/**
 * 写操作准入检查（控制接口 s2 新增）。
 *
 * 起因：pause / off 如果只改状态、不在写入口拦一下，就只是「记了一笔」，
 * 该推进的还在推进 —— 这是 s1 计划被审查打回的核心缺口。
 *
 * 旧 supervisor 的做法是一个显式理由字段 `executionBlockedReason`
 * （source/lib/index.mjs:7364），非 null 就不许推进。这里把它拆成两半：
 *   · assertWritable(task)  —— 写操作入口直接抛错，拦住实际动作
 *   · computeNextStep(task) —— 给 status 一个可读的「下一步/为什么停着」
 *
 * 与旧版差异：旧版把 disabled/paused/terminal 混在一个字符串里；这里用
 * code + allowed 分开，调用方既能给人看也能给机器判断。
 */

import { isRetryableReview } from "../review/job-scope.js";
import { ERR, MentorError, assertOrThrow } from "../errors.js";
import { PHASES, isFinished, isTerminal, allowedNext } from "./machine.js";
import { readyNodes, reviewOrderConflict, reviewOrderMessage } from "../plan/dag.js";

/** 拒绝理由的稳定 code（写进 error.details.reason，便于客户端分支） */
export const BLOCK = Object.freeze({
  NO_TASK: "NO_TASK",
  DISABLED: "SUPERVISOR_DISABLED",
  PAUSED: "TASK_PAUSED",
  ARCHIVED: "WORKFLOW_ARCHIVED",
  COMPLETED: "WORKFLOW_COMPLETED",
});

/**
 * 写操作准入。**任何会改变任务内容的 handler 开头都要调它。**
 *
 * 顺序有讲究：先看开关再看状态。
 *   · 导师被关掉（enabled=false）时，连「已暂停」都不该被当成主因 —— 用户先关的导师。
 *   · 已归档是硬终点，理由要最具体。
 *
 * @param {object|null} task
 * @throws {MentorError} 用 E_ILLEGAL_TRANSITION 承载，details.reason 区分具体原因
 */
export function assertWritable(task) {
  assertOrThrow(Boolean(task), ERR.NO_TASK, "当前没有任务，先调用 mentor_task_create", {
    reason: BLOCK.NO_TASK,
  });

  if (task.enabled === false) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      "导师已关闭，先调用 mentor_task_on 重新启用",
      { reason: BLOCK.DISABLED, allowed: ["mentor_task_on"] },
    );
  }

  if (task.phase === PHASES.ARCHIVED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已归档，无法再推进", {
      reason: BLOCK.ARCHIVED,
      allowed: ["mentor_task_create"],
    });
  }

  if (task.phase === PHASES.PAUSED) {
    throw new MentorError(
      ERR.ILLEGAL_TRANSITION,
      "任务已暂停，先调用 mentor_task_resume 恢复",
      { reason: BLOCK.PAUSED, allowed: ["mentor_task_resume", "mentor_task_clear"] },
    );
  }

  if (task.phase === PHASES.COMPLETED) {
    throw new MentorError(ERR.ILLEGAL_TRANSITION, "任务已完成，不能再变更内容", {
      reason: BLOCK.COMPLETED,
      allowed: ["mentor_task_clear"],
    });
  }
}

/** 只读判断：这个任务现在还能不能推进（给 status / UI 用，不抛错） */
export function isLive(task) {
  return Boolean(task && task.enabled !== false && !isFinished(task.phase));
}

/**
 * 计算「下一步」。返回形状固定，UI 与模型都能直接读。
 *
 * @param {object|null} task
 * @returns {{code:string, text:string, allowedActions:string[]}}
 */
