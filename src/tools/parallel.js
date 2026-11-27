/**
 * 并行委派核心（纯函数，不依赖 DSH）。
 *
 * 依据：`verification/parallel-and-live-review-design.md` §二
 *   —— 结构照旧版 dsh-task-supervisor（14 步调用序列），但刻意改四处：
 *   默认并发由 DEFAULT_MAX_PARALLEL 定义，硬上限 1..16；实际失败处理由 handlers.completeDelegation 负责。
 *
 * 本文件只做「能不能派、派了怎么回滚」的判定，不真正起子 Agent
 * （起会话在 s3 接线层，用 ctx.agents.create）。
 */

/** 上限硬边界：配置只能落在 [1,16]，1..16 之外一律拒收 */
export const MIN_PARALLEL = 1;
export const MAX_PARALLEL = 16;
/** 执行节点默认并发的唯一来源。 */
export const DEFAULT_MAX_PARALLEL = 8;

/** 本模块错误码（s3 接线时并入 ERR） */
export const PARALLEL_CODE = Object.freeze({
  LIMIT: "E_PARALLEL_LIMIT",
  BATCH: "E_DELEGATION_INVALID",
  CONFLICT: "E_WRITE_CONFLICT",
});

/** 历史回滚规划辅助接口，当前执行链不调用；不代表运行时失败策略。 */
export const FAILURE_POINTS = Object.freeze({
  R1: "入参/就绪/上限校验失败",
  R2: "写域校验失败",
  R3: "store.set(running) 之后、agents.create 之前失败",
  R4: "部分 worker 创建失败",
  R5: "worker 跑完但校验失败",
  R6: "汇总期 revision 变化（stale）",
  R7: "成功后主轴不做集成检查",
});

/** 回滚计划表：给定失败点，返回该做什么（不做自动重试，R5 尤其如此） */
const ROLLBACK = Object.freeze({
  R1: { touchTask: false, rollbackStages: false, pauseTask: false, dropResult: false, retry: false },
  R2: { touchTask: false, rollbackStages: false, pauseTask: false, dropResult: false, retry: false },
  R3: { touchTask: true, rollbackStages: true, pauseTask: false, dropResult: false, retry: false },
  R4: { touchTask: true, rollbackStages: true, pauseTask: false, dropResult: false, retry: false, cancelBatch: true },
  R5: { touchTask: true, rollbackStages: false, pauseTask: true, dropResult: false, retry: false },
  R6: { touchTask: false, rollbackStages: false, pauseTask: false, dropResult: true, retry: false },
  R7: { touchTask: false, rollbackStages: false, pauseTask: false, dropResult: false, retry: false, blockReport: true },
});

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details ?? {};
  err.isMentorFailure = true;
  return err;
}

/**
 * 解析并发上限：未传取默认；传了必须是 [1,16] 内的整数。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxParallel(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_PARALLEL;
  if (!Number.isInteger(value) || value < MIN_PARALLEL || value > MAX_PARALLEL) {
    throw fail(
      PARALLEL_CODE.LIMIT,
      `maxParallelNodes 必须是 ${MIN_PARALLEL}..${MAX_PARALLEL} 之间的整数，收到 ${String(value)}`,
      { min: MIN_PARALLEL, max: MAX_PARALLEL, got: value ?? null },
    );
  }
  return value;
}

/** 判断两个相对路径是否互相覆盖（相等、或一方是另一方的目录前缀） */
export function pathsOverlap(a, b) {
  const norm = (value) => {
    const parts = String(value ?? "").replace(/\\/gu, "/").split("/");
    const normalized = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === ".." && normalized.length && normalized.at(-1) !== "..") normalized.pop();
      else normalized.push(part);
    }
    const result = normalized.join("/");
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  const rawA = typeof a === "string" ? a.trim() : "";
  const rawB = typeof b === "string" ? b.trim() : "";
  if (!rawA || !rawB) return false;
  const pa = norm(rawA);
  const pb = norm(rawB);
  // 非空路径规范化为根（如 .、./、src/..）代表整个工作区。
  if (pa.length === 0 || pb.length === 0) return true;
  if (pa === pb) return true;
  return pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

/**
 * 批内写域冲突检查：两两比较，命中即报冲突对。
 *
 * 与旧版的差异：旧版只认「规范化后完全相等」（`index.mjs:5062`），
 * 父子目录关系漏判；这里把目录前缀也算冲突，宁可要求串行。
 *
 * @param {Array<{id:string, writePaths?:string[]}>} stages 本批要派的阶段
 * @returns {Array<{a:string, b:string, aPath:string, bPath:string}>} 冲突对（空数组=无冲突）
 */
export function findWriteConflicts(stages) {
  const conflicts = [];
  for (let i = 0; i < stages.length; i += 1) {
    for (let j = i + 1; j < stages.length; j += 1) {
      const a = stages[i];
      const b = stages[j];
      for (const pa of a.writePaths ?? []) {
        for (const pb of b.writePaths ?? []) {
          if (pathsOverlap(pa, pb)) {
            conflicts.push({ a: a.id, b: b.id, aPath: pa, bPath: pb });
          }
        }
      }
    }
  }
  return conflicts;
}

