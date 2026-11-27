/**
 * Round 4 · Calm UI 12-item acceptance suite (aligned with GPT-6.2 v1.0 spec).
 * Uses the same lightweight React runtime pattern as test/client.test.mjs — verifies
 * element-tree contracts, pure state transitions, CSS tokens, ARIA, and focus calls
 * (not real browser layout/pixel rendering).
 */

import test from "node:test";
import assert from "node:assert/strict";

const focusedIds = [];
const htmlAttrs = new Map();

globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
  hidden: false,
  body: { appendChild() {}, setAttribute() {}, style: {} },
  documentElement: {
    setAttribute(k, v) { htmlAttrs.set(k, String(v)); },
    getAttribute(k) { return htmlAttrs.has(k) ? htmlAttrs.get(k) : null; },
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  getElementById: (id) => ({
    id,
    focus(opts) { focusedIds.push({ id, opts }); },
  }),
};

globalThis.window = {
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame() {},
  getComputedStyle: () => ({ getPropertyValue: () => "", width: "0px", height: "0px" }),
};
globalThis.location = { search: "" };
globalThis.localStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};

function makeRuntime() {
  const hookStore = [];
  let idx = 0;
  let rerender = null;
  const React = {
    useState(init) {
      const i = idx++;
      if (!(i in hookStore)) hookStore[i] = typeof init === "function" ? init() : init;
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
      let run = !prev || !Array.isArray(deps);
      if (!run) {
        const old = prev.deps || [];
        run = deps.length !== old.length || deps.some((d, k) => !Object.is(d, old[k]));
      }
      if (run) {
        if (prev?.cleanup) prev.cleanup();
        const cleanup = fn();
        hookStore[i] = { deps: Array.isArray(deps) ? deps : null, cleanup: typeof cleanup === "function" ? cleanup : null };
      }
    },
    useLayoutEffect(fn, deps) { return this.useEffect(fn, deps); },
    useRef(v) {
      const i = idx++;
      if (!(i in hookStore)) hookStore[i] = { current: v };
      return hookStore[i];
    },
    useMemo(fn) {
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
  async function mount(Component, props, settleMs = 15) {
    hookStore.length = 0;
    rerender = () => { idx = 0; return Component(props); };
    idx = 0;
    const first = Component(props);
    await new Promise((r) => setTimeout(r, settleMs));
    idx = 0;
    return { first, final: Component(props) };
  }
  function rerenderNow(Component, props) {
    rerender = () => { idx = 0; return Component(props); };
    idx = 0;
    return Component(props);
  }
  return { React, mount, rerenderNow };
}

function findAll(node, pred, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, acc); return acc; }
  if (pred(node)) acc.push(node);
  if (node.children) for (const c of node.children) findAll(c, pred, acc);
  return acc;
}
function hasClass(node, cls) {
  return typeof node?.props?.className === "string" && node.props.className.split(/\s+/).includes(cls);
}
function texts(node, acc = []) {
  if (node == null || node === false) return acc;
  if (typeof node === "string" || typeof node === "number") { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { for (const n of node) texts(n, acc); return acc; }
  if (node.children) for (const c of node.children) texts(c, acc);
  return acc;
}

let captured = null;
globalThis.window.__ModuleLoader__ = { load: (o) => (captured = o) };
await import("../lib/client.js");
assert.ok(captured);

function makePlugin(callImpl) {
  const rt = makeRuntime();
  const exp = captured.factory((name) => {
    if (name === "react") return rt.React;
    if (name === "react-dom") return { createPortal: (children) => children };
    throw new Error("unexpected require " + name);
  });
  const ctx = {
    get(name) {
      if (name === "connection") return { rpc: { call: callImpl } };
      if (name === "slots") return { register: () => () => {}, inject: () => () => {} };
      return undefined;
    },
  };
  exp.apply(ctx);
  return { exp, rt, ctx };
}

const SAMPLE_TASK = {
  id: "task_r4",
  taskId: "task_r4",
  phase: "active",
  revision: 5,
  enabled: true,
  objective: "精简清爽任务面板",
  stages: [
    { id: "s1", title: "持久化隔离", criterionIds: ["c1"], dependsOn: [] },
    { id: "s2", title: "界面去容器化", criterionIds: ["c2"], dependsOn: ["s1"] },
  ],
  nodeRuns: [
    { stageId: "s1", attempt: 1, status: "accepted" },
    { stageId: "s2", attempt: 1, status: "running" },
  ],
  criteria: [
    { id: "c1", text: "损坏文件自动隔离" },
    { id: "c2", text: "阶段行无多余卡片容器" },
  ],
  findings: [
    { id: "f1", stageId: "s2", severity: "blocking", status: "open", text: "需要补充说明" },
    { id: "f2", stageId: "s2", severity: "advisory", status: "responded", text: "等待复核" },
    { id: "f3", stageId: "s1", severity: "blocking", status: "closed", text: "历史已修", closeReason: "核对无误" },
  ],
  unresolved: { total: 2, blocking: 1 },
  participants: [{ id: "p1", role: "worker", stageId: "s2", status: "running", streaming: true }],
  nextStep: { code: "READY", text: "推进 s2", allowedActions: ["mentor_task_pause", "mentor_task_continue"] },
};

test("R4-1 亮暗主题 token 完整，圆角/字体/动效/紧凑规则符合规格", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const css = exp.__test.DASHBOARD_CSS;
  for (const token of [
    "--mt-ink:#0F1115", "--mt-ink2:#1A1D21", "--mt-ink3:#2B2F36",
    "--mt-accent:#3568D4", "--mt-ok:#21835B", "--mt-warn:#986300", "--mt-err:#C43D42",
    "--mt-ink:#F5F6F8", "--mt-ink2:#E2E5EA", "--mt-ink3:#C8CDD6",
    "--mt-accent:#82AAFF", "--mt-ok:#62C99A", "--mt-warn:#DDB56A", "--mt-err:#F08080",
    "border-radius:12px", "border-radius:6px", "tabular-nums",
    ".mt-work[data-compact='1']{overflow-y:auto",
    ".mt-work[data-compact='1'] .mt-work-body{max-height:none;overflow:visible}",
    "prefers-reduced-motion:reduce",
  ]) {
    assert.ok(css.includes(token), `DASHBOARD_CSS 应包含规格 token/规则: ${token}`);
  }
  assert.equal(exp.__test.DEFAULT_PANEL_APPEARANCE.transparency, 6);
  assert.equal(exp.__test.DEFAULT_PANEL_APPEARANCE.blur, 16);
  assert.equal(exp.__test.DEFAULT_PANEL_APPEARANCE.motion, "light");
});

