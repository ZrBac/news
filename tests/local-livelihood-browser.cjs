const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const full = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const latest = await (
      await page.request.get(base + "/data/latest.json")
    ).json();
    let exportReads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/data/news.json") exportReads++;
    });
    await page.goto(base);
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator("#section-title").innerText(), "每日速览");
    const briefLabels = await page.locator(".category-label").allTextContents();
    assert(briefLabels.length <= 10);
    const today = await page.inputValue("#date-filter");
    const dayOf = (value) =>
      new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
    const eligibleCategories = new Set(
      latest.briefArticles
        .filter((article) => dayOf(article.publishedAt) === today)
        .map((article) => article.category),
    );
    assert(
      await page.locator("#date-panel").isHidden(),
      "mobile date controls stay collapsed until requested",
    );
    assert(
      await page
        .locator(".article")
        .first()
        .evaluate((node) => node.getBoundingClientRect().top < 420),
      "mobile readers reach the news in the first half of the screen",
    );
    assert(
      await page
        .locator("#search")
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16),
      "typing must not trigger Safari's small-font zoom",
    );
    await page.locator("#date-trigger").click();
    assert(await page.locator("#date-filter").isVisible());
    await page.locator("#date-trigger").click();
    for (const [category, label] of [
      ["local", "杭州资讯"],
      ["livelihood", "民生服务"],
    ]) {
      if (
        eligibleCategories.size <= 10 &&
        latest.briefArticles.some(
          (article) =>
            article.category === category &&
            dayOf(article.publishedAt) === today,
        )
      ) {
        assert(
          briefLabels.includes(label),
          category + " belongs in today's brief",
        );
      }
    }
    const tabs = await page
      .locator(".filter-categories [data-filter]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.filter));
    assert.deepEqual(tabs, [
      "general",
      "finance",
      "local",
      "livelihood",
      "tech",
      "ai",
      "models",
      "entertainment",
      "gaming",
      "sports",
    ]);
    assert.equal(
      await page
        .locator(".filter-tools button")
        .last()
        .getAttribute("data-filter"),
      "housing",
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no page overflow at " + width,
      );
      if (width <= 450) {
        const rows = await page
          .locator(".filter-categories button")
          .evaluateAll((nodes) => [
            ...new Set(
              nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
            ),
          ]);
        assert.equal(
          rows.length,
          1,
          "mobile categories use a single scrollable row",
        );
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + "/#sports");
    await page.waitForFunction(() => {
      const selected = document.querySelector(".filter-categories .selected");
      if (!selected || selected.dataset.filter !== "sports") return false;
      const item = selected.getBoundingClientRect(),
        group = selected.parentElement.getBoundingClientRect();
      return item.left >= group.left - 1 && item.right <= group.right + 1;
    });
    await page.locator('[data-view="brief"]').click();
    for (const [category, label] of [
      ["finance", "财经"],
      ["local", "杭州资讯"],
      ["livelihood", "民生服务"],
    ]) {
      const pool = full.articles.filter(
        (article) => article.category === category,
      );
      assert(pool.length >= 12, "usable initial content for " + category);
      await page.locator(`[data-filter="${category}"]`).click();
      await page
        .waitForFunction(
          (label) =>
            document.querySelector("#section-title").textContent === label &&
            document.querySelectorAll(".article").length >= 12 &&
            document.querySelector("#archive-notice").hidden,
          label,
        )
        .catch(async (error) => {
          console.error(
            await page.evaluate(() => ({
              title: document.querySelector("#section-title").textContent,
              count: document.querySelectorAll(".article").length,
              source: document.querySelector("#source-filter").value,
              query: document.querySelector("#search").value,
              notice: document.querySelector("#archive-notice").textContent,
              empty: document.querySelector(".empty-state")?.textContent,
            })),
          );
          throw error;
        });
      assert.deepEqual(
        new Set(await page.locator(".category-label").allTextContents()),
        new Set([label]),
      );
      const target = pool.at(-1);
      await page.fill("#search", target.title);
      await page.waitForFunction(
        (id) =>
          !!document.querySelector(`[data-save="${id}"]`) &&
          document.querySelector("#archive-notice").hidden,
        target.id,
      );
      const source = full.sources.find(
        (source) => source.id === target.sourceId,
      );
      await page.selectOption("#source-filter", source.id);
      assert(
        (await page.locator(".article h3").allTextContents()).includes(
          target.title,
        ),
      );
      await page.locator(`[data-save="${target.id}"]`).click();
      await page.locator(".saved-link").click();
      assert(
        (await page.locator(".article h3").allTextContents()).includes(
          target.title,
        ),
      );
      // Category buttons intentionally filter saved articles while in Favorites.
      // Return through the brief before opening the news section itself.
      await page.locator('[data-view="brief"]').click();
      await page.locator(`[data-filter="${category}"]`).click();
      await page.waitForFunction(
        (label) =>
          document.querySelector("#section-title").textContent === label &&
          document.querySelectorAll(".article").length >= 12 &&
          document.querySelector("#archive-notice").hidden,
        label,
      );
    }
    await page.locator(".reading-options > summary").click();
    const download = page.waitForEvent("download");
    await page.locator("#export-bookmarks").click();
    const backup = JSON.parse(
      await fs.readFile(await (await download).path(), "utf8"),
    );
    assert.deepEqual(
      new Set(backup.newsSaved.map((article) => article.category)),
      new Set(["finance", "local", "livelihood"]),
    );
    await page.evaluate(() => localStorage.removeItem("zrbac-news-saved-v1"));
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    await page.locator(".reading-options > summary").click();
    await page
      .locator("#bookmarks-file")
      .setInputFiles({
        name: "bookmarks.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(backup)),
      });
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("zrbac-news-saved-v1") || "[]")
          .length === 3,
    );
    await page.locator(".saved-link").click();
    assert.equal(await page.locator(".article").count(), 3);
    await page.locator(".reading-options > summary").click();
    await page.goto(base + "/#local");
    await page.evaluate(() => window.newsInitialLoad);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(
      () =>
        document.querySelector("#section-title").textContent === "杭州资讯" &&
        document.querySelectorAll(".article").length >= 12 &&
        document.querySelector("#archive-notice").hidden,
    );
    const online = await page.locator(".article h3").allTextContents();
    await page.screenshot({ path: "/tmp/local-news-mobile.png" });
    await context.setOffline(true);
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    await page.waitForFunction(
      () => document.querySelectorAll(".article").length >= 12,
    );
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      online,
    );
    await page.locator('[data-filter="livelihood"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#section-title").textContent === "民生服务" &&
        document.querySelectorAll(".article").length >= 12,
    );
    assert.deepEqual(
      new Set(await page.locator(".category-label").allTextContents()),
      new Set(["民生服务"]),
    );
    assert.equal(
      exportReads,
      0,
      "new columns use their indexes without downloading the full export",
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS: compact mobile navigation and date controls, finance/local/livelihood search, sources, bookmark backup/import and cached offline reading.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
