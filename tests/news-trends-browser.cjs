const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({args: ["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"], serviceWorkers: "block"});
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.route("**/*.workers.dev/**", route => route.fulfill({json: {}}));
    const page = await context.newPage(), errors = [], external = [], archives = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => {
      if (/newsnow|news\.google/.test(r.url())) external.push(r.url());
      if (r.url().includes("/data/archive/")) archives.push(r.url());
    });
    const data = await (await page.request.get(base + "/data/latest.json")).json();
    const now = new Date().toISOString();
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const categories = ["general", "finance", "livelihood", "tech", "ai", "models", "entertainment", "gaming", "sports", "housing"];
    const story = (id, category, extra = {}) => ({id, category, title: "新闻测试 " + id,
      sourceId: "test-" + category, publishedAt: now, excerpt: "", url: "https://example.com/" + id, ...extra});
    const signal = extra => ({platform: "baidu", name: "百度热搜", rank: 2, previousRank: 10,
      new: false, asOf: now, stale: false, ...extra});
    data.updatedAt = now; data.briefDays = [today]; delete data.archive;
    data.articles = categories.map(c => story(c, c)).concat([
      story("rising", "general", {trend: [signal({})]}),
      story("new", "finance", {trend: [signal({platform: "cls-hot", name: "财联社热门", previousRank: null, new: true})]}),
      story("major", "livelihood", {briefPriority: 3}),
    ]);
    data.briefArticles = []; data.modelReleases = []; data.housingArticles = []; data.gamingArticles = [];
    data.trends = {schema: 1, platforms: ["baidu", "weibo", "thepaper", "cls-hot"].map(id => ({id, status: "ok", observedAt: now}))};
    await page.route("**/data/latest.json*", route => route.fulfill({json: data}));
    await page.goto(base + "/#brief");
    await page.evaluate(() => window.newsInitialLoad);
    const ids = await page.locator(".article").evaluateAll(es => es.map(e => e.dataset.articleId));
    assert.equal(ids[0], "major");
    assert(ids.slice(1, 3).includes("rising") && ids.slice(1, 3).includes("new"));
    assert.equal(await page.locator('[data-article-id="rising"] .trend-label').innerText(), "较上次升温");
    assert.match(await page.locator('[data-article-id="rising"] .trend-label').getAttribute("title"), /百度热搜第 2/);
    assert.equal(await page.locator('[data-article-id="new"] .trend-label').innerText(), "新上榜");
    assert.equal(ids.length, 10);
    assert(new Set(await page.locator(".category-label").allTextContents()).size >= 7);
    assert.match(await page.locator("#view-note").innerText(), /4\/4/);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({width, height: 844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: "/tmp/news-trends-mobile.png"});
    await page.locator('[data-filter="all"]').click();
    assert.equal(await page.locator(".trend-label").count(), 0, "ordinary lists retain chronological reading");
    for (const article of data.articles) {
      if (article.trend) article.trend[0].asOf = new Date(Date.now() - 5 * 3600000).toISOString();
    }
    data.articles.sort((a, b) => Number(!!b.trend) - Number(!!a.trend));
    data.trends.platforms.forEach(b => b.status = "unavailable");
    const oldContext = await browser.newContext({...devices["iPhone 13"], serviceWorkers: "block"});
    await oldContext.addInitScript(require("./legacy-safari.cjs"));
    await oldContext.route("**/*.workers.dev/**", route => route.fulfill({json: {}}));
    await oldContext.route("**/data/latest.json*", route => route.fulfill({json: data}));
    const oldPage = await oldContext.newPage();
    oldPage.on("pageerror", e => errors.push(e.message));
    await oldPage.goto(base + "/#brief");
    await oldPage.evaluate(() => window.newsInitialLoad);
    assert(await oldPage.locator(".trend-label.stale").count() > 0);
    assert(!await oldPage.locator(".trend-label:not(.stale)").count());
    assert.match(await oldPage.locator("#view-note").innerText(), /0\/4.*保留上次/);
    // An old saved packet must not indefinitely advertise a trend as current.
    assert.equal(external.length, 0);
    assert.equal(archives.length, 0);
    assert.deepEqual(errors, []);
    console.log("Hot-list brief: markers, public notices, diversity, stale data, no upstream browser calls and mobile passed.");
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
