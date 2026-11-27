/**
 * v0.5 · 双模无侵入工作区快照、宿主真实 Diff 审计与按差异精准回滚
 *
 * 设计守则（对齐 2026 论文与开源 Postmortem）：
 *   1. 双模原生支持：
 *      · Git 仓模式：使用 os.tmpdir() 独立临时 GIT_INDEX_FILE + `git read-tree HEAD`
 *        + `git hash-object -w --no-filters` + `git update-index --index-info` + `git write-tree`。
 *        永不触碰 `.git/index`、永不重命名 `.git`（避开 Cline Windows 炸仓坑）、
 *        永不执行 `.gitattributes` clean/smudge filter（防不可信仓 RCE）、不碰 `git stash`。
 *      · 非 Git 目录模式：lstat 防符号链接/Windows Junction 环路扫描 + 内容寻址 SHA-256 清单
 *        + 轻量受限文本备份，让非 Git 工作区（含本插件自身目录）获得等价 Diff 与精准回滚能力。
 *   2. 安全边界：强制过滤 `isSensitivePath`（.env/.pem/.ssh/私钥）与 Windows 保留设备名（nul/con 等）。
 *   3. 精准回滚：只恢复 `<baseline>..<current>` 中本阶段改动的文件，绝不使用全量
 *      `checkout-index -a -f`（避开 OpenCode 刷全仓 mtime 触发 IDE 重载风暴的坑），
 *      不破坏用户任务前的未提交改动，且在文件被外部修改时默认拒绝（支持 `dryRun` 预览与 `force`）。
 *   4. 体积守恒：持久化到 task JSON 的 `diffAudit` 严格 < 2KB，全文统一 Diff 按需重建。
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSensitivePath } from "../review/evidence-reader.js";
import { pathsOverlap } from "../tools/parallel.js";

const GIT_TIMEOUT_MS = 12_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_SCAN_FILES = 6_000;
const MAX_BLOB_BYTES = 512 * 1024;
const MAX_TASK_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_DIFF_FILES_REPORTED = 50;
const MAX_UNIFIED_DIFF_CHARS = 96_000;

const IGNORED_DIRS = new Set([
  ".git",
  ".mentor-worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  ".cache",
  ".turbo",
]);

const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;

/** 纯内存快照存储（当 stateDir 为空时使用，按 taskId 隔离并自动限容） */
const memorySnapshots = new Map(); // taskId -> { snapshots: Map<snapId, manifest>, blobs: Map<sha256, Buffer> }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function toPosix(rel) {
  return String(rel ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function isIgnoredSegment(segment) {
  if (!segment) return false;
  if (IGNORED_DIRS.has(segment)) return true;
  if (process.platform === "win32" && WIN_RESERVED_RE.test(segment)) return true;
  return false;
}

function shouldSkipRelPath(relPath) {
  const norm = toPosix(relPath);
  if (!norm || norm === "." || path.posix.isAbsolute(norm) || /^[a-zA-Z]:/u.test(norm)) return true;
  if (isSensitivePath(norm)) return true;
  const parts = norm.split("/");
  if (parts.includes("..")) return true;
  return parts.some(isIgnoredSegment);
}

function normalizeRootKey(p) {
  if (!p || typeof p !== "string") return "";
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stripRelSubdir(gitRel, relSubdir) {
  if (!relSubdir) return gitRel;
  if (process.platform === "win32") {
    if (gitRel.toLowerCase().startsWith(`${relSubdir.toLowerCase()}/`)) {
      return gitRel.slice(relSubdir.length + 1);
    }
    return gitRel;
  }
  return gitRel.startsWith(`${relSubdir}/`) ? gitRel.slice(relSubdir.length + 1) : gitRel;
}

/** 校验回滚写入/删除路径严格位于 rootReal 内且沿途无符号链接/Windows Junction。 */
async function assertSafeRollbackTarget(rootAbs, rootReal, relPath) {
  if (shouldSkipRelPath(relPath)) return null;
  const abs = path.resolve(rootAbs, relPath);
  const relCheck = path.relative(rootAbs, abs);
  if (!relCheck || relCheck === ".." || relCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relCheck) ||
      (process.platform === "win32" && relCheck.includes(":"))) {
    return null;
  }
  // 逐级 lstat 检查已有祖先目录与叶节点，绝不跟随符号链接/联接点
  const segments = toPosix(relCheck).split("/").filter(Boolean);
  let cur = rootReal;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) return null;
    } catch (err) {
      if (err?.code === "ENOENT") break;
      return null;
    }
  }
  return abs;
}

