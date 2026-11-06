(function () {
  "use strict";
  const key = "news-outing-profile-v1", tokenKey = "news-outing-connection-v1";
  const empty = () => ({ schema: 1, settings: {}, records: [], pending: [] });
  let state, token = "", syncing = false, checkedAt = 0, message = "", connecting = false, unauthorized = false;
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
  async function request(op, path = "/api/outings/profile", version) {
    const endpoint = document.querySelector('meta[name="news-refresh-endpoint"]')?.content;
    if (!endpoint) throw new Error("unavailable");
    const url = new URL(path, endpoint), controller = new AbortController();
    if (Number.isSafeInteger(version) && version >= 0) url.searchParams.set("version", version);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { method: op ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        headers: { ...(path.endsWith("/connect") ? {} : {Authorization:"Bearer " + token}), ...(op ? { "Content-Type": "application/json" } : {}) },
        ...(op ? { body: JSON.stringify(op) } : {}) });
      if (!response.ok) throw new Error(({401:"unauthorized",429:"busy",409:"journal_full"})[response.status] || "unavailable");
      const result = await response.json();
      if (path === "/api/outings/profile" && (result.schema !== 1 || !Array.isArray(result.records))) throw new Error("unavailable");
      return result;
    } finally { clearTimeout(timer); }
  }
  async function sync(force) {
    if (!token || unauthorized || syncing || !navigator.onLine || (!force && Date.now() - checkedAt < 30000)) return;
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
    } catch (error) {
      if (error.message === "unauthorized") unauthorized = true;
      message = unauthorized ? "连接已失效，请重新输入六位连接码。" : "已保存在本机，联网后自动补传。";
    } finally { syncing = false; checkedAt = Date.now(); changed(); }
  }
  function update(op) {
    apply(state, op);
    state.pending = state.pending.filter(p => op.action === "settings" ? p.action !== "settings" : p.id !== op.id);
    state.pending.push(op);
    message = token ? "已保存，正在同步。" : "已保存在本机；连接共同记录后可用于下一轮推荐。";
    changed(); sync(true);
  }
  async function connect(value) {
    if (connecting) return;
    if (!/^\d{6}$/.test(value) && !/^[A-Za-z0-9_-]{32,100}$/.test(value)) { message = "请输入六位连接码。"; changed(); return; }
    connecting = true; message = "正在连接…"; changed();
    try {
      const credential = /^\d{6}$/.test(value) ? (await request({code:value}, "/api/outings/connect")).token : value;
      if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{32,100}$/.test(credential)) throw new Error("unavailable");
      // Never persist the short pairing code. Old private links remain valid.
      localStorage.setItem(tokenKey, credential);
      token = credential; unauthorized = false; checkedAt = 0;
      await sync(true);
    } catch (error) {
      message = error.message === "unauthorized" ? "连接码不正确，请重新输入。" : error.message === "busy" ?
        "尝试次数较多，请15分钟后再连接。" : "暂时未能连接，请检查网络及浏览器存储后重试。";
      changed();
    } finally { connecting = false; }
  }
  window.OutingProfile = {
    snapshot: () => state,
    status: () => message || (token ? "自动同步已开启" : "首次输入六位码，之后自动同步"),
    connected: () => !!token && !unauthorized, update, connect, sync,
    journalRequest: (op, version) => request(op, "/api/outings/journal", version),
    excludes: p => state.records.some(r => ["visited", "dismiss"].includes(r.status) && r.id === p.id),
    mark: (p, status) => update({ action: "record", id: p.id, title: p.name, status }),
  };
  window.addEventListener("online", () => sync(true));
  const visible = () => !document.hidden && !document.activeElement?.closest("form") && /^#(?:local|tonight)(?:$|[&?])/.test(location.hash);
  document.addEventListener("visibilitychange", () => { if (visible()) sync(true); });
  setInterval(() => { if (visible()) sync(false); }, 30000);
  window.addEventListener("storage", event => {
    if (event.key === key) {
      try { const incoming = JSON.parse(event.newValue); if (incoming?.records && incoming?.pending) state = incoming; } catch (_) {}
      window.dispatchEvent(new Event("outing-feedback-change"));
    }
    if (event.key === tokenKey) { token = event.newValue || ""; unauthorized = false; sync(true); }
  });
})();
