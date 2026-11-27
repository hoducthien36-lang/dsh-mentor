import { createHash } from "node:crypto";
import { DEFAULT_MAX_PARALLEL } from "../tools/parallel.js";
import { buildStatePayload } from "../rpc/state.js";
import { computeParallelism, recommendParallelBatch } from "../plan/parallelism.js";
import { progressView } from "./progress-view.js";
import { teamOverview } from "./team.js";
import { readyNodes, stageAttemptRef } from "../plan/dag.js";

const streams = new Map();
const textOf = content => (Array.isArray(content) ? content : []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
function knownSession(registry, id) {
  return registry.all().some(s => { const t=s.get(); return t && (t.mainSessionId===id || t.reviewJobs?.some(j=>j.sessionId===id) || t.nodeRuns?.some(r=>r.workerSessionId===id)); });
}
export function observeActivity(ctx, registry, disposers) {
  if (typeof ctx.on !== "function") return;
  const dispose=ctx.on("agent/assistant-stream", ({agent,frame}) => {
    const id=agent?.session?.id;
    if (!id || !knownSession(registry,id)) return;
    if (frame.type === "start") streams.set(id,{attemptId:frame.attemptId,text:"",updatedAt:Date.now(),streaming:true});
    const value=streams.get(id);
    if (!value || value.attemptId!==frame.attemptId) return;
    if (frame.type === "chunk" && frame.chunk?.type === "text-delta") { value.text=(value.text+frame.chunk.text).slice(-16000); value.updatedAt=Date.now(); }
    if (frame.type === "end") { value.streaming=false; value.updatedAt=Date.now(); }
  });
  if (typeof dispose === "function") disposers.push(dispose);
  disposers.push(()=>streams.clear());
}
function participant(ctx, item) {
  let agent;
  try { agent=ctx.agents.get(item.sessionId); } catch {}
  const live=streams.get(item.sessionId);
  let events=[];
  try { const end=agent?.session?.seq; events=agent?.session?.snapshotEvents(Math.max(0,(Number(end)||0)-100)) ?? []; } catch {}
  const latest=events.filter(e=>e.type === "assistant/message").at(-1);
  const activity=events.filter(e=>["tool/call","tool/result","turn/end"].includes(e.type)).at(-1);
  const activities=events.filter(e=>e.type === "tool/call").slice(-8).map(e=>({type:"tool",text:e.data?.name??"工具调用",at:e.time}));
  const terminal=["completed","failed","cancelled","accepted","awaiting-integration"].includes(item.status);
  const status=terminal ? item.status : agent ? agent.status === "running" ? "running" : "idle" : ["queued","running"].includes(item.status) ? "unavailable" : item.status ?? "unavailable";
  return { ...item,status,activity:activity?.type === "tool/call" ? activity.data?.name : status === "running" ? "生成回复" : null,outputText:(live?.streaming ? live.text : textOf(latest?.data?.message?.content ?? latest?.data?.content) || item.outputText || live?.text || "").slice(-16000),updatedAt:live?.updatedAt??activity?.time??item.updatedAt??null,streaming:live?.streaming===true && !!agent,activities };
}

/* ------------------------------------------------------------------ *
 * 2026-11-09 修缺陷 4（快照可读性）
 *
 * 真机事故：任务快照约 140KB 时，宿主对工具输出只保留首尾、截掉中段
 * （Omitted ~100KB），而 nodeRuns.reports 是追加式排列，新报告必然落在被截掉的
 * 区段里 —— 审查方于是"永远读不到本轮证据"，即使 evidence 写得再全。
 * 审查侧又没有 read/bash 可用，只有这个快照。
 *
 * 这里给三条通道：
 *   · reportId=X  → 只回那一条报告全文（不附带整快照，保证输出短）
 *   · stageId=X   → 只回该阶段的 nodeRuns 与 reviews
 *   · limit=N     → 控制 nodeRuns.reports 条数（默认 3），单条只截前 4000 字符
 * 并在快照里回带 reportTotal / reportsTruncated，让调用方知道有没有分页。
 * ------------------------------------------------------------------ */

const REPORT_DEFAULT_LIMIT = 3;
const REPORT_CHAR_CAP = 4000;
const REVIEW_HISTORY_LIMIT = 12;
const ACTIVITY_PREVIEW_CAP = 1000;

/* ------------------------------------------------------------------ *
 * Round 3：24KB UTF-8 快照预算（模型默认视图）
 *
 * 宿主对一次工具输出有硬上限。与其让它从中间截断（新报告必然落在被截掉的一段），
 * 不如服务端先按优先级裁剪，并把「裁掉了什么」写成 omitted 计数交给调用方：
 *   snapshotBytes     返回体真实 UTF-8 字节数
 *   snapshotTruncated 是否发生过裁剪
 *   omitted           各类历史被省略的条数
 *
 * 保护顺序：当前阶段 / 在途审查 / 未关闭 blocking finding / nextStep 先保住，
 * 再依次压 participants → tasks → dispatches → reviews → findings → 报告正文，
 * 最后才动报告条数。
 * ------------------------------------------------------------------ */
export const SNAPSHOT_BUDGET_BYTES = 24576;
const SNAPSHOT_TAIL_CHARS = 200;
const SNAPSHOT_RESERVE_BYTES = 320;
const OMITTED_KEYS = Object.freeze(["workers", "participants", "reports", "reviews", "findings", "reviewJobs", "reviewDispatches", "wakeDispatches", "tasks"]);

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

/** 大文本正文 → 定长摘要（绝不留原文）。 */
export function reportSummary(value) {
  const text = String(value ?? "");
  return {
    length: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
    tail: text.slice(-SNAPSHOT_TAIL_CHARS),
  };
}

function byteLengthOf(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

/** 按 UTF-16 安全边界截断（不留半个代理对）。 */
function safeSlice(text, cap) {
  const value = String(text ?? "");
  if (!Number.isFinite(cap) || cap >= value.length) return value;
  let end = Math.max(0, Math.trunc(cap));
  if (end === 0) return "";
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * 按 UTF-8 字节边界切一段文本：offset / maxBytes 都必须是合法整数，
 * 返回的 nextOffset 为 null 表示已读到结尾。
 */
export function readTextChunk(text, offset = 0, maxBytes = 16384) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  const total = buffer.length;
  const size = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.trunc(maxBytes), total || 1) : total || 1;
  let start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.trunc(offset), total) : 0;
  // 起点落到续字节上时回退到该码点的首字节
  while (start > 0 && start < total && (buffer[start] & 0xc0) === 0x80) start -= 1;
  let end = Math.min(total, start + size);
  while (end > start && end < total && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: buffer.subarray(start, end).toString("utf8"),
    offset: start,
    nextOffset: end >= total ? null : end,
    totalBytes: total,
  };
}

