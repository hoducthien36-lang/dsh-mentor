import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ERR, MentorError } from "../errors.js";
import { collectDependents, validObservation } from "../plan/dag.js";
import { pathsOverlap } from "../tools/parallel.js";
import { workerDenial } from "./worker-denials.js";
import { readEvidenceText } from "./evidence-reader.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const invalid = (message, details) => { throw new MentorError(ERR.EVIDENCE_MISMATCH, message, details); };
export const MAX_AUTO_RECHECKS_PER_PLAN = 3;

function sameWorkspaceFile(root, a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (root) return path.relative(path.resolve(root, a), path.resolve(root, b)) === "";
  return pathsOverlap(a, b) && pathsOverlap(b, a) && a.replace(/\\/gu, "/") === b.replace(/\\/gu, "/");
}

function denialMatches(expectedError, message, denial) {
  if (message.trim() === expectedError) return true;
  const expectedDenial = workerDenial(expectedError);
  if (!denial || !expectedDenial) return false;
  return expectedDenial.reason === expectedDenial.code
    ? denial.code === expectedDenial.code
    : denial.reason === expectedDenial.reason;
}

// Only host results paired with a preceding call in this worker session count.
// Store the host coordinates and digest, never arbitrary file contents or tool arguments.
export function captureReceipts(events, criteria, sessionId, root) {
  const wanted = criteria.filter(c => validObservation(c.observe));
  if (!wanted.length || !sessionId) return [];
  const calls = new Map(), receipts = new Map(), headers = [], called = new Set();
  let incompleteInventory = false;
  for (const event of events) {
    const d = event.data ?? {};
    if (event.type === "request/header") {
      const names = d.header?.tools?.map?.(t => t?.name ?? t?.function?.name);
      if (Array.isArray(names) && names.every(n => typeof n === "string")) headers.push({seq:event.seq,names});
      else incompleteInventory = true;
    }
    if (event.type === "tool/call" && d.callId) {
      calls.set(d.callId,{...d,seq:event.seq});
      called.add(d.name);
    }
    const m = d.message;
    if (event.type !== "tool/result" || typeof m?.isError !== "boolean") continue;
    const id = m.toolCallId ?? m.source?.callId;
    const call = calls.get(id);
    if (!call) continue;
    let args;
    try { args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments; } catch { continue; }
    const target = args?.file_path ?? args?.path;
    const message = (m.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
    for (const {id: criterionId, observe} of wanted) {
      if (receipts.has(criterionId) || observe.tool !== call.name || observe.outcome !== (m.isError ? "error" : "success")) continue;
      if (observe.target && (typeof target !== "string" || path.relative(path.resolve(root, observe.target), path.resolve(root, target)) !== "")) continue;
      const denial = m.isError ? workerDenial(message) : null;
      if (observe.errorCode && denial?.code !== observe.errorCode) continue;
      if (observe.errorContains && !message.includes(observe.errorContains)) continue;
      if (observe.error && !denialMatches(observe.error, message, denial)) continue;
      receipts.set(criterionId, { criterionId, sessionId, callId:id, callSeq:call.seq, resultSeq:event.seq,
        tool:call.name, outcome:observe.outcome, ...(observe.target ? {target:observe.target} : {}),
        ...(observe.error ? {error:observe.error} : {}),
        ...(observe.errorContains ? {errorContains:observe.errorContains} : {}),
        ...(denial ? {errorCode:denial.code, errorText:message.trim()} : {}), sha256:digest(message) });
    }
    calls.delete(id);
  }
  for (const {id:criterionId,observe} of wanted) {
    if (observe.outcome === "unavailable" && !incompleteInventory && !called.has(observe.tool) && headers.length && headers.every(h => !h.names.includes(observe.tool))) {
      receipts.set(criterionId, {criterionId,sessionId,tool:observe.tool,outcome:"unavailable",
        firstHeaderSeq:headers[0].seq,lastHeaderSeq:headers.at(-1).seq,headerCount:headers.length});
    }
  }
  return [...receipts.values()];
}

export function captureMainReceipts(task, args, sid, events) {
  if (!task || !sid || sid !== task.mainSessionId) {
    if (args?.receiptCallIds?.length) {
      throw new MentorError(ERR.EVIDENCE_UNKNOWN, "主会话回执需要绑定本次已开始的阶段");
    }
    return undefined;
  }
  const stage = (task.stages ?? []).find(s => s.id === args?.stageId);
  if (!stage) return undefined;
  const run = (task.nodeRuns ?? []).find(r => r.stageId === stage.id);
  const effectiveAttempt = args?.attempt ?? run?.attempt ?? 1;
  const stageCriteria = (task.criteria ?? []).filter(c => (stage.criterionIds ?? []).includes(c.id));
  const list = Array.isArray(events) ? events : [];

  if (args?.receiptCallIds?.length) {
    if (!run?.startedAt || run.startedAttempt !== effectiveAttempt || run.batchId) {
      throw new MentorError(ERR.EVIDENCE_UNKNOWN, "主会话回执需要绑定本次已开始的阶段");
    }
    const ids = new Set(args.receiptCallIds);
    const matched = list.filter(e => e.time >= run.startedAt && (
      (e.type === "tool/call" && ids.has(e.data?.callId)) ||
      (e.type === "tool/result" && ids.has(e.data?.message?.toolCallId ?? e.data?.message?.source?.callId))
    ));
    return captureReceipts(matched, stageCriteria, sid, task.workspaceRoot);
  }

  if (run?.batchId || !stageCriteria.some(c => validObservation(c.observe))) return undefined;

  let windowStart = null;
  if (run?.startedAt && run.startedAttempt === effectiveAttempt) {
    windowStart = run.startedAt;
  } else if (effectiveAttempt === 1) {
    if (Number.isFinite(task.approvedAt)) windowStart = task.approvedAt;
  } else {
    const priorReportAt = run?.reports?.at(-1)?.at;
    const priorReviewAt = (task.reviews ?? [])
      .filter(r => r.scope?.kind === "stage" && r.scope?.stageId === stage.id &&
        (r.scope?.planVersion == null || r.scope.planVersion === task.planVersion))
      .at(-1)?.at;
    const priorRecheckAt = (task.recheckHistory ?? [])
      .filter(r => r.planVersion === task.planVersion && r.reopened?.some(x => x.stageId === stage.id))
      .at(-1)?.at;
    const candidates = [task.approvedAt, priorReportAt, priorReviewAt, priorRecheckAt].filter(Number.isFinite);
    if (candidates.length) windowStart = Math.max(...candidates);
  }
  if (!Number.isFinite(windowStart)) return undefined;

  const usedCallIds = new Set(
    (run?.reports ?? [])
      .filter(r => r.planVersion === task.planVersion)
      .flatMap(r => (r.bindings ?? []).map(b => b.receipt?.callId).filter(Boolean)),
  );
  const scopedEvents = list.filter(e => {
    if (!Number.isFinite(e?.time) || e.time < windowStart) return false;
    if (usedCallIds.size) {
      if (e.type === "tool/call" && usedCallIds.has(e.data?.callId)) return false;
      if (e.type === "tool/result" && usedCallIds.has(e.data?.message?.toolCallId ?? e.data?.message?.source?.callId)) return false;
    }
    return true;
  });
  return captureReceipts(scopedEvents, stageCriteria, sid, task.workspaceRoot);
}

export function collectBindings(task, params, verified, read, root, mainReceipts = []) {
  const stage = task.stages.find(s => s.id === params.stageId);
  if (!stage) return [];
  const run = task.nodeRuns?.find(r => r.stageId === stage.id);
  const prior = run?.reports?.at(-1);
  const retained = run?.recheck && run.recheck.attempt === params.attempt && run.recheck.priorReportId === prior?.id && prior?.planVersion === task.planVersion
    ? run.recheck.retainedCriterionIds : [];
  const defaults = stage.criterionIds.filter(id => !retained.includes(id));
  const files = new Map(verified.evidenceFiles.map(f => [f.file,f.textSha256]));
  const lines = new Map();
  const bindings = [];
  for (const [i,ref] of verified.evidence.entries()) {
    const ids = params.evidenceRefs?.[i]?.criterionIds ?? defaults;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !stage.criterionIds.includes(id)))
      invalid("文件证据必须绑定本阶段的验收项", {file:ref.file,criterionIds:ids});
    const file = {file:ref.file, textSha256:files.get(ref.file)};
    if (ref.scope !== "file") {
      if (!lines.has(ref.file)) {
        const text=read(path.resolve(root,ref.file));
        if (digest(text)!==file.textSha256) invalid("绑定期间文件发生变化，请重新提交",{file:ref.file});
        lines.set(ref.file,text.split(/\r?\n/));
      }
      const at = ref.matchedAt ?? ref.line;
      Object.assign(file,{line:at,snippet:ref.snippet,lineSha256:digest(lines.get(ref.file)[at-1])});
    }
    for (const criterionId of new Set(ids)) bindings.push({criterionId,file});
  }
  if (retained.length) {
    const carried = prior.bindings.filter(b => retained.includes(b.criterionId));
    const stale = changedBindings(carried, root, read);
    if (stale.length) invalid("原计划沿用的证据又发生变化，需要同时复核", {stageId:stage.id,criterionIds:stale});
    bindings.push(...carried);
  }
  const worker = task.workers?.find(w => w.sessionId === run?.workerSessionId && w.stageId === stage.id && w.attempt === params.attempt &&
    w.status === "completed" && w.planVersion === task.planVersion);
  const activeRecheck = run?.recheck && run.recheck.attempt === params.attempt &&
    run.recheck.priorReportId === prior?.id && prior?.planVersion === task.planVersion;
  const priorAcceptedReview = activeRecheck && task.reviews?.some(r =>
    r.id === run.recheck.reviewId && r.verdict === "pass" && !r.selfReviewed);
  for (const id of defaults) {
    const criterion = task.criteria.find(c => c.id === id);
    if (!criterion?.observe) continue;
    const carriedReceipt = priorAcceptedReview
      ? prior?.bindings?.find(b => b.criterionId === id && b.receipt)?.receipt
      : null;
    const receipt = worker?.receipts?.find(r => r.criterionId === id) ?? mainReceipts.find(r=>r.criterionId===id) ?? carriedReceipt;
    if (!receipt) {
      invalid(
        run?.batchId
          ? "缺少对应本次助手执行的宿主回执"
          : "缺少对应本阶段执行的宿主工具回执（主会话自执行须在当前阶段内真实调用匹配工具，或派发助手执行）",
        { stageId: stage.id, criterionId: id, expected: criterion.observe },
      );
    }
    bindings.push({criterionId:id,receipt});
  }
  return bindings;
}

