/* Build replaces these constants; news-only publications keep the same shell version. */
const CACHE = "news-shell-__BUILD_ID__";
const APP_VERSION = "news-app-__APP_BUILD_ID__";
const SHELL = __SHELL_FILES__;
const NEWS_SHELL = __NEWS_SHELL__;
const GAMES_SHELL = __GAMES_SHELL__;
const GUIDE_SHELL = __GUIDE_SHELL__;
const HOMES_SHELL = __HOMES_SHELL__;
const GUIDE_FILES = __GUIDE_FILES__;
const GUIDE_REVISION = __GUIDE_REVISION__;
const CLIENT_CACHE = "news-reader-versions-v1";
const PAGE_SHELLS = {
  news: NEWS_SHELL,
  games: GAMES_SHELL,
  guide: GUIDE_SHELL,
  homes: HOMES_SHELL,
};
const PAGES = {
  "/": "/",
  "/index.html": "/",
  "/live": "/",
  "/live/": "/",
  "/live/index.html": "/",
  "/games": "/games/",
  "/games/": "/games/",
  "/games/index.html": "/games/",
  "/guide": "/guide/",
  "/guide/": "/guide/",
  "/guide/index.html": "/guide/",
  "/homes": "/homes/",
  "/homes/": "/homes/",
  "/homes/index.html": "/homes/",
  "/homes/live": "/homes/",
  "/homes/live/": "/homes/",
  "/homes/live/index.html": "/homes/",
};

const shellName = (name) =>
  typeof name === "string" && /^news-shell-[a-zA-Z0-9-]{1,100}$/.test(name);
const clientKey = (id) => "/__news_reader__/" + encodeURIComponent(id);
async function pruneShells() {
  // A different edition may still be installing. Its cache is not disposable.
  if (self.registration?.installing || self.registration?.waiting) return;
  const clients = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter((client) => {
    const url = new URL(client.url);
    return url.origin === self.location.origin &&
      Object.prototype.hasOwnProperty.call(PAGES, url.pathname);
  });
  const state = await caches.open(CLIENT_CACHE),
    keep = new Set([CACHE]);
  const live = new Set(clients.map((client) => clientKey(client.id)));
  for (const client of clients) {
    const record = await state.match(clientKey(client.id));
    // Older readers cannot identify their edition. Preserve their cache until
    // they close or refresh; automatic activation must not break an open game.
    if (!record) return;
    const name = (await record.json()).cacheName;
    if (!shellName(name)) return;
    keep.add(name);
  }
  // CacheStorage lists editions in creation order. An older worker finishing a
  // message must never delete a newer edition that just started installing.
  const editions = await caches.keys();
  for (const name of editions.slice(0, Math.max(0, editions.indexOf(CACHE))))
    if (name.startsWith("news-shell-") && !keep.has(name))
      await caches.delete(name);
  for (const request of await state.keys())
    if (!live.has(new URL(request.url).pathname)) await state.delete(request);
}

async function savedResource(path) {
  const current = await (await caches.open(CACHE)).match(path);
  if (current) return current;
  // Exact immutable paths only: an older open document keeps its own scripts
  // and guide chapters even after another tab has upgraded the worker.
  const previous = (await caches.keys())
    .filter((key) => key.startsWith("news-shell-") && key !== CACHE)
    .reverse();
  for (const name of previous) {
    const cache = await caches.open(name);
    if (
      Object.prototype.hasOwnProperty.call(PAGES, path) &&
      !(await cache.match("/__news_shell_version__"))
    ) continue;
    const saved = await cache.match(path);
    if (saved) return saved;
  }
}

async function validateShell(
  read,
  pages = Array.from(new Set(Object.values(PAGES))),
  assets = SHELL,
) {
  const html = (
    await Promise.all(
      pages.map(async (path) => {
        const response = await read(path);
        if (!response) throw new Error("Incomplete offline pages");
        return response.clone().text();
      }),
    )
  ).join("\n");
  const editions = [...html.matchAll(/name="news-shell-cache"\s+content="([^"]+)"/g)];
  if (editions.some((match) => match[1] !== CACHE))
    throw new Error("Page belongs to another offline edition");
  for (const asset of html.match(
    /\/assets\/news\/[\w.-]+\.[a-f0-9]{12}\.(?:json|js|css|svg)\b/g,
  ) || []) {
    if (!SHELL.includes(asset))
      throw new Error("Page assets belong to another deployment");
  }
  for (const asset of assets.filter((url) =>
    /\.[a-f0-9]{12}\.(js|css|svg|json)$/.test(url),
  )) {
    if (!html.includes(asset))
      throw new Error("Deployment changed during installation");
  }
}

