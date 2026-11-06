import test from "node:test";
import assert from "node:assert/strict";
import worker, { NewsCoordinator } from "../src/worker.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-24T10:00:00Z");
const iso = (value) => new Date(value).toISOString();

function harness(t, initial = {}) {
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const stored = new Map(Object.entries(structuredClone(initial)));
  const storage = {
    async get(key) {
      return structuredClone(stored.get(key));
    },
    async put(key, value) {
      if (typeof key === "object")
        for (const [k, v] of Object.entries(key))
          stored.set(k, structuredClone(v));
      else stored.set(key, structuredClone(value));
    },
  };
  let serial = Promise.resolve();
  const ctx = {
    storage,
    blockConcurrencyWhile(fn) {
      const next = serial.then(fn);
      serial = next.catch(() => {});
      return next;
    },
  };
  const h = {
    runs: [],
    updatedAt: iso(NOW - 3 * HOUR),
    dispatches: 0,
    queries: 0,
    fail: null,
    stored,
    advance(ms) {
      now += ms;
    },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("https://news.zacai.fun/data/status.json?")) {
      if (h.fail === "health") return new Response("", { status: 502 });
      return Response.json({ updatedAt: h.updatedAt });
    }
    assert(
      url.startsWith(
        "https://api.github.com/repos/ZrBac/news/actions/workflows/news.yml/",
      ),
    );
    assert.equal(options.headers.Authorization, "Bearer test-only");
    if (url.endsWith("/dispatches")) {
      h.dispatches++;
      assert.deepEqual(JSON.parse(options.body), { ref: "main" });
      assert(stored.has("request"), "cooldown must be durable before dispatch");
      if (h.fail === "dispatch") throw new Error("timeout");
      return new Response(null, { status: 204 });
    }
    assert.equal(new URL(url).searchParams.get("branch"), "main");
    h.queries++;
    if (h.fail === "runs") return new Response("", { status: 503 });
    return Response.json({ workflow_runs: h.runs });
  });
  const env = {
    GITHUB_TOKEN: "test-only",
    MANUAL_ENABLED: "true",
    WATCHDOG_ENABLED: "true",
    SCHEDULE_ENABLED: "true",
    REQUEST_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  };
  let controller;
  h.restart = () => {
    controller = new NewsCoordinator(ctx, env);
  };
  h.restart();
  env.COORDINATOR = {
    idFromName: (name) => name,
    get: () => ({ fetch: (url) => controller.fetch(new Request(url)) }),
  };
  h.env = env;
  h.call = (path) => controller.fetch(new Request("https://internal/" + path));
  h.result = async (path) => (await h.call(path)).json();
  h.public = (path = "/api/news-refresh", options = {}) =>
    worker.fetch(
      new Request("https://api.example.com" + path, {
        method: "POST",
        headers: { Origin: "https://news.zacai.fun", "X-News-Refresh": "1" },
        body: "{}",
        ...options,
      }),
      env,
    );
  return h;
}

test("parallel manual and scheduled requests dispatch once; cooldown survives restart", async (t) => {
  const h = harness(t);
  const results = await Promise.all([
    h.result("trigger"),
    h.result("check"),
    h.result("trigger"),
  ]);
  assert.equal(h.dispatches, 1);
  assert.deepEqual(
    results.map((r) => r.status),
    ["running", "cooldown", "cooldown"],
  );
  h.restart();
  assert.equal((await h.result("trigger")).status, "cooldown");
  assert.equal(h.dispatches, 1);
});

test("hourly scheduler shares manual concurrency and skips a recent publication", async t => {
  const h=harness(t);
  const results=await Promise.all([h.result('periodic'),h.result('trigger'),h.result('periodic')]);
  assert.equal(h.dispatches,1);
  assert.equal(results[1].status,'cooldown');
  h.updatedAt=iso(Date.now());
  h.advance(30*60_000);
  assert.equal((await h.result('periodic')).status,'fresh');
  h.advance(20*60_000);
  await h.result('periodic');
  assert.equal(h.dispatches,2);
});

test("the 09:00 discovery slot can refresh a half-hour-old publication", async t => {
  const h=harness(t);
  h.advance(Date.parse('2026-09-25T01:00:00Z')-NOW);
  h.updatedAt=iso(Date.now()-30*60_000);
  await h.result('periodic');
  assert.equal(h.dispatches,1);
});

test("timed-out dispatch consumes manual and recovery budgets across restarts", async (t) => {
  const h = harness(t);
  h.fail = "dispatch";
  assert.equal((await h.call("check")).status, 503);
  assert.equal(h.stored.get("recovery").attempts.length, 1);
  h.restart();
  assert.equal((await h.result("trigger")).status, "cooldown");
  assert.equal((await h.result("check")).status, "cooldown");
  assert.equal(h.dispatches, 1);
});

