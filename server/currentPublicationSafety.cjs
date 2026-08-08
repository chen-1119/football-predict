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

module.exports = {
  selectCurrentPublicationRows,
  sqliteGenerationCountDivergence,
};
