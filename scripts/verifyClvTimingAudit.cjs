"use strict";

const assert = require("node:assert/strict");
const {
  CLV_TIMING_AUDIT_VERSION,
  assessClvTiming,
  summarizeClvRows,
} = require("../src/services/clvTimingAudit.cjs");

const kickoffTime = "2026-07-27T12:00:00.000Z";
const makeRow = (overrides = {}) => ({
  matchId: "sporttery_1",
  kickoffTime,
  forecastOddsCapturedAt: "2026-07-27T10:00:00.000Z",
  closingOddsCapturedAt: "2026-07-27T11:50:00.000Z",
  clvProbabilityMove: 0.03,
  clvOddsRatioMove: 0.04,
  ...overrides,
});

const valid = assessClvTiming(makeRow());
assert.equal(valid.version, CLV_TIMING_AUDIT_VERSION);
assert.equal(valid.eligible, true);
assert.equal(valid.observationGapSeconds, 6_600);
assert.equal(valid.closingLeadSeconds, 600);

assert.equal(assessClvTiming(makeRow({
  closingOddsCapturedAt: "2026-07-27T10:00:00.000Z",
})).reason, "SAME_OBSERVATION");
assert.equal(assessClvTiming(makeRow({
  closingOddsCapturedAt: "2026-07-27T09:59:00.000Z",
})).reason, "CLOSING_BEFORE_FORECAST");
assert.equal(assessClvTiming(makeRow({
  closingOddsCapturedAt: "2026-07-27T12:01:00.000Z",
})).reason, "CLOSING_AFTER_KICKOFF");
assert.equal(assessClvTiming(makeRow({
  forecastOddsCapturedAt: null,
})).reason, "FORECAST_CLOCK_INVALID");

const summary = summarizeClvRows([
  makeRow(),
  makeRow({
    matchId: "sporttery_2",
    closingOddsCapturedAt: "2026-07-27T10:00:00.000Z",
    clvProbabilityMove: 0,
    clvOddsRatioMove: 0,
  }),
  makeRow({
    matchId: "sporttery_3",
    clvProbabilityMove: -0.02,
    clvOddsRatioMove: -0.01,
  }),
  makeRow({
    matchId: "sporttery_4",
    clvProbabilityMove: null,
    clvOddsRatioMove: null,
  }),
]);

assert.equal(summary.version, "closing-line-value-v2");
assert.equal(summary.candidateRows, 4);
assert.equal(summary.rows, 2);
assert.equal(summary.timingCoverage, 0.5);
assert.equal(summary.positiveClvRate, 0.5);
assert.deepEqual(summary.directionCounts, {
  positive: 1,
  flat: 0,
  negative: 1,
});
assert.equal(summary.timingAudit.reasonCounts.SAME_OBSERVATION, 1);
assert.equal(summary.timingAudit.movementMissingRows, 1);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "clv-timing-audit",
  version: CLV_TIMING_AUDIT_VERSION,
  assertions: 16,
  sample: summary,
}, null, 2)}\n`);
