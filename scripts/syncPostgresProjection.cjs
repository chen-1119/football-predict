"use strict";

const { syncPostgresProjectionFromSqlite } = require("./postgresProjectionSync.cjs");

const postgresMode = String(process.env.FOOTBALL_POSTGRES_MODE || "disabled").trim().toLowerCase();
const ifEnabled = process.argv.includes("--if-enabled");
const modeArg = process.argv.find((value) => value.startsWith("--mode="));
const requestedMode = modeArg ? modeArg.slice("--mode=".length) : null;

const main = async () => {
  if (ifEnabled && postgresMode === "disabled") {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "postgres-disabled",
      postgresMode,
    }, null, 2));
    return;
  }
  const mode = requestedMode
    || (process.argv.includes("--backfill") ? "backfill" : "incremental");
  const result = await syncPostgresProjectionFromSqlite({
    mode,
    force: process.argv.includes("--force"),
  });
  console.log(JSON.stringify({ ...result, postgresMode }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || null,
    error: error.message || String(error),
    reviewId: error.reviewId || null,
    existingMatchId: error.existingMatchId || null,
    incomingMatchId: error.incomingMatchId || null,
    existingObservationId: error.existingObservationId || null,
    incomingObservationId: error.incomingObservationId || null,
    existingIdentity: error.existingIdentity || null,
    incomingIdentity: error.incomingIdentity || null,
  }, null, 2));
  process.exitCode = 1;
});
