// A cached manual notebook must not prevent access to the new candidate page.
const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const H = require("../news/assets/homes-core.js");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");
const legacyHTML = `<!doctype html><meta charset="utf-8"><title>旧版我的看房</title>
  <h1>我的看房</h1><p>从收藏一套，到选好一个家</p><p>仅保存在当前浏览器，不自动同步。</p>
  <script>navigator.serviceWorker.register('/sw.js', {updateViaCache:'none'});</script>`;
// Preserve the original worker's cache-first navigation behavior and cache name
// prefix. No recovery URL or update prompt exists in this installed edition.
const legacyWorker = `const CACHE='news-shell-home-upgrade-legacy';
  self.addEventListener('install', e=>e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    await c.put('/homes/',new Response(${JSON.stringify(legacyHTML)},{headers:{'Content-Type':'text/html'}}));
  })()));
  self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch',e=>{
    const u=new URL(e.request.url);
    if(e.request.mode==='navigate'&&u.pathname==='/homes/')
      e.respondWith(caches.open(CACHE).then(c=>c.match('/homes/')));
  });
  self.addEventListener('message',e=>{
    if(e.data.type==='GET_VERSION') e.ports[0].postMessage({appVersion:'manual-only',cacheName:CACHE});
    if(e.data.type==='CHECK_OFFLINE') e.ports[0].postMessage({ready:false,reason:'version'});
  });`;

(async () => {
  let legacy = true,
    blockedDownloads = 0,
    blockInstall = true,
    markNetwork = false;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://local").pathname;
    if (legacy && ["/homes/", "/sw.js"].includes(pathname)) {
      return response
        .writeHead(200, {
          "Content-Type":
            pathname === "/sw.js" ? "text/javascript" : "text/html",
          "Cache-Control": "no-store",
        })
        .end(pathname === "/sw.js" ? legacyWorker : legacyHTML);
    }
    // An unavailable news asset can prevent a full offline update, even though
    // all of the home page's own assets and public listings remain reachable.
    if (blockInstall && /\/archive\.[a-f0-9]+\.js$/.test(pathname)) {
      blockedDownloads++;
      return response.writeHead(503).end("temporarily unavailable");
    }
    const file = path.resolve(
      root,
      "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname),
    );
    if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
    try {
      let body = await fs.readFile(file);
      if (markNetwork && pathname === "/homes/")
        body = Buffer.from(
          body
            .toString()
            .replace(
              '<main id="home-book"',
              '<main data-current-network="yes" id="home-book"',
            ),
        );
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
      };
      response
        .writeHead(200, {
          "Content-Type":
            mime[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.route("https://zacai.fun/api/homes/**", (route) =>
      route.abort(),
    );
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const workerErrors = [];
    const cdp = await context.newCDPSession(page);
    cdp.on("ServiceWorker.workerErrorReported", (event) =>
      workerErrors.push(event),
    );
    await cdp.send("ServiceWorker.enable");
    await page.goto(base + "/homes/");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const book = H.defaults();
    book.revision = 1;
    book.homes.push(
      H.home({
        id: "kept-home",
        name: "升级前收藏的房子",
        detail: "旧版留下的现场记录",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await page.evaluate(async (book) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("zrbac-home-book", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("notebook");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("notebook", "readwrite");
        tx.objectStore("notebook").put(book, "state");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      await caches.open("unrelated-upgrade-cache");
    }, book);
    legacy = false;
    await page.reload();
    assert.equal(
      await page.locator("#candidate-list").count(),
      0,
      "ordinary reload still uses the old installed page",
    );
    await page.goto(base + "/homes/live/");
    await page.evaluate(() =>
      Promise.all([window.homeCandidatesReady, window.homesInitialLoad]),
    );
    assert.equal(
      await page.locator(".candidate-card").count(),
      12,
      "new entrance works while the old worker is still active",
    );
    assert.deepEqual(
      await page.evaluate(() => window.HomeNotebook.snapshot()),
      book,
    );
    for (let i = 0; i < 100 && blockedDownloads < 2; i++)
      await page.waitForTimeout(100);
    assert(
      blockedDownloads >= 2,
      "the offline update genuinely encountered a download failure",
    );
    await page.waitForFunction(
      async () => !(await navigator.serviceWorker.getRegistration()).installing,
    );
    assert.equal(
      await page.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
      ),
      false,
    );
    assert.doesNotMatch(
      await page.locator("#offline-status").textContent(),
      /先点.*更新页面/,
      "do not ask for a missing update button",
    );
    assert.equal(
      await page.locator("#prepare-offline").textContent(),
      "重新检查",
    );
    assert.equal(await page.locator(".candidate-card").count(), 12);
    blockInstall = false;
    await page.locator("#prepare-offline").click();
    await page
      .locator("#pwa-update")
      .waitFor({ state: "visible" })
      .catch(async (error) => {
        console.error(
          "Upgrade diagnostics",
          workerErrors,
          await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return {
              active: reg.active?.state,
              waiting: reg.waiting?.state,
              installing: reg.installing?.state,
              status: document.querySelector("#offline-status").textContent,
              caches: await caches.keys(),
            };
          }),
        );
        throw error;
      });
    await Promise.all([
      page.waitForNavigation(),
      page.locator("#apply-update").click(),
    ]);
    await page.evaluate(() => window.homesInitialLoad);
    assert.deepEqual(
      await page.evaluate(() => window.HomeNotebook.snapshot()),
      book,
      "updating the worker preserves the notebook",
    );
    markNetwork = true;
    await page.goto(base + "/homes/");
    await page.locator('[data-current-network="yes"]').waitFor();
    await page.evaluate(() => window.homesInitialLoad);
    assert.deepEqual(
      await page.evaluate(() => window.HomeNotebook.snapshot()),
      book,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "home header fits " + width,
      );
    }
    await context.setOffline(true);
    await page.goto(base + "/homes/live/");
    await page.evaluate(() =>
      Promise.all([window.homeCandidatesReady, window.homesInitialLoad]),
    );
    assert.equal(
      await page.locator(".candidate-card").count(),
      12,
      "new entrance also has an offline fallback after updating",
    );
    assert.deepEqual(
      await page.evaluate(() => window.HomeNotebook.snapshot()),
      book,
    );
    assert(
      (await page.evaluate(() => caches.keys())).includes(
        "unrelated-upgrade-cache",
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: old manual cache, failed update without a prompt, fresh home entrance, preserved notebook, online updates and offline fallback.",
    );
    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
