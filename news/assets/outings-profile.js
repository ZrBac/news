(function () {
  "use strict";
  const key = "news-outing-profile-v1";
  const empty = () => ({ schema: 1, settings: {}, records: [], pending: [] });
  const endpoint = () => document.querySelector('meta[name="news-refresh-endpoint"]')?.content || "";
  let state, syncing = false, checkedAt = 0, message = "";
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
    if (op.action === "settings") profile.settings = { startArea: op.startArea, people: op.people, transport: op.transport };
    else {
      profile.records = profile.records.filter(r => r.id !== op.id);
      if (op.action === "record") profile.records.unshift({ id: op.id, title: op.title, status: op.status, updatedAt: new Date().toISOString() });
      profile.records = profile.records.slice(0, 300);
    }
  }
  async function request(op, path = "/api/outings/profile", version) {
    if (!endpoint()) throw new Error("unavailable");
    const url = new URL(path, endpoint()), controller = new AbortController();
    if (Number.isSafeInteger(version) && version >= 0) url.searchParams.set("version", version);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { method: op ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        ...(op ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) } : {}) });
      if (!response.ok) throw new Error(({429:"busy",409:"journal_full"})[response.status] || "unavailable");
      const result = await response.json();
      if (path === "/api/outings/profile" && (result.schema !== 1 || !Array.isArray(result.records))) throw new Error("unavailable");
      return result;
    } finally { clearTimeout(timer); }
  }
  async function sync(force) {
    if (!endpoint() || syncing || !navigator.onLine || (!force && Date.now() - checkedAt < 30000)) return;
    window.TonightJournal?.sync(force);
    syncing = true; checkedAt = Date.now();
    try {
      let remote = await request();
      while (state.pending.length) {
        const op = state.pending[0];
        remote = await request(op);
        // A second tap can replace this operation while the request is in flight.
        // Remove only the operation that actually reached the server.
        state.pending = state.pending.filter(p => JSON.stringify(p) !== JSON.stringify(op));
        try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
      }
      state = { ...remote, pending: [] };
      message = "已自动同步，两台设备共用这些偏好和反馈。";
    } catch (_) {
      message = "已保存在本机，暂未同步成功，联网后自动重试。";
    } finally { syncing = false; checkedAt = Date.now(); changed(); }
  }
  function update(op) {
    apply(state, op);
    state.pending = state.pending.filter(p => op.action === "settings" ? p.action !== "settings" : p.id !== op.id);
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
    mark: (p, status) => update({ action: "record", id: p.id, title: p.name, status }),
  };
  window.addEventListener("online", () => sync(true));
  window.addEventListener("hashchange", clearLegacyEntry);
  const visible = () => !document.hidden && !document.activeElement?.closest("form") && /^#(?:local|tonight)(?:$|[&?])/.test(location.hash);
  document.addEventListener("visibilitychange", () => { if (visible()) sync(true); });
  setInterval(() => { if (visible()) sync(false); }, 30000);
  window.addEventListener("storage", event => {
    if (event.key === key) {
      try { const incoming = JSON.parse(event.newValue); if (incoming?.records && incoming?.pending) state = incoming; } catch (_) {}
      window.dispatchEvent(new Event("outing-feedback-change"));
    }
  });
})();
