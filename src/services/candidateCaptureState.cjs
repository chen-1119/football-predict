"use strict";

// Operational capture health is not model nomination or promotion permission.
// ACTIVE keeps its existing contract. SHADOW needs an explicit, bound receipt
// proving that observation has not inherited any formal trial evidence.
const VERSION = "candidate-shadow-observation-state-v1";
const FORMAL_COUNTS = [
  "universe", "admitted", "excluded", "pending", "settled",
  "invalidSettlements", "invalid", "finalized",
];
const hashValid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const shadowAuditUnactivated = (audit) => Boolean(
  audit?.version === "candidate-prospective-audit-v1"
  && audit.state === "SHADOW"
  && audit.chainValid === true
  && audit.onlineEffect === false
  && audit.activationAt === null
  && audit.promotionReviewReady === false
  && audit.formalPromotionEligible === false
  && typeof audit.candidateRevisionId === "string" && audit.candidateRevisionId.length > 0
  && hashValid(audit.rootHash)
  && Number.isFinite(Date.parse(audit.evaluatedAt))
  && Number.isFinite(Date.parse(audit.frozenAt))
  && Date.parse(audit.frozenAt) <= Date.parse(audit.evaluatedAt)
  && audit.cohort?.formal?.denominatorReconciled === true
  && FORMAL_COUNTS.every((key) => audit.cohort.formal[key] === 0)
  && audit.metrics?.formalRows === 0
  && (Object.hasOwn(audit.metrics, "windowEvaluation")
    ? audit.metrics.windowEvaluation?.registeredWindows === 0
      && Array.isArray(audit.metrics.windows) && audit.metrics.windows.length === 0
    : audit.metrics.registeredCalendarWindows === 0 && audit.metrics.calendarWindows === 0)
  && (!Object.hasOwn(audit.metrics, "registeredCalendarWindows")
    || audit.metrics.registeredCalendarWindows === 0)
);

const buildShadowObservationState = (audit) => {
  if (!shadowAuditUnactivated(audit)) return null;
  return {
    version: VERSION,
    mode: "shadow-observation",
    reason: "candidate-awaiting-prospective-nomination",
    candidateRevisionId: audit.candidateRevisionId,
    rootHash: audit.rootHash,
    evaluatedAt: audit.evaluatedAt,
    frozenAt: audit.frozenAt,
    formalTrialActive: false,
    formalRecommendationAllowed: false,
    onlineEffect: false,
  };
};

const shadowObservationAuditValid = (audit) => {
  const expected = buildShadowObservationState(audit);
  const receipt = audit?.captureState;
  return Boolean(expected && receipt && Object.keys(expected).every(
    (key) => Object.hasOwn(receipt, key) && receipt[key] === expected[key],
  ));
};

// The server must not project a prior revision/root's healthy receipt while a
// refreeze or append-only capture has advanced the authoritative registry.
const projectShadowObservationState = (audit, registry) => {
  const ledger = Array.isArray(registry?.ledgers)
    ? registry.ledgers.find((row) => row?.ledgerId === registry.activeLedgerId) : null;
  if (!shadowObservationAuditValid(audit)
    || ledger?.header?.candidateRevisionId !== audit.candidateRevisionId
    || ledger?.rootHash !== audit.rootHash
    || ledger?.header?.frozenAt !== audit.frozenAt
    || !Array.isArray(ledger?.events)
    || ledger.events.some((event) => event.type === "activation" || event.phase === "formal")
  ) return null;
  return buildShadowObservationState(audit);
};

module.exports = {
  VERSION, FORMAL_COUNTS, buildShadowObservationState,
  shadowObservationAuditValid, projectShadowObservationState,
};
