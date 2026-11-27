import { ERR, MentorError } from "../errors.js";

function receiptId(receipt) {
  const location = receipt.callId ? ["call",receipt.callId] : ["headers",receipt.firstHeaderSeq,receipt.lastHeaderSeq];
  return [receipt.sessionId,...location].map(encodeURIComponent).join("/");
}

export function isWorkerReceipt(task, stageId, receipt, expectedPlanVersion = task?.planVersion) {
  return task.workers?.some(worker => worker.stageId === stageId && worker.status === "completed" &&
    (worker.planVersion === undefined || worker.planVersion === expectedPlanVersion) &&
    worker.sessionId === receipt.sessionId && worker.receipts?.some(r => r.criterionId === receipt.criterionId &&
      receiptId(r) === receiptId(receipt)));
}

export function handoffInputs(task, stage) {
  return (stage?.receiptInputs ?? []).map(({stageId, criterionId}) => {
    const run = task.nodeRuns.find(r => r.stageId === stageId);
    const report = run?.reports?.at(-1);
    const receipt = report?.bindings?.find(b => b.criterionId === criterionId && b.receipt)?.receipt;
    const receiptPlanVersion = report?.carriedFrom?.planVersion ?? report?.planVersion;
    if (run?.status !== "accepted" || report?.planVersion !== task.planVersion || !receipt || !isWorkerReceipt(task,stageId,receipt,receiptPlanVersion))
      throw new MentorError(ERR.EVIDENCE_UNKNOWN, "依赖阶段缺少已验收的助手原始回执", {stageId,criterionId});
    return {stageId,criterionId,reportId:report.id,receiptId:receiptId(receipt),receipt};
  });
}

export function confirmedHandoff(inputs, ids) {
  const selected = new Set(Array.isArray(ids) ? ids : []);
  if (selected.size !== new Set(inputs.map(i => i.receiptId)).size || inputs.some(i => !selected.has(i.receiptId)))
    throw new MentorError(ERR.EVIDENCE_REQUIRED, "请读取本阶段 mentor_team_context 的 receiptInputs，核对后原样提交 consumedReceiptIds");
  return inputs.map(({stageId,criterionId,reportId,receiptId}) => ({stageId,criterionId,reportId,receiptId}));
}
