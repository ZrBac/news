import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Workers runtime: SQLite coordinator serializes requests and keeps cooldown after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "news-worker-"));
  let dispatches = 0;
  let modelCalls = 0;
  const book = JSON.parse(
    await readFile(
      new URL("../../../news/guide/book.json", import.meta.url),
      "utf8",
    ),
  );
  const workflow = "/repos/ZrBac/news/actions/workflows/news.yml";
  const options = {
    modulesRoot: new URL("../../../", import.meta.url).pathname,
    modules: await Promise.all(
      [
        "../src/worker.js",
        "../src/guide.js",
        "../src/guide-prompt.js",
        "../../../news/assets/guide-core.js",
      ].map(async (path) => {
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
      GUIDE_API_URL: "https://model.test/chat/completions",
      GUIDE_MODEL: "test-model",
      GUIDE_API_KEY: "test-only",
      GUIDE_DAILY_LIMIT: "1",
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
      GUIDE_LIMITER: { namespace_id: "1002", simple: { limit: 6, period: 60 } },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/guide/search.json")
        return Response.json({
          ...book,
          entries: book.entries.map(({ body, url, ...entry }) => entry),
        });
      const chapter = /\/guide\/chapters\/(\d+)\./.exec(url.pathname);
      if (chapter)
        return Response.json({
          revision: book.revision,
          entries: book.entries.filter((e) => e.chapter === Number(chapter[1])),
        });
      if (url.origin === "https://model.test") {
        modelCalls++;
        const payload = await request.json();
        assert.equal(request.headers.get("Authorization"), "Bearer test-only");
        assert(payload.messages[1].content.includes("- 备注："));
        return Response.json({
          choices: [
            {
              message: {
                content: "先核对租赁合同和押金约定，见提供的第 15 节条目。",
              },
            },
          ],
        });
      }
      if (
        url.origin === "https://news.zacai.fun" &&
        url.pathname === "/data/status.json"
      )
        return Response.json({
          updatedAt: new Date(Date.now() - 10_800_000).toISOString(),
        });
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === workflow + "/runs")
        return Response.json({ workflow_runs: [] });
      assert.equal(url.pathname, workflow + "/dispatches");
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { ref: "hexo" });
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
    const ask = () =>
      mf.dispatchFetch("https://worker.test/api/life-guide/chat", {
        method: "POST",
        headers: {
          Origin: "https://news.zacai.fun",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: "房东不给退租房押金" }),
      });
    const answer = await ask();
    assert.equal(answer.status, 200, await answer.clone().text());
    assert(
      (await answer.json()).references.some((e) => e.id.startsWith("15-")),
    );
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal((await request()).status, "cooldown");
    assert.equal(dispatches, 1);
    assert.equal((await ask()).status, 429);
    assert.equal(modelCalls, 1);
  } finally {
    if (mf) await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
