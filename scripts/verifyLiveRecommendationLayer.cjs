const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LIVE_OFFICIAL_ODDS_MAX_AGE_MS,
  LIVE_RECOMMENDATION_POLICY_VERSION,
  buildLivePublicationEvidence,
  evaluateLiveRecommendation,
  hasOfficialSportterySourceForLivePrediction,
  isLiveRecommendationEligible,
  isLivePublicationEvidenceValid,
  isLiveRecommendationWindowOpen,
  isPublishedLiveRecommendationEligible,
  isServerLiveRecommendationEligible,
  liveRecommendationCutoffIso,
  liveRecommendationCutoffMs,
  officialOddsForLivePrediction,
  officialOddsFreshnessForLivePrediction,
  parseShanghaiDateTime,
} = require('../src/services/liveRecommendationEligibility.cjs');
const { isOfficialRecommendationEligible } = require('../src/services/officialRecommendationEligibility.cjs');
const { readSqliteCurrentMatches } = require('../server/sqliteStore.cjs');
const {
  buildLiveRecommendationAuditSummary,
  attachPostMatchReviews,
  buildPostMatchReview,
  finalizeLiveRecommendationPublications,
  predictionFromSnapshotTip,
  snapshotTip,
} = require('./syncData.cjs');

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

const basePrediction = {
  marketType: 'BEST',
  oddsPoolCode: 'HAD',
  handicapLine: '0',
  tipCode: '1',
  tipLabel: { zh: '主胜', en: 'Home' },
  odds: 2.1,
  trustScore: 58,
  recommendationAction: 'reference',
  recommendationTier: 'multi-factor-watch',
  visibilityStatus: 'FREE',
  resultStatus: 'PENDING',
  multiFactorEvidence: {
    version: 'multi-factor-market-evidence-v2',
    eligible: false,
    grade: 'WATCH',
    evidenceScore: 58,
    market: 'HAD',
    code: '1',
    handicapLine: '0',
    odds: 2.1,
    modelProbability: 0.54,
    marketProbability: 0.46,
    probabilityEdge: 0.08,
    expectedValue: 0.134,
    dataQuality: 0.8,
    supportingFactors: [
      'independent-model-probability',
      'model-separation',
      'model-market-edge',
      'positive-expected-value',
      'score-matrix-alignment',
    ],
    blockers: [],
    diagnostics: {
      severeMissingCount: 0,
    },
  },
};

const state = evaluateLiveRecommendation(basePrediction, 2.1, 0);
const publicationMatch = {
  id: 'sporttery_live_test',
  sourceMatchId: 'live_test',
  status: 'SCHEDULED',
  kickoffTime: '2026-07-16T10:00:00+08:00',
  buyEndTime: '2026-07-16 09:00:00',
  predictionMeta: { cutoffTime: '2026-07-16T10:00:00+08:00' },
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  oddsSource: 'sporttery:HAD',
  oddsPoolCode: 'HAD',
  oddsObservedAt: '2026-07-16T07:58:00+08:00',
  oddsReceivedAt: '2026-07-16T07:59:00+08:00',
  oddsSourceUrl: 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001',
};
const livePublicationEvidence = buildLivePublicationEvidence(
  publicationMatch,
  basePrediction,
  '2026-07-16T08:00:00+08:00'
);
assert.equal(
  liveRecommendationCutoffIso(publicationMatch),
  '2026-07-16T01:00:00.000Z',
  'display cutoff uses the earliest fail-closed official sale clock',
);
const livePrediction = {
  ...basePrediction,
  liveRecommendationAction: state.eligible ? 'recommend' : 'withhold',
  liveRecommendationTier: `live-${String(state.grade).toLowerCase()}`,
  liveRecommendation: state,
  livePublicationEvidence,
};

const legacyV1Publication = {
  version: 'live-recommendation-publication-v1',
  policyVersion: 'live-model-recommendation-v1',
  statisticsTrack: 'live-model',
  matchId: publicationMatch.id,
  sourceMatchId: publicationMatch.sourceMatchId,
  market: basePrediction.oddsPoolCode,
  code: basePrediction.tipCode,
  handicapLine: '0',
  officialSp: 2.1,
  officialSource: publicationMatch.oddsSource,
  officialSourceUrl: publicationMatch.oddsSourceUrl,
  publishedAt: '2026-07-16T08:00:00+08:00',
  cutoffAt: '2026-07-16T09:00:00+08:00',
};
const legacyV1Published = {
  ...livePrediction,
  liveRecommendation: {
    ...livePrediction.liveRecommendation,
    version: 'live-model-recommendation-v1',
  },
  livePublicationEvidence: legacyV1Publication,
};

