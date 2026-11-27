/**
 * 控制接口的行为测试（s2 审查要求的那条「真实工具链」断言）。
 *
 * 审查原话：
 *   「补一条 create(requireApproval:true)→plan_submit→awaiting-approval→approve 的断言，
 *     通过条件：该断言全绿（approve 可达、off 下被拒、planning pause/resume 成功、
 *     active nextStep=EXECUTE），且 rpc 分派能命中六个工具名。」
 *
 * 这里逐个钉死。全部走 HANDLERS 表（也就是真实工具链入口），
 * 不直接调 transition，避免「代码里有但工具调不到」的假通过。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import { buildStatePayload } from "../src/rpc/state.js";
import { COMMAND_ACTIONS, dispatchCommand } from "../src/rpc/command.js";
import { TOOL_NAMES } from "../lib/index.js";
import { MentorError, ERR } from "../src/errors.js";
import { PHASES } from "../src/state/machine.js";
import { gatedReport, toPhase } from "./support/fixtures.mjs";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const call = (store, name, params = {}) => {
  // 2026-11-09：mentor_stage_report 现在只有一条入口（门禁版），
  // 测试统一走 gatedReport 补 planVersion/evidenceRefs，其余工具原样派发。
  if (name === "mentor_stage_report") return gatedReport(store, params);
  const fn = HANDLERS[name];
  assert.equal(typeof fn, "function", `${name} 必须在 HANDLERS 里`);
  return fn(store, params);
};

const STAGES = [
  { id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] },
  { id: "s2", title: "二", criterionIds: ["c1"], dependsOn: ["s1"] },
];
const CRITERIA = [{ id: "c1", text: "有产出" }];

function newTask(extra = {}) {
  const store = createMemoryStore();
  const r = call(store, "mentor_task_create", { workspaceRoot: ROOT,
    objective: "控制接口行为测试",
    userMessageSeq: 1,
    ...extra,
  });
  assert.equal(r.ok, true, "建任务应成功");
  return store;
}

/* ---------------- 1. approve 可达（审查的核心缺口） ---------------- */

test("C1 create(requireApproval:true) → plan_submit 停在 awaiting-approval → approve 进入 active", () => {
  const store = newTask({ requireApproval: true });

  // requireApproval 必须真的落到任务对象上（上一轮它没落，导致 approve 不可达）
  assert.equal(store.get().requireApproval, true, "requireApproval 必须持久化到任务");

  const submitted = call(store, "mentor_plan_submit", {
    criteria: CRITERIA,
    stages: STAGES,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.value.phase, PHASES.AWAITING_APPROVAL, "要求批准时必须停在 awaiting-approval");
  assert.equal(submitted.value.requiresApproval, true);
  assert.ok(submitted.value.planVersion >= 1, "此刻已有可批准的 planVersion");

  const approved = call(store, "mentor_task_approve", {
    planVersion: submitted.value.planVersion,
  });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.value.phase, PHASES.ACTIVE);
  assert.equal(approved.value.approvedPlanVersion, submitted.value.planVersion);

  // 幂等
  const again = call(store, "mentor_task_approve", {});
  assert.equal(again.ok, true);
  assert.equal(again.value.duplicate, true, "同一版计划重复批准应幂等");
});

test("C2 缺省 requireApproval 时自动批准，一步到 active（向后兼容）", () => {
  const store = newTask();
  assert.equal(store.get().requireApproval, false);
  const submitted = call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  assert.equal(submitted.value.phase, PHASES.ACTIVE, "默认路径保持原行为");
  assert.equal(submitted.value.requiresApproval, false);
  // 已 active 且已批准 → approve 幂等
  const ap = call(store, "mentor_task_approve", {});
  assert.equal(ap.ok, true);
  assert.equal(ap.value.duplicate, true);
});

