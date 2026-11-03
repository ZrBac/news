const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    await context.addInitScript(require("./legacy-safari.cjs"));
    await context.addInitScript(() => { Date.now = () => Date.parse("2026-11-02T08:00:00Z"); });
    const page = await context.newPage(), errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(base)) external.push(request.url());
    });
    const packet = await (await page.request.get(base + "/data/latest.json")).json();
    const general = packet.sources.find((s) => s.category === "general");
    const item = (id, title, eventId, stamp) => ({
      id, title, category: "general", sourceId: general.id, url: "https://example.com/" + id,
      publishedAt: stamp, excerpt: "来源原有摘要",
      editorial: { eventId, summary: "杭州本周消费券将于11月3日开始申领。", updatedAt: "2026-11-02T07:30:00Z" },
    });
    packet.articles = [
      item("ai-a", "杭州公布新一轮消费券安排", "event-" + "a".repeat(24), "2026-11-02T07:00:00Z"),
      item("ai-b", "11月3日起申领杭州消费券", "event-" + "a".repeat(24), "2026-11-02T06:00:00Z"),
      item("ai-c", "另一个独立事件", "event-" + "b".repeat(24), "2026-11-02T05:00:00Z"),
    ];
    packet.briefArticles = packet.articles;
    packet.briefDays = ["2026-11-02", "2026-11-01"];
    packet.modelReleases = packet.gamingArticles = packet.housingArticles = [];
    delete packet.archive;
    packet.weekendArticles = [{
      id: "camp-facts", title: "杭州周末营地预约信息", category: "local", sourceId: "web-discovery",
      sourceName: "杭州文旅", url: "https://example.com/camp", publishedAt: "2026-11-02T01:00:00Z",
      excerpt: "营地公布了本周预约安排。", outing: { type: "camping", start: "2026-11-07", end: "2026-11-08" },
      facts: [{ kind: "stove", text: "禁止使用自带卡式炉" }, { kind: "parking", text: "停车后步行200米" }],
    }];
    const sunny = { date: "2026-11-07", code: 2, low: 10, high: 20, rainProbability: 10, rainMm: 0, windKmh: 8 };
    const rainy = { ...sunny, date: "2026-11-08", code: 63, rainProbability: 90, rainMm: 8 };
    const pick = { discovery: true, verifiedAt:"2026-11-02T07:00:00Z", novelty: "本周新增的活动与体验安排。", start:"2026-11-07", end:"2026-11-08", id: "place:baoshi", placeId: "baoshi", name: "宝石山", type: "hiking", region: "hangzhou",
      day: "2026-11-07", reason: "周六降水概率较低，可安排一段轻松步行。", reviewedOn: "2026-10-30",
      sources: [{ label: "文旅部门", url: "https://example.com/route" }] };
    packet.editorial = { news: { processed: 3, status: "ok" }, trip: {
      status: "ok", updatedAt: "2026-11-02T07:00:00Z", weekendStart: "2026-11-07", weekendEnd: "2026-11-08",
      weather: { updatedAt: "2026-11-02T07:00:00Z", regions: { hangzhou: { name: "杭州", days: [sunny, rainy] } } },
      picks: [pick, { ...pick, id: "rain-camp", name: "应被雨天条件拦截的露营", type: "camping", day: "2026-11-08" },
        { ...pick, id: "rainy-room", placeId: "", name: "室内书店", type: "rainy", day: "2026-11-08",
          reason: '室内阅读 <img id="bad" src=x onerror="window.bad=1">', sources: [{ label: "坏链接", url: "javascript:alert(1)" }] },
        { ...pick, id: "place:beigao", placeId: "beigao", name: "北高峰" },
        ...Array.from({length:5}, (_, i) => ({...pick, id:`event:extra-${i}`, placeId:"", name:`新增体验${i}`}))],
    } };
    await page.route("**/data/latest.json*", (route) => route.fulfill({ json: packet }));
    await page.goto(base + "/#brief");
    await page.evaluate(() => window.newsInitialLoad);
    assert.equal(await page.locator(".article").count(), 2);
    assert.equal(await page.locator(".editorial-summary").count(), 2);
    await page.locator(".article-reports summary").click();
    assert.match(await page.locator(".article-reports").innerText(), /11月3日起/);
    assert(await page.locator("#outing-recommendations").isHidden());
    await page.locator('[data-view="local"]').click();
    assert(await page.locator('#outing-filters').isHidden(), 'catalog filters start collapsed');
    assert(await page.locator('#source-filter').isHidden());
    assert(await page.locator('#outing-recommendations').evaluate(node =>
      !!(node.compareDocumentPosition(document.querySelector('#outing-catalog-heading')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'recommendations precede catalog controls in reading order');
    assert(await page.locator('.trip-discoveries h3').first().evaluate(node => node.getBoundingClientRect().top < 420), 'mobile first screen reaches an actual recommendation');
    assert.equal(await page.locator(".trip-list > li:visible").count(), 3);
    assert.equal(await page.locator("#bad").count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.match(await page.locator(".trip-list").innerText(), /降水概率 90%/);
    assert.equal(await page.locator(".trip-details[open]").count(), 0);
    assert(await page.locator('[data-trip-place="baoshi"]').isHidden());
    await page.locator(".trip-details > summary").first().click();
    assert(await page.locator('.trip-details').first().locator('a[href="https://example.com/route"]').isVisible());
    await page.locator('[data-trip-place="baoshi"]').click();
    assert(await page.locator("#hiking-places").getAttribute("open") !== null);
    assert(await page.locator('[data-place-id="baoshi"] .place-details').getAttribute("open") !== null);
    assert(await page.locator('[data-place-id="beigao"]').isHidden());
    assert.match(await page.locator('[data-trip-more]').innerText(), /再看 5 个新发现/);
    await page.locator('[data-trip-more]').click();
    assert.equal(await page.locator(".trip-list > li:visible").count(), 8);
    await page.locator('[data-outing-id="place:beigao"] .trip-details > summary').click();
    await page.locator('[data-trip-place="beigao"]').click();
    assert(await page.locator('[data-place-id="beigao"] .place-links').isVisible(), "recommendations reveal references beyond the first page");
    await page.locator('[data-save="camp-facts"]').click();
    assert.equal(await page.locator(".trip-list > li:visible").count(), 8, "saving a story keeps expanded recommendations");
    assert(await page.locator('[data-trip-place="beigao"]').isVisible());
    await page.locator('[data-trip-more]').click();
    assert.equal(await page.locator(".trip-list > li:visible").count(), 3);
    await page.locator(".outing-facts summary").click();
    assert.match(await page.locator(".outing-facts").innerText(), /禁止使用自带卡式炉/);
    assert.match(await page.locator('[data-article-id="camp-facts"] .article-meta').innerText(), /杭州文旅/);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no overflow at " + width);
    }
    await page.fill("#search", "宝石山");
    assert.equal(await page.locator(".trip-list > li").count(), 8, 'catalog search does not hide recommendations');
    await page.locator('#outing-filter-toggle').click();
    await page.locator('[data-outing-type="experience"]').click();
    assert.equal(await page.locator('.trip-discoveries > li').count(), 8);
    await page.locator('#date-trigger').click();
    await page.fill('#date-filter', '2026-11-01');
    assert.equal(await page.locator('.trip-discoveries > li').count(), 8, 'source publication dates only filter the catalog');
    await page.locator('#outing-filter-toggle').click();
    assert.match(await page.locator('#outing-filter-toggle').innerText(), /筛选 · 2/);
    await page.locator('#outing-filter-toggle').click();
    await page.locator('#outing-filter-reset').click();
    assert.equal(await page.locator('#search').inputValue(), '');
    assert.equal(await page.locator('#date-filter').inputValue(), '');
    await page.fill("#search", "");
    await page.locator('[data-outing-id="place:baoshi"] [data-outing-feedback="want"]').click();
    assert.equal(await page.locator('[data-outing-id="place:baoshi"] [data-outing-feedback="want"]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.unroute("**/data/latest.json*");
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".trip-list li").first().waitFor();
    assert.equal(await page.locator(".trip-list > li:visible").count(), 3, "saved recommendations remain readable offline");
    await page.locator('[data-trip-more]').click();
    assert.equal(await page.locator(".trip-list > li:visible").count(), 8, "extra recommendations remain available offline");
    assert.match(await page.locator("#load-notice").innerText(), /上次成功获取/);
    assert.equal(await page.locator('[data-outing-id="place:baoshi"] [data-outing-feedback="want"]').getAttribute('aria-pressed'), 'true', 'feedback survives offline reload');
    await page.locator('[data-outing-id="place:baoshi"] [data-outing-feedback="visited"]').click();
    assert.equal(await page.locator('[data-outing-id="place:baoshi"]').count(), 0);
    await page.locator('.outing-profile > summary').click();
    assert.match(await page.locator('.outing-records').innerText(), /宝石山 · 去过/);
    await page.locator('[data-outing-remove="place:baoshi"]').click();
    assert.equal(await page.locator('[data-outing-id="place:baoshi"]').count(), 1, 'undo restores an excluded suggestion');
    await page.evaluate(() => { Date.now = () => Date.parse("2026-11-05T08:00:00Z"); });
    await page.locator('#outing-filter-toggle').click();
    await page.locator('[data-outing-type="outdoor"]').click();
    await page.locator('[data-outing-kind="camping"]').click();
    await page.locator('[data-outing-type="all"]').click();
    assert.equal(await page.locator(".trip-list").count(), 0, "old weather must not look current");
    assert(await page.locator(".outing-profile").isVisible(), "personal records stay accessible after forecasts expire");
    await page.evaluate(packet => {
      Date.now = () => Date.parse('2026-11-02T08:00:00Z');
      packet.editorial.trip.alternatives = [{...packet.editorial.trip.picks[0], discovery:false}];
      packet.editorial.trip.picks = [];
      window.NewsEditorial.render(packet, {view:'local',query:'',outingType:'all',source:'all',date:''}, s=>s);
    }, packet);
    assert.equal(await page.locator('.trip-discoveries').count(), 0);
    assert.match(await page.locator('.trip-empty').innerText(), /暂未找到/);
    assert(await page.locator('.trip-backups .trip-list').isHidden(), 'permanent places start collapsed');
    await page.locator('.trip-backups > summary').click();
    await page.locator('.trip-backups .trip-details > summary').click();
    assert.match(await page.locator('.trip-backups').innerText(), /常设地点参考/);
    await page.locator('.brand').click();
    assert(await page.locator('.filter-row #source-filter').isVisible(), 'news source controls return to their original position');
    assert.equal(await page.locator('#source-filter').count(), 1);
    assert(await page.locator('#outing-catalog-heading').isHidden());
    await page.locator('[data-view="local"]').click();
    assert(await page.locator('#outing-filters').isHidden(), 'returning to outings resets the filter drawer');
    assert.equal(await page.locator('#outing-catalog-heading #result-count').count(), 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "reading recommendations must not call external APIs");
    await context.close();
    console.log("Editorial browser checks passed: grouping, facts, weather, filters, escaping and mobile layout");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
