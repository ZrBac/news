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
    await context.addInitScript(() => {
      Date.now = () => Date.parse("2026-10-23T10:00:00Z");
    });
    const page = await context.newPage(),
      errors = [],
      archives = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/data/archive/"))
        archives.push(request.url());
    });
    const latest = await (
      await page.request.get(base + "/data/latest.json")
    ).json();
    const source = latest.sources.find((s) => s.category === "local");
    const make = (id, title, type, extra = {}) => ({
      id,
      title,
      category: "local",
      sourceId: source.id,
      url: "https://publisher.example/" + id,
      excerpt: "原文提供具体安排。",
      publishedAt: "2026-10-23T02:00:00Z",
      outing: { type, ...extra },
    });
    const market = make("weekend-market", "杭州秋日农夫市集", "market", {
      start: "2026-10-24",
      end: "2026-10-25",
      venue: "良渚暖村草坪",
      cost: "免费入场",
    });
    latest.weekendArticles = [
      market,
      make("weekend-culture", "浙江省博物馆秋日特展", "culture", {
        start: "2026-10-01",
        end: "2026-11-10",
      }),
      make("weekend-outdoor", "安吉森林徒步与露营路线", "outdoor"),
      make("weekend-family", "杭州亲子非遗手作工作坊", "family", {
        start: "2026-10-24",
        end: "2026-10-24",
      }),
      make("weekend-city", "杭州城市漫游夜游路线", "city"),
      make("weekend-sport", "杭州桨板运动体验报名", "sport", {
        start: "2026-10-25",
        end: "2026-10-25",
      }),
      make("weekend-ended", "杭州上周音乐节", "culture", {
        start: "2026-10-17",
        end: "2026-10-18",
      }),
      make("weekend-future", "杭州下月话剧演出", "culture", {
        start: "2026-11-01",
        end: "2026-11-02",
      }),
      make("weekend-cancelled", "杭州市集取消", "market", { cancelled: true }),
      make("weekend-weekday", "杭州周内市集", "market", {
        until: "2026-10-23",
      }),
      make("weekend-calendar", "杭州11月话剧演出日历", "culture", {
        month: "2026-11",
      }),
      make("weekend-concert", "杭州本周末演唱会开票", "culture", {
        start: "2026-10-24",
        end: "2026-10-25",
      }),
      make("weekend-fan-show", "杭州歌友会演出预告", "culture"),
      {
        ...make("weekend-old", "杭州旧展览消息", "culture"),
        publishedAt: "2026-10-01T02:00:00Z",
      },
    ];
    // Simulate an older cached snapshot with dated reports pinned first.
    latest.weekendArticles.find((a) => a.id === "weekend-culture").publishedAt =
      "2026-10-21T02:00:00Z";
    latest.weekendArticles.find((a) => a.id === "weekend-outdoor").publishedAt =
      "2026-10-23T09:00:00Z";
    latest.weekendArticles.find((a) => a.id === "weekend-city").publishedAt =
      "2026-10-23T08:00:00Z";
    latest.weekendGuide = {
      search: { searchedAt: "2026-10-23T08:00:00Z", status: "ok" },
    };
    // Old caches and the full archive can still include outings among news.
    latest.articles.unshift(market);
    latest.briefArticles = [
      market,
      {
        ...latest.articles.find((article) => article.category === "general"),
        publishedAt: "2026-10-23T02:00:00Z",
      },
    ];
    // Keep the fixture's coverage metadata aligned with its frozen clock.
    latest.briefDays = ["2026-10-23"];
    await page.route("**/data/latest.json*", (route) =>
      route.fulfill({ json: latest }),
    );
    await page.goto(base + "/#local");
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator("#section-title").innerText(), "去处");
    assert.equal(await page.locator('[data-filter="local"]').count(), 0);
    assert.equal(
      await page.locator('.header-actions [data-view="local"]').innerText(),
      "去处",
    );
    assert.equal(
      await page.locator('[data-view="local"]').getAttribute("aria-current"),
      "page",
    );
    assert(await page.locator(".filter-tabs").isHidden());
    assert(await page.locator(".sidebar").isHidden());
    assert.equal(await page.locator(".article").count(), 6);
    assert.deepEqual(
      await page
        .locator(".article")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.dataset.articleId),
        ),
      ["weekend-outdoor", "weekend-city"],
    );
    assert.equal(
      await page.locator('[data-article-id="weekend-concert"]').count(),
      0,
    );
    assert(await page.locator("#camping-places").isVisible());
    assert(await page.locator("#hiking-places").isVisible());
    assert(await page.locator("#rainy-places").isVisible());
    assert.equal(await page.locator("[data-place-group][open]").count(), 0);
    assert.match(
      await page.locator("#result-count").innerText(),
      /21 个地点参考/,
    );
    // Searching opens just the matching reference group, without relying on feeds.
    await page.fill("#search", "宝石山");
    assert.equal(await page.locator(".place-card:visible").count(), 1);
    assert.match(
      await page.locator(".place-card:visible").innerText(),
      /保俶塔.*初阳台/s,
    );
    assert.match(
      await page.locator("#result-count").innerText(),
      /0 条出游消息 · 1 个地点参考/,
    );
    assert.match(await page.locator("#articles").innerText(), /地点参考见上方/);
    assert(await page.locator("#rainy-places").isHidden());
    await page.fill("#search", "");
    assert.equal(await page.locator("[data-place-group][open]").count(), 0);
    await page.fill("#search", "雨天");
    assert.equal(await page.locator(".place-card:visible").count(), 7);
    assert.doesNotMatch(
      (await page.locator("#rainy-places h3").allTextContents()).join(" "),
      /博物馆|博物院|美术馆/,
    );
    assert(await page.locator("#hiking-places").isHidden());
    await page.fill("#search", "雨天 攀岩");
    assert.equal(await page.locator(".place-card:visible").count(), 1);
    assert.match(
      await page.locator(".place-card:visible h3").innerText(),
      /香蕉攀岩/,
    );
    await page.fill("#search", "不存在的地点");
    assert.equal(await page.locator("[data-place-group]:visible").count(), 0);
    assert.match(await page.locator("#articles").innerText(), /暂时没有匹配/);
    await page.fill("#search", "");
    const referenceLinks = await page
      .locator("#hiking-places a, #rainy-places a")
      .evaluateAll((nodes) => nodes.map((a) => ({ href: a.href, rel: a.rel })));
    assert(referenceLinks.length >= 34);
    assert(
      referenceLinks.every(
        (a) => a.href.startsWith("https://") && a.rel.includes("noopener"),
      ),
    );
    await page.locator("#camping-places > summary").click();
    assert.equal(await page.locator(".camping-place:visible").count(), 4);
    assert.equal(
      await page
        .locator('.camping-links a[href^="https://uri.amap.com/search?"]')
        .count(),
      4,
    );
    await page.fill("#search", "风笑岭");
    assert.equal(await page.locator(".camping-place:visible").count(), 1);
    assert.match(await page.locator("#camping-count").innerText(), /1 个地点/);
    await page.fill("#search", "");
    await page.fill("#search", "安吉 卡式炉");
    assert.equal(await page.locator(".camping-place:visible").count(), 2);
    assert.match(
      await page
        .locator(".camping-place:visible")
        .allTextContents()
        .then((texts) => texts.join(" ")),
      /普通车.*未写明/,
    );
    await page.fill("#search", "");
    assert.equal(await page.locator("[data-outing-type]").count(), 7);
    assert.match(
      await page.locator("#weekend-tools").innerText(),
      /来源每小时检查.*每天9点、16点.*最近专题检索/s,
    );
    assert.match(
      await page.locator('[data-article-id="weekend-market"]').innerText(),
      /2026-10-24 至 2026-10-25.*良渚暖村草坪.*免费入场/s,
    );
    assert.match(
      await page.locator('[data-article-id="weekend-outdoor"]').innerText(),
      /活动时间见原文/,
    );
    for (const type of [
      "market",
      "culture",
      "outdoor",
      "family",
      "city",
      "sport",
    ]) {
      await page.locator(`[data-outing-type="${type}"]`).click();
      assert.equal(
        await page.locator("#camping-places").isVisible(),
        type === "outdoor",
      );
      assert.equal(
        await page.locator("#hiking-places").isVisible(),
        type === "outdoor",
      );
      assert.equal(
        await page.locator("#rainy-places").isVisible(),
        ["culture", "family", "city", "sport"].includes(type),
      );
      if (["culture", "family", "city", "sport"].includes(type)) {
        assert.equal(
          await page.locator("#rainy-places .place-card:not([hidden])").count(),
          { culture: 4, family: 2, city: 2, sport: 3 }[type],
        );
      }
      assert.equal(await page.locator(".article").count(), 1);
      assert.equal(
        await page
          .locator(`[data-outing-type="${type}"]`)
          .getAttribute("aria-pressed"),
        "true",
      );
    }
    await page.locator('[data-outing-type="all"]').click();
    await page.locator('[data-outing-range="recent"]').click();
    assert.equal(await page.locator(".article").count(), 9);
    const recentTimes = await page
      .locator(".article time")
      .evaluateAll((nodes) => nodes.map((node) => Date.parse(node.dateTime)));
    assert(
      recentTimes.every(
        (time, index) => index === 0 || time <= recentTimes[index - 1],
      ),
    );
    assert.equal(
      await page.locator('[data-article-id="weekend-concert"]').count(),
      0,
    );
    assert.equal(
      await page.locator('[data-article-id="weekend-fan-show"]').count(),
      0,
    );
    await page.fill("#search", "良渚暖村");
    await page.waitForFunction(
      () => document.querySelectorAll(".article").length === 1,
    );
    await page.locator('[data-save="weekend-market"]').click();
    await page.locator(".saved-link").click();
    assert.match(
      await page.locator(".outing-summary").innerText(),
      /2026-10-24/,
    );
    await page.locator(".reading-options summary").click();
    const pending = page.waitForEvent("download");
    await page.locator("#export-bookmarks").click();
    const backup = await fs.readFile(await (await pending).path());
    assert.equal(JSON.parse(backup).newsSaved[0].outing.venue, "良渚暖村草坪");
    await page.evaluate(() => localStorage.removeItem("zrbac-news-saved-v1"));
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    await page.locator(".reading-options summary").click();
    await page.locator("#bookmarks-file").setInputFiles({
      name: "weekend.json",
      mimeType: "application/json",
      buffer: backup,
    });
    await page.locator('[data-article-id="weekend-market"]').waitFor();
    assert.match(await page.locator(".outing-details").innerText(), /良渚暖村/);
    await page.locator('[data-view="brief"]').click();
    assert.equal(await page.locator("[data-place-group]:visible").count(), 0);
    assert.equal(
      await page.locator('[data-article-id="weekend-market"]').count(),
      0,
    );
    assert(await page.locator(".filter-tabs").isVisible());
    await page.locator('[data-filter="all"]').click();
    assert.equal(
      await page.locator('[data-article-id="weekend-market"]').count(),
      0,
    );
    await page.locator('[data-view="local"]').click();
    for (const group of ["hiking-places", "rainy-places", "camping-places"]) {
      if (!(await page.locator("#" + group).evaluate((node) => node.open)))
        await page.locator("#" + group + " > summary").click();
    }
    assert.equal(await page.locator(".place-card:visible").count(), 21);
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
    await page.screenshot({
      path: "/tmp/hangzhou-weekend-mobile.png",
      fullPage: true,
    });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator(".article").count(), 6);
    assert.deepEqual(
      await page
        .locator(".article")
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.dataset.articleId),
        ),
      ["weekend-outdoor", "weekend-city"],
    );
    await page.locator("#camping-places > summary").click();
    assert.equal(await page.locator(".camping-place:visible").count(), 4);
    await page.locator("#hiking-places > summary").click();
    assert.equal(
      await page.locator("#hiking-places .place-card:visible").count(),
      10,
    );
    await page.fill("#search", "雨天 浙江图书馆");
    assert.equal(await page.locator(".place-card:visible").count(), 1);
    assert.match(
      await page.locator(".place-card:visible h3").innerText(),
      /浙江图书馆/,
    );
    await page.fill("#search", "");
    assert.equal(await page.locator("#rainy-places[open]").count(), 0);
    assert.equal(
      await page.locator("#hiking-places .place-card:visible").count(),
      10,
    );
    assert.equal(
      await page.locator('[data-article-id="weekend-concert"]').count(),
      0,
    );
    await page.evaluate(() => {
      Date.now = () => Date.parse("2026-10-26T10:00:00Z");
    });
    await page.locator('[data-outing-type="all"]').click();
    assert.equal(
      await page.locator('[data-article-id="weekend-market"]').count(),
      0,
    );
    assert.equal(
      await page.locator('[data-article-id="weekend-family"]').count(),
      0,
    );
    assert.equal(
      archives.length,
      0,
      "weekend snapshot must not download the full archive",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: newest outings online/offline, hiking/rainy/camping references, search expansion/restoration, category filters, source/map links, dates/expiry, bookmarks, four widths, no archive downloads.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
