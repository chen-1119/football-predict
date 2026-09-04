const assert = require("node:assert/strict");
const {
  isWorldCupFinalsMatch,
  dedupeMatches,
  stageForMatch,
  metricsForRows,
  decisionClockForMatch,
  normalizedTrack,
  policyAccepts,
  runWalkForwardPolicySearch,
  buildWorldCupAudit,
} = require("./auditWorldCupHitRate.cjs");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
  evaluateBenchmarkSelection,
} = require("../src/services/benchmarkSelectionPolicy.cjs");

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check("competition identity includes only the World Cup finals", () => {
  assert.equal(isWorldCupFinalsMatch({ leagueName: "\u4e16\u754c\u676f" }), true);
  assert.equal(isWorldCupFinalsMatch({ leagueNameEn: "FIFA World Cup" }), true);
  assert.equal(isWorldCupFinalsMatch({ leagueNameEn: "World Cup - Qualification" }), false);
  assert.equal(isWorldCupFinalsMatch({ leagueNameEn: "World Cup - Women" }), false);
});

check("current and history copies are deduplicated in favor of settled results", () => {
  const rows = dedupeMatches([
    { id: "sporttery_1", sourceMatchId: "1", leagueName: "\u4e16\u754c\u676f", status: "SCHEDULED" },
    { id: "sporttery_1", sourceMatchId: "1", leagueName: "\u4e16\u754c\u676f", status: "FINISHED", scoreHome: 2, scoreAway: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "FINISHED");
});

check("official tournament dates map to non-overlapping stages", () => {
  assert.equal(stageForMatch({ businessDate: "2026-06-27" }), "group");
  assert.equal(stageForMatch({ businessDate: "2026-06-28" }), "r32");
  assert.equal(stageForMatch({ businessDate: "2026-07-04" }), "r16");
  assert.equal(stageForMatch({ businessDate: "2026-07-09" }), "qf");
  assert.equal(stageForMatch({ businessDate: "2026-07-14" }), "sf");
  assert.equal(stageForMatch({ businessDate: "2026-07-18" }), "third");
  assert.equal(stageForMatch({ businessDate: "2026-07-19" }), "final");
});

check("hit rate excludes pending rows and reports priced ROI separately", () => {
  const metrics = metricsForRows([
    { resultStatus: "WON", odds: 2 },
    { resultStatus: "LOST", odds: 2 },
    { resultStatus: "PENDING", odds: 2 },
  ]);
  assert.equal(metrics.settled, 2);
  assert.equal(metrics.hitRate, 0.5);
  assert.equal(metrics.netUnits, 0);
  assert.equal(metrics.roiPercent, 0);
});

check("decision clocks fail closed and require a snapshot strictly before cutoff", () => {
  assert.equal(decisionClockForMatch({
    kickoffTime: "2026-06-12T03:00:00+08:00",
    predictionMeta: {
      cutoffTime: "2026-06-12 02:30:00",
      snapshot: { latestAt: "2026-06-11T18:29:59.000Z" },
    },
  }).eligible, true);
  assert.equal(decisionClockForMatch({
    kickoffTime: "2026-06-12T03:00:00+08:00",
    predictionMeta: {
      cutoffTime: "2026-06-12 02:30:00",
      snapshot: { latestAt: "2026-06-11T18:30:00.000Z" },
    },
  }).eligible, false);
  assert.equal(decisionClockForMatch({ kickoffTime: "2026-06-12T03:00:00+08:00" }).eligible, false);
});

check("live-model is normalized as live and maximum odds are inclusive", () => {
  assert.equal(normalizedTrack({ performanceTrack: "live-model" }), "live");
  assert.equal(policyAccepts({ pools: null, minTrust: 0, maxOdds: 2.1 }, { odds: 2.1 }), true);
  assert.equal(policyAccepts({ pools: null, minTrust: 0, maxOdds: 2.1 }, { odds: 2.11 }), false);
  assert.equal(policyAccepts({ pools: null, minTrust: 0, minOdds: 1.2, maxOdds: 2.1 }, { odds: 1.19 }), false);
  assert.equal(policyAccepts({ pools: null, minTrust: 0, minOdds: 1.2, maxOdds: 2.1 }, { odds: 1.2 }), true);
});

check("benchmark shadow policy is HAD-only and enforces evidence and odds boundaries", () => {
  assert.equal(evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    trustScore: 60,
    odds: 1.85,
  }).qualified, true);
  assert.equal(evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    tipCode: "1",
    trustScore: 80,
    odds: 1.5,
  }).qualified, false);
  assert.equal(evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    trustScore: 59,
    odds: 1.5,
  }).qualified, false);
  assert.equal(evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    trustScore: 70,
    odds: 1.19,
  }).qualified, false);
  assert.equal(evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "1",
    trustScore: 70,
    odds: 1.86,
  }).qualified, false);
  assert.equal(GOODWIN_BENCHMARK_SHADOW_POLICY.role, "shadow-only");
});

