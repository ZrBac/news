// Optional end-to-end checks. Set PLAYWRIGHT_MODULE to the installed Playwright module.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator(".article").first().waitFor();
    assert.match(
      await page.locator("#update-status").innerText(),
      /最近检查 .*最新文章/,
    );
    assert.equal(await page.locator(".article").count(), 12);
    await page.click("#load-more");
    assert.equal(await page.locator(".article").count(), 24);

    const news = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const aiUrls = new Set(
      news.articles.filter((a) => a.category === "ai").map((a) => a.url),
    );
    assert(aiUrls.size > 0);
    await page.click('[data-filter="tech"]');
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("#section-title").innerText(), "科技动态");
    while (await page.locator("#load-more").isVisible())
      await page.click("#load-more");
    const techUrls = await page
      .locator(".article h3 a")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    assert(techUrls.length > 0);
    assert.equal(
      techUrls.length,
      news.articles.filter((a) => a.category === "tech").length,
    );
    assert(techUrls.every((url) => !aiUrls.has(url)));

    await page.click('[data-filter="ai"]');
    assert(
      (await page.locator(".article .category-label").allTextContents()).every(
        (t) => t === "人工智能",
      ),
    );
    await page.fill("#search", "这个关键词绝对不存在_842398");
    assert.equal(await page.locator(".article").count(), 0);
    await page.click("[data-reset]");
    await page.locator(".article").first().waitFor();
    await page.selectOption("#source-filter", "chinanews-world");
    assert(
      (await page.locator(".article-meta").allTextContents()).every((t) =>
        t.includes("中新网国际"),
      ),
    );
    await page.selectOption("#source-filter", "all");
    await page.click(".save-button >> nth=0");
    const title = await page.locator(".article h3").first().textContent();
    await page.click(".saved-link");
    assert.equal(await page.locator(".article").count(), 1);
    assert.equal(
      await page.locator(".article h3").first().textContent(),
      title,
    );
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator(".article").count(), 1);
    await page.click(".save-button");
    assert.equal(await page.locator(".article").count(), 0);
    assert.match(
      await page.locator(".empty-state h3").textContent(),
      /还没有收藏/,
    );

    await page.click('a[data-view="brief"]');
    assert.equal(await page.locator("#section-title").innerText(), "每日速览");
    assert.equal(
      await page.locator('a[data-view="brief"]').getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      await page.locator('[data-filter][aria-pressed="true"]').count(),
      0,
    );
    const briefCount = await page.locator(".article").count();
    assert(briefCount > 0 && briefCount <= 10);
    const selectedDate = await page.inputValue("#date-filter");
    assert(selectedDate.length === 10);
    await page.fill("#date-filter", "2020-01-01");
    assert.equal(await page.locator(".article").count(), 0);
    // Clicking the selected tab must reset an empty date/search without requiring a hash change.
    await page.click('a[data-view="brief"]');
    assert.equal(await page.inputValue("#date-filter"), selectedDate);
    assert.equal(await page.locator(".article").count(), briefCount);
    await page.fill("#search", "no_matching_brief_287349");
    assert.equal(await page.locator(".article").count(), 0);
    await page.click('a[data-view="brief"]');
    assert.equal(await page.inputValue("#search"), "");
    assert.equal(await page.locator(".article").count(), briefCount);
    await page.click("#clear-date");
    await page.locator(".article").first().waitFor();

    await page.click('[data-filter="entertainment"]');
    assert.equal(await page.locator("#section-title").innerText(), "文娱");
    assert.equal(await page.inputValue("#date-filter"), "");
    assert((await page.locator(".article").count()) > 0);
    assert(
      (await page.locator(".article .category-label").allTextContents()).every(
        (t) => t === "文娱",
      ),
    );
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("#section-title").innerText(), "文娱");
    assert.equal(
      await page
        .locator('[data-filter="entertainment"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.selectOption("#source-filter", "chinanews-culture");
    assert((await page.locator(".article").count()) > 0);
    assert(
      (await page.locator(".article-meta").allTextContents()).every((t) =>
        t.includes("中新网文娱"),
      ),
    );
    await page.fill("#search", "no_entertainment_results_732985");
    assert.equal(await page.locator(".article").count(), 0);
    await page.fill("#search", "");
    await page.selectOption("#source-filter", "all");

    await page.click('[data-filter="sports"]');
    assert.equal(await page.locator("#section-title").innerText(), "体育");
    assert((await page.locator(".article").count()) > 0);
    assert(
      (await page.locator(".article .category-label").allTextContents()).every(
        (t) => t === "体育",
      ),
    );
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await page.locator('[data-filter="sports"]').getAttribute("aria-pressed"),
      "true",
    );
    await page.selectOption("#source-filter", "chinanews-sports");
    assert((await page.locator(".article").count()) > 0);
    assert(
      (await page.locator(".article-meta").allTextContents()).every((t) =>
        t.includes("中新网体育"),
      ),
    );
    await page.fill("#search", "no_sports_results_849217");
    assert.equal(await page.locator(".article").count(), 0);
    await page.fill("#search", "");
    await page.click(".save-button >> nth=0");
    const sportsTitle = await page.locator(".article h3").first().textContent();
    await page.click(".saved-link");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator(".article").count(), 1);
    assert.equal(
      await page.locator(".article h3").first().textContent(),
      sportsTitle,
    );
    assert.equal(await page.locator(".category-label").innerText(), "体育");
    await page.click(".save-button");
    await page.click('[data-filter="sports"]');

    await page.click("#sources-trigger");
    const publishedSources = (
      await (await page.request.get(base + "/data/news.json")).json()
    ).sources;
    assert.equal(
      await page.locator(".source-row").count(),
      publishedSources.length,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate((e) => e.open), false);
    await page.click("#theme-toggle");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.click("#theme-toggle");
    await page.keyboard.press("Control+k");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.goto(base + "/#all", { waitUntil: "networkidle" });
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `overflow at ${width}`,
      );
    }
    await page.screenshot({
      path: "/tmp/zrbac-news-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/zrbac-news-mobile.png",
      fullPage: true,
    });
    const blog = await page.request.get(base + "/blog/");
    assert.equal(blog.status(), 404);
    assert.equal(await page.locator('a[href="/blog/"]').count(), 0);
    const article = await page.request.get(
      base + "/2020/09/25/Java-8-HashMap/",
    );
    assert.equal(article.status(), 404);
    const feed = await page.request.get(base + "/news.xml");
    assert.equal(feed.status(), 200);
    assert.match(await feed.text(), /<rss/);

    // Verify feed HTML is rendered as inert text, and unsafe URLs never become article links.
    const fixture = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    fixture.articles[0].title = '<img src=x onerror="window.injected=true">';
    fixture.articles[0].excerpt = "<script>window.injected=true</script>";
    fixture.articles[1].url = "javascript:window.injected=true";
    fixture.updatedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    await page.route("**/data/status.json", (route) =>
      route.fulfill({ json: { updatedAt: "fixture-new-version" } }),
    );
    await page.route("**/data/latest.json*", (route) =>
      route.fulfill({ json: fixture }),
    );
    await page.reload({ waitUntil: "networkidle" });
    assert.match(
      await page.locator("#update-status").innerText(),
      /检查已延迟/,
    );
    assert.equal(await page.locator(".article img,.article script").count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);

    await page.unroute("**/data/status.json");
    await page.unroute("**/data/latest.json*");
    await page.route("**/data/latest.json*", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("[data-retry]").waitFor();
    assert((await page.locator(".article").count()) > 0);
    assert.match(
      await page.locator("#load-notice").innerText(),
      /上次成功获取/,
    );
    await page.unroute("**/data/latest.json*");
    await page.click("[data-retry]");
    await page.locator("#load-notice").waitFor({ state: "hidden" });
    await page.locator(".article").first().waitFor();

    // Older browsers without AbortSignal.timeout still load, and a transient
    // first request failure is retried without requiring a click.
    const compatibility = await browser.newPage();
    await compatibility.addInitScript(() => {
      Object.defineProperty(AbortSignal, "timeout", {
        value: undefined,
        configurable: true,
      });
    });
    let requests = 0;
    await compatibility.route("**/data/latest.json*", (route) => {
      requests++;
      return requests === 1 ? route.abort("failed") : route.continue();
    });
    await compatibility.goto(base, { waitUntil: "networkidle" });
    await compatibility.locator(".article").first().waitFor();
    assert.equal(requests, 2);
    // First-time visitors with no cache get a working retry button, not a crash.
    await compatibility.evaluate(() =>
      localStorage.removeItem("zrbac-news-cache-v1"),
    );
    await compatibility.unroute("**/data/latest.json*");
    await compatibility.route("**/data/latest.json*", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await compatibility.reload({ waitUntil: "networkidle" });
    await compatibility.locator("[data-retry]").waitFor();
    assert.equal(await compatibility.locator(".article").count(), 0);
    assert.match(
      await compatibility.locator(".empty-state h3").innerText(),
      /资讯加载失败/,
    );
    await compatibility.unroute("**/data/latest.json*");
    await compatibility.click("[data-retry]");
    await compatibility.locator(".article").first().waitFor();
    await compatibility.close();
    assert.deepEqual(errors, []);
    console.log(
      "PASS: filters, search, pagination, saved persistence, brief/date, source dialog, theme, keyboard, 4 viewports, blog removal, RSS, XSS safety, failure/retry.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
