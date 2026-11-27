/**
 * 审查裁决与整改闭环（SPEC §1.4 / §2.4）。
 *
 * 核心不变量：**提交响应不等于关闭**。
 *   open --(response)--> responded --(后续审查显式标记解决并 pass)--> closed
 * 只有审批方能关闭 finding，被审方只能提交响应。
 */

import { ERR, MentorError, assertOrThrow } from "../errors.js";
import {
  assertAttemptCurrent,
  assertDependenciesReady,
  collectDependents,
} from "../plan/dag.js";

export const VERDICT = Object.freeze({ PASS: "pass", REVISE: "revise" });
export const SEVERITY = Object.freeze({ BLOCKING: "blocking", ADVISORY: "advisory" });
export const FINDING_STATUS = Object.freeze({
  OPEN: "open",
  RESPONDED: "responded",
  CLOSED: "closed",
});

const VERDICTS = Object.values(VERDICT);
const SEVERITIES = Object.values(SEVERITY);

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/**
 * 引文校验：把「谁说了什么」从转述变成可机检的事实。
 *
 * 背景：上一轮审查把用户原话「一直在让我重启」转述成「你又让我重启」，
 * 回原会话检索 0 命中。所以 finding / evidence 里凡是加了引号的引文，
 * 必须能在被审证据原文中**逐字**找到；找不到就拒收并列未命中片段。
 *
 * @param {string[]} quotes 引文数组（可省略/空数组表示不校验）
 * @param {string} evidenceText 被审原文
 * @returns {{ok:boolean, missed:string[], checked:number}}
 */
export function verifyQuotes(quotes, evidenceText) {
  const list = Array.isArray(quotes) ? quotes : [];
  const haystack = typeof evidenceText === "string" ? evidenceText : "";
  const missed = [];
  let checked = 0;
  for (const raw of list) {
    const q = typeof raw === "string" ? raw.trim() : "";
    if (!q) continue;
    checked += 1;
    if (!haystack.includes(q)) missed.push(q);
  }
  return { ok: missed.length === 0, missed, checked };
}

/**
 * 检查清单规范化（改造 s4，矩阵 G1）。
 *
 * 旧实现的强制协议是「先落 task_review_check_plan，再打开产物」；mentor 没有审查
 * 会话内状态，所以把这条约束落到裁决数据结构上：每条检查必须同时给出
 * `source`（依据什么）与 `criterion`（要证明什么）—— 两者都非空才算一条检查，
 * 否则「我看了」这种无法核对的表述会混进审查记录。
 */
export function normalizeChecks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((c, i) => {
    assertOrThrow(c && typeof c === "object", ERR.INTERNAL, `checks[${i}] 必须是对象`);
    const source = typeof c.source === "string" ? c.source.trim() : "";
    const criterion = typeof c.criterion === "string" ? c.criterion.trim() : "";
    assertOrThrow(
      source.length > 0,
      ERR.INTERNAL,
      `checks[${i}] 缺少 source（这条检查依据什么）`,
    );
    assertOrThrow(
      criterion.length > 0,
      ERR.INTERNAL,
      `checks[${i}] 缺少 criterion（这条检查要证明什么）`,
    );
    const criterionIds = Array.isArray(c.criterionIds)
      ? c.criterionIds.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      : [];
    return {
      id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `ck_${i + 1}`,
      source,
      criterion,
      criterionIds,
      ...(typeof c.recheckId === "string" && c.recheckId.trim() ? {recheckId:c.recheckId.trim()} : {}),
      findingIds: Array.isArray(c.findingIds) ? c.findingIds.filter(x => typeof x === "string") : [],
      reportIds: Array.isArray(c.reportIds) ? c.reportIds.filter(x => typeof x === "string") : [],
      observation: typeof c.observation === "string" ? c.observation.trim() : "",
      status: typeof c.status === "string" ? c.status : "unverified",
    };
  });
}

