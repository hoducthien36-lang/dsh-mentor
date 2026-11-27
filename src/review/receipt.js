/**
 * 可直接贴进 PR 的「验证收据（Verification Receipt）」（v0.6）。
 *
 * 借鉴 trustbut / prove_it / pr-proof：
 *   - 把 dsh-mentor 独有的确定性证据（宿主真实 Diff、逐字引文校验、readCoverage 账本、
 *     前置硬检查退出码、防改测试扫描、RETRACE 盲审对账、可选 Diff 变异测试、Worktree 隔离）
 *     合成一份客观、简洁、可复制的 Markdown 收据；
 *   - 强制包含显式「未验证 / 边界与假设（UNVERIFIED）」段，绝不把没跑过的检查包装成绿灯。
 *
 * 零外部依赖、纯函数。
 */

import { computeRetraceReconciliation } from "./retrace.js";

function mdEscapeInline(text) {
  return String(text ?? "").replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|").trim();
}

function summarizePrecheck(precheck) {
  if (!precheck || typeof precheck !== "object") return "未配置";
  const passed = Number(precheck.passed ?? 0);
  const total = Number(precheck.total ?? 0);
  const dur = Number.isFinite(precheck.durationMs) ? ` (${precheck.durationMs}ms)` : "";
  return `${precheck.ok ? "PASS" : "FAIL"} ${passed}/${total}${dur}`;
}

/**
 * 构建结构化与 Markdown 双形态的 PR 验证收据。
 *
 * @param {object|null} task
 * @param {{ includeFilesLimit?: number }} [options]
 */
