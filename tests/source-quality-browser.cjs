const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8769";
const legacy = require("./legacy-safari.cjs");

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const request = await browser.newContext();
    const latest = await (
      await request.request.get(base + "/data/latest.json")
    ).json();
    await request.close();
    const sources = structuredClone(latest.sources);
    const [busy, quiet, failed] = sources.slice(0, 3);
    failed.status = "unavailable";
    const updatedAt = latest.updatedAt;
    const startedAt = new Date(
      Date.parse(updatedAt) - 9 * 86400000,
    ).toISOString();
    const dayOf = (stamp) =>
      new Date(Date.parse(stamp) + 8 * 3600000).toISOString().slice(0, 10);
    const date = dayOf(updatedAt);
    const metric = (source, newCount, duplicateCount, extra = {}) => ({
      id: source.id,
      startedAt,
      newCount,
      duplicateCount,
      duplicateRate: newCount ? duplicateCount / newCount : null,
      checks: 8,
      successes: 8,
      observedDays: 1,
      failureStreak: 0,
      noNewDays: 0,
      lastNewAt: newCount ? updatedAt : null,
      daily: [{ date, checks: 8, successes: 8, newCount, duplicateCount }],
      ...extra,
    });
    const quality = {
      schema: 1,
      windowDays: 7,
      updatedAt,
      startedAt,
      sources: sources.map((source) => metric(source, 0, 0)),
    };
    quality.sources[0] = metric(busy, 100, 65);
    quality.sources[1] = metric(quiet, 0, 0, { noNewDays: 8 });
    quality.sources[2] = metric(failed, 12, 0, {
      failureStreak: 3,
      noNewDays: null,
      successes: 5,
      daily: [
        { date, checks: 8, successes: 5, newCount: 12, duplicateCount: 0 },
      ],
    });
    const qualityPath = "/data/source-quality.0123456789abcdef.json";
    const fixture = {
      ...latest,
      sources,
      sourceQuality: { schema: 1, path: qualityPath, startedAt, updatedAt },
    };
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
      });
      if (process.env.NEWS_LEGACY_SAFARI) await context.addInitScript(legacy);
      let reads = 0;
      await context.route("**/data/latest.json*", (route) =>
        route.fulfill({ json: fixture }),
      );
      await context.route("**" + qualityPath, (route) => {
        reads++;
        return route.fulfill({ json: quality });
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base + "/");
      await page.evaluate(() => window.newsInitialLoad);
      assert.equal(
        reads,
        0,
        "statistics must not compete with initial news loading",
      );
      await page.click("#sources-trigger");
      await page.waitForFunction(() =>
        document
          .querySelector("#source-quality-status")
          ?.textContent.includes("最近统计"),
      );
      assert.equal(reads, 1);
      assert.equal(await page.locator(".source-row").count(), sources.length);
      const busyRow = page.locator(`[data-source-id="${busy.id}"]`);
      assert.match(await busyRow.textContent(), /100 条/);
      assert.match(await busyRow.textContent(), /65%/);
      assert.match(await busyRow.textContent(), /同标题较多/);
      assert.match(
        await page.locator(`[data-source-id="${failed.id}"]`).textContent(),
        /连续失败 3 次/,
      );
      assert.match(
        await page.locator(`[data-source-id="${quiet.id}"]`).textContent(),
        /8 天未新增/,
      );
      await page.selectOption("#source-quality-sort", "new");
      assert.equal(
        await page
          .locator(".source-row")
          .first()
          .getAttribute("data-source-id"),
        busy.id,
      );
      await page.selectOption("#source-quality-sort", "idle");
      assert.equal(
        await page
          .locator(".source-row")
          .first()
          .getAttribute("data-source-id"),
        quiet.id,
      );
      await page.check("#source-quality-attention");
      assert.equal(await page.locator(".source-row").count(), 3);
      await page.uncheck("#source-quality-attention");
      const category = sources.at(-1).category;
      await page.selectOption("#source-quality-category", category);
      assert.equal(
        await page.locator(".source-row").count(),
        sources.filter((source) => source.category === category).length,
      );
      await page.selectOption("#source-quality-category", "all");
      await busyRow.locator(".source-history summary").click();
      assert.deepEqual(await busyRow.locator("tbody td").allTextContents(), [
        date.slice(5).replace("-", "/"),
        "100",
        "65",
        "8/8",
      ]);
      assert.equal(
        await page
          .locator("#info-dialog")
          .evaluate((dialog) => dialog.scrollWidth > dialog.clientWidth + 1),
        false,
      );
      await page.click("#close-dialog");
      await page.reload();
      await page.evaluate(() => window.newsInitialLoad);
      await context.setOffline(true);
      await page.click("#sources-trigger");
      await page.waitForFunction(() =>
        document
          .querySelector("#source-quality-status")
          ?.textContent.includes("最近统计"),
      );
      assert.equal(
        reads,
        1,
        "the immutable summary is reused offline after reopening",
      );
      assert.match(
        await page.locator(`[data-source-id="${busy.id}"]`).textContent(),
        /65%/,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    let invalid = true;
    await context.route("**/data/latest.json*", (route) =>
      route.fulfill({ json: fixture }),
    );
    await context.route("**" + qualityPath, (route) =>
      route.fulfill({
        json: invalid
          ? {
              ...quality,
              sources: [{ ...quality.sources[0], duplicateRate: 9 }],
            }
          : quality,
      }),
    );
    await page.goto(base + "/");
    await page.evaluate(() => window.newsInitialLoad);
    await page.click("#sources-trigger");
    await page.locator("[data-retry-quality]").waitFor();
    assert.match(
      await page.locator("#source-quality-status").textContent(),
      /暂时未能加载/,
    );
    assert.equal(await page.locator(".source-row").count(), sources.length);
    assert(
      await page.locator(".article").count(),
      "an invalid quality file does not block the news list",
    );
    invalid = false;
    await page.click("[data-retry-quality]");
    await page.waitForFunction(() =>
      document
        .querySelector("#source-quality-status")
        ?.textContent.includes("最近统计"),
    );
    assert.match(
      await page.locator(`[data-source-id="${busy.id}"]`).textContent(),
      /65%/,
    );
    await context.close();
    console.log(
      "PASS: lazy source quality, sorting, category and attention filters, daily counts, 3 viewports, legacy dialog, cached offline reading, malformed data and retry.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
