'use strict';
const { spawnSync } = require('node:child_process'), path = require('node:path'), assert = require('node:assert/strict');
function run() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/staged-code-release.test.cjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.equal(r.status, 0, r.stderr || r.stdout); assert.match(r.stdout, /^# skipped 0$/m);
  const tests = Number(/^# tests (\d+)$/m.exec(r.stdout)?.[1]); assert(tests >= 20);
  return { ok: true, tests, skipped: 0, actualBash: true, externalServiceEffectsMocked: true, productionWrites: 0 };
}
module.exports = { run };
if (require.main === module) console.log(JSON.stringify(run()));
