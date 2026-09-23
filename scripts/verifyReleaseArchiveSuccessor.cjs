"use strict";

// Signed native release gate for all 601 baseline archive identities, including
// ten provider-id rekeys and one independently observed successor. This reads
// the isolated candidate and final live PostgreSQL publication plus their
// immutable generations; it never restores data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { digest, validateManifest } = require("./frozenArchiveRestoration.cjs");
const { validateSuccessorLineage, exactSuccessor, evaluateArchivePreflight } = require("./releaseArchivePreflight.cjs");

const SHA = /^[a-f0-9]{64}$/;
const SOURCE_ID = "2040739";
const STATE_ROOT = "/var/lib/football-release/native";
const LIVE_STORE = "/var/lib/football-predict";
const META_KEYS = ["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"];

function assertPublishedSuccessor(match, lineage) {
  assert.ok(match && typeof match === "object" && !Array.isArray(match), "successor row is missing");
  const archive = match.archivedPreMatchPrediction;
  assert.ok(archive && typeof archive === "object", "successor archive is missing");
  const observation = { match, archiveSha256: digest(archive), archiveMeta: {
    sourceMatchId: archive.sourceMatchId || null, matchId: archive.matchId || null,
    eventVersion: archive.eventVersion || null, kickoffTime: archive.kickoffTime || null,
    source: archive.source || null, capturedAt: archive.capturedAt || null,
    phase: archive.phase || null, cutoffTime: archive.cutoffTime || null,
    oddsPoolCode: archive.prediction?.oddsPoolCode || null,
    tipCode: archive.prediction?.tipCode || null, odds: archive.prediction?.odds ?? null,
  } };
  assert.ok(exactSuccessor(observation, lineage), "archive is not the exact signed 2040739 successor");
  return observation.archiveSha256;
}

function evaluateSuccessorRows({ lineage, generationRows, postgresRows, postgresIdentity, generationPointer }) {
  assert.equal(lineage.original.sourceMatchId, SOURCE_ID);
  assert.equal(lineage.successor.sourceMatchId, SOURCE_ID);
  assert.ok(Array.isArray(generationRows) && Array.isArray(postgresRows));
  for (const [name, rows] of [["generation", generationRows], ["PostgreSQL", postgresRows]]) {
    assert.equal(rows.length, 1, `${name} must have exactly one 2040739 row`);
    assert.equal(rows[0].dataset, "history", `${name} successor must be historical`);
    assert.equal(String(rows[0].match?.sourceMatchId), SOURCE_ID, `${name} source ID changed`);
  }
  assert.equal(postgresRows[0].rowId, `history:${lineage.successor.id}`, "PostgreSQL row identity changed");
  assert.equal(postgresRows[0].matchId, lineage.successor.id, "PostgreSQL match identity changed");
  const generationHash = assertPublishedSuccessor(generationRows[0].match, lineage);
  const postgresHash = assertPublishedSuccessor(postgresRows[0].match, lineage);
  assert.equal(postgresHash, generationHash, "PostgreSQL and generation archives differ");
  assert.equal(postgresIdentity?.mode, "active-generation", "PostgreSQL publication is not a generation");
  for (const [key, pgKey] of [["generationId", "generationId"], ["manifestHash", "manifestHash"],
    ["sourceCycleId", "sourceCycleId"]]) {
    assert.ok(generationPointer?.[key], `generation ${key} missing`);
    assert.equal(postgresIdentity[pgKey], generationPointer[key], `PostgreSQL/generation ${key} mismatch`);
  }
  assert.ok(Number.isFinite(Date.parse(generationPointer.committedAt)), "generation commit timestamp invalid");
  assert.equal(Date.parse(postgresIdentity.committedAt), Date.parse(generationPointer.committedAt),
    "PostgreSQL/generation commit timestamp mismatch");
  return { ok: true, sourceMatchId: SOURCE_ID, originalArchiveSha256: lineage.original.archiveSha256,
    successorArchiveSha256: generationHash, generationId: generationPointer.generationId, databaseWrites: 0 };
}

function fixedAuthority() {
  const manifest = fixedManifest();
  return validateSuccessorLineage(manifest).lineage;
}

function fixedManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "data/frozen-archive-restoration.json"), "utf8"));
  validateManifest(manifest);
  validateSuccessorLineage(manifest);
  return manifest;
}

function archiveObservation(row) {
  const archive = row.match?.archivedPreMatchPrediction;
  return { ...row, archiveSha256: archive ? digest(archive) : null,
    archiveMeta: archive ? { sourceMatchId: archive.sourceMatchId || null, matchId: archive.matchId || null,
      eventVersion: archive.eventVersion || null, kickoffTime: archive.kickoffTime || null,
      source: archive.source || null, capturedAt: archive.capturedAt || null,
      phase: archive.phase || null, cutoffTime: archive.cutoffTime || null,
      oddsPoolCode: archive.prediction?.oddsPoolCode || null,
      tipCode: archive.prediction?.tipCode || null, odds: archive.prediction?.odds ?? null } : null };
}

