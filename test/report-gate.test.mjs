/**
 * 报告门禁测试（s3）。
 *
 * 覆盖 SPEC §2.6 门槛二：未响应 finding 拦截、responded 放行、
 * planVersion 缺失/非法/陈旧/相等 四态。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GATE_CODE,
  assertReportAllowed,
  unrespondedFindings,
} from "../src/review/report-gate.js";

/* ------------------------------ 夹具 ------------------------------ */

const mkFinding = (id, status, { responses = [] } = {}) => ({
  id,
  status,
  severity: "blocking",
  text: `问题 ${id}`,
  responses,
});

const taskWith = ({ findings = [], planVersion = 2 } = {}) => ({
  id: "task_x",
  phase: "reviewing",
  planVersion,
  findings,
});

/* --------------------------- unrespondedFindings --------------------------- */

test("G1 open 且无响应 → 列入旧账", () => {
  const list = unrespondedFindings(taskWith({ findings: [mkFinding("f1", "open"), mkFinding("f2", "open")] }));
  assert.deepEqual(list.map((f) => f.id), ["f1", "f2"]);
  assert.equal(list[0].severity, "blocking");
});

test("G2 responded 不算旧账（响应了允许继续推进）", () => {
  const list = unrespondedFindings(
    taskWith({ findings: [mkFinding("f1", "responded", { responses: [{ id: "r1" }] })] }),
  );
  assert.deepEqual(list, []);
});

test("G3 closed 不算旧账；open 但已有 responses 也不算", () => {
  const list = unrespondedFindings(
    taskWith({
      findings: [
        mkFinding("f1", "closed", { responses: [{ id: "r1" }] }),
        mkFinding("f2", "open", { responses: [{ id: "r2" }] }),
      ],
    }),
  );
  assert.deepEqual(list, []);
});

test("G4 历史数据缺 responses 字段时按未响应处理（保守）", () => {
  const legacy = { id: "f_old", status: "open", severity: "advisory", text: "老账" };
  assert.deepEqual(unrespondedFindings({ findings: [legacy] }).map((f) => f.id), ["f_old"]);
});

test("G5 task 没有 findings 字段 → 空数组，不抛错", () => {
  assert.deepEqual(unrespondedFindings({}), []);
  assert.deepEqual(unrespondedFindings(null), []);
});

/* --------------------------- assertReportAllowed --------------------------- */

test("G6 有未响应 finding → E_UNRESPONDED_FINDINGS 且带全部 id", () => {
  const task = taskWith({ findings: [mkFinding("f1", "open"), mkFinding("f2", "open"), mkFinding("f3", "responded", { responses: [{ id: "r" }] })] });
  assert.throws(
    () => assertReportAllowed(task, { planVersion: 2 }),
    (err) =>
      err.code === GATE_CODE.UNRESPONDED_FINDINGS &&
      JSON.stringify(err.details.findingIds) === JSON.stringify(["f1", "f2"]),
  );
});

test("G7 旧账清完 + planVersion 相符 → 放行，并回带 responded 计数", () => {
  const task = taskWith({
    findings: [
      mkFinding("f1", "responded", { responses: [{ id: "r1" }] }),
      mkFinding("f2", "closed", { responses: [{ id: "r2" }] }),
    ],
    planVersion: 3,
  });
  const out = assertReportAllowed(task, { planVersion: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.planVersion, 3);
  assert.equal(out.respondedUnverified, 1);
});

test("G8 planVersion 缺失 → E_STALE_PLAN", () => {
  assert.throws(
    () => assertReportAllowed(taskWith(), {}),
    (err) => err.code === GATE_CODE.STALE_PLAN && err.details.expected === 2,
  );
});

test("G9 planVersion 非法（0 / 小数 / 字符串）→ E_STALE_PLAN", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    assert.throws(
      () => assertReportAllowed(taskWith(), { planVersion: bad }),
      (err) => err.code === GATE_CODE.STALE_PLAN,
      `planVersion=${String(bad)} 应被拒`,
    );
  }
});

test("G10 planVersion 陈旧 → E_STALE_PLAN 且 details 带 expected/got", () => {
  assert.throws(
    () => assertReportAllowed(taskWith({ planVersion: 5 }), { planVersion: 3 }),
    (err) =>
      err.code === GATE_CODE.STALE_PLAN && err.details.expected === 5 && err.details.got === 3,
  );
});

test("G11 任务自身没有 planVersion → E_STALE_PLAN 且提示先提交计划", () => {
  assert.throws(
    () => assertReportAllowed({ findings: [] }, { planVersion: 1 }),
    (err) => err.code === GATE_CODE.STALE_PLAN && /先 mentor_plan_submit/u.test(err.message),
  );
});

test("G12 task 为空 → E_STALE_PLAN（不抛裸异常）", () => {
  assert.throws(
    () => assertReportAllowed(null, { planVersion: 1 }),
    (err) => err.code === GATE_CODE.STALE_PLAN,
  );
});

test("G13 旧账优先于版本判定：两样都错时报未响应 finding", () => {
  const task = taskWith({ findings: [mkFinding("f1", "open")], planVersion: 4 });
  assert.throws(
    () => assertReportAllowed(task, { planVersion: 1 }),
    (err) => err.code === GATE_CODE.UNRESPONDED_FINDINGS,
  );
});
