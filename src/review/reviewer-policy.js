/**
 * reviewer 子会话的工具策略（纯函数，零依赖）。
 *
 * 为什么要有这个模块：2026-11-09 真机实测过一次「审查永远超时」——
 * reviewer 的会话转写显示它没有 read/glob/grep，只好自行 spawn 两个子代理取证，
 * 随后 8 分钟卡在 wait_agent，10 分钟 `child-runtime-timeout`，
 * 计划永远批不了（死锁）。根因是宿主 `tools.restrict` 只能命名全局工具，
 * 把内置读工具写进 allow 会被剔除，于是我们改成「不收窄 + 只读 prompt + 越界看门狗」。
 *
 * 看门狗判定原来内联在 `lib/index.js` 的 `spawnReviewer` 异步闭包里，单测跑不到；
 * 抽到这里之后，`test/reviewer-policy.test.mjs` 可以逐条锁住放行/拦截名单。
 */

/** reviewer 只该有这几种工具：读任务快照、交裁决、读文件。 */
export const REVIEWER_ALLOWED_TOOLS = Object.freeze([
  "mentor_task_status",
  "mentor_review_apply",
  "mentor_evidence_read",
  "read",
  "glob",
  "grep",
  // 只读导航：locate 工作目录用，不改仓库（真机第一版被误拦，见下方 FORBIDDEN_PATTERNS 注释）
  "working_directory",
]);

/**
 * 危险工具族（正则）。命中即判定为越界：
 *   · 写盘 / 执行 shell —— 审查不该改变仓库
 *   · 团队与委派 —— 上一轮就是 spawn_teammate + wait_agent 把审查拖死的
 *   · 其他任务控制 / MCP —— 不在审查职责内
 *
 * 注意：**不要拦只读导航工具**（如 working_directory）。2026-11-09 真机第一次验证时
 * reviewer 第二步就是调 `working_directory` 定位工作目录，被误判后看门狗 5 秒 abort，
 * 审查直接失败。只读工具不改变仓库，交给 prompt 约束即可。
 */
const FORBIDDEN_PATTERNS = Object.freeze([
  /^write$/,
  /^edit$/,
  /^bash$/,
  // 2026-11-24（Round 5a）：本机宿主把 PowerShell 暴露为 `pwsh`，与 bash 同族，
  // 但旧名单只写了 bash —— 审查员在 Windows 上可以起 shell 而不被看门狗拦。
  /^pwsh$/,
  /^powershell$/,
  /^spawn_teammate$/,
  /^send_message$/,
  /^wait_agent$/,
  /^list_agents$/,
  /^interrupt_agent$/,
  /^team_task_/,
  /^task_/,          // 宿主的 task_* 督导工具，不是 mentor 的
  /^ego_/,
  /^mcp__/,
  /^cg$/,
]);

/**
 * 判断 reviewer 调用某个工具是否越界。
 *
 * 规则：
 *   1. 明确在放行名单里 → 放行（即使名字看着像危险族）；
 *   2. `mentor_*` 里不在放行名单的 → 拦截（reviewer 不该建任务 / 上报阶段 / 控制任务）；
 *   3. 命中危险族正则 → 拦截；
 *   4. 其余（未知的只读类工具）→ 放行，交给 prompt 约束，避免误杀新只读工具。
 *
 * @param {unknown} name 工具名
 * @returns {boolean} true = 越界，应当中止本次审查
 */
export function isForbiddenReviewerTool(name) {
  if (typeof name !== "string") return false;
  const value = name.trim();
  if (value.length === 0) return false;
  if (REVIEWER_ALLOWED_TOOLS.includes(value)) return false;
  if (value.startsWith("mentor_")) return true;
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 运行时硬预算：reviewer 累计工具调用超过这个数就中止。
 *
 * 为什么比 prompt 里写的「8 次」宽：「8 次」是给模型的建议值，用来压住反复读大文件的冲动；
 * 硬阈值留出余量，避免正常的「读快照 + 读三四个文件 + 交裁决」被误杀。
 * 两者一起才是完整约束 —— 只有 prompt 是建议，只有阈值是硬拦，缺一个都会重现历史死锁形态。
 */
export const REVIEWER_TOOL_BUDGET = 12;

/** prompt 里写给模型的建议预算（与 REVIEWER_TOOL_BUDGET 的差值即容错余量）。 */
export const REVIEWER_PROMPT_TOOL_BUDGET = 8;

/**
 * 累计调用数是否已超硬预算。
 *
 * @param {unknown} count 累计工具调用次数
 * @returns {boolean} true = 超预算，应当中止本次审查
 */
export function reviewerBudgetExceeded(count) {
  if (typeof count !== "number" || !Number.isFinite(count)) return false;
  return count > REVIEWER_TOOL_BUDGET;
}

/** Scan a full event snapshot once, shared by the watchdog and decision gate. */
export function reviewerPolicyViolation(events = []) {
  const seen = new Set();
  let toolCalls = 0;
  for (const event of events) {
    if (event?.type !== "tool/call") continue;
    const key = event.seq ?? event.id;
    if (key != null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    toolCalls += 1;
    const name = String(event.data?.name ?? "");
    if (isForbiddenReviewerTool(name)) return "reviewer-forbidden-tool:" + name;
    if (reviewerBudgetExceeded(toolCalls)) return "reviewer-budget-exceeded:" + toolCalls;
  }
  return null;
}

/**
 * reviewer prompt 里的强制约束（禁委派 + 预算）。
 *
 * 为什么要抽成函数：2026-11-09 的 P0 事故——这两行写在了 `lib/index.js` 的
 * `reviewPrompt` 里，而那个函数**全仓 0 处调用**，真正发出去的 `runtimeReviewPrompt`
 * 没有它们，于是 prompt 层没有任何预算或禁委派约束，只靠看门狗兜底。
 * 抽到这里并由 `runtimeReviewPrompt` 注入，`test/reviewer-policy.test.mjs`
 * 就能同时锁住「文案存在」和「确实被接线」。
 */
export function reviewerConstraintLines() {
  return [
    "scope=file 表示文件版本已绑定。判断全文性质时用 mentor_evidence_read 从首行读取，按 nextLine 和 nextColumn（缺省为 1）翻到末页，再依据原文裁决。可用 read / glob / grep 定位材料或补读片段上下文。片段证据已逐字匹配；同一段即能验证的输入、预期、实际值合并核对。无需为已可直接核实的事实补抄引用。文件变更或实际证据不足时说明缺口；计划审查没有阶段报告。",
    "禁止：不要调用 spawn_teammate / wait_agent / send_message / list_agents / 任何 task_* 或 team_task_* / bash / pwsh / powershell / write / edit / cg / ego_* / mcp__* —— 你是只读审查，起子代理或执行 shell 等于把审查拖死。",
    `预算：最多 ${REVIEWER_PROMPT_TOOL_BUDGET} 次工具调用、5 分钟内必须交裁决。读不到的证据就判 revise 并写清「缺什么、怎么补」，不要继续翻文件。`,
  ];
}
