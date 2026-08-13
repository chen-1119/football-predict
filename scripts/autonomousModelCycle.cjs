"use strict";

const {
  buildCandidateFromEvaluation,
  buildLearningEvidenceFromEvaluation,
  sha256,
  stableStringify,
} = require("./modelLearningRegistry.cjs");
const {
  acquireLearningLease,
  activeModelPointer,
  appendLearningEvent,
  commitModelArtifact,
  releaseLearningLease,
  verifyLearningLedger,
  writeLedgerHeadAnchor,
} = require("./modelLearningLedger.cjs");
const { verifyManifestHash } = require("./residualMarketWalkForward.cjs");

const AUTONOMOUS_MODEL_CYCLE_VERSION = "autonomous-model-cycle-v1";
const DEFAULT_LEASE_NAME = "autonomous-model-learning";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class AutonomousModelCycleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AutonomousModelCycleError";
    this.code = details.code || "AUTONOMOUS_MODEL_CYCLE_ERROR";
    Object.assign(this, details);
  }
}

const canonicalIso = (value, field) => {
  const millis = Date.parse(String(value || ""));
  if (!Number.isFinite(millis)) {
    throw new AutonomousModelCycleError(`${field} must be a valid timestamp`, {
      code: "INVALID_TIMESTAMP",
      field,
    });
  }
  return new Date(millis).toISOString();
};

const nonempty = (value, field) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new AutonomousModelCycleError(`${field} is required`, {
      code: "MISSING_FIELD",
      field,
    });
  }
  return normalized;
};

const assertHash = (value, field) => {
  const normalized = String(value || "");
  if (!HASH_PATTERN.test(normalized)) {
    throw new AutonomousModelCycleError(`${field} must be a sha256 hash`, {
      code: "INVALID_HASH",
      field,
    });
  }
  return normalized;
};

const stableClone = (value) => JSON.parse(stableStringify(value));

const pointerIdentity = (pointer) => ({
  generation: Number(pointer?.generation || 0),
  artifactHash: pointer?.artifactHash || null,
  previousArtifactHash: pointer?.previousArtifactHash || null,
  eventHash: pointer?.eventHash || null,
  updatedAt: pointer?.updatedAt || null,
});

const pointersEqual = (left, right) => stableStringify(pointerIdentity(left)) === stableStringify(pointerIdentity(right));

const canonicalActor = (actor = {}) => {
  const type = nonempty(actor.type || "automation", "actor.type");
  if (type !== "automation") {
    throw new AutonomousModelCycleError("autonomous learning cycles require actor.type=automation", {
      code: "ACTOR_TYPE_FORBIDDEN",
    });
  }
  return { type, id: nonempty(actor.id || "football-autonomous-model-cycle", "actor.id") };
};

const canonicalContract = (contract = {}) => ({
  inferenceImplementationHash: assertHash(
    contract.inferenceImplementationHash,
    "contract.inferenceImplementationHash",
  ),
  featureSchemaVersion: nonempty(contract.featureSchemaVersion, "contract.featureSchemaVersion"),
  policyVersion: nonempty(contract.policyVersion, "contract.policyVersion"),
  algorithmVersion: contract.algorithmVersion ? String(contract.algorithmVersion).trim() : null,
  modelVersion: contract.modelVersion ? String(contract.modelVersion).trim() : null,
  modelHash: contract.modelHash ? assertHash(contract.modelHash, "contract.modelHash") : null,
  trainingDataHash: contract.trainingDataHash
    ? assertHash(contract.trainingDataHash, "contract.trainingDataHash")
    : null,
  metricsManifestHash: contract.metricsManifestHash
    ? assertHash(contract.metricsManifestHash, "contract.metricsManifestHash")
    : null,
  trainedThrough: contract.trainedThrough
    ? canonicalIso(contract.trainedThrough, "contract.trainedThrough")
    : null,
});

