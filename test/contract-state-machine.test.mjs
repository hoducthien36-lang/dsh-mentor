/**
 * 状态机与门禁的**契约测试**（先测后改）。
 *
 * 这四条锁的是「应该怎样」，不是「现在怎样」。所以在当前实现下它们必须**全部失败**；
 * 如果某条现在是绿的，说明那条契约已经被实现了，要在阶段报告里注明。
 *
 * 与既有 test/*.test.mjs 的关系：那些测试大多在断言当前行为（这也是 447 条全绿
 * 却仍带缺陷的原因）；本文件反过来，先钉契约，再改实现。
 *
 * 硬约束：只 import 当前已存在的导出。setPhase 用动态 import + try/catch，
 * 避免 ESM 链接期失败把 4 条红塌成 1 个文件级失败。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { HANDLERS, createMemoryStore, stageReportGated } from "../src/tools/handlers.js";
import { PHASES, canTransition } from "../src/state/machine.js";
import { requestCheckpoint, applyBoundReview } from "../src/runtime/checkpoints.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 最小可用任务：字段齐到能被 requestCheckpoint / applyBoundReview / stage_report 接受 */
function makeTask(over = {}) {
  return {
    id: "t_contract",
    revision: 1,
    enabled: true,
    mainSessionId: "main-1",
    phase: PHASES.PLANNING,
    planVersion: 1,
    criteria: [{ id: "c1", text: "x" }],
    stages: [{ id: "s1", title: "阶段一", criterionIds: ["c1"], dependsOn: [], writePaths: [] }],
    nodeRuns: [],
    findings: [],
    reviews: [],
    reviewJobs: [],
    reviewDispatches: [],
    wakeDispatches: [],
    workspaceRoot: ROOT,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * T1：检查点不得替状态机做决定
 * ------------------------------------------------------------------ */

test("T1 requestCheckpoint 不得从 awaiting-approval 静默进入 reviewing", () => {
  // 前提：转移表自己就认为这条边非法
  assert.equal(
    canTransition(PHASES.AWAITING_APPROVAL, PHASES.REVIEWING),
    false,
    "转移表认为 awaiting-approval → reviewing 非法",
  );

  const store = createMemoryStore(makeTask({ phase: PHASES.AWAITING_APPROVAL }));

  assert.throws(
    () => requestCheckpoint(store, "plan"),
    (err) => err?.code === "E_ILLEGAL_TRANSITION",
    "requestCheckpoint 走了转移表禁止的边，应当抛 E_ILLEGAL_TRANSITION，而不是直接改 phase",
  );

  assert.equal(store.get().phase, PHASES.AWAITING_APPROVAL, "被拒之后状态不应被改动");
});

/* ------------------------------------------------------------------ *
 * T2：审查裁决也不得凭空造出转移边
 * ------------------------------------------------------------------ */

test("T2 applyBoundReview(plan, revise) 不得产生转移表没有的 reviewing → planning", () => {
  assert.equal(canTransition(PHASES.REVIEWING, PHASES.PLANNING), false, "转移表里没有 reviewing → planning 这条边");

  const store = createMemoryStore(
    makeTask({
      phase: PHASES.REVIEWING,
      pendingCheckpoint: {
        kind: "plan",
        stageId: "__plan__",
        attempt: 1,
        planVersion: 1,
        evidence: "",
        requestedAt: 1,
      },
      reviewJobs: [
        {
          id: "job-plan",
          kind: "plan",
          stageId: "__plan__",
          attempt: 1,
          planVersion: 1,
          sessionId: "rev-1",
          status: "running",
          readAt: 1,
          readPlanVersion: 1,
        },
      ],
    }),
  );

  assert.throws(
    () =>
      applyBoundReview(
        store,
        {
          reviewJobId: "job-plan",
          planVersion: 1,
          stageId: "__plan__",
          attempt: 1,
          kind: "plan",
          verdict: "revise",
          findings: ["契约测试：计划缺验收细节"],
        },
        "rev-1",
      ),
    (err) => err?.code === "E_ILLEGAL_TRANSITION",
    "判 revise 后直接写回 planning，等于造了一条转移表没有的边，应当显式拒绝或先补模型",
  );

  assert.notEqual(store.get().phase, PHASES.PLANNING, "状态不应落到 planning");
});

/* ------------------------------------------------------------------ *
 * T3：phase 只能有一个写入口
 * ------------------------------------------------------------------ */

test("T3 未经 setPhase 直接改 phase 必须被拒", async () => {
  let writer = null;
  try {
    writer = await import("../src/runtime/phase-writer.js");
  } catch {
    /* 尚未实现，下一条断言会给出清楚的失败原因 */
  }

  assert.ok(writer?.setPhase, "src/runtime/phase-writer.js 必须提供 setPhase()，作为 phase 的唯一写入口");

  const store = createMemoryStore(makeTask());
  const before = store.get();

  assert.throws(
    () => store.set({ ...before, phase: PHASES.REVIEWING, revision: before.revision + 1 }),
    (err) => err?.code === "E_PHASE_WRITE_BYPASS",
    "绕过 setPhase 直接改 phase，store 应当抛 E_PHASE_WRITE_BYPASS",
  );
});

/* ------------------------------------------------------------------ *
 * T4：双入口对同一入参必须同命运
 * ------------------------------------------------------------------ */

test("T4 HANDLERS.mentor_stage_report 与 stageReportGated 对同一入参必须同命运", () => {
  // 让 s1 处于「可上报」状态：阶段存在、依赖为空、无已有 review
  const base = makeTask({ phase: PHASES.ACTIVE });
  const a = createMemoryStore(base);
  const b = createMemoryStore(base);

  // 故意不带 evidenceRefs —— 这正是两条入口应当分歧的地方
  const params = { stageId: "s1", attempt: 1, evidence: "契约测试：故意缺 evidenceRefs" };

  const viaHandlers = HANDLERS.mentor_stage_report(a, params);
  const viaGated = stageReportGated(b, { ...params, planVersion: 1 });

  assert.equal(
    viaHandlers.ok,
    viaGated.ok,
    `双入口必须同命运，实际 HANDLERS.ok=${viaHandlers.ok}（code=${viaHandlers.code ?? "-"}）` +
      ` 而 gated.ok=${viaGated.ok}（code=${viaGated.code ?? "-"}）`,
  );
});