check('regression matrix covers canonical deep lines and immutable publication boundaries', () => {
  const failures = [];
  const expect = (name, condition) => {
    if (!condition) failures.push(name);
  };

  for (const line of ['让球 -2', 'HHAD:-2', '\u22122', '-2球']) {
    const prediction = {
      ...basePrediction,
      oddsPoolCode: 'HHAD',
      handicapLine: line,
      odds: 1.92,
      multiFactorEvidence: {
        ...basePrediction.multiFactorEvidence,
        market: 'HHAD',
        handicapLine: line,
        odds: 1.92,
        evidenceScore: 63,
        dataQuality: 0.59,
        diagnostics: { severeMissingCount: 1 },
      },
    };
    const result = evaluateLiveRecommendation(prediction, 1.92, line);
    expect(`deep handicap variant ${JSON.stringify(line)} adds safety hold`, (
      result.blockers.includes('live-deep-handicap-safety-hold')
    ));
  }

  const blankMatchIdMatch = { ...publicationMatch, id: '' };
  const blankMatchIdPrediction = {
    ...livePrediction,
    livePublicationEvidence: { ...livePublicationEvidence, matchId: '' },
  };
  expect('strict publication rejects an empty matchId on both sides', !isLivePublicationEvidenceValid(
    blankMatchIdMatch,
    blankMatchIdPrediction,
    2.1,
    0
  ));

  const blankSourceIdMatch = { ...publicationMatch, sourceMatchId: '' };
  const blankSourceIdPrediction = {
    ...livePrediction,
    livePublicationEvidence: { ...livePublicationEvidence, sourceMatchId: '' },
  };
  expect('strict publication rejects an empty sourceMatchId on both sides', !isLivePublicationEvidenceValid(
    blankSourceIdMatch,
    blankSourceIdPrediction,
    2.1,
    0
  ));

  const missingMaxAge = { ...livePublicationEvidence };
  delete missingMaxAge.officialOddsMaxAgeSeconds;
  expect('strict publication rejects missing officialOddsMaxAgeSeconds', !isLivePublicationEvidenceValid(
    publicationMatch,
    { ...livePrediction, livePublicationEvidence: missingMaxAge },
    2.1,
    0
  ));

  const excessiveMaxAge = {
    ...livePublicationEvidence,
    officialOddsMaxAgeSeconds: (LIVE_OFFICIAL_ODDS_MAX_AGE_MS / 1000) + 1,
  };
  expect('strict publication rejects officialOddsMaxAgeSeconds above the policy maximum', !isLivePublicationEvidenceValid(
    publicationMatch,
    { ...livePrediction, livePublicationEvidence: excessiveMaxAge },
    2.1,
    0
  ));

  expect('real publication-v1 schema remains archive-retained', isPublishedLiveRecommendationEligible(
    legacyV1Published,
    2.1,
    0,
    publicationMatch
  ));
  expect('real publication-v1 schema never passes strict creation validation', !isLivePublicationEvidenceValid(
    publicationMatch,
    legacyV1Published,
    2.1,
    0
  ));

  const refreshedLegacy = {
    ...legacyV1Published,
    liveRecommendation: {
      ...legacyV1Published.liveRecommendation,
      version: LIVE_RECOMMENDATION_POLICY_VERSION,
    },
  };
  expect('archive v1 survives a mutable liveRecommendation refresh to v2', isPublishedLiveRecommendationEligible(
    refreshedLegacy,
    2.1,
    0,
    publicationMatch
  ));

  const refreshedCurrent = {
    ...livePrediction,
    liveRecommendation: {
      ...livePrediction.liveRecommendation,
      version: 'live-model-recommendation-v1',
    },
  };
  expect('archive v2 survives a mutable liveRecommendation refresh to v1', isPublishedLiveRecommendationEligible(
    refreshedCurrent,
    2.1,
    0,
    publicationMatch
  ));

  assert.deepEqual(failures, []);
});

check('eligible live lane remains separate from formal lane', () => {
  const checkedAt = parseShanghaiDateTime('2026-07-16T08:05:00+08:00');
  assert.equal(state.eligible, true);
  assert.equal(isLiveRecommendationEligible(basePrediction, 2.1, 0, publicationMatch, checkedAt), false, 'unstructured rows must not render');
  assert.equal(isLiveRecommendationEligible(livePrediction, 2.1, 0, publicationMatch, checkedAt), true);
  assert.equal(isOfficialRecommendationEligible(livePrediction, 2.1, 0), false);
  assert.equal(livePrediction.recommendationAction, 'reference');
});

check('fresh official response clock is mandatory for executable live recommendations', () => {
  const checkedAt = parseShanghaiDateTime('2026-07-16T08:05:00+08:00');
  assert.equal(officialOddsFreshnessForLivePrediction(publicationMatch, basePrediction, checkedAt).eligible, true);
  const staleOfficialSp = {
    ...publicationMatch,
    oddsObservedAt: '2026-07-16T06:30:00+08:00',
    oddsReceivedAt: '2026-07-16T06:31:00+08:00',
  };
  assert.equal(officialOddsFreshnessForLivePrediction(staleOfficialSp, basePrediction, checkedAt).eligible, false);
  assert.equal(buildLivePublicationEvidence(staleOfficialSp, basePrediction, checkedAt), null);
  assert.equal(isServerLiveRecommendationEligible(livePrediction, 2.1, {
    officialSource: true,
    officialHandicapLine: 0,
    match: staleOfficialSp,
    nowMs: checkedAt,
  }), false);
});

for (const blocker of [
  'negative-expected-value',
  'had-hhad-conflict',
  'market-implied-probability-contradiction',
  'model-separation-too-thin',
  'low-sp-without-value',
  'model-risk-not-promotable',
  'upstream-multi-factor-gate-not-passed',
  'insufficient-data-quality',
  'too-many-severe-data-gaps',
]) {
  check(`hard blocker rejected: ${blocker}`, () => {
    const prediction = {
      ...basePrediction,
      multiFactorEvidence: {
        ...basePrediction.multiFactorEvidence,
        blockers: [...basePrediction.multiFactorEvidence.blockers, blocker],
      },
    };
    assert.equal(evaluateLiveRecommendation(prediction, 2.1, 0).eligible, false);
  });
}

check('a thin model lead stays reference and cannot create a live publication', () => {
  const prediction = {
    ...basePrediction,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      modelGap: 0.02,
      supportingFactors: basePrediction.multiFactorEvidence.supportingFactors
        .filter((factor) => factor !== 'model-separation'),
      blockers: ['model-separation-too-thin'],
    },
  };
  const decision = evaluateLiveRecommendation(prediction, 2.1, 0);
  assert.equal(decision.eligible, false);
  assert.ok(decision.blockers.includes('model-separation-too-thin'));
  assert.equal(buildLivePublicationEvidence(
    publicationMatch,
    prediction,
    '2026-07-16T08:00:00+08:00',
  ), null);
});

for (const [name, patch] of [
  ['null expected value', { expectedValue: null }],
  ['blank expected value', { expectedValue: '' }],
  ['missing data quality', { dataQuality: undefined }],
  ['low data quality', { dataQuality: 0.49 }],
]) {
  check(`${name} fails closed`, () => {
    const prediction = {
      ...basePrediction,
      multiFactorEvidence: {
        ...basePrediction.multiFactorEvidence,
        ...patch,
      },
    };
    assert.equal(evaluateLiveRecommendation(prediction, 2.1, 0).eligible, false);
  });
}

check('missing and excessive severe gaps fail closed', () => {
  const missing = {
    ...basePrediction,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      diagnostics: {},
    },
  };
  const excessive = {
    ...basePrediction,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      diagnostics: { severeMissingCount: 2 },
    },
  };
  assert.equal(evaluateLiveRecommendation(missing, 2.1, 0).eligible, false);
  assert.equal(evaluateLiveRecommendation(excessive, 2.1, 0).eligible, false);
});

const marketCoreEvidence = {
  ...basePrediction.multiFactorEvidence,
  evidenceScore: 60,
  probabilityEdge: 0.12,
  expectedValue: 0.1,
  dataQuality: 0.2,
  diagnostics: { severeMissingCount: 2 },
  supportingFactors: [
    'independent-model-probability',
    'model-separation',
    'model-market-edge',
    'positive-expected-value',
    'score-matrix-alignment',
    'had-hhad-consistency',
    'official-market-alignment',
  ],
};

