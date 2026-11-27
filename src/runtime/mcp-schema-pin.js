/**
 * MCP 工具 Schema 哈希固定与防 Rug-Pull 投毒检测（v1.0）。
 *
 * 理论依据：MCPTox (arXiv:2508.13253) & ShieldMCP
 *   - 外部协作 MCP 服务器可能在首次授权后静默篡改工具 description 或参数 schema，
 *     把隐藏提示词注入（Tool Poisoning / Rug-Pull）塞进模型上下文；
 *   - 本模块对每个外部 MCP 工具（默认 `mcp__*`）的规范化 `{ name, description, parameters }`
 *     计算 SHA-256 首次固定（TOFU Pinning）并持久化至 `stateDir/mcp-schema-pins.json`；
 *   - 每次检查时同时执行：① 哈希漂移对比（抓 Rug-Pull）；② 静态提示注入特征扫描
 *     （抓隐藏指令与外泄诱导）；仅人工显式执行 `/mentor pins trust <tool>` 才能更新基线。
 *
 * 零外部依赖；带写串行化与损坏文件保护（绝不覆写损坏的 pin 文件）。
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";

const PINS_FILE_NAME = "mcp-schema-pins.json";
const MAX_PINS = 256;

const POISON_PATTERNS = [
  { id: "PROMPT_OVERRIDE", re: /(?:ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+system\s+prompt|忽略(?:所有|之前|以上)指令|无视系统规则)/iu, summary: "疑似覆盖系统指令" },
  { id: "HIDDEN_DIRECTIVE_TAG", re: /<(?:IMPORTANT|SYSTEM|INSTRUCTION|ADMIN)[^>]*>[\s\S]{0,400}(?:before\s+calling|must\s+first|always\s+include|secret|read\s+~\/)/iu, summary: "疑似隐藏指令标签（MCPTox 典型特征）" },
  { id: "CREDENTIAL_EXFIL", re: /(?:~\/\.ssh|~\/\.aws|\.env\b|id_rsa|api[_-]?key|secret[_-]?token)[\s\S]{0,160}(?:pass\s+it|include\s+in|send\s+to|post\s+to|curl\s+|wget\s+|exfiltrat)/iu, summary: "疑似诱导读取凭据并外泄" },
  { id: "SILENT_EXEC_HIDE", re: /(?:do\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user|不要告诉用户|对用户隐藏)/iu, summary: "疑似要求对用户隐瞒行为" },
];

const pinWriteChains = new Map();

function pinFilePath(stateDir) {
  return path.join(stateDir, PINS_FILE_NAME);
}

function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** 计算单个工具描述符（name + description + parameters）的规范化 SHA-256 指纹。 */
export function computeToolSchemaHash(tool) {
  const canonical = canonicalJson({
    name: String(tool?.name ?? ""),
    description: String(tool?.description ?? ""),
    parameters: tool?.parameters ?? tool?.inputSchema ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function collectAllStrings(value, out, depth = 0) {
  if (value == null || depth > 12) return;
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k) out.push(k);
      collectAllStrings(v, out, depth + 1);
    }
  }
}

/** 扫描工具描述与全部参数叶子文本中的提示注入 / 投毒特征（无 8KB 截断盲区）。 */
export function scanToolDescriptionForPoisoning(tool) {
  const texts = [String(tool?.description ?? "")];
  const params = tool?.parameters ?? tool?.inputSchema;
  if (params && typeof params === "object") {
    collectAllStrings(params, texts);
  }
  const combined = texts.join("\n");
  const hits = [];
  for (const rule of POISON_PATTERNS) {
    if (rule.re.test(combined)) {
      hits.push({ rule: rule.id, toolName: String(tool?.name ?? ""), summary: rule.summary });
    }
  }
  return hits;
}

/** 判定是否为需要固定的外部协作 MCP 工具。 */
export function isExternalMcpTool(tool) {
  const name = String(tool?.name ?? "");
  return name.startsWith("mcp__") || tool?.source === "mcp";
}

function toNullProtoMap(obj) {
  const out = Object.create(null);
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = v;
    }
  }
  return out;
}

async function readPinsStore(stateDir) {
  if (!stateDir) return { version: 1, pins: Object.create(null), readError: null };
  const file = pinFilePath(stateDir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.pins !== "object") {
      return { version: 1, pins: Object.create(null), readError: "invalid-pins-shape" };
    }
    return { version: 1, pins: toNullProtoMap(parsed.pins), readError: null };
  } catch (err) {
    if (err?.code === "ENOENT") return { version: 1, pins: Object.create(null), readError: null };
    return { version: 1, pins: Object.create(null), readError: String(err?.message ?? err) };
  }
}

async function writePinsStore(stateDir, store) {
  if (!stateDir) return;
  const file = pinFilePath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), pins: store.pins }, null, 2), "utf8");
  await rename(tmp, file);
}

function enqueuePinWrite(stateDir, fn) {
  const key = process.platform === "win32" ? path.resolve(stateDir || ".").toLowerCase() : path.resolve(stateDir || ".");
  const prev = pinWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  pinWriteChains.set(key, settled);
  void settled.then(() => {
    if (pinWriteChains.get(key) === settled) pinWriteChains.delete(key);
  });
  return next;
}