test("C3 非 awaiting-approval 阶段 approve 明确报错，不改状态", () => {
  const store = newTask({ requireApproval: true });
  // 还在 planning（计划都没提交）
  const r = call(store, "mentor_task_approve", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_ILLEGAL_TRANSITION");
  assert.equal(store.get().phase, PHASES.PLANNING, "报错时不许改状态");
  assert.ok(Array.isArray(r.details.allowed), "错误里要带允许集合");
});

/* ---------------- 2. off 拦住 approve（c4） ---------------- */

test("C4 关闭导师后 approve 被拒绝，不允许绕过 off 直接转 active", () => {
  const store = newTask({ requireApproval: true });
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  assert.equal(store.get().phase, PHASES.AWAITING_APPROVAL);

  const off = call(store, "mentor_task_off", {});
  assert.equal(off.ok, true);
  assert.equal(store.get().enabled, false);

  const ap = call(store, "mentor_task_approve", {});
  assert.equal(ap.ok, false, "off 之后不许批准");
  assert.equal(ap.details.reason, "SUPERVISOR_DISABLED");
  assert.equal(store.get().phase, PHASES.AWAITING_APPROVAL, "状态不许被改");

  // 重新启用后能批准
  assert.equal(call(store, "mentor_task_on", {}).ok, true);
  assert.equal(call(store, "mentor_task_approve", {}).ok, true);
  assert.equal(store.get().phase, PHASES.ACTIVE);
});

/* ---------------- 3. planning 也能 pause / resume（c5） ---------------- */

test("C5 planning 阶段可以 pause 再 resume，且精确回到 planning", () => {
  const store = newTask();
  assert.equal(store.get().phase, PHASES.PLANNING);

  const paused = call(store, "mentor_task_pause", { reason: "user" });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(paused.value.phase, PHASES.PAUSED);
  assert.equal(paused.value.prePausePhase, PHASES.PLANNING, "要记住暂停前的状态");

  const resumed = call(store, "mentor_task_resume", {});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.value.phase, PHASES.PLANNING, "回到 planning 而不是 active");
});

test("C6 reviewing 期间暂停后 resume 回到 reviewing（不是一律回 active）", () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  call(store, "mentor_stage_report", {
    stageId: "s1",
    attempt: 1,
    evidence: "s1 的证据内容，足够长以便通过校验",
  });
  assert.equal(store.get().phase, PHASES.REVIEWING, "上报后应进入 reviewing");

  const paused = call(store, "mentor_task_pause", {});
  assert.equal(paused.ok, true);
  assert.equal(paused.value.prePausePhase, PHASES.REVIEWING);

  const resumed = call(store, "mentor_task_resume", {});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.value.phase, PHASES.REVIEWING, "必须回 reviewing，不能一律回 active");
});

/* ---------------- 4. active 的 nextStep 必须是 EXECUTE ---------------- */

test("C7 active 且有就绪节点时 nextStep.code === EXECUTE（不是 NO_READY_NODE）", () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  const task = store.get();
  assert.equal(task.phase, PHASES.ACTIVE);

  const payload = buildStatePayload(task);
  assert.equal(payload.nextStep.code, "EXECUTE", "有就绪节点就该报 EXECUTE");
  assert.match(payload.nextStep.text, /s1/, "要指出哪些节点可推进");
  assert.ok(payload.readyNodes.includes("s1"));
  assert.ok(!payload.readyNodes.includes("s2"), "s2 依赖 s1，此刻不该就绪");
});

/* ---------------- 5. 暂停后写操作真的被拦 ---------------- */

test("C8 暂停期间 stage_report / plan_amend 被拒绝（不只是改了状态）", () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  call(store, "mentor_task_pause", {});

  const report = call(store, "mentor_stage_report", {
    stageId: "s1",
    attempt: 1,
    evidence: "暂停期间不应被接受的证据内容",
  });
  assert.equal(report.ok, false, "暂停期间不许上报证据");
  assert.equal(report.details.reason, "TASK_PAUSED");

  const amend = call(store, "mentor_plan_amend", { reason: "改一下" });
  assert.equal(amend.ok, false, "暂停期间不许改计划");
});

/* ---------------- 6. clear 能归档任何状态（含 completed） ---------------- */