test("R4-2 阶段行无重复状态胶囊、验收证据无嵌套卡片、输出框无独立描边", async () => {
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: SAMPLE_TASK } }));
  const css = exp.__test.DASHBOARD_CSS;
  const ov = await rt.mount(exp.__test.OverviewContent, { task: SAMPLE_TASK, busy: false }, 5);
  const seg = findAll(ov.final, (n) => hasClass(n, "mt-seg-mini"))[0];
  const listBtn = findAll(seg, (n) => n.type === "button")[1];
  listBtn.props.onClick();
  const listTree = rt.rerenderNow(exp.__test.OverviewContent, { task: SAMPLE_TASK, busy: false });
  const rows = findAll(listTree, (n) => hasClass(n, "mt-stage-row"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(findAll(row, (n) => hasClass(n, "mt-work-badge")).length, 0, "阶段行不重复显示状态胶囊");
  }
  assert.match(css, /\.mt-work-output\{[^}]*border-left:2px solid var\(--mt-line\)/, "输出框改用左侧 2px 细竖线");
  assert.doesNotMatch(css, /\.mt-crit-item\{[^}]*border:/, "验收条目不再套独立卡片边框");
});

test("R4-3 默认过滤已关闭问题，历史计数准确；同时最多展开一个关闭编辑区且空白理由禁提交", async () => {
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: SAMPLE_TASK } }));
  const { visibleIssues, canSubmitClose, IssueContent } = exp.__test;

  const vClosed = visibleIssues(SAMPLE_TASK.findings, false);
  assert.equal(vClosed.open.length, 2);
  assert.equal(vClosed.closed.length, 1);
  assert.equal(vClosed.shown.length, 2);
  assert.equal(visibleIssues(SAMPLE_TASK.findings, true).shown.length, 3);

  assert.equal(canSubmitClose("", false), false);
  assert.equal(canSubmitClose("   \n ", false), false);
  assert.equal(canSubmitClose("已核实", true), false);
  assert.equal(canSubmitClose("已核实", false), true);

  // 编辑 f1 时，全页仅展开 1 个关闭编辑区，且 f2 的「关闭」按钮被禁用
  const drafts = { current: new Map([["f1", "   "]]) };
  const rendered = await rt.mount(IssueContent, {
    task: SAMPLE_TASK, busy: false, closingId: "f1", setClosingId: () => {},
    draftsRef: drafts, showClosed: false, setShowClosed: () => {},
  }, 5);
  assert.equal(findAll(rendered.final, (n) => hasClass(n, "mt-close-editor")).length, 1, "最多展开一个编辑区");
  const confirmBtn = findAll(rendered.final, (n) => n.type === "button" && texts(n).join("") === "确认关闭")[0];
  assert.equal(confirmBtn.props.disabled, true, "空白理由禁止提交");
  const f2CloseBtn = findAll(rendered.final, (n) => n.type === "button" && n.props.id === "mt-close-f2")[0];
  assert.equal(f2CloseBtn.props.disabled, true, "编辑一条时其余关闭入口禁用");
  const histBtn = findAll(rendered.final, (n) => hasClass(n, "mt-closed-toggle"))[0];
  assert.match(texts(histBtn).join(""), /已关闭 1/);
});

