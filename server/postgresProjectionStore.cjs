"use strict";

const {
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
} = require("../src/services/matchLifecycle.cjs");
const {
  sqlitePublicationMatches,
} = require("./dataGenerationBundle.cjs");
const {
  validateFastResultReceiptMetadata,
  FAST_RESULT_RECEIPT_META_KEYS,
} = require("../scripts/fastResultReceiptIntegrity.cjs");

const PUBLICATION_META_KEYS = Object.freeze([
  "data_publication_mode",
  "data_generation_id",
  "manifest_hash",
  "data_generation_source_cycle_id",
  "source_cycle_id",
  "committed_at",
]);

const STATUS_META_KEYS = Object.freeze([
  ...PUBLICATION_META_KEYS,
  "schema_version",
  "exported_at",
  "sync_meta_updated_at",
  "warehouse_policy",
  "fast_result_receipt",
  "fast_result_revision",
  "fast_result_published_at",
  "fast_result_source_cycle_id",
  "fast_result_dataset_revision",
]);

const sourceMatchIdFor = (id) => String(id || "").trim().replace(/^sporttery_/, "");

const normalizePayload = (payload) => {
  if (!payload) return null;
  if (typeof payload === "string") {
    try { return JSON.parse(payload); } catch { return null; }
  }
  return typeof payload === "object" && !Array.isArray(payload) ? payload : null;
};

const parsePayloadRows = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => normalizePayload(row?.payload))
  .filter(Boolean);

const metaObject = (rows) => Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [
  row.key,
  {
    value: row.value,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  },
]));

const publicationIdentityFromMeta = (meta, options = {}) => ({
  mode: meta?.data_publication_mode?.value || "legacy-bootstrap",
  generationId: meta?.data_generation_id?.value || null,
  manifestHash: meta?.manifest_hash?.value || null,
  sourceCycleId: meta?.data_generation_source_cycle_id?.value
    || (options.strictGenerationSource === true ? null : meta?.source_cycle_id?.value)
    || null,
  committedAt: meta?.committed_at?.value || null,
});

const selectMeta = async (client, keys = STATUS_META_KEYS) => {
  const result = await client.query(`
    SELECT key, value, updated_at
    FROM football.projection_meta
    WHERE key = ANY($1::text[])
  `, [keys]);
  return metaObject(result.rows);
};

const withReadSnapshot = async (pool, publicationIdentity, callback) => {
  const required = String(process.env.FOOTBALL_STORAGE_MODE || "").trim().toLowerCase() === "postgres-only";
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const meta = await selectMeta(client, PUBLICATION_META_KEYS);
    const publication = publicationIdentityFromMeta(meta, { strictGenerationSource: true });
    if (!sqlitePublicationMatches(publication, publicationIdentity)) {
      if (required) throw new Error("postgres-generation-mismatch");
      await client.query("ROLLBACK");
      return { available: false, reason: "postgres-generation-mismatch", publication, value: null };
    }
    const value = await callback(client, publication);
    await client.query("COMMIT");
    return { available: true, reason: null, publication, value };
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch { /* preserve read failure */ }
    if (required) {
      const failure = new Error("PostgreSQL publication is unavailable; refusing legacy data fallback");
      failure.code = "POSTGRES_REQUIRED_READ_UNAVAILABLE";
      failure.statusCode = 503;
      throw failure;
    }
    return {
      available: false,
      reason: error.message || String(error),
      publication: null,
      value: null,
    };
  } finally {
    client?.release();
  }
};

const readPostgresPublicationIdentity = async (pool) => {
  try {
    const meta = await selectMeta(pool, PUBLICATION_META_KEYS);
    return {
      available: true,
      reason: null,
      publication: publicationIdentityFromMeta(meta, { strictGenerationSource: true }),
    };
  } catch (error) {
    return {
      available: false,
      reason: error.message || String(error),
      publication: null,
    };
  }
};