/**
 * 证据存在性校验（改造 s4，矩阵 G7 的**第 1 道**过滤）。
 *
 * 准确表述：旧实现的证据资格有三道（存在 / 已读未过期 / 属当前版本），
 * mentor 只实现了第一道 —— 「这个 id 在本任务记录里真实存在」。另外两道
 * （审查方是否真的读过它、它是否属于当前 planVersion）mentor 没有对应机制，
 * 未实现，不假装等价。
 *
 * 空数组放行：旧实现 submit 路径对空 evidence_seqs 的判定**未确认**（本轮未取证），
 * 所以这里不擅自定为必须非空，而是显式记下这个未确认点。
 *
 * 旧取证的定性：旧实现要求 evidence_seqs 必须是审查会话真正读过的 seq，
 * 控制回执与失败结果一律排除。mentor 的等价物是「本任务真实产生过的证据 id」：
 * 阶段报告 id、审查 id、整改项 id。自由字符串不算证据 —— 否则整改链
 * 可以被伪造引用打穿。
 */
export function collectEvidenceIds(task) {
  const ids = new Set();
  for (const run of task?.nodeRuns ?? []) {
    for (const rep of run?.reports ?? []) {
      if (rep && typeof rep.id === "string" && rep.id) ids.add(rep.id);
    }
  }
  for (const r of task?.reviews ?? []) {
    if (r && typeof r.id === "string" && r.id) ids.add(r.id);
  }
  for (const f of task?.findings ?? []) {
    if (f && typeof f.id === "string" && f.id) ids.add(f.id);
  }
  return ids;
}

/**
 * 校验一组证据引用；空数组放行（响应可以不附证据，但附了就必须真实存在）。
 *
 * @param {object} task
 * @param {string[]} evidenceIds
 * @param {string} [where] 报错时用的字段名
 */
export function assertEvidenceRefs(task, evidenceIds, where = "evidenceIds") {
  const list = Array.isArray(evidenceIds) ? evidenceIds : [];
  if (list.length === 0) return { ok: true, checked: 0 };

  const known = collectEvidenceIds(task);
  const unknown = list.filter((id) => typeof id !== "string" || !known.has(id));
  assertOrThrow(
    unknown.length === 0,
    ERR.EVIDENCE_UNKNOWN,
    `${where} 引用了本任务里不存在的证据：${unknown.map((x) => String(x)).join(", ")}`,
    { unknown, checked: list.length, knownCount: known.size },
  );
  return { ok: true, checked: list.length };
}

/**
 * 构造一条 finding（尚未挂在任务上）。
 *
 * quotes/evidenceText 若同时给出，则做引文校验：任一条逐字找不到即抛
 * E_QUOTE_NOT_FOUND，details.missed 带未命中的原片段（不改写成近似）。
 */
export function createFinding({ reviewId, stageId, severity, text, quotes, evidenceText, id, at }) {
  assertOrThrow(
    SEVERITIES.includes(severity),
    ERR.INTERNAL,
    `未知严重度：${severity}`,
    { severity, allowed: SEVERITIES },
  );
  assertOrThrow(
    typeof text === "string" && text.trim().length > 0,
    ERR.INTERNAL,
    "finding 文本不能为空",
  );

  const q = verifyQuotes(quotes, evidenceText);
  assertOrThrow(
    q.ok,
    ERR.QUOTE_NOT_FOUND,
    `finding 引文在被审证据中未命中：${q.missed.join(" / ")}`,
    { missed: q.missed, checked: q.checked },
  );

  return {
    id: id ?? nextId("f"),
    reviewId: reviewId ?? null,
    // 2026-11-04 修 P0-2：记录归属阶段。原实现没有这个字段，
    // 于是 markedResolved 可以跨阶段关闭任意 finding。
    stageId: stageId ?? null,
    severity,
    text: text.trim(),
    quotes: Array.isArray(quotes) ? quotes.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [],
    status: FINDING_STATUS.OPEN,
    responses: [],
    resolvedByReviewId: null,
    createdAt: at ?? Date.now(),
  };
}

