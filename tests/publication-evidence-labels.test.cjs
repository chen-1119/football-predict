'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const words = n => n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(words).join('') : typeof n === 'object' ? words(n.props?.children) : String(n);
const nodes = (n, p) => n && typeof n === 'object' ? Array.isArray(n) ? n.flatMap(v => nodes(v, p)) : [...(p(n) ? [n] : []), ...nodes(n.props?.children, p)] : [];
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const compile = (file, imports) => {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Intl, Date, require: id => id === 'react/jsx-runtime' ? jsx : id.endsWith('.css') ? {} : imports(id) });
  return module.exports;
};
const at = '2026-10-02T08:00:00Z';
const forecast = id => ({ id, matchId: id, sourceMatchId: id, publishedAt: at, kickoffTime: '2026-10-02T12:00:00Z', cutoffTime: '2026-10-02T11:55:00Z',
  homeTeamName: 'Synthetic Home', awayTeamName: 'Synthetic Away', tipCode: '1', odds: 1.9, probabilities: { '1': .55, X: .25, '2': .2 }, modelProbability: .55,
  modelValidation: 'unvalidated', publicationStatus: 'PUBLISHED', statisticsTrack: 'published-forecast', recordHash: 'a'.repeat(64) });

test('unvalidated current and review publications remain references in both languages without changing frozen rows', () => {
  const data = { updatedAt: at, current: [{ forecast: forecast('current'), settlement: null }], history: [{ forecast: forecast('history'), settlement: { state: 'WON', score: '2-0' } }],
    summary: { published: 2, won: 1, settled: 1, pending: 1, hitRate: 1 } };
  const saved = JSON.stringify(data);
  for (const language of ['zh', 'en']) {
    let review = false;
    const { PublishedForecastPanel } = compile('../src/components/predictions/PublishedForecastPanel.tsx', id => {
      if (id === 'react') return { useState: () => [review, value => { review = value; }] };
      throw Error(id);
    });
    const render = () => PublishedForecastPanel({ data, language, failed: false, onSelectMatch: () => {} });
    for (const expected of ['current', 'history']) {
      const tree = render(), article = nodes(tree, n => n.type === 'article')[0];
      assert.equal(article.props['data-recommendation-state'], 'reference');
      assert.match(words(article), new RegExp(expected));
      assert.match(words(nodes(tree, n => n.type === 'h2')[0]), /已发布的单场参考|Published match references/);
      assert.match(words(tree), /未验证参考|unvalidated references/);
      assert.match(words(tree), /正式推荐门槛|formal recommendation gate/);
      nodes(tree, n => n.type === 'button')[1].props.onClick();
    }
    assert.equal(JSON.stringify(data), saved);
  }
});

test('published evidence facts do not merge reference and shadow status or claim formal adoption', () => {
  const { RecommendationEvidenceFacts } = compile('../src/components/predictions/RecommendationEvidenceFacts.tsx', id => {
    if (id.endsWith('/publishedDetailPresentation')) return require('../src/services/publishedDetailPresentation.ts');
    if (id.endsWith('/publishedMatchRecommendation')) return { publishedPickLabel: () => 'Synthetic Home' };
    return {};
  });
  const decision = { ...forecast('frozen'), decisionId: 'frozen', modelGeneratedAt: at, quoteObservedAt: at };
  const saved = JSON.stringify(decision);
  for (const language of ['zh', 'en']) {
    const tree = RecommendationEvidenceFacts({ match: {}, language, publishedDecision: decision, supplementaryModel: false });
    assert.match(words(tree), /已发布参考的模型概率|Published-reference probabilities/);
    assert.match(words(tree), /发布不等于影子实验或正式推荐门槛通过|publication does not establish shadow-study or formal-gate approval/);
    assert.doesNotMatch(words(tree), /参考／影子模型概率|Reference\/shadow model probabilities/);
    assert.equal(tree.props['data-decision-id'], 'frozen');
    assert.equal(tree.props['data-record-hash'], decision.recordHash);
  }
  assert.equal(JSON.stringify(decision), saved);
});
