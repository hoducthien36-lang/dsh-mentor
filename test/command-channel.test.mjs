/**
 * slash 命令通道测试（改造 s2-a）。
 *
 * 要钉死三件事：
 *   1. 每个动词都真的落到 HANDLERS，不存在「命令能干、工具不能干」的分叉
 *   2. 未识别的子命令报错并列可用动词，**不静默建任务**
 *   3. status 摘要在无任务 / 有任务 / 归档后三种形态下都可读
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HANDLERS, createMemoryStore } from "../src/tools/handlers.js";
import {
  MENTOR_VERBS,
  helpText,
  parseMentorCommand,
  runMentorCommand,
} from "../src/commands/channel.js";
import { PHASES } from "../src/state/machine.js";
import path from "node:path";
/** s3：v0.2.0 起 mentor_task_create 要求显式 workspaceRoot（证据校验用它做路径逃逸边界）。 */
const ROOT = path.resolve(import.meta.dirname, "..");

const CRITERIA = [{ id: "c1", text: "有产出" }];
const STAGES = [{ id: "s1", title: "一", criterionIds: ["c1"], dependsOn: [] }];

/** 建一个 active 的任务（可直接推进节点） */
function activeStore({ requireApproval = false } = {}) {
  const store = createMemoryStore();
  assert.equal(HANDLERS.mentor_task_create(store, { workspaceRoot: ROOT, objective: "命令通道测试", requireApproval }).ok, true);
  const submitted = HANDLERS.mentor_plan_submit(store, { criteria: CRITERIA, stages: STAGES });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (requireApproval) {
    assert.equal(HANDLERS.mentor_task_approve(store, {}).ok, true);
  }
  return store;
}

/* ---------------- 1. 解析 ---------------- */

test("M1 空输入等同 status；help 三种写法都识别", () => {
  for (const raw of ["", "   "]) {
    const p = parseMentorCommand(raw);
    assert.equal(p.verb, "status");
    assert.equal(p.action, "mentor_task_status");
    assert.equal(p.error, null);
  }
  for (const raw of ["help", "-h", "--help", "?"]) {
    const p = parseMentorCommand(raw);
    assert.equal(p.verb, "help");
    assert.equal(p.action, null);
  }
});

test("M2 未识别子命令报错，不把整句当 objective", () => {
  const p = parseMentorCommand("把缓存层重写一下");
  assert.equal(p.verb, null);
  assert.equal(p.action, null);
  assert.ok(p.error && p.error.includes("未知子命令"), p.error);

  const store = createMemoryStore();
  const out = runMentorCommand(store, "把缓存层重写一下");
  assert.equal(out.kind, "error");
  assert.equal(store.get(), null, "未识别输入不许创建任务");
});

test("M3 每个动词的 action 都指向真实存在的 HANDLERS", () => {
  for (const v of MENTOR_VERBS) {
    assert.equal(typeof HANDLERS[v.action], "function", `${v.verb} → ${v.action} 必须有实现`);
  }
  // 反向：控制类 handler 都要有一条命令能到达（避免只加工具不加命令）
  // 注意 task_status 之外的只读/写工具不要求有命令入口，这里只锁已声明动词覆盖的集合
  const covered = new Set(MENTOR_VERBS.map((v) => v.action));
  for (const must of [
    "mentor_task_create",
    "mentor_task_status",
    "mentor_task_approve",
    "mentor_task_pause",
    "mentor_task_resume",
    "mentor_task_clear",
    "mentor_task_off",
    "mentor_task_on",
  ]) {
    assert.ok(covered.has(must), `${must} 必须有对应的 /mentor 子命令`);
  }
});

/* ---------------- 2. 动词行为 ---------------- */

