/**
 * v0.5 对抗性审计回归锁测试：
 * 把独立审计发现的每一项 P0/P1 隐患都锁进确定性回归测试，防止未来回退。
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";

import { apply } from "../lib/index.js";
import { createMemoryStore } from "../src/tools/handlers.js";
import {
  captureWorkspaceSnapshot,
  computeStageDiffAudit,
  rollbackToSnapshot,
} from "../src/runtime/workspace-diff.js";
import { scanDiffForTampering } from "../src/runtime/tamper-scan.js";
import { evaluatePlanRigor, RIGOR_TIERS } from "../src/runtime/rigor.js";
import { runAutoSyntaxPrechecks } from "../src/runtime/prechecks.js";
import { globMatchesPath, setLessonStatus } from "../src/runtime/lessons.js";
import { readEvidenceText } from "../src/review/evidence-reader.js";
import { setPhase } from "../src/runtime/phase-writer.js";

async function mkTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function safeRm(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
}

function createPluginHarness(cfg = {}, { reviewerSetupSpy } = {}) {
  const tools = new Map();
  const commands = new Map();
  const reviewerDispatches = [];
  const mainAgent = {
    session: { id: "main-adv-sess", header: { cwd: cfg.cwd ?? process.cwd() }, snapshotEvents: () => [] },
    options: { provider: "deepseek", model: "deepseek-chat" },
    followup: async () => {},
  };
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    commands: {
      register(spec) {
        commands.set(spec.name, spec);
        return () => commands.delete(spec.name);
      },
    },
    agents: {
      get(id) {
        return id === mainAgent.session.id ? mainAgent : null;
      },
      async create(opts) {
        const childTools = new Map();
        const childAgent = {
          session: { id: opts.sessionId, append() {}, snapshotEvents: () => [] },
          followup: async (msg) => {
            reviewerDispatches.push({
              sessionId: opts.sessionId,
              text: msg?.content?.[0]?.text ?? "",
              childTools,
              childAgent,
            });
          },
          whenIdle: async () => {},
        };
        const child = {
          tools: {
            register(tool) {
              childTools.set(tool.name, tool);
              return () => childTools.delete(tool.name);
            },
            view() {
              return {
                visible: new Set(["read", "glob", "grep", "working_directory", "mentor_task_status", "mentor_review_apply"]),
                restrictableNames: new Set(["read", "glob", "grep", "working_directory", "mentor_task_status", "mentor_review_apply"]),
              };
            },
            restrict() {},
            guard() {},
          },
          get() { return null; },
        };
        await opts.setup?.(child, childAgent);
        reviewerSetupSpy?.({ childTools, childAgent });
        return { agent: childAgent, dispose() {} };
      },
    },
  };
  return { tools, commands, mainAgent, ctx, reviewerDispatches };
}

async function execTool(tools, name, args, agent) {
  const t = tools.get(name);
  assert.ok(t, `tool ${name} should be registered`);
  return JSON.parse(await t.execute(args, { agent }));
}

test("V05-ADV-1: model self-declared express is rejected; express with prechecks cannot skip plan review; plan_amend cannot downgrade strict", async () => {
  const dir = await mkTempDir("dsh-v05-adv-rigor-");
  const stateDir = await mkTempDir("dsh-v05-adv-rigor-state-");
  try {
    await writeFile(path.join(dir, "app.js"), "export const x = 1;\n", "utf8");
    const h = createPluginHarness({ cwd: dir });
    const dispose = await apply(h.ctx, { stateDir, defaultRigor: "standard" });
    try {
      // 1) 模型通过工具自填 rigor: "express"（非人工、默认 standard）—— 必须被升回 standard，绝不能跳过计划审查
      const created = await execTool(h.tools, "mentor_task_create", {
        objective: "小改动测试",
        workspaceRoot: dir,
        rigor: "express",
      }, h.mainAgent);
      assert.equal(created.ok, true);

      const submitted = await execTool(h.tools, "mentor_plan_submit", {
        criteria: [{ id: "c1", text: "app.js 更新" }],
        stages: [{ id: "s1", title: "改 app.js", criterionIds: ["c1"], writePaths: ["app.js"] }],
      }, h.mainAgent);
      assert.equal(submitted.ok, true);
      assert.equal(submitted.value.rigor.tier, "standard");
      assert.equal(submitted.value.expressSkippedPlanReview, undefined);
      assert.equal(submitted.value.phase, "planning");
      assert.equal(h.reviewerDispatches.length, 1, "model self-declared express must NOT skip plan review");

      // 2) 纯函数测试：即使人工显式 express，只要阶段含自定义 prechecks 就不能跳过计划审查
      const withPrechecks = evaluatePlanRigor({
        requested: "express",
        defaultRigor: "express",
        userExplicit: true,
        objective: "更新按钮文案",
        criteria: [{ id: "c1", text: "文案正确" }],
        stages: [{ id: "s1", title: "改文案", criterionIds: ["c1"], writePaths: ["ui.js"], prechecks: ["node -v"] }],
      });
      assert.equal(withPrechecks.tier, "standard");
      assert.equal(withPrechecks.skipPlanReview, false);

      // 3) 纯函数测试：plan_amend 传入 currentTier="strict" 时，删掉高危词也不能降级
      const amended = evaluatePlanRigor({
        requested: "express",
        defaultRigor: "express",
        userExplicit: true,
        currentTier: RIGOR_TIERS.STRICT,
        objective: "改文案",
        criteria: [{ id: "c1", text: "改完" }],
        stages: [{ id: "s1", title: "改文案", criterionIds: ["c1"], writePaths: ["README.md"] }],
      });
      assert.equal(amended.tier, "strict");
      assert.equal(amended.skipPlanReview, false);
    } finally {
      await dispose();
    }
  } finally {
    await safeRm(dir);
    await safeRm(stateDir);
  }
});

test("V05-ADV-2: tamper-scan blocks model testChangePolicy spoof, ignores spec/openapi.yaml, catches nested expect() wipe & process.exitCode=0, and persists strict escalation", async () => {
  const dir = await mkTempDir("dsh-v05-adv-tamper-");
  const stateDir = await mkTempDir("dsh-v05-adv-tamper-state-");
  try {
    await mkdir(path.join(dir, "test"), { recursive: true });
    await mkdir(path.join(dir, "spec"), { recursive: true });
    await writeFile(path.join(dir, "src.js"), "export const v = 1;\n", "utf8");
    await writeFile(path.join(dir, "test", "unit.test.js"), "import assert from 'node:assert';\nexpect(compute(1)).toBe(2);\n", "utf8");
    await writeFile(path.join(dir, "spec", "openapi.yaml"), "openapi: 3.0.0\n", "utf8");

    // 1) 非代码 spec/openapi.yaml 删除不误杀
    const nonCodeRes = scanDiffForTampering({
      unifiedDiff: "",
      changedFiles: [{ path: "spec/openapi.yaml", status: "D" }],
      testChangePolicy: "none",
    });
    assert.equal(nonCodeRes.ok, true, "deleting spec/openapi.yaml must not false-block");

    // 2) 嵌套 expect(fn(x)).toBe(...) 被清空为 0 断言 → 硬拦截
    const nestedWipe = scanDiffForTampering({
      unifiedDiff: [
        "--- a/test/unit.test.js",
        "+++ b/test/unit.test.js",
        "@@ -1,2 +1,1 @@",
        "-expect(compute(1)).toBe(2);",
        "+console.log('ok');",
      ].join("\n"),
      changedFiles: [{ path: "test/unit.test.js", status: "M" }],
      readCurrentFile: () => "import assert from 'node:assert';\nconsole.log('ok');\n",
    });
    assert.equal(nestedWipe.ok, false);
    assert.ok(nestedWipe.blocks.some((b) => b.rule === "TEST_ASSERTIONS_WIPED"));

    // 3) process.exitCode = 0 属于硬拦截 TEST_EXIT_ZERO_ADDED
    const exitCodeRes = scanDiffForTampering({
      unifiedDiff: [
        "--- a/test/unit.test.js",
        "+++ b/test/unit.test.js",
        "@@ -1,1 +1,2 @@",
        "+process.exitCode = 0;",
      ].join("\n"),
      changedFiles: [{ path: "test/unit.test.js", status: "M" }],
    });
    assert.equal(exitCodeRes.ok, false);
    assert.ok(exitCodeRes.blocks.some((b) => b.rule === "TEST_EXIT_ZERO_ADDED"));

    // 4) 端到端：被审模型在 mentor_stage_report 中伪造 args.testChangePolicy="remove" 仍被硬拦截且 rigor 持久化升级为 strict
    const h = createPluginHarness({ cwd: dir });
    const dispose = await apply(h.ctx, { stateDir, defaultRigor: "express" });
    try {
      await execTool(h.tools, "mentor_task_create", { objective: "改 src.js", workspaceRoot: dir }, h.mainAgent);
      const plan = await execTool(h.tools, "mentor_plan_submit", {
        criteria: [{ id: "c1", text: "src.js 更新" }],
        stages: [{ id: "s1", title: "更新 src.js", criterionIds: ["c1"], writePaths: ["src.js"] }],
      }, h.mainAgent);
      assert.equal(plan.value.expressSkippedPlanReview, true);
      assert.equal(plan.value.requiresReview, false);
      assert.equal(plan.value.reviewPending, false);

      // 故意在 mentor_node_start 之前改文件并删除测试，验证 pre-start 篡改逃逸也被捕获！
      await writeFile(path.join(dir, "src.js"), "export const v = 2;\n", "utf8");
      await rm(path.join(dir, "test", "unit.test.js"));

      const started = await execTool(h.tools, "mentor_node_start", { stageId: "s1" }, h.mainAgent);
      assert.equal(started.ok, true);

      const reported = await execTool(h.tools, "mentor_stage_report", {
        stageId: "s1",
        attempt: 1,
        evidence: "updated src.js",
        evidenceRefs: [{ file: "src.js", snippet: "v = 2", criterionIds: ["c1"] }],
        // 模型试图在阶段上报里自填 testChangePolicy="remove" 绕过防篡改
        testChangePolicy: "remove",
      }, h.mainAgent);
      assert.equal(reported.ok, false);
      assert.equal(reported.code, "E_PRECHECK_FAILED");
      assert.ok(reported.details?.tamperScan?.blocks?.some((b) => b.rule === "TEST_FILE_DELETED"));
      const curTask = dispose.store.findSession(h.mainAgent.session.id)?.get();
      assert.equal(curTask?.rigor?.tier, "strict", "tamper hard-block must persist strict rigor escalation");
    } finally {
      await dispose();
    }
  } finally {
    await safeRm(dir);
    await safeRm(stateDir);
  }
});

test("V05-ADV-3: rollback restores all 60+ files, blocks symlink/traversal/cross-workspace replay, and syncs stage+dependent nodeRuns", async () => {
  const dir = await mkTempDir("dsh-v05-adv-rb-");
  const otherDir = await mkTempDir("dsh-v05-adv-rb-other-");
  const stateDir = await mkTempDir("dsh-v05-adv-rb-state-");
  try {
    // 1) 创建 60 个文件（大于 50 展示上限），验证全量回滚
    await mkdir(path.join(dir, "bulk"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(dir, "bulk", `f${String(i).padStart(2, "0")}.txt`), `orig-${i}\n`, "utf8");
    }
    const base = await captureWorkspaceSnapshot({ workspaceRoot: dir, stateDir, taskId: "rb60" });
    assert.equal(base.ok, true);

    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(dir, "bulk", `f${String(i).padStart(2, "0")}.txt`), `mutated-${i}\n`, "utf8");
    }
    await writeFile(path.join(dir, "bulk", "extra.txt"), "junk\n", "utf8");

    // 跨工作区回滚必须被拒绝
    const crossWs = await rollbackToSnapshot({
      workspaceRoot: otherDir,
      stateDir,
      taskId: "rb60",
      targetSnapshot: base,
    });
    assert.equal(crossWs.ok, false);
    assert.equal(crossWs.reason, "workspace-root-mismatch");

    // 正常回滚必须恢复全部 60 个文件 + 删除 extra.txt
    const rb60 = await rollbackToSnapshot({
      workspaceRoot: dir,
      stateDir,
      taskId: "rb60",
      targetSnapshot: base,
      force: true,
    });
    assert.equal(rb60.ok, true);
    assert.equal(rb60.restoredFiles.length, 60);
    assert.deepEqual(rb60.deletedFiles, ["bulk/extra.txt"]);
    assert.equal(await readFile(path.join(dir, "bulk", "f59.txt"), "utf8"), "orig-59\n");
    assert.equal(existsSync(path.join(dir, "bulk", "extra.txt")), false);

    // 2) 绝对路径 evidenceRefs 在工作区内不应误报为 undeclaredFiles
    await writeFile(path.join(dir, "bulk", "f00.txt"), "changed-again\n", "utf8");
    const absAudit = await computeStageDiffAudit({
      workspaceRoot: dir,
      stateDir,
      taskId: "rb60",
      baseline: base,
      evidenceRefs: [{ file: path.join(dir, "bulk", "f00.txt") }],
      writePaths: [path.join(dir, "bulk")],
    });
    assert.equal(absAudit.ok, true);
    assert.deepEqual(absAudit.audit.undeclaredFiles, []);
    assert.deepEqual(absAudit.audit.outsideWritePaths, []);

    // 3) 伪造恶意 manifest（路径穿越 ../escape.txt + 符号链接/联接点 linkdir/pwn.txt）必须被拦截，绝不越界写盘
    const outsideFile = path.join(otherDir, "victim.txt");
    await writeFile(outsideFile, "untouched\n", "utf8");
    const linkDir = path.join(dir, "linkdir");
    await symlink(otherDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    const slugs = await readdir(path.join(stateDir, "snapshots"));
    assert.ok(slugs.length >= 1);
    const snapDir = path.join(stateDir, "snapshots", slugs[0]);
    await mkdir(path.join(snapDir, "blobs"), { recursive: true });
    await writeFile(path.join(snapDir, "blobs", "deadbeef"), "pwned\n", "utf8");
    const fakeManifest = path.join(snapDir, "evil.json");
    await writeFile(fakeManifest, JSON.stringify({
      id: "evil",
      workspaceRoot: base.workspaceRoot,
      files: {
        "../escape.txt": { size: 6, mtimeMs: 0, sha256: "deadbeef", backedUp: true },
        "linkdir/pwn.txt": { size: 6, mtimeMs: 0, sha256: "deadbeef", backedUp: true },
      },
    }), "utf8");
    const evilRb = await rollbackToSnapshot({
      workspaceRoot: dir,
      stateDir,
      taskId: "rb60",
      targetSnapshot: { ok: true, mode: "manifest", id: "evil", workspaceRoot: base.workspaceRoot },
      force: true,
    });
    assert.equal(evilRb.ok, false);
    assert.equal(evilRb.reason, "unsafe-rollback-path");
    assert.equal(existsSync(path.join(otherDir, "pwn.txt")), false, "symlink/junction target must never be written");
    assert.equal(existsSync(path.join(path.dirname(dir), "escape.txt")), false, "parent traversal target must never be written");
    await rm(linkDir, { recursive: true, force: true });

    // 4) mentor_stage_rollback 禁止静默退回 __task__，并同步将本阶段及传递下游阶段重置为 rework
    const h = createPluginHarness({ cwd: dir });
    const dispose = await apply(h.ctx, { stateDir, defaultRigor: "standard" });
    try {
      await execTool(h.tools, "mentor_task_create", { objective: "两阶段流水线", workspaceRoot: dir }, h.mainAgent);
      const store = dispose.store.findSession(h.mainAgent.session.id);
      const taskSnap = await captureWorkspaceSnapshot({ workspaceRoot: dir, stateDir, taskId: store.get().id });
      assert.equal(taskSnap.ok, true);
      setPhase(store, "active", {
        planVersion: 1,
        approvedPlanVersion: 1,
        stages: [
          { id: "s1", title: "一", criterionIds: ["c1"], writePaths: ["bulk/f00.txt"] },
          { id: "s2", title: "二", dependsOn: ["s1"], criterionIds: ["c2"], writePaths: ["bulk/f01.txt"] },
        ],
        criteria: [{ id: "c1", text: "一" }, { id: "c2", text: "二" }],
        nodeRuns: [
          { stageId: "s1", attempt: 1, status: "accepted" },
          { stageId: "s2", attempt: 1, status: "accepted" },
        ],
        stageCheckpoints: { __task__: taskSnap, s1: taskSnap },
        lastDiffAudits: { s1: { changedCount: 1 }, s2: { changedCount: 1 } },
      });

      // 显式请求不存在专属快照的 s2 → 绝不静默回滚 __task__
      const cmd = h.commands.get("mentor");
      const noSilentFallback = await cmd.handler({ agent: h.mainAgent, rawInput: "rollback s2" });
      assert.equal(noSilentFallback.kind, "error");
      assert.match(noSilentFallback.text, /拒绝静默回滚/);

      // 回滚 s1 → s1 和传递依赖 s2 都必须重置为 rework 且 attempt+1、清理 lastDiffAudits
      const okRb = await cmd.handler({ agent: h.mainAgent, rawInput: "rollback s1 --force" });
      assert.equal(okRb.kind, "success");
      const after = store.get();
      const s1Run = after.nodeRuns.find((r) => r.stageId === "s1");
      const s2Run = after.nodeRuns.find((r) => r.stageId === "s2");
      assert.equal(s1Run.status, "rework");
      assert.equal(s1Run.attempt, 2);
      assert.equal(s2Run.status, "rework");
      assert.equal(s2Run.attempt, 2);
      assert.equal(after.lastDiffAudits.s1, undefined);
      assert.equal(after.lastDiffAudits.s2, undefined);

      // 更换 workspaceRoot 必须清空 stageCheckpoints 与 lastDiffAudits
      const switched = await execTool(h.tools, "mentor_workspace_set", { workspaceRoot: otherDir }, h.mainAgent);
      assert.equal(switched.ok, true);
      assert.deepEqual(store.get().stageCheckpoints, {});
      assert.deepEqual(store.get().lastDiffAudits, {});
    } finally {
      await dispose();
    }
  } finally {
    await safeRm(dir);
    await safeRm(otherDir);
    await safeRm(stateDir);
  }
});

test("V05-ADV-4: reviewer mentor_evidence_read(mode=diff) rejects stale review; sensitive files blocked; JSONC skipped; lessons corrupt store not wiped & glob ReDoS-safe", async () => {
  const dir = await mkTempDir("dsh-v05-adv-misc-");
  const stateDir = await mkTempDir("dsh-v05-adv-misc-state-");
  try {
    // 1) 敏感文件拦截 (.npmrc / .git-credentials / terraform.tfstate / secrets.json)
    await writeFile(path.join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n", "utf8");
    await writeFile(path.join(dir, "terraform.tfstate"), "{}\n", "utf8");
    assert.throws(() => readEvidenceText(dir, ".npmrc"), /敏感/);
    assert.throws(() => readEvidenceText(dir, "terraform.tfstate"), /敏感/);

    // 2) JSONC (tsconfig.json 含注释) 不应误报 JSON 语法失败
    await writeFile(path.join(dir, "tsconfig.json"), "{\n  // comment\n  \"compilerOptions\": { \"strict\": true }\n}\n", "utf8");
    await writeFile(path.join(dir, "good.json"), "{\"ok\":true}\n", "utf8");
    const syntaxRes = await runAutoSyntaxPrechecks({
      workspaceRoot: dir,
      changedFiles: [
        { path: "tsconfig.json", status: "M" },
        { path: "good.json", status: "M" },
      ],
    });
    assert.equal(syntaxRes.ok, true);
    assert.equal(syntaxRes.total, 1, "tsconfig.json should be skipped as JSONC while good.json is checked");

    // 3) lessons.js 损坏文件不覆盖、globMatchesPath 防 ReDoS
    const lessonsFile = path.join(stateDir, "mentor-lessons.json");
    await writeFile(lessonsFile, "{ corrupted json !!!", "utf8");
    const setRes = await setLessonStatus(stateDir, { fingerprint: "abc", status: "accepted" });
    assert.equal(setRes.ok, false);
    assert.equal(await readFile(lessonsFile, "utf8"), "{ corrupted json !!!", "corrupt file must NOT be overwritten");

    const t0 = Date.now();
    const redosMatched = globMatchesPath("a" + "*a".repeat(40) + "*b", "a".repeat(80) + "c");
    const elapsed = Date.now() - t0;
    assert.equal(redosMatched, false);
    assert.ok(elapsed < 100, `globMatchesPath must resist ReDoS (took ${elapsed}ms)`);

    // 4) mentor_evidence_read(mode="diff") 在阶段审查完成/失效后拒绝继续读取
    let capturedDiffTool = null;
    let capturedChildAgent = null;
    const h = createPluginHarness({ cwd: dir }, {
      reviewerSetupSpy({ childTools, childAgent }) {
        if (childTools.has("mentor_evidence_read")) {
          capturedDiffTool = childTools.get("mentor_evidence_read");
          capturedChildAgent = childAgent;
        }
      },
    });
    const dispose = await apply(h.ctx, { stateDir, defaultRigor: "express" });
    try {
      await execTool(h.tools, "mentor_task_create", { objective: "测试审查过期守卫", workspaceRoot: dir }, h.mainAgent);
      await execTool(h.tools, "mentor_plan_submit", {
        criteria: [{ id: "c1", text: "good.json" }],
        stages: [{ id: "s1", title: "s1", criterionIds: ["c1"], writePaths: ["good.json"] }],
      }, h.mainAgent);
      await execTool(h.tools, "mentor_node_start", { stageId: "s1" }, h.mainAgent);
      await writeFile(path.join(dir, "good.json"), "{\"ok\":true,\"v\":2}\n", "utf8");
      const rep = await execTool(h.tools, "mentor_stage_report", {
        stageId: "s1",
        planVersion: 1,
        attempt: 1,
        summary: "已更新 good.json",
        evidence: "updated good.json",
        evidenceRefs: [{ file: "good.json", snippet: "\"v\":2", criterionIds: ["c1"] }],
      }, h.mainAgent);
      assert.equal(rep.ok, true, JSON.stringify(rep));
      assert.ok(capturedDiffTool, "stage reviewer should have mentor_evidence_read registered");
      // 把审查作业标成 completed，验证再次调用 mode="diff" 被拒
      const st = dispose.store.findSession(h.mainAgent.session.id);
      const cur = st.get();
      st.set({
        ...cur,
        reviewJobs: (cur.reviewJobs ?? []).map((j) => ({ ...j, status: "completed" })),
      });
      await assert.rejects(
        () => capturedDiffTool.execute({ mode: "diff" }, { agent: capturedChildAgent }),
        /已失效/,
      );
    } finally {
      await dispose();
    }
  } finally {
    await safeRm(dir);
    await safeRm(stateDir);
  }
});
