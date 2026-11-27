/**
 * v0.3 · 前置确定性硬检查门禁（Deterministic Pre-Review Gate / Sensors First）
 *
 * 在 mentor_stage_report 启动独立 LLM 审查前，先按阶段声明或全局配置运行确定性命令
 * （语法检查、单测、lint 等）：
 *   · 任一项失败 → 直接拦截上报并把退出码与输出尾部回传给主会话自修，零消耗审查 LLM；
 *   · 全部通过 → 放行并把摘要附给独立审查员，让审查员专注逻辑、边界与需求覆盖。
 */

import { exec, execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ERR } from "../errors.js";

let cachedPwshAvailable = null;

/** 检测本机 PATH 上是否存在 PowerShell 7 (`pwsh`)，结果进程内缓存一次。 */
export function detectPwshOnPath() {
  if (cachedPwshAvailable !== null) return cachedPwshAvailable;
  if (process.platform !== "win32") {
    cachedPwshAvailable = false;
    return false;
  }
  try {
    const res = spawnSync("where", ["pwsh"], { windowsHide: true, stdio: "ignore", timeout: 3000 });
    cachedPwshAvailable = res?.status === 0;
  } catch {
    cachedPwshAvailable = false;
  }
  return cachedPwshAvailable;
}

const LEADING_PWSH_RE = /^(\s*)(?:"pwsh(?:\.exe)?"|pwsh(?:\.exe)?)(?=\s|$)/iu;

/**
 * Windows 兼容回退：DSH 的 Shell 工具名叫 `pwsh`，但本机可能只装了 Windows PowerShell 5.1 (`powershell.exe`)。
 * 若 precheck 以 `pwsh` 开头且 PATH 中不存在 `pwsh`，透明改写为 `powershell` 并附带显式 note。
 */
export function resolvePrecheckCommand(command, {
  platform = process.platform,
  hasPwsh = platform === "win32" ? detectPwshOnPath() : true,
} = {}) {
  const raw = String(command ?? "");
  if (platform === "win32" && !hasPwsh && LEADING_PWSH_RE.test(raw)) {
    const rewritten = raw.replace(LEADING_PWSH_RE, "$1powershell");
    return {
      command: rewritten,
      originalCommand: raw,
      fallbackFrom: "pwsh",
      note: "本机 PATH 未找到 pwsh (PowerShell 7)，已自动回退至 Windows PowerShell 5.1 (powershell)",
    };
  }
  return { command: raw, originalCommand: raw, fallbackFrom: null, note: null };
}

export const MAX_PRECHECKS_PER_STAGE = 8;
export const MAX_TOTAL_PRECHECKS = 16;
export const MAX_PRECHECK_COMMAND_LENGTH = 512;
export const DEFAULT_PRECHECK_TIMEOUT_MS = 30_000;
export const MIN_PRECHECK_TIMEOUT_MS = 1_000;
export const MAX_PRECHECK_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CAP = 1200;
const EXEC_MAX_BUFFER = 256 * 1024;

function clampTimeout(value, fallback = DEFAULT_PRECHECK_TIMEOUT_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_PRECHECK_TIMEOUT_MS, Math.min(MAX_PRECHECK_TIMEOUT_MS, Math.trunc(n)));
}

function tailText(value, cap = OUTPUT_TAIL_CAP) {
  const text = String(value ?? "").trim();
  if (text.length <= cap) return text;
  return "…(truncated)\n" + text.slice(-cap);
}

/**
 * 归一化单条前置检查声明。
 * 支持简写字符串 `"node --check lib/index.js"` 或对象 `{ id?, label?, command, cwd?, timeoutMs? }`。
 */
