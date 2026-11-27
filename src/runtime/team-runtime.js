import { ERR, MentorError } from "../errors.js";
import { computeNextStep } from "../state/guard.js";
import { teamBatch, updateTeam } from "./team.js";
import { DEFAULT_MAX_PARALLEL } from "../tools/parallel.js";

const activeTasks = new WeakMap();

export function scheduleTeam(ctx, store, main, helpers) {
  const task = store.get();
  if (!task?.team?.enabled || task.enabled === false || !["active", "reviewing"].includes(task.phase) ||
      task.approvedPlanVersion !== task.planVersion || task.pendingCheckpoint) return [];
  const sessionId = task.mainSessionId;
  if (main?.session?.id !== sessionId) {
    let resolved;
    try { resolved = ctx.agents?.get?.(sessionId); } catch {}
    main = resolved?.agent ?? resolved;
  }
  if (!main?.session || !main.options?.model || !main.options.provider || !ctx.agents?.create) {
    if (!task.team.issue) updateTeam(store, { issue: "主会话或模型暂不可用，重新打开任务后可继续团队执行。" });
    return [];
  }
  if (task.team.mode === "diagnosis" && !task.team.notes?.some(note => note.kind === "hypothesis" && note.planVersion === task.planVersion)) {
    if (!task.team.issue) updateTeam(store, { issue: "先发布一个可证伪的假设，再启动诊断阶段。" });
    return [];
  }
  if (task.team.issue === "主会话或模型暂不可用，重新打开任务后可继续团队执行。" ||
      task.team.issue === "先发布一个可证伪的假设，再启动诊断阶段。") updateTeam(store, { issue: null });

  const current = () => {
    const latest = store.get();
    return latest?.id === task.id && latest.planVersion === task.planVersion && latest.team?.enabled &&
      latest.enabled !== false && ["active", "reviewing"].includes(latest.phase) ? latest : null;
  };
  const exec = { agent: main };
  const limit = store.settings?.maxParallelNodes ?? DEFAULT_MAX_PARALLEL;
  const inFlight = activeTasks.get(store) ?? new Map();
  activeTasks.set(store, inFlight);
  const selected = teamBatch(store.get(), limit, inFlight.values());
  const started = [];

  for (const stageId of selected) {
    const result = helpers.delegate(store, { taskId: task.id, stageIds: [stageId], team: true });
    if (!result.ok) {
      updateTeam(store, { issue: result.message });
      continue;
    }
    const binding = result.value;
    started.push(stageId);
    inFlight.set(binding.batchId, stageId);
    void settle(binding).catch(error => {
      if (current()) updateTeam(store, { issue: String(error?.message ?? error) });
    });
  }
  const latest = current();
  if (!latest || inFlight.size || computeNextStep(latest).code !== "READY_TO_COMPLETE" ||
      latest.team.completionRequestedVersion === latest.planVersion) return started;

  const reports = latest.nodeRuns.filter(run => run.status === "accepted").map(run => {
    const report = run.reports?.at(-1);
    return { stageId: run.stageId, reportId: report?.id, summary: report?.summary || report?.evidence?.slice(0, 400) };
  });
  let check;
  try { check = helpers.checkpoint(store, "completion", JSON.stringify(reports)); }
  catch (error) {
    if (error?.code === ERR.EVIDENCE_MISMATCH && error.details?.reopened === true && !error.details?.loopDetected && error.details?.changes?.length) {
      return [...started,...scheduleTeam(ctx,store,main,helpers)];
    }
    updateTeam(store, { issue: String(error?.message ?? error) });
    return started;
  }
  updateTeam(store, { completionRequestedVersion: latest.planVersion });
  void helpers.spawn(ctx, store, exec, check).catch(error => {
    if (current()) updateTeam(store, { issue: String(error?.message ?? error) });
  });
  return started;

  async function settle(binding) {
    let attentionReason;
    try {
      const result = await helpers.run(ctx, store, exec, binding);
      const stageId = binding.stageIds[0];
      const attempt = binding.dispatchPlan[0].attempt;
      const currentTask = current();
      if (!currentTask) return;
      const run = currentTask.nodeRuns.find(item => item.stageId === stageId);
      if (run?.status === "rework" && run.attempt === attempt + 1 && run.failedReason &&
          !currentTask.team.directions?.[stageId]?.hold) attentionReason = stageId + " 执行受阻：" + run.failedReason;
      if (run?.status !== "awaiting-integration" || run.batchId !== binding.batchId || run.attempt !== attempt) return;
      const worker = result.workers?.[0];
      if (!worker?.delivery) {
        attentionReason = stageId + " 已返回，等待主会话核对证据后上报。";
        updateTeam(store, { issue: attentionReason });
        return;
      }
      const report = helpers.report(store, { ...worker.delivery, taskId: task.id, stageId, attempt, planVersion: task.planVersion,
        integrationEvidence: "运行时已核对所属阶段、执行尝试和报告引用；实际交付结果由独立审查确认。" },
      { allowRuntimeEvidence: !(currentTask.stages.find(stage => stage.id === stageId)?.writePaths?.length) });
      if (!report.ok) {
        attentionReason = stageId + " 上报待处理：" + report.message;
        updateTeam(store, { issue: attentionReason });
        return;
      }
      const review = await helpers.spawn(ctx, store, exec, { kind: "stage", stageId, attempt });
      if (!review.queued && current()) updateTeam(store, { issue: stageId + " 审查派发失败：" + review.reason });
    } catch (error) {
      if (current()) {
        attentionReason = binding.stageIds[0] + " 执行失败：" + String(error?.message ?? error);
        updateTeam(store, { issue: attentionReason });
      }
    } finally {
      inFlight.delete(binding.batchId);
      if (current()) {
        const previousIssue = store.get().team.issue;
        scheduleTeam(ctx, store, main, helpers);
        const issue = store.get().team.issue;
        const reason = attentionReason || (issue !== previousIssue && issue);
        if (reason && store.settings?.autoWakeMain !== false) await helpers.continue(ctx, store, reason);
      }
    }
  }
}

export function requireWorkerAttempt(store, taskId, planVersion, stageId, attempt, sessionId) {
  const task = store.get();
  const run = task?.nodeRuns?.find(item => item.stageId === stageId);
  if (task?.id !== taskId || task.planVersion !== planVersion || run?.attempt !== attempt ||
      run.workerSessionId !== sessionId || run.status !== "running" || task.enabled === false || task.phase === "paused") {
    throw new MentorError(ERR.STALE_ATTEMPT, "阶段已暂停或当前执行尝试已改变");
  }
  return task;
}
