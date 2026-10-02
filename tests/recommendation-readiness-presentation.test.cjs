'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), crypto = require('node:crypto');
const compile = (file, imports = () => ({})) => {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, Date, Intl,
    require: id => id === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      : id.endsWith('.css') ? {} : imports(id) });
  return module.exports;
};
const readiness = compile('../src/services/recommendationReadinessPresentation.ts');
const view = compile('../src/services/publishedDetailPresentation.ts'), labels = compile('../src/services/publishedMatchRecommendation.ts');
const { RecommendationEvidenceFacts: Facts } = compile('../src/components/predictions/RecommendationEvidenceFacts.tsx', id =>
  id.endsWith('/recommendationReadinessPresentation') ? readiness : id.endsWith('/publishedDetailPresentation') ? view
    : id.endsWith('/publishedMatchRecommendation') ? labels : id.endsWith('/publishedRecommendationStatus.cjs')
      ? require('../src/services/publishedRecommendationStatus.cjs') : {});
const present = readiness.recommendationReadinessPresentation;
const words = n => n == null || typeof n === 'boolean' ? '' : Array.isArray(n) ? n.map(words).join('') : typeof n === 'object' ? words(n.props?.children) : String(n);
const nodes = (n, p) => n && typeof n === 'object' ? Array.isArray(n) ? n.flatMap(v => nodes(v, p)) : [...(p(n) ? [n] : []), ...nodes(n.props?.children, p)] : [];
const fixtureBytes = fs.readFileSync(require.resolve('./fixtures/recommendation-detail-20260922.json'));
const fixture = JSON.parse(fixtureBytes);
test('historical online capture bytes remain bound to the prior UI source receipt', () => {
  assert.equal(crypto.createHash('sha256').update(fixtureBytes).digest('hex'), 'a10c2acb4b9ca8622820bfda18919efeefb6a453fe41031b815993e96a28d2dc');
});
test('real recorded publications display analysis reference without hiding or changing frozen probabilities', () => {
  for (const { match, row } of fixture.fixtures) {
    const original = JSON.stringify(row);
    const tree = Facts({ match, language: 'zh', publishedDecision: row.decision, selectionQuality: row.selectionQuality, supplementaryModel: false });
    assert.equal(nodes(tree, n => n.props?.['data-display-stage'])[0].props['data-display-stage'], 'analysis-reference');
    assert.equal(nodes(tree, n => n.props?.['data-outcome']).length, 3);
    assert.match(words(tree), /分析参考/);
    assert.doesNotMatch(words(tree), /可发布推荐|正式推荐已验证/);
    assert.equal(JSON.stringify(row), original);
  }
});
// The remaining cases deliberately vary captured rows: SYNTHETIC boundary tests,
// never evidence that these qualification states occurred in production.
test('synthetic missing publication is waiting; it does not invent probabilities or borrow a legacy pick', () => {
  const tree = Facts({ match: { probabilities: { home: .9 } }, language: 'zh', publishedDecision: null, supplementaryModel: false });
  assert.equal(nodes(tree, n => n.props?.['data-display-stage'])[0].props['data-display-stage'], 'waiting-for-data');
  assert.match(words(tree), /等待资料.*正式资格未提供/);
  assert.equal(nodes(tree, n => n.props?.['data-outcome']).length, 0);
});
for (const language of ['zh', 'en']) {
  test(`synthetic reference qualification never grants formal model promotion (${language})`, () => {
    const decision = { ...fixture.fixtures[0].row.decision, modelValidation: 'unvalidated' };
    const quality = { status: 'reference-qualified', qualified: true, reasons: [] };
    const result = present(decision, quality, language);
    assert.equal(result.stage, 'analysis-reference');
    assert.equal(result.referencePassed, true);
    assert.equal(result.formalStatus, 'model-unvalidated');
    assert.doesNotMatch(JSON.stringify(result), /publishable-recommendation/);
  });
  test(`synthetic unknown reason is readable without exposing source errors or private tokens (${language})`, () => {
    const result = present(fixture.fixtures[0].row.decision, { status: 'watch', qualified: false,
      reasons: ['unexpected: https://internal.test?token=PRIVATE_TOKEN', 'another_unknown'] }, language);
    assert.equal(result.reasons.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|internal\.test|unexpected:|another_unknown/);
  });
}
test('synthetic missing inputs show the service restriction but keep the frozen three-way probabilities', () => {
  const tree = Facts({ match: {}, language: 'zh', publishedDecision: fixture.fixtures[0].row.decision,
    selectionQuality: { status: 'watch', qualified: false, reasons: ['input-evidence-unavailable', 'team-samples-insufficient'] }, supplementaryModel: false });
  assert.equal(nodes(tree, n => n.props?.['data-outcome']).length, 3);
  assert.match(words(tree), /输入依据尚未完整存档.*球队样本不足/);
  assert.doesNotMatch(words(tree), /伤停 0|确认首发|已取得 xG/);
});
test('synthetic known restrictions are mapped and de-duplicated; no UI probability threshold is evaluated', () => {
  const reasons = ['model-lead-too-thin', 'material-model-market-disagreement', 'cross-track-direction-conflict', 'direction-override-mismatch', 'model-lead-too-thin'];
  const result = present(fixture.fixtures[0].row.decision, { status: 'watch', qualified: false, reasons,
    probabilityLead: .99, expectedValue: 1000 }, 'zh');
  assert.equal(result.reasons.length, 4);
  assert.equal(result.referencePassed, false);
  assert.equal(result.stage, 'analysis-reference');
  assert.match(result.reasons.join('；'), /差距较小.*明显分歧.*存在冲突.*尚待核对/);
});
