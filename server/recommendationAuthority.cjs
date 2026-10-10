'use strict';

const { hash } = require('../src/services/leagueBaselineModel.cjs');
const { day } = require('../src/services/publishedForecastPolicy.cjs');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const { hasDirectionalEvidence, validateArchivedDecision } = require('./recommendationProjectionParity.cjs');

// Only the production port factory can select this policy. A stored/public
// strategySwitch, or a JSON copy of this object, cannot authorize retirement.
const TRAINED_ONLY_POLICY = Object.freeze({
  version: 'trained-only-publication-policy-v1',
  trainedOnly: true,
  legacyPublicationEnabled: false,
  legacyFallbackEnabled: false,
});
const VERSION = 'recommendation-publication-authority-v1';
const trustedAuthorities = new WeakSet();
const trustedAuthoritySummaries = new WeakMap();
const authorityPayloads = new WeakMap();
const retiredCurrentAuthority = Symbol('retired-current-publication-authority');
const retiredProjectionTokens = new WeakSet();
const isTrustedPolicy = value => value === TRAINED_ONLY_POLICY;
const isTrustedAuthority = value => Boolean(value && typeof value === 'object' && trustedAuthorities.has(value));
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error('RECOMMENDATION_AUTHORITY_' + code), {
    code: 'RECOMMENDATION_AUTHORITY_' + code,
    statusCode: 503,
  });
};
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const same = (left, right) => hash(left) === hash(right);
const clock = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const replayCache = new Map(), replayFlights = new Map();
const CACHE_ENTRIES = 4, CACHE_BYTES = 32 * 1024 * 1024, CAPTURE_BYTES = 64 * 1024 * 1024;
let replayCacheBytes = 0, replayWaiters = 0;

function removeReplay(key, entry) {
  if (replayCache.get(key) !== entry) return;
  replayCache.delete(key); replayCacheBytes -= entry.bytes;
}
function queryFingerprint(result) {
  check(Array.isArray(result?.rows) && result.rows.length <= 32, 'REPLAY_QUERY_BOUND');
  const { verifyRow } = require('../scripts/postgresPrivateModelArtifactStore.cjs');
  let bytes = 0;
  const rows = result.rows.map(row => {
    if (object(row) && Object.hasOwn(row, 'payload_json')) {
      // Every hit re-hashes the fresh raw bytes and verifies size and metadata.
      // A stored SHA or a prior reader's PostgreSQL snapshot is never trusted.
      const saved = verifyRow(row, row.artifact_key);
      bytes += saved.payloadBytes;
      return { key: saved.artifactKey, version: saved.artifactVersion, generatedAt: saved.generatedAt,
        updatedAt: saved.updatedAt, sha256: saved.payloadSha256, bytes: saved.payloadBytes };
    }
    const json = JSON.stringify(row); check(typeof json === 'string', 'REPLAY_QUERY_ROW');
    bytes += Buffer.byteLength(json); return row;
  });
  check(bytes <= CAPTURE_BYTES, 'REPLAY_CAPTURE_BOUND');
  return { fingerprint: hash(rows), bytes };
}
async function freshReplayMatches(client, entry, now) {
  if (now < entry.verifiedAt) return false;
  let bytes = 0;
  for (const recipe of entry.recipes) {
    const checked = queryFingerprint(await client.query(recipe.sql, recipe.args));
    bytes += checked.bytes; check(bytes <= CAPTURE_BYTES, 'REPLAY_CAPTURE_BOUND');
    if (checked.fingerprint !== recipe.fingerprint) return false;
  }
  return true;
}

