const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildProbabilityModel,
  buildPostMatchReview,
  fallbackPredictionsFromSnapshots,
  mergeReviewPredictionsWithSnapshot,
  parseHandicapLine,
  postMatchReviewActuals,
  predictionSet,
  resolveHandicapLine,
  resultStatus,
  settlePredictionsForMatch,
  sportteryPoolOdds,
} = require('./syncData.cjs');

const finished = (scoreHome, scoreAway, handicapLine, extra = {}) => ({
  id: `test-${scoreHome}-${scoreAway}-${String(handicapLine)}`,
  sourceMatchId: `source-${scoreHome}-${scoreAway}-${String(handicapLine)}`,
  status: 'FINISHED',
  scoreHome,
  scoreAway,
  resultProvenance: {
    provider: 'sporttery',
    official: true,
    trusted: true,
    scoreHome,
    scoreAway,
  },
  handicapLine,
  predictions: [],
  ...extra,
});

const hhadPrediction = (tipCode, handicapLine) => ({
  marketType: '1X2',
  oddsPoolCode: 'HHAD',
  handicapLine,
  tipCode,
  odds: 2,
  recommendationAction: 'reference',
  recommendationTier: 'reference',
  resultStatus: 'PENDING',
});

for (const invalid of [
  null,
  undefined,
  '',
  '   ',
  '+',
  '-',
  '\u2212',
  '\uFF0D',
  '.',
  '+.',
  '--',
  '\u8BA9\u7403 -',
  '0/0.5',
  '1abc2',
  'home1',
  '1away',
  '1..2',
  '--1',
  '+ 1',
]) {
  assert.equal(parseHandicapLine(invalid), null, `invalid line must stay null: ${String(invalid)}`);
}

for (const explicitZero of [0, '0', '+0', '-0', '\u8BA9\u7403 0']) {
  assert.equal(parseHandicapLine(explicitZero), 0, `explicit zero must remain valid: ${String(explicitZero)}`);
}

assert.equal(parseHandicapLine('\u8BA9\u7403 -1.00'), -1);
assert.equal(parseHandicapLine('HHAD: +1'), 1);
assert.equal(parseHandicapLine('-1\u7403'), -1);
assert.equal(parseHandicapLine('\uFF0B1'), 1);
assert.equal(parseHandicapLine('1-2'), null);

const minusOne = finished(2, 1, '-1');
assert.equal(resultStatus(minusOne, 'X', 'HHAD'), 'WON', '-1: 2-1 must settle as handicap draw');
assert.equal(resultStatus(minusOne, '1', 'HHAD'), 'LOST');
assert.equal(resultStatus(minusOne, '2', 'HHAD'), 'LOST');

const minusTwo = finished(2, 1, '-2');
assert.equal(resultStatus(minusTwo, '2', 'HHAD'), 'WON', '-2: 2-1 must settle as handicap away');

const plusOne = finished(0, 1, '+1');
assert.equal(resultStatus(plusOne, 'X', 'HHAD'), 'WON', '+1: 0-1 must settle as handicap draw');

const zeroLine = finished(2, 1, '0');
assert.equal(resultStatus(zeroLine, '1', 'HHAD'), 'WON', 'an explicit zero line must still settle');

for (const missing of [undefined, null, '', '-', '+']) {
  const match = finished(2, 1, missing);
  assert.equal(resultStatus(match, '1', 'HHAD'), 'PENDING', `missing line must not settle: ${String(missing)}`);
  assert.equal(postMatchReviewActuals(match).hhad, null, `missing line must not create an actual HHAD: ${String(missing)}`);
}

const predictionWinsPriority = finished(2, 1, '-1', {
  predictions: [hhadPrediction('2', '-2')],
});
assert.equal(resolveHandicapLine(predictionWinsPriority, predictionWinsPriority.predictions), -2);
assert.equal(settlePredictionsForMatch(predictionWinsPriority, predictionWinsPriority.predictions)[0].resultStatus, 'WON');

const spainFallback = finished(2, 1, undefined, {
  homeTeamName: 'Spain',
  awayTeamName: 'Belgium',
  externalSignals: {
    handicapLine: '-1',
    bookmakerOdds: {
      hhad: {
        odds1: 2.68,
        oddsX: 3.06,
        odds2: 2.33,
        handicapLine: '-1',
      },
    },
  },
});
assert.equal(resolveHandicapLine(spainFallback), -1);
assert.equal(postMatchReviewActuals(spainFallback).hhad, 'X', 'Spain 2-1 must resolve to handicap draw from traced HHAD data');

