/**
 * Round 5a · 全链路协议端到端（隔离）
 *
 * 约束（硬性）：
 *   1. 所有调用都必须经过 `apply()` 真正注册的工具，走 `tool.execute()` 的完整
 *      协议（identity / phase 门禁 / 快照预算 / readCoverage / 审查策略 / 持久化），
 *      **不得**绕过 execute 直调 HANDLERS。
 *   2. 宿主用最小假件：tools.register / agents.create+get / effect。审查子会话的
 *      `mentor_evidence_read` 由插件在 setup 里注册，本文件从假 child 工具表取回它
 *      再 execute —— 这也是真实链路。
 *   3. 全部数据落在 os.tmpdir()，t.after 清理；不触碰 ~/.dsh 或 clean-room。
 *
 * 覆盖：
 *   场景 1  建任务 → 计划审查 revise → 响应 + 计划修订 → 计划 pass →
 *           主会话 node_start + 宿主 write 回执自动绑定（不传 receiptCallIds）→
 *           阶段审查（evidence byteSize/textSha256 + readCoverage）pass →
 *           单节点 awaiting-integration 缺 integrationEvidence 被拒 → 补齐后 pass →
 *           整体验收 pass → dispose → 同目录 createStore 重载一致。
 *   场景 2a 审查会话出现越界工具（bash / pwsh）→ E_REVIEW_POLICY。
 *   场景 2b 大报告被默认快照截断 → E_REVIEW_UNREAD + needRead → 分片补读 → pass。
 *   场景 2c 模型侧无 mentor_finding_close；人工 dispatchCommand 带理由可关闭。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, createStore, TOOL_NAMES } from "../lib/index.js";
import { dispatchCommand } from "../src/rpc/command.js";

const MAIN = "session-r5a-main";
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const deferred = () => Promise.withResolvers();
/** 让子会话收尾产生的异步写盘落到磁盘，再交给 t.after 清理临时目录。 */
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mentor-e2e-r5a-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

/**
 * 起一个隔离的插件实例：真 apply()、真工具表、假宿主。
 * 审查子会话的 idle 由 handle.dispose() 兑现 —— 与真实宿主「dispose 后子会话结束」同形。
 */
async function startPlugin(t, { files = {} } = {}) {
  const root = await tempRoot(t);
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  for (const name of Object.keys(files)) {
    await writeFile(path.join(ws, name), files[name], "utf8");
  }

  const tools = new Map();
  const sessions = new Map(); // sessionId -> { agent, events, idle, disposals }
  const reviewerTools = new Map(); // sessionId -> 插件在该审查会话里注册的工具
  const mainEvents = [];
  const effects = [];

  const main = {
    session: { id: MAIN, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => mainEvents },
    options: { provider: "fixture", model: "fixture" },
    status: "idle",
    followup: async () => {},
    whenIdle: async () => {},
  };
  sessions.set(MAIN, { agent: main, events: mainEvents, idle: null, disposals: 0 });

  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => { tools.delete(tool.name); };
      },
    },
    effect(fn) { effects.push(fn()); },
    agents: {
      async create({ sessionId, setup }) {
        const idle = deferred();
        const events = [];
        const agent = {
          session: { id: sessionId, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => events },
          options: { provider: "fixture", model: "fixture" },
          status: "running",
          followup: async () => {},
          whenIdle: () => idle.promise,
        };
        const child = {
          tools: {
            view: () => ({ restrictableNames: new Set(), visible: new Set() }),
            restrict() {},
            register(tool) { reviewerTools.set(sessionId, tool); },
          },
        };
        const record = { agent, events, idle, disposals: 0 };
        sessions.set(sessionId, record);
        if (typeof setup === "function") setup(child, agent);
        return {
          agent,
          async dispose() {
            record.disposals += 1;
            idle.resolve();
          },
        };
      },
      get(sessionId) { return sessions.get(sessionId)?.agent ?? null; },
    },
  };

  const dispose = await apply(ctx, { stateDir: root, autoWakeMain: false, disposeTimeoutMs: 1000 });
  const registry = dispose.store;

  function scoped() {
    return registry.findSession(MAIN) ?? null;
  }
  function task() {
    const store = scoped();
    return store ? store.get() : null;
  }
  async function callAs(agent, name, args = {}) {
    const tool = tools.get(name);
    assert.ok(tool, "工具未注册：" + name);
    const raw = await tool.execute(args, { agent });
    assert.equal(typeof raw, "string", name + ".execute 必须返回 JSON 字符串");
    return JSON.parse(raw);
  }
  const call = (name, args) => callAs(main, name, args);
  function agentOf(sessionId) {
    const record = sessions.get(sessionId);
    assert.ok(record, "审查会话未创建：" + sessionId);
    return record.agent;
  }
  function eventsFor(sessionId) {
    const record = sessions.get(sessionId);
    assert.ok(record, "审查会话未创建：" + sessionId);
    return record.events;
  }
  function latestJob(predicate) {
    const job = (task()?.reviewJobs ?? []).findLast(predicate);
    assert.ok(job, "应存在匹配的审查作业");
    return job;
  }
  async function evidenceRead(sessionId, args) {
    const tool = reviewerTools.get(sessionId);
    assert.equal(tool?.name, "mentor_evidence_read", "该审查会话应持有 mentor_evidence_read");
    return JSON.parse(await tool.execute(args, { agent: agentOf(sessionId) }));
  }

  return {
    root, ws, ctx, tools, registry, dispose, main, mainEvents, effects,
    call, callAs, task, scoped, agentOf, eventsFor, latestJob, evidenceRead,
  };
}

