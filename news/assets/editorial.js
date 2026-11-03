/* Shared, precomputed editorial results. No API requests or credentials here. */
(function () {
  "use strict";
  const validDate = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function url(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
    } catch (_) { return ""; }
  }
  function dayOf(value) {
    return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
  }
  function metadata(article) {
    const e = article.editorial;
    return e && /^event-[a-f0-9]{24}$/.test(e.eventId) &&
      typeof e.summary === "string" && e.summary.length <= 120 && validDate(e.updatedAt) ? e : null;
  }
  function group(articles, titleKey) {
    const groups = new Map(), titles = new Map(), result = [];
    for (const article of articles) {
      const e = metadata(article);
      const key = e ? e.eventId : titleKey(article);
      const title = titleKey(article);
      const existing = groups.get(key) || titles.get(title);
      if (existing) {
        existing.reports.push(article);
        groups.set(key, existing);
        titles.set(title, existing);
      } else {
        const item = { ...article, reports: [] };
        groups.set(key, item);
        titles.set(title, item);
        result.push(item);
      }
    }
    return result;
  }
  function forecast(trip, pick) {
    const region = trip.weather && trip.weather.regions && trip.weather.regions[pick.region];
    return region && Array.isArray(region.days) ? region.days.find((d) => d.date === pick.day) : null;
  }
  const weatherNames = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾",
    51: "小雨", 53: "小雨", 55: "小雨", 56: "冻雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪", 80: "阵雨", 81: "阵雨", 82: "强阵雨",
    85: "阵雪", 86: "阵雪", 95: "雷雨", 96: "雷雨", 99: "雷雨",
  };
  const types = { hiking: "爬山", cycling: "骑行", camping: "露营", rainy: "雨天备选",
    market: "市集节庆", culture: "展览演出", outdoor: "户外周边" };
  function render(data, state, formatTime) {
    const panel = document.querySelector("#outing-recommendations");
    if (!panel) return;
    const expanded = new Set(Array.from(panel.querySelectorAll(".trip-details[open]"),
      (details) => details.closest("li").dataset.tripKey));
    const moreOpen = panel.querySelector("[data-trip-more]")?.getAttribute("aria-expanded") === "true";
    const attributionOpen = panel.querySelector(".trip-attribution")?.open;
    panel.hidden = true;
    panel.innerHTML = "";
    const trip = data.editorial && data.editorial.trip;
    const now = Date.now(), today = dayOf(new Date(now).toISOString());
    if (state.view !== "local" || !trip || !validDate(trip.updatedAt) ||
        !Array.isArray(trip.picks) || !/^\d{4}-\d{2}-\d{2}$/.test(trip.weekendStart) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(trip.weekendEnd) || trip.weekendEnd < today ||
        Date.parse(trip.weekendStart) - Date.parse(today) > 6 * 86400000) return;
    // Stale forecasts can be read offline with their timestamp, for at most 48h.
    // After that only the existing place references and dated source stories remain.
    if (!trip.weather || !validDate(trip.weather.updatedAt) || now - Date.parse(trip.weather.updatedAt) > 48 * 3600000) return;
    const stale = now - Date.parse(trip.weather.updatedAt) > 24 * 3600000 || trip.status !== "ok";
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const picks = trip.picks.filter((p) => {
      if (!p || typeof p !== "object") return false;
      const weather = forecast(trip, p);
      const category = ["hiking", "cycling"].includes(p.type) ? "outdoor" : p.type === "rainy" ? "culture" : p.type;
      return typeof p.name === "string" && typeof p.reason === "string" && p.day >= today &&
        p.day >= trip.weekendStart && p.day <= trip.weekendEnd && weather &&
        [weather.low, weather.high, weather.rainProbability, weather.rainMm, weather.windKmh, weather.code].every(Number.isFinite) &&
        (p.type === "rainy" || (weather.code < 51 && weather.rainProbability < 60 && weather.rainMm < 3 && weather.windKmh < 30)) &&
        (state.outingType === "all" || category === state.outingType) && state.source === "all" && !state.date &&
        words.every((w) => (p.name + " " + p.reason + " " + p.area).toLowerCase().includes(w)) &&
        !/演唱会|博物馆|亲子|观赛|攀岩|抱石|滑冰|溜冰|冰场/.test(p.name);
    }).slice(0, 4);
    if (!picks.length) return;
    panel.hidden = false;
    const updated = esc(formatTime(trip.updatedAt));
    panel.innerHTML = `<div class="trip-heading"><h2>本周出行</h2><span>${esc(trip.weekendStart.slice(5).replace("-", "/"))}—${esc(trip.weekendEnd.slice(5).replace("-", "/"))}</span></div>
      <p class="trip-note">结合天气挑选 · ${updated} 整理${stale ? " · 更新暂未完成，以下为上次建议" : ""}</p>
      <ul class="trip-list">${picks.map((p, index) => {
        const w = forecast(trip, p), region = trip.weather.regions[p.region];
        const links = (Array.isArray(p.sources) ? p.sources : []).filter((s) => url(s.url)).slice(0, 2);
        const reference = p.placeId && /^[a-z0-9-]+$/.test(p.placeId)
          ? `<button class="text-button" data-trip-place="${esc(p.placeId)}">路线与条件</button>` : "";
        const newsLinks = (Array.isArray(p.news) ? p.news : []).filter((n) => url(n.url) && validDate(n.publishedAt)).slice(0, 1);
        const key = JSON.stringify([p.id || p.name, p.day]);
        return `<li data-trip-key="${esc(key)}"${index > 1 ? ` data-trip-extra${moreOpen ? "" : " hidden"}` : ""}><p class="trip-kind">${esc(types[p.type] || "出游")}${p.type === "rainy" ? "" : " · " + esc(p.day.slice(5).replace("-", "/"))}</p>
          <h3>${esc(p.name)}</h3><p class="trip-reason">${esc(p.reason)}</p>
          <p class="trip-weather">${esc(region.name)} · ${esc(p.day.slice(5))} ${esc(weatherNames[w.code] || "天气预报")} ${esc(Math.round(w.low))}—${esc(Math.round(w.high))}℃ · 降水概率 ${esc(w.rainProbability)}%</p>
          <details class="trip-details"${expanded.has(key) ? " open" : ""}><summary>查看建议、路线与来源</summary><p>${esc(p.reason)}</p>
          ${p.reviewedOn ? `<p class="trip-note">地点参考 · 基础资料 ${esc(p.reviewedOn)}；开放与预约以当天公告为准。</p>` : `<p class="trip-note">活动日期 ${esc(p.start)}—${esc(p.end)}</p>`}
          ${newsLinks.map((n) => `<p class="trip-news"><a href="${esc(url(n.url))}" target="_blank" rel="noopener noreferrer">${esc(n.title)} ↗</a><span>报道 ${esc(formatTime(n.publishedAt))}</span></p>`).join("")}
          <div class="trip-links">${reference}${p.mapUrl && url(p.mapUrl) ? `<a href="${esc(url(p.mapUrl))}" target="_blank" rel="noopener noreferrer">地图 ↗</a>` : ""}${links.map((s) => `<a href="${esc(url(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.label || "来源原文")} ↗</a>`).join("")}</div></details></li>`;
      }).join("")}</ul>${picks.length > 2 ? `<button class="text-button" data-trip-more aria-expanded="${moreOpen}">${moreOpen ? "收起" : `再看 ${picks.length - 2} 个建议`}</button>` : ""}
      <details class="trip-attribution"${attributionOpen ? " open" : ""}><summary>推荐依据 · AI 辅助整理</summary><p class="trip-note">结合已收录资料与天气预报挑选，来源见各条建议。<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">天气：Open-Meteo</a> · ${esc(formatTime(trip.weather.updatedAt))} 获取；预报为区域参考，山地天气可能不同。</p></details>`;
  }
  document.addEventListener("click", (event) => {
    const more = event.target.closest("[data-trip-more]");
    if (more) {
      const expanded = more.getAttribute("aria-expanded") === "true";
      const extra = Array.from(document.querySelectorAll("[data-trip-extra]"));
      extra.forEach((row) => { row.hidden = expanded; });
      more.setAttribute("aria-expanded", String(!expanded));
      more.textContent = expanded ? `再看 ${extra.length} 个建议` : "收起";
      return;
    }
  });
  window.NewsEditorial = { metadata, group, render };
})();
