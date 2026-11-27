/**
 * 本地 ATIF v1.8 轨迹导出与离线确定性回归回放器（v1.0 Meta-Harness 闭环）。
 *
 * 对齐 Harbor ATIF-v1.8 规范（Agent Trajectory Interchange Format）：
 *   - 导出脱敏执行轨迹到 `stateDir/traces/<taskId>.atif.json`；
 *   - 包含 `schema_version`、`session_id`、`agent`、`steps[]`、`subagent_trajectories[]`、
 *     `final_metrics`（含 token/cache/rework/precheck/tamper/stuck 指标）与可回放的 `replay_fixtures`；
 *   - 内置离线回归回放器：把历史保存的轨迹重新喂给当前版本的
 *     `tamper-scan` / `rigor` / `ambiguity-gate` / `stuck-detector`，在改任何规则前用历史真题
 *     科学证伪有没有产生退化。
 *
 * 零外部依赖；导出前强制执行敏感凭据脱敏，绝不把 API Key / Bearer Token / 私钥落盘。
 */

import path from "node:path";
import { mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { evaluatePlanRigor } from "./rigor.js";
import { scanDiffForTampering } from "./tamper-scan.js";
import { analyzePlanAmbiguity } from "../plan/ambiguity-gate.js";
import { detectStuckLoop } from "./stuck-detector.js";
import { isSensitivePath } from "../review/evidence-reader.js";

export const ATIF_SCHEMA_VERSION = "ATIF-v1.8";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu,
  /\b(?:Bearer|Token)\s+[A-Za-z0-9._-]{16,}\b/giu,
  /(?:api[_-]?key|secret|password|passwd|auth[_-]?token)\s*[:=]\s*["']?[^\s"',;]{6,}["']?/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

/** 递归脱敏文本与对象中的常见凭据，避免轨迹落盘泄密（超深截断而不是原样透传）。 */
export function redactSecrets(value, depth = 0) {
  if (value == null) return value;
  if (depth > 12) return "[REDACTED_DEPTH]";
  if (typeof value === "string") {
    let out = value;
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, "[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(?:api_?key|secret|password|passwd|token|authorization|cookie)/iu.test(k) && typeof v === "string" && v.length > 0) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function safeSlug(id) {
  const clean = String(id ?? "task").replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 64);
  const hash = createHash("sha256").update(String(id ?? "task")).digest("hex").slice(0, 8);
  return `${clean || "task"}-${hash}`;
}

/**
 * 将当前任务状态与可选运行指标构建为 ATIF-v1.8 结构对象（纯函数，已脱敏）。
 *
 * @param {object} task
 * @param {{
 *   pluginVersion?: string,
 *   model?: string|null,
 *   metrics?: { prompt_tokens?: number, completion_tokens?: number, cached_tokens?: number },
 *   sessionEvents?: Array<object>,
 * }} [options]
 */
export function buildAtifTrace(task, options = {}) {
  if (!task || typeof task !== "object") {
    throw new Error("buildAtifTrace requires a valid task object");
  }
  const now = Date.now();
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const runs = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  const reviewJobs = Array.isArray(task.reviewJobs) ? task.reviewJobs : [];
  const workers = Array.isArray(task.workers) ? task.workers : [];
  const stuckEvents = Array.isArray(task.stuckEvents) ? task.stuckEvents : [];
  const diffAudits = task.lastDiffAudits && typeof task.lastDiffAudits === "object" ? task.lastDiffAudits : {};
  const prechecks = task.lastPrechecks && typeof task.lastPrechecks === "object" ? task.lastPrechecks : {};

  const steps = [];
  let stepId = 1;

  // Step 1: 任务创建与规划摘要
  steps.push({
    step_id: stepId++,
    timestamp: task.createdAt ?? now,
    source: "user",
    message: redactSecrets(String(task.objective ?? "")),
    extra: {
      event: "task_create",
      task_id: task.id,
      plan_version: task.planVersion ?? 0,
      rigor: task.rigor?.tier ?? "standard",
      stage_count: stages.length,
      criteria_count: (task.criteria ?? []).length,
    },
  });

  // 阶段上报、前置硬检查与宿主 Diff 审计步骤
  for (const run of runs) {
    if (!run?.stageId) continue;
    for (const rep of Array.isArray(run.reports) ? run.reports : []) {
      steps.push({
        step_id: stepId++,
        timestamp: rep.at ?? run.updatedAt ?? now,
        source: "agent",
        message: redactSecrets(String(rep.summary ?? "")),
        tool_calls: [{
          tool_call_id: rep.id ?? `report-${run.stageId}-${rep.attempt ?? 1}`,
          function_name: "mentor_stage_report",
          arguments: {
            stageId: run.stageId,
            attempt: rep.attempt ?? run.attempt ?? 1,
            evidenceFiles: (rep.evidenceFiles ?? []).map((f) => f.file),
          },
        }],
        observation: {
          results: [{
            source_call_id: rep.id ?? `report-${run.stageId}-${rep.attempt ?? 1}`,
            content: redactSecrets(JSON.stringify({
              precheck: prechecks[run.stageId] ? { ok: prechecks[run.stageId].ok, failed: prechecks[run.stageId].failed, total: prechecks[run.stageId].total } : null,
              diffAudit: diffAudits[run.stageId] ? {
                totalChangedFiles: diffAudits[run.stageId].totalChangedFiles,
                undeclaredFiles: diffAudits[run.stageId].undeclaredFiles,
                outsideWritePaths: diffAudits[run.stageId].outsideWritePaths,
                tamperScan: diffAudits[run.stageId].tamperScan ?? null,
              } : null,
            })),
          }],
        },
      });
    }
  }

  // 独立审查裁决步骤
  for (const rev of reviews) {
    if (!rev) continue;
    steps.push({
      step_id: stepId++,
      timestamp: rev.at ?? now,
      source: "system",
      message: redactSecrets(`[review:${rev.scope?.kind ?? "stage"}] verdict=${rev.verdict}`),
      observation: {
        results: [{
          source_call_id: rev.id ?? `rev-${stepId}`,
          content: redactSecrets(JSON.stringify({
            scope: rev.scope ?? null,
            verdict: rev.verdict,
            waived: Boolean(rev.waived),
            checksCount: (rev.checks ?? []).length,
            findingsCount: (rev.findings ?? []).length,
          })),
        }],
      },
    });
  }

  // 卡死检测事件
  for (const se of stuckEvents) {
    steps.push({
      step_id: stepId++,
      timestamp: se.at ?? now,
      source: "system",
      message: redactSecrets(`[stuck:${se.pattern}] action=${se.action} ${se.evidence ?? ""}`),
      extra: { event: "stuck_detected", pattern: se.pattern, action: se.action },
    });
  }

  // 子代理轨迹摘要（reviewer + worker）
  const subagentTrajectories = [
    ...reviewJobs.map((job) => ({
      role: "reviewer",
      session_id: job.sessionId ?? job.id,
      kind: job.kind ?? "stage",
      stage_id: job.stageId ?? null,
      attempt: job.attempt ?? 1,
      status: job.status ?? "unknown",
      verdict: job.verdict ?? null,
      model_route: job.modelRoute ?? null,
      error: redactSecrets(job.error ?? null),
    })),
    ...workers.map((w) => ({
      role: "worker",
      session_id: w.sessionId ?? w.key ?? null,
      stage_id: w.stageId ?? null,
      attempt: w.attempt ?? 1,
      status: w.status ?? "unknown",
      model_route: w.modelRoute ?? null,
      worktree: w.worktree ? { branch: w.worktree.branch, status: w.worktree.status } : null,
      error: redactSecrets(w.error ?? null),
    })),
  ];

  const totalReworks = runs.reduce((n, r) => n + Math.max(0, (r?.attempt ?? 1) - 1), 0);
  const precheckBlocks = Object.values(prechecks).filter((p) => p && p.ok === false).length;
  const tamperBlocks = Object.values(diffAudits).filter((d) => d?.tamperScan && d.tamperScan.ok === false).length;
  const durationMs = task.createdAt ? Math.max(0, (task.updatedAt ?? now) - task.createdAt) : 0;

  // 可离线重放的确定性夹具（用于 Meta-Harness 回归证伪）
  const replayFixtures = {
    plan: {
      objective: redactSecrets(String(task.objective ?? "")),
      requestedRigor: task.rigor?.requested ?? null,
      defaultRigor: options.defaultRigor ?? null,
      userExplicitRigor: task.rigor?.userExplicit === true,
      expectedTier: task.rigor?.upgraded ? (task.rigor?.previousTier ?? "standard") : (task.rigor?.tier ?? "standard"),
      finalTier: task.rigor?.tier ?? "standard",
      stages: stages.map((s) => ({
        id: s.id,
        title: redactSecrets(String(s.title ?? "")),
        criterionIds: s.criterionIds ?? [],
        writePaths: s.writePaths ?? [],
        testChangePolicy: s.testChangePolicy ?? "none",
        prechecks: Array.isArray(s.prechecks) ? redactSecrets(s.prechecks) : [],
      })),
      criteria: (task.criteria ?? []).map((c) => ({ id: c.id, text: redactSecrets(String(c.text ?? "")) })),
      clarifications: Array.isArray(task.clarifications) ? redactSecrets(task.clarifications) : [],
      ambiguityExpected: task.ambiguityReport ? {
        hasAmbiguity: Boolean(task.ambiguityReport.hasAmbiguity),
        blocking: Boolean(task.ambiguityReport.blocking),
      } : null,
    },
    tamperCases: Object.entries(diffAudits)
      .filter(([, a]) => a && a.tamperScan)
      .map(([sid, a]) => ({
        stageId: sid,
        changedFiles: a.changedFiles ?? [],
        unifiedDiff: typeof a.tamperScan?.unifiedDiffExcerpt === "string"
          ? redactSecrets(a.tamperScan.unifiedDiffExcerpt.slice(0, 4096))
          : "",
        policy: a.tamperScan.policy ?? "none",
        expectedOk: Boolean(a.tamperScan.ok),
        expectedBlocks: (a.tamperScan.blocks ?? []).map((b) => b.rule),
      })),
    stuckEventsSnapshot: Array.isArray(options.sessionEvents)
      ? redactSecrets(options.sessionEvents.slice(-40))
      : [],
  };

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: task.mainSessionId ?? task.id,
    task_id: task.id,
    phase: task.phase,
    exported_at: now,
    agent: {
      name: "dsh-mentor",
      version: options.pluginVersion ?? "1.0.0",
      model_name: options.model ?? null,
    },
    steps,
    subagent_trajectories: subagentTrajectories,
    final_metrics: {
      prompt_tokens: Number(options.metrics?.prompt_tokens ?? 0),
      completion_tokens: Number(options.metrics?.completion_tokens ?? 0),
      cached_tokens: Number(options.metrics?.cached_tokens ?? 0),
      total_steps: steps.length,
      total_stages: stages.length,
      accepted_stages: runs.filter((r) => r?.status === "accepted").length,
      total_reworks: totalReworks,
      precheck_blocks: precheckBlocks,
      tamper_blocks: tamperBlocks,
      stuck_events: stuckEvents.length,
      duration_ms: durationMs,
    },
    replay_fixtures: replayFixtures,
  };
}

