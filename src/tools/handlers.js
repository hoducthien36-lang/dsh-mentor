/**
 * 工具处理器层（SPEC §4）。
 *
 * 设计约束：这一层**不依赖 DSH**。每个 handler 是
 *   (store, params) => result
 * 的纯函数，DSH 适配层（lib/index.js）只负责把它们包成 defineTool。
 * 这样工具行为可以用内存 store 完整测试，不需要真实会话。
 *
 * 所有 handler 都过 guard：错误统一收敛成 { ok:false, code, message, details? }，
 * 不把裸异常抛到工具边界。
 *
 * 关于 taskId：SPEC §4 要求各工具带 taskId。本实现的状态存储是单任务的，
 * 因此 taskId 是「可选校验参数」——传了就核对是否与当前任务一致，不一致返回
 * 结构化错误而不是静默忽略。多任务存储只需替换 store 实现，handler 签名不变。
 */

import { isRetryableReview } from "../review/job-scope.js";
import { ERR, MentorError, assertOrThrow, ok, toFailure } from "../errors.js";
import { amendedRuns } from "../plan/amendment.js";
import { isWorkerReceipt, handoffInputs } from "../review/handoff.js";
import { changedBindings, collectBindings, evidenceImpact, recheckScope } from "../review/criterion-evidence.js";
import { readEvidenceText, carryReportFiles } from "../review/evidence-reader.js";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { assertEvidenceSync } from "../review/evidence-check.js";
import { assertReportAllowed } from "../review/report-gate.js";
import {
  PARALLEL_CODE,
  assertDisjointWritePaths,
  DEFAULT_MAX_PARALLEL,
  validateBatch,
  planBatch,
  rollbackFor,
} from "./parallel.js";
import { computeParallelism, suggestSplit } from "../plan/parallelism.js";
import {
  NODE_RUN_STATUS,
  PAUSE_REASONS,
  PHASES,
  checkCompletionReadiness,
  createTask as createTaskModel,
  isFinished,
  isPauseReason,
  pauseReasonList,
  transition,
} from "../state/machine.js";
import { objectiveCriteria, includeObjectiveCriteria } from "../plan/objective-criteria.js";
import { BLOCK, allowedTransitions, assertWritable, isLive } from "../state/guard.js";
import { setPhase, restorePhase } from "../runtime/phase-writer.js";
import { buildStatePayload } from "../rpc/state.js";
import { collectDependents, readyNodes, validatePlan, verificationPoint, stageAttemptRef, reviewOrderConflict, reviewOrderMessage } from "../plan/dag.js";
import {
  VERDICT,
  applyReview,
  assertEvidenceRefs,
  createFinding,
  createReview,
  prepareReviewFindings,
  findingById,
  forceCloseFinding,
  submitFindingResponse,
  submitStageReport,
  unresolvedSummary,
  verifyQuotes,
} from "../review/review.js";

/**
 * phase 被绕过状态机直接改写时的错误码。
 *
 * 2026-11-09（F2-1）：唯一来源改为 `src/errors.js` 的 `ERR.PHASE_WRITE_BYPASS`（SPEC §3 已登记）。
 * 这里保留同名导出只为兼容既有 import，不再持有字面量。
 */
export const PHASE_WRITE_BYPASS = ERR.PHASE_WRITE_BYPASS;

/**
 * 内存版状态存储；s5 接真实持久化时换掉实现即可，handler 不用改。
 *
 * 2026-11-09（T3 契约）：store 是「phase 只能通过 setPhase 写」这条规则的执行点。
 * 维护一份**已提交快照**（id + phase）：
 *   · `set(next, { phaseWriter: true })` —— 来自 src/runtime/phase-writer.js，放行；
 *   · 其余调用若在同一条任务上改了 phase，抛 E_PHASE_WRITE_BYPASS 且不落库；
 *   · 任务被整体替换（id 变化，如 mentor_task_create 换掉已完成任务）时放行并重置快照。
 *
 * 为什么用快照而不是「比较 get() 前后引用」：get() 返回的就是内部对象，
 * `const t = store.get(); t.phase = X; store.set(t)` 这种就地铁律里前后是同一个引用，
 * 引用比较永远看不出差别；只有 store 自己记住上次提交的 phase 才抓得住。
 */
export function createMemoryStore(initial = null) {
  let task = initial;
  let committedId = initial && typeof initial === "object" ? initial.id ?? null : null;
  let committedPhase = initial && typeof initial === "object" ? initial.phase ?? null : null;

  return {
    get: () => task,
    /**
     * @param {object|null} next 新任务对象
     * @param {{phaseWriter?: boolean}} [meta] 只有 phase-writer.setPhase 会带
     */
    set: (next, meta) => {
      if (next && typeof next === "object") {
        const sameTask = next.id === committedId;
        // 只在「两边都有合法 phase 且不同」时判定为旁路：
        // 测试夹具/启动期错误对象可能根本没有 phase 字段，那种写入不是状态迁移。
        const phaseChanged =
          typeof committedPhase === "string" &&
          typeof next.phase === "string" &&
          next.phase !== committedPhase;
        if (sameTask && phaseChanged && meta?.phaseWriter !== true) {
          throw new MentorError(
            PHASE_WRITE_BYPASS,
            "phase 只能通过 setPhase() 变更：绕过状态机的写入被拒绝",
            {
              taskId: next.id,
              from: committedPhase,
              to: next.phase ?? null,
              hint: "改用 src/runtime/phase-writer.js 的 setPhase(store, to, patch)",
            },
          );
        }
        committedId = next.id ?? null;
        committedPhase = next.phase ?? null;
      } else {
        committedId = null;
        committedPhase = null;
      }
      task = next;
      return task;
    },
    clear: () => {
      task = null;
      committedId = null;
      committedPhase = null;
    },
  };
}

/** 把异常收敛成结果形状 */
function guard(fn) {
  return (store, params) => {
    try {
      return fn(store, params ?? {});
    } catch (err) {
      return toFailure(err);
    }
  };
}

/**
 * 取当前任务；若传入 taskId 则核对其与当前任务一致。
 * 单任务实现下，传入别的 id 是明确的调用错误，不静默忽略。
 */
function requireTask(store, taskId) {
  const task = store.get();
  if (!task) {
    // 预期状态，不是内部故障：用专用码，调用方可据此决定"先建任务"而不是"报 bug"
    throw new MentorError(ERR.NO_TASK, "当前没有任务，先调用 mentor_task_create", {
      hint: "mentor_task_create",
    });
  }
  if (typeof taskId === "string" && taskId.length > 0 && taskId !== task.id) {
    throw new MentorError(
      ERR.TASK_MISMATCH,
      `本实现同一时刻只持有一个任务：当前为 ${task.id}，请求的是 ${taskId}`,
      { requestedTaskId: taskId, currentTaskId: task.id, multiTask: false },
    );
  }
  return task;
}

/* ------------------------------------------------------------------ *
 * 1. 建任务
 * ------------------------------------------------------------------ */

export const taskCreate = guard((store, params) => {
  const existing = store.get();

  // 已完成 / 已归档的任务不阻塞新任务。
  // 理由：这两种状态都不再推进，留着只会让插件永久不可用（真实使用中表现为
  // 「完成一次任务后必须重启 DSH」）。
  // 2026-11-04 控制接口（s4 审查）：**必须把 archived 也算进可替换**。
  // taskClear 把任务置 archived 后仍留在 store，而 computeNextStep 对 archived
  // 明确提示「要开新任务用 mentor_task_create」—— 只放行 completed 的话，
  // 用户点完 Clear 就既没有 live 任务、又建不了新任务，导师被彻底锁死，
  // 只能手删状态文件。clear → create 必须是一条通的路。
  const REPLACEABLE_PHASES = [PHASES.COMPLETED, PHASES.ARCHIVED];
  let replacedTaskId = null;
  if (existing && !REPLACEABLE_PHASES.includes(existing.phase)) {
    throw new MentorError(
      ERR.TASK_EXISTS,
      `已存在进行中的任务 ${existing.id}（phase=${existing.phase}）；` +
        "本实现不做多任务并行，请先完成、归档或等待其结束",
      { taskId: existing.id, phase: existing.phase },
    );
  }
  if (existing) replacedTaskId = existing.id;

  const task = createTaskModel(params.objective);
  const required = objectiveCriteria(task.objective, params.acceptanceGoals);
  if (required.length) task.requiredCriteria = required;
  // 记录触发本次任务的人类消息序号（SPEC §4 要求，可为空）
  if (typeof params.userMessageSeq === "number") {
    task.userMessageSeq = params.userMessageSeq;
  }
  // 2026-11-04 控制接口：requireApproval 必须落到任务对象上。
  // 上一轮只在 TOOLS 里加了这个参数、planSubmit 里读 task.requireApproval，
  // 但忘了在这里持久化 —— 于是任务永远没有这个字段，isSubmitted 恒为 false，
  // 默认路径永远自动批准，mentor_task_approve 在真实工具链里根本不可达
  //（s2 审查指出的核心缺陷）。
  task.enabled = true;
  task.humanInterventions = 0;
  if (typeof params.workClass === "string" && params.workClass.trim()) task.workClass = params.workClass.trim().slice(0,100);
  if (typeof params.rigor === "string" && ["express", "standard", "strict"].includes(params.rigor.trim().toLowerCase())) {
    const reqTier = params.rigor.trim().toLowerCase();
    task.rigor = {
      tier: reqTier,
      requested: reqTier,
      userExplicit: params.rigorUserExplicit === true,
      skipPlanReview: false,
      reasons: [params.rigorUserExplicit === true ? `用户指定 ${reqTier}` : `初始请求 ${reqTier}`],
      updatedAt: Date.now(),
    };
  }
  if (params.humanCitationRequest === true) task.humanCitationRequest = true;
  if (typeof params.workspaceRoot !== "string" || !path.isAbsolute(params.workspaceRoot)) {
    throw new MentorError(ERR.WORKSPACE_REQUIRED, "创建任务需要明确的绝对工作区路径 workspaceRoot");
  }
  task.workspaceRoot = path.resolve(params.workspaceRoot);
  task.requireApproval = params.requireApproval === true;
  // 2026-11-05 自动唤醒：记下"谁在推这个任务"。
  // 由工具层注入（exec.agent.session.id），模型不需要也不应该手填；
  // 旧任务没有这个字段时，唤醒判定返回 no-main-session 而不是报错。
  if (typeof params.mainSessionId === "string" && params.mainSessionId.length > 0) {
    task.mainSessionId = params.mainSessionId;
  }
  store.set(task);
  return ok({
    taskId: task.id,
    phase: task.phase,
    revision: task.revision,
    userMessageSeq: task.userMessageSeq ?? null,
    workspaceRoot: task.workspaceRoot,
    requireApproval: task.requireApproval,
    ...(task.requiredCriteria ? { requiredCriteria: task.requiredCriteria } : {}),
    // 覆盖了上一个已完成任务时告知调用方，不静默丢弃
    replacedTaskId,
  });
});