/** 建任务 + 提交计划；断言计划审查真的派发出去了。 */
async function submitPlan(plugin, { objective, criteria, stages }) {
  const created = await plugin.call("mentor_task_create", { objective, workspaceRoot: plugin.ws });
  assert.equal(created.ok, true, "create 失败：" + JSON.stringify(created));
  const submitted = await plugin.call("mentor_plan_submit", {
    taskId: created.value.taskId, criteria, stages,
  });
  assert.equal(submitted.ok, true, "plan_submit 失败：" + JSON.stringify(submitted));
  assert.equal(submitted.value.reviewQueued, true, "提交计划后必须真的派发独立审查");
  assert.equal(submitted.value.phase, "planning", "计划审查期间 phase 停在 planning");
  return { taskId: created.value.taskId, created, submitted };
}

/** 让当前这一版计划审查读快照并判 pass（checks 覆盖全部 criteria）。 */
async function passPlan(plugin, { taskId, planVersion, criteria, markedResolved = [] }) {
  const job = plugin.latestJob((j) => j.kind === "plan" && j.planVersion === planVersion);
  assert.equal(job.status, "running", "计划审查作业应处于 running");
  const reviewer = plugin.agentOf(job.sessionId);
  const read = await plugin.callAs(reviewer, "mentor_task_status", { taskId });
  assert.equal(read.ok, true, "计划审查读状态失败：" + JSON.stringify(read));
  const coverage = plugin.task().reviewJobs.find((j) => j.id === job.id).readCoverage;
  assert.equal(coverage?.complete, true, "计划审查读快照后 readCoverage 应为 complete");
  const applied = await plugin.callAs(reviewer, "mentor_review_apply", {
    taskId, reviewJobId: job.id, kind: "plan", planVersion, stageId: "__plan__", verdict: "pass",
    markedResolved,
    checks: criteria.map((c) => ({
      source: "mentor_task_status 快照",
      criterion: c.text,
      criterionIds: [c.id],
      observation: "计划条目、依赖与验收项均已登记",
      status: "passed",
    })),
  });
  assert.equal(applied.ok, true, "计划 pass 失败：" + JSON.stringify(applied));
  return { job, applied };
}

const CRITERIA = [
  { id: "c1", text: "宿主 write 回执已自动绑定", observe: { tool: "write", outcome: "success", target: "out.txt" } },
  { id: "c2", text: "交付文件可核对" },
  { id: "c3", text: "集成结果可核对" },
];
const STAGES = [
  { id: "s1", title: "自执行交付", criterionIds: ["c1", "c2"], dependsOn: [] },
  { id: "s2", title: "依赖集成", criterionIds: ["c3"], dependsOn: ["s1"] },
];

/* ================================================================== *
 * 场景 1：完整多阶段生命周期 + 自动回执 + readCoverage + 磁盘重载
 * ================================================================== */

