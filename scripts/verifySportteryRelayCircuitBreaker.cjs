const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  planFullProbe,
  transitionCollectorCycle,
  snapshotTrustDetails,
  snapshotCycleDetails,
  shouldRememberTrustedSnapshot,
  writeJsonAtomic,
  copyFileAtomic
} = require("./sportteryRelayCircuit.cjs");
const {
  backoffCurrentLaneProbeMinutes,
  candidateDeadlineUrgencyFromEvaluation,
  effectiveWafProbePolicy,
  realFullCollectionSucceeded,
  relayFailureIsWafBlocked,
  nextBackoffCurrentLaneProbeAt,
  resolveEffectiveUploadMode,
  shouldAttemptBackoffCurrentLane,
  snapshotForUpload,
  snapshotFailureEvidence
} = require("./pushSportteryRelaySnapshot.cjs");

const config = Object.freeze({ failureThreshold: 3, baseMinutes: 15, maxMinutes: 60 });
const minute = 60 * 1000;
const startedAt = Date.parse("2026-07-12T00:00:00.000Z");
const checks = [];

const pushCheck = (name, ok, details = {}) => {
  checks.push({ name, ok: Boolean(ok), ...details });
};

const upstreamWafFailureEvidence = snapshotFailureEvidence({
  errors: [
    { id: "method:concern", method: "concern", error: "official endpoint -> HTTP 567 blocked" },
    { id: "method:result", method: "result", error: "official endpoint -> HTTP 403 blocked" },
    { id: "method:all", method: "all", error: "timeout: official endpoint" },
  ],
});
pushCheck("weak full snapshot retains upstream WAF evidence", (
  upstreamWafFailureEvidence.errors === 3
  && upstreamWafFailureEvidence.wafBlocked === true
  && upstreamWafFailureEvidence.errorClasses?.["waf-blocked"] === 2
  && upstreamWafFailureEvidence.errorClasses?.timeout === 1
  && upstreamWafFailureEvidence.sampleErrors?.[0]?.class === "waf-blocked"
), { upstreamWafFailureEvidence });

