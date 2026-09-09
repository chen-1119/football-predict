"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { snapshotUpsertConflict } = require("./postgresSnapshotUpsert.cjs");
const { privateArtifactStorage } = require("./runtimePrivateModelArtifactStore.cjs");
const {
  createPostgresPool,
  runPostgresMigrations,
  withPostgresTransaction,
} = require("../server/postgresStore.cjs");
const {
  canonicalSourceMatchId,
  eventVersionOf,
} = require("../src/services/matchLifecycle.cjs");

const rootDir = path.resolve(__dirname, "..");
const DEFAULT_BATCH_ROWS = 200;
const MODE_VALUES = new Set(["backfill", "incremental", "fast-result"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const stableStringify = (value) => JSON.stringify(stableValue(value));
const text = (value) => String(value ?? "").trim();
const nullable = (value) => {
  const result = text(value);
  return result || null;
};
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const positiveInteger = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};
const iso = (value, fallback = null) => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : fallback;
  }
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};
const normalizeAiDecisionTimestamps = ({ forecast = {}, agent = {}, arena = {}, fallback }) => {
  const fallbackAt = iso(fallback, new Date().toISOString());
  const lockedAt = iso(
    forecast.lockedAt || arena.lockedAt || agent.submittedAt || forecast.decidedAt
      || forecast.generatedAt || arena.generatedAt,
    fallbackAt,
  );
  const proposedDecidedAt = iso(
    forecast.decidedAt || forecast.generatedAt || agent.submittedAt || arena.lockedAt
      || arena.generatedAt,
    lockedAt,
  );
  return {
    decidedAt: Date.parse(proposedDecidedAt) <= Date.parse(lockedAt) ? proposedDecidedAt : lockedAt,
    lockedAt,
  };
};
const jsonObject = (value, fallback = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const tableExists = (db, table) => Boolean(db.prepare(
  "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(table));

const activeIdsFromTable = (db, table, key = "id") => db.prepare(
  `SELECT ${key} AS id FROM ${table} ORDER BY ${key}`,
).all().map((row) => String(row.id));

const readMeta = (db) => Object.fromEntries(db.prepare(
  "SELECT key, value, updated_at FROM schema_meta ORDER BY key",
).all().map((row) => [row.key, row]));

const publicationFromMeta = (meta) => ({
  mode: meta.data_publication_mode?.value || "legacy-bootstrap",
  generationId: meta.data_generation_id?.value || null,
  manifestHash: meta.manifest_hash?.value || null,
  sourceCycleId: meta.data_generation_source_cycle_id?.value || meta.source_cycle_id?.value || null,
  committedAt: meta.committed_at?.value || null,
});

const assertPublicationIdentity = (publication) => {
  if (
    publication.mode !== "active-generation"
    || !/^g-[0-9a-f]{64}$/.test(publication.generationId || "")
    || !/^[0-9a-f]{64}$/.test(publication.manifestHash || "")
    || !publication.sourceCycleId
    || !iso(publication.committedAt)
  ) {
    const error = new Error("SQLite projection does not carry a complete active publication identity");
    error.code = "POSTGRES_SOURCE_PUBLICATION_IDENTITY_INVALID";
    error.publication = publication;
    throw error;
  }
};

const sourceFingerprint = (dbPath, stat, publication, meta) => sha256(stableStringify({
  path: path.resolve(dbPath),
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  publication,
  exportedAt: meta.exported_at?.value || null,
  fastResultRevision: meta.fast_result_revision?.value || null,
  fastResultPublishedAt: meta.fast_result_published_at?.value || null,
}));

const placeholders = (rowCount, columns, jsonColumnTypes = new Map()) => {
  let index = 0;
  return Array.from({ length: rowCount }, () => `(${columns.map((column) => {
    index += 1;
    const jsonType = jsonColumnTypes.get(column);
    return `$${index}${jsonType ? `::${jsonType}` : ""}`;
  }).join(",")})`).join(",");
};

const insertBatches = async ({
  client,
  table,
  columns,
  rows,
  conflict,
  jsonColumns = [],
  jsonbColumns = [],
  batchRows = DEFAULT_BATCH_ROWS,
  requireAffectedRows = false,
}) => {
  // Hash-bound payloads must use PostgreSQL `json`, not `jsonb`. `jsonb`
  // canonicalizes object keys, which changes legacy order-sensitive hashes
  // after a database round trip even when the semantic payload is identical.
  const jsonColumnTypes = new Map([
    ...jsonColumns.map((column) => [column, "json"]),
    ...jsonbColumns.map((column) => [column, "jsonb"]),
  ]);
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += batchRows) {
    const batch = rows.slice(offset, offset + batchRows);
    const values = [];
    for (const row of batch) {
      for (const column of columns) values.push(row[column] ?? null);
    }
    const result = await client.query(`
      INSERT INTO football.${table} (${columns.join(",")})
      VALUES ${placeholders(batch.length, columns, jsonColumnTypes)}
      ${conflict}
    `, values);
    if (requireAffectedRows && result.rowCount !== batch.length) {
      const error = new Error(`PostgreSQL ${table} upsert did not affect every fail-closed input row`);
      error.code = "POSTGRES_FAIL_CLOSED_UPSERT_INCOMPLETE";
      error.table = table;
      error.expectedRows = batch.length;
      error.affectedRows = result.rowCount;
      throw error;
    }
    written += batch.length;
  }
  return written;
};

const rowsFromIterator = (iterator, mapper, hash) => {
  const rows = [];
  for (const raw of iterator) {
    const row = mapper(raw);
    if (!row) continue;
    rows.push(row);
    hash.update(row.id || row.artifact_key || row.key || "");
    hash.update("\0");
    hash.update(row.payload || row.payload_json || row.value || "");
    hash.update("\n");
  }
  return rows;
};

const streamIteratorInsert = async ({
  client,
  table,
  columns,
  iterator,
  mapper,
  conflict,
  jsonColumns = ["payload"],
  batchRows = DEFAULT_BATCH_ROWS,
  collectRows = false,
}) => {
  const hash = crypto.createHash("sha256");
  const activeIds = [];
  const collectedRows = [];
  let batch = [];
  let written = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    written += await insertBatches({
      client,
      table,
      columns,
      rows: batch,
      conflict,
      jsonColumns,
      batchRows,
    });
    batch = [];
  };
  for (const raw of iterator) {
    const row = mapper(raw);
    if (!row) continue;
    const identity = row.id || row.artifact_key || row.key || "";
    activeIds.push(identity);
    if (collectRows) collectedRows.push(row);
    hash.update(identity);
    hash.update("\0");
    hash.update(row.payload || row.payload_json || row.value || "");
    hash.update("\n");
    batch.push(row);
    if (batch.length >= batchRows) await flush();
  }
  await flush();
  return {
    written,
    activeIds,
    rows: collectedRows,
    hash: hash.digest("hex"),
  };
};

const pruneWithActiveIds = async (client, table, ids, where = "", keyColumn = "id") => {
  const temp = `active_${table}_${crypto.randomBytes(5).toString("hex")}`;
  await client.query(`CREATE TEMP TABLE ${temp} (id text PRIMARY KEY) ON COMMIT DROP`);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    await client.query(`
      INSERT INTO ${temp} (id)
      VALUES ${batch.map((_, index) => `($${index + 1})`).join(",")}
      ON CONFLICT (id) DO NOTHING
    `, batch);
  }
  await client.query(`
    DELETE FROM football.${table} target
    ${where ? `WHERE ${where} AND` : "WHERE"}
      NOT EXISTS (SELECT 1 FROM ${temp} active WHERE active.id = target.${keyColumn})
  `);
};

const toMatchRow = (row) => ({
  id: row.id,
  dataset: row.dataset,
  match_id: nullable(row.match_id),
  source_match_id: nullable(row.source_match_id),
  kickoff_time: iso(row.kickoff_time),
  status: nullable(row.status),
  payload: row.payload,
});

