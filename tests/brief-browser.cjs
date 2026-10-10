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
    await page.goto(base);
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator("#section-title").innerText(), "每日速览");
    assert.equal(
      await page.locator('[data-view="brief"]').getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      await page
        .locator('.filter-tabs [data-filter][aria-pressed="true"]')
        .count(),
      0,
    );
    const data = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("zrbac-news-cache-v1")),
    );
    const today = await page.inputValue("#date-filter");
    assert(data.briefDays.includes(today));
    const categories = await page.locator(".category-label").allTextContents();
    assert.equal(categories.length, 10);
    assert.deepEqual(
      new Set(categories),
      new Set([
        "综合热点",
        "杭州房市",
        "人工智能",
        "模型发布",
        "科技动态",
        "文娱",
        "游戏",
        "体育",
      ]),
    );
    assert(categories.filter((c) => c === "文娱" || c === "体育").length <= 4);
    assert.equal(
      archives.length,
      0,
      "balanced first view must not scan the news archive",
    );
    const titles = await page.locator(".article h3").allTextContents();
    const firstPageIds = new Set(data.articles.map((a) => a.id));
    const supplemental = await page
      .locator(".save-button")
      .evaluateAll((els) => els.map((e) => e.dataset.save))
      .then((ids) => ids.find((id) => !firstPageIds.has(id)));
    assert(
      supplemental,
      "low-frequency stories are available even outside the latest 150",
    );
    await page.locator(`[data-save="${supplemental}"]`).click();
    assert(
      await page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem("zrbac-news-saved-v1")).some(
            (a) => a.id === id,
          ),
        supplemental,
      ),
    );
    await page.locator(".saved-link").click();
    assert.equal(await page.locator(".article").count(), 1);
    await page.locator('[data-filter="exchange"]').click();
    await page.locator("#fx-amount").fill("100");
    assert.match(
      await page.locator("#fx-converted").innerText(),
      /约 [\d,.]+ 元/,
    );
    const tabs = await page
      .locator(".filter-categories [data-filter]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.filter));
    assert.equal(tabs.indexOf("gaming") + 1, tabs.indexOf("sports"));
    await page.locator('[data-filter="gaming"]').click();
    assert.equal(await page.locator("#section-title").innerText(), "游戏");
    assert.deepEqual(
      new Set(await page.locator(".category-label").allTextContents()),
      new Set(["游戏"]),
    );
    assert.equal(
      archives.length,
      0,
      "game headlines use a small snapshot without loading old archives",
    );
    const extraGame = data.gamingArticles.find(
      (article) => !firstPageIds.has(article.id),
    );
    assert(extraGame);
    await page.fill("#search", extraGame.title);
    await page.locator(`[data-save="${extraGame.id}"]`).click();
    assert(
      await page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem("zrbac-news-saved-v1")).some(
            (article) => article.id === id,
          ),
        extraGame.id,
      ),
    );
    await page.locator('[data-view="brief"]').click();
    await page.fill("#date-filter", data.briefDays[1]);
    assert((await page.locator(".article").count()) > 0);
    assert((await page.locator(".article").count()) <= 10);
    assert.equal(archives.length, 0);
    await page.locator('[data-view="brief"]').click();
    assert.equal(await page.inputValue("#date-filter"), today);
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      titles,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no overflow at " + width,
      );
      if (width <= 450) {
        const boxes = await page.locator(".filter-group").evaluateAll((els) =>
          els.map((e) => ({
            kind: e.className,
            top: e.getBoundingClientRect().top,
          })),
        );
        assert.equal(boxes[0].top, boxes[2].top);
        assert(
          boxes[1].top > boxes[0].top,
          "news categories have a separate mobile row",
        );
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.move(380, 810);
    await page.screenshot({ path: "/tmp/brief-mobile.png" });
    await page.locator('[data-filter="all"]').click();
    assert.equal(await page.locator("#section-title").innerText(), "最新资讯");
    assert.equal(await page.locator(".article").count(), 12);
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      data.articles.slice(0, 12).map((a) => a.title),
    );
    assert.equal(await page.inputValue("#date-filter"), "");
    await page.goto(base);
    await page.evaluate(() => window.newsInitialLoad);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    assert.deepEqual(
      await page.locator(".article h3").allTextContents(),
      titles,
    );
    assert.equal(archives.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS: default daily brief, eight balanced categories, supplemental saves, yesterday, all-news order, grouped mobile tabs, four widths and offline without archive scans.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