const wafBackoffFixture = {
  active: true,
  reason: "cooldown-active",
  fullCircuit: {
    lastFullFailure: {
      wafBlocked: true,
      errorClasses: { "waf-blocked": 2 },
    },
  },
};
const candidateEvaluationFixture = ({
  deadlineAt,
  finalizationAt = Number.isFinite(Date.parse(deadlineAt || ""))
    ? new Date(Date.parse(deadlineAt) + 2 * minute).toISOString()
    : null,
  nearestStatus = "awaiting-market",
  fresh = true,
  skipped = false,
  dueUnrecorded = 0,
} = {}) => ({
  publicScorecard: {
    shadowTracks: {
      CANDIDATE_PROSPECTIVE: {
        state: "ACTIVE",
        chainValid: true,
        candidateRevisionId: "candidate@test",
        captureHeartbeat: {
          version: "prospective-deadline-heartbeat-v2",
          fresh,
          skipped,
          readiness: {
            version: "candidate-prospective-readiness-preview-v2",
            readyInvariantOk: true,
            nearestDeadlineAt: deadlineAt,
            nearestFinalizationAt: finalizationAt,
            nearestStatus,
            admission: {
              dueUnrecorded,
              readyDueUnrecorded: 0,
            },
          },
        },
      },
    },
  },
});
const urgentDeadline = candidateDeadlineUrgencyFromEvaluation({
  evaluation: candidateEvaluationFixture({
    deadlineAt: new Date(startedAt + 90 * minute).toISOString(),
  }),
  nowMs: startedAt,
  urgentWindowMinutes: 120,
});
const nonUrgentDeadline = candidateDeadlineUrgencyFromEvaluation({
  evaluation: candidateEvaluationFixture({
    deadlineAt: new Date(startedAt + 180 * minute).toISOString(),
  }),
  nowMs: startedAt,
  urgentWindowMinutes: 120,
});
pushCheck("valid nearest non-excluded candidate deadline activates bounded urgent recovery", (
  urgentDeadline.valid === true
  && urgentDeadline.urgent === true
  && nonUrgentDeadline.valid === true
  && nonUrgentDeadline.urgent === false
  && effectiveWafProbePolicy({
    deadlineUrgency: urgentDeadline,
    normalProbeMinutes: 10,
    normalProbeMaxMinutes: 60,
    urgentProbeMaxMinutes: 10,
  }).probeMaxMinutes === 10
), {
  urgentDeadline,
  nonUrgentDeadline,
});
const deadlineAtForGrace = new Date(startedAt + 90 * minute).toISOString();
const finalizationAtForGrace = new Date(startedAt + 92 * minute).toISOString();
const insideFinalizationGrace = candidateDeadlineUrgencyFromEvaluation({
  evaluation: candidateEvaluationFixture({
    deadlineAt: deadlineAtForGrace,
    finalizationAt: finalizationAtForGrace,
  }),
  nowMs: startedAt + 91 * minute,
  urgentWindowMinutes: 120,
});
const afterFinalizationGrace = candidateDeadlineUrgencyFromEvaluation({
  evaluation: candidateEvaluationFixture({
    deadlineAt: deadlineAtForGrace,
    finalizationAt: finalizationAtForGrace,
  }),
  nowMs: startedAt + 92 * minute + 1,
  urgentWindowMinutes: 120,
});
pushCheck("collector acceleration remains urgent through evidence finalization grace only", (
  insideFinalizationGrace.version === "candidate-deadline-collector-urgency-v2"
  && insideFinalizationGrace.valid === true
  && insideFinalizationGrace.urgent === true
  && insideFinalizationGrace.phase === "evidence-finalization-grace"
  && insideFinalizationGrace.reason === "candidate-deadline-finalization-grace"
  && insideFinalizationGrace.minutesUntilDeadline === -1
  && insideFinalizationGrace.minutesUntilFinalization === 1
  && effectiveWafProbePolicy({
    deadlineUrgency: insideFinalizationGrace,
    normalProbeMinutes: 10,
    normalProbeMaxMinutes: 60,
    urgentProbeMaxMinutes: 10,
  }).probeMaxMinutes === 10
  && afterFinalizationGrace.valid === false
  && afterFinalizationGrace.urgent === false
  && afterFinalizationGrace.phase === "closed"
), {
  insideFinalizationGrace,
  afterFinalizationGrace,
});
pushCheck("stale skipped excluded or unreconciled deadline evidence cannot accelerate probes", (
  [
    candidateEvaluationFixture({
      deadlineAt: new Date(startedAt + 30 * minute).toISOString(),
      fresh: false,
    }),
    candidateEvaluationFixture({
      deadlineAt: new Date(startedAt + 30 * minute).toISOString(),
      skipped: true,
    }),
    candidateEvaluationFixture({
      deadlineAt: new Date(startedAt + 30 * minute).toISOString(),
      nearestStatus: "excluded",
    }),
    candidateEvaluationFixture({
      deadlineAt: new Date(startedAt + 30 * minute).toISOString(),
      dueUnrecorded: 1,
    }),
  ].every((evaluation) => {
    const urgency = candidateDeadlineUrgencyFromEvaluation({
      evaluation,
      nowMs: startedAt,
      urgentWindowMinutes: 120,
    });
    const policy = effectiveWafProbePolicy({
      deadlineUrgency: urgency,
      normalProbeMinutes: 10,
      normalProbeMaxMinutes: 60,
      urgentProbeMaxMinutes: 10,
    });
    return urgency.valid === false
      && urgency.urgent === false
      && policy.probeMaxMinutes === 60;
  })
));
pushCheck("explicitly disabled WAF current lane suppresses current and calculator probes", (
  relayFailureIsWafBlocked(wafBackoffFixture.fullCircuit.lastFullFailure) === true
  && shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: false,
    healthyFullInterval: false,
    backoff: wafBackoffFixture,
  }) === false
), {
  defaultAttempt: shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: false,
    healthyFullInterval: false,
    backoff: wafBackoffFixture,
  }),
});
pushCheck("first WAF current-lane failure receives one bounded recovery probe", (
  shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: true,
    wafProbeMinutes: 10,
    healthyFullInterval: false,
    backoff: wafBackoffFixture,
    currentLaneState: {
      consecutiveFailures: 1,
      lastAttemptAt: new Date(startedAt).toISOString(),
    },
    nowMs: startedAt + 10 * minute,
  }) === true
));
pushCheck("bounded WAF current probe does not run on every minute scheduler tick", (
  shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: true,
    wafProbeMinutes: 10,
    healthyFullInterval: false,
    backoff: wafBackoffFixture,
    currentLaneState: {
      consecutiveFailures: 1,
      lastAttemptAt: new Date(startedAt).toISOString(),
    },
    nowMs: startedAt + 9 * minute,
  }) === false
  && nextBackoffCurrentLaneProbeAt({
    currentLaneState: {
      consecutiveFailures: 1,
      lastAttemptAt: new Date(startedAt).toISOString(),
    },
    wafProbeMinutes: 10,
  }) === new Date(startedAt + 10 * minute).toISOString()
));
pushCheck("consecutive WAF current-lane failures exponentially back off and cap", (
  backoffCurrentLaneProbeMinutes({
    currentLaneState: { consecutiveFailures: 2 },
    wafProbeMinutes: 10,
    wafProbeMaxMinutes: 60,
  }) === 20
  && backoffCurrentLaneProbeMinutes({
    currentLaneState: { consecutiveFailures: 3 },
    wafProbeMinutes: 10,
    wafProbeMaxMinutes: 60,
  }) === 40
  && backoffCurrentLaneProbeMinutes({
    currentLaneState: { consecutiveFailures: 4 },
    wafProbeMinutes: 10,
    wafProbeMaxMinutes: 60,
  }) === 60
  && backoffCurrentLaneProbeMinutes({
    currentLaneState: { consecutiveFailures: 12 },
    wafProbeMinutes: 10,
    wafProbeMaxMinutes: 60,
  }) === 60
  && nextBackoffCurrentLaneProbeAt({
    currentLaneState: {
      consecutiveFailures: 3,
      lastAttemptAt: new Date(startedAt).toISOString(),
    },
    wafProbeMinutes: 10,
    wafProbeMaxMinutes: 60,
  }) === new Date(startedAt + 40 * minute).toISOString()
));
pushCheck("healthy full interval still refreshes the lightweight lane", (
  shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: false,
    healthyFullInterval: true,
    backoff: wafBackoffFixture,
  }) === true
));
pushCheck("non-WAF full-lane cooldown does not suppress current freshness", (
  shouldAttemptBackoffCurrentLane({
    currentCollectEnabled: true,
    wafCurrentCollectEnabled: false,
    healthyFullInterval: false,
    backoff: {
      fullCircuit: {
        lastFullFailure: { code: "timeout" },
      },
    },
  }) === true
));

