/**
 * reviewer 工具策略的回归测试（19 条：6 放行 / 8 拦截 / 1 名单一致性 / 4 预算与接线）。
 *
 * 锁的是上一轮「审查永远超时」的根因：reviewer 必须留有读工具、
 * 且不得起子代理/写文件/碰其他任务工具。判定逻辑见 src/review/reviewer-policy.js。
 *
 * 2026-11-09 追加后半段：约束文案原先写在**从未被调用**的 `reviewPrompt` 里，
 * 真正发出去的 `runtimeReviewPrompt` 没有它。Q2–Q4 三条把「文案存在」「真的注入」
 * 「死函数不再回来」分别锁一遍，单测直接对生产函数的返回值断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REVIEWER_ALLOWED_TOOLS,
  REVIEWER_PROMPT_TOOL_BUDGET,
  REVIEWER_TOOL_BUDGET,
  isForbiddenReviewerTool,
  reviewerBudgetExceeded,
  reviewerConstraintLines,
} from "../src/review/reviewer-policy.js";
import { runtimeReviewPrompt } from "../lib/index.js";

/* ---------------------------- 放行（5 条） ---------------------------- */

test("P1 mentor_task_status 放行（审查要先读任务快照）", () => {
  assert.equal(isForbiddenReviewerTool("mentor_task_status"), false);
});

test("P2 mentor_review_apply 放行（裁决唯一出口）", () => {
  assert.equal(isForbiddenReviewerTool("mentor_review_apply"), false);
});

test("P3 read 放行（上一轮就是丢了它才去 spawn 子代理）", () => {
  assert.equal(isForbiddenReviewerTool("read"), false);
});

test("P4 glob 放行", () => {
  assert.equal(isForbiddenReviewerTool("glob"), false);
});

test("P5 grep 放行", () => {
  assert.equal(isForbiddenReviewerTool("grep"), false);
});

test("P6 working_directory 放行（只读导航；真机第一版误拦导致 5 秒 abort）", () => {
  assert.equal(isForbiddenReviewerTool("working_directory"), false);
});

/* ---------------------------- 拦截（8 条） ---------------------------- */

test("B1 spawn_teammate 拦截（起子代理是超时根因）", () => {
  assert.equal(isForbiddenReviewerTool("spawn_teammate"), true);
});

test("B2 wait_agent 拦截（上一轮 8 分钟卡在这里）", () => {
  assert.equal(isForbiddenReviewerTool("wait_agent"), true);
});

test("B3 send_message 拦截（审查不该给别的会话发消息）", () => {
  assert.equal(isForbiddenReviewerTool("send_message"), true);
});

test("B4 task_status 拦截（宿主的 task_* 督导工具不属于审查职权）", () => {
  assert.equal(isForbiddenReviewerTool("task_status"), true);
});

test("B5 team_task_create 拦截（团队看板写入）", () => {
  assert.equal(isForbiddenReviewerTool("team_task_create"), true);
});

test("B6 edit 拦截（审查只读，不改仓库）", () => {
  assert.equal(isForbiddenReviewerTool("edit"), true);
});

test("B7 bash 拦截（审查不该执行 shell）", () => {
  assert.equal(isForbiddenReviewerTool("bash"), true);
});

test("B8 mcp__* 拦截（MCP 工具不在审查职责内）", () => {
  assert.equal(isForbiddenReviewerTool("mcp__graphflow__graphflow_context"), true);
});

/* ------------------------- 名单与边界的一致性 ------------------------- */

test("L1 放行名单与函数判定一致，且 mentor_* 越权工具默认拦截", () => {
  assert.deepEqual([...REVIEWER_ALLOWED_TOOLS].sort(), [
    "glob",
    "grep",
    "mentor_evidence_read",
    "mentor_review_apply",
    "mentor_task_status",
    "read",
    "working_directory",
  ]);
  for (const name of REVIEWER_ALLOWED_TOOLS) {
    assert.equal(isForbiddenReviewerTool(name), false, `${name} 必须在放行名单里`);
  }
  // mentor_* 里不在放行名单的写操作一律拦
  for (const name of ["mentor_task_create", "mentor_stage_report", "mentor_task_clear"]) {
    assert.equal(isForbiddenReviewerTool(name), true, `${name} 应当被拦`);
  }
  // 非字符串/空串不误判
  assert.equal(isForbiddenReviewerTool(undefined), false);
  assert.equal(isForbiddenReviewerTool(""), false);
});

