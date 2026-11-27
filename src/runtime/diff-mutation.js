/**
 * 可选 Diff 范围增量变异测试引擎（Strict 墙内，v1.0）。
 *
 * 借鉴 Meta ACH (arXiv:2501.12862) 与 IBM Research Verified-but-Vacuous (Nov 2026)：
 *   - 专门击杀“覆盖率高但零断言力”的空洞测试（exit 0 但没真验证逻辑）；
 *   - **只针对本次 unifiedDiff 新增/改动行（`+` 行）的非测试代码生成极少量高信号定向变异体**
 *     （默认上限 8 个，单变异超时 <=10s），绝不对全仓跑分钟级变异；
 *   - **严禁原地改写用户工作区**：所有变异体都在 `os.tmpdir()` 隔离影子目录执行，
 *     测试命令经安全 `execFile` + 清洗环境变量运行，执行完毕无论成败一律彻底清理影子目录。
 *
 * 零外部依赖；默认关闭（仅在 `enableDiffMutation: true` 或人工 `/mentor mutate` 显式调用时运行）。
 */

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, lstat, realpath, copyFile, symlink } from "node:fs/promises";

import { isTestFilePath } from "./tamper-scan.js";
import { isSensitivePath } from "../review/evidence-reader.js";
import { rollbackToSnapshot } from "./workspace-diff.js";

const CODE_EXT_RE = /\.(?:js|mjs|cjs|ts|mts|cts)$/iu;
const SKIP_DIRS = new Set([".git", "node_modules", ".dsh", ".cache", "dist", "build", "coverage", ".next", ".turbo"]);
const MAX_HARD_MUTANTS = 16;
const DEFAULT_MAX_MUTANTS = 8;
const DEFAULT_MUTANT_TIMEOUT_MS = 10_000;
const MAX_SHADOW_FILES = 600;
const MAX_SHADOW_FILE_BYTES = 512 * 1024;

const MUTATION_OPERATORS = [
  {
    id: "STRICT_EQ_FLIP",
    match: /(===|!==)/u,
    mutate: (line) => {
      if (line.includes("===")) return line.replace("===", "!==");
      if (line.includes("!==")) return line.replace("!==", "===");
      return null;
    },
  },
  {
    id: "RELATIONAL_FLIP",
    match: /(?:>=|<=|(?<![=!<>])>(?![>=])|(?<![=!<>])<(?![<=]))/u,
    mutate: (line) => {
      if (line.includes(">=")) return line.replace(">=", ">");
      if (line.includes("<=")) return line.replace("<=", "<");
      // 避开箭头函数 => 与 JSX 标签
      const gt = /(?<![=!<>-])>(?![>=])/u;
      if (gt.test(line) && !/=>/u.test(line)) return line.replace(gt, ">=");
      const lt = /(?<![=!<>])<(?![<=a-zA-Z/])/u;
      if (lt.test(line)) return line.replace(lt, "<=");
      return null;
    },
  },
  {
    id: "BOOLEAN_LOGIC_FLIP",
    match: /(&&|\|\|)/u,
    mutate: (line) => {
      if (line.includes("&&")) return line.replace("&&", "||");
      if (line.includes("||")) return line.replace("||", "&&");
      return null;
    },
  },
  {
    id: "BOOLEAN_LITERAL_FLIP",
    match: /\b(?:true|false)\b/u,
    mutate: (line) => {
      if (/\btrue\b/u.test(line)) return line.replace(/\btrue\b/u, "false");
      if (/\bfalse\b/u.test(line)) return line.replace(/\bfalse\b/u, "true");
      return null;
    },
  },
  {
    id: "GUARD_NEGATE",
    match: /^\s*if\s*\(([^()]{1,80})\)/u,
    mutate: (line) => line.replace(/^(\s*if\s*\()([^()]{1,80})(\))/u, "$1!($2)$3"),
  },
  {
    id: "ARITHMETIC_STEP",
    match: /(?:\+\s*1\b|-\s*1\b)/u,
    mutate: (line) => {
      if (/\+\s*1\b/u.test(line)) return line.replace(/\+\s*1\b/u, "- 1");
      if (/-\s*1\b/u.test(line)) return line.replace(/-\s*1\b/u, "+ 1");
      return null;
    },
  },
];

function isCommentOrImportLine(line) {
  const t = String(line ?? "").trim();
  return !t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") ||
    t.startsWith("import ") || t.startsWith("export {") || t.startsWith("export type ");
}

