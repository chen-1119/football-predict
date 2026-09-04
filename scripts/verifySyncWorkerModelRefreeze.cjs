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
    describeModelBacktestNeed,
  } = require("./runSyncWorker.cjs");
  const decision = describeModelBacktestNeed({
    sqliteStep: { ok: true },
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.candidateImplementationDrift, true);
  assert.equal(decision.shouldRun, true);
  assert.equal(decision.reason, "candidate-implementation-drift");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "sync-worker-model-refreeze",
    assertions: 4,
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
