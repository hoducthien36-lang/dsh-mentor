import test from "node:test";
import assert from "node:assert/strict";
import { apply, wakeMain, withReviewerTracking } from "../lib/index.js";
import { createMemoryStore, reviewWaive } from "../src/tools/handlers.js";
import { computeNextStep } from "../src/state/guard.js";
import { reviewsInterruptedByPause } from "../src/runtime/checkpoints.js";
import { checkEvidenceSync } from "../src/review/evidence-check.js";
import { observeContinuation } from "../src/runtime/continuation.js";
import { runtimePayload } from "../src/runtime/activity.js";

function job(id, stageId, status) {
  return { id, sessionId: "review-" + id, kind: "stage", stageId, attempt: 1, planVersion: 1, status };
}

function task(jobs) {
  const ids = [...new Set(jobs.map(j => j.stageId))];
  return { id: "task-demo", phase: "reviewing", revision: 1, objective: "verify", mainSessionId: "main",
    criteria: [], findings: [], reviews: [], planVersion: 1, approvedPlanVersion: 1, reviewJobs: jobs,
    stages: ids.map(id => ({ id, dependsOn: [], criterionIds: [] })),
    nodeRuns: ids.map(stageId => ({ stageId, attempt: 1, status: "reported", reports: [] })) };
}

async function plugin(t, jobs, agents) {
  const registered = new Map();
  const main = {session: {id: "main", header: {}}, options: {provider: "local", model: "fixture"}};
  const dispose = await apply({agents, tools: {register(tool) { registered.set(tool.name, tool); }}}, {stateDir: ""});
  const store = withReviewerTracking(createMemoryStore(task(jobs)));
  t.after(() => dispose());
  const call = async (name, args = {}, agent = main) => JSON.parse(await registered.get(name).execute(args, {agent, store}));
  return {call, store, main};
}

test("resume dispatches two interrupted reviews once and preserves an unrelated failure", async t => {
  const sessions = [];
  const agents = {create: async ({sessionId}) => {
    sessions.push(sessionId);
    return {agent: {session: {id: sessionId}, followup: async () => {}, whenIdle: () => new Promise(() => {})}};
  }};
  const oldFailure = {...job("old", "c", "failed"), error: "model-offline"};
  const {store, call} = await plugin(t, [job("first","a","running"), job("second","b","queued"), oldFailure], agents);
  assert.equal((await call("mentor_task_pause")).value.phase, "paused");
  assert.equal((await call("mentor_task_pause")).value.duplicate, true);
  const resumed = await call("mentor_task_resume");
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.value.resumedReviews.filter(j => j.queued).map(j => j.previousReviewJobId).sort(), ["first","second"]);
  assert.equal((await call("mentor_task_resume")).ok, false);
  assert.equal(sessions.length, 2);
  assert.deepEqual(store.get().reviewJobs.find(j => j.id === "old"), oldFailure);
  for (const j of resumed.value.resumedReviews) {
    const snapshot = (await call("mentor_task_status", {reviewJobId: j.reviewJobId})).value;
    assert.deepEqual(snapshot.reviewDispatches.map(d => d.status), ["queued","running"]);
  }
  await call("mentor_task_pause");
});

test("legacy pause selects only a current cancellation inside the pause window", () => {
  const history = [job("superseded","a","failed"),job("current","a","failed"),job("previous","b","failed"),job("real","c","failed")];
  const data = task(history.map(j => ({...j, startedAt: 1, updatedAt: j.id === "previous" ? 8 : 12, error: j.id === "real" ? "model-offline" : "task-stopped"})));
  data.pausedAt = 10;
  assert.deepEqual(reviewsInterruptedByPause(data).map(j=>j.id), ["current"]);
});

test("a waiver for a superseded failed review cannot advertise a main-session verdict", () => {
  const data = task([job("first","a","failed"),job("retry","a","failed")]);
  const store = createMemoryStore(data);
  assert.equal(reviewWaive(store, {reason:"verify",reviewJobId:"first"}).ok, false);
  data.reviewWaivers = [{reviewJobId:"first", planVersion:1}];
  assert.equal(computeNextStep(data).allowedActions.includes("mentor_review_apply"), false);
  data.reviewWaivers[0].reviewJobId = "retry";
  assert.equal(computeNextStep(data).allowedActions.includes("mentor_review_apply"), true);
});

