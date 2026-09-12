"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict"), Module = require("node:module");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const root = path.resolve(__dirname, ".."), checks = [];
const read = name => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n?/g, "\n");
const bootstrap = "a".repeat(64), actualJournal = require("./nativeReleaseJournal.cjs");
// Exercise the real policy parser with a declared synthetic accepted identity.
// No production bootstrap is synthesized or written by this fixture.
const filename = path.join(__dirname, "validateNativeReleasePolicy.cjs"), m = new Module(filename, module);
m.filename = filename; m.paths = Module._nodeModulePaths(__dirname);
const originalRequire = Module.createRequire(filename);
m.require = name => name === "./nativeReleaseJournal.cjs" ? { ...actualJournal, BOOTSTRAP_SHA: bootstrap } : originalRequire(name);
m._compile(fs.readFileSync(filename, "utf8"), filename);
const { validateNativeReleasePolicy: validate, validateNativeRuntimeEnvironment: environment } = m.exports;
const policy = { version: "native-release-policy-v1", storageMode: "postgres-only", transactionVersion: 4, bootstrapSha256: bootstrap };
assert.equal(validate(policy).ok, true);
for (const mutation of [{ bootstrapSha256: null }, { bootstrapSha256: "b".repeat(64) }, { transactionVersion: 3 },
  { storageMode: "hybrid" }, { version: "unknown" }, { bypass: true }]) assert.throws(() => validate({ ...policy, ...mutation }));
checks.push("signed policy rejects incomplete, old-format, unknown or unaccepted bootstrap requests");
const identity = { bundleMarker: bootstrap, liveMarker: bootstrap };
assert.equal(environment("ENABLE_SQLITE_EXPORT=1\n", identity).kind, "initial-cutover");
assert.throws(() => environment("ENABLE_SQLITE_EXPORT=1\n", { bundleMarker: "b".repeat(64), liveMarker: "b".repeat(64) }));
const native = actualJournal.nativeEnvironment("KEEP_ME=yes\n");
assert.equal(environment(native, identity).kind, "runtime-only");
for (const content of [native + "ENABLE_SQLITE_EXPORT=0\n", native.replace("ENABLE_SQLITE_EXPORT=0", "ENABLE_SQLITE_EXPORT=1"),
  native.replace("PRIVATE_MODEL_ARTIFACT_STORAGE=postgres", "PRIVATE_MODEL_ARTIFACT_STORAGE=sqlite")]) assert.throws(() => environment(content, identity));