check("walk-forward selection is chronological and never uses random splits", () => {
  const rows = Array.from({ length: 72 }, (_, index) => ({
    matchKey: String(index + 1).padStart(3, "0"),
    kickoffTime: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
    resultStatus: index % 3 ? "WON" : "LOST",
    oddsPoolCode: index % 2 ? "HAD" : "HHAD",
    trustScore: index % 2 ? 65 : 45,
    odds: index % 2 ? 1.55 : 2.2,
  }));
  const result = runWalkForwardPolicySearch(rows, { initialTrainingRows: 36, evaluationWindowRows: 9 });
  assert.equal(result.randomSplit, false);
  assert.ok(result.foldCount >= 4);
  assert.equal(result.allFoldsStrictTimeOrder, true);
  assert.ok(result.folds.every((fold) => fold.trainingMaxTime < fold.evaluationMinTime));
});

check("walk-forward folds never split matches with the same kickoff time", () => {
  const rows = Array.from({ length: 70 }, (_, index) => ({
    matchKey: String(index + 1),
    kickoffTime: new Date(Date.UTC(2026, 5, 1, Math.floor(index / 2))).toISOString(),
    resultStatus: index % 3 ? "WON" : "LOST",
    oddsPoolCode: "HAD",
    trustScore: 65,
    odds: 1.7,
  }));
  const result = runWalkForwardPolicySearch(rows, { initialTrainingRows: 25, evaluationWindowRows: 7 });
  assert.ok(result.foldCount >= 4);
  assert.ok(result.folds.every((fold) => fold.trainingMaxTime < fold.evaluationMinTime));
});

check("walk-forward advances when a training window has no eligible policy", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    matchKey: String(index + 1),
    kickoffTime: new Date(Date.UTC(2026, 5, 1, index)).toISOString(),
    resultStatus: index % 2 ? "WON" : "LOST",
    oddsPoolCode: "HAD",
    trustScore: 50,
    odds: 1.7,
  }));
  const result = runWalkForwardPolicySearch(rows, {
    initialTrainingRows: 24,
    evaluationWindowRows: 6,
    policies: [{ id: "no-eligible-rows", pools: ["HAD"], minTrust: 100, maxOdds: 1.2 }],
  });
  assert.equal(result.foldCount, 0);
  assert.equal(result.selectedRows, 0);
});

check("formal BEST and reference BEST remain separate and supporting 1X2 is not double-counted", () => {
  const match = {
    id: "sporttery_1",
    sourceMatchId: "1",
    leagueName: "\u4e16\u754c\u676f",
    status: "FINISHED",
    businessDate: "2026-06-12",
    kickoffTime: "2026-06-12T03:00:00+08:00",
    scoreHome: 1,
    scoreAway: 0,
    predictionMeta: {
      cutoffTime: "2026-06-12 02:30:00",
      snapshot: { latestAt: "2026-06-11T18:00:00.000Z" },
    },
  };
  const report = buildWorldCupAudit({
    historyMatches: [match],
    reviews: [{
      matchId: match.id,
      sourceMatchId: match.sourceMatchId,
      settlement: { publicationVerified: true },
      predictionReview: {
        rows: [
          { marketType: "1X2", resultStatus: "WON", performanceTrack: "reference", oddsPoolCode: "HAD", odds: 1.5 },
          { marketType: "BEST", resultStatus: "WON", performanceTrack: "reference", oddsPoolCode: "HAD", odds: 1.5 },
          { marketType: "BEST", resultStatus: "LOST", performanceTrack: "formal", oddsPoolCode: "HHAD", odds: 2 },
        ],
      },
    }],
  });
  assert.equal(report.headline.formalPrimary.settled, 1);
  assert.equal(report.headline.referencePrimary.settled, 1);
  assert.equal(report.headline.uniqueMarkets.settled, 1);
  assert.equal(report.headline.allReviewRowsDiagnosticOnly.settled, 3);
  assert.equal(report.benchmarkShadow.formalOnlineEffect, false);
  assert.equal(report.benchmarkShadow.status, "collecting");
});

check("late BEST rows stay visible as diagnostics but are excluded from strict hit rate", () => {
  const baseMatch = {
    leagueName: "\u4e16\u754c\u676f",
    status: "FINISHED",
    businessDate: "2026-06-12",
    kickoffTime: "2026-06-12T03:00:00+08:00",
    scoreHome: 1,
    scoreAway: 0,
  };
  const matches = [
    {
      ...baseMatch,
      id: "sporttery_early",
      sourceMatchId: "early",
      predictionMeta: {
        cutoffTime: "2026-06-12 02:30:00",
        snapshot: { latestAt: "2026-06-11T18:00:00.000Z" },
      },
    },
    {
      ...baseMatch,
      id: "sporttery_late",
      sourceMatchId: "late",
      predictionMeta: {
        cutoffTime: "2026-06-12 02:30:00",
        snapshot: { latestAt: "2026-06-11T18:31:00.000Z" },
      },
    },
  ];
  const reviews = matches.map((match) => ({
    matchId: match.id,
    sourceMatchId: match.sourceMatchId,
    predictionReview: { rows: [{
      marketType: "BEST",
      resultStatus: "WON",
      performanceTrack: "reference",
      oddsPoolCode: "HAD",
      odds: 1.5,
    }] },
  }));
  const report = buildWorldCupAudit({ historyMatches: matches, reviews });
  assert.equal(report.headline.referencePrimary.settled, 1);
  assert.equal(report.headline.referencePrimaryRawDiagnostic.settled, 2);
  assert.equal(report.data.excludedPrimaryRows, 1);
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "world-cup-hit-rate-audit",
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks,
}, null, 2)}\n`);
