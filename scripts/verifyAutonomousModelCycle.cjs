"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildAutonomousCyclePlan,
  runAutonomousModelCycle: executeAutonomousModelCycle,
} = require("./autonomousModelCycle.cjs");
const {
  acquireLearningLease,
  activeModelPointer,
  openLearningLedger,
  releaseLearningLease,
  sha256,
  stableStringify,
  verifyLearningLedger,
} = require("./modelLearningLedger.cjs");
const {
  evaluateResidualMarketWalkForward,
} = require("./residualMarketWalkForward.cjs");
const {
  FEATURE_SCHEMA_VERSION,
  stableHash,
} = require("./residualMarketModel.cjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomous-model-cycle-"));
let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert.ok(condition, message);
};
const equal = (actual, expected, message) => {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
};
const rejects = (task, pattern, message) => {
  assertions += 1;
  assert.throws(task, pattern, message);
};

const makeRows = (count = 42) => {
  const outcomes = ["1", "X", "2"];
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const actual = outcomes[index % outcomes.length];
    const forecastTime = new Date(start + index * 86_400_000).toISOString();
    const currentModelProbabilities = actual === "1"
      ? { "1": 0.86, X: 0.08, "2": 0.06 }
      : actual === "X"
        ? { "1": 0.08, X: 0.86, "2": 0.06 }
        : { "1": 0.08, X: 0.06, "2": 0.86 };
    return {
      sourceMatchId: `synthetic-${String(index).padStart(3, "0")}`,
      forecastTime,
      resultObservedAt: new Date(start + index * 86_400_000 + 3_600_000).toISOString(),
      resultObservedAtFallback: false,
      actual,
      marketProbabilities: { "1": 0.5, X: 0.3, "2": 0.2 },
      currentModelProbabilities,
      currentModelObservedAt: forecastTime,
    };
  });
};

const buildEvaluation = (rows, generatedAt) => ({
  version: "model-evaluation-verifier-v1",
  generatedAt,
  residualMarketWalkForward: evaluateResidualMarketWalkForward(rows, {
    minTrainingRows: 12,
    holdoutRows: 6,
    minFolds: 3,
    iterations: 80,
    learningRate: 0.05,
  }),
  inputAudit: { ok: true, promotionEligible: false },
  promotionEvidenceAudit: {
    manifest: {
      promotionEligible: false,
      eligibleRows: 0,
      conflictingDuplicateKeys: 0,
      manifestHash: sha256("no-promotion-evidence"),
    },
  },
  recommendationSelection: { gate: { eligible: false } },
  riskTiers: { overall: { tier: "research" } },
});

const inferenceFile = path.join(__dirname, "residualMarketModel.cjs");
const contract = {
  inferenceImplementationHash: sha256(fs.readFileSync(inferenceFile)),
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  policyVersion: "multi-factor-market-evidence-v2",
};

const openTempLedger = (name) => {
  const dbPath = path.join(tempDir, name, "model-learning.db");
  const anchorFile = path.join(tempDir, name, "model-learning-head.json");
  return { ...openLearningLedger(dbPath), anchorFile };
};

const runCycle = (options) => executeAutonomousModelCycle({
  ...options,
  clock: options.clock || (() => options.runAt),
});

const rows = makeRows();
const evaluation = buildEvaluation(rows, "2026-01-01T00:00:00.000Z");
const residual = evaluation.residualMarketWalkForward;
check(residual.finalCandidate && residual.status === "evaluated-shadow", "synthetic residual candidate must be real");
check(residual.candidateReady === true, "synthetic residual candidate must pass its internal readiness gate");

