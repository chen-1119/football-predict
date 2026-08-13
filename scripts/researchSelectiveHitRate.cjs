const {
  loadAuditInputs,
  dedupeMatches,
  reviewRowsForMatches,
  runWalkForwardPolicySearch,
} = require("./auditWorldCupHitRate.cjs");

const inputs = loadAuditInputs();
const matches = dedupeMatches([...inputs.currentMatches, ...inputs.historyMatches]);
const rows = reviewRowsForMatches(matches, inputs.reviews)
  .filter((row) => (
    row.marketType === "BEST"
    && row.clockEligible
    && row.track === "reference"
  ));

const policies = [];
for (const minTrust of [0, 50, 55, 60, 65, 70]) {
  for (const maxOdds of [1.3, 1.35, 1.4, 1.45, 1.55, 1.6, 1.7, 1.85, 2.1, Infinity]) {
    policies.push({
      id: `had-trust-${minTrust}-odds-${Number.isFinite(maxOdds) ? maxOdds : "any"}`,
      pools: ["HAD"],
      minTrust,
      maxOdds,
    });
  }
}

const reports = policies
  .map((policy) => ({
    policy,
    ...runWalkForwardPolicySearch(rows, {
      policies: [policy],
      minTrainingSelectedRows: 5,
      minTrainingCoverage: 0.08,
    }),
  }))
  .filter((report) => report.foldCount >= 3 && report.selectedRows >= 5)
  .sort((left, right) => (
    (right.candidateMetrics.hitRate ?? 0) - (left.candidateMetrics.hitRate ?? 0)
    || right.selectedRows - left.selectedRows
  ));

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocol: "fixed-policy-expanding-window-screen-v1",
  rows: rows.length,
  candidates: reports.map((report) => ({
    id: report.policy.id,
    foldCount: report.foldCount,
    selectedRows: report.selectedRows,
    coveragePercent: report.coveragePercent,
    hitRatePercent: report.candidateMetrics.hitRatePercent,
    confidence95Percent: report.candidateMetrics.confidence95Percent,
    roiPercent: report.candidateMetrics.roiPercent,
    improvingFolds: report.improvingFolds,
    baselineHitRatePercent: report.baselineMetrics.hitRatePercent,
  })),
}, null, 2)}\n`);
