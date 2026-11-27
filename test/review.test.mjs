import test from "node:test";
import assert from "node:assert/strict";

import {
  FINDING_STATUS,
  SEVERITY,
  VERDICT,
  applyReview,
  assertNoUnresolvedBlocking,
  blockingOpenFindings,
  closeFinding,
  createFinding,
  createReview,
  findingById,
  forceCloseFinding,
  openFindings,
  submitFindingResponse,
  submitStageReport,
  unresolvedSummary,
} from "../src/review/review.js";
import { ERR, MentorError } from "../src/errors.js";
import { readyNodes } from "../src/plan/dag.js";

const isCode = (code) => (e) => e instanceof MentorError && e.code === code;

function baseTask() {
  return {
    id: "t1",
    revision: 1,
    phase: "reviewing",
    criteria: [],
    stages: [],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "pending" }],
    findings: [],
    reviews: [],
  };
}

// ---------------- createFinding ----------------

test("createFinding 默认状态 open、无响应", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "缺测试", id: "f1" });
  assert.equal(f.id, "f1");
  assert.equal(f.status, FINDING_STATUS.OPEN);
  assert.deepEqual(f.responses, []);
  assert.equal(f.resolvedByReviewId, null);
});

test("createFinding 拒绝空文本与未知严重度", () => {
  assert.throws(
    () => createFinding({ severity: SEVERITY.BLOCKING, text: "  " }),
    isCode(ERR.INTERNAL),
  );
  assert.throws(
    () => createFinding({ severity: "critical", text: "x" }),
    isCode(ERR.INTERNAL),
  );
});

// ---------------- createReview ----------------

test("createReview 接受 pass 且可以没有 finding", () => {
  const r = createReview({ stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r1" });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.markedResolved, []);
  assert.deepEqual(r.scope, { kind: "stage", stageId: "s1", attempt: 1 });
});

test("createReview 的 revise 必须至少一条 finding", () => {
  assert.throws(
    () => createReview({ stageId: "s1", attempt: 1, verdict: VERDICT.REVISE }),
    isCode(ERR.INTERNAL),
  );
});

test("createReview 把字符串 finding 转成 blocking 对象", () => {
  const r = createReview({
    stageId: "s1",
    attempt: 1,
    verdict: VERDICT.REVISE,
    findings: ["证据不足"],
    id: "r1",
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, SEVERITY.BLOCKING);
  assert.equal(r.findings[0].text, "证据不足");
  assert.equal(r.findings[0].reviewId, "r1");
  assert.equal(r.findings[0].status, FINDING_STATUS.OPEN);
});

test("createReview 拒绝未知裁决", () => {
  assert.throws(
    () => createReview({ stageId: "s1", attempt: 1, verdict: "maybe" }),
    isCode(ERR.INTERNAL),
  );
});

// ---------------- 响应不等于关闭（核心不变量） ----------------

test("提交响应后状态是 responded，不是 closed", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  const after = submitFindingResponse(f, { summary: "已补测试", evidenceIds: ["e1"] });

  assert.equal(after.status, FINDING_STATUS.RESPONDED);
  assert.notEqual(after.status, FINDING_STATUS.CLOSED);
  assert.equal(after.responses.length, 1);
  assert.equal(after.responses[0].summary, "已补测试");
  assert.deepEqual(after.responses[0].evidenceIds, ["e1"]);
  // 仍未关闭
  assert.ok(openFindings({ findings: [after] }).length === 1);
});

test("连续两次响应仍停留在 responded", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  const a = submitFindingResponse(f, { summary: "第一次" });
  const b = submitFindingResponse(a, { summary: "第二次" });
  assert.equal(b.status, FINDING_STATUS.RESPONDED);
  assert.equal(b.responses.length, 2);
});

test("已关闭的 finding 不能再提交响应", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  const responded = submitFindingResponse(f, { summary: "已修" });
  const closed = closeFinding(responded, "r2");
  assert.throws(
    () => submitFindingResponse(closed, { summary: "再来一次" }),
    isCode(ERR.INTERNAL),
  );
});

test("响应缺 summary 被拒绝", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  assert.throws(() => submitFindingResponse(f, {}), isCode(ERR.INTERNAL));
});

// ---------------- 关闭只有审批方能做 ----------------

