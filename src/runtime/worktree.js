/**
 * v0.4 · 并行 Git Worktree 物理隔离与顺序合并闸门
 *
 * 仅在配置 `workerIsolation: "worktree"` 时启用（默认 `"none"`，保持零侵入兼容）。
 * 设计守则（对齐三方审计共识）：
 *   1. 固定基线提交（baseHead）：派工前校验 Git 仓库与有效 HEAD；
 *   2. 物理隔离：每个写入型 worker 在独立 `.mentor-worktrees/<id>` 目录与临时分支运行；
 *   3. 顺序合并闸门：全部 worker 结束并释放句柄后，先重检 HEAD 是否漂移，再逐个
 *      `git apply --check --3way` 预检并合入主工作区；冲突即停并保留分支，零数据丢失；
 *   4. Windows 安全清理：仅用 `git worktree remove --force` + `git worktree prune`
 *      （带短重试处理句柄释放），严禁用盲目递归删除兜底。
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const WORKTREE_DIR_NAME = ".mentor-worktrees";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeSlug = (v) => String(v ?? "x").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

export function runGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? (error && !stderr ? error.message : "")),
      });
    });
  });
}

/** 探测工作区是否为有效 Git 仓库并固定基线 HEAD。 */
export async function probeGitWorktree(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    return { available: false, reason: "workspace-root-missing" };
  }
  const top = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) {
    return { available: false, reason: "not-a-git-repo", detail: top.stderr.trim() };
  }
  const repoRoot = path.resolve(top.stdout.trim());
  const head = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok || !head.stdout.trim()) {
    return { available: false, reason: "git-head-missing", detail: head.stderr.trim() };
  }
  const status = await runGit(repoRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.ok
    ? status.stdout.split(/\r?\n/u).filter((l) => l.trim().length > 0).map((l) => l.slice(3).trim())
    : [];
  return {
    available: true,
    repoRoot,
    baseHead: head.stdout.trim(),
    dirtyFiles,
  };
}

/** 确保 `.mentor-worktrees/` 写入 `.git/info/exclude`，避免污染仓库 `git status`。 */
async function ensureGitExclude(repoRoot) {
  try {
    const gitDirRes = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
    if (!gitDirRes.ok || !gitDirRes.stdout.trim()) return;
    const gitDir = path.resolve(repoRoot, gitDirRes.stdout.trim());
    const excludePath = path.join(gitDir, "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    let existing = "";
    try { existing = await readFile(excludePath, "utf8"); } catch {}
    if (!existing.split(/\r?\n/u).some((line) => line.trim() === `${WORKTREE_DIR_NAME}/`)) {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      await appendFile(excludePath, `${prefix}${WORKTREE_DIR_NAME}/\n`, "utf8");
    }
  } catch { /* non-fatal */ }
}

/** 为单个并行 worker 创建物理隔离的 Git worktree 与临时分支。 */
export async function createWorkerWorktree({ repoRoot, batchId, stageId, attempt = 1, baseHead }) {
  await ensureGitExclude(repoRoot);
  const worktreesBase = path.join(repoRoot, WORKTREE_DIR_NAME);
  await mkdir(worktreesBase, { recursive: true });
  const slug = `${safeSlug(batchId)}-${safeSlug(stageId)}-a${attempt}-${Date.now().toString(36).slice(-4)}`;
  const worktreePath = path.join(worktreesBase, slug);
  const branch = `mentor-wt/${slug}`;

  const added = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseHead]);
  if (!added.ok) {
    return {
      ok: false,
      reason: "worktree-create-failed",
      detail: added.stderr.trim() || added.stdout.trim(),
    };
  }
  return {
    ok: true,
    repoRoot,
    baseHead,
    worktreePath,
    branch,
  };
}