// A single slow file must not leave installation or preparation waiting forever.
const downloads = new Map();
function download(path) {
  if (downloads.has(path))
    return downloads.get(path).then((response) => response.clone());
  const work = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(
        new Request(path, { cache: "reload", signal: controller.signal }),
      );
      if (!response.ok) throw new Error("Offline download failed");
      if (GUIDE_FILES.includes(path)) {
        const data = await response.clone().json();
        const chapter = Number(/\/chapters\/(\d+)\./.exec(path)[1]);
        if (
          data.schema !== 1 ||
          data.revision !== GUIDE_REVISION ||
          !data.entries?.length ||
          data.entries.some(
            (entry) =>
              entry.chapter !== chapter || typeof entry.body !== "string",
          )
        )
          throw new Error("Invalid guide chapter");
      } else await response.clone().arrayBuffer();
      return response;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => downloads.delete(path));
  downloads.set(path, work);
  return work.then((response) => response.clone());
}
async function stageMissing(cache, paths, report, keepCore = false) {
  const missing = [];
  for (const path of paths) if (!(await cache.match(path))) missing.push(path);
  const staged = new Map();
  let cursor = 0,
    failed = false;
  const savedChapters = new Set();
  if (report)
    for (const path of GUIDE_FILES)
      if (await cache.match(path)) savedChapters.add(path);
  const progress = () => {
    if (report)
      report({
        progress: true,
        done: savedChapters.size,
        total: GUIDE_FILES.length,
      });
  };
  await progress();
  await Promise.all(
    Array.from({ length: Math.min(3, missing.length) }, async () => {
      while (cursor < missing.length) {
        const path = missing[cursor++];
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await download(path);
            break;
          } catch {
            await progress();
          }
        }
        if (!response) failed = true;
        else if (keepCore || GUIDE_FILES.includes(path)) {
          await cache.put(path, response);
          if (GUIDE_FILES.includes(path)) savedChapters.add(path);
        } else staged.set(path, response);
        await progress();
      }
    }),
  );
  return { staged, failed };
}
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Keep previously prepared entrances usable across an update. First-time
      // news readers download only the news shell.
      const assets = new Set(NEWS_SHELL),
        pages = new Set(["/"]);
      for (const name of (await caches.keys()).filter(
        (name) => name.startsWith("news-shell-") && name !== CACHE,
      )) {
        const previous = await caches.open(name);
        for (const [page, group] of [
          ["/games/", GAMES_SHELL],
          ["/guide/", GUIDE_SHELL],
          ["/homes/", HOMES_SHELL],
        ])
          if (await previous.match(page)) {
            pages.add(page);
            group.forEach((path) => assets.add(path));
          }
      }
      const result = await stageMissing(cache, [...assets], null, true);
      if (result.failed) throw new Error("Incomplete offline download");
      try {
        await validateShell(
          (path) => cache.match(path),
          [...pages],
          [...assets],
        );
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
      // Reuse immutable chapters when only the page layout has changed.
      for (const name of (await caches.keys()).filter(
        (name) => name.startsWith("news-shell-") && name !== CACHE,
      )) {
        const previous = await caches.open(name);
        for (const path of GUIDE_FILES) {
          if (await cache.match(path)) continue;
          const saved = await previous.match(path);
          if (saved) await cache.put(path, saved);
        }
      }
      if (pages.has("/guide/")) {
        const chapters = await stageMissing(cache, GUIDE_FILES);
        if (chapters.failed) throw new Error("Incomplete offline guide");
      }
      await cache.put(
        "/__news_shell_version__",
        new Response(
          JSON.stringify({
            appVersion: APP_VERSION,
            pageShells: PAGE_SHELLS,
            guideFiles: GUIDE_FILES,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      // The complete offline edition is ready; no update banner or click needed.
      await self.skipWaiting();
    })(),
  );
});

