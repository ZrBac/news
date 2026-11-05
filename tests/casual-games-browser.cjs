// NEWS_LEGACY_SAFARI=1 PLAYWRIGHT_MODULE=/path/to/playwright NEWS_BASE_URL=http://127.0.0.1:8765 node tests/casual-games-browser.cjs
const { chromium, devices } = require(
    process.env.PLAYWRIGHT_MODULE || "playwright",
  ),
  assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 664 },
    });
    if (process.env.NEWS_LEGACY_SAFARI)
      await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const saved = (kind) =>
      page.evaluate(
        (kind) => JSON.parse(localStorage.getItem(`zacai-casual-${kind}-v1`)),
        kind,
      );
    const cell = (i) => page.locator(`#casual-grid [data-cell="${i}"]`);
    const settled = () =>
      page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
    await page.goto(base + "/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Prepare the game library once, before opening any individual game.
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    await context.setOffline(true);
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    assert.equal(await page.locator(".game-card").count(), 11);
    // Hold with actual touchscreen events until the center-target charge, then land and reload offline.
    await page.locator('a[href="#jump"]').tap();
    await page.locator("#casual-resume").tap();
    const touch = await context.newCDPSession(page),
      button = await page.locator("#jump-charge").boundingBox(),
      point = {
        x: button.x + button.width / 2,
        y: button.y + button.height / 2,
      };
    const initial = await saved("jump"),
      power =
        ((Math.hypot(initial.target.x, initial.target.y) - 65) / 170 / 1.3) *
        100;
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.waitForFunction(
      (power) =>
        Number(
          document.querySelector("#jump-meter").getAttribute("aria-valuenow"),
        ) >= power,
      power,
    );
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("zacai-casual-jump-v1")).jumps === 1,
    );
    await page.locator("#casual-pause").tap();
    const landed = await saved("jump");
    assert(landed.score >= 1);
    await page.reload();
    assert.deepEqual(await saved("jump"), landed);
    assert(await page.locator("#casual-overlay").isVisible());
    await page.locator("#casual-resume").tap();
    await page.keyboard.down("Space");
    await page.waitForFunction(
      () =>
        Number(
          document.querySelector("#jump-meter").getAttribute("aria-valuenow"),
        ) > 5,
    );
    await page.keyboard.press("p");
    await page.keyboard.up("Space");
    assert.equal((await saved("jump")).phase, "ready");
    assert(await page.locator("#casual-overlay").isVisible());
    await page.locator("#casual-help").tap();
    assert((await page.locator("#help-text").textContent()).includes("蓄力"));
    await page.locator("#close-help").tap();
    await page.locator("#casual-new").tap();
    await page.locator("#casual-new-cancel").tap();
    assert.equal((await saved("jump")).jumps, 1);
    await page.locator("#casual-resume").tap();
    await page.screenshot({ path: "/tmp/casual-jump.png" });
    await page.locator("#casual-pause").tap();
    // Match swaps, invalid moves, paid shuffles, hints, keyboard and animation-safe save.
    await page.goto(base + "/games/#match");
    assert.equal(await page.locator("#casual-grid button").count(), 49);
    await page.locator("#match-hint").tap();
    assert.equal(await page.locator(".hinted").count(), 2);
    const hint = await page.evaluate(() =>
      CasualGamesCore.matchHint(
        JSON.parse(localStorage.getItem("zacai-casual-match-v1")).board,
      ),
    );
    await cell(hint[0]).tap();
    await cell(hint[1]).tap();
    await page.waitForFunction(
      () => !document.querySelector("#match-hint").disabled,
    );
    let m = await saved("match");
    assert.equal(m.moves, 27);
    assert(m.score >= 30);
    await page.reload();
    assert.deepEqual(await saved("match"), m);
    const invalid = await page.evaluate(() => {
      const C = CasualGamesCore,
        s = JSON.parse(localStorage.getItem("zacai-casual-match-v1"));
      for (let i = 0; i < 49; i++)
        for (const j of [i + 1, i + 7])
          if (
            j < 49 &&
            Math.abs((i % 7) - (j % 7)) +
              Math.abs(Math.floor(i / 7) - Math.floor(j / 7)) ===
              1 &&
            !C.matchSwap(C.clone(s), i, j)
          )
            return [i, j];
    });
    await cell(invalid[0]).tap();
    await cell(invalid[1]).tap();
    assert.deepEqual(await saved("match"), m);
    await page.locator("#match-shuffle").tap();
    assert.equal((await saved("match")).moves, 25);
    const swipe = await page.evaluate(() =>
      CasualGamesCore.matchHint(
        JSON.parse(localStorage.getItem("zacai-casual-match-v1")).board,
      ),
    );
    const a = await cell(swipe[0]).boundingBox(),
      b = await cell(swipe[1]).boundingBox();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: a.x + a.width / 2, y: a.y + a.height / 2 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () => !document.querySelector("#match-hint").disabled,
    );
    assert.equal((await saved("match")).moves, 24);
    await cell(0).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator(".selected").getAttribute("data-cell"),
      "1",
    );
    await page.screenshot({ path: "/tmp/casual-match.png" });
    // A reachable near-goal fixture completes the level through real UI controls.
    await page.evaluate(() => {
      CasualGames.close();
      const s = CasualGamesCore.matchCreate(8);
      s.roundScore = s.score = 990;
      localStorage.setItem("zacai-casual-match-v1", JSON.stringify(s));
    });
    await page.goto(base + "/games/?goal=1#match");
    const winning = await page.evaluate(() =>
      CasualGamesCore.matchHint(
        JSON.parse(localStorage.getItem("zacai-casual-match-v1")).board,
      ),
    );
    await cell(winning[0]).tap();
    await cell(winning[1]).tap();
    await page.locator("#casual-result").waitFor();
    assert.equal((await saved("match")).phase, "clear");
    await page.locator("#casual-result-action").tap();
    assert.equal((await saved("match")).level, 2);
    assert.equal((await saved("match")).moves, 28);
    // Mine long press should flag once and never reveal; explicit mode also works.
    await page.goto(base + "/games/#mines");
    const target = await cell(0).boundingBox();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      ],
    });
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("zacai-casual-mines-v1")).flags[0],
    );
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    let mines = await saved("mines");
    assert(mines.flags[0]);
    assert(!mines.started);
    assert(!mines.open[0]);
    await page.locator("#mine-mode").tap();
    await cell(0).tap();
    assert(!(await saved("mines")).flags[0]);
    await page.locator("#mine-mode").tap();
    await cell(27).tap();
    mines = await saved("mines");
    assert(mines.started);
    assert.equal(mines.board[27], 0);
    assert(mines.open.filter(Boolean).length >= 9);
    const closed = mines.open.findIndex((v) => !v);
    await cell(closed).click({ button: "right" });
    assert((await saved("mines")).flags[closed]);
    await cell(closed).focus();
    await page.keyboard.press("f");
    assert(!(await saved("mines")).flags[closed]);
    await page.reload();
    assert.deepEqual((await saved("mines")).board, mines.board);
    assert.deepEqual((await saved("mines")).open, mines.open);
    await page.screenshot({ path: "/tmp/casual-mines.png" });
    await page.locator("#casual-new").tap();
    await page.locator("#casual-level").selectOption("hard");
    await page.locator("#casual-new-confirm").tap();
    assert.equal(await page.locator("#casual-grid button").count(), 108);
    assert.equal((await saved("mines")).mines, 22);
    await cell(45).tap();
    // Every safe cell can be opened through UI; the loss result reveals the mine layout.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("zacai-casual-mines-v1"));
      for (let i = 0; i < s.board.length; i++)
        if (s.board[i] !== -1)
          document.querySelector(`[data-cell="${i}"]`).click();
    });
    assert.equal((await saved("mines")).phase, "won");
    assert(await page.locator("#casual-result").isVisible());
    await page.locator("#casual-new").tap();
    await page.locator("#casual-new-confirm").tap();
    await cell(0).tap();
    const bomb = (await saved("mines")).board.indexOf(-1);
    await cell(bomb).tap();
    assert.equal((await saved("mines")).phase, "lost");
    assert.equal(await page.locator(".mine").count(), 22);
    // Check small phone, landscape and tablet dimensions after the resize event/layout frame.
    for (const [width, height] of [
      [320, 568],
      [390, 664],
      [844, 390],
      [1024, 768],
    ]) {
      await page.setViewportSize({ width, height });
      for (const kind of ["jump", "match", "mines"]) {
        await page.goto(base + "/games/#" + kind);
        await settled();
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          play: document
            .querySelector("#casual-play")
            .getBoundingClientRect()
            .toJSON(),
          cell: document
            .querySelector("#casual-grid button")
            ?.getBoundingClientRect()
            .toJSON(),
          tools: document
            .querySelector('#casual-play [class="casual-tools"]:not([hidden])')
            ?.getBoundingClientRect()
            .toJSON(),
          charge: document
            .querySelector("#jump-charge")
            .getBoundingClientRect()
            .toJSON(),
        }));
        assert(!layout.overflow, `${kind} ${width} no horizontal overflow`);
        assert(layout.play.bottom <= height + 0.5);
        if (kind === "jump") {
          assert(layout.charge.bottom <= height);
          assert(layout.charge.height >= 44);
        } else {
          assert(layout.cell.width >= 26);
          assert(layout.tools.bottom <= height);
        }
      }
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(base + "/games/#jump");
    await page.locator("#casual-resume").tap();
    await settled();
    await page.screenshot({ path: "/tmp/casual-jump-wide.png" });
    // Older games and route cleanup remain usable.
    await page.goto(base + "/games/#blocks");
    assert(await page.locator("#extra-play").isVisible());
    assert(await page.locator("#casual-play").isHidden());
    await page.goto(base + "/games/#spider");
    assert.equal(await page.locator(".spider-column").count(), 10);
    await page.goto(base + "/games/#breakout");
    assert(await page.locator("#play").isVisible());
    assert.deepEqual(errors, []);
    await context.close();
    // Storage denial falls back to memory within this page; invalid stores recover.
    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      Storage.prototype.setItem = function () {
        throw new Error("blocked");
      };
    });
    const q = await blocked.newPage();
    await q.goto(base + "/games/#match");
    await q.locator("#match-shuffle").click();
    await q.goto(base + "/games/#mines");
    await q.goto(base + "/games/#match");
    assert((await q.locator("#casual-hud").textContent()).includes("26"));
    assert((await q.locator("#casual-save").textContent()).includes("未允许"));
    await blocked.close();
    const corrupt = await browser.newContext();
    await corrupt.addInitScript(() =>
      localStorage.setItem("zacai-casual-mines-v1", '{"kind":"mines"}'),
    );
    const r = await corrupt.newPage();
    await r.goto(base + "/games/#mines");
    assert.equal(await r.locator("#casual-grid button").count(), 64);
    await corrupt.close();
    console.log(
      "PASS: all games offline after library preparation, touch hold/swipe/flag, keyboard, saves, match completion, mine win/loss, small/landscape layouts, legacy dialogs, storage recovery and old game routes.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
