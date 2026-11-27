import { createHash, randomUUID } from "node:crypto";
import { verificationPoint } from "../plan/dag.js";
import { evidenceImpact, findRecheckLoop, reopenEvidence } from "../review/criterion-evidence.js";
import { HANDLERS } from "../tools/handlers.js";
import { createFinding, createReview, closeFinding, findingById, prepareReviewFindings } from "../review/review.js";
import { reviewableReports } from "../review/evidence-reader.js";
import { ERR, MentorError } from "../errors.js";
import { PHASES, allowedNext, transition } from "../state/machine.js";
import { latestReviewJob, isRetryableReview } from "../review/job-scope.js";
import { setPhase } from "./phase-writer.js";

const fail = (code, message, details = {}) => { throw new MentorError(code, message, details); };
const active = (task) => task && task.enabled !== false && !["paused", "archived", "completed"].includes(task.phase);

export function requestCheckpoint(store, kind, evidence = "") {
  const task = store.get();
  if (!active(task)) fail(ERR.TASK_INACTIVE, "任务已暂停、关闭或结束，不能启动审查");
  if (!["plan", "completion"].includes(kind)) fail(ERR.REVIEW_SCOPE, "未知检查点");
  if ((task.reviewJobs ?? []).some(j => ["queued", "running"].includes(j.status))) {
    fail(ERR.REVIEW_PENDING, "仍有审查进行中，完成后再提交此检查点");
  }
  if ((task.nodeRuns ?? []).some(r => ["running", "awaiting-integration"].includes(r.status))) {
    fail(ERR.WORK_PENDING, "先完成在途工作和集成，再提交检查点");
  }
  if (kind === "completion") {
    if (!task.stages?.length || task.stages.some(s => !task.nodeRuns.some(r => r.stageId === s.id && r.status === "accepted"))) {
      fail(ERR.STAGE_NOT_ACCEPTED, "整体验收前必须先完成所有阶段验收");
    }
    const changes = evidenceImpact(task, undefined, {fingerprint:true});
    if (changes.length) {
      const loop = findRecheckLoop(task, changes);
      if (loop.loop) {
        fail(ERR.EVIDENCE_MISMATCH, "同一文件的自动返工已重复触发，已停止自动重开以避免死循环；请人工核对计划依赖与写域",
          { changes, loopDetected: true, repeated: loop.repeated, priorRecheckIds: loop.priorRecheckIds });
      }
      const receipt = reopenEvidence(store, changes);
      fail(ERR.EVIDENCE_MISMATCH, "已重新打开证据变化的阶段及其依赖，请按 recheck 核对受影响的验收项", {changes, recheckId:receipt.id, reopened:true});
    }
    if (typeof evidence !== "string" || !evidence.trim()) fail(ERR.EVIDENCE_REQUIRED, "请提供整体交付物、结果与限制，不能仅列出阶段已通过");
  }
  const stageId = kind === "plan" ? "__plan__" : "__completion__";
  const checkpoint = { kind, stageId, attempt: task.planVersion, planVersion: task.planVersion, evidence, requestedAt: Date.now() };
  // 2026-11-09（T1 契约）：检查点不再替状态机做决定。
  //
  // 计划审查过去是在这里把 phase 直接写成 "reviewing"，而转移表里
  // awaiting-approval → reviewing 根本不存在 —— 于是每次 plan_submit 都造一条非法边，
  // 判 revise 时写回 planning（reviewing → planning）又造一条。
  // 现在：计划审查只在 planning 下提出，**不改 phase**，只挂 pendingCheckpoint；
  // 审查通过/打回时由 applyBoundReview 走 planning→awaiting-approval / active（合法边）。
  if (kind === "plan") {
    if (task.phase !== PHASES.PLANNING) {
      fail(ERR.ILLEGAL_TRANSITION, `计划检查点只能从 planning 阶段提出，当前是 ${task.phase}`, {
        from: task.phase,
        to: PHASES.REVIEWING,
        allowed: allowedNext(task.phase),
        hint: "检查点不改 phase；计划审查在 planning 下进行",
      });
    }
    store.set(transition(task, PHASES.PLANNING, { pendingCheckpoint: checkpoint, updatedAt: Date.now() }));
    return checkpoint;
  }
  // 完成审查：active → reviewing 是转移表里的合法边，但仍走单一写入口 setPhase。
  setPhase(store, PHASES.REVIEWING, { pendingCheckpoint: checkpoint });
  return checkpoint;
}