async function replayPublications(client, context, validate) {
  const { center, payload, trustRegistry, now, reviewedRuntime, trainedRuntime } = context;
  // Complete trust configuration and center contents are bound, including
  // optional fields. A business-day change or backward clock forces replay.
  const key = hash([hash(payload), hash(trustRegistry), day(now)]);
  const reuse = async () => {
    const entry = replayCache.get(key);
    if (!entry) return null;
    try {
      if (await freshReplayMatches(client, entry, now)) {
        // Another snapshot can replace/evict this entry while these reads
        // await. Its accounting and newer proof must not be overwritten.
        if (replayCache.get(key) === entry) { replayCache.delete(key); replayCache.set(key, entry); }
        return { reviewed: entry.reviewed, trained: entry.trained };
      }
    } catch (error) { removeReplay(key, entry); throw error; }
    removeReplay(key, entry); return null;
  };
  const cached = await reuse(); if (cached) return cached;
  const pending = replayFlights.get(key);
  if (pending && replayWaiters < 8) {
    replayWaiters++;
    try { await pending.catch(() => {}); } finally { replayWaiters--; }
    // Followers still prove every exact query against their own read session.
    const shared = await reuse(); if (shared) return shared;
  }
  const cold = async () => {
    const recipes = new Map(); let capturedBytes = 0;
    const recordingClient = { query: async (sql, args = []) => {
      const result = await client.query(sql, args), checked = queryFingerprint(result);
      const recipeKey = JSON.stringify([sql, args]);
      const prior = recipes.get(recipeKey);
      if (prior) check(prior.fingerprint === checked.fingerprint, 'NON_REPEATABLE_READ');
      else {
        capturedBytes += checked.bytes;
        check(capturedBytes <= CAPTURE_BYTES && recipes.size < 256, 'REPLAY_CAPTURE_BOUND');
        recipes.set(recipeKey, { sql, args: JSON.parse(JSON.stringify(args)), fingerprint: checked.fingerprint });
      }
      return result;
    } };
    const publicationClient = publicationClientAsOf(recordingClient, context);
    const reviewed = await reviewedRuntime.projection(publicationClient, center.businessDate, center.updatedAt);
    const trained = await trainedRuntime.projection(publicationClient, center.businessDate, center.updatedAt, trustRegistry);
    validate(reviewed, trained);
    const entry = { reviewed, trained, recipes: [...recipes.values()], verifiedAt: now };
    entry.bytes = Buffer.byteLength(JSON.stringify(entry));
    if (entry.bytes <= CACHE_BYTES) {
      const existing = replayCache.get(key); if (existing) removeReplay(key, existing);
      while (replayCache.size >= CACHE_ENTRIES || replayCacheBytes + entry.bytes > CACHE_BYTES) {
        const [oldKey, oldEntry] = replayCache.entries().next().value;
        removeReplay(oldKey, oldEntry);
      }
      freeze(entry); replayCache.set(key, entry); replayCacheBytes += entry.bytes;
    }
    return { reviewed, trained };
  };
  const work = cold();
  // Bounded single-flight bookkeeping; excess readers perform their own safe
  // replay instead of accumulating an unbounded pending-request queue.
  const registered = !replayFlights.has(key) && replayFlights.size < 4;
  if (registered) replayFlights.set(key, work);
  try { return await work; }
  finally { if (registered && replayFlights.get(key) === work) replayFlights.delete(key); }
}

function compareReviewed(actual, expected) {
  check(object(actual), 'REVIEWED_VIEW_INVALID');
  // Verify the saved seal before accommodating the additive threeCombos field.
  // Re-sealing an attacker-controlled record is never evidence of a replay.
  if (Object.hasOwn(actual, 'contentHash')) {
    const { contentHash, ...body } = actual;
    check(typeof contentHash === 'string' && contentHash === hash(body), 'REVIEWED_VIEW_SEAL');
  } else check(Array.isArray(actual.records) && actual.records.length === 0, 'REVIEWED_VIEW_SEAL');
  let comparable = expected;
  if (!Object.hasOwn(actual, 'threeCombos')) {
    const { threeCombos, contentHash, ...body } = expected;
    void threeCombos;
    comparable = contentHash ? { ...body, contentHash: hash(body) } : body;
  }
  check(same(actual, comparable), 'REVIEWED_VIEW_REPLAY');
}

