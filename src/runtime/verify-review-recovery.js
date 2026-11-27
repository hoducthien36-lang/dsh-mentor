import { ERR } from "../errors.js";
import { createTask } from "../state/machine.js";

// The store, session identities, model transport and wake recipient are local to one call.
// Task actions, review identity checks and delivery all use the installed plugin implementation.
export async function verifyReviewRecovery({ createStore, execute, cancel }) {
  const mainId = "mentor-probe-main";
  const task = {
    ...createTask("验证暂停和恢复审查"), phase: "active", enabled: true, mainSessionId: mainId,
    planVersion: 1, approvedPlanVersion: 1,
    criteria: [{ id: "c1", text: "样例阶段已通过" }],
    stages: [{ id: "s1", dependsOn: [], criterionIds: ["c1"] }],
    nodeRuns: [{ stageId: "s1", status: "accepted", attempt: 2, reports: [] }],
    reviewJobs: [{ id: "previous-failure", sessionId: "previous-reviewer", kind: "stage",
      stageId: "s1", attempt: 1, planVersion: 1, status: "failed", error: "fixture-model-offline" }],
  };
  const store = createStore(task);
  const received = [];
  const main = {
    session: { id: mainId, header: { id: mainId, delegationDepth: 0 } },
    options: { provider: "isolated", model: "isolated" }, ctx: { get: () => undefined },
    followup: async message => { received.push(message.source?.reviewJobId); },
  };
  const agents = {
    get: id => id === mainId ? main : undefined,
    async create({ sessionId }) {
      let finish;
      const idle = new Promise(resolve => { finish = resolve; });
      return {
        agent: { session: { id: sessionId }, followup: async () => {}, whenIdle: () => idle },
        dispose: () => finish(),
      };
    },
  };
  const call = (name, args = {}, agent = main) => execute(name, args, { agent, store }, {}, { agents }, {});
  const checks = [];
  const record = (name, passed, observed) => checks.push({ name, passed: Boolean(passed), observed });
  const scope = "内存隔离任务，使用当前插件的工具和裁决逻辑；审查会话及消息接收端为模拟宿主。";

  try {
    const first = await call("mentor_completion_request", { evidence: "样例阶段已通过" });
    if (!first.value?.queued) throw Error(first.message ?? first.value?.reason ?? "初次派发失败");
    const original = first.value;
    const pause = await call("mentor_task_pause");
    if (pause.value?.phase !== "paused") throw Error(pause.message ?? "暂停失败");
    const resumed = await call("mentor_task_resume");
    const jobs = resumed.value?.resumedReviews ?? [];
    const next = jobs.find(job => job.previousReviewJobId === original.reviewJobId);
    record("自动重派", jobs.length === 1 && next?.queued && next.reviewJobId !== original.reviewJobId,
      { before: original.reviewJobId, after: next?.reviewJobId ?? null, count: jobs.length });
    const previous = store.get().reviewJobs.find(job => job.id === "previous-failure");
    record("原有失败原因保留", previous?.status === "failed" && previous.error === "fixture-model-offline",
      { status: previous?.status, error: previous?.error });
    if (!next?.queued) throw Error(resumed.message ?? next?.reason ?? "未获得替代审查");
    const verdict = {
      kind: "completion", stageId: "__completion__", attempt: 1, planVersion: 1, verdict: "pass",
      checks: [{ source: "fixture state", criterion: "样例阶段已通过", criterionIds: ["c1"],
        observation: "s1 accepted", status: "passed" }],
    };
    const old = await call("mentor_review_apply", { ...verdict, reviewJobId: original.reviewJobId },
      { session: { id: original.reviewerSessionId } });
    record("旧审查身份提交遭拒", old.ok === false && old.code === ERR.REVIEW_STALE, { code: old.code });
    const reviewer = { session: { id: next.reviewerSessionId } };
    const read = await call("mentor_task_status", {}, reviewer);
    if (!read.ok) throw Error(read.message);
    const accepted = await call("mentor_review_apply", { ...verdict, reviewJobId: next.reviewJobId }, reviewer);
    record("新审查完成任务", accepted.ok && store.get().phase === "completed",
      { phase: store.get().phase, verdict: accepted.value?.verdict, code: accepted.code });
    record("主会话只收到一次新裁决", received.length === 1 && received[0] === next.reviewJobId,
      { received: [...received] });
    return { scope, passed: checks.every(check => check.passed), checks };
  } catch (error) {
    return { scope, passed: false, checks, error: String(error?.message ?? error) };
  } finally {
    await cancel(store, task.id, "probe-finished");
  }
}
