// NEWS_LEGACY_SAFARI=1 PLAYWRIGHT_MODULE=/path/to/playwright NEWS_BASE_URL=http://127.0.0.1:8765 node tests/extra-games-browser.cjs
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
    if (process.env.NEWS_LEGACY_SAFARI)
      await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const saved = (kind) =>
      page.evaluate(
        (kind) => JSON.parse(localStorage.getItem(`zacai-extra-${kind}-v1`)),
        kind,
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
    await page.locator('a[href="#dungeon"]').tap();
    await page.locator(".dungeon-choice").first().tap();
    assert.equal((await saved("dungeon")).stage, "battle");
    assert.equal(await page.locator(".dungeon-card").count(), 5);
    await page.locator(".dungeon-card:not([disabled])").first().tap();
    assert((await saved("dungeon")).energy < 3);
    await page.locator("#dungeon-end").tap();
    assert.equal((await saved("dungeon")).turn, 2);
    const battle = await saved("dungeon");
    await page.reload();
    assert.deepEqual(await saved("dungeon"), battle);
    await page.locator("#dungeon-deck").tap();
    assert((await page.locator("#help-title").textContent()).includes("牌组"));
    await page.locator("#close-help").tap();
    await page.screenshot({ path: "/tmp/news-extra-dungeon.png" });
    await page.locator("#extra-new").tap();
    await page.locator("#extra-new-cancel").tap();
    assert.deepEqual(await saved("dungeon"), battle);
    // Play a complete seeded expedition through UI buttons, including every reward and camp transition.
    await page.evaluate(() => {
      ExtraGames.close();
      localStorage.setItem(
        "zacai-extra-dungeon-v1",
        JSON.stringify(ExtraGamesCore.dungeonCreate(9)),
      );
    });
    await page.goto(base + "/games/?expedition=1#dungeon");
    const outcome = await page.evaluate(() => {
      const C = ExtraGamesCore;
      let actions = 0;
      while (actions++ < 2000) {
        const s = JSON.parse(localStorage.getItem("zacai-extra-dungeon-v1"));
        if (["won", "lost"].includes(s.stage))
          return { stage: s.stage, floor: s.floor, actions };
        let node;
        const choices = document.querySelectorAll(".dungeon-choice"),
          cards = document.querySelectorAll(".dungeon-card");
        if (s.stage === "route") {
          let i = 0;
          s.offers.forEach((id, j) => {
            if (C.ENEMIES[id].hp < C.ENEMIES[s.offers[i]].hp) i = j;
          });
          node = choices[i];
        } else if (s.stage === "camp")
          node = choices[s.hp < s.maxHp - 14 ? 0 : 1];
        else if (s.stage === "relic") node = choices[1];
        else if (s.stage === "reward") {
          const order = [
            "venom",
            "riposte",
            "focus",
            "sweep",
            "heavy",
            "shield",
            "weaken",
            "mend",
            "quick",
            "recover",
          ];
          const best = s.rewards
            .map((id, i) => ({ i, rank: order.indexOf(id) }))
            .sort((a, b) => a.rank - b.rank)[0];
          node = s.hp < 20 ? choices[0] : cards[best.i];
        } else if (s.stage === "battle") {
          const intent = C.dungeonIntent(s),
            attack = ["attack", "heavy"].includes(intent.type)
              ? intent.amount
              : 0;
          const ranked = s.hand
            .map((id, i) => {
              const c = C.CARDS[id],
                damage =
                  (c.damage ? c.damage + s.power + s.battlePower : 0) *
                  (c.hits || 1);
              return {
                i,
                score:
                  c.cost > s.energy
                    ? -1
                    : damage +
                      Math.min(c.block || 0, Math.max(0, attack - s.block)) *
                        1.2 +
                      Math.min(c.heal || 0, s.maxHp - s.hp) * 1.5 +
                      (c.poison || 0) * (s.enemy.hp > 15 ? 2 : 0) +
                      (c.draw || 0) * (s.energy > 1 ? 3 : 0) +
                      (c.power || 0) * 5 +
                      (c.weak || 0) * 2,
              };
            })
            .sort((a, b) => b.score - a.score);
          node =
            ranked[0] && ranked[0].score > 0
              ? cards[ranked[0].i]
              : document.querySelector("#dungeon-end");
        }
        if (!node || node.disabled)
          throw new Error("Unavailable choice at " + s.stage);
        node.click();
      }
      throw new Error("Expedition did not finish");
    });
    assert.equal(outcome.stage, "won");
    assert.equal(outcome.floor, 12);
    assert(
      (await page.locator(".dungeon-result").textContent()).includes(
        "走出了地牢",
      ),
    );
    await page.locator("#extra-play .back").tap();
    await page.locator('a[href="#defense"]').tap();
    const tapTile = async (x, y) => {
      const box = await page.locator("#extra-canvas").boundingBox();
      await page.touchscreen.tap(
        box.x + ((x + 0.5) * box.width) / 9,
        box.y + ((y + 0.5) * box.height) / 9,
      );
    };
    await tapTile(4, 4);
    assert.equal((await saved("defense")).towers.length, 1);
    assert.equal((await saved("defense")).gold, 135);
    await page.locator("#defense-upgrade").tap();
    assert.equal((await saved("defense")).towers[0].level, 2);
    await page.locator("#defense-sell").tap();
    assert.equal((await saved("defense")).towers.length, 0);
    await page.locator('[data-tower="cannon"]').tap();
    await tapTile(5, 2);
    await page.locator('[data-tower="arrow"]').tap();
    await tapTile(3, 2);
    await page.locator("#defense-wave").tap();
    await page.waitForTimeout(900);
    await page.locator("#extra-pause").tap();
    const defending = await saved("defense");
    assert.equal(defending.wave, 1);
    assert(defending.enemies.length > 0);
    await page.waitForTimeout(250);
    assert.deepEqual(await saved("defense"), defending);
    await page.reload();
    assert(await page.locator("#extra-overlay").isVisible());
    assert.deepEqual(await saved("defense"), defending);
    await page.locator("#extra-resume").tap();
    await page.locator("#defense-speed").tap();
    assert((await page.locator("#defense-speed").textContent()).includes("2"));
    await page.screenshot({ path: "/tmp/news-extra-defense.png" });
    await page.setViewportSize({ width: 844, height: 390 });
    assert(await page.locator("#extra-overlay").isVisible());
    await page.screenshot({ path: "/tmp/news-extra-defense-wide.png" });
    await page.locator("#extra-play .back").tap();
    await page.setViewportSize({ width: 390, height: 664 });
    await page.locator('a[href="#blocks"]').tap();
    assert(await page.locator("#extra-overlay").isVisible());
    await page.locator("#extra-resume").tap();
    await page.locator('[data-block="left"]').tap();
    await page.locator("#extra-pause").tap();
    assert.equal((await saved("blocks")).piece.x, 2);
    await page.locator("#extra-resume").tap();
    await page.locator('[data-block="rotate"]').tap();
    await page.locator("#extra-pause").tap();
    assert.equal((await saved("blocks")).piece.rot, 1);
    await page.locator("#extra-resume").tap();
    await page.locator('[data-block="hold"]').tap();
    assert(await page.locator('[data-block="hold"]').isDisabled());
    await page.locator("#extra-pause").tap();
    assert((await saved("blocks")).held);
    await page.locator("#extra-resume").tap();
    const cdp = await context.newCDPSession(page),
      left = await page.locator('[data-block="left"]').boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: left.x + left.width / 2, y: left.y + left.height / 2, id: 1 },
      ],
    });
    await page.waitForTimeout(520);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.locator("#extra-pause").tap();
    const heldLeft = (await saved("blocks")).piece.x;
    assert(heldLeft <= 0, "holding a direction repeats movement");
    await page.locator("#extra-resume").tap();
    const field = await page.locator("#extra-canvas").boundingBox(),
      x = field.x + field.width * 0.3,
      y = field.y + field.height * 0.5;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + field.width * 0.25, y, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.locator("#extra-pause").tap();
    assert((await saved("blocks")).piece.x > heldLeft);
    await page.locator("#extra-resume").tap();
    await page.locator('[data-block="drop"]').tap();
    await page.locator("#extra-pause").tap();
    const dropped = await saved("blocks");
    assert.equal(dropped.pieces, 1);
    assert(dropped.score > 0);
    await page.reload();
    assert.deepEqual(await saved("blocks"), dropped);
    assert(await page.locator("#extra-overlay").isVisible());
    await page.locator("#extra-resume").tap();
    await page.locator("#extra-help").tap();
    assert((await page.locator("#help-text").textContent()).includes("暂存"));
    await page.locator("#close-help").tap();
    assert(await page.locator("#extra-overlay").isVisible());
    await page.locator("#extra-resume").tap();
    await page.screenshot({ path: "/tmp/news-extra-blocks.png" });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("p");
    assert(await page.locator("#extra-overlay").isVisible());
    for (const [width, height] of [
      [320, 568],
      [390, 664],
      [844, 390],
      [1024, 768],
    ]) {
      await page.setViewportSize({ width, height });
      // Viewport emulation returns before resize events and the next layout frame.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const layout = await page.evaluate(() => {
        const c = document
            .querySelector("#extra-canvas")
            .getBoundingClientRect(),
          controls = document
            .querySelector("#blocks-controls")
            .getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          canvas: c.toJSON(),
          controls: controls.toJSON(),
        };
      });
      assert(!layout.overflow);
      assert(layout.canvas.bottom <= height);
      assert(layout.controls.bottom <= height);
      assert(
        layout.canvas.height >= height * 0.5,
        "board remains large enough",
      );
    }
    await page.screenshot({ path: "/tmp/news-extra-blocks-wide.png" });
    // A valid final-wave save is recognized as a victory after resuming.
    await page.evaluate(() => {
      ExtraGames.close();
      const s = ExtraGamesCore.defenseCreate();
      s.wave = 12;
      s.phase = "wave";
      localStorage.setItem("zacai-extra-defense-v1", JSON.stringify(s));
    });
    await page.goto(base + "/games/?final-wave=1#defense");
    await page.locator("#extra-resume").tap();
    await page.waitForFunction(() =>
      document
        .querySelector("#extra-overlay-title")
        .textContent.includes("十二波"),
    );
    assert.equal((await saved("defense")).phase, "won");
    await page.reload();
    assert(
      (await page.locator("#extra-overlay-title").textContent()).includes(
        "十二波",
      ),
    );
    await page.locator("#extra-new").tap();
    await page.locator("#extra-new-confirm").tap();
    assert.equal((await saved("defense")).wave, 0);
    // The new router still opens the existing card and arcade games.
    await page.locator("#extra-play .back").tap();
    await page.locator('a[href="#spider"]').tap();
    assert.equal(await page.locator(".spider-column").count(), 10);
    await page.locator("#table-play .back").tap();
    await page.locator('a[href="#breakout"]').tap();
    await page.locator("#start-game").tap();
    assert(await page.locator("#extra-play").isHidden());
    assert.deepEqual(errors, []);
    await context.setOffline(false);
    const denied = await browser.newContext({ ...devices["iPhone 13"] });
    await denied.addInitScript(() => {
      Storage.prototype.setItem = function () {
        throw new Error("denied");
      };
    });
    const dp = await denied.newPage();
    await dp.goto(base + "/games/#defense");
    assert(
      (await dp.locator("#extra-save").textContent()).includes("不允许存档"),
    );
    await dp.locator("#extra-play .back").tap();
    await dp.locator('a[href="#dungeon"]').tap();
    await dp.locator(".dungeon-choice").first().tap();
    await dp.locator("#extra-play .back").tap();
    await dp.locator('a[href="#dungeon"]').tap();
    assert(await dp.locator("#dungeon-end").isVisible());
    await denied.close();
    await page.evaluate(() => {
      ExtraGames.close();
      localStorage.setItem("zacai-extra-blocks-v1", '{"kind":"blocks"}');
    });
    await page.goto(base + "/games/?damaged=1#blocks");
    assert.equal((await saved("blocks")).pieces, 0);
    assert(
      await page.evaluate(() =>
        ExtraGamesCore.validBlocks(
          JSON.parse(localStorage.getItem("zacai-extra-blocks-v1")),
        ),
      ),
    );
    console.log(
      "PASS: all three games offline, full dungeon expedition through UI, tower controls and terminal states, touch and held block controls, pause/resize, saved progress, legacy dialogs, storage recovery.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