// Called inside the source SQLite read transaction. Sort only the small ID
// inventory: sorting complete payloads can spill tens of MB to a temp B-tree.
// Each bounded PK lookup preserves the original binary ID order and raw JSON.
// Keep the complete inventory/hash/pruning; this is not a changed-row shortcut.
function* iterateMatchSnapshotRows(db, batchRows = DEFAULT_BATCH_ROWS) {
  if (!Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > DEFAULT_BATCH_ROWS) {
    throw new Error("Match projection batch size must be between 1 and 200");
  }
  const readBatch = function* (ids) {
    const statement = db.prepare(`
      SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE id IN (${ids.map(() => "?").join(",")})
      ORDER BY id
    `);
    let count = 0;
    for (const row of statement.iterate(...ids)) {
      if (row.id !== ids[count]) throw new Error("Match projection inventory order changed");
      if (!["current", "history"].includes(row.dataset)) throw new Error("Match projection dataset changed");
      count += 1;
      yield row;
    }
    if (count !== ids.length) throw new Error("Match projection inventory is incomplete");
  };
  let ids = [];
  const inventory = db.prepare(
    "SELECT id FROM match_snapshots WHERE dataset IN ('current','history') ORDER BY id",
  ).iterate();
  for (const row of inventory) {
    if (typeof row.id !== "string") throw new Error("Match projection ID must be text");
    ids.push(row.id);
    if (ids.length === batchRows) {
      yield* readBatch(ids);
      ids = [];
    }
  }
  if (ids.length > 0) yield* readBatch(ids);
}

const toSourceRow = (row) => ({
  id: row.id,
  source: row.source,
  captured_at: iso(row.captured_at),
  payload: row.payload,
});

const toOddsRow = (row) => ({
  id: row.id,
  state_key: nullable(row.state_key),
  match_id: nullable(row.match_id),
  source_match_id: nullable(row.source_match_id),
  pool: nullable(row.pool),
  bookmaker: nullable(row.bookmaker),
  handicap_line: finite(row.handicap_line),
  captured_at: iso(row.captured_at),
  first_seen_at: iso(row.first_seen_at),
  last_seen_at: iso(row.last_seen_at),
  seen_count: positiveInteger(row.seen_count),
  payload: row.payload,
});

const toPredictionRow = (row) => ({
  id: row.id,
  state_key: nullable(row.state_key),
  match_id: nullable(row.match_id),
  source_match_id: nullable(row.source_match_id),
  phase: nullable(row.phase),
  captured_at: iso(row.captured_at),
  first_seen_at: iso(row.first_seen_at),
  last_seen_at: iso(row.last_seen_at),
  seen_count: positiveInteger(row.seen_count),
  payload: row.payload,
});

const upsertProjectionMeta = async (client, meta) => {
  const rows = Object.values(meta).map((row) => ({
    key: row.key,
    value: String(row.value ?? ""),
    updated_at: iso(row.updated_at, new Date().toISOString()),
  }));
  await insertBatches({
    client,
    table: "projection_meta",
    columns: ["key", "value", "updated_at"],
    rows,
    conflict: `ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at,
      replicated_at = now()`,
    batchRows: 400,
  });
  return rows.length;
};

const upsertPublication = async (client, publication, meta) => {
  const publicationId = publication.generationId;
  await client.query(`
    UPDATE football.publications
    SET state = 'previous'
    WHERE state = 'current' AND publication_id <> $1
  `, [publicationId]);
  await client.query(`
    INSERT INTO football.publications
      (publication_id, generation_id, manifest_hash, source_cycle_id, state, payload, committed_at)
    VALUES ($1, $2, $3, $4, 'current', $5::json, $6)
    ON CONFLICT (publication_id) DO UPDATE SET
      generation_id = EXCLUDED.generation_id,
      manifest_hash = EXCLUDED.manifest_hash,
      source_cycle_id = EXCLUDED.source_cycle_id,
      state = 'current',
      payload = EXCLUDED.payload,
      committed_at = EXCLUDED.committed_at
  `, [
    publicationId,
    publication.generationId,
    publication.manifestHash,
    publication.sourceCycleId,
    JSON.stringify({
      mode: publication.mode,
      exportedAt: meta.exported_at?.value || null,
      syncMetaUpdatedAt: meta.sync_meta_updated_at?.value || null,
    }),
    publication.committedAt,
  ]);
  return publicationId;
};

const recommendationFromMatch = (match) => {
  const archived = jsonObject(match?.archivedPreMatchPrediction, null);
  const prediction = jsonObject(archived?.prediction, null);
  if (!archived || !prediction || !text(prediction.tipCode)) return null;
  const frozenAt = iso(archived.capturedAt || match?.predictionMeta?.lockedAt || match?.predictionMeta?.generatedAt);
  const cutoffAt = iso(archived.cutoffTime || match?.predictionMeta?.cutoffTime || match?.kickoffTime);
  if (!frozenAt || !cutoffAt || Date.parse(frozenAt) > Date.parse(cutoffAt)) return null;
  const hash = sha256(stableStringify({
    matchId: match.id,
    sourceMatchId: match.sourceMatchId,
    archived,
  }));
  return {
    decision_id: `decision:${hash}`,
    match_id: text(match.id || match.sourceMatchId),
    track: prediction.recommendationAction === "recommend" ? "formal" : "reference",
    market: text(prediction.oddsPoolCode || prediction.marketType || "HAD"),
    direction: text(prediction.tipCode),
    odds: finite(prediction.odds) > 0 ? finite(prediction.odds) : null,
    evidence_score: finite(prediction.liveRecommendation?.evidenceScore ?? prediction.trustScore),
    frozen_at: frozenAt,
    cutoff_at: cutoffAt,
    decision_hash: hash,
    payload: JSON.stringify({ archivedPreMatchPrediction: archived, predictionMeta: match.predictionMeta || null }),
  };
};

const observationFromMatch = (match) => {
  if (String(match?.status || "").toUpperCase() !== "FINISHED") return null;
  if (!Number.isInteger(match.scoreHome) || !Number.isInteger(match.scoreAway)) return null;
  const observedAt = iso(
    match.resultObservedAt
    || match.resultUpdatedAt
    || match.resultSourceUpdatedAt
    || match.postMatchReview?.settlement?.resultObservedAt
    || match.postMatchReview?.generatedAt,
    iso(match.kickoffTime, new Date().toISOString()),
  );
  const resultIdentity = `${match.scoreHome}:${match.scoreAway}|${text(match.resultSource || match.source)}`;
  return {
    observation_id: `result:${sha256(`${match.id}|${resultIdentity}`)}`,
    match_id: text(match.id || match.sourceMatchId),
    result_identity: resultIdentity,
    observed_at: observedAt,
    is_official_final: text(match.resultSource || match.source).includes("sporttery"),
    payload: JSON.stringify({
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
      resultSource: match.resultSource || match.source || null,
      resultProvenance: match.resultProvenance || null,
    }),
  };
};

const reviewText = (rows, fallback) => {
  const values = (Array.isArray(rows) ? rows : []).map((row) => text(row?.zh || row?.en || row?.code)).filter(Boolean);
  return values.length > 0 ? values.join("；") : fallback;
};

const resultOnlyReviewIdentity = (match, review, observation) => {
  const sourceMatchId = canonicalSourceMatchId(
    review?.sourceMatchId || match?.sourceMatchId || match?.id,
  );
  const eventVersion = iso(
    review?.eventVersion
    || eventVersionOf(match)
    || match?.resultProvenance?.eventVersion,
  );
  const resultIdentity = text(observation?.result_identity);
  const observedAt = iso(observation?.observed_at);
  const settledAt = iso(review?.settlement?.settledAt || review?.generatedAt);
  const officialFinal = observation?.is_official_final === true;
  if (!sourceMatchId || !eventVersion || !resultIdentity || !observedAt || !settledAt || !officialFinal) {
    return null;
  }
  return {
    sourceMatchId,
    eventVersion,
    resultIdentity,
    observedAt,
    settledAt,
  };
};

