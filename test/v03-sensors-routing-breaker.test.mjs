/**
 * v0.3 · 三大高杠杆升级测试套件：
 *   1. 前置确定性硬检查门禁（Deterministic Pre-Review Gate）
 *   2. 审查/执行分模型路由（Heterogeneous Model Routing）
 *   3. 阶段返工熔断 + 升级简报 + UI 呈现（Rework Circuit Breaker）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, runtimeReviewPrompt } from "../lib/index.js";
import { validatePlan } from "../src/plan/dag.js";
import { computeNextStep } from "../src/state/guard.js";
import { resolvePrecheckCwd, runStagePrechecks } from "../src/runtime/prechecks.js";
import { normalizeModelRoute, resolveAgentOptions, summarizeModelRoute } from "../src/runtime/model-routing.js";

const MAIN = "session-v03-main";
const deferred = () => Promise.withResolvers();

async function tempWs(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mentor-v03-"));
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(ws, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  return { root, ws };
}

async function startV03Plugin(t, config = {}, files = { "out.txt": "ok\n" }) {
  const { root, ws } = await tempWs(t, files);
  const tools = new Map();
  const sessions = new Map();
  const spawned = [];
  const mainEvents = [];

  const main = {
    session: { id: MAIN, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => mainEvents },
    options: { provider: "main-provider", model: "main-model", reasoningEffort: "low" },
    status: "idle",
    followup: async () => {},
    whenIdle: async () => {},
  };
  sessions.set(MAIN, { agent: main, events: mainEvents, idle: null });

  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => { tools.delete(tool.name); };
      },
    },
    agents: {
      async create({ sessionId, agentOptions, setup }) {
        const idle = deferred();
        const events = [];
        const agent = {
          session: { id: sessionId, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => events },
          options: agentOptions,
          status: "running",
          followup: async () => {},
          whenIdle: () => idle.promise,
        };
        const child = {
          tools: {
            view: () => ({ restrictableNames: new Set(["read", "write", "edit", "glob", "grep"]), visible: new Set() }),
            restrict() {},
            register() {},
          },
        };
        sessions.set(sessionId, { agent, events, idle });
        spawned.push({ sessionId, agentOptions });
        if (typeof setup === "function") await setup(child, agent);
        return { agent, async dispose() { idle.resolve(); } };
      },
      get(sessionId) { return sessions.get(sessionId)?.agent ?? null; },
    },
  };

  const dispose = await apply(ctx, {
    stateDir: root,
    autoWakeMain: false,
    disposeTimeoutMs: 500,
    ...config,
  });
  t.after(async () => {
    await dispose();
    await new Promise((r) => setTimeout(r, 20));
  });

  const callAs = async (agent, name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, "工具未注册：" + name);
    return JSON.parse(await tool.execute(args, { agent }));
  };
  const call = (name, args) => callAs(main, name, args);
  const task = () => dispose.store.findSession(MAIN)?.get() ?? null;
  const agentOf = (sid) => sessions.get(sid)?.agent;

  return { root, ws, main, call, callAs, task, agentOf, spawned, sessions };
}

async function approvePlan(p, { criteria, stages }) {
  const created = await p.call("mentor_task_create", { objective: "v0.3 验证任务", workspaceRoot: p.ws });
  assert.equal(created.ok, true);
  const taskId = created.value.taskId;
  const sub = await p.call("mentor_plan_submit", { taskId, criteria, stages });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  const planJob = p.task().reviewJobs.findLast((j) => j.kind === "plan");
  const rev = p.agentOf(planJob.sessionId);
  await p.callAs(rev, "mentor_task_status", { taskId });
  const pass = await p.callAs(rev, "mentor_review_apply", {
    taskId, reviewJobId: planJob.id, kind: "plan", planVersion: 1, stageId: "__plan__", verdict: "pass",
    checks: criteria.map((c) => ({
      source: "plan", criterion: c.text, criterionIds: [c.id], observation: "ok", status: "passed",
    })),
  });
  assert.equal(pass.ok, true, JSON.stringify(pass));
  return taskId;
}

/* ================================================================== *
 * 1. 前置确定性硬检查门禁
 * ================================================================== */

