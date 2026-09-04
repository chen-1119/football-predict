"use strict";

const assert = require("node:assert/strict");
const {
  FORMAL_REVIEW_PERFORMANCE_START_DATE,
  FORMAL_REVIEW_PERFORMANCE_VERSION,
  buildFormalReviewPerformance,
  compactFormalReviewPerformance,
} = require("../server/reviewPerformanceSummary.cjs");

const formalMatch = ({ id, date, status, track = "formal", action = "recommend", role = "main", marketType = "BEST" }) => ({
  id,
  sourceMatchId: id,
  businessDate: date,
  status: "FINISHED",
  postMatchReview: {
    predictionReview: {
      formalBestStatus: status,
      rows: [{
        marketType,
        performanceTrack: track,
        recommendationAction: action,
        reviewRole: role,
        resultStatus: status,
      }],
    },
  },
});

const rows = [
  formalMatch({ id: "before", date: "2026-08-15", status: "WON" }),
  formalMatch({ id: "a", date: "2026-08-16", status: "WON" }),
  formalMatch({ id: "b", date: "2026-08-16", status: "LOST" }),
  formalMatch({ id: "c", date: "2026-08-17", status: "WON" }),
  formalMatch({ id: "c", date: "2026-08-17", status: "WON" }),
  formalMatch({ id: "reference", date: "2026-08-17", status: "WON", track: "reference" }),
  formalMatch({ id: "live", date: "2026-08-17", status: "WON", track: "live-model" }),
  formalMatch({ id: "not-best", date: "2026-08-17", status: "WON", marketType: "1X2" }),
  formalMatch({ id: "not-main", date: "2026-08-17", status: "WON", role: "reference" }),
  formalMatch({ id: "not-recommend", date: "2026-08-17", status: "WON", action: "watch" }),
];

const summary = buildFormalReviewPerformance({
  matches: rows,
  generatedAt: "2026-08-17T12:00:00.000Z",
});

assert.equal(summary.version, FORMAL_REVIEW_PERFORMANCE_VERSION);
assert.equal(summary.startDate, FORMAL_REVIEW_PERFORMANCE_START_DATE);
assert.deepEqual(summary.cumulative, {
  date: null,
  won: 2,
  lost: 1,
  settled: 3,
  hitRate: 2 / 3,
});
assert.deepEqual(summary.daily, [
  { date: "2026-08-16", won: 1, lost: 1, settled: 2, hitRate: 0.5 },
  { date: "2026-08-17", won: 1, lost: 0, settled: 1, hitRate: 1 },
]);
assert.equal(summary.exclusions.beforeStart, 1);
assert.equal(summary.exclusions.duplicateEvent, 1);
assert.equal(summary.exclusions.withoutFrozenFormalSettlement, 5);

assert.deepEqual(compactFormalReviewPerformance(summary)?.cumulative, {
  won: 2,
  lost: 1,
  settled: 3,
  hitRate: 2 / 3,
});
assert.equal(compactFormalReviewPerformance({ ...summary, cumulative: { won: 2, lost: 1, settled: 4 } }), null);

console.log(JSON.stringify({
  ok: true,
  version: FORMAL_REVIEW_PERFORMANCE_VERSION,
  startDate: FORMAL_REVIEW_PERFORMANCE_START_DATE,
  checks: 11,
  passed: 11,
}, null, 2));