/* --------------------- 预算与 prompt 接线（4 条） --------------------- */

test("Q1 硬预算边界：12 次内放行，第 13 次触发（prompt 建议值是 8）", () => {
  assert.equal(REVIEWER_TOOL_BUDGET, 12);
  assert.equal(REVIEWER_PROMPT_TOOL_BUDGET, 8);
  assert.equal(reviewerBudgetExceeded(0), false);
  assert.equal(reviewerBudgetExceeded(REVIEWER_TOOL_BUDGET), false, "第 12 次仍在预算内");
  assert.equal(reviewerBudgetExceeded(REVIEWER_TOOL_BUDGET + 1), true, "第 13 次必须触发");
  assert.equal(reviewerBudgetExceeded(undefined), false);
  assert.equal(reviewerBudgetExceeded("13"), false);
});

test("Q2 约束文案同时含禁委派与预算数字", () => {
  const text = reviewerConstraintLines().join("\n");
  assert.match(text, /spawn_teammate/);
  assert.match(text, /wait_agent/);
  assert.match(text, new RegExp(`${REVIEWER_PROMPT_TOOL_BUDGET} 次`));
  assert.match(text, /5 分钟/);
  // 2026-11-09 真机：stage 审查时 reviewer 拿 ego_cli 去读文件，被看门狗 abort 成
  // reviewer-forbidden-tool:ego_cli。约束文案必须同时给出「用什么读」和「别用什么读」。
  assert.match(text, /ego_/);
  assert.match(text, /mcp__/);
  assert.match(text, /read \/ glob \/ grep/);
});

test("Q3 真正发出的 reviewer prompt 已注入约束（plan 另含并行度）", () => {
  const task = {
    id: "task_prompt_probe",
    objective: "验证 prompt 接线",
    criteria: [{ id: "c1", text: "c1" }],
    stages: [
      { id: "s1", dependsOn: [], writePaths: ["a.md"] },
      { id: "s2", dependsOn: ["s1"], writePaths: ["b.md"] },
      { id: "s3", dependsOn: ["s1"], writePaths: ["c.md"] },
    ],
  };
  const planJob = { id: "job_plan", kind: "plan", stageId: null, attempt: null, planVersion: 1 };
  const planText = runtimeReviewPrompt(task, planJob);
  assert.match(planText, /spawn_teammate/, "plan 审查必须禁委派");
  assert.match(planText, new RegExp(`${REVIEWER_PROMPT_TOOL_BUDGET} 次`), "plan 审查必须带预算");
  assert.match(planText, /计划并行度：/, "plan 审查必须看到并行度");

  const stageJob = { id: "job_stage", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1 };
  const stageText = runtimeReviewPrompt(task, stageJob);
  assert.match(stageText, /spawn_teammate/, "stage 审查同样禁委派");
  assert.match(stageText, /阶段 s1/, "stage 审查要指明被审阶段");
  assert.equal(/计划并行度：/.test(stageText), false, "并行度只对计划审查有意义");

  const completionJob = { id: "job_done", kind: "completion", stageId: "completion", attempt: null, planVersion: 1 };
  assert.match(runtimeReviewPrompt(task, completionJob), /spawn_teammate/, "整体验收同样禁委派");
});

test("Q4 死函数 reviewPrompt 不再回来，且 runtimeReviewPrompt 真的引用约束", () => {
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.equal(/function reviewPrompt\s*\(/.test(source), false, "死函数已删除（它的文案曾因未接线而从未生效）");
  const body = source.slice(source.indexOf("export function runtimeReviewPrompt"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /reviewerConstraintLines\(\)/,
    "runtimeReviewPrompt 必须直接展开约束行");
});