function hasSkippedSegment(relPath) {
  return String(relPath ?? "").replace(/\\/gu, "/").split("/").some((seg) => SKIP_DIRS.has(seg) || seg === "..");
}

/**
 * 从 unified diff 解析出所有非测试代码文件的新增/改动行（1-based 行号）。
 */
export function extractDiffAddedLines(unifiedDiff) {
  const results = [];
  if (typeof unifiedDiff !== "string" || !unifiedDiff.trim()) return results;
  let currentFile = null;
  let newLine = 0;

  for (const rawLine of unifiedDiff.split(/\r?\n/u)) {
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (target === "/dev/null") {
        currentFile = null;
      } else {
        const norm = target.replace(/^b\//u, "").replace(/\\/gu, "/");
        currentFile = hasSkippedSegment(norm) || path.isAbsolute(norm) ? null : norm;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(rawLine);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      if (CODE_EXT_RE.test(currentFile) && !isTestFilePath(currentFile) && !isSensitivePath(currentFile)) {
        results.push({ file: currentFile, line: newLine, text: rawLine.slice(1) });
      }
      newLine += 1;
    } else if (rawLine.startsWith(" ")) {
      newLine += 1;
    }
  }
  return results;
}

/**
 * 只对本次 diff 改动到的代码行生成定向高信号变异体（上限 maxMutants）。
 */
export function generateDiffMutants({
  unifiedDiff,
  maxMutants = DEFAULT_MAX_MUTANTS,
} = {}) {
  const cap = Number.isInteger(maxMutants) && maxMutants > 0 ? Math.min(maxMutants, MAX_HARD_MUTANTS) : DEFAULT_MAX_MUTANTS;
  const addedLines = extractDiffAddedLines(unifiedDiff);
  const mutants = [];

  for (const entry of addedLines) {
    if (mutants.length >= cap) break;
    if (isCommentOrImportLine(entry.text)) continue;
    for (const op of MUTATION_OPERATORS) {
      if (mutants.length >= cap) break;
      if (!op.match.test(entry.text)) continue;
      const mutated = op.mutate(entry.text);
      if (!mutated || mutated === entry.text) continue;
      mutants.push({
        id: `mut-${mutants.length + 1}`,
        operator: op.id,
        file: entry.file,
        line: entry.line,
        original: entry.text.trim().slice(0, 140),
        mutated: mutated.trim().slice(0, 140),
        rawOriginal: entry.text,
        rawMutated: mutated,
      });
      break; // 每改动行最多 1 个变异体，优先扩大覆盖行面
    }
  }
  return mutants;
}

const ALLOWED_MUTATION_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "TZ", "NODE_ENV",
]);

/** 严格白名单环境：绝不把宿主 API Key / Token 暴露给变异测试子进程。 */
function scrubbedMutationEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED_MUTATION_ENV_KEYS.has(k.toUpperCase())) {
      env[k] = v;
    }
  }
  if (process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function runDirectExec(cwd, spec, timeoutMs) {
  const file = spec.file === "node" ? process.execPath : spec.file;
  const args = Array.isArray(spec.args) ? spec.args : [];
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: scrubbedMutationEnv(),
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
      resolve({
        ok: !error,
        timedOut,
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        durationMs: Date.now() - t0,
        tail: String(stderr || stdout || "").slice(-300),
      });
    });
  });
}

async function copyWorkspaceToShadow(srcRoot, dstRoot) {
  let count = 0;
  async function walk(curSrc, curDst, relPrefix) {
    if (count >= MAX_SHADOW_FILES) return;
    const entries = await readdir(curSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= MAX_SHADOW_FILES) break;
      if (SKIP_DIRS.has(entry.name)) {
        // 如存在 node_modules，以只读联接/符号链接方式复用依赖，绝不复制海量依赖包
        if (entry.name === "node_modules" && !relPrefix) {
          try {
            await symlink(
              path.join(curSrc, entry.name),
              path.join(curDst, entry.name),
              process.platform === "win32" ? "junction" : "dir",
            );
          } catch {}
        }
        continue;
      }
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (isSensitivePath(rel)) continue;
      const srcPath = path.join(curSrc, entry.name);
      const dstPath = path.join(curDst, entry.name);
      let st;
      try { st = await lstat(srcPath); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await mkdir(dstPath, { recursive: true });
        await walk(srcPath, dstPath, rel);
      } else if (st.isFile() && st.size <= MAX_SHADOW_FILE_BYTES) {
        count += 1;
        await copyFile(srcPath, dstPath);
      }
    }
  }
  await walk(srcRoot, dstRoot, "");
  return count;
}

