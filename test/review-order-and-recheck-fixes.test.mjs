import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, runtimeReviewPrompt } from "../lib/index.js";
import { ERR } from "../src/errors.js";
import { stageAttemptRef, validatePlan, verificationPoint } from "../src/plan/dag.js";
import { amendedRuns } from "../src/plan/amendment.js";
import { captureMainReceipts, captureReceipts, evidenceImpact, findRecheckLoop, recheckScope } from "../src/review/criterion-evidence.js";
import { readReportExcerpt } from "../src/review/evidence-reader.js";
import { createReview } from "../src/review/review.js";
import { handoffInputs, isWorkerReceipt } from "../src/review/handoff.js";
import { assertReportAllowed } from "../src/review/report-gate.js";
import { buildWakeMessage } from "../src/review/wake.js";
import { WORKER_DENIAL, workerDenial } from "../src/review/worker-denials.js";
import { findReport } from "../src/runtime/activity.js";
import { applyBoundReview, requestCheckpoint } from "../src/runtime/checkpoints.js";
import { progressView } from "../src/runtime/progress-view.js";
import { teamBatch } from "../src/runtime/team.js";
import { mentorToolVisible } from "../src/runtime/tool-visibility.js";
import { HANDLERS, createMemoryStore, stageReportGated } from "../src/tools/handlers.js";

const check = (ids, extra = {}) => ({
  criterionIds: Array.isArray(ids) ? ids : [ids],
  source: "test-source",
  criterion: "verified",
  observation: "observed",
  status: "passed",
  ...extra,
});

function makeTempRoot(t, prefix = "mentor-fix-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("planned downstream serial overwrite does not trigger false evidence drift or recheck loop", (t) => {
  const root = makeTempRoot(t, "mentor-serial-");
  const file = path.join(root, "stage-a.md");
  fs.writeFileSync(file, "value=20\nowner=stable\n");

  const stages = [
    { id: "s1", title: "initial", criterionIds: ["c1"], dependsOn: [], writePaths: ["stage-a.md"] },
    { id: "trigger", title: "update", criterionIds: ["c2"], dependsOn: ["s1"], writePaths: ["stage-a.md"] },
  ];
  const task = {
    id: "t-serial",
    phase: "active",
    mainSessionId: "main",
    planVersion: 1,
    approvedPlanVersion: 1,
    enabled: true,
    revision: 1,
    workspaceRoot: root,
    criteria: [
      { id: "c1", text: "write 20" },
      { id: "c2", text: "update to 40" },
    ],
    stages,
    findings: [],
    nodeRuns: [],
    reviews: [],
    reviewJobs: [],
  };
  const store = createMemoryStore(task);

  const rep1 = stageReportGated(store, {
    planVersion: 1,
    attempt: 1,
    stageId: "s1",
    evidence: "wrote 20",
    evidenceRefs: [{ file: "stage-a.md", snippet: "value=20", criterionIds: ["c1"] }],
  });
  assert.ok(rep1.ok, JSON.stringify(rep1));
  let cur = store.get();
  store.set({
    ...cur,
    nodeRuns: cur.nodeRuns.map((r) => (r.stageId === "s1" ? { ...r, status: "accepted" } : r)),
    reviews: [...cur.reviews, { id: "rev-s1", scope: { kind: "stage", stageId: "s1", attempt: 1 }, verdict: "pass", checks: [check("c1")] }],
  });

  // Downstream serial stage legitimately updates the same file.
  fs.writeFileSync(file, "value=40\nowner=stable\n");
  const rep2 = stageReportGated(store, {
    planVersion: 1,
    attempt: 1,
    stageId: "trigger",
    evidence: "updated 20 to 40",
    evidenceRefs: [{ file: "stage-a.md", snippet: "value=40", criterionIds: ["c2"] }],
  });
  assert.ok(rep2.ok, JSON.stringify(rep2));
  // Before trigger is accepted, impactPreview still shows the change against s1.
  assert.equal(rep2.value.impactPreview.changes[0].stageId, "s1");

  cur = store.get();
  store.set({
    ...cur,
    nodeRuns: cur.nodeRuns.map((r) => (r.stageId === "trigger" ? { ...r, status: "accepted" } : r)),
    reviews: [...cur.reviews, { id: "rev-trigger", scope: { kind: "stage", stageId: "trigger", attempt: 1 }, verdict: "pass", checks: [check("c2")] }],
  });

  // Once trigger is accepted with overlapping writePaths, s1's snapshot is superseded -> no drift!
  assert.deepEqual(evidenceImpact(store.get()), []);
  const cp = requestCheckpoint(store, "completion", "all done");
  assert.equal(cp.kind, "completion");

  // External post-acceptance drift after trigger STILL flags trigger (the latest owner).
  store.set({ ...store.get(), pendingCheckpoint: null });
  fs.writeFileSync(file, "value=99\nowner=stable\n");
  const drift = evidenceImpact(store.get());
  assert.deepEqual(drift.map((c) => c.stageId), ["trigger"]);
});

