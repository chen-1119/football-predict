const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
const allowedFiles = new Set([
  'src/components/predictions/MatchMarketOdds.tsx',
  'src/components/predictions/MatchSummaryRow.tsx',
  'src/components/predictions/CapturedMatchData.tsx',
  'src/components/predictions/sourceNeutralText.ts',
  'src/styles/captured-match-data.css',
  'src/services/bettingDisplay.ts',
  'src/services/archivedPreMatchPrediction.ts',
  'src/services/predictionVisibility.ts',
  'src/services/officialRecommendationEligibility.ts',
  'src/services/frozenReferenceMarketPair.cjs',
  'src/services/strictInstant.cjs'
].map(file => path.resolve(root, file)));
const cache = new Map();
const runtimeModules = new Set(['react/jsx-runtime', 'lucide-react']);
const compile = (source, fileName) => {
  const compiled = ts.transpileModule(source, { fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  assert.equal(compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), false, fileName);
  return compiled.outputText;
};
// Only the real, small presentation components and pure helpers run here.
// No Vite build, app context, network request or generated file is needed.
function loadPure(file) {
  const resolved = path.resolve(root, file);
  assert.ok(allowedFiles.has(resolved), 'Unexpected presentation dependency: ' + resolved);
  if (cache.has(resolved)) return cache.get(resolved);
  const exports = {};
  cache.set(resolved, exports);
  if (resolved.endsWith('.css')) return exports;
  if (resolved.endsWith('.cjs')) return require(resolved);
  const localRequire = name => {
    if (runtimeModules.has(name)) return require(name);
    assert.ok(name.startsWith('.'), 'Unexpected package dependency: ' + name);
    const stem = path.resolve(path.dirname(resolved), name);
    const dependency = [stem, stem + '.ts', stem + '.tsx', stem + '.cjs'].find(candidate => allowedFiles.has(candidate));
    assert.ok(dependency, 'Unexpected local dependency: ' + name);
    return loadPure(dependency);
  };
  new Function('require', 'exports', compile(read(resolved), resolved))(localRequire, exports);
  return exports;
}
const { MatchMarketOdds } = loadPure('src/components/predictions/MatchMarketOdds.tsx');
const { MatchSummaryRow } = loadPure('src/components/predictions/MatchSummaryRow.tsx');
const { getArchivedPreMatchPrediction } = loadPure('src/services/archivedPreMatchPrediction.ts');
const listSource = read('src/pages/PredictionsList.tsx');
const listAst = ts.createSourceFile('PredictionsList.tsx', listSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let rowBody;
function findRow(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'renderMatchRow') {
    assert.ok(node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body));
    rowBody = node.initializer.body;
  }
  ts.forEachChild(node, findRow);
}
findRow(listAst);
assert.ok(rowBody, 'Missing real match row');
const statementFor = name => {
  const found = rowBody.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.equal(found.length, 1, 'Missing or ambiguous real row value: ' + name);
  return found[0].getText(listAst);
};
const selectedSp = new Function('context', compile(`
  const { pickedPrediction, isVoid, isFinished, isInPlayArchiveFallback, isPublishedReferenceSpUnavailable,
    referenceOdds, fiveHundredDisplayOdds, publicCopy } = context;
  ${statementFor('recordedOdds')}
  ${statementFor('sp')}
  return sp;
`, 'selected-sp.ts'));
let summaryAttributes;
function findSummary(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(listAst) === 'MatchSummaryRow') summaryAttributes = node.attributes;
  ts.forEachChild(node, findSummary);
}
findSummary(rowBody);
assert.ok(summaryAttributes, 'Missing summary component');
const propExpression = name => {
  const prop = summaryAttributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(listAst) === name);
  assert.ok(prop?.initializer && ts.isJsxExpression(prop.initializer) && prop.initializer.expression, name);
  return prop.initializer.expression.getText(listAst);
};
const actualOddsProps = new Function('require', 'exports', 'MatchMarketOdds', 'match', 'language', 'sp', 'capturedDataByMatchId', compile(`
  return { marketOdds: (${propExpression('marketOdds')}), odds: (${propExpression('odds')}),
    marketOddsLabel: (${propExpression('marketOddsLabel')}) };
`, 'actual-odds-props.tsx'));