check('market-core-limited rows remain shadow-only at every exact lower bound', () => {
  const prediction = { ...basePrediction, multiFactorEvidence: marketCoreEvidence };
  const result = evaluateLiveRecommendation(prediction, 2.1, 0);
  assert.equal(result.eligible, false);
  assert.equal(result.coverageMode, 'market-core-limited');
  assert.equal(result.dataCoverageWarning, true);
  assert.ok(result.blockers.includes('live-market-core-limited-shadow-only'));
  for (const [field, value] of [
    ['evidenceScore', 59.99],
    ['probabilityEdge', 0.1199],
    ['expectedValue', 0.0999],
    ['dataQuality', 0.1999],
  ]) {
    const failed = evaluateLiveRecommendation({
      ...basePrediction,
      multiFactorEvidence: { ...marketCoreEvidence, [field]: value },
    }, 2.1, 0);
    assert.equal(failed.eligible, false, `${field} below bound must withhold`);
  }
  assert.equal(evaluateLiveRecommendation({
    ...basePrediction,
    multiFactorEvidence: {
      ...marketCoreEvidence,
      diagnostics: { severeMissingCount: 2.01 },
    },
  }, 2.1, 0).eligible, false);
  assert.equal(evaluateLiveRecommendation({
    ...basePrediction,
    multiFactorEvidence: {
      ...marketCoreEvidence,
      supportingFactors: marketCoreEvidence.supportingFactors.slice(0, 6),
    },
  }, 2.1, 0).eligible, false);
});

check('HHAD prices above 2.05 are withheld', () => {
  const prediction = {
    ...basePrediction,
    oddsPoolCode: 'HHAD',
    handicapLine: '+1',
    odds: 2.06,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      market: 'HHAD',
      handicapLine: '+1',
      odds: 2.06,
    },
  };
  const result = evaluateLiveRecommendation(prediction, 2.06, '+1');
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes('live-hhad-high-sp-safety-hold'));
});

check('deep HHAD requires stronger quality, zero severe gaps and stronger evidence', () => {
  const lowQuality = {
    ...basePrediction,
    oddsPoolCode: 'HHAD',
    handicapLine: '-2',
    odds: 1.92,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      market: 'HHAD',
      handicapLine: '-2',
      odds: 1.92,
      evidenceScore: 63,
      dataQuality: 0.59,
      diagnostics: { severeMissingCount: 1 },
    },
  };
  const withheld = evaluateLiveRecommendation(lowQuality, 1.92, '-2');
  assert.equal(withheld.eligible, false);
  assert.ok(withheld.blockers.includes('live-deep-handicap-safety-hold'));

  const stronger = {
    ...lowQuality,
    multiFactorEvidence: {
      ...lowQuality.multiFactorEvidence,
      evidenceScore: 64,
      dataQuality: 0.6,
      diagnostics: { severeMissingCount: 0 },
    },
  };
  assert.equal(evaluateLiveRecommendation(stronger, 1.92, '-2').eligible, true);
});

check('publication evidence is official, exact and immutable-bound', () => {
  assert.ok(livePublicationEvidence);
  assert.equal(isLivePublicationEvidenceValid(publicationMatch, livePrediction, 2.1, 0), true);
  assert.equal(isLivePublicationEvidenceValid(publicationMatch, {
    ...livePrediction,
    livePublicationEvidence: { ...livePublicationEvidence, officialSp: 2.11 },
  }, 2.1, 0), false);
  assert.equal(isLivePublicationEvidenceValid(publicationMatch, {
    ...livePrediction,
    livePublicationEvidence: { ...livePublicationEvidence, code: '2' },
  }, 2.1, 0), false);
  assert.equal(buildLivePublicationEvidence({
    ...publicationMatch,
    oddsSource: 'fallback:HAD',
  }, basePrediction, '2026-07-16T08:00:00+08:00'), null);
});

check('published live pick remains visible through a temporary runtime downgrade', () => {
  const downgraded = {
    ...livePrediction,
    liveRecommendationAction: 'withhold',
    liveRecommendationTier: 'live-withhold',
    liveRecommendation: {
      ...livePrediction.liveRecommendation,
      eligible: false,
    },
    multiFactorEvidence: {
      version: basePrediction.multiFactorEvidence.version,
      market: basePrediction.multiFactorEvidence.market,
      code: basePrediction.multiFactorEvidence.code,
    },
  };
  assert.equal(isLiveRecommendationEligible(
    downgraded,
    2.1,
    0,
    publicationMatch,
    parseShanghaiDateTime('2026-07-16T08:05:00+08:00')
  ), false);
  assert.equal(isPublishedLiveRecommendationEligible(downgraded, 2.1, 0, publicationMatch), true);
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: null,
  }, 2.1, 0, publicationMatch), false);
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: { ...livePublicationEvidence, code: '2' },
  }, 2.1, 0, publicationMatch), false);
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: { ...livePublicationEvidence, officialSp: 2.11 },
  }, 2.1, 0, publicationMatch), false);
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: { ...livePublicationEvidence, matchId: 'other-match' },
  }, 2.1, 0, publicationMatch), false);
  const reconciledProviderMatch = {
    ...publicationMatch,
    id: `fivehundred_${publicationMatch.sourceMatchId}`,
  };
  const canonicalProviderPublication = {
    ...livePublicationEvidence,
    matchId: `sporttery_${publicationMatch.sourceMatchId}`,
  };
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: canonicalProviderPublication,
  }, 2.1, 0, reconciledProviderMatch), true,
  'an immutable publication survives a trusted provider-prefix reconciliation');
  assert.equal(isLivePublicationEvidenceValid(reconciledProviderMatch, {
    ...downgraded,
    livePublicationEvidence: canonicalProviderPublication,
  }, 2.1, 0), false,
  'new publication validation still requires the exact current match id');
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: {
      ...canonicalProviderPublication,
      matchId: `untrusted_${publicationMatch.sourceMatchId}`,
    },
  }, 2.1, 0, reconciledProviderMatch), false,
  'arbitrary provider prefixes never inherit a publication');
  assert.equal(isPublishedLiveRecommendationEligible({
    ...downgraded,
    livePublicationEvidence: { ...livePublicationEvidence, officialSourceUrl: 'https://example.com/odds' },
  }, 2.1, 0, publicationMatch), false);
});

