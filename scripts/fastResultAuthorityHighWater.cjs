"use strict";

const crypto = require("node:crypto");
const {
  canonicalSourceMatchId,
  eventVersionOf,
} = require("../src/services/matchLifecycle.cjs");

const FAST_RESULT_AUTHORITY_HIGH_WATER_KEY = "fast_result_authority_high_water";
const FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX = `${FAST_RESULT_AUTHORITY_HIGH_WATER_KEY}:event:`;
const FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY = `${FAST_RESULT_AUTHORITY_HIGH_WATER_KEY}:initialized`;
const FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION = "verified-result-probe-high-water-v2";
const FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_VERSION = "verified-result-probe-high-water-row-v2";
const FAST_RESULT_AUTHORITY_IDENTITY_VERSION = "sporttery-event-team-identity-v2";
// This is an availability guard, never a retention policy. Reaching it rejects
// the whole batch; no trusted event is silently evicted to make room.
const FAST_RESULT_AUTHORITY_HIGH_WATER_MAX_ROWS = 100_000;

const asText = (value) => String(value ?? "").trim();
const canonicalText = (value) => asText(value).normalize("NFKC").toLowerCase();
const validIso = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const exactScore = (value) => Number.isInteger(value?.scoreHome)
  && Number.isInteger(value?.scoreAway)
  && value.scoreHome >= 0
  && value.scoreAway >= 0;
const safeJsonParse = (value) => {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
};

const teamIdentities = (match, side) => {
  const prefix = side === "home" ? "home" : "away";
  const candidates = [
    ["code", match?.[`${prefix}TeamCode`]],
    ["id", match?.[`${prefix}TeamId`]],
    ["name", match?.[`${prefix}Team`] || match?.[`${prefix}TeamName`]],
  ];
  const values = [];
  for (const [kind, value] of candidates) {
    const normalized = canonicalText(value);
    if (normalized) values.push(`${kind}:${normalized}`);
  }
  return [...new Set(values)].sort();
};

const authorityIdentityKey = ({
  sourceMatchId,
  eventVersion,
}) => {
  const identity = {
    identityVersion: FAST_RESULT_AUTHORITY_IDENTITY_VERSION,
    sourceMatchId: canonicalSourceMatchId(sourceMatchId),
    eventVersion: validIso(eventVersion),
  };
  if (!identity.sourceMatchId || !identity.eventVersion) return null;
  const key = crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return { key, ...identity };
};

const authorityEventIdentity = (match) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const eventVersion = validIso(eventVersionOf(match) || match?.kickoffTime);
  const homeTeamIdentities = teamIdentities(match, "home");
  const awayTeamIdentities = teamIdentities(match, "away");
  if (!sourceMatchId || !eventVersion || !homeTeamIdentities.length || !awayTeamIdentities.length) {
    return null;
  }
  return {
    ...authorityIdentityKey({
    sourceMatchId,
    eventVersion,
    }),
    homeTeamIdentities,
    awayTeamIdentities,
  };
};

const sameAuthorityEvent = (left, right) => {
  const leftIdentity = authorityEventIdentity(left);
  const rightIdentity = authorityEventIdentity(right);
  if (!leftIdentity || !rightIdentity || leftIdentity.key !== rightIdentity.key) return false;
  const overlaps = (a, b) => a.some((value) => b.includes(value));
  return overlaps(leftIdentity.homeTeamIdentities, rightIdentity.homeTeamIdentities)
    && overlaps(leftIdentity.awayTeamIdentities, rightIdentity.awayTeamIdentities);
};

const authorityHighWaterCandidate = ({
  match,
  observedAt,
  sourceCycleId,
  resultProbeRevisionId,
}) => {
  const identity = authorityEventIdentity(match);
  const normalizedObservedAt = validIso(observedAt);
  const normalizedCycleId = asText(sourceCycleId);
  if (!identity || !normalizedObservedAt || !normalizedCycleId) return null;
  if (!exactScore(match)) return null;
  return {
    version: FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_VERSION,
    ...identity,
    observedAt: normalizedObservedAt,
    sourceCycleId: normalizedCycleId,
    resultProbeRevisionId: asText(resultProbeRevisionId) || null,
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
  };
};

const validAuthorityRow = (row, metaKey = null) => {
  const identity = authorityIdentityKey(row || {});
  const normalizedHome = Array.isArray(row?.homeTeamIdentities)
    ? [...new Set(row.homeTeamIdentities.map(canonicalText).filter(Boolean))].sort()
    : [];
  const normalizedAway = Array.isArray(row?.awayTeamIdentities)
    ? [...new Set(row.awayTeamIdentities.map(canonicalText).filter(Boolean))].sort()
    : [];
  return Boolean(
    row?.version === FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_VERSION
    && identity
    && identity.key === asText(row?.key)
    && row.identityVersion === FAST_RESULT_AUTHORITY_IDENTITY_VERSION
    && normalizedHome.length > 0
    && normalizedAway.length > 0
    && JSON.stringify(row.homeTeamIdentities) === JSON.stringify(normalizedHome)
    && JSON.stringify(row.awayTeamIdentities) === JSON.stringify(normalizedAway)
    && validIso(row?.observedAt)
    && asText(row?.sourceCycleId)
    && exactScore(row)
    && (row?.resultProbeRevisionId === null
      || typeof row?.resultProbeRevisionId === "string")
    && (!metaKey || metaKey === `${FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX}${row.key}`)
  );
};

