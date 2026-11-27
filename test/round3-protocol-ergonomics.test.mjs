/**
 * Round 3：模型交互人体工学与协议收敛。
 *
 * 锁四件事：
 *   1. 模型默认快照严格落在 24KB UTF-8 预算内，且带 snapshotBytes / snapshotTruncated / omitted
 *   2. workers[].report 投影成摘要，workerId 单查能拿回完整记录
 *   3. reportId 分片续读（UTF-8 安全）+ readCoverage 累计账本，读完才 complete
 *   4. runAction 失败收口：nextStep / allowedActions（按身份过滤）/ humanActions / retryable / recovery
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { apply, withReviewerTracking } from "../lib/index.js";
import { createMemoryStore } from "../src/tools/handlers.js";
import { runtimePayload, findReport, SNAPSHOT_BUDGET_BYTES } from "../src/runtime/activity.js";
import { recordReviewRead, applyBoundReview } from "../src/runtime/checkpoints.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const NO_CTX = { agents: { get: () => undefined } };
const REGISTRY = { summaries: () => [], all: () => [] };
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// 多字节正文：分片必须按 UTF-8 字节边界切，拼接后与原文逐字相等
const BIG = "证据🧪-".repeat(4000);
const WORKER_REPORT = "worker 报告：" + "改完 a；".repeat(500);

/** 一个明显超过 24KB 的任务：大报告、多审查、多问题、多参与者 */
function bigTask() {
  const now = Date.now();
  const stages = ["s1", "s2", "s3"].map((id) => ({ id, title: id, criterionIds: ["c1"], dependsOn: [], writePaths: [] }));
  const nodeRuns = stages.map((stage, index) => ({
    stageId: stage.id, attempt: 1, status: "accepted",
    workerSessionId: "mentor-worker-" + stage.id, workerStatus: "completed", workerReport: WORKER_REPORT,
    reports: Array.from({ length: 3 }, (_, i) => ({
      id: `rep_${stage.id}_${i}`, attempt: 1, planVersion: 1,
      evidence: BIG.slice(0, 30000) + `tail-${stage.id}-${i}`, evidenceRefs: [], bindings: [],
      summary: "证据摘要", evidenceFiles: [],
    })),
  }));
  return {
    id: "task-r3-big", phase: "reviewing", revision: 9, planVersion: 1, approvedPlanVersion: 1,
    enabled: true, mainSessionId: "main", objective: "Round 3 预算", updatedAt: now,
    workspaceRoot: ROOT, criteria: [{ id: "c1", text: "验收项一" }], stages, nodeRuns,
    findings: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `f-closed-${i}`, stageId: "s1", severity: "advisory", status: "closed", text: "旧问题" + i })),
      { id: "f-block", stageId: "s2", severity: "blocking", status: "open", text: "未关闭的阻断项", responses: [] },
    ],
    reviews: Array.from({ length: 18 }, (_, i) => ({
      id: `r-${i}`, scope: { kind: "stage", stageId: "s1", attempt: 1, planVersion: 1 },
      verdict: i % 2 ? "pass" : "revise", findings: [], checks: [],
    })),
    reviewJobs: Array.from({ length: 15 }, (_, i) => ({
      id: `job-${i}`, sessionId: `mentor-review-${i}`, kind: "stage", stageId: "s1", attempt: 1,
      planVersion: 1, status: i === 14 ? "running" : "completed", verdict: "pass",
      startedAt: now, updatedAt: now, outputText: "审查输出".repeat(200),
    })),
    reviewDispatches: Array.from({ length: 20 }, (_, i) => ({ at: now, stageId: "s1", attempt: 1, kind: "stage", reviewJobId: `job-${i}`, status: "completed", queued: true })),
    wakeDispatches: Array.from({ length: 20 }, (_, i) => ({ at: now, key: `k-${i}`, stageId: "s1", attempt: 1, verdict: "pass", queued: true, status: "sent" })),
    workers: [{ key: "batch/s1/1", batchId: "batch", stageId: "s1", attempt: 1, sessionId: "mentor-worker-s1", status: "completed", report: WORKER_REPORT }],
  };
}

