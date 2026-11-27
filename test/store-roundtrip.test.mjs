/**
 * c4 往返测试：中文 evidence 落盘 → 读回，逐字相等。
 *
 * 目的：证明 src/persist/store.js 的 utf8 读写链路没有编码缺陷。
 * 覆盖三层：
 *   1. atomicWriteJson → readState 的基础往返（含中文、emoji、换行、引号）
 *   2. 完整任务形状（含 findings/reviews 里的中文长文本）往返
 *   3. 磁盘字节确实是 UTF-8（直接读 Buffer 与原文 utf8 编码比对）
 *
 * 所有夹具均在独立临时目录生成，不读取实际任务状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteJson, readState, assertStateShape } from "../src/persist/store.js";

/** 每个用例独立的临时目录，避免互相污染 */
async function tmpFile(name) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "mentor-rt-"));
  return path.join(dir, `${name}.json`);
}

const CN_TEXT = [
  "## s3 交付：并行派发接线（校验 → 置 running → 宿主派发 → 回滚）",
  "产物规模：`src/tools/handlers.js` 1,285 行 / 46,946 字节。",
  "**本报告提交 21 条 evidenceRefs，脚本 rows=21 bad=0，逐条对应，无丢弃。**",
  "交接符：`—`、`→`、`✔`、`✖`、`·`、`“引号”`、`「书名」`",
  "表情：🌸 🧠 ✅",
  "混合英文与符号：`E_WORKSPACE_REQUIRED` / `no-live-agent` / {a:1}",
  "全角标点：（），。；：？！",
].join("\n");

test("T1 atomicWriteJson → readState：中文文本逐字往返", async () => {
  const fp = await tmpFile("basic");
  const payload = { revision: 1, text: CN_TEXT, note: "中文键值" };
  await atomicWriteJson(fp, payload);

  const r = await readState(fp);
  assert.equal(r.corrupt, false, "不应被判为损坏");
  assert.equal(r.created, false, "不应被当成新建");
  assert.equal(r.state.text, CN_TEXT, "读回的文本必须与写入逐字相等");
  assert.equal(r.state.note, "中文键值");
});

test("T2 落盘字节确实是 UTF-8：Buffer 与原文 utf8 编码一致", async () => {
  const fp = await tmpFile("bytes");
  await atomicWriteJson(fp, { revision: 1, text: CN_TEXT });

  const onDisk = await fs.readFile(fp); // 原始字节
  const expected = Buffer.from(`${JSON.stringify({ revision: 1, text: CN_TEXT }, null, 2)}\n`, "utf8");
  assert.equal(
    Buffer.compare(onDisk, expected),
    0,
    "磁盘字节必须逐字节等于 UTF-8 编码后的 JSON（不一致说明写盘时换过编码）",
  );

  // 反向证明：若按 GBK 误解，会出现典型乱码字符；这里断言不存在
  const asText = onDisk.toString("utf8");
  assert.ok(asText.includes("并行派发接线"), "读回文本应包含正常中文");
  assert.ok(!/锛|鈥|涓|鏂|鐨/.test(asText), "不应出现 UTF-8 被按 GBK 解码后的典型乱码字符");
});

test("T3 完整任务形状（含中文 evidence）往返后 assertStateShape 通过", async () => {
  const fp = await tmpFile("task");
  const task = {
    id: "task_rt_1",
    revision: 7,
    phase: "reviewing",
    criteria: [{ id: "c1", text: "中文验收项：并行派发要真的派出去" }],
    stages: [{ id: "s1", title: "中文阶段名", criterionIds: ["c1"], dependsOn: [], writePaths: [] }],
    nodeRuns: [
      {
        stageId: "s1",
        attempt: 1,
        status: "reported",
        reports: [{ id: "rep_1", evidence: CN_TEXT, evidenceRefs: [{ file: "src/工具.js", line: 1, snippet: "中文片段" }] }],
      },
    ],
    findings: [{ id: "f_1", severity: "blocking", text: "中文整改项：缺日志证据", status: "open" }],
    reviews: [{ id: "r_1", verdict: "revise", finding: "中文裁决理由" }],
  };
  await atomicWriteJson(fp, task);

  const r = await readState(fp, { validate: assertStateShape });
  assert.equal(r.corrupt, false);
  assert.equal(r.state.nodeRuns[0].reports[0].evidence, CN_TEXT, "evidence 必须逐字相等");
  assert.equal(r.state.criteria[0].text, "中文验收项：并行派发要真的派出去");
  assert.equal(r.state.findings[0].text, "中文整改项：缺日志证据");
  assert.equal(r.state.reviews[0].finding, "中文裁决理由");
  assert.equal(r.state.nodeRuns[0].reports[0].evidenceRefs[0].file, "src/工具.js");
});

