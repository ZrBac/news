/* Shared rules for public home candidates. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HomeBook = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";
  function candidateFits(candidate) {
    const areas = candidate?.areas,
      layout = candidate?.layout;
    if (
      !Array.isArray(areas) ||
      areas.length !== 2 ||
      !areas.every(Number.isFinite) ||
      areas[0] < 100 ||
      areas[1] < areas[0] ||
      typeof layout !== "string"
    )
      return false;
    const numerals = {
      零: 0,
      〇: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const text = layout.replace(/[零〇一二两三四五六七八九十]+/g, (n) =>
      String(numerals[n] ?? 0),
    );
    const pattern =
      /(\d+(?:\.\d+)?(?:\s*[-–—~/、至到]\s*\d+(?:\.\d+)?)*)\s*(?:室|居)/g;
    const rooms = [];
    let match;
    while ((match = pattern.exec(text)))
      rooms.push(...match[1].match(/\d+(?:\.\d+)?/g).map(Number));
    return (
      rooms.length > 0 && rooms.every((n) => Number.isInteger(n) && n >= 3)
    );
  }
  return { candidateFits };
});
