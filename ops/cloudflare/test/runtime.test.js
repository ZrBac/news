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
      ["../src/worker.js"].map(async (path) => {
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
      MANUAL_ENABLED: "true",
      WATCHDOG_ENABLED: "true",
      OUTING_PROFILE_TOKEN: "test-private-profile",
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
    const profileUrl = "https://api.example.com/api/outings/profile";
    const profileHeaders = {Origin:"https://news.zacai.fun", Authorization:"Bearer test-private-profile"};
    const saved = await mf.dispatchFetch(profileUrl, {method:"POST", headers:profileHeaders,
      body:JSON.stringify({action:"record",id:"place:craft",title:"室内手作",status:"visited"})});
    assert.equal(saved.status,200);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const stored = await (await mf.dispatchFetch(profileUrl,{headers:profileHeaders})).json();
    assert.equal(stored.records[0].status,"visited", "private records persist in their separate SQLite object");
    assert.equal((await request()).status, "cooldown");
    assert.equal(dispatches, 1);
  } finally {
    if (mf) await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