async function resolveSafeShadowFile(shadowReal, relPath) {
  if (!relPath || hasSkippedSegment(relPath) || path.isAbsolute(relPath) || (process.platform === "win32" && relPath.includes(":"))) {
    return null;
  }
  const candidate = path.resolve(shadowReal, relPath);
  const relCheck = path.relative(shadowReal, candidate);
  if (!relCheck || relCheck === ".." || relCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relCheck)) {
    return null;
  }
  // 逐级 lstat 校验，绝不穿过 node_modules 联接点或任何符号链接改写外部文件
  let cur = shadowReal;
  for (const seg of relCheck.replace(/\\/gu, "/").split("/").filter(Boolean)) {
    cur = path.join(cur, seg);
    let st;
    try { st = await lstat(cur); } catch { return null; }
    if (st.isSymbolicLink()) return null;
  }
  try {
    const fileReal = await realpath(candidate);
    const realRel = path.relative(shadowReal, fileReal);
    if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    return fileReal;
  } catch {
    return null;
  }
}

async function ensureDiffTargetsCopied(srcRoot, dstRoot, mutants) {
  const srcReal = await realpath(srcRoot);
  const uniqueFiles = [...new Set(mutants.map((m) => m.file).filter(Boolean))];
  for (const rel of uniqueFiles) {
    if (hasSkippedSegment(rel) || isSensitivePath(rel) || path.isAbsolute(rel)) continue;
    const srcAbs = path.resolve(srcReal, rel);
    const relCheck = path.relative(srcReal, srcAbs);
    if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;
    try {
      const st = await lstat(srcAbs);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SHADOW_FILE_BYTES) continue;
      const dstAbs = path.resolve(dstRoot, rel);
      await mkdir(path.dirname(dstAbs), { recursive: true });
      await copyFile(srcAbs, dstAbs);
    } catch {}
  }
}

/**
 * 在隔离影子目录运行 Diff 范围增量变异测试（绝不修改真实工作区）。
 *
 * @param {{
 *   workspaceRoot: string,
 *   unifiedDiff: string,
 *   testSpec: { file: string, args: string[] } | null,
 *   maxMutants?: number,
 *   timeoutMs?: number,
 *   runner?: (cwd: string, testSpec: object) => Promise<{ ok: boolean, timedOut?: boolean }>,
 * }} params
 */
