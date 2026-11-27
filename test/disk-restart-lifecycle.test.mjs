import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";

import { apply, createStore, recoverInterrupted, spawnReviewer, cancelMentorRuntime } from "../lib/index.js";
import { HANDLERS } from "../src/tools/handlers.js";
import { assertStateShape, readState } from "../src/persist/store.js";
import { createSessionStores } from "../src/runtime/session-stores.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const deferred = () => Promise.withResolvers();
const sample = (extra = {}) => ({
  id: "task-A", revision: 4, phase: "active", planVersion: 1, approvedPlanVersion: 1,
  enabled: true, objective: "磁盘重启生命周期 ✅", mainSessionId: "main", workspaceRoot: ROOT,
  criteria: [{ id: "c1", text: "可恢复完成" }],
  stages: [{ id: "s1", title: "交付", criterionIds: ["c1"], dependsOn: [] }],
  nodeRuns: [{ stageId: "s1", attempt: 1, status: "accepted", reports: [] }],
  findings: [], reviews: [], reviewJobs: [], delegations: [], pendingCheckpoint: null,
  ...extra,
});

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "mentor-disk-lifecycle-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function harness(stateDir, options = {}) {
  const tools = new Map(), effects = [], children = new Map();
  let cleaned = 0;
  const main = { session: { id: "main", header: { cwd: ROOT }, snapshotEvents: () => [] },
    options: { provider: "fixture", model: "fixture" } };
  const ctx = {
    tools: { register(tool) {
      tools.set(tool.name, tool);
      return () => {
        cleaned++;
        tools.delete(tool.name);
        if (options.throwDisposer && cleaned === 1) throw new Error("fixture-disposer-failure");
      };
    } },
    effect(fn) { effects.push(fn()); },
    agents: { async create({ sessionId }) {
      const idle = deferred();
      const child = { session: { id: sessionId, snapshotEvents: () => [] },
        followup: async () => {}, whenIdle: () => idle.promise };
      const record = { idle, agent: child, disposals: 0 };
      children.set(sessionId, record);
      return { agent: child, async dispose() {
        record.disposals++;
        try { await options.onChildDispose?.(record); }
        finally { idle.resolve(); }
      } };
    } },
  };
  const dispose = await apply(ctx, { stateDir, autoWakeMain: false, disposeTimeoutMs: options.disposeTimeoutMs ?? 1000 });
  const store = dispose.store.all()[0];
  const call = async (name, args = {}, agent = main) => {
    const tool = tools.get(name);
    assert.ok(tool, name);
    return JSON.parse(await tool.execute(args, { store, agent }));
  };
  return { ctx, main, store, call, dispose, children, effects, tools, cleaned: () => cleaned };
}

for (const [label, bytes] of [
  ["corrupt JSON", Buffer.concat([Buffer.from('{ 坏 JSON 🌸\r\n', "utf8"), Buffer.from([0xff])])],
  ["wrong-shape JSON", Buffer.from('{"中文":"✅","revision":2}\r\n', "utf8")],
]) {
  test(`startup quarantines ${label} verbatim and attaches the original diagnostic once`, async t => {
    const dir = await directory(t), file = path.join(dir, "mentor-task.json");
    await fs.writeFile(file, bytes);
    const store = await createStore(dir);
    try {
      assert.equal(store.get(), null);
      assert.equal(store.quarantineFailed, false);
      const error = JSON.parse(await fs.readFile(path.join(dir, "mentor-startup-error.json"), "utf8"));
      assert.equal(error.kind, "corrupt");
      assert.ok(error.quarantinedTo);
      assert.equal(path.dirname(error.quarantinedTo), path.join(dir, "quarantine"));
      assert.deepEqual(await fs.readFile(error.quarantinedTo), bytes);
      await assert.rejects(fs.access(file), { code: "ENOENT" });
      store.set(sample());
      assert.deepEqual(store.get().lastStateError, error);
      store.set(sample({ revision: 5 }));
      assert.equal(store.get().lastStateError, undefined);
      await store.drain();
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), store.get());
      assert.deepEqual(await fs.readFile(error.quarantinedTo), bytes);
    } finally { await store.drain(); }
  });
}

