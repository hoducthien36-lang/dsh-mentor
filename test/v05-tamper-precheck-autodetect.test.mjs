import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanDiffForTampering, isTestFilePath } from "../src/runtime/tamper-scan.js";
import { runAutoSyntaxPrechecks, detectSuggestedPrechecks } from "../src/runtime/prechecks.js";
import { buildSimpleUnifiedDiff } from "../src/runtime/workspace-diff.js";

test("V05-T1: 防改测试硬拦截 4 类高置信作弊（.only / 整删测试 / exit(0) / 断言归零）", () => {
  assert.equal(isTestFilePath("test/auth.test.mjs"), true);
  assert.equal(isTestFilePath("tests/test_api.py"), true);
  assert.equal(isTestFilePath("pkg/service_test.go"), true);
  assert.equal(isTestFilePath("src/index.js"), false);

  // 1. 新增 .only
  const diffOnly = buildSimpleUnifiedDiff(
    "test/math.test.mjs",
    'test("a", () => { assert.equal(1, 1); });\n',
    'test.only("a", () => { assert.equal(1, 1); });\n',
  ).text;
  const r1 = scanDiffForTampering({ unifiedDiff: diffOnly });
  assert.equal(r1.ok, false);
  assert.equal(r1.blocks[0].rule, "TEST_ONLY_ADDED");

  // 2. 新增 process.exit(0)
  const diffExit = buildSimpleUnifiedDiff(
    "test/math.test.mjs",
    'test("a", () => { assert.equal(1, 1); });\n',
    'test("a", () => { process.exit(0); });\n',
  ).text;
  const r2 = scanDiffForTampering({ unifiedDiff: diffExit });
  assert.equal(r2.ok, false);
  assert.ok(r2.blocks.some((b) => b.rule === "TEST_EXIT_ZERO_ADDED"));

  // 3. 未声明整文件删除测试
  const r3 = scanDiffForTampering({
    changedFiles: [{ path: "test/legacy.test.mjs", status: "deleted" }],
    testChangePolicy: "none",
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.blocks[0].rule, "TEST_FILE_DELETED");

  // 3b. 显式声明 testChangePolicy=remove → 降级为软提醒，不误杀合法删除
  const r3b = scanDiffForTampering({
    changedFiles: [{ path: "test/legacy.test.mjs", status: "deleted" }],
    testChangePolicy: "remove",
  });
  assert.equal(r3b.ok, true);
  assert.equal(r3b.blocks.length, 0);
  assert.equal(r3b.warnings[0].rule, "TEST_FILE_DELETED_DECLARED");

  // 4. 删除严格断言导致整文件有效断言归零
  const afterWiped = 'test("empty", () => {\n  console.log("ok");\n});\n';
  const diffWiped = buildSimpleUnifiedDiff(
    "test/calc.test.mjs",
    'test("empty", () => {\n  assert.equal(calc(1), 2);\n});\n',
    afterWiped,
  ).text;
  const r4 = scanDiffForTampering({
    unifiedDiff: diffWiped,
    readCurrentFile: () => afterWiped,
  });
  assert.equal(r4.ok, false);
  assert.ok(r4.blocks.some((b) => b.rule === "TEST_ASSERTIONS_WIPED"));
});

test("V05-T2: 软告警识别弱化断言 / .skip / lint 绕过 / 空 catch，且不误阻断合法变更", () => {
  const diffWeak = buildSimpleUnifiedDiff(
    "test/user.spec.ts",
    'it("ok", () => {\n  expect(user.age).toBe(42);\n});\n',
    'it.skip("ok", () => {\n  // eslint-disable-next-line\n  try { expect(user.age).toBeDefined(); } catch {}\n});\n',
  ).text;
  const res = scanDiffForTampering({ unifiedDiff: diffWeak });
  assert.equal(res.ok, true, "软信号不得一刀切硬拦，应交由审查员与人类核对");
  const rules = new Set(res.warnings.map((w) => w.rule));
  assert.ok(rules.has("TEST_SKIP_ADDED"));
  assert.ok(rules.has("ASSERT_WEAKENED"));
  assert.ok(rules.has("LINT_SUPPRESSION_ADDED"));
  assert.ok(rules.has("BROAD_CATCH_SWALLOW"));
});

test("V05-P1: 零配置安全语法检查仅校验改动 .js/.json，且只读探测 package.json 绝不执行恶意脚本", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mentor-v05-pre-"));
  const rceMarker = path.join(dir, "npm-rce-canary.txt");
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      name: "untrusted-demo",
      scripts: {
        test: `node -e "require('fs').writeFileSync(${JSON.stringify(rceMarker)}, 'RCE')"`,
        lint: "eslint .",
      },
    }, null, 2), "utf8");
    await writeFile(path.join(dir, "good.js"), "export const ok = 1;\n", "utf8");
    await writeFile(path.join(dir, "bad.js"), "export function broken( {\n", "utf8");
    await writeFile(path.join(dir, "broken.json"), "{ invalid json", "utf8");

    // 1. 只读探测仅返回建议，绝不执行恶意 scripts.test
    const suggestions = await detectSuggestedPrechecks(dir);
    assert.ok(suggestions.some((s) => s.command === "npm run test" && s.requiresConfirmation === true));
    let executed = false;
    try { await stat(rceMarker); executed = true; } catch {}
    assert.equal(executed, false, "只读探测绝不能执行 package.json 里的脚本");

    // 2. 合法改动文件通过
    const okRes = await runAutoSyntaxPrechecks({
      workspaceRoot: dir,
      changedFiles: [{ path: "good.js", status: "modified" }],
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.passed, 1);

    // 3. 语法错误的 JS + 非法 JSON 均被拦截
    const badRes = await runAutoSyntaxPrechecks({
      workspaceRoot: dir,
      changedFiles: [
        { path: "bad.js", status: "modified" },
        { path: "broken.json", status: "modified" },
      ],
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.failed, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
