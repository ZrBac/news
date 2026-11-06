import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { NewsCoordinator } from "../src/worker.js";

test("private outing feedback requires a token, survives restart and can be undone", async () => {
  const data = new Map();
  const ctx = { blockConcurrencyWhile: fn => fn(), storage: {
    get: async key => structuredClone(data.get(key)),
    put: async (key,value) => data.set(key,structuredClone(value)),
  }};
  const env = { OUTING_PROFILE_TOKEN:"test-only-secret", REQUEST_LIMITER:{limit:async()=>({success:true})} };
  let object = new NewsCoordinator(ctx, env);
  env.COORDINATOR = {idFromName:name=>name,get:name=>{
    assert.equal(name,"outings"); return {fetch:req=>object.fetch(req)};
  }};
  const call = (body, auth=true, origin="https://news.zacai.fun") => worker.fetch(new Request("https://worker.example/api/outings/profile", {
    method:body?"POST":"GET", headers:{...(origin?{Origin:origin}:{}), ...(auth?{Authorization:"Bearer test-only-secret"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  }),env);
  assert.equal((await call(null,false)).status,401);
  assert.equal((await call(null,true,"https://evil.example")).status,403);
  const settings = await call({action:"settings",startArea:"杭州五常",people:2,transport:"car"});
  assert.equal(settings.status,200);
  await call({action:"record",id:"place:craft",title:"手作",status:"visited"});
  object = new NewsCoordinator(ctx, env);
  let profile = await (await call(null,true,null)).json();
  assert.equal(profile.records.length,1);
  assert.equal(profile.settings.people,2);
  assert.equal(profile.records[0].status,"visited");
  assert.equal(JSON.stringify(profile).includes("test-only-secret"),false);
  await call({action:"record",id:"place:craft",title:"手作",status:"want"});
  profile = await (await call(null)).json();
  assert.equal(profile.records.length,1);
  assert.equal(profile.records[0].status,"want");
  assert.equal((await call({action:"record",id:"bad",title:"bad",status:"visited"})).status,400);
  await call({action:"remove",id:"place:craft"});
  assert.equal((await (await call(null)).json()).records.length,0);
});

function fixture() {
  const data = new Map();
  const ctx = {blockConcurrencyWhile:fn=>fn(), storage:{
    get:async key=>structuredClone(data.get(key)),
    put:async (key,value)=>{for (const [k,v] of typeof key === "string" ? [[key,value]] : Object.entries(key)) data.set(k,structuredClone(v));},
    list:async ({prefix,startAfter,limit})=>new Map([...data].filter(([k])=>k.startsWith(prefix) && (!startAfter || k>startAfter)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit)),
  }};
  const env={OUTING_PROFILE_TOKEN:"test-private-connection-abcdefghijklmnopqrstuvwxyz",
    REQUEST_LIMITER:{limit:async()=>({success:true})}};
  let object=new NewsCoordinator(ctx,env);
  env.COORDINATOR={idFromName:n=>n,get:()=>({fetch:r=>object.fetch(r)})};
  const call=(path,body,auth=true,origin="https://news.zacai.fun",ip="test-ip")=>worker.fetch(new Request("https://worker.example/api/outings/"+path,{
    method:body?"POST":"GET",headers:{Origin:origin,"CF-Connecting-IP":ip,...(auth?{Authorization:"Bearer "+(typeof auth === "string" ? auth : env.OUTING_PROFILE_TOKEN)}:{})},
    ...(body?{body:JSON.stringify(body)}:{})}),env);
  return {call,data,restart:()=>{object=new NewsCoordinator(ctx,env);}};
}
const entry = id => ({id:"evening-"+id.repeat(24),activityId:"event:tonight-reading",title:"阅读",
  note:"读到第36页",next:"下次继续",createdAt:"2026-11-06T01:00:00Z"});
const put=(id,record)=>({id:"op-"+id.repeat(24),action:"put",record});
const remove=(id,recordId)=>({id:"op-"+id.repeat(24),action:"remove",recordId});
const batch=(...operations)=>({schema:1,operations});

test("automatic sync keeps shared data private and the removed pairing endpoint stays closed", async()=>{
  const {call}=fixture();
  assert.equal((await call("connect",{code:"246810"},false)).status,404);
  assert.equal((await call("profile",null,false)).status,401);
  assert.equal((await call("journal",null,false)).status,401);
  assert.equal((await call("journal",null,true,"https://evil.example")).status,403);
  assert.equal((await call("journal")).headers.get("Cache-Control"),"no-store");
});

test("browser entrance and existing devices share records without publishing the collection credential", async()=>{
  const {call}=fixture();
  const entrance=createHash("sha256").update("outings-browser-entry-v1:test-private-connection-abcdefghijklmnopqrstuvwxyz").digest("hex");
  assert.equal((await call("profile",null,"0".repeat(64))).status,401);
  assert.equal((await call("profile",{action:"record",id:"event:reading",title:"阅读",status:"want"},entrance)).status,200);
  assert.equal((await (await call("profile")).json()).records.length,1);
  assert.equal((await call("journal",batch(put("1",entry("a"))),entrance)).status,200);
  const saved=await (await call("journal")).json();
  assert.equal(saved.records.length,1);
  assert.equal(JSON.stringify(saved).includes(entrance),false);
});

test("journal merges two devices, keeps data separate, and retry cannot resurrect another device's deletion", async()=>{
  const {call,restart}=fixture();
  const first=entry("a"),second=entry("b"),firstOp=put("1",first);
  await call("journal",batch(firstOp));
  await call("journal",batch(put("2",second)));
  restart();
  let state=await (await call("journal")).json();
  assert.equal(state.records.length,2);
  assert.equal((await (await call("profile")).json()).records.length,0,"AI preference endpoint never contains journal text");
  const unchanged=await (await call("journal?version="+state.version)).json();
  assert.equal(unchanged.unchanged,true);
  await call("journal",batch(remove("3",first.id)));
  await call("journal",batch(firstOp)); // Response to the original put was lost.
  state=await (await call("journal")).json();
  assert.deepEqual(state.records.map(r=>r.id),[second.id]);
  await call("journal",batch(put("4",first))); // An explicit undo is a new operation.
  assert.equal((await (await call("journal")).json()).records.length,2);
  assert.equal((await call("journal",batch(put("5",{...first,note:"x".repeat(501)})))).status,400);
});

test("journal batches are atomic at capacity and pagination includes over 500 entries", async()=>{
  const {call,data}=fixture();
  for(let i=0;i<501;i++) {
    const record={...entry("a"),id:"evening-"+i.toString(16).padStart(24,"0")};
    data.set("journal-entry:"+record.id,record);
  }
  data.set("journalMeta",{version:501,count:501});
  assert.equal((await (await call("journal")).json()).records.length,501);
  data.set("journalMeta",{version:501,count:1999});
  assert.equal((await call("journal",batch(put("1",entry("b")),put("2",entry("c"))))).status,409);
  assert.equal(data.get("journalMeta").count,1999);
  assert.equal(data.has("journal-entry:"+entry("b").id),false);
});
