/**
 * dsh-mentor 客户端入口 —— 督导状态面板。
 *
 * 形态：CJS factory。宿主按 package.json 的 `exports["./client"]` 取本文件，
 *       以静态 bundle 形式 serve 给浏览器；末尾用 `window.__ModuleLoader__.load`
 *       注册。不需要 bundler —— factory 依赖宿主的 `react` / `react-dom` seed 模块。
 *
 * 依赖的服务（见模块级 `inject`）：
 *   - slots      挂载点注册表
 *   - connection 取数通道（rpc.call）
 *
 * 数据来源：服务端 `/api/mentor/state`（fetch 注册表路由），404 时回退 `/mentor`
 * RPC 通道。返回结构与 mentor_task_status 逐字段一致（由服务端 test/rpc.test.mjs
 * 深度相等锁死），面板只负责渲染它的子集。
 *
 * 本文件不参考、不包含任何上游未授权实现的代码。挂载点与 factory 形式来自
 * DSH 公开的 client 插件约定（第三方 MIT/Apache 插件的声明与官方模块名）。
 */

const factory = (require) => {
  const module = { exports: {} };
  const exports = module.exports;

  const React = require("react");
  // 2026-11-08 修 R2b：原来是无保护顶层解构 `const { createPortal } = require("react-dom")`。
  // 宿主不提供 react-dom seed 时，这里会直接把整个 factory 抛掉、状态条与面板全挂，
  // 与文件头「拿不到就退化」的承诺不符（同文件 ui-primitives 一直是有 try/catch 的）。
  // 改成可降级：拿不到就原位渲染（不再挂到 body），至少保证状态条可见。
  let createPortal = null;
  try {
    ({ createPortal } = require("react-dom") || {});
  } catch {
    createPortal = null;
  }
  /** 有 createPortal 就挂到指定容器，没有就原位渲染——降级不崩 */
  const portalTo = (children, container) =>
    typeof createPortal === "function" ? createPortal(children, container) : children;

  /**
   * DSH 官方 UI 组件库。
   *
   * 旧督导插件（dsh-task-supervisor）就是用它：`Button`×25、`DisclosureRow`×4，
   * 外加 `Menu` / `Checkbox` / `Modal` / `Input` / `MarkdownText`，以及
   * `IconChevronDownOutlineRegular` / `IconChecklistOutlineRegular` 这些图标组件。
   *
   * 用它而不是自己画的好处：字体、图标字形、主题变量、可访问性全由宿主提供。
   * 之前 98 处裸 createElement + 自写 CSS，字符（·/×/箭头等）落在没有对应字形的
   * 字体上就会显示成方块 —— 使用者反馈的「乱码」大概率源于此。
   *
   * 拿不到就退化成 null，下面的代码走手写 fallback，不会崩。
   */
  let UI = null;
  try {
    UI = require("@deepseek-ai/dsh-client-ui-primitives") || null;
  } catch (e) {
    UI = null;
  }

  /* ================================================================== *
   * 面板开关：模块级共享，两个挂载点各自订阅
   * ================================================================== */

  const panelState = { open: false };

  /* ================================================================== *
   * 薄壳热更新：把「UI 长什么样」交给一个可热替换的模块
   *
   * 背景（真机实测，verification/loader-probe.md）：
   *   - window.__ModuleLoader__ 不支持重复注册（duplicate factory registration），
   *     所以插件没法靠它换掉自己；
   *   - 但页面允许 new Function、且没有 meta CSP。
   * 于是这里走另一条路：UI 组件由 hotUi.current 间接提供，外壳定期向
   * `POST /api/mentor/hot-ui` 拉源码 + sha256，变了就重新求值、换引用、通知重渲染。
   * 效果：改 lib/hot-ui.js 不用刷新页面、不丢输入。
   *
   * 兜底：拉取/求值/结构校验任一失败 → hotUi.current 置空并标记 degraded，
   * 组件自动退回内置实现，界面不会挂。
   * ================================================================== */
  const hotUi = {
    current: null, // { marker, ComposerBar, MentorToggle, MentorPanel }
    sha: null,
    degraded: false,
    error: null,
    listeners: new Set(),
  };

  const HOT_UI_URL = "/api/mentor/hot-ui";
  const HOT_UI_POLL_MS = 8000;
  const HOT_UI_REQUIRED = ["ComposerBar", "MentorToggle", "MentorPanel"];

  /**
   * 求值一份 hot-ui 源码。纯函数，便于单测。
   * @param {string} source 形如 `(React, deps) => ui` 的箭头函数表达式源码
   * @param {*} React React 运行时
   * @param {object} deps 内置实现 { ComposerBar, MentorToggle, MentorPanel }
   */
  function evalHotUi(source, React, deps) {
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("hot-ui 源码为空");
    }
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      "React",
      "deps",
      "return (" + source + ")(React, deps);",
    );
    const ui = factory(React, deps);
    if (!ui || typeof ui !== "object") {
      throw new Error("hot-ui 未返回对象");
    }
    for (const key of HOT_UI_REQUIRED) {
      if (typeof ui[key] !== "function") {
        throw new Error("hot-ui 缺少组件 " + key);
      }
    }
    return ui;
  }

  function emitHotUi() {
    for (const fn of Array.from(hotUi.listeners)) {
      try {
        fn();
      } catch {}
    }
  }

  /**
   * 拉一次远端 UI 模块；sha 没变就什么都不做（避免无谓重渲染）。
   * @returns {Promise<boolean>} 是否发生了替换
   */
  async function refreshHotUi() {
    try {
      const r = await fetch(HOT_UI_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          type: "client-request",
          rpcId: "hot-ui-" + Math.random().toString(36).slice(2),
        }),
      });
      if (!r || !r.ok) throw new Error("HTTP " + (r && r.status));
      const envelope = await r.json();
      const result = envelope && envelope.result;
      if (!result || !result.ok) {
        throw new Error(
          (result && result.error && result.error.message) || "hot-ui 拉取失败",
        );
      }
      const value = result.value || {};
      if (value.sha256 && value.sha256 === hotUi.sha) return false;
      const ui = evalHotUi(value.source, React, {
        ComposerBar,
        MentorToggle,
        MentorPanel,
      });
      hotUi.current = ui;
      hotUi.sha = value.sha256 || null;
      hotUi.degraded = false;
      hotUi.error = null;
      emitHotUi();
      return true;
    } catch (err) {
      // 兜底：任何失败都退回内置 UI，并留下降级标记
      hotUi.degraded = true;
      hotUi.error = String((err && err.message) ?? err);
      hotUi.current = null;
      hotUi.sha = null;
      emitHotUi();
      return false;
    }
  }

  /** 订阅 hot-ui 变化的钩子 */
  function useHotUi() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const fn = () => force((v) => v + 1);
      hotUi.listeners.add(fn);
      return () => hotUi.listeners.delete(fn);
    }, []);
    return hotUi.current;
  }

  /* ==================================================================
   * 版本自检：把「这个页面现在加载的是哪一版插件」变成可见读数
   *
   * 为什么需要（2026-11-03）：桌面实例 19387 不暴露 CDP、launch token 是进程内
   * 随机会话值不落盘、ego 浏览器又是独立 profile，于是工具侧**读不到**桌面页面
   * 的 DOM —— 也就答不了「用户屏幕上是新版还是旧版」。以前只能反复让用户
   * 重启/刷新去试，这正是旧会话里「卡住」的成因。
   *
   * 做法：页面自己 POST /api/mentor/selfcheck 拿读数，渲染成
   *   plugin 7f1d6d7e8440 · ui:v1
   * 用户一眼就能回报数字；隔离实例也能直接对 DOM 断言。
   *
   * 取数失败只降级成 `plugin unknown`，绝不抛错、绝不吃掉状态条本身。
   * ================================================================== */
  const SELF_CHECK_URL = "/api/mentor/selfcheck";
  const SELF_CHECK_POLL_MS = 30000;
  const selfCheck = {
    clientSha: null,
    marker: null,
    startedAt: null,
    error: null,
    at: 0,
  };
  const selfCheckListeners = new Set();

  function emitSelfCheck() {
    for (const fn of Array.from(selfCheckListeners)) {
      try {
        fn();
      } catch {}
    }
  }

  async function refreshSelfCheck() {
    try {
      const r = await fetch(SELF_CHECK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          type: "client-request",
          rpcId: "selfcheck-" + Math.random().toString(36).slice(2),
          // s3：把 client 侧挂载结果一起报上去，让 agent 读落盘文件就能判定
          // 「右侧栏 tab 挂上了没 / 开过没」，不用靠人眼或浏览器。
          diag:
            typeof globalThis !== "undefined" && globalThis.__mtDiag
              ? globalThis.__mtDiag
              : null,
        }),
      });
      if (!r || !r.ok) throw new Error("HTTP " + (r && r.status));
      const envelope = await r.json();
      const result = envelope && envelope.result;
      if (!result || !result.ok) {
        throw new Error(
          (result && result.error && result.error.message) || "selfcheck 取数失败",
        );
      }
      const v = result.value || {};
      selfCheck.clientSha =
        typeof v.clientSha === "string" && v.clientSha !== "unknown"
          ? v.clientSha
          : null;
      selfCheck.marker = typeof v.hotUiMarker === "string" ? v.hotUiMarker : null;
      selfCheck.startedAt = v.startedAt || null;
      selfCheck.error = null;
    } catch (err) {
      // 降级：读数不可用，但状态条本身必须还在
      selfCheck.clientSha = null;
      selfCheck.marker = null;
      selfCheck.error = String((err && err.message) ?? err);
    }
    selfCheck.at = Date.now();
    emitSelfCheck();
  }

  function useSelfCheck() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const fn = () => force((v) => v + 1);
      selfCheckListeners.add(fn);
      return () => selfCheckListeners.delete(fn);
    }, []);
    return selfCheck;
  }

  /** 版本角标：`plugin 7f1d6d7e · ui:v1`；取数失败降级 `plugin unknown` */
  function VersionChip() {
    const v = useSelfCheck();
    let text;
    if (v.error) text = "plugin unknown";
    else if (v.clientSha) {
      text = "plugin " + v.clientSha.slice(0, 8) + (v.marker ? " · ui:" + v.marker : "");
    } else {
      text = "plugin …";
    }
    return React.createElement(
      "span",
      {
        className: "mt-chip mt-chip-ver",
        key: "ver",
        title:
          "plugin 段 = 服务端当前 client.js 的 sha256 前 8 位（磁盘内容，不是页面已运行副本的证明）；" +
          "ui: 段 = 热替换 UI 模块的 MARKER。" +
          "能看见本角标本身，说明该页面已加载含自检的 client 版本。" +
          (v.error ? "（取数失败：" + v.error + "）" : ""),
      },
      text,
    );
  }

  /** 启动自检轮询：加载后 600ms 取一次，其后每 30s 一次 */
  function startSelfCheck() {
    let stopped = false;
    const kick = setTimeout(() => {
      if (!stopped) refreshSelfCheck();
    }, 600);
    const interval = setInterval(() => {
      if (!stopped) refreshSelfCheck();
    }, SELF_CHECK_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(interval);
    };
  }

  /**
   * 生成一个「优先用热模块、失败回退内置」的组件。
   * @param {"ComposerBar"|"MentorToggle"|"MentorPanel"} name
   * @param {Function} fallback 内置实现
   */
  function makeHotSlot(name, fallback) {
    return function HotSlot(props) {
      const ui = useHotUi();
      const Comp = (ui && typeof ui[name] === "function" ? ui[name] : null) || fallback;
      return React.createElement(Comp, props);
    };
  }

  /** 启动热 UI 拉取：周期轮询 + 切回窗口/聚焦即刻拉 */
  function startHotUi() {
    let stopped = false;
    let last = 0;
    const trigger = () => {
      const now = Date.now();
      if (now - last < 1500) return; // 1.5s 节流
      last = now;
      if (!stopped) refreshHotUi();
    };
    const onVisibility = () => {
      try {
        if (document.visibilityState === "visible") trigger();
      } catch {}
    };
    try {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", trigger);
    } catch {}
    const kick = setTimeout(trigger, 300);
    const interval = setInterval(trigger, HOT_UI_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(interval);
      try {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", trigger);
      } catch {}
    };
  }
  /** 自更新轮询的 dispose（页面生命周期内不主动释放） */
  let updaterDispose = null;
  /** 热 UI 拉取的 dispose */
  let hotUiDispose = null;
  /** 版本自检轮询的 dispose */
  let selfCheckDispose = null;
  const listeners = new Set();

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function setOpen(next) {
    if (panelState.open === next) return;
    panelState.open = next;
    // s3 L2：打开面板时触发宿主 openTab（若宿主提供），并记 openTabCalled
    if (next === true) {
      try {
        if (typeof globalThis.__mtOpenTab === "function") globalThis.__mtOpenTab();
      } catch {}
    }
    for (const fn of listeners) fn();
  }

  /** apply 时的 ctx，供组件按需取 connection */
  let pluginCtx = null;

  /* ================================================================== *
   * 样式：闭包内注入 <style>，data 属性防重
   * ================================================================== */

  const STYLE_KEY = "dsh-mentor-panel";

  const CSS = `
.mt-toggle {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  color: var(--dsw-alias-label-secondary, #8e98a8);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  cursor: pointer;
  transition: color .15s ease, border-color .15s ease, background-color .15s ease, box-shadow .15s ease;
}
.mt-toggle:hover {
  color: var(--dsw-alias-label-primary, #eee);
  border-color: var(--dsw-alias-border-l2, rgba(148,163,184,.55));
  background: rgba(128,140,160,.08);
}
.mt-toggle-on {
  color: var(--dsw-alias-brand-primary, #3568D4);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3568D4) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3568D4) 10%, transparent);
}
.mt-toggle-on:hover {
  color: var(--dsw-alias-brand-primary, #3568D4);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3568D4) 62%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3568D4) 15%, transparent);
}
/* 导师被 task_off 关掉时的样子：明显是「关」的，点一下能重新打开 */
.mt-toggle-off {
  color: rgba(220, 88, 88, .92);
  border-color: rgba(220, 88, 88, .48);
  border-style: dashed;
}

/* 顶部工具条：导师模式开关 + Clear（2026-11-04 控制接口）
   Clear 放这里而不是状态条操作栏：状态条可折叠、可被按钮整个关掉，
   而那些状态下按钮仍然必须在 —— 用户要的是「随时能 Clear」。 */
.mt-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mt-clear {
  border-color: rgba(220, 88, 88, .35);
  color: rgba(220, 88, 88, .9);
}
.mt-clear:hover:not(:disabled) {
  border-color: rgba(220, 88, 88, .72);
  color: rgba(235, 95, 95, 1);
  background: rgba(220, 88, 88, .09);
}
.mt-clear:disabled {
  opacity: .36;
  cursor: not-allowed;
  border-color: var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  color: var(--dsw-alias-label-secondary, #8e98a8);
}
/* 二次确认态：变成实心红，视觉上明确「这一下就删了」 */
.mt-work-team{display:grid;gap:8px;padding-top:10px;border-top:1px solid var(--mt-line);overflow-wrap:anywhere}
.mt-work-team-input{display:grid;gap:8px;padding-top:6px}
.mt-work-team-input textarea{width:100%;min-height:60px;resize:vertical;font:inherit;color:var(--mt-ink);background:var(--mt-surface);border:1px solid var(--mt-line-strong);border-radius:8px;padding:7px 9px;outline:none;transition:border-color .15s}
.mt-work-team-input textarea:focus{border-color:var(--mt-brand)}
.mt-clear-confirm {
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;
  font-weight: 600;
}
.mt-clear-confirm:hover:not(:disabled) {
  background: #b91c1c;
  border-color: #b91c1c;
  color: #fff;
}
.mt-toast {
  margin-left: 4px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #a8a8a8);
  white-space: nowrap;
}
.mt-panel {
  position: fixed;
  top: 64px;
  right: 16px;
  bottom: 96px;
  width: 380px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay, #1f1f1f);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4));
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.35);
  color: var(--dsw-alias-label-primary, #eee);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  z-index: 900;
}
.mt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  flex: none;
}
.mt-title { font-weight: 600; flex: none; }
.mt-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 9px;
  background: rgba(128,128,128,.22);
  color: var(--dsw-alias-label-secondary, #aaa);
  flex: none;
  font-family: ui-monospace, monospace;
}
.mt-badge-planning { background: rgba(120,120,200,.28); color: #b6b6ff; }
.mt-badge-active   { background: rgba(74,144,217,.30); color: #8cc4ff; }
.mt-badge-reviewing{ background: rgba(224,161,60,.28); color: #ffce78; }
.mt-badge-completed{ background: rgba(90,190,120,.28); color: #86e0a8; }
.mt-spacer { flex: 1; }
.mt-btn {
  background: none;
  border: none;
  color: var(--dsw-alias-label-secondary, #a8a8a8);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
}
.mt-btn:hover { background: rgba(128,128,128,.18); }
.mt-btn:disabled { opacity: .5; cursor: default; }
.mt-body { flex: 1; overflow: auto; padding: 4px 12px 16px; }
.mt-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #aaa);
  margin: 14px 0 6px;
  letter-spacing: .04em;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mt-count {
  font-weight: 400;
  opacity: .7;
  font-family: ui-monospace, monospace;
}
.mt-row {
  padding: 5px 8px;
  border-radius: 7px;
  margin: 2px 0;
  background: rgba(128,128,128,.07);
}
.mt-row-main { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.mt-id {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #999);
  flex: none;
}
.mt-text { flex: 1; min-width: 0; word-break: break-word; }
.mt-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888);
  margin-top: 2px;
}
.mt-dim { color: var(--dsw-alias-label-secondary, #888); }
/* ──────────────────────────────────────────────────────────────
   状态面板（浅色毛玻璃 · 八段纵排）
   颜色写死成深色系：卡面是白色玻璃，深色文字在任何宿主主题下都可读。
   ────────────────────────────────────────────────────────────── */
.mt-p {
  --mt-ink: #0F1115;
  --mt-ink2: #1A1D21;
  --mt-ink3: #2B2F36;
  --mt-hair: rgba(0,0,0,.075);
  --mt-hair2: rgba(0,0,0,.11);
  --mt-blue: #0071e3;
  --mt-green: #28a745;
  --mt-amber: #e8890c;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255,255,255,.86), rgba(255,255,255,.70));
  border: 1px solid rgba(255,255,255,.92);
  backdrop-filter: blur(34px) saturate(1.6);
  -webkit-backdrop-filter: blur(34px) saturate(1.6);
  box-shadow:
    0 1px 0 rgba(255,255,255,.95) inset,
    0 0 0 1px rgba(0,0,0,.05),
    0 14px 34px -18px rgba(30,50,100,.34);
  color: var(--mt-ink);
  font-size: 12.5px;
  line-height: 1.45;
  overflow: hidden;
  /* 展开态不得超过半屏：插件不该盖住对话内容（第一版吃过这个亏） */
  max-height: 46vh;
  cursor: pointer;
  user-select: none;
  transition: box-shadow .16s, transform .16s;
}
.mt-p:hover {
  box-shadow:
    0 1px 0 rgba(255,255,255,.95) inset,
    0 0 0 1px rgba(0,0,0,.07),
    0 18px 40px -18px rgba(30,50,100,.42);
}
.mt-p:focus-visible { outline: 2px solid var(--mt-blue); outline-offset: 2px; }

/* 1 · 顶栏 */
.mt-p-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 15px;
  border-bottom: 1px solid var(--mt-hair);
  font-size: 11.5px; color: var(--mt-ink2);
}
.mt-p-chev { width: 11px; height: 11px; opacity: .5; flex: none; }
/* 官方图标：天生朝下，展开时转 180° 朝上 */
.mt-p-chev-official { display: inline-flex; align-items: center; justify-content: center; }
.mt-p-chev-official svg { width: 11px; height: 11px; }
.mt-p-chev-flip { transform: rotate(180deg); }
/* 左上角箭头是真按钮：点它折叠/展开，不再只是张图 */
.mt-p-chev-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: -3px 0 -3px -4px;
  border-radius: 5px;
  cursor: pointer;
  flex: none;
  transition: background .14s;
}
.mt-p-chev-btn:hover { background: rgba(0,0,0,.06); }
.mt-p-chev-btn:hover .mt-p-chev { opacity: .9; }
.mt-p-chev-btn:focus-visible { outline: 2px solid var(--mt-blue); outline-offset: 1px; }
.mt-p-chev-down { transform: rotate(180deg); }

/* 2026-11-04 第三轮：.mt-p-dismiss（× 按钮）与 .mt-p-mini（22px 窄恢复条）
   的样式已随之删除 —— 对应功能整体移除，规则改为「有任务就完整显示、没任务就不出现」。 */

/* 折叠态：只留顶栏和一行状态 */
.mt-p-collapsed-line {
  display: none;
  margin: 0;
  padding: 8px 15px 9px;
  font-size: 11.5px;
  color: var(--mt-ink2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mt-p[data-collapsed="1"] .mt-p-collapsed-line { display: block; }
/* 折叠时收起展开区与操作栏；摘要区保留（旧版折叠时也一直显示摘要） */
.mt-p[data-collapsed="1"] .mt-p-inner,
.mt-p[data-collapsed="1"] .mt-p-ops { display: none; }
.mt-p-bar-name { font-weight: 600; color: var(--mt-ink); letter-spacing: -.012em; }
.mt-p-bar-sep { width: 1px; height: 10px; background: var(--mt-hair2); }
.mt-p-sp { flex: 1; }
.mt-p-link { font-size: 11px; color: var(--mt-blue); }

/* 主体 */
/* 2026-11-04 修 A10 / c6：展开区高度受视口约束。
   旧版展开后能占掉半屏，用户原话「这个UI太大了，给你自己都遮住了，还不能折叠」。
   这里给一个上限并允许内部滚动，保证聊天正文始终露出来。 */
.mt-p-inner {
  padding: 13px 15px 0;
  max-height: min(38vh, 320px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 2 · 大状态行 */
.mt-p-hero { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.mt-p-bullet {
  width: 8px; height: 8px; border-radius: 50%; flex: none; position: relative;
  background: var(--mt-blue); box-shadow: 0 0 0 3px rgba(0,113,227,.16);
}
.mt-p-bullet[data-tone="warn"] { background: var(--mt-amber); box-shadow: 0 0 0 3px rgba(232,137,12,.18); }
.mt-p-bullet[data-tone="ok"] { background: var(--mt-green); box-shadow: 0 0 0 3px rgba(40,167,69,.16); }
.mt-p-bullet[data-tone="wait"] { background: rgba(0,0,0,.28); box-shadow: none; }
.mt-p-bullet-live::after {
  content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 1px solid rgba(0,113,227,.36);
  animation: mtPulse 2.4s ease-out infinite;
}
@keyframes mtPulse { 0% { transform: scale(.65); opacity: .9 } 70% { transform: scale(1.95); opacity: 0 } 100% { opacity: 0 } }
.mt-p-who { font-size: 14px; font-weight: 650; letter-spacing: -.02em; }
.mt-p-dot-sep { color: var(--mt-ink3); }
.mt-p-doing { font-size: 14px; font-weight: 500; color: var(--mt-ink2); letter-spacing: -.017em; }
.mt-p-ago { margin-left: auto; font-size: 11.5px; color: var(--mt-ink3); font-variant-numeric: tabular-nums; }

/* 3 · 指标行 */
.mt-p-metrics {
  display: flex; flex-wrap: wrap; gap: 0 6px;
  font-size: 11.5px; color: var(--mt-ink3); margin-bottom: 6px;
}
.mt-p-metric b { font-weight: 600; color: var(--mt-ink); font-variant-numeric: tabular-nums; }
.mt-p-metric-sep { color: rgba(0,0,0,.22); }

/* 4 · 解释行 */
.mt-p-explain { font-size: 11.5px; line-height: 1.6; color: var(--mt-ink3); margin-bottom: 11px; }

/* 5 · DAG */
.mt-dag-scroll { overflow: auto; overscroll-behavior: contain; margin: 0 -3px 10px; padding: 2px 3px; }
/* 状态条里的 DAG 只给个轮廓，别把聊天挤走；完整图去面板里看 */
.mt-dag-scroll-compact { max-height: 132px; }
.mt-dag-canvas { position: relative; margin: 0 auto; }
.mt-dag-svg { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.mt-dag-edge { fill: none; stroke: rgba(0,0,0,.30); stroke-width: 1.4; }
.mt-dag-edge.done { stroke: rgba(40,167,69,.60); }
.mt-dag-edge.live { stroke: rgba(232,137,12,.78); stroke-dasharray: 5 4; animation: mtFlow 1.15s linear infinite; }
@keyframes mtFlow { to { stroke-dashoffset: -18 } }
.mt-dag-arrow { fill: none; stroke: rgba(0,0,0,.36); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.mt-dag-arrow.done { stroke: rgba(40,167,69,.72); }
.mt-dag-arrow.live { stroke: rgba(232,137,12,.88); }

.mt-dag-node {
  position: absolute;
  display: flex; flex-direction: column; justify-content: center; gap: 5px;
  padding: 10px 13px;
  box-sizing: border-box;
  border-radius: 13px;
  border: 1px solid rgba(0,0,0,.075);
  background: linear-gradient(180deg, rgba(255,255,255,.94), rgba(255,255,255,.78));
  box-shadow: 0 1px 0 #fff inset, 0 2px 8px -3px rgba(30,50,100,.16);
  color: var(--mt-ink);
  overflow: visible;
  transition: box-shadow .15s, transform .15s;
}
.mt-dag-node:hover { transform: translateY(-1px); box-shadow: 0 1px 0 #fff inset, 0 8px 18px -8px rgba(30,50,100,.3); }
.mt-dag-node[data-tone="ok"] { border-color: rgba(40,167,69,.28); }
.mt-dag-node[data-tone="warn"],
.mt-dag-node[data-tone="live"] {
  border-color: rgba(232,137,12,.42);
  box-shadow: 0 1px 0 #fff inset, 0 0 0 3px rgba(232,137,12,.10), 0 2px 8px -3px rgba(30,50,100,.16);
}
.mt-dag-node[data-tone="wait"] { opacity: .70; }
.mt-dag-top {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; line-height: 1.3; color: var(--mt-ink3); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.mt-dag-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: rgba(0,0,0,.26); }
.mt-dag-dot.ok { background: var(--mt-green); box-shadow: 0 0 0 3px rgba(40,167,69,.14); }
.mt-dag-dot.live { background: var(--mt-amber); box-shadow: 0 0 0 3px rgba(232,137,12,.16); animation: mtBlip 1.9s ease-in-out infinite; }
.mt-dag-dot.warn { background: #e8890c; box-shadow: 0 0 0 3px rgba(232,137,12,.16); }
@keyframes mtBlip { 0%,100% { opacity: 1 } 50% { opacity: .42 } }
.mt-dag-name {
  font-size: 13px; font-weight: 600; line-height: 1.32; letter-spacing: -.016em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mt-dag-meta { font-size: 11px; line-height: 1.3; color: var(--mt-ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 常驻摘要区（对应旧版 dsh-task-inline-summary）：折叠展开都在 */
.mt-p-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 15px 10px;
  border-top: 1px solid var(--mt-hair);
}
.mt-p-summary-copy { flex: 1 1 auto; min-width: 0; }
.mt-p-summary-main {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -.012em;
  color: var(--mt-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mt-p-summary-hint {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--mt-ink3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mt-p-summary-link {
  flex: none;
  padding-top: 1px;
  font-size: 11.5px;
  color: var(--mt-blue);
  cursor: pointer;
}
/* 折叠时只留摘要主行，hints 收起 */
.mt-p[data-collapsed="1"] .mt-p-summary-hint { display: none; }

/* 展开区里的进度块（对应旧版 ReviewProgress） */
.mt-p-progress { padding-top: 0; }
/* 计划信息行 */
.mt-p-plan {
  margin: 0 0 9px;
  font-size: 11.5px;
  color: var(--mt-ink3);
}
/* 参与（旧版放在展开区末尾） */
.mt-p-participants {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 0 12px;
  font-size: 11.5px;
}
.mt-p-participants-lbl { color: var(--mt-ink3); }
.mt-p-participants-who { font-weight: 500; color: var(--mt-ink2); }
.mt-p-participants-who[data-live="1"] { color: var(--mt-amber); }

/* 2026-11-04 修 A6：字形纵向被裁。
   原话「有些字体…下面一半像被砍掉了一样」。根因是若干行用了 nowrap + overflow:hidden
   却没给 line-height，CJK 字形的下缘被行盒切掉。这里统一补 line-height；
   nowrap 保留（顶栏必须单行），只保证行盒足够高。 */
.mt-p { line-height: 1.45; }
.mt-p-summary-main, .mt-p-summary-hint, .mt-p-collapsed-line, .mt-p-plan,
.mt-p-explain, .mt-p-obj, .mt-p-doing, .mt-p-ago, .mt-p-mini-text,
.mt-p-who, .mt-p-metric { line-height: 1.5; }

/* 6 · 参与 */
.mt-p-foot {
  display: flex; align-items: center; gap: 14px;
  padding: 10px 15px;
  border-top: 1px solid var(--mt-hair);
  font-size: 11.5px; color: var(--mt-ink2);
}
.mt-p-foot-lbl { color: var(--mt-ink3); }
.mt-p-foot-who { font-weight: 500; color: var(--mt-ink); }
.mt-p-foot-who[data-live="1"] { color: var(--mt-amber); }

/* 7 · 任务原话 */
.mt-p-obj { padding: 0 15px 11px; font-size: 12px; line-height: 1.55; color: var(--mt-ink2); }

/* 8 · 操作栏 */
.mt-p-ops {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 9px 15px;
  border-top: 1px solid var(--mt-hair);
  background: rgba(255,255,255,.34);
}
.mt-p-btn {
  width: 30px; height: 30px; border-radius: 8px;
  border: 1px solid rgba(0,0,0,.085);
  background: rgba(255,255,255,.85);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background .14s, transform .14s;
  box-shadow: 0 1px 2px rgba(30,50,100,.10);
}
.mt-p-btn:hover { background: #fff; transform: translateY(-1px); }
.mt-p-btn svg { width: 12px; height: 12px; fill: var(--mt-ink2); }
.mt-p-ops-txt { font-size: 11.5px; color: var(--mt-blue); cursor: pointer; }

/* 折叠 / 空闲：一行窄条 */
/* 2026-11-04 第三轮：旧的 .mt-p-mini-* 系列（另一套窄条样式）已删除。
   对应功能随 × 按钮一起移除。 */

/* 2026-11-04 第三轮修复：.mt-chip 的基础规则丢了选择器。
   原文是「直接以 font-size: 10px; 开头、末尾一个右花括号」的裸声明块，
   浏览器解析时会丢弃，导致 .mt-chip 只剩 -ver/-accepted 等修饰类能生效，
   基础排版缺失 —— 表现为「右上角错位/乱码」。
   同时去掉 ui-monospace：它在 Windows 上退化成 Courier New，
   中文与「·」容易被渲染成方块，这是使用者反复点名的「乱码」来源之一。 */
.mt-chip {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(128,128,128,.24);
  color: var(--dsw-alias-label-secondary, #bbb);
  flex: none;
  font-family: inherit;
  line-height: 1.6;
}
/* 2026-11-04 修：.mt-chip-ver 的 font-family: ui-monospace 一并去掉。
   上一轮只清掉了 .mt-chip 基础规则里的等宽字体，修饰类还留着 —— 而
   VersionChip 用的正是 mt-chip mt-chip-ver，所以真正的渲染路径仍然走
   Courier New，乱码风险没有真正消除。这里连修饰类一起换成继承字体。 */
.mt-chip-ver     { background: rgba(128,128,128,.16); color: #b9c2cc; font-family: inherit; letter-spacing: -.2px; }
.mt-chip-accepted { background: rgba(90,190,120,.30); color: #9ff0bd; }
.mt-chip-reported { background: rgba(224,161,60,.30); color: #ffd894; }
.mt-chip-rework   { background: rgba(224,108,108,.30); color: #ffb0b0; }
.mt-chip-pending  { background: rgba(128,128,128,.24); color: #bbb; }
.mt-chip-blocking { background: rgba(224,108,108,.30); color: #ffb0b0; }
.mt-chip-stale    { background: rgba(224,161,60,.26); color: #ffd894; }
/* 自动重载提示条（自更新） */
.mt-reload {
  position: fixed;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-brand-primary, #4a90d9);
  background: var(--dsw-alias-bg-overlay, #1f1f1f);
  color: var(--dsw-alias-label-primary, #eee);
  font-size: 12px;
  box-shadow: 0 6px 24px rgba(0,0,0,.4);
}
.mt-reload button {
  background: none;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.45));
  color: var(--dsw-alias-label-secondary, #bbb);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mt-chip-advisory { background: rgba(224,161,60,.26); color: #ffd894; }
.mt-chip-open      { background: rgba(224,108,108,.22); color: #ffc0c0; }
.mt-chip-responded { background: rgba(74,144,217,.26); color: #a8d0ff; }
.mt-chip-closed    { background: rgba(90,190,120,.22); color: #9ff0bd; }
.mt-empty {
  color: var(--dsw-alias-label-secondary, #888);
  text-align: center;
  padding: 18px 8px;
  font-size: 12px;
}
.mt-error {
  color: var(--dsw-alias-state-error-primary, #e06c6c);
  padding: 10px 8px;
  font-size: 12px;
  word-break: break-word;
}
.mt-foot {
  flex: none;
  padding: 6px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));
  color: var(--dsw-alias-label-secondary, #888);
  font-size: 11px;
  display: flex;
  gap: 8px;
  align-items: center;
}
/* 输入框上方的状态条（conversation.composer.dock） */
.mt-bar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 5px 10px;
  margin-bottom: 6px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.32));
  background: var(--dsw-alias-bg-overlay, rgba(128,128,128,.08));
  color: var(--dsw-alias-label-primary, #eee);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
  transition: border-color .12s, background .12s;
}
/* 第一行：徽章 + 当前焦点 + 进度 + 版本；第二行：导师在做什么（小字） */
.mt-bar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mt-bar-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, #9aa4ae);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mt-bar-sub-dot {
  flex: none;
  opacity: .45;
}
.mt-focus {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #eee);
}
.mt-bar:hover {
  border-color: var(--dsw-alias-brand-primary, #4a90d9);
  background: var(--dsw-alias-bg-overlay, rgba(128,128,128,.14));
}
.mt-bar:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a90d9);
  outline-offset: 1px;
}
.mt-bar-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #ddd);
}
.mt-bar-prog {
  flex: none;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #999);
}
.mt-bar-track {
  flex: none;
  width: 56px;
  height: 4px;
  border-radius: 2px;
  background: rgba(128,128,128,.28);
  overflow: hidden;
}
.mt-bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary, #4a90d9);
  transition: width .25s;
}
.mt-bar-hint {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888);
}
/* 常驻态（没有督导任务）：压暗，避免和「有任务」的进度条混淆 */
.mt-bar-idle {
  border-style: dashed;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #a8a8a8);
}
.mt-bar-idle .mt-bar-text {
  color: var(--dsw-alias-label-secondary, #9a9a9a);
}
`;

  /**
   * 2026-11-04 修 P2-1：把诊断写进 DOM 属性。
   * 浏览器 console 在嵌入场景常抓不到，DOM 属性一定读得到。
   */
  function writeDiagAttr(diag, doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || !d.documentElement) return false;
    try {
      d.documentElement.setAttribute("data-mentor-diag", JSON.stringify(diag));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 2026-11-04 修 P2-1：一处挂载失败必须同时落三处 —— diag 字段（供 selfcheck
   * 上报）、DOM 属性（面板上一眼可见，刷新前就可见）、console.warn（开发时）。
   * 原来只有 diag，页面一刷新就什么也查不到了；ensureStyle 抛错更会把后面所有
   * 诊断一起带走。纯函数便于单测。
   */
  function recordMountFailure(diag, key, err, doc) {
    const msg = String((err && err.message) ?? err);
    diag[key + "Err"] = msg;
    writeDiagAttr(diag, doc);
    return msg;
  }

  const DASHBOARD_CSS = `
/* Round 4 · calm panel. Outer shell carries the material; inner content has no containers.
   Tokens follow the GPT-6.2 spec: 4 font sizes, 4 spacing steps, 2 radii, one accent. */
.mt-work{
  --mt-panel-rgb:250,250,252;
  --mt-ink:#0F1115;--mt-ink2:#1A1D21;--mt-ink3:#2B2F36;
  --mt-line:rgba(15,23,42,.09);--mt-hover:rgba(15,23,42,.045);
  --mt-accent:#3568D4;--mt-on-accent:#FFFFFF;
  --mt-ok:#21835B;--mt-warn:#986300;--mt-err:#C43D42;
  --mt-apple-blue:#007AFF;--mt-apple-green:#34C759;--mt-apple-orange:#FF9500;--mt-apple-red:#FF3B30;
  --mt-glass-hi:rgba(255,255,255,.88);
  --mt-glass-surface:rgba(255,255,255,.82);
  --mt-glass-dot:rgba(15,23,42,.08);
  --mt-ease:cubic-bezier(.22,1,.36,1);
  color-scheme:light;isolation:isolate;z-index:40;
  color:var(--mt-ink);
  background:rgba(var(--mt-panel-rgb),var(--mt-panel-alpha,.92));
  backdrop-filter:blur(var(--mt-panel-blur,22px)) saturate(1.8);
  -webkit-backdrop-filter:blur(var(--mt-panel-blur,22px)) saturate(1.8);
  border:1px solid rgba(15,23,42,.10);border-radius:16px;
  box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 2px 6px rgba(15,23,42,.05),0 18px 42px -18px rgba(15,23,42,.22);
  display:flex;flex-direction:column;min-height:0;overflow:hidden;
  max-width:calc(100vw - 20px);box-sizing:border-box;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing:antialiased;
}
@media(prefers-color-scheme:dark){
  .mt-work[data-appearance-theme=system]{
    --mt-panel-rgb:28,28,31;
    --mt-ink:#F5F6F8;--mt-ink2:#E2E5EA;--mt-ink3:#C8CDD6;
    --mt-line:rgba(255,255,255,.11);--mt-hover:rgba(255,255,255,.07);
    --mt-accent:#82AAFF;--mt-on-accent:#191919;
    --mt-ok:#62C99A;--mt-warn:#DDB56A;--mt-err:#F08080;
    --mt-apple-blue:#0A84FF;--mt-apple-green:#30D158;--mt-apple-orange:#FF9F0A;--mt-apple-red:#FF453A;
    --mt-glass-hi:rgba(255,255,255,.13);
    --mt-glass-surface:rgba(44,44,48,.78);
    --mt-glass-dot:rgba(255,255,255,.075);
    color-scheme:dark;
    border-color:rgba(255,255,255,.13);
    box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 2px 8px rgba(0,0,0,.32),0 22px 48px -18px rgba(0,0,0,.68);
  }
}
.mt-work[data-appearance-theme=dark]{
  --mt-panel-rgb:28,28,31;
  --mt-ink:#F5F6F8;--mt-ink2:#E2E5EA;--mt-ink3:#C8CDD6;
  --mt-line:rgba(255,255,255,.11);--mt-hover:rgba(255,255,255,.07);
  --mt-accent:#82AAFF;--mt-on-accent:#191919;
  --mt-ok:#62C99A;--mt-warn:#DDB56A;--mt-err:#F08080;
  --mt-apple-blue:#0A84FF;--mt-apple-green:#30D158;--mt-apple-orange:#FF9F0A;--mt-apple-red:#FF453A;
  --mt-glass-hi:rgba(255,255,255,.13);
  --mt-glass-surface:rgba(44,44,48,.78);
  --mt-glass-dot:rgba(255,255,255,.075);
  color-scheme:dark;
  border-color:rgba(255,255,255,.13);
  box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 2px 8px rgba(0,0,0,.32),0 22px 48px -18px rgba(0,0,0,.68);
}
.mt-work *{box-sizing:border-box}
.mt-work>*{flex-shrink:0;min-width:0}
.mt-work button,.mt-work select,.mt-work textarea{font:inherit;color:inherit}
.mt-work button{cursor:pointer}
.mt-work button:disabled{cursor:default;opacity:.45}
.mt-work :focus-visible{outline:2px solid var(--mt-accent);outline-offset:1px}
.mt-num,.mt-work-count,.mt-record-time,.mt-tab-n,.mt-work-appearance output{font-variant-numeric:tabular-nums}
.mt-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* Header */
.mt-work-top{display:flex;align-items:center;gap:8px;padding:12px 12px 4px}
.mt-work-expand{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:0;border:0;background:none;text-align:left}
.mt-work-logo{width:21px;height:21px;border-radius:6px;display:grid;place-items:center;flex:none;font-size:11px;font-weight:600;color:var(--mt-accent);background:color-mix(in srgb,var(--mt-accent) 12%,transparent)}
.mt-work-title{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-work-prog{display:inline-flex;align-items:center;gap:8px;flex:none}
.mt-work-meter{width:34px;height:3px;border-radius:2px;background:var(--mt-line);overflow:hidden;flex:none}
.mt-work-meter>i{display:block;height:100%;background:var(--mt-accent);transition:width 120ms var(--mt-ease)}
.mt-work[data-phase=completed] .mt-work-meter>i{background:var(--mt-ok)}
.mt-work-count{font-size:12px;color:var(--mt-ink2)}
.mt-work-chev{flex:none;font-size:11px;color:var(--mt-ink3);transition:color 120ms var(--mt-ease)}
.mt-work-expand:hover .mt-work-chev{color:var(--mt-ink)}

/* Status: dot + text, no pill background */
.mt-work-badge{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:12px;font-weight:500;white-space:nowrap;color:var(--mt-ink2);transition:color 120ms var(--mt-ease)}
.mt-work-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.mt-work-badge[data-status=pass],.mt-work-badge[data-status=accepted],.mt-work-badge[data-status=completed],.mt-work-badge[data-status=closed]{color:var(--mt-ok)}
.mt-work-badge[data-status=active],.mt-work-badge[data-status=running],.mt-work-badge[data-status=streaming],.mt-work-badge[data-status=executing],.mt-work-badge[data-status=responded]{color:var(--mt-accent)}
.mt-work-badge[data-status=reviewing],.mt-work-badge[data-status=reported],.mt-work-badge[data-status=awaiting-integration],.mt-work-badge[data-status=awaiting-approval],.mt-work-badge[data-status=rework],.mt-work-badge[data-status=paused],.mt-work-badge[data-status=open]{color:var(--mt-warn)}
.mt-work-badge[data-status=failed],.mt-work-badge[data-status=revise],.mt-work-badge[data-status=error],.mt-work-badge[data-status=rejected],.mt-work-badge[data-status=stopped]{color:var(--mt-err)}
.mt-work-badge[data-live='1']::before{animation:mtBreath 1.8s ease-in-out infinite}
@keyframes mtBreath{0%,100%{opacity:1}50%{opacity:.45}}

/* Sub-line */
.mt-work-next{display:flex;align-items:center;gap:8px;padding:0 12px 12px 41px;font-size:12px;color:var(--mt-ink2)}
.mt-work-next>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-icon-btn{width:24px;height:24px;display:inline-grid;place-items:center;flex:none;margin:-4px -4px -4px 0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--mt-ink3);transition:color 120ms var(--mt-ease),background-color 120ms var(--mt-ease)}
.mt-icon-btn:hover{color:var(--mt-ink);background:var(--mt-hover)}
.mt-work-link{padding:0;border:0;background:none;font-size:12px;color:var(--mt-accent)}

/* Empty */
.mt-work-empty{margin:0;padding:0 12px 12px 41px;font-size:12px;color:var(--mt-ink2);overflow-wrap:anywhere}
.mt-work-body .mt-work-empty{padding:16px 0;text-align:center}
.mt-work-empty-tools{display:inline-flex;align-items:center;gap:4px;flex:none}
.mt-work-muted{font-size:12px;color:var(--mt-ink2)}
.mt-work-error{color:var(--mt-err);overflow-wrap:anywhere}

/* Tabs: text + 2px underline */
.mt-work-tabs{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;border-top:1px solid var(--mt-line);border-bottom:1px solid var(--mt-line)}
.mt-work-tablist{display:flex;gap:16px;min-width:0;overflow-x:auto;scrollbar-width:none}
.mt-work-tablist::-webkit-scrollbar{display:none}
.mt-work-tabs [role=tab]{display:inline-flex;align-items:center;gap:4px;height:32px;margin-bottom:-1px;padding:0;border:0;border-bottom:2px solid transparent;background:none;font-size:13px;font-weight:500;color:var(--mt-ink2);white-space:nowrap;transition:color 120ms var(--mt-ease),border-color 120ms var(--mt-ease)}
.mt-work-tabs [role=tab]:hover{color:var(--mt-ink)}
.mt-work-tabs [role=tab].selected{color:var(--mt-ink);font-weight:600;border-bottom-color:var(--mt-accent)}
.mt-tab-n{font-size:11px;color:var(--mt-ink3)}
.mt-tab-n-warn{color:var(--mt-err);font-weight:600}
.mt-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--mt-accent);animation:mtBreath 1.8s ease-in-out infinite}
.mt-work-picker{max-width:160px;min-width:0;padding:2px 6px;border:1px solid var(--mt-line);border-radius:6px;background:transparent;font-size:12px;color:var(--mt-ink);text-overflow:ellipsis}
.mt-work-picker option{background:rgb(var(--mt-panel-rgb));color:var(--mt-ink)}

/* Body */
.mt-work-body{flex:0 1 auto;min-height:0;max-height:min(40vh,340px);overflow:auto;overscroll-behavior:contain;padding:12px;scrollbar-width:thin;animation:mtFade 100ms var(--mt-ease)}
.mt-work-body:focus-visible{outline-offset:-2px}
.mt-work-body p{margin:4px 0;overflow-wrap:anywhere}
@keyframes mtFade{from{opacity:0}to{opacity:1}}

.mt-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 9px}
.mt-sec-title{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;font-weight:600;letter-spacing:-.01em;color:var(--mt-ink2)}
.mt-sec-meta{margin-left:0;font-weight:400;color:var(--mt-ink3)}
/* macOS Segmented Control */
.mt-seg-mini{display:inline-flex;align-items:center;gap:2px;padding:2.5px;border:1px solid var(--mt-line);border-radius:9px;background:color-mix(in srgb,var(--mt-ink) 5%,transparent)}
.mt-seg-mini button{height:21px;padding:0 10px;border:0;border-radius:6.5px;background:transparent;font-size:11.5px;font-weight:500;color:var(--mt-ink3);transition:color 140ms var(--mt-ease),background-color 140ms var(--mt-ease),box-shadow 140ms var(--mt-ease)}
.mt-seg-mini button:hover{color:var(--mt-ink)}
.mt-seg-mini button.selected{color:var(--mt-ink);font-weight:600;background:var(--mt-glass-surface);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 1px 3px rgba(0,0,0,.16)}

/* Apple System Capsules & Pills */
.mt-pill{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:1;border:1px solid var(--mt-line);background:color-mix(in srgb,var(--mt-ink) 4.5%,transparent);color:var(--mt-ink2);white-space:nowrap}
.mt-pill[data-rigor=strict]{border-color:color-mix(in srgb,var(--mt-apple-orange) 36%,transparent);background:color-mix(in srgb,var(--mt-apple-orange) 13%,transparent);color:var(--mt-apple-orange)}
.mt-pill[data-rigor=express]{border-color:color-mix(in srgb,var(--mt-apple-green) 36%,transparent);background:color-mix(in srgb,var(--mt-apple-green) 13%,transparent);color:var(--mt-apple-green)}
.mt-pill[data-rigor=standard]{border-color:color-mix(in srgb,var(--mt-apple-blue) 34%,transparent);background:color-mix(in srgb,var(--mt-apple-blue) 12%,transparent);color:var(--mt-apple-blue)}
.mt-chip-btn{display:inline-flex;align-items:center;gap:4px;height:25px;padding:0 11px;border:1px solid var(--mt-line);border-radius:999px;background:var(--mt-glass-surface);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 1px 2px rgba(0,0,0,.08);font-size:11.5px;font-weight:500;color:var(--mt-ink);transition:border-color 140ms var(--mt-ease),background-color 140ms var(--mt-ease),color 140ms var(--mt-ease),transform 140ms var(--mt-ease)}
.mt-chip-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--mt-apple-blue) 52%,transparent);background:color-mix(in srgb,var(--mt-apple-blue) 12%,var(--mt-glass-surface));color:var(--mt-apple-blue);transform:translateY(-.5px)}

/* Apple Frosted Notification Banners */
.mt-alerts{display:flex;flex-direction:column;gap:7px;margin:0 0 10px}
.mt-callout{display:flex;flex-direction:column;gap:6px;margin:0 0 8px;padding:8px 11px;border:1px solid color-mix(in srgb,var(--mt-apple-orange) 28%,transparent);border-radius:12px;background:color-mix(in srgb,var(--mt-apple-orange) 8%,transparent);box-shadow:inset 0 1px 0 var(--mt-glass-hi)}
.mt-alerts .mt-callout{margin:0}
.mt-callout-err{border-color:color-mix(in srgb,var(--mt-apple-red) 30%,transparent);background:color-mix(in srgb,var(--mt-apple-red) 8.5%,transparent)}
.mt-callout-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.mt-callout-text{flex:1;min-width:0;font-size:12px;line-height:1.45;color:var(--mt-ink)}
.mt-callout-actions{display:inline-flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap}
.mt-btn-link{flex:none;padding:3px 10px;border:1px solid color-mix(in srgb,var(--mt-apple-blue) 34%,transparent);border-radius:999px;background:color-mix(in srgb,var(--mt-apple-blue) 12%,transparent);font-size:11.5px;font-weight:600;color:var(--mt-apple-blue);transition:background-color 140ms var(--mt-ease),border-color 140ms var(--mt-ease)}
.mt-btn-link:hover:not(:disabled){background:color-mix(in srgb,var(--mt-apple-blue) 20%,transparent);border-color:color-mix(in srgb,var(--mt-apple-blue) 55%,transparent)}

/* Apple Freeform / MindNode Organic Mind-Map Canvas */
.mt-mm-shell{display:flex;flex-direction:column;gap:0;border:1px solid var(--mt-line);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--mt-ink) 2.2%,transparent);box-shadow:inset 0 1px 0 var(--mt-glass-hi)}
.mt-mm-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--mt-line);background:color-mix(in srgb,var(--mt-ink) 3%,transparent);font-size:11px;color:var(--mt-ink3)}
.mt-mm-legend{display:inline-flex;align-items:center;gap:9px;min-width:0;overflow:hidden;white-space:nowrap}
.mt-mm-legend-item{display:inline-flex;align-items:center;gap:4px}
.mt-mm-legend-dot{width:6.5px;height:6.5px;border-radius:50%;flex:none;background:var(--mt-ink3)}
.mt-mm-legend-dot[data-tone=ok]{background:var(--mt-apple-green);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mt-apple-green) 22%,transparent)}
.mt-mm-legend-dot[data-tone=live]{background:var(--mt-apple-blue);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mt-apple-blue) 22%,transparent)}
.mt-mm-legend-dot[data-tone=warn]{background:var(--mt-apple-orange);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mt-apple-orange) 22%,transparent)}
.mt-mm-tools{display:inline-flex;align-items:center;gap:3px;flex:none;padding:2px;border-radius:999px;background:color-mix(in srgb,var(--mt-ink) 4.5%,transparent)}
.mt-mm-tool{height:20px;min-width:20px;padding:0 7px;border:0;border-radius:999px;background:transparent;font-size:11px;font-weight:500;color:var(--mt-ink2);transition:background-color 140ms var(--mt-ease),color 140ms var(--mt-ease),box-shadow 140ms var(--mt-ease)}
.mt-mm-tool:hover{color:var(--mt-ink);background:var(--mt-hover)}
.mt-mm-tool.active{color:var(--mt-apple-blue);background:var(--mt-glass-surface);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 1px 2px rgba(0,0,0,.12);font-weight:600}
.mt-mm-viewport{position:relative;overflow:auto;max-height:228px;padding:12px 10px;overscroll-behavior:contain;scrollbar-width:thin;background-image:radial-gradient(var(--mt-glass-dot) 1.15px,transparent 1.15px);background-size:18px 18px}
.mt-mm-stage{position:relative;transform-origin:0 0;transition:transform 160ms var(--mt-ease)}
.mt-mm-svg{position:absolute;inset:0;pointer-events:none;overflow:visible}
.mt-mm-edge{fill:none;stroke:color-mix(in srgb,var(--mt-ink3) 40%,transparent);stroke-linecap:round;transition:opacity 160ms var(--mt-ease),stroke 160ms var(--mt-ease)}
.mt-mm-edge[data-tone=ok]{stroke:color-mix(in srgb,var(--mt-apple-green) 78%,transparent)}
.mt-mm-edge[data-tone=live]{stroke:var(--mt-apple-blue);stroke-dasharray:6 4;animation:mtFlow 1.25s linear infinite}
.mt-mm-edge[data-tone=warn]{stroke:color-mix(in srgb,var(--mt-apple-orange) 86%,transparent)}
.mt-mm-edge[data-dim='1']{opacity:.18}
.mt-mm-edge[data-focus='1']{opacity:1}
.mt-mm-dot-end{fill:color-mix(in srgb,var(--mt-ink3) 56%,transparent);transition:opacity 160ms var(--mt-ease)}
.mt-mm-dot-end[data-tone=ok]{fill:var(--mt-apple-green)}
.mt-mm-dot-end[data-tone=live]{fill:var(--mt-apple-blue)}
.mt-mm-dot-end[data-tone=warn]{fill:var(--mt-apple-orange)}
.mt-mm-dot-end[data-dim='1']{opacity:.18}
/* MindNode / Freeform Squircle Nodes */
.mt-mm-node{position:absolute;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:7px 11px;border:1px solid var(--mt-line);border-radius:13px;background:var(--mt-glass-surface);color:var(--mt-ink);text-align:left;box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 2px 8px -3px rgba(0,0,0,.18);transition:border-color 160ms var(--mt-ease),box-shadow 160ms var(--mt-ease),opacity 160ms var(--mt-ease),transform 160ms var(--mt-ease)}
.mt-mm-node:hover{border-color:color-mix(in srgb,var(--mt-apple-blue) 56%,transparent);transform:translateY(-1.5px);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 8px 18px -8px rgba(0,0,0,.28)}
.mt-mm-node[data-dim='1']{opacity:.32}
.mt-mm-node[data-selected='1']{border-color:var(--mt-apple-blue);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 0 0 3px color-mix(in srgb,var(--mt-apple-blue) 28%,transparent),0 8px 20px -8px rgba(0,0,0,.30);transform:translateY(-1px)}
.mt-mm-root{border-color:color-mix(in srgb,var(--mt-apple-blue) 48%,var(--mt-line));border-radius:14px;background:linear-gradient(160deg,color-mix(in srgb,var(--mt-apple-blue) 16%,var(--mt-glass-surface)),var(--mt-glass-surface))}
.mt-mm-stage-node[data-tone=ok]{border-color:color-mix(in srgb,var(--mt-apple-green) 42%,var(--mt-line));background:linear-gradient(180deg,color-mix(in srgb,var(--mt-apple-green) 8%,var(--mt-glass-surface)),var(--mt-glass-surface))}
.mt-mm-stage-node[data-tone=live]{border-color:color-mix(in srgb,var(--mt-apple-blue) 52%,var(--mt-line));background:linear-gradient(180deg,color-mix(in srgb,var(--mt-apple-blue) 10%,var(--mt-glass-surface)),var(--mt-glass-surface))}
.mt-mm-stage-node[data-tone=warn]{border-color:color-mix(in srgb,var(--mt-apple-orange) 50%,var(--mt-line));background:linear-gradient(180deg,color-mix(in srgb,var(--mt-apple-orange) 9%,var(--mt-glass-surface)),var(--mt-glass-surface))}
.mt-mm-stage-node[data-tone=wait]{border-color:var(--mt-line)}
.mt-mm-node-top{display:flex;align-items:center;gap:5px;font-size:10.5px;line-height:1.25;color:var(--mt-ink3);white-space:nowrap;overflow:hidden}
.mt-mm-node-id{font-weight:600;color:var(--mt-ink2)}
.mt-mm-node-stat{margin-left:auto;font-size:10px;font-weight:600;color:var(--mt-ink3)}
.mt-mm-node-stat[data-tone=ok]{color:var(--mt-apple-green)}
.mt-mm-node-stat[data-tone=live]{color:var(--mt-apple-blue)}
.mt-mm-node-stat[data-tone=warn]{color:var(--mt-apple-orange)}
.mt-mm-node-title{font-size:12px;font-weight:600;letter-spacing:-.012em;line-height:1.3;color:var(--mt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-mm-node-sub{font-size:10.5px;line-height:1.25;color:var(--mt-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-mm-node-sub[data-err='1']{color:var(--mt-apple-red);font-weight:500}
.mt-mm-leaf{position:absolute;display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:1px solid var(--mt-line);border-radius:999px;background:var(--mt-glass-surface);box-shadow:inset 0 1px 0 var(--mt-glass-hi),0 1px 3px rgba(0,0,0,.10);font-size:10.5px;line-height:1.35;color:var(--mt-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity 160ms var(--mt-ease),border-color 160ms var(--mt-ease)}
.mt-mm-leaf[data-tone=ok]{border-color:color-mix(in srgb,var(--mt-apple-green) 42%,transparent);color:var(--mt-apple-green)}
.mt-mm-leaf[data-tone=warn]{border-color:color-mix(in srgb,var(--mt-apple-orange) 46%,transparent);color:var(--mt-apple-orange)}
.mt-mm-leaf[data-tone=err]{border-color:color-mix(in srgb,var(--mt-apple-red) 48%,transparent);color:var(--mt-apple-red)}
.mt-mm-leaf[data-dim='1']{opacity:.26}

/* Apple Sheet-Style Node Inspector */
.mt-mm-inspector{padding:10px 12px;border-top:1px solid var(--mt-line);background:color-mix(in srgb,var(--mt-glass-surface) 92%,transparent);display:flex;flex-direction:column;gap:7px;animation:mtFade 120ms var(--mt-ease)}
.mt-mm-insp-head{display:flex;align-items:center;gap:7px;min-width:0}
.mt-mm-insp-title{font-size:12.5px;font-weight:600;letter-spacing:-.012em;color:var(--mt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.mt-mm-insp-close{width:22px;height:22px;border:0;border-radius:999px;background:color-mix(in srgb,var(--mt-ink) 6%,transparent);color:var(--mt-ink2);display:inline-grid;place-items:center;flex:none;transition:background-color 140ms var(--mt-ease),color 140ms var(--mt-ease)}
.mt-mm-insp-close:hover{color:var(--mt-ink);background:color-mix(in srgb,var(--mt-ink) 12%,transparent)}
.mt-mm-insp-grid{display:flex;flex-wrap:wrap;gap:6px}
.mt-mm-insp-list{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--mt-ink2)}
.mt-mm-insp-row{display:flex;align-items:baseline;gap:6px}
.mt-fold-actions{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:8px}

/* Stage list: icon column + text column, no row cards, no pills */
.mt-stage-list{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.mt-stage-row{display:flex;align-items:flex-start;gap:8px}
.mt-stage-icon{width:14px;height:14px;margin-top:2px;flex:none;display:grid;place-items:center;font-size:11px;font-weight:700;line-height:1;color:var(--mt-ink3);transition:color 120ms var(--mt-ease)}
.mt-stage-icon[data-tone=ok]{color:var(--mt-ok)}
.mt-stage-icon[data-tone=live]{color:var(--mt-accent)}
.mt-stage-icon[data-tone=warn]{color:var(--mt-warn)}
.mt-stage-main{flex:1;min-width:0}
.mt-stage-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.mt-stage-title{font-size:13px;font-weight:500;overflow-wrap:anywhere}
.mt-stage-row[data-tone=wait] .mt-stage-title{color:var(--mt-ink2)}
.mt-tag{flex:none;font-size:11px;color:var(--mt-ink3)}
.mt-stage-attempt{flex:none;font-size:11px;color:var(--mt-warn)}
.mt-stage-sub{margin-top:2px;font-size:12px;color:var(--mt-ink2);overflow-wrap:anywhere}

/* Folds: separated by a hairline */
.mt-fold{margin-top:12px;border-top:1px solid var(--mt-line)}
.mt-fold>summary{display:flex;align-items:center;gap:8px;padding:8px 0 0;list-style:none;cursor:pointer;user-select:none;font-size:12px;font-weight:600;color:var(--mt-ink2)}
.mt-fold>summary::-webkit-details-marker{display:none}
.mt-fold>summary::after{content:'';width:6px;height:6px;margin-left:auto;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.7;transform:rotate(-45deg);transition:transform 120ms var(--mt-ease)}
.mt-fold[open]>summary::after{transform:rotate(45deg)}
.mt-fold-body{padding:8px 0 0}
.mt-record .mt-fold{margin-top:8px;border-top:0}
.mt-record .mt-fold>summary{padding-top:0}

/* Criteria and proofs */
.mt-crit-list{display:flex;flex-direction:column;gap:8px}
.mt-crit-head{display:flex;align-items:baseline;gap:8px}
.mt-crit-mark{width:14px;flex:none;text-align:center;font-size:11px;color:var(--mt-ink3)}
.mt-crit-mark[data-done='1']{color:var(--mt-ok);font-weight:700}
.mt-crit-text{flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere}
.mt-crit-proofs{display:flex;flex-direction:column;gap:4px;margin:4px 0 0 22px;padding-left:16px}
.mt-proof-chip{font-size:12px;color:var(--mt-ink2);overflow-wrap:anywhere}
.mt-proof-chip strong{font-weight:500;color:var(--mt-ink)}
.mt-proof-chip code{font-size:11px;color:var(--mt-ink3)}
.mt-proof-chip pre{margin:4px 0 0;padding-left:8px;border-left:2px solid var(--mt-line);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 'Cascadia Mono',Consolas,'Microsoft YaHei',monospace;color:var(--mt-ink2)}

/* Records (agents / reviews / issues): whitespace + hairline */
.mt-work-records{display:flex;flex-direction:column}
.mt-record{min-width:0;padding:12px 0;border-top:1px solid var(--mt-line);overflow-wrap:anywhere}
.mt-record:first-child{padding-top:0;border-top:0}
.mt-record:last-child{padding-bottom:0}
.mt-record-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.mt-record-title{font-size:13px;font-weight:600}
.mt-record-time{margin-left:auto;font-size:11px;color:var(--mt-ink3)}
.mt-record-body{margin:4px 0 0;font-size:13px}
.mt-record-sub{margin:4px 0 0;font-size:12px;color:var(--mt-ink2)}
.mt-work-avatar{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;flex:none;font-size:11px;font-weight:600;color:var(--mt-accent);background:color-mix(in srgb,var(--mt-accent) 12%,transparent)}
.mt-work-issue[data-status=closed]{opacity:.88}
.mt-issue-blocking{font-size:11px;font-weight:600;color:var(--mt-err)}
.mt-inline-action{margin-left:auto;padding:0;border:0;background:none;font-size:12px;color:var(--mt-ink3);transition:color 120ms var(--mt-ease)}
.mt-inline-action:hover:not(:disabled){color:var(--mt-err)}
.mt-close-editor{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.mt-close-editor textarea,.mt-work-team-input textarea{width:100%;min-height:44px;resize:vertical;padding:4px 8px;border:1px solid var(--mt-line);border-radius:6px;background:transparent;outline:none;font-size:12px;line-height:1.5;color:var(--mt-ink);transition:border-color 120ms var(--mt-ease)}
.mt-close-editor textarea:focus,.mt-work-team-input textarea:focus{border-color:var(--mt-accent)}
.mt-close-actions{display:flex;justify-content:flex-end;gap:8px}
.mt-closed-toggle{margin-top:12px;padding:0;border:0;background:none;text-align:left;font-size:12px;color:var(--mt-ink3)}
.mt-closed-toggle:hover{color:var(--mt-ink)}
.mt-btn-text{height:28px;padding:0 8px;border:0;border-radius:6px;background:none;font-size:12px;color:var(--mt-ink2);transition:color 120ms var(--mt-ease),background-color 120ms var(--mt-ease)}
.mt-btn-text:hover:not(:disabled){color:var(--mt-ink);background:var(--mt-hover)}
.mt-btn-primary{height:28px;padding:0 12px;border:0;border-radius:6px;background:var(--mt-accent);font-size:12px;font-weight:600;color:var(--mt-on-accent)}

/* Output: no box, a neutral rule on the left */
.mt-stream{position:relative;margin-top:8px}
.mt-work-output{margin:0;max-height:150px;overflow:auto;padding:0 0 0 8px;border-left:2px solid var(--mt-line);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 'Cascadia Mono',Consolas,'Microsoft YaHei',monospace;color:var(--mt-ink2);scrollbar-width:thin}
.mt-work-stream{max-height:190px}
.mt-stream-latest{position:absolute;right:8px;bottom:8px;height:24px;padding:0 8px;border:1px solid var(--mt-line);border-radius:6px;background:rgb(var(--mt-panel-rgb));font-size:12px;color:var(--mt-accent);box-shadow:0 2px 8px -2px rgba(0,0,0,.18)}
.mt-work-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mt-work-events,.mt-work-stages{margin:4px 0;padding-left:16px}
.mt-work-events li,.mt-work-stages li{padding:2px 0;font-size:12px;color:var(--mt-ink2)}

/* Team */
.mt-work-team{display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--mt-line);overflow-wrap:anywhere}
.mt-work-team .mt-fold{margin-top:0;border-top:0}
.mt-work-team .mt-fold>summary{padding-top:0}
.mt-work-team-input{display:grid;gap:8px}
.mt-work-team-input .mt-work-picker{width:100%;max-width:100%;padding:4px 8px}

/* DAG inside the calm panel */
.mt-work .mt-dag-scroll{max-height:180px;margin:0;padding:4px 2px}
.mt-work .mt-dag-node,.mt-work .mt-dag-node[data-tone]{gap:2px;padding:6px 8px;border:1px solid var(--mt-line);border-radius:6px;background:rgb(var(--mt-panel-rgb));box-shadow:none;color:var(--mt-ink)}
.mt-work .mt-dag-node:hover{transform:none;box-shadow:none}
.mt-work .mt-dag-node[data-tone=ok]{border-color:color-mix(in srgb,var(--mt-ok) 40%,transparent)}
.mt-work .mt-dag-node[data-tone=live]{border-color:color-mix(in srgb,var(--mt-accent) 55%,transparent)}
.mt-work .mt-dag-node[data-tone=warn]{border-color:color-mix(in srgb,var(--mt-warn) 55%,transparent)}
.mt-work .mt-dag-node[data-tone=wait]{opacity:.92}
.mt-work .mt-dag-name{font-size:12px;font-weight:600}
.mt-work .mt-dag-top{font-size:11px;color:var(--mt-ink2)}
.mt-work .mt-dag-edge,.mt-work .mt-dag-arrow{stroke:color-mix(in srgb,var(--mt-ink3) 55%,transparent)}
.mt-work .mt-dag-edge.done,.mt-work .mt-dag-arrow.done{stroke:var(--mt-ok)}
.mt-work .mt-dag-edge.live,.mt-work .mt-dag-arrow.live{stroke:var(--mt-accent)}
.mt-work .mt-dag-dot{background:var(--mt-ink3);box-shadow:none}
.mt-work .mt-dag-dot.ok{background:var(--mt-ok)}
.mt-work .mt-dag-dot.live{background:var(--mt-accent);box-shadow:none}
.mt-work .mt-dag-dot.warn{background:var(--mt-warn);box-shadow:none}

/* Footer: one primary, quiet secondaries */
.mt-work-footer{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border-top:1px solid var(--mt-line)}
.mt-work-foot-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mt-work-foot-left{display:inline-flex;align-items:center;gap:8px;min-width:0}
.mt-stale-notice{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--mt-warn)}
.mt-work-controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
.mt-work-controls button{height:28px;padding:0 13px;border:0;border-radius:8px;background:transparent;font-size:12px;font-weight:500;color:var(--mt-ink);transition:background-color 140ms var(--mt-ease),color 140ms var(--mt-ease),transform 140ms var(--mt-ease)}
.mt-work-controls button:hover:not(:disabled){background:var(--mt-hover)}
.mt-work-controls button.mt-ctrl-primary{background:var(--mt-apple-blue);font-weight:600;color:#FFFFFF;box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 1px 3px rgba(0,122,255,.28)}
.mt-work-controls button.mt-ctrl-primary:hover:not(:disabled){background:color-mix(in srgb,var(--mt-apple-blue) 90%,#fff);transform:translateY(-.5px)}
.mt-work-controls button.mt-ctrl-subtle{color:var(--mt-ink3)}
.mt-work-controls button.mt-ctrl-subtle:hover:not(:disabled){background:color-mix(in srgb,var(--mt-apple-red) 10%,transparent);color:var(--mt-apple-red)}

/* Appearance: a section, not a card */
.mt-work-appearance-button{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;font-size:12px;color:var(--mt-ink3);transition:color 120ms var(--mt-ease),background-color 120ms var(--mt-ease)}
.mt-work-appearance-button:hover{color:var(--mt-ink);background:var(--mt-hover)}
.mt-work-appearance-button[aria-expanded=true]{color:var(--mt-accent)}
.mt-work-appearance{margin:0 12px;padding:12px 0;border-top:1px solid var(--mt-line);color:var(--mt-ink)}
.mt-work-appearance-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600;color:var(--mt-ink2)}
.mt-work-appearance-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.mt-work-appearance label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mt-ink2)}
.mt-work-appearance-head{display:flex;align-items:center;justify-content:space-between;gap:4px}
.mt-work-appearance-head output{font-weight:500;color:var(--mt-ink)}
.mt-work-appearance input[type=range]{width:100%;margin:4px 0;accent-color:var(--mt-accent);cursor:pointer}
.mt-work-appearance-pills{display:inline-flex;gap:12px}
.mt-work-appearance-pills button{padding:0;border:0;background:none;font-size:12px;color:var(--mt-ink3)}
.mt-work-appearance-pills button.selected{color:var(--mt-accent);font-weight:600}
.mt-work-appearance-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:12px}
.mt-work-appearance-actions button{height:28px;padding:0 8px;border:0;border-radius:6px;background:none;font-size:12px;color:var(--mt-ink2)}
.mt-work-appearance-actions button:hover{color:var(--mt-ink);background:var(--mt-hover)}

/* Short viewport: the shell owns the only vertical scroll */
.mt-work[data-compact='1']{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.mt-work[data-compact='1'] .mt-work-body{max-height:none;overflow:visible}

/* v0.4: Undo archive banner, shift handoff, project lessons */
.mt-work-empty-card .mt-callout{margin:8px 12px 0}
.mt-lesson-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--mt-line);font-size:12px;line-height:1.45;color:var(--mt-ink)}
.mt-lesson-row:last-child{border-bottom:0}
.mt-lesson-ops{display:inline-flex;align-items:center;gap:8px;flex:none}
.mt-handoff-cmd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:1px solid var(--mt-line);border-radius:6px;background:var(--mt-subtle);font-size:12px;color:var(--mt-ink)}
.mt-handoff-cmd code{font-family:'Cascadia Mono',Consolas,monospace;font-size:11.5px;color:var(--mt-ink);overflow-wrap:anywhere}

/* Light motion */
@keyframes mtSheetIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes mtSheetOut{from{opacity:1}to{opacity:0}}
.mt-work[data-motion=opening]{animation:mtSheetIn 160ms var(--mt-ease)}
.mt-work[data-motion=closing]{animation:mtSheetOut 100ms var(--mt-ease) forwards}

@media(max-width:560px){
  .mt-work-next,.mt-work-empty{padding-left:12px}
  .mt-work-appearance-grid{grid-template-columns:1fr}
  .mt-work-foot-row{flex-wrap:wrap}
}
@media(prefers-reduced-motion:reduce){
  .mt-work,.mt-work *,.mt-work *::before,.mt-work *::after{animation:none!important;transition:none!important}
  [data-mentor-toggle]{transition:none}
}

/* Header toggle feedback */
[data-mentor-toggle]{transition:background-color 160ms ease,color 160ms ease,box-shadow 160ms ease}
[data-mentor-toggle][aria-expanded=true]{box-shadow:0 0 0 2px rgba(53,104,212,.12)}
`;

  function ensureStyle() {
    if (typeof document === "undefined") return;
    const selector = 'style[data-plugin-css="' + STYLE_KEY + '"]';
    const existing = document.querySelector(selector);
    // 2026-11-04 修 B10：原来「已存在就直接 return」，样式改动在已打开的页面上
    // 永远不生效，必须手动重启才能看到 —— 用户为此重复说了十几次「已经重启了」。
    // 改成内容比对：不同就原地替换。CSS 约 20KB 的字符串比较，挂载期只跑一次，
    // 开销可忽略；换来的是改样式不必重启。
    if (existing) {
      if (existing.textContent !== CSS + DASHBOARD_CSS) existing.textContent = CSS + DASHBOARD_CSS;
      return;
    }
    const el = document.createElement("style");
    el.setAttribute("data-plugin-css", STYLE_KEY);
    el.textContent = CSS + DASHBOARD_CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ================================================================== *
   * 取数：/api/mentor/state，404 回退 /mentor 通道
   * ================================================================== */

  /**
   * 归一化宿主返回：两条通道（fetch 注册表 / rpc）都返回
   *   { ok: true, value: <mentor 任务状态值> }
   * 而任务状态值本身就是 { taskId, revision, phase, criteria, stages, ... }，
   * **没有**再包一层 { task }。客户端两个消费者（状态条 / 面板）都按 { task } 取值，
   * 所以在取数出口统一补齐。
   *
   * 2026-11-03 修：此前直接假设 value.task，导致真机上
   *   - 状态条恒为 idle（拿不到 task 就 return null，界面上看不到任何东西）
   *   - 面板恒显示「点击刷新取数」
   * 而服务端 /api/mentor/state 其实已经返回了 phase=completed、revision=12 的任务。
   * 三种形状都接受：{task}、裸任务、null。
   */
  function normalizeState(env) {
    if (!env || env.ok !== true) return env;
    const v = env.value;
    if (v === null || v === undefined) return { ok: true, value: { task: null } };
    if (typeof v !== "object") return { ok: true, value: { task: null } };
    if (Object.prototype.hasOwnProperty.call(v, "task")) {
      return { ok: true, value: { ...v, task: v.task === undefined ? null : v.task } };
    }
    if (typeof v.taskId === "string") return { ok: true, value: { task: v, tasks: v.tasks || [] } };
    // 兼容旧测试夹具/旧版宿主：任务对象用 id + phase 标识
    if (typeof v.id === "string" && typeof v.phase === "string") {
      return { ok: true, value: { task: v } };
    }
    return { ok: true, value: { task: null } };
  }

  /**
   * 取数超时：宿主忙 / 连接半死时 connection.rpc.call 可能永不 settle。
   * 没有超时的话 ComposerBar 会冻结在旧状态、MentorPanel 的 loading 永不复位
   * （刷新按钮永久 disabled），而且定时器还会不断往上堆挂起请求。
   *
   * 2026-11-03 修：默认 8s，`__test.setFetchTimeout(ms)` 可调（只为单测）。
   */
  const FETCH_TIMEOUT = { ms: 8000 };

  function withTimeout(promise, ms, label) {
    if (!(ms > 0)) return promise;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`${label} 取数超时（${ms}ms）`));
      }, ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  function fetchState(ctx, selection = {}) {
    const connection =
      ctx && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
    if (
      !connection ||
      !connection.rpc ||
      typeof connection.rpc.call !== "function"
    ) {
      return Promise.resolve({
        ok: false,
        error: { code: "E_NO_CONNECTION", message: "connection 服务不可用" },
      });
    }

    // 保持同步调用（不要包进微任务）：单测靠「调用即产生一条 pending」来驱动，
    // 延后一拍会让取数变成异步发起、断言时机全乱。同步抛错单独兜住。
    const call = (channel, method) => {
      let pending;
      try {
        pending = connection.rpc.call(channel, method, selection);
      } catch (err) {
        return Promise.reject(err);
      }
      return withTimeout(pending, FETCH_TIMEOUT.ms, method);
    };

    return call("/api", "mentor/state")
      .catch((err) => {
        const msg = String((err && err.message) ?? err);
        // 宿主没有 fetch 注册表时该路径 404，回退到 rpc 通道
        if (/HTTP 404\b/.test(msg) || /\b404\b/.test(msg)) {
          return call("/mentor", "state");
        }
        throw err;
      })
      .then(normalizeState)
      .catch((err) => ({
        ok: false,
        error: {
          code: "E_FETCH_FAILED",
          message: String((err && err.message) ?? err),
        },
      }));
  }

  /**
   * 调控制接口（Clear / 暂停 / 恢复 / 关闭导师 / 启用导师）。
   *
   * 2026-11-04：服务端的六个控制接口原本只有 tool 通道（模型调用），
   * 而 UI 按钮走的是 connection rpc（客户端通道）——两套通道不互通。
   * 服务端在同一个端点里加了 action 分派（commandHandler），这里配套发 payload。
   *
   * @param {object} ctx cordis 上下文
   * @param {string} action 工具名，如 mentor_task_clear
   * @param {object} [params]
   * @returns {Promise<{ok:boolean, value?:object, error?:{code:string,message:string,details?:object}}>}
   */
  function callCommand(ctx, action, params = {}) {
    const connection =
      ctx && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
    if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
      return Promise.resolve({
        ok: false,
        error: { code: "E_NO_CONNECTION", message: "connection 服务不可用" },
      });
    }
    const run = (channel, method) => {
      let pending;
      try {
        pending = connection.rpc.call(channel, method, { action, params });
      } catch (err) {
        return Promise.reject(err);
      }
      return withTimeout(pending, FETCH_TIMEOUT.ms, `${method}:${action}`);
    };
    return run("/api", "mentor/state")
      .catch((err) => {
        const msg = String((err && err.message) ?? err);
        if (/HTTP 404\b/.test(msg) || /\b404\b/.test(msg)) {
          return run("/mentor", "state");
        }
        throw err;
      })
      .then((raw) => {
        if (raw && typeof raw === "object" && "ok" in raw) return raw;
        return {
          ok: false,
          error: { code: "E_BAD_RESPONSE", message: "控制响应形状异常" },
        };
      })
      .catch((err) => ({
        ok: false,
        error: {
          code: "E_COMMAND_FAILED",
          message: String((err && err.message) ?? err),
        },
      }));
  }

  /* ================================================================== *
   * 小组件
   * ================================================================== */

  const PHASE_CLASS = {
    planning: "mt-badge-planning",
    // 2026-11-04 控制接口：新增三个状态对应的徽标样式
    "awaiting-approval": "mt-badge-planning",
    active: "mt-badge-active",
    reviewing: "mt-badge-reviewing",
    paused: "mt-badge-warn",
    completed: "mt-badge-completed",
    archived: "mt-badge-idle",
  };

  function chip(label, kind) {
    return React.createElement(
      "span",
      { className: "mt-chip" + (kind ? " mt-chip-" + kind : "") },
      label,
    );
  }

  function SectionTitle(text, count) {
    return React.createElement(
      "div",
      { className: "mt-section-title" },
      React.createElement("span", null, text),
      typeof count === "number"
        ? React.createElement("span", { className: "mt-count" }, "(" + count + ")")
        : null,
    );
  }

  /** 计划验收项：显示被哪些 stage 引用 */
  function CriteriaBlock(criteria, stages) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return React.createElement("div", { className: "mt-empty" }, "尚无验收项");
    }
    const refBy = {};
    for (const st of stages || []) {
      for (const cid of st.criterionIds || []) {
        (refBy[cid] = refBy[cid] || []).push(st.id);
      }
    }
    return React.createElement(
      "div",
      null,
      ...criteria.map((c) =>
        React.createElement(
          "div",
          { className: "mt-row", key: "crit-" + c.id },
          React.createElement(
            "div",
            { className: "mt-row-main" },
            React.createElement("span", { className: "mt-id" }, c.id),
            React.createElement("span", { className: "mt-text" }, c.text || ""),
          ),
          refBy[c.id]
            ? React.createElement(
                "div",
                { className: "mt-meta" },
                "被阶段引用：" + refBy[c.id].join(", "),
              )
            : React.createElement(
                "div",
                { className: "mt-meta" },
                "未被任何阶段引用",
              ),
        ),
      ),
    );
  }

  /** 阶段：合并 stages 定义与 nodeRuns 运行态 */
  function StagesBlock(stages, nodeRuns) {
    if (!Array.isArray(stages) || stages.length === 0) {
      return React.createElement("div", { className: "mt-empty" }, "尚无阶段");
    }
    const runOf = {};
    for (const run of nodeRuns || []) runOf[run.stageId] = run;

    return React.createElement(
      "div",
      null,
      ...stages.map((st) => {
        const run = runOf[st.id];
        const status = run ? run.status : "pending";
        const deps = (st.dependsOn || []).join(", ");
        const reports = run && Array.isArray(run.reports) ? run.reports.length : 0;
        return React.createElement(
          "div",
          { className: "mt-row", key: "stage-" + st.id },
          React.createElement(
            "div",
            { className: "mt-row-main" },
            React.createElement("span", { className: "mt-id" }, st.id),
            React.createElement(
              "span",
              { className: "mt-text" },
              st.title || "(未命名阶段)",
            ),
            chip(status, status),
          ),
          React.createElement(
            "div",
            { className: "mt-meta" },
            "attempt " + (run ? run.attempt : 0),
            " · 上报 " + reports + " 次",
            deps ? " · 依赖 " + deps : " · 无依赖",
          ),
        );
      }),
    );
  }

  /** 未关闭问题：区分 severity 与 status */
  function FindingsBlock(unresolved) {
    const items = (unresolved && unresolved.items) || [];
    if (items.length === 0) {
      return React.createElement(
        "div",
        { className: "mt-empty" },
        "没有未关闭的问题",
      );
    }
    return React.createElement(
      "div",
      null,
      ...items.map((f) =>
        React.createElement(
          "div",
          { className: "mt-row", key: "find-" + f.id },
          React.createElement(
            "div",
            { className: "mt-row-main" },
            React.createElement("span", { className: "mt-id" }, f.id),
            chip(f.severity, f.severity),
            chip(f.status, f.status),
          ),
          React.createElement(
            "div",
            { className: "mt-meta mt-text" },
            f.text || "",
          ),
        ),
      ),
    );
  }

  /* ================================================================== *
   * 主组件
   * ================================================================== */

  /* ------------------------------------------------------------------ *
   * DAG 图：拓扑分层 + 贝塞尔连线
   *
   * 布局思路（参考旧督导插件的分层算法，代码独立实现）：
   *   1. level(id) = max(依赖的 level) + 1 —— 无依赖在第 0 列
   *   2. 同列按 stages 出现顺序纵向堆叠
   *   3. 每列按「本列行数 vs 最大行数」垂直居中，避免上重下轻
   *   4. 连线从父节点右边缘到子节点左边缘，三次贝塞尔 + 小箭头
   * 数据全部来自 task.stages[].dependsOn 与 nodeRuns[].status，不额外取数。
   * ------------------------------------------------------------------ */

  const DAG_NODE_W = 152;
  const DAG_NODE_H = 62;
  const DAG_COL_GAP = 22;
  const DAG_ROW_GAP = 12;
  const DAG_PAD = 6;

  /** 取某个 stage 的依赖 id 列表；兼容 dependsOn 缺失或非数组 */
  function dagDependencies(stages, index) {
    const stage = stages[index];
    const raw = stage && Array.isArray(stage.dependsOn) ? stage.dependsOn : [];
    const known = new Set(stages.map((s) => s && s.id));
    return raw.filter((id) => known.has(id));
  }

  /** 递归求层级，用 Map 记忆化；环由 seen 集合挡住，避免无限递归 */
  function dagLayout(stages) {
    const colStep = DAG_NODE_W + DAG_COL_GAP;
    const rowStep = DAG_NODE_H + DAG_ROW_GAP;
    const levels = new Map();
    const visiting = new Set();
    const levelOf = (index) => {
      const id = stages[index] && stages[index].id;
      if (levels.has(id)) return levels.get(id);
      if (visiting.has(id)) return 0; // 环：就地截断，不抛错
      visiting.add(id);
      const deps = dagDependencies(stages, index);
      let value = 0;
      if (deps.length > 0) {
        value = -1;
        for (const depId of deps) {
          const depIndex = stages.findIndex((s) => s && s.id === depId);
          if (depIndex >= 0) value = Math.max(value, levelOf(depIndex));
        }
        value += 1;
      }
      visiting.delete(id);
      levels.set(id, value);
      return value;
    };

    const rowsPerCol = new Map();
    const placed = [];
    stages.forEach((stage, i) => {
      const col = levelOf(i);
      const row = rowsPerCol.get(col) || 0;
      rowsPerCol.set(col, row + 1);
      placed.push({ stage, index: i, col, row });
    });

    const maxRows = Math.max(1, ...rowsPerCol.values());
    const positions = new Map();
    for (const item of placed) {
      const x = DAG_PAD + item.col * colStep;
      const centred = item.row + (maxRows - (rowsPerCol.get(item.col) || 1)) / 2;
      const y = DAG_PAD + centred * rowStep;
      positions.set(item.stage.id, { x, y, col: item.col, row: item.row });
    }

    const cols = Math.max(0, ...levels.values()) + 1;
    return {
      positions,
      width: DAG_PAD * 2 + cols * DAG_NODE_W + (cols - 1) * DAG_COL_GAP,
      height: DAG_PAD * 2 + maxRows * DAG_NODE_H + (maxRows - 1) * DAG_ROW_GAP,
    };
  }

  /** 节点状态 → 视觉分类 */
  function dagNodeTone(status) {
    if (status === "accepted" || status === "passed") return "ok";
    if (status === "rework" || status === "rejected" || status === "awaiting-integration") return "warn";
    if (status === "reported" || status === "reviewing") return "live";
    if (status === "running" || status === "in_progress") return "live";
    return "wait";
  }

  function dagStatusLabel(status) {
    return (
      {
        accepted: "已通过",
        passed: "已通过",
        reported: "待审查",
        reviewing: "审查中",
        rework: "待返工",
        rejected: "需修订",
        "awaiting-integration": "待核对",
        running: "执行中",
        in_progress: "执行中",
        pending: "待开始",
      }[status] || "待开始"
    );
  }

  function DAGView({ task, compact }) {
    const stages = Array.isArray(task.stages) ? task.stages : [];
    if (stages.length === 0) return null;
    const runs = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
    const runById = new Map(runs.filter(Boolean).map((r) => [r.stageId, r]));
    const layout = dagLayout(stages);
    const h = DAG_NODE_H;

    const edges = [];
    stages.forEach((stage, i) => {
      const to = layout.positions.get(stage.id);
      if (!to) return;
      for (const depId of dagDependencies(stages, i)) {
        const from = layout.positions.get(depId);
        if (!from) continue;
        const x1 = from.x + DAG_NODE_W;
        const y1 = from.y + h / 2;
        const x2 = to.x;
        const y2 = to.y + h / 2;
        const mx = (x1 + x2) / 2;
        const childRun = runById.get(stage.id);
        const tone = dagNodeTone(childRun && childRun.status);
        const cls = tone === "live" ? "live" : tone === "ok" ? "done" : "";
        edges.push(
          React.createElement("path", {
            key: "e-" + depId + "-" + stage.id,
            className: "mt-dag-edge " + cls,
            d: `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
          }),
          React.createElement("path", {
            key: "a-" + depId + "-" + stage.id,
            className: "mt-dag-arrow " + cls,
            d: `M${x2 - 5} ${y2 - 3.5} L${x2} ${y2} L${x2 - 5} ${y2 + 3.5}`,
          }),
        );
      }
    });

    const nodes = stages.map((stage) => {
      const pos = layout.positions.get(stage.id);
      if (!pos) return null;
      const run = runById.get(stage.id);
      const status = (run && run.status) || "pending";
      const tone = dagNodeTone(status);
      const attempt = run && Number(run.attempt) > 1 ? " · 第 " + run.attempt + " 次" : "";
      return React.createElement(
        "div",
        {
          key: stage.id,
          className: "mt-dag-node",
          "data-tone": tone,
          style: { left: pos.x + "px", top: pos.y + "px", width: DAG_NODE_W + "px", height: h + "px" },
          title: (stage.title || stage.id) + " · " + dagStatusLabel(status),
        },
        React.createElement(
          "span",
          { className: "mt-dag-top" },
          React.createElement("i", { className: "mt-dag-dot " + tone }),
          stage.id + " · " + dagStatusLabel(status) + attempt,
        ),
        React.createElement("span", { className: "mt-dag-name" }, stage.title || stage.id),
      );
    });

    return React.createElement(
      "div",
      { className: "mt-dag-scroll" + (compact ? " mt-dag-scroll-compact" : "") },
      React.createElement(
        "div",
        {
          className: "mt-dag-canvas",
          style: { width: layout.width + "px", height: layout.height + "px" },
        },
        React.createElement(
          "svg",
          {
            className: "mt-dag-svg",
            width: layout.width,
            height: layout.height,
            "aria-hidden": "true",
          },
          edges,
        ),
        nodes,
      ),
    );
  }

  /* ------------------------------------------------------------------ *
   * 交互式思维导图（MindMapView）：Whimsical / XMind / Linear 风格
   *
   * 布局算法（纯函数 layoutMindMap，无外部依赖，可单测）：
   *   - 第 0 列：任务总目标根节点（Root），纵向居中
   *   - 第 1..K 列：按 DAG 拓扑深度排布各阶段节点，平行分支自然分叉、汇聚
   *   - 最末梢分支（可选展开）：挂出该阶段的验收标准 / 变更收据 / 前置检查微胶囊
   *   - 三次贝塞尔曲线按层级渐变线宽（根分支 2.2px → 阶段依赖 1.8px → 叶子 1.3px）
   *   - 点击任意节点：聚焦其上下游依赖链（无关节点压暗至 36%）+ 底部弹出轻量节点详情
   * ------------------------------------------------------------------ */

  const MM_ROOT_W = 126;
  const MM_ROOT_H = 58;
  const MM_STAGE_W = 156;
  const MM_STAGE_H = 62;
  const MM_LEAF_W = 142;
  const MM_LEAF_H = 22;
  const MM_COL_GAP = 26;
  const MM_ROW_GAP = 12;
  const MM_LEAF_GAP = 6;
  const MM_PAD = 10;

  /**
   * 为节点收集轻量末梢分支标签（不重复阶段标题，保持概览零重复）。
   */
  function buildStageLeaves(stage, run, task, claimById) {
    const leaves = [];
    const pre = run?.lastPrecheck || task?.lastPrechecks?.[stage.id];
    if (pre && pre.ok === false) {
      leaves.push({
        id: stage.id + ':pre',
        tone: 'err',
        text: '! 前置失败 ' + pre.failed + '/' + pre.total,
        title: '前置硬检查未通过（' + pre.failed + '/' + pre.total + ' 失败）',
      });
    } else if (pre && pre.ok === true && pre.total > 0) {
      leaves.push({
        id: stage.id + ':pre',
        tone: 'ok',
        text: '✓ 检查 ' + pre.passed + '/' + pre.total,
        title: '前置硬检查通过（' + pre.passed + '/' + pre.total + '）',
      });
    }
    const audit = task?.lastDiffAudits?.[stage.id];
    if (audit) {
      const undeclared = audit.undeclaredFiles?.length ?? audit.undeclaredCount ?? 0;
      leaves.push({
        id: stage.id + ':diff',
        tone: undeclared > 0 ? 'warn' : 'ok',
        text: 'Δ +' + (audit.totalAddedLines || 0) + '/-' + (audit.totalRemovedLines || 0) + (undeclared > 0 ? ' · 未声明' + undeclared : ''),
        title: '变更 ' + (audit.totalChangedFiles || 0) + ' 个文件',
      });
    }
    const cids = Array.isArray(stage.criterionIds) ? stage.criterionIds : [];
    for (const cid of cids.slice(0, 2)) {
      const cl = claimById.get(cid);
      const done = Boolean(cl?.proofs?.length);
      const rawText = cl?.title || cid;
      leaves.push({
        id: stage.id + ':crit:' + cid,
        tone: done ? 'ok' : 'wait',
        text: (done ? '✓ ' : '○ ') + (rawText.length > 14 ? rawText.slice(0, 14) + '…' : rawText),
        title: rawText,
      });
    }
    if (cids.length > 2) {
      leaves.push({
        id: stage.id + ':more',
        tone: 'wait',
        text: '+ 其余 ' + (cids.length - 2) + ' 项标准',
        title: '点击节点查看全部验收标准',
      });
    }
    return leaves.slice(0, 4);
  }

  /**
   * 计算思维导图坐标、连线与依赖集合（纯函数，环安全）。
   */
  function layoutMindMap(task, { showLeaves = false } = {}) {
    const stages = Array.isArray(task?.stages) ? task.stages : [];
    const runs = Array.isArray(task?.nodeRuns) ? task.nodeRuns : [];
    const runById = new Map(runs.filter(Boolean).map((r) => [r.stageId, r]));
    const claimById = new Map();
    for (const c of (task?.progress?.claims || [])) {
      if (c && c.id) claimById.set(c.id, c);
    }
    for (const c of (task?.criteria || [])) {
      if (c && c.id && !claimById.has(c.id)) claimById.set(c.id, { id: c.id, title: c.text || c.id, proofs: [] });
    }
    if (stages.length === 0) {
      return { root: null, nodes: [], leaves: [], edges: [], width: 0, height: 0, parentsOf: new Map(), childrenOf: new Map() };
    }

    const base = dagLayout(stages);
    const parentsOf = new Map();
    const childrenOf = new Map();
    stages.forEach((st, i) => {
      const deps = dagDependencies(stages, i);
      parentsOf.set(st.id, deps);
      for (const dep of deps) {
        if (!childrenOf.has(dep)) childrenOf.set(dep, []);
        childrenOf.get(dep).push(st.id);
      }
    });

    // 按列分组
    const colsMap = new Map();
    let maxStageCol = 0;
    for (const st of stages) {
      const p = base.positions.get(st.id);
      const col = p ? p.col : 0;
      if (col > maxStageCol) maxStageCol = col;
      if (!colsMap.has(col)) colsMap.set(col, []);
      colsMap.get(col).push(st);
    }

    // 决定哪些节点展开末梢微胶囊（仅无下游依赖的末梢节点，避免连线交叉）
    const leavesByStage = new Map();
    let maxLeafStackH = 0;
    if (showLeaves) {
      for (const st of stages) {
        const isTerminal = !(childrenOf.get(st.id)?.length);
        if (!isTerminal) continue;
        const lf = buildStageLeaves(st, runById.get(st.id), task, claimById);
        if (lf.length) {
          leavesByStage.set(st.id, lf);
          const stackH = lf.length * MM_LEAF_H + (lf.length - 1) * MM_LEAF_GAP;
          if (stackH > maxLeafStackH) maxLeafStackH = stackH;
        }
      }
    }

    // 计算每列所需的行槽高度（有末梢分支的列给足垂直空间防重叠）
    let maxColHeight = MM_ROOT_H;
    const colSlotHeights = new Map();
    for (const [col, list] of colsMap.entries()) {
      const heights = list.map((st) => {
        const lf = leavesByStage.get(st.id);
        const leafH = lf ? lf.length * MM_LEAF_H + (lf.length - 1) * MM_LEAF_GAP : 0;
        return Math.max(MM_STAGE_H, leafH);
      });
      colSlotHeights.set(col, heights);
      const totalH = heights.reduce((a, b) => a + b, 0) + Math.max(0, list.length - 1) * MM_ROW_GAP;
      if (totalH > maxColHeight) maxColHeight = totalH;
    }

    const totalHeight = MM_PAD * 2 + Math.max(maxColHeight, maxLeafStackH, MM_ROOT_H);
    const rootX = MM_PAD;
    const rootY = Math.round((totalHeight - MM_ROOT_H) / 2);
    const root = { id: '__root__', x: rootX, y: rootY, w: MM_ROOT_W, h: MM_ROOT_H };

    const stageXBase = rootX + MM_ROOT_W + MM_COL_GAP;
    const stageStepX = MM_STAGE_W + MM_COL_GAP;
    const nodePos = new Map();
    const nodes = [];
    const leaves = [];

    for (const [col, list] of colsMap.entries()) {
      const heights = colSlotHeights.get(col);
      const colH = heights.reduce((a, b) => a + b, 0) + Math.max(0, list.length - 1) * MM_ROW_GAP;
      let cursorY = Math.round((totalHeight - colH) / 2);
      const x = stageXBase + col * stageStepX;
      list.forEach((stage, idx) => {
        const slotH = heights[idx];
        const y = Math.round(cursorY + (slotH - MM_STAGE_H) / 2);
        const run = runById.get(stage.id);
        const status = (run && run.status) || 'pending';
        const tone = dagNodeTone(status);
        const item = { id: stage.id, stage, run, status, tone, x, y, w: MM_STAGE_W, h: MM_STAGE_H, col };
        nodePos.set(stage.id, item);
        nodes.push(item);

        const lf = leavesByStage.get(stage.id);
        if (lf && lf.length) {
          const stackH = lf.length * MM_LEAF_H + (lf.length - 1) * MM_LEAF_GAP;
          let ly = Math.round(cursorY + (slotH - stackH) / 2);
          const lx = x + MM_STAGE_W + MM_COL_GAP - 6;
          for (const chipItem of lf) {
            leaves.push({ ...chipItem, stageId: stage.id, x: lx, y: ly, w: MM_LEAF_W, h: MM_LEAF_H });
            ly += MM_LEAF_H + MM_LEAF_GAP;
          }
        }
        cursorY += slotH + MM_ROW_GAP;
      });
    }

    const edges = [];
    const bezier = (x1, y1, x2, y2) => {
      const dx = Math.max(16, (x2 - x1) * 0.52);
      return `M${x1} ${y1} C${Math.round(x1 + dx)} ${y1}, ${Math.round(x2 - dx)} ${y2}, ${x2} ${y2}`;
    };

    for (const node of nodes) {
      const deps = parentsOf.get(node.id) || [];
      if (deps.length === 0) {
        const x1 = root.x + root.w;
        const y1 = Math.round(root.y + root.h / 2);
        const x2 = node.x;
        const y2 = Math.round(node.y + node.h / 2);
        edges.push({ id: 'r-' + node.id, from: '__root__', to: node.id, tone: node.tone, strokeWidth: 2.5, d: bezier(x1, y1, x2, y2), endX: x2, endY: y2, kind: 'root' });
      } else {
        for (const depId of deps) {
          const parent = nodePos.get(depId);
          if (!parent) continue;
          const x1 = parent.x + parent.w;
          const y1 = Math.round(parent.y + parent.h / 2);
          const x2 = node.x;
          const y2 = Math.round(node.y + node.h / 2);
          edges.push({ id: depId + '-' + node.id, from: depId, to: node.id, tone: node.tone, strokeWidth: 2.0, d: bezier(x1, y1, x2, y2), endX: x2, endY: y2, kind: 'stage' });
        }
      }
    }

    for (const leaf of leaves) {
      const parent = nodePos.get(leaf.stageId);
      if (!parent) continue;
      const x1 = parent.x + parent.w;
      const y1 = Math.round(parent.y + parent.h / 2);
      const x2 = leaf.x;
      const y2 = Math.round(leaf.y + leaf.h / 2);
      edges.push({ id: 'lf-' + leaf.id, from: leaf.stageId, to: leaf.id, stageId: leaf.stageId, tone: leaf.tone === 'err' ? 'warn' : leaf.tone, strokeWidth: 1.4, d: bezier(x1, y1, x2, y2), endX: x2, endY: y2, kind: 'leaf' });
    }

    const maxNodeRight = nodes.reduce((m, n) => Math.max(m, n.x + n.w), root.x + root.w);
    const maxLeafRight = leaves.reduce((m, l) => Math.max(m, l.x + l.w), maxNodeRight);
    const width = maxLeafRight + MM_PAD;

    return { root, nodes, leaves, edges, width, height: totalHeight, parentsOf, childrenOf };
  }

  /** 计算点击聚焦时，属于目标节点上下游链路的节点集合 */
  function mindMapFocusSet(selectedId, parentsOf, childrenOf) {
    if (!selectedId || selectedId === '__root__') return null;
    const set = new Set(['__root__', selectedId]);
    const walk = (start, adj) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop();
        for (const nxt of (adj.get(cur) || [])) {
          if (!set.has(nxt)) { set.add(nxt); stack.push(nxt); }
        }
      }
    };
    walk(selectedId, parentsOf);
    walk(selectedId, childrenOf);
    return set;
  }

  function MindMapView({ task, claims, checkpoints, busy, rollbackBusy, onPreviewRollback }) {
    const stages = Array.isArray(task?.stages) ? task.stages : [];
    const [showLeaves, setShowLeaves] = React.useState(() => stages.length <= 2);
    const [selectedId, setSelectedId] = React.useState(null);
    const [manualZoom, setManualZoom] = React.useState(null);
    const [viewWidth, setViewWidth] = React.useState(0);
    const viewportRef = React.useRef(null);
    const taskKey = task?.taskId || task?.id || '';
    React.useEffect(() => {
      setSelectedId(null);
      setShowLeaves(stages.length <= 2);
      setManualZoom(null);
    }, [taskKey, stages.length]);

    React.useEffect(() => {
      const el = viewportRef.current;
      if (!el) return undefined;
      const measure = () => {
        const w = el.clientWidth || 0;
        if (w > 0) setViewWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
      };
      measure();
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
      }
      return undefined;
    }, [taskKey]);

    const layout = layoutMindMap(task, { showLeaves });
    if (!layout.root) return null;

    const autoZoom = viewWidth > 40 && layout.width > (viewWidth - 20)
      ? Math.max(0.68, Math.min(1, Math.floor(((viewWidth - 22) / layout.width) * 100) / 100))
      : 1;
    const zoom = manualZoom === null ? autoZoom : manualZoom;

    const accepted = (task.nodeRuns || []).filter((r) => r.status === 'accepted').length;
    const focusSet = mindMapFocusSet(selectedId, layout.parentsOf, layout.childrenOf);
    const selectedNode = selectedId ? layout.nodes.find((n) => n.id === selectedId) : null;
    const claimById = new Map((claims || []).map((c) => [c.id, c]));

    const stageHintText = (node) => {
      const pre = node.run?.lastPrecheck || task.lastPrechecks?.[node.id];
      if (pre && pre.ok === false) return { text: '前置硬检查未通过（' + pre.failed + '/' + pre.total + ' 失败）', err: true };
      const audit = task.lastDiffAudits?.[node.id];
      if (audit) {
        const u = audit.undeclaredFiles?.length ?? audit.undeclaredCount ?? 0;
        return { text: '+' + (audit.totalAddedLines || 0) + '/-' + (audit.totalRemovedLines || 0) + (u > 0 ? ' · 未声明 ' + u : ''), err: u > 0 };
      }
      const cids = node.stage.criterionIds || [];
      if (cids.length) {
        const done = cids.filter((id) => claimById.get(id)?.proofs?.length).length;
        return { text: '验收 ' + done + '/' + cids.length + (node.run?.attempt > 1 ? ' · 第' + node.run.attempt + '轮' : ''), err: false };
      }
      return { text: node.run?.attempt > 1 ? '第' + node.run.attempt + '轮' : dagStatusLabel(node.status), err: false };
    };

    const toggleSelect = (id) => setSelectedId((cur) => (cur === id ? null : id));
    const stepZoom = (delta) => setManualZoom((cur) => {
      const base = cur === null ? autoZoom : cur;
      return Math.max(0.65, Math.min(1.25, Math.round((base + delta) * 100) / 100));
    });

    return h('div', { className: 'mt-mm-shell', 'data-mindmap': '1' },
      h('div', { className: 'mt-mm-bar' },
        h('div', { className: 'mt-mm-legend' },
          h('span', { className: 'mt-mm-legend-item' }, h('i', { className: 'mt-mm-legend-dot', 'data-tone': 'ok' }), '通过'),
          h('span', { className: 'mt-mm-legend-item' }, h('i', { className: 'mt-mm-legend-dot', 'data-tone': 'live' }), '进行中'),
          h('span', { className: 'mt-mm-legend-item' }, h('i', { className: 'mt-mm-legend-dot', 'data-tone': 'warn' }), '返工'),
          h('span', { className: 'mt-mm-legend-item' }, '· 点节点看详情')),
        h('div', { className: 'mt-mm-tools' },
          h('button', { type: 'button', className: 'mt-mm-tool' + (showLeaves ? ' active' : ''), 'aria-pressed': showLeaves, onClick: () => setShowLeaves((v) => !v), title: '展开或收期末梢验收与变更分支' }, showLeaves ? '收起分支' : '展开分支'),
          h('button', { type: 'button', className: 'mt-mm-tool', onClick: () => stepZoom(-0.12), 'aria-label': '缩小导图', title: '缩小' }, '−'),
          h('button', { type: 'button', className: 'mt-mm-tool' + (manualZoom === null ? ' active' : ''), onClick: () => setManualZoom(null), 'aria-label': '自动适应视口', title: '点击自动适应画布宽度' }, Math.round(zoom * 100) + '%'),
          h('button', { type: 'button', className: 'mt-mm-tool', onClick: () => stepZoom(0.12), 'aria-label': '放大导图', title: '放大' }, '+'))),
      h('div', { className: 'mt-mm-viewport', ref: viewportRef },
        h('div', {
          className: 'mt-mm-stage',
          style: {
            width: Math.ceil(layout.width * zoom) + 'px',
            height: Math.ceil(layout.height * zoom) + 'px',
          },
        },
          h('div', {
            style: {
              position: 'relative',
              width: layout.width + 'px',
              height: layout.height + 'px',
              transform: zoom === 1 ? undefined : 'scale(' + zoom + ')',
              transformOrigin: '0 0',
            },
          },
            h('svg', { className: 'mt-mm-svg', width: layout.width, height: layout.height, 'aria-hidden': 'true' },
              layout.edges.map((e) => {
                const isFocused = !focusSet || (e.kind === 'leaf'
                  ? focusSet.has(e.stageId)
                  : (focusSet.has(e.from) && focusSet.has(e.to)));
                return h(React.Fragment, { key: e.id },
                  h('path', {
                    className: 'mt-mm-edge',
                    d: e.d,
                    strokeWidth: e.strokeWidth,
                    'data-tone': e.tone,
                    'data-dim': isFocused ? undefined : '1',
                    'data-focus': focusSet && isFocused ? '1' : undefined,
                  }),
                  h('circle', {
                    className: 'mt-mm-dot-end',
                    cx: e.endX,
                    cy: e.endY,
                    r: e.kind === 'leaf' ? 2.2 : 2.8,
                    'data-tone': e.tone,
                    'data-dim': isFocused ? undefined : '1',
                  }));
              })),
            h('button', {
              type: 'button',
              className: 'mt-mm-node mt-mm-root',
              'data-mindmap-root': '1',
              style: { left: layout.root.x + 'px', top: layout.root.y + 'px', width: layout.root.w + 'px', height: layout.root.h + 'px' },
              onClick: () => setSelectedId(null),
              title: task.objective || '任务总目标',
            },
              h('span', { className: 'mt-mm-node-top' },
                h('span', { className: 'mt-mm-node-id' }, '目标'),
                h('span', { className: 'mt-mm-node-stat mt-num' }, accepted + '/' + stages.length)),
              h('span', { className: 'mt-mm-node-title' }, task.objective || '导师任务'),
              h('span', { className: 'mt-mm-node-sub' }, labelStatus(task.phase) + (task.planVersion ? ' · v' + task.planVersion : ''))),
            layout.nodes.map((node) => {
              const hint = stageHintText(node);
              const isSelected = selectedId === node.id;
              const isDim = Boolean(focusSet && !focusSet.has(node.id));
              return h('button', {
                key: node.id,
                type: 'button',
                className: 'mt-mm-node mt-mm-stage-node',
                'data-stage-id': node.id,
                'data-tone': node.tone,
                'data-selected': isSelected ? '1' : undefined,
                'data-dim': isDim ? '1' : undefined,
                'aria-pressed': isSelected,
                style: { left: node.x + 'px', top: node.y + 'px', width: node.w + 'px', height: node.h + 'px' },
                onClick: () => toggleSelect(node.id),
                title: (node.stage.title || node.id) + ' · ' + dagStatusLabel(node.status),
              },
                h('span', { className: 'mt-mm-node-top' },
                  h('span', { className: 'mt-mm-node-id' }, node.id),
                  h('span', { className: 'mt-mm-node-stat', 'data-tone': node.tone }, dagStatusLabel(node.status))),
                h('span', { className: 'mt-mm-node-title' }, node.stage.title || node.id),
                h('span', { className: 'mt-mm-node-sub', 'data-err': hint.err ? '1' : undefined }, hint.text));
            }),
            layout.leaves.map((leaf) => {
              const isDim = Boolean(focusSet && !focusSet.has(leaf.stageId));
              return h('div', {
                key: leaf.id,
                className: 'mt-mm-leaf',
                'data-tone': leaf.tone,
                'data-dim': isDim ? '1' : undefined,
                style: { left: leaf.x + 'px', top: leaf.y + 'px', maxWidth: leaf.w + 'px', height: leaf.h + 'px' },
                title: leaf.title || leaf.text,
              }, leaf.text);
            })))),
      selectedNode
        ? (() => {
            const st = selectedNode.stage;
            const pre = selectedNode.run?.lastPrecheck || task.lastPrechecks?.[st.id];
            const audit = task.lastDiffAudits?.[st.id];
            const deps = st.dependsOn || [];
            const cids = st.criterionIds || [];
            const canRollback = Boolean(checkpoints && checkpoints[st.id] && onPreviewRollback);
            return h('div', { className: 'mt-mm-inspector', 'data-mindmap-inspector': st.id },
              h('div', { className: 'mt-mm-insp-head' },
                h('span', { className: 'mt-pill' }, st.id),
                h('span', { className: 'mt-mm-insp-title' }, st.title || st.id),
                h('span', { className: 'mt-pill' }, dagStatusLabel(selectedNode.status) + (selectedNode.run?.attempt > 1 ? ' · 第' + selectedNode.run.attempt + '轮' : '')),
                canRollback
                  ? h('button', { type: 'button', className: 'mt-chip-btn', disabled: busy || rollbackBusy, onClick: () => onPreviewRollback(st.id) }, rollbackBusy ? '预览中…' : '预览回滚')
                  : null,
                h('button', { type: 'button', className: 'mt-mm-insp-close', 'aria-label': '关闭节点详情', onClick: () => setSelectedId(null) }, '×')),
              h('div', { className: 'mt-mm-insp-grid' },
                deps.length ? h('span', { className: 'mt-pill' }, '依赖：' + deps.join(', ')) : h('span', { className: 'mt-pill' }, '入口阶段'),
                st.writePaths?.length ? h('span', { className: 'mt-pill', title: st.writePaths.join(', ') }, '写入范围 ' + st.writePaths.length + ' 项') : null,
                pre ? h('span', { className: 'mt-pill' }, pre.ok ? ('硬检查通过 ' + pre.passed + '/' + pre.total) : ('前置硬检查未通过（' + pre.failed + '/' + pre.total + ' 失败）')) : null,
                audit ? h('span', { className: 'mt-pill' }, '变更 ' + (audit.totalChangedFiles || 0) + ' 文件 (+' + (audit.totalAddedLines || 0) + '/-' + (audit.totalRemovedLines || 0) + ')') : null),
              cids.length
                ? h('div', { className: 'mt-mm-insp-list' }, cids.map((cid) => {
                    const cl = claimById.get(cid);
                    const done = Boolean(cl?.proofs?.length);
                    return h('div', { key: cid, className: 'mt-mm-insp-row' },
                      h('span', { className: 'mt-crit-mark', 'data-done': done ? '1' : '0' }, done ? '✓' : '○'),
                      h('span', null, cl?.title || cid));
                  }))
                : null);
          })()
        : null);
  }

  /**
   * 输入框上方状态条的显隐开关。
   *
   * 2026-11-04 第四轮（用户裁定）：
   *   「点一下右上角的导师模式，显示输入框上方的UI，再点一下就消失」
   *
   * 取代了原先状态条右上角那个 × 小按钮。那个按钮的问题不在「能手动藏」，
   * 而在入口小、隐蔽、藏了之后看不见还容易回不来（点一次就永久消失）。
   * 换成常驻的顶部按钮后：
   *   · 入口一直在，丢不了；
   *   · 开关状态直接体现在按钮高亮上；
   *   · 选择持久化，刷新后保持。
   *
   * 与「有没有任务」是两层判断，互不干扰：
   *   开 → 显示任务或空态；关 → 动画收回后隐藏。
   *   保留组件以完成收回动画，并保留当前页签、滚动及外观设置。
   */
  const BAR_OPEN_KEY = "dsh-mentor:bar-open";
  const barOpenState = {
    open: true,
    trigger: null,
    listeners: new Set(),
    read() {
      try {
        const v =
          typeof localStorage !== "undefined" ? localStorage.getItem(BAR_OPEN_KEY) : null;
        // 没存过 → 默认开（保持「有任务就显示」的原行为，开关只是多一个关闭手段）
        return v === null ? true : v === "1";
      } catch (e) {
        return true;
      }
    },
    set(v) {
      this.open = Boolean(v);
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(BAR_OPEN_KEY, this.open ? "1" : "0");
        }
      } catch (e) {}
      for (const fn of Array.from(this.listeners)) {
        try {
          fn(this.open);
        } catch (e) {}
      }
    },
    toggle(trigger) {
      if (trigger?.isConnected) this.trigger = trigger;
      this.set(!this.open);
      return this.open;
    },
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };
  barOpenState.open = barOpenState.read();

  /**
   * 从状态条根节点枚举「真实进了 DOM 的区块」。
   *
   * 输入必须是**挂载后的真实 DOM 元素**，不是渲染输入。这一点很关键：
   * 2026-11-04 的 s2 版本曾用 `collapsed ? [...] : [...]` 拼出一个应然清单塞进 diag，
   * 再拿它当"证据"断言渲染结果 —— 循环自证，什么也没证明（s2 审查指出）。
   * 现在遍历真实子节点，diag 与渲染树一致。
   *
   * @param {Element|null} root 状态条根节点（.mt-p）
   * @returns {string[]} 区块 class 列表，如 ["mt-p-bar","mt-p-collapsed-line"]
   */
  function collectBarSections(root) {
    if (!root || typeof root !== "object" || !root.children) return [];
    const pick = (el) => {
      const cn = el && typeof el.className === "string" ? el.className : "";
      // 不限定 mt-p- 前缀：DAG 区块用的是 mt-dag-canvas / mt-dag-svg，
      // 若只认 mt-p-* 会把整块 DAG 漏掉，「八段齐全」就断言不出来。
      const m = cn.match(/\bmt-[a-z][a-z0-9-]*\b/);
      return m ? m[0] : null;
    };
    const out = [];
    for (const child of Array.from(root.children)) {
      const name = pick(child);
      if (!name) continue;
      out.push(name);
      // 展开区再多走一层，收叶子区块（进度 / 指标 / 解释 / DAG / 任务原话 / 参与）
      if (name === "mt-p-inner") {
        for (const leaf of Array.from(child.children || [])) {
          const sub = pick(leaf);
          if (sub && sub !== name) out.push(sub);
        }
      }
    }
    return out;
  }

  /**
   * 读状态条顶栏的真实文本（折叠空白、去首尾）。
   * 从 DOM 读而不是拼字符串 —— 只有真实文本才能证明「没有 ui:vN 角标 / 没有重复字符」。
   *
   * @param {Element|null} root 状态条根节点
   * @returns {string|null}
   */
  function readBarText(root) {
    if (!root || typeof root.querySelector !== "function") return null;
    const bar = root.querySelector(".mt-p-bar");
    if (!bar || typeof bar.textContent !== "string") return null;
    return bar.textContent.replace(/\s+/g, " ").trim();
  }

  /**
   * 输入框上方的状态条。
   *
   * 挂在 DSH 官方 slot `conversation.composer.dock`（位于输入框上方），
   * 顶部入口控制显隐；任务详情在输入框上方展开。
   *
   * 数据策略：共享任务快照；按运行状态自适应轮询，无任务时低频发现新任务。
   */

  // Header and dashboard subscribe to one ordered snapshot, including controls.
  const liveState = { value: {task:null,tasks:[],loaded:false,error:null,controlError:null,controlErrorCode:null,controlErrorAt:0,staleNotice:false,undoArchive:null,busy:false,updatedAt:0}, listeners:new Set(), ctx:null, timer:null, pending:null, epoch:0, stopped:true, taskId:null };
  function publishLive(patch) {
    liveState.value={...liveState.value,...patch};
    for(const fn of liveState.listeners) fn(liveState.value);
  }
  function scheduleLive() {
    if(liveState.stopped) return;
    clearTimeout(liveState.timer);
    const t=liveState.value.task;
    // 2026-11-24（Round 5a）：participants 里出现空洞时（旧夹具/掉字段的历史状态）
    // `p.streaming` 会抛 TypeError，而这段跑在 setTimeout 里 —— 一次异常就让轮询链
    // 永久停摆、面板再也不刷新。同文件 isTaskLive 一直是有 `p&&` 保护的，这里补齐。
    const running=t && (t.participants||[]).some(p=>p&&(p.streaming || ['running','streaming','executing','queued'].includes(p.status)));
    const hidden=typeof document!=='undefined' && document.visibilityState==='hidden';
    liveState.timer=setTimeout(refreshLive,hidden?15000:running?1200:t&&!['completed','archived'].includes(t.phase)?2500:10000);
  }
  function refreshLive() {
    if(!liveState.ctx||liveState.stopped) return Promise.resolve();
    if(liveState.pending) return liveState.pending;
    const epoch=liveState.epoch;
    liveState.pending=fetchState(liveState.ctx,liveState.taskId?{taskId:liveState.taskId}:{}).then(env=>{
      if(liveState.stopped||epoch!==liveState.epoch) return;
      if(!env?.ok) { publishLive({loaded:true,error:env?.error?.message||'暂时无法更新任务，正在重连'}); return; }
      const next=env.value?.task??null,old=liveState.value.task;
      if(old&&next&&(old.taskId||old.id)===(next.taskId||next.id)&&Number(next.revision)<Number(old.revision))return;
      const serverUndo=env.value?.recentUndoArchive&&env.value.recentUndoArchive.until>Date.now()?env.value.recentUndoArchive:null;
      const keptUndo=liveState.value.undoArchive&&liveState.value.undoArchive.until>Date.now()?liveState.value.undoArchive:null;
      publishLive({task:next,tasks:env.value?.tasks||next?.tasks||[],loaded:true,error:null,updatedAt:Date.now(),undoArchive:serverUndo||keptUndo});
    }).catch(err=>{if(epoch===liveState.epoch)publishLive({error:String(err?.message||err)});}).finally(()=>{
      liveState.pending=null;
      if(!liveState.stopped&&epoch!==liveState.epoch)refreshLive();else scheduleLive();
    });
    return liveState.pending;
  }
  function startLive(ctx) {
    liveState.ctx=ctx;liveState.stopped=false;refreshLive();
    const visible=()=>{if(document.visibilityState!=='hidden')refreshLive();};
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',visible);
    return ()=>{liveState.stopped=true;liveState.epoch++;clearTimeout(liveState.timer);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visible);};
  }
  function useLiveState() {
    const [state,setState]=React.useState(liveState.value);
    React.useEffect(()=>{liveState.listeners.add(setState);setState(liveState.value);return()=>liveState.listeners.delete(setState);},[]);
    return state;
  }
  function selectTask(taskId) {
    liveState.taskId=taskId||null;liveState.epoch++;
    publishLive({task:null,loaded:false,error:null,controlError:null,controlErrorAt:0,staleNotice:false});refreshLive();
  }
  const STALE_CODES = new Set(['E_STALE_REVISION', 'E_STALE_TASK']);
  const STALE_TEXT = '状态已更新，请核对后再次操作';
  const CONTROL_ERROR_TTL_MS = 8000;
  // A stale revision means the request did not run. The UI refreshes, keeps the
  // user's draft and asks for a deliberate second click; it never replays a write.
  async function runControl(action,params={},opts={}) {
    const t=liveState.value.task;
    const explicitRestore=action==='mentor_task_restore'&&params.taskId&&params.revision!==undefined;
    if((!t&&!explicitRestore)||liveState.value.busy)return{ok:false,error:{message:'任务暂不可操作'}};
    const targetTaskId=explicitRestore?params.taskId:(t.taskId||t.id);
    const targetRevision=explicitRestore?params.revision:t.revision;
    liveState.epoch++;publishLive({busy:true,action,controlError:null,controlErrorCode:null,controlErrorAt:0,staleNotice:false});
    try {
      const result=await callCommand(liveState.ctx,action,{...params,taskId:targetTaskId,revision:targetRevision});
      if(!result?.ok){
        const code=result?.error?.code||null;
        if(!opts.inline){
          if(STALE_CODES.has(code))publishLive({staleNotice:true});
          else publishLive({controlError:result?.error?.message||'操作未成功，请刷新后重试',controlErrorCode:code,controlErrorAt:Date.now()});
        }
      }
      else if(action==='mentor_task_clear'){
        const until=result.value?.archivedUndoUntil||0;
        const nextRev=typeof result.value?.revision==='number'?result.value.revision:((t?.revision??0)+1);
        const undoArchive=until>Date.now()?{taskId:result.value?.taskId||targetTaskId,revision:nextRev,objective:t?.objective||'导师任务',until}:null;
        publishLive({task:t?{...t,phase:'archived',revision:nextRev,archivedUndoUntil:until||undefined,live:false}:null,undoArchive});
      }
      else if(action==='mentor_task_restore'){
        liveState.taskId=result.value?.taskId||targetTaskId||null;
        publishLive({undoArchive:null});
      }
      return result;
    }finally{publishLive({busy:false,action:null});liveState.epoch++;refreshLive();}
  }
  /** Control errors leave the status line after a short while; the operation area keeps details. */
  function activeControlError(v, now = Date.now()) {
    if (!v || !v.controlError) return null;
    return !v.controlErrorAt || now - v.controlErrorAt < CONTROL_ERROR_TTL_MS ? v.controlError : null;
  }
  const STATUS_TEXT={planning:'规划中',active:'执行中',reviewing:'待审查','awaiting-approval':'等待批准',paused:'已暂停',completed:'已完成',archived:'已归档',running:'运行中',streaming:'正在回复',executing:'执行工具',queued:'排队中',pending:'待开始',reported:'待审查',accepted:'已通过',done:'已结束',failed:'失败',error:'错误',stopped:'已停止',cancelled:'已取消',settled:'已结束',dispatched:'已派发',idle:'待命',rework:'待返工',rejected:'需修订',pass:'通过',revise:'需修订',open:'待处理',responded:'待复核',closed:'已关闭','needs-user':'需补充信息',blocked:'受阻',unavailable:'会话不可用','awaiting-integration':'待核对'};
  const h=React.createElement;
  const useIsoLayoutEffect=React.useLayoutEffect||React.useEffect;
  function labelStatus(v){return STATUS_TEXT[v]||v||'未报告状态';}
  function clockText(at, withSec = false){if(!at)return'';const d=new Date(at);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString([],withSec?{hour:'2-digit',minute:'2-digit',second:'2-digit'}:{hour:'2-digit',minute:'2-digit'});}
  function empty(text){return h('p',{className:'mt-work-empty'},text);}
  function stateBadge(status, live){return h('span',{className:'mt-work-badge','data-status':status,...(live?{'data-live':'1'}:{})},labelStatus(status));}
  function textValue(v){return typeof v==='string'?v:v?.text||v?.message||v?.reason||v?.summary||'';}
  function focusLater(id){setTimeout(()=>{try{document.getElementById(id)?.focus({preventScroll:true});}catch{}},0);}
  function slidersIcon(){return h('svg',{width:13,height:13,viewBox:'0 0 16 16',fill:'none','aria-hidden':true},
    h('path',{d:'M2.5 4h11M2.5 8h11M2.5 12h11',stroke:'currentColor',strokeWidth:'1.4',strokeLinecap:'round'}),
    h('circle',{cx:5.5,cy:4,r:1.7,fill:'rgb(var(--mt-panel-rgb))',stroke:'currentColor',strokeWidth:'1.3'}),
    h('circle',{cx:10.5,cy:8,r:1.7,fill:'rgb(var(--mt-panel-rgb))',stroke:'currentColor',strokeWidth:'1.3'}),
    h('circle',{cx:6.5,cy:12,r:1.7,fill:'rgb(var(--mt-panel-rgb))',stroke:'currentColor',strokeWidth:'1.3'}));}
  function refreshIcon(){return h('svg',{width:14,height:14,viewBox:'0 0 16 16',fill:'none','aria-hidden':true},
    h('path',{d:'M13 8a5 5 0 1 1-1.46-3.54',stroke:'currentColor',strokeWidth:'1.4',strokeLinecap:'round'}),
    h('path',{d:'M13 2.5v3h-3',stroke:'currentColor',strokeWidth:'1.4',strokeLinecap:'round',strokeLinejoin:'round'}));}
  function refreshButton(){return h('button',{type:'button',className:'mt-work-link mt-icon-btn',onClick:refreshLive,'aria-label':'刷新任务状态',title:'刷新'},refreshIcon());}

  /* ---- Pure rules (exported for tests) ---- */
  const RUNNING_STATUSES=new Set(['running','streaming','executing']);
  /** Breathing is reserved for work that is actually executing or being reviewed. */
  function isTaskLive(task){
    if(!task)return false;
    return (task.participants||[]).some(p=>p&&(p.streaming||RUNNING_STATUSES.has(p.status)))||
      Boolean(task.activeReview&&RUNNING_STATUSES.has(task.activeReview.status));
  }
  const STREAM_FOLLOW_PX=24;
  function shouldFollowStream({scrollTop=0,clientHeight=0,scrollHeight=0,hasSelection=false}={}){
    return !hasSelection&&scrollHeight-scrollTop-clientHeight<=STREAM_FOLLOW_PX;
  }
  const COMPACT_ENTER_PX=240, COMPACT_EXIT_PX=256;
  /** Hysteresis keeps the layout from flickering around the threshold. */
  function nextCompact(prev, available){
    if(!Number.isFinite(available))return Boolean(prev);
    return prev?available<COMPACT_EXIT_PX:available<COMPACT_ENTER_PX;
  }
  function tabKeyTarget(ids, current, key){
    const i=ids.indexOf(current);
    if(i<0||!ids.length)return null;
    if(key==='ArrowRight')return ids[(i+1)%ids.length];
    if(key==='ArrowLeft')return ids[(i-1+ids.length)%ids.length];
    if(key==='Home')return ids[0];
    if(key==='End')return ids[ids.length-1];
    return null;
  }
  /** Esc leaves the innermost layer first: popover → editor (draft kept) → details. */
  function escapeLayer({showAppearance,closingId,expanded}={}){
    if(showAppearance)return 'appearance';
    if(closingId)return 'editor';
    if(expanded)return 'collapse';
    return null;
  }
  function visibleIssues(items, showClosed){
    const list=Array.isArray(items)?items.filter(Boolean):[];
    const open=list.filter(f=>f.status!=='closed'), closed=list.filter(f=>f.status==='closed');
    return {open,closed,shown:showClosed?[...open,...closed]:open};
  }
  function canSubmitClose(reason, pending){return !pending&&typeof reason==='string'&&reason.trim().length>=1;}

  /** Streaming text follows the tail only while the reader is already at the bottom. */
  function StreamOutput({text, streamKey, label, live}) {
    const ref=React.useRef(null);
    const follow=React.useRef(true);
    const [behind,setBehind]=React.useState(false);
    const selectionInside=()=>{
      try{
        const sel=typeof window!=='undefined'&&window.getSelection?window.getSelection():null;
        const el=ref.current;
        return Boolean(sel&&!sel.isCollapsed&&el&&sel.anchorNode&&el.contains(sel.anchorNode));
      }catch{return false;}
    };
    const measure=()=>{
      const el=ref.current;if(!el)return;
      follow.current=shouldFollowStream({scrollTop:el.scrollTop,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,hasSelection:selectionInside()});
      if(follow.current)setBehind(false);
    };
    useIsoLayoutEffect(()=>{follow.current=true;setBehind(false);const el=ref.current;if(el)el.scrollTop=el.scrollHeight;},[streamKey]);
    useIsoLayoutEffect(()=>{
      const el=ref.current;if(!el)return;
      if(follow.current&&!selectionInside()){el.scrollTop=el.scrollHeight;setBehind(false);}
      else setBehind(true);
    },[text]);
    const jump=()=>{const el=ref.current;follow.current=true;setBehind(false);if(el)el.scrollTop=el.scrollHeight;};
    return h('div',{className:'mt-stream'},
      h('pre',{ref,className:'mt-work-output'+(live?' mt-work-stream':''),'aria-label':label,'aria-live':'off',onScroll:measure},text),
      behind?h('button',{type:'button',className:'mt-stream-latest',onClick:jump},'↓ 查看最新'):null);
  }

  function ParticipantCards({task}) {
    const ps=Array.isArray(task.participants)?task.participants:[];
    if(!ps.length)return empty('暂无智能体活动记录');
    return h('div',{className:'mt-work-records'},ps.map((p,i)=>{
      const live=Boolean(p.streaming||RUNNING_STATUSES.has(p.status));
      const key=p.id||p.sessionId||String(i);
      return h('article',{className:'mt-work-agent mt-record',key},
        h('div',{className:'mt-record-head'},
          h('span',{className:'mt-work-avatar','aria-hidden':true},p.role==='reviewer'?'审':p.role==='worker'?'工':'主'),
          h('span',{className:'mt-record-title'},p.name||({main:'主智能体',worker:'执行助手',reviewer:'独立审查'}[p.role])||'智能体'),
          p.stageId?h('span',{className:'mt-tag'},p.stageId):null,
          p.worktree?.branch?h('span',{className:'mt-tag',title:'Worktree 分支：'+p.worktree.branch+(p.worktree.preservedPath?' · 保留目录：'+p.worktree.preservedPath:'')},'wt:'+({active:'隔离中',captured:'待合并',merged:'已合并','no-changes':'无改动',conflict:'合并冲突','head-drifted':'HEAD漂移','skipped-after-conflict':'冲突暂停','aborted-task-inactive':'任务已停',preserved:'成果已保留'}[p.worktree.status]||p.worktree.status||'active')):null,
          stateBadge(p.status,live),
          p.updatedAt?h('span',{className:'mt-record-time'},clockText(p.updatedAt)):null),
        p.worktree?.detail?h('p',{className:'mt-record-sub'},'Worktree：'+textValue(p.worktree.detail)):null,
        p.worktree?.preservedPath?h('p',{className:'mt-record-sub'},'保留目录：'+p.worktree.preservedPath):null,
        textValue(p.activity)?h('p',{className:'mt-record-sub'},textValue(p.activity)):null,
        p.outputText?h(StreamOutput,{text:p.outputText,streamKey:key,label:'智能体输出',live}):null,
        p.error?h('p',{className:'mt-work-error'},textValue(p.error)):null);
    }));
  }

  function ReviewContent({task}) {
    const active=task.activeReview, reviews=Array.isArray(task.reviews)?task.reviews:task.lastReview?[task.lastReview]:[];
    const scopeLabel=(kind,stageId)=>(stageId&&stageId!=='__plan__'&&stageId!=='__completion__')?stageId:({plan:'计划审查',completion:'整体验收'}[kind]||'阶段审查');
    const activeLive=Boolean(active&&RUNNING_STATUSES.has(active.status));
    return h('div',{className:'mt-work-records'},
      active?h('article',{className:'mt-work-review mt-record'},
        h('div',{className:'mt-record-head'},
          h('span',{className:'mt-record-title'},scopeLabel(active.kind,active.stageId)),
          stateBadge(active.status,activeLive)),
        active.text||active.outputText
          ?h(StreamOutput,{text:active.text||active.outputText,streamKey:active.id||active.reviewJobId||'active',label:'导师当前回复',live:true})
          :h('p',{className:'mt-record-sub'},'审查进行中，等待回复…'),
        active.activities?.length
          ?h('details',{className:'mt-fold'},
              h('summary',null,'活动记录 · '+active.activities.length),
              h('div',{className:'mt-fold-body'},
                h('ul',{className:'mt-work-events'},active.activities.slice(-15).map((v,i)=>h('li',{key:v.id||i},clockText(v.at||v.time,true),' ',v.name||v.type||'',' ',textValue(v))))))
          :null,
        active.error?h('p',{className:'mt-work-error'},textValue(active.error)):null):null,
      reviews.slice().reverse().map((r,i)=>h('article',{className:'mt-work-review mt-record',key:r.id||i},
        h('details',{className:'mt-fold',open:i===0&&(!active||['completed','failed','cancelled'].includes(active.status))},
          h('summary',null,
            h('span',null,scopeLabel(r.scope?.kind||r.kind,r.scope?.stageId||r.stageId)),
            stateBadge(r.verdict),
            r.at?h('span',{className:'mt-record-time'},clockText(r.at)):null),
          h('div',{className:'mt-fold-body'},
            r.summary||r.finding||r.text?h('p',null,r.summary||r.finding||r.text):null,
            (r.findings||[]).map((f,n)=>h('p',{key:f.id||n},textValue(f))),
            (r.existingFindingIds||[]).map(id=>h('p',{key:'existing-'+id,className:'mt-record-sub'},'沿用问题：',textValue((task.findings||[]).find(f=>f.id===id))||id)),
            !(r.findings||[]).length&&!(r.existingFindingIds||[]).length&&!(r.summary||r.finding||r.text)?h('p',{className:'mt-record-sub'},'已记录裁决'):null)))),
      !active&&!reviews.length?empty('暂无审查记录'):null);
  }

  /** Issues: open items by default, one inline close editor at a time, closed items behind a count. */
  function IssueContent({task, busy, closingId, setClosingId, draftsRef, showClosed, setShowClosed}) {
    const items=Array.isArray(task.findings)?task.findings:task.unresolved?.items||[];
    const [,force]=React.useState(0);
    const [pending,setPending]=React.useState(null);
    const [errors,setErrors]=React.useState({});
    // 2026-11-24（Round 5a）：draftsRef 缺省时原来每次渲染都新建 Map，
    // 关闭编辑区 / 按 Esc 后草稿会凭空消失。退化成组件内 ref，保证草稿一定留住。
    const localDrafts=React.useRef(new Map());
    const drafts=draftsRef?.current||localDrafts.current;
    const taskKey=task.taskId||task.id||'';
    const dKey=id=>taskKey?taskKey+':'+id:id;
    const readDraft=id=>drafts.has(dKey(id))?drafts.get(dKey(id)):(drafts.get(id)||'');
    if(!items.length)return empty('暂无待处理问题');
    const {open,closed,shown}=visibleIssues(items,showClosed);
    const writable=task.enabled!==false&&!['archived','completed','paused'].includes(task.phase);
    const stopEditing=id=>{setClosingId?.(null);focusLater('mt-close-'+id);};
    const submit=async f=>{
      const k=dKey(f.id);
      const submittedTaskKey=taskKey;
      const reason=readDraft(f.id).trim();
      if(!canSubmitClose(reason,pending))return;
      setPending(k);setErrors(e=>({...e,[k]:null}));
      let r;
      try{r=await runControl('mentor_finding_close',{findingId:f.id,reason},{inline:true});}
      finally{setPending(p=>p===k?null:p);}
      const currentTaskKey=liveState.value.task?.taskId||liveState.value.task?.id||'';
      if(currentTaskKey&&submittedTaskKey&&currentTaskKey!==submittedTaskKey){
        if(r?.ok){drafts.delete(k);}
        return;
      }
      if(r?.ok){drafts.delete(k);drafts.delete(f.id);setClosingId?.(null);}
      else setErrors(e=>({...e,[k]:STALE_CODES.has(r?.error?.code)?STALE_TEXT:(r?.error?.message||'关闭未成功，请重试')}));
    };
    return h('div',{className:'mt-work-records'},
      !open.length?h('p',{className:'mt-work-empty'},'没有未关闭的问题'):null,
      shown.map(f=>{
        const isOpen=f.status!=='closed', blocking=f.severity==='blocking'&&isOpen, editing=closingId===f.id;
        const k=dKey(f.id), draft=readDraft(f.id), mine=pending===k;
        return h('article',{className:'mt-work-issue mt-record',key:f.id,'data-status':f.status,'data-blocking':blocking?'1':'0'},
          h('div',{className:'mt-record-head'},
            stateBadge(f.status),
            f.stageId&&!['__plan__','__completion__'].includes(f.stageId)?h('span',{className:'mt-tag'},f.stageId):null,
            blocking?h('span',{className:'mt-issue-blocking'},'阻断验收'):null,
            isOpen&&writable&&!editing?h('button',{type:'button',id:'mt-close-'+f.id,className:'mt-inline-action',
              disabled:busy||Boolean(pending)||Boolean(closingId),'aria-label':'人工关闭问题 '+f.id,
              onClick:()=>setClosingId?.(f.id)},'关闭'):null),
          h('p',{className:'mt-record-body'},f.text||f.finding||''),
          !isOpen&&f.closeReason?h('p',{className:'mt-record-sub'},'关闭理由：'+f.closeReason):null,
          editing?h('div',{className:'mt-close-editor',role:'group','aria-label':'人工关闭问题'},
            h('textarea',{rows:2,maxLength:500,value:draft,disabled:mine,autoFocus:true,
              placeholder:'关闭理由（必填，会记入记录）','aria-label':'关闭理由',
              onChange:e=>{drafts.set(k,e.target.value);force(v=>v+1);}}),
            errors[k]?h('p',{className:'mt-work-error',role:'alert'},errors[k]):null,
            h('div',{className:'mt-close-actions'},
              h('button',{type:'button',className:'mt-btn-text',disabled:mine,onClick:()=>stopEditing(f.id)},'取消'),
              h('button',{type:'button',className:'mt-btn-primary',disabled:busy||!canSubmitClose(draft,mine),onClick:()=>submit(f)},mine?'提交中…':'确认关闭'))):null,
          f.responses?.length
            ?h('details',{className:'mt-fold'},
                h('summary',null,'处理记录 · '+f.responses.length),
                h('div',{className:'mt-fold-body'},f.responses.map((r,n)=>h('p',{key:n,className:'mt-record-sub'},r.text||r.response||r.summary||'已记录响应'))))
            :null);
      }),
      closed.length?h('button',{type:'button',className:'mt-closed-toggle','aria-expanded':Boolean(showClosed),
        onClick:()=>setShowClosed?.(v=>!v)},(showClosed?'⌄ ':'› ')+'已关闭 '+closed.length):null);
  }

  function TeamSection({task}) {
    const [stageId, selectStage] = React.useState('');
    const [text, setText] = React.useState('');
    const overview = task.team;
    if (!overview) return null;
    const steps = overview.steps || [];
    const adjustable = steps.filter(step => !['accepted','reported'].includes(step.status));
    const changed = async hold => {
      if (!stageId || !text.trim()) return;
      const result = await runControl('mentor_team_direction', { stageId, direction: text.trim(), hold });
      if (result?.ok) setText('');
    };
    const canAdjust = adjustable.length && !['archived','completed'].includes(task.phase);
    if (!overview.attention && !overview.issue && !overview.hypotheses?.length && !overview.notes?.length && !canAdjust) return null;
    return h('section', {className:'mt-work-team'},
      overview.attention ? h('p', {className:overview.issue ? 'mt-work-error' : 'mt-work-muted', style:{margin:0}}, overview.attention.text)
        : overview.issue ? h('p', {className:'mt-work-error', style:{margin:0}}, overview.issue) : null,
      overview.hypotheses?.length ? h('details', {className:'mt-fold', open:overview.mode === 'diagnosis'},
        h('summary', null, '诊断假设 · '+overview.hypotheses.length),
        h('div', {className:'mt-fold-body'},
          h('ul', {className:'mt-work-stages'}, overview.hypotheses.map(item => h('li', {key:item.id},
            h('div', null, item.text),
            h('small', {className:'mt-work-muted'}, ({unconfirmed:'待核对',supports:'有证据支持',refutes:'已被推翻',conflicting:'证据冲突'})[item.status] + ' · ' + item.nextCheck)))))) : null,
      overview.notes?.length ? h('details', {className:'mt-fold'},
        h('summary', null, '协作记录 · '+overview.notes.length),
        h('div', {className:'mt-fold-body'},
          h('ul', {className:'mt-work-stages'}, [...overview.notes].reverse().map(note =>
            h('li', {key:note.id}, h('div', null, note.text),
              note.evidence ? h('small', {className:'mt-work-muted'}, note.evidence) : null))))) : null,
      canAdjust
        ? h('details', {className:'mt-fold'},
            h('summary', null, '调整阶段方向'),
            h('div', {className:'mt-fold-body'},
              h('div', {className:'mt-work-team-input'},
                h('select', {className:'mt-work-picker', value:stageId, 'aria-label':'调整阶段', onChange:event=>selectStage(event.target.value)},
                  h('option', {value:''}, '选择要调整的阶段…'),
                  adjustable.map(step => h('option', {key:step.id,value:step.id},step.title))),
                h('textarea', {value:text, 'aria-label':'新的执行方向', placeholder:'说明新方向或依据', maxLength:1200, onChange:event=>setText(event.target.value)}),
                h('div', {className:'mt-work-controls'},
                  h('button', {type:'button',className:'mt-ctrl-primary',disabled:!stageId || !text.trim(),onClick:()=>changed(false)}, '应用并继续'),
                  h('button', {type:'button',disabled:!stageId || !text.trim(),onClick:()=>changed(true)}, '暂缓该阶段'))))) : null);
  }

  function renderProofItem(b, key) {
    if (b.receipt) {
      const outcome = ({success:'成功',error:'错误',unavailable:'未提供'})[b.receipt.outcome] || b.receipt.outcome;
      return h('div', {className:'mt-proof-chip', key},
        h('strong', null, b.receipt.tool + ' · ' + outcome),
        b.receipt.target ? ' · ' + b.receipt.target : '',
        b.receipt.error ? ' · ' + b.receipt.error : '',
        b.receipt.sha256 ? h('code', {title:'SHA-256: ' + b.receipt.sha256}, ' · #' + b.receipt.sha256.slice(0, 8)) : null);
    }
    if (b.file) {
      return h('div', {className:'mt-proof-chip', key},
        h('strong', null, b.file.file),
        b.file.line ? ' · L' + b.file.line : ' · 全文',
        b.file.snippet ? h('pre', null, b.file.snippet) : null);
    }
    if (b.recheck) {
      return h('div', {className:'mt-proof-chip', key},
        h('strong', null, '自动返工回执'),
        ' · 重开 ' + (b.recheck.reopenedStages || []).join('、'));
    }
    if (b.handoff) {
      return h('div', {className:'mt-proof-chip', key},
        h('strong', null, '助手交接'),
        ' · ',
        (b.handoff.inputs || []).map(x => x.stageId + '/' + x.criterionId).join('、'));
    }
    if (b.check) {
      return h('div', {className:'mt-proof-chip', key},
        h('strong', null, b.check.source || '审查核验'),
        b.check.observation ? ' · ' + b.check.observation : '');
    }
    return h('div', {className:'mt-proof-chip', key}, '已记录验收依据');
  }

  function OverviewContent({task, busy, onSwitchTab}) {
    const [stageView, setStageView] = React.useState('mindmap');
    const [copyState, setCopyState] = React.useState('idle');
    const [lessonPending, setLessonPending] = React.useState(null);
    const [rollbackPreview, setRollbackPreview] = React.useState(null);
    const [rollbackBusy, setRollbackBusy] = React.useState(false);
    const [receiptPreview, setReceiptPreview] = React.useState(null);
    const [exportNotice, setExportNotice] = React.useState('');
    const taskIdKey = task.taskId || task.id || '';
    React.useEffect(() => { setRollbackPreview(null); setReceiptPreview(null); setExportNotice(''); }, [taskIdKey]);
    const stages = task.stages || [];
    const runs = task.nodeRuns || [];
    const progress = task.progress;
    const stepById = new Map((progress?.steps || []).map(s => [s.id, s]));
    const accepted = runs.filter(r => r.status === 'accepted').length;
    const running = runs.filter(r => ['running', 'in_progress'].includes(r.status)).length;
    const p = task.parallelism;
    const taskId = task.taskId || task.id || '';
    const takeoverCmd = taskId ? '/mentor takeover ' + taskId : '';
    const showHandoff = Boolean(taskId && stages.length > 0 && !['archived', 'completed'].includes(task.phase));
    const projectLessons = task.projectLessons || null;
    const candidateLessons = Array.isArray(projectLessons?.candidates) ? projectLessons.candidates : [];
    const acceptedLessons = Array.isArray(projectLessons?.accepted) ? projectLessons.accepted : [];
    const lessonTotal = candidateLessons.length + acceptedLessons.length;
    const rigorInfo = task.rigor || null;
    const rigorLabel = rigorInfo?.tier === 'express' ? '快速' : rigorInfo?.tier === 'strict' ? '严格' : rigorInfo?.tier === 'standard' ? '标准' : null;
    const diffAudits = task.lastDiffAudits && typeof task.lastDiffAudits === 'object' ? Object.entries(task.lastDiffAudits) : [];
    const diffTotals = diffAudits.reduce((acc, [, a]) => {
      acc.files += a?.totalChangedFiles || 0;
      acc.added += a?.totalAddedLines || 0;
      acc.removed += a?.totalRemovedLines || 0;
      acc.undeclared += a?.undeclaredFiles?.length ?? a?.undeclaredCount ?? 0;
      acc.warnings += a?.tamperScan?.warnings?.length ?? a?.tamperWarnings ?? 0;
      return acc;
    }, { files: 0, added: 0, removed: 0, undeclared: 0, warnings: 0 });
    const checkpoints = task.stageCheckpoints && typeof task.stageCheckpoints === 'object' ? task.stageCheckpoints : null;
    const previewRollback = async (stageId) => {
      if (rollbackBusy || busy) return;
      setRollbackBusy(true);
      try {
        const res = await runControl('mentor_stage_rollback', { stageId, dryRun: true });
        if (res && res.ok !== false) setRollbackPreview(res.value || res);
      } finally {
        setRollbackBusy(false);
      }
    };
    const confirmRollback = async (stageId, force = false) => {
      if (rollbackBusy || busy) return;
      setRollbackBusy(true);
      try {
        const res = await runControl('mentor_stage_rollback', { stageId, dryRun: false, ...(force ? { force: true } : {}) });
        if (res && res.ok === true) setRollbackPreview(null);
      } finally {
        setRollbackBusy(false);
      }
    };
    const copyTakeover = async () => {
      if (!takeoverCmd) return;
      if (!navigator?.clipboard?.writeText) {
        setCopyState('failed');
        setTimeout(() => setCopyState('idle'), 2500);
        return;
      }
      try {
        await navigator.clipboard.writeText(takeoverCmd);
        setCopyState('copied');
      } catch {
        setCopyState('failed');
      }
      setTimeout(() => setCopyState('idle'), 2500);
    };
    const handleLesson = async (action, fingerprint) => {
      if (!fingerprint || lessonPending || busy) return;
      setLessonPending(fingerprint);
      try { await runControl(action, { fingerprint }); }
      finally { setLessonPending(null); }
    };
    const copyReceipt = async () => {
      if (busy) return;
      const res = await runControl('mentor_receipt_build');
      const md = res?.value?.markdown || '';
      if (!md) { setExportNotice(res?.error?.message || '生成收据失败'); return; }
      setReceiptPreview(md);
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(md);
          setExportNotice('已复制 PR 验证收据');
          return;
        }
      } catch {}
      setExportNotice('已生成 PR 验证收据（可在下方复制）');
    };
    const exportPassport = async () => {
      if (busy) return;
      const res = await runControl('mentor_passport_export');
      if (res?.ok && res.value) {
        setExportNotice('已导出任务护照 ' + String(res.value.integrityDigest || '').slice(0, 12));
      } else {
        setExportNotice(res?.error?.message || '导出任务护照失败');
      }
    };
    const exportTrace = async () => {
      if (busy) return;
      const res = await runControl('mentor_trace_export');
      if (res?.ok && res.value) {
        setExportNotice('已导出 ' + (res.value.schemaVersion || 'ATIF') + ' 轨迹');
      } else {
        setExportNotice(res?.error?.message || '导出轨迹失败');
      }
    };
    const stuckAlert = task.continuation?.kind === 'stuck-detected' ? task.continuation : null;
    const ambiguityReport = task.ambiguityReport?.hasAmbiguity && task.ambiguityReport?.questions?.length ? task.ambiguityReport : null;
    const mcpAlerts = Array.isArray(task.mcpSchemaAlerts) && task.mcpSchemaAlerts.length ? task.mcpSchemaAlerts : null;
    const claims = progress?.claims?.length
      ? progress.claims
      : (task.criteria || []).map(c => {
          const st = stages.find(s => (s.criterionIds || []).includes(c.id));
          return { stageId: st ? st.id : '__completion__', id: c.id, title: c.text || c.id, proofs: [], expected: null };
        });
    const provenCount = claims.filter(c => c.proofs && c.proofs.length > 0).length;
    const stageIconChar = tone => tone === 'ok' ? '✓' : tone === 'warn' ? '!' : tone === 'live' ? '●' : '○';
    const stageSub = (stage, run, status, tone) => {
      const pre = run?.lastPrecheck || task.lastPrechecks?.[stage.id];
      if (pre && pre.ok === false) return '前置硬检查未通过（' + pre.failed + '/' + pre.total + ' 失败）';
      const step = stepById.get(stage.id);
      if (step?.recheck) return step.recheck.reason + ' · 复核 ' + (step.recheck.criterionIds || []).join('、');
      if (tone === 'ok') return '';
      if (step?.detail) return step.detail;
      if (status !== 'pending') return labelStatus(status);
      return stage.dependsOn?.length ? '等待 ' + stage.dependsOn.join('、') : '';
    };
    const breaker = task.continuation?.kind === 'rework-circuit-breaker' ? task.continuation : null;
    const hasAlerts = Boolean(breaker || progress?.decisions?.length || stuckAlert || ambiguityReport || mcpAlerts || task.lastPersistError);

    return h('div', null,
      hasAlerts
        ? h('div', {className:'mt-alerts'},
            breaker
              ? h('div', {className:'mt-callout mt-callout-err', role:'alert'},
                  h('div', {className:'mt-callout-row'},
                    h('span', {className:'mt-callout-text'}, breaker.summary || ('阶段 ' + (breaker.stageId || '') + ' 连续返工已触发熔断暂停')),
                    h('span', {className:'mt-callout-actions'},
                      checkpoints && (checkpoints[breaker.stageId] || checkpoints.__task__)
                        ? h('button', {type:'button', className:'mt-btn-link', disabled:busy||rollbackBusy, onClick:()=>previewRollback(checkpoints[breaker.stageId] ? breaker.stageId : '__task__')}, rollbackBusy?'预览中…':(checkpoints[breaker.stageId] ? '从上一快照重来' : '回滚到任务基线'))
                        : null,
                      onSwitchTab ? h('button', {type:'button', className:'mt-btn-link', disabled:busy, onClick:()=>onSwitchTab('issues')}, '查看问题') : null,
                      h('button', {type:'button', className:'mt-btn-link', disabled:busy, onClick:()=>runControl('mentor_task_resume')}, '恢复继续'))),
                  (breaker.recentFindings || []).slice(0, 3).map((f, i) =>
                    h('p', {key:f.id || i, className:'mt-record-sub', style:{margin:0}}, '· ' + textValue(f))))
              : null,
            progress?.decisions?.length
              ? h('div', {className:'mt-callout'},
                  progress.decisions.map(d => h('div', {className:'mt-callout-row', key:d.label},
                    h('span', {className:'mt-callout-text'}, d.effect),
                    h('button', {type:'button', className:'mt-btn-link', disabled:busy, onClick:()=>runControl(d.action, d.params)}, d.label))))
              : null,
            stuckAlert
              ? h('div', {className:'mt-callout mt-callout-err', role:'alert', 'data-stuck-alert':'1'},
                  h('div', {className:'mt-callout-row'},
                    h('span', {className:'mt-callout-text'}, '循环卡死拦截（' + (stuckAlert.pattern || 'STUCK') + '）：' + textValue(stuckAlert.reason || '检测到无进展循环')),
                    h('button', {type:'button', className:'mt-btn-link', disabled:busy, onClick:()=>runControl('mentor_task_continue')}, '介入后继续')))
              : null,
            ambiguityReport
              ? h('div', {className:'mt-callout', role:'region', 'data-clarify-banner':'1'},
                  h('div', {className:'mt-callout-row'},
                    h('span', {className:'mt-callout-text'}, '待澄清边界（' + ambiguityReport.questions.length + ' 项）：' + textValue(ambiguityReport.summary || ''))),
                  ambiguityReport.questions.slice(0, 3).map(q =>
                    h('div', {key:q.id, style:{marginTop:'4px'}},
                      h('div', {className:'mt-record-sub'}, (q.severity === 'blocking' ? '[阻断] ' : '') + q.question),
                      h('div', {style:{display:'flex',flexWrap:'wrap',gap:'6px',marginTop:'4px'}},
                        (q.options || []).slice(0, 3).map((opt, idx) =>
                          h('button', {key:idx, type:'button', className:'mt-btn-link', disabled:busy, onClick:()=>runControl('mentor_clarify_answer', {questionId:q.id, answer:opt})}, opt))))))
              : null,
            mcpAlerts
              ? h('div', {className:'mt-callout mt-callout-err', role:'alert', 'data-mcp-alert':'1'},
                  h('span', {className:'mt-callout-text'}, '⚠ 外部 MCP 工具安全告警（' + mcpAlerts.length + ' 项）：' + mcpAlerts.slice(0, 2).map(a => a.summary || a.toolName).join('；')))
              : null,
            task.lastPersistError
              ? h('div', {className:'mt-callout mt-callout-err'},
                  h('span', {className:'mt-callout-text'}, '任务保存失败：' + textValue(task.lastPersistError)))
              : null)
        : null,
      rollbackPreview
        ? h('div', {className:'mt-callout', style:{marginBottom:'10px'}, 'data-rollback-preview':'1'},
            h('div', {className:'mt-callout-row'},
              h('span', {className:'mt-callout-text'}, '回滚预览（' + (rollbackPreview.stageId || '') + '）：将恢复 ' + (rollbackPreview.toRestore?.length || 0) + ' 个文件、删除 ' + (rollbackPreview.toDelete?.length || 0) + ' 个新建文件' + (rollbackPreview.externalConflicts?.length ? '（⚠ 有外部改动冲突）' : '')),
              h('span', {className:'mt-callout-actions'},
                h('button', {type:'button', className:'mt-btn-link', disabled:busy||rollbackBusy, onClick:()=>confirmRollback(rollbackPreview.stageId, Boolean(rollbackPreview.externalConflicts?.length))}, rollbackPreview.externalConflicts?.length ? '强制覆盖回滚' : '确认回滚'),
                h('button', {type:'button', className:'mt-btn-text', onClick:()=>setRollbackPreview(null)}, '取消'))))
        : null,
      stages.length
        ? h(React.Fragment, null,
            h('div', {className:'mt-sec-head'},
              h('span', {className:'mt-sec-title'},
                stageView === 'mindmap' ? '任务导图' : '执行阶段',
                h('span', {className:'mt-pill mt-num'}, accepted + '/' + stages.length + (running > 0 && p?.limit ? ' · 并行 ' + running + '/' + p.limit : '')),
                rigorLabel
                  ? h('span', {className:'mt-pill', 'data-rigor':rigorInfo.tier, title:(rigorInfo.reasons || []).join('；')}, '严格度：' + rigorLabel)
                  : null),
              h('div', {className:'mt-seg-mini', role:'group', 'aria-label':'阶段展示方式'},
                h('button', {type:'button', className:stageView==='mindmap'?'selected':'', 'aria-pressed':stageView==='mindmap', onClick:()=>setStageView('mindmap')}, '导图'),
                h('button', {type:'button', className:stageView==='list'?'selected':'', 'aria-pressed':stageView==='list', onClick:()=>setStageView('list')}, '列表'))),
            stageView === 'mindmap'
              ? h(MindMapView, {task, claims, checkpoints, busy, rollbackBusy, onPreviewRollback:previewRollback})
              : h('ul', {className:'mt-stage-list'}, stages.map(stage => {
                  const run = runs.find(r => r.stageId === stage.id);
                  const status = run?.status || 'pending';
                  const tone = dagNodeTone(status);
                  const sub = stageSub(stage, run, status, tone);
                  return h('li', {className:'mt-stage-row', key:stage.id, 'data-tone':tone, 'data-status':status},
                    h('span', {className:'mt-stage-icon', 'data-tone':tone, 'aria-hidden':true, title:labelStatus(status)}, stageIconChar(tone)),
                    h('div', {className:'mt-stage-main'},
                      h('div', {className:'mt-stage-head'},
                        h('span', {className:'mt-stage-title'}, stage.title || stage.id),
                        h('span', {className:'mt-tag'}, stage.id),
                        run?.attempt > 1 ? h('span', {className:'mt-stage-attempt'}, '第' + run.attempt + '轮') : null,
                        h('span', {className:'mt-sr-only'}, labelStatus(status))),
                      sub ? h('div', {className:'mt-stage-sub'}, sub) : null));
                })))
        : empty('正在整理计划与依赖，就绪后将显示执行阶段。'),
      claims.length
        ? h('details', {className:'mt-fold'},
            h('summary', null,
              '验收标准 · ' + claims.length,
              provenCount > 0 ? h('span', {className:'mt-sec-meta mt-num'}, '已绑定 ' + provenCount + '/' + claims.length) : null),
            h('div', {className:'mt-fold-body'},
              h('div', {className:'mt-crit-list'}, claims.map(c =>
                h('div', {className:'mt-crit-item', key:c.stageId + '/' + c.id},
                  h('div', {className:'mt-crit-head'},
                    h('span', {className:'mt-crit-mark', 'data-done':c.proofs?.length?'1':'0', 'aria-hidden':true}, c.proofs?.length ? '✓' : '○'),
                    h('span', {className:'mt-crit-text'}, c.title),
                    h('span', {className:'mt-tag'}, c.stageId === '__completion__' ? '整体验收' : c.stageId)),
                  c.proofs?.length ? h('div', {className:'mt-crit-proofs'}, c.proofs.map((b, i) => renderProofItem(b, i))) : null)))))
        : null,
      diffAudits.length > 0
        ? h('details', {className:'mt-fold', 'data-diff-receipt':'1'},
            h('summary', null,
              '变更收据 · ' + diffTotals.files + ' 文件 (+' + diffTotals.added + '/-' + diffTotals.removed + ')',
              h('span', {className:'mt-sec-meta mt-num'},
                (diffTotals.undeclared > 0 ? '未声明 ' + diffTotals.undeclared : '0 未声明') +
                (diffTotals.warnings > 0 ? ' · 测试提示 ' + diffTotals.warnings : ''))),
            h('div', {className:'mt-fold-body'},
              diffAudits.map(([sid, audit]) => h('div', {key:sid, style:{marginBottom:'6px'}},
                h('div', {className:'mt-record-sub'}, sid + '（' + (audit?.mode || 'diff') + '）：' + (audit?.changedFiles || []).map(f => f.path + ' (+' + (f.addedLines || 0) + '/-' + (f.removedLines || 0) + ')').join('、')),
                audit?.undeclaredFiles?.length
                  ? h('div', {className:'mt-record-sub'}, '未声明改动：' + audit.undeclaredFiles.join('、'))
                  : null,
                (audit?.tamperScan?.warnings || []).slice(0, 4).map((w, idx) =>
                  h('div', {key:idx, className:'mt-record-sub'}, '· [' + w.rule + '] ' + w.file + (w.line ? ':' + w.line : '') + ' ' + w.summary))))))
        : null,
      h(TeamSection, {task}),
      lessonTotal > 0
        ? h('details', {className:'mt-fold', 'data-lessons-fold':'1'},
            h('summary', null,
              '经验沉淀 · ' + lessonTotal,
              candidateLessons.length > 0
                ? h('span', {className:'mt-sec-meta mt-num'}, '待确认 ' + candidateLessons.length)
                : h('span', {className:'mt-sec-meta mt-num'}, '已采纳 ' + acceptedLessons.length)),
            h('div', {className:'mt-fold-body'},
              candidateLessons.map(item => {
                const labelText = item.lesson || item.rule || '';
                return h('div', {className:'mt-lesson-row', key:item.fingerprint, 'data-lesson-status':'candidate'},
                  h('span', null, labelText),
                  h('span', {className:'mt-lesson-ops'},
                    h('button', {type:'button', className:'mt-btn-link', 'aria-label':'采纳经验：' + labelText, disabled:busy||Boolean(lessonPending), onClick:()=>handleLesson('mentor_lesson_accept', item.fingerprint)}, lessonPending===item.fingerprint?'处理中…':'采纳'),
                    h('button', {type:'button', className:'mt-btn-text', 'aria-label':'忽略经验：' + labelText, disabled:busy||Boolean(lessonPending), onClick:()=>handleLesson('mentor_lesson_dismiss', item.fingerprint)}, '忽略')));
              }),
              acceptedLessons.map(item => h('div', {className:'mt-lesson-row', key:item.fingerprint, 'data-lesson-status':'accepted'},
                h('span', null, '✓ ' + (item.lesson || item.rule)),
                h('span', {className:'mt-lesson-ops'},
                  item.helpful > 0 ? h('span', {className:'mt-tag'}, '已帮省 ' + item.helpful + ' 次') : null,
                  item.fileMatch?.length ? h('span', {className:'mt-tag', title:item.fileMatch.join(', ')}, item.fileMatch[0]) : null,
                  item.occurrences > 1 ? h('span', {className:'mt-tag'}, '×' + item.occurrences) : null)))))
        : null,
      showHandoff || diffAudits.length > 0 || task.phase === 'completed'
        ? h('details', {className:'mt-fold', 'data-handoff-fold':'1'},
            h('summary', null, '交付收据 · 护照与轨迹'),
            h('div', {className:'mt-fold-body'},
              h('div', {className:'mt-fold-actions'},
                h('button', {type:'button', className:'mt-chip-btn', 'data-receipt-btn':'1', disabled:busy, onClick:copyReceipt}, '复制 PR 收据'),
                h('button', {type:'button', className:'mt-chip-btn', 'data-passport-btn':'1', disabled:busy, onClick:exportPassport}, '导出任务护照'),
                h('button', {type:'button', className:'mt-chip-btn', 'data-trace-btn':'1', disabled:busy, onClick:exportTrace}, '导出 ATIF 轨迹')),
              exportNotice ? h('p', {className:'mt-record-sub', role:'status', 'data-export-notice':'1', style:{margin:'0 0 6px'}}, exportNotice) : null,
              receiptPreview ? h('pre', {className:'mt-record-sub', 'data-receipt-preview':'1', style:{margin:'0 0 6px',whiteSpace:'pre-wrap',maxHeight:'180px',overflow:'auto'}}, receiptPreview) : null,
              showHandoff ? h(React.Fragment, null,
                h('p', {className:'mt-record-sub', style:{margin:'0 0 6px'}}, '长对话上下文快满时，在新会话中发送以下命令即可无损接管当前任务：'),
                h('div', {className:'mt-handoff-cmd'},
                  h('code', null, takeoverCmd),
                  h('button', {type:'button', className:'mt-btn-link', onClick:copyTakeover}, copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请手动选中' : '复制接班命令'))) : null))
        : null,
      progress?.history
        ? h('details', {className:'mt-fold'},
            h('summary', null, '同类任务参考 · ' + progress.history.workClass),
            h('div', {className:'mt-fold-body'},
              Object.entries(progress.history.groups).map(([mode, g]) => h('p', {key:mode, className:'mt-work-muted'},
                (mode === 'parallel' ? '并行' : '串行') + ' · ' + g.samples + ' 次' +
                (g.samples ? ' · 中位耗时 ' + Math.round(g.elapsedMs / 1000) + 's · 返工 ' + g.reworks : '')))))
        : null);
  }
  // Measure the card belonging to this slot. Render outside the host's clipped dock.
  function useComposerPosition(anchor) {
    const [position, setPosition] = React.useState(null);
    const [compact, setCompact] = React.useState(false);
    React.useLayoutEffect(() => {
      const seat = anchor.current?.closest('[data-composer-seat]');
      if (!seat) return;
      let frame = 0;
      const update = () => {
        frame = 0;
        const card = seat.querySelector('[data-composer-card]');
        const r = card?.getBoundingClientRect();
        const viewport = window.visualViewport;
        const vx = viewport?.offsetLeft || 0, vy = viewport?.offsetTop || 0;
        const vw = viewport?.width || window.innerWidth, vh = viewport?.height || window.innerHeight;
        if (!r || r.width <= 0 || r.height <= 0 || r.right <= vx || r.left >= vx + vw || r.top >= vy + vh || r.bottom <= vy) {
          setPosition(null);
          return;
        }
        const width = Math.max(0, Math.min(r.width, vw - 24));
        const left = Math.max(vx + 12, Math.min(r.left + (r.width - width) / 2, vx + vw - width - 12));
        const topEdge = Math.max(vy + 12, seat.parentElement.getBoundingClientRect().top + 8);
        const bottomEdge = Math.min(vy + vh - 12, Math.max(topEdge + 96, r.top - 8));
        const available = Math.max(0, Math.floor(bottomEdge - topEdge));
        // Below the threshold the whole card becomes the single scroll container.
        setCompact(prev => nextCompact(prev, available));
        const next = {
          position: 'fixed', left: Math.round(left) + 'px', width: Math.floor(width) + 'px',
          bottom: Math.round(window.innerHeight - bottomEdge) + 'px',
          maxHeight: available + 'px',
        };
        setPosition(old => old && Object.keys(next).every(k => old[k] === next[k]) ? old : next);
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
      for (let element = seat; element; element = element.parentElement) resize?.observe(element);
      const mutation = new MutationObserver(schedule);
      mutation.observe(seat, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, true);
      window.visualViewport?.addEventListener('resize', schedule);
      window.visualViewport?.addEventListener('scroll', schedule);
      update();
      return () => {
        cancelAnimationFrame(frame); resize?.disconnect(); mutation.disconnect();
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, true);
        window.visualViewport?.removeEventListener('resize', schedule);
        window.visualViewport?.removeEventListener('scroll', schedule);
      };
    }, [anchor]);
    return { position, compact };
  }
  const PANEL_APPEARANCE_KEY = 'dsh-mentor:panel-appearance';
  // motion: light (default, single-layer fade, honours reduced motion) / paper (the explicit sheet effect) / off.
  const DEFAULT_PANEL_APPEARANCE = {transparency:6, blur:16, theme:'system', motion:'light'};
  function readPanelAppearance() {
    try {
      const saved=JSON.parse(localStorage.getItem(PANEL_APPEARANCE_KEY));
      return {
        transparency:Number.isFinite(saved?.transparency)?Math.max(0,Math.min(100,saved.transparency)):DEFAULT_PANEL_APPEARANCE.transparency,
        blur:Number.isFinite(saved?.blur)?Math.max(0,Math.min(40,saved.blur)):DEFAULT_PANEL_APPEARANCE.blur,
        theme:['system','light','dark'].includes(saved?.theme)?saved.theme:'system',
        // Legacy "on"/"system" used the 24-layer sheet by default; they migrate to the light default.
        motion:['paper','off','light'].includes(saved?.motion)?saved.motion:'light',
      };
    } catch { return {...DEFAULT_PANEL_APPEARANCE}; }
  }
  function PanelAppearanceSettings({value,onChange,onClose}) {
    const change=patch=>onChange({...value,...patch});
    const pills=(options, current, field, label)=>h('div',{className:'mt-work-appearance-pills',role:'group','aria-label':label},
      options.map(([v,text])=>h('button',{key:v,type:'button',className:current===v?'selected':'','aria-pressed':current===v,onClick:()=>change({[field]:v})},text)));
    return h('div',{className:'mt-work-appearance',role:'group','aria-label':'任务面板外观'},
      h('div',{className:'mt-work-appearance-title'},
        h('span',null,'面板外观'),
        h('button',{type:'button',className:'mt-work-link',onClick:onClose,'aria-label':'收起外观设置'},'完成')),
      h('div',{className:'mt-work-appearance-grid'},
        h('label',null,
          h('span',{className:'mt-work-appearance-head'},h('span',null,'透明度'),h('output',null,value.transparency+'%')),
          h('input',{type:'range',min:0,max:100,step:1,value:value.transparency,'aria-label':'背景透明度','aria-valuetext':value.transparency+'%，0% 为不透明',onChange:e=>change({transparency:Number(e.target.value)})})),
        h('label',null,
          h('span',{className:'mt-work-appearance-head'},h('span',null,'毛玻璃模糊'),h('output',null,value.blur+' px')),
          h('input',{type:'range',min:0,max:40,step:1,value:value.blur,'aria-label':'背景模糊','aria-valuetext':value.blur+' 像素',onChange:e=>change({blur:Number(e.target.value)})})),
        h('label',null,h('span',null,'配色'),pills([['system','自动'],['light','浅色'],['dark','深色']], value.theme, 'theme', '面板配色')),
        h('label',null,h('span',null,'收放动效'),pills([['light','轻量'],['paper','纸张'],['off','关闭']], value.motion, 'motion', '收放动画'))),
      h('div',{className:'mt-work-appearance-actions'},
        h('button',{type:'button',onClick:()=>change({transparency:0,blur:0})},'纯色背景'),
        h('button',{type:'button',onClick:()=>onChange({...DEFAULT_PANEL_APPEARANCE})},'恢复默认')));
  }
  // Project one rectangular texture band onto its four corners, without rotating the whole card.
  function sheetBandMatrix(width,height,points) {
    const [p0,p1,p2,p3]=points;
    const dx1=p1.x-p2.x,dx2=p3.x-p2.x,dx3=p0.x-p1.x+p2.x-p3.x;
    const dy1=p1.y-p2.y,dy2=p3.y-p2.y,dy3=p0.y-p1.y+p2.y-p3.y;
    const determinant=dx1*dy2-dx2*dy1;
    const g=Math.abs(determinant)>1e-8?(dx3*dy2-dx2*dy3)/determinant:0;
    const k=Math.abs(determinant)>1e-8?(dx1*dy3-dx3*dy1)/determinant:0;
    return 'matrix3d('+[
      (p1.x-p0.x+g*p1.x)/width,(p1.y-p0.y+g*p1.y)/width,0,g/width,
      (p3.x-p0.x+k*p3.x)/height,(p3.y-p0.y+k*p3.y)/height,0,k/height,
      0,0,1,0,p0.x,p0.y,0,1,
    ].join(',')+')';
  }
  function makeSheetScene(panel,button,opening) {
    const started=performance.now(),bounds=panel.getBoundingClientRect(),dock=button.getBoundingClientRect();
    const layer=document.createElement('div');
    layer.className='mt-sheet-flight';layer.setAttribute('aria-hidden','true');layer.inert=true;
    Object.assign(layer.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:'41',contain:'layout style paint'});
    // A single live backdrop follows the whole sheet. Texture bands only carry content.
    const surface=getComputedStyle(panel),glass=document.createElement('div');
    glass.className='mt-sheet-glass';
    Object.assign(glass.style,{position:'absolute',inset:'0',backgroundColor:surface.backgroundColor,backdropFilter:surface.backdropFilter,webkitBackdropFilter:surface.backdropFilter,pointerEvents:'none'});
    const shadow=document.createElement('div');
    shadow.className='mt-sheet-shadow';
    Object.assign(shadow.style,{position:'absolute',left:bounds.left+'px',top:bounds.top+'px',width:bounds.width+'px',height:bounds.height+'px',borderRadius:surface.borderRadius,boxShadow:surface.boxShadow,pointerEvents:'none',opacity:'0'});
    layer.appendChild(shadow);layer.appendChild(glass);
    const material={color:surface.backgroundColor,radius:parseFloat(surface.borderTopLeftRadius)||0};
    const bands=[],count=24,bandHeight=bounds.height/count;
    const sourceNodes=[panel,...panel.querySelectorAll('*')];
    const scrolls=sourceNodes.map((el,index)=>({index,top:el.scrollTop,left:el.scrollLeft})).filter(v=>v.top||v.left);
    for(let i=0;i<count;i++){
      const strip=document.createElement('div'),clone=panel.cloneNode(true);
      const top=i*bandHeight,height=Math.min(bounds.height-top,bandHeight+.35);
      Object.assign(strip.style,{position:'absolute',left:'0',top:'0',width:bounds.width+'px',height:height+'px',overflow:'hidden',transformOrigin:'0 0',willChange:'transform'});
      clone.dataset.motion='snapshot';clone.classList.add('mt-sheet-snapshot');
      clone.removeAttribute('id');clone.removeAttribute('aria-label');clone.setAttribute('aria-hidden','true');clone.inert=true;
      clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
      Object.assign(clone.style,{position:'absolute',left:'0',top:-top+'px',bottom:'auto',width:bounds.width+'px',height:bounds.height+'px',maxHeight:'none',maxWidth:'none',margin:'0',visibility:'visible',transform:'none',pointerEvents:'none',boxShadow:'none',background:'transparent',backdropFilter:'none',webkitBackdropFilter:'none'});
      strip.appendChild(clone);layer.appendChild(strip);
      bands.push({element:strip,clone,top,height});
    }
    document.body.appendChild(layer);
    for(const band of bands){
      const nodes=[band.clone,...band.clone.querySelectorAll('*')];
      for(const scroll of scrolls){nodes[scroll.index].scrollTop=scroll.top;nodes[scroll.index].scrollLeft=scroll.left;}
    }
    return {panel,layer,glass,shadow,material,bands,bounds,dock,width:bounds.width,height:bounds.height,progress:opening?0:1,velocity:0,target:opening?1:0,started,last:performance.now(),frames:0,maxGap:0,slowFrames:0,buildMs:performance.now()-started,reversals:0};
  }
  function drawSheet(scene) {
    const progress=Math.max(0,Math.min(1,scene.progress)),collapse=1-progress,r=scene.bounds,b=scene.dock;
    const ease=value=>{const t=Math.max(0,Math.min(1,value));return t*t*t*(t*(t*6-15)+10);};
    const mix=(a,b,t)=>a+(b-a)*t;
    // First form the neck at the button. Only then lift the trailing edge into it.
    // Keeping these phases separate avoids the old uniformly compressed trapezoid.
    const pinch=ease(collapse/.48),gather=ease((collapse-.22)/.78);
    const leading=ease(collapse/.66),trailing=ease((collapse-.30)/.70);
    const topY=mix(r.top,b.top,leading),bottomY=mix(r.bottom,b.bottom,trailing);
    const edge=(fraction,right)=>{
      const influence=mix(pinch,gather,ease(fraction));
      return {x:mix(right?r.right:r.left,right?b.right:b.left,influence),y:mix(topY,bottomY,fraction)};
    };
    const destination=scene.target?r:b;
    scene.endpointError=Math.max(Math.abs(topY-destination.top),Math.abs(bottomY-destination.bottom),
      Math.abs(edge(0,false).x-destination.left),Math.abs(edge(1,false).x-destination.left),
      Math.abs(edge(0,true).x-destination.right),Math.abs(edge(1,true).x-destination.right));
    // Match the resting shadow before handing the sheet back to the real panel.
    scene.shadowOpacity=ease((progress-.94)/.04);
    Object.assign(scene.shadow.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',opacity:String(scene.shadowOpacity)});
    for(const band of scene.bands){
      const top=band.top/scene.height,bottom=(band.top+band.height)/scene.height;
      band.element.style.transform=sheetBandMatrix(scene.width,band.height,[edge(top,false),edge(top,true),edge(bottom,true),edge(bottom,false)]);
    }
    // Clip the live backdrop to the same curved outline, including rounded corners.
    const radius=Math.min(scene.material.radius,scene.width/2,scene.height/2);
    const fractions=new Set(Array.from({length:49},(_,i)=>i/48));
    for(let i=0;i<=8;i++){fractions.add(radius*i/8/scene.height);fractions.add(1-radius*i/8/scene.height);}
    const rows=[...fractions].sort((a,b)=>a-b);
    const outline=(fraction,right)=>{
      const left=edge(fraction,false),end=edge(fraction,true),y=fraction*scene.height;
      const distance=Math.min(y,scene.height-y);
      const inset=distance<radius?radius-Math.sqrt(Math.max(0,radius*radius-(radius-distance)**2)):0;
      return {x:(right?end.x:left.x)+(right?-1:1)*inset/scene.width*(end.x-left.x),y:left.y};
    };
    const points=[...rows.map(y=>outline(y,false)),...rows.slice().reverse().map(y=>outline(y,true))];
    scene.glass.style.clipPath='polygon('+points.map(p=>p.x+'px '+p.y+'px').join(',')+')';
    const fade=Math.max(0,Math.min(1,(progress-.012)*24));
    scene.fade=fade;
    // Parent opacity would isolate the backdrop from the page, so fade only paint/content.
    scene.glass.style.backgroundColor=fade===1?scene.material.color:'color-mix(in srgb, '+scene.material.color+' '+fade*100+'%, transparent)';
    scene.glass.style.visibility=fade>0?'visible':'hidden';
    for(const band of scene.bands)band.element.style.opacity=String(fade);
    scene.panel.style.visibility='hidden';
    scene.panel.style.opacity='';
  }
  // light: one CSS layer (opacity + 4px lift, 160/100ms), skipped under reduced motion.
  // paper: the 24-band sheet, only when the user explicitly picks it. off: no motion.
  function usePaperMotion(panelRef,open,position,policy) {
    const motion=React.useRef({open:null,scene:null,frame:0,timer:0});
    React.useLayoutEffect(()=>{
      const panel=panelRef.current,state=motion.current;
      if(!panel||!position){
        cancelAnimationFrame(state.frame);clearTimeout(state.timer);state.scene?.layer.remove();state.scene=null;state.open=null;return;
      }
      const previous=state.open;state.open=open;
      let button=barOpenState.trigger;
      if(!button?.isConnected||!button.getClientRects().length)button=[...document.querySelectorAll('[data-mentor-toggle]')].find(el=>el.getClientRects().length);
      if(!open&&panel.contains(document.activeElement))button?.focus({preventScroll:true});
      const settle=()=>{
        const scene=state.scene;
        cancelAnimationFrame(state.frame);state.frame=0;clearTimeout(state.timer);state.timer=0;
        if(scene){scene.progress=state.open?1:0;scene.velocity=0;drawSheet(scene);}
        panel.style.opacity='';
        panel.style.visibility=state.open?'visible':'hidden';panel.style.pointerEvents=state.open?'auto':'none';
        panel.dataset.motion=state.open?'open':'closed';
        scene?.layer.remove();state.scene=null;
        if(scene)globalThis.__mtDiag={...(globalThis.__mtDiag||{}),motion:{renderer:'genie-live-glass-crisp',result:panel.dataset.motion,frames:scene.frames,elapsedMs:Math.round(performance.now()-scene.started),buildMs:Math.round(scene.buildMs),maxFrameGapMs:Math.round(scene.maxGap),slowFrames:scene.slowFrames,reversals:scene.reversals}};
      };
      const systemReduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      globalThis.__mtDiag={...(globalThis.__mtDiag||{}),motionPolicy:policy,systemReducedMotion:systemReduced};
      if(policy!=='paper'){
        if(state.scene){state.scene.layer.remove();state.scene=null;cancelAnimationFrame(state.frame);}
        if(policy==='off'||systemReduced||previous===null||previous===open){settle();return;}
        clearTimeout(state.timer);
        panel.style.visibility='visible';panel.style.pointerEvents=open?'auto':'none';
        panel.dataset.motion=open?'opening':'closing';
        state.timer=setTimeout(settle,open?160:100);
        return;
      }
      if(!button){settle();return;}
      if(state.scene){
        if(previous!==open)state.scene.reversals++;
        state.scene.target=open?1:0;
        state.scene.bounds=panel.getBoundingClientRect();state.scene.dock=button.getBoundingClientRect();
        panel.dataset.motion=open?'opening':'closing';return;
      }
      if(previous===null||previous===open){settle();return;}
      const scene=makeSheetScene(panel,button,open);state.scene=scene;
      panel.style.visibility='hidden';panel.style.pointerEvents='none';panel.dataset.motion=open?'opening':'closing';
      drawSheet(scene);
      const tick=now=>{
        if(state.scene!==scene)return;
        const gap=now-scene.last,dt=Math.max(0,gap/1000);scene.last=now;scene.frames++;
        scene.maxGap=Math.max(scene.maxGap,gap);if(gap>34)scene.slowFrames++;
        const omega=scene.target?12.5:14,delta=scene.progress-scene.target,c=scene.velocity+omega*delta,decay=Math.exp(-omega*dt);
        scene.progress=scene.target+(delta+c*dt)*decay;
        scene.velocity=(scene.velocity-omega*c*dt)*decay;
        drawSheet(scene);
        const arrived=scene.endpointError<.25&&(scene.target?scene.shadowOpacity===1:scene.fade===0);
        if(arrived){settle();return;}
        state.frame=requestAnimationFrame(tick);
      };
      state.frame=requestAnimationFrame(tick);
    },[open,position,panelRef,policy]);
    React.useEffect(()=>()=>{const state=motion.current;cancelAnimationFrame(state.frame);clearTimeout(state.timer);state.scene?.layer.remove();state.scene=null;},[]);
  }
  function ComposerSurface({children, appearance, open, ...props}) {
    const anchor = React.useRef(null);
    const panel = React.useRef(null);
    const { position, compact } = useComposerPosition(anchor);
    usePaperMotion(panel,open,position,appearance.motion);
    return h(React.Fragment, null,
      h('span', {ref:anchor, hidden:true, 'data-mentor-anchor':''}),
      position ? portalTo(h('section', {...props, ref:panel, inert:open?undefined:'', 'aria-hidden':!open, 'data-appearance-theme':appearance.theme,
        ...(compact ? {'data-compact':'1'} : {}),
        style:{...position,visibility:'hidden',transformOrigin:'50% 50%','--mt-panel-alpha':String((100-appearance.transparency)/100),'--mt-panel-blur':appearance.blur+'px'}}, children), document.body) : null);
  }
  function TaskPicker({live, minCount = 2}) {
    if (!live.tasks || live.tasks.length < minCount) return null;
    return h('select', {className:'mt-work-picker', 'aria-label':'选择导师任务', value:liveState.taskId || '', disabled:live.busy, onChange:e=>selectTask(e.target.value)},
      h('option', {value:''}, '当前任务'),
      live.tasks.map(t=>h('option', {key:t.taskId, value:t.taskId}, (t.objective||'未命名任务').slice(0,28)+' · '+labelStatus(t.phase))));
  }
  const PRIMARY_ACTIONS=new Set(['mentor_task_approve','mentor_task_resume','mentor_task_continue','mentor_review_retry','mentor_task_on']);
  const scrollMemory=new Map();
  function ComposerBar() {
    const live=useLiveState(), task=live.task;
    const [open,setOpen]=React.useState(barOpenState.open);
    const [expanded,setExpanded]=React.useState(()=>{try{return localStorage.getItem('dsh-mentor:collapsed')==='open';}catch{return false;}});
    const [tab,setTab]=React.useState('overview');
    const [appearance,setAppearance]=React.useState(readPanelAppearance);
    const [showAppearance,setShowAppearance]=React.useState(false);
    const [closingId,setClosingId]=React.useState(null);
    const [showClosed,setShowClosed]=React.useState(false);
    const drafts=React.useRef(new Map());
    const [,forceExpire]=React.useState(0);
    const updateAppearance=value=>{
      setAppearance(value);
      try{localStorage.setItem(PANEL_APPEARANCE_KEY,JSON.stringify(value));}catch{}
    };
    const appearanceButton=h('button',{type:'button',id:'mt-appearance-btn',className:'mt-work-appearance-button','aria-label':'任务面板外观设置','aria-expanded':showAppearance,title:'调整面板透明度与主题',onClick:()=>setShowAppearance(v=>!v)},slidersIcon(),'外观');
    const appearanceSettings=showAppearance?h(PanelAppearanceSettings,{value:appearance,onChange:updateAppearance,onClose:()=>{setShowAppearance(false);focusLater('mt-appearance-btn');}}):null;
    React.useEffect(()=>barOpenState.subscribe(setOpen),[]);
    const hasTask=!!task, taskKey=task?.taskId||task?.id||null;
    React.useEffect(()=>{setClosingId(null);setShowClosed(false);},[taskKey]);
    React.useEffect(()=>{
      if(!live.controlError||!live.controlErrorAt)return undefined;
      const left=CONTROL_ERROR_TTL_MS-(Date.now()-live.controlErrorAt);
      if(left<=0)return undefined;
      const timer=setTimeout(()=>forceExpire(v=>v+1),left+20);
      return ()=>clearTimeout(timer);
    },[live.controlError,live.controlErrorAt]);
    const undoArchive = (() => {
      const now = Date.now();
      if (live.undoArchive && live.undoArchive.until > now) return live.undoArchive;
      if (task?.phase === 'archived' && task?.archivedUndoUntil > now) {
        return { taskId: task.taskId || task.id, revision: task.revision, objective: task.objective || '导师任务', until: task.archivedUndoUntil };
      }
      return null;
    })();
    React.useEffect(()=>{
      if(!undoArchive?.until)return undefined;
      const left=undoArchive.until-Date.now();
      if(left<=0)return undefined;
      const timer=setTimeout(()=>{
        if(liveState.value.undoArchive && liveState.value.undoArchive.until<=Date.now()) publishLive({undoArchive:null});
        forceExpire(v=>v+1);
      },left+30);
      return ()=>clearTimeout(timer);
    },[undoArchive?.taskId,undoArchive?.until]);
    const undoBanner = undoArchive
      ? h('div',{className:'mt-callout',role:'status','data-undo-archive':'1'},
          h('div',{className:'mt-callout-row'},
            h('span',{className:'mt-callout-text'},'已归档「'+(undoArchive.objective||undoArchive.taskId)+'」'),
            h('button',{type:'button',className:'mt-btn-link',disabled:live.busy,onClick:async()=>{const r=await runControl('mentor_task_restore',{taskId:undoArchive.taskId,revision:undoArchive.revision,enforceUndoWindow:true});if(r?.ok)focusLater('mt-work-expand');}},'撤销归档')))
      : null;
    React.useEffect(()=>{try{
      document.documentElement.setAttribute('data-mt-bar',open?'rendered':'hidden');
      globalThis.__mtDiag={...(globalThis.__mtDiag||{}),bar:open?'rendered':'hidden',taskId:task?.taskId||null,phase:task?.phase||null,revision:task?.revision??null,uiBuild:'20261125-v9-pro'};
    }catch{}},[hasTask,open,live.loaded,task?.taskId,task?.revision,task?.phase]);
    const collapse=()=>{setExpanded(false);setShowAppearance(false);try{localStorage.setItem('dsh-mentor:collapsed','closed');}catch{}};
    const onPanelKey=event=>{
      if(event?.key!=='Escape')return;
      const layer=escapeLayer({showAppearance,closingId,expanded});
      if(!layer)return;
      event.preventDefault?.();event.stopPropagation?.();
      if(layer==='appearance'){setShowAppearance(false);focusLater('mt-appearance-btn');}
      else if(layer==='editor'){const id=closingId;setClosingId(null);focusLater('mt-close-'+id);}
      else {collapse();focusLater('mt-work-expand');}
    };
    if(!hasTask)return h(ComposerSurface,{className:'mt-work mt-work-empty-card','aria-label':'导师任务',appearance,open,onKeyDown:onPanelKey},
      h('div',{className:'mt-work-top'},
        h('span',{className:'mt-work-logo','aria-hidden':true},'M'),
        h('strong',{className:'mt-work-title'},'导师任务'),
        h(TaskPicker,{live,minCount:1}),
        h('div',{className:'mt-work-empty-tools'},refreshButton(),appearanceButton)),
      appearanceSettings,
      undoBanner,
      empty(live.error ? '读取任务失败：'+live.error : live.loaded ? '暂无导师任务，在对话中说明目标即可开始。' : '正在读取任务…'));
    const toggle=()=>{const next=!expanded;if(!next){collapse();return;}setExpanded(true);try{localStorage.setItem('dsh-mentor:collapsed','open');}catch{}};
    const totalStages=(task.stages||[]).length;
    const accepted=(task.nodeRuns||[]).filter(r=>r.status==='accepted').length;
    const pct=totalStages>0?Math.round((accepted/totalStages)*100):task.phase==='completed'?100:0;
    const allowed=task.nextStep?.allowedActions||[];
    const canContinue=task.enabled!==false && ['active','planning','reviewing'].includes(task.phase) && !['REVIEW_FAILED','REVIEW_IN_PROGRESS','WORK_IN_PROGRESS'].includes(task.nextStep?.code);
    const controls=[['mentor_task_approve','批准计划'],['mentor_task_resume','恢复'],['mentor_review_retry','重试审查'],['mentor_task_continue','继续任务'],['mentor_task_on','启用导师'],['mentor_task_pause','暂停'],['mentor_task_off','关闭导师']].filter(([a])=>a==='mentor_task_continue'?canContinue:a==='mentor_task_on'?task.enabled===false&&!['completed','archived'].includes(task.phase):a==='mentor_task_off'?task.enabled!==false&&!['completed','archived'].includes(task.phase):allowed.includes(a));
    if (!task.team?.enabled && task.enabled !== false && ['active','reviewing'].includes(task.phase) && !task.pendingCheckpoint) {
      const offAt=controls.findIndex(([a])=>a==='mentor_task_off');
      controls.splice(offAt>=0?offAt:controls.length, 0, ['mentor_team_start','团队接力']);
    }
    // Exactly one visual primary action.
    const primaryAction=controls.find(([a])=>PRIMARY_ACTIONS.has(a))?.[0]||null;
    const reviewLive=Boolean(task.activeReview&&RUNNING_STATUSES.has(task.activeReview.status));
    const issueTotal=task.unresolved?.total||0;
    const agentCount=(task.participants||[]).length;
    const tabs=[
      {id:'overview', label:'概览'},
      {id:'reviews', label:'审查', dot:reviewLive, count:!reviewLive&&task.reviews?.length?task.reviews.length:0},
      {id:'issues', label:'问题', count:issueTotal, warn:issueTotal>0},
      {id:'agents', label:'智能体', count:agentCount},
    ];
    const tabIds=tabs.map(t=>t.id);
    const onTabKey=event=>{
      const target=tabKeyTarget(tabIds,tab,event?.key);
      if(!target)return;
      event.preventDefault?.();
      setTab(target);focusLater('mt-tab-'+target);
    };
    const statusError=live.error||activeControlError(live);
    const statusLine=statusError || task.progress?.headline || (task.continuation?.status==='needs-attention'?task.continuation.reason:task.nextStep?.text)||'等待任务更新';
    const bodyKey=(taskKey||'task')+':'+tab;
    return h(ComposerSurface,{className:'mt-work','aria-label':'导师任务','data-phase':task.phase,appearance,open,onKeyDown:onPanelKey},
      h('div',{className:'mt-work-top'},
        h('button',{type:'button',id:'mt-work-expand',className:'mt-work-expand',onClick:toggle,'aria-expanded':expanded,'aria-label':expanded?'收起任务详情':'展开任务详情'},
          h('span',{className:'mt-work-logo','aria-hidden':true},'M'),
          h('span',{className:'mt-work-title',title:task.objective},task.objective||'导师任务'),
          h('span',{className:'mt-work-prog'},
            totalStages>0?h('span',{className:'mt-work-meter','aria-hidden':true},h('i',{style:{width:pct+'%'}})):null,
            h('span',{className:'mt-work-count'},accepted+'/'+totalStages)),
          h('span',{className:'mt-work-chev','aria-hidden':true},expanded?'▾':'▸')),
        stateBadge(task.enabled===false?'stopped':task.phase, task.enabled!==false&&isTaskLive(task))),
      h('div',{className:'mt-work-next',role:'status'},
        h('span',{className:statusError?'mt-work-error':undefined,title:statusLine},statusLine),
        refreshButton()),
      undoBanner,
      expanded?h(React.Fragment,null,
        h('nav',{className:'mt-work-tabs','aria-label':'任务视图'},
          h('div',{className:'mt-work-tablist',role:'tablist','aria-label':'任务视图',onKeyDown:onTabKey},tabs.map(t=>h('button',{
            key:t.id,id:'mt-tab-'+t.id,type:'button',role:'tab',
            className:tab===t.id?'selected':'','aria-selected':tab===t.id,'aria-controls':'mt-tabpanel',
            tabIndex:tab===t.id?0:-1,onClick:()=>setTab(t.id)},
            t.label,
            t.dot?h('span',{className:'mt-tab-dot','aria-hidden':true}):null,
            t.count?h('span',{className:'mt-tab-n'+(t.warn?' mt-tab-n-warn':'')},t.count):null))),
          h(TaskPicker,{live,minCount:2})),
        h('div',{className:'mt-work-body',id:'mt-tabpanel',role:'tabpanel','aria-labelledby':'mt-tab-'+tab,tabIndex:0,key:bodyKey,
          ref:el=>{if(el&&!el.__mtRestored){el.__mtRestored=true;el.scrollTop=scrollMemory.get(bodyKey)||0;}},
          onScroll:event=>{const el=event?.currentTarget;if(el)scrollMemory.set(bodyKey,el.scrollTop);}},
          tab==='agents'?h(ParticipantCards,{task})
            :tab==='reviews'?h(ReviewContent,{task})
            :tab==='issues'?h(IssueContent,{task,busy:live.busy,closingId,setClosingId,draftsRef:drafts,showClosed,setShowClosed})
            :h(OverviewContent,{task,busy:live.busy,onSwitchTab:setTab})),
        appearanceSettings,
        h('footer',{className:'mt-work-footer'},
          live.staleNotice?h('div',{className:'mt-stale-notice',role:'status'},
            h('span',null,STALE_TEXT),
            h('button',{type:'button',className:'mt-btn-text',onClick:()=>publishLive({staleNotice:false})},'知道了')):null,
          h('div',{className:'mt-work-foot-row'},
            h('div',{className:'mt-work-foot-left'},
              appearanceButton,
              h('span',{className:'mt-work-muted mt-num'},live.busy?'处理中…':live.updatedAt?clockText(live.updatedAt):'')),
            h('div',{className:'mt-work-controls'},controls.map(([a,title])=>h('button',{
              key:a,
              type:'button',
              className:a===primaryAction?'mt-ctrl-primary':a==='mentor_task_off'?'mt-ctrl-subtle':undefined,
              disabled:live.busy,
              onClick:()=>runControl(a),
            },title)))))):null);
  }

  function MentorToggle() {
    // 2026-11-04 第四轮：这个按钮改成状态条的开关（原来打开一个全屏面板，
    // 面板已按用户要求删除，按钮差点变成摆设）。
    const [open, setLocalOpen] = React.useState(barOpenState.open);
    React.useEffect(() => barOpenState.subscribe(setLocalOpen), []);
    return React.createElement(
      "button",
      {
        type: "button",
        className: "mt-toggle" + (open ? " mt-toggle-on" : ""),
        "aria-label": open ? "隐藏导师状态条" : "显示导师状态条",
        "aria-pressed": open ? "true" : "false",
        title: open ? "点一下收起输入框上方的状态条" : "点一下显示输入框上方的状态条",
        'data-mentor-toggle': '',
        'aria-expanded': open,
        onClick: event => barOpenState.toggle(event.currentTarget),
      },
      "导师模式",
    );
  }

  /**
   * 顶部工具条的任务刷新间隔。
   * 抽成可改的对象是为了单测能把它调到 10ms —— 否则「挂载后才出现的任务
   * 要让 Clear 变亮」这条断言得等 15 秒。
   */
  const HEADER_POLL = { ms: 15000 };

  /**
   * 顶部工具条：`[导师模式] [Clear]`。
   *
   * 2026-11-04（用户要求「在UI里面加上Clear按钮我要随时能Clear」+ 审查打回
   * 「Clear 放 .mt-p-ops 里，折叠/关闭后够不着」）：
   *
   * Clear 放在**会话头部工具槽**，不放状态条里。理由是可达性：
   *   · 状态条展开 → 能点
   *   · 状态条收起（只留一行）→ 能点
   *   · 用「导师模式」把状态条整个关掉 → 还能点
   *   · 导师被 task_off 关掉 → 还能点（归档是本地数据操作，不需要导师开着）
   * 放状态条操作栏里做不到第一条之外的任何一种。
   *
   * 防误触：点第一次变成「确认归档?」，3 秒内再点才执行，否则自动复位。
   * 归档不可逆，不能一下误触就没了。
   */

  function MentorHeaderActions() {
    const live=useLiveState(),task=live.task;
    const [open,setOpen]=React.useState(barOpenState.open),[confirming,setConfirming]=React.useState(false),[notice,setNotice]=React.useState('');
    React.useEffect(()=>barOpenState.subscribe(setOpen),[]);
    React.useEffect(()=>{setConfirming(false);},[task?.taskId||task?.id]);
    React.useEffect(()=>{if(!confirming)return;const timer=setTimeout(()=>setConfirming(false),5000);return()=>clearTimeout(timer);},[confirming]);
    React.useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice]);
    const clear=async()=>{
      if(!task||live.busy)return;
      if(!confirming){setConfirming(true);return;}
      setConfirming(false);const r=await runControl('mentor_task_clear',{reason:'user-clear'});
      setNotice(r?.ok?'已归档任务':r?.error?.message||'归档失败');
    };
    return h('span',{className:'mt-header-actions'},
      h('button',{type:'button',className:'mt-toggle'+(open?' mt-toggle-on':''),'aria-label':open?'隐藏导师任务面板':'显示导师任务面板','aria-pressed':open,'aria-expanded':open,'data-mentor-toggle':'',onClick:event=>barOpenState.toggle(event.currentTarget)},'导师模式'),
      h('button',{type:'button',className:'mt-toggle mt-clear'+(confirming?' mt-clear-confirm':''),disabled:!task||task.phase==='archived'||live.busy,'aria-label':confirming?'确认归档当前导师任务':'归档当前导师任务',title:task?'归档当前选中任务，保留记录':'没有可归档任务',onClick:clear},live.action==='mentor_task_clear'?'归档中…':confirming?'确认归档？':'Clear'),
      notice||activeControlError(live)||live.error?h('span',{className:'mt-toast',role:'status'},notice||activeControlError(live)||live.error):null);
  }

  /**
   * s3 L3：把「面板里到底有没有内容」算成可读数字。
   * 纯函数，供 MentorPanel 渲染时回报 + 单测直接断言。
   *
   * @param {object|null} task mentor_task_status 返回的 value.task
   * @returns {{task:boolean, taskId:string|null, phase:string|null, revision:number|null,
   *            dagNodes:number, criteria:number, findings:number, nodeRuns:number}}
   */
  function summarizePanelSections(task) {
    const empty = {
      task: false,
      taskId: null,
      phase: null,
      revision: null,
      dagNodes: 0,
      criteria: 0,
      findings: 0,
      nodeRuns: 0,
    };
    if (!task || typeof task !== "object") return empty;

    const stages = Array.isArray(task.stages) ? task.stages : [];
    const criteria = Array.isArray(task.criteria) ? task.criteria : [];
    const nodeRuns = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
    const taskFindings = Array.isArray(task.findings) ? task.findings : [];
    const runFindings = nodeRuns.reduce(
      (n, r) => n + (r && Array.isArray(r.findings) ? r.findings.length : 0),
      0,
    );

    return {
      task: true,
      taskId: typeof task.id === "string" ? task.id : (task.taskId ?? null),
      phase: typeof task.phase === "string" ? task.phase : null,
      revision: typeof task.revision === "number" ? task.revision : null,
      dagNodes: stages.length,
      criteria: criteria.length,
      findings: taskFindings.length + runFindings,
      nodeRuns: nodeRuns.length,
    };
  }

  /** 把 sections + rect 写进 diag（selfcheck 会带它上行落盘） */
  function reportPanelObservation(task) {
    try {
      const g = globalThis;
      if (!g.__mtDiag) return;
      g.__mtDiag.sections = summarizePanelSections(task);
      g.__mtDiag.panelDataAt = Date.now();
      g.__mtDiag.tabActive = panelState.open === true;
      try {
        const node = g.document ? g.document.querySelector("[data-mt-pane]") : null;
        if (node && typeof node.getBoundingClientRect === "function") {
          const r = node.getBoundingClientRect();
          g.__mtDiag.rect = { w: Math.round(r.width), h: Math.round(r.height) };
        }
      } catch {}
    } catch {}
  }

  function MentorPanel() {
    const [open, setLocalOpen] = React.useState(panelState.open);
    React.useEffect(() => subscribe(() => setLocalOpen(panelState.open)), []);

    const [data, setData] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [tick, setTick] = React.useState(0);

    // 请求序号守卫：面板打开后会周期性取数，慢请求可能晚于快请求返回。
    // 没有守卫时「谁最后 resolve 谁说了算」，界面会退回到旧数据。
    // 2026-11-03 修：此前 C1 用例把这个缺陷当成既定行为记录下来了。
    //
    // 2026-11-03 二次修（真机 CDP 注入发现）：守卫只该保护**数据**（防旧数据覆盖新数据），
    // 不能连**错误**一起吞。原实现在 then/catch/finally 里都判 my !== dataSeq.current，
    // 于是「每 5s 一次周期刷新 + 8s 超时」的组合下，每个超时错误都属于旧序号，
    // 被后面的请求顶掉 —— 错误永远不显示、loading 永远不复位、刷新按钮永久 disabled。
    // 真机复现：Network.emulateNetworkConditions latency=9000 后，面板停在「…」且
    // refreshDisabled=true，11s 后仍无任何错误文案。
    const dataSeq = React.useRef(0);

    /**
     * @param {{silent?: boolean}} [opts] silent=后台轮询：不动 loading，避免和用户手动刷新抢状态。
     */
    const refresh = React.useCallback((opts) => {
      const silent = Boolean(opts && opts.silent);
      const my = ++dataSeq.current;
      if (!silent) setLoading(true);
      fetchState(pluginCtx)
        .then((env) => {
          if (env && env.ok) {
            // 数据仍然只允许「最新请求」写，防止旧响应覆盖新数据
            if (my === dataSeq.current) {
              setData(env.value);
              // s3 L3：面板真的拿到了数据 —— 把 sections/rect 写进 diag 供落盘判定
              reportPanelObservation(env.value && env.value.task);
              setError(null);
            }
          } else {
            // 失败信息如实呈现，不因序号落后就丢弃
            const msg =
              (env && env.error && env.error.message) || "取数失败";
            setError(msg);
          }
        })
        .catch((err) => {
          // 兜底：任何未预期异常都要让人看见，不让面板静默卡住
          setError(String((err && err.message) ?? err));
        })
        .finally(() => {
          // 只有非静默请求负责关 loading，且只关自己那一次
          if (!silent) setLoading(false);
        });
    }, []);

    React.useEffect(() => {
      if (!open) return undefined;
      refresh();
      // 面板开着就周期刷新：任务在别处推进（revision 变了）时不用手动点刷新。
      // 用 silent，避免后台轮询把 loading / 错误状态搅乱。
      const t = setInterval(() => refresh({ silent: true }), 5000);
      return () => clearInterval(t);
    }, [open, tick, refresh]);

    if (!open) return null;

    // 同 ComposerBar：fetchState 返回 { ok, value: { task } }，state 里存的是 value，
    // 取 task 必须再下一层。此前这里也写成 `data`，导致面板显示 rev undefined、
    // phase/objective/stages 全空（与状态条同一个 bug 的第二处）。
    const task = data && data.task !== null ? data.task : null;
    const isEmpty = data && data.task === null;

    const head = React.createElement(
      "div",
      { className: "mt-head" },
      React.createElement("div", { className: "mt-title" }, "导师模式"),
      task
        ? React.createElement(
            "span",
            {
              className:
                "mt-badge " + (PHASE_CLASS[task.phase] || ""),
            },
            task.phase,
          )
        : null,
      task
        ? React.createElement(
            "span",
            { className: "mt-badge" },
            "rev " + task.revision,
          )
        : null,
      React.createElement("div", { className: "mt-spacer" }),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mt-btn",
          "aria-label": "刷新",
          title: "刷新",
          disabled: loading,
          onClick: () => setTick((v) => v + 1),
        },
        loading ? "…" : "刷新",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mt-btn",
          "aria-label": "关闭",
          title: "关闭",
          onClick: () => setOpen(false),
        },
        "✕",
      ),
    );

    let body;
    // 顺序有讲究：**有任务就优先显示任务**。取数异常只在顶部加一条降级提示，
    // 不能像旧实现那样把已经渲染出来的任务整块换成错误页 —— 那等于一次瞬时
    // 失败就把人正在看的东西藏起来（与 ComposerBar 同一性质的缺陷）。
    if (task) {
      const unfinished = (task.unresolved && task.unresolved.items) || [];
      body = React.createElement(
        "div",
        { className: "mt-body" },
        error
          ? React.createElement(
              "div",
              { className: "mt-error", style: { marginTop: "8px" } },
              "取数异常（以下为上次成功的数据）：" + error,
            )
          : null,
        React.createElement(
          "div",
          { className: "mt-meta", style: { marginTop: "10px" } },
          task.objective || "",
        ),
        SectionTitle("验收项", (task.criteria || []).length),
        CriteriaBlock(task.criteria, task.stages),
        SectionTitle("阶段", (task.stages || []).length),
        StagesBlock(task.stages, task.nodeRuns),
        SectionTitle("未关闭问题", unfinished.length),
        FindingsBlock(task.unresolved),
      );
    } else if (error) {
      body = React.createElement(
        "div",
        { className: "mt-body" },
        React.createElement("div", { className: "mt-error" }, "取数失败：" + error),
        React.createElement(
          "div",
          { className: "mt-meta", style: { padding: "0 8px" } },
          "点右上角刷新重试",
        ),
      );
    } else if (isEmpty) {
      body = React.createElement(
        "div",
        { className: "mt-body" },
        React.createElement(
          "div",
          { className: "mt-empty" },
          "当前没有督导任务。",
          React.createElement("br"),
          "用 mentor_task_create 开一个。",
        ),
      );
    } else {
      body = React.createElement(
        "div",
        { className: "mt-body" },
        React.createElement("div", { className: "mt-empty" }, loading ? "加载中…" : "点击刷新取数"),
      );
    }

    return React.createElement(
      "div",
      { className: "mt-panel", role: "complementary", "aria-label": "导师模式督导面板", "data-mt-pane": "1" },
      head,
      body,
      React.createElement(
        "div",
        { className: "mt-foot" },
        React.createElement("span", null, "dsh-mentor 0.1.0"),
        task
          ? React.createElement(
              "span",
              null,
              "ready: " + ((task.readyNodes || []).join(", ") || "无"),
            )
          : null,
      ),
    );
  }

  /* ================================================================== *
   * 插件定义
   * ================================================================== */

  // 诊断层 1：client.js 被浏览器加载并执行到 factory 体。
  // 这条不依赖 DSH 调用任何导出函数，只要文件被加载就会出现。
  try {
    document.documentElement.setAttribute("data-mt-load", "1");
  } catch {}

  // cordis 服务依赖声明。
  //
  // 2026-11-04 第三轮（c7，用户裁定「我不需要这个右侧面板」）：
  // 侧栏相关注册全部删除，因此 `sidebarRight` / `sidebarRightTabs` /
  // `uiConversation` 三个强依赖也一并撤回 —— 留着一个用不上的强依赖，
  // 会让「服务缺失 → 插件不加载 → 连状态条都没了」成为一个真实风险。
  // 插件现在只依赖 slots（挂载 UI）与 connection（RPC 取数）。
  const inject = ["slots", "connection"];

  /* ================================================================== *
   * 自更新：宿主不会向页面推送 client-plugin 变更
   *
   * 2026-11-03 实测（隔离实例，CDP 观察 + 端点探测）：
   *   - 页面只有一条 WebSocket（/api/remote.mux），消息全是
   *     {type:"item",streamId:...} 的会话流，**没有任何 plugin rev 推送**；
   *   - /api/client-modules 在当前版本返回 404；
   *   - 唯一可靠的「宿主当前 serve 的版本」来源是 index HTML 里的
   *     `plugins/??dsh-mentor/client.js&rev=<digest>`。
   * 所以只能轮询：60s 拉一次 index（约 39KB），rev 变了就提示并自动重载，
   * 免得每次改插件都要求使用者手动按 Ctrl+R。
   *
   * 重要限制：这段代码本身也是插件代码 —— **它上线后的第一次仍需手动刷新一次**，
   * 之后再有改动才会自动生效。
   * ================================================================== */

  const UPDATER = {
    stateKey: "dsh-mentor-loaded-rev",
    optOutKey: "mt-auto-reload", // 置为 "0" 可关闭自动重载
    pollMs: 60000,
    countdownSec: 3,
  };

  /** 从 index HTML 里取宿主当前 serve 的 dsh-mentor bundle rev */
  function parseServedRev(html) {
    if (typeof html !== "string") return null;
    const m = html.match(/dsh-mentor\/client\.js&rev=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  /** 本页面实际加载的 rev（来自 boot manifest） */
  function loadedRev() {
    try {
      const boot = typeof window !== "undefined" ? window.__DSH_BOOT__ : null;
      const entry = ((boot && boot.entries) || []).find(
        (e) => e && e.id === "dsh-mentor",
      );
      return entry && entry.rev ? String(entry.rev) : null;
    } catch {
      return null;
    }
  }

  /** 带倒计时的重载提示；可点「稍后」取消本次 */

  function showReloadHint(onReload) {
    try {
      const el=document.createElement('div');el.className='mt-reload';el.setAttribute('role','status');
      const label=document.createElement('span');label.textContent='导师界面有更新，当前对话不会自动刷新。';
      const apply=document.createElement('button');apply.type='button';apply.textContent='更新界面';
      const later=document.createElement('button');later.type='button';later.textContent='稍后';
      apply.addEventListener('click',()=>{el.remove();onReload();});later.addEventListener('click',()=>el.remove());
      el.append(label,apply,later);(document.body||document.documentElement).appendChild(el);return el;
    } catch { return null; }
  }

  /**
   * 轮询宿主 serve 的 bundle rev，发现变化就提示 + 自动重载。
   * @returns {(() => void)|null} dispose
   */
  function watchForUpdates() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return null;
    }
    let ls = null;
    try {
      ls = window.localStorage;
    } catch {
      ls = null;
    }
    if (ls && ls.getItem(UPDATER.optOutKey) === "0") return null;

    const baseline = loadedRev();
    let stopped = false;
    let hinted = false;

    const check = async () => {
      if (stopped || hinted) return;
      try {
        const r = await fetch("/", { cache: "no-store" });
        if (!r || !r.ok) return;
        const served = parseServedRev(await r.text());
        if (!served || served === baseline) return;
        // 已经为这个版本重载过就别再刷，避免宿主每次给新 digest 时死循环
        let seen = null;
        try {
          seen = ls ? ls.getItem(UPDATER.stateKey) : null;
        } catch {}
        if (seen === served) return;
        try {
          if (ls) ls.setItem(UPDATER.stateKey, served);
        } catch {}
        hinted = true;
        showReloadHint(() => {
          try {
            window.location.reload();
          } catch {}
        });
      } catch {}
    };

    // 2026-11-03 追加：光靠 60s 轮询，改完代码最多要等一分钟才被发现。
    // 切回窗口 / 页面重新可见 时立刻查一次，把发现延迟压到「切回来即查」。
    // 3s 节流，避免来回切窗口时把 index 请求打爆。
    let lastCheck = 0;
    const triggerCheck = () => {
      const now = Date.now();
      if (now - lastCheck < 3000) return;
      lastCheck = now;
      check();
    };
    const onVisibility = () => {
      try {
        if (document.visibilityState === "visible") triggerCheck();
      } catch {}
    };

    try {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", triggerCheck);
    } catch {}

    const kick = setTimeout(check, 8000); // 启动后先查一次，不必等满 60s
    const interval = setInterval(check, UPDATER.pollMs);
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(interval);
      try {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", triggerCheck);
      } catch {}
    };
  }

  function apply(ctx) {
    // 诊断层 2：DSH 真的调用了 apply(ctx)。
    try {
      document.documentElement.setAttribute("data-mt-apply", "1");    } catch {}

    pluginCtx = ctx;
    const stopLive = startLive(ctx);

    // 诊断：把关键事实写到 documentElement 的 data 属性上，便于真机排查
    // （浏览器 console 在某些嵌入场景抓不到，DOM 属性一定读得到）
    const diag = {};
    // s3：把诊断挂到全局，selfcheck 每 30s 随请求体上报 → 插件写进
    // mentor-observation.json 的 reports[].diag，agent 读文件就能判定挂载情况。
    try {
      globalThis.__mtDiag = diag;
    } catch {}

    // 2026-11-04 修 D3/D4：取宿主服务的统一入口。
    // 改前三处一律 ctx.get("sidebarRight")，结果全部 undefined，表现为：
    //   registeredTab=false / tabErr「sidebarRightTabs / sidebarRight 均不可用」
    //   openTabErr「sidebarRight.openTab 不可用」
    //   registeredEvents=false / eventsErr「uiConversation.events 不可用」
    // 根因不在服务名，而在 package.json 的 dsh.client.inject：原来只声明了 4 个包，
    // 缺 dsh-client-ui-sidebar-right（sidebarRight / sidebarRightTabs 的提供方）
    // 与 dsh-client-ui-chat（uiConversation 的提供方），这两个服务在客户端运行时
    // 里根本没被加载。对照 dsh-task-supervisor 的 inject 声明可见差异，已补齐。
    // 另把「属性注入」与「ctx.get 反射」两种取法都试：cordis 声明 inject 后服务
    // 是 ctx 上的属性，而 ctx.get 走服务注册表，真机上不一定两者同时可用。
    const service = (name) => {
      try {
        const viaProp = ctx ? ctx[name] : undefined;
        if (viaProp !== undefined && viaProp !== null) return viaProp;
      } catch (e) {
        /* 属性访问被 getter 挡住时退回 ctx.get */
      }
      try {
        return typeof ctx.get === "function" ? ctx.get(name) : undefined;
      } catch (e) {
        return undefined;
      }
    };
    // 记录每个服务的两条取法结果，供真机排查（属性有 / 反射有 / 都没有）
    try {
      diag.serviceProbe = {};
      for (const name of ["slots", "sidebarRight", "sidebarRightTabs", "uiConversation"]) {
        const viaProp = ctx ? ctx[name] : undefined;
        const viaGet = typeof ctx.get === "function" ? ctx.get(name) : undefined;
        diag.serviceProbe[name] = {
          prop: viaProp === undefined || viaProp === null ? "none" : typeof viaProp,
          get: viaGet === undefined || viaGet === null ? "none" : typeof viaGet,
        };
      }
    } catch (e) {
      diag.serviceProbeErr = String((e && e.message) ?? e);
    }

    // 2026-11-04 修 P2-1：挂载失败原来只写内存 diag —— 页面刷新就没了；
    // ensureStyle 抛错还会把后面所有诊断一起带走（走不到末尾那次落 DOM）。
    // 现在统一走这两个函数：diag 字段 + DOM 属性（面板一眼可见）+ console.warn。
    const flushDiag = () => writeDiagAttr(diag);
    const reportMountFailure = (key, err) => {
      const msg = recordMountFailure(diag, key, err);
      if (typeof console !== "undefined") {
        console.warn("[dsh-mentor] 挂载失败 " + key + ": " + msg);
      }
    };
    try {
      diag.hasGet = typeof ctx.get === "function";
      diag.ctxKeys = Object.keys(ctx).slice(0, 40);
    } catch (e) {
      diag.ctxKeysErr = String((e && e.message) ?? e);
    }
    try {
      const s = typeof ctx.get === "function" ? ctx.get("slots") : "no-get";
      diag.slotsKind = typeof s;
      diag.slotsIsUndef = s === undefined;
      if (s && typeof s === "object") {
        diag.slotsKeys = Object.keys(s).slice(0, 20);
      }
    } catch (e) {
      diag.slotsErr = String((e && e.message) ?? e);
    }

    try {
      ensureStyle();
    } catch (e) {
      reportMountFailure("style", e);
    }

    const slots = service("slots");

    if (slots === undefined) {
      diag.result = "slots-undefined";
      flushDiag();
      if (typeof console !== "undefined") {
        console.warn("[dsh-mentor] slots 服务不可用，面板未挂载");
      }
      return;
    }

    diag.hasInject = typeof slots.inject === "function";
    diag.hasRegister = typeof slots.register === "function";

    try {
      // 会话头部的工具条：导师模式开关 + Clear（Clear 必须随时可点，
      // 所以放这里而不是状态条操作栏里 —— 后者折叠时整块不渲染）
      slots.inject("conversation.session.header.utilities", () =>
        slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "mentor-toggle",
            order: 90,
            label: () => "导师模式",
          },
          makeHotSlot("MentorHeaderActions", (props) =>
            React.createElement(MentorHeaderActions, { ...props, ctx }),
          ),
        ),
      );
      diag.registeredToggle = true;
    } catch (e) {
      reportMountFailure("toggle", e);
    }

    // 2026-11-04 第三轮（c7，用户裁定「我不需要这个右侧面板」）：
    // `shell.overlay` 的全屏浮层面板注册已删除。
    // 它是 `shell.overlay` 而不是侧栏，一旦 panelState.open 就是整屏覆盖 ——
    // 这正是「UI 太大遮住对话」的结构性来源。用户只需要输入框上方那条。
    // 组件 MentorPanel 定义暂时保留（不注册即不渲染），便于将来需要时快速接回。
    diag.registeredPanel = false;
    diag.panelDisabledReason = "removed-by-user-request";

    try {
      // 输入框区域的挂载点。DSH 该区域有 12 个 slot，实测：
      //   conversation.composer.dock → 可注册、组件会被调用（activity pill 所在 dock）
      //   conversation.composer.bar  → 注册后整个 dsh-client-ui-conversation 包加载失败，不可用
      slots.inject("conversation.composer.dock", () =>
        slots.register(
          {
            name: "conversation.composer.dock",
            id: "mentor-bar",
            order: 10,
            label: () => "导师模式",
          },
          makeHotSlot("ComposerBar", ComposerBar),
        ),
      );
      diag.registeredBar = true;
    } catch (e) {
      reportMountFailure("bar", e);
    }

    // ---- s3：右侧栏面板（对照 dsh-task-supervisor/patched/lib/client.js:8421-8440）----

    // ① tab 内容槽。只 openTab 没它，tab 打开就是空白。
    // 2026-11-04 第三轮（c7）：侧栏相关的四处注册全部删除 ——
    //   ① `sidebar.right.pane.tab` 内容槽
    //   ② `sidebarRightTabs` / `sidebarRight` 的 tab 注册
    //   ③ `openTab` 触发器（`globalThis.__mtOpenTab`）
    //   ④ `uiConversation.events` 的 review/milestone 订阅
    // 用户明确说「我不需要这个右侧面板」。删掉后也顺带消除了两类噪音：
    // 真机 diag 里长期为 false 的 registeredTab / registeredEvents，
    // 以及 `sidebarRight` / `uiConversation` 服务缺失时的报错路径。
    // 状态条（conversation.composer.dock）与顶部入口（…session.header.utilities）
    // 不依赖这些服务，删除不影响它们。
    diag.registeredPaneTab = false;
    diag.registeredTab = false;
    diag.registeredEvents = false;
    diag.sidebarRemovedReason = "removed-by-user-request";

    // 薄壳热更新：UI 由远端模块提供，改 lib/hot-ui.js 不用刷新页面
    try {
      hotUiDispose = startHotUi();
      diag.hotUi = true;
    } catch (e) {
      diag.hotUi = false;
      diag.hotUiErr = String((e && e.message) ?? e);
    }

    // 版本自检：把「页面加载的是哪一版」渲染成可见读数
    try {
      selfCheckDispose = startSelfCheck();
      diag.selfCheck = true;
    } catch (e) {
      diag.selfCheck = false;
      diag.selfCheckErr = String((e && e.message) ?? e);
    }

    // 自更新轮询：宿主不推送 plugin 变更，只能自己发现新 bundle。
    // 生命周期跟页面一致，页面重载即结束，所以只留引用不强制清理。
    try {
      updaterDispose = watchForUpdates();
      diag.updater = typeof updaterDispose === "function";
    } catch (e) {
      diag.updater = false;
      diag.updaterErr = String((e && e.message) ?? e);
    }

    diag.result = "done";
    flushDiag();
    return () => { stopLive(); updaterDispose?.(); hotUiDispose?.(); selfCheckDispose?.(); };
  }

  exports.inject = inject;
  exports.apply = apply;
  // 测试出口：让 node --test 能直接驱动这些纯函数 / 组件，不必启动浏览器。
  // 约定：__test 只被 test/client.test.mjs 使用，不应出现在任何运行时代码路径里。
  // panelState 暴露出来是为了让测试能把面板置为「打开」态驱动 MentorPanel。
  exports.__test = {
    fetchState,
    // s3 L3：面板内容统计（纯函数，直接断言 sections 字段）
    summarizePanelSections,
    writeDiagAttr,
    recordMountFailure,
    // 自采度量（纯函数：输入真实 DOM 元素，输出区块/文本读数）
    // 单测直接打这两个函数，不必依赖 mini React runtime 造出真 DOM。
    collectBarSections,
    readBarText,
    // 状态条显隐开关（顶部「导师模式」按钮控制）
    barOpenState,
    // 顶部工具条（导师模式开关 + Clear），Clear 的可达性在这里保证
    MentorHeaderActions,
    // 只为单测：把工具条的轮询间隔调到毫秒级
    setHeaderPollMs: (ms) => {
      HEADER_POLL.ms = ms;
    },
    getHeaderPollMs: () => HEADER_POLL.ms,
    callCommand,
    ComposerBar,
    MentorToggle,
    MentorPanel,
    panelState,
    // 只为单测：把 8s 超时调小，测「请求挂起 → 超时后 loading 复位」
    setFetchTimeout: (ms) => {
      FETCH_TIMEOUT.ms = ms;
    },
    getFetchTimeout: () => FETCH_TIMEOUT.ms,
    // 自更新相关（纯函数，便于单测）
    parseServedRev,
    loadedRev,
    watchForUpdates,
    // 薄壳热更新（便于单测：求值、回退、切换）
    evalHotUi,
    refreshHotUi,
    makeHotSlot,
    hotUiState: hotUi,
    // 版本自检（便于单测：读数成功 / 降级 unknown）
    refreshSelfCheck,
    VersionChip,
    selfCheckState: selfCheck,
    selfCheckListeners,
    // Round 4 rules (pure) and components
    shouldFollowStream,
    nextCompact,
    tabKeyTarget,
    escapeLayer,
    visibleIssues,
    canSubmitClose,
    activeControlError,
    isTaskLive,
    readPanelAppearance,
    DEFAULT_PANEL_APPEARANCE,
    runControl,
    getLiveState: () => liveState.value,
    IssueContent,
    OverviewContent,
    MindMapView,
    layoutMindMap,
    mindMapFocusSet,
    StreamOutput,
    DASHBOARD_CSS,
  };
  return module.exports;
};

window.__ModuleLoader__.load({ id: "dsh-mentor/client", factory });
