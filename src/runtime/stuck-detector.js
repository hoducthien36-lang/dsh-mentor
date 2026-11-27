/**
 * 实时回合内 5 模式死循环检测器（StuckDetector，v0.6）。
 *
 * 借鉴 OpenHands V1 SDK 5-pattern StuckDetector：
 *   1. REPEATED_TOOL_CALL      同一 (tool, argsHash) 连续重复 ≥ 4 次
 *   2. REPEATED_ERROR_SIGNATURE 同一归一化错误签名连续/密集重复 ≥ 3 次
 *   3. AB_OSCILLATION          A ↔ B 震荡往返 ≥ 3 轮（如反复改同一文件的两种状态）
 *   4. MONOLOGUE_NO_PROGRESS   连续 ≥ 4 条助手发言没有任何工具调用或推进
 *   5. SEARCH_THRASH           连续只读检索（read/grep/glob/status）≥ 6 次且目标高度重复（唯一目标 ≤ 2）
 *
 * 零外部依赖；对工具参数只做 SHA-256 摘要，绝不把明文凭据写进状态或日志。
 */

import { createHash } from "node:crypto";

export const STUCK_PATTERNS = Object.freeze({
  REPEATED_TOOL_CALL: "REPEATED_TOOL_CALL",
  REPEATED_ERROR_SIGNATURE: "REPEATED_ERROR_SIGNATURE",
  AB_OSCILLATION: "AB_OSCILLATION",
  MONOLOGUE_NO_PROGRESS: "MONOLOGUE_NO_PROGRESS",
  SEARCH_THRASH: "SEARCH_THRASH",
});

const READ_ONLY_SEARCH_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "mentor_task_status",
  "mentor_team_context",
  "mentor_evidence_read",
]);

function sha12(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 12);
}

function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function parseMaybeJsonArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed); } catch { return { _raw: trimmed }; }
    }
    return trimmed ? { _raw: trimmed } : {};
  }
  return {};
}

function extractToolCall(event) {
  if (!event || event.type !== "tool/call") return null;
  const name = String(event.data?.name ?? event.name ?? "").trim();
  if (!name) return null;
  const args = parseMaybeJsonArgs(event.data?.arguments ?? event.data?.args ?? event.arguments);
  const argsHash = sha12(stableJson(args));
  const target = typeof args?.file_path === "string"
    ? args.file_path
    : typeof args?.path === "string"
      ? args.path
      : typeof args?.query === "string"
        ? args.query
        : typeof args?.pattern === "string"
          ? args.pattern
          : typeof args?.command === "string"
            ? args.command.slice(0, 64)
            : "";
  return {
    seq: event.seq ?? event.id ?? null,
    name,
    argsHash,
    sig: `${name}#${argsHash}`,
    targetKey: target ? `${name}:${sha12(target)}` : `${name}#${argsHash}`,
  };
}

function normalizeErrorSignature(raw) {
  const text = String(raw ?? "")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gu, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/giu, "<hex>")
    .replace(/\b\d+\b/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  return text ? sha12(text) : "";
}

function extractToolResultText(payload) {
  if (!payload) return "";
  if (typeof payload.output === "string") return payload.output;
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) return payload.content.map((c) => c?.text ?? "").join("\n");
  return "";
}

/** 返回 { isError: true, sig, preview } 或 { isError: false } 或 null（非 tool/result）。 */
function inspectToolResult(event) {
  if (!event || event.type !== "tool/result") return null;
  const data = event.data ?? event;
  // 真实 DSH 事件把 tool/result 放在 event.data.message 下（见 criterion-evidence.js）
  const msg = data?.message && typeof data.message === "object" ? data.message : null;
  const isErr = Boolean(
    data?.isError === true ||
    msg?.isError === true ||
    data?.error ||
    msg?.error ||
    data?.ok === false ||
    data?.status === "error",
  );
  if (isErr) {
    const textFromMsg = extractToolResultText(msg);
    const raw = data?.error?.message ?? data?.error ?? msg?.error?.message ?? msg?.error ?? data?.message?.text ??
      (textFromMsg || extractToolResultText(data) || data?.message || "error");
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);
    const sig = normalizeErrorSignature(str);
    return sig ? { isError: true, sig, preview: str.slice(0, 120) } : { isError: false };
  }
  const text = extractToolResultText(msg) || extractToolResultText(data);
  if (text.startsWith("{") && text.includes('"ok":false')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.ok === false) {
        const raw = `${parsed.code ?? "ERR"}:${parsed.message ?? ""}`;
        const sig = normalizeErrorSignature(raw);
        return sig ? { isError: true, sig, preview: raw.slice(0, 120) } : { isError: false };
      }
    } catch {}
  }
  return { isError: false };
}

