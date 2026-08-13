"use strict";

const assert = require("node:assert/strict");
const { auditRecommendationBias } = require("./auditRecommendationBatchBias.cjs");

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

const clustered = auditRecommendationBias([
  match("a", "1"), match("b", "1"), match("c", "1"),
  match("d", "1"), match("e", "1"), match("f", "2"),
]);
assert.equal(clustered.triggered, true);
assert.equal(clustered.dominantCode, "1");
assert.equal(clustered.cause, "model-or-market-cluster-requires-review");

const coldDraws = auditRecommendationBias([
  match("a", "X", { cold: true }), match("b", "X", { cold: true }),
  match("c", "X", { cold: true }), match("d", "X", { cold: true }),
  match("e", "X", { cold: true }), match("f", "1"),
]);
assert.equal(coldDraws.triggered, true);
assert.equal(coldDraws.cause, "input-degeneracy-cold-start");

console.log(JSON.stringify({ ok: true, verified: [
  "balanced-batch",
  "dominant-direction-warning",
  "cold-start-root-cause",
  "no-artificial-direction-balancing",
] }, null, 2));
