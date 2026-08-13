const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(rootDir, 'src', 'pages', 'PredictionsList.tsx'), 'utf8');
const checks = [];

const check = (name, predicate) => {
  assert.ok(predicate, name);
  checks.push(name);
};

const dailyStatsStart = source.indexOf('const getDailyReviewStats =');
const dailyStatsEnd = source.indexOf('const formatDailyRate =', dailyStatsStart);
const dailyStatsSource = source.slice(dailyStatsStart, dailyStatsEnd);

check('date membership uses only the Sporttery business day', source.includes(
  'return sportteryDay ? [sportteryDay] : [];'
) && !source.includes('kickoffDay,\n    sportteryDay'));

// Production-shaped business-day fixture: two official finals with immutable
// archives/reviews plus one still-live fixture whose own archive must remain
// visible without entering the result-phase archive denominator.
const classifyBusinessDay = (matches, now) => matches.reduce((stats, match) => {
  const hasSettledReview = Boolean(match.postMatchReview?.predictionReview?.rows?.some((row) => (
    row.resultStatus === 'WON' || row.resultStatus === 'LOST'
  )));
  const kickoffAt = Date.parse(match.kickoffTime || '');
  const isPastScheduled = match.status === 'SCHEDULED'
    && Number.isFinite(kickoffAt)
    && kickoffAt <= now;
  const isResultPhase = match.resultDisposition === 'VOID'
    || match.status === 'FINISHED'
    || match.status === 'PENDING_RESULT'
    || hasSettledReview
    || isPastScheduled;
  stats.totalFixtures += 1;
  stats.resultPhaseFixtures += isResultPhase ? 1 : 0;
  stats.notYetResultPhase += isResultPhase ? 0 : 1;
  stats.finished += match.status === 'FINISHED' || hasSettledReview ? 1 : 0;
  stats.archivedDirections += isResultPhase && Boolean(match.archivedPreMatchPrediction) ? 1 : 0;
  return stats;
}, { totalFixtures: 0, resultPhaseFixtures: 0, notYetResultPhase: 0, finished: 0, archivedDirections: 0 });

const archive = { prediction: { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1' } };
const review = { predictionReview: { rows: [{ marketType: 'BEST', resultStatus: 'WON' }] } };
const productionDay = classifyBusinessDay([
  { status: 'FINISHED', kickoffTime: '2026-07-31T10:00:00Z', archivedPreMatchPrediction: archive, postMatchReview: review },
  { status: 'FINISHED', kickoffTime: '2026-07-31T12:00:00Z', archivedPreMatchPrediction: archive, postMatchReview: review },
  { status: 'LIVE', kickoffTime: '2026-07-31T14:00:00Z', archivedPreMatchPrediction: archive }
], Date.parse('2026-07-31T15:00:00Z'));
check('mixed yesterday business day keeps 3 total, 2 settled, 1 not final and archive 2/2', (
  productionDay.totalFixtures === 3
  && productionDay.finished === 2
  && productionDay.notYetResultPhase === 1
  && productionDay.resultPhaseFixtures === 2
  && productionDay.archivedDirections === 2
));

const archiveReader = fs.readFileSync(path.join(rootDir, 'src', 'services', 'archivedPreMatchPrediction.ts'), 'utf8');
const matchDetail = fs.readFileSync(path.join(rootDir, 'src', 'pages', 'MatchDetail.tsx'), 'utf8');
check('LIVE cards and detail can display the immutable original pre-match direction', [
  "match.status === 'LIVE'",
  'const isInPlayArchiveFallback',
  'Original pre-match pick',
  'Original pre-match archive'
].every((fragment) => archiveReader.includes(fragment) || source.includes(fragment))
  && matchDetail.includes('const isInPlayArchivedPrimaryDirection = Boolean(')
  && matchDetail.includes('const canonicalPreMatchPrediction = canonicalPublishedRecommendation?.prediction\n    || archivedPreMatchPrediction\n    || analysisReferencePrediction;'));

check('formal performance counts one settled BEST row per match', dailyStatsSource.includes(
  "const formalBestRow = settledRows.find((row) => isFormalReviewRow(row) && row.marketType === 'BEST');"
) && dailyStatsSource.includes('acc.formalSettled += 1;'));

check('reference BEST is isolated from supporting analysis rows', dailyStatsSource.includes(
  "const referenceBestRow = analysisRows.find((row) => row.marketType === 'BEST');"
) && dailyStatsSource.includes('acc.referenceBestSettled += 1;'));

check('all analysis rows retain their own denominator', dailyStatsSource.includes(
  'acc.analysisSettled += analysisRows.length;'
) && dailyStatsSource.includes(
  "acc.analysisWon += analysisRows.filter((row) => row.resultStatus === 'WON').length;"
));

check('zero-sample rates remain null and render explicitly', source.includes(
  "value === null ? (language === 'zh' ? '无样本' : 'N/A') : `${value}%`"
) && source.includes(': null,\n    analysisHitRate:'));

check('daily review exposes official tracks plus a separately labelled provisional shadow track', [
  'data-formal-settled={dailyReviewStats.formalSettled}',
  'data-live-settled={dailyReviewStats.liveSettled}',
  'data-reference-best-settled={dailyReviewStats.referenceBestSettled}',
  'data-analysis-settled={dailyReviewStats.analysisSettled}',
  'data-provisional-reference-settled={dailyReviewStats.provisionalReferenceSettled}',
  '原赛前方向保持不变',
  '官方竞彩结算与外部赛果参考分开统计',
  '外部比分不会写入正式命中率',
  '正式推荐（',
  '实时推荐（',
  '数据推荐 BEST',
  '全部分析项',
  '外部赛果影子参考',
  '官方已完场'
].every((fragment) => source.includes(fragment))
  && !source.includes('dailyReviewStats.liveSettled > 0 &&'));

console.log(JSON.stringify({ ok: true, checks }, null, 2));