test("R4-4 人工关闭失败保留理由草稿；pending 期间按钮禁用；STALE_REVISION 刷新但不重放写请求", async () => {
  const calls = [];
  let resolveCmd;
  const { exp, rt } = makePlugin((ch, method, payload) => {
    calls.push({ ch, method, payload });
    if (payload && payload.action === "mentor_finding_close") {
      return new Promise((res) => { resolveCmd = res; });
    }
    if (payload && payload.action === "mentor_task_pause") {
      return Promise.resolve({
        ok: false,
        error: { code: "E_STALE_REVISION", message: "任务状态已更新", details: { taskId: "task_r4", expectedRevision: 5, currentRevision: 6 } },
      });
    }
    return Promise.resolve({ ok: true, value: { task: SAMPLE_TASK } });
  });
  await new Promise((r) => setTimeout(r, 15));

  // 1. 模拟提交关闭期间禁用 + 失败保留理由草稿
  const drafts = { current: new Map([["f1", "人工确认已处理"]]) };
  let closingId = "f1";
  const props = () => ({
    task: SAMPLE_TASK, busy: false, closingId, setClosingId: (v) => { closingId = v; },
    draftsRef: drafts, showClosed: false, setShowClosed: () => {},
  });
  const mounted = await rt.mount(exp.__test.IssueContent, props(), 5);
  const confirmBtn = findAll(mounted.final, (n) => n.type === "button" && texts(n).join("") === "确认关闭")[0];
  assert.equal(confirmBtn.props.disabled, false);

  const pendingPromise = confirmBtn.props.onClick();
  const during = rt.rerenderNow(exp.__test.IssueContent, props());
  const duringConfirm = findAll(during, (n) => n.type === "button" && texts(n).join("") === "提交中…")[0];
  const duringCancel = findAll(during, (n) => n.type === "button" && texts(n).join("") === "取消")[0];
  assert.equal(duringConfirm.props.disabled, true, "pending 期间提交按钮禁用");
  assert.equal(duringCancel.props.disabled, true, "pending 期间取消按钮禁用");

  resolveCmd({ ok: false, error: { code: "E_FINDING_CLOSE_REASON", message: "后端拒绝" } });
  await pendingPromise;
  const afterFail = rt.rerenderNow(exp.__test.IssueContent, props());
  assert.equal(drafts.current.get("f1"), "人工确认已处理", "提交失败必须保留草稿");
  assert.match(texts(afterFail).join(" "), /后端拒绝/, "失败应原位报错");
  assert.equal(closingId, "f1", "失败不收起编辑区");

  // 2. STALE_REVISION：仅发 1 次写请求，绝不自动重放，且设置 staleNotice + 触发刷新
  const beforePause = calls.length;
  const staleRes = await exp.__test.runControl("mentor_task_pause");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.error.code, "E_STALE_REVISION");
  const pauseCalls = calls.slice(beforePause).filter((c) => c.payload?.action === "mentor_task_pause");
  assert.equal(pauseCalls.length, 1, "STALE_REVISION 绝不自动重放写请求");
  const stateRefreshes = calls.slice(beforePause).filter((c) => !c.payload?.action);
  assert.ok(stateRefreshes.length >= 1, "STALE_REVISION 必须自动刷新最新状态");
  assert.equal(exp.__test.getLiveState().staleNotice, true, "必须展示原位版本更新提示");
});

