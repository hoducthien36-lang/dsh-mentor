/**
 * 宿主消息构造器解析（P0 修复，2026-11-07）
 *
 * 背景：`lib/index.js` 原有 4 处 `await import("@deepseek-ai/dsh-llm")`
 * （spawnReviewer / wakeMain / runDelegation / continueMain），另有
 * `src/runtime/continuation.js` 一处。ESM 动态 import 的裸 specifier 从
 * **本插件目录**开始解析，而 `@deepseek-ai/dsh-llm` 只存在于宿主 asar 内，
 * 插件 node_modules 里没有 → 真机一律失败：
 *
 *   Cannot find package '@deepseek-ai/dsh-llm' imported from
 *   <plugin-root>/lib/index.js
 *
 * 后果：计划审查、阶段审查、完成审查、自动唤醒、并行派发、续跑提示
 * 六条链路全部断在第一步，任务停在 reviewing 且无路可走。
 *
 * 本模块按可信度递减提供三级解析，并在结果里标明用了哪一级：
 *
 *   1. package   直接 import 成功（隔离 profile 里装了该包时）
 *   2. resolved  从宿主入口 / 可执行文件位置 createRequire 解析到绝对路径后 import
 *   3. fallback  本地构造等价 message（结构对齐 dsh-llm 的 createMessage：
 *                { ...input, id, role:"user" } 并冻结）
 *
 * fallback 的取舍：它证明不了宿主一定接受，所以调用方把它写进
 * `reviewDispatch.messageSource` / `wake.messageSource`，让「降级」在状态里可见，
 * 而不是静默当成正常路径。
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@deepseek-ai/dsh-llm";

/** 本地等价实现：字段与 dsh-llm 的 createUserMessage 保持一致 */
export function createFallbackUserMessage(input = {}) {
  return Object.freeze({
    ...structuredClone({ content: [], ...input }),
    id: randomUUID(),
    role: "user",
  });
}

/** 从宿主可执行文件 / 入口脚本位置推候选解析基点 */
function candidateBases() {
  const bases = new Set();
  const push = (p) => {
    if (typeof p !== "string" || !p) return;
    // argv[1] 是文件，createRequire 需要文件或目录路径：文件直接可用
    bases.add(p);
  };

  // 宿主 app 入口（Electron 主进程 / ELECTRON_RUN_AS_NODE 下的 cli.js）
  push(process.argv?.[1]);
  // 兜底：可执行文件同级的 resources/app.asar
  const execDir = path.dirname(process.execPath ?? "");
  push(path.join(execDir, "resources", "app.asar", "dsh", "noop.js"));
  push(path.join(execDir, "resources", "app.asar", "noop.js"));
  // 当前工作目录（隔离 profile 场景下可能装过该包）
  push(path.join(process.cwd(), "noop.js"));

  return [...bases].filter((p) => {
    try {
      return typeof p === "string" && p.length > 0;
    } catch {
      return false;
    }
  });
}

async function tryPackageImport() {
  try {
    const mod = await import(PACKAGE);
    if (typeof mod?.createUserMessage === "function") {
      return { createUserMessage: mod.createUserMessage, source: "package" };
    }
  } catch {
    /* 落到下一级 */
  }
  return null;
}

async function tryResolvedImport() {
  for (const base of candidateBases()) {
    let resolved;
    try {
      const req = createRequire(base);
      resolved = req.resolve(PACKAGE);
    } catch {
      continue;
    }
    try {
      const mod = await import(pathToFileURL(resolved).href);
      if (typeof mod?.createUserMessage === "function") {
        return { createUserMessage: mod.createUserMessage, source: "resolved", resolvedFrom: resolved };
      }
    } catch {
      /* 该基点解析到了但加载失败：继续下一个 */
    }
  }
  return null;
}

let cached = null;
let inflight = null;

/**
 * 解析消息构造器。结果缓存（进程内一次即可）。
 *
 * @returns {Promise<{createUserMessage:Function, source:"package"|"resolved"|"fallback", resolvedFrom?:string}>}
 */
export async function loadCreateUserMessage() {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const found = (await tryPackageImport()) ?? (await tryResolvedImport());
    cached = found ?? { createUserMessage: createFallbackUserMessage, source: "fallback" };
    if (cached.source === "fallback") {
      process.stderr.write(
        `[dsh-mentor] ${PACKAGE} 不可解析，改用本地 message 构造（source=fallback）\n`,
      );
    } else {
      process.stderr.write(
        `[dsh-mentor] message 构造取到 ${cached.source}${cached.resolvedFrom ? "：" + cached.resolvedFrom : ""}\n`,
      );
    }
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 同步取已解析结果（未解析时返回 fallback），供不便 await 的调用点使用 */
export function getCreateUserMessageSync() {
  return cached ?? { createUserMessage: createFallbackUserMessage, source: "fallback" };
}

/** 供测试重置缓存 */
export function resetHostMessageCache() {
  cached = null;
  inflight = null;
}