export function normalizePrecheck(spec, index = 0) {
  if (typeof spec === "string") {
    const command = spec.trim();
    if (!command || command.length > MAX_PRECHECK_COMMAND_LENGTH || command.includes("\0")) return null;
    return { id: `precheck_${index + 1}`, label: command.slice(0, 64), command, cwd: null, timeoutMs: null };
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const command = typeof spec.command === "string" ? spec.command.trim() : "";
  if (!command || command.length > MAX_PRECHECK_COMMAND_LENGTH || command.includes("\0")) return null;
  const id = typeof spec.id === "string" && spec.id.trim() ? spec.id.trim() : `precheck_${index + 1}`;
  const label = typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : command.slice(0, 64);
  const cwd = typeof spec.cwd === "string" && spec.cwd.trim() ? spec.cwd.trim() : null;
  if (cwd && cwd.includes("\0")) return null;
  const timeoutMs = spec.timeoutMs === undefined || spec.timeoutMs === null
    ? null
    : (Number.isFinite(Number(spec.timeoutMs)) && Number(spec.timeoutMs) >= MIN_PRECHECK_TIMEOUT_MS
        ? clampTimeout(spec.timeoutMs)
        : NaN);
  if (Number.isNaN(timeoutMs)) return null;
  return { id, label, command, cwd, timeoutMs };
}

/** 校验所有阶段的 prechecks 声明（由 validatePlan 调用，一次收齐全部错误）。 */
export function validateStagePrechecks(stages) {
  const errors = [];
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (!stage || stage.prechecks === undefined) continue;
    if (!Array.isArray(stage.prechecks)) {
      errors.push({
        code: ERR.EMPTY_PLAN,
        message: `stage ${stage.id} 的 prechecks 必须是数组`,
        details: { stageId: stage.id },
      });
      continue;
    }
    if (stage.prechecks.length > MAX_PRECHECKS_PER_STAGE) {
      errors.push({
        code: ERR.EMPTY_PLAN,
        message: `stage ${stage.id} 的 prechecks 最多允许 ${MAX_PRECHECKS_PER_STAGE} 条（当前 ${stage.prechecks.length} 条）`,
        details: { stageId: stage.id, max: MAX_PRECHECKS_PER_STAGE, got: stage.prechecks.length },
      });
    }
    stage.prechecks.forEach((item, index) => {
      if (!normalizePrecheck(item, index)) {
        errors.push({
          code: ERR.EMPTY_PLAN,
          message: `stage ${stage.id} 的第 ${index + 1} 条 precheck 无效（需非空 command 且 ≤${MAX_PRECHECK_COMMAND_LENGTH} 字符，timeoutMs ≥ ${MIN_PRECHECK_TIMEOUT_MS}）`,
          details: { stageId: stage.id, index },
        });
      }
    });
  }
  return errors;
}

/** 把可选子目录解析并限制在 workspaceRoot 内（词法 + realpath 双重校验，防止符号链接/联接点逃逸）。 */
export function resolvePrecheckCwd(workspaceRoot, subCwd) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    return { ok: false, error: "缺少 workspaceRoot，无法安全运行前置硬检查" };
  }
  const root = path.resolve(workspaceRoot);
  const target = subCwd ? path.resolve(root, subCwd) : root;
  const lexicalRel = path.relative(root, target);
  if (lexicalRel === ".." || lexicalRel.startsWith(".." + path.sep) || path.isAbsolute(lexicalRel) ||
      (process.platform === "win32" && lexicalRel.includes(":"))) {
    return { ok: false, error: `precheck cwd 越出 workspaceRoot：${subCwd}` };
  }
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch (err) {
    return { ok: false, error: `precheck cwd 不存在或无法解析真实路径：${subCwd || "."} (${err?.code ?? err?.message ?? err})` };
  }
  const realRel = path.relative(realRoot, realTarget);
  if (realRel === ".." || realRel.startsWith(".." + path.sep) || path.isAbsolute(realRel) ||
      (process.platform === "win32" && realRel.includes(":"))) {
    return { ok: false, error: `precheck cwd 真实路径越出 workspaceRoot：${subCwd}` };
  }
  return { ok: true, cwd: realTarget };
}

function defaultRunner({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    exec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM") && durationMs >= timeoutMs - 50);
      const exitCode = error
        ? (typeof error.code === "number" ? error.code : 1)
        : 0;
      resolve({
        ok: !error,
        exitCode,
        timedOut,
        durationMs,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? (error && !stderr ? error.message : "")),
      });
    });
  });
}

