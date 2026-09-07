"use strict";
const { createHash } = require("node:crypto");
const { verifyHistoricalContentObservation } = require("./historicalContentObservation.cjs");
const VERSION = "recent-form-result-evidence-v1";
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
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
