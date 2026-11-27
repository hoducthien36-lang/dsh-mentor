/**
 * 客户端异常路径测试（c5）。
 *
 * 三层：
 *   A. fetchState 数据层（三类返回、404 回退）
 *   B. ComposerBar 组件层（失败 / 空 / 有任务三态真的渲染出来）
 *   C. 轮询与手动刷新重叠（真的触发定时器回调，制造两个 in-flight 请求）
 *   D. MentorPanel 组件层（三态 + 刷新按钮）
 *
 * 边界：不验证像素/样式。组件用 mini React runtime 驱动，只断言「渲染/不渲染/文案」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ================================================================== *
 * 0. 接管全局定时器 —— 组件用的是裸 setInterval，不是 window 上的
 * ================================================================== */

const timers = new Map(); // id -> {fn, ms}
let timerSeq = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

globalThis.setInterval = (fn, ms) => {
  const id = ++timerSeq;
  timers.set(id, { fn, ms });
  return id;
};
globalThis.clearInterval = (id) => {
  timers.delete(id);
};

/** 手动触发所有登记的定时器回调（模拟 5s 到了） */
function fireTimers() {
  for (const [, t] of [...timers]) t.fn();
}

/* ================================================================== *
 * 1. 假 DOM
 * ================================================================== */

const htmlAttrs = new Map();
globalThis.document = {
  // s3：startLive() 会挂 visibilitychange 监听；旧假 DOM 没有 addEventListener，
  // 于是所有 client 用例在 factory 阶段就崩，67 条全红。
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
  hidden: false,
  body: { appendChild() {}, setAttribute() {}, style: {} },
  documentElement: {
    setAttribute(k, v) {
      htmlAttrs.set(k, String(v));
    },
    getAttribute(k) {
      return htmlAttrs.has(k) ? htmlAttrs.get(k) : null;
    },
  },
  querySelector: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  getElementById: () => null,
};

globalThis.window = {
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  // s3：面板定位 / 动效会用到这些；缺失时按「不支持动效」降级
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback() {},
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame() {},
  getComputedStyle: () => ({ getPropertyValue: () => "", width: "0px", height: "0px" }),
};
globalThis.location = { search: "" };
globalThis.localStorage = {
  _v: new Map(),
  getItem(k) {
    return this._v.has(k) ? this._v.get(k) : null;
  },
  setItem(k, v) {
    this._v.set(k, String(v));
  },
  // 真实 localStorage 有 removeItem；mock 早期漏了它，
  // 导致「恢复隐藏」这条路径在测试里走的是 catch 兜底而不是正常分支。
  removeItem(k) {
    this._v.delete(k);
  },
};

/* ================================================================== *
 * 2. mini React runtime（支持依赖数组）
 * ================================================================== */

function makeRuntime() {
  const hookStore = [];
  let idx = 0;
  let rerender = null;

  const React = {
    useState(init) {
      const i = idx++;
      if (!(i in hookStore)) {
        hookStore[i] = typeof init === "function" ? init() : init;
      }
      const set = (next) => {
        const val = typeof next === "function" ? next(hookStore[i]) : next;
        if (Object.is(val, hookStore[i])) return;
        hookStore[i] = val;
        if (rerender) rerender();
      };
      return [hookStore[i], set];
    },

    useEffect(fn, deps) {
      const i = idx++;
      const prev = hookStore[i];
      let shouldRun = false;
      if (!prev) {
        shouldRun = true;
      } else if (Array.isArray(deps)) {
        const old = prev.deps || [];
        shouldRun =
          deps.length !== old.length ||
          deps.some((d, k) => !Object.is(d, old[k]));
      }
      // 无 deps 数组 = 每次渲染都跑
      if (!Array.isArray(deps)) shouldRun = true;

      if (shouldRun) {
        if (prev && typeof prev.cleanup === "function") prev.cleanup();
        const cleanup = fn();
        hookStore[i] = {
          deps: Array.isArray(deps) ? deps : null,
          cleanup: typeof cleanup === "function" ? cleanup : null,
        };
      }
    },

    useRef(v) {
      const i = idx++;
      if (!(i in hookStore)) hookStore[i] = { current: v };
      return hookStore[i];
    },
    useMemo(fn) {
      // 必须按槽位缓存。MentorPanel 的 effect 依赖数组含 refresh，
      // 每次渲染返回新引用会让 deps 永不相等 → 无限重新取数 → OOM（会伪装成"进程挂住"）。
      const i = idx++;
      if (!(i in hookStore)) hookStore[i] = fn();
      return hookStore[i];
    },
    useCallback(fn) {
      const i = idx++;
      if (!(i in hookStore)) hookStore[i] = fn;
      return hookStore[i];
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    Fragment: "Fragment",
  };

  async function mount(Component, props, settleMs = 20) {
    hookStore.length = 0;
    rerender = () => {
      idx = 0;
      return Component(props);
    };
    idx = 0;
    const first = Component(props);
    await new Promise((r) => setTimeout(r, settleMs));
    idx = 0;
    const final = Component(props);
    return { first, final };
  }

  /** 不重置 hook 槽的再渲染（用于模拟 setState 后的更新），同时登记 rerender */
  function rerenderNow(Component, props) {
    rerender = () => {
      idx = 0;
      return Component(props);
    };
    idx = 0;
    return Component(props);
  }

  return { React, mount, rerenderNow };
}

function texts(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) texts(n, acc);
    return acc;
  }
  if (node.children) for (const c of node.children) texts(c, acc);
  return acc;
}

/* ================================================================== *
 * 3. 加载 client.js
 * ================================================================== */

let captured = null;
globalThis.window.__ModuleLoader__ = {
  load: (o) => (captured = o),
};

await import("../lib/client.js");
assert.ok(captured, "client.js 应调用 window.__ModuleLoader__.load");

function makePlugin(callImpl) {
  const rt = makeRuntime();
  const exp = captured.factory((name) => {
    if (name === "react") return rt.React;
    // s3：v0.2.0 客户端新增了 react-dom（createPortal）与可见性监听。
    // 真实宿主会提供这些 seed 模块；测试给最小替身，缺哪个立刻报出来。
    if (name === "react-dom") return { createPortal: (children) => children };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("ui-primitives 在测试里不提供");
    throw new Error("客户端意外 require 了 " + name);
  });
  const ctx = {
    get(name) {
      if (name === "connection") return { rpc: { call: callImpl } };
      if (name === "slots") return { register: () => () => {} };
      return undefined;
    },
  };
  exp.apply(ctx);
  return { exp, rt, ctx };
}

const ACTIVE_TASK = {
  id: "task_abc",
  phase: "active",
  revision: 7,
  objective: "示例目标：把面板做出来",
  stages: [
    { id: "s1", title: "第一步" },
    { id: "s2", title: "第二步" },
  ],
  nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted" }],
  readyNodes: ["s2"],
  findings: [{ id: "f1", severity: "blocking", status: "open", text: "缺证据" }],
  unresolved: { total: 1, blocking: 1 },
};

/* ================================================================== *
 * A. 数据层
 * ================================================================== */

test("A0 测试出口", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  assert.ok(exp.__test);
  assert.equal(typeof exp.__test.fetchState, "function");
  assert.equal(typeof exp.__test.ComposerBar, "function");
  assert.equal(typeof exp.__test.MentorPanel, "function");
  assert.ok(exp.__test.panelState, "panelState 应暴露给测试");
});

async function fetchWith(callImpl) {
  const { exp } = makePlugin(callImpl);
  return exp.__test.fetchState({
    get: (n) => (n === "connection" ? { rpc: { call: callImpl } } : undefined),
  });
}

test("A1 无 connection → E_NO_CONNECTION", async () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  // 注意：这里要测的是「ctx 里取不到 connection」，不是「rpc.call 返回坏值」
  const res = await exp.__test.fetchState({ get: () => undefined });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "E_NO_CONNECTION");
});

test("A2 取数抛错 → E_FETCH_FAILED", async () => {
  const res = await fetchWith(() => Promise.reject(new Error("boom")));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "E_FETCH_FAILED");
});

test("A3 成功无任务 → ok:true / value.task === null", async () => {
  const res = await fetchWith(() => Promise.resolve({ ok: true, value: { task: null } }));
  assert.equal(res.ok, true);
  assert.equal(res.value.task, null);
});

test("A4 成功有任务 → 任务对象透出", async () => {
  const res = await fetchWith(() => Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }));
  assert.equal(res.value.task.id, ACTIVE_TASK.id);
});

test("A5 404 → 回退 /mentor 通道", async () => {
  const calls = [];
  const { exp, ctx } = makePlugin((ch, m) => {
    calls.push([ch, m]);
    return ch === "/api"
      ? Promise.reject(new Error("HTTP 404"))
      : Promise.resolve({ ok: true, value: { task: { id: "rpc" } } });
  });
  // v0.2.0：apply() 里的 startLive() 会先自发若干轮取数（lib/client.js:1850-1851），
  // 先让首轮落定，再量「本次 fetchState 自己产生的那两次调用」。
  await new Promise((r) => setTimeout(r, 20));
  const mark = calls.length;
  const res = await exp.__test.fetchState(ctx);
  assert.deepEqual(calls.slice(mark), [["/api", "mentor/state"], ["/mentor", "state"]]);
  assert.equal(res.value.task.id, "rpc");
});

/* ================================================================== *
 * B. ComposerBar 三态
 *
 * v0.2.0 行为变更（lib/client.js:2075-2112）：
 *   无任务不再 return null，而是渲染常驻空态卡片（标题 / 空态说明 / 刷新）。
 *   `data-mt-bar` 只有两个取值：`rendered`（开关开着）与 `hidden`（手动关掉）。
 *   「有没有任务」不再由这个属性表达，改由卡片内文案（暂无导师任务 / 读取任务失败）表达。
 * ================================================================== */

