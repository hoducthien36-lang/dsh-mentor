/**
 * phase 的唯一写入口（契约见 test/contract-state-machine.test.mjs 的 T3）。
 *
 * 为什么要有这个模块：状态机（`src/state/machine.js`）定义了合法转移表，
 * 但历史上很多地方直接 `store.set({ ...task, phase })` 把它绕过去了 ——
 * 检查点路径因此在真实链路上制造了转移表里根本不存在的边
 * （`awaiting-approval → reviewing`、`reviewing → planning`），
 * 每次 `plan_submit` 都会发生一次。
 *
 * 本模块把「改 phase」收敛成一步：
 *   1. `transition()` 先断言目标边合法，并 revision+1；
 *   2. `store.set(next, { phaseWriter: true })` 让 store 知道这次变更是授权的。
 *
 * 任何绕过本模块的 phase 变更都会被 store 以 `E_PHASE_WRITE_BYPASS` 拒绝
 * （见 `src/tools/handlers.js` 的 createMemoryStore；包装 store 负责透传 meta）。
 *
 * 设计边界：只依赖 machine + errors，不 import handlers（避免循环依赖）。
 */

import { PHASES, isPhase, transition } from "../state/machine.js";
import { ERR, MentorError } from "../errors.js";

/**
 * store 只认这个标记。
 *
 * 用一次性冻结对象而不是可伪造的字符串：调用方必须拿到同一个引用，
 * 随手 `{ phaseWriter: true }` 也等价 —— 真正拦住的是「完全没走 setPhase」的写入，
 * 而不是防恶意代码（同进程内本就无所谓恶意）。
 */
export const PHASE_WRITE_FLAG = Object.freeze({ phaseWriter: true });

/**
 * 变更当前任务的 phase。
 *
 * @param {{get:Function,set:Function}} store 任何带 get/set 的 store（内存/持久化/代理都行）
 * @param {string} to 目标 phase
 * @param {object} [patch] 同一次转移要合并的字段（revision/updatedAt 由 transition 负责）
 * @returns {object} 新的任务对象
 * @throws {MentorError} E_NO_TASK（无任务）/ E_ILLEGAL_TRANSITION（转移表不允许）
 */
export function setPhase(store, to, patch = {}) {
  const task = store?.get?.();
  if (!task) {
    throw new MentorError(ERR.NO_TASK, "当前没有任务，不能变更 phase", { to: to ?? null });
  }
  const next = transition(task, to, patch);
  store.set(next, PHASE_WRITE_FLAG);
  return next;
}

/**
 * 人工撤销归档专用写入口（保持 archived 在常规状态机里仍是无出边终态，
 * 只有显式人工恢复命令才能经本入口带 PHASE_WRITE_FLAG 恢复）。
 */
export function restorePhase(store, to, patch = {}) {
  const task = store?.get?.();
  if (!task) {
    throw new MentorError(ERR.NO_TASK, "当前没有任务，无法恢复归档");
  }
  if (task.phase !== PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, `只有已归档任务才能撤销归档，当前是 ${task.phase}`, {
      phase: task.phase,
    });
  }
  if (!isPhase(to) || to === PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, `无效的恢复目标阶段：${String(to)}`, { to: to ?? null });
  }
  const next = {
    ...task,
    ...patch,
    phase: to,
    revision: (task.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  store.set(next, PHASE_WRITE_FLAG);
  return next;
}
