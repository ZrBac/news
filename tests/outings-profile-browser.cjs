const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const retiredToken = "test-private-connection-" + "a".repeat(24);
    let journalVersion=0;
    const journalRows=new Map(), receipts=new Set();
    const journalRoute=async route=>{
      const req=route.request();
      assert.equal(req.headers().authorization,undefined);
      if(req.method()==="POST") {
        const {operations}=req.postDataJSON();
        for(const op of operations) {
          if(receipts.has(op.id)) continue;
          receipts.add(op.id);
          if(op.action==="remove") journalRows.delete(op.recordId);
          else if(!journalRows.has(op.record.id)) journalRows.set(op.record.id,op.record);
          journalVersion++;
        }
        return route.fulfill({json:{schema:1,version:journalVersion,acknowledged:operations.map(op=>op.id)}});
      }
      const known=new URL(req.url()).searchParams.get("version");
      return route.fulfill({json:known!==null && Number(known)===journalVersion ? {schema:1,version:journalVersion,unchanged:true} :
        {schema:1,version:journalVersion,records:[...journalRows.values()]}});
    };
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers:"block" });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    let remote = {schema:1, settings:{startArea:"测试出发地",people:2,transport:"car"},records:[]};
    let holdFirstPost = false, release, failuresLeft = 0, failuresSeen = 0;
    await context.route("**/api/outings/profile", async route => {
      const request = route.request();
      requests.push({ method:request.method(), authorization:request.headers().authorization });
      if (request.method() === "POST") {
        const op = request.postDataJSON();
        if (failuresLeft) { failuresLeft--; failuresSeen++; return route.fulfill({status:503,json:{status:"unavailable"}}); }
        if (op.action === "settings" && !op.people) return route.fulfill({status:400,json:{status:"invalid_request"}});
        if (op.action === "record" && (!/^(place|event):[a-z0-9-]{1,100}$/.test(op.id) || op.title.length > 150 ||
          op.url?.length > 1500 || op.area?.length > 120 || op.day?.length > 120))
          return route.fulfill({status:400,json:{status:"invalid_request"}});
        if (op.action === "suggestion") remote.settings = {...remote.settings,weekendNote:op.text};
        if (op.action === "settings") remote.settings = {...remote.settings,startArea:op.startArea,people:op.people,transport:op.transport};
        if (holdFirstPost) { holdFirstPost=false; await new Promise(resolve => { release=resolve; }); }
        remote.records = remote.records.filter(r => r.id !== op.id);
        if (op.action === "record") remote.records.push({id:op.id,title:op.title,status:op.status});
      }
      await route.fulfill({json:remote});
    });
    await context.route("**/api/outings/journal*",journalRoute);
    await context.route("**/profile-fixture", route => route.fulfill({contentType:"text/html",body:
      '<meta name="news-refresh-endpoint" content="https://worker.example/api/news-refresh"><p>Feedback test</p>'}));
    const script = path.resolve(__dirname,"../news/assets/outings-profile.js");
    await page.goto(base + "/profile-fixture#tonight&outing-key=" + retiredToken);
    await page.evaluate(value=>localStorage.setItem("news-outing-connection-v1",value),retiredToken);
    await page.addScriptTag({path:script});
    const journalScript=path.resolve(__dirname,"../news/assets/tonight-journal.js");
    await page.addScriptTag({path:journalScript});
    assert.equal(new URL(page.url()).hash, "#tonight", "retired entrance is cleaned without changing the selected page");
    await page.evaluate(() => OutingProfile.sync(true));
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().settings.startArea), "测试出发地");
    assert(requests.length > 0 && requests.every(r => r.authorization === undefined));
    assert.equal(await page.evaluate(() => localStorage.getItem("news-outing-connection-v1")),null);
    holdFirstPost = true;
    await page.evaluate(() => OutingProfile.mark({id:"event:one",name:"周末体验"}, "want"));
    await page.waitForFunction(() => OutingProfile.snapshot().pending.length === 1);
    for (let attempts=0; !release && attempts<100; attempts++) await page.waitForTimeout(20);
    assert(release, "first request reached the remote store");
    await page.evaluate(() => OutingProfile.mark({id:"event:one",name:"周末体验"}, "dismiss"));
    release();
    await page.waitForFunction(() => !OutingProfile.snapshot().pending.length);
    assert.equal(remote.records[0].status,"dismiss", "a newer tap while saving is not lost");
    await context.setOffline(true);
    await page.evaluate(() => OutingProfile.mark({id:"event:two",name:"另一个体验"}, "visited"));
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),1);
    assert.equal(await page.evaluate(() => OutingProfile.excludes({id:"event:two"})),true);
    await context.setOffline(false);
    await page.evaluate(() => OutingProfile.sync(true));
    await page.waitForFunction(() => !OutingProfile.snapshot().pending.length);
    assert.equal(remote.records.find(r => r.id === "event:two").status,"visited");
    await page.evaluate(() => OutingProfile.update({action:"remove",id:"event:two"}));
    await page.waitForFunction(() => !OutingProfile.snapshot().pending.length);
    assert.equal(remote.records.some(r=>r.id==="event:two"), false);
    // A transient write failure is retried within the sync awaited by Refresh.
    failuresLeft = 1;
    await page.evaluate(async () => {
      OutingProfile.update({action:"suggestion",text:"本周想做木工"});
      await OutingProfile.sync(true);
    });
    assert.equal(failuresSeen,1);
    assert.equal(remote.settings.weekendNote,"本周想做木工");
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),0);
    await page.evaluate(async () => {
      OutingProfile.update({action:"record",id:"event:Legacy-Story",title:"旧活动标题".repeat(40),status:"visited",
        url:"https://example.com/"+"a".repeat(1500),area:"地点".repeat(100),day:"日期".repeat(100)});
      await OutingProfile.sync(true);
    });
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),0,"old display metadata no longer permanently blocks upload");
    assert.equal(remote.records.find(r=>r.id==="event:legacy-story").status,"visited");
    await page.evaluate(async () => {OutingProfile.update({action:"remove",id:"event:legacy-story"});await OutingProfile.sync(true);});
    // Reproduce an old invalid setting ahead of a new suggestion. Save the
    // valid operation and retain the rejected one instead of stopping the queue.
    await context.setOffline(true);
    await page.evaluate(() => {
      OutingProfile.update({action:"settings",startArea:"五常",people:0,transport:"car"});
      OutingProfile.update({action:"suggestion",text:"新建议不能被旧偏好挡住"});
    });
    await context.setOffline(false);
    await page.evaluate(() => OutingProfile.sync(true));
    assert.equal(remote.settings.weekendNote,"新建议不能被旧偏好挡住");
    assert.deepEqual(await page.evaluate(() => OutingProfile.snapshot().pending.map(op=>op.action)),["settings"]);
    assert.match(await page.evaluate(() => OutingProfile.status()),/格式不兼容/);
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().settings.people),0,"rejected local edit is preserved");
    await page.evaluate(async () => {
      OutingProfile.update({action:"settings",startArea:"五常",people:2,transport:"car"});
      await OutingProfile.sync(true);
    });
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),0);
    // A connected device retries without needing an offline/online transition,
    // even when Save leaves focus inside the suggestion form.
    await page.evaluate(() => {
      const form=document.createElement("form");form.innerHTML='<input name="draft" value="还没保存的文字">';
      document.body.append(form);form.firstElementChild.focus();
    });
    failuresLeft = 2;
    await page.evaluate(async () => {
      OutingProfile.update({action:"suggestion",text:"网络恢复后自动补传"});
      await OutingProfile.sync(true);
    });
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().pending.length),1);
    assert.match(await page.evaluate(() => OutingProfile.status()),/同步服务暂时不可用/);
    await page.waitForFunction(() => !OutingProfile.snapshot().pending.length,{},{timeout:15000});
    assert.equal(remote.settings.weekendNote,"网络恢复后自动补传");
    assert.equal(await page.locator('input[name="draft"]').inputValue(),"还没保存的文字");
    assert.equal(remote.records[0].status,"dismiss");
    // A fresh browser opens the ordinary website, with no stored credential or special link.
    const secondContext = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers:"block" });
    await secondContext.route("**/api/outings/profile", route => {
      assert.equal(route.request().headers().authorization,undefined);
      return route.fulfill({json:remote});
    });
    const second = await secondContext.newPage();
    await secondContext.route("**/api/outings/journal*",journalRoute);
    await second.goto(base + "/#tonight");
    await second.locator('#outing-records').waitFor();
    assert.equal(await second.locator('[data-outing-connect], [data-outing-sync]').count(),0,'no pairing form or manual sync button');
    await second.waitForFunction(()=>OutingProfile.status().includes('已自动同步'));
    assert.equal(new URL(second.url()).hash,'#tonight');
    assert.equal(await second.evaluate(()=>localStorage.getItem("news-outing-connection-v1")),null);
    assert.equal(await second.locator('body').innerText().then(text=>/专属入口|连接码|开启自动同步/.test(text)),false);
    assert.equal(await second.evaluate(() => OutingProfile.snapshot().records[0].status),"dismiss");
    await second.reload({waitUntil:'domcontentloaded'});
    await second.waitForFunction(()=>window.OutingProfile?.status().includes('已自动同步'));
    assert.equal(await second.evaluate(()=>OutingProfile.connected()),true,'ordinary reopening automatically resumes shared sync');
    const pick={id:"event:tonight-reading",name:"慢慢读完一本书"};
    await page.evaluate(pick=>TonightJournal.add(pick,"第一台手机的进展","第37页继续"),pick);
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem(TonightJournal.key)).pending.length===0);
    await second.bringToFront();
    await second.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await second.waitForFunction(()=>TonightJournal.snapshot().length===1);
    await context.setOffline(true);
    await secondContext.setOffline(true);
    await page.evaluate(pick=>TonightJournal.add(pick,"离线时第一台新增",""),pick);
    await second.evaluate(pick=>TonightJournal.add(pick,"离线时第二台新增",""),pick);
    await context.setOffline(false);
    await secondContext.setOffline(false);
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem(TonightJournal.key)).pending.length===0);
    await second.waitForFunction(()=>JSON.parse(localStorage.getItem(TonightJournal.key)).pending.length===0);
    await page.bringToFront();
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(()=>TonightJournal.snapshot().length===3);
    const removed=await page.evaluate(()=>{const note=TonightJournal.snapshot().find(r=>r.note==="第一台手机的进展");TonightJournal.remove(note.id);return note.id;});
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem(TonightJournal.key)).pending.length===0);
    await second.bringToFront();
    await second.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await second.waitForFunction(id=>!TonightJournal.snapshot().some(r=>r.id===id),removed);
    assert.equal(journalRows.size,2);
    assert.equal(JSON.stringify(remote).includes("进展"),false,"notes never enter the AI profile endpoint");
    assert.deepEqual(errors,[]);
    await secondContext.close();
    await context.close();
    console.log("Outing sync passed: ordinary entry without credentials, legacy cleanup, offline merge, deletes and AI input separation");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
