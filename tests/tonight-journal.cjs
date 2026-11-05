const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto").webcrypto;
const source = fs.readFileSync(path.join(__dirname, "../news/assets/tonight-journal.js"), "utf8");
function device() {
  const stored = new Map();
  const storage = {getItem:k => stored.get(k) ?? null, setItem:(k,v) => stored.set(k,v)};
  const context = vm.createContext({window:{}, localStorage:storage, crypto});
  vm.runInContext(source, context);
  return {journal:context.window.TonightJournal, stored, storage};
}
const pick = {id:"event:tonight-reading", name:"把一本书慢慢读完"};

test("notes survive reopening and merge backups without replacing current entries", () => {
  const first = device();
  first.journal.add(pick, "读到第 36 页", "从第 37 页继续");
  const backup = JSON.parse(JSON.stringify(first.journal.backup()));
  const second = device();
  assert.equal(second.journal.restore(backup), 1);
  backup.records[0].note = "不能覆盖已存在的文字";
  assert.equal(second.journal.restore(backup), 0);
  assert.equal(second.journal.snapshot()[0].note, "读到第 36 页");
  assert.equal(second.journal.snapshot()[0].next, "从第 37 页继续");
  assert.equal(second.stored.size, 1, "does not write to shared outing records");
});

test("failed writes keep old entries and report failure instead of saving in memory", () => {
  const {journal, storage} = device();
  journal.add(pick, "已保存的文字", "下次继续");
  storage.setItem = () => {throw new Error("quota");};
  assert.throws(() => journal.add(pick, "不能丢掉旧记录", ""), /未能保存/);
  assert.equal(journal.snapshot().length, 1);
  assert.equal(journal.snapshot()[0].note, "已保存的文字");
});

test("invalid, duplicate and oversized imports preserve existing records", () => {
  const {journal, stored} = device();
  journal.add(pick, "原来的笔记", "");
  const before = stored.get(journal.key);
  const backup = JSON.parse(JSON.stringify(journal.backup()));
  for (const records of [[{...backup.records[0], note:" "}],
      [{...backup.records[0], note:"a".repeat(501)}],
      [{...backup.records[0], activityId:'<script>alert(1)</script>'}],
      [backup.records[0], backup.records[0]], Array(2001).fill(backup.records[0])]) {
    assert.throws(() => journal.restore({...backup, records}), /格式/);
    assert.equal(stored.get(journal.key), before);
  }
  assert.throws(() => journal.add(pick, "  ", ""), /格式/);
});

test("corrupt local data is not silently replaced; blocked reads remain visible", () => {
  const {journal, stored, storage} = device();
  stored.set(journal.key, "broken-json");
  assert.equal(journal.snapshot().length, 0);
  assert.match(journal.status(), /未覆盖/);
  assert.throws(() => journal.add(pick, "新的记录", ""), /未覆盖/);
  assert.equal(stored.get(journal.key), "broken-json");
  storage.getItem = () => {throw new Error("denied");};
  journal.snapshot();
  assert.match(journal.status(), /无法读取/);
});

test("delete and undo restore the actual note and next step", () => {
  const {journal} = device();
  const record = journal.add(pick, "今天理解的一个问题", "下次核对例子");
  const removed = journal.remove(record.id);
  assert.equal(journal.snapshot().length, 0);
  assert.equal(journal.restore({schema:1,app:"zacai-tonight-journal",records:[removed]}), 1);
  assert.equal(journal.snapshot()[0].next, "下次核对例子");
});