/* ------------------------------------------------------------------ R3-1 */

test("R3-1 模型默认快照严格落在 24KB 内，并回带 snapshotBytes / snapshotTruncated / omitted", () => {
  const task = bigTask();
  assert.ok(jsonBytes(task) > SNAPSHOT_BUDGET_BYTES * 3, "夹具必须明显超过预算，否则测不到裁剪");
  const store = { get: () => task, settings: {} };
  const registry = { summaries: () => Array.from({ length: 6 }, (_, i) => ({ taskId: `t${i}`, phase: "active", revision: 1, objective: "x", mainSessionId: "m" })) , all: () => [] };

  const out = runtimePayload(NO_CTX, store, registry);

  assert.ok(jsonBytes(out) <= SNAPSHOT_BUDGET_BYTES, `实际 ${jsonBytes(out)} 字节`);
  assert.equal(out.snapshotBytes, jsonBytes(out), "snapshotBytes 必须是返回体自身的 UTF-8 字节数");
  assert.equal(out.snapshotTruncated, true);
  assert.deepEqual(Object.keys(out.omitted).sort(), ["findings", "participants", "reports", "reviewDispatches", "reviewJobs", "reviews", "tasks", "wakeDispatches", "workers"]);
  // 关键内容必须保住
  assert.equal(out.nextStep.code, "REVIEW_IN_PROGRESS");
  assert.ok(out.findings.some((f) => f.id === "f-block" && f.status === "open"), "未关闭 blocking finding 不能被裁掉");
  assert.ok(out.reviewJobs.some((j) => j.id === "job-14" && j.status === "running"), "在途审查不能被裁掉");
  assert.equal(out.phase, "reviewing");
  // 单条报告正文不超过既有 4000 字符上限
  for (const run of out.nodeRuns) for (const report of run.reports ?? []) {
    assert.ok(report.evidence.length <= 4000);
  }
});

test("R3-1b 小任务不裁剪：snapshotTruncated=false、omitted 全零", () => {
  const task = {
    id: "t-small", phase: "active", revision: 1, planVersion: 1, approvedPlanVersion: 1, enabled: true,
    objective: "小任务", criteria: [{ id: "c1", text: "c" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "pending", reports: [] }],
    findings: [], reviews: [], reviewJobs: [], wakeDispatches: [],
  };
  const out = runtimePayload(NO_CTX, { get: () => task, settings: {} }, REGISTRY);
  assert.ok(jsonBytes(out) <= SNAPSHOT_BUDGET_BYTES);
  assert.equal(out.snapshotTruncated, false);
  for (const [key, value] of Object.entries(out.omitted)) assert.equal(value, 0, `${key} 不应有省略`);
});

/* ------------------------------------------------------------------ R3-2 */

test("R3-2 workers[].report 与 nodeRuns[].workerReport 投影成摘要，workerId 单查拿回完整记录", () => {
  const store = { get: () => bigTask(), settings: {} };
  const out = runtimePayload(NO_CTX, store, REGISTRY);

  const worker = out.workers[0];
  assert.equal(worker.report, undefined, "默认视图不得携带 workers[].report 原文");
  assert.equal(worker.reportSummary.length, WORKER_REPORT.length);
  assert.equal(worker.reportSummary.bytes, Buffer.byteLength(WORKER_REPORT, "utf8"));
  assert.equal(worker.reportSummary.sha256.length, 64);
  assert.ok(worker.reportSummary.tail.length <= 200);
  assert.equal(worker.reportSummary.tail, WORKER_REPORT.slice(-200));

  const run = out.nodeRuns.find((item) => item.stageId === "s1");
  assert.equal(run.workerReport, undefined, "默认视图不得携带 nodeRuns[].workerReport 原文");
  assert.equal(run.workerReportSummary.length, WORKER_REPORT.length);

  const single = runtimePayload(NO_CTX, store, REGISTRY, { workerId: "batch/s1/1" });
  assert.equal(single.workerOnly, true);
  assert.equal(single.found, true);
  assert.equal(single.worker.report, WORKER_REPORT, "单查必须给回完整正文");
  assert.equal(single.nodeRuns, undefined, "单查不附带整快照");

  const bySession = runtimePayload(NO_CTX, store, REGISTRY, { workerId: "mentor-worker-s1" });
  assert.equal(bySession.found, true);

  const missing = runtimePayload(NO_CTX, store, REGISTRY, { workerId: "nope" });
  assert.equal(missing.found, false);
  assert.equal(missing.reason, "worker-not-found");
  assert.ok(missing.knownWorkerIds.includes("batch/s1/1"));
});

