import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  sanitizeLessonText,
  distillTaskLessons,
  mergeCandidateLessons,
  setLessonStatus,
  queryAcceptedLessons,
  listProjectLessons,
  loadProjectLessons,
} from "../src/runtime/lessons.js";
import { COMMAND_ACTIONS } from "../src/rpc/command.js";
import { TOOL_NAMES, apply } from "../lib/index.js";

test("V04-L1: sanitizeLessonText 脱敏凭据与路径，distillTaskLessons 从闭环缺陷/前置失败/熔断提炼候选经验", () => {
  const dirty = "调用失败：Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig 和 sk-1234567890abcdefghij 在 C:\\Users\\Alice\\secret\\app.js 且 token=supersecret123";
  const clean = sanitizeLessonText(dirty);
  assert.doesNotMatch(clean, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(clean, /sk-1234567890/);
  assert.doesNotMatch(clean, /supersecret123/);
  assert.doesNotMatch(clean, /C:\\Users\\Alice/);
  assert.match(clean, /\[REDACTED\]/);
  assert.match(clean, /<path>/);

  const task = {
    id: "task-distill-1",
    workspaceRoot: path.join(os.tmpdir(), "ws-distill"),
    objective: "重构鉴权流程",
    findings: [
      { id: "f1", stageId: "s1", status: "closed", text: "编辑前先跑 lint 避免格式冲突", resolvedByReviewId: "rev-1", responses: [{ summary: "已补充 lint 校验" }] },
      { id: "f2", stageId: "s1", status: "open", text: "未关闭问题不应提炼" },
    ],
    reviews: [
      { id: "rev-1", verdict: "pass", selfReviewed: false },
    ],
    lastPrechecks: {
      s1: {
        ok: false,
        results: [{ id: "p1", label: "npm test", ok: false, exitCode: 1 }],
      },
    },
    continuation: {
      kind: "rework-circuit-breaker",
      stageId: "s1",
      summary: "阶段 s1 连续返工 3 次触发熔断",
    },
  };

  const distilled = distillTaskLessons(task);
  assert.equal(distilled.length, 3);
  assert.ok(distilled.every((x) => x.status === "candidate"));
  assert.ok(distilled.some((x) => x.source === "review-finding"));
  assert.ok(distilled.some((x) => x.source === "precheck-failure"));
  assert.ok(distilled.some((x) => x.source === "circuit-breaker"));
});

test("V04-L2: 候选默认不自动注入；仅人工采纳后可查询；去重累加 occurrences 且并发写盘不损坏", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-lessons-"));
  const ws = path.join(dir, "project-a");
  try {
    const task1 = {
      id: "task-a1",
      workspaceRoot: ws,
      findings: [
        { id: "f1", stageId: "s1", status: "closed", text: "修改路由后必须跑协议契约测试", resolvedByReviewId: "r1" },
      ],
      reviews: [{ id: "r1", verdict: "pass", selfReviewed: false }],
    };
    const task2 = {
      id: "task-a2",
      workspaceRoot: ws,
      findings: [
        { id: "f2", stageId: "s2", status: "closed", text: "修改路由后必须跑协议契约测试", resolvedByReviewId: "r2" },
        { id: "f3", stageId: "s2", status: "closed", text: "Windows 路径比较需忽略大小写", resolvedByReviewId: "r2" },
      ],
      reviews: [{ id: "r2", verdict: "pass", selfReviewed: false }],
    };

    // 并发合并两次，验证串行队列与去重
    await Promise.all([
      mergeCandidateLessons(dir, task1),
      mergeCandidateLessons(dir, task2),
    ]);

    // 未人工采纳前，queryAcceptedLessons 必须为空！
    const beforeAccept = await queryAcceptedLessons(dir, { workspaceRoot: ws });
    assert.equal(beforeAccept.length, 0, "未采纳的候选绝不能自动注入后续任务");

    const listed = await listProjectLessons(dir, { workspaceRoot: ws });
    assert.equal(listed.candidates.length, 2);
    const repeated = listed.candidates.find((x) => x.lesson.includes("协议契约测试"));
    assert.ok(repeated);
    assert.equal(repeated.occurrences, 2, "重复出现的候选应去重并累加 occurrences");

    // 人工采纳一条，忽略另一条
    const other = listed.candidates.find((x) => x.lesson.includes("Windows"));
    const accepted = await setLessonStatus(dir, { fingerprint: repeated.fingerprint, status: "accepted", workspaceRoot: ws });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.status, "accepted");
    const dismissed = await setLessonStatus(dir, { fingerprint: other.fingerprint, status: "dismissed", workspaceRoot: ws });
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.value.status, "dismissed");

    // 跨项目拒绝修改
    const crossWs = await setLessonStatus(dir, { fingerprint: repeated.fingerprint, status: "dismissed", workspaceRoot: path.join(dir, "other-project") });
    assert.equal(crossWs.ok, false);

    // 再次合并同条经验，不能覆盖已采纳/已忽略的人工决定
    await mergeCandidateLessons(dir, task1);
    const afterReMerge = await loadProjectLessons(dir);
    assert.equal(afterReMerge.items.find((x) => x.fingerprint === repeated.fingerprint).status, "accepted");
    assert.equal(afterReMerge.items.find((x) => x.fingerprint === other.fingerprint).status, "dismissed");

    // 查询仅返回已采纳规则
    const queried = await queryAcceptedLessons(dir, { workspaceRoot: ws, query: "契约" });
    assert.equal(queried.length, 1);
    assert.equal(queried[0].fingerprint, repeated.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V04-L3: 面板 RPC 支持采纳/忽略经验，且下个任务 create 自动注入已采纳规则；TOOL_NAMES 保持 27", async () => {
  assert.equal(TOOL_NAMES.length, 27);
  assert.ok(COMMAND_ACTIONS.includes("mentor_lesson_accept"));
  assert.ok(COMMAND_ACTIONS.includes("mentor_lesson_dismiss"));

  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-rpc-lessons-"));
  const ws = path.join(dir, "ws");
  const tools = new Map();
  let stateRoute = null;
  const ctx = {
    tools: {
      register(tool) { tools.set(tool.name, tool); return () => {}; },
    },
    connection: {
      fetch: {
        register(route) {
          if (route.path === "/api/mentor/state") stateRoute = route;
          return () => {};
        },
      },
    },
  };

  let dispose;
  try {
    dispose = await apply(ctx, { stateDir: dir, requireApproval: false });
    assert.ok(stateRoute, "应注册 /api/mentor/state 路由");

    // 预先种入一条候选经验
    await mergeCandidateLessons(dir, {
      id: "task-prev",
      workspaceRoot: ws,
      findings: [
        { id: "f1", stageId: "s1", status: "closed", text: "发布前必须验证隔离状态零污染", resolvedByReviewId: "r1" },
      ],
      reviews: [{ id: "r1", verdict: "pass", selfReviewed: false }],
    });

    const mainAgent = { session: { id: "sess-l3", header: { cwd: ws } }, options: { provider: "p", model: "m" } };
    const createdRaw = await tools.get("mentor_task_create").execute({
      objective: "验证经验注入",
      workspaceRoot: ws,
      userMessageSeq: 1,
    }, { agent: mainAgent });
    const created = JSON.parse(createdRaw);
    assert.equal(created.ok, true);
    assert.equal(created.value.relatedLessons, undefined, "候选未采纳时不应注入 relatedLessons");

    // 通过面板 state 路由读取，应带 projectLessons.candidates
    const callState = async (payload) => {
      const resp = await stateRoute.fetch({
        json: async () => ({ type: "client-request", rpcId: "rpc-1", payload }),
      });
      return (await resp.json()).result;
    };

    const st1 = await callState({ taskId: created.value.taskId });
    assert.equal(st1.ok, true);
    assert.equal(st1.value.projectLessons?.candidates?.length, 1);
    const fp = st1.value.projectLessons.candidates[0].fingerprint;

    // 面板人工采纳该经验
    const accRes = await callState({
      action: "mentor_lesson_accept",
      params: { taskId: created.value.taskId, revision: st1.value.revision, fingerprint: fp },
    });
    assert.equal(accRes.ok, true);
    assert.equal(accRes.value.status, "accepted");

    // 再次读取面板状态：移入 accepted
    const st2 = await callState({ taskId: created.value.taskId });
    assert.equal(st2.value.projectLessons.candidates.length, 0);
    assert.equal(st2.value.projectLessons.accepted.length, 1);

    // 新建下一个任务：已采纳规则自动注入 relatedLessons！
    const created2Raw = await tools.get("mentor_task_create").execute({
      objective: "新任务验证已采纳经验自动注入",
      workspaceRoot: ws,
      userMessageSeq: 2,
    }, { agent: { session: { id: "sess-l3-next", header: { cwd: ws } }, options: { provider: "p", model: "m" } } });
    const created2 = JSON.parse(created2Raw);
    assert.equal(created2.ok, true);
    assert.ok(Array.isArray(created2.value.relatedLessons) && created2.value.relatedLessons.length >= 1);
    assert.equal(created2.value.relatedLessons[0].source, "accepted-lesson");
    assert.match(created2.value.relatedLessons[0].lesson, /隔离状态零污染/);
  } finally {
    if (dispose) await dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("V04-L4: Calm UI v9-pro 契约（高对比纯黑字体、10s 撤销归档、接班简报、经验沉淀、Worktree 标签）", async () => {
  const hotUi = await readFile(new URL("../lib/hot-ui.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

  assert.match(hotUi, /MARKER\s*=\s*"v9-pro"/);
  assert.match(client, /uiBuild:'20261125-v9-pro'/);
  // 保留用户偏好的纯黑高对比度浅色文字与亮色深色文字
  assert.match(client, /--mt-ink:#0F1115;--mt-ink2:#1A1D21;--mt-ink3:#2B2F36/);
  assert.match(client, /--mt-ink:#F5F6F8;--mt-ink2:#E2E5EA;--mt-ink3:#C8CDD6/);
  // 四大 v0.4 UI 能力
  assert.match(client, /data-undo-archive/);
  assert.match(client, /mentor_task_restore/);
  assert.match(client, /data-handoff-fold/);
  assert.match(client, /\/mentor takeover /);
  assert.match(client, /data-lessons-fold/);
  assert.match(client, /mentor_lesson_accept/);
  assert.match(client, /mentor_lesson_dismiss/);
  assert.match(client, /Worktree 分支/);
});

test("V04-L5: 节点返工或重启清空 workerSessionId 后，participants 仍保留 task.workers 中的 Worktree 卡片", async () => {
  const { runtimePayload } = await import("../src/runtime/activity.js");
  const { createMemoryStore } = await import("../src/tools/handlers.js");
  const store = createMemoryStore({
    id: "task-wt-ui",
    objective: "Worktree 卡片保留验证",
    phase: "active",
    revision: 4,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "sess-main",
    workspaceRoot: os.tmpdir(),
    criteria: [{ id: "c1", text: "ok" }],
    stages: [{ id: "s1", title: "阶段一", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 2, status: "rework", workerSessionId: null, reports: [] }],
    workers: [{
      key: "b1/s1/1", batchId: "b1", stageId: "s1", attempt: 1, sessionId: "mentor-worker-wt1",
      status: "failed", error: "worktree-conflict",
      worktree: { branch: "mentor-wt/b1-s1-a1", status: "conflict", detail: "补丁冲突，分支已保留" },
    }],
    reviews: [],
    reviewJobs: [],
    findings: [],
    updatedAt: Date.now(),
  });
  const snap = runtimePayload({}, store, { summaries: () => [] }, { compact: false });
  const workerCard = snap.participants.find((p) => p.role === "worker" && p.sessionId === "mentor-worker-wt1");
  assert.ok(workerCard, "重启/返工后 workers[] 中的 Worktree 卡片必须仍在 participants 中可见");
  assert.equal(workerCard.worktree?.branch, "mentor-wt/b1-s1-a1");
  assert.equal(workerCard.worktree?.status, "conflict");
});
