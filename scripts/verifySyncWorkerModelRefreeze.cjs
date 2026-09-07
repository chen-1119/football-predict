"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-model-refreeze-"));
process.env.SERVER_STORE_DIR = tempDir;
process.env.DATASTORE_SQLITE_PATH = path.join(tempDir, "football.db");
process.env.ENABLE_MODEL_BACKTEST_ON_SYNC = "1";

fs.writeFileSync(
  path.join(tempDir, "candidate-prospective-capture-status.json"),
  `${JSON.stringify({
    version: "prospective-deadline-heartbeat-v2",
    ok: true,
    skipped: true,
    reason: "candidate-implementation-drift-awaiting-refreeze",
  }, null, 2)}\n`,
);

try {
  const {
    assertCandidateImplementationRefreezeBacktest,
    candidateImplementationDriftAwaitingRefreeze,
    describeModelBacktestNeed,
  } = require("./runSyncWorker.cjs");
  const decision = describeModelBacktestNeed({
    sqliteStep: { ok: true },
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.candidateImplementationDrift, true);
  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, "candidate-implementation-drift");

  fs.writeFileSync(
    path.join(tempDir, "candidate-prospective-capture-status.json"),
    `${JSON.stringify({
      version: "prospective-deadline-heartbeat-v2",
      ok: true,
      skipped: true,
      reason: "registry-lock-busy",
    }, null, 2)}\n`,
  );
  const latchedDecision = describeModelBacktestNeed({
    sqliteStep: { ok: true },
    forceCandidateImplementationRefreeze: true,
  });
  assert.equal(latchedDecision.candidateImplementationDrift, true);
  assert.equal(latchedDecision.shouldRun, true);
  assert.equal(latchedDecision.reason, "candidate-implementation-drift");

  const evaluatedAt = "2026-09-05T00:20:12.754Z";
  const driftStatus = {
    version: "prospective-deadline-heartbeat-v2",
    captureMode: "deadline-only",
    evaluatedAt,
    ok: true,
    skipped: true,
    reason: "candidate-implementation-drift-awaiting-refreeze",
    candidateRevisionId: "candidate@test",
    blockers: ["semantic-hash-mismatch:candidate-probability-evaluator"],
    audit: {
      evaluatedAt,
      state: "ACTIVE",
      chainValid: true,
      rootHash: "a".repeat(64),
      candidateRevisionId: "candidate@test",
      decisionRecord: {
        version: "candidate-atomic-decision-record-v3",
        admittedRows: 8,
        atomicRows: 8,
        completeRows: 8,
        failedRows: 0,
        coverage: 1,
        complete: true,
      },
    },
  };
  assert.equal(candidateImplementationDriftAwaitingRefreeze(driftStatus), true);
  assert.equal(candidateImplementationDriftAwaitingRefreeze({
    ...driftStatus, blockers: ["semantic-hash-mismatch:result-input-timeline"],
  }), true, "a changed result-admission policy must trigger the existing refreeze path");
  assert.equal(candidateImplementationDriftAwaitingRefreeze({
    ...driftStatus,
    blockers: ["candidate-data-incomplete"],
  }), false);

  const completedRefreeze = {
    ok: true,
    skipped: false,
    decision: { candidateImplementationDrift: true },
  };
  assert.strictEqual(
    assertCandidateImplementationRefreezeBacktest(completedRefreeze),
    completedRefreeze,
  );
  for (const invalidStep of [
    { ok: false, skipped: false, decision: { candidateImplementationDrift: true } },
    { ok: true, skipped: true, decision: { candidateImplementationDrift: true } },
    { ok: true, skipped: false, decision: { candidateImplementationDrift: false } },
  ]) {
    assert.throws(
      () => assertCandidateImplementationRefreezeBacktest(invalidStep),
      (error) => error?.code === "CANDIDATE_IMPLEMENTATION_REFREEZE_INCOMPLETE",
    );
  }

  const workerSource = fs.readFileSync(path.join(__dirname, "runSyncWorker.cjs"), "utf8");
  const afterBacktestIndex = workerSource.indexOf("await onAfterModelBacktest(modelBacktestStep)");
  assert.ok(afterBacktestIndex > workerSource.indexOf("const modelBacktestStep ="));
  assert.ok(afterBacktestIndex < workerSource.indexOf('onBeforeHeavyStep("model:learn:autonomous")'));
  assert.match(
    workerSource,
    /assertCandidateImplementationRefreezeBacktest\(modelBacktestStep\)[\s\S]*candidateDeadlineHeartbeat\?\.waitForHealthy\(\)[\s\S]*candidateImplementationRefreezePending = false/,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "sync-worker-model-refreeze",
    assertions: 17,
    decision: {
      enabled: decision.enabled,
      shouldRun: decision.shouldRun,
      reason: decision.reason,
      candidateImplementationDrift: decision.candidateImplementationDrift,
    },
  }, null, 2)}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
