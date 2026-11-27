import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { evaluatePlanRigor, escalateRigorOnReport, RIGOR_TIERS } from "../src/runtime/rigor.js";
import { normalizeModelRoute, resolveAgentOptions } from "../src/runtime/model-routing.js";
import {
  mergeCandidateLessons,
  setLessonStatus,
  queryAcceptedLessons,
  loadProjectLessons,
  recordLessonFeedback,
  globMatchesPath,
} from "../src/runtime/lessons.js";
import { createSessionStores } from "../src/runtime/session-stores.js";
import { createMemoryStore } from "../src/tools/handlers.js";
import { COMMAND_ACTIONS } from "../src/rpc/command.js";
import { runtimeReviewPrompt, TOOL_NAMES } from "../lib/index.js";

test("V05-R1: 自适应严格度宿主硬控「只升不降」（express 不得碰敏感路径/多阶段/未声明改动）", () => {
  // 1. 单阶段低风险小修（用户显式开启 express）→ 允许 express 跳过计划审查
  const expressOk = evaluatePlanRigor({
    requested: "express",
    userExplicit: true,
    stages: [{ id: "s1", writePaths: ["src/ui/label.js"], criterionIds: ["c1"] }],
    criteria: [{ id: "c1", text: "更新按钮文案" }],
    objective: "把按钮文案从保存改成确定",
  });
  assert.equal(expressOk.tier, RIGOR_TIERS.EXPRESS);
  assert.equal(expressOk.skipPlanReview, true);

  // 2. 请求 express 但涉及敏感路径（auth / test / package.json）→ 强制升档 strict，绝不跳计划审查
  const authEscalated = evaluatePlanRigor({
    requested: "express",
    stages: [{ id: "s1", writePaths: ["src/auth/jwt.js"], criterionIds: ["c1"] }],
    criteria: [{ id: "c1", text: "调整 token 校验" }],
    objective: "修复登录鉴权",
  });
  assert.equal(authEscalated.tier, RIGOR_TIERS.STRICT);
  assert.equal(authEscalated.skipPlanReview, false);

  // 3. 多阶段不允许 express → 升档 standard
  const multiEscalated = evaluatePlanRigor({
    requested: "express",
    stages: [
      { id: "s1", writePaths: ["a.js"], criterionIds: ["c1"] },
      { id: "s2", writePaths: ["b.js"], criterionIds: ["c2"] },
    ],
    criteria: [{ id: "c1", text: "a" }, { id: "c2", text: "b" }],
  });
  assert.equal(multiEscalated.tier, RIGOR_TIERS.STANDARD);
  assert.equal(multiEscalated.skipPlanReview, false);

  // 4. 上报期只升不降：大改动 / 未声明文件 / 防作弊警告 / attempt >= 2 自动升档
  const repUp = escalateRigorOnReport({
    current: expressOk,
    diffAudit: { totalChangedFiles: 5, totalDiffLines: 220, changedFiles: [], undeclaredFiles: ["extra.js"], outsideWritePaths: [] },
    attempt: 2,
  });
  assert.equal(repUp.tier, RIGOR_TIERS.STRICT);
  assert.equal(repUp.upgraded, true);
  assert.equal(repUp.skipPlanReview, false);
});

test("V05-M1: 模型路由支持 byRigor / escalateOnAttempt，且绝不对非推理端点盲注 reasoningEffort", () => {
  const nonReasonerMain = { options: { provider: "deepseek", model: "deepseek-chat" } };
  const resolvedNoEffort = resolveAgentOptions(nonReasonerMain, null, { kind: "stage", attempt: 3, rigor: "strict" });
  assert.equal(resolvedNoEffort.provider, "deepseek");
  assert.equal(resolvedNoEffort.model, "deepseek-chat");
  assert.equal("reasoningEffort" in resolvedNoEffort, false, "主会话未启用 reasoningEffort 时绝不盲注");

  const reasonerMain = { options: { provider: "openai", model: "gpt-5", reasoningEffort: "medium" } };
  const bumped = resolveAgentOptions(reasonerMain, null, { kind: "stage", attempt: 2, rigor: "standard" });
  assert.equal(bumped.reasoningEffort, "high", "主会话本身支持 reasoningEffort 时返工自动升档");

  const route = normalizeModelRoute({
    model: "deepseek-chat",
    byRigor: { strict: { provider: "openai", model: "gpt-5", reasoningEffort: "high" } },
    escalateOnAttempt: { minAttempt: 2, model: "deepseek-reasoner", reasoningEffort: "high" },
  });
  const strictOpt = resolveAgentOptions(nonReasonerMain, route, { kind: "stage", attempt: 1, rigor: "strict" });
  assert.equal(strictOpt.provider, "openai");
  assert.equal(strictOpt.model, "gpt-5");
  const retryOpt = resolveAgentOptions(nonReasonerMain, route, { kind: "stage", attempt: 2, rigor: "standard" });
  assert.equal(retryOpt.model, "deepseek-reasoner");
  assert.equal(retryOpt.reasoningEffort, "high");
});

