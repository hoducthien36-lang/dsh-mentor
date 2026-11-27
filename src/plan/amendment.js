import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { collectDependents } from "./dag.js";
import { evidenceImpact } from "../review/criterion-evidence.js";

export function amendedRuns(task, stages, criteria, planVersion) {
  const byId = items => new Map(items.map(item => [item.id, item]));
  const previous = byId(task.stages), next = byId(stages);
  const oldCriteria = byId(task.criteria), newCriteria = byId(criteria);
  const changed = new Set();
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const stage = next.get(id);
    if (!isDeepStrictEqual(previous.get(id), stage) ||
        stage?.criterionIds.some(key => !isDeepStrictEqual(oldCriteria.get(key), newCriteria.get(key)))) changed.add(id);
  }
  // A reason-only amendment (neither stages nor criteria changed) has no machine-readable boundary.
  if (!changed.size && isDeepStrictEqual(task.criteria, criteria)) for (const stage of stages) changed.add(stage.id);
  for (const change of evidenceImpact(task)) changed.add(change.stageId);

  const approvals = new Map();
  const runs = (task.nodeRuns ?? []).filter(run => next.has(run.stageId));
  for (const run of runs) {
    const report = run.reports?.at(-1);
    const review = task.reviews?.findLast(r => r.scope?.stageId === run.stageId && r.scope?.attempt === run.attempt &&
      r.verdict === "pass" && !r.selfReviewed);
    const nextStage = next.get(run.stageId);
    const readOnlyHandoff = Boolean(report?.handoff?.inputs?.length && !(nextStage?.writePaths?.length));
    const reusable = run.status === "accepted" && report?.planVersion === task.planVersion && review &&
      nextStage.criterionIds.every(id => report.bindings?.some(b => b.criterionId === id) || readOnlyHandoff);
    if (reusable) approvals.set(run.stageId, review.id);
    else changed.add(run.stageId);
  }
  for (const id of [...changed]) for (const child of collectDependents(stages, id)) changed.add(child);

  const keptStages = [], resetStages = [];
  const nodeRuns = runs.map(run => {
    if (!changed.has(run.stageId) && approvals.has(run.stageId)) {
      keptStages.push(run.stageId);
      const old = run.reports.at(-1);
      const report = {...old, id:"rep_"+randomUUID(), planVersion, at:Date.now(),
        carriedFrom:{reportId:old.id, planVersion:old.planVersion, reviewId:approvals.get(run.stageId)}};
      return {...run, recheck:null, reports:[...run.reports, report]};
    }
    if (!["reported","accepted","running","awaiting-integration"].includes(run.status)) return {...run, recheck:null};
    resetStages.push(run.stageId);
    return {...run, status:"rework", attempt:(run.attempt??0)+1, recheck:null, batchId:null,
      workerSessionId:null, workerStatus:null, failedReason:null};
  });
  return {nodeRuns, resetStages, keptStages};
}
