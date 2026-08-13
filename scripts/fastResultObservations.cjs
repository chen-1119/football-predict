"use strict";

const crypto = require("node:crypto");
const {
  canonicalSourceMatchId,
  eventVersionOf,
  reconcileMatchLifecycle,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");

const FAST_RESULT_OBSERVATION_VERSION = "fast-result-observations-v2";
// Security and export guards retain every exact fast-result event. This is an
// availability ceiling only: overflow throws and rolls the enclosing SQLite
// transaction back; rows are never silently evicted.
const FAST_RESULT_OBSERVATION_LIMIT = 100_000;
const FAST_RESULT_IDENTITY_RESOLUTION_VERSION = "fast-result-identity-resolution-v1";

const asText = (value) => String(value ?? "").trim();
const validIso = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const sourceMatchIdOf = (match) => canonicalSourceMatchId(match?.sourceMatchId || match?.id);
const exactScore = (match) => Number.isInteger(match?.scoreHome)
  && Number.isInteger(match?.scoreAway)
  && match.scoreHome >= 0
  && match.scoreAway >= 0;
const sameScore = (left, right) => exactScore(left)
  && exactScore(right)
  && left.scoreHome === right.scoreHome
  && left.scoreAway === right.scoreAway;
const trustedOfficialFinal = (match) => Boolean(
  match
  && (match.status === "FINISHED" || match.effectiveStatus === "FINISHED")
  && match?.resultProvenance?.provider === "sporttery"
  && match?.resultProvenance?.official === true
  && match?.resultProvenance?.trusted === true
  && exactScore(match)
);

const observationIdentity = ({ sourceMatchId, eventVersion, scoreHome, scoreAway }) => ({
  sourceMatchId: asText(sourceMatchId).toLowerCase(),
  eventVersion: asText(eventVersion).toLowerCase(),
  scoreHome,
  scoreAway,
});

const observationKey = (value) => {
  const identity = observationIdentity(value || {});
  if (!identity.sourceMatchId || !identity.eventVersion || !exactScore(identity)) return null;
  return `fast-result:${crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32)}`;
};

const normalizeObservation = (value) => {
  if (!value || typeof value !== "object") return null;
  const sourceMatchId = sourceMatchIdOf(value).toLowerCase();
  const eventVersion = asText(value.eventVersion || eventVersionOf(value));
  const resultObservedAt = validIso(value.resultObservedAt);
  const observationSource = asText(
    value.observationSource
    || value.resultObservationSource
    || "sqlite-fast-result-receipt"
  ) || null;
  const sourceUpdatedAt = validIso(value.sourceUpdatedAt || value.resultSourceUpdatedAt);
  const resultObservationFallback = value.resultObservationFallback === true
    || value.observationFallback === true
    || /(?:fallback|kickoff-plus|legacy-unattributed)/i.test(observationSource || "");
  const settledAt = validIso(value.settledAt);
  const publishedAt = validIso(value.publishedAt) || resultObservedAt;
  const normalized = {
    key: null,
    sourceMatchId,
    eventVersion,
    kickoffTime: validIso(value.kickoffTime),
    scoreHome: value.scoreHome,
    scoreAway: value.scoreAway,
    resultObservedAt,
    observationSource,
    sourceUpdatedAt,
    resultObservationFallback,
    promotionEligible: Boolean(resultObservedAt && observationSource && !resultObservationFallback),
    settledAt,
    publishedAt,
    sourceCycleId: asText(value.sourceCycleId) || null,
    datasetRevision: asText(value.datasetRevision) || null,
  };
  normalized.key = observationKey(normalized);
  if (
    !normalized.key
    || !resultObservedAt
    || !observationSource
    || !settledAt
    || !normalized.sourceCycleId
    || !normalized.datasetRevision
  ) return null;
  return normalized;
};

const observationRows = (payload) => {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
  return rows.map(normalizeObservation).filter(Boolean);
};

const mergeFastResultObservations = (
  existing,
  incoming = [],
  limit = FAST_RESULT_OBSERVATION_LIMIT
) => {
  const safeLimit = FAST_RESULT_OBSERVATION_LIMIT;
  const byKey = new Map();
  const addFirst = (row) => {
    const normalized = normalizeObservation(row);
    if (!normalized) return;
    const prior = byKey.get(normalized.key);
    if (!prior || Date.parse(normalized.resultObservedAt) < Date.parse(prior.resultObservedAt)) {
      byKey.set(normalized.key, normalized);
    }
  };
  observationRows(existing).forEach(addFirst);
  observationRows(incoming).forEach((row) => {
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  });
  const rows = Array.from(byKey.values())
    .sort((left, right) => Date.parse(right.resultObservedAt) - Date.parse(left.resultObservedAt));
  if (rows.length > safeLimit) {
    const error = new Error(`fast result observation capacity exceeded: ${rows.length}/${safeLimit}`);
    error.code = "FAST_RESULT_OBSERVATION_OVERFLOW";
    throw error;
  }
  return {
    version: FAST_RESULT_OBSERVATION_VERSION,
    limit: safeLimit,
    rows,
  };
};

const createFastResultObservation = (match, metadata = {}) => {
  if (!trustedOfficialFinal(match)) return null;
  return normalizeObservation({
    sourceMatchId: sourceMatchIdOf(match),
    eventVersion: eventVersionOf(match),
    kickoffTime: match.kickoffTime || null,
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
    resultObservedAt: match.resultObservedAt,
    observationSource: match?.resultProvenance?.observationSource
      || match?.resultObservationSource
      || metadata.observationSource
      || "sqlite-fast-result-publisher",
    sourceUpdatedAt: match?.resultProvenance?.sourceUpdatedAt
      || match?.resultSourceUpdatedAt
      || null,
    resultObservationFallback: match?.resultProvenance?.resultObservationFallback === true
      || match?.resultObservationFallback === true,
    settledAt: match.settledAt,
    publishedAt: metadata.publishedAt || match.resultObservedAt,
    sourceCycleId: metadata.sourceCycleId || match.sourceCycleId,
    datasetRevision: metadata.datasetRevision || match.datasetRevision,
  });
};

const findFastResultObservation = (match, payload) => {
  if (!trustedOfficialFinal(match)) return null;
  const sourceMatchId = sourceMatchIdOf(match).toLowerCase();
  return observationRows(payload).find((observation) => (
    observation.sourceMatchId === sourceMatchId
    && sameEvent(match, observation)
    && sameScore(match, observation)
  )) || null;
};

const applyFastResultObservation = (match, payload) => {
  const observation = findFastResultObservation(match, payload);
  if (!observation) return match;
  const priorReview = match?.postMatchReview && typeof match.postMatchReview === "object"
    ? match.postMatchReview
    : null;
  const priorSettlement = priorReview?.settlement && typeof priorReview.settlement === "object"
    ? priorReview.settlement
    : {};
  return {
    ...match,
    resultObservedAt: observation.resultObservedAt,
    resultObservationSource: observation.observationSource,
    resultSourceUpdatedAt: observation.sourceUpdatedAt,
    resultObservationFallback: observation.resultObservationFallback,
    settledAt: observation.settledAt,
    sourceCycleId: observation.sourceCycleId,
    datasetRevision: observation.datasetRevision,
    resultProvenance: match?.resultProvenance ? {
      ...match.resultProvenance,
      version: "result-provenance-v2",
      eventVersion: observation.eventVersion,
      observedAt: observation.resultObservedAt,
      observationSource: observation.observationSource,
      sourceUpdatedAt: observation.sourceUpdatedAt,
      sourceUpdatedAtAvailable: Boolean(observation.sourceUpdatedAt),
      resultObservationFallback: observation.resultObservationFallback,
      promotionEligible: observation.promotionEligible,
    } : match?.resultProvenance,
    ...(priorReview ? {
      postMatchReview: {
        ...priorReview,
        settlement: {
          ...priorSettlement,
          resultObservedAt: observation.resultObservedAt,
          resultObservationSource: observation.observationSource,
          resultSourceUpdatedAt: observation.sourceUpdatedAt,
          resultObservationFallback: observation.resultObservationFallback,
          settledAt: observation.settledAt,
          sourceCycleId: observation.sourceCycleId,
          datasetRevision: observation.datasetRevision,
        },
      },
    } : {}),
  };
};

const recentFastObservationSourceIds = (payload, limit = 64) => {
  const safeLimit = Math.max(1, Math.min(FAST_RESULT_OBSERVATION_LIMIT, Number(limit || 64)));
  return [...new Set(observationRows(payload).map((row) => row.sourceMatchId).filter(Boolean))]
    .slice(0, safeLimit);
};

const overlayIdentityKey = (match) => sourceMatchIdOf(match).toLowerCase();

const trustedFinalOutcomeIdentity = (match) => {
  if (!trustedOfficialFinal(match)) return null;
  const sourceMatchId = overlayIdentityKey(match);
  const eventVersion = eventVersionOf(match);
  const provenance = match?.resultProvenance || null;
  const provenanceSourceMatchId = provenance ? sourceMatchIdOf(provenance).toLowerCase() : "";
  const provenanceEventVersion = provenance ? eventVersionOf(provenance) : null;
  if (!sourceMatchId || !eventVersion) return null;
  if (provenanceSourceMatchId && provenanceSourceMatchId !== sourceMatchId) return null;
  if (provenanceEventVersion && provenanceEventVersion !== eventVersion) return null;
  if (provenance && exactScore(provenance) && !sameScore(match, provenance)) return null;
  return {
    sourceMatchId,
    eventVersion,
    scoreHome: match.scoreHome,
    scoreAway: match.scoreAway,
  };
};

const sameTrustedFinalOutcome = (left, right) => {
  const leftIdentity = trustedFinalOutcomeIdentity(left);
  const rightIdentity = trustedFinalOutcomeIdentity(right);
  if (!leftIdentity || !rightIdentity) return false;
  return leftIdentity.sourceMatchId === rightIdentity.sourceMatchId
    && leftIdentity.eventVersion === rightIdentity.eventVersion
    && leftIdentity.scoreHome === rightIdentity.scoreHome
    && leftIdentity.scoreAway === rightIdentity.scoreAway;
};

const beijingEventClock = (match) => {
  const eventVersion = eventVersionOf(match);
  const time = Date.parse(eventVersion || "");
  if (!Number.isFinite(time)) return null;
  const local = new Date(time + (8 * 60 * 60 * 1000)).toISOString();
  return {
    eventVersion,
    date: local.slice(0, 10),
    clock: local.slice(11, 16),
  };
};

const immutableArchiveBindsEvent = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  if (
    archive?.version !== "archived-pre-match-prediction-v1"
    || archive?.source !== "immutable-pre-match-prediction-snapshot"
    || sourceMatchIdOf(archive).toLowerCase() !== overlayIdentityKey(match)
  ) {
    return false;
  }
  const matchEvent = Date.parse(eventVersionOf(match) || "");
  const archiveEvent = Date.parse(archive.eventVersion || archive.kickoffTime || "");
  const capturedAt = Date.parse(archive.capturedAt || "");
  return Number.isFinite(matchEvent)
    && Number.isFinite(archiveEvent)
    && matchEvent === archiveEvent
    && Number.isFinite(capturedAt)
    && capturedAt < matchEvent;
};

