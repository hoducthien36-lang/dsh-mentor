import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { captureReceipts, evidenceImpact, collectBindings } from "../src/review/criterion-evidence.js";
import { requestCheckpoint, applyBoundReview } from "../src/runtime/checkpoints.js";
import { stageReportGated, createMemoryStore } from "../src/tools/handlers.js";
import { amendedRuns } from "../src/plan/amendment.js";
import { readReportExcerpt } from "../src/review/evidence-reader.js";
import { calibrateWork } from "../src/runtime/work-history.js";
import { progressView } from "../src/runtime/progress-view.js";
import { validatePlan } from "../src/plan/dag.js";
import { includeObjectiveCriteria } from "../src/plan/objective-criteria.js";

const check=id=>({criterionIds:[id],source:"source",criterion:id,observation:"checked",status:"passed"});
const result=(id,text,isError=false)=>({type:"tool/result",seq:12,data:{message:{toolCallId:id,isError,content:[{type:"text",text}]}}});
const call=(id,tool,file)=>({type:"tool/call",seq:11,data:{callId:id,name:tool,arguments:JSON.stringify({file_path:file})}});
const header=names=>({type:"request/header",seq:8,data:{header:{tools:names.map(name=>({name}))}}});
const criteria=[{id:"write",text:"file written",observe:{tool:"write",outcome:"success",target:"yes.txt"}},
  {id:"blocked",text:"outside write denied",observe:{tool:"write",outcome:"error",target:"no.txt",error:"Error: denied"}},
  {id:"hidden",text:"shell unavailable",observe:{tool:"ego_cli",outcome:"unavailable"}}];