/**
 * 构造一次审查裁决。
 *
 * revise 必须指明至少一个缺口：可以新增 finding，也可以引用尚未解决的旧 finding。
 */
/** Resolve existing issue references and reuse exact same-scope revise findings. */
export function prepareReviewFindings(task, { stageId, verdict, findings = [], existingFindingIds = [], allowedStageIds = [stageId] }) {
  assertOrThrow(Array.isArray(existingFindingIds), ERR.FINDING_UNKNOWN, "existingFindingIds 必须是数组");
  const referenced = new Set();
  for (const id of existingFindingIds) {
    const finding = findingById(task, id);
    assertOrThrow(finding.status !== FINDING_STATUS.CLOSED && allowedStageIds.includes(finding.stageId),
      ERR.REVIEW_SCOPE, "只能引用本次审查范围内尚未关闭的问题", { findingId: finding.id });
    referenced.add(finding.id);
  }
  assertOrThrow(verdict !== VERDICT.PASS || referenced.size === 0, ERR.REVIEW_VERDICT,
    "pass 不能同时声明尚未解决的 existingFindingIds；已复核解决的问题请用 markedResolved");
  const fresh = [];
  for (const item of Array.isArray(findings) ? findings : []) {
    const text = typeof item === "string" ? item.trim() : item?.text?.trim();
    const severity = typeof item === "string" ? SEVERITY.BLOCKING : item?.severity ?? SEVERITY.BLOCKING;
    const existing = verdict === VERDICT.REVISE && text
      ? (task.findings ?? []).find(f => f.status !== FINDING_STATUS.CLOSED && f.stageId === stageId &&
          f.severity === severity && f.text?.trim() === text)
      : null;
    if (existing) referenced.add(existing.id); else fresh.push(item);
  }
  return { findings: fresh, existingFindingIds: [...referenced] };
}

export function createReview({ stageId, attempt, planVersion, verdict, findings, existingFindingIds = [], checks, id, at }) {
  assertOrThrow(
    VERDICTS.includes(verdict),
    ERR.INTERNAL,
    `未知裁决：${verdict}`,
    { verdict, allowed: VERDICTS },
  );

  const list = Array.isArray(findings) ? findings : [];
  if (verdict === VERDICT.REVISE) {
    assertOrThrow(
      list.length > 0 || existingFindingIds.length > 0,
      ERR.INTERNAL,
      "revise 须给出新 finding 或引用尚未解决的 existingFindingIds",
    );
  }

  const reviewId = id ?? nextId("r");
  const reviewFindings = list.map((f) =>
    typeof f === "string"
      ? createFinding({ reviewId, stageId, severity: SEVERITY.BLOCKING, text: f, at })
      : { ...f, reviewId, stageId: f.stageId ?? stageId ?? null, status: FINDING_STATUS.OPEN, resolvedByReviewId: null },
  );

  return {
    id: reviewId,
    scope: {
      kind: "stage",
      stageId: stageId ?? null,
      attempt: attempt ?? 1,
      ...(Number.isInteger(planVersion) && planVersion >= 1 ? { planVersion } : {}),
    },
    verdict,
    findings: reviewFindings,
    existingFindingIds: [...existingFindingIds],
    // 检查清单（G1）：空数组表示审查方没给清单，是否允许由上层配置决定
    checks: normalizeChecks(checks),
    // 本次审查显式声明「已复核并确认解决」的 finding id
    markedResolved: [],
    at: at ?? Date.now(),
  };
}