/** 采集隔离 worktree 中的全部改动并提交到临时分支（不触碰主分支）。 */
export async function captureWorktreeDiff({ worktreePath, stageId, attempt = 1 }) {
  const add = await runGit(worktreePath, ["add", "-A"]);
  if (!add.ok) {
    return { ok: false, reason: "worktree-stage-failed", detail: add.stderr.trim() };
  }
  const names = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
  const changedFiles = names.ok
    ? names.stdout.split(/\r?\n/u).map((s) => s.trim()).filter(Boolean)
    : [];
  if (!changedFiles.length) {
    return { ok: true, hasChanges: false, changedFiles: [], diffStat: "", patch: "", commitSha: null };
  }
  const statRes = await runGit(worktreePath, ["diff", "--cached", "--stat"]);
  const patchRes = await runGit(worktreePath, ["diff", "--cached", "--binary"]);
  if (!patchRes.ok) {
    return { ok: false, reason: "worktree-diff-failed", detail: patchRes.stderr.trim() };
  }
  const commit = await runGit(worktreePath, [
    "-c", "user.name=dsh-mentor",
    "-c", "user.email=mentor@local",
    "commit", "--no-verify", "--no-gpg-sign", "-m", `mentor-wt: ${stageId} attempt ${attempt}`,
  ]);
  if (!commit.ok) {
    return {
      ok: false,
      reason: "worktree-commit-failed",
      detail: commit.stderr.trim() || commit.stdout.trim() || "临时分支提交失败",
      preserveWorktree: true,
    };
  }
  const rev = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
  if (!rev.ok || !rev.stdout.trim()) {
    return {
      ok: false,
      reason: "worktree-rev-failed",
      detail: rev.stderr.trim() || "无法读取临时分支提交哈希",
      preserveWorktree: true,
    };
  }
  return {
    ok: true,
    hasChanges: true,
    changedFiles,
    diffStat: statRes.stdout.trim(),
    patch: patchRes.stdout,
    commitSha: rev.stdout.trim(),
  };
}

/** 检查指定 worktree 是否仍有未提交或未合入的本地改动，用于失败兜底保护。 */
export async function hasWorktreeChanges(worktreePath, baseHead) {
  const status = await runGit(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) return true; // fail-safe: 无法判定时视为有改动，禁止强删
  if (status.stdout.trim().length > 0) return true;
  if (baseHead) {
    const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
    if (!head.ok || head.stdout.trim() !== baseHead) return true;
  }
  return false;
}

/**
 * 顺序合并闸门：
 *   1. 重新校验主仓库 HEAD === baseHead（防基线漂移）；
 *   2. 逐个用 `git apply --check --3way` 预检并应用补丁到主工作区；
 *   3. 任一冲突立即中止后续合并，已冲突分支保留供人工/主会话处理。
 */
