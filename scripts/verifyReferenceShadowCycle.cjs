"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildReferenceShadowEvaluation,
  buildStrategy,
} = require("./optimizePredictionStrategy.cjs");
const {
  applyModelStrategyToCalibration,
  buildModelCalibration,
  calibrationGateForProfile,
  calibrationWeightForProfile,
  referenceShadowTighteningFromStrategy,
} = require("./syncData.cjs");

const rootDir = path.resolve(__dirname, "..");

function trustedReferenceMatch(index, { days = 4, won = false } = {}) {
  const day = 1 + (index % days);
  const kickoffTime = `2026-07-${String(day).padStart(2, "0")}T12:00:00+08:00`;
  return {
    id: `sporttery_reference_${index}`,
    sourceMatchId: `reference_${index}`,
    status: "FINISHED",
    scoreHome: won ? 1 : 0,
    scoreAway: won ? 0 : 1,
    kickoffTime,
    kickoffDate: kickoffTime.slice(0, 10),
    leagueName: "Reference Test League",
    resultProvenance: {
      provider: "sporttery",
      official: true,
      trusted: true,
      promotionEligible: true,
    },
    predictions: [],
    postMatchReview: {
      settlement: {
        resultObservationFallback: false,
      },
      predictionReview: {
        rows: [{
          marketType: "BEST",
          oddsPoolCode: "HAD",
          tipCode: "1",
          odds: 1.9,
          trustScore: 60,
          resultStatus: won ? "WON" : "LOST",
          reviewRole: "reference",
          performanceTrack: "reference",
          recommendationAction: "reference",
          recommendationTier: "reference",
        }],
      },
    },
  };
}

function projectedScoreMatch(index, { rowsPerDay = 13 } = {}) {
  const day = 1 + Math.floor(index / rowsPerDay);
  const kickoffTime = `2026-07-${String(day).padStart(2, "0")}T12:00:00+08:00`;
  return {
    id: `sporttery_score_${index}`,
    sourceMatchId: `score_${index}`,
    status: "FINISHED",
    scoreHome: 3,
    scoreAway: 1,
    projectedScoreHome: 0,
    projectedScoreAway: 0,
    kickoffTime,
    kickoffDate: kickoffTime.slice(0, 10),
    businessDate: kickoffTime.slice(0, 10),
    resultProvenance: {
      provider: "sporttery",
      official: true,
      trusted: true,
    },
    probabilityModel: {
      scoreDistribution: [
        { label: "0-0", probability: 0.3 },
        { label: "1-0", probability: 0.2 },
        { label: "0-1", probability: 0.15 },
      ],
    },
    predictions: [],
  };
}

function allReferenceRules(reference) {
  return [
    reference?.tightening?.gateByMarket,
    reference?.tightening?.gateByProfile,
    reference?.tightening?.gateByMarketProfile,
    reference?.tightening?.gateByOddsBucket,
    reference?.tightening?.gateByTip,
  ].flatMap((map) => Object.values(map || {}));
}

const cold49 = buildReferenceShadowEvaluation(Array.from({ length: 49 }, (_, index) => (
  trustedReferenceMatch(index, { days: 4, won: false })
)));
assert.equal(cold49.sample.decisionRows, 49);
assert.equal(cold49.activation.onlineEffect, "shadow-observe");
assert.equal(cold49.tightening.activeGateCount, 0, "49 rows must never auto-tune");

const cold50OneDay = buildReferenceShadowEvaluation(Array.from({ length: 50 }, (_, index) => (
  trustedReferenceMatch(index, { days: 1, won: false })
)));
assert.equal(cold50OneDay.sample.independentMatchDays, 1);
assert.equal(cold50OneDay.tightening.activeGateCount, 0, "one match day must never auto-tune");

const cold50FourDaysMatches = Array.from({ length: 50 }, (_, index) => (
  trustedReferenceMatch(index, { days: 4, won: false })
));
const cold50FourDays = buildReferenceShadowEvaluation(cold50FourDaysMatches);
assert.equal(cold50FourDays.sample.independentMatchDays, 4);
assert.equal(cold50FourDays.activation.onlineEffect, "shadow-observe");
assert.equal(cold50FourDays.tightening.activeGateCount, 0);
assert.equal(cold50FourDays.promotionEligible, false);
assert.equal(cold50FourDays.countedInFormalMetrics, false);
for (const rule of allReferenceRules(cold50FourDays)) {
  assert.notEqual(rule.onlineAction, "loosen");
  assert.equal(rule.onlineAction, "observe");
  assert.equal(rule.sampleStatus, "shadow-quarantined");
  assert.ok(rule.reasons.includes("reference-cohort-not-tier-isolated"));
}

const strategy = buildStrategy(cold50FourDaysMatches, {});
assert.equal(strategy.sample.settledRows, 0, "reference rows must not enter formal settled rows");
assert.equal(strategy.sample.officialRows, 0, "reference rows must not enter official rows");
assert.equal(strategy.referenceShadowRows.sample.decisionRows, 50);
assert.equal(strategy.activation.onlineEffect, "shadow", "reference evidence cannot promote the formal strategy");
const calibrated = applyModelStrategyToCalibration({ gateByProfile: {} }, strategy);
assert.equal(calibrated.strategy, undefined);