test("R4-5 短视口 240/256px 滞回、流式 24/25px 与选区跟随规则、轻动效迁移与呼吸态收敛", () => {
  const { exp } = makePlugin(() => Promise.resolve({ ok: true, value: { task: null } }));
  const { nextCompact, shouldFollowStream, readPanelAppearance, isTaskLive } = exp.__test;

  // Compact hysteresis: <240 enter, >=256 exit
  assert.equal(nextCompact(false, 240), false);
  assert.equal(nextCompact(false, 239), true);
  assert.equal(nextCompact(true, 255), true);
  assert.equal(nextCompact(true, 256), false);

  // Stream follow: <=24px & no selection
  assert.equal(shouldFollowStream({ scrollTop: 76, clientHeight: 100, scrollHeight: 200, hasSelection: false }), true);
  assert.equal(shouldFollowStream({ scrollTop: 75, clientHeight: 100, scrollHeight: 200, hasSelection: false }), false);
  assert.equal(shouldFollowStream({ scrollTop: 100, clientHeight: 100, scrollHeight: 200, hasSelection: true }), false);

  // Legacy "on"/"system" migrate cleanly to "light" (no 24-layer clone by default)
  localStorage.setItem("dsh-mentor:panel-appearance", JSON.stringify({ transparency: 10, blur: 12, theme: "dark", motion: "on" }));
  assert.equal(readPanelAppearance().motion, "light");
  localStorage.setItem("dsh-mentor:panel-appearance", JSON.stringify({ motion: "paper" }));
  assert.equal(readPanelAppearance().motion, "paper");
  localStorage.removeItem("dsh-mentor:panel-appearance");

  // Breathing dot only when truly running/streaming
  assert.equal(isTaskLive({ phase: "paused", participants: [] }), false);
  assert.equal(isTaskLive({ phase: "active", participants: [{ status: "idle" }] }), false);
  assert.equal(isTaskLive({ phase: "active", participants: [{ status: "running" }] }), true);
  assert.equal(isTaskLive({ phase: "reviewing", activeReview: { status: "streaming" } }), true);
});

