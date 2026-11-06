const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"],serviceWorkers:"block"});
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors=[], requests=[];
    page.on("pageerror", e=>errors.push(e.message));
    await context.route("**/api/outings/profile",r=>r.fulfill({json:{schema:1,settings:{},records:[]}}));
    await context.route("**/api/outings/journal*",r=>r.fulfill({json:{schema:1,version:0,records:[]}}));
    let mode="ok", release;
    const answer={schema:1,status:"ok",generatedAt:new Date().toISOString(),intro:"先用半小时做一个小练习。",weather:null,
      ideas:["阅读","画画","整理照片"].map((title,i)=>({id:"event:tonight-"+i,title,reason:"做完留下自己的记录。",minutes:25,
        steps:["拿出已有材料，设一个十分钟计时。","留下一句话，下次接着做。"],outcome:"一条自己的理解",setting:"home",area:"",sources:[]}))};
    await context.route("**/api/outings/now",async route=>{
      requests.push(route.request().postDataJSON());
      if(mode==="pending") await new Promise(r=>{release=r;});
      if(mode==="busy") return route.fulfill({status:429,json:{status:"busy"}});
      if(mode==="error") return route.fulfill({status:503,json:{status:"unavailable"}});
      await route.fulfill({json:answer}).catch(()=>{});
    });
    await page.goto(base+"/#tonight");
    await page.waitForSelector("#tonight-plans h3");
    assert.equal(requests.length,0,"opening the page never spends an API call");
    assert.equal(await page.locator("#outing-now").evaluate(e=>e.open),false);
    await page.locator("#outing-now > summary").click();
    assert.equal(requests.length,0,"opening the entrance only shows the controls");
    await page.locator("#outing-now-minutes").selectOption("30");
    await page.locator("#outing-now-setting").selectOption("home");
    await page.locator("#outing-now-note").fill("今天有点累，想练画画");
    await page.locator("#outing-now-submit").click();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.deepEqual(requests[0],{minutes:30,setting:"home",note:"今天有点累，想练画画",previous:[]});
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.match(await page.locator("#outing-now-result").innerText(),/先做/);
    assert.match(await page.locator("#outing-now-result").innerText(),/未取得可用的实时天气/);
    await page.evaluate(()=>{location.hash="#local";});
    await page.waitForFunction(()=>!document.querySelector("#outing-recommendations").hidden);
    assert.equal(await page.locator("#outing-now-note").inputValue(),"今天有点累，想练画画");
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.equal(requests.length,1);
    mode="busy";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("半分钟"));
    assert.deepEqual(requests[1].previous,["阅读","画画","整理照片"]);
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3,"a failed request preserves the previous answer");
    mode="pending";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-submit").disabled);
    await page.locator("#outing-now-form").evaluate(form=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    await page.waitForTimeout(100);
    assert.equal(requests.length,3,"repeated taps never duplicate a running call");
    await page.locator("#outing-now-cancel").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已取消"));
    release();
    await context.setOffline(true);
    await page.locator("#outing-now-submit").click();
    assert.match(await page.locator("#outing-now-status").innerText(),/需要联网/);
    assert.equal(requests.length,3);
    await context.setOffline(false);
    await page.reload();
    await page.locator("#outing-now > summary").click();
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3,"refresh retains this session's previous advice");
    assert.equal(requests.length,3);
    // Source links and all generated strings are rendered as untrusted content.
    mode="ok";answer.ideas[0]={...answer.ideas[0],title:'<img src=x onerror="window.bad=true">',setting:"indoor",sources:[
      {url:"javascript:alert(1)",label:"bad"},{url:"https://example.com/craft",label:"来源"}]};
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector(".outing-now-ideas h3").textContent.includes("<img"));
    assert.equal(await page.locator("#outing-now-result img").count(),0);
    assert.equal(await page.locator('#outing-now-result a[href^="javascript:"]').count(),0);
    for(const width of [320,390,1440]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"no horizontal overflow at "+width);
    }
    await page.evaluate(()=>{location.hash="#brief";});
    await page.waitForFunction(()=>document.querySelector("#outing-now").hidden);
    await page.evaluate(()=>{location.hash="#tonight";});
    await page.waitForFunction(()=>!document.querySelector("#outing-now").hidden);
    assert.equal(requests.length,4);
    assert.deepEqual(errors,[]);
    console.log("Immediate outing advice: explicit calls, context, retries, cancellation, offline/session recovery, safe output and mobile layout passed.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
