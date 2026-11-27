import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDLERS,
  completionRequest,
  createMemoryStore,
  findingClose,
  findingRespond,
  planAmend,
  planSubmit,
  reviewApply,
  reworkStage,
  stageReport,
  taskCreate,
  taskStatus,
} from "../src/tools/handlers.js";
import { ERR } from "../src/errors.js";
import { FINDING_STATUS, VERDICT, createFinding, submitFindingResponse } from "../src/review/review.js";
import { PHASES } from "../src/state/machine.js";
import { toPhase } from "./support/fixtures.mjs";
import path from "node:path";

/** s3：v0.2.0 起 handlers.taskCreate 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。
 *  这里统一给测试一个项目根，避免每条用例各自硬编码。 */
const ROOT = path.resolve(import.meta.dirname, "..");

function freshStore() {
  return createMemoryStore();
}

const PLAN = {
  criteria: [{ id: "c1", text: "第一条" }],
  stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [], writePaths: [] }],
};

/** 建任务 + 提交计划的便捷前置 */
function withPlan() {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "测试目标" });
  planSubmit(store, PLAN);
  return store;
}

test("mentor_task_create 建任务并返回 taskId/phase/revision", () => {
  const store = freshStore();
  const r = taskCreate(store, { workspaceRoot: ROOT, objective: "目标" });
  assert.equal(r.ok, true);
  assert.ok(r.value.taskId);
  assert.equal(r.value.phase, PHASES.PLANNING);
  assert.equal(r.value.revision, 1);
});

test("mentor_task_create 重复建任务返回结构化错误", () => {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "目标" });
  const r = taskCreate(store, { workspaceRoot: ROOT, objective: "又一个" });
  assert.equal(r.ok, false);
  assert.equal(
    r.code,
    ERR.TASK_EXISTS,
    "「已有进行中任务」是预期状态，不该伪装成内部故障",
  );
  assert.ok(r.message.includes("已存在进行中的任务"));
});

test("mentor_task_create 在任务 completed 后允许新建，并告知被替换的 taskId", () => {
  const store = freshStore();
  const first = taskCreate(store, { workspaceRoot: ROOT, objective: "第一个" });
  // 2026-11-09：phase 只能经 setPhase 走合法边，不能裸写（见 T3 契约）。
  toPhase(store, PHASES.COMPLETED);

  const second = taskCreate(store, { workspaceRoot: ROOT, objective: "第二个" });
  assert.equal(second.ok, true);
  assert.notEqual(second.value.taskId, first.value.taskId);
  assert.equal(second.value.phase, PHASES.PLANNING);
  // 不静默丢弃：告知覆盖了哪个任务
  assert.equal(second.value.replacedTaskId, first.value.taskId);
});

test("mentor_task_create 对进行中的三个 phase 都拒绝覆盖", () => {
  for (const phase of [PHASES.PLANNING, PHASES.ACTIVE, PHASES.REVIEWING]) {
    const store = freshStore();
    taskCreate(store, { workspaceRoot: ROOT, objective: "占位" });
    toPhase(store, phase);
    const r = taskCreate(store, { workspaceRoot: ROOT, objective: "新的" });
    assert.equal(r.ok, false, `${phase} 阶段应拒绝覆盖`);
    assert.equal(r.details.phase, phase);
  }
});

test("mentor_task_create 空 objective 返回结构化错误而不是抛异常", () => {
  const store = freshStore();
  const r = taskCreate(store, { workspaceRoot: ROOT,});
  assert.equal(r.ok, false);
  assert.equal(typeof r.code, "string");
});

test("mentor_task_status 无任务时返回结构化错误", () => {
  const store = freshStore();
  const r = taskStatus(store, {});
  assert.equal(r.ok, false);
  assert.ok(r.details.hint);
});

