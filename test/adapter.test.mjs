/**
 * 适配层自测（lib/index.js）。
 *
 * 用假 ctx 驱动 apply()，检查：
 *   - 7 个工具是否全部注册、名字与 HANDLERS 一致
 *   - 参数 schema 是否包含 SPEC §4 要求的 taskId / userMessageSeq
 *   - execute 是否能真正跑通（返回可解析的 JSON）
 *   - dispose 是否能撤销注册、effect 是否被调用
 *
 * 注意边界：假 ctx 不跑 dsh-tools 的真实 compilePropertyMap，因此
 * 真机独有的 schema 约束（如 required 只能写 true 或省略）测不出来，
 * 那类问题只能在 s5 的真机加载中暴露。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_NAMES, VERSION, apply, createPersistentStore, createStore, inject, name as pluginName, spawnReviewer, withFollowupTimeout, withReviewerTracking } from "../lib/index.js";
import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { PHASES } from "../src/state/machine.js";
import { mkEvidence } from "./helpers/evidence.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

function makeCtx() {
  const registered = new Map();
  const effects = [];
  const ctx = {
    tools: {
      register(tool) {
        if (registered.has(tool.name)) throw new Error(`重复注册：${tool.name}`);
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
    effect(fn) {
      effects.push(fn);
    },
  };
  return { ctx, registered, effects };
}

/**
 * 当前测试的宿主替身。
 *
 * runAction 里 `store = exec?.store ?? await registry.forAgent(exec?.agent)`
 * —— 同一个 agent 对象拿到同一个 store，换一个 agent 就是新 store。
 * 所以：每次 setup() 造一个新 exec（测试之间隔离），同一次测试里的多次 call 复用
 * 同一个 exec（建完任务还能查到）。上一版每次 call 都新建 exec、session id 又固定，
 * 结果所有用例命中同一个 store，前一条留下的任务会污染后一条。
 */
let CURRENT_EXEC = null;
let execSeq = 0;

/** 换一个宿主会话 —— store 按 session id 隔离（src/runtime/session-stores.js:43 forAgent→forSession） */
function newSession() {
  execSeq += 1;
  CURRENT_EXEC = {
    agent: {
      session: {
        id: `test-session-${execSeq}`,
        header: { cwd: ROOT, delegationDepth: 0 },
      },
    },
  };
  return CURRENT_EXEC;
}

/** apply 是 async，统一在这里 await */
async function setup(config = {}) {
  const m = makeCtx();
  newSession();
  const out = await apply(m.ctx, config);
  return { ...m, out, exec: CURRENT_EXEC };
}

/** 直接调用某工具的 execute 并解析 JSON 结果 */
async function call(registered, toolName, args) {
  const tool = registered.get(toolName);
  assert.ok(tool, `工具未注册：${toolName}`);
  // s3：v0.2.0 起 runAction 从 exec.agent.session 取 sid 与 cwd
  //（lib/index.js:670 `sid = exec?.agent?.session?.id`，:687 拿 cwd 兜底 workspaceRoot）。
  const raw = await tool.execute(args ?? {}, CURRENT_EXEC ?? {});
  assert.equal(typeof raw, "string", `${toolName} execute 应返回字符串`);
  return JSON.parse(raw);
}

test("插件元信息：name 与 inject", () => {
  assert.equal(pluginName, "dsh-mentor");
  // 本轮起自动审查需要 ctx.agents（对照 dsh-task-supervisor 的八项 inject 声明）
  // s3：v0.2.0 新增 /mentor 命令通道，同时声明 commands 服务
  assert.deepEqual(inject, ["tools", "agents", "commands"]);
  assert.equal(typeof VERSION, "string");
});

