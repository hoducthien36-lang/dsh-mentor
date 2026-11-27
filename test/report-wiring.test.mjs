/**
 * 报告门槛端到端接线测试（s4）。
 *
 * 测的是**工具链路真正走的那个入口** `HANDLERS.mentor_stage_report_gated`
 * （lib/index.js 里 mentor_stage_report 绑定的就是它）。覆盖：
 *   1. 命中文件的正常上报 → 通过，且 report 里落了 planVersion / evidenceRefs
 *   2. 缺 evidenceRefs / 空数组 / 缺字段 / 片段不命中 / 文件不存在 / 行号越界 / 路径逃逸
 *   3. 存在 open 未响应 finding → E_UNRESPONDED_FINDINGS + findingIds
 *   4. planVersion 缺失 / 陈旧 → E_STALE_PLAN + expected/got
 *   5. responded 未复核 → 放行
 *   6. paused 状态下仍被「不可写」拦住（writable 语义没被破坏）
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore, planSubmit, stageReportGated, taskCreate } from "../src/tools/handlers.js";
import { ERR } from "../src/errors.js";
import { PHASES, transition } from "../src/state/machine.js";
import { toPhase } from "./support/fixtures.mjs";
import { mkEvidence } from "./helpers/evidence.mjs";
import path from "node:path";

/** s3：v0.2.0 起 handlers.taskCreate 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。
 *  这里统一给测试一个项目根，避免每条用例各自硬编码。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const PLAN = {
  criteria: [{ id: "c1", text: "第一条" }],
  stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [], writePaths: [] }],
};

function withPlan() {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "接线测试" });
  planSubmit(store, PLAN);
  return store;
}

/** 走工具链路真正绑定的那个入口（lib/index.js execute 里用的就是它） */
function gated(store, params, deps) {
  return stageReportGated(store, params, deps);
}

const base = (store, over = {}) => ({
  stageId: "s1",
  attempt: 1,
  evidence: "散文摘要：本轮做了什么",
  evidenceRefs: [mkEvidence("SPEC.md")],
  planVersion: store.get().planVersion,
  ...over,
});

/* ----------------------------- 1. 通过路径 ----------------------------- */

test("W1 命中文件的正常上报通过，report 落库 planVersion 与 evidenceRefs", () => {
  const store = withPlan();
  const ref = mkEvidence("src/review/report-gate.js");
  const r = gated(store, base(store, { evidenceRefs: [ref] }));

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.status, "reported");

  const task = store.get();
  const report = task.nodeRuns.find((x) => x.stageId === "s1").reports.at(-1);
  assert.equal(report.planVersion, task.planVersion);
  assert.equal(report.evidenceRefs.length, 1);
  assert.equal(report.evidenceRefs[0].file, ref.file);
  assert.equal(report.evidenceRefs[0].matchedAt, ref.line);
  assert.equal(task.phase, PHASES.REVIEWING);
});

/* ------------------------- 2. 证据形状与命中 ------------------------- */

test("W2 缺 evidenceRefs → E_EVIDENCE_REQUIRED", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_REQUIRED);
  assert.equal(store.get().phase, PHASES.ACTIVE, "拒收不应改动任务状态");
});

test("W3 空数组 → E_EVIDENCE_REQUIRED", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_REQUIRED);
});

test("W4 条目缺 snippet → E_EVIDENCE_REQUIRED 且 details.index 指向该条", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: [{ file: "SPEC.md", line: 1 }] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_REQUIRED);
  assert.equal(r.details.index, 0);
});

test("W5 片段与文件不符 → E_EVIDENCE_MISMATCH 且 misses 带明细", () => {
  const store = withPlan();
  const ref = mkEvidence("SPEC.md");
  const r = gated(store, base(store, { evidenceRefs: [{ ...ref, snippet: "这段文字在文件里根本不存在" }] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_MISMATCH);
  assert.equal(r.details.misses.length, 1);
  assert.equal(r.details.misses[0].reason, "snippet-not-found-in-window");
});

test("W6 文件不存在 → E_EVIDENCE_MISMATCH，reason=file-not-found", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: [{ file: "src/ghost.js", line: 1, snippet: "x" }] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_MISMATCH);
  assert.equal(r.details.misses[0].reason, "file-not-found");
});

test("W7 行号越界 → E_EVIDENCE_MISMATCH，reason=line-out-of-range", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: [{ file: "SPEC.md", line: 99999, snippet: "x" }] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_MISMATCH);
  assert.equal(r.details.misses[0].reason, "line-out-of-range");
});

test("W8 路径逃出项目根 → E_EVIDENCE_OUTSIDE（审查建议的独立错误码）", () => {
  const store = withPlan();
  const r = gated(store, base(store, { evidenceRefs: [{ file: "../../outside.js", line: 1, snippet: "x" }] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.EVIDENCE_OUTSIDE);
});

/* --------------------------- 3. 旧账门禁 --------------------------- */

test("W9 本阶段存在 open 未响应 blocking finding → E_UNRESPONDED_FINDINGS 且列 id", () => {
  const store = withPlan();
  const task = store.get();
  store.set({
    ...task,
    findings: [
      // v0.2.0 门禁只认「本阶段 + blocking + 从未响应」（src/review/report-gate.js:65）：
      // 别的阶段的旧账不拦这一次提交，advisory 也不拦（响应 ≠ 解决，但也不阻塞推进）。
      { id: "f_a", stageId: "s1", status: "open", severity: "blocking", text: "旧账A", responses: [] },
      { id: "f_b", stageId: "s1", status: "open", severity: "advisory", text: "旧账B" },
      { id: "f_c", stageId: "s1", status: "responded", severity: "blocking", text: "已响应", responses: [{ id: "r1" }] },
    ],
  });

  const r = gated(store, base(store));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.UNRESPONDED_FINDINGS);
  assert.deepEqual(r.details.findingIds, ["f_a"], "只拦 blocking 且属于本阶段的旧账");
  assert.ok(!r.details.findingIds.includes("f_b"), "advisory 不该拦");
  assert.ok(!r.details.findingIds.includes("f_c"), "responded 不算旧账");
});

test("W10 responded 未复核不算旧账 → 放行", () => {
  const store = withPlan();
  const task = store.get();
  store.set({
    ...task,
    findings: [{ id: "f_c", status: "responded", severity: "blocking", text: "已响应", responses: [{ id: "r1" }] }],
  });
  const r = gated(store, base(store));
  assert.equal(r.ok, true, JSON.stringify(r));
});

/* -------------------------- 4. 版本门禁 -------------------------- */

test("W11 planVersion 缺失 → E_STALE_PLAN", () => {
  const store = withPlan();
  const r = gated(store, base(store, { planVersion: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STALE_PLAN);
  assert.equal(r.details.expected, store.get().planVersion);
});

test("W12 planVersion 陈旧 → E_STALE_PLAN 且带 expected/got", () => {
  const store = withPlan();
  const current = store.get().planVersion;
  const r = gated(store, base(store, { planVersion: current - 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.STALE_PLAN);
  assert.equal(r.details.expected, current);
  assert.equal(r.details.got, current - 1);
});

/* ------------------- 5. 既有 writable 语义未被破坏 ------------------- */

test("W13 paused 状态仍被拦住（门禁没有绕过不可写判定）", () => {
  const store = withPlan();
  // 2026-11-09：phase 变更走单一写入口（active → paused 本身是合法边）
  toPhase(store, PHASES.PAUSED);

  const r = gated(store, base(store, { planVersion: store.get().planVersion }));
  assert.equal(r.ok, false);
  assert.equal(store.get().phase, PHASES.PAUSED);
});
