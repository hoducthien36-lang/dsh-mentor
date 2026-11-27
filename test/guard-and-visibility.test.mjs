/**
 * 11-13 那轮修复的回归测试（此前零覆盖）+ 本轮两项新代码。
 *
 * G1 既有·审查有效身份   —— 非最新 / 非 queued-running 的 job 不能交裁决
 * G2 既有·终态保护       —— 已 completed 的 job 二次裁决只做幂等返回，不改写状态
 * G3 既有·读取凭据顺序   —— 只有真正拿到任务快照才登记 readAt；单查不登记
 * G4 既有·快照收窄       —— 默认去 outputText 且截断 12 条；reviewJobId 只回单条
 * G5 本轮·告警可见       —— 快照顶层 alerts 聚合 reviewJobs[].runtimeWarning
 * G6 本轮·启动跳过终态   —— recoverInterrupted 不碰 archived/completed，其余照旧恢复
 *
 * 边界说明（重要）：
 *  - G2 覆盖的是 applyBoundReview 一层的终态语义。updateRuntimeReview 是 lib/index.js
 *    内部函数、未导出，看门狗那条路径无法在本文件直接断言，由 s4 的全量回归兜底。
 *  - 全部用例走内存 store / 假 ctx，不碰真实任务数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { apply, updateRuntimeReview, wakeMain } from "../lib/index.js";
import { createMemoryStore } from "../src/tools/handlers.js";
import { applyBoundReview, recordReviewRead } from "../src/runtime/checkpoints.js";
import { runtimePayload } from "../src/runtime/activity.js";
import { setPhase } from "../src/runtime/phase-writer.js";
import { mentorToolVisible } from "../src/runtime/tool-visibility.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLAN = { version: 1, stages: [{ id: "s1", criterionIds: ["c1"] }] };
const CRITERIA = [{ id: "c1", text: "验收项" }];

/** 假 ctx：只实现 apply 需要的 tools.register + effect */
function makeCtx() {
  const registered = new Map();
  const ctx = {
    tools: {
      register(tool) {
        if (registered.has(tool.name)) throw new Error(`重复注册：${tool.name}`);
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
    effect() {},
  };
  return { ctx, registered };
}

let sessionSeq = 0;
function newExec(mainSessionId) {
  sessionSeq += 1;
  return {
    agent: {
      session: { id: mainSessionId ?? `s3-session-${sessionSeq}`, header: { cwd: ROOT, delegationDepth: 0 } },
    },
  };
}

const baseTask = (over = {}) => ({
  id: "task_s3", phase: "active", revision: 3, planVersion: 1,
  mainSessionId: "main-s3", workspaceRoot: ROOT,
  criteria: CRITERIA, stages: PLAN.stages, plan: PLAN,
  nodeRuns: [], reviews: [], findings: [], reviewJobs: [], reviewDispatches: [],
  updatedAt: 1, ...over,
});

const job = (over = {}) => ({
  id: "job_1", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1,
  sessionId: "reviewer-1", status: "running", startedAt: 1, updatedAt: 1, ...over,
});

/** checkpoints 的 fail() 是抛 MentorError（带 .code），不是返回 {ok:false} */
function expectFail(fn, allowedCodes) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "应当抛错，但没有抛");
  assert.ok(
    allowedCodes.includes(caught.code),
    `错误码 ${caught.code} 不在允许集合 ${allowedCodes.join("/")}；消息：${caught.message}`,
  );
  return caught;
}

/* ------------------------------------------------------------------ G1 */
test("G1 审查有效身份：非最新 job 与新 job 并存时，旧 job 提交裁决被拒（E_REVIEW_STALE）", () => {
  const oldJob = job({ id: "job_old", sessionId: "reviewer-old" });
  const newJob = job({ id: "job_new", sessionId: "reviewer-new" });
  const store = createMemoryStore(baseTask({ reviewJobs: [oldJob, newJob] }));

  expectFail(() => applyBoundReview(store, {
    reviewJobId: "job_old", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1,
    verdict: "pass", checks: [],
  }, "reviewer-old"), ["E_REVIEW_STALE"]);

  // 最新 job 未被污染
  const after = store.get();
  assert.equal(after.reviewJobs.find((j) => j.id === "job_new").status, "running");
  assert.equal(after.reviewJobs.find((j) => j.id === "job_old").status, "running");
});

