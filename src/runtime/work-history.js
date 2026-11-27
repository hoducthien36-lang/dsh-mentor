// Compare completed work from the same workspace and task family. Unknown metrics
// stay unknown, so old tasks never look cheaper merely because counters were absent.
export function observationFamily(criteria) {
  const signatures = [...new Set((criteria??[]).filter(c=>c.observe).map(c=>c.observe.tool+"/"+c.observe.outcome))].sort();
  return signatures.length ? "工具验收 · "+signatures.join("、") : null;
}

export function workMetrics(task) {
  const workers = task.workers ?? [];
  const intervals = workers.filter(w => Number.isFinite(w.startedAt) && w.completedAt > w.startedAt);
  const overlapping = intervals.some((a,i) => intervals.slice(i+1).some(b => a.stageId !== b.stageId &&
    a.startedAt < b.completedAt && b.startedAt < a.completedAt));
  const mode = overlapping ? "parallel" : workers.length === intervals.length ? "serial" : null;
  const end = task.completedAt;
  return { mode, elapsedMs: Number.isFinite(end) && end > task.createdAt ? end-task.createdAt : null,
    interventions: Number.isInteger(task.humanInterventions) ? task.humanInterventions : null,
    reworks: (task.nodeRuns ?? []).reduce((n,r)=>n+Math.max(0,(r.attempt ?? 1)-1),0),
    stages:task.stages?.length ?? 0 };
}
function median(values) {
  const a = values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const i = Math.floor(a.length/2);
  return a.length%2 ? a[i] : (a[i-1]+a[i])/2;
}
export function calibrateWork(tasks, workClass, stageCount) {
  if (!workClass) return null;
  const rows = tasks.filter(t => t.workClass === workClass && t.completedAt).map(workMetrics)
    .filter(m => m.mode && m.elapsedMs && (!stageCount || Math.abs(stageCount-m.stages)<=Math.max(1,stageCount/3)));
  const groups = Object.fromEntries(["serial","parallel"].map(mode=>{
    const matches=rows.filter(r=>r.mode===mode);
    return [mode,{samples:matches.length,elapsedMs:median(matches.map(r=>r.elapsedMs)),
      reworks:median(matches.map(r=>r.reworks)),interventions:median(matches.map(r=>r.interventions)),
      measuredInterventions:matches.filter(r=>r.interventions!==null).length}];
  }));
  const {serial,parallel}=groups;
  let preferred=null;
  if (serial.samples>=2 && parallel.samples>=2) {
    const [fast,slow] = serial.elapsedMs<parallel.elapsedMs ? [serial,parallel] : [parallel,serial];
    if (fast.elapsedMs <= slow.elapsedMs*.8 && fast.reworks <= slow.reworks &&
        fast.measuredInterventions===fast.samples && slow.measuredInterventions===slow.samples && fast.interventions<=slow.interventions)
      preferred=fast===serial ? "serial":"parallel";
  }
  return {workClass,groups,preferred};
}
