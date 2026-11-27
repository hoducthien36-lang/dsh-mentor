/**
 * 计划 DAG 校验与就绪节点推导（SPEC §2.2）。
 *
 * 校验一次跑完、一次给全：不在第一个错误处停下，让提交方能一轮改完。
 */

import { ERR, MentorError } from "../errors.js";
import { WORKER_DENIAL } from "../review/worker-denials.js";
import { pathsOverlap } from "../tools/parallel.js";
import { validateStagePrechecks } from "../runtime/prechecks.js";

export function verificationPoint(criterion) {
  return criterion?.verifyAt ?? "stage";
}

export function reviewOrderConflict(task) {
  const identified = task?.reviewOrderIssues?.find(issue => issue.planVersion === task.planVersion);
  if (identified) return identified;
  const completionIds = new Set((task?.criteria ?? []).filter(c => verificationPoint(c) !== "stage").map(c => c.id));
  for (const stage of task?.stages ?? []) {
    const criterionId = Array.isArray(stage?.criterionIds) && stage.criterionIds.find(id => completionIds.has(id));
    if (criterionId) return { stageId: stage.id, criterionId };
  }
  return null;
}

export function reviewOrderMessage({ stageId, criterionId }) {
  return `阶段 ${stageId} 要求整体验收才能提供的证据（${criterionId}）。请修订计划：保留该验收项并从阶段 criterionIds 移除，阶段另列可当场验证的结果。`;
}

export function stageAttemptRef(task, stageId, attempt) {
  return [task.id,task.planVersion,stageId,attempt].map(encodeURIComponent).join("/");
}

const toolNames = ["read", "write", "edit", "grep", "glob"];
export function validObservation(spec) {
  return spec && Object.keys(spec).every(k=>["tool","outcome","target","error","errorCode","errorContains"].includes(k)) && typeof spec.tool === "string" && /^[\w.-]+$/.test(spec.tool) &&
    (spec.outcome === "unavailable" ? spec.target == null && spec.error == null && spec.errorCode == null && spec.errorContains == null :
      toolNames.includes(spec.tool) && ["success", "error"].includes(spec.outcome) &&
      (spec.target == null || typeof spec.target === "string" && spec.target.trim().length > 0) &&
      (spec.errorCode == null || spec.outcome === "error" && Object.values(WORKER_DENIAL).includes(spec.errorCode)) &&
      (spec.error == null || spec.outcome === "error" && typeof spec.error === "string" && spec.error.trim().length > 0) &&
      (spec.errorContains == null || spec.outcome === "error" && typeof spec.errorContains === "string" && spec.errorContains.trim().length > 0));
}

/**
 * 校验计划结构。返回收集到的全部问题。
 *
 * @param {{criteria:Array, stages:Array}} plan
 * @returns {{ok:boolean, errors:Array<{code:string,message:string,details?:object}>}}
 */