/**
 * 顺序执行阶段前置硬检查，收集全部结果（让主会话一轮修完所有失败项）。
 */
export async function runStagePrechecks({
  workspaceRoot,
  prechecks,
  timeoutMs = DEFAULT_PRECHECK_TIMEOUT_MS,
  runner = defaultRunner,
} = {}) {
  const rawList = Array.isArray(prechecks) ? prechecks : [];
  if (!rawList.length) {
    return { ok: true, total: 0, passed: 0, failed: 0, durationMs: 0, results: [] };
  }
  // v0.4 修复 P1：绝不静默截断超限检查，也不丢弃非法配置项（fail-closed）
  if (rawList.length > MAX_TOTAL_PRECHECKS) {
    return {
      ok: false,
      total: rawList.length,
      passed: 0,
      failed: 1,
      durationMs: 0,
      results: [{
        id: "precheck_limit",
        label: "前置硬检查数量超限",
        command: "",
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: `合并后的前置硬检查共 ${rawList.length} 条，超过上限 ${MAX_TOTAL_PRECHECKS} 条，已拒绝静默截断`,
      }],
    };
  }

  const startedAt = Date.now();
  const defaultTimeout = clampTimeout(timeoutMs, DEFAULT_PRECHECK_TIMEOUT_MS);
  const results = [];

  for (let idx = 0; idx < rawList.length; idx += 1) {
    const item = normalizePrecheck(rawList[idx], idx);
    if (!item) {
      results.push({
        id: `precheck_${idx + 1}`,
        label: "无效前置硬检查配置",
        command: String(rawList[idx]?.command ?? rawList[idx] ?? "").slice(0, 120),
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: `第 ${idx + 1} 条前置硬检查配置无效（需非空 command 且 ≤${MAX_PRECHECK_COMMAND_LENGTH} 字符，timeoutMs ≥ ${MIN_PRECHECK_TIMEOUT_MS}），门禁按 fail-closed 拦截`,
      });
      continue;
    }
    const cwdCheck = resolvePrecheckCwd(workspaceRoot, item.cwd);
    if (!cwdCheck.ok) {
      results.push({
        id: item.id,
        label: item.label,
        command: item.command,
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "",
        stderrTail: cwdCheck.error,
      });
      continue;
    }
    const itemTimeout = item.timeoutMs ?? defaultTimeout;
    const resolvedCmd = resolvePrecheckCommand(item.command);
    const execStart = Date.now();
    try {
      const out = await runner({ command: resolvedCmd.command, cwd: cwdCheck.cwd, timeoutMs: itemTimeout, item });
      const ok = Boolean(out?.ok);
      results.push({
        id: item.id,
        label: item.label,
        command: item.command,
        ...(resolvedCmd.fallbackFrom ? {
          executedCommand: resolvedCmd.command,
          fallbackFrom: resolvedCmd.fallbackFrom,
          note: resolvedCmd.note,
        } : {}),
        ok,
        exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : (ok ? 0 : 1),
        timedOut: Boolean(out?.timedOut),
        durationMs: Number.isFinite(out?.durationMs) ? Math.max(0, Math.trunc(out.durationMs)) : (Date.now() - execStart),
        stdoutTail: tailText(out?.stdout),
        stderrTail: tailText(out?.stderr),
      });
    } catch (err) {
      results.push({
        id: item.id,
        label: item.label,
        command: item.command,
        ...(resolvedCmd.fallbackFrom ? {
          executedCommand: resolvedCmd.command,
          fallbackFrom: resolvedCmd.fallbackFrom,
          note: resolvedCmd.note,
        } : {}),
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: Date.now() - execStart,
        stdoutTail: "",
        stderrTail: tailText(err?.message ?? err),
      });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    total: results.length,
    passed,
    failed,
    durationMs: Date.now() - startedAt,
    results,
  };
}

/** 给独立审查员提示用的精简摘要（仅在前置硬检查全部通过后注入）。 */
export function formatPrecheckPromptSummary(precheck) {
  if (!precheck || !precheck.total) return "";
  const items = (precheck.results ?? [])
    .map((r) => `${r.label}（${r.ok ? "通过" : "失败"}，${r.durationMs}ms${r.note ? `；${r.note}` : ""}）`)
    .join("；");
  return `前置确定性硬检查已通过（${precheck.passed}/${precheck.total}，耗时 ${precheck.durationMs}ms）：${items}。请重点审查逻辑正确性、边界条件与验收项覆盖。`;
}

/* ------------------------------------------------------------------ *
 * v0.5 · 安全零配置快速语法检查 + 只读建议探测
 *
 * 安全红线（防不可信仓库 RCE）：
 *   1. 自动执行仅使用 execFile（绝不经由 shell）+ 清洗环境变量（清除 NODE_OPTIONS /
 *      PYTHONSTARTUP / PYTHONPATH）+ 仅调用固定系统二进制（node --check），
 *      严禁自动执行 package.json scripts、npx、make 或 node_modules/.bin/*.cmd；
 *   2. 仓库构建/单测脚本仅作为只读建议（suggestedPrechecks）返回给主会话与用户显式采纳。
 * ------------------------------------------------------------------ */

const MAX_AUTO_SYNTAX_FILES = 20;
const AUTO_SYNTAX_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_READ_BYTES = 256 * 1024;
const JS_EXT_RE = /\.(?:[cm]?js)$/iu;
const JSON_EXT_RE = /\.json$/iu;

const JSONC_PATH_RE = /(?:^|\/)(?:[tj]sconfig(?:\.[^/]+)?\.json|\.vscode\/[^/]+\.json)$/iu;
const SCRUB_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
]);

