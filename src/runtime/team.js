import { randomUUID } from "node:crypto";
import { ERR, MentorError } from "../errors.js";
import { readyNodes, reviewOrderConflict, reviewOrderMessage } from "../plan/dag.js";
import { isRetryableReview } from "../review/job-scope.js";
import { executionWaves, recommendParallelBatch } from "../plan/parallelism.js";

const brief = (value, limit = 1200) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const currentRuns = task => new Map((task.nodeRuns ?? []).map(run => [run.stageId, run]));
const phaseAllowsWork = task => task && task.enabled !== false && ["active", "reviewing"].includes(task.phase) &&
  task.approvedPlanVersion === task.planVersion && !task.pendingCheckpoint;

export function recommendWork({ independentOutputs = 0, unknownCause = false, verifier = "",
  stages, requiresIndependentReview = false } = {}, maxParallel) {
  if (verifier === "review-recovery" && !requiresIndependentReview) return { mode: "direct", tool: "mentor_verify_review_recovery" };
  if (unknownCause) return { mode: "diagnosis", requiresIndependentReview, next: "先找能区分原因的观察。只有能独立取得不同证据时才分派。" };
  const layout = stages?.length ? executionWaves(stages, maxParallel) : null;
  if (layout?.leftover.length) return { mode: "planning", next: "先核对阶段依赖，当前计划有无法启动的阶段。" };
  const width = layout?.maxWidth ?? Math.min(independentOutputs, maxParallel ?? Infinity);
  if (width > 1) return { mode: "team", tool: "mentor_team_start", parallelStages: layout?.waves.find(wave => wave.length > 1),
    next: "并行派发可独立产出结果的阶段，串行链保留在同一阶段内。" };
  if (requiresIndependentReview) return { mode: "supervised", tool: "mentor_task_create",
    next: "由主会话执行，按用户要求提交独立审查。" };
  return { mode: "direct", next: "由当前会话完成改动并核对用户要求。" };
}

export function teamBatch(task, limit, settling = []) {
  if (!task?.team?.enabled || !phaseAllowsWork(task) || reviewOrderConflict(task)) return [];
  const runs = currentRuns(task);
  const blocked = new Set((task.findings ?? []).filter(f => f.status === "open" && f.severity === "blocking").map(f => f.stageId));
  const ready = readyNodes(task.stages, task.nodeRuns).filter(id => !task.team.directions?.[id]?.hold &&
    !blocked.has(id) && (!runs.get(id)?.failedReason || runs.get(id).failedReason === "任务已由用户停止"));
  // Reserve a writable area until review has consumed the worker's evidence.
  const running = [...new Set([...settling, ...[...runs.values()]
    .filter(run => ["running", "reported", "awaiting-integration"].includes(run.status)).map(run => run.stageId)])];
  return recommendParallelBatch(task.stages, ready, running, limit).stageIds;
}

export function updateTeam(store, patch) {
  const task = store.get();
  if (!task) throw new MentorError(ERR.NO_TASK, "当前没有任务");
  const team = { ...(task.team ?? {}), ...patch };
  store.set({ ...task, team, revision: task.revision + 1, updatedAt: Date.now() });
  return team;
}

export function changeDirection(store, { stageId, direction, hold = false }) {
  const task = store.get();
  if (!task?.stages?.some(stage => stage.id === stageId)) throw new MentorError(ERR.STAGE_UNKNOWN, "找不到要调整的阶段");
  if (["archived", "completed"].includes(task.phase)) throw new MentorError(ERR.TASK_INACTIVE, "任务已经结束");
  const text = brief(direction);
  if (!text) throw new MentorError(ERR.EVIDENCE_REQUIRED, "请说明调整方向");
  const entry = { text, hold: hold === true, at: Date.now() };
  const run = currentRuns(task).get(stageId);
  if (run?.status === "reported") throw new MentorError(ERR.REVIEW_PENDING, "该阶段正在审查，请先取得裁决");
  if (run?.status === "accepted") throw new MentorError(ERR.ILLEGAL_TRANSITION, "阶段已通过，修改已验收结果请先明确返工");
  const team = updateTeam(store, { issue: null, directions: { ...task.team?.directions, [stageId]: entry } });
  if (run?.status === "rework" && run.failedReason && !entry.hold) {
    const current = store.get();
    store.set({ ...current, nodeRuns: current.nodeRuns.map(item => item.stageId === stageId
      ? { ...item, failedReason: null } : item) });
  }
  return { team, entry, running: run?.status === "running" };
}