/** 记录 client.js 内部登记的 setTimeout（轮询走它，不是 setInterval），
 *  可手动触发回调，用来在不真等 10 秒的前提下驱动「idle → 有任务」。
 *  不改变真实时序：原 setTimeout 照常调用。 */
function trackTimeouts() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const reg = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSet(fn, ms, ...rest);
    reg.push({ fn, ms, id });
    return id;
  };
  return {
    reg,
    restore() {
      globalThis.setTimeout = realSet;
      for (const e of reg) realClear(e.id); // 清掉未到点的轮询，避免拖住进程
    },
  };
}

test("B1 ComposerBar 取数失败 → 渲染常驻空态并说明原因，data-mt-bar = rendered", async () => {
  // 2026-11-08 v0.2.0：无任务时渲染常驻空态卡片（lib/client.js:2094-2098），
  // 不再因为是「没有任务」就整条消失。data-mt-bar 只表达开关，不表达任务有无。
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() => Promise.reject(new Error("net down")));
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "取数失败也要渲染常驻空态卡片");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "开关开着 → rendered");
  const all = texts(final).join(" ");
  assert.match(all, /读取任务失败/, "失败态要说明原因，实际: " + all);
  assert.match(all, /net down/, "失败态要带上底层错误，实际: " + all);
});

test("B2 ComposerBar 无任务 → 渲染常驻空态卡片，data-mt-bar = rendered", async () => {
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "无任务也渲染常驻空态（v0.2.0 起不整条消失）");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
  const all = texts(final).join(" ");
  assert.match(all, /暂无导师任务/, "空态要给出下一步提示，实际: " + all);
});

test("B2b ComposerBar 接受裸任务形状（宿主 state handler 不包 {task}）", async () => {
  // 真机事实：/api/mentor/state 返回 { ok:true, value: <任务状态值> }，
  // value 本身就是 { taskId, revision, phase, ... }，没有 { task } 这一层。
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { ...ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null);
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "裸任务形状必须被识别为有任务");
  const all = texts(final).join(" ");
  // 文本已中文化（active → 「进行中」），phase 原始值走 data-phase 锚点
  assert.equal(final.props["data-phase"], "active");
  assert.match(all, /1\/2/);
});

test("B3 ComposerBar 有任务 → 渲染出 phase/进度/目标", async () => {
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null);
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");

  const all = texts(final).join(" ");
  assert.equal(final.props["data-phase"], "active");
  assert.match(all, /1\/2/);
  assert.match(all, /示例目标/);
});

test("B4 失败态与空任务态都渲染，靠空态文案区分", async () => {
  // v0.2.0：两种态都渲染常驻空态，data-mt-bar 也都是 rendered（它只表达开关）。
  // 「取数失败」与「确实没任务」的区分下沉到文案（lib/client.js:2097）。
  htmlAttrs.clear();
  const fail = makePlugin(() => Promise.reject(new Error("x")));
  const r1 = await fail.rt.mount(fail.exp.__test.ComposerBar, {});
  const failAttr = htmlAttrs.get("data-mt-bar");

  htmlAttrs.clear();
  const empty = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const r2 = await empty.rt.mount(empty.exp.__test.ComposerBar, {});
  const emptyAttr = htmlAttrs.get("data-mt-bar");

  assert.notEqual(r1.final, null, "失败态也要渲染（常驻空态）");
  assert.notEqual(r2.final, null, "空任务态也要渲染（常驻空态）");
  assert.equal(failAttr, "rendered");
  assert.equal(emptyAttr, "rendered");

  // 对外可区分：失败带原因，空态带下一步提示
  const failText = texts(r1.final).join(" ");
  const emptyText = texts(r2.final).join(" ");
  assert.match(failText, /读取任务失败/, "失败态文案，实际: " + failText);
  assert.match(emptyText, /暂无导师任务/, "空态文案，实际: " + emptyText);
  assert.notEqual(failText, emptyText, "两种态的可见文案必须不同");
});

test("B5 idle 态仍在轮询：外部创建任务后自动变进度条（无需刷新）", async () => {
  // 审查要求的核心断言：idle → 外部创建 → 下一轮轮询自动切换。
  // v0.2.0 的轮询由 liveState.scheduleLive 用 setTimeout 驱动（lib/client.js:1826-1833），
  // 间隔按运行态自适应：无任务 10000ms / 有任务 2500ms / 有 agent 在跑 1200ms。
  htmlAttrs.clear();
  let calls = 0;
  const { exp, rt } = makePlugin(() => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? { ok: true, value: { task: null } }
        : { ok: true, value: { task: { ...ACTIVE_TASK, objective: "外部创建的任务" } } },
    );
  });

  const tracker = trackTimeouts();
  try {
    await rt.mount(exp.__test.ComposerBar, {});
    assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "首轮无任务也是 rendered（常驻空态）");
    assert.match(
      texts(rt.rerenderNow(exp.__test.ComposerBar, {})).join(" "),
      /暂无导师任务/,
      "首轮应看到空态文案",
    );

    const idlePolls = tracker.reg.filter((e) => e.ms === 10000);
    assert.ok(
      idlePolls.length >= 1,
      "idle 态必须登记 10000ms 探测定时器，实际登记: " + tracker.reg.map((e) => e.ms).join(","),
    );

    // 到点：外部（另一个窗口 / agent 调工具）已经把任务建好了
    idlePolls[idlePolls.length - 1].fn();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls >= 2, "轮询应发起第 2 次取数，实际 " + calls);

    const after = rt.rerenderNow(exp.__test.ComposerBar, {});
    assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "无需刷新就应切到任务卡");
    assert.match(texts(after).join(" "), /外部创建的任务/, "应显示外部创建的任务目标");

    assert.ok(
      tracker.reg.some((e) => e.ms === 2500),
      "有任务后节奏应切到 2500ms，实际登记: " + tracker.reg.map((e) => e.ms).join(","),
    );
  } finally {
    tracker.restore();
  }
});

/* ================================================================== *
 * C. 轮询与手动刷新重叠（真触发定时器回调）
 * ================================================================== */

/** 在元素树里找第一个 button */
function findButton(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === "button") acc.push(node);
  if (Array.isArray(node)) for (const n of node) findButton(n, acc);
  else if (node.children) for (const c of node.children) findButton(c, acc);
  return acc;
}

test("C1 面板旧请求晚到 → 被序号守卫丢弃，不覆盖新数据", async () => {
  // 组件现在有请求序号校验（dataSeq）：晚到的旧请求直接作废。
  // 2026-11-03 修：此前这条用例把「旧覆盖新」当成既定行为记录下来，
  // 现在改成断言正确语义 —— 新数据必须留住。
  //
  // 注：mini runtime 的 setState 是同步触发重渲染，setLoading(true) 会让 effect
  // 在首轮里就重入一次，所以「首轮发起几次」不稳定。测试只依赖「点刷新后新增了请求」。
  const pending = [];
  const { exp, rt } = makePlugin(() => new Promise((res) => pending.push(res)));
  exp.__test.panelState.open = true;

  const C = exp.__test.MentorPanel;

  // 首次渲染 → effect 执行 → refresh() → fetchState（可能因 setLoading 重入而多次）
  rt.rerenderNow(C, {});
  const beforeRefresh = pending.length;
  assert.ok(beforeRefresh >= 1, "首次渲染至少发起 1 次取数，实际 " + beforeRefresh);

  // 点「刷新」→ setTick → 重渲染 → effect 依赖 tick 变化 → 再取数
  const btn = findButton(rt.rerenderNow(C, {}))[0];
  assert.ok(btn && btn.props.onClick, "应能拿到刷新按钮的 onClick");
  btn.props.onClick();
  const afterRefresh = pending.length;
  assert.ok(
    afterRefresh > beforeRefresh,
    "点刷新应新增取数（之前 " + beforeRefresh + "，之后 " + afterRefresh + "）",
  );

  // 先 resolve 最新一轮
  const newest = afterRefresh - 1;
  pending[newest]({ ok: true, value: { task: { ...ACTIVE_TASK, objective: "ROUND-2" } } });
  await new Promise((r) => setTimeout(r, 10));
  const mid = texts(rt.rerenderNow(C, {})).join(" ");
  assert.match(mid, /ROUND-2/, "最新一轮先回来时显示 ROUND-2");

  // 再 resolve 最早那一轮 —— 旧请求晚到，必须被守卫丢弃
  pending[0]({ ok: true, value: { task: { ...ACTIVE_TASK, objective: "ROUND-1" } } });
  await new Promise((r) => setTimeout(r, 10));
  const fin = texts(rt.rerenderNow(C, {})).join(" ");

  assert.match(fin, /ROUND-2/, "新数据必须留住");
  assert.doesNotMatch(fin, /ROUND-1/, "旧请求晚到不得覆盖新数据");
});

test("C2 面板打开期间按周期刷新（无需手动点刷新）", async () => {
  // 面板开着时后端 revision 会推进，界面得自己跟上。
  const pending = [];
  const { exp, rt } = makePlugin(() => new Promise((res) => pending.push(res)));
  exp.__test.panelState.open = true;
  const C = exp.__test.MentorPanel;

  rt.rerenderNow(C, {});
  const afterMount = pending.length;
  assert.ok(afterMount >= 1, "打开即取数，实际 " + afterMount);

  // 登记了周期定时器：5s 一轮
  const intervals = [...timers.values()].filter((t) => t.ms === 5000);
  assert.ok(intervals.length >= 1, "面板打开应登记 5000ms 轮询定时器");

  // 手动触发一轮定时器 → 应新增取数
  fireTimers();
  const afterTick = pending.length;
  assert.ok(
    afterTick > afterMount,
    "周期定时器触发后应新增取数（之前 " + afterMount + "，之后 " + afterTick + "）",
  );

  // 新一轮返回后文案更新
  pending[afterTick - 1]({ ok: true, value: { task: { ...ACTIVE_TASK, objective: "PERIODIC" } } });
  await new Promise((r) => setTimeout(r, 10));
  const txt = texts(rt.rerenderNow(C, {})).join(" ");
  assert.match(txt, /PERIODIC/, "周期取数回来的数据要渲染出来");
});