test("open 状态不能直接关闭（必须先响应）", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  // v0.2.0：错误码从笼统的 E_INTERNAL 细化为 E_FINDING_NOT_RESPONDED
  // （src/review/review.js:280-285），让调用方能区分「状态不对」和「内部错」。
  assert.throws(() => closeFinding(f, "r2"), isCode(ERR.FINDING_NOT_RESPONDED));
});

test("responded 状态可被复核关闭，并记录复核 review id", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  const responded = submitFindingResponse(f, { summary: "已修" });
  const closed = closeFinding(responded, "r2");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.resolvedByReviewId, "r2");
});

test("关闭必须给出 review id", () => {
  const f = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f1" });
  const responded = submitFindingResponse(f, { summary: "已修" });
  assert.throws(() => closeFinding(responded, ""), isCode(ERR.INTERNAL));
});

// ---------------- applyReview ----------------

test("applyReview 把新 finding 挂到任务并存入审查历史", () => {
  const task = baseTask();
  const review = createReview({
    stageId: "s1",
    attempt: 1,
    verdict: VERDICT.REVISE,
    findings: ["证据不足"],
    id: "r1",
  });

  const next = applyReview(task, review);

  assert.equal(next.findings.length, 1);
  assert.equal(next.findings[0].status, FINDING_STATUS.OPEN);
  assert.equal(next.reviews.length, 1);
  assert.equal(next.revision, task.revision + 1);
  // 入参未被改动
  assert.equal(task.findings.length, 0);
  assert.equal(task.revision, 1);
});

test("applyReview 的 pass 把 nodeRun 置 accepted，revise 置 rework", () => {
  const task = baseTask();

  const pass = applyReview(task, createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r1",
  }));
  assert.equal(pass.nodeRuns[0].status, "accepted");
  assert.equal(pass.nodeRuns[0].lastReviewId, "r1");

  const revise = applyReview(task, createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE, findings: ["再改"], id: "r2",
  }));
  assert.equal(revise.nodeRuns[0].status, "rework");
});

test("applyReview 判 revise 时，已 accepted 的传递后继一并失效", () => {
  // 缺口回归（s3 审查指出）：revise 只把被审节点置 rework，不动已 accepted 的后继，
  // 而后继保持 accepted 会被 readyNodes 当成完成，等于拿旧结果继续推进。
  const task = {
    id: "t1",
    revision: 1,
    phase: "reviewing",
    criteria: [],
    stages: [
      { id: "s1", criterionIds: [], dependsOn: [] },
      { id: "s2", criterionIds: [], dependsOn: ["s1"] },
      { id: "s3", criterionIds: [], dependsOn: ["s2"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "accepted" },
      { stageId: "s2", attempt: 1, status: "accepted" },
      { stageId: "s3", attempt: 1, status: "accepted" },
    ],
    findings: [],
    reviews: [],
  };

  const next = applyReview(
    task,
    createReview({
      stageId: "s1",
      attempt: 1,
      verdict: VERDICT.REVISE,
      findings: ["上游要重做"],
      id: "r1",
    }),
  );

  // 被审节点：rework 且 attempt+1（可重报 attempt 2）
  const s1 = next.nodeRuns.find((r) => r.stageId === "s1");
  assert.equal(s1.status, "rework");
  assert.equal(s1.attempt, 2);

  // 直接后继与传递后继都要失效
  const s2 = next.nodeRuns.find((r) => r.stageId === "s2");
  const s3 = next.nodeRuns.find((r) => r.stageId === "s3");
  assert.equal(s2.status, "rework", "直接后继 s2 应失效");
  assert.equal(s3.status, "rework", "传递后继 s3 也应失效");
  assert.equal(s2.attempt, 2);
  assert.equal(s3.attempt, 2);

  assert.deepEqual([...next.invalidated].sort(), ["s2", "s3"]);
  assert.deepEqual(
    readyNodes(next.stages, next.nodeRuns),
    ["s1"],
    "失效后只有 s1 可重做",
  );
});

test("applyReview 判 pass 时不动其它已 accepted 的节点", () => {
  const task = {
    id: "t1",
    revision: 1,
    phase: "reviewing",
    criteria: [],
    stages: [
      { id: "s1", criterionIds: [], dependsOn: [] },
      { id: "s2", criterionIds: [], dependsOn: ["s1"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "reported" },
      { stageId: "s2", attempt: 1, status: "accepted" },
    ],
    findings: [],
    reviews: [],
  };

  const next = applyReview(
    task,
    createReview({ stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r1" }),
  );

  const s2 = next.nodeRuns.find((r) => r.stageId === "s2");
  assert.equal(s2.status, "accepted", "pass 不应影响其它节点");
  assert.deepEqual(next.invalidated, []);
});

test("applyReview 通过 markedResolved 关闭已响应的 finding", () => {
  let task = baseTask();

  // 第一轮：提 finding
  task = applyReview(task, createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, text: "缺证据" }],
    id: "r1",
  }));
  assert.equal(task.findings[0].status, FINDING_STATUS.OPEN);

  // 执行方响应（不关闭）
  const responded = submitFindingResponse(findingById(task, "f1"), { summary: "补了" });
  task = { ...task, findings: [responded] };
  assert.equal(task.findings[0].status, FINDING_STATUS.RESPONDED);

  // 第二轮：审批方显式复核并关闭
  const r2 = createReview({ stageId: "s1", attempt: 2, verdict: VERDICT.PASS, id: "r2" });
  r2.markedResolved = ["f1"];
  task = applyReview(task, r2);

  assert.equal(task.findings[0].status, FINDING_STATUS.CLOSED);
  assert.equal(task.findings[0].resolvedByReviewId, "r2");
  assert.equal(openFindings(task).length, 0);
});

