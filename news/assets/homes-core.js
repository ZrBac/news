/* The private notebook is validated before local saves, imports and cloud sync. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HomeBook = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";
  const SCHEMA = 1;
  const MAX_BACKUP = 60 * 1024 * 1024;
  const statuses = {
    planned: "待看",
    visited: "已看",
    shortlist: "重点考虑",
    rejected: "已排除",
  };
  const kinds = { new: "新房", resale: "二手房" };
  const priceTypes = {
    asking: "挂牌价",
    quoted: "沟通报价",
    contract: "已核实成交价",
  };
  const campuses = { yungu: "云谷园区", xixi: "西溪园区" };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  function id() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function defaults() {
    return {
      schema: SCHEMA,
      revision: 0,
      profile: {
        budgetMin: 300,
        budgetMax: 350,
        areas: "西湖区、上城区、西溪及周边",
        priority: "new",
        driver: "undecided",
        maxDrive: null,
        maxTransit: null,
      },
      homes: [],
    };
  }
  function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("备份中的记录格式不正确。");
    return value;
  }
  function str(value, max = 500) {
    if (value == null) return "";
    if (typeof value !== "string" || value.length > max)
      throw new Error("文字格式不正确或超过长度限制。");
    return value.trim();
  }
  function num(value, max = 100000, min = 0) {
    if (value === "" || value == null) return null;
    if (
      !["number", "string"].includes(typeof value) ||
      !Number.isFinite(Number(value)) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error("金额、面积或通勤时间超出允许范围。");
    return Number(value);
  }
  function choice(value, choices, fallback) {
    if (value == null || value === "") return fallback;
    if (!Object.prototype.hasOwnProperty.call(choices, value))
      throw new Error("备份中有不支持的选项。");
    return value;
  }
  function date(value, required = false) {
    const result = str(value, 10);
    if (
      (!result && required) ||
      (result &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
          !Number.isFinite(Date.parse(result)) ||
          new Date(result).toISOString().slice(0, 10) !== result))
    )
      throw new Error("请填写有效日期。");
    return result;
  }
  function stamp(value) {
    const result = str(value, 30);
    if (!result || !Number.isFinite(Date.parse(result)))
      throw new Error("记录时间无效。");
    return new Date(result).toISOString();
  }
  function key(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
      throw new Error("记录编号无效。");
    return value;
  }
  function list(value, max, normalize) {
    if (!Array.isArray(value) || value.length > max)
      throw new Error("备份记录数量超出限制。");
    const result = value.map(normalize);
    const keys = result.map((item) => item.id);
    if (new Set(keys).size !== keys.length)
      throw new Error("备份包含重复记录编号。");
    return result;
  }
  function url(value) {
    const text = str(value, 2000);
    if (!text) return "";
    try {
      const result = new URL(text);
      if (
        !["https:", "http:"].includes(result.protocol) ||
        result.username ||
        result.password
      )
        throw new Error();
      return result.href;
    } catch {
      throw new Error("房源链接须为完整的 http 或 https 网址。");
    }
  }
  function profile(value) {
    const p = record(value);
    const result = {
      budgetMin: num(p.budgetMin),
      budgetMax: num(p.budgetMax),
      areas: str(p.areas, 300),
      priority: choice(p.priority, { new: 1, resale: 1, any: 1 }, "new"),
      driver: choice(p.driver, { ...campuses, undecided: 1 }, "undecided"),
      maxDrive: num(p.maxDrive, 600),
      maxTransit: num(p.maxTransit, 600),
    };
    if (
      result.budgetMin != null &&
      result.budgetMax != null &&
      result.budgetMin > result.budgetMax
    )
      throw new Error("预算下限不能高于上限。");
    return result;
  }
  function home(value) {
    const h = record(value),
      c = record(h.commute || {}),
      costs = record(h.costs || {});
    const result = {
      id: key(h.id),
      createdAt: stamp(h.createdAt),
      updatedAt: stamp(h.updatedAt),
      name: str(h.name, 100),
      kind: choice(h.kind, kinds, "new"),
      district: str(h.district, 100),
      address: str(h.address, 300),
      sourceUrl: url(h.sourceUrl),
      size: num(h.size, 10000, 0.01),
      layout: str(h.layout, 100),
      detail: str(h.detail, 1000),
      status: choice(h.status, statuses, "planned"),
      reason: str(h.reason, 1000),
      costs: {
        parking: num(costs.parking),
        tax: num(costs.tax),
        decoration: num(costs.decoration),
      },
      commute: {
        driver: choice(c.driver, { ...campuses, undecided: 1 }, "undecided"),
        station: str(c.station, 100),
        driverTotal: num(c.driverTotal, 600),
        detour: num(c.detour, 600),
        drop: num(c.drop, 600),
        wait: num(c.wait, 600),
        metro: num(c.metro, 600),
        lastLeg: num(c.lastLeg, 600),
        date: date(c.date),
        note: str(c.note, 1000),
      },
      prices: list(h.prices || [], 300, (value) => {
        const p = record(value);
        return {
          id: key(p.id),
          amount: num(p.amount, 100000, 0.01),
          type: choice(p.type, priceTypes, "asking"),
          date: date(p.date, true),
          source: str(p.source, 300),
          createdAt: stamp(p.createdAt),
        };
      }),
      visits: list(h.visits || [], 200, (value) => {
        const v = record(value);
        if (!Array.isArray(v.photos) || v.photos.length > 6)
          throw new Error("每次看房最多保存 6 张照片。");
        const photos = v.photos.map((value) => {
          if (
            typeof value !== "string" ||
            value.length > 1500000 ||
            !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
              value,
            )
          )
            throw new Error("照片格式无效或过大。");
          return value;
        });
        return {
          id: key(v.id),
          date: date(v.date, true),
          note: str(v.note, 4000),
          photos,
        };
      }),
    };
    if (!result.name || result.prices.some((p) => p.amount == null))
      throw new Error("房源名称或报价金额不能为空。");
    return result;
  }
  function validate(value) {
    const state = record(value);
    if (state.schema !== SCHEMA)
      throw new Error("不支持此备份版本，请使用“我的看房”导出的备份。");
    const revision =
      state.revision == null ? 0 : num(state.revision, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(revision)) throw new Error("备份版本号无效。");
    return {
      schema: SCHEMA,
      revision,
      profile: profile(state.profile),
      homes: list(state.homes, 500, home),
    };
  }
  function parse(text) {
    if (typeof text !== "string" || text.length > MAX_BACKUP)
      throw new Error("备份过大，最多支持 60 MB。");
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("无法读取 JSON 备份，原有记录没有改变。");
    }
    return validate(result);
  }
  function latest(home) {
    return (
      [...home.prices].sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.createdAt.localeCompare(a.createdAt),
      )[0] || null
    );
  }
  function passenger(c) {
    const legs = [c.drop, c.wait, c.metro, c.lastLeg];
    return legs.every((x) => x != null)
      ? legs.reduce((a, b) => a + b, 0)
      : null;
  }
  function totals(h) {
    const quote = latest(h),
      costs = Object.values(h.costs);
    return {
      amount: quote
        ? quote.amount + costs.reduce((sum, value) => sum + (value || 0), 0)
        : null,
      complete: !!quote && costs.every((value) => value != null),
    };
  }
  // Equal records are skipped. A conflicting record is kept as a separate copy,
  // so importing an old backup can never silently overwrite newer notes.
  function merge(current, imported, makeId = id) {
    const result = copy(current),
      known = new Map(current.homes.map((h) => [h.id, h]));
    let added = 0,
      conflicts = 0,
      skipped = 0;
    for (const entry of imported.homes) {
      const old = known.get(entry.id);
      if (old && JSON.stringify(old) === JSON.stringify(entry)) {
        skipped++;
        continue;
      }
      const h = copy(entry);
      if (old) {
        h.id = makeId();
        h.name = h.name.slice(0, 91) + "（导入副本）";
        conflicts++;
      }
      result.homes.push(h);
      known.set(h.id, h);
      added++;
    }
    if (!current.homes.length) result.profile = copy(imported.profile);
    return { state: validate(result), added, conflicts, skipped };
  }
  return {
    SCHEMA,
    MAX_BACKUP,
    statuses,
    kinds,
    priceTypes,
    campuses,
    copy,
    id,
    defaults,
    profile,
    home,
    validate,
    parse,
    latest,
    passenger,
    totals,
    merge,
  };
});
