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
  function detail(article) {
    const d = article.newsDetail;
    if (!d || !/^news-details-v[12]$/.test(d.revision) ||
        typeof d.summary !== "string" || d.summary.length < 16 || d.summary.length > 150 ||
        !validDate(d.updatedAt) || !/^[a-f0-9]{24}$/.test(d.inputHash)) return null;
    try {
      const original = new URL(article.originalUrl || article.url);
      if (!["http:", "https:"].includes(original.protocol) || original.username || original.password ||
          (original.port && !["80", "443"].includes(original.port))) return null;
      original.port = "";
      original.protocol = "https:";
      original.hash = "";
      for (const key of [...original.searchParams.keys()])
        if (/^utm_|^(fbclid|gclid)$/i.test(key)) original.searchParams.delete(key);
      return url(d.sourceUrl) === original.href ? d : null;
    } catch (_) { return null; }
  }
  function group(articles, titleKey) {
    const groups = new Map(), titles = new Map(), result = [];
    for (const article of articles) {
      const e = metadata(article);
      const key = /^notice-holidays-20\d{2}$/.test(article.briefEvent || "")
        ? article.briefEvent : article.outingGroup || (e ? e.eventId : titleKey(article));
      const title = titleKey(article);
      const existing = groups.get(key) || titles.get(title);
      if (existing) {
        existing.reports.push(article);
        groups.set(key, existing);
        titles.set(title, existing);
      } else {
        const item = { ...article, reports: [...(article.reports || [])] };
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
    const focused = document.activeElement, form = focused?.closest('[data-outing-settings]');
    const field = focused?.name, caret = typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const settings = form ? {startArea:form.elements.startArea.value,people:form.elements.people.value,transport:form.elements.transport.value} : profile.settings || {};
    if(form && field) Promise.resolve().then(()=>{const input=document.querySelector(`[data-outing-settings] [name="${field}"]`);input?.focus({preventScroll:true});if(input&&caret)input.setSelectionRange(...caret);});
    return `<details class="outing-profile"${profileOpen?' open':''}><summary>偏好设置</summary>
      <form data-outing-settings><label>出发地<input name="startArea" maxlength="50" value="${esc(settings.startArea||'')}" placeholder="例如：杭州五常"></label><label>人数<input name="people" type="number" min="1" max="10" value="${esc(settings.people??2)}"></label><label>出行方式<select name="transport"><option value="car"${settings.transport!=='transit'?' selected':''}>自驾</option><option value="transit"${settings.transport==='transit'?' selected':''}>公共交通</option></select></label><button class="text-button" type="submit">保存偏好</button></form></details>`;
  }
  let recordsRender;
  function renderRecords(data,state,formatTime) {
    recordsRender=[data,state,formatTime];
    const root=document.querySelector('#outing-records');if(!root)return;
    root.hidden=state.view!=='local';if(root.hidden)return;
    const target=document.querySelector(state.outingMode==='tonight'?'#tonight-plans':'#outing-recommendations');
    if(target.nextElementSibling!==root)target.after(root);
    const open=new Set([...root.querySelectorAll('details[open]')].map(d=>d.className));
    const file=root.querySelector('[data-tonight-file]');
    const profile=window.OutingProfile.snapshot(), records=profile.records;
    const journal=window.TonightJournal?.snapshot()||[];
    function list(status,label) {
      const selected=records.filter(r=>r.status===status);
      return `<details class="record-${status}"${open.has('record-'+status)?' open':''}><summary>${label} · ${selected.length}</summary>
        <ul class="outing-records">${selected.map(r=>{
          const place=r.id.startsWith('place:') && window.OutingLibrary.places().find(p=>'place:'+p.id===r.id);
          const href=url(r.url || place?.links?.find(l=>!l.url.includes('uri.amap.com'))?.url);
          return `<li><div>${r.id.startsWith('event:tonight-')?`<button class="text-button" data-tonight-open="${esc(r.id)}">${esc(r.title)}</button>`:place?`<button class="text-button" data-trip-place="${esc(place.id)}">${esc(r.title)}</button>`:href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(r.title)} ↗</a>`:`<span>${esc(r.title)}</span>`}
            ${r.area||r.day?`<p class="trip-note">${esc([r.day,r.area].filter(Boolean).join(' · '))}</p>`:''}</div>
            <div class="trip-links">${status==='want'?`<button class="text-button" data-record-visited="${esc(r.id)}">记为去过</button>`:''}<button class="text-button" data-outing-remove="${esc(r.id)}">撤销</button></div></li>`;
        }).join('')}</ul>${selected.length?'':'<p class="trip-note">在推荐或地点卡片上标记后，会出现在这里。</p>'}</details>`;
    }
    root.innerHTML=`<details class="our-outings"${open.has('our-outings')?' open':''}><summary>我们的记录 <span class="trip-note">${records.filter(r=>r.status==='want').length} 个想去 · ${journal.length} 条进展</span></summary>
      <p class="trip-note" role="status">${esc(window.OutingProfile.status())}</p>
      ${list('want','想去 / 喜欢')}${list('visited','去过')}
      ${window.NewsTonight?.journalMarkup(open.has('tonight-journal'),formatTime)||''}
      ${profileMarkup(open.has('outing-profile'))}${list('dismiss','不感兴趣')}
      <p id="record-operation-status" class="trip-note" role="status"></p></details>`;
    if(file)root.querySelector('[data-tonight-file]')?.replaceWith(file);
  }
  let lastRender, visiblePicks = new Map();
  function render(data, state, formatTime) {
    lastRender = [data, state, formatTime];
    const panel = document.querySelector("#outing-recommendations");
    if (!panel) return;
    const expanded = new Set(Array.from(panel.querySelectorAll(".trip-details[open]"),
      (details) => details.closest("li").dataset.tripKey));
    const moreOpen = panel.querySelector("[data-trip-more]")?.getAttribute("aria-expanded") === "true";
    const attributionOpen = panel.querySelector(".trip-attribution")?.open;
    panel.hidden = true;
    panel.innerHTML = "";
    const profileOnly = () => { panel.hidden = false; panel.innerHTML = `<p class="trip-note">本周推荐正在核对；可以先从地点库选玩法。</p>`; window.OutingProfile?.sync(false); };
    if (state.view !== "local" || state.outingMode === "tonight") return;
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
    const candidates = trip.picks.concat(trip.alternatives || []).filter((p) => {
      if (!p || typeof p !== "object") return false;
      const weather = forecast(trip, p);
      return typeof p.name === "string" && typeof p.reason === "string" && p.day >= today &&
        p.day >= trip.weekendStart && p.day <= trip.weekendEnd && weather &&
        [weather.low, weather.high, weather.rainProbability, weather.rainMm, weather.windKmh, weather.code].every(Number.isFinite) &&
        ((p.setting === "indoor" || (!p.setting && p.type === "rainy")) || (weather.code < 51 && weather.rainProbability < 60 && weather.rainMm < 3 && weather.windKmh < 30)) &&
        (!p.discovery || (validDate(p.verifiedAt) && now - Date.parse(p.verifiedAt) <= 48 * 3600000)) &&
        !window.OutingLibrary.excluded.test(p.name) && !window.OutingProfile?.excludes(p);
    });
    const picks = candidates.filter(p => p.discovery === true).slice(0, 12);
    const backups = candidates.filter(p => p.discovery !== true).slice(0, 12);
    const combined = [], used = new Set();
    const pool = picks.concat(backups);
    const kind = p => p.discovery ? /手作|手工|工坊|缝纫/.test(p.name)?'手作':p.type : p.type==='rainy' ? /手作|手工|拼豆|陶艺|缝纫/.test(p.name)?'手作':/剧院|剧场|话剧/.test(p.name)?'culture':/书店|图书馆/.test(p.name)?'阅读':'运动' : p.type;
    for(const p of pool) if(!used.has(kind(p))) {combined.push(p);used.add(kind(p));}
    for(const p of pool) if(!combined.includes(p)) combined.push(p);
    const suggestions=combined.slice(0,12);
    visiblePicks = new Map(candidates.map(p => [p.id, p]));
    panel.hidden = false;
    const updated = esc(formatTime(trip.updatedAt));
    const profile = window.OutingProfile?.snapshot() || { settings: {}, records: [] };
    const statuses = { visited: "去过", want: "想去", dismiss: "不感兴趣" };
    const cards = (items) => items.map((p, index) => {
      const primary=p.discovery === true;
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
      return `<li data-trip-key="${esc(key)}" data-outing-id="${esc(p.id)}"${index > 3 ? ` data-trip-extra${moreOpen ? "" : " hidden"}` : ""}>
        <p class="trip-kind">${primary?"限时活动":p.dynamic?"新收录地点":"常设去处"} · ${esc(types[p.type] || "出游")} · ${esc({indoor:"室内",outdoor:"室外",mixed:"含室外区域",unknown:"场地待确认"}[p.setting] || "场地待确认")}</p>
        <h3>${esc(p.name)}</h3><p class="trip-reason">${esc((p.summary || (primary ? p.reason : (p.details || '').split(/。/)[0]+'。') || p.reason).slice(0,110))}</p>
        <p class="trip-location">${esc(p.day.slice(5).replace('-','/'))} · ${esc(p.area || region.name)}</p>
        <p class="trip-practical">${esc(cost || '费用待确认')} · ${esc(booking || '预约情况见来源')}</p>
        <p class="trip-weather">${esc(region.name)} · ${esc(p.day.slice(5))} ${esc(weatherNames[w.code] || "天气预报")} ${esc(Math.round(w.low))}—${esc(Math.round(w.high))}℃ · 降水概率 ${esc(w.rainProbability)}%</p>
        <details class="trip-details"${expanded.has(key) ? " open" : ""}><summary>查看安排与来源</summary>
          <p><strong>为什么推荐：</strong>${esc(p.reason)}</p>

          ${primary && p.settingEvidence ? `<p><strong>场地依据：</strong>${esc(p.settingEvidence)}</p>` : ""}
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
    panel.innerHTML = `<div class="trip-heading"><h2>本周可选</h2><span>${esc(trip.weekendStart.slice(5).replace('-','/'))}—${esc(trip.weekendEnd.slice(5).replace('-','/'))}</span></div>
      <p class="trip-note">${suggestions.length} 个选择 · ${suggestions.filter(p=>p.discovery).length} 个限时活动 · ${updated} 核对${stale?' · 本轮暂未更新完成':''}</p>
      ${suggestions.length?`<ul class="trip-list trip-discoveries">${cards(suggestions)}</ul>`:'<p class="trip-empty">暂未核实到符合日期和天气条件的安排，先看看地点库。</p>'}
      ${suggestions.length>4?`<button class="text-button" data-trip-more aria-expanded="${moreOpen}">${moreOpen?'收起':`再看 ${suggestions.length-4} 个选择`}</button>`:''}
      <details class="trip-attribution"${attributionOpen?' open':''}><summary>筛选与更新</summary><p class="trip-note">每天9点、16点检索并核对来源，发布需要几分钟。先选不同玩法，再补充常设去处；不会把新收录写成新开放。去过或不感兴趣会避开，新增活动除外。<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">天气</a> ${esc(formatTime(trip.weather.updatedAt))} 获取。营业、价格与余位以主办方确认为准。</p></details>`;
    window.OutingProfile?.sync(false);
  }
  document.addEventListener("submit", event => {
    if (event.target.matches("[data-outing-settings]")) {
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
    const visited = event.target.closest('[data-record-visited]');
    if(visited) {const r=window.OutingProfile.snapshot().records.find(r=>r.id===visited.dataset.recordVisited);if(r)window.OutingProfile.mark({...r,name:r.title},'visited');return;}
    const remove = event.target.closest("[data-outing-remove]");
    if (remove) { window.OutingProfile?.update({action:"remove",id:remove.dataset.outingRemove}); return; }
    const more = event.target.closest("[data-trip-more]");
    if (more) {
      const expanded = more.getAttribute("aria-expanded") === "true";
      const extra = Array.from(document.querySelectorAll("[data-trip-extra]"));
      extra.forEach((row) => { row.hidden = expanded; });
      more.setAttribute("aria-expanded", String(!expanded));
      more.textContent = expanded ? `再看 ${extra.length} 个选择` : "收起";
      return;
    }
  });
  window.addEventListener('tonight-journal-change',()=>{if(recordsRender)renderRecords(...recordsRender);});
  window.NewsEditorial = { metadata, detail, group, render, profileMarkup, renderRecords };
})();