// A committed view is an as-of publication. New intake can commit before the
// worker refreshes that view; prove those newer artifacts before excluding
// them, and never treat a missing ACK on an old freeze as normal lag.
function publicationClientAsOf(client, { center, now, trustRegistry, reviewedRuntime, trainedRuntime }) {
  const { verifyRow } = require('../scripts/postgresPrivateModelArtifactStore.cjs');
  const { SELECT } = require('../scripts/leagueBaselineRegistry.cjs');
  const reviewedMaker = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
  const trainedMaker = require('../src/services/leagueBaselineRecommendation.cjs');
  const viewAt = Date.parse(center.updatedAt);
  const kindOf = sql => sql.startsWith('SELECT artifact_key FROM football.private_model_artifacts') ? 'reviewed'
    : sql.includes("artifact_key ~ '^league-forecast-") ? 'trained' : null;
  const visible = async (kind, row) => {
    const key = row.artifact_key;
    const raw = kind === 'reviewed' ? (await client.query(SELECT, [key])).rows[0] : row;
    const saved = verifyRow(raw, key), value = saved.payload, record = value.record;
    const { contentHash, ...body } = value;
    check(contentHash === hash(body), 'FREEZE_HASH');
    check(value.version === (kind === 'reviewed' ? 'reviewed-analysis-freeze-v1' : 'league-baseline-freeze-v1')
      && object(record) && value.createdAt === record.createdAt && record.businessDate === center.businessDate, 'FREEZE_ENVELOPE');
    const createdAt = clock(record.createdAt), storedAt = clock(value.storedAt);
    const createdNs = epochNanoseconds(record.createdAt), storedNs = epochNanoseconds(value.storedAt);
    check(Number.isSafeInteger(createdAt) && Number.isSafeInteger(storedAt) && createdNs !== null && storedNs !== null
      && createdNs < storedNs && storedNs <= BigInt(now) * 1000000n
      && saved.generatedAt === new Date(createdAt).toISOString()
      && saved.updatedAt === new Date(storedAt).toISOString(), 'FREEZE_STORAGE_CLOCK');
    const expectedKey = kind === 'trained' ? record.id : value.draft?.version === 3
      ? 'reviewed-analysis-' + center.businessDate + '-batch-' + hash(value.draft)
      : 'reviewed-analysis-' + center.businessDate + '-selected-two';
    check(key === expectedKey, 'FREEZE_KEY');
    const ackRows = (await client.query(SELECT, [key + '-ack'])).rows;
    check(ackRows.length <= 1, 'ACK_BOUND');
    if (ackRows.length === 0) {
      if (createdAt <= viewAt) return true; // Original runtime must reject the missing old ACK.
      const valid = kind === 'reviewed'
        ? same(reviewedMaker.make(value.draft, { ...value.inputs, trustRegistry, asOf: record.createdAt }), record)
        : trainedMaker.verify(record, { ...value.inputs, trustRegistry });
      check(valid, 'PENDING_FREEZE_REPLAY');
      return false;
    }
    const ack = verifyRow(ackRows[0], key + '-ack').payload;
    const observedNs = epochNanoseconds(kind === 'trained' ? ack.observedAt : ack.createdAt);
    check(observedNs !== null, 'ACK_CLOCK');
    if (createdNs <= BigInt(viewAt) * 1000000n && observedNs <= BigInt(viewAt) * 1000000n) return true;
    // Run the original complete freeze/ACK verifier at the actual read clock
    // before excluding a committed publication newer than the center view.
    const one = { query: async (sql, args) => kindOf(sql) === kind
      ? { rows: [kind === 'reviewed' ? { artifact_key: key } : raw] }
      : client.query(sql, args) };
    const replay = kind === 'reviewed'
      ? await reviewedRuntime.projection(one, center.businessDate, new Date(now).toISOString())
      : await trainedRuntime.projection(one, center.businessDate, new Date(now).toISOString(), trustRegistry);
    check(replay.records.length > 0 && (kind === 'reviewed' || replay.blocked === 0), 'LATER_PUBLICATION_REPLAY');
    return false;
  };
  return { query: async (sql, args) => {
    const result = await client.query(sql, args), kind = kindOf(sql);
    if (!kind) return result;
    check(Array.isArray(result.rows) && result.rows.length <= 32, 'PUBLICATION_BOUND');
    const rows = [];
    for (const row of result.rows) if (await visible(kind, row)) rows.push(row);
    return { ...result, rows };
  } };
}

/** The caller owns a repeatable-read read-only transaction. All publication
 * reads deliberately use this exact client; no secondary pool or writes. */