test("场景 1：多阶段生命周期 · 自动回执 · 累计 readCoverage · 磁盘重载一致", async (t) => {
  const plugin = await startPlugin(t, { files: { "out.txt": "交付内容 v1\n第二行：集成核对用\n" } });
  try {
    const { taskId } = await submitPlan(plugin, {
      objective: "R5a 生命周期端到端",
      criteria: CRITERIA,
      stages: STAGES,
    });

    /* ---- 计划审查 1：读快照 → revise ---- */
    const planJob1 = plugin.latestJob((j) => j.kind === "plan" && j.planVersion === 1);
    const planReviewer1 = plugin.agentOf(planJob1.sessionId);
    const planRead1 = await plugin.callAs(planReviewer1, "mentor_task_status", { taskId });
    assert.equal(planRead1.ok, true, "计划审查读状态失败：" + JSON.stringify(planRead1));
    assert.equal(planRead1.value.taskId, taskId);
    assert.ok(planRead1.value.snapshotBytes > 0 && planRead1.value.snapshotBytes <= 24576,
      "默认快照必须落在 24KB 预算内，实际 " + planRead1.value.snapshotBytes);

    const planRevise = await plugin.callAs(planReviewer1, "mentor_review_apply", {
      taskId, reviewJobId: planJob1.id, kind: "plan", planVersion: 1, stageId: "__plan__",
      verdict: "revise",
      findings: [{ severity: "blocking", text: "G1 计划缺少回滚步骤" }],
    });
    assert.equal(planRevise.ok, true, "计划 revise 失败：" + JSON.stringify(planRevise));
    assert.equal(planRevise.value.phase, "planning");

    const planFinding = plugin.task().findings.find((f) => f.reviewId === planRevise.value.reviewId);
    assert.ok(planFinding, "revise 必须落一条 blocking finding");
    assert.equal(planFinding.status, "open");

    /* ---- 主会话响应 + 修订计划 ---- */
    const responded = await plugin.call("mentor_finding_respond", {
      taskId, findingId: planFinding.id, summary: "已补回滚步骤与触发条件", evidenceIds: [],
    });
    assert.equal(responded.ok, true, "finding_respond 失败：" + JSON.stringify(responded));
    assert.equal(responded.value.findingStatus, "responded");

    const amended = await plugin.call("mentor_plan_submit", {
      taskId, criteria: CRITERIA, stages: STAGES,
    });
    assert.equal(amended.ok, true, "plan_submit v2 失败：" + JSON.stringify(amended));
    assert.equal(amended.value.planVersion, 2);
    assert.equal(amended.value.phase, "planning");
    assert.equal(amended.value.reviewQueued, true, "修订后的计划必须重新过审");

    /* ---- 计划审查 2：pass（关闭 G1） ---- */
    const planPass = await passPlan(plugin, {
      taskId, planVersion: 2, criteria: CRITERIA, markedResolved: [planFinding.id],
    });
    assert.equal(planPass.applied.value.phase, "active");
    assert.equal(plugin.task().approvedPlanVersion, 2, "计划 pass 后必须批准当前版本");

    /* ---- s1：主会话自执行，回执自动绑定（不传 receiptCallIds） ---- */
    const nodeStart1 = await plugin.call("mentor_node_start", { taskId, stageId: "s1" });
    assert.equal(nodeStart1.ok, true, "node_start 失败：" + JSON.stringify(nodeStart1));
    const at = nodeStart1.value.startedAt + 1;
    plugin.mainEvents.push(
      { type: "tool/call", seq: 1, time: at,
        data: { callId: "call_r5a_write", name: "write", arguments: JSON.stringify({ file_path: "out.txt", content: "x" }) } },
      { type: "tool/result", seq: 2, time: at + 1,
        data: { message: { isError: false, toolCallId: "call_r5a_write", content: [{ type: "text", text: "已写入 out.txt" }] } } },
    );

    const report1 = await plugin.call("mentor_stage_report", {
      taskId, stageId: "s1", planVersion: 2, attemptRef: nodeStart1.value.attemptRef,
      evidence: "主会话自执行 write 写入 out.txt；未显式传 receiptCallIds，回执由宿主事件自动绑定。",
      evidenceRefs: [{ file: "out.txt", scope: "file" }],
      summary: "s1 自执行交付",
    });
    assert.equal(report1.ok, true, "s1 stage_report 失败：" + JSON.stringify(report1));
    assert.ok(report1.value.reportId, "上报应返回 reportId");

    const savedReport1 = plugin.task().nodeRuns.find((r) => r.stageId === "s1").reports.at(-1);
    assert.equal(savedReport1.id, report1.value.reportId);
    assert.ok(savedReport1.bindings.some((b) => b.criterionId === "c1" && b.receipt?.callId === "call_r5a_write"),
      "receiptCallIds 缺省时必须自动绑定宿主回执");

    /* ---- s1 阶段审查：evidence_read + readCoverage → pass ---- */
    const stageJob1 = plugin.latestJob((j) => j.kind === "stage" && j.stageId === "s1" && j.attempt === 1);
    assert.equal(stageJob1.planVersion, 2);
    const stageReviewer1 = plugin.agentOf(stageJob1.sessionId);
    const stageRead1 = await plugin.callAs(stageReviewer1, "mentor_task_status", { taskId });
    assert.equal(stageRead1.ok, true, "阶段审查读状态失败：" + JSON.stringify(stageRead1));
    const coverage1 = plugin.task().reviewJobs.find((j) => j.id === stageJob1.id).readCoverage;
    assert.equal(coverage1?.complete, true, "读完整快照后 readCoverage 应为 complete");
    assert.deepEqual(coverage1.coveredReportIds, [report1.value.reportId]);

    const echo = await plugin.evidenceRead(stageJob1.sessionId, { reportId: report1.value.reportId, file: "out.txt" });
    const diskText = await readFile(path.join(plugin.ws, "out.txt"), "utf8");
    assert.equal(echo.byteSize, Buffer.byteLength(diskText, "utf8"), "byteSize 必须是精确 UTF-8 字节数");
    assert.equal(echo.textSha256, sha256(diskText), "textSha256 必须对应上报版本的文件内容");
    assert.equal(echo.totalLines, diskText.split(/\r?\n/u).length);
    assert.ok(Array.isArray(echo.excerpt) && echo.excerpt.length > 0, "evidence_read 必须返回带行号的原文");

    const stagePass1 = await plugin.callAs(stageReviewer1, "mentor_review_apply", {
      taskId, reviewJobId: stageJob1.id, kind: "stage", planVersion: 2, stageId: "s1", verdict: "pass",
      checks: [
        { source: "mentor_task_status 快照 + 报告 bindings", criterion: "宿主 write 回执已自动绑定",
          criterionIds: ["c1"], observation: "bindings 含 callId=call_r5a_write 的 write 成功回执", status: "passed" },
        { source: "mentor_evidence_read out.txt", criterion: "交付文件可核对",
          criterionIds: ["c2"], observation: "byteSize=" + echo.byteSize + "; textSha256=" + echo.textSha256, status: "passed" },
      ],
    });
    assert.equal(stagePass1.ok, true, "s1 pass 失败：" + JSON.stringify(stagePass1));
    const storedReview = plugin.task().reviews.find((r) => r.id === stagePass1.value.reviewId);
    assert.equal(storedReview.scope.kind, "stage");
    assert.equal(storedReview.scope.planVersion, 2, "review.scope.planVersion 必须正确落盘");
    assert.equal(storedReview.scope.stageId, "s1");
    assert.equal(storedReview.scope.attempt, 1);

    /* ---- s2：模拟单节点派工回来，等待集成 ---- */
    const nodeStart2 = await plugin.call("mentor_node_start", { taskId, stageId: "s2" });
    assert.equal(nodeStart2.ok, true, "s2 node_start 失败：" + JSON.stringify(nodeStart2));
    const simAt = Date.now();
    const beforeSim = plugin.task();
    plugin.scoped().set({
      ...beforeSim,
      revision: beforeSim.revision + 1,
      updatedAt: simAt,
      nodeRuns: beforeSim.nodeRuns.map((run) => run.stageId === "s2"
        ? { ...run, status: "awaiting-integration", batchId: "batch_r5a_s2", startedAt: simAt, startedAttempt: 1 }
        : run),
      delegations: [...(beforeSim.delegations ?? []), {
        batchId: "batch_r5a_s2", planVersion: 2, stageIds: ["s2"], maxParallel: 1,
        at: simAt, status: "running",
        dispatchPlan: [{ stageId: "s2", attempt: 1, attemptRef: nodeStart2.value.attemptRef, writePaths: [] }],
      }],
    });

    const missingIntegration = await plugin.call("mentor_stage_report", {
      taskId, stageId: "s2", planVersion: 2, attemptRef: nodeStart2.value.attemptRef,
      evidence: "已核对助手交付并集成，待补充集成结论。",
      evidenceRefs: [{ file: "out.txt", scope: "file" }],
    });
    assert.equal(missingIntegration.ok, false, "缺 integrationEvidence 必须被拒");
    assert.equal(missingIntegration.code, "E_EVIDENCE_REQUIRED");
    assert.ok(missingIntegration.details?.nextStep, "拒绝必须带 nextStep");
    assert.ok(Array.isArray(missingIntegration.details?.allowedActions), "拒绝必须带 allowedActions");

    const report2 = await plugin.call("mentor_stage_report", {
      taskId, stageId: "s2", planVersion: 2, attemptRef: nodeStart2.value.attemptRef,
      evidence: "独立核对 out.txt 与 s1 的 write 回执后确认集成一致。",
      evidenceRefs: [{ file: "out.txt", scope: "file" }],
      integrationEvidence: "已逐项核对 out.txt 内容与 s1 回执，集成结果与计划一致。",
    });
    assert.equal(report2.ok, true, "s2 stage_report 失败：" + JSON.stringify(report2));

    const stageJob2 = plugin.latestJob((j) => j.kind === "stage" && j.stageId === "s2");
    const stageReviewer2 = plugin.agentOf(stageJob2.sessionId);
    const stageRead2 = await plugin.callAs(stageReviewer2, "mentor_task_status", { taskId });
    assert.equal(stageRead2.ok, true, "s2 审查读状态失败：" + JSON.stringify(stageRead2));
    const echo2 = await plugin.evidenceRead(stageJob2.sessionId, { reportId: report2.value.reportId, file: "out.txt" });
    assert.equal(echo2.textSha256, sha256(diskText));
    const stagePass2 = await plugin.callAs(stageReviewer2, "mentor_review_apply", {
      taskId, reviewJobId: stageJob2.id, kind: "stage", planVersion: 2, stageId: "s2", verdict: "pass",
      checks: [{ source: "阶段报告 + 集成核对", criterion: "集成结果可核对", criterionIds: ["c3"],
        observation: "integrationEvidence 与 out.txt 指纹一致", status: "passed" }],
    });
    assert.equal(stagePass2.ok, true, "s2 pass 失败：" + JSON.stringify(stagePass2));

    /* ---- 整体验收 ---- */
    const completion = await plugin.call("mentor_completion_request", {
      taskId, evidence: "两个阶段均已独立审查通过；out.txt 与 write 回执一致，无遗留问题。",
    });
    assert.equal(completion.ok, true, "completion_request 失败：" + JSON.stringify(completion));
    assert.equal(completion.value.queued, true, "整体验收必须派发独立审查");
    const completionJob = plugin.latestJob((j) => j.kind === "completion");
    assert.equal(completionJob.planVersion, 2);
    const completionReviewer = plugin.agentOf(completionJob.sessionId);
    const completionRead = await plugin.callAs(completionReviewer, "mentor_task_status", { taskId });
    assert.equal(completionRead.ok, true, "整体验收读状态失败：" + JSON.stringify(completionRead));
    const completionCoverage = plugin.task().reviewJobs.find((j) => j.id === completionJob.id).readCoverage;
    assert.equal(completionCoverage?.complete, true, "整体验收读快照后 readCoverage 应为 complete");
    assert.deepEqual(completionCoverage.coveredReportIds.slice().sort(),
      [report1.value.reportId, report2.value.reportId].sort());
    const completionPass = await plugin.callAs(completionReviewer, "mentor_review_apply", {
      taskId, reviewJobId: completionJob.id, kind: "completion", planVersion: 2,
      stageId: "__completion__", verdict: "pass",
      checks: CRITERIA.map((c) => ({
        source: "整体核对", criterion: c.text, criterionIds: [c.id],
        observation: "阶段报告、集成记录与回执一致", status: "passed",
      })),
    });
    assert.equal(completionPass.ok, true, "整体验收 pass 失败：" + JSON.stringify(completionPass));
    assert.equal(completionPass.value.phase, "completed");

    /* ---- 终态断言 ---- */
    const final = plugin.task();
    assert.equal(final.phase, "completed");
    assert.equal(final.reviewJobs.length, 5, "应恰有 5 次独立审查");
    assert.equal(final.reviewJobs.every((j) => j.status === "completed"), true);
    assert.equal(final.reviews.length, 5);
    assert.equal(final.reviews.every((r) => !r.selfReviewed), true, "全部裁决都必须是非自审");
    assert.ok(final.reviewJobs.every((j) => j.sessionId !== MAIN), "审查会话不能是主会话");
    assert.ok(final.reviewJobs.every((j) => j.sessionId.startsWith("mentor-review-")));
    assert.equal(final.reviews.filter((r) => r.verdict === "pass").length, 4);
    assert.equal(final.reviews.filter((r) => r.scope.planVersion === 2).length, 4,
      "修订后再无旧版本裁决");
    assert.equal(final.nodeRuns.every((r) => r.status === "accepted"), true);

    /* ---- dispose → 同目录重载 ---- */
    const sessionDir = path.join(plugin.root, "sessions",
      createHash("sha256").update(MAIN).digest("hex").slice(0, 32));
    const scoped = plugin.scoped();
    assert.ok(scoped, "任务 store 应存在");
    await plugin.dispose();
    // 子会话在 dispose 期间会回写 outputText/updatedAt：先让收尾写入进内存，再冲一次盘，
    // 这样「内存快照」和「磁盘快照」比的是同一时刻。
    await settle();
    await scoped.drain();
    const memory = scoped.get();
    const reopened = await createStore(sessionDir);
    assert.deepEqual(reopened.get(), memory, "重载后的磁盘状态必须与内存逐字段一致");
    assert.equal(reopened.get().phase, "completed");
    assert.equal(reopened.get().planVersion, 2);
    assert.deepEqual(reopened.get().reviews.map((r) => r.verdict), ["revise", "pass", "pass", "pass", "pass"]);
    assert.deepEqual(reopened.get().nodeRuns.map((r) => [r.stageId, r.status]),
      [["s1", "accepted"], ["s2", "accepted"]]);
    const persisted = reopened.get().reviews.find((r) => r.id === stagePass1.value.reviewId);
    assert.equal(persisted.scope.planVersion, 2, "重载后 review.scope.planVersion 仍在");
    assert.equal(reopened.get().findings.filter((f) => f.status !== "closed").length, 0);
  } finally {
    await plugin.dispose();
    await settle();
  }
});