check('immutable v1 publications remain retained but cannot create a new v2 live pick', () => {
  const checkedAt = parseShanghaiDateTime('2026-07-16T08:05:00+08:00');
  assert.equal(isPublishedLiveRecommendationEligible(legacyV1Published, 2.1, 0, publicationMatch), true);
  assert.equal(isLiveRecommendationEligible(legacyV1Published, 2.1, 0, publicationMatch, checkedAt), false);
  assert.equal(isLivePublicationEvidenceValid(publicationMatch, legacyV1Published, 2.1, 0), false);
});

check('published live snapshot survives current SP movement and window closure but rejects stored divergence', () => {
  const changedRuntimePrediction = {
    ...livePrediction,
    tipCode: '2',
    odds: 3.4,
    liveRecommendationAction: 'withhold',
    liveRecommendationTier: 'live-withhold',
    liveRecommendation: {
      ...livePrediction.liveRecommendation,
      eligible: false,
    },
  };
  const closedMatch = {
    ...publicationMatch,
    status: 'PENDING_RESULT',
  };
  assert.equal(isLivePublicationEvidenceValid(
    publicationMatch,
    livePrediction,
    2.2,
    0
  ), false, 'strict creation gate must reject current SP movement');
  assert.equal(isPublishedLiveRecommendationEligible(
    livePrediction,
    2.2,
    0,
    publicationMatch
  ), true, 'published SP remains an immutable display record');
  assert.equal(isPublishedLiveRecommendationEligible(
    changedRuntimePrediction,
    3.4,
    0,
    publicationMatch
  ), false, 'stored prediction direction and SP remain bound to publication evidence');
  assert.equal(isLiveRecommendationWindowOpen(
    closedMatch,
    parseShanghaiDateTime('2026-07-16T10:01:00+08:00')
  ), false);
  assert.equal(isPublishedLiveRecommendationEligible(
    livePrediction,
    2.2,
    0,
    closedMatch
  ), true, 'window closure changes record state, not record visibility');
});

check('published HHAD snapshot survives current SP and handicap-line movement', () => {
  const hhadMatch = {
    ...publicationMatch,
    id: 'sporttery_live_hhad_test',
    sourceMatchId: 'live_hhad_test',
    handicapLine: '+1',
    handicapOdds: { odds1: 1.92, oddsX: 3.4, odds2: 3.18 },
    handicapOddsSource: 'sporttery:HHAD',
    handicapOddsPoolCode: 'HHAD',
    handicapOddsObservedAt: publicationMatch.oddsObservedAt,
    handicapOddsReceivedAt: publicationMatch.oddsReceivedAt,
    handicapOddsSourceUrl: publicationMatch.oddsSourceUrl,
  };
  const hhadPrediction = {
    ...basePrediction,
    oddsPoolCode: 'HHAD',
    handicapLine: '+1',
    odds: 1.92,
    multiFactorEvidence: {
      ...basePrediction.multiFactorEvidence,
      market: 'HHAD',
      handicapLine: '+1',
      odds: 1.92,
      expectedValue: 0.12,
    },
  };
  const hhadState = evaluateLiveRecommendation(hhadPrediction, 1.92, '+1');
  const hhadPublication = buildLivePublicationEvidence(
    hhadMatch,
    hhadPrediction,
    '2026-07-16T08:00:00+08:00'
  );
  const publishedHhad = {
    ...hhadPrediction,
    liveRecommendationAction: 'recommend',
    liveRecommendationTier: `live-${String(hhadState.grade).toLowerCase()}`,
    liveRecommendation: hhadState,
    livePublicationEvidence: hhadPublication,
  };
  const movedCurrentMarket = {
    ...hhadMatch,
    handicapLine: '+2',
    handicapOdds: { ...hhadMatch.handicapOdds, odds1: 2.05 },
  };
  assert.ok(hhadPublication);
  assert.equal(isLivePublicationEvidenceValid(movedCurrentMarket, publishedHhad, 2.05, '+2'), false);
  assert.equal(isPublishedLiveRecommendationEligible(publishedHhad, 2.05, '+2', movedCurrentMarket), true);
  assert.equal(isPublishedLiveRecommendationEligible({
    ...publishedHhad,
    handicapLine: '+2',
  }, 2.05, '+2', movedCurrentMarket), false, 'stored line tampering must fail closed');
});

check('published live identity is repaired after kickoff without rewriting live metadata', () => {
  const hhadMatch = {
    ...publicationMatch,
    id: 'sporttery_live_lifecycle_repair',
    sourceMatchId: 'live_lifecycle_repair',
    handicapLine: '+1',
    handicapOdds: { odds1: 1.92, oddsX: 3.4, odds2: 3.18 },
    handicapOddsSource: 'sporttery:HHAD',
    handicapOddsPoolCode: 'HHAD',
    handicapOddsObservedAt: publicationMatch.oddsObservedAt,
    handicapOddsReceivedAt: publicationMatch.oddsReceivedAt,
    handicapOddsSourceUrl: publicationMatch.oddsSourceUrl,
  };
  const hhadEvidence = {
    ...basePrediction.multiFactorEvidence,
    market: 'HHAD',
    handicapLine: '+1',
    odds: 1.92,
    expectedValue: 0.12,
  };
  const hhadCandidate = {
    ...basePrediction,
    oddsPoolCode: 'HHAD',
    handicapLine: '+1',
    tipCode: '1',
    tipLabel: { zh: '璁╄儨', en: 'Handicap home' },
    odds: 1.92,
    multiFactorEvidence: hhadEvidence,
  };
  const publishedPrediction = {
    ...hhadCandidate,
    liveRecommendationAction: 'recommend',
    liveRecommendationTier: 'live-a',
    liveRecommendation: evaluateLiveRecommendation(hhadCandidate, 1.92, '+1'),
  };
  publishedPrediction.livePublicationEvidence = buildLivePublicationEvidence(
    hhadMatch,
    publishedPrediction,
    '2026-07-16T08:00:00+08:00'
  );
  assert.ok(publishedPrediction.livePublicationEvidence);

  const preservedLiveRecommendation = {
    ...publishedPrediction.liveRecommendation,
    eligible: false,
    grade: 'WITHHOLD',
    blockers: ['legacy-runtime-refresh'],
  };
  for (const status of ['LIVE', 'PENDING_RESULT', 'FINISHED']) {
    const driftedBest = {
      ...publishedPrediction,
      oddsPoolCode: 'HAD',
      handicapLine: '0',
      tipCode: '2',
      tipLabel: { zh: 'legacy drift', en: 'Legacy drift' },
      odds: 2.05,
      liveRecommendationAction: 'withhold',
      liveRecommendationTier: 'legacy-runtime-tier',
      liveRecommendation: preservedLiveRecommendation,
    };
    const driftedMatch = {
      ...hhadMatch,
      status,
      handicapLine: '+2',
      handicapOdds: { ...hhadMatch.handicapOdds, odds1: 2.05 },
      predictions: [driftedBest],
    };
    const repairedMatch = finalizeLiveRecommendationPublications(
      [driftedMatch],
      '2026-07-16T10:10:00+08:00'
    )[0];
    const repaired = repairedMatch.predictions[0];
    assert.equal(repaired.oddsPoolCode, 'HHAD', `${status} restores the published market`);
    assert.equal(repaired.tipCode, '1', `${status} restores the published direction`);
    assert.equal(repaired.handicapLine, '+1', `${status} restores the published line`);
    assert.equal(repaired.odds, 1.92, `${status} restores the published SP`);
    assert.equal(repaired.tipLabel.en, 'Handicap home', `${status} restores the published label`);
    assert.equal(repaired.liveRecommendationAction, 'withhold');
    assert.equal(repaired.liveRecommendationTier, 'legacy-runtime-tier');
    assert.deepEqual(repaired.liveRecommendation, preservedLiveRecommendation);
    assert.deepEqual(
      repaired.livePublicationEvidence,
      publishedPrediction.livePublicationEvidence
    );
  }
});

