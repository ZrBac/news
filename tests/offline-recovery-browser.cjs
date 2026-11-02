// NEWS_TEST_SITE=/tmp/news-offline-preview PLAYWRIGHT_MODULE=/path/to/playwright node tests/offline-recovery-browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");
(async () => {
  let available = true,
    documents = 0;
  const server = http.createServer(async (req, res) => {
    if (!available) return res.writeHead(503).end("offline");
    let pathname = new URL(req.url, "http://local").pathname;
    if (pathname.endsWith("/")) pathname += "index.html";
    if (pathname.endsWith(".html")) documents++;
    const file = path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
    try {
      const data = await fs.readFile(file);
      const type =
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".json": "application/json",
          ".webmanifest": "application/manifest+json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[path.extname(file)] || "application/octet-stream";
      res
        .writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" })
        .end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`,
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "news-offline-profile-"));
  let context, browser;
  const args = {
    args: ["--no-sandbox"],
    viewport: { width: 390, height: 664 },
  };
  try {
    context = await chromium.launchPersistentContext(profile, args);
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    let page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    await page.locator('a[href="#mines"]').click();
    await page.locator("#casual-grid button").first().click();
    const save = await page.evaluate(() =>
      localStorage.getItem("zacai-casual-mines-v1"),
    );
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    const before = documents;
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(
      documents,
      before + 1,
      "online refresh revalidates the latest document",
    );
    const damaged = await page.evaluate(async () => {
      const name = (await caches.keys()).find((k) =>
          k.startsWith("news-shell-"),
        ),
        cache = await caches.open(name),
        asset = (await cache.keys()).find((r) =>
          /casual-games-core\./.test(r.url),
        );
      await cache.delete("/");
      await cache.delete(asset);
      const result = await new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
          ch.port1.close();
          resolve(e.data);
        };
        navigator.serviceWorker.controller.postMessage(
          { type: "CHECK_OFFLINE", paths: ["/games/"] },
          [ch.port2],
        );
      });
      return result;
    });
    assert.equal(damaged.ready, false);
    assert.equal(damaged.missing, 2);
    await page.locator("#prepare-offline").click();
    await page.locator("#offline-status.ready").waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("zacai-casual-mines-v1")),
      save,
    );
    assert.deepEqual(errors, []);
    await context.close();
    context = null;
    // Kill the browser, disconnect the transport, and reopen the same on-disk profile.
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
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    assert(await page.locator('a[href="/games/"]').first().isVisible());
    await page.goto(base + "/games/index.html#mines");
    await page.locator("#offline-status.ready").waitFor({ state: "attached" });
    assert.equal(await page.locator("#casual-grid button").count(), 64);
    assert.deepEqual(
      JSON.parse(
        await page.evaluate(() =>
          localStorage.getItem("zacai-casual-mines-v1"),
        ),
      ).board,
      JSON.parse(save).board,
    );
    assert(
      JSON.parse(
        await page.evaluate(() =>
          localStorage.getItem("zacai-casual-mines-v1"),
        ),
      ).open[0],
    );
    assert.deepEqual(errors, []);
    await context.close();
    context = null;
    available = true;
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    for (const reason of ["insecure", "unavailable"]) {
      const c = await browser.newContext(args);
      await c.addInitScript((reason) => {
        if (reason === "insecure")
          Object.defineProperty(window, "isSecureContext", { value: false });
        else
          Object.defineProperty(navigator, "serviceWorker", {
            value: undefined,
          });
      }, reason);
      const p = await c.newPage();
      await p.goto(base + "/games/");
      assert.equal(
        await p.locator("#offline-status").getAttribute("data-state"),
        reason,
      );
      assert(
        !(await p.locator("#offline-status").getAttribute("class")).includes(
          "ready",
        ),
      );
      assert(await p.locator("#offline-secure-link").isVisible());
      assert(await p.locator("#prepare-offline").isDisabled());
      await c.close();
    }
    console.log(
      "PASS: full-shell readiness, missing launch-page/asset repair, preserved saves, cached navigation, browser process restart offline, standalone context and distinct unsupported/insecure messages.",
    );
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
