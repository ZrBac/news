(() => {
  "use strict";
  const C = window.ExtraGamesCore,
    $ = (selector) => document.querySelector(selector);
  const TITLES = {
    dungeon: "卡牌地牢",
    defense: "轻量塔防",
    blocks: "俄罗斯方块",
  };
  const HELP = {
    dungeon:
      "共 12 层，击败第 4、8、12 层守门人。每回合有 3 点行动，点卡牌直接使用；看清敌人的下一步，再决定攻击或防御，点“结束回合”让敌人行动。每回合弃掉剩余手牌并抽 5 张，护盾只抵挡这一回合。中毒在敌人行动前造成伤害，每次减少 1 层；虚弱减少敌人的攻击。战斗后可选一张牌或跳过回血，营地可休整、磨刀或购物，守门人掉落永久装备。没有倒计时，随时退出会保存。",
    defense:
      "选择箭塔、炮塔或冰塔，再点草地建造；道路不能建塔。箭塔单体射速快，炮塔造成范围伤害，冰塔减慢敌人。点已有塔可查看射程、升级或按投入的七成出售。点击开始下一波，守住 12 波即获胜；漏过普通敌人损失 1 点城门生命，首领损失 3 点。可以边打边建塔，支持暂停和两倍速。切换页面会暂停并存档，回来后手动继续。",
    blocks:
      "左右移动、旋转方块，填满一行即可消除；堆到顶部结束。轮廓表示落点，“落到底”立即落下，“暂存”每个方块可用一次。手机可用下方按钮，长按左右或下移可连续操作；也可在棋盘左右滑动移动、向下滑动下移、轻点旋转。电脑方向键移动与旋转，空格落到底，C 暂存，P 或 Escape 暂停。每消除 10 行速度提升，切换页面自动暂停并保存。",
  };
  const colors = [
    "#69b7c7",
    "#e4bb63",
    "#a28bc5",
    "#7daf83",
    "#cf8179",
    "#7c9ccb",
    "#d69f6a",
  ];
  let kind = null,
    state = null,
    paused = true,
    frame = 0,
    last = 0,
    saveClock = 0,
    speed = 1,
    selectedTower = -1,
    towerType = "arrow",
    width = 0,
    height = 0,
    ratio = 1,
    previewKey = "",
    pointer = null,
    repeatTimer = 0;
  const memory = new Map();
  let records = {};
  try {
    const value = JSON.parse(
      localStorage.getItem("zacai-extra-records-v1") || "{}",
    );
    for (const id of Object.keys(TITLES))
      if (Number.isFinite(value?.[id]) && value[id] >= 0)
        records[id] = value[id];
  } catch {}
  const canvas = $("#extra-canvas"),
    ctx = canvas.getContext("2d");
  const text = (selector, value) => {
    const el = $(selector);
    if (el.textContent !== String(value)) el.textContent = value;
  };
  const message = (value) => text("#extra-message", value);
  const valid = (value) =>
    kind === "dungeon"
      ? C.validDungeon(value)
      : kind === "defense"
        ? C.validDefense(value)
        : C.validBlocks(value);
  const fresh = () =>
    kind === "dungeon"
      ? C.dungeonCreate()
      : kind === "defense"
        ? C.defenseCreate()
        : C.blocksCreate();
  const finished = () =>
    kind === "dungeon"
      ? ["won", "lost"].includes(state.stage)
      : kind === "defense"
        ? ["won", "lost"].includes(state.phase)
        : state.over;
  function save() {
    if (!kind || !state) return;
    const score =
      kind === "dungeon"
        ? state.floor
        : kind === "defense"
          ? state.wave
          : state.score;
    records[kind] = Math.max(records[kind] || 0, score);
    memory.set(kind, C.clone(state));
    try {
      localStorage.setItem(`zacai-extra-${kind}-v1`, JSON.stringify(state));
      localStorage.setItem("zacai-extra-records-v1", JSON.stringify(records));
      text("#extra-save", "进度自动保存在本机");
    } catch {
      text("#extra-save", "浏览器不允许存档，关闭页面后进度会丢失");
    }
  }
  function restore() {
    let data = memory.get(kind);
    if (!data)
      try {
        data = JSON.parse(localStorage.getItem(`zacai-extra-${kind}-v1`));
      } catch {}
    state = valid(data) ? data : fresh();
    save();
  }
  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function button(label, action, className = "") {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function choice(title, description, action, wide = false) {
    const node = button(
      "",
      action,
      "dungeon-choice" + (wide ? " dungeon-wide" : ""),
    );
    node.append(el("b", "", title), el("small", "", description));
    return node;
  }
  function dungeonAction(action) {
    if (action()) {
      save();
      renderDungeon();
      hud();
    }
  }
  function dungeonPick(value) {
    dungeonAction(() => C.dungeonChoose(state, value));
  }
  function cardNode(id, action, disabled = false) {
    const card = C.CARDS[id],
      node = button("", action, "dungeon-card");
    node.dataset.type = card.type;
    node.dataset.card = id;
    node.disabled = disabled;
    node.append(
      el("b", "", card.name),
      el("span", "card-energy", card.cost),
      el(
        "small",
        "",
        card.damage
          ? card.text.replace(
              /(造成 (?:\d+ 次 )?)\d+( 点伤害)/,
              (_, prefix, suffix) =>
                prefix +
                (card.damage +
                  state.power +
                  (state.stage === "battle" ? state.battlePower : 0)) +
                suffix,
            )
          : card.text,
      ),
      el("em", "", card.type),
    );
    return node;
  }
  function renderDungeon() {
    const area = $("#dungeon-area");
    area.replaceChildren();
    const intro = (title, desc) => {
      area.append(el("h2", "", title), el("p", "", desc));
    };
    const grid = el("div", "dungeon-choices");
    if (state.stage === "battle") {
      const enemy = state.enemy,
        def = C.ENEMIES[enemy.type],
        intent = C.dungeonIntent(state),
        lead = el("div", "dungeon-lead"),
        copy = el("div");
      copy.append(
        el("h2", "", def.name),
        el(
          "p",
          "enemy-intent",
          `下一步：${intent.type === "block" ? "护盾" : intent.type === "heal" ? "治疗" : intent.type === "heavy" ? "重击" : "攻击"} ${intent.amount}`,
        ),
        el(
          "p",
          "",
          `生命 ${enemy.hp} / ${enemy.maxHp} · 护盾 ${enemy.block}${enemy.poison ? " · 中毒 " + enemy.poison : ""}${enemy.weak ? " · 虚弱 " + enemy.weak : ""}`,
        ),
      );
      const bar = el("div", "enemy-life"),
        fill = el("i");
      fill.style.width = (enemy.hp / enemy.maxHp) * 100 + "%";
      bar.append(fill);
      copy.append(bar);
      lead.append(
        copy,
        el("span", "dungeon-emblem", enemy.type === "boss" ? "守" : "敌"),
      );
      area.append(lead);
      area.append(
        el(
          "div",
          "dungeon-meta",
          `第 ${state.turn} 回合 · 行动 ${state.energy} / 3 · 护盾 ${state.block} · 抽牌 ${state.draw.length} · 弃牌 ${state.discard.length}`,
        ),
      );
      const hand = el("div", "dungeon-hand");
      state.hand.forEach((id, index) =>
        hand.append(
          cardNode(
            id,
            () => dungeonAction(() => C.dungeonPlay(state, index)),
            C.CARDS[id].cost > state.energy,
          ),
        ),
      );
      area.append(hand);
      if (!state.hand.length)
        area.append(el("p", "", "手牌已用完，可以结束回合。"));
      const log = el("div", "dungeon-log");
      state.log.slice(-2).forEach((line) => log.append(el("div", "", line)));
      area.append(log);
    } else if (state.stage === "route") {
      intro(
        state.floor % 4 === 0 ? "守门人挡住了去路" : "前方有两条路",
        "选一个对手。获胜后获得金币，并选择一张新卡牌。",
      );
      state.offers.forEach((id, i) =>
        grid.append(
          choice(
            C.ENEMIES[id].name,
            {
              scout: "动作直接，多数回合会攻击。",
              guard: "先架盾再进攻，留意护盾与时机。",
              beast: "重击伤害高，防御牌要留好。",
              mage: "会治疗，也会蓄力重击。",
              boss: "更强的对手。击败后获得装备。",
            }[id],
            () => dungeonAction(() => C.dungeonEnter(state, i)),
          ),
        ),
      );
      area.append(grid);
    } else if (state.stage === "reward") {
      intro("带走一张牌", "新牌永久加入本局牌组。也可以跳过并恢复 4 点生命。");
      const cards = el("div", "dungeon-hand");
      state.rewards.forEach((id, i) =>
        cards.append(cardNode(id, () => dungeonPick(i))),
      );
      area.append(
        cards,
        choice(
          "跳过，恢复 4 点生命",
          "继续向下一层前进。",
          () => dungeonPick("skip"),
          true,
        ),
      );
    } else if (state.stage === "relic") {
      intro("守门人的藏品", "选一件装备，本局探索持续生效。");
      grid.append(
        choice("磨砺之刃", "每次攻击伤害 +2。", () => dungeonPick("blade")),
        choice("守护锁甲", "每回合开始获得 4 点护盾。", () =>
          dungeonPick("mail"),
        ),
        choice("生命护符", "生命上限 +12，并恢复 12 点生命。", () =>
          dungeonPick("heart"),
        ),
      );
      area.append(grid);
    } else if (state.stage === "camp") {
      intro("营地的火还没熄", "在这里做一件事，然后继续探索。");
      grid.append(
        choice("休整", "恢复 20 点生命。", () => dungeonPick("rest")),
        choice("磨刀", "本局每次攻击伤害 +1。", () => dungeonPick("forge")),
        choice("拜访商人", `用金币买补给。现有 ${state.gold} 金币。`, () =>
          dungeonPick("shop"),
        ),
      );
      area.append(grid);
    } else if (state.stage === "shop") {
      intro("旅途商人", "每件商品限买一次，买完可以直接离开。");
      for (const [id, title, desc, cost] of [
        ["potion", "治疗药水", "恢复 22 点生命", 20],
        ["armor", "轻便护甲", "每回合初始护盾 +2", 35],
        ["card", "毒刃卡牌", "一张毒刃加入牌组", 30],
      ]) {
        const node = choice(title, `${desc} · ${cost} 金币`, () =>
          dungeonPick(id),
        );
        node.disabled = state.gold < cost || state.purchased.includes(id);
        grid.append(node);
      }
      grid.append(
        choice(
          "离开商店",
          "继续探索下一层。",
          () => dungeonPick("leave"),
          true,
        ),
      );
      area.append(grid);
    } else {
      const box = el("div", "dungeon-result");
      box.append(
        el("strong", "", state.stage === "won" ? "胜" : "终"),
        el("h2", "", state.stage === "won" ? "走出了地牢" : "这次旅程到这里"),
        el(
          "p",
          "",
          `抵达第 ${state.floor} 层 · 收集 ${state.deck.length} 张牌 · ${state.gold} 金币`,
        ),
        button("再探索一次", newDialog),
      );
      area.append(box);
    }
    $("#dungeon-end").hidden = state.stage !== "battle";
    message(
      state.stage === "battle"
        ? "点卡牌使用；行动用完后，点“结束回合”。"
        : "没有倒计时，可以慢慢选择。",
    );
  }
  function hud() {
    if (!kind) return;
    text(
      "#extra-hud",
      kind === "dungeon"
        ? `第 ${state.floor} / 12 层　♥ ${state.hp}/${state.maxHp}　金币 ${state.gold}　攻击 +${state.power} · 初始盾 ${state.armor}`
        : kind === "defense"
          ? `第 ${state.wave} / 12 波　城门 ${state.lives}　金币 ${state.gold}　击败 ${state.kills}`
          : `得分 ${state.score}　消除 ${state.lines} 行　等级 ${1 + Math.floor(state.lines / 10)}`,
    );
    if (kind === "defense") {
      const t = state.towers[selectedTower];
      $("#defense-upgrade").disabled =
        !t ||
        t.level >= 3 ||
        finished() ||
        state.gold < C.defenseUpgradeCost(t);
      text(
        "#defense-upgrade",
        t
          ? t.level === 3
            ? "已满级"
            : `升级 · ${C.defenseUpgradeCost(t)}`
          : "升级",
      );
      $("#defense-sell").disabled = !t || finished();
      text("#defense-sell", t ? `出售 · ${Math.floor(t.spent * 0.7)}` : "出售");
      $("#defense-wave").disabled = state.phase !== "build";
      text(
        "#defense-wave",
        state.phase === "build"
          ? `开始第 ${state.wave + 1} 波`
          : state.phase === "wave"
            ? "本波进行中"
            : state.phase === "won"
              ? "防守成功"
              : "防线失守",
      );
      for (const node of document.querySelectorAll("[data-tower]")) {
        node.setAttribute(
          "aria-pressed",
          String(node.dataset.tower === towerType),
        );
        node.disabled = finished();
      }
      $("#extra-pause").disabled = state.phase === "build" || finished();
      text("#defense-speed", "速度 ×" + speed);
    } else if (kind === "blocks") {
      text(
        "#blocks-best",
        "最高分 " + Math.max(records.blocks || 0, state.score),
      );
      for (const node of document.querySelectorAll("[data-block]"))
        node.disabled =
          paused || state.over || (node.dataset.block === "hold" && state.held);
      renderPreview();
    }
    text("#extra-pause", paused ? "继续" : "暂停");
  }
  function renderPreview() {
    const key = state.next.join(",") + ":" + state.hold;
    if (key === previewKey) return;
    previewKey = key;
    const piece = (type) => {
      const node = el("div", "mini-piece");
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const cell = el("i");
          if (
            type !== null &&
            C.PIECES[type].some((p) => p[0] === x && p[1] === y)
          )
            cell.style.background = colors[type];
          node.append(cell);
        }
      return node;
    };
    $("#blocks-next").replaceChildren(...state.next.slice(0, 3).map(piece));
    $("#blocks-held").replaceChildren(piece(state.hold));
  }
  function overlay() {
    if (kind === "dungeon") return;
    const show = finished() || paused;
    $("#extra-overlay").hidden = !show;
    if (!show) return;
    text(
      "#extra-overlay-title",
      finished()
        ? kind === "defense"
          ? state.phase === "won"
            ? "十二波守住了！"
            : "防线失守"
          : "这一局结束了"
        : kind === "blocks" && state.pieces === 0 && state.score === 0
          ? "准备好了吗？"
          : "已暂停",
    );
    text(
      "#extra-overlay-text",
      finished()
        ? kind === "defense"
          ? `抵挡 ${state.wave} 波 · 击败 ${state.kills} 个敌人`
          : `得分 ${state.score} · 消除 ${state.lines} 行`
        : kind === "blocks"
          ? "左右移动，点旋转；“落到底”直接放下方块。"
          : "点继续恢复这一波。建塔、升级和金币进度已保存。",
    );
    text(
      "#extra-resume",
      finished()
        ? "新一局"
        : kind === "blocks" && state.pieces === 0 && state.score === 0
          ? "开始游戏"
          : "继续游戏",
    );
  }
  function fill(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  function circle(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function label(value, x, y, size, color, align = "center") {
    ctx.fillStyle = color;
    ctx.font = `600 ${size}px -apple-system, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(value, x, y);
  }
  function drawDefense() {
    const tile = width / 9;
    fill(0, 0, width, height, "#d5dfbf");
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 9; x++) {
        fill(
          x * tile + 1,
          y * tile + 1,
          tile - 2,
          tile - 2,
          (x + y) % 2 ? "#d5dfbf" : "#dce5c9",
        );
      }
    for (const [x, y] of C.PATH)
      fill(x * tile, y * tile, tile, tile, "#c9b991");
    ctx.strokeStyle = "#e3d5b4";
    ctx.lineWidth = tile * 0.34;
    ctx.beginPath();
    C.PATH.forEach(([x, y], i) =>
      i
        ? ctx.lineTo((x + 0.5) * tile, (y + 0.5) * tile)
        : ctx.moveTo((x + 0.5) * tile, (y + 0.5) * tile),
    );
    ctx.stroke();
    label(
      "来",
      (C.PATH[0][0] + 0.5) * tile,
      (C.PATH[0][1] + 0.5) * tile,
      tile * 0.3,
      "#806b46",
    );
    label("门", 8.5 * tile, 7.5 * tile, tile * 0.36, "#5b694d");
    const selected = state.towers[selectedTower];
    if (selected) {
      circle(
        (selected.x + 0.5) * tile,
        (selected.y + 0.5) * tile,
        C.defenseStats(selected).range * tile,
        "#477e6620",
      );
      ctx.strokeStyle = "#567d58";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        selected.x * tile + 2,
        selected.y * tile + 2,
        tile - 4,
        tile - 4,
      );
    }
    for (const t of state.towers) {
      const stats = C.defenseStats(t),
        x = (t.x + 0.5) * tile,
        y = (t.y + 0.5) * tile;
      circle(x, y, tile * 0.36, "#f2eee0");
      circle(x, y, tile * 0.29, stats.color);
      label(
        { arrow: "箭", cannon: "炮", frost: "冰" }[t.type],
        x,
        y,
        tile * 0.31,
        "#fff",
      );
      label("•".repeat(t.level), x, y + tile * 0.38, tile * 0.21, "#526647");
    }
    for (const e of state.enemies) {
      const p = C.defensePosition(e.progress),
        x = p.x * tile,
        y = p.y * tile;
      circle(
        x,
        y,
        tile * (e.type === "boss" ? 0.32 : 0.21),
        e.type === "boss"
          ? "#74506d"
          : e.type === "armored"
            ? "#6e7478"
            : e.type === "fast"
              ? "#c48749"
              : "#ab6550",
      );
      if (e.slow > 0) {
        ctx.strokeStyle = "#8cd8ec";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, tile * 0.28, 0, Math.PI * 2);
        ctx.stroke();
      }
      fill(x - tile * 0.3, y - tile * 0.4, tile * 0.6, 3, "#a8977c");
      fill(
        x - tile * 0.3,
        y - tile * 0.4,
        tile * 0.6 * Math.max(0, e.hp / e.maxHp),
        3,
        "#517952",
      );
    }
    for (const e of state.effects) {
      ctx.strokeStyle = C.TOWERS[e.type].color;
      ctx.lineWidth = e.type === "cannon" ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(e.x * tile, e.y * tile);
      ctx.lineTo(e.tx * tile, e.ty * tile);
      ctx.stroke();
      if (e.type === "cannon")
        circle(e.tx * tile, e.ty * tile, tile * 0.6, "#d6903b44");
    }
  }
  function drawBlocks() {
    const tile = width / 10;
    fill(0, 0, width, height, "#101c28");
    ctx.strokeStyle = "#263644";
    ctx.lineWidth = 0.6;
    for (let x = 0; x <= 10; x++) {
      ctx.beginPath();
      ctx.moveTo(x * tile, 0);
      ctx.lineTo(x * tile, height);
      ctx.stroke();
    }
    for (let y = 0; y <= 20; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * tile);
      ctx.lineTo(width, y * tile);
      ctx.stroke();
    }
    const block = (x, y, type, ghost = false) => {
      if (y < 0) return;
      if (ghost) {
        ctx.strokeStyle = colors[type];
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x * tile + 3, y * tile + 3, tile - 6, tile - 6);
      } else {
        fill(x * tile + 1, y * tile + 1, tile - 2, tile - 2, colors[type]);
        fill(x * tile + 3, y * tile + 3, tile - 6, 2, "#ffffff45");
      }
    };
    state.board.forEach((row, y) =>
      row.forEach((v, x) => {
        if (v) block(x, y, v - 1);
      }),
    );
    if (!state.over)
      C.blocksCells(C.blocksGhost(state)).forEach(([x, y]) =>
        block(x, y, state.piece.type, true),
      );
    C.blocksCells(state.piece).forEach(([x, y]) =>
      block(x, y, state.piece.type),
    );
  }
  function draw() {
    if (!ctx || !kind || kind === "dungeon" || !width || !height) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (kind === "defense") drawDefense();
    else drawBlocks();
  }
  function size() {
    if (!kind) return;
    document.documentElement.style.setProperty(
      "--extra-height",
      (window.visualViewport?.height || innerHeight) + "px",
    );
    if (kind === "dungeon") return;
    const area = $("#extra-arena"),
      available = Math.max(
        30,
        area.clientWidth - 16 - (kind === "blocks" ? 77 : 0),
      );
    const w =
        kind === "defense"
          ? Math.min(available, area.clientHeight)
          : Math.min(available, area.clientHeight / 2),
      h = kind === "defense" ? w : w * 2;
    if (w <= 0 || h <= 0) return;
    if (
      width &&
      (Math.abs(width - w) > 1 || Math.abs(height - h) > 1) &&
      !paused
    )
      pause();
    width = w;
    height = h;
    ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    draw();
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    clearTimeout(repeatTimer);
    pointer = null;
  }
  function pause() {
    if (!kind) return;
    if (kind === "dungeon") {
      save();
      return;
    }
    if (kind === "defense" && state.phase === "build") {
      save();
      return;
    }
    paused = true;
    stop();
    save();
    hud();
    overlay();
  }
  function resume() {
    if (!kind || kind === "dungeon" || finished()) return;
    paused = false;
    last = 0;
    hud();
    overlay();
    canvas.focus({ preventScroll: true });
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }
  function tick(time) {
    if (!kind || paused || kind === "dungeon") return;
    const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
    last = time;
    saveClock += dt;
    const before = kind === "blocks" ? state.pieces : state.phase;
    const steps = Math.max(
        1,
        Math.ceil(dt * 60 * (kind === "defense" ? speed : 1)),
      ),
      slice = (dt * (kind === "defense" ? speed : 1)) / steps;
    for (let i = 0; i < steps; i++) {
      if (kind === "defense") C.defenseStep(state, slice);
      else C.blocksStep(state, slice);
    }
    if (
      saveClock > 2 ||
      (kind === "blocks" ? state.pieces !== before : state.phase !== before)
    ) {
      save();
      saveClock = 0;
    }
    hud();
    draw();
    if (finished()) {
      paused = true;
      save();
      overlay();
      stop();
    } else if (kind === "defense" && state.phase === "build") {
      message("这一波守住了，可以补塔、升级，再开始下一波。");
      stop();
      hud();
    } else frame = requestAnimationFrame(tick);
  }
  function blockAction(action) {
    if (kind !== "blocks" || paused || state.over) return;
    const before = state.pieces;
    if (C.blocksAction(state, action)) {
      hud();
      draw();
      if (state.pieces !== before || state.over) save();
      if (state.over) {
        paused = true;
        stop();
        overlay();
        hud();
      }
    }
  }
  function defenseTap(x, y) {
    if (finished()) return;
    const found = state.towers.findIndex((t) => t.x === x && t.y === y);
    if (found >= 0) {
      selectedTower = found;
      const t = state.towers[found],
        stats = C.defenseStats(t);
      message(
        `${stats.name} ${t.level} 级 · 伤害 ${stats.damage} · 射程 ${stats.range.toFixed(1)} 格`,
      );
    } else if (C.defenseBuild(state, x, y, towerType)) {
      selectedTower = state.towers.length - 1;
      message("已建造" + C.TOWERS[towerType].name + "。点已有塔可升级。");
      save();
    } else
      message(
        C.PATH.some((p) => p[0] === x && p[1] === y)
          ? "这是敌人通行的道路，请在草地上建塔。"
          : "金币不足，击败敌人和完成波次可获得金币。",
      );
    hud();
    draw();
  }
  function help(content, title) {
    pause();
    text("#help-title", title || TITLES[kind] + " · 玩法");
    text("#help-text", content || HELP[kind]);
    $("#help-dialog").lastElementChild.hidden = true;
    $("#help-dialog").showModal();
  }
  function newDialog() {
    pause();
    $("#extra-new-dialog").showModal();
  }
  function open(next) {
    kind = next;
    restore();
    speed = 1;
    towerType = "arrow";
    selectedTower = -1;
    previewKey = "";
    width = 0;
    height = 0;
    saveClock = 0;
    paused =
      kind === "blocks" || (kind === "defense" && state.phase === "wave");
    $("#extra-actions").prepend($("#extra-pause"));
    $("#extra-actions").hidden = kind === "blocks";
    if (kind === "blocks") $("#blocks-controls").append($("#extra-pause"));
    $("#extra-play").hidden = false;
    $("#extra-play").dataset.game = kind;
    text("#extra-title", TITLES[kind]);
    $("#dungeon-area").hidden = kind !== "dungeon";
    $("#extra-arena").hidden = kind === "dungeon";
    $("#defense-tools").hidden = kind !== "defense";
    $("#blocks-controls").hidden = kind !== "blocks";
    $("#blocks-side").hidden = kind !== "blocks";
    $("#extra-pause").hidden = kind === "dungeon";
    $("#defense-speed").hidden = kind !== "defense";
    $("#dungeon-deck").hidden = kind !== "dungeon";
    $("#dungeon-end").hidden = kind !== "dungeon";
    $("#extra-pause").disabled = false;
    canvas.setAttribute(
      "aria-label",
      kind === "defense"
        ? "塔防棋盘，选择塔后点草地建造；也可用方向键选格，回车建造。"
        : "俄罗斯方块棋盘，用方向键移动旋转，空格落到底，C 暂存。",
    );
    if (kind === "dungeon") renderDungeon();
    else {
      message(
        kind === "defense"
          ? "先选防御塔，再点草地建造；准备好后开始下一波。"
          : "点旋转，左右滑动移动；也可用下方按钮。",
      );
      overlay();
    }
    hud();
    size();
  }
  function close() {
    save();
    stop();
    kind = null;
    state = null;
    $("#extra-play").hidden = true;
    $("#extra-new-dialog").close();
  }
  $("#extra-help").addEventListener("click", () => help());
  $("#extra-new").addEventListener("click", newDialog);
  $("#extra-new-cancel").addEventListener("click", () =>
    $("#extra-new-dialog").close(),
  );
  $("#extra-new-confirm").addEventListener("click", () => {
    state = fresh();
    memory.set(kind, C.clone(state));
    save();
    $("#extra-new-dialog").close();
    open(kind);
  });
  $("#extra-resume").addEventListener("click", () =>
    finished() ? newDialog() : resume(),
  );
  // React immediately to touch, including the first tap after a board swipe.
  $("#extra-pause").addEventListener("pointerdown", (event) => {
    if ($("#extra-pause").disabled) return;
    event.preventDefault();
    paused ? resume() : pause();
  });
  $("#extra-pause").addEventListener("click", (event) => {
    if (event.detail === 0) paused ? resume() : pause();
  });
  $("#dungeon-end").addEventListener("click", () =>
    dungeonAction(() => C.dungeonEnd(state)),
  );
  $("#dungeon-deck").addEventListener("click", () => {
    const counts = {};
    state.deck.forEach((id) => (counts[id] = (counts[id] || 0) + 1));
    help(
      Object.entries(counts)
        .map(
          ([id, count]) => `${C.CARDS[id].name} ×${count}：${C.CARDS[id].text}`,
        )
        .join("；"),
      "本局牌组 · " + state.deck.length + " 张",
    );
  });
  for (const node of document.querySelectorAll("[data-tower]"))
    node.addEventListener("click", () => {
      towerType = node.dataset.tower;
      selectedTower = -1;
      message(
        `已选${C.TOWERS[towerType].name}，点草地建造（${C.TOWERS[towerType].cost} 金币）。`,
      );
      hud();
      draw();
    });
  $("#defense-upgrade").addEventListener("click", () => {
    if (C.defenseUpgrade(state, selectedTower)) {
      save();
      hud();
      draw();
      message("升级完成，伤害与射程提升。");
    }
  });
  $("#defense-sell").addEventListener("click", () => {
    if (C.defenseSell(state, selectedTower)) {
      selectedTower = -1;
      save();
      hud();
      draw();
      message("已出售，返还投入金币的七成。");
    }
  });
  $("#defense-wave").addEventListener("click", () => {
    if (C.defenseStart(state)) {
      save();
      message("敌人来了，仍可继续建塔或升级。");
      resume();
    }
  });
  $("#defense-speed").addEventListener("click", () => {
    speed = speed === 1 ? 2 : 1;
    hud();
  });
  for (const node of document.querySelectorAll("[data-block]")) {
    const act = () => blockAction(node.dataset.block);
    node.addEventListener("pointerdown", (event) => {
      if (node.disabled) return;
      event.preventDefault();
      clearTimeout(repeatTimer);
      act();
      if (["left", "right", "down"].includes(node.dataset.block)) {
        const repeat = () => {
          act();
          repeatTimer = setTimeout(repeat, 85);
        };
        repeatTimer = setTimeout(repeat, 230);
      }
    });
    node.addEventListener("click", (event) => {
      if (event.detail === 0) act();
    });
  }
  for (const type of ["pointerup", "pointercancel"])
    window.addEventListener(type, () => clearTimeout(repeatTimer));
  canvas.addEventListener("pointerdown", (event) => {
    if (!kind || kind === "dungeon" || pointer !== null) return;
    event.preventDefault();
    const box = canvas.getBoundingClientRect();
    pointer = {
      id: event.pointerId,
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (
      !pointer ||
      event.pointerId !== pointer.id ||
      kind !== "blocks" ||
      paused
    )
      return;
    const box = canvas.getBoundingClientRect(),
      x = event.clientX - box.left,
      y = event.clientY - box.top,
      tile = width / 10;
    if (
      Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) > 8
    )
      pointer.moved = true;
    while (Math.abs(x - pointer.x) >= tile) {
      const direction = x > pointer.x ? 1 : -1;
      blockAction(direction > 0 ? "right" : "left");
      pointer.x += direction * tile;
    }
    while (y - pointer.y >= tile) {
      blockAction("down");
      pointer.y += tile;
    }
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const value = pointer;
    pointer = null;
    if (
      kind === "defense" &&
      Math.hypot(event.clientX - value.startX, event.clientY - value.startY) <
        12
    )
      defenseTap(
        Math.min(8, Math.floor(value.x / (width / 9))),
        Math.min(8, Math.floor(value.y / (height / 9))),
      );
    else if (kind === "blocks" && !value.moved) blockAction("rotate");
  });
  for (const type of ["pointercancel", "lostpointercapture"])
    canvas.addEventListener(type, () => {
      pointer = null;
    });
  let cursor = { x: 4, y: 4 };
  document.addEventListener("keydown", (event) => {
    if (
      !kind ||
      kind === "dungeon" ||
      document.querySelector("dialog[open]") ||
      /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)
    )
      return;
    if (
      [" ", "Enter"].includes(event.key) &&
      /^(BUTTON|A)$/.test(event.target.tagName)
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "p" || event.key === "Escape") {
      event.preventDefault();
      paused ? resume() : pause();
      return;
    }
    if (kind === "blocks") {
      const action =
        {
          ArrowLeft: "left",
          ArrowRight: "right",
          ArrowDown: "down",
          ArrowUp: "rotate",
          " ": "drop",
          c: "hold",
        }[event.key] || (key === "c" ? "hold" : null);
      if (action) {
        event.preventDefault();
        blockAction(action);
      }
    } else {
      const delta = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (delta) {
        event.preventDefault();
        cursor.x = Math.max(0, Math.min(8, cursor.x + delta[0]));
        cursor.y = Math.max(0, Math.min(8, cursor.y + delta[1]));
        message(
          `第 ${cursor.y + 1} 行第 ${cursor.x + 1} 列，按回车建造或选中。`,
        );
        draw();
        if (ctx) {
          ctx.strokeStyle = "#35583f";
          ctx.lineWidth = 3;
          ctx.strokeRect(
            (cursor.x * width) / 9 + 2,
            (cursor.y * height) / 9 + 2,
            width / 9 - 4,
            height / 9 - 4,
          );
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        defenseTap(cursor.x, cursor.y);
      }
    }
  });
  window.addEventListener("blur", pause);
  window.addEventListener("pagehide", pause);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("resize", size);
  window.visualViewport?.addEventListener("resize", size);
  new ResizeObserver(size).observe($("#extra-arena"));
  window.ExtraGames = { open, close };
})();