/* ------------------------------------------------------------------ *
 * 2. 读状态
 * ------------------------------------------------------------------ */

export const taskStatus = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (params.findingId) {
    return ok({ taskId: task.id, finding: findingById(task, params.findingId) });
  }

  // 2026-11-04 控制接口：改为复用 buildStatePayload，保证工具返回值与
  // 面板 RPC 端点逐字段一致（test/rpc.test.mjs 用深度相等锁着这个契约）。
  // 之前这里手抄了一份字段清单，加 nextStep/enabled 时两边就会悄悄分叉。
  return ok(buildStatePayload(task));
});

/* ------------------------------------------------------------------ *
 * 3. 提交计划
 * ------------------------------------------------------------------ */

export const planSubmit = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase !== PHASES.PLANNING) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `只有 planning 阶段能提交计划，当前是 ${task.phase}`,
      { phase: task.phase },
    );
  }

  const criteria = includeObjectiveCriteria(task.requiredCriteria, Array.isArray(params.criteria) ? params.criteria : []);
  const stages = Array.isArray(params.stages) ? params.stages : [];

  const check = validatePlan({ criteria, stages });
  if (!check.ok) {
    return {
      ok: false,
      code: check.errors.find(e => e.code === ERR.REVIEW_ORDER)?.code ?? ERR.EMPTY_PLAN,
      message: check.errors.find(e => e.code === ERR.REVIEW_ORDER)?.message ?? "计划校验未通过",
      details: { taskId: task.id, errors: check.errors },
    };
  }

  const planVersion = (task.planVersion ?? 0) + 1;
  // 2026-11-09（T1 契约）：检查点审查开启时，提交计划**不改 phase**。
  //
  // 转移表里没有 awaiting-approval → reviewing，也没有 reviewing → planning；
  // 以前这里是 planning→awaiting-approval 再让检查点直接 store.set 成 reviewing，
  // 等于每次 plan_submit 都造一条非法边（并让 revise 回 planning 同样非法）。
  // 现在改成：
  //   · 有检查点审查 → phase 留在 planning，审查通过后由 applyBoundReview
  //     走 planning→awaiting-approval（要人工批准）或 planning→active（自动批准）；
  //   · 没有检查点审查（单测/旧配置）→ 保持原行为：先 awaiting-approval，
  //     不需要批准再进 active。
  const inherited = task.nodeRuns?.length ? amendedRuns(task,stages,criteria,planVersion) : null;
  const patch = { criteria, stages, planVersion, ...(inherited?{nodeRuns:inherited.nodeRuns}:{}), updatedAt: Date.now() };
  let next;
  if (store.settings?.requireCheckpointReviews === true) {
    next = setPhase(store, PHASES.PLANNING, patch);
  } else if (task.requireApproval === true) {
    next = setPhase(store, PHASES.AWAITING_APPROVAL, patch);
  } else {
    next = setPhase(store, PHASES.ACTIVE, {
      ...patch,
      approvedPlanVersion: planVersion,
      approvedAt: Date.now(),
      autoApproved: true,
    });
  }

  const parallelism = computeParallelism(stages);
  const split = suggestSplit(stages, parallelism);

  return ok({
    taskId: next.id,
    planVersion,
    phase: next.phase,
    // 语义：这一版计划最终是否需要 mentor_task_approve。
    // 检查点审查开启时 phase 停在 planning，不能再用 phase 反推，直接看任务字段。
    requiresApproval: task.requireApproval === true,
    // 2026-11-07 澄清（P2）：`requiresApproval` 容易被读成「要人工点批准」，
    // 实际语义是「这一版计划还没走完审查」。检查点审查恒开
    // （session-stores 里 requireCheckpointReviews: true）时它恒为 true，
    // 与任务级 requireApproval（是否要 mentor_task_approve）不是一个东西，
    // 故单列 requiresReview，两者同时给出、含义分开。
    requiresReview: store.settings?.requireCheckpointReviews === true,
    // 2026-11-09：审查期停在 planning（不再进 reviewing），把这个状态显式写进返回，
    // 面板/调用方不用猜「为什么提交完还是 planning」。
    reviewPending: store.settings?.requireCheckpointReviews === true,
    validation: { ok: true, errors: [] },
    // 计划一提交就把「能不能并行」摆出来：宽度=1 的多节点计划会被建议拆
    parallelism,
    split,
  });
});

/* ------------------------------------------------------------------ *
 * 3b. 修订计划（active / reviewing 阶段仍可改，且必须留痕）
 * ------------------------------------------------------------------ */

/**
 * 为什么要这个工具：上一轮把 GET 写成自查端点，实测 GET 一律 400，
 * 只能改 POST + buffered —— 但计划已经 active，plan_submit 拒绝再提交，
 * 改动只写在报告里。审查看不到计划变了、也就无法对照计划验收。
 *
 * 所以：active / reviewing 下允许修订，但**必须带 reason**，并把
 * fromPlanVersion / toPlanVersion / 变更摘要记进 amendments[]。
 */
export const planAmend = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  const AMENDABLE = [PHASES.ACTIVE, PHASES.REVIEWING];
  if (!AMENDABLE.includes(task.phase)) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `只有 active / reviewing 阶段能修订计划，当前是 ${task.phase}`,
      { phase: task.phase, allowed: AMENDABLE },
    );
  }

  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  assertOrThrow(reason.length > 0, ERR.INTERNAL, "修订计划必须给 reason（记录为什么改）");

  const criteria = includeObjectiveCriteria(task.requiredCriteria, Array.isArray(params.criteria) ? params.criteria : task.criteria);
  const stages = Array.isArray(params.stages) ? params.stages : task.stages;
  const criteriaChanged = !isDeepStrictEqual(task.criteria ?? [], criteria);
  const stagesChanged = !isDeepStrictEqual(task.stages ?? [], stages);
  const changedFields = [
    ...(criteriaChanged ? ["criteria"] : []),
    ...(stagesChanged ? ["stages"] : []),
  ];
  const noOp = changedFields.length === 0;

  const check = validatePlan({ criteria, stages });
  const resolvedOrderIssues = (task.reviewOrderIssues ?? []).filter(issue => issue.planVersion === task.planVersion);
  for (const issue of resolvedOrderIssues) {
    const criterion = criteria.find(c => c.id === issue.criterionId);
    if (!criterion || verificationPoint(criterion) === "stage")
      throw new MentorError(ERR.REVIEW_ORDER, reviewOrderMessage(issue), issue);
  }
  if (!check.ok) {
    return {
      ok: false,
      code: check.errors.find(e => e.code === ERR.REVIEW_ORDER)?.code ?? ERR.EMPTY_PLAN,
      message: check.errors.find(e => e.code === ERR.REVIEW_ORDER)?.message ?? "修订后的计划校验未通过",
      details: { taskId: task.id, errors: check.errors },
    };
  }

  const planVersion = (task.planVersion ?? 0) + 1;
  const resolvedReviewIds = new Set(resolvedOrderIssues.map(issue => issue.reviewId).filter(Boolean));
  const resolvedOrderCriteria = new Set(resolvedOrderIssues.map(issue => issue.criterionId).filter(Boolean));
  const amendedFindings = resolvedOrderIssues.length
    ? (task.findings ?? []).map(f => {
        if (f.status === "closed") return f;
        const matchesOrder = (f.reviewOrder?.planVersion === task.planVersion &&
          (!resolvedOrderCriteria.size || resolvedOrderCriteria.has(f.reviewOrder.criterionId))) ||
          (f.reviewId && resolvedReviewIds.has(f.reviewId));
        return matchesOrder
          ? forceCloseFinding(f, `计划修订已解决验收顺序冲突（planVersion ${planVersion}）`, "plan-amend")
          : f;
      })
    : task.findings;
  const amendments = [
    ...(task.amendments ?? []),
    {
      at: Date.now(),
      reason,
      fromPlanVersion: task.planVersion ?? 0,
      toPlanVersion: planVersion,
      changedFields,
      noOp,
      criteriaCount: criteria.length,
      stagesCount: stages.length,
      stageIds: stages.map((s) => s && s.id).filter(Boolean),
    },
  ];

  // c3：计划变了，基于旧计划上报、仍在等审查的节点必须失效重报。
  // 否则它们会拿着旧 criteria 下的 evidence 被审，或者永远卡在 reported。
  // 2026-11-04 修 P1-6：原来只重置 reported。accepted 的节点是按**旧 criteria**
  // 通过的，计划改了就失去正当性，必须一并重置，否则 amend 改验收标准等于没改。
  const {nodeRuns,resetStages,keptStages} = amendedRuns(task,stages,criteria,planVersion);
  amendments.at(-1).keptStages = keptStages;
  amendments.at(-1).resetStages = resetStages;

  const amendPatch = { criteria, stages, planVersion, amendments, nodeRuns,
    ...(resolvedOrderIssues.length ? { findings: amendedFindings } : {}), updatedAt: Date.now() };
  if (task.team) amendPatch.team = {...task.team, issue:null,directions:Object.fromEntries(
    Object.entries(task.team.directions??{}).filter(([id,entry])=>!entry.hypothesisId && stages.some(s=>s.id===id)))};

  // 若因此没有待审内容，phase 从 reviewing 回落 active，否则会永久停在 reviewing。
  // 2026-11-09：改成 setPhase —— 这条是 reviewing→active（合法边），
  // 但 phase 变更必须走单一写入口，store 会拒绝裸写。
  let next;
  if (resetStages.length > 0 && task.phase === PHASES.REVIEWING) {
    next = setPhase(store, PHASES.ACTIVE, amendPatch);
  } else {
    store.set({ ...task, ...amendPatch, revision: (task.revision ?? 0) + 1 });
    next = store.get();
  }

  // 2026-11-09：检查点审查开启时，修订后的计划必须重新过审，而计划审查只在 planning 下进行。
  // active/reviewing → planning 在转移表里没有直连，走合法的 active→paused→planning 两步退回归划。
  if (store.settings?.requireCheckpointReviews === true && next.phase !== PHASES.PLANNING) {
    setPhase(store, PHASES.PAUSED, {
      pauseReason: PAUSE_REASONS.DECISION,
      prePausePhase: next.phase,
      pausedAt: Date.now(),
    });
    next = setPhase(store, PHASES.PLANNING, { prePausePhase: null, pauseReason: null, pausedAt: null });
  }

  return ok({
    taskId: next.id,
    planVersion,
    phase: next.phase,
    amendments: amendments.length,
    changedFields,
    noOp,
    ...(noOp
      ? {
          warning:
            "本次计划修订未检测到 stages 或 criteria 的实质变化（若漏传 stages，原阶段计划保持不变）；如需修改阶段请显式传入 stages。",
        }
      : {}),
    resetStages, keptStages,
    validation: { ok: true, errors: [] },
    parallelism: computeParallelism(stages),
    split: suggestSplit(stages),
  });
});

