import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASES,
  allowedNext,
  assertCompletionReady,
  canTransition,
  checkCompletionReadiness,
  createTask,
  isFinished,
  isTerminal,
  transition,
} from "../src/state/machine.js";
import { ERR, MentorError } from "../src/errors.js";

const OBJ = "clean-room 重写任务";

test("createTask 产出 planning 初始状态且 revision=1", () => {
  const t = createTask(OBJ, { id: "t1", createdAt: 1000 });
  assert.equal(t.id, "t1");
  assert.equal(t.phase, PHASES.PLANNING);
  assert.equal(t.revision, 1);
  assert.equal(t.objective, OBJ);
  assert.equal(t.planVersion, 0);
  assert.deepEqual(t.criteria, []);
  assert.deepEqual(t.stages, []);
  assert.equal(t.createdAt, 1000);
});

test("createTask 拒绝空 objective", () => {
  assert.throws(() => createTask(""), MentorError);
  assert.throws(() => createTask("   "), MentorError);
});

test("合法全路径 planning → active → reviewing → completed", () => {
  let t = createTask(OBJ, { createdAt: 1000 });

  t = transition(t, PHASES.ACTIVE, { planVersion: 1 });
  assert.equal(t.phase, PHASES.ACTIVE);
  assert.equal(t.planVersion, 1);

  t = transition(t, PHASES.REVIEWING);
  assert.equal(t.phase, PHASES.REVIEWING);

  t = transition(t, PHASES.COMPLETED);
  assert.equal(t.phase, PHASES.COMPLETED);
  assert.equal(t.revision, 4);
});

test("每次转移 revision +1 且不修改入参（不可变）", () => {
  const t1 = createTask(OBJ, { createdAt: 1000 });
  const t2 = transition(t1, PHASES.ACTIVE);
  assert.equal(t1.revision, 1);
  assert.equal(t1.phase, PHASES.PLANNING, "入参不被改动");
  assert.equal(t2.revision, 2);
});

test("planning 允许原地重入（计划退回修改）", () => {
  const t = createTask(OBJ, { createdAt: 1000 });
  const t2 = transition(t, PHASES.PLANNING);
  assert.equal(t2.phase, PHASES.PLANNING);
  assert.equal(t2.revision, 2);
});

test("reviewing 允许原地重入与退回 active", () => {
  let t = createTask(OBJ, { createdAt: 1000 });
  t = transition(t, PHASES.ACTIVE);
  t = transition(t, PHASES.REVIEWING);
  assert.ok(canTransition(PHASES.REVIEWING, PHASES.REVIEWING));
  assert.ok(canTransition(PHASES.REVIEWING, PHASES.ACTIVE));
  const back = transition(t, PHASES.ACTIVE);
  assert.equal(back.phase, PHASES.ACTIVE);
});

test("active 不能直接跳到 completed", () => {
  let t = createTask(OBJ, { createdAt: 1000 });
  t = transition(t, PHASES.ACTIVE);
  assert.equal(canTransition(PHASES.ACTIVE, PHASES.COMPLETED), false);
  assert.throws(
    () => transition(t, PHASES.COMPLETED),
    (e) => e instanceof MentorError && e.code === ERR.ILLEGAL_TRANSITION,
  );
});

test("completed 只能归档，其余出边全被拒绝", () => {
  // 2026-11-04 控制接口：completed 不再是绝对终态 —— 旧 supervisor 的 clear
  // 对已完成任务同样生效（source/lib/index.mjs:7152-7179 只挡了 pause），
  // 所以「做完的任务也能被 Clear 归档」必须成立。真终态是 archived。
  assert.deepEqual(allowedNext(PHASES.COMPLETED), [PHASES.ARCHIVED]);
  assert.equal(isTerminal(PHASES.COMPLETED), false, "completed 不是真终态");
  assert.equal(isTerminal(PHASES.ARCHIVED), true, "archived 才是真终态");
  assert.equal(isFinished(PHASES.COMPLETED), true, "但 completed 属于「不再推进」");

  for (const target of Object.values(PHASES)) {
    if (target === PHASES.ARCHIVED) continue;
    assert.equal(
      canTransition(PHASES.COMPLETED, target),
      false,
      `completed → ${target} 应被拒绝`,
    );
  }

  let t = createTask(OBJ, { createdAt: 1000 });
  t = transition(t, PHASES.ACTIVE);
  t = transition(t, PHASES.REVIEWING);
  t = transition(t, PHASES.COMPLETED);
  assert.throws(
    () => transition(t, PHASES.ACTIVE),
    (e) => e instanceof MentorError && e.code === ERR.ILLEGAL_TRANSITION,
  );
  // 但归档是允许的
  const archived = transition(t, PHASES.ARCHIVED);
  assert.equal(archived.phase, PHASES.ARCHIVED);
  // 归档之后才是真正的无出边
  assert.deepEqual(allowedNext(PHASES.ARCHIVED), []);
  assert.throws(
    () => transition(archived, PHASES.ACTIVE),
    (e) => e instanceof MentorError && e.code === ERR.ILLEGAL_TRANSITION,
  );
});

test("未知阶段名被拒绝", () => {
  const t = createTask(OBJ, { createdAt: 1000 });
  assert.throws(
    () => transition(t, "done"),
    (e) => e instanceof MentorError && e.code === ERR.ILLEGAL_TRANSITION,
  );
});