test("manual continuation cannot record its delivery on a replacement task", async t => {
  let store;
  const agents = {get: () => ({followup: async () => store.set({...store.get(), id:"replacement"})})};
  const p = await plugin(t, [], agents);
  store = p.store;
  await p.call("mentor_task_continue");
  assert.equal(store.get().id, "replacement");
  assert.equal(store.get().wakeDispatches?.length ?? 0, 0);
});

test("a pause during continuation message construction suppresses the old prompt", async t => {
  let store, sent = 0;
  const agents = {get: () => { queueMicrotask(() => p.call("mentor_task_pause")); return {followup: async () => { sent++; }}; }};
  const p = await plugin(t, [], agents);
  store = p.store;
  const result = await p.call("mentor_task_continue");
  assert.equal(store.get().phase,"paused");
  assert.equal(result.value.queued, false);
  assert.equal(sent, 0);
});

test("turn stopping rechecks the task after yielding", async () => {
  let callback;
  const store = createMemoryStore({...task([]), phase: "planning"});
  const cleanup = [];
  observeContinuation({on: (_, fn) => {callback = fn;}}, {all: () => [store]}, cleanup);
  let sent = 0;
  const running = callback({agent:{session:{id:"main"}, steer() { sent++; }}, turn:1, signal:new AbortController().signal});
  store.set({...store.get(), id:"replacement"});
  await running;
  assert.equal(sent, 0);
  cleanup.forEach(fn=>fn());
});

test("concurrent reviewer notifications queue up, a targeted read acknowledges only its job, and the rest merge into one delivery", async t => {
  const jobs = ["a","b","c"].map(id => ({...job(id,id,"completed"), verdict:"pass", reviewId:"r-"+id}));
  let release;
  const idle = new Promise(resolve => {release = resolve;});
  const sent = [];
  const main = {status:"running", whenIdle:()=>idle, followup:async msg=>{sent.push({ids:msg.source.reviewJobIds ?? [msg.source.reviewJobId], keys:msg.source.deliveryKeys ?? null, text:msg.content[0].text});}};
  const ctx = {agents:{get:()=>main}};
  const {store,call} = await plugin(t,jobs,ctx.agents);
  store.set({...store.get(),nodeRuns:store.get().nodeRuns.map(r=>({...r,status:"accepted"}))});
  const wake = j => wakeMain(ctx,store,{taskId:store.get().id,reviewJobId:j.id,kind:j.kind,stageId:j.stageId,attempt:1,planVersion:1,verdict:"pass"},{deps:{createUserMessage:x=>x}});
  assert.equal((await wake(jobs[0])).status,"deferred");
  assert.equal((await wake(jobs[1])).status,"deferred");
  // 精确读到阶段 b：只确认 b，未读的 a 继续排队
  await call("mentor_task_status",{reviewJobId:"b"});
  assert.equal((await wake(jobs[2])).status,"deferred");
  assert.deepEqual(store.get().wakeDispatches.filter(d=>d.reviewJobId==="b").map(d=>[d.status,d.reason]),[["skipped","main-read-status"]]);
  assert.equal(store.get().wakeDispatches.length,1,"读 b 不能顺手把 a 结掉");
  main.status="idle"; release();
  await new Promise(resolve=>setImmediate(resolve));
  // a 与 c 合并成一条消息送达：每条都有回执，没有 superseded 静默丢弃
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].ids,["a","c"]);
  assert.equal(sent[0].keys.length,2);
  assert.match(sent[0].text,/阶段 a/);
  assert.match(sent[0].text,/阶段 c/);
  const receipts = Object.fromEntries(store.get().wakeDispatches.map(d=>[d.reviewJobId,[d.status,d.reason]]));
  assert.deepEqual(receipts.a,["sent",null]);
  assert.deepEqual(receipts.b,["skipped","main-read-status"]);
  assert.deepEqual(receipts.c,["sent",null]);
  assert.ok(!store.get().wakeDispatches.some(d=>d.reason==="superseded"),"不得再有 superseded 静默丢弃");
  const exact=runtimePayload(ctx,store,null,{reviewJobId:"b"});
  assert.deepEqual(exact.wakeDispatches.map(d=>d.reviewJobId),["b"]);
  assert.deepEqual(runtimePayload(ctx,store,null,{stageId:"c"}).wakeDispatches.map(d=>d.stageId),["c"]);
});