test("markedResolved 指向 open finding：语义已于 2026-11-09 改为「pass 可关本阶段 open」并留痕", () => {
  // 这条原断言 E_FINDING_NOT_RESPONDED（「不能跳过响应直接关」），锁的是旧门禁。
  // 真机 v3→v6 的教训：finding 在 revise 轮提出、pass 轮才关，跨 review，
  // 旧规则导致「内容已全部修复」的一轮还要为补一次 respond 再被打回。
  // 现语义：pass 审查可以直接关闭本阶段的 open finding，但必须留 closedWithoutResponse 痕迹；
  // 「执行方不能自关」仍由 findingRespond 不提供关闭入口保证（见 R2）。
  let task = baseTask();
  task = applyReview(task, createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, text: "x" }],
    id: "r1",
  }));

  const r2 = createReview({ stageId: "s1", attempt: 2, verdict: VERDICT.PASS, id: "r2" });
  r2.markedResolved = ["f1"];

  const next = applyReview(task, r2);
  const closed = next.findings.find((f) => f.id === "f1");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, true);
  assert.equal(closed.resolvedByReviewId, "r2");
  assert.equal(openFindings(next).length, 0);
});

test("applyReview 同 id 的 finding 不重复挂载", () => {
  let task = baseTask();
  const review = createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, text: "x" }],
    id: "r1",
  });
  task = applyReview(task, review);
  // 再应用同一个 review（模拟重放）
  const again = applyReview(task, review);
  assert.equal(again.findings.length, 1);
});

// ---------------- 未解决问题清单 ----------------

test("blockingOpenFindings 区分严重度", () => {
  const task = {
    findings: [
      { id: "f1", severity: SEVERITY.BLOCKING, status: FINDING_STATUS.OPEN },
      { id: "f2", severity: SEVERITY.ADVISORY, status: FINDING_STATUS.OPEN },
      { id: "f3", severity: SEVERITY.BLOCKING, status: FINDING_STATUS.CLOSED },
    ],
  };
  const blocking = blockingOpenFindings(task);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].id, "f1");
});

test("assertNoUnresolvedBlocking 在存在未关闭 blocking 时抛 E_BLOCKING_FINDING_OPEN", () => {
  const task = {
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, status: FINDING_STATUS.RESPONDED }],
  };
  assert.throws(
    () => assertNoUnresolvedBlocking(task),
    isCode(ERR.BLOCKING_FINDING_OPEN),
  );
});

test("assertNoUnresolvedBlocking 在只剩 advisory 时通过", () => {
  const task = {
    findings: [{ id: "f1", severity: SEVERITY.ADVISORY, status: FINDING_STATUS.OPEN }],
  };
  assert.doesNotThrow(() => assertNoUnresolvedBlocking(task));
});

