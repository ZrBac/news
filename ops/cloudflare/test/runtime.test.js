import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Workers runtime: SQLite coordinator serializes requests and keeps cooldown after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "news-worker-"));
  let dispatches = 0;
  const workflow = "/repos/ZrBac/news/actions/workflows/news.yml";
  const options = {
    modulesRoot: new URL("../../../", import.meta.url).pathname,
    modules: await Promise.all(
      ["../src/worker.js", "../src/outing-now.js"].map(async (path) => {
        const file = new URL(path, import.meta.url);
        return {
          type: "ESModule",
          path: file.pathname,
          contents: await readFile(file, "utf8"),
        };
      }),
    ),
    compatibilityDate: "2026-09-01",
    bindings: {
      GITHUB_TOKEN: "test-only",
      OPENAI_API_KEY: "test-only-model",
      MANUAL_ENABLED: "true",
      WATCHDOG_ENABLED: "true",
    },
    durableObjects: {
      COORDINATOR: { className: "NewsCoordinator", useSQLite: true },
    },
    resourcePersistencePath: directory,
    isolatedResourcePersistencePath: directory,
    ratelimits: {
      REQUEST_LIMITER: {
        namespace_id: "1001",
        simple: { limit: 60, period: 60 },
      },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      const ideas = ["reading", "drawing", "photos"].map(id => ({id:"event:tonight-" + id,
        name:id, title:id, reason:"下班后做一个小练习。", minutes:20, setting:"home", group:"home", sources:[],
        steps:["拿出手边的材料。", "留下一个小成果。"],outcome:"一条记录"}));
      if (url.pathname === "/data/outing-now.json") return Response.json({schema:1,updatedAt:new Date().toISOString(),candidates:ideas});
      if (url.hostname === "api.open-meteo.com") return new Response("unavailable", {status:503});
      if (url.hostname === "api.openai.com") {
        assert.equal(request.headers.get("Authorization"),"Bearer test-only-model");
        const input=await request.json();
        assert.equal(input.store,false);
        return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({intro:"现在适合在家做一点小事。",ideas})}]}]});
      }
      if (
        url.origin === "https://news.zacai.fun" &&
        url.pathname === "/data/status.json"
      )
        return Response.json({
          updatedAt: new Date(Date.now() - 10_800_000).toISOString(),
        });
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === workflow + "/runs") {
        assert.equal(url.searchParams.get("branch"), "main");
        return Response.json({ workflow_runs: [] });
      }
      assert.equal(url.pathname, workflow + "/dispatches");
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { ref: "main" });
      dispatches++;
      return new Response(null, { status: 204 });
    },
  };
  let mf;
  const request = async () => {
    const response = await mf.dispatchFetch(
      "https://api.example.com/api/news-refresh",
      {
        method: "POST",
        headers: { Origin: "https://news.zacai.fun", "X-News-Refresh": "1" },
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const results = await Promise.all(Array.from({ length: 8 }, request));
    assert.equal(results.filter((r) => r.status === "running").length, 1);
    assert.equal(results.filter((r) => r.status === "cooldown").length, 7);
    const advice = await mf.dispatchFetch("https://api.example.com/api/outings/now", {method:"POST",
      headers:{Origin:"https://news.zacai.fun","Content-Type":"application/json"},
      body:JSON.stringify({minutes:30,setting:"home",note:"想做一点有积累的事",previous:[]})});
    assert.equal(advice.status,200);
    assert.equal((await advice.json()).ideas.length,3,"real Workers fetch, shared profile and model response work together");
    const profileUrl = "https://api.example.com/api/outings/profile";
    const profileHeaders = {Origin:"https://news.zacai.fun"};
    const saved = await mf.dispatchFetch(profileUrl, {method:"POST", headers:profileHeaders,
      body:JSON.stringify({action:"record",id:"place:craft",title:"室内手作",status:"visited"})});
    assert.equal(saved.status,200);
    const journalUrl="https://api.example.com/api/outings/journal";
    const record={id:"evening-"+"a".repeat(24),activityId:"event:tonight-reading",title:"阅读进展",
      note:"这个内容不应出现在AI的偏好输入",next:"下一页继续",createdAt:"2026-11-06T01:00:00Z"};
    const journalSaved=await mf.dispatchFetch(journalUrl,{method:"POST",headers:profileHeaders,
      body:JSON.stringify({schema:1,operations:[{id:"op-"+"b".repeat(24),action:"put",record}]})});
    assert.equal(journalSaved.status,200);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const stored = await (await mf.dispatchFetch(profileUrl,{headers:profileHeaders})).json();
    assert.equal(stored.records[0].status,"visited", "shared records persist in their separate SQLite object");
    assert.equal(JSON.stringify(stored).includes(record.note),false);
    const journalStored=await (await mf.dispatchFetch(journalUrl,{headers:profileHeaders})).json();
    assert.equal(journalStored.records[0].note,record.note,"journal survives a real SQLite runtime restart");
    assert.equal((await request()).status, "cooldown");
    assert.equal(dispatches, 1);
  } finally {
    if (mf) await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
