"use strict";
const assert = require("node:assert/strict");
const { summarizeRecentFormEvidence: summarize } = require("./recentFormEvidence.cjs");
const { buildFormSnapshots, predictionSet, buildPredictionFeatureSnapshot } = require("./syncData.cjs");
const { bindPublicReferenceDecision: bind, pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const decisionAt = "2026-09-07T01:00:00.000Z";
// The fixture decision is historical; run the actual model at that fixed clock.
// Otherwise wall-clock generatedAt makes evidence correctly reject the fixture.
const modelAtDecision = match => {
  const NativeDate = Date;
  global.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [decisionAt])); } static now() { return NativeDate.parse(decisionAt); } };
  try { return predictionSet(match); } finally { global.Date = NativeDate; }
};
let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const row = { sourceMatchId: "form-evidence", homeKey: "alpha", awayKey: "beta", kickoffTime: "2026-09-01T12:00:00Z",
  scoreHome: 0, scoreAway: 1, resultObservedAt: "2026-09-01T14:00:00Z", resultObservationSource: "synthetic-observation" };
check("actual zero score, side counts and distinct clocks are retained", () => {
  const evidence = summarize([row], "alpha", decisionAt);
  assert.equal(evidence.temporalStatus, "clock-recorded");
  assert.equal(evidence.sourceVerified, false);
  assert.equal(evidence.homeRows, 1); assert.equal(evidence.awayRows, 0);
  assert.equal(evidence.latestObservedAt, row.resultObservedAt);
  assert.notEqual(evidence.latestObservedAt, row.kickoffTime);
  assert.match(evidence.selectionHash, /^[a-f0-9]{64}$/);
});
check("missing clocks never fall back to kickoff or decision time", () => {
  const evidence = summarize([{ ...row, resultObservedAt: null }], "beta", decisionAt);
  assert.equal(evidence.latestObservedAt, null); assert.equal(evidence.observedRows, 0);
  assert.equal(evidence.missingObservedAtRows, 1); assert.equal(evidence.temporalStatus, "unverified");
  assert.equal(evidence.awayRows, 1);
});
check("missing source is not source proof", () => assert.equal(summarize([{ ...row, resultObservationSource: null }], "alpha", decisionAt).missingSourceRows, 1));
check("timezone-free and date-only clocks cannot become exact instants", () => {
  for (const value of [null, "", false, 0, "2026-09-01", "2026-09-01T14:00:00"]) assert.equal(summarize([{ ...row, resultObservedAt: value }], "alpha", decisionAt).missingObservedAtRows, 1);
});
for (const value of ["2026-02-29T14:00:00Z", "2026-04-31T14:00:00Z", "1900-02-29T14:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01T14:60:00Z", "2026-09-01T14:00:60Z", "2026-09-01T14:00:00+24:00", "2026-09-01T14:00:00+08:60"]) {
  check(`invalid calendar or clock remains missing: ${value}`, () => {
    const evidence = summarize([{ ...row, resultObservedAt: value }], "alpha", decisionAt);
    assert.equal(evidence.latestObservedAt, null); assert.equal(evidence.observedRows, 0);
    assert.equal(evidence.missingObservedAtRows, 1); assert.equal(evidence.temporalStatus, "unverified");
  });
}
check("invalid decision and kickoff calendars cannot attest temporal eligibility", () => {
  const badDecision = summarize([row], "alpha", "2026-09-31T01:00:00Z");
  assert.equal(badDecision.decisionAt, null); assert.equal(badDecision.temporalStatus, "unverified");
  const badKickoff = summarize([{ ...row, kickoffTime: "2026-08-32T12:00:00Z" }], "alpha", decisionAt);
  assert.equal(badKickoff.beforeKickoffRows, 1); assert.equal(badKickoff.temporalStatus, "conflicting");
});
check("valid leap-day, fractional and explicit-offset clocks retain original representation", () => {
  for (const value of ["2024-02-29T14:00:00Z", "2000-02-29T14:00:00Z", "2026-09-01T22:00:00.123456789+08:00", "2026-09-01T14:00Z"]) {
    const evidence = summarize([{ ...row, kickoffTime: "1999-01-01T12:00:00Z", resultObservedAt: value }], "alpha", decisionAt);
    assert.equal(evidence.latestObservedAt, value); assert.equal(evidence.temporalStatus, "clock-recorded");
  }
});
check("different explicit offsets order by instant rather than lexical timestamp", () => {
  const earlier = { ...row, resultObservedAt: "2026-09-01T22:00:00+08:00" };
  const later = { ...row, resultObservedAt: "2026-09-01T15:00:00Z" };
  assert.equal(summarize([later, earlier], "alpha", decisionAt).latestObservedAt, later.resultObservedAt);
});
check("late observation remains visible and conflicting", () => {
  const evidence = summarize([{ ...row, resultObservedAt: "2026-09-08T01:00:00Z" }], "alpha", decisionAt);
  assert.equal(evidence.afterDecisionRows, 1); assert.equal(evidence.temporalStatus, "conflicting");
});
check("observation at or before kickoff cannot be called eligible", () => {
  const evidence = summarize([{ ...row, resultObservedAt: row.kickoffTime }], "alpha", decisionAt);
  assert.equal(evidence.beforeKickoffRows, 1); assert.equal(evidence.temporalStatus, "conflicting");
});
check("empty history has no fabricated observation", () => {
  const evidence = summarize([], "alpha", decisionAt);
  assert.equal(evidence.temporalStatus, "empty"); assert.equal(evidence.latestObservedAt, null); assert.equal(evidence.sampleRows, 0);
});
check("metadata receipt is deterministic and binds scores without exposing raw records", () => {
  const before = clone(row);
  assert.deepEqual(summarize([row], "alpha", decisionAt), summarize([row], "alpha", decisionAt));
  assert.notEqual(summarize([row], "alpha", decisionAt).selectionHash, summarize([{ ...row, scoreHome: 2 }], "alpha", decisionAt).selectionHash);
  assert.deepEqual(row, before);
  assert.equal(summarize([row], "alpha", decisionAt).selected, undefined);
});

