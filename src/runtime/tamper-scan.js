/**
 * v0.5 · 离线零依赖测试防作弊静态扫描器（checkwash / proof-of-done / TRACE 启发）
 *
 * 设计原则（对齐三方审计与 CHI/UIST 90%–93% 审批疲劳实证）：
 *   1. 毫秒级纯 JS 扫描（<5ms），零 LLM 消耗、零外部依赖；
 *   2. 严格区分「极高置信作弊（blocks，硬拦）」与「可疑弱化信号（warnings，仅作证据提示）」，
 *      避免误杀合法的重构改测试而导致用户习惯性忽略；
 *   3. 尊重阶段可选声明 `testChangePolicy`（none | add | update | remove）：
 *      明确声明要删/改旧测试时，不把合法变更误报为作弊。
 */

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php)$/iu;
const TEST_PATH_RE = /(?:^|\/)(?:__tests__|tests?|spec|specs)\/|(?:^|\/)test_[^/]+\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|Tests?\.(?:cs|java|kt)$/iu;

const ONLY_RE = /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/u;
const EXIT_ZERO_RE = /\b(?:process\.exit|sys\.exit|os\._exit)\s*\(\s*0\s*\)|\bprocess\.exitCode\s*=\s*0\b/u;
const SKIP_RE = /\b(?:it|test|describe|context|suite)\.skip\s*\(|\b(?:xit|xdescribe)\s*\(|@(?:pytest\.mark\.)?skip(?:if)?\b|@unittest\.skip|\bt\.Skip\s*\(|#\[\s*ignore\b/u;
const LINT_BYPASS_RE = /(?:eslint-disable(?:-next-line|-line)?|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa\b|#\[\s*allow\(\s*warnings\s*\)\])/u;
const STRICT_ASSERT_RE = /\bexpect\s*\(.+\)\s*\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toThrow|toHaveBeenCalledWith)\s*\(|\bassert\.(?:strictEqual|deepStrictEqual|deepEqual|equal|throws|rejects|match)\s*\(|^\s*assert\s+.+\s*(?:==|!=|<=|>=|<|>|\bin\b)|\bassert_eq!\s*\(|\bt\.(?:Error|Fatal)f?\s*\(/u;
const WEAK_ASSERT_RE = /\bexpect\s*\(.+\)\s*\.(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(\s*\)|\bexpect\s*\(\s*true\s*\)\s*\.(?:toBe|toEqual)\s*\(\s*true\s*\)|^\s*assert\s+(?:True|1)\s*(?:#.*)?$|\bassert!\s*\(\s*true\s*\)/u;
const BROAD_SWALLOW_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except(?:\s+Exception)?\s*:\s*pass\b/u;

export const VALID_TEST_CHANGE_POLICIES = Object.freeze(["none", "add", "update", "remove"]);

export function isTestFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const norm = filePath.replace(/\\/gu, "/");
  // P1 修复：必须为代码文件扩展名，避免误把 spec/openapi.yaml 或 specs/design.md 判成测试文件
  if (!CODE_EXT_RE.test(norm)) return false;
  return TEST_PATH_RE.test(norm);
}

/** 将 unified diff 按文件拆分为 { file, hunks: [{ startNew, removed: [], added: [] }] }。 */
function parseUnifiedDiffByFile(unifiedDiff) {
  if (typeof unifiedDiff !== "string" || !unifiedDiff.trim()) return [];
  const sections = unifiedDiff.split(/(?=^diff --git )/mu).filter((s) => s.trim());
  const parsed = [];
  for (const sec of sections) {
    const lines = sec.split(/\r?\n/u);
    let file = null;
    let isDeleted = false;
    for (const line of lines.slice(0, 6)) {
      if (line.startsWith("+++ b/")) file = line.slice(6).trim();
      else if (line === "+++ /dev/null") isDeleted = true;
      else if (!file && line.startsWith("--- a/")) file = line.slice(6).trim();
      else if (!file && line.startsWith("diff --git a/")) {
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/u);
        if (m) file = m[2];
      }
    }
    if (!file) continue;
    const hunks = [];
    let current = null;
    let newLineNo = 0;
    for (const line of lines) {
      if (line.startsWith("@@ ")) {
        const m = line.match(/\+(\d+)/u);
        newLineNo = m ? Number.parseInt(m[1], 10) : 1;
        current = { removed: [], added: [] };
        hunks.push(current);
        continue;
      }
      if (!current) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.added.push({ line: newLineNo, text: line.slice(1) });
        newLineNo += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.removed.push({ text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        newLineNo += 1;
      }
    }
    parsed.push({ file: file.replace(/\\/gu, "/"), isDeleted, hunks });
  }
  return parsed;
}

/**
 * 扫描阶段真实 Diff 的测试完整性与防作弊信号。
 *
 * @param {object} opts
 * @param {string} opts.unifiedDiff
 * @param {Array<{path:string,status:string}>} [opts.changedFiles]
 * @param {string} [opts.testChangePolicy]  none | add | update | remove
 * @param {(relPath:string)=>string|null} [opts.readCurrentFile]  可选，用于核对测试文件剩余断言数
 */
export function scanDiffForTampering({
  unifiedDiff = "",
  changedFiles = [],
  testChangePolicy = "none",
  readCurrentFile = null,
} = {}) {
  const policy = VALID_TEST_CHANGE_POLICIES.includes(testChangePolicy) ? testChangePolicy : "none";
  const blocks = [];
  const warnings = [];
  const files = parseUnifiedDiffByFile(unifiedDiff);

  // 1) 整文件删除测试检查（结合 changedFiles 兜底，即使 unifiedDiff 被截断也能抓住）
  const deletedFiles = new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .filter((f) => f && f.status === "deleted" && isTestFilePath(f.path))
      .map((f) => f.path.replace(/\\/gu, "/")),
  );
  for (const f of files) {
    if (f.isDeleted && isTestFilePath(f.file)) deletedFiles.add(f.file);
  }
  for (const file of deletedFiles) {
    if (policy === "remove") {
      warnings.push({
        rule: "TEST_FILE_DELETED_DECLARED",
        severity: "warning",
        file,
        line: null,
        summary: "测试文件被整文件删除（已按 testChangePolicy=remove 放行，仍请审查核实）",
      });
    } else {
      blocks.push({
        rule: "TEST_FILE_DELETED",
        severity: "block",
        file,
        line: null,
        summary: "未声明 testChangePolicy=remove 却删除了整个测试文件",
      });
    }
  }

  // 2) 逐文件逐 Hunk 非对称检测
  for (const entry of files) {
    if (entry.isDeleted) continue;
    const isTest = isTestFilePath(entry.file);
    let fileRemovedStrict = 0;
    let fileAddedStrict = 0;

    for (const hunk of entry.hunks) {
      let hunkRemovedStrict = 0;
      let hunkAddedWeak = 0;
      let firstWeakLine = null;

      for (const rem of hunk.removed) {
        if (isTest && STRICT_ASSERT_RE.test(rem.text)) {
          hunkRemovedStrict += 1;
          fileRemovedStrict += 1;
        }
      }

      for (const add of hunk.added) {
        const txt = add.text;
        if (isTest) {
          if (ONLY_RE.test(txt)) {
            blocks.push({
              rule: "TEST_ONLY_ADDED",
              severity: "block",
              file: entry.file,
              line: add.line,
              summary: "测试文件新增 .only / fit / fdescribe（会跳过其余测试套）",
            });
          }
          if (EXIT_ZERO_RE.test(txt)) {
            blocks.push({
              rule: "TEST_EXIT_ZERO_ADDED",
              severity: "block",
              file: entry.file,
              line: add.line,
              summary: "测试文件新增强制退出码 0（process.exit(0) / sys.exit(0)）",
            });
          }
          if (SKIP_RE.test(txt)) {
            warnings.push({
              rule: "TEST_SKIP_ADDED",
              severity: "warning",
              file: entry.file,
              line: add.line,
              summary: "测试文件新增跳过标记（.skip / xfail / #[ignore] / t.Skip）",
            });
          }
          if (STRICT_ASSERT_RE.test(txt)) {
            fileAddedStrict += 1;
          }
          if (WEAK_ASSERT_RE.test(txt)) {
            hunkAddedWeak += 1;
            if (firstWeakLine === null) firstWeakLine = add.line;
          }
          if (BROAD_SWALLOW_RE.test(txt)) {
            warnings.push({
              rule: "BROAD_CATCH_SWALLOW",
              severity: "warning",
              file: entry.file,
              line: add.line,
              summary: "测试文件新增空异常捕获（可能静默吞掉失败）",
            });
          }
        }
        if (LINT_BYPASS_RE.test(txt)) {
          warnings.push({
            rule: "LINT_SUPPRESSION_ADDED",
            severity: "warning",
            file: entry.file,
            line: add.line,
            summary: "新增静态检查绕过标记（eslint-disable / @ts-ignore / noqa 等）",
          });
        }
      }

      // Diff 非对称特征：同一 hunk 内删除严格断言 + 新增弱断言/永真断言
      if (isTest && hunkRemovedStrict > 0 && hunkAddedWeak > 0) {
        warnings.push({
          rule: "ASSERT_WEAKENED",
          severity: "warning",
          file: entry.file,
          line: firstWeakLine,
          summary: `同一变更块内删除了 ${hunkRemovedStrict} 处严格断言并替换为宽松/永真断言`,
        });
      }
    }

    // 3) 整文件断言被清空检测（删除了断言且未新增任何严格断言，且当前文件剩余 0 条严格断言）
    if (isTest && fileRemovedStrict > 0 && fileAddedStrict === 0 && typeof readCurrentFile === "function") {
      try {
        const content = readCurrentFile(entry.file);
        if (typeof content === "string") {
          const remaining = content.split(/\r?\n/u).filter((l) => STRICT_ASSERT_RE.test(l)).length;
          if (remaining === 0) {
            if (policy === "remove") {
              warnings.push({
                rule: "TEST_ASSERTIONS_WIPED_DECLARED",
                severity: "warning",
                file: entry.file,
                line: null,
                summary: "测试文件严格断言已归零（已按 testChangePolicy=remove 放行）",
              });
            } else {
              blocks.push({
                rule: "TEST_ASSERTIONS_WIPED",
                severity: "block",
                file: entry.file,
                line: null,
                summary: `测试文件删除了 ${fileRemovedStrict} 处断言后剩余有效断言归零`,
              });
            }
          }
        }
      } catch {
        /* ignore unreadable */
      }
    }
  }

  return {
    ok: blocks.length === 0,
    policy,
    blocks: blocks.slice(0, 20),
    warnings: warnings.slice(0, 20),
    scannedFiles: files.length,
  };
}
