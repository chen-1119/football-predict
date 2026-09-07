const assert = require("node:assert/strict");
const {
  forEachForecastAsOf,
  forecastTimeForMatch,
  resultObservationForMatch,
  resultTimelineSemanticHash,
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

let clockChecks = 0;
const checkClock = (name, action) => { action(); clockChecks++; };
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { buildResultProvenance } = require("../src/services/matchLifecycle.cjs");
const { buildFormSnapshots, buildEloSnapshots } = require("./syncData.cjs");
const invalidInstants = ["2026-02-29T14:00:00Z", "2026-04-31T14:00:00Z", "1900-02-29T14:00:00Z",
  "2026-01-01T24:00:00Z", "2026-01-01T14:60:00Z", "2026-01-01T14:00:60Z",
  "2026-01-01T14:00:00+24:00", "2026-01-01T14:00:00+08:60", "2026-01-01", "2026-01-01T14:00:00", false, 0];
for (const value of invalidInstants) {
  checkClock(`invalid source instant: ${value}`, () => {
    assert.equal(strictInstant(value), null);
    const row = { ...a, resultObservedAt: value };
    assert.equal(buildResultProvenance(row).promotionEligible, false);
    assert.equal(resultObservationForMatch(row).observedAt, null);
  });
  checkClock(`invalid decision cannot fall through to kickoff: ${value}`, () => {
    assert.equal(forecastTimeForMatch({ ...c, predictionMeta: { generatedAt: value } }), null);
  });
  checkClock(`invalid kickoff cannot enter a timeline: ${value}`, () => {
    assert.equal(forecastTimeForMatch({ ...c, kickoffTime: value }), null);
    assert.equal(resultObservationForMatch({ ...a, kickoffTime: value }), null);
  });
}
for (const value of ["2024-02-29T14:00:00Z", "2000-02-29T14:00:00Z", "2026-01-01T22:00:00.123456789+08:00", "2026-01-01T14:00Z"]) {
  checkClock(`valid zoned instant bytes stay stable: ${value}`, () => assert.equal(strictInstant(value), value));
}
checkClock("trusted legacy provenance must not hide calendar rollover", () => {
  const trusted = buildResultProvenance(a);
  const row = { ...a, resultObservedAt: a.resultObservedAt,
    resultProvenance: { ...trusted, observedAt: "2026-02-29T14:00:00Z" } };
  assert.equal(buildResultProvenance(row).observedAt, null);
  assert.equal(resultObservationForMatch(row).promotionEligible, false);
});
checkClock("bad receipt cannot update the actual Elo or form builders", () => {
  const row = { ...a, kickoffTime: "2026-02-28T12:00:00Z", eventVersion: "2026-02-28T12:00:00Z",
    resultObservedAt: "2026-02-29T14:00:00Z" };
  const next = { ...c, homeTeamName: a.homeTeamName, awayTeamName: a.awayTeamName,
    kickoffTime: "2026-03-02T12:00:00Z", predictionMeta: { generatedAt: "2026-03-02T10:00:00Z" } };
  const good = { ...row, resultObservedAt: "2026-03-01T14:00:00Z" };
  assert.equal(buildFormSnapshots([row, next]).get(next.sourceMatchId).home.sampleSize, 0);
  assert.equal(buildEloSnapshots([row, next]).get(next.sourceMatchId).homeMatches, 0);
  assert.equal(buildFormSnapshots([good, next]).get(next.sourceMatchId).home.sampleSize, 1);
  assert.equal(buildEloSnapshots([good, next]).get(next.sourceMatchId).homeMatches, 1);
});
const replayTimelineHash = (lineEndings, changedParser = false) => {
  const source = require("node:fs").readFileSync(require.resolve("./asOfResultTimeline.cjs"), "utf8").replace(/\r\n?/g, "\n");
  const isolated = { exports: {} };
  require("node:vm").runInNewContext(lineEndings === "crlf" ? source.replace(/\n/g, "\r\n") : source, {
    module: isolated,
    require: name => name === "../src/services/strictInstant.cjs" && changedParser
      ? { strictInstant: value => typeof value === "string" ? value : null }
      : require(name),
  });
  return isolated.exports.resultTimelineSemanticHash();
};
checkClock("timeline semantic hash is stable across Windows and Linux line endings", () => {
  assert.equal(replayTimelineHash("lf"), resultTimelineSemanticHash());
  assert.equal(replayTimelineHash("crlf"), resultTimelineSemanticHash());
});
checkClock("a parser dependency change changes the timeline commitment", () => {
  assert.notEqual(replayTimelineHash("lf", true), resultTimelineSemanticHash());
});

console.log(JSON.stringify({
  ok: true,
  verifier: "as-of-result-timeline",
  assertions: 15 + clockChecks,
  clockChecks,
  version: summary.version,
  delayedObservation: summary,
  simultaneousKickoff: sameSummary,
  invalidClockExcluded: observation,
}, null, 2));
