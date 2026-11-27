/**
 * v0.5 · 自适应严格度分级（Adaptive Rigor: express / standard / strict）
 *
 * 设计守则（对齐 OpenSpec / SWE-Verifier / 三方安全审计）：
 *   1. 三档策略包而非配置地狱：
 *      · express  —— 小修快速通道：跳过计划审查，保留宿主真实 Diff + 防作弊扫描 + 1 次阶段/收尾审查；
 *      · standard —— 默认标准流程：完整计划审查 + 阶段审查 + 整体验收；
 *      · strict   —— 高危严格模式：完整审查 + 更强/升档审查路由 + 强制严格核查测试与敏感路径。
 *   2. 宿主硬控「只升不降」：模型永远不能自称 express 来逃避审查；一旦命中爆炸半径、
 *      敏感路径（测试/鉴权/迁移/构建/安全策略）、未声明改动、防作弊告警或返工，
 *      宿主自动升档并在 UI 与返回值中展示明确原因。
 */

export const RIGOR_TIERS = Object.freeze({
  EXPRESS: "express",
  STANDARD: "standard",
  STRICT: "strict",
});

export const VALID_RIGORS = Object.freeze([
  RIGOR_TIERS.EXPRESS,
  RIGOR_TIERS.STANDARD,
  RIGOR_TIERS.STRICT,
]);

const RANK = Object.freeze({
  express: 0,
  standard: 1,
  strict: 2,
});

const SENSITIVE_PATH_RE = /(?:^|\/)(?:auth|oauth|login|session|token|secret|security|crypto|rbac|acl|permission|policy|guard|checkpoint|migrat(?:ion|ions)?|schema|prisma|dockerfile|docker-compose|\.github\/workflows|\.gitlab-ci|makefile|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|go\.mod|pyproject\.toml)(?:\/|$|\.)|(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$/iu;

const SENSITIVE_OBJECTIVE_RE = /\b(?:auth|oauth|jwt|token|password|secret|security|migration|schema|database|production|deploy|ci\/cd|rollback|payment|billing)\b|鉴权|认证|权限|密码|密钥|安全|迁移|数据库|支付|生产|回滚/iu;

export function normalizeRigor(value, fallback = RIGOR_TIERS.STANDARD) {
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (VALID_RIGORS.includes(clean)) return clean;
  }
  return VALID_RIGORS.includes(fallback) ? fallback : RIGOR_TIERS.STANDARD;
}

export function isSensitiveRigorPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  return SENSITIVE_PATH_RE.test(filePath.replace(/\\/gu, "/"));
}

function maxTier(a, b) {
  return (RANK[a] ?? 1) >= (RANK[b] ?? 1) ? a : b;
}

/**
 * 规划期初判严格度（只允许从目标/请求值向上升级，不允许违规降级）。
 */
export function evaluatePlanRigor({
  requested = null,
  defaultRigor = RIGOR_TIERS.STANDARD,
  currentTier = null,
  userExplicit = false,
  stages = [],
  criteria = [],
  objective = "",
} = {}) {
  let tier = normalizeRigor(requested ?? defaultRigor, defaultRigor);
  if (currentTier && VALID_RIGORS.includes(currentTier)) {
    // 计划修订始终保持严格度单调「只升不降」（人工调档请走 mentor_rigor_set，不传 currentTier）
    tier = maxTier(currentTier, tier);
  }
  const reasons = [];

  if (requested && userExplicit) {
    reasons.push(`用户指定 ${tier}`);
  } else if (requested) {
    reasons.push(`初始请求 ${tier}`);
  } else {
    reasons.push(`默认 ${tier}`);
  }

  const stageList = Array.isArray(stages) ? stages : [];
  const criteriaList = Array.isArray(criteria) ? criteria : [];

  // 0) 安全红线（P0-1）：模型不得自封 express 跳过计划审查；
  // 只有人工显式指定（userExplicit）或宿主配置 defaultRigor==="express"，且无自定义 shell prechecks 时才允许 express 跳计划审查
  const expressAuthorized = Boolean(userExplicit || defaultRigor === RIGOR_TIERS.EXPRESS);
  const hasCustomStagePrechecks = stageList.some((s) => Array.isArray(s?.prechecks) && s.prechecks.length > 0);
  if (tier === RIGOR_TIERS.EXPRESS && !expressAuthorized) {
    tier = RIGOR_TIERS.STANDARD;
    reasons.push("仅人工或配置可启用 express，模型自声明已自动升档至 standard");
  }
  if (tier === RIGOR_TIERS.EXPRESS && hasCustomStagePrechecks) {
    tier = RIGOR_TIERS.STANDARD;
    reasons.push("计划含自定义 shell prechecks，禁止跳过计划审查，已自动升档至 standard");
  }

  // 1) 爆炸半径：多阶段或验收项 > 3 不允许走 express
  if (stageList.length > 1) {
    if (RANK[tier] < RANK.standard) {
      tier = RIGOR_TIERS.STANDARD;
      reasons.push(`多阶段计划（${stageList.length} 阶段）自动升档至 standard`);
    }
  }
  if (criteriaList.length > 3) {
    if (RANK[tier] < RANK.standard) {
      tier = RIGOR_TIERS.STANDARD;
      reasons.push(`验收项较多（${criteriaList.length} 条）自动升档至 standard`);
    }
  }

  // 2) 敏感写域或高风险目标词 → 强制至少 strict（或不可走 express）
  const touchedWritePaths = stageList.flatMap((s) => Array.isArray(s?.writePaths) ? s.writePaths : []);
  const sensitiveWrites = touchedWritePaths.filter(isSensitiveRigorPath);
  if (sensitiveWrites.length > 0) {
    if (RANK[tier] < RANK.strict) {
      tier = RIGOR_TIERS.STRICT;
      reasons.push(`涉及高敏感/测试/配置路径（${sensitiveWrites.slice(0, 3).join("、")}）自动升档至 strict`);
    }
  } else if (SENSITIVE_OBJECTIVE_RE.test(String(objective ?? ""))) {
    if (RANK[tier] < RANK.standard) {
      tier = RIGOR_TIERS.STANDARD;
      reasons.push("目标涉及高敏业务域，自动升档至 standard");
    }
  }

  return {
    tier,
    requested: requested ? normalizeRigor(requested, defaultRigor) : null,
    userExplicit: Boolean(userExplicit),
    skipPlanReview: tier === RIGOR_TIERS.EXPRESS && expressAuthorized && !hasCustomStagePrechecks && stageList.length <= 1,
    reasons,
    updatedAt: Date.now(),
  };
}

