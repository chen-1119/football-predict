"use strict";
// Exercise the real failure trap and shared cleanup in owned temporary trees.
// The isolated NODE_HOME implements only the declared recovery CLI fixture;
// installed recovery, PostgreSQL, services and release directories are not used.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), checks = [], observedCases = [];
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n?/g, "\n");
const nativeSource = read("deploy/light-server/release-native.sh");
const sharedSource = read("deploy/light-server/release-from-bundle.sh");
const extract = (source, name) => {
  const found = source.match(new RegExp("^" + name + "\\(\\) \\{[\\s\\S]*?^\\}", "m"));
  assert.ok(found, "missing actual shell function: " + name);
  return found[0];
};
const nativeExit = extract(nativeSource, "native_exit");
const cleanup = extract(sharedSource, "cleanup_build_tree");
assert.equal((nativeExit.match(/\/usr\/local\/libexec\/football-release-recovery\.cjs/g) || []).length, 1);
const shell = process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash";
const tempParent = fs.realpathSync(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempParent, "football-native-failure-cleanup-"));
const tempIdentity = fs.lstatSync(temp), ownershipToken = crypto.randomBytes(24).toString("hex");
fs.writeFileSync(path.join(temp, ".fixture-owner"), ownershipToken, { flag: "wx" });
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const removeOwnedFixture = () => {
  const resolved = fs.realpathSync(temp), stat = fs.lstatSync(temp);
  assert.ok(path.isAbsolute(temp) && !stat.isSymbolicLink() && stat.isDirectory());
  assert.ok(samePath(resolved, path.resolve(temp)) && samePath(path.dirname(resolved), tempParent));
  assert.ok(path.basename(resolved).startsWith("football-native-failure-cleanup-"));
  assert.equal(stat.dev, tempIdentity.dev); assert.equal(stat.ino, tempIdentity.ino);
  assert.equal(fs.readFileSync(path.join(temp, ".fixture-owner"), "utf8"), ownershipToken);
  fs.rmSync(resolved, { recursive: true, force: false });
};
const stop = ["stop-candidate", "stop-heartbeat", "stop-barrier", "static-attestations"];
const cases = [
  { name: "successful rollback removes only the owned build and preserves failure 23", status: 23,
    events: [...stop, "recovery", "quiescent", "cleanup", "finish:error"], removed: true },
  { name: "candidate stop failure retains build and recovery", fail: "candidate", status: 1,
    events: ["stop-candidate"], removed: false },
  { name: "heartbeat stop failure retains build and recovery", fail: "heartbeat", status: 1,
    events: stop.slice(0, 2), removed: false },
  { name: "sync barrier stop failure retains build and recovery", fail: "barrier", status: 1,
    events: stop.slice(0, 3), removed: false },
  { name: "fixed recovery failure retains build and recovery", fail: "recovery", status: 1,
    events: [...stop, "recovery"], removed: false },
  { name: "active build process refuses cleanup after successful recovery", fail: "quiescent", status: 1,
    events: [...stop, "recovery", "quiescent"], removed: false },
  { name: "failed removal is explicit and retains original build", fail: "cleanup", status: 1,
    events: [...stop, "recovery", "quiescent", "cleanup"], removed: false },
  { name: "unexpected BUILD_DIR is rejected without touching its sentinel", unexpected: true, status: 1,
    events: [...stop, "recovery", "quiescent"], removed: false },
  { name: "no active recovery cleans owned build without invoking recovery", active: false, status: 23,
    events: [...stop, "quiescent", "cleanup", "finish:error"], removed: true },
  { name: "zero initial status remains an error after cleanup", initial: 0, status: 1,
    events: [...stop, "recovery", "quiescent", "cleanup", "finish:error"], removed: true },
  { name: "static attestation cleanup failure does not skip build cleanup", fail: "static", status: 23,
    events: [...stop, "recovery", "quiescent", "cleanup", "finish:error"], removed: true },
];
let failure = null, fixtureCleanupComplete = false;
try {
  for (const [index, item] of cases.entries()) {
    const caseDir = path.join(temp, "case-" + index), buildName = item.unexpected ? "outside-build" : "app.build-fixture";
    const buildDir = path.join(caseDir, buildName), eventsFile = path.join(caseDir, "events.log");
    for (const dir of [buildName, "app", "previous", "recovery", "fixture-node/bin"]) {
      fs.mkdirSync(path.join(caseDir, dir), { recursive: true });
      fs.writeFileSync(path.join(caseDir, dir, "preserve"), item.name + "\n");
    }
    // No substitution in native_exit is necessary: this fixture executable
    // accepts exactly the real fixed recovery command as its single argument.
    fs.writeFileSync(path.join(caseDir, "fixture-node/bin/node"),
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
      '[ "$#" = 1 ] && [ "$1" = /usr/local/libexec/football-release-recovery.cjs ] || exit 88\n' +
      'printf "recovery\\n" >>"$FIXTURE_LOG"\nexit "$FIXTURE_RECOVERY_STATUS"\n');
    const script = "set -euo pipefail\n" +
      'APP_DIR="$PWD/app"\nBUILD_DIR="$PWD/' + buildName + '"\n' +
      'NEXT_DIR="$PWD/next-not-created"\nNODE_HOME="$PWD/fixture-node"\n' +
      'RECOVERY_ACTIVE=' + (item.active === false ? "0" : "1") + '\nSWAP_STARTED=0\nNATIVE_NEXT_CREATED=0\n' +
      'export FIXTURE_LOG="$PWD/events.log" FIXTURE_RECOVERY_STATUS=' + (item.fail === "recovery" ? "1" : "0") + '\n' +
      'chmod 0700 "$NODE_HOME/bin/node"\n' +
      'fixture_event() { printf "%s\\n" "$1" >>"$FIXTURE_LOG"; }\n' +
      'log() { printf "%s\\n" "$*" >&2; }\n' +
      'stop_candidate() { fixture_event stop-candidate; return ' + (item.fail === "candidate" ? "1" : "0") + '; }\n' +
      'stop_release_candidate_heartbeat_keeper() { fixture_event stop-heartbeat; return ' + (item.fail === "heartbeat" ? "1" : "0") + '; }\n' +
      'stop_release_sync_write_barrier() { fixture_event stop-barrier; return ' + (item.fail === "barrier" ? "1" : "0") + '; }\n' +
      'cleanup_release_static_attestations() { fixture_event static-attestations; return ' + (item.fail === "static" ? "1" : "0") + '; }\n' +
      'assert_build_user_quiescent() { fixture_event quiescent; return ' + (item.fail === "quiescent" ? "1" : "0") + '; }\n' +
      'release_stage_observe() { [ "$#" = 2 ] && [ "$1" = finish ] && [ "$2" = error ] || return 1; fixture_event finish:error; }\n' +
      'rm() {\n  [ "$#" = 4 ] && [ "$1" = -rf ] && [ "$2" = --one-file-system ] && [ "$3" = -- ] && [ "$4" = "$PWD/app.build-fixture" ] || return 89\n' +
      '  fixture_event cleanup\n  ' + (item.fail === "cleanup" ? "return 1" : 'command rm "$@"') + '\n}\n' +
      cleanup + "\n" + nativeExit + "\ntrap native_exit EXIT\nexit " + (item.initial ?? 23) + "\n";
    const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const result = spawnSync(shell, ["--noprofile", "--norc", "-s"], {
      cwd: caseDir, input: script, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536, env,
    });
    const actualEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n") : [];
    observedCases.push({ name: item.name, exitStatus: result.status, buildRemoved: !fs.existsSync(buildDir),
      recoveryPreserved: fs.existsSync(path.join(caseDir, "recovery/preserve")), actualEvents });
    assert.equal(result.error, undefined, item.name + ": shell error");
    assert.equal(result.signal, null, item.name + ": shell interrupted");
    assert.equal(result.status, item.status, item.name + ": " + result.stderr);
    assert.deepEqual(actualEvents, item.events, item.name + ": actual failure sequence");
    assert.equal(fs.existsSync(buildDir), !item.removed, item.name + ": actual build deletion");
    for (const dir of ["app", "previous", "recovery"])
      assert.equal(fs.readFileSync(path.join(caseDir, dir, "preserve"), "utf8"), item.name + "\n", item.name + ": protected " + dir);
    if (!item.removed) assert.equal(fs.readFileSync(path.join(buildDir, "preserve"), "utf8"), item.name + "\n");
    if (item.unexpected) assert.match(result.stderr, /refusing to clean unexpected build path/);
    if (item.fail === "quiescent") assert.match(result.stderr, /build user is not quiescent/);
    if (item.fail === "cleanup") assert.match(result.stderr, /isolated build tree could not be cleaned/);
    checks.push({ name: item.name, ok: true, exitStatus: result.status, buildRemoved: item.removed,
      recoveryPreserved: true, protectedAppPreserved: true, actualEvents });
  }
  assert.ok(nativeSource.includes("native_data drop-candidate-access\n  cleanup_build_tree\n  snapshot_app_tree_identity"));
  checks.push({ name: "normal successful candidate cleanup still precedes app snapshot", ok: true });
} catch (error) {
  failure = { name: error.name, message: error.message };
} finally {
  try { removeOwnedFixture(); fixtureCleanupComplete = !fs.existsSync(temp); }
  catch (error) { failure = { name: error.name, message: "owned fixture cleanup refused: " + error.message }; }
}
const report = { ok: failure === null && fixtureCleanupComplete, checks, observedCases, failure, fixtureCleanupComplete,
  nativeSourceSha256: crypto.createHash("sha256").update(nativeSource).digest("hex"),
  sharedSourceSha256: crypto.createHash("sha256").update(sharedSource).digest("hex"),
  actualBashFunctions: ["native_exit", "cleanup_build_tree"],
  fixedRecoveryCommand: "/usr/local/libexec/football-release-recovery.cjs",
  recoveryCliIsFixture: true, productionWrites: 0, postgresAccesses: 0, serviceCommands: 0 };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
