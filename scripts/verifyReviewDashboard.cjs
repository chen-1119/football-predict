'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('./lib/loadReviewTsForVerification.cjs');
const root = path.resolve(__dirname, '..');
const { selectReviewWindow, selectReviewMarketWindow, selectReviewExclusions, reviewShanghaiDate, reviewWilsonInterval, selectReviewVersions, selectReviewVersionWindow } = load(ts, path.join(root, 'src/services/reviewDashboard.ts'));
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const fixture = () => ({
  version: 'reference-review-performance-v1', generatedAt: '2026-09-06T16:00:00Z', startDate: '2026-08-01', timezone: 'Asia/Shanghai',
  cumulative: { won: 13, lost: 12, settled: 25, hitRate: .99 },
  daily: [
    { date: '2026-08-01', won: 3, lost: 2, settled: 5 },
    { date: '2026-08-09', won: 2, lost: 2, settled: 4 },
    { date: '2026-08-31', won: 3, lost: 4, settled: 7 },
    { date: '2026-09-01', won: 4, lost: 4, settled: 8 },
    { date: '2026-09-07', won: 1, lost: 0, settled: 1 },
  ], policy: { sourceScope: 'server-complete-history', unit: 'match-best' },
});
const select = (s, w = 'all', t = 'reference') => selectReviewWindow(s, t, w);
const withMarkets = (value) => ({ ...value, marketBreakdown: { version: 'review-best-market-v1',
  HAD: { cumulative: value.cumulative, daily: value.daily }, HHAD: { cumulative: { won: 0, lost: 0, settled: 0 }, daily: [] },
  UNKNOWN: { cumulative: { won: 0, lost: 0, settled: 0 }, daily: [] },
} });
check('Shanghai cutoff is independent of local timezone; timezone-less clock rejected', () => {
  assert.equal(reviewShanghaiDate('2026-09-06T15:59:59Z'), '2026-09-06');
  assert.equal(reviewShanghaiDate('2026-09-06T16:00:00Z'), '2026-09-07');
  assert.equal(reviewShanghaiDate('2026-09-07T00:00:00+08:00'), '2026-09-07');
  assert.equal(reviewShanghaiDate('2026-09-07T00:00:00'), null);
});
check('inclusive 7/30-day calendar windows use publication day, not latest settled day', () => {
  const seven = select(fixture(), '7d');
  assert.equal(seven.from, '2026-09-01'); assert.equal(seven.through, '2026-09-07');
  assert.equal(seven.counts.won, 5); assert.equal(seven.counts.settled, 9);
  const thirty = select(fixture(), '30d');
  assert.equal(thirty.from, '2026-08-09'); assert.equal(thirty.counts.settled, 20);
  const stale = fixture(); stale.generatedAt = '2026-09-20T00:00:00Z';
  assert.equal(select(stale, '7d').counts.settled, 0);
});
check('rates recompute from counts; permutations and unrelated input properties cannot change them', () => {
  assert.equal(select(fixture()).counts.hitRate, 13 / 25);
  const reversed = fixture(); reversed.daily.reverse(); reversed.browserMatches = [{ resultStatus: 'WON' }];
  assert.deepEqual(select(reversed), select(fixture()));
});
check('short history is explicitly marked as a partial calendar window', () => {
  const s = fixture(); s.startDate = '2026-09-07'; s.daily = s.daily.slice(-1); s.cumulative = { ...s.daily[0] };
  assert.equal(select(s, '30d').partial, true); assert.equal(select(s, '30d').from, '2026-09-07');
});
check('empty valid ledger is no samples, missing ledger is pending, never a default 50 percent', () => {
  const s = fixture(); s.daily = []; s.cumulative = { won: 0, lost: 0, settled: 0 };
  assert.equal(select(s).state, 'ready'); assert.equal(select(s).counts.hitRate, null);
  assert.equal(select(undefined).state, 'pending'); assert.equal(select(undefined).counts, null);
});
check('v1 cannot provide current-model partitions even if a live modelVersion is attached', () => {
  const s = fixture(); s.modelVersion = 'live-new-model';
  assert.equal(select(s, 'version').state, 'version-unavailable'); assert.equal(select(s, 'version').counts, null);
});
check('wrong track, policy, timezone, version and start date fail closed', () => {
  assert.equal(select(fixture(), 'all', 'formal').state, 'pending');
  for (const mutate of [s => s.version = 'new-v2', s => s.timezone = 'UTC', s => s.policy.unit = 'per-market',
    s => s.policy.sourceScope = 'browser-history', s => s.startDate = '2026-02-31', s => s.startDate = '2027-01-01',
    s => s.generatedAt = 'not-a-clock', s => s.daily = null]) {
    const s = fixture(); mutate(s); assert.equal(select(s).state, 'pending');
  }
});
check('malformed counts, duplicate days, out-of-window rows and unreconciled totals fail closed', () => {
  for (const mutate of [s => s.cumulative.won = '13', s => s.cumulative.lost = -1,
    s => s.cumulative.settled = 26, s => s.daily[0].won = 2,
    s => s.daily.push({ date: '2026-08-01', won: 0, lost: 0, settled: 0 }),
    s => s.daily[0].date = '2026-02-31', s => s.daily[0].date = '2026-07-31',
    s => s.daily[0].date = '2026-09-08']) {
    const s = fixture(); mutate(s); assert.equal(select(s).state, 'pending');
  }
});
const render = (track, window, props = {}) => {
  let hook = 0;
  const { ReviewEvidenceOverview } = load(ts, path.join(root, 'src/components/review/ReviewEvidenceOverview.tsx'), {
    react: { ...React, useState: () => [[track, window, 'HAD', props.versionChoice || ''][hook++], () => {}] },
  });
  const reference = withMarkets(fixture()); const formal = { ...withMarkets(fixture()), version: 'formal-review-performance-v1' };
  return renderToStaticMarkup(React.createElement(ReviewEvidenceOverview, { language: 'zh', formal, reference, ...props }));
};
check('actual overview renders category/window controls and honest mixed-market/evidence disclosures', () => {
  const html = render('reference', '7d');
  for (const value of ['55.6%', '命中 5 / 已结算 9', '正式推荐', '数据参考', '研究影子', '按版本', '近 7 天', '近 30 天',
    'HAD 冻结 BEST · 独立玩法口径', 'HHAD 让球', 'BEST 总账', '待补证', '分母待核验', '2026-09-01', '2026-09-07', 'aria-pressed="true"', '<details', '<summary']) assert.ok(html.includes(value), value);
});
check('actual current-version and missing-data UI do not invent a performance number', () => {
  const version = render('reference', 'version');
  assert.ok(version.includes('缺少可核验的版本分组')); assert.ok(!version.includes('52.0%'));
  const missing = render('formal', 'all', { formal: undefined });
  assert.ok(missing.includes('完整统计待更新')); assert.ok(!missing.includes('52.0%'));
});
check('shadow wins are never inferred from settled counts; long revision remains present', () => {
  const revision = `candidate-${'abcdef'.repeat(20)}`;
  const html = render('shadow', '7d', { shadow: { candidateRevisionId: revision, cohort: { shadow: { settled: 123 } } } });
  assert.ok(html.includes(revision)); assert.ok(html.includes('影子已结算 123 · 命中数未提供')); assert.ok(!html.includes('52.0%'));
});
check('market windows require a complete partition and never fall back to mixed BEST', () => {
  assert.equal(selectReviewMarketWindow(fixture(), 'reference', 'all', 'HAD').state, 'market-unavailable');
  assert.equal(selectReviewMarketWindow(fixture(), 'reference', 'all', 'BEST').counts.settled, 25);
  assert.equal(selectReviewMarketWindow(withMarkets(fixture()), 'reference', '7d', 'HAD').counts.settled, 9);
  assert.equal(selectReviewMarketWindow(withMarkets(fixture()), 'reference', 'all', 'HHAD').counts.hitRate, null);
});
check('market partition rejects missing groups, wrong versions and count/date drift', () => {
  for (const mutate of [s => delete s.marketBreakdown.UNKNOWN, s => s.marketBreakdown.version = 'bad',
    s => s.marketBreakdown.extra = {}, s => s.marketBreakdown.HHAD = s.marketBreakdown.HAD,
    s => s.marketBreakdown.HAD.daily = s.marketBreakdown.HAD.daily.map(r => ({ ...r, date: r.date === '2026-08-01' ? '2026-08-02' : r.date }))]) {
    const s = withMarkets(fixture()); mutate(s);
    assert.equal(selectReviewMarketWindow(s, 'reference', 'all', 'HAD').state, 'market-unavailable');
  }
});
check('unknown market rows are visible and excluded from HAD instead of silently reassigned', () => {
  const s = withMarkets(fixture());
  s.marketBreakdown.UNKNOWN = { cumulative: { won: 3, lost: 2, settled: 5 }, daily: [s.daily[0]] };
  s.marketBreakdown.HAD = { cumulative: { won: 10, lost: 10, settled: 20 }, daily: s.daily.slice(1) };
  const html = render('reference', 'all', { reference: s });
  assert.ok(html.includes('全部历史中有 5 场玩法未知，仅保留在 BEST 总账。'));
  assert.ok(html.includes('命中 10 / 已结算 20'));
  assert.equal(selectReviewMarketWindow(s, 'reference', 'all', 'HAD').counts.hitRate, .5);
  assert.equal(selectReviewMarketWindow(s, 'reference', 'all', 'BEST').counts.hitRate, 13 / 25);
});
const exclusionFixture = () => ({ ...withMarkets(fixture()), exclusions: { beforeStart: 1700, invalidDate: 0, invalidIdentity: 2,
  duplicateEvent: 3, conflictingEvent: 1, withoutFrozenReferenceSettlement: 800 } });