/* ================================================================== *
 * 场景 2a：审查员越界工具 → E_REVIEW_POLICY
 * ================================================================== */

test("场景 2a：审查会话调用 bash / pwsh → mentor_review_apply 被 E_REVIEW_POLICY 拦截", async (t) => {
  const plugin = await startPlugin(t, { files: { "a.txt": "证据文件 A\n" } });
  try {
    const { taskId } = await submitPlan(plugin, {
      objective: "越界工具门禁",
      criteria: [{ id: "c1", text: "文件证据可核对" }],
      stages: [{ id: "s1", title: "交付", criterionIds: ["c1"], dependsOn: [] }],
    });
    await passPlan(plugin, { taskId, planVersion: 1, criteria: [{ id: "c1", text: "文件证据可核对" }] });

    const report = await plugin.call("mentor_stage_report", {
      taskId, stageId: "s1", planVersion: 1,
      evidence: "已交付 a.txt，可核对。", evidenceRefs: [{ file: "a.txt", scope: "file" }],
    });
    assert.equal(report.ok, true, "stage_report 失败：" + JSON.stringify(report));

    const checks = [{ source: "报告", criterion: "文件证据可核对", criterionIds: ["c1"],
      observation: "a.txt 已绑定", status: "passed" }];

    /* ---- bash ---- */
    const job1 = plugin.latestJob((j) => j.kind === "stage" && j.stageId === "s1");
    const reviewer1 = plugin.agentOf(job1.sessionId);
    plugin.eventsFor(job1.sessionId).push({
      type: "tool/call", seq: 1, time: Date.now(),
      data: { callId: "bad_bash", name: "bash", arguments: JSON.stringify({ command: "ls" }) },
    });
    const blocked1 = await plugin.callAs(reviewer1, "mentor_review_apply", {
      taskId, reviewJobId: job1.id, kind: "stage", planVersion: 1, stageId: "s1", verdict: "pass", checks,
    });
    assert.equal(blocked1.ok, false, "越界工具必须拦截");
    assert.equal(blocked1.code, "E_REVIEW_POLICY");
    assert.equal(blocked1.details?.reason, "reviewer-forbidden-tool:bash");
    assert.equal(plugin.task().reviewJobs.find((j) => j.id === job1.id).status, "failed");

    /* ---- pwsh（Windows 宿主的 shell 工具名） ---- */
    const retried = await plugin.call("mentor_review_retry", { taskId, reviewJobId: job1.id });
    assert.equal(retried.ok, true, "review_retry 失败：" + JSON.stringify(retried));
    const job2 = plugin.task().reviewJobs.find((j) => j.id === retried.value.reviewJobId);
    assert.ok(job2 && job2.id !== job1.id, "重试必须产生新的审查作业");
    const reviewer2 = plugin.agentOf(job2.sessionId);
    plugin.eventsFor(job2.sessionId).push({
      type: "tool/call", seq: 1, time: Date.now(),
      data: { callId: "bad_pwsh", name: "pwsh", arguments: JSON.stringify({ command: "dir" }) },
    });
    const blocked2 = await plugin.callAs(reviewer2, "mentor_review_apply", {
      taskId, reviewJobId: job2.id, kind: "stage", planVersion: 1, stageId: "s1", verdict: "pass", checks,
    });
    assert.equal(blocked2.ok, false, "pwsh 同样必须拦截");
    assert.equal(blocked2.code, "E_REVIEW_POLICY");
    assert.equal(blocked2.details?.reason, "reviewer-forbidden-tool:pwsh");
  } finally {
    await plugin.dispose();
    await settle();
  }
});

