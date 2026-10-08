// Desktop Chrome recovery with an old cache, slow responses and broken HTTP caches.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const data = await (
      await page.request.get(base + "/data/news.json")
    ).json();
    const old = { ...data, updatedAt: "2026-09-24T08:58:00Z" };
    await page.addInitScript(
      (old) => localStorage.setItem("zrbac-news-cache-v1", JSON.stringify(old)),
      old,
    );
    await page.route("**/data/status.json", (route) =>
      route.fulfill({ json: { updatedAt: data.updatedAt } }),
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let mode = "slow",
      requests = [];
    await page.route("**/data/news.json*", async (route) => {
      requests.push(route.request().url());
      if (mode === "slow")
        await new Promise((resolve) => setTimeout(resolve, 16500));
      if (mode === "network" && requests.length === 1)
        return route.abort("failed");
      if (mode === "invalid" && requests.length === 1)
        return route.fulfill({
          body: "<html>broken cache</html>",
          contentType: "application/json",
        });
      if (mode === "http")
        return route.fulfill({ status: 503, body: "unavailable" });
      await route.fulfill({ json: data });
    });
    for (mode of ["slow", "network", "invalid"]) {
      requests = [];
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.locator(".article").first().waitFor();
      assert.match(
        await page.locator("#load-notice").innerText(),
        /后台检查|正在重试/,
      );
      await page.locator('[data-filter="sports"]').click();
      await page.fill("#search", "比赛");
      await page.evaluate(() => window.newsInitialLoad);
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("zrbac-news-cache-v1")).updatedAt,
        ),
        data.updatedAt,
        mode + " must recover old cache",
      );
      assert(await page.locator("#load-notice").isHidden());
      assert.equal(await page.inputValue("#search"), "比赛");
      assert.equal(await page.locator("#section-title").innerText(), "体育");
      assert.equal(requests.length, mode === "slow" ? 1 : 2);
      if (mode !== "slow")
        assert(new URL(requests[1]).searchParams.has("retry"));
    }
    mode = "http";
    requests = [];
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(requests.length, 2);
    assert.match(await page.locator("#load-notice").innerText(), /HTTP 503/);
    assert.match(
      await page.locator("#load-notice").innerText(),
      /09\/24 16:58/,
    );
    assert((await page.locator(".article").count()) > 0);
    mode = "ok";
    requests = [];
    await page.locator("[data-retry]").click();
    await page.waitForFunction(
      () => document.querySelector("#load-notice").hidden,
    );
    assert(
      new URL(requests[0]).searchParams.has("retry"),
      "manual reconnect bypasses a failed browser cache",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: desktop old cache refreshes after a >15s response, network and invalid-data failures retry uncached, HTTP failure remains readable, manual reconnect recovers and preserves filters.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
