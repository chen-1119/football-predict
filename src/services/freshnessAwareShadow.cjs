"use strict";
const VERSION = "freshness-aware-market-shrinkage-shadow-v1";
const KEYS = ["1", "X", "2"];
const triplet = (input) => {
  if (!input || !KEYS.every((key) => typeof input[key] === "number" && Number.isFinite(input[key])
    && input[key] >= 0 && input[key] <= 1)) return null;
  return Math.abs(KEYS.reduce((sum, key) => sum + input[key], 0) - 1) <= 0.001 ? input : null;
};

/** Fixed, unoptimized research policy. No current outcomes, LLM input or live writes. */
function evaluateFreshnessAwareShadow(row) {
  const decision = row?.decisionSnapshot;
  const clock = decision?.clockAudit;
  const model = triplet(decision?.probabilities?.HAD);
  const market = triplet(decision?.markets?.HAD?.marketProbabilities);
  const decided = Date.parse(decision?.decisionAt || "");
  const cutoff = Date.parse(decision?.cutoffTime || "");
  const kickoff = Date.parse(decision?.kickoffTime || "");
  const captured = Date.parse(decision?.capturedAt || "");
  const observed = Date.parse(decision?.markets?.HAD?.observedAt || "");
  const received = Date.parse(decision?.markets?.HAD?.receivedAt || "");
  const blockers = [];
  if (!model || !market) blockers.push("missing-valid-probability-pair");
  if (decision?.version !== "candidate-decision-snapshot-v2" || clock?.eligible !== true
    || ![decided, cutoff, kickoff, captured, observed, received].every(Number.isFinite)
    || decided >= Math.min(cutoff, kickoff) || captured >= Math.min(cutoff, kickoff)
    || observed > decided || received > decided) blockers.push("precutoff-clock-proof-missing");
  if (clock?.markets?.HAD?.provenanceEligible !== true) blockers.push("market-provenance-not-verified");
  const form = row?.featureSnapshot?.modelInputs?.form;
  const ages = [form?.home?.lastMatchAt, form?.away?.lastMatchAt].map((value) => {
    const last = Date.parse(value || "");
    return Number.isFinite(last) && last <= decided ? (decided - last) / 86400000 : null;
  });
  const knownForm = ages.every((age) => age !== null);
  // A 60-day half-life is a registered research assumption, not a claim that
  // offseason history is invalid. Missing clocks yield zero residual weight.
  const recencyWeight = knownForm ? Math.pow(0.5, Math.max(...ages) / 60) : 0;
  const quality = typeof decision?.dataQuality === "number" && Number.isFinite(decision.dataQuality)
    ? Math.max(0, Math.min(1, decision.dataQuality)) : 0;
  const modelWeight = 0.25 * quality * recencyWeight;
  return {
    version: VERSION, mode: "shadow-only", promotionAllowed: false,
    eligible: blockers.length === 0, blockers, modelWeight, formAgeDays: ages,
    probabilities: blockers.length ? null : Object.fromEntries(KEYS.map((key) =>
      [key, market[key] * (1 - modelWeight) + model[key] * modelWeight])),
    diagnostics: { missingFormClock: !knownForm, policyTunedOnResults: false },
  };
}
module.exports = { VERSION, evaluateFreshnessAwareShadow };
