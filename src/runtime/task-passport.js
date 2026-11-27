/**
 * 自动校验的跨会话「任务护照（Task Passport）」（v1.0，对齐 GitHub AHP 理念）。
 *
 * 将跨会话接班升级为带加密指纹与工作区漂移自检的可携带状态包：
 *   - 导出：收集任务状态快照 + 当前工作区 Git Tree SHA / 非 Git manifestDigest 指纹 +
 *     全部 evidenceFiles 的 SHA-256 指纹 + 规范 JSON 的 SHA-256 完整性校验摘要 +
 *     配置 stateDir 时的本地 HMAC-SHA256 签名（防本机伪造）；
 *   - 校验与导入：先验完整性与签名，再核对工作区与证据文件是否漂移（含非 Git manifestDigest）；
 *     严格校验 phase 合法性与 plan DAG；若导入计划含 shell prechecks 自动撤回批准并强制
 *     `requireApproval: true`（杜绝伪造护照借 prechecks RCE）；取消原会话在途运行并安全替换，
 *     不泄露旧任务残留字段、不因旧任务终态而崩溃。
 *
 * 零外部依赖；导出前自动脱敏常见凭据并排除敏感文件。
 */

import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";

import { captureWorkspaceSnapshot } from "./workspace-diff.js";
import { redactSecrets } from "./atif-trace.js";
import { isSensitivePath } from "../review/evidence-reader.js";
import { collectDependents, validatePlan } from "../plan/dag.js";
import { isPhase } from "../state/machine.js";
import { PHASE_WRITE_FLAG } from "./phase-writer.js";

export const PASSPORT_SCHEMA_VERSION = "dsh-mentor-passport/1.0";
const MAX_PASSPORT_FILE_BYTES = 4 * 1024 * 1024;
const HMAC_KEY_FILE = ".passport-hmac.key";

function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function safeSlug(id) {
  const clean = String(id ?? "task").replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 64);
  const hash = sha256Hex(String(id ?? "task")).slice(0, 8);
  return `${clean || "task"}-${hash}`;
}