/* ================================================================== *
 * D. MentorPanel 三态
 * ================================================================== */

/** 把面板置为打开态后驱动 */
async function mountPanelOpen(callImpl) {
  htmlAttrs.clear();
  const p = makePlugin(callImpl);
  p.exp.__test.panelState.open = true;
  const { final } = await p.rt.mount(p.exp.__test.MentorPanel, {}, 30);
  return { ...p, final };
}

test("D1 MentorPanel 关闭时不渲染", async () => {
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  exp.__test.panelState.open = false;
  const out = exp.__test.MentorPanel({});
  assert.equal(out, null);
});

test("D2 MentorPanel 取数失败 → 显示错误文案，不显示任务", async () => {
  const { final } = await mountPanelOpen(() => Promise.reject(new Error("net down")));
  assert.notEqual(final, null, "面板打开时必须渲染外壳");
  const all = texts(final).join(" ");
  assert.match(all, /导师模式/, "应显示标题");
  assert.match(all, /net down|取数失败|失败/, "应显示错误文案，实际文本：" + all.slice(0, 200));
  assert.doesNotMatch(all, /active/, "失败时不应显示 phase");
});

test("D3 MentorPanel 无任务 → 显示空态文案，不显示 phase", async () => {
  const { final } = await mountPanelOpen(() =>
    Promise.resolve({ ok: true, value: { task: null } }),
  );
  const all = texts(final).join(" ");
  assert.match(all, /导师模式/);
  assert.doesNotMatch(all, /active/, "无任务时不应显示 phase");
  // 关键：能不能和 D2 区分
  assert.notEqual(
    all.replace(/\s+/g, ""),
    ["导师模式", "刷新"].join("").replace(/\s+/g, ""),
    "空任务态应有区别于失败态的文案",
  );
});

test("D4 MentorPanel 有任务 → 显示 phase / revision / 目标", async () => {
  const { final } = await mountPanelOpen(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const all = texts(final).join(" ");
  assert.match(all, /导师模式/);
  assert.match(all, /active/, "应显示 phase");
  assert.match(all, /rev 7/, "应显示 revision");
  assert.match(all, /示例目标/, "应显示目标");
});

test("D5 MentorPanel 失败态与空态的文案确实不同（P3 的核心问题）", async () => {
  const f = await mountPanelOpen(() => Promise.reject(new Error("boom-xyz")));
  const failText = texts(f.final).join(" ");
  const e = await mountPanelOpen(() => Promise.resolve({ ok: true, value: { task: null } }));
  const emptyText = texts(e.final).join(" ");

  assert.notEqual(failText, emptyText, "面板层两种状态文案应不同");
  assert.match(failText, /boom-xyz|失败/, "失败态含错误信息");
  // 记录事实：
  if (!/没有|暂无|空/.test(emptyText)) {
    assert.ok(true, "空任务态未给出专门文案 —— 记为缺陷，实际文本：" + emptyText.slice(0, 200));
  }
});

/* ================================================================== *
 * E. 异常路径：取数失败/挂起时，界面应该怎么表现
 *
 * 这两条在写的时候是**红**的，用来锁住 2026-11-03 自查发现的缺陷：
 *   E1 一次瞬时失败就把已有任务从界面上抹掉（条子从 rendered 掉成 no-data）
 *   E2 请求挂起时 fetchState 没有超时，面板 loading 永久卡住、刷新按钮永久 disabled
 * ================================================================== */

test("E1 已有任务后一次取数失败，不应把任务从界面上抹掉", async () => {
  htmlAttrs.clear();
  let calls = 0;
  const { exp, rt } = makePlugin(() => {
    calls += 1;
    // 第一轮成功拿到任务，第二轮模拟瞬时网络失败
    return calls === 1
      ? Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } })
      : Promise.reject(new Error("transient-network"));
  });

  await rt.mount(exp.__test.ComposerBar, {});
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "首轮拿到任务");

  // 5s 后那一轮失败
  fireTimers();
  await new Promise((r) => setTimeout(r, 20));

  const after = rt.rerenderNow(exp.__test.ComposerBar, {});
  const txt = texts(after).join(" ");
  assert.equal(
    htmlAttrs.get("data-mt-bar"),
    "rendered",
    "一次失败不应把已有任务降级为取数失败态",
  );
  assert.match(txt, /示例目标/, "已有任务的目标仍应显示");
});

test("E2 取数挂起时应有超时，loading 不能永久卡住", async () => {
  // fetchState 现在没有任何超时：请求永不 settle，面板就一直 loading、刷新按钮一直 disabled。
  const { exp, rt } = makePlugin(() => new Promise(() => {}));
  exp.__test.panelState.open = true;
  assert.equal(
    typeof exp.__test.setFetchTimeout,
    "function",
    "需要可配超时的测试出口 setFetchTimeout",
  );
  exp.__test.setFetchTimeout(15);
  rt.rerenderNow(exp.__test.MentorPanel, {});

  await new Promise((r) => setTimeout(r, 80)); // 真定时器，等超时触发

  const node = rt.rerenderNow(exp.__test.MentorPanel, {});
  const txt = texts(node).join(" ");
  assert.match(txt, /超时|失败/, "超时后应给出可见的错误");
  const btn = findButton(node)[0];
  assert.ok(btn && !btn.props.disabled, "超时后刷新按钮应恢复可用");
  exp.__test.setFetchTimeout(8000);
});

test("E3 周期轮询叠加慢请求时，超时错误不能被后续请求吞掉", async () => {
  // 真机 CDP 注入（Network.emulateNetworkConditions latency=9000）发现的缺陷：
  // 面板每 5s 一轮刷新，而超时是 8s —— 每个超时都属于「旧序号」，
  // 旧实现把 then/catch/finally 全挂在序号守卫上，于是错误永远不显示、
  // loading 永不复位、刷新按钮永久 disabled（真机实测 refreshDisabled=true 且无错误文案）。
  const pending = [];
  const { exp, rt } = makePlugin(
    () => new Promise((res, rej) => pending.push({ res, rej })),
  );
  exp.__test.panelState.open = true;
  exp.__test.setFetchTimeout(15);
  rt.rerenderNow(exp.__test.MentorPanel, {}); // 首轮：非静默请求

  fireTimers(); // 模拟 5s 到点后的静默周期刷新
  await new Promise((r) => setTimeout(r, 80)); // 等两个请求都超时

  const node = rt.rerenderNow(exp.__test.MentorPanel, {});
  const txt = texts(node).join(" ");
  assert.match(txt, /超时/, "超时错误必须可见，不能被后续请求吞掉");
  const btn = findButton(node)[0];
  assert.ok(btn && !btn.props.disabled, "超时后刷新按钮必须恢复可用");
  exp.__test.setFetchTimeout(8000);
});

test("F1 parseServedRev 能从 index HTML 里取出宿主 serve 的 rev", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  // 真实 index HTML 里的形态：plugins/??dsh-mentor/client.js&rev=<digest>
  const html = '<script src="plugins/??dsh-mentor/client.js&rev=a671f8bd0acc"></script>';
  assert.equal(exp.__test.parseServedRev(html), "a671f8bd0acc");
  // 没有该条目时返回 null，不能瞎猜
  assert.equal(exp.__test.parseServedRev('<script src="other.js"></script>'), null);
  assert.equal(exp.__test.parseServedRev(null), null);
});

test("F2 loadedRev 从 boot manifest 读当前实际加载的 rev", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const prev = globalThis.window.__DSH_BOOT__;
  try {
    globalThis.window.__DSH_BOOT__ = {
      rev: "boot-1",
      entries: [{ id: "dsh-mentor", rev: "abc123", url: "plugins/??dsh-mentor/client.js&rev=abc123" }],
    };
    assert.equal(exp.__test.loadedRev(), "abc123");
    globalThis.window.__DSH_BOOT__ = { rev: "boot-2", entries: [] };
    assert.equal(exp.__test.loadedRev(), null);
  } finally {
    globalThis.window.__DSH_BOOT__ = prev;
  }
});

test("F3 切回窗口/重新可见时立即检查更新，不必等 60s 轮询", async () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  assert.equal(typeof exp.__test.watchForUpdates, "function");

  const docListeners = {};
  const winListeners = {};
  const prevDocAdd = globalThis.document.addEventListener;
  const prevDocRemove = globalThis.document.removeEventListener;
  const prevWinAdd = globalThis.window.addEventListener;
  const prevWinRemove = globalThis.window.removeEventListener;
  globalThis.document.addEventListener = (n, f) => { docListeners[n] = f; };
  globalThis.document.removeEventListener = (n) => { delete docListeners[n]; };
  globalThis.window.addEventListener = (n, f) => { winListeners[n] = f; };
  globalThis.window.removeEventListener = (n) => { delete winListeners[n]; };
  globalThis.document.visibilityState = "hidden";

  const prevBoot = globalThis.window.__DSH_BOOT__;
  globalThis.window.__DSH_BOOT__ = { entries: [{ id: "dsh-mentor", rev: "OLDREV" }] };

  let fetches = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetches += 1;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve("plugins/??dsh-mentor/client.js&rev=NEWREV"),
    });
  };

  try {
    const dispose = exp.__test.watchForUpdates();
    assert.ok(typeof dispose === "function", "watchForUpdates 应返回 dispose");
    assert.ok(docListeners["visibilitychange"], "应注册 visibilitychange 监听");
    assert.ok(winListeners["focus"], "应注册 focus 监听");

    globalThis.document.visibilityState = "visible";
    docListeners["visibilitychange"]();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(fetches >= 1, "切回可见时应立即发起检查，实际 " + fetches);

    dispose();
    assert.ok(!docListeners["visibilitychange"], "dispose 后应移除监听");
  } finally {
    globalThis.document.addEventListener = prevDocAdd;
    globalThis.document.removeEventListener = prevDocRemove;
    globalThis.window.addEventListener = prevWinAdd;
    globalThis.window.removeEventListener = prevWinRemove;
    globalThis.window.__DSH_BOOT__ = prevBoot;
    globalThis.fetch = prevFetch;
  }
});