/** 提交整改响应：open/responded → responded。不改变 closed。 */
export function submitFindingResponse(finding, { summary, evidenceIds, id, at } = {}) {
  assertOrThrow(
    finding && typeof finding === "object",
    ERR.INTERNAL,
    "finding 必须是对象",
  );
  assertOrThrow(
    finding.status !== FINDING_STATUS.CLOSED,
    ERR.INTERNAL,
    `finding ${finding.id} 已关闭，不能再提交响应`,
    { findingId: finding.id },
  );
  assertOrThrow(
    typeof summary === "string" && summary.trim().length > 0,
    ERR.INTERNAL,
    "响应必须带 summary",
  );

  const response = {
    id: id ?? nextId("fr"),
    findingId: finding.id,
    summary: summary.trim(),
    evidenceIds: Array.isArray(evidenceIds) ? [...evidenceIds] : [],
    at: at ?? Date.now(),
  };

  return {
    ...finding,
    status: FINDING_STATUS.RESPONDED,
    responses: [...(finding.responses ?? []), response],
  };
}

/**
 * 关闭 finding —— 只允许审批方在「显式复核通过」时调用。
 *
 * 2026-11-09 修机制问题②：新增 `allowOpen` 选项。
 *
 * 真机踩到的形态：finding 由**上一轮 revise 审查**提出（open），执行方改完后，
 * 下一轮 pass 审查想用 markedResolved 关掉它——旧规则要求「status 必须是 responded」，
 * 于是「内容已全部修复」的那一轮还要再被打回一次，只为补一次 respond。
 *
 * 但 finding 在 revise 轮提出、pass 轮才关闭，**跨 review**，所以不能用「同一 review 产出」
 * 来判断。改为：pass 裁决可以关闭本阶段的 open finding（`allowOpen`），并打
 * `closedWithoutResponse: true` 留痕，便于事后区分「响应后关闭」与「未经响应直接关闭」。
 *
 * 为什么这不削弱「响应≠关闭」：关不关仍由**审查方**决定（markedResolved），
 * 执行方（findingRespond / submitFindingResponse）依旧没有关闭入口；respond 从
 * 「关闭的前置」降为「可选的补充说明」。
 */
export function closeFinding(finding, reviewId, { allowOpen = false } = {}) {
  assertOrThrow(
    finding && typeof finding === "object",
    ERR.INTERNAL,
    "finding 必须是对象",
  );
  const responded = finding.status === FINDING_STATUS.RESPONDED;
  const closedWithoutResponse = allowOpen === true && finding.status === FINDING_STATUS.OPEN;
  assertOrThrow(
    responded || closedWithoutResponse,
    ERR.FINDING_NOT_RESPONDED,
    `finding ${finding.id} 当前状态是 ${finding.status}，只有 responded（或由 pass 审查直接关闭 open）才能被复核关闭`,
    { findingId: finding.id, status: finding.status, allowOpen },
  );
  assertOrThrow(
    typeof reviewId === "string" && reviewId.length > 0,
    ERR.INTERNAL,
    "关闭 finding 必须指明是哪个 review 复核的",
  );

  return {
    ...finding,
    status: FINDING_STATUS.CLOSED,
    resolvedByReviewId: reviewId,
    ...(closedWithoutResponse ? { closedWithoutResponse: true } : {}),
  };
}

/**
 * 用户侧强制关闭（2026-11-04 修 P1-3）。
 *
 * 与 closeFinding 的区别：不要求 responded 状态、不要求有 review 复核。
 * 用途：reviewer 一直不写 markedResolved（实测三轮全空）、任务被 E_BLOCKING_FINDING_OPEN
 * 挡死时的唯一人工出口。已 closed 时幂等返回，不报错。
 */
export function forceCloseFinding(finding, reason, closedBy = "user") {
  assertOrThrow(
    finding && typeof finding === "object",
    ERR.INTERNAL,
    "finding 必须是对象",
  );
  if (finding.status === FINDING_STATUS.CLOSED) return finding;
  return {
    ...finding,
    status: FINDING_STATUS.CLOSED,
    resolvedByReviewId: finding.resolvedByReviewId ?? null,
    closedBy,
    closeReason: typeof reason === "string" ? reason : "",
    closedAt: Date.now(),
  };
}