test("quarantine failure is structured and the startup store refuses to overwrite original bytes", async t => {
  const dir = await directory(t), file = path.join(dir, "mentor-task.json");
  const bytes = Buffer.from([0xff, 0xfe, 0x7b, 0x0d, 0x0a]);
  await fs.writeFile(file, bytes);
  // A regular file cannot be used as the quarantine directory, on Windows or POSIX.
  await fs.writeFile(path.join(dir, "quarantine"), "blocked");
  const loaded = await readState(file, { quarantineDir: path.join(dir, "quarantine"), validate: assertStateShape });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.quarantineFailed, true);
  assert.equal(loaded.quarantinedTo, null);
  assert.ok(loaded.quarantineError.length > 0);
  const store = await createStore(dir);
  assert.equal(store.quarantineFailed, true);
  assert.equal(store.lastStateError.kind, "quarantine-failed");
  assert.throws(() => store.set(sample()), { code: "E_STATE_CORRUPT" });
  assert.equal(store.get(), null);
  await store.drain();
  assert.deepEqual(await fs.readFile(file), bytes);
  const error = JSON.parse(await fs.readFile(path.join(dir, "mentor-startup-error.json"), "utf8"));
  assert.equal(error.kind, "quarantine-failed");
  assert.equal(error.quarantineFailed, true);
});

test("same-millisecond quarantines of identical basenames retain both originals", async t => {
  const dir = await directory(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
  const quarantineDir = path.join(dir, "quarantine");
  const inputs = await Promise.all(["one", "two"].map(async name => {
    const parent = path.join(dir, name);
    await fs.mkdir(parent);
    const file = path.join(parent, "mentor-task.json");
    await fs.writeFile(file, name);
    return { file, name };
  }));
  const results = await Promise.all(inputs.map(({ file }) => readState(file, { quarantineDir })));
  assert.notEqual(results[0].quarantinedTo, results[1].quarantinedTo);
  for (const [i, result] of results.entries()) {
    assert.equal(result.quarantineFailed, undefined);
    assert.match(path.basename(result.quarantinedTo), new RegExp(`\\.${process.pid}\\.`));
    assert.equal(await fs.readFile(result.quarantinedTo, "utf8"), inputs[i].name);
  }
});

for (const change of ["replaced", "archived", "amended"]) {
  test(`plan amend rejects a task ${change} during awaited child cancellation without further writes`, async t => {
    const dir = await directory(t), entered = deferred(), release = deferred();
    const p = await harness(dir, { onChildDispose: () => { entered.resolve(); return release.promise; } });
    try {
      p.store.set(sample());
      const review = await spawnReviewer(p.ctx, p.store, { agent: p.main }, { kind: "stage", stageId: "s1", attempt: 1 });
      assert.equal(review.queued, true);
      const pending = p.call("mentor_plan_amend", { taskId: "task-A", reason: "新计划" });
      await entered.promise;
      if (change === "replaced") {
        p.store.set(sample({ id: "task-B", revision: 71, planVersion: 8,
          nodeRuns: [{ stageId: "B", attempt: 3, status: "running", reports: [] }],
          reviewJobs: [{ id: "B-review", status: "queued", planVersion: 8 }],
          pendingCheckpoint: { kind: "completion", planVersion: 8, evidence: "保留 B" },
        }));
      } else if (change === "archived") {
        assert.equal(HANDLERS.mentor_task_clear(p.store, {}).ok, true);
      } else {
        p.store.set({ ...p.store.get(), planVersion: p.store.get().planVersion + 1, revision: 91 });
      }
      const snapshot = structuredClone(p.store.get());
      release.resolve();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.code, "E_STALE_PLAN", JSON.stringify(result));
      await turn();
      assert.deepEqual(p.store.get(), snapshot, "identity, revision, runs, reviews and checkpoint must remain unchanged");
      assert.equal(p.children.size, 1, "must not spawn a reviewer for the changed task");
      await p.store.drain();
      assert.deepEqual(JSON.parse(await fs.readFile(p.store.stateFile, "utf8")), snapshot);
    } finally { release.resolve(); await p.dispose(); }
  });
}

