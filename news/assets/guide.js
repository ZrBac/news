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
    serviceReady = false,
    busy = false,
    checkingService;
  let saved = new Set();
  try {
    const items = JSON.parse(localStorage.getItem("zrbac-guide-saved") || "[]");
    if (Array.isArray(items))
      saved = new Set(items.filter((id) => /^\d+-\d+$/.test(id)));
  } catch {
    /* Reading still works if storage is unavailable. */
  }
  const endpoint = $('meta[name="guide-endpoint"]').content;

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
      <details ${open ? "open" : ""}><summary>正文、来源与适用条件</summary><div class="entry-body">${markdown(entry.body, entry.url)}</div><a class="entry-original" href="${escape(entry.url)}" target="_blank" rel="noopener noreferrer">查看原项目本章</a></details>
    </article>`;
  }
  function counts() {
    $("#guide-saved-count").textContent = saved.size;
  }
  function render() {
    if (!book) return;
    const chapterId = $("#guide-chapter").value;
    const results = LifeGuide.search(book, $("#guide-query").value, {
      chapter: chapterId,
      grade: $("#guide-grade").value,
      saved: mode === "saved" ? saved : null,
    });
    $("#guide-result-count").textContent =
      `${results.length} 条${mode === "saved" ? "收藏" : "内容"} · 证据等级沿用作者标注`;
    $("#guide-results").innerHTML = results.length
      ? results
          .slice(0, limit)
          .map(({ entry }) => entryCard(entry))
          .join("")
      : `<p class="guide-muted">${mode === "saved" && !saved.size ? "还没有收藏。找到想留下的条目，点“收藏”。" : "没有找到匹配内容，可以换个关键词或取消筛选。"}</p>`;
    $("#guide-more").hidden = limit >= results.length;
    const chapter = book.chapters.find((c) => c.id === Number(chapterId));
    $("#chapter-intro").hidden = !chapter;
    if (chapter)
      $("#chapter-intro > div").innerHTML = markdown(
        chapter.intro,
        chapter.url,
      );
    counts();
  }
  function route() {
    const hash = location.hash.slice(1);
    mode = hash === "ask" ? "ask" : hash === "saved" ? "saved" : "read";
    $("#reader").hidden = mode === "ask";
    $("#question-panel").hidden = mode !== "ask";
    for (const tab of document.querySelectorAll("[data-mode]")) {
      if (tab.dataset.mode === mode) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (mode === "ask") {
      checkService();
      return;
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
  }
  function reset() {
    limit = 12;
    if (location.hash.startsWith("#entry/")) location.hash = "read";
    else render();
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
  async function api(path, options = {}, timeout = 9000) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(endpoint + path, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.status || "unavailable");
        error.status = data.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function checkService() {
    if (checkingService) return checkingService;
    if (!navigator.onLine) {
      serviceReady = false;
      $("#guide-ai-status").textContent =
        "当前离线。可查找已下载的原文，AI 问答需要联网。";
      $("#guide-ask").disabled = true;
      return;
    }
    checkingService = (async () => {
      try {
        const result = await api("/status");
        serviceReady = result.ready === true;
        $("#guide-ai-status").textContent = serviceReady
          ? "问答已就绪。提交的问题和相关原文会发送给模型服务。"
          : "AI 问答尚未配置。可先点“查找相关原文”阅读依据。";
      } catch {
        serviceReady = false;
        $("#guide-ai-status").textContent =
          "问答服务暂时无法连接，可先查找相关原文。";
      }
      $("#guide-ask").disabled = !serviceReady || !book || busy;
    })().finally(() => {
      checkingService = null;
    });
    return checkingService;
  }
  function question() {
    const input = $("#guide-question");
    const value = input.value.trim();
    if (!value || !input.reportValidity()) return "";
    return value;
  }
  function references(entries, title = "相关原文") {
    $("#guide-references").innerHTML = entries.length
      ? `<h2>${escape(title)}</h2>${entries.map((e) => entryCard(e)).join("")}`
      : '<p class="guide-muted">没有找到足够相关的原文，请补充具体情况或换个关键词。</p>';
  }
  $("#guide-lookup").addEventListener("click", () => {
    const value = question();
    if (value && book) references(LifeGuide.retrieve(book, value));
  });
  $("#guide-question-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = question();
    if (!value || !book || !serviceReady || busy) return;
    busy = true;
    $("#guide-ask").disabled = true;
    $("#guide-ask").textContent = "正在回答…";
    $("#guide-ai-status").textContent = "正在查找正文并生成回答…";
    const answer = $("#guide-answer");
    answer.hidden = true;
    references(LifeGuide.retrieve(book, value), "正在参考的原文");
    try {
      const result = await api(
        "/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: value }),
        },
        55000,
      );
      answer.textContent = result.answer;
      answer.hidden = false;
      const ids = new Set(result.references?.map((item) => item.id) || []);
      const entries = book.entries.filter((e) => ids.has(e.id));
      references(entries, "回答依据（可展开核对）");
      if (result.revision && result.revision !== book.revision) {
        $("#guide-ai-status").textContent =
          "回答参考了较新的正文版本，请点“更新页面”后核对原文。";
        const link = document.createElement("a");
        link.href = "https://github.com/eternity4719/HowToLiveBetter";
        link.textContent = "查看原项目最新版本";
        link.target = "_blank";
        link.rel = "noopener";
        $("#guide-ai-status").append(" ", link);
      } else
        $("#guide-ai-status").textContent =
          result.status === "no_match"
            ? "书中未检索到相关依据。"
            : "回答已完成。请展开原文核对适用条件和出处。";
    } catch (error) {
      const messages = {
        unconfigured: "AI 问答尚未配置，可先阅读下方原文。",
        rate_limited: "问答请求较多，请稍后再试。",
        provider_auth: "模型密钥或账户额度需要检查，可先阅读下方原文。",
        timeout: "模型回答超时，请稍后重试；下方原文仍可阅读。",
      };
      $("#guide-ai-status").textContent =
        messages[error.status] ||
        (error.name === "AbortError"
          ? messages.timeout
          : "本次问答未完成，请稍后重试；下方原文仍可阅读。");
      if (error.status === "unconfigured") serviceReady = false;
    } finally {
      busy = false;
      $("#guide-ask").disabled = !serviceReady || !navigator.onLine;
      $("#guide-ask").textContent = "AI 问答";
    }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => {
    if (mode === "ask") checkService();
  });
  window.addEventListener("offline", () => {
    if (mode === "ask") checkService();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && mode === "ask") checkService();
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
  window.guideInitialLoad = (async () => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch($('meta[name="guide-book"]').content, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("download_failed");
      book = await response.json();
      if (book.schema !== 1 || !book.entries?.length || !book.chapters?.length)
        throw new Error("invalid_book");
      $("#guide-chapter").innerHTML += book.chapters
        .map(
          (c) => `<option value="${c.id}">${c.id}. ${escape(c.title)}</option>`,
        )
        .join("");
      $("#guide-edition").textContent =
        `${book.chapters.length} 章 · ${book.entries.length} 条 · 正文版本日期 ${book.updatedAt.slice(0, 10)}（${book.revision.slice(0, 8)}）。发布时自动检查原项目更新。`;
      route();
      $("#guide-ask").disabled = !serviceReady || busy;
    } catch {
      $("#guide-result-count").textContent = "正文暂时无法加载，请联网后重试。";
      $("#guide-error").textContent =
        "首次使用需要联网下载正文。离线前请等待下方显示“已准备好，可离线阅读”。";
      $("#guide-error").hidden = false;
    } finally {
      clearTimeout(timer);
    }
  })();
  counts();
  route();
})();
