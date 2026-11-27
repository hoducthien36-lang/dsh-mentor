/**
 * 持久化层（SPEC §5）。
 *
 * 三条硬要求：
 *   1. 原子写：写 .tmp → fsync → rename，避免半截文件
 *   2. 损坏不静默重建：先移入 quarantine/ 再新建，并把隔离路径返回
 *   3. revision 冲突检测：写入前比对 expectedRevision
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ERR, MentorError } from "../errors.js";

/**
 * 原子写入任意可序列化对象为 JSON。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {unknown} data
 */
export async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;

  let handle;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(text, "utf8");
    // 落盘后再改名，保证 rename 之后读到的是完整内容
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }

  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // rename 失败要清掉临时文件，避免堆积
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * 读取状态文件。
 *
 * - 文件不存在：返回 { state: null, created: true }，由调用方决定初始化
 * - 解析/校验失败：移入 quarantine 后返回 { state: null, corrupt: true, quarantinedTo }
 * - 正常：返回 { state, fingerprint }
 *
 * @param {string} filePath
 * @param {{quarantineDir?:string, validate?:(v:any)=>void}} [options]
 */
export async function readState(filePath, options = {}) {
  const { quarantineDir, validate } = options;

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, state: null, created: true, corrupt: false, quarantinedTo: null };
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof validate === "function") validate(parsed);
    return {
      ok: true,
      state: parsed,
      created: false,
      corrupt: false,
      quarantinedTo: null,
      fingerprint: fingerprintOf(raw),
    };
  } catch (err) {
    let target = null;
    let quarantineError;
    try {
      if (quarantineDir) target = await quarantineFile(filePath, quarantineDir);
    } catch (error) {
      quarantineError = String(error?.message ?? error);
    }
    return {
      ok: false,
      state: null,
      created: false,
      corrupt: true,
      quarantinedTo: target,
      ...(quarantineError !== undefined ? { quarantineFailed: true, quarantineError } : {}),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function quarantineFile(filePath, quarantineDir) {
  await fs.mkdir(quarantineDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(filePath);
  const target = path.join(quarantineDir, `${base}.${stamp}.${process.pid}.${randomUUID()}.corrupt`);
  await fs.rename(filePath, target);
  return target;
}

/**
 * 带 revision 检查的写入。
 *
 * @param {string} filePath
 * @param {object} state 必须含 revision
 * @param {{expectedRevision?:number}} [options]
 */
export async function writeState(filePath, state, options = {}) {
  if (!state || typeof state.revision !== "number") {
    throw new MentorError(
      ERR.INTERNAL,
      "writeState 需要带数字 revision 的状态对象",
    );
  }

  const { expectedRevision } = options;
  if (expectedRevision !== undefined) {
    const current = await readState(filePath);
    const currentRevision = current.state ? current.state.revision : 0;
    if (currentRevision !== expectedRevision) {
      throw new MentorError(
        ERR.REVISION_CONFLICT,
        `revision 冲突：期望 ${expectedRevision}，实际 ${currentRevision}`,
        { expectedRevision, currentRevision },
      );
    }
  }

  await atomicWriteJson(filePath, state);
  return state;
}

/** 内容指纹：字节数与 sha256（用于"改前/改后"可比对） */
export function fingerprintOf(text) {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

/** 对文件取指纹（含 mtime），读不到返回 null */
export async function fileFingerprint(filePath) {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    return { ...fingerprintOf(raw), mtimeMs: stat.mtimeMs };
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 默认校验器：状态对象必须满足的最小形状。
 * 供 readState 的 validate 选项直接使用。
 */
export function assertStateShape(state) {
  const fail = (msg) => {
    throw new MentorError(ERR.STATE_CORRUPT, msg);
  };
  if (!state || typeof state !== "object") fail("状态必须是对象");
  if (typeof state.id !== "string" || state.id.length === 0) fail("缺少 id");
  if (typeof state.revision !== "number") fail("缺少 revision");
  if (typeof state.phase !== "string") fail("缺少 phase");
  if (!Array.isArray(state.criteria)) fail("criteria 必须是数组");
  if (!Array.isArray(state.stages)) fail("stages 必须是数组");
  if (!Array.isArray(state.nodeRuns)) fail("nodeRuns 必须是数组");
  if (!Array.isArray(state.findings)) fail("findings 必须是数组");
  if (!Array.isArray(state.reviews)) fail("reviews 必须是数组");
}
