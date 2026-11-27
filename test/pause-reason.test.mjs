/**
 * 暂停原因分层测试（改造 s2，矩阵 G6）。
 *
 * 旧 supervisor 用 pauseReason 8 值枚举而不是自由文本，因为**恢复策略依赖它**
 * （`index.mjs:353-362`）。这里钉死：枚举校验、值落到任务上、面板可见、
 * resume 带回 resumedFrom、review-fault 给出明确提示。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { PAUSE_REASONS, isPauseReason, pauseReasonList } from "../src/state/machine.js";
import { computeNextStep } from "../src/state/guard.js";
import { buildStatePayload } from "../src/rpc/state.js";
import { PHASES } from "../src/state/machine.js";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const STAGES = [{ id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] }];

function activeStore() {
  const store = createMemoryStore();
  HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "暂停原因测试" });
  assert.equal(HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages: STAGES }).ok, true);
  return store;
}

test("P1 pauseReason 枚举是 8 个值，与旧实现同名", () => {
  const values = pauseReasonList().sort();
  assert.deepEqual(values, [
    "decision",
    "planning-stalled",
    "recovery-failed",
    "recovery-stalled",
    "restart",
    "review-fault",
    "supervisor-stopped",
    "user",
  ]);
  assert.equal(values.length, 8);
  assert.ok(isPauseReason("user"));
  assert.equal(isPauseReason("用户说了算"), false);
});

test("P2 缺省原因是 user，且 prePausePhase 记下原状态", () => {
  const store = activeStore();
  const r = HANDLERS.mentor_task_pause(store, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.pauseReason, PAUSE_REASONS.USER);
  assert.equal(r.value.prePausePhase, PHASES.ACTIVE);
  assert.equal(store.get().pauseReason, "user");
  assert.equal(typeof store.get().pausedAt, "number");
});

test("P3 非枚举原因被拒，并列出可用值（不静默降级成 user）", () => {
  const store = activeStore();
  const r = HANDLERS.mentor_task_pause(store, { reason: "我累了" });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "E_ILLEGAL_TRANSITION");
  assert.equal(r.details.reason, "我累了");
  assert.equal(r.details.allowed.length, 8);
  assert.equal(store.get().phase, PHASES.ACTIVE, "拒绝时不许改状态");
});

test("P4 nextStep 在 paused 下显示原因", () => {
  const store = activeStore();
  HANDLERS.mentor_task_pause(store, { reason: "decision" });
  const next = computeNextStep(store.get());
  assert.equal(next.code, "TASK_PAUSED");
  assert.ok(next.text.includes("decision"), next.text);
});

test("P5 面板 payload 暴露 pauseReason / pausedAt", () => {
  const store = activeStore();
  HANDLERS.mentor_task_pause(store, { reason: "restart" });
  const payload = buildStatePayload(store.get());
  assert.equal(payload.pauseReason, "restart");
  assert.equal(payload.paused, true);
  assert.equal(typeof payload.pausedAt, "number");
});

test("P6 resume 清空原因并带回 resumedFrom；review-fault 额外给提示", () => {
  const store = activeStore();
  HANDLERS.mentor_task_pause(store, { reason: "review-fault" });

  const resumed = HANDLERS.mentor_task_resume(store, {});
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.value.phase, PHASES.ACTIVE);
  assert.equal(resumed.value.resumedFrom, "review-fault");
  assert.ok(resumed.value.hint && resumed.value.hint.includes("mentor_review_retry"), JSON.stringify(resumed.value));
  assert.equal(store.get().pauseReason, null);
  assert.equal(store.get().pausedAt, null);
});

test("P7 非 review-fault 的 resume 不给多余提示", () => {
  const store = activeStore();
  HANDLERS.mentor_task_pause(store, { reason: "user" });
  const resumed = HANDLERS.mentor_task_resume(store, {});
  assert.equal(resumed.value.resumedFrom, "user");
  assert.equal(resumed.value.hint, null);
});
