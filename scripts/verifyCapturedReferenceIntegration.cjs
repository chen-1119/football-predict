'use strict';

// Isolated integration contract: render the actual captured-detail branch and
// panel, and execute the actual list selection/SP/statistics expressions.
// No Vite, full MatchDetail hooks, syncData, network, generated files or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const now = Date.parse('2026-09-12T05:00:00.000Z');
const sourceFiles = new Set([
  'src/services/capturedReferenceAnalysis.ts',
  'src/components/predictions/CapturedReferenceAnalysisPanel.tsx',
  'src/components/predictions/CapturedMatchData.tsx',
  'src/components/predictions/sourceNeutralText.ts',
]);
const loaded = new Map();
let panelInitialTab = 'interpretation';
const clone = value => JSON.parse(JSON.stringify(value));
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const checks = [];
function check(name, callback) {
  callback();
  checks.push(name);
  console.log(`PASS ${name}`);
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function evaluate(source, filename, extra = {}) {
  const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const isolatedRequire = request => {
    if (request === 'react' && filename.endsWith('CapturedReferenceAnalysisPanel.tsx')) return {
      ...React,
      // Static rendering cannot click a tab. Override only this component's
      // initial tab state, then run its real JSX and React hooks unchanged.
      useState: initial => React.useState(initial === 'interpretation' ? panelInitialTab : initial),
    };
    if (request === 'react' || request === 'react/jsx-runtime') return require(request);
    if (request === 'lucide-react') return { ArrowLeft: () => null };
    assert.ok(request.startsWith('.'), `Non-whitelisted module: ${request}`);
    if (request.endsWith('.css')) return {};
    const resolved = path.resolve(path.dirname(filename), request);
    const candidate = [resolved, `${resolved}.ts`, `${resolved}.tsx`]
      .find(file => sourceFiles.has(path.relative(root, file).split(path.sep).join('/')));
    assert.ok(candidate, `Non-whitelisted source import: ${request}`);
    return load(candidate);
  };
  const context = vm.createContext({ module, exports: module.exports, require: isolatedRequire,
    Date, Intl, ...extra });
  new vm.Script(compiled, { filename }).runInContext(context, { timeout: 10_000 });
  return module.exports;
}
function load(filename) {
  const absolute = path.resolve(root, filename);
  if (!loaded.has(absolute)) loaded.set(absolute, evaluate(fs.readFileSync(absolute, 'utf8'), absolute));
  return loaded.get(absolute);
}
function readAst(relative) {
  const filename = path.join(root, relative);
  return ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function findNodes(node, predicate) {
  const found = [];
  const walk = current => { if (predicate(current)) found.push(current); ts.forEachChild(current, walk); };
  walk(node);
  return found;
}
function initializer(ast, name) {
  const nodes = findNodes(ast, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(nodes.length, 1, `Expected one real declaration of ${name}`);
  assert.ok(nodes[0].initializer, `${name} must have an initializer`);
  return nodes[0].initializer.getText(ast);
}

const detailAst = readAst('src/pages/MatchDetail.tsx');
const component = initializer(detailAst, 'MatchDetail');
const componentAst = ts.createSourceFile('component.tsx', `const Detail = ${component};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const branches = findNodes(componentAst, node => ts.isIfStatement(node)
  && node.expression.getText(componentAst).includes('matchesSavedCaptureIdentity')
  && node.thenStatement.getText(componentAst).includes('<CapturedReferenceAnalysisPanel'));
assert.equal(branches.length, 1, 'Expected exactly one real captured-reference detail branch');
const detailHarness = evaluate(`
  import { CapturedMatchData, matchesSavedCaptureIdentity } from '../components/predictions/CapturedMatchData';
  import { CapturedReferenceAnalysisPanel } from '../components/predictions/CapturedReferenceAnalysisPanel';
  import { formatSourceNeutralText } from '../components/predictions/sourceNeutralText';
  import { ArrowLeft } from 'lucide-react';
  export function ActualCapturedDetailBranch({ match, capturedData, language = 'zh', nowMs, onBack = () => {} }) {
    const displayText = (value, fallback = '') => formatSourceNeutralText(value, language, fallback);
    ${branches[0].getText(componentAst)}
    return <div data-existing-detail="true" />;
  }
`, path.join(root, 'src/pages/__captured_reference_integration__.tsx'));

const listAst = readAst('src/pages/PredictionsList.tsx');
const listNames = ['hasPick', 'savedAnalysis', 'capturedReference', 'capturedDirection', 'sp', 'settledStatus', 'resultLabel'];
const listHarness = evaluate(`
  import { buildCapturedReferenceAnalysis } from '../services/capturedReferenceAnalysis';
  const useMemo = callback => callback();
  const isSettledReviewStatus = ${initializer(listAst, 'isSettledReviewStatus')};
  const isFormalReviewRow = ${initializer(listAst, 'isFormalReviewRow')};
  const isLiveReviewRow = ${initializer(listAst, 'isLiveReviewRow')};
  // This harness contains no archive fixtures. Archive readers are isolated
  // from this regression; the real formal/reference statistics reducer runs.
  const getArchivedPreMatchPrediction = () => undefined;
  const getProvisionalArchivedOutcome = () => null;
  export const getDailyReviewStats = ${initializer(listAst, 'getDailyReviewStats')};
  export function selection(matches, capturedDataByMatchId, nowMs) {
    return ${initializer(listAst, 'capturedAnalyses')};
  }
  export function row({ match, capturedAnalyses, pickedPrediction, directionLabel = '',
    isVoid = false, isFinished = false, isInPlayArchiveFallback = false,
    isPublishedReferenceSpUnavailable = false, referenceOdds, fiveHundredDisplayOdds,
    publicCopy = { oddsLabel: '--' }, reviewRow, language = 'zh' }) {
    const recordedOdds = Number(pickedPrediction?.odds || 0);
    ${listNames.map(name => `const ${name} = ${initializer(listAst, name)};`).join('\n')}
    return { hasPick, capturedReference, capturedDirection, sp, settledStatus, resultLabel };
  }
`, path.join(root, 'src/pages/__captured_list_integration__.tsx'));

const dbPath = path.join(root, 'scripts/fixtures/captured-reference-20260912.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dbBefore = hash(dbPath);
const payload = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const match = payload.matches.find(item => item.id === 'sporttery_2041418');
assert.ok(match, 'Actual captured fixture must be present at the fixed verification time');
const capture = payload.capturedDataByMatchId[match.id];
assert.equal(capture.injuries.players.length, 5);
assert.deepEqual(capture.manualOdds.values, ['2.25', '3.30', '3.30']);
const before = JSON.stringify({ match, capture });
freeze(match); freeze(capture);
const { CapturedReferenceAnalysisPanel: Panel } = load('src/components/predictions/CapturedReferenceAnalysisPanel.tsx');
const { buildCapturedReferenceAnalysis: buildAnalysis } = load('src/services/capturedReferenceAnalysis.ts');
const detail = (item = match, saved = capture, time = now) => renderToStaticMarkup(React.createElement(
  detailHarness.ActualCapturedDetailBranch, { match: item, capturedData: saved, nowMs: time }));
const panel = (item = match, saved = capture, time = now, tab = 'interpretation') => {
  panelInitialTab = tab;
  try { return renderToStaticMarkup(React.createElement(Panel, { match: item, capture: saved, language: 'zh', now: time })); }
  finally { panelInitialTab = 'interpretation'; }
};

check('actual detail branch binds real capture, fixture and clock to the reference panel', () => {
  const html = detail(), text = visibleText(html);
  assert.ok(html.includes('captured-record-only'));
  assert.ok(text.includes('阿斯顿维拉') && text.includes('诺丁汉森林'));
  assert.ok(/42\.3\d?%/.test(text) && /1\s*-\s*0/.test(text) && /2\s*球/.test(text));
  assert.ok(text.includes('格雷茨卡') && text.includes('萨沃纳'));
});
check('the real panel renders reference probabilities and fitted goal parameters', () => {
  const text = visibleText(panel(match, capture, now, 'parameters'));
  const analysis = buildAnalysis(match, capture, now);
  assert.equal(analysis.status, 'available');
  assert.equal(analysis.outcome.code, 'home');
  assert.equal(analysis.goalsPick.label, '2');
  assert.ok(/参考/.test(text) && /42\.3\d?%/.test(text));
  assert.ok(/1\.23/.test(text) && /0\.96/.test(text) && /2\.19/.test(text));
  assert.ok(Math.abs(analysis.market.home - 0.423076923) < 1e-6);
});
check('wrong identity and absent capture never enter the real detail reference branch', () => {
  for (const invalid of [undefined, { ...capture, matchId: 'sporttery_999999' },
    { ...capture, awayName: '其他客队' }, { ...capture, kickoffTime: '2026-09-13T14:00:00.000Z' }]) {
    const html = detail(match, invalid === undefined ? null : invalid);
    assert.ok(html.includes('data-existing-detail'));
    assert.ok(!html.includes('captured-record-only') && !/42\.3\d?%/.test(html));
  }
});
const formalPick = freeze({ marketType: 'BEST', oddsPoolCode: 'HAD', handicapLine: '0', tipCode: '2',
  tipLabel: { zh: '客胜', en: 'Away win' }, odds: 2.45, recommendationAction: 'recommend',
  recommendationTier: 'main', resultStatus: 'PENDING', visibilityStatus: 'FREE' });
check('existing predictions, probability model or GPT analysis retain the original detail branch', () => {
  for (const existing of [{ ...match, predictions: [formalPick] },
    { ...match, probabilityModel: { version: 'existing-real-model' } },
    { ...match, gptPrediction: { explanation: { zh: '既有分析' } } }]) {
    const html = detail(freeze(existing));
    assert.ok(html.includes('data-existing-detail') && !html.includes('captured-record-only'));
  }
});
check('kickoff and completed matches receive a friendly unavailable panel without a new pick', () => {
  for (const [item, time] of [[match, Date.parse(match.kickoffTime)], [{ ...match, status: 'FINISHED' }, now]]) {
    const text = visibleText(panel(item, capture, time));
    assert.ok(text.length > 10);
    assert.ok(!/42\.3\d?%/.test(text) && !text.includes('1.23'));
    assert.ok(/开赛|结束|赛后|停止|不可|无法|暂不/.test(text));
  }
  assert.ok(!/42\.3\d?%/.test(visibleText(detail(match, capture, Date.parse(match.kickoffTime)))));
});
check('missing, partial and malformed odds show an unavailable state without fabricated probabilities', () => {
  for (const manualOdds of [null, { ...capture.manualOdds, values: ['2.25', '3.30'] },
    { ...capture.manualOdds, values: ['2.25', 'bad', '3.30'] },
    { ...capture.manualOdds, observedAt: '2026-09-12T06:00:00.000Z' }]) {
    const text = visibleText(panel(match, { ...capture, manualOdds }));
    assert.ok(text.length > 10 && !/42\.3\d?%/.test(text) && !text.includes('1.23'));
    assert.ok(/不足|缺少|无效|不完整|无法|暂不|未取得|时间|暂无|尚无/.test(text));
  }
});
check('the panel does not render private provenance or invent accuracy claims', () => {
  const polluted = { ...capture, sourceUrl: 'https://audit-source.example/private',
    manualOdds: { ...capture.manualOdds, sourceUrl: 'https://audit-source.example/odds',
      rowTimeAsDisplayed: 'https://audit-source.example/private' } };
  for (const tab of ['interpretation', 'parameters']) {
    const html = panel(match, polluted, now, tab), text = visibleText(html);
    assert.ok(!/audit-source|https?:\/\/|leisu\.com|500\.com|\/srv\/collector/.test(html));
    assert.ok(!/(?:准确率|命中率|置信度)\s*[:：]?\s*\d+(?:\.\d+)?\s*%/.test(text));
  }
});
check('real list selection admits only capture-only matches and leaves SP empty', () => {
  const variants = [match, { ...match, id: 'has-pick', predictions: [formalPick] },
    { ...match, id: 'has-model', probabilityModel: { version: 'real' } },
    { ...match, id: 'has-gpt', gptPrediction: {} }];
  const captures = Object.fromEntries(variants.map(item => [item.id, { ...capture, matchId: item.id }]));
  const selected = listHarness.selection(variants, captures, now);
  assert.equal(selected.size, 1);
  const row = listHarness.row({ match, capturedAnalyses: selected });
  assert.equal(row.capturedDirection, '主胜');
  assert.equal(row.sp, '--');
  assert.equal(row.settledStatus, undefined);
  assert.equal(row.resultLabel, '待赛果');
});
check('existing and frozen selected SP and settlement win over any captured reference', () => {
  const selected = listHarness.selection([match], { [match.id]: capture }, now);
  const scheduled = listHarness.row({ match, capturedAnalyses: selected, pickedPrediction: formalPick,
    directionLabel: '客胜', publicCopy: { oddsLabel: 'SP 2.45' } });
  assert.equal(scheduled.capturedReference, undefined);
  assert.equal(scheduled.sp, '2.45');
  for (const resultStatus of ['WON', 'LOST']) {
    const archived = listHarness.row({ match, capturedAnalyses: selected, pickedPrediction: formalPick,
      directionLabel: '客胜', isFinished: true, referenceOdds: { odds: 9.99 },
      publicCopy: { oddsLabel: 'SP 8.88' }, reviewRow: { resultStatus } });
    assert.equal(archived.sp, '2.45');
    assert.equal(archived.capturedReference, undefined);
    assert.equal(archived.settledStatus, resultStatus);
  }
  assert.equal(listHarness.row({ match, capturedAnalyses: selected, isVoid: true }).capturedReference, undefined);
});
check('actual list statistics do not count reference calculations as formal results', () => {
  const finished = freeze({ ...match, id: 'settled-fixture', status: 'FINISHED',
    postMatchReview: { predictionReview: { rows: [{ ...formalPick, performanceTrack: 'formal',
      reviewRole: 'main', resultStatus: 'WON' }] } } });
  const original = listHarness.getDailyReviewStats([finished], now);
  const withCapture = listHarness.getDailyReviewStats([finished, match], now);
  assert.equal(original.formalSettled, 1);
  for (const key of ['formalSettled', 'formalWon', 'formalHitRate', 'referenceBestSettled', 'analysisSettled']) {
    assert.equal(withCapture[key], original[key], `${key} must not change`);
  }
});
check('saved source fixture and frozen predictions remain unchanged', () => {
  assert.equal(JSON.stringify({ match, capture }), before);
  assert.equal(formalPick.odds, 2.45);
  assert.equal(formalPick.recommendationAction, 'recommend');
  assert.equal(match.predictions.length, 0);
  assert.equal(match.odds, null);
  assert.equal(hash(dbPath), dbBefore);
});
console.log(JSON.stringify({ ok: true, checks: checks.length, capturedFixture: match.id,
  scope: 'actual-detail-branch-and-list-expressions-with-real-panel',
  transpiledSources: [...loaded.keys()].map(file => path.relative(root, file)),
  networkUsed: false, productionWritten: false }));
