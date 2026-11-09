const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs
  .readFileSync(require.resolve("../news/sw.js"), "utf8")
  .replace(
    "__SHELL_FILES__",
    JSON.stringify([
      "/",
      "/games/",
      "/guide/",
      "/homes/",
      "/assets/news/compat.test.js",
    ]),
  )
  .replace(
    "__NEWS_SHELL__",
    JSON.stringify(["/", "/assets/news/compat.test.js"]),
  )
  .replace(
    "__GAMES_SHELL__",
    JSON.stringify(["/", "/games/", "/assets/news/compat.test.js"]),
  )
  .replace(
    "__GUIDE_SHELL__",
    JSON.stringify(["/", "/guide/", "/assets/news/compat.test.js"]),
  )
  .replace(
    "__HOMES_SHELL__",
    JSON.stringify(["/", "/homes/", "/assets/news/compat.test.js"]),
  )
  .replace(
    "__GUIDE_FILES__",
    JSON.stringify([
      "/guide/chapters/1.aaaaaaaaaaaa.json",
      "/guide/chapters/2.aaaaaaaaaaaa.json",
    ]),
  )
  .replace("__GUIDE_REVISION__", JSON.stringify("a".repeat(40)))
  .replace("__BUILD_ID__", "a".repeat(16));
function worker(options = {}) {
  const handlers = {},
    matches = [],
    buckets = options.buckets || new Map(),
    clients = options.clients || [];
  const key = (path) => typeof path === "string" ? path : new URL(path.url).pathname;
  const scope = vm.createContext({
    URL,
    Response,
    AbortController,
    Request: class extends Request {
      constructor(url, init) {
        super(new URL(url, "https://news.test"), init);
      }
    },
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout,
    self: {
      location: { origin: "https://news.test" },
      navigator: { onLine: options.online !== false },
      addEventListener: (type, handler) => (handlers[type] = handler),
      skipWaiting: options.skipWaiting || (async () => {}),
      registration: options.registration || {},
      clients: { claim: async () => {}, matchAll: async () => clients },
    },
    caches: {
      keys: async () => [...buckets.keys()],
      delete: async (name) => buckets.delete(name),
      open: async (name) => {
        if (!buckets.has(name)) buckets.set(name, options.entries || new Map());
        const entries = buckets.get(name);
        return {
          match: async (path) => {
            matches.push(key(path));
            return options.entries || options.buckets ? entries.get(key(path))?.clone() : new Response("cached " + key(path));
          },
          put: async (path, response) => entries.set(key(path), response.clone()),
          keys: async () => [...entries.keys()].map(path => new Request(new URL(path, "https://news.test"))),
          delete: async (path) => entries.delete(key(path)),
        };
      },
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
  async function message(type, paths, page, reply = true, extra = {}, client) {
    let result, work;
    handlers.message({
      data: { type, paths, page, ...extra },
      source: client,
      ports: reply ? [{ postMessage: (value) => (result = value) }] : [],
      waitUntil: (value) => (work = value),
    });
    await work;
    return result;
  }
  async function lifecycle(type) {
    let work;
    handlers[type]({waitUntil: value => { work = value; }});
    await work;
  }
  return { request, matches, message, lifecycle };
}
test("Offline navigation aliases return their matching HTML without Object.hasOwn", async () => {
  const { request } = worker();
  for (const [path, expected] of [
    ["/", "/"],
    ["/index.html", "/"],
    ["/live/", "/"],
    ["/games", "/games/"],
    ["/games/", "/games/"],
    ["/games/index.html", "/games/"],
    ["/games/?v=2", "/games/"],
    ["/guide", "/guide/"],
    ["/guide/", "/guide/"],
    ["/guide/index.html?from=home", "/guide/"],
    ["/homes", "/homes/"],
    ["/homes/", "/homes/"],
    ["/homes/index.html?from=housing", "/homes/"],
    ["/homes/live/", "/homes/"],
  ]) {
    assert.equal(await (await request(path)).text(), "cached " + expected);
  }
});

test("Home notebook preparation does not download games or guide chapters", async () => {
  const entries = new Map([
    ["/", new Response("home")],
    ["/assets/news/compat.test.js", new Response("asset")],
  ]);
  const fetched = [];
  const w = worker({
    entries,
    fetch: async (request) => {
      fetched.push(new URL(request.url).pathname);
      return new Response("home notebook");
    },
  });
  const result = await w.message("PREPARE_OFFLINE", ["/homes/"], "homes");
  assert.equal(result.ready, true);
  assert.deepEqual(fetched, ["/homes/"]);
  assert.equal(await (await w.request("/homes/")).text(), "home notebook");
});
test("Workers identify the UI version separately from their offline content", async () => {
  const result = await worker().message("GET_VERSION");
  assert.equal(result.appVersion, "news-app-__APP_BUILD_ID__");
});
test("Update activation accepts both legacy messages and acknowledged requests", async () => {
  let activations = 0;
  const w = worker({ skipWaiting: async () => activations++ });
  await w.message("ACTIVATE_UPDATE", undefined, undefined, false);
  assert.equal(activations, 1);
  assert.equal((await w.message("ACTIVATE_UPDATE")).accepted, true);
  assert.equal(activations, 2);
});
test("A complete offline install activates automatically; a failed install cannot replace it", async () => {
  let activated = 0;
  const complete = worker({entries: new Map(), fetch: async () => new Response("page or asset"), skipWaiting: async () => activated++});
  await complete.lifecycle("install");
  assert.equal(activated, 1);
  const broken = worker({entries: new Map(), fetch: async () => { throw new Error("unavailable"); }, skipWaiting: async () => activated++});
  await assert.rejects(broken.lifecycle("install"));
  assert.equal(activated, 1);
  const mixed = worker({entries: new Map(), fetch: async () => new Response('<meta name="news-shell-cache" content="news-shell-another">'), skipWaiting: async () => activated++});
  await assert.rejects(mixed.lifecycle("install"));
  assert.equal(activated, 1, "a partial CDN publication cannot activate a mixed edition");
});
test("An open older tab keeps its exact assets until it closes; unrelated caches survive", async () => {
  const current = "news-shell-" + "a".repeat(16), old = "news-shell-old";
  const path = "/assets/news/old.111111111111.js";
  const buckets = new Map([[old, new Map([[path, new Response("old script")]])],
    ["news-shell-unused", new Map()], [current, new Map()],
    ["unrelated-cache", new Map()], ["news-shell-next-install", new Map()]]);
  const clients = [{id:"old-tab",url:"https://news.test/games/"}, {id:"new-tab",url:"https://news.test/"}];
  const w = worker({buckets, clients});
  await w.message("CLIENT_VERSION", undefined, undefined, false, {cacheName: old}, clients[0]);
  assert(buckets.has("news-shell-unused"), "an unidentified client prevents premature cleanup");
  await w.message("CLIENT_VERSION", undefined, undefined, false, {cacheName: current}, clients[1]);
  assert(buckets.has(old));
  assert(!buckets.has("news-shell-unused"));
  assert.equal(await (await w.request(path, "cors")).text(), "old script");
  clients.shift();
  await w.message("CLIENT_VERSION", undefined, undefined, false, {cacheName: current}, clients[0]);
  assert(!buckets.has(old));
  assert(buckets.has("unrelated-cache"));
  assert(buckets.has("news-shell-next-install"), "an older worker cannot delete a concurrently installing edition");
});
test("An automatic update keeps a previously prepared guide complete before activation", async () => {
  const first = "/guide/chapters/1.aaaaaaaaaaaa.json", second = "/guide/chapters/2.aaaaaaaaaaaa.json";
  const buckets = new Map([["news-shell-old", new Map([
    ["/guide/", new Response("saved guide")],
    [first, new Response("unchanged chapter")],
  ])]]);
  let blocked = true, activated = 0;
  const fetched = [];
  const w = worker({buckets, skipWaiting: async () => activated++, fetch: async request => {
    const path = new URL(request.url).pathname;
    fetched.push(path);
    if (path === second) {
      if (blocked) throw new Error("unavailable chapter");
      return Response.json({schema: 1, revision: "a".repeat(40), entries: [{chapter: 2, body: "new chapter"}]});
    }
    return new Response("page or asset");
  }});
  await assert.rejects(w.lifecycle("install"));
  assert.equal(activated, 0, "an incomplete new guide cannot replace the saved edition");
  blocked = false;
  fetched.length = 0;
  await w.lifecycle("install");
  assert.equal(activated, 1);
  assert.deepEqual(fetched, [second], "unchanged and completed downloads are reused");
  assert.equal((await w.message("CHECK_OFFLINE", ["/guide/"], "guide")).ready, true);
});
test("Offline navigation never falls back to an unfinished installation", async () => {
  const buckets = new Map([
    ["news-shell-complete", new Map([["/guide/", new Response("saved guide")], ["/__news_shell_version__", Response.json({})]])],
    ["news-shell-incomplete", new Map([["/guide/", new Response("unfinished guide")]])],
  ]);
  const w = worker({buckets, online: false});
  assert.equal(await (await w.request("/guide/")).text(), "saved guide");
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

test("Offline navigation never waits on a stalled network request", async () => {
  let fetches = 0;
  const w = worker({
    online: false,
    fetch: () => {
      fetches++;
      return new Promise(() => {});
    },
  });
  assert.equal(await (await w.request("/games/")).text(), "cached /games/");
  assert.equal(fetches, 0);
});
test("Every entry reads new HTML online without replacing the installed fallback", async () => {
  const entries = new Map([["/homes/", new Response("installed notebook")]]);
  const w = worker({
    entries,
    fetch: async () => new Response("new candidates"),
  });
  for (const path of ["/", "/live/", "/index.html", "/games/", "/guide/", "/homes/", "/homes/live/", "/homes/index.html"])
    assert.equal(await (await w.request(path)).text(), "new candidates");
  assert.equal(await entries.get("/homes/").text(), "installed notebook");
});
test("Home navigation uses its saved page offline and after a bounded network timeout", async () => {
  let calls = 0,
    deadline;
  const offline = worker({
    online: false,
    fetch: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  assert.equal(
    await (await offline.request("/homes/live/")).text(),
    "cached /homes/",
  );
  assert.equal(calls, 0);
  const slow = worker({
    setTimeout: (fn, ms) => {
      deadline = ms;
      return setTimeout(fn, 1);
    },
    fetch: (_request, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("timeout"))),
      ),
  });
  assert.equal(await (await slow.request("/homes/")).text(), "cached /homes/");
  assert.equal(deadline, 3500);
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

test("Guide preparation keeps completed chapters and retries only the failed chapter", async () => {
  const entries = new Map([
    ["/", new Response("home")],
    ["/guide/", new Response("guide")],
    ["/assets/news/compat.test.js", new Response("asset")],
  ]);
  const fetched = [];
  let unavailable = true;
  const w = worker({
    entries,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      fetched.push(path);
      if (unavailable && path.includes("/2."))
        return new Response("failed", { status: 503 });
      const chapter = Number(/chapters\/(\d+)/.exec(path)[1]);
      return Response.json({
        schema: 1,
        revision: "a".repeat(40),
        entries: [{ id: chapter + "-1", chapter, body: "正文及备注" }],
      });
    },
  });
  const failed = await w.message("PREPARE_OFFLINE", ["/guide/"], "guide");
  assert.equal(failed.ready, false);
  assert.equal(failed.missing, 1);
  assert(entries.has("/guide/chapters/1.aaaaaaaaaaaa.json"));
  unavailable = false;
  fetched.length = 0;
  const ready = await w.message("PREPARE_OFFLINE", ["/guide/"], "guide");
  assert.equal(ready.ready, true);
  assert.deepEqual(fetched, ["/guide/chapters/2.aaaaaaaaaaaa.json"]);
  assert(
    !entries.has("/games/"),
    "guide readiness must not depend on missing game files",
  );
  assert.equal(
    await (await w.request("/guide/chapters/1.aaaaaaaaaaaa.json", "cors"))
      .json()
      .then((data) => data.entries[0].body),
    "正文及备注",
  );
});