test("mentor_task_status 返回快照含 readyNodes 与 unresolved", () => {
  const store = withPlan();
  const r = taskStatus(store, {});
  assert.equal(r.ok, true);
  assert.equal(r.value.phase, PHASES.ACTIVE);
  assert.equal(r.value.planVersion, 1);
  assert.deepEqual(r.value.readyNodes, ["s1"]);
  assert.equal(r.value.unresolved.total, 0);
});

test("mentor_plan_submit 首次提交成功并进入 active", () => {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "目标" });
  const r = planSubmit(store, PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.value.planVersion, 1);
  assert.equal(r.value.phase, PHASES.ACTIVE);
});

test("mentor_plan_submit 已进入 active 后再提交被拒", () => {
  const store = withPlan();
  const r = planSubmit(store, PLAN);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
});

test("mentor_plan_submit 非法计划返回结构化错误且带 errors 清单", () => {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "目标" });
  const r = planSubmit(store, {
    criteria: [{ id: "c1", text: "x" }],
    stages: [{ id: "s1", criterionIds: ["ghost"], dependsOn: [] }],
  });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.details.errors));
  assert.ok(r.details.errors.some((e) => e.code === ERR.CRITERION_UNKNOWN));
  // 失败不应写入计划
  assert.equal(store.get().planVersion, 0);
});

test("mentor_plan_submit 在非 planning 阶段被拒绝", () => {
  const store = withPlan();
  toPhase(store, PHASES.ACTIVE);
  const r = planSubmit(store, PLAN);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
});

test("mentor_stage_report 成功时返回 status/attempt/reportCount", () => {
  const store = withPlan();
  const r = stageReport(store, { stageId: "s1", attempt: 1, evidence: "跑出 1/1" });
  assert.equal(r.ok, true);
  assert.equal(r.value.status, "reported");
  assert.equal(r.value.attempt, 1);
  assert.equal(r.value.reportCount, 1);
});

test("mentor_stage_report 未知 stage 返回 E_STAGE_UNKNOWN", () => {
  const store = withPlan();
  const r = stageReport(store, { stageId: "nope", attempt: 1, evidence: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STAGE_UNKNOWN);
});

test("mentor_stage_report attempt 陈旧返回 E_STALE_ATTEMPT", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮" });
  reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE, findings: ["不够"],
  });
  const r = stageReport(store, { stageId: "s1", attempt: 1, evidence: "旧轮次" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STALE_ATTEMPT);
});

test("mentor_completion_request 前置不满足时返回未满足清单", () => {
  const store = withPlan();
  const r = completionRequest(store, { evidence: "想收工" });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.details.unmet));
  assert.ok(r.details.unmet.length >= 2);
});

test("mentor_finding_respond 响应后状态是 responded 而不是 closed", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });
  reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: "blocking", text: "缺证据" }],
  });

  // 改造 s4（G7）：evidenceIds 必须是真实存在的证据 id，这里引用本次阶段报告
  const reportId = store.get().nodeRuns[0].reports[0].id;
  const r = findingRespond(store, { findingId: "f1", summary: "补了", evidenceIds: [reportId] });
  assert.equal(r.ok, true);
  assert.equal(r.value.findingStatus, FINDING_STATUS.RESPONDED);
  assert.notEqual(r.value.findingStatus, FINDING_STATUS.CLOSED);
  assert.equal(r.value.awaitingRecheck, true);
});

test("mentor_finding_respond 未知 finding 返回 E_FINDING_UNKNOWN", () => {
  const store = withPlan();
  const r = findingRespond(store, { findingId: "ghost", summary: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.FINDING_UNKNOWN);
});

/* -------- 2026-11-09：经 handler 的端到端用例（c2 / c3） -------- */

test("H1 经 reviewApply：pass 可直接关闭上一轮 revise 提出的 open finding（不再要求先 respond）", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮证据" });

  // 第一轮 revise 提出 G1（open）
  const r1 = reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "G1", severity: "blocking", text: "流程缺口" }],
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.value.unresolved.blocking, 1);

  // 改完重报，pass 时直接点名关闭 G1（不调 findingRespond）
  assert.equal(stageReport(store, { stageId: "s1", attempt: 2, evidence: "已补流程" }).ok, true);
  const r2 = reviewApply(store, {
    stageId: "s1", attempt: 2, verdict: VERDICT.PASS, markedResolved: ["G1"],
  });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(r2.value.closedFindingIds, ["G1"]);
  assert.equal(r2.value.unresolved.total, 0);

  const closed = store.get().findings.find((f) => f.id === "G1");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, true, "要留下「未经 respond 直接关闭」的痕迹");
});