test("C9 clear 能归档已完成任务，并保留记录", () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  const taskId = store.get().id;
  // 手工推到 completed：phase 变更必须走合法边（2026-11-09 单一写入口）
  toPhase(store, PHASES.COMPLETED);

  const cleared = call(store, "mentor_task_clear", { reason: "收尾" });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.value.phase, PHASES.ARCHIVED);
  assert.ok(cleared.value.archivedAt > 0);
  assert.equal(store.get().id, taskId, "记录保留，不是删除");
  assert.equal(store.get().archivedReason, "收尾");

  // 幂等
  const again = call(store, "mentor_task_clear", {});
  assert.equal(again.ok, true);
  assert.equal(again.value.duplicate, true);

  // 归档后状态条该消失：nextStep 指向新建任务
  const payload = buildStatePayload(store.get());
  assert.equal(payload.nextStep.code, "WORKFLOW_ARCHIVED");
  assert.equal(payload.live, false);
});

/* ---------------- 7. rpc 分派能命中六个工具名（审查要求） ---------------- */

test("C10 六个控制接口都在 TOOL_NAMES 与 HANDLERS 里，名字一致", () => {
  const six = [
    "mentor_task_approve",
    "mentor_task_pause",
    "mentor_task_resume",
    "mentor_task_clear",
    "mentor_task_off",
    "mentor_task_on",
  ];
  for (const name of six) {
    assert.ok(TOOL_NAMES.includes(name), `${name} 必须在已注册工具里（服务端才会暴露）`);
    assert.equal(typeof HANDLERS[name], "function", `${name} 必须能分派到 handler`);
  }
  // 反向：HANDLERS 与 TOOL_NAMES 不是一一对应，v0.2.0 有两类明确边界。
  // 用「集合相等」钉住，新增遗漏会立刻红：
  //  A. 只留 handler、不暴露给模型：
  //     mentor_finding_close —— lib/index.js:468 显式 delete TOOLS，
  //                            README:24「整改只能由审查复核关闭，模型不许自己关」
  //     mentor_delegate_complete —— 内部收尾调用（lib/index.js:814），模型不该直接调
  //  B. 只暴露工具、实现在 runAction 内联（要拿 ctx.agents / 主会话句柄，
  //     塞进纯函数 HANDLERS 表就拿不到了）：lib/index.js:679/685/686
  const HANDLER_ONLY = ["mentor_delegate_complete", "mentor_finding_close"];
  const INLINE_ONLY = [
    "mentor_review_retry", "mentor_task_continue", "mentor_workspace_set",
    "mentor_verify_review_recovery", "mentor_work_mode", "mentor_team_start", "mentor_team_context",
    "mentor_team_direction", "mentor_team_note",
  ];
  assert.deepEqual(
    Object.keys(HANDLERS)
      .filter((k) => !TOOL_NAMES.includes(k))
      .sort(),
    HANDLER_ONLY.slice().sort(),
    "HANDLERS 里没工具定义的键，必须正好是这些内部 handler",
  );
  assert.deepEqual(
    TOOL_NAMES.filter((n) => !Object.keys(HANDLERS).includes(n)).sort(),
    INLINE_ONLY.slice().sort(),
    "TOOL_NAMES 里没 HANDLERS 的键，必须正好是这些内联实现",
  );
  // 被移除的只是「工具定义」，handler 本体必须还在（review_apply 复核关闭时要用）
  assert.equal(typeof HANDLERS.mentor_finding_close, "function", "handler 仍要保留");
});

/* ---------------- 8. rpc 分派端到端（s3 审查要求的） ---------------- */

test("C11 dispatchCommand 能按 action 命中六个工具并返回统一形状", async () => {
  const six = [
    "mentor_task_approve",
    "mentor_task_pause",
    "mentor_task_resume",
    "mentor_task_clear",
    "mentor_task_off",
    "mentor_task_on",
  ];
  for (const name of six) {
    assert.ok(
      COMMAND_ACTIONS.includes(name),
      `${name} 必须在 COMMAND_ACTIONS 里（UI 才知道能调什么）`,
    );
    // 每个都能真的分派到（结果成败不重要，重要的是不是 E_UNKNOWN_ACTION）
    const store = createMemoryStore();
    call(store, "mentor_task_create", { workspaceRoot: ROOT, objective: "分派测试" });
    const r = await dispatchCommand(store, { action: name, params: {} });
    assert.notEqual(
      r.error && r.error.code,
      "E_UNKNOWN_ACTION",
      `${name} 必须能被 dispatchCommand 命中`,
    );
    assert.equal(typeof r.ok, "boolean", `${name} 的返回必须是 {ok:...} 形状`);
  }
});