test("recovery stops after three attempts and resumes after a new publication", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.result("check")).status, "dispatched");
    h.advance(2 * HOUR + 1);
  }
  assert.equal((await h.result("check")).status, "retry_limit");
  assert.equal(h.dispatches, 3);
  h.updatedAt = iso(Date.now());
  assert.equal((await h.result("check")).status, "fresh");
  assert.equal(h.stored.get("recovery").attempts.length, 0);
  h.advance(3 * HOUR);
  assert.equal((await h.result("check")).status, "dispatched");
  assert.equal(h.dispatches, 4);
});

test("recovery refuses older cached data and does not reset the retry budget", async (t) => {
  const h = harness(t, {
    recovery: { baselineAt: iso(NOW - HOUR), attempts: [NOW - HOUR] },
  });
  assert.equal((await h.result("check")).status, "older_cached_response");
  assert.equal(h.stored.get("recovery").attempts.length, 1);
  assert.equal(h.dispatches, 0);
});

test("rolling 24 hour budget expires", async (t) => {
  const h = harness(t, {
    recovery: {
      baselineAt: iso(NOW - 3 * HOUR),
      attempts: [NOW - 25 * HOUR, NOW - 24 * HOUR - 1, NOW - 3 * HOUR],
    },
  });
  assert.equal((await h.result("check")).status, "dispatched");
  assert.equal(h.stored.get("recovery").attempts.length, 2);
});

test("active and recent GitHub runs suppress dispatch", async (t) => {
  const h = harness(t);
  h.runs = [{ id: 123, status: "queued", created_at: iso(NOW - 1000) }];
  assert.equal((await h.result("trigger")).status, "running");
  assert.equal((await h.result("check")).status, "run_active");
  h.advance(11_000);
  h.runs[0].status = "completed";
  assert.equal((await h.result("trigger")).status, "cooldown");
  assert.equal((await h.result("check")).status, "cooldown");
  assert.equal(h.dispatches, 0);
});

test("fresh publication skips dispatch; invalid/future health fails closed", async (t) => {
  const h = harness(t);
  h.updatedAt = iso(NOW);
  assert.equal((await h.result("trigger")).status, "fresh");
  h.updatedAt = "invalid";
  assert.equal((await h.call("check")).status, 503);
  h.advance(11_000);
  h.updatedAt = iso(NOW + HOUR);
  assert.equal((await h.call("check")).status, 503);
  assert.equal(h.dispatches, 0);
});

test("upstream errors do not dispatch or repeatedly query GitHub", async (t) => {
  const h = harness(t);
  h.fail = "runs";
  assert.equal((await h.call("trigger")).status, 503);
  assert.equal((await h.call("status")).status, 503);
  assert.equal(h.queries, 1);
  h.advance(11_000);
  h.fail = "health";
  assert.equal((await h.call("check")).status, 503);
  assert.equal(h.dispatches, 0);
});

test("status follows delayed GitHub visibility, completion and failure; reads are cached", async (t) => {
  const h = harness(t);
  await h.result("trigger");
  assert.equal((await h.result("status")).status, "running");
  h.runs = [
    {
      id: 42,
      status: "completed",
      conclusion: "success",
      created_at: iso(NOW + 1000),
    },
  ];
  h.advance(11_000);
  assert.equal((await h.result("status")).status, "ready");
  const count = h.queries;
  await h.result("status");
  assert.equal(h.queries, count);
  h.runs[0].conclusion = "failure";
  h.advance(11_000);
  assert.equal((await h.result("status")).status, "failed");
  h.runs = [];
  h.advance(120_000);
  assert.equal((await h.result("status")).status, "failed");
  assert.equal(h.dispatches, 1);
});

test("public API validates origin, route, header, body and IP limit", async (t) => {
  const h = harness(t);
  assert.equal((await h.public("/check")).status, 404);
  assert.equal((await h.public("/api/news-refresh?repo=other")).status, 404);
  assert.equal(
    (await h.public(undefined, { headers: { Origin: "https://evil.example" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await h.public(undefined, {
        headers: { Origin: "https://news.zacai.fun" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await h.public(undefined, { body: '{"ref":"main"}' })).status,
    400,
  );
  assert.equal(
    (await h.public(undefined, { body: "a".repeat(129) })).status,
    413,
  );
  const preflight = await h.public(undefined, {
    method: "OPTIONS",
    body: undefined,
  });
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://news.zacai.fun",
  );
  assert.equal(preflight.status, 200);
  h.env.REQUEST_LIMITER.limit = async () => ({ success: false });
  assert.equal((await h.public()).status, 429);
  assert.equal(h.dispatches, 0);
});

test("staging flags prevent both manual and scheduled dispatch", async (t) => {
  const h = harness(t);
  h.env.MANUAL_ENABLED = "false";
  h.env.WATCHDOG_ENABLED = "false";
  assert.equal((await h.public()).status, 503);
  await worker.scheduled({}, h.env);
  assert.equal(h.dispatches, 0);
});
