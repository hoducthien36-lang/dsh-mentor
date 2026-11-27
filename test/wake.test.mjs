/**
 * 唤醒判定与消息构造测试（s2）。
 *
 * 覆盖六种不唤醒理由 + 唯一放行路径 + 消息格式 + 日志容量。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  WAKE_LOG_LIMIT,
  appendWakeDispatch,
  buildWakeMessage,
  countOpenFindings,
  shouldWake,
  wakeKey,
} from "../src/review/wake.js";

const task = (over = {}) => ({
  id: "task_x",
  mainSessionId: "session-abc",
  planVersion: 3,
  findings: [],
  wakeDispatches: [],
  ...over,
});

const ok = { stageId: "s3", attempt: 1, verdict: "revise" };

/* ------------------------- 1. 节流键 ------------------------- */

test("K1 wakeKey 用三元组，缺字段也能拼但会被 shouldWake 判 invalid", () => {
  assert.equal(wakeKey(ok), "s3/1/revise");
  assert.equal(wakeKey({ stageId: "s1", attempt: 2, verdict: "pass" }), "s1/2/pass");
  assert.equal(wakeKey({}), "//");
});

/* ------------------------- 2. 六种不放行 ------------------------- */

test("K2 正常情况放行，reason=ok", () => {
  assert.deepEqual(shouldWake(task(), ok), { wake: true, reason: "ok", key: "s3/1/revise" });
});

test("K3 开关关闭 → disabled（优先级最高）", () => {
  assert.equal(shouldWake(task(), { ...ok, enabled: false }).reason, "disabled");
  // 即便同时缺 mainSessionId 也先报 disabled
  assert.equal(shouldWake({}, { ...ok, enabled: false }).reason, "disabled");
});

test("K4 缺 mainSessionId（旧任务）→ no-main-session", () => {
  assert.equal(shouldWake({ findings: [] }, ok).reason, "no-main-session");
  assert.equal(shouldWake(task({ mainSessionId: "" }), ok).reason, "no-main-session");
});

test("K5 宿主无 agents → host-agents-unavailable", () => {
  assert.equal(shouldWake(task(), { ...ok, hasAgents: false }).reason, "host-agents-unavailable");
});

test("K6 会话已消失 → main-session-gone", () => {
  assert.equal(shouldWake(task(), { ...ok, sessionAlive: false }).reason, "main-session-gone");
});

test("K7 同三元组已投过 → duplicate；不同 verdict 不算重复", () => {
  const t = task({ wakeDispatches: [{ key: "s3/1/revise", queued: true }] });
  assert.equal(shouldWake(t, ok).reason, "duplicate");
  assert.equal(shouldWake(t, { ...ok, verdict: "pass" }).reason, "ok");
  assert.equal(shouldWake(t, { ...ok, attempt: 2 }).reason, "ok");
});

test("K8 字段缺失/非法 → invalid", () => {
  for (const bad of [
    { attempt: 1, verdict: "pass" },
    { stageId: "s1", verdict: "pass" },
    { stageId: "s1", attempt: 0, verdict: "pass" },
    { stageId: "s1", attempt: 1 },
  ]) {
    assert.equal(shouldWake(task(), bad).reason, "invalid", JSON.stringify(bad));
  }
});

/* ------------------------- 3. finding 计数 ------------------------- */

test("K9 只数未关闭的，按 blocking/advisory 分开", () => {
  const t = task({
    findings: [
      { id: "a", status: "open", severity: "blocking" },
      { id: "b", status: "responded", severity: "blocking" },
      { id: "c", status: "closed", severity: "blocking" },
      { id: "d", status: "open", severity: "advisory" },
      { id: "e", status: "open" }, // 缺 severity 按 blocking
    ],
  });
  assert.deepEqual(countOpenFindings(t), { total: 4, blocking: 3, advisory: 1 });
  assert.deepEqual(countOpenFindings({}), { total: 0, blocking: 0, advisory: 0 });
});

/* ------------------------- 4. 消息格式 ------------------------- */

test("K10 revise 消息含阶段/attempt/verdict/计数/planVersion，且不含强制提交措辞", () => {
  const t = task({
    findings: [{ id: "a", status: "open", severity: "blocking" }],
  });
  const msg = buildWakeMessage({ ...ok, planVersion: 3 }, t);

  assert.match(msg, /^\[mentor\] 阶段 s3（attempt 1）审查完成：revise/u);
  assert.match(msg, /未解决 finding：1 条（blocking 1 \/ advisory 0）/u);
  assert.match(msg, /mentor_finding_respond/u);
  assert.match(msg, /planVersion：3/u);
  // 防自激：不得出现强制立即提交字样
  assert.doesNotMatch(msg, /立即提交|马上重报|自动提交/u);
});

test("K11 pass 消息的下一步指向推进下一个节点，不写重报", () => {
  const msg = buildWakeMessage({ ...ok, verdict: "pass", planVersion: 3 }, task());
  assert.match(msg, /已通过，可推进下一个就绪节点/u);
  assert.doesNotMatch(msg, /重报/u);
});

test("K12 缺 planVersion 时消息不炸（回退到任务或 ?）", () => {
  const a = buildWakeMessage({ ...ok }, task({ planVersion: 7 }));
  assert.match(a, /planVersion：7/u);
  const b = buildWakeMessage({ ...ok });
  assert.match(b, /planVersion：\?/u);
});

/* ------------------------- 5. 日志容量 ------------------------- */

test("K13 wakeDispatches 只保留最近 WAKE_LOG_LIMIT 条", () => {
  let t = task();
  for (let i = 1; i <= WAKE_LOG_LIMIT + 5; i += 1) {
    t = { ...t, wakeDispatches: appendWakeDispatch(t, { key: `s1/${i}/revise`, queued: true }) };
  }
  assert.equal(t.wakeDispatches.length, WAKE_LOG_LIMIT);
  assert.equal(t.wakeDispatches.at(-1).key, `s1/${WAKE_LOG_LIMIT + 5}/revise`);
  assert.equal(WAKE_LOG_LIMIT, 20);
});
