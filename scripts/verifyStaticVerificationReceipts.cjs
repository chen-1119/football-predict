"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const receipts = require("./staticVerificationReceipts.cjs");
const root = path.resolve(__dirname, ".."), clone = value => JSON.parse(JSON.stringify(value));

async function verifyStaticVerificationReceipts() {
  const checks = [], check = (name, callback) => { callback(); checks.push({ name, ok: true }); };
  const key = Buffer.alloc(32, 7), identity = { releaseSha: "a".repeat(64), inputs: { sha: "b".repeat(64) }, runtime: { node: "22.22.1" } };
  const body = { ok: true, checks: [{ name: "real check", ok: true }] };
  const result = { status: 0, timedOut: false, body, stdout: JSON.stringify(body), stderr: "" };
  const now = 1_788_800_000_000;
  const seal = receipts.sealReceipt({ identity, result, key, now, elapsedMs: 25 });
  const open = (value = seal, options = {}) => receipts.openReceipt(value, { identity, key, now: now + 100, ...options });
  check("same identity accepts authenticated successful result and retains original time", () => {
    const cached = open(); assert.deepEqual(cached.body, body);
    assert.equal(cached.verificationReceipt.verifiedAt, now); assert.equal(cached.verificationReceipt.reused, true);
  });
  check("untrusted receipt key rejected", () => assert.equal(open(seal, { key: Buffer.alloc(32, 8) }), null));
  check("changed release rejected", () => assert.equal(open(seal, { identity: { ...identity, releaseSha: "c".repeat(64) } }), null));
  check("changed complete inputs rejected", () => assert.equal(open(seal, { identity: { ...identity, inputs: { sha: "c".repeat(64) } } }), null));
  check("changed runtime rejected", () => assert.equal(open(seal, { identity: { ...identity, runtime: { node: "22.23.0" } } }), null));
  check("future receipt rejected", () => assert.equal(open(seal, { now: now - 1 }), null));
  check("expired receipt rejected", () => assert.equal(open(seal, { now: now + receipts.MAX_AGE_MS + 1 }), null));
  check("exact expiry boundary remains valid", () => assert.ok(open(seal, { now: now + receipts.MAX_AGE_MS })));
  for (const [name, change] of [
    ["body tampering", p => { p.result.body.checks.push({ name: "invented", ok: true }); }],
    ["output tampering", p => { p.result.stdout += " "; }],
    ["timestamp tampering", p => { p.checkedAt -= 1; }],
    ["elapsed tampering", p => { p.elapsedMs += 1; }],
    ["unknown format", p => { p.version = "unknown"; }],
  ]) check(`${name} rejected`, () => { const altered = clone(seal); change(altered.payload); assert.equal(open(altered), null); });
  for (const [name, patch] of [
    ["exit failure", { status: 1 }], ["timeout", { timedOut: true }],
    ["missing status", { status: undefined }], ["malformed stdout", { stdout: "not JSON" }],
    ["missing body", { body: null }],
    ["overall failure", { body: { ...body, ok: false } }],
    ["empty checks", { body: { ok: true, checks: [] } }],
    ["failed nested check", { body: { ok: true, checks: [{ ok: false }] } }],
  ]) check(`${name} is never signed as successful evidence`, () => assert.throws(() => receipts.sealReceipt({ identity, result: { ...result, ...patch }, key, now, elapsedMs: 1 })));
  check("truncated or missing receipt rejected", () => { assert.equal(open(null), null); assert.equal(open({}), null); });
  check("receipt HMAC cannot be replaced by an ordinary digest", () => {
    const altered = clone(seal); altered.mac = receipts.hashValue(altered.payload); assert.equal(open(altered), null);
  });
  const allowed = Object.keys(receipts.PROFILES);
  check("only explicitly audited source or isolated fixture commands eligible", () => assert.deepEqual(allowed.sort(), ["scripts/verifyBetSlipRecommendationGate.cjs", "scripts/verifyFrontendEvidenceSemantics.cjs", "scripts/verifySelectedJsonObjectFile.cjs"].sort()));
  for (const command of ["scripts/verifyApiContracts.cjs", "scripts/verifyModelPromotionGate.cjs", "scripts/verifyProductionPlanCoverage.cjs", "scripts/verifyFastResultProductionClone.cjs", "scripts/exportDataStoreSqlite.cjs"])
    check(`live or mixed command always executes: ${command}`, () => assert.equal(receipts.collectInputs(root, [command]), null));
  check("additional arguments are not treated as the audited command", () => assert.equal(receipts.collectInputs(root, [allowed[0], "--different-mode"]), null));
  const readiness = fs.readFileSync(path.join(root, "scripts/verifyProductionReadiness.cjs"), "utf8");
  const runnerStart = readiness.indexOf("const runLocalJsonFresh ="), runnerEnd = readiness.indexOf("const runLocalJson =", runnerStart);
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);
  const runnerSource = readiness.slice(runnerStart, runnerEnd);
  async function drainCase(oldExitBehavior) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const source = oldExitBehavior ? runnerSource.replace('childProcess.on("close",', 'childProcess.on("exit",') : runnerSource;
    const run = vm.runInNewContext(source + "\nrunLocalJsonFresh;", {
      spawn: () => child, childTimeoutMs: 1000, setTimeout, clearTimeout,
      process: { execPath: process.execPath, cwd: () => root, env: {}, stderr: { write() {} } },
    });
    const pending = run(["fixture-only.cjs"]);
    child.emit("exit", 0, null);
    child.stdout.emit("data", Buffer.from(JSON.stringify(body)));
    child.emit("close", 0, null);
    return pending;
  }
  const priorDrain = await drainCase(true), fixedDrain = await drainCase(false);
  check("old exit callback reproducibly loses final buffered JSON", () => assert.equal(priorDrain.body, null));
  check("actual updated child runner drains stdout before evaluating result", () => {
    assert.equal(fixedDrain.status, 0); assert.equal(fixedDrain.body.ok, true);
    assert.equal(fixedDrain.body.checks.length, 1); assert.equal(fixedDrain.timedOut, false);
  });
  const hangingChild = new EventEmitter(), kills = [], deadlines = [];
  hangingChild.stdout = new EventEmitter(); hangingChild.stderr = new EventEmitter();
  hangingChild.stdout.destroy = () => {}; hangingChild.stderr.destroy = () => {};
  hangingChild.kill = signal => { kills.push(signal); return false; };
  const hangingRunner = vm.runInNewContext(runnerSource + "\nrunLocalJsonFresh;", {
    spawn: () => hangingChild, childTimeoutMs: 1000,
    setTimeout: callback => { const timer = { callback, unref() {} }; deadlines.push(timer); return timer; }, clearTimeout() {},
    process: { execPath: process.execPath, cwd: () => root, env: {}, stderr: { write() {} } },
  });
  const hangingResult = hangingRunner(["fixture-only.cjs"]);
  hangingChild.emit("exit", 0, null);
  deadlines[0].callback(); assert.equal(deadlines.length, 2); deadlines[1].callback();
  const timeoutResult = await hangingResult;
  check("inherited open pipes cannot bypass the hard timeout after direct child exits", () => {
    assert.equal(timeoutResult.status, 124); assert.equal(timeoutResult.timedOut, true);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "football-static-receipt-verify-"));
  try {
    const copy = name => { const to = path.join(fixture, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(root, name), to); };
    for (const file of ["package.json", "package-lock.json", ...allowed, "src/services/generator.ts", "src/pages/BetSlipGenerator.tsx", "src/components/recommendations/RecommendationCenter.tsx", "src/services/recommendationCenterView.ts", "server/index.cjs", "server/selectedJsonObjectFile.cjs", "server/dataGenerationStore.cjs", "server/chunkedJsonFile.cjs"]) copy(file);
    const selectedArgs = ["scripts/verifySelectedJsonObjectFile.cjs"], selectedInputs = receipts.collectInputs(fixture, selectedArgs);
    check("isolated large JSON fixture binds its complete executing module closure", () => {
      assert.ok(selectedInputs);
      for (const file of ["server/selectedJsonObjectFile.cjs", "server/dataGenerationStore.cjs", "server/chunkedJsonFile.cjs"])
        assert.ok(selectedInputs.files.some(([name]) => name === file));
    });
    check("audited fixture import inventory includes the new bounded reader", () => {
      const expected = {
        "scripts/verifySelectedJsonObjectFile.cjs": ["node:assert/strict", "node:fs", "node:os", "node:path", "node:crypto", "node:child_process", "../server/selectedJsonObjectFile.cjs", "../server/dataGenerationStore.cjs"],
        "server/selectedJsonObjectFile.cjs": ["node:fs", "node:crypto"],
        "server/dataGenerationStore.cjs": ["node:crypto", "node:fs", "node:os", "node:path", "./chunkedJsonFile.cjs", "./selectedJsonObjectFile.cjs"],
        "server/chunkedJsonFile.cjs": ["node:fs", "node:crypto"],
      };
      for (const [name, imports] of Object.entries(expected)) {
        const source = fs.readFileSync(path.join(fixture, name), "utf8");
        assert.deepEqual([...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1]), imports);
      }
      // This inventory is a regression check, not an arbitrary-JS analyzer.
      // Exact reviewed entry/module hashes enforce enrollment in production.
    });
    check("shortened fixture mode is ineligible even with a prior full proof", () => {
      assert.equal(receipts.collectInputs(fixture, selectedArgs, { VERIFY_SELECTED_JSON_SKIP_LARGE: "1" }), null);
      assert.equal(receipts.collectInputs(fixture, [...selectedArgs, "--large-child"]), null);
    });
    for (const moduleName of ["server/selectedJsonObjectFile.cjs", "server/dataGenerationStore.cjs", "server/chunkedJsonFile.cjs"]) {
      fs.appendFileSync(path.join(fixture, moduleName), "\nrequire('./new-unaudited-dependency.cjs');\n");
      check(`changed executable module requires dependency reaudit: ${moduleName}`, () => assert.equal(receipts.collectInputs(fixture, selectedArgs), null));
      copy(moduleName);
    }
    const selectedSource = fs.readFileSync(path.join(fixture, selectedArgs[0]), "utf8");
    const cases = [...selectedSource.matchAll(/check\('([^']+)', /g)].map(match => match[1]);
    const fullBody = { ok: true, checks: 10, cases, largeEvidence: { maxRssKiB: 200000, evidence: {
      bytes: 472 * 1024 * 1024 + Buffer.byteLength('{"ignored":"","keep":{"x":"中😀","n":[1,true,null],"bulk":""},"updatedAt":"2026-09-07"}'),
      sha256: "d".repeat(64), selectedChars: 32 * 1024 * 1024 + 64,
      maxObservedDepth: 3, selectedKeys: ["keep", "updatedAt"],
    } } };
    const fixtureResult = body => ({ status: 0, body, stdout: JSON.stringify(body), timedOut: false });
    const fixtureIdentity = { ...identity, inputs: selectedInputs };
    check("complete fixture result uses its own exact authenticated output contract", () => {
      const sealed = receipts.sealReceipt({ identity: fixtureIdentity, result: fixtureResult(fullBody), key, now, elapsedMs: 6000 });
      assert.deepEqual(receipts.openReceipt(sealed, { identity: fixtureIdentity, key, now }).body, fullBody);
      assert.equal(receipts.success(fixtureResult(fullBody)), false);
    });
    for (const [name, change] of [
      ["skipped large fixture", body => { body.checks = 9; body.cases.pop(); body.largeEvidence = null; }],
      ["missing memory evidence", body => { body.largeEvidence = null; }],
      ["changed case inventory", body => { body.cases[0] = "different test"; }],
      ["truncated large input", body => { body.largeEvidence.evidence.bytes--; }],
      ["over-budget memory", body => { body.largeEvidence.maxRssKiB = 320 * 1024; }],
      ["missing retained key", body => { body.largeEvidence.evidence.selectedKeys.pop(); }],
      ["malformed content hash", body => { body.largeEvidence.evidence.sha256 = "unknown"; }],
    ]) check(`${name} cannot become reusable fixture success`, () => {
      const altered = clone(fullBody); change(altered);
      assert.throws(() => receipts.sealReceipt({ identity: fixtureIdentity, result: fixtureResult(altered), key, now, elapsedMs: 1 }));
    });
    const command = ["scripts/verifyBetSlipRecommendationGate.cjs"];
    const input = receipts.collectInputs(fixture, command); assert.ok(input);
    check("real source scanner dependency closure exists", () => assert.ok(input.files.some(([name]) => name === "src/services/generator.ts")));
    const sourcePath = path.join(fixture, "src/services/generator.ts"), source = fs.readFileSync(sourcePath), stat = fs.statSync(sourcePath);
    fs.appendFileSync(sourcePath, "\n// changed dependency\n"); fs.utimesSync(sourcePath, stat.atime, stat.mtime);
    check("changed dependency invalidates even if mtime restored", () => assert.notEqual(receipts.hashValue(receipts.collectInputs(fixture, command)), receipts.hashValue(input)));
    fs.writeFileSync(sourcePath, source);
    fs.appendFileSync(path.join(fixture, "package-lock.json"), "\n");
    check("dependency lock bytes invalidate", () => assert.notEqual(receipts.hashValue(receipts.collectInputs(fixture, command)), receipts.hashValue(input)));
    copy("package-lock.json");
    const scanned = ["scripts/verifyFrontendEvidenceSemantics.cjs"], tree = receipts.collectInputs(fixture, scanned);
    fs.mkdirSync(path.join(fixture, "src/outputs")); fs.writeFileSync(path.join(fixture, "src/outputs/new.ts"), "new source");
    check("nested outputs source membership is covered", () => assert.notEqual(receipts.hashValue(receipts.collectInputs(fixture, scanned)), receipts.hashValue(tree)));
    fs.appendFileSync(path.join(fixture, command[0]), "\n// add unknown input reading\n");
    check("new verifier code requires dependency reaudit, never auto-enrolls", () => assert.equal(receipts.collectInputs(fixture, command), null));
    copy(command[0]); fs.renameSync(sourcePath, sourcePath + ".retained");
    check("missing required dependency cannot reuse success", () => assert.throws(() => receipts.collectInputs(fixture, command)));
    fs.renameSync(sourcePath + ".retained", sourcePath);
    let calls = 0;
    const raw = () => { calls++; return Promise.resolve(result); };
    await receipts.runWithStaticReceipt({ rootDir: fixture, args: command, env: {}, execute: raw });
    await receipts.runWithStaticReceipt({ rootDir: fixture, args: command, env: {}, execute: raw });
    check("unconfigured receipt store executes every real check", () => assert.equal(calls, 2));
    await receipts.runWithStaticReceipt({ rootDir: fixture, args: command,
      env: { VERIFY_STATIC_RELEASE_SHA: "a".repeat(64), VERIFY_STATIC_RECEIPT_DIR: fixture, NODE_OPTIONS: "--require unsafe.js" }, execute: raw });
    check("inherited Node injection disables reuse", () => assert.equal(calls, 3));
    const actual = spawnSync(process.execPath, command, { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 15000 });
    check("audited real scanner still executes and passes against copied actual sources", () => { assert.equal(actual.status, 0, JSON.stringify({ stdout: actual.stdout, stderr: actual.stderr, error: actual.error?.message, signal: actual.signal })); assert.equal(JSON.parse(actual.stdout).ok, true); });
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  return { ok: true, verifier: "static-verification-receipts", checks, productionWrites: 0,
    scope: "authenticated evidence, exact audited dependency closure, real source scanner, fail-open-to-execution; not live acceptance or measured release acceleration" };
}
module.exports = { verifyStaticVerificationReceipts };
if (require.main === module) verifyStaticVerificationReceipts().then(report => console.log(JSON.stringify(report, null, 2)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
