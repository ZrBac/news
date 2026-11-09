const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "outing-now-recovery-"));
  let context, mode="pending", calls=0, reads=0, latest;
  const errors=[], jobs=new Map();
  const answer={schema:1,status:"ok",contextVersion:3,generatedAt:new Date().toISOString(),intro:"练一次速写，留下作品。",weather:null,
    ideas:["速写","阅读","整理照片"].map((title,i)=>({id:"event:practice-"+i,title,reason:"下次可以接着做。",minutes:25,
      steps:["拿出材料。","写下今天的收获。"],outcome:"一条记录",setting:"home",sources:[]}))};
  const completed=()=>({schema:1,status:"ok",result:structuredClone(answer)});
  async function start() {
    context=await chromium.launchPersistentContext(directory,{...devices["iPhone 13"],serviceWorkers:"block",args:["--no-sandbox"]});
    await context.addInitScript(require("./legacy-safari.cjs"));
    context.on("page",page=>page.on("pageerror",error=>errors.push(error.message)));
    for(const page of context.pages())page.on("pageerror",error=>errors.push(error.message));
    await context.route("**/api/outings/profile",r=>r.fulfill({json:{schema:1,settings:{},records:[]}}));
    await context.route("**/api/outings/journal*",r=>r.fulfill({json:{schema:1,version:0,records:[]}}));
    await context.route("**/api/outings/now/jobs/*",async route=>{
      const id=route.request().url().split("/").pop();latest=id;
      if(route.request().method()==="POST") {
        calls++;
        if(mode==="lost")return route.abort("failed");
        if(!jobs.has(id))jobs.set(id,mode==="pending"?{schema:1,status:"running",stage:"generating",deadline:Date.now()+120000}:
          mode==="error"?{schema:1,status:"unavailable"}:completed());
      } else reads++;
      await route.fulfill({status:jobs.has(id)?200:404,json:jobs.get(id)||{status:"not_found"}}).catch(()=>{});
    });
    const page=context.pages()[0];await page.goto(base+"/#tonight");
    await page.locator("#outing-now > summary").waitFor();return page;
  }
  try {
    let page=await start();
    await page.locator("#outing-now > summary").click();
    await page.locator("#outing-now-minutes").selectOption("30");
    await page.locator("#outing-now-setting").selectOption("home");
    await page.locator("#outing-now-note").fill("今晚想画画，明天继续");
    await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已提交"));
    const first=latest;
    await page.locator("#outing-now > summary").click();
    await page.evaluate(()=>{location.hash="#brief";});
    await page.waitForFunction(()=>document.querySelector("#outing-now").hidden);
    await page.evaluate(()=>{location.hash="#tonight";});
    await page.locator("#outing-now > summary").waitFor();
    assert.match(await page.locator("#outing-now > summary").innerText(),/正在获取/);
    await page.locator("#outing-now").evaluate(panel=>panel.addEventListener("toggle",e=>e.stopImmediatePropagation(),{capture:true,once:true}));
    await page.locator("#outing-now > summary").click();
    assert.equal(calls,1);
    await context.close();
    jobs.set(first,completed());
    page=await start();
    await page.waitForSelector(".outing-now-ideas > li");
    assert.equal(await page.locator("#outing-now-note").inputValue(),"今晚想画画，明天继续");
    assert.equal(await page.locator("#outing-now-minutes").inputValue(),"30");
    assert.equal(await page.locator("#outing-now-setting").inputValue(),"home");
    assert.equal(calls,1,"closing the entire browser resumes GET, not a second paid POST");
    assert(reads>0);assert.match(await page.locator("#outing-now-status").innerText(),/整理好了/);
    await context.close();page=await start();
    await page.waitForSelector(".outing-now-ideas > li");assert.equal(calls,1);
    mode="error";await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("没能取得"));
    await page.locator("#outing-now > summary").click();await page.reload();
    await page.locator("#outing-now > summary").waitFor();
    assert(!(await page.locator("#outing-now").evaluate(e=>e.open)));
    await page.locator("#outing-now > summary").click();
    assert.match(await page.locator("#outing-now-status").innerText(),/没能取得.*上次结果/);
    assert.equal(calls,2,"terminal failure never triggers generation on reload");
    mode="pending";await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("已提交"));
    const shared=latest, second=await context.newPage();
    await second.goto(base+"/#local");await second.locator("#outing-now-note").waitFor();
    await second.locator("#outing-now-note").fill("另一页的新想法先留着");
    answer.intro="原请求完成后，返回入口也能看到这次建议。";jobs.set(shared,completed());
    await second.waitForFunction(()=>document.querySelector(".outing-now-intro").textContent.includes("原请求完成"));
    assert.equal(await second.locator("#outing-now-note").inputValue(),"另一页的新想法先留着");
    assert.match(await second.locator("#outing-now-status").innerText(),/条件已更改/);
    await second.reload();await second.locator("#outing-now-note").waitFor();
    assert.equal(await second.locator("#outing-now-note").inputValue(),"另一页的新想法先留着");
    assert.equal(calls,3,"both tabs can read one job without resubmission");await second.close();
    // Failure before acceptance is recoverable with an explicit replay of the
    // same opaque ID, so a late acknowledgement cannot create a duplicate job.
    mode="lost";await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("还未确认"));
    const uncertain=latest;assert.equal(jobs.has(uncertain),false);
    mode="ok";await page.locator("#outing-now-submit").click();
    await page.waitForFunction(()=>document.querySelector("#outing-now-status").textContent.includes("整理好了"));
    assert.equal(latest,uncertain,"manual retry keeps the original ID when acceptance was uncertain");
    assert.equal(calls,5);
    await context.addInitScript(()=>{const now=Date.now;Date.now=()=>now()+2*86400000;});
    await page.reload();await page.waitForSelector(".outing-now-ideas > li");
    assert.match(await page.locator("#outing-now-result").innerText(),/上次建议，时间和天气可能已变化/);
    // Old faulty recommendations remain available on request, collapsed by
    // default instead of filling the page after every failed new attempt.
    await page.evaluate(answer=>{
      localStorage.removeItem("news-outing-now-state-v2");sessionStorage.removeItem("news-outing-now-state-v2");
      delete answer.contextVersion;
      sessionStorage.setItem("news-outing-now-v1",JSON.stringify(answer));
      sessionStorage.setItem("news-outing-now-draft-v1",JSON.stringify({minutes:"60",setting:"home",note:"旧版留下的想法"}));
    },answer);
    await page.reload();await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"旧版留下的想法");
    assert.match(await page.locator("#outing-now-result").innerText(),/按旧规则生成，建议重新获取/);
    assert.equal(await page.locator("#outing-now-result > details").evaluate(e=>e.open),false);
    await page.locator("#outing-now-result > details > summary").click();
    await page.waitForSelector(".outing-now-ideas > li");
    await context.close();page=await start();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"旧版留下的想法");
    await context.addInitScript(()=>{
      const setItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value) {
        if(this===localStorage && key==="news-outing-now-state-v2")throw new DOMException("Storage full","QuotaExceededError");
        return setItem.call(this,key,value);
      };
    });
    await page.reload();await page.locator("#outing-now-note").fill("本机空间不足时也先留在当前标签页");
    assert.match(await page.locator("#outing-now-status").innerText(),/无法保存到本机/);
    await page.reload();await page.locator("#outing-now-note").waitFor();
    assert.equal(await page.locator("#outing-now-note").inputValue(),"本机空间不足时也先留在当前标签页");
    assert.equal(calls,5,"migration and fallback recovery never generate");
    assert.deepEqual(errors,[]);
    console.log("Advice recovery: real browser restart, server result recovery, cross-tab edits, uncertain submission replay, legacy collapse and storage fallback passed.");
  } finally {await context?.close();await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
