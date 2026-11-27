/**
 * 统一错误约定（SPEC §3）。
 *
 * 所有对外函数的错误都走 MentorError：带稳定 code，不抛裸字符串。
 * 调用方拿到的是 { ok:false, code, message, details? }，不是异常。
 */

export const ERR = Object.freeze({
  // 状态机
  ILLEGAL_TRANSITION: "E_ILLEGAL_TRANSITION",
  // 2026-11-09（状态机收口）：绕过 src/runtime/phase-writer.js 的 setPhase() 裸写 phase。
  // store 层（createMemoryStore）发现同一条任务的 phase 变了且没有 phaseWriter 标记时抛它。
  PHASE_WRITE_BYPASS: "E_PHASE_WRITE_BYPASS",
  // 计划 DAG
  CRITERION_UNKNOWN: "E_CRITERION_UNKNOWN",
  REVIEW_ORDER: "E_REVIEW_ORDER",
  CRITERION_ORPHAN: "E_CRITERION_ORPHAN",
  DEP_UNKNOWN: "E_DEP_UNKNOWN",
  DEP_CYCLE: "E_DEP_CYCLE",
  NO_ENTRY: "E_NO_ENTRY",
  STAGE_DUP: "E_STAGE_DUP",
  WRITEPATH_CONFLICT: "E_WRITEPATH_CONFLICT",
  EMPTY_PLAN: "E_EMPTY_PLAN",
  PLAN_CITATION_SCOPE: "E_PLAN_CITATION_SCOPE",
  // 阶段验收
  DEP_NOT_READY: "E_DEP_NOT_READY",
  STALE_ATTEMPT: "E_STALE_ATTEMPT",
  STAGE_UNKNOWN: "E_STAGE_UNKNOWN",
  // 整改
  BLOCKING_FINDING_OPEN: "E_BLOCKING_FINDING_OPEN",
  FINDING_UNKNOWN: "E_FINDING_UNKNOWN",
  FINDING_NOT_RESPONDED: "E_FINDING_NOT_RESPONDED",
  // 2026-11-04 修 P2-4：reviewer 提交了已存在的 finding id
  FINDING_DUP: "E_FINDING_DUP",
  // 引文校验：引号里的那段在被审证据中找不到（防转述失真）
  QUOTE_NOT_FOUND: "E_QUOTE_NOT_FOUND",
  // 2026-11-04 改造 s4（G7）：响应里引用了本任务不存在的证据 id
  EVIDENCE_UNKNOWN: "E_EVIDENCE_UNKNOWN",
  // 2026-11-04 s4（SPEC §2.6 报告提交门槛）：
  // evidence[] 缺字段/空数组 / 片段未命中 / 路径逃出项目根 / 旧账未清 / 计划版本陈旧
  EVIDENCE_REQUIRED: "E_EVIDENCE_REQUIRED",
  EVIDENCE_MISMATCH: "E_EVIDENCE_MISMATCH",
  EVIDENCE_OUTSIDE: "E_EVIDENCE_OUTSIDE",
  UNRESPONDED_FINDINGS: "E_UNRESPONDED_FINDINGS",
  STALE_PLAN: "E_STALE_PLAN",
  // v0.3：阶段前置确定性硬检查未通过（未启动独立审查）
  PRECHECK_FAILED: "E_PRECHECK_FAILED",
  // 2026-11-05 并行委派（s3）：批次超限 / 批次形状非法 / 同批写域冲突
  PARALLEL_LIMIT: "E_PARALLEL_LIMIT",
  DELEGATION_INVALID: "E_DELEGATION_INVALID",
  WRITE_CONFLICT: "E_WRITE_CONFLICT",
  // 2026-11-04 改造 s4（G1）：配置要求 pass 必须附检查清单，但没给
  CHECKS_REQUIRED: "E_CHECKS_REQUIRED",
  // 2026-11-04 修 P0-2：审查闸门的范围校验（幽灵 stageId / attempt 失配 / 跨阶段关闭）
  REVIEW_SCOPE: "E_REVIEW_SCOPE",
  // 审查工具越界或调用次数超过硬预算
  REVIEW_POLICY: "E_REVIEW_POLICY",
  // 检查点与人工控制
  TASK_INACTIVE: "E_TASK_INACTIVE",
  REVIEW_PENDING: "E_REVIEW_PENDING",
  WORK_PENDING: "E_WORK_PENDING",
  STAGE_NOT_ACCEPTED: "E_STAGE_NOT_ACCEPTED",
  REVIEW_IDENTITY: "E_REVIEW_IDENTITY",
  SELF_REVIEW_UNAUTHORIZED: "E_SELF_REVIEW_UNAUTHORIZED",
  REVIEW_STALE: "E_REVIEW_STALE",
  REVIEW_UNREAD: "E_REVIEW_UNREAD",
  REVIEW_VERDICT: "E_REVIEW_VERDICT",
  REVIEW_COVERAGE: "E_REVIEW_COVERAGE",
  REVIEW_MISSING: "E_REVIEW_MISSING",
  HUMAN_REQUIRED: "E_HUMAN_REQUIRED",
  FINDING_CLOSE_REASON: "E_FINDING_CLOSE_REASON",
  // 持久化
  REVISION_CONFLICT: "E_REVISION_CONFLICT",
  STATE_CORRUPT: "E_STATE_CORRUPT",
  // 任务定位（预期状态，不是内部故障）
  NO_TASK: "E_NO_TASK",
  WORKSPACE_REQUIRED: "E_WORKSPACE_REQUIRED",
  TASK_MISMATCH: "E_TASK_MISMATCH",
  TASK_EXISTS: "E_TASK_EXISTS",
  // 兜底
  INTERNAL: "E_INTERNAL",
});