/**
 * 上报/返工期复判严格度（绝对「只升不降」）。
 */
export function escalateRigorOnReport({
  current = null,
  diffAudit = null,
  tamperScan = null,
  precheckResult = null,
  attempt = 1,
} = {}) {
  const previousTier = normalizeRigor(current?.tier ?? current, RIGOR_TIERS.STANDARD);
  let nextTier = previousTier;
  const reasons = Array.isArray(current?.reasons) ? [...current.reasons] : [];
  const addedReasons = [];

  const bump = (target, reason) => {
    const resolved = maxTier(nextTier, target);
    if (resolved !== nextTier) {
      nextTier = resolved;
      addedReasons.push(reason);
      reasons.push(reason);
    }
  };

  if (tamperScan && ((tamperScan.blocks?.length ?? 0) > 0 || (tamperScan.warnings?.length ?? 0) > 0)) {
    bump(RIGOR_TIERS.STRICT, "检测到测试完整性/防作弊信号，自动升档至 strict");
  }
  if (diffAudit?.undeclaredFiles?.length > 0) {
    bump(RIGOR_TIERS.STRICT, `存在 ${diffAudit.undeclaredFiles.length} 个未声明改动文件，自动升档至 strict`);
  }
  if (diffAudit?.outsideWritePaths?.length > 0) {
    bump(RIGOR_TIERS.STRICT, `存在 ${diffAudit.outsideWritePaths.length} 个越出写域改动，自动升档至 strict`);
  }
  const sensitiveChanged = (diffAudit?.changedFiles ?? []).map((f) => f.path).filter(isSensitiveRigorPath);
  if (sensitiveChanged.length > 0) {
    bump(RIGOR_TIERS.STRICT, `改动触及敏感/测试/配置路径（${sensitiveChanged.slice(0, 3).join("、")}），自动升档至 strict`);
  }
  if ((diffAudit?.totalChangedFiles ?? 0) > 3 || (diffAudit?.totalDiffLines ?? 0) > 150) {
    bump(
      RIGOR_TIERS.STANDARD,
      `实际改动超出小修阈值（${diffAudit.totalChangedFiles} 文件 / ${diffAudit.totalDiffLines} 行），自动升档至 standard`,
    );
  }
  if (precheckResult && precheckResult.ok === false) {
    bump(RIGOR_TIERS.STANDARD, "前置硬检查失败，自动升档至 standard");
  }
  if (attempt >= 2) {
    bump(previousTier === RIGOR_TIERS.EXPRESS ? RIGOR_TIERS.STANDARD : RIGOR_TIERS.STRICT, `阶段进入第 ${attempt} 次返工，自动升档`);
  }

  return {
    ...(current && typeof current === "object" ? current : {}),
    tier: nextTier,
    previousTier,
    upgraded: nextTier !== previousTier,
    addedReasons,
    reasons: reasons.slice(-8),
    skipPlanReview: false,
    updatedAt: Date.now(),
  };
}
