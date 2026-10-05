'use strict';
// Transport contract only. SSH is mocked and no server is contacted.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');
const script = path.resolve(__dirname, '../scripts/captureHistoryRegression.cjs');
const realRequire = createRequire(script), program = path.resolve(__dirname, '../scripts/historyRegressionRemote.py');
function setup(t, focus) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'football-form-capture-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert.ok(path.basename(directory).startsWith('football-form-capture-test-'));
    fs.rmSync(directory, { recursive: true });
  });
  const calls = [], module = { exports: {} };
  let response = { ok: true, productionWrites: false, sameSnapshot: true, rows: [],
    version: focus ? 'bounded-online-history-form-supplement-v1' : 'bounded-online-history-export-v1',
    ...(focus ? { featureFocus: 'form', supplementOnly: true, candidateEligible: false } : {}) };
  function localRequire(name) {
    if (name === 'node:child_process') return { spawnSync(command, args, options) { calls.push({ command, args, options }); return { status: 0, stdout: Buffer.from(JSON.stringify(response)) }; } };
    if (name === './releaseSshHostKeyPin.cjs') return {
      validateReleaseSshHostKeyPin(options) { assert.equal(options.host, '134.175.132.183'); assert.equal(options.expectedFingerprint, 'SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to'); return { fingerprint: options.expectedFingerprint }; },
      buildPinnedSshBaseOptions() { return ['-o', 'StrictHostKeyChecking=yes']; },
    };
    return realRequire(name);
  }
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require: localRequire, module, __dirname: path.dirname(script), process, Buffer, TextDecoder, console });
  return { capture: module.exports.capture, calls, output: path.join(directory, 'capture.json'), setResponse(next) { response = next; } };
}
test('focus preserves pinned fixed program transport and exclusive outputs', t => {
  const h = setup(t, true);
  h.capture({ programFile: program, outputFile: h.output, featureFocus: 'form' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, 'ssh');
  assert.equal(h.calls[0].args.at(-1), 'sudo -n timeout --signal=TERM --kill-after=5s 110s python3 - --feature-focus=form');
  assert.deepEqual(h.calls[0].options.input, fs.readFileSync(program));
  assert.throws(() => h.capture({ programFile: program, outputFile: h.output, featureFocus: 'form' }), /OUTPUT_EXISTS/);
  assert.equal(h.calls.length, 1);
});
test('default command remains unchanged and unknown options never reach SSH', t => {
  const h = setup(t, false);
  assert.throws(() => h.capture({ programFile: program, outputFile: h.output, featureFocus: 'xg' }), /EXPORT_MODE_NOT_ALLOWED/);
  assert.throws(() => h.capture({ programFile: program, outputFile: h.output, command: 'arbitrary' }), /EXPORTER_OPTIONS_NOT_ALLOWED/);
  assert.equal(h.calls.length, 0);
  h.capture({ programFile: program, outputFile: h.output });
  assert.equal(h.calls[0].args.at(-1), 'sudo -n timeout --signal=TERM --kill-after=5s 110s python3 -');
});
test('focus refuses ordinary or promoted responses without writing capture', t => {
  const h = setup(t, true);
  for (const response of [
    { ok: true, productionWrites: false, sameSnapshot: true, rows: [], version: 'bounded-online-history-export-v1' },
    { ok: true, productionWrites: false, sameSnapshot: true, rows: [], version: 'bounded-online-history-form-supplement-v1', featureFocus: 'form', supplementOnly: true, candidateEligible: true },
  ]) {
    h.setResponse(response);
    assert.throws(() => h.capture({ programFile: program, outputFile: h.output, featureFocus: 'form' }), /INVALID_READ_ONLY_RECEIPT/);
    assert.equal(fs.existsSync(h.output), false);
  }
});
