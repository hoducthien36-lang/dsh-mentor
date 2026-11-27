/**
 * 任务状态机（SPEC §2.1）。
 *
 * 合法转移表是唯一权威：
 *   planning          → planning, awaiting-approval, archived
 *   awaiting-approval → awaiting-approval, active, paused, archived
 *   active            → active, reviewing, paused, archived
 *   reviewing         → reviewing, active, completed, paused, archived
 *   paused            → paused, planning, awaiting-approval, active, reviewing, archived
 *   completed         → archived            （做完 ≠ 不能归档）
 *   archived          → （唯一真终态，无出边）
 *
 * 非法转移一律抛 E_ILLEGAL_TRANSITION，绝不静默修正。
 *
 * 2026-11-04 扩表（控制接口）：新增 AWAITING_APPROVAL / PAUSED / ARCHIVED 三态。
 *   · AWAITING_APPROVAL 是 `mentor_task_approve` 的落脚点 —— 原来 plan_submit
 *     直接 planning→active，导致「批准当前计划」根本无处可批（s1 设计被审查打回的硬伤）。
 *   · PAUSED 承接 pause/resume，配合 prePausePhase 精确恢复。
 *   · ARCHIVED 承接 clear。completed 允许 → archived：旧 supervisor 的 clear
 *     对已完成任务同样生效（source/lib/index.mjs:7152-7179 只挡了 pause），
 *     所以「已完成也能归档」必须成立。
 */

import { ERR, MentorError, assertOrThrow } from "../errors.js";

export const PHASES = Object.freeze({
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting-approval",
  ACTIVE: "active",
  REVIEWING: "reviewing",
  PAUSED: "paused",
  COMPLETED: "completed",
  ARCHIVED: "archived",
});

const ALL_PHASES = Object.freeze(Object.values(PHASES));

/** 转移表：from → 允许的 to 集合 */const ALLOWED = Object.freeze({
  [PHASES.PLANNING]: Object.freeze([
    PHASES.PLANNING,
    // 保留直通 active：auto-approve 路径（requireApproval=false）就是
    // planning → awaiting-approval → active 两步走，但测试与外部调用方
    // 仍有用 transition(task, ACTIVE) 直接造 active 任务的场景。
    // 删掉它会让「计划一提交就开工」这条合法路径变成非法，
    // 属过度收紧 —— 合法性交给调用点（planSubmit 决定走一步还是两步）。
    PHASES.AWAITING_APPROVAL,
    PHASES.ACTIVE,
    // 2026-11-04 修（s2 审查）：planning 必须能暂停。
    // 设计表里写了 planning → paused，代码里却漏了，导致规划中途按暂停
    // 直接抛 E_ILLEGAL_TRANSITION —— 与 c5「暂停当前任务」冲突。
    PHASES.PAUSED,
    PHASES.ARCHIVED,
  ]),
  [PHASES.AWAITING_APPROVAL]: Object.freeze([
    PHASES.AWAITING_APPROVAL,
    PHASES.ACTIVE,
    PHASES.PAUSED,
    PHASES.ARCHIVED,
  ]),
  // 2026-11-04 修 P2-6：原实现没有自环，active 下任何 transition(task, ACTIVE)
  // 都会抛 E_ILLEGAL_TRANSITION；planAmend 只能靠 store.set 绕过，属侥幸。
  [PHASES.ACTIVE]: Object.freeze([
    PHASES.ACTIVE,
    PHASES.REVIEWING,
    PHASES.PAUSED,
    PHASES.ARCHIVED,
  ]),
  [PHASES.REVIEWING]: Object.freeze([
    PHASES.REVIEWING,
    PHASES.ACTIVE,
    PHASES.COMPLETED,
    PHASES.PAUSED,
    PHASES.ARCHIVED,
  ]),
  [PHASES.PAUSED]: Object.freeze([
    PHASES.PAUSED,
    PHASES.PLANNING,
    PHASES.AWAITING_APPROVAL,
    PHASES.ACTIVE,
    PHASES.REVIEWING,
    PHASES.ARCHIVED,
  ]),
  [PHASES.COMPLETED]: Object.freeze([PHASES.ARCHIVED]),
  [PHASES.ARCHIVED]: Object.freeze([]),
});

