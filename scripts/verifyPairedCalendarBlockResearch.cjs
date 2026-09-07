"use strict";
const assert = require("node:assert/strict");
const { POLICY, prepareCalendar, pairedCalendarBlockResearch } = require("./pairedCalendarBlockResearch.cjs");
const rows = Array.from({ length: 56 }, (_, i) => ({ eventId: `event-${i}`, forecastAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
  baseline: { brier: 0.6, logLoss: 1.1 }, candidate: { brier: 0.5, logLoss: 1 } }));
const passed = []; const check = (name, fn) => { fn(); passed.push(name); };
const result = pairedCalendarBlockResearch(rows);
check("positive fixed paired deltas give exact degenerate intervals", () => {
  assert.equal(result.status, "computed-research-only");
  assert.deepEqual(result.observedImprovement, { brier: 0.1, logLoss: 0.1 });
  assert.deepEqual(result.unadjusted95.brier, { lower: 0.1, upper: 0.1 });
  assert.equal(result.promotionEligible, false);
});
check("four comparisons and two endpoints use two-sided family correction", () => {
  assert.equal(result.familyAdjusted.familySize, 8);
  assert.equal(result.familyAdjusted.tailAlpha, 0.003125);
  assert.equal(POLICY.iterations, 5000);
});
check("reordered input is byte deterministic", () => assert.deepEqual(pairedCalendarBlockResearch([...rows].reverse()), result));
check("same-day matches remain a single calendar cluster with an empty day retained", () => {
  const days = prepareCalendar([rows[0], { ...rows[0], eventId: "same-day" }, rows[2]]);
  assert.deepEqual(days.map(d => d.rows), [2, 0, 1]);
  assert.deepEqual(days[0].ids, ["event-0", "same-day"]);
});
check("no-data and insufficient time support remain unavailable", () => {
  assert.equal(pairedCalendarBlockResearch([]).unadjusted95, null);
  assert.equal(pairedCalendarBlockResearch(rows.slice(0, 10)).status, "insufficient-calendar-support");
  assert.equal(pairedCalendarBlockResearch([rows[0], rows.at(-1)]).unadjusted95, null);
});
check("duplicate identities, bad clocks and null losses fail closed", () => {
  assert.throws(() => pairedCalendarBlockResearch([...rows, rows[0]]), /identity/);
  assert.throws(() => prepareCalendar([{ ...rows[0], forecastAt: "not-a-date" }]), /clock/);
  for (const loss of [null, NaN, Infinity, -1]) assert.throws(() => prepareCalendar([{ ...rows[0], candidate: { brier: loss, logLoss: 1 } }]), /loss/);
});
check("identical candidate and market give exactly zero, negative results remain negative", () => {
  const equal = pairedCalendarBlockResearch(rows.map(r => ({ ...r, candidate: r.baseline })));
  assert.deepEqual(equal.familyAdjusted.intervals.logLoss, { lower: 0, upper: 0 });
  const worse = pairedCalendarBlockResearch(rows.map(r => ({ ...r, baseline: r.candidate, candidate: r.baseline })));
  assert.deepEqual(worse.unadjusted95.brier, { lower: -0.1, upper: -0.1 });
  assert.equal(worse.seedHash, result.seedHash);
});
check("point estimate is match-weighted, not an average of unequal day means", () => {
  const uneven = [...rows, ...Array.from({ length: 20 }, (_, i) => ({ ...rows[0], eventId: `extra-${i}`, candidate: { brier: 0.3, logLoss: 0.8 } }))];
  const report = pairedCalendarBlockResearch(uneven);
  assert.equal(report.observedImprovement.brier, Number(((56 * 0.1 + 20 * 0.3) / 76).toFixed(10)));
  assert.ok(report.familyAdjusted.intervals.brier.lower <= report.unadjusted95.brier.lower);
  assert.ok(report.familyAdjusted.intervals.brier.upper >= report.unadjusted95.brier.upper);
});
console.log(JSON.stringify({ ok: true, checks: passed.length, passed }, null, 2));