function reviewJobSummary(job) {
  const { outputText, ...summary } = job;
  return { ...summary, outputLength: String(outputText ?? "").length, outputOmitted: Boolean(outputText) };
}

function compactParticipant(item) {
  const text = String(item.outputText ?? "");
  return { ...item, outputText: text.slice(-ACTIVITY_PREVIEW_CAP), outputTruncated: text.length > ACTIVITY_PREVIEW_CAP };
}

function allReports(task) {
  const out = [];
  for (const run of Array.isArray(task?.nodeRuns) ? task.nodeRuns : []) {
    for (const report of Array.isArray(run?.reports) ? run.reports : []) {
      out.push({ stageId: run.stageId, attempt: run.attempt, report });
    }
  }
  return out;
}

/** 按 reportId 精确取一条报告（全文，不截断）。 */
export function findReport(task, reportId) {
  if (!reportId) return null;
  const hit = allReports(task).find((entry) => entry.report?.id === reportId);
  if (!hit) return null;
  const evidence = String(hit.report?.evidence ?? "");
  return {
    reportId: hit.report.id,
    stageId: hit.stageId,
    attempt: hit.attempt,
    reportAttempt: hit.report.attempt ?? null,
    summary: hit.report.summary ?? "",
    planVersion: hit.report.planVersion ?? null,
    evidenceRefs: hit.report.evidenceRefs ?? [],
    evidenceFiles: hit.report.evidenceFiles ?? [],
    bindings: hit.report.bindings ?? [],
    ...(hit.report.handoff ? { handoff: hit.report.handoff } : {}),
    ...(hit.report.impactPreview ? { impactPreview: hit.report.impactPreview } : {}),
    evidence,
    evidenceLength: evidence.length,
    full: true,
  };
}