const stateFromTransition = (previous, transition) => ({
  ...previous,
  version: 2,
  fullCircuit: transition.fullCircuit,
  currentLaneState: transition.currentLaneState,
  lastCollectorTransitionCycleId: transition.transitionApplied
    ? transition.cycleId
    : previous.lastCollectorTransitionCycleId || null,
  consecutiveCollectFailures: transition.compatibility.consecutiveCollectFailures,
  lastCollectOkAt: transition.compatibility.lastCollectOkAt,
  lastCollectFailedAt: transition.compatibility.lastCollectFailedAt,
  lastFailure: transition.compatibility.lastFailure
});

const transition = (previous, event, nowMs) => {
  const result = transitionCollectorCycle(previous, event, { nowMs, config });
  return { result, state: stateFromTransition(previous, result) };
};

const failFull = (previous, cycleId, nowMs, failure = { code: "waf-blocked", wafBlocked: true }) => transition(previous, {
  cycleId,
  fullAttempted: true,
  fullOk: false,
  fullFailure: failure,
  currentAttempted: true,
  currentOk: false,
  currentFailure: failure
}, nowMs);

let state = {
  version: 2,
  fullCircuit: {
    version: 2,
    circuitState: "closed",
    consecutiveFullFailures: 0,
    lastFullAttemptAt: null,
    lastFullOkAt: null,
    lastFullFailedAt: null,
    nextFullProbeAt: null,
    backoffMinutes: 0,
    lastFullFailure: null,
    lastTransitionCycleId: null
  },
  currentLaneState: {
    version: 1,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastOkAt: null,
    lastFailedAt: null,
    rows: 0,
    usableEndpoints: 0,
    lastTransitionCycleId: null
  }
};

const firstFailure = failFull(state, "full-failure-1", startedAt);
state = firstFailure.state;
pushCheck("a full failure advances exactly once", state.fullCircuit.consecutiveFullFailures === 1, {
  failures: state.fullCircuit.consecutiveFullFailures,
  transitionApplied: firstFailure.result.transitionApplied
});