const reviewFromMatch = (match, recommendation, observation) => {
  const review = jsonObject(match?.postMatchReview, null);
  if (!review || !review.generatedAt || !observation) return null;
  const rawStatus = text(review?.predictionReview?.formalBestStatus).toUpperCase();
  const formalHit = ["HIT", "WON", "WIN"].includes(rawStatus)
    ? true
    : ["MISS", "LOST", "LOSS"].includes(rawStatus)
      ? false
      : null;
  const settlement = formalHit === true ? "won" : formalHit === false ? "lost" : "result-only";
  const resultOnlyIdentity = settlement === "result-only" && !recommendation
    ? resultOnlyReviewIdentity(match, review, observation)
    : null;
  return {
    review_id: resultOnlyIdentity
      ? `review:${sha256(stableStringify({
        version: "result-only-review-v1",
        sourceMatchId: resultOnlyIdentity.sourceMatchId,
        eventVersion: resultOnlyIdentity.eventVersion,
        resultIdentity: resultOnlyIdentity.resultIdentity,
      }))}`
      : `review:${sha256(`${match.id}|${review.generatedAt}`)}`,
    match_id: text(match.id || match.sourceMatchId),
    decision_id: recommendation?.decision_id || null,
    observation_id: observation.observation_id,
    settlement,
    formal_hit: formalHit,
    review_reason: reviewText(review.modelDiagnosis, "赛果已归档，未发现可计入正式统计的赛前决策。"),
    adjustment: reviewText(review.nextAdjustment, "保留为后续滚动校准样本，不对已生成内容回写。"),
    settled_at: iso(review?.settlement?.settledAt || review.generatedAt),
    payload: JSON.stringify(review),
    _result_only_identity: resultOnlyIdentity,
  };
};

const reviewBusinessKey = (review) => `${text(review?.match_id)}\u0000${text(review?.decision_id)}`;

