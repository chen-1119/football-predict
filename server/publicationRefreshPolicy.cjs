"use strict";

// A native PostgreSQL projection changes atomically. The resolver still binds
// it to a fully verified immutable generation before replacing the read cache.
// Waiting for the whole enrichment/sync job after that commit blocks readers
// unnecessarily. Pointer writes and legacy multi-store publication still wait.
const publicationRefreshBlocked = ({ postgresOnly, pointerLocked, syncLocked }) => (
  Boolean(pointerLocked || (!postgresOnly && syncLocked))
);

const nativePublicationReadError = (status, transitionActive) => {
  const transitioning = transitionActive === true && status?.available === true
    && status.baseReady === false && status.baseBlockedReason === "postgres-generation-mismatch";
  const error = new Error(transitioning
    ? "PostgreSQL publication switch is being verified; retry shortly"
    : "PostgreSQL publication is unavailable; refusing legacy data fallback");
  error.code = transitioning ? "POSTGRES_PUBLICATION_TRANSITION" : "POSTGRES_REQUIRED_READ_UNAVAILABLE";
  error.statusCode = 503;
  if (transitioning) error.postgresStatus = status;
  return error;
};

const publicationTransitionHealth = (fallback, error) => {
  const pg = error?.postgresStatus;
  if (error?.code !== "POSTGRES_PUBLICATION_TRANSITION" || pg?.available !== true
    || pg.baseReady !== false || pg.baseBlockedReason !== "postgres-generation-mismatch") return fallback;
  return {
    ...fallback,
    status: { ...fallback.status, serviceOk: true, publicationTransitioning: true },
    sync: { ...fallback.sync, running: true, workerState: "publication-transition" },
    data: {
      ...fallback.data, source: "postgres", updatedAt: pg.syncMetaUpdatedAt || null,
      currentCount: pg.counts.currentMatches, historyCount: pg.counts.historyMatches,
      currentRead: { source: "postgres-publication-transition", stale: true,
        blockedReason: "postgres-generation-mismatch", count: pg.counts.currentMatches },
    },
    storage: { ...fallback.storage, primary: "postgres", postgres: pg },
  };
};

// Only the generation supplying the displayed rows can date that publication.
// Probing it, or importing it into a database again, does not advance its source clock.
const currentPublicationAgeSeconds = (meta, nowMs) => {
  // sourceUpdatedAt is the producer's observation persisted with the rows.
  // currentFreshnessTime and fileUpdatedAt may also advance on a result-only write.
  const clocks = [meta?.api?.sourceUpdatedAt];
  if (String(meta?.sourceAttempt?.transport || meta?.api?.transport || "").startsWith("relay")) {
    clocks.push(meta?.sourceAttempt?.relayCurrentLaneCapturedAt);
  }
  const times = clocks.map(clock => typeof clock === "string" ? Date.parse(clock) : NaN);
  if (!Number.isFinite(nowMs) || times.some(time => !Number.isFinite(time) || time > nowMs)) return null;
  return (nowMs - Math.min(...times)) / 1000;
};

module.exports = { publicationRefreshBlocked, nativePublicationReadError, publicationTransitionHealth, currentPublicationAgeSeconds };