export function buildVerificationReceipt(task, options = {}) {
  if (!task || typeof task !== "object") {
    return {
      ok: false,
      reason: "no-task",
      markdown: "当前没有可生成验证收据的任务。",
      unverified: ["无活跃任务"],
    };
  }

  const filesLimit = Number.isInteger(options.includeFilesLimit) && options.includeFilesLimit > 0
    ? options.includeFilesLimit : 30;
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const runs = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  const findings = Array.isArray(task.findings) ? task.findings : [];
  const criteria = Array.isArray(task.criteria) ? task.criteria : [];
  const diffAudits = task.lastDiffAudits && typeof task.lastDiffAudits === "object" ? task.lastDiffAudits : {};
  const prechecks = task.lastPrechecks && typeof task.lastPrechecks === "object" ? task.lastPrechecks : {};
  const mutations = task.lastMutations && typeof task.lastMutations === "object" ? task.lastMutations : {};

  const acceptedStages = runs.filter((r) => r?.status === "accepted").length;
  const totalReworks = runs.reduce((n, r) => n + Math.max(0, (r?.attempt ?? 1) - 1), 0);
  const openBlocking = findings.filter((f) => f && f.status !== "closed" && f.status !== "resolved" && f.severity === "blocking");
  const openAdvisory = findings.filter((f) => f && f.status !== "closed" && f.status !== "resolved" && f.severity !== "blocking");
  const waivedReviews = reviews.filter((r) => Boolean(r?.selfReviewed || r?.waived || r?.waiver));

  // 聚合全任务真实改动文件（去重）
  const changedFileMap = new Map();
  let totalAdded = 0;
  let totalRemoved = 0;
  const undeclaredSet = new Set();
  const outsideSet = new Set();
  const tamperWarnings = [];
  let hasAnyDiffAudit = false;
  let usedNonGitMode = false;
  let hadTruncatedDiff = false;

  for (const [sid, audit] of Object.entries(diffAudits)) {
    if (!audit || typeof audit !== "object") continue;
    hasAnyDiffAudit = true;
    if (audit.mode === "manifest") usedNonGitMode = true;
    if (audit.truncatedFiles) hadTruncatedDiff = true;
    totalAdded += Number(audit.totalAddedLines ?? 0);
    totalRemoved += Number(audit.totalRemovedLines ?? 0);
    for (const f of Array.isArray(audit.changedFiles) ? audit.changedFiles : []) {
      if (!f?.path) continue;
      changedFileMap.set(f.path, {
        path: f.path,
        status: f.status ?? "M",
        addedLines: Number(f.addedLines ?? 0),
        removedLines: Number(f.removedLines ?? 0),
        stageId: sid,
      });
    }
    for (const u of Array.isArray(audit.undeclaredFiles) ? audit.undeclaredFiles : []) undeclaredSet.add(u);
    for (const o of Array.isArray(audit.outsideWritePaths) ? audit.outsideWritePaths : []) outsideSet.add(o);
    for (const w of Array.isArray(audit.tamperScan?.warnings) ? audit.tamperScan.warnings : []) {
      tamperWarnings.push({ stageId: sid, ...w });
    }
  }

  // 逐阶段收据明细
  const stageRows = stages.map((st) => {
    const run = runs.find((r) => r?.stageId === st.id);
    const audit = diffAudits[st.id] ?? null;
    const pre = run?.lastPrecheck ?? prechecks[st.id] ?? null;
    const mut = mutations[st.id] ?? null;
    const latestReport = run?.reports?.at(-1) ?? null;
    const recon = audit
      ? computeRetraceReconciliation({ diffAudit: audit, report: latestReport, stageDef: st, criteria })
      : null;
    const stageReviews = reviews.filter((r) => r?.scope?.kind === "stage" && r?.scope?.stageId === st.id);
    const lastRev = stageReviews.at(-1) ?? null;
    return {
      stageId: st.id,
      title: st.title ?? st.id,
      status: run?.status ?? "pending",
      attempt: run?.attempt ?? 0,
      diffCount: audit?.totalChangedFiles ?? 0,
      undeclaredCount: audit?.undeclaredFiles?.length ?? 0,
      precheck: summarizePrecheck(pre),
      reviewVerdict: lastRev ? `${lastRev.verdict}${(lastRev.selfReviewed || lastRev.waived || lastRev.waiver) ? "(waived)" : ""}` : "未审",
      retraceStatus: recon?.status ?? "n/a",
      mutationScore: mut && typeof mut.mutationScore === "number" ? `${Math.round(mut.mutationScore * 100)}% (${mut.killed}/${mut.total})` : null,
      citationsVerified: (latestReport?.evidenceFiles?.length ?? 0),
      receiptsVerified: (latestReport?.bindings ?? []).reduce((n, b) => n + (b?.receipt ? 1 : (b?.receipts?.length ?? 0)), 0),
    };
  });

  // 显式诚实列出 UNVERIFIED / 边界与假设（绝不隐瞒）
  const unverified = [];
  if (task.phase !== "completed") {
    unverified.push(`任务尚未进入 completed 终态（当前 phase=${task.phase}），整体验收尚未闭环。`);
  }
  if (!hasAnyDiffAudit) {
    unverified.push("未记录宿主真实工作区 Diff 审计（可能已关闭 enableDiffAudit 或尚未上报阶段）。");
  }
  if (usedNonGitMode) {
    unverified.push("工作区为非 Git 目录，Diff 审计基于 SHA-256 文件清单模式（已跳过符号链接与超大二进制文件）。");
  }
  if (hadTruncatedDiff) {
    unverified.push("部分阶段改动文件数超过单次摘要展示上限，请结合完整 git diff 复核全量变更。");
  }
  if (task.expressPlanReviewSkipped) {
    unverified.push("低风险 express 档跳过了计划期独立审查（仍保留阶段实施审查）。");
  }
  if (waivedReviews.length > 0) {
    unverified.push(`存在 ${waivedReviews.length} 轮人工放行（waived）审查，对应裁决未经独立审查子会话完成。`);
  }
  const stagesWithoutPrecheck = stages.filter((s) => !prechecks[s.id] && !runs.find((r) => r?.stageId === s.id)?.lastPrecheck);
  if (stagesWithoutPrecheck.length > 0) {
    unverified.push(`以下阶段未执行确定性前置检查命令：${stagesWithoutPrecheck.map((s) => s.id).join("、")}。`);
  }
  if (undeclaredSet.size > 0) {
    unverified.push(`存在未在 evidenceRefs 中声明的真实改动文件：${[...undeclaredSet].slice(0, 10).join("、")}。`);
  }
  if (outsideSet.size > 0) {
    unverified.push(`存在超出声明 writePaths 写域的真实改动文件：${[...outsideSet].slice(0, 10).join("、")}。`);
  }
  if (tamperWarnings.length > 0) {
    unverified.push(`防改测试扫描产出 ${tamperWarnings.length} 条软告警（如断言弱化/跳过标记），请人工确认属合法变更。`);
  }
  if (openBlocking.length > 0 || openAdvisory.length > 0) {
    unverified.push(`仍有未关闭整改项：blocking ${openBlocking.length} 条、advisory ${openAdvisory.length} 条。`);
  }
  if (task.ambiguityReport?.hasAmbiguity) {
    unverified.push(`前置澄清门仍有 ${task.ambiguityReport.questions?.length ?? 0} 项未决澄清问题。`);
  }
  if (Object.keys(mutations).length === 0) {
    unverified.push("未启用 Diff 范围增量变异测试（默认关闭，仅核验现有测试退出码与防篡改规则）。");
  }
  if (task.mcpSchemaAlerts?.length > 0) {
    unverified.push(`检测到 ${task.mcpSchemaAlerts.length} 条外部 MCP 工具 Schema 漂移告警，请核对工具来源。`);
  }

  const rigorTier = task.rigor?.tier ?? "standard";
  const allChanged = [...changedFileMap.values()];
  const mdLines = [
    `## Mentor Verification Receipt · \`${task.id}\``,
    "",
    `- **目标**：${mdEscapeInline(task.objective)}`,
    `- **状态**：\`${task.phase}\` · 计划 \`v${task.planVersion ?? 0}\` · 严格度 \`${rigorTier}\` · 阶段通过 \`${acceptedStages}/${stages.length}\` · 总返工 \`${totalReworks}\` 次`,
    `- **宿主真实改动**：${hasAnyDiffAudit ? `${allChanged.length} 个文件（\`+${totalAdded} / -${totalRemoved}\` 行）` : "无记录"}${undeclaredSet.size ? ` · ⚠ 未声明 ${undeclaredSet.size} 个` : ""}${outsideSet.size ? ` · ⚠ 越写域 ${outsideSet.size} 个` : ""}`,
    `- **防改测试扫描**：${tamperWarnings.length === 0 ? "通过（0 硬拦截 / 0 软告警）" : `0 硬拦截 / ${tamperWarnings.length} 软告警`}`,
    `- **独立审查记录**：共 ${reviews.length} 轮（人工放行 ${waivedReviews.length} 轮），未关闭问题 blocking ${openBlocking.length} / advisory ${openAdvisory.length}`,
    "",
  ];

  if (stageRows.length > 0) {
    mdLines.push("### 阶段核验明细");
    mdLines.push("");
    mdLines.push("| 阶段 | 状态 | 尝试 | 真实改动 | 前置硬检查 | 独立审查 | RETRACE 对账 | 变异得分 |");
    mdLines.push("|---|---|---:|---:|---|---|---|---|");
    for (const row of stageRows) {
      mdLines.push(
        `| \`${row.stageId}\` ${mdEscapeInline(row.title)} | \`${row.status}\` | ${row.attempt} | ${row.diffCount}${row.undeclaredCount ? ` (未声明 ${row.undeclaredCount})` : ""} | ${mdEscapeInline(row.precheck)} | ${mdEscapeInline(row.reviewVerdict)} | \`${row.retraceStatus}\` | ${row.mutationScore ?? "-"} |`,
      );
    }
    mdLines.push("");
  }

  if (allChanged.length > 0) {
    mdLines.push("### 宿主观测到的真实改动文件");
    mdLines.push("");
    for (const f of allChanged.slice(0, filesLimit)) {
      const flags = [
        undeclaredSet.has(f.path) ? "⚠未声明" : "",
        outsideSet.has(f.path) ? "⚠越写域" : "",
      ].filter(Boolean).join(" ");
      mdLines.push(`- \`${f.status}\` \`${f.path}\` (+${f.addedLines}/-${f.removedLines})${flags ? ` — ${flags}` : ""}`);
    }
    if (allChanged.length > filesLimit) {
      mdLines.push(`- … 另有 ${allChanged.length - filesLimit} 个文件省略`);
    }
    mdLines.push("");
  }

  mdLines.push("### UNVERIFIED / 边界与假设（明确未核验项）");
  mdLines.push("");
  if (unverified.length === 0) {
    mdLines.push("- 无额外未核验边界（全部阶段已通过宿主 Diff 审计、前置硬检查、独立审查与整体验收）。");
  } else {
    for (const item of unverified) mdLines.push(`- ${item}`);
  }

  return {
    ok: true,
    taskId: task.id,
    phase: task.phase,
    rigor: rigorTier,
    acceptedStages,
    totalStages: stages.length,
    totalReworks,
    changedFilesCount: allChanged.length,
    totalAddedLines: totalAdded,
    totalRemovedLines: totalRemoved,
    undeclaredFiles: [...undeclaredSet],
    outsideWritePaths: [...outsideSet],
    tamperWarningsCount: tamperWarnings.length,
    stageRows,
    unverified,
    markdown: mdLines.join("\n"),
    generatedAt: Date.now(),
  };
}
