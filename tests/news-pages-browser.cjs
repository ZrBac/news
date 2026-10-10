const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const full = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const latest = await (
      await page.request.get(base + "/data/latest.json")
    ).json();
    assert(full.articles.length > 600);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let fullReads = 0,
      archiveReads = 0,
      failArchive = false;
    await page.route("**/data/news.json*", (route) => {
      fullReads++;
      return route.abort("failed");
    });
    await page.route("**/data/archive/**", (route) => {
      archiveReads++;
      return failArchive
        ? route.fulfill({ status: 503, body: "offline" })
        : route.continue();
    });
    await page.goto(base + "/#all", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator(".article").count(), 12);
    assert.equal(
      archiveReads,
      0,
      "opening latest news must not download the archive",
    );
    for (let i = 0; i < 12; i++) await page.locator("#load-more").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".article").length === 156,
    );
    const cached = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("zrbac-news-cache-v1")),
    );
    assert.equal(cached.archive.loaded, 3);
    assert.deepEqual(
      cached.articles.map((a) => a.id),
      full.articles.slice(0, 600).map((a) => a.id),
    );
    // A search absent from the first page must inspect remaining pages, not claim
    // that a partial list is the complete archive.
    await page.fill("#search", "no_such_headline_982751");
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem("zrbac-news-cache-v1"));
      return data.archive.loaded === data.archive.pages.length;
    });
    const complete = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("zrbac-news-cache-v1")),
    );
    assert.deepEqual(
      complete.articles.map((a) => a.id),
      full.articles.map((a) => a.id),
    );
    await page.fill("#search", full.articles[full.articles.length - 1].title);
    await page.locator(".article").first().waitFor();
    assert(
      (await page.locator(".article h3").allTextContents()).includes(
        full.articles[full.articles.length - 1].title,
      ),
    );
    const date = await page.evaluate(
      (value) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
            .formatToParts(new Date(value))
            .map((p) => [p.type, p.value]),
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
      },
      full.articles[full.articles.length - 1].publishedAt,
    );
    await page.fill("#search", "");
    await page.click("#date-trigger");
    await page.fill("#date-filter", date);
    assert((await page.locator(".article").count()) > 0);
    // Failed history requests never turn a successful current-news refresh into a failure.
    await page.evaluate(
      (data) =>
        localStorage.setItem("zrbac-news-cache-v1", JSON.stringify(data)),
      latest,
    );
    failArchive = true;
    // A fragment-only navigation can reuse the current document and its loaded
    // archive; use a new document when replacing the persisted test cache.
    await page.goto(base + "/?archive-reset=1#all", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => window.newsInitialLoad);
    await page.fill("#search", "no_such_headline_982751");
    await page.locator("[data-retry-archive]").waitFor();
    assert(await page.locator("#load-notice").isHidden());
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).articles
            .length,
      ),
      150,
    );
    failArchive = false;
    await page.locator("[data-retry-archive]").click();
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem("zrbac-news-cache-v1"));
      return data.archive.loaded === data.archive.pages.length;
    });
    assert.equal(fullReads, 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: small first page, no full export downloads, ordered pagination, complete historical search/date, archive failure isolation and retry.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
