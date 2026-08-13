"use strict";

const assert = require("node:assert/strict");
const {
  buildHitRateAudit,
  wilsonInterval95,
} = require("../server/hitRateAudit.cjs");

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check("empty formal cohort remains collecting and never displays a rate", () => {
  const audit = buildHitRateAudit({
    metrics: { settled: 0, won: 0, lost: 0 },
  });
  assert.equal(audit.status, "collecting");
  assert.equal(audit.sampleReady, false);
  assert.equal(audit.observed.hitRate, null);
  assert.deepEqual(audit.observed.interval95, { lower: null, upper: null });
  assert.equal(audit.observed.flatStakeRoi, null);
  assert.equal(audit.closingLineValue.timingCoverage, null);
  assert.equal(audit.closingLineValue.positiveRate, null);
  assert.equal(audit.closingLineValue.averageProbabilityMove, null);
});

check("external 80 percent claim is never accepted as a training label", () => {
  const audit = buildHitRateAudit({
    metrics: { settled: 800, won: 640, lost: 160 },
  });
  assert.equal(audit.externalBenchmark.claimedRate, 0.8);
  assert.equal(audit.externalBenchmark.verificationStatus, "unverified-external-claim");
  assert.equal(audit.externalBenchmark.usableAsTrainingLabel, false);
});

check("Wilson interval is finite and conservative", () => {
  const interval = wilsonInterval95(80, 100);
  assert.ok(interval.lower > 0.7 && interval.lower < 0.8);
  assert.ok(interval.upper > 0.8 && interval.upper < 0.9);
});

check("small cherry-picked sample cannot pass the benchmark gate", () => {
  const audit = buildHitRateAudit({
    metrics: { settled: 20, won: 20, lost: 0, flatStakeRoi: 0.12 },
  });
  assert.equal(audit.status, "collecting");
  assert.equal(audit.sampleReady, false);
});

check("large near-80 cohort can become credible only with a conservative interval", () => {
  const audit = buildHitRateAudit({
    metrics: { settled: 1000, won: 800, lost: 200, flatStakeRoi: 0.04, avgOdds: 1.35 },
    closingLineValue: {
      version: "closing-line-value-v2",
      rows: 580,
      candidateRows: 1000,
      timingCoverage: 0.58,
      positiveClvRate: 0.58,
      avgProbabilityMove: 0.012,
      timingAudit: {
        version: "closing-line-timing-audit-v1",
        eligibleRows: 580,
        movementMissingRows: 0,
        reasonCounts: { SAME_OBSERVATION: 420 },
      },
    },
  });
  assert.equal(audit.status, "credible-near-target");
  assert.equal(audit.sampleReady, true);
  assert.ok(audit.observed.interval95.lower >= 0.75);
  assert.equal(audit.closingLineValue.version, "closing-line-value-v2");
  assert.equal(audit.closingLineValue.rows, 580);
  assert.equal(audit.closingLineValue.candidateRows, 1000);
  assert.equal(audit.closingLineValue.timingCoverage, 0.58);
  assert.equal(audit.closingLineValue.timingAudit.eligibleRows, 580);
  assert.equal(audit.closingLineValue.timingAudit.reasonCounts.SAME_OBSERVATION, 420);
});

check("complete-denominator and immutable-publication policies are explicit", () => {
  const audit = buildHitRateAudit({
    metrics: { settled: 500, won: 300, lost: 200 },
  });
  assert.ok(audit.denominatorPolicy.includes("reference-live-and-analysis-tracks-excluded"));
  assert.ok(audit.denominatorPolicy.includes("no-retrospective-row-deletion"));
  assert.equal(audit.publicationPolicy.immutableLedgerRequired, true);
  assert.equal(audit.publicationPolicy.completeWinsAndLossesRequired, true);
  assert.equal(audit.publicationPolicy.postCutoffMutationForbidden, true);
});

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  names: checks,
}, null, 2));
