"use strict";
const { readStorageMode } = require("../server/storageMode.cjs");
const { mergeFastResultObservations, recentFastObservationSourceIds } = require("./fastResultObservations.cjs");

async function readRuntimeFastResultInput({ sqlitePath, existingObservations = [], receiptOnly = false, ...options } = {}) {
  if (!readStorageMode().postgresOnly) {
    const { readSqliteFastResultReceipt, readSqliteTransitionMatches } = require("../server/sqliteStore.cjs");
    const receipt = await readSqliteFastResultReceipt(sqlitePath);
    const ids = recentFastObservationSourceIds(mergeFastResultObservations(existingObservations, receipt?.observations || []), 256);
    const finals = receiptOnly || !ids.length ? [] : await readSqliteTransitionMatches(sqlitePath, { sourceMatchIds: ids, limit: 256 });
    return { receipt, finals, storage: "sqlite" };
  }
  const session = await require("./postgresRuntimeReadSession.cjs").openPostgresRuntimeReadSession(options);
  try {
    const receipt = await session.receipt();
    const ids = recentFastObservationSourceIds(mergeFastResultObservations(existingObservations, receipt?.observations || []), 256);
    // Only receipt-bound events participate in the overlay. Read every matching
    // history row in this same snapshot; never truncate away an event alias.
    const finals = receiptOnly ? [] : await session.historyForSourceIds(ids);
    return { receipt, finals, storage: "postgres" };
  } finally { await session.close(); }
}
module.exports = { readRuntimeFastResultInput };
