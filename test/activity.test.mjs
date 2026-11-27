/**
 * runtimePayload 的快照可读性测试（c6 / 缺陷 4）。
 *
 * 背景（2026-11-09 真机）：任务快照约 140KB 时，宿主对工具输出只保留首尾、截掉中段，
 * 而 nodeRuns.reports 是追加式排列 —— 审查方永远读不到本轮证据。审查侧又没有
 * read/bash，只有这个快照。所以 status 必须提供 reportId / stageId / limit 三条通道。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runtimePayload, findReport } from "../src/runtime/activity.js";

const BIG = (marker) => `${"X".repeat(20000)}${marker}`;

function makeTask() {
  return {
    id: "t1",
    phase: "active",
    revision: 3,
    planVersion: 1,
    approvedPlanVersion: 1,
    enabled: true,
    objective: "快照可读性",
    updatedAt: Date.now(),
    criteria: [{ id: "c1", text: "c1" }],
    stages: [
      { id: "s1", title: "a", criterionIds: ["c1"], dependsOn: [], writePaths: ["a.md"] },
      { id: "s2", title: "b", criterionIds: ["c1"], dependsOn: [], writePaths: ["b.md"] },
    ],
    nodeRuns: [
      {
        stageId: "s1", attempt: 1, status: "accepted", reports: [
          { id: "rep_1", evidence: BIG("MID-1"), evidenceRefs: [], attempt: 1 },
          { id: "rep_2", evidence: BIG("MID-2"), evidenceRefs: [], attempt: 2 },
          { id: "rep_3", evidence: BIG("MID-3"), evidenceRefs: [], attempt: 3 },
          { id: "rep_4", evidence: BIG("MID-4"), evidenceRefs: [], attempt: 4 },
        ],
      },
      {
        stageId: "s2", attempt: 1, status: "rework", reports: [
          { id: "rep_5", evidence: BIG("MID-5"), evidenceRefs: [], attempt: 1 },
          { id: "rep_6", evidence: BIG("MID-6"), evidenceRefs: [], attempt: 2 },
        ],
      },
    ],
    findings: [
      { id: "f1", stageId: "s1", severity: "blocking", status: "open", text: "s1 的问题", responses: [] },
      { id: "f2", stageId: "s2", severity: "blocking", status: "open", text: "s2 的问题", responses: [] },
    ],
    reviews: [
      { id: "r1", scope: { kind: "stage", stageId: "s1", attempt: 1, planVersion: 1 }, verdict: "pass", findings: [], checks: [] },
      { id: "r2", scope: { kind: "stage", stageId: "s2", attempt: 1, planVersion: 1 }, verdict: "revise", findings: [], checks: [] },
    ],
    wakeDispatches: [],
  };
}

function makeStore(task) {
  return { get: () => task, settings: {} };
}

const ctx = { agents: { get: () => undefined } };
const registry = { summaries: () => [], all: () => [] };

test("A1 默认分页：每个阶段只回最近 3 条，单条截到 4000 字符，并回带 reportTotal / reportsTruncated", () => {
  const task = makeTask();
  const out = runtimePayload(ctx, makeStore(task), registry);

  assert.equal(out.reportTotal, 6, "总报告数应如实回带");
  assert.equal(out.reportsTruncated, true, "发生分页要标记");

  const s1 = out.nodeRuns.find((r) => r.stageId === "s1");
  assert.equal(s1.reports.length, 3, "6 条里 s1 有 4 条，默认只回最近 3 条");
  assert.deepEqual(s1.reports.map((r) => r.id), ["rep_2", "rep_3", "rep_4"], "回的是最近 3 条");
  for (const report of s1.reports) {
    assert.ok(report.evidence.length <= 4000, `单条 evidence 应被截到 4000，实际 ${report.evidence.length}`);
    assert.equal(report.evidenceTruncated, true);
    assert.equal(report.evidenceLength, 20005, "原始长度要回带，便于判断丢了多少");
  }

  const s2 = out.nodeRuns.find((r) => r.stageId === "s2");
  assert.equal(s2.reports.length, 2, "s2 只有 2 条，不受 limit 影响");
});

test("A2 reportId 通道：只回该条报告全文（不截断、不含整快照），中间正文可见", () => {
  const task = makeTask();
  const out = runtimePayload(ctx, makeStore(task), registry, { reportId: "rep_5" });

  assert.equal(out.reportOnly, true, "reportId 模式不能附带整快照，否则又会撞截断");
  assert.equal(out.found, true);
  assert.equal(out.report.reportId, "rep_5");
  assert.equal(out.report.stageId, "s2");
  assert.equal(out.report.evidenceLength, 20005);
  assert.ok(out.report.evidence.length === 20005, "全文必须完整");
  assert.ok(out.report.evidence.includes("MID-5"), "尾部标记在");
  assert.ok(out.report.evidence.startsWith("XXXX"), "头部正文在");
  assert.equal(out.nodeRuns, undefined, "不应回整份 nodeRuns");
});

test("A3 reportId 不存在时给出候选，而不是静默空", () => {
  const task = makeTask();
  const out = runtimePayload(ctx, makeStore(task), registry, { reportId: "rep_nope" });

  assert.equal(out.found, false);
  assert.equal(out.reason, "report-not-found");
  assert.ok(Array.isArray(out.knownReportIds) && out.knownReportIds.includes("rep_6"));
});

test("A4 stageId 通道：只回该阶段的 nodeRuns / reviews / findings", () => {
  const task = makeTask();
  const out = runtimePayload(ctx, makeStore(task), registry, { stageId: "s2", limit: 5 });

  assert.equal(out.stageFilter, "s2");
  assert.deepEqual(out.nodeRuns.map((r) => r.stageId), ["s2"]);
  assert.deepEqual(out.reviews.map((r) => r.id), ["r2"]);
  assert.deepEqual(out.findings.map((f) => f.id), ["f2"]);
  assert.equal(out.nodeRuns[0].reports.length, 2, "limit 5 时 s2 的 2 条全回");
});

test("A5 findReport 能按 id 取到任意阶段（含被分页挤掉的早期报告）", () => {
  const task = makeTask();
  const first = findReport(task, "rep_1");
  assert.equal(first.stageId, "s1");
  assert.equal(first.evidenceLength, 20005);
  assert.ok(first.evidence.includes("MID-1"));
  assert.equal(findReport(task, "nope"), null);
});

test("A6 默认输出比不裁时小得多（同一任务，简单比字节数）", () => {
  const task = makeTask();
  const paged = JSON.stringify(runtimePayload(ctx, makeStore(task), registry));
  const raw = JSON.stringify(task.nodeRuns);
  assert.ok(paged.length < raw.length, `分页输出 ${paged.length} 应小于原始 ${raw.length}`);
  assert.ok(paged.length < 30000, `分页后应远小于原始 6 条满载，实际 ${paged.length}`);
});

test("A7 默认视图强制落在 24KB UTF-8 预算内，并回带 snapshotBytes / snapshotTruncated / omitted", () => {
  const task = makeTask();
  const out = runtimePayload(ctx, makeStore(task), registry);
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");

  assert.ok(bytes <= 24576, `Round 3 预算：实际 ${bytes} 字节`);
  assert.equal(out.snapshotBytes, bytes, "snapshotBytes 必须是返回体自身的字节数");
  assert.equal(typeof out.snapshotTruncated, "boolean");
  assert.deepEqual(Object.keys(out.omitted).sort(), [
    "findings", "participants", "reports", "reviewDispatches", "reviewJobs",
    "reviews", "tasks", "wakeDispatches", "workers",
  ]);
  // A1 的分页语义不变：最近 3 条仍在，单条仍不超过 4000 字符
  assert.equal(out.nodeRuns.find((r) => r.stageId === "s1").reports.length, 3);
  for (const run of out.nodeRuns) for (const report of run.reports) {
    assert.ok(report.evidence.length <= 4000);
  }
  // 未关闭的 blocking finding 必须保住
  assert.ok(out.findings.some((f) => f.severity === "blocking" && f.status === "open"));
});
