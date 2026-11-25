"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { createFixture, runRecovery, mapped, write } = require("./verifyReleaseRecovery.cjs");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
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
const budgetKeys = ["CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS", "CANDIDATE_PROSPECTIVE_CAPTURE_RECOVERY_BUDGET_MS"];
const oldBudgetEnvironment = "KEEP_EXACT=retained value\nENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE=1\n"
  + "SYNC_WORKER_SYNC_TIMEOUT_MS=600000\nSYNC_WORKER_SQLITE_TIMEOUT_MS=600000\n"
  + budgetKeys.map(key => key + "=80000").join("\n") + "\n";
const nativeBudgetEnvironment = journal.nativeEnvironment(oldBudgetEnvironment);
const keyValues = (text, key) => text.split(/\r?\n/).filter(line => line.startsWith(key + "="));
for (const key of budgetKeys) {
  assert.deepEqual(keyValues(nativeBudgetEnvironment, key), [key + "=45000"]);
  assert.deepEqual(keyValues(journal.nativeEnvironment(nativeBudgetEnvironment), key), [key + "=45000"]);
}
const duplicateEnvironment = journal.nativeEnvironment(oldBudgetEnvironment
  + " export CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS = 90000\n"
  + "CANDIDATE_PROSPECTIVE_CAPTURE_RECOVERY_BUDGET_MS=100000\n");
for (const key of budgetKeys) assert.equal(duplicateEnvironment.match(new RegExp(key + "\\s*=", "g")).length, 1);
assert.equal(duplicateEnvironment.includes("90000"), false);
assert.equal(duplicateEnvironment.includes("100000"), false);
const semanticRows = text => text.split(/\r?\n/).filter(Boolean);
assert.deepEqual(semanticRows(journal.nativeEnvironment(nativeBudgetEnvironment)), semanticRows(nativeBudgetEnvironment));
for (const line of ["KEEP_EXACT=retained value", "ENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE=1", "SYNC_WORKER_SYNC_TIMEOUT_MS=600000", "SYNC_WORKER_SQLITE_TIMEOUT_MS=600000"]) assert(nativeBudgetEnvironment.includes(line + "\n"));
const workerEnvironment = Object.fromEntries(semanticRows(nativeBudgetEnvironment).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const workerProbe = spawnSync(process.execPath, ["-e", "const worker=require('./scripts/runSyncWorker.cjs');console.log(JSON.stringify({enabled:worker.candidateDeadlineCaptureEnabled,timeout:worker.candidateDeadlineCaptureTimeoutMs,recovery:worker.candidateDeadlineCaptureRecoveryBudgetMs,ttl:worker.candidateDeadlineHeartbeatFreshnessLimitMs,sync:worker.commandTimeouts.sync,sqlite:worker.commandTimeouts.sqlite,schedule:worker.candidateDeadlinePreemptiveSchedule('2026-10-23T12:00:00.000Z',Date.parse('2026-10-23T12:00:00.000Z'))}));"],
  { cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), ...workerEnvironment } });
assert.equal(workerProbe.status, 0, workerProbe.stderr || workerProbe.stdout);
const actualWorker = JSON.parse(workerProbe.stdout);
assert.equal(actualWorker.enabled, true); assert.equal(actualWorker.timeout, 45000); assert.equal(actualWorker.recovery, 45000);
assert.equal(actualWorker.ttl, 180000); assert.equal(actualWorker.sync, 600000); assert.equal(actualWorker.sqlite, 600000);
assert.equal(actualWorker.schedule.refreshAgeMs, 75000); assert.equal(actualWorker.schedule.budgetFits, true);
const recoveryCases = [];
for (const phase of ["prepared", "swap-complete", "committed"]) {
  const fixture = createFixture(phase, { acceptedUi: true });
  try {
    for (const name of ["sqlite", "external-model-artifacts"]) {
      const rewindDirectory = path.resolve(fixture.current, name);
      assert.equal(path.dirname(rewindDirectory), path.resolve(fixture.current));
      assert(path.resolve(fixture.current).startsWith(path.resolve(fixture.root) + path.sep));
      fs.rmSync(rewindDirectory, { recursive: true, force: true });
    }
    const snapshotFile = path.join(fixture.current, "runtime-env/env"), snapshotManifest = path.join(fixture.current, "runtime-env/manifest.tsv");
    const metadata = fs.readFileSync(snapshotManifest, "utf8").trim().split("\t");
    metadata[3] = String(Buffer.byteLength(oldBudgetEnvironment)); metadata[4] = crypto.createHash("sha256").update(oldBudgetEnvironment).digest("hex");
    write(snapshotFile, oldBudgetEnvironment); write(snapshotManifest, metadata.join("\t") + "\n");
    const originalMetadata = fs.readFileSync(snapshotManifest);
    const identity = JSON.parse(fs.readFileSync(path.join(fixture.current, "trees/old-app.json")));
    const contract = journal.contractFor({ kind: "runtime-only", oldIdentity: identity, topology, nativeAlreadyActive: true });
    journal.writeNativeSnapshot({ stagingDir: fixture.current, contract, environment: nativeBudgetEnvironment });
    assert.equal(fs.readFileSync(snapshotFile, "utf8"), oldBudgetEnvironment);
    assert.deepEqual(fs.readFileSync(snapshotManifest), originalMetadata);
    assert.equal(fs.readFileSync(path.join(fixture.current, "native-mode/runtime-env/env"), "utf8"), nativeBudgetEnvironment);
    write(path.join(fixture.current, "transaction-version"), "4\n");
    const mockFile = mapped(fixture.root, "/mock-systemd.json"), mockState = JSON.parse(fs.readFileSync(mockFile));
    mockState.nativeHealth = true; mockState.nativeDatabaseTopology = topology; write(mockFile, JSON.stringify(mockState));
    const recovered = runRecovery(fixture); assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(fs.readFileSync(mapped(fixture.root, "/etc/football-predict/env"), "utf8"), nativeBudgetEnvironment);
    assert.equal(fs.readFileSync(path.join(fixture.app, "tree-id"), "utf8").trim(), phase === "committed" ? "new" : "old");
    assert.equal(fs.existsSync(fixture.current), false);
    recoveryCases.push({ phase, actualRecoveryCli: true, oldSnapshotUnchangedBeforeRecovery: true, installedBudget: 45000, restoredTree: phase === "committed" ? "new" : "old" });
  } finally {
    const resolved = fs.realpathSync(fixture.root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("football-release-recovery-")); fs.rmSync(resolved, { recursive: true });
  }
}
const legacyFixture = createFixture("swap-complete", { acceptedUi: true });
try {
  const originalEnvironment = fs.readFileSync(path.join(legacyFixture.current, "runtime-env/env"));
  const recovered = runRecovery(legacyFixture); assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.deepEqual(fs.readFileSync(mapped(legacyFixture.root, "/etc/football-predict/env")), originalEnvironment);
} finally {
  const resolved = fs.realpathSync(legacyFixture.root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-release-recovery-")); fs.rmSync(resolved, { recursive: true });
}
console.log(JSON.stringify({ ok: true, checks: 8, budgetNormalization: { old80To45: true, duplicateKeysRemoved: true, semanticIdempotence: true, unrelatedValuesPreserved: true },
  workerPolicy: actualWorker, nativeBudgetRecoveryCases: recoveryCases, legacyRollbackOriginalEnvironmentPreserved: true,
  scope: "publisher snapshot writer to actual v4 recovery CLI; systemd/DB identity mocked", productionWrites: 0 }));