const buildAutonomousCyclePlan = ({ evaluation, contract } = {}) => {
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    throw new AutonomousModelCycleError("evaluation must be an object", {
      code: "INVALID_EVALUATION",
    });
  }
  const normalizedContract = canonicalContract(contract);
  const candidate = buildCandidateFromEvaluation(evaluation, normalizedContract);
  const evidence = buildLearningEvidenceFromEvaluation(evaluation, normalizedContract);
  const residual = evaluation.residualMarketWalkForward || {};
  const finalCandidatePresent = Boolean(
    residual.finalCandidate
    && typeof residual.finalCandidate === "object"
    && !Array.isArray(residual.finalCandidate),
  );
  const blockers = [];
  if (!finalCandidatePresent) blockers.push("residual-final-candidate-missing");
  if (!verifyManifestHash(residual)) blockers.push("residual-manifest-integrity-invalid");
  if (residual.candidateReady !== true) blockers.push("residual-final-candidate-not-ready");
  if (Array.isArray(residual.internalCandidateBlockers)
      && residual.internalCandidateBlockers.length > 0) {
    blockers.push("residual-final-candidate-internal-blockers");
  }
  blockers.push(...(Array.isArray(candidate.validationBlockers) ? candidate.validationBlockers : []));
  if (candidate.candidateReady !== true) blockers.push("candidate-not-ready");
  if (Array.isArray(candidate.internalCandidateBlockers)
      && candidate.internalCandidateBlockers.length > 0) {
    blockers.push("candidate-internal-blockers");
  }
  if (candidate.shadowOnly !== true) blockers.push("candidate-shadow-only-required");
  if (candidate.productionEligible !== false) {
    blockers.push("candidate-self-production-eligibility-invalid");
  }
  if (candidate.inferenceImplementationHash !== normalizedContract.inferenceImplementationHash) {
    blockers.push("inference-implementation-contract-mismatch");
  }
  if (candidate.featureSchemaVersion !== normalizedContract.featureSchemaVersion) {
    blockers.push("feature-schema-contract-mismatch");
  }
  if (candidate.policyVersion !== normalizedContract.policyVersion) {
    blockers.push("policy-contract-mismatch");
  }
  const validationBlockers = Array.from(new Set(blockers.map(String))).sort();
  const evidenceHash = sha256(stableStringify(evidence));
  const candidateBytes = Buffer.from(stableStringify(candidate), "utf8");
  const candidateBytesHash = sha256(candidateBytes);
  const identity = {
    version: AUTONOMOUS_MODEL_CYCLE_VERSION,
    candidateArtifactHash: candidate.artifactHash,
    candidateBytesHash,
    evidenceHash,
    inferenceImplementationHash: normalizedContract.inferenceImplementationHash,
    featureSchemaVersion: normalizedContract.featureSchemaVersion,
    featureSchemaHash: candidate.featureSchemaHash,
    policyVersion: normalizedContract.policyVersion,
    algorithmVersion: candidate.algorithmVersion,
    modelVersion: candidate.modelVersion,
    modelHash: candidate.modelHash,
    trainingDataHash: candidate.trainingDataHash,
    parametersHash: candidate.parametersHash,
    metricsManifestHash: candidate.metricsManifestHash,
    sourceEvaluationVersion: evidence.sourceEvaluationVersion,
    finalCandidatePresent,
    validationBlockers,
  };
  const cycleId = sha256(stableStringify(identity));
  return {
    version: AUTONOMOUS_MODEL_CYCLE_VERSION,
    cycleId,
    identity: stableClone(identity),
    candidate,
    candidateBytes,
    candidateBytesHash,
    evidence,
    evidenceHash,
    finalCandidatePresent,
    validationBlockers,
    legalCandidate: finalCandidatePresent && validationBlockers.length === 0,
  };
};

const eventKeyFor = (cycleId, state) => sha256(stableStringify({
  version: AUTONOMOUS_MODEL_CYCLE_VERSION,
  cycleId,
  state,
}));

const appendCycleEvent = (db, plan, {
  state,
  eventType,
  occurredAt,
  actor,
  payload,
  artifactHash = null,
  lease = null,
}) => appendLearningEvent(db, {
  cycleId: plan.cycleId,
  eventKey: eventKeyFor(plan.cycleId, state),
  eventType,
  state,
  occurredAt,
  actor,
  payload,
  artifactHash,
  lease,
});

const baseEventPayload = (plan) => ({
  cycleVersion: AUTONOMOUS_MODEL_CYCLE_VERSION,
  candidateArtifactHash: plan.candidate.artifactHash,
  candidateBytesHash: plan.candidateBytesHash,
  evidenceHash: plan.evidenceHash,
  trainingDataHash: plan.candidate.trainingDataHash,
  metricsManifestHash: plan.candidate.metricsManifestHash,
  activePointerMutationAuthorized: false,
});

