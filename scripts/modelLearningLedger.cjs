"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MODEL_LEARNING_LEDGER_VERSION = "model-learning-ledger-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_STATES = new Set(["PROMOTED", "REJECTED", "ROLLED_BACK", "ROLLBACK_FAILED"]);
const TRANSITIONS = Object.freeze({
  __START__: ["DATASET_DISCOVERED"],
  DATASET_DISCOVERED: ["SNAPSHOT_FROZEN", "REJECTED"],
  SNAPSHOT_FROZEN: ["TRAINED", "EVALUATED", "REJECTED"],
  TRAINED: ["EVALUATED", "REJECTED"],
  EVALUATED: ["ARTIFACT_COMMITTED", "REGISTERED_SHADOW", "REJECTED"],
  ARTIFACT_COMMITTED: ["REGISTERED_SHADOW", "REJECTED"],
  REGISTERED_SHADOW: ["CANARY_ACTIVE", "REJECTED"],
  CANARY_ACTIVE: ["PROMOTED", "ROLLBACK_REQUESTED", "REJECTED"],
  PROMOTED: ["ROLLBACK_REQUESTED"],
  ROLLBACK_REQUESTED: ["ROLLED_BACK", "ROLLBACK_FAILED"],
  REJECTED: [],
  ROLLED_BACK: [],
  ROLLBACK_FAILED: [],
});

class ModelLearningLedgerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ModelLearningLedgerError";
    this.code = details.code || "MODEL_LEARNING_LEDGER_ERROR";
    Object.assign(this, details);
  }
}

const sha256 = (value) => crypto.createHash("sha256")
  .update(Buffer.isBuffer(value) ? value : String(value))
  .digest("hex");

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ModelLearningLedgerError("non-finite values cannot be committed", { code: "NON_FINITE_VALUE" });
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const canonicalIso = (value, field) => {
  const millis = Date.parse(String(value || ""));
  if (!Number.isFinite(millis)) {
    throw new ModelLearningLedgerError(`${field} must be a valid timestamp`, { code: "INVALID_TIMESTAMP", field });
  }
  return new Date(millis).toISOString();
};

const nonempty = (value, field) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new ModelLearningLedgerError(`${field} is required`, { code: "MISSING_FIELD", field });
  return normalized;
};

const assertHash = (value, field) => {
  const normalized = String(value || "");
  if (!HASH_PATTERN.test(normalized)) {
    throw new ModelLearningLedgerError(`${field} must be a sha256 hash`, { code: "INVALID_HASH", field });
  }
  return normalized;
};

const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const asBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(stableStringify(value), "utf8");
};

const withImmediateTransaction = (db, task) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = task();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  }
};

