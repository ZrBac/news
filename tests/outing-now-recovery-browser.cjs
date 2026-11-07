const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "outing-now-recovery-"));
  let context, mode = "ok", calls = 0, release;
  const errors = [];
  const answer = {schema:1, generatedAt:new Date().toISOString(), intro:"今晚练一次速写，留下作品。", weather:null,
    ideas:["速写","阅读","整理照片"].map((title,i)=>({id:"event:practice-"+i,title,reason:"下次可以接着做。",minutes:25,
      steps:["拿出材料。","写下今天的收获。"],outcome:"一条记录",setting:"home",sources:[]}))};
  async function start() {
    context = await chromium.launchPersistentContext(directory, {...devices["iPhone 13"],serviceWorkers:"block",args:["--no-sandbox"]});
    await context.addInitScript(require("./legacy-safari.cjs"));
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    await context.route("**/api/outings/profile", route => route.fulfill({json:{schema:1,settings:{},records:[]}}));
    await context.route("**/api/outings/journal*", route => route.fulfill({json:{schema:1,version:0,records:[]}}));
    await context.route("**/api/outings/now", async route => {
      calls++;
      if (mode === "pending") await new Promise(resolve => {release = resolve;});
      await route.fulfill(mode === "error" ? {status:503,json:{status:"unavailable"}} : {json:answer}).catch(()=>{});
    });
    const page = context.pages()[0];
    await page.goto(base+"/#tonight");
    await page.locator("#outing-now > summary").waitFor();
    return page;
  }
  try {
    let page = await start();
    await page.locator("#outing-now > summary").click();
    await page.locator("#outing-now-minutes").selectOption("30");
    await page.locator("#outing-now-setting").selectOption("home");
    await page.locator("#outing-now-note").fill("今晚想画画，明天继续");
    mode = "pending";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-submit").disabled);
    // Returning within the page keeps the same request alive, even when folded.
    await page.locator("#outing-now > summary").click();
    await page.evaluate(()=>{location.hash="#brief";});
    await page.waitForFunction(()=>document.querySelector("#outing-now").hidden);
    await page.evaluate(()=>{location.hash="#tonight";});
    await page.locator("#outing-now > summary").waitFor();
    assert.match(await page.locator("#outing-now > summary").innerText(),/正在生成/);
    // Closing a browser can drop the queued details toggle event. Saving the
    // open state must not depend on that later event reaching its handler.
    await page.locator("#outing-now").evaluate(panel=>panel.addEventListener("toggle",event=>event.stopImmediatePropagation(),{capture:true,once:true}));
    await page.locator("#outing-now > summary").click();
    assert(await page.locator("#outing-now-submit").isDisabled());
    assert.equal(calls,1);
    // A true browser/PWA restart must not depend on the old tab's sessionStorage.
    await context.close(); release();
    page = await start();
    await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"今晚想画画，明天继续");
    assert.equal(await page.locator("#outing-now-minutes").inputValue(),"30");
    assert.equal(await page.locator("#outing-now-setting").inputValue(),"home");
    assert.match(await page.locator("#outing-now-status").innerText(),/上次.*还没收到建议.*输入已恢复/);
    assert.match(await page.locator("#outing-now > summary").innerText(),/上次未完成/);
    assert.equal(await page.locator("#outing-now-submit").innerText(),"重新获取");
    assert(!(await page.locator("#outing-now-submit").isDisabled()));
    assert.equal(calls,1,"a restart never silently resubmits the interrupted request");
    mode = "ok";
    await page.locator("#outing-now-submit").click();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.equal(calls,2);
    await context.close();
    page = await start();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.equal(await page.locator("#outing-now-note").inputValue(),"今晚想画画，明天继续");
    assert.equal(calls,2,"a completed answer survives closing the entire browser");
    // Failed requests must not be reported as a fresh start or discard old results.
    mode = "error";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("没能取得"));
    await page.locator("#outing-now > summary").click();
    await page.reload();
    await page.locator("#outing-now > summary").waitFor();
    assert(!(await page.locator("#outing-now").evaluate(e=>e.open)),"the user's collapsed entrance stays compact");
    assert.match(await page.locator("#outing-now > summary").innerText(),/上次未完成/);
    await page.locator("#outing-now > summary").click();
    assert.match(await page.locator("#outing-now-status").innerText(),/没能取得.*上次结果/);
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.equal(calls,3);
    // An open tab can deliver its eventual answer to a second entrance without a retry.
    mode = "pending";
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-submit").disabled);
    const second = await context.newPage();
    await second.goto(base+"/#local");
    await second.locator("#outing-now-note").waitFor();
    assert.match(await second.locator("#outing-now-status").innerText(),/还没收到建议/);
    await second.locator("#outing-now-note").fill("另一页的新想法先留着");
    answer.intro = "原页面完成后，返回入口也能看到这次建议。";
    release();
    await second.waitForFunction(()=>document.querySelector(".outing-now-intro").textContent.includes("原页面完成"));
    assert.equal(await second.locator("#outing-now-note").inputValue(),"另一页的新想法先留着");
    await second.reload();
    await second.locator("#outing-now-note").waitFor();
    assert.equal(await second.locator("#outing-now-note").inputValue(),"另一页的新想法先留着","receiving a result also preserves this tab's edited draft on reload");
    assert.equal(calls,4);
    await second.close();
    // Older results remain readable but are explicitly dated; they are never presented as live.
    await context.addInitScript(()=>{const now = Date.now; Date.now = ()=>now()+2*86400000;});
    await page.reload();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.match(await page.locator("#outing-now-result").innerText(),/上次建议，时间和天气可能已变化/);
    assert.equal(calls,4);
    // Migrate existing session-only input and advice when the new version loads.
    await page.evaluate(answer=>{
      localStorage.removeItem("news-outing-now-state-v2");
      sessionStorage.removeItem("news-outing-now-state-v2");
      sessionStorage.setItem("news-outing-now-v1",JSON.stringify(answer));
      sessionStorage.setItem("news-outing-now-draft-v1",JSON.stringify({minutes:"60",setting:"home",note:"旧版留下的想法"}));
    },answer);
    await page.reload();
    await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"旧版留下的想法");
    await context.close();
    page = await start();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.equal(await page.locator("#outing-now-note").inputValue(),"旧版留下的想法","migration survives a closed browser");
    // If durable storage fills up, the newer session fallback wins over a stale disk copy.
    await context.addInitScript(()=>{
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key === "news-outing-now-state-v2") throw new DOMException("Storage full","QuotaExceededError");
        return setItem.call(this,key,value);
      };
    });
    await page.reload();
    await page.locator("#outing-now-note").fill("本机空间不足时也先留在当前标签页");
    assert.match(await page.locator("#outing-now-status").innerText(),/无法保存到本机/);
    await page.reload();
    await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"本机空间不足时也先留在当前标签页");
    assert.equal(await page.locator(".outing-now-ideas > li").count(),3);
    assert.equal(calls,4,"migration and fallback recovery never call the model");
    assert.deepEqual(errors,[]);
    console.log("Advice recovery: browser restart, re-entry, failure, collapsed status, cross-tab completion, dated results, session migration and storage fallback passed.");
  } finally {
    await context?.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
