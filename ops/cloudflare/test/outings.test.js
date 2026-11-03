import test from "node:test";
import assert from "node:assert/strict";
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