async function loadOrCreateLocalHmacKey(stateDir) {
  if (!stateDir) return null;
  const keyFile = path.join(stateDir, HMAC_KEY_FILE);
  try {
    const existing = (await readFile(keyFile, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {}
  try {
    await mkdir(stateDir, { recursive: true });
    const fresh = randomBytes(32).toString("hex");
    await writeFile(keyFile, fresh, { encoding: "utf8", mode: 0o600 });
    return fresh;
  } catch {
    return null;
  }
}

async function readLocalHmacKey(stateDir) {
  if (!stateDir) return null;
  try {
    const existing = (await readFile(path.join(stateDir, HMAC_KEY_FILE), "utf8")).trim();
    return existing.length >= 32 ? existing : null;
  } catch {
    return null;
  }
}

function normalizeRelToRoot(root, rawFile) {
  if (typeof rawFile !== "string" || !rawFile.trim()) return "";
  const trimmed = rawFile.trim();
  if (root && path.isAbsolute(trimmed)) {
    const rel = path.relative(path.resolve(root), path.resolve(trimmed));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.replace(/\\/gu, "/");
    }
  }
  return trimmed.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/**
 * 安全计算工作区内文件的 SHA-256（逐级 lstat + realpath 严防祖先符号链接/联接点逃逸与敏感文件别名绕过）。
 */
async function hashWorkspaceFileSafe(workspaceRoot, relPath) {
  if (!workspaceRoot || !relPath || typeof relPath !== "string") return null;
  const norm = normalizeRelToRoot(workspaceRoot, relPath);
  if (!norm || norm.startsWith("/") || norm.includes("..") || isSensitivePath(norm)) return null;
  try {
    const rootReal = await realpath(workspaceRoot);
    const abs = path.resolve(rootReal, norm);
    const relCheck = path.relative(rootReal, abs);
    if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
    // 逐级检查祖先目录与叶节点，拒绝任何符号链接/Windows Junction
    let cur = rootReal;
    for (const seg of relCheck.replace(/\\/gu, "/").split("/").filter(Boolean)) {
      cur = path.join(cur, seg);
      const st = await lstat(cur);
      if (st.isSymbolicLink()) return null;
    }
    const fileReal = await realpath(abs);
    const realRel = path.relative(rootReal, fileReal);
    if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    if (isSensitivePath(realRel.replace(/\\/gu, "/"))) return null;
    const st = await lstat(fileReal);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const buf = await readFile(fileReal);
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

/**
 * 导出带工作区指纹、完整性摘要与本地 HMAC 签名的任务护照。
 */
export async function exportTaskPassport({
  task,
  stateDir = "",
  workspaceRoot = null,
} = {}) {
  if (!task || typeof task !== "object") {
    return { ok: false, reason: "no-task", message: "当前没有可导出护照的任务" };
  }
  const root = workspaceRoot || task.workspaceRoot || null;
  let workspaceFingerprint = null;
  if (root) {
    const snap = await captureWorkspaceSnapshot({ workspaceRoot: root, stateDir, taskId: task.id });
    if (snap.ok) {
      workspaceFingerprint = {
        mode: snap.mode,
        id: snap.id,
        treeSha: snap.treeSha ?? null,
        manifestDigest: snap.manifestDigest ?? null,
        baseHead: snap.baseHead ?? null,
        fileCount: snap.fileCount ?? null,
        at: snap.at,
      };
    }
  }

  // 收集各阶段引用过的证据文件并做实时 SHA-256 指纹（兼容 textSha256 与 sha256）
  const evidenceMap = {};
  const fileStages = {};
  for (const run of Array.isArray(task.nodeRuns) ? task.nodeRuns : []) {
    if (!run?.stageId) continue;
    for (const rep of Array.isArray(run.reports) ? run.reports : []) {
      for (const ef of Array.isArray(rep?.evidenceFiles) ? rep.evidenceFiles : []) {
        const f = ef?.file;
        if (!f || typeof f !== "string") continue;
        const norm = normalizeRelToRoot(root, f);
        if (!norm || norm.startsWith("/") || norm.includes("..")) continue;
        if (!fileStages[norm]) fileStages[norm] = [];
        if (!fileStages[norm].includes(run.stageId)) fileStages[norm].push(run.stageId);
        if (evidenceMap[norm] === undefined) {
          const liveHash = root ? await hashWorkspaceFileSafe(root, norm) : null;
          evidenceMap[norm] = liveHash ?? ef.textSha256 ?? ef.sha256 ?? null;
        }
      }
    }
  }

  const sanitizedTask = redactSecrets({
    id: task.id,
    objective: task.objective,
    phase: task.phase,
    enabled: task.enabled !== false,
    planVersion: task.planVersion ?? 0,
    approvedPlanVersion: task.approvedPlanVersion ?? null,
    requireApproval: Boolean(task.requireApproval),
    workspaceRoot: root,
    workClass: task.workClass ?? null,
    rigor: task.rigor ?? null,
    criteria: task.criteria ?? [],
    requiredCriteria: task.requiredCriteria ?? null,
    stages: task.stages ?? [],
    nodeRuns: task.nodeRuns ?? [],
    reviews: task.reviews ?? [],
    findings: task.findings ?? [],
    lastPrechecks: task.lastPrechecks ?? null,
    lastDiffAudits: task.lastDiffAudits ?? null,
    ambiguityReport: task.ambiguityReport ?? null,
    clarifications: task.clarifications ?? [],
    ownershipGeneration: Number.isInteger(task.ownershipGeneration) ? task.ownershipGeneration : 1,
    sessionHistory: Array.isArray(task.sessionHistory) ? task.sessionHistory.slice(-10) : [],
    revision: task.revision ?? 1,
    createdAt: task.createdAt ?? Date.now(),
    updatedAt: task.updatedAt ?? Date.now(),
  });

  const payload = {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    taskId: task.id,
    workspaceRoot: root,
    workspaceFingerprint,
    evidenceFingerprints: evidenceMap,
    evidenceStages: fileStages,
    task: sanitizedTask,
  };
  const canonical = canonicalJson(payload);
  const integrityDigest = sha256Hex(canonical);
  const hmacKey = await loadOrCreateLocalHmacKey(stateDir);
  const localSignature = hmacKey ? createHmac("sha256", hmacKey).update(canonical).digest("hex") : null;
  const passport = { ...payload, integrityDigest, ...(localSignature ? { localSignature } : {}) };

  let file = null;
  if (stateDir) {
    const dir = path.join(stateDir, "passports");
    await mkdir(dir, { recursive: true });
    file = path.join(dir, `${safeSlug(task.id)}.passport.json`);
    await writeFile(file, JSON.stringify(passport, null, 2), "utf8");
  }

  return {
    ok: true,
    file,
    integrityDigest,
    signed: Boolean(localSignature),
    workspaceFingerprint,
    evidenceCount: Object.keys(evidenceMap).length,
    passport,
  };
}

/**
 * 校验任务护照的完整性摘要、本地 HMAC 签名以及当前工作区/证据文件是否发生漂移。
 */
export async function verifyTaskPassport({
  passport,
  workspaceRoot = null,
  stateDir = "",
} = {}) {
  if (!passport || typeof passport !== "object" || passport.schemaVersion !== PASSPORT_SCHEMA_VERSION) {
    return {
      ok: false,
      integrityOk: false,
      reason: "invalid-passport-schema",
      message: "任务护照格式或版本不受支持",
    };
  }
  const { integrityDigest, localSignature, ...unsigned } = passport;
  const canonical = canonicalJson(unsigned);
  const expected = sha256Hex(canonical);
  if (!integrityDigest || integrityDigest !== expected) {
    return {
      ok: false,
      integrityOk: false,
      reason: "integrity-mismatch",
      message: "任务护照完整性校验失败（文件可能已损坏或被篡改），拒绝加载",
      expected,
      received: integrityDigest ?? null,
    };
  }
  if (localSignature && stateDir) {
    const hmacKey = await readLocalHmacKey(stateDir);
    if (hmacKey) {
      const expectedSig = createHmac("sha256", hmacKey).update(canonical).digest("hex");
      if (localSignature !== expectedSig) {
        return {
          ok: false,
          integrityOk: false,
          reason: "signature-mismatch",
          message: "任务护照本地 HMAC 签名校验失败（疑似伪造护照），拒绝加载",
        };
      }
    }
  }

  const root = workspaceRoot || passport.workspaceRoot || null;
  const driftedEvidenceFiles = [];
  const affectedStageSet = new Set();
  const evidenceStages = passport.evidenceStages && typeof passport.evidenceStages === "object"
    ? passport.evidenceStages : {};

  if (root && passport.evidenceFingerprints && typeof passport.evidenceFingerprints === "object") {
    for (const [relPath, expectedHash] of Object.entries(passport.evidenceFingerprints)) {
      if (!expectedHash) continue;
      const liveHash = await hashWorkspaceFileSafe(root, relPath);
      if (liveHash !== expectedHash) {
        driftedEvidenceFiles.push({
          file: relPath,
          reason: liveHash === null ? "missing-or-unreadable" : "content-changed",
          expectedHash: String(expectedHash).slice(0, 12),
          actualHash: liveHash ? liveHash.slice(0, 12) : null,
        });
        for (const sid of Array.isArray(evidenceStages[relPath]) ? evidenceStages[relPath] : []) {
          affectedStageSet.add(sid);
          for (const dep of collectDependents(passport.task?.stages ?? [], sid)) {
            affectedStageSet.add(dep);
          }
        }
      }
    }
  }

  let workspaceDrifted = driftedEvidenceFiles.length > 0;
  let currentWorkspaceFingerprint = null;
  if (root && passport.workspaceFingerprint?.id) {
    const snap = await captureWorkspaceSnapshot({ workspaceRoot: root, stateDir, taskId: passport.taskId });
    if (snap.ok) {
      currentWorkspaceFingerprint = {
        mode: snap.mode,
        id: snap.id,
        treeSha: snap.treeSha ?? null,
        manifestDigest: snap.manifestDigest ?? null,
      };
      if (passport.workspaceFingerprint.mode === "git" && snap.mode === "git") {
        if (snap.treeSha !== passport.workspaceFingerprint.treeSha) {
          workspaceDrifted = true;
        }
      } else if (passport.workspaceFingerprint.mode === "manifest" && snap.mode === "manifest") {
        if (passport.workspaceFingerprint.manifestDigest && snap.manifestDigest &&
            snap.manifestDigest !== passport.workspaceFingerprint.manifestDigest) {
          workspaceDrifted = true;
        }
      } else if (passport.workspaceFingerprint.mode !== snap.mode) {
        workspaceDrifted = true;
      }
    }
  }

  const affectedStages = [...affectedStageSet];
  return {
    ok: true,
    integrityOk: true,
    taskId: passport.taskId,
    workspaceRoot: root,
    workspaceDrifted,
    driftedEvidenceFiles,
    affectedStages,
    expectedWorkspaceFingerprint: passport.workspaceFingerprint ?? null,
    currentWorkspaceFingerprint,
    summary: !workspaceDrifted
      ? "护照完整性与工作区指纹均一致，可零漂移无缝续跑。"
      : driftedEvidenceFiles.length > 0
        ? `护照完整但检测到 ${driftedEvidenceFiles.length} 个已验收证据文件发生漂移（影响阶段：${affectedStages.join("、") || "全局"}）。`
        : "护照完整，工作区快照较导出时有其他改动，建议核对后再推进。",
  };
}

/**
 * 校验并安全导入任务护照到目标会话 store（仅限人工通道调用）。
 */
export async function importTaskPassport({
  passport,
  targetStore,
  targetSessionId,
  workspaceRoot = null,
  stateDir = "",
  force = false,
  cancelExistingRuntime = null,
} = {}) {
  if (!targetStore || typeof targetStore.set !== "function") {
    return { ok: false, reason: "invalid-store", message: "缺少目标任务存储" };
  }
  if (!targetSessionId || typeof targetSessionId !== "string") {
    return { ok: false, reason: "missing-session", message: "缺少目标会话标识" };
  }
  const verify = await verifyTaskPassport({ passport, workspaceRoot, stateDir });
  if (!verify.ok || !verify.integrityOk) {
    return verify;
  }

  const srcTask = structuredClone(passport.task);
  if (!srcTask || typeof srcTask !== "object" || !srcTask.id || !isPhase(srcTask.phase)) {
    return { ok: false, reason: "invalid-task-state", message: "护照内的任务结构或 phase 不合法，拒绝导入" };
  }
  if (Array.isArray(srcTask.stages) && srcTask.stages.length > 0) {
    const planCheck = validatePlan({ criteria: srcTask.criteria ?? [], stages: srcTask.stages });
    if (!planCheck.ok) {
      return { ok: false, reason: "invalid-task-plan", message: "护照内的计划 DAG 校验失败，拒绝导入", errors: planCheck.errors };
    }
  }

  if (verify.driftedEvidenceFiles.length > 0 && !force) {
    return {
      ok: false,
      reason: "workspace-drifted",
      message: `检测到 ${verify.driftedEvidenceFiles.length} 个已验收证据文件发生漂移（${verify.driftedEvidenceFiles.map((d) => d.file).slice(0, 5).join("、")}），已阻止盲目导入；如确认把受影响阶段重开为 rework 请加 --force`,
      verify,
    };
  }

  // 安全防线：若导入护照包含自定义 shell prechecks，强制撤回自动批准并要求人工确认，杜绝伪造护照 RCE
  const hasShellPrechecks = (srcTask.stages ?? []).some((s) => Array.isArray(s?.prechecks) && s.prechecks.length > 0);
  const safePhase = hasShellPrechecks && ["active", "reviewing"].includes(srcTask.phase)
    ? "awaiting-approval"
    : srcTask.phase;

  // 若目标会话已有旧任务，先取消其在途子会话，防止孤儿 reviewer/worker 晚到回写
  const existing = targetStore.get();
  if (existing && typeof cancelExistingRuntime === "function") {
    try { await cancelExistingRuntime(targetStore, existing.id, "passport-replaced"); } catch {}
  }

  const affectedSet = new Set(verify.affectedStages);
  const nextRuns = (Array.isArray(srcTask.nodeRuns) ? srcTask.nodeRuns : []).map((run) => {
    if (!run || !affectedSet.has(run.stageId) || run.status === "pending") return run;
    return {
      ...run,
      status: "rework",
      attempt: Math.max(1, (run.attempt ?? 0) + 1),
      batchId: null,
      workerSessionId: null,
      workerStatus: null,
      failedReason: "passport-evidence-drifted",
    };
  });

  const nextGeneration = (Number.isInteger(srcTask.ownershipGeneration) ? srcTask.ownershipGeneration : 1) + 1;
  const now = Date.now();
  const nextHistory = [
    ...(Array.isArray(srcTask.sessionHistory) ? srcTask.sessionHistory : []),
    { at: now, sessionId: targetSessionId, generation: nextGeneration, reason: "passport-import" },
  ].slice(-12);

  const importedTask = {
    ...srcTask,
    phase: safePhase,
    requireApproval: hasShellPrechecks ? true : Boolean(srcTask.requireApproval),
    approvedPlanVersion: hasShellPrechecks ? null : (srcTask.approvedPlanVersion ?? null),
    mainSessionId: targetSessionId,
    workspaceRoot: workspaceRoot || srcTask.workspaceRoot || null,
    nodeRuns: nextRuns,
    reviewJobs: [],
    delegations: [],
    workers: [],
    pendingCheckpoint: null,
    ownershipGeneration: nextGeneration,
    sessionHistory: nextHistory,
    passportImportedAt: now,
    revision: (Number.isInteger(srcTask.revision) ? srcTask.revision : 0) + 1,
    updatedAt: now,
  };

  // 安全整对象替换：携带 PHASE_WRITE_FLAG 既不触发终态非法转移崩毁，也绝不混入旧任务残留字段
  targetStore.set(importedTask, PHASE_WRITE_FLAG);

  return {
    ok: true,
    taskId: importedTask.id,
    phase: importedTask.phase,
    requireApprovalForPrechecks: hasShellPrechecks,
    ownershipGeneration: nextGeneration,
    reopenedStages: verify.affectedStages,
    verify,
  };
}

/** 安全从磁盘读取并解析任务护照（拒绝非 .json、敏感文件、符号链接及超过 4MB 文件）。 */
export async function readPassportFile(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("缺少任务护照文件路径");
  }
  const norm = filePath.trim().replace(/\\/gu, "/");
  if (!norm.toLowerCase().endsWith(".json") || isSensitivePath(norm)) {
    throw new Error("拒绝读取非 .json 或敏感路径文件");
  }
  const st = await lstat(filePath);
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_PASSPORT_FILE_BYTES) {
    throw new Error("拒绝读取符号链接或超过 4MB 的护照文件");
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}
