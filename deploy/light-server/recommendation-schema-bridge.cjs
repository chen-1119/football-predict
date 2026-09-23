"use strict";

// One signed, additive migration for the native PostgreSQL release lane.
// Candidate and live databases are selected from the bound native release
// state, never from a caller-supplied URL. The old live processes remain on
// schema 012 until the stopped swap window.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "013_dual_choice_research";
const FILE = `${VERSION}.sql`;
const SHA_RE = /^[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const canonicalSql = value => String(value).replace(/\r\n/g, "\n");
const migrationFile = path.join(ROOT, "server/postgres/migrations", FILE);

function readSignedMigration() {
  const stat = fs.lstatSync(migrationFile);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "signed migration source is unsafe");
  const sql = canonicalSql(fs.readFileSync(migrationFile, "utf8"));
  assert.match(sql, /CREATE TABLE football\.recommendation_dual_research_records\s*\(/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
  return { sql, hash: sha256(sql) };
}

function expectedBaseline() {
  const dir = path.join(ROOT, "server/postgres/migrations");
  const files = fs.readdirSync(dir).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  assert.equal(files.length, 13, "signed release must contain exactly migrations 001 through 013");
  assert.equal(files.at(-1), FILE);
  return files.slice(0, -1).map(file => ({
    version: file.slice(0, -4),
    sha256: sha256(canonicalSql(fs.readFileSync(path.join(dir, file), "utf8"))),
  }));
}

async function applyToPool(pool, signed, baseline) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-schema-migrations-v1"]);
    const applied = (await client.query("SELECT version,sha256 FROM football.schema_migrations ORDER BY version COLLATE \"C\"")).rows;
    assert.deepEqual(applied.slice(0, baseline.length), baseline, "signed base migrations differ from installed schema");
    assert(applied.length === baseline.length || applied.length === baseline.length + 1, "unexpected installed migration count");
    const existing = applied[baseline.length];
    const table = (await client.query("SELECT to_regclass('football.recommendation_dual_research_records')::text AS name")).rows[0]?.name;
    if (existing) {
      assert.deepEqual(existing, { version: VERSION, sha256: signed.hash }, "013 migration digest mismatch");
      assert.equal(table, "football.recommendation_dual_research_records", "recorded 013 table is absent");
      await client.query("COMMIT");
      began = false;
      return { ok: true, applied: false, version: VERSION, sha256: signed.hash };
    }
    assert.equal(table, null, "unrecorded 013 table already exists");
    await client.query(signed.sql);
    await client.query("ALTER TABLE football.recommendation_dual_research_records OWNER TO football");
    await client.query("GRANT SELECT, INSERT ON football.recommendation_dual_research_records TO football");
    await client.query("INSERT INTO football.schema_migrations(version,sha256) VALUES ($1,$2)", [VERSION, signed.hash]);
    await client.query("COMMIT");
    began = false;
    return { ok: true, applied: true, version: VERSION, sha256: signed.hash };
  } catch (error) {
    if (began) try { await client.query("ROLLBACK"); } catch { /* original failure is authoritative */ }
    throw error;
  } finally {
    client.release();
  }
}

function readState(sha) {
  assert.match(sha, SHA_RE);
  const { read } = require("../../scripts/nativeReleaseDataPlane.cjs");
  const directory = path.join("/var/lib/football-release/native", sha);
  const state = read(path.join(directory, "state.json"));
  assert.equal(state.sha, sha);
  const transaction = require("./football-release-recovery.cjs").loadTransaction();
  assert.equal(transaction.bundleSha, sha);
  assert.deepEqual(transaction.native.contract, state.contract);
  return { directory, state };
}

function writeLiveIntent(directory, state, hash) {
  const name = path.join(directory, "recommendation-schema-intent.json");
  const intent = { version: "recommendation-schema-bridge-v1", bundleSha256: state.sha,
    migrationVersion: VERSION, migrationSha256: hash, databaseOid: state.oldDatabaseOid,
    clusterId: state.clusterId };
  if (fs.existsSync(name)) {
    const { read } = require("../../scripts/nativeReleaseDataPlane.cjs");
    assert.deepEqual(read(name), intent, "existing schema intent does not match this signed release");
    return name;
  }
  const fd = fs.openSync(name, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(intent) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(directory, "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  return name;
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  const [target, sha] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert(["candidate", "live"].includes(target));
  const { directory, state } = readState(sha);
  assert.equal(state.kind, "runtime-only", "013 migration is for an existing PostgreSQL-only runtime");
  const signed = readSignedMigration(), baseline = expectedBaseline();
  if (target === "live") writeLiveIntent(directory, state, signed.hash);
  const database = target === "live" ? "football" : state.candidateDatabase;
  const databaseOid = target === "live" ? state.oldDatabaseOid : state.candidateOid;
  const { NativeReleasePostgresPool } = require("../../scripts/nativeReleasePostgresTransport.cjs");
  const pool = new NativeReleasePostgresPool({ database, databaseOid, clusterId: state.clusterId });
  try {
    return { ...await applyToPool(pool, signed, baseline), databaseKind: target, databaseOid };
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });

module.exports = { VERSION, applyToPool, expectedBaseline, readSignedMigration, writeLiveIntent };
