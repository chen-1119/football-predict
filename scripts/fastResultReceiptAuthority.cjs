"use strict";

const {
  canonicalSourceMatchId,
  eventVersionOf,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");
const {
  observationRows,
  sameScore,
  trustedOfficialFinal,
} = require("./fastResultObservations.cjs");
const {
  authorityIdentityKey,
} = require("./fastResultAuthorityHighWater.cjs");

const sourceMatchIdFor = (value) => canonicalSourceMatchId(
  value?.sourceMatchId || value?.id
).toLowerCase();

const fastResultEventClock = (value) => {
  const instant = Date.parse(
    eventVersionOf(value) || value?.eventVersion || value?.kickoffTime || ""
  );
  if (!Number.isFinite(instant)) return null;
  const beijing = new Date(instant + (8 * 60 * 60 * 1000)).toISOString();
  return {
    instant,
    eventVersion: new Date(instant).toISOString(),
    date: beijing.slice(0, 10),
    clock: beijing.slice(11, 16),
  };
};

const immutableArchiveBindsFastResultEvent = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  const matchClock = fastResultEventClock(match);
  const archiveClock = fastResultEventClock(archive);
  const capturedAt = Date.parse(archive?.capturedAt || "");
  return Boolean(
    archive?.version === "archived-pre-match-prediction-v1"
    && archive?.source === "immutable-pre-match-prediction-snapshot"
    && sourceMatchIdFor(archive) === sourceMatchIdFor(match)
    && matchClock
    && archiveClock
    && matchClock.instant === archiveClock.instant
    && Number.isFinite(capturedAt)
    && capturedAt < matchClock.instant
  );
};

/**
 * Narrow compatibility rule for the historical result lane that represented
 * an unknown fixture clock as Beijing 00:00.  It is an identity alias only:
 * callers must still require a separate exact-event observation before the
 * resolved event can become active authority.
 */
const legacyMidnightFastResultAlias = (observation, match) => {
  if (
    !observation
    || !trustedOfficialFinal(match)
    || sourceMatchIdFor(observation) !== sourceMatchIdFor(match)
    || sameEvent(observation, match)
    || !immutableArchiveBindsFastResultEvent(match)
  ) {
    return false;
  }
  const receiptClock = fastResultEventClock(observation);
  const matchClock = fastResultEventClock(match);
  const observedAt = Date.parse(observation.resultObservedAt || "");
  return Boolean(
    receiptClock
    && matchClock
    && receiptClock.date === matchClock.date
    && receiptClock.clock === "00:00"
    && matchClock.clock !== "00:00"
    && Number.isFinite(observedAt)
    && observedAt >= matchClock.instant
  );
};

const failure = (mismatchKind, details = {}) => ({
  ok: false,
  reason: "legacy-receipt-history-mismatch",
  mismatchKind,
  ...details,
});

/**
 * Resolve receipt observations onto the single current trusted history row
 * for each immutable event.  Historical observations remain in their original
 * form and receipt root, but only an exact-event/current-score observation can
 * activate authority.  A midnight alias can therefore be retained for audit
 * without creating a second, fabricated authority event.
 */
