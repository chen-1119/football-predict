'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript');
// Compile the real TypeScript adapters, not a reimplementation of their selection rules.
const root = path.resolve(__dirname, '..'), cache = new Map();
function load(file) {
  const full = path.join(root, file);
  if (cache.has(full)) return cache.get(full).exports;
  const compiled = ts.transpileModule(fs.readFileSync(full, 'utf8'), { fileName: full,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = new Module(full); m.filename = full; cache.set(full, m);
  m.require = name => {
    if (name === './marketQuotePolicy') return load('src/services/marketQuotePolicy.ts');
    throw new Error(`Unexpected runtime dependency: ${name}`);
  };
  m._compile(compiled, full);
  return m.exports;
}
const display = load('src/services/bettingDisplay.ts');
const odds = { odds1: 2.1, oddsX: 3.3, odds2: 3.5 };
test('existing display entrypoint binds fallback source/time to the fallback value', () => {
  const value = display.getResolvedMatchOdds({ oddsSource: 'sporttery:had', oddsUpdatedAt: '2026-09-14T01:00:00Z', externalSignals: {
    source: '500.com:jczq', updatedAt: '2026-09-14T02:00:00Z', bookmakerOdds: { had: odds } } });
  assert.equal(value.had.source, '500.com:jczq');
  assert.equal(value.had.updatedAt, '2026-09-14T02:00:00.000Z');
});
test('official rows cannot be filled by reference prices', () => {
  const rows = display.getSportteryPoolRows({ externalSignals: { source: '500.com:jczq', bookmakerOdds: { had: odds } } }, 'zh');
  assert.equal(rows.find(row => row.poolCode === 'HAD').odds, null);
});
test('HHAD requires an explicit valid line even through the legacy availability function', () => {
  assert.equal(display.getOfficialResultPoolAvailability({ handicapOdds: odds, handicapOddsSource: 'sporttery:hhad' }).hasHhad, false);
  assert.equal(display.getOfficialResultPoolAvailability({ handicapOdds: odds, handicapOddsSource: 'sporttery:hhad', handicapLine: '0' }).hasHhad, true);
});
test('no market reference is upgraded into an official recommendation by an API call', () => {
  const input = { externalSignals: { source: '500.com:jczq', bookmakerOdds: { had: odds } } };
  assert.equal(display.isPredictionOfficialResultPoolAvailable(input,{ tipCode: '1', oddsPoolCode: 'HAD' }), false);
});
