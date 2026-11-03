(function () {
  "use strict";
  const key = "news-outing-profile-v1", tokenKey = "news-outing-connection-v1";
  const empty = () => ({ schema: 1, settings: {}, records: [], pending: [] });
  let state, token = "", syncing = false, checkedAt = 0, message = "";
  try { state = JSON.parse(localStorage.getItem(key)); token = localStorage.getItem(tokenKey) || ""; } catch (_) {}
  if (!state || !Array.isArray(state.records) || !Array.isArray(state.pending)) state = empty();
  const incoming = location.hash.match(/(?:&|\?)outing-key=([A-Za-z0-9_-]{32,100})/);
  if (incoming) {
    token = incoming[1];
    try { localStorage.setItem(tokenKey, token); } catch (_) {}
    history.replaceState(null, "", location.pathname + location.search + "#local");
  }
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
  async function request(op) {
    const endpoint = document.querySelector('meta[name="news-refresh-endpoint"]')?.content;
    if (!endpoint) throw new Error("unavailable");
    const url = new URL("/api/outings/profile", endpoint), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url.href, { method: op ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, ...(op ? { "Content-Type": "application/json" } : {}) },
        ...(op ? { body: JSON.stringify(op) } : {}) });
      if (!response.ok) throw new Error(response.status === 401 ? "unauthorized" : "unavailable");
      const result = await response.json();
      if (result.schema !== 1 || !Array.isArray(result.records)) throw new Error("unavailable");
      return result;
    } finally { clearTimeout(timer); }
  }
  async function sync(force) {
    if (!token || syncing || !navigator.onLine || (!force && Date.now() - checkedAt < 60000)) return;
    syncing = true; checkedAt = Date.now();
    try {
      let remote = await request();
      while (state.pending.length) {
        const op = state.pending[0];
        remote = await request(op);
        // A second tap can replace this operation while the request is in flight.
        // Remove only the operation that actually reached the server.
        state.pending = state.pending.filter(p => p !== op);
        try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
      }
      state = { ...remote, pending: [] };
      message = "共同记录已同步，下次整理会参考这些反馈。";
    } catch (error) {
      message = error.message === "unauthorized" ? "连接码无效，请重新连接。" : "已保存在本机，联网后重试同步。";
    } finally { syncing = false; changed(); }
  }
  function update(op) {
    apply(state, op);
    state.pending = state.pending.filter(p => op.action === "settings" ? p.action !== "settings" : p.id !== op.id);
    state.pending.push(op);
    message = token ? "已保存，正在同步。" : "已保存在本机；连接共同记录后可用于下一轮推荐。";
    changed(); sync(true);
  }
  function connect(value) {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(value)) { message = "请使用专属连接链接或完整连接码。"; changed(); return; }
    token = value;
    try { localStorage.setItem(tokenKey, token); } catch (_) {}
    sync(true);
  }
  window.OutingProfile = {
    snapshot: () => state,
    status: () => message || (token ? "共同记录已连接" : "记录保存在当前设备"),
    connected: () => !!token, update, connect, sync,
    excludes: p => state.records.some(r => ["visited", "dismiss"].includes(r.status) && r.id === p.id),
    mark: (p, status) => update({ action: "record", id: p.id, title: p.name, status }),
  };
  window.addEventListener("online", () => sync(true));
})();