/* ------------------------------------------------------------------ *
 * Round 3：服务端累计 readCoverage 账本
 *
 * 24KB 预算只能限制「单次传输」，不能降低审查完整性。所以「已读」不再是一次
 * 快照的布尔值，而是按审查作业累计的覆盖账本：
 *   · coverage 由服务端**根据最终投影结果**生成，模型传什么都改不了它；
 *   · 快照里完整出现（未被截断）的报告直接计入 coveredReportIds；
 *   · 被 24KB 预算裁掉的报告，用 { reportId } 单查或 { reportId, offset, maxBytes }
 *     顺序续读到 nextOffset === null 后补记进同一 scopeDigest；
 *   · 只有 complete === true 才写 readAt / readPlanVersion。
 *
 * scopeDigest 由「任务 + 作业 + 计划版本 + 所需报告集合」派生：计划改动或所需
 * 证据变化即换 digest，旧覆盖自动作废，避免拿上一版已读写进这一版。
 * ------------------------------------------------------------------ */

/** 分片续读游标：store → jobId → reportId → 下一个期望 offset */
const chunkLedgers = new WeakMap();

function chunkLedger(store, reviewJobId) {
  let ledger = chunkLedgers.get(store);
  if (!ledger) { ledger = new Map(); chunkLedgers.set(store, ledger); }
  let job = ledger.get(reviewJobId);
  if (!job) { job = new Map(); ledger.set(reviewJobId, job); }
  return job;
}

function scopeDigestOf(task, job, requiredReportIds) {
  return createHash("sha256").update(JSON.stringify({
    taskId: task?.id ?? null,
    reviewJobId: job?.id ?? null,
    planVersion: job?.planVersion ?? null,
    kind: job?.kind ?? null,
    stageId: job?.stageId ?? null,
    attempt: job?.attempt ?? null,
    requiredReportIds,
  }), "utf8").digest("hex");
}

/** 快照里这条报告是否完整（未摘要、未按字符截断、长度对得上）。 */
function snapshotCarriesFullReport(snapshot, reportId) {
  for (const run of Array.isArray(snapshot?.nodeRuns) ? snapshot.nodeRuns : []) {
    for (const report of Array.isArray(run?.reports) ? run.reports : []) {
      if (report?.id !== reportId) continue;
      const evidence = String(report?.evidence ?? "");
      if (report?.evidenceTruncated === true) return false;
      if (Number.isInteger(report?.evidenceLength) && report.evidenceLength !== evidence.length) return false;
      return true;
    }
  }
  return false;
}

/**
 * 登记一次读取。
 *
 * 兼容三种调用：
 *   recordReviewRead(store, sid)                       —— 旧语义：只要有活跃作业就登记 readAt
 *   recordReviewRead(store, sid, { stageId })          —— 旧语义 + 阶段收窄
 *   recordReviewRead(store, sid, { snapshot })         —— 新语义：按快照投影累计覆盖
 *   recordReviewRead(store, sid, { reportRead })       —— 新语义：按单条/分片补读累计覆盖
 */
