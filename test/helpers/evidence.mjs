/**
 * 测试用证据构造器（s4）。
 *
 * 为什么不让人手写 snippet：本会话里 s1 阶段就因为我手写证据行号错位被打回。
 * 这个 helper 直接读真实文件，取「声称行号处」的原行作为 snippet，
 * 因此天然命中 —— 手写容易错的不是逻辑，是记性。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根：test/helpers/ 往上两级 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 生成一条真实命中文件的证据。
 *
 * @param {string} relPath 相对项目根的路径
 * @param {number} [line] 声称行号（1 基）；省略则取第一条非空行
 * @returns {{file:string, line:number, snippet:string}}
 */
export function mkEvidence(relPath, line) {
  const abs = path.resolve(ROOT, relPath);
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/u);

  let target = line;
  if (!Number.isInteger(target) || target < 1) {
    target = lines.findIndex((l) => l.trim().length > 0) + 1;
    if (target < 1) target = 1;
  }

  const raw = lines[target - 1] ?? "";
  const snippet = raw.trim().length > 0 ? raw.trim() : " ";
  return { file: relPath, line: target, snippet };
}

/** 常用：一条证据 + 当前 planVersion 的报告参数 */
export function stageReportArgs(store, { relPath = "SPEC.md", line, ...rest } = {}) {
  const task = store.get();
  return {
    evidenceRefs: [mkEvidence(relPath, line)],
    planVersion: task?.planVersion ?? 1,
    ...rest,
  };
}