test("G1 审查有效身份：状态 failed 的 job 由主会话提交被拒（要人工 waiver）", () => {
  const failed = job({ id: "job_failed", sessionId: "reviewer-x", status: "failed", error: "boom" });
  const store = createMemoryStore(baseTask({ reviewJobs: [failed] }));

  expectFail(() => applyBoundReview(store, {
    reviewJobId: "job_failed", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1,
    verdict: "pass", checks: [],
  }, "main-s3"), ["E_SELF_REVIEW_UNAUTHORIZED", "E_REVIEW_IDENTITY", "E_REVIEW_STALE"]);

  assert.equal(store.get().reviewJobs[0].status, "failed", "失败的 job 不该被这次调用推进");
});

/* ------------------------------------------------------------------ G2 */
test("G2 终态保护：updateRuntimeReview 不改写已 completed 的 status 与 verdict", () => {
  const store = createMemoryStore(baseTask({
    reviewJobs: [job({ id: "job_done", status: "completed", verdict: "pass", reviewId: "rev_1" })],
  }));

  updateRuntimeReview(store, "task_s3", { id: "job_done" }, { status: "failed", error: "watchdog-after-accept" });

  const after = store.get().reviewJobs[0];
  assert.equal(after.status, "completed", "已完成的 job 不该被改成 failed");
  assert.equal(after.verdict, "pass", "已接受裁决不该被覆盖");
  assert.equal(after.error, undefined, "guard 生效时不应写入新的 error");
});

test("G2 终态保护：updateRuntimeReview 不改写已 failed 的 job 状态", () => {
  const store = createMemoryStore(baseTask({
    reviewJobs: [job({ id: "job_failed", status: "failed", error: "original" })],
  }));

  updateRuntimeReview(store, "task_s3", { id: "job_failed" }, { status: "completed", verdict: "pass" });

  const after = store.get().reviewJobs[0];
  assert.equal(after.status, "failed", "失败的 job 不该被改成 completed");
  assert.equal(after.verdict, undefined, "不该凭空写上 verdict");
  assert.equal(after.error, "original", "原失败原因应保留");
});

test("G2 终态保护：非终态 job 仍可被改成 failed（对照组，证明 guard 不是一刀切）", () => {
  const store = createMemoryStore(baseTask({ reviewJobs: [job({ id: "job_run", status: "running" })] }));

  updateRuntimeReview(store, "task_s3", { id: "job_run" }, { status: "failed", error: "boom" });

  const after = store.get().reviewJobs[0];
  assert.equal(after.status, "failed");
  assert.equal(after.error, "boom");
});

test("G2 终态保护：已 completed 时其它字段（runtimeWarning）仍能落库，只挡 status", () => {
  const store = createMemoryStore(baseTask({
    reviewJobs: [job({ id: "job_done", status: "completed", verdict: "pass" })],
  }));

  updateRuntimeReview(store, "task_s3", { id: "job_done" },
    { runtimeWarning: { message: "reviewer-forbidden-tool:ego_cli", at: 123 } });

  const after = store.get().reviewJobs[0];
  assert.equal(after.status, "completed", "status 不动");
  assert.equal(after.runtimeWarning.message, "reviewer-forbidden-tool:ego_cli", "告警要能落库");
  assert.equal(after.runtimeWarning.at, 123);
});