const rebindLegacyMidnightResultClock = (fastFinal, currentFinal) => {
  if (
    !trustedOfficialFinal(fastFinal)
    || !trustedOfficialFinal(currentFinal)
    || overlayIdentityKey(fastFinal) !== overlayIdentityKey(currentFinal)
    || !sameScore(fastFinal, currentFinal)
    || !immutableArchiveBindsEvent(currentFinal)
  ) {
    return null;
  }
  const fastClock = beijingEventClock(fastFinal);
  const currentClock = beijingEventClock(currentFinal);
  if (
    !fastClock
    || !currentClock
    || fastClock.date !== currentClock.date
    || fastClock.clock !== "00:00"
    || currentClock.clock === "00:00"
  ) {
    return null;
  }
  const reboundEventVersion = eventVersionOf(currentFinal);
  return {
    ...fastFinal,
    kickoffTime: currentFinal.kickoffTime,
    eventVersion: reboundEventVersion,
    matchDate: currentFinal.matchDate || fastFinal.matchDate,
    businessDate: currentFinal.businessDate || fastFinal.businessDate,
    buyEndTime: currentFinal.buyEndTime || fastFinal.buyEndTime,
    archivedPreMatchPrediction: currentFinal.archivedPreMatchPrediction,
    predictions: currentFinal.predictions || fastFinal.predictions,
    probabilityModel: currentFinal.probabilityModel || fastFinal.probabilityModel,
    predictionMeta: currentFinal.predictionMeta || fastFinal.predictionMeta,
    resultProvenance: fastFinal.resultProvenance ? {
      ...fastFinal.resultProvenance,
      kickoffTime: currentFinal.kickoffTime,
      eventVersion: reboundEventVersion,
    } : fastFinal.resultProvenance,
    fastResultIdentityResolution: {
      version: FAST_RESULT_IDENTITY_RESOLUTION_VERSION,
      policy: "legacy-midnight-result-clock-rebound-to-immutable-prematch-event",
      canonicalSourceMatchId: overlayIdentityKey(currentFinal),
      previousEventVersion: fastClock.eventVersion,
      reboundEventVersion,
      discardedRows: 0,
      deduplicatedTrustedFinalRows: 1,
      discardedUntrustedRows: 0,
      inheritedMismatchedPreMatchEvidence: true,
      immutableArchiveValidated: true,
    },
  };
};

