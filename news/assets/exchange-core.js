(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NewsExchange = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";
  const DAY = 86400000;
  function dayNumber(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      return NaN;
    const time = Date.parse(value + "T00:00:00Z");
    return Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
      ? time / DAY
      : NaN;
  }
  const dayString = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  function analyze(data, today) {
    const now = dayNumber(today);
    if (
      !data ||
      !["USD", "JPY", "THB"].includes(data.base) ||
      data.series !== `ecb-${data.base.toLowerCase()}-cny-reference-v1` ||
      data.quote !== "CNY" ||
      !Number.isFinite(now)
    )
      return null;
    const seen = new Set();
    let malformed = false;
    const points = (Array.isArray(data.points) ? data.points : [])
      .filter((p) => {
        if (
          !p ||
          !Number.isFinite(dayNumber(p.date)) ||
          dayNumber(p.date) > now ||
          !Number.isFinite(p.rate) ||
          p.rate <= 0.000001 ||
          p.rate >= 100 ||
          seen.has(p.date)
        ) {
          malformed = true;
          return false;
        }
        seen.add(p.date);
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!points.length) return null;
    const latest = points[points.length - 1];
    const end = dayNumber(latest.date),
      cutoff = end - 29;
    const window = points.filter((p) => dayNumber(p.date) >= cutoff);
    const complete =
      !malformed &&
      dayNumber(points[0].date) <= cutoff &&
      window.length >= 15 &&
      window.every(
        (p, i) => !i || dayNumber(p.date) - dayNumber(window[i - 1].date) <= 5,
      );
    const min = Math.min(...window.map((p) => Math.round(p.rate * 1e6)));
    const tied =
      window.filter((p) => Math.round(p.rate * 1e6) === min).length > 1;
    const stale = now - end > 4;
    const verified = data.status === "ok";
    // Show the last available month even when viewing an old offline snapshot.
    const asOf = dayNumber(data.asOfDate);
    const displayEnd = Number.isFinite(asOf)
      ? Math.max(end, Math.min(now, asOf))
      : end;
    const visible = points.filter(
      (p) =>
        dayNumber(p.date) >= displayEnd - 29 && dayNumber(p.date) <= displayEnd,
    );
    const low =
      complete && !stale && verified && Math.round(latest.rate * 1e6) === min;
    return {
      latest,
      points: visible,
      windowStart: dayString(cutoff),
      windowEnd: latest.date,
      periodStart: dayString(displayEnd - 29),
      periodEnd: dayString(displayEnd),
      complete,
      stale,
      verified,
      low,
      tied,
      min: min / 1e6,
      samples: window.length,
    };
  }
  // Integer arithmetic keeps half-cent rounding exact for six-decimal quotes.
  function convertAmount(value, rate) {
    const amount = String(value).trim();
    if (
      !/^(?:\d{1,9}(?:\.\d{0,2})?|\.\d{1,2})$/.test(amount) ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate >= 100
    )
      return null;
    const parts = amount.split(".");
    const cents =
      BigInt(parts[0] || "0") * 100n + BigInt((parts[1] || "").padEnd(2, "0"));
    const converted =
      (cents * BigInt(Math.round(rate * 1000000)) + 500000n) / 1000000n;
    return `${converted / 100n}.${String(converted % 100n).padStart(2, "0")}`;
  }
  return { analyze, convertAmount };
});
