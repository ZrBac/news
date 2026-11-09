const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({args:["--no-sandbox"]});
  try {
    const context = await browser.newContext({...devices["iPhone 13"],serviceWorkers:"block"});
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors=[], requests=[], jobs=new Map();
    page.on("pageerror", e=>errors.push(e.message));
    await context.route("**/api/outings/profile",r=>r.fulfill({json:{schema:1,settings:{},records:[]}}));
    await context.route("**/api/outings/journal*",r=>r.fulfill({json:{schema:1,version:0,records:[]}}));
    let mode="ok", reads=0, latest;
    const answer={schema:1,status:"ok",contextVersion:3,generatedAt:new Date().toISOString(),intro:"先用半小时做一个小练习。",weather:null,
      ideas:["阅读","画画","整理照片"].map((title,i)=>({id:"event:tonight-"+i,title,reason:"做完留下自己的记录。",minutes:25,
        steps:["拿出已有材料，设一个十分钟计时。","留下一句话，下次接着做。"],outcome:"一条自己的理解",setting:"home",area:"",sources:[]}))};
    const completed=()=>({schema:1,status:"ok",result:structuredClone(answer)});
    await context.route("**/api/outings/now/jobs/*",async route=>{
      const id=route.request().url().split("/").pop(); latest=id;
      if(route.request().method()==="POST") {
        requests.push({id,input:route.request().postDataJSON()});
        if(mode==="busy")return route.fulfill({status:429,json:{status:"busy"}});
        if(!jobs.has(id))jobs.set(id,mode==="pending"?{schema:1,status:"running",stage:"generating",deadline:Date.now()+120000}:
          mode==="timeout"?{schema:1,status:"timeout"}:completed());
      } else reads++;
      await route.fulfill({status:jobs.has(id)?200:404,json:jobs.get(id)||{status:"not_found"}}).catch(()=>{});
    });
    await page.goto(base+"/#tonight");
    await page.waitForSelector("#tonight-plans h3");
    assert.equal(requests.length,0);assert.equal(reads,0,"an unused entrance makes no advice calls");
    await page.locator("#outing-now > summary").click();
    await page.locator("#outing-now-minutes").selectOption("30");
    await page.locator("#outing-now-setting").selectOption("home");
    await page.locator("#outing-now-note").fill("今天有点累，想练画画");
    await page.locator("#outing-now-submit").click();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.deepEqual(requests[0].input,{minutes:30,setting:"home",note:"今天有点累，想练画画",previous:[]});
    assert.match(requests[0].id,/^[a-f0-9]{32}$/);
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.match(await page.locator("#outing-now-result").innerText(),/北京时间/);
    await page.locator('#outing-now-setting').selectOption('outside');
    assert.match(await page.locator('#outing-now-status').innerText(),/条件已更改，下方仍是上次建议/);
    assert.equal(requests.length,1,'editing conditions never spends another request');
    await page.locator('#outing-now-setting').selectOption('home');
    mode="busy";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("半分钟"));
    assert.deepEqual(requests[1].input.previous,["阅读","画画","整理照片"]);
    mode="pending";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已提交"));
    await page.locator("#outing-now-form").evaluate(form=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(requests.length,3,"repeated taps do not duplicate a job");
    await page.locator("#outing-now-cancel").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已暂停等待"));
    await context.setOffline(true);
    await page.locator("#outing-now-submit").click();
    assert.match(await page.locator("#outing-now-status").innerText(),/需要联网/);
    jobs.set(latest,completed());
    await context.setOffline(false);
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("整理好了"));
    assert.equal(requests.length,3,"reconnect reads the existing result without generation");
    assert(reads>0);
    await page.reload();
    await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"今天有点累，想练画画");
    assert.equal(requests.length,3);
    mode="timeout";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("限定时间"));
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3,"a terminal generation failure preserves the last result");
    mode="ok";answer.ideas[0]={...answer.ideas[0],title:'<img src=x onerror="window.bad=true">',setting:"indoor",sources:[
      {url:"javascript:alert(1)",label:"bad"},{url:"https://example.com/craft",label:"来源"}]};
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector(".outing-now-ideas h3").textContent.includes("<img"));
    assert.equal(await page.locator("#outing-now-result img").count(),0);
    assert.equal(await page.locator('#outing-now-result a[href^="javascript:"]').count(),0);
    for(const width of [320,390,1440]) {
      await page.setViewportSize({width,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    // A lost POST acknowledgement (even a response body ignoring abort) must
    // recover through GET, not submit a second paid request or accept late data.
    await page.evaluate(answer=>{
      window.originalNowFetch=window.fetch;window.originalNowTimeout=window.setTimeout;
      window.nowPosts=0;window.nowReads=0;window.nowStall="connection";window.testNowAnswer=answer;
      window.setTimeout=(fn,ms,...args)=>originalNowTimeout(fn,ms===12000?60:ms===2500?20:ms,...args);
      window.fetch=(url,options)=>{
        if(!String(url).includes("/api/outings/now/jobs/"))return originalNowFetch(url,options);
        if(options.method==="GET") {window.nowReads++;return Promise.resolve({ok:true,status:200,json:async()=>({status:"ok",result:window.testNowAnswer})});}
        window.nowPosts++;
        if(window.nowStall==="body")return Promise.resolve({ok:true,status:202,json:()=>new Promise(resolve=>{window.releaseNow=resolve;})});
        return new Promise(resolve=>{window.releaseNow=data=>resolve({ok:true,status:200,json:async()=>data});});
      };
    },answer);
    for(const stall of ["connection","body"]) {
      await page.evaluate(stall=>{window.nowStall=stall;},stall);
      await page.locator("#outing-now-submit").click();
      await page.waitForFunction(()=>!document.querySelector("#outing-now-submit").disabled);
      assert.match(await page.locator("#outing-now-status").innerText(),/整理好了/);
      await page.evaluate(()=>window.releaseNow({status:"ok",result:{...window.testNowAnswer,intro:"迟到回复不可覆盖"}}));
      await page.waitForTimeout(40);
      assert.doesNotMatch(await page.locator(".outing-now-intro").innerText(),/迟到/);
    }
    assert.deepEqual(await page.evaluate(()=>[window.nowPosts,window.nowReads]),[2,2]);
    // If no acknowledgement or status can be obtained, waiting remains bounded
    // and the same job ID is kept for a later read-only recovery.
    await page.evaluate(()=>{
      window.fetch=(url,options)=>String(url).includes("/api/outings/now/jobs/")?new Promise(()=>{}):originalNowFetch(url,options);
    });
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("暂时连不上"));
    assert.equal(await page.locator("#outing-now-submit").isDisabled(),false);
    assert.equal(await page.locator("#outing-now-submit").innerText(),"查看结果");
    await page.locator("#outing-now-submit").click();
    await page.locator("#outing-now-cancel").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已暂停等待"));
    assert.equal(await page.locator("#outing-now-submit").isDisabled(),false,"pause does not depend on fetch honoring abort");
    assert.deepEqual(errors,[]);
    console.log("Immediate advice: durable jobs, read-only reconnect, lost acknowledgements/bodies, bounded connections, pause, safe rendering and mobile layout passed.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