const checks = [];
function check(name, run) {
  try { run(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.message }); }
}
const base = {
  id: 'sporttery_42', sourceMatchId: '42', status: 'SCHEDULED',
  homeTeamName: '测试主队', awayTeamName: '测试客队',
  kickoffTime: '2030-09-12T12:00:00Z', eventVersion: '2030-09-12T12:00:00Z', predictions: [],
  odds: { odds1: 2.11, oddsX: 3.22, odds2: 4.33 }, oddsSource: 'sporttery:had',
  handicapOdds: { odds1: 1.45, oddsX: 4.56, odds2: 6.78 }, handicapOddsSource: 'sporttery:hhad', handicapLine: '-1'
};
const renderMarket = (match, language = 'zh', capturedData) => renderToStaticMarkup(React.createElement(MatchMarketOdds, { match, language, capturedData }));
const poolHtml = (html, code) => {
  const parts = html.split(/(?=<div class="compact-market-odds__row" data-market-pool=")/);
  const part = parts.find(value => value.startsWith('<div class="compact-market-odds__row" data-market-pool="' + code + '"'));
  assert.ok(part, 'Missing pool: ' + code);
  return part;
};
const prices = (html, code) => [...poolHtml(html, code).matchAll(/class="compact-market-odds__price"><span>[^<]*<\/span><strong>([^<]*)<\/strong>/g)].map(match => match[1]);
const assertPrices = (html, had, hhad) => {
  assert.deepEqual(prices(html, 'HAD'), had);
  assert.deepEqual(prices(html, 'HHAD'), hhad);
};
const hadPrices = ['2.11', '3.22', '4.33'], hhadPrices = ['1.45', '4.56', '6.78'], unavailable = ['--', '--', '--'];

check('complete official HAD and HHAD render six separately labelled prices', () => {
  const html = renderMarket(base);
  assertPrices(html, hadPrices, hhadPrices);
  for (const label of ['胜平负', '让球胜平负', '主胜', '平局', '客胜', '让胜', '让平', '让负', '主队 -1']) assert.ok(html.includes(label), label);
  assert.equal((html.match(/data-market-pool=/g) || []).length, 2);
});
check('HHAD renders signed integer home lines including zero without changing outcome prices', () => {
  for (const [line, label] of [['1', '+1'], ['+2.0', '+2'], ['0', '0'], ['-2', '-2'], [1, '+1']]) {
    const html = renderMarket({ ...base, handicapLine: line });
    assertPrices(html, hadPrices, hhadPrices);
    assert.ok(html.includes('主队 ' + label));
  }
});
check('missing or invalid current HHAD lines never borrow a recommendation archive line', () => {
  for (const line of [undefined, '', ' ', 'unknown', '0.5', '1/2', '9007199254740992', {}]) {
    const html = renderMarket({ ...base, handicapLine: line,
      archivedPreMatchPrediction: { prediction: { handicapLine: '-3', odds: 8.88 } },
      predictions: [{ oddsPoolCode: 'HHAD', handicapLine: '-3' }] });
    assertPrices(html, hadPrices, unavailable);
    assert.ok(html.includes('让球未确认'));
    assert.ok(!html.includes('主队 -3'));
  }
});
check('missing pools show six unavailable prices without claiming a sale state', () => {
  for (const status of ['SCHEDULED', 'LIVE', 'PENDING_RESULT', 'FINISHED']) {
    const html = renderMarket({ ...base, status, odds: undefined, handicapOdds: undefined });
    assertPrices(html, unavailable, unavailable);
    assert.ok(!/已停售|未开售|待开售|Closed|Sale closed/.test(html));
  }
});
check('external or unlabelled prices never replace official pool prices', () => {
  for (const source of [undefined, 'leisu', '500.com', 'sporttery:had-lookalike']) {
    const html = renderMarket({ ...base, oddsSource: source, handicapOddsSource: source,
      externalSignals: { bookmakerOdds: { had: base.odds, hhad: base.handicapOdds }, externalOdds: base.odds, handicapLine: '-1' } });
    assertPrices(html, unavailable, unavailable);
  }
});
check('incomplete or invalid prices hide the whole affected pool without affecting the other pool', () => {
  for (const invalid of [undefined, 0, 1, NaN, Infinity]) {
    assertPrices(renderMarket({ ...base, odds: { ...base.odds, oddsX: invalid } }), unavailable, hhadPrices);
    assertPrices(renderMarket({ ...base, handicapOdds: { ...base.handicapOdds, odds2: invalid } }), hadPrices, unavailable);
  }
});
check('valid numeric strings and official source suffixes retain their normalized display', () => {
  assertPrices(renderMarket({ ...base, odds: { odds1: '2.11', oddsX: '3.22', odds2: '4.33' },
    oddsSource: 'SPORTTERY:HAD:snapshot', handicapOddsSource: 'sporttery:hhad:snapshot' }), hadPrices, hhadPrices);
});
check('English output retains all six prices and explicit handicap semantics', () => {
  const html = renderMarket(base, 'en');
  assertPrices(html, hadPrices, hhadPrices);
  for (const label of ['1X2', 'Handicap', 'Home -1', 'H.Home', 'H.Draw', 'H.Away']) assert.ok(html.includes(label));
});
check('source URLs, source names, timestamps and probabilities are absent from public market markup', () => {
  const html = renderMarket({ ...base, oddsSource: 'sporttery:had:secret-provider-name',
    handicapOddsSource: 'sporttery:hhad:secret-provider-name', oddsUpdatedAt: 'private-updated-at-marker',
    sourceUrl: 'https://private-source.invalid/secret', sourcePath: '/private/source/path' });
  assertPrices(html, hadPrices, hhadPrices);
  assert.ok(!/secret-provider-name|sporttery:|private-source|private-updated|\/private\/|href=|支持率|%/.test(html));
});

const frozen = { ...structuredClone(base), status: 'FINISHED', archivedPreMatchPrediction: {
  version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot', sourceMatchId: '42',
  kickoffTime: base.kickoffTime, eventVersion: base.eventVersion,
  capturedAt: '2030-09-12T11:00:00Z', cutoffTime: base.kickoffTime, marketEvidenceScope: 'result-pool',
  prediction: { marketType: 'BEST', oddsPoolCode: 'HHAD', handicapLine: '-2', tipCode: '2', odds: 2.45,
    tipLabel: { zh: '让负', en: 'Handicap away' }, recommendationAction: 'reference', resultStatus: 'PENDING' }
} };
const now = Date.parse('2030-09-12T15:00:00Z');
const actualArchivedSp = match => selectedSp({ pickedPrediction: getArchivedPreMatchPrediction(match, now),
  isVoid: match.resultDisposition === 'VOID', isFinished: match.status !== 'LIVE',
  isInPlayArchiveFallback: match.status === 'LIVE', isPublishedReferenceSpUnavailable: false,
  referenceOdds: { odds: 7.77 }, fiveHundredDisplayOdds: 8.88, publicCopy: { oddsLabel: 'SP 9.99' } });
const renderSummary = (match, sp, capturedDataByMatchId) => renderToStaticMarkup(React.createElement(MatchSummaryRow, {
  eventKey: '42:event', tone: 'archive', timeLabel: '时间', teamsLabel: '比赛', pickLabel: '推荐方向',
  oddsLabel: 'SP', resultLabel: '结果', detailsLabel: '详情', time: '12:00', teams: 'Home / Away',
  pick: '让负', result: '待赛果', onOpen() {},
  ...actualOddsProps(require, {}, MatchMarketOdds, match, 'zh', sp, capturedDataByMatchId)
}));
check('finished pending and live market snapshots remain separate from the actual frozen recommendation SP', () => {
  for (const status of ['FINISHED', 'PENDING_RESULT', 'LIVE']) {
    const match = { ...frozen, status };
    const before = JSON.stringify(match);
    const sp = actualArchivedSp(match);
    assert.equal(sp, '2.45');
    const html = renderSummary(match, sp);
    assertPrices(html, hadPrices, hhadPrices);
    assert.ok(html.includes('比赛赔率快照'));
    assert.ok(html.includes('class="compact-sp">2.45</strong>'));
    assert.ok(html.includes('class="compact-sp-note">推荐方向</small>'));
    assert.ok(poolHtml(html, 'HHAD').includes('主队 -1'));
    assert.equal(getArchivedPreMatchPrediction(match, now).handicapLine, '-2');
    assert.equal(JSON.stringify(match), before);
  }
});
check('market repricing changes the snapshot while frozen SP stays unchanged', () => {
  const repriced = { ...frozen, handicapOdds: { odds1: 1.2, oddsX: 5.5, odds2: 9.9 }, handicapLine: '+1' };
  assert.equal(actualArchivedSp(repriced), '2.45');
  const html = renderSummary(repriced, actualArchivedSp(repriced));
  assertPrices(html, hadPrices, ['1.20', '5.50', '9.90']);
  assert.ok(html.includes('主队 +1'));
  assert.ok(html.includes('class="compact-sp">2.45</strong>'));
});
check('missing market pools preserve a valid recorded SP and missing archives never manufacture one', () => {
  const missingPools = { ...frozen, odds: undefined, handicapOdds: undefined };
  const html = renderSummary(missingPools, actualArchivedSp(missingPools));
  assertPrices(html, unavailable, unavailable);
  assert.ok(html.includes('class="compact-sp">2.45</strong>'));
  const noArchive = { ...frozen, archivedPreMatchPrediction: undefined };
  assert.equal(actualArchivedSp(noArchive), '--');
  assertPrices(renderSummary(noArchive, actualArchivedSp(noArchive)), hadPrices, hhadPrices);
});
check('void and unavailable published-reference gates still suppress only the selected SP', () => {
  assert.equal(actualArchivedSp({ ...frozen, resultDisposition: 'VOID' }), '--');
  assert.equal(selectedSp({ pickedPrediction: frozen.archivedPreMatchPrediction.prediction,
    isPublishedReferenceSpUnavailable: true }), '--');
});

const manualCapture = {
  matchId: base.id, homeName: base.homeTeamName, awayName: base.awayTeamName,
  kickoffTime: base.kickoffTime, predictionEligible: false,
  injuries: { observedAt: '2030-09-12T11:20:00Z', players: [] },
  lineup: { status: 'unverified', observedAt: null, message: '未取得阵容' },
  manualOdds: { observedAt: '2030-09-12T11:20:00Z', rowTimeAsDisplayed: '09-12 19:20',
    values: ['2.25', '3.30', '3.30'], method: 'manual-visual-review' }
};
const noOfficialPools = { ...base, odds: undefined, handicapOdds: undefined };
const manualPrices = ['2.25', '3.30', '3.30'];
const assertNoManual = html => assert.ok(!html.includes('data-market-pool="MANUAL_1X2"'), 'Unqualified manual odds must not be rendered');

check('actual list binding shows qualified manual prices separately while official pools and selected SP stay unavailable', () => {
  const match = { ...noOfficialPools, status: 'FINISHED' };
  const before = JSON.stringify({ match, manualCapture });
  const sp = actualArchivedSp(match);
  assert.equal(sp, '--');
  const html = renderSummary(match, sp, { [match.id]: manualCapture });
  assertPrices(html, unavailable, unavailable);
  assert.deepEqual(prices(html, 'MANUAL_1X2'), manualPrices);
  assert.equal((html.match(/data-market-pool=/g) || []).length, 3);
  for (const label of ['人工核对', '非竞彩 SP', '采集于', '19:20', '北京时间']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('class="compact-sp">--</strong>'));
  assert.equal(JSON.stringify({ match, manualCapture }), before, 'presentation cannot write captured prices back into the match');
});
check('manual quotes never replace an existing official HAD pool or mix into the HHAD pool', () => {
  for (const match of [base, { ...base, handicapOdds: undefined }]) {
    const html = renderMarket(match, 'zh', manualCapture);
    assertNoManual(html);
    assert.deepEqual(prices(html, 'HAD'), hadPrices);
  }
  const html = renderMarket({ ...base, odds: undefined }, 'zh', manualCapture);
  assertPrices(html, unavailable, hhadPrices);
  assert.deepEqual(prices(html, 'MANUAL_1X2'), manualPrices);
  assert.ok(poolHtml(html, 'HHAD').includes('主队 -1'));
});
check('manual capture must match the exact match id, both original names and kickoff instant', () => {
  for (const mutation of [
    { matchId: 'sporttery_43' }, { homeName: '另一主队' }, { awayName: '另一客队' },
    { homeName: base.awayTeamName, awayName: base.homeTeamName },
    { kickoffTime: '2030-09-12T12:01:00Z' }, { kickoffTime: 'invalid' }, { predictionEligible: true }
  ]) {
    const html = renderSummary(noOfficialPools, '--', { [base.id]: { ...manualCapture, ...mutation } });
    assertNoManual(html);
    assertPrices(html, unavailable, unavailable);
  }
  assertNoManual(renderSummary(noOfficialPools, '--', { sporttery_43: manualCapture }));
  assert.deepEqual(prices(renderMarket(noOfficialPools, 'zh', { ...manualCapture,
    kickoffTime: '2030-09-12T20:00:00+08:00' }), 'MANUAL_1X2'), manualPrices);
});
check('manual quotes require explicit valid capture time before kickoff and the manual review method', () => {
  for (const mutation of [
    { observedAt: '2030-09-12T11:20:00' }, { observedAt: 'invalid' }, { observedAt: null },
    { observedAt: base.kickoffTime }, { observedAt: '2030-09-12T12:00:01Z' },
    { method: 'automatic-extraction' }, { method: undefined }
  ]) {
    assertNoManual(renderMarket(noOfficialPools, 'zh', { ...manualCapture,
      manualOdds: { ...manualCapture.manualOdds, ...mutation } }));
  }
  const html = renderMarket(noOfficialPools, 'en', { ...manualCapture,
    manualOdds: { ...manualCapture.manualOdds, observedAt: '2030-09-12T19:20:00+08:00' } });
  assert.deepEqual(prices(html, 'MANUAL_1X2'), manualPrices);
  assert.ok(html.includes('Not Sporttery SP'));
  assert.ok(html.includes('19:20'));
});
check('missing, malformed, incomplete and nonfinite manual values stay hidden without throwing', () => {
  for (const values of [undefined, null, {}, [], ['2.25', '3.30'], ['2.25', '3.30', '3.30', '4.00'],
    ['1.00', '3.30', '3.30'], ['0.00', '3.30', '3.30'], ['NaN', '3.30', '3.30'],
    ['Infinity', '3.30', '3.30'], ['9'.repeat(310) + '.00', '3.30', '3.30'], [null, '3.30', '3.30']]) {
    assertNoManual(renderMarket(noOfficialPools, 'zh', { ...manualCapture,
      manualOdds: { ...manualCapture.manualOdds, values } }));
  }
  assertNoManual(renderMarket(noOfficialPools, 'zh', { ...manualCapture, manualOdds: null }));
});
check('manual reference display preserves archived recommendation SP and never exposes capture source addresses', () => {
  const match = { ...frozen, odds: undefined, handicapOdds: undefined };
  const capture = { ...manualCapture, sourceUrl: 'https://private-source.invalid/secret',
    manualOdds: { ...manualCapture.manualOdds, rowTimeAsDisplayed: 'https://private-source.invalid/row', sourceName: 'leisu' } };
  const before = JSON.stringify({ match, capture });
  const sp = actualArchivedSp(match);
  assert.equal(sp, '2.45');
  const html = renderSummary(match, sp, { [match.id]: capture });
  assertPrices(html, unavailable, unavailable);
  assert.deepEqual(prices(html, 'MANUAL_1X2'), manualPrices);
  assert.ok(html.includes('class="compact-sp">2.45</strong>'));
  assert.ok(!/private-source|href=|leisu/i.test(html));
  assert.equal(JSON.stringify({ match, capture }), before);
});

const ok = checks.every(item => item.ok);
console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), summary: {
  total: checks.length, passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length
}, checks }, null, 2));
if (!ok) process.exitCode = 1;
