'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const react = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createRuntime } = require('../scripts/recommendationPlatform/runtime.cjs');
const { memoryPorts } = require('./recommendationFixture.cjs');

function compile(file, dependency = require) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: dependency, Date, Number, Math, Intl });
  return module.exports;
}
const view = compile('../src/services/recommendationCenterView.ts');
const compare = compile('../src/services/marketComparison.ts');
const component = compile('../src/components/recommendations/MarketComparison.tsx', id => {
  if (id === 'react/jsx-runtime') return require(id);
  if (id === '../../services/marketComparison') return compare;
  if (id.endsWith('.css')) return {};
  throw new Error(`Unexpected import ${id}`);
});

async function actualFrozenDecision() {
  const ports = memoryPorts();
  ports.current[0] = {
    ...ports.current[0], handicapLine: -1,
    handicapOdds: { odds1: 3.3, oddsX: 3.5, odds2: 1.92 },
    handicapOddsSource: 'sporttery:HHAD',
    handicapOddsUpdatedAt: new Date(ports.now).toISOString(),
    probabilityModel: { ...ports.current[0].probabilityModel,
      calculationTrace: { poisson: { lambdas: { home: 1.7, away: .8 } } } }
  };
  await createRuntime(ports).publishingCycle();
  const raw = { recommendationCenter: ports.state.view };
  const parsed = view.parseRecommendationCenter(raw);
  const row = parsed.current.find(item => item.decision.handicapAnalysis?.version === 'handicap-margin-v3');
  assert.ok(row, 'real platform must create a coherent v3 handicap analysis');
  return { raw, decision: row.decision };
}

test('real frozen record exposes both complete SP triplets and one coherent probability basis', async () => {
  const { decision } = await actualFrozenDecision();
  const before = JSON.stringify(decision), result = compare.buildMarketComparison(decision);
  assert.equal(result.decisionId, decision.decisionId);
  assert.equal(result.markets[0].probabilityBasis, 'coherent-score-matrix');
  assert.equal(result.markets[1].probabilityBasis, 'coherent-score-matrix');
  assert.equal(result.markets[1].line, -1);
  for (const market of result.markets) {
    assert.equal(market.quoteStatus, 'frozen');
    assert.equal(market.outcomes.length, 3);
    assert.ok(market.outcomes.every(outcome => outcome.probability !== null && outcome.frozenSp > 1));
    assert.ok(Math.abs(market.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) - 1) < 1e-6);
  }
  assert.equal(result.markets[0].outcomes.find(outcome => outcome.code === decision.tipCode).frozenSp, decision.odds);
  assert.equal(result.markets[1].outcomes.find(outcome => outcome.code === decision.handicapAnalysis.tipCode).frozenSp,
    decision.handicapAnalysis.marketReference.selectedOdds);
  assert.equal(JSON.stringify(decision), before, 'comparison cannot change the frozen pick');
  const html = renderToStaticMarkup(react.createElement(component.MarketComparison, { decision, language: 'zh' }));
  assert.match(html, /两种玩法，同一决策/);
  assert.match(html, /让球胜平负 · -1/);
  assert.match(html, /发布时 SP/);
  assert.match(html, /条件概率/);
});

test('tampered frozen prices and post-publication handicap evidence fail parsing', async () => {
  const { raw } = await actualFrozenDecision();
  const cloned = () => JSON.parse(JSON.stringify(raw));
  for (const mutation of [
    d => { d.quoteOdds[d.tipCode] = 99; },
    d => { d.quoteOdds.X = 0; },
    d => { d.handicapAnalysis.marketReference.odds[d.handicapAnalysis.tipCode] = 99; },
    d => { d.handicapAnalysis.marketReference.observedAt = new Date(Date.parse(d.publishedAt) + 1000).toISOString(); },
    d => { d.handicapAnalysis.marketReference.handicapLine *= -1; }
  ]) {
    const copy = cloned();
    const row = copy.recommendationCenter.current.find(item => item.decision.handicapAnalysis?.version === 'handicap-margin-v3');
    mutation(row.decision);
    assert.throws(() => view.parseRecommendationCenter(copy));
  }
});

test('old quotes and incomplete old records show missing SP without invented current prices', async () => {
  const { decision } = await actualFrozenDecision();
  const stale = { ...decision, quoteObservedAt: new Date(Date.parse(decision.publishedAt) - 16 * 60_000).toISOString() };
  const staleView = compare.buildMarketComparison(stale);
  assert.equal(staleView.markets[0].quoteStatus, 'expired');
  assert.ok(staleView.markets[0].outcomes.every(outcome => outcome.frozenSp === null));
  const old = { ...decision, quoteOdds: undefined,
    handicapAnalysis: { ...decision.handicapAnalysis, marketReference: null } };
  const oldView = compare.buildMarketComparison(old);
  assert.equal(oldView.markets[0].outcomes.filter(outcome => outcome.frozenSp !== null).length, 1);
  assert.equal(oldView.markets[1].quoteStatus, 'missing');
  assert.ok(oldView.markets[1].outcomes.every(outcome => outcome.frozenSp === null));
});

test('standalone v2 and invalid v3 remain distinct; no conditional probability becomes unconditional', async () => {
  const { decision } = await actualFrozenDecision();
  const h = decision.handicapAnalysis;
  const old = { ...decision, handicapAnalysis: { ...h, version: 'handicap-margin-v2', distributionBasis: undefined,
    overallProbabilities: { '1': .2, X: .3, '2': .5 }, probabilities: { '1': .8, X: .1, '2': .1 } } };
  const result = compare.buildMarketComparison(old);
  assert.equal(result.markets[1].probabilityBasis, 'standalone-historical');
  assert.equal(result.markets[1].outcomes.find(outcome => outcome.code === '2').probability, .5);
  assert.notEqual(result.markets[1].outcomes.find(outcome => outcome.code === '1').probability, .8);
  const invalid = { ...decision, handicapAnalysis: { ...h, straightProbabilities: { '1': .1, X: .2, '2': .7 } } };
  const blocked = compare.buildMarketComparison(invalid);
  assert.equal(blocked.markets[1].probabilityBasis, 'unavailable');
  assert.ok(blocked.markets[1].outcomes.every(outcome => outcome.probability === null));
});

test('standalone parsers reuse the same strict reconciliation logic', async () => {
  const { raw } = await actualFrozenDecision();
  const row = raw.recommendationCenter.current[0];
  assert.equal(view.parseRecommendationSingleRow(row).decision.recordHash, view.parseRecommendationCenter(raw).current[0].decision.recordHash);
  assert.equal(view.parseRecommendationSummary(raw.recommendationCenter.review.statistics.single).published,
    view.parseRecommendationCenter(raw).review.statistics.single.published);
  assert.throws(() => view.parseRecommendationSummary({ published: 1, settled: 0, won: 1, lost: 0, pending: 0, void: 0, disputed: 0 }));
});