export function changedBindings(bindings, root, read = file => readEvidenceText(root,file), cache = new Map()) {
  const stale = new Set();
  for (const {criterionId,file} of bindings ?? []) {
    if (!file) continue;
    if (!cache.has(file.file)) {
      try { const text=read(path.resolve(root,file.file)); cache.set(file.file,{hash:digest(text),lines:text.split(/\r?\n/)}); }
      catch { cache.set(file.file,null); }
    }
    const content=cache.get(file.file);
    if (content?.hash === file.textSha256) continue;
    if (content && file.lineSha256) {
      if (content.lines[file.line-1] !== undefined && digest(content.lines[file.line-1]) === file.lineSha256) continue;
      const matches=content.lines.filter(line => line.includes(file.snippet) && digest(line) === file.lineSha256);
      if (matches.length === 1) continue;
    }
    stale.add(criterionId);
  }
  return [...stale];
}

function isSupersededByDependent(task, stageId, fileRel) {
  const dependents = collectDependents(task.stages ?? [], stageId);
  if (!dependents.size) return false;
  for (const depStage of task.stages ?? []) {
    if (!dependents.has(depStage.id)) continue;
    if (!(depStage.writePaths ?? []).some(wp => pathsOverlap(wp, fileRel))) continue;
    const depRun = (task.nodeRuns ?? []).find(r => r.stageId === depStage.id && r.status === "accepted");
    const depReport = depRun?.reports?.at(-1);
    if (!depReport || depReport.planVersion !== task.planVersion) continue;
    const matchedFile = (depReport.evidenceFiles ?? []).some(f => sameWorkspaceFile(task.workspaceRoot, f.file, fileRel));
    const matchedBinding = (depReport.bindings ?? []).some(b => b.file && sameWorkspaceFile(task.workspaceRoot, b.file.file, fileRel));
    if (matchedFile || matchedBinding) return true;
  }
  return false;
}