/* ------------------------------------------------------------------ *
 * 4. 上报阶段
 * ------------------------------------------------------------------ */

export const stageReport = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  // 2026-11-04 修 P2-3：completed 原本不是真终态 —— 这三个工具都没查 phase，
  // 已完成的任务还能被重新上报改回 reported，历史被静默改写。
  if (task.phase === PHASES.COMPLETED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已完成，不能再上报阶段证据", { phase: task.phase });
  }

  // 证据自证引文：报「我做了 X」时引号里的那段必须在自己的证据里逐字存在
  const qv = verifyQuotes(params.quotes, params.evidence);
  if (!qv.ok) {
    return {
      ok: false,
      code: ERR.QUOTE_NOT_FOUND,
      message: `引文在 evidence 中未命中：${qv.missed.join(" / ")}`,
      details: { missed: qv.missed, checked: qv.checked },
    };
  }

  const reported = submitStageReport(task, {
    stageId: params.stageId,
    attempt: params.attempt,
    evidence: params.evidence,
    summary: params.summary,
    planVersion: params.planVersion,
    evidenceRefs: params.evidenceRefs,
    evidenceFiles: params.evidenceFiles,
    bindings: params.bindings,
    integrationEvidence: params.integrationEvidence,
    impactPreview: params.impactPreview,
    handoff: params.handoff,
  });
  // 提交证据后进入待审（SPEC §2.1 active → reviewing）
  //
  // 2026-11-09：两步写 —— 先落报告（phase 不变，store 放行），再走 setPhase 进 reviewing。
  // 不能直接 transition(reported) 后 store.set：那会让「改 phase」绕过单一写入口，
  // 而且 reported 基于 store 里的旧任务构造，直接用 setPhase 会丢掉本次报告。
  store.set(reported);
  const next = reported.phase === PHASES.ACTIVE ? setPhase(store, PHASES.REVIEWING) : store.get();

  const run = next.nodeRuns.find((r) => r.stageId === params.stageId);
  return ok({
    taskId: next.id,
    stageId: params.stageId,
    status: run?.status,
    attempt: run?.attempt,
    reportCount: run?.reports?.length ?? 0,
    // 2026-11-09（R-02）：这里不再断言「已排队」—— handler 根本不知道派发结果，
    // 常量 true 会在派发失败时与 reviewDispatch.queued=false 自相矛盾。
    // 真实值由 lib/index.js 在 spawnReviewer 返回后合并进 value。
    // SPEC §4 要求的 evidenceRefs 一并回传，方便审查方直接看到本报告的结构化证据。
    evidenceRefs: run?.reports?.at(-1)?.evidenceRefs ?? [],
  });
});

/* ------------------------------------------------------------------ *
 * 5. 请求完成
 * ------------------------------------------------------------------ */

/** 项目根（供证据路径「逃出项目根」判定用），由本文件位置反推 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `stageReport` 的可写态包装：保留「paused / off / archived / completed 一律拦住」
 * 这条既有语义。放在这里而不是 HANDLERS 表里，是因为 gated 入口要复用它。
 */
const writableStageReport = writable(stageReport);

/**
 * 带报告门槛的 stageReport —— **工具链路唯一入口**（SPEC §2.6）。
 *
 * 为什么要把门禁单独包一层而不是直接改 `stageReport`：`HANDLERS` 是同步 map，
 * 既有 33 处单测调用点直接用 `HANDLERS.mentor_stage_report(store, {...})` 构造
 * 「散文证据」场景。把门禁放进同一个函数会让这些用例全部变红，而它们测的是
 * 别的规则（attempt 失配、依赖未就绪等）。所以：
 *   · `stageReport`      = 原语义，内部使用，供既有单测
 *   · `stageReportGated` = 对外唯一实现，DSH 工具绑定的是它
 * 两者共用同一份 `submitStageReport`，不会出现两套写入逻辑。
 *
 * @param {object} store
 * @param {object} params 需含 evidenceRefs（结构化证据数组）与 planVersion
 * @param {{readFileSync?: Function, root?: string}} [deps] 注入点，便于单测
 */
