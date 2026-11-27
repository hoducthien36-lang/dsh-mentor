/**
 * v0.4 · 跨会话接班机制（Cross-Session Shift Handoff & Atomic Ownership Takeover）
 *
 * 借鉴 Anthropic 长任务框架 + Beads 持久化账本：
 *   1. `buildShiftHandoff(task)` 生成精简（≤4KB）、无失忆的交接简报（结构化 + Markdown）；
 *   2. `takeoverTaskSession(...)` 以原子所有权迁移方式将任务交接给新会话：
 *      - 先取消旧会话在途子代理（防止旧回调回写）；
 *      - 校验目标会话没有进行中的冲突任务；
 *      - 递增 `ownershipGeneration` 与 `revision` 并留痕 `sessionHistory[]`；
 *      - 写入目标 store 并清空旧 store 指针，杜绝双主脑裂。
 */

import { ERR, MentorError } from "../errors.js";
import { readyNodes } from "../plan/dag.js";
import { computeNextStep } from "../state/guard.js";
import { PHASES } from "../state/machine.js";

const HANDOFF_MD_CAP = 3200;
const takeoverLocks = new WeakMap();

function serializeTakeover(registry, fn) {
  if (!registry || typeof registry !== "object") return fn();
  const prev = takeoverLocks.get(registry) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  takeoverLocks.set(registry, next.catch(() => {}));
  return next;
}

/** 为任意任务生成结构化 + Markdown 交接简报（纯函数）。 */
export function buildShiftHandoff(task) {
  if (!task || !task.id) return null;
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const runs = Array.isArray(task.nodeRuns) ? task.nodeRuns : [];
  const runById = new Map(runs.map((r) => [r?.stageId, r]));
  const acceptedStageIds = stages
    .filter((s) => runById.get(s.id)?.status === "accepted")
    .map((s) => s.id);
  const readyStageIds = readyNodes(stages, runs);
  const remainingStageIds = stages
    .filter((s) => runById.get(s.id)?.status !== "accepted")
    .map((s) => s.id);

  const openFindings = (task.findings ?? [])
    .filter((f) => f && f.status !== "closed")
    .slice(-8)
    .map((f) => ({
      id: f.id,
      stageId: f.stageId ?? null,
      severity: f.severity ?? "advisory",
      status: f.status ?? "open",
      text: String(f.text ?? "").slice(0, 200),
    }));

  const failedPrechecks = Object.entries(task.lastPrechecks ?? {})
    .filter(([, p]) => p && p.ok === false)
    .map(([stageId, p]) => ({
      stageId,
      failed: p.failed ?? 0,
      total: p.total ?? 0,
      labels: (p.results ?? []).filter((r) => !r.ok).map((r) => r.label).slice(0, 4),
    }));

  const nextStep = computeNextStep(task);
  const takeoverCommand = `/mentor takeover ${task.id}`;
  const generatedAt = Date.now();

  const lines = [
    `## 导师任务交接简报（${task.id}）`,
    `- **目标**：${String(task.objective ?? "").slice(0, 240)}`,
    `- **当前状态**：${task.phase} · 计划 v${task.planVersion ?? 0}（已批准 v${task.approvedPlanVersion ?? 0}）· revision ${task.revision ?? 0}`,
    `- **阶段进度**：已通过 ${acceptedStageIds.length}/${stages.length}（${acceptedStageIds.length ? acceptedStageIds.join("、") : "无"}）；当前就绪：${readyStageIds.length ? readyStageIds.join("、") : "无"}；待完成：${remainingStageIds.length ? remainingStageIds.join("、") : "无"}`,
    `- **下一步**：${nextStep.text}`,
  ];
  if (openFindings.length) {
    lines.push(`- **未关闭问题（${openFindings.length}）**：`);
    for (const f of openFindings.slice(0, 5)) {
      lines.push(`  - [${f.severity}/${f.status}] ${f.stageId ? f.stageId + " · " : ""}${f.id}：${f.text}`);
    }
  }
  if (failedPrechecks.length) {
    lines.push(`- **最近失败的前置硬检查**：${failedPrechecks.map((p) => `${p.stageId}(${p.labels.join("/")})`).join("；")}`);
  }
  if (task.continuation?.kind === "rework-circuit-breaker") {
    lines.push(`- **熔断提醒**：${task.continuation.summary}`);
  }
  lines.push(`- **在新会话接班**：发送 \`${takeoverCommand}\`，再调用 \`mentor_task_status\` 继续推进。`);

  let markdown = lines.join("\n");
  if (markdown.length > HANDOFF_MD_CAP) {
    markdown = markdown.slice(0, HANDOFF_MD_CAP - 16) + "\n…(truncated)";
  }

  return {
    version: 1,
    taskId: task.id,
    objective: String(task.objective ?? "").slice(0, 240),
    phase: task.phase,
    planVersion: task.planVersion ?? 0,
    approvedPlanVersion: task.approvedPlanVersion ?? null,
    mainSessionId: task.mainSessionId ?? null,
    ownershipGeneration: Number.isInteger(task.ownershipGeneration) ? task.ownershipGeneration : 0,
    workspaceRoot: task.workspaceRoot ?? null,
    progress: {
      accepted: acceptedStageIds.length,
      total: stages.length,
      acceptedStageIds,
      readyStageIds,
      remainingStageIds,
    },
    openFindings,
    failedPrechecks,
    nextStep,
    takeoverCommand,
    generatedAt,
    markdown,
  };
}