test("recheck circuit breaker stops repeated automatic reopen on the same file and carries prior observe receipt", (t) => {
  const root = makeTempRoot(t, "mentor-loop-");
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "count = 1\n");

  const writeReceipt = {
    criterionId: "c-obs",
    sessionId: "w1",
    callId: "call-1",
    callSeq: 1,
    resultSeq: 2,
    tool: "write",
    outcome: "success",
    target: "a.txt",
    sha256: "abc",
  };
  const task = {
    id: "t-loop",
    phase: "active",
    mainSessionId: "main",
    planVersion: 1,
    approvedPlanVersion: 1,
    enabled: true,
    revision: 1,
    workspaceRoot: root,
    criteria: [
      { id: "c-val", text: "value checked" },
      { id: "c-obs", text: "write succeeded", observe: { tool: "write", outcome: "success", target: "a.txt" } },
    ],
    stages: [{ id: "a", title: "a", criterionIds: ["c-val", "c-obs"], dependsOn: [], writePaths: ["a.txt"] }],
    workers: [{ sessionId: "w1", stageId: "a", attempt: 1, planVersion: 1, status: "completed", receipts: [writeReceipt] }],
    findings: [],
    nodeRuns: [{ stageId: "a", attempt: 1, status: "pending", workerSessionId: "w1", reports: [] }],
    reviews: [],
    reviewJobs: [],
  };
  const store = createMemoryStore(task);

  const rep1 = stageReportGated(store, {
    planVersion: 1,
    attempt: 1,
    stageId: "a",
    evidence: "count is 1",
    evidenceRefs: [{ file: "a.txt", snippet: "count = 1", criterionIds: ["c-val", "c-obs"] }],
  });
  assert.ok(rep1.ok, JSON.stringify(rep1));
  let cur = store.get();
  store.set({
    ...cur,
    nodeRuns: cur.nodeRuns.map((r) => ({ ...r, status: "accepted" })),
    reviews: [{ id: "rev1", scope: { kind: "stage", stageId: "a", attempt: 1 }, verdict: "pass", checks: [check(["c-val", "c-obs"])] }],
  });

  // First external drift -> reopens a once.
  fs.writeFileSync(file, "count = 2\n");
  assert.throws(
    () => requestCheckpoint(store, "completion", "first attempt"),
    (err) => err.code === ERR.EVIDENCE_MISMATCH && err.details?.reopened === true && !err.details?.loopDetected,
  );
  assert.equal(store.get().recheckHistory.length, 1);

  // Recheck attempt 2 re-verifies file without running write again: prior verified observe receipt is carried!
  const rep2 = stageReportGated(store, {
    planVersion: 1,
    attempt: 2,
    stageId: "a",
    evidence: "verified count is 2",
    evidenceRefs: [{ file: "a.txt", snippet: "count = 2", criterionIds: ["c-val"] }],
  });
  assert.ok(rep2.ok, JSON.stringify(rep2));
  assert.ok(store.get().nodeRuns[0].reports.at(-1).bindings.some((b) => b.criterionId === "c-obs" && b.receipt?.callId === "call-1"));

  cur = store.get();
  store.set({
    ...cur,
    nodeRuns: cur.nodeRuns.map((r) => ({ ...r, status: "accepted" })),
    reviews: [...cur.reviews, { id: "rev2", scope: { kind: "stage", stageId: "a", attempt: 2 }, verdict: "pass", checks: [check(["c-val", "c-obs"])] }],
  });

  // Second drift on the exact same (a, a.txt) in the same planVersion hits the loop circuit breaker!
  fs.writeFileSync(file, "count = 3\n");
  const loopCheck = findRecheckLoop(store.get(), evidenceImpact(store.get(), undefined, { fingerprint: true }));
  assert.equal(loopCheck.loop, true);
  assert.throws(
    () => requestCheckpoint(store, "completion", "second attempt"),
    (err) => err.code === ERR.EVIDENCE_MISMATCH && err.details?.loopDetected === true,
  );
  // Circuit breaker must NOT reopen the stage or append another recheckHistory entry.
  assert.equal(store.get().recheckHistory.length, 1);
  assert.equal(store.get().nodeRuns[0].status, "accepted");
});

test("verificationPoint uses explicit verifyAt without hardcoded text regex", () => {
  const plainText = {
    id: "goal-2",
    text: "改动一个已绑定文件里的数字后，列出 recheck.criterionIds",
  };
  assert.equal(verificationPoint(plainText), "stage");
  assert.equal(verificationPoint({ ...plainText, verifyAt: "completion-recheck" }), "completion-recheck");

  const badPlan = validatePlan({
    criteria: [{ id: "g2", text: "recheck", verifyAt: "completion-recheck" }],
    stages: [{ id: "s1", criterionIds: ["g2"], dependsOn: [] }],
  });
  assert.equal(badPlan.ok, false);
  assert.equal(badPlan.errors[0].code, ERR.REVIEW_ORDER);
});

