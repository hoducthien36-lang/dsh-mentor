/**
 * 并行委派核心测试（s1）。
 *
 * 覆盖：上限边界（默认/1/16/0/17/非整数）、批次形状（空/重复/未就绪/不存在）、
 * 写域冲突（相同路径/目录前缀/无关路径）、R1~R7 回滚表（重点是 R5 不重试）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_PARALLEL,
  FAILURE_POINTS,
  MAX_PARALLEL,
  MIN_PARALLEL,
  PARALLEL_CODE,
  assertDisjointWritePaths,
  findWriteConflicts,
  normalizeMaxParallel,
  pathsOverlap,
  planBatch,
  rollbackFor,
  validateBatch,
} from "../src/tools/parallel.js";

/* --------------------------- 1. 上限 --------------------------- */

test("P1 未传上限取默认 8", () => {
  assert.equal(normalizeMaxParallel(undefined), DEFAULT_MAX_PARALLEL);
  assert.equal(normalizeMaxParallel(null), DEFAULT_MAX_PARALLEL);
  // v0.2.0：默认并发由 4 上调为 8（src/tools/parallel.js:16），
  // 与 cordis.patch.yml 的 maxParallelNodes: 8 对齐 —— 两处必须同一个数。
  assert.equal(DEFAULT_MAX_PARALLEL, 8);
});

test("P2 边界 1 与 16 合法，0 / 17 / 非整数 / 字符串拒收", () => {
  assert.equal(normalizeMaxParallel(MIN_PARALLEL), 1);
  assert.equal(normalizeMaxParallel(MAX_PARALLEL), 16);
  for (const bad of [0, -1, 17, 2.5, "4", true]) {
    assert.throws(
      () => normalizeMaxParallel(bad),
      (err) =>
        err.code === PARALLEL_CODE.LIMIT &&
        err.details.min === 1 &&
        err.details.max === 16,
      `maxParallel=${String(bad)} 应拒收`,
    );
  }
});

/* --------------------------- 2. 批形状 --------------------------- */

const PLAN = [
  { id: "s1", writePaths: ["src/a.js"] },
  { id: "s2", writePaths: ["src/b.js", "docs/x.md"] },
  { id: "s3", writePaths: ["src/c.js"], dependsOn: ["s1"] },
];

test("P3 空数组 / 非数组拒收", () => {
  for (const bad of [[], undefined, "s1"]) {
    assert.throws(
      () => validateBatch({ stageIds: bad, readyNodeIds: ["s1"], stages: PLAN }),
      (err) => err.code === PARALLEL_CODE.BATCH,
    );
  }
});

test("P4 重复 id 拒收", () => {
  assert.throws(
    () => validateBatch({ stageIds: ["s1", "s1"], readyNodeIds: ["s1"], stages: PLAN }),
    (err) => err.code === PARALLEL_CODE.BATCH && /重复/u.test(err.message),
  );
});

test("P5 超过并发上限 → E_PARALLEL_LIMIT 且带 requested/limit", () => {
  assert.throws(
    () =>
      validateBatch({
        stageIds: ["s1", "s2"],
        readyNodeIds: ["s1", "s2"],
        stages: PLAN,
        maxParallel: 1,
      }),
    (err) =>
      err.code === PARALLEL_CODE.LIMIT &&
      err.details.requested === 2 &&
      err.details.limit === 1,
  );
});

test("P6 未就绪阶段拒收并列出 notReady", () => {
  assert.throws(
    () => validateBatch({ stageIds: ["s3"], readyNodeIds: ["s1"], stages: PLAN }),
    (err) =>
      err.code === PARALLEL_CODE.BATCH &&
      JSON.stringify(err.details.notReady) === JSON.stringify(["s3"]),
  );
});

test("P7 计划里不存在的阶段拒收并列出 unknown", () => {
  assert.throws(
    () => validateBatch({ stageIds: ["sX"], readyNodeIds: ["sX"], stages: PLAN }),
    (err) =>
      err.code === PARALLEL_CODE.BATCH &&
      JSON.stringify(err.details.unknown) === JSON.stringify(["sX"]),
  );
});

test("P8 正常批次去重后返回 stageIds 与 maxParallel", () => {
  const out = validateBatch({
    stageIds: ["s2", "s1"],
    readyNodeIds: ["s1", "s2"],
    stages: PLAN,
    maxParallel: 4,
  });
  assert.deepEqual(out.stageIds, ["s2", "s1"]);
  assert.equal(out.maxParallel, 4);
  assert.equal(out.stages.length, 2);
});

/* --------------------------- 3. 写域冲突 --------------------------- */

