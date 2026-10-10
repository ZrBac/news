/* Build replaces these constants; news-only publications keep the same shell version. */
const CACHE = "news-shell-__BUILD_ID__";
const SHELL = __SHELL_FILES__;
const GUIDE_SHELL = __GUIDE_SHELL__;
const GUIDE_FILES = __GUIDE_FILES__;
const GUIDE_REVISION = __GUIDE_REVISION__;
const PAGES = {
  "/": "/",
  "/index.html": "/",
  "/games": "/games/",
  "/games/": "/games/",
  "/games/index.html": "/games/",
  "/guide": "/guide/",
  "/guide/": "/guide/",
  "/guide/index.html": "/guide/",
};

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
      const result = await stageMissing(cache, SHELL, null, true);
      if (result.failed) throw new Error("Incomplete offline download");
      try {
        await validateShell((path) => cache.match(path));
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
    })(),
  );
});

// Complete chapters are stored immediately; retries only request missing chapters.
let repairing;
async function repairShell(guide = false, report) {
  if (repairing) {
    await repairing.catch(() => {});
    return repairShell(guide, report);
  }
  repairing = (async () => {
    const cache = await caches.open(CACHE);
    const assets = guide ? GUIDE_SHELL : SHELL;
    const paths = guide ? [...assets, ...GUIDE_FILES] : assets;
    const { staged, failed } = await stageMissing(cache, paths, report);
    await validateShell(
      (path) => staged.get(path) || cache.match(path),
      guide ? ["/", "/guide/"] : undefined,
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
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("news-shell-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE")
    event.waitUntil(self.skipWaiting());
  if (
    !["CHECK_OFFLINE", "PREPARE_OFFLINE"].includes(event.data?.type) ||
    !event.ports[0]
  )
    return;
  event.waitUntil(
    (async () => {
      try {
        const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
        if (
          !paths.length ||
          paths.length > 64 ||
          !paths.every((path) => SHELL.includes(path))
        ) {
          event.ports[0].postMessage({ ready: false, reason: "version" });
          return;
        }
        const guide = event.data.page === "guide";
        let repairFailed = false;
        if (event.data.type === "PREPARE_OFFLINE") {
          try {
            await repairShell(guide, (value) =>
              event.ports[0].postMessage(value),
            );
          } catch {
            repairFailed = true;
          }
        }
        const cache = await caches.open(CACHE),
          missing = [];
        // The Home Screen start URL is '/', even when installation starts in /games/.
        // Check the entire launch shell, not just assets of the currently open page.
        const required = guide ? [...GUIDE_SHELL, ...GUIDE_FILES] : SHELL;
        for (const path of required)
          if (!(await cache.match(path))) missing.push(path);
        event.ports[0].postMessage({
          ready: !missing.length,
          missing: missing.length,
          total: required.length,
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
  // Launch the installed version directly, including after a cold offline start.
  // HTML and its hashed assets switch together through the update button.
  try {
    const cached = await (await caches.open(CACHE)).match(page);
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
    (SHELL.includes(url.pathname) || GUIDE_FILES.includes(url.pathname)) &&
    !Object.prototype.hasOwnProperty.call(PAGES, url.pathname)
  ) {
    event.respondWith(
      (async () =>
        (await (await caches.open(CACHE)).match(url.pathname)) ||
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
