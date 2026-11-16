const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../news/assets/homes-core.js");
test("Candidate requirements include 110 square metres but exclude two rooms and unknowns", () => {
  for (const example of require("./fixtures/home-requirements.json"))
    assert.equal(H.candidateFits(example), example.fits, example.label);
});
test("Watch matching separates phases, preferred sizes and room counts", () => {
  const groups = require("../news/home-watchlist.json").communities;
  const item = {kind: "resale", name: "金地自在城·求学里", areas: [124.84,124.84], layout: "3室2厅"};
  const q = H.watchCommunity(item, groups);
  assert.equal(q.id, "qiuxueli");
  assert.equal(H.watchTarget(item,q).order,1);
  assert.equal(H.watchTarget({...item,areas:[119.2,119.2]},q),null);
  assert.equal(H.watchTarget({...item,layout:"3室2厅1卫"},q),null);
  assert.equal(H.watchCommunity({...item,name:"金地自在城境水岸"},groups),null);
  assert.equal(H.watchCommunity({...item,name:"协安紫郡",title:"紫郡西苑大三房"},groups),null);
  assert.equal(H.watchCommunity({...item,name:"紫郡西苑",title:"近紫郡东苑"},groups),null);
  assert.equal(H.watchCommunity({...item,name:"协安紫郡",title:"紫郡东苑大三房"},groups).id,"zijundongyuan");
  assert.equal(H.candidateFits({...item,name:"万科融信西雅图",areas:[108,108]}),false);
});