test("H2 经 findingRespond：文本编号别名（G1）与派生 id 都能命中同一条 finding", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮证据" });
  reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    // id 是派生格式，文本里写的是 G1 —— 真机上调用方照文本编号 respond 就踩空
    findings: [{ id: "f_mw8x9y_7", severity: "blocking", text: "[blocking] G1 流程缺口" }],
  });

  const reportId = store.get().nodeRuns[0].reports[0].id;
  // ① 用文本里的编号
  const byAlias = findingRespond(store, { findingId: "G1", summary: "按编号响应", evidenceIds: [reportId] });
  assert.equal(byAlias.ok, true, JSON.stringify(byAlias));
  assert.equal(byAlias.value.findingId, "f_mw8x9y_7", "别名要解析到真实 id");
  assert.equal(byAlias.value.findingStatus, FINDING_STATUS.RESPONDED);

  // ② 用派生 id（精确命中优先）
  const byExact = findingRespond(store, { findingId: "f_mw8x9y_7", summary: "按 id 再响应一次", evidenceIds: [reportId] });
  assert.equal(byExact.ok, true);
  assert.equal(byExact.value.findingId, "f_mw8x9y_7");
});

test("H3 经 reviewApply：跨阶段 markedResolved 仍被拒（本阶段边界不放松）", () => {  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮证据" });
  reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f-own", severity: "blocking", text: "本阶段问题" }],
  });
  // 手工挂一条别的阶段的 open finding，模拟历史遗留
  const t = store.get();
  store.set({
    ...t,
    findings: [...t.findings, {
      id: "f-other", reviewId: "r-old", stageId: "s2", severity: "blocking",
      text: "别的阶段", quotes: [], status: "open", responses: [], resolvedByReviewId: null, createdAt: Date.now(),
    }],
  });

  const r = reviewApply(store, {
    stageId: "s1", attempt: 2, verdict: VERDICT.PASS, markedResolved: ["f-other"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.REVIEW_SCOPE);
});

test("H4 经 reviewApply：markedResolved 写文本编号（G1）也能关掉以派生 id 存储的 finding", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮证据" });
  reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    // 存的是派生 id，文本里写的是 G1 —— 与真机 f_mw8dzih4_8 / G1 同形
    findings: [{ id: "f_mw8dzih4_8", severity: "blocking", text: "[blocking] G1 是唯一阻断项" }],
  });

  assert.equal(stageReport(store, { stageId: "s1", attempt: 2, evidence: "已修" }).ok, true);
  const r = reviewApply(store, {
    stageId: "s1", attempt: 2, verdict: VERDICT.PASS, markedResolved: ["G1"],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.value.closedFindingIds, ["f_mw8dzih4_8"], "写进 closedFindingIds 的应是真实 id");
  assert.equal(r.value.unresolved.total, 0);
  const closed = store.get().findings.find((f) => f.id === "f_mw8dzih4_8");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, true);
});

// ---------------- 工具层完整闭环 ----------------

