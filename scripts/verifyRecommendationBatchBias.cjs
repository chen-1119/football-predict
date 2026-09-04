"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { auditRecommendationBias } = require("./auditRecommendationBatchBias.cjs");
const {
  evidenceAwareIndependentProbabilities,
  independentBaseLambdas,
} = require("./syncData.cjs");

const match = (id, code, { cold = false } = {}) => ({
  id,
  status: "SCHEDULED",
  predictions: [{ marketType: "BEST", tipCode: code }],
  predictionMeta: {
    elo: { homeMatches: cold ? 0 : 20, awayMatches: cold ? 0 : 20 },
    form: {
      home: { sampleSize: cold ? 0 : 10 },
      away: { sampleSize: cold ? 0 : 10 },
    },
  },
});

const balanced = auditRecommendationBias([
  match("a", "1"), match("b", "X"), match("c", "2"),
  match("d", "1"), match("e", "X"), match("f", "2"),
]);
assert.equal(balanced.triggered, false);
assert.equal(balanced.policy.mutatesRecommendationDirection, false);
assert.equal(balanced.publicationBlocked, false);

const clustered = auditRecommendationBias([
  match("a", "1"), match("b", "1"), match("c", "1"),
  match("d", "1"), match("e", "1"), match("f", "2"),
]);
assert.equal(clustered.triggered, true);
assert.equal(clustered.dominantCode, "1");
assert.equal(clustered.cause, "model-or-market-cluster-requires-review");
assert.equal(clustered.publicationBlocked, false,
  "complete but lopsided evidence is reviewed, not artificially rebalanced");

const productionShapedCold = (id, code) => ({
  id,
  status: "SCHEDULED",
  predictions: [{ marketType: "BEST", tipCode: code }],
  predictionMeta: {
    featureSnapshot: {
      modelInputs: {
        elo: { homeMatches: 0, awayMatches: 0 },
        form: { home: { sampleSize: 0 }, away: { sampleSize: 0 } },
        oneXTwoFinal: { home: 0.448, draw: 0.252, away: 0.3 },
      },
    },
  },
});
const productionShapedColdAudit = auditRecommendationBias([
  productionShapedCold("p1", "1"), productionShapedCold("p2", "1"),
  productionShapedCold("p3", "1"), productionShapedCold("p4", "1"),
  productionShapedCold("p5", "1"), match("p6", "2"),
]);
assert.equal(productionShapedColdAudit.coldStartRows, 5,
  "the batch gate must read the production featureSnapshot input path");
assert.equal(productionShapedColdAudit.repeatedProbabilityTriggered, true,
  "the batch gate must read production-shaped probability signatures");
assert.equal(productionShapedColdAudit.publicationBlocked, true);

const productionShapedOneSided = auditRecommendationBias([
  ...["s1", "s2", "s3", "s4", "s5"].map((id) => ({
    ...productionShapedCold(id, "1"),
    predictionMeta: {
      featureSnapshot: {
        modelInputs: {
          elo: { homeMatches: 800, awayMatches: 0 },
          form: { home: { sampleSize: 12 }, away: { sampleSize: 0 } },
          oneXTwoFinal: { home: 0.46, draw: 0.27, away: 0.27 },
        },
      },
    },
  })),
  match("s6", "2"),
]);
assert.equal(productionShapedOneSided.coldStartRows, 5,
  "one-sided Elo and form must remain input-degenerate instead of inheriting a neutral opponent");
assert.equal(productionShapedOneSided.publicationBlocked, true);

const marketCopy = auditRecommendationBias([
  { ...match("m1", "1"), odds: { odds1: 1.7, oddsX: 3.6, odds2: 4.8 } },
  { ...match("m2", "2"), odds: { odds1: 4.1, oddsX: 3.4, odds2: 1.8 } },
  { ...match("m3", "1"), odds: { odds1: 1.9, oddsX: 3.3, odds2: 3.9 } },
  { ...match("m4", "2"), odds: { odds1: 3.8, oddsX: 3.5, odds2: 1.85 } },
  { ...match("m5", "1"), odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 } },
]);
assert.equal(marketCopy.marketLeaderAgreementTriggered, true,
  "a slate that exactly copies market leaders must be visible in diagnostics");
assert.equal(marketCopy.publicationBlocked, false,
  "market agreement alone is diagnostic and must not force artificial direction changes");

