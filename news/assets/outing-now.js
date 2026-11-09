/* Explicit generation; reopening only reads the previously submitted job. */
(function () {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const panel = $("#outing-now");
  if (!panel) return;
  const form = $("#outing-now-form"), status = $("#outing-now-status"), results = $("#outing-now-result");
  const submit = $("#outing-now-submit"), cancel = $("#outing-now-cancel");
  const key = "news-outing-now-state-v2";
  const hint = status.textContent.trim(), summary = panel.querySelector("summary span");
  const waitLimit = 150000, requestLimit = 12000;
  let saved = null, active = null, attempt = null, durable = true, writtenAt = 0;
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const safe = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch (_) { return ""; } };
  const time = value => { const d = new Date(Date.parse(value) + 8 * 3600000); return Number.isFinite(d.getTime()) ? d.toISOString().slice(5,16).replace("T", " ") : ""; };
  const valid = data => data?.schema === 1 && Number.isFinite(Date.parse(data.generatedAt)) && typeof data.intro === "string" &&
    Array.isArray(data.ideas) && data.ideas.length === 3 && data.ideas.every(p => p && typeof p.title === "string" &&
      typeof p.id === "string" && typeof p.reason === "string" && Number.isFinite(p.minutes) && Array.isArray(p.steps) &&
      p.steps.every(s => typeof s === "string") && typeof p.outcome === "string" && Array.isArray(p.sources) &&
      p.sources.every(s => s && typeof s.url === "string"));
  const validDraft = draft => ["30","60","120","240"].includes(draft?.minutes) &&
    ["auto","home","outside"].includes(draft.setting) && typeof draft.note === "string" && draft.note.length <= 300;
  const validAttempt = value => typeof value?.id === "string" && Number.isFinite(Date.parse(value.startedAt)) &&
    ["pending","ok","cancelled","timeout","busy","unavailable","paused","disconnected","not_submitted"].includes(value.outcome);
  const hasJob = () => /^[a-f0-9]{32}$/.test(attempt?.jobId) && validDraft({...attempt.input,minutes:String(attempt.input?.minutes)}) &&
    Array.isArray(attempt.input.previous) && attempt.input.previous.length <= 6;
  const recoverable = () => hasJob() && ["pending","paused","disconnected","not_submitted"].includes(attempt.outcome) &&
    Date.now() - Date.parse(attempt.startedAt) < 86400000;
  const sameRequest = () => hasJob() && Object.entries(draftInput()).every(([k,v]) => attempt.input[k] === v);
  const read = (storage, name) => { try { return JSON.parse(window[storage].getItem(name)); } catch (_) { return null; } };
  const stamp = value => Number.isSafeInteger(value?.updatedAt) && value.updatedAt > 0 ? value.updatedAt : 0;
  const draftInput = () => ({minutes:Number($("#outing-now-minutes").value), setting:$("#outing-now-setting").value,
    note:$("#outing-now-note").value.trim()});
  const conditionsChanged = () => saved?.request && Object.entries(draftInput()).some(([k,v]) => saved.request[k] !== v);
  function endpoint() {
    try { const u = new URL($('meta[name="news-refresh-endpoint"]').content); u.pathname = "/api/outings/now"; return u.href; } catch (_) { return ""; }
  }
  function draw() {
    if (!saved) return;
    results.hidden = false;
    const age = Date.now() - Date.parse(saved.generatedAt);
    const weather = saved.weather;
    const legacy = saved.contextVersion !== 3;
    results.innerHTML = `${legacy ? '<details class="tonight-details"><summary>查看上次建议（按旧规则生成，建议重新获取）</summary>' : ""}<p class="trip-note">${esc(time(saved.generatedAt))} 生成（北京时间）${age > 30 * 60000 ? " · 上次建议，时间和天气可能已变化" : ""}</p>
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
      <p class="trip-note outing-now-weather">${weather ? `天气参考：${esc(weather.area)}，${esc(weather.temperature)}°C，未来这段时间降雨概率最高 ${esc(weather.rainProbability)}%。<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> ${esc(time(weather.observedAt))}` : "本次未取得可用的实时天气，按在家或室内安排。"}</p>${legacy ? "</details>" : ""}`;
  }
  // One bounded snapshot survives a closed tab/PWA, not just a same-tab reload.
  // Keep the last answer with its timestamp instead of silently dropping it the next day.
  const previous = [read("localStorage", key), read("sessionStorage", key)].filter(p => p?.schema === 2)
    .sort((a, b) => stamp(b) - stamp(a))[0];
  writtenAt = stamp(previous);
  const answer = previous ? previous.result : read("sessionStorage", "news-outing-now-v1");
  const draft = previous ? previous.draft : read("sessionStorage", "news-outing-now-draft-v1");
  if (valid(answer)) saved = answer;
  if (validAttempt(previous?.attempt)) attempt = previous.attempt;
  if (new Date(Date.now() + 8 * 3600000).getUTCHours() >= 21) $("#outing-now-minutes").value = "30";
  if (validDraft(draft)) {
    $("#outing-now-minutes").value = draft.minutes;
    $("#outing-now-setting").value = draft.setting;
    $("#outing-now-note").value = draft.note;
  }
  panel.open = previous ? previous.open === true : !!(saved || validDraft(draft));
  function persist() {
    writtenAt = Math.max(Date.now(), writtenAt + 1);
    const snapshot = JSON.stringify({schema:2, updatedAt:writtenAt, result:saved, attempt, open:panel.open,
      draft:{minutes:$("#outing-now-minutes").value, setting:$("#outing-now-setting").value, note:$("#outing-now-note").value}});
    try { localStorage.setItem(key, snapshot); durable = true; } catch (_) { durable = false; }
    // A fallback still allows same-tab recovery when durable storage is unavailable.
    try { sessionStorage.setItem(key, snapshot); } catch (_) {}
  }
  function showState() {
    const outcome = attempt?.outcome;
    summary.textContent = active ? "正在获取" : conditionsChanged() ? "条件已更改" : recoverable() ? "可继续获取" : outcome === "cancelled" ? "已取消" :
      outcome && outcome !== "ok" ? "上次未完成" : saved ? "已有建议" : "即时建议";
    if (active) return;
    const messages = {
      pending:`上次（${time(attempt?.startedAt)}）还没收到建议，输入已恢复。点击“重新获取”再试一次。`,
      ok:"按这次条件整理好了。想换方向，可以补充一句再试。",
      cancelled:"已取消等待，输入已保留。",
      timeout:"这次生成未能在限定时间内完成，输入已保留，可以重新获取。",
      busy:"上次请求繁忙，没能取得建议，稍等半分钟再试。",
      unavailable:"这次没能取得建议，输入已保留，请重试。",
      paused:"已暂停等待，任务会在后台继续。点击“查看结果”可接着获取，无需重新生成。",
      disconnected:"暂时连不上服务，任务可能仍在进行。点击“查看结果”可找回原请求，联网或重新打开后也会继续查询。",
      not_submitted:"还未确认服务收到请求，输入已保留。点击“继续获取”会重试同一请求。"
    };
    let message = messages[outcome] || (saved ? "已恢复上次建议，生成时间见下方。" : hint);
    if (conditionsChanged() && (!outcome || outcome === "ok")) message = "条件已更改，下方仍是上次建议。点击“按新条件获取”后才会重新生成。";
    if (outcome && outcome !== "ok" && saved) message += "下方仍是上次结果。";
    if (!navigator.onLine) message = "即时建议需要联网。" + (saved ? "下方保留上次结果。" : "输入已保留，联网后可重试。") +
      (outcome === "pending" ? "上次请求尚未收到结果。" : "");
    if (!durable) message += "当前浏览器无法保存到本机，关闭页面后可能丢失。";
    status.textContent = message;
    submit.textContent = recoverable() && sameRequest() ? outcome === "not_submitted" ? "继续获取" : "查看结果" :
      outcome && outcome !== "ok" ? "重新获取" : conditionsChanged() ? "按新条件获取" : saved ? "换几个建议" : "给我建议";
  }
  if (previous || saved || validDraft(draft)) persist();
  const saveDraft = () => { persist(); showState(); };
  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  draw();
  showState();
  window.addEventListener("offline", () => { if (active) active.stop("disconnected"); else showState(); });
  window.addEventListener("online", () => { showState(); resume(); });
  // The details "toggle" event is queued and may not run before a tab closes.
  // Save the actual attribute change in the current task's microtask checkpoint.
  new MutationObserver(persist).observe(panel, {attributes:true, attributeFilter:["open"]});
  panel.addEventListener("toggle", () => { if (panel.open && !active) draw(); showState(); });
  // A second tab can recover an answer completed by the original tab without
  // another model call. Never replace a different request or an edited draft.
  window.addEventListener("storage", event => {
    if (event.key !== key || active || attempt?.outcome !== "pending") return;
    let next;
    try { next = JSON.parse(event.newValue); } catch (_) { return; }
    if (next?.schema !== 2 || !validAttempt(next.attempt) || next.attempt.id !== attempt.id || next.attempt.outcome === "pending") return;
    if (next.attempt.outcome === "ok" && !valid(next.result)) return;
    attempt = next.attempt;
    if (valid(next.result)) saved = next.result;
    writtenAt = Math.max(writtenAt, stamp(next));
    persist();
    draw(); showState();
  });
  cancel.textContent = "暂停等待";
  cancel.addEventListener("click", () => active?.stop("paused"));
  const resume = () => {
    if (active && Date.now() >= active.deadline) active.stop("paused");
    else if (!active && recoverable() && navigator.onLine) followJob(false);
  };
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  async function fetchJob(run, method) {
    const controller = new AbortController(); run.controller = controller;
    let timer;
    try {
      return await Promise.race([run.stopped, new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error("connection")); controller.abort(); }, requestLimit);
      }), (async () => {
        const response = await fetch(endpoint() + "/jobs/" + attempt.jobId, {method, cache:"no-store", signal:controller.signal,
          ...(method === "POST" ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(attempt.input)} : {})});
        if (response.status === 404) return {status:"not_found"};
        if (response.status === 410) return {status:"expired"};
        if (response.status === 429) { if (method === "POST") throw new Error("busy"); throw new Error("connection"); }
        if (!response.ok) throw new Error("connection");
        return await response.json();
      })()]);
    } finally { clearTimeout(timer); }
  }
  async function followJob(create) {
    if (active || !hasJob()) return;
    const run = {deadline:Date.now() + waitLimit};
    run.stopped = new Promise((_, reject) => { run.stop = reason => {
      run.reason = reason; reject(new Error(reason)); run.controller?.abort();
    }; });
    active = run;
    attempt.outcome = "pending";
    persist(); showState();
    submit.disabled = true; submit.textContent = "正在获取…"; cancel.hidden = false; results.setAttribute("aria-busy", "true");
    status.textContent = create ? "正在提交你的条件…" : "正在找回上次请求的结果…";
    const timer = setTimeout(() => run.stop("paused"), waitLimit);
    try {
      let data = null, failures = 0;
      if (create) {
        try { data = await fetchJob(run, "POST"); }
        catch (error) {
          if (["paused","busy","disconnected"].includes(error.message)) throw error;
          status.textContent = "提交连接中断，正在确认原请求是否已收到…";
        }
      }
      while (true) {
        if (run.reason) throw new Error(run.reason);
        if (!data) {
          try { data = await fetchJob(run, "GET"); failures = 0; }
          catch (error) {
            if (["paused","disconnected"].includes(error.message)) throw error;
            if (++failures >= 3) throw new Error("disconnected");
            status.textContent = "连接暂时中断，正在找回同一请求，不会重复生成…";
          }
        }
        if (data) {
          if (run.reason) throw new Error(run.reason);
          if (data.status === "ok") {
            if (!valid(data.result)) throw new Error("unavailable");
            const {minutes, setting, note} = attempt.input;
            saved = {...data.result, request:{minutes,setting,note}};
            attempt.outcome = "ok"; draw(); break;
          }
          if (data.status === "not_found") throw new Error("not_submitted");
          if (data.status === "expired") throw new Error("timeout");
          if (!["queued","running"].includes(data.status)) throw new Error(["timeout","busy"].includes(data.status) ? data.status : "unavailable");
          attempt.accepted = true; persist();
          if (Number.isFinite(data.deadline) && Date.now() > data.deadline + 5000) throw new Error("timeout");
          const stages = {preparing:"正在核对当前时间、天气和偏好",generating:"正在生成建议",checking:"正在核对建议",correcting:"正在调整不合适的建议"};
          status.textContent = (stages[data.stage] || "正在生成建议") + "。已提交，可以离开页面，回来会接着获取结果。";
        }
        data = null;
        await Promise.race([run.stopped, new Promise(resolve => { run.poll = setTimeout(resolve, 2500); })]);
      }
    } catch (error) {
      attempt.outcome = ["paused","disconnected","not_submitted","timeout","busy"].includes(error.message) ? error.message : "unavailable";
      run.controller?.abort();
    } finally {
      clearTimeout(timer); clearTimeout(run.poll); active = null; submit.disabled = false; cancel.hidden = true;
      results.removeAttribute("aria-busy");
      persist(); showState();
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (active) return;
    if (!navigator.onLine) { showState(); return; }
    if (!endpoint()) { status.textContent = "暂时无法连接，请稍后再试。"; return; }
    if (recoverable() && sameRequest()) { followJob(attempt.outcome === "not_submitted"); return; }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,"0")).join("");
    attempt = {id,jobId:id,startedAt:new Date().toISOString(),outcome:"pending",input:{...draftInput(),
      previous:saved && Date.now() - Date.parse(saved.generatedAt) < 24 * 3600000 ? saved.ideas.map(p => p.title.slice(0,120)) : []}};
    // Save the ID before submission, including when its acknowledgement is lost.
    persist(); followJob(true);
  });
  if (recoverable() && navigator.onLine) followJob(false);
  results.addEventListener("click", event => {
    const button = event.target.closest("[data-now-save]");
    const item = button && saved?.ideas[Number(button.dataset.nowSave)];
    if (!item) return;
    window.OutingProfile.mark({id:item.id, name:item.title, area:item.area, url:item.sources.find(s => safe(s.url))?.url}, "want");
    button.textContent = "已记下"; button.disabled = true;
  });
})();
