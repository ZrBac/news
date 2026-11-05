const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors = [], archive = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (r.url().includes("/data/archive/")) archive.push(r.url()); });
    const data = await (await page.request.get(base + "/data/latest.json")).json();
    const now = new Date().toISOString();
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const categories = ["general", "finance", "livelihood", "tech", "ai", "models", "entertainment", "gaming", "sports", "housing"];
    const story = (id, category, extra = {}) => ({ id, category, title: "一般消息 " + id,
      excerpt: "这是一条供测试使用的一般消息。", sourceId: "test-" + category,
      publishedAt: now, url: "https://example.com/" + id, ...extra });
    const meta = (key, priority) => ({ eventId: "event-" + key.repeat(24), priority,
      summary: "来源公布了这条消息的具体安排。", isBackground: false, updatedAt: now });
    const holiday = story("holiday", "livelihood", { title: "2027年部分节假日安排公布", briefPriority: 3,
      briefEvent: "notice-holidays-2027", editorial: meta("a", 1), publishedAt: new Date(Date.parse(now) - 1000).toISOString() });
    data.updatedAt = now;
    data.briefDays = [today];
    data.articles = categories.map(c => story(c, c)).concat([
      story("follow-up", "livelihood", { title: "放假通知的后续报道", editorial: meta("d", 1), briefEvent: "notice-holidays-2027" }),
      story("major-one", "general", { editorial: meta("b", 3) }),
      story("major-two", "general", { editorial: meta("c", 3) }),
    ]);
    data.briefArticles = [holiday]; // Not in the latest news packet.
    data.modelReleases = []; data.gamingArticles = []; data.housingArticles = [];
    await page.route("**/data/latest.json*", r => r.fulfill({ json: data }));
    await page.goto(base + "/#brief");
    await page.evaluate(() => window.newsInitialLoad);
    const ids = await page.locator(".article").evaluateAll(es => es.map(e => e.dataset.articleId));
    assert.equal(ids.length, 10);
    assert.deepEqual(new Set(ids.slice(0, 3)), new Set(["holiday", "major-one", "major-two"]));
    assert(!ids.includes("follow-up"), "the main notice represents its duplicate reports");
    assert.equal(await page.locator('.article[data-article-id="holiday"] .article-reports a[href="https://example.com/follow-up"]').count(), 1);
    assert.equal(archive.length, 0, "important stories load without downloading the archive");
    assert(new Set(await page.locator(".category-label").allTextContents()).size >= 7);
    await page.locator('[data-save="holiday"]').click();
    await page.locator(".saved-link").click();
    assert.equal(await page.locator('.article[data-article-id="holiday"]').count(), 1);
    await page.locator('[data-view="brief"]').click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log("News coverage: major stories, duplicate reports, supplementary notice, save and mobile layout passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