check('non-scheduled rows without publication evidence remain byte-for-byte untouched', () => {
  const noPublication = {
    ...publicationMatch,
    status: 'PENDING_RESULT',
    predictions: [{
      ...basePrediction,
      odds: 2.25,
      liveRecommendationAction: 'withhold',
      liveRecommendationTier: 'legacy-runtime-tier',
      liveRecommendation: null,
      livePublicationEvidence: null,
    }],
  };
  const result = finalizeLiveRecommendationPublications(
    [noPublication],
    '2026-07-16T10:10:00+08:00'
  )[0];
  assert.strictEqual(result, noPublication);
  assert.deepEqual(result, noPublication);
});

check('frontend reads direction, line and SP from the published live snapshot', () => {
  const displaySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'displayRecommendation.ts'), 'utf8');
  const listSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'PredictionsList.tsx'), 'utf8');
  assert.match(displaySource, /oddsPoolCode:\s*publishedMarket/);
  assert.match(displaySource, /tipCode:\s*publishedCode/);
  assert.match(displaySource, /odds:\s*publishedOdds/);
  assert.match(displaySource, /publicationTrack === 'formal' && isHandicapMarketContradicted/);
  assert.match(listSource, /getOnSaleDisplayRecommendation\(match, language, nowMs\) \|\| getLiveDisplayRecommendation\(match, language\)/);
  assert.match(listSource, /selectOnSaleAnalysisReference\(match, \{ allowModelOnly: true, candidate: rawDisplayRecommendation\?\.prediction, now: nowMs \}\)/);
  assert.match(listSource, /const archivedPreMatchPrediction = getArchivedPreMatchPrediction\(match, nowMs\)/);
  assert.match(listSource, /reviewPrediction \|\| displayRecommendation\?\.prediction \|\| archivedPreMatchPrediction \|\| analysisReference/);
  assert.match(listSource, /publishedMatchRecommendation\(published\.data, match\)/);
  assert.match(listSource, /usesPublishedRecommendation\(match, unifiedRow, nowMs\)/);
  assert.match(listSource, /<PublishedMatchPick row=\{unifiedRow\}/);
  assert.match(listSource, /row\.performanceTrack === 'formal'/);
});

check('unchanged direction binds once and later SP drift preserves the immutable publication', () => {
  const legacy = {
    ...publicationMatch,
    predictions: [{
      ...basePrediction,
      liveRecommendationAction: 'withhold',
      liveRecommendationTier: 'live-withhold',
      liveRecommendation: null,
      livePublicationEvidence: null,
    }],
  };
  const once = finalizeLiveRecommendationPublications(
    [legacy],
    '2026-07-16T08:00:00+08:00'
  )[0];
  const published = once.predictions[0];
  assert.equal(published.liveRecommendationAction, 'recommend');
  assert.ok(published.livePublicationEvidence);
  assert.equal(published.livePublicationEvidence.officialSp, 2.1);

  const changed = finalizeLiveRecommendationPublications([{
    ...once,
    odds: { ...once.odds, odds1: 2.2 },
    predictions: once.predictions.map((prediction) => prediction.marketType === 'BEST'
      ? { ...prediction, odds: 2.2 }
      : prediction),
  }], '2026-07-16T08:10:00+08:00')[0];
  const retained = changed.predictions[0];
  assert.equal(retained.liveRecommendationAction, 'recommend');
  assert.deepEqual(retained.livePublicationEvidence, published.livePublicationEvidence);
  assert.equal(retained.odds, 2.1, 'stored BEST SP remains the publication SP');
  assert.equal(retained.tipCode, published.tipCode);
  assert.equal(retained.oddsPoolCode, published.oddsPoolCode);
  assert.equal(isPublishedLiveRecommendationEligible(retained, 2.2, 0, changed), true);
  assert.equal(isServerLiveRecommendationEligible(retained, 2.2, {
    officialSource: true,
    officialHandicapLine: 0,
    match: changed,
    nowMs: parseShanghaiDateTime('2026-07-16T08:10:00+08:00'),
  }), false);
});

check('WATCH rows never enter live picks', () => {
  assert.equal(evaluateLiveRecommendation({ ...basePrediction, tipCode: 'WATCH' }, 2.1, 0).eligible, false);
});

check('canonical cutoff cannot extend a shorter buy-end clock', () => {
  const match = {
    status: 'SCHEDULED',
    kickoffTime: '2026-07-17T08:30:00+08:00',
    buyEndTime: '2026-07-16 22:00:00',
    predictionMeta: { cutoffTime: '2026-07-17T08:30:00+08:00' },
  };
  assert.equal(liveRecommendationCutoffMs(match), parseShanghaiDateTime('2026-07-16 22:00:00'));
  assert.equal(liveRecommendationCutoffIso(match), '2026-07-16T14:00:00.000Z');
  assert.equal(isLiveRecommendationWindowOpen(match, parseShanghaiDateTime('2026-07-16 21:59:59')), true);
  assert.equal(isLiveRecommendationWindowOpen(match, parseShanghaiDateTime('2026-07-16 22:00:01')), false);
});

