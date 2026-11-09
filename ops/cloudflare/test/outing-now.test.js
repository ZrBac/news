import test from "node:test";
import assert from "node:assert/strict";
import worker, {NewsCoordinator} from "../src/worker.js";
import {adviceIssues, generateAdvice, selectCandidates, suggestionApplies, suggestionContext, timeContext, weatherContext} from "../src/outing-now.js";

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
  const env={NEWS_SITE_URL:"https://news.example.com",OPENAI_API_KEY:"test-value-do-not-expose",REQUEST_LIMITER:{limit:async()=>({success:true})}};
  env.COORDINATOR={idFromName:n=>n,get:name=>{
    if(!objects.has(name)) {
      const storage=new Map(); stores.set(name,storage);
      if(name==="outings")storage.set("outingProfile",structuredClone(profile));
      objects.set(name,new NewsCoordinator({blockConcurrencyWhile:fn=>fn(),storage:{get:async k=>structuredClone(storage.get(k)),put:async(k,v)=>storage.set(k,structuredClone(v))}},env));
    }
    return {fetch:r=>objects.get(name).fetch(r)};
  }};
  const call=(body=input,origin="https://news.example.com",method="POST")=>worker.fetch(new Request("https://worker.example/api/outings/now",{
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
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"https://news.example.com");
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
  env.NEWS_SITE_URL="https://reader.example.org";
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json")) {
      assert.equal(url,"https://reader.example.org/data/outing-now.json");
      return Response.json(packet);
    }
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
  t.mock.method(globalThis,"setTimeout",(fn,ms,...args)=>original(fn,ms>44000 && ms<=45000?5:ms,...args));
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(url.includes("outing-now.json"))return Response.json(packet);
    if(url.includes("open-meteo"))return Response.json(forecast());
    return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));
  });
  const r=await call(); assert.equal(r.status,504);
  assert.equal(stores.get("outing-advice").get("advicePermit").leases.length,0);
});

test("Shanghai clock and saved relative dates remain anchored across UTC midnight and year boundaries",()=>{
  const noon = Date.parse("2026-11-08T05:17:00Z");
  assert.deepEqual(timeContext(noon,240),{timezone:"Asia/Shanghai",localNow:"2026-11-08T13:17+08:00",date:"2026-11-08",clock:"13:17",
    period:"下午",windowEnd:"2026-11-08T17:17+08:00",daylightWindow:true});
  assert.equal(timeContext(noon+8*3600000,30).period,"夜间");
  const afternoon = timeContext(noon+2*3600000,240);
  assert.equal(afternoon.daylightWindow,false,"a late-afternoon plan can extend into the evening");
  assert(adviceIssues({...answer,intro:"现在已是晚上。"},home,input,afternoon).includes("wrong_time_of_day"),"future evening plans do not make the current afternoon become night");
  assert.deepEqual(adviceIssues({...answer,intro:"现在是下午，可以安排到今晚。"},home,input,afternoon),[]);
  assert.equal(timeContext(Date.parse("2026-12-31T16:15:00Z"),60).date,"2027-01-01");
  const settings={weekendNoteUpdatedAt:"2026-12-31T16:10:00Z"};
  assert.deepEqual(suggestionContext(settings),{writtenAt:"2027-01-01T00:10+08:00",relativeDates:{今天:"2027-01-01",明天:"2027-01-02",后天:"2027-01-03"}});
  assert.equal(suggestionContext({}).relativeDates,null,"an undated old note is not anchored to today");
});

test("rain does not turn an explicit half-day outing into home projects when indoor venues exist",()=>{
  const noon=Date.parse("2026-11-08T05:17:00Z"), request={...input,minutes:240,setting:"outside",note:"雨天自驾"};
  const outside=[place("studio"),place("library"),place("craft")];
  const all={candidates:[...home,...outside,place("hill",{setting:"outdoor"})]};
  const wet={outside:false,isDay:true};
  assert.deepEqual(selectCandidates(all,profile,request,wet,noon).map(p=>p.id),outside.map(p=>p.id));
  assert(selectCandidates(all,profile,{...request,setting:"home"},wet,noon).every(p=>p.setting==="home"));
  const limited=selectCandidates({candidates:[...home,outside[0]]},profile,request,wet,noon);
  assert.equal(limited.filter(p=>p.setting!=="home").length,1);
  assert(adviceIssues(answer,limited,request,timeContext(noon,240)).includes("ignored_outside_choice"));
  assert(!adviceIssues({...answer,ideas:[{...answer.ideas[0],id:outside[0].id},...answer.ideas.slice(1)]},limited,request,timeContext(noon,240)).length);
});

