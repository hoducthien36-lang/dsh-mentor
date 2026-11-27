/**
 * v0.3 + v0.5 · 审查/执行分模型路由与返工/严格度自动升档（Heterogeneous Model Routing + Attempt Escalation）
 *
 * 允许在插件配置中为独立审查员（reviewerModel）和并行执行助手（workerModel）
 * 单独指定 provider / model / reasoningEffort，并支持：
 *   · byKind: { plan?, stage?, completion? }
 *   · byRigor: { express?, standard?, strict? }   (v0.5)
 *   · escalateOnAttempt: { minAttempt?, provider?, model?, reasoningEffort? } (v0.5)
 *
 * 安全红线：绝不对未配置且主会话本身未启用 reasoningEffort 的非推理端点盲目注入 reasoningEffort，
 * 避免上游 API 返回 400。缺省时完全继承主会话模型，保持零侵入向后兼容。
 */

const VALID_KINDS = ["plan", "stage", "completion"];
const VALID_RIGORS = ["express", "standard", "strict"];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseSingleRoute(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf("/");
    if (slash > 0 && slash < trimmed.length - 1) {
      return {
        provider: trimmed.slice(0, slash).trim(),
        model: trimmed.slice(slash + 1).trim(),
      };
    }
    return { model: trimmed };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const provider = nonEmpty(raw.provider);
  const model = nonEmpty(raw.model);
  const reasoningEffort = nonEmpty(raw.reasoningEffort);
  if (!provider && !model && !reasoningEffort) return null;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * 归一化配置里的模型路由声明。
 * 支持：
 *   - null / undefined / "" → null（继承主会话）
 *   - "provider/model" 或 "model"
 *   - { provider?, model?, reasoningEffort?, byKind?, byRigor?, escalateOnAttempt? }
 */
export function normalizeModelRoute(raw) {
  if (raw == null) return null;
  const base = parseSingleRoute(raw);
  let byKind = null;
  let byRigor = null;
  let escalateOnAttempt = null;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.byKind && typeof raw.byKind === "object") {
      const map = {};
      for (const kind of VALID_KINDS) {
        const parsed = parseSingleRoute(raw.byKind[kind]);
        if (parsed) map[kind] = parsed;
      }
      if (Object.keys(map).length > 0) byKind = map;
    }
    if (raw.byRigor && typeof raw.byRigor === "object") {
      const map = {};
      for (const tier of VALID_RIGORS) {
        const parsed = parseSingleRoute(raw.byRigor[tier]);
        if (parsed) map[tier] = parsed;
      }
      if (Object.keys(map).length > 0) byRigor = map;
    }
    if (raw.escalateOnAttempt && typeof raw.escalateOnAttempt === "object") {
      const parsed = parseSingleRoute(raw.escalateOnAttempt);
      if (parsed) {
        const minAttempt = Number.isInteger(raw.escalateOnAttempt.minAttempt) && raw.escalateOnAttempt.minAttempt >= 2
          ? raw.escalateOnAttempt.minAttempt
          : 2;
        escalateOnAttempt = { minAttempt, ...parsed };
      }
    }
  }

  if (!base && !byKind && !byRigor && !escalateOnAttempt) return null;
  return {
    ...(base ?? {}),
    ...(byKind ? { byKind } : {}),
    ...(byRigor ? { byRigor } : {}),
    ...(escalateOnAttempt ? { escalateOnAttempt } : {}),
  };
}

const EFFORT_LADDER = ["low", "medium", "high"];

function bumpReasoningEffort(current) {
  if (typeof current !== "string") return undefined;
  const idx = EFFORT_LADDER.indexOf(current.trim().toLowerCase());
  if (idx < 0) return current;
  return EFFORT_LADDER[Math.min(EFFORT_LADDER.length - 1, idx + 1)];
}

/**
 * 结合主会话 options 与角色路由，推导子会话的 agentOptions。
 * 优先级（从低到高）：主会话 → route 基线 → byKind → byRigor → escalateOnAttempt。
 * 若主会话本身已配置 reasoningEffort（证明端点支持），且未显式配 route，
 * 在 strict 档或 attempt >= 2 时安全升一档 reasoningEffort（low→medium→high）。
 */
export function resolveAgentOptions(main, route, { kind, attempt = 1, rigor = null } = {}) {
  const base = main && main.options && typeof main.options === "object" ? main.options : null;
  const normalized = normalizeModelRoute(route);
  const kindOverride = kind && normalized?.byKind?.[kind] ? normalized.byKind[kind] : null;
  const rigorOverride = rigor && normalized?.byRigor?.[rigor] ? normalized.byRigor[rigor] : null;
  const attemptOverride = normalized?.escalateOnAttempt && attempt >= normalized.escalateOnAttempt.minAttempt
    ? normalized.escalateOnAttempt
    : null;

  const hasExplicit = Boolean(normalized || kindOverride || rigorOverride || attemptOverride);
  const effective = hasExplicit
    ? {
        ...(normalized ? { provider: normalized.provider, model: normalized.model, reasoningEffort: normalized.reasoningEffort } : {}),
        ...(kindOverride ?? {}),
        ...(rigorOverride ?? {}),
        ...(attemptOverride ? {
          ...(attemptOverride.provider ? { provider: attemptOverride.provider } : {}),
          ...(attemptOverride.model ? { model: attemptOverride.model } : {}),
          ...(attemptOverride.reasoningEffort ? { reasoningEffort: attemptOverride.reasoningEffort } : {}),
        } : {}),
      }
    : null;

  const rest = base ? Object.fromEntries(
    Object.entries(base).filter(([k]) => !["provider", "model", "reasoningEffort"].includes(k)),
  ) : {};

  const provider = effective?.provider ?? nonEmpty(base?.provider);
  const model = effective?.model ?? nonEmpty(base?.model);
  if (!provider || !model) return null;

  let reasoningEffort = effective?.reasoningEffort !== undefined
    ? effective.reasoningEffort
    : base?.reasoningEffort;

  // 仅当主会话端点本身声明了 reasoningEffort 且未显式覆盖时，才在 strict / attempt>=2 安全升档
  if (effective?.reasoningEffort === undefined && base?.reasoningEffort !== undefined && (attempt >= 2 || rigor === "strict")) {
    reasoningEffort = bumpReasoningEffort(base.reasoningEffort);
  }

  return {
    ...rest,
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** 记录到 reviewJobs[] / workers[] 的轻量模型元数据（便于审阅与排障）。 */
export function summarizeModelRoute(resolved, main) {
  if (!resolved) return null;
  const base = main?.options;
  const inherited = Boolean(
    base &&
    base.provider === resolved.provider &&
    base.model === resolved.model &&
    (base.reasoningEffort ?? null) === (resolved.reasoningEffort ?? null),
  );
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    inherited,
  };
}
