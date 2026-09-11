"use strict";
// One named coverage contract shared by the producer and production admission.
const VERIFIER = "production-fixture-isolation-v2";
const SCRIPTS = Object.freeze([
  "verifyPostgresMigrationPlan.cjs",
  "verifyAccessCodeConcurrency.cjs",
  "verifySportteryRelayFullRecovery.cjs",
]);
const STORAGE_MODES = Object.freeze(["postgres-only", "hybrid"]);
const CASES = Object.freeze(SCRIPTS.flatMap(script => STORAGE_MODES.map(inheritedStorage =>
  Object.freeze({ script, inheritedStorage }))));
const key = row => JSON.stringify([row?.script, row?.inheritedStorage]);
function isolationReportPassed(report) {
  if (report?.verifier !== VERIFIER || report.ok !== true || !Array.isArray(report.checks)) return false;
  const remaining = new Set(CASES.map(key));
  for (const row of report.checks) {
    if (row?.ok !== true || row.status !== 0 || row.signal !== null || row.error != null
      || !remaining.delete(key(row))) return false;
  }
  return remaining.size === 0;
}
module.exports = { VERIFIER, CASES, isolationReportPassed };
