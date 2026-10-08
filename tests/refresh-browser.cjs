const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
const endpoint = process.env.NEWS_REFRESH_ENDPOINT || "https://zacai.fun/api/news-refresh";

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const original = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const updated = structuredClone(original);
    updated.updatedAt = new Date(Date.now()).toISOString();
    let mode = "running";
    let posts = 0;
    await page.route(endpoint + "**", (route) => {
      const request = route.request();
      if (request.method() === "POST") posts++;
      if (mode === "unavailable") return route.abort("failed");
      return route.fulfill({
        headers: { "Access-Control-Allow-Origin": "*" },
        json: {
          status: request.url().endsWith("/status") ? "ready" : mode,
          baselineAt: original.updatedAt,
        },
      });
    });
    await page.goto(base + "/#sports", { waitUntil: "networkidle" });
    await page.locator(".article").first().waitFor();
    await page.selectOption("#source-filter", "cna-sports");
    await page.route("**/data/news.json*", (route) =>
      route.fulfill({ json: updated }),
    );
    await page.click("#refresh-news");
    assert(await page.locator("#refresh-news").isDisabled());
    await page.waitForFunction(() =>
      document
        .querySelector("#refresh-notice")
        .textContent.includes("刷新完成"),
    );
    assert.equal(posts, 1);
    assert.equal(await page.locator("#section-title").innerText(), "体育");
    assert.equal(await page.inputValue("#source-filter"), "cna-sports");
    assert(!(await page.locator("#refresh-news").isDisabled()));
    mode = "cooldown";
    await page.click("#refresh-news");
    await page.waitForFunction(() =>
      document
        .querySelector("#refresh-notice")
        .textContent.includes("每 15 分钟"),
    );
    mode = "unavailable";
    await page.click("#refresh-news");
    await page.waitForFunction(() =>
      document
        .querySelector("#refresh-notice")
        .textContent.includes("暂时无法确认"),
    );
    assert((await page.locator(".article").count()) > 0);
    assert(!(await page.locator("#refresh-news").isDisabled()));
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: refresh progress, completion, cooldown, API outage fallback, preserved filters, responsive layout.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
