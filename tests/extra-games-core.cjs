const test = require("node:test"),
  assert = require("node:assert/strict");
const C = require("../news/assets/extra-games-core.js");
const battle = () => {
  const s = C.dungeonCreate(9);
  C.dungeonEnter(s, 0);
  return s;
};
test("Dungeon shuffle is reproducible and a fight starts with five cards and three energy", () => {
  const s = battle();
  assert.deepEqual(s, battle());
  assert(C.validDungeon(s));
  assert.equal(s.hand.length, 5);
  assert.equal(s.draw.length, 7);
  assert.equal(s.energy, 3);
  const before = C.clone(s);
  assert.equal(C.dungeonPlay(s, 99), false);
  assert.deepEqual(s, before);
  s.energy = 0;
  const index = s.hand.findIndex((id) => C.CARDS[id].cost > 0);
  const zero = C.clone(s);
  assert.equal(C.dungeonPlay(s, index), false);
  assert.deepEqual(s, zero);
});
test("Cards apply repeated attacks, armor, shield, healing and battle-only bonuses", () => {
  const s = battle();
  s.hand = ["focus", "sweep", "guard", "mend"];
  s.enemy.hp = 100;
  s.enemy.maxHp = 100;
  s.enemy.block = 3;
  s.hp = 40;
  s.power = 1;
  assert(C.dungeonPlay(s, 0));
  assert.equal(s.battlePower, 2);
  assert(s.exhaust.includes("focus"));
  assert(C.dungeonPlay(s, 0));
  assert.equal(s.enemy.hp, 89);
  assert.equal(s.enemy.block, 0);
  assert(C.dungeonPlay(s, 0));
  assert.equal(s.block, 7);
  assert(C.dungeonPlay(s, 0));
  assert.equal(s.hp, 44);
  assert.equal(s.energy, 0);
  assert(s.exhaust.includes("mend"));
});
test("Enemy intent resolves against shield, then energy and equipment shields reset", () => {
  const s = battle();
  s.enemy.type = "scout";
  s.block = 3;
  s.armor = 2;
  s.energy = 0;
  const hp = s.hp,
    intent = C.dungeonIntent(s);
  assert.equal(intent.type, "attack");
  assert(C.dungeonEnd(s));
  assert.equal(s.hp, hp - (intent.amount - 3));
  assert.equal(s.block, 2);
  assert.equal(s.energy, 3);
  assert.equal(s.hand.length, 5);
  assert.equal(s.turn, 2);
  assert(C.validDungeon(s));
});
test("Poison can finish an enemy before its attack and rewards cannot be claimed twice", () => {
  const s = battle();
  s.enemy.hp = 3;
  s.enemy.poison = 4;
  const hp = s.hp;
  C.dungeonEnd(s);
  assert.equal(s.hp, hp);
  assert.equal(s.stage, "reward");
  const deck = s.deck.length;
  assert(C.dungeonChoose(s, 0));
  assert.equal(s.deck.length, deck + 1);
  assert.equal(s.floor, 2);
  assert.equal(C.dungeonChoose(s, 0), false);
  assert.equal(s.deck.length, deck + 1);
  assert(C.validDungeon(s));
});
test("Camp and shop persist permanent upgrades, enforce prices and single purchases", () => {
  const s = battle();
  s.stage = "camp";
  s.floor = 3;
  s.hp = 20;
  s.gold = 100;
  C.dungeonChoose(s, "shop");
  assert(C.dungeonChoose(s, "potion"));
  assert.equal(s.hp, 42);
  assert.equal(s.gold, 80);
  assert.equal(C.dungeonChoose(s, "potion"), false);
  assert(C.dungeonChoose(s, "armor"));
  assert.equal(s.armor, 2);
  assert(C.dungeonChoose(s, "card"));
  assert.equal(s.gold, 15);
  assert.equal(C.dungeonChoose(s, "armor"), false);
  C.dungeonChoose(s, "leave");
  assert.equal(s.floor, 4);
  assert.deepEqual(s.offers, ["boss"]);
  assert(C.validDungeon(s));
});
test("Boss equipment choices work and the final boss and player death have terminal outcomes", () => {
  const s = battle();
  s.floor = 4;
  s.enemy.type = "boss";
  s.enemy.hp = 1;
  s.hand = ["strike"];
  C.dungeonPlay(s, 0);
  assert.equal(s.stage, "relic");
  C.dungeonChoose(s, "mail");
  assert.equal(s.armor, 4);
  assert.equal(s.stage, "reward");
  C.dungeonChoose(s, "skip");
  assert.equal(s.floor, 5);
  C.dungeonEnter(s, 0);
  s.floor = 12;
  s.enemy.type = "boss";
  s.enemy.hp = 1;
  s.hand = ["strike"];
  C.dungeonPlay(s, 0);
  assert.equal(s.stage, "won");
  assert(C.validDungeon(s));
  const lost = battle();
  lost.hp = 1;
  lost.block = 0;
  lost.enemy.type = "scout";
  C.dungeonEnd(lost);
  assert.equal(lost.stage, "lost");
  assert.equal(lost.hp, 0);
});
test("Tower placement, upgrades and sale respect sites, money and level limits", () => {
  const s = C.defenseCreate();
  assert.equal(C.defenseBuild(s, 0, 1, "arrow"), false);
  assert.equal(C.defenseBuild(s, -1, 0, "arrow"), false);
  assert(C.defenseBuild(s, 4, 4, "arrow"));
  assert.equal(s.gold, 135);
  assert.equal(C.defenseBuild(s, 4, 4, "frost"), false);
  assert(C.defenseUpgrade(s, 0));
  assert(C.defenseUpgrade(s, 0));
  assert.equal(s.towers[0].level, 3);
  assert.equal(C.defenseUpgrade(s, 0), false);
  const before = s.gold,
    refund = Math.floor(s.towers[0].spent * 0.7);
  assert(C.defenseSell(s, 0));
  assert.equal(s.gold, before + refund);
  assert(s.gold < 180);
  assert(C.validDefense(s));
});
function firing(type) {
  const s = C.defenseCreate();
  C.defenseBuild(s, 4, 2, type);
  C.defenseStart(s);
  s.queue = [];
  s.enemies = [
    {
      id: 1,
      type: "normal",
      progress: 4,
      hp: 100,
      maxHp: 100,
      speed: 0.72,
      armor: 3,
      slow: 0,
    },
  ];
  return s;
}
test("Arrow damage respects armor, frost slows, cannon splashes only nearby targets", () => {
  const arrow = firing("arrow");
  C.defenseStep(arrow, 0.01);
  assert.equal(arrow.enemies[0].hp, 95);
  const frost = firing("frost");
  C.defenseStep(frost, 0.01);
  assert.equal(frost.enemies[0].hp, 99);
  assert(frost.enemies[0].slow > 1);
  const cannon = firing("cannon");
  cannon.enemies.push(
    { ...cannon.enemies[0], id: 2, progress: 4.5 },
    { ...cannon.enemies[0], id: 3, progress: 18 },
  );
  C.defenseStep(cannon, 0.01);
  assert.equal(cannon.enemies[0].hp, 83);
  assert.equal(cannon.enemies[1].hp, 83);
  assert.equal(cannon.enemies[2].hp, 100);
});
test("Kills and wave bonuses pay once, bosses cost three lives and wave twelve wins", () => {
  const s = firing("arrow");
  s.enemies[0].hp = 1;
  const gold = s.gold;
  C.defenseStep(s, 0.01);
  assert.equal(s.kills, 1);
  assert.equal(s.phase, "build");
  assert(s.gold > gold);
  const after = s.gold;
  C.defenseStep(s, 0.1);
  assert.equal(s.gold, after);
  const fail = firing("arrow");
  fail.lives = 3;
  fail.enemies[0].type = "boss";
  fail.enemies[0].progress = C.PATH.length - 1.01;
  C.defenseStep(fail, 0.1);
  assert.equal(fail.phase, "lost");
  assert.equal(fail.lives, 0);
  const won = C.defenseCreate();
  won.wave = 12;
  won.phase = "wave";
  C.defenseStep(won, 0.1);
  assert.equal(won.phase, "won");
  assert(C.validDefense(won));
});
test("A planned mix of towers can complete all twelve waves with valid resumable states", () => {
  const s = C.defenseCreate(),
    plan = [
      [5, 2, "cannon"],
      [4, 4, "frost"],
      [3, 2, "arrow"],
      [5, 4, "arrow"],
      [6, 6, "cannon"],
      [3, 4, "arrow"],
      [4, 6, "frost"],
      [5, 6, "arrow"],
    ];
  for (
    let tick = 0;
    tick < 10000 && !["won", "lost"].includes(s.phase);
    tick++
  ) {
    if (s.phase === "build") {
      for (const [x, y, type] of plan)
        if (!s.towers.some((t) => t.x === x && t.y === y))
          C.defenseBuild(s, x, y, type);
      for (let i = 0; i < s.towers.length; i++) C.defenseUpgrade(s, i);
      C.defenseStart(s);
    }
    C.defenseStep(s, 0.1);
    assert(C.validDefense(s));
  }
  assert.equal(s.phase, "won");
  assert.equal(s.wave, 12);
});
test("Falling blocks use bags of seven distinct pieces and reproducible random order", () => {
  const s = C.blocksCreate(9);
  assert.deepEqual(s, C.blocksCreate(9));
  const order = [];
  for (let i = 0; i < 14; i++) {
    order.push(s.piece.type);
    C.blocksAction(s, "drop");
    s.board = Array.from({ length: 20 }, () => Array(10).fill(0));
    assert(C.validBlocks(s));
  }
  assert.equal(new Set(order.slice(0, 7)).size, 7);
  assert.equal(new Set(order.slice(7)).size, 7);
});
test("Block rotation kicks away from walls, rejects collisions and hold is once per piece", () => {
  const s = C.blocksCreate(9);
  s.piece = { type: 0, rot: 1, x: -2, y: 2 };
  assert(C.blocksFits(s, s.piece));
  assert(C.blocksAction(s, "rotate"));
  assert(C.blocksFits(s, s.piece));
  while (C.blocksAction(s, "left")) {}
  const before = C.clone(s);
  assert.equal(C.blocksAction(s, "left"), false);
  assert.deepEqual(s, before);
  const type = s.piece.type;
  assert(C.blocksAction(s, "hold"));
  assert.equal(s.hold, type);
  assert.equal(C.blocksAction(s, "hold"), false);
  C.blocksAction(s, "drop");
  assert(C.blocksAction(s, "hold"));
  assert.equal(s.piece.type, type);
  assert(C.validBlocks(s));
});
test("Hard drop clears four rows together, scores correctly and advances the queue", () => {
  const s = C.blocksCreate(4);
  for (let y = 16; y < 20; y++)
    s.board[y] = Array.from({ length: 10 }, (_, x) => (x === 4 ? 0 : 1));
  s.piece = { type: 0, rot: 1, x: 2, y: 0 };
  const next = s.next[0];
  assert.equal(C.blocksGhost(s).y, 16);
  C.blocksAction(s, "drop");
  assert.equal(s.lines, 4);
  assert.equal(s.score, 832);
  assert.equal(s.piece.type, next);
  assert(s.board.flat().every((v) => !v));
  assert(C.validBlocks(s));
});
test("Gravity and lock delay progress, a blocked spawn ends the run and saves reject corruption", () => {
  const s = C.blocksCreate(3);
  for (let i = 0; i < 10; i++) C.blocksStep(s, 0.1);
  assert(s.piece.y > 0);
  assert.equal(s.score, 0);
  s.piece = C.blocksGhost(s);
  for (let i = 0; i < 5; i++) C.blocksStep(s, 0.1);
  assert.equal(s.pieces, 1);
  s.board[0].fill(1);
  s.board[1].fill(1);
  C.blocksAction(s, "hold");
  assert(s.over);
  assert(C.validBlocks(s));
  assert.equal(C.validBlocks({ ...s, score: NaN }), false);
  assert.equal(C.validDefense({ ...C.defenseCreate(), towers: [{}] }), false);
  assert.equal(
    C.validDungeon({ ...C.dungeonCreate(1), deck: ["constructor"] }),
    false,
  );
  for (const value of [null, {}, [], { kind: "blocks" }])
    for (const validate of [C.validDungeon, C.validDefense, C.validBlocks])
      assert.equal(validate(value), false);
});