/**
 * 原子跨会话接管：将 sourceStore 中的任务迁移到 targetSessionId 对应的会话 store。
 * 保证无双主写入、旧运行态先停止、迁移可幂等重试。
 */
export async function takeoverTaskSession({
  registry,
  sourceStore,
  targetSessionId,
  reason = "shift-handoff",
  cancelSourceRuntime,
}) {
  if (!targetSessionId || typeof targetSessionId !== "string" || !targetSessionId.trim()) {
    throw new MentorError(ERR.REVIEW_IDENTITY, "接班需要有效的目标会话标识（sessionId）");
  }
  const targetSid = targetSessionId.trim();

  return serializeTakeover(registry, async () => {
    const task = sourceStore?.get?.();
    if (!task) {
      throw new MentorError(ERR.NO_TASK, "找不到要接管的任务");
    }
    if (task.phase === PHASES.ARCHIVED || task.phase === PHASES.COMPLETED) {
      throw new MentorError(ERR.ILLEGAL_TRANSITION, `终态任务（${task.phase}）无需跨会话接班`, {
        taskId: task.id,
        phase: task.phase,
      });
    }

    // 幂等：当前会话已经是任务主会话
    if (task.mainSessionId === targetSid) {
      return {
        ok: true,
        value: {
          taskId: task.id,
          mainSessionId: targetSid,
          ownershipGeneration: Number.isInteger(task.ownershipGeneration) ? task.ownershipGeneration : 0,
          duplicate: true,
          handoff: buildShiftHandoff(task),
        },
      };
    }

    const assertTargetAvailable = () => {
      const existingTargetStore = registry.findSession?.(targetSid);
      const existingTargetTask = existingTargetStore?.get?.();
      if (existingTargetTask && existingTargetTask.id !== task.id &&
          ![PHASES.ARCHIVED, PHASES.COMPLETED].includes(existingTargetTask.phase)) {
        throw new MentorError(
          ERR.TASK_EXISTS,
          `目标会话已有进行中的任务（${existingTargetTask.id}），请先归档或完成该任务后再接班`,
          { targetSessionId: targetSid, existingTaskId: existingTargetTask.id, existingPhase: existingTargetTask.phase },
        );
      }
      return existingTargetTask;
    };

    assertTargetAvailable();
    const initialGeneration = Number.isInteger(task.ownershipGeneration) ? task.ownershipGeneration : 0;

    // 先取消旧会话上仍在运行的子代理，防止旧回调继续回写旧 store
    if (typeof cancelSourceRuntime === "function") {
      await cancelSourceRuntime(sourceStore, task.id, "session-takeover");
    }

    const latest = sourceStore.get();
    const latestGeneration = Number.isInteger(latest?.ownershipGeneration) ? latest.ownershipGeneration : 0;
    if (!latest || latest.id !== task.id || latestGeneration !== initialGeneration ||
        latest.phase === PHASES.ARCHIVED || latest.phase === PHASES.COMPLETED) {
      throw new MentorError(ERR.STALE_PLAN, "等待旧会话停止期间任务已变化，请刷新后重试");
    }

    // 锁内再次确认目标会话没有被并发占用
    const existingTargetTask = assertTargetAvailable();

    const now = Date.now();
    const generation = latestGeneration + 1;
    const fromSessionId = latest.mainSessionId ?? null;
    const historyEntry = {
      fromSessionId,
      toSessionId: targetSid,
      at: now,
      reason: String(reason || "shift-handoff").slice(0, 200),
      generation,
    };
    const migrated = {
      ...latest,
      mainSessionId: targetSid,
      ownershipGeneration: generation,
      revision: (latest.revision ?? 0) + 1,
      updatedAt: now,
      sessionHistory: [...(latest.sessionHistory ?? []), historyEntry].slice(-20),
    };

    const targetStore = await registry.forSession(targetSid);
    const targetCurrent = targetStore.get?.();
    if (targetCurrent && targetCurrent.id !== task.id &&
        ![PHASES.ARCHIVED, PHASES.COMPLETED].includes(targetCurrent.phase)) {
      throw new MentorError(
        ERR.TASK_EXISTS,
        `目标会话已有进行中的任务（${targetCurrent.id}），请先归档或完成该任务后再接班`,
        { targetSessionId: targetSid, existingTaskId: targetCurrent.id, existingPhase: targetCurrent.phase },
      );
    }
    if (existingTargetTask && existingTargetTask.id !== task.id && typeof registry.archiveBeforeReplace === "function") {
      await registry.archiveBeforeReplace(targetStore);
    }

    // 必须先确认目标端落盘成功，再撤销源端所有权与磁盘文件（杜绝双主脑裂或写入失败丢任务）
    targetStore.set(migrated);
    if (typeof targetStore.flushStrict === "function") {
      await targetStore.flushStrict();
    } else {
      await targetStore.flush?.();
    }

    if (sourceStore !== targetStore) {
      if (typeof sourceStore.removePersisted === "function") {
        await sourceStore.removePersisted();
      } else {
        sourceStore.clear?.();
        await sourceStore.flush?.();
      }
    }

    return {
      ok: true,
      value: {
        taskId: migrated.id,
        fromSessionId,
        mainSessionId: targetSid,
        ownershipGeneration: generation,
        revision: migrated.revision,
        duplicate: false,
        handoff: buildShiftHandoff(migrated),
      },
    };
  });
}