export function evidenceImpact(task, stageId, { read, fingerprint = false, acceptedOnly = false } = {}) {
  const cache = new Map(), changes = [];
  for (const run of task.nodeRuns ?? []) {
    if (stageId && run.stageId !== stageId || !["accepted","reported"].includes(run.status)) continue;
    if (acceptedOnly && run.status !== "accepted") continue;
    const report=run.reports?.at(-1);
    if (!report?.bindings?.length) continue;
    const rawIds = changedBindings(report.bindings, task.workspaceRoot, read, cache);
    if (!rawIds.length) continue;
    // Ignore files deliberately overwritten and verified by an accepted downstream stage with overlapping writePaths.
    const ids = run.status === "accepted" && !stageId
      ? rawIds.filter(cid => {
          const boundFiles = report.bindings.filter(b => b.criterionId === cid && b.file);
          if (!boundFiles.length) return true;
          return boundFiles.some(({ file }) => {
            const diskHash = cache.get(file.file)?.hash ?? null;
            if (diskHash === file.textSha256) return false;
            return !isSupersededByDependent(task, run.stageId, file.file);
          });
        })
      : rawIds;
    if (!ids.length) continue;
    const change = { stageId: run.stageId, criterionIds: ids, reportId: report.id };
    if (fingerprint) {
      change.files = report.bindings.filter(b => b.file && ids.includes(b.criterionId)).map(({criterionId, file}) => ({
        criterionId, file: file.file, before: file.textSha256, observed: cache.get(file.file)?.hash ?? null
      }));
    }
    changes.push(change);
  }
  return changes;
}