async function readTrustedPublicationAuthority(client, { policy, asOf } = {}) {
  if (!isTrustedPolicy(policy)) return null;
  const now = clock(asOf);
  check(Number.isSafeInteger(now) && Number.isFinite(new Date(now).getTime()), 'READ_CLOCK');
  const rows = (await client.query('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows;
  check(Array.isArray(rows) && rows.length === 1, 'CENTER_UNAVAILABLE');
  const payload = rows[0]?.payload;
  check(object(payload) && Buffer.byteLength(JSON.stringify(payload)) <= 32 * 1024 * 1024, 'CENTER_BOUND');
  const center = payload.recommendationCenter;
  check(object(center) && center.version === 'recommendation-center-v1', 'CENTER_UNAVAILABLE');
  const updated = clock(center.updatedAt);
  check(typeof center.updatedAt === 'string' && Number.isSafeInteger(updated) && updated <= now
    && center.businessDate === day(updated), 'CENTER_CLOCK');
  const currentBusinessDate = day(now), availableForCurrentDay = center.businessDate === currentBusinessDate;
  const strategy = center.strategySwitch;
  check(object(strategy) && strategy.version === 'trained-strategy-switch-v1'
    && strategy.activeReferenceStrategy === 'league-trained-baseline-v1'
    && strategy.legacyPublicationEnabled === false && strategy.legacyFallbackEnabled === false
    && strategy.formalEligible === false, 'STRATEGY_CONTRACT');
  for (const field of ['current', 'previews', 'todayCombos', 'todayDualResearch']) {
    check(Array.isArray(center[field]) && center[field].length === 0, 'LEGACY_CURRENT_NOT_RETIRED');
  }

  const trustRegistry = require('../src/services/collectorAttestation.cjs').loadCollectorTrustRegistry(
    process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
      || require('node:path').resolve(__dirname, '../deploy/light-server/collector-trust-registry.json'),
  );
  // Use the published view clock to reproduce its original cutoff-dependent
  // combo set. Consumers still apply their current clock before offering it.
  const reviewedRuntime = require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
  const trainedRuntime = require('../scripts/recommendationPlatform/leagueBaselineRuntime.cjs');
  const reviewedPresent = Object.hasOwn(center, 'reviewedAnalysis');
  const trainedPresent = Object.hasOwn(center, 'leagueBaseline');
  const validate = (reviewed, trained) => {
    check(trained.blocked === 0, 'TRAINED_REPLAY_BLOCKED');
    if (reviewedPresent) compareReviewed(center.reviewedAnalysis, reviewed);
    else check(reviewed.records.length === 0, 'REVIEWED_VIEW_MISSING');
    if (trainedPresent) check(object(center.leagueBaseline) && same(center.leagueBaseline, trained), 'TRAINED_VIEW_REPLAY');
    else check(trained.records.length === 0, 'TRAINED_VIEW_MISSING');
    check(Number.isSafeInteger(strategy.modelAdoptionCount) && strategy.modelAdoptionCount >= 0
      && strategy.modelAdoptionCount === trained.records.length, 'ADOPTION_COUNT');
  };
  const { reviewed, trained } = await replayPublications(client,
    { center, payload, now, trustRegistry, reviewedRuntime, trainedRuntime }, validate);
  // The freshly read center is compared even when deterministic replay is reused.
  validate(reviewed, trained);
  const laneValidation = (present, records) => {
    const openRecords = availableForCurrentDay ? records.filter(record => now < Date.parse(record.cutoffAt)).length : 0;
    return { status: present ? 'verified' : 'unavailable', records: records.length,
      openRecords, closedRecords: records.length - openRecords };
  };

  const authority = freeze({
    version: VERSION,
    mode: 'reviewed-and-trained',
    legacyCurrentEnabled: false,
    businessDate: center.businessDate,
    currentBusinessDate,
    publicationState: availableForCurrentDay ? 'current' : 'stale',
    availableForCurrentDay,
    updatedAt: center.updatedAt,
    observedAt: new Date(now).toISOString(),
    reviewedAnalysis: reviewedPresent ? reviewed : null,
    leagueBaseline: trainedPresent ? trained : null,
    records: { reviewed: reviewed.records, trained: trained.records },
    activeValidation: {
      // Integrity succeeded. This does not claim that either lane has an
      // available publication, nor that a closed record can still be offered.
      ok: true,
      reviewed: laneValidation(reviewedPresent, reviewed.records),
      trained: laneValidation(trainedPresent, trained.records),
    },
  });
  trustedAuthorities.add(authority);
  authorityPayloads.set(authority, freeze(JSON.parse(JSON.stringify(payload))));
  return authority;
}

async function readPublicationAuthority(client, options = {}) {
  if (!isTrustedPolicy(options.policy)) return null;
  try { return await readTrustedPublicationAuthority(client, options); }
  catch (error) {
    if (error?.statusCode === 503) throw error;
    throw Object.assign(new Error(error?.message || 'RECOMMENDATION_AUTHORITY_READ_UNAVAILABLE', { cause: error }), {
      code: error?.code || 'RECOMMENDATION_AUTHORITY_READ_UNAVAILABLE', statusCode: 503,
    });
  }
}

const getAuthorityCenterPayload = authority => isTrustedAuthority(authority) ? authorityPayloads.get(authority) : null;
const isRetiredCurrentProjection = match => {
  const token = match?.[retiredCurrentAuthority];
  return Boolean(token && typeof token === 'object' && retiredProjectionTokens.has(token)
    && isTrustedAuthority(token.authority));
};

function summarizeAuthority(authority) {
  if (!isTrustedAuthority(authority)) return null;
  const summary = freeze({
    version: VERSION, mode: authority.mode, legacyCurrentEnabled: false,
    businessDate: authority.businessDate, updatedAt: authority.updatedAt, observedAt: authority.observedAt,
    currentBusinessDate: authority.currentBusinessDate, publicationState: authority.publicationState,
    availableForCurrentDay: authority.availableForCurrentDay,
    activeValidation: authority.activeValidation,
  });
  return summary;
}

// Public JSON cannot mint this context. The summary and every row must come
// from the same successful authority read, including when the snapshot is empty.
function isTrustedCurrentAuthorityProjection(rows, summary) {
  const snapshot = object(summary) ? trustedAuthoritySummaries.get(summary) : null;
  if (!snapshot || !isTrustedAuthority(snapshot.authority) || !Array.isArray(rows)
    || rows.length !== snapshot.tokens.size || rows.length > 512) return false;
  const actual = new Set(rows.map(row => row?.[retiredCurrentAuthority]));
  return actual.size === rows.length && rows.every(row => isRetiredCurrentProjection(row)
    && row[retiredCurrentAuthority].authority === snapshot.authority
    && snapshot.tokens.has(row[retiredCurrentAuthority]));
}

function projectRetiredCurrent(match, authority) {
  if (!isTrustedAuthority(authority) || !object(match)) return match;
  let legacyArchiveState;
  if (match.archivedPreMatchPrediction != null) {
    check(validateArchivedDecision(match).valid, 'EXISTING_ARCHIVE_INVALID');
    legacyArchiveState = 'valid';
  } else legacyArchiveState = hasDirectionalEvidence(match)
    || (isRetiredCurrentProjection(match) && match[retiredCurrentAuthority].legacyArchiveState === 'missing')
    ? 'missing' : 'none';
  const token = Object.freeze({ authority, legacyArchiveState });
  retiredProjectionTokens.add(token);
  return {
    ...match,
    // Enumerable symbols survive the server's ordinary object-spread
    // normalizers, but JSON/source payloads cannot create this private token.
    [retiredCurrentAuthority]: token,
    predictions: [],
    recommendationAuthority: freeze({ ...summarizeAuthority(authority), legacyArchiveState }),
  };
}

function projectCurrentAuthoritySnapshot(rows, authority) {
  check(isTrustedAuthority(authority) && Array.isArray(rows) && rows.length <= 512, 'CURRENT_SNAPSHOT_INVALID');
  const projected = rows.map(row => projectRetiredCurrent(row, authority));
  const recommendationAuthority = summarizeAuthority(authority);
  // Capture exact membership before lifecycle/list/detail normalizers spread the
  // rows. A subset, duplicate, JSON copy, or a second RR read cannot reuse it.
  trustedAuthoritySummaries.set(recommendationAuthority, {
    authority, tokens: new Set(projected.map(row => row?.[retiredCurrentAuthority])),
  });
  return { rows: projected, recommendationAuthority };
}

module.exports = {
  TRAINED_ONLY_POLICY, isTrustedPolicy, readPublicationAuthority,
  isTrustedAuthority, summarizeAuthority, projectRetiredCurrent,
  isRetiredCurrentProjection, getAuthorityCenterPayload,
  isTrustedCurrentAuthorityProjection, projectCurrentAuthoritySnapshot,
};
