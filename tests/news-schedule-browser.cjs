const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const request = await browser.newContext();
    const original = await (await request.request.get(base + "/data/latest.json")).json();
    await request.close();
    for (const [now, checked, late] of [
      ["2026-11-09T01:00:00+08:00", "2026-11-08T21:05:00+08:00", false],
      ["2026-11-09T08:59:00+08:00", "2026-11-08T21:05:00+08:00", false],
      ["2026-11-09T09:30:00+08:00", "2026-11-08T21:05:00+08:00", false],
      ["2026-11-09T09:50:00+08:00", "2026-11-08T21:05:00+08:00", true],
      ["2026-11-09T16:10:00+08:00", "2026-11-09T15:05:00+08:00", false],
      ["2026-11-09T17:50:00+08:00", "2026-11-09T15:05:00+08:00", true],
      ["2026-11-09T23:00:00+08:00", "2026-11-09T21:05:00+08:00", false],
      ["2026-11-10T08:00:00+08:00", "2026-11-09T19:05:00+08:00", true],
    ]) {
      const context = await browser.newContext({ viewport: {width:390,height:844}, serviceWorkers:"block" });
      const page = await context.newPage();
      const errors=[];
      page.on("pageerror", e=>errors.push(e.message));
      await page.clock.install({ time: new Date(now) });
      const fixture={...original,updatedAt:now,newsCheckedAt:checked};
      await page.route("**/data/latest.json*", r=>r.fulfill({json:fixture}));
      await page.route("https://*.workers.dev/**", r=>r.fulfill({json:{schema:1,records:[],settings:{}}}));
      await page.goto(base+"/#general", {waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>document.querySelector("#update-status").textContent.includes("最近检查"));
      const text=await page.locator("#update-status").innerText();
      assert.equal(text.includes("检查已延迟"),late,now+": "+text);
      assert(text.includes(checked.slice(11,16)),"show actual news collection, not an outing publication");
      assert((await page.locator("#update-status").getAttribute("title")).includes("夜间暂停"));
      assert.deepEqual(errors,[]);
      await context.close();
    }
    console.log("News schedule: daytime grace, night pause, stale news and separate publication timestamps passed.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