/**
 * 投影 nodeRuns：按 stageId 过滤、按 limit 取最近 N 条、单条截断。
 *
 * Round 3：compact 视图下同时把 nodeRuns[].workerReport 换成摘要，
 * 并把每条报告的原始正文暂存在 originals 里，供后面的字节预算继续收窄。
 */
function projectRuns(task, { stageId, limit, compact }) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : REPORT_DEFAULT_LIMIT;
  const runs = Array.isArray(task?.nodeRuns) ? task.nodeRuns : [];
  const originals = new Map();
  let total = 0;
  let truncated = false;
  const projected = [];
  for (const run of runs) {
    if (stageId && run.stageId !== stageId) continue;
    const reports = Array.isArray(run.reports) ? run.reports : [];
    total += reports.length;
    if (reports.length > cap) truncated = true;
    const kept = reports.slice(-cap).map((report) => {
      const evidence = String(report?.evidence ?? "");
      if (report?.id != null) originals.set(report.id, evidence);
      if (evidence.length <= REPORT_CHAR_CAP) return { ...report };
      truncated = true;
      return { ...report, evidence: evidence.slice(0, REPORT_CHAR_CAP), evidenceTruncated: true, evidenceLength: evidence.length };
    });
    const { workerReport, ...rest } = run ?? {};
    projected.push({
      ...rest,
      reports: kept,
      ...(compact && workerReport != null ? { workerReportSummary: reportSummary(workerReport) } : {}),
      ...(compact ? {} : (workerReport != null ? { workerReport } : {})),
    });
  }
  return { runs: projected, reportTotal: total, reportsTruncated: truncated, reportCap: cap, originals };
}

/** 把已经裁过一次的报告正文继续按 cap 收窄（original 保留 length）。 */
function applyEvidenceCap(payload, cap, originals) {
  for (const run of payload.nodeRuns ?? []) {
    for (const report of run.reports ?? []) {
      const original = originals.get(report?.id);
      if (original === undefined) continue;
      if (original.length <= cap) {
        report.evidence = original;
        if (original.length > REPORT_CHAR_CAP) {
          report.evidence = original.slice(0, REPORT_CHAR_CAP);
          report.evidenceTruncated = true;
          report.evidenceLength = original.length;
        } else {
          delete report.evidenceTruncated;
          delete report.evidenceLength;
        }
        continue;
      }
      report.evidence = safeSlice(original, cap);
      report.evidenceTruncated = true;
      report.evidenceLength = original.length;
    }
  }
}

function countReports(payload) {
  let total = 0;
  for (const run of payload.nodeRuns ?? []) total += (run.reports ?? []).length;
  return total;
}

/**
 * 兜底：把当前最长的字符串字段砍半（skips sha256）。
 * 只在前面所有裁剪步骤都不够时才会跑，用于给「绝不超预算」留最后一道闸。
 */
function shrinkLongestString(root) {
  let target = null;
  const walk = (value, parent, key) => {
    if (typeof value === "string") {
      if (key === "sha256") return;
      if (!target || value.length > target.value.length) target = { parent, key, value };
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], value, i);
      return;
    }
    if (value && typeof value === "object") {
      for (const name of Object.keys(value)) walk(value[name], value, name);
    }
  };
  walk(root, null, null);
  if (!target?.parent || target.value.length <= 40) return false;
  target.parent[target.key] = target.value.slice(0, Math.max(40, Math.floor(target.value.length / 2)));
  return true;
}

/**
 * 逐步裁剪到预算内。每一步都只动「历史/非关键」部分，
 * 当前阶段、在途审查、未关闭 blocking finding 与 nextStep 始终保留。
 */