const reviewGeneratedAtMs = (review) => {
  const payload = jsonObject(review?.payload, null);
  const parsed = Date.parse(payload?.generatedAt || review?.settled_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const dedupeSemanticReviews = (reviews) => {
  const selected = new Map();
  for (const review of reviews) {
    const key = reviewBusinessKey(review);
    const prior = selected.get(key);
    if (!prior || reviewGeneratedAtMs(review) >= reviewGeneratedAtMs(prior)) selected.set(key, review);
  }
  return [...selected.values()];
};

const resultOnlyAliasIds = (sourceMatchId, keeperMatchId) => [...new Set([
  text(keeperMatchId),
  text(sourceMatchId),
  `sporttery_${sourceMatchId}`,
  `fivehundred_${sourceMatchId}`,
  `sporttery:${sourceMatchId}`,
  `fivehundred:${sourceMatchId}`,
  `sporttery-${sourceMatchId}`,
  `fivehundred-${sourceMatchId}`,
].filter(Boolean))];

const buildResultOnlyReviewCleanupCandidates = (reviews) => {
  const bySource = new Map();
  for (const review of reviews) {
    const identity = review?._result_only_identity;
    if (
      review?.decision_id
      || review?.formal_hit !== null
      || review?.settlement !== "result-only"
      || !identity?.sourceMatchId
      || !identity?.eventVersion
      || !identity?.resultIdentity
      || !identity?.observedAt
      || !identity?.settledAt
    ) continue;
    if (!bySource.has(identity.sourceMatchId)) bySource.set(identity.sourceMatchId, []);
    bySource.get(identity.sourceMatchId).push(review);
  }

  const candidates = new Map();
  const ambiguous = new Set();
  for (const [sourceMatchId, rows] of bySource) {
    // A provider id that maps to more than one active keeper is ambiguous
    // (for example a rescheduled/reused id). Leave every prior row untouched.
    if (rows.length !== 1) continue;
    const keeper = rows[0];
    const identity = keeper._result_only_identity;
    for (const candidateMatchId of resultOnlyAliasIds(sourceMatchId, keeper.match_id)) {
      const prior = candidates.get(candidateMatchId);
      if (prior && prior.keeper_review_id !== keeper.review_id) {
        ambiguous.add(candidateMatchId);
        continue;
      }
      candidates.set(candidateMatchId, {
        candidate_match_id: candidateMatchId,
        keeper_review_id: keeper.review_id,
        keeper_match_id: keeper.match_id,
        keeper_observation_id: keeper.observation_id,
        source_match_id: sourceMatchId,
        event_version: identity.eventVersion,
        result_identity: identity.resultIdentity,
        observed_at: identity.observedAt,
        settled_at: identity.settledAt,
      });
    }
  }
  for (const candidateMatchId of ambiguous) candidates.delete(candidateMatchId);
  return [...candidates.values()];
};

const resultOnlyIdentityFromStoredRows = (reviewRow, observationRow = reviewRow) => {
  const reviewPayload = jsonObject(reviewRow?.review_payload ?? reviewRow?.payload, null);
  const observationPayload = jsonObject(
    observationRow?.observation_payload ?? observationRow?.payload,
    null,
  );
  const sourceMatchId = canonicalSourceMatchId(
    reviewPayload?.sourceMatchId
    || observationPayload?.resultProvenance?.sourceMatchId
    || reviewRow?.match_id,
  );
  const eventVersion = iso(
    reviewPayload?.eventVersion
    || observationPayload?.resultProvenance?.eventVersion,
  );
  const resultIdentity = text(observationRow?.result_identity);
  const observedAt = iso(observationRow?.observed_at);
  const settledAt = iso(reviewRow?.settled_at);
  if (
    reviewRow?.decision_id !== null
    || reviewRow?.formal_hit !== null
    || reviewRow?.settlement !== "result-only"
    || observationRow?.is_official_final !== true
    || !sourceMatchId
    || !eventVersion
    || !resultIdentity
    || !observedAt
    || !settledAt
  ) return null;
  return { sourceMatchId, eventVersion, resultIdentity, observedAt, settledAt };
};

const sameResultOnlyIdentity = (left, right) => Boolean(left) && Boolean(right)
  && left.sourceMatchId === right.sourceMatchId
  && left.eventVersion === right.eventVersion
  && left.resultIdentity === right.resultIdentity
  && left.observedAt === right.observedAt
  && left.settledAt === right.settledAt;

const sameStableResultOnlyIdentity = (left, right) => Boolean(left) && Boolean(right)
  && left.sourceMatchId === right.sourceMatchId
  && left.eventVersion === right.eventVersion
  && left.resultIdentity === right.resultIdentity;

const isMonotonicResultOnlyClockRefresh = (existing, incoming) => {
  if (!sameStableResultOnlyIdentity(existing, incoming)) return false;
  const existingObservedAt = Date.parse(existing.observedAt || "");
  const incomingObservedAt = Date.parse(incoming.observedAt || "");
  const existingSettledAt = Date.parse(existing.settledAt || "");
  const incomingSettledAt = Date.parse(incoming.settledAt || "");
  return Number.isFinite(existingObservedAt)
    && Number.isFinite(incomingObservedAt)
    && Number.isFinite(existingSettledAt)
    && Number.isFinite(incomingSettledAt)
    && incomingObservedAt >= existingObservedAt
    && incomingSettledAt >= existingSettledAt;
};

const isForwardCanonicalResultOnlyRebase = (existingMatchId, incomingMatchId, sourceMatchId) => {
  const existing = text(existingMatchId).toLowerCase();
  const incoming = text(incomingMatchId).toLowerCase();
  if (!existing || !incoming) return false;
  if (existing === incoming) return true;
  if (incoming !== `sporttery_${sourceMatchId}`) return false;
  return resultOnlyAliasIds(sourceMatchId, incoming).includes(existing);
};

const inspectResultOnlyReviewConflicts = async (client, reviews) => {
  const incomingById = new Map();
  for (const review of reviews) {
    const prior = incomingById.get(review.review_id);
    if (prior && (
      prior.match_id !== review.match_id
      || prior.observation_id !== review.observation_id
      || !sameResultOnlyIdentity(prior._result_only_identity, review._result_only_identity)
    )) {
      const error = new Error("Ambiguous result-only reviews share one stable review id");
      error.code = "POSTGRES_RESULT_ONLY_REVIEW_INPUT_AMBIGUOUS";
      error.reviewId = review.review_id;
      throw error;
    }
    incomingById.set(review.review_id, review);
  }
  const ids = [...incomingById.keys()];
  if (ids.length === 0) return { rebasedReviews: 0, staleObservationIds: [] };
  const existingRows = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const result = await client.query(`
      SELECT existing_review.review_id,
             existing_review.match_id,
             existing_review.decision_id,
             existing_review.observation_id,
             existing_review.settlement,
             existing_review.formal_hit,
             existing_review.settled_at,
             existing_review.payload::text AS review_payload,
             existing_observation.result_identity,
             existing_observation.observed_at,
             existing_observation.is_official_final,
             existing_observation.payload::text AS observation_payload
      FROM football.post_match_reviews AS existing_review
      LEFT JOIN football.result_observations AS existing_observation
        ON existing_observation.observation_id = existing_review.observation_id
      WHERE existing_review.review_id = ANY($1::text[])
      FOR UPDATE OF existing_review
    `, [batch]);
    existingRows.push(...result.rows);
  }

  let rebasedReviews = 0;
  const staleObservationIds = new Set();
  for (const existing of existingRows) {
    const incoming = incomingById.get(existing.review_id);
    const existingIdentity = resultOnlyIdentityFromStoredRows(existing);
    const incomingIdentity = incoming?._result_only_identity;
    const sameMatch = existing.match_id === incoming?.match_id;
    const sameObservation = existing.observation_id === incoming?.observation_id;
    const safeObservationBinding = !sameMatch || sameObservation;
    const safe = Boolean(incoming)
      && incoming.decision_id === null
      && incoming.formal_hit === null
      && incoming.settlement === "result-only"
      && safeObservationBinding
      && (
        sameResultOnlyIdentity(existingIdentity, incomingIdentity)
        // The official archive can refresh ingestion clocks for the exact same
        // result object. Keep that exception narrower than alias rebasing:
        // provider changes still require the complete five-field identity.
        || (
          sameMatch
          && sameObservation
          && isMonotonicResultOnlyClockRefresh(existingIdentity, incomingIdentity)
        )
      )
      && isForwardCanonicalResultOnlyRebase(
        existing.match_id,
        incoming.match_id,
        incomingIdentity.sourceMatchId,
      );
    if (!safe) {
      const error = new Error("Existing stable review id is not a safe result-only canonical rebase");
      error.code = "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE";
      error.reviewId = existing.review_id;
      error.existingMatchId = existing.match_id;
      error.incomingMatchId = incoming?.match_id || null;
      error.existingObservationId = existing.observation_id || null;
      error.incomingObservationId = incoming?.observation_id || null;
      error.existingIdentity = existingIdentity;
      error.incomingIdentity = incomingIdentity || null;
      throw error;
    }
    if (existing.match_id !== incoming.match_id) rebasedReviews += 1;
    if (existing.observation_id && existing.observation_id !== incoming.observation_id) {
      staleObservationIds.add(existing.observation_id);
    }
  }
  return { rebasedReviews, staleObservationIds: [...staleObservationIds] };
};

const upsertResultOnlyReviews = async (client, reviews, columns) => {
  if (reviews.some((review) => (
    review.decision_id !== null
    || review.formal_hit !== null
    || review.settlement !== "result-only"
    || !review._result_only_identity
  ))) {
    const error = new Error("Result-only review upsert received a formal, locked, or unbound row");
    error.code = "POSTGRES_RESULT_ONLY_REVIEW_INPUT_UNSAFE";
    throw error;
  }
  const conflictState = await inspectResultOnlyReviewConflicts(client, reviews);
  await insertBatches({
    client,
    table: "post_match_reviews",
    columns,
    jsonColumns: ["payload"],
    rows: reviews,
    requireAffectedRows: true,
    conflict: `ON CONFLICT (review_id) DO UPDATE SET
      match_id = EXCLUDED.match_id,
      observation_id = EXCLUDED.observation_id,
      settlement = EXCLUDED.settlement,
      formal_hit = EXCLUDED.formal_hit,
      review_reason = EXCLUDED.review_reason,
      adjustment = EXCLUDED.adjustment,
      settled_at = EXCLUDED.settled_at,
      payload = EXCLUDED.payload
    WHERE football.post_match_reviews.decision_id IS NULL
      AND football.post_match_reviews.formal_hit IS NULL
      AND football.post_match_reviews.settlement = 'result-only'
      AND EXCLUDED.decision_id IS NULL
      AND EXCLUDED.formal_hit IS NULL
      AND EXCLUDED.settlement = 'result-only'
      AND EXCLUDED.settled_at >= football.post_match_reviews.settled_at
    RETURNING review_id`,
  });
  return conflictState;
};

const pruneStaleResultOnlyReviews = async (client, reviews, preexistingObservationIds = []) => {
  const candidates = buildResultOnlyReviewCleanupCandidates(reviews);
  let deletedReviewCount = 0;
  const deletedObservationIds = new Set(
    preexistingObservationIds.map((value) => text(value)).filter(Boolean),
  );
  if (candidates.length > 0) {
    const temp = `active_result_only_reviews_${crypto.randomBytes(5).toString("hex")}`;
    await client.query(`
      CREATE TEMP TABLE ${temp} (
        candidate_match_id text PRIMARY KEY,
        keeper_review_id text NOT NULL,
        keeper_match_id text NOT NULL,
        keeper_observation_id text NOT NULL,
        source_match_id text NOT NULL,
        event_version text NOT NULL,
        result_identity text NOT NULL,
        observed_at timestamptz NOT NULL,
        settled_at timestamptz NOT NULL
      ) ON COMMIT DROP
    `);
    const columns = [
      "candidate_match_id", "keeper_review_id", "keeper_match_id", "keeper_observation_id",
      "source_match_id", "event_version", "result_identity", "observed_at", "settled_at",
    ];
    for (let offset = 0; offset < candidates.length; offset += 200) {
      const batch = candidates.slice(offset, offset + 200);
      const values = batch.flatMap((row) => columns.map((column) => row[column]));
      let parameter = 0;
      await client.query(`
        INSERT INTO ${temp} (${columns.join(",")})
        VALUES ${batch.map(() => `(${columns.map(() => `$${++parameter}`).join(",")})`).join(",")}
        ON CONFLICT (candidate_match_id) DO NOTHING
      `, values);
    }
    await client.query(`ANALYZE ${temp}`);

    // Bound every DELETE to a small set of match ids. post_match_reviews has a
    // (match_id, decision_id) index whose match_id prefix keeps each statement
    // selective even when a long-lived production table contains many legacy
    // generatedAt review ids for one event.
    for (let offset = 0; offset < candidates.length; offset += 200) {
      const candidateMatchIds = candidates
        .slice(offset, offset + 200)
        .map((row) => row.candidate_match_id);
      const deleted = await client.query(`
        WITH deleted AS (
          DELETE FROM football.post_match_reviews AS stale
          USING ${temp} AS active,
                football.result_observations AS stale_observation,
                football.post_match_reviews AS keeper,
                football.result_observations AS keeper_observation
          WHERE active.candidate_match_id = ANY($1::text[])
            AND stale.match_id = active.candidate_match_id
            AND stale.match_id = ANY($1::text[])
            AND stale.review_id <> active.keeper_review_id
            AND stale.decision_id IS NULL
            AND stale.formal_hit IS NULL
            AND stale.settlement = 'result-only'
            AND stale.observation_id = stale_observation.observation_id
            AND stale_observation.is_official_final IS TRUE
            AND keeper.review_id = active.keeper_review_id
            AND keeper.match_id = active.keeper_match_id
            AND keeper.decision_id IS NULL
            AND keeper.formal_hit IS NULL
            AND keeper.settlement = 'result-only'
            AND keeper.observation_id = keeper_observation.observation_id
            AND keeper_observation.observation_id = active.keeper_observation_id
            AND keeper_observation.is_official_final IS TRUE
            AND stale_observation.result_identity = active.result_identity
            AND keeper_observation.result_identity = active.result_identity
            AND stale_observation.observed_at = active.observed_at
            AND keeper_observation.observed_at = active.observed_at
            AND stale.settled_at = active.settled_at
            AND keeper.settled_at = active.settled_at
            AND regexp_replace(
              lower(COALESCE(NULLIF(stale.payload->>'sourceMatchId', ''), stale.match_id)),
              '^(sporttery|fivehundred)[_:-]',
              ''
            ) = active.source_match_id
            AND regexp_replace(
              lower(COALESCE(
                NULLIF(stale_observation.payload->'resultProvenance'->>'sourceMatchId', ''),
                stale.match_id
              )),
              '^(sporttery|fivehundred)[_:-]',
              ''
            ) = active.source_match_id
            AND COALESCE(
              NULLIF(stale.payload->>'eventVersion', ''),
              NULLIF(stale_observation.payload->'resultProvenance'->>'eventVersion', '')
            ) = active.event_version
            AND COALESCE(
              NULLIF(keeper.payload->>'eventVersion', ''),
              NULLIF(keeper_observation.payload->'resultProvenance'->>'eventVersion', '')
            ) = active.event_version
          RETURNING stale.observation_id
        )
        SELECT observation_id, COUNT(*)::integer AS deleted_review_count
        FROM deleted
        GROUP BY observation_id
      `, [candidateMatchIds]);
      for (const row of deleted.rows || []) {
        deletedReviewCount += Number(row.deleted_review_count) || 0;
        const observationId = text(row.observation_id);
        if (observationId) deletedObservationIds.add(observationId);
      }
    }
  }
  const staleObservationIds = [...deletedObservationIds];
  if (staleObservationIds.length === 0) {
    return { reviews: deletedReviewCount, observations: 0 };
  }
  const keeperObservationIds = [...new Set(
    candidates.map((row) => row.keeper_observation_id).filter(Boolean),
  )];
  const deletedObservations = await client.query(`
    DELETE FROM football.result_observations AS stale_observation
    WHERE stale_observation.observation_id = ANY($1::text[])
      AND NOT (stale_observation.observation_id = ANY($2::text[]))
      AND NOT EXISTS (
        SELECT 1
        FROM football.post_match_reviews AS remaining_review
        WHERE remaining_review.observation_id = stale_observation.observation_id
      )
    RETURNING stale_observation.observation_id
  `, [staleObservationIds, keeperObservationIds]);
  return {
    reviews: deletedReviewCount,
    observations: deletedObservations.rowCount || 0,
  };
};

const archiveParityCorrection = (recommendation) => {
  const payload = jsonObject(recommendation?.payload, null);
  const correction = payload?.archivedPreMatchPrediction?.recoveryEvidence;
  const parityRepair = correction?.version === "published-direction-archive-parity-v1"
    && correction?.reason === "archived-direction-diverged-from-user-visible-published-direction";
  const signedRecoveryRepair = correction?.version === "archived-pre-match-recovery-v1"
    && correction?.source === "signed-release-pre-cutoff-snapshot-recovery"
    && correction?.reason === "archived-direction-diverged-from-user-visible-published-direction"
    && /^[a-f0-9]{64}$/.test(text(correction?.integritySha256));
  if (!parityRepair && !signedRecoveryRepair) return null;
  const previousMarket = text(correction?.previous?.market).toUpperCase();
  const previousDirection = text(correction?.previous?.direction).toUpperCase();
  const canonicalMarket = text(correction?.canonical?.market).toUpperCase();
  const canonicalDirection = text(correction?.canonical?.direction).toUpperCase();
  if (
    !["HAD", "HHAD"].includes(previousMarket)
    || !["1", "X", "2"].includes(previousDirection)
    || canonicalMarket !== text(recommendation?.market).toUpperCase()
    || canonicalDirection !== text(recommendation?.direction).toUpperCase()
    || (previousMarket === canonicalMarket && previousDirection === canonicalDirection)
  ) return null;
  return {
    previousMarket,
    previousDirection,
    canonicalMarket,
    canonicalDirection,
  };
};

const removeUnreferencedFrozenRecommendationDuplicates = async (
  client,
  matchId,
  keeperDecisionId,
) => {
  const result = await client.query(`
    DELETE FROM football.frozen_recommendations AS duplicate
    WHERE duplicate.match_id = $1
      AND duplicate.decision_id <> $2
      AND NOT EXISTS (
        SELECT 1
        FROM football.post_match_reviews AS attached_review
        JOIN football.frozen_recommendations AS attached_duplicate
          ON attached_duplicate.decision_id = attached_review.decision_id
        WHERE attached_duplicate.match_id = $1
          AND attached_duplicate.decision_id <> $2
      )
  `, [matchId, keeperDecisionId]);
  return result.rowCount;
};

const repairFrozenRecommendationParity = async (client, recommendations) => {
  const corrections = recommendations
    .map((recommendation) => ({ recommendation, correction: archiveParityCorrection(recommendation) }))
    .filter((row) => Boolean(row.correction));
  if (corrections.length === 0) return 0;

  const matchIds = [...new Set(corrections.map((row) => row.recommendation.match_id))];
  const existing = await client.query(`
    SELECT decision_id, match_id, market, direction, decision_hash
    FROM football.frozen_recommendations
    WHERE match_id = ANY($1::text[])
    ORDER BY match_id, frozen_at DESC, decision_id
  `, [matchIds]);
  const byMatch = new Map();
  for (const row of existing.rows) {
    if (!byMatch.has(row.match_id)) byMatch.set(row.match_id, []);
    byMatch.get(row.match_id).push(row);
  }

  let corrected = 0;
  for (const { recommendation, correction } of corrections) {
    const rows = byMatch.get(recommendation.match_id) || [];
    const target = rows.filter((row) => (
      text(row.market).toUpperCase() === correction.previousMarket
      && text(row.direction).toUpperCase() === correction.previousDirection
    ));
    const alreadyCorrected = rows.find((row) => row.decision_hash === recommendation.decision_hash);
    if (alreadyCorrected) {
      recommendation.decision_id = alreadyCorrected.decision_id;
      corrected += await removeUnreferencedFrozenRecommendationDuplicates(
        client,
        recommendation.match_id,
        alreadyCorrected.decision_id,
      );
      continue;
    }
    // A correction may mutate exactly one previously frozen semantic row and
    // keeps its decision_id stable so settled review foreign keys remain
    // attached. Ambiguous/multiple prior rows fail closed and are not changed.
    if (target.length !== 1) continue;
    const prior = target[0];
    const result = await client.query(`
      UPDATE football.frozen_recommendations
      SET publication_id = $1,
          track = $2,
          market = $3,
          direction = $4,
          odds = $5,
          evidence_score = $6,
          frozen_at = $7,
          cutoff_at = $8,
          decision_hash = $9,
          payload = $10::json
      WHERE decision_id = $11
        AND match_id = $12
        AND market = $13
        AND direction = $14
        AND decision_hash = $15
    `, [
      recommendation.publication_id,
      recommendation.track,
      recommendation.market,
      recommendation.direction,
      recommendation.odds,
      recommendation.evidence_score,
      recommendation.frozen_at,
      recommendation.cutoff_at,
      recommendation.decision_hash,
      recommendation.payload,
      prior.decision_id,
      recommendation.match_id,
      prior.market,
      prior.direction,
      prior.decision_hash,
    ]);
    if (result.rowCount !== 1) continue;
    recommendation.decision_id = prior.decision_id;
    corrected += 1;
    corrected += await removeUnreferencedFrozenRecommendationDuplicates(
      client,
      recommendation.match_id,
      prior.decision_id,
    );
  }
  return corrected;
};

const persistSemanticRows = async (client, matches, publicationId) => {
  let recommendations = [];
  const observations = [];
  let reviews = [];
  let resultOnlyConflictState = { rebasedReviews: 0, staleObservationIds: [] };
  for (const row of matches) {
    const match = jsonObject(row.payload, null);
    if (!match) continue;
    const recommendation = recommendationFromMatch(match);
    const observation = observationFromMatch(match);
    const review = reviewFromMatch(match, recommendation, observation);
    if (recommendation) recommendations.push({ ...recommendation, publication_id: publicationId });
    if (observation) observations.push(observation);
    if (review) reviews.push(review);
  }
  recommendations = [...new Map(recommendations.map((row) => [row.decision_hash, row])).values()];
  const correctedFrozenRecommendations = await repairFrozenRecommendationParity(
    client,
    recommendations,
  );
  if (recommendations.length > 0) {
    const existing = await client.query(`
      SELECT decision_hash, decision_id
      FROM football.frozen_recommendations
      WHERE decision_hash = ANY($1::text[])
    `, [recommendations.map((row) => row.decision_hash)]);
    const existingIds = new Map(existing.rows.map((row) => [row.decision_hash, row.decision_id]));
    for (const recommendation of recommendations) {
      recommendation.decision_id = existingIds.get(recommendation.decision_hash) || recommendation.decision_id;
    }
    for (const review of reviews) {
      const recommendation = recommendations.find((row) => row.match_id === review.match_id);
      if (recommendation) review.decision_id = recommendation.decision_id;
    }
  }
  reviews = dedupeSemanticReviews(reviews);
  if (recommendations.length > 0) {
    await insertBatches({
      client,
      table: "frozen_recommendations",
      columns: [
        "decision_id", "match_id", "publication_id", "track", "market", "direction",
        "odds", "evidence_score", "frozen_at", "cutoff_at", "decision_hash", "payload",
      ],
      jsonColumns: ["payload"],
      rows: recommendations,
      conflict: `ON CONFLICT (decision_hash) DO UPDATE SET
        publication_id = EXCLUDED.publication_id,
        payload = EXCLUDED.payload`,
    });
  }
  if (observations.length > 0) {
    await insertBatches({
      client,
      table: "result_observations",
      columns: ["observation_id", "match_id", "result_identity", "observed_at", "is_official_final", "payload"],
      jsonColumns: ["payload"],
      rows: observations,
      conflict: `ON CONFLICT (observation_id) DO UPDATE SET
        observed_at = GREATEST(football.result_observations.observed_at, EXCLUDED.observed_at),
        is_official_final = football.result_observations.is_official_final OR EXCLUDED.is_official_final,
        payload = EXCLUDED.payload`,
    });
  }
  if (reviews.length > 0) {
    const columns = [
      "review_id", "match_id", "decision_id", "observation_id", "settlement", "formal_hit",
      "review_reason", "adjustment", "settled_at", "payload",
    ];
    const reviewsWithDecision = reviews.filter((review) => Boolean(review.decision_id));
    const reviewsWithoutDecision = reviews.filter((review) => !review.decision_id);
    const resultOnlyReviews = reviewsWithoutDecision.filter((review) => (
      review.formal_hit === null
      && review.settlement === "result-only"
      && Boolean(review._result_only_identity)
    ));
    const otherReviewsWithoutDecision = reviewsWithoutDecision.filter((review) => (
      !resultOnlyReviews.includes(review)
    ));
    if (reviewsWithDecision.length > 0) {
      await insertBatches({
        client,
        table: "post_match_reviews",
        columns,
        jsonColumns: ["payload"],
        rows: reviewsWithDecision,
        conflict: `ON CONFLICT (match_id, decision_id) DO UPDATE SET
        review_id = EXCLUDED.review_id,
        observation_id = EXCLUDED.observation_id,
        settlement = EXCLUDED.settlement,
        formal_hit = EXCLUDED.formal_hit,
        review_reason = EXCLUDED.review_reason,
        adjustment = EXCLUDED.adjustment,
        settled_at = EXCLUDED.settled_at,
        payload = EXCLUDED.payload`,
      });
    }
    if (resultOnlyReviews.length > 0) {
      resultOnlyConflictState = await upsertResultOnlyReviews(client, resultOnlyReviews, columns);
    }
    if (otherReviewsWithoutDecision.length > 0) {
      await insertBatches({
        client,
        table: "post_match_reviews",
        columns,
        jsonColumns: ["payload"],
        rows: otherReviewsWithoutDecision,
        conflict: `ON CONFLICT (review_id) DO UPDATE SET
        observation_id = EXCLUDED.observation_id,
        settlement = EXCLUDED.settlement,
        formal_hit = EXCLUDED.formal_hit,
        review_reason = EXCLUDED.review_reason,
        adjustment = EXCLUDED.adjustment,
        settled_at = EXCLUDED.settled_at,
        payload = EXCLUDED.payload`,
      });
    }
  }
  const prunedStaleResultOnly = await pruneStaleResultOnlyReviews(
    client,
    reviews,
    resultOnlyConflictState.staleObservationIds,
  );
  await client.query("DELETE FROM football.formal_review_daily");
  await client.query(`
    INSERT INTO football.formal_review_daily (business_date, won, lost, source_revision, computed_at)
    SELECT
      (settled_at AT TIME ZONE 'Asia/Shanghai')::date,
      COUNT(*) FILTER (WHERE formal_hit IS TRUE)::integer,
      COUNT(*) FILTER (WHERE formal_hit IS FALSE)::integer,
      $1,
      now()
    FROM football.post_match_reviews
    WHERE formal_hit IS NOT NULL
    GROUP BY (settled_at AT TIME ZONE 'Asia/Shanghai')::date
  `, [publicationId]);
  return {
    frozenRecommendations: recommendations.length,
    correctedFrozenRecommendations,
    resultObservations: observations.length,
    postMatchReviews: reviews.length,
    rebasedStaleResultOnlyReviews: resultOnlyConflictState.rebasedReviews,
    prunedStaleResultOnlyReviews: prunedStaleResultOnly.reviews,
    prunedStaleResultObservations: prunedStaleResultOnly.observations,
  };
};

const loadAiArena = (aiArenaPath) => {
  try {
    return jsonObject(fs.readFileSync(aiArenaPath, "utf8"), null);
  } catch {
    return null;
  }
};

const deactivateMissingAiCompetitors = async (client, competitorIds) => {
  const activeIds = [...new Set(
    (Array.isArray(competitorIds) ? competitorIds : [])
      .map((value) => text(value))
      .filter(Boolean),
  )];
  if (activeIds.length === 0) return 0;
  const result = await client.query(`
    UPDATE football.ai_competitors
    SET active = FALSE
    WHERE active IS TRUE
      AND NOT (competitor_id = ANY($1::text[]))
  `, [activeIds]);
  return Number(result?.rowCount || 0);
};

const persistAiArena = async (client, arena) => {
  if (!arena) return { competitors: 0, decisions: 0, ledgerEntries: 0 };
  const agents = Array.isArray(arena.agents) ? arena.agents : [];
  const competitionId = text(arena.monthKey || arena.weekStart || arena.generatedAt || "current");
  const competitors = agents.map((agent) => ({
    competitor_id: text(agent.id),
    display_name: text(agent.name || agent.id),
    strategy_version: text(agent.model || arena.version || "unknown"),
    active: text(agent.status).toUpperCase() !== "INACTIVE",
  })).filter((row) => row.competitor_id);
  const deactivatedCompetitors = await deactivateMissingAiCompetitors(
    client,
    competitors.map((row) => row.competitor_id),
  );
  if (competitors.length > 0) {
    await insertBatches({
      client,
      table: "ai_competitors",
      columns: ["competitor_id", "display_name", "strategy_version", "active"],
      rows: competitors,
      conflict: `ON CONFLICT (competitor_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        strategy_version = EXCLUDED.strategy_version,
        active = EXCLUDED.active`,
    });
  }
  const decisions = [];
  for (const agent of agents) {
    for (const forecast of Array.isArray(agent.forecasts) ? agent.forecasts : []) {
      const matchId = text(forecast.matchId || forecast.id || forecast.sourceMatchId);
      if (!matchId) continue;
      const stake = Math.max(0, Math.trunc(finite(forecast.stake ?? forecast.points) || 0));
      const rawRisk = text(forecast.riskTier).toLowerCase();
      const riskTier = stake === 0 ? "skip" : ["low", "medium", "high"].includes(rawRisk) ? rawRisk : "medium";
      const { decidedAt, lockedAt } = normalizeAiDecisionTimestamps({ forecast, agent, arena });
      const direction = text(forecast.direction || forecast.tipCode || forecast.selection || "SKIP");
      const decisionHash = sha256(stableStringify({ competitionId, agent: agent.id, matchId, forecast }));
      decisions.push({
        decision_id: `ai:${decisionHash}`,
        competition_id: competitionId,
        competitor_id: text(agent.id),
        match_id: matchId,
        direction,
        confidence: Math.min(1, Math.max(0, finite(forecast.confidence ?? forecast.probability) || 0)),
        stake,
        risk_tier: riskTier,
        decision_hash: decisionHash,
        decided_at: decidedAt,
        locked_at: lockedAt,
        payload: JSON.stringify(forecast),
      });
    }
  }
  if (decisions.length > 0) {
    await insertBatches({
      client,
      table: "ai_decisions",
      columns: [
        "decision_id", "competition_id", "competitor_id", "match_id", "direction", "confidence",
        "stake", "risk_tier", "decision_hash", "decided_at", "locked_at", "payload",
      ],
      jsonColumns: ["payload"],
      rows: decisions,
      conflict: "ON CONFLICT (decision_id) DO NOTHING",
    });
  }
  const ledger = competitors.map((competitor) => {
    const agent = agents.find((row) => text(row.id) === competitor.competitor_id) || {};
    const openingBalance = Math.max(0, Math.trunc(finite(agent.startingBalance) || 0));
    return {
      entry_id: `opening:${competitionId}:${competitor.competitor_id}`,
      competition_id: competitionId,
      competitor_id: competitor.competitor_id,
      decision_id: null,
      idempotency_key: `opening:${competitionId}:${competitor.competitor_id}`,
      delta: openingBalance,
      balance_after: openingBalance,
      reason: "competition-opening-balance",
      payload: JSON.stringify({ generatedAt: arena.generatedAt || null, source: arena.version || null }),
    };
  });
  if (ledger.length > 0) {
    await insertBatches({
      client,
      table: "ai_score_ledger",
      columns: [
        "entry_id", "competition_id", "competitor_id", "decision_id", "idempotency_key",
        "delta", "balance_after", "reason", "payload",
      ],
      jsonColumns: ["payload"],
      rows: ledger,
      conflict: "ON CONFLICT (entry_id) DO NOTHING",
    });
  }
  return {
    competitors: competitors.length,
    deactivatedCompetitors,
    decisions: decisions.length,
    ledgerEntries: ledger.length,
  };
};

const createSqliteProjectionSource = (options = {}) => {
  const dbPath = path.resolve(options.dbPath || process.env.DATASTORE_SQLITE_PATH || path.join(rootDir, "server-data", "football.db"));
  const { DatabaseSync } = require("node:sqlite");
  const stat = fs.statSync(dbPath), db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const table of ["schema_meta", "source_snapshots", "match_snapshots", "odds_snapshots", "prediction_snapshots"])
      if (!tableExists(db, table)) throw new Error(`SQLite source table missing: ${table}`);
    db.exec("BEGIN");
    const meta = readMeta(db), publication = publicationFromMeta(meta);
    const tableRows = (table, { full = true, cutoff = null } = {}) => {
      if (table === "match_snapshots") return iterateMatchSnapshotRows(db);
      if (!["source_snapshots", "odds_snapshots", "prediction_snapshots", "private_model_artifacts"].includes(table))
        throw new Error("unsupported projection source table");
      const where = full || table === "private_model_artifacts" ? "" : table === "source_snapshots"
        ? "WHERE captured_at >= ? OR id = 'public-reference-decisions:current' OR source = 'sporttery:public-reference-index'"
        : "WHERE COALESCE(last_seen_at, captured_at) >= ?";
      const statement = db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${table === "private_model_artifacts" ? "artifact_key" : "id"}`);
      return where ? statement.iterate(cutoff) : statement.iterate();
    };
    return { kind: "sqlite", path: dbPath, bytes: stat.size, meta, publication,
      fingerprint: sourceFingerprint(dbPath, stat, publication, meta),
      tableRows, activeIds: table => activeIdsFromTable(db, table),
      hasPrivateAudit: () => tableExists(db, "private_model_artifacts"),
      assertUnchanged() {},
      close() { try { db.exec("ROLLBACK"); } finally { db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
};

// Backend-independent transactional projector. Native generation sources must
// provide complete inventories and an unchanged-source check; no SQLite shim.
const syncPostgresProjectionFromSource = async (source, options = {}) => {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  if (!source || !["sqlite", "native-generation"].includes(source.kind)
    || typeof source.path !== "string" || !/^[a-f0-9]{64}$/.test(source.fingerprint || "")
    || !["tableRows", "activeIds", "hasPrivateAudit", "assertUnchanged", "close"].every(key => typeof source[key] === "function"))
    throw new Error("invalid complete PostgreSQL projection source");
  const dbPath = source.path;
  const mode = MODE_VALUES.has(options.mode) ? options.mode : "incremental";
  const aiArenaPath = path.resolve(
    options.aiArenaPath
    || process.env.AI_ARENA_PATH
    || path.join(rootDir, "public", "data", "ai-arena.json"),
  );
  let pool;
  const ownsPool = !options.pool;
  try {
    const { meta, publication, fingerprint } = source;
    assertPublicationIdentity(publication);
    if (stableStringify(publicationFromMeta(meta)) !== stableStringify(publication))
      throw new Error("projection source metadata and publication identity disagree");
    source.assertUnchanged();
    pool = options.pool || createPostgresPool({ applicationName: `football-projection-${mode}` });
    const arena = loadAiArena(aiArenaPath);
    await runPostgresMigrations(pool);

    const result = await withPostgresTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-postgres-projection-sync-v1"]);
      const existing = await client.query(`
        SELECT run_id, source_fingerprint
        FROM football.projection_runs
        ORDER BY committed_at DESC, run_id DESC
        LIMIT 1
      `);
      if (existing.rows[0]?.source_fingerprint === fingerprint && mode !== "backfill" && options.force !== true) {
        source.assertUnchanged();
        return {
          ok: true,
          skipped: true,
          reason: "source-fingerprint-unchanged",
          publication,
          sourceFingerprint: fingerprint,
          previousRunId: existing.rows[0].run_id,
          rowCounts: {},
          tableHashes: {},
        };
      }

      const publicationId = await upsertPublication(client, publication, meta);
      const rowCounts = { projectionMeta: await upsertProjectionMeta(client, meta) };
      const tableHashes = {};
      const allMatchRows = [];

      const syncTable = async ({ table, iterator, mapper, columns, conflict, jsonColumns = ["payload"], prune = false, pruneWhere = "", collectRows = false }) => {
        const streamed = await streamIteratorInsert({
          client,
          table,
          columns,
          iterator,
          mapper,
          conflict,
          jsonColumns,
          collectRows,
        });
        rowCounts[table] = streamed.written;
        tableHashes[table] = streamed.hash;
        if (prune) await pruneWithActiveIds(client, table, streamed.activeIds, pruneWhere);
        return streamed.rows;
      };

      const matches = await syncTable({
        table: "match_snapshots",
        iterator: source.tableRows("match_snapshots"),
        mapper: toMatchRow,
        columns: ["id", "dataset", "match_id", "source_match_id", "kickoff_time", "status", "payload"],
        conflict: snapshotUpsertConflict("match_snapshots"),
        prune: true,
        pruneWhere: "target.dataset IN ('current','history')",
        collectRows: true,
      });
      allMatchRows.push(...matches.filter((row) => ["current", "history"].includes(row.dataset)));

      if (mode !== "fast-result") {
        const latestRun = await client.query(`
          SELECT committed_at FROM football.projection_runs
          ORDER BY committed_at DESC, run_id DESC LIMIT 1
        `);
        const previousCommittedAt = latestRun.rows[0]?.committed_at;
        const incrementalCutoff = previousCommittedAt
          ? new Date(previousCommittedAt.getTime() - 6 * 60 * 60 * 1000).toISOString()
          : "1970-01-01T00:00:00.000Z";
        const full = mode === "backfill";
        // The current public-reference archive can change through retention
        // or a binding correction while all recordedAt clocks remain old.
        // Project the document and its PK lookup shards outside that window.
        const sourceRows = await streamIteratorInsert({
          client,
          table: "source_snapshots",
          columns: ["id", "source", "captured_at", "payload"],
          iterator: source.tableRows("source_snapshots", { full, cutoff: incrementalCutoff }),
          mapper: toSourceRow,
          jsonColumns: ["payload"],
          conflict: snapshotUpsertConflict("source_snapshots"),
        });
        rowCounts.source_snapshots = sourceRows.written;
        tableHashes.source_snapshots = sourceRows.hash;
        await pruneWithActiveIds(
          client,
          "source_snapshots",
          full ? sourceRows.activeIds : source.activeIds("source_snapshots"),
        );

        const oddsRows = await streamIteratorInsert({
          client,
          table: "odds_snapshots",
          columns: [
            "id", "state_key", "match_id", "source_match_id", "pool", "bookmaker", "handicap_line",
            "captured_at", "first_seen_at", "last_seen_at", "seen_count", "payload",
          ],
          iterator: source.tableRows("odds_snapshots", { full, cutoff: incrementalCutoff }),
          mapper: toOddsRow,
          jsonColumns: ["payload"],
          conflict: snapshotUpsertConflict("odds_snapshots"),
        });
        rowCounts.odds_snapshots = oddsRows.written;
        tableHashes.odds_snapshots = oddsRows.hash;
        await pruneWithActiveIds(
          client,
          "odds_snapshots",
          full ? oddsRows.activeIds : source.activeIds("odds_snapshots"),
        );

        const predictionRows = await streamIteratorInsert({
          client,
          table: "prediction_snapshots",
          columns: [
            "id", "state_key", "match_id", "source_match_id", "phase", "captured_at",
            "first_seen_at", "last_seen_at", "seen_count", "payload",
          ],
          iterator: source.tableRows("prediction_snapshots", { full, cutoff: incrementalCutoff }),
          mapper: toPredictionRow,
          jsonColumns: ["payload"],
          conflict: snapshotUpsertConflict("prediction_snapshots"),
        });
        rowCounts.prediction_snapshots = predictionRows.written;
        tableHashes.prediction_snapshots = predictionRows.hash;
        await pruneWithActiveIds(
          client,
          "prediction_snapshots",
          full ? predictionRows.activeIds : source.activeIds("prediction_snapshots"),
        );

        if (privateArtifactStorage() !== "postgres" && source.hasPrivateAudit()) {
          const artifactRows = await streamIteratorInsert({
            client,
            table: "private_model_artifacts",
            columns: [
              "artifact_key", "artifact_version", "generated_at", "updated_at",
              "payload", "payload_sha256", "payload_bytes",
            ],
            iterator: source.tableRows("private_model_artifacts"),
            mapper: (row) => ({
            artifact_key: row.artifact_key,
            artifact_version: row.artifact_version,
            generated_at: iso(row.generated_at),
            updated_at: iso(row.updated_at),
            payload: row.payload_json,
            payload_json: row.payload_json,
            payload_sha256: row.payload_sha256,
            payload_bytes: Number(row.payload_bytes),
            }),
            jsonColumns: ["payload"],
            conflict: snapshotUpsertConflict("private_model_artifacts"),
          });
          rowCounts.private_model_artifacts = artifactRows.written;
          tableHashes.private_model_artifacts = artifactRows.hash;
          if (full) await pruneWithActiveIds(
            client,
            "private_model_artifacts",
            artifactRows.activeIds,
            "",
            "artifact_key",
          );
        }
      }

      rowCounts.semantic = await persistSemanticRows(client, allMatchRows, publicationId);
      rowCounts.aiArena = await persistAiArena(client, arena);
      const runId = `pg-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      const durationMs = Math.max(0, Date.now() - startedMs);
      await client.query(`
        INSERT INTO football.projection_runs
          (run_id, mode, source_path, source_fingerprint, publication_id, row_counts,
           table_hashes, started_at, duration_ms, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)
      `, [
        runId,
        mode,
        dbPath,
        fingerprint,
        publicationId,
        JSON.stringify(rowCounts),
        JSON.stringify(tableHashes),
        startedAt,
        durationMs,
        JSON.stringify({
          sourceKind: source.kind,
          sqliteBytes: source.kind === "sqlite" ? source.bytes : 0,
          exportedAt: meta.exported_at?.value || null,
          aiArenaVersion: arena?.version || null,
          aiArenaGeneratedAt: arena?.generatedAt || null,
        }),
      ]);
      source.assertUnchanged();
      return {
        ok: true,
        skipped: false,
        runId,
        mode,
        publication,
        sourceFingerprint: fingerprint,
        rowCounts,
        tableHashes,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
      };
    }, { isolationLevel: "SERIALIZABLE" });
    return result;
  } finally {
    try { source.close(); } finally { if (ownsPool && pool) await pool.end(); }
  }
};
const syncPostgresProjectionFromSqlite = options => syncPostgresProjectionFromSource(createSqliteProjectionSource(options), options);

module.exports = {
  archiveParityCorrection,
  buildResultOnlyReviewCleanupCandidates,
  deactivateMissingAiCompetitors,
  dedupeSemanticReviews,
  inspectResultOnlyReviewConflicts,
  iterateMatchSnapshotRows,
  isForwardCanonicalResultOnlyRebase,
  normalizeAiDecisionTimestamps,
  pruneStaleResultOnlyReviews,
  repairFrozenRecommendationParity,
  resultOnlyIdentityFromStoredRows,
  resultOnlyReviewIdentity,
  reviewFromMatch,
  syncPostgresProjectionFromSqlite,
  syncPostgresProjectionFromSource,
  createSqliteProjectionSource,
  upsertResultOnlyReviews,
};
