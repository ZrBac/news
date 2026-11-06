/* Offline-first evening notes. Authenticated sync is separate from AI preferences. */
(function () {
  "use strict";
  const key = "news-tonight-journal-v1", limit = 2000;
  let cached = [], problem = "", message = "", syncing = false, checkedAt = 0;
  const empty = () => ({schema:1, records:[], pending:[], version:null});
  function identifier(prefix) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, n => n.toString(16).padStart(2,"0")).join("");
  }
  const operation = record => ({id:identifier("op-"), action:"put", record});
  const text = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.length <= max;
  function valid(r) {
    return r && /^evening-[a-f0-9]{24}$/.test(r.id) &&
      /^event:tonight-[a-z0-9-]{1,70}$/.test(r.activityId) && text(r.title, 1, 80) &&
      typeof r.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.createdAt) &&
      Number.isFinite(Date.parse(r.createdAt)) && text(r.note, 1, 500) && text(r.next, 0, 200);
  }
  function clean(records) {
    if (!Array.isArray(records) || records.length > limit || !records.every(valid) ||
        new Set(records.map(r => r.id)).size !== records.length)
      throw new Error("记录格式不正确，原有记录已保留。");
    return records.map(r => ({id:r.id, activityId:r.activityId, title:r.title,
      createdAt:r.createdAt, note:r.note, next:r.next}))
      .sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  function read() {
    let raw;
    try { raw = localStorage.getItem(key); }
    catch (_) { throw new Error("浏览器暂时无法读取本机记录，请检查存储设置。"); }
    if (raw === null) return empty();
    try {
      const value = JSON.parse(raw);
      if (value.schema !== 1) throw new Error();
      const records = clean(value.records);
      // An older, local-only journal is uploaded once, preserving all IDs.
      const pending = value.pending === undefined ? records.map(operation) : value.pending;
      if (!Array.isArray(pending) || !pending.every(op => op && /^op-[a-f0-9]{24}$/.test(op.id) &&
          (op.action === "put" ? valid(op.record) : op.action === "remove" && /^evening-[a-f0-9]{24}$/.test(op.recordId)))) throw new Error();
      return {schema:1, records, pending, version:Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : null};
    } catch (_) { throw new Error("本机记录暂时无法读取，未覆盖原数据。请先保留浏览器数据。"); }
  }
  function snapshot() {
    try { cached = read().records; problem = ""; }
    catch (error) { problem = error.message; }
    return cached.map(r => ({...r}));
  }
  function write(state) {
    const next = clean(state.records);
    try { localStorage.setItem(key, JSON.stringify({...state, records:next})); }
    catch (_) { throw new Error("未能保存，可能是浏览器存储已满或受限。文字仍在输入框，请先复制保存。"); }
    cached = next; problem = "";
  }
  function add(pick, note, next) {
    const state = read();
    if (state.records.length >= limit) throw new Error("已有 2000 条记录，请先导出备份，再整理旧记录；原记录不会自动删除。");
    const record = {id:identifier("evening-"),
      activityId:pick.id, title:pick.name, createdAt:new Date(Date.now()).toISOString(),
      note:note.trim(), next:next.trim()};
    write({...state, records:[record, ...state.records], pending:[...state.pending, operation(record)]});
    schedule();
    return record;
  }
  function remove(id) {
    const state = read(), record = state.records.find(r => r.id === id);
    if (!record) return;
    write({...state, records:state.records.filter(r => r.id !== id),
      pending:[...state.pending, {id:identifier("op-"), action:"remove", recordId:id}]});
    schedule();
    return record;
  }
  function restore(value) {
    if (!value || value.app !== "zacai-tonight-journal" || value.schema !== 1)
      throw new Error("请选择本站导出的今晚记录文件，原有记录已保留。");
    const incoming = clean(value.records), state = read(), records = state.records, known = new Set(records.map(r => r.id));
    const extra = incoming.filter(r => !known.has(r.id));
    if (records.length + extra.length > limit) throw new Error("合并后超过 2000 条，未改动原有记录。请先整理旧记录。");
    write({...state, records:[...records, ...extra], pending:[...state.pending, ...extra.map(operation)]});
    schedule();
    return extra.length;
  }
  function backup() {
    return {app:"zacai-tonight-journal", schema:1, exportedAt:new Date(Date.now()).toISOString(), records:read().records};
  }
  function schedule() {
    message = window.OutingProfile?.connected() ? "已保存，正在自动同步。" : "已保存在本机；在“偏好与反馈”连接后自动同步。";
    if (window.OutingProfile?.connected()) setTimeout(() => sync(true), 0);
  }
  function overlay(records, pending) {
    const merged = new Map(records.map(r => [r.id, r]));
    for (const op of pending) {
      if (op.action === "remove") merged.delete(op.recordId);
      else if (!merged.has(op.record.id)) merged.set(op.record.id, op.record);
    }
    return clean([...merged.values()]);
  }
  async function sync(force) {
    if (!window.OutingProfile?.connected() || syncing || !navigator.onLine || (!force && Date.now() - checkedAt < 30000)) return;
    syncing = true; checkedAt = Date.now();
    try {
      let state = read();
      write(state); // Persist any migration before the first network request.
      // Bound each pass so large imports resume without a request storm.
      for (let batch = 0; state.pending.length && batch < 6; batch++) {
        const sent = state.pending.slice(0,10);
        const result = await window.OutingProfile.journalRequest({schema:1, operations:sent});
        if (result.schema !== 1 || !Array.isArray(result.acknowledged) ||
            !sent.every(op => result.acknowledged.includes(op.id))) throw new Error("unavailable");
        const acknowledged = new Set(sent.map(op => op.id));
        state = read();
        state.pending = state.pending.filter(op => !acknowledged.has(op.id));
        write(state);
      }
      const remote = await window.OutingProfile.journalRequest(undefined, state.version);
      if (remote.schema !== 1 || !Number.isSafeInteger(remote.version) || remote.version < 0) throw new Error("unavailable");
      state = read(); // Preserve any edits made while the download was in flight.
      if (Number.isSafeInteger(state.version) && remote.version < state.version) return;
      if (remote.unchanged !== true) state.records = overlay(clean(remote.records), state.pending);
      else if (state.version !== remote.version) throw new Error("unavailable");
      state.version = remote.version;
      write(state);
      message = state.pending.length ? "部分记录已同步，其余会自动补传。" : "积累已自动同步，两台设备都能接着看。";
    } catch (error) {
      message = error.message === "unauthorized" ? "连接已失效，请在“偏好与反馈”重新连接。" :
        error.message === "journal_full" ? "共同记录已满，本机内容已保留。请先备份、整理旧记录。" :
        "本机记录已保留，暂未同步成功，联网后自动重试。";
    } finally {
      syncing = false; checkedAt = Date.now();
      window.dispatchEvent(new Event("tonight-journal-change"));
    }
  }
  window.TonightJournal = {key, snapshot, status:() => problem || message, add, remove, restore, backup, sync};
})();
