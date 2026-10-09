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
    const errors = [],
      archives = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().includes("/data/archive/")) archives.push(r.url());
    });
    await page.goto(base + "/#housing");
    await page.locator(".price-card").first().waitFor();
    assert.equal(
      await page.locator("#section-title").innerText(),
      "杭州成交价",
    );
    assert.equal(
      await page.locator(".filter-tabs > :last-child").innerText(),
      "杭州成交价",
    );
    assert.equal(await page.locator(".price-card").count(), 2);
    assert.equal(await page.locator(".official-grid > div").count(), 2);
    assert.match(
      await page.locator(".official-prices").innerText(),
      /环比.*(?:上涨|下降|持平)/s,
    );
    assert.equal(await page.locator(".housing-table tbody tr").count(), 10);
    assert.match(await page.locator(".cric-prices").innerText(), /元\/㎡/);
    const marketBefore = await page
      .locator(".housing-market")
      .allTextContents();

    assert.equal(
      await page.locator(".housing-watchlist, .watch-project").count(),
      0,
    );
    assert.equal(
      await page.locator(".xihu-hotspots, #xihu-heading").count(),
      0,
    );
    assert.equal(
      await page
        .locator(
          ".watch-fact, .xihu-property, .price-samples, .price-links, [data-housing-type]",
        )
        .count(),
      0,
    );
    assert.doesNotMatch(
      await page.locator("#housing-prices").innerText(),
      /西湖区房源动态|紫璋台|建发云启之江|润启未来之城|约340万元|36,047|25,085|资料核实于|小区成交样本/,
    );
    assert.match(
      await page.locator("#housing-prices").innerText(),
      /统计期.*2026-/,
    );
    assert.match(
      await page.locator("#housing-prices").innerText(),
      /暂未接入全市实时逐套成交库/,
    );
    assert.equal(await page.locator("#articles").isVisible(), false);
    assert.equal(await page.locator("#search").isVisible(), false);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no overflow at " + width,
      );
    }
    assert.equal(
      archives.length,
      0,
      "price section must not download the news archive",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/housing-prices-mobile.png",
      fullPage: true,
    });
    const prices = await page.locator(".price-value").allTextContents();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.locator(".price-card").first().waitFor();
    assert.deepEqual(
      await page.locator(".price-value").allTextContents(),
      prices,
    );
    assert.equal(await page.locator(".watch-project").count(), 0);
    assert.equal(
      await page.locator(".xihu-hotspots, #xihu-heading").count(),
      0,
    );
    assert.deepEqual(
      await page.locator(".housing-market").allTextContents(),
      marketBefore,
    );
    await page.locator('[data-filter="all"]').click();
    await page.locator(".article").first().waitFor();
    assert(await page.locator("#search").isVisible());
    assert.equal(await page.locator("#housing-prices").isVisible(), false);
    await page.locator('[data-filter="housing"]').click();
    assert(await page.locator(".price-card").first().isVisible());
    assert.deepEqual(errors, []);
    console.log(
      "PASS: transaction price periods, last tab, no archive download, four widths, offline prices and news navigation.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
