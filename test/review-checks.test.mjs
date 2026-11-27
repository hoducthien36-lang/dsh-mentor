/**
 * 审查检查清单（改造 s4，矩阵 G1）。
 *
 * 旧实现的强制协议：审查会话必须先 task_review_check_plan 立清单，再打开产物。
 * mentor 没有审查会话内状态，所以把约束落到裁决入参：每条检查必须同时给
 * source（依据什么）与 criterion（要证明什么），并可由 requireChecksForPass 强制。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { normalizeChecks } from "../src/review/review.js";
import { PHASES } from "../src/state/machine.js";
import { gatedReport } from "./support/fixtures.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const STAGES = [{ id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] }];

function reportedStore(settings) {
  const store = createMemoryStore();
  if (settings) store.settings = settings;
  HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "检查清单测试" });
  assert.equal(HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages: STAGES }).ok, true);
  assert.equal(gatedReport(store, { stageId: "s1", attempt: 1, evidence: "做了" }).ok, true);
  return store;
}

test("K1 normalizeChecks 要求 source + criterion 都非空", () => {
  const checks = normalizeChecks([
    { source: "读 src/x.js:12", criterion: "c1 有产出", criterionIds: ["c1"] },
  ]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].source, "读 src/x.js:12");
  assert.equal(checks[0].criterion, "c1 有产出");
  assert.deepEqual(checks[0].criterionIds, ["c1"]);
  assert.ok(checks[0].id.startsWith("ck_"));

  assert.throws(() => normalizeChecks([{ criterion: "只给了一半" }]), /source/);
  assert.throws(() => normalizeChecks([{ source: "只有依据" }]), /criterion/);
  assert.throws(() => normalizeChecks(["我不是对象"]), /必须是对象/);
});

test("K2 未配置强制时，pass 可以不带 checks（向后兼容）", () => {
  const store = reportedStore();
  // 越界读风险点：内存 store 根本没有 settings 字段，
  // reviewApply 里 `store.settings?.requireChecksForPass` 必须安全短路，不能抛 TypeError
  assert.equal(store.settings, undefined, "内存 store 不应有 settings 字段");
  const r = HANDLERS.mentor_review_apply(store, { stageId: "s1", attempt: 1, verdict: "pass" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(store.get().reviews.at(-1).checks, [], "空清单落成空数组而不是 undefined");
});

test("K3 requireChecksForPass=true 时，pass 不带 checks 被拒（E_CHECKS_REQUIRED）", () => {
  const store = reportedStore({ requireChecksForPass: true });
  const r = HANDLERS.mentor_review_apply(store, { stageId: "s1", attempt: 1, verdict: "pass" });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "E_CHECKS_REQUIRED");
  assert.equal(store.get().phase, PHASES.REVIEWING, "拒绝时不许改状态");
  assert.equal(store.get().reviews.length, 0, "拒绝时不许写审查记录");
});

test("K4 requireChecksForPass=true 且给了清单 → pass 成立，清单入库", () => {
  const store = reportedStore({ requireChecksForPass: true });
  const r = HANDLERS.mentor_review_apply(store, {
    stageId: "s1",
    attempt: 1,
    verdict: "pass",
    checks: [{ source: "读 verification/old-vs-new-matrix.md", criterion: "矩阵覆盖七节", criterionIds: ["c1"] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const review = store.get().reviews.at(-1);
  assert.equal(review.checks.length, 1);
  assert.equal(review.checks[0].source, "读 verification/old-vs-new-matrix.md");
  assert.deepEqual(review.checks[0].criterionIds, ["c1"]);
});

test("K5 revise 不受 requireChecksForPass 限制（打回不需要先立清单）", () => {
  const store = reportedStore({ requireChecksForPass: true });
  const r = HANDLERS.mentor_review_apply(store, {
    stageId: "s1",
    attempt: 1,
    verdict: "revise",
    findings: ["证据不够具体"],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(store.get().reviews.at(-1).verdict, "revise");
});

test("K6 检查清单随 review 一起可读（面板/历史无损）", () => {
  const store = reportedStore({ requireChecksForPass: true });
  HANDLERS.mentor_review_apply(store, {
    stageId: "s1",
    attempt: 1,
    verdict: "pass",
    checks: [
      { source: "跑 node --test", criterion: "318 全过", criterionIds: ["c1"] },
      { source: "读 handlers.js:788", criterion: "枚举校验存在", criterionIds: ["c1"] },
    ],
  });
  const checks = store.get().reviews.at(-1).checks;
  assert.equal(checks.length, 2);
  assert.equal(checks[1].source, "读 handlers.js:788");
});