export function stageReportGated(store, params, deps = {}) {
  return guard((s, p) => {
    const task = s.get();
    assertOrThrow(!!task, ERR.NO_TASK, "当前没有任务", { taskId: p.taskId ?? null });

    // 2026-11-09：可写判定必须排在门禁之前。
    // 以前 HANDLERS 上包了一层 writable()，暂停/关闭/归档会先拿到 TASK_PAUSED；
    // 现在 HANDLERS 直接绑本函数，若先跑门槛，暂停中的上报会被判成
    // E_UNRESPONDED_FINDINGS / E_STALE_PLAN，调用方拿不到「任务已暂停」这个真实原因。
    assertWritable(task);

    // 门槛二：旧账与计划版本（先判，因为它是硬前置）
    assertReportAllowed(task, { planVersion: p.planVersion, stageId: p.stageId });

    const conflict = reviewOrderConflict(task);
    if (conflict) throw new MentorError(ERR.REVIEW_ORDER, reviewOrderMessage(conflict), conflict);

    // 门槛一：结构化证据逐字命中
    const root = deps.root ?? task.workspaceRoot;
    assertOrThrow(typeof root === "string" && path.isAbsolute(root), ERR.WORKSPACE_REQUIRED, "该历史任务尚未绑定工作区，请通过 mentor_workspace_set 设置实际项目目录");
    const readSync = deps.readFileSync ?? ((abs, maxBytes) => readEvidenceText(root, abs, maxBytes));
    const observations = deps.allowRuntimeEvidence ? p.observations ?? [] : [];
    const stage = task.stages?.find(s => s.id === p.stageId);
    const run = task.nodeRuns?.find(r => r.stageId === p.stageId);
    const currentAttempt = run?.attempt ?? 1;
    let attempt = p.attempt;
    if (p.attemptRef !== undefined) {
      if (p.attemptRef !== stageAttemptRef(task, p.stageId, currentAttempt)) {
        throw new MentorError(ERR.STALE_ATTEMPT, "上报引用的阶段尝试已过期，请核对当轮成果再提交",
          { stageId: p.stageId, attemptRef: p.attemptRef, current: currentAttempt });
      }
      if (attempt !== undefined && attempt !== currentAttempt) {
        throw new MentorError(ERR.STALE_ATTEMPT, `stage ${p.stageId} 的 attempt 与 attemptRef 不一致`,
          { stageId: p.stageId, reportedAttempt: attempt, current: currentAttempt });
      }
      attempt = currentAttempt;
    } else if (attempt === undefined) {
      if (currentAttempt !== 1 || run?.batchId) {
        throw new MentorError(ERR.STALE_ATTEMPT, "请从本次派工、开始阶段或状态 reportBindings 中取 attemptRef",
          { stageId: p.stageId, current: currentAttempt });
      }
      attempt = 1;
    } else if (deps.requireAttemptRef === true && (currentAttempt !== 1 || run?.batchId)) {
      throw new MentorError(ERR.STALE_ATTEMPT, "重做与并行派工阶段须通过 attemptRef 绑定本轮，不能仅靠手填 attempt 提交",
        { stageId: p.stageId, current: currentAttempt });
    }
    const reportParams = { ...p, attempt };
    const recheck = run?.recheck?.attempt === attempt ? run.recheck : null;
    if (recheck?.retainedCriterionIds.length) {
      const retained = run.reports.at(-1)?.bindings?.filter(b=>recheck.retainedCriterionIds.includes(b.criterionId));
      const changed = changedBindings(retained,root,readSync);
      if (changed.length) {
        const expanded = {...recheck,criterionIds:[...new Set([...recheck.criterionIds,...changed])],
          retainedCriterionIds:recheck.retainedCriterionIds.filter(id=>!changed.includes(id))};
        s.set({...task,nodeRuns:task.nodeRuns.map(r=>r===run?{...r,recheck:expanded}:r),revision:task.revision+1,updatedAt:Date.now()});
        throw new MentorError(ERR.EVIDENCE_MISMATCH,"新的文件变化扩大了复核范围，请按更新后的验收项上报",{recheck:expanded});
      }
    }
    const required = recheck?.criterionIds ?? stage?.criterionIds ?? [];
    const runtimeOnly = required.length > 0 && required.every(id => task.criteria.some(c => c.id === id && c.observe));
    let handoff;
    if (stage?.receiptInputs?.length) {
      const worker = task.workers?.find(w => w.sessionId === run?.workerSessionId && w.stageId === p.stageId &&
        w.attempt === attempt && w.planVersion === task.planVersion && w.status === "completed");
      const expected = handoffInputs(task,stage);
      if (!expected.every(input => worker?.consumedInputs?.some(i => i.reportId === input.reportId &&
          i.criterionId === input.criterionId && i.receiptId === input.receiptId)))
        throw new MentorError(ERR.EVIDENCE_REQUIRED,"缺少接收助手本轮对已验收上游回执的确认");
      handoff = {sessionId:worker.sessionId,inputs:worker.consumedInputs};
    }
    const checked = (observations.length || runtimeOnly || (handoff && !stage.writePaths?.length)) && !p.evidenceRefs?.length
      ? { evidence: [], evidenceFiles: [] }
      : assertEvidenceSync(p.evidenceRefs, readSync, { root, fingerprint: true });

    const prior = task.nodeRuns?.find(run => run.stageId === p.stageId)?.reports?.at(-1);
    const eligible = prior?.planVersion === task.planVersion && prior.attempt < attempt &&
      (!task.workspaceChangedAt || prior.at >= task.workspaceChangedAt);
    const coverage = carryReportFiles(eligible ? prior : null, checked.evidenceFiles, root, readSync);
    const evidence = observations.length ? p.evidence + "\n运行观察：" + JSON.stringify(observations) : p.evidence;
    const bindings = collectBindings(task,reportParams,checked,readSync,root,deps.mainReceipts);
    const outgoing = (task.stages ?? []).flatMap(s => s.receiptInputs ?? []).filter(input => input.stageId === p.stageId);
    for (const input of outgoing) {
      const receipt = bindings.find(b => b.criterionId === input.criterionId && b.receipt)?.receipt;
      if (!receipt || !isWorkerReceipt(task,p.stageId,receipt,task.planVersion))
        throw new MentorError(ERR.EVIDENCE_REQUIRED,"下游需要本阶段助手的原始回执，请用助手执行此观察",input);
    }

    const changes = evidenceImpact(task, undefined, {read:readSync, fingerprint:true, acceptedOnly:true});
    const impactPreview = changes.length ? {changes, ...recheckScope(task,changes)} : null;
    const result = writableStageReport(s, { ...reportParams, evidence, bindings, impactPreview, handoff, evidenceRefs: checked.evidence, evidenceFiles: coverage.files });
    if (result.ok) {
      result.value.reportId = s.get().nodeRuns.find(run => run.stageId === p.stageId).reports.at(-1).id;
      if (impactPreview) result.value.impactPreview = impactPreview;
      result.value.evidenceCoverage = { files: coverage.files.map(f => f.file),
        inherited: coverage.inherited, skipped: coverage.skipped };
    }
    return result;
  })(store, params);
}

export const completionRequest = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  const readiness = checkCompletionReadiness(task);
  if (!readiness.ok) {
    return {
      ok: false,
      code: readiness.unmet.some((u) => u.code === ERR.BLOCKING_FINDING_OPEN)
        ? ERR.BLOCKING_FINDING_OPEN
        : ERR.ILLEGAL_TRANSITION,
      message: "完成请求的前置条件未满足",
      details: { taskId: task.id, unmet: readiness.unmet },
    };
  }

  const next = setPhase(store, PHASES.COMPLETED, {
    completedAt: Date.now(),
    completionEvidence:
      typeof params.evidence === "string" ? params.evidence.trim() : "",
  });

  return ok({ taskId: next.id, phase: next.phase, revision: next.revision });
});

/* ------------------------------------------------------------------ *
 * 6. 响应整改
 * ------------------------------------------------------------------ */

export const findingRespond = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase === PHASES.COMPLETED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已完成，不能再响应整改项", { phase: task.phase });
  }
  const finding = findingById(task, params.findingId);

  // 改造 s4（G7）：响应里附的证据必须真实存在（阶段报告 / 审查 / 整改项的 id）。
  // 不校验的话，「我修好了，证据是 e-1」这种自由字符串可以凭空捏造，
  // 整条整改确认链就等于没有依据。
  assertEvidenceRefs(task, params.evidenceIds);

  const responded = submitFindingResponse(finding, {
    summary: params.summary,
    evidenceIds: params.evidenceIds,
  });

  const next = {
    ...task,
    findings: task.findings.map((f) => (f.id === responded.id ? responded : f)),
    revision: task.revision + 1,
    updatedAt: Date.now(),
  };
  store.set(next);

  return ok({
    taskId: next.id,
    findingId: responded.id,
    // 关键：响应不等于关闭
    findingStatus: responded.status,
    responseCount: responded.responses.length,
    awaitingRecheck: true,
  });
});

/* ------------------------------------------------------------------ *
 * 6b. 强制关闭整改项（2026-11-04 修 P1-3：用户侧出口）
 *     审查复核关闭要求 verdict=pass 且 reviewer 主动写 markedResolved，
 *     实测三轮全为空数组 → 任务被 E_BLOCKING_FINDING_OPEN 永久挡住。
 * ------------------------------------------------------------------ */

export const findingClose = guard((store, params) => {
  const task = requireTask(store, params.taskId);
  const finding = findingById(task, params.findingId);
  const alreadyClosed = finding.status === "closed";

  if (alreadyClosed) {
    // 幂等：已关闭时直接回报，不推进 revision
    return ok({
      taskId: task.id,
      findingId: finding.id,
      findingStatus: finding.status,
      alreadyClosed: true,
      unresolved: unresolvedSummary(task),
    });
  }

  assertOrThrow(typeof params.reason === "string" && params.reason.trim().length > 0,
    ERR.FINDING_CLOSE_REASON, "人工关闭必须填写理由");
  const closed = forceCloseFinding(finding, params.reason.trim(), "user");
  const next = {
    ...task,
    findings: task.findings.map((f) => (f.id === closed.id ? closed : f)),
    revision: task.revision + 1,
    updatedAt: Date.now(),
  };
  store.set(next);

  return ok({
    taskId: next.id,
    findingId: closed.id,
    findingStatus: closed.status,
    alreadyClosed: false,
    closeReason: closed.closeReason,
    unresolved: unresolvedSummary(next),
  });
});

/* ------------------------------------------------------------------ *
 * 7. 应用审查裁决
 *    SPEC §4 初版漏列，但审查是闭环必需环节，已在 SPEC 中补入
 * ------------------------------------------------------------------ */

