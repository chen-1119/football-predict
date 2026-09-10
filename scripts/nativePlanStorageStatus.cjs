"use strict";
const { openPostgresRuntimeReadSession } = require("./postgresRuntimeReadSession.cjs");
// This is a direct warehouse audit, not a fabricated SQLite health response.
// Counts, receipt and immutable publication binding share one read snapshot.
async function readNativePlanStorageStatus(options = {}) {
  const session = await openPostgresRuntimeReadSession(options);
  try {
    const receipt = await session.receipt();
    const rows = await session.client.query(`SELECT
      (SELECT count(*) FROM football.match_snapshots WHERE dataset='current')::text AS current,
      (SELECT count(*) FROM football.match_snapshots WHERE dataset='history')::text AS history,
      (SELECT count(*) FROM football.odds_snapshots)::text AS odds,
      (SELECT count(*) FROM football.prediction_snapshots)::text AS predictions`);
    const row = rows.rows[0];
    const counts = Object.fromEntries(Object.entries({ currentMatches: row.current, historyMatches: row.history,
      oddsSnapshots: row.odds, predictionSnapshots: row.predictions }).map(([key, value]) => {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("unsafe native warehouse count");
      return [key, Number(value)];
    }));
    return { available: true, storage: "postgres", statusSource: "postgres-repeatable-read",
      counts, publication: session.identity, receipt, receiptValid: true, sqliteAccesses: 0 };
  } finally { await session.close(); }
}
module.exports = { readNativePlanStorageStatus };
