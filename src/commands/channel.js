/**
 * slash 命令通道（改造 s2-a，对齐旧 supervisor 的 `/task`）。
 *
 * 旧插件把人机控制做成了两条通道：工具（模型调）+ slash 命令（人在输入框敲）。
 * mentor 之前只有工具通道 —— 人除了点 UI 按钮没有别的入口。
 * 本模块补上命令通道，语义上**不新增任何状态能力**：每个动词都是把已有 handler
 * 调一次，和工具通道走同一张 HANDLERS 表。人工 waive / close 刻意不向模型
 * 开放同等权限，业务状态转换仍复用已有 handler。
 *
 * 设计取舍（写在这里而不是藏起来）：
 *   · 未识别的子命令一律报错并列可用动词，**不静默把整句当 objective 建任务**。
 *     旧 `/task <目标>` 是「进入规划、下一条消息作目标」的两步流程；mentor 建任务
 *     必须显式给 objective，静默建任务会让误敲一行字就产生一个任务记录。
 *   · 输出是纯文本，供会话里直接读；结构化数据仍走 `mentor_task_status`。
 */

import { HANDLERS } from "../tools/handlers.js";
import { buildStatePayload } from "../rpc/state.js";
import { PHASES, pauseReasonList } from "../state/machine.js";

/** 暂停原因枚举（与 machine.js 同源，避免两处各写一份） */
const PAUSE_REASON_VALUES = pauseReasonList();

/** 子命令表：verb → 对应 handler 名 + 参数怎么取 */
export const MENTOR_VERBS = Object.freeze([
  { verb: "status", action: "mentor_task_status", hint: "查看当前任务状态与下一步" },
  { verb: "new", action: "mentor_task_create", hint: "new <目标>：建一个新任务（进入 planning）" },
  { verb: "approve", action: "mentor_task_approve", hint: "approve [计划版本]：批准当前计划" },
  { verb: "pause", action: "mentor_task_pause", hint: "pause [原因]：暂停当前任务（原因取枚举，缺省 user）" },
  { verb: "resume", action: "mentor_task_resume", hint: "resume：恢复到暂停前的状态" },
  { verb: "clear", action: "mentor_task_clear", hint: "clear [原因]：归档当前任务" },
  { verb: "off", action: "mentor_task_off", hint: "off：关闭导师（保留任务记录）" },
  { verb: "on", action: "mentor_task_on", hint: "on：重新启用导师（不自动恢复任务）" },
  // 2026-11-07：独立审查真的起不来时，只有人能放行主会话自审。
  // 模型侧没有等价工具调用路径（lib/index.js 里 !human 直接拒）。
  { verb: "waive", action: "mentor_review_waive", hint: "waive <理由>：人工放行本版计划的失败审查，允许主会话兜底裁决（会留痕）" },
  { verb: "close", action: "mentor_finding_close", hint: "close <问题编号> <理由>：人工强制关闭一条问题，记录操作者和理由" },
]);

const VERB_MAP = new Map(MENTOR_VERBS.map((v) => [v.verb, v]));

/** 帮助文本。命令面板里 `input.hint` 空间有限，完整清单放这里。 */
export function helpText() {
  const lines = ["导师模式 · /mentor 子命令："];
  for (const v of MENTOR_VERBS) lines.push(`  ${v.hint}`);
  lines.push("  help：显示本清单");
  lines.push("提示：不带子命令等同 status。命令与 mentor_* 工具走同一套 handler，能力没有分叉。");
  lines.push("      人工 waive / close 会留痕，模型不能代为操作。");
  return lines.join("\n");
}

/**
 * 解析一行命令输入。
 *
 * @param {string} raw  `/mentor` 之后的部分（不含命令名本身）
 * @returns {{verb:string|null, action:string|null, params:object, rest:string, error:string|null}}
 */
export function parseMentorCommand(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    // 空输入 = 看状态。旧 `/task` 空输入是「进入规划入口」，mentor 没有这个中间态。
    return { verb: "status", action: "mentor_task_status", params: {}, rest: "", error: null };
  }

  const [head, ...tailArr] = text.split(/\s+/u);
  const word = head.toLowerCase();
  const rest = tailArr.join(" ").trim();

  if (["help", "-h", "--help", "?"].includes(word)) {
    return { verb: "help", action: null, params: {}, rest, error: null };
  }

  const entry = VERB_MAP.get(word);
  if (!entry) {
    return {
      verb: null,
      action: null,
      params: {},
      rest,
      error: `未知子命令：${head}。可用：${[...VERB_MAP.keys()].join(" / ")} / help`,
    };
  }

  // 逐个动词取参数：只做「这一行剩下的文字怎么塞进已有参数」这一件事
  if (entry.verb === "new") {
    if (rest.length === 0) {
      return { verb: "new", action: entry.action, params: {}, rest, error: "new 需要目标陈述：/mentor new <目标>" };
    }
    return { verb: "new", action: entry.action, params: { objective: rest }, rest, error: null };
  }

  if (entry.verb === "close") {
    const [findingId, ...reasonWords] = rest.split(/\s+/u);
    const reason = reasonWords.join(" ").trim();
    if (!findingId || !reason) return { verb: "close", action: entry.action, params: {}, rest, error: "需要问题编号与理由：/mentor close <问题编号> <理由>" };
    return { verb: "close", action: entry.action, params: { findingId, reason }, rest, error: null };
  }

  if (entry.verb === "waive") {
    if (rest.length === 0) {
      return { verb: "waive", action: entry.action, params: {}, rest, error: "waive 需要理由：/mentor waive <为什么必须主会话兜底>" };
    }
    return { verb: "waive", action: entry.action, params: { reason: rest }, rest, error: null };
  }

  if (entry.verb === "approve") {
    const params = {};
    if (rest.length > 0) {
      const n = Number(rest);
      if (!Number.isSafeInteger(n)) {
        return { verb: "approve", action: entry.action, params, rest, error: `approve 的版本号必须是整数，收到：${rest}` };
      }
      params.planVersion = n;
    }
    return { verb: "approve", action: entry.action, params, rest, error: null };
  }

  if (entry.verb === "pause") {
    // 原因必须是枚举（对齐旧 pauseReason 8 值）：自由文本会让「为什么停」不可判断，
    // 而 resume 的策略要依赖它。给错就报错并列可用值，不静默降级成 user。
    if (rest.length === 0) {
      return { verb: "pause", action: entry.action, params: {}, rest, error: null };
    }
    const known = PAUSE_REASON_VALUES.includes(rest);
    if (!known) {
      return {
        verb: "pause",
        action: entry.action,
        params: { reason: rest },
        rest,
        error: `未知暂停原因：${rest}。可用：${PAUSE_REASON_VALUES.join(" / ")}`,
      };
    }
    return { verb: "pause", action: entry.action, params: { reason: rest }, rest, error: null };
  }

  if (entry.verb === "clear") {
    const params = rest.length > 0 ? { reason: rest } : {};
    return { verb: entry.verb, action: entry.action, params, rest, error: null };
  }

  return { verb: entry.verb, action: entry.action, params: {}, rest, error: null };
}