test("apply 注册全部工具，且与 HANDLERS 键一致", async () => {
  const { registered } = await setup();

  // s3：这条断言原先假设「所有工具都对应一个 HANDLERS 键」，v0.2.0 之后不成立，
  // 差异是**有意的分层**，不是漂移：
  //   · 需要 ctx/agent 的三个工具在 lib/index.js 里内联实现（:469-472 注册，:675/:681/:682 实现）
  //   · mentor_delegate_complete 只由运行时内部回填调用，mentor_finding_close
  //     不向模型开放（README:24），两者都不该出现在 TOOL_NAMES
  const INLINE_IMPLEMENTED = ["mentor_review_retry","mentor_workspace_set","mentor_task_continue","mentor_work_mode",
    "mentor_team_start","mentor_team_direction","mentor_team_note","mentor_team_context","mentor_verify_review_recovery"];
  const INTERNAL_ONLY = ["mentor_delegate_complete", "mentor_finding_close"];

  const expectedTools = [...new Set([...Object.keys(HANDLERS), ...INLINE_IMPLEMENTED])]
    .filter((n) => !INTERNAL_ONLY.includes(n))
    .sort();

  assert.equal(registered.size, TOOL_NAMES.length);
  assert.deepEqual([...registered.keys()].sort(), expectedTools, "注册的工具集应等于 HANDLERS + 内联实现 - 内部专用");
  assert.deepEqual([...TOOL_NAMES].sort(), expectedTools, "TOOL_NAMES 应与实际注册一致");
  for (const n of INTERNAL_ONLY) {
    assert.ok(!TOOL_NAMES.includes(n), `${n} 是内部专用，不该开放成工具`);
  }
});

test("每个工具都有非空 description 与 parameters", async () => {
  const { registered } = await setup();
  for (const [n, tool] of registered) {
    assert.equal(typeof tool.description, "string", `${n} 缺 description`);
    assert.ok(tool.description.length > 10, `${n} description 太短`);
    assert.equal(typeof tool.parameters, "object", `${n} 缺 parameters`);
    assert.ok(Object.keys(tool.parameters).length > 0, `${n} parameters 为空`);
  }
});

test("参数 schema 对齐 SPEC §4：create 带 userMessageSeq，其余带 taskId", async () => {
  const { registered } = await setup();

  const create = registered.get("mentor_task_create").parameters;
  assert.ok(create.objective, "create 应要求 objective");
  assert.equal(create.objective.required, true);
  assert.ok(create.userMessageSeq, "create 应接受 userMessageSeq");

  for (const n of TOOL_NAMES) {
    if (n === "mentor_task_create") continue;
    assert.ok(registered.get(n).parameters.taskId, `${n} 应接受 taskId`);
  }

  assert.equal(registered.get("mentor_plan_submit").parameters.criteria.required, true);
  assert.equal(registered.get("mentor_plan_submit").parameters.stages.required, true);
  assert.equal(registered.get("mentor_stage_report").parameters.stageId.required, true);
  assert.ok(registered.get("mentor_stage_report").parameters.attemptRef, "stage_report 应支持 attemptRef 绑定");
  assert.ok(registered.get("mentor_stage_report").parameters.attempt, "stage_report 应保留 attempt 兼容参数");
  assert.equal(registered.get("mentor_finding_respond").parameters.findingId.required, true);
  assert.equal(registered.get("mentor_review_apply").parameters.verdict.required, true);
});

test("可选参数不得显式带 required:false（真机 schema 会拒）", async () => {
  const { registered } = await setup();
  for (const [n, tool] of registered) {
    for (const [paramName, spec] of Object.entries(tool.parameters)) {
      if ("required" in spec) {
        assert.equal(
          spec.required,
          true,
          `${n}.${paramName} 显式写了 required:${spec.required}，真机会拒绝；可选参数应整体省略该字段`,
        );
      }
    }
  }
});

test("execute 真正跑通：建任务 → 读状态", async () => {
  const { registered } = await setup();

  const created = await call(registered, "mentor_task_create", { workspaceRoot: ROOT,
    objective: "适配层自测",
    userMessageSeq: 42,
  });
  assert.equal(created.ok, true);
  assert.ok(created.value.taskId);
  assert.equal(created.value.phase, PHASES.PLANNING);
  assert.equal(created.value.userMessageSeq, 42);

  const status = await call(registered, "mentor_task_status", {});
  assert.equal(status.ok, true);
  assert.equal(status.value.objective, "适配层自测");
  assert.equal(status.value.taskId, created.value.taskId);
});