export function recordReviewRead(store, sessionId, input = {}) {
  const task = store.get();
  if (!task) return;
  const { stageId, snapshot = null, reportRead = null } = input ?? {};
  // 只有显式给了投影结果才启用覆盖账本；纯 { stageId } 调用保持旧行为（既有单测夹具）
  const ledgered = Boolean(snapshot || reportRead);
  let changed = false;
  const reviewJobs = (task.reviewJobs ?? []).map(j => {
    if (!sessionId || j.sessionId !== sessionId || !["queued", "running"].includes(j.status) ||
        j.planVersion !== task.planVersion || latestReviewJob(task, j)?.id !== j.id ||
        (stageId && (j.kind !== "stage" || j.stageId !== stageId))) return j;
    if (!ledgered) {
      changed = true;
      return { ...j, readAt: Date.now(), readPlanVersion: task.planVersion };
    }
    const required = reviewableReports(task, j).map(report => report?.id).filter(Boolean);
    const digest = scopeDigestOf(task, j, required);
    const prior = j.readCoverage?.scopeDigest === digest ? j.readCoverage : null;
    const covered = new Set(prior?.coveredReportIds ?? []);
    let snapshotComplete = prior?.snapshotComplete === true;
    if (snapshot) {
      if (snapshot.taskId === task.id && snapshot.snapshotTruncated !== true) snapshotComplete = true;
      for (const id of required) if (snapshotCarriesFullReport(snapshot, id)) covered.add(id);
    }
    if (reportRead && reportRead.reportId && required.includes(reportRead.reportId)) {
      const id = reportRead.reportId;
      if (reportRead.mode === "full") {
        covered.add(id);
      } else {
        // 分片：只认从头开始、offset 连续且 sha256 一致的读完，防止「只读尾段」或翻页中途内容变化绕过
        const cursor = chunkLedger(store, j.id);
        const expected = cursor.get(id);
        const expectedOffset = typeof expected === "number" ? expected : expected?.nextOffset;
        const expectedSha = typeof expected === "object" && expected ? expected.sha256 : null;
        const shaMatches = !expectedSha || !reportRead.sha256 || expectedSha === reportRead.sha256;
        const sequential = reportRead.offset === 0 || (expectedOffset != null && reportRead.offset === expectedOffset && shaMatches);
        if (sequential && reportRead.nextOffset == null) {
          covered.add(id);
          cursor.delete(id);
        } else if (sequential) {
          cursor.set(id, { nextOffset: reportRead.nextOffset, sha256: reportRead.sha256 ?? null });
        } else {
          cursor.delete(id);
        }
      }
    }
    const coveredReportIds = required.filter(id => covered.has(id));
    const complete = required.every(id => covered.has(id));
    const signature = JSON.stringify([digest, coveredReportIds, snapshotComplete, complete]);
    const priorSignature = prior
      ? JSON.stringify([prior.scopeDigest, prior.coveredReportIds ?? [], prior.snapshotComplete === true, prior.complete === true])
      : null;
    const readAtSatisfied = complete && typeof j.readAt === "number" && j.readPlanVersion === task.planVersion;
    if (signature === priorSignature && (complete ? readAtSatisfied : typeof j.readAt !== "number")) return j;
    changed = true;
    const coverage = {
      version: 1, taskId: task.id, reviewJobId: j.id, planVersion: j.planVersion,
      kind: j.kind, stageId: j.stageId, attempt: j.attempt, scopeDigest: digest,
      requiredReportIds: required, coveredReportIds, snapshotComplete, complete,
    };
    const next = { ...j, readCoverage: coverage };
    if (complete) {
      next.readAt = Date.now();
      next.readPlanVersion = task.planVersion;
    } else {
      delete next.readAt;
      delete next.readPlanVersion;
    }
    return next;
  });
  if (changed) store.set({ ...task, reviewJobs });
}

