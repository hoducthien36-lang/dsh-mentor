/**
 * mainSessionId 落库测试（s3）。
 *
 * 为什么要单独测：唤醒机制能不能工作，取决于"任务上有没有记着谁在推它"。
 * 这个字段由工具层注入（exec.agent.session.id），模型不填；
 * 旧任务没有该字段时必须安静降级，不能抛错。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore, taskCreate, taskStatus } from "../src/tools/handlers.js";
import { buildStatePayload } from "../src/rpc/state.js";
import { shouldWake } from "../src/review/wake.js";
import { toPhase } from "./support/fixtures.mjs";
import path from "node:path";

/** s3：v0.2.0 起 handlers.taskCreate 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。
 *  这里统一给测试一个项目根，避免每条用例各自硬编码。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const SESSION = "session-7500a91f-deadbeef";

/* ------------------------- 1. 落库 ------------------------- */

test("M1 建任务时带 mainSessionId → 落到任务上，状态与 payload 都能读到", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "落库", mainSessionId: SESSION });

  assert.equal(store.get().mainSessionId, SESSION);

  const status = taskStatus(store, {});
  assert.equal(status.ok, true);
  assert.equal(status.value.mainSessionId, SESSION);

  const payload = buildStatePayload(store.get());
  assert.equal(payload.mainSessionId, SESSION);
});

test("M2 不传 mainSessionId → 任务上没有该字段（不是空字符串）", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "不传" });
  assert.equal(store.get().mainSessionId, undefined);
  // payload 层统一给 null，方便前端判空
  assert.equal(buildStatePayload(store.get()).mainSessionId, null);
});

test("M3 空字符串 / 非字符串一律忽略，不写入脏值", () => {
  for (const bad of ["", 123, null, undefined, {}]) {
    const store = createMemoryStore();
    taskCreate(store, { workspaceRoot: ROOT, objective: `bad-${String(bad)}`, mainSessionId: bad });
    assert.equal(store.get().mainSessionId, undefined, `mainSessionId=${String(bad)} 不该落库`);
  }
});

/* ------------------------- 2. 旧任务兼容 ------------------------- */

test("M4 旧任务（无 mainSessionId）读状态不报错，payload 给 null", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "旧任务" });
  const task = { ...store.get() };
  delete task.mainSessionId;
  store.set(task);

  const status = taskStatus(store, {});
  assert.equal(status.ok, true);
  assert.equal(status.value.mainSessionId, null);
  assert.equal(buildStatePayload(store.get()).mainSessionId, null);
});

test("M5 旧任务参与唤醒判定时降级为 no-main-session，而不是抛错", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "旧任务" });
  const task = { ...store.get() };
  delete task.mainSessionId;

  const verdict = shouldWake(task, { stageId: "s1", attempt: 1, verdict: "revise" });
  assert.equal(verdict.wake, false);
  assert.equal(verdict.reason, "no-main-session");
});

/* ------------------------- 3. 与唤醒判定衔接 ------------------------- */

test("M6 新任务带 mainSessionId 时，唤醒判定可放行", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "可唤醒", mainSessionId: SESSION });
  const verdict = shouldWake(store.get(), { stageId: "s1", attempt: 1, verdict: "pass" });
  assert.equal(verdict.wake, true);
  assert.equal(verdict.key, "s1/1/pass");
});

test("M7 替换旧任务（completed/archived）后，新任务的 mainSessionId 是新的", () => {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "第一", mainSessionId: "session-old" });
  // 2026-11-09：phase 变更走合法边（planning → archived）
  toPhase(store, "archived");
  taskCreate(store, { workspaceRoot: ROOT, objective: "第二", mainSessionId: "session-new" });
  assert.equal(store.get().mainSessionId, "session-new");
});
