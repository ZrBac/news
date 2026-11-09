const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() => { Date.now = () => Date.parse("2026-11-05T08:00:00Z"); });
    const page = await context.newPage(), errors = [], external = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(base)) external.push(r.url()); });
    const packet = JSON.parse(fs.readFileSync(path.join(process.env.NEWS_TEST_SITE || "_site", "data/latest.json")));
    const source = category => packet.sources.find(s => s.category === category).id;
    const story = (id, category, title, event) => ({
      id, category, title, sourceId: source(category), url: "https://example.com/" + id,
      publishedAt: "2026-11-05T07:00:00Z", excerpt: "原订阅摘要保留供读取失败时使用。",
      editorial: {eventId: "event-" + event.repeat(24), summary: "订阅摘要整理的简短消息。", updatedAt: "2026-11-05T07:10:00Z"},
    });
    const general = story("brief-detail", "general", "本月公开服务安排", "a");
    const model = story("model-detail", "models", "示例模型发布新版本", "b");
    const fallback = story("model-fallback", "models", "另一模型开放预览", "c");
    const report = { ...general, id: "other-report", url: "https://example.com/other-report", title: "同一服务的另一篇报道" };
    const details = (article, summary) => ({revision: "news-details-v2", inputHash: "f".repeat(24),
      summary, sourceUrl: article.url, updatedAt: "2026-11-05T07:30:00Z"});
    general.newsDetail = details(general, "登记已开放，工作日可在官方平台提交申请。");
    model.newsDetail = details(model, "模型已面向现有开发者开放预览，新增图表理解功能；模型权重仍待开放，申请体验需要已有开发者账号。");
    report.newsDetail = details(report, "这是另一篇报道专属的补充内容，不能覆盖当前卡片自己的原文依据或混入另一条新闻的摘要。");
    fallback.newsDetail = { ...details(fallback, model.newsDetail.summary), sourceUrl: "https://elsewhere.test/wrong" };
    packet.updatedAt = "2026-11-05T07:40:00Z";
    packet.articles = [general, model, fallback, report];
    packet.briefArticles = packet.articles;
    packet.briefDays = ["2026-11-05", "2026-11-04"];
    packet.modelReleases = [model, fallback];
    packet.gamingArticles = packet.housingArticles = [];
    delete packet.archive;
    await page.route("**/data/latest.json*", route => route.fulfill({json: packet}));
    await page.goto(base + "/#brief", {waitUntil: "domcontentloaded"});
    await page.locator('[data-article-id="brief-detail"]').waitFor();
    assert.equal(await page.locator('[data-summary-source="article"]').count(), 2);
    assert.equal(await page.locator('[data-article-id="brief-detail"] .editorial-summary').innerText(), general.newsDetail.summary);
    assert.equal(await page.locator('[data-article-id="model-fallback"] .editorial-summary').innerText(), fallback.editorial.summary);
    assert.equal(await page.locator('.article-reports a').count(), 1);
    assert(!(await page.locator('#articles').innerText()).includes("另一篇报道专属"));
    assert(await page.evaluate(a => window.NewsEditorial.detail(a) === null,
      {...model, newsDetail: {...model.newsDetail, revision: "unknown"}}));
    await page.locator('[data-filter="general"]').click();
    assert.equal(await page.locator('[data-article-id="brief-detail"] .editorial-summary').innerText(), general.newsDetail.summary, "ordinary categories use verified details too");
    await page.fill('#search', '工作日');
    assert.equal(await page.locator('.article').count(), 1, 'ordinary category details are searchable');
    await page.fill('#search', '');
    const expanded = ['finance','livelihood','tech','ai','entertainment','gaming','sports','housing'].map((category,index) => {
      const article = story('detail-' + category, category, category + '栏目的最新报道', 'def01234'[index]);
      article.newsDetail = details(article, '本次已公布该栏目特有的新安排及适用范围，具体条件需在公布期限内核对。');
      return article;
    });
    packet.articles.push(...expanded);
    packet.gamingArticles = expanded.filter(a => a.category === 'gaming');
    packet.housingArticles = expanded.filter(a => a.category === 'housing');
    await page.reload({waitUntil:'domcontentloaded'});
    for (const article of expanded) {
      await page.locator(`[data-filter="${article.category}"]`).click();
      const container = article.category === 'housing' ? '#housing-news' : '#articles';
      const card = page.locator(`${container} [data-article-id="${article.id}"]`);
      await card.waitFor();
      assert.equal(await card.locator('.editorial-summary').innerText(), article.newsDetail.summary, article.category + ' displays source-backed detail');
    }
    await page.locator('[data-filter="models"]').click();
    assert.equal(await page.locator('[data-summary-source="article"]').count(), 1);
    assert.match(await page.locator('[data-article-id="model-fallback"]').innerText(), /原订阅摘要/);
    await page.fill('#search', '开发者账号');
    assert.equal(await page.locator('.article').count(), 1, 'displayed details are searchable');
    assert.equal(await page.locator('.article').getAttribute('data-article-id'), 'model-detail');
    await page.fill('#search', '');
    await page.locator('[data-save="model-detail"]').click();
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem("zrbac-news-saved-v1")).some(a => a.newsDetail)));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({width, height: 844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no overflow at " + width);
    }
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.unroute("**/data/latest.json*");
    await context.setOffline(true);
    await page.reload({waitUntil: "domcontentloaded"});
    await page.locator('[data-summary-source="article"]').waitFor();
    assert.equal(await page.locator('[data-article-id="model-detail"] .editorial-summary').innerText(), model.newsDetail.summary);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "reading source details never downloads original articles or calls an external API");
    await context.close();
    console.log("News details passed: category-wide details, attribution, fallback, grouping, search, mobile and offline reading");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