/* ================================================================== *
 * 场景 2b：24KB 快照截断 → E_REVIEW_UNREAD → 分片补读 → pass
 * ================================================================== */

test("场景 2b：大报告被快照预算截断 → E_REVIEW_UNREAD + needRead → 分片补读后 pass", async (t) => {
  const plugin = await startPlugin(t, { files: { "big.txt": "大文件正文，用于核对文件证据。\n" } });
  try {
    const criteria = [{ id: "c1", text: "大报告可核对" }];
    const { taskId } = await submitPlan(plugin, {
      objective: "大报告与分片续读",
      criteria,
      stages: [{ id: "s1", title: "大报告", criterionIds: ["c1"], dependsOn: [] }],
    });
    await passPlan(plugin, { taskId, planVersion: 1, criteria });

    const bigEvidence = Array.from({ length: 1200 },
      (_, i) => "第 " + (i + 1) + " 行：大报告正文，用于验证 24KB 快照预算与分片续读。").join("\n");
    assert.ok(Buffer.byteLength(bigEvidence, "utf8") > 24576, "夹具必须真的超过 24KB");

    const report = await plugin.call("mentor_stage_report", {
      taskId, stageId: "s1", planVersion: 1,
      evidence: bigEvidence, evidenceRefs: [{ file: "big.txt", scope: "file" }], summary: "大报告",
    });
    assert.equal(report.ok, true, "stage_report 失败：" + JSON.stringify(report));
    const reportId = report.value.reportId;

    const checks = [{ source: "分片续读到的原文", criterion: "大报告可核对", criterionIds: ["c1"],
      observation: "报告全文已按 needRead 读完", status: "passed" }];

    const job = plugin.latestJob((j) => j.kind === "stage" && j.stageId === "s1");
    const reviewer = plugin.agentOf(job.sessionId);

    /* ---- 未读先裁决：必须被门禁拦下并给出 needRead ---- */
    const blocked = await plugin.callAs(reviewer, "mentor_review_apply", {
      taskId, reviewJobId: job.id, kind: "stage", planVersion: 1, stageId: "s1", verdict: "pass", checks,
    });
    assert.equal(blocked.ok, false, "未读报告不能裁决");
    assert.equal(blocked.code, "E_REVIEW_UNREAD");
    assert.deepEqual(blocked.details?.needRead?.missingReportIds, [reportId]);
    assert.ok(Array.isArray(blocked.details?.needRead?.suggestedQueries) &&
      blocked.details.needRead.suggestedQueries.some((q) => q.reportId === reportId),
      "needRead 必须给出可执行的分片查询");

    /* ---- 读整快照：大报告仍被截断，覆盖不完整 ---- */
    const snap = await plugin.callAs(reviewer, "mentor_task_status", { taskId });
    assert.equal(snap.ok, true, "读快照失败：" + JSON.stringify(snap));
    assert.ok(snap.value.snapshotBytes <= 24576, "默认快照不得超过 24KB，实际 " + snap.value.snapshotBytes);
    const projected = snap.value.nodeRuns.find((r) => r.stageId === "s1").reports.at(-1);
    assert.equal(projected.id, reportId);
    assert.equal(projected.evidenceTruncated, true, "大报告在默认快照里必须被标记截断");
    assert.ok(projected.evidence.length < bigEvidence.length);

    const stillUnread = await plugin.callAs(reviewer, "mentor_review_apply", {
      taskId, reviewJobId: job.id, kind: "stage", planVersion: 1, stageId: "s1", verdict: "pass", checks,
    });
    assert.equal(stillUnread.code, "E_REVIEW_UNREAD");
    assert.equal(stillUnread.details?.coverage?.complete, false);
    assert.equal(stillUnread.details?.coverage?.snapshotComplete, false);

    /* ---- 按 needRead 顺序分片补读 ---- */
    let offset = 0;
    let collected = "";
    for (let guard = 0; guard < 64; guard += 1) {
      const chunk = await plugin.callAs(reviewer, "mentor_task_status", {
        taskId, reportId, offset, maxBytes: 16384,
      });
      assert.equal(chunk.ok, true, "分片续读失败：" + JSON.stringify(chunk));
      assert.equal(chunk.value.reportOnly, true);
      assert.equal(chunk.value.found, true);
      collected += chunk.value.text;
      if (chunk.value.nextOffset === null) break;
      assert.ok(chunk.value.nextOffset > offset, "nextOffset 必须单调前进");
      offset = chunk.value.nextOffset;
      if (guard === 63) assert.fail("分片续读未在 64 次内完成");
    }
    assert.equal(collected, bigEvidence, "分片续读必须逐字节还原报告全文");

    const coverage = plugin.task().reviewJobs.find((j) => j.id === job.id).readCoverage;
    assert.equal(coverage.complete, true, "读完被截断的报告后 readCoverage 应为 complete");
    assert.deepEqual(coverage.coveredReportIds, [reportId]);

    const applied = await plugin.callAs(reviewer, "mentor_review_apply", {
      taskId, reviewJobId: job.id, kind: "stage", planVersion: 1, stageId: "s1", verdict: "pass", checks,
    });
    assert.equal(applied.ok, true, "补读后 pass 失败：" + JSON.stringify(applied));
    assert.equal(plugin.task().nodeRuns.find((r) => r.stageId === "s1").status, "accepted");
  } finally {
    await plugin.dispose();
    await settle();
  }
});