export async function mergeWorktreeSequential({ repoRoot, baseHead, items = [], canMerge = null }) {
  const results = [];
  if (typeof canMerge === "function" && !canMerge()) {
    for (const item of items) {
      results.push({
        stageId: item.stageId,
        branch: item.branch,
        status: "aborted-task-inactive",
        keepBranch: Boolean(item.hasChanges),
        detail: "任务已暂停、归档或计划变更，已停止合入并保留隔离分支",
      });
    }
    return { ok: false, reason: "task-inactive", results };
  }
  const headNow = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!headNow.ok || headNow.stdout.trim() !== baseHead) {
    for (const item of items) {
      results.push({
        stageId: item.stageId,
        branch: item.branch,
        status: "head-drifted",
        keepBranch: Boolean(item.hasChanges),
        detail: `主仓库 HEAD 已从 ${baseHead.slice(0, 8)} 漂移至 ${(headNow.stdout || "").trim().slice(0, 8) || "unknown"}，已停止自动合入并保留分支 ${item.branch}`,
      });
    }
    return { ok: false, reason: "head-drifted", results };
  }

  let halted = false;
  let haltReason = null;
  for (const item of items) {
    if (!item.hasChanges || !item.patch) {
      results.push({ stageId: item.stageId, branch: item.branch, status: "no-changes", keepBranch: false });
      continue;
    }
    if (halted) {
      results.push({
        stageId: item.stageId,
        branch: item.branch,
        status: haltReason === "task-inactive" ? "aborted-task-inactive" : "skipped-after-conflict",
        keepBranch: true,
        detail: haltReason === "task-inactive"
          ? `任务已停止，分支 ${item.branch} 已保留`
          : `因前置阶段合并冲突而暂停合入，分支 ${item.branch} 已保留`,
      });
      continue;
    }
    if (typeof canMerge === "function" && !canMerge()) {
      halted = true;
      haltReason = "task-inactive";
      results.push({
        stageId: item.stageId,
        branch: item.branch,
        status: "aborted-task-inactive",
        keepBranch: true,
        detail: `应用补丁前检测到任务已停止，已终止合入并保留分支 ${item.branch}`,
      });
      continue;
    }
    const patchFile = path.join(tmpdir(), `mentor-wt-${safeSlug(item.stageId)}-${Date.now().toString(36)}.patch`);
    try {
      await writeFile(patchFile, item.patch, "utf8");
      // 必须用纯 --check（不带 --3way）：--3way 遇冲突会直接向工作区写冲突标记；
      // 纯 --check 完全只读，冲突时零污染主工作区并保留隔离分支。
      const dryRun = await runGit(repoRoot, ["apply", "--check", patchFile]);
      if (!dryRun.ok) {
        halted = true;
        haltReason = "merge-conflict";
        results.push({
          stageId: item.stageId,
          branch: item.branch,
          status: "conflict",
          keepBranch: true,
          detail: dryRun.stderr.trim() || "补丁预检冲突，已停止合入并保留隔离分支",
        });
        continue;
      }
      if (typeof canMerge === "function" && !canMerge()) {
        halted = true;
        haltReason = "task-inactive";
        results.push({
          stageId: item.stageId,
          branch: item.branch,
          status: "aborted-task-inactive",
          keepBranch: true,
          detail: `应用补丁前检测到任务已停止，已终止合入并保留分支 ${item.branch}`,
        });
        continue;
      }
      const applied = await runGit(repoRoot, ["apply", patchFile]);
      if (!applied.ok) {
        halted = true;
        haltReason = "merge-conflict";
        results.push({
          stageId: item.stageId,
          branch: item.branch,
          status: "conflict",
          keepBranch: true,
          detail: applied.stderr.trim() || "补丁应用冲突，已保留隔离分支",
        });
        continue;
      }
      results.push({
        stageId: item.stageId,
        branch: item.branch,
        status: "merged",
        keepBranch: false,
        changedFiles: item.changedFiles ?? [],
      });
    } finally {
      try { await unlink(patchFile); } catch {}
    }
  }

  return {
    ok: !halted,
    reason: halted ? (haltReason || "merge-conflict") : null,
    results,
  };
}

/**
 * Windows 安全清理：仅通过 Git 原生命令卸载 worktree 与清理分支（带短重试，不盲目 rm -rf）。
 */
export async function cleanupWorktree({ repoRoot, worktreePath, branch, keepBranch = false }) {
  let removed = false;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (res.ok) {
      removed = true;
      break;
    }
    lastError = res.stderr.trim() || res.stdout.trim();
    if (/is not a working tree/iu.test(lastError)) {
      removed = true;
      break;
    }
    await sleep(150 * (attempt + 1));
  }
  await runGit(repoRoot, ["worktree", "prune"]);

  let branchDeleted = false;
  if (!keepBranch && branch) {
    const del = await runGit(repoRoot, ["branch", "-D", branch]);
    branchDeleted = del.ok;
  }
  return { ok: removed, branchDeleted, keepBranch, ...(removed ? {} : { error: lastError }) };
}
