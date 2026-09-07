"use strict";
const { strictInstant } = require("../src/services/strictInstant.cjs");
const VERSION = "api-football-clock-evidence-v2";
const present = value => value !== undefined && value !== null;

function temporalEligibilityFor(fetchedAt, cutoff) {
  const receipt = strictInstant(fetchedAt), deadline = strictInstant(cutoff);
  const eligible = Boolean(receipt && deadline && Date.parse(receipt) <= Date.parse(deadline));
  return { eligible, fetchedAt: receipt, cutoff: deadline, basis: "fetchedAt<=cutoff",
    reason: eligible ? "Observed no later than the pre-match cutoff."
      : "Observed after cutoff or a strict zoned clock could not be proven." };
}

function prematchCutoffFor(entry) {
  const values = [entry?.match?.buyEndTime, entry?.match?.predictionMeta?.cutoffTime,
    entry?.match?.cutoffTime, entry?.match?.kickoffTime, entry?.map?.fixtureDate];
  // Null/undefined mean absent optional fields. An explicitly malformed primary
  // field may not fall through to a later, more permissive clock.
  return strictInstant(values.find(present));
}

function buildClockEvidence({ observedAt, sourceUpdatedAt, cutoff }) {
  const receipt = strictInstant(observedAt), sourceClock = strictInstant(sourceUpdatedAt);
  const temporalEligibility = temporalEligibilityFor(observedAt, cutoff);
  const sourceTimeStatus = !present(sourceUpdatedAt) ? "missing"
    : !sourceClock ? "invalid"
      : receipt && Date.parse(sourceClock) > Date.parse(receipt) ? "after-receipt" : "recorded";
  if (["invalid", "after-receipt"].includes(sourceTimeStatus)) {
    temporalEligibility.eligible = false;
    temporalEligibility.reason = "Upstream update clock is invalid or later than the receipt.";
  }
  return { observedAt: receipt, sourceUpdatedAt: sourceClock,
    clockEvidence: { version: VERSION, receiptStatus: receipt ? "recorded" : "missing-or-invalid",
      sourceTimeStatus, upstreamTimeVerified: false, scope: "local-response-receipt-not-official-publication" },
    temporalEligibility };
}

function pieceClockEligible(piece, entry = null) {
  if (piece?.clockEvidence?.version !== VERSION || piece.temporalEligibility?.eligible !== true) return false;
  const receipt = piece.observedAt;
  const cutoff = entry ? prematchCutoffFor(entry) : piece.temporalEligibility?.cutoff;
  const clocks = buildClockEvidence({ observedAt: receipt, sourceUpdatedAt: piece.sourceUpdatedAt, cutoff });
  return clocks.temporalEligibility.eligible
    && piece.provenance?.fetchedAt === receipt
    && piece.provenance?.sourceUpdatedAt === piece.sourceUpdatedAt
    && piece.temporalEligibility?.fetchedAt === receipt
    && piece.temporalEligibility?.cutoff === cutoff
    && piece.clockEvidence?.sourceTimeStatus === clocks.clockEvidence.sourceTimeStatus;
}

module.exports = { VERSION, temporalEligibilityFor, prematchCutoffFor, buildClockEvidence, pieceClockEligible };
