import test from "node:test";
import assert from "node:assert/strict";
import worker, {NewsCoordinator, OutingAdviceJob} from "../src/worker.js";

const NOW = Date.parse("2026-11-08T06:00:00Z");
const input = {minutes:240,setting:"outside",note:"雨天自驾 赏秋",previous:[]};
const candidates = ["craft","sewing","gallery"].map(id=>({id:"place:"+id,name:id,setting:"indoor",group:"rainy",
  checkedAt:new Date(NOW).toISOString(),sources:[{label:"来源",url:"https://example.com/"+id}]}));
const answer = {intro:"可以先核对室内备选的开放情况。",ideas:candidates.map(p=>({id:p.id,title:p.name,reason:"雨天室内备选。",
  minutes:120,steps:["先核实当天营业与预约。","确认后再出发。"],outcome:"一段体验"}))};
const output = {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(answer)}]}]};
const id="ab".repeat(16);
function fixture(t) {
  t.mock.method(Date,"now",()=>NOW);
  const objects=new Map(), stores=new Map(), ctxs=new Map();
  const env={NEWS_SITE_URL:"https://news.example.com",OPENAI_API_KEY:"test-only",REQUEST_LIMITER:{limit:async()=>({success:true})}};
  function get(name,Class) {
    if(!objects.has(name)) {
      const data=stores.get(name)||new Map(); stores.set(name,data); let serial=Promise.resolve();
      const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),
        setAlarm:async t=>data.set("$alarm",t),deleteAll:async()=>data.clear()};
      storage.transaction=async fn=>fn(storage);
      const ctx={storage,blockConcurrencyWhile:fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;}};
      ctxs.set(name,ctx);objects.set(name,new Class(ctx,env));
    }
    return objects.get(name);
  }
  env.COORDINATOR={idFromName:n=>n,get:n=>get(n,NewsCoordinator)};
  env.ADVICE_JOBS={idFromName:n=>n,get:n=>get(n,OutingAdviceJob)};
  const call=(method="POST",body=input,jobId=id,origin="https://news.example.com")=>worker.fetch(new Request("https://worker.example/api/outings/now/jobs/"+jobId,
    {method,headers:{Origin:origin,"Content-Type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}),env);
  return {env,stores,call,job:()=>get(id,OutingAdviceJob),restart:()=>objects.delete(id)};
}

test("an accepted job survives lost acknowledgements, duplicate POSTs and reopening without a second generation",async t=>{
  const h=fixture(t);let calls=0,release,started;
  const ready=new Promise(r=>{started=r;});
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json"))return Response.json({schema:1,candidates});
    if(url.includes("open-meteo"))return new Response("",{status:503});
    calls++;started();return new Promise(r=>{release=()=>r(Response.json(output));});
  });
  assert.equal((await h.call("GET")).status,404,"read-only recovery must not create or charge for a job");
  assert.equal((await h.call("POST",input,id,"https://evil.example")).status,403);
  assert.equal((await h.call("POST",{...input,minutes:900})).status,400);
  const initial=await Promise.all([h.call(),h.call()]);
  assert.deepEqual(initial.map(r=>r.status),[202,202]);
  assert.equal(calls,0,"submission only saves the request and schedules its alarm");
  assert.equal(h.stores.get("outing-advice").get("advicePermit").leases.length,1);
  assert.equal((await h.call("POST",{...input,note:"不同条件"})).status,409);
  const generation=h.job().alarm();await ready;
  const running=await (await h.call("GET")).json();
  assert.equal(running.status,"running");assert.equal(running.stage,"generating");
  assert.equal((await h.call()).status,202,"replaying the same accepted request just returns its state");
  const profile=await h.env.COORDINATOR.get("outings").fetch(new Request("https://internal/outing-profile"));
  assert.equal(profile.status,200,"model generation never blocks the shared profile object");
  release();await generation;h.restart();
  const result=await (await h.call("GET")).json();
  assert.equal(result.status,"ok");assert.equal(result.result.ideas.length,3);
  assert.equal(result.input,undefined);assert.equal(result.lease,undefined);
  assert.equal(JSON.stringify(result).includes("test-only"),false);
  assert.equal((await h.call()).status,200);
  await h.job().alarm();
  assert.equal(calls,1,"reading, restarting or redelivering a completed alarm cannot regenerate");
  assert.equal(h.stores.get("outing-advice").get("advicePermit").leases.length,0);
  const raw=h.stores.get(id).get("job");raw.expiresAt=Date.now()-1;h.stores.get(id).set("job",raw);
  assert.equal((await h.call("GET")).status,410);
  await h.job().alarm();assert.equal(h.stores.get(id).size,0,"request and result are removed after a day");
});

test("stalled provider bodies have a hard deadline; the failure is retrievable and the permit is released",async t=>{
  const h=fixture(t), original=setTimeout;
  t.mock.method(globalThis,"setTimeout",(fn,ms,...args)=>original(fn,ms>80000?5:ms,...args));
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json"))return Response.json({schema:1,candidates});
    if(url.includes("open-meteo"))return new Response("",{status:503});
    // A stuck reader ignores abort; a timer outside fetch still terminates work.
    return new Response(new ReadableStream({start(){}}));
  });
  await h.call();await h.job().alarm();
  assert.equal((await (await h.call("GET")).json()).status,"timeout");
  assert.equal(h.stores.get("outing-advice").get("advicePermit").leases.length,0);
});

test("alarm recovery never silently reruns an uncertain paid call; delayed jobs expire before generation",async t=>{
  const h=fixture(t);let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;throw new Error("unexpected");});
  await h.call();
  let raw=h.stores.get(id).get("job");raw.status="running";h.stores.get(id).set("job",raw);
  h.restart();await h.job().alarm();
  assert.equal((await (await h.call("GET")).json()).status,"unavailable");
  assert.equal(calls,0);
  raw=h.stores.get(id).get("job");raw.status="queued";raw.deadline=Date.now()-1;h.stores.get(id).set("job",raw);
  await h.job().alarm();
  assert.equal((await (await h.call("GET")).json()).status,"timeout");
  assert.equal(calls,0);
});
