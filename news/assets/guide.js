(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const escape = (text) =>
    String(text || "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  let book,
    mode = "read",
    limit = 12,
    indexLoading,
    loadingAll;
  const pendingChapters = new Map();
  let saved = new Set();
  try {
    const items = JSON.parse(localStorage.getItem("zrbac-guide-saved") || "[]");
    if (Array.isArray(items))
      saved = new Set(items.filter((id) => /^\d+-\d+$/.test(id)));
  } catch {
    /* Reading still works if storage is unavailable. */
  }

  function safeUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : "";
    } catch {
      return "";
    }
  }
  function inline(text, base) {
    const links = [];
    const protectedText = text.replace(
      /\[([^\]]+)\]\(([^\s)]+)\)|<(https?:\/\/[^>]+)>|https?:\/\/[^\s<>]+/g,
      (match, label, target, auto) => {
        const raw = target || auto || match.replace(/[。；，.,;]+$/, "");
        const url = safeUrl(raw, base);
        const content = escape(label || raw);
        const suffix = !target && !auto ? escape(match.slice(raw.length)) : "";
        links.push(
          url
            ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${content}</a>${suffix}`
            : escape(match),
        );
        return `\u0000L${links.length - 1}\u0000`;
      },
    );
    return escape(protectedText)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\u0000L(\d+)\u0000/g, (_, number) => links[Number(number)]);
  }
  function markdown(text, base) {
    // Raw HTML is never executed. Notes and multiline conditions remain visible.
    const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
    const parts = [];
    let list = false,
      code = null;
    const closeList = () => {
      if (list) parts.push("</ul>");
      list = false;
    };
    for (const line of lines) {
      if (/^```/.test(line)) {
        closeList();
        if (code) {
          parts.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
          code = null;
        } else code = [];
      } else if (code) code.push(line);
      else if (/^\s*[-*] /.test(line)) {
        if (!list) {
          parts.push("<ul>");
          list = true;
        }
        parts.push(`<li>${inline(line.replace(/^\s*[-*] /, ""), base)}</li>`);
      } else {
        closeList();
        if (line.trim())
          parts.push(`<p>${inline(line.replace(/^#{1,6} /, ""), base)}</p>`);
      }
    }
    closeList();
    if (code) parts.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
    return parts.join("");
  }
  function entryCard(entry, open = false) {
    const chapter = book.chapters.find((c) => c.id === entry.chapter);
    return `<article class="guide-entry" id="entry-${entry.id}" data-entry="${entry.id}">
      <p class="entry-meta"><span>第 ${entry.chapter} 章 · ${escape(chapter.title)} · 第 ${entry.number} 条</span><span>证据 ${escape(entry.grade || "未标注")}</span>${entry.disputed ? '<span class="entry-warning">有争议，请看备注</span>' : ""}${entry.pending ? '<span class="entry-warning">含待核实内容</span>' : ""}</p>
      <div class="entry-head"><h2><a href="#entry/${entry.id}">${escape(entry.title)}</a></h2><button class="entry-save" data-save="${entry.id}" aria-pressed="${saved.has(entry.id)}">${saved.has(entry.id) ? "已收藏" : "收藏"}</button></div>
      <p class="entry-summary">${escape(entry.summary)}</p>
      <details ${open ? "open" : ""}><summary>正文、来源与适用条件</summary><div class="entry-body" ${typeof entry.body === "string" ? 'data-loaded="true"' : ""}>${typeof entry.body === "string" ? markdown(entry.body, entry.url) : "<p>展开后加载本章正文。</p>"}</div><a class="entry-original" href="${escape(entry.url)}" target="_blank" rel="noopener noreferrer">查看原项目本章</a></details>
    </article>`;
  }
  function counts() {
    $("#guide-saved-count").textContent = saved.size;
  }
  function render() {
    if (!book) return;
    const expanded = new Set(
      Array.from(
        document.querySelectorAll(".guide-entry details[open]"),
        (details) => details.closest(".guide-entry").dataset.entry,
      ),
    );
    const chapterId = $("#guide-chapter").value;
    const results = LifeGuide.search(book, $("#guide-query").value, {
      chapter: chapterId,
      grade: $("#guide-grade").value,
      saved: mode === "saved" ? saved : null,
    });
    $("#guide-result-count").textContent = book.partial
      ? "首屏正文已可阅读，正在加载完整目录…"
      : `${results.length} 条${mode === "saved" ? "收藏" : "内容"} · 证据等级沿用作者标注`;
    $("#guide-results").innerHTML = results.length
      ? results
          .slice(0, limit)
          .map(({ entry }) => entryCard(entry, expanded.has(entry.id)))
          .join("")
      : `<p class="guide-muted">${book.partial ? "完整目录尚未加载，可通过“按章节阅读”查看其他内容，或点“重新加载目录”。" : mode === "saved" && !saved.size ? "还没有收藏。找到想留下的条目，点“收藏”。" : "没有找到匹配内容，可以换个关键词或取消筛选。"}</p>`;
    $("#guide-more").hidden = limit >= results.length;
    const chapter = book.chapters.find((c) => c.id === Number(chapterId));
    $("#chapter-intro").hidden = !chapter;
    if (chapter)
      $("#chapter-intro > div").innerHTML = markdown(
        chapter.intro,
        chapter.url,
      );
    counts();
    expandVisible();
    if ($("#guide-query").value.trim() && !book.partial) loadingMessage();
  }
  function route() {
    const hash = location.hash.slice(1);
    mode = hash === "saved" ? "saved" : "read";
    for (const tab of document.querySelectorAll("[data-mode]")) {
      if (tab.dataset.mode === mode) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (!book) return;
    const id = /^entry\/(\d+-\d+)$/.exec(hash)?.[1];
    const entry = book.entries.find((e) => e.id === id);
    if (entry) {
      $("#guide-results").innerHTML = entryCard(entry, true);
      $("#guide-result-count").textContent =
        `第 ${entry.chapter} 章第 ${entry.number} 条 · 已展开完整正文`;
      $("#chapter-intro").hidden = true;
      $("#guide-more").hidden = true;
      counts();
    } else render();
    expandVisible();
  }
  function reset() {
    limit = 12;
    if (location.hash.startsWith("#entry/")) location.hash = "read";
    else render();
    if ($("#guide-query").value.trim()) loadAllChapters();
    else $("#guide-download-status").hidden = true;
  }
  $("#guide-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    reset();
  });
  $("#guide-query").addEventListener("input", reset);
  $("#guide-chapter").addEventListener("change", reset);
  $("#guide-grade").addEventListener("change", reset);
  $("#guide-more").addEventListener("click", () => {
    limit += 12;
    render();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-save]");
    if (!button) return;
    const id = button.dataset.save;
    if (saved.has(id)) saved.delete(id);
    else saved.add(id);
    try {
      localStorage.setItem(
        "zrbac-guide-saved",
        JSON.stringify(Array.from(saved)),
      );
    } catch {
      $("#guide-error").hidden = false;
      $("#guide-error").textContent =
        "浏览器未能保存收藏，请检查可用空间或改用普通标签页。";
    }
    for (const item of document.querySelectorAll(`[data-save="${id}"]`)) {
      item.setAttribute("aria-pressed", String(saved.has(id)));
      item.textContent = saved.has(id) ? "已收藏" : "收藏";
    }
    counts();
    if (mode === "saved") render();
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("reading-change", () => {
    try {
      const items = JSON.parse(
        localStorage.getItem("zrbac-guide-saved") || "[]",
      );
      if (Array.isArray(items))
        saved = new Set(items.filter((id) => /^\d+-\d+$/.test(id)));
    } catch {}
    counts();
    render();
  });
  window.addEventListener("online", () => {
    if (!book || book.partial) window.guideInitialLoad = loadIndex();
  });
  window.addEventListener("guide-offline-ready", () => {
    if (book && !book.partial) loadAllChapters();
  });
  function theme(value) {
    document.documentElement.dataset.theme = value;
    $('meta[name="theme-color"]').content =
      value === "dark" ? "#181818" : "#ffffff";
  }
  try {
    theme(
      localStorage.getItem("zrbac-news-theme") === "dark" ? "dark" : "light",
    );
  } catch {
    theme("light");
  }
  $("#theme-toggle").addEventListener("click", () => {
    const value =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    theme(value);
    try {
      localStorage.setItem("zrbac-news-theme", value);
    } catch {
      /* Optional preference. */
    }
  });
  $("#close-dialog").addEventListener("click", () => $("#info-dialog").close());
  async function fetchJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("download_failed");
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  function chapterLoaded(chapter) {
    return (
      book.entries.filter(
        (entry) =>
          entry.chapter === chapter.id && typeof entry.body === "string",
      ).length === chapter.count
    );
  }
  function updateBodies() {
    for (const card of document.querySelectorAll(".guide-entry")) {
      const entry = book.entries.find((item) => item.id === card.dataset.entry);
      const body = card.querySelector(".entry-body");
      if (entry && typeof entry.body === "string" && !body.dataset.loaded) {
        body.innerHTML = markdown(entry.body, entry.url);
        body.dataset.loaded = "true";
      }
    }
  }
  function loadingMessage() {
    const status = $("#guide-download-status");
    const loaded = book.chapters.filter(chapterLoaded).length;
    status.hidden = !$("#guide-query").value.trim();
    status.textContent =
      loaded === book.chapters.length
        ? "已检索全部章节正文。"
        : `先显示标题和摘要的匹配结果；正文已加载 ${loaded}/${book.chapters.length} 章，正在补充检索。`;
  }
  function loadChapter(id) {
    const chapter = book.chapters.find((item) => item.id === Number(id));
    if (!chapter || chapterLoaded(chapter)) return Promise.resolve();
    if (pendingChapters.has(chapter.id)) return pendingChapters.get(chapter.id);
    const task = (async () => {
      const data = await fetchJSON(chapter.file);
      const expected = book.entries.filter(
        (entry) => entry.chapter === chapter.id,
      );
      if (
        data.schema !== 1 ||
        data.revision !== book.revision ||
        !Array.isArray(data.entries) ||
        data.entries.length !== chapter.count ||
        expected.some(
          (entry) =>
            !data.entries.some(
              (item) =>
                item.id === entry.id &&
                item.chapter === chapter.id &&
                typeof item.body === "string",
            ),
        )
      )
        throw new Error("invalid_chapter");
      for (const entry of expected)
        Object.assign(
          entry,
          data.entries.find((item) => item.id === entry.id),
        );
      updateBodies();
      if (
        $("#guide-query").value.trim() &&
        !location.hash.startsWith("#entry/")
      )
        render();
    })().finally(() => pendingChapters.delete(chapter.id));
    pendingChapters.set(chapter.id, task);
    return task;
  }
  async function expandEntry(card) {
    const entry = book?.entries.find((item) => item.id === card.dataset.entry);
    const body = card.querySelector(".entry-body");
    if (!entry || typeof entry.body === "string") return;
    body.textContent = "正在加载本章正文…";
    try {
      await loadChapter(entry.chapter);
    } catch {
      body.innerHTML =
        "<p>本章暂未下载成功，已加载的内容仍可阅读。</p>" +
        `<button class="entry-retry" data-retry-entry="${entry.id}">重试本章</button>`;
    }
  }
  function expandVisible() {
    for (const details of document.querySelectorAll(
      ".guide-entry details[open]",
    ))
      expandEntry(details.closest(".guide-entry"));
  }
  function loadAllChapters() {
    if (loadingAll || !book || book.partial) return loadingAll;
    loadingAll = (async () => {
      let next = 0;
      const chapters = book.chapters.filter(
        (chapter) => !chapterLoaded(chapter),
      );
      let failed = false;
      await Promise.all(
        Array.from({ length: Math.min(3, chapters.length) }, async () => {
          while (next < chapters.length) {
            const chapter = chapters[next++];
            try {
              await loadChapter(chapter.id);
            } catch {
              failed = true;
            }
            loadingMessage();
          }
        }),
      );
      if (failed && $("#guide-query").value.trim())
        $("#guide-download-status").textContent =
          "部分章节尚未下载，当前检索已加载的正文及全部标题、摘要。联网后再次搜索可重试。";
    })().finally(() => {
      loadingAll = null;
    });
    return loadingAll;
  }
  function loadIndex() {
    if (indexLoading) return indexLoading;
    $("#guide-retry").hidden = true;
    indexLoading = (async () => {
      try {
        const data = await fetchJSON($('meta[name="guide-book"]').content);
        if (
          data.schema !== 1 ||
          !data.entries?.length ||
          !data.chapters?.length ||
          data.chapters.some(
            (chapter) =>
              !/^\/guide\/chapters\/\d+\.[a-f0-9]{12}\.json$/.test(
                chapter.file,
              ),
          )
        )
          throw new Error("invalid_book");
        const existing = new Map(
          book?.revision === data.revision
            ? book.entries.map((entry) => [entry.id, entry.body])
            : [],
        );
        for (const entry of data.entries)
          if (typeof existing.get(entry.id) === "string")
            entry.body = existing.get(entry.id);
        book = data;
        $("#guide-chapter").disabled = false;
        $("#guide-error").hidden = true;
        route();
        if ($("#guide-query").value.trim()) loadAllChapters();
        window.dispatchEvent(new Event("guide-index-ready"));
      } catch {
        $("#guide-error").textContent =
          "完整目录暂未下载成功。首屏正文和“按章节阅读”仍可使用，联网后可点“重新加载目录”。";
        $("#guide-error").hidden = false;
        $("#guide-retry").hidden = false;
      }
    })().finally(() => {
      indexLoading = null;
    });
    return indexLoading;
  }
  $("#guide-retry").addEventListener("click", () => {
    window.guideInitialLoad = loadIndex();
  });
  document.addEventListener(
    "toggle",
    (event) => {
      if (event.target.matches(".guide-entry details") && event.target.open)
        expandEntry(event.target.closest(".guide-entry"));
    },
    true,
  );
  document.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry-entry]");
    if (retry) expandEntry(retry.closest(".guide-entry"));
    const chapter = event.target.closest("[data-read-chapter]");
    if (chapter && book && !book.partial) {
      event.preventDefault();
      $("#guide-chapter").value = chapter.dataset.readChapter;
      $("#guide-query").value = "";
      location.hash = "read";
      reset();
      chapter.closest("details").open = false;
    }
  });
  try {
    book = JSON.parse($("#guide-bootstrap").textContent);
    book.partial = true;
    $("#guide-chapter").disabled = true;
    $("#guide-chapter").innerHTML += book.chapters
      .map(
        (chapter) =>
          `<option value="${chapter.id}">${chapter.id}. ${escape(chapter.title)}</option>`,
      )
      .join("");
    $("#guide-edition").textContent =
      `${book.chapters.length} 章 · ${book.totalEntries} 条 · 正文版本日期 ${book.updatedAt.slice(0, 10)}（${book.revision.slice(0, 8)}）。发布时自动检查原项目更新。`;
  } catch {
    /* The static first page and chapter links still work. */
  }
  counts();
  route();
  window.guideInitialLoad = loadIndex();
})();
