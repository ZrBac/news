(function (root, factory) {
  "use strict";
  const api = factory();
  root.LifeGuide = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "");
  const textCache = new WeakMap();
  function indexed(entry) {
    let value = textCache.get(entry);
    if (!value) {
      value = {
        title: entry.searchTitle || normalize(entry.title),
        summary: entry.searchSummary || normalize(entry.summary),
        body: normalize(entry.body),
      };
      textCache.set(entry, value);
    }
    return value;
  }
  const stop = new Set([
    "怎么",
    "什么",
    "如何",
    "是不是",
    "有没有",
    "可以",
    "能不能",
    "时候",
    "现在",
    "一下",
    "哪些",
    "应该",
    "需要",
    "自己",
    "一个",
    "这本",
    "指南",
    "我的",
    "我要",
    "我想",
    "多少",
    "的吗",
    "的人",
    "问题",
    "办法",
    "事情",
    "之后",
    "之前",
  ]);
  const aliases = [
    [/被裁|裁员|辞退|离职|加班|工伤|欠薪/, "劳动合同 经济补偿 失业 工伤 加班"],
    [/租房|押金|房东/, "租房 押金 房东 合同"],
    [/买房|房贷|房产/, "买房 房贷 房产 首付"],
    [/戒烟|抽烟|吸烟/, "戒烟 烟草 尼古丁"],
    [/失眠|睡不着|睡眠|熬夜/, "睡眠 失眠 熬夜"],
    [/被骗|诈骗|转账|刷单/, "诈骗 转账 反诈"],
    [/领证|结婚|彩礼|恋爱/, "结婚 彩礼 婚姻 恋爱"],
    [/看病|医保|挂号|医院/, "看病 医保 社区 医院"],
    [/育儿|小孩|孩子|宝宝/, "孩子 儿童 出生"],
    [/自杀|活不下去|不想活/, "12356 自杀 危机", [1, 29]],
    [/没呼吸|大出血|触电|溺水|中毒|火灾|心梗|卒中/, "急救 120 119", [13]],
    [/被拘留|被传唤|被起诉/, "传唤 拘留 律师", [8]],
  ];
  function tokens(query) {
    const text = normalize(query);
    const words = new Set(text.match(/[a-z0-9]{2,}/g) || []);
    for (const segment of text.match(/[\u4e00-\u9fff]+/g) || []) {
      if (segment.length === 1) words.add(segment);
      for (let i = 0; i < segment.length - 1; i++) {
        const token = segment.slice(i, i + 2);
        if (!stop.has(token)) words.add(token);
      }
    }
    return Array.from(words).slice(0, 100);
  }
  function search(book, query, options = {}) {
    const text = normalize(query),
      terms = tokens(query);
    const extra = new Set(),
      priority = new Set();
    for (const [pattern, expansion, chapters] of aliases) {
      if (pattern.test(text)) {
        for (const word of tokens(expansion)) extra.add(word);
        for (const id of chapters || []) priority.add(id);
      }
    }
    if (book.lookup) {
      // Generated postings avoid scanning the entire book inside a small Worker.
      const scores = new Float32Array(book.entries.length);
      for (const term of terms) {
        for (const item of book.lookup[term] || [])
          scores[Math.floor(item / 16)] += item % 16;
      }
      for (const term of extra) {
        for (const item of book.lookup[term] || [])
          scores[Math.floor(item / 16)] += item % 16 === 14 ? 6 : 2;
      }
      return book.entries
        .map((entry, i) => ({
          entry,
          score:
            scores[i] +
            (priority.has(entry.chapter) ? 30 : 0) +
            (text && entry.searchTitle?.includes(text) ? 100 : 0),
        }))
        .filter(
          ({ entry, score }) =>
            (!text || score > 0) &&
            (!options.chapter || entry.chapter === Number(options.chapter)) &&
            (!options.grade || entry.grade === options.grade) &&
            (!options.saved || options.saved.has(entry.id)),
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.entry.chapter - b.entry.chapter ||
            a.entry.number - b.entry.number,
        );
    }
    return book.entries
      .filter(
        (entry) =>
          (!options.chapter || entry.chapter === Number(options.chapter)) &&
          (!options.grade || entry.grade === options.grade) &&
          (!options.saved || options.saved.has(entry.id)),
      )
      .map((entry) => {
        if (!text) return { entry, score: 0 };
        const { title, summary, body } = indexed(entry);
        let score = title.includes(text) ? 100 : 0;
        let direct = 0;
        for (const term of terms) {
          const weight = title.includes(term)
            ? 14
            : summary.includes(term)
              ? 5
              : body.includes(term)
                ? 1
                : 0;
          direct += weight;
          score += weight;
        }
        for (const term of extra)
          score += title.includes(term) ? 6 : summary.includes(term) ? 2 : 0;
        if (priority.has(entry.chapter)) score += 30;
        return { entry, score: direct || extra.size ? score : 0 };
      })
      .filter(({ score }) => !text || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.entry.chapter - b.entry.chapter ||
          a.entry.number - b.entry.number,
      );
  }
  // These cost weights and ratio bands mirror upstream index.html (MIT).
  function ratio(entry) {
    const t = entry.tags;
    const cost =
      { 0: 0, 少: 1, 多: 2 }[t["钱"]] +
      { 少: 0, 中: 1, 多: 2 }[t["时间"]] +
      { 否: 0, 些: 1, 是: 2 }[t["毅力"]];
    if (!Number.isFinite(cost)) return "未标注";
    return t["收益"] === "大"
      ? cost === 0
        ? "极高"
        : cost <= 2
          ? "高"
          : "一般"
      : t["收益"] === "中" && cost === 0
        ? "高"
        : "一般";
  }
  function retrieve(book, question) {
    const ranked = search(book, question);
    if (!ranked.length) return [];
    const chapters = new Set(
      Array.from(
        new Set(ranked.slice(0, 6).map(({ entry }) => entry.chapter)),
      ).slice(0, 3),
    );
    const result = [];
    let size = 0;
    for (const { entry } of ranked) {
      if (!chapters.has(entry.chapter)) continue;
      // Keep whole entries, including caveats and source links. Never cut a note.
      if (size + (entry.body?.length || 0) > 24000) continue;
      result.push(entry);
      size += entry.body?.length || 0;
      if (result.length === 8) break;
    }
    return result;
  }
  return { search, retrieve, ratio, tokens };
});
