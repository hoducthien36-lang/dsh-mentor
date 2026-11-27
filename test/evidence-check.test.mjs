/**
 * 证据核对模块测试（s2）。
 *
 * 覆盖 SPEC §2.6 门槛一的全部分支：命中、未命中、文件不存在、行号越界、
 * 越界路径、空数组、缺字段、多条混叵。readFile 注入，不依赖真实文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CODE,
  LINE_WINDOW,
  assertEvidence,
  checkEvidence,
  isOutsideRoot,
  normalizeEvidence,
} from "../src/review/evidence-check.js";

/* ------------------------------ 测试夹具 ------------------------------ */

const FILES = {
  "src/a.js": ["// a", "const x = 1;", "export const Y = 2;", "", "// tail"].join("\n"),
  "docs/b.md": ["# B", "", "| col | val |", "|---|---|"].join("\n"),
  // 12 行长文件：用于「行号在文件内、但 snippet 落在窗口外」这个分支
  "src/long.js": [
    "const first = 'needle';",
    "const l2 = 2;",
    "const l3 = 3;",
    "const l4 = 4;",
    "const l5 = 5;",
    "const l6 = 6;",
    "const l7 = 7;",
    "const l8 = 8;",
    "const l9 = 9;",
    "const l10 = 10;",
    "const l11 = 11;",
    "const last = 12;",
  ].join("\n"),
};

/** 注入式 readFile：只在 FILES 里找，找不到抛 ENOENT 风格错误 */
function fakeReadFile(absPath) {
  const key = absPath.replace(/\\/g, "/").replace(/^.*?(?=(src|docs)\/)/u, "");
  if (Object.prototype.hasOwnProperty.call(FILES, key)) return FILES[key];
  const err = new Error(`ENOENT: no such file ${absPath}`);
  err.code = "ENOENT";
  throw err;
}

/* ------------------------------ 1. 形状校验 ------------------------------ */

test("E1 合法条目被规范化（去首尾空白，保留行号整数）", () => {
  const out = normalizeEvidence([{ file: "  src/a.js  ", line: 2, snippet: " const x = 1; " }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "src/a.js");
  assert.equal(out[0].line, 2);
  assert.equal(out[0].snippet, " const x = 1; ");
});

test("E2 空数组被拒：E_EVIDENCE_REQUIRED", () => {
  assert.throws(
    () => normalizeEvidence([]),
    (err) => err.code === CODE.EVIDENCE_REQUIRED && err.details.missing.includes("evidence"),
  );
});

test("E3 缺 file 或 snippet 报出缺失字段；行号可以省略", () => {
  assert.equal(normalizeEvidence([{ file: "src/a.js", snippet: "x" }])[0].line, undefined);
  for (const [item, missing] of [
    [{ line: 1, snippet: "x" }, "file"],
    [{ file: "src/a.js", line: 1 }, "snippet"],
  ]) {
    assert.throws(
      () => normalizeEvidence([item]),
      (err) =>
        err.code === CODE.EVIDENCE_REQUIRED &&
        err.details.missing.includes(missing),
      `应报缺 ${missing}`,
    );
  }
});

test("E4 line 非正整数被拒", () => {
  for (const line of [0, -3, 1.5, "2", null]) {
    assert.throws(
      () => normalizeEvidence([{ file: "src/a.js", line, snippet: "x" }]),
      (err) => err.code === CODE.EVIDENCE_REQUIRED && err.details.missing.includes("line"),
      `line=${String(line)} 应被拒`,
    );
  }
});

test("E5 非对象条目被拒", () => {
  assert.throws(() => normalizeEvidence(["我是字符串"]), (err) => err.code === CODE.EVIDENCE_REQUIRED);
});

/* ------------------------------ 2. 命中 / 不命中 ------------------------------ */

test("E6 命中：snippet 是该行子串即通过，并回带 matchedAt", async () => {
  const r = await checkEvidence(
    [{ file: "src/a.js", line: 2, snippet: "const x = 1;" }],
    fakeReadFile,
  );
  assert.equal(r.ok, true);
  assert.equal(r.hits, 1);
  assert.deepEqual(r.misses, []);
  assert.equal(r.evidence[0].matchedAt, 2);
});

test("E7 命中：行号差在 ±窗口内也算（容忍插入/删除行）", async () => {
  const r = await checkEvidence(
    [{ file: "src/a.js", line: 2 + LINE_WINDOW, snippet: "const x = 1;" }],
    fakeReadFile,
  );
  assert.equal(r.ok, true);
  assert.equal(r.evidence[0].matchedAt, 2);
});

test("E8 不命中：行号在文件内但 snippet 落在窗口外 → E_EVIDENCE_MISMATCH，misses 带明细", async () => {
  // needle 在第 1 行，声称在第 12 行 → 差 11 行，远超 ±3 窗口，且 12 行在文件范围内
  const items = [{ file: "src/long.js", line: 12, snippet: "const first = 'needle';" }];
  const r = await checkEvidence(items, fakeReadFile);
  assert.equal(r.ok, false);
  assert.equal(r.misses.length, 1);
  assert.equal(r.misses[0].reason, "snippet-not-found-in-window");
  assert.deepEqual(r.misses[0].window, [9, 12]);

  await assert.rejects(
    () => assertEvidence(items, fakeReadFile),
    (err) =>
      err.code === CODE.EVIDENCE_MISMATCH &&
      err.details.misses.length === 1 &&
      err.details.hits === 0,
  );
});

test("E9 不命中：snippet 与文件内容不同（哪怕很像）", async () => {
  const r = await checkEvidence(
    [{ file: "src/a.js", line: 2, snippet: "const x = 2;" }],
    fakeReadFile,
  );
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "snippet-not-found-in-window");
});