test("unresolvedSummary 区分从未响应与等待复核", () => {
  const task = {
    findings: [
      { id: "f1", severity: SEVERITY.BLOCKING, status: FINDING_STATUS.OPEN, text: "a" },
      { id: "f2", severity: SEVERITY.BLOCKING, status: FINDING_STATUS.RESPONDED, text: "b" },
      { id: "f3", severity: SEVERITY.ADVISORY, status: FINDING_STATUS.CLOSED, text: "c" },
    ],
  };
  const s = unresolvedSummary(task);
  assert.equal(s.total, 2);
  assert.equal(s.blocking, 2);
  assert.equal(s.neverResponded, 1);
  assert.equal(s.awaitingRecheck, 1);
  assert.equal(s.items.length, 2);
});

test("findingById 找不到时抛 E_FINDING_UNKNOWN", () => {
  assert.throws(
    () => findingById({ findings: [] }, "nope"),
    isCode(ERR.FINDING_UNKNOWN),
  );
});

// ---------------- 节点证据提交（c5 前半句） ----------------

/** 带计划结构的任务：a（入口）→ b（依赖 a） */
function taskWithPlan() {
  return {
    id: "t1",
    revision: 1,
    phase: "active",
    criteria: [
      { id: "c1", text: "一" },
      { id: "c2", text: "二" },
    ],
    stages: [
      { id: "a", criterionIds: ["c1"], dependsOn: [] },
      { id: "b", criterionIds: ["c2"], dependsOn: ["a"] },
    ],
    nodeRuns: [],
    findings: [],
    reviews: [],
  };
}

test("提交节点证据：合法时写入 reports 且状态置 reported", () => {
  const task = taskWithPlan();
  const next = submitStageReport(task, {
    stageId: "a",
    attempt: 1,
    evidence: "跑出 12/12 通过",
    summary: "首轮实现",
  });

  assert.equal(next.nodeRuns.length, 1);
  const run = next.nodeRuns[0];
  assert.equal(run.stageId, "a");
  assert.equal(run.status, "reported");
  assert.equal(run.reports.length, 1);
  assert.equal(run.reports[0].evidence, "跑出 12/12 通过");
  assert.equal(run.reports[0].summary, "首轮实现");
  assert.equal(run.reports[0].attempt, 1);
  assert.equal(next.revision, task.revision + 1);
  // 入参未被改动
  assert.equal(task.nodeRuns.length, 0);
});

test("提交节点证据：同一 attempt 再提交会追加第二条 report", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "第一次" });
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "补一条" });
  assert.equal(task.nodeRuns[0].reports.length, 2);
  assert.equal(task.nodeRuns[0].status, "reported");
});

test("提交节点证据：stage 不存在 → E_STAGE_UNKNOWN", () => {
  const task = taskWithPlan();
  assert.throws(
    () => submitStageReport(task, { stageId: "zzz", attempt: 1, evidence: "x" }),
    isCode(ERR.STAGE_UNKNOWN),
  );
});

test("提交节点证据：attempt 陈旧 → E_STALE_ATTEMPT", () => {
  let task = taskWithPlan();
  task = { ...task, nodeRuns: [{ stageId: "a", attempt: 2, status: "rework", reports: [] }] };
  assert.throws(
    () => submitStageReport(task, { stageId: "a", attempt: 1, evidence: "x" }),
    isCode(ERR.STALE_ATTEMPT),
  );
});

test("提交节点证据：前置阶段未 accepted → E_DEP_NOT_READY", () => {
  const task = taskWithPlan();
  // b 依赖 a，但 a 还没被接受
  assert.throws(
    () => submitStageReport(task, { stageId: "b", attempt: 1, evidence: "x" }),
    isCode(ERR.DEP_NOT_READY),
  );
});

test("提交节点证据：前置阶段已 accepted 时 b 可提交", () => {
  let task = taskWithPlan();
  task = { ...task, nodeRuns: [{ stageId: "a", attempt: 1, status: "accepted", reports: [] }] };
  const next = submitStageReport(task, { stageId: "b", attempt: 1, evidence: "b 的证据" });
  const bRun = next.nodeRuns.find((r) => r.stageId === "b");
  assert.equal(bRun.status, "reported");
  assert.equal(bRun.reports[0].evidence, "b 的证据");
});

