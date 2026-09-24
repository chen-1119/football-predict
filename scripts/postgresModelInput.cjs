"use strict";

const { createPostgresPool } = require("../server/postgresStore.cjs");
const { publicationIdentityFromMeta } = require("../server/postgresProjectionStore.cjs");
const { sqlitePublicationMatches, resolveServingPublicationForSqliteIdentity,
  acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");

// Sort only narrow keys. Sorting payload::text detoasts the retained training
// corpus into PostgreSQL temporary files before the LIMIT can be satisfied.
// Hydrate each bounded page by primary key in the same MVCC transaction, then
// restore the cursor order before giving rows to the model collector.
async function scanPostgresModelInput(client, table, settings, consume) {
  if (!["match_snapshots", "prediction_snapshots", "odds_snapshots"].includes(table)) throw new Error("model input table rejected");
  const limit = Number(settings.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("invalid model input row limit");
  const direction = settings.preferLatestRows === true ? "DESC" : "ASC";
  const cursor = `model_${table}`;
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR
    SELECT id${table === "match_snapshots" ? ", dataset" : ""}
    FROM football.${table} ${table === "match_snapshots" ? "WHERE dataset IN ('current', 'history')" : ""}
    ORDER BY ${table === "match_snapshots" ? "kickoff_time" : "captured_at"} ${direction}, id ${direction} LIMIT $1`, [limit]);
  let scanError = null;
  try {
    while (true) {
      const page = await client.query(`FETCH FORWARD 128 FROM ${cursor}`);
      if (!page.rows.length) break;
      const ids = page.rows.map(row => row.id);
      if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
        throw new Error("model input cursor returned invalid ids");
      }
      const hydrated = await client.query(`SELECT id, payload::text AS payload
        FROM football.${table} WHERE id = ANY($1::text[])`, [ids]);
      const byId = new Map(hydrated.rows.map(row => [row.id, row]));
      if (byId.size !== ids.length || hydrated.rows.length !== ids.length) {
        throw new Error("model input page changed inside read transaction");
      }
      for (const row of page.rows) {
        const value = byId.get(row.id);
        if (!value || typeof value.payload !== "string") throw new Error("model input page payload missing");
        consume(table === "match_snapshots" ? { ...value, dataset: row.dataset } : value);
      }
    }
  } catch (error) {
    scanError = error;
    throw error;
  } finally {
    try { await client.query(`CLOSE ${cursor}`); }
    catch (error) { if (!scanError) throw error; }
  }
}

// Each cursor is bounded; all input tables share one MVCC snapshot. Do not
// stitch current fixtures or result corrections from another transaction into it.
async function readPostgresModelInput(options = {}) {
  const owned = !options.pool;
  const pool = options.pool || createPostgresPool({ applicationName: "football-model-input", max: 1 });
  let client, lease;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const metadata = await client.query(`SELECT key, value FROM football.projection_meta
      WHERE key = ANY($1::text[])`, [["data_publication_mode", "data_generation_id", "manifest_hash",
      "data_generation_source_cycle_id", "committed_at"]]);
    const identity = publicationIdentityFromMeta(Object.fromEntries(metadata.rows.map(row => [row.key, { value: row.value }])),
      { strictGenerationSource: true });
    if (identity.mode !== "active-generation" || !identity.generationId || !identity.manifestHash
      || !identity.sourceCycleId || !identity.committedAt) throw new Error("model input requires a complete PostgreSQL publication identity");
    if (options.publicationIdentity && !sqlitePublicationMatches(identity, options.publicationIdentity)) {
      throw new Error("model input PostgreSQL publication mismatch");
    }
    const publication = resolveServingPublicationForSqliteIdentity({ storeDir: options.storeDir,
      publicDataDir: options.publicDataDir, sqliteIdentity: identity, allowPrevious: true });
    if (!publication.context || !sqlitePublicationMatches(publication.identity, identity)) {
      throw new Error("model input immutable generation mismatch");
    }
    lease = acquireGenerationReadLease({ storeDir: options.storeDir, generationId: identity.generationId,
      context: publication.context, owner: "postgres-model-input", ttlMs: 30 * 60_000 });
    const current = [], history = [];
    // Unlike snapshot training limits, match truncation must never silently
    // change the evaluation denominator. Refuse oversized input explicitly.
    const count = await client.query("SELECT COUNT(*)::int AS count FROM football.match_snapshots WHERE dataset IN ('current', 'history')");
    if (count.rows[0].count > 1_000_000) throw new Error("model input match limit exceeded");
    await scanPostgresModelInput(client, "match_snapshots", { limit: 1_000_000 }, row => {
      const payload = JSON.parse(row.payload);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid model match payload");
      if (row.dataset === "current") current.push(payload);
      else if (row.dataset === "history") history.push(payload);
      else throw new Error("invalid model match dataset");
    });
    const results = {};
    for (const table of ["prediction_snapshots", "odds_snapshots"]) {
      const settings = options[table];
      const collector = options.createCollector(table, settings);
      await scanPostgresModelInput(client, table, settings, collector.add);
      results[table] = { ...collector.finish(), source: "postgres", table, publication: identity };
    }
    await client.query("COMMIT");
    return { current, history, ...results, publication: identity };
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
    throw error; // No JSON or SQLite fallback on incomplete training evidence.
  } finally {
    client?.release();
    lease?.release();
    if (owned) await pool.end();
  }
}

module.exports = { readPostgresModelInput, scanPostgresModelInput };
