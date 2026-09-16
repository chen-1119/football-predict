const fs = require('fs');
const path = require('path');
const {
  MULTI_FACTOR_POLICY_VERSION,
  MIN_MODEL_GAP,
  evaluateMultiFactorRecommendation,
} = require('../src/services/multiFactorRecommendation.cjs');
const {
  buildDynamicRecommendationConfidence,
} = require('../src/services/recommendationConfidence.cjs');

const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });

const strongEvidence = (overrides = {}) => ({
  market: 'HAD',
  code: '1',
  odds: 2.35,
  modelProbability: 0.54,
  marketProbability: 0.4,
  modelGap: 0.14,
  dataQuality: 0.82,
  scoreAligned: true,
  crossMarketCompatible: true,
  handicapAligned: true,
  marketLeaderAligned: true,
  trendSupports: true,
  trendContradicts: false,
  externalMarketAligned: true,
  externalMarketContradicted: false,
  externalMarketRisk: 'low',
  upstreamRecommended: true,
  upstreamAligned: true,
  globalRiskTier: 'stable',
  trustPenalty: 2,
  riskPenalty: 0.01,
  severeMissingCount: 0,
  riskTagsCount: 1,
  ...overrides,
});

const lowSpWeak = evaluateMultiFactorRecommendation(strongEvidence({
  odds: 1.31,
  modelProbability: 0.51,
  marketProbability: 0.71,
  modelGap: 0.18,
}));
check('low SP with a real model/market contradiction is rejected for the contradiction, not its price', !lowSpWeak.eligible
  && lowSpWeak.blockers.includes('market-implied-probability-contradiction')
  && !lowSpWeak.blockers.some((item) => item.includes('low-sp')), { result: lowSpWeak });

const highSpStrong = evaluateMultiFactorRecommendation(strongEvidence());
check('SP above the old ceiling can pass when independent evidence is strong', highSpStrong.eligible
  && highSpStrong.odds === 2.35
  && highSpStrong.code === '1'
  && highSpStrong.blockers.length === 0, { result: highSpStrong });

const hhadWithoutLine = evaluateMultiFactorRecommendation(strongEvidence({ market: 'HHAD' }));
check('HHAD evidence cannot be eligible without its audited line', !hhadWithoutLine.eligible
  && hhadWithoutLine.blockers.includes('missing-handicap-line'));
const hhadWithLine = evaluateMultiFactorRecommendation(strongEvidence({ market: 'HHAD', handicapLine: '-1' }));
check('HHAD evidence persists its canonical line', hhadWithLine.handicapLine === '-1'
  && !hhadWithLine.blockers.includes('missing-handicap-line'));

const highSpWeak = evaluateMultiFactorRecommendation(strongEvidence({
  odds: 3.1,
  modelProbability: 0.31,
  marketProbability: 0.3,
  modelGap: 0.03,
  trendSupports: false,
  externalMarketAligned: false,
}));
check('weak evidence remains observation-only without a price-specific blocker', !highSpWeak.eligible
  && highSpWeak.blockers.includes('model-probability-too-low')
  && highSpWeak.blockers.includes('model-separation-too-thin')
  && !highSpWeak.blockers.some((item) => item.includes('long-price')), { result: highSpWeak });

const upstreamFailed = evaluateMultiFactorRecommendation(strongEvidence({
  upstreamRecommended: false,
}));
check('unified layer cannot override the upstream multi-factor gate', !upstreamFailed.eligible
  && upstreamFailed.blockers.includes('upstream-multi-factor-gate-not-passed'));

const riskWatch = evaluateMultiFactorRecommendation(strongEvidence({ globalRiskTier: 'watch' }));
check('watch risk tier cannot publish a formal recommendation', !riskWatch.eligible
  && riskWatch.blockers.includes('model-risk-not-promotable'));

const riskUnknown = evaluateMultiFactorRecommendation(strongEvidence({ globalRiskTier: '' }));
check('missing risk state fails closed', !riskUnknown.eligible
  && riskUnknown.blockers.includes('model-risk-not-promotable'));

const thinModelGap = evaluateMultiFactorRecommendation(strongEvidence({ modelGap: 0.059 }));
check('model separation below the tightened six-point floor is rejected', !thinModelGap.eligible
  && thinModelGap.blockers.includes('model-separation-too-thin')
  && thinModelGap.minimumModelGap === 0.06);

const minimumModelGap = evaluateMultiFactorRecommendation(strongEvidence({ modelGap: 0.06 }));
check('model separation at the six-point floor clears the separation blocker',
  !minimumModelGap.blockers.includes('model-separation-too-thin'));

const confidenceInputs = {
  selectedProbability: 0.54,
  modelGap: 0.14,
  dataQuality: 0.82,
  evidenceCompleteness: 1,
  evidenceScore: 79,
  marketProbability: 0.4,
  marketAligned: true,
  supportingFactorCount: 7,
  freshnessEvidence: {
    observedAt: '2026-08-20T10:00:00Z',
    evaluatedAt: '2026-08-20T10:10:00Z',
    source: 'fixture-observation',
  },
  blockerCount: 0,
  calibrationHitRate: 0.52,
  calibrationSample: 42,
};
const shortPriceConfidence = buildDynamicRecommendationConfidence({ ...confidenceInputs, odds: 1.35 });
const longPriceConfidence = buildDynamicRecommendationConfidence({ ...confidenceInputs, odds: 3.35 });
check('confidence is invariant to SP when all football evidence is identical',
  shortPriceConfidence.score === longPriceConfidence.score
  && shortPriceConfidence.available === true
  && shortPriceConfidence.priceIndependent === true
  && longPriceConfidence.priceIndependent === true,
  { shortPriceConfidence, longPriceConfidence });

check('policy contains no max-SP direction switch', MULTI_FACTOR_POLICY_VERSION === 'multi-factor-dynamic-evidence-v4'
  && MIN_MODEL_GAP === 0.06
  && !JSON.stringify(highSpStrong).includes('maxSp')
  && highSpStrong.code === strongEvidence().code);

const syncSource = fs.readFileSync(path.join(__dirname, 'syncData.cjs'), 'utf8');
check('sync invalidates cached pre-match rows when the multi-factor policy changes',
  syncSource.includes('sporttery-day-formula-trace-v74-auditable-confidence-facts')
  && syncSource.includes('existingMultiFactorPolicyVersion !== nextMultiFactorPolicyVersion'));

const ok = checks.every((row) => row.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  policy: MULTI_FACTOR_POLICY_VERSION,
  checks,
}, null, 2));
if (!ok) process.exitCode = 1;