test("非法转移的错误 details 带上允许集合", () => {
  const t = createTask(OBJ, { createdAt: 1000 });
  try {
    transition(t, PHASES.COMPLETED);
    assert.fail("应当抛错");
  } catch (e) {
    assert.equal(e.code, ERR.ILLEGAL_TRANSITION);
    // planning 现在允许：自环、awaiting-approval、active（auto-approve 直通）、
    // paused（规划中途也能暂停）、archived
    assert.deepEqual(
      e.details.allowed.sort(),
      [
        PHASES.ARCHIVED,
        PHASES.AWAITING_APPROVAL,
        PHASES.ACTIVE,
        PHASES.PAUSED,
        PHASES.PLANNING,
      ].sort(),
    );
  }
});

// ---------------- 完成请求前置条件 ----------------

function baseReviewedTask(overrides = {}) {
  let t = createTask(OBJ, { createdAt: 1000 });
  t = transition(t, PHASES.ACTIVE, { planVersion: 1 });
  t = transition(t, PHASES.REVIEWING);
  return {
    ...t,
    // 校验以 stages 为准，所以基准任务必须有一个已 accepted 的阶段
    stages: [{ id: "s1", title: "阶段一", criterionIds: [], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted" }],
    findings: [],
    reviews: [{ id: "r1", verdict: "pass", findings: [] }],
    ...overrides,
  };
}

test("完成前置条件：全部满足时 ready=true", () => {
  const r = checkCompletionReadiness(baseReviewedTask());
  assert.equal(r.ok, true);
  assert.deepEqual(r.unmet, []);
});

test("完成前置条件：阶段未全部 accepted", () => {
  const task = baseReviewedTask({
    stages: [
      { id: "s1", title: "阶段一", criterionIds: [], dependsOn: [] },
      { id: "s2", title: "阶段二", criterionIds: [], dependsOn: ["s1"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "accepted" },
      { stageId: "s2", attempt: 1, status: "rework" },
    ],
  });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false);
  assert.ok(r.unmet.some((u) => u.code === "unmet_stage_not_accepted"));
});

test("完成前置条件：阶段从未上报过（nodeRuns 里没有记录）", () => {
  // v0.1.0 真实缺陷回归：只遍历 nodeRuns 会漏掉从未上报的阶段。
  // 场景来自 task_mvzibxpw：s1 已 accepted，s2 一次都没上报，旧逻辑放行完成。
  const task = baseReviewedTask({
    stages: [
      { id: "s1", title: "阶段一", criterionIds: [], dependsOn: [] },
      { id: "s2", title: "阶段二", criterionIds: [], dependsOn: ["s1"] },
    ],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted" }],
  });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false, "从未上报的阶段必须阻止完成");
  const item = r.unmet.find((u) => u.code === "unmet_stage_not_accepted");
  assert.ok(item, "应给出 unmet_stage_not_accepted");
  assert.match(item.message, /s2/, "提示里应点名未完成的阶段");
});

test("完成前置条件：计划里没有阶段", () => {
  const task = baseReviewedTask({ stages: [], nodeRuns: [] });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false);
  assert.ok(r.unmet.some((u) => u.code === "unmet_no_stages"));
});

test("完成前置条件：blocking finding 未关闭", () => {
  const task = baseReviewedTask({
    findings: [
      { id: "f1", severity: "blocking", status: "responded" },
    ],
  });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false);
  assert.ok(r.unmet.some((u) => u.code === ERR.BLOCKING_FINDING_OPEN));
  assert.throws(
    () => assertCompletionReady(task),
    (e) => e instanceof MentorError && e.code === ERR.BLOCKING_FINDING_OPEN,
  );
});

test("完成前置条件：advisory finding 未关闭不阻塞", () => {
  const task = baseReviewedTask({
    findings: [{ id: "f1", severity: "advisory", status: "open" }],
  });
  assert.equal(checkCompletionReadiness(task).ok, true);
});

test("完成前置条件：最近一次裁决不是 pass", () => {
  const task = baseReviewedTask({
    reviews: [{ id: "r1", verdict: "revise", findings: [] }],
  });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false);
  assert.ok(r.unmet.some((u) => u.code === "unmet_review_not_pass"));
});

test("完成前置条件：不在 reviewing 状态", () => {
  const task = baseReviewedTask({ phase: PHASES.ACTIVE });
  const r = checkCompletionReadiness(task);
  assert.equal(r.ok, false);
  assert.ok(r.unmet.some((u) => u.code === "unmet_not_reviewing"));
});

test("assertCompletionReady 在全部满足时不抛", () => {
  assert.doesNotThrow(() => assertCompletionReady(baseReviewedTask()));
});

/* ------------------------------------------------------------------ *
 * s2：PHASES.ACTIVE 自环（P2-6）
 * ------------------------------------------------------------------ */

test("active → active 是合法转移（P2-6）", () => {
  assert.equal(canTransition(PHASES.ACTIVE, PHASES.ACTIVE), true);

  const t = { id: "t", revision: 1, phase: PHASES.ACTIVE, criteria: [], stages: [], nodeRuns: [], findings: [], reviews: [] };
  const next = transition(t, PHASES.ACTIVE);
  assert.equal(next.phase, PHASES.ACTIVE);
  assert.equal(next.revision, 2, "自环也要推进 revision");
});