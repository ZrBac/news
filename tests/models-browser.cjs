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
      Math.min(12, data.modelReleases.length),
    );
    assert(
      (await page.locator(".category-label").allTextContents()).every(
        (t) => t === "模型发布",
      ),
    );
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      data.modelReleases.slice(0, 12).map((a) => a.title),
    );
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
    if (data.modelReleases.length > 12) {
      await page.locator("#load-more").click();
      assert.equal(
        await page.locator(".article").count(),
        Math.min(24, data.modelReleases.length),
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
      data.modelReleases.slice(0, 12).map((a) => a.title),
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