test("C12 dispatchCommand 对未知 action 明确报 E_UNKNOWN_ACTION 并列出已知动作", async () => {
  const store = createMemoryStore();
  const r = await dispatchCommand(store, { action: "mentor_task_nuke", params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "E_UNKNOWN_ACTION");
  assert.ok(Array.isArray(r.error.details.known), "要告诉调用方有哪些可用动作");
  assert.ok(r.error.details.known.includes("mentor_task_clear"));

  // 空 action 也不许静默返回状态
  const empty = await dispatchCommand(store, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "E_UNKNOWN_ACTION");
});

test("C13 dispatchCommand 把 handler 的业务错误原样透出（不吞成 E_INTERNAL）", async () => {
  const store = newTask();
  const t = store.get();
  // v0.2.0：dispatchCommand 有三道前置（src/rpc/command.js:7-9）：
  //   unknown action → stale task（params.taskId 必须等于当前任务 id）
  //   → stale revision（params.revision 必须等于 task.revision）。
  // UI 按钮发的就是这两个字段（lib/client.js:1870 传 taskId + revision），
  // 测试按同一契约调用，才能走到业务错误那一层。
  // 计划都没提交就 approve，应拿到 ILLEGAL_TRANSITION 而不是内部错误。
  const r = await dispatchCommand(store, {
    action: "mentor_task_approve",
    params: { taskId: t.id, revision: t.revision },
  });
  assert.equal(r.ok, false);
  assert.equal(
    r.error.code,
    "E_ILLEGAL_TRANSITION",
    "业务错误原样透出，不吞成 E_INTERNAL / E_CONTROL_FAILED",
  );
  assert.match(
    String(r.error.message),
    /只有 awaiting-approval 阶段能批准计划/,
    "错误信息要能直接看懂卡在哪一步：" + r.error.message,
  );
  // RPC 与工具通道保持相同的结构化业务错误。
  assert.equal(r.error.details.phase, "planning");
  const direct = call(store, "mentor_task_approve", {});
  assert.equal(direct.ok, false);
  assert.equal(direct.code, "E_ILLEGAL_TRANSITION");
  assert.deepEqual(r.error.details, direct.details);
  assert.equal(direct.details.phase, "planning", "details 要带出当前阶段");
  assert.ok(
    Array.isArray(direct.details.allowed) && direct.details.allowed.includes("awaiting-approval"),
    "details.allowed 要列出可用阶段",
  );
});

test("C14 dispatchCommand 走 clear 后，状态快照变成 non-live（UI 收不到 live 就藏条）", async () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });

  const before = buildStatePayload(store.get());
  assert.equal(before.live, true, "归档前是 live");

  const t = store.get();
  const r = await dispatchCommand(store, {
    action: "mentor_task_clear",
    params: { taskId: t.id, revision: t.revision, reason: "ui-click" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const after = buildStatePayload(store.get());
  assert.equal(after.phase, "archived");
  assert.equal(after.live, false, "归档后必须 non-live —— 状态条据此隐藏");
  assert.equal(after.nextStep.code, "WORKFLOW_ARCHIVED");
});

test("C15 dispatchCommand 走 off 后也是 non-live（状态条同样该隐藏）", async () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  const t = store.get();
  const r = await dispatchCommand(store, {
    action: "mentor_task_off",
    params: { taskId: t.id, revision: t.revision },
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const payload = buildStatePayload(store.get());
  assert.equal(payload.enabled, false);
  assert.equal(payload.live, false, "off 后必须 non-live");
  // 任务记录仍在
  assert.ok(payload.taskId);
  assert.equal(payload.phase, "active", "off 只关开关，phase 不动");
});

test("C16 clear 之后能立刻建新任务（归档不许把导师锁死）", () => {
  // s4 审查的核心 gap：taskClear 把任务置 archived 后仍留在 store，
  // 而 taskCreate 只放行 completed —— 用户点完 Clear 就既没有 live 任务、
  // 又建不了新任务，只能手删状态文件。clear → create 必须通。
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });

  const archivedId = store.get().id;
  const cleared = call(store, "mentor_task_clear", { reason: "ui-click" });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(store.get().phase, "archived");

  // 归档后立刻建新任务
  const created = call(store, "mentor_task_create", { workspaceRoot: ROOT,
    objective: "归档之后的新任务",
    userMessageSeq: 9,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.ok(created.value.taskId, "必须返回新 taskId");
  assert.notEqual(created.value.taskId, archivedId, "必须是一个新任务，不是复用作废的");
  assert.equal(created.value.replacedTaskId, archivedId, "要告知替换了哪个旧任务");
  assert.equal(store.get().phase, PHASES.PLANNING, "新任务从 planning 开始");
  assert.equal(store.get().id, created.value.taskId);
});

test("C17 completed 也能被新任务替换（保持原有行为）", () => {
  const store = newTask();
  const taskId = store.get().id;
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  toPhase(store, PHASES.COMPLETED);

  const created = call(store, "mentor_task_create", { workspaceRoot: ROOT, objective: "做完之后再开一个" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.replacedTaskId, taskId);
});

test("C18 进行中的任务仍然不许被静默覆盖", () => {
  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  assert.equal(store.get().phase, PHASES.ACTIVE);

  const created = call(store, "mentor_task_create", { workspaceRoot: ROOT, objective: "想覆盖进行中的" });
  assert.equal(created.ok, false, "进行中的任务不能被静默覆盖");
  assert.equal(created.code, "E_TASK_EXISTS");
  assert.equal(store.get().phase, PHASES.ACTIVE, "旧任务必须还在");
});

test("C19 RPC stale task/revision details include expected and current identities", async () => {
  const store = newTask(), task = store.get(), action = "mentor_task_pause";
  const stale = await dispatchCommand(store, { action, params: { taskId: "old" } });
  assert.equal(stale.error.code, "E_STALE_TASK");
  assert.deepEqual(stale.error.details, { expectedTaskId: "old", currentTaskId: task.id });
  const missing = await dispatchCommand(createMemoryStore(), { action, params: { taskId: "old" } });
  assert.deepEqual(missing.error.details, { expectedTaskId: "old", currentTaskId: null });
  const revision = await dispatchCommand(store, { action, params: { taskId: task.id, revision: task.revision - 1 } });
  assert.equal(revision.error.code, "E_STALE_REVISION");
  assert.deepEqual(revision.error.details, {
    taskId: task.id, expectedRevision: task.revision - 1, currentRevision: task.revision,
  });
  assert.equal(store.get(), task);
});

test("C20 RPC preserves thrown MentorError details and omits absent handler details", async () => {
  const store = newTask(), task = store.get();
  const payload = { action: "mentor_task_pause", params: { taskId: task.id, revision: task.revision } };
  const details = { phase: task.phase, context: { revision: task.revision } };
  const result = await dispatchCommand(store, payload, () => { throw new MentorError(ERR.TASK_INACTIVE, "blocked", details); });
  assert.deepEqual(result.error, { code: ERR.TASK_INACTIVE, message: "blocked", details });
  const plain = await dispatchCommand(store, payload, () => ({ ok: false, code: "E_FIXTURE", message: "plain" }));
  assert.deepEqual(plain.error, { code: "E_FIXTURE", message: "plain" });
});

test("C21 RPC 支持人工关闭 mentor_finding_close（带理由），且仍不暴露给模型工具表", async () => {
  assert.ok(COMMAND_ACTIONS.includes("mentor_finding_close"), "UI 控制通道应包含 mentor_finding_close");
  assert.ok(!TOOL_NAMES.includes("mentor_finding_close"), "模型工具表严禁暴露 mentor_finding_close");

  const store = newTask();
  call(store, "mentor_plan_submit", { criteria: CRITERIA, stages: STAGES });
  const withFinding = {
    ...store.get(),
    findings: [{ id: "f-ui-1", stageId: "s1", severity: "blocking", status: "open", text: "待核对" }],
  };
  store.set(withFinding);

  const r = await dispatchCommand(store, {
    action: "mentor_finding_close",
    params: { taskId: withFinding.id, revision: withFinding.revision, findingId: "f-ui-1", reason: "人工复核已满足" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(store.get().findings[0].status, "closed");
  assert.equal(store.get().findings[0].closeReason, "人工复核已满足");
});