const getPostgresProjectionStatus = async (pool, options = {}) => {
  const startedAt = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [meta, countsResult, runResult, serverResult] = await Promise.all([
        selectMeta(client, STATUS_META_KEYS),
        client.query(`
          SELECT
            COUNT(*) FILTER (WHERE dataset = 'current')::bigint AS current_matches,
            COUNT(*) FILTER (WHERE dataset = 'history')::bigint AS history_matches,
            COUNT(*) FILTER (WHERE dataset NOT IN ('current', 'history'))::bigint AS legacy_match_snapshots,
            (SELECT COUNT(*)::bigint FROM football.odds_snapshots) AS odds_snapshots,
            (SELECT COUNT(*)::bigint FROM football.prediction_snapshots) AS prediction_snapshots,
            (SELECT COUNT(*)::bigint FROM football.source_snapshots) AS source_snapshots,
            (SELECT COUNT(*)::bigint FROM football.private_model_artifacts) AS private_model_artifacts
          FROM football.match_snapshots
        `),
        client.query(`
          SELECT run_id, mode, source_fingerprint, row_counts, table_hashes,
                 started_at, committed_at, duration_ms
          FROM football.projection_runs
          ORDER BY committed_at DESC, run_id DESC
          LIMIT 1
        `),
        client.query(`
          SELECT current_database() AS database,
                 current_setting('server_version') AS server_version,
                 pg_is_in_recovery() AS in_recovery,
                 now() AS checked_at
        `),
      ]);
      await client.query("COMMIT");
      const publication = publicationIdentityFromMeta(meta);
      const baseReady = sqlitePublicationMatches(publication, options.publicationIdentity);
      const counts = countsResult.rows[0] || {};
      const number = (value) => Number(value || 0);
      const latestRun = runResult.rows[0] || null;
      const server = serverResult.rows[0] || {};
      return {
        available: true,
        latencyMs: Date.now() - startedAt,
        database: server.database || null,
        serverVersion: server.server_version || null,
        inRecovery: server.in_recovery ?? null,
        checkedAt: server.checked_at instanceof Date ? server.checked_at.toISOString() : server.checked_at,
        exportedAt: meta.exported_at?.value || null,
        syncMetaUpdatedAt: meta.sync_meta_updated_at?.value || null,
        publication,
        baseReady,
        baseBlockedReason: baseReady ? null : "postgres-generation-mismatch",
        counts: {
          currentMatches: number(counts.current_matches),
          historyMatches: number(counts.history_matches),
          legacyMatchSnapshots: number(counts.legacy_match_snapshots),
          oddsSnapshots: number(counts.odds_snapshots),
          predictionSnapshots: number(counts.prediction_snapshots),
          sourceSnapshots: number(counts.source_snapshots),
          privateModelArtifacts: number(counts.private_model_artifacts),
        },
        latestRun: latestRun ? {
          runId: latestRun.run_id,
          mode: latestRun.mode,
          sourceFingerprint: latestRun.source_fingerprint,
          rowCounts: latestRun.row_counts,
          tableHashes: latestRun.table_hashes,
          startedAt: latestRun.started_at instanceof Date ? latestRun.started_at.toISOString() : latestRun.started_at,
          committedAt: latestRun.committed_at instanceof Date ? latestRun.committed_at.toISOString() : latestRun.committed_at,
          durationMs: Number(latestRun.duration_ms || 0),
        } : null,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve status failure */ }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return {
      available: false,
      latencyMs: Date.now() - startedAt,
      reason: error.message || String(error),
      counts: {},
    };
  }
};

const readPostgresCurrentMatches = async (pool, options = {}) => {
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT payload
      FROM football.match_snapshots
      WHERE dataset = 'current'
      ORDER BY kickoff_time ASC, match_id ASC
    `);
    return parsePayloadRows(rows.rows);
  });
  return result.available ? result.value : [];
};

const readPostgresHistoryMatchesForList = async (pool, limit = 600, options = {}) => {
  const safeLimit = Math.max(1, Math.min(1200, Number(limit || 600)));
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT payload
      FROM football.match_snapshots
      WHERE dataset = 'history'
      ORDER BY kickoff_time DESC, match_id ASC
      LIMIT $1
    `, [safeLimit]);
    return parsePayloadRows(rows.rows);
  });
  return result.available ? result.value : [];
};

