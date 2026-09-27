"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs"), os = require("node:os");
const {
  resolveActivePublication, readPublicationJson, acquireGenerationReadLease,
  assertActivePublicationPointerUnchanged,
} = require("../server/dataGenerationBundle.cjs");
const { acquirePointerCommitLock, storePaths, readGenerationSelectedObject } = require("../server/dataGenerationStore.cjs");
const { attachArchivedPreMatchPredictions } = require("./syncData.cjs");
const {
  hashPayload, sourceMatchIdFor, canonicalOddsState, canonicalPredictionState,
  mergeCanonicalOddsStates, mergeCanonicalPredictionStates, earliestIso, latestIso,
} = require("./sqliteWarehouse.cjs");
const {
  normalizeLegacyReviewClock, rawOddsRecord, rawPredictionRecord,
  syncMetaDataVersion, fastResultGenerationReconciliationStamp,
} = require("./generationProjectionRows.cjs");
const {
  SOURCE_ID, INDEX_ID, INDEX_PREFIX, VERSION, INDEX_VERSION,
} = require("../server/publicReferenceArchive.cjs");
const { buildStreamedPublicReferenceArchive } = require("../server/streamedPublicReferenceArchive.cjs");
const { streamJsonObjectArrays } = require("../server/streamedJsonObjectArrays.cjs");
const { validateFastResultReceiptMetadata } = require("./fastResultReceiptIntegrity.cjs");
const {
  validateAuthorityHighWaterMetadata, FAST_RESULT_AUTHORITY_HIGH_WATER_KEY: HIGH_WATER,
  FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY: INITIALIZED,
  FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX: ROW_PREFIX,
} = require("./fastResultAuthorityHighWater.cjs");
const { trustedOfficialFinal } = require("./fastResultObservations.cjs");
const { buildFastResultProjectionGuard, guardedFastFinalFor, reconciledGenerationFastFinal } = require("./fastResultProjectionGuard.cjs");

const iso = value => value instanceof Date ? value.toISOString() : value;
const normalizeStoredRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, iso(value)]));
const sorted = rows => [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
const limit = (value, fallback, minimum) => {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > 1_000_000) throw new Error("invalid native projection retention limit");
  return number;
};
const rowFromState = (state, kind) => ({
  id: state.id, state_key: state.stateKey, match_id: state.matchId || null,
  source_match_id: state.sourceMatchId || null, captured_at: state.capturedAt || null,
  first_seen_at: state.firstSeenAt || state.capturedAt || null,
  last_seen_at: state.lastSeenAt || state.capturedAt || null,
  seen_count: Math.max(1, Number(state.seenCount || 1)), payload: JSON.stringify(state.payload),
  ...(kind === "odds" ? { pool: state.pool || null, bookmaker: state.bookmaker || null,
    handicap_line: Number.isFinite(Number(state.handicapLine)) ? Number(state.handicapLine) : null } : { phase: state.phase || null }),
});

// Legacy bounded materializer kept for explicit diagnostic callers. The native
// projection below uses the disk-backed builder, not this object-graph API.
const MAX_REFERENCE_RETAINED_CHARS = 320 * 1024 * 1024;
function readPostgresReferenceSnapshot(context, { maxRetainedChars = MAX_REFERENCE_RETAINED_CHARS, maxItems = 100000 } = {}) {
  if (!Number.isSafeInteger(maxRetainedChars) || maxRetainedChars < 1 || maxRetainedChars > MAX_REFERENCE_RETAINED_CHARS
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100000) throw new Error("invalid native reference admission bound");
  const name = "prediction-snapshots.json";
  // Reuse context/path admission and retain only tiny top-level metadata.
  const { value: metadata } = readGenerationSelectedObject(context, name, {
    keys: ["updatedAt", "retentionDays"], maxSelectedChars: 64 * 1024,
  });
  const entry = context.manifest.files.find(item => item.path === name);
  const arrays = { publicReferenceDecisions: [], publicReferenceEvidence: [] };
  let retainedChars = 0, items = 0;
  const result = require("../server/streamedJsonObjectArrays.cjs").streamJsonObjectArrays(
    path.join(context.generationDir, name), {
      keys: Object.keys(arrays), allowNonArrays: true,
      expectedBytes: entry.bytes, expectedSha256: entry.sha256,
      onItem(key, value) {
        retainedChars += JSON.stringify(value).length;
        if (retainedChars > maxRetainedChars || ++items > maxItems) {
          const error = new Error("native reference object graph exceeds bounded admission");
          error.code = "POSTGRES_REFERENCE_ADMISSION_LIMIT";
          throw error;
        }
        arrays[key].push(value);
      },
    });
  return { ...metadata, ...Object.fromEntries(result.fields.map(key => [key, arrays[key]])) };
}

