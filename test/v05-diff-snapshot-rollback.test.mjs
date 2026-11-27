import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  captureWorkspaceSnapshot,
  computeStageDiffAudit,
  readFileDiffExcerpt,
  rollbackToSnapshot,
  formatDiffAuditForPrompt,
} from "../src/runtime/workspace-diff.js";
import { apply } from "../lib/index.js";

function gitSync(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeFakeHost(ws) {
  const registered = new Map();
  let cmdHandler = null;
  const ctx = {
    on: () => () => {},
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
    commands: {
      register(spec) {
        if (spec && spec.name === "mentor" && typeof spec.handler === "function") {
          cmdHandler = (agent, rawInput) => spec.handler({ agent, rawInput });
        }
        return () => {};
      },
    },
    agents: {
      created: [],
      async create(opts) {
        let reviewerRead = null;
        const childTools = {
          view: () => ({ restrictableNames: new Set(["mentor_task_status", "mentor_review_apply", "read", "glob", "grep", "working_directory"]) }),
          restrict() {},
          guard() {},
          register(t) { if (t.name === "mentor_evidence_read") reviewerRead = t; },
        };
        let resolveIdle;
        const idlePromise = new Promise((res) => { resolveIdle = res; });
        const childAgent = {
          session: {
            id: opts.sessionId,
            header: { cwd: ws },
            append() {},
            snapshotEvents: () => [],
          },
          followup: async (msg) => { ctx.agents.created.at(-1).prompt = msg?.content?.[0]?.text ?? ""; },
          whenIdle: () => idlePromise,
        };
        const rec = { opts, agent: childAgent, prompt: "", getEvidenceRead: () => reviewerRead, finishIdle: () => resolveIdle() };
        ctx.agents.created.push(rec);
        if (opts.setup) await opts.setup({ tools: childTools }, childAgent);
        return { agent: childAgent };
      },
      get: () => null,
    },
  };
  const mainAgent = {
    session: { id: "main-sess-v05", header: { cwd: ws }, snapshotEvents: () => [] },
    options: { provider: "deepseek", model: "deepseek-chat" },
  };
  return {
    ctx,
    registered,
    mainAgent,
    getCmd: () => cmdHandler,
    async call(name, args = {}) {
      const tool = registered.get(name);
      assert.ok(tool, `tool missing: ${name}`);
      return JSON.parse(await tool.execute(args, { agent: mainAgent }));
    },
  };
}

test("V05-D1: Git 模式无侵入快照不碰 .git/index、防 .gitattributes clean filter RCE、过滤 .env 并支持精准回滚不改无关 mtime", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-git-"));
  const sentinel = path.join(dir, "rce-canary.txt");
  try {
    gitSync(dir, ["init"]);
    gitSync(dir, ["config", "user.name", "tester"]);
    gitSync(dir, ["config", "user.email", "tester@local"]);
    await writeFile(path.join(dir, ".gitattributes"), "*.js filter=evil\n", "utf8");
    await writeFile(path.join(dir, "keep.txt"), "untouched content\n", "utf8");
    await writeFile(path.join(dir, "app.js"), "export const x = 1;\n", "utf8");
    await writeFile(path.join(dir, "old.js"), "export const old = 1;\n", "utf8");
    gitSync(dir, ["add", "-A"]);
    gitSync(dir, ["commit", "--no-verify", "-m", "init"]);
    // 在基线提交后再配置真实可执行的恶意 clean filter（Git 内置 sh 必定可执行）：
    // 若快照误跑 `git add`，立刻会写出 rce-canary.txt；用 `--no-filters` 则绝不触发！
    const sentinelPosix = sentinel.replace(/\\/gu, "/");
    gitSync(dir, ["config", "filter.evil.clean", `sh -c 'echo PWNED > "${sentinelPosix}"; cat'`]);

    // 给 keep.txt 设一个过去的时间戳，验证回滚不刷它的 mtime
    const pastTime = new Date(Date.now() - 120_000);
    await utimes(path.join(dir, "keep.txt"), pastTime, pastTime);
    const keepMtimeBefore = Math.trunc((await stat(path.join(dir, "keep.txt"))).mtimeMs);

    // 模拟任务前用户的脏改动 & 敏感 .env 文件
    await writeFile(path.join(dir, ".env"), "SECRET_KEY=topsecret\n", "utf8");
    await writeFile(path.join(dir, "user-wip.txt"), "user pre-task edit\n", "utf8");

    const baseSnap = await captureWorkspaceSnapshot({ workspaceRoot: dir, taskId: "t-git" });
    assert.equal(baseSnap.ok, true);
    assert.equal(baseSnap.mode, "git");
    assert.equal(baseSnap.skippedSensitive >= 1, true, "必须跳过 .env 敏感文件");

    // 确认未触发 .gitattributes clean filter RCE
    let rceTriggered = false;
    try { await stat(sentinel); rceTriggered = true; } catch {}
    assert.equal(rceTriggered, false, "快照绝不能执行仓库 .gitattributes clean filter");

    // 确认主仓库 git status/index 未被污染（user-wip.txt 仍为未暂存 ??；测试自身调 status 需同样关掉 canary filter）
    const statusPorcelain = gitSync(dir, ["-c", "filter.evil.clean=", "status", "--porcelain"]);
    assert.match(statusPorcelain, /\?\?\s+user-wip\.txt/);

    // 阶段执行：改 app.js、新增 extra.js、删 old.js
    await writeFile(path.join(dir, "app.js"), "export const x = 2;\nexport const y = 3;\n", "utf8");
    await writeFile(path.join(dir, "extra.js"), "export const sneaky = true;\n", "utf8");
    await rm(path.join(dir, "old.js"));

    const diffRes = await computeStageDiffAudit({
      workspaceRoot: dir,
      taskId: "t-git",
      baseline: baseSnap,
      evidenceRefs: [{ file: "app.js", line: 1, snippet: "export const x = 2;" }],
      writePaths: ["app.js"],
    });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.audit.totalChangedFiles, 3);
    assert.deepEqual(diffRes.audit.undeclaredFiles.sort(), ["extra.js", "old.js"]);
    assert.deepEqual(diffRes.audit.outsideWritePaths.sort(), ["extra.js", "old.js"]);
    assert.match(diffRes.unifiedDiff, /extra\.js/);

    // 确认依旧未触发 RCE
    try { await stat(sentinel); rceTriggered = true; } catch {}
    assert.equal(rceTriggered, false);

    // 回滚预览（dryRun）
    const preview = await rollbackToSnapshot({
      workspaceRoot: dir,
      taskId: "t-git",
      targetSnapshot: baseSnap,
      currentSnapshot: diffRes.currentSnapshot,
      dryRun: true,
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.toRestore.sort(), ["app.js", "old.js"]);
    assert.deepEqual(preview.toDelete, ["extra.js"]);

    // 模拟外部人工又改了 app.js → 默认拒绝覆盖（防丢失人工修改）
    await writeFile(path.join(dir, "app.js"), "export const x = 999;\n", "utf8");
    const blocked = await rollbackToSnapshot({
      workspaceRoot: dir,
      taskId: "t-git",
      targetSnapshot: baseSnap,
      currentSnapshot: diffRes.currentSnapshot,
      dryRun: false,
      force: false,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "external-modifications-detected");
    assert.deepEqual(blocked.externalConflicts, ["app.js"]);

    // 显式 force 精准回滚
    const rolled = await rollbackToSnapshot({
      workspaceRoot: dir,
      taskId: "t-git",
      targetSnapshot: baseSnap,
      currentSnapshot: diffRes.currentSnapshot,
      force: true,
    });
    assert.equal(rolled.ok, true);
    assert.equal(await readFile(path.join(dir, "app.js"), "utf8"), "export const x = 1;\n");
    assert.equal(await readFile(path.join(dir, "old.js"), "utf8"), "export const old = 1;\n");
    assert.equal(await readFile(path.join(dir, "user-wip.txt"), "utf8"), "user pre-task edit\n", "不得误删任务前用户未提交改动");
    let extraExists = true;
    try { await stat(path.join(dir, "extra.js")); } catch { extraExists = false; }
    assert.equal(extraExists, false, "本阶段新建文件应被移除");

    // 关键验证（避开 OpenCode checkout-index 坑）：无关文件 keep.txt 的 mtime 纹丝不动
    const keepMtimeAfter = Math.trunc((await stat(path.join(dir, "keep.txt"))).mtimeMs);
    assert.equal(keepMtimeAfter, keepMtimeBefore, "精准回滚绝不得刷新无关文件的 mtime");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V05-D2: 非 Git 工作区双模快照、纯 JS Diff 审计与精准回滚（零外部依赖）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-nongit-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-state-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
    await writeFile(path.join(dir, "keep.txt"), "stay calm\n", "utf8");
    await writeFile(path.join(dir, ".env"), "API_KEY=sk-secret12345678\n", "utf8");

    const pastTime = new Date(Date.now() - 90_000);
    await utimes(path.join(dir, "keep.txt"), pastTime, pastTime);
    const keepMtimeBefore = Math.trunc((await stat(path.join(dir, "keep.txt"))).mtimeMs);

    const baseSnap = await captureWorkspaceSnapshot({ workspaceRoot: dir, stateDir, taskId: "t-nongit" });
    assert.equal(baseSnap.ok, true);
    assert.equal(baseSnap.mode, "manifest");
    assert.equal(baseSnap.skippedSensitive >= 1, true);

    await writeFile(path.join(dir, "src", "math.js"), "export function add(a, b) {\n  return a + b + 0;\n}\n", "utf8");
    await writeFile(path.join(dir, "src", "extra.js"), "export const z = 1;\n", "utf8");

    const diffRes = await computeStageDiffAudit({
      workspaceRoot: dir,
      stateDir,
      taskId: "t-nongit",
      baseline: baseSnap,
      evidenceRefs: [{ file: "src/math.js", line: 2, snippet: "return a + b + 0;" }],
    });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.audit.mode, "manifest");
    assert.equal(diffRes.audit.totalChangedFiles, 2);
    assert.deepEqual(diffRes.audit.undeclaredFiles, ["src/extra.js"]);
    assert.match(diffRes.unifiedDiff, /\+  return a \+ b \+ 0;/);

    const single = await readFileDiffExcerpt({
      workspaceRoot: dir,
      stateDir,
      taskId: "t-nongit",
      baseline: baseSnap,
      current: diffRes.currentSnapshot,
      file: "src/extra.js",
    });
    assert.equal(single.ok, true);
    assert.match(single.diff, /src\/extra\.js/);
    assert.doesNotMatch(single.diff, /src\/math\.js/);

    const promptText = formatDiffAuditForPrompt(diffRes.audit);
    assert.match(promptText, /未声明改动警告/);
    assert.match(promptText, /src\/extra\.js/);

    const rb = await rollbackToSnapshot({
      workspaceRoot: dir,
      stateDir,
      taskId: "t-nongit",
      targetSnapshot: baseSnap,
      currentSnapshot: diffRes.currentSnapshot,
    });
    assert.equal(rb.ok, true);
    assert.equal(await readFile(path.join(dir, "src", "math.js"), "utf8"), "export function add(a, b) {\n  return a + b;\n}\n");
    let extraExists = true;
    try { await stat(path.join(dir, "src", "extra.js")); } catch { extraExists = false; }
    assert.equal(extraExists, false);
    assert.equal(Math.trunc((await stat(path.join(dir, "keep.txt"))).mtimeMs), keepMtimeBefore);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
});

test("V05-D3: 端到端接线（node_start 快照 → stage_report 未声明改动审计 → 审查员 mode='diff' 可读 → /mentor rollback 精准回滚）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-e2e-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-e2e-state-"));
  try {
    await writeFile(path.join(dir, "main.js"), "export const v = 1;\n", "utf8");
    const host = makeFakeHost(dir);
    const plugin = await apply(host.ctx, { stateDir, autoWakeMain: false, defaultRigor: "express" });
    try {
      const created = await host.call("mentor_task_create", {
        objective: "修改 main.js 常量",
        workspaceRoot: dir,
        rigor: "express",
      });
      assert.equal(created.ok, true);

      const planned = await host.call("mentor_plan_submit", {
        taskId: created.value.taskId,
        criteria: [{ id: "c1", text: "main.js 常量更新为 2" }],
        stages: [{ id: "s1", title: "更新常量", description: "改 main.js", criterionIds: ["c1"], dependsOn: [], writePaths: ["main.js"] }],
      });
      assert.equal(planned.ok, true);
      assert.equal(planned.value.expressSkippedPlanReview, true, "小修 express 应跳过计划审查直接进入 active");
      assert.equal(planned.value.phase, "active");

      const started = await host.call("mentor_node_start", { taskId: created.value.taskId, stageId: "s1" });
      assert.equal(started.ok, true);
      assert.ok(started.value.checkpointId, "mentor_node_start 必须记录阶段基线快照");

      // 修改 main.js + 偷偷新增一个未声明的 secret-side.js
      await writeFile(path.join(dir, "main.js"), "export const v = 2;\n", "utf8");
      await writeFile(path.join(dir, "side.js"), "export const side = 'sneaky';\n", "utf8");

      const reported = await host.call("mentor_stage_report", {
        taskId: created.value.taskId,
        stageId: "s1",
        planVersion: planned.value.planVersion,
        summary: "已更新 main.js",
        evidence: "main.js 已改为 2",
        evidenceRefs: [{ file: "main.js", line: 1, snippet: "export const v = 2;" }],
      });
      assert.equal(reported.ok, true, JSON.stringify(reported));
      assert.deepEqual(reported.value.diffAudit.undeclaredFiles, ["side.js"]);
      assert.equal(reported.value.rigorUpgraded?.tier, "strict", "出现未声明改动必须强制升档至 strict");

      // 独立审查员 prompt 应包含宿主真实 Diff 与未声明改动警告，且可用 mode='diff' 读到 side.js
      const rev = host.ctx.agents.created.at(-1);
      assert.ok(rev, "阶段审查应已派发");
      assert.match(rev.prompt, /宿主真实工作区改动审计/);
      assert.match(rev.prompt, /side\.js/);

      const evReadTool = rev.getEvidenceRead();
      assert.ok(evReadTool);
      const diffPayload = JSON.parse(await evReadTool.execute({ mode: "diff", file: "side.js" }, { agent: rev.agent }));
      assert.equal(diffPayload.ok, true);
      assert.match(diffPayload.diff, /sneaky/);

      // 结束审查运行，再执行人工回滚
      rev.finishIdle();
      await new Promise((r) => setTimeout(r, 20));

      // 人工执行 /mentor rollback --dry-run 与正式回滚
      const cmd = host.getCmd();
      const previewCmd = await cmd(host.mainAgent, "rollback s1 --dry-run");
      assert.equal(previewCmd.kind, "success");
      assert.match(previewCmd.text, /将恢复 1 个文件、删除 1 个新建文件/);

      const rbCmd = await cmd(host.mainAgent, "rollback s1");
      assert.equal(rbCmd.kind, "success");
      assert.equal(await readFile(path.join(dir, "main.js"), "utf8"), "export const v = 1;\n");
      let sideExists = true;
      try { await stat(path.join(dir, "side.js")); } catch { sideExists = false; }
      assert.equal(sideExists, false);
    } finally {
      await plugin();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
});
