'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { selectOnSaleAnalysisReference } = require('../src/services/analysisReferenceSelection.ts');
const { getListHandicapSupplement, getAnalysisReferenceHandicapSupplement } = require('../src/services/displayRecommendation.ts');
const { getArchivedPreMatchPrediction } = require('../src/services/archivedPreMatchPrediction.ts');
const { isLegacyCurrentRecommendationRetired } = require('../src/services/recommendationAuthorityPresentation.ts');
const { buildImmutableAnalysisReferenceDecision } = require('../src/services/immutableAnalysisReferenceDecision.cjs');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const at = offset => new Date(NOW + offset).toISOString();
const marker = { version: 'recommendation-publication-authority-v1', mode: 'reviewed-and-trained', legacyCurrentEnabled: false };
const retirement = match => ({ ...match, recommendationAuthority: marker });
const prediction = { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '2', odds: 4.75,
  tipLabel: { zh: '客胜', en: 'Away' }, recommendationAction: 'reference', trustScore: 45,
  explanation: { zh: '', en: '' }, visibilityStatus: 'FREE', resultStatus: 'PENDING' };
const fixture = () => ({
  id: 'sporttery_2041870', sourceMatchId: '2041870', status: 'SCHEDULED',
  homeTeamId: 'authority-home', awayTeamId: 'authority-away', homeTeamName: 'Home', awayTeamName: 'Away',
  kickoffTime: at(14400000), eventVersion: at(14400000), buyEndTime: at(12600000),
  odds: { odds1: 1.56, oddsX: 3.6, odds2: 4.75 }, oddsSource: 'sporttery:HAD', oddsUpdatedAt: at(-60000),
  predictions: [],
  probabilityModel: { inputSufficiency: { sufficient: true }, oneXTwo: { final: { home: 55, draw: 25, away: 20 } },
    unifiedPosterior: { generatedAt: at(-60000), selectedMarket: 'HAD', selectedCode: '1', selectedProbability: 0.55 } },
});
const publicReferenceFixture = () => {
  const match = fixture();
  match.predictionMeta = { publicReferenceDecision: {
    version: 'public-reference-decision-v2', integrityVerified: true, contentHash: 'a'.repeat(64),
    sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime, eventVersion: match.eventVersion,
    recordedAt: at(-60000), decisionAt: at(-120000), cutoffTime: match.buyEndTime, prediction,
  } };
  return match;
};
const atomicFixture = () => ({ ...fixture(), predictionMeta: { dualMarketDecision: {
  version: 'dual-market-decision-binding-v1', decisionSnapshotVersion: 'candidate-decision-snapshot-v2',
  sourceCycleId: 'verified-fixture-cycle', bindingHash: 'a'.repeat(64), publicBindingVersion: 'dual-market-public-binding-v1',
  publicBindingHash: 'b'.repeat(64), integrityVerified: true, integrityVersion: 'dual-market-decision-integrity-v1',
  sourceClocks: { decisionAt: at(-120000), cutoffTime: at(12600000), hadObservedAt: at(-180000), hadReceivedAt: at(-150000) },
  strategyVersions: { predictionPolicy: 'policy-v1', model: 'model-v1', calibration: 'calibration-v1' },
  had: { poolCode: 'HAD', code: '1', odds: 1.47, modelProbability: 0.509, marketProbability: 0.603, recommendationAction: 'reference' },
} } });
const immutableFixture = () => {
  const match = { ...fixture(), odds: { odds1: 1 / 0.30, oddsX: 1 / 0.29, odds2: 1 / 0.41, updatedAt: at(-60000) },
    oddsSource: '500.com:HAD', probabilityModel: { inputSufficiency: { sufficient: false },
      oneXTwo: { final: { home: 45, draw: 30, away: 25 } },
      unifiedPosterior: { generatedAt: at(-60000), selectedMarket: 'MODEL_ONLY_1X2', selectedCode: '1', selectedProbability: 45 } } };
  const decision = buildImmutableAnalysisReferenceDecision(match, at(0));
  assert.ok(decision);
  return { ...match, predictionMeta: { immutableAnalysisReferenceDecision: decision } };
};

