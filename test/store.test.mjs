import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertStateShape,
  atomicWriteJson,
  fileFingerprint,
  fingerprintOf,
  readState,
  writeState,
} from "../src/persist/store.js";
import { ERR, MentorError } from "../src/errors.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mentor-store-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sampleState(overrides = {}) {
  return {
    id: "t1",
    revision: 1,
    phase: "planning",
    criteria: [],
    stages: [],
    nodeRuns: [],
    findings: [],
    reviews: [],
    ...overrides,
  };
}

test("atomicWriteJson 写入后可原样读回", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    const data = { a: 1, b: ["x", "y"], 中文: "值" };
    await atomicWriteJson(file, data);
    const raw = await fs.readFile(file, "utf8");
    assert.deepEqual(JSON.parse(raw), data);
  });
});

test("atomicWriteJson 不留临时文件", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    await atomicWriteJson(file, { a: 1 });
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["state.json"]);
  });
});

test("atomicWriteJson 自动创建父目录", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "nested", "deep", "state.json");
    await atomicWriteJson(file, { ok: true });
    assert.equal(await fileExists(file), true);
  });
});

test("readState 文件不存在 → created=true 且 state 为 null", async () => {
  await withTempDir(async (dir) => {
    const r = await readState(path.join(dir, "missing.json"));
    assert.equal(r.state, null);
    assert.equal(r.created, true);
    assert.equal(r.corrupt, false);
  });
});

test("readState 正常文件返回解析结果与指纹", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    const state = sampleState();
    await atomicWriteJson(file, state);
    const r = await readState(file, { validate: assertStateShape });
    assert.equal(r.corrupt, false);
    assert.equal(r.state.id, "t1");
    assert.ok(r.fingerprint.sha256.length === 64);
  });
});

test("readState 遇到损坏 JSON → 移入 quarantine 且 corrupt=true", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    const quarantine = path.join(dir, "quarantine");
    await fs.writeFile(file, "{ this is not json", "utf8");

    const r = await readState(file, {
      quarantineDir: quarantine,
      validate: assertStateShape,
    });

    assert.equal(r.corrupt, true);
    assert.equal(r.state, null);
    assert.ok(r.quarantinedTo, "应返回隔离文件路径");

    // 原文件已被移走
    assert.equal(await fileExists(file), false);
    // 隔离文件存在且保留原始内容
    const moved = await fs.readFile(r.quarantinedTo, "utf8");
    assert.equal(moved, "{ this is not json");
  });
});

test("readState 结构不合法（缺字段）也算损坏", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    const quarantine = path.join(dir, "quarantine");
    await fs.writeFile(file, JSON.stringify({ id: "x" }), "utf8");

    const r = await readState(file, {
      quarantineDir: quarantine,
      validate: assertStateShape,
    });
    assert.equal(r.corrupt, true);
    assert.ok(r.quarantinedTo);
  });
});

test("writeState 正常写入并返回状态", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    const out = await writeState(file, sampleState());
    assert.equal(out.revision, 1);
    const back = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(back.id, "t1");
  });
});

test("writeState expectedRevision 匹配时通过", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    await writeState(file, sampleState({ revision: 3 }));
    const out = await writeState(file, sampleState({ revision: 4 }), {
      expectedRevision: 3,
    });
    assert.equal(out.revision, 4);
  });
});

test("writeState expectedRevision 不匹配 → E_REVISION_CONFLICT", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    await writeState(file, sampleState({ revision: 5 }));
    await assert.rejects(
      () => writeState(file, sampleState({ revision: 6 }), { expectedRevision: 3 }),
      (e) => e instanceof MentorError && e.code === ERR.REVISION_CONFLICT,
    );
  });
});

test("writeState 文件不存在时 expectedRevision=0 可用", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "new.json");
    const out = await writeState(file, sampleState({ revision: 1 }), {
      expectedRevision: 0,
    });
    assert.equal(out.revision, 1);
  });
});

test("writeState 拒绝缺少 revision 的状态", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    await assert.rejects(
      () => writeState(file, { id: "x" }),
      (e) => e instanceof MentorError && e.code === ERR.INTERNAL,
    );
  });
});

test("fingerprintOf 对相同内容稳定、对不同内容不同", () => {
  const a = fingerprintOf("hello");
  const b = fingerprintOf("hello");
  const c = fingerprintOf("hello!");
  assert.deepEqual(a, b);
  assert.notEqual(a.sha256, c.sha256);
  assert.equal(a.bytes, 5);
});

test("fileFingerprint 带 mtime，读不到返回 null", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "state.json");
    assert.equal(await fileFingerprint(file), null);
    await atomicWriteJson(file, sampleState());
    const fp = await fileFingerprint(file);
    assert.ok(fp);
    assert.equal(typeof fp.mtimeMs, "number");
    assert.equal(fp.sha256.length, 64);
  });
});

test("assertStateShape 逐项检查必需字段", () => {
  const okState = sampleState();
  assert.doesNotThrow(() => assertStateShape(okState));

  const cases = [
    [null, "状态必须是对象"],
    [{}, "缺少 id"],
    [{ id: "x" }, "缺少 revision"],
    [{ id: "x", revision: 1 }, "缺少 phase"],
    [{ id: "x", revision: 1, phase: "planning" }, "criteria 必须是数组"],
  ];
  for (const [bad, expected] of cases) {
    assert.throws(
      () => assertStateShape(bad),
      (e) => e instanceof MentorError && e.message === expected,
      `期望拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
