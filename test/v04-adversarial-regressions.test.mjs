import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { apply, createPersistentStore, createStore } from "../lib/index.js";
import { createMemoryStore, HANDLERS, taskRestore } from "../src/tools/handlers.js";
import { runtimePayload } from "../src/runtime/activity.js";
import { createSessionStores } from "../src/runtime/session-stores.js";
import { sanitizeLessonText, mergeCandidateLessons, setLessonStatus, loadProjectLessons } from "../src/runtime/lessons.js";
import { probeGitWorktree, createWorkerWorktree, captureWorktreeDiff, mergeWorktreeSequential, cleanupWorktree, runGit } from "../src/runtime/worktree.js";
import { writeState } from "../src/persist/store.js";

test("V04-R1 (P0): 24KB 快照裁剪绝不原地篡改 store.get() 真实任务对象", () => {
  const longDesc = "很长的阶段描述".repeat(1500);
  const longObj = "超级长的任务目标".repeat(1200);
  const task = {
    id: "task-immut-1",
    objective: longObj,
    phase: "active",
    revision: 3,
    planVersion: 1,
    approvedPlanVersion: 1,
    mainSessionId: "sess-immut",
    workspaceRoot: os.tmpdir(),
    criteria: [{ id: "c1", text: "验收项".repeat(600) }],
    stages: [{ id: "s1", title: "阶段一", description: longDesc, criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{ stageId: "s1", attempt: 1, status: "running", reports: [] }],
    findings: [],
    reviews: [],
    reviewJobs: [],
    updatedAt: Date.now(),
  };
  const before = structuredClone(task);
  const store = createMemoryStore(task);
  const snap = runtimePayload({}, store, { summaries: () => [] }, { compact: true });
  assert.equal(snap.snapshotTruncated, true);
  assert.ok(snap.snapshotBytes <= 24576);
  assert.deepEqual(store.get(), before, "fitSnapshot / shrinkLongestString 绝不能修改 store 里的原始对象");
});

test("V04-R2 (P0): 跨会话接班删除源端磁盘状态文件，重启重载后严格单主且按 generation 去重", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-r2-"));
  const ws = path.join(dir, "ws");
  const commands = new Map();
  const ctx = {
    tools: { register() { return () => {}; } },
    commands: { register(spec) { commands.set(spec.name, spec); return () => {}; } },
  };
  let dispose;
  try {
    dispose = await apply(ctx, { stateDir: dir, requireApproval: false });
    const mentorCmd = commands.get("mentor");
    const agentA = { session: { id: "sess-A-r2", header: { cwd: ws } }, options: { provider: "p", model: "m" } };
    const agentB = { session: { id: "sess-B-r2", header: { cwd: ws } }, options: { provider: "p", model: "m" } };

    const created = await mentorCmd.handler({ agent: agentA, rawInput: "new 验证接班零脑裂" });
    assert.equal(created.kind, "success");
    const taskId = dispose.store.findSession("sess-A-r2").get().id;

    const taken = await mentorCmd.handler({ agent: agentB, rawInput: `takeover ${taskId}` });
    assert.equal(taken.kind, "success");
    await dispose();
    dispose = null;

    // 重启重新加载所有 session 目录：A 不应存在，B 唯一拥有 taskId
    const reloaded = await createSessionStores(createStore, { stateDir: dir });
    assert.equal(reloaded.findSession("sess-A-r2"), undefined, "重启后旧会话 A 不应再拥有该任务");
    const bStore = reloaded.findSession("sess-B-r2");
    assert.ok(bStore, "重启后新会话 B 应唯一拥有该任务");
    assert.equal(bStore.get().id, taskId);
    assert.equal(bStore.get().ownershipGeneration, 1);

    // 额外测试：即使人工造出崩溃残留双文件，启动期也按 ownershipGeneration 自动保留最新一份
    const fakeStaleDir = path.join(dir, "sessions", "00000000000000000000000000000001");
    await mkdir(fakeStaleDir, { recursive: true });
    await writeState(path.join(fakeStaleDir, "mentor-task.json"), {
      ...bStore.get(),
      mainSessionId: "sess-stale-ghost",
      ownershipGeneration: 0,
      revision: 1,
    });
    const deduped = await createSessionStores(createStore, { stateDir: dir });
    assert.equal(deduped.findSession("sess-stale-ghost"), undefined, "低 generation 残留副本应在启动期被去重清除");
    assert.equal(deduped.findSession("sess-B-r2")?.get()?.ownershipGeneration, 1);
  } finally {
    if (dispose) await dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("V04-R3 (P0/P1): 运行中暂停任务归档后返回精确最终 revision、撤销完整还原暂停前 phase，且 state 返回 recentUndoArchive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-r3-"));
  const ws = path.join(dir, "ws");
  const tools = new Map();
  let stateRoute = null;
  const ctx = {
    tools: { register(t) { tools.set(t.name, t); return () => {}; } },
    connection: { fetch: { register(r) { if (r.path === "/api/mentor/state") stateRoute = r; return () => {}; } } },
  };
  const callState = async (payload) => {
    const resp = await stateRoute.fetch({ json: async () => ({ type: "client-request", rpcId: "r3", payload }) });
    return (await resp.json()).result;
  };
  let dispose;
  try {
    dispose = await apply(ctx, { stateDir: dir, requireApproval: false });
    const agent = { session: { id: "sess-r3", header: { cwd: ws } }, options: { provider: "p", model: "m" } };
    const created = JSON.parse(await tools.get("mentor_task_create").execute({
      objective: "验证暂停归档撤销链路", workspaceRoot: ws, userMessageSeq: 1,
    }, { agent }));
    const taskId = created.value.taskId;
    const scoped = dispose.store.findSession("sess-r3");
    assert.equal(scoped.get().phase, "planning");

    // 注入一条在途 reviewJob + 暂停（planning -> paused）
    scoped.set({ ...scoped.get(), reviewJobs: [{ id: "rj-1", status: "running", kind: "plan", stageId: "__plan__", attempt: 1, planVersion: 0 }] });
    const paused = HANDLERS.mentor_task_pause(scoped, { taskId, reason: "user" });
    assert.equal(paused.ok, true);
    assert.equal(scoped.get().prePausePhase, "planning");

    // 面板发 Clear：会触发 setPhase(archived) + recoverInterrupted(revision 再 +1)
    const revBeforeClear = scoped.get().revision;
    const cleared = await callState({ action: "mentor_task_clear", params: { taskId, revision: revBeforeClear, reason: "user-clear" } });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.revision, scoped.get().revision, "clear 返回值必须包含 recoverInterrupted 后的最终 revision");
    assert.ok(cleared.value.archivedUndoUntil > Date.now());

    // 无显式 taskId 拉取面板 state：隐藏归档任务本身，但携带 recentUndoArchive（刷新页面/命令归档也不丢 10s 撤销）
    const emptyView = await callState({});
    assert.equal(emptyView.ok, true);
    assert.equal(emptyView.value.task, null);
    assert.equal(emptyView.value.recentUndoArchive?.taskId, taskId);
    assert.equal(emptyView.value.recentUndoArchive?.revision, cleared.value.revision);

    // 用 clear 返回的精确 revision 点击撤销归档
    const restored = await callState({
      action: "mentor_task_restore",
      params: { taskId, revision: cleared.value.revision, enforceUndoWindow: true },
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.value.phase, "paused");
    assert.equal(scoped.get().prePausePhase, "planning", "归档撤销必须还原暂停前的 planning 阶段");

    // 继续恢复：应回到 planning（而非退化成 awaiting-approval）
    const resumed = HANDLERS.mentor_task_resume(scoped, { taskId });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.phase, "planning");
  } finally {
    if (dispose) await dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("V04-R4 (P0/P1): Worktree canMerge 中止零污染主目录，且拒绝脏工作区派工", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-r4-"));
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "core.autocrlf", "false"]);
    await runGit(repo, ["config", "user.name", "tester"]);
    await runGit(repo, ["config", "user.email", "tester@local"]);
    await writeFile(path.join(repo, "a.txt"), "base\n", "utf8");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "init"]);

    const probe = await probeGitWorktree(repo);
    assert.equal(probe.available, true);
    assert.equal(probe.dirtyFiles.length, 0);

    const wt = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "b1", stageId: "s1", attempt: 1, baseHead: probe.baseHead });
    assert.equal(wt.ok, true);
    await writeFile(path.join(wt.worktreePath, "a.txt"), "changed-in-wt\n", "utf8");
    const cap = await captureWorktreeDiff({ worktreePath: wt.worktreePath, stageId: "s1", attempt: 1 });
    assert.equal(cap.ok, true);
    assert.ok(cap.commitSha);

    // 模拟任务已暂停：canMerge 返回 false -> 停止合入、主目录零改动、保留分支
    const merged = await mergeWorktreeSequential({
      repoRoot: probe.repoRoot,
      baseHead: probe.baseHead,
      items: [{ ...wt, stageId: "s1", ...cap }],
      canMerge: () => false,
    });
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, "task-inactive");
    assert.equal(merged.results[0].status, "aborted-task-inactive");
    assert.equal(merged.results[0].keepBranch, true);
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "base\n", "任务暂停后绝不能改写主工作区");

    await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt.worktreePath, branch: wt.branch, keepBranch: false });

    // 脏工作区探测
    await writeFile(path.join(repo, "uncommitted.txt"), "dirty\n", "utf8");
    const dirtyProbe = await probeGitWorktree(repo);
    assert.ok(dirtyProbe.dirtyFiles.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V04-R5 (P1): PKCS#8 私钥脱敏、满额保留最新 200 条、损坏文件进 quarantine、忽略经验不被历史回退复活", async () => {
  const pkcs8 = "错误输出：-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw";
  const redacted = sanitizeLessonText(pkcs8);
  assert.doesNotMatch(redacted, /MIIEvQIBADAN/);
  assert.match(redacted, /\[REDACTED_KEY\]/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v04-r5-"));
  const ws = path.join(dir, "ws");
  try {
    // 1. 损坏 lessons.json 进 quarantine/
    await writeFile(path.join(dir, "lessons.json"), "{broken json!!!", "utf8");
    const loaded = await loadProjectLessons(dir);
    assert.deepEqual(loaded.items, []);
    assert.ok(loaded.quarantined, "损坏 lessons.json 应被隔离至 quarantine/");
    const qFiles = await readdir(path.join(dir, "quarantine"));
    assert.ok(qFiles.some((f) => f.startsWith("lessons.") && f.endsWith(".corrupt.json")));

    // 2. 满额 205 条时保留最新 200 条而非删掉最新
    const seedItems = Array.from({ length: 204 }, (_, i) => ({
      fingerprint: `fp-old-${String(i).padStart(3, "0")}`,
      schemaVersion: 1,
      projectKey: ws.toLowerCase(),
      source: "review-finding",
      rule: `旧经验第 ${i} 条规则`,
      lesson: `旧经验第 ${i} 条规则`,
      status: "candidate",
      occurrences: 1,
      firstSeenAt: 1000 + i,
      lastSeenAt: 1000 + i,
    }));
    await writeFile(path.join(dir, "lessons.json"), JSON.stringify({ schemaVersion: 1, items: seedItems }), "utf8");
    await mergeCandidateLessons(dir, {
      id: "task-newest",
      workspaceRoot: ws,
      findings: [{ id: "fn", stageId: "s1", status: "closed", text: "最新的一条高价值经验规则", resolvedByReviewId: "rn" }],
      reviews: [{ id: "rn", verdict: "pass", selfReviewed: false }],
    });
    const afterCap = await loadProjectLessons(dir);
    assert.equal(afterCap.items.length, 200);
    assert.ok(afterCap.items.some((x) => x.rule.includes("最新的一条高价值经验规则")), "满额截断必须保留最新经验");

    // 3. 历史回退不得复活已忽略或未采纳候选经验
    const prevTask = {
      id: "task-history-bypass",
      workspaceRoot: ws,
      objective: "旧任务",
      phase: "completed",
      revision: 5,
      planVersion: 1,
      updatedAt: Date.now() - 1000,
      findings: [{ id: "fh1", stageId: "s1", status: "closed", text: "已被用户忽略的历史缺陷规则", resolvedByReviewId: "rh1" }],
      reviews: [{ id: "rh1", verdict: "pass", selfReviewed: false, scope: { planVersion: 1 } }],
    };
    await mkdir(path.join(dir, "history"), { recursive: true });
    await writeState(path.join(dir, "history", "a".repeat(64) + ".json"), prevTask);
    const distilled = await mergeCandidateLessons(dir, prevTask);
    const fp = distilled[0].fingerprint;
    await setLessonStatus(dir, { fingerprint: fp, status: "dismissed", workspaceRoot: ws });

    const registry = await createSessionStores(createStore, { stateDir: dir });
    const queried = await registry.lessons({ id: "task-new", workspaceRoot: ws }, "");
    assert.ok(!queried.some((x) => String(x.lesson).includes("已被用户忽略的历史缺陷规则")), "被忽略的经验绝不能经历史回退复活");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
