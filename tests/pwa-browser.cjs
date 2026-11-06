// Run against a locally built site: NEWS_TEST_SITE=/tmp/news-pwa-preview node tests/pwa-browser.cjs
// DevTools network instrumentation can restart a retiring Chromium worker and
// stall activation. Keep lifecycle workers uninstrumented; the HTTP fixture
// also disconnects during outages so offline assertions still lose the network.
process.env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK = "1";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const waitForBrowser = require("./browser-poll.cjs");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");

(async () => {
  let networkOffline = false;
  let revision = 1;
  let appRevision = 1;
  let dataTime;
  let blockInstall = false;
  const server = http.createServer(async (request, response) => {
    if (networkOffline) return request.destroy();
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (blockInstall && /\/archive\.[a-f0-9]+\.js$/.test(pathname))
      return response.writeHead(503).end("temporarily unavailable");
    const target = path.resolve(
      root,
      "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname),
    );
    if (!target.startsWith(root + path.sep))
      return response.writeHead(404).end();
    try {
      let body = await fs.readFile(target);
      if (target.endsWith("index.html"))
        body = Buffer.from(body.toString()
          .replace(/news-shell-([a-f0-9]{16})/, "news-shell-$1-test" + revision)
          .replace("<body", '<body data-test-revision="' + revision + '"'));
      if (pathname === "/sw.js")
        body = Buffer.from(
          body
            .toString()
            .replace(/news-shell-([a-f0-9]{16})/, "news-shell-$1-test" + revision)
            .replace(/news-app-([a-f0-9]+)/, "news-app-$1-test" + appRevision),
        );
      if (pathname === "/sw.js" && process.env.NEWS_LEGACY_SAFARI)
        body = Buffer.from("Object.hasOwn = undefined;\n" + body.toString());
      if (
        ["/data/news.json", "/data/latest.json", "/data/status.json"].includes(
          pathname,
        ) &&
        dataTime
      ) {
        const data = JSON.parse(body);
        data.updatedAt = dataTime;
        body = Buffer.from(JSON.stringify(data));
      }
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      response
        .writeHead(200, {
          "Content-Type":
            types[path.extname(target)] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "Content-Length": body.length,
        })
        .end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    async function setOffline(offline) {
      networkOffline = offline;
      await context.setOffline(offline);
    }
    // Exercise manual installation instructions without opening a native OS dialog.
    await context.addInitScript(() =>
      window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }),
    );
    if (process.env.NEWS_LEGACY_SAFARI)
      await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Offline/update behavior must also be testable with yesterday's snapshot,
    // when today's daily brief correctly has no articles yet.
    await page.goto(base + "/#all", { waitUntil: "networkidle" });
    await page.locator(".article").first().waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert(
      await page.locator("#pwa-update").isHidden(),
      "first offline installation must not be reported as an application update",
    );
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    assert.deepEqual(manifest.errors, []);
    assert.equal(JSON.parse(manifest.data).display, "standalone");
    const installability = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installability.installabilityErrors, []);

    await page.click("#install-app");
    assert.equal(await page.locator("#dialog-title").innerText(), "安装到桌面");
    assert.match(
      await page.locator("#dialog-content").innerText(),
      /添加到主屏幕/,
    );
    if (process.env.NEWS_LEGACY_SAFARI) {
      assert(
        await page
          .locator("#info-dialog")
          .evaluate((el) => el.classList.contains("legacy-dialog")),
      );
      await page.keyboard.press("Tab");
      assert(
        await page
          .locator("#info-dialog")
          .evaluate((el) => el.contains(document.activeElement)),
      );
      await page.keyboard.press("Escape");
      assert(await page.locator("#info-dialog").isHidden());
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "install-app",
      );
      await page.click("#install-app");
    }
    await page.click("#close-dialog");
    assert(await page.locator("#info-dialog").isHidden());
    await page.click(".save-button >> nth=0");
    const savedTitle = await page.locator(".article h3").first().innerText();
    const before = await page.evaluate(
      () => JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).updatedAt,
    );

    await setOffline(true);
    await page.reload({ waitUntil: "networkidle" });
    // Chromium's navigator emulation can reset across a service-worker navigation.
    // Keep both the transport and the simulated OS connectivity state offline.
    await cdp.send("Network.overrideNetworkState", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.locator(".article").first().waitFor({ timeout: 10000 });
    assert.match(
      await page.locator("#load-notice").innerText(),
      /上次成功获取/,
    );
    await page.click(".saved-link");
    assert.equal(
      await page.locator(".article h3").first().innerText(),
      savedTitle,
    );
    assert(
      await page.locator("#pwa-update").isHidden(),
      "offline reopening must not prompt for an application update",
    );
    await page.fill("#search", savedTitle.slice(0, 4));
    assert.equal(await page.locator(".article").count(), 1);
    await page.click("#refresh-news");
    assert.match(await page.locator("#refresh-notice").innerText(), /当前离线/);

    dataTime = new Date(Date.parse(before) + 3_600_000).toISOString();
    await setOffline(false);
    await cdp.send("Network.overrideNetworkState", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.waitForFunction(
      (expected) =>
        JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).updatedAt ===
        expected,
      dataTime,
    );
    assert(await page.locator("#load-notice").isHidden());
    assert(
      await page.locator("#pwa-update").isHidden(),
      "refreshing news data must not prompt for an application update",
    );
    assert.equal(
      await page.locator(".article h3").first().innerText(),
      savedTitle,
    );
    const cachedUrls = await page.evaluate(async () => {
      const keys = (await caches.keys()).filter((k) =>
        k.startsWith("news-shell-"),
      );
      return (await (await caches.open(keys[0])).keys()).map((r) => r.url);
    });
    assert(!cachedUrls.some((url) => /news\.json|news-refresh/.test(url)));

    await page.evaluate(() => caches.open("unrelated-test-cache"));
    async function waitRevision(tab, expected) {
      await waitForBrowser(tab, async expected => {
        const registration = await navigator.serviceWorker.getRegistration();
        const controller = navigator.serviceWorker.controller;
        // Version messages can wake the retiring worker while Chromium is
        // stopping it. Observe activation before asking the new controller.
        if (registration?.installing || registration?.waiting ||
            !controller || controller !== registration?.active ||
            controller.state !== "activated") return false;
        return new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = e => { channel.port1.close(); resolve(e.data.cacheName?.endsWith("test" + expected)); };
          controller.postMessage({type: "GET_VERSION"}, [channel.port2]);
        });
      }, expected);
    }
    // Content updates activate silently without reloading a reader's open page.
    await page.evaluate(() => { window.openReaderMarker = "keep-reading"; });
    revision = 2;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await waitRevision(page, 2);
    assert.equal(await page.evaluate(() => window.openReaderMarker), "keep-reading");
    assert.equal(await page.locator("#pwa-update, #apply-update").count(), 0);
    for (const width of [390, 1440]) {
      await page.setViewportSize({width, height: 844});
      await page.reload({waitUntil: "networkidle"});
      assert.equal(await page.locator("body").getAttribute("data-test-revision"), "2");
    }
    const guide = await context.newPage();
    await guide.goto(base + "/guide/", {waitUntil: "networkidle"});
    assert.equal(await guide.locator("#pwa-update, #apply-update").count(), 0);
    await guide.locator("#offline-status.ready").waitFor();
    await guide.close();

    // Refresh gets new HTML even when offline-package installation fails. The
    // previous complete edition remains usable offline until the retry succeeds.
    revision = 3;
    appRevision = 2;
    blockInstall = true;
    await page.reload({waitUntil: "networkidle"});
    assert.equal(await page.locator("body").getAttribute("data-test-revision"), "3");
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await waitForBrowser(page, async () => !(await navigator.serviceWorker.getRegistration()).installing);
    await waitRevision(page, 2);
    await setOffline(true);
    await page.reload({waitUntil: "networkidle"});
    assert.equal(await page.locator("body").getAttribute("data-test-revision"), "2");
    await page.locator(".article").first().waitFor();
    blockInstall = false;
    await setOffline(false);
    await page.reload({waitUntil: "networkidle"});
    assert.equal(await page.locator("body").getAttribute("data-test-revision"), "3");
    await waitRevision(page, 3);

    const game = await context.newPage();
    game.on("pageerror", error => errors.push(error.message));
    await game.goto(base + "/games/#mines");
    await game.locator("#offline-status.ready").waitFor({ state: "attached" });
    await game.evaluate(async () => {
      window.playingMarker = "keep-playing";
      const cache = document.querySelector('meta[name="news-shell-cache"]').content;
      await (await caches.open(cache)).put("/assets/news/kept.111111111111.js", new Response("older open game resource"));
    });
    const other = await context.newPage();
    await other.goto(base, {waitUntil: "networkidle"});
    await page.evaluate(() => { window.openReaderMarker = "keep-reading"; });
    revision = 4;
    appRevision = 3;
    await other.reload({waitUntil: "networkidle"});
    assert.equal(await other.locator("body").getAttribute("data-test-revision"), "4");
    await waitRevision(other, 4);
    assert.equal(await page.evaluate(() => window.openReaderMarker), "keep-reading");
    assert.equal(await game.evaluate(() => window.playingMarker), "keep-playing");
    assert.equal(await page.locator("#pwa-update, #apply-update").count(), 0);
    await setOffline(true);
    assert.equal(await game.evaluate(async () => (await fetch("/assets/news/kept.111111111111.js")).text()), "older open game resource");
    await game.locator("#offline-status.ready").waitFor({ state: "attached" });
    await setOffline(false);
    await game.close();
    await page.reload({waitUntil: "networkidle"});
    assert.equal(await page.locator("body").getAttribute("data-test-revision"), "4");
    await waitForBrowser(page, async () => {
      const keys = (await caches.keys()).filter(k => k.startsWith("news-shell-"));
      return keys.length === 1 && keys[0].endsWith("test4");
    });
    assert((await page.evaluate(() => caches.keys())).includes("unrelated-test-cache"));
    await other.close();
    for (const path of [
      "/blog/",
      "/2020/09/25/Java-8-HashMap/",
      "/not-a-news-page",
    ]) {
      const missing = await page.goto(base + path, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(
        missing.status(),
        404,
        "service worker must not rewrite removed or missing pages into the news app",
      );
    }
    await setOffline(true);
    await page.goto(base + "/#saved", { waitUntil: "networkidle" });
    await page.locator(".article").first().waitFor();
    assert.equal(
      await page.locator(".article h3").first().innerText(),
      savedTitle,
    );
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/news-pwa-offline.png",
      fullPage: true,
    });
    console.log(
      "PASS: refresh loads the latest HTML without prompts, automatic activation, failed-install offline fallback, uninterrupted readers/games, old asset retention, cache cleanup, bookmarks and mobile layout.",
    );
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
