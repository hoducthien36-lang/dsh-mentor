/**
 * 2026-11-13（s2）：summaries() 必须过滤归档任务的锁。
 *
 * 背景：面板的 tasks 列表来自 registry.summaries()（activity.js:175，runtimePayload 内），
 * 原来 summarize() 只 filter(Boolean) 不去 phase，于是早已 archived 的任务连同它停在
 * rework 的阶段进度一起挂在界面上，看起来像还有任务在跑。
 *
 * 本文件锁三件事：
 *   1. summaries() 不返回 phase === "archived" 的任务
 *   2. completed 不被过滤（只过滤 archived，别扩大范围）
 *   3. all() / select() 行为不变 —— 归档任务仍可按 id 选中并读到
 *
 * 不依赖真实文件系统：factory 忽略 stateDir，直接返回内存 store。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSessionStores } from "../src/runtime/session-stores.js";
import { createMemoryStore } from "../src/tools/handlers.js";

/**
 * createSessionStores 先建 legacy（factory 第 1 次调用），之后每次 forSession 建一个。
 * 用序号喂不同初值，得到 legacy(空) + live(active) + arch(archived) + done(completed)。
 */
const SEEDS = [
  null,
  { id: "task_live", phase: "active", objective: "live", revision: 1, updatedAt: 300 },
  { id: "task_arch", phase: "archived", objective: "arch", revision: 2, updatedAt: 200 },
  { id: "task_done", phase: "completed", objective: "done", revision: 3, updatedAt: 100 },
];

async function setup() {
  let i = 0;
  const factory = async () => createMemoryStore(SEEDS[i++] ?? null);
  const registry = await createSessionStores(factory, { stateDir: null });
  await registry.forSession("sess-live");
  await registry.forSession("sess-arch");
  await registry.forSession("sess-done");
  return registry;
}

test("summaries() 不返回归档任务，但 all() 与 select() 仍能看到它", async () => {
  const registry = await setup();

  assert.equal(registry.all().length, 4, "all() 应含全部 store（legacy 空 + 三个任务）");

  const ids = registry.summaries().map((t) => t.taskId).sort();
  assert.deepEqual(ids, ["task_done", "task_live"], "summaries 只应含非归档任务");
  assert.equal(registry.summaries().length, 2);

  const picked = await registry.select({ taskId: "task_arch" });
  assert.equal(picked.get().phase, "archived", "select 仍能选中归档任务");
  assert.ok(
    registry.all().some((s) => s.get()?.id === "task_arch"),
    "all() 仍含归档任务（未被删除）",
  );
});

test("summaries() 保留 completed，只过滤 archived", async () => {
  const registry = await setup();
  const ids = registry.summaries().map((t) => t.taskId);
  assert.ok(ids.includes("task_done"), "completed 不该被过滤");
  assert.ok(!ids.includes("task_arch"), "archived 必须被过滤");
});

test("summaries() 仍按 updatedAt 倒序，返回字段集合不变", async () => {
  const registry = await setup();
  const rows = registry.summaries();
  assert.deepEqual(rows.map((r) => r.taskId), ["task_live", "task_done"], "按 updatedAt 倒序");
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["mainSessionId", "objective", "phase", "revision", "taskId"],
      "投影字段与改动前一致",
    );
  }
});
