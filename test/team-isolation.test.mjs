import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { teamBatch, teamContext } from "../src/runtime/team.js";
import { setTimeout as delay } from "node:timers/promises";

async function setup(t) {
  const tools = new Map(), children = new Map(), notices = [];
  const main = { session: { id: "main", header: { cwd: process.cwd() } }, options: { provider: "test", model: "test" }, ctx: { get: () => undefined },
    async followup(message) { notices.push(message); } };
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); } }, agents: {
    get(id) { return id === main.session.id ? main : children.get(id)?.agent; },
    async create({ sessionId, setup, signal }) {
      const local = new Map(), idle = Promise.withResolvers();
      const events = [{ type: "turn/end", data: { reason: { kind: "completed" } } }];
      const agent = { session: { id: sessionId, append() {}, snapshotEvents: () => events },
        whenIdle: () => idle.promise, steer(message) { this.peer = message; }, async followup(message) { this.input = message; } };
      const record = { agent, local, finish: idle.resolve, signal };
      children.set(sessionId, record);
      const names = new Set(["read","glob","grep","write","edit","mentor_task_status"]);
      await setup({ tools: { restrict() {}, guard(check) { record.guard = check; }, get() {},
        view: () => ({ visible: names, restrictableNames: names }),
        register: tool => local.set(tool.name, tool) } }, agent);
      return { agent, dispose: idle.resolve };
    }
  }};
  const plugin = await apply(ctx, { stateDir: "", maxParallelNodes: 2 });
  t.after(() => plugin());
  const store = await plugin.store.forSession("main");
  const call = async (name, args = {}, agent = main, registry = tools) => JSON.parse(await registry.get(name).execute(args, { agent }));
  return { store, call, children, main, notices, plugin };
}