test("G2 终态保护：applyBoundReview 对已 completed 的 job 二次裁决只回幂等", () => {
  const done = job({ id: "job_done2", status: "completed", verdict: "pass", reviewId: "rev_2" });
  const store = createMemoryStore(baseTask({ reviewJobs: [done] }));

  const out = applyBoundReview(store, {
    reviewJobId: "job_done2", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1,
    verdict: "revise", checks: [],
  }, "reviewer-1");

  assert.equal(out.ok, true);
  assert.equal(out.value.duplicate, true, "应走幂等返回");
  assert.equal(out.value.verdict, "pass", "幂等返回应回原裁决");
  const after = store.get().reviewJobs[0];
  assert.equal(after.status, "completed");
  assert.equal(after.verdict, "pass");
});

/* ------------------------------------------------------------------ G3 */
test("G3 读取凭据：没有可读的 queued/running job 时不登记 readAt", () => {
  const store = createMemoryStore(baseTask({
    reviewJobs: [job({ id: "job_done", status: "completed", verdict: "pass" })],
  }));

  recordReviewRead(store, "reviewer-1");

  assert.equal(store.get().reviewJobs[0].readAt, undefined, "已完成的 job 不该被登记为已读");
});

test("G3 读取凭据：仍 queued/running 的本会话 job 才登记 readAt，且 stageId 只匹配对应阶段", () => {
  const s1Job = job({ id: "job_s1", stageId: "s1", sessionId: "reviewer-1", status: "running" });
  const s2Job = job({ id: "job_s2", stageId: "s2", sessionId: "reviewer-1", status: "running" });
  const store = createMemoryStore(baseTask({ reviewJobs: [s1Job, s2Job] }));

  recordReviewRead(store, "reviewer-1", { stageId: "s2" });

  const jobs = store.get().reviewJobs;
  assert.equal(typeof jobs.find((j) => j.id === "job_s2").readAt, "number", "s2 的 job 应被登记");
  assert.equal(jobs.find((j) => j.id === "job_s1").readAt, undefined, "s1 的 job 不该被登记");
});

test("G3 读取凭据：别的会话读不算本审查的已读", () => {
  const store = createMemoryStore(baseTask({
    reviewJobs: [job({ id: "job_1", sessionId: "reviewer-1", status: "running" })],
  }));

  recordReviewRead(store, "someone-else");

  assert.equal(store.get().reviewJobs[0].readAt, undefined);
});

/* ------------------------------------------------------------------ G4 */
test("G4 快照收窄：默认 reviewJobs 去掉 outputText 正文，超过 12 条截断并回带 total/truncated", () => {
  const many = Array.from({ length: 15 }, (_, i) => job({
    id: `job_${i}`, status: "completed", verdict: "pass", outputText: "x".repeat(500),
  }));
  const store = createMemoryStore(baseTask({ reviewJobs: many }));

  const payload = runtimePayload(null, store, null, {});

  assert.equal(payload.reviewJobs.length, 12, "默认只回最近 12 条");
  assert.equal(payload.reviewJobTotal, 15);
  assert.equal(payload.reviewJobsTruncated, true);
  for (const j of payload.reviewJobs) {
    assert.equal(j.outputText, undefined, "默认快照不带 outputText 正文");
    assert.equal(typeof j.outputLength, "number", "应回带 outputLength 供判断");
    assert.equal(j.outputOmitted, true);
  }
});

test("G4 快照收窄：reviewJobId 精确查询只回单条，不附带整快照", () => {
  const many = Array.from({ length: 5 }, (_, i) => job({ id: `job_${i}`, status: "completed" }));
  const store = createMemoryStore(baseTask({ reviewJobs: many }));

  const payload = runtimePayload(null, store, null, { reviewJobId: "job_3" });

  assert.equal(payload.reviewJobOnly, true);
  assert.equal(payload.found, true);
  assert.equal(payload.reviewJob.id, "job_3");
  assert.equal(payload.reviewJobs, undefined, "精确查询不该带 reviewJobs 列表");
  assert.equal(payload.nodeRuns, undefined, "精确查询不该带整快照");
});

