import { readyNodes, verificationPoint } from "../plan/dag.js";
import { teamAttention } from "./team.js";

export function progressView(task,nextStep) {
  const runs = new Map((task.nodeRuns ?? []).map(r=>[r.stageId,r]));
  const ready = new Set(readyNodes(task.stages,task.nodeRuns));
  const stages = task.stages ?? [], title = id=>stages.find(s=>s.id===id)?.title || id;
  const labels={accepted:"已通过",running:"执行中",reported:"独立审查中","awaiting-integration":"等待主会话核对",rework:"需要返工"};
  const claims=[];
  const steps=stages.map(stage=>{
    const run=runs.get(stage.id),hold=task.team?.directions?.[stage.id];
    const report=run?.reports?.at(-1);
    const currentReport = report?.attempt===run?.attempt && report?.planVersion===task.planVersion ? report : null;
    const bindings=currentReport?.bindings??[];
    for(const id of stage.criterionIds??[]) {
      const c=(task.criteria??[]).find(c=>c.id===id);
      const expected=c?.observe;
      const proofs = bindings.filter(b=>b.criterionId===id);
      if (!proofs.length && currentReport?.handoff?.inputs?.length) {
        proofs.push({ handoff: currentReport.handoff });
      }
      claims.push({stageId:stage.id,id,title:c?.text??id,proofs,
        expected:expected?[expected.tool,expected.outcome,expected.target,expected.errorCode ?? expected.error ?? expected.errorContains].filter(Boolean).join(" · "):null});
    }
    const waiting=(stage.dependsOn??[]).filter(id=>runs.get(id)?.status!=="accepted").map(title);
    const detail=hold?.hold?"已暂缓 · "+hold.text : run?.failedReason || labels[run?.status] ||
      (waiting.length?"等待 "+waiting.join("、"):ready.has(stage.id)&&task.approvedPlanVersion===task.planVersion?"依赖已就绪":"等待计划批准");
    return {id:stage.id,title:title(stage.id),detail,recheck:run?.status==="rework"?run.recheck:null};
  });
  const planRechecks = (task.recheckHistory ?? []).filter(r => r.planVersion === task.planVersion);
  const completionReview = (task.reviews ?? []).findLast(r => r.scope?.kind === "completion" &&
    (r.scope?.planVersion === undefined || r.scope.planVersion === task.planVersion) && r.verdict === "pass");
  for (const c of (task.criteria ?? [])) {
    const verifyAt = verificationPoint(c);
    if (verifyAt === "stage") continue;
    const proofs = [];
    if (verifyAt === "completion-recheck") {
      for (const r of planRechecks) {
        proofs.push({
          recheck: {
            id: r.id,
            at: r.at,
            reopenedStages: (r.reopened ?? []).map(x => x.stageId),
            criterionIds: (r.reopened ?? []).flatMap(x => x.criterionIds ?? []),
            retainedStages: (r.retainedStages ?? []).map(x => x.stageId),
          },
        });
      }
    }
    for (const ck of completionReview?.checks ?? []) {
      if (ck.criterionIds?.includes(c.id)) {
        proofs.push({ check: { reviewId: completionReview.id, source: ck.source, observation: ck.observation, recheckId: ck.recheckId ?? null } });
      }
    }
    claims.push({
      stageId: "__completion__",
      verifyAt,
      id: c.id,
      title: c.text ?? c.id,
      proofs,
      expected: verifyAt === "completion-recheck" ? "整体验收 · 需引用实际自动返工回执" : "整体验收",
    });
  }
  const attention=teamAttention(task), decisions=[];
  if (task.enabled!==false && task.phase==="awaiting-approval")
    decisions.push({label:"批准当前计划",action:"mentor_task_approve",effect:"计划已通过独立审查。确认范围符合预期后批准，团队即可开始。"});
  if (task.enabled!==false && task.phase==="paused")
    decisions.push({label:"恢复任务",action:"mentor_task_resume",effect:"任务已暂停。确认阻塞原因已处理后，可从保留的阶段恢复。"});
  if (task.enabled!==false && ["active","reviewing"].includes(task.phase))
    for(const [id,d] of Object.entries(task.team?.directions??{})) if(d.hold)
      decisions.push({label:"恢复 "+title(id),action:"mentor_team_direction",params:{stageId:id,hold:false,direction:"按已批准的计划继续，复核暂缓依据："+d.text},
        effect:title(id)+" 的暂缓原因："+d.text+"。保留暂缓可继续其他分支；恢复后允许重新派工。"});
  let headline = attention?.text || nextStep?.text || "";
  if (["active","reviewing"].includes(task.phase) && !decisions.length &&
      (attention?.waiting || (!attention && ["WORK_IN_PROGRESS","REVIEW_IN_PROGRESS"].includes(nextStep?.code)))) {
    const statusNames=[["accepted","已通过"],["running","执行中"],["reported","审查中"]];
    const summary=statusNames.flatMap(([status,label])=>{
      const ids=stages.filter(s=>runs.get(s.id)?.status===status).map(s=>s.title||s.id);
      return ids.length?[ids.slice(0,3).join("、")+(ids.length>3?"等 "+ids.length+" 项":"")+" "+label]:[];
    });
    headline=(summary.length?summary.join("；"):headline)+"。目前无需你操作。";
  }
  if (task.phase==="paused") headline = task.pauseReason==="recovery-failed" ? "助手执行失败，任务已暂停。可以先查看受影响的阶段。" : "任务已暂停，已验收的成果保留。";
  if (task.phase==="awaiting-approval") headline="计划已通过独立审查，等待你批准开工。";
  if (task.continuation?.status==="needs-attention") headline=task.continuation.reason;
  return {headline,steps,claims,decisions,history:task.calibration??null};
}