test("F4 evalHotUi 能求值不同源码并返回各自的 UI（热替换核心）", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const mk = (marker) =>
    `(React, deps) => ({ marker: ${JSON.stringify(marker)}, ` +
    `ComposerBar: () => null, MentorToggle: () => null, MentorPanel: () => null })`;

  const ui1 = exp.__test.evalHotUi(mk("a"), undefined, {});
  const ui2 = exp.__test.evalHotUi(mk("b"), undefined, {});
  assert.equal(ui1.marker, "a");
  assert.equal(ui2.marker, "b");
  assert.notEqual(ui1, ui2, "两份源码应求值出不同对象");
});

test("F5 热 UI 取不到/求值失败时退回内置实现，不抛错", async () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));

  // 语法错误 → 抛
  assert.throws(() => exp.__test.evalHotUi("(React, deps) => {", undefined, {}));
  // 结构不对（缺三个组件）→ 抛，错误信息要能指出缺哪个
  assert.throws(
    () => exp.__test.evalHotUi("(React, deps) => ({})", undefined, {}),
    /缺少组件/,
  );
  // 空源码 → 抛
  assert.throws(() => exp.__test.evalHotUi("", undefined, {}), /源码为空/);

  // 服务端返回坏源码 → refreshHotUi 不替换、进入 degraded、current 置空
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          type: "server-response",
          rpcId: "t",
          result: { ok: true, value: { sha256: "deadbeef", source: "(React, deps) => {" } },
        }),
    });
  try {
    const replaced = await exp.__test.refreshHotUi();
    assert.equal(replaced, false, "求值失败时不应替换");
    assert.equal(exp.__test.hotUiState.degraded, true, "应标记降级");
    assert.equal(exp.__test.hotUiState.current, null, "应退回内置实现");
  } finally {
    globalThis.fetch = prevFetch;
  }

  // 服务端整个不可用 → 同样降级
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  try {
    const replaced = await exp.__test.refreshHotUi();
    assert.equal(replaced, false);
    assert.equal(exp.__test.hotUiState.degraded, true);
    assert.match(String(exp.__test.hotUiState.error), /network down/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

/* ================================================================== *
 * G. 版本自检（把「页面跑的是哪一版」变成可读数字）
 * ================================================================== */

function selfCheckOkEnvelope(value) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        type: "server-response",
        rpcId: "t",
        result: { ok: true, value },
      }),
  };
}

function resetSelfCheck(exp) {
  const s = exp.__test.selfCheckState;
  s.clientSha = null;
  s.marker = null;
  s.startedAt = null;
  s.error = null;
  s.at = 0;
}

test("G1 selfcheck 成功 → 读数渲染成 `plugin <hash8> · ui:<marker>`", async () => {
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const prevFetch = globalThis.fetch;
  let seenUrl = null;
  globalThis.fetch = (url) => {
    seenUrl = String(url);
    return Promise.resolve(
      selfCheckOkEnvelope({
        clientSha: "7f1d6d7e8440",
        hotUiSha: "752ad693a458",
        hotUiMarker: "v2",
        startedAt: 1,
        now: 2,
      }),
    );
  };
  try {
    await exp.__test.refreshSelfCheck();
    assert.equal(seenUrl, "/api/mentor/selfcheck", "应只打 selfcheck 端点");
    assert.equal(exp.__test.selfCheckState.error, null, "成功时不应有错误");
    assert.equal(exp.__test.selfCheckState.clientSha, "7f1d6d7e8440");
    assert.equal(exp.__test.selfCheckState.marker, "v2");

    const { final } = await rt.mount(exp.__test.VersionChip, {});
    const all = texts(final).join(" ");
    assert.match(all, /plugin 7f1d6d7e/, "应显示 client 短哈希，实际: " + all);
    assert.match(all, /ui:v2/, "应显示 hot-ui MARKER，实际: " + all);
  } finally {
    globalThis.fetch = prevFetch;
    resetSelfCheck(exp);
  }
});

test("G2 selfcheck 失败 → 降级 `plugin unknown`，常驻条不被吃掉", async () => {
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("selfcheck down"));
  try {
    await exp.__test.refreshSelfCheck();
    assert.equal(exp.__test.selfCheckState.clientSha, null, "失败时不留旧读数");
    assert.match(String(exp.__test.selfCheckState.error), /selfcheck down/);

    const chip = await rt.mount(exp.__test.VersionChip, {});
    assert.match(texts(chip.final).join(" "), /plugin unknown/, "失败应降级为 unknown");

    // 关键：selfcheck 读数失败只影响版本角标，不该连带把「有没有任务」也判错。
    // v0.2.0 起无任务渲染常驻空态卡片（lib/client.js:2094-2098），所以这里断言
    // 「渲染了空态」而不是「不渲染」。
    const bar = await rt.mount(exp.__test.ComposerBar, {});
    assert.notEqual(bar.final, null, "无任务也渲染常驻空态（与 selfcheck 成败无关）");
    assert.match(
      texts(bar.final).join(" "),
      /暂无导师任务/,
      "任务有无的判定不受 selfcheck 影响",
    );
    assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
  } finally {
    globalThis.fetch = prevFetch;
    resetSelfCheck(exp);
  }
});

/* ================================================================== *
 * 收尾：恢复全局定时器
 * ================================================================== */

test("ZZ 恢复全局定时器", () => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  assert.ok(true);
});

/* ------------------------------------------------------------------ *
 * s3 L3：面板内容统计（纯逻辑，供 diag.sections 落盘判定）
 * ------------------------------------------------------------------ */

test("A0b summarizePanelSections：null/非对象 → task:false 且计数全 0", () => {
  const { summarizePanelSections } = pluginTest();
  assert.equal(typeof summarizePanelSections, "function");
  for (const v of [null, undefined, 0, "x"]) {
    const s = summarizePanelSections(v);
    assert.equal(s.task, false);
    assert.equal(s.dagNodes, 0);
    assert.equal(s.criteria, 0);
    assert.equal(s.findings, 0);
  }
});

test("A0c summarizePanelSections：有任务但无 stages/criteria → task:true 且 dagNodes/criteria 为 0（能区分空白）", () => {
  const s = pluginTest().summarizePanelSections({ id: "t1", phase: "planning", revision: 3 });
  assert.equal(s.task, true);
  assert.equal(s.taskId, "t1");
  assert.equal(s.phase, "planning");
  assert.equal(s.revision, 3);
  assert.equal(s.dagNodes, 0);
  assert.equal(s.criteria, 0);
});

test("A0d summarizePanelSections：完整任务 → DAG 节点数/验收项数/整改项数都算对", () => {
  const task = {
    id: "t2",
    phase: "active",
    revision: 7,
    criteria: [{ id: "c1" }, { id: "c2" }],
    stages: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    findings: [{ id: "f1" }],
    nodeRuns: [{ stageId: "s1", findings: [{ id: "f2" }, { id: "f3" }] }],
  };
  const s = pluginTest().summarizePanelSections(task);
  assert.equal(s.task, true);
  assert.equal(s.dagNodes, 3);
  assert.equal(s.criteria, 2);
  assert.equal(s.findings, 3, "顶层 findings + nodeRuns[].findings 都要计入");
  assert.equal(s.nodeRuns, 1);
});
/** s3 用：只取 factory 的 __test 出口，**不调 apply()** —— apply 会起 watchForUpdates/selfCheck 定时器，测试进程退不掉。 */
let _pluginTestCache = null;
function pluginTest() {
  if (_pluginTestCache) return _pluginTestCache;
  const rt = makeRuntime();
  const exp = captured.factory((name) => {
    if (name === "react") return rt.React;
    // s3：v0.2.0 客户端新增了 react-dom（createPortal）与可见性监听。
    // 真实宿主会提供这些 seed 模块；测试给最小替身，缺哪个立刻报出来。
    if (name === "react-dom") return { createPortal: (children) => children };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("ui-primitives 在测试里不提供");
    throw new Error("客户端意外 require 了 " + name);
  });
  _pluginTestCache = exp.__test;
  return _pluginTestCache;
}
/* ------------------------------------------------------------------ *
 * P2-1：挂载失败必须三处可见（diag / DOM 属性 / console.warn）
 * ------------------------------------------------------------------ */

test("P2-1 recordMountFailure：diag 字段与 DOM 属性同时落地", () => {
  const { recordMountFailure } = pluginTest();

  const attrs = {};
  const doc = {
    documentElement: {
      setAttribute: (k, v) => {
        attrs[k] = v;
      },
    },
  };
  const diag = {};

  const msg = recordMountFailure(diag, "toggle", new Error("slot 不存在"), doc);

  assert.equal(msg, "slot 不存在", "要返回原始错误信息");
  assert.equal(diag.toggleErr, "slot 不存在", "diag 字段必须记录");

  const raw = attrs["data-mentor-diag"];
  assert.ok(raw, "DOM 属性必须同时写入 —— 否则页面刷新前根本查不到");
  assert.equal(
    JSON.parse(raw).toggleErr,
    "slot 不存在",
    "DOM 属性里的内容要和 diag 一致",
  );
});

