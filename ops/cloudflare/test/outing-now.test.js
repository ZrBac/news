import test from "node:test";
import assert from "node:assert/strict";
import worker, {NewsCoordinator} from "../src/worker.js";
import {generateAdvice, selectCandidates, weatherContext} from "../src/outing-now.js";

const now = Date.parse("2026-11-06T11:30:00Z");
const home = ["reading", "drawing", "story"].map(id => ({id:"event:tonight-"+id, name:id, setting:"home", group:"home", sources:[]}));
const place = (id, more={}) => ({id:"place:"+id, name:id, setting:"indoor", group:"rainy", checkedAt:"2026-11-06", sources:[{label:"来源",url:"https://example.com/"+id}], ...more});
const packet = {schema:1,updatedAt:"2026-11-06T09:00:00Z",candidates:[...home,place("craft"),place("old",{checkedAt:"2026-01-01"})]};
const input = {minutes:60, setting:"auto", note:"想积累点东西", previous:[]};
const profile = {schema:1,settings:{startArea:"杭州五常",people:2,transport:"car",weekendNote:"不要逛书店"},records:[]};
function forecast(stamp=now) {
  const day=new Date(stamp+8*3600000).toISOString().slice(0,10);
  return {current:{time:new Date(stamp+8*3600000).toISOString().slice(0,16),temperature_2m:18,precipitation:0,weather_code:2,wind_speed_10m:5,is_day:0},
    hourly:{time:[18,19,20,21,22,23].map(h=>day+"T"+h+":00"), precipitation_probability:[0,0,0,0,0,0],precipitation:[0,0,0,0,0,0],wind_speed_10m:[5,5,5,5,5,5],weather_code:[2,2,2,2,2,2]}};
}
const answer = {intro:"现在适合在家做点小事。",ideas:home.map(p=>({id:p.id,title:p.name,reason:"半小时能做完。",minutes:25,steps:["先拿出纸笔。","留下一个小成果。"],outcome:"一页记录"}))};
const modelResponse = a => ({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(a)}]}]});
function fixture() {
  const stores = new Map(), objects = new Map();
  const env={OPENAI_API_KEY:"test-value-do-not-expose",REQUEST_LIMITER:{limit:async()=>({success:true})}};
  env.COORDINATOR={idFromName:n=>n,get:name=>{
    if(!objects.has(name)) {
      const storage=new Map(); stores.set(name,storage);
      if(name==="outings")storage.set("outingProfile",structuredClone(profile));
      objects.set(name,new NewsCoordinator({blockConcurrencyWhile:fn=>fn(),storage:{get:async k=>structuredClone(storage.get(k)),put:async(k,v)=>storage.set(k,structuredClone(v))}},env));
    }
    return {fetch:r=>objects.get(name).fetch(r)};
  }};
  const call=(body=input,origin="https://news.zacai.fun",method="POST")=>worker.fetch(new Request("https://worker.example/api/outings/now",{
    method,headers:{Origin:origin,"Content-Type":"application/json"},...(method==="POST"?{body:JSON.stringify(body)}:{})}),env);
  return {env,stores,call};
}

test("advice filters expired events, stale sources, feedback, night outings and unsuitable weather",()=>{
  const candidates=[...home,place("visited"),place("wanted"),place("hike",{setting:"outdoor",group:"hiking"}),
    place("stale",{checkedAt:"2026-01-01"}),place("concert",{name:"演唱会"}),
    place("closed",{closed:true}),place("dynamic-old",{dynamic:true,checkedAt:"2026-10-28"}),
    place("stale-event",{id:"event:stale",group:"event",checkedAt:"2026-11-03",start:"2026-11-01",end:"2026-11-08"}),
    place("past",{id:"event:past",group:"event",start:"2026-11-01",end:"2026-11-05"}),
    place("future",{id:"event:future",group:"event",start:"2026-11-07",end:"2026-11-08"})];
  const p={...profile,records:[{id:"place:visited",title:"visited",status:"visited"},{id:"place:wanted",title:"wanted",status:"want"}]};
  const selected=selectCandidates({candidates},p,input,{outside:true,isDay:false},now);
  assert.deepEqual(selected.map(x=>x.id),["place:wanted",...home.map(x=>x.id)]);
  assert(selectCandidates({candidates},p,input,null,now).every(x=>x.setting!=="outdoor"));
  assert(selectCandidates({candidates},p,input,{outside:true,isDay:true},now+3*3600000).every(x=>x.setting==="home"));
  assert(selectCandidates({candidates},p,{...input,minutes:30},null,now).every(x=>x.setting==="home"));
  assert.equal(weatherContext(forecast(now-7200000),now,60),null);
  assert.equal(weatherContext({current:forecast().current,hourly:{time:[]}},now,60),null);
  assert.equal(weatherContext(forecast(),now,60).outside,true);
  const wet=forecast(); wet.hourly.precipitation_probability[2]=90;
  assert.equal(weatherContext(wet,now,60).outside,false);
});

