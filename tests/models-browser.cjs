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
    const page = await context.newPage(),
      errors = [],
      archives = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().includes("/data/archive/")) archives.push(r.url());
    });
    const packet = await (await page.request.get(base + "/data/latest.json")).json();
    const sources = packet.sources.filter(s => s.category === "models").slice(0, 2);
    assert.equal(sources.length, 2);
    // Fixed releases keep pagination independent of live news and editorial merges.
    // Two reports describe one release; the other model versions stay separate.
    const releases = Array.from({length: 18}, (_, i) => ({
      id: "model-test-" + i, category: "models", sourceId: sources[i % 2].id,
      title: `示例模型 ${i + 1}.0 正式发布`, excerpt: "新版本开放使用。",
      url: "https://example.com/model/" + i,
      publishedAt: new Date(Date.parse(packet.updatedAt) - i * 3600000).toISOString(),
      editorial: {eventId: "event-" + i.toString(16).padStart(24, "0"), summary: "模型发布。", updatedAt: packet.updatedAt},
    }));
    packet.modelReleases = [releases[0], {...releases[0], id: "model-copy", sourceId: sources[1].id,
      title: "另一来源：示例模型 1.0 正式发布", url: "https://example.com/other-report"}, ...releases.slice(1)];
    await page.route("**/data/latest.json*", route => route.fulfill({json: packet}));
    await page.goto(base + "/#models");
    await page.evaluate(() => window.newsInitialLoad);
    const data = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("zrbac-news-cache-v1")),
    );
    assert(data.modelReleases.length >= 4);
    assert.equal(await page.locator("#section-title").innerText(), "模型发布");
    assert.equal(
      await page.locator('[data-filter="models"]').getAttribute("aria-pressed"),
      "true",
    );
    assert(await page.locator("#view-note").isVisible());
    assert.equal(
      await page.locator(".article").count(),
      Math.min(12, releases.length),
    );
    assert(
      (await page.locator(".category-label").allTextContents()).every(
        (t) => t === "模型发布",
      ),
    );
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      releases.slice(0, 12).map((a) => a.title),
    );
    assert.equal(await page.locator(".article-reports a").count(), 1);
    assert.equal(
      archives.length,
      0,
      "model list is in the initial offline packet",
    );
    const tabs = await page
      .locator(".filter-tabs [data-filter]")
      .evaluateAll((els) => els.map((e) => e.dataset.filter));
    assert.equal(tabs[tabs.indexOf("ai") + 1], "models");
    assert.equal(tabs.at(-1), "housing");
    if (releases.length > 12) {
      await page.locator("#load-more").click();
      assert.equal(
        await page.locator(".article").count(),
        Math.min(24, releases.length),
      );
    }
    const article =
      data.modelReleases.find(
        (a) => !data.articles.some((n) => n.id === a.id),
      ) || data.modelReleases[0];
    await page.fill("#search", article.title);
    assert(
      (await page.locator(".article h3").allTextContents()).includes(
        article.title,
      ),
    );
    await page.locator(`.save-button[data-save="${article.id}"]`).click();
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("zrbac-news-saved-v1")),
    );
    assert(
      saved.some((a) => a.id === article.id),
      "supplemental model announcements can be saved",
    );
    await page.locator('[data-filter="models"]').click();
    await page.fill("#search", "");
    const source = data.modelReleases[0].sourceId;
    await page.selectOption("#source-filter", source);
    assert.equal(
      await page.locator(".article").count(),
      Math.min(
        12,
        data.modelReleases.filter((a) => a.sourceId === source).length,
      ),
    );
    await page.selectOption("#source-filter", "all");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no overflow at " + width,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/models-mobile.png", fullPage: true });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      releases.slice(0, 12).map((a) => a.title),
    );
    await page.fill("#search", article.title);
    assert(
      (await page.locator(".article h3").allTextContents()).includes(
        article.title,
      ),
    );
    assert.equal(archives.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS: model tab, dated releases, pagination, search, source filter, supplementary saves, four widths, offline and no archive scans.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
