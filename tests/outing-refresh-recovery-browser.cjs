const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  const errors = [];
  let context, page, packet, fresh, published = false, mode = "running", posts = 0, reads = 0, loseAck = false, releaseAck;
  let profile = {schema:1,settings:{people:2,transport:"car"},records:[]};
  async function start(storageState) {
    context = await browser.newContext({...devices["iPhone 13"],serviceWorkers:"block",...(storageState ? {storageState} : {})});
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(()=>{Date.now = ()=>Date.parse("2026-11-08T01:30:00Z");});
    await context.route("**/api/outings/profile", async route => {
      if (route.request().method() === "POST") {
        const op = route.request().postDataJSON();
        assert.equal(op.action,"suggestion");
        profile.settings = {...profile.settings,weekendNote:op.text,weekendNoteUpdatedAt:new Date().toISOString()};
      }
      await route.fulfill({json:profile});
    });
    await context.route("**/api/outings/journal*",route=>route.fulfill({json:{schema:1,version:0,records:[]}}));
    await context.route("**/api/news-refresh**", async route => {
      if (route.request().method() === "POST") {
        assert.deepEqual(route.request().postDataJSON(),{scope:"outings"});
        posts++;
        if (mode === "limited") return route.fulfill({status:429,json:{status:"busy"}});
        if (loseAck) await new Promise(resolve=>{releaseAck=resolve;});
        return route.fulfill({json:{status:"running",baselineAt:(published ? fresh : packet).updatedAt}}).catch(()=>{});
      }
      reads++;
      if (mode === "unavailable") return route.abort();
      if (mode === "ready") {
        published = true;
        fresh.editorial.trip.suggestionAppliedAt = profile.settings.weekendNoteUpdatedAt;
      }
      await route.fulfill({json:{status:mode}});
    });
    page = await context.newPage();
    page.on("pageerror",error=>errors.push(error.message));
    if (!packet) {
      packet = await (await page.request.get(base+"/data/latest.json")).json();
      packet.updatedAt = "2026-11-08T00:00:00Z";
      packet.editorial = {...packet.editorial,trip:{status:"ok",updatedAt:packet.updatedAt,weekendStart:"2026-11-07",weekendEnd:"2026-11-08",
        weather:{updatedAt:packet.updatedAt,regions:{hangzhou:{name:"杭州",days:[{date:"2026-11-08",code:61,low:12,high:18,rainProbability:90,rainMm:8,windKmh:8}]}}},picks:[],alternatives:[
        {id:"place:craft",name:"原来的周末体验",type:"rainy",setting:"indoor",region:"hangzhou",day:"2026-11-08",summary:"一起做一件作品。",reason:"雨天可以在室内体验。",sources:[{url:"https://example.com/craft",label:"场地来源"}]}
      ]}};
      fresh = structuredClone(packet);
      fresh.updatedAt = fresh.editorial.trip.updatedAt = "2026-11-08T01:30:10Z";
      fresh.editorial.trip.alternatives[0].name = "这次找到的木工体验";
    }
    await context.route("**/data/latest.json*",route=>route.fulfill({json:published ? fresh : packet}));
    await page.goto(base+"/#local");
    await page.evaluate(()=>window.newsInitialLoad);
    await page.waitForFunction(()=>OutingProfile.status().includes("已自动同步"));
  }
  try {
    await start();
    await page.locator("#outing-adjust > summary").click();
    // A fetch or JSON body that ignores abort must not keep Refresh awaiting sync.
    for (const stall of ["connection","body","background"]) {
      await page.evaluate(stall=>{
        window.weekendFetch = window.fetch; window.weekendTimer = window.setTimeout; window.weekendClock = Date.now;
        window.weekendReleases = [];
        window.setTimeout = (fn,ms,...args)=>weekendTimer(fn,stall !== "background" && ms > 10000 && ms <= 15000 ? 80 : ms,...args);
        window.fetch = (url, options) => {
          if (!String(url).endsWith("/api/outings/profile") || options?.method !== "POST") return weekendFetch(url,options);
          if (stall === "body") return Promise.resolve({ok:true,status:200,json:()=>new Promise(resolve=>weekendReleases.push(resolve))});
          return new Promise(resolve=>weekendReleases.push(data=>resolve({ok:true,status:200,json:async()=>data})));
        };
      },stall);
      const note = "要用上这次想法 " + stall;
      await page.locator("#outing-suggestion").fill(note);
      await page.locator("#refresh-outings").click();
      if (stall === "background") {
        await page.evaluate(()=>{Date.now=()=>weekendClock()+31000;document.dispatchEvent(new Event("visibilitychange"));});
      }
      await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("同步连接超时"),{},{timeout:5000});
      assert(!(await page.locator("#refresh-outings").isDisabled()));
      assert.equal(await page.locator("#outing-suggestion").inputValue(),note);
      assert.equal(await page.evaluate(()=>OutingProfile.snapshot().pending.length),1);
      assert.equal(posts,0,"unsynced feedback never launches a search");
      await page.evaluate(stale=>{
        Date.now=weekendClock;weekendReleases.forEach(release=>release(stale));
        window.fetch=weekendFetch;window.setTimeout=weekendTimer;
      },profile);
      await page.waitForTimeout(30);
      assert.equal(await page.evaluate(()=>OutingProfile.snapshot().pending.length),1,"a late stale reply cannot acknowledge or replace the saved edit");
      await page.evaluate(()=>OutingProfile.sync(true));
      assert.equal(profile.settings.weekendNote,note);
    }
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(()=>document.querySelector("#refresh-outings").textContent.includes("检索中"));
    assert.equal(posts,1);
    await page.evaluate(()=>{location.hash="#brief";});
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").hidden);
    await page.evaluate(()=>{location.hash="#local";});
    await page.locator("#outing-refresh-notice").waitFor();
    assert.match(await page.locator("#outing-refresh-notice").innerText(),/已等待/);
    // Close the original context. Only localStorage is carried into the new one.
    const saved = await context.storageState();
    await context.close();
    mode = "unavailable";
    await start(saved);
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("暂时无法读取"));
    await page.locator("#outing-adjust > summary").click();
    assert.equal(await page.locator("#refresh-outings").innerText(),"查看进度");
    assert(!(await page.locator("#refresh-outings").isDisabled()));
    assert.equal(posts,1,"reopening a pending search must never POST again");
    const paused = await context.storageState(), previousReads = reads;
    await context.close();
    // Publication can finish even when the status API is temporarily unreachable.
    published = true;
    fresh.editorial.trip.suggestionAppliedAt = profile.settings.weekendNoteUpdatedAt;
    await start(paused);
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("已重新检索并筛选"));
    assert.equal(reads,previousReads,"a fresh published recommendation settles the pending task without waiting for status");
    assert.equal(posts,1);
    assert.match(await page.locator(".trip-list h3").innerText(),/这次找到/);
    assert.match(await page.locator("#outing-suggestion-status").textContent(),/已用于本轮/);
    // An acknowledgement may be lost after the server accepted the POST.
    await page.locator("#outing-adjust > summary").click();
    await page.evaluate(()=>{const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===25000?100:ms,...args);});
    loseAck = true; mode = "running";
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("暂时无法读取"));
    assert.equal(posts,2);
    const unacknowledged = await context.storageState();
    await context.close();releaseAck();
    // Move the publication forward only after the waiting browser has closed.
    fresh.updatedAt = fresh.editorial.trip.updatedAt = "2026-11-08T01:31:00Z";
    fresh.editorial.trip.alternatives[0].name = "第二次核对后的体验";
    mode = "ready";loseAck = false;
    await start(unacknowledged);
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("已重新检索并筛选"));
    assert.equal(posts,2,"lost acknowledgement recovery never duplicates the search");
    assert.match(await page.locator(".trip-list h3").innerText(),/第二次核对/);
    await page.reload();
    await page.locator("#outing-refresh-notice").waitFor();
    assert.match(await page.locator("#outing-refresh-notice").innerText(),/已重新检索并筛选/);
    assert.equal(posts,2);
    mode = "limited";
    await page.locator("#outing-adjust > summary").click();
    await page.locator("#refresh-outings").click();
    await page.waitForFunction(()=>document.querySelector("#outing-refresh-notice").textContent.includes("稍等一分钟"));
    assert.equal(await page.locator("#refresh-outings").innerText(),"重新找一批","rate limiting does not leave a nonexistent job pending");
    await page.reload();
    await page.locator("#outing-refresh-notice").waitFor();
    assert.equal(posts,3);
    assert.deepEqual(errors,[]);
    console.log("Weekend refresh recovery: stalled sync/body, background deadline, retained feedback, re-entry, publication, status outage and lost acknowledgement passed.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