check('recommendation screens honor the sale cutoff and frozen publication', () => {
  const readSource = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const listSource = readSource('src/pages/PredictionsList.tsx');
  const detailSource = readSource('src/pages/MatchDetail.tsx');
  const bestSource = readSource('src/pages/BestTips.tsx');
  const centerSource = readSource('src/components/recommendations/RecommendationCenter.tsx');
  const publishedPickSource = readSource('src/components/recommendations/PublishedMatchPick.tsx');
  const publishedViewSource = readSource('src/services/recommendationCenterView.ts');
  assert.match(listSource, /!isBeforeMatchSaleCutoff\(match, now\)/);
  assert.match(listSource, /<PublishedMatchPick row=\{unifiedRow\}/);
  assert.match(detailSource, /useUnified \? publishedDetail\?\.cutoffTime/);
  assert.match(detailSource, /liveRecommendationCutoffIso\(match\)/);
  assert.match(bestSource, /<RecommendationCenter language=\{language\}/);
  assert.match(centerSource, /useRecommendationCenter\(\)/);
  assert.match(centerSource, /data\?\.current\.filter/);
  assert.match(publishedPickSource, /now<Math\.min\(Date\.parse\(d\.cutoffTime\),Date\.parse\(d\.kickoffTime\)\)/);
  assert.match(publishedViewSource, /Date\.parse\(publishedAt\)>=Math\.min\(Date\.parse\(kickoffTime\),Date\.parse\(cutoffTime\)\)/);
});

check('snapshot round-trip preserves structured live evidence', () => {
  const tip = snapshotTip([livePrediction], 'BEST');
  const fullRestored = predictionFromSnapshotTip({ best: tip, signature: '' }, 'BEST');
  assert.equal(fullRestored.livePublicationEvidence.officialOddsClockSource, livePublicationEvidence.officialOddsClockSource);

  const compactedTip = {
    ...tip,
    livePublicationEvidence: { ...tip.livePublicationEvidence },
  };
  delete compactedTip.livePublicationEvidence.officialOddsObservedAt;
  delete compactedTip.livePublicationEvidence.officialOddsReceivedAt;
  delete compactedTip.livePublicationEvidence.officialOddsClockSource;
  delete compactedTip.livePublicationEvidence.officialOddsMaxAgeSeconds;
  const snapshotMarketProof = {
    sourceMatchId: 'live_test',
    featureSnapshot: {
      market: {
        had: {
          odds: publicationMatch.odds,
          source: publicationMatch.oddsSource,
          observedAt: publicationMatch.oddsObservedAt,
          receivedAt: publicationMatch.oddsReceivedAt,
          provenance: {
            market: { sourceMatchId: publicationMatch.sourceMatchId },
            endpoint: { url: publicationMatch.oddsSourceUrl },
          },
        },
      },
    },
  };
  const restored = predictionFromSnapshotTip({
    ...snapshotMarketProof,
    best: compactedTip,
    signature: '',
  }, 'BEST');
  assert.equal(restored.liveRecommendationAction, 'recommend');
  assert.equal(restored.liveRecommendation.version, LIVE_RECOMMENDATION_POLICY_VERSION);
  assert.equal(restored.liveRecommendation.statisticsTrack, 'live-model');
  assert.equal(restored.liveRecommendation.expectedValue, state.expectedValue);
  assert.equal(restored.livePublicationEvidence.officialSp, 2.1);
  assert.equal(restored.livePublicationEvidence.publishedAt, livePublicationEvidence.publishedAt);
  assert.equal(
    restored.livePublicationEvidence.officialOddsObservedAt,
    livePublicationEvidence.officialOddsObservedAt
  );
  assert.equal(
    restored.livePublicationEvidence.officialOddsReceivedAt,
    livePublicationEvidence.officialOddsReceivedAt
  );
  assert.equal(
    restored.livePublicationEvidence.officialOddsClockSource,
    livePublicationEvidence.officialOddsClockSource
  );
  assert.equal(
    restored.livePublicationEvidence.officialOddsMaxAgeSeconds,
    livePublicationEvidence.officialOddsMaxAgeSeconds
  );
  const tamperedMarketRestored = predictionFromSnapshotTip({
    ...snapshotMarketProof,
    featureSnapshot: {
      market: {
        had: {
          ...snapshotMarketProof.featureSnapshot.market.had,
          odds: { ...publicationMatch.odds, odds1: 2.11 },
        },
      },
    },
    best: compactedTip,
    signature: '',
  }, 'BEST');
  assert.equal(tamperedMarketRestored.livePublicationEvidence.officialOddsClockSource, null);

  const snapshotIndex = new Map([[
    'live_test',
    [{
      sourceMatchId: 'live_test',
      matchId: 'sporttery_live_test',
      phase: 'locked',
      capturedAt: '2026-07-16T08:00:00+08:00',
      cutoffTime: '2026-07-16 09:00:00',
      kickoffTime: '2026-07-16T10:00:00+08:00',
      ...snapshotMarketProof,
      best: compactedTip,
      signature: 'BEST:HAD:1:live-model',
    }, {
      sourceMatchId: 'live_test',
      matchId: 'sporttery_live_test',
      phase: 'locked',
      capturedAt: '2026-07-16T08:30:00+08:00',
      cutoffTime: '2026-07-16 09:00:00',
      kickoffTime: '2026-07-16T10:00:00+08:00',
      ...snapshotMarketProof,
      best: snapshotTip([{
        ...basePrediction,
        recommendationAction: 'recommend',
        publicationId: 'forged-formal-publication',
        publicationEvidence: { version: 'forged-binding' },
      }], 'BEST'),
      signature: 'BEST:HAD:1:reference',
    }],
  ]]);
  const review = buildPostMatchReview({
    id: 'fivehundred_live_test',
    sourceMatchId: 'live_test',
    matchNo: '001',
    status: 'FINISHED',
    effectiveStatus: 'FINISHED',
    kickoffTime: '2026-07-16T10:00:00+08:00',
    buyEndTime: '2026-07-16 09:00:00',
    scoreHome: 1,
    scoreAway: 0,
    resultProvenance: {
      provider: 'sporttery', official: true, trusted: true,
      observedAt: '2026-07-16T12:00:00+08:00', observationSource: 'sporttery:result',
    },
    predictions: [],
  }, '2026-07-16T12:01:00+08:00', snapshotIndex);
  assert.equal(review.predictionReview.liveSettled, 1);
  assert.equal(review.predictionReview.liveWon, 1);
  assert.equal(review.predictionReview.rows[0].performanceTrack, 'live-model');
  assert.equal(review.predictionReview.rows[0].publicationId, null);
  assert.equal(
    review.predictionReview.rows[0].livePublicationEvidence.publishedAt,
    livePublicationEvidence.publishedAt
  );
});