const wait = async predicate => {
  for (let round = 0; round < 60; round++) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail("workflow stalled");
};
const plan = {
  criteria: ["a","b","c"].map(id => ({id,text:id})),
  stages: ["a","b","c"].map(id => ({id,title:id,criterionIds:[id],dependsOn:id==="c"?["a"]:[]})),
};
async function approve(fixture, job) {
  const reviewer = fixture.children.get(job.sessionId);
  assert.ok((await fixture.call("mentor_task_status", {}, reviewer.agent)).ok);
  const ids = job.kind==="stage" ? [job.stageId] : plan.criteria.map(c=>c.id);
  const result = await fixture.call("mentor_review_apply", {reviewJobId:job.id,kind:job.kind,stageId:job.stageId,
    attempt:job.attempt,planVersion:job.planVersion,verdict:"pass",checks:[{source:"fixture",criterion:"fixture",
      observation:"fixture",status:"passed",criterionIds:ids}]}, reviewer.agent);
  reviewer.finish();
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
const worker = (fixture,id) => wait(() => [...fixture.children.values()].find(c=>c.agent.input?.source?.stageId===id && c.local.has("mentor_team_deliver") && !c.signal.aborted));
async function finishStage(fixture, worker, details = {}) {
  const note = await fixture.call("mentor_team_note", {kind:"observation", text:"fixture observation", evidence:"fixture result", ...details}, worker.agent, worker.local);
  assert.ok(note.ok, JSON.stringify(note));
  const invalid = await fixture.call("mentor_team_deliver", {evidence:"bad reference", evidenceRefs:["fixture.txt"]}, worker.agent, worker.local);
  assert.equal(invalid.code, "E_EVIDENCE_REQUIRED");
  const delivery = await fixture.call("mentor_team_deliver", {evidence:"observed result"}, worker.agent, worker.local);
  assert.ok(delivery.ok, JSON.stringify(delivery));
  worker.finish();
}

test("A passes and C starts while B is still running, with direct handoff and final review", async t => {
  const fixture=await setup(t), {call,store}=fixture;
  assert.ok((await call("mentor_task_create",{objective:"parallel",workspaceRoot:process.cwd()})).ok);
  assert.ok((await call("mentor_team_start")).ok);
  assert.ok((await call("mentor_plan_submit",plan)).ok);
  await approve(fixture,store.get().reviewJobs.at(-1));
  const a=await worker(fixture,"a"), b=await worker(fixture,"b");
  assert.match(a.guard({agent:a.agent,name:"ego_cli"}),/worker-tool-not-allowed/);
  assert.match(a.guard({agent:a.agent,name:"write"}),/worker-tool-not-allowed/);
  assert.equal(a.guard({agent:a.agent,name:"mentor_team_deliver"}),undefined);
  await finishStage(fixture,a,{toStageId:"b"});
  await wait(()=>b.agent.peer);
  const peer = await call("mentor_team_context",{},b.agent,b.local);
  assert.equal(peer.value.notes[0].stageId,"a");
  const reviewA = await wait(()=>store.get().reviewJobs.find(j=>j.stageId==="a"&&j.status==="running"));
  await approve(fixture,reviewA);
  const c = await worker(fixture,"c");
  assert.equal(store.get().nodeRuns.find(r=>r.stageId==="b").status,"running");
  assert.match(c.agent.input.content[0].text,/reportId/);
  await finishStage(fixture,c);
  await finishStage(fixture,b);
  for (const id of ["b","c"]) {
    const job=await wait(()=>store.get().reviewJobs.find(j=>j.stageId===id&&j.status==="running"));
    await approve(fixture,job);
  }
  const completion=await wait(()=>store.get().reviewJobs.find(j=>j.kind==="completion"&&j.status==="running"));
  assert.equal(fixture.notices.length,0,"主会话在团队执行和验收期间无需介入");
  const pending = await call("mentor_task_status");
  assert.equal(pending.value.team.attention.owner,"reviewer");
  const requests = await Promise.all(["first","second"].map(evidence=>call("mentor_completion_request",{evidence})));
  for(const reply of requests) {
    assert.equal(reply.value?.reviewJobId,completion.id,JSON.stringify(reply));
    assert.equal(reply.value.duplicate,true);
  }
  assert.equal(store.get().reviewJobs.filter(j=>j.kind==="completion").length,1);
  await approve(fixture,completion);
  assert.equal(store.get().phase,"completed");
  assert.equal(fixture.notices.length,1,"最终交付唤醒主会话一次");
});

test("changing one stage cancels that attempt and preserves other running work", async t => {
  const fixture=await setup(t), {store,call}=fixture;
  await call("mentor_task_create",{objective:"direction",workspaceRoot:process.cwd()});
  await call("mentor_team_start"); await call("mentor_plan_submit",plan);
  await approve(fixture,store.get().reviewJobs.at(-1));
  const a=await worker(fixture,"a"), b=await worker(fixture,"b");
  assert.ok((await call("mentor_team_direction",{stageId:"a",direction:"Check the other assumption",hold:true})).ok);
  assert.ok(a.signal.aborted);
  await wait(()=>store.get().nodeRuns.find(r=>r.stageId==="a")?.status==="rework");
  assert.equal(teamBatch(store.get(),2).includes("a"),false);
  assert.equal(b.signal.aborted,false);
  const late=await call("mentor_team_note",{kind:"decision",text:"stale"},a.agent,a.local);
  assert.equal(late.ok,false);
  await call("mentor_team_direction",{stageId:"a",direction:"Start with the counterexample"});
  const next=await worker(fixture,"a");
  assert.notEqual(a.agent.session.id,next.agent.session.id);
  assert.equal(store.get().nodeRuns.find(r=>r.stageId==="a")?.attempt,2);
  await call("mentor_task_pause");
});

test("a blocked worker summons the main session while a sibling keeps running", async t => {
  const f = await setup(t);
  await f.call("mentor_task_create", {objective:"blocked branch", workspaceRoot:process.cwd()});
  await f.call("mentor_team_start");
  await f.call("mentor_plan_submit",plan);
  await approve(f,f.store.get().reviewJobs.at(-1));
  const a = await worker(f,"a"), b = await worker(f,"b");
  await f.call("mentor_team_deliver",{blocked:"缺少必要输入"},a.agent,a.local);
  a.finish();
  await wait(()=>f.notices.length);
  assert.match(f.notices[0].content[0].text,/缺少必要输入/);
  assert.equal(b.signal.aborted,false);
  await f.call("mentor_task_pause");
});

test("conflicting observations go back to their authors and a correction retains the evidence trail", async t => {
  const f = await setup(t);
  await f.call("mentor_task_create", {objective:"compare evidence",workspaceRoot:process.cwd()});
  await f.call("mentor_team_start");
  await f.call("mentor_plan_submit",plan);
  const h = (await f.call("mentor_team_note",{kind:"hypothesis",text:"X",nextCheck:"read input"})).value;
  await approve(f,f.store.get().reviewJobs.at(-1));
  const a=await worker(f,"a"), b=await worker(f,"b");
  const note = (w,outcome,replaces) => f.call("mentor_team_note", {kind:"observation",text:outcome,
    evidence:"read by "+w.agent.session.id,hypothesisId:h.id,outcome,replaces},w.agent,w.local);
  const first=await note(a,"supports");
  const opposite=await note(b,"refutes");
  assert.ok(first.ok && opposite.ok,JSON.stringify([first,opposite]));
  await wait(()=>a.agent.peer && b.agent.peer);
  assert.match(a.agent.peer.content[0].text,/相反/);
  assert.equal((await note(b,"refutes",first.value.id)).ok,false);
  assert.equal((await note(b,"supports",opposite.value.id)).ok,true);
  const view=teamContext(f.store.get());
  assert.equal(view.hypotheses[0].status,"supports");
  assert.ok(view.notes.some(n=>n.id===opposite.value.id));
  assert.equal(f.notices.length,0);
  await f.call("mentor_task_pause");
});

test("an agreed host receipt redirects only the affected worker and is bound into the independent stage report",async t=>{
  const f=await setup(t);
  await f.call("mentor_task_create",{objective:"targeted evidence",workspaceRoot:process.cwd()});
  await f.call("mentor_team_start");
  const criteria=plan.criteria.map(c=>c.id==="a"?{...c,observe:{tool:"read",outcome:"success",target:"evidence.txt"}}:c);
  await f.call("mentor_plan_submit",{...plan,criteria});
  await approve(f,f.store.get().reviewJobs.at(-1));
  const a=await worker(f,"a"), b=await worker(f,"b");
  const rule=await f.call("mentor_team_note",{kind:"hypothesis",text:"source is missing",nextCheck:"read it",
    onRefuted:{stageId:"b",criterionId:"a",action:"redirect",direction:"check downstream instead"}});
  assert.ok(rule.ok,JSON.stringify(rule));
  const observe={kind:"observation",text:"source exists",hypothesisId:rule.value.id,outcome:"refutes",receiptCriterionIds:["a"]};
  assert.equal((await f.call("mentor_team_note",observe,a.agent,a.local)).ok,false);
  const events=a.agent.session.snapshotEvents();
  events.push({type:"tool/call",seq:10,data:{name:"read",callId:"read-A",arguments:'{"file_path":"evidence.txt"}'}},
    {type:"tool/result",seq:11,data:{message:{toolCallId:"read-A",isError:false,content:[{type:"text",text:"source content"}]}}});
  const notice=await f.call("mentor_team_note",observe,a.agent,a.local);
  assert.ok(notice.ok,JSON.stringify(notice)); assert.equal(notice.value.receipts[0].callId,"read-A");
  await wait(()=>b.signal.aborted);
  assert.ok(!a.signal.aborted);
  const replacement=await worker(f,"b");
  assert.notEqual(replacement,b);
  assert.match(replacement.agent.input.content[0].text,/check downstream instead/);
  assert.ok((await f.call("mentor_team_deliver",{evidence:"host confirmed read"},a.agent,a.local)).ok);
  a.finish();
  const job=await wait(()=>f.store.get().reviewJobs.find(j=>j.stageId==="a"&&j.status==="running"));
  const report=f.store.get().nodeRuns.find(r=>r.stageId==="a").reports.at(-1);
  assert.equal(report.bindings[0].receipt.resultSeq,11);
  await approve(f,job);
  await worker(f,"c");
  assert.equal(f.store.get().nodeRuns.find(r=>r.stageId==="b").status,"running");
  await f.call("mentor_task_pause");
});

test("mode selection, diagnosis precondition and legacy read", async t => {
  const {call,store}=await setup(t);
  assert.equal((await call("mentor_work_mode",{verifier:"review-recovery"})).value.tool,"mentor_verify_review_recovery");
  assert.equal((await call("mentor_work_mode",{unknownCause:true})).value.mode,"diagnosis");
  const chain=plan.stages.map((s,i,list)=>({...s,dependsOn:i?[list[i-1].id]:[]}));
  assert.equal((await call("mentor_work_mode",{stages:chain,independentOutputs:3})).value.mode,"direct");
  assert.equal((await call("mentor_work_mode",{stages:plan.stages})).value.mode,"team");
  assert.equal((await call("mentor_work_mode",{stages:chain,requiresIndependentReview:true})).value.mode,"supervised");
  await call("mentor_task_create",{objective:"unknown",workspaceRoot:process.cwd()});
  assert.equal((await call("mentor_task_status")).value.team,undefined);
  await call("mentor_team_start",{mode:"diagnosis"});
  assert.deepEqual(teamBatch(store.get(),2),[]);
  assert.equal((await call("mentor_team_note",{kind:"hypothesis",text:"X"})).ok,false);
  assert.equal((await call("mentor_team_note",{kind:"hypothesis",text:"X",nextCheck:"Look for Y"})).ok,true);
  assert.equal(teamContext(store.get()).notes[0].nextCheck,"Look for Y");
});

test("diagnosis shows contradictory observations without recording a conclusion", async t => {
  const {call,store}=await setup(t);
  await call("mentor_task_create",{objective:"diagnose",workspaceRoot:process.cwd()});
  const item = (await call("mentor_team_note",{kind:"hypothesis",text:"X",nextCheck:"Look for Y"})).value;
  for (const outcome of ["supports","refutes"]) {
    const r = await call("mentor_team_note",{kind:"observation",text:"result",evidence:"tool output",hypothesisId:item.id,outcome});
    assert.ok(r.ok,JSON.stringify(r));
  }
  assert.equal(teamContext(store.get()).hypotheses[0].status,"conflicting");
});

test("historical lessons are scoped to the workspace and anchored to reviewed findings", async t => {
  const {plugin,store}=await setup(t);
  const previous = await plugin.store.forSession("previous");
  previous.set({id:"past",workspaceRoot:process.cwd(),updatedAt:2,findings:[
    { id:"f1",status:"closed",resolvedByReviewId:"r1",text:"check the raw output" },
    { id:"unreviewed",status:"closed",text:"missing review" },
  ],reviews:[{id:"r1",verdict:"pass",scope:{planVersion:2},checks:[{findingIds:["f1"],observation:"original output"}]}]});
  const other = await plugin.store.forSession("other");
  other.set({...previous.get(),id:"other",workspaceRoot:process.cwd()+"/other"});
  const result = await plugin.store.lessons({id:"now",workspaceRoot:process.cwd()},"raw");
  assert.deepEqual(result.map(item=>[item.taskId,item.findingId,item.check]),[["past","f1","original output"]]);
});

test("built-in recovery verification produces evidence without an active task", async t => {
  const {call,store}=await setup(t);
  const result = await call("mentor_verify_review_recovery");
  assert.ok(result.ok,JSON.stringify(result));
  assert.equal(result.value.checks.length,5);
  assert.equal(store.get(),null);
});