test("V05-K1: runtimeReviewPrompt 静态前缀置顶保 DeepSeek KV Cache，且宿主 Diff 先于 reportIndex 与 objective", () => {
  const taskA = {
    id: "task-alpha-111",
    objective: "修复模块 A 的边界检查",
    planVersion: 1,
    rigor: { tier: "strict", reasons: ["涉及测试路径"] },
    stages: [{ id: "s1", criterionIds: ["c1"] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, reports: [{ id: "rep-a", attempt: 1, planVersion: 1, bindings: [], evidenceFiles: [{ file: "a.js" }] }] }],
    lastDiffAudits: {
      s1: {
        mode: "git",
        totalChangedFiles: 2,
        totalAddedLines: 10,
        totalRemovedLines: 2,
        changedFiles: [{ path: "a.js", status: "modified", addedLines: 8, removedLines: 2 }, { path: "hidden.js", status: "added", addedLines: 2, removedLines: 0 }],
        undeclaredFiles: ["hidden.js"],
      },
    },
  };
  const taskB = {
    id: "task-beta-999",
    objective: "重构模块 B 的序列化逻辑",
    planVersion: 3,
    stages: [{ id: "s2", criterionIds: ["c2"] }],
    nodeRuns: [{ stageId: "s2", attempt: 2, reports: [{ id: "rep-b", attempt: 2, planVersion: 3, bindings: [], evidenceFiles: [{ file: "b.js" }] }] }],
  };

  const pA = runtimeReviewPrompt(taskA, { id: "job-1", kind: "stage", stageId: "s1", attempt: 1, planVersion: 1 });
  const pB = runtimeReviewPrompt(taskB, { id: "job-2", kind: "stage", stageId: "s2", attempt: 2, planVersion: 3 });

  // 计算从 Token 0 开始的严格逐字符公共前缀长度
  let commonLen = 0;
  while (commonLen < pA.length && commonLen < pB.length && pA[commonLen] === pB[commonLen]) {
    commonLen += 1;
  }
  assert.ok(commonLen >= 800, `静态前缀过短（仅 ${commonLen} 字符），可能击穿 DeepSeek Token-0 KV 缓存`);

  // 去锚定顺序：宿主真实 Diff 必须出现在 reportIndex 与任务目标之前
  const idxHostDiff = pA.indexOf("宿主真实工作区改动审计");
  const idxReportIndex = pA.indexOf("本轮可读的最新报告与文件");
  const idxObjective = pA.indexOf("任务目标：");
  assert.ok(idxHostDiff > 0 && idxHostDiff < idxReportIndex, "宿主真实 Diff 必须排在被审方 reportIndex 之前");
  assert.ok(idxReportIndex < idxObjective);
});

