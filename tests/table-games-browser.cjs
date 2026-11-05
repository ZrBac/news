// PLAYWRIGHT_MODULE=/path/to/playwright NEWS_BASE_URL=http://127.0.0.1:8765 node tests/table-games-browser.cjs
const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 664 },
    });
    await context.addInitScript(() => {
      let seed = 260926;
      Math.random = () =>
        (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    });
    if (process.env.NEWS_LEGACY_SAFARI)
      await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const saved = (kind) =>
      page.evaluate(
        (kind) => JSON.parse(localStorage.getItem(`zacai-table-${kind}-v1`)),
        kind,
      );
    await page.goto(base + "/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Prepare the game library once, before opening any individual game.
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    await context.setOffline(true);
    await page.goto(base + "/games/#spider");
    await page.locator("#table-play").waitFor();
    assert.equal(await page.locator(".spider-column").count(), 10);
    assert.equal(await page.locator(".spider-card:not(.facedown)").count(), 10);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      390,
    );
    for (const width of [320, 375, 390, 430, 600, 844]) {
      await page.setViewportSize({ width, height: 664 });
      const layout = await page.evaluate(() => {
        const scroll = document.querySelector("#spider-scroll");
        const bounds = scroll.getBoundingClientRect();
        return {
          overflow: scroll.scrollWidth - scroll.clientWidth,
          cardsFit: [...document.querySelectorAll(".spider-card")].every(
            (card) => {
              const box = card.getBoundingClientRect();
              const corner = card
                .querySelector(".card-corner")
                ?.getBoundingClientRect();
              return (
                box.left >= bounds.left &&
                box.right <= bounds.right &&
                (!corner ||
                  (corner.left >= box.left &&
                    corner.right <= box.right &&
                    corner.bottom <= box.top + 40))
              );
            },
          ),
        };
      });
      assert(layout.overflow <= 1, `all ten columns must fit at ${width}px`);
      assert(
        layout.cardsFit,
        `cards and corner marks must stay visible at ${width}px`,
      );
    }
    await page.setViewportSize({ width: 390, height: 664 });
    await page.screenshot({ path: "/tmp/news-spider-phone.png" });
    const initial = await saved("spider");
    await page.locator("#spider-deal").tap();
    assert.equal((await saved("spider")).state.stock.length, 40);
    await page.locator("#table-undo").tap();
    assert.deepEqual((await saved("spider")).state, initial.state);
    // Use a guaranteed legal move, exercising the actual two-tap controller on the fitted table.
    let hint = await page.evaluate(
      () =>
        TableGamesCore.spiderHints(
          JSON.parse(localStorage.getItem("zacai-table-spider-v1")).state,
        )[0],
    );
    if (!hint) {
      await page.locator("#spider-deal").tap();
      hint = await page.evaluate(
        () =>
          TableGamesCore.spiderHints(
            JSON.parse(localStorage.getItem("zacai-table-spider-v1")).state,
          )[0],
      );
    }
    assert(hint);
    const preMove = (await saved("spider")).state;
    const source = page.locator(
      `[data-col="${hint.from}"][data-index="${hint.index}"]`,
    );
    await source.tap();
    assert((await source.getAttribute("aria-pressed")) === "true");
    const destCount = preMove.columns[hint.to].length;
    if (destCount)
      await page
        .locator(`[data-col="${hint.to}"][data-index="${destCount - 1}"]`)
        .tap();
    else await page.locator(`[data-to="${hint.to}"]`).tap();
    assert.equal((await saved("spider")).state.moves, preMove.moves + 1);
    const moved = await saved("spider");
    await page.reload();
    assert.deepEqual(await saved("spider"), moved);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: "/tmp/news-spider-landscape.png" });
    assert.deepEqual((await saved("spider")).state, moved.state);
    await page.locator("#table-help").tap();
    assert((await page.locator("#help-text").textContent()).includes("104"));
    await page.locator("#close-help").tap();
    await page.locator("#table-new").tap();
    await page.locator("#table-level").selectOption("2");
    await page.locator("#table-new-cancel").tap();
    assert.deepEqual((await saved("spider")).state, moved.state);
    await page.locator("#table-new").tap();
    await page.locator("#table-level").selectOption("2");
    await page.locator("#table-new-confirm").tap();
    assert.equal((await saved("spider")).state.suits, 2);
    assert.equal((await saved("spider")).history.length, 0);
    await page.locator("#table-play .back").tap();
    await page.locator('a[href="#sudoku"]').tap();
    await page.setViewportSize({ width: 390, height: 664 });
    assert.equal(await page.locator(".sudoku-cell").count(), 81);
    const puzzle = (await saved("sudoku")).state;
    const i = puzzle.givens.findIndex((n) => !n),
      answer = puzzle.solution[i];
    await page.locator(`[data-cell="${i}"]`).tap();
    await page.locator("#sudoku-notes").tap();
    await page.locator(`[data-number="${answer}"]`).tap();
    assert.equal((await saved("sudoku")).state.notes[i], 1 << (answer - 1));
    assert.equal((await saved("sudoku")).state.values[i], 0);
    await page.locator("#table-undo").tap();
    assert.equal((await saved("sudoku")).state.notes[i], 0);
    await page.locator("#sudoku-notes").tap();
    await page.locator(`[data-number="${answer}"]`).tap();
    assert.equal((await saved("sudoku")).state.values[i], answer);
    await page.locator("#sudoku-erase").tap();
    assert.equal((await saved("sudoku")).state.values[i], 0);
    await page.locator("#table-hint").tap();
    assert.equal((await saved("sudoku")).state.values[i], answer);
    assert.equal((await saved("sudoku")).state.hints, 1);
    const progress = await saved("sudoku");
    await page.screenshot({ path: "/tmp/news-sudoku-phone.png" });
    const pad = await page.locator("#sudoku-pad").boundingBox();
    assert(
      pad.y + pad.height <= 664,
      "number pad must be visible without scrolling on iPhone 13",
    );
    await page.reload();
    assert.deepEqual(await saved("sudoku"), progress);
    await page.locator(`[data-cell="${i}"]`).tap();
    await page.keyboard.press("Delete");
    assert.equal((await saved("sudoku")).state.values[i], 0);
    await page.keyboard.press(String(answer));
    assert.equal((await saved("sudoku")).state.values[i], answer);
    await page.keyboard.press("Control+z");
    assert.equal((await saved("sudoku")).state.values[i], 0);
    await page.locator("#table-new").tap();
    await page.locator("#table-level").selectOption("hard");
    await page.locator("#table-new-confirm").tap();
    assert.equal(
      (await saved("sudoku")).state.givens.filter(Boolean).length,
      28,
    );
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: "/tmp/news-sudoku-landscape.png" });
    const landscapeBoard = await page.locator("#sudoku-board").boundingBox();
    assert(
      landscapeBoard.y + landscapeBoard.height <= 390,
      "landscape board fits vertically",
    );
    await page.locator("#table-play .back").tap();
    await page.locator('a[href="#breakout"]').tap();
    await page.locator("#start-game").tap();
    await page.locator("#pause-game").tap();
    assert(await page.locator("#table-play").isHidden());
    assert.deepEqual(errors, []);
    await context.setOffline(false);
    // Storage denied: still playable and resumable within the current document, explicit notice.
    const denied = await browser.newContext({ ...devices["iPhone 13"] });
    await denied.addInitScript(() => {
      Storage.prototype.setItem = function () {
        throw new Error("denied");
      };
    });
    const dp = await denied.newPage();
    await dp.goto(base + "/games/#spider");
    assert(
      (await dp.locator("#table-save-status").textContent()).includes(
        "不允许存档",
      ),
    );
    await dp.locator("#spider-deal").tap();
    await dp.locator("#table-play .back").tap();
    await dp.locator('a[href="#spider"]').tap();
    assert((await dp.locator("#spider-deal").textContent()).includes("4"));
    await denied.close();
    // Completion and undo through the UI, using legitimate states one move from finishing.
    await page.evaluate(() => {
      const s = TableGamesCore.createSpider();
      s.stock = [];
      s.columns = Array.from({ length: 10 }, () => []);
      s.completed = Array.from({ length: 7 }, (_, n) =>
        Array.from({ length: 13 }, (_, i) => ({
          id: n * 13 + 12 - i,
          up: true,
        })),
      );
      s.columns[0] = Array.from({ length: 12 }, (_, i) => ({
        id: 103 - i,
        up: true,
      }));
      s.columns[1] = [{ id: 91, up: true }];
      localStorage.setItem(
        "zacai-table-spider-v1",
        JSON.stringify({ state: s, history: [] }),
      );
    });
    await page.goto(base + "/games/#spider");
    await page.locator('[data-col="1"][data-index="0"]').tap();
    await page.locator('[data-col="0"][data-index="11"]').tap();
    assert(await page.locator("#table-result").isVisible());
    assert.equal((await saved("spider")).state.completed.length, 8);
    await page.locator("#table-undo").tap();
    assert(await page.locator("#table-result").isHidden());
    await page.evaluate(() => {
      const s = TableGamesCore.createSudoku();
      s.values = [...s.solution];
      s.values[s.givens.findIndex((n) => !n)] = 0;
      localStorage.setItem(
        "zacai-table-sudoku-v1",
        JSON.stringify({ state: s, history: [] }),
      );
    });
    await page.goto(base + "/games/?completion-test=1#sudoku");
    await page.locator("#table-hint").tap();
    assert(await page.locator("#table-result").isVisible());
    await page.reload();
    assert(await page.locator("#table-result").isVisible());
    await page.locator("#table-undo").tap();
    assert(await page.locator("#table-result").isHidden());
    // Damaged persisted data is ignored; a playable replacement is stored.
    await page.evaluate(() => TableGames.close());
    await page.evaluate(() =>
      localStorage.setItem(
        "zacai-table-sudoku-v1",
        '{"state":{"kind":"sudoku"}}',
      ),
    );
    await page.goto(base + "/games/?corrupt-test=1#sudoku");
    assert.equal(await page.locator(".sudoku-cell").count(), 81);
    assert(
      await page.evaluate(() =>
        TableGamesCore.validSudoku(
          JSON.parse(localStorage.getItem("zacai-table-sudoku-v1")).state,
        ),
      ),
    );
    await context.close();
    console.log(
      "Card and puzzle checks passed: touch, readable table, keypad, undo, notes, difficulty, autosave, offline resume, landscape, storage recovery.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
