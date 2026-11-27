import { readyNodes } from "../plan/dag.js";
import { ERR } from "../errors.js";
import { computeNextStep } from "../state/guard.js";
import { isRetryableReview } from "../review/job-scope.js";

export function mentorToolVisible(name, task, sid, step) {
  if (!sid || name === "mentor_review_waive") return false;
  if (task && sid !== task.mainSessionId) {
    const reviewer = task.reviewJobs?.some(j => j.sessionId === sid && j.planVersion === task.planVersion &&
      ["running", "queued"].includes(j.status));
    if (reviewer) return name === "mentor_task_status" || name === "mentor_review_apply";
    const activeWorkerRun = task.nodeRuns?.find(r => r.workerSessionId === sid && r.status === "running");
    if (activeWorkerRun) {
      const stage = task.stages?.find(s => s.id === activeWorkerRun.stageId);
      const collaboration = Boolean(task.team?.enabled || stage?.receiptInputs?.length);
      return name === "mentor_task_status" && collaboration;
    }
    return false;
  }
  if (["mentor_task_status","mentor_work_mode","mentor_verify_review_recovery"].includes(name)) return true;
  // 2026-11-24 修复「任务建成即死锁」：宿主在会话开始时对 when 求值一次，之后不随
  // 任务创建重算。会话开始时任务尚未创建，task 必为 null，原实现
  // `return name === "mentor_task_create"` 于是把 21 个流程工具永久剪掉——任务建好后
  // nextStep 指向的 mentor_plan_submit / mentor_task_clear 全都不在工具表里，状态机
  // 要求做 A 或 B 而 A、B 都不可用。主会话这里一律放行；动作合法性由 handlers.js 的
  // requireTask（无任务 → E_NO_TASK + hint）与 taskCreate（进行中任务 → E_TASK_EXISTS）
  // 负责，越界调用得到明确错误码而不是崩溃或重复建任务。
  // 子会话（reviewer / worker）的严格收窄在上面已 return，不受此影响。
  if (!task) return true;
  if (name === "mentor_task_create") return ["archived","completed"].includes(task.phase);
  if (name === "mentor_task_clear") return task.phase !== "archived";
  if (name === "mentor_task_on") return task.enabled === false;
  if (task.enabled === false || ["archived","completed"].includes(task.phase)) return false;
  if (name === "mentor_task_off") return true;
  if (name === "mentor_task_continue" && task.continuation?.status === "needs-attention") return task.phase !== "paused";
  if (task.phase === "paused") return name === "mentor_task_resume";
  if (["mentor_task_pause","mentor_team_context"].includes(name)) return true;
  if (name === "mentor_finding_respond") return task.findings?.some(f => f.status !== "closed") ?? false;
  const next = step ?? computeNextStep(task);
  if (name === "mentor_task_approve") return task.requireApproval !== true && next.allowedActions.includes(name);
  if (name === "mentor_review_apply") return next.allowedActions.includes(name);
  if (name === "mentor_review_retry") return task.reviewJobs?.some(j => isRetryableReview(task,j)) ?? false;
  if (next.allowedActions.includes(name)) return true;
  if (name === "mentor_workspace_set") return !task.pendingCheckpoint &&
    !task.nodeRuns?.some(r => r.status === "running") && !task.reviewJobs?.some(j => ["running","queued"].includes(j.status));
  if (task.pendingCheckpoint || next.code === ERR.REVIEW_ORDER) return false;
  if (["mentor_team_start","mentor_team_note"].includes(name)) return true;
  if (name === "mentor_team_direction") return task.team?.enabled === true;
  if (!["active","reviewing"].includes(task.phase)) return false;
  if (name === "mentor_plan_amend") return true;
  if (task.approvedPlanVersion !== task.planVersion) return false;
  if (name === "mentor_rework_stage") return task.nodeRuns?.some(r => r.status === "accepted") ?? false;
  const hasIntegration = task.nodeRuns?.some(r => r.status === "awaiting-integration") ?? false;
  return ["mentor_delegate_nodes","mentor_node_start","mentor_stage_report"].includes(name) &&
    (readyNodes(task.stages ?? [], task.nodeRuns ?? []).length > 0 ||
      (name === "mentor_stage_report" && (next.code === "INTEGRATE" || hasIntegration)));
}