test("V05-L1: 修复 lessons 2 个 v0.4 隐藏 Bug（分区限容不挤掉已采纳规则 + 持久化模式不泄漏未确认历史）并验证 ACE 效用与 glob 作用域", async () => {
  assert.equal(globMatchesPath("src/auth/**", "src/auth/token.js"), true);
  assert.equal(globMatchesPath("src/auth/**", "docs/readme.md"), false);
  assert.equal(globMatchesPath("src/runtime", "src/runtime/rigor.js"), true);

  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-ace-"));
  const ws = path.join(dir, "proj");
  try {
    // 1. 创建并采纳一条老的 auth 作用域经验
    const distilled = await mergeCandidateLessons(dir, {
      id: "task-old-acc",
      workspaceRoot: ws,
      stages: [{ id: "s1", writePaths: ["src/auth/**"] }],
      findings: [{ id: "f1", stageId: "s1", status: "closed", text: "鉴权模块必须校验 token 过期时间", resolvedByReviewId: "r1" }],
      reviews: [{ id: "r1", verdict: "pass", selfReviewed: false }],
    });
    const accFp = distilled[0].fingerprint;
    await setLessonStatus(dir, { fingerprint: accFp, status: "accepted", workspaceRoot: ws });

    // 2. 写入 205 条更新的 candidate 噪声，验证老的 accepted 规则绝不被挤掉！
    const loaded = await loadProjectLessons(dir);
    const noise = Array.from({ length: 205 }, (_, i) => ({
      fingerprint: `noise-${String(i).padStart(3, "0")}`,
      schemaVersion: 2,
      projectKey: loaded.items[0].projectKey,
      source: "review-finding",
      rule: `候选噪声规则 ${i}`,
      lesson: `候选噪声规则 ${i}`,
      status: "candidate",
      occurrences: 1,
      firstSeenAt: Date.now() + i,
      lastSeenAt: Date.now() + i,
    }));
    await writeFile(path.join(dir, "lessons.json"), JSON.stringify({ schemaVersion: 2, items: [loaded.items[0], ...noise] }), "utf8");
    await mergeCandidateLessons(dir, {
      id: "task-trigger-save",
      workspaceRoot: ws,
      findings: [{ id: "f2", stageId: "s1", status: "closed", text: "新候选触发限容写盘规则", resolvedByReviewId: "r2" }],
      reviews: [{ id: "r2", verdict: "pass", selfReviewed: false }],
    });
    const afterCap = await loadProjectLessons(dir);
    assert.equal(afterCap.items.length, 200);
    assert.ok(afterCap.items.some((x) => x.fingerprint === accFp && x.status === "accepted"), "海量候选绝不得挤掉人工采纳的规则");

    // 3. glob 作用域过滤：命中 src/auth/jwt.js，不命中 docs/intro.md
    const hitAuth = await queryAcceptedLessons(dir, { workspaceRoot: ws, touchedPaths: ["src/auth/jwt.js"] });
    assert.equal(hitAuth.length, 1);
    assert.equal(hitAuth[0].kind, "review-finding");
    assert.equal(hitAuth[0].stageId, "s1");
    assert.equal(hitAuth[0].rule, "鉴权模块必须校验 token 过期时间");
    const missDocs = await queryAcceptedLessons(dir, { workspaceRoot: ws, touchedPaths: ["docs/intro.md"] });
    assert.equal(missDocs.length, 0, "不匹配 fileMatch 的路径不应注入无关规则");

    // 4. ACE 负反馈自动降权（harmful >= 2 且 harmful > helpful → 自动静默）
    await recordLessonFeedback(dir, { fingerprints: [accFp], outcome: "harmful", workspaceRoot: ws });
    await recordLessonFeedback(dir, { fingerprints: [accFp], outcome: "harmful", workspaceRoot: ws });
    const afterHarmful = await queryAcceptedLessons(dir, { workspaceRoot: ws, touchedPaths: ["src/auth/jwt.js"] });
    assert.equal(afterHarmful.length, 0, "连续有害的规则应被 ACE 自动静默降权");

    // 5. 持久化模式下 session-stores.lessons() 绝不泄漏未确认的 history 任务 finding
    const reg = await createSessionStores(async () => createMemoryStore(), { stateDir: dir });
    const sPrev = await reg.forSession("old-sess");
    sPrev.set({
      id: "task-unaccepted-leak",
      workspaceRoot: ws,
      updatedAt: Date.now(),
      findings: [{ id: "fl", status: "closed", resolvedByReviewId: "rl", text: "未经确认不应泄漏的历史发现" }],
      reviews: [{ id: "rl", verdict: "pass", selfReviewed: false }],
    });
    const leaked = await reg.lessons({ id: "task-cur", workspaceRoot: ws }, "");
    assert.equal(leaked.length, 0, "持久化模式下绝不得绕过 candidate-first 泄漏未确认历史 finding");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V05-C1: 死守 27 工具契约与 Calm UI v0.5 锚点（严格度标签 / 变更收据 / 回滚预览 / ACE 计数）", async () => {
  assert.equal(TOOL_NAMES.length, 27, "必须死守 27 个全局 MCP 工具契约");
  assert.equal(TOOL_NAMES.includes("mentor_stage_rollback"), false);
  assert.equal(TOOL_NAMES.includes("mentor_rigor_set"), false);
  assert.equal(COMMAND_ACTIONS.includes("mentor_stage_rollback"), true);
  assert.equal(COMMAND_ACTIONS.includes("mentor_rigor_set"), true);

  const clientSrc = await readFile(path.resolve("lib/client.js"), "utf8");
  assert.match(clientSrc, /data-rigor/);
  assert.match(clientSrc, /data-diff-receipt/);
  assert.match(clientSrc, /data-rollback-preview/);
  assert.match(clientSrc, /已帮省 /);
});
