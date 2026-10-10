(() => {
  "use strict";
  const preferencesKey = "zrbac-reading-preferences-v1",
    readKey = "zrbac-news-read-v1";
  const newsKey = "zrbac-news-saved-v1",
    guideKey = "zrbac-guide-saved";
  const get = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let preferences = get(preferencesKey, {});
  if (!preferences || typeof preferences !== "object") preferences = {};
  let read = new Set();
  const restoreRead = () => {
    const values = get(readKey, []);
    read = new Set(
      Array.isArray(values)
        ? values.filter((id) => typeof id === "string").slice(-6000)
        : [],
    );
  };
  restoreRead();
  const notify = (message) => {
    const output = document.querySelector("#reading-status");
    if (output) output.textContent = message;
  };
  function apply() {
    const size = ["normal", "large", "larger"].includes(preferences.size)
      ? preferences.size
      : "normal";
    document.documentElement.dataset.readingSize = size;
    const selector = document.querySelector("#reading-size");
    if (selector) selector.value = size;
    const unread = document.querySelector("#only-unread");
    if (unread) {
      unread.checked = preferences.onlyUnread === true;
      document.querySelector(".reading-options > summary").textContent =
        unread.checked ? "阅读设置 · 只看未读" : "阅读设置";
    }
  }
  function changed() {
    window.dispatchEvent(new Event("reading-change"));
  }
  function savePreferences() {
    apply();
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(preferences));
    } catch {
      notify("浏览器未允许保存设置，本次仅在当前页面有效。");
    }
    changed();
  }
  window.NewsPersonal = {
    isRead: (id) => read.has(id),
    onlyUnread: () => preferences.onlyUnread === true,
    markRead(id) {
      read.delete(id);
      read.add(id);
      read = new Set([...read].slice(-6000));
      try {
        localStorage.setItem(readKey, JSON.stringify([...read]));
      } catch {}
    },
  };
  apply();
  document
    .querySelector("#reading-size")
    ?.addEventListener("change", (event) => {
      preferences.size = event.target.value;
      savePreferences();
    });
  document
    .querySelector("#only-unread")
    ?.addEventListener("change", (event) => {
      preferences.onlyUnread = event.target.checked;
      savePreferences();
    });
  function newsArticle(value) {
    if (
      !value ||
      typeof value.id !== "string" ||
      value.id.length > 128 ||
      typeof value.title !== "string" ||
      value.title.length > 240 ||
      !Number.isFinite(Date.parse(value.publishedAt)) ||
      ![
        "general",
        "tech",
        "ai",
        "models",
        "gaming",
        "sports",
        "entertainment",
        "housing",
      ].includes(value.category)
    )
      return false;
    try {
      const url = new URL(value.url);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }
  document.querySelector("#export-bookmarks")?.addEventListener("click", () => {
    const news = get(newsKey, []),
      guide = get(guideKey, []);
    const value = {
      schema: 1,
      app: "zacai-bookmarks",
      exportedAt: new Date().toISOString(),
      newsSaved: Array.isArray(news) ? news.filter(newsArticle) : [],
      guideSaved: Array.isArray(guide)
        ? guide.filter((id) => typeof id === "string" && /^\d+-\d+$/.test(id))
        : [],
    };
    const link = document.createElement("a"),
      url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
    link.href = url;
    link.download =
      "资讯与指南收藏-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    notify(
      `已导出 ${value.newsSaved.length} 条资讯收藏、${value.guideSaved.length} 条指南收藏。`,
    );
  });
  document
    .querySelector("#import-bookmarks")
    ?.addEventListener("click", () =>
      document.querySelector("#bookmarks-file").click(),
    );
  document
    .querySelector("#bookmarks-file")
    ?.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        if (file.size > 20 * 1024 * 1024)
          throw new Error("收藏文件过大，请选择本站导出的 JSON 文件。");
        let value;
        try {
          value = JSON.parse(await file.text());
        } catch {
          throw new Error("无法读取收藏文件，请选择本站导出的 JSON 文件。");
        }
        if (
          value?.schema !== 1 ||
          value.app !== "zacai-bookmarks" ||
          !Array.isArray(value.newsSaved) ||
          value.newsSaved.length > 10000 ||
          !value.newsSaved.every(newsArticle) ||
          !Array.isArray(value.guideSaved) ||
          value.guideSaved.length > 5000 ||
          !value.guideSaved.every(
            (id) => typeof id === "string" && /^\d+-\d+$/.test(id),
          )
        )
          throw new Error("收藏文件格式不正确，原有收藏已保留。");
        const news = get(newsKey, []),
          guide = get(guideKey, []);
        // Imported items fill missing IDs; existing snapshots keep their contents.
        const mergedNews = [
          ...new Map(
            [
              ...value.newsSaved.map((article) =>
                Object.fromEntries(
                  [
                    "id",
                    "title",
                    "url",
                    "publishedAt",
                    "sourceId",
                    "sourceName",
                    "category",
                    "excerpt",
                  ]
                    .filter((key) => typeof article[key] === "string")
                    .map((key) => [key, article[key]]),
                ),
              ),
              ...(Array.isArray(news) ? news.filter(newsArticle) : []),
            ].map((a) => [a.id, a]),
          ).values(),
        ];
        const mergedGuide = [
          ...new Set([
            ...(Array.isArray(guide) ? guide : []),
            ...value.guideSaved,
          ]),
        ];
        const previousNews = localStorage.getItem(newsKey),
          previousGuide = localStorage.getItem(guideKey);
        try {
          localStorage.setItem(newsKey, JSON.stringify(mergedNews));
          localStorage.setItem(guideKey, JSON.stringify(mergedGuide));
        } catch {
          for (const [key, previous] of [
            [newsKey, previousNews],
            [guideKey, previousGuide],
          ])
            try {
              if (previous === null) localStorage.removeItem(key);
              else localStorage.setItem(key, previous);
            } catch {}
          throw new Error("浏览器未能保存导入的收藏，请检查可用空间。");
        }
        changed();
        notify(
          `已合并收藏：${mergedNews.length} 条资讯、${mergedGuide.length} 条指南。`,
        );
      } catch (error) {
        notify(error.message);
      } finally {
        event.target.value = "";
      }
    });
  window.addEventListener("storage", (event) => {
    if (event.key === readKey) restoreRead();
    if (event.key === preferencesKey) {
      const value = get(preferencesKey, {});
      preferences =
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {};
      apply();
    }
    if ([readKey, preferencesKey, newsKey, guideKey].includes(event.key))
      changed();
  });
})();
