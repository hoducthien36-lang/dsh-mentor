import { ERR, MentorError } from "../errors.js";

// Detect the specific reporting burden independently from ordinary source references.
const perItem = /(?:每(?:一)?(?:个|项|条|行|组|处|列)|逐(?:个|项|条|行)|每个数字|\b(?:each|every|per)[ -](?:reported |individual )?(?:number|value|result|assertion|item|row|entry|figure|metric)s?\b)/iu;
const sourceLine = /(?:行号|哪一行|第几行|来源行|原始行位置|行级引用|行锚|\bline[ -](?:numbers?|references?|citations?)\b)/iu;
const reporting = /(?:证据|来源|出处|取自|引文|引用|断言表|报告|标注|溯源|溯及|report|evidence|citation|cite|provenance|reference)/iu;
const negated = /(?:不用|无需|无须|不再要求|不必|不需要|不要|禁止|避免|取消|去掉|不要求|不强制|不应|不希望|no need|do not|don't|not required|without)/iu;

function citationDecision(text, reportingOnly = false) {
  let result;
  for (const clause of String(text ?? "").split(/[。！？；;\n]/u)) {
    if ((!reportingOnly || reporting.test(clause)) && perItem.test(clause) && sourceLine.test(clause)) result = !negated.test(clause);
  }
  return result;
}

export function assertRequestedCitationScope(task, plan, session) {
  const entries = [
    ...(Array.isArray(plan.criteria) ? plan.criteria.map(c => [c?.id, c?.text]) : []),
    ...(Array.isArray(plan.stages) ? plan.stages.map(s => [s?.id, [s?.title, s?.description].join("。")]) : []),
  ];
  const offending = entries.filter(([,text]) => citationDecision(text, true) === true);
  if (!offending.length) return;

  const userEvents = (session?.snapshotEvents?.() ?? []).filter(e =>
    e.type === "user/message" && e.data?.source?.kind === "user");
  // Restrict authorization to the request that opened this task and subsequent user turns.
  const start = userEvents.findLastIndex(e => e.time <= task.createdAt);
  let authorized = task.humanCitationRequest === true;
  for (const event of userEvents.slice(Math.max(0, start))) {
    const content = event.data.content;
    const decision = citationDecision(Array.isArray(content)
      ? content.filter(b => b.type === "text").map(b => b.text).join("\n") : content);
    if (decision !== undefined) authorized = decision;
  }
  if (!authorized) throw new MentorError(ERR.PLAN_CITATION_SCOPE,
    "本次用户请求没有要求逐项标注来源行号。请保留实际验收结果，全文性质请登记整个文件，局部事实可引用原文片段，再提交计划。",
    { entries: offending.map(([id]) => id) });
}

export function explicitlyRequestsLineCitations(text) {
  return citationDecision(text) === true;
}