test("完整闭环：建任务 → 计划 → 上报 → revise → 响应 → pass → 完成", () => {
  const store = freshStore();

  // 1. 建任务
  const created = taskCreate(store, { workspaceRoot: ROOT, objective: "闭环验证" });
  assert.equal(created.ok, true);

  // 2. 提交计划
  assert.equal(planSubmit(store, PLAN).ok, true);

  // 3. 上报，被 revise
  assert.equal(stageReport(store, { stageId: "s1", attempt: 1, evidence: "首轮证据" }).ok, true);
  const r1 = reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: "blocking", text: "证据不足" }],
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.value.unresolved.blocking, 1);

  // 4. 响应（不等于关闭）
  const resp = findingRespond(store, { findingId: "f1", summary: "补了实测" });
  assert.equal(resp.ok, true);
  assert.equal(resp.value.findingStatus, FINDING_STATUS.RESPONDED);

  // 5. 此时完成请求仍被拒（blocking 未关闭）
  const blocked = completionRequest(store, { evidence: "想收工" });
  assert.equal(blocked.ok, false);

  // 6. 用新 attempt 重新上报
  const re = stageReport(store, { stageId: "s1", attempt: 2, evidence: "改进后的证据" });
  assert.equal(re.ok, true);
  assert.equal(re.value.attempt, 2);

  // 7. 复核通过并关闭 finding
  const r2 = reviewApply(store, {
    stageId: "s1", attempt: 2, verdict: VERDICT.PASS, markedResolved: ["f1"],
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.value.verdict, VERDICT.PASS);
  assert.equal(r2.value.unresolved.total, 0);
  assert.equal(r2.value.phase, PHASES.REVIEWING);

  // 8. 请求完成
  const done = completionRequest(store, { evidence: "全部达成" });
  assert.equal(done.ok, true);
  assert.equal(done.value.phase, PHASES.COMPLETED);

  // 9. 状态可回读
  const status = taskStatus(store, {});
  assert.equal(status.value.phase, PHASES.COMPLETED);
});

test("HANDLERS 暴露全部工具名且都是函数", () => {
  const names = Object.keys(HANDLERS);
  assert.ok(names.length >= 7);
  for (const n of names) {
    assert.equal(typeof HANDLERS[n], "function", `${n} 应为函数`);
    assert.ok(n.startsWith("mentor_"), `${n} 应有 mentor_ 前缀`);
  }
});

test("所有 handler 在极端入参下都不抛裸异常", () => {
  const store = freshStore();
  for (const [name, fn] of Object.entries(HANDLERS)) {
    for (const params of [undefined, null, {}, { stageId: 42 }, { attempt: "x" }]) {
      let out;
      assert.doesNotThrow(() => {
        out = fn(store, params);
      }, `${name} 在 ${JSON.stringify(params)} 下抛了异常`);
      assert.equal(typeof out, "object");
      assert.equal(typeof out.ok, "boolean", `${name} 应返回 {ok}`);
      if (!out.ok) assert.equal(typeof out.code, "string", `${name} 失败应有 code`);
    }
  }
});

/* ---------------- 错误码语义（预期状态 vs 内部故障） ---------------- */

test("无任务时用 E_NO_TASK，而不是 E_INTERNAL", () => {
  const store = freshStore();
  const r = taskStatus(store, {});
  assert.equal(r.ok, false);
  assert.equal(
    r.code,
    ERR.NO_TASK,
    "「没有任务」是预期状态，不该伪装成内部故障",
  );
  assert.notEqual(r.code, ERR.INTERNAL);
  assert.equal(r.details?.hint, "mentor_task_create", "应给出下一步提示");
});

test("传入不匹配的 taskId 时用 E_TASK_MISMATCH", () => {
  const store = withPlan();
  const currentId = store.get().id;
  const r = taskStatus(store, { taskId: "task_someone_else" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.TASK_MISMATCH);
  assert.equal(r.details?.currentTaskId, currentId);
  assert.equal(r.details?.requestedTaskId, "task_someone_else");
  // 传自己的 id 应当正常
  assert.equal(taskStatus(store, { taskId: currentId }).ok, true);
});

/* ---------------- 主动返工（mentor_rework_stage） ---------------- */

/** 造一个「s1 已接受、s2 已接受、s3 依赖 s2」的场景 */
function withAcceptedChain() {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "返工测试" });
  planSubmit(store, {
    criteria: [{ id: "c1", text: "目标" }],
    stages: [
      { id: "s1", criterionIds: ["c1"], dependsOn: [], writePaths: [] },
      { id: "s2", criterionIds: ["c1"], dependsOn: ["s1"], writePaths: [] },
      { id: "s3", criterionIds: ["c1"], dependsOn: ["s2"], writePaths: [] },
    ],
  });
  const t = store.get();
  store.set({
    ...t,
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "accepted", reports: [] },
      { stageId: "s2", attempt: 1, status: "accepted", reports: [] },
      { stageId: "s3", attempt: 1, status: "accepted", reports: [] },
    ],
  });
  return store;
}

