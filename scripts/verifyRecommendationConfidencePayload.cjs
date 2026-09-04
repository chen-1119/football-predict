const assert = require('node:assert/strict');
const {
  applyPredictionPersistence,
  predictionSet,
  predictionSetWithoutOfficialOdds,
} = require('./syncData.cjs');
const {
  buildDynamicRecommendationConfidence,
} = require('../src/services/recommendationConfidence.cjs');
const {
  evaluateMultiFactorRecommendation,
} = require('../src/services/multiFactorRecommendation.cjs');

const nowMs = Date.now();
const iso = (offsetMs) => new Date(nowMs + offsetMs).toISOString();

const productionFixture = (overrides = {}) => ({
  sourceMatchId: `confidence-contract-${Math.abs(Number(overrides.clockVariant || 0))}`,
  source: 'sporttery',
  sourceCycleId: 'fixture-cycle-auditable-confidence',
  homeTeam: 'Contract Home',
  awayTeam: 'Contract Away',
  leagueName: 'Contract League',
  kickoffTime: iso(24 * 60 * 60 * 1000),
  status: 'SCHEDULED',
  odds: { odds1: 1.95, oddsX: 3.35, odds2: 3.7 },
  oddsSource: 'sporttery:HAD',
  eloSnapshot: {
    probabilities: { home: 0.53, draw: 0.26, away: 0.21 },
    homeRating: 1630,
    awayRating: 1510,
    diff: 120,
    homeMatches: 30,
    awayMatches: 30,
    historicalSource: {
      source: 'fixture-history',
      version: 'v1',
      signature: 'confidence-contract-elo-v1',
    },
  },
  formSnapshot: {
    version: 'rolling-form-fixture-v1',
    sampleSize: 12,
    home: {
      sampleSize: 6,
      goalsForAvg: 1.8,
      goalsAgainstAvg: 0.9,
      lastMatchAt: iso(-7 * 24 * 60 * 60 * 1000),
    },
    away: {
      sampleSize: 6,
      goalsForAvg: 1.0,
      goalsAgainstAvg: 1.5,
      lastMatchAt: iso(-6 * 24 * 60 * 60 * 1000),
    },
    historicalSource: {
      source: 'fixture-history',
      version: 'v1',
      signature: 'confidence-contract-form-v1',
    },
  },
  leaguePrior: {
    source: 'fixture-history',
    trainingVersion: 'v1',
    trainingSignature: 'confidence-contract-league-v1',
    matches: 100,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
  externalSignals: {
    preMatch: {
      source: 'audited-pre-match-fixture',
      quality: {
        version: 'pre-match-quality-contract-v1',
        score: 82,
        sourceQuality: 'high',
        severeMissingCount: 0,
        trustPenalty: 0,
        missing: [],
        connected: {
          referee: true,
          teamCards: true,
          lineup: true,
          injuries: true,
          xg: true,
          weather: true,
          market: true,
          motivation: true,
          strength: true,
          form: true,
        },
      },
    },
  },
  // A stable strategy is present, but no retrospective sample is invented.
  modelCalibration: {
    strategy: { activation: { riskGuard: { riskTier: 'stable' } } },
  },
  ...overrides,
});

const generatedBest = (fixture) => {
  const generated = predictionSet(fixture);
  const best = generated.predictions.find((row) => row.marketType === 'BEST');
  assert.ok(best?.confidence, 'production predictionSet must emit the BEST confidence contract');
  return { generated, best };
};

const noClock = generatedBest(productionFixture({ clockVariant: 1 }));
const noClockMetrics = noClock.best.confidence.publicMetrics;
assert.equal(noClock.best.confidence.available, false);
assert.ok(noClock.best.confidence.unavailableReasons.includes('freshness-quality-missing'));
assert.equal(noClockMetrics.freshnessQuality, null);
assert.equal(noClockMetrics.freshnessObservedAt, null);
assert.equal(noClockMetrics.freshnessSourceUpdatedAt, null);
assert.equal(noClockMetrics.freshnessAsOf, null);
assert.equal(noClockMetrics.freshnessAgeSeconds, null);
assert.equal(noClockMetrics.freshnessBasis, 'unavailable');
assert.equal(noClockMetrics.calibrationSample, null,
  'an absent retrospective calibration sample must stay null, never n=0');
assert.equal(
  noClockMetrics.evidenceCompleteness,
  noClock.generated.probabilityModel.inputSufficiency.coverageRatio,
  'public completeness must be the auditable directional input coverage ratio',
);
assert.equal(noClockMetrics.evidenceCompletenessBasis, 'input-coverage-ratio');
assert.equal(noClockMetrics.dataQuality, 0.82,
  'public data quality must preserve the explicit pre-match quality observation');

const observedAt = iso(-10 * 60 * 1000);
const observedClock = generatedBest(productionFixture({
  clockVariant: 2,
  oddsObservedAt: observedAt,
}));
const observedMetrics = observedClock.best.confidence.publicMetrics;
assert.equal(observedClock.best.confidence.available, true);
assert.equal(observedMetrics.freshnessBasis, 'observed-at');
assert.equal(observedMetrics.freshnessObservedAt, observedAt);
assert.equal(observedMetrics.freshnessSourceUpdatedAt, null);
assert.equal(observedMetrics.freshnessAsOf, observedAt);
assert.equal(observedMetrics.freshnessSource, 'sporttery:HAD');
assert.ok(observedMetrics.freshnessAgeSeconds >= 9 * 60);
assert.ok(observedMetrics.freshnessAgeSeconds <= 11 * 60);
assert.equal(observedMetrics.freshnessQuality, 1);
assert.equal(observedMetrics.calibrationSample, null);

const sourceUpdatedAt = iso(-2 * 60 * 60 * 1000);
const updatedClock = generatedBest(productionFixture({
  clockVariant: 3,
  oddsUpdatedAt: sourceUpdatedAt,
}));
const updatedMetrics = updatedClock.best.confidence.publicMetrics;
assert.equal(updatedClock.best.confidence.available, true);
assert.equal(updatedMetrics.freshnessBasis, 'source-updated-at');
assert.equal(updatedMetrics.freshnessObservedAt, null);
assert.equal(updatedMetrics.freshnessSourceUpdatedAt, sourceUpdatedAt);
assert.equal(updatedMetrics.freshnessAsOf, sourceUpdatedAt);
assert.equal(updatedMetrics.freshnessQuality, 0.75);

const modelOnlyFixture = productionFixture({
  sourceMatchId: 'confidence-contract-model-only',
  clockVariant: 4,
  odds: undefined,
  oddsSource: undefined,
});
const modelOnlyGenerated = predictionSetWithoutOfficialOdds(modelOnlyFixture);
const modelOnlyBest = modelOnlyGenerated.predictions.find((row) => row.marketType === 'BEST');
const modelOnlyMetrics = modelOnlyBest?.confidence?.publicMetrics;
assert.ok(modelOnlyBest?.confidence,
  'model-only BEST must emit the auditable confidence contract');
assert.equal(modelOnlyBest.confidence.available, false,
  'model-only confidence stays unavailable until all audited scoring inputs exist');
assert.ok(modelOnlyBest.confidence.unavailableReasons.includes('evidence-score-missing'));
assert.equal(modelOnlyMetrics.evidenceCompleteness,
  modelOnlyGenerated.probabilityModel.inputSufficiency.coverageRatio);
assert.equal(modelOnlyMetrics.evidenceCompletenessBasis, 'input-coverage-ratio');
assert.equal(modelOnlyMetrics.marketConsistency, 'unavailable');
assert.equal(modelOnlyMetrics.marketConsistencyBasis, 'unavailable');
assert.equal(modelOnlyMetrics.freshnessQuality, null);
assert.equal(modelOnlyMetrics.freshnessBasis, 'unavailable');
assert.equal(modelOnlyMetrics.calibrationSample, null);

const coldStartGenerated = predictionSetWithoutOfficialOdds(productionFixture({
  sourceMatchId: 'confidence-contract-cold-start',
  clockVariant: 5,
  odds: undefined,
  oddsSource: undefined,
  eloSnapshot: undefined,
  formSnapshot: undefined,
  leaguePrior: undefined,
}));
const coldStartBest = coldStartGenerated.predictions.find((row) => row.marketType === 'BEST');
assert.equal(coldStartBest?.recommendationTier, 'cold-start-reference');
assert.ok(coldStartBest?.confidence?.publicMetrics,
  'cold-start display conversion must preserve partial audited public metrics');
assert.equal(coldStartBest.confidence.publicMetrics.marketConsistency, 'unavailable');

const persistenceFixture = productionFixture({
  sourceMatchId: 'confidence-contract-mutable-persistence',
  clockVariant: 6,
  odds: undefined,
  oddsSource: undefined,
  buyEndTime: iso(12 * 60 * 60 * 1000),
});
const persistenceCandidate = {
  ...persistenceFixture,
  ...predictionSetWithoutOfficialOdds(persistenceFixture),
};
const firstPersisted = applyPredictionPersistence(
  persistenceCandidate,
  null,
  iso(60 * 60 * 1000),
  { finalizedAt: iso(61 * 60 * 1000) },
);
const mutableLegacy = {
  ...firstPersisted,
  predictions: firstPersisted.predictions.map(({ confidence, ...prediction }) => prediction),
};
const enrichedMutable = applyPredictionPersistence(
  persistenceCandidate,
  mutableLegacy,
  iso(2 * 60 * 60 * 1000),
  { finalizedAt: iso(2 * 60 * 60 * 1000 + 60 * 1000) },
);
const enrichedMutableBest = enrichedMutable.predictions.find((row) => row.marketType === 'BEST');
assert.ok(enrichedMutableBest?.confidence?.publicMetrics,
  'same-signal mutable unpublished rows must converge to the current confidence contract');
assert.equal(enrichedMutableBest.tipCode,
  mutableLegacy.predictions.find((row) => row.marketType === 'BEST')?.tipCode,
  'confidence convergence must not rewrite the existing direction');

const formallyPublishedLegacy = {
  ...mutableLegacy,
  predictions: mutableLegacy.predictions.map((prediction) => (
    prediction.marketType === 'BEST'
      ? { ...prediction, publicationId: 'formal-publication-contract' }
      : prediction
  )),
};
const preservedFormal = applyPredictionPersistence(
  persistenceCandidate,
  formallyPublishedLegacy,
  iso(3 * 60 * 60 * 1000),
  { finalizedAt: iso(3 * 60 * 60 * 1000 + 60 * 1000) },
);
assert.equal(
  preservedFormal.predictions.find((row) => row.marketType === 'BEST')?.confidence,
  undefined,
  'a formally published row must never receive a retrospective confidence backfill',
);

const preservedAfterCutoff = applyPredictionPersistence(
  persistenceCandidate,
  mutableLegacy,
  iso(13 * 60 * 60 * 1000),
  { finalizedAt: iso(13 * 60 * 60 * 1000 + 60 * 1000) },
);
assert.equal(
  preservedAfterCutoff.predictions.find((row) => row.marketType === 'BEST')?.confidence,
  undefined,
  'a trusted frozen pre-cutoff decision must remain byte-semantic and cannot be backfilled',
);

const absentFacts = buildDynamicRecommendationConfidence({
  selectedProbability: 0.52,
  dataQuality: 0.8,
  evidenceCompleteness: null,
  evidenceScore: 75,
  marketAligned: null,
  calibrationSample: null,
  freshnessEvidence: null,
});
assert.equal(absentFacts.publicMetrics.evidenceCompleteness, null);
assert.equal(absentFacts.publicMetrics.marketConsistency, 'unavailable');
assert.equal(absentFacts.publicMetrics.marketConsistencyBasis, 'unavailable');
assert.equal(absentFacts.publicMetrics.calibrationSample, null);
assert.equal(absentFacts.publicMetrics.freshnessQuality, null);

const absentMarketEvidence = evaluateMultiFactorRecommendation({
  market: 'HAD',
  code: '1',
  odds: 2.1,
  modelProbability: 0.52,
  marketProbability: null,
  modelGap: 0.12,
  dataQuality: 0.8,
  marketLeaderAligned: null,
  scoreAligned: true,
  crossMarketCompatible: true,
  handicapAligned: true,
  upstreamRecommended: true,
  upstreamAligned: true,
  globalRiskTier: 'stable',
});
assert.equal(absentMarketEvidence.diagnostics.marketLeaderAligned, null,
  'an absent market leader is unknown, not a market conflict');

console.log(JSON.stringify({
  ok: true,
  verifier: 'recommendation-confidence-production-payload',
  assertions: 49,
  contract: {
    missingCalibrationSampleIsNull: true,
    marketAlignmentIsTriState: true,
    freshnessRequiresAuditedClock: true,
    completenessUsesInputCoverageRatio: true,
    missingFactsRemainNull: true,
    modelOnlyRowsEmitPartialPublicFacts: true,
    mutableRowsConvergeWithoutDirectionRewrite: true,
    frozenOrPublishedRowsNeverBackfill: true,
  },
}, null, 2));
