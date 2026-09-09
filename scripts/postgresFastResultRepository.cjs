"use strict";
const path = require("node:path"), crypto = require("node:crypto");
const { createPostgresPool } = require("../server/postgresStore.cjs");
const { resolveActivePublication, acquireGenerationReadLease, assertActivePublicationPointerUnchanged } = require("../server/dataGenerationBundle.cjs");
const { acquirePointerCommitLock, storePaths } = require("../server/dataGenerationStore.cjs");
const { validateFastResultReceiptMetadata, FAST_RESULT_RECEIPT_META_KEYS } = require("./fastResultReceiptIntegrity.cjs");
const high = require("./fastResultAuthorityHighWater.cjs");
const { persistSemanticRows } = require("./postgresProjectionSync.cjs");
const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));

// Named operations over real PostgreSQL tables. The publisher's shared
// algorithm never translates SQLite SQL or constructs a temporary database.
async function createPostgresFastResultRepository(options = {}) {
  const root = path.resolve(__dirname, "..");
  const storeDir = path.resolve(options.storeDir || process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(root, "server-data"));
  const publicDataDir = path.resolve(options.publicDataDir || path.join(root, "public/data"));
  const active = resolveActivePublication({ storeDir, publicDataDir });
  if (active.mode !== "active-generation") throw new Error("native fast-result publication requires an immutable base generation");
  const lease = acquireGenerationReadLease({ storeDir, generationId: active.identity.generationId, context: active.context,
    owner: "postgres-fast-result", ttlMs: 15 * 60 * 1000 });
  let pool, client, transaction = false, closed = false, pointerLock;
  const assertBase = () => {
    if (Date.now() >= Date.parse(lease.expiresAt)) throw new Error("native fast-result generation lease expired");
    assertActivePublicationPointerUnchanged({ storeDir, expected: active });
  };
  const changedIds = new Set();
  const metadata = async () => (await client.query("SELECT key,value,updated_at FROM football.projection_meta WHERE key LIKE 'fast_result_%' ORDER BY key")).rows.map(normalize);
  const receipt = async () => {
    const rows = (await client.query("SELECT key,value,updated_at FROM football.projection_meta WHERE key=ANY($1::text[])", [FAST_RESULT_RECEIPT_META_KEYS])).rows.map(normalize);
    if (!rows.some(row => ["fast_result_receipt", "fast_result_revision"].includes(row.key))) {
      const event = (await client.query("SELECT key FROM football.projection_meta WHERE key LIKE 'fast_result_authority_high_water:event:%' LIMIT 1")).rows[0];
      if (event) rows.push(event);
    }
    return validateFastResultReceiptMetadata(rows);
  };
  const authority = async () => {
    const rows = await metadata(), byKey = new Map(rows.map(row => [row.key, row]));
    return high.validateAuthorityHighWaterMetadata({ manifestRow: byKey.get(high.FAST_RESULT_AUTHORITY_HIGH_WATER_KEY),
      initializedRow: byKey.get(high.FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY),
      storedRows: rows.filter(row => row.key.startsWith(high.FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX)) });
  };
  const upsertMeta = (key, value, at) => client.query(`INSERT INTO football.projection_meta(key,value,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`, [key, String(value), at]);
  const close = async () => {
    if (closed) return; closed = true;
    try {
      if (transaction && client) await client.query("ROLLBACK");
    } finally {
      try { client?.release(); }
      finally {
        try { pointerLock?.release(); }
        finally { try { lease.release(); } finally { if (!options.pool && pool) await pool.end(); } }
      }
    }
  };
  try {
    pool = options.pool || createPostgresPool({ applicationName: "football-native-fast-result" });
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); transaction = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-postgres-projection-sync-v1"]);
    assertBase();
    const values = Object.fromEntries((await client.query("SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])",
      [["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"]])).rows.map(row => [row.key, row.value]));
    for (const [key, field] of [["data_publication_mode", "mode"], ["data_generation_id", "generationId"], ["manifest_hash", "manifestHash"],
      ["data_generation_source_cycle_id", "sourceCycleId"], ["committed_at", "committedAt"]]) {
      if (values[key] !== active.identity[field]) throw new Error(`native fast-result PostgreSQL/base mismatch: ${key}`);
    }
    const matchRows = async (dataset, id) => (await client.query(`SELECT id,dataset,match_id,source_match_id,kickoff_time,status,payload::text AS payload
      FROM football.match_snapshots WHERE dataset=$1 AND source_match_id=$2 ORDER BY id`, [dataset, id])).rows.map(normalize);
    const changed = async (sql, params, id) => {
      const result = await client.query(sql, params); if (result.rowCount) changedIds.add(id);
      return { changes: result.rowCount };
    };
    return {
      available: () => true, receipt, authority, upsertMeta,
      migrateLegacy: () => ({ ok: false, reason: "legacy receipt requires explicit pre-cutover migration" }),
      begin() { if (!transaction) throw new Error("native publication transaction already ended"); },
      async rollback() { if (transaction) { await client.query("ROLLBACK"); transaction = false; } },
      async commit() {
        if (!transaction) throw new Error("native publication transaction already ended");
        const state = await receipt(), ledger = await authority();
        if (!state.valid || !ledger.valid || (!state.missing && ledger.missing)) throw new Error("native fast-result metadata failed precommit integrity");
        const rows = changedIds.size ? (await client.query(`SELECT id,payload::text AS payload FROM football.match_snapshots
          WHERE id=ANY($1::text[]) AND dataset='history' ORDER BY id`, [[...changedIds]])).rows : [];
        const semantic = rows.length ? await persistSemanticRows(client, rows, active.identity.generationId) : {};
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ publication: active.identity, receipt: state.receipt,
          authority: ledger.manifest, rows })).digest("hex");
        await client.query(`INSERT INTO football.projection_runs(run_id,mode,source_path,source_fingerprint,publication_id,row_counts,
          table_hashes,started_at,duration_ms,payload) VALUES($1,'fast-result',$2,$3,$4,$5::jsonb,'{}'::jsonb,now(),0,$6::jsonb)`,
        [`pg-fast-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`, `generation:${active.identity.generationId}`, fingerprint,
          active.identity.generationId, JSON.stringify({ changedHistory: rows.length, semantic }), JSON.stringify({ sourceKind: "native-fast-result", sqliteBytes: 0 })]);
        pointerLock = acquirePointerCommitLock({ lockDir: storePaths(storeDir).pointerLockDir });
        assertBase();
        await client.query("COMMIT"); transaction = false;
        pointerLock.release(); pointerLock = null;
      },
      history: id => matchRows("history", id), current: id => matchRows("current", id),
      rowById: async id => (await client.query("SELECT id,dataset,payload::text AS payload FROM football.match_snapshots WHERE id=$1", [id])).rows[0],
      predictions: async id => (await client.query(`SELECT payload FROM football.prediction_snapshots
        WHERE source_match_id=$1 ORDER BY captured_at ASC,id ASC`, [id])).rows.map(row => row.payload).filter(row => row && typeof row === "object"),
      insertHistory: (id, matchId, sourceId, kickoff, payload) => changed(`INSERT INTO football.match_snapshots
        (id,dataset,match_id,source_match_id,kickoff_time,status,payload) VALUES($1,'history',$2,$3,$4,'FINISHED',$5::json)`,
      [id, matchId, sourceId, kickoff, payload], id),
      updateHistory: (matchId, sourceId, kickoff, payload, id) => changed(`UPDATE football.match_snapshots
        SET match_id=$1,source_match_id=$2,kickoff_time=$3,status='FINISHED',payload=$4::json WHERE id=$5 AND dataset='history'`,
      [matchId, sourceId, kickoff, payload, id], id),
      deleteCurrent: id => changed("DELETE FROM football.match_snapshots WHERE id=$1 AND dataset='current'", [id], id),
      async persistAuthority(merged, at) {
        if (!merged?.valid || !merged.changed) return false;
        const updatedAt = merged.rows.reduce((latest, row) => !latest || Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest, null) || at;
        const manifest = { ...high.expectedManifest(), updatedAt, rows: merged.rows.length, rootHash: high.rowsRootHash(merged.rows) };
        await upsertMeta(high.FAST_RESULT_AUTHORITY_HIGH_WATER_KEY, JSON.stringify(manifest), updatedAt);
        await client.query(`INSERT INTO football.projection_meta(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,
        [high.FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY, JSON.stringify({ version: high.FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION,
          state: "INITIALIZED", initializedAt: at || updatedAt }), at || updatedAt]);
        for (const row of merged.changedRows.length ? merged.changedRows : merged.rows) {
          await upsertMeta(high.FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX + row.key, JSON.stringify(row), row.observedAt);
        }
        return true;
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { createPostgresFastResultRepository };
