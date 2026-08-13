"use strict";

const GOODWIN_BENCHMARK_SHADOW_POLICY = Object.freeze({
  version: "goodwin-benchmark-prospective-shadow-v2",
  activatedAt: "2026-07-26T22:00:00.000Z",
  marketType: "BEST",
  oddsPoolCode: "HAD",
  minimumEvidenceScore: 60,
  minimumOdds: 1.2,
  maximumOdds: 1.85,
  targetHitRate: 0.8,
  hitRateDisclosureOnly: true,
  decisionOffsetMinutes: 10,
  maximumSnapshotStalenessMinutes: 30,
  maximumIngestLagMinutes: 5,
  reviewCheckpoints: Object.freeze([200, 300, 450, 700, 1050]),
  minimumSettledRowsForPromotionReview: 200,
  minimumChronologicalFolds: 6,
  minimumRowsPerWindow: 15,
  maximumSingleWindowShare: 0.35,
  minimumCalendarDays: 42,
  maximumAbsoluteSpiegelhalterZ: 1.96,
  minimumBrierSkillScore90LowerBound: -0.02,
  minimumPositiveClvRate: 0.558,
  minimumClosingLineCoverage: 0.95,
  minimumLeagueCount: 4,
  maximumSingleLeagueShare: 0.4,
  minimumRoiEvidenceRows: 1000,
  role: "shadow-only",
  formalOnlineEffect: false,
});

const finiteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const evaluateBenchmarkSelection = (prediction, options = {}) => {
  const policy = options.policy || GOODWIN_BENCHMARK_SHADOW_POLICY;
  const marketType = String(prediction?.marketType || "");
  const oddsPoolCode = String(prediction?.oddsPoolCode || "");
  const evidenceScore = finiteNumber(prediction?.trustScore, null);
  const odds = finiteNumber(prediction?.odds, null);
  const tipCode = String(prediction?.tipCode || "");
  const blockers = [];

  if (marketType !== policy.marketType) blockers.push("market-not-best");
  if (oddsPoolCode !== policy.oddsPoolCode) blockers.push("pool-not-had");
  if (evidenceScore === null || evidenceScore < policy.minimumEvidenceScore) {
    blockers.push("evidence-below-threshold");
  }
  if (odds === null || odds < policy.minimumOdds || odds > policy.maximumOdds) {
    blockers.push("odds-outside-band");
  }
  if (!["1", "X", "2"].includes(tipCode)) blockers.push("invalid-one-x-two-tip");
  if (prediction?.clockEligible === false) blockers.push("decision-clock-ineligible");

  return {
    version: policy.version,
    activatedAt: policy.activatedAt,
    qualified: blockers.length === 0,
    role: policy.role,
    formalOnlineEffect: false,
    blockers,
    evidenceScore,
    odds,
    criteria: {
      marketType: policy.marketType,
      oddsPoolCode: policy.oddsPoolCode,
      minimumEvidenceScore: policy.minimumEvidenceScore,
      minimumOdds: policy.minimumOdds,
      maximumOdds: policy.maximumOdds,
    },
  };
};

module.exports = {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
  evaluateBenchmarkSelection,
};
