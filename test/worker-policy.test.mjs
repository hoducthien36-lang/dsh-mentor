/**
 * worker 越界工具策略与运行时看门狗的回归测试（12 条）。
 *
 * 锁的是 P1-1：`restrictMentorChild` 在 allow 全为内置工具时降级成
 * `mode="builtin-unrestricted"`，worker 实际拿到全量工具（含 bash / 团队工具 / ego_* / mcp__*），
 * 只剩 prompt 约束。判定逻辑在 src/review/worker-policy.js，接线在 lib/index.js 的 dispatchWorkers。
 *
 * 三组：
 *   W  名单一致性（哪些必须拦、哪些必须放）
 *   S  事件扫描（注入 events 数组，不碰宿主）
 *   R  运行时接线（注入 fake getEvents / record / abort，验到「标记中止」这一步）
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKER_FORBIDDEN_PATTERNS,
  WORKER_FORBIDDEN_SAMPLES,
  isForbiddenWorkerTool,
  scanWorkerEvents,
  startWorkerWatchdog,
} from "../src/review/worker-policy.js";

/* ------------------------- W. 名单一致性 ------------------------- */

test("W1 五个必拦工具全部命中", () => {
  for (const name of WORKER_FORBIDDEN_SAMPLES) {
    assert.equal(isForbiddenWorkerTool(name), true, `${name} 必须被拦`);
  }
  assert.deepEqual([...WORKER_FORBIDDEN_SAMPLES].sort(), [
    "bash",
    "send_message",
    "spawn_teammate",
    "team_task_create",
    "wait_agent",
  ]);
});

test("W2 团队 / 委派 / 任务控制 / 浏览器 / MCP 族按前缀拦截", () => {
  for (const name of [
    "team_task_list",
    "team_task_update",
    "list_agents",
    "interrupt_agent",
    "task_status",
    "task_create",
    "ego_cli",
    "ego_click",
    "mcp__graphflow__graphflow_context",
  ]) {
    assert.equal(isForbiddenWorkerTool(name), true, `${name} 应当被拦`);
  }
});

test("W3 worker 本职工作工具放行（读、写、mentor_*）", () => {
  for (const name of ["read", "glob", "grep", "write", "edit", "mentor_task_status", "working_directory"]) {
    assert.equal(isForbiddenWorkerTool(name), false, `${name} 不该被拦`);
  }
});

test("W4 非字符串 / 空串 / 未知只读工具不误判", () => {
  assert.equal(isForbiddenWorkerTool(undefined), false);
  assert.equal(isForbiddenWorkerTool(null), false);
  assert.equal(isForbiddenWorkerTool(""), false);
  assert.equal(isForbiddenWorkerTool("   "), false);
  assert.equal(isForbiddenWorkerTool("some_future_read_tool"), false);
});

test("W5 正则表非空且每条都能构造（防止写成字符串）", () => {
  assert.ok(WORKER_FORBIDDEN_PATTERNS.length >= 8);
  for (const pattern of WORKER_FORBIDDEN_PATTERNS) {
    assert.equal(pattern instanceof RegExp, true, "每条规则必须是 RegExp");
  }
});

/* ------------------------- S. 事件扫描 ------------------------- */

const call = (name, seq) => ({ type: "tool/call", seq, data: { name } });

test("S1 纯读工具序列 → 无 violation，但计数正确", () => {
  const { calls, violation } = scanWorkerEvents([call("read", 1), call("grep", 2), call("edit", 3)]);
  assert.equal(calls, 3);
  assert.equal(violation, null);
});

test("S2 含 spawn_teammate 的事件数组 → violation 命中该工具名", () => {
  const { calls, violation } = scanWorkerEvents([call("read", 1), call("spawn_teammate", 2)]);
  assert.equal(violation, "spawn_teammate");
  assert.equal(calls, 2, "命中后立即返回，但要算上命中这一次");
});

test("S3 同一 seq 重复出现只计一次（快照会重复返回同一事件）", () => {
  const seen = new Set();
  const first = scanWorkerEvents([call("read", 7)], seen);
  const second = scanWorkerEvents([call("read", 7)], seen);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 0, "同一 seq 第二次不再计数");
});

test("S4 非 tool/call 事件与非数组入参不影响判定", () => {
  assert.equal(scanWorkerEvents([{ type: "text", seq: 1, data: { name: "bash" } }]).violation, null);
  assert.equal(scanWorkerEvents(undefined).calls, 0);
  assert.equal(scanWorkerEvents(null).violation, null);
});

/* ------------------------- R. 运行时接线 ------------------------- */

/** fake 定时器：记录注册与清理，便于断言「命中后自停」 */
function fakeTimer() {
  const state = { registered: [], cleared: [] };
  return {
    state,
    setIntervalImpl: (fn, ms) => {
      const handle = { fn, ms, id: state.registered.length + 1 };
      state.registered.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => state.cleared.push(handle),
  };
}

test("R1 命中越界：record 收到 status=failed + 标记，abort 恰好一次，定时器被清理", () => {
  const timer = fakeTimer();
  const recorded = [];
  let aborts = 0;
  const events = [call("mentor_task_status", 1), call("ego_cli", 2)];

  const watchdog = startWorkerWatchdog({
    getEvents: () => events,
    onViolation: (name) => {
      // 与 lib/index.js 的 onViolation 同形：先记标记，再 abort
      recorded.push({ status: "failed", error: "worker-forbidden-tool:" + name });
      aborts += 1;
    },
    intervalMs: 1500,
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });

  assert.equal(timer.state.registered.length, 1, "起了一个 1.5s 定时器");
  assert.equal(timer.state.registered[0].ms, 1500);

  const violation = watchdog.tick();

  assert.equal(violation, "ego_cli");
  assert.deepEqual(recorded, [{ status: "failed", error: "worker-forbidden-tool:ego_cli" }]);
  assert.equal(aborts, 1, "abort 只能调一次");
  assert.equal(timer.state.cleared.length, 1, "命中后必须清理定时器");
  assert.equal(watchdog.isStopped(), true);
});

test("R2 stop 之后 tick 不再触发（即使事件里仍有越界工具）", () => {
  const timer = fakeTimer();
  let aborts = 0;
  const events = [call("bash", 1)];
  const watchdog = startWorkerWatchdog({
    getEvents: () => events,
    onViolation: () => { aborts += 1; },
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });
  watchdog.stop();
  assert.equal(watchdog.tick(), null);
  assert.equal(aborts, 0);
  assert.equal(timer.state.cleared.length, 1);
});

test("R3 纯读序列：tick 多次都不触发，也不清理定时器", () => {
  const timer = fakeTimer();
  let aborts = 0;
  const events = [call("read", 1), call("glob", 2)];
  const watchdog = startWorkerWatchdog({
    getEvents: () => events,
    onViolation: () => { aborts += 1; },
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });
  assert.equal(watchdog.tick(), null);
  assert.equal(watchdog.tick(), null);
  assert.equal(aborts, 0);
  assert.equal(timer.state.cleared.length, 0);
  watchdog.stop();
});

test("R4 getEvents 抛错不炸（宿主会话可能已销毁）", () => {
  const timer = fakeTimer();
  const watchdog = startWorkerWatchdog({
    getEvents: () => { throw new Error("session gone"); },
    onViolation: () => { throw new Error("不该被调用"); },
    setIntervalImpl: timer.setIntervalImpl,
    clearIntervalImpl: timer.clearIntervalImpl,
  });
  assert.throws(() => watchdog.tick(), /session gone/);
  watchdog.stop();
});
