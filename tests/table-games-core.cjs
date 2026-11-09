const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../news/assets/table-games-core.js");
function seeded(seed = 31) {
  return () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}
function fixture(suits = 2) {
  return {
    kind: "spider",
    suits,
    columns: Array.from({ length: 10 }, () => []),
    stock: [],
    completed: [],
    moves: 0,
  };
}
const card = (rank, suit = 0, up = true) => ({ id: rank - 1 + 13 * suit, up });

test("Spider deals 104 distinct cards, ten face-up cards, and fifty stock cards", () => {
  for (const suits of [1, 2]) {
    const s = C.createSpider(suits, seeded());
    assert(C.validSpider(s));
    assert.deepEqual(
      s.columns.map((c) => c.length),
      [6, 6, 6, 6, 5, 5, 5, 5, 5, 5],
    );
    assert.equal(s.columns.flat().filter((c) => c.up).length, 10);
    assert.equal(s.stock.length, 50);
    for (let n = 0; n < 5; n++) {
      assert(C.spiderDeal(s));
      assert(C.validSpider(s));
    }
    const snapshot = C.clone(s);
    assert.equal(C.spiderDeal(s), false);
    assert.deepEqual(s, snapshot);
  }
});
test("Spider only moves ordered same-suit tails but can land on another suit", () => {
  const s = fixture();
  s.columns[0] = [card(9), card(8), card(7, 1)];
  s.columns[1] = [card(10, 1)];
  assert.equal(C.spiderSequence(s, 0, 0), false);
  assert.equal(C.spiderMove(s, 0, 0, 1), false);
  s.columns[0].pop();
  assert(C.spiderMove(s, 0, 0, 1));
  assert.deepEqual(s.columns[1].map(C.rank), [10, 9, 8]);
  assert.equal(C.spiderSequence(s, 1, 0), false);
  assert(C.spiderSequence(s, 1, 1));
  assert(C.spiderMove(s, 1, 1, 2));
  assert.equal(s.moves, 2);
  assert.equal(C.spiderMove(s, 2, 0, 2), false);
});
test("Spider flipping, completed run collection and undo keep every card", () => {
  const s = fixture(1);
  s.columns[0] = [
    { id: 13, up: false },
    ...Array.from({ length: 12 }, (_, i) => card(13 - i)),
  ];
  s.columns[1] = [card(1)];
  const used = new Set(s.columns.flat().map((c) => c.id));
  s.columns[2] = Array.from({ length: 104 }, (_, id) => ({
    id,
    up: true,
  })).filter((c) => !used.has(c.id));
  const before = C.clone(s);
  assert(C.validSpider(before));
  assert(C.spiderMove(s, 1, 0, 0));
  assert.equal(s.completed.length, 1);
  assert.equal(s.columns[0].length, 1);
  assert(s.columns[0][0].up);
  assert(C.validSpider(s));
  assert.equal(before.completed.length, 0);
  assert.equal(before.columns[0][0].up, false);
  assert(C.validSpider(before));
});
test("Empty columns block dealing without consuming cards; hints are legal", () => {
  const s = C.createSpider(2, seeded(55));
  const hints = C.spiderHints(s);
  assert(hints.length);
  for (const h of hints) assert(C.spiderCanMove(s, h.from, h.index, h.to));
  s.columns[0].push(...s.columns[1]);
  s.columns[1] = [];
  s.columns[0].forEach((card) => (card.up = true));
  const before = C.clone(s);
  assert.equal(C.spiderDeal(s), false);
  assert.deepEqual(s, before);
  for (let i = 0; i < 100; i++) {
    const h = C.spiderHints(s)[0];
    if (!h) break;
    assert(C.spiderMove(s, h.from, h.index, h.to));
    assert(C.validSpider(s));
  }
});
// Independent constraint solver checks that each puzzle has exactly one solution.
function countSolutions(input) {
  const board = [...input];
  let count = 0;
  function solve() {
    if (count > 1) return;
    let best = -1,
      options = [];
    for (let i = 0; i < 81; i++)
      if (!board[i]) {
        const r = Math.floor(i / 9),
          c = i % 9,
          used = new Set();
        for (let j = 0; j < 9; j++) {
          used.add(board[r * 9 + j]);
          used.add(board[j * 9 + c]);
          used.add(
            board[
              (Math.floor(r / 3) * 3 + Math.floor(j / 3)) * 9 +
                Math.floor(c / 3) * 3 +
                (j % 3)
            ],
          );
        }
        const possible = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
          (n) => !used.has(n),
        );
        if (!possible.length) return;
        if (best < 0 || possible.length < options.length) {
          best = i;
          options = possible;
        }
      }
    if (best < 0) {
      count++;
      return;
    }
    for (const n of options) {
      board[best] = n;
      solve();
      if (count > 1) break;
    }
    board[best] = 0;
  }
  solve();
  return count;
}
test("All original Sudoku templates and randomized variants have unique solutions", () => {
  for (const [difficulty, templates] of Object.entries(C.templates)) {
    for (const template of templates)
      assert.equal(countSolutions([...template.puzzle].map(Number)), 1);
    for (let i = 1; i <= 8; i++) {
      const s = C.createSudoku(difficulty, seeded(i));
      assert(C.validSudoku(s));
      assert.equal(
        s.givens.filter(Boolean).length,
        { easy: 42, normal: 34, hard: 28 }[difficulty],
      );
      assert.equal(countSolutions(s.givens), 1);
      assert.equal(C.sudokuComplete(s), false);
      assert.equal(C.peers(i).length, 20);
    }
  }
});
test("Sudoku givens cannot change, notes toggle and filled numbers remove peer notes", () => {
  const s = C.createSudoku("hard", seeded());
  const given = s.givens.findIndex(Boolean),
    i = s.givens.findIndex((n) => !n),
    j = C.peers(i).find((n) => !s.givens[n]);
  const before = C.clone(s);
  assert.equal(C.sudokuWrite(s, given, 0), false);
  assert.deepEqual(s, before);
  assert(C.sudokuWrite(s, i, 3, true));
  assert.equal(s.notes[i], 4);
  assert.equal(s.values[i], 0);
  assert(C.sudokuWrite(s, i, 3, true));
  assert.equal(s.notes[i], 0);
  C.sudokuWrite(s, j, 3, true);
  C.sudokuWrite(s, i, 3);
  assert.equal(s.notes[j], 0);
  assert.equal(s.values[i], 3);
  assert.equal(C.sudokuWrite(s, i, 2, true), false);
  C.sudokuWrite(s, j, 3);
  assert(C.conflicts(s.values)[i]);
  assert(C.conflicts(s.values)[j]);
  assert(C.validSudoku(s), "conflicting user entries are valid save data");
  C.sudokuWrite(s, i, 0);
  assert.equal(s.values[i], 0);
});
test("Hints correct selected cells, count uses, and recognize completion", () => {
  const s = C.createSudoku("normal", seeded()),
    i = s.givens.findIndex((n) => !n);
  C.sudokuWrite(s, i, (s.solution[i] % 9) + 1);
  assert.equal(C.sudokuHint(s, i), i);
  assert.equal(s.values[i], s.solution[i]);
  assert.equal(s.hints, 1);
  while (!C.sudokuComplete(s)) assert(C.sudokuHint(s, -1) >= 0);
  assert.equal(C.sudokuHint(s, i), -1);
  assert(C.validSudoku(s));
});
test("Invalid, truncated and duplicated stored game data is rejected", () => {
  for (const value of [null, {}, [], { kind: "spider" }, { kind: "sudoku" }]) {
    assert.equal(C.validSpider(value), false);
    assert.equal(C.validSudoku(value), false);
  }
  let s = C.createSpider();
  s.stock[0].id = s.stock[1].id;
  assert.equal(C.validSpider(s), false);
  s = C.createSudoku();
  s.notes.pop();
  assert.equal(C.validSudoku(s), false);
  s = C.createSudoku();
  s.solution[0] = s.solution[1];
  assert.equal(C.validSudoku(s), false);
  s = C.createSudoku();
  s.values[s.givens.findIndex(Boolean)] = 0;
  assert.equal(C.validSudoku(s), false);
});