const settled = { sourceMatchId: "actual-form-result", eventVersion: row.kickoffTime, kickoffTime: row.kickoffTime,
  homeTeamName: "Alpha", awayTeamName: "Beta", source: "sporttery", status: "FINISHED", scoreHome: 0, scoreAway: 1,
  resultSource: "sporttery:official-api", sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
  resultObservedAt: row.resultObservedAt, resultObservationSource: "sporttery-relay-endpoint-fetched-at" };
const forecast = { sourceMatchId: "actual-form-forecast", eventVersion: "2026-09-08T12:00:00Z", kickoffTime: "2026-09-08T12:00:00Z",
  status: "SCHEDULED", homeTeamName: "Alpha", awayTeamName: "Beta", predictionMeta: { generatedAt: decisionAt }, odds: { odds1: 2.1, oddsX: 3.3, odds2: 3.4 }, oddsSource: "sporttery:HAD" };
const form = buildFormSnapshots([settled, forecast]).get(forecast.sourceMatchId);
check("actual as-of form builder preserves the observed result clock through aggregation", () => {
  assert.equal(form.home.sampleSize, 1); assert.equal(form.home.goalsForAvg, 0);
  assert.equal(form.home.resultEvidence.observedRows, 1);
  assert.equal(form.home.resultEvidence.latestObservedAt, "2026-09-01T14:00:00.000Z");
  assert.equal(form.away.resultEvidence.awayRows, 1);
});
check("late results remain excluded by the actual timeline, not stamped earlier", () => {
  const late = { ...settled, resultObservedAt: "2026-09-07T02:00:00Z" };
  const output = buildFormSnapshots([late, forecast]).get(forecast.sourceMatchId);
  assert.equal(output.home.sampleSize, 0); assert.equal(output.home.resultEvidence.observedRows, 0);
});
check("historical seed without clocks remains visibly unverified", () => {
  const seed = { version: "synthetic-seed", teams: { alpha: { recent: [{ ...row, resultObservedAt: null, resultObservationSource: null }] }, beta: { recent: [{ ...row, resultObservedAt: null, resultObservationSource: null }] } } };
  const output = buildFormSnapshots([forecast], seed).get(forecast.sourceMatchId);
  assert.equal(output.home.sampleSize, 1); assert.equal(output.home.resultEvidence.missingObservedAtRows, 1);
});
check("actual model, feature capture and frozen public record retain compact metadata", () => {
  const match = { ...forecast, formSnapshot: form };
  match.probabilityModel = modelAtDecision(match).probabilityModel;
  match.predictionMeta = { ...match.predictionMeta, decisionId: "form-result-evidence-test", modelVersion: match.probabilityModel.version, policyVersion: "test" };
  match.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(match, decisionAt);
  match.predictions = [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "X", odds: 3.3, recommendationAction: "reference" }];
  const published = bind(match, null, decisionAt);
  const evidence = published.predictionMeta.publicReferenceDecision.dataGaps.inputSummaries.form.home.resultEvidence;
  assert.equal(evidence.selectionHash, form.home.resultEvidence.selectionHash);
  assert.equal(evidence.sourceVerified, false); assert.equal(evidence.sourceLabels, undefined);
  assert.deepEqual(pending(published).evidence.featureSnapshot.modelInputs.form.home.resultEvidence, form.home.resultEvidence);
});
console.log(JSON.stringify({ ok: true, checks, scope: "selected-row metadata, actual as-of timeline, real model/feature/public capture; synthetic fixtures only", productionDataTouched: false, modelWeightsChanged: false }, null, 2));
