const assert = require("node:assert/strict");
const {
  buildMarketLaneShadowAudit,
  buildOutcomeCalibrationShadow,
  buildProbabilityModel,
  buildUnifiedPosteriorCandidates,
} = require("./syncData.cjs");
const { summarizeCalibrationRows } = require("./auditWorldCupCalibrationShadow.cjs");

const checks = [];
const check = (name, run) => {
  run();
  checks.push(name);
};

check("no-stacked-cooldown shadow never mutates the active calibration", () => {
  const activeCalibration = {
    probabilities: { home: 0.53, draw: 0.29, away: 0.18 },
  };
  const activeBefore = JSON.stringify(activeCalibration);
  const shadow = buildOutcomeCalibrationShadow(
    { probabilities: { home: 0.6, draw: 0.25, away: 0.15 } },
    activeCalibration
  );
  assert.equal(JSON.stringify(activeCalibration), activeBefore);
  assert.deepEqual(shadow.probabilities, { home: 60, draw: 25, away: 15 });
  assert.deepEqual(shadow.activeProbabilities, { home: 53, draw: 29, away: 18 });
  assert.equal(shadow.activation, "shadow-only");
  assert.equal(shadow.formalOutputChanged, false);
});

const coolingBucket = {
  settled: 20,
  won: 4,
  lost: 16,
  hitRate: 0.2,
  cooldown: true,
  urgentCooldown: true,
};
const calibrationFixture = {
  leagueName: "世界杯",
  countryName: "国际",
  odds: { odds1: 1.5, oddsX: 4, odds2: 6 },
  handicapLine: "-1",
  predictionHealth: {
    homeFavorite: coolingBucket,
    byMarket: { "1X2": coolingBucket },
    oneXTwo: {
      byTip: { "1": coolingBucket },
      byProfile: { international: coolingBucket },
      byOddsBucket: { sp_1_46_1_70: coolingBucket },
      lowSpSide: coolingBucket,
    },
    byMarketProfile: { "1X2:international": coolingBucket },
  },
};
const lambdaBlend = {
  marketHomeLambda: 1.8,
  marketAwayLambda: 0.7,
  independentHomeLambda: 1.8,
  independentAwayLambda: 0.7,
  independentTotalLambda: 2.5,
  independentHomeShare: 0.72,
  leagueHomeLambda: 1.8,
  leagueAwayLambda: 0.7,
  leagueWeight: 0,
  formHomeLambda: 1.8,
  formAwayLambda: 0.7,
  formWeight: 0,
  finalHomeLambda: 1.8,
  finalAwayLambda: 0.7,
};

check("production 1X2 remains on the active stacked calibration while shadow stores the pre-cooldown triplet", () => {
  const model = buildProbabilityModel(
    calibrationFixture,
    { home: 0.62, draw: 0.23, away: 0.15 },
    { home: 0.4, draw: 0.3, away: 0.3 },
    1.8,
    0.7,
    0.54,
    0.47,
    lambdaBlend,
    { meta: null },
    {}
  );
  assert.deepEqual(model.oneXTwo.final, { home: 45.3, draw: 28.1, away: 26.6 });
  assert.deepEqual(model.calibrationAdjustment.oneXTwo.shadow.probabilities, { home: 51.8, draw: 23.3, away: 24.8 });
  assert.deepEqual(model.calibrationAdjustment.oneXTwo.shadow.activeProbabilities, model.oneXTwo.final);
  assert.equal(model.calibrationAdjustment.oneXTwo.shadow.formalOutputChanged, false);
});