/* ------------------------------------------------------------------ G5 */
test("G5 告警可见：job 已 completed 后记录的越界告警，出现在 mentor_task_status 顶层 alerts", async () => {
  const { ctx, registered } = makeCtx();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "mentor-s3-g5-"));
  const out = await apply(ctx, { stateDir });
  const exec = newExec("main-g5");

  const create = registered.get("mentor_task_create");
  assert.ok(create, "mentor_task_create 应已注册");
  await create.execute({ objective: "g5", workspaceRoot: ROOT }, exec);

  const statusTool = registered.get("mentor_task_status");
  assert.ok(statusTool, "mentor_task_status 应已注册");

  // 直接往当前 store 里塞一个带 runtimeWarning 的 job（模拟看门狗在裁决后写告警）
  const store = out.store;
  const task = store.get();
  store.set({
    ...task,
    reviewJobs: [
      { id: "job_ok", kind: "stage", stageId: "s1", attempt: 1, status: "completed", verdict: "pass" },
      { id: "job_warn", kind: "stage", stageId: "s2", attempt: 1, status: "completed", verdict: "pass",
        runtimeWarning: { message: "reviewer-forbidden-tool:ego_cli", at: 1794566000000 } },
    ],
  });

  const res = JSON.parse(await statusTool.execute({}, exec));
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.value.alerts), "顶层应出现 alerts 数组");
  assert.equal(res.value.alerts.length, 1);
  assert.equal(res.value.alerts[0].reviewJobId, "job_warn");
  assert.equal(res.value.alerts[0].message, "reviewer-forbidden-tool:ego_cli");
  assert.equal(res.value.alerts[0].stageId, "s2");

  // 无告警时不应凭空多出 alerts 字段
  store.set({ ...store.get(), reviewJobs: [{ id: "job_ok2", kind: "stage", stageId: "s1", attempt: 1, status: "completed" }] });
  const res2 = JSON.parse(await statusTool.execute({}, exec));
  assert.equal(res2.value.alerts, undefined, "没有 runtimeWarning 时不应挂 alerts");
});

/* ------------------------------------------------------------------ G6 */
/**
 * G6 走真实启动路径：apply() 里对 store.all() 的循环才是被修的地方。
 * 造一个 stateDir，第一次启动建任务并改成目标 phase，第二次用同 stateDir 启动，
 * 看重启后 revision 有没有被试恢复逻辑推进。
 */
async function restartWith(phase) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `mentor-s3-g6-${phase}-`));
  const a = makeCtx();
  const out1 = await apply(a.ctx, { stateDir });
  const exec = newExec(`main-g6-${phase}`);
  await a.registered.get("mentor_task_create").execute({ objective: "g6", workspaceRoot: ROOT }, exec);
  const store1 = out1.store;

  // phase 只能走 setPhase（转移表见 src/state/machine.js）
  if (phase === "archived") {
    setPhase(store1, "archived");
  } else if (phase === "completed") {
    setPhase(store1, "active");
    setPhase(store1, "reviewing");
    setPhase(store1, "completed");
  } else if (phase === "planning") {
    // 建任务后本来就是 planning，不需要转移
  } else if (phase === "paused") {
    setPhase(store1, "paused");
  } else if (phase === "reviewing") {
    setPhase(store1, "active");
    setPhase(store1, "reviewing");
  } else {
    setPhase(store1, "active");
  }

  const base = store1.get();
  // 造「重启时还有在途工作」的现场：revision 固定为 7 便于比对
  store1.set({
    ...base,
    revision: 7,
    reviewJobs: [{ id: "jr", kind: "stage", stageId: "s1", attempt: 1, planVersion: base.planVersion ?? 1, sessionId: "rv", status: "running", startedAt: 1, updatedAt: 1 }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "running" }],
  });
  const id = store1.get().id;
  await store1.flush?.();

  const b = makeCtx();
  const out2 = await apply(b.ctx, { stateDir });
  const restored = out2.store.all().map((s) => s.get()).filter(Boolean).find((t) => t.id === id);
  assert.ok(restored, `应能重新加载任务 ${id}`);
  return restored;
}

