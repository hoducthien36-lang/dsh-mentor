import { findWriteConflicts, normalizeMaxParallel } from "../tools/parallel.js";

/**
 * 并行度分析（纯函数，不依赖 DSH）。
 *
 * 为什么需要它：并行上限再高也受计划形状限制 —— s1→s2→s3→s4 这种链式计划，
 * 上限 16 也只能同时跑 1 个。所以把「计划能不能并行」变成提交计划时就能看到的数字，
 * 而不是执行时的体感。
 *
 * 输出：波浪分层（waves）、最大并行宽度（maxWidth）、关键路径长度、
 * 串行轮数、本可并行却被串起来的节点数，以及针对宽度=1 计划的拆分建议。
 */

/**
 * @typedef {{id:string, dependsOn?:string[], writePaths?:string[]}} Stage
 */

/** 按 dependsOn 做拓扑分层：第 n 层 = 前 n-1 层全部就绪后才能开始的节点 */
export function computeWaves(stages) {
  const list = Array.isArray(stages) ? stages : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const done = new Set();
  const waves = [];
  let guard = 0;

  while (done.size < list.length && guard <= list.length + 1) {
    guard += 1;
    const layer = list
      .filter((s) => !done.has(s.id))
      .filter((s) => (s.dependsOn ?? []).every((d) => byId.has(d) && done.has(d)))
      .map((s) => s.id);
    if (layer.length === 0) break; // 有环或依赖缺失，剩余节点不参与分层
    for (const id of layer) done.add(id);
    waves.push(layer);
  }

  return { waves, leftover: list.filter((s) => !done.has(s.id)).map((s) => s.id) };
}

/** 关键路径长度（这里取分层轮数：每轮只能等上一轮全部结束） */
export function countCriticalPath(stages) {
  return computeWaves(stages).waves.length;
}

/**
 * 并行度总报告。
 *
 * @param {Stage[]} stages
 * @returns {{maxWidth:number, waves:string[][], criticalPathLength:number, serialRounds:number, parallelizableCount:number, nodeCount:number, leftover:string[]}}
 */
export function computeParallelism(stages, options = {}) {
  const list = Array.isArray(stages) ? stages : [];
  const { waves, leftover } = computeWaves(list);
  const maxWidth = waves.reduce((m, w) => Math.max(m, w.length), 0);
  const serialRounds = waves.length;

  // 本可并行却被串起来：分层里宽度>1 的轮次带来的「本可同时」机会，
  // 用「节点数 - 轮数」衡量 —— 差越大说明并行被利用得越多。
  const parallelizableCount = Math.max(0, list.length - serialRounds);

  const schedule = executionWaves(list, options.maxParallel);
  return {
    executionWaves: schedule.waves,
    usableParallelism: schedule.maxWidth,
    executionRounds: schedule.waves.length,
    maxParallel: schedule.maxParallel,
    writeConflicts: findWriteConflicts(list),
    nodeCount: list.length,
    maxWidth,
    waves,
    criticalPathLength: waves.length,
    serialRounds,
    parallelizableCount,
    leftover,
  };
}

/**
 * 拆分建议：只在「节点 ≥3 且当前宽度 =1」时给，避免噪音。
 *
 * @param {Stage[]} stages
 * @param {ReturnType<typeof computeParallelism>} [report] 可传入已算好的报告
 * @returns {{needed:boolean, reason:string, suggestions:string[]}}
 */
export function suggestSplit(stages, report) {
  const list = Array.isArray(stages) ? stages : [];
  const r = report ?? computeParallelism(list);

  if (list.length < 3) {
    return { needed: false, reason: "节点少于 3 个，拆并行没有收益", suggestions: [] };
  }
  if (r.maxWidth > 1) {
    return { needed: false, reason: `当前已有宽度 ${r.maxWidth} 的并行轮次`, suggestions: [] };
  }

  const suggestions = [
    "按文件粒度拆：把同一阶段要改的多个互不相干的文件拆成多个节点，各自声明 writePaths，可同轮并发。",
    "按三分类拆：设计 / 实现 / 回归 三类里，同一类内部的独立项可以并行，跨类保持依赖。",
    "逐条说明依赖：只保留确实需要前序产物的边；独立调查、不同文件实现可并行，最后单列集成节点。不能为了凑并发移除真实依赖。",
  ];

  return {
    needed: true,
    reason: `${list.length} 个节点的计划宽度恒为 1（完全串行）`,
    suggestions,
  };
}

/** 生成写进 reviewer 提示的一句话，让规划期审查必须看并行度 */
export function reviewerHint(report) {
  const r = report ?? { maxWidth: 0, serialRounds: 0, nodeCount: 0 };
  if (r.nodeCount <= 1) return "单节点计划，无需评估并行度。";
  if (r.maxWidth > 1) {
    return `并行度：${r.nodeCount} 节点 / ${r.serialRounds} 轮 / 最大宽度 ${r.maxWidth}（存在并行轮次）。`;
  }
  return `并行度：${r.nodeCount} 节点 / ${r.serialRounds} 轮 / 最大宽度 1（完全串行）——请要求作者说明为何不能拆并行。`;
}

/** 在已声明依赖、写域和并发上限内计算可执行批次，不修改用户计划。 */
export function executionWaves(stages, maxParallel) {
  const limit = normalizeMaxParallel(maxParallel);
  const list = Array.isArray(stages) ? stages : [];
  const done = new Set();
  const waves = [];
  while (done.size < list.length) {
    const candidates = list.filter((stage) => !done.has(stage.id) &&
      (stage.dependsOn ?? []).every((dependency) => done.has(dependency)));
    const selected = [];
    for (const stage of candidates) {
      if (selected.length >= limit) break;
      if (!findWriteConflicts([...selected, stage]).length) selected.push(stage);
    }
    if (!selected.length) break;
    waves.push(selected.map((stage) => stage.id));
    selected.forEach((stage) => done.add(stage.id));
  }
  return { waves, maxParallel: limit, maxWidth: Math.max(0, ...waves.map((wave) => wave.length)),
    leftover: list.filter((stage) => !done.has(stage.id)).map((stage) => stage.id) };
}

/** 根据当前状态推荐一个无写冲突的派发批次；真实准入仍由 handler 校验。 */
export function recommendParallelBatch(stages, readyNodeIds, runningNodeIds = [], maxParallel) {
  const limit = normalizeMaxParallel(maxParallel);
  const ready = new Set(readyNodeIds ?? []);
  const running = new Set(runningNodeIds ?? []);
  const active = (stages ?? []).filter((stage) => running.has(stage.id));
  const selected = [];
  for (const stage of stages ?? []) {
    if (!ready.has(stage.id) || running.has(stage.id)) continue;
    if (selected.length >= Math.max(0, limit - active.length)) break;
    if (!findWriteConflicts([...active, ...selected, stage]).length) selected.push(stage);
  }
  return { stageIds: selected.map((stage) => stage.id), activeCount: active.length,
    maxParallel: limit, availableSlots: Math.max(0, limit - active.length) };
}
