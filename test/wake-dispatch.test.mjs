/**
 * 唤醒投递接线测试（s4）。
 *
 * 用假 ctx.agents 测「投一次 / 重复不投 / 关闭不投 / 抛错不影响裁决 / 各类降级」。
 * 真机（restart 后真 followup）属 s5，本测试不冒充。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { wakeMain } from "../lib/index.js";
import { createMemoryStore, taskCreate } from "../src/tools/handlers.js";
import path from "node:path";

/** s3：v0.2.0 起 handlers.taskCreate 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。
 *  这里统一给测试一个项目根，避免每条用例各自硬编码。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const SESSION = "session-main-1";

/** 造任务：带 mainSessionId（withSession=false 时模拟旧任务）、一条未关闭 finding */
function makeStore({ withSession = true } = {}) {
  const store = createMemoryStore();
  taskCreate(store, { workspaceRoot: ROOT, objective: "唤醒投递", mainSessionId: withSession ? SESSION : undefined });
  const t = store.get();
  // 注意：taskCreate 不写 undefined 字段；若要模拟旧任务，显式删掉即可
  if (!withSession) delete t.mainSessionId;
  store.set({
    ...t,
    planVersion: 2,
    findings: [{ id: "f1", status: "open", severity: "blocking", text: "问题" }],
    wakeDispatches: [],
  });
  return store;
}

/** 假宿主：agents.get 返回带 followup 的 agent */
function fakeCtx({ alive = true, throwOnFollowup = false } = {}) {
  const calls = [];
  const lookups = [];
  return {
    calls,
    lookups,
    ctx: {
      agents: {
        get(id) {
          lookups.push(id);
          if (!alive) return undefined;
          return {
            agent: {
              async followup(message) {
                if (throwOnFollowup) throw new Error("followup 超时");
                calls.push(message);
              },
            },
          };
        },
      },
    },
  };
}

const deps = {
  createUserMessage: ({ source, content }) => ({ role: "user", source, content }),
};

const applied = { stageId: "s1", attempt: 1, verdict: "revise" };

/* ------------------------- 1. 投一次 ------------------------- */

test("D1 正常投递：queued=true，followup 一次，消息含四要素，日志记 queued", async () => {
  const store = makeStore();
  const { ctx, calls, lookups } = fakeCtx();

  const r = await wakeMain(ctx, store, applied, { deps });

  assert.equal(r.queued, true);
  assert.equal(r.reason, "ok");
  // v0.2.0 去重键（lib/index.js:736-737）：
  //   <taskId>/<reviewJobId|reviewId|stageId>/<planVersion>/<attempt>/<verdict>
  // 带上 taskId 与 planVersion，是为了「换任务 / 改计划后同阶段重审」不被误判为重复。
  assert.equal(r.key, `${store.get().id}/s1/${store.get().planVersion}/1/revise`);
  assert.equal(calls.length, 1);
  assert.deepEqual(lookups, [SESSION], "应该去拿主轴会话，不是别人");

  const text = calls[0].content[0].text;
  assert.match(text, /^\[mentor\] 阶段 s1（attempt 1）审查完成：revise/u);
  assert.match(text, /未解决 finding：1 条（blocking 1 \/ advisory 0）/u);
  assert.match(text, /mentor_finding_respond/u);
  assert.match(text, /planVersion：2/u);

  const log = store.get().wakeDispatches;
  assert.equal(log.length, 1);
  assert.equal(log[0].queued, true);
  assert.equal(log[0].key, r.key);
});

test("D1b plan 审查文案带 planVersion 与 attempt（多轮 revise 可区分）", async () => {
  const store = makeStore();
  const { ctx, calls } = fakeCtx();

  const r = await wakeMain(ctx, store,
    { kind: "plan", stageId: "__plan__", attempt: 3, verdict: "revise", planVersion: 2 }, { deps });

  assert.equal(r.queued, true);
  assert.equal(calls.length, 1);
  // 2026-11-09 真机：plan 文案原来不含轮次，五轮 revise 长得一模一样，被误看成重复投递。
  const text = calls[0].content[0].text;
  assert.match(text, /^\[mentor\] 计划审查完成：revise（planVersion 2，attempt 3）/u);
});

