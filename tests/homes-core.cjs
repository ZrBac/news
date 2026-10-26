const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../news/assets/homes-core.js");
function fixture() {
  return H.home({
    id: "home-1",
    name: "测试房源",
    createdAt: "2026-10-26T08:00:00Z",
    updatedAt: "2026-10-26T08:00:00Z",
    size: 100,
    prices: [
      {
        id: "price-1",
        amount: 330,
        type: "asking",
        date: "2026-10-26",
        source: "平台挂牌",
        createdAt: "2026-10-26T08:00:00Z",
      },
    ],
  });
}
test("Unknown costs and travel legs stay unknown; confirmed zero is valid", () => {
  const h = fixture();
  assert.deepEqual(H.totals(h), { amount: 330, complete: false });
  assert.equal(H.passenger(h.commute), null);
  h.costs = { parking: 20, tax: 0, decoration: 10 };
  assert.deepEqual(H.totals(h), { amount: 360, complete: true });
  Object.assign(h.commute, { drop: 15, wait: 0, metro: 20, lastLeg: 10 });
  assert.equal(H.passenger(h.commute), 45);
  h.commute.lastLeg = null;
  assert.equal(H.passenger(h.commute), null);
});
test("Backdated prices do not replace newer prices and quote types survive backups", () => {
  const h = fixture();
  h.prices.push({
    id: "price-2",
    amount: 320,
    type: "quoted",
    date: "2026-10-25",
    source: "销售",
    createdAt: "2026-10-27T08:00:00Z",
  });
  const state = H.defaults();
  state.homes = [h];
  const restored = H.parse(JSON.stringify(state));
  assert.equal(H.latest(restored.homes[0]).amount, 330);
  assert.equal(restored.homes[0].prices[1].type, "quoted");
});
test("Import preserves both versions of conflicting homes and skips exact duplicates", () => {
  const current = H.defaults();
  current.homes = [fixture()];
  const imported = H.copy(current);
  assert.equal(H.merge(current, imported).skipped, 1);
  imported.homes[0].reason = "更早的备注";
  const result = H.merge(current, imported, () => "conflict-copy");
  assert.equal(result.conflicts, 1);
  assert.equal(result.state.homes.length, 2);
  assert.equal(result.state.homes[0].reason, "");
  assert.equal(result.state.homes[1].reason, "更早的备注");
  assert.equal(current.homes.length, 1);
  assert.match(result.state.homes[1].name, /导入副本/);
});
test("Photos, notes, preferences and explicit zero round-trip through a backup", () => {
  const state = H.defaults(),
    h = fixture();
  h.visits = [
    {
      id: "visit-1",
      date: "2026-10-26",
      note: "阳台采光好\n晚高峰要再走一遍",
      photos: ["data:image/jpeg;base64,YWJjZA=="],
    },
  ];
  h.costs.tax = 0;
  state.homes = [h];
  state.profile.driver = "xixi";
  assert.deepEqual(H.parse(JSON.stringify(state)), state);
  assert.deepEqual(H.merge(H.defaults(), state).state.profile, state.profile);
});
test("Invalid imports are rejected as a whole, including unsafe links and photos", () => {
  const base = H.defaults();
  base.homes = [fixture()];
  for (const mutate of [
    (s) => {
      s.schema = 2;
    },
    (s) => {
      s.homes.push(H.copy(s.homes[0]));
    },
    (s) => {
      s.homes[0].sourceUrl = "javascript:alert(1)";
    },
    (s) => {
      s.homes[0].sourceUrl = "https://user:secret@example.com/";
    },
    (s) => {
      s.homes[0].size = -10;
    },
    (s) => {
      s.homes[0].prices[0].date = "2026-02-30";
    },
    (s) => {
      s.homes[0].status = "__proto__";
    },
    (s) => {
      s.profile.budgetMin = 400;
    },
    (s) => {
      s.homes[0].visits = [
        {
          id: "v1",
          date: "2026-10-26",
          note: "",
          photos: ["data:image/svg+xml;base64,YWJjZA=="],
        },
      ];
    },
  ]) {
    const bad = H.copy(base);
    mutate(bad);
    assert.throws(() => H.parse(JSON.stringify(bad)));
    assert.equal(base.homes[0].name, "测试房源");
  }
  assert.throws(() => H.parse("not JSON"));
});
