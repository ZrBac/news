(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CasualGamesCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const integer = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const finite = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function random(s) {
    s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
    return s.seed / 4294967296;
  }
  function base(kind, seed) {
    return {
      kind,
      version: 1,
      seed: (seed === undefined ? Date.now() : seed) >>> 0,
    };
  }
  function shuffle(s, a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random(s) * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function jumpTarget(s) {
    const distance = 130 + random(s) * 95,
      direction = random(s) < 0.5 ? -1 : 1;
    return {
      x: direction * distance * 0.8,
      y: -distance * 0.6,
      r: Math.max(25, 39 - s.jumps * 0.45),
    };
  }
  // Keep actual future platforms in the save; previews become the next targets.
  // Missing arrays are the original two-platform save format.
  function jumpPrepare(s) {
    if (!s.trail) s.trail = [];
    if (!s.upcoming) s.upcoming = [];
    while (s.upcoming.length < 2) {
      const count = s.upcoming.length,
        from = count ? s.upcoming[count - 1] : s.target,
        previous =
          count > 1 ? s.upcoming[count - 2] : count ? s.target : s.current,
        direction = from.x > previous.x ? -1 : 1,
        distance = 130 + random(s) * 95;
      s.upcoming.push({
        x: from.x + direction * distance * 0.8,
        y: from.y - distance * 0.6,
        r: Math.max(25, 39 - (s.jumps + count + 1) * 0.45),
      });
    }
    return s;
  }
  function jumpCreate(seed) {
    const s = {
      ...base("jump", seed),
      score: 0,
      jumps: 0,
      streak: 0,
      phase: "ready",
      charge: 0,
      elapsed: 0,
      current: { x: 0, y: 0, r: 40 },
      player: { x: 0, y: 0 },
      flight: null,
      target: null,
      message: "长按蓄力，松手跳向下一座台。",
    };
    s.target = jumpTarget(s);
    return jumpPrepare(s);
  }
  function jumpPress(s) {
    if (s.phase !== "ready") return false;
    jumpPrepare(s);
    s.phase = "charging";
    s.charge = 0;
    return true;
  }
  function jumpCancel(s) {
    if (s.phase === "charging") {
      s.phase = "ready";
      s.charge = 0;
    }
  }
  function jumpRelease(s) {
    if (s.phase !== "charging") return false;
    const dx = s.target.x - s.player.x,
      dy = s.target.y - s.player.y,
      length = Math.hypot(dx, dy),
      distance = 65 + 170 * s.charge;
    s.flight = {
      from: { ...s.player },
      to: {
        x: s.player.x + (dx / length) * distance,
        y: s.player.y + (dy / length) * distance,
      },
    };
    s.phase = "flying";
    s.elapsed = 0;
    return true;
  }
  function jumpStep(s, dt) {
    dt = Math.max(0, Math.min(0.1, dt));
    if (s.phase === "charging") s.charge = Math.min(1.3, s.charge + dt);
    if (s.phase !== "flying") return false;
    s.elapsed = Math.min(0.65, s.elapsed + dt);
    const t = s.elapsed / 0.65;
    s.player = {
      x: s.flight.from.x + (s.flight.to.x - s.flight.from.x) * t,
      y: s.flight.from.y + (s.flight.to.y - s.flight.from.y) * t,
    };
    if (t < 1) return false;
    const miss = Math.hypot(s.player.x - s.target.x, s.player.y - s.target.y);
    if (miss > s.target.r - 4) {
      s.phase = "over";
      s.message = "差一点！再试试调整蓄力时间。";
      return true;
    }
    const centered = miss <= s.target.r * 0.24;
    s.streak = centered ? s.streak + 1 : 0;
    const gain = centered ? 2 + Math.min(s.streak, 5) : 1;
    s.score += gain;
    s.jumps++;
    s.message = centered ? `正中圆心！+${gain} 分` : "稳稳落地，+1 分";
    jumpPrepare(s);
    const translate = (p) => ({
      ...p,
      x: p.x - s.target.x,
      y: p.y - s.target.y,
    });
    s.trail = [...s.trail, s.current].slice(-2).map(translate);
    s.upcoming = s.upcoming.map(translate);
    s.player = { x: s.player.x - s.target.x, y: s.player.y - s.target.y };
    s.current = { x: 0, y: 0, r: s.target.r };
    s.target = s.upcoming.shift();
    jumpPrepare(s);
    s.phase = "ready";
    s.charge = 0;
    s.elapsed = 0;
    s.flight = null;
    return true;
  }
  function validJump(s) {
    const point = (p) =>
      p && finite(p.x, -1000, 1000) && finite(p.y, -1000, 1000);
    const platform = (p) => point(p) && finite(p.r, 25, 40);
    return !!(
      s &&
      s.kind === "jump" &&
      s.version === 1 &&
      integer(s.seed, 0, 4294967295) &&
      integer(s.score, 0, 1e9) &&
      integer(s.jumps, 0, 1e8) &&
      integer(s.streak, 0, s.jumps) &&
      ["ready", "charging", "flying", "over"].includes(s.phase) &&
      finite(s.charge, 0, 1.3) &&
      finite(s.elapsed, 0, 0.65) &&
      platform(s.current) &&
      platform(s.target) &&
      ((s.trail === undefined && s.upcoming === undefined) ||
        (Array.isArray(s.trail) &&
          s.trail.length <= 2 &&
          s.trail.every(platform) &&
          Array.isArray(s.upcoming) &&
          s.upcoming.length === 2 &&
          s.upcoming.every(platform))) &&
      point(s.player) &&
      typeof s.message === "string" &&
      s.message.length < 150 &&
      (["flying", "over"].includes(s.phase)
        ? s.flight && point(s.flight.from) && point(s.flight.to)
        : s.flight === null)
    );
  }

  const MATCH_W = 7,
    MATCH_H = 7;
  function matchGroups(board) {
    const result = new Set();
    for (let y = 0; y < MATCH_H; y++)
      for (let x = 0; x < MATCH_W;) {
        let end = x + 1;
        while (
          end < MATCH_W &&
          board[y * MATCH_W + end] === board[y * MATCH_W + x]
        )
          end++;
        if (end - x >= 3)
          for (let k = x; k < end; k++) result.add(y * MATCH_W + k);
        x = end;
      }
    for (let x = 0; x < MATCH_W; x++)
      for (let y = 0; y < MATCH_H;) {
        let end = y + 1;
        while (
          end < MATCH_H &&
          board[end * MATCH_W + x] === board[y * MATCH_W + x]
        )
          end++;
        if (end - y >= 3)
          for (let k = y; k < end; k++) result.add(k * MATCH_W + x);
        y = end;
      }
    return [...result];
  }
  function adjacent(a, b) {
    return (
      integer(a, 0, 48) &&
      integer(b, 0, 48) &&
      Math.abs((a % 7) - (b % 7)) +
        Math.abs(Math.floor(a / 7) - Math.floor(b / 7)) ===
        1
    );
  }
  function matchHint(board) {
    for (let i = 0; i < 49; i++)
      for (const j of [i + 1, i + 7])
        if (adjacent(i, j)) {
          const copy = board.slice();
          [copy[i], copy[j]] = [copy[j], copy[i]];
          if (matchGroups(copy).length) return [i, j];
        }
    return null;
  }
  function matchBoard(s) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const board = [];
      for (let i = 0; i < 49; i++) {
        const choices = [0, 1, 2, 3, 4, 5].filter(
          (n) =>
            !(i % 7 >= 2 && board[i - 1] === n && board[i - 2] === n) &&
            !(i >= 14 && board[i - 7] === n && board[i - 14] === n),
        );
        board.push(choices[Math.floor(random(s) * choices.length)]);
      }
      if (matchHint(board)) return board;
    }
    // Deterministic fallback has no matches and a guaranteed swap at (0, 1).
    const board = Array.from(
      { length: 49 },
      (_, i) => ((i % 7) + Math.floor(i / 7) * 2) % 6,
    );
    board[0] = 0;
    board[1] = 1;
    board[2] = 0;
    board[8] = 0;
    return board;
  }
  function matchCreate(seed) {
    const s = {
      ...base("match", seed),
      level: 1,
      moves: 28,
      score: 0,
      roundScore: 0,
      target: 1000,
      phase: "playing",
      board: [],
      combo: 0,
    };
    s.board = matchBoard(s);
    return s;
  }
  function matchSwap(s, a, b) {
    if (s.phase !== "playing" || !adjacent(a, b)) return null;
    const board = s.board.slice();
    [board[a], board[b]] = [board[b], board[a]];
    if (!matchGroups(board).length) return null;
    s.board = board;
    s.moves--;
    const frames = [];
    let groups,
      combo = 0;
    while ((groups = matchGroups(s.board)).length && combo < 50) {
      combo++;
      const gain = groups.length * 10 * Math.min(combo, 5);
      frames.push({ board: s.board.slice(), removed: groups, gain, combo });
      s.score += gain;
      s.roundScore += gain;
      const gone = new Set(groups);
      for (let x = 0; x < 7; x++) {
        const column = [];
        for (let y = 6; y >= 0; y--)
          if (!gone.has(y * 7 + x)) column.push(s.board[y * 7 + x]);
        for (let y = 6; y >= 0; y--)
          s.board[y * 7 + x] =
            6 - y < column.length ? column[6 - y] : Math.floor(random(s) * 6);
      }
    }
    s.combo = combo;
    const reshuffled = !!matchGroups(s.board).length || !matchHint(s.board);
    if (reshuffled) s.board = matchBoard(s);
    if (s.roundScore >= s.target) s.phase = "clear";
    else if (s.moves <= 0) s.phase = "lost";
    return { frames, reshuffled };
  }
  function matchShuffle(s) {
    if (s.phase !== "playing" || s.moves < 3) return false;
    s.moves -= 2;
    s.board = matchBoard(s);
    s.combo = 0;
    return true;
  }
  function matchNext(s) {
    if (s.phase !== "clear") return false;
    s.level++;
    s.target = 1000 + (s.level - 1) * 250;
    s.roundScore = 0;
    s.moves = 28;
    s.combo = 0;
    s.phase = "playing";
    s.board = matchBoard(s);
    return true;
  }
  function validMatch(s) {
    return !!(
      s &&
      s.kind === "match" &&
      s.version === 1 &&
      integer(s.seed, 0, 4294967295) &&
      integer(s.level, 1, 1e5) &&
      integer(s.moves, 0, 28) &&
      integer(s.score, 0, 1e12) &&
      integer(s.roundScore, 0, s.score) &&
      s.target === 1000 + (s.level - 1) * 250 &&
      integer(s.combo, 0, 50) &&
      ["playing", "clear", "lost"].includes(s.phase) &&
      Array.isArray(s.board) &&
      s.board.length === 49 &&
      s.board.every((n) => integer(n, 0, 5)) &&
      matchGroups(s.board).length === 0 &&
      (s.phase === "clear"
        ? s.roundScore >= s.target
        : s.roundScore < s.target) &&
      (s.phase === "lost"
        ? s.moves === 0
        : s.phase === "clear" || s.moves > 0) &&
      !!matchHint(s.board)
    );
  }

  const MINE_LEVELS = {
    easy: { name: "入门", w: 8, h: 8, mines: 10 },
    normal: { name: "标准", w: 9, h: 9, mines: 14 },
    hard: { name: "挑战", w: 9, h: 12, mines: 22 },
  };
  function mineNeighbors(s, i) {
    const result = [],
      x = i % s.w,
      y = Math.floor(i / s.w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (
          (dx || dy) &&
          x + dx >= 0 &&
          x + dx < s.w &&
          y + dy >= 0 &&
          y + dy < s.h
        )
          result.push((y + dy) * s.w + x + dx);
    return result;
  }
  function mineCreate(level = "easy", seed) {
    if (!own(MINE_LEVELS, level)) level = "easy";
    const { w, h, mines } = MINE_LEVELS[level];
    return {
      ...base("mines", seed),
      level,
      w,
      h,
      mines,
      board: Array(w * h).fill(0),
      open: Array(w * h).fill(false),
      flags: Array(w * h).fill(false),
      started: false,
      phase: "playing",
      seconds: 0,
      hit: -1,
    };
  }
  function minePlant(s, first) {
    const safe = new Set([first, ...mineNeighbors(s, first)]);
    const positions = shuffle(
      s,
      Array.from({ length: s.w * s.h }, (_, i) => i).filter(
        (i) => !safe.has(i),
      ),
    ).slice(0, s.mines);
    for (const i of positions) s.board[i] = -1;
    for (let i = 0; i < s.board.length; i++)
      if (s.board[i] !== -1)
        s.board[i] = mineNeighbors(s, i).filter(
          (j) => s.board[j] === -1,
        ).length;
    s.started = true;
  }
  function mineFlag(s, i) {
    if (
      s.phase !== "playing" ||
      !integer(i, 0, s.board.length - 1) ||
      s.open[i]
    )
      return false;
    if (!s.flags[i] && s.flags.filter(Boolean).length >= s.mines) return false;
    s.flags[i] = !s.flags[i];
    return true;
  }
  function mineReveal(s, i) {
    if (
      s.phase !== "playing" ||
      !integer(i, 0, s.board.length - 1) ||
      s.flags[i]
    )
      return false;
    if (!s.started) minePlant(s, i);
    let queue = [i];
    if (s.open[i]) {
      const around = mineNeighbors(s, i);
      if (
        s.board[i] <= 0 ||
        around.filter((j) => s.flags[j]).length !== s.board[i]
      )
        return false;
      queue = around.filter((j) => !s.flags[j] && !s.open[j]);
      if (!queue.length) return false;
    }
    while (queue.length) {
      const j = queue.pop();
      if (s.open[j] || s.flags[j]) continue;
      s.open[j] = true;
      if (s.board[j] === -1) {
        s.phase = "lost";
        s.hit = j;
        return true;
      }
      if (s.board[j] === 0)
        queue.push(
          ...mineNeighbors(s, j).filter((k) => !s.open[k] && !s.flags[k]),
        );
    }
    if (s.open.filter(Boolean).length === s.board.length - s.mines) {
      s.phase = "won";
      s.flags = s.board.map((n) => n === -1);
    }
    return true;
  }
  function validMines(s) {
    if (
      !s ||
      s.kind !== "mines" ||
      s.version !== 1 ||
      !own(MINE_LEVELS, s.level)
    )
      return false;
    const d = MINE_LEVELS[s.level],
      n = d.w * d.h;
    if (
      s.w !== d.w ||
      s.h !== d.h ||
      s.mines !== d.mines ||
      !integer(s.seed, 0, 4294967295) ||
      typeof s.started !== "boolean" ||
      !finite(s.seconds, 0, 1e9) ||
      !integer(s.hit, -1, n - 1) ||
      !["playing", "won", "lost"].includes(s.phase) ||
      !Array.isArray(s.board) ||
      s.board.length !== n ||
      !s.board.every((v) => integer(v, -1, 8)) ||
      ![s.open, s.flags].every(
        (a) =>
          Array.isArray(a) &&
          a.length === n &&
          a.every((v) => typeof v === "boolean"),
      ) ||
      s.flags.filter(Boolean).length > s.mines ||
      s.open.some((v, i) => v && s.flags[i])
    )
      return false;
    if (!s.started)
      return (
        s.phase === "playing" &&
        s.hit === -1 &&
        s.seconds === 0 &&
        s.board.every((v) => v === 0) &&
        !s.open.some(Boolean)
      );
    if (
      s.board.filter((v) => v === -1).length !== s.mines ||
      s.board.some(
        (v, i) =>
          v !== -1 &&
          v !== mineNeighbors(s, i).filter((j) => s.board[j] === -1).length,
      )
    )
      return false;
    const safe = s.open.filter((v, i) => v && s.board[i] !== -1).length,
      exposed = s.open.some((v, i) => v && s.board[i] === -1);
    return s.phase === "lost"
      ? exposed && s.hit >= 0 && s.board[s.hit] === -1 && s.open[s.hit]
      : !exposed &&
          s.hit === -1 &&
          (s.phase === "won" ? safe === n - s.mines : safe < n - s.mines);
  }
  return {
    clone,
    jumpCreate,
    jumpPrepare,
    jumpPress,
    jumpCancel,
    jumpRelease,
    jumpStep,
    validJump,
    MATCH_W,
    MATCH_H,
    matchCreate,
    matchGroups,
    matchHint,
    matchSwap,
    matchShuffle,
    matchNext,
    validMatch,
    MINE_LEVELS,
    mineCreate,
    mineNeighbors,
    mineReveal,
    mineFlag,
    validMines,
  };
});
