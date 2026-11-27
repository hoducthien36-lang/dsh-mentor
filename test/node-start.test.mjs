/**
 * mentor_node_start 测试（改造 s2-b）。
 *
 * 语义边界要钉死：它**只记进度**，不改变验收路径 —— 没 start 也能直接上报。
 * 但它仍然过 assertWritable，暂停/关闭导师时不能继续"开始"。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { PHASES } from "../src/state/machine.js";
import { gatedReport } from "./support/fixtures.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const STAGES = [
  { id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] },
  { id: "s2", title: "二", criterionIds: ["c1"], dependsOn: ["s1"] },
];

function activeStore() {
  const store = createMemoryStore();
  HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "node_start 测试" });
  const r = HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages: STAGES });
  assert.equal(r.ok, true, JSON.stringify(r));
  return store;
}

test("N1 记录就绪节点的 startedAt，phase 不变", () => {
  const store = activeStore();
  const before = store.get().phase;

  const r = HANDLERS.mentor_node_start(store, { stageId: "s1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.stageId, "s1");
  assert.equal(r.value.attempt, 1);
  assert.equal(typeof r.value.startedAt, "number");

  const run = store.get().nodeRuns.find((x) => x.stageId === "s1");
  assert.equal(run.status, "pending", "只记进度，不改节点状态");
  assert.equal(run.startedAttempt, 1);
  assert.equal(store.get().phase, before, "phase 不变");
});

test("N2 同一 attempt 重复开始幂等，不改时间戳", () => {
  const store = activeStore();
  const first = HANDLERS.mentor_node_start(store, { stageId: "s1" });
  const second = HANDLERS.mentor_node_start(store, { stageId: "s1" });

  assert.equal(second.ok, true);
  assert.equal(second.value.duplicate, true);
  assert.equal(second.value.startedAt, first.value.startedAt);
});

test("N3 非就绪节点被拒（前置阶段未 accepted）", () => {
  const store = activeStore();
  const r = HANDLERS.mentor_node_start(store, { stageId: "s2" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_DEP_NOT_READY");
  assert.deepEqual(r.details.readyNodes, ["s1"]);
});

test("N4 未知阶段报 E_STAGE_UNKNOWN 并列出已知阶段", () => {
  const store = activeStore();
  const r = HANDLERS.mentor_node_start(store, { stageId: "s9" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_STAGE_UNKNOWN");
  assert.deepEqual(r.details.knownStages, ["s1", "s2"]);
});

test("N5 attempt 与当前不符报 E_STALE_ATTEMPT", () => {
  const store = activeStore();
  HANDLERS.mentor_node_start(store, { stageId: "s1", attempt: 1 });
  const r = HANDLERS.mentor_node_start(store, { stageId: "s1", attempt: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_STALE_ATTEMPT");
});

test("N6 已上报的节点不能再「开始」", () => {
  const store = activeStore();
  HANDLERS.mentor_node_start(store, { stageId: "s1" });
  const rep = gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" });
  assert.equal(rep.ok, true, JSON.stringify(rep));

  const r = HANDLERS.mentor_node_start(store, { stageId: "s1" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_ILLEGAL_TRANSITION");
  assert.equal(r.details.status, "reported");
});

test("N7 暂停时拒绝：进度记录也是写操作", () => {
  const store = activeStore();
  assert.equal(HANDLERS.mentor_task_pause(store, {}).ok, true);
  const r = HANDLERS.mentor_node_start(store, { stageId: "s1" });
  assert.equal(r.ok, false);
  assert.equal(r.details.reason, "TASK_PAUSED");
});

test("N8 不记录也能直接上报（进度记录不是验收前置）", () => {
  const store = activeStore();
  const rep = gatedReport(store, { stageId: "s1", attempt: 1, evidence: "直接上报" });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  // 上报后进入待审：这条只证明「没 start 也能上报」，不涉及 phase 语义
  assert.equal(store.get().phase, PHASES.REVIEWING);
  const run = store.get().nodeRuns.find((x) => x.stageId === "s1");
  assert.equal(run.status, "reported");
  assert.equal(run.startedAt, undefined, "没调 node_start 就不该凭空有 startedAt");
});