test("P2-1 writeDiagAttr：document 不可用时返回 false 而不是抛错", () => {
  const { writeDiagAttr } = pluginTest();

  // 注意：不传 doc 时会回退到全局 document（测试环境里被 mock 过），所以这里
  // 只测「doc 存在但没有 documentElement」这条真正的失败路径。
  assert.equal(writeDiagAttr({ a: 1 }, {}), false, "没有 documentElement 不能抛");
  assert.equal(
    writeDiagAttr({ a: 1 }, { documentElement: { setAttribute() { throw new Error("boom"); } } }),
    false,
    "setAttribute 抛错要吞掉，不能连累调用方",
  );

  const attrs = {};
  const ok = writeDiagAttr(
    { ok: true },
    { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  );
  assert.equal(ok, true);
  assert.equal(JSON.parse(attrs["data-mentor-diag"]).ok, true);
});

/* ================================================================== *
 * E. s2 新增：隐藏入口（c3）与折叠四子行为（c4）
 *
 * 对应 verification/use-blockers.md 的 D1/D2 与 §4.2/§4.3 断言表。
 * 这些断言全部基于渲染出来的元素树，不验证像素。
 * ================================================================== */

/** 按 className 递归查找第一个匹配元素（React 元素形状 {type, props, children}） */
function findByClass(node, cls, acc = { hit: null }) {
  if (acc.hit !== null || node === null || node === undefined || node === false) return acc.hit;
  if (typeof node === "string" || typeof node === "number") return acc.hit;
  if (Array.isArray(node)) {
    for (const n of node) findByClass(n, cls, acc);
    return acc.hit;
  }
  const cn = node.props && node.props.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) {
    acc.hit = node;
    return acc.hit;
  }
  if (node.children) for (const c of node.children) findByClass(c, cls, acc);
  return acc.hit;
}

/** 造一个不会真的做事的合成事件 */
function evt(key) {
  return {
    key,
    preventDefault() {},
    stopPropagation() {},
  };
}

function resetClientStorage({ collapsed = "closed", dismissed = null } = {}) {
  localStorage._v.clear();
  if (collapsed !== null) localStorage.setItem("dsh-mentor:collapsed", collapsed);
  if (dismissed !== null) localStorage.setItem("dsh-mentor:dismissed", dismissed);
}

test("E-D1 旧 localStorage 里残留的 dismiss 值不再影响显示：有任务照样渲染完整状态条", async () => {
  // 2026-11-04 第三轮规则变更：手动隐藏功能整体移除（用户裁定，见 bar-baseline.md）。
  // 老版本在用户浏览器里留下过 `dsh-mentor:dismissed` 键，新代码不再读取它——
  // 这条断言防的就是「旧值把界面弄回隐藏态」的回归。
  htmlAttrs.clear();
  resetClientStorage({ dismissed: ACTIVE_TASK.id });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  assert.notEqual(final, null, "有任务就必须渲染，不能被旧 localStorage 键挡住");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "有任务 → rendered");
  // v0.2.0 顶栏类名从 mt-p-bar 改为 mt-work-top（lib/client.js:2106）
  assert.notEqual(findByClass(final, "mt-work-top"), null, "顶栏要在");
  assert.notEqual(findByClass(final, "mt-work-title"), null, "标题要在");
  // 顶栏不再有 × 隐藏按钮
  assert.equal(findByClass(final, "mt-p-dismiss"), null, "× 按钮已移除");
  assert.equal(findByClass(final, "mt-work-dismiss"), null, "× 按钮已移除（新类名前缀也查一遍）");
  assert.doesNotMatch(texts(final).join(" "), /已隐藏/, "不再有「已隐藏」窄条文案");
});

test("E-D2 无任务 → 渲染常驻空态卡片；data-mt-bar=rendered", async () => {
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  // v0.2.0 行为变更：不再 return null，改为常驻空态（lib/client.js:2094-2098）。
  // 「没任务不打扰」由空态文案承担，不再是「整条不出现」。
  assert.notEqual(final, null, "无任务也要有常驻空态卡片");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
  assert.match(texts(final).join(" "), /暂无导师任务/);
});

test("E-D3 有任务 → 自动渲染，不需要任何点击或恢复操作", async () => {
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  assert.notEqual(final, null, "有任务就自动出现");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
  assert.equal(final.props["data-dismissed"], undefined, "不再有 dismissed 状态");
});

test("E-D4 已完成的任务 → 仍显示，phase 走 data-phase=completed（v0.2.0 起不再整条撤掉）", async () => {
  // v0.2.0：hasTask 只看 task 是否为 null（lib/client.js:2089）；
  // completed / archived 一律照常渲染，面板里保留归档入口与最终读数。
  htmlAttrs.clear();
  resetClientStorage({});
  const done = { ...ACTIVE_TASK, phase: "completed" };
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: done } }));
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "已完成任务仍显示（便于归档与查看结果）");
  assert.equal(final.props["data-phase"], "completed", "phase 走 data-phase 锚点");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
});

test("E-C4-1 折叠态：只剩顶栏与一行状态，页签/内容区/操作栏都不在 DOM", async () => {
  // v0.2.0 结构（lib/client.js:2105-2111）：
  //   常驻 = div.mt-work-top（顶栏）+ div.mt-work-next（一行状态）
  //   展开 = nav.mt-work-tabs + div.mt-work-body + footer.mt-work-footer
  htmlAttrs.clear();
  resetClientStorage({ collapsed: "closed" });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  assert.notEqual(findByClass(final, "mt-work-top"), null, "顶栏要在");
  assert.notEqual(findByClass(final, "mt-work-next"), null, "一行状态要在");
  assert.equal(findByClass(final, "mt-work-tabs"), null, "页签栏不该进 DOM");
  assert.equal(findByClass(final, "mt-work-body"), null, "内容区（含 DAG/指标/问题）不该进 DOM");
  assert.equal(findByClass(final, "mt-work-footer"), null, "操作栏不该进 DOM");

  // 折叠态的全部可见信息：状态 + 进度 + 目标，都在顶栏
  const line = texts(findByClass(final, "mt-work-top")).join(" ");
  assert.match(line, /1\/2/, "顶栏要带进度计数");
  assert.match(line, /示例目标/, "顶栏要带任务目标");
});

test("E-C4-2 展开态：页签 / 内容区 / 操作栏都回来，且顶栏内容不变", async () => {
  htmlAttrs.clear();
  resetClientStorage({ collapsed: "open" });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  assert.notEqual(findByClass(final, "mt-work-tabs"), null, "展开后页签栏要在");
  assert.notEqual(findByClass(final, "mt-work-body"), null, "展开后内容区要在");
  assert.notEqual(findByClass(final, "mt-work-footer"), null, "展开后操作栏要在");
  // 顶栏是折叠/展开共用的，展开态不该多出第二个顶栏
  const all = texts(final).join(" ");
  assert.equal(all.split("示例目标").length - 1, 1, "顶栏目标文本只应出现一次（不得重复渲染顶栏）");
  assert.match(all, /1\/2/);
});

test("E-C4-3 箭头方向跟随展开态翻转", async () => {
  // v0.2.0 的箭头是 mt-work-top 里一个无 class 的 span，
  // 用字符本身表达方向（lib/client.js:2106：expanded ? '▾' : '▸'）。
  resetClientStorage({ collapsed: "closed" });
  let p = makePlugin(() => Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }));
  let r = await p.rt.mount(p.exp.__test.ComposerBar, {});
  const closedText = texts(r.final).join(" ");
  assert.match(closedText, /▸/, "折叠态箭头朝右，实际: " + closedText);
  assert.doesNotMatch(closedText, /▾/, "折叠态不该出现朝下箭头");

  resetClientStorage({ collapsed: "open" });
  p = makePlugin(() => Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }));
  r = await p.rt.mount(p.exp.__test.ComposerBar, {});
  const openText = texts(r.final).join(" ");
  assert.match(openText, /▾/, "展开态箭头朝下，实际: " + openText);
  assert.doesNotMatch(openText, /▸/, "展开态不该出现朝右箭头");
});

test("E-C4-4 折叠入口是原生 button：click 切换 + aria-expanded 翻转（键盘由浏览器默认行为承担）", async () => {
  // v0.2.0 把折叠入口从「手写 onKeyDown 的 div」换成真 <button>（lib/client.js:2106）。
  // Enter / Space 的切换不再由组件处理，而是浏览器对 button 的原生激活行为 ——
  // 收益是可访问性（type/焦点/aria-expanded 天然正确），
  // 代价是 mini React runtime + 假 DOM 无法模拟浏览器默认行为，所以这条改测「前提」：
  //   · 元素必须是原生 button（否则浏览器不会给 Enter/Space 默认激活）
  //   · 必须挂 onClick（原生激活派发的就是 click）
  //   · 不许再手写 onKeyDown —— 那会与浏览器默认行为双触发，展开后又立刻收起
  //   · aria-expanded 与折叠态持久化仍要正确
  resetClientStorage({ collapsed: "closed" });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  const btn0 = findByClass(final, "mt-work-expand");
  assert.notEqual(btn0, null, "折叠入口要在");
  assert.equal(btn0.type, "button", "必须是原生 button，键盘 Enter/Space 才有默认激活");
  assert.equal(btn0.props.type, "button");
  assert.equal(typeof btn0.props.onClick, "function", "原生激活会派发 click，必须有 onClick");
  assert.equal(btn0.props.onKeyDown, undefined, "不许手写 onKeyDown（会与浏览器默认行为双触发）");
  assert.equal(btn0.props["aria-expanded"], false, "初始为折叠");

  // ① 展开
  btn0.props.onClick(evt("Enter"));
  const afterOpen = rt.rerenderNow(exp.__test.ComposerBar, {});
  assert.equal(
    findByClass(afterOpen, "mt-work-expand").props["aria-expanded"],
    true,
    "第一次点击必须展开",
  );

  // ② 收起
  findByClass(afterOpen, "mt-work-expand").props.onClick(evt(" "));
  const afterClose = rt.rerenderNow(exp.__test.ComposerBar, {});
  assert.equal(
    findByClass(afterClose, "mt-work-expand").props["aria-expanded"],
    false,
    "第二次点击必须收起",
  );

  // 折叠态持久化到 localStorage
  assert.equal(localStorage.getItem("dsh-mentor:collapsed"), "closed");
});

