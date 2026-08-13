"use strict";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const count = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
};

const cleanState = (state = {}) => ({
  version: "candidate-heartbeat-continuity-v1",
  candidateRevisionId: state.candidateRevisionId || null,
  lastEvaluatedAt: state.lastEvaluatedAt || null,
  lastRootHash: state.lastRootHash || null,
  lastAdmittedRows: count(state.lastAdmittedRows),
  lastAtomicRows: count(state.lastAtomicRows),
  transitions: count(state.transitions) || 0,
  noOpTransitions: count(state.noOpTransitions) || 0,
  stableNoOpTransitions: count(state.stableNoOpTransitions) || 0,
  eventTransitions: count(state.eventTransitions) || 0,
  supersededEventTransitions: count(state.supersededEventTransitions) || 0,
  candidateResets: count(state.candidateResets) || 0,
  pendingEventProof: state.pendingEventProof === true,
  idempotencyVerified: state.idempotencyVerified === true,
  lastEventEvaluatedAt: state.lastEventEvaluatedAt || null,
  lastVerifiedAt: state.lastVerifiedAt || null,
  violation: state.violation || null,
});

const continuityObservation = (input = {}) => ({
  candidateRevisionId: String(input.candidateRevisionId || "").trim() || null,
  evaluatedAt: String(input.evaluatedAt || "").trim() || null,
  rootHash: String(input.rootHash || "").trim().toLowerCase() || null,
  eventsAdded: count(input.eventsAdded),
  admittedRows: count(input.admittedRows),
  atomicRows: count(input.atomicRows),
});

const violation = (code, previous, current) => ({
  code,
  detectedAt: new Date().toISOString(),
  previous,
  current,
});

const advanceCandidateHeartbeatContinuity = (priorState, input = {}) => {
  const previous = cleanState(priorState);
  const current = continuityObservation(input);
  const next = { ...previous };

  if (
    !current.candidateRevisionId
    || !current.evaluatedAt
    || !SHA256_PATTERN.test(String(current.rootHash || ""))
    || current.eventsAdded === null
    || current.admittedRows === null
    || current.atomicRows === null
  ) {
    next.violation = violation("heartbeat-continuity-observation-invalid", {
      candidateRevisionId: previous.candidateRevisionId,
      evaluatedAt: previous.lastEvaluatedAt,
      rootHash: previous.lastRootHash,
    }, current);
    return next;
  }
  if (current.admittedRows !== current.atomicRows) {
    next.violation = violation("heartbeat-continuity-atomic-row-mismatch", {
      admittedRows: previous.lastAdmittedRows,
      atomicRows: previous.lastAtomicRows,
    }, current);
    return next;
  }

  if (
    previous.candidateRevisionId
    && previous.candidateRevisionId !== current.candidateRevisionId
  ) {
    return {
      ...cleanState(),
      candidateRevisionId: current.candidateRevisionId,
      lastEvaluatedAt: current.evaluatedAt,
      lastRootHash: current.rootHash,
      lastAdmittedRows: current.admittedRows,
      lastAtomicRows: current.atomicRows,
      candidateResets: previous.candidateResets + 1,
    };
  }

  if (!previous.lastEvaluatedAt) {
    return {
      ...next,
      candidateRevisionId: current.candidateRevisionId,
      lastEvaluatedAt: current.evaluatedAt,
      lastRootHash: current.rootHash,
      lastAdmittedRows: current.admittedRows,
      lastAtomicRows: current.atomicRows,
      violation: null,
    };
  }

  if (previous.lastEvaluatedAt === current.evaluatedAt) {
    if (
      previous.lastRootHash !== current.rootHash
      || previous.lastAdmittedRows !== current.admittedRows
      || previous.lastAtomicRows !== current.atomicRows
    ) {
      next.violation = violation("same-heartbeat-state-drift", {
        evaluatedAt: previous.lastEvaluatedAt,
        rootHash: previous.lastRootHash,
        admittedRows: previous.lastAdmittedRows,
        atomicRows: previous.lastAtomicRows,
      }, current);
    }
    return next;
  }

  next.transitions += 1;
  if (current.eventsAdded === 0) {
    next.noOpTransitions += 1;
    if (
      previous.lastRootHash !== current.rootHash
      || previous.lastAdmittedRows !== current.admittedRows
      || previous.lastAtomicRows !== current.atomicRows
    ) {
      next.violation = violation("no-op-heartbeat-mutated-ledger", {
        evaluatedAt: previous.lastEvaluatedAt,
        rootHash: previous.lastRootHash,
        admittedRows: previous.lastAdmittedRows,
        atomicRows: previous.lastAtomicRows,
      }, current);
    } else {
      next.stableNoOpTransitions += 1;
      if (previous.pendingEventProof) {
        next.pendingEventProof = false;
        next.idempotencyVerified = true;
        next.lastVerifiedAt = current.evaluatedAt;
      }
    }
  } else {
    next.eventTransitions += 1;
    if (previous.pendingEventProof) next.supersededEventTransitions += 1;
    if (previous.lastRootHash === current.rootHash) {
      next.violation = violation("event-heartbeat-did-not-advance-root", {
        evaluatedAt: previous.lastEvaluatedAt,
        rootHash: previous.lastRootHash,
      }, current);
    } else {
      next.pendingEventProof = true;
      next.idempotencyVerified = false;
      next.lastEventEvaluatedAt = current.evaluatedAt;
    }
  }

  next.candidateRevisionId = current.candidateRevisionId;
  next.lastEvaluatedAt = current.evaluatedAt;
  next.lastRootHash = current.rootHash;
  next.lastAdmittedRows = current.admittedRows;
  next.lastAtomicRows = current.atomicRows;
  return next;
};

module.exports = {
  advanceCandidateHeartbeatContinuity,
  cleanState,
  continuityObservation,
};