test("REVIEW_ORDER closure: completionOnlyCriterionId wake directs plan_amend and planAmend closes stale order finding", (t) => {
  const root = makeTempRoot(t, "mentor-order-");
  fs.writeFileSync(path.join(root, "a.txt"), "40\n");

  const task = {
    id: "t-order",
    phase: "reviewing",
    mainSessionId: "main",
    planVersion: 1,
    approvedPlanVersion: 1,
    enabled: true,
    revision: 5,
    workspaceRoot: root,
    team: { enabled: true, mode: "team", notes: [], directions: {} },
    criteria: [
      { id: "c-edit", text: "edit file to 40" },
      { id: "goal-2", text: "verify automatic recheck list" },
    ],
    stages: [{ id: "trigger", title: "trigger", criterionIds: ["c-edit", "goal-2"], dependsOn: [], writePaths: ["a.txt"] }],
    nodeRuns: [{ stageId: "trigger", attempt: 1, status: "reported", reports: [{ id: "rep1", stageId: "trigger", attempt: 1, planVersion: 1, evidence: "edited" }] }],
    findings: [],
    reviews: [],
    reviewJobs: [{
      id: "job-1",
      kind: "stage",
      stageId: "trigger",
      attempt: 1,
      planVersion: 1,
      sessionId: "rev-1",
      status: "running",
      readAt: 1,
      readPlanVersion: 1,
    }],
  };
  const store = createMemoryStore(task);

  const applied = applyBoundReview(store, {
    taskId: "t-order",
    reviewJobId: "job-1",
    kind: "stage",
    stageId: "trigger",
    attempt: 1,
    planVersion: 1,
    verdict: "revise",
    completionOnlyCriterionId: "goal-2",
    findings: ["goal-2 只能由整体验收产生"],
  }, "rev-1");
  assert.ok(applied.ok, JSON.stringify(applied));

  const afterReview = store.get();
  assert.equal(afterReview.findings.length, 1);
  assert.equal(afterReview.findings[0].reviewOrder?.criterionId, "goal-2");
  assert.equal(afterReview.reviewOrderIssues[0].reviewId, applied.value.reviewId);

  // Wake message must guide main session to mentor_plan_amend instead of respond+re-report.
  const wakeText = buildWakeMessage({ stageId: "trigger", attempt: 1, verdict: "revise", planVersion: 1 }, afterReview);
  assert.match(wakeText, /mentor_plan_amend/);
  assert.doesNotMatch(wakeText, /再重报该阶段/);

  // Plan amendment moves goal-2 to completion-recheck and auto-closes the stale order finding.
  const amended = HANDLERS.mentor_plan_amend(store, {
    taskId: "t-order",
    reason: "move goal-2 to completion-recheck",
    criteria: [
      { id: "c-edit", text: "edit file to 40" },
      { id: "goal-2", text: "verify automatic recheck list", verifyAt: "completion-recheck" },
    ],
    stages: [{ id: "trigger", title: "trigger", criterionIds: ["c-edit"], dependsOn: [], writePaths: ["a.txt"] }],
  });
  assert.ok(amended.ok, JSON.stringify(amended));

  const afterAmend = store.get();
  assert.equal(afterAmend.findings[0].status, "closed");
  assert.equal(afterAmend.findings[0].closedBy, "plan-amend");

  // Under the new planVersion, trigger is no longer blocked by the old order-conflict finding.
  store.set({ ...afterAmend, approvedPlanVersion: afterAmend.planVersion });
  assert.deepEqual(teamBatch(store.get(), 4), ["trigger"]);
  assert.equal(assertReportAllowed(store.get(), { planVersion: afterAmend.planVersion, stageId: "trigger" }).ok, true);
});

test("tool visibility: receiptInputs worker gets status, INTEGRATE is not shadowed by REVIEW_FAILED, and WeakMap respects revision", async (t) => {
  const task = {
    id: "t-vis",
    phase: "active",
    enabled: true,
    revision: 1,
    updatedAt: 10,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "main",
    criteria: [
      { id: "c1", text: "a", observe: { tool: "write", outcome: "success" } },
      { id: "c2", text: "b" },
    ],
    stages: [
      { id: "s1", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", criterionIds: ["c2"], dependsOn: ["s1"], receiptInputs: [{ stageId: "s1", criterionId: "c1" }] },
    ],
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "reported" },
      { stageId: "s2", attempt: 1, status: "running", workerSessionId: "w-handoff" },
    ],
    reviewJobs: [{ id: "j-fail", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1, status: "failed", error: "boom" }],
    findings: [],
    reviews: [],
  };

  // Non-team worker on a stage with receiptInputs still sees mentor_task_status.
  assert.equal(mentorToolVisible("mentor_task_status", task, "w-handoff"), true);
  assert.equal(mentorToolVisible("mentor_task_create", task, "w-handoff"), false);

  // Non-team worker on a stage WITHOUT receiptInputs does not see mentor_task_status.
  const noInputTask = {
    ...task,
    stages: task.stages.map((s) => (s.id === "s2" ? { id: "s2", criterionIds: ["c2"], dependsOn: ["s1"] } : s)),
  };
  assert.equal(mentorToolVisible("mentor_task_status", noInputTask, "w-handoff"), false);

  // When s1 has REVIEW_FAILED and s2 is awaiting-integration, main still sees mentor_stage_report!
  const integrateTask = {
    ...task,
    nodeRuns: [
      { stageId: "s1", attempt: 1, status: "reported" },
      { stageId: "s2", attempt: 1, status: "awaiting-integration" },
    ],
  };
  assert.equal(mentorToolVisible("mentor_stage_report", integrateTask, "main"), true);

  // Reused context object across revision changes must not serve stale visibility.
  const whenByTool = new Map();
  const ctx = {
    tools: {
      register(tool, opts) {
        whenByTool.set(tool.name, opts?.when);
      },
    },
    effect() {},
  };
  const dispose = await apply(ctx, { stateDir: "" });
  t.after(() => dispose());
  const sharedContext = { agent: { session: { id: "main-reused", header: { cwd: process.cwd() } } } };
  assert.equal(whenByTool.get("mentor_task_create")(sharedContext), true);
  // 2026-11-24 契约变更（工具死锁修复）：
  //   原断言为 false —— 「主会话无任务时不放行 mentor_plan_submit」。
  //   该断言成立的前提是「when 会被反复求值、随任务创建即时变化」，真机证伪：
  //   宿主在会话开始时求值一次即定型，中途不重算（实测 2026-11-24：任务 13:41:30
  //   落盘，本会话工具表仍只有 4 个；同时验证 findSession 在建任务后同步即可命中，
  //   故不是取数失败，而是不再求值）。继续用 when 剪裁工具，只会让 false 永久固化，
  //   任务建成后 nextStep 指向的 plan_submit / task_clear 全都不存在 → 死锁。
  //   现改为 task=null 时主会话全放行，动作合法性下沉到 handlers.js 的
  //   requireTask（无任务 → E_NO_TASK + hint）与 taskCreate（进行中 → E_TASK_EXISTS）。
  //   子会话（reviewer / worker）的严格收窄在函数前段 return，不受此变更影响，
  //   见下方 332-350 行的既有断言与 guard-and-visibility 的 G8 用例。
  assert.equal(whenByTool.get("mentor_plan_submit")(sharedContext), true);

  const store = await dispose.store.forSession("main-reused");
  HANDLERS.mentor_task_create(store, { objective: "fresh", workspaceRoot: process.cwd(), mainSessionId: "main-reused" });
  // Same sharedContext object now sees planning tools immediately!
  assert.equal(whenByTool.get("mentor_task_create")(sharedContext), false);
  assert.equal(whenByTool.get("mentor_plan_submit")(sharedContext), true);
});

