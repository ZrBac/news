import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { NewsCoordinator } from "../src/worker.js";
import { messages, modelConfig } from "../src/guide.js";

const book = JSON.parse(
  readFileSync(new URL("../../../news/guide/book.json", import.meta.url)),
);
const origin = "https://news.zacai.fun";
const env = {
  GUIDE_API_URL: "https://api.deepseek.com/chat/completions",
  GUIDE_MODEL: "deepseek-flash",
  GUIDE_API_KEY: "test-only",
  GUIDE_LIMITER: { limit: async () => ({ success: true }) },
  COORDINATOR: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ status: "ok" }) }),
  },
};
const request = (path = "/chat", body = { question: "租房押金不退怎么办" }) =>
  new Request("https://worker.test/api/life-guide" + path, {
    method: path === "/status" ? "GET" : "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(path === "/status" ? {} : { body: JSON.stringify(body) }),
  });

test("Unconfigured service reports its state without contacting a model", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected_network");
  });
  const unconfigured = { ...env, GUIDE_API_KEY: "" };
  const response = await worker.fetch(request("/status"), unconfigured);
  assert.deepEqual(await response.json(), { ready: false });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  const result = await worker.fetch(request(), unconfigured);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).status, "unconfigured");
});
test("Origins, input size and arbitrary model/context overrides are rejected", async () => {
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.test/api/life-guide/status", {
          headers: { Origin: "https://evil.test" },
        }),
        env,
      )
    ).status,
    403,
  );
  for (const body of [
    { question: "" },
    { question: "x".repeat(1001) },
    { question: "租房", url: "https://evil.test" },
    { question: "租房", context: "fabricated" },
  ]) {
    assert.equal((await worker.fetch(request("/chat", body), env)).status, 400);
  }
  assert.equal(
    modelConfig({ ...env, GUIDE_API_URL: "http://localhost/chat/completions" }),
    null,
  );
  assert.equal(
    modelConfig({ ...env, GUIDE_API_URL: "https://key@host/chat/completions" }),
    null,
  );
});
test("Model receives whole verified entries; response and references are returned safely", async (t) => {
  let payload;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://news.zacai.fun/guide/search.json")
      return Response.json({
        ...book,
        entries: book.entries.map(({ body, url, ...entry }) => entry),
      });
    const chapter = /\/guide\/chapters\/(\d+)\./.exec(url);
    if (chapter)
      return Response.json({
        revision: book.revision,
        entries: book.entries.filter((e) => e.chapter === Number(chapter[1])),
      });
    assert.equal(url, env.GUIDE_API_URL);
    assert.equal(options.headers.Authorization, "Bearer test-only");
    assert.equal(options.redirect, "manual");
    payload = JSON.parse(options.body);
    return Response.json({
      choices: [{ message: { content: "先核对合同。第 15 节第 1 条。" } }],
    });
  });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, book.revision);
  assert(result.references.length > 0);
  assert.equal(payload.max_tokens, 2000);
  assert.equal(payload.thinking.type, "disabled");
  assert(payload.messages[0].content.includes("待核实"));
  for (const reference of result.references) {
    const entry = book.entries.find((e) => e.id === reference.id);
    assert(
      payload.messages[1].content.includes(
        JSON.stringify(entry.body).slice(1, -1),
      ),
    );
  }
});
test("Per-IP limit and persistent daily budget stop paid calls", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected_network");
  });
  const limited = {
    ...env,
    GUIDE_LIMITER: { limit: async () => ({ success: false }) },
  };
  assert.equal((await worker.fetch(request(), limited)).status, 429);
  const state = new Map();
  const ctx = {
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      get: async (key) => state.get(key),
      put: async (key, value) => state.set(key, value),
    },
  };
  let now = Date.parse("2026-10-10T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  let coordinator = new NewsCoordinator(ctx, { GUIDE_DAILY_LIMIT: "1" });
  const budget = () =>
    coordinator.fetch(new Request("https://internal/guide-budget"));
  assert.equal((await budget()).status, 200);
  coordinator = new NewsCoordinator(ctx, { GUIDE_DAILY_LIMIT: "1" });
  assert.equal((await budget()).status, 429);
  now += 86400000;
  assert.equal((await budget()).status, 200);
});
test("Prompt exposes source conditions and distinguishes evidence from author opinion", () => {
  const entry = book.entries.find((e) => e.pending);
  const prompt = messages(book, [entry], "问题");
  assert(prompt[0].content.includes("作者的判断"));
  assert(prompt[0].content.includes("不同收益口径"));
  assert(prompt[1].content.includes('"pending":true'));
});
