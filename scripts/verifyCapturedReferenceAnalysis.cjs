'use strict';

// Pure numerical and input-identity verification only. No collector, production
// model, database, app context, network call, or generated artifact is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const fileName = path.join(root, 'src/services/capturedReferenceAnalysis.ts');
const source = fs.readFileSync(fileName, 'utf8');
const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
for (const statement of ast.statements) {
  if (ts.isImportDeclaration(statement)) assert.equal(statement.importClause?.isTypeOnly, true, 'Service imports must be erased type imports');
}
const compiled = ts.transpileModule(source, { fileName, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.equal(compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), false);
const service = {};
new Function('require', 'exports', compiled.outputText)(name => { throw new Error('Unexpected runtime dependency: ' + name); }, service);
const { buildCapturedReferenceAnalysis: analyze } = service;

const sampleDir = path.join(root, 'collectors/leisu-prematch/samples');
const saved = JSON.parse(fs.readFileSync(path.join(sampleDir, 'logged-in-validation.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(sampleDir, 'fixtures.2026-09-12.json'), 'utf8'));
const fixture = fixtures.matches.find(row => row.id === 'sporttery_2041418');
assert.ok(fixture);
const match = { id: fixture.id, homeTeamName: fixture.homeTeamName, awayTeamName: fixture.awayTeamName,
  kickoffTime: fixture.kickoffTime, status: 'SCHEDULED' };
const capture = { matchId: match.id, homeName: match.homeTeamName, awayName: match.awayTeamName,
  kickoffTime: match.kickoffTime, predictionEligible: false,
  injuries: { observedAt: saved.analysisPage.observedAt, players: [] },
  lineup: { status: 'unverified', observedAt: null, message: '' },
  manualOdds: { observedAt: saved.oddsHistoryPage.observedAt, rowTimeAsDisplayed: '09-12 09:07',
    values: saved.oddsHistoryPage.manualVisualReview.historyRowOdds.find(row => row.rowKey === 'history-1').winDrawLossAsDisplayed,
    method: 'manual-visual-review' } };
const NOW = Date.parse('2026-09-12T04:00:00.000Z');
const withOdds = values => ({ ...structuredClone(capture), manualOdds: { ...capture.manualOdds, values } });
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const probability = value => assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, 'invalid probability ' + value);
const sum = values => values.reduce((total, value) => total + value, 0);
const factorialLog = count => { let result = 0; for (let n = 2; n <= count; n++) result += Math.log(n); return result; };
const independentScore = (h, a, lh, la) => Math.exp(-lh - la + h * Math.log(lh) + a * Math.log(la) - factorialLog(h) - factorialLog(a));
function invariants(result) {
  assert.equal(result.status, 'available', result.reason);
  assert.equal(result.recommendationAction, 'reference');
  assert.equal(result.productionEligible, false);
  assert.match(result.version, /independent-poisson-reference-v1$/);
  const model = result.model;
  assert.ok(model.homeLambda >= 0.02 && model.homeLambda <= 8);
  assert.ok(model.awayLambda >= 0.02 && model.awayLambda <= 8);
  near(model.totalLambda, model.homeLambda + model.awayLambda);
  assert.ok(model.fitMaxError <= 0.005);
  probability(model.matrixMass); probability(model.tailMass);
  assert.ok(model.matrixMass >= 0.999999);
  near(model.matrixMass + model.tailMass, 1, 1e-15);
  for (const code of ['home', 'draw', 'away']) {
    probability(result.market[code]); probability(model.fittedOutcome[code]);
    assert.ok(Math.abs(result.market[code] - model.fittedOutcome[code]) <= 0.005);
  }
  near(result.market.home + result.market.draw + result.market.away, 1, 1e-15);
  near(sum(Object.values(model.fittedOutcome)), model.matrixMass, 2e-15);
  assert.equal(result.outcome.probability, result.market[result.outcome.code]);
  near(result.outcome.gap, [...['home', 'draw', 'away'].map(code => result.market[code])].sort((a, b) => b - a)[0]
    - [...['home', 'draw', 'away'].map(code => result.market[code])].sort((a, b) => b - a)[1]);
  probability(result.outcome.probability); probability(result.outcome.gap);
  assert.equal(result.scores.length, 5);
  assert.equal(new Set(result.scores.map(row => `${row.home}:${row.away}`)).size, 5);
  for (const [index, row] of result.scores.entries()) {
    assert.ok(Number.isInteger(row.home) && row.home >= 0 && Number.isInteger(row.away) && row.away >= 0);
    probability(row.probability);
    near(row.probability, independentScore(row.home, row.away, model.homeLambda, model.awayLambda), 1e-14);
    if (index) assert.ok(result.scores[index - 1].probability >= row.probability);
  }
  const allScores = [];
  for (let home = 0; home <= 35; home++) {
    for (let away = 0; away <= 35; away++) allScores.push(independentScore(home, away, model.homeLambda, model.awayLambda));
  }
  allScores.sort((a, b) => b - a);
  result.scores.forEach((row, index) => near(row.probability, allScores[index], 1e-14));
  assert.ok(sum(result.scores.map(row => row.probability)) < 1, 'top five scores are not renormalized');
  assert.deepEqual(result.totalGoals.map(row => row.label), ['0', '1', '2', '3', '4', '5', '6', '7+']);
  result.totalGoals.forEach(row => probability(row.probability));
  near(sum(result.totalGoals.map(row => row.probability)), 1, 1e-15);
  assert.ok(result.totalGoals.some(row => row.label === result.goalsPick.label && row.probability === result.goalsPick.probability));
  near(result.goalsPick.probability, Math.max(...result.totalGoals.map(row => row.probability)));
  probability(result.under25); probability(result.over25); probability(result.btts);
  near(result.under25 + result.over25, 1, 1e-15);
  near(result.over25, sum(result.totalGoals.slice(3).map(row => row.probability)), 1e-15);
  near(result.btts, (1 - Math.exp(-model.homeLambda)) * (1 - Math.exp(-model.awayLambda)), 1e-15);
  return result;
}
const checks = [];
const check = (name, run) => { try { run(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.message }); } };
const reject = (m, c, now, reason) => {
  const result = analyze(m, c, now);
  assert.deepEqual(result, { version: 'captured-1x2-independent-poisson-reference-v1', status: 'unavailable', reason });
};

check('real saved 2.25/3.30/3.30 observation produces only an explicitly labelled uncalibrated reference', () => {
  assert.deepEqual(capture.manualOdds.values, ['2.25', '3.30', '3.30']);
  const result = invariants(analyze(match, capture, NOW));
  assert.deepEqual(result.inputOdds, [2.25, 3.30, 3.30]);
  assert.equal(result.inputObservedAt, saved.oddsHistoryPage.observedAt);
  near(result.market.home, 11 / 26);
  near(result.market.draw, 15 / 52);
  near(result.market.away, 15 / 52);
  near(result.market.overround, 1 / 2.25 + 2 / 3.30 - 1);
  assert.equal(result.outcome.code, 'home');
  assert.equal('calibrated' in result, false);
});
check('most likely draw score is retained even when the market favourite is home', () => {
  const result = invariants(analyze(match, withOdds(oddsFromRates(1.6, 1.3)), NOW));
  assert.equal(result.outcome.code, 'home');
  assert.deepEqual([result.scores[0].home, result.scores[0].away], [1, 1]);
});
check('equal home/away odds give symmetric fitted rates and win probabilities', () => {
  const result = invariants(analyze(match, withOdds(['2.80', '3.30', '2.80']), NOW));
  near(result.model.homeLambda, result.model.awayLambda, 1e-15);
  near(result.market.home, result.market.away, 1e-15);
  near(result.model.fittedOutcome.home, result.model.fittedOutcome.away, 1e-15);
});
check('swapping home/away quotes swaps both lambdas and outcomes while preserving totals and both-teams-to-score', () => {
  const forward = invariants(analyze(match, withOdds(['1.75', '3.70', '4.60']), NOW));
  const reverse = invariants(analyze(match, withOdds(['4.60', '3.70', '1.75']), NOW));
  near(forward.model.homeLambda, reverse.model.awayLambda, 1e-12);
  near(forward.model.awayLambda, reverse.model.homeLambda, 1e-12);
  near(forward.market.home, reverse.market.away, 1e-15);
  near(forward.over25, reverse.over25, 1e-15);
  near(forward.btts, reverse.btts, 1e-15);
  assert.equal(forward.outcome.code, 'home'); assert.equal(reverse.outcome.code, 'away');
  assert.deepEqual(forward.totalGoals, reverse.totalGoals);
});
check('identity, reference-only and match status gates refuse cross-match and in-play analysis', () => {
  reject(match, undefined, NOW, 'capture-missing');
  for (const change of [{ id: '' }, { homeTeamName: '' }, { awayTeamName: '' }, { homeTeamName: match.awayTeamName }]) reject({ ...match, ...change }, capture, NOW, 'invalid-match-identity');
  for (const change of [{ matchId: 'sporttery_1' }, { homeName: '另一主队' }, { awayName: '另一客队' },
    { homeName: capture.awayName, awayName: capture.homeName }, { kickoffTime: '2026-09-12T14:01:00Z' }]) reject(match, { ...capture, ...change }, NOW, 'capture-identity-mismatch');
  reject(match, { ...capture, predictionEligible: true }, NOW, 'capture-not-reference-only');
  for (const status of ['LIVE', 'FINISHED', 'PENDING_RESULT', 'POSTPONED', 'CANCELLED', 'UNKNOWN']) reject({ ...match, status }, capture, NOW, 'match-not-scheduled');
  reject(match, capture, Date.parse(match.kickoffTime), 'match-started');
});
check('timestamps require explicit zones, valid calendars, past observation and pre-kickoff capture', () => {
  for (const kickoffTime of ['2026-09-12T14:00:00', '2026-02-30T14:00:00Z', 'bad']) reject({ ...match, kickoffTime }, capture, NOW, 'invalid-time');
  reject(match, { ...capture, kickoffTime: '2026-09-12T14:00:00' }, NOW, 'invalid-time');
  reject(match, capture, NaN, 'invalid-time');
  for (const observedAt of ['2026-09-12T03:57:45', '2026-02-30T03:57:45Z', 'bad']) reject(match, { ...capture, manualOdds: { ...capture.manualOdds, observedAt } }, NOW, 'invalid-time');
  reject(match, { ...capture, manualOdds: { ...capture.manualOdds, observedAt: '2026-09-12T04:00:01Z' } }, NOW, 'observation-in-future');
  for (const observedAt of [match.kickoffTime, '2026-09-12T14:00:01Z']) reject(match, { ...capture, manualOdds: { ...capture.manualOdds, observedAt } }, NOW, 'observation-not-prematch');
  invariants(analyze(match, { ...capture, kickoffTime: '2026-09-12T22:00:00+08:00',
    manualOdds: { ...capture.manualOdds, observedAt: '2026-09-12T12:00:00+08:00' } }, NOW));
});
check('manual provenance and three finite decimal odds above one are mandatory', () => {
  reject(match, { ...capture, manualOdds: null }, NOW, 'manual-odds-missing');
  reject(match, { ...capture, manualOdds: { ...capture.manualOdds, method: 'automatic' } }, NOW, 'unsupported-capture-method');
  for (const values of [undefined, null, {}, [], ['2.25', '3.30'], ['2.25', '3.30', '3.30', '4.00'],
    [2.25, 3.30, 3.30], ['1.00', '3.30', '3.30'], ['0.00', '3.30', '3.30'], ['-2.25', '3.30', '3.30'],
    ['Infinity', '3.30', '3.30'], ['NaN', '3.30', '3.30'], ['9'.repeat(310) + '.00', '3.30', '3.30'],
    [' 2.25', '3.30', '3.30'], ['2.25', null, '3.30']]) reject(match, withOdds(values), NOW, 'invalid-odds');
});
check('infeasible low-draw and nearly-certain-draw markets fail the bounded fit threshold', () => {
  for (const values of [['2.00', '10000.00', '2.00'], ['1000.00', '1.01', '1000.00']]) reject(match, withOdds(values), NOW, 'fit-quality-insufficient');
});
function oddsFromRates(homeLambda, awayLambda) {
  const probabilities = { home: 0, draw: 0, away: 0 };
  for (let home = 0; home <= 45; home++) {
    for (let away = 0; away <= 45; away++) probabilities[home > away ? 'home' : home === away ? 'draw' : 'away'] += independentScore(home, away, homeLambda, awayLambda);
  }
  return ['home', 'draw', 'away'].map(code => (1 / (probabilities[code] * 1.02)).toFixed(2));
}
check('seeded plausible synthetic markets satisfy residual, mass, sorted-score and bucket invariants', () => {
  let seed = 0x451ad;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let iteration = 0; iteration < 32; iteration++) {
    const rates = [0.4 + random() * 3.4, 0.4 + random() * 3.4];
    invariants(analyze(match, withOdds(oddsFromRates(...rates)), NOW));
  }
});
check('7+ retains high-goal tail probability as one complete bucket', () => {
  const result = invariants(analyze(match, withOdds(oddsFromRates(7.5, 7.5)), NOW));
  assert.equal(result.goalsPick.label, '7+');
  assert.ok(result.totalGoals[7].probability > 0.98);
  assert.ok(result.model.tailMass < 0.000001);
  near(result.totalGoals[7].probability, 1 - sum(result.totalGoals.slice(0, 7).map(row => row.probability)), 1e-15);
});
check('unconfirmed markets, history fragments and all match predictions remain unused and unchanged', () => {
  const extra = { ...structuredClone(capture), manualMarkets: [{ market: 'totals', currentValues: ['999', '99', '999'] }],
    teamHistory: [{ side: 'home', matches: [{ score: '20-0' }, { score: '20-0' }, { score: '20-0' }] }] };
  const extendedMatch = { ...match, predictions: [{ odds: 1.11, model: 'untouched' }] };
  const before = JSON.stringify({ extendedMatch, extra });
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(extendedMatch); freeze(extra);
  assert.deepEqual(analyze(extendedMatch, extra, NOW), analyze(match, capture, NOW));
  assert.equal(JSON.stringify({ extendedMatch, extra }), before);
});

const ok = checks.every(row => row.ok);
console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), testScope: 'pure-reference-model-only',
  summary: { total: checks.length, passed: checks.filter(row => row.ok).length, failed: checks.filter(row => !row.ok).length }, checks }, null, 2));
if (!ok) process.exitCode = 1;