export function recordTeamNote(store, args, origin = {}) {
  const task = store.get();
  const text = brief(args.text);
  const evidence = brief(args.evidence) || (origin.receipts ?? []).map(r=>r.callId ?? r.sessionId+"#"+r.firstHeaderSeq).join("、");
  const kind = args.kind;
  if (!text || !["artifact", "hypothesis", "decision", "observation"].includes(kind)) {
    throw new MentorError(ERR.EVIDENCE_REQUIRED, "请说明事项类型和内容");
  }
  if (["artifact", "observation"].includes(kind) && !evidence) {
    throw new MentorError(ERR.EVIDENCE_REQUIRED, "请提供产物位置、复现步骤或工具回执编号");
  }
  const toStageId = args.toStageId || null;
  if (toStageId && !task.stages?.some(stage => stage.id === toStageId)) throw new MentorError(ERR.STAGE_UNKNOWN, "找不到接收阶段");
  const nextCheck = brief(args.nextCheck);
  if (kind === "hypothesis" && !nextCheck) throw new MentorError(ERR.EVIDENCE_REQUIRED, "请填写能推翻该假设的下一步观察");
  const hypothesisId = args.hypothesisId || null;
  const outcome = hypothesisId ? args.outcome : null;
  if (hypothesisId) {
    const hypothesis = teamContext(task, origin.stageId ?? toStageId).hypotheses.find(note => note.id === hypothesisId);
    if (kind !== "observation" || !hypothesis || !["supports", "refutes", "inconclusive"].includes(outcome)) {
      throw new MentorError(ERR.EVIDENCE_UNKNOWN, "观察须引用当前可见假设，并标明支持、推翻或证据不足");
    }
  }
  const replaces = args.replaces || null;
  if (replaces) {
    const previous = task.team?.notes?.find(n => n.id === replaces);
    if (!hypothesisId || previous?.kind !== "observation" || previous.planVersion !== task.planVersion ||
        previous.stageId !== (origin.stageId ?? null) || previous.attempt !== (origin.attempt ?? null) ||
        previous.hypothesisId !== hypothesisId || previous.toStageId !== toStageId) {
      throw new MentorError(ERR.EVIDENCE_UNKNOWN, "只能更正自己在同一阶段、尝试和假设下发布给同一接收方的观察");
    }
  }
  let onRefuted;
  if (args.onRefuted) {
    const rule = args.onRefuted;
    if (origin.stageId || kind !== "hypothesis" || !task.stages?.some(s => s.id === rule.stageId) ||
        !task.criteria?.some(c => c.id === rule.criterionId && c.observe) ||
        !["hold","redirect"].includes(rule.action) || !brief(rule.direction))
      throw new MentorError(ERR.REVIEW_SCOPE,"撤线规则须由主会话在提出假设时绑定目标阶段、宿主回执验收项和后续方向");
    onRefuted = {stageId:rule.stageId,criterionId:rule.criterionId,action:rule.action,direction:brief(rule.direction)};
  }
  const receipts = origin.receipts ?? [];
  const prior = (task.team?.notes ?? []).at(-1);
  if (prior?.planVersion === task.planVersion && prior.stageId === (origin.stageId ?? null) &&
      prior.attempt === (origin.attempt ?? null) && prior.kind === kind && prior.text === text &&
      prior.evidence === evidence && JSON.stringify(prior.onRefuted) === JSON.stringify(onRefuted) &&
      JSON.stringify(prior.receipts ?? []) === JSON.stringify(receipts) && prior.toStageId === toStageId && prior.nextCheck === nextCheck &&
      (prior.replaces ?? null) === replaces && (prior.hypothesisId ?? null) === hypothesisId && (prior.outcome ?? null) === outcome) return prior;
  const note = { id: randomUUID(), at: Date.now(), planVersion: task.planVersion, stageId: origin.stageId ?? null,
    attempt: origin.attempt ?? null, kind, text, evidence, nextCheck, toStageId,
    ...(onRefuted ? {onRefuted} : {}), ...(receipts.length ? {receipts} : {}),
    ...(hypothesisId ? { hypothesisId, outcome } : {}), ...(replaces ? { replaces } : {}) };
  updateTeam(store, { notes: [...(task.team?.notes ?? []), note].slice(-60) });
  return note;
}

