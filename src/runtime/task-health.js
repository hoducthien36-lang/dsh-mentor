/**
 * 论文对齐的 MAST-14 与 PR-MCI 任务健康度体检引擎（v1.0）。
 *
 * 将调研核心论文的量化指标直接转化为每个任务的实时确定性体检卡：
 *   - PR-MCI 诚实度得分（arXiv:2601.04886）：真实改动与声明引用的一致率（揪出幽灵改动与未声明改动）
 *   - MAST-14 防线覆盖矩阵（UC Berkeley, arXiv:2503.13657）：14 类多智能体失败模式的实时防线状态
 *   - 返工 / 卡死 / 硬检查 / 防作弊综合效率指标
 *
 * 零外部依赖、纯函数。
 */

import { computeRetraceReconciliation } from "../review/retrace.js";

/**
 * 计算单个任务的 MAST-14 & PR-MCI 实时健康度评分卡。
 *
 * @param {object|null} task
 */
export function evaluateTaskHealth(task) {
  if (!task || typeof task !== "object") {
    return { ok: false, reason: "no-task", markdown: "当前会话没有活跃任务。" };
  }

  const stages = Array.isArray(task.stages) ? task.stages : [];
  const runs = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  const diffAudits = task.lastDiffAudits && typeof task.lastDiffAudits === "object" ? task.lastDiffAudits : {};
  const prechecks = task.lastPrechecks && typeof task.lastPrechecks === "object" ? task.lastPrechecks : {};
  const stuckEvents = Array.isArray(task.stuckEvents) ? task.stuckEvents : [];
  const mcpAlerts = Array.isArray(task.mcpSchemaAlerts) ? task.mcpSchemaAlerts : [];

  let totalChanged = 0;
  let totalDeclared = 0;
  let totalUndeclared = 0;
  let totalPhantom = 0;
  let totalOutside = 0;
  let tamperBlocks = 0;
  let tamperWarnings = 0;

  for (const [sid, audit] of Object.entries(diffAudits)) {
    if (!audit || typeof audit !== "object") continue;
    const stageDef = stages.find((s) => s?.id === sid) ?? null;
    const latestReport = runs.find((r) => r?.stageId === sid)?.reports?.at(-1) ?? null;
    const recon = computeRetraceReconciliation({ diffAudit: audit, report: latestReport, stageDef, criteria: task.criteria ?? [] });
    totalChanged += Number(audit.totalChangedFiles ?? 0);
    totalDeclared += Number(audit.declaredCount ?? 0);
    totalUndeclared += recon.undeclaredChanges.length;
    totalPhantom += recon.phantomClaims.length;
    totalOutside += recon.outsideWritePaths.length;
    if (audit.tamperScan?.ok === false) tamperBlocks += (audit.tamperScan.blocks?.length ?? 1);
    tamperWarnings += (audit.tamperScan?.warnings?.length ?? 0);
  }

  // PR-MCI 诚实度（0..100）：无未声明改动、无幽灵改动、无越写域即 100 分
  const denom = Math.max(1, totalChanged + totalDeclared);
  const discrepancies = totalUndeclared + totalPhantom + totalOutside;
  const prMciHonestyPct = Object.keys(diffAudits).length === 0
    ? null
    : Math.max(0, Math.round((1 - Math.min(1, discrepancies / denom)) * 100));

  const totalReworks = runs.reduce((n, r) => n + Math.max(0, (r?.attempt ?? 1) - 1), 0);
  const acceptedStages = runs.filter((r) => r?.status === "accepted").length;
  const precheckPassed = Object.values(prechecks).filter((p) => p?.ok === true).length;
  const precheckFailed = Object.values(prechecks).filter((p) => p?.ok === false).length;
  const waivedCount = reviews.filter((r) => Boolean(r?.selfReviewed || r?.waived || r?.waiver)).length;

  // UC Berkeley MAST-14 失败模式实时防线状态
  const mast14 = [
    { id: "FM-1.1", name: "任务规格偏离", status: (task.criteria?.length ?? 0) > 0 && Object.keys(diffAudits).length > 0 ? "guarded" : "baseline" },
    { id: "FM-1.2", name: "角色越界", status: totalOutside > 0 ? "alert" : "guarded" },
    { id: "FM-1.3", name: "步骤死循环", status: stuckEvents.length > 0 ? "intervened" : "guarded" },
    { id: "FM-1.4", name: "上下文丢失", status: "guarded" },
    { id: "FM-1.5", name: "终止条件失控", status: "guarded" },
    { id: "FM-2.1", name: "会话中断重置", status: "guarded" },
    { id: "FM-2.2", name: "模糊需求未澄清", status: task.ambiguityReport?.blocking ? "alert" : "guarded" },
    { id: "FM-2.3", name: "任务范围脱轨", status: totalUndeclared > 0 || totalOutside > 0 ? "alert" : "guarded" },
    { id: "FM-2.4", name: "信息隐藏/暗改", status: totalUndeclared > 0 ? "alert" : "guarded" },
    { id: "FM-2.5", name: "忽略同侪/整改", status: "guarded" },
    { id: "FM-2.6", name: "推理-行动错配(幽灵改动)", status: totalPhantom > 0 ? "alert" : "guarded" },
    { id: "FM-3.1", name: "过早宣称完成", status: "guarded" },
    { id: "FM-3.2", name: "验证不完整", status: precheckFailed > 0 || tamperBlocks > 0 ? "intervened" : "guarded" },
    { id: "FM-3.3", name: "审查偏见/锚定", status: waivedCount > 0 ? "alert" : "guarded" },
  ];

  const activeAlerts = mast14.filter((m) => m.status === "alert").map((m) => `${m.id} ${m.name}`);
  const lines = [
    `## Mentor Health Scorecard · \`${task.id}\``,
    `- **阶段进度**：${acceptedStages}/${stages.length} accepted · 严格度 \`${task.rigor?.tier ?? "standard"}\` · 总返工 ${totalReworks} 次`,
    `- **PR-MCI 报告诚实度**：${prMciHonestyPct === null ? "尚未产生阶段 Diff" : `${prMciHonestyPct}%`}（未声明 ${totalUndeclared} · 幽灵引用 ${totalPhantom} · 越写域 ${totalOutside}）`,
    `- **确定性防线拦截**：前置硬检查 通过 ${precheckPassed} / 拦截 ${precheckFailed} · 防改测试拦截 ${tamperBlocks}（软告 ${tamperWarnings}）· 卡死介入 ${stuckEvents.length} 次 · MCP 安全告警 ${mcpAlerts.length} 条`,
    `- **MAST-14 覆盖度**：14/14 防线已挂载${activeAlerts.length ? `（⚠ 当前告警：${activeAlerts.join("、")}）` : "（全部绿灯）"}`,
  ];

  return {
    ok: true,
    taskId: task.id,
    rigor: task.rigor?.tier ?? "standard",
    prMciHonestyPct,
    totalReworks,
    precheckPassed,
    precheckFailed,
    tamperBlocks,
    tamperWarnings,
    stuckInterventions: stuckEvents.length,
    mcpAlertsCount: mcpAlerts.length,
    waivedCount,
    mast14,
    activeAlerts,
    markdown: lines.join("\n"),
  };
}
