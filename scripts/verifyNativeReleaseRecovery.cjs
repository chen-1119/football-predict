"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { createFixture, runRecovery, mapped, write, sha256, readTreeId } = require("./verifyReleaseRecovery.cjs");
const nativeEnv = ["FOOTBALL_STORAGE_MODE=postgres-only", "FOOTBALL_POSTGRES_MODE=primary", "DATASTORE_READ_SOURCE=postgres",
  "CURRENT_MATCH_SOURCE=postgres", "ENABLE_SQLITE_EXPORT=0", "PRIVATE_MODEL_ARTIFACT_STORAGE=postgres",
  "POSTGRES_PROJECTION_SOURCE=native-generation", "FOOTBALL_POSTGRES_URL=postgresql://football@127.0.0.1/football", "RELEASE_STATE=native"].join("\n") + "\n";
function fixture(phase, active, kind = "initial-cutover") {
  const f = createFixture(phase, { acceptedUi: true, modelArtifactCount: 9 });
  // Remove only the snapshots owned by this brand-new synthetic fixture.
  for (const name of ["sqlite", "external-model-artifacts"]) {
    const target = path.resolve(f.current, name); assert.equal(path.dirname(target), path.resolve(f.current));
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  }
  write(path.join(f.current, "transaction-version"), "4\n");
  const contract = { version: "native-app-data-forward-v1", kind, clusterId: "7645341234567890123", oldDatabaseOid: "12345", newDatabaseOid: kind === "runtime-only" ? "12345" : "12346",
    candidateDatabase: kind === "runtime-only" ? null : "football_release_aaaaaaaaaaaa_1789010100",
    archiveDatabase: kind === "runtime-only" ? null : "football_legacy_bbbbbbbbbbbb_1789010100", compatibleRuntimeSha256: f.frontend.runtimeSha256 };
  const nativeDir = path.join(f.current, "native-mode");
  write(path.join(nativeDir, "state.json"), JSON.stringify(contract) + "\n");
  fs.cpSync(path.join(f.current, "runtime-env"), path.join(nativeDir, "runtime-env"), { recursive: true });
  write(path.join(nativeDir, "runtime-env/env"), nativeEnv);
  const manifestPath = path.join(nativeDir, "runtime-env/manifest.tsv"), parts = fs.readFileSync(manifestPath, "utf8").trim().split("\t");
  parts[3] = String(Buffer.byteLength(nativeEnv)); parts[4] = sha256(nativeEnv); write(manifestPath, parts.join("\t") + "\n");
  const mockPath = mapped(f.root, "/mock-systemd.json"), state = JSON.parse(fs.readFileSync(mockPath));
  state.nativeHealth = true;
  state.nativeDatabaseTopology = { clusterId: contract.clusterId, databases: kind === "runtime-only" ? { football: contract.newDatabaseOid }
    : active ? { football: contract.newDatabaseOid, [contract.archiveDatabase]: contract.oldDatabaseOid }
      : { football: contract.oldDatabaseOid, [contract.candidateDatabase]: contract.newDatabaseOid } };
  write(mockPath, JSON.stringify(state));
  return { ...f, mockPath, contract, nativeDir };
}
function cleanup(f) {
  const resolved = fs.realpathSync(f.root);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-release-recovery-")); fs.rmSync(resolved, { recursive: true, force: true });
}
function rewriteNativeEnv(f, content) {
  write(path.join(f.nativeDir, "runtime-env/env"), content);
  const file = path.join(f.nativeDir, "runtime-env/manifest.tsv"), parts = fs.readFileSync(file, "utf8").trim().split("\t");
  parts[3] = String(Buffer.byteLength(content)); parts[4] = sha256(content); write(file, parts.join("\t") + "\n");
}
const checks = [];
for (const [phase, active, kind] of [["prepared", false, "initial-cutover"], ["prepared", true, "initial-cutover"],
  ["swap-complete", false, "initial-cutover"], ["swap-complete", true, "initial-cutover"], ["recovering-rollback", true, "initial-cutover"],
  ["swap-complete", true, "runtime-only"], ["committed", true, "initial-cutover"], ["committed", true, "runtime-only"]]) {
  const f = fixture(phase, active, kind);
  try {
    const files = [f.sqliteTarget, f.strategyTarget, f.evaluationTarget, f.registryTarget, f.benchmarkProspectiveTarget];
    const before = files.map(file => fs.readFileSync(file));
    const dbBefore = JSON.parse(fs.readFileSync(f.mockPath)).nativeDatabaseTopology;
    const result = runRecovery(f); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readTreeId(f.app), phase === "committed" ? "new" : "old");
    assert.deepEqual(files.map(file => fs.readFileSync(file)), before, "rollback must retain newer model, frozen registry and all database bytes");
    const state = JSON.parse(fs.readFileSync(f.mockPath));
    assert.deepEqual(state.nativeDatabaseTopology, dbBefore); assert.equal(state.publicationAffinityRebuilds || 0, active ? 0 : 1);
    assert.equal(fs.readFileSync(mapped(f.root, "/etc/football-predict/env"), "utf8"), active ? nativeEnv : "RELEASE_STATE=old\n");
    assert.equal(fs.existsSync(f.current), false);
    checks.push({ phase, active, kind, ok: true });
  } finally { cleanup(f); }
}
for (const [name, mutate] of [
  ["cluster change", f => { const s = JSON.parse(fs.readFileSync(f.mockPath)); s.nativeDatabaseTopology.clusterId = "9999999999999999999"; write(f.mockPath, JSON.stringify(s)); }],
  ["unknown database", f => { const s = JSON.parse(fs.readFileSync(f.mockPath)); s.nativeDatabaseTopology.databases.football = "33333"; write(f.mockPath, JSON.stringify(s)); }],
  ["mixed rename", f => { const s = JSON.parse(fs.readFileSync(f.mockPath)); s.nativeDatabaseTopology.databases[f.contract.candidateDatabase] = f.contract.newDatabaseOid; write(f.mockPath, JSON.stringify(s)); }],
  ["unbound compatible application", f => { const c = { ...f.contract, compatibleRuntimeSha256: "0".repeat(64) }; write(path.join(f.nativeDir, "state.json"), JSON.stringify(c)); }],
  ["database rewind snapshot", f => write(path.join(f.current, "sqlite/canary"), "do not read")],
  ["tampered native environment", f => write(path.join(f.nativeDir, "runtime-env/env"), nativeEnv.replace("ENABLE_SQLITE_EXPORT=0", "ENABLE_SQLITE_EXPORT=1"))],
  ["valid digest but re-enabled SQLite", f => rewriteNativeEnv(f, nativeEnv.replace("ENABLE_SQLITE_EXPORT=0", "ENABLE_SQLITE_EXPORT=1"))],
  ["indented duplicate selector", f => rewriteNativeEnv(f, nativeEnv + " ENABLE_SQLITE_EXPORT=1\n")],
  ["different database URL", f => rewriteNativeEnv(f, nativeEnv.replace("127.0.0.1/football", "127.0.0.1/other"))],
  ["remote database URL", f => rewriteNativeEnv(f, nativeEnv.replace("127.0.0.1/football", "example.invalid/football"))],
  ["ambiguous connection options", f => rewriteNativeEnv(f, nativeEnv.replace("127.0.0.1/football", "127.0.0.1/football?host=/var/run/postgresql&host=remote"))],
]) {
  const f = fixture("swap-complete", true);
  try {
    mutate(f); const before = fs.readFileSync(f.mockPath, "utf8"), envBefore = fs.readFileSync(mapped(f.root, "/etc/football-predict/env"));
    const result = runRecovery(f); assert.notEqual(result.status, 0, name);
    assert.equal(readTreeId(f.app), "new"); assert.equal(fs.readFileSync(f.mockPath, "utf8"), before);
    assert.deepEqual(fs.readFileSync(mapped(f.root, "/etc/football-predict/env")), envBefore); assert.equal(fs.existsSync(f.current), true);
    checks.push({ name, ok: true });
  } finally { cleanup(f); }
}
{
  const f = fixture("swap-complete", true);
  try {
    const state = JSON.parse(fs.readFileSync(f.mockPath)); state.nativeHealth = false; write(f.mockPath, JSON.stringify(state));
    assert.notEqual(runRecovery(f).status, 0); assert.equal(fs.existsSync(f.current), true);
    assert.equal(readTreeId(f.app), "old"); assert.equal(fs.readFileSync(mapped(f.root, "/etc/football-predict/env"), "utf8"), nativeEnv);
    const repaired = JSON.parse(fs.readFileSync(f.mockPath)); repaired.nativeHealth = true; write(f.mockPath, JSON.stringify(repaired));
    assert.equal(runRecovery(f).status, 0); assert.equal(fs.existsSync(f.current), false);
    checks.push({ name: "HTTP health alone cannot finalize native recovery; retry keeps advanced data and native mode", ok: true });
  } finally { cleanup(f); }
}
console.log(JSON.stringify({ ok: true, checks, scope: "actual recovery CLI and filesystem with mocked systemd/database identity; not a real database rename rehearsal", productionWrites: 0 }));
