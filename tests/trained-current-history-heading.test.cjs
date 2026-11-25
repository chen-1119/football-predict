'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const React = require('react'), render = require('react-dom/server').renderToStaticMarkup;
const root = path.resolve(__dirname, '..'), baseline = process.env.FOOTBALL_HEADING_TEST_BASELINE || root;
const native = require('node:module').createRequire(path.join(baseline, 'package.json'));
const now = Date.parse('2026-10-23T12:30:00Z'), day = '2026-10-23';
function fixture(count = 4, modelDay = day) {
  const records = Array.from({ length: count }, (_, index) => ({ id: 'synthetic-' + index, businessDate: modelDay,
    modelHash: String(index + 1).repeat(64), recordHash: 'a'.repeat(64), parametersHash: 'b'.repeat(64),
    homeTeamName: 'Synthetic home ' + index, awayTeamName: 'Synthetic away ' + index, direction: '1',
    had: { 1: 0.5, X: 0.25, 2: 0.25 }, scoreTop3: [], cutoffAt: '2026-10-23T18:00:00Z', modelVersion: 'synthetic-ui-only' }));
  return { businessDate: day, updatedAt: new Date(now).toISOString(), inputAsOf: new Date(now).toISOString(),
    lanes: { publish: { status: 'ok' }, combos: { status: 'ok' }, settlement: { status: 'ok' } },
    current: [], previews: [], todayCombos: [], todayDualResearch: [], review: { singles: [], combos: [], statistics: {} },
    strategySwitch: { activeReferenceStrategy: 'league-trained-baseline-v1', modelAdoptionCount: count },
    leagueBaseline: { businessDate: modelDay, records }, reviewedAnalysis: { businessDate: day, records: [] },
    reviewedAnalysisHistory: { businessDate: '2026-10-22', combos: [], threeCombos: [], records: Array.from({ length: 11 }, (_, index) => ({
      eventId: 'history-' + index, eventVersion: '2026-10-22T18:00:00Z', businessDate: '2026-10-22', matchNum: String(index),
      homeTeamName: 'Historical home', awayTeamName: 'Historical away', market: 'HAD', selection: 'h',
      sp: 2, originalSp: 2, scores: [[1, 0]], reason: 'Synthetic editorial layout fixture', limitations: ['synthetic-only'],
      analysisUrl: 'https://example.invalid/synthetic', quoteObservedAt: '2026-10-22T12:00:00Z', cutoffAt: '2026-10-22T18:00:00Z' })) } };
}
function renderCenter(data, { failed = false, authorizationRequired = false, tab = 'single', language = 'zh', mode = 'recommendations' } = {}) {
  const cache = new Map();
  function compile(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const primary = path.join(root, relative), file = fs.existsSync(primary) ? primary : path.join(baseline, relative);
    const module = { exports: {} }; cache.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, Date: class extends Date { static now() { return now; } }, Intl, Set,
      require(id) {
        if (id === '../../hooks/useRecommendationCenter') return { useRecommendationCenter: () => ({ data, loading: false, failed, authorizationRequired, refresh() {} }) };
        if (id === '../../hooks/useRecommendationReviewPage') return { useRecommendationReviewPage: () => ({ data: null, loading: false, failed: false, authorizationRequired: false, refresh() {} }) };
        if (id.endsWith('.css')) return {};
        if (id === 'lucide-react' || id.startsWith('../') && !id.includes('/services/') || id.startsWith('./') && !['./LeagueBaselineDirections', './ReviewedAnalysis'].includes(id)) return new Proxy({}, { get: () => () => null });
        if (id.startsWith('.')) for (const suffix of ['', '.ts', '.tsx', '.cjs']) {
          const next = path.join(path.dirname(relative), id + suffix), candidate = path.join(baseline, next);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return /\.tsx?$/.test(next) ? compile(next) : native(candidate);
        }
        return native(id);
      } }, { filename: file });
    return module.exports;
  }
  return render(React.createElement(compile('src/components/recommendations/RecommendationCenter.tsx').RecommendationCenter,
    { language, onSelectMatch() {}, selectedTab: tab, mode }));
}
test('today trained rows own the heading while yesterday editorial remains explicitly historical and unchanged', () => {
  const data = fixture(), before = JSON.stringify(data), html = renderCenter(data);
  assert.match(html, /<h1 id="rc-title">今日推荐<\/h1>/); assert.match(html, /比赛日 2026-10-23/);
  assert.equal((html.match(/class="rc-paper__record" data-model-hash=/g) || []).length, 4);
  assert.match(html, /data-reviewed-business-date="2026-10-22" data-reviewed-history="true"/);
  assert.match(html, /11 场原冻结记录 · 历史记录，非今日新荐/); assert.equal(JSON.stringify(data), before);
});
test('zero current model rows preserves the existing yesterday history fallback', () => {
  const html = renderCenter(fixture(0)); assert.match(html, /<h1 id="rc-title">历史推荐<\/h1>/); assert.match(html, /比赛日 2026-10-22/);
});
test('old model rows cannot claim the current heading or appear as current records', () => {
  const html = renderCenter(fixture(4, '2026-10-22')); assert.match(html, /<h1 id="rc-title">历史推荐<\/h1>/);
  assert.equal((html.match(/class="rc-paper__record" data-model-hash=/g) || []).length, 0);
});
test('English heading uses today while preserving the historical editorial date', () => {
  const html = renderCenter(fixture(), { language: 'en' }); assert.match(html, /Today’s Recommendations/); assert.match(html, /MATCH DAY 2026-10-23/);
});
test('combo tabs without displayed model rows retain their historical date', () => {
  for (const tab of ['two', 'three']) { const html = renderCenter(fixture(), { tab }); assert.match(html, /<h1 id="rc-title">历史推荐<\/h1>/); assert.match(html, /比赛日 2026-10-22/); }
});
test('failed or unauthorized reads never display retained model or editorial rows', () => {
  for (const options of [{ failed: true }, { authorizationRequired: true }]) {
    const html = renderCenter(fixture(), options); assert.doesNotMatch(html, /data-model-hash=/); assert.doesNotMatch(html, /data-reviewed-history=/);
  }
});
module.exports = { fixture, renderCenter };