const candidateModel = {
  generatedAt: "2026-07-01T00:00:00Z",
  oneXTwo: {
    final: { home: 55, draw: 25, away: 20 },
    scoreImplied: { home: 50, draw: 30, away: 20 },
    poisson: { home: 52, draw: 28, away: 20 },
    market: { home: 50, draw: 28, away: 22 },
  },
  handicap: {
    scoreImplied: { home: 25, draw: 30, away: 45 },
    poisson: { home: 27, draw: 28, away: 45 },
    market: { home: 28, draw: 30, away: 42 },
  },
  scoreDistribution: [
    { home: 1, away: 0, probability: 18 },
    { home: 2, away: 0, probability: 14 },
    { home: 1, away: 1, probability: 12 },
  ],
};
const candidateMatch = {
  id: "world-cup-lane-fixture",
  leagueName: "世界杯",
  homeTeamName: "甲",
  awayTeamName: "乙",
  handicapLine: "-1",
  kickoffTime: "2026-07-02T00:00:00Z",
  predictionMeta: { cutoffTime: "2026-07-01T23:30:00Z" },
};
const candidateContext = {
  best: null,
  oneXTwo: null,
  probabilityModel: candidateModel,
  probabilities: { home: 0.5, draw: 0.28, away: 0.22 },
  hhadProbabilities: { home: 0.28, draw: 0.3, away: 0.42 },
  hadOdds: { odds1: 1.9, oddsX: 3.3, odds2: 4.2 },
  hhadOdds: { odds1: 2.9, oddsX: 3.2, odds2: 2.1 },
  anchorHandicapLine: "-1",
  contextSignals: { dataGaps: { coverageScore: 80, sourceQuality: "high" } },
};

check("HAD and HHAD are recorded as independent lanes with HAD active first", () => {
  const result = buildUnifiedPosteriorCandidates(candidateMatch, candidateContext);
  assert.equal(result.selected.market, "HAD");
  assert.equal(result.selected.code, "1");
  assert.equal(result.marketLaneAudit.currentSelection.market, result.selected.market);
  assert.equal(result.marketLaneAudit.currentSelection.code, result.selected.code);
  assert.equal(result.marketLaneAudit.lanes.HAD.market, "HAD");
  assert.equal(result.marketLaneAudit.lanes.HHAD.market, "HHAD");
  assert.equal(result.marketLaneAudit.activation, "active-had-first");
  assert.equal(result.marketLaneAudit.formalOutputChanged, false);
});

check("lane audit records when active HAD-first changes a raw HHAD winner", () => {
  const had = { market: "HAD", code: "1", probability: 0.42, odds: 2.1, gap: 0.08, posteriorScore: 0.52 };
  const hhad = { market: "HHAD", code: "2", probability: 0.55, odds: 1.9, gap: 0.2, posteriorScore: 0.7 };
  const audit = buildMarketLaneShadowAudit(had, hhad, had, hhad);
  assert.equal(audit.rawSelection.market, "HHAD");
  assert.equal(audit.currentSelection.market, "HAD");
  assert.equal(audit.shadowSelection.market, "HAD");
  assert.equal(audit.wouldChangeSelection, true);
  assert.equal(audit.formalOutputChanged, true);
});

check("the production selector cannot let an unpromoted HHAD score displace HAD", () => {
  const hhadDominantModel = {
    ...candidateModel,
    oneXTwo: {
      ...candidateModel.oneXTwo,
      final: { home: 42, draw: 30, away: 28 },
      market: { home: 42, draw: 30, away: 28 },
    },
    handicap: {
      scoreImplied: { home: 10, draw: 15, away: 75 },
      poisson: { home: 10, draw: 15, away: 75 },
      market: { home: 10, draw: 15, away: 75 },
    },
  };
  const result = buildUnifiedPosteriorCandidates(candidateMatch, {
    ...candidateContext,
    probabilityModel: hhadDominantModel,
    probabilities: { home: 0.42, draw: 0.30, away: 0.28 },
    hhadProbabilities: { home: 0.10, draw: 0.15, away: 0.75 },
  });
  assert.equal(result.marketLaneAudit.rawSelection.market, "HHAD");
  assert.equal(result.selected.market, "HAD");
  assert.equal(result.marketLaneAudit.currentSelection.market, "HAD");
  assert.equal(result.marketLaneAudit.formalOutputChanged, true);
});

check("a draw-heavy model keeps the draw when a 65 percent HAD home favorite disagrees", () => {
  const drawHeavyModel = {
    ...candidateModel,
    oneXTwo: {
      ...candidateModel.oneXTwo,
      final: { home: 36, draw: 40, away: 24 },
      scoreImplied: { home: 25, draw: 55, away: 20 },
      poisson: { home: 35, draw: 40, away: 25 },
      market: { home: 65, draw: 17, away: 18 },
    },
    scoreDistribution: [
      { home: 0, away: 0, probability: 20 },
      { home: 1, away: 1, probability: 18 },
      { home: 1, away: 0, probability: 15 },
    ],
  };
  const result = buildUnifiedPosteriorCandidates(candidateMatch, {
    ...candidateContext,
    probabilityModel: drawHeavyModel,
    probabilities: { home: 0.65, draw: 0.17, away: 0.18 },
    hadOdds: { odds1: 1.538462, oddsX: 5.882353, odds2: 5.555556 },
  });
  assert.equal(result.scoreShape.drawHeavy, true);
  assert.equal(result.selected.market, "HAD");
  assert.equal(result.selected.code, "X");
  assert.equal(result.marketBaseline.leaderCode, "1");
  assert.equal(result.marketBaseline.thresholdMet, true);
  assert.equal(result.marketBaseline.directionAligned, false);
  assert.equal(result.marketBaseline.applied, false);
  assert.ok(result.marketBaseline.blockers.includes("model-market-direction-conflict"));
});