test("mentor_rework_stage 把已接受的阶段置回 rework 并让 attempt+1", () => {
  const store = withAcceptedChain();
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s2" });
  assert.equal(r.ok, true);
  assert.equal(r.value.stageId, "s2");
  assert.equal(r.value.status, "rework");
  assert.equal(r.value.attempt, 2, "返工后 attempt 应 +1");

  const runs = store.get().nodeRuns;
  const s2 = runs.find((x) => x.stageId === "s2");
  assert.equal(s2.status, "rework");
  assert.equal(s2.attempt, 2);
});

test("mentor_rework_stage 让传递依赖它的已接受节点一并失效", () => {
  const store = withAcceptedChain();
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s1" });
  assert.equal(r.ok, true);
  // s2 依赖 s1、s3 依赖 s2，两者都应失效
  assert.deepEqual([...r.value.invalidated].sort(), ["s2", "s3"]);

  const runs = store.get().nodeRuns;
  assert.equal(runs.find((x) => x.stageId === "s2").status, "rework");
  assert.equal(runs.find((x) => x.stageId === "s3").status, "rework");
  // 只依赖自己那一环被返工的 s1
  assert.equal(runs.find((x) => x.stageId === "s1").status, "rework");
});

test("返工后 readyNodes 立刻反映出来（后继不再就绪）", () => {
  const store = withAcceptedChain();
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s1" });
  assert.deepEqual(r.value.readyNodes, ["s1"], "只有被返工的 s1 重新可做");
});

test("mentor_rework_stage 拒绝非 accepted 的节点", () => {
  const store = withAcceptedChain();
  const t = store.get();
  store.set({
    ...t,
    nodeRuns: t.nodeRuns.map((x) =>
      x.stageId === "s2" ? { ...x, status: "rework" } : x,
    ),
  });
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s2" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
  assert.match(r.message, /只有 accepted/);
});

test("mentor_rework_stage 拒绝从未上报过的阶段", () => {
  const store = withAcceptedChain();
  const t = store.get();
  store.set({ ...t, nodeRuns: t.nodeRuns.filter((x) => x.stageId !== "s3") });
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s3" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
  assert.match(r.message, /从未上报/);
});

test("mentor_rework_stage 拒绝计划里不存在的阶段", () => {
  const store = withAcceptedChain();
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STAGE_UNKNOWN);
  assert.deepEqual(r.details?.knownStageIds, ["s1", "s2", "s3"]);
});

test("mentor_rework_stage 拒绝空 stageId", () => {
  const store = withAcceptedChain();
  const r = HANDLERS.mentor_rework_stage(store, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STAGE_UNKNOWN);
});