// Complete chapters are stored immediately; retries only request missing chapters.
let repairing;
async function repairShell(page = "games", report) {
  if (repairing) {
    await repairing.catch(() => {});
    return repairShell(page, report);
  }
  repairing = (async () => {
    const cache = await caches.open(CACHE);
    const guide = page === "guide";
    const assets = guide
      ? GUIDE_SHELL
      : page === "homes"
        ? HOMES_SHELL
        : GAMES_SHELL;
    const paths = guide ? [...assets, ...GUIDE_FILES] : assets;
    const { staged, failed } = await stageMissing(cache, paths, report);
    await validateShell(
      (path) => staged.get(path) || cache.match(path),
      ["/", `/${page}/`],
      assets,
    );
    for (const [path, response] of staged) await cache.put(path, response);
    if (failed) throw new Error("Incomplete offline download");
  })().finally(() => {
    repairing = null;
  });
  return repairing;
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await pruneShells().catch(() => {});
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (
    event.data?.type === "CLIENT_VERSION" && event.source?.id &&
    shellName(event.data.cacheName)
  ) {
    event.waitUntil(
      (async () => {
        await (await caches.open(CLIENT_CACHE)).put(
          clientKey(event.source.id),
          new Response(JSON.stringify({ cacheName: event.data.cacheName }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
        await pruneShells();
      })().catch(() => {}),
    );
    return;
  }
  if (event.data?.type === "GET_VERSION" && event.ports[0]) {
    event.waitUntil(
      Promise.resolve().then(() =>
        event.ports[0].postMessage({
          appVersion: APP_VERSION,
          cacheName: CACHE,
        }),
      ),
    );
    return;
  }
  if (["ACTIVATE_UPDATE", "SKIP_WAITING"].includes(event.data?.type)) {
    self.skipWaiting();
    event.ports[0]?.postMessage({ accepted: true });
    return;
  }
  if (
    !["CHECK_OFFLINE", "PREPARE_OFFLINE"].includes(event.data?.type) ||
    !event.ports[0]
  )
    return;
  event.waitUntil(
    (async () => {
      try {
        const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
        const edition = shellName(event.data.cacheName)
          ? event.data.cacheName
          : CACHE;
        const cache = await caches.open(edition);
        const metadata = edition === CACHE
          ? { pageShells: PAGE_SHELLS, guideFiles: GUIDE_FILES }
          : await (await cache.match("/__news_shell_version__"))?.json();
        const page = ["guide", "homes"].includes(event.data.page)
          ? event.data.page
          : "games";
        const required = metadata?.pageShells?.[page];
        if (
          !paths.length ||
          paths.length > 64 ||
          !required ||
          !paths.every((path) => required.includes(path))
        ) {
          event.ports[0].postMessage({ ready: false, reason: "version" });
          return;
        }
        const guide = page === "guide";
        let repairFailed = false;
        if (event.data.type === "PREPARE_OFFLINE" && edition === CACHE) {
          try {
            await repairShell(page, (value) =>
              event.ports[0].postMessage(value),
            );
          } catch {
            repairFailed = true;
          }
        }
        const missing = [];
        // The Home Screen start URL is '/', even when installation starts in /games/.
        // Check the entire launch shell, not just assets of the currently open page.
        const complete = guide
          ? [...required, ...(metadata.guideFiles || [])]
          : required;
        for (const path of complete)
          if (!(await cache.match(path))) missing.push(path);
        event.ports[0].postMessage({
          ready: !missing.length,
          missing: missing.length,
          total: complete.length,
          reason: repairFailed
            ? "download"
            : missing.length
              ? "missing"
              : "ready",
        });
      } catch {
        event.ports[0].postMessage({ ready: false, reason: "storage" });
      }
    })(),
  );
});

async function navigation(request, page) {
  // A normal navigation/reload reads the latest published HTML. Keep saved HTML
  // paired with its own assets instead of overwriting it with another edition.
  if (self.navigator?.onLine !== false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(request, {
        cache: "no-cache",
        signal: controller.signal,
      });
      if (response.ok) {
        await response.clone().arrayBuffer();
        return response;
      }
    } catch {
      // Offline, failed or slow connections still open the saved edition.
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const cached = await savedResource(page);
    if (cached) return cached;
  } catch {
    /* Online browsing remains available when cache access is denied. */
  }
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    request.mode === "navigate" &&
    Object.prototype.hasOwnProperty.call(PAGES, url.pathname)
  ) {
    event.respondWith(navigation(request, PAGES[url.pathname]));
  } else if (
    (SHELL.includes(url.pathname) ||
      GUIDE_FILES.includes(url.pathname) ||
      /^\/assets\/news\/[\w.-]+\.[a-f0-9]{12}\.(?:json|js|css|svg)$/.test(url.pathname) ||
      /^\/guide\/chapters\/\d+\.[a-f0-9]{12}\.json$/.test(url.pathname)) &&
    !Object.prototype.hasOwnProperty.call(PAGES, url.pathname)
  ) {
    event.respondWith(
      (async () =>
        (await savedResource(url.pathname)) ||
        (GUIDE_FILES.includes(url.pathname)
          ? (async () => {
              const response = await download(url.pathname);
              await (
                await caches.open(CACHE)
              ).put(url.pathname, response.clone());
              return response;
            })()
          : fetch(request)))(),
    );
  }
  // News data and refresh APIs always use the network. app.js handles its explicit
  // last-successful-data fallback. Other paths are not intercepted.
});