assert.throws(() => environment(native, { ...identity, liveMarker: "" }));
checks.push("native and initial environments require all storage selectors and completed live identity");
const source = read("deploy/light-server/release-from-bundle.sh"), lane = read("deploy/light-server/release-native.sh");
const start = source.indexOf('if [ -f "$TRUSTED_SOURCE_DIR/deploy/light-server/native-release-policy.json" ]; then');
const end = source.indexOf('\nnode -e "require(\'node:sqlite\')"', start); assert.ok(start > 0 && end > start);
assert.ok(start > source.indexOf('"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseStoragePreflight.cjs"'));
const fragment = source.slice(start, end), temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-dispatch-"));
try {
  const shell = process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash";
  fs.mkdirSync(path.join(temp, "deploy/light-server"), { recursive: true });
  fs.writeFileSync(path.join(temp, "deploy/light-server/native-release-policy.json"), JSON.stringify(policy));
  for (const status of [0, 1]) {
    fs.writeFileSync(path.join(temp, "deploy/light-server/release-native.sh"), `run_native_release() { printf 'native-lane\\n'; return ${status}; }\n`);
    const script = `set -euo pipefail\nTRUSTED_SOURCE_DIR='${temp.replaceAll("\\", "/")}'\n${fragment}\nprintf 'legacy-sqlite-work\\n'\n`;
    const result = spawnSync(shell, ["--noprofile", "--norc", "-s"], { input: script, encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8" } });
    assert.equal(result.status, status, result.stderr); assert.equal(result.stdout.includes("native-lane"), true);
    assert.equal(result.stdout.includes("legacy-sqlite-work"), false);
  }
  checks.push("actual signed shell dispatch exits native success and failure without reaching SQLite lane");
} finally {
  assert.equal(path.dirname(fs.realpathSync(temp)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(temp).startsWith("football-native-dispatch-")); fs.rmSync(temp, { recursive: true });
}
for (const token of ["native_data seed", "native_data final", "initialize_release_recovery_snapshot", "candidateReleaseContinuity.cjs",
  "verifyProductionReadiness.cjs", "wait_for_worker_official_publish_after", "wait_for_worker_readiness_idle_after", "REMOTE_REQUIRE_POSTGRES_ONLY=1",
  "commit_release_transaction", "verifyCandidateArtifactSeed.cjs"]) assert.ok(lane.includes(token), token);
assert.ok(lane.indexOf("initialize_release_recovery_snapshot") < lane.indexOf("native_data seed"));
assert.ok(lane.indexOf("native_data final") < lane.indexOf('mv "$APP_DIR" "$BACKUP_DIR"'));
assert.ok(lane.indexOf("wait_for_worker_official_publish_after") < lane.indexOf("commit_release_transaction"));
assert.ok(!lane.includes("datastore:sqlite") && !lane.includes("ensure_node_runtime_env"));
checks.push("native preparation, durable journal, data cutover and mandatory official acceptance retain their ordering");
const restoreFunction = source.match(/^restore_live_service_after_candidate_barrier\(\) \{[\s\S]*?^\}/m)?.[0];
const restoreCall = lane.match(/^  restore_live_service_after_candidate_barrier [a-z-]+$/m)?.[0];
assert.ok(restoreFunction && restoreCall);
for (const failure of ["none", "restart", "active", "health"]) {
  const script = "set -euo pipefail\nSERVICE_NAME=fixture HOST=127.0.0.1 PORT=8788\n" +
    "restart_service_if_needed() { " + (failure === "restart" ? "return 1" : "return 0") + "; }\n" +
    "systemctl() { " + (failure === "active" ? "return 1" : "return 0") + "; }\n" +
    "wait_for_health() { " + (failure === "health" ? "return 1" : "printf 'health-verified\\n'; return 0") + "; }\n" + restoreFunction + "\n" + restoreCall + "\nprintf 'restore-complete\\n'\n";
  const result = spawnSync(process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash", ["--noprofile", "--norc", "-s"],
    { input: script, encoding: "utf8", windowsHide: true, timeout: 5000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(result.status, failure === "none" ? 0 : 1, "native restore helper rejects its actual caller: " + failure);
  assert.equal(result.stdout.includes("restore-complete"), failure === "none");
}
checks.push("actual native cache handoff calls the shared restore helper with an accepted label and propagates restart and health failures");
const buildStep = source.match(/^run_build_step\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(buildStep);
const budgetScript = "set -euo pipefail\nTRANSACTION_VERSION=3 BUILD_USER=fixture BUILD_DIR=/fixture\nlog(){ :; }\nnext_transient_unit(){ NEXT_TRANSIENT_UNIT=fixture; }\ntransient_build_properties(){ :; }\nassert_transient_unit_cleared(){ :; }\nsystemd-run(){ printf '%s\\n' \"$@\"; }\n" + buildStep + "\nrun_build_step candidate-postgres-reconciled true\n";
const budgetResult = spawnSync(process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash", ["--noprofile", "--norc", "-s"],
 { input: budgetScript, encoding: "utf8", windowsHide: true, timeout: 5000, env: {PATH:process.env.PATH,SystemRoot:process.env.SystemRoot} });
assert.equal(budgetResult.status,0,budgetResult.stderr);
for (const token of ["MemoryHigh=1600M", "MemoryMax=2200M", "MemorySwapMax=512M", "NODE_OPTIONS=--max-old-space-size=1536"]) assert.ok(budgetResult.stdout.includes(token), token);
checks.push("actual native PostgreSQL build step receives the bounded large-projection memory allocation");
const refreshStep = source.match(/^run_candidate_refresh_step\(\) \{[\s\S]*?^\}/m)?.[0];
const refreshCall = lane.match(/^  run_candidate_refresh_step ([a-z-]+) env /m)?.[1];
assert.ok(refreshStep && refreshCall);
const refreshScript = budgetScript.slice(0, budgetScript.indexOf(buildStep)) +
  "NEXT_DIR=/next CANDIDATE_STORE_DIR=/store CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS=90\n" +
  refreshStep + "\nrun_candidate_refresh_step " + refreshCall + " true\n";
const refreshResult = spawnSync(process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash", ["--noprofile", "--norc", "-s"],
  { input: refreshScript, encoding: "utf8", windowsHide: true, timeout: 5000, env: { PATH:process.env.PATH, SystemRoot:process.env.SystemRoot } });
assert.equal(refreshResult.status,0,refreshResult.stderr);
for(const token of ["MemoryHigh=3G", "MemoryMax=3500M", "MemorySwapMax=512M", "NODE_OPTIONS=--max-old-space-size=2304", "RuntimeMaxSec=110s"])
  assert.ok(refreshResult.stdout.includes(token),token);
checks.push("actual native deadline refresh caller uses the measured native evidence memory and runtime limits");
const entries = ["scripts/nativeDatabaseCutover.cjs", "scripts/postgresReleaseMirror.cjs", "scripts/nativeReleaseDatabaseSession.cjs",
  "scripts/nativeReleaseDataPlane.cjs", "scripts/nativeReleaseGenerationCopy.cjs", "scripts/nativeReleasePostgresTransport.cjs",
  "scripts/validateNativeReleasePolicy.cjs", "scripts/verifyNativeReleasePipeline.cjs", "scripts/verifyNativeReleaseDataPlane.cjs",
  "deploy/light-server/release-native.sh", "deploy/light-server/native-release-policy.json"];
for (const entry of entries) for (const gate of ["scripts/createReleaseBundle.cjs", "scripts/verifyReleaseBundleSafety.cjs"])
  assert.ok(read(gate).includes(JSON.stringify(entry)), gate + ": " + entry);
checks.push("both signed archive gates require every native lane dependency and verifier");
const deploy = read("scripts/deployReleaseBundle.cjs");
const dispatchStart = deploy.indexOf("let nativeFullRelease = false;"), dispatchEnd = deploy.indexOf("let releaseWindowPreflight =", dispatchStart);
assert.ok(dispatchStart > deploy.indexOf("if (actualSha256 !== sidecarSha256 || actualSha256 !== manifest.sha256)"));
assert.ok(dispatchEnd > dispatchStart);
const dispatch = (present, selectedPolicy = policy) => vm.runInNewContext(deploy.slice(dispatchStart, dispatchEnd) + "\nnativeFullRelease;", {
  frontendOnly: false, bundlePath: "fixture.tgz", bundleInspection: { entries: present ? ["./deploy/light-server/native-release-policy.json"] : [] },
  inspectBundleEntryBytes: (_file, entry) => { const content = Buffer.from(entry.endsWith(".json") ? JSON.stringify(selectedPolicy) : 'const BOOTSTRAP_SHA = "' + bootstrap + '";');
    return { ok: true, bytes: content.length, content }; },
  require: name => { assert.equal(name, "./validateNativeReleasePolicy.cjs"); return m.exports; }, fail: reason => { throw Error(reason); },
}, { timeout: 1000 });
assert.equal(dispatch(true), true); assert.equal(dispatch(false), false); assert.throws(() => dispatch(true, { ...policy, bootstrapSha256: null }));
const cloneStart = deploy.indexOf("  if (!nativeFullRelease) {"), cloneEnd = deploy.indexOf("\n}\n// End authenticated local routing;", cloneStart);
assert.ok(cloneEnd > cloneStart);
for (const nativeFullRelease of [false, true]) {
  let calls = 0;
  vm.runInNewContext(deploy.slice(cloneStart, cloneEnd), { nativeFullRelease, rootDir: "/fixture", path: path.posix,
    process: { execPath: "/fixture/node" }, runCommand: (_command, args) => { assert.equal(args[0], "scripts/verifyFastResultProductionClone.cjs"); calls++; return { status: 0 }; },
    fail: reason => { throw Error(reason); } }, { timeout: 1000 });
  assert.equal(calls, nativeFullRelease ? 0 : 1);
}
checks.push("actual authenticated client routing removes SQLite clone work only for the signed native lane");
const recoveryStart = deploy.indexOf('  const sshRecoveryOk = recovery.status === 0');
const recoveryEnd = deploy.indexOf('  console.log(JSON.stringify({', recoveryStart);
assert.ok(recoveryStart > 0 && recoveryEnd > recoveryStart);
for (const storage of ['postgres-only', 'hybrid']) for (const success of [false, true]) {
  let selected = null;
  const recovered = vm.runInNewContext(deploy.slice(recoveryStart, recoveryEnd) + '\n({ok,publicVerify});', {
    recovery: { status: success ? 0 : 1, stdout: 'recoveryStorage=' + storage + '\nrecovery-ok\n' },
    runCommand: (_command, args, options) => { assert.equal(args[0], 'scripts/verifyRemotePublicReadiness.cjs'); selected = options.env; return {status:0,stdout:'{"ok":true}'}; },
    process: {execPath:'fixture-node',env:{}}, publicBaseUrl:'https://fixture.invalid', parseJson: value => {try{return JSON.parse(value)}catch{return null}},
  }, {timeout:1000});
  assert.equal(recovered.ok, success);
  if (!success) assert.equal(selected, null);
  else {
    assert.equal(selected.REMOTE_REQUIRE_SQLITE, storage === 'hybrid' ? '1' : '0');
    assert.equal(selected.REMOTE_REQUIRE_POSTGRES_ONLY, storage === 'postgres-only' ? '1' : '0');
    assert.equal(selected.REMOTE_REQUIRED_READ_SOURCE, storage === 'postgres-only' ? 'postgres' : '');
    assert.equal(selected.REMOTE_REQUIRE_SYNC_WORKER, '1');
  }
}
checks.push('actual cold recovery selects full public acceptance for the recovered storage and rejects failed recovery');
const { mirrorTimeBudget } = require("./postgresReleaseMirror.cjs");
assert.equal(mirrorTimeBudget(), 600000); assert.equal(mirrorTimeBudget(true), 1200000);
for (const value of [0, 999, 600001, Infinity]) assert.throws(() => mirrorTimeBudget(false, value));
assert.throws(() => mirrorTimeBudget(true, 1200001)); assert.throws(() => mirrorTimeBudget("true"));
const sessions = read("scripts/nativeReleaseDatabaseSession.cjs");
assert.equal(sessions.split("preparation: true").length, 2);
assert.ok(sessions.indexOf("preparation: true") < sessions.indexOf("async finalMirrorAndSwitch"));
checks.push("online full mirror has measured preparation margin while the stopped-window bound remains unchanged");
if (actualJournal.BOOTSTRAP_SHA) assert.equal(require("./validateNativeReleasePolicy.cjs").readPolicy(path.join(root, "deploy/light-server/native-release-policy.json")).ok, true);
else assert.throws(() => require("./validateNativeReleasePolicy.cjs").readPolicy(path.join(root, "deploy/light-server/native-release-policy.json")), /accepted bootstrap proof/);
console.log(JSON.stringify({ ok: true, checks, productionWrites: 0, bootstrapAccepted: Boolean(actualJournal.BOOTSTRAP_SHA),
  scope: "actual policy parser and shell dispatch fixture; full data preparation and live cutover are separate required evidence" }));
