/* Original offline rules for a card expedition, tower defense and falling blocks. */
(function (root) {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function random(s) {
    s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
    return s.seed / 4294967296;
  }
  function shuffle(s, items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random(s) * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const CARDS = {
    strike: {
      name: "挥砍",
      cost: 1,
      damage: 6,
      text: "造成 6 点伤害",
      type: "攻击",
    },
    guard: {
      name: "格挡",
      cost: 1,
      block: 7,
      text: "获得 7 点护盾",
      type: "防御",
    },
    quick: {
      name: "谋划",
      cost: 1,
      draw: 2,
      block: 3,
      text: "抽 2 张牌，获得 3 点护盾",
      type: "技能",
    },
    mend: {
      name: "包扎",
      cost: 1,
      heal: 4,
      text: "恢复 4 点生命，本场战斗移除",
      exhaust: true,
      type: "技能",
    },
    heavy: {
      name: "重斩",
      cost: 2,
      damage: 16,
      text: "造成 16 点伤害",
      type: "攻击",
    },
    venom: {
      name: "毒刃",
      cost: 1,
      damage: 3,
      poison: 4,
      text: "造成 3 点伤害，施加 4 层中毒",
      type: "攻击",
    },
    shield: {
      name: "坚守",
      cost: 2,
      block: 17,
      text: "获得 17 点护盾",
      type: "防御",
    },
    sweep: {
      name: "连击",
      cost: 1,
      damage: 4,
      hits: 2,
      text: "造成 2 次 4 点伤害",
      type: "攻击",
    },
    weaken: {
      name: "破势",
      cost: 1,
      damage: 4,
      weak: 2,
      text: "造成 4 点伤害，敌人虚弱 2 回合",
      type: "攻击",
    },
    focus: {
      name: "蓄力",
      cost: 0,
      power: 2,
      text: "本场攻击力 +2，本场战斗移除",
      exhaust: true,
      type: "技能",
    },
    recover: {
      name: "急救",
      cost: 2,
      heal: 10,
      text: "恢复 10 点生命，本场战斗移除",
      exhaust: true,
      type: "技能",
    },
    riposte: {
      name: "反击",
      cost: 1,
      damage: 5,
      block: 5,
      text: "造成 5 点伤害，获得 5 点护盾",
      type: "攻击",
    },
  };
  const ENEMIES = {
    scout: {
      name: "游荡者",
      hp: 20,
      attack: 5,
      cycle: ["attack", "attack", "block"],
    },
    guard: {
      name: "铁甲卫兵",
      hp: 29,
      attack: 7,
      cycle: ["block", "attack", "attack"],
    },
    beast: {
      name: "洞穴兽",
      hp: 24,
      attack: 6,
      cycle: ["attack", "heavy", "block"],
    },
    mage: {
      name: "灰袍术士",
      hp: 22,
      attack: 6,
      cycle: ["attack", "heal", "heavy"],
    },
    boss: {
      name: "地牢守门人",
      hp: 52,
      attack: 9,
      cycle: ["attack", "block", "heavy"],
    },
  };
  function dungeonCreate(seed = Date.now() >>> 0) {
    const s = {
      kind: "dungeon",
      version: 1,
      seed,
      floor: 1,
      hp: 56,
      maxHp: 56,
      gold: 0,
      power: 0,
      armor: 0,
      deck: [
        "strike",
        "strike",
        "strike",
        "strike",
        "strike",
        "guard",
        "guard",
        "guard",
        "guard",
        "quick",
        "mend",
        "riposte",
      ],
      stage: "route",
      hand: [],
      draw: [],
      discard: [],
      exhaust: [],
      energy: 3,
      block: 0,
      battlePower: 0,
      enemy: null,
      offers: [],
      rewards: [],
      purchased: [],
      log: [],
      turn: 1,
    };
    dungeonRoute(s);
    return s;
  }
  function dungeonLog(s, text) {
    s.log.push(text);
    s.log = s.log.slice(-4);
  }
  function dungeonRoute(s) {
    s.enemy = null;
    s.hand = [];
    s.draw = [];
    s.discard = [];
    s.exhaust = [];
    s.block = 0;
    if ([3, 7, 11].includes(s.floor)) {
      s.stage = "camp";
      return;
    }
    s.stage = "route";
    s.offers =
      s.floor % 4 === 0
        ? ["boss"]
        : shuffle(s, ["scout", "guard", "beast", "mage"]).slice(0, 2);
  }
  function dungeonDraw(s, n) {
    for (let i = 0; i < n && s.hand.length < 9; i++) {
      if (!s.draw.length) {
        s.draw = shuffle(s, s.discard);
        s.discard = [];
      }
      if (s.draw.length) s.hand.push(s.draw.pop());
    }
  }
  function dungeonIntent(s) {
    const def = ENEMIES[s.enemy.type],
      type = def.cycle[(s.turn - 1) % def.cycle.length];
    const attack = def.attack + Math.floor(s.floor * 0.8);
    return {
      type,
      amount:
        type === "attack"
          ? Math.max(1, attack - (s.enemy.weak ? 3 : 0))
          : type === "heavy"
            ? Math.max(1, attack + 5 - (s.enemy.weak ? 3 : 0))
            : type === "block"
              ? 8 + Math.floor(s.floor / 2)
              : 6,
    };
  }
  function dungeonEnter(s, index) {
    if (s.stage !== "route" || !Number.isInteger(index) || !s.offers[index])
      return false;
    const type = s.offers[index],
      def = ENEMIES[type],
      hp = def.hp + s.floor * (type === "boss" ? 5 : 3);
    s.enemy = { type, hp, maxHp: hp, block: 0, poison: 0, weak: 0 };
    s.stage = "battle";
    s.turn = 1;
    s.energy = 3;
    s.block = s.armor;
    s.battlePower = 0;
    s.hand = [];
    s.discard = [];
    s.exhaust = [];
    s.draw = shuffle(s, s.deck);
    s.log = [];
    dungeonDraw(s, 5);
    dungeonLog(s, `遭遇${def.name}。`);
    return true;
  }
  function dungeonFinish(s) {
    if (s.hp <= 0) {
      s.hp = 0;
      s.stage = "lost";
      dungeonLog(s, "这次探索结束了。");
      return true;
    }
    if (s.enemy && s.enemy.hp <= 0) {
      s.enemy.hp = 0;
      s.gold += 14 + s.floor * 3;
      if (s.floor === 12) {
        s.stage = "won";
        dungeonLog(s, "最后的守门人倒下了，探索完成！");
        return true;
      }
      s.rewards = shuffle(
        s,
        Object.keys(CARDS).filter((id) => !["strike", "guard"].includes(id)),
      ).slice(0, 3);
      s.stage = s.enemy.type === "boss" ? "relic" : "reward";
      dungeonLog(s, "战斗获胜，选择一份战利品。");
      return true;
    }
    return false;
  }
  function dungeonPlay(s, index) {
    if (s.stage !== "battle" || !Number.isInteger(index) || !s.hand[index])
      return false;
    const id = s.hand[index],
      card = CARDS[id];
    if (card.cost > s.energy) return false;
    s.energy -= card.cost;
    s.hand.splice(index, 1);
    (card.exhaust ? s.exhaust : s.discard).push(id);
    if (card.damage)
      for (let hit = 0; hit < (card.hits || 1); hit++) {
        const damage = card.damage + s.power + s.battlePower,
          absorbed = Math.min(s.enemy.block, damage);
        s.enemy.block -= absorbed;
        s.enemy.hp -= damage - absorbed;
      }
    if (card.block) s.block += card.block;
    if (card.heal) s.hp = Math.min(s.maxHp, s.hp + card.heal);
    if (card.poison) s.enemy.poison += card.poison;
    if (card.weak) s.enemy.weak += card.weak;
    if (card.power) s.battlePower += card.power;
    if (card.draw) dungeonDraw(s, card.draw);
    dungeonLog(s, `使用${card.name}。`);
    dungeonFinish(s);
    return true;
  }
  function dungeonEnd(s) {
    if (s.stage !== "battle") return false;
    s.enemy.hp -= s.enemy.poison;
    if (s.enemy.poison) {
      dungeonLog(s, `中毒造成 ${s.enemy.poison} 点伤害。`);
      s.enemy.poison--;
    }
    if (dungeonFinish(s)) return true;
    const intent = dungeonIntent(s);
    s.enemy.block = 0;
    if (["attack", "heavy"].includes(intent.type)) {
      const damage = Math.max(0, intent.amount - s.block);
      s.hp -= damage;
      dungeonLog(s, `敌人攻击 ${intent.amount}，受到 ${damage} 点伤害。`);
    } else if (intent.type === "block") {
      s.enemy.block = intent.amount;
      dungeonLog(s, `敌人获得 ${intent.amount} 点护盾。`);
    } else {
      s.enemy.hp = Math.min(s.enemy.maxHp, s.enemy.hp + intent.amount);
      dungeonLog(s, "敌人恢复生命。");
    }
    if (s.enemy.weak) s.enemy.weak--;
    if (dungeonFinish(s)) return true;
    s.discard.push(...s.hand);
    s.hand = [];
    s.energy = 3;
    s.block = s.armor;
    s.turn++;
    dungeonDraw(s, 5);
    return true;
  }
  function dungeonChoose(s, choice) {
    if (s.stage === "reward") {
      if (choice === "skip") s.hp = Math.min(s.maxHp, s.hp + 4);
      else if (Number.isInteger(choice) && s.rewards[choice])
        s.deck.push(s.rewards[choice]);
      else return false;
      s.floor++;
      dungeonRoute(s);
      return true;
    }
    if (s.stage === "relic") {
      if (choice === "blade") s.power += 2;
      else if (choice === "mail") s.armor += 4;
      else if (choice === "heart") {
        s.maxHp += 12;
        s.hp = Math.min(s.maxHp, s.hp + 12);
      } else return false;
      s.stage = "reward";
      return true;
    }
    if (s.stage === "camp") {
      if (choice === "rest") s.hp = Math.min(s.maxHp, s.hp + 20);
      else if (choice === "forge") s.power++;
      else if (choice === "shop") {
        s.stage = "shop";
        s.purchased = [];
        return true;
      } else return false;
      s.floor++;
      dungeonRoute(s);
      return true;
    }
    if (s.stage === "shop") {
      if (choice === "leave") {
        s.floor++;
        dungeonRoute(s);
        return true;
      }
      const prices = { potion: 20, armor: 35, card: 30 };
      if (
        !prices[choice] ||
        s.gold < prices[choice] ||
        s.purchased.includes(choice)
      )
        return false;
      s.gold -= prices[choice];
      s.purchased.push(choice);
      if (choice === "potion") s.hp = Math.min(s.maxHp, s.hp + 22);
      if (choice === "armor") s.armor += 2;
      if (choice === "card") s.deck.push("venom");
      return true;
    }
    return false;
  }
  // A winding path leaves build sites on both sides. Coordinates are tile centers.
  const WAYPOINTS = [
    [0, 1],
    [6, 1],
    [6, 3],
    [2, 3],
    [2, 5],
    [7, 5],
    [7, 7],
    [8, 7],
  ];
  const PATH = [];
  for (let i = 0; i < WAYPOINTS.length - 1; i++) {
    let [x, y] = WAYPOINTS[i];
    const [tx, ty] = WAYPOINTS[i + 1],
      dx = Math.sign(tx - x),
      dy = Math.sign(ty - y);
    while (x !== tx || y !== ty) {
      PATH.push([x, y]);
      x += dx;
      y += dy;
    }
  }
  PATH.push(WAYPOINTS[WAYPOINTS.length - 1]);
  const TOWERS = {
    arrow: {
      name: "箭塔",
      cost: 45,
      damage: 8,
      rate: 0.55,
      range: 2.25,
      color: "#448679",
    },
    cannon: {
      name: "炮塔",
      cost: 75,
      damage: 20,
      rate: 1.45,
      range: 2.05,
      color: "#c78448",
    },
    frost: {
      name: "冰塔",
      cost: 60,
      damage: 4,
      rate: 0.95,
      range: 2.2,
      color: "#668fb4",
    },
  };
  function defenseCreate() {
    return {
      kind: "defense",
      version: 1,
      phase: "build",
      wave: 0,
      lives: 15,
      gold: 180,
      kills: 0,
      towers: [],
      enemies: [],
      queue: [],
      spawn: 0,
      serial: 0,
      effects: [],
    };
  }
  function defensePosition(progress) {
    const index = Math.min(PATH.length - 1, Math.floor(progress)),
      p = PATH[index],
      q = PATH[Math.min(index + 1, PATH.length - 1)],
      f = progress - index;
    return {
      x: p[0] + (q[0] - p[0]) * f + 0.5,
      y: p[1] + (q[1] - p[1]) * f + 0.5,
    };
  }
  function defenseStats(t) {
    const base = TOWERS[t.type];
    return {
      ...base,
      damage: Math.round(base.damage * Math.pow(1.65, t.level - 1)),
      range: base.range + (t.level - 1) * 0.2,
      rate: base.rate * Math.pow(0.85, t.level - 1),
    };
  }
  function defenseBuild(s, x, y, type) {
    const base = TOWERS[type];
    if (
      !base ||
      !["build", "wave"].includes(s.phase) ||
      ![x, y].every((n) => Number.isInteger(n) && n >= 0 && n < 9) ||
      PATH.some((p) => p[0] === x && p[1] === y) ||
      s.towers.some((t) => t.x === x && t.y === y) ||
      s.gold < base.cost
    )
      return false;
    s.gold -= base.cost;
    s.towers.push({ x, y, type, level: 1, cooldown: 0, spent: base.cost });
    return true;
  }
  function defenseUpgradeCost(t) {
    return Math.round(TOWERS[t.type].cost * 0.8 * t.level);
  }
  function defenseUpgrade(s, index) {
    const t = s.towers[index];
    if (
      !["build", "wave"].includes(s.phase) ||
      !t ||
      t.level >= 3 ||
      s.gold < defenseUpgradeCost(t)
    )
      return false;
    const cost = defenseUpgradeCost(t);
    s.gold -= cost;
    t.spent += cost;
    t.level++;
    return true;
  }
  function defenseSell(s, index) {
    if (!["build", "wave"].includes(s.phase) || !s.towers[index]) return false;
    const t = s.towers.splice(index, 1)[0];
    s.gold += Math.floor(t.spent * 0.7);
    return true;
  }
  function defenseStart(s) {
    if (s.phase !== "build" || s.wave >= 12) return false;
    s.wave++;
    s.phase = "wave";
    s.spawn = 0.2;
    s.queue = Array.from({ length: 6 + s.wave }, (_, i) =>
      s.wave >= 3 && i % 4 === 0
        ? "armored"
        : s.wave >= 2 && i % 3 === 1
          ? "fast"
          : "normal",
    );
    if (s.wave % 4 === 0) s.queue.push("boss");
    return true;
  }
  function defenseEnemy(s, type) {
    const base = 24 + s.wave * 11;
    return {
      id: ++s.serial,
      type,
      progress: 0,
      hp:
        type === "boss"
          ? 160 + s.wave * 35
          : Math.round(
              base * (type === "fast" ? 0.65 : type === "armored" ? 1.35 : 1),
            ),
      maxHp:
        type === "boss"
          ? 160 + s.wave * 35
          : Math.round(
              base * (type === "fast" ? 0.65 : type === "armored" ? 1.35 : 1),
            ),
      speed: type === "boss" ? 0.48 : type === "fast" ? 1.25 : 0.72,
      armor: type === "armored" ? 3 : 0,
      slow: 0,
    };
  }
  function defenseStep(s, dt) {
    if (s.phase !== "wave") return;
    dt = clamp(dt, 0, 0.1);
    s.effects = s.effects
      .map((e) => ({ ...e, ttl: e.ttl - dt }))
      .filter((e) => e.ttl > 0);
    s.spawn = Math.max(0, s.spawn - dt);
    if (s.spawn <= 0 && s.queue.length) {
      s.enemies.push(defenseEnemy(s, s.queue.shift()));
      s.spawn = 0.8;
    }
    for (const e of s.enemies) {
      e.progress += e.speed * (e.slow > 0 ? 0.45 : 1) * dt;
      e.slow = Math.max(0, e.slow - dt);
    }
    for (const t of s.towers) {
      t.cooldown = Math.max(0, t.cooldown - dt);
      if (t.cooldown > 0) continue;
      const stats = defenseStats(t),
        targets = s.enemies
          .filter(
            (e) =>
              e.hp > 0 &&
              e.progress < PATH.length - 1 &&
              Math.hypot(
                defensePosition(e.progress).x - t.x - 0.5,
                defensePosition(e.progress).y - t.y - 0.5,
              ) <= stats.range,
          )
          .sort((a, b) => b.progress - a.progress);
      if (!targets.length) continue;
      const target = targets[0],
        pos = defensePosition(target.progress);
      t.cooldown = stats.rate;
      const hit =
        t.type === "cannon"
          ? s.enemies.filter(
              (e) =>
                e.hp > 0 &&
                Math.hypot(
                  defensePosition(e.progress).x - pos.x,
                  defensePosition(e.progress).y - pos.y,
                ) <= 1.05,
            )
          : [target];
      for (const e of hit) {
        e.hp -= Math.max(1, stats.damage - e.armor);
        if (t.type === "frost") e.slow = 1.7;
      }
      s.effects.push({
        x: t.x + 0.5,
        y: t.y + 0.5,
        tx: pos.x,
        ty: pos.y,
        type: t.type,
        ttl: 0.18,
      });
    }
    s.enemies = s.enemies.filter((e) => {
      if (e.hp <= 0) {
        s.gold += (e.type === "boss" ? 35 : 7) + Math.floor(s.wave / 3);
        s.kills++;
        return false;
      }
      if (e.progress >= PATH.length - 1) {
        s.lives -= e.type === "boss" ? 3 : 1;
        return false;
      }
      return true;
    });
    if (s.lives <= 0) {
      s.lives = 0;
      s.phase = "lost";
      return;
    }
    if (!s.queue.length && !s.enemies.length) {
      s.gold += 25 + s.wave * 4;
      s.phase = s.wave === 12 ? "won" : "build";
    }
  }
  const PIECES = [
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ];
  function blocksCells(piece) {
    const n = piece.type === 0 ? 4 : piece.type === 1 ? 2 : 3;
    return PIECES[piece.type].map(([a, b]) => {
      let x = a,
        y = b;
      for (let i = 0; i < piece.rot; i++) [x, y] = [n - 1 - y, x];
      return [x + piece.x, y + piece.y];
    });
  }
  function blocksFits(s, p) {
    return blocksCells(p).every(
      ([x, y]) => x >= 0 && x < 10 && y < 20 && (y < 0 || !s.board[y][x]),
    );
  }
  function blocksFill(s) {
    while (s.next.length < 5) {
      if (!s.bag.length) s.bag = shuffle(s, [0, 1, 2, 3, 4, 5, 6]);
      s.next.push(s.bag.pop());
    }
  }
  function blocksSpawn(s, type) {
    blocksFill(s);
    s.piece = {
      type: type === undefined ? s.next.shift() : type,
      rot: 0,
      x: 3,
      y: 0,
    };
    blocksFill(s);
    s.fall = 0;
    s.lock = 0;
    s.resets = 0;
    if (!blocksFits(s, s.piece)) s.over = true;
  }
  function blocksCreate(seed = Date.now() >>> 0) {
    const s = {
      kind: "blocks",
      version: 1,
      seed,
      board: Array.from({ length: 20 }, () => Array(10).fill(0)),
      next: [],
      bag: [],
      hold: null,
      held: false,
      piece: null,
      score: 0,
      lines: 0,
      pieces: 0,
      fall: 0,
      lock: 0,
      resets: 0,
      over: false,
    };
    blocksSpawn(s);
    return s;
  }
  function blocksGhost(s) {
    const p = { ...s.piece };
    while (blocksFits(s, { ...p, y: p.y + 1 })) p.y++;
    return p;
  }
  function blocksLock(s) {
    const cells = blocksCells(s.piece);
    if (cells.some(([, y]) => y < 0)) {
      s.over = true;
      return;
    }
    for (const [x, y] of cells) s.board[y][x] = s.piece.type + 1;
    const remaining = s.board.filter((row) => row.some((v) => !v)),
      count = 20 - remaining.length;
    s.score += [0, 100, 300, 500, 800][count] * (1 + Math.floor(s.lines / 10));
    s.lines += count;
    s.pieces++;
    while (remaining.length < 20) remaining.unshift(Array(10).fill(0));
    s.board = remaining;
    s.held = false;
    blocksSpawn(s);
  }
  function blocksAction(s, action) {
    if (s.over) return false;
    if (action === "drop") {
      const ghost = blocksGhost(s);
      s.score += (ghost.y - s.piece.y) * 2;
      s.piece = ghost;
      blocksLock(s);
      return true;
    }
    if (action === "hold") {
      if (s.held) return false;
      const type = s.piece.type,
        held = s.hold;
      s.hold = type;
      blocksSpawn(s, held === null ? undefined : held);
      s.held = true;
      return true;
    }
    const grounded = !blocksFits(s, { ...s.piece, y: s.piece.y + 1 });
    if (action === "rotate") {
      const rotated = { ...s.piece, rot: (s.piece.rot + 1) % 4 };
      for (const [dx, dy] of [
        [0, 0],
        [-1, 0],
        [1, 0],
        [-2, 0],
        [2, 0],
        [0, -1],
      ])
        if (
          blocksFits(s, { ...rotated, x: rotated.x + dx, y: rotated.y + dy })
        ) {
          s.piece = { ...rotated, x: rotated.x + dx, y: rotated.y + dy };
          if (grounded && s.resets < 10) {
            s.lock = 0;
            s.resets++;
          }
          return true;
        }
      return false;
    }
    const delta = { left: [-1, 0], right: [1, 0], down: [0, 1] }[action];
    if (!delta) return false;
    const p = { ...s.piece, x: s.piece.x + delta[0], y: s.piece.y + delta[1] };
    if (!blocksFits(s, p)) return false;
    s.piece = p;
    if (action === "down") {
      s.score++;
      s.fall = 0;
      s.lock = 0;
    } else if (grounded && s.resets < 10) {
      s.lock = 0;
      s.resets++;
    }
    return true;
  }
  function blocksStep(s, dt) {
    if (s.over) return;
    dt = clamp(dt, 0, 0.1);
    s.fall += dt;
    const interval = Math.max(
      0.09,
      0.75 * Math.pow(0.85, Math.floor(s.lines / 10)),
    );
    while (s.fall >= interval) {
      s.fall -= interval;
      const p = { ...s.piece, y: s.piece.y + 1 };
      if (blocksFits(s, p)) {
        s.piece = p;
        s.lock = 0;
      } else break;
    }
    if (!blocksFits(s, { ...s.piece, y: s.piece.y + 1 })) {
      s.lock += dt;
      if (s.lock >= 0.45) blocksLock(s);
    } else s.lock = 0;
  }
  const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const number = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  function validDungeon(s) {
    if (
      !s ||
      s.kind !== "dungeon" ||
      s.version !== 1 ||
      !integer(s.seed, 0, 4294967295) ||
      !integer(s.floor, 1, 12) ||
      !integer(s.maxHp, 1, 200) ||
      !integer(s.hp, 0, s.maxHp) ||
      !integer(s.gold, 0, 10000) ||
      !integer(s.power, 0, 40) ||
      !integer(s.armor, 0, 40) ||
      !integer(s.energy, 0, 3) ||
      !integer(s.block, 0, 1000) ||
      !integer(s.battlePower, 0, 1000) ||
      !integer(s.turn, 1, 10000) ||
      ![
        "route",
        "battle",
        "camp",
        "shop",
        "reward",
        "relic",
        "won",
        "lost",
      ].includes(s.stage)
    )
      return false;
    for (const key of ["deck", "hand", "draw", "discard", "exhaust", "rewards"])
      if (
        !Array.isArray(s[key]) ||
        s[key].length > 100 ||
        s[key].some((id) => !Object.prototype.hasOwnProperty.call(CARDS, id))
      )
        return false;
    if (
      !s.deck.length ||
      !Array.isArray(s.offers) ||
      s.offers.length > 2 ||
      s.offers.some(
        (id) => !Object.prototype.hasOwnProperty.call(ENEMIES, id),
      ) ||
      !Array.isArray(s.log) ||
      s.log.length > 4 ||
      s.log.some((v) => typeof v !== "string" || v.length > 200) ||
      !Array.isArray(s.purchased) ||
      s.purchased.some((v) => !["potion", "armor", "card"].includes(v))
    )
      return false;
    if (["battle", "reward", "relic"].includes(s.stage)) {
      const e = s.enemy;
      if (
        !e ||
        !Object.prototype.hasOwnProperty.call(ENEMIES, e.type) ||
        !integer(e.maxHp, 1, 500) ||
        !integer(e.hp, 0, e.maxHp) ||
        !integer(e.block, 0, 1000) ||
        !integer(e.poison, 0, 1000) ||
        !integer(e.weak, 0, 1000)
      )
        return false;
    }
    return true;
  }
  function validDefense(s) {
    if (
      !s ||
      s.kind !== "defense" ||
      s.version !== 1 ||
      !["build", "wave", "won", "lost"].includes(s.phase) ||
      !integer(s.wave, 0, 12) ||
      !integer(s.lives, 0, 15) ||
      !integer(s.gold, 0, 100000) ||
      !integer(s.kills, 0, 10000) ||
      !integer(s.serial, 0, 10000) ||
      !number(s.spawn, -1, 2) ||
      !Array.isArray(s.towers) ||
      s.towers.length > 81 ||
      !Array.isArray(s.enemies) ||
      s.enemies.length > 30 ||
      !Array.isArray(s.queue) ||
      s.queue.length > 30 ||
      !Array.isArray(s.effects) ||
      s.effects.length > 200
    )
      return false;
    const types = ["normal", "fast", "armored", "boss"];
    if (s.queue.some((v) => !types.includes(v))) return false;
    if (
      s.towers.some(
        (t) =>
          !t ||
          !Object.prototype.hasOwnProperty.call(TOWERS, t.type) ||
          !integer(t.x, 0, 8) ||
          !integer(t.y, 0, 8) ||
          !integer(t.level, 1, 3) ||
          !integer(t.spent, 1, 1000) ||
          !number(t.cooldown, 0, 2) ||
          PATH.some((p) => p[0] === t.x && p[1] === t.y),
      )
    )
      return false;
    if (new Set(s.towers.map((t) => t.x + "," + t.y)).size !== s.towers.length)
      return false;
    return (
      s.enemies.every(
        (e) =>
          e &&
          types.includes(e.type) &&
          integer(e.id, 1, 10000) &&
          number(e.progress, 0, PATH.length - 1) &&
          number(e.maxHp, 1, 2000) &&
          number(e.hp, 0.00001, e.maxHp) &&
          number(e.speed, 0.1, 2) &&
          number(e.armor, 0, 10) &&
          number(e.slow, 0, 2),
      ) &&
      s.effects.every(
        (e) =>
          e &&
          ["x", "y", "tx", "ty"].every((k) => number(e[k], 0, 9)) &&
          Object.prototype.hasOwnProperty.call(TOWERS, e.type) &&
          number(e.ttl, 0, 1),
      )
    );
  }
  function validBlocks(s) {
    if (
      !s ||
      s.kind !== "blocks" ||
      s.version !== 1 ||
      !integer(s.seed, 0, 4294967295) ||
      !Array.isArray(s.board) ||
      s.board.length !== 20 ||
      s.board.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 10 ||
          row.some((v) => !integer(v, 0, 7)),
      ) ||
      !Array.isArray(s.next) ||
      s.next.length !== 5 ||
      s.next.some((v) => !integer(v, 0, 6)) ||
      !Array.isArray(s.bag) ||
      s.bag.length > 7 ||
      s.bag.some((v) => !integer(v, 0, 6)) ||
      !(s.hold === null || integer(s.hold, 0, 6)) ||
      typeof s.held !== "boolean" ||
      typeof s.over !== "boolean" ||
      !integer(s.score, 0, 1e9) ||
      !integer(s.lines, 0, 100000) ||
      !integer(s.pieces, 0, 1000000) ||
      !number(s.fall, 0, 1) ||
      !number(s.lock, 0, 1) ||
      !integer(s.resets, 0, 10)
    )
      return false;
    const p = s.piece;
    return (
      !!p &&
      integer(p.type, 0, 6) &&
      integer(p.rot, 0, 3) &&
      integer(p.x, -3, 9) &&
      integer(p.y, -4, 20) &&
      (s.over || blocksFits(s, p))
    );
  }
  const api = {
    clone,
    CARDS,
    ENEMIES,
    dungeonCreate,
    dungeonEnter,
    dungeonPlay,
    dungeonEnd,
    dungeonChoose,
    dungeonIntent,
    validDungeon,
    PATH,
    TOWERS,
    defenseCreate,
    defensePosition,
    defenseStats,
    defenseBuild,
    defenseUpgradeCost,
    defenseUpgrade,
    defenseSell,
    defenseStart,
    defenseStep,
    validDefense,
    PIECES,
    blocksCreate,
    blocksCells,
    blocksFits,
    blocksGhost,
    blocksAction,
    blocksStep,
    validBlocks,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExtraGamesCore = api;
})(globalThis);