const queryTransitionMatches = async (client, options = {}) => {
  const requestedLimit = Number(options.limit);
  if (Number.isFinite(requestedLimit) && requestedLimit <= 0) return [];
  const safeLimit = Math.max(1, Math.min(256, Number(options.limit || 32)));
  const sourceMatchIds = [...new Set((Array.isArray(options.sourceMatchIds) ? options.sourceMatchIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, 256);
  const exact = sourceMatchIds.length > 0
    ? await client.query(`
        SELECT payload
        FROM football.match_snapshots
        WHERE dataset = 'history' AND source_match_id = ANY($1::text[])
        ORDER BY kickoff_time DESC, id DESC
        LIMIT $2
      `, [sourceMatchIds, safeLimit * 4])
    : { rows: [] };
  const recent = await client.query(`
    SELECT payload
    FROM football.match_snapshots
    WHERE dataset = 'history'
    ORDER BY kickoff_time DESC, id DESC
    LIMIT $1
  `, [safeLimit * 4]);
  const exactRows = parsePayloadRows(exact.rows);
  const recentRows = parsePayloadRows(recent.rows);
  const rows = [];
  const seen = new Set();
  const append = (payload) => {
    const key = `${payload.id || ""}|${payload.sourceMatchId || ""}|${payload.eventVersion || payload.kickoffTime || ""}|${payload.scoreHome}:${payload.scoreAway}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(payload);
  };
  for (const sourceMatchId of sourceMatchIds) {
    exactRows.filter((payload) => String(payload.sourceMatchId || "") === sourceMatchId).forEach(append);
  }
  recentRows.forEach(append);
  return rows.slice(0, safeLimit);
};

const readPostgresTransitionMatches = async (pool, options = {}) => {
  const result = await withReadSnapshot(pool, options.publicationIdentity, (client) => (
    queryTransitionMatches(client, options)
  ));
  return result.available ? result.value : [];
};

const readPostgresCurrentTransitionSnapshot = async (pool, options = {}) => {
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client, publication) => {
    const [current, transitionRows, meta] = await Promise.all([
      client.query(`
        SELECT payload FROM football.match_snapshots
        WHERE dataset = 'current'
        ORDER BY kickoff_time ASC, match_id ASC
      `),
      queryTransitionMatches(client, options),
      selectMeta(client, [
        "fast_result_revision", "fast_result_published_at", "dataset_revision",
        "source_cycle_id", "data_generation_id", "manifest_hash", "committed_at",
        "data_publication_mode", "data_generation_source_cycle_id",
      ]),
    ]);
    return {
      available: true,
      currentRows: parsePayloadRows(current.rows),
      transitionRows,
      meta,
      publication,
    };
  });
  return result.available
    ? result.value
    : { available: false, currentRows: [], transitionRows: [], meta: {}, reason: result.reason };
};

const readPostgresHistoryMatchesPage = async (pool, options = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const safeOffset = Math.max(0, Number(options.offset || 0));
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const [count, rows] = await Promise.all([
      client.query("SELECT COUNT(*)::bigint AS count FROM football.match_snapshots WHERE dataset = 'history'"),
      client.query(`
        SELECT payload FROM football.match_snapshots
        WHERE dataset = 'history'
        ORDER BY kickoff_time DESC, match_id ASC
        LIMIT $1 OFFSET $2
      `, [safeLimit, safeOffset]),
    ]);
    return {
      rows: parsePayloadRows(rows.rows),
      consumedRows: rows.rowCount,
      totalAvailable: Number(count.rows[0]?.count || 0),
    };
  });
  return result.available ? result.value : { rows: [], consumedRows: 0, totalAvailable: 0 };
};

const readPostgresMatchById = async (pool, id, options = {}) => {
  const matchId = String(id || "").trim();
  if (!matchId) return null;
  const sourceMatchId = sourceMatchIdFor(matchId);
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT payload, dataset
      FROM football.match_snapshots
      WHERE match_id = $1 OR source_match_id = $1 OR match_id = $2 OR source_match_id = $2
      ORDER BY CASE dataset WHEN 'current' THEN 0 ELSE 1 END, kickoff_time DESC
    `, [matchId, sourceMatchId]);
    return parsePayloadRows(rows.rows).reduce((current, candidate) => (
      current ? reconcileMatchLifecycle(current, candidate) : resolveMatchLifecycle(candidate)
    ), null);
  });
  return result.available ? result.value : null;
};