check("a 65 percent opposite HAD favorite cannot replace the existing model direction", () => {
  const strongAwayMarketModel = {
    ...candidateModel,
    oneXTwo: {
      ...candidateModel.oneXTwo,
      market: { home: 18, draw: 17, away: 65 },
    },
  };
  const result = buildUnifiedPosteriorCandidates(candidateMatch, {
    ...candidateContext,
    probabilityModel: strongAwayMarketModel,
    hadOdds: { odds1: 5.555556, oddsX: 5.882353, odds2: 1.538462 },
  });
  assert.equal(result.selected.market, "HAD");
  assert.equal(result.selected.code, "1");
  assert.notEqual(result.selected.selectionPolicy, "calibrated-had-market-baseline");
  assert.equal(result.marketBaseline.leaderCode, "2");
  assert.equal(result.marketBaseline.leaderProbability, 0.65);
  assert.equal(result.marketBaseline.thresholdMet, true);
  assert.equal(result.marketBaseline.directionAligned, false);
  assert.equal(result.marketBaseline.applied, false);
  assert.ok(result.marketBaseline.blockers.includes("model-market-direction-conflict"));
});

check("an aligned 65 percent HAD leader is recorded as support without changing the model pick", () => {
  const result = buildUnifiedPosteriorCandidates(candidateMatch, {
    ...candidateContext,
    probabilities: { home: 0.65, draw: 0.17, away: 0.18 },
    hadOdds: { odds1: 1.538462, oddsX: 5.882353, odds2: 5.555556 },
  });
  assert.equal(result.marketBaseline.rawSelection.market, "HAD");
  assert.equal(result.marketBaseline.rawSelection.code, "1");
  assert.equal(result.selected.market, result.marketBaseline.rawSelection.market);
  assert.equal(result.selected.code, result.marketBaseline.rawSelection.code);
  assert.equal(result.selected.selectionPolicy, "calibrated-had-market-baseline");
  assert.equal(result.marketBaseline.leaderCode, "1");
  assert.equal(result.marketBaseline.leaderProbability, 0.65);
  assert.equal(result.marketBaseline.thresholdMet, true);
  assert.equal(result.marketBaseline.directionAligned, true);
  assert.equal(result.marketBaseline.applied, true);
  assert.deepEqual(result.marketBaseline.blockers, []);
  assert.equal(result.selected.marketBaselineSupport?.applied, true);
});

check("HHAD remains available when no official HAD pool exists", () => {
  const result = buildUnifiedPosteriorCandidates(candidateMatch, {
    ...candidateContext,
    hadOdds: null,
  });
  assert.equal(result.selected.market, "HHAD");
  assert.equal(result.marketBaseline.applied, false);
});

check("calibration report compares probability quality without inventing recommendation ROI", () => {
  const rows = [
    {
      actual: "1",
      probabilities: { "1": 0.51, X: 0.3, "2": 0.19 },
      shadowProbabilities: { "1": 0.62, X: 0.23, "2": 0.15 },
      activePick: "1",
      shadowPick: "1",
    },
    {
      actual: "2",
      probabilities: { "1": 0.46, X: 0.3, "2": 0.24 },
      shadowProbabilities: { "1": 0.4, X: 0.3, "2": 0.3 },
      activePick: "1",
      shadowPick: "1",
    },
  ];
  const summary = summarizeCalibrationRows(rows);
  assert.equal(summary.rows, 2);
  assert.equal(summary.comparison.top1ChangedRows, 0);
  assert.ok(summary.comparison.brierImprovement > 0);
  assert.ok(summary.comparison.logLossImprovement > 0);
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "world-cup-safe-optimizer",
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  passed: checks,
}, null, 2)}\n`);