test("execute 走完整闭环：计划 → 上报 → 裁决 → 完成", async () => {
  const { registered } = await setup();

  const created = await call(registered, "mentor_task_create", { workspaceRoot: ROOT, objective: "闭环" });
  assert.equal(created.ok, true);
  const plan = await call(registered, "mentor_plan_submit", {
    criteria: [{ id: "c1", text: "一条" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
  });
  assert.equal(plan.ok, true);
  // s3：v0.2.0 起 plan_submit 直接进入 reviewing 等独立审查（自带 requiresReview:true），
  // 不再停在 active。旧断言取的是 v0.1.x 语义。
  // 2026-11-09（T1 契约）：审查期不再是 reviewing —— 转移表里没有
  // awaiting-approval→reviewing，所以计划审查期间 phase 停在 planning，
  // 只挂 pendingCheckpoint，由审查结论决定落到 awaiting-approval 还是 active。
  assert.equal(plan.value.phase, PHASES.PLANNING);
  assert.equal(plan.value.requiresReview, true);
  assert.equal(plan.value.reviewPending, true);

  // 闸门：计划没经独立审查通过（approvedPlanVersion !== planVersion）就不能上报阶段
  //（lib/index.js:693）。这条也在 execute 链路上真验一遍，别只在 store 层断言。
  const gated = await call(registered, "mentor_stage_report", {
    stageId: "s1",
    attempt: 1,
    evidence: "实测通过",
    evidenceRefs: [mkEvidence("SPEC.md")],
    planVersion: plan.value.planVersion,
  });
  assert.equal(gated.ok, false, "未过计划审查时必须拦");
  // 拦截顺序（lib/index.js:692 → 693）：plan_submit 会先落 pendingCheckpoint，
  // 所以第一道是「检查点未完成」，第二道才是「计划未审查通过」。两者都表示同一件事：
  // 计划还没拿到独立审查的结论，阶段不能开工。
  assert.match(
    JSON.stringify(gated),
    /当前检查点尚未完成|计划尚未审查通过/,
    JSON.stringify(gated),
  );

  // 闭环后半段落在 HANDLERS 层。
  //
  // 为什么不在 execute 上硬走：工具链路里 mentor_review_apply 必须绑定 reviewJobId，
  // 且只认独立审查会话的 sessionId —— 主会话自判会被 E_SELF_REVIEW_UNAUTHORIZED 拦
  //（src/runtime/checkpoints.js:59-78，这是 v0.2.0 的审查独立性要求）。
  // 假宿主没有 ctx.agents，派发不到 reviewer 会话；要在这里伪造独立会话，
  // 测的就不是适配层而是伪造的会话身份了。
  // HANDLERS 就是工具链路真正的落点（lib/index.js:701 `HANDLERS[name]?.(store,args)`），
  // 所以在这里把「计划已通过」之后的三段接起来，覆盖的是同一张表、同一份状态机。
  const store = createMemoryStore();
  const created2 = HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "闭环" });
  assert.equal(created2.ok, true);
  const plan2 = HANDLERS.mentor_plan_submit(store, {
    criteria: [{ id: "c1", text: "一条" }],
    stages: [{ id: "s1", criterionIds: ["c1"], dependsOn: [] }],
  });
  assert.equal(plan2.ok, true);
  assert.equal(store.get().phase, PHASES.ACTIVE);
  assert.equal(store.get().approvedPlanVersion, plan2.value.planVersion, "计划提交即批准（无 requireApproval）");

  const rep = HANDLERS.mentor_stage_report(store, {
    stageId: "s1",
    attempt: 1,
    evidence: "实测通过",
    evidenceRefs: [mkEvidence("SPEC.md")],
    planVersion: plan2.value.planVersion,
  });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(rep.value.status, "reported");

  const rev = HANDLERS.mentor_review_apply(store, { stageId: "s1", attempt: 1, verdict: "pass" });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(store.get().nodeRuns[0].status, "accepted", "pass 后节点必须 accepted");

  const done = HANDLERS.mentor_completion_request(store, { evidence: "全部完成" });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.value.phase, PHASES.COMPLETED);
});

