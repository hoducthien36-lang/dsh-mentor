/**
 * 并行接线测试（s3）。
 *
 * 测的是「校验 → 置 running → 回执 → awaiting-integration / 回退」这条链路，
 * 以及 plan_submit 返回的并行度报告。真正的子 Agent 派发在 lib/index.js（要 ctx.agents），
 * 本测试不碰宿主，只保证状态机与错误码是对的。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryStore,
  delegateNodes,
  completeDelegation,
  planSubmit,
  taskCreate,
} from "../src/tools/handlers.js";
import { ERR } from "../src/errors.js";
import { PHASES } from "../src/state/machine.js";
import { toPhase } from "./support/fixtures.mjs";
import path from "node:path";

/** handlers.taskCreate 自 v0.2.0 起要求显式 workspaceRoot（证据校验拿它做路径逃逸边界） */
const ROOT = path.resolve(import.meta.dirname, "..");

const PLAN = {
  criteria: [{ id: "c1", text: "一条" }],
  stages: [
    { id: "s1", title: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["src/a.js"] },
    { id: "s2", title: "b", criterionIds: ["c1"], dependsOn: [], writePaths: ["src/b.js"] },
    { id: "s3", title: "c", criterionIds: ["c1"], dependsOn: ["s1"], writePaths: ["src/c.js"] },
  ],
};

/**
 * 造一个「计划已通过审查、可以派发」的任务。
 *
 * v0.2.0 起 planSubmit 直接把任务推进到 reviewing 等独立审查，不再停在 active；
 * 而 delegateNodes 要求 phase===active 且 approvedPlanVersion===planVersion
 * （与 lib/index.js:689 同一道门禁）。本文件测的是「校验 → 置 running → 回执 → 回退」
 * 这条并行链路，不是审查流程本身，所以这里直接把「审查已通过」的状态铺好 ——
 * 字段与 lib/index.js 在 plan 审查 pass 后写入的一致。
 */
function withPlan() {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "并行接线测试" });
  const plan = planSubmit(store, PLAN);
  const t = store.get();
  store.set({
    ...t,
    phase: PHASES.ACTIVE,
    approvedPlanVersion: plan.value.planVersion,
    pendingCheckpoint: null,
  });
  return store;
}

/* ------------------------- 1. 派发校验 ------------------------- */

