/**
 * 证据资格校验（改造 s4，矩阵 G7）。
 *
 * 旧实现要求 evidence_seqs 必须是审查会话真正读过的 seq，控制回执与失败结果排除。
 * mentor 的等价物：evidenceIds 必须是本任务真实产生过的证据 id
 * （阶段报告 / 审查 / 整改项），自由字符串一律拒收。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { collectEvidenceIds } from "../src/review/review.js";
import { PHASES } from "../src/state/machine.js";
import { gatedReport } from "./support/fixtures.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const STAGES = [{ id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] }];

/** 造一个「有 1 条报告 + 1 条审查 + 1 条 finding」的任务 */
function storeWithFinding() {
  const store = createMemoryStore();
  HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "证据资格测试" });
  HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages: STAGES });
  gatedReport(store, { stageId: "s1", attempt: 1, evidence: "第一版证据" });
  const rev = HANDLERS.mentor_review_apply(store, {
    stageId: "s1",
    attempt: 1,
    verdict: "revise",
    findings: ["证据太笼统"],
  });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  return store;
}

test("E1 collectEvidenceIds 收报告 id、审查 id、finding id", () => {
  const store = storeWithFinding();
  const task = store.get();
  const ids = collectEvidenceIds(task);
  const repId = task.nodeRuns[0].reports[0].id;
  const reviewId = task.reviews[0].id;
  const findingId = task.findings[0].id;
  for (const id of [repId, reviewId, findingId]) {
    assert.ok(ids.has(id), `${id} 应该在证据集合里`);
  }
});

test("E2 响应引用真实报告 id → 通过", () => {
  const store = storeWithFinding();
  const task = store.get();
  const repId = task.nodeRuns[0].reports[0].id;
  const findingId = task.findings[0].id;

  const r = HANDLERS.mentor_finding_respond(store, {
    findingId,
    summary: "已补具体证据",
    evidenceIds: [repId],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(store.get().findings[0].status, "responded");
});

test("E3 引用不存在的 id → E_EVIDENCE_UNKNOWN，且状态不变", () => {
  const store = storeWithFinding();
  const findingId = store.get().findings[0].id;

  const r = HANDLERS.mentor_finding_respond(store, {
    findingId,
    summary: "凭空捏造证据",
    evidenceIds: ["e-1", "随便编的"],
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "E_EVIDENCE_UNKNOWN");
  assert.deepEqual(r.details.unknown, ["e-1", "随便编的"]);
  assert.equal(store.get().findings[0].status, "open", "拒收时不许推进状态");
});

test("E4 不附证据仍然允许（响应可以不引用证据，但引用就必须真实）", () => {
  const store = storeWithFinding();
  const findingId = store.get().findings[0].id;
  const r = HANDLERS.mentor_finding_respond(store, { findingId, summary: "口头说明" });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("E5 混入一个假 id 也整体拒收（不做部分通过）", () => {
  const store = storeWithFinding();
  const task = store.get();
  const repId = task.nodeRuns[0].reports[0].id;
  const findingId = task.findings[0].id;

  const r = HANDLERS.mentor_finding_respond(store, {
    findingId,
    summary: "一条真一条假",
    evidenceIds: [repId, "ghost-evidence"],
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(r.details.unknown, ["ghost-evidence"]);
  // revise 会把任务退回 active（不是 reviewing），这里只核对「拒收没改状态」
  assert.equal(store.get().phase, PHASES.ACTIVE);
  assert.equal(store.get().findings[0].status, "open");
});