test("a noon answer claiming it is evening is corrected using the same clock and outing choices",async t=>{
  const {env}=fixture(), noon=Date.parse("2026-11-08T05:17:00Z");
  const request={minutes:240,setting:"outside",note:"雨天自驾",previous:[]};
  const venues=[place("studio"),place("library"),place("craft")];
  const wrong={...answer,intro:"五常此刻已是晚上，先在家安排轻松短项目。"};
  const corrected={intro:"现在是下午，雨天可以自驾到室内场所。",ideas:venues.map(p=>({...answer.ideas[0],id:p.id,title:p.name,minutes:150}))};
  let calls=0;
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(url.includes("outing-now.json"))return Response.json({...packet,candidates:[...home,...venues]});
    if(url.includes("open-meteo"))return Response.json({current:{...forecast(noon).current,is_day:1},hourly:{
      time:[12,13,14,15,16,17,18].map(h=>"2026-11-08T"+h+":00"),precipitation_probability:Array(7).fill(77),
      precipitation:Array(7).fill(0.5),wind_speed_10m:Array(7).fill(8),weather_code:Array(7).fill(61)}});
    calls++;
    const body=JSON.parse(init.body), context=JSON.parse(body.input);
    assert.equal(context.time.localNow,"2026-11-08T13:17+08:00");
    assert.equal(context.time.windowEnd,"2026-11-08T17:17+08:00");
    assert.equal(context.weather.isDay,true);assert.equal(context.weather.outside,false);
    assert.equal(context.selection.requiredOutings,3);
    assert(context.candidates.every(p=>p.setting==="indoor"));
    if(calls===2)assert.match(body.instructions,/wrong_time_of_day/);
    return Response.json(modelResponse(calls===1?wrong:corrected));
  });
  const result=await generateAdvice(env,request,noon);
  assert.equal(calls,2);assert.equal(result.contextVersion,3);
  assert.equal(result.time.period,"下午");
  assert(result.ideas.every(p=>p.setting==="indoor" && p.minutes===150));
  assert(!/晚上|今晚/.test(result.intro));
});

test("current weather stays distinct from future rain; wrong claims are rejected but conditional plans remain valid",()=>{
  const data=forecast(), wet=data.hourly.precipitation_probability; wet[2]=90;
  const weather=weatherContext(data,now,60), timing=timeContext(now,60);
  assert.equal(weather.currentPrecipitationMm,0);
  assert.equal(weather.rainProbability,90);
  const wrong={...answer,intro:"五常此刻有雨，适合室内。"};
  assert(adviceIssues(wrong,home,input,timing,weather).includes("forecast_claimed_as_current_rain"));
  assert.deepEqual(adviceIssues({...answer,intro:"未来这段时间降雨概率高，可先选室内。"},home,input,timing,weather),[]);
  assert.deepEqual(adviceIssues(wrong,home,{...input,note:"外面正在下雨，想在家"},timing,weather),[],"an explicit local report may differ from the regional forecast");
  wet[2]=140;assert.equal(weatherContext(data,now,60),null,"invalid forecasts cannot authorize an outing");
});

test("one dated event is not three choices and distant outdoor venues need their own weather",()=>{
  const stamp=Date.parse("2026-11-08T05:17:00Z"), fresh={outside:true,isDay:true};
  const show=place("show",{id:"event:show-a",group:"event",name:"第二十届杭州文博会",start:"2026-11-06",end:"2026-11-08",checkedAt:"2026-11-08"});
  const candidates=[...home,show,{...show,id:"event:show-b",name:"第二十届杭州文化创意产业博览会"},
    place("local-hill",{setting:"outdoor",region:"hangzhou"}),
    place("distant-hill",{setting:"outdoor",region:"anji"}),
    place("legacy-distant",{setting:"outdoor",area:"安吉"})];
  const selected=selectCandidates({candidates},profile,{...input,minutes:240,setting:"outside"},fresh,stamp);
  assert.equal(selected.filter(p=>p.group==="event").length,1);
  assert(selected.some(p=>p.id==="place:local-hill"));
  assert(!selected.some(p=>/distant/.test(p.id)));
});

test("a saved tomorrow plan is not applied to now, and a timezone-less timestamp is not guessed",()=>{
  const settings={weekendNote:"明天只想听雨赏景",weekendNoteUpdatedAt:"2026-11-07T16:21:00Z"};
  assert.equal(suggestionApplies(settings,"2026-11-08"),false);
  assert.equal(suggestionApplies(settings,"2026-11-09"),true);
  assert.equal(suggestionApplies(settings,"2026-11-15"),false);
  assert.equal(suggestionApplies({...settings,weekendNote:"喜欢安静的地方"},"2026-11-08"),true);
  assert.equal(suggestionContext({...settings,weekendNoteUpdatedAt:"2026-11-08T00:21:00"}).relativeDates,null);
});

test("an old suggestion cannot silently postpone current advice; correction is bounded",async t=>{
  const noon=Date.parse("2026-11-08T05:17:00Z"), timing=timeContext(noon,240);
  assert(adviceIssues({...answer,ideas:[{...answer.ideas[0],title:"明天再出发"},...answer.ideas.slice(1)]},home,input,timing).includes("postponed_current_request"));
  const wrong={...answer,intro:"现在已经是夜间，先洗漱后休息。"};
  const {env}=fixture();let calls=0;
  t.mock.method(globalThis,"fetch",async url=>{
    if(url.includes("outing-now.json"))return Response.json(packet);
    if(url.includes("open-meteo"))throw new Error("unavailable");
    calls++;return Response.json(modelResponse(wrong));
  });
  await assert.rejects(generateAdvice(env,{...input,minutes:240},noon),/invalid_response/);
  assert.equal(calls,2,"do not publish another wrong-time answer or retry indefinitely");
  assert.deepEqual(adviceIssues({...answer,intro:"现在已是晚上，今晚在家休息。"},home,input,timeContext(now,60)),[],"evening requests retain evening wording");
});
