const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const token = "test-private-connection-" + "a".repeat(24);
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers:"block" });
    await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(), errors = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    let remote = {schema:1, settings:{startArea:"测试出发地",people:2,transport:"car"},records:[]};
    let holdFirstPost = false, release;
    await context.route("**/api/outings/profile", async route => {
      const request = route.request();
      requests.push({ method:request.method(), authorization:request.headers().authorization });
      if (request.method() === "POST") {
        const op = request.postDataJSON();
        if (holdFirstPost) { holdFirstPost=false; await new Promise(resolve => { release=resolve; }); }
        remote.records = remote.records.filter(r => r.id !== op.id);
        if (op.action === "record") remote.records.push({id:op.id,title:op.title,status:op.status});
      }
      await route.fulfill({json:remote});
    });
    await context.route("**/profile-fixture", route => route.fulfill({contentType:"text/html",body:
      '<meta name="news-refresh-endpoint" content="https://worker.example/api/news-refresh"><p>Feedback test</p>'}));
    const script = path.resolve(__dirname,"../news/assets/outings-profile.js");
    await page.goto(base + "/profile-fixture#local&outing-key=" + token);
    await page.addScriptTag({path:script});
    assert.equal(new URL(page.url()).hash, "#local", "connection token is removed from browser URL");
    await page.evaluate(() => OutingProfile.sync(true));
    assert.equal(await page.evaluate(() => OutingProfile.snapshot().settings.startArea), "测试出发地");
    assert(requests.every(r => r.authorization === "Bearer " + token));
    assert.equal(await page.evaluate(() => JSON.stringify(OutingProfile.snapshot()).includes(localStorage.getItem("news-outing-connection-v1"))), false);
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
    // A new phone uses the same private link; no records are embedded in HTML.
    const secondContext = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers:"block" });
    await secondContext.route("**/profile-fixture", route => route.fulfill({contentType:"text/html",body:
      '<meta name="news-refresh-endpoint" content="https://worker.example/api/news-refresh">'}));
    await secondContext.route("**/api/outings/profile", route => {
      assert.equal(route.request().headers().authorization,"Bearer " + token);
      return route.fulfill({json:remote});
    });
    const second = await secondContext.newPage();
    await second.goto(base + "/profile-fixture#local&outing-key=" + token);
    await second.addScriptTag({path:script});
    await second.evaluate(() => OutingProfile.sync(true));
    assert.equal(await second.evaluate(() => OutingProfile.snapshot().records[0].status),"dismiss");
    assert.deepEqual(errors,[]);
    await secondContext.close();
    await context.close();
    console.log("Outing feedback browser checks passed: private auth, offline queue, concurrent taps, undo and sync");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
