/**
 * reviewing 状态下的 nextStep（真机反馈修）—— 「看不到进度」的根因之一。
 *
 * 原来 reviewing 一律回「等待裁决」，pass 之后节点已 accepted 也照旧，
 * 于是状态条永远显示「导师审查中」。这里按「最近裁决 + 就绪节点」钉三种情况。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { computeNextStep } from "../src/state/guard.js";
import { PHASES } from "../src/state/machine.js";
import { gatedReport } from "./support/fixtures.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const TWO = [
  { id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] },
  { id: "s2", title: "二", criterionIds: ["c1"], dependsOn: ["s1"] },
];
const ONE = [{ id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] }];

function storeWith(stages) {
  const store = createMemoryStore();
  assert.equal(HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "nextStep 测试" }).ok, true);
  assert.equal(HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages }).ok, true);
  return store;
}

test("Q1 reviewing + 无裁决 → 等待裁决", () => {
  const store = storeWith(TWO);
  assert.equal(gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" }).ok, true);
  assert.equal(store.get().phase, PHASES.REVIEWING);

  const next = computeNextStep(store.get());
  assert.equal(next.code, "REVIEW_IN_PROGRESS", next.text);
});

test("Q2 reviewing + pass + 还有就绪节点 → REVIEW_PASSED 并点名节点", () => {
  const store = storeWith(TWO);
  gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" });
  const reviewed = HANDLERS.mentor_review_apply(store, {
    stageId: "s1",
    attempt: 1,
    verdict: "pass",
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(store.get().phase, PHASES.REVIEWING, "pass 后 phase 仍留 reviewing（completion 需要）");

  const next = computeNextStep(store.get());
  assert.equal(next.code, "REVIEW_PASSED", next.text);
  assert.ok(next.text.includes("s2"), `下一步要点名 s2：${next.text}`);
  assert.ok(next.allowedActions.includes("mentor_stage_report"));
});

test("Q3 reviewing + pass + 全部 accepted → READY_TO_COMPLETE", () => {
  const store = storeWith(ONE);
  gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" });
  assert.equal(HANDLERS.mentor_review_apply(store, { stageId: "s1", attempt: 1, verdict: "pass" }).ok, true);

  const next = computeNextStep(store.get());
  assert.equal(next.code, "READY_TO_COMPLETE", next.text);
  assert.ok(next.allowedActions.includes("mentor_completion_request"));
});

test("Q4 状态条的下一步与 buildStatePayload 一致（面板读的就是它）", async () => {
  const { buildStatePayload } = await import("../src/rpc/state.js");
  const store = storeWith(TWO);
  gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" });
  HANDLERS.mentor_review_apply(store, { stageId: "s1", attempt: 1, verdict: "pass" });

  const payload = buildStatePayload(store.get());
  assert.equal(payload.nextStep.code, "REVIEW_PASSED");
  assert.deepEqual(payload.readyNodes, ["s2"]);
});
