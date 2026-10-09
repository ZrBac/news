(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    moon: '<path d="M20.9 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
    "arrow-up-right": '<path d="M6 18 18 6M6 6h12v12"/>',
    "arrow-down": '<path d="M12 4v16m-6-6 6 6 6-6"/>',
    radio:
      '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    sparkles:
      '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    rss: '<circle cx="5" cy="19" r="1"/><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/>',
    x: '<path d="m6 6 12 12M6 18 18 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.globe}</svg>`;
  $$("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
  const escape = (value) =>
    String(value ?? "").replace(
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
  const safeUrl = (value) => {
    try {
      const u = new URL(value);
      return ["https:", "http:"].includes(u.protocol) &&
        !u.username &&
        !u.password
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  const categoryNames = {
    general: "综合热点",
    tech: "科技动态",
    ai: "人工智能",
    entertainment: "文娱",
    sports: "体育",
    housing: "杭州房市",
  };
  const state = {
    data: null,
    view: "all",
    filter: "all",
    query: "",
    source: "all",
    date: "",
    limit: 12,
    saved: new Map(),
  };
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateParts = (date) => dayFormatter.formatToParts(new Date(date));
  const dayOf = (date) => {
    const parts = Object.fromEntries(
      dateParts(date).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const formatTime = (date) => timeFormatter.format(new Date(date));
  const relativeTime = (date) => {
    const minutes = Math.max(
      0,
      Math.floor((Date.now() - new Date(date).getTime()) / 60000),
    );
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
    return formatTime(date);
  };
  function validArticle(a) {
    return (
      a &&
      typeof a.id === "string" &&
      typeof a.title === "string" &&
      !!safeUrl(a.url) &&
      Number.isFinite(Date.parse(a.publishedAt)) &&
      Object.prototype.hasOwnProperty.call(categoryNames, a.category)
    );
  }
  let toastTimer;
  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
    }, 3000);
  }
  function loadSaved() {
    try {
      const data = JSON.parse(
        localStorage.getItem("zrbac-news-saved-v1") || "[]",
      );
      if (Array.isArray(data))
        state.saved = new Map(data.filter(validArticle).map((a) => [a.id, a]));
    } catch {
      state.saved = new Map();
    }
    updateSavedCount();
  }
  function updateSavedCount() {
    $("#saved-count").textContent = state.saved.size;
    $("#saved-count").hidden = !state.saved.size;
  }
  function sourceFor(article) {
    return (
      state.data?.sources.find((s) => s.id === article.sourceId) || {
        name: article.sourceName || article.sourceId,
      }
    );
  }
  function saveArticle(id) {
    if (state.saved.has(id)) {
      state.saved.delete(id);
      toast("已移出收藏");
    } else {
      const article = state.data.articles.find((a) => a.id === id);
      if (!article) return;
      state.saved.set(id, { ...article, sourceName: sourceFor(article).name });
      toast("已收藏，可在「我的收藏」中查看");
    }
    try {
      localStorage.setItem(
        "zrbac-news-saved-v1",
        JSON.stringify([...state.saved.values()]),
      );
    } catch {
      toast("浏览器未允许保存；本次收藏仅在当前页面有效");
    }
    updateSavedCount();
    render();
  }
  function articleCard(article, index) {
    const saved = state.saved.has(article.id);
    const source = sourceFor(article);
    return `<article class="article"><div class="article-body">
      ${state.view === "brief" ? `<span class="article-number">${String(index + 1).padStart(2, "0")}</span>` : ""}
      <h3><a href="${escape(safeUrl(article.url))}" target="_blank" rel="noopener noreferrer">${escape(article.title)}</a></h3>
      ${article.excerpt ? `<p>${escape(article.excerpt)}</p>` : ""}
      <div class="article-meta"><span>${escape(source.name)}</span><time datetime="${escape(article.publishedAt)}" title="北京时间 ${escape(formatTime(article.publishedAt))}">${escape(relativeTime(article.publishedAt))}</time><span class="category-label ${escape(article.category)}">${categoryNames[article.category]}</span></div>
      </div><button class="save-button${saved ? " saved" : ""}" data-save="${escape(article.id)}" aria-label="${saved ? "取消收藏" : "收藏"}：${escape(article.title)}" aria-pressed="${saved}" title="${saved ? "取消收藏" : "收藏文章"}">${icon("bookmark")}</button></article>`;
  }
  function selectBrief(articles) {
    const queues = [
      "general",
      "housing",
      "ai",
      "tech",
      "entertainment",
      "sports",
    ].map((category) => articles.filter((a) => a.category === category));
    const selected = [];
    const counts = {};
    // Rotate categories and sources. This is a transparent reading selection, not a popularity score.
    while (selected.length < 10 && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (!q.length || selected.length >= 10) continue;
        const best = q.findIndex((a) => (counts[a.sourceId] || 0) < 2);
        const [article] = q.splice(best < 0 ? 0 : best, 1);
        selected.push(article);
        counts[article.sourceId] = (counts[article.sourceId] || 0) + 1;
      }
    }
    return selected;
  }
  function matchingArticles() {
    let articles =
      state.view === "saved"
        ? [...state.saved.values()].sort((a, b) =>
            b.publishedAt.localeCompare(a.publishedAt),
          )
        : state.data.articles;
    if (state.filter !== "all")
      articles = articles.filter((a) => a.category === state.filter);
    if (state.source !== "all")
      articles = articles.filter((a) => a.sourceId === state.source);
    if (state.date)
      articles = articles.filter((a) => dayOf(a.publishedAt) === state.date);
    if (state.query) {
      const words = state.query
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      articles = articles.filter((a) =>
        words.every((word) =>
          `${a.title} ${a.excerpt} ${sourceFor(a).name}`
            .toLocaleLowerCase()
            .includes(word),
        ),
      );
    }
    return state.view === "brief" ? selectBrief(articles) : articles;
  }
  function housingMarket(data) {
    const market = data.market || {};
    const note = (kind, r) => {
      const status = (data.marketSources || []).find((s) => s.kind === kind);
      const stale =
        Date.now() - Date.parse(r.periodEnd + "T00:00:00+08:00") >
        75 * 86400000;
      return `<p class="price-period">统计期 ${escape(r.periodStart)} 至 ${escape(r.periodEnd)}</p>
        <p class="price-published">${escape(r.scope)}${r.publishedAt ? ` · 发布于 ${escape(r.publishedAt)}` : ""}</p>
        <a href="${escape(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${escape(r.source)} ↗</a>
        ${stale ? '<p class="price-status">统计期较早，等待来源发布可核实的新数据。</p>' : ""}
        ${status && status.status !== "ok" ? '<p class="price-status">本轮部分来源未能核实，保留上次数据和原统计期。</p>' : ""}`;
    };
    const valid = (r) =>
      r && safeUrl(r.url) && /^\d{4}-\d{2}-\d{2}$/.test(r.periodEnd);
    const change = (index) => {
      const value = Math.round((index - 100) * 10) / 10;
      return value === 0
        ? "持平"
        : `${value > 0 ? "上涨" : "下降"} ${Math.abs(value).toFixed(1)}%`;
    };
    let html = "";
    const official = market.official;
    if (
      valid(official) &&
      Array.isArray(official.values) &&
      official.values.length === 2
    ) {
      const values = official.values.filter(
        (v) =>
          ["new", "resale"].includes(v.kind) &&
          Number.isFinite(v.momIndex) &&
          Number.isFinite(v.yoyIndex),
      );
      if (values.length === 2)
        html += `<section class="housing-market official-prices"><h2>官方房价走势</h2>
        <p class="price-intro">国家统计局的价格指数变化，用于观察涨跌，不是每平方米成交价格。</p>
        <div class="official-grid">${values.map((v) => `<div><h3>${v.kind === "new" ? "新房" : "二手房"}</h3><p>环比 <strong>${change(v.momIndex)}</strong></p><p>同比 <strong>${change(v.yoyIndex)}</strong></p></div>`).join("")}</div>
        ${note("official", official)}</section>`;
    }
    const districts = market.districts;
    if (
      valid(districts) &&
      Array.isArray(districts.rows) &&
      districts.rows.length
    ) {
      const rows = districts.rows.filter((r) =>
        [r.count, r.area, r.amount].every(Number.isFinite),
      );
      html += `<section class="housing-market district-prices"><h2>各区新房成交</h2>
        <p class="price-intro">按来源公布的成交套数、面积和金额展示，统计范围为所列十区。</p>
        <table class="housing-table"><thead><tr><th scope="col">区域</th><th scope="col">套数</th><th scope="col">面积<small>万㎡</small></th><th scope="col">金额<small>亿元</small></th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${escape(r.name)}</th><td>${escape(r.count.toLocaleString("zh-CN"))}</td><td>${r.area.toFixed(2)}</td><td>${r.amount.toFixed(2)}</td></tr>`).join("")}</tbody></table>
        ${note("districts", districts)}</section>`;
    }
    const cric = market.cric;
    if (valid(cric) && Number.isFinite(cric.price) && cric.price > 0)
      html += `<section class="housing-market cric-prices"><h2>克而瑞新房成交均价</h2>
      <p class="market-price">${escape(cric.price.toLocaleString("zh-CN"))}<small>元/㎡</small></p>
      <p class="price-intro">独立来源的月度统计。与上方周报的统计周期、范围不同，请分别查看。</p>${note("cric", cric)}</section>`;
    return html;
  }
  let exchangePoints = [];
  let exchangeCurrency = "USD";
  const exchangeNames = { USD: "美元", JPY: "日元", THB: "泰铢" };
  function renderExchangeRates() {
    const panel = $("#exchange-rates");
    const active = state.view === "exchange";
    panel.hidden = !active;
    $("#news-content").classList.toggle("exchange-view", active);
    if (!active) return;
    const name = exchangeNames[exchangeCurrency];
    const allRates = state.data.exchangeRates || {};
    const data =
      exchangeCurrency === "USD"
        ? allRates
        : allRates.currencies?.[exchangeCurrency];
    const tabs = `<div class="fx-currencies" role="group" aria-label="选择汇率币种">${Object.entries(
      exchangeNames,
    )
      .map(
        ([code, label]) =>
          `<button data-fx-currency="${code}" aria-pressed="${code === exchangeCurrency}">${label} <span>${code}</span></button>`,
      )
      .join("")}</div>`;
    const info = window.NewsExchange.analyze(data, dayOf(Date.now()));
    if (!info) {
      panel.innerHTML = `${tabs}<p class="view-note">${name}兑人民币数据暂未获取成功，后续更新会自动重试。</p>`;
      exchangePoints = [];
      return;
    }
    exchangePoints = info.points;
    const rateText = (rate) => rate.toFixed(6);
    let graph = '<p class="price-published">近30天暂无可展示的报价。</p>';
    if (info.points.length) {
      const rates = info.points.map((p) => p.rate);
      const min = Math.min(...rates),
        max = Math.max(...rates);
      const pad = Math.max((max - min) * 0.12, min * 0.0001, 0.000001);
      const bottom = min - pad,
        top = max + pad;
      const start = Date.parse(info.periodStart),
        end = Date.parse(info.periodEnd);
      const coords = info.points.map((p) => [
        58 + ((Date.parse(p.date) - start) / Math.max(1, end - start)) * 560,
        18 + ((top - p.rate) / (top - bottom)) * 150,
      ]);
      graph = `<svg class="fx-chart" viewBox="0 0 640 210" role="img" aria-labelledby="fx-chart-title fx-chart-desc"><title id="fx-chart-title">${name}兑人民币近30天参考汇率走势</title><desc id="fx-chart-desc">1${name}折合人民币。最低${rateText(min)}，最高${rateText(max)}。可使用下方滑块或每日记录查看具体日期。</desc>
        ${[0, 1, 2]
          .map((i) => {
            const y = 18 + i * 75;
            return `<line x1="58" x2="618" y1="${y}" y2="${y}" class="fx-grid"/><text x="50" y="${y + 4}" text-anchor="end">${(top - ((top - bottom) * i) / 2).toFixed(4)}</text>`;
          })
          .join("")}
        <polyline points="${coords.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ")}" class="fx-line"/>
        ${coords.map(([x, y], i) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4" data-fx-point="${i}" class="fx-point${i === coords.length - 1 ? " selected" : ""}"/>`).join("")}
        <text x="58" y="196">${escape(info.periodStart.slice(5))}</text><text x="618" y="196" text-anchor="end">${escape(info.periodEnd.slice(5))}</text></svg>
        <p id="fx-readout" class="fx-readout" aria-live="polite">${escape(info.points[info.points.length - 1].date)} · 1 ${name} = ${rateText(info.points[info.points.length - 1].rate)} 人民币</p>
        ${info.points.length > 1 ? `<label class="fx-slider-label" for="fx-day">滑动查看日期</label><input id="fx-day" type="range" min="0" max="${info.points.length - 1}" value="${info.points.length - 1}" step="1" aria-describedby="fx-readout"/>` : ""}`;
    }
    const alert = info.low
      ? `<p class="fx-alert" role="status">${info.tied ? "并列" : "达到"}近20天最低</p>`
      : "";
    const status = !info.verified
      ? "本轮获取失败，显示上次数据，暂停最低提醒。"
      : info.stale
        ? "报价日期较早，暂停最低提醒，等待来源更新。"
        : !info.complete
          ? "历史数据不足，暂不判断20天最低。"
          : info.low
            ? "按最新已公布的参考汇率比较。"
            : "最新参考汇率尚未达到近20天最低。";
    panel.innerHTML = `${tabs}<section class="fx-summary${info.low ? " is-low" : ""}"><div class="fx-heading"><h2>${name} <span>${exchangeCurrency} / CNY</span></h2>${alert}</div>
      <p class="fx-unit">1 ${name}兑人民币</p><p class="fx-value">${rateText(info.latest.rate)} <small>元</small></p>
      <p class="price-published">报价日期 ${escape(info.latest.date)} · 每日参考汇率</p><p class="fx-status">${status}</p>
      ${info.complete ? `<p class="price-published">20天区间最低 ${rateText(info.min)} · ${escape(info.windowStart)} 至 ${escape(info.windowEnd)} · ${info.samples} 个报价日</p>` : ""}</section>
      <section class="fx-history"><h2>近一个月走势</h2><p class="price-published">${escape(info.periodStart)} 至 ${escape(info.periodEnd)} · 最近30个自然日</p>${graph}</section>
      <details class="fx-records"><summary>每日记录（${info.points.length} 个报价日）</summary><table class="housing-table"><thead><tr><th scope="col">日期</th><th scope="col">1${name}兑人民币</th></tr></thead><tbody>${[
        ...info.points,
      ]
        .reverse()
        .map(
          (p) =>
            `<tr><th scope="row">${escape(p.date)}</th><td>${rateText(p.rate)}</td></tr>`,
        )
        .join("")}</tbody></table></details>
      <div class="fx-notes"><p>来源：<a href="${escape(safeUrl(data.sourceUrl))}" target="_blank" rel="noopener noreferrer">欧洲央行（ECB）参考汇率 ↗</a>。由同日人民币兑欧元报价除以${name}兑欧元报价换算；不是银行现汇买入价或卖出价。</p>
      <p>随网站自动检查更新，来源通常在欧洲工作日每日发布一次。周末及休市日不新增报价，图表只连接已公布的数据点。</p>
      <p>提醒比较截至最新报价日期的20个自然日（含当天），达到或并列最低均高亮；按六位小数比较，历史不足、获取失败或报价超过4天时暂停提醒。</p>
      ${data.checkedAt ? `<p>最近检查 ${escape(formatTime(data.checkedAt))}（北京时间）；检查时间不代表新报价。</p>` : ""}</div>`;
  }
  function renderHousingPrices() {
    const panel = $("#housing-prices");
    const active = state.view === "housing";
    panel.hidden = !active;
    $("#news-content").classList.toggle("housing-view", active);
    if (!active) return;
    const data = state.data.housingPrices || {};
    const records = (Array.isArray(data.records) ? data.records : [])
      .filter(
        (r) =>
          r &&
          ["new", "resale"].includes(r.kind) &&
          Number.isFinite(r.price) &&
          r.price > 0 &&
          safeUrl(r.url) &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.periodStart) &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.periodEnd),
      )
      .sort(
        (a, b) =>
          b.periodEnd.localeCompare(a.periodEnd) ||
          String(b.publishedAt).localeCompare(String(a.publishedAt)),
      );
    const cards = ["new", "resale"]
      .map((kind) => {
        const record = records.find((r) => r.kind === kind);
        const label = kind === "new" ? "新房" : "二手房";
        if (!record)
          return `<section class="price-card"><h2>${label}</h2><p>暂未收录可核实的成交价格。</p></section>`;
        const status = (data.sources || []).find((s) => s.kind === kind);
        const stale =
          Date.now() - Date.parse(record.periodEnd + "T00:00:00+08:00") >
          45 * 86400000;
        return `<section class="price-card"><h2>${label}<span>${escape(record.metric)}</span></h2>
        <p class="price-value">${escape(record.price.toLocaleString("zh-CN"))}<small>元/㎡</small></p>
        <p class="price-period">统计期 ${escape(record.periodStart)} 至 ${escape(record.periodEnd)}</p>
        <p>${escape(record.scope)}</p>
        <a href="${escape(safeUrl(record.url))}" target="_blank" rel="noopener noreferrer">${escape(record.source)} ↗</a>
        <p class="price-published">发布于 ${escape(record.publishedAt)}</p>
        ${stale ? '<p class="price-status">统计期已超过 45 天，请留意原站后续发布。</p>' : ""}
        ${status && status.status !== "ok" ? '<p class="price-status">本轮部分数据未能核实，保留已收录价格。</p>' : ""}</section>`;
      })
      .join("");
    panel.innerHTML = `<h2 class="city-price-heading">杭州整体成交</h2><p class="price-intro">自动检查来源发布的成交均价。新房与二手房分别标注统计周期，没有新数据时保留上次结果。</p>
      <div class="price-grid">${cards}</div>
      <p class="price-explanation">这里展示已公开的成交、网签统计；暂未接入全市实时逐套成交库。不同周期和成交房源构成的均价不能直接比较。</p>${housingMarket(data)}`;
  }

  function render() {
    if (!state.data) return;
    renderHousingPrices();
    renderExchangeRates();
    const articles = matchingArticles();
    const titles = {
      all: "最新资讯",
      general: "综合热点",
      tech: "科技动态",
      ai: "人工智能",
      entertainment: "文娱",
      sports: "体育",
      housing: "杭州房价",
      exchange: "汇率",
      brief: "每日速览",
      saved: "我的收藏",
    };
    $("#section-title").textContent = titles[state.view] || titles.all;
    const partial = hasArchive() && state.view !== "saved";
    $("#result-count").textContent =
      partial && state.view !== "brief"
        ? `已加载 ${articles.length} 条资讯`
        : `${articles.length} 条资讯`;
    if (state.view === "housing")
      $("#result-count").textContent = "公开成交数据";
    if (state.view === "exchange")
      $("#result-count").textContent = "美元 · 日元 · 泰铢";
    $$("[data-view]").forEach((el) => {
      const active =
        el.dataset.view === state.view ||
        (el.dataset.view === "tech" && state.view === "ai");
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    $$("[data-filter]").forEach((el) => {
      const active =
        el.dataset.filter === state.filter && state.view !== "brief";
      el.classList.toggle("selected", active);
      el.setAttribute("aria-pressed", active);
    });
    const note = $("#view-note");
    note.hidden = !["saved", "brief", "entertainment", "housing"].includes(
      state.view,
    );
    if (state.view === "housing")
      note.textContent =
        "关注杭州新房、二手房成交、价格变化、购房政策与土拍。按报道发布时间排序，点击标题查看原报道及数据口径。";
    if (state.view === "entertainment")
      note.textContent =
        "娱乐圈、影视和综艺消息，按发布时间更新。点击标题查看原报道。";
    if (state.view === "saved")
      note.textContent =
        "收藏保存在当前浏览器，可保留已超出资讯归档期限的条目。清除浏览器数据会移除收藏，不会自动跨设备同步。";
    if (state.view === "brief")
      note.textContent =
        "从所选日期的资讯中，按综合、杭州房市、AI、科技、文娱、体育轮流选取最多 10 条，兼顾不同来源。摘要来自资讯源，并非 AI 撰写或人工排名。";
    $("#date-trigger").classList.toggle("active", !!state.date);
    $("#date-trigger span:last-child").textContent = state.date
      ? state.date.slice(5).replace("-", "/")
      : "日期";
    $("#articles").setAttribute("aria-busy", "false");
    if (articles.length) {
      $("#articles").innerHTML = articles
        .slice(0, state.limit)
        .map(articleCard)
        .join("");
    } else {
      const emptySaved = state.view === "saved" && !state.saved.size;
      $("#articles").innerHTML =
        `<div class="empty-state">${icon(emptySaved ? "bookmark" : "search")}<h3>${emptySaved ? "还没有收藏" : partial ? "已加载的资讯中暂无匹配" : "暂时没有匹配的资讯"}</h3><p>${emptySaved ? "点击新闻右侧的书签即可收藏。" : partial ? "正在查找较早资讯；也可调整关键词、来源或日期。" : "试试其他关键词、来源或日期。"}</p><button data-reset>浏览全部资讯</button></div>`;
    }
    $("#load-more").hidden =
      articles.length <= state.limit &&
      (!partial || (state.view === "brief" && articles.length >= 10));
    $("#load-more").disabled = archiveJob?.data === state.data;
    $("#list-end").hidden =
      partial || !articles.length || articles.length > state.limit;
  }
  function route(scroll = false) {
    const hash = location.hash.slice(1);
    if (hash === "news-content" || hash === "section-title") {
      if (!state.data) return;
      render();
      return;
    }
    state.view = [
      "all",
      "general",
      "tech",
      "ai",
      "entertainment",
      "sports",
      "housing",
      "exchange",
      "brief",
      "saved",
    ].includes(hash)
      ? hash
      : "all";
    state.filter = [
      "general",
      "tech",
      "ai",
      "entertainment",
      "sports",
      "housing",
      "exchange",
    ].includes(state.view)
      ? state.view
      : "all";
    state.limit = 12;
    state.query = "";
    state.source = "all";
    state.date = state.view === "brief" ? dayOf(Date.now()) : "";
    $("#search").value = "";
    $("#source-filter").value = "all";
    $("#date-filter").value = state.date;
    $("#date-panel").hidden = state.view !== "brief";
    $("#date-trigger").setAttribute("aria-expanded", state.view === "brief");
    render();
    ensureArticles();
    if (scroll)
      $("#news-content").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderSidebar() {
    const seenSources = new Set();
    const latest = [];
    for (const a of state.data.articles) {
      if (!seenSources.has(a.sourceId)) {
        latest.push(a);
        seenSources.add(a.sourceId);
      }
      if (latest.length === 5) break;
    }
    $("#latest-list").innerHTML = latest
      .map(
        (a) =>
          `<li><div><a href="${escape(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${escape(a.title)}</a><p>${escape(sourceFor(a).name)} · ${escape(relativeTime(a.publishedAt))}</p></div></li>`,
      )
      .join("");
    $("#tech-list").innerHTML = state.data.articles
      .filter((a) => a.category === "ai")
      .slice(0, 5)
      .map(
        (a) =>
          `<li><a href="${escape(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${escape(a.title)}</a><p>${escape(sourceFor(a).name)} · ${escape(relativeTime(a.publishedAt))}</p></li>`,
      )
      .join("");
    $("#source-badges").innerHTML = state.data.sources
      .map(
        (s) =>
          `<a href="${escape(safeUrl(s.home))}" target="_blank" rel="noopener noreferrer">${escape(s.name)}</a>`,
      )
      .join("");
    $("#source-filter").innerHTML =
      '<option value="all">全部来源</option>' +
      state.data.sources
        .map(
          (s) => `<option value="${escape(s.id)}">${escape(s.name)}</option>`,
        )
        .join("");
    const ok = state.data.sources.filter((s) => s.status === "ok").length;
    const stale =
      Date.now() - Date.parse(state.data.updatedAt) > 2 * 3600 * 1000;
    const latestPublished = state.data.articles.reduce(
      (date, a) => Math.max(date, Date.parse(a.publishedAt)),
      0,
    );
    $("#update-status").textContent =
      `${stale ? "检查已延迟 · " : ""}最近检查 ${formatTime(state.data.updatedAt)} · 最新文章 ${latestPublished ? formatTime(latestPublished) : "暂无"} · ${ok}/${state.data.sources.length} 个来源可用`;
    $("#update-status").title =
      "最近检查为资讯源抓取时间，最新文章为已收录文章的发布时间。计划每小时检查，可能延迟；时间均为北京时间。";
    const dates = state.data.articles.map((a) => dayOf(a.publishedAt)).sort();
    if (dates.length)
      $("#date-filter").min = state.data.archive?.oldest
        ? dayOf(state.data.archive.oldest)
        : dates[0];
    $("#date-filter").max = dayOf(Date.now());
  }
  function showSources() {
    $("#dialog-title").textContent = "资讯来源";
    const sourceRows = state.data
      ? state.data.sources
          .map(
            (s) =>
              `<div class="source-row"><div><a href="${escape(safeUrl(s.home))}" target="_blank" rel="noopener noreferrer">${escape(s.name)} ${icon("arrow-up-right")}</a><small>${s.latestAt ? "最近发布：" + escape(formatTime(s.latestAt)) : "本轮未取得有效资讯"}</small></div><span class="source-status ${s.status === "ok" ? "" : "unavailable"}">${s.status === "ok" ? "● 本轮已连接" : "○ 暂不可用"}</span></div>`,
          )
          .join("")
      : "<p>资讯尚未加载完成，请稍后再试。</p>";
    $("#dialog-content").innerHTML =
      "<p>通过公开 RSS 获取标题、发布时间及简短摘要，点击资讯前往原站阅读完整内容。标注“聚合”的来源由 Google 新闻汇集该网站的报道。不同来源有各自的报道视角。</p>" +
      sourceRows +
      "<p>计划每小时检查一次，来源失败时保留已收录内容。本站归档保留最近 30 天、最多 6000 条，历史从首次上线后逐步积累；并不代表全网实时热度榜。</p>";
    $("#info-dialog").showModal();
  }
  function showAbout() {
    $("#dialog-title").textContent = "关于本站";
    $("#dialog-content").innerHTML =
      '<p>个人新闻订阅页，汇总综合新闻、杭州房市、科技、AI、文娱和体育资讯，计划每小时检查更新。</p><h3>排序与分类</h3><p>新闻按来源标注的发布时间排列，AI 分类依据标题关键词及来源。每日速览从不同分类与来源中选取最多 10 条，不代表热度排名。</p><h3>内容与收藏</h3><p>标题及短摘要来自对应资讯源，点击标题阅读原文。收藏仅保存在当前浏览器，不会跨设备同步。</p><p><a href="https://github.com/ZrBac/news/issues" target="_blank" rel="noopener noreferrer">问题反馈</a></p>';
    $("#info-dialog").showModal();
  }
  function theme(value) {
    document.documentElement.dataset.theme = value;
    $("#theme-toggle").innerHTML = icon(value === "dark" ? "sun" : "moon");
    $("#theme-toggle").setAttribute(
      "aria-label",
      value === "dark" ? "切换浅色模式" : "切换深色模式",
    );
    $('meta[name="theme-color"]').content =
      value === "dark" ? "#181818" : "#ffffff";
  }
  let storedTheme;
  try {
    storedTheme = localStorage.getItem("zrbac-news-theme");
  } catch {}
  theme(storedTheme === "dark" ? "dark" : "light");
  $("#theme-toggle").addEventListener("click", () => {
    const value =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    theme(value);
    try {
      localStorage.setItem("zrbac-news-theme", value);
    } catch {}
  });
  $("#edition-date").textContent = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  $("#year").textContent = new Date().getFullYear();
  function focusSearch() {
    $("#news-content").scrollIntoView({ behavior: "smooth" });
    $("#search").focus({ preventScroll: true });
  }
  document.addEventListener("keydown", (e) => {
    if (
      (e.key === "k" && (e.ctrlKey || e.metaKey)) ||
      (e.key === "/" &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) &&
        !$("#info-dialog").open)
    ) {
      e.preventDefault();
      focusSearch();
    }
  });
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    state.limit = 12;
    render();
    ensureArticles();
  });
  $("#source-filter").addEventListener("change", (e) => {
    state.source = e.target.value;
    state.limit = 12;
    render();
    ensureArticles();
  });
  $("#date-trigger").addEventListener("click", () => {
    const open = $("#date-panel").hidden;
    $("#date-panel").hidden = !open;
    $("#date-trigger").setAttribute("aria-expanded", open);
    if (open) $("#date-filter").focus();
  });
  $("#date-filter").addEventListener("change", (e) => {
    state.date = e.target.value;
    state.limit = 12;
    render();
    ensureArticles();
  });
  $("#clear-date").addEventListener("click", () => {
    state.date = "";
    $("#date-filter").value = "";
    render();
    ensureArticles();
  });
  $("#load-more").addEventListener("click", () => {
    state.limit += 12;
    render();
    ensureArticles();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "fx-day") return;
    const index = Number(e.target.value),
      point = exchangePoints[index];
    if (!point) return;
    $("#fx-readout").textContent =
      `${point.date} · 1 ${exchangeNames[exchangeCurrency]} = ${point.rate.toFixed(6)} 人民币`;
    $$("[data-fx-point]").forEach((el) =>
      el.classList.toggle("selected", Number(el.dataset.fxPoint) === index),
    );
  });
  document.addEventListener("click", (e) => {
    const currency = e.target.closest("[data-fx-currency]");
    if (
      currency &&
      Object.prototype.hasOwnProperty.call(
        exchangeNames,
        currency.dataset.fxCurrency,
      )
    ) {
      exchangeCurrency = currency.dataset.fxCurrency;
      renderExchangeRates();
      return;
    }
    const viewLink = e.target.closest("a[data-view]");
    if (
      viewLink &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      e.button === 0
    ) {
      e.preventDefault();
      const hash = "#" + viewLink.dataset.view;
      if (location.hash !== hash) history.pushState(null, "", hash);
      // A repeated click should also reset the date/search instead of doing nothing.
      route(true);
      return;
    }
    const filter = e.target.closest("[data-filter]");
    if (filter && state.view === "brief") {
      history.replaceState(null, "", "#" + filter.dataset.filter);
      route();
      return;
    }
    if (filter) {
      state.filter = filter.dataset.filter;
      state.limit = 12;
      if (!["saved", "brief"].includes(state.view)) {
        state.view = state.filter;
        history.replaceState(null, "", "#" + state.view);
      }
      render();
      ensureArticles();
    }
    const save = e.target.closest("[data-save]");
    if (save) saveArticle(save.dataset.save);
    if (e.target.closest("[data-reset]")) {
      location.hash = "all";
      route();
    }
    if (e.target.closest("[data-retry-archive]")) ensureArticles(true);
    if (e.target.closest("[data-retry]")) load(true, false, true);
  });
  window.addEventListener("hashchange", () => route(true));
  window.addEventListener("storage", (e) => {
    if (e.key === "zrbac-news-saved-v1") {
      loadSaved();
      render();
    }
  });
  ["#sources-trigger", "#footer-sources"].forEach((id) =>
    $(id).addEventListener("click", showSources),
  );
  $("#about-trigger").addEventListener("click", showAbout);
  $("#close-dialog").addEventListener("click", () => $("#info-dialog").close());
  $("#info-dialog").addEventListener("click", (e) => {
    if (e.target === $("#info-dialog")) {
      const r = e.target.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        e.target.close();
    }
  });
  loadSaved();
  const cacheKey = "zrbac-news-cache-v1";
  let archiveJob = null;
  let loading = false;
  let refreshing = false;
  function validateData(data) {
    if (
      !data ||
      !Array.isArray(data.articles) ||
      !Array.isArray(data.sources) ||
      !Number.isFinite(Date.parse(data.updatedAt))
    )
      throw Object.assign(new Error("Invalid data"), { name: "DataError" });
    if (
      data.archive &&
      (!Array.isArray(data.archive.pages) ||
        data.archive.pages.length > 1000 ||
        !data.archive.pages.every(
          (path) =>
            typeof path === "string" &&
            /^\/data\/archive\/[a-f0-9]{16}\.json$/.test(path),
        ) ||
        !Number.isInteger(data.archive.loaded) ||
        data.archive.loaded < 0 ||
        data.archive.loaded > data.archive.pages.length ||
        !Number.isInteger(data.archive.total) ||
        data.archive.total < data.articles.length ||
        (data.archive.oldest != null &&
          !Number.isFinite(Date.parse(data.archive.oldest))))
    )
      throw Object.assign(new Error("Invalid archive index"), {
        name: "DataError",
      });
    data.articles = data.articles.filter(validArticle);
    return data;
  }
  async function requestJSON(url, options = {}, timeout = 30000) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    let timer;
    try {
      return await Promise.race([
        fetch(url, {
          ...options,
          ...(controller ? { signal: controller.signal } : {}),
        }).then(async (response) => {
          if (!response.ok)
            throw Object.assign(new Error("News data unavailable"), {
              name: "HTTPError",
              status: response.status,
            });
          try {
            return await response.json();
          } catch (error) {
            if (error.name === "SyntaxError") error.name = "DataError";
            throw error;
          }
        }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("News request timed out");
            error.name = "TimeoutError";
            reject(error);
            if (controller) controller.abort();
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function hasArchive(data = state.data) {
    return !!data?.archive && data.archive.loaded < data.archive.pages.length;
  }
  function persistData(data) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch {
      // A large archive can exceed localStorage; keep the small current-news page.
      if (data.archive)
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              ...data,
              articles: data.articles.slice(0, 150),
              archive: { ...data.archive, loaded: 0 },
            }),
          );
        } catch {}
    }
  }
  function ensureArticles(fresh = false) {
    if (
      loading ||
      ["saved", "housing", "exchange"].includes(state.view) ||
      !hasArchive()
    )
      return;
    if (archiveJob?.data === state.data) return archiveJob.promise;
    const data = state.data;
    const needed = () => (state.view === "brief" ? 10 : state.limit + 1);
    if (matchingArticles().length >= needed()) return;
    const notice = $("#archive-notice");
    const job = { data };
    archiveJob = job;
    job.promise = (async () => {
      let failed = false;
      try {
        while (
          state.data === data &&
          !["saved", "housing", "exchange"].includes(state.view) &&
          hasArchive(data) &&
          matchingArticles().length < needed()
        ) {
          if (!navigator.onLine) throw new Error("Offline");
          notice.hidden = false;
          notice.textContent = "正在查找较早资讯…";
          $("#load-more").disabled = true;
          // Commit complete batches in order, so the loaded list stays a continuous
          // newest-first prefix even when a request fails or filters change.
          const paths = data.archive.pages.slice(
            data.archive.loaded,
            data.archive.loaded + 3,
          );
          const pages = await Promise.all(
            paths.map(async (path) => {
              const page = await requestJSON(
                fresh ? path + "?retry=" + Date.now() : path,
                { cache: fresh ? "no-store" : "default" },
                20000,
              );
              if (
                !page ||
                !Array.isArray(page.articles) ||
                !page.articles.every(validArticle)
              )
                throw new Error("Invalid archive page");
              return page.articles;
            }),
          );
          if (state.data !== data) return;
          data.articles.push(...pages.flat());
          data.archive.loaded += paths.length;
          persistData(data);
          render();
        }
      } catch {
        failed = true;
        if (state.data === data) {
          notice.hidden = false;
          notice.innerHTML = navigator.onLine
            ? '历史资讯暂时未能加载，当前内容仍可阅读。<button class="text-button" data-retry-archive>继续加载</button> <button class="text-button" data-retry>更新资讯后重试</button>'
            : "当前离线，只能检索已经保存在本机的资讯。";
        }
      } finally {
        if (archiveJob === job) {
          archiveJob = null;
          if (!failed) notice.hidden = true;
          render();
        }
      }
    })();
    return job.promise;
  }
  async function fetchData(checkVersion = false, fresh = false) {
    if (!navigator.onLine)
      throw Object.assign(new Error("Offline"), { name: "OfflineError" });
    if (checkVersion && state.data) {
      try {
        const version = await requestJSON(
          "/data/status.json",
          { cache: "no-cache" },
          4000,
        );
        if (version.updatedAt === state.data.updatedAt) return state.data;
      } catch {
        // A missing or unavailable status file must not prevent a data refresh.
      }
    }
    return validateData(
      await requestJSON(
        fresh ? "/data/latest.json?retry=" + Date.now() : "/data/latest.json",
        { cache: fresh ? "no-store" : "no-cache" },
        30000,
      ),
    );
  }
  function showData(data, preserveFilters = false, persist = true) {
    const hadData = !!state.data;
    state.data = data;
    if (persist) persistData(data);
    $("#archive-notice").hidden = true;
    renderSidebar();
    if (preserveFilters && hadData) {
      if (
        state.source !== "all" &&
        !data.sources.some((s) => s.id === state.source)
      )
        state.source = "all";
      $("#source-filter").value = state.source;
      render();
    } else route();
    ensureArticles();
  }
  async function load(
    preserveFilters = false,
    checkVersion = false,
    fresh = false,
  ) {
    if (loading) return;
    loading = true;
    $("#refresh-news").disabled = true;
    $("#load-notice").hidden = true;
    if (!state.data) {
      try {
        const cached = validateData(JSON.parse(localStorage.getItem(cacheKey)));
        showData(cached, false, false);
      } catch {}
    }
    if (state.data) {
      $("#load-notice").textContent = navigator.onLine
        ? "正在显示上次成功获取的资讯，后台检查更新中…"
        : "当前离线，正在显示上次成功获取的资讯。";
      $("#load-notice").hidden = false;
    }
    $("#articles").setAttribute("aria-busy", String(!state.data));
    try {
      let data;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          data = await fetchData(
            checkVersion && attempt === 0 && !fresh,
            fresh || attempt > 0,
          );
          break;
        } catch (error) {
          if (attempt === 1 || !navigator.onLine) throw error;
          if (state.data) {
            $("#load-notice").textContent =
              "连接暂时不畅，正在重试；可继续阅读上次成功获取的资讯。";
          } else $("#update-status").textContent = "连接暂时不畅，正在重试…";
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      // The reader may have changed tab, search, date or pagination while fetching.
      if (data !== state.data) showData(data, preserveFilters || !!state.data);
      $("#load-notice").hidden = true;
      return true;
    } catch (error) {
      const reason =
        error.name === "TimeoutError"
          ? "资讯下载超时"
          : error.name === "HTTPError"
            ? `资讯请求失败（HTTP ${error.status}）`
            : error.name === "DataError"
              ? "收到的资讯数据异常"
              : error.name === "OfflineError" || !navigator.onLine
                ? "当前离线"
                : "网络连接失败";
      if (state.data) {
        $("#load-notice").innerHTML =
          `${escape(reason)}，当前显示上次成功获取的资讯（${escape(formatTime(state.data.updatedAt))}）。<button class="text-button" data-retry>重新连接</button>`;
        $("#load-notice").hidden = false;
        return false;
      }
      $("#articles").setAttribute("aria-busy", "false");
      $("#articles").innerHTML =
        `<div class="empty-state">${icon("radio")}<h3>资讯加载失败</h3><p>${escape(reason)}，请重试或换个网络。</p><button data-retry>重新加载</button></div>`;
      $("#update-status").textContent = "数据加载失败，请稍后重试";
      $("#latest-list").innerHTML = "<li><div>等待资讯恢复连接</div></li>";
      return false;
    } finally {
      loading = false;
      $("#refresh-news").disabled = refreshing;
      $("#articles").setAttribute("aria-busy", "false");
      ensureArticles();
    }
  }
  $("#refresh-news").addEventListener("click", async () => {
    if (refreshing || loading) return;
    if (!navigator.onLine) {
      $("#refresh-notice").textContent =
        "当前离线，可继续阅读已缓存的资讯；联网后再刷新。";
      $("#refresh-notice").hidden = false;
      return;
    }
    refreshing = true;
    const button = $("#refresh-news");
    const notice = $("#refresh-notice");
    button.disabled = true;
    button.textContent = "正在刷新…";
    notice.hidden = false;
    notice.textContent = "正在请求更新…";
    const endpoint =
      document.querySelector('meta[name="news-refresh-endpoint"]')?.content ||
      "https://zacai.fun/api/news-refresh";
    let baseline = Date.parse(state.data?.updatedAt || "") || 0;
    try {
      let result = await requestJSON(
        endpoint,
        {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-News-Refresh": "1",
          },
          body: "{}",
        },
        90000,
      );
      if (result.status === "fresh" || result.status === "cooldown") {
        const loaded = await load(true);
        notice.textContent = loaded
          ? "已重新读取已发布的资讯。为避免重复抓取，后台刷新最多每 15 分钟触发一次。"
          : "后台近期已有刷新请求，但当前未能读取最新资讯，请稍后重试。";
        return;
      }
      if (result.status === "busy") {
        notice.textContent = "后台正在检查更新，请稍后再试。";
        return;
      }
      if (result.status !== "running") throw new Error("Refresh unavailable");
      baseline = Math.max(baseline, Date.parse(result.baselineAt || "") || 0);
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        notice.textContent =
          result.status === "ready"
            ? "发布已完成，正在读取最新资讯…"
            : "正在抓取和发布，通常需要约一分钟；排队时可能更久。";
        await new Promise((resolve) => setTimeout(resolve, 5000));
        result = await requestJSON(
          endpoint + "/status",
          { credentials: "omit", cache: "no-store" },
          15000,
        );
        if (result.status === "failed") {
          notice.textContent =
            "本次抓取或发布未成功，现有资讯仍可阅读，请稍后再试。";
          return;
        }
        if (result.status === "ready") {
          const data = await fetchData();
          if (Date.parse(data.updatedAt) > baseline) {
            showData(data, true);
            $("#load-notice").hidden = true;
            notice.textContent = `刷新完成，最近检查 ${formatTime(data.updatedAt)}。`;
            return;
          }
        }
      }
      notice.textContent =
        "更新请求已提交，暂未读到新版本，请稍后再点刷新查看。";
    } catch {
      await load(true);
      notice.textContent =
        "暂时无法确认后台刷新状态，已尝试重新读取网站资讯，请稍后再试。";
    } finally {
      refreshing = false;
      button.disabled = false;
      button.textContent = "刷新资讯";
    }
  });
  window.addEventListener("online", () => {
    if ($("#refresh-notice").textContent.includes("当前离线"))
      $("#refresh-notice").hidden = true;
    load(true, true);
  });
  window.addEventListener("offline", () => {
    if (state.data) {
      $("#load-notice").textContent = "当前离线，正在显示上次成功获取的资讯。";
      $("#load-notice").hidden = false;
    }
  });
  window.newsInitialLoad = load(false, true);
})();
