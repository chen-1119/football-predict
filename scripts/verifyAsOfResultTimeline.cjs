const assert = require("node:assert/strict");
const {
  forEachForecastAsOf,
  forecastTimeForMatch,
  resultObservationForMatch,
} = require("./asOfResultTimeline.cjs");

const match = (id, kickoffTime, overrides = {}) => ({
  id,
  sourceMatchId: id,
  kickoffTime,
  eventVersion: kickoffTime,
  source: "sporttery",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
  resultSource: "sporttery:official-api",
  status: "SCHEDULED",
  homeTeamName: `${id}-home`,
  awayTeamName: `${id}-away`,
  ...overrides,
});

const a = match("A", "2026-01-01T12:00:00.000Z", {
  status: "FINISHED",
  scoreHome: 1,
  scoreAway: 0,
  resultObservedAt: "2026-01-01T14:00:00.000Z",
  resultObservationSource: "sporttery-relay-endpoint-fetched-at",
});
const b = match("B", "2026-01-01T13:00:00.000Z");
const c = match("C", "2026-01-01T15:00:00.000Z");
const seen = new Map();
const state = [];
const summary = forEachForecastAsOf([c, a, b], {
  onResult: (row) => state.push(row.sourceMatchId),
  onForecast: (row) => seen.set(row.sourceMatchId, [...state]),
});
assert.deepEqual(seen.get("A"), []);
assert.deepEqual(seen.get("B"), [], "13:00 forecast must not see a result observed at 14:00");
assert.deepEqual(seen.get("C"), ["A"], "15:00 forecast may use the result observed at 14:00");
assert.equal(summary.forecasts, 3);
assert.equal(summary.appliedResults, 1);
assert.equal(summary.fallbackResults, 0);

const sameOne = match("same-1", "2026-02-01T12:00:00.000Z", {
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 1,
});
const sameTwo = match("same-2", "2026-02-01T12:00:00.000Z", {
  status: "FINISHED",
  scoreHome: 0,
  scoreAway: 0,
});
const sameSeen = new Map();
const sameState = [];
const sameSummary = forEachForecastAsOf([sameTwo, sameOne], {
  onResult: (row) => sameState.push(row.sourceMatchId),
  onForecast: (row) => sameSeen.set(row.sourceMatchId, [...sameState]),
});
assert.deepEqual(sameSeen.get("same-1"), []);
assert.deepEqual(sameSeen.get("same-2"), []);
assert.equal(sameSummary.appliedResults, 0);
assert.equal(sameSummary.unappliedResults, 0);
assert.equal(sameSummary.unobservedResults, 2);

const badClock = match("clock", "2026-03-01T12:00:00.000Z", {
  status: "FINISHED",
  scoreHome: 1,
  scoreAway: 1,
  resultObservedAt: "2026-03-01T11:00:00.000Z",
});
const observation = resultObservationForMatch(badClock);
assert.equal(observation.fallback, true);
assert.equal(observation.observedAt, null);
assert.equal(observation.promotionEligible, false);

const forecastOverride = match("forecast", "2026-03-02T12:00:00.000Z", {
  predictionMeta: { generatedAt: "2026-03-02T09:30:00.000Z" },
});
assert.equal(forecastTimeForMatch(forecastOverride), Date.parse("2026-03-02T09:30:00.000Z"));

console.log(JSON.stringify({
  ok: true,
  verifier: "as-of-result-timeline",
  assertions: 15,
  version: summary.version,
  delayedObservation: summary,
  simultaneousKickoff: sameSummary,
  invalidClockExcluded: observation,
}, null, 2));
