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
      let ready = false,
        calls = 0,
        failure = false;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/life-guide/status", (route) =>
        route.fulfill({ json: { ready } }),
      );
      await page.route("**/api/life-guide/chat", async (route) => {
        calls++;
        assert.deepEqual(Object.keys(route.request().postDataJSON()), [
          "question",
        ]);
        await route.fulfill({
          status: failure ? 503 : 200,
          json: failure
            ? { status: "timeout" }
            : {
                status: "ok",
                answer:
                  '<img src=x onerror="window.guideInjected=true">\n先核对合同，见第 15 节第 1 条。',
                references: [{ id: "15-1" }],
                revision: book.revision,
              },
        });
      });
      await page.goto(base + "/guide/");
      await page.locator(".guide-entry").first().waitFor();
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
      await page.locator('[data-mode="ask"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector("#guide-ai-status")
          .textContent.includes("尚未配置"),
      );
      assert(await page.locator("#guide-ask").isDisabled());
      await page.locator("#guide-question").fill("房东不退租房押金怎么办");
      await page.locator("#guide-lookup").click();
      assert(
        (await page.locator("#guide-references .guide-entry").count()) > 0,
      );
      assert.equal(calls, 0);
      ready = true;
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await page.waitForFunction(
        () => !document.querySelector("#guide-ask").disabled,
      );
      await page.locator("#guide-ask").click();
      await page.locator("#guide-answer").waitFor({ state: "visible" });
      assert(
        (await page.locator("#guide-answer").innerText()).includes("第 15 节"),
      );
      assert.equal(await page.locator("#guide-answer img").count(), 0);
      assert.equal(await page.evaluate(() => window.guideInjected), undefined);
      assert.equal(calls, 1);
      assert.equal(
        await page.locator("#guide-references .guide-entry").count(),
        1,
      );
      failure = true;
      await page.locator("#guide-ask").click();
      await page.waitForFunction(() =>
        document.querySelector("#guide-ai-status").textContent.includes("超时"),
      );
      assert(
        (await page.locator("#guide-references .guide-entry").count()) > 0,
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
      await page.locator('[data-mode="ask"]').click();
      assert(
        (await page.locator("#guide-ai-status").innerText()).includes(
          "当前离线",
        ),
      );
      assert(await page.locator("#guide-ask").isDisabled());
      await page.locator("#guide-question").fill("公司裁员要确认什么");
      await page.locator("#guide-lookup").click();
      assert(
        (await page.locator("#guide-references").innerText()).includes(
          "第 19 章",
        ),
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `Guide reading, favorites, offline and mocked AI: ${width}px passed`,
      );
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