function evaluateFullBaselineObservations({ manifest, generationRows, postgresRows, generationPointer, releaseSha }) {
  assert.match(releaseSha || "", SHA);
  const expectedIds = new Set(manifest.baseline.records.map(row => String(row.sourceMatchId)));
  assert.equal(expectedIds.size, 601, "signed baseline source identities are ambiguous");
  for (const [name, rows] of [["generation", generationRows], ["PostgreSQL", postgresRows]]) {
    assert.equal(rows.length, expectedIds.size, `${name} must retain all 601 source rows`);
    assert.equal(new Set(rows.map(row => String(row.match?.sourceMatchId))).size, expectedIds.size,
      `${name} has duplicate source rows`);
    for (const row of rows) {
      assert.ok(expectedIds.has(String(row.match?.sourceMatchId)), `${name} contains an outside source`);
      assert.equal(row.dataset, "history", `${name} archive row is not historical`);
      assert.ok(row.match?.id, `${name} match identity is missing`);
      if (name === "PostgreSQL") {
        assert.equal(row.rowId, `history:${row.match.id}`, "PostgreSQL row identity differs from payload");
        assert.equal(row.matchId, row.match.id, "PostgreSQL match identity differs from payload");
        assert.equal(String(row.sourceMatchIdColumn), String(row.match.sourceMatchId),
          "PostgreSQL source column differs from payload");
      }
    }
  }
  const generationBySource = new Map(generationRows.map(row => [String(row.match.sourceMatchId), row]));
  for (const pg of postgresRows) {
    const source = String(pg.match.sourceMatchId), generation = generationBySource.get(source);
    assert.ok(generation, `generation source missing: ${source}`);
    for (const field of ["id", "sourceMatchId", "eventVersion", "kickoffTime", "homeTeamName", "awayTeamName"])
      assert.equal(pg.match[field], generation.match[field], `PostgreSQL/generation identity differs for ${source}: ${field}`);
    assert.equal(pg.archiveSha256, generation.archiveSha256, `PostgreSQL/generation archive differs for ${source}`);
  }
  const checkedAt = new Date().toISOString(), results = [];
  for (const [name, rows] of [["generation", generationRows], ["PostgreSQL", postgresRows]]) {
    const report = evaluateArchivePreflight({ version: "release-archive-observation-v1", checkedAt,
      releaseMarker: releaseSha, generation: generationPointer, rows, productionWrites: 0 }, manifest, checkedAt);
    assert.equal(report.ok, true, `${name} signed baseline drift: ${JSON.stringify(report.blockers.slice(0, 8))}`);
    assert.equal(report.restorableRows, 0, `${name} still has unmaterialized original archives`);
    assert.equal(report.preservedRows, 600, `${name} signed baseline is incomplete`);
    assert.equal(report.rekeyedIdentityRows, 10, `${name} signed original rekey count changed`);
    assert.equal(report.supersededRows, 1, `${name} must retain one exact successor`);
    assert.equal(report.superseded[0].sourceMatchId, SOURCE_ID, `${name} successor identity changed`);
    results.push({ name, preservedRows: report.preservedRows, rekeyedIdentityRows: report.rekeyedIdentityRows,
      supersededRows: report.supersededRows });
  }
  return { baselineRows: expectedIds.size, preservedRows: results[0].preservedRows,
    rekeyedIdentityRows: results[0].rekeyedIdentityRows, supersededRows: results[0].supersededRows };
}

function evaluateSignedBaselineRows({ manifest, lineage, generationRows, postgresRows, postgresIdentity, generationPointer, releaseSha }) {
  const baseline = evaluateFullBaselineObservations({ manifest, generationRows, postgresRows, generationPointer, releaseSha });
  return { ...evaluateSuccessorRows({ lineage,
    generationRows: generationRows.filter(row => String(row.match.sourceMatchId) === SOURCE_ID),
    postgresRows: postgresRows.filter(row => String(row.match.sourceMatchId) === SOURCE_ID),
    postgresIdentity, generationPointer }), ...baseline };
}

function secureStateFile(file) {
  for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022), "unsafe native state directory");
    if (dir === path.dirname(dir)) break;
  }
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1
    && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= 1024 * 1024, "unsafe native state file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { assert.equal(fs.fstatSync(fd).ino, stat.ino); return JSON.parse(fs.readFileSync(fd, "utf8")); }
  finally { fs.closeSync(fd); }
}