export function isPhase(value) {
  return typeof value === "string" && ALL_PHASES.includes(value);
}

/**
 * 暂停原因分层（改造 s2，对齐旧 supervisor 的 pauseReason 8 值）。
 *
 * 旧实现把「为什么停」编码成枚举而不是自由文本，因为**恢复策略依赖它**：
 * `review-fault` 的 resume 要重试原审查，其余只是回到暂停前状态。
 * mentor 之前只存自由字符串，等于把这条信息丢了。
 *
 * 取值来源：`index.mjs:353-362`（inventory §3.3）。
 */
/**
 * nodeRuns 的合法状态词表（并行委派需要新增两态）。
 *
 * 为什么要有这张表：并行派发期间节点既不是 pending（已派出去）也不是 reported
 * （worker 还没交），旧词表只有 pending/reported/rework/accepted 四态，
 * 落到中间态时只能临时拼字符串，容易被写错也查不出来。
 */
export const NODE_RUN_STATUS = Object.freeze({
  PENDING: "pending", // 等主轴执行
  RUNNING: "running", // 并行派发中（worker 未回）
  AWAITING_INTEGRATION: "awaiting-integration", // worker 全回，等主轴做集成检查
  REPORTED: "reported", // 已上报证据，待审查
  REWORK: "rework", // 审查打回
  ACCEPTED: "accepted", // 审查通过
});

const ALL_NODE_RUN_STATUS = Object.freeze(Object.values(NODE_RUN_STATUS));

export function isNodeRunStatus(value) {
  return typeof value === "string" && ALL_NODE_RUN_STATUS.includes(value);
}

export const PAUSE_REASONS = Object.freeze({
  USER: "user", // 用户/模型主动暂停
  DECISION: "decision", // 等用户对某个决定表态
  REVIEW_FAULT: "review-fault", // 审查自身出错（恢复时需重试审查）
  RESTART: "restart", // 进程重启遗留
  RECOVERY_STALLED: "recovery-stalled",
  PLANNING_STALLED: "planning-stalled",
  RECOVERY_FAILED: "recovery-failed",
  SUPERVISOR_STOPPED: "supervisor-stopped", // 导师被关闭时顺带停
});

const ALL_PAUSE_REASONS = Object.freeze(Object.values(PAUSE_REASONS));

export function isPauseReason(value) {
  return typeof value === "string" && ALL_PAUSE_REASONS.includes(value);
}

export function pauseReasonList() {
  return [...ALL_PAUSE_REASONS];
}

/** 唯一真终态：归档。已归档的任务不再有任何出边。 */
export function isTerminal(phase) {
  return phase === PHASES.ARCHIVED;
}

/**
 * 语义上的「不再推进」：已完成或已归档。
 * 与 isTerminal 区分开 —— completed 仍可被归档，只是不能再执行工作。
 */
export function isFinished(phase) {
  return phase === PHASES.COMPLETED || phase === PHASES.ARCHIVED;
}

/** 列出某状态下允许的下一状态（含自身，表示原地重入） */
export function allowedNext(from) {
  return ALLOWED[from] ? [...ALLOWED[from]] : [];
}

export function canTransition(from, to) {
  return allowedNext(from).includes(to);
}

export function assertTransition(from, to) {
  assertOrThrow(isPhase(from), ERR.ILLEGAL_TRANSITION, `未知的当前状态：${from}`, {
    from,
  });
  assertOrThrow(isPhase(to), ERR.ILLEGAL_TRANSITION, `未知的目标状态：${to}`, {
    to,
  });
  assertOrThrow(
    canTransition(from, to),
    ERR.ILLEGAL_TRANSITION,
    `状态转移非法：${from} → ${to}`,
    { from, to, allowed: allowedNext(from) },
  );
}

/**
 * 创建一个处于 planning 的初始任务（SPEC §1.1 的字段子集）。
 *
 * @param {string} objective 目标陈述，非空
 * @param {object} [extra]   额外字段（如 id / createdAt），主要用于测试注入确定性
 * @returns {object} 新任务对象
 */