test("taskId 校验：传入不匹配的 id 返回结构化错误而非静默忽略", async () => {
  const { registered } = await setup();
  await call(registered, "mentor_task_create", { workspaceRoot: ROOT, objective: "x" });

  const wrong = await call(registered, "mentor_task_status", { taskId: "task_not_here" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.details.multiTask, false);
  assert.equal(wrong.details.requestedTaskId, "task_not_here");
  assert.ok(wrong.details.currentTaskId);
});

test("错误路径不抛异常，返回 { ok:false, code }", async () => {
  const { registered } = await setup();

  // s3：v0.2.0 起「没有任务」不再是错误 —— mentor_task_status 返回 {ok:true, value:{task:null}}，
  // 让面板能区分「空态」与「取数失败」（src/rpc/state.js:23 同一语义）。
  // 这里改成断言空态形状；真正的错误路径改用需要任务的操作来测。
  newSession();
  const empty = await call(registered, "mentor_task_status", {});
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.value.task, null, "无任务应是空态成功，不是错误");

  const r2 = await call(registered, "mentor_stage_report", {});
  assert.equal(r2.ok, false);
  assert.equal(typeof r2.code, "string");
});

/* ------------------------------------------------------------------ *
 * Round 3：失败信封统一带可执行引导
 * ------------------------------------------------------------------ */
test("失败信封保持 { ok, code, message, details } 形状，并补 nextStep / allowedActions / retryable / recovery", async () => {
  const { registered } = await setup();
  await call(registered, "mentor_task_create", { workspaceRoot: ROOT, objective: "错误引导" });

  const denied = await call(registered, "mentor_task_approve", {});
  assert.equal(denied.ok, false);
  assert.equal(typeof denied.code, "string");
  assert.equal(typeof denied.message, "string");
  assert.equal(denied.details.recovery, "correct-input");
  assert.equal(denied.details.retryable, false);
  assert.deepEqual(Object.keys(denied).sort(), ["code", "details", "message", "ok"], "工具信封形状不变");
  assert.ok(denied.details.nextStep && typeof denied.details.nextStep.code === "string");
  assert.ok(Array.isArray(denied.details.allowedActions));
  for (const name of denied.details.allowedActions) {
    assert.notEqual(name, "mentor_review_waive", "模型侧不该被推荐人工放行动作");
    assert.notEqual(name, "mentor_finding_close", "模型侧不该被推荐人工关闭动作");
  }
});

test("effect 钩子被调用，dispose 撤销全部注册", async () => {
  const { registered, effects, out } = await setup();
  assert.equal(effects.length, 1);
  assert.equal(registered.size, TOOL_NAMES.length);

  // cordis 的 effect 约定：回调必须返回 cleanup 函数（真机不给会报 Invalid effect）
  const cleanup = effects[0]();
  assert.equal(typeof cleanup, "function", "effect 回调必须返回 cleanup 函数");
  cleanup();
  assert.equal(registered.size, 0);

  // apply 返回的本身就是 dispose 函数（cordis 要求返回值必须是函数或 null）
  assert.equal(typeof out, "function", "apply 必须返回 dispose 函数");
  assert.doesNotThrow(() => out());
});

test("缺失 ctx.tools 时抛出可诊断错误", async () => {
  await assert.rejects(() => apply({}, {}), /宿主未提供 ctx\.tools\.register/);
  await assert.rejects(() => apply(null, {}), /宿主未提供 ctx\.tools\.register/);
});

test("配置被采纳并可回读", async (t) => {
  // s3：v0.2.0 把配置键从 requireEvidenceForPass 改为 requireChecksForPass
  //（lib/index.js:208 默认值、:220-223 读取；handlers.js:631 用它做 pass 前置）。
  // 旧键仍能被忽略而不报错，所以这里同时断言旧键不再被采纳。
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), "mentor-config-"));
  const { out } = await setup({ stateDir, requireChecksForPass: false });
  t.after(async () => { await out(); await fs.rm(stateDir, { recursive: true, force: true }); });
  assert.equal(out.config.stateDir, stateDir);
  assert.equal(out.config.requireChecksForPass, false);
  // readOnlyToolsDuringPlanning 已移除：配了但没有任何拦截实现，留着会误导使用者以为有防护
  assert.equal("readOnlyToolsDuringPlanning" in out.config, false);
});

test("selfCheckOnLoad 未开启时不返回 selfCheck 结果", async () => {
  const { out } = await setup();
  assert.equal(out.selfCheck, null);
});