test("direct handoff: planVersion binding, read-only amend retention, activity/prompt/progress-view exposure, and non-empty worker tool schema", async (t) => {
  const root = makeTempRoot(t, "mentor-handoff-");
  const receipt = { criterionId: "c1", sessionId: "w1", callId: "call-1", tool: "write", outcome: "success" };
  const baseTask = {
    id: "t-ho",
    phase: "reviewing",
    planVersion: 2,
    approvedPlanVersion: 2,
    mainSessionId: "main",
    workspaceRoot: root,
    criteria: [
      { id: "c1", text: "s1 write", observe: { tool: "write", outcome: "success" } },
      { id: "c2", text: "s2 consume" },
      { id: "g-recheck", text: "recheck proof", verifyAt: "completion-recheck" },
    ],
    stages: [
      { id: "s1", title: "sender", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "receiver", criterionIds: ["c2"], dependsOn: ["s1"], receiptInputs: [{ stageId: "s1", criterionId: "c1" }] },
    ],
    workers: [{ sessionId: "w1", stageId: "s1", attempt: 1, planVersion: 1, status: "completed", receipts: [receipt] }],
    nodeRuns: [
      {
        stageId: "s1",
        attempt: 1,
        status: "accepted",
        reports: [{ id: "rep-s1", stageId: "s1", attempt: 1, planVersion: 2, carriedFrom: { planVersion: 1 }, bindings: [{ criterionId: "c1", receipt }] }],
      },
      {
        stageId: "s2",
        attempt: 1,
        status: "accepted",
        reports: [{
          id: "rep-s2",
          stageId: "s2",
          attempt: 1,
          planVersion: 2,
          evidence: "consumed",
          handoff: { sessionId: "w2", inputs: [{ stageId: "s1", criterionId: "c1", reportId: "rep-s1", receiptId: "w1/call/call-1" }] },
          impactPreview: { changes: [{ stageId: "s1", criterionIds: ["c1"] }] },
        }],
      },
    ],
    reviews: [
      { id: "rev-s1", scope: { kind: "stage", stageId: "s1", attempt: 1 }, verdict: "pass", checks: [check("c1")] },
      { id: "rev-s2", scope: { kind: "stage", stageId: "s2", attempt: 1 }, verdict: "pass", checks: [check("c2")] },
    ],
    recheckHistory: [{ id: "rc-1", planVersion: 2, at: 123, changes: [], reopened: [{ stageId: "s1", criterionIds: ["c1"] }], retainedStages: [] }],
    findings: [],
  };

  // isWorkerReceipt rejects wrong planVersion, accepts matching or carriedFrom planVersion.
  assert.equal(isWorkerReceipt(baseTask, "s1", receipt, 2), false);
  assert.equal(isWorkerReceipt(baseTask, "s1", receipt, 1), true);
  assert.equal(handoffInputs(baseTask, baseTask.stages[1])[0].receiptId, "w1/call/call-1");

  // findReport & runtimeReviewPrompt both expose handoff and impactPreview.
  const full = findReport(baseTask, "rep-s2");
  assert.equal(full.handoff.sessionId, "w2");
  assert.equal(full.impactPreview.changes[0].stageId, "s1");
  const prompt = runtimeReviewPrompt(baseTask, { id: "j2", kind: "stage", stageId: "s2", attempt: 1, planVersion: 2 });
  assert.match(prompt, /"handoff":/);
  assert.match(prompt, /"impactPreview":/);
  assert.match(prompt, /"attempt":1/);

  // amendedRuns preserves accepted read-only handoff stage when only unrelated completion criterion changes.
  const amended = amendedRuns(
    baseTask,
    baseTask.stages,
    baseTask.criteria.map((c) => (c.id === "g-recheck" ? { ...c, text: "updated recheck text" } : c)),
    3,
  );
  assert.ok(amended.keptStages.includes("s2"));

  // progressView exposes both handoff proofs and completion-recheck claims.
  const view = progressView(baseTask, { text: "ready" });
  const recClaim = view.claims.find((c) => c.id === "g-recheck");
  assert.equal(recClaim?.stageId, "__completion__");
  assert.equal(recClaim?.proofs[0]?.recheck?.id, "rc-1");
  const hoClaim = view.claims.find((c) => c.id === "c2");
  assert.equal(hoClaim?.proofs[0]?.handoff?.sessionId, "w2");

  // Verify worker setup sees pre-registered worker session & registers non-empty mentor_team_context schema.
  let seenDuringSetup = null;
  let contextParams = null;
  const tools = new Map();
  const main = {
    session: { id: "main-ho", header: { cwd: root } },
    options: { provider: "test", model: "test" },
    ctx: { get: () => undefined },
  };
  let pluginStore;
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    agents: {
      get: (id) => (id === "main-ho" ? main : undefined),
      async create({ sessionId, setup }) {
        seenDuringSetup = pluginStore.findSession(sessionId)?.get()?.id ?? null;
        const local = new Map();
        const names = new Set(["read", "glob", "grep", "write", "edit", "mentor_task_status"]);
        const agent = {
          session: { id: sessionId, append() {}, snapshotEvents: () => [{ type: "turn/end", data: { reason: { kind: "completed" } } }] },
          whenIdle: () => Promise.resolve(),
          followup: async () => {},
        };
        await setup({
          tools: {
            restrict() {},
            guard() {},
            view: () => ({ visible: names, restrictableNames: names }),
            register: (tool) => local.set(tool.name, tool),
          },
        }, agent);
        contextParams = local.get("mentor_team_context")?.parameters ?? null;
        return { agent, dispose() {} };
      },
    },
  };
  const plugin = await apply(ctx, { stateDir: "" });
  pluginStore = plugin.store;
  t.after(() => plugin());
  const store = await plugin.store.forSession("main-ho");
  store.set({
    ...baseTask,
    id: "t-ho-run",
    phase: "active",
    mainSessionId: "main-ho",
    nodeRuns: [baseTask.nodeRuns[0], { stageId: "s2", attempt: 1, status: "pending", reports: [] }],
  });
  await tools.get("mentor_delegate_nodes").execute({ stageIds: ["s2"], waitForCompletion: true }, { agent: main });
  assert.equal(seenDuringSetup, "t-ho-run", "worker session should be registered before agents.create setup");
  assert.ok(contextParams && Object.keys(contextParams).length > 0, "worker mentor_team_context must have non-empty parameters");
});