test("real-time handler is explicit, bounded, and never reads journal content or returns provider secrets",async t=>{
  const {env,call,stores}=fixture(); let calls=0,payload;
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(url.includes("outing-now.json")) return Response.json(packet);
    if(url.includes("open-meteo")) return Response.json(forecast());
    assert.equal(url,"https://api.openai.com/v1/responses"); calls++;payload=JSON.parse(init.body);
    assert.equal(init.headers.Authorization,"Bearer test-value-do-not-expose");
    return Response.json(modelResponse(answer));
  });
  assert.equal((await call(input,"https://evil.example")).status,403);
  assert.equal((await call(input,undefined,"GET")).status,405);
  assert.equal((await call(input,undefined,"OPTIONS")).status,200);
  for(const body of [{...input,minutes:900},{...input,note:"x".repeat(301)},{...input,model:"other"},{...input,previous:["x".repeat(121)]},[]])
    assert.equal((await call(body)).status,400);
  assert.equal(calls,0);
  const response=await call(); const result=await response.json();
  assert.equal(response.status,200); assert.equal(result.ideas.length,3);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"https://news.zacai.fun");
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal(JSON.stringify(result).includes(env.OPENAI_API_KEY),false);
  assert.equal(payload.store,false);
  const material=JSON.parse(payload.input);
  assert.equal(material.preferences.sharedNote,"不要逛书店");
  assert.equal("journal" in material,false);
  assert.deepEqual(stores.get("outings").get("outingProfile"),profile);
  assert.equal(stores.get("outing-advice").get("advicePermit").leases.length,0);
  env.REQUEST_LIMITER.limit=async()=>({success:false});
  assert.equal((await call()).status,429);
  assert.equal(calls,1);
});

test("weather failure still permits home advice; invented venues, duplicate IDs and overlong plans fail closed",async t=>{
  const {env}=fixture();let output=modelResponse(answer);
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json"))return Response.json(packet);
    if(url.includes("open-meteo"))throw new Error("unavailable");
    return Response.json(output);
  });
  const result=await generateAdvice(env,input,now);
  assert.equal(result.weather,null);
  for(const replacement of [{...answer.ideas[0],id:"place:invented"},{...answer.ideas[0],minutes:90},{...answer.ideas[0],steps:[]}]) {
    output=modelResponse({...answer,ideas:[replacement,...answer.ideas.slice(1)]});
    await assert.rejects(generateAdvice(env,input,now),/invalid_response/);
  }
  output=modelResponse({...answer,ideas:[answer.ideas[0],answer.ideas[0],answer.ideas[2]]});
  await assert.rejects(generateAdvice(env,input,now),/invalid_response/);
  output={status:"incomplete",output:[]};
  await assert.rejects(generateAdvice(env,input,now),/invalid_response/);
});

test("provider failures release permits and concurrent advice does not lock shared feedback",async t=>{
  const {env,call,stores}=fixture();let finish,started;
  const ready=new Promise(r=>{started=r;});
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json"))return Response.json(packet);
    if(url.includes("open-meteo"))return Response.json(forecast());
    started(); return new Promise(r=>{finish=()=>r(new Response("secret-provider-detail",{status:500}));});
  });
  const ongoing=call();await ready;
  const response=await env.COORDINATOR.get("outings").fetch(new Request("https://internal/outing-profile",{method:"POST",body:JSON.stringify({action:"suggestion",text:"周末想试木工"})}));
  assert.equal(response.status,200);
  finish(); const failed=await ongoing;
  assert.equal(failed.status,503); assert.equal((await failed.text()).includes("secret"),false);
  assert.equal(stores.get("outing-advice").get("advicePermit").leases.length,0);
  const gate=env.COORDINATOR.get("outing-advice");
  const acquire=()=>gate.fetch(new Request("https://internal/advice-acquire",{method:"POST"}));
  assert.equal((await acquire()).status,200);assert.equal((await acquire()).status,200);assert.equal((await acquire()).status,429);
});

test("model deadline aborts slow fetch and releases the shared slot",async t=>{
  const {call,stores}=fixture();const original=globalThis.setTimeout;
  t.mock.method(globalThis,"setTimeout",(fn,ms,...args)=>original(fn,ms===45000?5:ms,...args));
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(url.includes("outing-now.json"))return Response.json(packet);
    if(url.includes("open-meteo"))return Response.json(forecast());
    return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));
  });
  const r=await call(); assert.equal(r.status,504);
  assert.equal(stores.get("outing-advice").get("advicePermit").leases.length,0);
});
