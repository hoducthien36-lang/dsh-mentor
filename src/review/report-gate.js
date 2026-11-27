/**
 * 报告提交门禁（SPEC §2.6 门槛二）。
 *
 * 治的是本会话里反复出现的第二种返工：旧账不清理 + 版本错位。
 *   · 旧账：任务里还有 open 且从未响应的 finding 时，不允许提交新的阶段报告。
 *     「每轮只修最新几条」在机制上走不通 —— 不响应旧账就交不上去。
 *   · 版本：报告必须声明它依据的 planVersion；缺失或不等于当前版本一律拒收。
 *     这样「计划改了、报告还引用旧内容」不可能静默通过。
 *
 * 设计边界：纯函数，只读 task 对象，不 import DSH、不写库。
 */

import { MentorError, assertOrThrow } from "../errors.js";

/**
 * 本模块的错误码（SPEC §3 已登记）。
 * 与 evidence-check 同样理由：`src/errors.js` 属接线阶段写域，本阶段用本地常量，
 * s4 接线时再并入 `ERR`。
 */
export const GATE_CODE = Object.freeze({
  UNRESPONDED_FINDINGS: "E_UNRESPONDED_FINDINGS",
  STALE_PLAN: "E_STALE_PLAN",
});

/**
 * 列出「open 且从未响应」的 finding —— 这些是必须先清掉的旧账。
 *
 * 语义要点：
 *   · `responded`（已响应、未复核）**不算**旧账：响应了就允许继续推进，
 *     关闭仍由后续 pass 复核决定，与 SPEC §2.4 一致。
 *   · `closed` 不算。
 *   · 历史数据里 `responses` 可能缺省，按「未响应」处理（保守）。
 *
 * @param {{findings?: Array<object>}} task
 * @returns {Array<{id:string, severity:string, text:string}>}
 */
export function unrespondedFindings(task) {
  const findings = Array.isArray(task?.findings) ? task.findings : [];
  return findings
    .filter((f) => f && f.status === "open")
    .filter((f) => !Array.isArray(f.responses) || f.responses.length === 0)
    .map((f) => ({
      id: f.id,
      severity: f.severity ?? "blocking",
      text: typeof f.text === "string" ? f.text : "",
    }));
}

/**
 * 门禁主函数：不通过就抛结构化错误，通过则返回一份可读的放行摘要。
 *
 * @param {object} task 当前任务
 * @param {{planVersion?: number}} [options]
 * @returns {{ok:true, planVersion:number, respondedUnverified:number}}
 */
export function assertReportAllowed(task, options = {}) {
  assertOrThrow(
    task && typeof task === "object",
    GATE_CODE.STALE_PLAN,
    "当前没有任务，无法校验报告门槛",
    { expected: null, got: options.planVersion ?? null },
  );

  // ---- 门槛一：旧账 ----
  const unresponded = unrespondedFindings(task).filter(f => f.severity === "blocking" && (!options.stageId || task.findings.find(item => item.id === f.id)?.stageId === options.stageId));
  if (unresponded.length > 0) {
    throw new MentorError(
      GATE_CODE.UNRESPONDED_FINDINGS,
      `还有 ${unresponded.length} 条整改项从未响应，先用 mentor_finding_respond 逐条响应再提交报告`,
      {
        findingIds: unresponded.map((f) => f.id),
        items: unresponded,
      },
    );
  }

  // ---- 门槛二：计划版本 ----
  const expected = task.planVersion;
  const got = options.planVersion;

  assertOrThrow(
    Number.isInteger(got) && got >= 1,
    GATE_CODE.STALE_PLAN,
    "提交阶段报告必须声明所依据的 planVersion（正整数）",
    { expected: expected ?? null, got: got ?? null },
  );

  assertOrThrow(
    Number.isInteger(expected) && expected >= 1,
    GATE_CODE.STALE_PLAN,
    "当前任务没有可用的 planVersion，先 mentor_plan_submit",
    { expected: expected ?? null, got },
  );

  if (got !== expected) {
    throw new MentorError(
      GATE_CODE.STALE_PLAN,
      `报告依据的 planVersion 是 ${got}，当前计划已是 v${expected}；请按当前计划重写证据后再报`,
      { expected, got },
    );
  }

  const respondedUnverified = (Array.isArray(task.findings) ? task.findings : []).filter(
    (f) => f && f.status === "responded",
  ).length;

  return { ok: true, planVersion: expected, respondedUnverified };
}
