"use strict";
const path = require("node:path");
const { createPostgresPool } = require("../server/postgresStore.cjs");
const { publicationIdentityFromMeta } = require("../server/postgresProjectionStore.cjs");
const { resolveServingPublicationForSqliteIdentity, acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");
const { FAST_RESULT_RECEIPT_META_KEYS, validateFastResultReceiptMetadata } = require("./fastResultReceiptIntegrity.cjs");

async function openPostgresRuntimeReadSession(options = {}) {
  const storeDir = path.resolve(options.storeDir || process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(__dirname, "../server-data"));
  const publicDataDir = path.resolve(options.publicDataDir || process.env.DATA_GENERATION_PUBLIC_DATA_DIR || path.join(__dirname, "../public/data"));
  const owned = !options.pool, pool = options.pool || createPostgresPool({ max: 1, applicationName: "football-runtime-reader" });
  let client, lease, closed = false, sharedLock = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let releaseError;
    try { if (client) await client.query("ROLLBACK"); }
    catch (error) { releaseError = error; }
    finally {
      if (sharedLock) try { await client.query("SELECT pg_advisory_unlock_shared(hashtext($1))", ["football-postgres-projection-sync-v1"]); }
      catch (error) { releaseError = error; }
      client?.release(releaseError); lease?.release(); if (owned) await pool.end();
    }
  };
  try {
    client = await pool.connect();
    // Reconciliation may hold this shared barrier through its local file writes.
    // A result publisher cannot advance the receipt beneath those writes.
    if (options.protectReceipt) {
      // Acquire before BEGIN so a wait cannot pin a snapshot older than the
      // publisher whose exclusive lock just completed.
      await client.query("SELECT pg_advisory_lock_shared(hashtext($1))", ["football-postgres-projection-sync-v1"]);
      sharedLock = true;
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const rows = await client.query("SELECT key,value FROM football.projection_meta WHERE key = ANY($1::text[])",
      [["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"]]);
    const identity = publicationIdentityFromMeta(Object.fromEntries(rows.rows.map(row => [row.key, { value: row.value }])), { strictGenerationSource: true });
    if (identity.mode !== "active-generation" || !identity.generationId || !identity.manifestHash || !identity.sourceCycleId || !identity.committedAt) {
      throw new Error("native read requires complete publication identity");
    }
    const publication = resolveServingPublicationForSqliteIdentity({ storeDir, publicDataDir, sqliteIdentity: identity, allowPrevious: true });
    if (!publication.context) throw new Error("native read requires matching immutable generation");
    lease = acquireGenerationReadLease({ storeDir, generationId: identity.generationId, context: publication.context,
      owner: "postgres-runtime-reader", ttlMs: 15 * 60_000 });
    const receiptState = async () => {
        const result = await client.query("SELECT key,value,updated_at FROM football.projection_meta WHERE key=ANY($1::text[])", [FAST_RESULT_RECEIPT_META_KEYS]);
        if (!result.rows.some(row => ["fast_result_receipt", "fast_result_revision"].includes(row.key))) {
          result.rows.push(...(await client.query("SELECT key FROM football.projection_meta WHERE key LIKE 'fast_result_authority_high_water:event:%' LIMIT 1")).rows);
        }
        const state = validateFastResultReceiptMetadata(result.rows.map(row => ({ ...row,
          updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at })));
        if (!state.valid) throw new Error(`native receipt invalid: ${state.reason}`);
        if (state.legacy) throw new Error("native receipt requires explicit legacy migration");
        return state;
    };
    return { client, identity, publication, close,
      async receipt() { return (await receiptState()).receipt; },
      async guardedFinals() {
        const state = await receiptState();
        const high = require("./fastResultAuthorityHighWater.cjs");
        const metadata = (await client.query("SELECT key,value,updated_at FROM football.projection_meta WHERE key=$1 OR key=$2 OR starts_with(key,$3)",
          [high.FAST_RESULT_AUTHORITY_HIGH_WATER_KEY, high.FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY, high.FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX]))
          .rows.map(row => ({ ...row, updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at }));
        const byKey = new Map(metadata.map(row => [row.key, row]));
        const authorityState = high.validateAuthorityHighWaterMetadata({
          manifestRow: byKey.get(high.FAST_RESULT_AUTHORITY_HIGH_WATER_KEY),
          initializedRow: byKey.get(high.FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY),
          storedRows: metadata.filter(row => row.key.startsWith(high.FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX)),
        });
        const ids = [...new Set(state.observations.map(row => row.sourceMatchId.toLowerCase()))];
        const rows = ids.length ? (await client.query(`SELECT id,dataset,match_id,source_match_id,kickoff_time,status,payload::text AS payload
          FROM football.match_snapshots WHERE dataset='history' AND lower(source_match_id)=ANY($1::text[]) ORDER BY id`, [ids])).rows : [];
        const receiptHistory = rows.map(row => ({ ...row, kickoff_time: row.kickoff_time instanceof Date ? row.kickoff_time.toISOString() : row.kickoff_time,
          match: JSON.parse(row.payload) }));
        return require("./fastResultProjectionGuard.cjs").buildFastResultProjectionGuard({ receiptState: state, authorityState, receiptHistory });
      },
      async historyForSourceIds(ids) {
        if (!ids.length) return [];
        const result = await client.query("SELECT payload::text AS payload FROM football.match_snapshots WHERE dataset='history' AND lower(source_match_id)=ANY($1::text[])",
          [[...new Set(ids.map(id => String(id).toLowerCase()))]]);
        return result.rows.map(row => JSON.parse(row.payload));
      },
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { openPostgresRuntimeReadSession };