export function teamContext(task, stageId) {
  const runs = currentRuns(task);
  const visible = (task.team?.notes ?? []).filter(note => note.planVersion === task.planVersion &&
    (!note.stageId || (runs.get(note.stageId)?.attempt === note.attempt &&
      !["rework", "pending"].includes(runs.get(note.stageId)?.status))) &&
    (!stageId || !note.toStageId || note.toStageId === stageId || note.stageId === stageId));
  const notes = visible.slice(-12);
  const stage = task.stages?.find(item => item.id === stageId);
  const dependencies = (stage?.dependsOn ?? []).map(id => {
    const run = runs.get(id);
    const report = run?.reports?.at(-1);
    return { stageId: id, status: run?.status, reportId: report?.id, summary: report?.summary,
      files: (report?.evidenceFiles ?? []).map(file => file.file) };
  });
  const replaced = new Set(visible.map(note => note.replaces).filter(Boolean));
  const hypotheses = visible.filter(note => note.kind === "hypothesis").map(note => {
    const findings = visible.filter(item => item.hypothesisId === note.id && item.outcome !== "inconclusive" && !replaced.has(item.id));
    const outcomes = new Set(findings.map(item => item.outcome));
    return { id: note.id, text: note.text, nextCheck: note.nextCheck, ...(note.onRefuted ? {onRefuted:note.onRefuted} : {}), evidenceIds: findings.map(item => item.id),
      ...(outcomes.size > 1 ? { observations: findings.map(({id,stageId,outcome,evidence}) => ({id,stageId,outcome,evidence})) } : {}),
      status: outcomes.size > 1 ? "conflicting" : findings.at(-1)?.outcome ?? "unconfirmed" };
  });
  return { direction: task.team?.directions?.[stageId] ?? null, notes, dependencies, hypotheses,
    routes:(task.team?.routes??[]).filter(r=>r.planVersion===task.planVersion && (!stageId||r.stageId===stageId)).slice(-8) };
}

export function noteRecipients(task, note) {
  const ids = new Set([note.toStageId].filter(Boolean));
  if (note.kind === "observation" || note.kind === "artifact") {
    for (const stage of task.stages ?? []) {
      const consumes = stage.dependsOn?.includes(note.stageId) ||
        note.receipts?.some(r => stage.criterionIds?.includes(r.criterionId));
      if (!note.toStageId && consumes) ids.add(stage.id);
    }
    const hypothesis = teamContext(task).hypotheses.find(h => h.id === note.hypothesisId);
    if (hypothesis?.onRefuted && (!note.toStageId || note.toStageId === hypothesis.onRefuted.stageId)) ids.add(hypothesis.onRefuted.stageId);
    if (hypothesis?.status === "conflicting") for (const o of hypothesis.observations) if (o.stageId) ids.add(o.stageId);
  }
  if (!note.hypothesisId || !teamContext(task).hypotheses.some(h => h.id===note.hypothesisId && h.status==="conflicting")) ids.delete(note.stageId);
  return [...ids];
}

export function applyEvidenceDirection(store,note) {
  if (!note.hypothesisId) return null;
  const task=store.get(), hypothesis=teamContext(task).hypotheses.find(h=>h.id===note.hypothesisId);
  const rule=hypothesis?.onRefuted;
  if (!rule || note.toStageId && note.toStageId!==rule.stageId) return null;
  const run=currentRuns(task).get(rule.stageId);
  if (["awaiting-integration","reported","accepted"].includes(run?.status)) return null;
  const prior=task.team.directions?.[rule.stageId];
  if (prior?.evidenceNoteId===note.id || task.team.routes?.some(r=>r.noteId===note.id)) return null;
  const retract = prior?.hypothesisId===hypothesis.id && hypothesis.status!=="refutes";
  const refuted = hypothesis.status==="refutes" && note.outcome==="refutes" &&
    note.receipts?.some(r=>r.criterionId===rule.criterionId) && (!prior || prior.hypothesisId===hypothesis.id);
  if (!refuted && !retract) return null;
  const direction = retract ? "原撤线依据发生变化，按原计划复核："+hypothesis.nextCheck : rule.direction;
  const change=changeDirection(store,{stageId:rule.stageId,direction,hold:!retract && rule.action==="hold"});
  const current=store.get(), entry={...change.entry,evidenceNoteId:note.id,hypothesisId:hypothesis.id};
  const route={stageId:rule.stageId,noteId:note.id,hypothesisId:hypothesis.id,planVersion:task.planVersion,
    action:retract?"recheck":rule.action,direction,at:entry.at};
  updateTeam(store,{directions:{...current.team.directions,[rule.stageId]:entry},routes:[...(current.team.routes??[]),route].slice(-60)});
  return {...route,running:change.running};
}