test("attemptRef validation lives in stageReportGated and tool calls reject attempt guessing on rework", async (t) => {
  const root = makeTempRoot(t, "mentor-ref-");
  fs.writeFileSync(path.join(root, "f.txt"), "hello\n");

  const tools = new Map();
  const main = { session: { id: "main-ref", header: { cwd: root } }, options: { provider: "t", model: "m" } };
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); } }, effect() {} };
  const dispose = await apply(ctx, { stateDir: "" });
  t.after(() => dispose());

  const store = await dispose.store.forSession("main-ref");
  store.set({
    id: "t-ref",
    phase: "active",
    enabled: true,
    revision: 1,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "main-ref",
    workspaceRoot: root,
    criteria: [{ id: "c1", text: "ok" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 2, status: "rework", reports: [] }],
    findings: [],
    reviews: [],
    reviewJobs: [],
  });

  // Stale attemptRef fails directly at HANDLERS layer (T4 single source of truth).
  const badRef = HANDLERS.mentor_stage_report(store, {
    stageId: "s1",
    attemptRef: stageAttemptRef(store.get(), "s1", 1),
    planVersion: 1,
    evidence: "hello",
    evidenceRefs: [{ file: "f.txt", snippet: "hello" }],
  });
  assert.equal(badRef.code, ERR.STALE_ATTEMPT);

  // Via model tool, guessing attempt: 2 without attemptRef is rejected.
  const guessed = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attempt: 2,
    planVersion: 1,
    evidence: "hello",
    evidenceRefs: [{ file: "f.txt", snippet: "hello" }],
  }, { agent: main }));
  assert.equal(guessed.code, ERR.STALE_ATTEMPT);

  // Passing valid attemptRef without attempt succeeds and binds attempt=2!
  const good = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: stageAttemptRef(store.get(), "s1", 2),
    planVersion: 1,
    evidence: "hello",
    evidenceRefs: [{ file: "f.txt", snippet: "hello" }],
  }, { agent: main }));
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.value.attempt, 2);
});

