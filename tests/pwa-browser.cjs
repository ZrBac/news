// Run against a locally built site: NEWS_TEST_SITE=/tmp/news-pwa-preview node tests/pwa-browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");

(async () => {
  let revision = 1;
  let dataTime;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const target = path.resolve(
      root,
      "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname),
    );
    if (!target.startsWith(root + path.sep))
      return response.writeHead(404).end();
    try {
      let body = await fs.readFile(target);
      if (pathname === "/sw.js")
        body = Buffer.from(
          body
            .toString()
            .replace(/news-shell-([a-f0-9]+)/, "news-shell-$1-test" + revision),
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
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator(".article").first().waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
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

    await context.setOffline(true);
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
    await page.fill("#search", savedTitle.slice(0, 4));
    assert.equal(await page.locator(".article").count(), 1);
    await page.click("#refresh-news");
    assert.match(await page.locator("#refresh-notice").innerText(), /当前离线/);

    dataTime = new Date(Date.parse(before) + 3_600_000).toISOString();
    await context.setOffline(false);
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
    revision = 2;
    await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration()).update(),
    );
    await page
      .locator("#pwa-update")
      .waitFor({ state: "visible", timeout: 15000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.click("#apply-update"),
    ]);
    await page.locator(".article").first().waitFor();
    const keys = await page.evaluate(() => caches.keys());
    assert.deepEqual(
      keys
        .filter((k) => k.startsWith("news-shell-"))
        .map((k) => k.endsWith("test2")),
      [true],
    );
    assert(keys.includes("unrelated-test-cache"));
    assert(await page.locator("#pwa-update").isHidden());
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
    await context.setOffline(true);
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
      "PASS: installability, manual install guide, offline reopening/search/bookmarks, online recovery, fresh data, atomic update, cache cleanup, scoped routing, responsive layout.",
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