/* ------------------------------------------------------------------ R3-3 */

test("R3-3 reportId 默认仍回全文（A2 兼容），offset/maxBytes 分片可续读到 nextOffset=null", () => {
  const store = { get: () => bigTask(), settings: {} };
  const full = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_s1_0" });
  assert.equal(full.reportOnly, true);
  assert.equal(full.found, true);
  assert.equal(full.report.full, true);

  const target = findReport(store.get(), "rep_s1_0").evidence;
  assert.equal(full.report.evidence, target);
  const totalBytes = Buffer.byteLength(target, "utf8");

  const first = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_s1_0", offset: 0, maxBytes: 4096 });
  assert.equal(first.full, false);
  assert.equal(first.offset, 0);
  assert.ok(first.nextOffset > 0);
  assert.equal(first.totalBytes, totalBytes);
  assert.equal(first.sha256.length, 64);
  assert.equal(first.report, undefined, "分片模式不回整条报告对象");

  let offset = 0;
  let text = "";
  for (let i = 0; i < 200 && offset !== null; i += 1) {
    const part = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_s1_0", offset, maxBytes: 4096 });
    assert.ok(!part.text.includes("\uFFFD"), "分片不得切断多字节字符");
    text += part.text;
    offset = part.nextOffset;
  }
  assert.equal(text, target, "分片拼接必须逐字还原原文");
});

/* ------------------------------------------------------------------ R3-4 */

