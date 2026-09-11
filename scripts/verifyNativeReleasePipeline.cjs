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
if (actualJournal.BOOTSTRAP_SHA) assert.equal(require("./validateNativeReleasePolicy.cjs").readPolicy(path.join(root, "deploy/light-server/native-release-policy.json")).ok, true);
else assert.throws(() => require("./validateNativeReleasePolicy.cjs").readPolicy(path.join(root, "deploy/light-server/native-release-policy.json")), /accepted bootstrap proof/);
console.log(JSON.stringify({ ok: true, checks, productionWrites: 0, bootstrapAccepted: Boolean(actualJournal.BOOTSTRAP_SHA),
  scope: "actual policy parser and shell dispatch fixture; full data preparation and live cutover are separate required evidence" }));