test("T4 已有乱码文本照原样保留，不会被二次破坏", async () => {
  // 模拟历史遗留的乱码串（UTF-8 被按 GBK 解过一轮的产物）
  const MOJIBAKE = "## s1 attempt 2锛堜笁鏉℃暣鏀瑰凡閫愭潯 respond锛?";
  const fp = await tmpFile("mojibake");
  await atomicWriteJson(fp, { revision: 1, text: MOJIBAKE });

  const r = await readState(fp);
  assert.equal(r.state.text, MOJIBAKE, "已损坏的字符串应原样保存，读盘代码不做「修复」猜测");
});

test("T5 丰富中文、多阶段与 emoji 任务 UTF-8 精确往返", async (t) => {
  const fp = await tmpFile("rich-task");
  t.after(() => fs.rm(path.dirname(fp), { recursive: true, force: true }));
  const task = {
    id: "任务-中文-🌸", revision: 17, phase: "reviewing", planVersion: 3,
    objective: "多阶段交付与独立审查 ✅", mainSessionId: "主会话-🧠",
    criteria: [{ id: "c1", text: "中文证据完整往返" }, { id: "c2", text: "保留换行、引号与 emoji 🌸" }],
    stages: [
      { id: "s1", title: "采集证据", criterionIds: ["c1"], dependsOn: [] },
      { id: "s2", title: "独立核验 ✅", criterionIds: ["c2"], dependsOn: ["s1"] },
    ],
    nodeRuns: ["s1", "s2"].map((stageId, i) => ({
      stageId, attempt: i + 1, status: "reported",
      reports: [{ id: "报告-" + i, evidence: CN_TEXT,
        evidenceRefs: [{ file: "src/工具.js", line: i + 1, snippet: "中文片段 🌸" }] }],
    })),
    findings: [{ id: "问题-1", text: "补充独立核验记录", status: "open", severity: "blocking" }],
    reviews: [{ id: "审查-1", verdict: "revise", finding: "中文裁决：待补证据 🧠" }],
    reviewJobs: [{ id: "审查任务-2", status: "running", kind: "stage", stageId: "s2" }],
    pendingCheckpoint: { kind: "completion", evidence: CN_TEXT },
  };
  await atomicWriteJson(fp, task);
  const r = await readState(fp, { validate: assertStateShape });
  assert.equal(r.corrupt, false);
  assert.deepEqual(r.state, task);
  assert.deepEqual(await fs.readFile(fp), Buffer.from(`${JSON.stringify(task, null, 2)}\n`, "utf8"));
  const reports = r.state.nodeRuns.flatMap(run => run.reports);
  assert.ok(reports.length > 0);
  const mojibake = /锛|鈥|涓|鏂|鐨|銆|瀹|鍚|鍙|寮|姣|鎵|鍒|鏃|鎴|鍦|缁|璁|閫|閿/;
  for (const report of reports) {
    assert.equal(report.evidence, CN_TEXT);
    assert.ok(!mojibake.test(report.evidence));
  }
  assert.ok(reports.some(report => /[\u4e00-\u9fa5]{4,}/.test(report.evidence)));
  for (const finding of r.state.findings) assert.ok(!mojibake.test(finding.text));
});
