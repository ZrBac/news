// Verify first-paint behavior while requests remain deliberately unresolved.
const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const original = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    let resolveNews;
    const newsGate = new Promise((resolve) => {
      resolveNews = resolve;
    });
    await page.route("**/data/news.json*", async (route) => {
      await newsGate;
      await route.fulfill({ json: original });
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    assert.equal(
      await page.locator("#offline-tools, #offline-status").count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      ),
      0,
      "offline installation must wait for the initial news download",
    );
    resolveNews();
    await page.locator(".article").first().waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.unroute("**/data/news.json*");
    let fullDownloads = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/data/news.json") fullDownloads++;
    });
    let releaseStatus;
    const statusGate = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    await page.route("**/data/status.json", async (route) => {
      await statusGate;
      await route.fulfill({ json: { updatedAt: original.updatedAt } });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".article").first().waitFor();
    assert.match(await page.locator("#load-notice").innerText(), /后台检查/);
    await page.locator('[data-filter="sports"]').first().click();
    releaseStatus();
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(
      fullDownloads,
      0,
      "unchanged news only needs the tiny status file",
    );
    assert.equal(await page.locator("#section-title").innerText(), "体育");
    assert(await page.locator("#load-notice").isHidden());
    await page.unroute("**/data/status.json");
    const updated = structuredClone(original);
    updated.updatedAt = new Date(
      Date.parse(original.updatedAt) + 3600000,
    ).toISOString();
    await page.route("**/data/status.json", (route) =>
      route.fulfill({ json: { updatedAt: updated.updatedAt } }),
    );
    let releaseUpdate;
    const updateGate = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    await page.route("**/data/news.json*", async (route) => {
      await updateGate;
      await route.fulfill({ json: updated });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".article").first().waitFor();
    await page.locator('[data-filter="tech"]').first().click();
    await page.fill("#search", "未来");
    releaseUpdate();
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.inputValue("#search"), "未来");
    assert.equal(await page.locator("#section-title").innerText(), "科技动态");
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).updatedAt,
      ),
      updated.updatedAt,
    );
    await page.unroute("**/data/news.json*");
    await page.unroute("**/data/status.json");
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".article").first().waitFor();
    assert.equal(
      await page.locator("#offline-tools, #offline-status").count(),
      0,
    );
    assert.match(
      await page.locator("#load-notice").innerText(),
      /上次成功获取/,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: news before PWA install, cached articles before network response, unchanged news avoids full download, background update preserves filters, standalone news has no game prompt, offline news opens.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