function scrubbedEnv() {
  const env = { ...process.env };
  // Windows 环境变量大小写不敏感，必须按大写统一剔除防 Node_Options 绕过
  for (const key of Object.keys(env)) {
    if (SCRUB_ENV_KEYS.has(key.toUpperCase())) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Electron 宿主（DSH Desktop）下 process.execPath 是 Electron 二进制，必须加 ELECTRON_RUN_AS_NODE=1
  if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function runDirectBinary(bin, args, { cwd, timeoutMs = AUTO_SYNTAX_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
      env: scrubbedEnv(),
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM") && durationMs >= timeoutMs - 50);
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({
        ok: !error,
        exitCode,
        timedOut,
        durationMs,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? (error && !stderr ? error.message : "")),
      });
    });
  });
}

/**
 * 零配置安全语法硬检查（仅针对本次实际改动的 .js/.mjs/.cjs/.json 文件，不跑任何仓库脚本）。
 */
export async function runAutoSyntaxPrechecks({
  workspaceRoot,
  changedFiles = [],
  timeoutMs = AUTO_SYNTAX_TIMEOUT_MS,
  binaryRunner = runDirectBinary,
} = {}) {
  const cwdCheck = resolvePrecheckCwd(workspaceRoot, null);
  if (!cwdCheck.ok) {
    return { ok: true, total: 0, passed: 0, failed: 0, durationMs: 0, results: [], auto: true };
  }
  const activeFiles = (Array.isArray(changedFiles) ? changedFiles : [])
    .filter((f) => f && f.status !== "deleted" && typeof f.path === "string" && f.path.trim())
    .map((f) => f.path.replace(/\\/gu, "/"))
    .filter((p) => JS_EXT_RE.test(p) || JSON_EXT_RE.test(p))
    .slice(0, MAX_AUTO_SYNTAX_FILES);

  if (!activeFiles.length) {
    return { ok: true, total: 0, passed: 0, failed: 0, durationMs: 0, results: [], auto: true };
  }

  const startedAt = Date.now();
  const perFileTimeout = clampTimeout(timeoutMs, AUTO_SYNTAX_TIMEOUT_MS);
  const results = [];

  for (const rel of activeFiles) {
    const absCheck = resolvePrecheckCwd(workspaceRoot, rel);
    if (!absCheck.ok) continue;
    const execStart = Date.now();

    if (JSON_EXT_RE.test(rel)) {
      // JSONC（tsconfig.json / jsconfig.json / .vscode/*.json）允许注释与尾逗号，不做严格 JSON.parse 硬拦
      if (JSONC_PATH_RE.test(rel)) continue;
      try {
        const raw = await readFile(absCheck.cwd, "utf8");
        if (Buffer.byteLength(raw, "utf8") <= MAX_MANIFEST_READ_BYTES) {
          JSON.parse(raw);
          results.push({
            id: `auto_json_${results.length + 1}`,
            label: `auto-syntax: JSON.parse ${rel}`,
            command: `JSON.parse(${rel})`,
            ok: true,
            exitCode: 0,
            timedOut: false,
            durationMs: Date.now() - execStart,
            stdoutTail: "",
            stderrTail: "",
            auto: true,
          });
        }
      } catch (err) {
        results.push({
          id: `auto_json_${results.length + 1}`,
          label: `auto-syntax: JSON.parse ${rel}`,
          command: `JSON.parse(${rel})`,
          ok: false,
          exitCode: 1,
          timedOut: false,
          durationMs: Date.now() - execStart,
          stdoutTail: "",
          stderrTail: tailText(err?.message ?? err),
          auto: true,
        });
      }
      continue;
    }

    // JS / MJS / CJS：直接使用当前进程的可执行文件 process.execPath --check，杜绝 PATH 劫持
    const out = await binaryRunner(process.execPath, ["--check", absCheck.cwd], {
      cwd: cwdCheck.cwd,
      timeoutMs: perFileTimeout,
    });
    results.push({
      id: `auto_js_${results.length + 1}`,
      label: `auto-syntax: node --check ${rel}`,
      command: `node --check ${rel}`,
      ok: Boolean(out?.ok),
      exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : (out?.ok ? 0 : 1),
      timedOut: Boolean(out?.timedOut),
      durationMs: Number.isFinite(out?.durationMs) ? Math.max(0, Math.trunc(out.durationMs)) : (Date.now() - execStart),
      stdoutTail: tailText(out?.stdout),
      stderrTail: tailText(out?.stderr),
      auto: true,
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    total: results.length,
    passed,
    failed,
    durationMs: Date.now() - startedAt,
    results,
    auto: true,
  };
}

/**
 * 只读探测项目清单文件并给出前置检查建议（绝不静默执行，必须由计划或人工显式声明才运行）。
 */
export async function detectSuggestedPrechecks(workspaceRoot) {
  const cwdCheck = resolvePrecheckCwd(workspaceRoot, null);
  if (!cwdCheck.ok) return [];
  const root = cwdCheck.cwd;
  const suggestions = [];

  async function tryReadText(rel) {
    try {
      const buf = await readFile(path.join(root, rel));
      if (buf.length > MAX_MANIFEST_READ_BYTES) return null;
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  const pkgRaw = await tryReadText("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      for (const key of ["check", "typecheck", "lint", "test"]) {
        if (typeof scripts[key] === "string" && scripts[key].trim()) {
          suggestions.push({
            source: "package.json",
            label: `npm run ${key}`,
            command: `npm run ${key}`,
            scriptPreview: scripts[key].trim().slice(0, 120),
            requiresConfirmation: true,
          });
        }
      }
    } catch { /* ignore invalid json */ }
  }

  const tsconfig = await tryReadText("tsconfig.json");
  if (tsconfig) {
    suggestions.push({
      source: "tsconfig.json",
      label: "tsc --noEmit",
      command: "tsc --noEmit",
      requiresConfirmation: true,
    });
  }

  const pyproject = await tryReadText("pyproject.toml");
  if (pyproject) {
    suggestions.push({
      source: "pyproject.toml",
      label: "pytest -q",
      command: "pytest -q",
      requiresConfirmation: true,
    });
  }

  const cargo = await tryReadText("Cargo.toml");
  if (cargo) {
    suggestions.push({
      source: "Cargo.toml",
      label: "cargo check --offline",
      command: "cargo check --offline",
      requiresConfirmation: true,
    });
  }

  const gomod = await tryReadText("go.mod");
  if (gomod) {
    suggestions.push({
      source: "go.mod",
      label: "go test ./...",
      command: "go test ./...",
      requiresConfirmation: true,
    });
  }

  return suggestions.slice(0, 8);
}
