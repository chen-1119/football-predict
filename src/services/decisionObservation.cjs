"use strict";

// Observation time is not an input, computation, or decision time. In particular,
// advancing it must never make a cached decision eligible for a later deadline.
const instant = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
};

function decisionCaptureDisposition(match, capturedAt) {
  const meta = match?.predictionMeta || {};
  const model = match?.probabilityModel || {};
  const captured = instant(capturedAt);
  const decision = instant(meta.decisionGeneratedAt || meta.generatedAt);
  const base = instant(model.generatedAt);
  const unified = instant(model.unifiedPosterior?.generatedAt);
  if (captured === null || decision === null || base === null || unified === null) {
    return { fresh: false, reason: "decision-computation-clock-missing" };
  }
  if (decision < captured || base < captured || unified < captured) {
    return { fresh: false, reason: "cached-decision-reobservation" };
  }
  if (base > unified || unified > decision
      || (meta.modelGeneratedAt && instant(meta.modelGeneratedAt) !== base)
      || (meta.unifiedPosteriorGeneratedAt && instant(meta.unifiedPosteriorGeneratedAt) !== unified)) {
    return { fresh: false, reason: "decision-computation-clock-inconsistent" };
  }
  return { fresh: true, reason: "current-cycle-computation" };
}

function decisionObservationFor(match, observedAt, reason) {
  const meta = match?.predictionMeta || {};
  return {
    version: "decision-reobservation-v1",
    sourceMatchId: String(match?.sourceMatchId || match?.id || ""),
    matchId: match?.id || null,
    kickoffTime: match?.kickoffTime || null,
    decisionId: meta.decisionId || null,
    decisionAt: meta.decisionGeneratedAt || meta.generatedAt || null,
    featureSnapshotHash: meta.featureSnapshotHash || meta.featureSnapshot?.hash || null,
    observedAt,
    reason,
    promotionEligible: false,
  };
}

module.exports = { decisionCaptureDisposition, decisionObservationFor };
