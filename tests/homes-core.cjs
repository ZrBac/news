const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../news/assets/homes-core.js");
test("Candidate requirements include 100 square metres but exclude two rooms and unknowns", () => {
  for (const example of require("./fixtures/home-requirements.json"))
    assert.equal(H.candidateFits(example), example.fits, example.label);
});