check('settlement writes live metrics without formal denominator pollution', () => {
  const settledMatch = {
    id: 'fivehundred_live_test',
    sourceMatchId: 'live_test',
    matchNo: '001',
    status: 'FINISHED',
    effectiveStatus: 'FINISHED',
    kickoffTime: '2026-07-16T10:00:00+08:00',
    buyEndTime: '2026-07-16 09:00:00',
    homeTeamName: '主队',
    awayTeamName: '客队',
    scoreHome: 1,
    scoreAway: 0,
    resultObservedAt: '2026-07-16T12:00:00+08:00',
    resultObservationSource: 'sporttery:result',
    resultProvenance: {
      provider: 'sporttery',
      official: true,
      trusted: true,
      observedAt: '2026-07-16T12:00:00+08:00',
      observationSource: 'sporttery:result',
    },
    predictions: [livePrediction],
  };
  const firstAttachment = attachPostMatchReviews(
    [settledMatch],
    '2026-07-16T12:01:00+08:00'
  );
  const review = firstAttachment.matches[0].postMatchReview;
  assert.ok(review);
  assert.equal(review.predictionReview.mainSettled, 0);
  assert.equal(review.predictionReview.liveSettled, 1);
  assert.equal(review.predictionReview.liveWon, 1);
  assert.equal(review.predictionReview.liveBestStatus, 'WON');
  assert.equal(review.predictionReview.rows[0].performanceTrack, 'live-model');
  assert.equal(review.predictionReview.rows[0].recommendationAction, 'reference');

  const secondAttachment = attachPostMatchReviews(
    firstAttachment.matches,
    '2026-07-16T12:09:00+08:00'
  );
  const repeatedReview = secondAttachment.matches[0].postMatchReview;
  assert.equal(repeatedReview.predictionReview.liveSettled, 1);
  assert.equal(repeatedReview.predictionReview.liveWon, 1);
  assert.equal(repeatedReview.predictionReview.rows[0].performanceTrack, 'live-model');
  assert.equal(
    repeatedReview.predictionReview.rows[0].livePublicationEvidence.officialOddsClockSource,
    livePublicationEvidence.officialOddsClockSource
  );
  assert.equal(
    repeatedReview.predictionReview.rows[0].livePublicationEvidence.officialOddsMaxAgeSeconds,
    livePublicationEvidence.officialOddsMaxAgeSeconds
  );
});

check('legacy live flags without publication evidence never enter live statistics', () => {
  const review = buildPostMatchReview({
    id: 'sporttery_live_test',
    sourceMatchId: 'live_test',
    matchNo: '001',
    status: 'FINISHED',
    effectiveStatus: 'FINISHED',
    kickoffTime: '2026-07-16T10:00:00+08:00',
    buyEndTime: '2026-07-16 09:00:00',
    homeTeamName: 'legacy-home',
    awayTeamName: 'legacy-away',
    scoreHome: 1,
    scoreAway: 0,
    resultObservedAt: '2026-07-16T12:00:00+08:00',
    resultObservationSource: 'sporttery:result',
    resultProvenance: {
      provider: 'sporttery', official: true, trusted: true,
      observedAt: '2026-07-16T12:00:00+08:00', observationSource: 'sporttery:result',
    },
    predictions: [{ ...livePrediction, livePublicationEvidence: null }],
  }, '2026-07-16T12:01:00+08:00');
  assert.ok(review);
  assert.equal(review.predictionReview.liveSettled, 0);
  assert.equal(review.predictionReview.referenceSettled, 0);
  assert.deepEqual(review.predictionReview.rows, []);
});

check('unsnapshotted mutable references never enter settled performance', () => {
  const match = {
    id: 'fivehundred_reference_without_snapshot',
    sourceMatchId: 'reference_without_snapshot',
    matchNo: '002',
    status: 'FINISHED',
    effectiveStatus: 'FINISHED',
    kickoffTime: '2026-07-16T10:00:00+08:00',
    buyEndTime: '2026-07-16 09:00:00',
    homeTeamName: 'home',
    awayTeamName: 'away',
    scoreHome: 1,
    scoreAway: 0,
    resultObservedAt: '2026-07-16T12:00:00+08:00',
    resultObservationSource: 'sporttery:result',
    resultProvenance: {
      provider: 'sporttery', official: true, trusted: true,
      observedAt: '2026-07-16T12:00:00+08:00', observationSource: 'sporttery:result',
    },
    predictions: [basePrediction],
  };
  const withoutSnapshot = buildPostMatchReview(match, '2026-07-16T12:01:00+08:00');
  assert.ok(withoutSnapshot);
  assert.equal(withoutSnapshot.predictionReview.referenceSettled, 0);
  assert.deepEqual(withoutSnapshot.predictionReview.rows, []);

  const snapshotIndex = new Map([[
    match.sourceMatchId,
    [{
      sourceMatchId: match.sourceMatchId,
      matchId: `sporttery_${match.sourceMatchId}`,
      phase: 'locked',
      capturedAt: '2026-07-16T08:30:00+08:00',
      cutoffTime: match.buyEndTime,
      kickoffTime: match.kickoffTime,
      best: snapshotTip([basePrediction], 'BEST'),
      signature: 'BEST:HAD:1:reference',
    }],
  ]]);
  const withSnapshot = buildPostMatchReview(
    match,
    '2026-07-16T12:01:00+08:00',
    snapshotIndex
  );
  assert.ok(withSnapshot);
  assert.equal(withSnapshot.predictionReview.referenceSettled, 1);
  assert.equal(withSnapshot.predictionReview.referenceBestStatus, 'WON');
});

