const assert = require("node:assert/strict");
const {
  normalizeProbabilityTriplet,
  marketProbabilityTripletFor,
  summarizeProbabilityRows,
  compareMetrics,
  buildSnapshotIndex,
  findPreMatchSnapshotFor,
  buildOddsIndex,
  findLatestOddsBefore,
  buildWorldCupModelRegression,
} = require("./auditWorldCupModelRegression.cjs");

const checks = [];
const check = (name, run) => {
  run();
  checks.push(name);
};

check("percent and unit probability triplets normalize identically", () => {
  assert.deepEqual(normalizeProbabilityTriplet({ home: 50, draw: 30, away: 20 }), { "1": 0.5, X: 0.3, "2": 0.2 });
  assert.deepEqual(normalizeProbabilityTriplet({ "1": 0.5, X: 0.3, "2": 0.2 }), { "1": 0.5, X: 0.3, "2": 0.2 });
});

check("market baseline removes the overround", () => {
  const probabilities = marketProbabilityTripletFor({ odds1: 2, oddsX: 4, odds2: 4 });
  assert.equal(Number(Object.values(probabilities).reduce((sum, value) => sum + value, 0).toFixed(8)), 1);
  assert.equal(probabilities["1"], 0.5);
});

check("classification metrics expose zero draw recall and class imbalance", () => {
  const metrics = summarizeProbabilityRows([
    { actual: "1", probabilities: { "1": 0.6, X: 0.2, "2": 0.2 } },
    { actual: "X", probabilities: { "1": 0.45, X: 0.4, "2": 0.15 } },
    { actual: "2", probabilities: { "1": 0.1, X: 0.2, "2": 0.7 } },
  ]);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.drawRecall, 0);
  assert.equal(metrics.actualDistribution.X, 1);
  assert.equal(metrics.pickDistribution.X, 0);
  assert.ok(metrics.brier > 0);
  assert.ok(metrics.logLoss > 0);
});

check("comparison requires accuracy, Brier and log loss to all be non-worse", () => {
  const comparison = compareMetrics(
    { rows: 10, accuracy: 0.6, brier: 0.5, logLoss: 0.9 },
    { rows: 10, accuracy: 0.6, brier: 0.49, logLoss: 0.88 },
  );
  assert.equal(comparison.modelNonWorseOnAllCoreMetrics, false);
  assert.ok(comparison.brierImprovement < 0);
});

check("snapshot selection excludes review and post-kickoff rows", () => {
  const match = {
    id: "sporttery_1",
    sourceMatchId: "1",
    kickoffTime: "2026-06-12T03:00:00+08:00",
    predictionMeta: { cutoffTime: "2026-06-12 02:30:00" },
  };
  const snapshots = [
    { sourceMatchId: "1", capturedAt: "2026-06-11T18:00:00.000Z", phase: "late", probabilityFinal: { home: 60, draw: 20, away: 20 } },
    { sourceMatchId: "1", capturedAt: "2026-06-11T20:00:00.000Z", phase: "review", probabilityFinal: { home: 10, draw: 10, away: 80 } },
    { sourceMatchId: "1", capturedAt: "2026-06-11T20:30:00.000Z", phase: "late", probabilityFinal: { home: 10, draw: 10, away: 80 } },
    { sourceMatchId: "1", capturedAt: "2026-06-11T18:31:00.000Z", phase: "late", probabilityFinal: { home: 10, draw: 80, away: 10 } },
  ];
  const selected = findPreMatchSnapshotFor(match, buildSnapshotIndex(snapshots));
  assert.equal(selected.snapshot.capturedAt, "2026-06-11T18:00:00.000Z");
});

check("market pairing never reads odds after the forecast timestamp", () => {
  const match = { id: "sporttery_1", sourceMatchId: "1" };
  const rows = [
    { sourceMatchId: "1", poolCode: "HAD", capturedAt: "2026-06-11T17:00:00.000Z", odds1: 2, oddsX: 3, odds2: 4 },
    { sourceMatchId: "1", poolCode: "HAD", capturedAt: "2026-06-11T19:00:00.000Z", odds1: 1.5, oddsX: 4, odds2: 6 },
  ];
  const selected = findLatestOddsBefore(match, buildOddsIndex(rows), Date.parse("2026-06-11T18:00:00.000Z"));
  assert.equal(selected.row.odds1, 2);
});

check("World Cup report separates diagnostic metrics from promotion eligibility", () => {
  const match = {
    id: "sporttery_1",
    sourceMatchId: "1",
    leagueName: "\u4e16\u754c\u676f",
    status: "FINISHED",
    businessDate: "2026-06-11",
    kickoffTime: "2026-06-12T03:00:00+08:00",
    scoreHome: 1,
    scoreAway: 1,
    predictionMeta: { lockedAt: "2026-06-11T18:00:00.000Z", cutoffTime: "2026-06-12 02:30:00" },
  };
  const report = buildWorldCupModelRegression({
    historyMatches: [match],
    predictionSnapshots: [{
      sourceMatchId: "1",
      capturedAt: "2026-06-11T18:00:00.000Z",
      phase: "late",
      probabilityFinal: { home: 60, draw: 20, away: 20 },
      odds: { odds1: 2, oddsX: 3, odds2: 4 },
    }],
    modelEvaluation: { sample: { promotionProbabilityRows: 0 } },
  });
  assert.equal(report.model.rows, 1);
  assert.equal(report.model.drawRecall, 0);
  assert.equal(report.promotionGate.eligible, false);
  assert.ok(report.promotionGate.blockers.includes("draw-recall-zero"));
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "world-cup-model-regression",
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks,
}, null, 2)}\n`);
