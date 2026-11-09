const test = require("node:test"),
  assert = require("node:assert/strict");
const C = require("../news/assets/casual-games-core.js");
function fly(s, charge) {
  assert(C.jumpPress(s));
  for (let t = 0; t < charge;) {
    const dt = Math.min(0.05, charge - t);
    C.jumpStep(s, dt);
    t += dt;
  }
  assert(C.jumpRelease(s));
  for (let i = 0; i < 14; i++) C.jumpStep(s, 0.05);
}
test("Jump centers reward streaks, generate reachable targets and round-trip progress", () => {
  const s = C.jumpCreate(123);
  assert.deepEqual(s, C.jumpCreate(123));
  for (let i = 0; i < 40; i++) {
    const distance = Math.hypot(
      s.target.x - s.player.x,
      s.target.y - s.player.y,
    );
    fly(s, (distance - 65) / 170);
    assert.equal(s.phase, "ready");
    assert.equal(s.jumps, i + 1);
    assert.equal(s.streak, i + 1);
    assert(C.validJump(C.clone(s)));
  }
  assert(s.score > 200);
});
test("Jump short launches miss, charge caps, cancelled holds do not jump and flight is saved", () => {
  const s = C.jumpCreate(1);
  C.jumpPress(s);
  C.jumpStep(s, 0.1);
  C.jumpCancel(s);
  assert.equal(s.phase, "ready");
  assert.equal(s.charge, 0);
  C.jumpPress(s);
  for (let i = 0; i < 100; i++) C.jumpStep(s, 0.1);
  assert.equal(s.charge, 1.3);
  C.jumpCancel(s);
  C.jumpPress(s);
  C.jumpRelease(s);
  C.jumpStep(s, 0.1);
  assert(C.validJump(s));
  const resumed = C.clone(s);
  for (let i = 0; i < 10; i++) {
    C.jumpStep(s, 0.1);
    C.jumpStep(resumed, 0.1);
  }
  assert.deepEqual(resumed, s);
  assert.equal(s.phase, "over");
  assert.equal(s.score, 0);
  assert(!C.jumpPress(s));
  const bad = C.clone(s);
  bad.target.r = 0;
  assert(!C.validJump(bad));
});
test("Match boards start without matches, always have a move, and legal moves settle with a move", () => {
  for (let seed = 0; seed < 80; seed++) {
    const s = C.matchCreate(seed);
    assert(C.validMatch(s));
    assert.equal(C.matchGroups(s.board).length, 0);
    for (let i = 0; i < 12 && s.phase === "playing"; i++) {
      const [a, b] = C.matchHint(s.board),
        moves = s.moves,
        score = s.score;
      const result = C.matchSwap(s, a, b);
      assert(result.frames.length);
      assert.equal(s.moves, moves - 1);
      assert(s.score >= score + 30);
      assert(C.validMatch(C.clone(s)));
    }
  }
});
test("Invalid match swaps never spend a move, wrap rows, mutate RNG or score", () => {
  const s = C.matchCreate(4),
    before = C.clone(s);
  assert.equal(C.matchSwap(s, 6, 7), null);
  assert.equal(C.matchSwap(s, 0, 14), null);
  assert.equal(C.matchSwap(s, -1, 0), null);
  assert.deepEqual(s, before);
  let found = false;
  for (let a = 0; a < 48; a++) {
    const prior = C.clone(s);
    const result = C.matchSwap(s, a, a + 1);
    if (!result) {
      assert.deepEqual(s, prior);
      found = true;
      break;
    }
  }
  assert(found);
  assert.deepEqual(
    C.matchGroups(Array(49).fill(2)).sort((a, b) => a - b),
    Array.from({ length: 49 }, (_, i) => i),
  );
});
test("Match cascades score each unique tile, goals advance, shuffle costs two and no moves ends round", () => {
  const s = C.matchCreate(8);
  s.roundScore = 990;
  s.score = 990;
  const hint = C.matchHint(s.board);
  const result = C.matchSwap(s, ...hint);
  const points = result.frames.reduce(
    (sum, f) => sum + f.removed.length * 10 * Math.min(f.combo, 5),
    0,
  );
  assert.equal(s.score, 990 + points);
  assert.equal(s.phase, "clear");
  assert(C.validMatch(s));
  assert(C.matchNext(s));
  assert.equal(s.level, 2);
  assert.equal(s.moves, 28);
  assert.equal(s.target, 1250);
  assert(C.matchShuffle(s));
  assert.equal(s.moves, 26);
  assert(C.validMatch(s));
  const doomed = C.matchCreate(1);
  doomed.moves = 1;
  C.matchSwap(doomed, ...C.matchHint(doomed.board));
  assert.equal(doomed.phase, "lost");
  assert(!C.matchNext(doomed));
  assert(!C.matchShuffle(doomed));
  assert(C.validMatch(doomed));
  const bad = C.clone(doomed);
  bad.board = Array(49).fill(1);
  assert(!C.validMatch(bad));
});
test("Mines first click and all neighbors are safe across every difficulty; saves have consistent counts", () => {
  for (const level of Object.keys(C.MINE_LEVELS))
    for (let seed = 0; seed < 35; seed++) {
      const s = C.mineCreate(level, seed),
        first = (seed * 17) % s.board.length;
      assert(C.validMines(s));
      assert(C.mineReveal(s, first));
      assert.equal(s.board[first], 0);
      for (const i of C.mineNeighbors(s, first))
        assert.notEqual(s.board[i], -1);
      assert.equal(s.board.filter((v) => v === -1).length, s.mines);
      assert(C.validMines(C.clone(s)));
    }
});
test("Mines flags toggle, block reveal, are limited and invalid actions do not mutate", () => {
  const s = C.mineCreate("easy", 1);
  for (let i = 0; i < 10; i++) assert(C.mineFlag(s, i));
  assert(!C.mineFlag(s, 10));
  const before = C.clone(s);
  assert(!C.mineReveal(s, 0));
  assert(!C.mineFlag(s, -1));
  assert(!C.mineReveal(s, 99));
  assert.deepEqual(s, before);
  assert(C.mineFlag(s, 0));
  assert(C.mineReveal(s, 0));
  assert(s.started);
  assert(C.validMines(s));
});
test("Mines wins by opening all safe cells, loses on a mine, and cannot act after finish", () => {
  const win = C.mineCreate("normal", 42);
  C.mineReveal(win, 0);
  for (let i = 0; i < win.board.length; i++)
    if (win.board[i] !== -1) C.mineReveal(win, i);
  assert.equal(win.phase, "won");
  assert(C.validMines(win));
  assert.equal(win.flags.filter(Boolean).length, win.mines);
  assert(!C.mineFlag(win, win.board.indexOf(-1)));
  const lose = C.mineCreate("hard", 42);
  C.mineReveal(lose, 0);
  const hit = lose.board.indexOf(-1);
  assert(C.mineReveal(lose, hit));
  assert.equal(lose.hit, hit);
  assert.equal(lose.phase, "lost");
  assert(C.validMines(lose));
  assert(!C.mineReveal(lose, 1));
});
test("Mines number chords reveal with correct flags and punish incorrect flags", () => {
  const source = C.mineCreate("normal", 22);
  C.mineReveal(source, 40);
  const target = source.board.findIndex(
    (n, i) =>
      source.open[i] &&
      n > 0 &&
      C.mineNeighbors(source, i).some(
        (j) => !source.open[j] && source.board[j] !== -1,
      ),
  );
  assert(target >= 0);
  const neighbors = C.mineNeighbors(source, target),
    mines = neighbors.filter((i) => source.board[i] === -1),
    safe = neighbors.find((i) => !source.open[i] && source.board[i] !== -1);
  const correct = C.clone(source);
  mines.forEach((i) => C.mineFlag(correct, i));
  assert(C.mineReveal(correct, target));
  assert(correct.open[safe]);
  assert.notEqual(correct.phase, "lost");
  assert(C.validMines(correct));
  const wrong = C.clone(source);
  mines.slice(1).forEach((i) => C.mineFlag(wrong, i));
  C.mineFlag(wrong, safe);
  assert(C.mineReveal(wrong, target));
  assert.equal(wrong.phase, "lost");
  assert(C.validMines(wrong));
});
test("Invalid or mismatched stored states are rejected", () => {
  for (const validate of [C.validMines, C.validMatch, C.validJump])
    for (const bad of [
      null,
      {},
      [],
      false,
      { version: 1, kind: "mines", level: "__proto__" },
    ])
      assert(!validate(bad));
  const s = C.mineCreate();
  C.mineReveal(s, 0);
  s.board[s.board.findIndex((n) => n > 0)] = 8;
  assert(!C.validMines(s));
});