check('complete exclusions preserve separate event and record units without affecting rates', () => {
  const s = exclusionFixture(), audit = selectReviewExclusions(s, 'reference');
  assert.equal(audit.complete, true); assert.equal(audit.rows.find(r => r.key === 'conflictingEvent').unit, 'event');
  assert.equal(audit.rows.find(r => r.key === 'duplicateEvent').unit, 'record');
  assert.equal(audit.rows.find(r => r.key === 'invalidDate').value, 0);
  assert.deepEqual(select(s), select(fixture())); assert.equal(Object.hasOwn(audit, 'total'), false);
});
check('missing wrong-track or invalid summary never turns exclusions into verified zeros', () => {
  for (const s of [undefined, fixture(), { ...exclusionFixture(), version: 'old' }, { ...exclusionFixture(), exclusions: [] }]) {
    const audit = selectReviewExclusions(s, 'reference'); assert.equal(audit.complete, false);
    assert.ok(audit.rows.every(r => r.value === null));
  }
  assert.equal(selectReviewExclusions(exclusionFixture(), 'formal').available, false);
});
check('exclusion counters reject malformed values, absent fields, inheritance and unknown schemas', () => {
  for (const value of [null, '', '0', false, -1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const s = exclusionFixture(); s.exclusions.conflictingEvent = value;
    const audit = selectReviewExclusions(s, 'reference'); assert.equal(audit.complete, false);
    assert.equal(audit.rows.find(r => r.key === 'conflictingEvent').value, null);
  }
  const missing = exclusionFixture(); delete missing.exclusions.invalidIdentity;
  assert.equal(selectReviewExclusions(missing, 'reference').complete, false);
  const inherited = exclusionFixture(); inherited.exclusions = Object.create(inherited.exclusions);
  assert.ok(selectReviewExclusions(inherited, 'reference').rows.every(r => r.value === null));
  const extra = exclusionFixture(); extra.exclusions.unrecognized = 12;
  assert.equal(selectReviewExclusions(extra, 'reference').unknownFields, 1);
  assert.equal(selectReviewExclusions(extra, 'reference').complete, false);
});
check('actual exclusion UI explains whole-input scope in a filtered window and stays out of shadow', () => {
  const s = exclusionFixture();
  for (const w of ['7d', '30d', 'all', 'version']) {
    const html = render('reference', w, { reference: s });
    assert.ok(html.includes('统计排除与去重')); assert.ok(html.includes('不随上方时间或玩法筛选变化'));
    assert.ok(html.includes('1,700')); assert.ok(html.includes('条记录')); assert.ok(html.includes('场赛事'));
    assert.ok(!html.includes('不能视为已完成审计'));
  }
  assert.ok(!render('shadow', 'all', { reference: s }).includes('data-review-exclusions'));
  assert.ok(render('reference', 'all', { reference: withMarkets(fixture()) }).includes('不能视为已完成审计'));
});
check('Wilson reference values, symmetry and boundary samples', () => {
  const interval = (won, lost) => reviewWilsonInterval({ won, lost, settled: won + lost });
  const half = interval(50, 50);
  assert.ok(Math.abs(half.lower - .4038315304) < 1e-9);
  assert.ok(Math.abs(half.upper - .5961684696) < 1e-9);
  assert.equal(interval(0, 1).lower, 0); assert.equal(interval(1, 0).upper, 1);
  assert.ok(Math.abs(interval(0, 1).upper - .7934506856) < 1e-9);
  assert.ok(Math.abs(interval(7, 13).lower + interval(13, 7).upper - 1) < 1e-12);
  assert.ok(interval(5, 5).upper - interval(5, 5).lower > half.upper - half.lower);
  assert.ok(interval(500, 500).upper - interval(500, 500).lower < half.upper - half.lower);
});
check('Wilson rejects absent, zero and malformed counts; ignores supplied hit rate', () => {
  for (const row of [null, {}, { won: 0, lost: 0, settled: 0 }, { won: 1, lost: 0, settled: 2 },
    { won: '1', lost: 0, settled: 1 }, { won: -1, lost: 2, settled: 1 }, { won: 0.5, lost: 0.5, settled: 1 }]) assert.equal(reviewWilsonInterval(row), null);
  assert.deepEqual(reviewWilsonInterval({ won: 50, lost: 50, settled: 100, hitRate: .99 }), reviewWilsonInterval({ won: 50, lost: 50, settled: 100 }));
});
check('interval uses selected reconciled market/window and cannot leak to unknown or shadow results', () => {
  const html = render('reference', '7d');
  const expected = reviewWilsonInterval({ won: 5, lost: 4, settled: 9 });
  assert.ok(html.includes(`${(expected.lower * 100).toFixed(1)}% – ${(expected.upper * 100).toFixed(1)}%`));
  for (const words of ['95% Wilson', '假设各场独立', '未校正同日或联赛相关性', '不用于模型晋级']) assert.ok(html.includes(words));
  for (const absent of [render('reference', 'version'), render('shadow', 'all'), render('formal', 'all', { formal: undefined }),
    render('reference', 'all', { reference: fixture() })]) assert.ok(!absent.includes('data-review-uncertainty'));
});
const versionFixture = () => {
  const { fixture: make } = require('./verifyFrozenReviewVersion.cjs');
  const { buildReferenceReviewPerformance, compactReferenceReviewPerformance } = require('../server/reviewPerformanceSummary.cjs');
  const unknown = make('991006'); delete unknown.postMatchReview.predictionReview.rows[0].frozenVersion;
  return compactReferenceReviewPerformance(buildReferenceReviewPerformance({ matches: [make(), make('991004', 'frozen-model-b', 'HHAD'), unknown], generatedAt: '2026-09-07T15:00:00.000Z' }));
};
check('actual server partition selects exact model/policy labels and independent markets without a default current version', () => {
  const s = versionFixture(), versions = selectReviewVersions(s, 'reference');
  assert.equal(versions.available, true); assert.equal(versions.groups.length, 2);
  const b = versions.groups.find(g => g.modelVersion === 'frozen-model-b');
  assert.equal(selectReviewVersionWindow(s, 'reference', 'HHAD', b.key).counts.hitRate, 0);
  assert.equal(selectReviewVersionWindow(s, 'reference', 'HAD', b.key).counts.hitRate, null);
  assert.equal(selectReviewVersionWindow(s, 'reference', 'HAD', 'UNKNOWN').counts.settled, 1);
  assert.equal(selectReviewVersionWindow(s, 'reference', 'HAD', '').counts, null);
  const html = render('reference', 'version', { reference: s });
  assert.ok(html.includes('请选择已记录的冻结版本')); assert.ok(html.includes('完整历史有 1 场版本未追溯'));
  assert.ok(!html.includes('data-review-uncertainty'));
  const selected = render('reference', 'version', { reference: s, versionChoice: versions.groups.find(g => g.modelVersion === 'frozen-model-a').key });
  assert.ok(selected.includes('命中 1 / 已结算 1')); assert.ok(selected.includes('frozen-model-a / frozen-policy-a'));
});
check('UI version selector rejects malformed, duplicate and unreconciled full partitions', () => {
  for (const mutate of [s => s.versionBreakdown.groups.push(null), s => delete s.versionBreakdown.unknown,
    s => s.versionBreakdown.groups.push(s.versionBreakdown.groups[0]), s => s.versionBreakdown.groups[0].cumulative.won++,
    s => s.versionBreakdown.scope = 'current-model', s => s.versionBreakdown.unknown.daily[0].date = '2026-09-06',
    s => s.versionBreakdown.groups[0].modelVersion = '']) {
    const s = versionFixture(); mutate(s); assert.equal(selectReviewVersions(s, 'reference').available, false);
  }
});
console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks }, null, 2));
