/**
 * dsh-mentor 可热替换 UI 模块（薄壳架构）
 *
 * 怎么工作：
 *   1. 本文件由服务端路由 `POST /api/mentor/hot-ui` 以**源码文本 + sha256** 返回；
 *   2. 客户端外壳（lib/client.js）用 `new Function` 求值本文件，传入 (React, deps)，
 *      得到一组组件；
 *   3. 外壳定期拉本文件的 sha256，变化就重新求值、替换引用、通知组件重渲染 ——
 *      **不重载页面、不丢输入**。
 *
 * 为什么能这么干：真机实测 `new Function` 与 `eval` 在 DSH 页面可用、无 meta CSP。
 *
 * 约定：
 *   - 本文件必须是一个「箭头函数表达式」，签名 (React, deps) => ui；
 *   - deps 提供内置实现：{ ComposerBar, MentorToggle, MentorPanel }；
 *   - ui 至少包含 ComposerBar / MentorToggle / MentorPanel 三个组件，外加一个 marker；
 *   - 这里抛错不会把界面弄挂：外壳会退回内置实现并标记降级。
 */
(React, deps) => {
  const { ComposerBar, MentorToggle, MentorPanel } = deps;

  // v1 → v2/v3 → v4：见下方历史注释。
  // v5（2026-11-04）：去掉包裹 div，marker 改挂 <html>。
  // v9-pro（2026-11-25）：v0.4 升级（纯黑高对比 + 10s 撤销归档 + 跨会话接班简报 + 项目经验沉淀 + worktree 标签）。
  const MARKER = "v9-pro";

  /**
   * 状态条包装。
   *
   * v4 及以前这里返回 `<div style="display:contents" data-hot-ui=...>`。
   * 实测问题：display:contents 的盒子不参与布局，它的属性节点会直接落进
   * composer slot 容器，和其他元素叠在同一位置 —— 这就是用户连提三次的
   * 「右上角有乱码」（session-f6230ebf #33 / #41 / #43）。
   * 现在不再包任何 DOM，marker 挂到 <html data-hot-ui>，断言路径
   * （document.documentElement.getAttribute("data-hot-ui")）保持不变。
   *
   * 另外：顶栏右侧的 VersionChip 已经显示 `ui:<marker>`，这里不再额外产出角标，
   * 避免出现「两个角标重复」的视觉噪音。
   */
  const HotComposerBar = (props) => {
    try {
      if (typeof document !== "undefined" && document.documentElement) {
        document.documentElement.setAttribute("data-hot-ui", MARKER);
      }
    } catch (e) {
      /* 属性写失败不影响渲染 */
    }
    return React.createElement(ComposerBar, props);
  };

  return {
    marker: MARKER,
    ComposerBar: HotComposerBar,
    MentorToggle,
    MentorPanel,
  };
}
