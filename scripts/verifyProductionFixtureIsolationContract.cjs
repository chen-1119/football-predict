"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const contract = require("./productionFixtureIsolationContract.cjs");
function run() {
  const checks = [], check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
  const source = fs.readFileSync(path.join(__dirname, "verifyProductionReadiness.cjs"), "utf8");
  assert.ok(source.includes('const { isolationReportPassed } = require("./productionFixtureIsolationContract.cjs")'));
  const start = source.indexOf('  pushCheck(checks, "temporary verifier servers reject inherited production database settings",');
  const end = source.indexOf('\n  const dataValidationScopes', start);
  assert.ok(start >= 0 && end > start);
  const accepts = (body, overrides = {}) => {
    let result;
    vm.runInNewContext(source.slice(start, end), { checks: [], isolationReportPassed: contract.isolationReportPassed,
      fixtureIsolation: { status: 0, timedOut: false, body, stdout: "", stderr: "", ...overrides },
      pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
    return result;
  };
  const producer = fs.readFileSync(path.join(__dirname, "verifyProductionFixtureIsolation.cjs"), "utf8");
  let report;
  const calls = [];
  vm.runInNewContext(producer, { __dirname, process: { execPath: process.execPath, env: {} },
    require: name => name === "node:child_process" ? { spawnSync: (_node, args, options) => {
      calls.push({ script: path.basename(args[0]), inheritedStorage: options.env.FOOTBALL_STORAGE_MODE });
      assert.equal(options.env.FOOTBALL_POSTGRES_URL, "postgresql://fixture:fixture@127.0.0.1:1/fixture");
      return { status: 0, signal: null, stdout: '{"ok":true}' };
    } } : name === "./productionFixtureIsolationContract.cjs" ? contract : require(name),
    console: { log: json => { report = JSON.parse(json); } } }, { timeout: 1000 });
  check("actual six-case producer output passes actual production predicate", () => {
    assert.deepEqual(calls, contract.CASES); assert.equal(calls.length, 6); assert.equal(accepts(report), true);
  });
  const copy = () => structuredClone(report);
  check("legacy three-case output is rejected", () => { const r = copy(); r.checks = r.checks.slice(0, 3); assert.equal(accepts(r), false); });
  for (let i = 0; i < contract.CASES.length; i++) {
    check(`missing named case ${i} is rejected`, () => { const r = copy(); r.checks.splice(i, 1); assert.equal(accepts(r), false); });
  }
  for (const [name, mutate] of Object.entries({
    duplicate: r => { r.checks[5] = r.checks[0]; }, extra: r => { r.checks.push(r.checks[0]); },
    unknownScript: r => { r.checks[0].script = "unknown.cjs"; }, wrongMode: r => { r.checks[0].inheritedStorage = "unknown"; },
    childFailed: r => { r.checks[0].status = 1; }, childKilled: r => { r.checks[0].signal = "SIGTERM"; },
    childError: r => { r.checks[0].error = "ETIMEDOUT"; }, childRejected: r => { r.checks[0].ok = false; },
    missingSignal: r => { delete r.checks[0].signal; }, falseReport: r => { r.ok = false; },
    oldVersion: r => { r.verifier = "production-fixture-isolation-v1"; }, malformed: r => { r.checks = null; },
  })) check(`${name} evidence is rejected`, () => { const r = copy(); mutate(r); assert.equal(accepts(r), false); });
  check("failed parent process cannot supply passing JSON", () => assert.equal(accepts(report, { status: 1 }), false));
  check("timed-out parent process cannot supply passing JSON", () => assert.equal(accepts(report, { timedOut: true }), false));
  check("case ordering is immaterial but coverage is exact", () => { const r = copy(); r.checks.reverse(); assert.equal(accepts(r), true); });
  return { ok: true, verifier: "production-fixture-isolation-contract-v1", checks, productionWrites: 0, providerRequests: 0 };
}
module.exports = { run };
if (require.main === module) console.log(JSON.stringify(run(), null, 2));
