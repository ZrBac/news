const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs
  .readFileSync(require.resolve("../news/sw.js"), "utf8")
  .replace(
    "__SHELL_FILES__",
    JSON.stringify(["/", "/games/", "/guide/", "/assets/news/compat.test.js"]),
  );
function worker(options = {}) {
  const handlers = {},
    matches = [];
  const scope = vm.createContext({
    URL,
    Response,
    AbortController,
    Request: class extends Request {
      constructor(url, init) {
        super(new URL(url, "https://news.test"), init);
      }
    },
    setTimeout,
    clearTimeout,
    self: {
      location: { origin: "https://news.test" },
      addEventListener: (type, handler) => (handlers[type] = handler),
    },
    caches: {
      open: async () => ({
        match: async (path) => {
          matches.push(path);
          return options.entries
            ? options.entries.get(path)?.clone()
            : new Response("cached " + path);
        },
        put: async (path, response) =>
          options.entries.set(path, response.clone()),
      }),
    },
    fetch:
      options.fetch ||
      (async () => {
        throw new TypeError("offline");
      }),
  });
  vm.runInContext("Object.hasOwn = undefined;", scope);
  vm.runInContext(source, scope);
  function request(path, mode = "navigate", method = "GET") {
    let response;
    handlers.fetch({
      request: { url: new URL(path, "https://news.test").href, mode, method },
      respondWith: (value) => (response = value),
    });
    return response;
  }
  async function message(type, paths) {
    let result, work;
    handlers.message({
      data: { type, paths },
      ports: [{ postMessage: (value) => (result = value) }],
      waitUntil: (value) => (work = value),
    });
    await work;
    return result;
  }
  return { request, matches, message };
}
test("Offline navigation aliases return their matching HTML without Object.hasOwn", async () => {
  const { request } = worker();
  for (const [path, expected] of [
    ["/", "/"],
    ["/index.html", "/"],
    ["/games", "/games/"],
    ["/games/", "/games/"],
    ["/games/index.html", "/games/"],
    ["/games/?v=2", "/games/"],
    ["/guide", "/guide/"],
    ["/guide/", "/guide/"],
    ["/guide/index.html?from=home", "/guide/"],
  ]) {
    assert.equal(await (await request(path)).text(), "cached " + expected);
  }
});
test("Offline shell assets load and unrelated routes still bypass the worker", async () => {
  const { request, matches } = worker();
  assert.equal(
    await (await request("/assets/news/compat.test.js", "cors")).text(),
    "cached /assets/news/compat.test.js",
  );
  for (const path of [
    "/data/news.json",
    "/api/news-refresh",
    "/missing",
    "/toString",
    "https://elsewhere.test/games/",
  ])
    assert.equal(request(path), undefined);
  assert.equal(request("/games/", "navigate", "POST"), undefined);
  assert.deepEqual(matches, ["/assets/news/compat.test.js"]);
});

test("Cached navigation never waits on a stalled network request", async () => {
  let fetches = 0;
  const w = worker({
    fetch: () => {
      fetches++;
      return new Promise(() => {});
    },
  });
  assert.equal(await (await w.request("/games/")).text(), "cached /games/");
  assert.equal(fetches, 0);
});
test("Readiness includes the home-screen launch page, not only the game assets", async () => {
  const entries = new Map([
    ["/games/", new Response("games")],
    ["/guide/", new Response("guide")],
    ["/assets/news/compat.test.js", new Response("asset")],
  ]);
  const result = await worker({ entries }).message("CHECK_OFFLINE", [
    "/games/",
    "/assets/news/compat.test.js",
  ]);
  assert.equal(result.ready, false);
  assert.equal(result.missing, 1);
});
test("Repair fetches missing files and preserves existing cache entries", async () => {
  const entries = new Map([
      ["/games/", new Response("games")],
      ["/guide/", new Response("guide")],
      ["/assets/news/compat.test.js", new Response("asset")],
    ]),
    fetched = [];
  const w = worker({
    entries,
    fetch: async (request) => {
      fetched.push(new URL(request.url).pathname);
      return new Response("homepage");
    },
  });
  const result = await w.message("PREPARE_OFFLINE", ["/games/"]);
  assert.equal(result.ready, true);
  assert.deepEqual(fetched, ["/"]);
  assert.equal(await entries.get("/").text(), "homepage");
  assert.equal(await entries.get("/games/").text(), "games");
});
test("Repair never mixes a newer page with the current worker or erases working assets", async () => {
  const entries = new Map([
    ["/games/", new Response("games")],
    ["/guide/", new Response("guide")],
    ["/assets/news/compat.test.js", new Response("asset")],
  ]);
  const w = worker({
    entries,
    fetch: async () =>
      new Response('<script src="/assets/news/new.aaaaaaaaaaaa.js"></script>'),
  });
  const result = await w.message("PREPARE_OFFLINE", ["/games/"]);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "download");
  assert(!entries.has("/"));
  assert.equal(entries.size, 3);
  const failed = await worker({ entries }).message("PREPARE_OFFLINE", [
    "/games/",
  ]);
  assert.equal(failed.ready, false);
  assert.equal(entries.size, 3);
});