test("selfCheckOnLoad 开启时经已注册工具的 execute 跑闭环", async () => {
  const { out } = await setup({ selfCheckOnLoad: true, allowDebugSeeds: true });
  assert.ok(out.selfCheck, "应返回 selfCheck 结果");
  assert.equal(out.selfCheck.ok, true);
  assert.equal(out.selfCheck.viaRegisteredTools, true);
  assert.equal(out.selfCheck.toolCount, TOOL_NAMES.length);
});

/* ------------------------------------------------------------------ *
 * 自动审查接线（c1）：起 reviewer 子会话，失败必须降级而非静默卡住
 * ------------------------------------------------------------------ */

const TASK_STUB = { id: "task-stub", revision: 1, criteria: [], stages: [], nodeRuns: [], planVersion: 0 };

test("spawnReviewer：宿主没有 ctx.agents 时返回 queued:false，不抛异常", async () => {
  const store = createMemoryStore(TASK_STUB);
  const r = await spawnReviewer({}, store, { agent: { session: {} } }, { stageId: "s1", attempt: 1 });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "host-agents-unavailable");
});

test("spawnReviewer：没有活跃 agent 时返回 queued:false/no-live-agent", async () => {
  const store = createMemoryStore(TASK_STUB);
  const agents = { create: async () => ({ agent: {} }) };
  const r = await spawnReviewer({ agents }, store, {}, { stageId: "s1", attempt: 1 });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no-live-agent");
});

test("spawnReviewer：没有任务时返回 queued:false/no-task", async () => {
  const store = createMemoryStore(null);
  const agents = { create: async () => ({ agent: {} }) };
  const r = await spawnReviewer({ agents }, store, { agent: { session: {} } }, { stageId: "s1", attempt: 1 });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "no-task");
});

test("spawnReviewer：正常路径创建子会话、投递审查 prompt，返回 reviewerSessionId", async () => {
  const store = createMemoryStore(TASK_STUB);
  let createdArgs = null;
  let followupMsg = null;
  const agents = {
    create: async (args) => {
      createdArgs = args;
      return {
        agent: {
          session: { append() {}, snapshotEvents: () => [], inheritedEventCount: 0, header: {} },
          followup: (m) => {
            followupMsg = m;
          },
        },
      };
    },
  };
  const exec = { agent: { session: { header: { delegationDepth: 0 } }, options: { provider: "test-provider", model: "test-model" } } };
  const r = await spawnReviewer({ agents }, store, exec, { stageId: "s1", attempt: 2 });

  assert.equal(r.queued, true);
  assert.match(r.reviewerSessionId, /^mentor-review-[0-9a-f-]{36}$/);
  assert.equal(createdArgs.sessionId, r.reviewerSessionId);
  assert.ok(createdArgs.parentAgent, "必须把主 agent 作为 parentAgent 传入");
  // prompt 里要能看出被审对象与必须调用 review_apply
  const text = followupMsg.content[0].text;
  assert.match(text, /task-stub/);
  assert.match(text, /"stageId":"s1"/, "被审阶段应以绑定参数形式出现");
  // s3：v0.2.0 的 prompt 改成给 JSON 绑定参数（review_apply 现在要求 reviewJobId/kind/attempt 成套绑定），
  // 旧的 `attempt 2` 自由文本写法已不存在，对应的是 JSON 里的 "attempt":2。
  assert.match(text, /"attempt":2/, "attempt 应出现在绑定参数里");
  assert.match(text, /mentor_review_apply/);
  assert.equal(followupMsg.source.kind, "dsh-mentor-review");
});

