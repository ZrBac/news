/* Evening plans are precomputed. Reading, changing choices and feedback work offline. */
(function () {
  "use strict";
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const dayOf = value => new Date(value + 8 * 3600000).toISOString().slice(0, 10);
  const preferenceKey = "news-tonight-choices-v1";
  let preferences = {}, round = 0, expanded = false, lastRender, visible = new Map(), message = "", signature = "";
  const drafts = new Map();
  let historyLimit = 20, removedRecord = null;
  try { preferences = JSON.parse(localStorage.getItem(preferenceKey)) || {}; } catch (_) {}
  if (typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
  if (![19, 21].includes(preferences.arrival)) preferences.arrival = new Date(Date.now() + 8 * 3600000).getUTCHours() >= 21 ? 21 : 19;
  if (!["active", "easy"].includes(preferences.energy)) preferences.energy = preferences.arrival === 21 ? "easy" : "active";
  const hash = value => { let h = 0; for (const c of value) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0; return h; };
  function safeUrl(value) {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch (_) { return ""; }
  }
  function currentWeather(data, now, today) {
    const weather = data.editorial?.trip?.weather;
    const age = now - Date.parse(weather?.updatedAt);
    if (!Number.isFinite(age) || age < -300000 || age > 24 * 3600000) return null;
    const days = weather?.regions?.hangzhou?.days;
    const row = Array.isArray(days) ? days.find(d => d.date === today) : null;
    if (!row || ![row.rainProbability, row.rainMm, row.windKmh, row.code].every(Number.isFinite)) return null;
    return {...row, updatedAt: weather.updatedAt,
      outside: row.rainProbability < 60 && row.rainMm < 3 && row.windKmh < 30 && row.code < 51};
  }
  function options(data, now) {
    const today = dayOf(now), weather = currentWeather(data, now, today);
    const records = window.OutingProfile?.snapshot().records || [];
    const progress = window.TonightJournal.snapshot();
    const home = data.editorial?.tonightHome;
    const generated = home?.revision === window.NewsTonightCatalog?.revision && home?.day === today && Array.isArray(home.ideas) ? home.ideas : [];
    const late = preferences.arrival === 21 || new Date(now + 8 * 3600000).getUTCHours() >= 21;
    let choices = (window.NewsTonightCatalog?.activities || []).map(base => {
      const entries = progress.filter(r => r.activityId === base.id);
      const pick = {...base, progress:entries[0], sessions:entries.length};
      const variant = generated.find(p => p.id === base.id);
      if (!pick.progress && base.project && base.setting === "home" && variant && typeof variant.name === "string" && typeof variant.summary === "string" &&
          Array.isArray(variant.steps) && variant.steps.length === 3 && variant.steps.every(s => typeof s === "string"))
        return {...pick, summary:variant.summary, steps:variant.steps, starter:variant.name, generated:true};
      return pick;
    });
    if (!late && preferences.energy === "active" && data.editorial?.tonight?.day === today) {
      for (const event of Array.isArray(data.editorial.tonight.events) ? data.editorial.tonight.events : []) {
        if (!event || typeof event !== "object") continue;
        const age = now - Date.parse(event.verifiedAt);
        const starts = Date.parse(today + "T" + event.startTime + ":00+08:00");
        const ends = Date.parse(today + "T" + event.endTime + ":00+08:00");
        if (/演唱会|博物馆|亲子|观赛|攀岩|抱石|滑冰|溜冰|冰场/.test(event.name) ||
            event.day !== today || !Number.isFinite(age) || age < -300000 || age > 48 * 3600000 ||
            !Number.isFinite(starts) || !Number.isFinite(ends) || starts - now < 30 * 60000 || ends <= starts ||
            !/^2[01]:[0-5]\d$/.test(event.startTime) || ends > Date.parse(today + "T22:00:00+08:00") ||
            ends - starts > 90 * 60000 || !event.timeEvidence ||
            !Array.isArray(event.sources) || !event.sources.some(s => safeUrl(s.url))) continue;
        const facts = event.facts || [];
        choices.push({...event, arrivals:[19], energy:"active", kind:"今晚活动", live:true,
          minutes:Math.round((ends - starts) / 60000),
          summary:event.novelty || "查看今晚的安排与来源。", materials:"先查实际路程、报名要求与余位；单程超过20分钟时换个近的。",
          steps:[`地点：${event.area}`, `原文时段：${event.timeEvidence}`, "先确认报名与回程，再出发。"],
          cost:facts.find(f => f.kind === "cost")?.text || "来源未公布费用，需向主办方确认。",
          booking:facts.find(f => f.kind === "booking")?.text || "是否预约与当前余位需确认。"});
      }
    }
    choices = choices.filter(p => {
      if (!p.arrivals.includes(preferences.arrival) || (late && (p.setting !== "home" || p.minutes > 40)) ||
          (preferences.energy === "easy" && p.energy !== "easy") ||
          (p.setting !== "home" && p.setting !== "indoor" && !weather?.outside)) return false;
      const record = records.find(r => r.id === p.id);
      if (record?.status === "dismiss") return false;
      if (record?.status === "visited" && !p.project) {
        const age = now - Date.parse(record.updatedAt);
        if (p.live || !Number.isFinite(age) || age < 7 * 86400000) return false;
      }
      p.liked = record?.status === "want";
      return true;
    });
    choices.sort((a,b) => Number(!!b.progress) - Number(!!a.progress) ||
      Number(!!b.live) - Number(!!a.live) || Number(b.liked) - Number(a.liked) ||
      Number(!!b.project) - Number(!!a.project) ||
      (round === 0 ? Number(!!b.generated) - Number(!!a.generated) : 0) ||
      hash(today + round + a.id) - hash(today + round + b.id));
    // Keep different kinds within the first three; do not fill the screen with
    // three variants of drawing, or only venues that still need a reservation.
    const diverse = [], used = new Set();
    for (const pick of choices) if (!used.has(pick.kind)) { diverse.push(pick); used.add(pick.kind); }
    for (const pick of choices) if (!diverse.includes(pick)) diverse.push(pick);
    if (!late && preferences.energy === "active" && !diverse.slice(0,3).some(p => p.setting !== "home")) {
      const index = diverse.findIndex(p => p.setting !== "home");
      if (index > 2) diverse.splice(2, 0, diverse.splice(index, 1)[0]);
    }
    return {choices:diverse, weather, today, late};
  }
  function journalMarkup(isOpen, formatTime) {
    const records = window.TonightJournal.snapshot();
    return `<details class="tonight-journal"${isOpen ? " open" : ""}><summary>我的积累 · ${records.length} 条记录</summary>
      <p class="trip-note">只保存在当前浏览器，不随共同记录同步，也不发送给 AI。照片、录音仍放在自己的相册或文件里。更换设备或清理浏览器前，请导出备份。</p>
      <div class="trip-links"><button class="text-button" data-tonight-export${records.length ? "" : " disabled"}>导出记录</button>
      <button class="text-button" data-tonight-import>导入记录</button><input type="file" data-tonight-file accept=".json,application/json" aria-label="选择今晚记录文件" hidden></div>
      ${window.TonightJournal.status() ? `<p class="trip-note" role="alert">${esc(window.TonightJournal.status())}</p>` : ""}
      ${records.length ? `<ul class="tonight-history">${records.slice(0,historyLimit).map(r => `<li>
        <p><strong>${esc(r.title)}</strong> <span class="trip-note">${esc(formatTime(r.createdAt))}</span></p>
        <p class="tonight-record-text">${esc(r.note)}</p>${r.next ? `<p class="tonight-record-text"><strong>下次：</strong>${esc(r.next)}</p>` : ""}
        <button class="text-button" data-tonight-remove="${esc(r.id)}" aria-label="删除${esc(r.title)}的这条记录">删除这条记录</button></li>`).join("")}</ul>` : '<p class="trip-note">做完一小段，在项目下记一句；下次打开就能接着来。</p>'}
      ${records.length > historyLimit ? '<button class="text-button" data-tonight-history-more>查看更多记录</button>' : ""}
      ${removedRecord ? '<button class="text-button" data-tonight-undo>撤销刚才的删除</button>' : ""}</details>`;
  }
  function recordingMarkup(p, isOpen) {
    const draft = drafts.get(p.id) || {note:"", next:p.progress?.next || p.project.next};
    return `<details class="tonight-recording"${isOpen ? " open" : ""}><summary>记下进展</summary>
      <form data-tonight-record="${esc(p.id)}">
        <label>这次留下了什么<textarea name="note" required maxlength="500" rows="3" placeholder="${esc(p.project.prompt)}">${esc(draft.note)}</textarea></label>
        <label>下次接着做<input name="next" maxlength="200" value="${esc(draft.next)}"></label>
        <p class="trip-note">文字只存本机，可离线记录；完整记录和备份在下方“我的积累”。</p>
        <button class="text-button" type="submit">保存这次进展</button>
      </form></details>`;
  }
  function render(data, state, formatTime) {
    lastRender = [data, state, formatTime];
    const panel = document.querySelector("#tonight-plans");
    if (!panel) return;
    const active = state.view === "local" && state.outingMode === "tonight";
    panel.hidden = !active;
    if (!active) { panel.innerHTML = ""; return; }
    const open = new Set(Array.from(panel.querySelectorAll(".tonight-details[open]"), d => d.closest("li").dataset.tonightId));
    const recordingOpen = new Set(Array.from(panel.querySelectorAll(".tonight-recording[open]"), d => d.closest("li").dataset.tonightId));
    const journalOpen = panel.querySelector(".tonight-journal")?.open;
    const attributionOpen = panel.querySelector(".trip-attribution")?.open;
    const profileOpen = panel.querySelector(".outing-profile")?.open;
    const focused = document.activeElement;
    const focusedRecord = focused?.closest("[data-tonight-record]")?.dataset.tonightRecord;
    const field = focusedRecord && focused.name;
    const selection = field && [focused.selectionStart, focused.selectionEnd];
    const focusAttribute = ["data-tonight-arrival","data-tonight-energy","data-tonight-more","data-tonight-shuffle"].find(a => focused?.hasAttribute(a));
    const focusValue = focusAttribute && focused.getAttribute(focusAttribute);
    const {choices, weather, today, late} = options(data, Date.now());
    signature = today + choices.map(p => p.id).join(",");
    visible = new Map(choices.map(p => [p.id, p]));
    const weatherNote = late && preferences.arrival === 19 ? "现在已过21点，先选在家能结束的小安排，累了也可以休息。" :
      preferences.arrival === 21 ? "先吃饭、洗漱，再选一件小事；累了也可以直接休息。" :
      weather ? (weather.outside ? `杭州市区今日降水概率 ${weather.rainProbability}%，外出前再看实际天气。` :
        "今日预报有雨或不适合户外，先选室内与居家安排。") : "今日天气暂未核实，先选室内与居家安排。";
    const home = data.editorial?.tonightHome;
    const homeCurrent = home?.revision === window.NewsTonightCatalog?.revision && home?.day === today && home.ideas?.length;
    const cards = choices.map((p,i) => {
      const place = p.setting === "home" ? "在家" : p.live ? "晚间活动" : "附近备选";
      const map = p.mapQuery || (p.live && p.area);
      const mapLink = map ? "https://uri.amap.com/search?keyword=" + encodeURIComponent(map) + "&city=杭州&callnative=0" : "";
      return `<li data-tonight-id="${esc(p.id)}"${i >= 3 ? ` data-tonight-extra${expanded ? "" : " hidden"}` : ""}>
        <p class="trip-kind">${place} · ${esc(p.kind)} · ${esc(p.minutes)} 分钟${p.setting !== "home" ? "，路程另计" : ""}${p.project && p.progress ? ` · 已记 ${p.sessions} 次` : ""}</p>
        <h3>${esc(p.name)}</h3><p class="tonight-summary">${esc(p.summary)}</p>
        ${p.project ? `<p class="tonight-output"><strong>留下：</strong>${esc(p.project.outcome)}</p>` : ""}
        ${p.project && p.progress ? `<div class="tonight-continuation"><p class="tonight-last-note"><strong>上次：</strong>${esc(p.progress.note)}</p>
          <p class="tonight-next"><strong>今晚接着：</strong>${esc(p.progress.next || p.project.next)}</p></div>` : ""}
        ${p.live ? `<p class="trip-weather">今天 ${esc(p.startTime)}—${esc(p.endTime)} · ${esc(p.area)}</p>` : ""}
        <details class="tonight-details"${open.has(p.id) ? " open" : ""}><summary>${p.live ? "时段、报名与来源" : p.project ? "怎么开始 / 准备什么" : "怎么玩 / 准备什么"}</summary>
          ${p.starter ? `<p class="tonight-starter"><strong>第一次可以试：</strong>${esc(p.starter)}</p>` : ""}
          <p><strong>准备：</strong>${esc(p.materials)}</p><ol>${p.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
          ${p.project && !p.progress ? `<p><strong>下次：</strong>${esc(p.project.next)}</p>` : ""}
          <p><strong>费用：</strong>${esc(p.cost)}</p>${p.booking ? `<p><strong>报名：</strong>${esc(p.booking)}</p>` : ""}
          <div class="trip-links">${p.link === "/games/" ? '<a href="/games/">打开小游戏 ↗</a>' : ""}
          ${mapLink ? `<a href="${esc(mapLink)}" target="_blank" rel="noopener noreferrer">${p.live ? "查看地点和路程" : "查附近场馆"} ↗</a>` : ""}
          ${p.live ? (p.sources || []).filter(s => safeUrl(s.url)).slice(0,2).map(s => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.label || "来源原文")} ↗</a>`).join("") : ""}
          ${p.live && safeUrl(p.bookingUrl) ? `<a href="${esc(safeUrl(p.bookingUrl))}" target="_blank" rel="noopener noreferrer">报名入口 ↗</a>` : ""}</div>
          ${p.live ? `<p class="trip-note">来源核对 ${esc(formatTime(p.verifiedAt))}；不代表实时余位。</p>` : ""}
        </details>
        ${p.project ? recordingMarkup(p, recordingOpen.has(p.id)) : ""}
        <div class="trip-feedback">${[...(!p.project ? [["visited","玩过"]] : []),["want","喜欢"],["dismiss","不感兴趣"]].map(([key,label]) => `<button class="text-button" data-tonight-feedback="${key}" aria-pressed="${key === "want" && p.liked}">${label}</button>`).join("")}</div>
      </li>`;
    }).join("");
    panel.innerHTML = `<div class="trip-heading"><h2>今晚做点什么</h2><span>${esc(today.slice(5).replace("-","/"))}</span></div>
      <div class="tonight-controls">
        <div class="tonight-arrival" role="group" aria-label="到家时间">${[19,21].map(h => `<button data-tonight-arrival="${h}" aria-pressed="${preferences.arrival === h}">${h} 点到家</button>`).join("")}</div>
        <div class="tonight-energy" role="group" aria-label="今晚精力">${[["active","有精神"],["easy","有点累"]].map(([key,label]) => `<button data-tonight-energy="${key}" aria-pressed="${preferences.energy === key}">${label}</button>`).join("")}</div>
      </div>
      <p class="trip-note tonight-context">${esc(weatherNote)}</p>
      <div class="tonight-list-heading"><span>${choices.length ? `可选 ${choices.length} 个安排 · 在做的优先` : "今晚轻松一点"}</span><button class="text-button" data-tonight-shuffle${choices.length < 2 ? " disabled" : ""}>换一组</button></div>
      <p id="tonight-feedback-status" class="trip-note" role="status" tabindex="-1"${message ? "" : " hidden"}>${esc(message)}</p>
      ${choices.length ? `<ul class="trip-list tonight-list">${cards}</ul>` : `<p class="trip-empty">这组安排已经看过或暂时不感兴趣。可以切换精力，或在下方记录里撤销反馈；今晚直接休息也可以。</p>`}
      ${choices.length > 3 ? `<button class="text-button" data-tonight-more aria-expanded="${expanded}">${expanded ? "收起" : `再看 ${choices.length - 3} 个安排`}</button>` : ""}
      ${journalMarkup(journalOpen, formatTime)}
      ${window.NewsEditorial?.profileMarkup(profileOpen) || ""}
      <details class="trip-attribution"${attributionOpen ? " open" : ""}><summary>安排怎么更新</summary><p class="trip-note">每天为尚未开始的居家项目整理一次起步选题${homeCurrent ? `，今天 ${esc(formatTime(home.updatedAt))} 已整理` : "，当前使用内置安排"}。有进展的项目按上次记录继续，不每天换题；刷新和“换一组”不影响记录。时长为建议预留。</p>
      <p class="trip-note">晚间活动随每天9点、16点的补充检索更新，实际发布可能延迟；只展示日期与晚间起止时刻明确的场次。附近备选是找场建议，营业与费用尚需确认。${data.editorial?.tonight?.researchedAt ? `最近检索 ${esc(formatTime(data.editorial.tonight.researchedAt))}。` : ""}</p>
      <p class="trip-note">有进展的项目优先，仍按到家时间、精力和天气筛选；“喜欢”优先，“不感兴趣”隐藏但保留进展，可在去处记录里撤销。普通活动“玩过”后7天内少重复。休息不需要记录。已缓存的文字可离线阅读，地图、来源和音乐视频需联网或提前下载。${weather ? `<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">天气：Open-Meteo</a> · ${esc(formatTime(weather.updatedAt))} 获取，为全天区域参考。` : ""}</p></details>`;
    if (focusAttribute) panel.querySelector(`[${focusAttribute}="${focusValue}"]`)?.focus({preventScroll:true});
    if (field && ["note","next"].includes(field)) {
      const input = panel.querySelector(`[data-tonight-record="${focusedRecord}"] [name="${field}"]`);
      input?.focus({preventScroll:true});
      if (input && selection) input.setSelectionRange(...selection);
    }
    window.OutingProfile?.sync(false);
  }
  function report(text) {
    message = text;
    const status = document.querySelector("#tonight-feedback-status");
    if (status) { status.textContent = text; status.hidden = false; }
  }
  document.addEventListener("input", event => {
    const form = event.target.closest("[data-tonight-record]");
    if (form) {
      drafts.set(form.dataset.tonightRecord, {note:form.elements.note.value, next:form.elements.next.value});
      form.querySelector(".tonight-save-error")?.remove();
    }
  });
  document.addEventListener("submit", event => {
    const form = event.target.closest("[data-tonight-record]");
    if (!form || !lastRender) return;
    event.preventDefault();
    const pick = visible.get(form.dataset.tonightRecord);
    if (!pick?.project) return;
    try {
      window.TonightJournal.add(pick, form.elements.note.value, form.elements.next.value);
      drafts.delete(pick.id);
      message = "进展已保存在本机，下次会接着这一步。";
      // Close the editor before re-rendering, so its saved draft is not restored.
      form.closest("details").open = false;
      render(...lastRender);
      document.querySelector("#tonight-feedback-status")?.focus({preventScroll:true});
    } catch (error) {
      report(error.message);
      let notice = form.querySelector(".tonight-save-error");
      if (!notice) {
        notice = document.createElement("p"); notice.className = "trip-note tonight-save-error";
        notice.setAttribute("role", "alert"); form.append(notice);
      }
      notice.textContent = error.message;
      // Keep the text, focus and caret when storage is unavailable.
    }
  });
  document.addEventListener("change", async event => {
    if (!event.target.matches("[data-tonight-file]")) return;
    const input = event.target, file = input.files[0];
    if (!file || !lastRender) return;
    try {
      if (file.size > 3 * 1024 * 1024) throw new Error("记录文件过大，请选择本站导出的 JSON 文件。");
      let value;
      try { value = JSON.parse(await file.text()); }
      catch (_) { throw new Error("无法读取记录文件，原有记录已保留。"); }
      const added = window.TonightJournal.restore(value);
      message = `已导入 ${added} 条记录，重复记录未添加。`;
      render(...lastRender);
    } catch (error) { report(error.message); }
    finally { input.value = ""; }
  });
  document.addEventListener("click", event => {
    const panel = event.target.closest("#tonight-plans");
    if (!panel || !lastRender) return;
    if (event.target.closest("[data-tonight-export]")) {
      try {
        const backup = window.TonightJournal.backup(), link = document.createElement("a");
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], {type:"application/json"}));
        link.href = url; link.download = `今晚记录-${dayOf(Date.now())}.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        report("已准备记录文件，请在浏览器下载或分享菜单中保存。");
      } catch (error) { report(error.message); }
      return;
    }
    if (event.target.closest("[data-tonight-import]")) { panel.querySelector("[data-tonight-file]").click(); return; }
    const remove = event.target.closest("[data-tonight-remove]");
    if (remove || event.target.closest("[data-tonight-undo]")) {
      try {
        if (remove) {
          removedRecord = window.TonightJournal.remove(remove.dataset.tonightRemove);
          message = "已删除这条记录，可在“我的积累”里撤销。";
        } else if (removedRecord) {
          window.TonightJournal.restore({app:"zacai-tonight-journal", schema:1, records:[removedRecord]});
          removedRecord = null; message = "已恢复记录。";
        }
        render(...lastRender);
      } catch (error) { report(error.message); }
      return;
    }
    if (event.target.closest("[data-tonight-history-more]")) { historyLimit += 20; render(...lastRender); return; }
    const arrival = event.target.closest("[data-tonight-arrival]"), energy = event.target.closest("[data-tonight-energy]");
    if (arrival || energy) {
      if (arrival) preferences.arrival = Number(arrival.dataset.tonightArrival);
      if (energy) preferences.energy = energy.dataset.tonightEnergy;
      try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch (_) {}
      expanded = false; round = 0; message = ""; render(...lastRender); return;
    }
    const feedback = event.target.closest("[data-tonight-feedback]");
    if (feedback) {
      const pick = visible.get(feedback.closest("[data-tonight-id]").dataset.tonightId);
      if (!pick) return;
      message = feedback.dataset.tonightFeedback === "visited" ? "已记下，近期少推荐这个玩法。可在下方记录里撤销。" :
        feedback.dataset.tonightFeedback === "want" ? "已记下，后面优先推荐。" : "已隐藏，可在下方记录里撤销。";
      window.OutingProfile?.mark(pick, feedback.dataset.tonightFeedback);
      document.querySelector("#tonight-feedback-status")?.focus({preventScroll:true});
      return;
    }
    if (event.target.closest("[data-tonight-more]")) { expanded = !expanded; render(...lastRender); }
    if (event.target.closest("[data-tonight-shuffle]")) { round++; expanded = false; message = ""; render(...lastRender); }
  });
  window.addEventListener("outing-feedback-change", () => { if (lastRender) render(...lastRender); });
  window.addEventListener("storage", event => { if (event.key === window.TonightJournal.key && lastRender) render(...lastRender); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && lastRender) render(...lastRender); });
  setInterval(() => {
    if (document.hidden || !lastRender || document.querySelector("#tonight-plans").hidden || document.activeElement?.closest("form")) return;
    const {choices, today} = options(lastRender[0], Date.now());
    if (signature !== today + choices.map(p => p.id).join(",")) render(...lastRender);
  }, 60000);
  window.NewsTonight = {render};
})();