test("workerDenial handles wrapped/multiline errors and captureReceipts supports errorCode & errorContains", () => {
  assert.deepEqual(workerDenial("Error: worker-write-outside-owned-paths"), {
    code: WORKER_DENIAL.OUTSIDE,
    reason: WORKER_DENIAL.OUTSIDE,
  });
  assert.deepEqual(workerDenial("Error: Error: worker-write-outside-owned-paths: C:\\x.txt\n    at guard"), {
    code: WORKER_DENIAL.OUTSIDE,
    reason: "worker-write-outside-owned-paths: C:\\x.txt",
  });
  assert.equal(workerDenial("Error: worker-write-outside-owned-paths-fake"), null);

  const events = [
    { type: "tool/call", seq: 1, data: { callId: "c1", name: "write", arguments: JSON.stringify({ file_path: "bad.txt" }) } },
    { type: "tool/result", seq: 2, data: { message: { toolCallId: "c1", isError: true, content: [{ type: "text", text: "Error: worker-write-outside-owned-paths: bad.txt\nat line 1" }] } } },
    { type: "tool/call", seq: 3, data: { callId: "c2", name: "read", arguments: JSON.stringify({ file_path: "missing.txt" }) } },
    { type: "tool/result", seq: 4, data: { message: { toolCallId: "c2", isError: true, content: [{ type: "text", text: "Error: ENOENT: no such file or directory, open 'missing.txt'" }] } } },
  ];
  const criteria = [
    { id: "deny-code", text: "deny by code", observe: { tool: "write", outcome: "error", errorCode: WORKER_DENIAL.OUTSIDE } },
    { id: "deny-text", text: "deny by legacy text", observe: { tool: "write", outcome: "error", error: "worker-write-outside-owned-paths" } },
    { id: "enoent", text: "missing file error", observe: { tool: "read", outcome: "error", errorContains: "ENOENT" } },
  ];
  const receipts = captureReceipts(events, criteria, "worker-1", process.cwd());
  assert.deepEqual(receipts.map((r) => r.criterionId).sort(), ["deny-code", "deny-text", "enoent"]);
});

test("main-session stage report auto-captures observe receipts without receiptCallIds and guards rework/delegation boundaries", async (t) => {
  const root = makeTempRoot(t, "mentor-main-receipt-");
  const targetFile = path.join(root, "smoke.txt");
  fs.writeFileSync(targetFile, "mentor-smoke-ok\n");

  const tools = new Map();
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    effect() {},
  };
  const dispose = await apply(ctx, { stateDir: "" });
  t.after(() => dispose());

  const sessionEvents = [];
  const main = {
    session: {
      id: "main-observe",
      header: { cwd: root },
      snapshotEvents: () => sessionEvents,
    },
  };
  const store = await dispose.store.forSession("main-observe");
  const approvedAt = Date.now() - 5000;
  store.set({
    id: "t-main-obs",
    phase: "active",
    enabled: true,
    planVersion: 1,
    approvedPlanVersion: 1,
    approvedAt,
    mainSessionId: "main-observe",
    workspaceRoot: root,
    revision: 1,
    criteria: [
      { id: "c1", text: "smoke.txt content matches" },
      { id: "c2", text: "write succeeded", observe: { tool: "write", outcome: "success", target: "smoke.txt" } },
    ],
    stages: [{ id: "s1", criterionIds: ["c1", "c2"], dependsOn: [], writePaths: ["smoke.txt"] }],
    nodeRuns: [],
    findings: [],
    reviews: [],
    reviewJobs: [],
  });

  // Pre-approval event must NOT satisfy post-approval stage execution.
  sessionEvents.push(
    { type: "tool/call", seq: 1, time: approvedAt - 1000, data: { callId: "old-call", name: "write", arguments: JSON.stringify({ file_path: targetFile }) } },
    { type: "tool/result", seq: 2, time: approvedAt - 900, data: { message: { toolCallId: "old-call", isError: false, content: [{ type: "text", text: "Created file" }] } } },
  );
  const beforeStart = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    planVersion: 1,
    evidence: "stale only",
    evidenceRefs: [{ file: "smoke.txt", snippet: "mentor-smoke-ok", criterionIds: ["c1"] }],
  }, { agent: main }));
  assert.equal(beforeStart.ok, false);
  assert.equal(beforeStart.code, ERR.EVIDENCE_MISMATCH);
  assert.match(beforeStart.message, /主会话自执行/);

  // Standard flow: mentor_node_start -> write tool call -> mentor_stage_report without receiptCallIds.
  const started = JSON.parse(await tools.get("mentor_node_start").execute({ stageId: "s1" }, { agent: main }));
  assert.equal(started.ok, true, JSON.stringify(started));
  const writeAt = started.value.startedAt + 10;
  sessionEvents.push(
    { type: "tool/call", seq: 10, time: writeAt, data: { callId: "call-s1-a1", name: "write", arguments: JSON.stringify({ file_path: targetFile }) } },
    { type: "tool/result", seq: 11, time: writeAt + 5, data: { message: { toolCallId: "call-s1-a1", isError: false, content: [{ type: "text", text: "Created file" }] } } },
  );
  const reported = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: started.value.attemptRef,
    planVersion: 1,
    evidence: "wrote smoke.txt",
    evidenceRefs: [{ file: "smoke.txt", snippet: "mentor-smoke-ok", criterionIds: ["c1"] }],
  }, { agent: main }));
  assert.equal(reported.ok, true, JSON.stringify(reported));
  const bindings1 = store.get().nodeRuns[0].reports.at(-1).bindings;
  assert.equal(bindings1.find((b) => b.criterionId === "c2")?.receipt?.callId, "call-s1-a1");

  // Rework after revise: attempt-1 write event must NOT satisfy attempt 2, AND stale batchId must clear.
  const cur = store.get();
  const job1 = { id: "job-s1-1", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1, sessionId: "rev-1", status: "running", readAt: 1, readPlanVersion: 1 };
  store.set({
    ...cur,
    nodeRuns: cur.nodeRuns.map((r) => ({ ...r, batchId: "legacy-batch", workerSessionId: "legacy-worker" })),
    reviewJobs: [job1],
  });
  const revised = applyBoundReview(store, {
    taskId: "t-main-obs",
    reviewJobId: "job-s1-1",
    kind: "stage",
    stageId: "s1",
    attempt: 1,
    planVersion: 1,
    verdict: "revise",
    findings: ["redo write"],
  }, "rev-1");
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(store.get().nodeRuns[0].batchId, null);
  assert.equal(store.get().nodeRuns[0].workerSessionId, null);
  assert.equal(store.get().reviews.at(-1).scope.planVersion, 1);

  // Respond to finding so report gate allows attempt 2.
  const findingId = store.get().findings[0].id;
  assert.equal(HANDLERS.mentor_finding_respond(store, { findingId, summary: "will redo" }).ok, true);

  // Attempt 2 without a new write event must be rejected even if main omits mentor_node_start.
  const attempt2Ref = stageAttemptRef(store.get(), "s1", 2);
  const staleAttempt2 = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: attempt2Ref,
    planVersion: 1,
    evidence: "did not re-write",
    evidenceRefs: [{ file: "smoke.txt", snippet: "mentor-smoke-ok", criterionIds: ["c1"] }],
  }, { agent: main }));
  assert.equal(staleAttempt2.ok, false);
  assert.equal(staleAttempt2.code, ERR.EVIDENCE_MISMATCH);

  // Fresh write after revise succeeds on attempt 2!
  const redoAt = Date.now() + 20;
  sessionEvents.push(
    { type: "tool/call", seq: 20, time: redoAt, data: { callId: "call-s1-a2", name: "write", arguments: JSON.stringify({ file_path: targetFile }) } },
    { type: "tool/result", seq: 21, time: redoAt + 5, data: { message: { toolCallId: "call-s1-a2", isError: false, content: [{ type: "text", text: "Updated file" }] } } },
  );
  const goodAttempt2 = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: attempt2Ref,
    planVersion: 1,
    evidence: "re-wrote smoke.txt",
    evidenceRefs: [{ file: "smoke.txt", snippet: "mentor-smoke-ok", criterionIds: ["c1"] }],
  }, { agent: main }));
  assert.equal(goodAttempt2.ok, true, JSON.stringify(goodAttempt2));
  assert.equal(store.get().nodeRuns[0].reports.at(-1).bindings.find((b) => b.criterionId === "c2")?.receipt?.callId, "call-s1-a2");

  // Worker-delegated stage must NEVER capture main-session receipts.
  const delegatedTask = {
    ...store.get(),
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "awaiting-integration", batchId: "b-worker", startedAt: approvedAt, startedAttempt: 1, reports: [] }],
  };
  assert.equal(captureMainReceipts(delegatedTask, { stageId: "s1" }, "main-observe", sessionEvents), undefined);
  assert.throws(
    () => captureMainReceipts(delegatedTask, { stageId: "s1", receiptCallIds: ["call-s1-a1"] }, "main-observe", sessionEvents),
    (err) => err.code === ERR.EVIDENCE_UNKNOWN,
  );
});