const conflictingExternalLine = finished(2, 1, undefined, {
  externalSignals: {
    handicapLine: '-2',
    bookmakerOdds: {
      hhad: { odds1: 2.1, oddsX: 3.1, odds2: 3.2, handicapLine: '-1' },
    },
  },
});
assert.equal(resolveHandicapLine(conflictingExternalLine), -1, 'bookmaker HHAD line must beat a conflicting generic external line');

const tracedGenericExternalLine = finished(2, 1, undefined, {
  externalSignals: {
    handicapLine: '-1',
    bookmakerOdds: {
      hhad: { odds1: 2.1, oddsX: 3.1, odds2: 3.2 },
    },
  },
});
assert.equal(resolveHandicapLine(tracedGenericExternalLine), -1, 'generic line may fill a missing bookmaker line when HHAD odds trace it');

const untracedGenericExternalLine = finished(2, 1, undefined, {
  externalSignals: {
    handicapLine: '-1',
    bookmakerOdds: { hhad: {} },
  },
});
assert.equal(resolveHandicapLine(untracedGenericExternalLine), null, 'an empty hhad object is not enough to trust a generic line');

const markedGenericExternalLine = finished(2, 1, undefined, {
  externalSignals: {
    handicapLine: '-1',
    oddsPoolCode: 'HHAD',
  },
});
assert.equal(resolveHandicapLine(markedGenericExternalLine), -1, 'an explicit HHAD marker may qualify the generic line');

const externalHadZero = finished(0, 0, undefined, {
  externalSignals: {
    handicapLine: '0',
    bookmakerOdds: {
      had: { odds1: 2.1, oddsX: 3.1, odds2: 3.2 },
    },
  },
});
assert.equal(resolveHandicapLine(externalHadZero), null, 'external HAD zero must never be promoted to an HHAD line');

const invalidReview = buildPostMatchReview(finished(2, 1, undefined), new Date().toISOString());
assert.equal(invalidReview.actual.hhad, null, 'post-match review must remove unauditable HHAD actuals');

const snapshotLineReviewMatch = finished(2, 1, undefined, {
  predictions: [hhadPrediction('X', '-1')],
});
const predictionLineReview = buildPostMatchReview(snapshotLineReviewMatch, new Date().toISOString());
assert.equal(predictionLineReview.actual.hhad.code, 'X');
assert.equal(predictionLineReview.actual.hhad.handicapLine, '-1');
assert.deepEqual(
  predictionLineReview.predictionReview.rows,
  [],
  'a mutable HHAD direction without a pre-match snapshot must not enter performance'
);

const snapshotMatch = finished(2, 1, undefined, {
  sourceMatchId: 'snapshot-match',
  kickoffTime: '2026-07-11T19:00:00+08:00',
  buyEndTime: '2026-07-11T18:00:00+08:00',
  predictions: [{ ...hhadPrediction('2', '-2'), marketType: 'BEST' }],
});
const snapshot = (capturedAt, phase, line, tipCode = 'X') => ({
  sourceMatchId: 'snapshot-match',
  capturedAt,
  cutoffTime: '2026-07-11T18:00:00+08:00',
  phase,
  signature: `BEST:HHAD:${tipCode}:reference`,
  best: {
    tipCode,
    oddsPoolCode: 'HHAD',
    handicapLine: line,
    odds: 2,
    recommendationAction: 'reference',
    recommendationTier: 'reference',
  },
});
const safeSnapshot = snapshot('2026-07-11T17:30:00+08:00', 'final', '-1');
const afterCutoffSnapshot = snapshot('2026-07-11T18:30:00+08:00', 'final', '-2', '2');
const reviewSnapshot = snapshot('2026-07-11T17:45:00+08:00', 'review', '-2', '2');
const afterKickoffSnapshot = snapshot('2026-07-11T19:10:00+08:00', 'locked', '-2', '2');
const snapshotIndex = new Map([[
  'snapshot-match',
  [safeSnapshot, afterCutoffSnapshot, reviewSnapshot, afterKickoffSnapshot],
]]);
const restoredPredictions = fallbackPredictionsFromSnapshots(snapshotMatch, snapshotIndex);
assert.equal(restoredPredictions.length, 1);
assert.equal(restoredPredictions[0].handicapLine, '-1', 'only the latest qualified pre-cutoff snapshot may be restored');
assert.equal(restoredPredictions[0].tipCode, 'X');