/** 裁决前的已读门禁：新账本优先，旧夹具（只有 readAt）继续放行。 */
function assertReviewRead(task, job) {
  const coverage = job.readCoverage;
  const required = reviewableReports(task, job).map(report => report?.id).filter(Boolean);
  const needRead = (missing) => ({
    reviewJobId: job.id, stageId: job.stageId ?? null, kind: job.kind ?? null, attempt: job.attempt ?? null,
    missingReportIds: missing,
    suggestedQueries: [
      ...(job.kind === "stage" ? [{ stageId: job.stageId }] : []),
      ...missing.map(id => ({ reportId: id })),
      ...missing.map(id => ({ reportId: id, offset: 0, maxBytes: 16384 })),
    ],
  });
  if (coverage && coverage.planVersion === task.planVersion) {
    if (coverage.complete === true) return;
    const missing = required.filter(id => !(coverage.coveredReportIds ?? []).includes(id));
    fail(ERR.REVIEW_UNREAD, "本轮审查所需证据尚未读完：请先读取任务快照，再用 reportId 逐条读完被 24KB 预算裁掉的报告", {
      needRead: needRead(missing),
      coverage: {
        requiredReportIds: coverage.requiredReportIds ?? [], coveredReportIds: coverage.coveredReportIds ?? [],
        snapshotComplete: coverage.snapshotComplete === true, complete: coverage.complete === true,
      },
    });
  }
  if (job.readAt && job.readPlanVersion === task.planVersion) return;
  fail(ERR.REVIEW_UNREAD, "请先调用 mentor_task_status 读取任务快照（阶段审查可用对应 stageId）；仅查询单条 finding、报告或审查记录不计为已读任务", {
    needRead: needRead(required),
  });
}

