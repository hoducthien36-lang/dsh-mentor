/**
 * v0.4 · Round 2 安全边界与 v0.3 P1 加固测试套件：
 *   1. prechecks 绝不静默截断（>16 条 fail-closed）、非法项 fail-closed、cwd realpath 防链接逃逸
 *   2. reviewer 同步前置 child.tools.guard（执行前拦截 write/pwsh/预算溢出，消除 1.5s 看门狗窗口）
 *   3. evidence-reader / evidence-check 拒绝敏感凭据路径（.env / .ssh / *.key 等）
 *   4. prompt 注入防御声明 + readReportExcerpt 不可信数据标记
 *   5. buildStatePayload 透出 lastPrechecks + runtimePayload 24KB 预算裁剪超长 precheck 输出尾部
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, runtimeReviewPrompt } from "../lib/index.js";
import { resolvePrecheckCwd, runStagePrechecks, MAX_TOTAL_PRECHECKS } from "../src/runtime/prechecks.js";
import { isSensitivePath, readEvidenceText } from "../src/review/evidence-reader.js";
import { checkEvidenceSync } from "../src/review/evidence-check.js";
import { buildStatePayload } from "../src/rpc/state.js";
import { runtimePayload, SNAPSHOT_BUDGET_BYTES } from "../src/runtime/activity.js";
import { REVIEWER_TOOL_BUDGET } from "../src/review/reviewer-policy.js";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mentor-v04-sec-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  return dir;
}

test("V04-S1 prechecks 超限（>16 条）与非法配置项均按 fail-closed 拦截，绝不静默通过", async (t) => {
  const ws = await tempDir(t);

  // 非法配置全部拦截
  const invalid = await runStagePrechecks({
    workspaceRoot: ws,
    prechecks: ["   ", { command: "" }, { command: "echo hi", timeoutMs: 10 }],
    runner: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  });
  assert.equal(invalid.ok, false, "全是非法项时绝不能返回 ok=true");
  assert.equal(invalid.failed, 3);
  assert.equal(invalid.passed, 0);

  // 超出合并上限不静默截断
  const tooMany = await runStagePrechecks({
    workspaceRoot: ws,
    prechecks: Array.from({ length: MAX_TOTAL_PRECHECKS + 1 }, (_, i) => `echo ${i}`),
    runner: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  });
  assert.equal(tooMany.ok, false, "超限必须明确失败而非静默截断");
  assert.match(tooMany.results[0].stderrTail, /拒绝静默截断/);
});

test("V04-S2 resolvePrecheckCwd 拒绝不存在目录与指向外部的 junction/symlink", async (t) => {
  const base = await tempDir(t);
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  await mkdir(ws, { recursive: true });
  await mkdir(outside, { recursive: true });

  assert.equal(resolvePrecheckCwd(ws, ".").ok, true);
  assert.equal(resolvePrecheckCwd(ws, "does-not-exist").ok, false);

  const linkPath = path.join(ws, "escape-link");
  await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  const check = resolvePrecheckCwd(ws, "escape-link");
  assert.equal(check.ok, false, "指向外部的 junction/symlink 必须被 realpath 拦截");
  assert.match(check.error, /越出 workspaceRoot/);
});

test("V04-S3 敏感凭据路径（.env / .ssh / *.key / credentials）在证据核对与读取两层均被拦截", async (t) => {
  const ws = await tempDir(t);
  await writeFile(path.join(ws, ".env"), "SECRET=123\n", "utf8");
  await writeFile(path.join(ws, "safe.txt"), "hello\n", "utf8");

  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/.env.production"), true);
  assert.equal(isSensitivePath(".ssh/id_rsa"), true);
  assert.equal(isSensitivePath("certs/private.key"), true);
  assert.equal(isSensitivePath("src/index.js"), false);

  assert.throws(() => readEvidenceText(ws, ".env"), (err) => err.code === "E_EVIDENCE_OUTSIDE");
  assert.equal(readEvidenceText(ws, "safe.txt"), "hello\n");

  const checked = checkEvidenceSync([{ file: ".env", scope: "file" }], () => {
    throw new Error("敏感路径不应触发底层读文件");
  }, { root: ws });
  assert.equal(checked.ok, false);
  assert.equal(checked.misses[0].reason, "outside-root");
});

test("V04-S4 reviewer 同步前置 child.tools.guard 在执行前拦截 write/pwsh 与超预算调用", async (t) => {
  const root = await tempDir(t);
  const ws = path.join(root, "ws");
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, "a.txt"), "ok\n", "utf8");

  const tools = new Map();
  let installedGuard = null;
  let reviewerAgent = null;
  const main = {
    session: { id: "sec-main", header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => [] },
    options: { provider: "fixture", model: "fixture" },
    status: "idle",
    followup: async () => {},
    whenIdle: async () => {},
  };

  const ctx = {
    tools: {
      register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    },
    agents: {
      async create({ sessionId, setup }) {
        const idle = Promise.withResolvers();
        reviewerAgent = {
          session: { id: sessionId, header: { cwd: ws }, seq: 0, append() {}, snapshotEvents: () => [] },
          options: { provider: "fixture", model: "fixture" },
          status: "running",
          followup: async () => {},
          whenIdle: () => idle.promise,
        };
        const child = {
          tools: {
            view: () => ({ restrictableNames: new Set(["mentor_task_status", "mentor_review_apply", "read"]), visible: new Set() }),
            restrict() {},
            guard(fn) { installedGuard = fn; },
            register() {},
          },
        };
        if (typeof setup === "function") setup(child, reviewerAgent);
        return { agent: reviewerAgent, async dispose() { idle.resolve(); } };
      },
      get: () => main,
    },
  };

  const dispose = await apply(ctx, { stateDir: root, autoWakeMain: false, disposeTimeoutMs: 500 });
  t.after(async () => { await dispose(); await new Promise((r) => setTimeout(r, 20)); });

  const call = async (name, args) => JSON.parse(await tools.get(name).execute(args, { agent: main }));
  const created = await call("mentor_task_create", { objective: "测试同步守卫", workspaceRoot: ws });
  await call("mentor_plan_submit", {
    taskId: created.value.taskId,
    criteria: [{ id: "c1", text: "检查 a.txt" }],
    stages: [{ id: "s1", title: "阶段 1", criterionIds: ["c1"], dependsOn: [] }],
  });

  assert.equal(typeof installedGuard, "function", "spawnReviewer 必须安装同步 tools.guard");
  assert.equal(installedGuard({ agent: reviewerAgent, name: "write" }), "reviewer-forbidden-tool:write");
  assert.equal(installedGuard({ agent: reviewerAgent, name: "pwsh" }), "reviewer-forbidden-tool:pwsh");
  assert.equal(installedGuard({ agent: reviewerAgent, name: "mentor_stage_report" }), "reviewer-forbidden-tool:mentor_stage_report");
  // 允许的工具在预算内放行，超出预算被同步拦截
  for (let i = 1; i <= REVIEWER_TOOL_BUDGET; i += 1) {
    assert.equal(installedGuard({ agent: reviewerAgent, name: "mentor_task_status" }), undefined);
  }
  assert.match(installedGuard({ agent: reviewerAgent, name: "mentor_task_status" }), /reviewer-tool-budget-exceeded/);

  // prompt 包含不可信数据边界声明
  const task = dispose.store.findSession("sec-main").get();
  const prompt = runtimeReviewPrompt(task, task.reviewJobs[0]);
  assert.match(prompt, /不可信被审数据/);
});

test("V04-S5 buildStatePayload 透出 lastPrechecks，且 runtimePayload 24KB 预算会裁剪超长 precheck 尾部", () => {
  const hugeTail = "ERROR LINE\n".repeat(4000);
  const task = {
    id: "t-pre-budget",
    revision: 3,
    objective: "预算裁剪测试",
    phase: "active",
    planVersion: 1,
    approvedPlanVersion: 1,
    enabled: true,
    criteria: [{ id: "c1", text: "c1" }],
    stages: [{ id: "s1", title: "s1", criterionIds: ["c1"], dependsOn: [] }],
    nodeRuns: [{
      stageId: "s1", attempt: 1, status: "running", reports: [],
      lastPrecheck: {
        at: 1, ok: false, total: 1, passed: 0, failed: 1, durationMs: 20,
        results: [{ id: "p1", label: "lint", command: "npm run lint", ok: false, exitCode: 1, timedOut: false, durationMs: 20, stdoutTail: hugeTail, stderrTail: hugeTail }],
      },
    }],
    lastPrechecks: {
      s1: {
        at: 1, ok: false, total: 1, passed: 0, failed: 1, durationMs: 20,
        results: [{ id: "p1", label: "lint", command: "npm run lint", ok: false, exitCode: 1, timedOut: false, durationMs: 20, stdoutTail: hugeTail, stderrTail: hugeTail }],
      },
    },
    findings: [],
    reviews: [],
    reviewJobs: [],
    wakeDispatches: [],
  };

  const state = buildStatePayload(task);
  assert.equal(state.lastPrechecks.s1.ok, false, "buildStatePayload 必须透出 lastPrechecks");

  const compact = runtimePayload({ agents: { get: () => undefined } }, { get: () => task, settings: {} }, { summaries: () => [], all: () => [] });
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") <= SNAPSHOT_BUDGET_BYTES, "包含超大 precheck 尾部时仍须严守 24KB 预算");
  assert.equal(compact.lastPrechecks.s1.ok, false, "裁剪尾部后仍须保留失败状态");
  assert.equal(compact.lastPrechecks.s1.results[0].exitCode, 1);
});
