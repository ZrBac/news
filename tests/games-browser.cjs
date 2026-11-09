// PLAYWRIGHT_MODULE=/path/to/playwright NEWS_BASE_URL=http://127.0.0.1:8765 node tests/games-browser.cjs
const { chromium, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const assert = require("node:assert/strict");
const base = process.env.NEWS_BASE_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    if (process.env.NEWS_LEGACY_SAFARI)
      await context.addInitScript(require("./legacy-safari.cjs"));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");
    await page.locator('header a[href="/games/"]').waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Prepare the game library once, before opening any individual game.
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    await context.setOffline(true);
    await page.goto(base + "/games/");
    await page.locator("#offline-status.ready").waitFor();
    assert.equal(await page.locator(".game-card").count(), 11);
    await page.screenshot({
      path: "/tmp/news-games-library.png",
      fullPage: true,
    });
    for (const kind of ["breakout", "shooter", "runner"]) {
      await page.locator(`a[href="#${kind}"]`).tap();
      await page.locator("#start-game").tap();
      await page.waitForTimeout(250);
      assert(await page.locator("#game-overlay").isHidden());
      const box = await page.locator("#game-canvas").boundingBox();
      const viewport = page.viewportSize();
      assert(box.width >= viewport.width * 0.96, "game must fill phone width");
      assert(
        box.height >= viewport.height * 0.8,
        "game must use at least 80% of phone height",
      );
      const scroll = await page.evaluate(() => scrollY);
      await page.touchscreen.tap(
        box.x + box.width * 0.6,
        box.y + box.height * 0.7,
      );
      await page.waitForTimeout(250);
      assert.equal(
        await page.evaluate(() => scrollY),
        scroll,
        "tapping the game must not scroll",
      );
      if (kind === "breakout" || kind === "shooter") {
        // Inspect controller calls at the engine boundary, then send real touch gestures.
        await page.evaluate(() => {
          const original = GamesCore.step;
          GamesCore.step = (state, dt, input, ...rest) => {
            window.lastControl = {
              kind: state.kind,
              x: state.paddle ?? state.player.x + 12,
              y: state.player?.y,
              input: { ...input },
              width: state.width,
            };
            return original(state, dt, input, ...rest);
          };
        });
        const session = await context.newCDPSession(page);
        const x = box.x + box.width * 0.25,
          y = box.y + box.height * 0.8;
        await page.waitForTimeout(50);
        const initial = await page.evaluate(() => window.lastControl.x);
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        await page.waitForTimeout(70);
        assert(
          Math.abs(
            (await page.evaluate(() => window.lastControl.x)) - initial,
          ) < 2,
          "touch down must not teleport the player",
        );
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + 50, y }],
        });
        await page.waitForTimeout(70);
        assert(
          (await page.evaluate(() => window.lastControl.x)) > initial + 20,
          "relative drag must move the player",
        );
        await session.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await session.detach();
      }
      await page.locator("#pause-game").tap();
      assert.equal(
        await page.locator("#overlay-title").innerText(),
        "休息一下",
      );
      const pausedScore = await page.locator("#score").innerText();
      await page.waitForTimeout(200);
      assert.equal(await page.locator("#score").innerText(), pausedScore);
      await page.locator("#start-game").tap();
      assert(await page.locator("#game-overlay").isHidden());
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.locator("#game-overlay").waitFor();
      assert.equal(
        await page.locator("#overlay-title").innerText(),
        "休息一下",
      );
      await page.locator("#restart-game").tap();
      if (kind === "shooter")
        await page.screenshot({
          path: "/tmp/news-games-shooter.png",
          fullPage: true,
        });
      if (kind === "runner") {
        await page.locator("#game-overlay").waitFor({ timeout: 10000 });
        assert.equal(
          await page.locator("#overlay-title").innerText(),
          "这一局结束了",
        );
        const score = Number(
          (await page.locator("#score").innerText()).match(/\d+/)[0],
        );
        assert(score > 0);
        await page.reload();
        await page.locator("#game-title").waitFor();
        assert.match(
          await page.locator("#record").innerText(),
          new RegExp(String(score)),
        );
      }
      await page.locator("#play .back").tap();
      await page.locator("#library").waitFor();
    }
    for (const path of ["/games/index.html", "/games"]) {
      await page.goto(base + path);
      await page.locator(".game-card").first().waitFor();
    }
    await context.setOffline(false);
    await page.goto(base + "/games/");
    for (const width of [320, 360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
    await page.goto(base + "/games/#shooter");
    await page.locator("#start-game").tap();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(
      () => document.querySelector("#overlay-title").textContent === "休息一下",
    );
    const landscape = await page.locator("#game-canvas").boundingBox();
    assert(
      landscape.width >= 820 && landscape.height >= 300,
      "landscape also fills the screen",
    );
    await page.locator("#help-game").tap();
    assert(await page.locator("#help-dialog").isVisible());
    await page.locator("#close-help").tap();
    await page.locator("#play .back").tap();
    await page.locator("#library").waitFor();
    assert(
      !(await page.evaluate(() => document.body.classList.contains("playing"))),
    );
    const keyboard = await browser.newPage();
    await keyboard.goto(base + "/games/#runner");
    await keyboard.locator("#start-game").click();
    await keyboard.keyboard.press("Space");
    await keyboard.keyboard.press("p");
    assert.equal(
      await keyboard.locator("#overlay-title").innerText(),
      "休息一下",
    );
    await keyboard.keyboard.press("p");
    assert(await keyboard.locator("#game-overlay").isHidden());
    // Storage denial does not prevent a round from starting.
    const privatePage = await browser.newPage();
    await privatePage.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new Error("Storage unavailable");
      };
      Storage.prototype.getItem = () => {
        throw new Error("Storage unavailable");
      };
    });
    await privatePage.goto(base + "/games/#breakout");
    await privatePage.locator("#start-game").click();
    assert(await privatePage.locator("#game-overlay").isHidden());
    assert(await privatePage.locator("#storage-notice").isVisible());
    assert.deepEqual(errors, []);
    console.log(
      "PASS: mobile entry, offline games after library preparation, all three arcade games offline, immersive portrait/landscape, relative drag without teleporting, touch, keyboard, pause/resume, visibility pause, restart, saved records, route aliases, five widths, denied storage.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