export async function runDiffScopedMutationTest({
  workspaceRoot,
  unifiedDiff,
  testSpec = null,
  maxMutants = DEFAULT_MAX_MUTANTS,
  timeoutMs = DEFAULT_MUTANT_TIMEOUT_MS,
  runner = null,
} = {}) {
  if (!workspaceRoot) {
    return { ok: false, reason: "workspace-root-missing", message: "缺少工作区路径" };
  }
  if (!runner && (!testSpec || typeof testSpec.file !== "string" || !testSpec.file.trim())) {
    return {
      ok: false,
      reason: "test-command-missing",
      message: "未指定可执行测试命令（格式：{ file, args }），跳过变异测试",
    };
  }

  const mutants = generateDiffMutants({ unifiedDiff, maxMutants });
  if (mutants.length === 0) {
    return {
      ok: true,
      total: 0,
      killed: 0,
      survived: 0,
      timedOut: 0,
      mutationScore: 1,
      mutants: [],
      survivors: [],
      message: "本次 Diff 改动行没有可变异的非测试代码逻辑。",
    };
  }

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 500
    ? Math.min(timeoutMs, 15_000) : DEFAULT_MUTANT_TIMEOUT_MS;
  const execTest = runner
    ? (cwd) => runner(cwd, testSpec)
    : (cwd) => runDirectExec(cwd, testSpec, effectiveTimeout);

  const shadowDir = await mkdtemp(path.join(os.tmpdir(), "mentor-mut-"));
  const shadowReal = await realpath(shadowDir);
  const t0 = Date.now();
  try {
    await copyWorkspaceToShadow(workspaceRoot, shadowReal);
    await ensureDiffTargetsCopied(workspaceRoot, shadowReal, mutants);

    // 1. 基线测试必须先通过，否则不误把基线失败算成 killed
    const baselineRes = await execTest(shadowReal);
    if (!baselineRes?.ok) {
      return {
        ok: false,
        reason: "baseline-test-failed",
        message: "基线测试在影子目录未通过，无法执行变异评分",
        baselineDetail: baselineRes?.tail ?? null,
      };
    }

    const results = [];
    let killed = 0;
    let survived = 0;
    let timedOut = 0;

    for (const mut of mutants) {
      const targetFile = await resolveSafeShadowFile(shadowReal, mut.file);
      if (!targetFile) {
        results.push({ ...mut, status: "skipped", reason: "unsafe-path" });
        continue;
      }
      let origContent;
      try {
        origContent = await readFile(targetFile, "utf8");
      } catch {
        results.push({ ...mut, status: "skipped", reason: "file-not-in-shadow" });
        continue;
      }
      const lines = origContent.split(/\r?\n/u);
      const idx = mut.line - 1;
      if (idx < 0 || idx >= lines.length || lines[idx] !== mut.rawOriginal) {
        const fallbackIdx = lines.findIndex((l) => l === mut.rawOriginal);
        if (fallbackIdx < 0) {
          results.push({ ...mut, status: "skipped", reason: "line-mismatch" });
          continue;
        }
        lines[fallbackIdx] = mut.rawMutated;
      } else {
        lines[idx] = mut.rawMutated;
      }

      try {
        await writeFile(targetFile, lines.join("\n"), "utf8");
        const runRes = await execTest(shadowReal);
        let status;
        if (runRes?.timedOut) {
          status = "timeout";
          timedOut += 1;
        } else if (runRes?.ok) {
          status = "survived";
          survived += 1;
        } else {
          status = "killed";
          killed += 1;
        }
        results.push({
          id: mut.id,
          operator: mut.operator,
          file: mut.file,
          line: mut.line,
          original: mut.original,
          mutated: mut.mutated,
          status,
        });
      } finally {
        await writeFile(targetFile, origContent, "utf8");
      }
    }

    const evaluated = killed + survived + timedOut;
    if (evaluated === 0) {
      return {
        ok: false,
        reason: "no-mutants-evaluated",
        total: 0,
        killed: 0,
        survived: 0,
        timedOut: 0,
        mutationScore: null,
        durationMs: Date.now() - t0,
        mutants: results,
        survivors: [],
        message: "生成了变异体但全部因路径安全或行不匹配被跳过，未得出有效变异得分。",
      };
    }
    const mutationScore = (killed + timedOut) / evaluated;
    const survivors = results.filter((r) => r.status === "survived");

    return {
      ok: true,
      total: evaluated,
      killed,
      survived,
      timedOut,
      mutationScore,
      durationMs: Date.now() - t0,
      mutants: results,
      survivors,
      summary: evaluated === 0
        ? "未执行有效变异体。"
        : survivors.length === 0
          ? `Diff 变异测试全杀（${killed}/${evaluated} killed，得分 ${Math.round(mutationScore * 100)}%）。`
          : `⚠ 发现 ${survivors.length}/${evaluated} 个变异体存活（得分 ${Math.round(mutationScore * 100)}%），对应改动行可能存在断言空洞！`,
    };
  } finally {
    await rm(shadowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
}

/**
 * Fail-to-Pass (F2P) 空洞新测试验证（IBM Research Verified-but-Vacuous, Nov 2026 + prove_it）：
 *   1. 在隔离影子目录中先运行当前测试（必须 PASS）；
 *   2. 仅把「非测试生产代码」回滚回阶段基线快照，保留本次新增/改动的测试文件；
 *   3. 再次运行测试：
 *      - 若在旧基线代码上 FAIL → `verified-f2p`（数学证明新测试真正复现了旧缺陷/新行为！）
 *      - 若在旧基线代码上依然 PASS → `vacuous-pass-on-baseline`（揪出没有真正测到改动的空洞测试！）
 *
 * 全程只在隔离影子目录操作，绝不触碰真实工作区。
 */
export async function verifyFailToPass({
  workspaceRoot,
  baselineSnapshot,
  stateDir = "",
  taskId = "default",
  changedFiles = [],
  testSpec = null,
  timeoutMs = DEFAULT_MUTANT_TIMEOUT_MS,
  runner = null,
} = {}) {
  if (!workspaceRoot || !baselineSnapshot?.ok) {
    return { ok: false, reason: "baseline-missing", message: "缺少工作区或基线快照，无法执行 Fail-to-Pass 验证" };
  }
  if (!runner && (!testSpec || typeof testSpec.file !== "string" || !testSpec.file.trim())) {
    return { ok: false, reason: "test-command-missing", message: "未指定可执行测试命令，跳过 F2P 验证" };
  }
  const files = Array.isArray(changedFiles) ? changedFiles.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean) : [];
  const touchedTestFiles = files.filter((f) => isTestFilePath(f) && !hasSkippedSegment(f) && !isSensitivePath(f));
  const touchedProdFiles = files.filter((f) => !isTestFilePath(f) && !hasSkippedSegment(f) && !isSensitivePath(f));
  if (touchedTestFiles.length === 0 || touchedProdFiles.length === 0) {
    return {
      ok: true,
      status: "not-applicable",
      message: "本次变更未同时包含生产代码与测试文件改动，跳过 Fail-to-Pass 验证。",
    };
  }

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 500
    ? Math.min(timeoutMs, 15_000) : DEFAULT_MUTANT_TIMEOUT_MS;
  const execTest = runner
    ? (cwd) => runner(cwd, testSpec)
    : (cwd) => runDirectExec(cwd, testSpec, effectiveTimeout);

  const shadowDir = await mkdtemp(path.join(os.tmpdir(), "mentor-f2p-"));
  const shadowReal = await realpath(shadowDir);
  try {
    await copyWorkspaceToShadow(workspaceRoot, shadowReal);
    // 1) 当前代码 + 新测试必须先 PASS
    const afterRes = await execTest(shadowReal);
    if (!afterRes?.ok) {
      return {
        ok: false,
        status: "current-test-failed",
        message: "当前代码在影子目录未通过测试，无法进行 Fail-to-Pass 基线对照。",
      };
    }

    // 2) 备份影子目录中的新测试文件 → 将影子目录恢复到基线快照（兼容 Git 与非 Git）→ 写回新测试文件
    const savedTests = new Map();
    for (const rel of touchedTestFiles) {
      const safe = await resolveSafeShadowFile(shadowReal, rel);
      if (safe) {
        try { savedTests.set(rel, await readFile(safe)); } catch {}
      }
    }

    if (baselineSnapshot.mode === "git" && baselineSnapshot.repoRoot && baselineSnapshot.treeSha) {
      const relSubdir = baselineSnapshot.relSubdir || "";
      for (const rel of touchedProdFiles) {
        const dst = path.resolve(shadowReal, rel);
        const relCheck = path.relative(shadowReal, dst);
        if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;
        const gitRel = relSubdir ? `${relSubdir}/${rel}` : rel;
        const bytes = await new Promise((resolve) => {
          execFile("git", ["cat-file", "-p", `${baselineSnapshot.treeSha}:${gitRel}`], {
            cwd: baselineSnapshot.repoRoot,
            encoding: "buffer",
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
          }, (err, out) => resolve(err ? null : out));
        });
        if (bytes === null) {
          await rm(dst, { force: true }).catch(() => {});
        } else {
          await mkdir(path.dirname(dst), { recursive: true });
          await writeFile(dst, bytes);
        }
      }
    } else {
      const rb = await rollbackToSnapshot({
        workspaceRoot: shadowReal,
        stateDir,
        taskId,
        targetSnapshot: { ...baselineSnapshot, workspaceRoot: shadowReal },
        force: true,
      });
      if (!rb.ok) {
        return { ok: false, status: "baseline-restore-failed", reason: rb.reason, message: rb.message || "影子目录恢复基线失败" };
      }
    }

    for (const [rel, buf] of savedTests.entries()) {
      const dst = path.resolve(shadowReal, rel);
      const relCheck = path.relative(shadowReal, dst);
      if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, buf);
    }

    // 3) 在「旧基线代码 + 新测试」上跑测试：应该 FAIL 才算有效 F2P！
    const beforeRes = await execTest(shadowReal);
    const passedOnBaseline = Boolean(beforeRes?.ok);
    return {
      ok: true,
      status: passedOnBaseline ? "vacuous-pass-on-baseline" : "verified-f2p",
      verifiedF2P: !passedOnBaseline,
      vacuous: passedOnBaseline,
      touchedTestFiles,
      touchedProdFiles,
      summary: passedOnBaseline
        ? `⚠ 空洞测试告警（Verified-but-Vacuous）：新增/改动测试在未修复的旧基线代码上仍然 PASS（未真正复现本次改动）。`
        : `✓ Fail-to-Pass 核验通过：新测试在旧基线代码上按预期 FAIL、在新代码上 PASS。`,
    };
  } finally {
    await rm(shadowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
}