const duplicateFailure = failFull(state, "full-failure-1", startedAt + 1000);
pushCheck("f same cycle pre/post transition is idempotent", (
  duplicateFailure.state.fullCircuit.consecutiveFullFailures === 1
  && duplicateFailure.result.duplicate === true
  && duplicateFailure.result.transitionApplied === false
), {
  failures: duplicateFailure.state.fullCircuit.consecutiveFullFailures,
  duplicate: duplicateFailure.result.duplicate,
  transitionApplied: duplicateFailure.result.transitionApplied
});

state = failFull(state, "full-failure-2", startedAt + minute).state;
state = failFull(state, "full-failure-3", startedAt + 2 * minute).state;
const cooldownAnchor = {
  failures: state.fullCircuit.consecutiveFullFailures,
  lastFailedAt: state.fullCircuit.lastFullFailedAt,
  nextFullProbeAt: state.fullCircuit.nextFullProbeAt
};

for (let index = 0; index < 10; index += 1) {
  const currentCycle = transition(state, {
    cycleId: `current-only-${index}`,
    fullAttempted: false,
    currentAttempted: true,
    currentOk: true,
    currentRows: 20 + index,
    currentUsableEndpoints: 2
  }, startedAt + (3 + index) * minute);
  state = currentCycle.state;
}
pushCheck("b current-only cooldown cycles do not advance full failure", (
  state.fullCircuit.consecutiveFullFailures === cooldownAnchor.failures
  && state.fullCircuit.lastFullFailedAt === cooldownAnchor.lastFailedAt
  && state.fullCircuit.nextFullProbeAt === cooldownAnchor.nextFullProbeAt
), {
  before: cooldownAnchor,
  after: {
    failures: state.fullCircuit.consecutiveFullFailures,
    lastFailedAt: state.fullCircuit.lastFullFailedAt,
    nextFullProbeAt: state.fullCircuit.nextFullProbeAt,
    currentLastOkAt: state.currentLaneState.lastOkAt
  }
});

const nextProbeMs = Date.parse(state.fullCircuit.nextFullProbeAt);
const beforeProbe = planFullProbe(state, { nowMs: nextProbeMs - 1, config });
const atProbe = planFullProbe(state, { nowMs: nextProbeMs, config });
pushCheck("c fixed cooldown opens one half-open probe at deadline", (
  beforeProbe.active === true
  && beforeProbe.mode === "current-only"
  && atProbe.active === false
  && atProbe.mode === "half-open"
), {
  before: { active: beforeProbe.active, mode: beforeProbe.mode },
  atDeadline: { active: atProbe.active, mode: atProbe.mode },
  nextFullProbeAt: state.fullCircuit.nextFullProbeAt
});

const halfOpenFailure = failFull(state, "half-open-failure", nextProbeMs);
state = halfOpenFailure.state;
const halfOpenNextProbeAt = state.fullCircuit.nextFullProbeAt;
const halfOpenDuplicate = failFull(state, "half-open-failure", nextProbeMs + 1000);
pushCheck("d failed half-open increments once and fixes a later probe", (
  state.fullCircuit.consecutiveFullFailures === 4
  && Date.parse(halfOpenNextProbeAt) === nextProbeMs + 30 * minute
  && halfOpenDuplicate.state.fullCircuit.consecutiveFullFailures === 4
  && halfOpenDuplicate.state.fullCircuit.nextFullProbeAt === halfOpenNextProbeAt
), {
  failures: state.fullCircuit.consecutiveFullFailures,
  backoffMinutes: state.fullCircuit.backoffMinutes,
  nextFullProbeAt: halfOpenNextProbeAt,
  duplicateFailures: halfOpenDuplicate.state.fullCircuit.consecutiveFullFailures
});

for (let index = 0; index < 5; index += 1) {
  state = transition(state, {
    cycleId: `post-half-open-current-${index}`,
    fullAttempted: false,
    currentAttempted: true,
    currentOk: true,
    currentRows: 30,
    currentUsableEndpoints: 2
  }, nextProbeMs + (index + 1) * minute).state;
}
pushCheck("d current lane cannot slide a half-open deadline", state.fullCircuit.nextFullProbeAt === halfOpenNextProbeAt, {
  expected: halfOpenNextProbeAt,
  actual: state.fullCircuit.nextFullProbeAt
});

