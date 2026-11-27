import test from "node:test";
import assert from "node:assert/strict";

import {
  assertAttemptCurrent,
  assertDependenciesReady,
  findCycle,
  findWritePathConflicts,
  readyNodes,
  topoSort,
  validatePlan,
} from "../src/plan/dag.js";
import { ERR, MentorError } from "../src/errors.js";

/** 一个合法的三阶段计划：a → b → c，其中 b 与 c 都依赖 a 的后续关系 */
function goodPlan() {
  return {
    criteria: [
      { id: "c1", text: "第一条" },
      { id: "c2", text: "第二条" },
    ],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["src/one.js"] },
      { id: "b", criterionIds: ["c2"], dependsOn: ["a"], writePaths: ["src/two.js"] },
      { id: "c", criterionIds: ["c2"], dependsOn: ["b"], writePaths: ["src/three.js"] },
    ],
  };
}

const codes = (r) => r.errors.map((e) => e.code);

test("合法计划通过校验", () => {
  const r = validatePlan(goodPlan());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("plan 缺数组时给 E_EMPTY_PLAN", () => {
  assert.equal(validatePlan({}).ok, false);
  assert.deepEqual(codes(validatePlan({})), [ERR.EMPTY_PLAN]);
});

test("stages 为空时给 E_EMPTY_PLAN", () => {
  const r = validatePlan({ criteria: [{ id: "c1" }], stages: [] });
  assert.deepEqual(codes(r), [ERR.EMPTY_PLAN]);
});

test("stage id 重复 → E_STAGE_DUP", () => {
  const p = goodPlan();
  p.stages[2].id = "a";
  const r = validatePlan(p);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes(ERR.STAGE_DUP));
});

test("criterionIds 为空 → E_CRITERION_UNKNOWN", () => {
  const p = goodPlan();
  p.stages[0].criterionIds = [];
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.CRITERION_UNKNOWN));
});

test("引用不存在的 criterion → E_CRITERION_UNKNOWN", () => {
  const p = goodPlan();
  p.stages[0].criterionIds = ["nope"];
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.CRITERION_UNKNOWN));
  assert.ok(r.errors.some((e) => e.details?.criterionId === "nope"));
});

test("criterion 无人引用 → E_CRITERION_ORPHAN", () => {
  const p = goodPlan();
  p.criteria.push({ id: "c3", text: "没人管" });
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.CRITERION_ORPHAN));
  assert.ok(r.errors.some((e) => e.details?.criterionId === "c3"));
});

test("dependsOn 指向不存在的 stage → E_DEP_UNKNOWN", () => {
  const p = goodPlan();
  p.stages[1].dependsOn = ["ghost"];
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.DEP_UNKNOWN));
});

test("自依赖 → E_DEP_CYCLE", () => {
  const p = goodPlan();
  p.stages[0].dependsOn = ["a"];
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.DEP_CYCLE));
});

test("两节点环 → E_DEP_CYCLE 且 details.cycle 给出环", () => {
  const p = {
    criteria: [{ id: "c1" }],
    stages: [
      { id: "x", criterionIds: ["c1"], dependsOn: ["y"] },
      { id: "y", criterionIds: ["c1"], dependsOn: ["x"] },
    ],
  };
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.DEP_CYCLE));
  const e = r.errors.find((x) => x.code === ERR.DEP_CYCLE && x.details?.cycle);
  assert.ok(Array.isArray(e.details.cycle));
  assert.ok(e.details.cycle.length >= 3, "环序列应含首尾重复");
});

test("全部有依赖（无入口）→ E_NO_ENTRY", () => {
  const p = {
    criteria: [{ id: "c1" }],
    stages: [
      { id: "x", criterionIds: ["c1"], dependsOn: ["y"] },
      { id: "y", criterionIds: ["c1"], dependsOn: ["x"] },
    ],
  };
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.NO_ENTRY));
});

test("多个问题一次全给，不在第一个错误处停", () => {
  const p = {
    criteria: [{ id: "c1" }, { id: "c2" }],
    stages: [
      { id: "a", criterionIds: ["ghost"], dependsOn: [] },
      { id: "a", criterionIds: ["c1"], dependsOn: [] },
    ],
  };
  const r = validatePlan(p);
  const c = codes(r);
  assert.ok(c.includes(ERR.STAGE_DUP), "应报重复 id");
  assert.ok(c.includes(ERR.CRITERION_UNKNOWN), "应报未知 criterion");
  assert.ok(c.includes(ERR.CRITERION_ORPHAN), "应报孤儿 criterion c2");
  assert.ok(r.errors.length >= 3);
});