function coverageTask() {
  return {
    id: "task-r3-ledger", phase: "reviewing", revision: 1, planVersion: 1, approvedPlanVersion: 1,
    enabled: true, mainSessionId: "main", objective: "覆盖账本",
    criteria: [{ id: "c1", text: "验收项" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{
      stageId: "s1", attempt: 1, status: "reported",
      reports: [{ id: "rep_big", attempt: 1, planVersion: 1, evidence: BIG, evidenceRefs: [], bindings: [] }],
    }],
    findings: [], reviews: [], wakeDispatches: [],
    reviewJobs: [{ id: "job1", sessionId: "reviewer-1", kind: "stage", stageId: "s1", attempt: 1,
      planVersion: 1, status: "running", startedAt: 1, updatedAt: 1 }],
  };
}

const verdictArgs = () => ({
  reviewJobId: "job1", kind: "stage", planVersion: 1, stageId: "s1", attempt: 1, verdict: "pass",
  checks: [{ source: "fixture", criterion: "验收项", criterionIds: ["c1"], observation: "已核对证据", status: "passed" }],
});

test("R3-4 大报告被预算裁剪时记账为未读：REVIEW_UNREAD 精确列出缺哪条，分片读完才 complete", () => {
  const store = createMemoryStore(coverageTask());

  // 1) 默认快照：正文被 24KB/4000 字符裁剪，不能算读全
  const snapshot = runtimePayload(NO_CTX, store, REGISTRY, { stageId: "s1" });
  recordReviewRead(store, "reviewer-1", { stageId: "s1", snapshot });
  let job = store.get().reviewJobs[0];
  assert.deepEqual(job.readCoverage.requiredReportIds, ["rep_big"]);
  assert.deepEqual(job.readCoverage.coveredReportIds, []);
  assert.equal(job.readCoverage.complete, false);
  assert.equal(job.readCoverage.version, 1);
  assert.equal(job.readAt, undefined, "未读全不得写 readAt");

  // 2) 直接裁决 → E_REVIEW_UNREAD，details.needRead 精确到报告
  assert.throws(() => applyBoundReview(store, verdictArgs(), "reviewer-1"), (error) => {
    assert.equal(error.code, "E_REVIEW_UNREAD");
    assert.equal(error.details.needRead.reviewJobId, "job1");
    assert.equal(error.details.needRead.stageId, "s1");
    assert.deepEqual(error.details.needRead.missingReportIds, ["rep_big"]);
    assert.ok(Array.isArray(error.details.needRead.suggestedQueries) && error.details.needRead.suggestedQueries.length >= 1);
    return true;
  });

  // 3) 分片读完 → 累计进同一 scopeDigest，complete 收敛
  let offset = 0;
  for (let i = 0; i < 200 && offset !== null; i += 1) {
    const part = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_big", offset, maxBytes: 4096 });
    recordReviewRead(store, "reviewer-1", { reportRead: { reportId: "rep_big", mode: "chunk", offset: part.offset, nextOffset: part.nextOffset } });
    offset = part.nextOffset;
  }
  job = store.get().reviewJobs[0];
  assert.deepEqual(job.readCoverage.coveredReportIds, ["rep_big"]);
  assert.equal(job.readCoverage.complete, true);
  assert.equal(typeof job.readAt, "number");
  assert.equal(job.readPlanVersion, 1);

  // 4) 现在才能裁决
  const applied = applyBoundReview(store, verdictArgs(), "reviewer-1");
  assert.equal(applied.ok, true, JSON.stringify(applied));
});

test("R3-4b 跳读尾段不算读全（offset 不连续会被拒绝累计）", () => {
  const store = createMemoryStore(coverageTask());
  const total = Buffer.byteLength(BIG, "utf8");
  const tail = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_big", offset: total - 100, maxBytes: 4096 });
  assert.equal(tail.nextOffset, null, "尾段本身就是最后一片");
  recordReviewRead(store, "reviewer-1", { reportRead: { reportId: "rep_big", mode: "chunk", offset: tail.offset, nextOffset: tail.nextOffset } });
  const job = store.get().reviewJobs[0];
  assert.equal(job.readCoverage.complete, false, "没有从头顺序读完不能算 complete");
  assert.deepEqual(job.readCoverage.coveredReportIds, []);
});

test("R3-4c 单条 {reportId} 全文读取可直接补齐覆盖", () => {
  const store = createMemoryStore(coverageTask());
  recordReviewRead(store, "reviewer-1", { reportRead: { reportId: "rep_big", mode: "full" } });
  const job = store.get().reviewJobs[0];
  assert.equal(job.readCoverage.complete, true);
  assert.equal(typeof job.readAt, "number");
});

test("R3-4d 分片续读绑定 sha256：中途内容指纹变化必须重置游标、拒绝标为 complete", () => {
  const store = createMemoryStore(coverageTask());
  const first = runtimePayload(NO_CTX, store, REGISTRY, { reportId: "rep_big", offset: 0, maxBytes: 4096 });
  assert.ok(first.nextOffset > 0 && first.sha256);
  recordReviewRead(store, "reviewer-1", {
    reportRead: { reportId: "rep_big", mode: "chunk", offset: first.offset, nextOffset: first.nextOffset, sha256: first.sha256 },
  });
  // 下一片虽然 offset 连续，但 sha256 变了（模拟中途内容变化），且声称到达末尾
  recordReviewRead(store, "reviewer-1", {
    reportRead: { reportId: "rep_big", mode: "chunk", offset: first.nextOffset, nextOffset: null, sha256: "0".repeat(64) },
  });
  const job = store.get().reviewJobs[0];
  assert.equal(job.readCoverage.complete, false, "sha256 失配的分片续读不得标为 complete");
  assert.deepEqual(job.readCoverage.coveredReportIds, []);
});

/* ------------------------------------------------------------------ R3-5 */

function seededStore(overrides = {}) {
  return withReviewerTracking(createMemoryStore({
    id: "task-r3-err", phase: "reviewing", revision: 1, planVersion: 1, approvedPlanVersion: 1,
    enabled: true, mainSessionId: "main", objective: "错误收口",
    criteria: [{ id: "c1", text: "c1" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "reported", reports: [] }],
    findings: [], reviews: [], wakeDispatches: [],
    reviewJobs: [{ id: "job1", sessionId: "reviewer-1", kind: "stage", stageId: "s1", attempt: 1,
      planVersion: 1, status: "running", startedAt: 1, updatedAt: 1 }],
    ...overrides,
  }));
}

test("R3-5 失败信封统一带可执行引导，且绝不向审查员推荐主会话动作", async (t) => {
  const registered = new Map();
  const dispose = await apply({ agents: { get: () => undefined }, tools: { register(tool) { registered.set(tool.name, tool); } } }, { stateDir: "" });
  t.after(() => dispose());
  const store = seededStore();
  const main = { session: { id: "main", header: { cwd: ROOT } } };
  const reviewer = { session: { id: "reviewer-1", header: { cwd: ROOT } } };
  const call = async (name, args, agent) => JSON.parse(await registered.get(name).execute(args ?? {}, { agent, store }));

  // 审查员越权：不得拿到主会话动作
  const denied = await call("mentor_workspace_set", { workspaceRoot: ROOT }, reviewer);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "E_REVIEW_IDENTITY");
  assert.deepEqual(denied.details.allowedActions, [], "reviewer 不该被推荐任何主会话动作");
  assert.equal(denied.details.recovery, "correct-input");
  assert.equal(denied.details.retryable, false);
  assert.ok(denied.details.nextStep && denied.details.nextStep.code === "REVIEW_IN_PROGRESS");

  // 主会话在途：WORK_PENDING 可等待重试
  const pending = await call("mentor_workspace_set", { workspaceRoot: ROOT }, main);
  assert.equal(pending.code, "E_WORK_PENDING");
  assert.equal(pending.details.recovery, "wait");
  assert.equal(pending.details.retryable, true);
  assert.ok(pending.details.allowedActions.includes("mentor_task_pause"));

  // 人工专属：放行审查
  const waive = await call("mentor_review_waive", { reason: "人工放行" }, main);
  assert.equal(waive.code, "E_HUMAN_REQUIRED");
  assert.equal(waive.details.recovery, "human");
  assert.ok(waive.details.humanActions.some((line) => line.includes("/mentor waive")));

  // handler 返回的 {ok:false} 也走同一套收口
  const planning = withReviewerTracking(createMemoryStore({
    id: "task-r3-plan", phase: "planning", revision: 1, planVersion: 0, enabled: true,
    mainSessionId: "main", objective: "计划", criteria: [], stages: [], nodeRuns: [],
    findings: [], reviews: [], reviewJobs: [], wakeDispatches: [],
  }));
  const approve = JSON.parse(await registered.get("mentor_task_approve").execute({}, { agent: main, store: planning }));
  assert.equal(approve.ok, false);
  assert.equal(approve.code, "E_ILLEGAL_TRANSITION");
  assert.equal(approve.details.recovery, "correct-input");
  assert.equal(approve.details.nextStep.code, "PLANNING");
});

