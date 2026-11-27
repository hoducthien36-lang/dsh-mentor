/**
 * 审查完成后的「唤醒主轴」判定与消息构造（纯函数，不依赖 DSH）。
 *
 * 背景（见 verification/autowake-design.md）：
 *   reviewer 调 mentor_review_apply 把裁决写进状态库，但**写库不等于唤醒**。
 *   主轴（主会话 agent）的回合早已结束，没人告诉它"审查出结果了"，
 *   于是任务停在 active 一动不动，直到用户开口 —— 本会话实测卡过 64 分钟。
 *
 * 本模块只负责「该不该唤醒、唤醒说什么」，真正投递在 lib/index.js（需要 ctx.agents）。
 */

import { reviewOrderConflict, reviewOrderMessage } from "../plan/dag.js";

/** 缺省唤醒上限：多阶段并行审查同时结束时，最多记这么多条 */
export const WAKE_LOG_LIMIT = 20;

/**
 * 节流键：阶段 + attempt + 裁决三元组。
 *
 * 为什么不是只用 stageId：同一阶段 `revise → 修 → 再报 → pass` 是两次不同结果，
 * 只按 stageId 去重会把 pass 吞掉；带 verdict 还能合并 reviewer 重试写下的同向裁决。
 */
export function wakeKey({ stageId, attempt, verdict } = {}) {
  return `${String(stageId ?? "")}/${String(attempt ?? "")}/${String(verdict ?? "")}`;
}

/** 统计未关闭的 finding，按严重度分开 */
export function countOpenFindings(task) {
  const list = Array.isArray(task?.findings) ? task.findings : [];
  const open = list.filter((f) => f && f.status !== "closed");
  const blocking = open.filter((f) => (f.severity ?? "blocking") === "blocking").length;
  return { total: open.length, blocking, advisory: open.length - blocking };
}

/**
 * 该不该唤醒。
 *
 * 六种不唤醒的理由，全部带 reason，且**都不影响裁决本身**：
 *   disabled                —— 配置 autoWakeMain=false
 *   no-main-session         —— 任务上没有 mainSessionId（旧任务/导入数据）
 *   host-agents-unavailable —— 宿主没给 ctx.agents
 *   main-session-gone       —— agents.get 拿不到该会话（已结束/已归档）
 *   duplicate               —— 同一三元组已经投过
 *   invalid                 —— 阶段/attempt/verdict 缺失，构造不出有意义的消息
 *
 * @param {object} task
 * @param {{stageId?:string, attempt?:number, verdict?:string, enabled?:boolean,
 *          hasAgents?:boolean, sessionAlive?:boolean}} [options]
 * @returns {{wake:boolean, reason:string, key:string}}
 */
export function shouldWake(task, options = {}) {
  const { stageId, attempt, verdict } = options;
  const key = wakeKey({ stageId, attempt, verdict });

  const valid =
    typeof stageId === "string" && stageId.length > 0 &&
    Number.isInteger(attempt) && attempt >= 1 &&
    typeof verdict === "string" && verdict.length > 0;
  if (!valid) return { wake: false, reason: "invalid", key };

  if (options.enabled === false) return { wake: false, reason: "disabled", key };
  if (!task || typeof task !== "object") return { wake: false, reason: "no-main-session", key };
  if (typeof task.mainSessionId !== "string" || task.mainSessionId.length === 0) {
    return { wake: false, reason: "no-main-session", key };
  }
  if (options.hasAgents === false) return { wake: false, reason: "host-agents-unavailable", key };
  if (options.sessionAlive === false) return { wake: false, reason: "main-session-gone", key };

  const seen = Array.isArray(task.wakeDispatches) ? task.wakeDispatches : [];
  if (seen.some((d) => d && d.key === key)) return { wake: false, reason: "duplicate", key };

  return { wake: true, reason: "ok", key };
}

/**
 * 唤醒消息正文。
 *
 * 刻意不写"立即提交"这类强制措辞：那会形成「唤醒 → 自动重报 → 又审查 → 又唤醒」的自激环。
 * 只陈述结果与建议动作，由主轴自己决定节奏。
 *
 * @param {{stageId:string, attempt:number, verdict:string, planVersion?:number}} report
 * @param {object} [task] 用于数未关闭 finding
 */
export function buildWakeMessage(report, task) {
  const { stageId, attempt, verdict } = report ?? {};
  const { total, blocking, advisory } = countOpenFindings(task);
  const planVersion = report?.planVersion ?? task?.planVersion ?? "?";

  const conflict = task ? reviewOrderConflict(task) : null;
  const nextHint = conflict
    ? `下一步：${reviewOrderMessage(conflict)} 请调用 mentor_plan_amend 调整计划，勿继续重报该阶段。`
    : verdict === "pass"
      ? "下一步：该阶段已通过，可推进下一个就绪节点（先 mentor_task_status 看待办）。"
      : "下一步：调 mentor_task_status 读 findings，逐条 mentor_finding_respond 后再重报该阶段。";

  return [
    `[mentor] 阶段 ${stageId}（attempt ${attempt}）审查完成：${verdict}`,
    `未解决 finding：${total} 条（blocking ${blocking} / advisory ${advisory}）`,
    nextHint,
    `planVersion：${planVersion}`,
  ].join("\n");
}

/**
 * 把一次投递记进任务（容量 WAKE_LOG_LIMIT，风格同 reviewDispatches）。
 *
 * @param {object} task
 * @param {{key:string, queued:boolean, reason?:string, stageId?:string, attempt?:number, verdict?:string, at?:number}} entry
 */
export function appendWakeDispatch(task, entry) {
  const list = Array.isArray(task?.wakeDispatches) ? task.wakeDispatches : [];
  return [...list, { at: Date.now(), ...entry }].slice(-WAKE_LOG_LIMIT);
}

export function buildPlanWakeMessage({ verdict, planVersion, attempt }, task) {
  const header = `[mentor] 计划审查完成：${verdict}（planVersion ${planVersion}，attempt ${attempt}）。`;
  if (verdict === "revise") {
    const open = (task.findings ?? []).filter(f => f.stageId === "__plan__" && f.status !== "closed");
    const issues = open.filter(f => f.severity === "blocking");
    const reasons = (issues.length ? issues : open).map(f => `${f.id}：${f.text}`);
    return header + "请修订计划并用 mentor_plan_submit 重新提交。" +
      (reasons.length ? "\n待整改：\n" + reasons.join("\n") : "读取 mentor_task_status 查看审查意见。");
  }
  if (task.phase === "awaiting-approval") return header + "等待用户批准计划后再开始执行。";
  return header + "按已批准的计划推进就绪阶段，可并行派发没有写域冲突的节点。";
}