export const reviewApply = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase === PHASES.COMPLETED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已完成，不能再应用审查裁决", { phase: task.phase });
  }

  // 2026-11-04 修 P0-2：审查闸门原来完全不校验归属 —— 一个幽灵 stageId 加
  // markedResolved 就能把 finding 关掉、把一条 pass 塞进 reviews，让 completion
  // 前置检查全绿。下面三道校验任一不符都显式拒绝，不再静默成功。
  const stages = Array.isArray(task.stages) ? task.stages : [];
  if (!stages.some((s) => s && s.id === params.stageId)) {
    throw new MentorError(
      ERR.REVIEW_SCOPE,
      `被审阶段不存在于计划中：${params.stageId}`,
      { stageId: params.stageId, known: stages.map((s) => s && s.id) },
    );
  }

  // 被审原文：优先用显式传入的 evidenceText，否则取该阶段最近一次上报的 evidence。
  // 这一步是「真实审查路径也能校验引文」的关键 —— 审查方不需要额外查库，
  // 服务端自己把被审原文接上来。
  const run = (task.nodeRuns ?? []).find((r) => r.stageId === params.stageId);
  if (!run) {
    throw new MentorError(
      ERR.REVIEW_SCOPE,
      `阶段 ${params.stageId} 从未上报过，无法被审查`,
      { stageId: params.stageId },
    );
  }
  if (run.attempt !== params.attempt) {
    throw new MentorError(
      ERR.REVIEW_SCOPE,
      `attempt 失配：被审的是 ${params.attempt}，该阶段当前是 ${run.attempt}`,
      { stageId: params.stageId, reviewed: params.attempt, current: run.attempt },
    );
  }

  // markedResolved 只能关闭**本阶段**的 finding（历史无归属的走 finding_close）
  //
  // 2026-11-09 修 c3：先经 findingById 把「审查方写的编号」归一成真实 id，再判归属。
  // 真机上 finding 可能以派生 id（f_xxx_n）存储、而审查文本里写的是 G1；
  // 不归一的话 passing 时写 markedResolved:["G1"] 会被误判越界（E_REVIEW_SCOPE）。
  // 歧义（同一编号命中多条）抛 E_FINDING_UNKNOWN 并带 candidates，不瞎猜。
  let resolvedIds = [];
  if (Array.isArray(params.markedResolved) && params.markedResolved.length > 0) {
    resolvedIds = params.markedResolved.map((id) => findingById(task, id).id);
    const offending = resolvedIds.filter((id) => {
      const f = (task.findings ?? []).find((x) => x && x.id === id);
      return !f || (f.stageId ?? null) !== params.stageId;
    });
    if (offending.length > 0) {
      throw new MentorError(
        ERR.REVIEW_SCOPE,
        `markedResolved 只能引用本阶段(${params.stageId})的整改项；越界或不存在：${offending.join(", ")}`,
        { stageId: params.stageId, offending },
      );
    }
  }

  const lastReport = Array.isArray(run?.reports) ? run.reports.at(-1) : null;
  const evidenceText =
    typeof params.evidenceText === "string" && params.evidenceText.length > 0
      ? params.evidenceText
      : (lastReport?.evidence ?? "");

  // 改造 s4（G1）：配置要求 pass 必须附检查清单时，空 checks 直接拒。
  // 旧实现是「没立清单就先打开产物」的硬错误；mentor 没有审查会话内状态，
  // 所以把这条约束落到裁决入参上，可由 requireChecksForPass 开关逐步启用。
  const checks = Array.isArray(params.checks) ? params.checks : [];
  if (store.settings?.requireChecksForPass === true && params.verdict === VERDICT.PASS && checks.length === 0) {
    throw new MentorError(
      ERR.CHECKS_REQUIRED,
      "配置要求 pass 必须附检查清单（checks：每条给 source + criterion），本次为空",
      { stageId: params.stageId, verdict: params.verdict, requireChecksForPass: true },
    );
  }

  const reviewPlanVersion = Number.isInteger(params.planVersion) && params.planVersion >= 1
    ? params.planVersion
    : (Number.isInteger(task.planVersion) && task.planVersion >= 1 ? task.planVersion : undefined);
  const review = createReview({
    stageId: params.stageId,
    attempt: params.attempt,
    planVersion: reviewPlanVersion,
    verdict: params.verdict,
    checks,
    ...prepareReviewFindings(task, {
      stageId: params.stageId, verdict: params.verdict, existingFindingIds: params.existingFindingIds,
      findings: (params.findings ?? []).map((f) => {
      if (typeof f === "string") return f;
      // 结构化 finding 带 quotes 时逐字比对被审原文；不带则保持旧行为
      if (Array.isArray(f.quotes) && f.quotes.length > 0) {
        return createFinding({
          severity: f.severity,
          text: f.text,
          id: f.id,
          quotes: f.quotes,
          evidenceText,
        });
      }
      return createFinding({ severity: f.severity, text: f.text, id: f.id });
      }),
    }),
  });
  if (resolvedIds.length > 0) {
    review.markedResolved = [...resolvedIds];
  }

  const next = applyReview(task, review);
  store.set(next);

  // revise 回 active 以便继续推进；pass 留在 reviewing（此时才允许请求完成）
  // 2026-11-09：reviewing→active 是合法边，但仍需走 setPhase 单一写入口。
  let settled = next;
  if (review.verdict === VERDICT.REVISE && next.phase === PHASES.REVIEWING) {
    settled = setPhase(store, PHASES.ACTIVE);
  }

  return ok({
    taskId: settled.id,
    reviewId: review.id,
    closedFindingIds: settled.closedFindingIds ?? [],
    verdict: review.verdict,
    phase: settled.phase,
    unresolved: unresolvedSummary(settled),
  });
});

/* ------------------------------------------------------------------ *
 * 8. 主动返工节点（对齐 supervisor 的 task_rework_node 能力）
 * ------------------------------------------------------------------ */

/**
 * 主动返工一个已接受的阶段。
 *
 * 与「审查判 revise」的区别：revise 是被动产生（裁决结果，且现在同样会做传递失效），
 * 本工具是主动发起，用于「上游阶段本身没被质疑、但我判断它需要重做」的场景。
 *
 * 语义：
 *   - 只接受当前 status === "accepted" 的节点（其余状态返工无意义）
 *   - 该节点置 rework 且 attempt + 1（与 revise 后必须 attempt+1 的规则一致）
 *   - 传递依赖它的、当前已 accepted 的后继节点一并置 rework（防止拿旧结果继续推进）
 *   - 返回值带新的 readyNodes，便于调用方立刻知道下一步能做什么
 */
export const reworkStage = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase === PHASES.COMPLETED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已完成，不能返工节点", {
      phase: task.phase,
    });
  }

  const stageId = params.stageId;
  if (typeof stageId !== "string" || stageId.length === 0) {
    throw new MentorError(ERR.STAGE_UNKNOWN, "必须提供非空 stageId", {
      stageId: stageId ?? null,
    });
  }

  const stage = (task.stages ?? []).find((s) => s.id === stageId);
  if (!stage) {
    throw new MentorError(ERR.STAGE_UNKNOWN, `计划里没有阶段 ${stageId}`, {
      stageId,
      knownStageIds: (task.stages ?? []).map((s) => s.id),
    });
  }

  const run = (task.nodeRuns ?? []).find((r) => r.stageId === stageId);
  if (!run) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `阶段 ${stageId} 从未上报过，无需返工`,
      { stageId, stageStatus: null },
    );
  }
  if (run.status !== "accepted") {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `阶段 ${stageId} 当前状态是 ${run.status}，只有 accepted 的节点才需要主动返工`,
      { stageId, stageStatus: run.status },
    );
  }

  const dependents = collectDependents(task.stages, stageId);
  const invalidated = [];

  const nodeRuns = (task.nodeRuns ?? []).map((r) => {
    if (r.stageId === stageId) {
      return {
        ...r,
        status: "rework",
        attempt: r.attempt + 1,
        ...(r.batchId != null ? { batchId: null } : {}),
        ...(r.workerSessionId != null ? { workerSessionId: null } : {}),
      };
    }
    // 2026-11-04 修 P1-5：与 applyReview 保持一致，reported 的后继同样失效
    if (
      dependents.has(r.stageId) &&
      (r.status === "accepted" || r.status === "reported")
    ) {
      invalidated.push(r.stageId);
      return {
        ...r,
        status: "rework",
        attempt: r.attempt + 1,
        ...(r.batchId != null ? { batchId: null } : {}),
        ...(r.workerSessionId != null ? { workerSessionId: null } : {}),
      };
    }
    return r;
  });

  const next = {
    ...task,
    nodeRuns,
    revision: (task.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  store.set(next);

  return ok({
    taskId: next.id,
    stageId,
    status: "rework",
    attempt: run.attempt + 1,
    invalidated,
    readyNodes: readyNodes(next.stages, next.nodeRuns),
  });
});

/* ------------------------------------------------------------------ *
 * 10. 控制接口（2026-11-04 新增，对齐旧 supervisor 的 task-approve / clear /
 *     pause / resume / off / on）
 *
 * 旧 supervisor 那 7 个 `task-*` 是 slash 命令（source/lib/index.mjs:7040-7059），
 * 只转调 `/task <action>`；真正的状态改写在 `/task` handler 里（7152-7228）。
 * mentor 没有命令通道，所以这六个能力直接落成工具。
 *
 * 与旧版的差异（写在这里而不是藏起来）：
 *   · 旧版 approve 强制绑定 `user_message_seq`（一条真实的用户批准消息），
 *     mentor 的任务不在 session 事件流里，没有这个概念，所以只校验 planVersion；
 *   · 旧版 pause 会顺带 `withdrawOwned()` 撤回自动执行许可，mentor 没有
 *     armed 机制，等价物是 assertWritable() 在写入口直接把门关掉。
 * ------------------------------------------------------------------ */

/**
 * 批准当前计划。对应旧 supervisor 的 `task_approve`。
 *
 * 只在 awaiting-approval 下可用 —— 别的阶段说明计划要么还没提交、要么已经在跑，
 * 两种情况下「批准」都没有意义，必须明确报错而不是静默改状态。
 */
