const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const now = new Date().toISOString();
    const row = (id, name, area, total, layout = "3室2厅") => ({id, name, kind: "resale", district: "西湖", region: "三墩",
      areas: [area,area], layout, total, priceBasis: "listing", source: "test", url: "https://m.fang.com/esf/hz/3_123.html",
      checkedAt: now, firstSeen: now, history: [], status: "平台挂牌"});
    const packet = {schema:1,updatedAt:now,coverage:"测试范围",sources:[{id:"test",name:"测试来源",url:"https://m.fang.com/",ok:true,checkedAt:now}],items:[
      row("q-other","金地自在城求学里",119.2,310),
      row("q","金地自在城求学里",124.84,330),
      row("q-second","金地自在城求学里",124.84,320),
      row("lu","金地自在城鹭影轩",121.1,335),
      row("zi","紫璋台公寓",125.58,320,"4室2厅2卫"),
      row("dong","紫郡东苑",139.9,350),
      row("zi-large","建发金辉紫璋台",139.74,380,"4室2厅"),
      row("comparison","中海西溪华府",116.53,458),
      row("old-small","万科融信西雅图",108,300),
      row("west","协安紫郡",139.9,350),
    ]};
    packet.items.find(c=>c.id==="west").title="紫郡西苑大三房";
    await page.route("**/data/home-candidates.json", r=>r.fulfill({json:packet}));
    await page.goto(base+"/homes/");
    await page.evaluate(()=>window.homeCandidatesReady);
    assert.equal(await page.inputValue("#candidate-community"),"priority");
    assert.equal(await page.inputValue("#candidate-budget"),"400");
    assert.deepEqual(await page.locator(".candidate-card").evaluateAll(cards=>cards.map(c=>c.dataset.candidate)),["q","lu","zi","dong","zi-large","q-second","q-other"]);
    assert.match(await page.locator('[data-candidate="q"] .home-price').innerText(), /330/);
    assert.match(await page.locator('[data-candidate="q"]').innerText(), /卫生间数量未披露/);
    assert.match(await page.locator('[data-candidate="q-other"] .candidate-focus').innerText(), /其他大户型/);
    assert.doesNotMatch(await page.locator("#candidate-list").innerText(), /293|历史成交线索|已核实成交价/);
    await page.locator(".home-watch-reference > summary").click();
    assert.match(await page.locator("#candidate-watch-reference").innerText(), /300–350 万/);
    assert.match(await page.locator("#candidate-watch-reference").innerText(), /手动整理/);
    assert.equal(await page.locator(".watch-community").count(),7);
    await page.selectOption("#candidate-community","comparison");
    assert.equal(await page.inputValue("#candidate-scope"),"all");
    assert.equal(await page.locator(".candidate-card").count(),1);
    assert.match(await page.locator(".candidate-card").innerText(), /458/);
    await page.selectOption("#candidate-community","luyingxuan");
    assert.equal(await page.locator(".candidate-card").count(),1);
    assert.match(await page.locator(".candidate-card h3").innerText(), /鹭影轩/);
    await page.selectOption("#candidate-community","all");
    assert.equal(await page.locator('[data-candidate="old-small"]').count(),0);
    await page.selectOption("#candidate-community","priority");
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"no overflow at "+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator(".home-watch-reference > summary").click();
    await page.screenshot({path:"/tmp/home-watch-mobile.png",fullPage:true});
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>document.querySelector("#offline-status").dataset.state==="ready");
    await page.unroute("**/data/home-candidates.json");
    await context.setOffline(true);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.evaluate(()=>window.homeCandidatesReady);
    assert.equal(await page.locator(".candidate-card").count(),7);
    await page.locator(".home-watch-reference > summary").click();
    assert.match(await page.locator("#candidate-watch-reference").innerText(),/历史成交线索 · 金额待核实/);
    assert.deepEqual(errors,[]);
    console.log("PASS: focused communities, target-area ordering, separate reference prices, comparison listings above budget, old small-flat exclusion, mobile and offline.");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