/** 状态摘要（纯文本）。无任务时也给出明确的下一步。 */
export function formatStatus(store) {
  const task = store.get();
  if (!task) {
    return "导师模式 · 当前没有任务。用 /mentor new <目标> 建一个。";
  }

  const payload = buildStatePayload(task);
  const total = (task.stages ?? []).length;
  const accepted = (task.nodeRuns ?? []).filter((r) => r && r.status === "accepted").length;
  const lines = [
    `导师模式 · ${task.phase}${task.enabled === false ? "（导师已关闭）" : ""}`,
    `任务：${task.objective}`,
  ];

  if (total > 0) {
    lines.push(`计划 v${task.planVersion}（已批准 v${task.approvedPlanVersion ?? "无"}）`);
    lines.push(`阶段：${accepted}/${total} accepted，就绪：${(payload.readyNodes ?? []).join("、") || "无"}`);
  } else {
    lines.push("计划：尚未提交（/mentor approve 在提交前无意义）");
  }

  const unresolved = payload.unresolved ?? { total: 0, blocking: 0 };
  lines.push(`未解决整改：共 ${unresolved.total}，blocking ${unresolved.blocking}`);
  lines.push(`下一步：${payload.nextStep?.text ?? "未知"}`);
  return lines.join("\n");
}

/**
 * 执行一行命令。返回 `{kind, text, data?}` —— 正好是宿主命令 handler 的返回形状。
 *
 * @param {{get:()=>object|null, set:(o:object)=>void}} store
 * @param {string} raw
 */
export function runMentorCommand(store, raw) {
  const parsed = parseMentorCommand(raw);

  if (parsed.error) {
    return { kind: "error", text: parsed.error, data: { verb: parsed.verb } };
  }

  if (parsed.verb === "help") {
    return { kind: "success", text: helpText(), data: { verb: "help" } };
  }

  const fn = HANDLERS[parsed.action];
  if (typeof fn !== "function") {
    // 结构与 HANDLERS 表脱钩：不是运行时能靠用户操作修好的事，必须显式报
    return { kind: "error", text: `命令 ${parsed.verb} 没有对应实现：${parsed.action}` };
  }

  // status 在无任务时也必须给出「怎么开始」，不能把 E_NO_TASK 当错误抛给用户：
  // 「查状态」在一个干净环境里是合法操作，返回空态与建任务入口才算完整回答。
  if (parsed.verb === "status") {
    const payload = store.get() ? buildStatePayload(store.get()) : { task: null };
    return { kind: "success", text: formatStatus(store), data: payload };
  }

  const result = fn(store, parsed.params);
  if (!result || result.ok !== true) {
    const code = (result && result.code) || "E_COMMAND_FAILED";
    const message = (result && result.message) || "命令执行失败";
    return { kind: "error", text: `「${code}」${message}`, data: result ?? null };
  }

  return { kind: "success", text: formatAction(parsed.verb, result.value), data: result.value };
}

/** 动作结果的单行摘要 + 下一步提示 */
function formatAction(verb, value) {
  const v = value && typeof value === "object" ? value : {};
  const bits = [`/mentor ${verb} 已执行`];
  if (v.phase) bits.push(`phase=${v.phase}`);
  if (v.planVersion !== undefined && v.planVersion !== null) bits.push(`planVersion=${v.planVersion}`);
  if (v.approvedPlanVersion !== undefined && v.approvedPlanVersion !== null) {
    bits.push(`approvedPlanVersion=${v.approvedPlanVersion}`);
  }
  if (v.enabled !== undefined) bits.push(`enabled=${v.enabled}`);
  if (v.duplicate === true) bits.push("重复调用（幂等）");
  if (v.archivedAt) bits.push(`archivedAt=${v.archivedAt}`);

  const task = v.taskId ? `任务 ${v.taskId}` : "";
  const head = [bits.join(" · "), task].filter(Boolean).join(" · ");

  // 归档后 store 里仍留任务对象，这里直接读它给下一步，不额外查一次
  const next =
    v.phase === PHASES.ARCHIVED
      ? "下一步：/mentor new <目标> 开新任务"
      : v.phase === PHASES.PAUSED
        ? "下一步：/mentor resume 恢复"
        : v.enabled === false
          ? "下一步：/mentor on 重新启用"
          : "下一步：/mentor status 看当前状态";

  return `${head}\n${next}`;
}
