"use strict";
const { createHash } = require("node:crypto");
const { verifyHistoricalContentObservation } = require("./historicalContentObservation.cjs");
const VERSION = "recent-form-result-evidence-v1";
const instant = value => {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] || "0"].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (parts[8] !== "Z" && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4, 6)) > 59)) return null;
  // Reject Date.parse calendar rollover; preserve valid original bytes so this
  // metadata repair does not recanonicalize existing valid selection receipts.
  return Number.isFinite(Date.parse(value)) ? value : null;
};
const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

// Describe only the rows the existing form arithmetic selected. No synthetic
// receipt time, source attestation, sorting, deduplication or model-weight change.
function summarizeRecentFormEvidence(rows, teamKey, decisionAt) {
  const selected = rows.map(row => ({ sourceMatchId: text(row.sourceMatchId), homeKey: text(row.homeKey), awayKey: text(row.awayKey),
    kickoffTime: instant(row.kickoffTime), resultObservedAt: instant(row.resultObservedAt), observationSource: text(row.resultObservationSource),
    scoreHome: typeof row.scoreHome === "number" && Number.isFinite(row.scoreHome) ? row.scoreHome : null,
    scoreAway: typeof row.scoreAway === "number" && Number.isFinite(row.scoreAway) ? row.scoreAway : null,
    ...(verifyHistoricalContentObservation(row) ? { localContentReceipt: { firstObservedAt: row.sourceObservation.firstObservedAt, contentHash: row.sourceObservation.contentHash } } : {}) }));
  const decisionClock = instant(decisionAt);
  const dated = selected.filter(row => row.resultObservedAt);
  const last = dated.map(row => row.resultObservedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
  const beforeKickoffRows = dated.filter(row => !row.kickoffTime || Date.parse(row.resultObservedAt) <= Date.parse(row.kickoffTime)).length;
  const afterDecisionRows = decisionClock ? dated.filter(row => Date.parse(row.resultObservedAt) > Date.parse(decisionClock)).length : 0;
  const missingObservedAtRows = selected.length - dated.length;
  const missingSourceRows = selected.filter(row => !row.observationSource).length;
  const contentRows = selected.filter(row => row.localContentReceipt);
  return { version: VERSION, scope: "selected-input-observation-metadata", sourceVerified: false,
    sampleRows: selected.length, homeRows: selected.filter(row => row.homeKey === teamKey).length,
    awayRows: selected.filter(row => row.awayKey === teamKey).length,
    observedRows: dated.length, missingObservedAtRows, missingSourceRows, beforeKickoffRows, afterDecisionRows,
    latestObservedAt: last, decisionAt: decisionClock,
    temporalStatus: !selected.length ? "empty" : beforeKickoffRows || afterDecisionRows ? "conflicting" : missingObservedAtRows || missingSourceRows || !decisionClock ? "unverified" : "clock-recorded",
    // These are labels, not a count of independent evidence providers.
    sourceLabels: [...new Set(selected.map(row => row.observationSource).filter(Boolean))].sort(),
    ...(contentRows.length ? { contentObservation: {
      version: "recent-form-content-receipt-summary-v1", scope: "local-content-receipt-only", sourceVerified: false,
      sampleRows: selected.length, receivedRows: contentRows.length, missingReceiptRows: selected.length - contentRows.length,
      afterDecisionRows: decisionClock ? contentRows.filter(row => Date.parse(row.localContentReceipt.firstObservedAt) > Date.parse(decisionClock)).length : null,
      latestFirstObservedAt: contentRows.map(row => row.localContentReceipt.firstObservedAt).sort().at(-1), decisionAt: decisionClock,
    } } : {}),
    selectionHash: createHash("sha256").update(JSON.stringify({ version: VERSION, teamKey, decisionAt: decisionClock, selected })).digest("hex") };
}
module.exports = { VERSION, summarizeRecentFormEvidence };