test("提交节点证据：evidence 为空被拒绝", () => {
  const task = taskWithPlan();
  assert.throws(
    () => submitStageReport(task, { stageId: "a", attempt: 1, evidence: "   " }),
    isCode(ERR.INTERNAL),
  );
});

test("提交证据 → 裁决 的端到端串联：reported 后拿到 revise 变 rework", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "首轮证据" });
  assert.equal(task.nodeRuns[0].status, "reported");

  const review = createReview({
    stageId: "a",
    attempt: 1,
    verdict: VERDICT.REVISE,
    findings: ["证据不足以证明边界"],
    id: "r1",
  });
  task = applyReview(task, review);

  assert.equal(task.nodeRuns[0].status, "rework");
  assert.equal(task.nodeRuns[0].lastReviewId, "r1");
  assert.equal(task.findings.length, 1);
  // 提交过的证据仍在
  assert.equal(task.nodeRuns[0].reports.length, 1);
});

test("revise 裁决携带 markedResolved 被拒绝（只有 pass 能关闭）", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "证据" });
  task = applyReview(task, createReview({
    stageId: "a", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, text: "缺" }],
    id: "r1",
  }));
  task = { ...task, findings: [submitFindingResponse(findingById(task, "f1"), { summary: "补了" })] };

  const r2 = createReview({ stageId: "a", attempt: 2, verdict: VERDICT.REVISE, findings: ["还不够"], id: "r2" });
  r2.markedResolved = ["f1"];

  assert.throws(() => applyReview(task, r2), isCode(ERR.INTERNAL));
});

test("pass 裁决携带 markedResolved 才允许关闭", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "证据" });
  task = applyReview(task, createReview({
    stageId: "a", attempt: 1, verdict: VERDICT.REVISE,
    findings: [{ id: "f1", severity: SEVERITY.BLOCKING, text: "缺" }],
    id: "r1",
  }));
  task = { ...task, findings: [submitFindingResponse(findingById(task, "f1"), { summary: "补了" })] };

  // revise 后 attempt 已递增到 2，因此这轮 pass 审查必须针对 attempt=2
  const r2 = createReview({ stageId: "a", attempt: 2, verdict: VERDICT.PASS, id: "r2" });
  r2.markedResolved = ["f1"];
  task = applyReview(task, r2);

  assert.equal(task.findings[0].status, FINDING_STATUS.CLOSED);
  assert.equal(task.nodeRuns[0].status, "accepted");
});

// ---------------- attempt 递增（SPEC §2.3） ----------------

test("revise 后 nodeRun.attempt 递增到 2", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "首轮" });
  task = applyReview(task, createReview({
    stageId: "a", attempt: 1, verdict: VERDICT.REVISE,
    findings: ["不够"], id: "r1",
  }));

  assert.equal(task.nodeRuns[0].attempt, 2);
  assert.equal(task.nodeRuns[0].status, "rework");
});

test("pass 后 attempt 保持不变", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "首轮" });
  task = applyReview(task, createReview({
    stageId: "a", attempt: 1, verdict: VERDICT.PASS, id: "r1",
  }));

  assert.equal(task.nodeRuns[0].attempt, 1);
  assert.equal(task.nodeRuns[0].status, "accepted");
});

test("revise 后必须用新 attempt 重新提交，旧 attempt 被拒", () => {
  let task = taskWithPlan();
  task = submitStageReport(task, { stageId: "a", attempt: 1, evidence: "首轮" });
  task = applyReview(task, createReview({
    stageId: "a", attempt: 1, verdict: VERDICT.REVISE,
    findings: ["不够"], id: "r1",
  }));

  // 拿旧 attempt 重提 → 拒绝
  assert.throws(
    () => submitStageReport(task, { stageId: "a", attempt: 1, evidence: "再试" }),
    isCode(ERR.STALE_ATTEMPT),
  );

  // 用新 attempt → 通过，且两次证据都留着
  const next = submitStageReport(task, { stageId: "a", attempt: 2, evidence: "改进后" });
  const run = next.nodeRuns[0];
  assert.equal(run.attempt, 2);
  assert.equal(run.status, "reported");
  assert.equal(run.reports.length, 2);
});

// ---------------- P0-0 修复：pass 自动复核关闭 ----------------

