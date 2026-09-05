"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readSqlitePublicationIdentity } = require("../server/sqliteStore.cjs");
const {
  createSqlitePublicationIdentityCache,
  sqlitePublicationFileToken,
} = require("../server/sqlitePublicationIdentityCache.cjs");

const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-sqlite-identity-cache-"));
const dbPath = path.join(tempDir, "football.db");
let db = null;
try {
  let nowMs = 10_000;
  let reads = 0;
  const read = createSqlitePublicationIdentityCache({
    dbPath,
    now: () => nowMs,
    readIdentity: (file) => { reads += 1; return readSqlitePublicationIdentity(file); },
  });
  check("missing database remains unavailable", () => {
    assert.equal(read().available, false);
    assert.equal(read().available, false);
    assert.equal(reads, 1);
  });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);");
  const setIdentity = (revision) => {
    const stmt = db.prepare("INSERT OR REPLACE INTO schema_meta (key,value,updated_at) VALUES (?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    for (const [key, value] of Object.entries({
      data_publication_mode: "active-generation",
      data_generation_id: `g-${revision}`,
      manifest_hash: `manifest-${revision}`,
      data_generation_source_cycle_id: `cycle-${revision}`,
      committed_at: `2026-09-05T07:00:0${revision}.000Z`,
    })) stmt.run(key, value, "2026-09-05T07:00:00.000Z");
    db.exec("COMMIT");
  };
  setIdentity(1);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  check("database creation invalidates a cached miss", () => {
    assert.equal(read().publication.generationId, "g-1");
    assert.equal(reads, 2);
  });
  check("unchanged identity is cached within one second", () => {
    assert.equal(read().publication.generationId, "g-1");
    assert.equal(reads, 2);
  });
  const mainBefore = fs.statSync(dbPath, { bigint: true });
  const tokenBefore = sqlitePublicationFileToken(dbPath);
  setIdentity(2);
  check("real WAL commit leaves main database metadata unchanged", () => {
    const mainAfter = fs.statSync(dbPath, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(mainAfter[key], mainBefore[key], key);
    }
    assert.notEqual(sqlitePublicationFileToken(dbPath), tokenBefore);
  });
  check("WAL commit refreshes every publication field without restart or checkpoint", () => {
    const state = read();
    assert.equal(state.available, true);
    assert.equal(state.publication.generationId, "g-2");
    assert.equal(state.publication.manifestHash, "manifest-2");
    assert.equal(state.publication.sourceCycleId, "cycle-2");
    assert.equal(state.publication.committedAt, "2026-09-05T07:00:02.000Z");
    assert.equal(reads, 3);
  });
  check("positive cache expires even when file metadata is identical", () => {
    nowMs += 1_000;
    assert.equal(read().publication.generationId, "g-2");
    assert.equal(reads, 4);
  });
  check("clock moving backwards cannot preserve a positive entry", () => {
    nowMs -= 2_000;
    read();
    assert.equal(reads, 5);
  });
  check("checkpoint keeps identity correct and invalidates old file token", () => {
    const before = sqlitePublicationFileToken(dbPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.notEqual(sqlitePublicationFileToken(dbPath), before);
    assert.equal(read().publication.generationId, "g-2");
    assert.equal(reads, 6);
  });
  check("a mutation during identity read is not retained in the cache", () => {
    let raceReads = 0;
    const racingRead = createSqlitePublicationIdentityCache({
      dbPath, now: () => nowMs,
      readIdentity: (file) => {
        raceReads += 1;
        const state = readSqlitePublicationIdentity(file);
        if (raceReads === 1) setIdentity(3);
        return state;
      },
    });
    assert.equal(racingRead().publication.generationId, "g-2");
    assert.equal(racingRead().publication.generationId, "g-3");
    assert.equal(raceReads, 2);
  });
  check("an unavailable result cannot reuse an earlier available identity", () => {
    nowMs += 1_000;
    db.exec("DROP TABLE schema_meta");
    assert.equal(read().available, false);
    nowMs += 1_000;
    assert.equal(read().available, false);
    assert.equal(reads, 8);
  });
  check("runtime uses the shared WAL-aware cache and keeps exact pairing checks", () => {
    const source = fs.readFileSync(path.join(__dirname, "../server/index.cjs"), "utf8");
    assert.match(source, /require\("\.\/sqlitePublicationIdentityCache\.cjs"\)/);
    assert.match(source, /return readCachedSqlitePublicationIdentity\(\);/);
    assert.match(source, /sqlitePublicationMatches\(sqlite\.publication, publication\?\.identity\)/);
    assert.match(source, /requireSqlitePairForResolvedPostgresPublication\(message\.publication\)/);
  });
  console.log(JSON.stringify({ ok: true, version: "sqlite-publication-identity-cache-v1", checks }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, checks, error: error.stack || error.message }, null, 2));
  process.exitCode = 1;
} finally {
  db?.close();
  // Only the exact directory created by this test is removed.
  fs.rmSync(tempDir, { recursive: true, force: true });
}
