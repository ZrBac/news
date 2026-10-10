const test = require("node:test");
const assert = require("node:assert/strict");
const book = require("../news/guide/book.json");
const guide = require("../news/assets/guide-core.js");

test("Work and rental questions retrieve actual full entries with caveats", () => {
  for (const [question, chapter] of [
    ["公司裁员我能拿补偿吗", 19],
    ["房东不给退租房押金", 15],
  ]) {
    const entries = guide.retrieve(book, question);
    assert(
      entries.some((e) => e.chapter === chapter),
      question,
    );
    assert(entries.length <= 8);
    assert(new Set(entries.map((e) => e.chapter)).size <= 3);
    for (const entry of entries) {
      assert.equal(
        entry.body,
        book.entries.find((e) => e.id === entry.id).body,
      );
      assert(entry.body.includes("- 备注："));
      assert(entry.body.includes("- 来源："));
    }
  }
});
test("Unknown subjects yield no invented answer, and filters apply to favorites", () => {
  assert.deepEqual(guide.retrieve(book, "量子虫洞星际飞船"), []);
  const saved = new Set(["15-1", "19-1"]);
  const result = guide.search(book, "", { saved, chapter: 15 });
  assert.deepEqual(
    result.map((r) => r.entry.id),
    ["15-1"],
  );
});
test("Emergency and crisis questions prioritize their specified source chapters", () => {
  assert(
    guide.retrieve(book, "有人溺水没呼吸了").some((e) => e.chapter === 13),
  );
  assert(
    guide
      .retrieve(book, "我有自杀念头活不下去了")
      .some((e) => [1, 29].includes(e.chapter)),
  );
});
test("Cost ratio bands reproduce the source's algorithm", () => {
  assert.equal(
    guide.ratio({ tags: { 钱: "0", 时间: "少", 毅力: "否", 收益: "大" } }),
    "极高",
  );
  assert.equal(
    guide.ratio({ tags: { 钱: "少", 时间: "少", 毅力: "否", 收益: "大" } }),
    "高",
  );
  assert.equal(
    guide.ratio({ tags: { 钱: "多", 时间: "多", 毅力: "是", 收益: "中" } }),
    "一般",
  );
});

test("Published lookup indexes select chapters without requiring truncated entry bodies", () => {
  const entries = [
    book.entries.find((e) => e.id === "15-1"),
    book.entries.find((e) => e.id === "19-1"),
  ];
  const index = {
    entries: entries.map(({ body, summary, ...entry }) => entry),
    lookup: { 押金: [14], 裁员: [30], 公司: [21] },
  };
  assert.equal(guide.retrieve(index, "房东不退押金")[0].id, "15-1");
  assert.equal(guide.retrieve(index, "公司裁员")[0].id, "19-1");
  assert.deepEqual(guide.retrieve(index, "量子虫洞星际飞船"), []);
});
