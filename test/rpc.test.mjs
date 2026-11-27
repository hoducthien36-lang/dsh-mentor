/**
 * RPC 端点层测试（s2）。
 *
 * 核心约束：`buildStatePayload(task)` 必须与 `mentor_task_status` 工具返回的 value
 * **逐字段深度相等**。这样面板取数与工具层永远同形，不会出现端点裁字段而验收
 * 要求全字段的偏差。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryStore,
  planSubmit,
  taskCreate,
  stageReport,
  taskStatus,
} from "../src/tools/handlers.js";
import { buildStatePayload, createStateHandler } from "../src/rpc/state.js";
import path from "node:path";

/** s3：v0.2.0 起 handlers.taskCreate 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。
 *  这里统一给测试一个项目根，避免每条用例各自硬编码。 */
const ROOT = path.resolve(import.meta.dirname, "..");

/* ------------------------------------------------------------------ *
 * 造一个带计划与上报记录的真实任务
 * ------------------------------------------------------------------ */

function makeTask({ withReport = false } = {}) {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "rpc 层的测试任务" });
  planSubmit(store, {
    criteria: [
      { id: "c1", text: "第一条" },
      { id: "c2", text: "第二条" },
    ],
    stages: [
      { id: "s1", title: "阶段一", criterionIds: ["c1"] },
      { id: "s2", title: "阶段二", criterionIds: ["c2"], dependsOn: ["s1"] },
    ],
  });
  if (withReport) {
    stageReport(store, {
      stageId: "s1",
      attempt: 1,
      evidence: "第一轮的证据",
      summary: "摘要",
    });
  }
  return store;
}

/* ------------------------------------------------------------------ *
 * 空态
 * ------------------------------------------------------------------ */

test("无任务时 payload 返回 { task: null }，而不是抛错", () => {
  const payload = buildStatePayload(null);
  assert.deepEqual(payload, { task: null });
});

test("无任务时 handler 返回 ok:true 的信封，不以错误表示空态", async () => {
  const store = createMemoryStore();
  const handler = createStateHandler(store);
  const res = await handler();
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { task: null });
});

/* ------------------------------------------------------------------ *
 * 与 taskStatus 深度相等（本次改动的核心保证）
 * ------------------------------------------------------------------ */

test("有任务时 payload 与 mentor_task_status 的 value 深度相等", () => {
  const store = makeTask();
  const fromTool = taskStatus(store, {});
  assert.equal(fromTool.ok, true);

  const fromRpc = buildStatePayload(store.get());
  assert.deepEqual(fromRpc, fromTool.value);
});

test("有上报记录时仍然深度相等（nodeRuns 不被裁剪）", () => {
  const store = makeTask({ withReport: true });
  const fromTool = taskStatus(store, {});
  const fromRpc = buildStatePayload(store.get());

  assert.deepEqual(fromRpc, fromTool.value);
  // 显式确认 nodeRuns 里的 reports 原样保留，没有被裁成摘要
  assert.equal(fromRpc.nodeRuns.length, 1);
  assert.equal(fromRpc.nodeRuns[0].reports.length, 1);
  assert.equal(fromRpc.nodeRuns[0].reports[0].evidence, "第一轮的证据");
});

test("handler 的值与 taskStatus 的 value 深度相等", async () => {
  const store = makeTask({ withReport: true });
  const handler = createStateHandler(store);
  const res = await handler();
  const fromTool = taskStatus(store, {});

  assert.equal(res.ok, true);
  assert.deepEqual(res.value, fromTool.value);
});

/* ------------------------------------------------------------------ *
 * 字段完整性：防止以后某侧悄悄删字段
 * ------------------------------------------------------------------ */