const resolveFastResultReceiptAuthorities = ({ observations, historyRows }) => {
  const normalizedObservations = observationRows(observations);
  const normalizedHistory = (Array.isArray(historyRows) ? historyRows : [])
    .map((value, resolverIndex) => {
      const entry = value?.match ? value : { match: value };
      return { ...entry, resolverIndex };
    })
    .filter((entry) => trustedOfficialFinal(entry.match));
  const historyBySource = new Map();
  for (const entry of normalizedHistory) {
    const sourceMatchId = sourceMatchIdFor(entry.match);
    if (!sourceMatchId) continue;
    const rows = historyBySource.get(sourceMatchId) || [];
    rows.push(entry);
    historyBySource.set(sourceMatchId, rows);
  }

  const resolved = [];
  for (const observation of normalizedObservations) {
    const sourceMatchId = sourceMatchIdFor(observation);
    const sourceRows = historyBySource.get(sourceMatchId) || [];
    const exactRows = sourceRows.filter((entry) => sameEvent(entry.match, observation));
    const aliasRows = exactRows.length === 0
      ? sourceRows.filter((entry) => legacyMidnightFastResultAlias(observation, entry.match))
      : [];
    const candidates = exactRows.length > 0 ? exactRows : aliasRows;
    if (candidates.length !== 1) {
      return failure(
        candidates.length > 1
          ? "current-authority-event-ambiguous"
          : "current-authority-event-missing",
        {
          observationKey: observation.key,
          sourceHistoryRows: sourceRows.length,
          exactHistoryRows: exactRows.length,
          legacyAliasHistoryRows: aliasRows.length,
          eventHistoryRows: candidates.length,
          observationRows: 1,
        },
      );
    }
    const authorityEntry = candidates[0];
    const authorityIdentity = authorityIdentityKey({
      sourceMatchId: sourceMatchIdFor(authorityEntry.match),
      eventVersion: eventVersionOf(authorityEntry.match) || authorityEntry.match?.kickoffTime,
    });
    if (!authorityIdentity) {
      return failure("current-authority-event-identity-invalid", {
        observationKey: observation.key,
      });
    }
    resolved.push({
      observation,
      authorityEntry,
      authorityIdentity,
      mode: exactRows.length === 1 ? "exact-event" : "legacy-midnight-alias",
    });
  }

  const groupsByAuthority = new Map();
  for (const row of resolved) {
    const group = groupsByAuthority.get(row.authorityIdentity.key) || {
      authorityIdentity: row.authorityIdentity,
      authorityEntry: row.authorityEntry,
      resolvedObservations: [],
    };
    if (group.authorityEntry.resolverIndex !== row.authorityEntry.resolverIndex) {
      return failure("current-authority-event-ambiguous", {
        authorityEventKey: row.authorityIdentity.key,
        eventHistoryRows: 2,
      });
    }
    group.resolvedObservations.push(row);
    groupsByAuthority.set(row.authorityIdentity.key, group);
  }

  const groups = [];
  for (const group of groupsByAuthority.values()) {
    const activeRows = group.resolvedObservations.filter(({ observation, mode }) => (
      mode === "exact-event"
      && sameScore(group.authorityEntry.match, observation)
    ));
    if (activeRows.length !== 1) {
      return failure(
        activeRows.length === 0
          ? "current-authority-exact-observation-missing"
          : "current-authority-score-ambiguous",
        {
          authorityEventKey: group.authorityIdentity.key,
          eventHistoryRows: 1,
          observationRows: group.resolvedObservations.length,
          exactObservationRows: group.resolvedObservations
            .filter((row) => row.mode === "exact-event").length,
          currentScoreObservationRows: activeRows.length,
          legacyAliasObservationRows: group.resolvedObservations
            .filter((row) => row.mode === "legacy-midnight-alias").length,
        },
      );
    }
    groups.push({
      ...group,
      activeObservation: activeRows[0].observation,
      observations: group.resolvedObservations.map((row) => row.observation),
      legacyAliasObservations: group.resolvedObservations
        .filter((row) => row.mode === "legacy-midnight-alias")
        .map((row) => row.observation),
    });
  }

  groups.sort((left, right) => left.authorityIdentity.key.localeCompare(right.authorityIdentity.key));
  return {
    ok: true,
    observations: normalizedObservations,
    groups,
    authorityRows: groups.length,
    legacyAliasObservations: groups.reduce(
      (count, group) => count + group.legacyAliasObservations.length,
      0,
    ),
  };
};

module.exports = {
  fastResultEventClock,
  immutableArchiveBindsFastResultEvent,
  legacyMidnightFastResultAlias,
  resolveFastResultReceiptAuthorities,
};
