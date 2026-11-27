/**
 * 面板取数用的任务快照。
 *
 * 契约：**与 mentor_task_status 的返回逐字段一致**。
 * test/rpc.test.mjs 用深度相等把两边锁在一起——任何一侧增删字段而另一侧没跟上，
 * 测试就会红。这样面板看到的永远是工具层真实返回的形状，不会出现「端点裁字段、
 * 验收要求全字段」的偏差。
 *
 * 本模块不依赖 DSH，与 handlers.js 同层，可独立测试。
 */

import { readyNodes } from "../plan/dag.js";
import { unresolvedSummary } from "../review/review.js";
import { allowedTransitions, computeNextStep, isLive } from "../state/guard.js";

/**
 * 由当前任务对象组出快照。
 *
 * @param {object|null} task  store 里的当前任务
 * @returns {{task: null} | object}  无任务时返回 { task: null }，不以错误表示空态
 */
export function buildStatePayload(task) {
  if (!task) return { task: null };

  return {
    taskId: task.id,
    revision: task.revision,
    objective: task.objective,
    phase: task.phase,
    planVersion: task.planVersion,
    // 2026-11-05（s3）：谁在推这个任务，唤醒主轴时要用。旧任务无该字段 → null，不报错。
    mainSessionId: task.mainSessionId ?? null,
    criteria: task.criteria,
    ...(task.requiredCriteria ? { requiredCriteria: task.requiredCriteria } : {}),
    stages: task.stages,
    nodeRuns: task.nodeRuns,
    ...(task.recheckHistory?.length ? {recheckHistory:task.recheckHistory} : {}),
    readyNodes: readyNodes(task.stages, task.nodeRuns),
    unresolved: unresolvedSummary(task),
    lastReview: task.reviews.at(-1) ?? null,
    workspaceRoot: task.workspaceRoot ?? null,
    findings: task.findings ?? [],
    reviews: task.reviews ?? [],
    parallelBatches: task.delegations ?? task.parallelBatches ?? [],
    workers: task.workers ?? [],
    pendingCheckpoint: task.pendingCheckpoint ?? null,
    continuation: task.continuation ?? null,
    ...(task.lastPrechecks ? { lastPrechecks: task.lastPrechecks } : {}),
    ...(task.rigor ? { rigor: task.rigor } : {}),
    ...(task.lastDiffAudits && Object.keys(task.lastDiffAudits).length ? { lastDiffAudits: task.lastDiffAudits } : {}),
    ...(task.stageCheckpoints && Object.keys(task.stageCheckpoints).length ? { stageCheckpoints: task.stageCheckpoints } : {}),
    ...(task.suggestedPrechecks?.length ? { suggestedPrechecks: task.suggestedPrechecks } : {}),
    ...(task.ambiguityReport ? { ambiguityReport: task.ambiguityReport } : {}),
    ...(task.clarifications?.length ? { clarifications: task.clarifications } : {}),
    ...(task.stuckEvents?.length ? { stuckEvents: task.stuckEvents } : {}),
    ...(task.lastMutations && Object.keys(task.lastMutations).length ? { lastMutations: task.lastMutations } : {}),
    ...(task.mcpSchemaAlerts?.length ? { mcpSchemaAlerts: task.mcpSchemaAlerts } : {}),
    reviewJobs: task.reviewJobs ?? [],
    reviewDispatches: task.reviewDispatches ?? [],
    wakeDispatches: task.wakeDispatches ?? [],
    lastPersistError: task.lastPersistError ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    // ---- 2026-11-04 控制接口新增 ----
    // 对应旧 supervisor 的 task-status「状态 + 下一步」：
    //   · enabled            —— 导师是否被 task-off 关掉（旧版同名概念）
    //   · nextStep           —— 旧版叫 executionBlockedReason + 人话提示，
    //                           这里合成 {code,text,allowedActions}
    //   · allowedTransitions —— 当前 phase 还能迁到哪，供 UI 决定按钮灰不灰
    // enabled 判断在 computeNextStep 内部优先于 paused，保证「导师关了」时
    // 给出的理由是 SUPERVISOR_DISABLED 而不是「已暂停」。
    enabled: task.enabled !== false,
    live: isLive(task),
    paused: task.phase === "paused",
    prePausePhase: task.prePausePhase ?? null,
    // 暂停原因分层（改造 s2，对齐旧 pauseReason 8 值）：恢复策略依赖它
    pauseReason: task.pauseReason ?? null,
    pausedAt: task.pausedAt ?? null,
    approvedPlanVersion: task.approvedPlanVersion ?? null,
    archivedAt: task.archivedAt ?? null,
    ...(task.archivedUndoUntil ? { archivedUndoUntil: task.archivedUndoUntil } : {}),
    ...(task.preArchivePhase ? { preArchivePhase: task.preArchivePhase } : {}),
    ...(Number.isInteger(task.ownershipGeneration) ? { ownershipGeneration: task.ownershipGeneration } : {}),
    ...(task.sessionHistory?.length ? { sessionHistory: task.sessionHistory } : {}),
    nextStep: computeNextStep(task),
    allowedTransitions: allowedTransitions(task),
  };
}

/**
 * 生成端点处理器。
 *
 * 返回 RPC 信封 { ok: true, value: {...} }。读的是传入 store 的当前快照，
 * 因此与工具层共享同一份状态，不存在两套数据源。
 *
 * @param {{get: () => object|null}} store
 * @returns {() => Promise<{ok: true, value: object}>}
 */
export function createStateHandler(store) {
  return async function handleState() {
    return { ok: true, value: buildStatePayload(store.get()) };
  };
}