test("the requested line wins over an earlier duplicate inside the search window", () => {
  const result = checkEvidenceSync([{file:"a.txt", line:4,snippet:"dup"}],()=>"one\ndup\nthree\ndup");
  assert.equal(result.evidence[0].matchedAt,4);
});

test("a paused completion review is replaced, independently approved and wakes the main session once", async t => {
  const messages = [];
  const children = new Map();
  const agents = {
    get: () => ({agent: {followup: async msg => messages.push(msg)}}),
    create: async ({sessionId}) => {
      const idle = Promise.withResolvers();
      children.set(sessionId, idle);
      return { agent: {session:{id:sessionId}, whenIdle:()=>idle.promise, followup:async()=>{}},
        dispose:async()=>idle.resolve() };
    },
  };
  const {call,store} = await plugin(t, [job("accepted","a","completed")], agents);
  store.set({...store.get(),nodeRuns:store.get().nodeRuns.map(r=>({...r,status:"accepted"}))});
  const original = await call("mentor_completion_request",{evidence:"deliverable checked"});
  assert.equal(original.value.queued,true);
  await call("mentor_task_pause");
  const resumed = (await call("mentor_task_resume")).value.resumedReviews;
  assert.equal(resumed.length,1);
  const replacement = resumed[0];
  assert.equal(replacement.previousReviewJobId,original.value.reviewJobId);
  const submit = (id,session) => call("mentor_review_apply", {reviewJobId:id,kind:"completion",stageId:"__completion__",
    attempt:1,planVersion:1,verdict:"pass",checks:[{source:"fixture",criterion:"all stages accepted",criterionIds:[],
    observation:"all accepted",status:"passed"}]}, {session:{id:session}});
  assert.equal((await submit(original.value.reviewJobId,original.value.reviewerSessionId)).code,"E_REVIEW_STALE");
  await call("mentor_task_status",{}, {session:{id:replacement.reviewerSessionId}});
  const result = await submit(replacement.reviewJobId,replacement.reviewerSessionId);
  assert.equal(result.ok,true, JSON.stringify(result));
  children.get(replacement.reviewerSessionId).resolve();
  assert.equal(store.get().phase,"completed");
  assert.equal(store.get().pendingCheckpoint,null);
  assert.equal(messages.length,1);
  assert.equal(messages[0].source.reviewJobId,replacement.reviewJobId);
});

test("failed wake batch clears queue entries so later reviews do not replay or double-finish failed notices", async t => {
  const jobs = ["a","b"].map(id => ({...job(id,id,"completed"), verdict:"pass", reviewId:"r-"+id}));
  let failNext = true;
  const delivered = [];
  const main = {
    status: "idle",
    whenIdle: async () => {},
    followup: async msg => {
      if (failNext) { failNext = false; throw new Error("boom"); }
      delivered.push(msg.source.reviewJobIds ?? [msg.source.reviewJobId]);
    },
  };
  const ctx = { agents: { get: () => main } };
  const { store } = await plugin(t, jobs, ctx.agents);
  store.set({ ...store.get(), nodeRuns: store.get().nodeRuns.map(r => ({ ...r, status: "accepted" })) });
  const wake = j => wakeMain(ctx, store, { taskId: store.get().id, reviewJobId: j.id, kind: j.kind, stageId: j.stageId, attempt: 1, planVersion: 1, verdict: "pass" }, { deps: { createUserMessage: x => x } });

  const first = await wake(jobs[0]);
  assert.equal(first.status, "failed");
  assert.equal(store.get().continuation?.kind, "review-delivery-failed");

  // 后续新通知 b 到来时，已失败的 a 必须已出队，不能被重放或重复落回执
  const second = await wake(jobs[1]);
  assert.equal(second.status, "sent");
  assert.deepEqual(delivered, [["b"]]);
  const aDispatches = store.get().wakeDispatches.filter(d => d.reviewJobId === "a");
  assert.equal(aDispatches.length, 1, "失败的 a 不得被重复 finish");
  assert.equal(aDispatches[0].status, "failed");
});