test("payload 含全部顶层字段（含控制接口新增项）", () => {
  const store = makeTask();
  const payload = buildStatePayload(store.get());

  const expected = [
    "taskId",
    "revision",
    "objective",
    "phase",
    "planVersion",
    // 2026-11-05（autowake s3）：谁在推这个任务，唤醒主轴用；旧任务为 null
    "mainSessionId",
    "criteria",
    "stages",
    "nodeRuns",
    "readyNodes",
    "unresolved",
    "lastReview",
    // v0.2.0：任务工作区（证据校验的路径逃逸边界），UI 用它显示/换项目
    "workspaceRoot",
    // v0.2.0 面板数据源：问题清单与审查历史（lib/client.js 的 issues/reviews 页签）
    "findings",
    "reviews",
    // v0.2.0 并行执行：批次、在跑的 worker、整体检查点
    "parallelBatches",
    "workers",
    "pendingCheckpoint",
    // v0.2.0 续行与审查派发：谁在跑审查 / 有没有卡住的唤醒
    "continuation",
    "reviewJobs",
    "reviewDispatches",
    "wakeDispatches",
    // v0.2.0 持久化故障外显：落盘失败要让 UI 看见，不能静默
    "lastPersistError",
    "createdAt",
    "updatedAt",
    // 2026-11-04 控制接口：补上旧 supervisor task-status 的「状态 + 下一步」
    "enabled",
    "live",
    "paused",
    "prePausePhase",
    // 改造 s2（矩阵 G6）：暂停原因分层，resume 策略依赖它
    "pauseReason",
    "pausedAt",
    "approvedPlanVersion",
    "archivedAt",
    "nextStep",
    "allowedTransitions",
  ];
  for (const key of expected) {
    assert.ok(key in payload, `缺少字段: ${key}`);
  }
  assert.equal(Object.keys(payload).length, expected.length);
});

test("nextStep 在关键状态下给出可读结论（对旧 executionBlockedReason 的替代）", () => {
  const store = makeTask();
  const base = store.get();

  // planning：提示去提交计划
  const planning = buildStatePayload({ ...base, phase: "planning" });
  assert.equal(planning.nextStep.code, "PLANNING");
  assert.ok(planning.nextStep.allowedActions.includes("mentor_plan_submit"));

  // awaiting-approval：提示去批准
  const awaiting = buildStatePayload({ ...base, phase: "awaiting-approval", planVersion: 1 });
  assert.equal(awaiting.nextStep.code, "AWAITING_APPROVAL");
  assert.ok(awaiting.nextStep.allowedActions.includes("mentor_task_approve"));

  // paused：提示去恢复，并带上暂停前的状态
  const paused = buildStatePayload({
    ...base,
    phase: "paused",
    prePausePhase: "reviewing",
  });
  assert.equal(paused.nextStep.code, "TASK_PAUSED");
  assert.match(paused.nextStep.text, /reviewing/);
  assert.ok(paused.nextStep.allowedActions.includes("mentor_task_resume"));

  // 导师被关掉：理由优先级高于 paused（先关的导师才是主因）
  const off = buildStatePayload({ ...base, enabled: false, phase: "paused" });
  assert.equal(off.nextStep.code, "SUPERVISOR_DISABLED");
  assert.equal(off.enabled, false);

  // 已归档：只能新建
  const archived = buildStatePayload({ ...base, phase: "archived" });
  assert.equal(archived.nextStep.code, "WORKFLOW_ARCHIVED");
  assert.deepEqual(archived.nextStep.allowedActions, ["mentor_task_create"]);
});

test("payload 反映 store 的实时状态，不是快照拷贝", async () => {
  const store = makeTask();
  const handler = createStateHandler(store);

  const before = await handler();
  assert.equal(before.value.readyNodes.includes("s1"), true);
  assert.equal(before.value.readyNodes.includes("s2"), false);

  // s1 上报后 readyNodes 应保持不变（未被接受前 s2 仍不可用），revision 应递增
  const revisionBefore = before.value.revision;
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });

  const after = await handler();
  assert.ok(after.value.revision > revisionBefore, "revision 应随状态推进递增");
  assert.deepEqual(after.value, taskStatus(store, {}).value);
});
