"use strict";

const { attestPublicReferenceDecision } = require("./publicReferenceDecision.cjs");
const { digest } = require("./publicReferenceEvidence.cjs");
const VERSION = "frozen-review-version-v1";
const fields = ["version", "source", "referenceHash", "evidenceHash", "featureHash", "modelHash", "modelVersion", "policyVersion", "decisionAt", "recordedAt", "cutoffTime", "selection"];
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const versionText = value => typeof value === "string" && value.length > 0 && value.length <= 240 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const clock = value => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === value.slice(0, 10);
const selection = row => {
  if (row?.marketType !== "BEST" || row.recommendationAction !== "reference"
    || !["HAD", "HHAD"].includes(row.oddsPoolCode) || !["1", "X", "2"].includes(row.tipCode)
    || typeof row.odds !== "number" || !Number.isFinite(row.odds) || row.odds < 0) return null;
  const line = row.oddsPoolCode === "HAD" ? 0 : row.handicapLine;
  if (row.oddsPoolCode === "HAD" && row.handicapLine != null && row.handicapLine !== "" && Number(row.handicapLine) !== 0) return null;
  if (line == null || line === "" || !Number.isFinite(Number(line))) return null;
  return JSON.stringify([row.oddsPoolCode, row.tipCode, Number(line), row.odds]);
};

// Compact content receipt, NOT an independent source attestation. The original
// public reference and its evidence remain in the separate hash-addressed ledger.
function compactFrozenReviewVersion(trace, row) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)
    || Object.keys(trace).sort().join("|") !== [...fields, "contentHash"].sort().join("|")
    || trace.version !== VERSION || trace.source !== "public-reference-decision-v2"
    || ![trace.referenceHash, trace.evidenceHash, trace.featureHash, trace.modelHash, trace.contentHash].every(validHash)
    || !versionText(trace.modelVersion) || !versionText(trace.policyVersion)
    || ![trace.decisionAt, trace.recordedAt, trace.cutoffTime].every(clock)
    || Date.parse(trace.decisionAt) > Date.parse(trace.recordedAt) || Date.parse(trace.recordedAt) >= Date.parse(trace.cutoffTime)
    || !selection(row) || trace.selection !== selection(row)) return null;
  const body = Object.fromEntries(fields.map(key => [key, trace[key]]));
  return digest(body) === trace.contentHash ? { ...body, contentHash: trace.contentHash } : null;
}

function captureFrozenReviewVersion(record, match, row) {
  const verified = attestPublicReferenceDecision(record, match), b = verified?.evidenceBinding;
  if (!verified || verified.version !== "public-reference-decision-v2" || !b
    || !selection(row) || selection(row) !== selection(verified.prediction)) return null;
  const body = { version: VERSION, source: verified.version, referenceHash: verified.contentHash,
    evidenceHash: b.evidenceHash, featureHash: b.featureHash, modelHash: b.modelHash,
    modelVersion: b.modelVersion, policyVersion: b.policyVersion, decisionAt: verified.decisionAt,
    recordedAt: verified.recordedAt, cutoffTime: verified.cutoffTime, selection: selection(row) };
  return compactFrozenReviewVersion({ ...body, contentHash: digest(body) }, row);
}

function resolveFrozenReviewVersion(match, row) {
  const stored = compactFrozenReviewVersion(row?.frozenVersion, row);
  if (!stored || row.performanceTrack !== "reference" || row.reviewRole !== "reference") return null;
  const expected = captureFrozenReviewVersion(match?.predictionMeta?.publicReferenceDecision, match, row);
  return expected && expected.contentHash === stored.contentHash ? stored : null;
}

module.exports = { VERSION, frozenReviewSelection: selection, compactFrozenReviewVersion, captureFrozenReviewVersion, resolveFrozenReviewVersion };