/**
 * 派发前校验：入参形状 → 上限 → 就绪 → 批内写域。
 *
 * @param {object} input
 * @param {unknown} input.stageIds 本批要派的阶段 id 列表
 * @param {string[]} input.readyNodeIds 当前就绪节点
 * @param {Array<{id:string, writePaths?:string[]}>} input.stages 计划里的全部阶段
 * @param {unknown} [input.maxParallel] 并发上限（可选）
 * @returns {{stageIds:string[], maxParallel:number, stages:Array<object>}}
 */
export function validateBatch({ stageIds, readyNodeIds, stages, maxParallel }) {
  if (!Array.isArray(stageIds) || stageIds.length === 0) {
    throw fail(PARALLEL_CODE.BATCH, "stageIds 必须是非空数组", { got: stageIds ?? null });
  }

  if (stageIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw fail(PARALLEL_CODE.BATCH, "stageIds 必须只包含非空阶段 ID", {});
  }
  const unique = [...new Set(stageIds)];
  if (unique.length !== stageIds.length) {
    throw fail(PARALLEL_CODE.BATCH, "stageIds 有重复项", { stageIds });
  }

  const limit = normalizeMaxParallel(maxParallel);
  if (unique.length > limit) {
    throw fail(
      PARALLEL_CODE.LIMIT,
      `本批 ${unique.length} 个阶段超过并发上限 ${limit}`,
      { requested: unique.length, limit },
    );
  }

  const ready = new Set(readyNodeIds ?? []);
  const notReady = unique.filter((id) => !ready.has(id));
  if (notReady.length > 0) {
    throw fail(PARALLEL_CODE.BATCH, "存在未就绪的阶段", {
      notReady,
      readyNodeIds: [...ready],
    });
  }

  const byId = new Map((stages ?? []).map((s) => [s.id, s]));
  const picked = unique.map((id) => byId.get(id));
  const unknown = unique.filter((id, idx) => !picked[idx]);
  if (unknown.length > 0) {
    throw fail(PARALLEL_CODE.BATCH, "计划里没有这些阶段", { unknown });
  }

  const conflicts = findWriteConflicts(picked);
  if (conflicts.length > 0) {
    throw fail(PARALLEL_CODE.CONFLICT, "同批阶段写域重叠，需要串行执行", { conflicts });
  }

  return { stageIds: unique, maxParallel: limit, stages: picked };
}

/**
 * 回滚计划：给定失败点返回动作表；未知失败点一律按最保守（不动任务、不重试）。
 *
 * @param {keyof typeof FAILURE_POINTS} point
 */
export function rollbackFor(point) {
  const plan = ROLLBACK[point];
  if (!plan) {
    return { point, known: false, ...ROLLBACK.R5 };
  }
  return { point, known: true, label: FAILURE_POINTS[point], ...plan };
}

/**
 * 生成整批的回滚计划（阶段说明里点名的 `planBatch`）。
 *
 * 与 `rollbackFor` 的关系：`rollbackFor` 是单点查询，`planBatch` 是批级视图 ——
 * 给定整批 worker 的结果，判断本批该落哪个失败点、怎么收尾、要不要停任务。
 *
 * @param {Array<{stageId:string, ok:boolean, reason?:string}>} results
 * @returns {{point:string, failed:string[], dispatchFailed:boolean, partial:boolean, rollback:object}}
 */
export function planBatch(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r || r.ok !== true).map((r) => r?.stageId ?? "(unknown)");

  if (list.length === 0) {
    return { point: "R1", failed: [], dispatchFailed: true, partial: false, rollback: rollbackFor("R1") };
  }
  if (failed.length === 0) {
    return { point: "R7", failed: [], dispatchFailed: false, partial: false, rollback: rollbackFor("R7") };
  }

  // 一个都没成 = 建会话阶段就失败（R4）；部分成功也按 R4（整批取消，避免半成品）
  //
  // R5 的判据：worker **跑完了却没通过校验**（有 report 但仍 ok:false）。
  // 这类失败保留证据、停任务、不自动重试 —— 与 R4（压根没跑起来）语义不同。
  const ranButInvalid = list.some((r) => r?.ok !== true &&
    (r?.started === true || r?.phase === "execution" ||
      (typeof r?.report === "string" && r.report.trim().length > 0)));
  if (ranButInvalid) {
    return {
      point: "R5",
      failed,
      dispatchFailed: false,
      partial: failed.length < list.length,
      rollback: rollbackFor("R5"),
    };
  }

  const point = failed.length === list.length ? "R4" : "R4";
  const validationOnly = list.every((r) => r?.reason === "validation");
  const chosen = validationOnly ? "R2" : point;

  return {
    point: chosen,
    failed,
    dispatchFailed: failed.length === list.length,
    partial: failed.length < list.length,
    rollback: rollbackFor(chosen),
  };
}

/**
 * 同批写域断言（阶段说明里点名的 `assertDisjointWritePaths`）。
 *
 * 与 `findWriteConflicts` 的关系：后者只返回冲突对（查询），本函数在冲突时抛
 * `E_WRITE_CONFLICT`（断言），供接线层直接调用。
 *
 * @param {Array<{id:string, writePaths?:string[]}>} stages
 * @returns {true} 无冲突时返回 true
 */
export function assertDisjointWritePaths(stages) {
  const conflicts = findWriteConflicts(stages);
  if (conflicts.length > 0) {
    throw fail(PARALLEL_CODE.CONFLICT, "同批阶段写域重叠，需要串行执行", { conflicts });
  }
  return true;
}
