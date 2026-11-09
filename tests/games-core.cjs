const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../news/assets/games-core.js");
const step = (s, input = {}, seconds = 1 / 120) =>
  C.step(s, seconds, input, () => 0.5);

test("brick impacts score once and preserve ball speed", () => {
  const s = C.create("breakout");
  s.wait = 0;
  s.ball = { x: 37, y: 53, vx: 0, vy: 240, r: 6 };
  step(s);
  assert.equal(s.bricks[0].hp, 0);
  assert.equal(s.score, 10);
  assert.equal(s.ball.vy, -240);
  step(s);
  assert.equal(s.score, 10);
});
test("paddle rebounds upward, wall clamps, three missed balls end game", () => {
  const s = C.create("breakout");
  s.wait = 0;
  s.ball = { x: 180, y: 391, vx: 20, vy: 300, r: 6 };
  step(s);
  assert(s.ball.vy < 0);
  s.ball = { x: 6, y: 300, vx: -240, vy: 10, r: 6 };
  step(s);
  assert(s.ball.vx > 0);
  assert.equal(s.ball.x, 6);
  for (let i = 0; i < 3; i++) {
    s.wait = 0;
    s.ball.y = 480;
    step(s);
  }
  assert.equal(s.lives, 0);
  assert(s.ended);
});
test("clearing a wall advances level and completing five wins", () => {
  const s = C.create("breakout");
  s.wait = 0;
  s.bricks.forEach((b) => (b.hp = 0));
  step(s);
  assert.equal(s.level, 2);
  assert.equal(s.bricks.length, 35);
  s.level = 5;
  s.wait = 0;
  s.bricks.forEach((b) => (b.hp = 0));
  step(s);
  assert(s.won && s.ended);
});
test("shooter bullets hit once and remove defeated enemies", () => {
  const s = C.create("shooter");
  s.fire = 1;
  s.spawn = 1;
  s.enemies = [{ x: 100, y: 100, w: 26, h: 28, speed: 0, hp: 1 }];
  s.bullets = [{ x: 110, y: 105, w: 4, h: 12 }];
  step(s);
  assert.equal(s.score, 20);
  assert.equal(s.enemies.length, 0);
  assert.equal(s.bullets.length, 0);
});
test("shooter damage has grace period and escaped enemies cost a life", () => {
  const s = C.create("shooter");
  s.spawn = 10;
  const enemy = (y) => ({ x: 170, y, w: 26, h: 28, speed: 0, hp: 1 });
  s.enemies = [enemy(382), enemy(382)];
  step(s);
  assert.equal(s.lives, 2);
  s.enemies = [enemy(461)];
  step(s);
  assert.equal(s.lives, 1);
  s.enemies = [enemy(461)];
  step(s);
  assert(s.ended);
});
test("runner permits exactly two jumps, resets on landing, collides with obstacle", () => {
  const s = C.create("runner");
  s.spawn = 100;
  assert(C.jump(s));
  step(s);
  assert(s.player.y < 342);
  assert(C.jump(s));
  assert.equal(C.jump(s), false);
  for (let i = 0; i < 150; i++) step(s);
  assert.equal(s.player.y, 342);
  assert.equal(s.jumps, 0);
  assert(s.score > 0);
  s.obstacles = [{ x: 65, y: 340, w: 30, h: 30 }];
  step(s);
  assert(s.ended);
});
test("controls stay within boundaries and ended rounds freeze", () => {
  for (const kind of ["breakout", "shooter", "runner"]) {
    const s = C.create(kind);
    step(s, { x: -1000, y: -1000 });
    if (kind === "breakout") assert.equal(s.paddle, 39);
    if (kind === "shooter") {
      assert.equal(s.player.x, 4);
      assert.equal(s.player.y, 165);
    }
    s.ended = true;
    const before = JSON.stringify(s);
    step(s);
    assert.equal(JSON.stringify(s), before);
  }
});

test("tall and landscape playfields keep controls and ground inside the visible world", () => {
  for (const size of [
    { width: 360, height: 720 },
    { width: 960, height: 460 },
  ]) {
    const b = C.create("breakout", size);
    assert.equal(b.ball.y, size.height - 85);
    step(b, { x: 9999 });
    assert.equal(b.paddle, size.width - 39);
    const s = C.create("shooter", size);
    step(s, { x: 9999, y: 9999 });
    assert.equal(s.player.x, size.width - 28);
    assert.equal(s.player.y, size.height - 36);
    const r = C.create("runner", size);
    assert.equal(r.player.y, size.height - 118);
    C.resize(r, 360, 640);
    assert.equal(r.player.y, 522);
  }
});
