"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createPostgresPool } = require("../server/postgresStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const dbPath = path.resolve(
  process.env.DATASTORE_SQLITE_PATH || path.join(rootDir, "server-data", "football.db"),
);
const aiArenaPath = path.resolve(
  process.env.AI_ARENA_PATH || path.join(rootDir, "public", "data", "ai-arena.json"),
);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const stableStringify = (value) => JSON.stringify(stableValue(value));
const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;

const sourceTable = (db, table, options = {}) => {
  const where = options.where ? `WHERE ${options.where}` : "";
  const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get()?.count || 0);
  const hash = crypto.createHash("sha256");
  const sampleIds = [];
  const sampleStride = Math.max(1, Math.floor(count / 48));
  let index = 0;
  for (const row of db.prepare(`SELECT ${options.key || "id"} AS id, ${options.payload || "payload"} AS payload FROM ${table} ${where} ORDER BY ${options.key || "id"}`).iterate()) {
    hash.update(String(row.id || ""));
    hash.update("\0");
    hash.update(String(row.payload || ""));
    hash.update("\n");
    if (index < 8 || index >= count - 8 || index % sampleStride === 0) sampleIds.push(String(row.id));
    index += 1;
  }
  return { count, hash: hash.digest("hex"), sampleIds: [...new Set(sampleIds)].slice(0, 72) };
};

const comparePayloadSamples = async (pool, db, table, source, options = {}) => {
  if (source.sampleIds.length === 0) return { samples: 0, mismatches: [] };
  const key = options.key || "id";
  const sourcePayload = options.sourcePayload || "payload";
  const postgresPayload = options.postgresPayload || "payload";
  const pg = await pool.query(`
    SELECT ${key} AS id, ${postgresPayload} AS payload
    FROM football.${table}
    WHERE ${key} = ANY($1::text[])
  `, [source.sampleIds]);
  const pgRows = new Map(pg.rows.map((row) => [String(row.id), row.payload]));
  const select = db.prepare(`SELECT ${sourcePayload} AS payload FROM ${table} WHERE ${key} = ?`);
  const mismatches = [];
  for (const id of source.sampleIds) {
    const sqlitePayload = select.get(id)?.payload;
    const postgresPayload = pgRows.get(id);
    if (sqlitePayload === undefined || postgresPayload === undefined) {
      mismatches.push({ id, reason: "row-missing" });
      continue;
    }
    if (stableStringify(parse(sqlitePayload)) !== stableStringify(parse(postgresPayload))) {
      mismatches.push({ id, reason: "payload-mismatch" });
    }
  }
  return { samples: source.sampleIds.length, mismatches };
};