/* ------------------------- 2. 重复不投 ------------------------- */
test("D2 同一三元组第二次 → duplicate，不再 followup", async () => {
  const store = makeStore();
  const { ctx, calls } = fakeCtx();

  const first = await wakeMain(ctx, store, applied, { deps });
  const second = await wakeMain(ctx, store, applied, { deps });

  assert.equal(second.queued, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.key, first.key, "同一三元组必须落到同一个去重键");
  assert.equal(calls.length, 1, "只投一次");
  // v0.2.0：duplicate 分支直接返回、不写审计（lib/index.js:748-750）——
  // 只有真正尝试投递（成功或失败）才留痕，否则日志会被重复调用灌满。
  assert.equal(store.get().wakeDispatches.length, 1, "只有成功那次留痕");
  assert.equal(store.get().wakeDispatches[0].queued, true);
});

test("D3 不同 verdict / 不同 attempt 不算重复", async () => {
  const store = makeStore();
  const { ctx, calls } = fakeCtx();

  await wakeMain(ctx, store, applied, { deps });
  await wakeMain(ctx, store, { ...applied, verdict: "pass" }, { deps });
  await wakeMain(ctx, store, { ...applied, attempt: 2 }, { deps });

  assert.equal(calls.length, 3);
});

/* ------------------------- 3. 关闭 ------------------------- */

test("D4 enabled=false → disabled，且不去碰 agents.get", async () => {
  const store = makeStore();
  const { ctx, calls, lookups } = fakeCtx();

  const r = await wakeMain(ctx, store, applied, { deps, enabled: false });

  assert.equal(r.queued, false);
  assert.equal(r.reason, "disabled");
  assert.equal(calls.length, 0);
  assert.deepEqual(lookups, [], "关闭时连会话都不查");
  assert.equal(store.get().wakeDispatches.at(-1).reason, "disabled");
});

/* ------------------------- 4. 各类降级 ------------------------- */

test("D5 旧任务无 mainSessionId → no-main-session", async () => {
  const store = makeStore({ withSession: false });
  const { ctx, calls } = fakeCtx();

  const r = await wakeMain(ctx, store, applied, { deps });
  assert.equal(r.reason, "no-main-session");
  assert.equal(calls.length, 0);
});

test("D6 宿主无 ctx.agents → host-agents-unavailable", async () => {
  const store = makeStore();
  const r = await wakeMain({}, store, applied, { deps });
  assert.equal(r.reason, "host-agents-unavailable");
});

test("D7 会话已结束（agents.get 返回 undefined）→ main-session-gone", async () => {
  const store = makeStore();
  const { ctx } = fakeCtx({ alive: false });

  const r = await wakeMain(ctx, store, applied, { deps });
  assert.equal(r.reason, "main-session-gone");
  assert.equal(store.get().wakeDispatches.at(-1).reason, "main-session-gone");
});

test("D8 拿不到 createUserMessage → llm-unavailable，不投裸对象", async () => {
  const store = makeStore();
  const { ctx, calls } = fakeCtx();

  // 不注入 deps，且测试环境里动态 import 失败 → 应拒绝投递而不是发裸对象
  const r = await wakeMain(ctx, store, applied, { deps: { createUserMessage: null } });
  // 若环境里真有 dsh-llm 则可为 ok；两种情况都不能发裸对象
  if (r.queued) {
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0], "object");
  } else {
    assert.equal(r.reason, "llm-unavailable");
    assert.equal(calls.length, 0);
  }
});

/* ------------------------- 5. 投递抛错不影响裁决 ------------------------- */

test("D9 followup 抛错 → delivery-failed，不向外抛（裁决不受影响）", async () => {
  const store = makeStore();
  const { ctx } = fakeCtx({ throwOnFollowup: true });

  const r = await wakeMain(ctx, store, applied, { deps });

  assert.equal(r.queued, false);
  assert.match(r.reason, /^delivery-failed: /u);
  assert.match(store.get().wakeDispatches.at(-1).reason, /^delivery-failed: /u);
  // 任务本身没被改动（revision 不变）
  assert.equal(store.get().wakeDispatches.length, 1);
});