const expectedManifest = () => ({
  version: FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION,
  storage: "schema-meta-per-event",
  identityVersion: FAST_RESULT_AUTHORITY_IDENTITY_VERSION,
  rowPrefix: FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX,
  maxRows: FAST_RESULT_AUTHORITY_HIGH_WATER_MAX_ROWS,
  overflowPolicy: "fail-closed-no-eviction",
});

const rowsRootHash = (rows) => crypto.createHash("sha256")
  .update(JSON.stringify([...rows].sort((left, right) => String(left.key).localeCompare(String(right.key)))))
  .digest("hex");

const loadAuthorityHighWater = (db) => {
  const manifestRow = db.prepare(
    "SELECT value, updated_at FROM schema_meta WHERE key = ?"
  ).get(FAST_RESULT_AUTHORITY_HIGH_WATER_KEY);
  const initializedRow = db.prepare(
    "SELECT value, updated_at FROM schema_meta WHERE key = ?"
  ).get(FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY);
  const storedRows = db.prepare(`
    SELECT key, value, updated_at
    FROM schema_meta
    WHERE key LIKE ?
    ORDER BY key ASC
  `).all(`${FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX}%`);
  return validateAuthorityHighWaterMetadata({ manifestRow, initializedRow, storedRows });
};

const validateAuthorityHighWaterMetadata = ({ manifestRow, initializedRow, storedRows }) => {
  if (new Set(storedRows.map(row => row.key)).size !== storedRows.length) {
    throw new Error("duplicate fast-result authority key");
  }
  if (!manifestRow && storedRows.length === 0 && !initializedRow) {
    return {
      valid: true,
      missing: true,
      initialized: false,
      manifestRow: null,
      rows: [],
    };
  }
  const manifest = safeJsonParse(manifestRow?.value);
  const initialized = safeJsonParse(initializedRow?.value);
  const expected = expectedManifest();
  const parsedRows = storedRows.map((row) => ({
    metaKey: row.key,
    updatedAt: row.updated_at,
    value: safeJsonParse(row.value),
  }));
  const rowsValid = storedRows.length <= FAST_RESULT_AUTHORITY_HIGH_WATER_MAX_ROWS
    && parsedRows.every((row) => (
      validAuthorityRow(row.value, row.metaKey)
      && validIso(row.updatedAt) === validIso(row.value.observedAt)
    ));
  const rows = rowsValid ? parsedRows.map((row) => row.value) : [];
  const latestRowObservedAt = rows.reduce((latest, row) => (
    !latest || Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest
  ), null) || new Date(0).toISOString();
  const manifestValid = Boolean(
    manifestRow
    && manifest?.version === expected.version
    && manifest?.storage === expected.storage
    && manifest?.identityVersion === expected.identityVersion
    && manifest?.rowPrefix === expected.rowPrefix
    && Number(manifest?.maxRows) === expected.maxRows
    && manifest?.overflowPolicy === expected.overflowPolicy
    && Number(manifest?.rows) === storedRows.length
    && validIso(manifest?.updatedAt) === latestRowObservedAt
    && manifest?.rootHash === rowsRootHash(rows)
  );
  const initializedValid = Boolean(
    initializedRow
    && initialized?.version === FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION
    && initialized?.state === "INITIALIZED"
    && validIso(initialized?.initializedAt)
    && validIso(initializedRow.updated_at) === validIso(initialized.initializedAt)
  );
  return {
    valid: manifestValid && initializedValid && rowsValid,
    missing: false,
    initialized: manifestValid && initializedValid,
    manifestRow,
    initializedRow,
    manifest,
    rows,
  };
};

const authorityHighWaterRow = (ledger, match) => {
  const identity = authorityEventIdentity(match);
  if (!identity) return null;
  const row = (ledger?.rows || []).find((candidate) => candidate.key === identity.key) || null;
  if (!row) return null;
  const overlaps = (left, right) => left.some((value) => right.includes(value));
  return overlaps(row.homeTeamIdentities, identity.homeTeamIdentities)
    && overlaps(row.awayTeamIdentities, identity.awayTeamIdentities)
    ? row
    : null;
};

const authorityHighWaterBindsResult = (row, match) => Boolean(
  row
  && exactScore(row)
  && exactScore(match)
  && row.scoreHome === match.scoreHome
  && row.scoreAway === match.scoreAway
);