test("host receipts require exact target, outcome and paired call; duplicate and unrelated frames do not prove a claim",()=>{
  const hits=captureReceipts([header(["write","read"]),call("1","write","no.txt"),result("1","not denied"),call("2","write","yes.txt"),result("2","do not retain content"),
    call("3","write","no.txt"),result("3","Error: denied",true),result("3","other",true)],criteria,"worker",process.cwd());
  assert.deepEqual(hits.map(r=>r.criterionId).sort(),["blocked","hidden","write"]);
  assert.equal(hits[0].callId,"2");assert.doesNotMatch(JSON.stringify(hits),/do not retain content/);
  assert.deepEqual(captureReceipts([result("1","Error: denied",true),header(["ego_cli"]),header(["read"])],criteria,"w",process.cwd()),[]);
  assert.equal(validatePlan({criteria:[{...criteria[0],observe:{...criteria[0].observe,unsupported:true}}],stages:[{id:"a",dependsOn:[],criterionIds:["write"]}]}).ok,false);
  assert.equal(includeObjectiveCriteria([{id:"write",text:"original"}],criteria)[0].text,"original");
  assert.deepEqual(includeObjectiveCriteria([{id:"write",text:"original"}],criteria)[0].observe,criteria[0].observe);
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"mentor-bindings-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stages=[{id:"a",criterionIds:["a1","a2"],dependsOn:[]},{id:"b",criterionIds:["b"],dependsOn:[]},{id:"c",criterionIds:["c"],dependsOn:["a"]}];
  const task={id:"t",phase:"active",mainSessionId:"main",planVersion:1,approvedPlanVersion:1,enabled:true,revision:1,workspaceRoot:root,
    criteria:["a1","a2","b","c"].map(id=>({id,text:id})),stages,findings:[],nodeRuns:[],reviews:[],reviewJobs:[]};
  const store=createMemoryStore(task);
  for(const stage of stages) {
    fs.writeFileSync(path.join(root,stage.id),stage.id==="a"?"count = 1\nowner = stable":"ok");
    const refs=stage.id==="a"?[{file:"a",snippet:"count = 1",criterionIds:["a1"]},{file:"a",snippet:"owner = stable",criterionIds:["a2"]}]:[{file:stage.id,scope:"file"}];
    const r=stageReportGated(store,{planVersion:1,attempt:1,stageId:stage.id,evidence:"observed",evidenceRefs:refs});
    assert.ok(r.ok,JSON.stringify(r));
    const s=store.get();
    store.set({...s,nodeRuns:s.nodeRuns.map(n=>n.stageId===stage.id?{...n,status:"accepted"}:n),reviews:[...s.reviews,
      {id:"review"+stage.id,scope:{stageId:stage.id,attempt:1,kind:"stage"},verdict:"pass",checks:stage.criterionIds.map(check)}]});
  }
  return {root,store};
}

test("a changed figure reopens one criterion and its dependents, carries the unchanged check, and preserves independent B",t=>{
  const {store,root}=fixture(t);
  fs.writeFileSync(path.join(root,"a"),"title\ncount = 1\nowner = stable");
  assert.deepEqual(evidenceImpact(store.get()),[]);
  const job={id:"j",sessionId:"r",kind:"completion",attempt:1,planVersion:1,stageId:"__completion__",status:"running"};
  const original=store.get(), reportId=original.nodeRuns[0].reports[0].id;
  const excerpt=readReportExcerpt({...original,reviewJobs:[job]},"t",job,{reportId,file:"a"});
  assert.equal(excerpt.boundLinesOnly,true); assert.equal(excerpt.excerpt[0].text,"count = 1");
  fs.writeFileSync(path.join(root,"a"),"count = 2\nowner = stable");
  assert.throws(()=>requestCheckpoint(store,"completion","deliver"),{code:"E_EVIDENCE_MISMATCH"});
  const [a,b,c]=store.get().nodeRuns;
  assert.deepEqual(a.recheck.criterionIds,["a1"]);assert.deepEqual(a.recheck.retainedCriterionIds,["a2"]);
  assert.equal(b.status,"accepted");assert.equal(c.status,"rework");
  const submitted=stageReportGated(store,{planVersion:1,attempt:2,stageId:"a",evidence:"2",evidenceRefs:[{file:"a",snippet:"count = 2"}]});
  assert.ok(submitted.ok,JSON.stringify(submitted));
  const review={...job,id:"ja",kind:"stage",attempt:2,stageId:"a",readAt:1,readPlanVersion:1};
  store.set({...store.get(),reviewJobs:[review]});
  const r=applyBoundReview(store,{taskId:"t",reviewJobId:"ja",kind:"stage",stageId:"a",attempt:2,planVersion:1,verdict:"pass",checks:[check("a1")]},"r");
  assert.ok(r.ok,JSON.stringify(r));
  assert.match(store.get().reviews.at(-1).checks.find(c=>c.criterionIds.includes("a2")).source,/reviewa/);
});

test("amending one standard preserves a separately verified stage with provenance",t=>{
  const {store}=fixture(t), task=store.get();
  const result=amendedRuns(task,task.stages,task.criteria.map(c=>c.id==="a1"?{...c,text:"new standard"}:c),2);
  assert.deepEqual(result.keptStages,["b"]);assert.deepEqual(result.resetStages,["a","c"]);
  assert.equal(result.nodeRuns[1].reports.at(-1).carriedFrom.reportId,task.nodeRuns[1].reports.at(-1).id);
  const view=progressView(task,{text:"ready"});
  assert.equal(view.claims.find(x=>x.id==="a2").proofs[0].file.snippet,"owner = stable");
});

test("a concurrent edit expands a partial recheck and cannot silently pass stale evidence",t=>{
  const {store,root}=fixture(t);
  fs.writeFileSync(path.join(root,"a"),"count = 2\nowner = stable");
  assert.throws(()=>requestCheckpoint(store,"completion","all"));
  fs.writeFileSync(path.join(root,"a"),"count = 2\nowner = changed");
  const r=stageReportGated(store,{stageId:"a",attempt:2,planVersion:1,evidence:"update",evidenceRefs:[{file:"a",snippet:"count = 2"}]});
  assert.equal(r.code,"E_EVIDENCE_MISMATCH");assert.deepEqual(store.get().nodeRuns[0].recheck.retainedCriterionIds,[]);
});

test("history compares measured overlap and preserves unknown interventions",()=>{
  const make=(id,parallel,ms)=>({id,workClass:"verification",createdAt:1,completedAt:ms+1,humanInterventions:0,
    stages:[{},{}],workers:[{stageId:"a",startedAt:2,completedAt:12},{stageId:"b",startedAt:parallel?3:13,completedAt:20}]});
  const rows=[make("s1",false,90),make("s2",false,92),make("p1",true,40),make("p2",true,42)];
  assert.equal(calibrateWork(rows,"verification",2).preferred,"parallel");
  assert.equal(calibrateWork(rows.slice(1),"verification",2).preferred,null);
  delete rows[0].humanInterventions;
  assert.equal(calibrateWork(rows,"verification",2).preferred,null);
  assert.equal(calibrateWork(rows,"other",2).groups.serial.samples,0);
});

test("a refuted route reopens on conflicting evidence and respects a subsequent manual decision",async()=>{
  const {recordTeamNote,applyEvidenceDirection,changeDirection}=await import("../src/runtime/team.js");
  const store=createMemoryStore({id:"route",phase:"active",planVersion:1,revision:1,criteria,team:{enabled:true},
    stages:["a","b","c"].map(id=>({id,criterionIds:["write"],dependsOn:[]})),
    nodeRuns:["a","b","c"].map(stageId=>({stageId,status:"running",attempt:1}))});
  const h=recordTeamNote(store,{kind:"hypothesis",text:"file is absent",nextCheck:"write test",
    onRefuted:{stageId:"b",criterionId:"write",action:"hold",direction:"wait for new evidence"}});
  const note=(stageId,outcome,receipts=[])=>recordTeamNote(store,{kind:"observation",hypothesisId:h.id,outcome,
    text:stageId+outcome,evidence:"tool result"},{stageId,attempt:1,receipts});
  assert.equal(applyEvidenceDirection(store,note("a","refutes")),null);
  const refutation=note("a","refutes",[{criterionId:"write",callId:"owned"}]);
  assert.equal(applyEvidenceDirection(store,refutation).action,"hold");
  assert.equal(applyEvidenceDirection(store,refutation),null);
  assert.equal(applyEvidenceDirection(store,note("c","supports")).action,"recheck");
  changeDirection(store,{stageId:"b",direction:"manually chosen",hold:true});
  assert.equal(applyEvidenceDirection(store,note("c","refutes")),null);
  assert.equal(store.get().team.directions.b.text,"manually chosen");
});

test("unavailable tool requires complete consistent inventories and no contradictory invocation",()=>{
  const c=[criteria[2]];
  for (const events of [[header(["read"]),{type:"request/header",data:{}}],[header(["read"]),call("x","ego_cli","")]]) {
    assert.deepEqual(captureReceipts(events,c,"s",process.cwd()),[]);
  }
});
