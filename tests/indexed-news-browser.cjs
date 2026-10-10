const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8769";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const full = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const latest = await (
      await page.request.get(base + "/data/latest.json")
    ).json();
    const target = full.articles.at(-1);
    const recentGameSources = new Set(
      latest.gamingArticles.map((a) => a.sourceId),
    );
    const rare =
      full.articles.find(
        (a) => a.category === "gaming" && !recentGameSources.has(a.sourceId),
      ) || full.articles.filter((a) => a.category === "gaming").at(-1);
    assert(rare, "preview needs game news for its game-column checks");
    const rareName = full.sources.find(
      (source) => source.id === rare.sourceId,
    ).name;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date(rare.publishedAt))
        .map((part) => [part.type, part.value]),
    );
    const rareDay = parts.year + "-" + parts.month + "-" + parts.day;
    async function selectRare() {
      if (await page.locator("#date-panel").isHidden())
        await page.click("#date-trigger");
      await page.fill("#date-filter", rareDay);
      await page.selectOption("#source-filter", rare.sourceId);
      await page.waitForFunction(
        (title) =>
          Array.from(document.querySelectorAll(".article h3")).some(
            (el) => el.textContent === title,
          ) && document.querySelector("#archive-notice").hidden,
        rare.title,
      );
    }
    let exportReads = 0,
      indexReads = 0,
      pageReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/data/news.json") exportReads++;
      else if (path.includes("/data/archive/index.")) indexReads++;
      else if (path.startsWith("/data/archive/")) pageReads++;
    });
    await page.goto(base + "/#all");
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(indexReads, 0);
    assert.equal(pageReads, 0);
    await page.fill("#search", "no_such_headline_982751");
    await page.waitForFunction(
      () => document.querySelector("#result-count").textContent === "0 条资讯",
    );
    assert.equal(indexReads, 1);
    assert.equal(
      pageReads,
      0,
      "an absent keyword needs an index, not every historical story",
    );
    await page.fill("#search", target.title);
    await page.locator(".article h3").first().waitFor();
    assert(
      (await page.locator(".article h3").allTextContents()).includes(
        target.title,
      ),
    );
    assert(
      pageReads <= 3,
      "historical search downloads only matching category chunks",
    );
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).articles
            .length,
      ),
      150,
    );
    await page.fill("#search", "");
    await page.click('[data-filter="gaming"]');
    const sportsSource = full.articles.find(
      (a) =>
        a.category === "sports" &&
        !latest.archive.categories.gaming.includes(a.sourceId),
    ).sourceId;
    assert.equal(
      await page
        .locator(`#source-filter option[value="${sportsSource}"]`)
        .count(),
      0,
    );
    await selectRare();
    assert(
      (await page.locator(".article-meta").first().innerText()).includes(
        rareName,
      ),
    );
    await page.click(".save-button");
    await page.click(".saved-link");
    const savedTitle = await page.locator(".article h3").first().innerText();
    await page
      .locator(".article h3 a")
      .first()
      .evaluate((link) => {
        link.addEventListener("click", (event) => event.preventDefault(), {
          once: true,
        });
        link.click();
      });
    assert.equal(await page.locator(".read-label").first().innerText(), "已读");
    await page.locator(".reading-options summary").click();
    await page.check("#only-unread");
    assert.match(
      await page.locator(".reading-options summary").innerText(),
      /只看未读/,
    );
    assert.equal(await page.locator(".article").count(), 0);
    await page.uncheck("#only-unread");
    await page.selectOption("#reading-size", "larger");
    assert(
      (await page
        .locator(".article h3")
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 20,
    );
    await page.goto(base + "/guide/");
    await page.locator(".entry-save").first().click();
    await page.locator(".reading-options summary").click();
    const downloading = page.waitForEvent("download");
    await page.click("#export-bookmarks");
    const backup = JSON.parse(
      await fs.readFile(await (await downloading).path(), "utf8"),
    );
    assert.equal(backup.newsSaved.length, 1);
    assert.equal(backup.guideSaved.length, 1);
    await page.evaluate(() => {
      localStorage.removeItem("zrbac-news-saved-v1");
      localStorage.removeItem("zrbac-guide-saved");
    });
    await page.goto(base + "/#saved");
    await page.locator(".reading-options summary").click();
    await page.setInputFiles("#bookmarks-file", {
      name: "bookmarks.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await page.waitForFunction(() =>
      document.querySelector("#reading-status").textContent.includes("已合并"),
    );
    assert.equal(
      await page.locator(".article h3").first().innerText(),
      savedTitle,
    );
    await page.setInputFiles("#bookmarks-file", {
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          ...backup,
          newsSaved: [{ ...backup.newsSaved[0], url: "javascript:alert(1)" }],
        }),
      ),
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#reading-status")
        .textContent.includes("格式不正确"),
    );
    assert.equal(
      await page.locator(".article h3").first().innerText(),
      savedTitle,
    );
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.goto(base + "/#gaming");
    await selectRare();
    await page.waitForFunction(
      () =>
        document.querySelector(".article h3") &&
        document.querySelector("#archive-notice").hidden,
    );
    assert(
      (await page.locator(".article-meta").first().innerText()).includes(
        rareName,
      ),
    );
    await page.reload();
    await page.evaluate(() => window.newsInitialLoad);
    await selectRare();
    await page.waitForFunction(
      () =>
        document.querySelector(".article h3") &&
        document.querySelector("#archive-notice").hidden,
    );
    assert.equal(await page.inputValue("#reading-size"), "larger");
    assert.equal(exportReads, 0);
    assert.deepEqual(errors, []);
    await context.close();
    const duplicateContext = await browser.newContext({
      serviceWorkers: "block",
    });
    const duplicatePage = await duplicateContext.newPage();
    const sample = structuredClone(latest);
    sample.archive = { pages: [], loaded: 0, total: sample.articles.length };
    const secondSource = sample.sources.find(
      (source) => source.id !== sample.articles[0].sourceId,
    ).id;
    sample.articles[0] = {
      ...sample.articles[0],
      title: "测试：同一条新闻",
      url: "https://one.example.test/story",
    };
    sample.articles[1] = {
      ...sample.articles[0],
      id: "second-report",
      url: "https://two.example.test/story",
      sourceId: secondSource,
    };
    await duplicatePage.route("**/data/latest.json*", (route) =>
      route.fulfill({ json: sample }),
    );
    await duplicatePage.goto(base + "/#all");
    await duplicatePage.evaluate(() => window.newsInitialLoad);
    assert.equal(
      await duplicatePage
        .locator(".article h3")
        .filter({ hasText: "测试：同一条新闻" })
        .count(),
      1,
    );
    const reports = duplicatePage
      .locator(".article")
      .filter({
        has: duplicatePage.locator("h3", { hasText: "测试：同一条新闻" }),
      })
      .locator(".article-reports");
    await reports.locator("summary").click();
    assert.equal(await reports.locator("a").count(), 1);
    await duplicatePage.selectOption("#source-filter", secondSource);
    assert.equal(
      await duplicatePage
        .locator(".article h3")
        .filter({ hasText: "测试：同一条新闻" })
        .count(),
      1,
    );
    await duplicateContext.close();
    // A failed history chunk remains retryable without erasing the latest news.
    const retryContext = await browser.newContext({ serviceWorkers: "block" });
    const retryPage = await retryContext.newPage();
    let failed = true;
    await retryPage.route("**/data/archive/**", (route) =>
      new URL(route.request().url()).pathname.includes("index.") || !failed
        ? route.continue()
        : route.fulfill({ status: 503, body: "unavailable" }),
    );
    await retryPage.goto(base + "/#all");
    await retryPage.evaluate(() => window.newsInitialLoad);
    await retryPage.fill("#search", target.title);
    await retryPage.locator("[data-retry-archive]").waitFor();
    assert(await retryPage.locator("#load-notice").isHidden());
    failed = false;
    await retryPage.click("[data-retry-archive]");
    await retryPage.locator(".article h3").first().waitFor();
    assert(
      (await retryPage.locator(".article h3").allTextContents()).includes(
        target.title,
      ),
    );
    await retryContext.close();
    console.log(
      "PASS: indexed search, rare game sources, scoped sources, small persisted snapshot, cached offline history, read markers, font preference, bookmark backup/merge/rejection and chunk retries.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
