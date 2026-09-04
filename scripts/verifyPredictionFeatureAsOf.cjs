const assert = require("assert");
const {
  buildPredictionFeatureSnapshot,
  candidateExternalMarketEvidence,
  oddsTrendForMatch,
} = require("./syncData.cjs");

const baseMatch = (externalUpdatedAt) => ({
  id: "sporttery_asof-test",
  source: "sporttery",
  sourceMatchId: "asof-test",
  kickoffTime: "2026-07-01T22:00:00+08:00",
  buyEndTime: "2026-07-01 19:00:00",
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  oddsSource: "sporttery:HAD",
  probabilityModel: {
    version: "asof-test-model",
    generatedAt: "2026-07-01T12:00:00.000Z",
    oneXTwo: {
      final: { home: 40, draw: 30, away: 30 },
      market: { home: 42, draw: 28, away: 30 },
      poisson: { home: 39, draw: 31, away: 30 },
    },
  },
  externalSignals: {
    updatedAt: externalUpdatedAt,
    fiveHundred: {
      source: "500.com",
      updatedAt: externalUpdatedAt,
      europeOdds: {
        companies: 24,
        currentAverage: { odds1: 2.08, oddsX: 3.18, odds2: 3.36 },
        initialAverage: { odds1: 2.2, oddsX: 3.1, odds2: 3.25 },
        currentProbabilityAverage: { home: 0.43, draw: 0.28, away: 0.29 },
        official: {
          currentProbability: { home: 0.44, draw: 0.28, away: 0.28 },
          initialProbability: { home: 0.41, draw: 0.29, away: 0.3 },
          returnRateCurrent: 91.2,
          kellyCurrent: { odds1: 0.87, oddsX: 0.9, odds2: 1.02 },
        },
      },
      asianHandicap: {
        companies: 16,
        currentAverageLine: -0.75,
        initialAverageLine: -0.5,
        lineMovement: -0.25,
      },
      marketConsensus: { riskLevel: "low" },
    },
  },
});

const postCutoff = buildPredictionFeatureSnapshot(baseMatch("2026-07-01T11:30:00.000Z"));
assert.equal(postCutoff.market.external.capturedBeforeCutoff, false);
assert.equal(postCutoff.market.external.usableForModel, false);
assert.equal(postCutoff.market.external.cutoffAt, "2026-07-01T11:00:00.000Z");
assert.deepEqual(postCutoff.market.external.europe.officialKellyCurrent, {
  odds1: 0.87,
  oddsX: 0.9,
  odds2: 1.02,
});

const incompleteKellyMatch = baseMatch("2026-07-01T10:30:00.000Z");
incompleteKellyMatch.externalSignals.fiveHundred.europeOdds.official.kellyCurrent.oddsX = null;
assert.equal(
  buildPredictionFeatureSnapshot(incompleteKellyMatch).market.external.europe.officialKellyCurrent,
  null
);

const fresh = buildPredictionFeatureSnapshot(baseMatch("2026-07-01T10:30:00.000Z"));
assert.equal(fresh.market.external.capturedBeforeCutoff, true);
assert.equal(fresh.market.external.freshAsOf, true);
assert.equal(fresh.market.external.usableForModel, true);

const stale = buildPredictionFeatureSnapshot(baseMatch("2026-06-27T10:30:00.000Z"));
assert.equal(stale.market.external.capturedBeforeCutoff, true);
assert.equal(stale.market.external.freshAsOf, false);
assert.equal(stale.market.external.usableForModel, false);

const externalEvidence = candidateExternalMarketEvidence(
  baseMatch("2026-07-01T11:30:00.000Z"),
  { market: "HAD", code: "1" },
  "2026-07-01T12:00:00.000Z"
);
assert.equal(externalEvidence.available, false);
assert.equal(externalEvidence.reason, "post-cutoff-external-market");

const hhadExternalEvidence = candidateExternalMarketEvidence(
  baseMatch("2026-07-01T10:30:00.000Z"),
  { market: "HHAD", code: "1" },
  "2026-07-01T10:45:00.000Z"
);
assert.equal(hhadExternalEvidence.available, false);
assert.equal(hhadExternalEvidence.reason, "external-had-market-not-hhad-outcome-evidence");

const trend = oddsTrendForMatch(baseMatch("2026-07-01T10:30:00.000Z"), [
  { sourceMatchId: "asof-test", capturedAt: "2026-07-01T10:00:00.000Z", odds1: 2.2, oddsX: 3.1, odds2: 3.25 },
  { sourceMatchId: "asof-test", capturedAt: "2026-07-01T10:30:00.000Z", odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  { sourceMatchId: "asof-test", capturedAt: "2026-07-01T11:30:00.000Z", odds1: 1.8, oddsX: 3.5, odds2: 4.1 },
]);
assert.equal(trend.sampleSize, 2);
assert.equal(trend.lastCapturedAt, "2026-07-01T10:30:00.000Z");
assert.equal(trend.cutoffAt, "2026-07-01T11:00:00.000Z");
assert.equal(trend.odds1Change, -0.1);

console.log("prediction-feature-asof-ok");
