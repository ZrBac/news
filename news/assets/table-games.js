/* Local, offline-first interfaces for Spider and Sudoku. */
(() => {
  "use strict";
  const C = window.TableGamesCore,
    $ = (selector) => document.querySelector(selector);
  const levels = { easy: "入门", normal: "标准", hard: "进阶" };
  let kind = null,
    state = null,
    history = [],
    selection = null,
    cell = 0,
    notes = false,
    hintCursor = 0;
  const memory = new Map();
  const key = () => `zacai-table-${kind}-v1`;
  const valid = (value) =>
    kind === "spider" ? C.validSpider(value) : C.validSudoku(value);
  const message = (text) => ($("#table-message").textContent = text);
  const won = () =>
    kind === "spider" ? state.completed.length === 8 : C.sudokuComplete(state);
  function save() {
    if (!state || !kind) return;
    const data = { state, history };
    memory.set(kind, C.clone(data));
    try {
      localStorage.setItem(key(), JSON.stringify(data));
      $("#table-save-status").textContent = "进度自动保存在本机";
    } catch {
      $("#table-save-status").textContent =
        "浏览器不允许存档，关闭页面后进度会丢失";
    }
  }
  function restore() {
    let data = memory.get(kind);
    if (!data)
      try {
        data = JSON.parse(localStorage.getItem(key()));
      } catch {}
    if (data && valid(data.state)) {
      state = data.state;
      history = Array.isArray(data.history)
        ? data.history.slice(-30).filter(valid)
        : [];
    } else {
      state = kind === "spider" ? C.createSpider() : C.createSudoku();
      history = [];
    }
    selection = null;
    notes = false;
    hintCursor = 0;
    cell =
      kind === "sudoku"
        ? Math.max(
            0,
            state.givens.findIndex((n) => !n),
          )
        : 0;
    save();
  }
  function change(action) {
    const before = C.clone(state);
    if (!action()) return false;
    history.push(before);
    if (history.length > 30) history.shift();
    hintCursor = 0;
    save();
    render();
    return true;
  }
  function button(text, className) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    el.className = className;
    return el;
  }
  function span(text, className = "") {
    const el = document.createElement("span");
    el.textContent = text;
    el.className = className;
    return el;
  }
  function renderSpider() {
    const board = $("#spider-board");
    const focused = document.activeElement?.dataset;
    const focusKey =
      focused?.col !== undefined
        ? `[data-col="${focused.col}"][data-index="${focused.index}"]`
        : null;
    board.replaceChildren();
    for (let col = 0; col < 10; col++) {
      const pile = document.createElement("div");
      pile.className = "spider-column";
      const can =
        selection &&
        C.spiderCanMove(state, selection.col, selection.index, col);
      if (can) pile.classList.add("can-drop");
      const drop = button("", "pile-drop");
      drop.dataset.to = col;
      drop.append(span(String(col + 1)));
      drop.setAttribute(
        "aria-label",
        `第 ${col + 1} 列${state.columns[col].length ? "" : "，空列"}${can ? "，可移到这里" : ""}`,
      );
      pile.append(drop);
      let top = 24;
      state.columns[col].forEach((card, index) => {
        const rank = [
          "",
          "A",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "10",
          "J",
          "Q",
          "K",
        ][C.rank(card)];
        const red = C.suit(card, state.suits) === 1,
          pip = red ? "♥" : "♠";
        const el = card.up
          ? button("", "spider-card")
          : span("", "spider-card facedown");
        el.style.top = top + "px";
        if (card.up) {
          el.dataset.col = col;
          el.dataset.index = index;
          const corner = span("", "card-corner");
          corner.append(span(rank, "card-rank"), span(pip, "card-suit"));
          el.append(corner, span(pip, "card-center"));
          el.classList.toggle("red", red);
          const selected = selection?.col === col && index >= selection.index;
          el.classList.toggle("selected", selected);
          el.setAttribute("aria-pressed", String(selected));
          el.setAttribute(
            "aria-label",
            `第 ${col + 1} 列，${red ? "红桃" : "黑桃"} ${rank}`,
          );
        } else el.setAttribute("aria-hidden", "true");
        pile.append(el);
        top += card.up ? 40 : 14;
      });
      pile.style.minHeight = Math.max(150, top + 76) + "px";
      board.append(pile);
    }
    if (focusKey) board.querySelector(focusKey)?.focus({ preventScroll: true });
    $("#table-progress").textContent =
      `完成 ${state.completed.length} / 8 · ${state.moves} 步`;
    $("#table-difficulty").textContent =
      state.suits === 1 ? "单花色" : "双花色";
    $("#spider-deal").textContent = `发牌（${state.stock.length / 10}）`;
    $("#spider-deal").disabled = !state.stock.length || won();
    $("#spider-cancel").hidden = !selection;
  }
  function renderSudoku() {
    const board = $("#sudoku-board"),
      errors = C.conflicts(state.values),
      related = new Set(C.peers(cell));
    const focusIndex = document.activeElement?.dataset.cell;
    board.replaceChildren();
    state.values.forEach((value, index) => {
      const el = button(value ? String(value) : "", "sudoku-cell");
      el.dataset.cell = index;
      const row = Math.floor(index / 9),
        col = index % 9;
      el.classList.toggle("given", !!state.givens[index]);
      el.classList.toggle("selected", index === cell);
      el.classList.toggle("related", related.has(index));
      el.classList.toggle("same", !!value && value === state.values[cell]);
      el.classList.toggle("conflict", !!errors[index]);
      el.classList.toggle("box-right", col === 2 || col === 5);
      el.classList.toggle("box-bottom", row === 2 || row === 5);
      el.setAttribute("aria-pressed", String(index === cell));
      let label = `第 ${row + 1} 行第 ${col + 1} 列，${value || "空格"}${state.givens[index] ? "，题目数字" : ""}${errors[index] ? "，数字重复" : ""}`;
      if (!value && state.notes[index]) {
        const grid = span("", "cell-notes"),
          values = [];
        for (let n = 1; n <= 9; n++) {
          const present = state.notes[index] & (1 << (n - 1));
          grid.append(span(present ? String(n) : ""));
          if (present) values.push(n);
        }
        el.append(grid);
        label += "，笔记 " + values.join("、");
      }
      el.setAttribute("aria-label", label);
      board.append(el);
    });
    if (focusIndex !== undefined)
      board
        .querySelector(`[data-cell="${focusIndex}"]`)
        ?.focus({ preventScroll: true });
    $("#table-progress").textContent =
      `已填 ${state.values.filter(Boolean).length} / 81 · 提示 ${state.hints} 次`;
    $("#table-difficulty").textContent = levels[state.difficulty];
    $("#sudoku-notes").textContent = "笔记：" + (notes ? "开" : "关");
    $("#sudoku-notes").setAttribute("aria-pressed", String(notes));
    $("#sudoku-erase").disabled =
      !!state.givens[cell] ||
      won() ||
      (!state.values[cell] && !state.notes[cell]);
    for (const el of $("#sudoku-pad").children)
      el.disabled = !!state.givens[cell] || won();
  }
  function render() {
    if (kind === "spider") renderSpider();
    else renderSudoku();
    $("#table-undo").disabled = !history.length;
    $("#table-hint").disabled = won();
    $("#table-result").hidden = !won();
    $("#table-result").textContent =
      kind === "spider"
        ? "收齐八组，完成牌局！"
        : `解出来了！已使用 ${state.hints} 次提示。`;
  }
  function chooseCard(col, index) {
    if (won()) return;
    if (selection && selection.col !== col) {
      moveTo(col);
      return;
    }
    if (selection?.col === col && selection.index === index) {
      selection = null;
      message("已取消选牌。");
      render();
      return;
    }
    if (!C.spiderSequence(state, col, index)) {
      message("这组牌尚未按同花色递减排列，请从更下面的牌开始选。");
      return;
    }
    selection = { col, index };
    render();
    message(
      `已选第 ${col + 1} 列的 ${state.columns[col].length - index} 张牌，点另一列移动。金色边框表示可放置。`,
    );
  }
  function moveTo(to) {
    if (!selection) {
      message("先点一张明牌，再点目标列。");
      return;
    }
    const { col, index } = selection;
    if (!C.spiderCanMove(state, col, index, to)) {
      message("目标牌需大一点；空列可放任意一组同花色顺序牌。");
      return;
    }
    selection = null;
    change(() => C.spiderMove(state, col, index, to));
    message(won() ? "可以点“新一局”继续挑战。" : `已移到第 ${to + 1} 列。`);
  }
  function write(value) {
    if (kind !== "sudoku" || won()) return;
    if (state.givens[cell]) {
      message("题目数字不能修改，请点一个空格。");
      return;
    }
    if (change(() => C.sudokuWrite(state, cell, value, notes && value !== 0))) {
      message(
        won()
          ? "完成！可以换一道新题。"
          : C.conflicts(state.values).some(Boolean)
            ? "红色数字在行、列或宫内重复，请检查。"
            : notes && value
              ? "已更新笔记；关掉笔记后可正式填数。"
              : "进度已保存。",
      );
    } else if (notes && state.values[cell])
      message("先擦除这个格子的数字，再记候选数。");
  }
  function size() {
    if (kind)
      document.documentElement.style.setProperty(
        "--table-height",
        (window.visualViewport?.height || innerHeight) + "px",
      );
  }
  function open(next) {
    kind = next;
    restore();
    $("#table-play").hidden = false;
    $("#table-play").dataset.game = kind;
    $("#table-title").textContent = kind === "spider" ? "蜘蛛纸牌" : "数独";
    for (const id of ["spider-scroll", "spider-deal"])
      $("#" + id).hidden = kind !== "spider";
    for (const id of ["sudoku-wrap", "sudoku-notes", "sudoku-erase"])
      $("#" + id).hidden = kind !== "sudoku";
    $("#spider-cancel").hidden = true;
    size();
    render();
    message(
      kind === "spider"
        ? "十列已全部显示。点选牌，再点目标列移动。"
        : "点一个空格，再点下方数字。需要记候选数时打开“笔记”。",
    );
  }
  function close() {
    save();
    kind = null;
    state = null;
    selection = null;
    history = [];
    $("#table-play").hidden = true;
    $("#table-new-dialog").close();
    $("#help-dialog").close();
    $("#help-dialog").lastElementChild.hidden = false;
  }
  $("#spider-board").addEventListener("click", (e) => {
    const card = e.target.closest("[data-col]"),
      drop = e.target.closest("[data-to]");
    if (card) chooseCard(Number(card.dataset.col), Number(card.dataset.index));
    else if (drop) moveTo(Number(drop.dataset.to));
  });
  $("#spider-cancel").addEventListener("click", () => {
    selection = null;
    render();
    message("已取消选牌。");
  });
  $("#spider-deal").addEventListener("click", () => {
    if (state.columns.some((c) => !c.length)) {
      message("还有空列，先移入一张牌或一组牌，才能发下一轮。");
      return;
    }
    selection = null;
    if (change(() => C.spiderDeal(state)))
      message("每列已发一张牌。需要时可以撤销。");
  });
  $("#sudoku-board").addEventListener("click", (e) => {
    const el = e.target.closest("[data-cell]");
    if (el) {
      cell = Number(el.dataset.cell);
      renderSudoku();
      message(
        state.givens[cell]
          ? "这是题目数字，请选择空格填写。"
          : notes
            ? "笔记已开启，点数字记下候选数。"
            : "点下方数字填写，或用键盘输入。",
      );
    }
  });
  for (let n = 1; n <= 9; n++) {
    const el = button(String(n), "");
    el.dataset.number = n;
    el.setAttribute("aria-label", "填入 " + n);
    el.addEventListener("click", () => write(n));
    $("#sudoku-pad").append(el);
  }
  $("#sudoku-notes").addEventListener("click", () => {
    notes = !notes;
    renderSudoku();
    message(
      notes
        ? "笔记已开启：点数字添加或移除候选数。"
        : "笔记已关闭：点数字正式填写。",
    );
  });
  $("#sudoku-erase").addEventListener("click", () => write(0));
  $("#table-undo").addEventListener("click", () => {
    if (!history.length) return;
    state = history.pop();
    selection = null;
    hintCursor = 0;
    save();
    render();
    message("已撤销上一步。最多保留最近 30 步。");
  });
  $("#table-hint").addEventListener("click", () => {
    if (kind === "spider") {
      const hints = C.spiderHints(state);
      if (!hints.length) {
        message(
          state.stock.length && !state.columns.some((c) => !c.length)
            ? "暂未找到可移动的牌，可以发下一轮。"
            : "暂未找到可移动的牌，可以撤销尝试其他路线。",
        );
        return;
      }
      const hint = hints[hintCursor++ % hints.length];
      selection = { col: hint.from, index: hint.index };
      render();
      $("#spider-board").children[hint.from].scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
      message(
        `可将第 ${hint.from + 1} 列选中的牌移到第 ${hint.to + 1} 列。再点提示可看其他走法。`,
      );
    } else {
      let filled = -1;
      change(() => {
        filled = C.sudokuHint(state, cell);
        return filled >= 0;
      });
      if (filled >= 0) {
        cell = filled;
        renderSudoku();
        message(
          `已填入第 ${Math.floor(cell / 9) + 1} 行第 ${(cell % 9) + 1} 列的数字 ${state.values[cell]}。`,
        );
      }
    }
  });
  $("#table-help").addEventListener("click", () => {
    $("#help-title").textContent = $("#table-title").textContent + " · 玩法";
    $("#help-text").textContent =
      kind === "spider"
        ? "共 104 张牌，收齐八组同花色 K 到 A 即获胜。点一张牌选中它及下方同花色递减的牌，再点目标列：目标牌必须大一点，花色可以不同；空列可放任意合法牌组。有空列时不能发牌。手机竖屏可看全十列，横屏牌面更大。提示只展示合法走法，随机牌局不保证有解。支持撤销最近 30 步。"
        : "每一行、每一列、每个 3×3 宫内填入 1 到 9，不能重复。点格子后用下方数字填写；笔记用于记录候选数。红色表示行、列或宫内重复，不代表所有错误都会标红。提示会直接填入一格答案。支持撤销最近 30 步；电脑可用方向键选格、数字键填数、N 切换笔记、Delete 擦除。";
    $("#help-dialog").lastElementChild.hidden = true;
    $("#help-dialog").showModal();
  });
  $("#table-new").addEventListener("click", () => {
    const select = $("#table-level");
    select.replaceChildren();
    const choices = kind === "spider" ? { 1: "单花色", 2: "双花色" } : levels;
    for (const [value, text] of Object.entries(choices)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = String(kind === "spider" ? state.suits : state.difficulty);
    $("#table-new-dialog").showModal();
  });
  $("#table-new-cancel").addEventListener("click", () =>
    $("#table-new-dialog").close(),
  );
  $("#table-new-confirm").addEventListener("click", () => {
    const level = $("#table-level").value;
    state =
      kind === "spider" ? C.createSpider(Number(level)) : C.createSudoku(level);
    history = [];
    selection = null;
    notes = false;
    hintCursor = 0;
    cell = kind === "sudoku" ? state.givens.findIndex((n) => !n) : 0;
    $("#table-new-dialog").close();
    save();
    render();
    $("#spider-scroll").scrollTo(0, 0);
    message("新一局已准备好。");
  });
  document.addEventListener("keydown", (e) => {
    if (
      !kind ||
      document.querySelector("dialog[open]") ||
      /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)
    )
      return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      $("#table-undo").click();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || kind !== "sudoku") return;
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      write(Number(e.key));
    } else if (["Backspace", "Delete"].includes(e.key)) {
      e.preventDefault();
      write(0);
    } else if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      $("#sudoku-notes").click();
    } else if (e.key.startsWith("Arrow")) {
      const offsets = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -9,
        ArrowDown: 9,
      };
      if (offsets[e.key]) {
        e.preventDefault();
        cell = Math.max(0, Math.min(80, cell + offsets[e.key]));
        renderSudoku();
        $("#sudoku-board").children[cell].focus({ preventScroll: true });
      }
    }
  });
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) save();
  });
  window.addEventListener("resize", size);
  window.visualViewport?.addEventListener("resize", size);
  window.TableGames = { open, close };
})();
