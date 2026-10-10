const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8769";
const book = require("../news/guide/book.json");

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const width of [320, 390, 768, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
      });
      await context.addInitScript(require("./legacy-safari.cjs"));
      await context.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { value: true }),
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base + "/guide/");
      await page.locator(".guide-entry").first().waitFor();
      await page.evaluate(() => window.guideInitialLoad);
      assert.equal(await page.locator(".guide-entry").count(), 12);
      assert(
        (await page.locator("#guide-edition").innerText()).includes("676"),
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.locator("#guide-chapter").selectOption("15");
      assert(
        (await page.locator(".entry-meta").first().innerText()).includes(
          "第 15 章",
        ),
      );
      await page.locator("#chapter-intro summary").click();
      assert(await page.locator("#chapter-intro > div").isVisible());
      await page.locator(".guide-entry details summary").first().click();
      await page.waitForFunction(() =>
        document.querySelector(".entry-body").textContent.includes("备注："),
      );
      const body = await page.locator(".entry-body").first().innerText();
      assert(
        body.includes("成本：") &&
          body.includes("来源：") &&
          body.includes("备注："),
      );
      assert.equal(
        await page.locator('.entry-body a[href^="javascript:"]').count(),
        0,
      );
      await page.locator(".entry-save").first().click();
      await page.locator('[data-mode="saved"]').click();
      assert.equal(await page.locator(".guide-entry").count(), 1);
      await page.reload();
      await page.locator('.entry-save[aria-pressed="true"]').waitFor();
      await page.locator('[data-mode="read"]').click();
      await page.locator("#guide-chapter").selectOption("");
      await page.locator("#guide-query").fill("量子虫洞星际飞船");
      assert.equal(await page.locator(".guide-entry").count(), 0);
      await page.locator("#guide-query").fill("租房押金");
      assert((await page.locator(".guide-entry").count()) > 0);
      assert.equal(
        await page
          .locator("#guide-ask, #question-panel, [data-mode=ask]")
          .count(),
        0,
      );
      await page.locator("#offline-status.ready").waitFor({ timeout: 30000 });
      assert.equal(
        await page.locator("#offline-status").innerText(),
        "已准备好，可离线阅读",
      );
      await context.setOffline(true);
      await page.goto(base + "/guide/index.html#saved");
      await page.locator('.entry-save[aria-pressed="true"]').waitFor();
      assert.equal(await page.locator(".guide-entry").count(), 1);
      await page.locator('[data-mode="read"]').click();
      await page.locator("#guide-chapter").selectOption("34");
      await page.locator(".guide-entry details summary").first().click();
      await page.waitForFunction(() =>
        document.querySelector(".entry-body").textContent.includes("备注："),
      );
      await page.goto(base + "/");
      assert(await page.locator('a.guide-link[href="/guide/"]').isVisible());
      await page.locator('a.guide-link[href="/guide/"]').click();
      await page.locator(".guide-entry").first().waitFor();
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `Guide entry, reading, favorites and offline chapters: ${width}px passed`,
      );
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