test("pass 裁决不会自动关闭 responded finding —— 关闭必须由 markedResolved 点名", () => {
  // 2026-11-08 核实（推翻 TEST-SYNC-TODO.md 里「自动关闭要求 stageId 匹配」的猜测）：
  // applyReview 只有一条关闭路径 —— src/review/review.js:435-443 按 markedResolved 关闭；
  // 返回对象里没有 autoClosed 字段（全仓只有旧测试引用过它），关闭记录叫 closedFindingIds。
  // 「响应 ≠ 解决」是 v0.2.0 的明确契约：审查方不点名，finding 就一直挂着。
  const raw = createFinding({
    severity: SEVERITY.BLOCKING,
    text: "缺证据",
    id: "f1",
    reviewId: "r0",
    stageId: "s1",
  });
  const responded = submitFindingResponse(raw, { summary: "已补齐", evidenceIds: [] });
  assert.equal(responded.status, FINDING_STATUS.RESPONDED);

  const task = { ...baseTask(), findings: [responded] };
  const review = createReview({ stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r1" });
  assert.deepEqual(review.markedResolved, [], "前提：reviewer 没写 markedResolved");

  const after = applyReview(task, review);
  assert.equal(
    after.findings[0].status,
    FINDING_STATUS.RESPONDED,
    "pass 但没点名 → 不能顺带关闭",
  );
  assert.deepEqual(after.closedFindingIds, [], "本条没关闭任何 finding");
  assert.equal(
    after.autoClosed,
    undefined,
    "不存在 autoClosed 字段（关闭记录走 closedFindingIds）",
  );
});

test("revise 裁决不关闭 responded；点名 + pass 才关闭，并写进 closedFindingIds", () => {
  const raw = createFinding({
    severity: SEVERITY.BLOCKING,
    text: "缺证据",
    id: "f2",
    reviewId: "r0",
    stageId: "s1",
  });
  const responded = submitFindingResponse(raw, { summary: "已补齐", evidenceIds: [] });
  const task = { ...baseTask(), findings: [responded] };
  const review = createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE, id: "r2",
    findings: [{ severity: SEVERITY.BLOCKING, text: "还有缺口" }],
  });

  const after = applyReview(task, review);
  assert.equal(after.findings[0].status, FINDING_STATUS.RESPONDED, "revise 不能关");
  assert.deepEqual(after.closedFindingIds, [], "revise 不关闭任何 finding");

  // 反向：同一条 responded，换成 pass + 点名 → 必须关，并写进 closedFindingIds
  const review2 = createReview({ stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r3" });
  review2.markedResolved = ["f2"];
  const after2 = applyReview({ ...baseTask(), findings: [responded] }, review2);
  assert.equal(after2.findings[0].status, FINDING_STATUS.CLOSED, "点名 + pass → 关闭");
  assert.deepEqual(after2.closedFindingIds, ["f2"]);
  assert.equal(after2.findings[0].resolvedByReviewId, "r3");
});

test("forceCloseFinding 能直接关闭 open 状态，已关闭时幂等", () => {
  const open = createFinding({ severity: SEVERITY.BLOCKING, text: "x", id: "f3" });
  const closed = forceCloseFinding(open, "人工确认已解决");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedBy, "user");
  assert.equal(closed.closeReason, "人工确认已解决");

  const again = forceCloseFinding(closed, "再关一次");
  assert.equal(again, closed, "已关闭必须幂等返回同一对象");
});
// ---------------- P1-5：reported 的后继也要失效 ----------------

test("revise 时 reported 的后继也被失效（P1-5）", () => {
  const task = {
    id: "t-p15", revision: 1, phase: "reviewing",
    criteria: [{ id: "c1" }],
    stages: [
      { id: "s1", title: "A", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "B", criterionIds: ["c1"], dependsOn: ["s1"] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "reported", reports: [] },
      { stageId: "s2", attempt: 1, status: "reported", reports: [] },
    ],
    findings: [],
    reviews: [],
  };
  const review = createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE, id: "r-p15",
    findings: [{ severity: SEVERITY.BLOCKING, text: "上游有问题" }],
  });

  const after = applyReview(task, review);
  const s2 = after.nodeRuns.find((r) => r.stageId === "s2");

  assert.equal(s2.status, "rework", "reported 后继必须失效，否则会拿废弃的上游结果过关");
  assert.equal(s2.attempt, 2, "失效后 attempt 必须 +1");
  assert.ok(after.invalidated.includes("s2"), "invalidated 要记录被失效的阶段");
});
// ---------------- P2-4：同 id finding 显式报错 ----------------