export function computeNextStep(task) {
  if (!task) {
    return {
      code: "NO_TASK",
      text: "还没有任务。用 mentor_task_create 建一个。",
      allowedActions: ["mentor_task_create"],
    };
  }

  if (task.enabled === false) {
    return {
      code: BLOCK.DISABLED,
      text: "导师已关闭（任务记录保留）。用 mentor_task_on 重新启用，再 mentor_task_resume 继续。",
      allowedActions: ["mentor_task_on", "mentor_task_clear"],
    };
  }

  if (![PHASES.PAUSED,PHASES.ARCHIVED,PHASES.COMPLETED].includes(task.phase)) {
    const jobs=(task.reviewJobs??[]).filter(j=>j.planVersion===task.planVersion);
    const pending=jobs.filter(j=>["queued","running"].includes(j.status));
    const failed = jobs.filter(job => isRetryableReview(task, job));
    // 2026-11-07：自审兜底收紧后，主会话不能凭「审查失败」就自己判 pass。
    // 只有人工 /mentor waive 写过 waiver 的那条 job，才把 review_apply 放进可选动作。
    const waived=(task.reviewWaivers??[]).some(w=>failed.some(j=>j.id===w.reviewJobId)&&w.planVersion===task.planVersion);
    if(task.pendingCheckpoint) return {code:failed.length?"REVIEW_FAILED":"REVIEW_IN_PROGRESS",text:failed.length?("审查未完成：独立审查派发失败（见 reviewJobs[].error）。先 mentor_review_retry；仍起不来需人工执行 /mentor waive <理由> 放行，之后主会话才可兜底裁决（结果标记 selfReviewed）。"+(waived?" 已放行，可提交裁决。":"")):"正在进行"+(task.pendingCheckpoint.kind==="plan"?"计划审查":"整体验收")+"，可在审查页查看实际输出。",allowedActions:[...(failed.length?["mentor_review_retry",...(waived?["mentor_review_apply"]:[])]:[]),"mentor_task_pause","mentor_task_clear"]};
    if(failed.length) return {code:"REVIEW_FAILED",text:"有审查失败，查看错误后重试；已完成的阶段保留。需要兜底时由人工 /mentor waive <理由> 放行。",allowedActions:[...(waived?["mentor_review_apply"]:[]),"mentor_review_retry","mentor_task_pause","mentor_task_clear"]};
    const conflict = reviewOrderConflict(task);
    if (conflict && [PHASES.ACTIVE, PHASES.REVIEWING].includes(task.phase))
      return {code: ERR.REVIEW_ORDER, text: reviewOrderMessage(conflict), allowedActions:["mentor_plan_amend","mentor_task_pause","mentor_task_clear"]};
    const runs=task.nodeRuns??[];
    if(runs.some(r=>r.status==="awaiting-integration"))return {code:"INTEGRATE",text:"并行工作已返回，主会话需要核对汇总成果后提交阶段证据。",allowedActions:["mentor_stage_report","mentor_task_continue","mentor_task_pause","mentor_task_clear"]};
    const ready=readyNodes(task.stages??[],runs);
    if(!ready.length&&pending.length)return {code:"REVIEW_IN_PROGRESS",text:"独立审查正在进行，可在审查页查看输出。",allowedActions:["mentor_task_pause","mentor_task_clear"]};
    if(!ready.length&&runs.some(r=>r.status==="running"))return {code:"WORK_IN_PROGRESS",text:"阶段执行中，可在智能体页查看当前活动。",allowedActions:["mentor_task_pause","mentor_task_clear"]};
    if(task.stages?.length&&task.stages.every(s=>runs.some(r=>r.stageId===s.id&&r.status==="accepted")))return {code:"READY_TO_COMPLETE",text:"所有阶段已通过，请提交整体交付证据并请求独立整体验收。",allowedActions:["mentor_completion_request","mentor_task_continue","mentor_task_pause","mentor_task_clear"]};
  }
  switch (task.phase) {
    case PHASES.ARCHIVED:
      return {
        code: BLOCK.ARCHIVED,
        text: "任务已归档。要开新任务用 mentor_task_create。",
        allowedActions: ["mentor_task_create"],
      };
    case PHASES.COMPLETED:
      return {
        code: BLOCK.COMPLETED,
        text: "任务已完成。可以 mentor_task_clear 归档收尾，或直接开新任务。",
        allowedActions: ["mentor_task_clear", "mentor_task_create"],
      };
    case PHASES.PAUSED:
      if (task.continuation?.kind === "rework-circuit-breaker") {
        return {
          code: "REWORK_CIRCUIT_BREAKER",
          text: task.continuation.summary || `阶段 ${task.continuation.stageId ?? ""} 连续返工触发熔断，已暂停等待人工介入。`,
          allowedActions: ["mentor_task_resume", "mentor_task_clear"],
        };
      }
      return {
        code: BLOCK.PAUSED,
        text: `任务已暂停（原因：${task.pauseReason || "未记录"}），暂停前是 ${task.prePausePhase || "未知"}。用 mentor_task_resume 恢复。`,
        allowedActions: ["mentor_task_resume", "mentor_task_clear"],
      };
    case PHASES.PLANNING:
      return {
        code: "PLANNING",
        text: "正在规划。用 mentor_plan_submit 提交 DAG 计划。",
        allowedActions: ["mentor_plan_submit", "mentor_task_clear"],
      };
    case PHASES.AWAITING_APPROVAL:
      return {
        code: "AWAITING_APPROVAL",
        text: `计划 v${task.planVersion ?? 0} 已提交，等待批准。用 mentor_task_approve 批准后开始执行。`,
        allowedActions: ["mentor_task_approve", "mentor_task_pause", "mentor_task_clear"],
      };
    case PHASES.ACTIVE: {
      // 2026-11-04 修（s2 审查）：这里原来读 `task.readyNodes`，
      // 但任务对象上根本没有这个字段（它是 buildStatePayload 现算的），
      // 于是 active 恒报 NO_READY_NODE —— task-status 的「下一步」是错的。
      // 改为用 DAG 现算。
      const ready = readyNodes(task.stages ?? [], task.nodeRuns ?? []);
      if (ready.length > 0) {
        return {
          code: "EXECUTE",
          text: `可以推进的节点：${ready.join("、")}。执行后用 mentor_stage_report 上报证据。`,
          allowedActions: ["mentor_stage_report", "mentor_task_pause", "mentor_task_clear"],
        };
      }
      return {
        code: "NO_READY_NODE",
        text: "当前没有就绪节点，检查阶段依赖是否都未满足。",
        allowedActions: ["mentor_plan_amend", "mentor_task_pause", "mentor_task_clear"],
      };
    }
    case PHASES.REVIEWING: {
      // 2026-11-04 修（真机反馈「看不到进度」）：原来不管审查结果如何，
      // reviewing 一律回「已提交审查，等待裁决」。但 pass 之后节点已 accepted、
      // phase 仍故意留在 reviewing（completion 要求 reviewing），于是状态条一直
      // 显示「导师审查中」，而实际上该继续推下一个节点或直接请求完成。
      // 现在按「最近裁决 + 就绪节点」给出真实下一步。
      const last = (task.reviews ?? []).at(-1);
      const ready = readyNodes(task.stages ?? [], task.nodeRuns ?? []);

      if (last && last.verdict === "pass") {
        if (ready.length > 0) {
          return {
            code: "REVIEW_PASSED",
            text: `最近一次审查通过。可以继续推进：${ready.join("、")}。执行后用 mentor_stage_report 上报证据。`,
            allowedActions: [
              "mentor_stage_report",
              "mentor_plan_amend",
              "mentor_task_pause",
              "mentor_task_clear",
            ],
          };
        }

        const accepted = (task.nodeRuns ?? []).filter((r) => r && r.status === "accepted").length;
        const total = (task.stages ?? []).length;
        if (total > 0 && accepted === total) {
          return {
            code: "READY_TO_COMPLETE",
            text: `全部 ${total} 个阶段已接受、最近审查通过：可以 mentor_completion_request 请求完成。`,
            allowedActions: ["mentor_completion_request", "mentor_task_pause", "mentor_task_clear"],
          };
        }

        return {
          code: "NO_READY_NODE",
          text: `审查已通过，但没有就绪节点（${accepted}/${total} accepted）。检查阶段依赖或修订计划。`,
          allowedActions: ["mentor_plan_amend", "mentor_task_pause", "mentor_task_clear"],
        };
      }

      return {
        code: "REVIEW_IN_PROGRESS",
        text: "已提交审查，等待裁决。",
        allowedActions: ["mentor_task_pause", "mentor_task_clear"],
      };
    }
    default:
      return {
        code: "UNKNOWN",
        text: `未知状态：${task.phase}`,
        allowedActions: [],
      };
  }
}

/** 当前状态允许迁到哪些 phase（原样透出，便于客户端画按钮） */
export function allowedTransitions(task) {
  if (!task) return [];
  return allowedNext(task.phase);
}