export function teamAttention(task) {
  if (!task?.team?.enabled) return null;
  const action = (owner, text, waiting = false) => ({ owner, text, waiting });
  if (task.phase === "archived") return action("none", "任务已归档");
  if (task.phase === "completed") return action("main", "整体验收已通过，主会话可交付结果");
  if (task.enabled === false || task.phase === "paused") return action("user", "任务已停止，等待恢复");
  if (task.phase === "awaiting-approval") return action("user", "计划已审查，等待你批准执行");
  const jobs = (task.reviewJobs ?? []).filter(j => j.planVersion === task.planVersion);
  const failed = jobs.find(j => isRetryableReview(task, j));
  if (failed) return action("main", "审查失败，需核对后重试：" + (failed.error || failed.stageId));
  const conflict = reviewOrderConflict(task);
  if (conflict && !task.pendingCheckpoint) return action("main",reviewOrderMessage(conflict));
  if (task.team.issue) return action("main", task.team.issue);
  const pending = jobs.filter(j => ["running", "queued"].includes(j.status));
  if (task.pendingCheckpoint && pending.some(j => j.kind === task.pendingCheckpoint.kind)) {
    return action("reviewer", task.pendingCheckpoint.kind === "completion" ? "独立审查员正在整体验收" : "独立审查员正在审查计划", true);
  }
  const runs = task.nodeRuns ?? [];
  const manual = runs.find(r => (r.status === "running" && !r.batchId && !r.workerSessionId) ||
    (r.status === "awaiting-integration" && !r.batchId) ||
    (r.status === "rework" && !task.team.directions?.[r.stageId]?.hold && r.failedReason && r.failedReason !== "任务已由用户停止"));
  if (manual) return action("main", "阶段 " + manual.stageId + " 需要主会话处理" + (manual.failedReason ? "：" + manual.failedReason : ""));
  const blocked = (task.findings ?? []).find(f => f.status === "open" && f.severity === "blocking");
  if (blocked) return action("main", "需要处理审查意见：" + (blocked.text || blocked.id));
  const workers = runs.filter(r => r.status === "running" && (r.batchId || r.workerSessionId));
  if (workers.length) return action("worker", "阶段执行中：" + workers.map(r => r.stageId).join("、"), true);
  if (pending.length) return action("reviewer", "独立审查中：" + pending.map(j => j.stageId).join("、"), true);
  const held = Object.entries(task.team.directions ?? {}).filter(([,entry]) => entry.hold);
  if (held.length) return action("user", "阶段已暂缓，等待调整方向：" + held.map(([id]) => id).join("、"));
  return action("main", task.phase === "planning" ? "主会话准备执行计划" : "主会话核对下一步");
}

export function teamOverview(task) {
  if (!task?.team) return undefined;
  const runs = currentRuns(task);
  const steps = (task.stages ?? []).map(stage => ({
    id: stage.id, title: stage.title || stage.id, owner: runs.get(stage.id)?.workerSessionId || null,
    status: runs.get(stage.id)?.status || "pending",
    error: runs.get(stage.id)?.failedReason || null,
    startedAt: runs.get(stage.id)?.startedAt || null,
    finishedAt: runs.get(stage.id)?.completedAt || null,
    waitingOn: (stage.dependsOn ?? []).filter(id => runs.get(id)?.status !== "accepted"),
    direction: task.team.directions?.[stage.id] ?? null,
  }));
  const { notes, hypotheses } = teamContext(task);
  return { mode: task.team.mode ?? "team", enabled: task.team.enabled === true,
    routes:(task.team.routes ?? []).filter(r=>r.planVersion===task.planVersion), issue: task.team.issue ?? null, attention: teamAttention(task), steps, notes, hypotheses };
}
