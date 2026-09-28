"use strict";
const assert = require("node:assert/strict");
const { buildGoalFitEvidence, fitJointGoalRates, verifyJointGoalFit } = require("../src/services/jointGoalFit.cjs");
const { verifyModelInputUsage, summarizeModelInputUsage } = require("../src/services/modelInputUsage.cjs");
const { buildInputEvidence, validInputEvidence } = require("../src/services/recommendationInputEvidence.cjs");
const { predictionSet, predictionSetWithoutOfficialOdds } = require("./syncData.cjs");

const at = "2026-09-27T12:00:00Z";
const fixture = () => ({ sourceMatchId: "joint-goal-fixture", kickoffTime: "2099-09-29T12:00:00Z",
  status: "SCHEDULED", homeTeam: "Synthetic Home", awayTeam: "Synthetic Away",
  homeTeamName: "Synthetic Home", awayTeamName: "Synthetic Away", leagueName: "Synthetic League",
  odds: { odds1: 2.2, oddsX: 3.3, odds2: 3.2 }, oddsSource: "sporttery:HAD" });
const history = (homeXg = 2.1, awayXg = 0.65) => Array.from({ length: 12 }, (_, n) => [
  { team: "Synthetic Home", opponent: `Home Opponent ${n}`, xg: homeXg, xga: 0.8, scoreHome: n < 9 ? 3 : 1, scoreAway: 0 },
  { team: "Synthetic Away", opponent: `Away Opponent ${n}`, xg: awayXg, xga: 1.9, scoreHome: n < 3 ? 3 : 0, scoreAway: 0 },
]).flat().map((row, n) => ({ status: "FINISHED", sourceMatchId: `past-${n}`,
  homeTeamName: row.team, awayTeamName: row.opponent,
  kickoffTime: new Date(Date.parse("2026-08-01T12:00:00Z") + n * 86400000).toISOString(),
  resultObservedAt: new Date(Date.parse("2026-08-01T12:00:00Z") + n * 86400000 + 7200000).toISOString(),
  resultProvenance: { source: "test-result-receipt" }, scoreHome: row.scoreHome, scoreAway: row.scoreAway,
  stats: { observed: true, source: "test-post-match-statistics", observedAt: new Date(Date.parse("2026-08-01T12:00:00Z") + n * 86400000 + 10800000).toISOString(),
    xG: { home: row.xg, away: row.xga } } }));
const base = fixture();
const evidence = buildGoalFitEvidence(history(), base, at);
assert.ok(evidence);
const match = { ...base, externalSignals: { goalFitEvidence: evidence } };
const fit = fitJointGoalRates(match, 1.3, 1.15, at);
assert.ok(fit && verifyJointGoalFit(fit, match, at));
assert.ok(fit.output.home > 1.3 && fit.output.away < 1.15);
assert.ok(fit.over25Probability > 0 && fit.over25Probability < 1);
assert.equal(fitJointGoalRates(base, 1.3, 1.15, at), null);
assert.equal(fitJointGoalRates(match, 1.3, 1.15, "2026-08-01T12:00:00Z"), null);
assert.equal(buildGoalFitEvidence(history().map(row => ({ ...row, stats: { ...row.stats, observedAt: null } })), base, at), null);
assert.equal(buildGoalFitEvidence(history().map(row => ({ ...row, stats: { ...row.stats, source: "api-football:shadow" } })), base, at), null);
assert.equal(buildGoalFitEvidence(history().map(row => ({ ...row, resultObservedAt: "2026-09-28T12:00:00Z" })), base, at), null);
assert.equal(buildGoalFitEvidence(history().map(row => ({ ...row, resultObservationFallback: true })), base, at), null);
assert.equal(buildGoalFitEvidence(history().slice(0, 12), base, at), null);
const wrongEvent = { ...match, sourceMatchId: "other-event" };
assert.equal(fitJointGoalRates(wrongEvent, 1.3, 1.15, at), null);
const changed = structuredClone(match);
changed.externalSignals.goalFitEvidence.rows[0].homeXg = 7;
assert.equal(fitJointGoalRates(changed, 1.3, 1.15, at), null);
const noEvidence = predictionSet(base).probabilityModel;
const applied = predictionSet(match).probabilityModel;
assert.equal(noEvidence.baseModelVersion, "independent-elo-form-poisson-v13");
assert.equal(applied.baseModelVersion, "independent-elo-form-poisson-v14-joint-goals");
assert.equal(applied.inputUsage.length, noEvidence.inputUsage.length + 1);
assert.ok(applied.inputUsage.every(verifyModelInputUsage));
assert.ok(summarizeModelInputUsage(applied, match).rows.some(row => row.key === "observedXg"));
assert.ok(summarizeModelInputUsage(applied, match).rows.some(row => row.key === "historicalOver25"));
const inputEvidence = buildInputEvidence(applied, match);
assert.ok(inputEvidence && validInputEvidence(inputEvidence, applied, match));
assert.notEqual(inputEvidence.arithmetic.status, "invalid");
const lambdas = applied.calculationTrace.poisson.lambdas;
const over25 = 1 - Math.exp(-lambdas.home - lambdas.away)
  * (1 + lambdas.home + lambdas.away + (lambdas.home + lambdas.away) ** 2 / 2);
assert.ok(Math.abs(over25 - applied.lambdaBlend.jointGoalFit.over25Probability) < 0.007);
assert.notEqual(applied.goalLines.over25, noEvidence.goalLines.over25);
const noOdds = { ...match, odds: null };
const modelOnly = predictionSetWithoutOfficialOdds(noOdds).probabilityModel;
assert.equal(modelOnly.baseModelVersion, "model-only-no-official-sp-v5-joint-goals");
assert.ok(modelOnly.inputUsage.some(row => row.stage === "joint-goal-fit"));
console.log("joint-goal-fit: observed xG and historical 2.5 goals applied, bounded and clock-gated in both paths");