/**
 * 批量校验并固定外部 MCP 工具 Schema 哈希。
 *
 * @param {{
 *   stateDir?: string,
 *   tools: Array<{ name: string, description?: string, parameters?: object, inputSchema?: object, source?: string }>,
 *   onlyExternal?: boolean,
 * }} params
 */
export async function verifyAndPinMcpTools({
  stateDir = "",
  tools = [],
  onlyExternal = true,
} = {}) {
  const list = (Array.isArray(tools) ? tools : [])
    .filter((t) => t && typeof t.name === "string" && t.name.trim())
    .filter((t) => (!onlyExternal || isExternalMcpTool(t)));

  if (!list.length) {
    return { ok: true, checked: 0, pinned: [], verified: [], alerts: [] };
  }

  return enqueuePinWrite(stateDir, async () => {
    const store = await readPinsStore(stateDir);
    if (store.readError) {
      return {
        ok: false,
        reason: "pins-store-corrupt",
        message: `MCP 固定表读取异常（${store.readError}），为防覆写已中止更新`,
        checked: 0,
        pinned: [],
        verified: [],
        alerts: [{ kind: "STORE_CORRUPT", summary: store.readError }],
      };
    }

    const pinned = [];
    const verified = [];
    const alerts = [];
    let dirty = false;
    const now = Date.now();

    for (const tool of list) {
      const hash = computeToolSchemaHash(tool);
      const poisonHits = scanToolDescriptionForPoisoning(tool);
      for (const hit of poisonHits) {
        alerts.push({
          kind: "TOOL_POISONING",
          severity: "blocking",
          toolName: tool.name,
          rule: hit.rule,
          summary: `外部工具 ${tool.name} 描述命中投毒特征（${hit.summary}）`,
          hash: hash.slice(0, 16),
        });
      }

      const existing = Object.hasOwn(store.pins, tool.name) ? store.pins[tool.name] : null;
      if (!existing) {
        // 首次发现即命中投毒特征：绝不自动固定为可信基线！
        if (poisonHits.length > 0) {
          continue;
        }
        if (Object.keys(store.pins).length < MAX_PINS) {
          store.pins[tool.name] = {
            name: tool.name,
            sha256: hash,
            pinnedAt: now,
            lastSeenAt: now,
            descriptionPreview: String(tool.description ?? "").slice(0, 120),
          };
          dirty = true;
          pinned.push({ name: tool.name, sha256: hash.slice(0, 16) });
        } else {
          alerts.push({
            kind: "PIN_CAPACITY_EXCEEDED",
            severity: "warning",
            toolName: tool.name,
            summary: `MCP 固定表已达上限（${MAX_PINS}），未能固定外部工具 ${tool.name}`,
          });
        }
      } else if (existing.sha256 !== hash) {
        alerts.push({
          kind: "RUG_PULL_DRIFT",
          severity: "blocking",
          toolName: tool.name,
          previousHash: String(existing.sha256).slice(0, 16),
          currentHash: hash.slice(0, 16),
          summary: `外部工具 ${tool.name} 的 Schema/描述较首次固定时发生篡改漂移（${String(existing.sha256).slice(0, 8)} → ${hash.slice(0, 8)}），如为合法升级请人工执行 /mentor pins trust ${tool.name}`,
        });
      } else {
        existing.lastSeenAt = now;
        verified.push({ name: tool.name, sha256: hash.slice(0, 16) });
      }
    }

    if (dirty && stateDir) {
      await writePinsStore(stateDir, store);
    }

    return {
      ok: alerts.length === 0,
      checked: list.length,
      pinned,
      verified,
      alerts,
    };
  });
}

/** 人工显式信任并更新某个 MCP 工具的新 Schema 哈希（用于合法版本升级）。 */
export async function trustMcpToolPin(stateDir, tool) {
  if (!stateDir) return { ok: false, reason: "no-state-dir", message: "未启用持久化 stateDir，无法保存工具固定哈希" };
  if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
    return { ok: false, reason: "invalid-tool", message: "缺少有效的工具定义" };
  }
  return enqueuePinWrite(stateDir, async () => {
    const store = await readPinsStore(stateDir);
    if (store.readError) {
      return { ok: false, reason: "pins-store-corrupt", message: `固定表损坏（${store.readError}），拒绝覆写` };
    }
    const hash = computeToolSchemaHash(tool);
    const now = Date.now();
    store.pins[tool.name] = {
      name: tool.name,
      sha256: hash,
      pinnedAt: now,
      lastSeenAt: now,
      trustedByHuman: true,
      descriptionPreview: String(tool.description ?? "").slice(0, 120),
    };
    await writePinsStore(stateDir, store);
    return { ok: true, name: tool.name, sha256: hash.slice(0, 16) };
  });
}

/** 列出当前已固定的外部 MCP 工具指纹。 */
export async function listMcpSchemaPins(stateDir) {
  const store = await readPinsStore(stateDir);
  return {
    ok: !store.readError,
    readError: store.readError,
    pins: Object.values(store.pins).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}
