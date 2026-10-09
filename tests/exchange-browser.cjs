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
    const page = await context.newPage(),
      errors = [],
      archives = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().includes("/data/archive/")) archives.push(r.url());
    });
    await page.goto(base + "/#exchange");
    await page.locator(".fx-value").waitFor();
    assert.equal(await page.locator("#section-title").innerText(), "汇率");
    assert.equal(
      await page
        .locator('[data-filter="exchange"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator("#search").isVisible(), false);
    assert.equal(await page.locator("#articles").isVisible(), false);
    assert.equal(await page.locator("#housing-prices").isVisible(), false);
    assert.match(await page.locator(".fx-notes").innerText(), /20个自然日/);
    const before = await page.locator("#fx-readout").innerText();
    await page.locator("#fx-day").fill("0");
    const first = await page.locator("#fx-readout").innerText();
    assert.notEqual(first, before);
    assert.equal(await page.locator(".fx-point.selected").count(), 1);
    await page.locator(".fx-records summary").click();
    assert((await page.locator(".fx-records tbody tr").count()) >= 15);
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
    await page.locator(".fx-records summary").click();
    await page.screenshot({ path: "/tmp/exchange-mobile.png", fullPage: true });
    assert.equal(archives.length, 0);
    const prices = await page.locator(".fx-value").innerText();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.locator(".fx-value").waitFor();
    assert.equal(await page.locator(".fx-value").innerText(), prices);
    await page.locator("#fx-day").fill("0");
    assert.equal(await page.locator("#fx-readout").innerText(), first);
    await page.locator('[data-filter="housing"]').click();
    await page.locator(".price-card").first().waitFor();
    assert.equal(await page.locator("#exchange-rates").isVisible(), false);
    await page.locator('[data-filter="all"]').click();
    await page.locator(".article").first().waitFor();
    assert(await page.locator("#search").isVisible());
    assert.deepEqual(errors, []);
    await context.close();
    const request = await browser.newContext();
    const response = await request.request.get(base + "/data/latest.json");
    const original = await response.json();
    await request.close();
    const today = new Date().toISOString().slice(0, 10),
      points = [];
    for (let n = 45; n >= 0; n--) {
      const d = new Date(Date.parse(today) - n * 86400000);
      if (![0, 6].includes(d.getUTCDay()))
        points.push({ date: d.toISOString().slice(0, 10), rate: 7 + n / 1000 });
    }
    points.at(-1).rate = 6;
    for (const scenario of [
      "low",
      "tie",
      "higher",
      "failed",
      "short",
      "stale",
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      const data = JSON.parse(JSON.stringify(original));
      data.exchangeRates = {
        ...data.exchangeRates,
        status: "ok",
        asOfDate: today,
        points: JSON.parse(JSON.stringify(points)),
      };
      if (scenario === "tie") data.exchangeRates.points.at(-2).rate = 6;
      if (scenario === "higher") data.exchangeRates.points.at(-1).rate = 8;
      if (scenario === "failed") data.exchangeRates.status = "unavailable";
      if (scenario === "short")
        data.exchangeRates.points = data.exchangeRates.points.slice(-3);
      if (scenario === "stale")
        data.exchangeRates.points.forEach(
          (p) =>
            (p.date = new Date(Date.parse(p.date) - 10 * 86400000)
              .toISOString()
              .slice(0, 10)),
        );
      await ctx.route("**/data/latest.json*", (r) => r.fulfill({ json: data }));
      const tab = await ctx.newPage();
      await tab.goto(base + "/#exchange");
      await tab.locator(".fx-summary").waitFor();
      assert.equal(
        await tab.locator(".fx-summary.is-low").count(),
        ["low", "tie"].includes(scenario) ? 1 : 0,
        scenario,
      );
      if (scenario === "tie")
        assert.match(await tab.locator(".fx-alert").innerText(), /并列/);
      if (scenario === "low")
        await tab.screenshot({
          path: "/tmp/exchange-low-mobile.png",
          fullPage: true,
        });
      await ctx.close();
    }
    console.log(
      "PASS: USD/CNY view, slider, history, four widths, offline, no archives, navigation, low/tie/non-low/failure/insufficient/stale alerts.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