(async () => {
  const dbPath = path.join(__dirname, '..', 'server-data', 'football.db');
  const matches = await readSqliteCurrentMatches(dbPath, { limit: 100 });
  const now = Date.now();
  const qualified = [];
  const publishedQualified = [];
  const retainedPublished = [];
  const regeneratedQualified = [];
  const legacyEligibleWithoutEvidence = [];
  for (const match of matches) {
    const prediction = (match.predictions || []).find((row) => row.marketType === 'BEST');
    if (!prediction) continue;
    const line = prediction.oddsPoolCode === 'HHAD' ? match.handicapLine : 0;
    const officialOdds = officialOddsForLivePrediction(match, prediction);
    if (isPublishedLiveRecommendationEligible(prediction, officialOdds, line, match)) {
      retainedPublished.push({
        matchId: match.id,
        pool: prediction.livePublicationEvidence.market,
        tipCode: prediction.livePublicationEvidence.code,
        line: prediction.livePublicationEvidence.handicapLine,
        publishedSp: prediction.livePublicationEvidence.officialSp,
        status: match.status,
      });
    }
    if (prediction.tipCode === 'WATCH') continue;
    const live = evaluateLiveRecommendation(prediction, officialOdds, line);
    const officialSource = hasOfficialSportterySourceForLivePrediction(match, prediction);
    if (live.eligible && officialSource && !prediction.livePublicationEvidence) {
      legacyEligibleWithoutEvidence.push(match.id);
    }
    if (isServerLiveRecommendationEligible(prediction, officialOdds, {
      officialSource,
      officialHandicapLine: line,
      match,
      nowMs: now,
    }) && isLiveRecommendationWindowOpen(match, now)) {
      qualified.push(match.id);
    }
    if (
      hasOfficialSportterySourceForLivePrediction(match, prediction)
      && isPublishedLiveRecommendationEligible(prediction, officialOdds, line, match)
      && isLiveRecommendationWindowOpen(match, now)
    ) {
      publishedQualified.push(match.id);
    }
    const simulatedPublishedAt = liveRecommendationCutoffMs(match) - 60_000;
    const publication = buildLivePublicationEvidence(match, prediction, simulatedPublishedAt);
    if (!publication) continue;
    const regeneratedPrediction = {
      ...prediction,
      liveRecommendationAction: 'recommend',
      liveRecommendationTier: `live-${String(live.grade || 'c').toLowerCase()}`,
      liveRecommendation: live,
      livePublicationEvidence: publication,
    };
    if (!isServerLiveRecommendationEligible(regeneratedPrediction, officialOdds, {
      officialSource,
      officialHandicapLine: line,
      match,
      nowMs: simulatedPublishedAt,
    })) continue;
    regeneratedQualified.push({
      matchId: match.id,
      pool: prediction.oddsPoolCode,
      tipCode: prediction.tipCode,
      line: prediction.oddsPoolCode === 'HHAD' ? match.handicapLine : '0',
      odds: prediction.odds,
      evidenceScore: live.evidenceScore,
      probabilityEdge: live.probabilityEdge,
      expectedValue: live.expectedValue,
      grade: live.grade,
      coverageMode: live.coverageMode,
      dataCoverageWarning: live.dataCoverageWarning,
      cutoffAt: new Date(liveRecommendationCutoffMs(match)).toISOString(),
    });
  }
  check('legacy SQLite rows are distinguished from newly publication-bound rows', () => {
    assert.ok(qualified.length <= 3, 'live page must remain a small selected set');
    assert.equal(legacyEligibleWithoutEvidence.length, 0, 'final current publication must bind the eligible legacy row once');
    assert.ok(regeneratedQualified.length <= 3, 'live page must remain a small selected set');
    assert.ok(regeneratedQualified.every((row) => row.tipCode !== 'WATCH'));
    const matchById = new Map(matches.map((match) => [match.id, match]));
    const currentIds = new Set(matchById.keys());
    if (currentIds.has('sporttery_2040520')) {
      assert.equal(regeneratedQualified.some((row) => row.matchId === 'sporttery_2040520'), false);
    }
    if (currentIds.has('sporttery_2040522')) {
      const match = matchById.get('sporttery_2040522');
      const prediction = (match?.predictions || []).find((row) => row.marketType === 'BEST');
      const freshAtRuntime = officialOddsFreshnessForLivePrediction(match, prediction, now).eligible;
      if (!freshAtRuntime) assert.equal(qualified.includes('sporttery_2040522'), false);
    }
  });

  const runtimeAudit = buildLiveRecommendationAuditSummary(matches, new Date(now).toISOString());
  check('sync runtime audit exposes the exact immutable published recommendation set', () => {
    assert.equal(runtimeAudit.qualifiedCount, publishedQualified.length);
    assert.deepEqual(runtimeAudit.rows.map((row) => row.matchId), publishedQualified);
    assert.ok(runtimeAudit.rows.every((row) => (
      row.officialSp > 1
      && row.evidenceScore >= 45
      && row.publishedAt
      && row.cutoffAt
    )));
  });

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.cjs'), 'utf8');
  check('server performs independent live source and cutoff validation', () => {
    assert.match(serverSource, /isServerLiveRecommendationEligible/);
    assert.match(serverSource, /isLiveRecommendationWindowOpen\(match, nowMs\)/);
    assert.match(serverSource, /officialOddsFreshnessForLivePrediction\(match, prediction, nowMs\)/);
    assert.match(serverSource, /official-sp-clock-missing-or-stale/);
    assert.match(serverSource, /unverified-official-source/);
  });
  check('current-list compact rows preserve every immutable live publication identity field', () => {
    const compactStart = serverSource.indexOf('const compactPredictionForCurrentList =');
    const compactEnd = serverSource.indexOf('const compactTrendTextForList =', compactStart);
    const compactSource = serverSource.slice(compactStart, compactEnd);
    assert.ok(compactStart >= 0 && compactEnd > compactStart);
    assert.match(compactSource, /oddsPoolCode: prediction\.oddsPoolCode/);
    assert.match(compactSource, /handicapLine: prediction\.handicapLine/);
    assert.match(compactSource, /tipCode: prediction\.tipCode/);
    assert.match(compactSource, /odds: prediction\.odds/);
    assert.match(compactSource, /livePublicationEvidence: prediction\.livePublicationEvidence/);
  });

  console.log(JSON.stringify({
    ok: true,
    version: LIVE_RECOMMENDATION_POLICY_VERSION,
    checks: checks.length,
    sqliteRows: matches.length,
    qualifiedCount: qualified.length,
    qualified,
    publishedQualifiedCount: publishedQualified.length,
    publishedQualified,
    retainedPublishedCount: retainedPublished.length,
    retainedPublished,
    legacyEligibleWithoutEvidence,
    regeneratedQualifiedCount: regeneratedQualified.length,
    regeneratedQualified,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
