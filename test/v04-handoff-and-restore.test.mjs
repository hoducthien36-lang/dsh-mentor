/**
 * v0.4 · Round 3 跨会话接班机制与可逆归档测试套件：
 *   1. buildShiftHandoff 生成精简（≤4KB）结构化 + Markdown 交接简报
 *   2. 归档留存 preArchivePhase + 10 秒持久化撤销窗口，人工 mentor_task_restore 可精确恢复且模型不可调
 *   3. 跨会话接管（mentor_session_takeover / /mentor takeover）：
 *      - 递增 ownershipGeneration、记录 sessionHistory
 *      - 迁移落盘到目标会话目录并清空源会话（杜绝双主脑裂）
 *      - 幂等重复接管、目标会话冲突拦截、磁盘重载一致
 *   4. 严格保持 TOOL_NAMES.length === 27 不变
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, TOOL_NAMES, createStore } from "../lib/index.js";
import { dispatchCommand, COMMAND_ACTIONS } from "../src/rpc/command.js";
import { buildShiftHandoff } from "../src/runtime/handoff-shift.js";
import { createSessionStores } from "../src/runtime/session-stores.js";

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "mentor-v04-shift-"));
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, "a.txt"), "ok\n", "utf8");
  return { root, ws };
}

async function startPlugin(t, stateDir, ws) {
  const tools = new Map();
  const commands = new Map();
  const sessions = new Map();
  const makeAgent = (id) => {
    const a = {
      session: { id, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => [] },
      options: { provider: "fixture", model: "fixture" },
      status: "idle",
      followup: async () => {},
      whenIdle: async () => {},
    };
    sessions.set(id, a);
    return a;
  };
  const mainA = makeAgent("session-shift-A");
  const mainB = makeAgent("session-shift-B");
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    commands: { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name); } },
    agents: {
      async create({ sessionId, setup }) {
        const idle = Promise.withResolvers();
        const ag = makeAgent(sessionId);
        ag.status = "running";
        ag.whenIdle = () => idle.promise;
        const child = { tools: { view: () => ({ restrictableNames: new Set(), visible: new Set() }), restrict() {}, register() {}, guard() {} } };
        if (typeof setup === "function") setup(child, ag);
        return { agent: ag, async dispose() { idle.resolve(); } };
      },
      get: (id) => sessions.get(id) ?? null,
    },
  };
  const dispose = await apply(ctx, { stateDir, autoWakeMain: false, disposeTimeoutMs: 500 });
  t.after(async () => {
    await dispose();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const callAs = async (agent, name, args = {}) => JSON.parse(await tools.get(name).execute(args, { agent }));
  const slash = async (agent, rawInput) => commands.get("mentor").handler({ agent, rawInput });
  return { dispose, tools, commands, mainA, mainB, callAs, slash, sessions };
}

test("V04-H1 TOOL_NAMES 保持 27 项不变，restore / takeover 仅进入人工 COMMAND_ACTIONS", () => {
  assert.equal(TOOL_NAMES.length, 27);
  assert.ok(!TOOL_NAMES.includes("mentor_task_restore"));
  assert.ok(!TOOL_NAMES.includes("mentor_session_takeover"));
  assert.ok(COMMAND_ACTIONS.includes("mentor_task_restore"));
  assert.ok(COMMAND_ACTIONS.includes("mentor_session_takeover"));
});

test("V04-H2 buildShiftHandoff 生成 ≤4KB 交接简报，包含进度、未关闭问题与接管命令", () => {
  const task = {
    id: "task_handoff_1",
    revision: 6,
    objective: "重构持久化引擎",
    phase: "active",
    planVersion: 2,
    approvedPlanVersion: 2,
    mainSessionId: "session-old",
    workspaceRoot: "/repo",
    criteria: [{ id: "c1", text: "阶段1" }, { id: "c2", text: "阶段2" }],
    stages: [
      { id: "s1", title: "阶段1", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "阶段2", criterionIds: ["c2"], dependsOn: ["s1"] },
    ],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted", reports: [] }],
    findings: [{ id: "f1", stageId: "s2", severity: "blocking", status: "open", text: "需补齐边界测试" }],
    reviews: [],
    reviewJobs: [],
  };
  const brief = buildShiftHandoff(task);
  assert.equal(brief.progress.accepted, 1);
  assert.equal(brief.progress.total, 2);
  assert.deepEqual(brief.progress.readyStageIds, ["s2"]);
  assert.equal(brief.openFindings.length, 1);
  assert.equal(brief.takeoverCommand, "/mentor takeover task_handoff_1");
  assert.ok(Buffer.byteLength(brief.markdown, "utf8") <= 4096);
  assert.match(brief.markdown, /\/mentor takeover task_handoff_1/);
});

test("V04-H3 可逆归档：归档写入 preArchivePhase 与 10s 撤销截止时间，/mentor restore 可精确恢复原阶段", async (t) => {
  const { root, ws } = await tempRoot(t);
  const p = await startPlugin(t, root, ws);

  const created = await p.callAs(p.mainA, "mentor_task_create", { objective: "归档撤销测试", workspaceRoot: ws });
  const taskId = created.value.taskId;
  await p.callAs(p.mainA, "mentor_plan_submit", {
    taskId,
    criteria: [{ id: "c1", text: "检查 a.txt" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [] }],
  });
  const planJob = p.dispose.store.findSession("session-shift-A").get().reviewJobs[0];
  const rev = p.sessions.get(planJob.sessionId);
  await p.callAs(rev, "mentor_task_status", { taskId });
  await p.callAs(rev, "mentor_review_apply", {
    taskId, reviewJobId: planJob.id, kind: "plan", planVersion: 1, stageId: "__plan__", verdict: "pass",
    checks: [{ source: "plan", criterion: "检查 a.txt", criterionIds: ["c1"], observation: "ok", status: "passed" }],
  });
  assert.equal(p.dispose.store.findSession("session-shift-A").get().phase, "active");

  // 归档
  const cleared = await p.callAs(p.mainA, "mentor_task_clear", { taskId, reason: "误触归档" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.phase, "archived");
  assert.equal(cleared.value.preArchivePhase, "active");
  assert.ok(cleared.value.archivedUndoUntil > Date.now());

  // 人工 /mentor restore 恢复到 active
  const restored = await p.slash(p.mainA, "restore");
  assert.equal(restored.kind, "success", JSON.stringify(restored));
  const afterRestore = p.dispose.store.findSession("session-shift-A").get();
  assert.equal(afterRestore.phase, "active");
  assert.equal(afterRestore.archivedAt, null);
  assert.equal(afterRestore.preArchivePhase, null);
});

test("V04-H4 跨会话接管：原子迁移到新会话目录、清空旧会话、防冲突、幂等且磁盘重载一致", async (t) => {
  const { root, ws } = await tempRoot(t);
  const p = await startPlugin(t, root, ws);

  const created = await p.callAs(p.mainA, "mentor_task_create", { objective: "跨会话接班测试", workspaceRoot: ws });
  const taskId = created.value.taskId;
  await p.callAs(p.mainA, "mentor_plan_submit", {
    taskId,
    criteria: [{ id: "c1", text: "检查 a.txt" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [] }],
  });
  const planJob = p.dispose.store.findSession("session-shift-A").get().reviewJobs[0];
  const rev = p.sessions.get(planJob.sessionId);
  await p.callAs(rev, "mentor_task_status", { taskId });
  await p.callAs(rev, "mentor_review_apply", {
    taskId, reviewJobId: planJob.id, kind: "plan", planVersion: 1, stageId: "__plan__", verdict: "pass",
    checks: [{ source: "plan", criterion: "检查 a.txt", criterionIds: ["c1"], observation: "ok", status: "passed" }],
  });

  // 1) 在旧会话生成交接简报（/mentor handoff 与 mentor_task_status({handoff:true}) 均可）
  const handoffSlash = await p.slash(p.mainA, "handoff");
  assert.equal(handoffSlash.kind, "success");
  assert.match(handoffSlash.text, new RegExp(`/mentor takeover ${taskId}`));
  const handoffTool = await p.callAs(p.mainA, "mentor_task_status", { taskId, handoff: true });
  assert.equal(handoffTool.ok, true);
  assert.equal(handoffTool.value.handoffOnly, true);
  assert.equal(handoffTool.value.handoff.taskId, taskId);

  // 2) 新会话 B 执行 /mentor takeover <taskId>
  const taken = await p.slash(p.mainB, `takeover ${taskId} 新会话接班`);
  assert.equal(taken.kind, "success", JSON.stringify(taken));
  assert.equal(p.dispose.store.findSession("session-shift-A"), undefined, "旧会话指针必须已清空，杜绝双主脑裂");
  const migrated = p.dispose.store.findSession("session-shift-B")?.get();
  assert.ok(migrated);
  assert.equal(migrated.id, taskId);
  assert.equal(migrated.mainSessionId, "session-shift-B");
  assert.equal(migrated.ownershipGeneration, 1);
  assert.equal(migrated.sessionHistory.length, 1);
  assert.equal(migrated.sessionHistory[0].fromSessionId, "session-shift-A");
  assert.equal(migrated.sessionHistory[0].toSessionId, "session-shift-B");

  // 3) 重复接管幂等（ownershipGeneration 与 sessionHistory 不增长）
  const dup = await p.slash(p.mainB, `takeover ${taskId}`);
  assert.equal(dup.kind, "success");
  assert.equal(p.dispose.store.findSession("session-shift-B")?.get()?.ownershipGeneration, 1);
  assert.equal(p.dispose.store.findSession("session-shift-B")?.get()?.sessionHistory.length, 1);

  // 4) 若会话 A 建了另一个活跃任务，会话 B 不能被覆盖接管
  const other = await p.callAs(p.mainA, "mentor_task_create", { objective: "另一个活跃任务", workspaceRoot: ws });
  const conflict = await p.slash(p.mainB, `takeover ${other.value.taskId}`);
  assert.equal(conflict.kind, "error");
  assert.match(conflict.text, /目标会话已有进行中的任务/);

  // 5) 磁盘重载一致性验证
  await p.dispose.store.drain();
  const reloaded = await createSessionStores(createStore, { stateDir: root });
  const loadedB = reloaded.findSession("session-shift-B")?.get();
  assert.equal(loadedB?.id, taskId);
  assert.equal(loadedB?.mainSessionId, "session-shift-B");
  assert.equal(loadedB?.ownershipGeneration, 1);
});
