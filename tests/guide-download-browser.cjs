const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");

(async () => {
  let releaseIndex;
  const indexGate = new Promise((resolve) => {
    releaseIndex = resolve;
  });
  let failedChapter = true;
  let available = true;
  const downloads = [];
  const server = http.createServer(async (req, res) => {
    if (!available) return res.writeHead(503).end("offline");
    let pathname = new URL(req.url, "http://local").pathname;
    if (pathname.includes("guide-index.")) await indexGate;
    if (pathname.startsWith("/guide/chapters/")) {
      downloads.push(pathname);
      if (failedChapter && /\/15\./.test(pathname))
        return res.writeHead(503).end("try again");
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
    try {
      const body = await fs.readFile(file);
      const types = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
      };
      res
        .writeHead(200, {
          "Content-Type":
            types[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "guide-offline-"));
  let context;
  const args = {
    args: ["--no-sandbox"],
    viewport: { width: 390, height: 844 },
  };
  const errors = [];
  try {
    context = await chromium.launchPersistentContext(profile, args);
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    let page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    let apiCalls = 0,
      fullBookCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/life-guide")) apiCalls++;
      if (request.url().includes("guide-book.")) fullBookCalls++;
    });
    await page.goto(base + "/guide/", { waitUntil: "domcontentloaded" });
    assert.equal(await page.locator(".guide-entry").count(), 12);
    await page.locator(".guide-entry details summary").first().click();
    assert(
      (await page.locator(".entry-body").first().innerText()).includes(
        "备注：",
      ),
      "first-page text works while the directory download is stalled",
    );
    assert.equal(await page.locator("#guide-chapter").isDisabled(), true);
    assert.equal(await page.locator("#guide-ask, [data-mode=ask]").count(), 0);
    releaseIndex();
    await page.evaluate(() => window.guideInitialLoad);
    await page.waitForFunction(
      () =>
        document.querySelector("#offline-status").dataset.state === "download",
      { timeout: 30000 },
    );
    const saved = await page.evaluate(async () => {
      const cache = await caches.open(
        (await caches.keys()).find((key) => key.startsWith("news-shell-")),
      );
      return (await cache.keys()).filter((request) =>
        request.url.includes("/guide/chapters/"),
      ).length;
    });
    assert.equal(
      saved,
      33,
      "one failed chapter does not discard the other chapters",
    );
    await page.locator("#guide-chapter").selectOption("19");
    await page.locator(".guide-entry details summary").first().click();
    await page.waitForFunction(() =>
      document.querySelector(".entry-body").textContent.includes("备注："),
    );
    await page.locator(".entry-save").first().click();
    failedChapter = false;
    downloads.length = 0;
    await page.locator("#prepare-offline").click();
    await page.locator("#offline-status.ready").waitFor({ timeout: 30000 });
    assert.deepEqual(
      new Set(downloads.map((url) => Number(/chapters\/(\d+)/.exec(url)[1]))),
      new Set([15]),
      "retry downloads only the missing chapter",
    );
    const readyWithoutGames = await page.evaluate(async () => {
      const cache = await caches.open(
        (await caches.keys()).find((key) => key.startsWith("news-shell-")),
      );
      const game = (await cache.keys()).find((request) =>
        /casual-games-core\./.test(request.url),
      );
      await cache.delete("/games/");
      await cache.delete(game);
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          channel.port1.close();
          resolve(event.data);
        };
        navigator.serviceWorker.controller.postMessage(
          { type: "CHECK_OFFLINE", paths: ["/guide/"], page: "guide" },
          [channel.port2],
        );
      });
    });
    assert.equal(readyWithoutGames.ready, true);
    assert.equal(apiCalls, 0);
    assert.equal(fullBookCalls, 0);
    await context.close();
    context = null;
    available = false;
    context = await chromium.launchPersistentContext(profile, {
      ...args,
      offline: true,
    });
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.locator('a.guide-link[href="/guide/"]').click();
    await page.evaluate(() => window.guideInitialLoad);
    await page.locator("#offline-status.ready").waitFor({ timeout: 15000 });
    await page.locator('[data-mode="saved"]').click();
    await page.locator('.entry-save[aria-pressed="true"]').waitFor();
    await page.locator('[data-mode="read"]').click();
    await page.locator("#guide-chapter").selectOption("15");
    await page.locator(".guide-entry details summary").first().click();
    await page.waitForFunction(() =>
      document.querySelector(".entry-body").textContent.includes("备注："),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: first-page reading without directory download, no AI calls, partial chapter retention, retry of only missing chapter, independence from game assets and cold offline restart.",
    );
  } finally {
    releaseIndex();
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