test("Jump previews become real targets and the last two platforms remain in the route", () => {
  const s = C.jumpCreate(71);
  for (let i = 0; i < 70; i++) {
    const target = { ...s.target },
      preview = { ...s.upcoming[0] };
    fly(
      s,
      (Math.hypot(target.x - s.player.x, target.y - s.player.y) - 65) / 170,
    );
    assert.equal(s.phase, "ready");
    assert.deepEqual(s.target, {
      x: preview.x - target.x,
      y: preview.y - target.y,
      r: preview.r,
    });
    assert.equal(s.upcoming.length, 2);
    assert.equal(s.trail.length, Math.min(i + 1, 2));
    assert.equal(s.trail[s.trail.length - 1].x, -target.x);
    assert(s.trail.every((p) => p.y > 0));
    assert(s.upcoming[0].y < s.target.y && s.upcoming[1].y < s.upcoming[0].y);
    assert(C.validJump(C.clone(s)));
  }
});
test("Original jump saves upgrade without replacing scores, landing targets or in-flight progress", () => {
  const s = C.jumpCreate(12);
  fly(s, (Math.hypot(s.target.x, s.target.y) - 65) / 170);
  C.jumpPress(s);
  C.jumpStep(s, 0.1);
  C.jumpRelease(s);
  C.jumpStep(s, 0.1);
  delete s.trail;
  delete s.upcoming;
  assert(C.validJump(s));
  const before = C.clone(s);
  C.jumpPrepare(s);
  for (const key of [
    "score",
    "jumps",
    "streak",
    "phase",
    "charge",
    "elapsed",
    "current",
    "target",
    "player",
    "flight",
  ])
    assert.deepEqual(s[key], before[key]);
  assert.equal(s.upcoming.length, 2);
  assert(C.validJump(s));
  const prepared = C.clone(s);
  C.jumpPrepare(s);
  assert.deepEqual(s, prepared);
  const bad = C.clone(s);
  bad.upcoming[0].x = Infinity;
  assert(!C.validJump(bad));
  const partial = C.clone(s);
  delete partial.trail;
  assert(!C.validJump(partial));
});