test("R4-6 WAI-ARIA tablist roving tabindex、方向键/Home/End 切换、以及 Esc 逐层退出并恢复焦点", async () => {
  focusedIds.length = 0;
  localStorage.setItem("dsh-mentor:collapsed", "open");
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: SAMPLE_TASK } }));
  const { tabKeyTarget, escapeLayer, ComposerBar } = exp.__test;

  const ids = ["overview", "reviews", "issues", "agents"];
  assert.equal(tabKeyTarget(ids, "overview", "ArrowRight"), "reviews");
  assert.equal(tabKeyTarget(ids, "overview", "ArrowLeft"), "agents");
  assert.equal(tabKeyTarget(ids, "issues", "Home"), "overview");
  assert.equal(tabKeyTarget(ids, "overview", "End"), "agents");

  assert.equal(escapeLayer({ showAppearance: true, closingId: "f1", expanded: true }), "appearance");
  assert.equal(escapeLayer({ showAppearance: false, closingId: "f1", expanded: true }), "editor");
  assert.equal(escapeLayer({ showAppearance: false, closingId: null, expanded: true }), "collapse");
  assert.equal(escapeLayer({ showAppearance: false, closingId: null, expanded: false }), null);

  const { final } = await rt.mount(ComposerBar, {});
  const tabs = findAll(final, (n) => n.props?.role === "tab");
  assert.equal(tabs.length, 4);
  assert.equal(tabs.filter((t) => t.props.tabIndex === 0).length, 1, "tablist 仅一个 tabIndex=0");
  assert.equal(tabs[0].props["aria-selected"], true);
  assert.equal(tabs[0].props["aria-controls"], "mt-tabpanel");
  const panel = findAll(final, (n) => n.props?.role === "tabpanel")[0];
  assert.equal(panel.props["aria-labelledby"], "mt-tab-overview");

  // 键盘右方向键切到审查页并聚焦
  const tablist = findAll(final, (n) => n.props?.role === "tablist")[0];
  tablist.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
  const afterArrow = rt.rerenderNow(ComposerBar, {});
  const activeTab = findAll(afterArrow, (n) => n.props?.role === "tab" && n.props["aria-selected"] === true)[0];
  assert.equal(activeTab.props.id, "mt-tab-reviews");

  // 先打开外观设置，按一次 Esc 只关外观并回焦外观按钮；再按一次 Esc 收起面板并回焦展开按钮
  const isAppearanceEl = (n) => typeof n?.type === "function" && n.type.name === "PanelAppearanceSettings";
  const appBtn = findAll(afterArrow, (n) => n.props?.id === "mt-appearance-btn")[0];
  appBtn.props.onClick();
  const withApp = rt.rerenderNow(ComposerBar, {});
  assert.equal(findAll(withApp, isAppearanceEl).length, 1, "点外观按钮应挂载 PanelAppearanceSettings");

  withApp.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  const afterEsc1 = rt.rerenderNow(ComposerBar, {});
  assert.equal(findAll(afterEsc1, isAppearanceEl).length, 0, "第一下 Esc 关闭外观设置");
  assert.equal(findAll(afterEsc1, (n) => hasClass(n, "mt-work-tabs")).length, 1, "面板仍保持展开");

  afterEsc1.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  const afterEsc2 = rt.rerenderNow(ComposerBar, {});
  assert.equal(findAll(afterEsc2, (n) => hasClass(n, "mt-work-tabs")).length, 0, "第二下 Esc 收起面板");

  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(focusedIds.map((f) => f.id), ["mt-tab-reviews", "mt-appearance-btn", "mt-work-expand"]);
});

