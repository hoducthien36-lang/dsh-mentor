/**
 * 命令通道的适配层测试（改造 s2-a）。
 *
 * 为什么单独测：`runMentorCommand` 的单测只证明纯逻辑对，
 * 真正决定「输入框里敲 /mentor 有没有反应」的是 apply() 里那段注册代码。
 * 假 ctx 提供 commands 服务，就能在不重启 DSH 的前提下把这条路径跑通。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { apply } from "../lib/index.js";
import { PHASES } from "../src/state/machine.js";

/**
 * v0.2.0：命令 handler 的签名是 `({ agent, rawInput })`（lib/index.js:1837）。
 * `agent` 决定两件事，缺了就跑不通：
 *   ① 选会话 store —— `store.forAgent(agent)` → `forSession(agent.session.id)`，
 *      没有 id 直接抛「当前操作缺少宿主会话身份」（src/runtime/session-stores.js:24）；
 *   ② 建任务补工作区 —— `workspaceRoot ?? agent.session.header.cwd`（lib/index.js:691）。
 */
const AGENT = {
  session: {
    id: "test-session",
    header: { cwd: path.resolve(import.meta.dirname, "..") },
  },
};

function makeCtx({ withCommands = true } = {}) {
  const tools = new Map();
  const commands = new Map();
  const service = {
    register(spec) {
      if (!spec || typeof spec.name !== "string") throw new Error("命令必须有 name");
      if (commands.has(spec.name)) throw new Error(`重复注册命令：${spec.name}`);
      commands.set(spec.name, spec);
      return () => commands.delete(spec.name);
    },
  };

  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    effect() {},
    get(serviceName) {
      if (serviceName === "commands") return withCommands ? service : undefined;
      return undefined;
    },
  };
  return { ctx, tools, commands };
}

async function setup(opts = {}) {
  const m = makeCtx(opts);
  // stateDir 留空 → 内存 store，测试不落盘、不污染真实任务状态
  await apply(m.ctx, { stateDir: "" });
  return m;
}

test("R1 apply 注册 /mentor 主命令 + 7 条快捷命令", async () => {
  const { commands } = await setup();

  assert.ok(commands.has("mentor"), "主命令 /mentor 必须注册");
  const shortcuts = ["status", "approve", "pause", "resume", "clear", "off", "on"].map((v) => `mentor-${v}`);
  for (const name of shortcuts) {
    assert.ok(commands.has(name), `快捷命令 ${name} 必须注册`);
  }
  assert.equal(commands.size, 1 + shortcuts.length);

  const main = commands.get("mentor");
  assert.equal(typeof main.handler, "function");
  assert.ok(main.description.includes("导师"), main.description);
  assert.ok(main.input && typeof main.input.hint === "string", "主命令要给 input.hint");
});

test("R2 /mentor 空输入 = 看状态；无任务时是成功回执而不是错误", async () => {
  const { commands } = await setup();
  const out = await commands.get("mentor").handler({ agent: AGENT, rawInput: "" });

  assert.equal(out.kind, "success", JSON.stringify(out));
  assert.ok(out.text.includes("没有任务"), out.text);
  assert.ok(out.text.includes("/mentor new"), out.text);
});

test("R3 /mentor new 真的建任务，随后的 status 能读到", async () => {
  const { commands } = await setup();
  const main = commands.get("mentor");

  const created = await main.handler({ agent: AGENT, rawInput: "new 写矩阵文件" });
  assert.equal(created.kind, "success", JSON.stringify(created));
  assert.ok(created.text.includes("planning") || created.text.includes("已执行"), created.text);

  const status = await commands.get("mentor-status").handler({ agent: AGENT });
  assert.equal(status.kind, "success", JSON.stringify(status));
  assert.ok(status.text.includes(PHASES.PLANNING), status.text);
  assert.ok(status.text.includes("写矩阵文件"), status.text);
});

test("R4 未识别输入走错误回执，不建任务", async () => {
  const { commands } = await setup();
  const main = commands.get("mentor");

  const bad = await main.handler({ agent: AGENT, rawInput: "随便一句话" });
  assert.equal(bad.kind, "error", JSON.stringify(bad));
  assert.ok(bad.text.includes("未知子命令"), bad.text);

  const status = await commands.get("mentor-status").handler({ agent: AGENT });
  assert.ok(status.text.includes("没有任务"), "错误输入不应创建任务：" + status.text);
});

test("R5 宿主没有 commands 服务时不抛，工具仍然全部注册", async () => {
  const { commands, tools } = await setup({ withCommands: false });
  assert.equal(commands.size, 0);
  assert.ok(tools.size >= 17, `工具应照常注册，实际 ${tools.size}`);
});