// The projection only needs the retained tail of rows; reference evidence is
// validated separately. Keep offsets (not payload graphs) while canonical
// states are merged, sorted and compared with PostgreSQL.
const archiveSourceKey = value => String(value?.sourceMatchId || String(value?.id || "").replace(/^sporttery_/, "")).trim();
function spoolGenerationRows(context, name, limitRows, tempDir, complete = false) {
  if (!["prediction-snapshots.json", "odds-history.json"].includes(name)
    || !Number.isSafeInteger(limitRows) || limitRows < 1 || limitRows > 1000000) throw new Error("invalid native row spool options");
  const entry = context?.manifest?.files?.find(item => item.path === name);
  if (!entry || !context.generationDir) throw new Error("native row spool missing immutable manifest");
  const base = fs.realpathSync(tempDir || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, "football-pg-states-"));
  let fd = null, closed = false, bytes = 0, count = 0;
  const tail = new Array(limitRows);
  const close = () => {
    if (closed) return; closed = true;
    let closeError = null; if (fd !== null) { try { fs.closeSync(fd); } catch (error) { closeError = error; } }
    if (path.dirname(directory) !== base || !path.basename(directory).startsWith("football-pg-states-")) throw new Error("unsafe state scratch cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
    if (closeError) throw closeError;
  };
  const append = value => {
    const buffer = Buffer.from(JSON.stringify(value));
    if (bytes + buffer.length > 2 * 1024 ** 3) throw new Error("native state scratch exceeds bounded bytes");
    const item = { offset: bytes, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
    let offset = 0;
    while (offset < buffer.length) { const n = fs.writeSync(fd, buffer, offset, buffer.length - offset); if (!n) throw new Error("native state scratch write stalled"); offset += n; }
    bytes += buffer.length; return item;
  };
  const read = item => {
    if (closed) throw new Error("native state scratch is closed");
    const buffer = Buffer.allocUnsafe(item.bytes); let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, item.offset + offset); if (!n) throw new Error("native state scratch truncated"); offset += n; }
    if (crypto.createHash("sha256").update(buffer).digest("hex") !== item.sha256) throw new Error("native state scratch integrity invalid");
    return JSON.parse(buffer.toString("utf8"));
  };
  try {
    fs.chmodSync(directory, 0o700);
    fd = fs.openSync(path.join(directory, "states.json"), "wx+", 0o600);
    const result = streamJsonObjectArrays(path.join(context.generationDir, name), { keys: ["rows"], expectedBytes: entry.bytes, expectedSha256: entry.sha256,
      onItem(_key, value) {
        if (complete && count >= limitRows) throw new Error("complete native archive row inventory exceeds bounded count");
        tail[count++ % limitRows] = { ...append(value), sourceKey: archiveSourceKey(value) };
      } });
    if (!result.fields.includes("rows")) throw new Error("native projection missing rows array");
    return { append, read, close, directory,
      *rows() { for (let index = Math.max(0, count - limitRows); index < count; index++) yield read(tail[index % limitRows]); },
      *rowsForSource(sourceKey) { for (let index = Math.max(0, count - limitRows); index < count; index++) {
        const item = tail[index % limitRows]; if (item.sourceKey === sourceKey) yield read(item);
      } } };
  } catch (error) { close(); throw error; }
}

