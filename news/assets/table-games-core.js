/* Original offline card and puzzle rules. */
(function (root) {
  "use strict";
  const templates = {
    easy: [
      {
        puzzle:
          "001052643852000000006901280200090008007245060003180024064300872019708400008064001",
        solution:
          "971852643852436197436971285245693718187245369693187524564319872319728456728564931",
      },
      {
        puzzle:
          "013947000090050060820130900106009308057302406200001000009003700362014050071095632",
        solution:
          "613947285794258163825136974146579328957382416238461597589623741362714859471895632",
      },
      {
        puzzle:
          "958070400000310009000005000026040957000060008834709261670020800503090120412038796",
        solution:
          "958276413267314589341985672126843957795162348834759261679421835583697124412538796",
      },
    ],
    normal: [
      {
        puzzle:
          "009000050207080063060007819000270080020096005900435000000302100502008090070964000",
        solution:
          "819643257257189463463527819345271986721896345986435721694352178532718694178964532",
      },
      {
        puzzle:
          "070153000000986024098004153904030000000561840006809000000090078500400000000310600",
        solution:
          "472153986315986724698724153984237561723561849156849237231695478569478312847312695",
      },
      {
        puzzle:
          "001000000400000920380019705700000000000701584004936000009002000040193057527004019",
        solution:
          "291457836475368921386219745712845693963721584854936172139572468648193257527684319",
      },
    ],
    hard: [
      {
        puzzle:
          "020000000006020009070004215030007000000000090805000647000800900658290400100003006",
        solution:
          "521379864486125739973684215239467158764518392815932647347856921658291473192743586",
      },
      {
        puzzle:
          "030007900081000003000006078306000201002090780000200600900060510000070002000309800",
        solution:
          "634187925781952463259436178396748251512693784847215639923864517468571392175329846",
      },
      {
        puzzle:
          "002010000070503004000200870001000027009000180020038056040050092090700000503000000",
        solution:
          "462817539178593264935246871381965427659472183724138956847351692296784315513629748",
      },
    ],
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function shuffle(values, random = Math.random) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  const rank = (card) => (card.id % 13) + 1;
  const suit = (card, suits) => Math.floor(card.id / 13) % suits;
  function createSpider(suits = 1, random = Math.random) {
    if (![1, 2].includes(suits)) suits = 1;
    const deck = shuffle(
      Array.from({ length: 104 }, (_, id) => ({ id, up: false })),
      random,
    );
    const columns = Array.from({ length: 10 }, (_, i) => {
      const cards = deck.splice(0, i < 4 ? 6 : 5);
      cards[cards.length - 1].up = true;
      return cards;
    });
    return {
      kind: "spider",
      suits,
      columns,
      stock: deck,
      completed: [],
      moves: 0,
    };
  }
  function spiderSequence(s, col, index) {
    const cards = s.columns[col];
    if (
      !cards ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= cards.length ||
      !cards[index].up
    )
      return false;
    return cards
      .slice(index + 1)
      .every(
        (card, i) =>
          card.up &&
          rank(cards[index + i]) === rank(card) + 1 &&
          suit(card, s.suits) === suit(cards[index], s.suits),
      );
  }
  function spiderCanMove(s, col, index, to) {
    if (col === to || !s.columns[to] || !spiderSequence(s, col, index))
      return false;
    const dest = s.columns[to];
    return (
      !dest.length ||
      rank(dest[dest.length - 1]) === rank(s.columns[col][index]) + 1
    );
  }
  function collectSpider(s) {
    for (const col of s.columns) {
      while (col.length >= 13) {
        const tail = col.slice(-13),
          first = tail[0];
        if (
          !tail.every(
            (card, i) =>
              card.up &&
              rank(card) === 13 - i &&
              suit(card, s.suits) === suit(first, s.suits),
          )
        )
          break;
        s.completed.push(col.splice(-13));
        if (col.length) col[col.length - 1].up = true;
      }
    }
  }
  function spiderMove(s, col, index, to) {
    if (!spiderCanMove(s, col, index, to)) return false;
    s.columns[to].push(...s.columns[col].splice(index));
    if (s.columns[col].length)
      s.columns[col][s.columns[col].length - 1].up = true;
    s.moves++;
    collectSpider(s);
    return true;
  }
  function spiderDeal(s) {
    if (s.stock.length < 10 || s.columns.some((c) => !c.length)) return false;
    for (const col of s.columns) {
      const card = s.stock.pop();
      card.up = true;
      col.push(card);
    }
    s.moves++;
    collectSpider(s);
    return true;
  }
  function spiderHints(s) {
    const moves = [];
    for (let from = 0; from < 10; from++)
      for (let index = 0; index < s.columns[from].length; index++)
        for (let to = 0; to < 10; to++) {
          if (
            !spiderCanMove(s, from, index, to) ||
            (!s.columns[to].length && index === 0)
          )
            continue;
          const dest = s.columns[to],
            top = s.columns[from][index];
          const priority =
            (index > 0 && !s.columns[from][index - 1].up ? 4 : 0) +
            (dest.length &&
            suit(dest[dest.length - 1], s.suits) === suit(top, s.suits)
              ? 2
              : 0);
          moves.push({ from, index, to, priority });
        }
    return moves.sort((a, b) => b.priority - a.priority);
  }
  function validSpider(s) {
    if (
      !s ||
      s.kind !== "spider" ||
      ![1, 2].includes(s.suits) ||
      !Array.isArray(s.columns) ||
      s.columns.length !== 10 ||
      !s.columns.every(Array.isArray) ||
      !Array.isArray(s.stock) ||
      s.stock.length > 50 ||
      s.stock.length % 10 ||
      !Array.isArray(s.completed) ||
      s.completed.length > 8 ||
      !s.completed.every(Array.isArray) ||
      !Number.isSafeInteger(s.moves) ||
      s.moves < 0
    )
      return false;
    const cards = [...s.columns.flat(), ...s.stock, ...s.completed.flat()];
    if (
      cards.length !== 104 ||
      cards.some(
        (c) =>
          !c ||
          !Number.isInteger(c.id) ||
          c.id < 0 ||
          c.id > 103 ||
          typeof c.up !== "boolean",
      ) ||
      new Set(cards.map((c) => c.id)).size !== 104
    )
      return false;
    if (s.stock.some((c) => c.up)) return false;
    for (const col of s.columns) {
      let faceUp = false;
      for (const c of col) {
        if (faceUp && !c.up) return false;
        faceUp ||= c.up;
      }
      if (col.length && !col[col.length - 1].up) return false;
    }
    return s.completed.every(
      (run) =>
        run.length === 13 &&
        run.every(
          (c, i) =>
            c.up &&
            rank(c) === 13 - i &&
            suit(c, s.suits) === suit(run[0], s.suits),
        ),
    );
  }
  function createSudoku(difficulty = "normal", random = Math.random) {
    if (!["easy", "normal", "hard"].includes(difficulty)) difficulty = "normal";
    const base =
      templates[difficulty][
        Math.floor(random() * templates[difficulty].length)
      ];
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], random);
    const rows = shuffle([0, 1, 2], random).flatMap((b) =>
      shuffle([0, 1, 2], random).map((r) => b * 3 + r),
    );
    const cols = shuffle([0, 1, 2], random).flatMap((b) =>
      shuffle([0, 1, 2], random).map((c) => b * 3 + c),
    );
    const transpose = random() < 0.5;
    const transform = (str) =>
      Array.from({ length: 81 }, (_, i) => {
        const r = rows[Math.floor(i / 9)],
          c = cols[i % 9],
          n = Number(str[transpose ? c * 9 + r : r * 9 + c]);
        return n ? digits[n - 1] : 0;
      });
    const givens = transform(base.puzzle);
    return {
      kind: "sudoku",
      difficulty,
      givens,
      solution: transform(base.solution),
      values: [...givens],
      notes: Array(81).fill(0),
      hints: 0,
    };
  }
  function peers(index) {
    const r = Math.floor(index / 9),
      c = index % 9;
    return Array.from({ length: 81 }, (_, i) => i).filter(
      (i) =>
        i !== index &&
        (Math.floor(i / 9) === r ||
          i % 9 === c ||
          (Math.floor(i / 27) === Math.floor(r / 3) &&
            Math.floor((i % 9) / 3) === Math.floor(c / 3))),
    );
  }
  function conflicts(values) {
    return values.map((v, i) => v && peers(i).some((j) => values[j] === v));
  }
  function sudokuWrite(s, index, value, notes = false) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 80 ||
      s.givens[index] ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 9
    )
      return false;
    if (notes && value) {
      if (s.values[index]) return false;
      s.notes[index] ^= 1 << (value - 1);
      return true;
    }
    if (s.values[index] === value && !s.notes[index]) return false;
    s.values[index] = value;
    s.notes[index] = 0;
    if (value) for (const i of peers(index)) s.notes[i] &= ~(1 << (value - 1));
    return true;
  }
  function sudokuHint(s, index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 80 ||
      s.givens[index] ||
      s.values[index] === s.solution[index]
    )
      index = s.values.findIndex((v, i) => v !== s.solution[i]);
    if (index < 0) return -1;
    sudokuWrite(s, index, s.solution[index]);
    s.hints++;
    return index;
  }
  function sudokuComplete(s) {
    return s.values.every((v, i) => v === s.solution[i]);
  }
  function validSudoku(s) {
    if (
      !s ||
      s.kind !== "sudoku" ||
      !["easy", "normal", "hard"].includes(s.difficulty) ||
      !Number.isSafeInteger(s.hints) ||
      s.hints < 0
    )
      return false;
    for (const key of ["givens", "solution", "values", "notes"])
      if (!Array.isArray(s[key]) || s[key].length !== 81) return false;
    if (s.notes.some((n) => !Number.isInteger(n) || n < 0 || n > 511))
      return false;
    if (
      ["givens", "solution", "values"].some((k) =>
        s[k].some((n) => !Number.isInteger(n) || n < 0 || n > 9),
      )
    )
      return false;
    return (
      !s.solution.includes(0) &&
      !conflicts(s.solution).some(Boolean) &&
      s.givens.every((n, i) => !n || (n === s.solution[i] && s.values[i] === n))
    );
  }
  const api = {
    templates,
    clone,
    rank,
    suit,
    createSpider,
    spiderSequence,
    spiderCanMove,
    spiderMove,
    spiderDeal,
    spiderHints,
    validSpider,
    createSudoku,
    peers,
    conflicts,
    sudokuWrite,
    sudokuHint,
    sudokuComplete,
    validSudoku,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TableGamesCore = api;
})(globalThis);
