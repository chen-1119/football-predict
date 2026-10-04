"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, after } = require("node:test");
const root = path.resolve(__dirname, "..");
const backtest = path.join(root, "scripts/runModelBacktest.cjs");
const verifier = path.join(root, "scripts/verifyRecommendationPairedEventScoring.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "football-backtest-entry-"));
const guardFile = path.join(directory, "guard.cjs");

// This preload prevents a bad entrypoint regression from reading real business
// data, writing anything, starting children, or silently loading DEV fixtures.
fs.writeFileSync(guardFile, `
const fs = require('node:fs');
const Module = require('node:module');
const child = require('node:child_process');
const forbidden = name => () => { throw Error('FORBIDDEN_IMPORT_SIDE_EFFECT:' + name); };
for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','copyFileSync','unlinkSync','rmSync','rmdirSync','truncateSync','createWriteStream','writeFile','appendFile','mkdir','rename','copyFile','unlink','rm','rmdir','truncate']) fs[name] = forbidden(name);
for (const name of ['writeFile','appendFile','mkdir','rename','copyFile','unlink','rm','rmdir','truncate']) fs.promises[name] = forbidden('promises.' + name);
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[name] = forbidden(name);
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const text = String(file).replace(/\\\\/g, '/');
  if (/\\/(?:public\\/data|server-data|model-research)\\//.test(text) || /\\.(?:db|sqlite)$/.test(text)) throw Error('FORBIDDEN_BUSINESS_READ:' + text);
  return read.call(this, file, ...args);
};
const load = Module._load;
Module._load = function(request, ...args) {
  if (/verifyRecommendationPairedEventScoring|collectorAttestationTestFixture/.test(request)) throw Error('FORBIDDEN_DEV_DEPENDENCY:' + request);
  return load.call(this, request, ...args);
};
`, "utf8");
after(() => { fs.unlinkSync(guardFile); fs.rmdirSync(directory); });

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MODEL_BACKTEST_") || ["PRIVATE_MODEL_ARTIFACT_STORAGE", "FOOTBALL_STORAGE_MODE",
      "CANDIDATE_PROSPECTIVE_REGISTRY_FILE", "BENCHMARK_PROSPECTIVE_LEDGER_FILE"].includes(key)) delete env[key];
  }
  return env;
};
const run = (args, env = cleanEnv()) => spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 30000 });

test("importing actual comparison does not execute self-tests, read business data, write, spawn, or load DEV fixtures", () => {
  const result = run(["--require", guardFile, "-e", `
    process.argv.push('--verify-strict-promotion-cohort', '--verify-null-fail-closed', '--verify-sqlite-streaming',
      '--verify-odds-observation-time', '--verify-recommendation-selection-time-order', '--verify-probability-selection', '--verify-selected-event-pairing');
    process.exit = () => { throw Error('FORBIDDEN_IMPORT_EXIT'); };
    const { recommendationSelectionComparison } = require(${JSON.stringify(backtest)});
    if (typeof recommendationSelectionComparison !== 'function') throw Error('missing real comparison');
    const report = recommendationSelectionComparison([]);
    if (report.gate.eligible || report.pairedSelectedEventComparison.candidate.status !== 'unavailable') throw Error('empty comparison promoted');
    console.log('import-safe-real-comparison');
  `]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "import-safe-real-comparison");
});

test("migrated production CLI flag rejects explicitly without falling through into a backtest", () => {
  const result = run(["--require", guardFile, backtest, "--verify-selected-event-pairing"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /moved to: node scripts\/verifyRecommendationPairedEventScoring\.cjs/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /FORBIDDEN_/);
});

test("independent DEV CLI exercises the same real comparison, signed settlement, paired scoring and gates", () => {
  const result = run([verifier]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.integrationExecuted, true);
  assert.equal(report.assertions, 29);
  assert.equal(report.checks.filter(row => row.ok).length, 29);
  for (const name of ["actual comparison keeps original cohorts and pairs model/market per cohort",
    "missing pairing retains descriptive stats but cannot activate",
    "cross-subset score advantage cannot mask inferior same-event model scoring",
    "pair set and scoring independent of input order",
    "real signed v2 constructor/replay/settler accepts HAD and HHAD"]) {
    assert.equal(report.checks.find(row => row.name === name)?.ok, true, name);
  }
});

test("retained time-order CLI still executes its real checks without DEV dependencies", () => {
  const result = run(["--require", guardFile, backtest, "--verify-recommendation-selection-time-order"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.verifier, "model-backtest-recommendation-selection-time-order");
  assert.ok(report.assertions > 0);
});

test("isolated input requires an isolated output before running any CLI check", () => {
  const env = { ...cleanEnv(), MODEL_BACKTEST_INPUT_DATA_DIR: directory };
  const result = run(["--require", guardFile, backtest, "--verify-recommendation-selection-time-order"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an explicit isolated/);
});

test("isolated output cannot overlap input even for retained CLI checks", () => {
  const env = { ...cleanEnv(), MODEL_BACKTEST_INPUT_DATA_DIR: directory,
    MODEL_BACKTEST_PUBLIC_OUTPUT_FILE: path.join(directory, "model-evaluation.json") };
  const result = run(["--require", guardFile, backtest, "--verify-recommendation-selection-time-order"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlaps a read-only input/);
  assert.deepEqual(fs.readdirSync(directory), ["guard.cjs"]);
});