// ---------------- writePaths ----------------

test("writePaths 冲突：无依赖关系的两个 stage 抢同一路径", () => {
  const p = {
    criteria: [{ id: "c1" }],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["same.js"] },
      { id: "b", criterionIds: ["c1"], dependsOn: [], writePaths: ["same.js"] },
    ],
  };
  const r = validatePlan(p);
  assert.ok(codes(r).includes(ERR.WRITEPATH_CONFLICT));
  const e = r.errors.find((x) => x.code === ERR.WRITEPATH_CONFLICT);
  assert.equal(e.details.path, "same.js");
});

test("writePaths 允许：有传递依赖关系的两个 stage 可写同一路径（串行）", () => {
  const p = {
    criteria: [{ id: "c1" }],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["same.js"] },
      { id: "b", criterionIds: ["c1"], dependsOn: ["a"], writePaths: ["same.js"] },
    ],
  };
  const r = validatePlan(p);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("findWritePathConflicts 直接调用也返回空（无冲突时）", () => {
  const p = goodPlan();
  const ids = new Set(p.stages.map((s) => s.id));
  assert.deepEqual(findWritePathConflicts(p.stages, ids), []);
});

test("findCycle 对无环计划返回空数组", () => {
  const p = goodPlan();
  assert.deepEqual(findCycle(p.stages, new Set(p.stages.map((s) => s.id))), []);
});

// ---------------- 拓扑序 ----------------

test("topoSort 把依赖排在前", () => {
  const order = topoSort(goodPlan().stages).map((s) => s.id);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("topoSort 遇环抛 E_DEP_CYCLE", () => {
  const stages = [
    { id: "x", dependsOn: ["y"] },
    { id: "y", dependsOn: ["x"] },
  ];
  assert.throws(
    () => topoSort(stages),
    (e) => e instanceof MentorError && e.code === ERR.DEP_CYCLE,
  );
});

// ---------------- 就绪节点 ----------------

test("readyNodes：只有入口节点就绪", () => {
  assert.deepEqual(readyNodes(goodPlan().stages, []), ["a"]);
});

test("readyNodes：a 被接受后 b 就绪，c 未就绪", () => {
  const runs = [{ stageId: "a", attempt: 1, status: "accepted" }];
  assert.deepEqual(readyNodes(goodPlan().stages, runs), ["b"]);
});

test("readyNodes：a、b 都接受后 c 就绪", () => {
  const runs = [
    { stageId: "a", attempt: 1, status: "accepted" },
    { stageId: "b", attempt: 1, status: "accepted" },
  ];
  assert.deepEqual(readyNodes(goodPlan().stages, runs), ["c"]);
});

test("readyNodes：rework 状态不算接受", () => {
  const runs = [{ stageId: "a", attempt: 2, status: "rework" }];
  assert.deepEqual(readyNodes(goodPlan().stages, runs), ["a"]);
});

test("assertDependenciesReady：依赖未接受时抛 E_DEP_NOT_READY", () => {
  const stage = goodPlan().stages[1]; // b 依赖 a
  assert.throws(
    () => assertDependenciesReady(stage, []),
    (e) => e instanceof MentorError && e.code === ERR.DEP_NOT_READY,
  );
});

test("assertDependenciesReady：依赖已接受时通过", () => {
  const stage = goodPlan().stages[1];
  assert.doesNotThrow(() =>
    assertDependenciesReady(stage, [
      { stageId: "a", attempt: 1, status: "accepted" },
    ]),
  );
});

// ---------------- attempt 一致性 ----------------

test("assertAttemptCurrent：首次报告 attempt=1 通过", () => {
  assert.doesNotThrow(() => assertAttemptCurrent("a", 1, []));
});

test("assertAttemptCurrent：attempt 不匹配抛 E_STALE_ATTEMPT", () => {
  const runs = [{ stageId: "a", attempt: 2, status: "rework" }];
  assert.throws(
    () => assertAttemptCurrent("a", 1, runs),
    (e) => e instanceof MentorError && e.code === ERR.STALE_ATTEMPT,
  );
});

test("assertAttemptCurrent：匹配当前 attempt 通过", () => {
  const runs = [{ stageId: "a", attempt: 2, status: "rework" }];
  assert.doesNotThrow(() => assertAttemptCurrent("a", 2, runs));
});
