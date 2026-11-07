/* On-demand advice; no model calls on page load, navigation, or reconnect. */
(function () {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const panel = $("#outing-now");
  if (!panel) return;
  const form = $("#outing-now-form"), status = $("#outing-now-status"), results = $("#outing-now-result");
  const submit = $("#outing-now-submit"), cancel = $("#outing-now-cancel");
  const key = "news-outing-now-v1", draftKey = "news-outing-now-draft-v1";
  const waitLimit = 60000;
  let saved = null, active = null;
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const safe = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch (_) { return ""; } };
  const time = value => { const d = new Date(Date.parse(value) + 8 * 3600000); return Number.isFinite(d.getTime()) ? d.toISOString().slice(5,16).replace("T", " ") : ""; };
  const valid = data => data?.schema === 1 && Number.isFinite(Date.parse(data.generatedAt)) && typeof data.intro === "string" &&
    Array.isArray(data.ideas) && data.ideas.length === 3 && data.ideas.every(p => typeof p.title === "string" &&
      typeof p.id === "string" && typeof p.reason === "string" && Number.isFinite(p.minutes) && Array.isArray(p.steps) &&
      p.steps.every(s => typeof s === "string") && typeof p.outcome === "string" && Array.isArray(p.sources));
  function endpoint() {
    try { const u = new URL($('meta[name="news-refresh-endpoint"]').content); u.pathname = "/api/outings/now"; return u.href; } catch (_) { return ""; }
  }
  function draw() {
    if (!saved) return;
    results.hidden = false;
    const age = Date.now() - Date.parse(saved.generatedAt);
    const weather = saved.weather;
    results.innerHTML = `<p class="trip-note">${esc(time(saved.generatedAt))} 生成${age > 30 * 60000 ? " · 上次建议，时间和天气可能已变化" : ""}</p>
      <p class="outing-now-intro">${esc(saved.intro)}</p>
      <ol class="outing-now-ideas">${saved.ideas.map((p, i) => `<li>
        <span class="trip-kind">${p.setting === "home" ? "在家" : "出门参考"} · 约 ${esc(p.minutes)} 分钟${p.setting !== "home" ? "（含往返）" : ""}</span>
        <h3>${esc(p.title)}</h3><p>${esc(p.reason)}</p>
        <p class="outing-now-first"><strong>先做：</strong>${esc(p.steps[0])}</p>
        <details class="tonight-details"><summary>接下来怎么做</summary>
          <ol>${p.steps.slice(1).map(s => `<li>${esc(s)}</li>`).join("")}</ol><p>留下什么：${esc(p.outcome)}</p>
          ${p.setting !== "home" ? `<p class="trip-note">${esc(p.area)} · 当天营业、场次、价格与余位需出发前确认。${p.checkedAt ? "资料核对 " + esc(time(p.checkedAt)) : ""}</p>` : ""}
          <div class="trip-links">${p.sources.filter(s => safe(s.url)).map(s => `<a href="${esc(safe(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.label || "来源")} ↗</a>`).join("")}</div>
        </details>
        ${p.setting !== "home" ? `<button type="button" class="text-button outing-now-save" data-now-save="${i}">记到想去</button>` : ""}
      </li>`).join("")}</ol>
      <p class="trip-note outing-now-weather">${weather ? `天气参考：${esc(weather.area)}，${esc(weather.temperature)}°C，未来这段时间降雨概率最高 ${esc(weather.rainProbability)}%。<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> ${esc(time(weather.observedAt))}` : "本次未取得可用的实时天气，按在家或室内安排。"}</p>`;
    submit.textContent = "换几个建议";
  }
  try {
    const previous = JSON.parse(sessionStorage.getItem(key));
    if (valid(previous) && Date.now() - Date.parse(previous.generatedAt) < 24 * 3600000) saved = previous;
  } catch (_) {}
  if (new Date(Date.now() + 8 * 3600000).getUTCHours() >= 21) $("#outing-now-minutes").value = "30";
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (["30","60","120","240"].includes(draft?.minutes) && ["auto","home","outside"].includes(draft.setting) &&
        typeof draft.note === "string" && draft.note.length <= 300) {
      $("#outing-now-minutes").value = draft.minutes;
      $("#outing-now-setting").value = draft.setting;
      $("#outing-now-note").value = draft.note;
    }
  } catch (_) {}
  function saveDraft() {
    try { sessionStorage.setItem(draftKey, JSON.stringify({minutes:$("#outing-now-minutes").value,
      setting:$("#outing-now-setting").value, note:$("#outing-now-note").value})); } catch (_) {}
  }
  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  draw();
  const online = () => {
    if (!active && !navigator.onLine) status.textContent = "即时建议需要联网。" + (saved ? "下方保留上次结果。" : "可以先看下面已保存的今晚、周末安排。");
  };
  online();
  window.addEventListener("offline", online);
  window.addEventListener("online", () => { if (!active) status.textContent = "已联网，可以点击获取当前建议。"; });
  panel.addEventListener("toggle", () => { if (panel.open && !active) { draw(); online(); } });
  cancel.addEventListener("click", () => active?.stop("cancelled"));
  const resume = () => {
    // Mobile browsers suspend timers in the background. Enforce elapsed wall
    // time as soon as this page becomes visible again, including bfcache restores.
    if (active && Date.now() >= active.deadline) active.stop("timeout");
  };
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (active) return;
    if (!navigator.onLine) { online(); return; }
    if (!endpoint()) { status.textContent = "暂时无法连接，请稍后再试。"; return; }
    const controller = new AbortController(), run = {controller, deadline:Date.now() + waitLimit};
    // Abort is best-effort. Independently settle the UI even if a connection or
    // response body ignores the abort signal, and ignore its eventual late reply.
    const stopped = new Promise((_, reject) => { run.stop = reason => {
      reject(new Error(reason)); controller.abort();
    }; });
    active = run;
    const input = {minutes:Number($("#outing-now-minutes").value), setting:$("#outing-now-setting").value,
      note:$("#outing-now-note").value.trim(), previous:saved?.ideas.map(p => p.title.slice(0,120)) || []};
    saveDraft();
    submit.disabled = true; submit.textContent = "正在生成…"; cancel.hidden = false; results.setAttribute("aria-busy", "true");
    status.textContent = "正在结合当前时间、天气和偏好想几个安排…";
    const slow = setTimeout(() => { status.textContent = "还在生成，本次最多等待 1 分钟。可以取消，输入会保留。"; }, 10000);
    const timer = setTimeout(() => run.stop("timeout"), waitLimit);
    try {
      const data = await Promise.race([stopped, (async () => {
        const response = await fetch(endpoint(), {method:"POST", cache:"no-store", headers:{"Content-Type":"application/json"},
          body:JSON.stringify(input), signal:controller.signal});
        if (!response.ok) throw new Error(response.status === 429 ? "busy" : response.status === 504 ? "timeout" : "unavailable");
        const result = await response.json();
        if (!valid(result)) throw new Error("unavailable");
        return result;
      })()]);
      if (Date.now() >= run.deadline) throw new Error("timeout");
      saved = data;
      try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch (_) {}
      draw(); status.textContent = "按这次条件整理好了。想换方向，可以补充一句再试。";
    } catch (error) {
      status.textContent = (error.message === "cancelled" ? "已取消等待，输入已保留。" : error.name === "AbortError" || error.message === "timeout" ? "这次等待超时，输入已保留，可以点击重试。" : error.message === "busy" ? "正在处理其他请求，稍等半分钟再试。" : "这次没能取得建议，输入已保留，请重试。") + (saved ? "下方仍是上次结果。" : "");
      controller.abort();
    } finally {
      clearTimeout(timer); clearTimeout(slow); active = null; submit.disabled = false; cancel.hidden = true;
      submit.textContent = saved ? "换几个建议" : "给我建议";
      results.removeAttribute("aria-busy");
    }
  });
  results.addEventListener("click", event => {
    const button = event.target.closest("[data-now-save]");
    const item = button && saved?.ideas[Number(button.dataset.nowSave)];
    if (!item) return;
    window.OutingProfile.mark({id:item.id, name:item.title, area:item.area, url:item.sources.find(s => safe(s.url))?.url}, "want");
    button.textContent = "已记下"; button.disabled = true;
  });
})();