test("G6 启动跳过终态：再次启动不重写 archived 任务（revision 与在途状态都不变）", async () => {
  const archived = await restartWith("archived");
  assert.equal(archived.phase, "archived");
  assert.equal(archived.revision, 7, "归档任务重启后 revision 不该 +1");
  assert.equal(archived.reviewJobs[0].status, "running", "归档任务的在途审查不该被标失败");
  assert.equal(archived.nodeRuns[0].status, "running", "归档任务的节点不该被返工");
});

test("G6 启动跳过终态：completed 同样跳过", async () => {
  const done = await restartWith("completed");
  assert.equal(done.phase, "completed");
  assert.equal(done.revision, 7, "已完成任务重启后 revision 不该 +1");
  assert.equal(done.reviewJobs[0].status, "running");
});

test("G6 启动跳过终态：对照组 active 任务仍被恢复（revision+1，在途审查标失败、节点返工）", async () => {
  const active = await restartWith("active");
  assert.equal(active.phase, "active");
  assert.equal(active.revision, 8, "非终态任务应被恢复并 revision+1");
  assert.equal(active.reviewJobs[0].status, "failed", "在途审查应被标失败");
  assert.equal(active.nodeRuns[0].status, "rework", "在途节点应返工");
  assert.equal(active.nodeRuns[0].attempt, 2, "返工后 attempt 应 +1");
});

test("G6 启动跳过终态：对照组 planning 任务仍被恢复", async () => {
  const planning = await restartWith("planning");
  assert.equal(planning.phase, "planning");
  assert.equal(planning.revision, 8, "planning 不是终态，应被恢复并 revision+1");
  assert.equal(planning.reviewJobs[0].status, "failed");
  assert.equal(planning.nodeRuns[0].status, "rework");
});

test("G6 启动跳过终态：对照组 paused 任务仍被恢复", async () => {
  const paused = await restartWith("paused");
  assert.equal(paused.phase, "paused");
  assert.equal(paused.revision, 8, "paused 不是终态，应被恢复并 revision+1");
  assert.equal(paused.reviewJobs[0].status, "failed");
  assert.equal(paused.nodeRuns[0].status, "rework");
});

test("G6 启动跳过终态：对照组 reviewing 任务仍被恢复", async () => {
  const reviewing = await restartWith("reviewing");
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.revision, 8, "reviewing 不是终态，应被恢复并 revision+1");
  assert.equal(reviewing.reviewJobs[0].status, "failed");
  assert.equal(reviewing.nodeRuns[0].status, "rework");
  assert.equal(reviewing.nodeRuns[0].attempt, 2);
});

/* ------------------------------------------------------- G7（真机复现的补丁） */
test("G7 唤醒守卫：任务已 completed 后不再投递新的审查唤醒", async () => {
  const store = createMemoryStore(baseTask({
    phase: "completed",
    mainSessionId: "main-s3",
    reviewJobs: [],
    wakeDispatches: [],
  }));

  const out = await wakeMain({}, store, {
    kind: "stage", stageId: "s1", attempt: 1, verdict: "pass", planVersion: 1,
  }, { enabled: true });

  assert.equal(out.queued, false, "已 completed 的任务不该再被唤醒");
  assert.equal(out.reason, "task-inactive");
});

test("G7 唤醒守卫：非终态任务仍会尝试唤醒（对照组，证明守卫不是一刀切）", async () => {
  for (const phase of ["active", "reviewing"]) {
    const store = createMemoryStore(baseTask({ phase, mainSessionId: "main-s3", wakeDispatches: [] }));
    const out = await wakeMain({}, store, {
      kind: "stage", stageId: "s1", attempt: 1, verdict: "pass", planVersion: 1,
    }, { enabled: true });
    assert.notEqual(out.reason, "task-inactive", `${phase} 不该被判成 task-inactive，实际 ${out.reason}`);
  }
});

