/**
 * v0.4 + v0.5 · 复盘规则自动沉淀与 ACE 效用治理引擎（Candidate-First + ACE Utility + Glob Scope）
 *
 * 设计守则（对齐三方审计共识 + ETH Zurich AGENTS.md + Stanford ACE arXiv:2510.04618）：
 *   1. 默认候选（candidate），绝不把未经人工确认的噪声自动注入高优先级提示；
 *   2. 落盘前自动脱敏（mask API keys / Bearer / 私钥片段），按项目+来源+规范文本计算指纹去重；
 *   3. 分区限容：人工采纳（accepted）规则永远优先保留，绝不被海量新候选挤出 200 条上限；
 *   4. ACE 效用治理与作用域（v0.5）：
 *      · `fileMatch` 路径通配符作用域（参考 AWS Kiro）：命中所改路径才注入，避免无关规则污染上下文；
 *      · `{ helpful, harmful, injectedCount }` 效用计数：有害规则（harmful >= 2 且 harmful > helpful）自动静默降权；
 *      · 45 天长期注入无增益自动衰减，避免 ETH Zurich 实证的 -3% 成功率 / +20% 成本膨胀陷阱。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const LESSONS_SCHEMA_VERSION = 2;
const MAX_LESSONS_PER_TASK = 5;
const MAX_STORED_LESSONS = 200;
const MAX_ACCEPTED_LESSONS = 100;
const STALE_DECAY_MS = 45 * 24 * 3600 * 1000;

const writeChains = new Map();

function serializeWrite(filePath, fn) {
  const resolved = path.resolve(filePath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(key, next.catch(() => {}));
  return next;
}

export function normalizeProjectKey(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") return "";
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 脱敏常见凭据/密钥片段与本机绝对路径，避免把敏感内容沉淀进共享规则库。 */
export function sanitizeLessonText(value) {
  let text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  text = text
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/gu, "[REDACTED_KEY]")
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|ghp_[a-zA-Z0-9]{20,})\b/gu, "[REDACTED_SECRET]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, "$1[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{6,}/giu, "$1[REDACTED]")
    .replace(/[A-Za-z]:\\[^\s"',;]+/gu, "<path>")
    .replace(/(?:\/Users\/|\/home\/|\/root\/)[^\s"',;]+/gu, "<path>");
  return text.slice(0, 260);
}

export function lessonFingerprint(projectKey, source, rule) {
  const norm = String(rule ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, " ").trim();
  // 保持 v1 指纹前缀兼容，避免升级后已有 lessons.json 条目指纹漂移
  return createHash("sha256")
    .update(`v1|${projectKey}|${source}|${norm}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function normalizeGlob(pattern) {
  if (typeof pattern !== "string") return "";
  return pattern.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/** 轻量零依赖线性时间通配符匹配（支持 `*`, `**`, `?` 以及目录前缀；纯 DP 无回溯，彻底杜绝 ReDoS）。 */
export function globMatchesPath(pattern, filePath) {
  const pat = normalizeGlob(pattern);
  const target = normalizeGlob(filePath);
  if (!pat || !target || pat.length > 256 || target.length > 1024) return false;
  const collapsed = pat.replace(/\*{3,}/gu, "**").replace(/(?:\*\*\/)+/gu, "**/");
  const p = process.platform === "win32" ? collapsed.toLowerCase() : collapsed;
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  if (p === "*" || p === "**" || p === "**/*") return true;
  // 纯目录前缀（不含通配符）按路径前缀匹配
  if (!/[*?]/u.test(p)) {
    const clean = p.replace(/\/+$/u, "");
    return t === clean || t.startsWith(`${clean}/`);
  }
  const tokens = [];
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**/", i)) {
      tokens.push({ type: "globstar_dir" });
      i += 3;
    } else if (p.startsWith("**", i)) {
      tokens.push({ type: "globstar" });
      i += 2;
    } else if (p[i] === "*") {
      tokens.push({ type: "star" });
      i += 1;
    } else if (p[i] === "?") {
      tokens.push({ type: "qmark" });
      i += 1;
    } else {
      tokens.push({ type: "lit", ch: p[i] });
      i += 1;
    }
  }
  const n = t.length;
  let dp = new Uint8Array(n + 1);
  dp[0] = 1;
  for (const tok of tokens) {
    const next = new Uint8Array(n + 1);
    if (tok.type === "globstar") {
      let seen = false;
      for (let j = 0; j <= n; j++) {
        if (dp[j]) seen = true;
        if (seen) next[j] = 1;
      }
    } else if (tok.type === "globstar_dir") {
      let seen = false;
      for (let j = 0; j <= n; j++) {
        if (dp[j]) {
          next[j] = 1;
          seen = true;
        }
        if (seen && j > 0 && t[j - 1] === "/") next[j] = 1;
      }
    } else if (tok.type === "star") {
      let seen = false;
      for (let j = 0; j <= n; j++) {
        if (dp[j]) seen = true;
        if (seen) next[j] = 1;
        if (j < n && t[j] === "/") seen = false;
      }
    } else if (tok.type === "qmark") {
      for (let j = 0; j < n; j++) {
        if (dp[j] && t[j] !== "/") next[j + 1] = 1;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (dp[j] && t[j] === tok.ch) next[j + 1] = 1;
      }
    }
    dp = next;
  }
  return dp[n] === 1;
}

export function lessonMatchesPaths(item, touchedPaths) {
  const globs = Array.isArray(item?.fileMatch) ? item.fileMatch.filter((g) => typeof g === "string" && g.trim()) : [];
  if (!globs.length) return true; // 全局项目级规则
  const paths = Array.isArray(touchedPaths) ? touchedPaths.filter((p) => typeof p === "string" && p.trim()) : [];
  if (!paths.length) return true; // 尚未限定文件范围时仍可返回
  return paths.some((fp) => globs.some((g) => globMatchesPath(g, fp)));
}

/** 计算 ACE 效用分与静默衰减判定。 */
export function computeLessonUtility(item, now = Date.now()) {
  const helpful = Number.isInteger(item?.helpful) ? item.helpful : 0;
  const harmful = Number.isInteger(item?.harmful) ? item.harmful : 0;
  const injectedCount = Number.isInteger(item?.injectedCount) ? item.injectedCount : 0;
  const occurrences = Number.isInteger(item?.occurrences) ? item.occurrences : 1;

  const suppressedHarmful = harmful >= 2 && harmful > helpful;
  const lastActivity = item?.lastHelpfulAt ?? item?.decidedAt ?? item?.lastSeenAt ?? 0;
  const staleDecayed = injectedCount >= 3 && helpful === 0 && lastActivity > 0 && (now - lastActivity) > STALE_DECAY_MS;
  const score = helpful * 2 + Math.min(occurrences, 5) - harmful * 3;
  return { score, suppressed: suppressedHarmful || staleDecayed, suppressedHarmful, staleDecayed };
}

function inferStageFileMatch(task, stageId) {
  if (!task || !stageId) return [];
  const stage = (task.stages ?? []).find((s) => s && s.id === stageId);
  const raw = [];
  if (Array.isArray(stage?.writePaths)) raw.push(...stage.writePaths);
  const run = (task.nodeRuns ?? []).find((r) => r && r.stageId === stageId);
  const lastReport = run?.reports?.at(-1);
  if (Array.isArray(lastReport?.evidenceFiles)) {
    for (const f of lastReport.evidenceFiles) {
      if (f?.file) raw.push(f.file);
    }
  }
  const unique = [...new Set(raw.map(normalizeGlob).filter(Boolean))];
  return unique.slice(0, 6);
}

/**
 * 从单个任务提炼高信号候选经验（纯函数，绝不修改 task）。
 */
export function distillTaskLessons(task) {
  if (!task || !task.id) return [];
  const projectKey = normalizeProjectKey(task.workspaceRoot);
  const now = Date.now();
  const seen = new Set();
  const candidates = [];

  const push = ({ source, rule, detail = null, stageId = null, fileMatch = [] }) => {
    const cleanRule = sanitizeLessonText(rule);
    if (!cleanRule || cleanRule.length < 6) return;
    const fp = lessonFingerprint(projectKey, source, cleanRule);
    if (seen.has(fp)) return;
    seen.add(fp);
    const globs = Array.isArray(fileMatch) && fileMatch.length ? fileMatch : inferStageFileMatch(task, stageId);
    candidates.push({
      fingerprint: fp,
      schemaVersion: LESSONS_SCHEMA_VERSION,
      projectKey,
      workspaceRoot: task.workspaceRoot ?? null,
      source,
      rule: cleanRule,
      lesson: cleanRule,
      detail: detail ? sanitizeLessonText(detail) : null,
      stageId,
      workClass: task.workClass ?? null,
      taskId: task.id,
      sourceTaskIds: [task.id],
      ...(globs.length ? { fileMatch: globs } : {}),
      status: "candidate",
      occurrences: 1,
      helpful: 0,
      harmful: 0,
      injectedCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  };

  // 1. 返工熔断事件（最高信号）
  if (task.continuation?.kind === "rework-circuit-breaker") {
    const firstFinding = task.continuation.recentFindings?.[0]?.text;
    push({
      source: "circuit-breaker",
      stageId: task.continuation.stageId ?? null,
      rule: firstFinding
        ? `避免重复返工（${task.continuation.stageId ?? "阶段"}）：${firstFinding}`
        : `阶段 ${task.continuation.stageId ?? ""} 曾触发返工熔断，同类任务应先拆分细化验收标准`,
      detail: task.continuation.summary,
    });
  }

  // 2. 经独立审查闭环的真实 finding
  for (const finding of task.findings ?? []) {
    if (!finding || finding.status !== "closed") continue;
    const review = (task.reviews ?? []).find((r) =>
      r && r.id === finding.resolvedByReviewId && r.verdict === "pass" && !r.selfReviewed);
    if (!review) continue;
    const response = finding.responses?.at(-1)?.summary ?? null;
    push({
      source: "review-finding",
      stageId: finding.stageId ?? null,
      rule: finding.text,
      detail: response,
    });
  }

  // 3. 失败的前置硬检查
  for (const [stageId, pre] of Object.entries(task.lastPrechecks ?? {})) {
    if (!pre || pre.ok !== false) continue;
    const failedLabels = (pre.results ?? []).filter((r) => !r.ok).map((r) => r.label).filter(Boolean);
    if (!failedLabels.length) continue;
    push({
      source: "precheck-failure",
      stageId,
      rule: `上报前先跑通硬检查：${failedLabels.slice(0, 3).join("、")}`,
      detail: (pre.results ?? []).find((r) => !r.ok)?.stderrTail ?? null,
    });
  }

  return candidates.slice(0, MAX_LESSONS_PER_TASK);
}

function lessonsFilePath(stateDir) {
  return stateDir ? path.join(stateDir, "lessons.json") : null;
}

export async function loadProjectLessons(stateDir) {
  const file = lessonsFilePath(stateDir);
  if (!file) return { schemaVersion: LESSONS_SCHEMA_VERSION, items: [] };
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { schemaVersion: LESSONS_SCHEMA_VERSION, items: [] };
    process.stderr.write(`[dsh-mentor] 读取 lessons.json 失败: ${String(err?.message ?? err)}\n`);
    return { schemaVersion: LESSONS_SCHEMA_VERSION, items: [], readError: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      return { schemaVersion: LESSONS_SCHEMA_VERSION, items: parsed.items };
    }
    throw new Error("lessons.json 结构无效（缺少 items 数组）");
  } catch (err) {
    // v0.4：损坏文件先隔离到 quarantine/，绝不静默丢弃或直接覆盖用户历史采纳记录
    const quarantineDir = path.join(stateDir, "quarantine");
    const quarantineFile = path.join(quarantineDir, `lessons.${Date.now()}.corrupt.json`);
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(file, quarantineFile);
    } catch {}
    process.stderr.write(`[dsh-mentor] lessons.json 损坏并已隔离至 ${quarantineFile}: ${String(err?.message ?? err)}\n`);
    return { schemaVersion: LESSONS_SCHEMA_VERSION, items: [], quarantined: quarantineFile };
  }
}

async function atomicWriteJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  let lastErr = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(err?.code)) {
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
        continue;
      }
      break;
    }
  }
  await rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

/**
 * 分区限容保存（v0.5 修复隐藏 Bug）：
 *   1. 人工采纳（accepted）规则永远优先保留（最多 MAX_ACCEPTED_LESSONS 条），绝不被新候选挤掉；
 *   2. 剩余额度按 lastSeenAt 降序保留最新候选与已忽略记录，总条数守住 MAX_STORED_LESSONS = 200。
 */
async function saveProjectLessons(stateDir, data) {
  const file = lessonsFilePath(stateDir);
  if (!file) return;
  const all = Array.isArray(data.items) ? data.items.filter(Boolean) : [];
  const accepted = all
    .filter((i) => i.status === "accepted")
    .sort((a, b) =>
      computeLessonUtility(b).score - computeLessonUtility(a).score ||
      (b.decidedAt ?? b.lastSeenAt ?? 0) - (a.decidedAt ?? a.lastSeenAt ?? 0),
    )
    .slice(0, MAX_ACCEPTED_LESSONS);
  const othersCap = Math.max(0, MAX_STORED_LESSONS - accepted.length);
  const others = all
    .filter((i) => i.status !== "accepted")
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .slice(0, othersCap);
  const trimmed = {
    schemaVersion: LESSONS_SCHEMA_VERSION,
    updatedAt: Date.now(),
    items: [...accepted, ...others],
  };
  await atomicWriteJson(file, trimmed);
}

/** 将任务的候选经验按指纹去重并入 `<stateDir>/lessons.json`（不覆盖已人工决策的 status）。 */
export async function mergeCandidateLessons(stateDir, task) {
  const distilled = distillTaskLessons(task);
  if (!distilled.length || !stateDir) return distilled;
  const file = lessonsFilePath(stateDir);
  return serializeWrite(file, async () => {
    const store = await loadProjectLessons(stateDir);
    if (store.readError) return distilled; // 防瞬时读盘失败（如 EBUSY）覆盖已有规则库
    const byFp = new Map(store.items.map((item) => [item.fingerprint, item]));
    for (const cand of distilled) {
      const existing = byFp.get(cand.fingerprint);
      if (existing) {
        if (existing.lastTaskId !== cand.taskId) {
          existing.occurrences = (existing.occurrences ?? 1) + 1;
          existing.lastTaskId = cand.taskId;
          const prevIds = Array.isArray(existing.sourceTaskIds) ? existing.sourceTaskIds : (existing.taskId ? [existing.taskId] : []);
          if (!prevIds.includes(cand.taskId)) existing.sourceTaskIds = [...prevIds, cand.taskId].slice(-10);
        }
        existing.lastSeenAt = cand.lastSeenAt;
        if (cand.detail && !existing.detail) existing.detail = cand.detail;
        if (cand.fileMatch?.length) {
          existing.fileMatch = [...new Set([...(existing.fileMatch ?? []), ...cand.fileMatch])].slice(0, 8);
        }
      } else {
        byFp.set(cand.fingerprint, { ...cand, lastTaskId: cand.taskId });
      }
    }
    const items = [...byFp.values()];
    await saveProjectLessons(stateDir, { items });
    return distilled;
  });
}

/** 人工采纳或忽略一条沉淀经验（幂等，串行原子写盘；可选更新 fileMatch 作用域）。 */
export async function setLessonStatus(stateDir, { fingerprint, status, workspaceRoot = null, fileMatch = null }) {
  if (!fingerprint || typeof fingerprint !== "string") {
    return { ok: false, code: "E_FINDING_UNKNOWN", message: "缺少经验指纹（fingerprint）" };
  }
  if (!["accepted", "dismissed"].includes(status)) {
    return { ok: false, code: "E_ILLEGAL_TRANSITION", message: `无效经验状态：${status}` };
  }
  if (!stateDir) {
    return { ok: true, value: { fingerprint, status, persisted: false } };
  }
  const file = lessonsFilePath(stateDir);
  return serializeWrite(file, async () => {
    const store = await loadProjectLessons(stateDir);
    if (store.readError) {
      return { ok: false, code: "E_STATE_CORRUPT", message: `读取经验库失败，已中止写入以防覆盖历史：${store.readError}` };
    }
    const target = store.items.find((item) => item.fingerprint === fingerprint);
    if (!target) {
      return { ok: false, code: "E_FINDING_UNKNOWN", message: `未找到对应的经验条目：${fingerprint}` };
    }
    if (workspaceRoot && target.projectKey && normalizeProjectKey(workspaceRoot) !== target.projectKey) {
      return { ok: false, code: "E_TASK_MISMATCH", message: "不能跨项目修改其他工作区的经验条目" };
    }
    const globs = Array.isArray(fileMatch)
      ? [...new Set(fileMatch.map(normalizeGlob).filter(Boolean))].slice(0, 8)
      : null;
    const duplicate = target.status === status && !globs;
    target.status = status;
    target.decidedAt = Date.now();
    target.decidedBy = "user";
    if (globs) target.fileMatch = globs;
    if (!duplicate) await saveProjectLessons(stateDir, store);
    return {
      ok: true,
      value: {
        fingerprint,
        status,
        rule: target.rule,
        lesson: target.lesson ?? target.rule,
        ...(target.fileMatch?.length ? { fileMatch: target.fileMatch } : {}),
        duplicate,
        workspaceRoot,
      },
    };
  });
}

/**
 * ACE 效用反馈记录（helpful / harmful / injected）：
 *   · injected：任务创建/规划命中注入时累计计数；
 *   · helpful：任务零返工顺利完成时为注入规则记正反馈；
 *   · harmful：注入规则仍发生同源返工/熔断或人工点踩时记负反馈，触发自动降权。
 */
export async function recordLessonFeedback(stateDir, { fingerprints = [], outcome = "injected", workspaceRoot = null } = {}) {
  const fps = [...new Set((Array.isArray(fingerprints) ? fingerprints : []).filter((f) => typeof f === "string" && f.trim()))];
  if (!stateDir || !fps.length || !["helpful", "harmful", "injected"].includes(outcome)) {
    return { ok: true, updated: 0 };
  }
  const file = lessonsFilePath(stateDir);
  const projectKey = workspaceRoot ? normalizeProjectKey(workspaceRoot) : "";
  return serializeWrite(file, async () => {
    const store = await loadProjectLessons(stateDir);
    if (store.readError) return { ok: false, updated: 0, readError: store.readError };
    const now = Date.now();
    let updated = 0;
    for (const item of store.items) {
      if (!item || !fps.includes(item.fingerprint)) continue;
      if (projectKey && item.projectKey && item.projectKey !== projectKey) continue;
      if (outcome === "injected") {
        item.injectedCount = (Number.isInteger(item.injectedCount) ? item.injectedCount : 0) + 1;
        item.lastInjectedAt = now;
      } else if (outcome === "helpful") {
        item.helpful = (Number.isInteger(item.helpful) ? item.helpful : 0) + 1;
        item.lastHelpfulAt = now;
      } else if (outcome === "harmful") {
        item.harmful = (Number.isInteger(item.harmful) ? item.harmful : 0) + 1;
        item.lastHarmfulAt = now;
      }
      updated += 1;
    }
    if (updated > 0) await saveProjectLessons(stateDir, store);
    return { ok: true, updated };
  });
}

/** 仅返回当前项目**已被人工采纳、命中作用域且未被 ACE 效用降权**的规则。 */
export async function queryAcceptedLessons(stateDir, {
  workspaceRoot,
  query = "",
  touchedPaths = null,
  limit = 5,
  now = Date.now(),
} = {}) {
  if (!stateDir || !workspaceRoot) return [];
  const projectKey = normalizeProjectKey(workspaceRoot);
  const keyword = String(query ?? "").trim().toLowerCase();
  const store = await loadProjectLessons(stateDir);
  return store.items
    .filter((item) => item && item.status === "accepted" && item.projectKey === projectKey)
    .filter((item) => !computeLessonUtility(item, now).suppressed)
    .filter((item) => lessonMatchesPaths(item, touchedPaths))
    .filter((item) => !keyword || `${item.rule} ${item.detail ?? ""}`.toLowerCase().includes(keyword))
    .sort((a, b) =>
      computeLessonUtility(b, now).score - computeLessonUtility(a, now).score ||
      (b.occurrences ?? 1) - (a.occurrences ?? 1) ||
      (b.decidedAt ?? 0) - (a.decidedAt ?? 0),
    )
    .slice(0, limit)
    .map((item) => ({
      fingerprint: item.fingerprint,
      source: item.source,
      kind: item.source,
      rule: item.rule,
      lesson: item.rule,
      detail: item.detail ?? null,
      stageId: item.stageId ?? null,
      sourceTaskIds: Array.isArray(item.sourceTaskIds) ? item.sourceTaskIds : (item.taskId ? [item.taskId] : []),
      ...(item.fileMatch?.length ? { fileMatch: item.fileMatch } : {}),
      occurrences: item.occurrences ?? 1,
      helpful: Number.isInteger(item.helpful) ? item.helpful : 0,
      harmful: Number.isInteger(item.harmful) ? item.harmful : 0,
      injectedCount: Number.isInteger(item.injectedCount) ? item.injectedCount : 0,
      accepted: true,
    }));
}

/** 给面板展示用的项目经验视图（已采纳 + 待确认候选，忽略的不显示；附 ACE 效用状态）。 */
export async function listProjectLessons(stateDir, { workspaceRoot, limit = 8, now = Date.now() } = {}) {
  if (!stateDir || !workspaceRoot) return { accepted: [], candidates: [] };
  const projectKey = normalizeProjectKey(workspaceRoot);
  const store = await loadProjectLessons(stateDir);
  const matching = store.items.filter((item) => item && item.projectKey === projectKey);
  const normalizeItem = (item) => {
    const util = computeLessonUtility(item, now);
    return {
      ...item,
      lesson: item.lesson ?? item.rule,
      rule: item.rule ?? item.lesson,
      helpful: Number.isInteger(item.helpful) ? item.helpful : 0,
      harmful: Number.isInteger(item.harmful) ? item.harmful : 0,
      injectedCount: Number.isInteger(item.injectedCount) ? item.injectedCount : 0,
      suppressed: util.suppressed,
      utilityScore: util.score,
    };
  };
  const accepted = matching
    .filter((item) => item.status === "accepted")
    .sort((a, b) => computeLessonUtility(b, now).score - computeLessonUtility(a, now).score || (b.occurrences ?? 1) - (a.occurrences ?? 1))
    .slice(0, limit)
    .map(normalizeItem);
  const candidates = matching
    .filter((item) => item.status === "candidate")
    .sort((a, b) => (b.occurrences ?? 1) - (a.occurrences ?? 1) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    .slice(0, limit)
    .map(normalizeItem);
  return { accepted, candidates };
}
