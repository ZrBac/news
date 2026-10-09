const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("../news/assets/exchange-core.js");
const TODAY = "2026-10-09";
function fixture() {
  const points = [];
  for (let n = 40; n >= 0; n--) {
    const d = new Date(Date.parse(TODAY) - n * 86400000);
    if (![0, 6].includes(d.getUTCDay()))
      points.push({ date: d.toISOString().slice(0, 10), rate: 7 + n / 1000 });
  }
  return {
    series: "ecb-usd-cny-reference-v1",
    base: "USD",
    quote: "CNY",
    asOfDate: TODAY,
    status: "ok",
    points,
  };
}
test("quote direction, 30 calendar days, 20 calendar day low rather than 20 observations", () => {
  const data = fixture();
  data.points[0].rate = 6;
  const info = analyze(data, TODAY);
  assert.equal(info.low, true);
  assert.equal(info.windowStart, "2026-09-20");
  assert.equal(info.periodStart, "2026-09-10");
  assert.equal(info.latest.rate, 7);
  assert(info.samples < 20);
  assert(info.points.every((p) => p.date >= "2026-09-10"));
});
test("ties highlight, higher current quote does not, comparison uses six decimal places", () => {
  const data = fixture();
  data.points.at(-2).rate = 7;
  assert.equal(analyze(data, TODAY).tied, true);
  assert.equal(analyze(data, TODAY).low, true);
  data.points.at(-1).rate = 7.000001;
  assert.equal(analyze(data, TODAY).low, false);
});
test("weekend retains dated quote but stale data and collection failure suspend alert", () => {
  const data = fixture();
  assert.equal(analyze(data, "2026-10-11").low, true);
  assert.equal(analyze(data, "2026-10-14").low, false);
  assert.equal(analyze({ ...data, status: "unavailable" }, TODAY).low, false);
});
test("insufficient, gapped, duplicate, invalid or future history cannot trigger a low", () => {
  const data = fixture();
  for (const points of [
    data.points.slice(-5),
    data.points.filter((p) => p.date < "2026-09-28" || p.date > "2026-10-06"),
    [...data.points, data.points[0]],
    [...data.points, { date: "2026-10-40", rate: 6 }],
    [...data.points, { date: "2026-10-10", rate: 6 }],
  ])
    assert.equal(analyze({ ...data, points }, TODAY).low, false);
  assert.equal(analyze({ ...data, base: "CNY" }, TODAY), null);
  assert.equal(analyze({ ...data, points: [] }, TODAY), null);
});

test("JPY and THB use their own low-price series, including rates below 0.1", () => {
  for (const code of ["JPY", "THB"]) {
    const data = fixture();
    data.base = code;
    data.series = `ecb-${code.toLowerCase()}-cny-reference-v1`;
    data.points = data.points.map((p) => ({
      ...p,
      rate: Number((p.rate / (code === "JPY" ? 140 : 35)).toFixed(6)),
    }));
    assert.equal(analyze(data, TODAY).low, true);
    data.points[data.points.length - 1].rate += 0.01;
    assert.equal(analyze(data, TODAY).low, false);
    data.series = "ecb-usd-cny-reference-v1";
    assert.equal(analyze(data, TODAY), null);
  }
});
