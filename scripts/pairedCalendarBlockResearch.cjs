"use strict";
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const DAY = 86400000;
const KEYS = ["brier", "logLoss"];
const POLICY = Object.freeze({ version: "paired-calendar-block-research-v1", blockDays: 7, iterations: 5000,
  minimumCalendarDays: 28, minimumOccupiedDays: 14, alpha: 0.05, comparisonCount: 4, endpointCount: 2 });
const round = x => x === null ? null : Number(x.toFixed(10));
function prepareCalendar(rows) {
  if (!Array.isArray(rows)) throw new Error("paired rows must be an array");
  const ids = new Set();
  const sorted = [...rows].sort((a, b) => String(a.forecastAt).localeCompare(String(b.forecastAt)) || String(a.eventId).localeCompare(String(b.eventId)));
  for (const r of sorted) {
    if (typeof r.eventId !== "string" || !r.eventId.trim() || ids.has(r.eventId)) throw new Error("invalid or duplicate paired identity");
    ids.add(r.eventId);
    if (typeof r.forecastAt !== "string" || !Number.isFinite(Date.parse(r.forecastAt)) || new Date(r.forecastAt).toISOString() !== r.forecastAt) throw new Error("invalid paired calendar clock");
    for (const side of ["baseline", "candidate"]) for (const key of KEYS) {
      if (typeof r[side]?.[key] !== "number" || !Number.isFinite(r[side][key]) || r[side][key] < 0) throw new Error("invalid paired loss");
    }
  }
  if (!sorted.length) return [];
  const start = Date.parse(sorted[0].forecastAt.slice(0, 10)), end = Date.parse(sorted.at(-1).forecastAt.slice(0, 10));
  if ((end - start) / DAY > 3660) throw new Error("calendar exceeds research allocation bound");
  const days = Array.from({ length: (end - start) / DAY + 1 }, (_, i) => ({ date: new Date(start + i * DAY).toISOString().slice(0, 10), rows: 0, ids: [], brier: 0, logLoss: 0 }));
  for (const r of sorted) {
    const day = days[(Date.parse(r.forecastAt.slice(0, 10)) - start) / DAY];
    day.rows++; day.ids.push(r.eventId);
    for (const key of KEYS) day[key] += r.baseline[key] - r.candidate[key];
  }
  return days;
}
function pairedCalendarBlockResearch(rows) {
  const days = prepareCalendar(rows), occupiedDays = days.filter(d => d.rows).length;
  const count = rows.length;
  const observed = Object.fromEntries(KEYS.map(k => [k, count ? round(days.reduce((s, d) => s + d[k], 0) / count) : null]));
  const body = { policy: POLICY, researchOnly: true, promotionEligible: false, rows: count, calendarDays: days.length, occupiedDays,
    calendarHash: stableHash(days), observedImprovement: observed,
    caveat: "historical descriptive sensitivity; assumes useful dependence capture in seven-day blocks; not team-cluster independence or prospective promotion evidence" };
  if (days.length < POLICY.minimumCalendarDays || occupiedDays < POLICY.minimumOccupiedDays) return { ...body, status: "insufficient-calendar-support", unadjusted95: null, familyAdjusted: null };
  // Seed depends on the fixed method and identities, not on the winning route or its labels.
  const seedHash = stableHash({ policy: POLICY, identities: days.map(d => ({ date: d.date, ids: d.ids })) });
  let state = Number.parseInt(seedHash.slice(0, 8), 16) >>> 0 || 0x9e3779b9;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const samples = { brier: [], logLoss: [] };
  let emptyReplicates = 0;
  for (let iteration = 0; iteration < POLICY.iterations; iteration++) {
    const sums = { brier: 0, logLoss: 0 }; let sampledDays = 0, sampledRows = 0;
    while (sampledDays < days.length) {
      const start = Math.floor(random() * days.length);
      for (let offset = 0; offset < POLICY.blockDays && sampledDays < days.length; offset++, sampledDays++) {
        const day = days[(start + offset) % days.length];
        sampledRows += day.rows;
        for (const k of KEYS) sums[k] += day[k];
      }
    }
    if (!sampledRows) { emptyReplicates++; continue; }
    for (const k of KEYS) samples[k].push(sums[k] / sampledRows);
  }
  if (emptyReplicates) return { ...body, status: "empty-bootstrap-replicate", seedHash, emptyReplicates, unadjusted95: null, familyAdjusted: null };
  for (const k of KEYS) samples[k].sort((a, b) => a - b);
  const intervals = tail => Object.fromEntries(KEYS.map(k => [k, {
    lower: round(samples[k][Math.floor((samples[k].length - 1) * tail)]),
    upper: round(samples[k][Math.floor((samples[k].length - 1) * (1 - tail))]),
  }]));
  const familySize = POLICY.comparisonCount * POLICY.endpointCount;
  const tailAlpha = POLICY.alpha / (2 * familySize);
  return { ...body, status: "computed-research-only", seedHash, emptyReplicates,
    unadjusted95: intervals(POLICY.alpha / 2),
    familyAdjusted: { method: "two-sided-bonferroni-four-route-scope-comparisons-two-endpoints", familySize, tailAlpha, intervals: intervals(tailAlpha) } };
}
module.exports = { POLICY, prepareCalendar, pairedCalendarBlockResearch };
