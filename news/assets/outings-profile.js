(function () {
  "use strict";
  const key = "news-outing-profile-v1";
  const empty = () => ({ schema: 1, settings: {}, records: [], pending: [] });
  const endpoint = () => document.querySelector('meta[name="news-refresh-endpoint"]')?.content || "";
  let state, syncJob = null, checkedAt = 0, message = "", retryTimer = null, failures = 0;
  const requests = new Set();
  try { state = JSON.parse(localStorage.getItem(key)); } catch (_) {}
  try { localStorage.removeItem("news-outing-connection-v1"); } catch (_) {}
  if (!state || !Array.isArray(state.records) || !Array.isArray(state.pending)) state = empty();
  function clearLegacyEntry() {
    if (!/[&?]outing-key=/.test(location.hash)) return;
    const view = /^#tonight(?:[&?]|$)/.test(location.hash) ? "#tonight" : "#local";
    history.replaceState(null, "", location.pathname + location.search + view);
  }
  clearLegacyEntry();
  function changed() {
    try { localStorage.setItem(key, JSON.stringify(state)); }
    catch (_) { message = "浏览器未允许保存，请保持页面打开。"; }
    window.dispatchEvent(new Event("outing-feedback-change"));
  }
  function apply(profile, op) {
    if (op.action === "settings") profile.settings = { ...profile.settings, startArea: op.startArea, people: op.people, transport: op.transport };
    else if (op.action === "suggestion") profile.settings = {...profile.settings, weekendNote:op.text, weekendNoteUpdatedAt:new Date().toISOString()};
    else {
      profile.records = profile.records.filter(r => r.id !== op.id);
      if (op.action === "record") profile.records.unshift({ id: op.id, title: op.title, status: op.status, ...(op.url?{url:op.url}:{}), ...(op.area?{area:op.area}:{}), ...(op.day?{day:op.day}:{}), updatedAt: new Date().toISOString() });
      profile.records = profile.records.slice(0, 300);
    }
  }
  async function request(op, path = "/api/outings/profile", version, timeout = 15000) {
    if (!endpoint()) throw new Error("unavailable");
    const url = new URL(path, endpoint()), controller = new AbortController();
    if (Number.isSafeInteger(version) && version >= 0) url.searchParams.set("version", version);
    const deadline = Date.now() + timeout;
    let expire;
    // Abort alone cannot settle a stalled connection or response body on every
    // mobile browser. Reject independently and never merge a late response.
    const stopped = new Promise((_, reject) => { expire = () => {
      reject(new Error("timeout")); controller.abort();
    }; });
    const resume = () => { if (Date.now() >= deadline) expire(); };
    requests.add(resume);
    const timer = setTimeout(expire, timeout);
    try {
      const result = await Promise.race([stopped, (async () => {
        const response = await fetch(url.href, { method: op ? "POST" : "GET", cache: "no-store", signal: controller.signal,
          ...(op ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) } : {}) });
        if (!response.ok) throw new Error(({400:"invalid_record",413:"invalid_record",401:"forbidden",403:"forbidden",429:"busy",409:"journal_full"})[response.status] || "unavailable");
        const value = await response.json();
        if (path === "/api/outings/profile" && (value.schema !== 1 || !Array.isArray(value.records))) throw new Error("unavailable");
        return value;
      })()]);
      if (Date.now() >= deadline) throw new Error("timeout");
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("timeout");
      if (error instanceof TypeError) throw new Error("network");
      throw error;
    } finally { clearTimeout(timer); requests.delete(resume); controller.abort(); }
  }
  const transient = error => ["network", "timeout", "unavailable"].includes(error.message);
  function outgoing(op) {
    if (!["record", "remove"].includes(op?.action)) return op;
    const value = {...op};
    // Older clients did not bound display metadata and could produce upper-case
    // story IDs. Keep the actual feedback, and send the current wire format.
    if (/^(place|event):[a-z0-9-]{1,100}$/i.test(value.id)) value.id = value.id.toLowerCase();
    if (value.action === "record") {
      if (typeof value.title === "string") value.title = value.title.trim().slice(0,150);
      for (const field of ["area", "day"]) {
        if (typeof value[field] === "string") value[field] = value[field].slice(0,120);
        else delete value[field];
      }
      try {
        const url = new URL(value.url);
        if (url.protocol !== "https:" || url.username || url.password || url.href.length > 1500) throw new Error();
        value.url = url.href;
      } catch (_) { delete value.url; }
    }
    return value;
  }
  async function profileRequest(op, deadline) {
    const value = outgoing(op);
    const send = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timeout");
      return request(value, undefined, undefined, Math.min(15000, remaining));
    };
    try { return await send(); }
    catch (error) {
      if (!transient(error) || !navigator.onLine || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(800, deadline - Date.now())));
      return send();
    }
  }
  function merge(remote) {
    // Keep unsent edits over the shared copy, including a record rejected by the
    // server. A failed older operation must neither erase data nor block later ones.
    state = {...remote, pending:state.pending};
    for (const op of state.pending) apply(state, op);
  }
  const onOutings = () => !document.hidden && /^#(?:local|tonight)(?:$|[&?])/.test(location.hash);
  function retryLater(error) {
    clearTimeout(retryTimer);
    if (!state.pending.length || !navigator.onLine || !onOutings() ||
        error && !transient(error) && error.message !== "busy") return;
    const delay = error?.message === "busy" ? 60000 : Math.min(60000, 5000 * Math.pow(2, failures++));
    retryTimer = setTimeout(() => { if (onOutings()) sync(true); }, delay);
  }
  function sync(force) {
    if (syncJob) return syncJob;
    if (!endpoint() || !navigator.onLine || (!force && Date.now() - checkedAt < 30000)) return Promise.resolve();
    window.TonightJournal?.sync(force);
    clearTimeout(retryTimer);
    checkedAt = Date.now();
    const deadline = Date.now() + 30000;
    syncJob = (async () => {
      let remote, problem;
      const rejected = new Set();
      try {
        // Upload first: the POST also returns the shared copy. A separate GET
        // must not prevent saving, or spend another request for each retry.
        for (let sent = 0; sent < 20; sent++) {
          const op = state.pending.find(p => !rejected.has(JSON.stringify(p)));
          if (!op) break;
          try { remote = await profileRequest(op, deadline); }
          catch (error) {
            if (error.message !== "invalid_record") throw error;
            rejected.add(JSON.stringify(op));
            continue;
          }
          // A second tap can replace this operation while the request is in flight.
          // Remove only the operation that actually reached the server.
          state.pending = state.pending.filter(p => JSON.stringify(p) !== JSON.stringify(op));
          merge(remote);
          try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
        }
        if (!remote) remote = await profileRequest(undefined, deadline);
        merge(remote);
        if (state.pending.some(p => rejected.has(JSON.stringify(p)))) problem = new Error("invalid_record");
        message = !state.pending.length ? "已自动同步，两台设备共用这些偏好和反馈。" :
          problem ? "有记录格式不兼容，仍保存在本机；其他内容已同步。请检查偏好填写，或在“我们的记录”里重新标记对应反馈。" :
          "部分内容已同步，剩余内容会自动补传。";
        if (!state.pending.length) failures = 0;
      } catch (error) {
        problem = error;
        const reason = {network:"暂时连不上同步服务",timeout:"同步连接超时",busy:"同步请求较多",forbidden:"当前入口未获同步服务允许"}[error.message] || "同步服务暂时不可用";
        message = `${reason}，内容已保存在本机。${error.message === "forbidden" ? "请从网站的正式入口打开。" : "稍后会自动重试。"}`;
      } finally { checkedAt = Date.now(); changed(); retryLater(problem); }
    })().finally(() => { syncJob = null; });
    return syncJob;
  }
  function update(op) {
    apply(state, op);
    state.pending = state.pending.filter(p => ["settings", "suggestion"].includes(op.action) ? p.action !== op.action : p.id !== op.id);
    state.pending.push(op);
    message = navigator.onLine ? "已保存，正在同步。" : "已保存在本机，联网后自动同步。";
    changed(); sync(true);
  }
  window.OutingProfile = {
    snapshot: () => state,
    status: () => message || "打开后自动同步，离线时先保存在本机。",
    connected: () => !!endpoint(), update, sync,
    journalRequest: (op, version) => request(op, "/api/outings/journal", version),
    excludes: p => state.records.some(r => ["visited", "dismiss"].includes(r.status) && r.id === p.id),
    mark: (p, status) => {
      const url = window.OutingLibrary?.safe(p.url || p.bookingUrl || p.sources?.[0]?.url);
      update({action:"record", id:p.id, title:p.name.slice(0,150), status,
        ...(url && url.length <= 1500 ? {url} : {}), ...(p.area ? {area:p.area.slice(0,120)} : {}), ...(p.day ? {day:p.day.slice(0,120)} : {})});
    },
  };
  window.addEventListener("online", () => sync(true));
  window.addEventListener("hashchange", clearLegacyEntry);
  // An unfinished draft can pause background reads, but must not stop queued
  // writes after the user has already pressed Save.
  const visible = () => onOutings() && (state.pending.length || !document.activeElement?.closest("form"));
  const resume = () => { for (const check of requests) check(); if (visible()) sync(true); };
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  setInterval(() => { if (visible()) sync(false); }, 30000);
  window.addEventListener("storage", event => {
    if (event.key === key) {
      try { const incoming = JSON.parse(event.newValue); if (incoming?.records && incoming?.pending) state = incoming; } catch (_) {}
      window.dispatchEvent(new Event("outing-feedback-change"));
    }
  });
})();
