/**
 * v0.4 · Round 4 并行 Git Worktree 物理隔离与顺序合并闸门（真实 Git 实操测试）
 *
 * 在临时真实 Git 仓库中验证：
 *   1. 非 Git 目录优雅降级 probeGitWorktree → available=false
 *   2. 并行创建 2 个隔离 worktree，各自写入不同文件，互不干扰，顺序合并闸门 cleanly 应用到主工作区
 *   3. 合并冲突安全中止并保留隔离分支，绝不损坏主工作区
 *   4. 主仓库 HEAD 漂移检测：停止自动合入并保留隔离分支
 *   5. Windows 安全清理：全部清理后 `git worktree list` 只剩主工作区，`.git/info/exclude` 防脏工作树
 *   6. 端到端通过 apply({ workerIsolation: "worktree" }) 真实派工两个并行阶段并在隔离目录各自写文件后合并
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply } from "../lib/index.js";
import {
  runGit,
  probeGitWorktree,
  createWorkerWorktree,
  captureWorktreeDiff,
  mergeWorktreeSequential,
  cleanupWorktree,
} from "../src/runtime/worktree.js";

async function createTempGitRepo(t, files = { "README.md": "base\n", "shared.txt": "line1\nline2\n" }) {
  const dir = await mkdtemp(path.join(tmpdir(), "mentor-v04-wt-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  assert.equal((await runGit(dir, ["init"])).ok, true);
  await runGit(dir, ["config", "user.name", "tester"]);
  await runGit(dir, ["config", "user.email", "tester@local"]);
  await runGit(dir, ["config", "core.autocrlf", "false"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  assert.equal((await runGit(dir, ["add", "-A"])).ok, true);
  assert.equal((await runGit(dir, ["commit", "--no-gpg-sign", "-m", "initial"])).ok, true);
  return dir;
}

test("V04-W1 非 Git 目录优雅返回 available=false；有效 Git 仓库返回 baseHead", async (t) => {
  const nonGit = await mkdtemp(path.join(tmpdir(), "mentor-v04-nongit-"));
  t.after(async () => { await rm(nonGit, { recursive: true, force: true }); });
  const p0 = await probeGitWorktree(nonGit);
  assert.equal(p0.available, false);

  const repo = await createTempGitRepo(t);
  const p1 = await probeGitWorktree(repo);
  assert.equal(p1.available, true);
  assert.match(p1.baseHead, /^[a-f0-9]{40}$/);
});

test("V04-W2 双 worktree 并行物理隔离写入 + 顺序合并闸门 + 无残留清理", async (t) => {
  const repo = await createTempGitRepo(t);
  const probe = await probeGitWorktree(repo);

  const wt1 = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "b1", stageId: "s1", attempt: 1, baseHead: probe.baseHead });
  const wt2 = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "b1", stageId: "s2", attempt: 1, baseHead: probe.baseHead });
  assert.equal(wt1.ok, true, JSON.stringify(wt1));
  assert.equal(wt2.ok, true, JSON.stringify(wt2));

  // 两个 worker 在物理隔离目录里各自写文件，主工作区此时丝毫不受影响
  await writeFile(path.join(wt1.worktreePath, "alpha.txt"), "from s1\n", "utf8");
  await writeFile(path.join(wt2.worktreePath, "beta.txt"), "from s2\n", "utf8");

  const d1 = await captureWorktreeDiff({ worktreePath: wt1.worktreePath, stageId: "s1", attempt: 1 });
  const d2 = await captureWorktreeDiff({ worktreePath: wt2.worktreePath, stageId: "s2", attempt: 1 });
  assert.equal(d1.ok, true);
  assert.deepEqual(d1.changedFiles, ["alpha.txt"]);
  assert.equal(d2.ok, true);
  assert.deepEqual(d2.changedFiles, ["beta.txt"]);

  const merged = await mergeWorktreeSequential({
    repoRoot: probe.repoRoot,
    baseHead: probe.baseHead,
    items: [
      { stageId: "s1", branch: wt1.branch, ...d1 },
      { stageId: "s2", branch: wt2.branch, ...d2 },
    ],
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(await readFile(path.join(repo, "alpha.txt"), "utf8"), "from s1\n");
  assert.equal(await readFile(path.join(repo, "beta.txt"), "utf8"), "from s2\n");

  const c1 = await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt1.worktreePath, branch: wt1.branch, keepBranch: false });
  const c2 = await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt2.worktreePath, branch: wt2.branch, keepBranch: false });
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, true);
  assert.equal(c1.branchDeleted, true);
  assert.equal(c2.branchDeleted, true);

  const list = await runGit(repo, ["worktree", "list", "--porcelain"]);
  const wtCount = list.stdout.split(/\r?\n/u).filter((l) => l.startsWith("worktree ")).length;
  assert.equal(wtCount, 1, "清理后应仅剩主工作区");
});

test("V04-W3 合并冲突安全中止并保留隔离分支，绝不损坏主工作区", async (t) => {
  const repo = await createTempGitRepo(t, { "shared.txt": "original\n" });
  const probe = await probeGitWorktree(repo);

  const wt1 = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "bc", stageId: "s1", attempt: 1, baseHead: probe.baseHead });
  const wt2 = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "bc", stageId: "s2", attempt: 1, baseHead: probe.baseHead });
  await writeFile(path.join(wt1.worktreePath, "shared.txt"), "edited-by-s1\n", "utf8");
  await writeFile(path.join(wt2.worktreePath, "shared.txt"), "edited-by-s2\n", "utf8");

  const d1 = await captureWorktreeDiff({ worktreePath: wt1.worktreePath, stageId: "s1", attempt: 1 });
  const d2 = await captureWorktreeDiff({ worktreePath: wt2.worktreePath, stageId: "s2", attempt: 1 });

  const merged = await mergeWorktreeSequential({
    repoRoot: probe.repoRoot,
    baseHead: probe.baseHead,
    items: [
      { stageId: "s1", branch: wt1.branch, ...d1 },
      { stageId: "s2", branch: wt2.branch, ...d2 },
    ],
  });
  assert.equal(merged.ok, false);
  assert.equal(merged.reason, "merge-conflict");
  assert.equal(merged.results[0].status, "merged");
  assert.equal(merged.results[1].status, "conflict");
  assert.equal(merged.results[1].keepBranch, true);
  // 主工作区保持 s1 的干净改动，不被 s2 冲突搞乱
  assert.equal(await readFile(path.join(repo, "shared.txt"), "utf8"), "edited-by-s1\n");

  await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt1.worktreePath, branch: wt1.branch, keepBranch: false });
  await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt2.worktreePath, branch: wt2.branch, keepBranch: true });
  const branches = await runGit(repo, ["branch", "--list", wt2.branch]);
  assert.match(branches.stdout, new RegExp(wt2.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "冲突分支必须保留供人工核对");
});

test("V04-W4 主仓库 HEAD 漂移时自动停止合入并保留分支", async (t) => {
  const repo = await createTempGitRepo(t);
  const probe = await probeGitWorktree(repo);
  const wt = await createWorkerWorktree({ repoRoot: probe.repoRoot, batchId: "bd", stageId: "s1", attempt: 1, baseHead: probe.baseHead });
  await writeFile(path.join(wt.worktreePath, "new.txt"), "wt change\n", "utf8");
  const d = await captureWorktreeDiff({ worktreePath: wt.worktreePath, stageId: "s1", attempt: 1 });

  // 模拟派工期间主仓库被提交了一次新 commit
  await writeFile(path.join(repo, "drift.txt"), "moved\n", "utf8");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--no-gpg-sign", "-m", "main moved"]);

  const merged = await mergeWorktreeSequential({
    repoRoot: probe.repoRoot,
    baseHead: probe.baseHead,
    items: [{ stageId: "s1", branch: wt.branch, ...d }],
  });
  assert.equal(merged.ok, false);
  assert.equal(merged.reason, "head-drifted");
  assert.equal(merged.results[0].status, "head-drifted");
  assert.equal(merged.results[0].keepBranch, true);
  await cleanupWorktree({ repoRoot: probe.repoRoot, worktreePath: wt.worktreePath, branch: wt.branch, keepBranch: true });
});

test("V04-W5 端到端 apply({ workerIsolation: 'worktree' }) 真实并行派工并合并到主工作区", async (t) => {
  const repo = await createTempGitRepo(t);
  const stateDir = await mkdtemp(path.join(tmpdir(), "mentor-v04-wt-state-"));
  t.after(async () => { await rm(stateDir, { recursive: true, force: true }); });

  const tools = new Map();
  const sessions = new Map();
  const workerCwds = [];
  const main = {
    session: { id: "wt-main", header: { cwd: repo }, seq: 0, append() {}, snapshotEvents: () => [] },
    options: { provider: "fixture", model: "fixture" },
    status: "idle",
    followup: async () => {},
    whenIdle: async () => {},
  };
  sessions.set("wt-main", main);

  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    agents: {
      async create({ sessionId, meta, setup }) {
        const events = [];
        let settled = false;
        const idle = Promise.withResolvers();
        const ag = {
          session: { id: sessionId, header: { cwd: meta?.cwd ?? repo }, seq: 0, append() {}, snapshotEvents: () => events },
          options: { provider: "fixture", model: "fixture" },
          status: "running",
          async followup(msg) {
            // 若是 worker，在它被分配的隔离 worktree 目录中写文件并结束回合
            if (sessionId.startsWith("mentor-worker-")) {
              workerCwds.push(meta.cwd);
              const target = msg.content[0].text.includes("阶段 s1") ? "f1.txt" : "f2.txt";
              await writeFile(path.join(meta.cwd, target), `written in ${path.basename(meta.cwd)}\n`, "utf8");
              events.push({ type: "assistant/message", seq: 1, time: Date.now(), data: { message: { content: [{ type: "text", text: `done ${target}` }] } } });
              events.push({ type: "turn/end", seq: 2, time: Date.now(), data: { reason: { kind: "completed" } } });
              ag.status = "idle";
              settled = true;
              idle.resolve();
            }
          },
          whenIdle: () => idle.promise,
        };
        sessions.set(sessionId, ag);
        const child = {
          tools: {
            view: () => ({ restrictableNames: new Set(["read", "write", "edit", "glob", "grep"]), visible: new Set(["read", "write", "edit", "glob", "grep"]) }),
            restrict() {},
            guard() {},
            register() {},
          },
        };
        if (typeof setup === "function") await setup(child, ag);
        return { agent: ag, async dispose() { if (!settled) idle.resolve(); } };
      },
      get: (id) => sessions.get(id) ?? null,
    },
  };

  const dispose = await apply(ctx, { stateDir, autoWakeMain: false, workerIsolation: "worktree", disposeTimeoutMs: 500 });
  t.after(async () => { await dispose(); await new Promise((r) => setTimeout(r, 20)); });
  const callAs = async (agent, name, args = {}) => JSON.parse(await tools.get(name).execute(args, { agent }));

  const created = await callAs(main, "mentor_task_create", { objective: "并行 worktree 端到端", workspaceRoot: repo });
  const taskId = created.value.taskId;
  await callAs(main, "mentor_plan_submit", {
    taskId,
    criteria: [{ id: "c1", text: "生成 f1.txt" }, { id: "c2", text: "生成 f2.txt" }],
    stages: [
      { id: "s1", title: "写 f1", criterionIds: ["c1"], dependsOn: [], writePaths: ["f1.txt"] },
      { id: "s2", title: "写 f2", criterionIds: ["c2"], dependsOn: [], writePaths: ["f2.txt"] },
    ],
  });
  const planJob = dispose.store.findSession("wt-main").get().reviewJobs[0];
  const rev = sessions.get(planJob.sessionId);
  await callAs(rev, "mentor_task_status", { taskId });
  await callAs(rev, "mentor_review_apply", {
    taskId, reviewJobId: planJob.id, kind: "plan", planVersion: 1, stageId: "__plan__", verdict: "pass",
    checks: [
      { source: "plan", criterion: "生成 f1.txt", criterionIds: ["c1"], observation: "ok", status: "passed" },
      { source: "plan", criterion: "生成 f2.txt", criterionIds: ["c2"], observation: "ok", status: "passed" },
    ],
  });

  const delegated = await callAs(main, "mentor_delegate_nodes", { taskId, stageIds: ["s1", "s2"], waitForCompletion: true });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  assert.equal(workerCwds.length, 2);
  assert.notEqual(workerCwds[0], repo, "worker 必须运行在独立 worktree 目录而非主工作区");
  assert.notEqual(workerCwds[0], workerCwds[1], "两个并行 worker 必须各有物理隔离目录");

  // 合并闸门已将两份改动合入主工作区
  assert.match(await readFile(path.join(repo, "f1.txt"), "utf8"), /written in /);
  assert.match(await readFile(path.join(repo, "f2.txt"), "utf8"), /written in /);
  const wtList = await runGit(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(wtList.stdout.split(/\r?\n/u).filter((l) => l.startsWith("worktree ")).length, 1, "派工结束后临时 worktree 应已清理干净");
});
