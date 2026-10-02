"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const storeBefore = process.env.SERVER_STORE_DIR;
process.env.SERVER_STORE_DIR = path.join(os.tmpdir(), `source-shadow-worker-${randomUUID()}`);
const { observeWorkerSourceCollectionShadow: observe, workerHistoryFields } = require("../scripts/runSyncWorker.cjs");
if (storeBefore === undefined) delete process.env.SERVER_STORE_DIR;
else process.env.SERVER_STORE_DIR = storeBefore;
const { adaptSourceCollectorSnapshot } = require("../scripts/sourceCollectorShadowAdapter.cjs");
const { fetchEndpoint, collectorErrorRecord } = require("../scripts/collectSportterySnapshot.cjs");
const { createCollectorKeyPair } = require("../src/services/collectorAttestation.cjs");
const pair = createCollectorKeyPair({ keyId: "test-worker-shadow", independenceDomain: "test-worker-shadow" });
const url = "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001";
const baseMs = Date.parse("2026-10-02T11:00:00Z");
const at = seconds => new Date(baseMs + seconds * 1000).toISOString();
async function attempt(seconds, status = 567) {
  let tick = 0;
  const sourceCycleId = `test-cycle-${seconds}`;
  const payload = { success: true, errorCode: "0", value: { totalCount: 1,
    matchInfoList: [{ subMatchList: [{ matchId: "1" }] }] } };
  const rawBody = Buffer.from(JSON.stringify(payload));
  try {
    const entry = await fetchEndpoint({ id: "current", role: "current", url, sourceCycleId,
      clock: () => at(seconds + tick++), attestationSigner: pair, request: async () => {
        const response = { statusCode: status, headers: {}, rawBody, payload };
        if (status !== 200) { const error = new Error("fixture"); error.response = response; throw error; }
        return response;
      } });
    return { sourceCycleId, endpoints: [entry] };
  } catch (error) {
    return { sourceCycleId, errors: [collectorErrorRecord({ id: "current", url, sourceCycleId, error })] };
  }
}
const observeSnapshot = (snapshot, previous, seconds) => observe({
  enabled: true, asOf: at(seconds), previous, sourceFiles: ["memory-only"], readClosure: () => null,
  readFiles: (_files, options) => adaptSourceCollectorSnapshot(snapshot, { ...options, trustRegistry: pair.registry }),
});
function runningStatus(previous) {
  const original = process.env.SYNC_WORKER_SOURCE_SHADOW;
  process.env.SYNC_WORKER_SOURCE_SHADOW = "1";
  try { return { ok: true, cycleState: "running", ...workerHistoryFields({ sourceCollectionShadow: previous }) }; }
  finally {
    if (original === undefined) delete process.env.SYNC_WORKER_SOURCE_SHADOW;
    else process.env.SYNC_WORKER_SOURCE_SHADOW = original;
  }
}
test("disabled observer neither loads evidence nor carries shadow state into worker history", () => {
  const original = process.env.SYNC_WORKER_SOURCE_SHADOW;
  delete process.env.SYNC_WORKER_SOURCE_SHADOW;
  try {
    const noRead = () => { assert.fail("disabled observer must not read"); };
    assert.equal(observe({ asOf: at(10), readFiles: noRead, readClosure: noRead }), null);
    assert.equal(Object.hasOwn(workerHistoryFields({ sourceCollectionShadow: { consecutiveFailures: 2 } }), "sourceCollectionShadow"), false);
  } finally {
    if (original !== undefined) process.env.SYNC_WORKER_SOURCE_SHADOW = original;
  }
});
test("failed to running to failed retains the sequence and repeat attempts keep the same retry clock", async () => {
  const firstSnapshot = await attempt(0);
  const first = observeSnapshot(firstSnapshot, null, 5);
  const running = runningStatus(first);
  const repeat = observeSnapshot(firstSnapshot, running.sourceCollectionShadow, 10);
  assert.equal(repeat.consecutiveFailures, 1);
  assert.equal(repeat.repeatedObservation, true);
  assert.equal(repeat.nextAttemptAt, first.nextAttemptAt);
  const second = observeSnapshot(await attempt(20), runningStatus(repeat).sourceCollectionShadow, 25);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.retryAfterSeconds, 43200);
  const reloaded = JSON.parse(JSON.stringify(runningStatus(second)));
  const third = observeSnapshot(await attempt(30), reloaded.sourceCollectionShadow, 35);
  assert.equal(third.consecutiveFailures, 3);
  assert.equal(third.retryAfterSeconds, 86400);
});
test("verified source success resets the sequence and the next new failure starts at one", async () => {
  const first = observeSnapshot(await attempt(0), null, 5);
  const second = observeSnapshot(await attempt(10), runningStatus(first).sourceCollectionShadow, 15);
  const success = observeSnapshot(await attempt(20, 200), runningStatus(second).sourceCollectionShadow, 25);
  assert.equal(success.state, "available");
  assert.equal(success.evidence.signatureVerified, true);
  assert.equal(success.consecutiveFailures, 0);
  const next = observeSnapshot(await attempt(30), runningStatus(success).sourceCollectionShadow, 35);
  assert.equal(next.consecutiveFailures, 1);
  assert.equal(next.retryAfterSeconds, 21600);
  for (const value of [first, second, success, next]) {
    assert.equal(value.shadowOnly, true);
    assert.equal(value.publicationAction, "none");
    assert.equal(value.schedulingApplied, false);
  }
});
test("observer exceptions preserve the sequence without escaping into the worker error handler", async () => {
  const snapshot = await attempt(0), first = observeSnapshot(snapshot, null, 5);
  const unknown = observe({ enabled: true, asOf: at(10), previous: runningStatus(first).sourceCollectionShadow,
    sourceFiles: ["memory-only"], readClosure: () => null, readFiles: () => { throw new Error("fixture"); } });
  assert.equal(unknown.state, "unknown-evidence");
  assert.equal(unknown.consecutiveFailures, 1);
  assert.equal(unknown.attemptKey, first.attemptKey);
  assert.equal(unknown.nextAttemptAt, null);
  const repeat = observeSnapshot(snapshot, runningStatus(unknown).sourceCollectionShadow, 15);
  assert.equal(repeat.consecutiveFailures, 1);
  assert.equal(repeat.nextAttemptAt, first.nextAttemptAt);
});
test("unproven source success cannot reset a failure sequence", async () => {
  const first = observeSnapshot(await attempt(0), null, 5);
  const response = await attempt(10, 200);
  response.endpoints[0].collectorAttestation.signature = "invalid";
  const unknown = observeSnapshot(response, runningStatus(first).sourceCollectionShadow, 15);
  assert.equal(unknown.state, "unknown-evidence");
  assert.equal(unknown.consecutiveFailures, 1);
  assert.equal(unknown.nextAttemptAt, null);
  const next = observeSnapshot(await attempt(20), runningStatus(unknown).sourceCollectionShadow, 25);
  assert.equal(next.consecutiveFailures, 2);
});