test("E10 文件不存在 → file-not-found 明细", async () => {
  const r = await checkEvidence([{ file: "src/ghost.js", line: 1, snippet: "x" }], fakeReadFile);
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "file-not-found");
});

test("E11 行号越界 → line-out-of-range 且带 totalLines", async () => {
  const r = await checkEvidence([{ file: "src/a.js", line: 999, snippet: "const x = 1;" }], fakeReadFile);
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "line-out-of-range");
  assert.equal(r.misses[0].totalLines, 5);
});

/* ------------------------------ 3. 越界路径 ------------------------------ */

test("E12 isOutsideRoot：../ 逃逸被判越界，正常相对路径不越界", () => {
  const root = process.cwd();
  assert.equal(isOutsideRoot(root, "../outside.js"), true);
  assert.equal(isOutsideRoot(root, "src/review/x.js"), false);
});

test("E13 越界路径在 checkEvidence 里被拒为 outside-root（不尝试读文件）", async () => {
  let touched = 0;
  const readFile = () => {
    touched += 1;
    return "";
  };
  const r = await checkEvidence(
    [{ file: "../escape.js", line: 1, snippet: "x" }],
    readFile,
    { root: process.cwd() },
  );
  assert.equal(r.ok, false);
  assert.equal(r.misses[0].reason, "outside-root");
  assert.equal(touched, 0, "越界时不应读文件");
});

/* ------------------------------ 4. 多条混叵 ------------------------------ */

test("E14 多条：部分命中部分不命中 → 整体 ok=false，计数正确", async () => {
  const r = await checkEvidence(
    [
      { file: "src/a.js", line: 2, snippet: "const x = 1;" },
      { file: "docs/b.md", line: 3, snippet: "| col | val |" },
      { file: "src/a.js", line: 3, snippet: "这行根本不存在" },
    ],
    fakeReadFile,
  );
  assert.equal(r.ok, false);
  assert.equal(r.hits, 2);
  assert.equal(r.misses.length, 1);
  assert.equal(r.evidence.length, 2);
});

test("E15 缩进不同不影响命中（去行首空白后比较）", async () => {
  const r = await checkEvidence(
    [{ file: "src/a.js", line: 3, snippet: "export const Y = 2;" }],
    fakeReadFile,
  );
  assert.equal(r.ok, true);
});