test("stage reviews persist scope.planVersion and recheckScope respects planVersion", (t) => {
  const root = makeTempRoot(t, "mentor-stage-pv-");
  const content = "v=1\n";
  fs.writeFileSync(path.join(root, "a.txt"), content, "utf8");
  const hash = createHash("sha256").update(content, "utf8").digest("hex");

  // Direct createReview without planVersion keeps backward-compatible scope shape.
  const bare = createReview({ stageId: "s1", attempt: 1, verdict: "pass" });
  assert.equal("planVersion" in bare.scope, false);

  const task = {
    id: "t-pv",
    phase: "reviewing",
    enabled: true,
    planVersion: 4,
    approvedPlanVersion: 4,
    mainSessionId: "main",
    workspaceRoot: root,
    revision: 1,
    criteria: [{ id: "c1", text: "v=1" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "reported", reports: [{ id: "rep-1", stageId: "s1", attempt: 1, planVersion: 4, evidence: "ok", bindings: [{ criterionId: "c1", file: { file: "a.txt", textSha256: hash } }] }] }],
    findings: [],
    reviews: [
      { id: "old-pv-rev", scope: { kind: "stage", stageId: "s1", attempt: 1, planVersion: 1 }, verdict: "pass", checks: [check("c1")] },
    ],
    reviewJobs: [{ id: "job-pv4", kind: "stage", stageId: "s1", attempt: 1, planVersion: 4, sessionId: "rev-pv4", status: "running", readAt: 1, readPlanVersion: 4 }],
  };
  const store = createMemoryStore(task);
  const applied = applyBoundReview(store, {
    taskId: "t-pv",
    reviewJobId: "job-pv4",
    kind: "stage",
    stageId: "s1",
    attempt: 1,
    planVersion: 4,
    verdict: "pass",
    checks: [check("c1")],
  }, "rev-pv4");
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(store.get().reviews.at(-1).scope.planVersion, 4);

  // recheckScope must NOT treat an older planVersion pass review as valid for a newer planVersion.
  const crossPlanTask = {
    ...store.get(),
    planVersion: 5,
    reviews: [{ id: "old-pv-rev", scope: { kind: "stage", stageId: "s1", attempt: 1, planVersion: 4 }, verdict: "pass", checks: [check("c1")] }],
  };
  const scope = recheckScope(crossPlanTask, [{ stageId: "s1", criterionIds: [] }]);
  assert.deepEqual(scope.affected[0].retainedCriterionIds, []);
  assert.equal(scope.affected[0].reviewId, undefined);
});