test("W1 派发两个就绪且写域不相交的节点 → 都置 running 并返回 dispatchPlan", () => {
  const store = withPlan();
  const r = delegateNodes(store, { stageIds: ["s1", "s2"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.stageIds.length, 2);
  assert.equal(r.value.maxParallel, 8, "缺省取配置的 maxParallelNodes（src/tools/parallel.js:16 的 DEFAULT_MAX_PARALLEL 是 8）");

  const runs = store.get().nodeRuns.filter((x) => ["s1", "s2"].includes(x.stageId));
  assert.deepEqual(runs.map((x) => x.status), ["running", "running"]);
  assert.equal(r.value.dispatchPlan.length, 2);
  assert.deepEqual(r.value.dispatchPlan[0].writePaths, ["src/a.js"]);
});

test("W2 超过并发上限 → E_PARALLEL_LIMIT", () => {
  const store = withPlan();
  const r = delegateNodes(store, { stageIds: ["s1", "s2"], maxParallel: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.PARALLEL_LIMIT);
  assert.equal(r.details.limit, 1);
});

test("W3 写域重叠 → E_WRITE_CONFLICT 且带冲突对", () => {
  // 注意：合法计划在 plan 层就会被 dag 的写域校验拦掉，所以「批内冲突」这个场景
  // 只能来自历史/导入状态。这里直接构造任务，模拟那种状态。
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "冲突" });
  const base = store.get();
  store.set({
    ...base,
    planVersion: 1,
    criteria: [{ id: "c1", text: "一" }],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["lib/index.js"] },
      { id: "b", criterionIds: ["c1"], dependsOn: [], writePaths: ["lib/index.js"] },
    ],
    nodeRuns: [
      { id: "a", stageId: "a", attempt: 1, status: "pending", reports: [] },
      { id: "b", stageId: "b", attempt: 1, status: "pending", reports: [] },
    ],
  });
  // 2026-11-09：phase 变更走合法边（planning → active），不再混在裸 store.set 里。
  toPhase(store, PHASES.ACTIVE);
  const r = delegateNodes(store, { stageIds: ["a", "b"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.WRITE_CONFLICT);
  assert.equal(r.details.conflicts.length, 1);
});

test("W4 未就绪节点 → E_DELEGATION_INVALID 且列 notReady", () => {
  const store = withPlan();
  const r = delegateNodes(store, { stageIds: ["s3"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.DELEGATION_INVALID);
  assert.deepEqual(r.details.notReady, ["s3"]);
});

test("W5 空数组 / 重复 id → E_DELEGATION_INVALID", () => {
  const store = withPlan();
  assert.equal(delegateNodes(store, { stageIds: [] }).code, ERR.DELEGATION_INVALID);
  assert.equal(delegateNodes(store, { stageIds: ["s1", "s1"] }).code, ERR.DELEGATION_INVALID);
});

test("W6 计划未完成（planning）阶段拒绝派发", () => {
  const store = withPlan();
  // v0.2.0 的 delegateNodes 允许 active 与 reviewing 两种 phase（见 src/tools/handlers.js 的
  // delegateNodes 前置 `![PHASES.ACTIVE, PHASES.REVIEWING].includes(task.phase)`），
  // 所以旧用例设 reviewing 当然不会被拒。真正该拒的是 planning：计划还没提交，没有可派的节点。
  // 2026-11-09：active → planning 在转移表里没有直连，用法定路径 active→paused→planning。
  toPhase(store, PHASES.PLANNING);
  const r = delegateNodes(store, { stageIds: ["s1"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
});

/* ------------------------- 2. 回执与回退 ------------------------- */

test("W7 全部 worker 成功 → 节点置 awaiting-integration，任务仍 active", () => {
  const store = withPlan();
  const d = delegateNodes(store, { stageIds: ["s1", "s2"] });
  const r = completeDelegation(store, { batchId: d.value.batchId, planVersion: store.get().planVersion,
    results: [
      { stageId: "s1", attempt: 1, ok: true, report: "改完 a" },
      { stageId: "s2", attempt: 1, ok: true, report: "改完 b" },
    ],
  });
  assert.equal(r.ok, true);
  const runs = store.get().nodeRuns.filter((x) => ["s1", "s2"].includes(x.stageId));
  assert.deepEqual(runs.map((x) => x.status), ["awaiting-integration", "awaiting-integration"]);
  assert.equal(store.get().phase, PHASES.ACTIVE);
  assert.equal(runs[0].workerReport, "改完 a");
});

test("W8 部分失败 → 失败节点进 rework，成功的置 awaiting-integration", () => {
  const store = withPlan();
  const d = delegateNodes(store, { stageIds: ["s1", "s2"] });
  const r = completeDelegation(store, { batchId: d.value.batchId, planVersion: store.get().planVersion,
    results: [
      { stageId: "s1", attempt: 1, ok: true, report: "好了" },
      { stageId: "s2", attempt: 1, ok: false, reason: "worker-failed: boom" },
    ],
  });
  // guard 把结果包成 {ok:true, value}，批量是否全部成功看 value.ok
  assert.equal(r.ok, true, "调用本身成功");
  assert.equal(r.value.ok, false, "批次未全部成功");
  assert.equal(r.value.point, "R4");
  const s1 = store.get().nodeRuns.find((x) => x.stageId === "s1");
  const s2 = store.get().nodeRuns.find((x) => x.stageId === "s2");
  assert.equal(s1.status, "awaiting-integration");
  assert.equal(s2.status, "rework", "v0.2.0 用 rework 表示需要返工的节点");
  assert.equal(s2.failedReason, "worker-failed: boom");
});

test("W9 worker 跑完但校验失败（有 report 仍 ok:false）→ R5：暂停任务且不自动重试", () => {
  const store = withPlan();
  const d = delegateNodes(store, { stageIds: ["s1"] });
  const r = completeDelegation(store, { batchId: d.value.batchId, planVersion: store.get().planVersion,
    results: [{ stageId: "s1", attempt: 1, ok: false, report: "我跑完了，但没通过校验" }],
  });
  assert.equal(r.value.point, "R5");
  assert.equal(store.get().phase, PHASES.PAUSED);
  assert.equal(store.get().pauseReason, "recovery-failed");
});

/* ------------------------- 3. 并行度报告 ------------------------- */

test("W10 plan_submit 返回 parallelism 与 split（扇出计划有并行轮次，不建议拆）", () => {
  // 全新 store 只提交一次：已 active 的任务不能重复 plan_submit
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "并行度" });
  const r = planSubmit(store, PLAN);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.parallelism.maxWidth, 2, "s1/s2 同轮可并行");
  assert.equal(r.value.parallelism.serialRounds, 2);
  assert.equal(r.value.split.needed, false);
});

test("W11 全串行计划 → split.needed=true 且给建议", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "全串行" });
  const r = planSubmit(store, {
    criteria: [{ id: "c1", text: "一" }],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [] },
      { id: "b", criterionIds: ["c1"], dependsOn: ["a"] },
      { id: "c", criterionIds: ["c1"], dependsOn: ["b"] },
    ],
  });
  assert.equal(r.value.parallelism.maxWidth, 1);
  assert.equal(r.value.split.needed, true);
  assert.equal(r.value.split.suggestions.length, 3);
});