const mergeAuthorityHighWater = (ledger, candidates) => {
  const byKey = new Map((ledger?.rows || []).map((row) => [row.key, row]));
  const changedByKey = new Map();
  const overlaps = (left, right) => left.some((value) => right.includes(value));
  for (const candidate of candidates.filter(Boolean)) {
    const current = byKey.get(candidate.key);
    const incomingMs = Date.parse(candidate.observedAt);
    const currentMs = Date.parse(current?.observedAt || "");
    if (!current) {
      byKey.set(candidate.key, candidate);
      changedByKey.set(candidate.key, candidate);
      continue;
    }
    if (
      !overlaps(current.homeTeamIdentities, candidate.homeTeamIdentities)
      || !overlaps(current.awayTeamIdentities, candidate.awayTeamIdentities)
    ) {
      return {
        valid: false,
        overflow: false,
        identityConflict: true,
        changed: false,
        changedRows: [],
        rows: ledger?.rows || [],
      };
    }
    const sameResult = authorityHighWaterBindsResult(current, candidate);
    if (!sameResult && !(
      Number.isFinite(incomingMs)
      && Number.isFinite(currentMs)
      && incomingMs > currentMs
      && candidate.sourceCycleId !== current.sourceCycleId
    )) {
      return {
        valid: false,
        overflow: false,
        identityConflict: false,
        scoreConflict: true,
        changed: false,
        changedRows: [],
        rows: ledger?.rows || [],
      };
    }
    const mergedTeams = {
      homeTeamIdentities: [...new Set([
        ...current.homeTeamIdentities,
        ...candidate.homeTeamIdentities,
      ])].sort(),
      awayTeamIdentities: [...new Set([
        ...current.awayTeamIdentities,
        ...candidate.awayTeamIdentities,
      ])].sort(),
    };
    if (
      Number.isFinite(incomingMs)
      && Number.isFinite(currentMs)
      && incomingMs > currentMs
      && candidate.sourceCycleId !== current.sourceCycleId
    ) {
      const replacement = { ...candidate, ...mergedTeams };
      byKey.set(candidate.key, replacement);
      changedByKey.set(candidate.key, replacement);
    } else if (
      JSON.stringify(current.homeTeamIdentities) !== JSON.stringify(mergedTeams.homeTeamIdentities)
      || JSON.stringify(current.awayTeamIdentities) !== JSON.stringify(mergedTeams.awayTeamIdentities)
    ) {
      const replacement = { ...current, ...mergedTeams };
      byKey.set(candidate.key, replacement);
      changedByKey.set(candidate.key, replacement);
    }
  }
  if (byKey.size > FAST_RESULT_AUTHORITY_HIGH_WATER_MAX_ROWS) {
    return {
      valid: false,
      overflow: true,
      changed: false,
      changedRows: [],
      rows: ledger?.rows || [],
    };
  }
  const rows = [...byKey.values()].sort((left, right) => (
    String(left.key).localeCompare(String(right.key))
  ));
  const changedRows = [...changedByKey.values()];
  return {
    valid: true,
    overflow: false,
    changed: ledger?.missing === true || changedRows.length > 0,
    changedRows,
    rows,
  };
};

const persistAuthorityHighWater = (db, merged, updatedAtFallback) => {
  if (!merged?.valid || !merged?.changed) return false;
  const updatedAt = merged.rows.reduce((latest, row) => (
    !latest || Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest
  ), null) || validIso(updatedAtFallback);
  const manifest = {
    ...expectedManifest(),
    updatedAt: updatedAt || new Date(0).toISOString(),
    rows: merged.rows.length,
    rootHash: rowsRootHash(merged.rows),
  };
  db.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(
    FAST_RESULT_AUTHORITY_HIGH_WATER_KEY,
    JSON.stringify(manifest),
    manifest.updatedAt,
  );
  const initializedAt = validIso(updatedAtFallback) || manifest.updatedAt;
  db.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(
    FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY,
    JSON.stringify({
      version: FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION,
      state: "INITIALIZED",
      initializedAt,
    }),
    initializedAt,
  );
  const upsert = db.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const rowsToWrite = merged.changedRows.length > 0
    ? merged.changedRows
    : merged.rows;
  for (const row of rowsToWrite) {
    upsert.run(
      `${FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX}${row.key}`,
      JSON.stringify(row),
      row.observedAt,
    );
  }
  return true;
};

module.exports = {
  FAST_RESULT_AUTHORITY_HIGH_WATER_INITIALIZED_KEY,
  FAST_RESULT_AUTHORITY_HIGH_WATER_KEY,
  FAST_RESULT_AUTHORITY_HIGH_WATER_MAX_ROWS,
  FAST_RESULT_AUTHORITY_HIGH_WATER_ROW_PREFIX,
  FAST_RESULT_AUTHORITY_HIGH_WATER_VERSION,
  authorityEventIdentity,
  authorityHighWaterBindsResult,
  authorityHighWaterCandidate,
  authorityHighWaterRow,
  authorityIdentityKey,
  expectedManifest,
  loadAuthorityHighWater,
  validateAuthorityHighWaterMetadata,
  mergeAuthorityHighWater,
  persistAuthorityHighWater,
  rowsRootHash,
  sameAuthorityEvent,
};