export function applyBoundReview(store, args, sessionId) {
  const task = store.get();
  if (!task) fail(ERR.TASK_INACTIVE, "没有任务");
  if (!args.reviewJobId) fail(ERR.REVIEW_IDENTITY, "裁决必须绑定 reviewJobId");
  const job = (task.reviewJobs ?? []).find(j => j.id === args.reviewJobId);
  // 2026-11-07 P0-2（审查派发失败即死锁）修复，第二版。
  //
  // 第一版直接把「job failed」当成放行条件，等于主会话可以给自己判 pass，
  // 没有任何人工条件 —— 审查独立性被这次兜底吃掉了，已被审出并收紧。
  //
  // 现规则：
  //   · 仅当前最新且仍 queued/running 的独立审查会话可交裁决；
  //   · 主会话只能在**该 job 已 failed 且人工已放行**时兜底，
  //     放行记录来自 reviewWaivers（只有 /mentor waive 或面板能写，
  //     模型侧没有等价入口）；
  //   · 兜底裁决必须把 selfReviewed 与 waiver 一起写进 review，事后可审计。
  const isMainSession = Boolean(sessionId) && sessionId === task.mainSessionId;
  const reviewerDispatchFailed = Boolean(job) && job.status === "failed";
  const waiver = reviewerDispatchFailed
    ? (task.reviewWaivers ?? []).find((w) => w.reviewJobId === job.id && w.planVersion === task.planVersion)
    : null;
  const selfReviewFallback = isMainSession && reviewerDispatchFailed && Boolean(waiver);
  if (isMainSession && reviewerDispatchFailed && !waiver) {
    fail(ERR.SELF_REVIEW_UNAUTHORIZED, "独立审查已失败，但主会话不能自行通过：需要人工执行 /mentor waive <理由> 显式放行", {
      reviewJobId: job.id, kind: job.kind, stageId: job.stageId, attempt: job.attempt,
      humanCommands: ["/mentor waive <理由>", "mentor_review_retry"],
    });
  }
  if (!job || (!selfReviewFallback && (job.sessionId !== sessionId || !sessionId || isMainSession))) {
    fail(ERR.REVIEW_IDENTITY, "只有本次独立审查会话可提交裁决，主会话不能自行验收", {
      fallbackAvailable: reviewerDispatchFailed,
      hint: reviewerDispatchFailed
        ? "该检查点的独立审查已失败：需要人工 /mentor waive <理由> 放行后，主会话才能兜底裁决"
        : "先跑一次 mentor_review_retry；仍失败则请人工放行",
    });
  }
  if (job.status === "completed") {
    return { ok: true, value: { taskId: task.id, reviewId: job.reviewId, duplicate: true, kind: job.kind, stageId: job.stageId, attempt: job.attempt, verdict: job.verdict, planVersion: job.planVersion } };
  }
  if (!active(task)) fail(ERR.TASK_INACTIVE, "任务当前不接受审查裁决");
  const currentJob = latestReviewJob(task, job);
  if (currentJob?.id !== job.id || (!selfReviewFallback && !["queued", "running"].includes(job.status)) || job.planVersion !== task.planVersion || args.planVersion !== job.planVersion || args.stageId !== job.stageId || args.attempt !== job.attempt || (args.kind ?? "stage") !== job.kind) {
    fail(ERR.REVIEW_STALE, "审查的任务版本、阶段或尝试已改变，请读取当前状态后重新派发");
  }
  // 自审兜底时主会话本来就在读状态（它一直在推任务），不再要求已读凭据；
  // 独立 reviewer 仍必须先把任务读全，避免不看证据就裁决。
  // Round 3：新账本 readCoverage.complete 优先；仅当 job 没有账本时才回落到
  // 旧的 readAt + readPlanVersion（兼容既有单测夹具与历史落盘数据）。
  if (!selfReviewFallback) assertReviewRead(task, job);
  if (!["pass", "revise"].includes(args.verdict)) fail(ERR.REVIEW_VERDICT, "裁决只接受 pass 或 revise");
  const deferred = args.completionOnlyCriterionId;
  if (deferred !== undefined && (job.kind !== "stage" || args.verdict !== "revise" ||
      !task.stages.find(s => s.id === job.stageId)?.criterionIds.includes(deferred)))
    fail(ERR.REVIEW_SCOPE, "顺序冲突只能指向当前退回阶段负责的验收项");
  let checks = Array.isArray(args.checks) ? args.checks : [];
  if (args.verdict === "pass") {
    if (job.kind !== "plan") {
      const changes = evidenceImpact(task, job.kind === "stage" ? job.stageId : undefined);
      if (changes.length) fail(ERR.EVIDENCE_MISMATCH, "本轮引用的证据已变化，请按受影响项提交整改裁决", {changes});
    }
    const run = job.kind === "stage" && task.nodeRuns.find(r => r.stageId === job.stageId);
    if (run?.recheck?.attempt === job.attempt && run.recheck.retainedCriterionIds?.length && run.reports?.at(-2)?.id === run.recheck.priorReportId) {
      const prior = task.reviews.find(r => r.id === run.recheck.reviewId && !r.selfReviewed && r.verdict === "pass");
      const checked = new Set(checks.flatMap(c => c.criterionIds ?? []));
      const retained = new Set(run.recheck.retainedCriterionIds.filter(id => !checked.has(id)));
      const inherited = (prior?.checks ?? []).flatMap(c => {
        const criterionIds = (c.criterionIds ?? []).filter(id => retained.has(id));
        return c.status === "passed" && criterionIds.length ? [{...c,criterionIds,source:"沿用审查 "+prior.id+" · "+c.source}] : [];
      });
      checks = [...checks,...inherited];
      args = {...args,checks};
    }
    const ids = job.kind === "stage" ? task.stages.find(s => s.id === job.stageId)?.criterionIds ?? [] : task.criteria.map(c => c.id);
    if (!checks.length || checks.some(c => !c.source?.trim() || !c.criterion?.trim() || !c.observation?.trim() || c.status !== "passed")) {
      fail(ERR.CHECKS_REQUIRED, "通过裁决须给实际检查结果：source、criterion、observation、status=passed、criterionIds");
    }
    if (job.kind === "completion") {
      const receipts = new Set((task.recheckHistory ?? []).filter(r => r.planVersion === task.planVersion).map(r => r.id));
      for (const c of task.criteria.filter(c => verificationPoint(c) === "completion-recheck")) {
        if (!checks.some(check => check.criterionIds?.includes(c.id) && receipts.has(check.recheckId)))
          fail(ERR.EVIDENCE_REQUIRED, "此项须引用本版计划实际执行自动返工的记录，请核对 recheckHistory", {criterionId:c.id});
      }
    }
    const covered = new Set(checks.flatMap(c => c.criterionIds ?? []));
    const missing = ids.filter(id => !covered.has(id));
    if (missing.length) fail(ERR.REVIEW_COVERAGE, "检查没有覆盖本次验收项", { missing });
  }
  let result;
  if (job.kind === "stage") {
    const run = task.nodeRuns.find(r => r.stageId === job.stageId);
    if (!run || run.status !== "reported" || run.attempt !== job.attempt || run.reports?.at(-1)?.planVersion !== task.planVersion) fail(ERR.REVIEW_STALE, "本阶段没有当前版本的待审报告");
    result = HANDLERS.mentor_review_apply(store, { ...args, planVersion: job.planVersion, evidenceText: undefined });
    if (!result?.ok) return result;
    // 阶段分支的 review 由 handler 写入，这里补自审痕迹：
    // 只在内存里改标记会让「这条 pass 是人放行的」在落盘记录里丢失。
    if (selfReviewFallback) {
      const after = store.get();
      const reviews = [...(after.reviews ?? [])];
      const last = reviews.length - 1;
      if (last >= 0) reviews[last] = { ...reviews[last], selfReviewed: true, waiver };
      store.set({ ...after, reviews });
    }
  } else {
    if (!task.pendingCheckpoint || task.pendingCheckpoint.kind !== job.kind || task.pendingCheckpoint.planVersion !== task.planVersion) fail(ERR.REVIEW_STALE, "检查点已经失效");
    const allowedStageIds = job.kind === "plan" ? ["__plan__"] : ["__plan__", "__completion__", ...task.stages.map(s => s.id)];
    const prepared = prepareReviewFindings(task, { ...args, stageId: job.stageId, allowedStageIds,
      findings: (args.findings ?? []).map(f => typeof f === "string" ? f : createFinding({ ...f, stageId: job.stageId })) });
    const review = createReview({ ...args, ...prepared, id: randomUUID() });
    const ids = new Set((task.findings ?? []).map(f => f.id));
    for (const finding of review.findings) {
      if (ids.has(finding.id)) fail(ERR.FINDING_DUP, "finding id 已存在，请引用旧问题", { findingId: finding.id });
      ids.add(finding.id);
    }
    review.scope = { kind: job.kind, stageId: job.stageId, attempt: job.attempt, planVersion: job.planVersion };
    review.markedResolved = [...new Set((args.markedResolved ?? []).map(id => findingById(task, id).id))];
    // 自审兜底必须在 review 上留痕，不能与独立审查的结果看起来一样
    if (selfReviewFallback) { review.selfReviewed = true; review.waiver = waiver; }
    if (review.markedResolved.length && args.verdict !== "pass") fail(ERR.REVIEW_VERDICT, "修订裁决不能关闭问题");
    const marked = new Set(review.markedResolved);
    for (const id of marked) {
      const finding = task.findings.find(f => f.id === id);
      if (!finding || !allowedStageIds.includes(finding.stageId)) fail(ERR.REVIEW_SCOPE, "整改项不属于本检查点", { findingId: id, stageId: finding?.stageId ?? null, kind: job.kind, allowedStageIds });
      if (job.kind === "completion" && !["__plan__", "__completion__"].includes(finding.stageId)) {
        const stage = task.stages.find(s => s.id === finding.stageId);
        const run = task.nodeRuns.find(r => r.stageId === finding.stageId);
        const report = run?.reports?.at(-1);
        const evidenceChecks = checks.filter(c => Array.isArray(c.findingIds) && c.findingIds.includes(id) &&
          Array.isArray(c.reportIds) && c.reportIds.includes(report?.id));
        const covered = new Set(evidenceChecks.flatMap(c => c.criterionIds ?? []));
        if (!run || run.status !== "accepted" || !report?.id || report.planVersion !== task.planVersion ||
            !evidenceChecks.length || (stage.criterionIds ?? []).some(id => !covered.has(id))) {
          fail(ERR.REVIEW_SCOPE, "整体验收关闭阶段问题须复核当前已验收报告，并在 checks 中绑定 findingIds、reportIds 和阶段验收项",
            { findingId: id, stageId: finding.stageId, reportId: report?.id ?? null });
        }
        (review.stageFindingRechecks ??= []).push({ findingId: id, stageId: finding.stageId, attempt: run.attempt, reportId: report.id });
      }
    }
    const findings = [...task.findings.map(f => marked.has(f.id) ? closeFinding(f, review.id, { allowOpen: true }) : f), ...review.findings];
    if (args.verdict === "pass" && findings.some(f => f.severity === "blocking" && f.status !== "closed" && (job.kind === "completion" || f.stageId === "__plan__"))) fail(ERR.BLOCKING_FINDING_OPEN, "还有未复核关闭的阻断项；请逐项核验后列入 markedResolved");
    // 2026-11-09（T1/T2 契约）：裁决落点全部走 setPhase，且只用转移表里的合法边：
    //   · plan pass  ：planning → awaiting-approval（要批）/ planning → active（自动批）
    //   · plan revise：planning → planning（自环）
    //   · completion pass：reviewing → completed；revise：reviewing → active
    // 以前这里直接 store.set({ ...task, phase }) 造了 reviewing → planning 这条不存在的边。
    // 若当前 phase 走不通（例如人为构造 reviewing + 计划检查点），assertTransition 会抛
    // E_ILLEGAL_TRANSITION 且不改状态 —— 这正是契约要求的行为。
    const phase = args.verdict === "pass"
      ? (job.kind === "completion" ? PHASES.COMPLETED : task.requireApproval ? PHASES.AWAITING_APPROVAL : PHASES.ACTIVE)
      : (job.kind === "plan" ? PHASES.PLANNING : PHASES.ACTIVE);
    const patch = { findings, reviews: [...task.reviews, review], pendingCheckpoint: null, updatedAt: Date.now() };
    if (job.kind === "plan" && args.verdict === "pass" && !task.requireApproval) {
      patch.approvedPlanVersion = task.planVersion;
      patch.approvedAt = Date.now();
    }
    if (phase === PHASES.COMPLETED) {
      patch.completedAt = Date.now();
      patch.completionEvidence = task.pendingCheckpoint.evidence;
      if (task.team?.issue) patch.team = { ...task.team, issue: null };
    }
    const next = setPhase(store, phase, patch);
    result = { ok: true, value: { taskId: task.id, reviewId: review.id, closedFindingIds: [...marked], verdict: review.verdict, phase, kind: job.kind, stageId: job.stageId, attempt: job.attempt } };
  }
  const current = store.get();
  const continuation = current.continuation?.kind === "review-failed" && current.continuation.reviewJobId === job.id ? null : current.continuation;
  const orderIssue = deferred ? {stageId:job.stageId,criterionId:deferred,planVersion:job.planVersion,reviewJobId:job.id,reviewId:result.value.reviewId} : null;
  const taggedFindings = orderIssue
    ? (current.findings ?? []).map(f => f.reviewId === result.value.reviewId
        ? { ...f, reviewOrder: { planVersion: job.planVersion, stageId: job.stageId, criterionId: deferred } }
        : f)
    : current.findings;
  const settled = { ...current, findings: taggedFindings,
    ...(continuation === undefined ? {} : { continuation }),
    ...(orderIssue && {reviewOrderIssues:[...(current.reviewOrderIssues ?? []),orderIssue]}), reviewJobs: (current.reviewJobs ?? []).map(j => j.id === job.id ? { ...j, status: "completed", reviewId: result.value.reviewId, verdict: args.verdict, updatedAt: Date.now() } : j) };
  store.set(settled);

  // v0.3：阶段返工熔断（Run Budget）
  // 同一计划版本下某阶段连续 revise 达到上限时，自动暂停任务并生成人工介入简报，
  // 防止主会话与审查员陷入死循环烧 token；人工 resume 后重置本阶段熔断计数窗口。
  let circuitBreaker = null;
  const reworkLimit = Number.isInteger(store.settings?.maxStageReworks) ? store.settings.maxStageReworks : 0;
  if (job.kind === "stage" && args.verdict === "revise" && reworkLimit > 0 && settled.phase !== PHASES.PAUSED) {
    const run = (settled.nodeRuns ?? []).find(r => r && r.stageId === job.stageId);
    const resetIdx = Number.isInteger(run?.breakerResetReviewCount) && run.breakerResetReviewCount >= 0
      ? run.breakerResetReviewCount
      : 0;
    const reviseCount = (settled.reviews ?? []).slice(resetIdx).filter(r =>
      r?.scope?.kind === "stage" &&
      r.scope.stageId === job.stageId &&
      r.scope.planVersion === job.planVersion &&
      r.verdict === "revise",
    ).length;
    if (reviseCount >= reworkLimit) {
      const openStageFindings = (settled.findings ?? []).filter(f =>
        f && f.status !== "closed" && f.stageId === job.stageId,
      );
      const triggeredAt = Date.now();
      circuitBreaker = {
        kind: "rework-circuit-breaker",
        stageId: job.stageId,
        planVersion: job.planVersion,
        reviseCount,
        limit: reworkLimit,
        triggeredAt,
        recentFindings: openStageFindings.slice(-6).map(f => ({
          id: f.id,
          severity: f.severity,
          status: f.status,
          text: f.text,
        })),
        summary: `阶段 ${job.stageId} 在计划 v${job.planVersion} 已连续被打回 ${reviseCount} 次（达到返工熔断上限 ${reworkLimit}），已自动暂停等待人工介入。`,
        humanOptions: [
          "在「问题」页签人工关闭争议项并恢复继续",
          "在「概览」调整该阶段执行方向",
          "修订计划（mentor_plan_amend）拆分阶段或重定验收标准",
          "点击「恢复继续」重置本阶段熔断计数后继续执行",
        ],
      };
      setPhase(store, PHASES.PAUSED, {
        prePausePhase: settled.phase,
        pauseReason: circuitBreaker.summary,
        pausedAt: triggeredAt,
        continuation: { status: "needs-attention", ...circuitBreaker },
      });
    }
  }

  result.value = {
    ...result.value,
    ...(circuitBreaker ? { phase: PHASES.PAUSED, circuitBreakerTripped: true, escalationBrief: circuitBreaker } : {}),
    kind: job.kind, stageId: job.stageId, attempt: job.attempt, reviewJobId: job.id, planVersion: job.planVersion, selfReviewed: selfReviewFallback,
  };
  return result;
}

export function reviewsInterruptedByPause(task) {
  if (!Number.isFinite(task.pausedAt)) return [];
  return (task.reviewJobs ?? []).filter(job => {
    if (!isRetryableReview(task, job)) return false;
    if (job.interruptedByPauseAt != null) return job.interruptedByPauseAt === task.pausedAt;
    // Older desktop sessions only recorded the cancellation reason and timestamps.
    return ["task-stopped", "user-control", "任务已由用户停止"].includes(job.error) &&
      job.startedAt <= task.pausedAt && task.pausedAt <= job.updatedAt;
  });
}

export function reviewRetryTarget(store, reviewJobId) {
  const task = store.get();
  if (!active(task)) fail(ERR.TASK_INACTIVE, "恢复任务后才能重试审查");
  const job = (task.reviewJobs ?? []).findLast(j => (!reviewJobId || j.id === reviewJobId) && isRetryableReview(task, j));
  if (!job) fail(ERR.REVIEW_MISSING, "没有当前版本可重试的失败审查");
  return { kind: job.kind, stageId: job.stageId, attempt: job.attempt };
}