test("spawnReviewer：agents.create 抛错时降级并带回 reason", async () => {
  const store = createMemoryStore(TASK_STUB);
  const agents = {
    create: async () => {
      throw new Error("boom");
    },
  };
  const exec = { agent: { session: { header: {} }, options: { provider: "test-provider", model: "test-model" } } };
  const r = await spawnReviewer({ agents }, store, exec, { stageId: "s1", attempt: 1 });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "boom");
});
test("mentor_finding_close 不向模型开放，整改项只能靠 pass 复核关闭", () => {
  // s3：v0.2.0 反过来了 —— 这里原来断言 finding_close 在 TOOL_NAMES 里（P1-3 的旧契约），
  // 但 lib/index.js:468 现在显式 `delete TOOLS.mentor_finding_close`，
  // README:24 写明「没有向模型开放强制关闭整改项的工具」：整改项只能由后续 pass 审查
  // 显式 markedResolved 复核关闭，模型不能自己宣告解决。
  //
  // 用户侧的强制出口仍然存在，只是不在工具表里：
  //   src/review/review.js:306 forceCloseFinding()，由 HANDLERS.mentor_finding_close 暴露。
  assert.ok(!TOOL_NAMES.includes("mentor_finding_close"), "强制关闭不得作为工具暴露给模型");
  assert.ok(TOOL_NAMES.includes("mentor_finding_respond"), "响应入口必须保留");
  assert.equal(typeof HANDLERS.mentor_finding_close, "function", "用户侧强制关闭的 handler 仍应存在");
});
/* ------------------------------------------------------------------ *
 * s2：失败可见性与持久化（P0-1 / P1-7 / P1-1）
 * ------------------------------------------------------------------ */