test("P9 pathsOverlap：相同路径、目录前缀、反斜杠归一 都算重叠", () => {
  assert.equal(pathsOverlap("src/a.js", "src/a.js"), true);
  assert.equal(pathsOverlap("src", "src/a.js"), true);
  assert.equal(pathsOverlap("src\\a.js", "src/a.js"), true);
  assert.equal(pathsOverlap("src/a.js", "src/b.js"), false);
});

test("P10 同批写同一文件 → E_WRITE_CONFLICT 且带冲突对", () => {
  const stages = [
    { id: "a", writePaths: ["lib/index.js"] },
    { id: "b", writePaths: ["lib/index.js"] },
  ];
  assert.throws(
    () => validateBatch({ stageIds: ["a", "b"], readyNodeIds: ["a", "b"], stages }),
    (err) =>
      err.code === PARALLEL_CODE.CONFLICT &&
      err.details.conflicts.length === 1 &&
      err.details.conflicts[0].aPath === "lib/index.js",
  );
});

test("P11 目录前缀也算冲突（旧版只认完全相等，这里更严）", () => {
  const stages = [
    { id: "a", writePaths: ["src"] },
    { id: "b", writePaths: ["src/review/review.js"] },
  ];
  assert.equal(findWriteConflicts(stages).length, 1);
});

test("P12 写域不相交可并行；没写 writePaths 的节点不参与冲突", () => {
  const stages = [
    { id: "a", writePaths: ["src/a.js"] },
    { id: "b", writePaths: ["src/b.js"] },
    { id: "c" },
  ];
  assert.deepEqual(findWriteConflicts(stages), []);
});

/* --------------------------- 4. 回滚表 --------------------------- */

test("P13 R1/R2 不动任务；R3/R4 回退阶段；R5 pause 且不重试", () => {
  const r1 = rollbackFor("R1");
  const r2 = rollbackFor("R2");
  const r3 = rollbackFor("R3");
  const r4 = rollbackFor("R4");
  const r5 = rollbackFor("R5");

  assert.equal(r1.touchTask, false);
  assert.equal(r2.touchTask, false);
  assert.equal(r3.rollbackStages, true);
  assert.equal(r4.cancelBatch, true);
  assert.equal(r5.pauseTask, true);
  assert.equal(r5.rollbackStages, false, "R5 保留证据，不回退阶段");
  assert.equal(r5.retry, false, "R5 不自动重试");
});

test("P14 R6 只丢结果不动任务不改 revision；R7 拦住上报", () => {
  const r6 = rollbackFor("R6");
  assert.equal(r6.dropResult, true);
  assert.equal(r6.touchTask, false);
  assert.equal(rollbackFor("R7").blockReport, true);
});

test("P15 未知失败点按最保守处理（不动任务、不重试）且标 known=false", () => {
  const r = rollbackFor("R99");
  assert.equal(r.known, false);
  assert.equal(r.retry, false);
  assert.equal(r.rollbackStages, false);
});

test("P16 七个失败点都有标签，不漏", () => {
  assert.equal(Object.keys(FAILURE_POINTS).length, 7);
  for (const k of Object.keys(FAILURE_POINTS)) {
    assert.equal(typeof rollbackFor(k).label, "string");
  }
});

/* --------------------------- 5. 批级回滚与写域断言（阶段说明点名的两个符号） --------------------------- */

test("P17 planBatch：空批→R1、全失败→R4 且 dispatchFailed、部分失败→R4 partial、全成功→R7", () => {
  assert.equal(planBatch([]).point, "R1");

  const allFail = planBatch([
    { stageId: "s1", ok: false },
    { stageId: "s2", ok: false },
  ]);
  assert.equal(allFail.point, "R4");
  assert.equal(allFail.dispatchFailed, true);
  assert.deepEqual(allFail.failed, ["s1", "s2"]);

  const partial = planBatch([
    { stageId: "s1", ok: true },
    { stageId: "s2", ok: false },
  ]);
  assert.equal(partial.point, "R4");
  assert.equal(partial.partial, true);
  assert.equal(partial.dispatchFailed, false);

  const ok = planBatch([{ stageId: "s1", ok: true }]);
  assert.equal(ok.point, "R7");
  assert.equal(ok.rollback.blockReport, true);
});

test("P18 assertDisjointWritePaths：无冲突返回 true，有冲突抛 E_WRITE_CONFLICT", () => {
  assert.equal(
    assertDisjointWritePaths([
      { id: "a", writePaths: ["src/a.js"] },
      { id: "b", writePaths: ["src/b.js"] },
    ]),
    true,
  );

  assert.throws(
    () =>
      assertDisjointWritePaths([
        { id: "a", writePaths: ["src/x.js"] },
        { id: "b", writePaths: ["src/x.js"] },
      ]),
    (err) => err.code === PARALLEL_CODE.CONFLICT && err.details.conflicts.length === 1,
  );
});
