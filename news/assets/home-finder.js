(() => {
  "use strict";
  const H = window.HomeBook,
    $ = (s) => document.querySelector(s);
  const FEED = $('meta[name="home-candidates-feed"]').content;
  const DATA_CACHE = "news-home-candidates-data-v1";
  const CACHE = "zrbac-home-candidates-v1";
  const esc = (v) =>
    String(v ?? "").replace(
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
  const number = (v) => Math.round(v * 10) / 10;
  const date = (v) =>
    v && Number.isFinite(Date.parse(v))
      ? new Date(v).toLocaleString("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "时间未知";
  const url = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  let feed,
    limit = 12,
    origin = "",
    loading = false;
  const profile = () => ({
    budgetMin: 300,
    budgetMax: Number($("#candidate-budget").value) || 350,
    priority: "new",
  });
  const unavailable = (c) =>
    c.missing ||
    c.mixedUse ||
    /售罄|待售|停售/.test(c.status + (c.crossCheck?.status || "")) ||
    /地块$/.test(c.name);
  function amount(c) {
    if (c.total > 0) return c.total;
    if (c.unitPrice > 0 && c.areas?.length)
      return number((c.unitPrice * c.areas[0]) / 10000);
    return null;
  }
  function category(c, p) {
    if (unavailable(c)) return "other";
    const total = amount(c);
    if (total == null) return "verify";
    return p.budgetMax == null || total <= p.budgetMax ? "budget" : "other";
  }
  function price(c) {
    if (c.total)
      return {
        main: `${number(c.total)} 万${c.priceBasis === "project" ? "起 / 参考" : ""}`,
        note:
          c.priceBasis === "listing"
            ? "该套挂牌总价 · 未核实成交与在售"
            : "平台楼盘总价参考 · 具体房号待核实",
      };
    if (c.unitPrice && c.areas?.length)
      return {
        main: `约 ${number((c.unitPrice * c.areas[0]) / 10000)} 万起`,
        note: `按均价 × 最小展示面积估算 · 不是单套报价`,
      };
    return {
      main: c.unitPrice ? `${number(c.unitPrice)} 元/㎡` : "价格待核实",
      note: "平台参考均价 · 缺少对应户型总价",
    };
  }
  function area(c) {
    return c.areas?.length
      ? c.areas[0] === c.areas[1]
        ? `${c.areas[0]}㎡`
        : `${c.areas[0]}–${c.areas[1]}㎡`
      : "面积待核实";
  }
  function history(c) {
    const rows = (c.history || [])
      .slice(-3)
      .reverse()
      .map((event) => {
        const values = Object.entries(event.changes || {})
          .map(([key, change]) => {
            const labels = {
              total: ["总价参考", "万"],
              unitPrice: ["均价", "元/㎡"],
              status: ["销售标记", ""],
              opening: ["开盘信息", ""],
              delivery: ["交付信息", ""],
            };
            const def = labels[key];
            return def
              ? `${def[0]}：${change.from ?? "未提供"}${change.from == null ? "" : def[1]} → ${change.to ?? "未提供"}${change.to == null ? "" : def[1]}`
              : "";
          })
          .filter(Boolean)
          .join("；");
        return `<li>${esc(date(event.at))} · ${esc(values)}</li>`;
      });
    return rows.length
      ? `<details class="candidate-history"><summary>${c.history.length} 次来源信息变化</summary><ul>${rows.join("")}</ul></details>`
      : `<p class="home-muted candidate-observed">从 ${esc(date(c.firstSeen))} 开始观察</p>`;
  }
  function render() {
    if (!feed) return;
    const p = profile(),
      scope = $("#candidate-scope").value,
      kind = $("#candidate-kind").value,
      district = $("#candidate-area").value;
    const regionSelect = $("#candidate-region"),
      selectedRegion = regionSelect.value;
    const regions = [
      ...new Set(
        feed.items
          .filter((c) => !district || c.district === district)
          .map((c) => c.region)
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "zh-CN"));
    regionSelect.innerHTML =
      '<option value="">全部板块</option>' +
      regions
        .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
        .join("");
    regionSelect.value = regions.includes(selectedRegion) ? selectedRegion : "";
    const region = regionSelect.value;
    const all = feed.items.filter(
      (c) =>
        (!kind || c.kind === kind) &&
        (!district || c.district === district) &&
        (!region || c.region === region),
    );
    const items = all.filter(
      (c) => scope === "all" || category(c, p) === scope,
    );
    const desired = p.priority === "resale" ? "resale" : "new";
    const rank = (c) =>
      (c.kind === desired ? 0 : 100) +
      (amount(c) != null && p.budgetMin != null && amount(c) < p.budgetMin
        ? 20
        : 0) +
      (c.district === "上城" ? 10 : 0);
    items.sort(
      (a, b) => rank(a) - rank(b) || (amount(b) || 0) - (amount(a) || 0),
    );
    // Show different communities before repeating units from the same community.
    const counts = new Map(),
      occurrence = new Map();
    for (const c of items) {
      const key = [c.kind, c.district, c.name].join("|");
      occurrence.set(c.id, counts.get(key) || 0);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        occurrence.get(a.id) - occurrence.get(b.id) ||
        (amount(b) || 0) - (amount(a) || 0),
    );
    const budget = all.filter((c) => category(c, p) === "budget");
    const resale = budget.filter((c) => c.kind === "resale");
    const communities = new Set(resale.map((c) => c.district + "|" + c.name))
      .size;
    $("#candidate-summary").textContent =
      `预算内：${budget.length - resale.length} 个新盘 · ${resale.length} 条二手挂牌（${communities} 个小区）`;
    const failures = feed.sources.filter((s) => !s.ok).length;
    $("#candidate-message").textContent =
      `${origin}检查于 ${date(feed.updatedAt)}${failures ? ` · ${failures} 个来源有页面未更新，保留上次结果` : ""} · 当前 ${items.length} 条`;
    $("#candidate-list").innerHTML =
      items
        .slice(0, limit)
        .map((c) => {
          const q = price(c),
            scopeLabel =
              category(c, p) === "budget"
                ? c.priceBasis === "listing"
                  ? "挂牌在预算内"
                  : "参考金额在预算内"
                : category(c, p) === "verify"
                  ? "总价待核实"
                  : "暂不优先";
          const caution = [
            c.mixedUse ? "混合物业类型，住宅产权需核实" : "",
            c.crossCheck?.status?.includes("售罄")
              ? "另一来源标记住宅售罄"
              : "",
            c.missing ? "本次列表未再出现，不能据此判断已售" : "",
            c.stale ? "来源未更新，显示上次结果" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const affordable =
            !c.total && !c.areas?.length && c.unitPrice && p.budgetMax
              ? `按此均价，${p.budgetMax} 万约对应 ${number((p.budgetMax * 10000) / c.unitPrice)}㎡，有无该面积房源待核实。`
              : "";
          const map = `https://uri.amap.com/search?keyword=${encodeURIComponent("杭州 " + c.name)}&city=杭州&view=map`;
          return `<article class="candidate-card" data-candidate="${esc(c.id)}"><div class="home-card-top"><span class="home-tag">${c.kind === "new" ? "新房" : "二手房"}</span><span class="home-tag ${category(c, p) === "budget" ? "active" : ""}">${esc(scopeLabel)}</span></div><h3>${esc(c.name)}</h3><p class="home-muted">${esc([c.district, c.region, area(c), c.layout.replace(/\s*—.*$/, "")].filter(Boolean).join(" · "))}</p><p class="home-price">${esc(q.main)}</p><p class="home-quote">${esc(q.note)}</p>${c.unitPrice && c.total ? `<p class="home-quote">参考均价 ${esc(c.unitPrice)} 元/㎡</p>` : ""}${affordable ? `<p class="candidate-note">${esc(affordable)}</p>` : ""}<p class="candidate-note">${esc(c.address || "详细位置请查看来源与地图")}<br>通勤待核实 · ${esc(c.status)}</p>${caution ? `<p class="home-caution">${esc(caution)}</p>` : ""}${history(c)}<div class="candidate-bottom"><div><a href="${esc(url(c.url))}" target="_blank" rel="noopener noreferrer">查看房源 ↗</a> <a href="${esc(map)}" target="_blank" rel="noopener noreferrer">地图 ↗</a></div></div><p class="candidate-observed home-muted">该条检查于 ${esc(date(c.checkedAt))}</p></article>`;
        })
        .join("") ||
      `<div class="home-empty"><h3>这批来源暂时没有符合条件的线索</h3><p>可以查看“价格待核实”，或切换区域和房源类型。列表未覆盖全部市场。</p></div>`;
    $("#candidate-more").hidden = items.length <= limit;
    $("#candidate-more").textContent =
      `再看 ${Math.min(12, Math.max(0, items.length - limit))} 条 · 还有 ${Math.max(0, items.length - limit)} 条`;
    $("#candidate-coverage").textContent =
      feed.coverage + " 每天 9:00、16:00 检查，时间为北京时间。";
    $("#candidate-sources").innerHTML = feed.sources
      .map(
        (s) =>
          `<p><a href="${esc(url(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a> · ${s.ok ? `检查 ${esc(date(s.checkedAt))}` : `未更新${s.checkedAt ? ` · 上次成功 ${esc(date(s.checkedAt))}` : ""}`}</p>`,
      )
      .join("");
  }
  function accept(value) {
    if (
      value?.schema !== 1 ||
      !Array.isArray(value.items) ||
      !Array.isArray(value.sources) ||
      value.items.length > 500
    )
      throw new Error("房源数据格式暂不可用");
    if (
      !value.items.every(
        (c) =>
          c &&
          typeof c.name === "string" &&
          typeof c.id === "string" &&
          ["new", "resale"].includes(c.kind) &&
          url(c.url),
      )
    )
      throw new Error("房源数据格式暂不可用");
    // Apply the same requirements to old local caches and the public static feed.
    feed = { ...value, items: value.items.filter(H.candidateFits) };
    render();
  }
  async function load() {
    if (loading) return;
    loading = true;
    $("#candidate-refresh").disabled = true;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(FEED, {
        cache: "no-store",
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) throw new Error();
      origin = "";
      accept(await response.json());
      try {
        localStorage.setItem(CACHE, JSON.stringify(feed));
      } catch {}
      try {
        await (await caches.open(DATA_CACHE)).put(FEED, new Response(JSON.stringify(feed), { headers: { "Content-Type": "application/json" } }));
      } catch {}
    } catch {
      origin = "连接暂不可用，显示上次结果 · ";
      if (feed) render();
      else
        $("#candidate-message").textContent =
          "暂时无法读取房源，请联网后点“重新读取最新结果”。";
    } finally {
      clearTimeout(timeout);
      loading = false;
      $("#candidate-refresh").disabled = false;
    }
  }
  for (const id of [
    "candidate-budget",
    "candidate-scope",
    "candidate-kind",
    "candidate-area",
    "candidate-region",
  ])
    $("#" + id).addEventListener("change", () => {
      if (id === "candidate-area") $("#candidate-region").value = "";
      limit = 12;
      render();
    });
  $("#candidate-more").addEventListener("click", () => {
    limit += 12;
    render();
  });
  $("#candidate-refresh").addEventListener("click", load);
  window.addEventListener("online", load);
  $("#close-dialog").addEventListener("click", () => $("#info-dialog").close());
  $("#theme-toggle").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    $('meta[name="theme-color"]').content = theme === "dark" ? "#181818" : "#ffffff";
    try { localStorage.setItem("zrbac-news-theme", theme); } catch {}
  });
  // Retired shared links must not leave their private fragment visible in this public reader.
  if (/^#sync=/.test(location.hash)) window.history.replaceState(null, "", location.pathname + location.search);
  window.homeCandidatesReady = (async () => {
    try {
      const cached = localStorage.getItem(CACHE);
      if (cached) {
        origin = "上次结果 · ";
        accept(JSON.parse(cached));
      }
    } catch {}
    if (!feed) {
      try {
        const response = await (await caches.open(DATA_CACHE)).match(FEED);
        if (response?.ok) {
          origin = "上次结果 · ";
          accept(await response.json());
        }
      } catch {}
    }
    if (navigator.onLine !== false) await load();
    else if (feed) { origin = "离线，显示上次结果 · "; render(); }
    else $("#candidate-message").textContent = "尚未保存房源，请联网打开一次。";
  })();
})();
