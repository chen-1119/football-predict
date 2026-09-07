"use strict";

const { DECISION_SNAPSHOT_VERSION, isDecisionClockAuditEligible } = require("../src/services/decisionSnapshot.cjs");
const { exactDecisionEventMatch: exactEventBinding } = require("../src/services/decisionEventIdentity.cjs");

// An observation contract, not a new admission gate. Missing selected evidence
// does not prove that an upstream source never collected it.
const VERSION = "prediction-evidence-diagnostics-v1";
const FIELD_CONTRACT = Object.freeze({
  eventIdentity: ["sourceMatchId", "matchId"],
  eventClocks: ["kickoffTime", "cutoffTime", "decisionAt", "capturedAt"],
  implementation: ["version", "modelVersion", "policyVersion", "policyHash"],
  inputBinding: ["featureSnapshotHash", "sourceCycleId"],
  sameDecisionMarket: ["markets.HAD.odds", "markets.HAD.observedAt", "markets.HAD.receivedAt", "markets.HAD.provenanceHash"],
  modelProbabilities: ["probabilities.HAD"],
});
const valueAt = (value, key) => key.split(".").reduce((item, part) => item?.[part], value);
const present = (value) => value !== null && value !== undefined
  && (typeof value !== "string" || value.trim() !== "");
const unique = (values) => [...new Set(values)];

const observePredictionEvidence = ({ match, selectedSnapshot, strictPair } = {}) => {
  const snapshot = selectedSnapshot?.snapshot || null;
  const decision = snapshot?.decisionSnapshot || null;
  const eventBindingExact = exactEventBinding(decision, match);
  // Reuse only the exact object returned by this call's strict pair builder.
  // Stored eligible flags and matching IDs are not proof and are revalidated.
  const clockEligible = Boolean(decision && (strictPair?.decision === decision
    || isDecisionClockAuditEligible(decision)));
  const stage = !decision ? "selected-decision-missing"
    : decision.version !== DECISION_SNAPSHOT_VERSION ? "selected-version-not-promotable"
      : eventBindingExact !== true ? "event-binding-rejected"
        : !clockEligible ? "clock-or-provenance-rejected"
          : !strictPair ? "same-decision-pair-rejected" : "strict-pair-accepted";
  return {
    version: VERSION,
    stage,
    selectedDecisionVersion: decision?.version || null,
    eventBindingExact,
    storedClockClaimEligible: decision?.clockAudit?.eligible === true,
    revalidatedClockEligible: clockEligible,
    clockBlockers: unique((Array.isArray(decision?.clockAudit?.blockers) ? decision.clockAudit.blockers : [])
      .filter((reason) => typeof reason === "string")),
    fields: Object.fromEntries(Object.values(FIELD_CONTRACT).flat().map((key) => [key, present(valueAt(decision, key))])),
    // Business/event versions and first-receipt clocks are separate from the
    // decision-v2 contract. Observe their absence; never synthesize them here.
    supplementalFields: {
      businessDate: present(snapshot?.businessDate),
      eventVersion: present(decision?.eventVersion || snapshot?.eventVersion),
      firstSeenAt: present(snapshot?.firstSeenAt),
    },
  };
};

const classifyRow = (row) => {
  const trace = row?.evidenceTrace;
  if (row?.promotionAudit?.eligible === true) return "eligible";
  if (!trace) return "trace-unavailable";
  if (trace.stage !== "strict-pair-accepted") return trace.stage;
  return "downstream-evidence-rejected";
};

const summarizePredictionEvidence = (rows = []) => {
  const input = Array.isArray(rows) ? rows : [];
  const primaryCounts = {};
  const clockBlockerCounts = {};
  const reasonCounts = {};
  const fieldPresence = Object.fromEntries(Object.values(FIELD_CONTRACT).flat().map((key) => [key, 0]));
  const samples = [];
  const sampleCounts = {};
  let traceRows = 0;
  let eligibleRows = 0;
  let rejectedStoredClockClaims = 0;
  for (const row of input) {
    const trace = row?.evidenceTrace;
    const primary = classifyRow(row);
    primaryCounts[primary] = (primaryCounts[primary] || 0) + 1;
    if (primary === "eligible") eligibleRows += 1;
    if (trace) traceRows += 1;
    if (trace?.storedClockClaimEligible && !trace.revalidatedClockEligible) rejectedStoredClockClaims += 1;
    for (const key of Object.keys(fieldPresence)) if (trace?.fields?.[key] === true) fieldPresence[key] += 1;
    for (const reason of unique(trace?.clockBlockers || [])) clockBlockerCounts[reason] = (clockBlockerCounts[reason] || 0) + 1;
    for (const reason of unique(row?.promotionAudit?.reasons || [])) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (primary !== "eligible" && (sampleCounts[primary] || 0) < 3) {
      sampleCounts[primary] = (sampleCounts[primary] || 0) + 1;
      samples.push({
        matchId: row?.matchId || null,
        sourceMatchId: row?.sourceMatchId || null,
        kickoffTime: row?.kickoffTime || null,
        primary,
        decisionVersion: trace?.selectedDecisionVersion || null,
        clockBlockers: trace?.clockBlockers || [],
        admissionReasons: unique(row?.promotionAudit?.reasons || []),
      });
    }
  }
  return {
    version: VERSION,
    scope: "main-model-probability-cohort-only",
    rows: input.length,
    traceRows,
    eligibleRows,
    rejectedRows: input.length - eligibleRows,
    primaryCounts,
    reasonCounts,
    clockBlockerCounts,
    rejectedStoredClockClaims,
    fieldPresence,
    contract: FIELD_CONTRACT,
    samples,
    policy: {
      onlineEffect: "none",
      changesAdmission: false,
      primaryCountsAreDisjoint: true,
      reasonCountsOverlap: true,
      missingSelectedEvidenceProvesUpstreamAbsence: false,
      recovery: "Only repair a binding after independent immutable source evidence is verified; never reconstruct a pre-match receipt from post-match data.",
      candidateProspectiveCohortIncluded: false,
    },
  };
};

const compactPredictionEvidence = (value) => {
  if (value?.version !== VERSION) return null;
  const keys = ["version", "scope", "rows", "traceRows", "eligibleRows", "rejectedRows", "primaryCounts",
    "reasonCounts", "clockBlockerCounts", "rejectedStoredClockClaims", "fieldPresence", "contract", "policy"];
  return { ...Object.fromEntries(keys.map((key) => [key, value[key]])), hiddenFields: ["samples"] };
};

module.exports = { VERSION, FIELD_CONTRACT, exactEventBinding, observePredictionEvidence, summarizePredictionEvidence, compactPredictionEvidence };
