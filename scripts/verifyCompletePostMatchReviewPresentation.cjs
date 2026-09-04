const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
const reviewPage = read('src/pages/HitAndWin.tsx');
const listPage = read('src/pages/PredictionsList.tsx');
const detailPage = read('src/pages/MatchDetail.tsx');
const server = read('server/index.cjs');
const dataStore = read('server/dataStore.cjs');

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
const hasAll = (source, values) => values.every((value) => source.includes(value));

check('review page shows every match from the selected business day instead of a fixed recent subset',
  hasAll(reviewPage, [
    'const systemReviewDates = useMemo',
    'const activeReviewDate =',
    'reviewDateKey(match) === activeReviewDate',
    'systemReviewMatches.map((match) =>'
  ])
  && !reviewPage.includes('.slice(0, 12)'));

check('review page keeps the summary concise while preserving a full-detail route',
  hasAll(reviewPage, [
    'review?.modelDiagnosis?.slice(0, 1).map(',
    'review?.nextAdjustment?.slice(0, 1).map(',
    "navigate(`/match/${encodeURIComponent(match.id)}`",
    "fromPath: '/review'",
    '未命中与失误定位',
    'data-review-date-hit-rate',
    'data-review-cumulative-hit-rate',
    'data-review-date-reference-hit-rate',
    'data-review-cumulative-reference-hit-rate',
    "primaryTrack === 'reference'",
    'Data pick · Hit (separate record)',
    'Data pick · Miss (separate record)'
  ])
  && !reviewPage.includes("referenceBestStatus || null"));

check('review-origin detail routes open the complete review tab directly',
  hasAll(read('src/App.tsx'), [
    "initialTab={routeState?.fromPath === '/review' ? 'history' : 'overview'}"
  ])
  && hasAll(detailPage, [
    'initialTab?: DetailTab',
    "initialTab = 'overview'",
    'useState<DetailTab>(initialTab)'
  ]));

check('detail page does not truncate settlement rows, diagnoses, adjustments, or evidence gaps',
  hasAll(detailPage, [
    'settledPostReviewRows.map((row) =>',
    'postReviewDiagnosis.map((item) =>',
    'postReviewAdjustments.map((item) =>',
    'postReviewDataGaps.map((item) =>',
    'primaryPostReviewMistakeSummary'
  ])
  && !detailPage.includes('settledPostReviewRows.slice(0, 4)')
  && !detailPage.includes('postReviewDiagnosis.slice(0, 4)')
  && !detailPage.includes('postReviewAdjustments.slice(0, 4)')
  && !detailPage.includes('postReviewDataGaps.slice(0, 4)'));

check('formal live and reference tracks all expose explicit settled outcome labels without merging denominators',
  hasAll(listPage, [
    'const showFormalHit =',
    'const showFormalMiss =',
    'const showLiveHit =',
    'const showLiveMiss =',
    '实时推荐命中',
    '实时推荐未中',
    '参考命中 · 不计正式战绩',
    '参考未命中 · 不计正式战绩'
  ]));

check('fixtures page exposes a compact complete review without changing pre-match cards', hasAll(listPage, [
  'isFixturesView && isFinished && reviewRow',
  'className="fixture-review-disclosure"',
  'fixtureMistakeSummary',
  'fixtureReviewDiagnosis.map(',
  'fixtureReviewAdjustments.map(',
  'fixtureReviewDataGaps.map(',
  '点击本行“详情”可查看全部市场结算、历史样本与证据。'
]));

for (const [name, source] of [['server', server], ['dataStore', dataStore]]) {
  const compactStart = source.indexOf('const compactPostMatchReviewForList =');
  const compactEnd = source.indexOf('\n};', compactStart) + 3;
  const compactSource = source.slice(compactStart, compactEnd);
  check(`${name} list projection retains review explanation fields`, hasAll(compactSource, [
    'scoreReview: review.scoreReview',
    'modelDiagnosis: review.modelDiagnosis || []',
    'nextAdjustment: review.nextAdjustment || []',
    'dataGaps: review.dataGaps || []'
  ]));
}

const failed = checks.filter((item) => !item.ok);
const report = {
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