/** 将脱敏后的 ATIF-v1.8 轨迹落盘到 `stateDir/traces/<slug>.atif.json`。 */
export async function exportAtifTrace(stateDir, task, options = {}) {
  const trace = buildAtifTrace(task, options);
  if (!stateDir) {
    return { ok: true, persisted: false, file: null, trace };
  }
  const dir = path.join(stateDir, "traces");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeSlug(task.id)}.atif.json`);
  await writeFile(file, JSON.stringify(trace, null, 2), "utf8");
  return { ok: true, persisted: true, file, trace };
}

/** 列出 `stateDir/traces/` 下已保存的轨迹文件。 */
export async function listSavedTraces(stateDir) {
  if (!stateDir) return [];
  const dir = path.join(stateDir, "traces");
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(".atif.json")).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * 离线回归回放单条 ATIF 轨迹：用当前版本的确定性传感器重新评估历史夹具，
 * 精确报告 regressions（退化）/ improvements（改善）/ unchanged（稳定）。
 */
export function replayAtifTrace(trace) {
  if (!trace || trace.schema_version !== ATIF_SCHEMA_VERSION) {
    return { ok: false, reason: "invalid-atif-schema", checks: [], regressions: [], improvements: [] };
  }
  const fx = trace.replay_fixtures ?? {};
  const checks = [];
  const regressions = [];
  const improvements = [];

  // 1) 回放自适应严格度判定
  if (fx.plan) {
    const rigorEval = evaluatePlanRigor({
      requested: fx.plan.requestedRigor ?? null,
      ...(fx.plan.defaultRigor ? { defaultRigor: fx.plan.defaultRigor } : {}),
      userExplicit: fx.plan.userExplicitRigor === true,
      stages: fx.plan.stages ?? [],
      criteria: fx.plan.criteria ?? [],
      objective: fx.plan.objective ?? "",
    });
    const matched = !fx.plan.expectedTier || rigorEval.tier === fx.plan.expectedTier;
    checks.push({
      id: "rigor",
      expected: fx.plan.expectedTier ?? null,
      actual: rigorEval.tier,
      matched,
    });
    const rank = { express: 0, standard: 1, strict: 2 };
    if (!matched && fx.plan.expectedTier) {
      if ((rank[rigorEval.tier] ?? 1) < (rank[fx.plan.expectedTier] ?? 1)) {
        regressions.push(`rigor 降级：历史期望 ${fx.plan.expectedTier}，当前判为 ${rigorEval.tier}`);
      } else {
        improvements.push(`rigor 收紧：历史 ${fx.plan.expectedTier} → 当前 ${rigorEval.tier}`);
      }
    }

    // 2) 回放模糊需求澄清门（带上历史 clarifications）
    const amb = analyzePlanAmbiguity({
      objective: fx.plan.objective ?? "",
      stages: fx.plan.stages ?? [],
      criteria: fx.plan.criteria ?? [],
      clarifications: fx.plan.clarifications ?? [],
    });
    if (fx.plan.ambiguityExpected) {
      const ambMatch = amb.blocking === fx.plan.ambiguityExpected.blocking;
      checks.push({
        id: "ambiguity-gate",
        expected: fx.plan.ambiguityExpected.blocking,
        actual: amb.blocking,
        matched: ambMatch,
      });
      if (!ambMatch) {
        if (fx.plan.ambiguityExpected.blocking && !amb.blocking) {
          regressions.push("ambiguity-gate 漏报：历史阻断型歧义在当前版本未触发阻断");
        } else {
          improvements.push("ambiguity-gate 新增捕获了历史未拦住的阻断型歧义");
        }
      }
    }
  }

  // 3) 回放防改测试扫描夹具
  for (const tc of Array.isArray(fx.tamperCases) ? fx.tamperCases : []) {
    const scan = scanDiffForTampering({
      unifiedDiff: tc.unifiedDiff ?? "",
      changedFiles: tc.changedFiles ?? [],
      testChangePolicy: tc.policy ?? "none",
    });
    const matched = scan.ok === tc.expectedOk;
    checks.push({
      id: `tamper:${tc.stageId}`,
      expected: tc.expectedOk,
      actual: scan.ok,
      matched,
    });
    if (!matched) {
      if (tc.expectedOk === false && scan.ok === true) {
        regressions.push(`tamper-scan 漏拦（${tc.stageId}）：历史阻断 [${(tc.expectedBlocks ?? []).join(",")}] 当前放行`);
      } else {
        improvements.push(`tamper-scan 增强拦截（${tc.stageId}）：当前新拦住 [${scan.blocks.map((b) => b.rule).join(",")}]`);
      }
    }
  }

  // 4) 回放事件流卡死检测（如有快照）
  if (Array.isArray(fx.stuckEventsSnapshot) && fx.stuckEventsSnapshot.length > 0) {
    const st = detectStuckLoop(fx.stuckEventsSnapshot);
    const expectedStuck = (trace.final_metrics?.stuck_events ?? 0) > 0;
    const stuckMatched = st.stuck === expectedStuck;
    checks.push({
      id: "stuck-detector",
      expected: expectedStuck,
      actual: st.stuck,
      matched: stuckMatched,
    });
    if (!stuckMatched) {
      if (expectedStuck && !st.stuck) {
        regressions.push("stuck-detector 漏报：历史已触发卡死拦截的事件流在当前版本未检出");
      } else {
        improvements.push(`stuck-detector 增强捕获：当前版本检出 ${st.pattern}`);
      }
    }
  }

  const passed = checks.filter((c) => c.matched).length;
  return {
    ok: regressions.length === 0,
    taskId: trace.task_id ?? null,
    schemaVersion: trace.schema_version,
    totalChecks: checks.length,
    matchedChecks: passed,
    passRate: checks.length > 0 ? passed / checks.length : 1,
    checks,
    regressions,
    improvements,
  };
}

const MAX_TRACE_FILE_BYTES = 4 * 1024 * 1024;

/** 批量回放 `stateDir/traces/` 中全部历史轨迹文件（或指定单个 .json 文件，带安全路径与大小校验）。 */
export async function replayTraceDirectory(stateDir, targetFile = null) {
  if (targetFile) {
    const norm = String(targetFile).replace(/\\/gu, "/");
    if (!norm.toLowerCase().endsWith(".json") || isSensitivePath(norm)) {
      return { ok: false, totalTraces: 0, passedTraces: 0, totalRegressions: 1, results: [{ file: targetFile, ok: false, regressions: ["拒绝读取非 .json 或敏感路径文件"] }] };
    }
    try {
      const st = await lstat(targetFile);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_TRACE_FILE_BYTES) {
        return { ok: false, totalTraces: 0, passedTraces: 0, totalRegressions: 1, results: [{ file: targetFile, ok: false, regressions: ["拒绝读取符号链接或超过 4MB 的轨迹文件"] }] };
      }
    } catch (err) {
      return { ok: false, totalTraces: 0, passedTraces: 0, totalRegressions: 1, results: [{ file: targetFile, ok: false, regressions: [String(err?.message ?? err)] }] };
    }
  }
  const files = targetFile ? [targetFile] : await listSavedTraces(stateDir);
  if (!files.length) {
    return { ok: true, totalTraces: 0, passedTraces: 0, totalRegressions: 0, results: [] };
  }
  const results = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      results.push({ file, ...replayAtifTrace(parsed) });
    } catch (err) {
      results.push({ file, ok: false, reason: String(err?.message ?? err), regressions: ["读取/解析轨迹失败"], improvements: [] });
    }
  }
  const totalRegressions = results.reduce((n, r) => n + (r.regressions?.length ?? 0), 0);
  const passedTraces = results.filter((r) => r.ok).length;
  return {
    ok: totalRegressions === 0 && passedTraces === results.length,
    totalTraces: results.length,
    passedTraces,
    totalRegressions,
    results,
  };
}