test("V03-1a validatePlan 校验 stage.prechecks：合法放行，空命令/超限/非法 timeout 拒绝", () => {
  const valid = validatePlan({
    criteria: [{ id: "c1", text: "交付可运行" }],
    stages: [{
      id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [],
      prechecks: ["node --check out.js", { id: "t1", label: "单测", command: "node --test", cwd: ".", timeoutMs: 5000 }],
    }],
  });
  assert.equal(valid.ok, true);

  const bad = validatePlan({
    criteria: [{ id: "c1", text: "交付可运行" }],
    stages: [{
      id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [],
      prechecks: ["   ", { command: "echo hi", timeoutMs: 50 }],
    }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);

  const tooMany = validatePlan({
    criteria: [{ id: "c1", text: "交付可运行" }],
    stages: [{
      id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [],
      prechecks: Array.from({ length: 9 }, (_, i) => `echo ${i}`),
    }],
  });
  assert.equal(tooMany.ok, false);
});

test("V03-1b resolvePrecheckCwd 严格拦截 workspaceRoot 路径逃逸", async (t) => {
  const { ws } = await tempWs(t);
  await mkdir(path.join(ws, "sub", "dir"), { recursive: true });
  assert.equal(resolvePrecheckCwd(ws, ".").ok, true);
  assert.equal(resolvePrecheckCwd(ws, "sub/dir").ok, true);
  assert.equal(resolvePrecheckCwd(ws, "../outside").ok, false);
  assert.equal(resolvePrecheckCwd(ws, path.resolve(ws, "..")).ok, false);
});

test("V03-1c 真实子进程运行 prechecks：失败返回退出码与输出尾部，通过返回 ok=true", async (t) => {
  const { ws } = await tempWs(t);
  const nodeBin = JSON.stringify(process.execPath);
  const res = await runStagePrechecks({
    workspaceRoot: ws,
    prechecks: [
      { id: "ok1", label: "语法通过", command: `${nodeBin} -e "console.log('green')"` },
      { id: "fail1", label: "断言失败", command: `${nodeBin} -e "console.error('boom-detail'); process.exit(2)"` },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.total, 2);
  assert.equal(res.passed, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.results[0].ok, true);
  assert.match(res.results[0].stdoutTail, /green/);
  assert.equal(res.results[1].ok, false);
  assert.equal(res.results[1].exitCode, 2);
  assert.match(res.results[1].stderrTail, /boom-detail/);
});

test("V03-1d 前置硬检查失败拦截 mentor_stage_report（零消耗审查会话）；修好后放行并将摘要注入审查提示", async (t) => {
  let passCheck = false;
  const p = await startV03Plugin(t, {
    precheckRunner: async ({ command }) => (passCheck
      ? { ok: true, exitCode: 0, durationMs: 12, stdout: "all pass", stderr: "" }
      : { ok: false, exitCode: 1, durationMs: 18, stdout: "", stderr: "SyntaxError: bad token" }),
  });
  const taskId = await approvePlan(p, {
    criteria: [{ id: "c1", text: "文件语法正确" }],
    stages: [{
      id: "s1", title: "写文件", criterionIds: ["c1"], dependsOn: [],
      prechecks: [{ id: "chk", label: "语法检查", command: "node --check out.txt" }],
    }],
  });

  const start = await p.call("mentor_node_start", { taskId, stageId: "s1" });
  const spawnedBefore = p.spawned.length;

  // 1) 硬检查失败 → E_PRECHECK_FAILED，绝不启动独立审查，阶段停留在非 reported
  const blocked = await p.call("mentor_stage_report", {
    taskId, stageId: "s1", planVersion: 1, attemptRef: start.value.attemptRef,
    evidence: "已修改 out.txt", evidenceRefs: [{ file: "out.txt", scope: "file" }],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "E_PRECHECK_FAILED");
  assert.equal(blocked.details.recovery, "correct-input");
  assert.equal(blocked.details.precheck.failed, 1);
  assert.match(blocked.details.precheck.results[0].stderrTail, /SyntaxError/);
  assert.equal(p.spawned.length, spawnedBefore, "硬检查失败绝不能启动独立审查子会话");
  assert.notEqual(p.task().nodeRuns.find((r) => r.stageId === "s1")?.status, "reported");
  assert.equal(p.task().lastPrechecks.s1.ok, false);

  // 2) 修复后再次上报 → 硬检查全绿，正常启动独立审查，且审查提示含前置硬检查摘要
  passCheck = true;
  const reported = await p.call("mentor_stage_report", {
    taskId, stageId: "s1", planVersion: 1, attemptRef: start.value.attemptRef,
    evidence: "已修复语法问题", evidenceRefs: [{ file: "out.txt", scope: "file" }],
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  assert.equal(reported.value.precheck.ok, true);
  assert.equal(reported.value.reviewQueued, true);
  assert.equal(p.spawned.length, spawnedBefore + 1);
  const stageJob = p.task().reviewJobs.findLast((j) => j.kind === "stage");
  const prompt = runtimeReviewPrompt(p.task(), stageJob);
  assert.match(prompt, /前置确定性硬检查已通过（1\/1/);
});

/* ================================================================== *
 * 2. 审查/执行分模型路由
 * ================================================================== */

test("V03-2a normalizeModelRoute 与 resolveAgentOptions 支持简写、对象、按审查类型覆盖与回落", () => {
  const main = { options: { provider: "deepseek", model: "deepseek-chat", temperature: 0.2 } };

  assert.deepEqual(normalizeModelRoute("openai/gpt-6.2"), { provider: "openai", model: "gpt-6.2" });
  assert.deepEqual(normalizeModelRoute("deepseek-reasoner"), { model: "deepseek-reasoner" });

  // 仅指定 model 时继承 main.provider
  const sameProv = resolveAgentOptions(main, "deepseek-reasoner");
  assert.equal(sameProv.provider, "deepseek");
  assert.equal(sameProv.model, "deepseek-reasoner");
  assert.equal(sameProv.temperature, 0.2);

  // 跨家族模型 + byKind 细化
  const route = {
    provider: "openai",
    model: "gpt-6.2",
    reasoningEffort: "high",
    byKind: { plan: { model: "gpt-6.2-architect" } },
  };
  const planOpts = resolveAgentOptions(main, route, { kind: "plan" });
  assert.equal(planOpts.provider, "openai");
  assert.equal(planOpts.model, "gpt-6.2-architect");
  assert.equal(planOpts.reasoningEffort, "high");
  assert.equal(summarizeModelRoute(planOpts, main).inherited, false);

  const stageOpts = resolveAgentOptions(main, route, { kind: "stage" });
  assert.equal(stageOpts.model, "gpt-6.2");

  // 无主模型且路由缺 provider 时返回 null
  assert.equal(resolveAgentOptions({ options: {} }, "model-only"), null);
  // 无主模型但路由完整给出 provider/model 时仍可工作
  assert.deepEqual(resolveAgentOptions({ options: {} }, "openai/gpt-6.2"), { provider: "openai", model: "gpt-6.2" });
});

test("V03-2b 真实插件运行时：plan 审查、stage 审查、worker 分别拿到各自路由的模型", async (t) => {
  const p = await startV03Plugin(t, {
    reviewerModel: {
      provider: "openai",
      model: "gpt-6.2",
      reasoningEffort: "high",
      byKind: { plan: { model: "gpt-6.2-plan" } },
    },
    workerModel: "deepseek-official/deepseek-flash",
  });
  const taskId = await approvePlan(p, {
    criteria: [{ id: "c1", text: "交付验证" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [], writePaths: ["out.txt"] }],
  });

  // 1) plan 审查应走 byKind.plan
  const planSpawn = p.spawned[0];
  assert.equal(planSpawn.agentOptions.provider, "openai");
  assert.equal(planSpawn.agentOptions.model, "gpt-6.2-plan");
  assert.equal(planSpawn.agentOptions.reasoningEffort, "high");
  assert.equal(p.task().reviewJobs[0].modelRoute.model, "gpt-6.2-plan");
  assert.equal(p.task().reviewJobs[0].modelRoute.inherited, false);

  // 2) stage 审查应走默认 reviewerModel
  const start = await p.call("mentor_node_start", { taskId, stageId: "s1" });
  await p.call("mentor_stage_report", {
    taskId, stageId: "s1", planVersion: 1, attemptRef: start.value.attemptRef,
    evidence: "已写好 out.txt", evidenceRefs: [{ file: "out.txt", scope: "file" }],
  });
  const stageSpawn = p.spawned.at(-1);
  assert.equal(stageSpawn.agentOptions.provider, "openai");
  assert.equal(stageSpawn.agentOptions.model, "gpt-6.2");
  assert.equal(p.task().reviewJobs.at(-1).modelRoute.model, "gpt-6.2");
});

/* ================================================================== *
 * 3. 阶段返工熔断 + 升级简报 + Resume 重置窗口
 * ================================================================== */

test("V03-3a 同一阶段连续 revise 达到 maxStageReworks 自动熔断暂停并生成升级简报；人工 resume 后重置计数窗口", async (t) => {
  const p = await startV03Plugin(t, { maxStageReworks: 2 });
  const taskId = await approvePlan(p, {
    criteria: [{ id: "c1", text: "交付验证" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [] }],
  });

  async function reportAndRevise(round) {
    const start = await p.call("mentor_node_start", { taskId, stageId: "s1" });
    assert.equal(start.ok, true, "round " + round + " node_start: " + JSON.stringify(start));
    const rep = await p.call("mentor_stage_report", {
      taskId, stageId: "s1", planVersion: 1, attemptRef: start.value.attemptRef,
      evidence: `第 ${round} 轮证据`, evidenceRefs: [{ file: "out.txt", scope: "file" }],
    });
    assert.equal(rep.ok, true, "round " + round + " report: " + JSON.stringify(rep));
    const job = p.task().reviewJobs.findLast((j) => j.kind === "stage" && j.stageId === "s1");
    const rev = p.agentOf(job.sessionId);
    await p.callAs(rev, "mentor_task_status", { taskId });
    return p.callAs(rev, "mentor_review_apply", {
      taskId, reviewJobId: job.id, kind: "stage", planVersion: 1, stageId: "s1", attempt: job.attempt,
      verdict: "revise",
      findings: [{ severity: "blocking", text: `第 ${round} 轮缺关键验证` }],
    });
  }

  // 第 1 次打回：未达上限（1 < 2），保持 active
  const r1 = await reportAndRevise(1);
  assert.equal(r1.ok, true);
  assert.equal(r1.value.phase, "active");
  assert.equal(r1.value.circuitBreakerTripped, undefined);

  // 响应第 1 条 finding 才能再次上报
  const f1 = p.task().findings.at(-1);
  await p.call("mentor_finding_respond", { taskId, findingId: f1.id, summary: "已补" });

  // 第 2 次打回：达到上限（2 >= 2），自动熔断暂停 + 生成升级简报
  const r2 = await reportAndRevise(2);
  assert.equal(r2.ok, true);
  assert.equal(r2.value.phase, "paused");
  assert.equal(r2.value.circuitBreakerTripped, true);
  assert.equal(r2.value.escalationBrief.kind, "rework-circuit-breaker");
  assert.equal(r2.value.escalationBrief.reviseCount, 2);
  assert.equal(r2.value.escalationBrief.limit, 2);
  assert.ok(r2.value.escalationBrief.recentFindings.length >= 1);
  assert.equal(p.task().phase, "paused");
  assert.equal(computeNextStep(p.task()).code, "REWORK_CIRCUIT_BREAKER");

  // 熔断暂停期不能继续上报
  const blockedWhilePaused = await p.call("mentor_node_start", { taskId, stageId: "s1" });
  assert.equal(blockedWhilePaused.ok, false);

  // 人工恢复后：熔断计数窗口重置，允许继续推进，下一次打回（新窗口第 1 次）不会立刻再熔断
  const resumed = await p.call("mentor_task_resume", { taskId });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.value.phase, "active");
  assert.equal(resumed.value.breakerResetStageId, "s1");
  assert.equal(p.task().continuation, null);

  const f2 = p.task().findings.at(-1);
  await p.call("mentor_finding_respond", { taskId, findingId: f2.id, summary: "按人工建议重做" });
  const r3 = await reportAndRevise(3);
  assert.equal(r3.ok, true);
  assert.equal(r3.value.phase, "active", "resume 后重置窗口，新窗口第 1 次打回不应立刻再熔断");
});

test("V03-3b maxStageReworks=0 时关闭熔断，连续多次 revise 不暂停", async (t) => {
  const p = await startV03Plugin(t, { maxStageReworks: 0 });
  const taskId = await approvePlan(p, {
    criteria: [{ id: "c1", text: "交付验证" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [] }],
  });
  for (let round = 1; round <= 4; round += 1) {
    const start = await p.call("mentor_node_start", { taskId, stageId: "s1" });
    await p.call("mentor_stage_report", {
      taskId, stageId: "s1", planVersion: 1, attemptRef: start.value.attemptRef,
      evidence: `r${round}`, evidenceRefs: [{ file: "out.txt", scope: "file" }],
    });
    const job = p.task().reviewJobs.findLast((j) => j.kind === "stage");
    const rev = p.agentOf(job.sessionId);
    await p.callAs(rev, "mentor_task_status", { taskId });
    const res = await p.callAs(rev, "mentor_review_apply", {
      taskId, reviewJobId: job.id, kind: "stage", planVersion: 1, stageId: "s1", attempt: job.attempt,
      verdict: "revise", findings: [{ severity: "blocking", text: `issue-${round}` }],
    });
    assert.equal(res.value.phase, "active");
    const f = p.task().findings.at(-1);
    await p.call("mentor_finding_respond", { taskId, findingId: f.id, summary: "fix" });
  }
});
