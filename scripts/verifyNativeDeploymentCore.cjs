"use strict";
// Deployment admission checks the serving data plane. Model/UI regression
// suites run separately and cannot promote a reference recommendation here.
const assert = require("node:assert/strict");
const { readStorageMode } = require("../server/storageMode.cjs");
const { nativeStorageReadiness } = require("./nativeStorageReadiness.cjs");
const { readPostgresWorkerObservation } = require("./postgresWorkerObservation.cjs");
// Return only fixed gate names and aggregate counts. Never print response
// payloads, connection errors, credentials or historical prediction contents.
function assessHealth(health) {
  const storage = nativeStorageReadiness(health), blockers = [...storage.blockers];
  if (health.status?.fastResultIntegrityOk !== true) blockers.push("fast-result-integrity-not-ready");
  if (health.status?.recommendationProjectionParityOk !== true) blockers.push("recommendation-projection-parity-not-ready");
  if (health.status?.recommendationReliable !== false) blockers.push("reference-model-reliability-contract-invalid");
  const parity = health.data?.recommendations?.projectionParity || {}, counts = {};
  for (const key of ["checkedRows", "preMatchRows", "resultPhaseRows", "listCanonicalMissingRows",
    "detailCanonicalMissingRows", "canonicalDecisionMismatchRows", "hadHhadProjectionMismatchRows", "mismatchRows"]) {
    counts[key] = Number.isSafeInteger(parity[key]) && parity[key] >= 0 ? parity[key] : null;
  }
  return { ok: blockers.length === 0, blockers, storage, projectionCounts: counts };
}
function requireHealth(health) {
  const report = assessHealth(health);
  if (!report.ok) {
    const error = new Error("NATIVE_DEPLOYMENT_HEALTH_REJECTED");
    error.diagnostic = { version: "native-deployment-core-failure-v1", phase: "health",
      blockers: report.blockers, projectionCounts: report.projectionCounts, productionWrites: 0 };
    throw error;
  }
  return report.storage;
}
async function verify() {
  assert.equal(readStorageMode().postgresOnly, true, "native-postgres-only-mode-required");
  const base = new URL(process.env.VERIFY_BASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
  const response = await fetch(new URL("/api/v1/health", base), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, "native-health-http-not-ready");
  const health = await response.json(), storage = requireHealth(health);
  const publication = await readPostgresWorkerObservation({
    validationStep: { ok: true }, generationStep: { ok: true }, projectionStep: { ok: true },
  });
  assert.equal(publication.ready, true, JSON.stringify(publication.blockers));
  return { ok: true, verifier: "native-deployment-core-v1", checkedAt: new Date().toISOString(),
    storage, publication, sourceRefreshOk: health.status?.serviceOk === true,
    recommendationMode: "reference-shadow", offlineRegressionSuitesDeferred: true };
}
if (require.main === module) verify().then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.diagnostic ? JSON.stringify(error.diagnostic) : error.message); process.exitCode = 1; });
module.exports = { verify, assessHealth, requireHealth };