test("createPersistentStore：写盘失败时把 lastPersistError 写进内存 task（P1-7）", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mentor-persist-"));

  let store;
  try {
    store = createPersistentStore(tmp, null);
    // writeState 要求 revision 是数字；故意不给，制造一次确定的写盘失败
    store.set({ id: "t-bad", revision: undefined });
    await store.flush();

    const cur = store.get();
    assert.ok(cur.lastPersistError, "写盘失败必须落到 task 可读字段上，不能只写 stderr");
    assert.match(cur.lastPersistError.message, /revision/);
    assert.equal(typeof cur.lastPersistError.at, "number");
  } finally {
    await store?.drain();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("createPersistentStore：启动错误合并到第一个写入的 task，之后不再重复（P1-1）", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mentor-startup-"));

  let store;
  try {
    const startupError = { kind: "corrupt", message: "形状不对", quarantinedTo: null, at: 1 };
    store = createPersistentStore(tmp, null, startupError);

    store.set({ id: "t1", revision: 1 });
    assert.deepEqual(store.get().lastStateError, startupError, "首个 task 必须带上启动错误");

    store.set({ id: "t1", revision: 2 });
    assert.equal(store.get().lastStateError, undefined, "启动错误只挂一次");
  } finally {
    await store?.drain();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("createStore：state 文件是合法 JSON 但形状不对时隔离并留启动错误（P1-1）", async () => {
  const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mentor-corrupt-"));

  let store;
  try {
    // 用户手写 {} 想重置任务，这是台账里最现实的触发场景
    await writeFile(path.join(tmp, "mentor-task.json"), "{}", "utf8");

    store = await createStore(tmp);
    assert.equal(store.get(), null, "形状不对不能当任务加载");

    const raw = await readFile(path.join(tmp, "mentor-startup-error.json"), "utf8");
    const e = JSON.parse(raw);
    assert.equal(e.kind, "corrupt");
    assert.ok(e.message.length > 0);

    store.set({ id: "t-new", revision: 1 });
    assert.ok(store.get().lastStateError, "新 task 也要能看到启动错误");
  } finally {
    await store?.drain();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("spawnReviewer：失败原因写进 task.reviewDispatches，不再只活在返回体（P0-1）", async () => {
  const store = createMemoryStore({ id: "task-d", revision: 1, criteria: [], stages: [], nodeRuns: [], planVersion: 0 });
  const r = await spawnReviewer({}, store, { agent: { session: {} } }, { stageId: "s1", attempt: 2 });

  assert.equal(r.queued, false);
  const log = store.get().reviewDispatches;
  assert.ok(Array.isArray(log) && log.length === 1, "必须留一条派发记录");
  assert.equal(log[0].queued, false);
  assert.equal(log[0].reason, "host-agents-unavailable");
  assert.equal(log[0].stageId, "s1");
  assert.equal(log[0].attempt, 2);
});

test("spawnReviewer：成功派发也留记录，带 reviewerSessionId（P0-1）", async () => {
  const store = createMemoryStore({ id: "task-d2", revision: 1, criteria: [], stages: [], nodeRuns: [], planVersion: 0 });
  const agents = {
    create: async () => ({
      agent: {
        session: { append() {}, snapshotEvents: () => [], inheritedEventCount: 0, header: {} },
        followup: () => {},
      },
    }),
  };
  const exec = { agent: { session: { header: {} }, options: { provider: "p", model: "m" } } };
  const r = await spawnReviewer({ agents }, store, exec, { stageId: "s1", attempt: 1 });

  assert.equal(r.queued, true);
  const log = store.get().reviewDispatches;
  // 断言方向修正（2026-11-08）：
  //   mock 的 agent 不会真的产出审查裁决，所以 lib/index.js:624-649 的后台监控任务
  //   会立刻判定「未完成」，并补写一条 status:"failed" 的记录（queued:false）。
  //   旧断言取「最后一条」必然是那条 failed，等于在验证 mock 环境不会发生的事。
  //   真正要防的是「成功派发没留下可追溯的记录」，所以改成：存在一条 queued:true
  //   且 reviewerSessionId 能对上本次派发的记录。
  assert.ok(log.length >= 1, "成功派发必须留记录");
  assert.ok(
    log.some((x) => x.queued === true && x.reviewerSessionId === r.reviewerSessionId),
    "记录里要有成功的派发条目并对得上 reviewer 会话",
  );
});
/* ------------------------------------------------------------------ *
 * s2 补：P0-1 运行期失败（followup 拒绝 / 超时）
 * ------------------------------------------------------------------ */

test("spawnReviewer：followup 拒绝时把运行期失败写进 reviewDispatches（P0-1 运行期）", async () => {
  const store = createMemoryStore({ id: "task-rt", revision: 1, criteria: [], stages: [], nodeRuns: [], planVersion: 0 });
  const agents = {
    create: async () => ({
      agent: {
        session: { append() {}, snapshotEvents: () => [], inheritedEventCount: 0, header: {} },
        followup: () => Promise.reject(new Error("session is closed")),
      },
    }),
  };
  const exec = { agent: { session: { header: {} }, options: { provider: "p", model: "m" } } };
  const r = await spawnReviewer({ agents }, store, exec, { stageId: "s1", attempt: 1 });

  assert.equal(r.queued, false, "followup 拒绝不能报成功");
  // v0.2.0：派发失败的 reason 直接就是底层错误消息（lib/index.js:581-585 的 fail()），
  // 不再拼 "followup-failed:" 前缀 —— 「这次派发失败了」由 queued/status 字段表达。
  assert.match(r.reason, /session is closed/);

  const log = store.get().reviewDispatches;
  // v0.2.0：reviewDispatches 是「派发状态机逐跳留痕」（lib/index.js:1101-1111 ——
  // 每次 updateRuntimeReview 都追加一条），所以一次失败派发会留下 queued → running → failed。
  // 旧断言「1 次派发 = 1 条」取的是 v0.1.x 语义。
  assert.ok(log.length >= 1, "运行期失败必须留记录");
  const last = log.at(-1);
  assert.equal(last.queued, false, "最后一条必须是失败态");
  assert.match(last.reason, /session is closed/, "原始错误信息必须保留");
  assert.ok(last.reviewerSessionId, "失败时也要能定位是哪个会话");
  assert.equal(
    log.filter((x) => x.queued === false).length,
    1,
    "失败只记一次，不能每跳都算失败",
  );
  assert.ok(
    log.some((x) => x.queued === true),
    "前面应有「已受理 / 已在跑」的轨迹，证明不是静默失败",
  );
});

test("withFollowupTimeout：void/已 resolve 直接通过，挂死会按超时拒绝", async () => {
  await withFollowupTimeout(undefined, 50);
  await withFollowupTimeout(null, 50);
  await withFollowupTimeout(Promise.resolve("ok"), 50);
  await assert.rejects(() => withFollowupTimeout(new Promise(() => {}), 30), /超时/);
});
/* ------------------------------------------------------------------ *
 * s2：运维守卫（P2-5）+ lastReviewer 生命周期（P2-2）
 * ------------------------------------------------------------------ */

test("selfCheckOnLoad 未声明 allowDebugSeeds 时被忽略（P2-5）", async () => {
  const { out } = await setup({ selfCheckOnLoad: true });

  assert.equal(
    out.selfCheck,
    null,
    "没有 allowDebugSeeds 时 selfCheckOnLoad 必须被忽略，不能在生产里跑闭环覆盖任务",
  );
  if (typeof out === "function") out();
});

test("withReviewerTracking：新 review 入库时清空 lastReviewer（P2-2）", () => {
  const mem = createMemoryStore({
    id: "t-lr", revision: 1, reviews: [],
    lastReviewer: { sessionId: "mentor-review-abc", stageId: "s1", attempt: 1, at: 1 },
  });
  const store = withReviewerTracking(mem);

  assert.equal(store.get().lastReviewer.sessionId, "mentor-review-abc");

  // 普通写入不清空
  store.set({ ...store.get(), revision: 2 });
  assert.ok(store.get().lastReviewer, "没有新 review 时不能清");

  // 审查结果入库 → 清空。
  // v0.2.0 的清空条件（lib/index.js:114-120）：review.scope 的 stageId + attempt
  // 必须与 lastReviewer 的 stageId + attempt 对上，且 review.at 不早于 pending.at ——
  // 否则「别的阶段审查完了」会把当前阶段的在途审查者抹掉。
  store.set({
    ...store.get(),
    revision: 3,
    reviews: [{ id: "r1", verdict: "pass", scope: { kind: "stage", stageId: "s1", attempt: 1 }, at: 2 }],
  });
  assert.equal(store.get().lastReviewer, null, "本阶段本尝试的审查入库即视为完成，必须清空");
  // 清空是持久的：再来一次普通写入也不能自己长回来
  store.set({ ...store.get(), revision: 4 });
  assert.equal(store.get().lastReviewer, null, "清空后普通写入不能复活 lastReviewer");
});
test("withReviewerTracking：审查入库后的后续写入不能把 lastReviewer 带回来（P2-2 真机缺陷）", () => {
  const mem = createMemoryStore({
    id: "t-lr2", revision: 1, reviews: [],
    lastReviewer: { sessionId: "mentor-review-xyz", stageId: "s1", attempt: 1, at: 1 },
  });
  const store = withReviewerTracking(mem);

  // 第一写：review 入库（模拟 applyReview）—— review 要带 scope + at，
  // 否则按 v0.2.0 的条件（lib/index.js:114-120）它不构成「本阶段这次尝试的结论」。
  store.set({
    ...store.get(),
    revision: 2,
    reviews: [{ id: "r1", verdict: "revise", scope: { kind: "stage", stageId: "s1", attempt: 1 }, at: 2 }],
  });
  assert.equal(store.get().lastReviewer, null, "第一次写就该清空");

  // 第二写：从**仍带旧字段**的原对象派生（模拟 reviewApply 里的 transition）
  const stale = {
    id: "t-lr2", revision: 3,
    reviews: [{ id: "r1", verdict: "revise", scope: { kind: "stage", stageId: "s1", attempt: 1 }, at: 2 }],
    lastReviewer: { sessionId: "mentor-review-xyz", stageId: "s1", attempt: 1, at: 1 },
  };
  store.set(stale);
  assert.equal(store.get().lastReviewer, null, "第二次写不能把 lastReviewer 带回来");
});
/* ------------------------------------------------------------------ *
 * P3-1：recordObservation 并发写不能丢条
 *
 * 每次显式注入独立文件路径，不读取或写入共享观测记录。
 * ------------------------------------------------------------------ */

test("recordObservation：并发调用不丢条（P3-1）", async (t) => {
  const { recordObservation } = await import("../lib/index.js");
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await fs.mkdtemp(path.join(tmpdir(), "mentor-observation-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "mentor-observation.json");
  const tag = "concurrent-";

  // 十次并发写入，每次带不同的 rpcId 便于核对
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      recordObservation({
        kind: "selfcheck",
        rpcId: tag + i,
        clientSha: "sha-" + i,
        startedAt: Date.now(),
      }, file),
    ),
  );

  const payload = JSON.parse(await fs.readFile(file, "utf8"));

  assert.equal(payload.reportCount, 10);
  assert.equal(payload.reports.length, 10);
  const ids = payload.reports.map((r) => r.rpcId).filter((x) => String(x).startsWith(tag));
  assert.equal(ids.length, 10, "十次并发必须十条，不能互相覆盖");
  assert.equal(new Set(ids).size, 10, "不能有重复/丢失");
});
