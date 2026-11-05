/* Private evening notes stay on this device; no network or shared-profile writes. */
(function () {
  "use strict";
  const key = "news-tonight-journal-v1", limit = 2000;
  let cached = [], problem = "";
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
    if (raw === null) return [];
    try {
      const value = JSON.parse(raw);
      if (value.schema !== 1) throw new Error();
      return clean(value.records);
    } catch (_) { throw new Error("本机记录暂时无法读取，未覆盖原数据。请先保留浏览器数据。"); }
  }
  function snapshot() {
    try { cached = read(); problem = ""; }
    catch (error) { problem = error.message; }
    return cached.map(r => ({...r}));
  }
  function write(records) {
    const next = clean(records);
    try { localStorage.setItem(key, JSON.stringify({schema:1, records:next})); }
    catch (_) { throw new Error("未能保存，可能是浏览器存储已满或受限。文字仍在输入框，请先复制保存。"); }
    cached = next; problem = "";
  }
  function add(pick, note, next) {
    const records = read();
    if (records.length >= limit) throw new Error("已有 2000 条记录，请先导出备份，再整理旧记录；原记录不会自动删除。");
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const record = {id:"evening-" + Array.from(bytes, n => n.toString(16).padStart(2,"0")).join(""),
      activityId:pick.id, title:pick.name, createdAt:new Date(Date.now()).toISOString(),
      note:note.trim(), next:next.trim()};
    write([record, ...records]);
    return record;
  }
  function remove(id) {
    const records = read(), record = records.find(r => r.id === id);
    write(records.filter(r => r.id !== id));
    return record;
  }
  function restore(value) {
    if (!value || value.app !== "zacai-tonight-journal" || value.schema !== 1)
      throw new Error("请选择本站导出的今晚记录文件，原有记录已保留。");
    const incoming = clean(value.records), records = read(), known = new Set(records.map(r => r.id));
    const extra = incoming.filter(r => !known.has(r.id));
    if (records.length + extra.length > limit) throw new Error("合并后超过 2000 条，未改动原有记录。请先整理旧记录。");
    write([...records, ...extra]);
    return extra.length;
  }
  function backup() {
    return {app:"zacai-tonight-journal", schema:1, exportedAt:new Date(Date.now()).toISOString(), records:read()};
  }
  window.TonightJournal = {key, snapshot, status:() => problem, add, remove, restore, backup};
})();