const initializeLedger = (db) => {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_artifacts (
      artifact_hash TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL,
      media_type TEXT NOT NULL,
      artifact_bytes BLOB NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      metadata_json TEXT NOT NULL,
      metadata_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS model_learning_events (
      sequence INTEGER PRIMARY KEY,
      cycle_sequence INTEGER NOT NULL,
      cycle_id TEXT NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      state TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      artifact_hash TEXT,
      previous_event_hash TEXT,
      previous_cycle_event_hash TEXT,
      previous_cycle_state TEXT,
      event_hash TEXT NOT NULL UNIQUE,
      FOREIGN KEY(artifact_hash) REFERENCES model_artifacts(artifact_hash)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS model_learning_events_cycle_sequence
      ON model_learning_events(cycle_id, cycle_sequence);

    CREATE TABLE IF NOT EXISTS active_model_pointer (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      artifact_hash TEXT,
      previous_artifact_hash TEXT,
      event_hash TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(artifact_hash) REFERENCES model_artifacts(artifact_hash),
      FOREIGN KEY(event_hash) REFERENCES model_learning_events(event_hash)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS learning_leases (
      lease_name TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS model_learning_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS model_artifacts_no_update
      BEFORE UPDATE ON model_artifacts BEGIN SELECT RAISE(ABORT, 'model_artifacts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS model_artifacts_no_delete
      BEFORE DELETE ON model_artifacts BEGIN SELECT RAISE(ABORT, 'model_artifacts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS model_learning_events_no_update
      BEFORE UPDATE ON model_learning_events BEGIN SELECT RAISE(ABORT, 'model_learning_events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS model_learning_events_no_delete
      BEFORE DELETE ON model_learning_events BEGIN SELECT RAISE(ABORT, 'model_learning_events are append-only'); END;
  `);
  const now = new Date(0).toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO active_model_pointer
      (singleton, generation, artifact_hash, previous_artifact_hash, event_hash, updated_at)
    VALUES (1, 0, NULL, NULL, NULL, ?)
  `).run(now);
  return db;
};

const openLearningLedger = (dbPath, options = {}) => {
  const resolved = path.resolve(dbPath);
  if (!options.readOnly) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved, { readOnly: options.readOnly === true });
  if (!options.readOnly) initializeLedger(db);
  else {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
  }
  return { db, dbPath: resolved };
};

const commitModelArtifact = (db, {
  bytes,
  artifactType,
  mediaType = "application/json",
  metadata = {},
  createdAt,
  declaredHash = null,
} = {}) => withImmediateTransaction(db, () => {
  const artifactBytes = asBuffer(bytes);
  const artifactHash = sha256(artifactBytes);
  const normalizedArtifactType = nonempty(artifactType, "artifactType");
  const normalizedMediaType = nonempty(mediaType, "mediaType");
  const metadataJson = stableStringify(metadata || {});
  const metadataHash = sha256(metadataJson);
  if (declaredHash !== null && assertHash(declaredHash, "declaredHash") !== artifactHash) {
    throw new ModelLearningLedgerError("declared artifact hash does not match bytes", {
      code: "ARTIFACT_HASH_MISMATCH",
      declaredHash,
      artifactHash,
    });
  }
  const existing = db.prepare("SELECT * FROM model_artifacts WHERE artifact_hash=?").get(artifactHash);
  if (existing) {
    const existingBytes = Buffer.from(existing.artifact_bytes);
    if (!existingBytes.equals(artifactBytes)) {
      throw new ModelLearningLedgerError("same artifact hash resolved to different bytes", {
        code: "ARTIFACT_CONTENT_CONFLICT",
        artifactHash,
      });
    }
    if (existing.artifact_type !== normalizedArtifactType
        || existing.media_type !== normalizedMediaType
        || existing.metadata_hash !== metadataHash
        || existing.metadata_json !== metadataJson) {
      throw new ModelLearningLedgerError("same artifact bytes were declared with different identity metadata", {
        code: "ARTIFACT_METADATA_CONFLICT",
        artifactHash,
      });
    }
    return { artifactHash, byteLength: artifactBytes.length, idempotent: true };
  }
  db.prepare(`
    INSERT INTO model_artifacts
      (artifact_hash, artifact_type, media_type, artifact_bytes, byte_length, metadata_json, metadata_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactHash,
    normalizedArtifactType,
    normalizedMediaType,
    artifactBytes,
    artifactBytes.length,
    metadataJson,
    metadataHash,
    canonicalIso(createdAt, "createdAt"),
  );
  return { artifactHash, byteLength: artifactBytes.length, metadataHash, idempotent: false };
});

const latestCycleEvent = (db, cycleId) => db.prepare(`
  SELECT * FROM model_learning_events WHERE cycle_id=? ORDER BY cycle_sequence DESC LIMIT 1
`).get(cycleId) || null;

const assertLearningLeaseFence = (db, lease) => {
  if (lease === null || lease === undefined) return null;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
    throw new ModelLearningLedgerError("lease fence must be an object", { code: "LEASE_FENCE_INVALID" });
  }
  const leaseName = nonempty(lease.leaseName, "lease.leaseName");
  const holderId = nonempty(lease.holderId, "lease.holderId");
  const fencingToken = Math.trunc(Number(lease.fencingToken));
  if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
    throw new ModelLearningLedgerError("lease fencing token must be a positive safe integer", {
      code: "LEASE_FENCE_INVALID",
    });
  }
  const checkedAt = canonicalIso(lease.checkedAt, "lease.checkedAt");
  const row = db.prepare("SELECT * FROM learning_leases WHERE lease_name=?").get(leaseName);
  if (!row || row.holder_id !== holderId || Number(row.fencing_token) !== fencingToken) {
    throw new ModelLearningLedgerError("learning lease holder or fencing token no longer owns the lease", {
      code: "LEASE_FENCE_MISMATCH",
      leaseName,
      holderId,
      fencingToken,
    });
  }
  if (Date.parse(row.expires_at) <= Date.parse(checkedAt)) {
    throw new ModelLearningLedgerError("learning lease expired before the ledger write", {
      code: "LEASE_EXPIRED",
      leaseName,
      holderId,
      fencingToken,
      expiresAt: row.expires_at,
      checkedAt,
    });
  }
  return { leaseName, holderId, fencingToken, checkedAt, expiresAt: row.expires_at };
};

const normalizeExpectedGeneration = (value, field = "expectedGeneration") => {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new ModelLearningLedgerError(`${field} must be a non-negative safe integer`, {
      code: "POINTER_EXPECTATION_INVALID",
      field,
    });
  }
  return generation;
};

const normalizeOptionalArtifactHash = (value, field) => (
  value === null || value === undefined ? null : assertHash(value, field)
);

const eventProjection = (row) => ({
  version: MODEL_LEARNING_LEDGER_VERSION,
  sequence: Number(row.sequence),
  cycleSequence: Number(row.cycle_sequence),
  cycleId: row.cycle_id,
  eventKey: row.event_key,
  eventType: row.event_type,
  state: row.state,
  occurredAt: row.occurred_at,
  actor: parseJson(row.actor_json, {}),
  payloadHash: row.payload_hash,
  artifactHash: row.artifact_hash || null,
  previousEventHash: row.previous_event_hash || null,
  previousCycleEventHash: row.previous_cycle_event_hash || null,
  previousCycleState: row.previous_cycle_state || null,
});

const PRIVILEGED_EVENT_AUTHORITY = Symbol("model-learning-ledger-privileged-event-authority");
const PRIVILEGED_EVENT_STATES = new Set(["PROMOTED", "ROLLED_BACK"]);

const appendLearningEventWithinTransaction = (db, {
  cycleId,
  eventKey,
  eventType,
  state,
  occurredAt,
  actor,
  payload = {},
  artifactHash = null,
  lease = null,
} = {}, authority = null) => {
  const normalizedCycleId = assertHash(cycleId, "cycleId");
  const normalizedEventKey = assertHash(eventKey, "eventKey");
  const normalizedState = nonempty(state, "state").toUpperCase();
  const normalizedEventType = nonempty(eventType, "eventType").toUpperCase();
  if (PRIVILEGED_EVENT_STATES.has(normalizedState) && authority !== PRIVILEGED_EVENT_AUTHORITY) {
    throw new ModelLearningLedgerError(`${normalizedState} requires the controlled model transition API`, {
      code: "PRIVILEGED_EVENT_REQUIRED",
      state: normalizedState,
    });
  }
  assertLearningLeaseFence(db, lease);
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, normalizedState)) {
    throw new ModelLearningLedgerError(`unsupported learning state: ${normalizedState}`, { code: "INVALID_STATE" });
  }
  const actorValue = stableValue({
    type: nonempty(actor?.type, "actor.type"),
    id: nonempty(actor?.id, "actor.id"),
  });
  const payloadValue = stableValue(payload || {});
  const payloadJson = stableStringify(payloadValue);
  const payloadHash = sha256(payloadJson);
  const normalizedArtifactHash = artifactHash === null ? null : assertHash(artifactHash, "artifactHash");
  if (normalizedArtifactHash) {
    const artifact = db.prepare("SELECT artifact_hash FROM model_artifacts WHERE artifact_hash=?").get(normalizedArtifactHash);
    if (!artifact) throw new ModelLearningLedgerError("event artifact does not exist", { code: "ARTIFACT_MISSING" });
  }

  const duplicate = db.prepare("SELECT * FROM model_learning_events WHERE event_key=?").get(normalizedEventKey);
  if (duplicate) {
    const duplicatePayload = parseJson(duplicate.payload_json, null);
    if (duplicate.cycle_id !== normalizedCycleId
        || duplicate.event_type !== normalizedEventType
        || duplicate.state !== normalizedState
        || duplicate.artifact_hash !== normalizedArtifactHash
        || stableStringify(duplicatePayload) !== payloadJson) {
      throw new ModelLearningLedgerError("event key is already bound to different content", {
        code: "EVENT_KEY_CONFLICT",
        eventKey: normalizedEventKey,
      });
    }
    return { event: eventProjection(duplicate), eventHash: duplicate.event_hash, idempotent: true };
  }

  const globalHead = db.prepare("SELECT * FROM model_learning_events ORDER BY sequence DESC LIMIT 1").get() || null;
  const cycleHead = latestCycleEvent(db, normalizedCycleId);
  const previousState = cycleHead?.state || "__START__";
  const allowed = TRANSITIONS[previousState] || [];
  if (!allowed.includes(normalizedState)) {
    throw new ModelLearningLedgerError(`invalid learning transition ${previousState} -> ${normalizedState}`, {
      code: "INVALID_STATE_TRANSITION",
      previousState,
      state: normalizedState,
    });
  }
  const sequence = Number(globalHead?.sequence || 0) + 1;
  const cycleSequence = Number(cycleHead?.cycle_sequence || 0) + 1;
  const occurred = canonicalIso(occurredAt, "occurredAt");
  const row = {
    sequence,
    cycle_sequence: cycleSequence,
    cycle_id: normalizedCycleId,
    event_key: normalizedEventKey,
    event_type: normalizedEventType,
    state: normalizedState,
    occurred_at: occurred,
    actor_json: stableStringify(actorValue),
    payload_json: payloadJson,
    payload_hash: payloadHash,
    artifact_hash: normalizedArtifactHash,
    previous_event_hash: globalHead?.event_hash || null,
    previous_cycle_event_hash: cycleHead?.event_hash || null,
    previous_cycle_state: cycleHead?.state || null,
  };
  const eventHash = sha256(stableStringify(eventProjection({ ...row, event_hash: null })));
  db.prepare(`
    INSERT INTO model_learning_events
      (sequence, cycle_sequence, cycle_id, event_key, event_type, state, occurred_at,
       actor_json, payload_json, payload_hash, artifact_hash, previous_event_hash,
       previous_cycle_event_hash, previous_cycle_state, event_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sequence,
    cycleSequence,
    normalizedCycleId,
    normalizedEventKey,
    normalizedEventType,
    normalizedState,
    occurred,
    row.actor_json,
    payloadJson,
    payloadHash,
    normalizedArtifactHash,
    row.previous_event_hash,
    row.previous_cycle_event_hash,
    row.previous_cycle_state,
    eventHash,
  );
  const inserted = db.prepare("SELECT * FROM model_learning_events WHERE sequence=?").get(sequence);
  return { event: eventProjection(inserted), eventHash, idempotent: false };
};

const appendLearningEvent = (db, options = {}) => withImmediateTransaction(
  db,
  () => appendLearningEventWithinTransaction(db, options),
);

const assertPointerPrecondition = (db, {
  expectedGeneration,
  expectedCurrentArtifactHash,
} = {}) => {
  const generation = normalizeExpectedGeneration(expectedGeneration);
  const currentArtifactHash = normalizeOptionalArtifactHash(
    expectedCurrentArtifactHash,
    "expectedCurrentArtifactHash",
  );
  const pointer = activeModelPointer(db);
  if (pointer.generation !== generation || pointer.artifactHash !== currentArtifactHash) {
    throw new ModelLearningLedgerError("active model pointer no longer matches the authorization precondition", {
      code: "ACTIVE_POINTER_PRECONDITION_FAILED",
      expectedGeneration: generation,
      actualGeneration: pointer.generation,
      expectedCurrentArtifactHash: currentArtifactHash,
      actualCurrentArtifactHash: pointer.artifactHash,
    });
  }
  return { pointer, expectedGeneration: generation, expectedCurrentArtifactHash: currentArtifactHash };
};

const assertPrivilegedActorOwnsLease = (actor, leaseFence) => {
  const actorId = nonempty(actor?.id, "actor.id");
  if (actorId !== leaseFence.holderId) {
    throw new ModelLearningLedgerError("privileged event actor must own the fenced learning lease", {
      code: "PRIVILEGED_ACTOR_LEASE_MISMATCH",
      actorId,
      leaseHolderId: leaseFence.holderId,
    });
  }
};

const cycleEvents = (db, cycleId) => db.prepare(`
  SELECT * FROM model_learning_events WHERE cycle_id=? ORDER BY cycle_sequence
`).all(cycleId);

const assertCandidateArtifactContinuity = (db, cycleId, candidateArtifactHash, requiredStates) => {
  const relevant = cycleEvents(db, cycleId)
    .filter((event) => requiredStates.includes(event.state));
  for (const state of requiredStates) {
    const stateEvents = relevant.filter((event) => event.state === state);
    if (stateEvents.length !== 1 || stateEvents[0].artifact_hash !== candidateArtifactHash) {
      throw new ModelLearningLedgerError("candidate artifact identity is not continuous across the cycle", {
        code: "CANDIDATE_ARTIFACT_DISCONTINUITY",
        cycleId,
        state,
        candidateArtifactHash,
        observedArtifactHashes: stateEvents.map((event) => event.artifact_hash || null),
      });
    }
  }
  return relevant;
};

const assertPayloadHasNoReservedAuthority = (payload) => {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const reserved = [
    "pointerAuthorization",
    "targetArtifactHash",
    "expectedGeneration",
    "expectedCurrentArtifactHash",
  ];
  const conflict = reserved.find((field) => Object.prototype.hasOwnProperty.call(value, field));
  if (conflict) {
    throw new ModelLearningLedgerError("controlled pointer authorization fields are ledger-owned", {
      code: "POINTER_AUTHORITY_FIELD_RESERVED",
      field: conflict,
    });
  }
  return value;
};

const authorizedPayload = ({
  payload,
  targetArtifactHash,
  candidateArtifactHash,
  expectedGeneration,
  expectedCurrentArtifactHash,
  expectedPointerEventHash,
  authorizedFromEventHash,
  leaseFence,
}) => ({
  ...assertPayloadHasNoReservedAuthority(payload),
  targetArtifactHash,
  expectedGeneration,
  expectedCurrentArtifactHash,
  pointerAuthorization: {
    version: "active-model-pointer-authorization-v1",
    targetArtifactHash,
    candidateArtifactHash,
    expectedGeneration,
    expectedCurrentArtifactHash,
    expectedPointerEventHash,
    authorizedFromEventHash,
    leaseName: leaseFence.leaseName,
    holderId: leaseFence.holderId,
    fencingToken: leaseFence.fencingToken,
  },
});

const appendAuthorizedPromotion = (db, {
  cycleId,
  eventKey,
  occurredAt,
  actor,
  payload = {},
  targetArtifactHash,
  expectedGeneration,
  expectedCurrentArtifactHash = null,
  lease,
} = {}) => withImmediateTransaction(db, () => {
  const normalizedCycleId = assertHash(cycleId, "cycleId");
  const target = assertHash(targetArtifactHash, "targetArtifactHash");
  const leaseFence = assertLearningLeaseFence(db, lease);
  if (!leaseFence) {
    throw new ModelLearningLedgerError("promotion requires a fenced learning lease", {
      code: "PRIVILEGED_LEASE_REQUIRED",
    });
  }
  assertPrivilegedActorOwnsLease(actor, leaseFence);
  const head = latestCycleEvent(db, normalizedCycleId);
  if (!head || head.state !== "CANARY_ACTIVE") {
    throw new ModelLearningLedgerError("promotion requires CANARY_ACTIVE as the current cycle head", {
      code: "PRIVILEGED_STATE_PRECONDITION",
      expectedState: "CANARY_ACTIVE",
      actualState: head?.state || "__START__",
    });
  }
  assertCandidateArtifactContinuity(
    db,
    normalizedCycleId,
    target,
    ["ARTIFACT_COMMITTED", "REGISTERED_SHADOW", "CANARY_ACTIVE"],
  );
  const pointerExpectation = assertPointerPrecondition(db, {
    expectedGeneration,
    expectedCurrentArtifactHash,
  });
  if (pointerExpectation.pointer.artifactHash === target) {
    throw new ModelLearningLedgerError("promotion target is already active", {
      code: "POINTER_TARGET_ALREADY_ACTIVE",
      targetArtifactHash: target,
    });
  }
  return appendLearningEventWithinTransaction(db, {
    cycleId: normalizedCycleId,
    eventKey,
    eventType: "PROMOTED",
    state: "PROMOTED",
    occurredAt,
    actor,
    payload: authorizedPayload({
      payload,
      targetArtifactHash: target,
      candidateArtifactHash: target,
      expectedGeneration: pointerExpectation.expectedGeneration,
      expectedCurrentArtifactHash: pointerExpectation.expectedCurrentArtifactHash,
      expectedPointerEventHash: pointerExpectation.pointer.eventHash,
      authorizedFromEventHash: head.event_hash,
      leaseFence,
    }),
    artifactHash: target,
    lease,
  }, PRIVILEGED_EVENT_AUTHORITY);
});

const appendAuthorizedRollback = (db, {
  cycleId,
  eventKey,
  occurredAt,
  actor,
  payload = {},
  targetArtifactHash,
  expectedGeneration,
  expectedCurrentArtifactHash,
  lease,
} = {}) => withImmediateTransaction(db, () => {
  const normalizedCycleId = assertHash(cycleId, "cycleId");
  const target = assertHash(targetArtifactHash, "targetArtifactHash");
  const currentCandidate = assertHash(expectedCurrentArtifactHash, "expectedCurrentArtifactHash");
  const leaseFence = assertLearningLeaseFence(db, lease);
  if (!leaseFence) {
    throw new ModelLearningLedgerError("rollback requires a fenced learning lease", {
      code: "PRIVILEGED_LEASE_REQUIRED",
    });
  }
  assertPrivilegedActorOwnsLease(actor, leaseFence);
  const head = latestCycleEvent(db, normalizedCycleId);
  if (!head || head.state !== "ROLLBACK_REQUESTED") {
    throw new ModelLearningLedgerError("rollback requires ROLLBACK_REQUESTED as the current cycle head", {
      code: "PRIVILEGED_STATE_PRECONDITION",
      expectedState: "ROLLBACK_REQUESTED",
      actualState: head?.state || "__START__",
    });
  }
  assertCandidateArtifactContinuity(
    db,
    normalizedCycleId,
    currentCandidate,
    ["ARTIFACT_COMMITTED", "REGISTERED_SHADOW", "CANARY_ACTIVE", "PROMOTED", "ROLLBACK_REQUESTED"],
  );
  const pointerExpectation = assertPointerPrecondition(db, {
    expectedGeneration,
    expectedCurrentArtifactHash: currentCandidate,
  });
  const promoted = cycleEvents(db, normalizedCycleId).find((event) => event.state === "PROMOTED");
  if (!promoted || pointerExpectation.pointer.eventHash !== promoted.event_hash) {
    throw new ModelLearningLedgerError("rollback cycle does not own the active candidate pointer", {
      code: "ROLLBACK_ACTIVE_EVENT_MISMATCH",
      expectedActiveEventHash: promoted?.event_hash || null,
      actualActiveEventHash: pointerExpectation.pointer.eventHash,
    });
  }
  if (!pointerExpectation.pointer.previousArtifactHash
      || pointerExpectation.pointer.previousArtifactHash !== target) {
    throw new ModelLearningLedgerError("rollback target must be the pointer's immediate predecessor", {
      code: "ROLLBACK_TARGET_MISMATCH",
      targetArtifactHash: target,
      previousArtifactHash: pointerExpectation.pointer.previousArtifactHash,
    });
  }
  return appendLearningEventWithinTransaction(db, {
    cycleId: normalizedCycleId,
    eventKey,
    eventType: "ROLLED_BACK",
    state: "ROLLED_BACK",
    occurredAt,
    actor,
    payload: authorizedPayload({
      payload,
      targetArtifactHash: target,
      candidateArtifactHash: currentCandidate,
      expectedGeneration: pointerExpectation.expectedGeneration,
      expectedCurrentArtifactHash: pointerExpectation.expectedCurrentArtifactHash,
      expectedPointerEventHash: pointerExpectation.pointer.eventHash,
      authorizedFromEventHash: head.event_hash,
      leaseFence,
    }),
    artifactHash: target,
    lease,
  }, PRIVILEGED_EVENT_AUTHORITY);
});

const acquireLearningLease = (db, {
  leaseName = "model-learning",
  holderId,
  now,
  ttlMs = 15 * 60 * 1000,
} = {}) => withImmediateTransaction(db, () => {
  const name = nonempty(leaseName, "leaseName");
  const holder = nonempty(holderId, "holderId");
  const acquiredAt = canonicalIso(now, "now");
  const nowMs = Date.parse(acquiredAt);
  const safeTtlMs = Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Math.trunc(Number(ttlMs) || 0)));
  const expiresAt = new Date(nowMs + safeTtlMs).toISOString();
  const existing = db.prepare("SELECT * FROM learning_leases WHERE lease_name=?").get(name);
  if (existing && Date.parse(existing.expires_at) > nowMs && existing.holder_id !== holder) {
    return {
      acquired: false,
      leaseName: name,
      holderId: existing.holder_id,
      fencingToken: Number(existing.fencing_token),
      expiresAt: existing.expires_at,
    };
  }
  const fencingToken = Number(existing?.fencing_token || 0) + 1;
  db.prepare(`
    INSERT INTO learning_leases (lease_name, holder_id, fencing_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lease_name) DO UPDATE SET
      holder_id=excluded.holder_id,
      fencing_token=excluded.fencing_token,
      acquired_at=excluded.acquired_at,
      expires_at=excluded.expires_at
  `).run(name, holder, fencingToken, acquiredAt, expiresAt);
  return { acquired: true, leaseName: name, holderId: holder, fencingToken, acquiredAt, expiresAt };
});

const releaseLearningLease = (db, { leaseName = "model-learning", holderId, fencingToken } = {}) => (
  withImmediateTransaction(db, () => {
    const result = db.prepare(`
      UPDATE learning_leases SET expires_at='1970-01-01T00:00:00.000Z'
      WHERE lease_name=? AND holder_id=? AND fencing_token=?
    `).run(
      nonempty(leaseName, "leaseName"),
      nonempty(holderId, "holderId"),
      Math.trunc(Number(fencingToken)),
    );
    return { released: Number(result.changes || 0) === 1 };
  })
);

const activeModelPointer = (db) => {
  const row = db.prepare("SELECT * FROM active_model_pointer WHERE singleton=1").get();
  return {
    generation: Number(row?.generation || 0),
    artifactHash: row?.artifact_hash || null,
    previousArtifactHash: row?.previous_artifact_hash || null,
    eventHash: row?.event_hash || null,
    updatedAt: row?.updated_at || null,
  };
};

const compareAndSwapActiveModel = (db, {
  expectedGeneration,
  targetArtifactHash,
  eventHash,
  updatedAt,
  lease,
} = {}) => withImmediateTransaction(db, () => {
  const target = assertHash(targetArtifactHash, "targetArtifactHash");
  const requestedGeneration = normalizeExpectedGeneration(expectedGeneration);
  const leaseFence = assertLearningLeaseFence(db, lease);
  if (!leaseFence) {
    throw new ModelLearningLedgerError("active pointer CAS requires a fenced learning lease", {
      code: "PRIVILEGED_LEASE_REQUIRED",
    });
  }
  const event = db.prepare("SELECT * FROM model_learning_events WHERE event_hash=?").get(
    assertHash(eventHash, "eventHash"),
  );
  if (!event || !["PROMOTED", "ROLLED_BACK"].includes(event.state)) {
    throw new ModelLearningLedgerError("active pointer requires a promoted or rolled-back event", {
      code: "POINTER_EVENT_INVALID",
    });
  }
  const payload = parseJson(event.payload_json, {});
  const authorization = payload.pointerAuthorization;
  if (!authorization
      || authorization.version !== "active-model-pointer-authorization-v1"
      || !["PROMOTED", "ROLLED_BACK"].includes(event.state)) {
    throw new ModelLearningLedgerError("pointer event lacks a controlled ledger authorization", {
      code: "POINTER_AUTHORIZATION_MISSING",
    });
  }
  if (payload.targetArtifactHash !== target
      || authorization.targetArtifactHash !== target
      || event.artifact_hash !== target) {
    throw new ModelLearningLedgerError("pointer event does not authorize the target artifact", {
      code: "POINTER_AUTHORITY_MISMATCH",
    });
  }
  if (authorization.expectedGeneration !== requestedGeneration
      || payload.expectedGeneration !== requestedGeneration) {
    throw new ModelLearningLedgerError("CAS generation does not match the immutable event authorization", {
      code: "POINTER_EXPECTATION_MISMATCH",
      requestedGeneration,
      authorizedGeneration: authorization.expectedGeneration,
    });
  }
  if (authorization.leaseName !== leaseFence.leaseName
      || authorization.holderId !== leaseFence.holderId
      || authorization.fencingToken !== leaseFence.fencingToken) {
    throw new ModelLearningLedgerError("CAS lease does not match the event's fenced authorization", {
      code: "POINTER_LEASE_AUTHORITY_MISMATCH",
    });
  }
  const cycleHead = latestCycleEvent(db, event.cycle_id);
  if (!cycleHead || cycleHead.event_hash !== event.event_hash) {
    throw new ModelLearningLedgerError("pointer event has been superseded by a later cycle event", {
      code: "POINTER_EVENT_SUPERSEDED",
      eventHash: event.event_hash,
      cycleHeadEventHash: cycleHead?.event_hash || null,
      cycleHeadState: cycleHead?.state || null,
    });
  }
  const expectedPreviousState = event.state === "PROMOTED" ? "CANARY_ACTIVE" : "ROLLBACK_REQUESTED";
  if (event.previous_cycle_state !== expectedPreviousState
      || authorization.authorizedFromEventHash !== event.previous_cycle_event_hash) {
    throw new ModelLearningLedgerError("pointer event is not bound to the required cycle head", {
      code: "POINTER_CYCLE_AUTHORITY_MISMATCH",
      expectedPreviousState,
      actualPreviousState: event.previous_cycle_state,
    });
  }
  if (event.state === "PROMOTED") {
    assertCandidateArtifactContinuity(
      db,
      event.cycle_id,
      target,
      ["ARTIFACT_COMMITTED", "REGISTERED_SHADOW", "CANARY_ACTIVE", "PROMOTED"],
    );
  } else {
    const candidate = assertHash(authorization.candidateArtifactHash, "candidateArtifactHash");
    assertCandidateArtifactContinuity(
      db,
      event.cycle_id,
      candidate,
      ["ARTIFACT_COMMITTED", "REGISTERED_SHADOW", "CANARY_ACTIVE", "PROMOTED", "ROLLBACK_REQUESTED"],
    );
  }
  const current = activeModelPointer(db);
  if (current.eventHash === event.event_hash
      && current.generation === requestedGeneration + 1
      && current.artifactHash === target) {
    return { swapped: false, reason: "event-already-consumed", current };
  }
  if (current.generation !== requestedGeneration
      || current.artifactHash !== (authorization.expectedCurrentArtifactHash ?? null)
      || current.eventHash !== (authorization.expectedPointerEventHash ?? null)) {
    return { swapped: false, reason: "authorization-stale", current };
  }
  const nextGeneration = current.generation + 1;
  const result = db.prepare(`
    UPDATE active_model_pointer SET
      generation=?, artifact_hash=?, previous_artifact_hash=?, event_hash=?, updated_at=?
    WHERE singleton=1 AND generation=?
  `).run(
    nextGeneration,
    target,
    current.artifactHash,
    event.event_hash,
    canonicalIso(updatedAt, "updatedAt"),
    requestedGeneration,
  );
  if (Number(result.changes || 0) !== 1) {
    return { swapped: false, reason: "generation-race", current: activeModelPointer(db) };
  }
  return { swapped: true, pointer: activeModelPointer(db) };
});

const verifyLearningLedger = (db) => {
  const errors = [];
  const artifacts = db.prepare("SELECT * FROM model_artifacts ORDER BY artifact_hash").all();
  const artifactHashes = new Set();
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.artifact_bytes);
    if (sha256(bytes) !== artifact.artifact_hash) errors.push(`artifact-hash-mismatch:${artifact.artifact_hash}`);
    if (bytes.length !== Number(artifact.byte_length)) errors.push(`artifact-length-mismatch:${artifact.artifact_hash}`);
    if (sha256(artifact.metadata_json) !== artifact.metadata_hash) errors.push(`artifact-metadata-mismatch:${artifact.artifact_hash}`);
    artifactHashes.add(artifact.artifact_hash);
  }

  const events = db.prepare("SELECT * FROM model_learning_events ORDER BY sequence").all();
  let previousHash = null;
  const cycleHeads = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const row = events[index];
    if (Number(row.sequence) !== index + 1) errors.push(`event-sequence:${index + 1}`);
    if ((row.previous_event_hash || null) !== previousHash) errors.push(`event-chain:${row.sequence}`);
    if (sha256(row.payload_json) !== row.payload_hash) errors.push(`event-payload:${row.sequence}`);
    const expected = sha256(stableStringify(eventProjection(row)));
    if (expected !== row.event_hash) errors.push(`event-hash:${row.sequence}`);
    if (row.artifact_hash && !artifactHashes.has(row.artifact_hash)) errors.push(`event-artifact:${row.sequence}`);
    const cycleHead = cycleHeads.get(row.cycle_id) || null;
    if (Number(row.cycle_sequence) !== Number(cycleHead?.cycle_sequence || 0) + 1) {
      errors.push(`cycle-sequence:${row.sequence}`);
    }
    if ((row.previous_cycle_event_hash || null) !== (cycleHead?.event_hash || null)) {
      errors.push(`cycle-chain:${row.sequence}`);
    }
    const previousState = cycleHead?.state || "__START__";
    if (!(TRANSITIONS[previousState] || []).includes(row.state)) errors.push(`cycle-transition:${row.sequence}`);
    if (PRIVILEGED_EVENT_STATES.has(row.state)) {
      const payload = parseJson(row.payload_json, {});
      const authorization = payload.pointerAuthorization;
      const expectedPreviousState = row.state === "PROMOTED" ? "CANARY_ACTIVE" : "ROLLBACK_REQUESTED";
      if (!authorization || authorization.version !== "active-model-pointer-authorization-v1") {
        errors.push(`privileged-authorization:${row.sequence}`);
      } else {
        if (payload.targetArtifactHash !== row.artifact_hash
            || authorization.targetArtifactHash !== row.artifact_hash) {
          errors.push(`privileged-target:${row.sequence}`);
        }
        if (!Number.isSafeInteger(authorization.expectedGeneration)
            || authorization.expectedGeneration < 0
            || payload.expectedGeneration !== authorization.expectedGeneration) {
          errors.push(`privileged-generation:${row.sequence}`);
        }
        const expectedCurrent = authorization.expectedCurrentArtifactHash;
        if (expectedCurrent !== null && !HASH_PATTERN.test(String(expectedCurrent || ""))) {
          errors.push(`privileged-current-artifact:${row.sequence}`);
        }
        if (authorization.authorizedFromEventHash !== row.previous_cycle_event_hash
            || row.previous_cycle_state !== expectedPreviousState) {
          errors.push(`privileged-cycle-authority:${row.sequence}`);
        }
        if (!authorization.leaseName || !authorization.holderId
            || !Number.isSafeInteger(authorization.fencingToken)
            || authorization.fencingToken <= 0) {
          errors.push(`privileged-lease-authority:${row.sequence}`);
        }
      }
    }
    cycleHeads.set(row.cycle_id, row);
    previousHash = row.event_hash;
  }

  const pointer = activeModelPointer(db);
  if (pointer.artifactHash && !artifactHashes.has(pointer.artifactHash)) errors.push("pointer-artifact-missing");
  if (pointer.eventHash) {
    const event = events.find((row) => row.event_hash === pointer.eventHash);
    const payload = event ? parseJson(event.payload_json, {}) : {};
    const authorization = payload.pointerAuthorization;
    if (!event || !["PROMOTED", "ROLLED_BACK"].includes(event.state)) errors.push("pointer-event-invalid");
    if (event && (event.artifact_hash !== pointer.artifactHash || payload.targetArtifactHash !== pointer.artifactHash)) {
      errors.push("pointer-event-authority-mismatch");
    }
    if (event && (!authorization || authorization.version !== "active-model-pointer-authorization-v1")) {
      errors.push("pointer-event-authorization-missing");
    }
    if (authorization && pointer.generation !== Number(authorization.expectedGeneration) + 1) {
      errors.push("pointer-event-generation-mismatch");
    }
    if (authorization
        && pointer.previousArtifactHash !== (authorization.expectedCurrentArtifactHash ?? null)) {
      errors.push("pointer-event-previous-artifact-mismatch");
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    artifacts: artifacts.length,
    events: events.length,
    cycles: cycleHeads.size,
    headEventHash: previousHash,
    pointer,
  };
};

const writeLedgerHeadAnchor = (db, anchorFile, { generatedAt, hmacKey = null } = {}) => {
  const verification = verifyLearningLedger(db);
  if (!verification.valid) {
    throw new ModelLearningLedgerError("cannot anchor an invalid ledger", {
      code: "LEDGER_INVALID",
      errors: verification.errors,
    });
  }
  const body = {
    version: "model-learning-ledger-head-v1",
    generatedAt: canonicalIso(generatedAt, "generatedAt"),
    headEventHash: verification.headEventHash,
    events: verification.events,
    artifacts: verification.artifacts,
    activeGeneration: verification.pointer.generation,
    activeArtifactHash: verification.pointer.artifactHash,
  };
  const anchorHash = sha256(stableStringify(body));
  const signature = hmacKey
    ? crypto.createHmac("sha256", String(hmacKey)).update(anchorHash).digest("hex")
    : null;
  const anchor = { ...body, anchorHash, signature, signatureType: signature ? "hmac-sha256" : "none" };
  const resolved = path.resolve(anchorFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");
    // Windows rejects fsync on a read-only descriptor even though POSIX commonly
    // permits it. Open read/write so the durability barrier is portable.
    const handle = fs.openSync(temp, "r+");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, resolved);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
  return anchor;
};

module.exports = {
  HASH_PATTERN,
  MODEL_LEARNING_LEDGER_VERSION,
  ModelLearningLedgerError,
  TERMINAL_STATES,
  TRANSITIONS,
  acquireLearningLease,
  activeModelPointer,
  appendAuthorizedPromotion,
  appendAuthorizedRollback,
  appendLearningEvent,
  commitModelArtifact,
  compareAndSwapActiveModel,
  initializeLedger,
  openLearningLedger,
  releaseLearningLease,
  sha256,
  stableStringify,
  verifyLearningLedger,
  writeLedgerHeadAnchor,
};