const marketConflict = auditRecommendationBias([
  ...["a", "b", "c", "d", "e"].map((id) => ({
    ...match(id, "1"),
    odds: { odds1: 4.2, oddsX: 3.5, odds2: 1.65 },
  })),
  { ...match("f", "2"), odds: { odds1: 3.8, oddsX: 3.4, odds2: 1.72 } },
]);
assert.equal(marketConflict.directionTriggered, true);
assert.equal(marketConflict.dominantMarketConflictTriggered, true);
assert.equal(marketConflict.publicationBlocked, true,
  "an extreme model direction that repeatedly opposes a complete market slate must fail closed");
assert.ok(marketConflict.blockingReasons.includes("dominant-direction-opposes-market-cluster"));

const withheldMarketConflict = auditRecommendationBias([
  ...["a", "b", "c", "d", "e"].map((id) => ({
    ...match(id, "1"),
    predictions: [{ marketType: "BEST", tipCode: "WATCH", recommendationAction: "reference" }],
    probabilityModel: { unifiedPosterior: { selectedCode: "1" } },
    odds: { odds1: 4.2, oddsX: 3.5, odds2: 1.65 },
  })),
  { ...match("f", "2"), odds: { odds1: 3.8, oddsX: 3.4, odds2: 1.72 } },
]);
assert.equal(withheldMarketConflict.rows, 1,
  "WATCH rows must retain their internal posterior without re-entering the public BEST cohort");
assert.equal(withheldMarketConflict.publicationBlocked, false,
  "a fail-closed WATCH downgrade must not be revived into a batch publication blocker");

const eloLed = evidenceAwareIndependentProbabilities({
  homeTeam: "Home",
  awayTeam: "Away",
  eloSnapshot: {
    homeMatches: 120,
    awayMatches: 120,
    probabilities: { home: 0.27, draw: 0.27, away: 0.46 },
  },
});
assert.ok(eloLed.away > eloLed.home,
  "complete Elo evidence must lead the independent seed instead of the generic home prior");
const eloLambdas = independentBaseLambdas({}, eloLed);
assert.ok(eloLambdas.awayLambda > eloLambdas.homeLambda,
  "an Elo-led away advantage must reach the Poisson expected-goal seed");

const coldDraws = auditRecommendationBias([
  match("a", "X", { cold: true }), match("b", "X", { cold: true }),
  match("c", "X", { cold: true }), match("d", "X", { cold: true }),
  match("e", "X", { cold: true }), match("f", "1"),
]);
assert.equal(coldDraws.triggered, true);
assert.equal(coldDraws.cause, "input-degeneracy-cold-start");
assert.equal(coldDraws.publicationBlocked, true);
assert.ok(coldDraws.blockingReasons.includes("dominant-direction-with-cold-start-majority"));

const repeatedProbabilities = auditRecommendationBias([
  ...["a", "b", "c", "d"].map((id, index) => ({
    ...match(id, index % 2 ? "1" : "X", { cold: true }),
    probabilityModel: { oneXTwo: { final: { home: 44.8, draw: 25.2, away: 30 } } },
  })),
  {
    ...match("e", "2", { cold: true }),
    probabilityModel: { oneXTwo: { final: { home: 30, draw: 25, away: 45 } } },
  },
]);
assert.equal(repeatedProbabilities.repeatedProbabilityTriggered, true);
assert.equal(repeatedProbabilities.maxRepeatedProbabilityRows, 4);
assert.equal(repeatedProbabilities.cause, "input-degeneracy-repeated-probabilities");
assert.equal(repeatedProbabilities.publicationBlocked, true);
assert.ok(repeatedProbabilities.blockingReasons.includes("repeated-probability-cluster"));

const syncSource = fs.readFileSync(path.join(__dirname, "syncData.cjs"), "utf8");
assert.match(syncSource, /auditRecommendationBias\(prospectiveAuditMatches/,
  "the fail-closed audit must inspect the freshly generated candidate slate before persistence");
assert.match(syncSource, /if \(recommendationBiasAudit\.publicationBlocked\)/,
  "input degeneracy must block the sync before it can publish a new generation");
assert.match(syncSource, /cohort: "prospective-pre-persistence"/,
  "the audit record must disclose that it evaluated prospective candidate decisions");

console.log(JSON.stringify({ ok: true, verified: [
  "balanced-batch",
  "dominant-direction-warning",
  "cold-start-root-cause",
  "production-feature-snapshot-cold-start",
  "production-one-sided-input-degeneracy",
  "repeated-probability-cluster-warning",
  "market-copy-cluster-diagnostic",
  "input-degeneracy-publication-block",
  "dominant-market-conflict-publication-block",
  "watch-downgrade-stays-outside-public-best-cohort",
  "elo-led-poisson-seed",
  "prospective-pre-persistence-wiring",
  "no-artificial-direction-balancing",
] }, null, 2));