test("missing integrationEvidence returns ERR.EVIDENCE_REQUIRED with tailored single-worker vs parallel wording", async (t) => {
  const root = makeTempRoot(t, "mentor-int-ev-");
  fs.writeFileSync(path.join(root, "out.txt"), "ok\n");

  const tools = new Map();
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    effect() {},
  };
  const dispose = await apply(ctx, { stateDir: "" });
  t.after(() => dispose());

  const main = { session: { id: "main-int", header: { cwd: root }, snapshotEvents: () => [] } };
  const store = await dispose.store.forSession("main-int");
  const baseTask = {
    id: "t-int",
    phase: "active",
    enabled: true,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "main-int",
    workspaceRoot: root,
    revision: 1,
    criteria: [{ id: "c1", text: "ok" }, { id: "c2", text: "ok2" }],
    stages: [
      { id: "s1", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", criterionIds: ["c2"], dependsOn: [] },
    ],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "awaiting-integration", batchId: "b-single", reports: [] }],
    delegations: [{ batchId: "b-single", planVersion: 1, stageIds: ["s1"], status: "completed" }],
    findings: [],
    reviews: [],
    reviewJobs: [],
  };
  store.set(baseTask);

  const singleRes = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: stageAttemptRef(baseTask, "s1", 1),
    planVersion: 1,
    evidence: "checked",
    evidenceRefs: [{ file: "out.txt", snippet: "ok" }],
  }, { agent: main }));
  assert.equal(singleRes.ok, false);
  assert.equal(singleRes.code, ERR.EVIDENCE_REQUIRED);
  assert.match(singleRes.message, /助手交付成果/);
  assert.equal(singleRes.details.field, "integrationEvidence");

  store.set({
    ...baseTask,
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "awaiting-integration", batchId: "b-multi", reports: [] }],
    delegations: [{ batchId: "b-multi", planVersion: 1, stageIds: ["s1", "s2"], status: "completed" }],
  });
  const parallelRes = JSON.parse(await tools.get("mentor_stage_report").execute({
    stageId: "s1",
    attemptRef: stageAttemptRef(baseTask, "s1", 1),
    planVersion: 1,
    evidence: "checked",
    evidenceRefs: [{ file: "out.txt", snippet: "ok" }],
  }, { agent: main }));
  assert.equal(parallelRes.ok, false);
  assert.equal(parallelRes.code, ERR.EVIDENCE_REQUIRED);
  assert.match(parallelRes.message, /并行成果/);
});

test("readReportExcerpt returns exact UTF-8 byteSize and textSha256 in both full and boundLinesOnly modes", (t) => {
  const root = makeTempRoot(t, "mentor-reader-meta-");
  const initial = "# 标题\nvalue = 175\n";
  fs.writeFileSync(path.join(root, "smoke.md"), initial, "utf8");

  const task = {
    id: "t-read",
    phase: "reviewing",
    enabled: true,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "main",
    workspaceRoot: root,
    revision: 1,
    criteria: [{ id: "c1", text: "value checked" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [],
    findings: [],
    reviews: [],
    reviewJobs: [],
  };
  const store = createMemoryStore(task);
  const rep = stageReportGated(store, {
    planVersion: 1,
    attempt: 1,
    stageId: "s1",
    evidence: "checked smoke.md",
    evidenceRefs: [{ file: "smoke.md", snippet: "value = 175", criterionIds: ["c1"] }],
  });
  assert.equal(rep.ok, true, JSON.stringify(rep));

  const job = { id: "j-read", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1, sessionId: "rev-read", status: "running" };
  const withJob = { ...store.get(), reviewJobs: [job] };

  const full = readReportExcerpt(withJob, "t-read", job, { reportId: rep.value.reportId, file: "smoke.md" });
  assert.equal(full.byteSize, Buffer.byteLength(initial, "utf8"));
  assert.notEqual(full.byteSize, initial.length, "multi-byte UTF-8 byteSize must differ from UTF-16 length");
  assert.equal(full.textSha256, createHash("sha256").update(initial, "utf8").digest("hex"));

  // Modify an unbound line so readReportExcerpt takes the boundLinesOnly branch.
  const modified = "# 新标题（变更）\nvalue = 175\n";
  fs.writeFileSync(path.join(root, "smoke.md"), modified, "utf8");
  const bound = readReportExcerpt(withJob, "t-read", job, { reportId: rep.value.reportId, file: "smoke.md" });
  assert.equal(bound.boundLinesOnly, true);
  assert.equal(bound.byteSize, Buffer.byteLength(modified, "utf8"));
  assert.equal(bound.textSha256, createHash("sha256").update(modified, "utf8").digest("hex"));
});
