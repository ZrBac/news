(() => {
  "use strict";
  const sessions = new WeakMap();
  const cacheName = "news-history-v1";
  const pagePath = /^\/data\/archive\/[a-f0-9]{16}\.json$/;
  const indexPath = /^\/data\/archive\/index\.[a-f0-9]{16}\.json$/;
  const session = (data) => {
    if (!sessions.has(data))
      sessions.set(data, {
        indexes: new Map(),
        read: new Set(),
        pending: new Map(),
      });
    return sessions.get(data);
  };
  async function read(path, request, validate, fresh) {
    let cache;
    try {
      cache = await caches.open(cacheName);
    } catch {}
    if (!fresh && cache) {
      try {
        const response = await cache.match(path);
        if (response) {
          const value = await response.json();
          if (validate(value)) return value;
          await cache.delete(path);
        }
      } catch {}
    }
    if (!navigator.onLine) throw new Error("Offline history");
    const value = await request(
      fresh ? path + "?retry=" + Date.now() : path,
      { cache: fresh ? "no-store" : "default" },
      20000,
    );
    if (!validate(value)) throw new Error("Invalid history");
    try {
      await cache?.put(
        path,
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      /* Browsing remains available when persistent storage is denied. */
    }
    return value;
  }
  function indexKey(data, criteria) {
    if (criteria.filter !== "all") return criteria.filter;
    if (criteria.source !== "all") {
      const categories = Object.entries(data.archive.categories || {}).filter(
        ([, sources]) => sources.includes(criteria.source),
      );
      if (categories.length === 1) return categories[0][0];
    }
    return "all";
  }
  async function index(data, request, fresh = false, key = "all") {
    const state = session(data);
    if (state.indexes.has(key)) return state.indexes.get(key);
    if (state.pending.has(key)) return state.pending.get(key);
    const pending = read(
      (data.archive.indexes || {})[key] || data.archive.lookup,
      request,
      (value) =>
        value?.schema === 1 &&
        Array.isArray(value.pages) &&
        value.pages.length <= 1000 &&
        value.pages.every(
          (path) => typeof path === "string" && pagePath.test(path),
        ) &&
        Array.isArray(value.rows) &&
        value.rows.length <= 12000 &&
        value.rows.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 5 &&
            row.slice(0, 4).every((value) => typeof value === "string") &&
            /^\d{4}-\d{2}-\d{2}$/.test(row[2]) &&
            Number.isInteger(row[4]) &&
            row[4] >= -1 &&
            row[4] < value.pages.length,
        ),
      fresh,
    )
      .then((value) => {
        state.indexes.set(key, value);
        return value;
      })
      .finally(() => {
        state.pending.delete(key);
      });
    state.pending.set(key, pending);
    return pending;
  }
  function matches(data, criteria) {
    const indexes = session(data).indexes;
    const value = indexes.get(indexKey(data, criteria)) || indexes.get("all");
    if (!value) return null;
    const key = JSON.stringify([
      criteria.filter,
      criteria.source,
      criteria.date,
      criteria.query,
    ]);
    const state = session(data);
    if (state.matchCache?.key === key && state.matchCache.value === value)
      return state.matchCache.rows;
    const words = criteria.query.toLowerCase().split(/\s+/).filter(Boolean);
    const names = new Map(
      data.sources.map((source) => [
        source.id,
        String(source.name || source.id).toLowerCase(),
      ]),
    );
    const rows = value.rows.filter(
      ([source, category, day, text]) =>
        (criteria.filter === "all" || category === criteria.filter) &&
        (criteria.source === "all" || source === criteria.source) &&
        (!criteria.date || day === criteria.date) &&
        words.every((word) =>
          (text + " " + (names.get(source) || "")).includes(word),
        ),
    );
    state.matchCache = { key, value, rows };
    return rows;
  }
  function remaining(data, criteria) {
    const loaded = session(data).read;
    if (!criteria.query && data.archive.shards)
      return data.archive.shards
        .map((shard, page) => ({ ...shard, page }))
        .filter(
          (shard) =>
            !loaded.has(shard.page) &&
            (criteria.filter === "all" || shard.category === criteria.filter) &&
            (criteria.source === "all" ||
              shard.sources.includes(criteria.source)) &&
            (!criteria.date || shard.days.includes(criteria.date)),
        )
        .sort((a, b) => b.newest.localeCompare(a.newest))
        .map((shard) => shard.page);
    const rows = matches(data, criteria);
    if (!rows) return null;
    return [
      ...new Set(
        rows
          .map((row) => row[4])
          .filter((page) => page >= 0 && !loaded.has(page)),
      ),
    ];
  }
  window.NewsArchive = {
    available: (data) => indexPath.test(data?.archive?.lookup || ""),
    remaining,
    validMetadata(data) {
      const archive = data.archive;
      return (
        (!archive.categories ||
          (typeof archive.categories === "object" &&
            !Array.isArray(archive.categories) &&
            Object.values(archive.categories).every(
              (sources) =>
                Array.isArray(sources) &&
                sources.every((source) => typeof source === "string"),
            ))) &&
        (!archive.indexes ||
          (typeof archive.indexes === "object" &&
            !Array.isArray(archive.indexes) &&
            Object.values(archive.indexes).every(
              (path) => typeof path === "string" && indexPath.test(path),
            ))) &&
        (!archive.shards ||
          (Array.isArray(archive.shards) &&
            archive.shards.length <= 1000 &&
            archive.shards.every(
              (shard) =>
                typeof shard.path === "string" &&
                pagePath.test(shard.path) &&
                typeof shard.category === "string" &&
                Array.isArray(shard.sources) &&
                shard.sources.every((source) => typeof source === "string") &&
                Array.isArray(shard.days) &&
                shard.days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)) &&
                Number.isFinite(Date.parse(shard.newest)),
            )))
      );
    },
    async prepare(data, criteria, request, fresh) {
      if (criteria.query || !data.archive.shards)
        await index(data, request, fresh, indexKey(data, criteria));
    },
    newestRemaining(data, criteria) {
      if (criteria.query || !data.archive.shards) return null;
      const page = remaining(data, criteria)[0];
      return page === undefined ? null : data.archive.shards[page].newest;
    },
    async page(data, number, request, validateArticle, fresh = false) {
      const state = session(data);
      const value = await read(
        data.archive.shards
          ? data.archive.shards[number].path
          : [...state.indexes.values()][0].pages[number],
        request,
        (value) =>
          Array.isArray(value?.articles) &&
          value.articles.every(validateArticle),
        fresh,
      );
      return value.articles;
    },
    mark(data, pages) {
      pages.forEach((page) => session(data).read.add(page));
    },
    async prune(data) {
      const value = [...session(data).indexes.values()][0];
      if (!value && !data.archive.shards) return;
      try {
        const cache = await caches.open(cacheName);
        const keep = new Set([
          data.archive.lookup,
          ...Object.values(data.archive.indexes || {}),
          ...(data.archive.shards
            ? data.archive.shards.map((shard) => shard.path)
            : value.pages),
        ]);
        const requests = await cache.keys();
        let excess = requests.length - 120;
        for (const request of requests) {
          if (excess <= 0) break;
          if (!keep.has(new URL(request.url).pathname)) {
            await cache.delete(request);
            excess--;
          }
        }
      } catch {}
    },
  };
})();
