'use strict';
// Synthetic source mutations exercise the verifier without editing product files.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), script = path.join(root, 'scripts/verifyFrontendEvidenceSemantics.cjs');
const component = path.join(root, 'src/components/recommendations/SelectionQualityNote.tsx');
const source = fs.readFileSync(component, 'utf8'), scriptSource = fs.readFileSync(script, 'utf8'), realRequire = createRequire(script);
function run(modified) {
  let result;
  vm.runInNewContext(scriptSource, { __dirname: path.dirname(script), process: { exitCode: 0 },
    console: { log: value => { result = JSON.parse(value); } }, require: id => ['fs', 'node:fs'].includes(id) ? { ...fs,
      readFileSync: (file, ...args) => path.resolve(file) === component ? modified : fs.readFileSync(file, ...args) } : realRequire(id) });
  return result;
}
test('shared helper import plus actual calls is sufficient without a meaningless re-export', () => {
  assert(!source.includes('export { selectionPriceStatus, selectionReferenceLabel }'));
  const result = run(source);
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks.find(item => item.name.includes('positive EV')).ok, true);
});
test('synthetic removal of a shared helper call fails the static contract', () => {
  for (const call of ['selectionPriceStatus(quality)', 'selectionReferenceLabel(quality,language)']) {
    const result = run(source.replace(call, 'localImplementation(quality)'));
    assert.equal(result.checks[0].ok, false);
  }
});
test('synthetic local implementations cannot shadow the audited shared helper import', () => {
  for (const shadow of ['function selectionPriceStatus(quality) { return "model-supported"; }',
    'const selectionReferenceLabel = () => "formal";', 'const { selectionReferenceLabel } = localHelpers;']) {
    const result = run(source + '\n' + shadow);
    assert.equal(result.checks[0].ok, false);
    assert.equal(result.checks.find(item => item.name.includes('positive EV')).ok, true);
  }
});