const readPostgresOddsHistoryRows = async (pool, options = {}) => {
  const safeLimit = Math.max(1, Math.min(500, Number(options.limit || 200)));
  const matchId = String(options.matchId || "").trim();
  const sourceMatchId = String(options.sourceMatchId || sourceMatchIdFor(matchId)).trim();
  const marketPool = String(options.pool || "").trim();
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT payload
      FROM football.odds_snapshots
      WHERE ($1::text = '' OR match_id = $1 OR source_match_id = $2)
        AND ($1::text <> '' OR $2::text = '' OR source_match_id = $2)
        AND ($3::text = '' OR pool = $3)
      ORDER BY captured_at DESC
      LIMIT $4
    `, [matchId, sourceMatchId || matchId, marketPool, safeLimit]);
    return parsePayloadRows(rows.rows);
  });
  return result.available ? result.value : [];
};

const readPostgresPredictionSnapshotRows = async (pool, options = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const matchId = String(options.matchId || "").trim();
  const sourceMatchId = String(
    options.sourceMatchId || matchId.replace(/^(?:sporttery|fivehundred)_/, ""),
  ).trim();
  const phase = String(options.phase || "").trim();
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT payload
      FROM football.prediction_snapshots
      WHERE ($1::text = '' OR match_id = $1 OR source_match_id = $2)
        AND ($1::text <> '' OR $2::text = '' OR source_match_id = $2)
        AND ($3::text = '' OR phase = $3)
      ORDER BY captured_at DESC, id DESC
      LIMIT $4
    `, [matchId, sourceMatchId || matchId, phase, safeLimit]);
    return parsePayloadRows(rows.rows);
  });
  return result.available ? result.value : [];
};

const readPostgresFastResultReceiptState = async (pool, options = {}) => {
  const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
    const rows = await client.query(`
      SELECT key, value, updated_at
      FROM football.projection_meta
      WHERE key = ANY($1::text[])
    `, [FAST_RESULT_RECEIPT_META_KEYS]);
    if (!rows.rows.some(row => ["fast_result_receipt", "fast_result_revision"].includes(row.key))) {
      const event = await client.query("SELECT key FROM football.projection_meta WHERE key LIKE 'fast_result_authority_high_water:event:%' LIMIT 1");
      rows.rows.push(...event.rows);
    }
    return validateFastResultReceiptMetadata(rows.rows.map(row => ({ ...row,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at })));
  });
  if (!result.available) {
    return {
      available: false,
      valid: false,
      missing: false,
      legacy: false,
      reason: result.reason || "postgres-receipt-read-failed",
      revision: null,
      receipt: null,
    };
  }
  return {
    available: true,
    valid: result.value.valid === true,
    missing: result.value.missing === true,
    legacy: result.value.legacy === true,
    reason: result.value.reason || null,
    revision: Number.isSafeInteger(result.value.revision) ? result.value.revision : null,
    receipt: result.value.valid && !result.value.missing ? result.value.receipt : null,
  };
};

const readPostgresPublicReferenceEvidence = async (pool, options = {}) => {
  const { INDEX_ID, MAX_INDEX_BYTES, MAX_AUDIT_BYTES, indexRowId, validReferenceHash, resolveIndexedPublicReferenceEvidence } = require("./publicReferenceArchive.cjs");
  if (!validReferenceHash(options.referenceHash)) return { ok: false, reason: "invalid-reference-hash" };
  if (!options.publicationIdentity?.generationId) return { ok: false, reason: "generation-unavailable" };
  try {
    const result = await withReadSnapshot(pool, options.publicationIdentity, async (client) => {
      const manifest = await client.query("SELECT payload FROM football.source_snapshots WHERE id = $1 AND octet_length(payload::text) <= $2 LIMIT 1", [INDEX_ID, MAX_INDEX_BYTES]);
      const rows = await client.query("SELECT payload FROM football.source_snapshots WHERE id = $1 AND octet_length(payload::text) <= $2 LIMIT 1", [indexRowId(options.referenceHash), MAX_AUDIT_BYTES]);
      return resolveIndexedPublicReferenceEvidence(normalizePayload(manifest.rows[0]?.payload), normalizePayload(rows.rows[0]?.payload), options.referenceHash);
    });
    if (!result.available) return { ok: false, reason: result.reason === "postgres-generation-mismatch" ? "generation-mismatch" : "evidence-read-failed" };
    return { ...result.value, publication: result.publication };
  } catch { return { ok: false, reason: "evidence-store-unavailable" }; }
};

module.exports = {
  readPostgresPublicReferenceEvidence,
  getPostgresProjectionStatus,
  publicationIdentityFromMeta,
  readPostgresCurrentMatches,
  readPostgresCurrentTransitionSnapshot,
  readPostgresFastResultReceiptState,
  readPostgresHistoryMatchesForList,
  readPostgresHistoryMatchesPage,
  readPostgresMatchById,
  readPostgresOddsHistoryRows,
  readPostgresPredictionSnapshotRows,
  readPostgresPublicationIdentity,
  readPostgresTransitionMatches,
};