const overlayFinalSortKey = (match) => {
  const observedAt = validIso(
    match?.resultObservedAt
    || match?.resultProvenance?.observedAt
    || match?.resultSourceUpdatedAt
    || match?.resultUpdatedAt
  ) || "";
  return [
    overlayIdentityKey(match),
    eventVersionOf(match) || "",
    observedAt,
    String(match?.scoreHome ?? ""),
    String(match?.scoreAway ?? ""),
    asText(match?.id),
  ].join("|");
};

const fastResultIdentityConflict = (sourceMatchId, reason, rows) => {
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((match) => ({
      id: asText(match?.id) || null,
      sourceMatchId: overlayIdentityKey(match) || null,
      eventVersion: eventVersionOf(match) || null,
      status: asText(match?.effectiveStatus || match?.status).toUpperCase() || null,
      score: exactScore(match) ? `${match.scoreHome}-${match.scoreAway}` : null,
      trustedOfficialFinal: trustedOfficialFinal(match),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const error = new Error(
    `fast result overlay identity conflict ${sourceMatchId}: ${reason}; candidates=${JSON.stringify(candidates)}`
  );
  error.code = "FAST_RESULT_IDENTITY_CONFLICT";
  error.sourceMatchId = sourceMatchId;
  error.reason = reason;
  error.candidates = candidates;
  return error;
};

const assertUniqueOverlayRows = (rows) => {
  const identities = new Map();
  const ids = new Map();
  for (const match of rows) {
    const identity = overlayIdentityKey(match);
    if (identity) {
      const prior = identities.get(identity);
      if (prior) {
        throw fastResultIdentityConflict(identity, "duplicate-canonical-source-id-after-resolution", [prior, match]);
      }
      identities.set(identity, match);
    }
    const id = asText(match?.id);
    if (id) {
      const prior = ids.get(id);
      if (prior) {
        throw fastResultIdentityConflict(identity || id, "duplicate-published-id-after-resolution", [prior, match]);
      }
      ids.set(id, match);
    }
  }
  return rows;
};

const overlayFastObservedFinals = (matches, sqliteFinals, payload) => {
  const finals = (Array.isArray(sqliteFinals) ? sqliteFinals : [])
    .filter((match) => trustedOfficialFinal(match) && findFastResultObservation(match, payload))
    .sort((left, right) => overlayFinalSortKey(left).localeCompare(overlayFinalSortKey(right)));
  let enriched = [...(Array.isArray(matches) ? matches : [])];
  for (const final of finals) {
    const identity = overlayIdentityKey(final);
    if (!identity) {
      throw fastResultIdentityConflict("missing", "trusted-final-missing-canonical-source-id", [final]);
    }
    const identityRows = enriched
      .map((match, index) => ({ match, index }))
      .filter((entry) => overlayIdentityKey(entry.match) === identity);
    if (identityRows.length === 0) {
      enriched.push(final);
      continue;
    }

    const archiveClockReference = identityRows
      .map((entry) => entry.match)
      .find((match) => rebindLegacyMidnightResultClock(final, match));
    const overlayFinal = archiveClockReference
      ? rebindLegacyMidnightResultClock(final, archiveClockReference)
      : final;
    const exactRows = identityRows.filter((entry) => sameEvent(entry.match, overlayFinal));
    const mismatchedRows = identityRows.filter((entry) => !sameEvent(entry.match, overlayFinal));
    const equivalentTrustedFinals = mismatchedRows
      .map((entry) => entry.match)
      .filter((match) => trustedOfficialFinal(match) && sameTrustedFinalOutcome(match, overlayFinal));
    const legacyMidnightAliases = mismatchedRows
      .map((entry) => entry.match)
      .filter((match) => (
        trustedOfficialFinal(match)
        && Boolean(rebindLegacyMidnightResultClock(match, overlayFinal))
      ));
    const conflictingTrustedFinals = identityRows
      .map((entry) => entry.match)
      .filter((match) => (
        trustedOfficialFinal(match)
        && !sameTrustedFinalOutcome(match, overlayFinal)
        && !legacyMidnightAliases.includes(match)
      ));
    if (conflictingTrustedFinals.length > 0) {
      throw fastResultIdentityConflict(
        identity,
        "conflicting-trusted-official-finals",
        [overlayFinal, ...conflictingTrustedFinals]
      );
    }

    let resolved = overlayFinal;
    for (const entry of exactRows.sort((left, right) => left.index - right.index)) {
      resolved = reconcileMatchLifecycle(entry.match, resolved);
    }
    if (mismatchedRows.length > 0) {
      // This is the critical full/fast race boundary. A result-only SQLite row
      // can carry the same canonical upstream id as a freshly rebuilt 500.com
      // fallback while strict event/team guards reject reconciliation. Keeping
      // both creates duplicate public ids. The trusted official final wins, but
      // no prediction or other pre-match content is inherited from the
      // mismatched row. A second trusted copy is safe to discard only when its
      // canonical id, exact event revision, root score and provenance score all
      // agree. Kickoff/team fields are fixture metadata and may drift between
      // the full and result lanes; they remain excluded from inheritance. Any
      // substantive trusted result conflict aborts above instead of guessing.
      resolved = {
        ...final,
        fastResultIdentityResolution: {
          version: FAST_RESULT_IDENTITY_RESOLUTION_VERSION,
          policy: legacyMidnightAliases.length > 0
            ? "legacy-midnight-result-clock-discarded-for-immutable-prematch-event"
            : equivalentTrustedFinals.length > 0
              ? "equivalent-trusted-official-finals-deduplicated"
              : "trusted-official-final-over-canonical-id-conflict",
          canonicalSourceMatchId: identity,
          discardedRows: mismatchedRows.length,
          deduplicatedTrustedFinalRows: equivalentTrustedFinals.length + legacyMidnightAliases.length,
          discardedUntrustedRows: mismatchedRows.length
            - equivalentTrustedFinals.length
            - legacyMidnightAliases.length,
          inheritedMismatchedPreMatchEvidence: false,
          immutableArchiveValidated: legacyMidnightAliases.length > 0,
        },
      };
    }

    const removeIndexes = new Set(identityRows.map((entry) => entry.index));
    const insertAt = Math.min(...removeIndexes);
    enriched = enriched.filter((_, index) => !removeIndexes.has(index));
    enriched.splice(Math.min(insertAt, enriched.length), 0, resolved);
  }
  return assertUniqueOverlayRows(enriched);
};

module.exports = {
  FAST_RESULT_OBSERVATION_LIMIT,
  FAST_RESULT_OBSERVATION_VERSION,
  FAST_RESULT_IDENTITY_RESOLUTION_VERSION,
  applyFastResultObservation,
  createFastResultObservation,
  findFastResultObservation,
  mergeFastResultObservations,
  normalizeObservation,
  observationKey,
  observationRows,
  overlayFastObservedFinals,
  recentFastObservationSourceIds,
  sameScore,
  sameTrustedFinalOutcome,
  trustedOfficialFinal,
};