export function createTask(objective, extra = {}) {
  assertOrThrow(
    typeof objective === "string" && objective.trim().length > 0,
    ERR.INTERNAL,
    "objective 必须是非空字符串",
  );

  const now = extra.createdAt ?? Date.now();
  return {
    id: extra.id ?? newId(),
    revision: 1,
    objective: objective.trim(),
    phase: PHASES.PLANNING,
    planVersion: 0,
    criteria: [],
    stages: [],
    nodeRuns: [],
    findings: [],
    reviews: [],
    createdAt: now,
    updatedAt: now,
  };
}

function newId() {
  // 不引入 uuid 依赖：用时间戳 + 随机段，碰撞概率足够低，且不泄漏机器信息
  const rand = Math.random().toString(36).slice(2, 10);
  return `task_${Date.now().toString(36)}_${rand}`;
}

/**
 * 执行一次状态转移，返回**新任务对象**（不修改入参）。
 *
 * @param {object} task 当前任务
 * @param {string} to   目标状态
 * @param {object} [patch] 同一次转移要合并的字段
 * @returns {object} 新任务
 */
export function transition(task, to, patch = {}) {
  assertOrThrow(!!task && typeof task === "object", ERR.INTERNAL, "task 必须是对象");
  assertTransition(task.phase, to);

  const next = {
    ...task,
    ...patch,
    phase: to,
    revision: task.revision + 1,
    updatedAt: patch.updatedAt ?? Date.now(),
  };
  return next;
}

/**
 * 完成请求的前置判定（SPEC §2.5）。
 * 只判断与状态机/节点/整改有关的条件，证据内容由上层负责。
 *
 * @param {object} task
 * @returns {{ok:boolean, unmet:Array<{code:string,message:string}>}}
 */
export function checkCompletionReadiness(task) {
  const unmet = [];

  // 以 stages 为准逐个核对是否已 accepted。
  // 只遍历 nodeRuns 会漏掉「从未上报过」的阶段——那种阶段在 nodeRuns 里根本没有记录，
  // 会被误判成"没有未完成项"。这是 v0.1.0 的真实缺陷（task_mvzibxpw 上复现）。
  const stages = task.stages ?? [];
  if (stages.length === 0) {
    unmet.push({
      code: "unmet_no_stages",
      message: "计划中没有阶段，无法请求完成",
    });
  }

  const acceptedStageIds = new Set(
    (task.nodeRuns ?? [])
      .filter((r) => r.status === "accepted")
      .map((r) => r.stageId),
  );
  const unfinished = stages.filter((s) => !acceptedStageIds.has(s.id));
  if (unfinished.length > 0) {
    unmet.push({
      code: "unmet_stage_not_accepted",
      message: `仍有 ${unfinished.length} 个阶段未被接受：${unfinished
        .map((s) => s.id)
        .join(", ")}`,
    });
  }

  const openBlocking = (task.findings ?? []).filter(
    (f) => f.severity === "blocking" && f.status !== "closed",
  );
  if (openBlocking.length > 0) {
    unmet.push({
      code: ERR.BLOCKING_FINDING_OPEN,
      message: `仍有 ${openBlocking.length} 条 blocking finding 未关闭`,
    });
  }

  const lastReview = (task.reviews ?? []).at(-1);
  if (!lastReview || lastReview.verdict !== "pass") {
    unmet.push({
      code: "unmet_review_not_pass",
      message: "最近一次审查裁决不是 pass",
    });
  }

  if (task.phase !== PHASES.REVIEWING) {
    unmet.push({
      code: "unmet_not_reviewing",
      message: `当前状态是 ${task.phase}，完成请求只能在 reviewing 下提出`,
    });
  }

  return { ok: unmet.length === 0, unmet };
}

/** 断言式版本：不满足就抛错，details 里带全部未满足项 */
export function assertCompletionReady(task) {
  const { ok: ready, unmet } = checkCompletionReadiness(task);
  if (!ready) {
    throw new MentorError(
      unmet.length === 1 && unmet[0].code === ERR.BLOCKING_FINDING_OPEN
        ? ERR.BLOCKING_FINDING_OPEN
        : ERR.ILLEGAL_TRANSITION,
      "完成请求的前置条件未满足",
      { unmet },
    );
  }
}
