/* Build replaces these constants; news-only publications keep the same shell version. */
const CACHE = "news-shell-__BUILD_ID__";
const SHELL = __SHELL_FILES__;
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

async function validateShell(read) {
  const html = (
    await Promise.all(
      Array.from(new Set(Object.values(PAGES))).map(async (path) => {
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
  for (const asset of SHELL.filter((url) =>
    /\.[a-f0-9]{12}\.(js|css|svg|json)$/.test(url),
  )) {
    if (!html.includes(asset))
      throw new Error("Deployment changed during installation");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await cache.addAll(
          SHELL.map((url) => new Request(url, { cache: "reload" })),
        );
        await validateShell((path) => cache.match(path));
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
    })(),
  );
});

// Repair evicted files without clearing saves, registrations, or working cache entries.
let repairing;
function repairShell() {
  if (repairing) return repairing;
  repairing = (async () => {
    const cache = await caches.open(CACHE),
      staged = new Map();
    const missing = [];
    for (const path of SHELL)
      if (!(await cache.match(path))) missing.push(path);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, missing.length) }, async () => {
        while (cursor < missing.length) {
          const path = missing[cursor++],
            controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          try {
            const response = await fetch(
              new Request(path, { cache: "reload", signal: controller.signal }),
            );
            if (!response.ok) throw new Error("Offline download failed");
            // Read the complete body while the timeout is active.
            await response.clone().arrayBuffer();
            staged.set(path, response);
          } finally {
            clearTimeout(timer);
          }
        }
      }),
    );
    // Do not put newer HTML into an older worker's shell during repair.
    await validateShell((path) => staged.get(path) || cache.match(path));
    for (const [path, response] of staged) await cache.put(path, response);
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
        let repairFailed = false;
        if (event.data.type === "PREPARE_OFFLINE") {
          try {
            await repairShell();
          } catch {
            repairFailed = true;
          }
        }
        const cache = await caches.open(CACHE),
          missing = [];
        // The Home Screen start URL is '/', even when installation starts in /games/.
        // Check the entire launch shell, not just assets of the currently open page.
        for (const path of SHELL)
          if (!(await cache.match(path))) missing.push(path);
        event.ports[0].postMessage({
          ready: !missing.length,
          missing: missing.length,
          total: SHELL.length,
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
    SHELL.includes(url.pathname) &&
    !Object.prototype.hasOwnProperty.call(PAGES, url.pathname)
  ) {
    event.respondWith(
      (async () =>
        (await (await caches.open(CACHE)).match(url.pathname)) ||
        fetch(request))(),
    );
  }
  // News data and refresh APIs always use the network. app.js handles its explicit
  // last-successful-data fallback. Other paths are not intercepted.
});