/**
 * 对事件流执行 5 模式死循环检测（纯函数，不读时钟，不修改入参）。
 *
 * @param {Array<object>} events
 * @param {{
 *   repeatToolThreshold?: number,
 *   repeatErrorThreshold?: number,
 *   oscillationCycles?: number,
 *   monologueThreshold?: number,
 *   searchThrashThreshold?: number,
 * }} [options]
 */
export function detectStuckLoop(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const repeatToolThreshold = Number.isInteger(options.repeatToolThreshold) && options.repeatToolThreshold >= 2
    ? options.repeatToolThreshold : 4;
  const repeatErrorThreshold = Number.isInteger(options.repeatErrorThreshold) && options.repeatErrorThreshold >= 2
    ? options.repeatErrorThreshold : 3;
  const oscillationCycles = Number.isInteger(options.oscillationCycles) && options.oscillationCycles >= 2
    ? options.oscillationCycles : 3;
  const monologueThreshold = Number.isInteger(options.monologueThreshold) && options.monologueThreshold >= 2
    ? options.monologueThreshold : 4;
  const searchThrashThreshold = Number.isInteger(options.searchThrashThreshold) && options.searchThrashThreshold >= 4
    ? options.searchThrashThreshold : 6;

  const toolCalls = [];
  const recentResults = [];
  let trailingMonologue = 0;

  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    const tc = extractToolCall(ev);
    if (tc) {
      toolCalls.push(tc);
      trailingMonologue = 0;
      continue;
    }
    const tr = inspectToolResult(ev);
    if (tr) {
      recentResults.push(tr);
      continue;
    }
    if (ev.type === "assistant/message") {
      trailingMonologue += 1;
    }
  }

  // 模式 1：同一 (tool, argsHash) 连续重复
  if (toolCalls.length >= repeatToolThreshold) {
    const tail = toolCalls.at(-1);
    let streak = 1;
    for (let i = toolCalls.length - 2; i >= 0; i -= 1) {
      if (toolCalls[i].sig === tail.sig) streak += 1;
      else break;
    }
    if (streak >= repeatToolThreshold) {
      return {
        stuck: true,
        pattern: STUCK_PATTERNS.REPEATED_TOOL_CALL,
        repeatCount: streak,
        evidence: `工具 ${tail.name} 以完全相同参数连续调用了 ${streak} 次`,
        suggestion: "停止重复同一调用，先读取失败原因或换用其他诊断思路；若受限于环境阻塞请暂停交给人处理。",
      };
    }
  }

  // 模式 2：同一归一化错误签名在最近结果窗口内密集重复（成功调用会自动冲出旧错，防永久中毒）
  if (recentResults.length >= repeatErrorThreshold) {
    const win = recentResults.slice(-Math.max(repeatErrorThreshold * 2, 8));
    const counts = new Map();
    for (const item of win) {
      if (!item.isError) continue;
      const prev = counts.get(item.sig) ?? { count: 0, preview: item.preview };
      prev.count += 1;
      counts.set(item.sig, prev);
    }
    for (const { count, preview } of counts.values()) {
      if (count >= repeatErrorThreshold) {
        return {
          stuck: true,
          pattern: STUCK_PATTERNS.REPEATED_ERROR_SIGNATURE,
          repeatCount: count,
          evidence: `最近工具调用连续命中相同错误 ${count} 次：${preview}`,
          suggestion: "同一报错已反复出现，切勿原样重试；请先核对根因、检查工作区/参数假设，必要时回滚到上一快照或请求人工介入。",
        };
      }
    }
  }

  // 模式 3：A ↔ B 震荡循环（至少 oscillationCycles 轮 = 2*cycles 次调用）
  const oscLen = oscillationCycles * 2;
  if (toolCalls.length >= oscLen) {
    const win = toolCalls.slice(-oscLen);
    const a = win[0].sig;
    const b = win[1].sig;
    if (a !== b && win.every((item, idx) => item.sig === (idx % 2 === 0 ? a : b))) {
      return {
        stuck: true,
        pattern: STUCK_PATTERNS.AB_OSCILLATION,
        repeatCount: oscillationCycles,
        evidence: `检测到 ${win[0].name} ↔ ${win[1].name} 往返震荡 ${oscillationCycles} 轮无进展`,
        suggestion: "当前陷入两步来回拉锯，请立刻停下对比两次改动为何互相抵消，重新制定一次性修复方案。",
      };
    }
  }

  // 模式 4：连续纯独白无任何工具调用推进
  if (trailingMonologue >= monologueThreshold) {
    return {
      stuck: true,
      pattern: STUCK_PATTERNS.MONOLOGUE_NO_PROGRESS,
      repeatCount: trailingMonologue,
      evidence: `连续 ${trailingMonologue} 条回复未触发任何工具操作或状态推进`,
      suggestion: "请直接调用所需工具推进当前阶段，或如存在未决阻塞立即明确说明并暂停交由用户决策。",
    };
  }

  // 模式 5：只读检索空转（连续多次只读搜索且目标高度重复）
  if (toolCalls.length >= searchThrashThreshold) {
    const win = toolCalls.slice(-searchThrashThreshold);
    if (win.every((tc) => READ_ONLY_SEARCH_TOOLS.has(tc.name))) {
      const uniqueTargets = new Set(win.map((tc) => tc.targetKey));
      if (uniqueTargets.size <= 2) {
        return {
          stuck: true,
          pattern: STUCK_PATTERNS.SEARCH_THRASH,
          repeatCount: searchThrashThreshold,
          evidence: `连续 ${searchThrashThreshold} 次只读检索局限在 ${uniqueTargets.size} 个重复目标上`,
          suggestion: "已反复读取相同目标，请基于已有信息直接推进实施/上报，或换新的检索关键词。",
        };
      }
    }
  }

  return {
    stuck: false,
    pattern: null,
    repeatCount: 0,
    evidence: "",
    suggestion: "",
  };
}