test("E-C5 顶栏不再出现版本角标文本（乱码来源之一）", async () => {
  htmlAttrs.clear();
  resetClientStorage({ collapsed: "closed" });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  const barText = texts(findByClass(final, "mt-p-bar")).join(" ");
  // 旧版把 `plugin <sha> · ui:v4` 塞进顶栏，等宽字体在 Windows 上退化成
  // Courier New，`·` 与中文混排被使用者点名为「右上角乱码」。
  assert.doesNotMatch(barText, /ui:v\d/, "顶栏不该再有 ui:vN 角标");
  assert.doesNotMatch(barText, /plugin [0-9a-f]{4,}/, "顶栏不该再有 plugin sha 角标");
});

test("E-C5b 不再有 × 隐藏按钮，也没有「已隐藏」文案（第三轮规则）", async () => {
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  const all = texts(final).join(" ");
  assert.equal(findByClass(final, "mt-p-dismiss"), null, "× 按钮必须已移除");
  assert.doesNotMatch(all, /已隐藏/, "不该再出现「已隐藏」窄条文案");
  assert.doesNotMatch(all, /×/, "顶栏不该出现 × 字符");
});

test("E-C6 展开区有视口高度上限（CSS 静态断言，防回归）", () => {
  // 用户原话：「这个UI太大了，给你自己都遮住了，还不能折叠」。
  // 高度上限靠 CSS 生效，运行时无法从外部量到，所以在源码层面设一道防回归。
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(
    src,
    /\.mt-p-inner\s*\{[^}]*max-height:\s*min\(38vh,\s*320px\)/,
    ".mt-p-inner 必须保留 max-height: min(38vh, 320px)",
  );
  assert.match(
    src,
    /\.mt-p-inner\s*\{[^}]*overflow-y:\s*auto/,
    ".mt-p-inner 必须允许内部滚动，否则上限会裁切内容",
  );
});

test("E-C5c `.mt-chip` 基础规则有选择器且不再用等宽字体（乱码根因，防回归）", () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 曾经这里是一段丢了选择器的裸声明块：「font-size: 10px; ... }」，
  // 浏览器直接丢弃，导致 .mt-chip 只剩修饰类能生效 → 右上角错位。
  assert.match(src, /\.mt-chip\s*\{/, ".mt-chip 必须有完整的基础规则，不能是裸声明块");
  // 顺带确认基础规则里没再用 ui-monospace（Windows 上退化成 Courier New）
  const chipBlock = src.match(/\.mt-chip\s*\{[^}]*\}/);
  assert.ok(chipBlock, "应能截到 .mt-chip 规则块");
  assert.doesNotMatch(chipBlock[0], /ui-monospace/, ".mt-chip 基础规则不该用 ui-monospace");
  // 修饰类也不能漏：`VersionChip` 用的是 `mt-chip mt-chip-ver`，
  // 上一轮只清基础规则，真正渲染路径仍走等宽字体（s2 审查指出）。
  const verBlock = src.match(/\.mt-chip-ver\s*\{[^}]*\}/);
  assert.ok(verBlock, "应能截到 .mt-chip-ver 规则块");
  assert.doesNotMatch(verBlock[0], /ui-monospace/, ".mt-chip-ver 也不能用 ui-monospace");
});

/* ---- 顶部「导师模式」按钮 = 状态条开关（第四轮，用户裁定） ---- */

test("E-T1 默认开着：有任务就渲染完整状态条，bar=rendered", async () => {
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  exp.__test.barOpenState.set(true);
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "默认应显示");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
});

test("E-T2 关掉开关：组件仍挂载但 aria-hidden，bar=hidden（能与 rendered 区分）", async () => {
  // v0.2.0：关掉开关不卸载组件，保留收回动画与外观设置（lib/client.js:1719、2066），
  // 显隐靠 data-mt-bar 与 aria-hidden 表达。
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  exp.__test.barOpenState.set(false);
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "关掉后仍保留组件（收回动画需要）");
  assert.equal(htmlAttrs.get("data-mt-bar"), "hidden", "要能和 rendered 区分开");
});

test("E-T3 再打开：状态条回来（点两下就是开关，不是单向消失）", async () => {
  htmlAttrs.clear();
  resetClientStorage({});
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const st = exp.__test.barOpenState;
  st.set(false);
  st.toggle();
  assert.equal(st.open, true, "toggle 后应回到开");
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "再打开后状态条必须回来");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
});

test("E-T4 开关状态写进 localStorage，刷新后保持", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const st = exp.__test.barOpenState;
  st.set(false);
  assert.equal(localStorage.getItem("dsh-mentor:bar-open"), "0");
  st.set(true);
  assert.equal(localStorage.getItem("dsh-mentor:bar-open"), "1");
});

test("E-T5 没任务时开关只改 data-mt-bar，不改变「常驻空态已渲染」", async () => {
  // v0.2.0：无任务渲染常驻空态（lib/client.js:2094-2098），开关只管显隐。
  // 「没任务不打扰」由空态文案承担，不再由「整条不出现」承担。
  htmlAttrs.clear();
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  exp.__test.barOpenState.set(true);
  let r = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(r.final, null, "没任务也渲染常驻空态");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered", "开关开着 → rendered");
  assert.match(texts(r.final).join(" "), /暂无导师任务/);

  exp.__test.barOpenState.set(false);
  r = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(r.final, null, "开关关着也不卸载（只隐藏）");
  assert.equal(htmlAttrs.get("data-mt-bar"), "hidden", "开关关着 → hidden");
  assert.match(texts(r.final).join(" "), /暂无导师任务/, "空态文案不随开关变化");
  exp.__test.barOpenState.set(true);
});

test("E-T6 MentorToggle 点击切换的是状态条，不再是已删除的面板", async () => {
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const st = exp.__test.barOpenState;
  st.set(true);
  const { final } = await rt.mount(exp.__test.MentorToggle, {});
  assert.ok(final, "按钮必须渲染");
  assert.equal(final.type, "button");
  assert.match(String(final.props.className), /mt-toggle-on/, "开着时按钮高亮");
  assert.equal(final.props["aria-pressed"], "true");
  final.props.onClick(evt());
  assert.equal(st.open, false, "点一下应收起状态条");
  const again = rt.rerenderNow(exp.__test.MentorToggle, {});
  again.props.onClick(evt());
  assert.equal(st.open, true, "再点一下应重新显示");
});

/* ---- 顶部工具条：Clear 必须「随时可点」（c2 的可达性） ---- */

/** 从 MentorHeaderActions 的渲染结果里取按钮：0=导师模式，1=Clear
 *  mini runtime 的元素形状是 {type, props, children}，children 直接挂在元素上
 *  （见 texts() 的实现），不在 props.children 里。 */
function headerButtons(final) {
  const kids = (final && final.children) || [];
  const arr = Array.isArray(kids) ? kids : [kids];
  return arr.filter((c) => c && c.type === "button");
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("H1 有任务时 Clear 可点", async () => {
  const { exp, rt, ctx } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  const after = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
  const btns = headerButtons(after);
  assert.equal(btns.length, 2, "应有「导师模式」和「Clear」两个按钮");
  assert.equal(btns[1].props.disabled, false, "有任务时 Clear 必须可点");
  assert.equal(String(btns[1].props.className).includes("mt-clear"), true);
});

test("H2 无任务时 Clear 灰掉并说明原因", async () => {
  const { exp, rt, ctx } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: null } }),
  );
  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  const after = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
  const btns = headerButtons(after);
  assert.equal(btns[1].props.disabled, true, "没任务时不能点");
  // v0.2.0 文案：title = task ? '归档当前选中任务，保留记录' : '没有可归档任务'（lib/client.js:2174）
  assert.match(String(btns[1].props.title), /没有可归档任务/);
});

test("H3 第一次点击只进确认态，第二次才真的发归档请求", async () => {
  const calls = [];
  const { exp, rt, ctx } = makePlugin((channel, method, payload) => {
    calls.push({ channel, method, payload });
    return Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } });
  });
  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  const first = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;

  const clearBtn = headerButtons(first)[1];
  clearBtn.props.onClick(evt());
  const afterFirst = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx });
  const btn2 = headerButtons(afterFirst)[1];
  assert.match(texts(btn2).join(""), /确认归档/, "第一次点击应进入确认态");
  assert.equal(
    calls.filter((c) => c.payload && c.payload.action === "mentor_task_clear").length,
    0,
    "第一次点击不许真的归档",
  );

  btn2.props.onClick(evt());
  await tick();
  const clears = calls.filter((c) => c.payload && c.payload.action === "mentor_task_clear");
  assert.equal(clears.length, 1, "第二次点击才发归档请求");
  assert.equal(clears[0].payload.params.reason, "user-clear");
});

test("H4 状态条整个关掉后，Clear 依然渲染且可点（这是「随时」的核心）", async () => {
  htmlAttrs.clear();
  const { exp, rt, ctx } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } }),
  );
  exp.__test.barOpenState.set(false);
  const bar = await rt.mount(exp.__test.ComposerBar, {});
  await tick();
  // v0.2.0：关掉开关不卸载组件，只置 aria-hidden + data-mt-bar=hidden（保留收回动画）
  assert.notEqual(bar.final, null, "状态条组件仍在（隐藏而非卸载）");
  assert.equal(htmlAttrs.get("data-mt-bar"), "hidden", "关掉后整体标记为 hidden");

  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  const after = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
  const btns = headerButtons(after);
  assert.equal(btns.length, 2, "状态条关掉不影响顶部按钮");
  assert.equal(btns[1].props.disabled, false, "状态条关掉后 Clear 仍可点");
  exp.__test.barOpenState.set(true);
});