const recoveryAt = Date.parse(halfOpenNextProbeAt);
state = transition(state, {
  cycleId: "half-open-success",
  fullAttempted: true,
  fullOk: true,
  currentAttempted: true,
  currentOk: true,
  currentRows: 36,
  currentUsableEndpoints: 2
}, recoveryAt).state;
pushCheck("e real full success closes circuit and resets operational failures", (
  state.fullCircuit.circuitState === "closed"
  && state.fullCircuit.consecutiveFullFailures === 0
  && state.fullCircuit.nextFullProbeAt === null
  && state.fullCircuit.lastFullOkAt === new Date(recoveryAt).toISOString()
), {
  circuitState: state.fullCircuit.circuitState,
  failures: state.fullCircuit.consecutiveFullFailures,
  nextFullProbeAt: state.fullCircuit.nextFullProbeAt,
  lastFullOkAt: state.fullCircuit.lastFullOkAt
});

const beforeHealthyFullDue = planFullProbe(state, { nowMs: recoveryAt + 59 * minute, config });
const atHealthyFullDue = planFullProbe(state, { nowMs: recoveryAt + 60 * minute, config });
pushCheck("closed circuit refreshes current between hourly full collections", (
  beforeHealthyFullDue.active === true
  && beforeHealthyFullDue.mode === "current-only"
  && beforeHealthyFullDue.reason === "healthy-full-interval"
  && atHealthyFullDue.active === false
  && atHealthyFullDue.mode === "full"
), {
  beforeDue: {
    active: beforeHealthyFullDue.active,
    mode: beforeHealthyFullDue.mode,
    reason: beforeHealthyFullDue.reason,
    nextScheduledFullAt: beforeHealthyFullDue.nextScheduledFullAt
  },
  atDue: {
    active: atHealthyFullDue.active,
    mode: atHealthyFullDue.mode,
    reason: atHealthyFullDue.reason
  }
});

const legacyState = {
  version: 1,
  consecutiveCollectFailures: 548,
  lastCollectOkAt: "2026-07-10T12:38:52.552Z",
  lastCollectFailedAt: "2026-07-12T10:58:16.308Z",
  lastFailure: { code: "untrusted-relay-snapshot" }
};
const migrationNow = Date.parse("2026-07-12T11:08:00.000Z");
const migrationPlan = planFullProbe(legacyState, { nowMs: migrationNow, config });
const migratedFailure = failFull(legacyState, "legacy-half-open", migrationNow);
pushCheck("v1 inflated count migrates to an immediate bounded half-open probe", (
  migrationPlan.active === false
  && migrationPlan.mode === "half-open"
  && migrationPlan.failures === config.failureThreshold
  && migrationPlan.legacyInflatedFailureCount === 548
  && migratedFailure.state.fullCircuit.consecutiveFullFailures === config.failureThreshold + 1
  && migratedFailure.state.fullCircuit.legacyInflatedFailureCount === 548
), {
  plan: {
    active: migrationPlan.active,
    mode: migrationPlan.mode,
    failures: migrationPlan.failures,
    legacyInflatedFailureCount: migrationPlan.legacyInflatedFailureCount
  },
  afterFailedProbe: {
    failures: migratedFailure.state.fullCircuit.consecutiveFullFailures,
    nextFullProbeAt: migratedFailure.state.fullCircuit.nextFullProbeAt
  }
});

const fixtureCycleId = "sporttery-relay:20260712T000000000Z:fixture-atomic-cycle";
const endpoint = (method, rows, fetchedAt = "2026-07-12T00:00:00.000Z", page = null, sourceCycleId = fixtureCycleId) => ({
  id: method,
  method,
  ...(page === null || page === undefined ? {} : { page }),
  fetchedAt,
  requestedAt: fetchedAt,
  receivedAt: new Date(Date.parse(fetchedAt) + 1000).toISOString(),
  sourceCycleId,
  collectorProvenance: { sourceCycleId },
  collectorAttestation: { keyId: "fixture-existing-attestation", signature: `signed:${method}:${page ?? 1}` },
  ok: true,
  rows,
  payload: {
    value: {
      matchInfoList: [{ subMatchList: Array.from({ length: rows }, (_, index) => ({ matchId: index + 1 })) }]
    }
  }
});