function changeKeys(changes) {
  const keys = new Set();
  for (const change of changes ?? []) {
    if (Array.isArray(change.files) && change.files.length) {
      for (const f of change.files) keys.add(`${change.stageId}::${f.file}`);
    } else {
      keys.add(`${change.stageId}::${(change.criterionIds ?? []).slice().sort().join(",")}`);
    }
  }
  return keys;
}

export function findRecheckLoop(task, changes) {
  const prior = (task?.recheckHistory ?? []).filter(r => r.planVersion === task.planVersion);
  if (!prior.length) return { loop: false, repeated: [], priorRecheckIds: [] };
  const incoming = changeKeys(changes);
  const repeated = new Set();
  for (const entry of prior) {
    const prevKeys = changeKeys(entry.changes);
    for (const key of incoming) {
      if (prevKeys.has(key)) repeated.add(key);
    }
  }
  const loop = repeated.size > 0 || prior.length >= MAX_AUTO_RECHECKS_PER_PLAN;
  return { loop, repeated: [...repeated], priorRecheckIds: prior.map(r => r.id) };
}

export function recheckScope(task, changes) {
  const changed = new Map(changes.map(change => [change.stageId, change]));
  const downstream = new Set();
  for (const id of changed.keys()) {
    for (const child of collectDependents(task.stages, id)) downstream.add(child);
  }
  const affected = [], retainedStages = [];
  for (const run of task.nodeRuns ?? []) {
    if (run.status !== "accepted") continue;
    const report = run.reports.at(-1);
    const stageId = run.stageId;
    if (!changed.has(stageId) && !downstream.has(stageId)) {
      retainedStages.push({stageId, reportId:report?.id});
      continue;
    }
    const stage = task.stages.find(s => s.id === stageId);
    const review = task.reviews.findLast(r => r.scope?.stageId === stageId && r.scope?.attempt === run.attempt &&
      (r.scope?.planVersion == null || r.scope.planVersion === task.planVersion) &&
      r.verdict === "pass" && !r.selfReviewed);
    const retainedCriterionIds = stage.criterionIds.filter(id => review && !downstream.has(stageId) &&
      !changed.get(stageId)?.criterionIds.includes(id) && report.bindings?.some(b => b.criterionId === id) &&
      review.checks?.some(c => c.status === "passed" && c.criterionIds?.includes(id)));
    affected.push({stageId, attempt:run.attempt+1, priorReportId:report.id, reviewId:review?.id,
      criterionIds:stage.criterionIds.filter(id => !retainedCriterionIds.includes(id)), retainedCriterionIds,
      reason:changed.has(stageId) ? "所引用的文件证据变化" : "依赖阶段需要重新验收"});
  }
  return {affected, dependentStageIds:[...downstream], retainedStages};
}

// Only the completion checkpoint applies the scope, after all in-flight work has settled.
export function reopenEvidence(store, changes) {
  const task = store.get();
  const {affected, retainedStages} = recheckScope(task, changes);
  const byStage = new Map(affected.map(({stageId, ...recheck}) => [stageId, recheck]));
  const nodeRuns = task.nodeRuns.map(run => {
    const recheck = byStage.get(run.stageId);
    return recheck ? {...run,status:"rework",attempt:recheck.attempt,batchId:null,workerSessionId:null,
      workerStatus:null,failedReason:null,recheck} : run;
  });
  const receipt = {id:randomUUID(), planVersion:task.planVersion, at:Date.now(), changes, reopened:affected, retainedStages};
  store.set({...task,nodeRuns,recheckHistory:[...(task.recheckHistory ?? []),receipt],revision:task.revision+1,updatedAt:receipt.at,
    ...(task.team?{team:{...task.team,completionRequestedVersion:null}}:{})});
  return receipt;
}
