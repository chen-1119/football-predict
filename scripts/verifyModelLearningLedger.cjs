"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ModelLearningLedgerError,
  acquireLearningLease,
  activeModelPointer,
  appendAuthorizedPromotion,
  appendAuthorizedRollback,
  appendLearningEvent,
  commitModelArtifact,
  compareAndSwapActiveModel,
  openLearningLedger,
  releaseLearningLease,
  sha256,
  stableStringify,
  verifyLearningLedger,
  writeLedgerHeadAnchor,
} = require("./modelLearningLedger.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};
const throwsCode = (task, code, message) => {
  assert.throws(task, (error) => error instanceof ModelLearningLedgerError && error.code === code, message);
  assertions += 1;
};
const throwsSqlite = (task, pattern, message) => {
  assert.throws(task, pattern, message);
  assertions += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-model-ledger-"));
const dbPath = path.join(root, "model-learning.db");
const anchorPath = path.join(root, "model-learning-head.json");
const { db } = openLearningLedger(dbPath);

const actor = Object.freeze({ type: "service", id: "verifier" });
const t0 = Date.parse("2026-07-16T00:00:00.000Z");
const at = (seconds) => new Date(t0 + seconds * 1_000).toISOString();
const cycleA = sha256("cycle-a-input-and-trainer");
const cycleB = sha256("cycle-b-input-and-trainer");
const cycleRegisteredOnly = sha256("cycle-registered-only");
const cycleDiscontinuous = sha256("cycle-discontinuous-candidate");
const eventKey = (cycleId, state) => sha256(`${cycleId}:${state}`);

const append = (cycleId, state, second, options = {}) => appendLearningEvent(db, {
  cycleId,
  eventKey: eventKey(cycleId, state),
  eventType: options.eventType || state,
  state,
  occurredAt: at(second),
  actor,
  payload: options.payload || { evidence: state.toLowerCase() },
  artifactHash: options.artifactHash || null,
});

try {
  const artifactABytes = Buffer.from(stableStringify({
    version: "residual-market-model-v1",
    coefficients: [0.1, -0.2, 0.05],
    intercepts: [0.01, -0.01, 0],
    trainedThrough: "2026-07-01T00:00:00.000Z",
  }));
  const artifactA = commitModelArtifact(db, {
    bytes: artifactABytes,
    artifactType: "residual-market-model",
    metadata: { datasetHash: sha256("dataset-a"), trainerHash: sha256("trainer-v1") },
    createdAt: at(0),
  });
  equal(artifactA.artifactHash, sha256(artifactABytes), "artifact hash is content addressed");
  equal(artifactA.idempotent, false, "first artifact commit is not idempotent");

  const artifactARepeat = commitModelArtifact(db, {
    bytes: artifactABytes,
    artifactType: "residual-market-model",
    metadata: { datasetHash: sha256("dataset-a"), trainerHash: sha256("trainer-v1") },
    createdAt: at(1),
  });
  equal(artifactARepeat.idempotent, true, "same bytes are idempotent");
  equal(artifactARepeat.artifactHash, artifactA.artifactHash, "idempotent artifact keeps identity");
  throwsCode(() => commitModelArtifact(db, {
    bytes: artifactABytes,
    artifactType: "residual-market-model",
    metadata: { datasetHash: sha256("different-dataset"), trainerHash: sha256("trainer-v1") },
    createdAt: at(1),
  }), "ARTIFACT_METADATA_CONFLICT", "same bytes cannot be rebound to different training metadata");
  throwsCode(() => commitModelArtifact(db, {
    bytes: artifactABytes,
    artifactType: "residual-market-model",
    metadata: {},
    createdAt: at(2),
    declaredHash: sha256("wrong-bytes"),
  }), "ARTIFACT_HASH_MISMATCH", "declared artifact hash mismatch is rejected");

  const firstLease = acquireLearningLease(db, {
    holderId: "worker-a",
    now: at(2),
    ttlMs: 10_000,
  });
  check(firstLease.acquired, "first worker acquires learning lease");
  equal(firstLease.fencingToken, 1, "first lease receives fencing token 1");
  const blockedLease = acquireLearningLease(db, {
    holderId: "worker-b",
    now: at(3),
    ttlMs: 10_000,
  });
  equal(blockedLease.acquired, false, "concurrent holder cannot steal live lease");
  equal(blockedLease.fencingToken, 1, "blocked holder observes current fencing token");
  const takeoverLease = acquireLearningLease(db, {
    holderId: "worker-b",
    now: at(13),
    ttlMs: 10_000,
  });
  check(takeoverLease.acquired, "expired lease can be acquired");
  equal(takeoverLease.fencingToken, 2, "lease takeover advances fencing token");
  equal(releaseLearningLease(db, {
    holderId: "worker-a",
    fencingToken: firstLease.fencingToken,
  }).released, false, "stale holder cannot release replacement lease");
  equal(releaseLearningLease(db, {
    holderId: "worker-b",
    fencingToken: takeoverLease.fencingToken,
  }).released, true, "current holder releases matching fenced lease");
  const reacquiredLease = acquireLearningLease(db, {
    holderId: "worker-c",
    now: at(14),
    ttlMs: 10_000,
  });
  check(reacquiredLease.acquired, "released lease can be acquired by a new worker");
  equal(reacquiredLease.fencingToken, 3, "fencing token remains monotonic after explicit release");
  equal(releaseLearningLease(db, {
    holderId: "worker-c",
    fencingToken: reacquiredLease.fencingToken,
  }).released, true, "new fenced holder releases the lease");

  const controlLease = acquireLearningLease(db, {
    leaseName: "model-promotion-control",
    holderId: "release-manager",
    now: at(4),
    ttlMs: 120_000,
  });
  check(controlLease.acquired, "release manager acquires the privileged transition lease");
  const privilegedActor = Object.freeze({ type: "service", id: "release-manager" });
  const controlFence = (second) => ({
    leaseName: controlLease.leaseName,
    holderId: controlLease.holderId,
    fencingToken: controlLease.fencingToken,
    checkedAt: at(second),
  });
  const unrelatedLease = acquireLearningLease(db, {
    leaseName: "unrelated-control",
    holderId: "release-manager",
    now: at(4),
    ttlMs: 120_000,
  });
  check(unrelatedLease.acquired, "independent lease exists for authority mismatch checks");

  append(cycleRegisteredOnly, "DATASET_DISCOVERED", 4);
  append(cycleRegisteredOnly, "SNAPSHOT_FROZEN", 4);
  append(cycleRegisteredOnly, "TRAINED", 4);
  append(cycleRegisteredOnly, "EVALUATED", 4);
  append(cycleRegisteredOnly, "ARTIFACT_COMMITTED", 4, { artifactHash: artifactA.artifactHash });
  append(cycleRegisteredOnly, "REGISTERED_SHADOW", 4, { artifactHash: artifactA.artifactHash });
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleRegisteredOnly,
    eventKey: eventKey(cycleRegisteredOnly, "PROMOTED"),
    occurredAt: at(4),
    actor: privilegedActor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
    lease: controlFence(4),
  }), "PRIVILEGED_STATE_PRECONDITION", "promotion cannot bypass CANARY_ACTIVE");

  throwsCode(() => append(cycleA, "TRAINED", 4), "INVALID_STATE_TRANSITION", "cycle cannot skip dataset discovery");
  const a1 = append(cycleA, "DATASET_DISCOVERED", 5);
  equal(a1.event.cycleSequence, 1, "first cycle event receives sequence 1");
  const a1Repeat = append(cycleA, "DATASET_DISCOVERED", 99);
  equal(a1Repeat.idempotent, true, "logical event retry is idempotent despite retry clock");
  equal(a1Repeat.eventHash, a1.eventHash, "event retry preserves original event hash");
  throwsCode(() => appendLearningEvent(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "DATASET_DISCOVERED"),
    eventType: "DATASET_DISCOVERED",
    state: "DATASET_DISCOVERED",
    occurredAt: at(6),
    actor,
    payload: { evidence: "different" },
  }), "EVENT_KEY_CONFLICT", "event key cannot bind different content");

  append(cycleA, "SNAPSHOT_FROZEN", 6);
  append(cycleA, "TRAINED", 7);
  append(cycleA, "EVALUATED", 8);
  append(cycleA, "ARTIFACT_COMMITTED", 9, { artifactHash: artifactA.artifactHash });
  append(cycleA, "REGISTERED_SHADOW", 10, { artifactHash: artifactA.artifactHash });
  append(cycleA, "CANARY_ACTIVE", 10, { artifactHash: artifactA.artifactHash });
  throwsCode(() => append(cycleA, "PROMOTED", 11, {
    artifactHash: artifactA.artifactHash,
    payload: { targetArtifactHash: artifactA.artifactHash, gate: "forged" },
  }), "PRIVILEGED_EVENT_REQUIRED", "ordinary append cannot forge a promotion event");
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor: privilegedActor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
  }), "PRIVILEGED_LEASE_REQUIRED", "promotion requires an explicit fenced lease");
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
    lease: controlFence(11),
  }), "PRIVILEGED_ACTOR_LEASE_MISMATCH", "promotion actor must own the fenced lease");
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor: privilegedActor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
    lease: { ...controlFence(11), fencingToken: controlLease.fencingToken + 1 },
  }), "LEASE_FENCE_MISMATCH", "stale or forged fencing token cannot authorize promotion");
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor: privilegedActor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 1,
    expectedCurrentArtifactHash: null,
    lease: controlFence(11),
  }), "ACTIVE_POINTER_PRECONDITION_FAILED", "promotion authorization binds the active generation");
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor: privilegedActor,
    payload: { expectedGeneration: 0 },
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
    lease: controlFence(11),
  }), "POINTER_AUTHORITY_FIELD_RESERVED", "caller cannot forge ledger-owned pointer authorization fields");
  const promotionA = appendAuthorizedPromotion(db, {
    cycleId: cycleA,
    eventKey: eventKey(cycleA, "PROMOTED"),
    occurredAt: at(11),
    actor: privilegedActor,
    payload: { gate: "verified" },
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 0,
    expectedCurrentArtifactHash: null,
    lease: controlFence(11),
  });

  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 0,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: a1.eventHash,
    updatedAt: at(12),
    lease: controlFence(12),
  }), "POINTER_EVENT_INVALID", "non-promotion event cannot authorize active pointer");
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 0,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: promotionA.eventHash,
    updatedAt: at(12),
  }), "PRIVILEGED_LEASE_REQUIRED", "active pointer CAS also requires the fenced lease");
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 0,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: promotionA.eventHash,
    updatedAt: at(12),
    lease: {
      leaseName: unrelatedLease.leaseName,
      holderId: unrelatedLease.holderId,
      fencingToken: unrelatedLease.fencingToken,
      checkedAt: at(12),
    },
  }), "POINTER_LEASE_AUTHORITY_MISMATCH", "a different valid lease cannot consume the authorization");
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 1,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: promotionA.eventHash,
    updatedAt: at(12),
    lease: controlFence(12),
  }), "POINTER_EXPECTATION_MISMATCH", "CAS cannot override the generation bound into the event");
  const firstSwap = compareAndSwapActiveModel(db, {
    expectedGeneration: 0,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: promotionA.eventHash,
    updatedAt: at(12),
    lease: controlFence(12),
  });
  check(firstSwap.swapped, "first promoted artifact becomes active through CAS");
  equal(firstSwap.pointer.generation, 1, "first active pointer generation is 1");
  equal(firstSwap.pointer.artifactHash, artifactA.artifactHash, "pointer references authorized artifact A");
  const replayA = compareAndSwapActiveModel(db, {
    expectedGeneration: 0,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: promotionA.eventHash,
    updatedAt: at(13),
    lease: controlFence(13),
  });
  equal(replayA.swapped, false, "consumed promotion event cannot overwrite active model");
  equal(replayA.reason, "event-already-consumed", "CAS reports one-shot event consumption explicitly");

  const artifactBBytes = Buffer.from(stableStringify({
    version: "residual-market-model-v1",
    coefficients: [0.3, -0.1, -0.2],
    intercepts: [0.02, 0, -0.02],
    trainedThrough: "2026-07-08T00:00:00.000Z",
  }));
  const artifactB = commitModelArtifact(db, {
    bytes: artifactBBytes,
    artifactType: "residual-market-model",
    metadata: { datasetHash: sha256("dataset-b"), trainerHash: sha256("trainer-v1") },
    createdAt: at(14),
  });

  append(cycleDiscontinuous, "DATASET_DISCOVERED", 14);
  append(cycleDiscontinuous, "SNAPSHOT_FROZEN", 14);
  append(cycleDiscontinuous, "TRAINED", 14);
  append(cycleDiscontinuous, "EVALUATED", 14);
  append(cycleDiscontinuous, "ARTIFACT_COMMITTED", 14, { artifactHash: artifactA.artifactHash });
  append(cycleDiscontinuous, "REGISTERED_SHADOW", 14, { artifactHash: artifactA.artifactHash });
  append(cycleDiscontinuous, "CANARY_ACTIVE", 14, { artifactHash: artifactB.artifactHash });
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleDiscontinuous,
    eventKey: eventKey(cycleDiscontinuous, "PROMOTED"),
    occurredAt: at(14),
    actor: privilegedActor,
    targetArtifactHash: artifactB.artifactHash,
    expectedGeneration: 1,
    expectedCurrentArtifactHash: artifactA.artifactHash,
    lease: controlFence(14),
  }), "CANDIDATE_ARTIFACT_DISCONTINUITY", "promotion rejects a candidate hash changed between cycle stages");

  append(cycleB, "DATASET_DISCOVERED", 15);
  append(cycleB, "SNAPSHOT_FROZEN", 16);
  append(cycleB, "TRAINED", 17);
  append(cycleB, "EVALUATED", 18);
  append(cycleB, "ARTIFACT_COMMITTED", 19, { artifactHash: artifactB.artifactHash });
  append(cycleB, "REGISTERED_SHADOW", 20, { artifactHash: artifactB.artifactHash });
  append(cycleB, "CANARY_ACTIVE", 20, { artifactHash: artifactB.artifactHash });
  throwsCode(() => appendAuthorizedPromotion(db, {
    cycleId: cycleB,
    eventKey: eventKey(cycleB, "PROMOTED"),
    occurredAt: at(21),
    actor: privilegedActor,
    targetArtifactHash: artifactB.artifactHash,
    expectedGeneration: 1,
    expectedCurrentArtifactHash: sha256("not-the-active-artifact"),
    lease: controlFence(21),
  }), "ACTIVE_POINTER_PRECONDITION_FAILED", "promotion authorization binds the current active artifact");
  const promotionB = appendAuthorizedPromotion(db, {
    cycleId: cycleB,
    eventKey: eventKey(cycleB, "PROMOTED"),
    occurredAt: at(21),
    actor: privilegedActor,
    payload: { gate: "verified" },
    targetArtifactHash: artifactB.artifactHash,
    expectedGeneration: 1,
    expectedCurrentArtifactHash: artifactA.artifactHash,
    lease: controlFence(21),
  });
  const secondSwap = compareAndSwapActiveModel(db, {
    expectedGeneration: 1,
    targetArtifactHash: artifactB.artifactHash,
    eventHash: promotionB.eventHash,
    updatedAt: at(22),
    lease: controlFence(22),
  });
  check(secondSwap.swapped, "second promoted artifact replaces active model");
  equal(secondSwap.pointer.previousArtifactHash, artifactA.artifactHash, "pointer retains rollback target");

  throwsCode(() => appendAuthorizedRollback(db, {
    cycleId: cycleB,
    eventKey: eventKey(cycleB, "ROLLED_BACK"),
    occurredAt: at(23),
    actor: privilegedActor,
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 2,
    expectedCurrentArtifactHash: artifactB.artifactHash,
    lease: controlFence(23),
  }), "PRIVILEGED_STATE_PRECONDITION", "rollback cannot skip ROLLBACK_REQUESTED");

  append(cycleB, "ROLLBACK_REQUESTED", 23, {
    artifactHash: artifactB.artifactHash,
    payload: { reason: "canary-regression", currentArtifactHash: artifactB.artifactHash },
  });
  throwsCode(() => append(cycleB, "ROLLED_BACK", 24, {
    artifactHash: artifactA.artifactHash,
    payload: { targetArtifactHash: artifactA.artifactHash },
  }), "PRIVILEGED_EVENT_REQUIRED", "ordinary append cannot forge a rollback event");
  throwsCode(() => appendAuthorizedRollback(db, {
    cycleId: cycleB,
    eventKey: eventKey(cycleB, "ROLLED_BACK"),
    occurredAt: at(24),
    actor: privilegedActor,
    targetArtifactHash: artifactB.artifactHash,
    expectedGeneration: 2,
    expectedCurrentArtifactHash: artifactB.artifactHash,
    lease: controlFence(24),
  }), "ROLLBACK_TARGET_MISMATCH", "rollback can only restore the immediate predecessor artifact");
  const rollback = appendAuthorizedRollback(db, {
    cycleId: cycleB,
    eventKey: eventKey(cycleB, "ROLLED_BACK"),
    occurredAt: at(24),
    actor: privilegedActor,
    payload: { reason: "canary-regression" },
    targetArtifactHash: artifactA.artifactHash,
    expectedGeneration: 2,
    expectedCurrentArtifactHash: artifactB.artifactHash,
    lease: controlFence(24),
  });
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 2,
    targetArtifactHash: artifactB.artifactHash,
    eventHash: rollback.eventHash,
    updatedAt: at(25),
    lease: controlFence(25),
  }), "POINTER_AUTHORITY_MISMATCH", "CAS target cannot differ from the authorized rollback target");
  const rollbackSwap = compareAndSwapActiveModel(db, {
    expectedGeneration: 2,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: rollback.eventHash,
    updatedAt: at(25),
    lease: controlFence(25),
  });
  check(rollbackSwap.swapped, "authorized rollback switches pointer using CAS");
  equal(activeModelPointer(db).artifactHash, artifactA.artifactHash, "rollback restores artifact A");
  equal(activeModelPointer(db).generation, 3, "rollback advances pointer generation monotonically");
  const rollbackReplay = compareAndSwapActiveModel(db, {
    expectedGeneration: 2,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: rollback.eventHash,
    updatedAt: at(26),
    lease: controlFence(26),
  });
  equal(rollbackReplay.swapped, false, "consumed rollback event cannot be reused");
  equal(rollbackReplay.reason, "event-already-consumed", "rollback replay is identified as consumed");
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 1,
    targetArtifactHash: artifactB.artifactHash,
    eventHash: promotionB.eventHash,
    updatedAt: at(26),
    lease: controlFence(26),
  }), "POINTER_EVENT_SUPERSEDED", "promotion event superseded by rollback cannot be reused");

  const controlTakeover = acquireLearningLease(db, {
    leaseName: controlLease.leaseName,
    holderId: "replacement-release-manager",
    now: at(125),
    ttlMs: 30_000,
  });
  check(controlTakeover.acquired, "expired privileged lease can be fenced by a replacement manager");
  equal(controlTakeover.fencingToken, controlLease.fencingToken + 1,
    "privileged lease takeover advances the fencing token");
  throwsCode(() => compareAndSwapActiveModel(db, {
    expectedGeneration: 2,
    targetArtifactHash: artifactA.artifactHash,
    eventHash: rollback.eventHash,
    updatedAt: at(126),
    lease: controlFence(126),
  }), "LEASE_FENCE_MISMATCH", "old release worker cannot write after fenced lease takeover");

  const verification = verifyLearningLedger(db);
  check(verification.valid, `ledger verifies: ${verification.errors.join(",")}`);
  equal(verification.artifacts, 2, "ledger contains two content-addressed artifacts");
  equal(verification.cycles, 4, "ledger contains all deterministic test cycles");
  check(verification.events >= 30, "ledger contains the complete event histories");
  equal(verification.headEventHash, rollback.eventHash, "ledger head is the rollback event");

  throwsSqlite(() => db.prepare("UPDATE model_artifacts SET byte_length=0 WHERE artifact_hash=?")
    .run(artifactA.artifactHash), /append-only/, "artifact mutation is rejected by database trigger");
  throwsSqlite(() => db.prepare("DELETE FROM model_learning_events WHERE sequence=1").run(), /append-only/,
    "event deletion is rejected by database trigger");
  check(verifyLearningLedger(db).valid, "failed tamper attempts leave ledger valid");

  const hmacKey = "verifier-only-anchor-secret";
  const anchor = writeLedgerHeadAnchor(db, anchorPath, { generatedAt: at(26), hmacKey });
  equal(anchor.headEventHash, rollback.eventHash, "external anchor captures ledger head");
  equal(anchor.signatureType, "hmac-sha256", "external anchor declares HMAC signature");
  const anchorBody = {
    version: anchor.version,
    generatedAt: anchor.generatedAt,
    headEventHash: anchor.headEventHash,
    events: anchor.events,
    artifacts: anchor.artifacts,
    activeGeneration: anchor.activeGeneration,
    activeArtifactHash: anchor.activeArtifactHash,
  };
  equal(anchor.anchorHash, sha256(stableStringify(anchorBody)), "anchor hash covers canonical ledger head body");
  equal(anchor.signature, crypto.createHmac("sha256", hmacKey).update(anchor.anchorHash).digest("hex"),
    "anchor signature verifies independently");
  equal(JSON.parse(fs.readFileSync(anchorPath, "utf8")).anchorHash, anchor.anchorHash,
    "atomic anchor file contains the verified head");

  db.close();
  const readOnly = openLearningLedger(dbPath, { readOnly: true });
  check(verifyLearningLedger(readOnly.db).valid, "persisted ledger reopens read-only and verifies");
  readOnly.db.close();

  const tamperedPath = path.join(root, "model-learning-tampered.db");
  fs.copyFileSync(dbPath, tamperedPath);
  const tampered = openLearningLedger(tamperedPath);
  try {
    tampered.db.exec("DROP TRIGGER model_learning_events_no_update");
    const tamperedPayload = '{"privilegedTamper":true}';
    tampered.db.prepare("UPDATE model_learning_events SET payload_json=? WHERE sequence=1")
      .run(tamperedPayload);
    const payloadTamper = verifyLearningLedger(tampered.db);
    equal(payloadTamper.valid, false, "verification detects payload tampering after trigger bypass");
    check(payloadTamper.errors.some((error) => error.startsWith("event-payload:1")),
      "tamper report identifies the corrupted payload hash");
    tampered.db.prepare("UPDATE model_learning_events SET payload_hash=? WHERE sequence=1")
      .run(sha256(tamperedPayload));
    const chainTamper = verifyLearningLedger(tampered.db);
    equal(chainTamper.valid, false, "hash-chain verification detects a forged replacement payload hash");
    check(chainTamper.errors.some((error) => error.startsWith("event-hash:1")),
      "tamper report identifies the corrupted event hash");
  } finally {
    tampered.db.close();
  }

  console.log(JSON.stringify({
    ok: true,
    verifier: "model-learning-ledger-v1",
    assertions,
    artifacts: verification.artifacts,
    events: verification.events,
    cycles: verification.cycles,
    headEventHash: verification.headEventHash,
    activeGeneration: rollbackSwap.pointer.generation,
  }, null, 2));
} finally {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(root, { recursive: true, force: true });
}
