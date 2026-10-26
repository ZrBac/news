const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
const input = (page, name) => page.locator(`#home-form [name="${name}"]`);
async function add(page, name, price) {
  await page.locator("#add-home").click();
  await input(page, "name").fill(name);
  if (price) await input(page, "price").fill(price);
  await page.locator('#home-form [type="submit"]').click();
  await page.locator("#home-editor").waitFor({ state: "hidden" });
}
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      acceptDownloads: true,
    });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(),
      errors = [],
      writes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() !== "GET") writes.push(request.url());
    });
    await page.goto(base + "/homes/");
    await page.evaluate(() => window.homesInitialLoad);
    assert.match(
      await page.locator("#profile-summary").innerText(),
      /300–350 万/,
    );
    assert.match(
      await page.locator("#profile-summary").innerText(),
      /开车方向待确定/,
    );
    assert.equal(await page.locator(".home-card").count(), 0);
    await add(
      page,
      '西溪测试房 <img src=x onerror="window.injected=1">',
      "330",
    );
    await page.locator("[data-edit]").first().click();
    await input(page, "size").fill("100");
    await input(page, "price").fill("325");
    await input(page, "priceType").selectOption("quoted");
    await input(page, "priceSource").fill("测试销售口头报价");
    await page
      .locator("#home-form summary", { hasText: "两个人的通勤" })
      .click();
    await input(page, "driver").selectOption("yungu");
    for (const [name, value] of Object.entries({
      driverTotal: "35",
      station: "测试地铁站",
      drop: "10",
      wait: "5",
      metro: "20",
      lastLeg: "10",
    }))
      await input(page, name).fill(value);
    await page.locator('#home-form [type="submit"]').click();
    await page.locator("#home-editor").waitFor({ state: "hidden" });
    assert.match(
      await page.locator(".home-card").innerText(),
      /送站＋地铁 45 分钟/,
    );
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator("[data-detail]").click();
    assert.equal(await page.locator("[data-delete-price]").count(), 2);
    await page
      .locator('#visit-form [name="note"]')
      .fill(
        "测试现场记录：采光好，下次确认噪音。<script>window.injected=2</script>",
      );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEfoAAAAASUVORK5CYII=",
      "base64",
    );
    await page
      .locator("#visit-photos")
      .setInputFiles({ name: "test.png", mimeType: "image/png", buffer: png });
    await page.locator('#visit-form [type="submit"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll(".home-photo-grid img").length === 1,
    );
    assert.match(
      await page.locator(".home-photo-grid img").getAttribute("src"),
      /^data:image\/jpeg;base64,/,
    );
    await page.locator('[data-close="home-detail"]').click();
    await page.reload();
    await page.evaluate(() => window.homesInitialLoad);
    assert.equal(await page.locator(".home-card").count(), 1);
    assert.match(await page.locator(".home-card").innerText(), /1 次看房记录/);
    await add(page, "云谷测试房", "360");
    assert.match(
      await page.locator(".home-card").first().innerText(),
      /已知金额超预算 10 万/,
    );
    for (const box of await page.locator("[data-compare]").all())
      await box.check();
    await page.locator("#show-compare").click();
    assert.match(await page.locator("#compare-content").innerText(), /45 分钟/);
    assert.match(
      await page.locator("#compare-content").innerText(),
      /测试现场记录/,
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "compare layout overflow at " + width,
      );
    }
    await page.locator('[data-close="compare-dialog"]').click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "card layout overflow at " + width,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/homes-mobile.png", fullPage: true });
    const downloaded = page.waitForEvent("download");
    await page.locator("#export-homes").click();
    const download = await downloaded,
      backup = await fs.readFile(await download.path(), "utf8");
    const data = JSON.parse(backup);
    assert.equal(data.homes.length, 2);
    assert.equal(data.homes[0].visits[0].photos.length, 1);
    // New browser/device restores everything; conflicting imports keep both versions.
    const other = await browser.newContext({ ...devices["iPhone 13"] });
    const restored = await other.newPage();
    await restored.goto(base + "/homes/");
    await restored.evaluate(() => window.homesInitialLoad);
    restored.on("dialog", (dialog) => dialog.accept());
    await restored
      .locator("#backup-file")
      .setInputFiles({
        name: "homes.json",
        mimeType: "application/json",
        buffer: Buffer.from(backup),
      });
    await restored.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 2,
    );
    const bad = JSON.parse(backup);
    bad.homes[0].sourceUrl = "javascript:alert(1)";
    await restored
      .locator("#backup-file")
      .setInputFiles({
        name: "bad.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(bad)),
      });
    await restored.waitForFunction(() =>
      document.querySelector("#home-message").textContent.includes("导入失败"),
    );
    assert.equal(await restored.locator(".home-card").count(), 2);
    data.homes[0].reason = "旧备份中的不同意见";
    await restored
      .locator("#backup-file")
      .setInputFiles({
        name: "older.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(data)),
      });
    await restored.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 3,
    );
    assert.match(await restored.locator("#home-list").innerText(), /导入副本/);
    // An editor left open in another tab must never overwrite newer committed notes.
    const second = await context.newPage();
    await second.goto(base + "/homes/");
    await second.evaluate(() => window.homesInitialLoad);
    await page.locator("[data-edit]").first().click();
    await input(page, "reason").fill("尚未保存的旧标签页");
    await second.locator("[data-edit]").first().click();
    await input(second, "reason").fill("新标签页刚保存的理由");
    await second.locator('#home-form [type="submit"]').click();
    await second.locator("#home-editor").waitFor({ state: "hidden" });
    await page.locator('#home-form [type="submit"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector("#home-form .home-form-error")
        .textContent.includes("另一页面"),
    );
    assert.equal(
      await input(page, "reason").inputValue(),
      "尚未保存的旧标签页",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-close="home-editor"]').first().click();
    await page.waitForFunction(() =>
      document
        .querySelector("#home-list")
        .textContent.includes("新标签页刚保存的理由"),
    );
    await page.waitForFunction(
      () => document.querySelector("#offline-status").dataset.state === "ready",
      { timeout: 45000 },
    );
    await context.setOffline(true);
    await page.reload();
    await page.evaluate(() => window.homesInitialLoad);
    assert.equal(await page.locator(".home-card").count(), 2);
    await add(page, "离线添加测试", "310");
    await page.reload();
    await page.evaluate(() => window.homesInitialLoad);
    assert.equal(await page.locator(".home-card").count(), 3);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.deepEqual(writes, [], "notes and photos must never be uploaded");
    assert.deepEqual(errors, []);
    // Disabled storage must be explicit; the app cannot claim an in-memory save.
    const blocked = await browser.newContext();
    await blocked.addInitScript(() =>
      Object.defineProperty(window, "indexedDB", {
        get() {
          throw new Error("Storage denied");
        },
      }),
    );
    const denied = await blocked.newPage();
    await denied.goto(base + "/homes/");
    await denied.locator("#storage-error").waitFor();
    assert(await denied.locator("#add-home").isDisabled());
    await other.close();
    await blocked.close();
    await context.close();
    console.log(
      "PASS: home notebook mobile/legacy dialogs, real persistence, typed price history, commute totals, compressed photos, comparison, safe backup restore, conflict copies, tab conflicts, offline edits, and unavailable storage.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