try {
  const main = openTempLedger("main");
  try {
    const plan = buildAutonomousCyclePlan({ evaluation, contract });
    check(plan.legalCandidate, "canonical candidate must be legal");
    equal(plan.validationBlockers, [], "legal candidate must not have validation blockers");
    const first = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation,
      contract,
      runAt: "2026-01-02T00:00:00.000Z",
      capturedAt: "2026-01-01T23:59:00.000Z",
      holderId: "verifier-main-first",
    });
    equal(first.status, "registered-shadow", "valid candidate must be registered only as shadow");
    check(first.leaseReleased, "successful cycle must release its lease");
    check(first.activeModelPointerUnchanged, "shadow cycle must report an unchanged active pointer");
    equal(first.activeModelPointer.generation, 0, "shadow cycle must not increment active generation");
    equal(first.activeModelPointer.artifactHash, null, "shadow cycle must not activate an artifact");
    check(fs.existsSync(main.anchorFile), "successful cycle must write a ledger head anchor");

    const firstVerification = verifyLearningLedger(main.db);
    check(firstVerification.valid, "ledger must verify after shadow registration");
    equal(firstVerification.cycles, 1, "first run must create one deterministic cycle");
    equal(firstVerification.events, 6, "valid cycle must commit exactly six state events");
    equal(firstVerification.artifacts, 1, "valid cycle must commit exactly one candidate artifact");
    const states = main.db.prepare(
      "SELECT state FROM model_learning_events WHERE cycle_id=? ORDER BY cycle_sequence",
    ).all(first.cycleId).map((row) => row.state);
    equal(states, [
      "DATASET_DISCOVERED",
      "SNAPSHOT_FROZEN",
      "TRAINED",
      "EVALUATED",
      "ARTIFACT_COMMITTED",
      "REGISTERED_SHADOW",
    ], "valid cycle must follow the shadow-only state machine");

    const artifactRow = main.db.prepare("SELECT * FROM model_artifacts").get();
    const artifactCandidate = JSON.parse(Buffer.from(artifactRow.artifact_bytes).toString("utf8"));
    const metadata = JSON.parse(artifactRow.metadata_json);
    equal(artifactRow.artifact_hash, sha256(Buffer.from(artifactRow.artifact_bytes)), "artifact must be content addressed");
    equal(artifactCandidate.artifactHash, plan.candidate.artifactHash, "ledger bytes must contain the canonical candidate");
    equal(
      artifactCandidate.parametersHash,
      sha256(stableStringify(artifactCandidate.model.parameters)),
      "candidate parameter hash must bind the persisted parameters",
    );
    equal(metadata.parametersHash, artifactCandidate.parametersHash, "artifact metadata must carry the same parameter hash");
    equal(metadata.activePointerMutationAuthorized, false, "artifact metadata must forbid active pointer mutation");
    equal(metadata.productionEligible, false, "artifact metadata must remain non-production");

    const changedClockEvaluation = JSON.parse(JSON.stringify(evaluation));
    changedClockEvaluation.generatedAt = "2035-12-31T23:59:59.999Z";
    const second = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation: changedClockEvaluation,
      contract,
      runAt: "2027-04-05T06:07:08.000Z",
      capturedAt: "2027-04-05T06:00:00.000Z",
      holderId: "verifier-main-second",
    });
    equal(second.cycleId, first.cycleId, "run clocks and evaluation.generatedAt must not change cycle identity");
    check(second.lease.fencingToken > first.lease.fencingToken, "released lease must retain a monotonic fencing counter");
    const secondVerification = verifyLearningLedger(main.db);
    equal(secondVerification.events, 6, "idempotent retry must not duplicate events");
    equal(secondVerification.artifacts, 1, "idempotent retry must not duplicate artifacts");
    equal(secondVerification.cycles, 1, "idempotent retry must not duplicate cycles");
    equal(activeModelPointer(main.db).generation, 0, "idempotent retry must leave active generation at zero");

    const zeroEvaluation = buildEvaluation([], "2026-02-01T00:00:00.000Z");
    const zero = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation: zeroEvaluation,
      contract,
      runAt: "2026-02-02T00:00:00.000Z",
      holderId: "verifier-zero-first",
    });
    equal(zero.status, "rejected", "zero-sample evaluation must be rejected");
    check(zero.blockers.includes("residual-final-candidate-missing"), "zero-sample rejection must record the missing final candidate");
    const zeroStates = main.db.prepare(
      "SELECT state FROM model_learning_events WHERE cycle_id=? ORDER BY cycle_sequence",
    ).all(zero.cycleId).map((row) => row.state);
    equal(zeroStates, ["DATASET_DISCOVERED", "SNAPSHOT_FROZEN", "EVALUATED", "REJECTED"], "invalid candidate must take the fail-closed state path");
    const afterZero = verifyLearningLedger(main.db);
    equal(afterZero.artifacts, 1, "rejected zero-sample cycle must not commit an artifact");
    equal(afterZero.events, 10, "zero-sample cycle must add exactly four events");
    equal(afterZero.cycles, 2, "zero-sample evaluation must have its own deterministic cycle");
    equal(afterZero.pointer.generation, 0, "rejected cycle must leave active generation at zero");

    const zeroRetryEvaluation = JSON.parse(JSON.stringify(zeroEvaluation));
    zeroRetryEvaluation.generatedAt = "2040-01-01T00:00:00.000Z";
    const zeroRetry = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation: zeroRetryEvaluation,
      contract,
      runAt: "2028-02-02T00:00:00.000Z",
      capturedAt: "2028-02-01T00:00:00.000Z",
      holderId: "verifier-zero-second",
    });
    equal(zeroRetry.cycleId, zero.cycleId, "zero-sample retry must retain its cycle identity");
    const afterZeroRetry = verifyLearningLedger(main.db);
    equal(afterZeroRetry.events, 10, "zero-sample retry must not duplicate events");
    equal(afterZeroRetry.artifacts, 1, "zero-sample retry must not add an artifact");

    const notReadyEvaluation = JSON.parse(JSON.stringify(evaluation));
    const notReadyResidual = notReadyEvaluation.residualMarketWalkForward;
    notReadyResidual.candidateReady = false;
    notReadyResidual.internalCandidateBlockers = ["synthetic-readiness-blocker"];
    notReadyResidual.finalCandidate.candidateReady = false;
    notReadyResidual.finalCandidate.internalCandidateBlockers = ["synthetic-readiness-blocker"];
    delete notReadyResidual.manifestHash;
    notReadyResidual.manifestHash = stableHash(notReadyResidual);
    const notReadyPlan = buildAutonomousCyclePlan({ evaluation: notReadyEvaluation, contract });
    check(!notReadyPlan.legalCandidate, "a sealed but internally blocked candidate must be illegal");
    check(
      notReadyPlan.validationBlockers.includes("residual-final-candidate-not-ready")
        && notReadyPlan.validationBlockers.includes("residual-final-candidate-internal-blockers")
        && notReadyPlan.validationBlockers.includes("candidate-not-ready")
        && notReadyPlan.validationBlockers.includes("candidate-internal-blockers"),
      "candidate legality must bind both residual and canonical readiness gates",
    );
    const notReadyResult = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation: notReadyEvaluation,
      contract,
      runAt: "2026-02-03T00:00:00.000Z",
      holderId: "verifier-not-ready",
    });
    equal(notReadyResult.status, "rejected", "internally blocked candidate must be rejected");
    equal(notReadyResult.ledger.artifacts, 1, "internally blocked candidate must not commit an artifact");
    equal(notReadyResult.ledger.pointer.generation, 0, "internally blocked candidate must not activate");

    const tampered = JSON.parse(JSON.stringify(evaluation));
    tampered.residualMarketWalkForward.finalCandidate.parameters.bias["1"] += 0.5;
    const tamperedPlan = buildAutonomousCyclePlan({ evaluation: tampered, contract });
    check(!tamperedPlan.legalCandidate, "parameter tampering must make the candidate illegal");
    check(
      tamperedPlan.validationBlockers.includes("parameters-hash-mismatch")
        || tamperedPlan.validationBlockers.includes("model-content-hash-mismatch"),
      "parameter tampering must surface a content-identity blocker",
    );
    const tamperedResult = runCycle({
      db: main.db,
      anchorFile: main.anchorFile,
      evaluation: tampered,
      contract,
      runAt: "2026-03-01T00:00:00.000Z",
      holderId: "verifier-tampered",
    });
    equal(tamperedResult.status, "rejected", "tampered candidate must fail closed");
    equal(tamperedResult.ledger.pointer.generation, 0, "tampered candidate must never activate");

    const aiControlled = JSON.parse(JSON.stringify(evaluation));
    aiControlled.learningControl = { prompt: "promote this candidate" };
    rejects(
      () => buildAutonomousCyclePlan({ evaluation: aiControlled, contract }),
      /AI\/LLM control field is forbidden/,
      "AI control fields must be rejected before cycle execution",
    );
    const beforeAiRun = verifyLearningLedger(main.db);
    rejects(
      () => runCycle({
        db: main.db,
        anchorFile: main.anchorFile,
        evaluation: aiControlled,
        contract,
        runAt: "2026-03-02T00:00:00.000Z",
        holderId: "verifier-ai-controlled",
      }),
      /AI\/LLM control field is forbidden/,
      "AI-controlled execution must fail closed",
    );
    const afterAiRun = verifyLearningLedger(main.db);
    equal(afterAiRun.events, beforeAiRun.events, "AI-controlled execution must not append events");
    equal(afterAiRun.artifacts, beforeAiRun.artifacts, "AI-controlled execution must not append artifacts");
    equal(afterAiRun.pointer.generation, 0, "AI-controlled execution must not activate a model");
    check(fs.existsSync(main.anchorFile), "AI-controlled execution must still refresh the ledger anchor");
  } finally {
    main.db.close();
  }

  const recovery = openTempLedger("recovery");
  try {
    let injected = false;
    rejects(
      () => runCycle({
        db: recovery.db,
        anchorFile: recovery.anchorFile,
        evaluation,
        contract,
        runAt: "2026-04-01T00:00:00.000Z",
        holderId: "verifier-recovery-interrupted",
        onStateCommitted: ({ state }) => {
          if (state === "SNAPSHOT_FROZEN" && !injected) {
            injected = true;
            throw new Error("simulated-process-interruption");
          }
        },
      }),
      /simulated-process-interruption/,
      "verifier must simulate an interrupted learning cycle",
    );
    check(fs.existsSync(recovery.anchorFile), "interrupted cycle must still write a head anchor");
    equal(verifyLearningLedger(recovery.db).events, 2, "interrupted cycle must persist only completed states");
    const resumed = runCycle({
      db: recovery.db,
      anchorFile: recovery.anchorFile,
      evaluation,
      contract,
      runAt: "2026-04-02T00:00:00.000Z",
      holderId: "verifier-recovery-resumed",
    });
    equal(resumed.status, "registered-shadow", "retry must resume the interrupted shadow cycle");
    const recoveryVerification = verifyLearningLedger(recovery.db);
    equal(recoveryVerification.events, 6, "resumed cycle must not duplicate pre-interruption events");
    equal(recoveryVerification.cycles, 1, "resumed cycle must retain the original cycle identity");
    equal(recoveryVerification.artifacts, 1, "resumed cycle must commit one artifact");
    equal(recoveryVerification.pointer.generation, 0, "resumed cycle must remain shadow-only");
  } finally {
    recovery.db.close();
  }

  const evidenceRefresh = openTempLedger("evidence-refresh");
  try {
    const originalEvidence = runCycle({
      db: evidenceRefresh.db,
      anchorFile: evidenceRefresh.anchorFile,
      evaluation,
      contract,
      runAt: "2026-04-10T00:00:00.000Z",
      holderId: "verifier-evidence-original",
    });
    const refreshedEvaluation = JSON.parse(JSON.stringify(evaluation));
    refreshedEvaluation.riskTiers.overall.tier = "stable";
    const refreshedEvidence = runCycle({
      db: evidenceRefresh.db,
      anchorFile: evidenceRefresh.anchorFile,
      evaluation: refreshedEvaluation,
      contract,
      runAt: "2026-04-11T00:00:00.000Z",
      holderId: "verifier-evidence-refreshed",
    });
    check(originalEvidence.cycleId !== refreshedEvidence.cycleId, "new evidence must create a distinct evidence cycle");
    equal(originalEvidence.candidateBytesHash, refreshedEvidence.candidateBytesHash, "new evidence must reuse identical candidate bytes");
    equal(originalEvidence.ledgerArtifactHash, refreshedEvidence.ledgerArtifactHash, "new evidence must reuse the content-addressed model artifact");
    const refreshedVerification = verifyLearningLedger(evidenceRefresh.db);
    equal(refreshedVerification.cycles, 2, "two evidence sets must remain independently auditable");
    equal(refreshedVerification.events, 12, "each evidence set must retain its own six-state chain");
    equal(refreshedVerification.artifacts, 1, "identical model bytes must not duplicate the artifact");
    equal(refreshedVerification.pointer.generation, 0, "evidence refresh must remain shadow-only");
  } finally {
    evidenceRefresh.db.close();
  }

  const staleWorker = openTempLedger("stale-worker");
  try {
    let clockNow = "2026-04-20T00:00:00.000Z";
    let takeover = null;
    rejects(
      () => runCycle({
        db: staleWorker.db,
        anchorFile: staleWorker.anchorFile,
        evaluation,
        contract,
        runAt: clockNow,
        clock: () => clockNow,
        leaseTtlMs: 1_000,
        holderId: "verifier-stale-worker",
        onStateCommitted: ({ state }) => {
          if (state !== "SNAPSHOT_FROZEN" || takeover) return;
          clockNow = "2026-04-20T00:00:02.000Z";
          takeover = acquireLearningLease(staleWorker.db, {
            leaseName: "autonomous-model-learning",
            holderId: "verifier-takeover-worker",
            now: clockNow,
            ttlMs: 60_000,
          });
        },
      }),
      /holder or fencing token no longer owns the lease/,
      "expired worker must be fenced out after a new holder takes over",
    );
    check(takeover?.acquired === true && takeover.fencingToken > 1, "takeover worker must receive a newer fencing token");
    const staleVerification = verifyLearningLedger(staleWorker.db);
    check(staleVerification.valid, "partially written fenced cycle must leave a valid ledger");
    equal(staleVerification.events, 2, "stale worker must not write after snapshot freeze");
    equal(staleVerification.artifacts, 0, "stale worker must not commit an artifact");
    equal(staleVerification.pointer.generation, 0, "stale worker must not change active generation");
    check(fs.existsSync(staleWorker.anchorFile), "fenced-out worker must still anchor the valid ledger head");
    check(releaseLearningLease(staleWorker.db, {
      leaseName: takeover.leaseName,
      holderId: takeover.holderId,
      fencingToken: takeover.fencingToken,
    }).released, "takeover worker lease must be releasable");
  } finally {
    staleWorker.db.close();
  }

  const concurrency = openTempLedger("concurrency");
  try {
    const held = acquireLearningLease(concurrency.db, {
      leaseName: "autonomous-model-learning",
      holderId: "verifier-existing-holder",
      now: "2026-05-01T00:00:00.000Z",
      ttlMs: 60_000,
    });
    check(held.acquired, "setup holder must acquire the learning lease");
    const busy = runCycle({
      db: concurrency.db,
      anchorFile: concurrency.anchorFile,
      evaluation,
      contract,
      runAt: "2026-05-01T00:00:30.000Z",
      holderId: "verifier-competing-holder",
    });
    equal(busy.status, "lease-busy", "concurrent holder must fail closed on the lease");
    equal(verifyLearningLedger(concurrency.db).events, 0, "lease-busy attempt must not append cycle events");
    equal(activeModelPointer(concurrency.db).generation, 0, "lease-busy attempt must not change active generation");
    check(fs.existsSync(concurrency.anchorFile), "lease-busy attempt must still anchor the ledger head");
    check(releaseLearningLease(concurrency.db, {
      leaseName: held.leaseName,
      holderId: held.holderId,
      fencingToken: held.fencingToken,
    }).released, "setup holder must release the learning lease");
  } finally {
    concurrency.db.close();
  }

  console.log(JSON.stringify({
    ok: true,
    version: "verify-autonomous-model-cycle-v1",
    assertions,
    syntheticRows: rows.length,
    candidateReady: residual.candidateReady,
    residualFolds: residual.folds.length,
    policy: "Autonomous cycles may register immutable shadow candidates or reject invalid evidence; they cannot promote or mutate the active model pointer.",
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
