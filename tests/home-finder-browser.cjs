const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors = [], external = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(base)) external.push(r.url()); });
    const now = new Date().toISOString();
    const item = {id: "new-1", kind: "new", name: "测试新盘", district: "西湖", region: "三墩", address: "测试路",
      url: "https://hz.newhouse.fang.com/loupan/1.htm", unitPrice: null, total: 320, priceBasis: "project",
      areas: [110, 120], layout: "3室", status: "在售", source: "test", checkedAt: now, firstSeen: now, history: []};
    const packet = {schema: 1, updatedAt: now, coverage: "公开测试来源", sources: [{id: "test", name: "房天下", url: item.url, ok: true, checkedAt: now}], items: [item,
      ...Array.from({length: 14}, (_, i) => ({...item, id: "resale-" + i, kind: "resale", name: "测试小区" + i,
        url: "https://m.fang.com/esf/hz/3_" + i + ".html", priceBasis: "listing", total: 330, areas: [110,110], layout: "3室2厅", district: "余杭", region: "闲林"})),
      {...item, id: "small", name: "不符合面积", areas: [90,90]},
      {...item, id: "two", name: "不符合户型", layout: "2室"},
      {...item, id: "sold", name: "售罄新盘", status: "售罄"},
      {...item, id: "escape", name: '<img id="bad" src=x onerror="window.bad=1">', total: 400},
    ]};
    let fail = false;
    await page.route("**/data/home-candidates.json", route => fail ? route.abort() : route.fulfill({json: packet}));
    await page.goto(base + "/homes/#sync=test-retired-fragment");
    await page.evaluate(() => window.homeCandidatesReady);
    assert.equal(new URL(page.url()).hash, "", "retired private link is cleared");
    assert.equal(await page.locator("h1").innerText(), "杭州房源");
    assert.equal(await page.locator(".candidate-card").count(), 12);
    assert.equal(await page.locator("#cloud-connect, #add-home, #saved-homes, [data-save-candidate]").count(), 0);
    assert.equal(await page.evaluate(() => typeof window.HomeNotebook), "undefined");
    assert.match(await page.locator('[data-candidate="new-1"]').innerText(), /楼盘总价参考/);
    await page.locator("#candidate-more").click();
    assert.equal(await page.locator(".candidate-card").count(), 15);
    await page.selectOption("#candidate-kind", "resale");
    assert.equal(await page.locator(".candidate-card").count(), 12);
    await page.selectOption("#candidate-area", "西湖");
    assert.equal(await page.locator(".candidate-card").count(), 0);
    await page.selectOption("#candidate-kind", "new");
    assert.equal(await page.locator(".candidate-card").count(), 1);
    await page.fill("#candidate-budget", "300");
    await page.locator("#candidate-budget").dispatchEvent("change");
    assert.equal(await page.locator(".candidate-card").count(), 0);
    await page.fill("#candidate-budget", "350");
    await page.locator("#candidate-budget").dispatchEvent("change");
    await page.selectOption("#candidate-scope", "all");
    assert.equal(await page.locator(".candidate-card").count(), 3);
    assert.equal(await page.locator("#bad").count(), 0);
    assert.equal(await page.locator('[data-candidate="small"], [data-candidate="two"]').count(), 0);
    await page.selectOption("#candidate-scope", "budget");
    await page.locator(".home-help summary").click();
    packet.items[0].total = 310;
    packet.items[0].history = [{at: now, changes: {total: {from: 320, to: 310}}}];
    await page.locator("#candidate-refresh").click();
    await page.waitForFunction(() => document.querySelector('[data-candidate="new-1"] .home-price').textContent.includes("310"));
    await page.waitForFunction(() => !document.querySelector("#candidate-refresh").disabled);
    assert.match(await page.locator(".candidate-history").innerText(), /1 次来源信息变化/);
    fail = true;
    await page.locator("#candidate-refresh").click();
    await page.waitForFunction(() => document.querySelector("#candidate-message").textContent.includes("上次结果"));
    assert.match(await page.locator('[data-candidate="new-1"] .home-price').innerText(), /310/);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({width, height: 844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no overflow at " + width);
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.locator("#theme-toggle").click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator("#theme-toggle").getAttribute("aria-label"), "切换浅色模式");
    await page.locator("#install-app").click();
    assert(await page.locator("#info-dialog").isVisible());
    await page.locator("#close-dialog").click();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => document.querySelector("#offline-status").dataset.state === "ready");
    await page.evaluate(() => localStorage.removeItem("zrbac-home-candidates-v1"));
    await page.unroute("**/data/home-candidates.json");
    await context.setOffline(true);
    await page.reload({waitUntil: "domcontentloaded"});
    await page.evaluate(() => window.homeCandidatesReady);
    assert.equal(await page.locator(".candidate-card").count(), 12, "Cache Storage keeps listings when localStorage is absent");
    assert.match(await page.locator("#candidate-message").innerText(), /离线/);
    assert.match(await page.locator('[data-candidate="new-1"] .home-price').innerText(), /310/);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "public listing page does not call a server API");
    console.log("PASS: static listings, filters, observed changes, safe rendering, no notebook/server calls, mobile and offline recovery.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