test("recoverInterrupted expectation checks all identity fields and remains idempotent after reload", async t => {
  const dir = await directory(t), store = await createStore(dir);
  store.set(sample({ nodeRuns: [{ stageId: "s1", attempt: 1, status: "running" }],
    reviewJobs: [{ id: "review", status: "running" }], delegations: [{ batchId: "batch", status: "running" }] }));
  const snapshot = structuredClone(store.get());
  const expect = { taskId: snapshot.id, planVersion: snapshot.planVersion, mainSessionId: snapshot.mainSessionId };
  for (const wrong of [{ taskId: "B" }, { planVersion: 99 }, { mainSessionId: "other" }]) {
    assert.deepEqual(recoverInterrupted(store, "restart", { ...expect, ...wrong }), { applied: false, reason: "task-changed" });
    assert.deepEqual(store.get(), snapshot);
  }
  assert.deepEqual(recoverInterrupted(store, "restart", expect), { applied: true });
  assert.equal(store.get().revision, snapshot.revision + 1);
  assert.equal(store.get().nodeRuns[0].status, "rework");
  assert.equal(store.get().nodeRuns[0].attempt, 2);
  assert.equal(store.get().reviewJobs[0].status, "failed");
  assert.equal(store.get().delegations[0].status, "cancelled");
  await store.drain();
  const restored = await createStore(dir), recovered = structuredClone(restored.get());
  assert.deepEqual(recoverInterrupted(restored, "restart", expect), { applied: false, reason: "no-interrupted-work" });
  assert.deepEqual(restored.get(), recovered);
});

test("drain follows writes enqueued while the previous write is settling, including session stores", async t => {
  const dir = await directory(t);
  const registry = await createSessionStores(createStore, { stateDir: dir });
  const store = await registry.forSession("drain-main");
  store.set(sample({ revision: 1 }));
  const pending = registry.drain();
  const late = store.flush().then(() => store.set(sample({ revision: 2, objective: "最后一次写入 🌸" })));
  await pending;
  await late;
  assert.equal(JSON.parse(await fs.readFile(store.stateFile, "utf8")).revision, 2);
  await registry.close();
  await assert.rejects(registry.forSession("after-close"), /卸载/);
});