export function validatePlan(plan) {
  const criteria = Array.isArray(plan?.criteria) ? plan.criteria : null;
  const stages = Array.isArray(plan?.stages) ? plan.stages : null;
  const errors = [];

  if (criteria === null || stages === null) {
    return {
      ok: false,
      errors: [
        {
          code: ERR.EMPTY_PLAN,
          message: "plan 必须同时提供 criteria 与 stages 数组",
        },
      ],
    };
  }
  if (stages.length === 0) {
    return {
      ok: false,
      errors: [{ code: ERR.EMPTY_PLAN, message: "计划至少要有一个 stage" }],
    };
  }

  const conflict = reviewOrderConflict({ criteria, stages: stages.filter(Boolean) });
  if (conflict) errors.push({ code: ERR.REVIEW_ORDER, message: reviewOrderMessage(conflict), details: conflict });
  for (const c of criteria) {
    if ((c?.verifyAt !== undefined && !["stage", "completion", "completion-recheck"].includes(c.verifyAt)) ||
        (verificationPoint(c) !== "stage" && c?.observe !== undefined))
      errors.push({code:ERR.EMPTY_PLAN,message:"verifyAt 取 stage、completion 或 completion-recheck；助手工具回执由具体阶段验证",details:{criterionId:c?.id}});
    if (c?.observe !== undefined && !validObservation(c.observe))
      errors.push({code:ERR.EMPTY_PLAN,message:"验收项 observe 需要有效的工具、预期结果和匹配条件",details:{criterionId:c.id}});
  }

  // --- stage id 唯一 ---
  const seenStageIds = new Map();
  for (const s of stages) {
    if (!s || typeof s.id !== "string" || s.id.length === 0) {
      errors.push({
        code: ERR.EMPTY_PLAN,
        message: "每个 stage 必须有非空字符串 id",
      });
      continue;
    }
    seenStageIds.set(s.id, (seenStageIds.get(s.id) ?? 0) + 1);
  }
  for (const [id, count] of seenStageIds) {
    if (count > 1) {
      errors.push({
        code: ERR.STAGE_DUP,
        message: `stage id 重复：${id}（出现 ${count} 次）`,
        details: { stageId: id, count },
      });
    }
  }

  const stageIds = new Set(stages.filter((s) => s && s.id).map((s) => s.id));
  const criterionIds = new Set(
    criteria.filter((c) => c && c.id).map((c) => c.id),
  );

  // --- criterion 引用必须存在 ---
  const referencedCriteria = new Set();
  for (const s of stages) {
    if (!s || !s.id) continue;
    if (!Array.isArray(s.criterionIds) || s.criterionIds.length === 0) {
      errors.push({
        code: ERR.CRITERION_UNKNOWN,
        message: `stage ${s.id} 的 criterionIds 为空`,
        details: { stageId: s.id },
      });
      continue;
    }
    for (const cid of s.criterionIds) {
      if (!criterionIds.has(cid)) {
        errors.push({
          code: ERR.CRITERION_UNKNOWN,
          message: `stage ${s.id} 引用了不存在的 criterion：${cid}`,
          details: { stageId: s.id, criterionId: cid },
        });
      } else {
        referencedCriteria.add(cid);
      }
    }
  }

  // --- 不能有孤儿 criterion（每条都要有阶段负责） ---
  for (const c of criteria) {
    if (!c || !c.id) continue;
    if (verificationPoint(c) === "stage" && !referencedCriteria.has(c.id)) {
      errors.push({
        code: ERR.CRITERION_ORPHAN,
        message: `criterion ${c.id} 没有被任何 stage 引用`,
        details: { criterionId: c.id },
      });
    }
  }

  // --- dependsOn 引用必须存在 ---
  for (const s of stages) {
    if (!s || !s.id) continue;
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    for (const dep of deps) {
      if (!stageIds.has(dep)) {
        errors.push({
          code: ERR.DEP_UNKNOWN,
          message: `stage ${s.id} 依赖了不存在的 stage：${dep}`,
          details: { stageId: s.id, dependsOn: dep },
        });
      }
      if (dep === s.id) {
        errors.push({
          code: ERR.DEP_CYCLE,
          message: `stage ${s.id} 依赖自身`,
          details: { stageId: s.id },
        });
      }
    }
  }

  for (const stage of stages.filter(Boolean)) {
    if (stage.receiptInputs === undefined) continue;
    if (!Array.isArray(stage.receiptInputs)) {
      errors.push({code:ERR.DEP_UNKNOWN,message:"receiptInputs 必须是上游阶段与验收项的数组",details:{stageId:stage.id}});
      continue;
    }
    for (const input of stage.receiptInputs) {
      const source = stages.find(s => s?.id === input?.stageId);
      const criterion = criteria.find(c => c?.id === input?.criterionId);
      if (!source || !Array.isArray(stage.dependsOn) || !stage.dependsOn.includes(source.id) ||
          (!Array.isArray(source.criterionIds) || !source.criterionIds.includes(criterion?.id)) || !validObservation(criterion?.observe))
        errors.push({code:ERR.DEP_UNKNOWN,message:"交接回执须引用直接依赖阶段声明的工具观察项",details:{stageId:stage.id,input}});
    }
  }

  // --- v0.3：阶段前置硬检查声明校验 ---
  errors.push(...validateStagePrechecks(stages));

  // --- 无环（三色 DFS） ---
  const cycleNodes = findCycle(stages, stageIds);
  if (cycleNodes.length > 0) {
    errors.push({
      code: ERR.DEP_CYCLE,
      message: `依赖存在环：${cycleNodes.join(" → ")}`,
      details: { cycle: cycleNodes },
    });
  }

  // --- 必须有入口（至少一个无依赖的 stage） ---
  const hasEntry = stages.some(
    (s) => !Array.isArray(s.dependsOn) || s.dependsOn.length === 0,
  );
  if (!hasEntry) {
    errors.push({
      code: ERR.NO_ENTRY,
      message: "没有入口 stage（所有 stage 都有依赖）",
    });
  }

  // --- writePaths 冲突：两个 stage 声明同一路径且彼此无依赖关系 ---
  const conflicts = findWritePathConflicts(stages, stageIds);
  for (const c of conflicts) {
    errors.push({
      code: ERR.WRITEPATH_CONFLICT,
      message: `writePaths 冲突：${c.path} 同时被 ${c.a} 与 ${c.b} 声明，且二者无依赖关系`,
      details: c,
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 三色 DFS 找环，返回环上的节点序列（含首尾重复以便阅读）。
 * 无环返回空数组。
 */
export function findCycle(stages, stageIds) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const byId = new Map();
  for (const s of stages) {
    if (s && s.id && stageIds.has(s.id)) byId.set(s.id, s);
  }

  const color = new Map();
  for (const id of byId.keys()) color.set(id, WHITE);
  const stack = [];

  function visit(id) {
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    for (const dep of deps) {
      if (!byId.has(dep)) continue; // 未知依赖由 DEP_UNKNOWN 单独报
      const state = color.get(dep);
      if (state === GRAY) {
        const at = stack.indexOf(dep);
        return [...stack.slice(at), dep];
      }
      if (state === WHITE) {
        const found = visit(dep);
        if (found.length > 0) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return [];
  }

  for (const id of byId.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** 判断 a 是否可达 b（沿 dependsOn 方向） */
function dependsOnTransitively(byId, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const node = byId.get(from);
  const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
  for (const dep of deps) {
    if (dependsOnTransitively(byId, dep, target, seen)) return true;
  }
  return false;
}

/**
 * writePaths 冲突：同一路径被两个 stage 声明，且两者之间没有任何方向的可达依赖。
 * 有依赖关系视为串行，允许先后写同一文件。
 */
export function findWritePathConflicts(stages, stageIds) {
  const byId = new Map();
  for (const stage of stages) {
    if (stage?.id && stageIds.has(stage.id)) byId.set(stage.id, stage);
  }
  const list = [...byId.values()];
  const conflicts = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      // 有因果依赖的节点串行执行，可先后修改相同文件。
      if (dependsOnTransitively(byId, a.id, b.id) || dependsOnTransitively(byId, b.id, a.id)) continue;
      for (const aPath of Array.isArray(a.writePaths) ? a.writePaths : []) {
        for (const bPath of Array.isArray(b.writePaths) ? b.writePaths : []) {
          if (pathsOverlap(aPath, bPath)) conflicts.push({
            path: aPath === bPath ? aPath : String(aPath) + " / " + String(bPath),
            a: a.id, b: b.id, aPath, bPath,
          });
        }
      }
    }
  }
  return conflicts;
}

/**
 * 拓扑序（依赖在前）。前提：调用方已通过 validatePlan 确认无环，
 * 若仍遇环则抛 E_DEP_CYCLE。
 */
export function topoSort(stages) {
  const byId = new Map(stages.filter((s) => s && s.id).map((s) => [s.id, s]));
  const result = [];
  const state = new Map(); // id → "visiting" | "done"

  function visit(id) {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new MentorError(ERR.DEP_CYCLE, `依赖存在环，涉及 stage：${id}`, { stageId: id });
    }
    state.set(id, "visiting");
    const node = byId.get(id);
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    for (const dep of deps) {
      if (byId.has(dep)) visit(dep);
    }
    state.set(id, "done");
    result.push(node);
  }

  for (const id of byId.keys()) visit(id);
  return result;
}

/**
 * 就绪节点：依赖的 stage 全部处于 accepted 状态。
 *
 * @param {Array} stages
 * @param {Array} nodeRuns  形如 [{ stageId, attempt, status }]
 * @returns {string[]} 就绪 stage id（按计划原始顺序）
 */
export function readyNodes(stages, nodeRuns) {
  const accepted = new Set(
    (nodeRuns ?? [])
      .filter((r) => r && r.status === "accepted")
      .map((r) => r.stageId),
  );

  const ready = [];
  for (const s of stages) {
    if (!s || !s.id) continue;
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    // 就绪 = 依赖全部接受 且 自身尚未被接受（已做完的不再"可开始"）
    const run = (nodeRuns ?? []).find((r) => r && r.stageId === s.id);
    const available = !run || run.status === "pending" || run.status === "rework";
    if (deps.every((d) => accepted.has(d)) && available) {
      ready.push(s.id);
    }
  }
  return ready;
}

/**
 * 收集传递依赖 rootId 的所有 stage id（多级）。
 *
 * 用途：某阶段被返工（主动 rework 或审查判 revise）时，已 accepted 的后继节点
 * 不会自动失效——因为 readyNodes 只看 status，而 accepted 记录本身不会变。
 * 必须显式把它们置回 rework，否则会拿旧结果继续推进。
 *
 * @param {Array} stages
 * @param {string} rootId
 * @returns {Set<string>} 传递依赖 rootId 的 stage id 集合（不含 rootId 自身）
 */
export function collectDependents(stages, rootId) {
  const byDep = new Map();
  for (const s of stages ?? []) {
    if (!s || !s.id) continue;
    for (const d of Array.isArray(s.dependsOn) ? s.dependsOn : []) {
      if (!byDep.has(d)) byDep.set(d, []);
      byDep.get(d).push(s.id);
    }
  }
  const out = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of byDep.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * 提交某节点前的依赖闸门（SPEC §2.3）：
 * 依赖未全部 accepted 则抛 E_DEP_NOT_READY。
 */
export function assertDependenciesReady(stage, nodeRuns) {
  const accepted = new Set(
    (nodeRuns ?? [])
      .filter((r) => r && r.status === "accepted")
      .map((r) => r.stageId),
  );
  const deps = Array.isArray(stage?.dependsOn) ? stage.dependsOn : [];
  const missing = deps.filter((d) => !accepted.has(d));
  if (missing.length > 0) {
    throw new MentorError(
      ERR.DEP_NOT_READY,
      `stage ${stage.id} 的前置阶段尚未被接受：${missing.join(", ")}`,
      { stageId: stage.id, missing },
    );
  }
}

/**
 * attempt 一致性校验（SPEC §2.3）：报告里的 attempt 必须等于当前尝试号。
 */
export function assertAttemptCurrent(stageId, reportedAttempt, nodeRuns) {
  const run = (nodeRuns ?? []).find((r) => r.stageId === stageId);
  const current = run ? run.attempt : 1;
  if (reportedAttempt !== current) {
    throw new MentorError(
      ERR.STALE_ATTEMPT,
      `stage ${stageId} 的 attempt 不匹配：报告 ${reportedAttempt}，当前 ${current}`,
      { stageId, reportedAttempt, current },
    );
  }
}