/* ================================================================== *
 * 场景 2c：模型侧无强制关闭入口；人工 RPC 传理由可关闭
 * ================================================================== */

test("场景 2c：模型侧无 mentor_finding_close；人工 dispatchCommand 传理由关闭成功", async (t) => {
  const plugin = await startPlugin(t);
  try {
    const { taskId } = await submitPlan(plugin, {
      objective: "人工关闭出口",
      criteria: [{ id: "c1", text: "计划可执行" }],
      stages: [{ id: "s1", title: "交付", criterionIds: ["c1"], dependsOn: [] }],
    });
    const planJob = plugin.latestJob((j) => j.kind === "plan");
    const reviewer = plugin.agentOf(planJob.sessionId);
    const read = await plugin.callAs(reviewer, "mentor_task_status", { taskId });
    assert.equal(read.ok, true, "读状态失败：" + JSON.stringify(read));
    const revised = await plugin.callAs(reviewer, "mentor_review_apply", {
      taskId, reviewJobId: planJob.id, kind: "plan", planVersion: 1, stageId: "__plan__",
      verdict: "revise", findings: [{ severity: "blocking", text: "G1 先补失败处理" }],
    });
    assert.equal(revised.ok, true, "计划 revise 失败：" + JSON.stringify(revised));
    const finding = plugin.task().findings[0];
    assert.equal(finding.status, "open");

    /* ---- 模型侧：工具表里根本没有 mentor_finding_close ---- */
    assert.equal(plugin.tools.has("mentor_finding_close"), false,
      "模型侧工具表不得注册 mentor_finding_close");
    assert.equal(TOOL_NAMES.includes("mentor_finding_close"), false,
      "TOOL_NAMES 不得包含 mentor_finding_close");

    /* ---- 人工 RPC：缺理由被拒，带理由成功 ---- */
    const scoped = plugin.scoped();
    assert.ok(scoped, "任务 store 应存在");
    const withoutReason = await dispatchCommand(scoped, {
      action: "mentor_finding_close",
      params: { taskId, revision: scoped.get().revision, findingId: finding.id },
    });
    assert.equal(withoutReason.ok, false, "缺理由必须被拒");
    assert.equal(withoutReason.error.code, "E_FINDING_CLOSE_REASON");

    const humanClose = await dispatchCommand(scoped, {
      action: "mentor_finding_close",
      params: {
        taskId, revision: scoped.get().revision, findingId: finding.id,
        reason: "人工确认：失败处理已并入 s1",
      },
    });
    assert.equal(humanClose.ok, true, "人工关闭失败：" + JSON.stringify(humanClose));
    assert.equal(humanClose.value.findingStatus, "closed");

    const closed = scoped.get().findings.find((f) => f.id === finding.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedBy, "user");
    assert.equal(closed.closeReason, "人工确认：失败处理已并入 s1");
    assert.ok(scoped.get().revision > 0);
  } finally {
    await plugin.dispose();
    await settle();
  }
});