test("R4-7 人工关闭草稿与报错按 taskId:findingId 隔离，提交在途切换任务不污染新任务", async () => {
  let resolveClose;
  let currentTask = SAMPLE_TASK;
  const OTHER_TASK = {
    ...SAMPLE_TASK,
    id: "task_r4_other",
    taskId: "task_r4_other",
    findings: [{ id: "f1", stageId: "s1", severity: "blocking", status: "open", text: "另一任务的同号问题" }],
  };
  const { exp, rt } = makePlugin((ch, method, payload) => {
    if (payload && payload.action === "mentor_finding_close") {
      return new Promise((res) => { resolveClose = res; });
    }
    return Promise.resolve({ ok: true, value: { task: currentTask } });
  });
  await new Promise((r) => setTimeout(r, 15));

  const drafts = { current: new Map([["task_r4:f1", "旧任务关闭理由"]]) };
  let closingId = "f1";
  const propsFor = (task) => ({
    task, busy: false, closingId, setClosingId: (v) => { closingId = v; },
    draftsRef: drafts, showClosed: false, setShowClosed: () => {},
  });

  // 在旧任务发起关闭提交
  const mounted = await rt.mount(exp.__test.IssueContent, propsFor(SAMPLE_TASK), 5);
  const confirmBtn = findAll(mounted.final, (n) => n.type === "button" && texts(n).join("") === "确认关闭")[0];
  const inflight = confirmBtn.props.onClick();

  // 提交尚未返回时，宿主状态切到了另一个任务（同 findingId=f1）
  currentTask = OTHER_TASK;
  exp.__test.getLiveState().task = OTHER_TASK;
  const onOther = rt.rerenderNow(exp.__test.IssueContent, propsFor(OTHER_TASK));
  const otherTextarea = findAll(onOther, (n) => n.type === "textarea")[0];
  assert.equal(otherTextarea.props.value, "", "新任务的 f1 不应串读旧任务草稿");

  // 旧任务关闭返回失败：不能把报错写到新任务，也不能收起新任务的编辑区
  resolveClose({ ok: false, error: { code: "E_FINDING_CLOSE_REASON", message: "旧任务报错" } });
  await inflight;
  const afterResolve = rt.rerenderNow(exp.__test.IssueContent, propsFor(OTHER_TASK));
  assert.equal(closingId, "f1", "旧任务返回不得改写新任务的 closingId");
  assert.doesNotMatch(texts(afterResolve).join(" "), /旧任务报错/, "旧任务错误不得污染新任务");
});

test("R4-8 v0.3 熔断升级简报与前置硬检查失败在概览页清晰可见", async () => {
  let switchedTab = null;
  const { exp, rt } = makePlugin(() => Promise.resolve({ ok: true, value: { task: SAMPLE_TASK } }));
  const breakerTask = {
    ...SAMPLE_TASK,
    phase: "paused",
    continuation: {
      status: "needs-attention",
      kind: "rework-circuit-breaker",
      stageId: "s2",
      reviseCount: 3,
      limit: 3,
      summary: "阶段 s2 在计划 v1 已连续被打回 3 次（达到返工熔断上限 3），已自动暂停等待人工介入。",
      recentFindings: [{ id: "f1", severity: "blocking", text: "边界条件未覆盖" }],
    },
    lastPrechecks: {
      s2: { ok: false, total: 2, passed: 1, failed: 1 },
    },
  };
  const mounted = await rt.mount(exp.__test.OverviewContent, {
    task: breakerTask,
    busy: false,
    onSwitchTab: (id) => { switchedTab = id; },
  }, 5);
  const allText = texts(mounted.final).join(" ");
  assert.match(allText, /连续被打回 3 次/);
  assert.match(allText, /边界条件未覆盖/);
  // 验证 MindMapView 子树及列表视图均可直接看到前置硬检查失败提示
  const mmTree = await rt.mount(exp.__test.MindMapView, { task: breakerTask, claims: [], busy: false }, 3);
  assert.match(texts(mmTree.final).join(" "), /前置硬检查未通过（1\/2 失败）/);
  const viewIssuesBtn = findAll(mounted.final, (n) => n.type === "button" && texts(n).join("") === "查看问题")[0];
  assert.ok(viewIssuesBtn, "熔断提示必须带查看问题按钮");
  viewIssuesBtn.props.onClick();
  assert.equal(switchedTab, "issues");
});
