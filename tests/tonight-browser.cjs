const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8766";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"]});
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() => { Date.now = () => Date.parse("2026-11-05T11:30:00Z"); });
    const page = await context.newPage(), errors = [], external = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(base) && /^https?:/.test(r.url())) external.push(r.url()); });
    const packet = await (await page.request.get(base + "/data/latest.json")).json();
    const event = {id:"event:night-fixture", name:"五常晚间手作", discovery:true, setting:"indoor", region:"hangzhou", area:"余杭区五常",
      day:"2026-11-05", startTime:"20:30", endTime:"21:30", minutes:60, verifiedAt:"2026-11-05T08:00:00Z",
      timeEvidence:"11月5日20:30—21:30，手作体验。", novelty:"今天晚间的双人手作体验。", sources:[{label:"活动原文",url:"https://hznews.hangzhou.com.cn/example"}]};
    packet.editorial = {...packet.editorial, tonightHome:{day:"2026-11-05",updatedAt:"2026-11-05T08:00:00Z",ideas:[{
      id:"event:tonight-drawing",name:'新主题 <img id="injected" src=x>',summary:"今晚用三笔接龙画一家水下小店。",
      steps:["画一个门框开始接龙。","轮流添笔，画出店里的东西。","给它起名字，拍照收尾。"]}]},
      trip:{weather:{updatedAt:"2026-11-05T08:00:00Z",regions:{hangzhou:{days:[{
        date:"2026-11-05",low:12,high:20,rainProbability:10,rainMm:0,windKmh:10,code:1}]}}}},
      tonight:{day:"2026-11-05",researchedAt:"2026-11-05T08:00:00Z",events:[event,
        {...event,id:"event:already-started",startTime:"19:00",name:"已开始的活动"},
        {...event,id:"event:stale",verifiedAt:"2026-11-01T00:00:00Z",name:"过期来源"},
        {...event,id:"event:bad-link",sources:[{url:"javascript:alert(1)"}],name:"无有效来源"}]}};
    await page.route("**/data/latest.json*", route => route.fulfill({json:packet}));
    await page.goto(base + "/#tonight");
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator('[data-outing-mode="tonight"]').getAttribute("aria-current"), "page");
    assert(await page.locator("#news-listing").isHidden());
    assert(await page.locator("#outing-browse").isHidden());
    assert.equal(await page.locator(".tonight-list > li:visible").count(), 3);
    assert(await page.locator('.tonight-list h3').first().evaluate(el => el.getBoundingClientRect().top < 630));
    assert.equal(await page.locator('[data-tonight-id="event:night-fixture"]').count(), 1);
    assert.equal(await page.locator('[data-tonight-id="event:already-started"],[data-tonight-id="event:stale"],[data-tonight-id="event:bad-link"]').count(), 0);
    assert.equal(await page.locator("#injected").count(), 0);
    await page.locator("[data-tonight-more]").click();
    assert(await page.locator(".tonight-list > li:visible").count() > 8);
    await page.locator('[data-tonight-id="event:night-fixture"] summary').click();
    assert.match(await page.locator('[data-tonight-id="event:night-fixture"]').innerText(), /20:30—21:30/);
    assert.match(await page.locator('[data-tonight-id="event:night-fixture"]').innerText(), /来源未公布费用/);
    await page.locator('[data-tonight-arrival="21"]').click();
    assert.equal(await page.locator('[data-tonight-id="event:night-fixture"]').count(), 0);
    await page.locator('[data-tonight-energy="easy"]').click();
    assert(await page.locator(".tonight-list > li").count() >= 6);
    const labels = await page.locator(".tonight-list > li > .trip-kind").allTextContents();
    assert(labels.every(label => label.startsWith("在家") && Number(label.match(/(\d+) 分钟/)[1]) <= 40));
    const prior = await page.locator(".tonight-list > li:visible").evaluateAll(nodes=>nodes.map(n=>n.dataset.tonightId));
    await page.locator("[data-tonight-shuffle]").click();
    const shuffled = await page.locator(".tonight-list > li:visible").evaluateAll(nodes=>nodes.map(n=>n.dataset.tonightId));
    assert.notDeepEqual(shuffled, prior, "change set changes the visible choices");
    const chosen = shuffled[0], card = page.locator(`[data-tonight-id="${chosen}"]`);
    await card.locator('[data-tonight-feedback="want"]').click();
    assert.equal(await card.locator('[data-tonight-feedback="want"]').getAttribute("aria-pressed"), "true");
    await card.locator('[data-tonight-feedback="visited"]').click();
    assert.equal(await card.count(), 0);
    await page.locator(".outing-profile > summary").click();
    assert.match(await page.locator(".outing-records").innerText(), /玩过/);
    await page.locator(`[data-outing-remove="${chosen}"]`).click();
    assert.equal(await card.count(), 1);
    await page.locator('[data-tonight-arrival="19"]').click();
    await page.locator('[data-tonight-energy="active"]').click();
    await page.evaluate(packet => {
      packet.editorial.trip.weather.regions.hangzhou.days[0].rainProbability = 90;
      NewsTonight.render(packet, {view:"local", outingMode:"tonight"}, s=>s);
    }, packet);
    assert.equal(await page.locator('[data-tonight-id="event:tonight-nearby-walk"],[data-tonight-id="event:tonight-nearby-cycle"]').count(), 0, "rain excludes outdoor options");
    assert.match(await page.locator(".tonight-context").innerText(), /有雨/);
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), "no overflow at " + width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-outing-mode="weekend"]').click();
    // Fragment navigation dispatches hashchange after the click handler. Wait
    // for the routed panel, rather than sampling the old view on faster runners.
    await page.locator("#tonight-plans").waitFor({state:"hidden"});
    assert(await page.locator("#tonight-plans").isHidden());
    assert(await page.locator("#outing-catalog-heading").isVisible());
    await page.locator(".brand").click();
    await page.locator(".filter-row #source-filter").waitFor({state:"visible"});
    assert(await page.locator("#outing-nav").isHidden());
    assert(await page.locator(".filter-row #source-filter").isVisible());
    await page.goto(base + "/#tonight");
    await page.evaluate(() => window.newsInitialLoad);
    await page.locator('[data-tonight-arrival="21"]').click();
    await page.locator('[data-tonight-energy="easy"]').click();
    await page.locator('[data-tonight-more]').click();
    await page.locator('[data-tonight-id="event:tonight-short-film"] [data-tonight-feedback="dismiss"]').click();
    const hiddenId = await page.evaluate(()=>OutingProfile.snapshot().records.find(r=>r.status==="dismiss").id);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await page.unroute("**/data/latest.json*");
    await context.setOffline(true);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.locator(".tonight-list > li").first().waitFor();
    assert.equal(await page.locator('[data-tonight-arrival="21"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(`[data-tonight-id="${hiddenId}"]`).count(), 0);
    await page.locator(".tonight-details > summary").first().click();
    assert.equal(await page.locator(".tonight-details[open] ol > li").count(), 3, "all steps are available offline");
    await page.evaluate(() => {
      Date.now = () => Date.parse("2026-11-06T14:00:00Z");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.locator('[data-tonight-id="event:tonight-drawing"] h3').textContent(), "轮流添三笔，画出一家奇怪的小店", "yesterday's generated theme isn't labelled as today's");
    assert.equal(await page.locator('[data-tonight-id="event:night-fixture"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "reading and shuffling do not call a model or map API");
    await context.close();
    console.log("Tonight checks passed: time and energy, evidence, weather, feedback, navigation, mobile and offline");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
