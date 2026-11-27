import { HANDLERS } from "../tools/handlers.js";
export const COMMAND_ACTIONS=Object.freeze(["mentor_task_approve","mentor_task_pause","mentor_task_resume","mentor_task_clear","mentor_task_restore","mentor_task_off","mentor_task_on","mentor_review_retry","mentor_task_continue","mentor_review_waive","mentor_team_start","mentor_team_direction","mentor_finding_close","mentor_session_takeover","mentor_lesson_accept","mentor_lesson_dismiss","mentor_stage_rollback","mentor_rigor_set","mentor_clarify_answer","mentor_receipt_build","mentor_passport_export","mentor_trace_export"]);
export async function dispatchCommand(store,payload,dispatch){
 // 2026-11-08 修：fail 原来只带 code/message，调用方拿不到任何可操作信息。
 // 现在支持第三参 details，并给 E_UNKNOWN_ACTION 带上可用动作清单。
 const fail=(code,message,details)=>({ok:false,error:{code,message,...(details===undefined?{}:{details})}}),action=payload?.action,params=payload?.params??{},task=store.get();
 if(!COMMAND_ACTIONS.includes(action))return fail("E_UNKNOWN_ACTION","不支持的面板操作",{known:[...COMMAND_ACTIONS],action:action??null});
 if(!task||params.taskId!==task.id)return fail("E_STALE_TASK","任务已改变，请刷新后重试",{expectedTaskId:params.taskId,currentTaskId:task?.id??null});
 if(params.revision!==task.revision)return fail("E_STALE_REVISION","任务状态已更新，请刷新后重试",{taskId:task.id,expectedRevision:params.revision,currentRevision:task.revision});
 try{const r=await(dispatch?dispatch(action,params):HANDLERS[action]?.(store,params));return r?.ok?{ok:true,value:r.value}:fail(r?.code??"E_CONTROL_FAILED",r?.message??"操作失败",r?.details);}catch(e){return fail(e.code??"E_CONTROL_FAILED",String(e.message??e),e.details);}
}
