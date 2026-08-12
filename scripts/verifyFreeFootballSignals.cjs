"use strict";

const assert = require("node:assert/strict");
const {
  buildFreeFootballSignal,
  componentUsableBeforeCutoff,
} = require("./syncFreeFootballSignals.cjs");
const { buildQuality } = require("./syncPreMatchSignals.cjs");

const kickoffTime = "2026-08-13T20:00:00+08:00";
const buyEndTime = "2026-08-13 19:30:00";
const baseMatch = {
  id: "sporttery_free_fixture",
  sourceMatchId: "free_fixture",
  kickoffTime,
  buyEndTime,
  homeTeamName: "Home",
  awayTeamName: "Away",
  predictionMeta: {
    cutoffTime: buyEndTime,
    elo: {
      homeRating: 1660,
      awayRating: 1510,
      homeMatches: 30,
      awayMatches: 28,
      historicalSource: { source: "signed-local-history" },
    },
    form: {
      home: { sampleSize: 12, pointsPerMatch: 1.9, goalsForAvg: 1.8 },
      away: { sampleSize: 12, pointsPerMatch: 1.2, goalsForAvg: 1.1 },
    },
    oneXTwo: { poisson: { home: 0.52, draw: 0.27, away: 0.21 } },
    leaguePrior: { matches: 2000 },
  },
};

const preCutoff = {
  sourceObservedAt: "2026-08-13T11:00:00.000Z",
  usableForPreMatch: true,
};
const postCutoff = {
  sourceObservedAt: "2026-08-13T12:00:01.000Z",
  usableForPreMatch: true,
};
assert.equal(componentUsableBeforeCutoff(preCutoff, buyEndTime), true);
assert.equal(componentUsableBeforeCutoff(postCutoff, buyEndTime), false);

const full = buildFreeFootballSignal({
  ...baseMatch,
  odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 },
}, {
  updatedAt: preCutoff.sourceObservedAt,
  bookmakerOdds: {
    had: { odds1: 1.84, oddsX: 3.5, odds2: 4.1, ...preCutoff },
  },
  fiveHundred: {
    recentForm: { home: {}, away: {}, ...preCutoff },
  },
});
assert.equal(full.grade, "A");
assert.equal(full.recommendationReady, true);
assert.equal(full.analysisComplete, true);
assert.equal(full.policy.postCutoffMutationAllowed, false);

const modelOnly = buildFreeFootballSignal(baseMatch, {});
assert.equal(modelOnly.grade, "C");
assert.equal(modelOnly.recommendationReady, true);
assert.equal(modelOnly.market.available, false);
assert.ok(modelOnly.sources.includes("local-history-model"));
const modelOnlyQuality = buildQuality({
  match: baseMatch,
  signal: { freeFootball: modelOnly },
  teamHistory: { home: null, away: null },
});
assert.equal(modelOnlyQuality.recommendationUsable, true);
assert.equal(modelOnlyQuality.components.strength.status, "verified");
assert.equal(modelOnlyQuality.components.form.status, "verified");
assert.equal(modelOnlyQuality.analysisComplete, false);

const postCutoffSupplement = buildFreeFootballSignal(baseMatch, {
  updatedAt: postCutoff.sourceObservedAt,
  bookmakerOdds: {
    had: { odds1: 1.7, oddsX: 3.6, odds2: 4.8, ...postCutoff },
  },
  fiveHundred: {
    recentForm: { home: {}, away: {}, ...postCutoff },
  },
});
assert.equal(postCutoffSupplement.grade, "C");
assert.equal(postCutoffSupplement.market.fiveHundredHad, false);
assert.equal(postCutoffSupplement.supplements.fiveHundredDetails, false);

const leagueFallback = buildFreeFootballSignal({
  id: "sporttery_league_fallback",
  sourceMatchId: "league_fallback",
  kickoffTime,
  buyEndTime,
  predictionMeta: { leaguePrior: { matches: 500 } },
}, {});
assert.equal(leagueFallback.grade, "C");
assert.equal(leagueFallback.recommendationReady, true);

const noEvidence = buildFreeFootballSignal({
  id: "sporttery_no_evidence",
  sourceMatchId: "no_evidence",
  kickoffTime,
  buyEndTime,
}, {});
assert.equal(noEvidence.grade, "D");
assert.equal(noEvidence.recommendationReady, false);

console.log(JSON.stringify({
  ok: true,
  verified: [
    "pre-cutoff-component-timing",
    "complete-free-source-grade",
    "model-only-recommendation-fallback",
    "recommendation-usable-is-separate-from-analysis-complete",
    "post-cutoff-supplement-rejection",
    "league-prior-cold-start",
    "fail-closed-with-no-evidence",
  ],
}, null, 2));