test("同 id 的 finding 被显式拒绝，不再静默丢弃（P2-4）", () => {
  const existing = createFinding({
    severity: SEVERITY.BLOCKING, text: "已存在的问题", id: "f-dup", reviewId: "r0",
  });
  const task = { ...baseTask(), findings: [existing] };
  const review = createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.REVISE, id: "r-dup",
    findings: [{ severity: SEVERITY.BLOCKING, text: "重复提交", id: "f-dup" }],
  });

  assert.throws(
    () => applyReview(task, review),
    (e) => e instanceof MentorError && e.code === ERR.FINDING_DUP,
    "同 id 必须报错，否则 reviews 里会留下 task.findings 里不存在的整改要求",
  );
});

// ---------------- 2026-11-09：整改闭环与 findingId 双命名 ----------------

test("R1 pass 审查可关闭上一轮 revise 提出的 open finding（无需先 respond）", () => {
  // 真机形态：finding 由 v3 revise 提出（open），执行方改完，v6 pass 想用 markedResolved 关它。
  // 旧规则要求先 respond → 内容已全部通过的一轮还得再被打回一次。
  const old = createFinding({
    severity: SEVERITY.BLOCKING, text: "G1 流程缺口", id: "f-open", reviewId: "r-prev", stageId: "s1",
  });
  const task = { ...baseTask(), findings: [old], stages: [{ id: "s1", dependsOn: [], writePaths: [] }] };
  const review = createReview({
    stageId: "s1", attempt: 2, verdict: VERDICT.PASS, id: "r-pass", findings: [],
  });
  review.markedResolved = ["f-open"];

  const next = applyReview(task, review);
  const closed = next.findings.find((f) => f.id === "f-open");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, true, "要留下「未经 respond 直接关闭」的痕迹");
  assert.equal(closed.resolvedByReviewId, "r-pass");
});

test("R2 执行方仍没有关闭入口：respond 后状态是 responded 而非 closed", () => {
  // 「响应≠关闭」的真正护栏是「执行方关不了」，不是「必须先响应」。
  const finding = createFinding({
    severity: SEVERITY.BLOCKING, text: "G1 某问题", id: "f-x", reviewId: "r1", stageId: "s1",
  });
  const responded = submitFindingResponse(finding, { summary: "已修", evidenceIds: [] });
  assert.equal(responded.status, FINDING_STATUS.RESPONDED);
  assert.notEqual(responded.status, FINDING_STATUS.CLOSED);
  assert.equal(responded.closedWithoutResponse, undefined);
});

test("R2b revise 裁决下 markedResolved 仍被拒（只有 pass 能关）", () => {
  const old = createFinding({
    severity: SEVERITY.BLOCKING, text: "旧问题", id: "f-z", reviewId: "r-prev", stageId: "s1",
  });
  const task = { ...baseTask(), findings: [old], stages: [{ id: "s1", dependsOn: [], writePaths: [] }] };
  const review = createReview({
    stageId: "s1", attempt: 2, verdict: VERDICT.REVISE, id: "r-rev",
    findings: [{ severity: SEVERITY.BLOCKING, text: "还是不行" }],
  });
  review.markedResolved = ["f-z"];

  assert.throws(() => applyReview(task, review), /只有 pass 裁决才能关闭 finding/);
});

test("R3 responded 的历史 finding 照旧可被 pass 关闭（旧路径不回归）", () => {
  const old = createFinding({
    severity: SEVERITY.BLOCKING, text: "旧问题", id: "f-responded", reviewId: "r-prev", stageId: "s1",
  });
  const responded = submitFindingResponse(old, { summary: "已修", evidenceIds: [] });
  const task = { ...baseTask(), findings: [responded], stages: [{ id: "s1", dependsOn: [], writePaths: [] }] };
  const review = createReview({
    stageId: "s1", attempt: 1, verdict: VERDICT.PASS, id: "r-close", findings: [],
  });
  review.markedResolved = ["f-responded"];

  const next = applyReview(task, review);
  const closed = next.findings.find((f) => f.id === "f-responded");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, undefined, "走 respond 路径的不该带该标记");
});