const snapshot = (endpoints, extra = {}) => ({
  version: 1,
  source: "sporttery-relay-snapshot",
  capturedAt: "2026-07-12T00:00:00.000Z",
  sourceCycleId: fixtureCycleId,
  requestedAt: "2026-07-12T00:00:00.000Z",
  completedAt: "2026-07-12T00:00:01.000Z",
  provenanceVersion: 1,
  collectorProvenance: {
    sourceCycleId: fixtureCycleId,
    requestedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:00:01.000Z",
    clock: "collector-owned-wall-clock"
  },
  endpoints,
  errors: [],
  ...extra
});

const currentOnly = snapshot([endpoint("current", 60), endpoint("calculator", 60)]);
const currentResultHead = snapshot([endpoint("current", 23), endpoint("calculator", 1), endpoint("result", 80)]);
const realFull = snapshot([
  endpoint("current", 60),
  endpoint("calculator", 60),
  endpoint("result", 80),
  endpoint("all", 80),
]);
const composite = snapshot(realFull.endpoints, {
  producer: { compositeFromTrustedSnapshot: true },
  summary: { composite: { reason: "test" } }
});
const currentTrust = snapshotTrustDetails(currentOnly, { minRows: 100, minEndpoints: 2 });
const currentResultHeadTrust = snapshotTrustDetails(currentResultHead, { minRows: 100, minEndpoints: 2 });
const fullTrust = snapshotTrustDetails(realFull, { minRows: 100, minEndpoints: 2 });
pushCheck("g full trust requires a usable non-current paged lane", (
  currentTrust.usable === true
  && currentTrust.fullTrusted === false
  && currentResultHeadTrust.fullTrusted === false
  && currentResultHeadTrust.archiveCoverageComplete === false
  && fullTrust.fullTrusted === true
  && fullTrust.archiveCoverageComplete === true
  && fullTrust.pagedUsableEndpoints === 2
), {
  currentOnly: currentTrust,
  currentResultHead: currentResultHeadTrust,
  realFull: fullTrust
});
pushCheck("g composite cannot replace the last real full snapshot", (
  shouldRememberTrustedSnapshot(realFull, { minRows: 100, minEndpoints: 2 }) === true
  && shouldRememberTrustedSnapshot(composite, { minRows: 100, minEndpoints: 2 }) === false
), {
  realFullRemembered: shouldRememberTrustedSnapshot(realFull, { minRows: 100, minEndpoints: 2 }),
  compositeRemembered: shouldRememberTrustedSnapshot(composite, { minRows: 100, minEndpoints: 2 })
});

const mixedCycleFull = snapshot([
  endpoint("current", 60),
  endpoint("calculator", 60, "2026-07-12T00:00:00.000Z", null, "sporttery-relay:other-cycle"),
  endpoint("result", 80),
  endpoint("all", 80)
]);
const mixedCycleTrust = snapshotTrustDetails(mixedCycleFull, { minRows: 100, minEndpoints: 2 });
pushCheck("g mixed collector cycles fail closed even with enough rows and archive coverage", (
  mixedCycleTrust.fullTrusted === false
  && mixedCycleTrust.atomicCycle === false
  && mixedCycleTrust.cycle.blockers.includes("mixed-endpoint-source-cycles")
), { cycle: mixedCycleTrust.cycle, fullTrusted: mixedCycleTrust.fullTrusted });

const pagedFull = snapshot([
  endpoint("current", 23),
  endpoint("calculator", 1),
  endpoint("result", 80, "2026-07-12T00:00:00.000Z", 1),
  endpoint("result", 80, "2026-07-12T00:00:00.000Z", 2),
  endpoint("all", 80, "2026-07-12T00:00:00.000Z", 1),
  endpoint("all", 80, "2026-07-12T00:00:00.000Z", 2)
], {
  summary: { rows: 344, endpoints: 6, usableEndpoints: 6 }
});
const fastUpload = snapshotForUpload(pagedFull, "live");
const fastUploadMethods = fastUpload.snapshot.endpoints.map((row) => `${row.method}:${row.page ?? 1}`);
const fullUpload = snapshotForUpload(pagedFull, "full");
pushCheck("h fast upload contains only current/calculator and result page 1", (
  fastUpload.summary.mode === "live"
  && fastUpload.snapshot.endpoints.length === 3
  && fastUploadMethods.includes("current:1")
  && fastUploadMethods.includes("calculator:1")
  && fastUploadMethods.includes("result:1")
  && !fastUploadMethods.some((key) => key.startsWith("all:"))
  && !fastUploadMethods.includes("result:2")
  && snapshotCycleDetails(fastUpload.snapshot).atomic === true
  && fastUpload.snapshot.sourceCycleId === fixtureCycleId
  && fastUpload.snapshot.endpoints.every((row) => row.collectorAttestation?.signature?.startsWith("signed:"))
), {
  mode: fastUpload.summary.mode,
  endpoints: fastUploadMethods,
  cycle: snapshotCycleDetails(fastUpload.snapshot)
});

