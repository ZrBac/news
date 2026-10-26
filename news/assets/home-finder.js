(() => {
  "use strict";
  const H = window.HomeBook,
    $ = (s) => document.querySelector(s);
  const API = $('meta[name="homes-api"]').content.replace(/\/$/, "");
  const FALLBACK = $('meta[name="home-candidates-fallback"]').content;
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
    limit = 6,
    origin = "",
    loading = false;
  const profile = () =>
    window.HomeNotebook?.snapshot().profile || H.defaults().profile;
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
    const saved = new Set(
      (window.HomeNotebook?.snapshot().homes || []).map((h) => h.sourceUrl),
    );
    const all = feed.items.filter(
      (c) =>
        (!kind || c.kind === kind) && (!district || c.district === district),
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
    const budgetCount = all.filter((c) => category(c, p) === "budget").length;
    $("#candidate-summary").textContent =
      `${budgetCount} 条预算内线索 · 新房展示参考总价，二手房展示单套挂牌价`;
    const failures = feed.sources.filter((s) => !s.ok).length;
    $("#candidate-message").textContent =
      `${origin}检查于 ${date(feed.updatedAt)}${failures ? ` · ${failures} 个来源本次未更新，保留上次结果` : ""} · 当前 ${items.length} 条`;
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
          return `<article class="candidate-card" data-candidate="${esc(c.id)}"><div class="home-card-top"><span class="home-tag">${c.kind === "new" ? "新房" : "二手房"}</span><span class="home-tag ${category(c, p) === "budget" ? "active" : ""}">${esc(scopeLabel)}</span></div><h3>${esc(c.name)}</h3><p class="home-muted">${esc([c.district, c.region, area(c), c.kind === "resale" ? c.layout : ""].filter(Boolean).join(" · "))}</p><p class="home-price">${esc(q.main)}</p><p class="home-quote">${esc(q.note)}</p>${c.unitPrice && c.total ? `<p class="home-quote">参考均价 ${esc(c.unitPrice)} 元/㎡</p>` : ""}${affordable ? `<p class="candidate-note">${esc(affordable)}</p>` : ""}<p class="candidate-note">${esc(c.address || "详细位置请查看来源与地图")}<br>通勤待核实 · ${esc(c.status)}</p>${caution ? `<p class="home-caution">${esc(caution)}</p>` : ""}${history(c)}<div class="candidate-bottom"><div><a href="${esc(url(c.url))}" target="_blank" rel="noopener noreferrer">查看房源 ↗</a> <a href="${esc(map)}" target="_blank" rel="noopener noreferrer">地图 ↗</a></div><button data-save-candidate="${esc(c.id)}" ${saved.has(c.url) ? "disabled" : ""}>${saved.has(c.url) ? "已收藏" : "＋ 收藏"}</button></div><p class="candidate-observed home-muted">该条检查于 ${esc(date(c.checkedAt))}</p></article>`;
        })
        .join("") ||
      `<div class="home-empty"><h3>这批来源暂时没有符合条件的线索</h3><p>可以查看“价格待核实”，或切换区域和房源类型。列表未覆盖全部市场。</p></div>`;
    $("#candidate-more").hidden = items.length <= limit;
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
    feed = value;
    render();
  }
  async function load() {
    if (loading) return;
    loading = true;
    $("#candidate-refresh").disabled = true;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(API + "/candidates", {
        cache: "no-store",
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) throw new Error();
      origin = "服务器";
      accept(await response.json());
      try {
        localStorage.setItem(CACHE, JSON.stringify(feed));
      } catch {}
    } catch {
      origin = "连接暂不可用，显示上次结果 · ";
      if (feed) render();
      else
        $("#candidate-message").textContent =
          "暂时无法读取候选，请联网后重试。你的收藏仍可使用。";
    } finally {
      clearTimeout(timeout);
      loading = false;
      $("#candidate-refresh").disabled = false;
    }
  }
  $("#candidate-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-save-candidate]");
    if (!button) return;
    const c = feed.items.find((x) => x.id === button.dataset.saveCandidate);
    if (!c) return;
    button.disabled = true;
    try {
      await window.homesInitialLoad;
      const next = window.HomeNotebook.snapshot();
      if (next.homes.some((h) => h.sourceUrl === c.url)) return;
      const now = new Date().toISOString(),
        q = price(c);
      const observation = c.checkedAt?.slice(0, 10) || now.slice(0, 10);
      next.homes.push(
        H.home({
          id: H.id(),
          name: c.name,
          kind: c.kind,
          district: [c.district, c.region].filter(Boolean).join(" · "),
          address: c.address || "",
          sourceUrl: c.url,
          size: c.areas?.[0] === c.areas?.[1] ? c.areas[0] : null,
          layout: c.kind === "resale" ? c.layout : "",
          createdAt: now,
          updatedAt: now,
          detail: `${q.main}；${q.note}。${c.unitPrice ? `参考均价 ${c.unitPrice} 元/㎡。` : ""}页面检查 ${date(c.checkedAt)}。${c.status}；通勤、余房及其他费用待核实。`,
          commute: { driver: next.profile.driver },
          prices:
            c.priceBasis === "listing" && c.total
              ? [
                  {
                    id: H.id(),
                    amount: c.total,
                    type: "asking",
                    date: observation,
                    source:
                      "房天下页面报价；此日期为检查日期，非发布或成交日期",
                    createdAt: now,
                  },
                ]
              : [],
          visits: [],
        }),
      );
      await window.HomeNotebook.save(next, next.revision);
      window.HomeNotebook.message(
        `已收藏 ${c.name}，可在下方“我的收藏与看房记录”中查看${c.priceBasis === "listing" ? "。" : "。楼盘参考金额保存在说明里，取得具体房号报价后再记入价格记录。"}`,
      );
    } catch (error) {
      window.HomeNotebook?.message(error.message);
    } finally {
      render();
    }
  });
  for (const id of ["candidate-scope", "candidate-kind", "candidate-area"])
    $("#" + id).addEventListener("change", () => {
      limit = 6;
      render();
    });
  $("#candidate-more").addEventListener("click", () => {
    limit += 6;
    render();
  });
  $("#candidate-refresh").addEventListener("click", load);
  window.addEventListener("homebookchange", render);
  window.addEventListener("online", load);
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
        const response = await fetch(FALLBACK);
        if (response.ok) {
          origin = "随页面保存的结果 · ";
          accept(await response.json());
        }
      } catch {}
    }
    await load();
  })();
})();
