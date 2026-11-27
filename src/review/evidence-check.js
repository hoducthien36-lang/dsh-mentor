/**
 * 结构化证据核对（SPEC §2.6 门槛一）。
 *
 * 为什么要有这个模块：本会话里 s1 阶段被打回 4 次，理由高度一致 ——
 * 报告写「我改了 / 见某文件」，而审查方要的是「文件里哪一行、哪段原文」。
 * 靠人自觉写清楚已经失败过多次，所以把这条约束做成机器可执行的校验：
 *   · 缺字段 / 空数组 → 拒收
 *   · snippet 在文件里找不到 → 拒收并列未命中项
 *
 * 设计边界：纯函数，不 import DSH，不读全局状态；读文件由调用方注入
 * （`readFile`），因此可以完全脱离真实文件系统测试。
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";

import { EVIDENCE_PREVIEW_BYTES, isSensitivePath } from "./evidence-reader.js";
import { ERR, MentorError, assertOrThrow } from "../errors.js";

/**
 * 本模块使用的错误码（SPEC §3 已登记）。
 *
 * 保留公开的 CODE 名称；具体值来自统一错误表。
 */
export const CODE = Object.freeze({
  EVIDENCE_REQUIRED: ERR.EVIDENCE_REQUIRED,
  EVIDENCE_MISMATCH: ERR.EVIDENCE_MISMATCH,
  EVIDENCE_OUTSIDE: ERR.EVIDENCE_OUTSIDE,
});

/** snippet 命中窗口：允许声称行号与实际行号差 ±3 行（容忍插入/删除行） */
export const LINE_WINDOW = 3;

/**
 * 形状校验。返回规范化后的条目数组；任何不合规都抛 `E_EVIDENCE_REQUIRED`。
 *
 * @param {unknown} items
 * @returns {Array<{file:string, scope:"file"} | {file:string, line?:number, snippet:string}>}
 */
export function normalizeEvidence(items) {
  assertOrThrow(
    Array.isArray(items) && items.length > 0,
    CODE.EVIDENCE_REQUIRED,
    "evidence 必填且不能为空数组：整份文件用 {file, scope:\"file\"}，片段用 {file, snippet}，有歧义时加 line",
    { index: null, missing: ["evidence"] },
  );

  return items.map((item, index) => {
    assertOrThrow(
      item && typeof item === "object",
      CODE.EVIDENCE_REQUIRED,
      `evidence[${index}] 必须是对象`,
      { index, missing: ["{file,line,snippet}"] },
    );

    const missing = [];
    const file = typeof item.file === "string" ? item.file.trim() : "";
    if (item.scope !== undefined) {
      assertOrThrow(item.scope === "file" && file.length > 0 &&
        item.line === undefined && item.snippet === undefined, CODE.EVIDENCE_REQUIRED,
        '全文登记使用 {file, scope:"file"}，不带 line 或 snippet', { index });
      return {file, scope:"file"};
    }
    const snippet = typeof item.snippet === "string" ? item.snippet : "";
    const line = item.line;

    if (file.length === 0) missing.push("file");
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) missing.push("line");
    if (snippet.trim().length === 0) missing.push("snippet");

    assertOrThrow(
      missing.length === 0,
      CODE.EVIDENCE_REQUIRED,
      `evidence[${index}] 缺字段或取值非法：${missing.join(", ")}`,
      { index, missing },
    );

    return { file, line, snippet };
  });
}

/**
 * 判断 file 是否逃出项目根。只做字符串级规范化判断，不碰真实路径。
 *
 * @param {string} root 项目根（绝对路径）
 * @param {string} file 证据里的相对路径
 * @returns {boolean} true = 越界
 */
