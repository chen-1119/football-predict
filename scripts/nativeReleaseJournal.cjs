"use strict";
// Root-owned bridge between the signed publisher and the standalone v4
// recovery reader. This creates a journal, never activates or renames a DB.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
// Exact accepted r730 runtime; original 198 decisions/evidence and frozen
// archive continuity were independently verified after its official cycle.
const BOOTSTRAP_SHA = "a69f15cc7deeb44343cede093f2b6b0e8ea02b01587121b856c2f4d10f6e194b";
const NATIVE_SELECTORS = Object.freeze({ FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary",
  DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0",
  PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres", POSTGRES_PROJECTION_SOURCE: "native-generation" });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function nativeEnvironment(text) {
  assert.ok(Buffer.byteLength(text) <= 262144 && !text.includes("\0"));
  const remove = new Set([...Object.keys(NATIVE_SELECTORS), "FOOTBALL_POSTGRES_URL", "FOOTBALL_POSTGRES_SSL_MODE"]);
  const lines = text.split(/\r?\n/).filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return !match || !remove.has(match[1]);
  });
  // Fixed peer-authenticated local DB. No password or connection option is
  // copied from a temporary build/candidate database into the runtime.
  lines.push(...Object.entries(NATIVE_SELECTORS).map(([key, value]) => key + "=" + value),
    "FOOTBALL_POSTGRES_URL=postgresql://football@localhost/football?host=%2Fvar%2Frun%2Fpostgresql",
    "FOOTBALL_POSTGRES_SSL_MODE=disable");
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}
function contractFor({ kind, oldIdentity, topology, candidateDatabase = null, archiveDatabase = null, nativeAlreadyActive = false }) {
  assert.ok(["initial-cutover", "runtime-only"].includes(kind));
  assert.match(topology.clusterId, /^[0-9]{10,20}$/);
  assert.match(oldIdentity.bundleMarker || "", /^[a-f0-9]{64}$/);
  assert.equal(oldIdentity.bundleMarker, oldIdentity.liveMarker, "old runtime is not accepted");
  if (kind === "initial-cutover") {
    assert.match(BOOTSTRAP_SHA || "", /^[a-f0-9]{64}$/, "initial cutover disabled: no accepted native-capable bootstrap");
    assert.equal(oldIdentity.bundleMarker, BOOTSTRAP_SHA, "initial cutover requires the exact accepted native-capable bootstrap");
    assert.match(candidateDatabase || "", /^football_release_[a-f0-9]{12}_[0-9]{1,10}$/);
    assert.match(archiveDatabase || "", /^football_legacy_[a-f0-9]{12}_[0-9]{1,10}$/);
    assert.equal(topology.databases[archiveDatabase], undefined, "archive database already exists");
  } else {
    assert.equal(nativeAlreadyActive, true, "runtime-only journal cannot switch hybrid production to native implicitly");
    assert.equal(candidateDatabase, null); assert.equal(archiveDatabase, null);
  }
  const oldDatabaseOid = topology.databases.football, newDatabaseOid = kind === "runtime-only" ? oldDatabaseOid : topology.databases[candidateDatabase];
  for (const value of [oldDatabaseOid, newDatabaseOid]) assert.ok(typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 4294967295n);
  if (kind === "initial-cutover") assert.notEqual(oldDatabaseOid, newDatabaseOid);
  return { version: "native-app-data-forward-v1", kind, clusterId: topology.clusterId, oldDatabaseOid, newDatabaseOid,
    candidateDatabase, archiveDatabase, compatibleRuntimeSha256: oldIdentity.bundleMarker };
}
function writeNativeSnapshot({ stagingDir, contract, environment }) {
  const dir = path.join(stagingDir, "native-mode");
  fs.mkdirSync(dir, { mode: 0o700 }); // No recursive overwrite or reuse.
  fs.cpSync(path.join(stagingDir, "runtime-env"), path.join(dir, "runtime-env"), { recursive: true, errorOnExist: true, force: false });
  const file = path.join(dir, "runtime-env/env"), manifest = path.join(dir, "runtime-env/manifest.tsv");
  const parts = fs.readFileSync(manifest, "utf8").trim().split("\t");
  assert.equal(parts.length, 8); assert.equal(parts[0], "env"); assert.equal(parts[1], "/etc/football-predict/env"); assert.equal(parts[2], "1");
  parts[3] = String(Buffer.byteLength(environment)); parts[4] = digest(environment);
  for (const [target, bytes] of [[file, environment], [manifest, parts.join("\t") + "\n"], [path.join(dir, "state.json"), JSON.stringify(contract) + "\n"]]) {
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const fd = fs.openSync(target, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (process.platform === "linux") for (const directory of [path.join(dir, "runtime-env"), dir]) {
    const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { ok: true, kind: contract.kind, databaseWrites: 0, environmentSha256: digest(environment) };
}
module.exports = { BOOTSTRAP_SHA, NATIVE_SELECTORS, nativeEnvironment, contractFor, writeNativeSnapshot };
if (require.main === module) {
  try {
    assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
    const [stagingDir, kind, candidate = "-", archive = "-"] = process.argv.slice(2);
    assert.equal(process.argv.length, 6);
    assert.match(stagingDir || "", /^\/var\/lib\/football-release\/recovery\/\.current\.[a-f0-9]{12}\.[A-Za-z0-9]{6}$/);
    for (let dir = stagingDir;; dir = path.dirname(dir)) {
      const st = fs.lstatSync(dir); assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022));
      if (dir === path.dirname(dir)) break;
    }
    const plain = file => { const st = fs.lstatSync(file); assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === 0 && !(st.mode & 0o077)); return fs.readFileSync(file, "utf8"); };
    const oldIdentity = JSON.parse(plain(path.join(stagingDir, "trees/old-app.json")));
    const original = plain(path.join(stagingDir, "runtime-env/env"));
    const names = ["football", candidate, archive].filter(name => name !== "-");
    for (const name of names) assert.match(name, /^(football|football_(release|legacy)_[a-f0-9]{12}_[0-9]{1,10})$/);
    const query = "BEGIN READ ONLY; SELECT json_build_object('clusterId',(SELECT system_identifier::text FROM pg_control_system()),'databases',(SELECT json_object_agg(datname,oid::text) FROM pg_database WHERE datname IN (" + names.map(name => "'" + name + "'").join(",") + "))); ROLLBACK;";
    const result = spawnSync("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-X", "-q", "-t", "-A", "--set=ON_ERROR_STOP=1", "--dbname=postgres"], {
      input: query, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", PGHOST: "/var/run/postgresql", PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=5000" } });
    assert.equal(result.status, 0, "native journal database identity query failed");
    const nativeAlreadyActive = /^FOOTBALL_STORAGE_MODE=postgres-only\s*$/m.test(original);
    const contract = contractFor({ kind, oldIdentity, topology: JSON.parse(result.stdout), candidateDatabase: candidate === "-" ? null : candidate,
      archiveDatabase: archive === "-" ? null : archive, nativeAlreadyActive });
    console.log(JSON.stringify(writeNativeSnapshot({ stagingDir, contract, environment: nativeEnvironment(original) })));
  } catch (error) { console.error(JSON.stringify({ ok: false, phase: "native-recovery-journal", error: error.message })); process.exitCode = 1; }
}