test("mentor_rework_stage 拒绝已完成的任务", () => {
  const store = withAcceptedChain();
  toPhase(store, PHASES.COMPLETED);
  const r = HANDLERS.mentor_rework_stage(store, { stageId: "s1" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
  assert.match(r.message, /已完成/);
});

/* ------------------------------------------------------------------ *
 * c3：计划可修订（active / reviewing 都能改，必须留痕）
 * ------------------------------------------------------------------ */

test("mentor_plan_amend 在 active 阶段可修订，planVersion+1 并记录 reason", () => {
  const store = withPlan();
  const before = store.get();
  assert.equal(before.phase, PHASES.ACTIVE);

  const r = planAmend(store, {
    reason: "GET 实测 400 空体，端点改 POST + requestBody buffered",
    criteria: [{ id: "c1", text: "改后的第一条" }],
  });

  assert.equal(r.ok, true);
  const after = store.get();
  assert.equal(after.planVersion, before.planVersion + 1);
  assert.equal(after.amendments.length, 1);
  assert.equal(after.amendments[0].reason, "GET 实测 400 空体，端点改 POST + requestBody buffered");
  assert.equal(after.amendments[0].fromPlanVersion, before.planVersion);
  assert.equal(after.criteria[0].text, "改后的第一条");
  assert.equal(after.stages.length, before.stages.length, "没传 stages 就保持原样");
  assert.ok(after.revision > before.revision);
});

test("mentor_plan_amend 在 reviewing 阶段也可修订（旧行为是彻底不可改）", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });
  assert.equal(store.get().phase, PHASES.REVIEWING);

  const r = planAmend(store, { reason: "审查指出补一条验收项" });
  assert.equal(r.ok, true);
  assert.equal(store.get().amendments.length, 1);
});

test("mentor_plan_amend 缺 reason 拒绝", () => {
  const store = withPlan();
  const r = planAmend(store, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.INTERNAL);
  assert.ok(r.message.includes("reason"));
});