/* --------------------------------------------- G8（2026-11-24 工具死锁回归） */
/**
 * 真机现象：新会话建完任务后，nextStep.allowedActions 指向 mentor_plan_submit 与
 * mentor_task_clear，但这两个工具都不在工具表里，任务永久停在 planning。
 *
 * 协议根因：宿主在会话开始时对 tools.register 的 when 求值一次，之后不随任务创建
 * 重算。会话开始时任务尚未创建，task 必为 null；原实现 `if (!task) return
 * name === "mentor_task_create"` 于是把流程工具全部剪掉，之后无法恢复。
 *
 * 修复：task 为 null 时主会话一律放行，动作合法性交给 handlers.js 的 requireTask
 * （无任务 → E_NO_TASK + hint）与 taskCreate（进行中任务 → E_TASK_EXISTS）。
 */
test("G8 工具可见性：task=null 时主会话能看全部流程工具（含 plan_submit / task_clear）", () => {
  const sid = "main-g8";
  const flowTools = [
    "mentor_plan_submit",
    "mentor_plan_amend",
    "mentor_stage_report",
    "mentor_completion_request",
    "mentor_finding_respond",
    "mentor_review_apply",
    "mentor_rework_stage",
    "mentor_delegate_nodes",
    "mentor_node_start",
    "mentor_task_approve",
    "mentor_task_pause",
    "mentor_task_resume",
    "mentor_task_clear",
    "mentor_task_off",
    "mentor_task_on",
    "mentor_team_start",
    "mentor_team_note",
    "mentor_team_context",
    "mentor_team_direction",
  ];
  for (const name of flowTools) {
    assert.equal(
      mentorToolVisible(name, null, sid, null),
      true,
      `task=null 时 ${name} 必须可见，否则任务建成即死锁`,
    );
  }
  // 无任务时本就该可见的四件套，一并锁住
  for (const name of ["mentor_task_create", "mentor_task_status", "mentor_work_mode", "mentor_verify_review_recovery"]) {
    assert.equal(mentorToolVisible(name, null, sid, null), true, `task=null 时 ${name} 必须可见`);
  }
});

test("G8 工具可见性：task=null 时仍守原有边界（无会话身份 / waive）", () => {
  assert.equal(mentorToolVisible("mentor_plan_submit", null, undefined, null), false, "没有 sid 时不该放行");
  assert.equal(mentorToolVisible("mentor_plan_submit", null, "", null), false, "空 sid 时不该放行");
  assert.equal(mentorToolVisible("mentor_task_create", null, null, null), false, "sid 为 null 时不该放行");
  assert.equal(mentorToolVisible("mentor_review_waive", null, "main-g8", null), false, "review_waive 永远不可见");
});

test("G8 工具可见性：task=null 放宽后，reviewer / worker 的收窄未被破坏", () => {
  const other = {
    id: "task-g8",
    mainSessionId: "main-owner",
    phase: "active",
    planVersion: 1,
    revision: 1,
    reviewJobs: [{ sessionId: "sess-reviewer", status: "running", planVersion: 1 }],
    nodeRuns: [],
  };
  assert.equal(mentorToolVisible("mentor_task_status", other, "sess-reviewer", null), true, "reviewer 能看状态");
  assert.equal(mentorToolVisible("mentor_review_apply", other, "sess-reviewer", null), true, "reviewer 能交裁决");
  assert.equal(mentorToolVisible("mentor_plan_submit", other, "sess-reviewer", null), false, "reviewer 不能提计划");
  assert.equal(mentorToolVisible("mentor_stage_report", other, "sess-reviewer", null), false, "reviewer 不能上报表阶段");
  assert.equal(mentorToolVisible("mentor_plan_submit", other, "sess-stranger", null), false, "陌生人不能提计划");
  assert.equal(mentorToolVisible("mentor_task_status", other, "sess-stranger", null), false, "陌生人不能看状态");
});
