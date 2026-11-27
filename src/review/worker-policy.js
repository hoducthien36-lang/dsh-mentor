/**
 * worker 子会话的工具策略与运行时看门狗（零依赖，全部可注入）。
 *
 * 为什么要有这个模块：`restrictMentorChild` 在 allow 全为内置工具时会降级成
 * `mode="builtin-unrestricted"`（宿主 `tools.restrict` 只认全局工具，内置 read/glob/grep
 * 会被判 unknown 剔除，survivors 为空）。结果是 worker 实际拿到全量工具——含 bash、
 * 团队工具、ego_*／mcp__*——只剩 prompt 在约束。reviewer 侧早就有 1.5s 越界看门狗，
 * worker 侧没有；这里把它补齐，并且把「轮询 + 中止」也做成可注入依赖的函数，
 * 好让单测能验到接线（不只是判名单）。
 *
 * 与 reviewer-policy 的区别：worker 是**允许写**的（写域由 writeGuard + stage.writePaths 管），
 * 所以这里只拦「不该做的事」：shell、团队/委派、其它任务控制、浏览器与 MCP 工具。
 */

import { createStuckTracker } from "../runtime/stuck-detector.js";

/** worker 不该拿到的工具族（正则）。命中即中止该 worker。 */
export const WORKER_FORBIDDEN_PATTERNS = Object.freeze([
  /^bash$/,
  /^pwsh$/i,
  /^powershell$/i,
  /^cmd$/i,
  /^cg$/,
  /^team_task_/,
  /^spawn_teammate$/,
  /^send_message$/,
  /^wait_agent$/,
  /^list_agents$/,
  /^interrupt_agent$/,
  /^task_/, // 宿主的 task_* 督导工具，不是 mentor 的
  /^ego_/,
  /^mcp__/,
]);

/** 明显该拦的工具名，供测试与文档引用（与 WORKER_FORBIDDEN_PATTERNS 保持一致） */
export const WORKER_FORBIDDEN_SAMPLES = Object.freeze([
  "bash",
  "team_task_create",
  "spawn_teammate",
  "send_message",
  "wait_agent",
]);

/**
 * 判断 worker 调用某个工具是否越界。
 *
 * 规则：命中危险族 → 越界；其余（read/glob/grep/write/edit 以及未知只读类）→ 放行。
 * 写域不在这里判——write/edit 的目标路径由 restrictMentorChild 的 writeGuard 负责。
 *
 * @param {unknown} name 工具名
 * @returns {boolean} true = 越界
 */
export function isForbiddenWorkerTool(name) {
  if (typeof name !== "string") return false;
  const value = name.trim();
  if (value.length === 0) return false;
  if (value.startsWith("mentor_")) return false;
  return WORKER_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 扫一遍事件数组，找出第一个越界工具调用。
 *
 * 纯函数：不读时钟、不调宿主、不改入参（`seen` 由调用方持有）。
 * 同一事件（同 seq）只计一次，防止快照重复返回导致重复计数。
 *
 * @param {Array<{type?:string, seq?:number, id?:string, data?:{name?:string}}>} events
 * @param {Set<unknown>} [seen] 已处理过的事件键（就地累加）
 * @returns {{seen:Set<unknown>, calls:number, violation:string|null}}
 */
export function scanWorkerEvents(events, seen = new Set()) {
  const list = Array.isArray(events) ? events : [];
  let calls = 0;
  for (const event of list) {
    if (event?.type !== "tool/call") continue;
    const key = event.seq ?? event.id;
    if (key != null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    calls += 1;
    const name = String(event.data?.name ?? "");
    if (isForbiddenWorkerTool(name)) return { seen, calls, violation: name };
  }
  return { seen, calls, violation: null };
}

/**
 * worker 运行时看门狗：定时轮询事件，命中越界即调一次 onViolation 并自停。
 *
 * 为什么把「轮询」也抽出来：只测 `scanWorkerEvents` 的话，「漏调 abort」「标记写错位置」
 * 这类接线错误测不出来——真机才会暴露。这里把 setInterval / clearInterval 都做成
 * 可注入，单测可以直接调 `tick()` 或注入假定时器，断言 onViolation 的副作用。
 *
 * @param {{
 *   getEvents: () => Array<object>,
 *   onViolation: (name: string) => void,
 *   intervalMs?: number,
 *   setIntervalImpl?: (fn: () => void, ms: number) => unknown,
 *   clearIntervalImpl?: (handle: unknown) => void,
 * }} options
 * @returns {{tick: () => string|null, stop: () => void, isStopped: () => boolean}}
 */
export function startWorkerWatchdog({
  getEvents,
  onViolation,
  onStuck = null,
  stuckOptions = null,
  intervalMs = 1500,
  setIntervalImpl,
  clearIntervalImpl,
} = {}) {
  const seen = new Set();
  const stuckTracker = typeof onStuck === "function" ? createStuckTracker(stuckOptions ?? undefined) : null;
  let stopped = false;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer != null) {
      if (typeof clearIntervalImpl === "function") clearIntervalImpl(timer);
      else if (typeof clearInterval === "function") clearInterval(timer);
    }
    timer = null;
  };

  const tick = () => {
    if (stopped) return null;
    const events = typeof getEvents === "function" ? getEvents() ?? [] : [];
    const { violation } = scanWorkerEvents(events, seen);
    if (violation) {
      stop();
      if (typeof onViolation === "function") onViolation(violation);
      return violation;
    }
    if (stuckTracker) {
      const verdict = stuckTracker.evaluate(events);
      if (verdict.action === "steer" || verdict.action === "halt") {
        if (verdict.action === "halt") stop();
        onStuck(verdict);
        return `stuck:${verdict.pattern}`;
      }
    }
    return null;
  };

  if (typeof setIntervalImpl === "function") {
    timer = setIntervalImpl(tick, intervalMs);
  } else if (typeof setInterval === "function") {
    timer = setInterval(tick, intervalMs);
  }

  return { tick, stop, isStopped: () => stopped };
}