test("mentor_plan_amend 修订后的计划校验失败返回 EMPTY_PLAN 并带错误清单", () => {
  const store = withPlan();
  const r = planAmend(store, {
    reason: "故意写坏",
    criteria: [{ id: "c1", text: "只有这一条" }],
    stages: [{ id: "s1", criterionIds: ["c_missing"], dependsOn: [], writePaths: [] }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EMPTY_PLAN);
  assert.ok(Array.isArray(r.details.errors) && r.details.errors.length > 0);
});

test("mentor_plan_amend 在 planning 阶段不被接受（该用 plan_submit）", () => {
  const store = freshStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "还没提计划" });
  const r = planAmend(store, { reason: "想直接改" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
});

/* ------------------------------------------------------------------ *
 * c4：引文校验（防转述失真）
 * ------------------------------------------------------------------ */

const EVIDENCE_TEXT = "你一直在让我重启，你就是没有搞定";

test("引文校验：逐字命中被审证据时通过，并留存 quotes", () => {
  const f = createFinding({
    severity: "blocking",
    text: "用户明确否证过三次",
    quotes: ["一直在让我重启"],
    evidenceText: EVIDENCE_TEXT,
  });
  assert.equal(f.quotes.length, 1);
  assert.equal(f.quotes[0], "一直在让我重启");
});

test("引文校验：转述失真被拒，报未命中片段", () => {
  assert.throws(
    () =>
      createFinding({
        severity: "blocking",
        text: "转述",
        quotes: ["你又让我重启"],
        evidenceText: EVIDENCE_TEXT,
      }),
    (err) => err.code === ERR.QUOTE_NOT_FOUND && err.details.missed[0] === "你又让我重启",
  );
});

test("引文校验：不传 quotes 时不做校验（向后兼容）", () => {
  const f = createFinding({ severity: "blocking", text: "普通 finding" });
  assert.deepEqual(f.quotes, []);
});

test("evidence 引文校验：quotes 不在 evidence 中返回 QUOTE_NOT_FOUND", () => {
  const store = withPlan();
  const r = stageReport(store, {
    stageId: "s1",
    attempt: 1,
    evidence: "全量单测 180/180 通过",
    quotes: ["181/181"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.QUOTE_NOT_FOUND);
  assert.deepEqual(r.details.missed, ["181/181"]);
});

test("evidence 引文校验：命中则正常上报", () => {
  const store = withPlan();
  const r = stageReport(store, {
    stageId: "s1",
    attempt: 1,
    evidence: "全量单测 180/180 通过",
    quotes: ["180/180"],
  });
  assert.equal(r.ok, true);
});
/* ------------------------------------------------------------------ *
 * c3：plan_amend 与审查的交互（reported 节点必须失效重报）
 * ------------------------------------------------------------------ */

test("plan_amend 时，reported 的节点被重置为 rework 并 attempt+1", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });
  assert.equal(store.get().phase, PHASES.REVIEWING);
  assert.equal(store.get().nodeRuns[0].status, "reported");

  const r = planAmend(store, { reason: "计划变更，旧证据失效" });

  assert.equal(r.ok, true);
  assert.deepEqual(r.value.resetStages, ["s1"], "被重置的阶段要回传到返回值");
  assert.equal(store.get().nodeRuns[0].status, "rework");
  assert.equal(store.get().nodeRuns[0].attempt, 2);
  // 重置后没有待审内容，phase 必须回落 active，不能永久停在 reviewing
  assert.equal(store.get().phase, PHASES.ACTIVE);
});

test("plan_amend 在 active 且无 reported 节点时不重置任何阶段", () => {
  const store = withPlan();
  const r = planAmend(store, { reason: "只是补一条验收" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.resetStages, []);
  assert.equal(store.get().phase, PHASES.ACTIVE);
});
/* ------------------------------------------------------------------ *
 * P1-3 修复：mentor_finding_close 用户侧出口
 * ------------------------------------------------------------------ */

function storeWithFinding(status) {
  const raw = createFinding({ severity: "blocking", text: "缺证据", id: "f1", reviewId: "r0" });
  const finding = status === "responded"
    ? submitFindingResponse(raw, { summary: "已补齐", evidenceIds: [] })
    : raw;
  return createMemoryStore({
    id: "t1", revision: 1, phase: "reviewing",
    criteria: [], stages: [], nodeRuns: [], findings: [finding], reviews: [],
  });
}

test("mentor_finding_close：能把 open 的 finding 关闭并推进 revision", () => {
  const store = storeWithFinding("open");
  const r = findingClose(store, { findingId: "f1", reason: "人工确认已解决" });
  assert.equal(r.ok, true);
  assert.equal(r.value.findingStatus, FINDING_STATUS.CLOSED);
  assert.equal(r.value.alreadyClosed, false);
  assert.equal(store.get().findings[0].status, FINDING_STATUS.CLOSED);
  assert.equal(store.get().revision, 2);
});

test("mentor_finding_close：已关闭时幂等，不推进 revision", () => {
  const store = storeWithFinding("responded");
  findingClose(store, { findingId: "f1", reason: "第一次" });
  const revAfterFirst = store.get().revision;

  const again = findingClose(store, { findingId: "f1", reason: "第二次" });
  assert.equal(again.ok, true);
  assert.equal(again.value.alreadyClosed, true);
  assert.equal(store.get().revision, revAfterFirst, "幂等不应推进 revision");
});
/* ------------------------------------------------------------------ *
 * s3：审查闸门校验（P0-2）—— 幽灵 stageId / attempt 失配 / 跨阶段关闭
 * ------------------------------------------------------------------ */

test("reviewApply：幽灵 stageId 被拒，不再静默成功（P0-2）", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });

  const r = reviewApply(store, { stageId: "ghost", attempt: 1, verdict: VERDICT.PASS });

  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.REVIEW_SCOPE);
  // 关键：拒绝之后不能留下任何审查痕迹 —— 否则幽灵裁决仍会污染 reviews
  assert.equal((store.get().reviews ?? []).length, 0, "被拒的裁决不能写进 reviews");
});

test("reviewApply：attempt 失配被拒，不再静默跳过节点更新（P0-2）", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });

  const r = reviewApply(store, { stageId: "s1", attempt: 99, verdict: VERDICT.PASS });

  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.REVIEW_SCOPE);
  assert.equal(store.get().nodeRuns[0].status, "reported", "节点状态不能被改");
  assert.equal((store.get().reviews ?? []).length, 0);
});