test("dispose and effect share one promise, await delayed child teardown and final disk writes, then resume to completion", async t => {
  const dir = await directory(t), entered = deferred(), release = deferred();
  let p;
  p = await harness(dir, { throwDisposer: true, onChildDispose: async () => {
    entered.resolve();
    await release.promise;
    // Model a child's delayed finally block, followed by another queued state write.
    p.store.set({ ...p.store.get(), teardown: "子会话已清理 ✅" });
    void p.store.flush().then(() => p.store.set({ ...p.store.get(), finalWrite: "尾部写盘 🌸" }));
  } });
  try {
    p.store.set(sample());
    const requested = await p.call("mentor_completion_request", { evidence: "所有阶段已验收" });
    assert.equal(requested.ok, true, JSON.stringify(requested));
    assert.equal(requested.value.queued, true);
    const execute = p.tools.get("mentor_task_pause").execute;
    const shutdown = p.effects[0]();
    assert.equal(p.dispose(), shutdown);
    assert.equal(p.dispose.done, shutdown);
    await entered.promise;
    let finished = false;
    void shutdown.then(() => { finished = true; });
    await turn();
    assert.equal(finished, false, "dispose must await the delayed child");
    assert.equal(p.tools.size, 0, "one throwing disposer must not skip remaining disposers");
    const blocked = JSON.parse(await execute({}, { store: p.store, agent: p.main }));
    assert.equal(blocked.code, "E_TASK_INACTIVE");
    assert.deepEqual(await spawnReviewer(p.ctx, p.store, { agent: p.main }), { queued: false, reason: "plugin-disposed" });
    release.resolve();
    await shutdown;
    assert.equal(p.dispose(), shutdown);
    assert.equal(p.children.values().next().value.disposals, 1);
    const cleanups = p.cleaned();
    await p.effects[0]();
    assert.equal(p.cleaned(), cleanups);
    const reopened = await createStore(dir);
    assert.equal(reopened.get().teardown, "子会话已清理 ✅");
    assert.equal(reopened.get().finalWrite, "尾部写盘 🌸");
    assert.deepEqual(reopened.get(), p.store.get());
    const before = structuredClone(reopened.get());
    assert.equal(recoverInterrupted(reopened, "restart").applied, false);
    assert.deepEqual(reopened.get(), before);

    const resumed = await harness(dir);
    try {
      assert.equal((await resumed.call("mentor_task_pause")).ok, true);
      const resume = await resumed.call("mentor_task_resume");
      assert.equal(resume.ok, true, JSON.stringify(resume));
      let job = resumed.store.get().reviewJobs.findLast(j => j.status === "running");
      if (!job) {
        const retried = await resumed.call("mentor_review_retry", { reviewJobId: requested.value.reviewJobId });
        assert.equal(retried.ok, true, JSON.stringify(retried));
        job = resumed.store.get().reviewJobs.find(j => j.id === retried.value.reviewJobId);
      }
      assert.ok(job);
      const reviewer = resumed.children.get(job.sessionId).agent;
      assert.equal((await resumed.call("mentor_task_status", {}, reviewer)).ok, true);
      const result = await resumed.call("mentor_review_apply", {
        reviewJobId: job.id, kind: "completion", stageId: "__completion__", attempt: 1,
        planVersion: 1, verdict: "pass", checks: [{ source: "fixture", criterion: "可恢复完成",
          criterionIds: ["c1"], observation: "重启后所有阶段验收状态与持久化记录一致", status: "passed" }],
      }, reviewer);
      assert.equal(result.ok, true, JSON.stringify(result));
      resumed.children.get(job.sessionId).idle.resolve();
      assert.equal(resumed.store.get().phase, "completed");
      assert.equal(resumed.store.get().pendingCheckpoint, null);
      assert.ok(resumed.store.get().reviews.some(r => r.verdict === "pass"));
    } finally { await resumed.dispose(); }
    const final = await createStore(dir);
    assert.equal(final.get().phase, "completed");
    assert.equal(final.get().finalWrite, "尾部写盘 🌸");
    assert.equal(recoverInterrupted(final, "restart again").applied, false);
  } finally { release.resolve(); await p.dispose(); }
});

test("hung child disposal is bounded and cancellation/disposal calls share the same teardown", async t => {
  const dir = await directory(t);
  const p = await harness(dir, { disposeTimeoutMs: 25, onChildDispose: () => new Promise(() => {}) });
  try {
    p.store.set(sample());
    const review = await spawnReviewer(p.ctx, p.store, { agent: p.main }, { kind: "stage", stageId: "s1", attempt: 1 });
    assert.equal(review.queued, true);
    let watchdog;
    try {
      await Promise.race([
        Promise.all([cancelMentorRuntime(p.store, "task-A"), p.dispose()]),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("bounded cancellation did not finish")), 1000); }),
      ]);
    } finally { clearTimeout(watchdog); }
    assert.equal(p.children.get(review.reviewerSessionId).disposals, 1);
  } finally { await p.dispose(); }
});