const main = async () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const pool = createPostgresPool({ applicationName: "football-postgres-parity" });
  try {
    db.exec("BEGIN");
    const sources = {
      match_snapshots: sourceTable(db, "match_snapshots", { where: "dataset IN ('current','history')" }),
      source_snapshots: sourceTable(db, "source_snapshots"),
      odds_snapshots: sourceTable(db, "odds_snapshots"),
      prediction_snapshots: sourceTable(db, "prediction_snapshots"),
      private_model_artifacts: sourceTable(db, "private_model_artifacts", {
        key: "artifact_key",
        payload: "payload_json",
      }),
    };
    const expectedCounts = {
      currentMatches: Number(db.prepare("SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset='current'").get().count),
      historyMatches: Number(db.prepare("SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset='history'").get().count),
      sourceSnapshots: sources.source_snapshots.count,
      oddsSnapshots: sources.odds_snapshots.count,
      predictionSnapshots: sources.prediction_snapshots.count,
      privateModelArtifacts: sources.private_model_artifacts.count,
    };
    const metaKeys = [
      "data_publication_mode", "data_generation_id", "manifest_hash",
      "data_generation_source_cycle_id", "committed_at", "exported_at",
    ];
    const sqliteMeta = Object.fromEntries(db.prepare(`
      SELECT key, value FROM schema_meta
      WHERE key IN (${metaKeys.map(() => "?").join(",")})
    `).all(...metaKeys).map((row) => [row.key, row.value]));

    const [counts, pgMetaRows, backfillRun, semantic, ai] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE dataset='current')::bigint AS current_matches,
          COUNT(*) FILTER (WHERE dataset='history')::bigint AS history_matches,
          (SELECT COUNT(*)::bigint FROM football.source_snapshots) AS source_snapshots,
          (SELECT COUNT(*)::bigint FROM football.odds_snapshots) AS odds_snapshots,
          (SELECT COUNT(*)::bigint FROM football.prediction_snapshots) AS prediction_snapshots,
          (SELECT COUNT(*)::bigint FROM football.private_model_artifacts) AS private_model_artifacts
        FROM football.match_snapshots
      `),
      pool.query("SELECT key,value FROM football.projection_meta WHERE key = ANY($1::text[])", [metaKeys]),
      pool.query(`
        SELECT run_id, source_fingerprint, row_counts, table_hashes, committed_at
        FROM football.projection_runs WHERE mode='backfill'
        ORDER BY committed_at DESC LIMIT 1
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM football.frozen_recommendations)::bigint AS frozen_recommendations,
          (SELECT COUNT(*) FROM football.result_observations)::bigint AS result_observations,
          (SELECT COUNT(*) FROM football.post_match_reviews)::bigint AS post_match_reviews,
          (SELECT COUNT(*) FROM football.formal_review_daily)::bigint AS formal_review_daily
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM football.ai_competitors)::bigint AS competitors,
          (SELECT COUNT(*) FROM football.ai_decisions)::bigint AS decisions,
          (SELECT COUNT(*) FROM football.ai_score_ledger)::bigint AS ledger_entries
      `),
    ]);
    const pgCountsRaw = counts.rows[0] || {};
    const actualCounts = {
      currentMatches: Number(pgCountsRaw.current_matches || 0),
      historyMatches: Number(pgCountsRaw.history_matches || 0),
      sourceSnapshots: Number(pgCountsRaw.source_snapshots || 0),
      oddsSnapshots: Number(pgCountsRaw.odds_snapshots || 0),
      predictionSnapshots: Number(pgCountsRaw.prediction_snapshots || 0),
      privateModelArtifacts: Number(pgCountsRaw.private_model_artifacts || 0),
    };
    assert.deepEqual(actualCounts, expectedCounts, "PostgreSQL projection counts differ from SQLite");
    const pgMeta = Object.fromEntries(pgMetaRows.rows.map((row) => [row.key, row.value]));
    assert.deepEqual(pgMeta, sqliteMeta, "PostgreSQL publication metadata differs from SQLite");
    assert.ok(backfillRun.rows[0], "a committed PostgreSQL backfill run is required");
    const backfillHashes = backfillRun.rows[0].table_hashes || {};
    for (const table of Object.keys(sources)) {
      assert.match(String(backfillHashes[table] || ""), /^[0-9a-f]{64}$/, `${table} backfill hash is missing`);
    }

    const samples = {};
    for (const [table, source] of Object.entries(sources)) {
      samples[table] = await comparePayloadSamples(pool, db, table, source, table === "private_model_artifacts"
        ? { key: "artifact_key", sourcePayload: "payload_json", postgresPayload: "payload" }
        : {});
      assert.deepEqual(samples[table].mismatches, [], `${table} sampled payload parity failed`);
    }

    const arena = (() => {
      try { return JSON.parse(fs.readFileSync(aiArenaPath, "utf8")); } catch { return null; }
    })();
    const expectedCompetitors = Array.isArray(arena?.agents) ? arena.agents.length : 0;
    assert.equal(Number(ai.rows[0]?.competitors || 0), expectedCompetitors, "AI competitor projection is incomplete");
    assert.ok(
      Number(semantic.rows[0]?.result_observations || 0) >= expectedCounts.historyMatches,
      "every published history match must have a PostgreSQL result observation",
    );
    assert.ok(
      Number(semantic.rows[0]?.post_match_reviews || 0) >= expectedCounts.historyMatches,
      "every published history match must have a PostgreSQL review row",
    );
    db.exec("COMMIT");
    console.log(JSON.stringify({
      ok: true,
      verifier: "postgres-parity",
      checkedAt: new Date().toISOString(),
      publication: sqliteMeta,
      counts: actualCounts,
      backfill: {
        runId: backfillRun.rows[0].run_id,
        committedAt: backfillRun.rows[0].committed_at,
        sourceFingerprint: backfillRun.rows[0].source_fingerprint,
        hashes: backfillHashes,
      },
      currentSourceHashes: Object.fromEntries(Object.entries(sources).map(([table, source]) => [table, source.hash])),
      samples,
      semantic: semantic.rows[0],
      ai: ai.rows[0],
    }, null, 2));
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve parity failure */ }
    throw error;
  } finally {
    db.close();
    await pool.end();
  }
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || null,
    error: error.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});