// Real immutable generation reader. No node:sqlite, SQLite database, or SQL
// compatibility facade is used. Existing PG state is read under the writer's
// SERIALIZABLE transaction/advisory lock; old states survive input retention.
function createPostgresGenerationSource(options = {}) {
  const root = path.resolve(__dirname, "..");
  const storeDir = path.resolve(options.storeDir || process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(root, "server-data"));
  const publicDataDir = path.resolve(options.publicDataDir || path.join(root, "public/data"));
  const active = resolveActivePublication({ storeDir, publicDataDir });
  if (active.mode !== "active-generation") throw new Error("native PostgreSQL projection requires a validated immutable generation");
  const publication = Object.fromEntries(["mode", "generationId", "manifestHash", "sourceCycleId", "committedAt"].map(key => [key, active.identity[key]]));
  const oddsLimit = limit(options.oddsLimit ?? process.env.SQLITE_EXPORT_ODDS_LIMIT, 50000, 1000);
  const predictionLimit = limit(options.predictionLimit ?? process.env.SQLITE_EXPORT_PREDICTION_LIMIT, 10000, 500);
  const oddsStateLimit = limit(options.oddsStateLimit ?? process.env.SQLITE_ODDS_STATE_LIMIT, Math.max(50000, oddsLimit), 1000);
  const predictionStateLimit = limit(options.predictionStateLimit ?? process.env.SQLITE_PREDICTION_STATE_LIMIT, Math.max(50000, predictionLimit), 500);
  const policy = { version: "postgres-native-generation-v2-streamed-reference", oddsLimit, predictionLimit, oddsStateLimit, predictionStateLimit,
    publicReferenceArchive: VERSION, publicReferenceIndex: INDEX_VERSION };
  const now = new Date().toISOString();
  const meta = {};
  const put = (key, value) => { meta[key] = { key, value: String(value ?? ""), updated_at: now }; };
  put("data_publication_mode", publication.mode); put("data_generation_id", publication.generationId);
  put("manifest_hash", publication.manifestHash); put("committed_at", publication.committedAt);
  put("source_cycle_id", publication.sourceCycleId); put("data_generation_source_cycle_id", publication.sourceCycleId);
  put("projection_source_kind", "native-generation"); put("warehouse_policy", JSON.stringify(policy));
  put("exported_at", now); put("prediction_state_identity_version", "prediction-state-v3");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ publication, policy })).digest("hex");
  const lease = acquireGenerationReadLease({ storeDir, generationId: publication.generationId, context: active.context,
    owner: "postgres-native-projection", ttlMs: 30 * 60 * 1000 });
  let closed = false, client = null, pointerLock = null, guard = null, syncMeta = null;
  const scratch = new Set();
  const inventories = new Map();
  const assertOpen = () => { if (closed) throw new Error("native projection source is closed"); };
  const assertUnchanged = () => {
    assertOpen();
    if (Date.now() >= Date.parse(lease.expiresAt)) throw new Error("native projection generation read lease expired");
    assertActivePublicationPointerUnchanged({ storeDir, expected: active });
  };
  const read = name => {
    assertUnchanged();
    // readPublicationJson rechecks each file against the validated manifest.
    return readPublicationJson(active, name, null);
  };
  const array = (value, name) => {
    if (!Array.isArray(value)) throw new Error(`native projection missing array: ${name}`);
    return value;
  };
  const prepare = async (pgClient, { mode }) => {
    if (client) throw new Error("native projection source was already prepared");
    if (mode === "fast-result") throw new Error("native base projection cannot impersonate a fast-result publication");
    client = pgClient;
    syncMeta = read("sync-meta.json");
    if (!syncMeta || typeof syncMeta !== "object" || Array.isArray(syncMeta)) throw new Error("native projection sync metadata missing");
    put("sync_meta_updated_at", syncMetaDataVersion(syncMeta));
    put("fast_result_generation_reconciliation", fastResultGenerationReconciliationStamp(syncMeta));
    const rows = (await client.query("SELECT key, value, updated_at FROM football.projection_meta WHERE key LIKE 'fast_result_%' ORDER BY key")).rows.map(normalizeStoredRow);
    const byKey = new Map(rows.map(row => [row.key, row]));
    const receiptState = validateFastResultReceiptMetadata(rows);
    const authorityState = validateAuthorityHighWaterMetadata({ manifestRow: byKey.get(HIGH_WATER),
      initializedRow: byKey.get(INITIALIZED), storedRows: rows.filter(row => row.key.startsWith(ROW_PREFIX)) });
    if (!receiptState.valid || !authorityState.valid) throw new Error(`native projection fast-result integrity invalid: ${receiptState.reason || "authority"}`);
    const sources = [...new Set(receiptState.observations.map(row => String(row.sourceMatchId).toLowerCase()))];
    const history = sources.length ? (await client.query(`SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload::text AS payload
      FROM football.match_snapshots WHERE dataset='history' AND LOWER(source_match_id)=ANY($1::text[])`, [sources])).rows.map(normalizeStoredRow) : [];
    const receiptHistory = history.map(row => ({ ...row, match: JSON.parse(row.payload) })).filter(row => trustedOfficialFinal(row.match));
    guard = buildFastResultProjectionGuard({ receiptState, authorityState, receiptHistory });
    // Preserve receipt bytes/clocks; base generation publication does not invent
    // a fresh result observation or reset an established high-water ledger.
    for (const row of rows) if (row.key !== "fast_result_generation_reconciliation") meta[row.key] = row;
  };
  async function* matchRows() {
    let archiveRows = null;
    const snapshots = match => {
      assertUnchanged();
      // The selector only looks up this provider match ID. Index every row on
      // disk, then materialize just that match's original complete history.
      if (!archiveRows) { archiveRows = spoolGenerationRows(active.context, "prediction-snapshots.json", 1000000, options.referenceTempDir, true); scratch.add(archiveRows); }
      return { rows: [...archiveRows.rowsForSource(archiveSourceKey(match))] };
    };
    try {
    const result = new Map(guard.rows.map(row => [row.id, row]));
    const rebased = new Set(), seen = new Set();
    for (const dataset of ["current", "history"]) {
      for (const input of array(read(`matches-${dataset}.json`), dataset)) {
        const original = attachArchivedPreMatchPredictions([input], () => snapshots(input), null, now)[0];
        let match = normalizeLegacyReviewClock(original);
        const sourceId = match.sourceMatchId || sourceMatchIdFor(match.id) || null;
        let id = `${dataset}:${match.id || sourceId || hashPayload(match)}`;
        const protectedRow = guardedFastFinalFor(guard, match);
        if (protectedRow && dataset === "current") continue;
        if (protectedRow) {
          const reconciled = reconciledGenerationFastFinal(guard, protectedRow, match, syncMeta);
          if (!reconciled) continue;
          if (rebased.has(protectedRow.id)) throw new Error("duplicate reconciled native fast final");
          rebased.add(protectedRow.id); result.delete(protectedRow.id); match = reconciled;
          id = `${dataset}:${match.id || sourceId || hashPayload(match)}`;
        } else if (dataset === "history" && result.has(id)) continue;
        if (seen.has(id)) throw new Error("duplicate native match projection id");
        seen.add(id);
        result.set(id, { id, dataset, match_id: match.id || null, source_match_id: sourceId,
          kickoff_time: match.kickoffTime || null, status: match.status || null, payload: JSON.stringify(match) });
      }
    }
    for (const row of sorted(result.values())) yield row;
    } finally { if (archiveRows) { archiveRows.close(); scratch.delete(archiveRows); } }
  }
  async function* sourceRows() {
    assertUnchanged();
    const archive = buildStreamedPublicReferenceArchive(active.context, { tempDir: options.referenceTempDir });
    if (archive) scratch.add(archive);
    try {
    const rows = [{ id: "sync-meta:current", source: syncMeta.source || "sporttery",
      captured_at: syncMeta.updatedAt || syncMeta.capturedAt || null, payload: JSON.stringify(syncMeta) }];
    const external = read("external-signals.json");
    if (!external || typeof external !== "object" || Array.isArray(external)) throw new Error("native projection external signals missing");
    rows.push({ id: "external-signals:current", source: external.source || "external-signals", captured_at: external.updatedAt || null, payload: JSON.stringify(external) });
    const old = (await client.query("SELECT id FROM football.source_snapshots ORDER BY id")).rows;
    inventories.set("source_snapshots", [...new Set([...old.map(row => row.id).filter(id =>
      !id.startsWith("sync-meta:") && !id.startsWith("external-signals:") && id !== SOURCE_ID && id !== INDEX_ID && !id.startsWith(INDEX_PREFIX)), ...rows.map(row => row.id), ...(archive?.ids || [])])]);
    const ordinary = sorted(rows), references = archive?.rows(); let next = references?.next();
    for (const row of ordinary) {
      while (next && !next.done && Buffer.compare(Buffer.from(next.value.id), Buffer.from(row.id)) < 0) { yield next.value; next = references.next(); }
      yield row;
    }
    while (next && !next.done) { yield next.value; next = references.next(); }
    } finally { if (archive) { archive.close(); scratch.delete(archive); } }
  }
  async function* stateRows(kind) {
    const table = kind === "odds" ? "odds_snapshots" : "prediction_snapshots";
    const canonical = kind === "odds" ? canonicalOddsState : canonicalPredictionState;
    const merge = kind === "odds" ? mergeCanonicalOddsStates : mergeCanonicalPredictionStates;
    const raw = kind === "odds" ? rawOddsRecord : rawPredictionRecord;
    assertUnchanged();
    const input = spoolGenerationRows(active.context, kind === "odds" ? "odds-history.json" : "prediction-snapshots.json",
      kind === "odds" ? oddsLimit : predictionLimit, options.referenceTempDir);
    scratch.add(input);
    try {
    const candidates = new Map();
    for (const row of input.rows()) {
      const candidate = canonical(row) || raw(row, "public");
      const previous = candidates.get(candidate.id);
      const merged = merge(previous ? input.read(previous.item) : undefined, candidate);
      candidates.set(candidate.id, { id: candidate.id, lastSeenAt: merged.lastSeenAt, capturedAt: merged.capturedAt, item: input.append(merged) });
    }
    // Small metadata inventory only; do not load the multi-GB warehouse into V8.
    const old = (await client.query(`SELECT id, state_key, captured_at, first_seen_at, last_seen_at, seen_count FROM football.${table} ORDER BY id`)).rows.map(normalizeStoredRow);
    const oldById = new Map(old.map(row => [row.id, row]));
    const mergedTimes = new Map(old.map(row => [row.id, row.last_seen_at || row.captured_at]));
    for (const state of candidates.values()) mergedTimes.set(state.id, latestIso(mergedTimes.get(state.id), state.lastSeenAt, state.capturedAt));
    const retained = [...mergedTimes].sort((a, b) => (Date.parse(b[1]) || 0) - (Date.parse(a[1]) || 0)
      || Buffer.compare(Buffer.from(b[0]), Buffer.from(a[0]))).slice(0, kind === "odds" ? oddsStateLimit : predictionStateLimit).map(([id]) => id);
    inventories.set(table, retained); const keep = new Set(retained);
    for (const descriptor of sorted(candidates.values())) {
      if (!keep.has(descriptor.id)) continue;
      const state = input.read(descriptor.item);
      const previous = oldById.get(state.id);
      if (!previous) { yield rowFromState(state, kind); continue; }
      if (String(previous.state_key || "") !== String(state.stateKey || "")) throw new Error("native projection state id collision");
      // Match the legacy prediction metadata-first path exactly. Repeated
      // observations must not rewrite original payloads or manufacture samples.
      if (kind === "prediction") {
        const first = earliestIso(previous.first_seen_at, previous.captured_at, state.firstSeenAt, state.capturedAt);
        const last = latestIso(previous.last_seen_at, previous.captured_at, state.lastSeenAt, state.capturedAt) || first;
        const count = Math.max(1, Number(previous.seen_count || 1), state.seenCount || 1);
        if (!(Date.parse(state.lastSeenAt || state.capturedAt) > Date.parse(previous.last_seen_at || previous.captured_at))
          && previous.captured_at === first && previous.first_seen_at === first && previous.last_seen_at === last && previous.seen_count === count) continue;
      }
      const stored = (await client.query(`SELECT *, payload::text AS payload FROM football.${table} WHERE id=$1`, [state.id])).rows[0];
      if (!stored) throw new Error("native projection state inventory changed");
      // Malformed legacy raw rows follow the legacy exporter: a noncanonical
      // prior state is not promoted to a canonical forecast by migration.
      yield rowFromState(merge(canonical(normalizeStoredRow(stored)), state), kind);
    }
    } finally { input.close(); scratch.delete(input); }
  }
  return {
    kind: "native-generation", path: active.context.generationDir || `generation:${publication.generationId}`,
    bytes: 0, publication, meta, fingerprint, prepare, assertUnchanged,
    tableRows(table) {
      assertOpen(); if (!client) throw new Error("native source requires transaction preparation");
      if (table === "match_snapshots") return matchRows();
      if (table === "source_snapshots") return sourceRows();
      if (table === "odds_snapshots") return stateRows("odds");
      if (table === "prediction_snapshots") return stateRows("prediction");
      throw new Error("unsupported native source table");
    },
    activeIds(table) { if (!inventories.has(table)) throw new Error("native active inventory has not completed"); return inventories.get(table); },
    hasPrivateAudit: () => false,
    beforeCommit() {
      pointerLock = acquirePointerCommitLock({ lockDir: storePaths(storeDir).pointerLockDir });
      assertUnchanged(); // Lock remains held through COMMIT or ROLLBACK.
    },
    close() {
      if (closed) return; closed = true;
      try { for (const resource of scratch) resource.close(); scratch.clear(); }
      finally { try { pointerLock?.release(); } finally { lease.release(); } }
    },
  };
}
module.exports = { createPostgresGenerationSource, rowFromState, readPostgresReferenceSnapshot, spoolGenerationRows };