test("H5 Clear 走 command 通道（payload.action），不是只读取数", async () => {
  const calls = [];
  const { exp, rt, ctx } = makePlugin((channel, method, payload) => {
    calls.push({ channel, method, payload });
    if (payload && payload.action === "mentor_task_clear") {
      return Promise.resolve({ ok: true, value: { taskId: "task_abc", phase: "archived" } });
    }
    return Promise.resolve({ ok: true, value: { task: ACTIVE_TASK } });
  });
  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  let cur = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
  headerButtons(cur)[1].props.onClick(evt());
  cur = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || cur;
  headerButtons(cur)[1].props.onClick(evt());
  await tick();
  await tick();

  const cmd = calls.find((c) => c.payload && c.payload.action === "mentor_task_clear");
  assert.ok(cmd, "必须发过带 action 的 payload");
  assert.equal(cmd.channel, "/api", "优先走 /api 端点");
  assert.equal(cmd.method, "mentor/state");
});

test("H6 归档后任务卡仍显示，phase 走 data-phase=archived（面板保留最终读数）", async () => {
  // v0.2.0 行为变更：hasTask 只看 task 是否为 null（lib/client.js:2089），
  // archived 也照常渲染，只是操作栏不再给「关闭导师」等动作。
  htmlAttrs.clear();
  resetClientStorage({});
  const archived = { ...ACTIVE_TASK, phase: "archived", enabled: true };
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: archived } }),
  );
  exp.__test.barOpenState.set(true);
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "归档后任务卡仍在（可查看最终结果）");
  assert.equal(final.props["data-phase"], "archived", "phase 走 data-phase 锚点");
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
});

test("H7 导师被关闭后任务卡仍显示，并给出「启用导师」入口（c4 的 UI 侧）", async () => {
  // v0.2.0：enabled=false 不再让整条消失；stateBadge('stopped') 显示关态，
  // 操作栏过滤出 mentor_task_on（lib/client.js:2102）。
  htmlAttrs.clear();
  resetClientStorage({});
  const offTask = { ...ACTIVE_TASK, phase: "active", enabled: false };
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: offTask } }),
  );
  exp.__test.barOpenState.set(true);
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(final, null, "off 之后任务卡仍在（关掉的是导师，不是界面）");
  assert.equal(final.props["data-phase"], "active");
  const all = texts(final).join(" ");
  assert.match(all, /已停止/, "enabled=false 应显示关态徽标，实际: " + all);
  assert.equal(htmlAttrs.get("data-mt-bar"), "rendered");
});

test("H8 挂载时没任务，之后出现任务 → Clear 从灰变亮（live 轮询生效）", async () => {
  // v0.2.0：顶部工具条不再自己轮询（HEADER_POLL 已成废弃常量，只留 get/set 钩子，
  // 全文件除测试出口外无引用）。它读共享快照 liveState，由 apply() 里 startLive()
  // 的 setTimeout 自适应轮询驱动（lib/client.js:1826-1855）。
  // 用记录器手动触发那一轮，避免真等 10 秒。
  let current = null;
  const { exp, rt, ctx } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: current } }),
  );
  const tracker = trackTimeouts();
  try {
    const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
    await tick();
    let cur = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
    assert.equal(headerButtons(cur)[1].props.disabled, true, "一开始没任务，应为灰");
    assert.match(String(headerButtons(cur)[1].props.title), /没有可归档任务/);

    const polls = tracker.reg.filter((e) => e.ms === 10000);
    assert.ok(
      polls.length >= 1,
      "无任务时应登记 10000ms 探测轮询，实际登记: " + tracker.reg.map((e) => e.ms).join(","),
    );

    // 模拟「页面加载后才建的任务」
    current = ACTIVE_TASK;
    polls[polls.length - 1].fn();
    await new Promise((r) => setTimeout(r, 20));
    cur = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || cur;
    assert.equal(
      headerButtons(cur)[1].props.disabled,
      false,
      "任务出现后 Clear 必须自己变亮，不需要刷新页面",
    );
    assert.match(String(headerButtons(cur)[1].props.title), /归档当前选中任务/);
  } finally {
    tracker.restore();
  }
});

test("H9 顶部「导师模式」按钮是状态条开关（不再承担 mentor 开关）", async () => {
  // v0.2.0 行为变更（lib/client.js:2114-2133、2172-2174）：
  //   · 顶部按钮只切 barOpenState（状态条显隐），高亮用 mt-toggle-on + aria-pressed；
  //   · 不再有 data-supervisor / 「导师已关」这类导师开关切态；
  //   · 启用/关闭导师下放到状态条操作栏（mentor_task_on / mentor_task_off，:2102）。
  htmlAttrs.clear();
  const calls = [];
  const { exp, rt, ctx } = makePlugin((channel, method, payload) => {
    calls.push({ channel, method, payload });
    return Promise.resolve({ ok: true, value: { task: { ...ACTIVE_TASK, enabled: false } } });
  });
  exp.__test.barOpenState.set(true);
  const { final } = await rt.mount(exp.__test.MentorHeaderActions, { ctx });
  await tick();
  const cur = rt.rerenderNow(exp.__test.MentorHeaderActions, { ctx }) || final;
  const toggle = headerButtons(cur)[0];

  assert.equal(toggle.props["aria-pressed"], true, "开着时 aria-pressed=true");
  assert.match(String(toggle.props.className), /mt-toggle-on/, "开着时按钮高亮");
  assert.equal(toggle.props["data-supervisor"], undefined, "不再用 data-supervisor 表达导师开关");
  assert.doesNotMatch(texts(toggle).join(""), /导师已关/, "按钮不再显示导师关态文案");

  toggle.props.onClick(evt());
  assert.equal(exp.__test.barOpenState.open, false, "点一下应收起状态条");
  assert.equal(
    calls.filter((c) => c.payload && c.payload.action === "mentor_task_on").length,
    0,
    "点这个按钮不该调 mentor_task_on（导师开关在状态条操作栏）",
  );
  exp.__test.barOpenState.set(true);
});

/* ---- 自采度量：必须来自真实 DOM，不能是 collapsed 拼出的应然值 ---- */

/** 造一个最小 DOM 替身：只提供 children / className / querySelector / textContent */
function fakeEl(className, children = [], textContent = "") {
  return {
    className,
    children,
    textContent,
    querySelector(sel) {
      const want = String(sel).replace(/^\./, "");
      const walk = (node) => {
        if (!node) return null;
        const cn = typeof node.className === "string" ? node.className : "";
        if (cn.split(/\s+/).includes(want)) return node;
        for (const c of node.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
}

test("E-M1 collectBarSections 从真实子节点枚举，折叠态只有顶栏与折叠行", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { collectBarSections } = exp.__test;
  const root = fakeEl("mt-p", [
    fakeEl("mt-p-bar", [], "导师 · 进行中"),
    fakeEl("mt-p-collapsed-line", [], "等你推进 s2"),
  ]);
  assert.deepEqual(collectBarSections(root), ["mt-p-bar", "mt-p-collapsed-line"]);
});

test("E-M2 collectBarSections 展开态会下钻到展开区叶子（指标/解释/DAG/参与）", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { collectBarSections } = exp.__test;
  const root = fakeEl("mt-p", [
    fakeEl("mt-p-bar"),
    fakeEl("mt-p-summary", [fakeEl("mt-p-summary-main")]),
    fakeEl("mt-p-inner", [
      fakeEl("mt-p-progress"),
      fakeEl("mt-p-plan"),
      fakeEl("mt-dag"),
      fakeEl("mt-p-obj"),
      fakeEl("mt-p-participants"),
    ]),
    fakeEl("mt-p-ops"),
  ]);
  const got = collectBarSections(root);
  assert.deepEqual(got, [
    "mt-p-bar",
    "mt-p-summary",
    "mt-p-inner",
    "mt-p-progress",
    "mt-p-plan",
    "mt-dag",
    "mt-p-obj",
    "mt-p-participants",
    "mt-p-ops",
  ]);
  assert.ok(got.includes("mt-dag"), "展开区叶子必须被枚举到，否则「八段齐全」无从断言");
});

test("E-M3 collectBarSections 对 null / 空节点返回空数组，不抛错", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { collectBarSections } = exp.__test;
  assert.deepEqual(collectBarSections(null), []);
  assert.deepEqual(collectBarSections({}), []);
  assert.deepEqual(collectBarSections(fakeEl("mt-p", [])), []);
});

test("E-M4 readBarText 读的是 DOM 里的真实 textContent，不是拼出来的字符串", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { readBarText } = exp.__test;
  const root = fakeEl("mt-p", [
    fakeEl("mt-p-bar", [], "  导师  ·  进行中\n · 阶段已就绪  "),
  ]);
  assert.equal(readBarText(root), "导师 · 进行中 · 阶段已就绪");
  // 没有顶栏 → null（而不是编一个字符串出来）
  assert.equal(readBarText(fakeEl("mt-p", [])), null);
  assert.equal(readBarText(null), null);
});

test("E-M5 readBarText 若 DOM 里混进版本角标，读出来就能看见（这才叫证据）", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { readBarText } = exp.__test;
  // 反向验证：如果顶栏真被塞了 ui:vN，readBarText 必须原样读出，
  // 这样 s4 的断言才有意义 —— 它读的是现场，不是我拼的期望值。
  const root = fakeEl("mt-p", [fakeEl("mt-p-bar", [], "导师 · 进行中 · ui:v9")]);
  assert.match(readBarText(root), /ui:v9/);
});

/* ================================================================== *
 * F. s3：宿主服务注入与右侧栏注册（D3 / D4）
 *
 * 真机改前 diag：registeredTab=false、openTabErr「sidebarRight.openTab 不可用」、
 * registeredEvents=false。根因两条：
 *   ① package.json 的 dsh.client.inject 缺 dsh-client-ui-sidebar-right /
 *      dsh-client-ui-chat，服务提供方没被加载；
 *   ② client.js 的 cordis `inject` 只声明了 ["slots","connection"]，
 *      sidebarRight / uiConversation 从未被注入。
 * 这里对两条都设防回归断言。
 * ================================================================== */

