"use strict";
const { createHash } = require("node:crypto");
const VERSION = "public-reference-evidence-v1";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const instant = (value) => typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

// A content-addressed record of what the public publisher actually used.
// This is NOT a provenance attestation or permission to promote a model.
function capturePublicReferenceEvidence(match, record) {
  const feature = match?.predictionMeta?.featureSnapshot;
  const model = match?.probabilityModel;
  if (!feature || feature.migrated === true || !model || !text(record?.decisionId)
    || !text(match?.predictionMeta?.modelVersion || model.version)
    || !text(match?.predictionMeta?.policyVersion)
    || !Number.isFinite(instant(match?.eventVersion))) return null;
  if (String(feature.sourceMatchId || "") !== record.sourceMatchId
    || instant(feature.kickoffTime) !== instant(record.kickoffTime)) return null;
  const clocks = [feature.capturedAt, model.generatedAt, model.unifiedPosterior?.generatedAt]
    .filter((value) => value !== undefined && value !== null);
  if (!clocks.length || !Number.isFinite(instant(feature.capturedAt))
    || clocks.some((value) => !Number.isFinite(instant(value)) || instant(value) > instant(record.decisionAt))) return null;
  const evidence = clone({
    version: VERSION,
    sourceMatchId: record.sourceMatchId, kickoffTime: record.kickoffTime,
    eventVersion: match.eventVersion, businessDate: match.businessDate || null,
    cutoffTime: record.cutoffTime, decisionAt: record.decisionAt,
    recordedAt: record.recordedAt, decisionId: record.decisionId,
    modelVersion: match.predictionMeta.modelVersion || model.version,
    policyVersion: match.predictionMeta.policyVersion,
    featureSnapshot: feature, probabilityModel: model,
    sourceProof: { HAD: match.oddsMarketProvenance || null, HHAD: match.handicapOddsMarketProvenance || null },
    publicPrediction: record.prediction,
  });
  return {
    evidence,
    binding: { version: VERSION, evidenceHash: digest(evidence), featureHash: digest(evidence.featureSnapshot),
      modelHash: digest(evidence.probabilityModel), modelVersion: evidence.modelVersion, policyVersion: evidence.policyVersion },
  };
}

function verifyPublicReferenceEvidence(entry, record) {
  const e = entry?.evidence;
  const b = record?.evidenceBinding;
  if (!e || !b || !e.featureSnapshot || !e.probabilityModel || !e.publicPrediction || record.version !== "public-reference-decision-v2"
    || entry.version !== VERSION || e.version !== VERSION || b.version !== VERSION
    || entry.referenceHash !== record.contentHash || entry.evidenceHash !== b.evidenceHash
    || digest(e) !== b.evidenceHash || digest(e.featureSnapshot) !== b.featureHash
    || digest(e.probabilityModel) !== b.modelHash
    || e.modelVersion !== b.modelVersion || e.policyVersion !== b.policyVersion) return false;
  for (const key of ["sourceMatchId", "kickoffTime", "eventVersion", "cutoffTime", "decisionAt", "recordedAt", "decisionId"]) {
    if (e[key] !== record[key]) return false;
  }
  return digest(e.publicPrediction) === digest(record.prediction);
}

function collectPublicReferenceEvidence(records, entries) {
  const byHash = new Map(records.map((record) => [record.contentHash, record]));
  const retained = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const record = byHash.get(entry?.referenceHash);
    if (!record) continue; // Retention follows the exact public revision ledger.
    if (!verifyPublicReferenceEvidence(entry, record)) throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID");
    if (retained.has(entry.referenceHash) && digest(retained.get(entry.referenceHash)) !== digest(entry)) {
      throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_CONFLICT");
    }
    retained.set(entry.referenceHash, entry);
  }
  for (const record of records) {
    if (record.evidenceBinding && !retained.has(record.contentHash)) throw new Error("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
  }
  return [...retained.values()];
}
function compactPublicDataGaps(feature) {
  const inputs = feature?.modelInputs;
  const gaps = inputs?.dataGaps;
  if (!inputs) return null;
  const string = value => typeof value === "string" ? value.slice(0, 200) : null;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const components = {};
  for (const key of ["referee", "teamCards", "motivation", "lineup", "injuries", "xg", "weather", "strength", "form"]) {
    const c = gaps?.preMatchQuality?.components?.[key];
    if (!c || typeof c !== "object") continue;
    components[key] = Object.fromEntries(["status", "availabilityState", "source", "sourceObservedAt", "expectedPublishedAt"]
      .map(key => [key, string(c[key])]));
  }
    const resultEvidence = value => value?.version === "recent-form-result-evidence-v1" && value.sourceVerified === false
      ? { version: value.version, sourceVerified: false,
        ...Object.fromEntries(["sampleRows", "homeRows", "awayRows", "observedRows", "missingObservedAtRows", "missingSourceRows", "beforeKickoffRows", "afterDecisionRows"].map(key => [key, number(value[key])])),
        latestObservedAt: string(value.latestObservedAt), decisionAt: string(value.decisionAt), temporalStatus: string(value.temporalStatus), selectionHash: string(value.selectionHash) } : null;
    const formSide = value => value && typeof value === "object"
      ? { sampleSize: number(value.sampleSize), lastMatchAt: string(value.lastMatchAt), resultEvidence: resultEvidence(value.resultEvidence) } : null;
  return {
    connected: gaps?.connected ? { ...gaps.connected } : {},
    preMatchQuality: { components },
    calculationUsage: inputs.usageSummary?.version === "model-input-usage-v1" && inputs.usageSummary?.scope === "base-calculation-only"
      ? clone(inputs.usageSummary) : null,
    inputSummaries: {
      version: "decision-input-presence-v1",
      capturedAt: string(feature.capturedAt),
      form: { home: formSide(inputs.form?.home), away: formSide(inputs.form?.away),
        source: string(inputs.form?.historicalSource?.source) },
      elo: { homeMatches: number(inputs.elo?.homeMatches), awayMatches: number(inputs.elo?.awayMatches),
        source: string(inputs.elo?.historicalSource?.source) },
    },
  };
}
module.exports = { VERSION, digest, capturePublicReferenceEvidence, verifyPublicReferenceEvidence, collectPublicReferenceEvidence, compactPublicDataGaps };