function fitSnapshot(payload, { originals, baselineTruncated = false }) {
  const omitted = { workers: 0, participants: 0, reports: 0, reviews: 0, findings: 0, reviewJobs: 0, reviewDispatches: 0, wakeDispatches: 0, tasks: 0 };
  let evidenceCap = REPORT_CHAR_CAP;
  let trimmed = Boolean(baselineTruncated);
  const envelope = (bytesDigit = 0) => ({ ...payload, snapshotBytes: bytesDigit, snapshotTruncated: true, omitted });
  const measure = () => byteLengthOf(envelope(SNAPSHOT_BUDGET_BYTES));
  const fits = () => measure() <= SNAPSHOT_BUDGET_BYTES - SNAPSHOT_RESERVE_BYTES;

  const dropTail = (key, keep) => {
    const list = Array.isArray(payload[key]) ? payload[key] : [];
    if (list.length <= keep) return false;
    payload[key] = list.slice(-keep);
    omitted[key] += list.length - keep;
    trimmed = true;
    return true;
  };

  if (!fits()) {
    // 1. 参与者：只留主轴 + 在途审查/执行者，其余（旧助手/旧审查员）先走
    const list = Array.isArray(payload.participants) ? payload.participants : [];
    if (list.length) {
      const keep = [];
      for (const item of list) {
        if (item?.role === "main" || ["queued", "running"].includes(item?.status)) keep.push(item);
      }
      const rest = list.filter((item) => !keep.includes(item)).slice(-2);
      const next = [...keep, ...rest];
      if (next.length < list.length) {
        omitted.participants += list.length - next.length;
        payload.participants = next;
        trimmed = true;
      }
    }
  }
  if (!fits()) dropTail("tasks", 3);
  if (!fits()) {
    if (Array.isArray(payload.reviewDispatches) && payload.reviewDispatches.length > 6) {
      omitted.reviewDispatches += payload.reviewDispatches.length - 6;
      payload.reviewDispatches = payload.reviewDispatches.slice(-6);
      trimmed = true;
    }
    if (!fits() && Array.isArray(payload.wakeDispatches) && payload.wakeDispatches.length > 6) {
      omitted.wakeDispatches += payload.wakeDispatches.length - 6;
      payload.wakeDispatches = payload.wakeDispatches.slice(-6);
      trimmed = true;
    }
  }
  if (!fits()) {
    // 2. 审查历史：保住最新一条与「在途审查对应」的记录
    const list = Array.isArray(payload.reviews) ? payload.reviews : [];
    const keepIds = new Set((payload.reviewJobs ?? []).filter((j) => ["queued", "running"].includes(j?.status)).map((j) => j.reviewId).filter(Boolean));
    const kept = list.filter((review, index) => index >= list.length - 5 || keepIds.has(review?.id));
    if (kept.length < list.length) {
      omitted.reviews += list.length - kept.length;
      payload.reviews = kept;
      trimmed = true;
    }
  }
  if (!fits()) {
    // 3. 整改项：未关闭的全留，已关闭的只留最近 3 条
    const list = Array.isArray(payload.findings) ? payload.findings : [];
    const open = list.filter((item) => item?.status !== "closed");
    const closed = list.filter((item) => item?.status === "closed").slice(-3);
    if (open.length + closed.length < list.length) {
      omitted.findings += list.length - open.length - closed.length;
      payload.findings = [...open, ...closed];
      trimmed = true;
    }
  }
  if (!fits() && Array.isArray(payload.reviewJobs) && payload.reviewJobs.length > 6) {
    const active = payload.reviewJobs.filter((j) => ["queued", "running"].includes(j?.status));
    const recent = payload.reviewJobs.filter((j) => !active.includes(j)).slice(-4);
    omitted.reviewJobs += payload.reviewJobs.length - active.length - recent.length;
    payload.reviewJobs = payload.reviewJobs.filter((j) => active.includes(j) || recent.includes(j));
    trimmed = true;
  }
  if (!fits() && Array.isArray(payload.recheckHistory) && payload.recheckHistory.length > 3) {
    payload.recheckHistory = payload.recheckHistory.slice(-3);
    trimmed = true;
  }
  // v0.4：裁剪 lastPrechecks 与 nodeRuns[].lastPrecheck 的输出尾部，保留状态/退出码/阶段信息，避免撑爆 24KB
  if (!fits()) {
    const compactPrecheck = (entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const results = Array.isArray(entry.results)
        ? entry.results.map((r) => ({ id: r.id, label: r.label, ok: r.ok, exitCode: r.exitCode, timedOut: Boolean(r.timedOut), durationMs: r.durationMs }))
        : [];
      return { at: entry.at ?? null, ok: entry.ok, total: entry.total, passed: entry.passed, failed: entry.failed, durationMs: entry.durationMs, results };
    };
    if (payload.lastPrechecks && typeof payload.lastPrechecks === "object") {
      const nextMap = {};
      for (const [k, v] of Object.entries(payload.lastPrechecks)) nextMap[k] = compactPrecheck(v);
      payload.lastPrechecks = nextMap;
      trimmed = true;
    }
    for (const run of payload.nodeRuns ?? []) {
      if (run?.lastPrecheck) {
        run.lastPrecheck = compactPrecheck(run.lastPrecheck);
        trimmed = true;
      }
    }
  }
  // v0.5：裁剪 lastDiffAudits / stageCheckpoints / suggestedPrechecks，确保永不撑爆 24KB
  if (!fits()) {
    if (payload.suggestedPrechecks) {
      delete payload.suggestedPrechecks;
      trimmed = true;
    }
    if (payload.stageCheckpoints) {
      delete payload.stageCheckpoints;
      trimmed = true;
    }
    if (payload.lastDiffAudits && typeof payload.lastDiffAudits === "object") {
      const compactMap = {};
      for (const [k, v] of Object.entries(payload.lastDiffAudits)) {
        if (!v || typeof v !== "object") continue;
        compactMap[k] = {
          mode: v.mode,
          totalChangedFiles: v.totalChangedFiles,
          totalDiffLines: v.totalDiffLines,
          undeclaredCount: v.undeclaredFiles?.length ?? 0,
          tamperWarnings: v.tamperScan?.warnings?.length ?? 0,
        };
      }
      payload.lastDiffAudits = compactMap;
      trimmed = true;
    }
  }
  // v0.6 + v1.0：裁剪扩展观测字段，确保 24KB 预算硬约束
  if (!fits()) {
    for (const key of ["lastMutations", "stuckEvents", "mcpSchemaAlerts", "ambiguityReport", "clarifications"]) {
      if (payload[key] !== undefined) {
        delete payload[key];
        trimmed = true;
      }
    }
  }
  if (!fits()) {
    // 4. 报告正文：先按字节预算整体收窄，尽量保住每条报告的「条数」
    applyEvidenceCap(payload, 0, originals);
    if (measure() <= SNAPSHOT_BUDGET_BYTES - SNAPSHOT_RESERVE_BYTES) {
      let lo = 0;
      let hi = REPORT_CHAR_CAP;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        applyEvidenceCap(payload, mid, originals);
        if (measure() <= SNAPSHOT_BUDGET_BYTES - SNAPSHOT_RESERVE_BYTES) lo = mid;
        else hi = mid - 1;
      }
      applyEvidenceCap(payload, lo, originals);
      evidenceCap = lo;
      if (lo < REPORT_CHAR_CAP) trimmed = true;
    } else {
      applyEvidenceCap(payload, 0, originals);
      evidenceCap = 0;
      trimmed = true;
    }
  }
  // 5. 仍然超预算：从最旧的报告开始整条丢弃
  while (!fits() && countReports(payload) > 0) {
    let victim = null;
    for (const run of payload.nodeRuns ?? []) {
      const reports = run.reports ?? [];
      if (!reports.length) continue;
      if (!victim || (reports[0]?.attempt ?? 0) < (victim.reports[0]?.attempt ?? 0)) victim = run;
    }
    if (!victim) break;
    victim.reports = victim.reports.slice(1);
    omitted.reports += 1;
    trimmed = true;
  }
  // 6. 兜底：去掉纯展示块，保住任务骨架
  if (!fits()) {
    for (const key of ["progress", "activeReview", "wake", "parallelism", "team"]) {
      if (payload[key] !== undefined && payload[key] !== null) {
        payload[key] = key === "parallelism" || key === "team" ? null : undefined;
        delete payload[key];
        trimmed = true;
      }
    }
  }
  if (!fits() && Array.isArray(payload.participants) && payload.participants.length) {
    omitted.participants += payload.participants.length;
    payload.participants = [];
    trimmed = true;
  }
  if (!fits() && Array.isArray(payload.tasks) && payload.tasks.length) {
    omitted.tasks += payload.tasks.length;
    payload.tasks = [];
    trimmed = true;
  }
  if (!fits() && typeof payload.objective === "string" && payload.objective.length > 400) {
    payload.objective = safeSlice(payload.objective, 400);
    trimmed = true;
  }
  if (!fits()) {
    for (const stage of payload.stages ?? []) {
      if (typeof stage?.description === "string" && stage.description.length > 300) {
        stage.description = safeSlice(stage.description, 300);
        trimmed = true;
      }
    }
  }
  // 7. 最后一道闸：还有超长字符串就砍半，保证「绝不超预算」是硬约束
  for (let guard = 0; guard < 256 && !fits(); guard += 1) {
    if (!shrinkLongestString(payload)) break;
    trimmed = true;
  }
  return { omitted, trimmed, evidenceCap };
}