function generationRows(storeDir, sourceIds) {
  const store = require("../server/dataGenerationStore.cjs");
  const context = store.resolveCurrentGeneration({ storeDir });
  const rows = [];
  for (const [name, dataset] of [["matches-current.json", "current"], ["matches-history.json", "history"]]) {
    const document = store.readGenerationFile(context, name, { parseJson: true });
    const matches = Array.isArray(document) ? document : document?.matches;
    assert.ok(Array.isArray(matches), `generation ${name} is not a match array`);
    for (const match of matches) if (sourceIds.has(String(match?.sourceMatchId))) rows.push(archiveObservation({ dataset, match }));
  }
  const after = store.resolveCurrentGeneration({ storeDir });
  assert.deepEqual(after.pointer, context.pointer, "generation pointer changed during successor verification");
  return { rows, pointer: context.pointer };
}

async function verifyNativeSuccessor({ mode, sha, storeDir }) {
  assert.ok(["candidate", "live"].includes(mode), "invalid successor verification mode");
  assert.match(sha || "", SHA, "invalid signed bundle SHA");
  assert.equal(process.platform, "linux", "native successor verification requires Linux");
  assert.equal(process.getuid(), 0, "native successor verification requires root");
  if (mode === "candidate") {
    assert.match(storeDir || "", /^\/opt\/football-predict\.build-[a-f0-9]{12}-[0-9]+\/server-data$/);
    assert.ok(storeDir.startsWith(`/opt/football-predict.build-${sha.slice(0, 12)}-`), "candidate store is not from this bundle");
  } else assert.equal(storeDir, LIVE_STORE, "live store path changed");
  const manifest = fixedManifest(), lineage = validateSuccessorLineage(manifest).lineage;
  const sourceIds = new Set(manifest.baseline.records.map(row => String(row.sourceMatchId)));
  const state = secureStateFile(path.join(STATE_ROOT, sha, "state.json"));
  assert.equal(state.sha, sha);
  assert.equal(state.kind, "runtime-only", "successor verification requires PostgreSQL-only release");
  const database = mode === "candidate" ? state.candidateDatabase : "football";
  const databaseOid = mode === "candidate" ? state.candidateOid : state.oldDatabaseOid;
  const { NativeReleasePostgresPool } = require("./nativeReleasePostgresTransport.cjs");
  const pool = new NativeReleasePostgresPool({ database, databaseOid, clusterId: state.clusterId });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const meta = await client.query("SELECT key,value FROM football.projection_meta WHERE key = ANY($1::text[])", [META_KEYS]);
    assert.equal(meta.rows.length, META_KEYS.length, "incomplete PostgreSQL publication identity");
    const values = Object.fromEntries(meta.rows.map(row => [row.key, row.value]));
    const identity = { mode: values.data_publication_mode, generationId: values.data_generation_id,
      manifestHash: values.manifest_hash, sourceCycleId: values.data_generation_source_cycle_id,
      committedAt: values.committed_at };
    const pg = await client.query("SELECT id,dataset,match_id,source_match_id,payload::text AS payload FROM football.match_snapshots WHERE source_match_id=ANY($1::text[])", [[...sourceIds]]);
    const postgresRows = pg.rows.map(row => {
      assert.ok(sourceIds.has(String(row.source_match_id)));
      return archiveObservation({ rowId: row.id, dataset: row.dataset, matchId: row.match_id,
        sourceMatchIdColumn: row.source_match_id, match: JSON.parse(row.payload) });
    });
    const { rows: generationMatches, pointer } = generationRows(storeDir, sourceIds);
    const result = evaluateSignedBaselineRows({ manifest, lineage, generationRows: generationMatches, postgresRows,
      postgresIdentity: identity, generationPointer: pointer, releaseSha: sha });
    await client.query("ROLLBACK"); client.release(); client = null;
    return { ...result, mode, databaseOid, bundleSha256: sha };
  } finally {
    if (client) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    await pool.end();
  }
}

module.exports = { assertPublishedSuccessor, evaluateSuccessorRows, evaluateFullBaselineObservations, evaluateSignedBaselineRows,
  archiveObservation, fixedAuthority, fixedManifest, verifyNativeSuccessor };
if (require.main === module) {
  const [mode, sha, candidateStore, ...extra] = process.argv.slice(2);
  verifyNativeSuccessor({ mode, sha, storeDir: mode === "live" && candidateStore === undefined ? LIVE_STORE : candidateStore })
    .then(result => { assert.equal(extra.length, 0); console.log(JSON.stringify(result)); })
    .catch(error => { console.error(JSON.stringify({ ok: false, mode, error: String(error.message).slice(0, 500), databaseWrites: 0 })); process.exitCode = 1; });
}