test("R4 findingById 支持「文本编号」别名命中派生 id", () => {
  const derived = createFinding({
    severity: SEVERITY.BLOCKING,
    text: "[blocking] 整改闭环仍缺最后一步：G1 是唯一 neverResponded 的 blocking 项",
    id: "f_mw8dzih4_8",
    reviewId: "r-x",
    stageId: "s1",
  });
  const task = { ...baseTask(), findings: [derived] };

  assert.equal(findingById(task, "f_mw8dzih4_8").id, "f_mw8dzih4_8", "精确 id 优先");
  assert.equal(findingById(task, "G1").id, "f_mw8dzih4_8", "文本里的编号也能命中");
});

test("R5 别名命中多条时报错并列出候选，不瞎猜", () => {
  const a = createFinding({ severity: SEVERITY.BLOCKING, text: "G1 第一个", id: "f-a", reviewId: "r1", stageId: "s1" });
  const b = createFinding({ severity: SEVERITY.BLOCKING, text: "G1 第二个", id: "f-b", reviewId: "r2", stageId: "s1" });
  const task = { ...baseTask(), findings: [a, b] };

  assert.throws(
    () => findingById(task, "G1"),
    (e) => e instanceof MentorError && e.code === ERR.FINDING_UNKNOWN
      && Array.isArray(e.details?.candidates) && e.details.candidates.length === 2,
  );
});

test("R6 未知 id 报错时带上 known 与 aliases，便于自纠", () => {
  const one = createFinding({ severity: SEVERITY.BLOCKING, text: "G2 只有这一条", id: "f-only", reviewId: "r1", stageId: "s1" });
  const task = { ...baseTask(), findings: [one] };

  assert.throws(
    () => findingById(task, "G9"),
    (e) => e instanceof MentorError && e.code === ERR.FINDING_UNKNOWN
      && e.details?.known?.includes("f-only")
      && e.details?.aliases?.includes("G2"),
  );
});

test("R7 markedResolved 写文本编号（G1）也能关闭以派生 id 存储的 finding", () => {
  // 真机形态：finding 存成 f_mw8dzih4_8，审查方在 pass 的 markedResolved 里写的是 G1。
  // 只归一 respond 一侧不够——关闭路径同样要能解析别名。
  const stored = createFinding({
    severity: SEVERITY.BLOCKING,
    text: "[blocking] 整改闭环仍缺最后一步：G1 是唯一 neverResponded 的 blocking 项",
    id: "f_mw8dzih4_8", reviewId: "r-prev", stageId: "s1",
  });
  const task = { ...baseTask(), findings: [stored], stages: [{ id: "s1", dependsOn: [], writePaths: [] }] };
  const review = createReview({ stageId: "s1", attempt: 2, verdict: VERDICT.PASS, id: "r-alias" });
  review.markedResolved = ["G1"];

  const next = applyReview(task, review);
  const closed = next.findings.find((f) => f.id === "f_mw8dzih4_8");
  assert.equal(closed.status, FINDING_STATUS.CLOSED);
  assert.equal(closed.closedWithoutResponse, true);
  assert.equal(closed.resolvedByReviewId, "r-alias");
});

test("R8 markedResolved 写歧义编号（多命中）→ E_FINDING_UNKNOWN 且带 candidates", () => {
  const a = createFinding({ severity: SEVERITY.BLOCKING, text: "G2 第一个", id: "f-a", reviewId: "r1", stageId: "s1" });
  const b = createFinding({ severity: SEVERITY.BLOCKING, text: "G2 第二个", id: "f-b", reviewId: "r2", stageId: "s1" });
  const task = { ...baseTask(), findings: [a, b], stages: [{ id: "s1", dependsOn: [], writePaths: [] }] };
  const review = createReview({ stageId: "s1", attempt: 2, verdict: VERDICT.PASS, id: "r-amb" });
  review.markedResolved = ["G2"];

  assert.throws(
    () => applyReview(task, review),
    (e) => e instanceof MentorError && e.code === ERR.FINDING_UNKNOWN
      && Array.isArray(e.details?.candidates) && e.details.candidates.length === 2,
  );
});