test("M4 status 无任务时给出建任务入口，有任务时列 phase/就绪/下一步", () => {
  const empty = createMemoryStore();
  const out0 = runMentorCommand(empty, "");
  assert.equal(out0.kind, "success");
  assert.ok(out0.text.includes("没有任务"), out0.text);
  assert.ok(out0.text.includes("/mentor new"), out0.text);

  const store = activeStore();
  const out1 = runMentorCommand(store, "status");
  assert.equal(out1.kind, "success");
  assert.ok(out1.text.includes(PHASES.ACTIVE), out1.text);
  assert.ok(out1.text.includes("就绪：s1"), out1.text);
  assert.ok(out1.text.includes("下一步："), out1.text);
});

test("M5 new 建任务并进 planning；缺目标 / 缺 workspaceRoot 都明确报错", () => {
  const store = createMemoryStore();
  const missing = runMentorCommand(store, "new");
  assert.equal(missing.kind, "error");
  assert.equal(store.get(), null);

  // v0.2.0：`/mentor new` 只产出 objective，workspaceRoot 由宿主会话 cwd 补
  // （lib/index.js:691 `workspaceRoot: args.workspaceRoot ?? exec?.agent?.session?.header?.cwd`）。
  // runMentorCommand 是纯函数、没有会话上下文，所以这里必然走到 E_WORKSPACE_REQUIRED ——
  // 这条断言钉的就是「纯函数入口不会偷偷造一条没有工作区的任务」这个边界。
  const noRoot = runMentorCommand(store, "new 写一个矩阵文件");
  assert.equal(noRoot.kind, "error", noRoot.text);
  assert.ok(noRoot.text.includes("E_WORKSPACE_REQUIRED"), noRoot.text);
  assert.equal(store.get(), null, "缺 workspaceRoot 时不该落一条半成品任务");

  // 宿主补上 cwd 之后的等价调用（工具层契约）就能建出来
  const created = HANDLERS.mentor_task_create(store, {
    objective: "写一个矩阵文件",
    workspaceRoot: ROOT,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(store.get().phase, PHASES.PLANNING);
  assert.equal(store.get().objective, "写一个矩阵文件");
});

test("M6 pause → resume 精确回到暂停前状态；off → on 不自动恢复", () => {
  const store = activeStore();

  assert.equal(runMentorCommand(store, "pause decision").kind, "success");
  assert.equal(store.get().phase, PHASES.PAUSED);
  assert.equal(store.get().prePausePhase, PHASES.ACTIVE);
  assert.equal(store.get().pauseReason, "decision");

  // 原因必须是枚举：自由文本报错并列可用值，不静默降级
  const badReason = runMentorCommand(store, "pause 随便停一下");
  assert.equal(badReason.kind, "error", badReason.text);
  assert.ok(badReason.text.includes("未知暂停原因"), badReason.text);

  // 暂停下写操作被拒（走同一张 HANDLERS，说明命令没有旁路）
  const blocked = runMentorCommand(store, "status");
  assert.ok(blocked.text.includes("已暂停"), blocked.text);

  assert.equal(runMentorCommand(store, "resume").kind, "success");
  assert.equal(store.get().phase, PHASES.ACTIVE);

  assert.equal(runMentorCommand(store, "off").kind, "success");
  assert.equal(store.get().enabled, false);

  const on = runMentorCommand(store, "on");
  assert.equal(on.kind, "success");
  assert.equal(store.get().enabled, true);
  assert.equal(store.get().phase, PHASES.ACTIVE, "on 只开开关，不改 phase");
});

test("M7 approve 支持带版本号，且陈旧版本被拒", () => {
  const store = activeStore({ requireApproval: true });
  // activeStore 已经批准过（planVersion=1），现在同版本再批是幂等
  const again = runMentorCommand(store, "approve 1");
  assert.equal(again.kind, "success", again.text);
  assert.ok(again.text.includes("幂等"), again.text);

  const stale = runMentorCommand(store, "approve 99");
  assert.equal(stale.kind, "error", stale.text);
  assert.ok(stale.text.includes("E_ILLEGAL_TRANSITION"), stale.text);

  const notInt = runMentorCommand(store, "approve abc");
  assert.equal(notInt.kind, "error");
  assert.ok(notInt.text.includes("整数"), notInt.text);
});

test("M8 clear 归档后可立刻用 new 开新任务（导师不被锁死）", () => {
  const store = activeStore();
  const cleared = runMentorCommand(store, "clear 收尾");
  assert.equal(cleared.kind, "success", cleared.text);
  assert.equal(store.get().phase, PHASES.ARCHIVED);
  assert.ok(cleared.text.includes("/mentor new"), cleared.text);

  const next = HANDLERS.mentor_task_create(store, {
    objective: "下一个任务",
    workspaceRoot: ROOT,
  });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(store.get().phase, PHASES.PLANNING);
  assert.equal(store.get().objective, "下一个任务");
});

test("M9 help 列出全部动词，且提示命令与工具同一套 handler", () => {
  const text = helpText();
  for (const v of MENTOR_VERBS) {
    assert.ok(text.includes(v.verb), `帮助里缺 ${v.verb}`);
  }
  assert.ok(text.includes("同一套 handler"), text);
});

/* ---------------- 4. 人工专属出口：/mentor close ---------------- *
 *
 * 背景：mentor_finding_close 是 reviewer 一直不写 markedResolved、
 * 任务被 E_BLOCKING_FINDING_OPEN 挡死时的人工出口（src/review/review.js:315）。
 * 它刻意不从模型工具表暴露，只走 /mentor close 命令。
 * 下面把「命令能用 / 模型不能调」这两半都钉住。
 */

test("M10 close 动词精确映射到 mentor_finding_close，且解析要求编号+理由", () => {
  // M3 只验「action 有实现」，这里验「就是这一个」——写错成别的已存在 handler 时 M3 会漏
  const closeVerb = MENTOR_VERBS.find((v) => v.verb === "close");
  assert.ok(closeVerb, "MENTOR_VERBS 必须含 close");
  assert.equal(closeVerb.action, "mentor_finding_close", "close 必须精确映射到 mentor_finding_close");
  assert.equal(typeof HANDLERS[closeVerb.action], "function", "mentor_finding_close 必须有实现");

  // 正常：findingId 与 reason 都要落进 params
  const ok = parseMentorCommand("close cmp-f1 内容已人工核验，证据在 REPORT.md");
  assert.equal(ok.error, null);
  assert.equal(ok.verb, "close");
  assert.equal(ok.params.findingId, "cmp-f1");
  assert.equal(ok.params.reason, "内容已人工核验，证据在 REPORT.md");

  // 缺理由：必须报错，不能静默按理由为空通过
  const noReason = parseMentorCommand("close cmp-f1");
  assert.ok(noReason.error, "缺 reason 必须报错");
  assert.match(noReason.error, /问题编号与理由/);

  // 完全缺参数
  const noArgs = parseMentorCommand("close");
  assert.ok(noArgs.error, "缺 findingId 必须报错");

  // helpText 两条：动词在册 + 「同一套 handler」不被文案改动冲掉
  // （本轮修复曾把该句整句替换，M9 因此红过一次，这里就近再钉一遍）
  const text = helpText();
  assert.ok(text.includes("close"), "help 要列出 close");
  assert.ok(text.includes("同一套 handler"), "help 要保留「同一套 handler」");
});

test("M11 mentor_finding_close 不在模型工具表，但 mentor_finding_respond 仍在", async () => {
  const { TOOL_NAMES } = await import("../lib/index.js");
  assert.equal(
    TOOL_NAMES.includes("mentor_finding_close"),
    false,
    "mentor_finding_close 是人工专属，不能出现在模型工具表",
  );
  assert.equal(
    TOOL_NAMES.includes("mentor_finding_respond"),
    true,
    "mentor_finding_respond 是模型可调的正规整改入口，不能被误删",
  );
  // 数量锚定：增删工具时这条会红，提醒同步检查人工/模型边界
  assert.equal(TOOL_NAMES.length, 27, `工具表应为 27 项，实际 ${TOOL_NAMES.length}`);
});
