(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const C = window.GamesCore;
  const games = {
    breakout: {
      title: "打砖块",
      instructions:
        "在画面任意位置左右滑动，挡板跟随移动；电脑用 ← →。打完五关获胜。",
      note: "接住弹球，别让它落下。",
    },
    shooter: {
      title: "飞机大战",
      instructions:
        "在画面任意位置拖动，飞机跟随手指的位移，自动开火。别让敌机飞出底部。",
      note: "躲开敌机，守住三次机会。",
    },
    runner: {
      title: "跳跃跑酷",
      instructions: "点画面或按空格跳跃，空中可再跳一次。",
      note: "看准障碍，点一下就起跳。",
    },
  };
  const canvas = $("#game-canvas"),
    ctx = canvas.getContext("2d");
  let kind,
    state,
    phase = "ready",
    frame,
    last = 0,
    accumulator = 0;
  let input = {},
    keys = new Set(),
    pointer = null;
  let world = { width: C.W, height: C.H },
    renderScale = 2,
    dragStart = null;
  const recordsKey = "zacai-arcade-records-v1";
  let records = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(recordsKey) || "{}");
    for (const key of Object.keys(games))
      if (Number.isSafeInteger(parsed?.[key]) && parsed[key] >= 0)
        records[key] = parsed[key];
    const theme = localStorage.getItem("zrbac-news-theme");
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
  } catch {
    $("#storage-notice").hidden = false;
  }
  function saveRecord() {
    if (!state) return;
    records[kind] = Math.max(records[kind] || 0, state.score);
    try {
      localStorage.setItem(recordsKey, JSON.stringify(records));
    } catch {
      $("#storage-notice").hidden = false;
    }
  }
  function hud() {
    $("#score").textContent = "得分 " + state.score;
    $("#record").textContent =
      "最高 " + Math.max(records[kind] || 0, state.score);
  }
  function stop() {
    cancelAnimationFrame(frame);
    keys.clear();
    input = {};
    pointer = null;
  }
  function showOverlay(title, note, button) {
    $("#game-overlay").hidden = false;
    $("#overlay-title").textContent = title;
    $("#overlay-note").textContent = note;
    $("#start-game").textContent = button;
    $("#restart-game").hidden = phase !== "paused";
    $("#pause-game").disabled = true;
  }
  function pause() {
    if (phase !== "running") return;
    phase = "paused";
    stop();
    saveRecord();
    showOverlay("休息一下", "回来后从这里继续。", "继续游戏");
    $("#game-status").textContent = "游戏已暂停";
  }
  function start(fresh = false) {
    if (!state || !ctx) return;
    if (fresh || phase === "over") state = C.create(kind, world);
    phase = "running";
    input = {};
    keys.clear();
    last = 0;
    accumulator = 0;
    $("#game-overlay").hidden = true;
    $("#pause-game").disabled = false;
    $("#game-status").textContent = "";
    canvas.focus({ preventScroll: true });
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }
  function route() {
    saveRecord();
    stop();
    window.TableGames.close();
    window.ExtraGames.close();
    window.CasualGames.close();
    kind = location.hash.slice(1);
    if (["jump", "match", "mines"].includes(kind)) {
      state = null;
      $("#library").hidden = true;
      $("#play").hidden = true;
      document.body.classList.add("playing");
      window.CasualGames.open(kind);
      return;
    }
    if (["dungeon", "defense", "blocks"].includes(kind)) {
      state = null;
      $("#library").hidden = true;
      $("#play").hidden = true;
      document.body.classList.add("playing");
      window.ExtraGames.open(kind);
      return;
    }
    if (["spider", "sudoku"].includes(kind)) {
      state = null;
      $("#library").hidden = true;
      $("#play").hidden = true;
      document.body.classList.add("playing");
      window.TableGames.open(kind);
      return;
    }
    const game = games[kind];
    $("#library").hidden = !!game;
    $("#play").hidden = !game;
    document.body.classList.toggle("playing", !!game);
    phase = "ready";
    state = null;
    if (!game) return;
    sizeCanvas();
    state = C.create(kind, world);
    $("#help-title").textContent = game.title + " · 玩法";
    $("#help-text").textContent = game.instructions;
    $("#game-title").textContent = game.title;
    $("#instructions").textContent = game.instructions;
    canvas.setAttribute(
      "aria-label",
      game.title + "游戏画面。" + game.instructions,
    );
    $("#game-status").textContent = "";
    showOverlay(
      ctx ? "准备好了吗？" : "暂不支持游戏画面",
      ctx ? game.instructions : "请使用支持 Canvas 的浏览器。",
      "开始游戏",
    );
    $("#start-game").disabled = !ctx;
    hud();
    draw();
  }
  function sizeCanvas() {
    if ($("#play").hidden) return;
    document.documentElement.style.setProperty(
      "--play-height",
      (window.visualViewport?.height || innerHeight) + "px",
    );
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / C.W, box.height / C.H);
    const next = { width: box.width / scale, height: box.height / scale };
    if (
      state &&
      (Math.abs(next.width - world.width) > 1 ||
        Math.abs(next.height - world.height) > 1)
    ) {
      pause();
      C.resize(state, next.width, next.height);
    }
    world = next;
    const ratio = Math.min(devicePixelRatio || 1, 3);
    renderScale = ratio * scale;
    const width = Math.round(box.width * ratio),
      height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw();
  }
  function act() {
    C.action(state);
    if (state.event) $("#game-status").textContent = state.event;
    hud();
    draw();
  }
  function tick(time) {
    if (phase !== "running") return;
    if (!last) last = time;
    accumulator += Math.min((time - last) / 1000, 0.08);
    last = time;
    input.dx =
      Number(keys.has("ArrowRight") || keys.has("d")) -
      Number(keys.has("ArrowLeft") || keys.has("a"));
    input.dy =
      Number(keys.has("ArrowDown") || keys.has("s")) -
      Number(keys.has("ArrowUp") || keys.has("w"));
    while (accumulator >= 1 / 120 && !state.ended) {
      C.step(state, 1 / 120, input);
      accumulator -= 1 / 120;
      if (state.event) $("#game-status").textContent = state.event;
    }
    hud();
    draw();
    if (state.ended) {
      phase = "over";
      stop();
      saveRecord();
      showOverlay(
        state.won ? "五关全通！" : "这一局结束了",
        "得分 " + state.score + " · 最高 " + records[kind],
        "再玩一次",
      );
      $("#game-status").textContent = state.won
        ? "恭喜通关！"
        : "游戏结束，得分 " + state.score;
    } else frame = requestAnimationFrame(tick);
  }
  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  function text(value, x, y, color, size = 12) {
    ctx.fillStyle = color;
    ctx.font = `600 ${size}px -apple-system, sans-serif`;
    ctx.fillText(value, x, y);
  }
  function plane(x, y, enemy = false) {
    ctx.fillStyle = enemy ? "#db9972" : "#a3ded2";
    ctx.beginPath();
    if (enemy) {
      ctx.moveTo(x + 13, y + 28);
      ctx.lineTo(x, y + 3);
      ctx.lineTo(x + 13, y + 10);
      ctx.lineTo(x + 26, y + 3);
    } else {
      ctx.moveTo(x + 12, y);
      ctx.lineTo(x + 24, y + 27);
      ctx.lineTo(x + 12, y + 21);
      ctx.lineTo(x, y + 27);
    }
    ctx.closePath();
    ctx.fill();
  }
  function draw() {
    if (!ctx || !state) return;
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    const s = state,
      W = s.width,
      H = s.height,
      ground = H - 90;
    if (kind === "breakout") {
      rect(0, 0, W, H, "#f2eadc");
      text("第 " + s.level + " / 5 关", 16, 24, "#7f6d57");
      text("机会 " + s.lives, W - 73, 24, "#7f6d57");
      const colors = ["#b86e58", "#cc8561", "#d69b6d", "#d5b27e", "#a6b198"];
      for (const b of s.bricks)
        if (b.hp) {
          rect(b.x, b.y, b.w, b.h, colors[b.row]);
          if (b.hp > 1) rect(b.x + 3, b.y + 3, b.w - 6, 2, "#fff8");
        }
      rect(s.paddle - 38, H - 61, 76, 9, "#65584b");
      ctx.fillStyle = "#65584b";
      ctx.beginPath();
      ctx.arc(s.ball.x, s.ball.y, s.ball.r, 0, Math.PI * 2);
      ctx.fill();
      rect(16, H - 20, W - 32, 1, "#ded3c0");
    } else if (kind === "shooter") {
      rect(0, 0, W, H, "#14232d");
      for (let i = 0; i < Math.ceil((W * H) / 3680); i++)
        rect(
          (i * 79 + 31) % W,
          (i * 47 + s.time * (12 + (i % 3) * 8)) % H,
          i % 3 ? 1 : 2,
          2,
          i % 3 ? "#405562" : "#799aab",
        );
      text("第 " + s.level + " 波", 16, 24, "#9cb1bd");
      text("防线 " + Math.max(0, s.lives), W - 73, 24, "#9cb1bd");
      for (const b of s.bullets) rect(b.x, b.y, b.w, b.h, "#d1eee2");
      for (const e of s.enemies) {
        plane(e.x, e.y, true);
        if (e.hp > 1) rect(e.x + 10, e.y + 4, 6, 3, "#ffe3b3");
      }
      if (s.invincible <= 0 || Math.floor(s.time * 12) % 2 === 0)
        plane(s.player.x, s.player.y);
      if (s.invincible > 0) {
        ctx.strokeStyle = "#a3ded266";
        ctx.beginPath();
        ctx.arc(s.player.x + 12, s.player.y + 14, 23, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (kind === "runner") {
      rect(0, 0, W, H, "#f3e5c9");
      ctx.fillStyle = "#e2bd81";
      ctx.beginPath();
      ctx.arc(W - 75, 90, 30, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < Math.ceil(W / 130) + 2; i++) {
        const x = ((((i * 130 - s.distance * 0.15) % 650) + 650) % 650) - 130;
        ctx.fillStyle = "#e6cfaa";
        ctx.beginPath();
        ctx.moveTo(x - 90, ground);
        ctx.lineTo(x + 40, ground - 125 + (i % 2) * 25);
        ctx.lineTo(x + 170, ground);
        ctx.fill();
      }
      rect(0, ground, W, 90, "#d6b48b");
      rect(0, ground, W, 3, "#a77c54");
      for (let i = 0; i < 15; i++)
        rect(
          ((((i * 41 - s.distance) % 615) + 615) % 615) - 30,
          ground + 20 + (i % 3) * 15,
          10,
          2,
          "#c09b70",
        );
      for (const o of s.obstacles) {
        rect(o.x, o.y, o.w, o.h, "#a16d4f");
        rect(o.x + 4, o.y + 4, 3, o.h - 8, "#c99468");
      }
      const p = s.player;
      rect(p.x, p.y, p.w, p.h - 3, "#496a70");
      rect(p.x + 16, p.y + 6, 4, 4, "#fff7e6");
      const stride = s.jumps ? 0 : (Math.floor(s.time * 12) % 2) * 5;
      rect(p.x + 2, p.y + 22, 6, 6 + stride, "#39555c");
      rect(p.x + 16, p.y + 22, 6, 11 - stride, "#39555c");
      text("距离 " + Math.floor(s.distance / 10) + " m", 16, 24, "#947b58");
      text(
        s.jumps === 1 ? "还能再跳" : s.jumps === 2 ? "等待落地" : "二段跳就绪",
        W - 90,
        24,
        "#947b58",
        11,
      );
    }
    for (const p of s.particles) {
      ctx.globalAlpha = p.life / 0.4;
      rect(p.x, p.y, 3, 3, p.color);
    }
    ctx.globalAlpha = 1;
  }
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * world.width) / r.width,
      y: ((e.clientY - r.top) * world.height) / r.height,
    };
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (phase !== "running" || pointer !== null) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    pointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    if (kind === "runner") act();
    else {
      dragStart = {
        x: p.x,
        y: p.y,
        playerX:
          kind === "breakout"
            ? state.paddle
            : state.player.x + state.player.w / 2,
        playerY: state.player ? state.player.y + state.player.h / 2 : 0,
      };
      input.x = dragStart.playerX;
      if (kind === "shooter") input.y = dragStart.playerY;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (
      phase !== "running" ||
      pointer !== e.pointerId ||
      !["breakout", "shooter"].includes(kind) ||
      !dragStart
    )
      return;
    const p = point(e);
    input.x = C.clamp(
      dragStart.playerX + p.x - dragStart.x,
      kind === "breakout" ? 39 : 16,
      world.width - (kind === "breakout" ? 39 : 16),
    );
    if (kind === "shooter")
      input.y = C.clamp(
        dragStart.playerY + p.y - dragStart.y,
        179,
        world.height - 22,
      );
    // Rebase after each movement so dragging back from an edge responds immediately.
    dragStart = { x: p.x, y: p.y, playerX: input.x, playerY: input.y || 0 };
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    canvas.addEventListener(type, (e) => {
      if (pointer === e.pointerId) pointer = null;
    });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if (
      !state ||
      $("#info-dialog").open ||
      $("#help-dialog").open ||
      /^(INPUT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName)
    )
      return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "a",
        "d",
        "w",
        "s",
        " ",
        "p",
        "Escape",
        "Enter",
      ].includes(key)
    )
      return;
    e.preventDefault();
    if (key === "p" || key === "Escape") {
      if (!e.repeat) {
        if (phase === "running") pause();
        else if (phase === "paused") start();
      }
      return;
    }
    if (phase !== "running") return;
    delete input.x;
    delete input.y;
    keys.add(key);
    if (
      kind === "runner" &&
      [" ", "ArrowUp", "w", "Enter"].includes(key) &&
      !e.repeat
    )
      act();
  });
  document.addEventListener("keyup", (e) =>
    keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key),
  );
  $("#start-game").addEventListener("click", () => start());
  $("#restart-game").addEventListener("click", () => start(true));
  $("#pause-game").addEventListener("click", pause);
  $("#install-app").addEventListener("click", pause);
  $("#close-dialog").addEventListener("click", () => $("#info-dialog").close());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("blur", pause);
  window.addEventListener("pagehide", () => {
    pause();
    saveRecord();
  });
  $("#help-game").addEventListener("click", () => {
    pause();
    $("#help-dialog").showModal();
  });
  $("#close-help").addEventListener("click", () => $("#help-dialog").close());
  new ResizeObserver(sizeCanvas).observe($("#stage"));
  window.visualViewport?.addEventListener("resize", sizeCanvas);
  window.addEventListener("resize", sizeCanvas);
  window.addEventListener("hashchange", route);
  route();
})();