for (const [name, make, source] of [
  ['public reference record', publicReferenceFixture, 'published-reference'],
  ['atomic dual market record', atomicFixture, 'atomic-dual-market-reference'],
  ['immutable analysis record', immutableFixture, 'immutable-five-hundred-market'],
  ['probability model fallback', fixture, 'model-low-evidence'],
]) {
  test(`retirement prevents ${name} from recreating a current direction despite empty predictions`, () => {
    const match = make(), before = JSON.stringify(match);
    assert.equal(match.predictions.length, 0);
    const baseline = selectOnSaleAnalysisReference(match, { now: NOW, allowModelOnly: true });
    assert.equal(baseline?.source, source);
    assert.ok(['1', 'X', '2'].includes(baseline?.prediction.tipCode));
    for (const clock of [NOW, Date.parse(match.buyEndTime) + 1]) {
      for (const allowModelOnly of [false, true]) {
        assert.equal(selectOnSaleAnalysisReference(retirement(match), { now: clock, allowModelOnly }), undefined);
      }
    }
    assert.equal(JSON.stringify(match), before, 'presentation suppression cannot rewrite stored decisions or model inputs');
  });
}

test('only the complete retirement marker suppresses existing selectors; it grants no recommendation', () => {
  const match = publicReferenceFixture(), expected = selectOnSaleAnalysisReference(match, { now: NOW });
  for (const value of [undefined, null, {}, { ...marker, version: 'unrecognized' },
    { ...marker, mode: 'legacy' }, { ...marker, legacyCurrentEnabled: true }]) {
    const input = { ...match, recommendationAuthority: value };
    assert.equal(isLegacyCurrentRecommendationRetired(input), false);
    assert.deepEqual(selectOnSaleAnalysisReference(input, { now: NOW }), expected);
  }
  assert.equal(isLegacyCurrentRecommendationRetired(retirement(match)), true);
  assert.equal(selectOnSaleAnalysisReference(retirement(match), { now: NOW }), undefined);
});

test('retirement suppresses synthesized handicap companions through both public entrypoints', () => {
  const match = { ...fixture(), handicapLine: '-1', handicapOdds: { odds1: 2, oddsX: 3.5, odds2: 3.5 },
    handicapOddsSource: 'sporttery:HHAD', probabilityModel: { ...fixture().probabilityModel,
      handicap: { line: '-1', market: { home: 55, draw: 20, away: 25 }, poisson: { home: 58, draw: 20, away: 22 } } } };
  assert.ok(getListHandicapSupplement(match, 'zh'), 'fixture must exercise a real model/market fallback');
  assert.equal(getListHandicapSupplement(retirement(match), 'zh'), null);
  assert.equal(getAnalysisReferenceHandicapSupplement(retirement(match), 'zh', undefined, undefined), null);
});

test('valid existing archives retain original direction and SP in live and result phases after retirement', () => {
  const match = fixture();
  match.archivedPreMatchPrediction = {
    version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
    sourceMatchId: match.sourceMatchId, eventVersion: match.eventVersion, kickoffTime: match.kickoffTime,
    cutoffTime: match.buyEndTime, capturedAt: at(-60000), prediction,
  };
  assert.equal(getArchivedPreMatchPrediction(retirement(match), NOW), undefined);
  for (const status of ['LIVE', 'PENDING_RESULT', 'FINISHED', 'SCHEDULED']) {
    const current = retirement({ ...match, status }), before = JSON.stringify(current.archivedPreMatchPrediction);
    const archived = getArchivedPreMatchPrediction(current, Date.parse(match.kickoffTime) + 1);
    assert.equal(archived?.tipCode, prediction.tipCode);
    assert.equal(archived?.odds, prediction.odds);
    assert.equal(JSON.stringify(current.archivedPreMatchPrediction), before);
  }
});
