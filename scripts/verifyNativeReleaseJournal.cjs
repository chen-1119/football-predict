"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { createFixture, runRecovery, mapped, write } = require("./verifyReleaseRecovery.cjs");
const journal = require("./nativeReleaseJournal.cjs");
const oldIdentity = { bundleMarker: "a".repeat(64), liveMarker: "a".repeat(64) };
const topology = { clusterId: "7645341234567890123", databases: { football: "12345", football_release_aaaaaaaaaaaa_1789010100: "12346" } };
const initial = { kind: "initial-cutover", oldIdentity, topology, candidateDatabase: "football_release_aaaaaaaaaaaa_1789010100", archiveDatabase: "football_legacy_bbbbbbbbbbbb_1789010100" };
if (journal.BOOTSTRAP_SHA === null) assert.throws(() => journal.contractFor(initial), /no accepted native-capable bootstrap/);
else {
  assert.match(journal.BOOTSTRAP_SHA, /^[a-f0-9]{64}$/);
  const accepted = journal.contractFor({ ...initial, oldIdentity: { bundleMarker: journal.BOOTSTRAP_SHA, liveMarker: journal.BOOTSTRAP_SHA } });
  assert.equal(accepted.compatibleRuntimeSha256, journal.BOOTSTRAP_SHA);
  assert.equal(accepted.kind, "initial-cutover");
  assert.throws(() => journal.contractFor(initial), /exact accepted native-capable bootstrap/);
}
assert.throws(() => journal.contractFor({ ...initial, oldIdentity: { bundleMarker: "0".repeat(64), liveMarker: "0".repeat(64) } }), /bootstrap/);
assert.throws(() => journal.contractFor({ kind: "runtime-only", oldIdentity, topology }), /implicitly/);
const failedSha = "2671839d1f1580b73d1548466dbabea11c821aaa187ca71a62ae38195b82ac06";
assert.throws(() => journal.contractFor({ ...initial, oldIdentity: { bundleMarker: failedSha, liveMarker: failedSha } }), /bootstrap/);
const env = journal.nativeEnvironment("KEEP_ME=yes\n FOOTBALL_STORAGE_MODE='hybrid'\nENABLE_SQLITE_EXPORT=1\nENABLE_SQLITE_EXPORT=1\nFOOTBALL_POSTGRES_URL=postgresql://bad@remote/candidate\n");
assert.ok(env.includes("KEEP_ME=yes")); assert.equal(env.match(/ENABLE_SQLITE_EXPORT=/g).length, 1); assert.ok(!env.includes("remote"));
assert.equal(require("../server/storageMode.cjs").readStorageMode(Object.fromEntries(env.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))).postgresOnly, true);
const f = createFixture("prepared", { acceptedUi: true });
try {
  const identity = JSON.parse(fs.readFileSync(path.join(f.current, "trees/old-app.json")));
  const contract = journal.contractFor({ kind: "runtime-only", oldIdentity: identity, topology, nativeAlreadyActive: true });
  const result = journal.writeNativeSnapshot({ stagingDir: f.current, contract, environment: env }); assert.equal(result.databaseWrites, 0);
  assert.throws(() => journal.writeNativeSnapshot({ stagingDir: f.current, contract, environment: env }), { code: "EEXIST" });
  write(path.join(f.current, "transaction-version"), "4\n");
  const mock = mapped(f.root, "/mock-systemd.json"), state = JSON.parse(fs.readFileSync(mock));
  state.nativeHealth = true; state.nativeDatabaseTopology = topology; write(mock, JSON.stringify(state));
  const recovered = runRecovery(f); assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(fs.readFileSync(mapped(f.root, "/etc/football-predict/env"), "utf8"), env);
  assert.equal(fs.existsSync(f.current), false);
} finally {
  const resolved = fs.realpathSync(f.root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-release-recovery-")); fs.rmSync(resolved, { recursive: true });
}
const source = fs.readFileSync(path.join(__dirname, "../deploy/light-server/release-from-bundle.sh"), "utf8");
const begin = source.indexOf("initialize_release_recovery_snapshot()"), end = source.indexOf("\nwrite_recovery_phase()", begin);
const initializer = source.slice(begin, end);
assert.ok(initializer.indexOf("nativeReleaseJournal.cjs") > initializer.indexOf("snapshot_managed_config_for_rollback"));
assert.ok(initializer.indexOf("nativeReleaseJournal.cjs") < initializer.indexOf('mv -T -- "$RECOVERY_STAGING_DIR" "$RECOVERY_DIR"'));
console.log(JSON.stringify({ ok: true, checks: 8, scope: "publisher snapshot writer to actual v4 recovery CLI; systemd/DB identity mocked", productionWrites: 0 }));