export const taskApprove = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  // 2026-11-04 修（s2 审查）：导师被关掉时不许批准。
  // 否则 off 只挡了 writable 包住的写操作，approve 不包 writable，
  // 会绕过「关闭导师」直接转 active —— c4 的「off 后不干预」当场失效。
  if (task.enabled === false) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "导师已关闭，先调用 mentor_task_on", {
      reason: BLOCK.DISABLED,
      allowed: ["mentor_task_on"],
    });
  }

  // 陈旧计划校验：调用方给了 planVersion 就必须对得上（对齐旧版
  // "approval refers to a stale task or plan"）
  //
  // 2026-11-04 修（改造 s2）：这条必须排在幂等返回**之前**。
  // 原先顺序是「已 active 且版本相同 → 直接返回 duplicate」，于是
  // `approve 99`（明显陈旧的版本）也会被当成成功——幂等分支吞掉了陈旧性判断。
  if (params.planVersion !== undefined && params.planVersion !== task.planVersion) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "批准指向的是旧版本计划", {
      expected: task.planVersion,
      got: params.planVersion,
    });
  }

  if (task.phase === PHASES.ACTIVE && task.approvedPlanVersion === task.planVersion) {
    // 幂等：同一版计划重复批准
    return ok({
      taskId: task.id,
      phase: task.phase,
      approvedPlanVersion: task.approvedPlanVersion,
      duplicate: true,
    });
  }

  if (task.phase !== PHASES.AWAITING_APPROVAL) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `只有 awaiting-approval 阶段能批准计划，当前是 ${task.phase}`,
      { phase: task.phase, allowed: allowedTransitions(task) },
    );
  }

  if (!task.planVersion || task.planVersion < 1) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "当前没有可批准的计划（planVersion 为空）", {
      phase: task.phase,
      planVersion: task.planVersion ?? 0,
    });
  }

  const next = setPhase(store, PHASES.ACTIVE, {
    approvedPlanVersion: task.planVersion,
    approvedAt: Date.now(),
    autoApproved: false,
  });

  return ok({
    taskId: next.id,
    phase: next.phase,
    approvedPlanVersion: next.approvedPlanVersion,
  });
});

/** 暂停。记下 prePausePhase，resume 时精确回到这个状态而不是二选一猜。 */
export const taskPause = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase === PHASES.PAUSED) {
    return ok({
      taskId: task.id,
      phase: task.phase,
      prePausePhase: task.prePausePhase ?? null,
      duplicate: true,
    });
  }

  if (task.phase === PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "已归档的任务不能暂停", {
      phase: task.phase,
    });
  }

  // 暂停原因必须是枚举值（对齐旧 supervisor 的 pauseReason 8 值）。
  // 自由字符串会把「为什么停」变成无法判断的信息 —— 恢复策略要依赖它。
  const reason = params.reason === undefined ? PAUSE_REASONS.USER : String(params.reason);
  if (!isPauseReason(reason)) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, `未知暂停原因：${reason}`, {
      reason,
      allowed: pauseReasonList(),
    });
  }

  const pausedAt = Date.now();
  const next = setPhase(store, PHASES.PAUSED, {
    prePausePhase: task.phase,
    pauseReason: reason,
    pausedAt,
    reviewJobs: (task.reviewJobs ?? []).map(job =>
      ["queued", "running"].includes(job.status)
        ? { ...job, status: "failed", error: "task-paused", interruptedByPauseAt: pausedAt, updatedAt: pausedAt }
        : job),
  });

  return ok({
    taskId: next.id,
    phase: next.phase,
    prePausePhase: next.prePausePhase,
    pauseReason: next.pauseReason,
  });
});

/** 恢复。回到暂停前的状态；老数据没有 prePausePhase 时按批准情况兜底。 */
export const taskResume = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase !== PHASES.PAUSED) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `只有 paused 阶段能恢复，当前是 ${task.phase}`,
      { phase: task.phase },
    );
  }

  if (task.enabled === false) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "导师已关闭，先调用 mentor_task_on", {
      reason: BLOCK.DISABLED,
      allowed: ["mentor_task_on"],
    });
  }

  // 优先用记录的 prePausePhase；老数据（本次升级前暂停的）按需兜底
  let target = task.prePausePhase;
  if (!target || target === PHASES.PAUSED) {
    target = task.approvedPlanVersion ? PHASES.ACTIVE : PHASES.AWAITING_APPROVAL;
  }
  if (target === PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "暂停前的状态是已归档，无法恢复", {
      prePausePhase: task.prePausePhase,
    });
  }

  const pausedReason = task.pauseReason ?? null;
  const fromBreaker = task.continuation?.kind === "rework-circuit-breaker" ? task.continuation : null;
  const resetReviewCount = Array.isArray(task.reviews) ? task.reviews.length : 0;
  const resumePatch = {
    prePausePhase: null,
    pauseReason: null,
    pausedAt: null,
    ...(fromBreaker ? {
      continuation: null,
      nodeRuns: (task.nodeRuns ?? []).map((r) =>
        r && r.stageId === fromBreaker.stageId ? { ...r, breakerResetReviewCount: resetReviewCount } : r),
    } : {}),
  };
  const next = setPhase(store, target, resumePatch);

  return ok({
    taskId: next.id,
    phase: next.phase,
    resumedFrom: pausedReason,
    ...(fromBreaker ? { breakerResetStageId: fromBreaker.stageId } : {}),
    hint:
      fromBreaker
        ? `已重置阶段 ${fromBreaker.stageId} 的返工熔断计数，可继续推进`
        : pausedReason === PAUSE_REASONS.REVIEW_FAULT
          ? "暂停前已失败的审查可用 mentor_review_retry 重试"
          : null,
  });
});

/**
 * 归档（Clear）。对应旧 supervisor 的 `task-clear`。
 *
 * 关键：**completed 也能归档**。旧版的 clear 分支对已完成任务没有拦截
 * （source/lib/index.mjs:7152-7179 只挡了 pause），所以「做完的任务点 Clear」
 * 必须有效，否则「随时能 Clear」是假的。只有 archived 本身是幂等返回。
 */
export const taskClear = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.phase === PHASES.ARCHIVED) {
    return ok({
      taskId: task.id,
      phase: task.phase,
      archivedAt: task.archivedAt ?? null,
      duplicate: true,
    });
  }

  const now = Date.now();
  const next = setPhase(store, PHASES.ARCHIVED, {
    archivedAt: now,
    archivedUndoUntil: now + 10_000,
    preArchivePhase: task.phase,
    preArchivePauseReason: task.pauseReason ?? null,
    preArchivePrePausePhase: task.prePausePhase ?? null,
    archivedReason: params.reason === undefined ? "user-clear" : String(params.reason),
    pauseReason: null,
    prePausePhase: null,
  });

  return ok({
    taskId: next.id,
    phase: next.phase,
    revision: next.revision,
    archivedAt: next.archivedAt,
    archivedUndoUntil: next.archivedUndoUntil,
    preArchivePhase: next.preArchivePhase,
  });
});

/**
 * 人工撤销归档（不放进 HANDLERS / TOOL_NAMES，仅由人工面板或 /mentor restore 调用）。
 * 支持 10 秒持久化撤销窗口校验（enforceUndoWindow=true 时）或人工显式 /mentor restore 随时恢复。
 */
export const taskRestore = guard((store, params = {}) => {
  const task = requireTask(store, params.taskId);
  if (task.phase !== PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, `只有已归档任务才能恢复，当前是 ${task.phase}`, {
      phase: task.phase,
    });
  }
  if (params.enforceUndoWindow === true && Number.isFinite(task.archivedUndoUntil) && Date.now() > task.archivedUndoUntil) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "10 秒快捷撤销窗口已过，请使用 /mentor restore 显式恢复", {
      archivedUndoUntil: task.archivedUndoUntil,
    });
  }
  let target = task.preArchivePhase;
  if (!target || target === PHASES.ARCHIVED) {
    target = task.approvedPlanVersion ? PHASES.ACTIVE : PHASES.PLANNING;
  }
  const restorePausePatch = target === PHASES.PAUSED
    ? {
        pauseReason: task.preArchivePauseReason ?? PAUSE_REASONS.USER,
        prePausePhase: task.preArchivePrePausePhase ?? (task.approvedPlanVersion ? PHASES.ACTIVE : PHASES.PLANNING),
      }
    : {};
  const next = restorePhase(store, target, {
    ...restorePausePatch,
    archivedAt: null,
    archivedUndoUntil: null,
    archivedReason: null,
    preArchivePhase: null,
    preArchivePauseReason: null,
    preArchivePrePausePhase: null,
    restoredAt: Date.now(),
    restoredBy: "user",
  });
  return ok({
    taskId: next.id,
    phase: next.phase,
    revision: next.revision,
    restoredAt: next.restoredAt,
  });
});

/** 关闭导师。只动 enabled，phase 原样保留 —— 记录不许丢。 */
export const taskOff = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.enabled === false) {
    return ok({ taskId: task.id, enabled: false, phase: task.phase, duplicate: true });
  }

  const next = { ...task, enabled: false, revision: task.revision + 1, updatedAt: Date.now() };
  store.set(next);
  return ok({ taskId: next.id, enabled: false, phase: next.phase });
});

/** 重新启用。**不自动 resume**（与旧版一致：on 只开开关，继续要显式 resume）。 */
export const taskOn = guard((store, params) => {
  const task = requireTask(store, params.taskId);

  if (task.enabled !== false) {
    return ok({ taskId: task.id, enabled: true, phase: task.phase, duplicate: true });
  }

  const next = { ...task, enabled: true, revision: task.revision + 1, updatedAt: Date.now() };
  store.set(next);
  return ok({
    taskId: next.id,
    enabled: true,
    phase: next.phase,
    hint: next.phase === PHASES.PAUSED ? "任务仍处于暂停，用 mentor_task_resume 继续" : null,
  });
});

