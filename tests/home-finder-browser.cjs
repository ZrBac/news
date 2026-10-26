const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
const server = spawn(
  "python3",
  [path.join(__dirname, "homes_api_testserver.py"), new URL(base).origin],
  { stdio: ["ignore", "pipe", "inherit"] },
);
async function boot() {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("test backend did not start")),
      10000,
    );
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(output.split("\n")[0]));
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("test backend exited " + code));
    });
  });
}
async function add(page, name) {
  await page.locator("#add-home").click();
  await page.locator('#home-form [name="name"]').fill(name);
  await page.locator('#home-form [type="submit"]').click();
  await page.locator("#home-editor").waitFor({ state: "hidden" });
}
const synced = async (page) => {
  try {
    await page.waitForFunction(() =>
      document
        .querySelector("#cloud-status")
        .textContent.startsWith("已同步到"),
    );
  } catch (error) {
    throw new Error(
      `${error.message}; status=${await page.locator("#cloud-status").innerText()}; dialog=${await page.locator("#sync-error").textContent()}`,
    );
  }
};
(async () => {
  const config = await boot(),
    api = `http://127.0.0.1:${config.port}/api/homes`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const errors = [];
    async function device() {
      const context = await browser.newContext({
        ...devices["iPhone 13"],
        serviceWorkers: "block",
        permissions: ["local-network-access"],
      });
      await context.route("**/homes/", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: (await response.text()).replace(
            'content="https://zacai.fun/api/homes"',
            `content="${api}"`,
          ),
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (msg) => {
        if (msg.type() === "error" && msg.text().includes("fetch"))
          console.log(msg.text());
      });
      page.on("requestfailed", (request) => {
        if (request.url().startsWith(api))
          console.log("Test API request failed:", request.failure()?.errorText);
      });
      page.on("response", (response) => {
        if (response.url().startsWith(api) && response.status() >= 400)
          console.log("Test API status:", response.status());
      });
      return { page, context };
    }
    const first = await device(),
      second = await device();
    const a = first.page,
      b = second.page;
    await a.goto(base + "/homes/");
    await a.evaluate(() =>
      Promise.all([window.homeCandidatesReady, window.homesInitialLoad]),
    );
    assert(
      (await a.locator(".candidate-card").count()) > 0,
      "prepopulated budget candidates",
    );
    await a.locator("#candidate-kind").selectOption("new");
    await a.locator("[data-save-candidate]").first().click();
    await a.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 1,
    );
    assert.match(
      await a.locator(".home-card").innerText(),
      /价格待补充/,
      "project estimate is not a unit asking quote",
    );
    await a.locator("#candidate-kind").selectOption("resale");
    await a.locator("[data-save-candidate]").first().click();
    await a.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 2,
    );
    assert.match(await a.locator("#home-list").innerText(), /挂牌价/);
    for (const width of [320, 390, 768, 1440]) {
      await a.setViewportSize({ width, height: 844 });
      assert(
        await a.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "candidate layout overflow " + width,
      );
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: "/tmp/home-finder-mobile.png", fullPage: true });
    await a.locator("[data-detail]").first().click();
    await a
      .locator('#visit-form [name="note"]')
      .fill("两人共用的现场照片与笔记");
    await a.locator("#visit-photos").setInputFiles({
      name: "room.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEfoAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await a.locator('#visit-form [type="submit"]').click();
    await a.waitForFunction(
      () => document.querySelectorAll(".home-photo-grid img").length === 1,
    );
    await a.locator('[data-close="home-detail"]').first().click();
    // An existing local notebook migrates when the private link is opened.
    await a.goto(base + "/homes/#sync=" + config.token);
    await synced(a);
    assert.equal(
      new URL(a.url()).hash,
      "",
      "private token removed from the address bar",
    );
    await b.goto(base + "/homes/#sync=" + config.token);
    await synced(b);
    assert.equal(
      await b.locator(".home-card").count(),
      2,
      "second device receives migrated data",
    );
    await b.locator("[data-detail]").first().click();
    assert.match(
      await b.locator("#detail-content").innerText(),
      /两人共用的现场照片与笔记/,
    );
    assert.match(
      await b.locator(".home-photo-grid img").getAttribute("src"),
      /^data:image\/jpeg;base64,/,
    );
    await b.locator('[data-close="home-detail"]').first().click();
    // A device can edit while disconnected. An online edit on the other device must survive.
    await first.context.setOffline(true);
    await add(a, "离线记录 A");
    await add(b, "另一设备记录 B");
    await synced(b);
    await first.context.setOffline(false);
    await a.locator("#cloud-sync").click();
    await a.locator("#cloud-merge").waitFor({ state: "visible" });
    a.on("dialog", (dialog) => dialog.accept());
    await a.locator("#cloud-merge").click();
    await synced(a);
    assert.equal(await a.locator(".home-card").count(), 4);
    await b.locator("#cloud-sync").click();
    await b.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 4,
    );
    assert.match(await b.locator("#home-list").innerText(), /离线记录 A/);
    assert.match(await b.locator("#home-list").innerText(), /另一设备记录 B/);
    // A remote change must not replace the draft in an open editor.
    await b.locator("[data-edit]").first().click();
    await b.locator('#home-form [name="reason"]').fill("未保存的现场意见");
    await add(a, "较新的服务端记录");
    await synced(a);
    await b.evaluate(() => window.HomeCloud.sync());
    assert.equal(
      await b.locator('#home-form [name="reason"]').inputValue(),
      "未保存的现场意见",
    );
    b.on("dialog", (dialog) => dialog.accept());
    await b.locator('[data-close="home-editor"]').first().click();
    await b.waitForFunction(
      () => document.querySelectorAll(".home-card").length === 5,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Home finder: candidate price provenance, mobile layout, local migration, two-device sync, offline conflict and draft preservation passed",
    );
  } finally {
    await browser.close();
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.kill("SIGTERM"));
