"use strict";

const asRows = (value) => (Array.isArray(value) ? value : []);

/**
 * Protects the public current list from an empty SQLite projection while the
 * immutable generation paired with that database still contains fixtures.
 *
 * An empty current list can be legitimate after the last pending match moves
 * to history, so the guard only activates when the same serving generation is
 * demonstrably non-empty. The caller remains responsible for verifying the
 * SQLite/generation publication identity before invoking this selector.
 */
const selectCurrentPublicationRows = ({ sqliteRows, generationRows }) => {
  const sqlite = asRows(sqliteRows);
  const generation = asRows(generationRows);
  const sqliteEmptyGenerationDivergence = sqlite.length === 0 && generation.length > 0;

  return Object.freeze({
    rows: sqliteEmptyGenerationDivergence ? generation : sqlite,
    source: sqliteEmptyGenerationDivergence
      ? "generation-sqlite-empty-divergence"
      : "sqlite",
    degraded: sqliteEmptyGenerationDivergence,
    blockedReason: sqliteEmptyGenerationDivergence
      ? "sqlite-current-empty-generation-nonempty"
      : null,
    sqliteCount: sqlite.length,
    generationCount: generation.length,
  });
};

const sqliteGenerationCountDivergence = ({ sqliteCount, generationCount }) => {
  const safeSqliteCount = Math.max(0, Number(sqliteCount) || 0);
  const safeGenerationCount = Math.max(0, Number(generationCount) || 0);
  return Object.freeze({
    active: safeSqliteCount === 0 && safeGenerationCount > 0,
    blockedReason: safeSqliteCount === 0 && safeGenerationCount > 0
      ? "sqlite-current-empty-generation-nonempty"
      : null,
    sqliteCount: safeSqliteCount,
    generationCount: safeGenerationCount,
  });
};

/**
 * SQLite exporters replace the database atomically. On some filesystems there
 * is a very short interval where stat/open cannot see either pathname even
 * though the immutable generation is already complete and readable. Only
 * classify that interval as a publication transition when a healthy SQLite
 * read was observed very recently and the sync worker is still active.
 */
const sqliteAtomicReplacementFallbackActive = ({
  sqliteAvailable,
  generationAvailable,
  workerRunning,
  lastAvailableAtMs,
  nowMs = Date.now(),
  ttlMs = 30_000,
}) => {
  const lastSeen = Number(lastAvailableAtMs);
  const now = Number(nowMs);
  const ttl = Math.max(1, Number(ttlMs) || 30_000);
  return sqliteAvailable !== true
    && generationAvailable === true
    && workerRunning === true
    && Number.isFinite(lastSeen)
    && Number.isFinite(now)
    && now >= lastSeen
    && now - lastSeen <= ttl;
};

module.exports = {
  selectCurrentPublicationRows,
  sqliteGenerationCountDivergence,
  sqliteAtomicReplacementFallbackActive,
};
