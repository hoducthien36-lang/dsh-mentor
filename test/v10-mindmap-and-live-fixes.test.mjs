import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

import {
  resolvePrecheckCommand,
  runStagePrechecks,
  formatPrecheckPromptSummary,
} from "../src/runtime/prechecks.js";
import { createMemoryStore, taskCreate, planSubmit, planAmend } from "../src/tools/handlers.js";
import { TOOL_NAMES } from "../lib/index.js";

function loadClientExports() {
  const React = {
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(init) {
      const val = typeof init === "function" ? init() : init;
      return [val, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(v) { return { current: v }; },
    useCallback(fn) { return fn; },
  };
  let loaded = null;
  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          loaded = factory((id) => {
            if (id === "react") return React;
            throw new Error("missing " + id);
          });
        },
      },
    },
  });
  return readFile(path.resolve("lib/client.js"), "utf8").then((src) => {
    vm.runInContext(src, ctx);
    return loaded.__test;
  });
}

test("LIVE-FIX-1: Windows 未安装 pwsh 7 时 precheck 自动透明回退至 powershell 5.1 并保留显式 note", async () => {
  // 1) Windows + 无 pwsh → 自动改写前导 pwsh / pwsh.exe
  const r1 = resolvePrecheckCommand('pwsh -NoProfile -Command "Write-Output ok"', {
    platform: "win32",
    hasPwsh: false,
  });
  assert.equal(r1.command, 'powershell -NoProfile -Command "Write-Output ok"');
  assert.equal(r1.fallbackFrom, "pwsh");
  assert.match(r1.note, /PowerShell 5\.1/);

  const r2 = resolvePrecheckCommand('  "pwsh.exe" -Command "1+1"', {
    platform: "win32",
    hasPwsh: false,
  });
  assert.equal(r2.command, '  powershell -Command "1+1"');
  assert.equal(r2.fallbackFrom, "pwsh");

  // 2) 已安装 pwsh 或非 Windows → 不改写
  const r3 = resolvePrecheckCommand('pwsh -Command "1+1"', { platform: "win32", hasPwsh: true });
  assert.equal(r3.command, 'pwsh -Command "1+1"');
  assert.equal(r3.fallbackFrom, null);

  const r4 = resolvePrecheckCommand('pwsh -Command "1+1"', { platform: "linux", hasPwsh: false });
  assert.equal(r4.command, 'pwsh -Command "1+1"');
  assert.equal(r4.fallbackFrom, null);

  // 3) 非 pwsh 命令原样透传（如 node / powershell）
  const r5 = resolvePrecheckCommand("node --check lib/client.js", { platform: "win32", hasPwsh: false });
  assert.equal(r5.command, "node --check lib/client.js");
  assert.equal(r5.fallbackFrom, null);

  // 4) formatPrecheckPromptSummary 透出回退说明，不静默隐瞒
  const summary = formatPrecheckPromptSummary({
    ok: true,
    total: 1,
    passed: 1,
    failed: 0,
    durationMs: 45,
    results: [{
      id: "precheck_1",
      label: "pwsh check",
      ok: true,
      durationMs: 45,
      note: "本机 PATH 未找到 pwsh (PowerShell 7)，已自动回退至 Windows PowerShell 5.1 (powershell)",
    }],
  });
  assert.match(summary, /已自动回退至 Windows PowerShell 5\.1/);

  // 5) runStagePrechecks 端到端不报错（mock runner）
  const seen = [];
  const res = await runStagePrechecks({
    workspaceRoot: os.tmpdir(),
    prechecks: ['pwsh -NoProfile -Command "Write-Host hi"'],
    runner: async ({ command }) => {
      seen.push(command);
      return { ok: true, exitCode: 0, durationMs: 12, stdout: "hi", stderr: "" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(seen.length, 1);
});

test("LIVE-FIX-2: mentor_plan_amend 回显 changedFields 与 noOp，漏传 stages 时给出明确 warning", () => {
  const store = createMemoryStore();
  const created = taskCreate(store, { objective: "验证 plan_amend 回显", workspaceRoot: os.tmpdir() });
  assert.equal(created.ok, true);
  const submitted = planSubmit(store, {
    criteria: [{ id: "c1", text: "基础验收" }],
    stages: [{ id: "s1", title: "阶段一", criterionIds: ["c1"], dependsOn: [] }],
  });
  assert.equal(submitted.ok, true);

  // 1) 漏传 stages 与 criteria（纯 reason 修订）→ changedFields=[], noOp=true, warning 非空
  const noOpRes = planAmend(store, { reason: "漏传 stages 模拟" });
  assert.equal(noOpRes.ok, true);
  assert.deepEqual(noOpRes.value.changedFields, []);
  assert.equal(noOpRes.value.noOp, true);
  assert.match(noOpRes.value.warning, /未检测到 stages 或 criteria 的实质变化/);
  assert.equal(store.get().amendments.at(-1).noOp, true);

  // 2) 只修改 stages → changedFields=["stages"], noOp=false, 无 warning
  const stageRes = planAmend(store, {
    reason: "拆出第二阶段",
    stages: [
      { id: "s1", title: "阶段一", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "阶段二", criterionIds: ["c1"], dependsOn: ["s1"] },
    ],
  });
  assert.equal(stageRes.ok, true);
  assert.deepEqual(stageRes.value.changedFields, ["stages"]);
  assert.equal(stageRes.value.noOp, false);
  assert.equal(stageRes.value.warning, undefined);

  // 3) 同时修改 criteria 与 stages → changedFields=["criteria", "stages"]
  const bothRes = planAmend(store, {
    reason: "追加新验收标准并绑定",
    criteria: [
      { id: "c1", text: "基础验收" },
      { id: "c2", text: "扩展验收" },
    ],
    stages: [
      { id: "s1", title: "阶段一", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "阶段二（增强）", criterionIds: ["c1", "c2"], dependsOn: ["s1"] },
    ],
  });
  assert.equal(bothRes.ok, true);
  assert.deepEqual(bothRes.value.changedFields, ["criteria", "stages"]);
  assert.equal(bothRes.value.noOp, false);
});

test("MINDMAP-1: layoutMindMap 拓扑分支、菱形汇聚、末梢叶子、无重叠、环安全与聚焦链路隔离", async () => {
  const exp = await loadClientExports();
  assert.equal(TOOL_NAMES.length, 27, "全球 MCP 工具数必须死守 27");

  const diamondTask = {
    id: "t-mm-1",
    objective: "实现高可用认证网关",
    phase: "active",
    planVersion: 2,
    criteria: [
      { id: "c1", text: "协议校验" },
      { id: "c2", text: "令牌签发" },
      { id: "c3", text: "限流保护" },
      { id: "c4", text: "集成压测通过" },
    ],
    stages: [
      { id: "s1", title: "梳理协议边界", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "令牌签名实现", criterionIds: ["c2"], dependsOn: ["s1"] },
      { id: "s3", title: "令牌桶限流器", criterionIds: ["c3"], dependsOn: ["s1"] },
      { id: "s4", title: "全链路集成验收", criterionIds: ["c4"], dependsOn: ["s2", "s3"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "accepted" },
      { stageId: "s2", attempt: 1, status: "accepted" },
      { stageId: "s3", attempt: 2, status: "rework" },
      { stageId: "s4", attempt: 1, status: "pending" },
    ],
    lastDiffAudits: {
      s2: { totalChangedFiles: 2, totalAddedLines: 42, totalRemovedLines: 5, undeclaredFiles: [] },
      s4: { totalChangedFiles: 1, totalAddedLines: 12, totalRemovedLines: 0, undeclaredFiles: [] },
    },
  };

  const lay = exp.layoutMindMap(diamondTask, { showLeaves: true });
  assert.ok(lay.root && lay.root.id === "__root__");
  assert.equal(lay.nodes.length, 4);
  // 拓扑列：s1 在 col 0，s2/s3 并行在 col 1，s4 汇聚在 col 2
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("s1").col, 0);
  assert.equal(byId.get("s2").col, 1);
  assert.equal(byId.get("s3").col, 1);
  assert.equal(byId.get("s4").col, 2);
  assert.ok(byId.get("s2").y + byId.get("s2").h <= byId.get("s3").y, "同列并行节点绝不得纵向重叠");
  assert.ok(lay.leaves.length >= 2, "末梢节点 s4 展开后应挂出变更与验收微胶囊");
  assert.ok(lay.edges.every((e) => /^M\d+ \d+ C\d+ \d+, \d+ \d+, \d+ \d+$/.test(e.d)), "全部连线应为合法三次贝塞尔曲线");

  // 聚焦 s2：应包含 __root__, s1, s2, s4，排除无关并行分支 s3
  const focusS2 = exp.mindMapFocusSet("s2", lay.parentsOf, lay.childrenOf);
  assert.equal(focusS2.has("__root__"), true);
  assert.equal(focusS2.has("s1"), true);
  assert.equal(focusS2.has("s2"), true);
  assert.equal(focusS2.has("s4"), true);
  assert.equal(focusS2.has("s3"), false, "并行无关分支 s3 应被压暗隔离");

  // 环安全：异常循环依赖绝不爆栈
  const cyclic = exp.layoutMindMap({
    id: "t-cyc",
    objective: "环测试",
    stages: [
      { id: "a", title: "A", dependsOn: ["b"] },
      { id: "b", title: "B", dependsOn: ["a"] },
    ],
    nodeRuns: [],
  });
  assert.equal(cyclic.nodes.length, 2);
  assert.ok(cyclic.width > 0 && cyclic.height > 0);
});