let mixedCompactRejected = false;
try {
  snapshotForUpload(mixedCycleFull, "live");
} catch (error) {
  mixedCompactRejected = String(error?.message || error).includes("mixed-cycle compact relay upload");
}
pushCheck("h compact upload refuses mixed cycles instead of laundering endpoint provenance", mixedCompactRejected, {
  mixedCompactRejected
});
pushCheck("h periodic full collection forces a complete HTTP upload", (
  realFullCollectionSucceeded({
    cycleEvent: { fullAttempted: true, fullOk: true },
    collectOk: true,
    collectSkipped: false,
    usedTrustedFallback: false
  }) === true
  && resolveEffectiveUploadMode({
    requestedMode: "live",
    sshUpload: false,
    fullCollectionSucceeded: true,
    staleTrustedFallback: false
  }) === "full"
  && fullUpload.snapshot.endpoints.length === pagedFull.endpoints.length
  && fullUpload.snapshot.endpoints.some((row) => row.method === "result" && row.page === 2)
  && fullUpload.snapshot.endpoints.some((row) => row.method === "all" && row.page === 2)
), {
  requestedMode: "live",
  effectiveMode: resolveEffectiveUploadMode({
    requestedMode: "live",
    sshUpload: false,
    fullCollectionSucceeded: true,
    staleTrustedFallback: false
  }),
  uploadEndpoints: fullUpload.snapshot.endpoints.length
});
pushCheck("h fast cycle keeps the compact upload mode", (
  realFullCollectionSucceeded({
    cycleEvent: { fullAttempted: false, fullOk: false },
    collectOk: false,
    collectSkipped: true,
    usedTrustedFallback: false
  }) === false
  && resolveEffectiveUploadMode({
    requestedMode: "live",
    sshUpload: false,
    fullCollectionSucceeded: false,
    staleTrustedFallback: false
  }) === "live"
), {
  effectiveMode: resolveEffectiveUploadMode({
    requestedMode: "live",
    sshUpload: false,
    fullCollectionSucceeded: false,
    staleTrustedFallback: false
  })
});

const fullRecoveryVerifier = spawnSync(process.execPath, [
  path.join(__dirname, "verifySportteryRelayFullRecovery.cjs")
], {
  cwd: path.resolve(__dirname, ".."),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
let fullRecoveryPayload = null;
try {
  fullRecoveryPayload = JSON.parse(fullRecoveryVerifier.stdout || "null");
} catch {
  fullRecoveryPayload = null;
}
pushCheck("h independent full recovery preserves archive across fast updates", (
  fullRecoveryVerifier.status === 0
  && fullRecoveryPayload?.ok === true
  && fullRecoveryPayload?.summary?.checks === 2
  && fullRecoveryPayload?.summary?.failed === 0
), {
  status: fullRecoveryVerifier.status,
  summary: fullRecoveryPayload?.summary || null,
  stderr: String(fullRecoveryVerifier.stderr || "").slice(-500)
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-relay-circuit-"));
try {
  const statePath = path.join(tempDir, "state.json");
  const copyPath = path.join(tempDir, "last-good.json");
  writeJsonAtomic(statePath, { version: 1, value: "before" });
  writeJsonAtomic(statePath, { version: 2, value: "after" });
  copyFileAtomic(statePath, copyPath);
  const written = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const copied = JSON.parse(fs.readFileSync(copyPath, "utf8"));
  const temporaryFiles = fs.readdirSync(tempDir).filter((file) => file.endsWith(".tmp"));
  pushCheck("state and last-good writes use atomic replacement", (
    written.version === 2
    && copied.version === 2
    && temporaryFiles.length === 0
  ), {
    written,
    copied,
    temporaryFiles
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  verifier: "sporttery-relay-circuit-breaker",
  checkedAt: new Date().toISOString(),
  summary: {
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length
  },
  checks
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
