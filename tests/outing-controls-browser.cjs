const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"], serviceWorkers:"block"});
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() => { Date.now = () => Date.parse("2026-11-06T11:30:00Z"); });
    const page = await context.newPage(), errors = [], posts = [];
    page.on("pageerror", e => errors.push(e.message));
    let profile = {schema:1, settings:{people:2,transport:"car"}, records:[{id:"place:old",title:"已去的地方",status:"visited"}]};
    const profileRoute = async route => {
      if (route.request().method() === "POST") {
        const op = route.request().postDataJSON();
        assert.equal(op.action,"suggestion");
        profile.settings = {...profile.settings,weekendNote:op.text,weekendNoteUpdatedAt:new Date().toISOString()};
      }
      await route.fulfill({json:profile});
    };
    await context.route("**/api/outings/profile", profileRoute);
    await context.route("**/api/outings/journal*", r => r.fulfill({json:{schema:1,version:0,records:[]}}));
    const packet = await (await page.request.get(base+"/data/latest.json")).json();
    packet.updatedAt = "2026-11-06T08:00:00Z";
    const forecast = {date:"2026-11-07",code:61,low:12,high:18,rainProbability:90,rainMm:8,windKmh:8};
    packet.editorial = {...packet.editorial,trip:{updatedAt:packet.updatedAt,status:"ok",weekendStart:"2026-11-07",weekendEnd:"2026-11-08",
      weather:{updatedAt:packet.updatedAt,regions:{hangzhou:{name:"杭州",days:[forecast,{...forecast,date:"2026-11-08"}]}}},
      picks:[],alternatives:[{id:"place:craft",name:"周末陶艺",type:"rainy",setting:"indoor",region:"hangzhou",day:"2026-11-07",
        reason:"周六有雨，可以一起在室内做一只杯子。",summary:"两个人亲手做一只杯子。",sources:[{url:"https://example.com/craft",label:"来源"}]}]}};
    const fresh = structuredClone(packet);
    fresh.updatedAt = fresh.editorial.trip.updatedAt = "2026-11-06T11:30:00Z";
    fresh.editorial.trip.alternatives[0].name = "周末木工体验";
    let mode = "busy", published = false;
    await context.route("**/data/latest.json*", r => r.fulfill({json:published ? fresh : packet}));
    await context.route("**/api/news-refresh**", async route => {
      if (mode === "unavailable") return route.abort();
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        assert.deepEqual(body,{scope:"outings"});
        posts.push(body);
        assert.equal(profile.settings.weekendNote,"想试木工，别再推荐书店", "latest draft reaches shared storage before dispatch");
        return route.fulfill({json:{status:mode === "success" || mode === "failed" ? "running" : mode,baselineAt:packet.updatedAt,retryAfter:600}});
      }
      if (mode === "success") {
        published = true;
        fresh.editorial.trip.suggestionAppliedAt = profile.settings.weekendNoteUpdatedAt;
      }
      return route.fulfill({json:{status:mode === "failed" ? "failed" : "ready"}});
    });
    await page.goto(base+"/#local");
    await page.evaluate(() => window.newsInitialLoad);
    await page.waitForFunction(() => OutingProfile.status().includes("已自动同步"));
    assert(await page.locator(".update-bar").isHidden());
    assert(await page.locator("#search").isHidden());
    assert.equal(await page.locator("#outing-library").getAttribute("open"),null);
    assert.equal(await page.locator(".our-outings").getAttribute("open"),null);
    assert.equal(await page.locator("#outing-adjust").getAttribute("open"),null);
    assert(await page.locator(".trip-want").isVisible());
    assert(await page.locator('[data-outing-feedback="visited"]').isHidden());
    assert(await page.locator(".trip-list h3").evaluate(el => el.getBoundingClientRect().top < 420));
    await page.keyboard.press("/");
    assert(await page.locator("#search").isVisible());
    await page.locator("#outing-library > summary").click();
    await page.locator("#outing-adjust > summary").click();
    const input = page.locator("#outing-suggestion");
    await input.fill("未保存的想法 <img id=bad-suggestion>");
    await page.evaluate(() => window.dispatchEvent(new Event("outing-feedback-change")));
    assert.equal(await input.inputValue(),"未保存的想法 <img id=bad-suggestion>");
    assert.equal(await page.locator("#bad-suggestion").count(),0);
    await context.setOffline(true);
    await input.fill("这周想做陶艺");
    await page.locator('#outing-suggestion-form [type="submit"]').click();
    assert.match(await page.locator("#outing-suggestion-status").innerText(),/本机.*联网/);
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),1);
    await context.setOffline(false);
    await page.evaluate(() => OutingProfile.sync(true));
    await page.waitForFunction(() => !OutingProfile.snapshot().pending.length);
    assert.equal(profile.settings.weekendNote,"这周想做陶艺");
    assert.equal(profile.settings.people,2);
    assert.equal(profile.records.length,1);
    const secondContext = await browser.newContext({serviceWorkers:"block"});
    await secondContext.route("**/api/outings/profile",profileRoute);
    await secondContext.route("**/api/outings/journal*", r => r.fulfill({json:{schema:1,version:0,records:[]}}));
    await secondContext.route("**/data/latest.json*", r => r.fulfill({json:packet}));
    const second = await secondContext.newPage();
    await second.goto(base+"/#local");
    await second.waitForFunction(() => document.querySelector("#outing-suggestion").value === "这周想做陶艺");
    await secondContext.close();
    await input.fill("想试木工，别再推荐书店");
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(() => document.querySelector("#outing-refresh-notice").textContent.includes("已有更新"));
    assert.equal(posts.length,1);
    mode = "cooldown";
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(() => document.querySelector("#outing-refresh-notice").textContent.includes("10 分钟"));
    mode = "success";
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(() => document.querySelector("#outing-refresh-notice").textContent.includes("已重新检索并筛选"));
    assert.match(await page.locator(".trip-list h3").innerText(),/木工/);
    assert.match(await page.locator("#outing-suggestion-status").innerText(),/已用于本轮/);
    mode = "failed";
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(() => document.querySelector("#outing-refresh-notice").textContent.includes("本次检索或发布未成功"));
    assert.match(await page.locator(".trip-list h3").innerText(),/木工/);
    assert(!(await page.locator("#refresh-outings").isDisabled()));
    for (const width of [320,390,1440]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "overflow at "+width);
    }
    await page.locator(".brand").click();
    assert(await page.locator("#outing-refresh-notice").isHidden());
    assert(await page.locator(".update-bar").isVisible());
    assert(await page.locator("#search").isVisible());
    assert.deepEqual(errors,[]);
    console.log("Outing controls passed: compact layout, drafts, offline/shared suggestions, forced refresh, busy/cooldown/failure, news restoration.");
    await context.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
