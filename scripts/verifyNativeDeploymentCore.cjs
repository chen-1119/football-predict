"use strict";
// Deployment admission checks the serving data plane. Model/UI regression
// suites run separately and cannot promote a reference recommendation here.
const assert = require("node:assert/strict");
const { readStorageMode } = require("../server/storageMode.cjs");
const { nativeStorageReadiness } = require("./nativeStorageReadiness.cjs");
const { readPostgresWorkerObservation } = require("./postgresWorkerObservation.cjs");
async function verify() {
  assert.equal(readStorageMode().postgresOnly, true);
  const base = new URL(process.env.VERIFY_BASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
  const response = await fetch(new URL("/api/v1/health", base), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const health = await response.json(), storage = nativeStorageReadiness(health);
  assert.equal(storage.ok, true, storage.blockers.join(","));
  assert.equal(health.status?.fastResultIntegrityOk, true);
  assert.equal(health.status?.recommendationProjectionParityOk, true);
  assert.equal(health.status?.recommendationReliable, false);
  const publication = await readPostgresWorkerObservation({
    validationStep: { ok: true }, generationStep: { ok: true }, projectionStep: { ok: true },
  });
  assert.equal(publication.ready, true, JSON.stringify(publication.blockers));
  return { ok: true, verifier: "native-deployment-core-v1", checkedAt: new Date().toISOString(),
    storage, publication, sourceRefreshOk: health.status?.serviceOk === true,
    recommendationMode: "reference-shadow", offlineRegressionSuitesDeferred: true };
}
if (require.main === module) verify().then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