export function isOutsideRoot(root, file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/** 去掉行首缩进空白，避免「缩进不同」被当成不命中 */
function normalizeLine(text) {
  return String(text ?? "").replace(/^\s+/u, "").trimEnd();
}

/**
 * 逐条核对（同步核心）。
 *
 * 为什么需要同步版：s4 接线时确认 `HANDLERS` 是同步 map，`stageReport` 不能改成
 * async（否则 33 处既有单测调用点都要加 await，与本次目标无关且放大风险）。
 * 于是把比对逻辑放在同步核心，异步版先预读文件再复用同一核心 —— 只有一份比对逻辑。
 *
 * @param {unknown} items
 * @param {(absPath:string)=>string} readSync 同步读文件（注入）
 * @param {{root?:string}} [options]
 */
export function checkEvidenceSync(items, readSync, options = {}) {
  const evidence = normalizeEvidence(items);
  const root = typeof options.root === "string" && options.root.length > 0 ? options.root : null;

  const misses = [];
  const verified = [];
  let hits = 0;
  const sources = new Map();
  const evidenceFiles = new Map();
  const wholeFiles = new Set(evidence.filter(ref => ref.scope === "file").map(ref => path.resolve(root ?? ".", ref.file)));

  for (const item of evidence) {
    if (isSensitivePath(item.file)) {
      misses.push({ ...item, reason: "outside-root", detail: "出于安全限制，不允许将凭据或密钥类敏感文件作为证据" });
      continue;
    }
    if (root && isOutsideRoot(root, item.file)) {
      misses.push({ ...item, reason: "outside-root" });
      continue;
    }

    const filename = root ? path.resolve(root, item.file) : item.file;
    let source = sources.get(filename);
    try {
      if (!source) {
        const whole = wholeFiles.has(path.resolve(filename));
        const raw = readSync(filename, whole ? EVIDENCE_PREVIEW_BYTES : undefined);
        if (whole && raw instanceof Uint8Array && !isUtf8(raw)) {
          throw new MentorError(CODE.EVIDENCE_MISMATCH, "全文登记需要有效的 UTF-8 文本");
        }
        const text = raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8") : String(raw);
        if (whole && (Buffer.byteLength(text, "utf8") > EVIDENCE_PREVIEW_BYTES || text.includes("\0"))) {
          throw new MentorError(CODE.EVIDENCE_MISMATCH, "全文登记仅支持不超过 2 MiB 的 UTF-8 文本；大文件请提交具体片段");
        }
        source = { lines: text.split(/\r?\n/u) };
        if (options.fingerprint || whole) source.sha256 = createHash("sha256").update(text, "utf8").digest("hex");
        sources.set(filename, source);
      }
    } catch (err) {
      misses.push({
        ...item,
        reason: err?.code === CODE.EVIDENCE_OUTSIDE ? "outside-root" : err?.code === CODE.EVIDENCE_MISMATCH ? "unreadable-text" : "file-not-found",
        detail: String((err && err.message) ?? err),
      });
      continue;
    }

    if (item.scope === "file") {
      hits += 1;
      verified.push({file: item.file, scope: "file"});
      evidenceFiles.set(item.file, {file: item.file, textSha256: source.sha256});
      continue;
    }
    const { lines } = source;
    if (item.line > lines.length) {
      misses.push({ ...item, reason: "line-out-of-range", totalLines: lines.length });
      continue;
    }

    const want = normalizeLine(item.snippet);
    const auto = item.line === undefined;
    const start = auto ? 1 : Math.max(1, item.line - LINE_WINDOW);
    const end = auto ? lines.length : Math.min(lines.length, item.line + LINE_WINDOW);

    const matches = [];
    if (!auto && normalizeLine(lines[item.line - 1]).includes(want)) {
      matches.push(item.line);
    } else {
      for (let ln = start; ln <= end; ln += 1) {
        if (!normalizeLine(lines[ln - 1]).includes(want)) continue;
        matches.push(ln);
        if (!auto || matches.length === 2) break;
      }
    }
    if (matches.length === 2) {
      misses.push({ ...item, reason: "ambiguous-snippet", candidateLines: matches, hint: "请给出 line 或更长的唯一片段" });
      continue;
    }
    const [matchedAt] = matches;
    if (matchedAt === undefined) {
      misses.push({ ...item, reason: auto ? "snippet-not-found" : "snippet-not-found-in-window", window: [start, end] });
      continue;
    }

    hits += 1;
    verified.push({ ...item, line: item.line ?? matchedAt, matchedAt });
    if (source.sha256) evidenceFiles.set(item.file, { file: item.file, textSha256: source.sha256 });
  }

  return { ok: misses.length === 0, hits, misses, evidence: verified,
    ...(options.fingerprint || wholeFiles.size ? { evidenceFiles: [...evidenceFiles.values()] } : {}) };
}

/**
 * 逐条核对（异步包装）：先预读所有文件，再交给同步核心比对。
 *
 * @param {unknown} items
 * @param {(absPath:string)=>Promise<string>|string} readFile
 * @param {{root?:string}} [options]
 * @returns {Promise<{ok:boolean, hits:number, misses:Array<object>, evidence:Array<object>}>}
 */
export async function checkEvidence(items, readFile, options = {}) {
  const evidence = normalizeEvidence(items);
  const root = typeof options.root === "string" && options.root.length > 0 ? options.root : null;

  const cache = new Map();
  for (const item of evidence) {
    if (root && isOutsideRoot(root, item.file)) continue;
    const abs = root ? path.resolve(root, item.file) : item.file;
    if (cache.has(abs)) continue;
    try {
      cache.set(abs, await readFile(abs));
    } catch (err) {
      cache.set(abs, { __error: err });
    }
  }

  return checkEvidenceSync(
    evidence,
    (abs) => {
      const value = cache.get(abs);
      if (value && value.__error) throw value.__error;
      return value ?? "";
    },
    options,
  );
}

/**
 * 断言版本：不通过就抛结构化错误。
 *
 * @param {unknown} items
 * @param {(absPath:string)=>Promise<string>|string} readFile
 * @param {{root?:string}} [options]
 */
export async function assertEvidence(items, readFile, options = {}) {
  return assertVerified(await checkEvidence(items, readFile, options));
}

/**
 * 断言版本（同步）。handler 里用它，避免把同步工具链路改成异步。
 *
 * @param {unknown} items
 * @param {(absPath:string)=>string} readSync
 * @param {{root?:string}} [options]
 */
export function assertEvidenceSync(items, readSync, options = {}) {
  return assertVerified(checkEvidenceSync(items, readSync, options));
}

function assertVerified(result) {
  if (result.ok) return result;

  const outside = result.misses.filter((m) => m.reason === "outside-root");
  if (outside.length > 0) {
    throw new MentorError(
      CODE.EVIDENCE_OUTSIDE,
      `${outside.length} 条证据路径逃出项目根`,
      { files: outside.map((m) => m.file), misses: result.misses, hits: result.hits },
    );
  }

  throw new MentorError(
    CODE.EVIDENCE_MISMATCH,
    `${result.misses.length} 条证据未命中（共 ${result.misses.length + result.hits} 条）`,
    { misses: result.misses, hits: result.hits },
  );
}