function runGitExec(cwd, args, { env = null, input = null, encoding = "utf8", timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: encoding === "buffer" ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "")) : String(stdout ?? ""),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? (error && !stderr ? error.message : "")),
      });
    });
    if (input !== null && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

async function safeUnlinkRetry(filePath) {
  for (let i = 0; i < 6; i += 1) {
    try {
      await unlink(filePath);
      return;
    } catch (err) {
      if (err?.code === "ENOENT") return;
      if (process.platform === "win32" && ["EBUSY", "EPERM", "EACCES"].includes(err?.code)) {
        await sleep(25 * (i + 1));
        continue;
      }
      return;
    }
  }
}

function safeTaskSlug(taskId) {
  return createHash("sha256").update(String(taskId || "default")).digest("hex").slice(0, 24);
}

function getMemBucket(taskId) {
  const key = safeTaskSlug(taskId);
  let bucket = memorySnapshots.get(key);
  if (!bucket) {
    bucket = { snapshots: new Map(), blobs: new Map(), totalBytes: 0 };
    memorySnapshots.set(key, bucket);
    // 最多保留最近 16 个内存任务，防长驻内存泄漏
    if (memorySnapshots.size > 16) {
      const oldest = memorySnapshots.keys().next().value;
      if (oldest) memorySnapshots.delete(oldest);
    }
  }
  return bucket;
}

async function saveManifestBlob({ stateDir, taskId, hash, buf }) {
  if (!buf || buf.length > MAX_BLOB_BYTES) return false;
  if (!stateDir) {
    const bucket = getMemBucket(taskId);
    if (bucket.blobs.has(hash)) return true;
    if (bucket.totalBytes + buf.length > MAX_TASK_BACKUP_BYTES) return false;
    bucket.blobs.set(hash, Buffer.from(buf));
    bucket.totalBytes += buf.length;
    return true;
  }
  const blobDir = path.join(stateDir, "snapshots", safeTaskSlug(taskId), "blobs");
  const blobFile = path.join(blobDir, hash);
  try {
    await lstat(blobFile);
    return true;
  } catch {}
  await mkdir(blobDir, { recursive: true });
  await writeFile(blobFile, buf);
  return true;
}

async function readManifestBlob({ stateDir, taskId, hash }) {
  if (!hash) return null;
  if (!stateDir) {
    return getMemBucket(taskId).blobs.get(hash) ?? null;
  }
  const blobFile = path.join(stateDir, "snapshots", safeTaskSlug(taskId), "blobs", hash);
  try {
    return await readFile(blobFile);
  } catch {
    return null;
  }
}

async function saveManifestSnapshot({ stateDir, taskId, snapId, manifest }) {
  if (!stateDir) {
    getMemBucket(taskId).snapshots.set(snapId, manifest);
    return;
  }
  const dir = path.join(stateDir, "snapshots", safeTaskSlug(taskId));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${snapId}.json`), JSON.stringify(manifest), "utf8");
}

async function loadManifestSnapshot({ stateDir, taskId, snapId }) {
  if (!snapId) return null;
  if (!stateDir) {
    return getMemBucket(taskId).snapshots.get(snapId) ?? null;
  }
  const file = path.join(stateDir, "snapshots", safeTaskSlug(taskId), `${snapId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Git 模式无侵入快照（独立临时 GIT_INDEX_FILE + --no-filters）
 * ------------------------------------------------------------------ */

/** 解析 `git status --porcelain=v1 -z -uall` 输出（NUL 分隔，支持含空格/中文/重命名路径）。 */
function parsePorcelainZ(raw) {
  const entries = [];
  if (!raw) return entries;
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const xy = token.slice(0, 2);
    const filePath = token.slice(3);
    // 重命名/复制格式：XY newPath\0oldPath\0
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const oldPath = tokens[i + 1] ?? "";
      i += 1;
      if (oldPath) entries.push({ xy: "D ", path: toPosix(oldPath) });
      entries.push({ xy: "A ", path: toPosix(filePath) });
    } else {
      entries.push({ xy, path: toPosix(filePath) });
    }
  }
  return entries;
}

/**
 * 读取仓库/环境里所有已配置的 filter.<name>.(clean|smudge|process) 键名，
 * 并同时禁用 core.fsmonitor 与 core.hooksPath，彻底阻断 git status / diff-tree / cat-file 触发任意外部命令 RCE。
 */
async function collectFilterDisableFlags(repoRoot) {
  const flags = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath="];
  const res = await runGitExec(repoRoot, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"]);
  if (!res.ok || !res.stdout.trim()) return flags;
  const seen = new Set();
  for (const raw of res.stdout.split(/\r?\n/u)) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    flags.push("-c", `${key}=`);
  }
  return flags;
}

async function captureGitSnapshot({ workspaceRoot, gitProbe }) {
  const repoRoot = gitProbe.repoRoot;
  let wsReal = path.resolve(workspaceRoot);
  try { wsReal = await realpath(workspaceRoot); } catch {}
  const tmpIdx = path.join(tmpdir(), `dsh-mentor-idx-${process.pid}-${randomBytes(6).toString("hex")}`);
  const env = {
    GIT_INDEX_FILE: tmpIdx,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const noFilterFlags = await collectFilterDisableFlags(repoRoot);
    // 1) 从 HEAD 只读填充临时索引（完全不触碰 .git/index）
    const readTree = await runGitExec(repoRoot, [...noFilterFlags, "read-tree", gitProbe.baseHead], { env });
    if (!readTree.ok) {
      return { ok: false, reason: "git-read-tree-failed", detail: readTree.stderr.trim() };
    }

    // 2) 仅枚举当前工作树相对于 HEAD 的变更与未跟踪文件（O(dirty files)，大仓也极快；已禁用全部外部过滤器与 fsmonitor）
    const relSubdir = toPosix(path.relative(repoRoot, wsReal));
    const safeSubdir = relSubdir && !relSubdir.startsWith("..") && !path.isAbsolute(relSubdir) ? relSubdir : "";
    const scopeArgs = safeSubdir ? ["--", safeSubdir] : [];
    const statusRes = await runGitExec(
      repoRoot,
      [...noFilterFlags, "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=dirty", ...scopeArgs],
      { env },
    );
    if (!statusRes.ok) {
      return { ok: false, reason: "git-status-failed", detail: statusRes.stderr.trim() };
    }

    const dirty = parsePorcelainZ(statusRes.stdout);
    const indexRecords = [];
    let skippedSensitive = 0;
    let truncated = false;

    for (const item of dirty) {
      if (indexRecords.length >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const gitRel = item.path;
      const wsRel = stripRelSubdir(gitRel, safeSubdir);
      if (isSensitivePath(gitRel) || isSensitivePath(wsRel)) {
        skippedSensitive += 1;
        continue;
      }
      if (shouldSkipRelPath(gitRel)) continue;

      const absPath = path.resolve(repoRoot, gitRel);
      let st = null;
      try {
        st = await lstat(absPath);
      } catch {
        st = null;
      }

      if (!st || item.xy.includes("D")) {
        indexRecords.push(`0 0000000000000000000000000000000000000000\t${gitRel}`);
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;

      // 关键安全措施：用 --no-filters 直接写原始字节对象，彻底绕过仓库 .gitattributes clean filter RCE
      const hashRes = await runGitExec(repoRoot, ["hash-object", "-w", "--no-filters", "--", absPath], { env });
      if (!hashRes.ok || !hashRes.stdout.trim()) continue;
      const oid = hashRes.stdout.trim();
      const mode = (st.mode & 0o111) && process.platform !== "win32" ? "100755" : "100644";
      indexRecords.push(`${mode} ${oid}\t${gitRel}`);
    }

    if (indexRecords.length > 0) {
      // 使用 -z NUL 分隔，免疫文件名含换行或引号的索引注入
      const upd = await runGitExec(repoRoot, ["update-index", "-z", "--index-info"], {
        env,
        input: `${indexRecords.join("\0")}\0`,
      });
      if (!upd.ok) {
        return { ok: false, reason: "git-update-index-failed", detail: upd.stderr.trim() };
      }
    }

    const treeRes = await runGitExec(repoRoot, ["write-tree"], { env });
    if (!treeRes.ok || !treeRes.stdout.trim()) {
      return { ok: false, reason: "git-write-tree-failed", detail: treeRes.stderr.trim() };
    }

    return {
      ok: true,
      mode: "git",
      id: treeRes.stdout.trim(),
      treeSha: treeRes.stdout.trim(),
      workspaceRoot: wsReal,
      repoRoot,
      relSubdir: safeSubdir,
      baseHead: gitProbe.baseHead,
      dirtyCount: dirty.length,
      skippedSensitive,
      truncated,
      at: Date.now(),
    };
  } finally {
    await safeUnlinkRetry(tmpIdx);
    await safeUnlinkRetry(`${tmpIdx}.lock`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. 非 Git 目录模式安全快照（lstat 防环路 + SHA-256 清单 + 轻量备份）
 * ------------------------------------------------------------------ */

async function scanWorkspaceManifest({ workspaceRoot, stateDir, taskId, saveBlobs = true }) {
  const rootReal = await realpath(workspaceRoot);
  let stateReal = null;
  if (stateDir) {
    try { stateReal = await realpath(stateDir); } catch { stateReal = path.resolve(stateDir); }
  }
  const stateKey = stateReal ? (process.platform === "win32" ? stateReal.toLowerCase() : stateReal) : null;
  const rootKey = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
  const visitedDirs = new Set([rootKey]);
  const files = {};
  let fileCount = 0;
  let skippedSensitive = 0;
  let truncated = false;

  async function walk(currentDir, relPrefix) {
    if (fileCount >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (isIgnoredSegment(name)) continue;
      if (stateKey && rootKey === stateKey && ["snapshots", "sessions", "history", "quarantine"].includes(name)) continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (isSensitivePath(rel)) {
        skippedSensitive += 1;
        continue;
      }
      const abs = path.join(currentDir, name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      // 严禁跟随符号链接/Windows Junction，防目录环路与越界读盘
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        let dirReal;
        try {
          dirReal = await realpath(abs);
        } catch {
          continue;
        }
        const key = process.platform === "win32" ? dirReal.toLowerCase() : dirReal;
        if (stateKey && key === stateKey && stateKey !== rootKey) continue;
        if (visitedDirs.has(key)) continue;
        visitedDirs.add(key);
        await walk(abs, rel);
      } else if (st.isFile()) {
        fileCount += 1;
        if (st.size <= MAX_BLOB_BYTES) {
          try {
            const buf = await readFile(abs);
            const hash = sha256Buf(buf);
            const backedUp = saveBlobs ? await saveManifestBlob({ stateDir, taskId, hash, buf }) : false;
            files[rel] = { sha256: hash, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), backedUp };
          } catch {
            /* skip unreadable */
          }
        } else {
          // 大文件只记元信息指纹，不读入内存
          files[rel] = { sha256: `large:${st.size}:${Math.trunc(st.mtimeMs)}`, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), backedUp: false };
        }
      }
    }
  }

  await walk(rootReal, "");
  const snapId = `m_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const manifestDigest = createHash("sha256")
    .update(Object.keys(files).sort().map((k) => `${k}:${files[k].sha256}`).join("\n"), "utf8")
    .digest("hex");
  const manifest = { id: snapId, workspaceRoot: rootReal, manifestDigest, at: Date.now(), files, fileCount, skippedSensitive, truncated };
  await saveManifestSnapshot({ stateDir, taskId, snapId, manifest });
  return {
    ok: true,
    mode: "manifest",
    id: snapId,
    manifestDigest,
    workspaceRoot: rootReal,
    fileCount,
    skippedSensitive,
    truncated,
    at: manifest.at,
  };
}

/** 仅用只读 rev-parse 探测 Git 仓库与 HEAD（绝不跑 git status，避免在禁用 filter 前触发 .gitattributes clean filter）。 */
async function probeGitRepoFast(workspaceRoot) {
  const top = await runGitExec(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) return { available: false, reason: "not-a-git-repo" };
  const repoRoot = path.resolve(top.stdout.trim());
  const head = await runGitExec(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok || !head.stdout.trim()) return { available: false, reason: "git-head-missing" };
  return { available: true, repoRoot, baseHead: head.stdout.trim() };
}

/** 捕获当前工作区快照（自动选择 Git 无侵入 plumbing 或非 Git 安全清单）。 */
export async function captureWorkspaceSnapshot({ workspaceRoot, stateDir = "", taskId = "default" } = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    return { ok: false, reason: "workspace-root-missing" };
  }
  try {
    const gitProbe = await probeGitRepoFast(workspaceRoot);
    if (gitProbe.available) {
      const gitSnap = await captureGitSnapshot({ workspaceRoot, gitProbe });
      if (gitSnap.ok) return gitSnap;
    }
    return await scanWorkspaceManifest({ workspaceRoot, stateDir, taskId, saveBlobs: true });
  } catch (err) {
    return { ok: false, reason: "snapshot-failed", detail: String(err?.message ?? err) };
  }
}

/* ------------------------------------------------------------------ *
 * 3. 纯 JS 轻量统一 Diff（用于非 Git 模式，零外部依赖）
 * ------------------------------------------------------------------ */

function isProbablyBinary(buf) {
  if (!buf || !buf.length) return false;
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 轻量 LCS 逐行统一 Diff（超长文件自动退化为全段替换，保证毫秒级完成）。 */
export function buildSimpleUnifiedDiff(relPath, oldText, newText) {
  const a = oldText === null ? [] : String(oldText).split(/\r?\n/u);
  const b = newText === null ? [] : String(newText).split(/\r?\n/u);
  const oldLabel = oldText === null ? "/dev/null" : `a/${relPath}`;
  const newLabel = newText === null ? "/dev/null" : `b/${relPath}`;
  const header = `diff --git a/${relPath} b/${relPath}\n--- ${oldLabel}\n+++ ${newLabel}\n`;

  if (oldText === null) {
    const body = b.map((l) => `+${l}`).join("\n");
    return {
      addedLines: b.length,
      removedLines: 0,
      text: `${header}@@ -0,0 +1,${b.length} @@\n${body}\n`,
    };
  }
  if (newText === null) {
    const body = a.map((l) => `-${l}`).join("\n");
    return {
      addedLines: 0,
      removedLines: a.length,
      text: `${header}@@ -1,${a.length} +0,0 @@\n${body}\n`,
    };
  }

  // 裁剪公共前后缀，大幅缩小矩阵规模
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (!midA.length && !midB.length) {
    return { addedLines: 0, removedLines: 0, text: "" };
  }

  const ops = [];
  if (midA.length * midB.length <= 160_000) {
    const m = midA.length;
    const n = midB.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j]
          ? dp[i + 1][j + 1] + 1
          : (dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ type: " ", line: midA[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "-", line: midA[i] });
        i += 1;
      } else {
        ops.push({ type: "+", line: midB[j] });
        j += 1;
      }
    }
    while (i < m) { ops.push({ type: "-", line: midA[i] }); i += 1; }
    while (j < n) { ops.push({ type: "+", line: midB[j] }); j += 1; }
  } else {
    for (const line of midA) ops.push({ type: "-", line });
    for (const line of midB) ops.push({ type: "+", line });
  }

  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.type === "+") addedLines += 1;
    else if (op.type === "-") removedLines += 1;
  }

  const ctxBefore = a.slice(Math.max(0, prefix - 3), prefix).map((l) => ` ${l}`);
  const ctxAfter = a.slice(a.length - suffix, Math.min(a.length, a.length - suffix + 3)).map((l) => ` ${l}`);
  const hunkStartA = Math.max(1, prefix - ctxBefore.length + 1);
  const hunkLenA = ctxBefore.length + midA.length + ctxAfter.length;
  const hunkStartB = hunkStartA;
  const hunkLenB = ctxBefore.length + midB.length + ctxAfter.length;
  const hunkBody = [...ctxBefore, ...ops.map((o) => `${o.type}${o.line}`), ...ctxAfter].join("\n");

  return {
    addedLines,
    removedLines,
    text: `${header}@@ -${hunkStartA},${hunkLenA} +${hunkStartB},${hunkLenB} @@\n${hunkBody}\n`,
  };
}

/* ------------------------------------------------------------------ *
 * 4. 宿主真实 Diff 审计（Git & 非 Git 统一输出结构）
 * ------------------------------------------------------------------ */

async function diffGitSnapshots({ baseline, current }) {
  const repoRoot = current.repoRoot || baseline.repoRoot;
  const relSubdir = current.relSubdir || baseline.relSubdir || "";
  const pathArgs = relSubdir ? ["--", relSubdir] : [];
  const noFilterFlags = await collectFilterDisableFlags(repoRoot);

  const statusRes = await runGitExec(repoRoot, [
    ...noFilterFlags,
    "-c", "core.quotepath=false",
    "diff-tree", "-r", "--no-renames", "--name-status", "-z",
    baseline.treeSha, current.treeSha, ...pathArgs,
  ]);
  if (!statusRes.ok) {
    return { ok: false, reason: "git-diff-tree-failed", detail: statusRes.stderr.trim() };
  }

  const numstatRes = await runGitExec(repoRoot, [
    ...noFilterFlags,
    "-c", "core.quotepath=false",
    "diff-tree", "-r", "--no-renames", "--numstat", "-z",
    baseline.treeSha, current.treeSha, ...pathArgs,
  ]);

  const countsByPath = new Map();
  if (numstatRes.ok && numstatRes.stdout) {
    for (const rec of numstatRes.stdout.split("\0")) {
      if (!rec) continue;
      const parts = rec.split("\t");
      if (parts.length < 3) continue;
      const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
      const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
      const p = toPosix(parts.slice(2).join("\t"));
      countsByPath.set(p, { addedLines: added, removedLines: removed });
    }
  }

  const tokens = statusRes.stdout.split("\0").filter(Boolean);
  const changedFiles = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i];
    const gitRel = toPosix(tokens[i + 1]);
    if (shouldSkipRelPath(gitRel)) continue;
    const wsRel = stripRelSubdir(gitRel, relSubdir);
    const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
    const c = countsByPath.get(gitRel) ?? { addedLines: 0, removedLines: 0 };
    changedFiles.push({ path: wsRel, gitPath: gitRel, status, addedLines: c.addedLines, removedLines: c.removedLines });
  }

  let unifiedDiff = "";
  if (changedFiles.length > 0) {
    const safeGitPaths = changedFiles.slice(0, MAX_DIFF_FILES_REPORTED).map((f) => f.gitPath);
    const patchRes = await runGitExec(repoRoot, [
      ...noFilterFlags,
      "-c", "core.quotepath=false",
      "diff-tree", "-p", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
      ...(relSubdir ? [`--relative=${relSubdir}`] : []),
      baseline.treeSha, current.treeSha, "--", ...safeGitPaths,
    ]);
    if (patchRes.ok) {
      unifiedDiff = patchRes.stdout.length > MAX_UNIFIED_DIFF_CHARS
        ? `${patchRes.stdout.slice(0, MAX_UNIFIED_DIFF_CHARS)}\n…(diff truncated)`
        : patchRes.stdout;
    }
  }

  return {
    ok: true,
    mode: "git",
    changedFiles: changedFiles.map(({ path: p, status, addedLines, removedLines }) => ({
      path: p,
      status,
      addedLines,
      removedLines,
    })),
    unifiedDiff,
  };
}

async function diffManifestSnapshots({ stateDir, taskId, baseline, current }) {
  const baseM = await loadManifestSnapshot({ stateDir, taskId, snapId: baseline.id });
  const currM = await loadManifestSnapshot({ stateDir, taskId, snapId: current.id });
  if (!baseM || !currM) {
    return { ok: false, reason: "manifest-snapshot-missing" };
  }

  const allPaths = new Set([...Object.keys(baseM.files ?? {}), ...Object.keys(currM.files ?? {})]);
  const changedFiles = [];
  const diffChunks = [];
  let diffChars = 0;

  for (const rel of [...allPaths].sort()) {
    if (shouldSkipRelPath(rel)) continue;
    const before = baseM.files?.[rel] ?? null;
    const after = currM.files?.[rel] ?? null;
    if (before && after && before.sha256 === after.sha256) continue;

    const status = !before ? "added" : !after ? "deleted" : "modified";
    let addedLines = 0;
    let removedLines = 0;

    const beforeBuf = before?.backedUp ? await readManifestBlob({ stateDir, taskId, hash: before.sha256 }) : null;
    const afterBuf = after?.backedUp ? await readManifestBlob({ stateDir, taskId, hash: after.sha256 }) : null;
    const canTextDiff =
      (status === "added" && afterBuf && !isProbablyBinary(afterBuf)) ||
      (status === "deleted" && beforeBuf && !isProbablyBinary(beforeBuf)) ||
      (status === "modified" && beforeBuf && afterBuf && !isProbablyBinary(beforeBuf) && !isProbablyBinary(afterBuf));

    if (canTextDiff) {
      const oldText = status === "added" ? null : beforeBuf.toString("utf8");
      const newText = status === "deleted" ? null : afterBuf.toString("utf8");
      const built = buildSimpleUnifiedDiff(rel, oldText, newText);
      addedLines = built.addedLines;
      removedLines = built.removedLines;
      if (built.text && diffChars < MAX_UNIFIED_DIFF_CHARS) {
        const remain = MAX_UNIFIED_DIFF_CHARS - diffChars;
        diffChunks.push(built.text.length > remain ? `${built.text.slice(0, remain)}\n…(diff truncated)` : built.text);
        diffChars += built.text.length;
      }
    }

    changedFiles.push({ path: rel, status, addedLines, removedLines });
  }

  return {
    ok: true,
    mode: "manifest",
    changedFiles,
    unifiedDiff: diffChunks.join(""),
  };
}

/** 规范化相对路径集合（Windows 大小写无关比对）。 */
function pathKey(p) {
  const norm = toPosix(p);
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** 将工作区内的绝对或相对路径统一转为相对 workspaceRoot 的 posix 路径（兼容 Windows 8.3 短路径 / macOS /var 符号链接）。 */
function normalizeToWorkspaceRel(roots, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  const trimmed = filePath.trim();
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  if (rootList.length && path.isAbsolute(trimmed)) {
    const absTarget = path.resolve(trimmed);
    for (const r of rootList) {
      const rel = path.relative(path.resolve(r), absTarget);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
      if (rel === "") return ".";
    }
  }
  return toPosix(trimmed);
}

/**
 * 计算阶段真实 Diff 审计摘要（紧凑供落盘与审查员前置事实核对）及全量未截断变更列表。
 */
export async function computeStageDiffAudit({
  workspaceRoot,
  stateDir = "",
  taskId = "default",
  baseline,
  current = null,
  evidenceRefs = [],
  writePaths = [],
} = {}) {
  if (!baseline || !baseline.ok) {
    return { ok: false, reason: "baseline-missing" };
  }
  let wsReal = workspaceRoot ? path.resolve(workspaceRoot) : "";
  if (workspaceRoot) {
    try { wsReal = await realpath(workspaceRoot); } catch {}
  }
  if (baseline.workspaceRoot && wsReal && normalizeRootKey(baseline.workspaceRoot) !== normalizeRootKey(wsReal)) {
    return { ok: false, reason: "workspace-root-mismatch" };
  }
  const latest = current?.ok ? current : await captureWorkspaceSnapshot({ workspaceRoot, stateDir, taskId });
  if (!latest.ok) {
    return { ok: false, reason: latest.reason || "current-snapshot-failed", detail: latest.detail };
  }
  if (baseline.mode !== latest.mode) {
    return { ok: false, reason: "snapshot-mode-mismatch" };
  }

  const rawDiff = baseline.mode === "git"
    ? await diffGitSnapshots({ baseline, current: latest })
    : await diffManifestSnapshots({ stateDir, taskId, baseline, current: latest });
  if (!rawDiff.ok) return rawDiff;

  const normRoots = [wsReal, workspaceRoot].filter(Boolean);
  const declared = [...new Set(
    (Array.isArray(evidenceRefs) ? evidenceRefs : [])
      .map((ref) => (typeof ref === "string" ? ref : ref?.file))
      .map((f) => normalizeToWorkspaceRel(normRoots, f))
      .filter(Boolean),
  )];
  const declaredKeys = new Set(declared.map(pathKey));
  const changedKeys = new Set(rawDiff.changedFiles.map((f) => pathKey(f.path)));

  const undeclaredFiles = rawDiff.changedFiles
    .filter((f) => !declaredKeys.has(pathKey(f.path)))
    .map((f) => f.path);

  const normalizedWritePaths = Array.isArray(writePaths)
    ? writePaths.map((p) => normalizeToWorkspaceRel(normRoots, p)).filter(Boolean)
    : [];
  const outsideWritePaths = normalizedWritePaths.length > 0
    ? rawDiff.changedFiles
        .filter((f) => !normalizedWritePaths.some((wp) => pathsOverlap(wp, f.path)))
        .map((f) => f.path)
    : [];

  const unchangedCitedFiles = declared.filter((f) => !changedKeys.has(pathKey(f)));

  const totalAddedLines = rawDiff.changedFiles.reduce((s, f) => s + (f.addedLines || 0), 0);
  const totalRemovedLines = rawDiff.changedFiles.reduce((s, f) => s + (f.removedLines || 0), 0);

  const audit = {
    mode: latest.mode,
    baselineId: baseline.id,
    currentId: latest.id,
    at: latest.at,
    totalChangedFiles: rawDiff.changedFiles.length,
    changedFiles: rawDiff.changedFiles.slice(0, MAX_DIFF_FILES_REPORTED),
    truncatedFiles: rawDiff.changedFiles.length > MAX_DIFF_FILES_REPORTED,
    totalAddedLines,
    totalRemovedLines,
    totalDiffLines: totalAddedLines + totalRemovedLines,
    declaredCount: declared.length,
    undeclaredFiles: undeclaredFiles.slice(0, 30),
    outsideWritePaths: outsideWritePaths.slice(0, 30),
    unchangedCitedFiles: unchangedCitedFiles.slice(0, 20),
  };

  return {
    ok: true,
    audit,
    allChangedFiles: rawDiff.changedFiles,
    currentSnapshot: latest,
    unifiedDiff: rawDiff.unifiedDiff,
  };
}

/** 按需提取单个文件的 Diff 片段（供审查员 `mentor_evidence_read({ mode: "diff" })` 调用）。 */
export async function readFileDiffExcerpt({
  workspaceRoot,
  stateDir = "",
  taskId = "default",
  baseline,
  current,
  file = null,
} = {}) {
  const res = await computeStageDiffAudit({ workspaceRoot, stateDir, taskId, baseline, current });
  if (!res.ok) return res;
  let text = res.unifiedDiff || "";
  if (file) {
    const norm = toPosix(file);
    const sections = text.split(/(?=^diff --git )/mu);
    const matched = sections.filter((sec) => {
      const firstLine = sec.split(/\r?\n/u, 1)[0] ?? "";
      return firstLine.includes(`a/${norm} `) || firstLine.endsWith(`b/${norm}`);
    });
    text = matched.join("");
  }
  return {
    ok: true,
    mode: res.audit.mode,
    changedFiles: res.audit.changedFiles,
    undeclaredFiles: res.audit.undeclaredFiles,
    diff: text.slice(0, 24_000),
    truncated: text.length > 24_000,
  };
}

/* ------------------------------------------------------------------ *
 * 5. 按差异文件精准回滚（零全量 checkout，绝不刷无关文件 mtime）
 * ------------------------------------------------------------------ */

async function readFileFromGitTree(repoRoot, treeSha, gitRel) {
  const res = await runGitExec(repoRoot, ["cat-file", "-p", `${treeSha}:${gitRel}`], { encoding: "buffer" });
  return res.ok ? res.stdout : null;
}

/**
 * 将工作区精准回滚到 `targetSnapshot`（仅还原 target..current 之间发生变更的文件）。
 *
 * 保护守则：
 *   1. `dryRun: true` 只返回将丢弃/恢复的文件清单（供 Calm UI 5 秒预览），不写磁盘；
 *   2. 默认检查磁盘现状是否与 `currentSnapshot` 一致，若已被人工或外部进程修改且 `force !== true`，
 *      拒绝覆盖并返回 `externalConflicts`，防止误删用户手动改动；
 *   3. 绝不碰 target..current 未变动的文件，完全保留其他文件的 mtime 与任务前未提交改动。
 */
export async function rollbackToSnapshot({
  workspaceRoot,
  stateDir = "",
  taskId = "default",
  targetSnapshot,
  currentSnapshot = null,
  dryRun = false,
  force = false,
} = {}) {
  if (!workspaceRoot || !targetSnapshot?.ok) {
    return { ok: false, reason: "target-snapshot-missing", message: "缺少可回滚的阶段快照" };
  }
  const rootAbs = path.resolve(workspaceRoot);
  let rootReal = rootAbs;
  try { rootReal = await realpath(rootAbs); } catch {}
  if (targetSnapshot.workspaceRoot && normalizeRootKey(targetSnapshot.workspaceRoot) !== normalizeRootKey(rootReal)) {
    return {
      ok: false,
      reason: "workspace-root-mismatch",
      message: "目标快照归属其他工作区，已拒绝跨项目回滚",
    };
  }
  const nowSnap = await captureWorkspaceSnapshot({ workspaceRoot, stateDir, taskId });
  if (!nowSnap.ok) {
    return { ok: false, reason: nowSnap.reason || "current-snapshot-failed", message: "无法采集当前工作区状态" };
  }
  if (nowSnap.mode !== targetSnapshot.mode) {
    return { ok: false, reason: "snapshot-mode-mismatch", message: "当前工作区快照模式与目标快照不一致，无法安全回滚" };
  }

  // 若给了阶段结束快照 currentSnapshot，使用全量未截断列表检查自阶段结束以来有无外部人工改动
  const externalConflicts = [];
  if (currentSnapshot?.ok && currentSnapshot.mode === nowSnap.mode && !force) {
    const drift = await computeStageDiffAudit({
      workspaceRoot,
      stateDir,
      taskId,
      baseline: currentSnapshot,
      current: nowSnap,
    });
    if (drift.ok && drift.allChangedFiles.length > 0) {
      for (const f of drift.allChangedFiles) externalConflicts.push(f.path);
    }
  }

  const delta = await computeStageDiffAudit({
    workspaceRoot,
    stateDir,
    taskId,
    baseline: targetSnapshot,
    current: nowSnap,
  });
  if (!delta.ok) {
    return { ok: false, reason: delta.reason || "diff-failed", message: "无法计算回滚差异" };
  }

  // 使用全量未截断 allChangedFiles，彻底杜绝 >50 文件时的静默半回滚
  const fullChanges = delta.allChangedFiles;
  const toRestore = fullChanges.filter((f) => f.status === "modified" || f.status === "deleted").map((f) => f.path);
  const toDelete = fullChanges.filter((f) => f.status === "added").map((f) => f.path);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: targetSnapshot.mode,
      targetSnapshotId: targetSnapshot.id,
      toRestore,
      toDelete,
      externalConflicts,
      totalAffected: toRestore.length + toDelete.length,
    };
  }

  if (externalConflicts.length > 0 && !force) {
    return {
      ok: false,
      reason: "external-modifications-detected",
      message: `检测到阶段快照之后有外部修改（${externalConflicts.slice(0, 5).join("、")}），已中止回滚以防丢失人工改动；确认覆盖请加 force`,
      externalConflicts,
      toRestore,
      toDelete,
    };
  }

  const restoredFiles = [];
  const deletedFiles = [];
  const skippedFiles = [];

  // 回滚前全量路径安全预检：发现任何穿越路径、绝对路径或符号链接/联接点立即整体中止，不落半截改动
  const unsafePaths = [];
  const safeTargets = new Map();
  for (const rel of [...toRestore, ...toDelete]) {
    if (safeTargets.has(rel)) continue;
    const abs = await assertSafeRollbackTarget(rootAbs, rootReal, rel);
    if (!abs) unsafePaths.push(rel);
    else safeTargets.set(rel, abs);
  }
  if (unsafePaths.length > 0) {
    return {
      ok: false,
      reason: "unsafe-rollback-path",
      message: `检测到越界或符号链接路径（${unsafePaths.slice(0, 5).join("、")}），已中止回滚`,
      unsafePaths,
    };
  }

  if (targetSnapshot.mode === "git") {
    const repoRoot = targetSnapshot.repoRoot;
    const relSubdir = targetSnapshot.relSubdir || "";
    for (const rel of toRestore) {
      const abs = safeTargets.get(rel);
      const gitRel = relSubdir ? `${relSubdir}/${rel}` : rel;
      const bytes = await readFileFromGitTree(repoRoot, targetSnapshot.treeSha, gitRel);
      if (bytes === null) { skippedFiles.push(rel); continue; }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      restoredFiles.push(rel);
    }
    for (const rel of toDelete) {
      const abs = safeTargets.get(rel);
      await safeUnlinkRetry(abs);
      deletedFiles.push(rel);
    }
  } else {
    const targetManifest = await loadManifestSnapshot({ stateDir, taskId, snapId: targetSnapshot.id });
    if (!targetManifest) {
      return { ok: false, reason: "manifest-snapshot-missing", message: "找不到目标非 Git 快照清单" };
    }
    for (const rel of toRestore) {
      const abs = safeTargets.get(rel);
      const entry = targetManifest.files?.[rel];
      const bytes = entry?.backedUp ? await readManifestBlob({ stateDir, taskId, hash: entry.sha256 }) : null;
      if (bytes === null) { skippedFiles.push(rel); continue; }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      restoredFiles.push(rel);
    }
    for (const rel of toDelete) {
      const abs = safeTargets.get(rel);
      await safeUnlinkRetry(abs);
      deletedFiles.push(rel);
    }
  }

  return {
    ok: true,
    dryRun: false,
    mode: targetSnapshot.mode,
    targetSnapshotId: targetSnapshot.id,
    restoredFiles,
    deletedFiles,
    skippedFiles,
    totalAffected: restoredFiles.length + deletedFiles.length,
  };
}

/** 生成给独立审查员的紧凑宿主 Diff 事实摘要（零额外工具调用，直供审查员前置核对）。 */
export function formatDiffAuditForPrompt(diffAudit, tamperScan = null) {
  if (!diffAudit) return "";
  const lines = [];
  const fileBrief = (diffAudit.changedFiles ?? [])
    .slice(0, 12)
    .map((f) => `${f.path}(${f.status[0]}+${f.addedLines}/-${f.removedLines})`)
    .join("、");
  lines.push(
    `宿主真实工作区改动审计（${diffAudit.mode}，不可由被审方伪造）：共变更 ${diffAudit.totalChangedFiles} 个文件（+${diffAudit.totalAddedLines}/-${diffAudit.totalRemovedLines} 行）` +
    (fileBrief ? `：${fileBrief}${diffAudit.totalChangedFiles > 12 ? " 等" : ""}` : "（无文件变更）") + "。",
  );
  if (diffAudit.undeclaredFiles?.length) {
    lines.push(
      `⚠ 未声明改动警告（共 ${diffAudit.undeclaredFiles.length} 个文件被修改但未出现在 evidenceRefs 中）：${diffAudit.undeclaredFiles.slice(0, 10).join("、")}。请务必核查这些改动是否偏离任务范围或存在隐蔽缺陷（可用 mentor_evidence_read mode="diff" 查看差异）。`,
    );
  }
  if (diffAudit.outsideWritePaths?.length) {
    lines.push(
      `⚠ 越出写域警告：以下改动超出本阶段 writePaths：${diffAudit.outsideWritePaths.slice(0, 10).join("、")}。`,
    );
  }
  if (tamperScan?.warnings?.length) {
    const warnText = tamperScan.warnings
      .slice(0, 6)
      .map((w) => `[${w.rule}] ${w.file}:${w.line ?? "?"} ${w.summary}`)
      .join("；");
    lines.push(`⚠ 测试完整性提示（请人工/审查核实是否为合法需求变更）：${warnText}。`);
  }
  return lines.join("\n");
}