const snapshotPreferredReview = buildPostMatchReview(snapshotMatch, new Date().toISOString(), snapshotIndex);
assert.equal(snapshotPreferredReview.actual.hhad.code, 'X', 'qualified snapshot HHAD line must override current non-WATCH content for review');
assert.equal(snapshotPreferredReview.actual.hhad.handicapLine, '-1');
assert.equal(snapshotPreferredReview.predictionReview.rows[0].tipCode, 'X');
assert.equal(snapshotPreferredReview.predictionReview.rows[0].resultStatus, 'WON');

const snapshotWithoutLine = snapshot('2026-07-11T17:40:00+08:00', 'final', undefined, 'X');
const snapshotOnlyPredictions = fallbackPredictionsFromSnapshots(
  snapshotMatch,
  new Map([['snapshot-match', [snapshotWithoutLine]]])
);
const isolatedSnapshotPredictions = mergeReviewPredictionsWithSnapshot(
  [
    { ...hhadPrediction('2', '-2'), marketType: 'BEST' },
    { marketType: 'GOALS', tipCode: 'O2.5', odds: 1.9, recommendationAction: 'reference' },
  ],
  snapshotOnlyPredictions
);
assert.equal(isolatedSnapshotPredictions.length, 1, 'a qualified snapshot must not inherit markets absent from the snapshot');
assert.equal(isolatedSnapshotPredictions[0].tipCode, 'X');
assert.equal(isolatedSnapshotPredictions[0].handicapLine, undefined, 'snapshot HHAD without a line must not borrow the current line');
const unresolvedSnapshotReview = buildPostMatchReview(
  snapshotMatch,
  new Date().toISOString(),
  new Map([['snapshot-match', [snapshotWithoutLine]]])
);
assert.equal(unresolvedSnapshotReview.actual.hhad, null, 'snapshot HHAD without its captured line must not be settled');
assert.equal(unresolvedSnapshotReview.predictionReview.rows[0].resultStatus, 'PENDING');

const mutableLineSnapshotMatch = {
  ...snapshotMatch,
  handicapLine: '-2',
  externalSignals: {
    handicapLine: '-2',
    oddsPoolCode: 'HHAD',
    bookmakerOdds: {
      hhad: { odds1: 2.1, oddsX: 3.1, odds2: 3.2, handicapLine: '-2' },
    },
  },
};
const isolatedMissingLineReview = buildPostMatchReview(
  mutableLineSnapshotMatch,
  new Date().toISOString(),
  new Map([['snapshot-match', [snapshotWithoutLine]]])
);
assert.equal(
  isolatedMissingLineReview.actual.hhad,
  null,
  'snapshot HHAD without its own line must not borrow mutable match or external lines'
);
assert.equal(isolatedMissingLineReview.predictionReview.rows[0].resultStatus, 'PENDING');

const unsafeOnlyIndex = new Map([['snapshot-match', [afterCutoffSnapshot, reviewSnapshot, afterKickoffSnapshot]]]);
assert.deepEqual(fallbackPredictionsFromSnapshots({ ...snapshotMatch, predictions: [] }, unsafeOnlyIndex), []);

const zeroHandicapModel = buildProbabilityModel(
  { sourceMatchId: 'zero-line-model', handicapLine: 0 },
  { home: 0.4, draw: 0.3, away: 0.3 },
  { home: 0.4, draw: 0.3, away: 0.3 },
  1.2,
  1.0,
  0.48,
  0.5,
  null,
  {},
  null
);
assert.equal(zeroHandicapModel.handicap.line, '0', 'numeric zero line must retain a handicap model');

const currentMatches = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'public', 'data', 'matches-current.json'),
  'utf8'
));
const liveSmokeMatch = currentMatches.find((match) => match.odds || match.handicapOdds);
assert.ok(liveSmokeMatch, 'current data must provide a prediction-set smoke fixture');
const livePredictionSet = predictionSet(liveSmokeMatch);
assert.ok(Array.isArray(livePredictionSet.predictions), 'predictionSet must execute without unresolved line variables');

const invalidPool = sportteryPoolOdds({
  oddsList: [{ poolCode: 'HHAD', h: 2.1, d: 3.2, a: 3.3, goalLine: '-' }],
}, 'HHAD', 'https://example.test', 'test');
assert.equal(invalidPool, null, 'HHAD odds without a real line must be rejected');

const zeroPool = sportteryPoolOdds({
  oddsList: [{ poolCode: 'HHAD', h: 2.1, d: 3.2, a: 3.3, goalLine: '0' }],
}, 'HHAD', 'https://example.test', 'test');
assert.equal(zeroPool.handicap, '0', 'an explicit HHAD zero line must be preserved');

console.log('Handicap parsing and settlement regression checks passed.');
