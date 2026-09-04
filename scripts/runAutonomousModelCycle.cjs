"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runAutonomousModelCycle,
} = require("./autonomousModelCycle.cjs");
const {
  openLearningLedger,
  sha256,
} = require("./modelLearningLedger.cjs");
const {
  FEATURE_SCHEMA_VERSION,
} = require("./residualMarketModel.cjs");

const rootDir = path.resolve(__dirname, "..");
const serverStoreDir = path.resolve(
  process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"),
);
const artifactDir = path.resolve(
  process.env.MODEL_LEARNING_ARTIFACT_DIR || path.join(serverStoreDir, "model-artifacts"),
);
const evaluationFile = path.resolve(
  process.env.MODEL_LEARNING_EVALUATION_FILE
    || path.join(rootDir, "public", "data", "model-evaluation.json"),
);
const ledgerFile = path.resolve(
  process.env.MODEL_LEARNING_LEDGER_FILE
    || path.join(artifactDir, "model-learning.db"),
);
const anchorFile = path.resolve(
  process.env.MODEL_LEARNING_ANCHOR_FILE
    || path.join(artifactDir, "model-learning-head.json"),
);
const inferenceFile = path.resolve(
  process.env.MODEL_LEARNING_INFERENCE_FILE
    || path.join(__dirname, "residualMarketModel.cjs"),
);

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const main = () => {
  if (!fs.existsSync(evaluationFile)) {
    throw new Error(`model evaluation not found: ${evaluationFile}`);
  }
  if (!fs.existsSync(inferenceFile)) {
    throw new Error(`residual inference implementation not found: ${inferenceFile}`);
  }
  const evaluation = JSON.parse(fs.readFileSync(evaluationFile, "utf8"));
  const runAt = process.env.MODEL_LEARNING_RUN_AT || new Date().toISOString();
  const { db, dbPath } = openLearningLedger(ledgerFile);
  try {
    const result = runAutonomousModelCycle({
      db,
      anchorFile,
      evaluation,
      contract: {
        inferenceImplementationHash: sha256(fs.readFileSync(inferenceFile)),
        featureSchemaVersion: process.env.MODEL_LEARNING_FEATURE_SCHEMA_VERSION
          || FEATURE_SCHEMA_VERSION,
        policyVersion: process.env.MODEL_LEARNING_POLICY_VERSION
          || "multi-factor-market-evidence-v2",
      },
      runAt,
      capturedAt: process.env.MODEL_LEARNING_CAPTURED_AT || null,
      actor: {
        type: "automation",
        id: process.env.MODEL_LEARNING_ACTOR_ID || "football-autonomous-model-cycle",
      },
      holderId: process.env.MODEL_LEARNING_LEASE_HOLDER_ID
        || `${os.hostname()}:${process.pid}`,
      leaseName: process.env.MODEL_LEARNING_LEASE_NAME || "autonomous-model-learning",
      leaseTtlMs: positiveInteger(process.env.MODEL_LEARNING_LEASE_TTL_MS, 15 * 60 * 1000),
      anchorHmacKey: process.env.MODEL_LEARNING_ANCHOR_HMAC_KEY || null,
    });
    console.log(JSON.stringify({
      ok: result.ok,
      version: result.version,
      status: result.status,
      evaluationFile,
      inferenceFile,
      ledgerFile: dbPath,
      anchorFile,
      cycleId: result.cycleId,
      candidateArtifactHash: result.candidateArtifactHash,
      ledgerArtifactHash: result.ledgerArtifactHash || null,
      evidenceHash: result.evidenceHash,
      candidateReady: result.candidateReady === true,
      blockers: result.blockers || [],
      idempotentLedger: {
        cycles: result.ledger?.cycles ?? null,
        events: result.ledger?.events ?? null,
        artifacts: result.ledger?.artifacts ?? null,
        valid: result.ledger?.valid ?? null,
      },
      lease: {
        acquired: result.lease?.acquired === true,
        fencingToken: result.lease?.fencingToken ?? null,
        released: result.leaseReleased === true,
      },
      activeModelPointer: result.activeModelPointer,
      activeModelPointerUnchanged: result.activeModelPointerUnchanged === true,
      anchorHash: result.anchor?.anchorHash || null,
      policy: "This runner can append shadow or rejection evidence only. It never emits PROMOTED and never calls active-model pointer CAS.",
    }, null, 2));
    if (!result.ok) process.exitCode = 2;
    return result;
  } finally {
    db.close();
  }
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = { main };
