(() => {
  "use strict";
  const C = window.CasualGamesCore,
    $ = (s) => document.querySelector(s);
  const titles = { jump: "跳一跳", match: "消消乐", mines: "扫雷" };
  const help = {
    jump: "按住画面或下方按钮蓄力，松手跳向下一座台；按得越久，跳得越远。落在台上得 1 分，正中圆心有额外加分，连续命中加分更多。画面会显示前后平台，“下一台”是本次目标；后面两座台会依次成为目标。蓄力条满后保持最大力度，不会自动起跳。电脑长按空格再松开。P 或 Escape 暂停，切换页面也会暂停；未完成的蓄力会取消。",
    match:
      "先点一个方块，再点相邻方块交换；也可向相邻格滑动。横向或纵向至少三个同色方块会消除，掉落后可连续消除。每格基础 10 分，连续消除有倍数奖励。每关 28 步，达到目标即可进入下一关；无效交换不扣步。提示免费，主动重排扣 2 步；没有合法交换时自动免费重排。形状不同也能帮助区分颜色。",
    mines:
      "点格子翻开，数字表示周围八格中的地雷数。第一次翻开及周围格子保证安全。长按未翻开的格子插旗，也可切换“插旗模式”；电脑右键或 F 键插旗。已翻开的数字周围插旗数等于数字时，再点数字会打开其余邻格，插错旗可能踩雷。翻开全部安全格即获胜。计时只统计本页实际游玩的时间。随机棋盘不保证全程无需猜测。",
  };
  const memory = new Map(),
    validators = {
      jump: C.validJump,
      match: C.validMatch,
      mines: C.validMines,
    };
  const canvas = $("#casual-canvas"),
    ctx = canvas.getContext("2d"),
    grid = $("#casual-grid");
  let kind = null,
    state = null,
    paused = true,
    frame = 0,
    last = 0,
    width = 0,
    height = 0,
    ratio = 1,
    camera = null,
    chargePointer = null,
    selected = -1,
    focusCell = 0,
    flagMode = false,
    gesture = null,
    longTimer = 0,
    busy = false,
    animation = 0,
    hints = [],
    best = 0,
    timer = 0;
  const text = (id, value) => {
    const n = $(id);
    if (n.textContent !== String(value)) n.textContent = value;
  };
  const say = (value) => text("#casual-message", value);
  const fresh = () =>
    kind === "jump"
      ? C.jumpCreate()
      : kind === "match"
        ? C.matchCreate()
        : C.mineCreate($("#casual-level").value);
  const over = () =>
    state &&
    (kind === "jump"
      ? state.phase === "over"
      : kind === "match"
        ? state.phase !== "playing"
        : state.phase !== "playing");
  function save() {
    if (!kind || !state) return;
    memory.set(kind, C.clone(state));
    if (kind === "jump") best = Math.max(best, state.score);
    try {
      localStorage.setItem(`zacai-casual-${kind}-v1`, JSON.stringify(state));
      if (kind === "jump")
        localStorage.setItem("zacai-jump-best-v1", String(best));
      text("#casual-save", "进度自动保存在本机");
    } catch {
      text("#casual-save", "浏览器未允许存档，关闭页面后进度会丢失");
    }
  }
  function restore() {
    let value = memory.get(kind);
    try {
      if (!value)
        value = JSON.parse(localStorage.getItem(`zacai-casual-${kind}-v1`));
      const record = Number(localStorage.getItem("zacai-jump-best-v1"));
      if (Number.isSafeInteger(record) && record >= 0) best = record;
    } catch {}
    state = validators[kind](value) ? C.clone(value) : fresh();
    if (kind === "jump") {
      C.jumpPrepare(state);
      C.jumpCancel(state);
    }
    save();
  }
  function hud() {
    if (!state) return;
    const parts =
      kind === "jump"
        ? [
            `得分 ${state.score}`,
            `跳过 ${state.jumps} 台`,
            `最高 ${Math.max(best, state.score)}`,
          ]
        : kind === "match"
          ? [
              `第 ${state.level} 关`,
              `目标 ${state.roundScore} / ${state.target}`,
              `剩余 ${state.moves} 步`,
            ]
          : [
              C.MINE_LEVELS[state.level].name,
              `剩余雷 ${state.mines - state.flags.filter(Boolean).length}`,
              `用时 ${Math.floor(state.seconds)} 秒`,
            ];
    const box = $("#casual-hud");
    if (box.textContent !== parts.join("")) {
      box.replaceChildren(
        ...parts.map((p) => {
          const span = document.createElement("span");
          span.textContent = p;
          return span;
        }),
      );
    }
    $("#match-shuffle").disabled = busy || over() || state.moves < 3;
    $("#match-hint").disabled = busy || over();
    $("#mine-mode").disabled = over();
    $("#mine-mode").setAttribute("aria-pressed", String(flagMode));
    text("#mine-mode", flagMode ? "插旗模式" : "翻开模式");
    const result = $("#casual-result");
    result.hidden = !over() || kind === "jump" || busy;
    if (!result.hidden) {
      text(
        "#casual-result-title",
        kind === "match"
          ? state.phase === "clear"
            ? "这一关过了！"
            : "步数用完了"
          : state.phase === "won"
            ? "全部排除了！"
            : "踩到地雷了",
      );
      text(
        "#casual-result-note",
        kind === "match"
          ? `本关 ${state.roundScore} 分 · 累计 ${state.score} 分`
          : `用时 ${Math.floor(state.seconds)} 秒`,
      );
      text(
        "#casual-result-action",
        kind === "match" && state.phase === "clear" ? "下一关" : "再来一局",
      );
    }
    $("#jump-charge").disabled = paused || over() || state.phase === "flying";
    $("#casual-pause").disabled = over();
    if (kind === "jump") {
      $("#jump-meter-fill").style.width = (state.charge / 1.3) * 100 + "%";
      $("#jump-meter").setAttribute(
        "aria-valuenow",
        String(Math.round((state.charge / 1.3) * 100)),
      );
    }
  }
  const shapes = [
    '<circle cx="20" cy="20" r="16"/>',
    '<path d="m20 2 5.5 11.5L38 15.5l-9 9 2 13-11-6-11 6 2-13-9-9 12.5-2Z"/>',
    '<path d="m20 5 16 29H4Z"/>',
    '<rect x="5" y="5" width="30" height="30" rx="1"/>',
    '<path d="M14 3h12v11h11v12H26v11H14V26H3V14h11Z"/>',
    '<path d="M20 36C15 31 3 23 3 13 3 3 16 1 20 10 24 1 37 3 37 13c0 10-12 18-17 23Z"/>',
  ];
  const shapeNames = ["圆形", "星形", "三角", "方形", "十字", "心形"];
  function renderGrid(board = state.board, removed = []) {
    const count = state.board.length;
    if (grid.children.length !== count) {
      grid.replaceChildren();
      for (let i = 0; i < count; i++) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.cell = i;
        b.className = "casual-cell";
        grid.append(b);
      }
    }
    grid.style.setProperty("--columns", kind === "match" ? 7 : state.w);
    grid.setAttribute(
      "aria-label",
      kind === "match" ? "交换方块的消消乐棋盘" : "扫雷棋盘",
    );
    const gone = new Set(removed);
    [...grid.children].forEach((b, i) => {
      b.tabIndex = i === focusCell ? 0 : -1;
      b.className = "casual-cell";
      b.disabled = false;
      b.removeAttribute("aria-pressed");
      if (kind === "match") {
        b.classList.add("gem", "gem-" + board[i]);
        b.classList.toggle("selected", i === selected);
        b.classList.toggle("hinted", hints.includes(i));
        b.classList.toggle("clearing", gone.has(i));
        const shape = String(board[i]);
        if (b.dataset.shape !== shape) {
          b.innerHTML =
            '<svg viewBox="0 0 40 40" aria-hidden="true">' +
            shapes[board[i]] +
            "</svg>";
          b.dataset.shape = shape;
        }
        b.setAttribute(
          "aria-label",
          `第 ${Math.floor(i / 7) + 1} 行第 ${(i % 7) + 1} 列，${shapeNames[board[i]]}`,
        );
        b.setAttribute("aria-pressed", String(i === selected));
      } else {
        delete b.dataset.shape;
        const show = state.open[i],
          mine = state.board[i] === -1,
          ended = over(),
          flag = state.flags[i];
        b.classList.toggle("revealed", show);
        b.classList.toggle("flagged", flag);
        b.classList.toggle("hit", state.hit === i);
        b.classList.toggle("mine", ended && mine);
        b.classList.toggle("wrong", ended && flag && !mine);
        b.textContent =
          ended && mine
            ? "●"
            : flag
              ? "旗"
              : show && state.board[i] > 0
                ? String(state.board[i])
                : "";
        if (ended && flag && !mine) b.textContent = "×";
        b.dataset.number = show ? state.board[i] : "";
        b.setAttribute(
          "aria-label",
          `第 ${Math.floor(i / state.w) + 1} 行第 ${(i % state.w) + 1} 列，${ended && mine ? "地雷" : flag ? "已插旗" : show ? state.board[i] || "空白" : "未翻开"}`,
        );
      }
    });
  }
  function mineAct(i, flag = false) {
    if (kind !== "mines" || busy || document.querySelector("dialog[open]"))
      return;
    const ok = flag ? C.mineFlag(state, i) : C.mineReveal(state, i);
    if (ok) {
      save();
      renderGrid();
      hud();
      say(
        over()
          ? state.phase === "won"
            ? "全部安全格已翻开。"
            : "红色格是踩中的地雷。"
          : flag
            ? "旗帜已更新。"
            : "数字表示周围地雷数；长按可插旗。",
      );
    } else if (flag && !state.flags[i] && !state.open[i])
      say("旗帜已用完，请先检查已有标记。");
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function swap(a, b) {
    const result = C.matchSwap(state, a, b);
    selected = -1;
    hints = [];
    if (!result) {
      renderGrid();
      say("这一步不能组成三连，不扣步数。");
      return;
    }
    save();
    busy = true;
    hud();
    const token = ++animation;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const first = result.frames[0],
      gain = result.frames.reduce((total, step) => total + step.gain, 0);
    // Mark the first match without fading or resizing any tile. Apply the
    // settled cascade once instead of flashing through every intermediate board.
    if (!reduced) {
      renderGrid(first.board, first.removed);
      await wait(320);
    }
    if (token !== animation || kind !== "match") return;
    busy = false;
    renderGrid();
    hud();
    say(
      `${result.frames.length > 1 ? result.frames.length + " 连消 · " : ""}+${gain} 分${result.reshuffled ? "，已自动免费重排。" : ""}`,
    );
  }
  function matchAct(i) {
    if (kind !== "match" || busy || over()) return;
    focusCell = i;
    if (selected === i) {
      selected = -1;
      renderGrid();
      return;
    }
    if (
      selected >= 0 &&
      Math.abs((selected % 7) - (i % 7)) +
        Math.abs(Math.floor(selected / 7) - Math.floor(i / 7)) ===
        1
    ) {
      swap(selected, i);
      return;
    }
    selected = i;
    hints = [];
    renderGrid();
    say("再点一个相邻方块交换。");
  }
  function overlay() {
    if (kind !== "jump") return;
    const show = paused || over();
    $("#casual-overlay").hidden = !show;
    text(
      "#casual-overlay-title",
      over()
        ? "这次跳了 " + state.jumps + " 台"
        : state.jumps || state.phase === "flying"
          ? "休息一下"
          : "准备起跳",
    );
    text(
      "#casual-overlay-note",
      over()
        ? `得分 ${state.score} · 最高 ${Math.max(best, state.score)}`
        : "按住蓄力，松开跳跃。",
    );
    text(
      "#casual-resume",
      over()
        ? "再来一局"
        : state.jumps || state.phase === "flying"
          ? "继续游戏"
          : "开始游戏",
    );
  }
  function jumpView() {
    const platforms = [
      ...state.trail,
      state.current,
      state.target,
      ...state.upcoming,
    ];
    const minX = Math.min(...platforms.map((p) => p.x - p.r)) - 18,
      maxX = Math.max(...platforms.map((p) => p.x + p.r)) + 18,
      minY = Math.min(...platforms.map((p) => (p.y - p.r) * 0.54)) - 55,
      maxY = Math.max(...platforms.map((p) => (p.y + p.r) * 0.54)) + 32;
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2 / 0.54,
      scale: Math.min(width / (maxX - minX), height / (maxY - minY), 1.45),
    };
  }
  function moveCamera(dt) {
    const next = jumpView();
    if (!camera) {
      camera = next;
      return;
    }
    const amount = 1 - Math.exp(-dt * 5);
    for (const key of ["x", "y", "scale"])
      camera[key] += (next[key] - camera[key]) * amount;
  }
  function draw() {
    if (kind !== "jump" || !ctx || !width || !height) return;
    if (!camera) camera = jumpView();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#edf0e6";
    ctx.fillRect(0, 0, width, height);
    const scale = camera.scale;
    const project = (p) => ({
      x: width / 2 + (p.x - camera.x) * scale,
      y: height / 2 + (p.y - camera.y) * scale * 0.54,
    });
    const platforms = [
      ...state.trail.map((p, i) => ({
        ...p,
        role: "past",
        number: state.jumps - state.trail.length + i + 1,
      })),
      { ...state.current, role: "current", number: state.jumps + 1 },
      { ...state.target, role: "next", number: state.jumps + 2 },
      ...state.upcoming.map((p, i) => ({
        ...p,
        role: "future",
        number: state.jumps + i + 3,
      })),
    ];
    // A quiet path shows the order; future platforms are actual saved targets.
    ctx.strokeStyle = "#c5ceba";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3 * scale, 7 * scale]);
    ctx.beginPath();
    platforms.forEach((p, i) => {
      const q = project(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    platforms
      .slice()
      .sort((a, b) => a.y - b.y)
      .forEach((p) => {
        const q = project(p),
          r = p.r * scale,
          next = p.role === "next",
          past = p.role === "past";
        ctx.fillStyle = next ? "#788f73" : past ? "#b9c1af" : "#9ca78e";
        ctx.beginPath();
        ctx.ellipse(q.x, q.y + 17 * scale, r, r * 0.54, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(q.x - r, q.y, 2 * r, 17 * scale);
        ctx.fillStyle = next
          ? "#c9d9a4"
          : past
            ? "#e1e5d8"
            : p.role === "current"
              ? "#e2dec1"
              : "#dbe2cb";
        ctx.beginPath();
        ctx.ellipse(q.x, q.y, r, r * 0.54, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = next ? "#657f54" : past ? "#c4cbb9" : "#a1ae8e";
        ctx.lineWidth = next ? 2 : 1;
        ctx.stroke();
        if (next) {
          ctx.fillStyle = "#839e5c";
          ctx.beginPath();
          ctx.ellipse(q.x, q.y, r * 0.24, r * 0.13, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.font = `${Math.max(10, 11 * scale)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = past ? "#778570" : "#f8faef";
        ctx.fillText(String(p.number), q.x, q.y + r * 0.4 + 13 * scale);
      });
    const p = project(state.player),
      t = state.phase === "flying" ? state.elapsed / 0.65 : 0,
      lift = Math.sin(t * Math.PI) * 95 * scale;
    ctx.fillStyle = "rgba(35,55,49,.17)";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 12 * scale, 5 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    const compress =
      state.phase === "charging" ? (state.charge / 1.3) * 8 * scale : 0;
    const top = p.y - lift - 34 * scale + compress;
    ctx.fillStyle = "#36574c";
    ctx.fillRect(
      p.x - 8 * scale,
      top + 12 * scale,
      16 * scale,
      22 * scale - compress,
    );
    ctx.beginPath();
    ctx.arc(p.x, top + 7 * scale, 10 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f7f1d2";
    ctx.beginPath();
    ctx.arc(p.x + 3 * scale, top + 5 * scale, 2 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#61735f";
    ctx.font = `${Math.max(12, 13 * scale)}px sans-serif`;
    ctx.textAlign = "center";
    const target = project(state.target);
    ctx.fillText(
      "下一台 · " + (state.jumps + 2),
      target.x,
      target.y - state.target.r * 0.54 * scale - 15 * scale,
    );
  }
  function resize() {
    if (!kind) return;
    const nextHeight = window.visualViewport?.height || innerHeight;
    document.documentElement.style.setProperty(
      "--casual-height",
      nextHeight + "px",
    );
    if (kind !== "jump") return;
    const area = $("#casual-jump-area"),
      w = area.clientWidth,
      h = area.clientHeight;
    if (
      width &&
      (Math.abs(width - w) > 1 || Math.abs(height - h) > 1) &&
      !paused
    )
      pause();
    width = w;
    height = h;
    ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    camera = jumpView();
    draw();
  }
  function tick(time) {
    if (kind !== "jump" || paused) return;
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 0;
    last = time;
    const previousTarget = { ...state.target };
    const landed = C.jumpStep(state, dt);
    if (landed && state.phase === "ready" && camera) {
      camera.x -= previousTarget.x;
      camera.y -= previousTarget.y;
    }
    moveCamera(dt);
    if (landed) {
      save();
      say(state.message);
    }
    hud();
    draw();
    if (over()) {
      paused = true;
      save();
      overlay();
      return;
    }
    frame = requestAnimationFrame(tick);
  }
  function pause() {
    if (!kind) return;
    if (kind === "jump") {
      C.jumpCancel(state);
      chargePointer = null;
      paused = true;
      cancelAnimationFrame(frame);
      last = 0;
      overlay();
      draw();
      hud();
    }
    save();
  }
  function resume() {
    if (kind !== "jump") return;
    if (over()) {
      state = C.jumpCreate();
      camera = null;
      save();
    }
    paused = false;
    last = 0;
    overlay();
    hud();
    canvas.focus({ preventScroll: true });
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }
  function press() {
    if (
      kind === "jump" &&
      !paused &&
      !document.querySelector("dialog[open]") &&
      C.jumpPress(state)
    ) {
      say("松手起跳");
      hud();
    }
  }
  function release() {
    if (kind === "jump" && !paused && C.jumpRelease(state)) {
      save();
      hud();
    }
  }
  function resetDialog() {
    pause();
    $("#casual-level-wrap").hidden = kind !== "mines";
    if (kind === "mines") $("#casual-level").value = state.level;
    $("#casual-new-dialog").showModal();
  }
  function open(next) {
    kind = next;
    restore();
    selected = -1;
    focusCell = 0;
    flagMode = false;
    busy = false;
    hints = [];
    paused = true;
    width = 0;
    height = 0;
    camera = null;
    $("#casual-play").hidden = false;
    $("#casual-play").dataset.game = kind;
    text("#casual-title", titles[kind]);
    $("#casual-jump-area").hidden = kind !== "jump";
    $("#casual-board-area").hidden = kind === "jump";
    $("#jump-tools").hidden = kind !== "jump";
    $("#match-tools").hidden = kind !== "match";
    $("#mine-tools").hidden = kind !== "mines";
    $("#casual-pause").hidden = kind !== "jump";
    say(
      kind === "jump"
        ? state.message
        : kind === "match"
          ? "交换相邻方块，三个同色就能消除。"
          : "首点及周围安全；长按格子可以插旗。",
    );
    if (kind === "jump") {
      overlay();
    } else {
      grid.replaceChildren();
      renderGrid();
    }
    hud();
    resize();
    clearInterval(timer);
    timer = setInterval(() => {
      if (
        kind === "mines" &&
        state.started &&
        !over() &&
        !document.hidden &&
        document.hasFocus() &&
        !document.querySelector("dialog[open]")
      ) {
        state.seconds++;
        hud();
        if (state.seconds % 5 === 0) save();
      }
    }, 1000);
  }
  function close() {
    pause();
    clearInterval(timer);
    clearTimeout(longTimer);
    cancelAnimationFrame(frame);
    animation++;
    busy = false;
    gesture = null;
    chargePointer = null;
    if ($("#casual-new-dialog").open) $("#casual-new-dialog").close();
    $("#casual-play").hidden = true;
    kind = null;
    state = null;
  }
  grid.addEventListener("pointerdown", (event) => {
    if (!kind || busy || over() || event.button !== 0) return;
    const cell = event.target.closest("[data-cell]");
    if (!cell) return;
    const i = Number(cell.dataset.cell);
    focusCell = i;
    clearTimeout(longTimer);
    gesture = {
      id: event.pointerId,
      i,
      x: event.clientX,
      y: event.clientY,
      used: false,
      cancelled: false,
    };
    if (kind === "mines")
      longTimer = setTimeout(() => {
        if (gesture) {
          gesture.used = true;
          mineAct(i, true);
        }
      }, 420);
    try {
      grid.setPointerCapture(event.pointerId);
    } catch {}
  });
  grid.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12) {
      clearTimeout(longTimer);
      if (kind === "mines") gesture.cancelled = true;
    }
  });
  grid.addEventListener("pointerup", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    clearTimeout(longTimer);
    const g = gesture;
    gesture = null;
    event.preventDefault();
    if (g.used || g.cancelled) return;
    if (kind === "mines") mineAct(g.i, flagMode);
    else if (kind === "match") {
      const dx = event.clientX - g.x,
        dy = event.clientY - g.y;
      if (Math.hypot(dx, dy) > 20) {
        const offset =
          Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : Math.sign(dy) * 7;
        const to = g.i + offset;
        if (
          to >= 0 &&
          to < 49 &&
          Math.abs((to % 7) - (g.i % 7)) +
            Math.abs(Math.floor(to / 7) - Math.floor(g.i / 7)) ===
            1
        )
          swap(g.i, to);
      } else matchAct(g.i);
    }
  });
  grid.addEventListener("pointercancel", () => {
    clearTimeout(longTimer);
    gesture = null;
  });
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearTimeout(longTimer);
    if (event.pointerType === "touch" || gesture) return;
    const cell = event.target.closest("[data-cell]");
    if (kind === "mines" && cell) mineAct(Number(cell.dataset.cell), true);
  });
  grid.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const cell = event.target.closest("[data-cell]");
    if (!cell) return;
    const i = Number(cell.dataset.cell);
    if (kind === "mines") mineAct(i, flagMode);
    else if (kind === "match") matchAct(i);
  });
  grid.addEventListener("focusin", (event) => {
    const cell = event.target.closest("[data-cell]");
    if (!cell) return;
    focusCell = Number(cell.dataset.cell);
    for (const button of grid.children)
      button.tabIndex = Number(button.dataset.cell) === focusCell ? 0 : -1;
  });
  grid.addEventListener("keydown", (event) => {
    if (!["match", "mines"].includes(kind) || busy) return;
    const columns = kind === "match" ? 7 : state.w,
      rows = kind === "match" ? 7 : state.h;
    let x = focusCell % columns,
      y = Math.floor(focusCell / columns);
    if (event.key === "ArrowLeft") x = Math.max(0, x - 1);
    else if (event.key === "ArrowRight") x = Math.min(columns - 1, x + 1);
    else if (event.key === "ArrowUp") y = Math.max(0, y - 1);
    else if (event.key === "ArrowDown") y = Math.min(rows - 1, y + 1);
    else if (event.key.toLowerCase() === "f" && kind === "mines") {
      event.preventDefault();
      mineAct(focusCell, true);
      return;
    } else return;
    event.preventDefault();
    focusCell = y * columns + x;
    renderGrid();
    grid.children[focusCell].focus({ preventScroll: true });
  });
  for (const node of [canvas, $("#jump-charge")]) {
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || chargePointer !== null) return;
      event.preventDefault();
      chargePointer = event.pointerId;
      try {
        node.setPointerCapture(event.pointerId);
      } catch {}
      press();
    });
    node.addEventListener("pointerup", (event) => {
      if (chargePointer !== event.pointerId) return;
      event.preventDefault();
      chargePointer = null;
      release();
    });
    node.addEventListener("pointercancel", () => {
      chargePointer = null;
      if (kind === "jump") {
        C.jumpCancel(state);
        hud();
      }
    });
    node.addEventListener("contextmenu", (event) => event.preventDefault());
  }
  document.addEventListener("keydown", (event) => {
    if (kind !== "jump" || document.querySelector("dialog[open]")) return;
    if (event.key === " " && !event.target.closest("button,a,select")) {
      event.preventDefault();
      if (!event.repeat) press();
    } else if (event.key.toLowerCase() === "p" || event.key === "Escape") {
      event.preventDefault();
      if (paused && !over()) resume();
      else pause();
    }
  });
  document.addEventListener("keyup", (event) => {
    if (kind === "jump" && event.key === " ") {
      event.preventDefault();
      release();
    }
  });
  $("#jump-charge").addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) press();
    }
  });
  $("#jump-charge").addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      release();
    }
  });
  $("#casual-pause").addEventListener("click", pause);
  $("#casual-resume").addEventListener("click", resume);
  $("#casual-new").addEventListener("click", resetDialog);
  $("#casual-new-cancel").addEventListener("click", () =>
    $("#casual-new-dialog").close(),
  );
  $("#casual-new-confirm").addEventListener("click", () => {
    if (!kind) return;
    animation++;
    busy = false;
    state = fresh();
    camera = null;
    save();
    $("#casual-new-dialog").close();
    selected = -1;
    hints = [];
    focusCell = 0;
    if (kind === "jump") {
      paused = true;
      overlay();
      draw();
    } else {
      grid.replaceChildren();
      renderGrid();
    }
    hud();
    say(kind === "jump" ? state.message : "新的一局开始了。");
  });
  $("#casual-help").addEventListener("click", () => {
    if (!kind) return;
    pause();
    text("#help-title", titles[kind] + " · 玩法");
    text("#help-text", help[kind]);
    $("#help-dialog").lastElementChild.hidden = true;
    $("#help-dialog").showModal();
  });
  $("#casual-result-action").addEventListener("click", () => {
    if (kind === "match" && C.matchNext(state)) {
      selected = -1;
      hints = [];
      save();
      renderGrid();
      hud();
      say("新关卡开始，目标提高了。");
    } else resetDialog();
  });
  $("#match-hint").addEventListener("click", () => {
    if (kind !== "match" || busy || over()) return;
    hints = C.matchHint(state.board) || [];
    selected = -1;
    renderGrid();
    say("交换虚线框中的两个方块。");
  });
  $("#match-shuffle").addEventListener("click", () => {
    if (kind === "match" && !busy && C.matchShuffle(state)) {
      selected = -1;
      hints = [];
      save();
      renderGrid();
      hud();
      say("已重排，扣除 2 步。");
    }
  });
  $("#mine-mode").addEventListener("click", () => {
    flagMode = !flagMode;
    hud();
    say(
      flagMode
        ? "点未翻开的格子插旗；再点按钮切回翻开。"
        : "点格子翻开，也可以长按插旗。",
    );
  });
  window.addEventListener("blur", () => {
    clearTimeout(longTimer);
    gesture = null;
    pause();
  });
  window.addEventListener("pagehide", pause);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(longTimer);
      gesture = null;
      pause();
    }
  });
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.CasualGames = { open, close };
})();