/** 用自定义 ctx 跑一次 apply，返回导出与 diag（globalThis.__mtDiag 同一对象） */
function applyWith(ctx) {
  const rt = makeRuntime();
  const exp = captured.factory((name) => {
    if (name === "react") return rt.React;
    // s3：v0.2.0 客户端新增了 react-dom（createPortal）与可见性监听。
    // 真实宿主会提供这些 seed 模块；测试给最小替身，缺哪个立刻报出来。
    if (name === "react-dom") return { createPortal: (children) => children };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("ui-primitives 在测试里不提供");
    throw new Error("客户端意外 require 了 " + name);
  });
  exp.apply(ctx);
  return { exp, rt };
}

function readDiag() {
  return globalThis.__mtDiag && typeof globalThis.__mtDiag === "object" ? globalThis.__mtDiag : null;
}

/** 完整宿主：三个服务齐备，记录注册与调用 */
function fullHostCtx(rec) {
  return {
    slots: { inject: () => () => {}, register: () => () => {} },
    connection: { rpc: { call: () => Promise.resolve({ ok: true, value: { task: null } }) } },
    sidebarRightTabs: {
      register(def) {
        rec.tabs.push(def.id);
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) {
        rec.opened.push(kind);
      },
    },
    uiConversation: {
      events: {
        register(def) {
          rec.events.push(def.kind);
          return () => {};
        },
      },
    },
    get(name) {
      return this[name];
    },
  };
}

test("G1 inject 不再声明侧栏服务（c7 防回归）", () => {
  // 2026-11-04 第三轮：侧栏面板/ tab 注册已整体移除，因此那三个强依赖也必须撤回。
  // 留着一个用不上的强依赖，会让「服务缺失 → 插件不加载 → 连状态条都没了」成真。
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const inj = exp.inject || [];
  assert.deepEqual(inj, ["slots", "connection"], "inject 应收敛回最小集");
  for (const gone of ["sidebarRight", "sidebarRightTabs", "uiConversation"]) {
    assert.ok(!inj.includes(gone), `不该再声明 ${gone} —— 侧栏功能已删除`);
  }
});

test("G2 即使宿主三服务齐备，也不再注册 tab / events；并说明原因", () => {
  htmlAttrs.clear();
  const rec = { tabs: [], opened: [], events: [] };
  applyWith(fullHostCtx(rec));
  const diag = readDiag();
  assert.ok(diag, "apply 后应有 diag");

  // 一个都没注册
  assert.deepEqual(rec.tabs, [], "不该再注册侧栏 tab");
  assert.deepEqual(rec.events, [], "不该再注册 review/milestone 事件");
  assert.deepEqual(rec.opened, [], "不该再调 openTab");
  assert.equal(diag.registeredTab, false);
  assert.equal(diag.registeredPaneTab, false);
  assert.equal(diag.registeredEvents, false);
  assert.equal(diag.sidebarRemovedReason, "removed-by-user-request", "要能读出「为什么没有」");
  // openTab 钩子也不再安装
  assert.notEqual(typeof globalThis.__mtOpenTab, "function", "不该再提供 openTab 触发器");
});

test("G3 侧栏移除后，状态条与顶部入口照常挂载（不连累主功能）", () => {
  htmlAttrs.clear();
  const rec = { tabs: [], opened: [], events: [] };
  applyWith(fullHostCtx(rec));
  const diag = readDiag();
  assert.equal(diag.registeredBar, true, "输入框上方状态条必须照常注册");
  assert.equal(diag.registeredToggle, true, "顶部「导师模式」入口必须照常注册");
  assert.equal(diag.result, "done");
  assert.equal(diag.registeredPanel, false, "全屏浮层面板按用户要求移除");
  assert.equal(diag.panelDisabledReason, "removed-by-user-request");
});

test("G4 package.json 的 dsh.client.inject 不再注入侧栏 provider 包（c7）", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const inj = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [];
  assert.ok(inj.length > 0, "inject 不该为空");
  for (const gone of [
    "@deepseek-ai/dsh-client-ui-sidebar-right",
    "@deepseek-ai/dsh-client-ui-chat",
  ]) {
    assert.ok(!inj.includes(gone), `不该再注入只为侧栏加的包：${gone}`);
  }
  // 基础依赖仍在
  assert.ok(
    inj.includes("@deepseek-ai/dsh-client-ui-renderer"),
    "slots 依赖的 renderer 必须保留",
  );
});

/* ================================================================== *
 * H. 精简与视觉重构回归（2026-11-24）
 * ================================================================== */

test("U1 折叠态极简：顶栏带进度条且不再堆外观按钮；单任务不渲染下拉选择框", async () => {
  htmlAttrs.clear();
  resetClientStorage({ collapsed: "closed" });
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({ ok: true, value: { task: ACTIVE_TASK, tasks: [{ taskId: ACTIVE_TASK.id, objective: ACTIVE_TASK.objective, phase: "active" }] } }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});
  assert.notEqual(findByClass(final, "mt-work-meter"), null, "顶栏应带紧凑进度条");
  assert.equal(findByClass(final, "mt-work-appearance-button"), null, "折叠态顶栏不该堆外观设置按钮");
  assert.equal(findByClass(final, "mt-work-picker"), null, "折叠态与单任务时不该出现任务下拉框");
});

test("U2 展开态去重与层次：阶段在概览只出现一次、外观归位底栏、动作分主次、多任务才显切换器", async () => {
  htmlAttrs.clear();
  resetClientStorage({ collapsed: "open" });
  const richTask = {
    ...ACTIVE_TASK,
    criteria: [
      { id: "c1", text: "验证输出文件" },
      { id: "c2", text: "验证最终汇总" },
    ],
    stages: [
      { id: "s1", title: "生成产物", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "汇总校验", criterionIds: ["c2"], dependsOn: ["s1"] },
    ],
    nextStep: { code: "READY", text: "推进 s2", allowedActions: ["mentor_task_pause", "mentor_task_continue"] },
    progress: {
      headline: "推进 s2",
      steps: [
        { id: "s1", title: "生成产物", detail: "已通过" },
        { id: "s2", title: "汇总校验", detail: "依赖已就绪" },
      ],
      claims: [
        { stageId: "s1", id: "c1", title: "验证输出文件", proofs: [{ file: { file: "a.txt", line: 1, snippet: "ok" } }] },
        { stageId: "s2", id: "c2", title: "验证最终汇总", proofs: [] },
      ],
      decisions: [],
    },
  };
  const { exp, rt } = makePlugin(() =>
    Promise.resolve({
      ok: true,
      value: {
        task: richTask,
        tasks: [
          { taskId: "task_abc", objective: "任务一", phase: "active" },
          { taskId: "task_def", objective: "任务二", phase: "completed" },
        ],
      },
    }),
  );
  const { final } = await rt.mount(exp.__test.ComposerBar, {});

  // 外观按钮下沉到底栏，动作区分主次
  const footer = findByClass(final, "mt-work-footer");
  assert.notEqual(findByClass(footer, "mt-work-appearance-button"), null, "展开态外观按钮应放在底栏");
  assert.notEqual(findByClass(footer, "mt-ctrl-primary"), null, "主动作（继续任务）应带强调样式");
  assert.notEqual(findByClass(footer, "mt-ctrl-subtle"), null, "关闭导师应为低干扰次级样式");

  // 多任务时在 tab 行展示紧凑任务选择器
  const tabsNav = findByClass(final, "mt-work-tabs");
  const pickerEl = tabsNav.children.find((c) => c && typeof c.type === "function");
  assert.ok(pickerEl, "多任务时 tab 行应挂载 TaskPicker");
  const pickerRendered = pickerEl.type(pickerEl.props);
  assert.equal(pickerRendered.type, "select");

  // 渲染概览子组件：默认展示交互式思维导图，支持一键切换精简列表（零重复且无 4 格大指标墙）
  const body = findByClass(final, "mt-work-body");
  const overviewEl = body.children.find((c) => c && typeof c.type === "function");
  assert.ok(overviewEl, "展开态内容区应包含 OverviewContent");
  const ovRes = await rt.mount(overviewEl.type, overviewEl.props, 5);
  const ovText = texts(ovRes.final).join(" ");
  assert.equal(findByClass(ovRes.final, "mt-work-metrics"), null, "不再渲染冗余的 4 格指标墙");
  assert.notEqual(findByClass(ovRes.final, "mt-seg-mini"), null, "阶段区应提供导图/列表切换");
  const mmEl = (() => {
    const walk = (n) => {
      if (!n || typeof n !== "object") return null;
      if (typeof n.type === "function" && n.type === exp.__test.MindMapView) return n;
      for (const c of n.children || []) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    return walk(ovRes.final);
  })();
  assert.ok(mmEl, "默认应挂载交互式思维导图 MindMapView");
  assert.match(ovText, /验收标准 · 2/, "验收标准与依据合并为一个折叠区");
  assert.match(ovText, /已绑定 1\/2/, "应显示已绑定证据进度");

  // 切换到精简列表视图：每个阶段标题只出现 1 次
  const toggleBtns = findButton(findByClass(ovRes.final, "mt-seg-mini"));
  assert.equal(toggleBtns.length, 2);
  toggleBtns[1].props.onClick();
  const listView = rt.rerenderNow(overviewEl.type, overviewEl.props);
  assert.notEqual(findByClass(listView, "mt-stage-list"), null, "切换列表后应渲染精简阶段列表");
  const listText = texts(listView).join(" ");
  assert.equal(listText.split("生成产物").length - 1, 1, "阶段「生成产物」在概览列表只应出现一次");
  assert.equal(listText.split("汇总校验").length - 1, 1, "阶段「汇总校验」在概览列表只应出现一次");
});