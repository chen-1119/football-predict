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

module.exports = { publicationRefreshBlocked, nativePublicationReadError, publicationTransitionHealth };