function finalizeSnapshot(payload, { omitted, trimmed }) {
  const out = { ...payload, snapshotBytes: 0, snapshotTruncated: Boolean(trimmed), omitted };
  let bytes = byteLengthOf(out);
  for (let i = 0; i < 4 && out.snapshotBytes !== bytes; i++) {
    out.snapshotBytes = bytes;
    bytes = byteLengthOf(out);
  }
  out.snapshotBytes = bytes;
  return out;
}

export function runtimePayload(ctx, store, registry, options = {}) {
  const task=store.get();
  const { stageId, reportId, reviewJobId, workerId, limit: reportLimit, compact = true } = options ?? {};

  // Exact history lookup keeps the default snapshot small without losing stored evidence.
  if (reviewJobId) {
    const job = (task?.reviewJobs ?? []).find(j => j.id === reviewJobId);
    return {
      taskId: task?.id ?? null, reviewJobOnly: true, found: Boolean(job),
      ...(job ? {
        reviewDispatches: (task.reviewDispatches ?? []).filter(entry => entry.reviewJobId === job.id),
        wakeDispatches: (task.wakeDispatches ?? []).filter(entry => {
          if (entry.reviewJobId != null) return entry.reviewJobId === job.id;
          // Older wake records encoded the job or verdict ID in the delivery key.
          return entry.key?.startsWith(task.id + "/" + job.id + "/") ||
            (job.reviewId && entry.key?.startsWith(task.id + "/" + job.reviewId + "/"));
        }),
        reviewJob: { ...job }, review: (task.reviews ?? []).find(r => r.id === job.reviewId) ?? null,
      }
        : { reason: "review-job-not-found", reviewJobId }),
    };
  }

  // Round 3：助手单查。只回这一条的完整记录（含 report 原文），不附带整快照。
  if (workerId) {
    const workers = Array.isArray(task?.workers) ? task.workers : [];
    const worker = workers.find((item) => item && (item.key === workerId || item.sessionId === workerId || item.id === workerId));
    return {
      taskId: task?.id ?? null, workerOnly: true, found: Boolean(worker),
      ...(worker ? { worker: { ...worker } } : {
        reason: "worker-not-found", workerId,
        knownWorkerIds: workers.map((item) => item?.key ?? item?.sessionId ?? item?.id).filter(Boolean).slice(-20),
      }),
    };
  }

  // 通道 A：只要一条报告全文。**不返回整快照** —— 否则又会被宿主截断，等于没取到。
  if (reportId) {
    const hit = findReport(task, reportId);
    const total = allReports(task).length;
    const chunked = options.offset !== undefined || options.maxBytes !== undefined;
    if (!hit) {
      return {
        taskId: task?.id ?? null, reportOnly: true, found: false, reportTotal: total,
        reason: "report-not-found", reportId,
        knownReportIds: allReports(task).map((e) => e.report?.id).filter(Boolean).slice(-20),
      };
    }
    if (chunked) {
      // 分片续读：按 UTF-8 边界切，nextOffset=null 表示这条已读完
      const slice = readTextChunk(hit.evidence, options.offset, options.maxBytes);
      return {
        taskId: task?.id ?? null, reportOnly: true, found: true,
        reportId: hit.reportId, stageId: hit.stageId, attempt: hit.attempt,
        offset: slice.offset, nextOffset: slice.nextOffset, totalBytes: slice.totalBytes,
        sha256: sha256Hex(hit.evidence), full: slice.nextOffset === null,
        text: slice.text,
      };
    }
    return {
      taskId: task?.id ?? null,
      reportOnly: true,
      found: true,
      reportTotal: total,
      report: hit,
    };
  }

  const projection = projectRuns(task, { stageId, limit: reportLimit, compact });
  let base=buildStatePayload(task);
  base={ ...base, nodeRuns: projection.runs, reportTotal: projection.reportTotal, reportsTruncated: projection.reportsTruncated };
  if (compact) {
    // 原始 workers[].report 是大头：默认视图只留摘要，完整记录用 workerId 单查
    base.workers = (Array.isArray(task?.workers) ? task.workers : []).map((worker) => {
      const { report, ...rest } = worker ?? {};
      return report == null ? rest : { ...rest, reportSummary: reportSummary(report) };
    });
  }
  // 通道 B：按阶段收窄
  if (stageId) {
    base.stageFilter = stageId;
    base.reviewDispatches = (base.reviewDispatches ?? []).filter(entry => entry.stageId === stageId);
    base.wakeDispatches = (base.wakeDispatches ?? []).filter(entry => entry.stageId === stageId);
    base.reviews=(base.reviews??[]).filter(r=>r?.scope?.stageId===stageId);
    base.findings=(base.findings??[]).filter(f=>f?.stageId===stageId);
    base.criteria=base.criteria??[];
  }
  const historyCap = Number.isInteger(reportLimit) && reportLimit > 0
    ? Math.min(reportLimit, REVIEW_HISTORY_LIMIT) : REVIEW_HISTORY_LIMIT;
  const jobs = (task?.reviewJobs ?? []).filter(j => !stageId || j.stageId === stageId);
  base.reviewJobs = jobs.slice(-historyCap).map(reviewJobSummary);
  base.reviewJobTotal = jobs.length;
  base.reviewJobsTruncated = jobs.length > historyCap;
  if (compact) {
    const reviews = base.reviews ?? [];
    base.reviewTotal = reviews.length;
    base.reviewsTruncated = reviews.length > historyCap;
    base.reviews = reviews.slice(-historyCap);
    if (stageId) base.lastReview = base.reviews.at(-1) ?? null;
  }
  if(task?.continuation?.status==="needs-attention")base.continuation=task.continuation;
  const activeRun=(task?.reviewJobs??[]).some(j=>["queued","running"].includes(j.status)) ||
    (task?.nodeRuns??[]).some(r=>r.status==="running");
  const lastActivity=Math.max(Number(task?.updatedAt)||0, Number(task?.continuation?.at)||0);
  if(task?.enabled!==false && ["planning","active","reviewing"].includes(task?.phase) &&
      !activeRun && lastActivity>0 && Date.now()-lastActivity>24*60*60*1000 && base.continuation?.status!=="needs-attention"){
    base.continuation={status:"needs-attention",kind:"stalled",reason:"此任务超过 24 小时没有状态更新。请查看问题后继续，或由你决定是否归档。",at:lastActivity};
  }
  const tasks=registry?.summaries?.()??[];
  if (!task) return {...base,tasks};
  let participants=[];
  if (task.mainSessionId) participants.push(participant(ctx,{id:task.mainSessionId,sessionId:task.mainSessionId,role:"main",status:["archived","completed"].includes(task.phase)?"completed":undefined}));
  const seenWorkerSessions = new Set();
  for (const r of task.nodeRuns??[]) if(r.workerSessionId && (!stageId || r.stageId===stageId)) {
    seenWorkerSessions.add(r.workerSessionId);
    const workerRec = (task.workers ?? []).find(w => w?.sessionId === r.workerSessionId || (w?.stageId === r.stageId && w?.attempt === r.attempt));
    participants.push(participant(ctx,{id:r.workerSessionId,sessionId:r.workerSessionId,role:"worker",stageId:r.stageId,attempt:r.attempt,status:r.workerStatus??r.status,startedAt:r.startedAt,outputText:r.workerReport,error:r.failedReason,...(workerRec?.worktree ? { worktree: workerRec.worktree } : {})}));
  }
  for (const w of (task.workers ?? []).filter(w => w?.sessionId && !seenWorkerSessions.has(w.sessionId) && (!stageId || w.stageId === stageId)).slice(-8)) {
    seenWorkerSessions.add(w.sessionId);
    participants.push(participant(ctx,{id:w.sessionId,sessionId:w.sessionId,role:"worker",stageId:w.stageId,attempt:w.attempt,status:w.status,startedAt:w.startedAt,updatedAt:w.updatedAt,outputText:w.report,error:w.error,...(w.worktree ? { worktree: w.worktree } : {})}));
  }
  for (const j of (task.reviewJobs??[]).filter(j=>!stageId||j.stageId===stageId).slice(-12)) participants.push(participant(ctx,{id:j.id,sessionId:j.sessionId,role:"reviewer",kind:j.kind,stageId:j.stageId,attempt:j.attempt,status:j.status,startedAt:j.startedAt,updatedAt:j.updatedAt,outputText:j.outputText,error:j.error}));
  if (compact) participants = participants.map(compactParticipant);
  const reviewer=participants.filter(x=>x.role==="reviewer").findLast(x=>["queued","running"].includes(x.status)) ?? participants.filter(x=>x.role==="reviewer").at(-1);
  const limit=store.settings?.maxParallelNodes??DEFAULT_MAX_PARALLEL;
  const ready=readyNodes(task.stages??[],task.nodeRuns??[]);
  const reportable = new Set([...ready, ...(task.nodeRuns ?? []).filter(r => r.status === "awaiting-integration").map(r => r.stageId)]);
  base.reportBindings = [...reportable].filter(id => !stageId || id === stageId).map(id => ({
    stageId:id, attemptRef:stageAttemptRef(task,id,task.nodeRuns.find(r => r.stageId === id)?.attempt ?? 1)
  }));
  const running=(task.nodeRuns??[]).filter(r=>r.status==="running").map(r=>r.stageId);
  let plan={};try{plan=computeParallelism(task.stages??[],{maxParallel:limit});}catch{}
  let recommendation=[];try{recommendation=recommendParallelBatch(task.stages??[],ready,running,limit);}catch{}
  const wake=base.wakeDispatches?.at(-1);
  const payload={...base,...(!compact?{progress:progressView(task,base.nextStep)}:{}),tasks,participants,team:teamOverview(task),activeReview:reviewer?{...reviewer,text:reviewer.outputText}:null,parallelism:{...plan,limit,running:running.length,ready:ready.length,recommendation:recommendation.stageIds??[],availableSlots:recommendation.availableSlots??0},wake:wake?{status:wake.status ?? (wake.queued ? "sent" : "failed"),at:wake.at,reason:wake.reason}:null};
  // 模型默认视图（compact !== false）强制落在 24KB UTF-8 预算内；
  // 面板取数（compact:false）保持全量，不做裁剪。
  if (compact === false) return payload;
  // v0.4 P0 修：fitSnapshot 会截断 stages[].description 与超长字段，必须先深拷贝，绝不污染 store.get() 共享引用！
  const isolatedPayload = structuredClone(payload);
  const baselineTruncated = projection.reportsTruncated === true ||
    base.reviewJobsTruncated === true || base.reviewsTruncated === true;
  return finalizeSnapshot(isolatedPayload, fitSnapshot(isolatedPayload, { originals: projection.originals, baselineTruncated }));
}
