/**
 * 测试共用夹具（2026-11-09 状态机单一写入口改造配套）。
 *
 * 两件东西：
 *   1. `gatedReport(store, params)` —— 走 `HANDLERS.mentor_stage_report` 的真实门禁路径，
 *      自动补 planVersion 与一条逐字命中的 evidenceRefs（`package.json` 第 2 行）。
 *      以前测试直调 HANDLERS 时门禁是旁路，现在门禁就是 HANDLERS 本身，
 *      所以这里只补参数，不放宽任何断言。
 *   2. `toPhase(store, target)` —— 用**合法边**把任务推到目标 phase，
 *      替代测试里 `store.set({ ...task, phase })` 的旧写法（那种写法已被
 *      E_PHASE_WRITE_BYPASS 拒绝）。
 */

import { allowedNext } from "../../src/state/machine.js";
import { setPhase } from "../../src/runtime/phase-writer.js";
import { stageReportGated } from "../../src/tools/handlers.js";

/** 逐字命中 E:\caten\projects\dsh-mentor-clean-room\package.json 的第 2 行 */
export const EVIDENCE_REF = Object.freeze({
  file: "package.json",
  line: 2,
  snippet: '"name": "dsh-mentor",',
});

export function gatedReport(store, params = {}) {
  const task = store.get();
  return stageReportGated(store, {
    planVersion: task?.planVersion,
    evidenceRefs: [EVIDENCE_REF],
    ...params,
  });
}

/** 在转移表上求 from→target 的最短路径（不含自环；走不到返回 null） */
function shortestPath(from, target) {
  if (from === target) return [];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of allowedNext(cur)) {
      if (next === cur || prev.has(next)) continue;
      prev.set(next, cur);
      if (next === target) {
        const path = [next];
        let node = cur;
        while (node !== null && node !== from) {
          path.unshift(node);
          node = prev.get(node);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * 用合法转移把当前任务推到 target phase。
 *
 * @param {{get:Function}} store
 * @param {string} target
 * @returns {object} 目标状态的任务
 */
export function toPhase(store, target) {
  const path = shortestPath(store.get()?.phase, target);
  if (!path) throw new Error(`toPhase: ${store.get()?.phase} → ${target} 没有合法路径`);
  for (const hop of path) setPhase(store, hop);
  return store.get();
}
