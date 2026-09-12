'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../deploy/light-server/football-release-recovery.cjs'), 'utf8').replace(/\r\n/g, '\n');
const methods = ['waitForHealth', 'waitForNativeHealth'];
let cases = 0;
for (const method of methods) {
  const body = source.match(new RegExp('  ' + method + '\\(\\) \\{[\\s\\S]*?\\n  \\}'))?.[0];
  assert.ok(body);
  for (const scenario of ['late-success', 'never-ready', 'invalid-native']) {
    let clock = 0, polls = 0;
    const healthy = { storage: { primary: 'postgres', sqlite: { retired: true, available: false, readSource: 'postgres' },
      postgres: { available: true, baseReady: true, publication: { mode: 'active-generation', generationId: 'g-'+'a'.repeat(64), manifestHash: 'a'.repeat(64), sourceCycleId: 'fixture', committedAt: '2026-09-12T00:00:00Z' } }, fastResultIntegrity: { valid: true } }, data: { currentRead: { source: 'postgres' } } };
    const context = { TEST_MODE: false, Date: { now: () => clock, parse: Date.parse },
      Atomics: { wait: (_a, _b, _c, ms) => { clock += ms; } }, Int32Array, SharedArrayBuffer,
      fail: message => { throw new Error(message); } };
    const adapter = vm.runInNewContext('({' + body + '})', context);
    adapter.run = (command, args) => {
      assert.equal(command, 'curl'); assert.ok(args.includes('--max-time')); polls++;
      return { status: scenario === 'never-ready' || clock < 75000 ? 7 : 0,
        stdout: JSON.stringify(scenario === 'invalid-native' ? {} : healthy) };
    };
    if (scenario === 'late-success' || (scenario === 'invalid-native' && method === 'waitForHealth')) {
      adapter[method](); assert.ok(clock >= 75000 && clock < 180000);
    } else { assert.throws(() => adapter[method]()); assert.equal(clock, 180000); }
    assert.ok(polls <= 90); cases++;
  }
}
console.log(JSON.stringify({ok:true,cases,productionWrites:0,scope:'actual recovery methods with controlled time and transport; 75-second startup passes, unavailable or invalid native storage fails'}));