test("reviewApply：markedResolved 不能跨阶段关闭 finding（P0-2）", () => {
  const store = withPlan();
  stageReport(store, { stageId: "s1", attempt: 1, evidence: "证据" });

  // 造一条归属 s9 的 responded finding
  const other = submitFindingResponse(
    createFinding({ severity: "blocking", text: "别的阶段的问题", id: "f-other", reviewId: "r0", stageId: "s9" }),
    { summary: "已处理", evidenceIds: [] },
  );
  store.set({ ...store.get(), findings: [other] });

  const r = reviewApply(store, {
    stageId: "s1", attempt: 1, verdict: VERDICT.PASS, markedResolved: ["f-other"],
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.REVIEW_SCOPE);
  assert.equal(store.get().findings[0].status, FINDING_STATUS.RESPONDED, "跨阶段的 finding 不能被关");
});
/* ------------------------------------------------------------------ *
 * P1-5 / P1-6：失效语义补齐
 * ------------------------------------------------------------------ */

function storeTwoStages() {
  return createMemoryStore({
    id: "t-2s", revision: 1, phase: "active",
    criteria: [{ id: "c1", text: "x" }],
    stages: [
      { id: "s1", title: "A", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "B", criterionIds: ["c1"], dependsOn: ["s1"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "accepted", reports: [] },
      { stageId: "s2", attempt: 1, status: "reported", reports: [] },
    ],
    findings: [],
    reviews: [],
  });
}

test("plan_amend 后 accepted 节点也被重置（P1-6）", () => {
  const store = storeTwoStages();
  const r = planAmend(store, { reason: "改验收标准" });

  assert.equal(r.ok, true);
  assert.ok(r.value.resetStages.includes("s1"), "accepted 的 s1 必须重置");
  assert.ok(r.value.resetStages.includes("s2"), "reported 的 s2 也要重置");

  const s1 = store.get().nodeRuns.find((x) => x.stageId === "s1");
  assert.equal(s1.status, "rework", "旧 criteria 下通过的结果不能再算数");
  assert.equal(s1.attempt, 2);
});

test("reworkStage 失效 reported 的后继（P1-5）", () => {
  const store = storeTwoStages();
  const r = reworkStage(store, { stageId: "s1" });

  assert.equal(r.ok, true);
  const s2 = store.get().nodeRuns.find((x) => x.stageId === "s2");
  assert.equal(s2.status, "rework", "reported 后继必须一并失效");
  assert.equal(s2.attempt, 2);
});
/* ------------------------------------------------------------------ *
 * P2-3：completed 是真终态
 * ------------------------------------------------------------------ */

function storeCompleted() {
  return createMemoryStore({
    id: "t-done", revision: 5, phase: PHASES.COMPLETED,
    criteria: [{ id: "c1", text: "x" }],
    stages: [{ id: "s1", title: "A", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted", reports: [] }],
    findings: [],
    reviews: [{ id: "r1", verdict: "pass", scope: { stageId: "s1", attempt: 1 }, findings: [], markedResolved: [] }],
  });
}

test("completed 后 stage_report 被拒（P2-3）", () => {
  const store = storeCompleted();
  const r = stageReport(store, { stageId: "s1", attempt: 1, evidence: "想改历史" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
  // 关键：被拒之后历史不能被改写
  assert.equal(store.get().nodeRuns[0].status, "accepted");
  assert.equal(store.get().revision, 5);
});

test("completed 后 finding_respond 被拒（P2-3）", () => {
  const store = storeCompleted();
  const r = findingRespond(store, { findingId: "whatever", summary: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
});

test("completed 后 review_apply 被拒（P2-3）", () => {
  const store = storeCompleted();
  const r = reviewApply(store, { stageId: "s1", attempt: 1, verdict: VERDICT.PASS });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.ILLEGAL_TRANSITION);
  assert.equal((store.get().reviews ?? []).length, 1, "被拒的裁决不能污染 reviews");
});