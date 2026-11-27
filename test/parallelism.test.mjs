/**
 * 并行度分析测试（s2）。
 *
 * 核心断言：链式计划宽度=1；扇出计划宽度=N；循环依赖不炸也不误判；
 * 拆分建议只在「节点≥3 且宽度=1」时出现；reviewerHint 覆盖三档文案。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeParallelism,
  computeWaves,
  countCriticalPath,
  reviewerHint,
  suggestSplit,
} from "../src/plan/parallelism.js";

const chain = () => [
  { id: "s1" },
  { id: "s2", dependsOn: ["s1"] },
  { id: "s3", dependsOn: ["s2"] },
  { id: "s4", dependsOn: ["s3"] },
];

const fanout = () => [
  { id: "s1" },
  { id: "s2a", dependsOn: ["s1"] },
  { id: "s2b", dependsOn: ["s1"] },
  { id: "s2c", dependsOn: ["s1"] },
  { id: "s3", dependsOn: ["s2a", "s2b", "s2c"] },
];

/* --------------------------- 1. 分层 --------------------------- */

test("J1 链式计划分成 4 轮，每轮 1 个", () => {
  const { waves } = computeWaves(chain());
  assert.deepEqual(waves, [["s1"], ["s2"], ["s3"], ["s4"]]);
});

test("J2 扇出计划中间轮 3 个并行", () => {
  const { waves } = computeWaves(fanout());
  assert.deepEqual(waves, [["s1"], ["s2a", "s2b", "s2c"], ["s3"]]);
});

test("J3 无依赖的多个节点落在同一轮", () => {
  const { waves } = computeWaves([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(waves, [["a", "b", "c"]]);
});

test("J4 循环依赖不死循环，剩余节点进 leftover", () => {
  const { waves, leftover } = computeWaves([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ]);
  assert.deepEqual(waves, []);
  assert.deepEqual(leftover.sort(), ["a", "b"]);
});

test("J5 依赖指向计划外的节点时按未满足处理，节点进 leftover（不静默当已就绪）", () => {
  // v0.2.0 语义（src/plan/parallelism.js:30）：就绪条件是 dependsOn 里每个 id
  // 都存在于本计划且已完成（`byId.has(d) && done.has(d)`）。指向计划外的依赖
  // 永远满足不了 → 节点既不进任何一轮，也不会被当成「已就绪」放过去，
  // 而是留在 leftover 里等计划校验去报。
  const { waves, leftover } = computeWaves([{ id: "a", dependsOn: ["ghost"] }]);
  assert.deepEqual(waves, [], "依赖不存在 → 不能进首轮");
  assert.deepEqual(leftover, ["a"], "节点要留在 leftover，不能静默放行");
});

/* --------------------------- 2. 指标 --------------------------- */

test("J6 链式：maxWidth=1、轮数=4、可并行数=0", () => {
  const r = computeParallelism(chain());
  assert.equal(r.nodeCount, 4);
  assert.equal(r.maxWidth, 1);
  assert.equal(r.serialRounds, 4);
  assert.equal(r.criticalPathLength, 4);
  assert.equal(r.parallelizableCount, 0);
  assert.deepEqual(r.leftover, []);
});

test("J7 扇出：maxWidth=3、轮数=3、可并行数=2", () => {
  const r = computeParallelism(fanout());
  assert.equal(r.nodeCount, 5);
  assert.equal(r.maxWidth, 3);
  assert.equal(r.serialRounds, 3);
  assert.equal(r.parallelizableCount, 2);
});

test("J8 countCriticalPath 与 serialRounds 一致", () => {
  assert.equal(countCriticalPath(fanout()), computeParallelism(fanout()).serialRounds);
});

test("J9 空计划不炸：全 0", () => {
  const r = computeParallelism([]);
  assert.equal(r.nodeCount, 0);
  assert.equal(r.maxWidth, 0);
  assert.equal(r.serialRounds, 0);
});

/* --------------------------- 3. 拆分建议 --------------------------- */

test("J10 链式 4 节点 → 需要拆分，且给三条具体建议", () => {
  const s = suggestSplit(chain());
  assert.equal(s.needed, true);
  assert.equal(s.suggestions.length, 3);
  assert.match(s.reason, /宽度恒为 1/u);
});

test("J11 已有并行宽度 → 不建议拆", () => {
  const s = suggestSplit(fanout());
  assert.equal(s.needed, false);
  assert.match(s.reason, /宽度 3/u);
});

test("J12 少于 3 个节点 → 不建议拆（避免噪音）", () => {
  assert.equal(suggestSplit([{ id: "a" }, { id: "b", dependsOn: ["a"] }]).needed, false);
});

/* --------------------------- 4. reviewer 提示 --------------------------- */

test("J13 提示文案三档：单节点 / 有并行 / 完全串行", () => {
  assert.match(reviewerHint(computeParallelism([{ id: "s1" }])), /单节点/u);
  assert.match(reviewerHint(computeParallelism(fanout())), /最大宽度 3/u);
  assert.match(reviewerHint(computeParallelism(chain())), /完全串行/u);
  assert.match(reviewerHint(computeParallelism(chain())), /说明为何不能拆并行/u);
});