/**
 * 有状态的回合级死循环跟踪器：
 *   - 首次命中：返回 action="steer"（注入诊断纠偏提示），并推进 steerWatermark = list.length，
 *     避免下一次 1.5s 看门狗因 steer 自身追加的 user/message 立刻误判 halt；
 *   - 纠偏后在新事件切片上再次构成死循环：返回 action="halt"（交由人工接管或中止失控 worker）。
 */
export function createStuckTracker(options = {}) {
  let steerCount = 0;
  let lastEventCount = 0;
  let steerWatermark = 0;
  let lastPattern = null;
  const maxSteers = Number.isInteger(options.maxSteers) && options.maxSteers >= 1 ? options.maxSteers : 1;

  return {
    evaluate(events) {
      const list = Array.isArray(events) ? events : [];
      // 同一批事件不重复计数（防止定时器多次 tick 误触发二次升级）
      if (list.length <= lastEventCount) {
        return { action: "none", stuck: false, pattern: null, steerCount };
      }
      const windowEvents = steerWatermark > 0 ? list.slice(steerWatermark) : list;
      const res = detectStuckLoop(windowEvents, options);
      if (!res.stuck) {
        lastEventCount = list.length;
        return { action: "none", ...res, steerCount };
      }
      lastEventCount = list.length;
      lastPattern = res.pattern;
      if (steerCount < maxSteers) {
        steerCount += 1;
        steerWatermark = list.length;
        return {
          action: "steer",
          ...res,
          steerCount,
          message: `[mentor:stuck-detector] 检测到疑似循环卡死（${res.pattern}：${res.evidence}）。${res.suggestion}`,
        };
      }
      return {
        action: "halt",
        ...res,
        steerCount,
        message: `纠偏后仍持续卡死（${res.pattern}：${res.evidence}），已停止自动空转并交由人工处理。`,
      };
    },
    reset() {
      steerCount = 0;
      lastEventCount = 0;
      steerWatermark = 0;
      lastPattern = null;
    },
    state() {
      return { steerCount, lastEventCount, steerWatermark, lastPattern };
    },
  };
}