test("R3-5b 需要人工批准时返回 HUMAN_REQUIRED 并给出人工动作", async (t) => {
  const registered = new Map();
  const dispose = await apply({ agents: { get: () => undefined }, tools: { register(tool) { registered.set(tool.name, tool); } } }, { stateDir: "" });
  t.after(() => dispose());
  const store = withReviewerTracking(createMemoryStore({
    id: "task-r3-approve", phase: "awaiting-approval", revision: 1, planVersion: 1, approvedPlanVersion: null,
    enabled: true, requireApproval: true, mainSessionId: "main", objective: "等批准",
    criteria: [{ id: "c1", text: "c1" }], stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [], findings: [], reviews: [], reviewJobs: [], wakeDispatches: [],
  }));
  const main = { session: { id: "main", header: { cwd: ROOT } } };
  const res = JSON.parse(await registered.get("mentor_task_approve").execute({}, { agent: main, store }));
  assert.equal(res.ok, false);
  assert.equal(res.code, "E_HUMAN_REQUIRED");
  assert.equal(res.details.recovery, "human");
  assert.ok(res.details.humanActions.some((line) => line.includes("/mentor approve")));
  assert.ok(!res.details.allowedActions.includes("mentor_task_approve"), "模型侧不该被推荐自行批准");
});
