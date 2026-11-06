const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage();
    const latest = await (
      await page.request.get(base + "/data/latest.json")
    ).json();
    // Isolate URL handling from today's AI event groups; two live feed rows
    // may be reports of the same event and share one visible card.
    const direct = {id:"link-direct",title:"原文链接检查一",category:"general",
      sourceId:latest.sources.find(s => s.category === "general").id,
      publishedAt:new Date().toISOString(),excerpt:"原始摘要。",
      url:"https://news.google.com/rss/articles/CBMiTest",originalUrl:"https://publisher.example/story"};
    const fallback = {...direct,id:"link-fallback",title:"原文链接检查二",
      url:"https://publisher.example/fallback",originalUrl:"javascript:alert(1)"};
    latest.articles = [direct, fallback];
    delete latest.archive;
    await page.route("**/data/latest.json*", (route) =>
      route.fulfill({ json: latest }),
    );
    await page.goto(base + "/#all");
    await page.evaluate(() => window.newsInitialLoad);
    const link = (id) => page.locator(`[data-article-id="${id}"] h3 a`);
    assert.equal(
      await link(direct.id).getAttribute("href"),
      direct.originalUrl,
    );
    assert.equal(await link(fallback.id).getAttribute("href"), fallback.url);
    await page.locator(`[data-save="${direct.id}"]`).click();
    await page.locator(".saved-link").click();
    assert.equal(
      await link(direct.id).getAttribute("href"),
      direct.originalUrl,
    );
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".article").first().waitFor();
    assert.equal(
      await link(direct.id).getAttribute("href"),
      direct.originalUrl,
    );
    await page.locator(".reading-options summary").click();
    const pendingDownload = page.waitForEvent("download");
    await page.locator("#export-bookmarks").click();
    const download = await pendingDownload;
    const contents = await fs.readFile(await download.path());
    const saved = JSON.parse(contents).newsSaved;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].url, direct.url);
    assert.equal(saved[0].originalUrl, direct.originalUrl);
    await page.evaluate(() => localStorage.removeItem("zrbac-news-saved-v1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.newsInitialLoad);
    await page.locator(".reading-options summary").click();
    await page.locator("#bookmarks-file").setInputFiles({
      name: "bookmarks.json",
      mimeType: "application/json",
      buffer: contents,
    });
    await link(direct.id).waitFor();
    assert.equal(
      await link(direct.id).getAttribute("href"),
      direct.originalUrl,
    );
    console.log(
      "PASS: publisher URLs bypass aggregation, unsafe overrides fall back, direct links survive offline bookmarks and backup/import.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