/* ------------------------------------------------------------------ *
 * 10b. 人工放行独立审查（2026-11-07）
 *
 * 触发场景：独立审查确实失败（reviewJobs[].status === "failed"），重试也
 * 起不来（宿主缺模型 / agents），任务停在 reviewing 无法推进。
 *
 * 为什么必须由人放行：这条通道的直接效果是「主会话可以给自己判 pass」。
 * 模型若能自己开这个口子，导师模式的独立性当场归零 —— 2026-11-07 的第一
 * 版兜底就犯了这个错（job failed 就放行，没有人工条件，被审出后收紧）。
 * 因此：
 *   · 写入只能来自人工通道（lib/index.js 里 !human 直接拒）
 *   · 必须给理由，理由同时进 waiver 与后续 review 记录
 *   · 只对当前 planVersion 里、状态为 failed 的那一个 job 生效
 * ------------------------------------------------------------------ */

export const reviewWaive = guard((store, params) => {
  const task = requireTask(store, params.taskId);
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  assertOrThrow(reason.length > 0, ERR.INTERNAL, "放行独立审查必须给理由（会记进 waivers 与 review）");

  const failed = (task.reviewJobs ?? []).filter(job => isRetryableReview(task, job));
  assertOrThrow(
    failed.length > 0,
    ERR.INTERNAL,
    "没有当前计划版本的失败审查；先 mentor_review_retry 确认确实起不来，才谈放行",
  );

  const target = params.reviewJobId
    ? failed.find((job) => job.id === params.reviewJobId)
    : failed.at(-1);
  assertOrThrow(!!target, ERR.INTERNAL, "指定的 reviewJobId 不是当前版本可放行的失败审查");

  const waiver = {
    id: `wv_${Date.now().toString(36)}_${(task.reviewWaivers ?? []).length + 1}`,
    reviewJobId: target.id,
    kind: target.kind,
    stageId: target.stageId,
    attempt: target.attempt,
    planVersion: target.planVersion,
    reason,
    by: typeof params.by === "string" && params.by ? params.by : "human",
    at: Date.now(),
  };
  const next = {
    ...task,
    reviewWaivers: [
      ...(task.reviewWaivers ?? []).filter((w) => w.reviewJobId !== target.reviewJobId && w.reviewJobId !== target.id),
      waiver,
    ],
    revision: task.revision + 1,
    updatedAt: Date.now(),
  };
  store.set(next);
  return ok({
    taskId: next.id,
    waiver,
    hint: "主会话现在可以对这条 job 提交裁决；结果会标记 selfReviewed=true 并带上本理由",
  });
});

/* ------------------------------------------------------------------ *
 * 11. 节点开始记录（改造 s2-b，对齐旧 supervisor 的 task_start_node）
 *
 * 旧版语义：「可选地记录主轴开始某个就绪节点，用于展示进度；上报时不要求先 start」。
 * 这里保持同一条边界 —— 它只写 startedAt / startedAttempt 两个展示字段，
 * **不改变验收语义**：没 start 也能直接 mentor_stage_report。
 *
 * 仍然过 assertWritable：暂停 / 关闭导师时不该继续"开始"新节点。
 * ------------------------------------------------------------------ */

export const nodeStart = guard((store, params) => {
  const task = requireTask(store, params.taskId);
  assertWritable(task);

  const stageId = typeof params.stageId === "string" ? params.stageId.trim() : "";
  const stage = (task.stages ?? []).find((s) => s && s.id === stageId);
  if (!stage) {
    throw new MentorError(ERR.STAGE_UNKNOWN, `计划里没有 stage：${stageId || "(空)"}`, {
      stageId,
      knownStages: (task.stages ?? []).map((s) => s.id),
    });
  }

  const runs = task.nodeRuns ?? [];
  const run = runs.find((r) => r && r.stageId === stageId);

  if (run && (run.status === "reported" || run.status === "accepted")) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      `阶段 ${stageId} 当前是 ${run.status}，「开始」在已上报/已接受之后没有意义`,
      { stageId, status: run.status },
    );
  }

  const ready = readyNodes(task.stages ?? [], runs);
  if (!ready.includes(stageId) && !(run?.status === "running" && !run.batchId)) {
    throw new MentorError(
      ERR.DEP_NOT_READY,
      `阶段 ${stageId} 当前不是就绪节点（前置阶段未全部 accepted）`,
      { stageId, readyNodes: ready },
    );
  }

  const attempt = params.attempt === undefined ? (run ? run.attempt : 1) : params.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new MentorError(ERR.INTERNAL, `attempt 必须是 >=1 的整数，收到 ${String(params.attempt)}`, {
      stageId,
      attempt: params.attempt,
    });
  }
  if (run && attempt !== run.attempt) {
    throw new MentorError(
      ERR.STALE_ATTEMPT,
      `attempt 不匹配：当前是 ${run.attempt}，收到 ${attempt}`,
      { stageId, currentAttempt: run.attempt, received: attempt },
    );
  }

  // 同一 attempt 重复「开始」幂等：只回显，不改时间戳（否则每次调用都刷新，等于没有开始时刻）
  if (run && run.startedAttempt === attempt && run.startedAt) {
    return ok({
      taskId: task.id,
      stageId,
      attempt,
      attemptRef: stageAttemptRef(task,stageId,attempt),
      startedAt: run.startedAt,
      duplicate: true,
      readyNodes: ready,
    });
  }

  const startedAt = Date.now();
  // 2026-11-08 修：「开始」只记进度，不动验收路径 —— 原来这里把 status 置成 "running"，
  // 与 test/node-start.test.mjs 文件头「它只记进度，不改变验收路径」以及本模块的语义承诺相反，
  // 也让「没 start 也能直接上报」这条边界失效（上报门禁会看到 running）。
  // 真正把节点置 running 的是并行派发（delegateNodes），不是这里。
  const nodeRuns = run
    ? runs.map((r) => (r.stageId === stageId
      ? {
          ...r,
          startedAt,
          startedAttempt: attempt,
          ...(r.batchId != null ? { batchId: null } : {}),
          ...(r.workerSessionId != null ? { workerSessionId: null } : {}),
        }
      : r))
    : [...runs, { stageId, attempt, status: "pending", reports: [], startedAt, startedAttempt: attempt }];

  const next = {
    ...task,
    nodeRuns,
    revision: (task.revision ?? 0) + 1,
    updatedAt: startedAt,
  };
  store.set(next);

  return ok({ taskId: next.id, stageId, attempt, attemptRef:stageAttemptRef(task,stageId,attempt), startedAt, readyNodes: ready });
});

/**
 * 写操作包装器：在 handler 之前先过 assertWritable。
 *
 * 为什么放这一层而不是逐个 handler 里加：
 *   · 15 处 requireTask 里有只读的（task_status）、有要能在 paused 下跑的
 *     （resume）、有要能在 off 下跑的（on），逐处加很容易漏或加错；
 *   · 统一挂在 HANDLERS 映射上，看一眼表就知道哪些是写操作、哪些放行。
 *
 * 放行规则（不包 writable 的）：
 *   · mentor_task_status        —— 只读，关了导师也要能查
 *   · mentor_task_create        —— 新建任务不应被旧任务的 paused/off 拦住
 *   · mentor_task_on / off      —— 开关本身必须在 off 状态下可调
 *   · mentor_task_resume        —— 必须在 paused 状态下可调
 *   · mentor_task_clear         —— 任何状态都能归档（含 completed/off）
 *   · mentor_task_approve       —— 自带 awaiting-approval 判断，不重复拦
 *   · mentor_task_pause         —— 暂停本身要在运行中调用
 */
function writable(fn) {
  return (store, params) => {
    try {
      const task = store.get();
      // 没任务时不在这里报错：交给 handler 统一的 NO_TASK 文案
      if (task) assertWritable(task);
      return fn(store, params ?? {});
    } catch (err) {
      return toFailure(err);
    }
  };
}
/* ------------------------------------------------------------------ *
 * 4.5 并行委派（规则见 verification/parallel-and-live-review-design.md）
 * ------------------------------------------------------------------ */

/** 把 s1 模块的错误码映射到 ERR，避免两套码表 */
function mapParallelError(err) {
  const map = {
    [PARALLEL_CODE.LIMIT]: ERR.PARALLEL_LIMIT,
    [PARALLEL_CODE.BATCH]: ERR.DELEGATION_INVALID,
    [PARALLEL_CODE.CONFLICT]: ERR.WRITE_CONFLICT,
  };
  const code = map[err?.code];
  return code ? { ok: false, code, message: err.message, details: err.details ?? {} } : null;
}

/**
 * 派发一批并行节点：校验 → 置 running → 返回 dispatchPlan。
 * 真正起子 Agent 在 lib/index.js（要 ctx.agents）；本层只做判定与状态迁移。
 */
