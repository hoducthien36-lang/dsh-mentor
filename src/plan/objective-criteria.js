import { ERR, MentorError } from "../errors.js";

// Accept an explicit list in any language. The desktop also writes Chinese
// objectives with a labeled, sequential ①②… checklist.
function numberedGoals(objective) {
  const list = /(?:观察|验证|核对|验收)(?:以下|如下)?[一二三四五六七八九十\d]*(?:点|项|目标|要求)?[：:]\s*(①[^\n]*(?:\n[ \t]*[②-⑳][^\n]*)*)/u.exec(objective);
  if (!list) return [];
  const items = [...list[1].matchAll(/([①-⑳])([^①-⑳]+)/gu)];
  if (items.length < 2 || items.some((item, i) => item[1].codePointAt(0) !== 0x2460 + i)) return [];
  return items.map(item => item[2].trim().replace(/[；;。]+$/u, "").trim());
}

export function objectiveCriteria(objective, supplied = []) {
  if (!Array.isArray(supplied) || supplied.some(item => typeof item !== "string" || !item.trim())) {
    throw new MentorError(ERR.EMPTY_PLAN, "acceptanceGoals 需要填写非空的目标文本数组");
  }
  const texts = new Set([...numberedGoals(objective), ...supplied.map(item => item.trim())]);
  return [...texts].map((text, i) => ({ id: "goal-" + (i + 1), text }));
}

export function includeObjectiveCriteria(required, proposed) {
  if (!required?.length) return proposed;
  const reserved = new Set(required.map(item => item.id));
  return [...required.map(item => {
    const spec = proposed.find(c => c?.id === item.id);
    return { ...item, ...(spec?.observe !== undefined && { observe: spec.observe }),
      ...(spec?.verifyAt !== undefined && { verifyAt: spec.verifyAt }) };
  }), ...proposed.filter(item => !reserved.has(item?.id))];
}