const runAutonomousModelCycle = ({
  db,
  anchorFile,
  evaluation,
  contract,
  runAt = new Date().toISOString(),
  capturedAt = null,
  actor = { type: "automation", id: "football-autonomous-model-cycle" },
  holderId = `autonomous-model-cycle:${process.pid}`,
  leaseName = DEFAULT_LEASE_NAME,
  leaseTtlMs = 15 * 60 * 1000,
  anchorHmacKey = null,
  onStateCommitted = null,
  clock = () => new Date().toISOString(),
} = {}) => {
  if (!db || typeof db.prepare !== "function") {
    throw new AutonomousModelCycleError("an open model learning ledger database is required", {
      code: "LEDGER_DB_REQUIRED",
    });
  }
  const resolvedAnchorFile = nonempty(anchorFile, "anchorFile");
  const occurredAt = canonicalIso(runAt, "runAt");
  let observationCapturedAt;
  let normalizedActor;
  let plan;
  let activeBefore;
  try {
    observationCapturedAt = capturedAt ? canonicalIso(capturedAt, "capturedAt") : null;
    normalizedActor = canonicalActor(actor);
    plan = buildAutonomousCyclePlan({ evaluation, contract });
    activeBefore = activeModelPointer(db);
  } catch (error) {
    try {
      writeLedgerHeadAnchor(db, resolvedAnchorFile, {
        generatedAt: occurredAt,
        hmacKey: anchorHmacKey,
      });
    } catch (anchorError) {
      error.anchorError = anchorError?.message || String(anchorError);
    }
    throw error;
  }
  const record = (entry) => {
    if (!lease?.acquired) {
      throw new AutonomousModelCycleError("a live fenced lease is required for cycle events", {
        code: "LEASE_FENCE_REQUIRED",
      });
    }
    const checkedAt = canonicalIso(
      typeof clock === "function" ? clock() : clock,
      "clock",
    );
    const committed = appendCycleEvent(db, plan, {
      ...entry,
      occurredAt: checkedAt,
      lease: {
        leaseName: lease.leaseName,
        holderId: lease.holderId,
        fencingToken: lease.fencingToken,
        checkedAt,
      },
    });
    if (typeof onStateCommitted === "function") {
      onStateCommitted({
        cycleId: plan.cycleId,
        state: entry.state,
        eventHash: committed.eventHash,
        idempotent: committed.idempotent,
      });
    }
    return committed;
  };
  let lease = null;
  let leaseReleased = false;
  let anchor = null;
  let result = null;
  let failure = null;

  try {
    lease = acquireLearningLease(db, {
      leaseName: nonempty(leaseName, "leaseName"),
      holderId: nonempty(holderId, "holderId"),
      now: occurredAt,
      ttlMs: leaseTtlMs,
    });
    if (!lease.acquired) {
      result = {
        ok: false,
        status: "lease-busy",
        version: AUTONOMOUS_MODEL_CYCLE_VERSION,
        cycleId: plan.cycleId,
        candidateArtifactHash: plan.candidate.artifactHash,
        evidenceHash: plan.evidenceHash,
        lease,
      };
    } else {
      const common = baseEventPayload(plan);
      record({
        state: "DATASET_DISCOVERED",
        eventType: "DATASET_DISCOVERED",
        occurredAt,
        actor: normalizedActor,
        payload: {
          ...common,
          sourceEvaluationVersion: plan.evidence.sourceEvaluationVersion,
        },
      });
      record({
        state: "SNAPSHOT_FROZEN",
        eventType: "SNAPSHOT_FROZEN",
        occurredAt,
        actor: normalizedActor,
        payload: {
          ...common,
          cycleIdentity: plan.identity,
          finalCandidatePresent: plan.finalCandidatePresent,
        },
      });

      let ledgerArtifact = null;
      if (plan.legalCandidate) {
        record({
          state: "TRAINED",
          eventType: "MODEL_TRAINED",
          occurredAt,
          actor: normalizedActor,
          payload: {
            ...common,
            modelHash: plan.candidate.modelHash,
            parametersHash: plan.candidate.parametersHash,
            featureSchemaHash: plan.candidate.featureSchemaHash,
            trainedThrough: plan.candidate.trainedThrough,
          },
        });
      }

      record({
        state: "EVALUATED",
        eventType: "CANDIDATE_EVALUATED",
        occurredAt,
        actor: normalizedActor,
        payload: {
          ...common,
          decision: plan.legalCandidate ? "register-shadow" : "reject",
          candidateReady: plan.candidate.candidateReady === true,
          internalCandidateBlockers: plan.candidate.internalCandidateBlockers,
          validationBlockers: plan.validationBlockers,
        },
      });

      if (plan.legalCandidate) {
        ledgerArtifact = commitModelArtifact(db, {
          bytes: plan.candidateBytes,
          artifactType: "residual-market-shadow-candidate",
          mediaType: "application/vnd.football.model-candidate+json",
          metadata: {
            version: "autonomous-model-artifact-metadata-v1",
            candidateId: plan.candidate.candidateId,
            candidateArtifactHash: plan.candidate.artifactHash,
            candidateBytesHash: plan.candidateBytesHash,
            inferenceImplementationHash: plan.candidate.inferenceImplementationHash,
            featureSchemaVersion: plan.candidate.featureSchemaVersion,
            featureSchemaHash: plan.candidate.featureSchemaHash,
            policyVersion: plan.candidate.policyVersion,
            modelHash: plan.candidate.modelHash,
            trainingDataHash: plan.candidate.trainingDataHash,
            parametersHash: plan.candidate.parametersHash,
            metricsManifestHash: plan.candidate.metricsManifestHash,
            shadowOnly: true,
            productionEligible: false,
            activePointerMutationAuthorized: false,
          },
          createdAt: occurredAt,
          declaredHash: plan.candidateBytesHash,
        });
        record({
          state: "ARTIFACT_COMMITTED",
          eventType: "ARTIFACT_COMMITTED",
          occurredAt,
          actor: normalizedActor,
          artifactHash: ledgerArtifact.artifactHash,
          payload: {
            ...common,
            ledgerArtifactHash: ledgerArtifact.artifactHash,
            byteLength: ledgerArtifact.byteLength,
          },
        });
        record({
          state: "REGISTERED_SHADOW",
          eventType: "REGISTERED_SHADOW",
          occurredAt,
          actor: normalizedActor,
          artifactHash: ledgerArtifact.artifactHash,
          payload: {
            ...common,
            ledgerArtifactHash: ledgerArtifact.artifactHash,
            candidateReady: plan.candidate.candidateReady === true,
            internalCandidateBlockers: plan.candidate.internalCandidateBlockers,
            shadowOnly: true,
            productionEligible: false,
          },
        });
      } else {
        record({
          state: "REJECTED",
          eventType: "CANDIDATE_REJECTED",
          occurredAt,
          actor: normalizedActor,
          payload: {
            ...common,
            blockers: plan.validationBlockers,
            finalCandidatePresent: plan.finalCandidatePresent,
          },
        });
      }

      const activeAfter = activeModelPointer(db);
      if (!pointersEqual(activeBefore, activeAfter)) {
        throw new AutonomousModelCycleError("shadow cycle changed the active model pointer", {
          code: "ACTIVE_POINTER_MUTATED",
          activeBefore,
          activeAfter,
        });
      }
      const verification = verifyLearningLedger(db);
      if (!verification.valid) {
        throw new AutonomousModelCycleError("model learning ledger failed verification", {
          code: "LEDGER_INVALID",
          errors: verification.errors,
        });
      }
      result = {
        ok: true,
        status: plan.legalCandidate ? "registered-shadow" : "rejected",
        version: AUTONOMOUS_MODEL_CYCLE_VERSION,
        cycleId: plan.cycleId,
        candidateArtifactHash: plan.candidate.artifactHash,
        candidateBytesHash: plan.candidateBytesHash,
        ledgerArtifactHash: ledgerArtifact?.artifactHash || null,
        evidenceHash: plan.evidenceHash,
        candidateReady: plan.candidate.candidateReady === true,
        blockers: plan.legalCandidate
          ? plan.candidate.internalCandidateBlockers
          : plan.validationBlockers,
        lease,
        capturedAt: observationCapturedAt,
        activeModelPointer: activeAfter,
        activeModelPointerUnchanged: true,
        ledger: verification,
      };
    }
  } catch (error) {
    failure = error;
  } finally {
    if (lease?.acquired) {
      try {
        leaseReleased = releaseLearningLease(db, {
          leaseName: lease.leaseName,
          holderId: lease.holderId,
          fencingToken: lease.fencingToken,
        }).released;
        if (!leaseReleased && !failure) {
          failure = new AutonomousModelCycleError("learning lease release failed", {
            code: "LEASE_RELEASE_FAILED",
          });
        }
      } catch (error) {
        if (!failure) failure = error;
      }
    }
    try {
      anchor = writeLedgerHeadAnchor(db, resolvedAnchorFile, {
        generatedAt: occurredAt,
        hmacKey: anchorHmacKey,
      });
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  if (failure) throw failure;
  const activeAfter = activeModelPointer(db);
  if (!pointersEqual(activeBefore, activeAfter)) {
    throw new AutonomousModelCycleError("active model pointer changed during shadow-only cycle", {
      code: "ACTIVE_POINTER_MUTATED",
      activeBefore,
      activeAfter,
    });
  }
  return {
    ...result,
    leaseReleased,
    anchor,
    activeModelPointer: activeAfter,
    activeModelPointerUnchanged: true,
  };
};

module.exports = {
  AUTONOMOUS_MODEL_CYCLE_VERSION,
  AutonomousModelCycleError,
  DEFAULT_LEASE_NAME,
  buildAutonomousCyclePlan,
  eventKeyFor,
  runAutonomousModelCycle,
};
