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
  function profileMarkup(profileOpen) {
    const profile = window.OutingProfile?.snapshot() || {settings:{},records:[]};
    const settings = profile.settings || {};
    const statuses = { visited:"去过", want:"想去", dismiss:"不感兴趣" };
    return `      <details class="outing-profile"${profileOpen ? " open" : ""}><summary>我的去处 · ${profile.records.length} 条记录</summary>
        <p class="trip-note" role="status">${esc(window.OutingProfile?.status() || "记录保存在当前设备")}</p>
        <form data-outing-settings><label>出发地<input name="startArea" maxlength="50" value="${esc(settings.startArea || "")}" placeholder="例如：杭州五常"></label><label>人数<input name="people" type="number" min="1" max="10" value="${esc(settings.people || 2)}"></label><label>出行方式<select name="transport"><option value="car"${settings.transport !== "transit" ? " selected" : ""}>自驾</option><option value="transit"${settings.transport === "transit" ? " selected" : ""}>公共交通</option></select></label><button class="text-button" type="submit">保存偏好</button></form>
        ${window.OutingProfile?.connected() ? `<button class="text-button" data-outing-sync>同步共同记录</button><details class="outing-connection"><summary>更换连接码</summary>` : `<p class="trip-note">连接共同记录后，两台手机可共享反馈，后续自动整理也会参考。</p>`}<form data-outing-connect><label>专属连接码<input name="code" type="password" autocomplete="off" spellcheck="false"></label><button class="text-button" type="submit">连接</button></form>${window.OutingProfile?.connected() ? "</details>" : ""}
        <ul class="outing-records">${profile.records.slice(0,50).map(r => `<li><span>${esc(r.title)} · ${esc(statuses[r.status] || "")}</span><button class="text-button" data-outing-remove="${esc(r.id)}">撤销</button></li>`).join("")}</ul>
      </details>
`;
  }
  let lastRender, visiblePicks = new Map();
  function render(data, state, formatTime) {
    lastRender = [data, state, formatTime];
    const panel = document.querySelector("#outing-recommendations");
    if (!panel) return;
    const expanded = new Set(Array.from(panel.querySelectorAll(".trip-details[open]"),
      (details) => details.closest("li").dataset.tripKey));
    const moreOpen = panel.querySelector("[data-trip-more]")?.getAttribute("aria-expanded") === "true";
    const profileOpen = panel.querySelector(".outing-profile")?.open;
    const backupsOpen = panel.querySelector(".trip-backups")?.open;
    const attributionOpen = panel.querySelector(".trip-attribution")?.open;
    panel.hidden = true;
    panel.innerHTML = "";
    const profileOnly = () => { panel.hidden = false; panel.innerHTML = profileMarkup(profileOpen); window.OutingProfile?.sync(false); };
    if (state.view !== "local") return;
    const trip = data.editorial && data.editorial.trip;
    const now = Date.now(), today = dayOf(new Date(now).toISOString());
    if (!trip || !validDate(trip.updatedAt) ||
        !Array.isArray(trip.picks) || !/^\d{4}-\d{2}-\d{2}$/.test(trip.weekendStart) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(trip.weekendEnd) || trip.weekendEnd < today ||
        Date.parse(trip.weekendStart) - Date.parse(today) > 6 * 86400000) return profileOnly();
    // Stale forecasts can be read offline with their timestamp, for at most 48h.
    // After that only the existing place references and dated source stories remain.
    if (!trip.weather || !validDate(trip.weather.updatedAt) || now - Date.parse(trip.weather.updatedAt) > 48 * 3600000) return profileOnly();
    const stale = now - Date.parse(trip.weather.updatedAt) > 24 * 3600000 || trip.status !== "ok";
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = trip.picks.concat(trip.alternatives || []).filter((p) => {
      if (!p || typeof p !== "object") return false;
      const weather = forecast(trip, p);
      const category = ["hiking", "cycling"].includes(p.type) ? "outdoor" : p.type === "rainy" ? "culture" : p.type;
      return typeof p.name === "string" && typeof p.reason === "string" && p.day >= today &&
        p.day >= trip.weekendStart && p.day <= trip.weekendEnd && weather &&
        [weather.low, weather.high, weather.rainProbability, weather.rainMm, weather.windKmh, weather.code].every(Number.isFinite) &&
        ((p.setting === "indoor" || (!p.setting && p.type === "rainy")) || (weather.code < 51 && weather.rainProbability < 60 && weather.rainMm < 3 && weather.windKmh < 30)) &&
        (!p.discovery || (validDate(p.verifiedAt) && now - Date.parse(p.verifiedAt) <= 48 * 3600000)) &&
        (state.outingType === "all" || category === state.outingType) && state.source === "all" && !state.date &&
        words.every((w) => (p.name + " " + p.reason + " " + p.area).toLowerCase().includes(w)) &&
        !/演唱会|博物馆|亲子|观赛|攀岩|抱石|滑冰|溜冰|冰场/.test(p.name) && !window.OutingProfile?.excludes(p);
    });
    const picks = candidates.filter(p => p.discovery === true).slice(0, 3);
    const backups = candidates.filter(p => p.discovery !== true).slice(0, 3);
    visiblePicks = new Map(candidates.map(p => [p.id, p]));
    panel.hidden = false;
    const updated = esc(formatTime(trip.updatedAt));
    const profile = window.OutingProfile?.snapshot() || { settings: {}, records: [] };
    const statuses = { visited: "去过", want: "想去", dismiss: "不感兴趣" };
    const cards = (items, primary) => items.map((p, index) => {
      const w = forecast(trip, p), region = trip.weather.regions[p.region];
      const links = (Array.isArray(p.sources) ? p.sources : []).filter(s => url(s.url)).slice(0, 2);
      const facts = Array.isArray(p.facts) ? p.facts : [];
      const cost = facts.find(f => f.kind === "cost")?.text;
      const booking = facts.find(f => f.kind === "booking")?.text;
      const record = profile.records.find(r => r.id === p.id);
      const key = JSON.stringify([p.id || p.name, p.day]);
      const reference = p.placeId && /^[a-z0-9-]+$/.test(p.placeId)
        ? `<button class="text-button" data-trip-place="${esc(p.placeId)}">路线与条件</button>` : "";
      const newsLinks = (Array.isArray(p.news) ? p.news : []).filter(n => url(n.url) && validDate(n.publishedAt)).slice(0, 1);
      return `<li data-trip-key="${esc(key)}" data-outing-id="${esc(p.id)}"${primary && index > 1 ? ` data-trip-extra${moreOpen ? "" : " hidden"}` : ""}>
        <p class="trip-kind">${esc(types[p.type] || "出游")} · ${esc({indoor:"室内",outdoor:"室外",mixed:"含室外区域",unknown:"场地待确认"}[p.setting] || "场地待确认")}</p>
        <h3>${esc(p.name)}</h3><p class="trip-reason">${esc(primary ? p.novelty : p.reason)}</p>
        <p class="trip-weather">${esc(region.name)} · ${esc(p.day.slice(5))} ${esc(weatherNames[w.code] || "天气预报")} ${esc(Math.round(w.low))}—${esc(Math.round(w.high))}℃ · 降水概率 ${esc(w.rainProbability)}%</p>
        <details class="trip-details"${expanded.has(key) ? " open" : ""}><summary>查看安排与来源</summary>
          <p><strong>为什么推荐：</strong>${esc(p.reason)}</p>
          ${primary ? `<p><strong>活动日期：</strong>${esc(p.start)}—${esc(p.end)}</p><p><strong>地点：</strong>${esc(p.area || "详细地点待确认")}</p>
          <p><strong>费用：</strong>${esc(cost || "来源未公布，需确认两人总价")}${cost ? "（原文口径，两人总价以报名页为准）" : ""}</p>
          <p><strong>预约：</strong>${esc(booking || "是否需预约及余位待确认")}</p>` : `<p class="trip-note">常设地点参考 · 基础资料 ${esc(p.reviewedOn || "见来源")}；出发前确认开放与预约。</p>`}
          ${newsLinks.map(n => `<p class="trip-news"><a href="${esc(url(n.url))}" target="_blank" rel="noopener noreferrer">${esc(n.title)} ↗</a><span>报道 ${esc(formatTime(n.publishedAt))}</span></p>`).join("")}
          <div class="trip-links">${reference}${p.mapUrl && url(p.mapUrl) ? `<a href="${esc(url(p.mapUrl))}" target="_blank" rel="noopener noreferrer">地图 ↗</a>` : ""}${p.bookingUrl && url(p.bookingUrl) ? `<a href="${esc(url(p.bookingUrl))}" target="_blank" rel="noopener noreferrer">预约入口 ↗</a>` : ""}${links.map(l => `<a href="${esc(url(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label || "来源原文")} ↗</a>`).join("")}</div>
          ${p.verifiedAt ? `<p class="trip-note">来源核对 ${esc(formatTime(p.verifiedAt))}；开放、费用与余位以主办方最新公告为准。</p>` : ""}
        </details>
        <div class="trip-feedback">${Object.entries(statuses).map(([value,label]) => `<button class="text-button" data-outing-feedback="${value}" aria-pressed="${record?.status === value}">${label}</button>`).join("")}</div>
      </li>`;
    }).join("");
    panel.innerHTML = `<div class="trip-heading"><h2>本周新发现</h2><span>${esc(trip.weekendStart.slice(5).replace("-", "/"))}—${esc(trip.weekendEnd.slice(5).replace("-", "/"))}</span></div>
      <p class="trip-note">${updated} 整理 · ${picks.length} 个新活动${stale ? " · 更新暂未完成，以下为上次资料" : ""}</p>
      ${picks.length ? `<ul class="trip-list trip-discoveries">${cards(picks, true)}</ul>` : `<p class="trip-empty">暂未找到符合当前条件、日期与来源明确的新活动。新的活动消息会继续补充。</p>`}
      ${picks.length > 2 ? `<button class="text-button" data-trip-more aria-expanded="${moreOpen}">${moreOpen ? "收起" : "再看 1 个新发现"}</button>` : ""}
      ${backups.length ? `<details class="trip-backups"${backupsOpen ? " open" : ""}><summary>常设备选 · ${backups.length} 个</summary><ul class="trip-list">${cards(backups, false)}</ul></details>` : ""}
      ${profileMarkup(profileOpen)}
      <details class="trip-attribution"${attributionOpen ? " open" : ""}><summary>推荐依据</summary><p class="trip-note">新发现依据近期来源中的具体活动安排，AI 辅助筛选；常设地点单列为备选。未公布的费用、预约和余位不作推断。<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">天气：Open-Meteo</a> · ${esc(formatTime(trip.weather.updatedAt))} 获取；预报为区域参考。</p></details>`;
    window.OutingProfile?.sync(false);
  }
  window.addEventListener("outing-feedback-change", () => { if (lastRender) render(...lastRender); });
  document.addEventListener("submit", event => {
    if (event.target.matches("[data-outing-connect]")) {
      event.preventDefault(); window.OutingProfile?.connect(new FormData(event.target).get("code").trim());
    } else if (event.target.matches("[data-outing-settings]")) {
      event.preventDefault(); const f = new FormData(event.target);
      window.OutingProfile?.update({action:"settings",startArea:f.get("startArea").trim(),people:Number(f.get("people")),transport:f.get("transport")});
    }
  });

  document.addEventListener("click", (event) => {
    const feedback = event.target.closest("[data-outing-feedback]");
    if (feedback) {
      const pick = visiblePicks.get(feedback.closest("[data-outing-id]").dataset.outingId);
      if (pick) window.OutingProfile?.mark(pick, feedback.dataset.outingFeedback);
      return;
    }
    const remove = event.target.closest("[data-outing-remove]");
    if (remove) { window.OutingProfile?.update({action:"remove",id:remove.dataset.outingRemove}); return; }
    if (event.target.closest("[data-outing-sync]")) { window.OutingProfile?.sync(true); return; }
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