export const delegateNodes = guard((store, params) => {
  const task = requireTask(store, params.taskId);
  assertWritable(task);
  if (![PHASES.ACTIVE, PHASES.REVIEWING].includes(task.phase) || task.pendingCheckpoint) throw new MentorError(ERR.ILLEGAL_TRANSITION, "计划尚未批准或整体检查点未结束，不能派工");
  const conflict = reviewOrderConflict(task);
  if (conflict) throw new MentorError(ERR.REVIEW_ORDER, reviewOrderMessage(conflict), conflict);
  const configured = store.settings?.maxParallelNodes ?? DEFAULT_MAX_PARALLEL;
  const maximum = params.maxParallel ?? configured;
  assertOrThrow(Number.isInteger(maximum) && maximum >= 1 && maximum <= configured, ERR.PARALLEL_LIMIT, "请求并发不能超过配置的 maxParallelNodes", { configured, requested: maximum });
  const active = (task.nodeRuns ?? []).filter(r => r.status === "running");
  const ready = readyNodes(task.stages ?? [], task.nodeRuns ?? []);
  let batch;
  try {
    batch = validateBatch({ stageIds: params.stageIds, readyNodeIds: ready, stages: task.stages ?? [], maxParallel: maximum });
    assertOrThrow(active.length + batch.stageIds.length <= maximum, ERR.PARALLEL_LIMIT, "本任务在途节点已占用并发名额", { running: active.length, requested: batch.stageIds.length, maximum });
    assertDisjointWritePaths([...task.stages.filter(s => active.some(r => r.stageId === s.id)), ...batch.stages]);
  } catch(err) { const mapped=mapParallelError(err); if(mapped)return mapped; throw err; }
  const batchId = "batch_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8);
  const startedAt = Date.now();
  const hit = new Set(batch.stageIds);
  const existing = new Set(task.nodeRuns.map(r=>r.stageId));
  const nodeRuns = [
    ...task.nodeRuns.map(r=>hit.has(r.stageId)?{...r,status:NODE_RUN_STATUS.RUNNING,batchId,startedAt,workerSessionId:null,failedReason:null}:r),
    ...batch.stageIds.filter(id=>!existing.has(id)).map(stageId=>({stageId,attempt:1,status:NODE_RUN_STATUS.RUNNING,reports:[],batchId,startedAt,startedAttempt:1})),
  ];
  const dispatchPlan = batch.stages.map(stage => {
    const attempt = nodeRuns.find(run => run.stageId === stage.id).attempt;
    return {stageId:stage.id, attempt, attemptRef:stageAttemptRef(task,stage.id,attempt), writePaths:stage.writePaths ?? []};
  });
  const binding={batchId,planVersion:task.planVersion,stageIds:batch.stageIds,maxParallel:maximum,at:startedAt,status:"running",dispatchPlan,...(params.team === true ? { team: true } : {})};
  store.set({...task,nodeRuns,delegations:[...(task.delegations??[]),binding],revision:task.revision+1,updatedAt:startedAt});
  return ok({taskId:task.id,...binding});
});

function applyWorkerResult(run, result, at) {
  return {
    ...run, status: result.ok ? NODE_RUN_STATUS.AWAITING_INTEGRATION : NODE_RUN_STATUS.REWORK,
    attempt: result.ok ? run.attempt : run.attempt + 1,
    workerReport: typeof result.report === "string" ? result.report : "",
    failedReason: result.ok || result.reason === "team-direction-changed" ? null : result.reason ?? "worker failed",
    batchId: result.ok ? run.batchId : null, completedAt: at,
  };
}

// Publish a finished sibling while the batch is still running. Its review may
// advance the stage before the final batch receipt arrives.
export function publishWorkerSuccess(store, binding, result) {
  const task = store.get();
  if (!result.ok || task?.id !== binding.taskId || task.planVersion !== binding.planVersion ||
      task.enabled === false || ![PHASES.ACTIVE, PHASES.REVIEWING].includes(task.phase)) return false;
  const batch = task.delegations?.find(b => b.batchId === binding.batchId && b.status === "running");
  const run = task.nodeRuns.find(r => r.stageId === result.stageId);
  if (!batch || run?.status !== "running" || run.batchId !== batch.batchId || run.attempt !== result.attempt) return false;
  const at = Date.now();
  const { delivery, ...receipt } = result;
  store.set({ ...task, nodeRuns: task.nodeRuns.map(r => r === run ? applyWorkerResult(r, result, at) : r),
    delegations: task.delegations.map(b => b === batch ? { ...b, results: [...(b.results ?? []), receipt] } : b),
    revision: task.revision + 1, updatedAt: at });
  return true;
}

export const completeDelegation = guard((store, params) => {
  const task=requireTask(store,params.taskId);
  assertWritable(task);
  const batch=(task.delegations??[]).find(b=>b.batchId===params.batchId);
  assertOrThrow(!!batch && batch.planVersion===task.planVersion && params.planVersion===task.planVersion, ERR.STALE_ATTEMPT, "并行回执的任务或计划版本已失效");
  if(batch.status==="completed") return ok({taskId:task.id,batchId:batch.batchId,status:batch.status,duplicate:true});
  assertOrThrow(batch.status==="running", ERR.STALE_ATTEMPT, "该批派工已取消");
  const results=Array.isArray(params.results)?params.results:[];
  const ids=results.map(r=>r.stageId);
  assertOrThrow(ids.length===batch.stageIds.length && new Set(ids).size===ids.length && batch.stageIds.every(id=>ids.includes(id)),ERR.DELEGATION_INVALID,"回执必须完整且唯一地覆盖本批节点");
  const published = new Map((batch.results ?? []).map(result => [result.stageId, result]));
  const remaining = results.filter(result => !published.has(result.stageId));
  for (const result of results) {
    const prior = published.get(result.stageId);
    assertOrThrow(!prior || (prior.attempt === result.attempt && prior.ok === result.ok),
      ERR.STALE_ATTEMPT, "阶段回执与已提交结果不符", { stageId: result.stageId });
  }
  for(const r of remaining){
    const run=task.nodeRuns.find(n=>n.stageId===r.stageId);
    assertOrThrow(run?.batchId===params.batchId && run.attempt===r.attempt && run.status==="running",ERR.STALE_ATTEMPT,"迟到回执不能覆盖新的节点尝试",{stageId:r.stageId});
  }
  const nodeRuns=task.nodeRuns.map(run=>{
    const result = remaining.find(r => r.stageId === run.stageId);
    return result ? applyWorkerResult(run, result, Date.now()) : run;
  });
  const failures=results.filter(r=>!r.ok);
  // 2026-11-08 修：回执原来只回 ok/failed/partial，调用方看不出本批落哪个失败点、该怎么回滚。
  // planBatch 已经算好了 R1/R4/R5/R7，直接透出 point 与 rollback 计划。
  // 并且 R5（worker 跑完却没通过校验）要暂停任务、不自动重试 —— 保留证据等人判断。
  const batchPlan = planBatch(results);
  const paused = batchPlan.point === "R5" && !batch.team;
  // 2026-11-09：先落回执（phase 不变，store 放行），需要暂停时再走 setPhase。
  // 原来把 phase 混在同一个裸 store.set 里，属于绕过单一写入口。
  store.set({...task,nodeRuns,delegations:task.delegations.map(b=>b.batchId===batch.batchId?{...b,status:"completed",results:results.map(({ delivery, ...result }) => result),completedAt:Date.now()}:b),revision:task.revision+1,updatedAt:Date.now()});
  if (paused) setPhase(store, PHASES.PAUSED, { pauseReason: "recovery-failed", prePausePhase: task.phase, pausedAt: Date.now() });
  return ok({taskId:task.id,batchId:batch.batchId,status:"completed",ok:failures.length===0,failed:failures.map(r=>r.stageId),partial:failures.length>0&&failures.length<results.length,point:batchPlan.point,rollback:batchPlan.rollback,phase:store.get().phase,message:failures.length?(paused?"子任务跑完但校验未过；保留证据并暂停任务，不自动重试":"部分节点失败；保留成功输出，主会话处理失败节点并集成"):"子任务已返回；主会话须检查并集成后提交阶段验收"});
});

export const HANDLERS = Object.freeze({
  // 只读 / 开关类：不包 writable，任何状态都必须可调
  mentor_task_create: taskCreate,
  mentor_task_status: taskStatus,

  // 写操作：先过 assertWritable（paused / off / archived / completed 一律拦住）
  //
  // 2026-11-09（T4 契约）：`mentor_stage_report` 直接绑 `stageReportGated`。
  // 以前这里是 writable(stageReport) —— 同一个工具名有两条语义不同的入口
  // （工具链路走门禁、HANDLERS 直调裸写），对同一入参会给出相反结论。
  // 不做「工厂化 HANDLERS」：lib/index.js:24 是具名 import，改成工厂会在插件
  // 加载期 ESM 链接失败，node --check 查不出来。
  mentor_plan_submit: writable(planSubmit),
  mentor_plan_amend: writable(planAmend),
  mentor_stage_report: stageReportGated,
  mentor_completion_request: writable(completionRequest),
  mentor_finding_respond: writable(findingRespond),
  mentor_finding_close: writable(findingClose),
  mentor_review_apply: writable(reviewApply),
  mentor_rework_stage: writable(reworkStage),
  mentor_node_start: writable(nodeStart),
  // 并行委派（2026-11-05）：校验+状态迁移在 handler，起子 Agent 在 lib/index.js
  mentor_delegate_nodes: delegateNodes,
  mentor_delegate_complete: completeDelegation,

  // 控制接口（2026-11-04）：各自管自己的准入，不能统一包 writable
  //   · on / off   —— 要在 off 状态下可调
  //   · resume     —— 要在 paused 状态下可调
  //   · clear      —— 任何状态都要能归档（含 completed / off）
  //   · approve    —— 自带 awaiting-approval 判断
  //   · pause      —— 要在运行中调用
  mentor_task_approve: taskApprove,
  mentor_task_pause: taskPause,
  mentor_task_resume: taskResume,
  mentor_task_clear: taskClear,
  mentor_task_off: taskOff,
  mentor_task_on: taskOn,
  // 人工放行（2026-11-07）：独立审查确实失败时，只有人能显式豁免，
  // 模型拿不到这条通道（lib/index.js 里 !human 直接拒）。放行记录进
  // task.reviewWaivers，由 applyBoundReview 校验后才允许主会话裁决。
  mentor_review_waive: reviewWaive,
});
