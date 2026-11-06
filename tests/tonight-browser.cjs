const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8766";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"]});
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() => { Date.now = () => Date.parse("2026-11-05T11:30:00Z"); });
    const page = await context.newPage(), errors = [], external = [], blockedSync = new Set();
    // Keep synchronization unavailable while testing local notes and backups.
    await context.route("**/api/outings/**", route => {
      blockedSync.add(route.request().url());
      return route.abort();
    });
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (!r.url().startsWith(base) && /^https?:/.test(r.url())) external.push(r.url()); });
    const packet = await (await page.request.get(base + "/data/latest.json")).json();
    const event = {id:"event:night-fixture", name:"五常晚间手作", discovery:true, setting:"indoor", region:"hangzhou", area:"余杭区五常",
      day:"2026-11-05", startTime:"20:30", endTime:"21:30", minutes:60, verifiedAt:"2026-11-05T08:00:00Z",
      timeEvidence:"11月5日20:30—21:30，手作体验。", novelty:"今天晚间的双人手作体验。", sources:[{label:"活动原文",url:"https://hznews.hangzhou.com.cn/example"}]};
    packet.eveningWeather={updatedAt:"2026-11-05T11:00:00Z",hours:[19,20,21,22].map(h=>({time:`2026-11-05T${h}:00`,rainProbability:10,rainMm:0,windKmh:10,code:1}))};
    packet.editorial = {...packet.editorial, tonightHome:{revision:"tonight-v2",day:"2026-11-05",updatedAt:"2026-11-05T08:00:00Z",ideas:[{
      id:"event:tonight-drawing",name:'新选题 <img id="injected" src=x>',summary:"今晚画一只带影子的杯子，存进自己的小画册。",
      steps:["从桌上的杯子开始画轮廓。","看着杯子补上影子和把手。","写下日期存好，下次接着画另一件小物。"]}, {
      id:"event:tonight-reading",name:"第一次从一个问题开始",summary:"从已有书里找一节，留下一句自己的理解。",
      steps:["选手边的一本书开始读。","合上书复述一个有趣的观点。","记下书名和页码，下次从这里接着读。"]}]},
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
    assert.match(await page.locator('.outing-profile > summary').textContent(), /偏好设置/);
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
    const chosen = "event:tonight-reading", card = page.locator(`[data-tonight-id="${chosen}"]`);
    await page.locator("[data-tonight-more]").click();
    await card.locator('[data-tonight-feedback="want"]').click();
    assert.equal(await card.locator('[data-tonight-feedback="want"]').getAttribute("aria-pressed"), "true");
    assert.equal(await card.locator('[data-tonight-feedback="visited"]').count(), 0, "projects use real notes, not a played badge");
    await card.locator('.tonight-recording > summary').click();
    await card.locator('[name="note"]').fill('读到第 36 页 <img id="private-injected" src=x>');
    await card.locator('[name="next"]').fill("从第 37 页继续，把上一页的疑问弄清楚");
    await page.evaluate(() => window.dispatchEvent(new Event("outing-feedback-change")));
    assert.equal(await card.locator('[name="note"]').inputValue(), '读到第 36 页 <img id="private-injected" src=x>', "background feedback refresh preserves drafts");
    assert.equal(await card.locator('[name="next"]').evaluate(el => document.activeElement === el), true, "typing focus survives a background render");
    await card.locator('[type="submit"]').click();
    assert.match(await card.locator(".tonight-next").innerText(), /从第 37 页继续/);
    assert.equal(await card.locator(".tonight-starter").count(), 0, "daily starter stops replacing work once a project has progress");
    assert.equal(await page.locator("#private-injected").count(), 0, "saved text is escaped");
    assert.equal(await card.locator('.tonight-recording').getAttribute("open"), null);
    assert.equal(await page.locator('.tonight-list > li:visible').first().getAttribute("data-tonight-id"), chosen);
    assert.equal(await page.evaluate(() => JSON.stringify(OutingProfile.snapshot()).includes("第 36 页")), false, "journal notes do not enter AI feedback");
    // Legacy visited feedback must not hide a continuing project for a week.
    await page.evaluate(id => OutingProfile.mark(NewsTonightCatalog.activities.find(p => p.id === id), "visited"), chosen);
    assert.equal(await card.count(), 1);
    await page.locator("#outing-records-trigger").click();
    await page.locator(".outing-profile > summary").click();
    await page.locator(".record-visited > summary").click();
    assert.match(await page.locator(".record-visited .outing-records").innerText(), /把一本书慢慢读完/);
    await page.locator(`[data-outing-remove="${chosen}"]`).click();
    assert.equal(await card.count(), 1);
    await page.locator(".tonight-journal > summary").click();
    assert.match(await page.locator(".tonight-history").innerText(), /第 36 页/);
    const downloaded = page.waitForEvent("download");
    await page.locator("[data-tonight-export]").click();
    const download = await downloaded;
    const backup = JSON.parse(require("node:fs").readFileSync(await download.path(), "utf8"));
    assert.equal(backup.records.length, 1);
    await page.locator("[data-tonight-remove]").click();
    assert.equal(await page.locator(".tonight-history li").count(), 0);
    await page.locator("[data-tonight-undo]").click();
    assert.equal(await page.locator(".tonight-history li").count(), 1);
    const choosingFile = page.waitForEvent("filechooser");
    await page.locator('[data-tonight-import]').click();
    const chooser = await choosingFile;
    await page.evaluate(() => window.dispatchEvent(new Event("outing-feedback-change")));
    await chooser.setFiles({name:"今晚.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(backup))});
    await page.waitForFunction(() => document.querySelector("#tonight-feedback-status").textContent.includes("重复记录未添加"));
    assert.equal(await page.locator(".tonight-history li").count(), 1, "import merges without duplicates");
    await card.locator('.tonight-recording > summary').click();
    await card.locator('[name="note"]').fill("存储失败时不要丢掉这句");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreTonightStorage = () => {Storage.prototype.setItem = original;};
      Storage.prototype.setItem = function(key,value) {
        if (key === TonightJournal.key) throw new Error("quota");
        return original.call(this,key,value);
      };
    });
    await card.locator('[type="submit"]').click();
    assert.match(await page.locator("#tonight-feedback-status").textContent(), /未能保存/);
    assert.equal(await card.locator('[name="note"]').inputValue(), "存储失败时不要丢掉这句");
    assert.equal(await page.evaluate(() => TonightJournal.snapshot().length), 1);
    await page.evaluate(() => window.restoreTonightStorage());
    await page.locator('[data-tonight-arrival="19"]').click();
    await page.locator('[data-tonight-energy="active"]').click();
    await page.evaluate(packet => {
      packet.eveningWeather.hours.forEach(r=>r.rainProbability=90);
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
    assert.match(await card.locator(".tonight-next").innerText(), /从第 37 页继续/, "continuation survives offline reload");
    await page.locator(".tonight-details > summary").first().click();
    assert.equal(await page.locator(".tonight-details[open] ol > li").count(), 3, "all steps are available offline");
    await page.evaluate(() => {
      Date.now = () => Date.parse("2026-11-06T14:00:00Z");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.locator('[data-tonight-id="event:tonight-drawing"] h3').textContent(), "画一本家里的小物图鉴");
    assert.equal(await page.locator('.tonight-starter').count(), 0, "yesterday's generated theme isn't labelled as today's");
    assert.match(await card.locator(".tonight-next").innerText(), /从第 37 页继续/, "new days do not reset a project");
    assert.equal(await page.locator('.tonight-list > li:visible').first().getAttribute("data-tonight-id"), chosen);
    await card.locator('.tonight-recording > summary').click();
    await card.locator('[name="note"]').fill("第 37 页的问题已经看懂了");
    await card.locator('[name="next"]').fill("下一次从第 42 页继续");
    await card.locator('[type="submit"]').click();
    assert.equal(await page.evaluate(() => TonightJournal.snapshot().length), 2, "append progress while offline");
    await page.reload({waitUntil:"domcontentloaded"});
    await page.locator(".tonight-list > li").first().waitFor();
    assert.match(await card.locator(".tonight-next").innerText(), /第 42 页/);
    assert.equal(await page.evaluate(() => TonightJournal.snapshot().length), 2);
    assert.equal(await page.locator('[data-tonight-id="event:night-fixture"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external.filter(url=>!blockedSync.has(url)), [], "reading and shuffling do not call a model or map API");
    await context.close();
    console.log("Tonight checks passed: ongoing projects, shared notes, backup/restore during sync, storage failures, time/energy/weather, mobile and offline continuation");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