const tampered = structuredClone(strategy);
tampered.referenceShadowRows.tightening.gateByMarket["1X2"].onlineAction = "loosen";
assert.equal(referenceShadowTighteningFromStrategy(tampered), null, "unsafe reference rules must fail closed");
assert.equal(applyModelStrategyToCalibration({ strategy: { stale: true } }, tampered).strategy, undefined);

const hot100 = buildReferenceShadowEvaluation(Array.from({ length: 100 }, (_, index) => (
  trustedReferenceMatch(index, { days: 4, won: true })
)));
assert.equal(hot100.tightening.activeGateCount, 0, "hot reference rows cannot loosen gates");
assert.ok(allReferenceRules(hot100).every((rule) => rule.onlineAction !== "loosen"));

const hot8Summary = {
  byMarketProfile: {
    "1X2:other": { settled: 8, won: 8, lost: 0, hitRate: 1, independentMatchDays: 4 },
  },
  byProfile: {},
};
assert.ok(calibrationGateForProfile(hot8Summary, "other").minProbabilityBoost >= 0);
assert.ok(calibrationWeightForProfile(hot8Summary, "other").market >= 0.58);

const hot50ThreeDaysSummary = {
  byMarketProfile: {
    "1X2:other": { settled: 50, won: 50, lost: 0, hitRate: 1, independentMatchDays: 3 },
  },
  byProfile: {},
};
assert.ok(calibrationGateForProfile(hot50ThreeDaysSummary, "other").minProbabilityBoost >= 0);

const hot50FourDaysSummary = {
  byMarketProfile: {
    "1X2:other": { settled: 50, won: 50, lost: 0, hitRate: 1, independentMatchDays: 4 },
  },
  byProfile: {},
};
assert.ok(calibrationGateForProfile(hot50FourDaysSummary, "other").minProbabilityBoost < 0);
assert.ok(calibrationWeightForProfile(hot50FourDaysSummary, "other").market < 0.58);

const score49 = buildModelCalibration(Array.from({ length: 49 }, (_, index) => projectedScoreMatch(index)));
assert.equal(score49.scoreCalibration.sample.automaticTuningSampleReady, false);
assert.equal(score49.scoreCalibration.adjustments.totalLambdaAdjustment, 0);
assert.equal(score49.scoreCalibration.adjustments.over25ProbabilityShift, 0);
assert.deepEqual(score49.scoreCalibration.adjustments.bandRankBoosts, {});

const score50OneDay = buildModelCalibration(Array.from({ length: 50 }, (_, index) => (
  projectedScoreMatch(index, { rowsPerDay: 50 })
)));
assert.equal(score50OneDay.scoreCalibration.sample.independentMatchDays, 1);
assert.equal(score50OneDay.scoreCalibration.sample.automaticTuningSampleReady, false);
assert.equal(score50OneDay.scoreCalibration.adjustments.totalLambdaAdjustment, 0);

const score50FourDays = buildModelCalibration(Array.from({ length: 50 }, (_, index) => projectedScoreMatch(index)));
assert.equal(score50FourDays.scoreCalibration.sample.independentMatchDays, 4);
assert.equal(score50FourDays.scoreCalibration.sample.automaticTuningSampleReady, true);
assert.ok(score50FourDays.scoreCalibration.adjustments.totalLambdaAdjustment > 0);

const runnerSource = fs.readFileSync(path.join(rootDir, "scripts", "runAutonomousModelCycle.cjs"), "utf8");
const cycleSource = fs.readFileSync(path.join(rootDir, "scripts", "autonomousModelCycle.cjs"), "utf8");
assert.match(runnerSource, /never emits PROMOTED and never calls active-model pointer CAS/);
assert.match(cycleSource, /status: plan\.legalCandidate \? "registered-shadow" : "rejected"/);
assert.match(cycleSource, /activeModelPointerUnchanged: true/);

console.log(JSON.stringify({
  ok: true,
  verifier: "reference-shadow-cycle",
  referenceShadow: {
    rowsRequired: 50,
    matchDaysRequired: 4,
    formalRows: strategy.sample.settledRows,
    referenceRows: strategy.referenceShadowRows.sample.rows,
    referenceDecisionRows: strategy.referenceShadowRows.sample.decisionRows,
    activeGates: strategy.referenceShadowRows.tightening.activeGates,
    embeddedEffect: calibrated.strategy?.activation?.onlineEffect || null,
    promotionAllowed: calibrated.strategy?.activation?.promotionAllowed ?? false,
    looseningAllowed: calibrated.strategy?.activation?.looseningAllowed ?? false,
  },
  scoreCalibration: {
    rows49Ready: score49.scoreCalibration.sample.automaticTuningSampleReady,
    rows50OneDayReady: score50OneDay.scoreCalibration.sample.automaticTuningSampleReady,
    rows50FourDaysReady: score50FourDays.scoreCalibration.sample.automaticTuningSampleReady,
  },
  autonomousCycle: "shadow-or-reject-only; active pointer unchanged",
}, null, 2));
