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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/#housing");
    await page.locator(".article").first().waitFor();
    assert.equal(await page.locator("#section-title").innerText(), "杭州房市");
    assert.equal(
      await page
        .locator('[data-filter="housing"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert(
      (await page.locator(".article .category-label").allTextContents()).every(
        (t) => t === "杭州房市",
      ),
    );
    assert.match(
      await page.locator("#view-note").innerText(),
      /新房、二手房成交/,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no horizontal overflow at " + width,
      );
      assert(await page.locator('[data-filter="housing"]').isVisible());
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill("#search", "二手房");
    await page.locator(".article").first().waitFor();
    assert(
      (await page.locator(".article").allTextContents()).every((t) =>
        t.includes("二手房"),
      ),
    );
    await page.selectOption("#source-filter", "hz-housing-tide");
    await page.locator(".article").first().waitFor();
    assert(
      (await page.locator(".article-meta").allTextContents()).every((t) =>
        t.includes("潮新闻"),
      ),
    );
    await page.locator(".save-button").first().click();
    const title = await page.locator(".article h3").first().innerText();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.goto(base + "/#saved");
    await page.locator(".article").first().waitFor();
    assert.equal(await page.locator(".article h3").first().innerText(), title);
    assert.equal(
      await page.locator(".category-label").first().innerText(),
      "杭州房市",
    );
    await page.goto(base + "/#housing");
    await page.reload();
    await page.locator(".article").first().waitFor();
    assert.equal(await page.locator("#section-title").innerText(), "杭州房市");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: housing direct route, dedicated labels, mobile tabs, search, source filter, saved housing article and offline navigation.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