/**
 * 执行方提交某节点的证据（SPEC §2.3）。
 *
 * 三道闸门，任一不过返回结构化错误而不是静默接受：
 *   1. stage 必须存在于计划中
 *   2. attempt 必须等于当前尝试号（防重复提交/陈旧轮次）
 *   3. 前置阶段必须全部 accepted（DAG 顺序不能跳）
 *
 * 通过后：证据追加进该 nodeRun.reports，status 置 reported，等审查裁决。
 */
export function submitStageReport(task, { stageId, attempt, evidence, summary, planVersion, evidenceRefs, evidenceFiles, bindings, integrationEvidence, impactPreview, handoff } = {}) {
  assertOrThrow(!!task && typeof task === "object", ERR.INTERNAL, "task 必须是对象");

  const stage = (task.stages ?? []).find((s) => s && s.id === stageId);
  if (!stage) {
    throw new MentorError(ERR.STAGE_UNKNOWN, `计划里没有 stage：${stageId}`, {
      stageId,
      knownStages: (task.stages ?? []).map((s) => s.id),
    });
  }

  // 复用 dag.js 的两道既有校验，避免同一规则写两遍
  assertAttemptCurrent(stageId, attempt, task.nodeRuns);
  assertDependenciesReady(stage, task.nodeRuns);

  const ev = typeof evidence === "string" ? evidence.trim() : "";
  assertOrThrow(ev.length > 0, ERR.INTERNAL, "evidence 不能为空");

  const report = {
    id: nextId("rep"),
    stageId,
    attempt,
    evidence: ev,
    summary: typeof summary === "string" ? summary.trim() : "",
    integrationEvidence: typeof integrationEvidence === "string" ? integrationEvidence.trim() : "",
    // SPEC §2.6：报告必须落库它依据的计划版本与结构化证据，供审查与回溯
    planVersion: Number.isInteger(planVersion) ? planVersion : null,
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    ...(Array.isArray(evidenceFiles) ? { evidenceFiles } : {}),
    ...(bindings?.length ? {bindings} : {}),
    ...(impactPreview ? {impactPreview} : {}),
    ...(handoff ? {handoff} : {}),
    at: Date.now(),
  };

  const existed = (task.nodeRuns ?? []).some((r) => r.stageId === stageId);
  const nodeRuns = existed
    ? (task.nodeRuns ?? []).map((r) =>
        r.stageId === stageId
          ? {
              ...r,
              status: "reported",
              reports: [...(r.reports ?? []), report],
            }
          : r,
      )
    : [
        ...(task.nodeRuns ?? []),
        { stageId, attempt, status: "reported", reports: [report] },
      ];

  return {
    ...task,
    nodeRuns,
    revision: (task.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
}

/**
 * 把一次审查裁决合并进任务（返回新任务，不修改入参）。
 *
 * 做四件事：
 *   1. 新 findings 以 open 状态挂到任务
 *   2. markedResolved 里的 finding 从 responded 转 closed
 *   3. review 存入历史
 *   4. 对应 nodeRun 的 status 按裁决更新（pass→accepted / revise→rework）
 */
export function applyReview(task, review) {
  assertOrThrow(!!task && typeof task === "object", ERR.INTERNAL, "task 必须是对象");
  assertOrThrow(
    review && VERDICTS.includes(review.verdict),
    ERR.INTERNAL,
    "review 缺少合法 verdict",
  );

  const existingIds = new Set((task.findings ?? []).map((f) => f.id));

  // 2026-11-04 修 P2-4：同 id 的 finding 以前被静默过滤掉，但 review 仍完整进
  // reviews —— 于是「审查历史里记着这条整改要求，task.findings 里却没有」，面板
  // 未关闭问题少一条、completion 闸门也看不见它。现在改为显式报错。
  const dupIds = [
    ...new Set(
      (review.findings ?? [])
        .map((f) => f && f.id)
        .filter((id) => id && existingIds.has(id)),
    ),
  ];
  // 同一 review 重放是合法幂等操作（任务重算/重试场景），不算冲突；
  // 只有**不同 review** 撞同一 finding id 才是 P2-4 说的静默丢弃。
  const isReplay = (task.reviews ?? []).some((r) => r && r.id === review.id);
  if (dupIds.length > 0 && !isReplay) {
    throw new MentorError(
      ERR.FINDING_DUP,
      `finding id 冲突：${dupIds.join(", ")} 已存在于本任务`,
      { duplicateIds: dupIds },
    );
  }

  // 1. 新 finding。重放同一 review 时要过滤掉已挂载的（保持幂等、不重复 push）；
  //    走到这里的非重放路径已经在上一步把撞 id 的情况抛掉了，所以是全量。
  const fresh = isReplay
    ? (review.findings ?? []).filter((f) => !existingIds.has(f && f.id))
    : (review.findings ?? []);
  let findings = [...(task.findings ?? []), ...fresh];

  // 只关闭审查方明确核验过的本阶段问题，响应不等于解决。
  // 2026-11-09 c3：markedResolved 允许写「文本里的编号」（如 G1），这里先归一成真实 id；
  // 歧义（同一编号多命中）与完全未知都显式抛错，不瞎猜。工具层（handlers.reviewApply）已先归一，
  // 这里再兜一层，保证直接调 applyReview 的调用方行为一致。
  const marked = new Set(
    (review.markedResolved ?? []).map((id) => findingById(task, id).id),
  );
  if (marked.size > 0 && review.verdict !== VERDICT.PASS) throw new MentorError(ERR.INTERNAL,"只有 pass 裁决才能关闭 finding");
  for (const id of marked) {
    const finding=findings.find(f=>f.id===id);
    if (!finding || finding.stageId !== review.scope.stageId) throw new MentorError(ERR.REVIEW_SCOPE,"整改项不属于本阶段",{findingId:id});
  }
  const closedFindingIds = [...marked];
  // 2026-11-09：pass 可以关闭本阶段的 open finding —— finding 通常在上一轮 revise 提出，
  // 等到 pass 才关，跨 review，所以不能用「同一 review 产出」判定。
  // 关闭动作仍只发生在审查方（markedResolved），执行方没有关闭入口。
  findings=findings.map(f=>marked.has(f.id)?closeFinding(f,review.id,{allowOpen:true}):f);

  // 3. 审查历史
  const reviews = [...(task.reviews ?? []), review];

  // 4. 节点运行状态
  const { stageId, attempt } = review.scope ?? {};
  const isPass = review.verdict === VERDICT.PASS;

  // revise 时被审节点本身变 rework，但**已 accepted 的后继不会自动失效**——
  // readyNodes 只看 status，accepted 记录不变就一直算完成。
  // 必须把传递依赖被审阶段的、当前 accepted 的后继一并置回 rework，否则等于拿旧结果继续推进。
  // （这条缺口是 s3 审查指出的：主动返工工具拒绝非 accepted 节点，revise 路径就再没有别的失效入口。）
  const dependents = isPass
    ? new Set()
    : collectDependents(task.stages, stageId);
  const invalidated = [];

  const nodeRuns = (task.nodeRuns ?? []).map((run) => {
    if (run.stageId === stageId && run.attempt === attempt) {
      return {
        ...run,
        status: isPass ? "accepted" : "rework",
        lastReviewId: review.id,
        // SPEC §2.3：revise 后下次报告必须 attempt+1，pass 则保持当前尝试号
        attempt: isPass ? run.attempt : run.attempt + 1,
        ...(!isPass && run.batchId != null ? { batchId: null } : {}),
        ...(!isPass && run.workerSessionId != null ? { workerSessionId: null } : {}),
      };
    }
    // 2026-11-04 修 P1-5：原来只失效 accepted 的后继。若后继处于 reported
    // （已上报等审）就不会被失效 —— reviewer 仍可能给它 pass，那个 pass 的依据
    // 是被废弃的上游结果。accepted 与 reported 都必须失效。
    if (
      !isPass &&
      dependents.has(run.stageId) &&
      (run.status === "accepted" || run.status === "reported")
    ) {
      invalidated.push(run.stageId);
      return {
        ...run,
        status: "rework",
        attempt: run.attempt + 1,
        ...(run.batchId != null ? { batchId: null } : {}),
        ...(run.workerSessionId != null ? { workerSessionId: null } : {}),
      };
    }
    return run;
  });

  return {
    ...task,
    findings,
    reviews,
    nodeRuns,
    invalidated,
    closedFindingIds,
    revision: (task.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
}

/** 未关闭的 finding（含 open 与 responded） */
export function openFindings(task) {
  return (task.findings ?? []).filter((f) => f.status !== FINDING_STATUS.CLOSED);
}

/** 未关闭的 blocking finding —— 它是完成请求的硬闸门 */
export function blockingOpenFindings(task) {
  return openFindings(task).filter((f) => f.severity === SEVERITY.BLOCKING);
}

/**
 * 从 finding 文本里提取「审查方在报告里用的编号」（如 `G1`、`F2`），作为别名。
 *
 * 2026-11-09 修机制问题③：真机上出现过 id 是 `f_mw8dzih4_8` 而审查文本里写的是
 * 「G1 是唯一 neverResponded 的 blocking 整改项」的情况——调用方照文本里的编号去
 * respond 会找不到（或更糟：respond 到另一条同名的派生 id 上）。
 */
export function findingAlias(finding) {
  if (!finding || typeof finding.text !== "string") return null;
  const match = finding.text.match(/\b([A-Z]{1,3}\d{1,3})\b/);
  return match ? match[1] : null;
}

export function findingById(task, findingId) {
  const list = Array.isArray(task.findings) ? task.findings : [];
  const exact = list.find((f) => f && f.id === findingId);
  if (exact) return exact;

  // 精确 id 未命中时，按文本里的编号做一次兜底解析（必须唯一命中才算）
  const aliased = list.filter((f) => findingAlias(f) === findingId);
  if (aliased.length === 1) return aliased[0];
  if (aliased.length > 1) {
    throw new MentorError(
      ERR.FINDING_UNKNOWN,
      `finding 别名 ${findingId} 命中多条，请改用精确 id`,
      { findingId, candidates: aliased.map((f) => f.id) },
    );
  }

  throw new MentorError(ERR.FINDING_UNKNOWN, `找不到 finding：${findingId}`, {
    findingId,
    known: list.map((f) => f.id),
    aliases: list.map((f) => findingAlias(f)).filter(Boolean),
  });
}

/** 断言没有未关闭的 blocking finding */
export function assertNoUnresolvedBlocking(task) {
  const blocking = blockingOpenFindings(task);
  if (blocking.length > 0) {
    throw new MentorError(
      ERR.BLOCKING_FINDING_OPEN,
      `仍有 ${blocking.length} 条 blocking finding 未关闭`,
      { findingIds: blocking.map((f) => f.id) },
    );
  }
}

/**
 * 未解决问题清单 —— 给审查结论用。
 * 区分「从未响应」与「响应了但没被复核关闭」，后者才是真正的僵局。
 */
export function unresolvedSummary(task) {
  const open = openFindings(task);
  return {
    total: open.length,
    blocking: open.filter((f) => f.severity === SEVERITY.BLOCKING).length,
    neverResponded: open.filter((f) => f.status === FINDING_STATUS.OPEN).length,
    awaitingRecheck: open.filter((f) => f.status === FINDING_STATUS.RESPONDED).length,
    items: open.map((f) => ({
      id: f.id,
      severity: f.severity,
      status: f.status,
      text: f.text,
    })),
  };
}