/**
 * Round 3：失败结果的「可执行引导」目录。
 *
 * 只描述两类与调用方无关的元信息：
 *   · recovery —— 调用方下一步该干什么（wait / refresh / correct-input / retry / human / none）
 *   · retryable —— 原样重放是否可能成功
 *
 * 具体到某个身份能调哪些工具（allowedActions / humanActions）属于适配层知识，
 * 放在 lib/index.js 里组装 —— 那里才知道 task、sessionId 与 human 开关。
 * 本表刻意不 import 任何模块，避免与 state/guard.js 形成循环依赖。
 */
export const FAILURE_GUIDANCE = Object.freeze({
  // 预期状态门禁：等一等就会过去
  [ERR.REVIEW_PENDING]: { recovery: "wait", retryable: true },
  [ERR.WORK_PENDING]: { recovery: "wait", retryable: true },
  // 需要重新读取状态再决定
  [ERR.REVIEW_UNREAD]: { recovery: "refresh", retryable: true },
  [ERR.REVIEW_STALE]: { recovery: "refresh", retryable: true },
  [ERR.STALE_PLAN]: { recovery: "refresh", retryable: true },
  [ERR.STALE_ATTEMPT]: { recovery: "refresh", retryable: true },
  [ERR.REVISION_CONFLICT]: { recovery: "refresh", retryable: true },
  [ERR.REVIEW_MISSING]: { recovery: "refresh", retryable: true },
  [ERR.STATE_CORRUPT]: { recovery: "human", retryable: false },
  // 输入/参数问题：改参数再试
  [ERR.ILLEGAL_TRANSITION]: { recovery: "correct-input", retryable: false },
  [ERR.TASK_MISMATCH]: { recovery: "correct-input", retryable: false },
  [ERR.TASK_EXISTS]: { recovery: "correct-input", retryable: false },
  [ERR.WORKSPACE_REQUIRED]: { recovery: "correct-input", retryable: false },
  [ERR.NO_TASK]: { recovery: "correct-input", retryable: false },
  [ERR.STAGE_UNKNOWN]: { recovery: "correct-input", retryable: false },
  [ERR.EVIDENCE_REQUIRED]: { recovery: "correct-input", retryable: false },
  [ERR.EVIDENCE_MISMATCH]: { recovery: "correct-input", retryable: false },
  [ERR.EVIDENCE_OUTSIDE]: { recovery: "correct-input", retryable: false },
  [ERR.EVIDENCE_UNKNOWN]: { recovery: "correct-input", retryable: false },
  [ERR.PRECHECK_FAILED]: { recovery: "correct-input", retryable: false },
  [ERR.CHECKS_REQUIRED]: { recovery: "correct-input", retryable: false },
  [ERR.REVIEW_COVERAGE]: { recovery: "correct-input", retryable: false },
  [ERR.REVIEW_VERDICT]: { recovery: "correct-input", retryable: false },
  [ERR.REVIEW_SCOPE]: { recovery: "correct-input", retryable: false },
  [ERR.REVIEW_IDENTITY]: { recovery: "correct-input", retryable: false },
  [ERR.REVIEW_POLICY]: { recovery: "correct-input", retryable: false },
  [ERR.DELEGATION_INVALID]: { recovery: "correct-input", retryable: false },
  [ERR.PARALLEL_LIMIT]: { recovery: "correct-input", retryable: false },
  [ERR.WRITE_CONFLICT]: { recovery: "correct-input", retryable: false },
  // 只有人能解开
  [ERR.HUMAN_REQUIRED]: { recovery: "human", retryable: false },
  [ERR.SELF_REVIEW_UNAUTHORIZED]: { recovery: "human", retryable: false },
  // 其余
  [ERR.TASK_INACTIVE]: { recovery: "none", retryable: false },
  [ERR.INTERNAL]: { recovery: "retry", retryable: true },
});

/** 未登记的 code 一律保守处理：不承诺可重放。 */
export function failureGuidance(code) {
  return FAILURE_GUIDANCE[code] ?? { recovery: "retry", retryable: false };
}

export class MentorError extends Error {
  /**
   * @param {string} code  来自 ERR 的稳定错误码
   * @param {string} message 人类可读说明
   * @param {object} [details] 结构化补充信息（不塞进 message）
   */
  constructor(code, message, details) {
    super(message);
    this.name = "MentorError";
    this.code = code;
    this.details = details === undefined ? null : details;
  }

  /** 转成对外结果形状 */
  toResult() {
    const out = { ok: false, code: this.code, message: this.message };
    if (this.details !== null) out.details = this.details;
    return out;
  }
}

/** 成功结果包装 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * 把任意异常收敛成对外结果。
 * MentorError 原样透出；其他异常降级为 E_INTERNAL 并保留原始信息。
 */
export function toFailure(err) {
  if (err instanceof MentorError) return err.toResult();
  return {
    ok: false,
    code: ERR.INTERNAL,
    message: err && err.message ? String(err.message) : String(err),
  };
}

/**
 * 断言工具：条件不满足就抛 MentorError。
 * 用于库内部；对外函数统一用 try/catch + toFailure 收口。
 */
export function assertOrThrow(condition, code, message, details) {
  if (!condition) throw new MentorError(code, message, details);
}
