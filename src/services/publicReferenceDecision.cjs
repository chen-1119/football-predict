"use strict";

const { createHash } = require("node:crypto");
const VERSION = "public-reference-decision-v1";
const BOUND_VERSION = "public-reference-decision-v2";
const { VERSION: EVIDENCE_VERSION, capturePublicReferenceEvidence, compactPublicDataGaps } = require("./publicReferenceEvidence.cjs");
const pendingEvidence = new WeakMap();
const pendingPublicReferenceEvidence = (match) => pendingEvidence.get(match) || null;
const instant = (value) => {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
};
const eventId = (match) => String(match?.sourceMatchId || String(match?.id || "").replace(/^[^_]+_/, "")).trim();
const direction = (prediction) => {
  if (prediction?.marketType !== "BEST" || prediction.recommendationAction !== "reference"
    || !["1", "X", "2"].includes(prediction.tipCode)
    || !["HAD", "HHAD"].includes(prediction.oddsPoolCode)) return null;
  if (prediction.oddsPoolCode === "HAD" && prediction.handicapLine != null
    && String(prediction.handicapLine).trim() !== "" && Number(prediction.handicapLine) !== 0) return null;
  if (prediction.oddsPoolCode === "HHAD"
    && (prediction.handicapLine == null || String(prediction.handicapLine).trim() === ""
      || !Number.isFinite(Number(prediction.handicapLine)))) return null;
  if (typeof prediction.odds !== "number" || !Number.isFinite(prediction.odds) || prediction.odds < 0) return null;
  return `${prediction.oddsPoolCode}:${prediction.tipCode}:${prediction.oddsPoolCode === "HHAD" ? Number(prediction.handicapLine) : 0}`;
};
const publicTip = (best) => {
  // Do not create a second route around the compact public-confidence contract.
  const { marketType, oddsPoolCode, handicapLine, tipCode, tipLabel, odds, trustScore,
    recommendationAction, recommendationTier, visibilityStatus, resultStatus } = best;
  return JSON.parse(JSON.stringify({ marketType, oddsPoolCode, handicapLine, tipCode, tipLabel, odds, trustScore,
    recommendationAction, recommendationTier, visibilityStatus, resultStatus,
    explanation: { zh: "赛前公开参考记录；不计正式命中率。", en: "Public pre-match reference; excluded from formal hit rate." },
    liveRecommendationAction: "withhold",
    confidence: best.confidence ? { available: best.confidence.available, band: best.confidence.band,
      publicMetrics: best.confidence.publicMetrics } : undefined,
  }));
};
const payload = (record) => ({
  version: record.version, sourceMatchId: record.sourceMatchId,
  kickoffTime: record.kickoffTime, eventVersion: record.eventVersion,
  cutoffTime: record.cutoffTime, recordedAt: record.recordedAt,
  decisionAt: record.decisionAt, decisionId: record.decisionId,
  revision: record.revision, previousHash: record.previousHash,
  prediction: record.prediction,
  dataGaps: record.dataGaps || null,
  ...(record.version === BOUND_VERSION ? { evidenceBinding: record.evidenceBinding || null } : {}),
});
const hash = (record) => createHash("sha256").update(JSON.stringify(payload(record))).digest("hex");

function attestPublicReferenceDecision(record, match) {
  if (!record || ![VERSION, BOUND_VERSION].includes(record.version) || !direction(record.prediction)
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || (record.previousHash !== null && !/^[a-f0-9]{64}$/.test(record.previousHash || ""))
    || record.contentHash !== hash(record) || !eventId(match)
    || record.sourceMatchId !== eventId(match)) return null;
  if (record.version === BOUND_VERSION && record.evidenceBinding) {
    const b = record.evidenceBinding;
    if (b.version !== EVIDENCE_VERSION || ![b.evidenceHash, b.featureHash, b.modelHash].every((v) => /^[a-f0-9]{64}$/.test(v || ""))
      || !b.modelVersion || !b.policyVersion) return null;
  }
  const [kickoff, matchKickoff, cutoff, recorded, decided] = [record.kickoffTime, match.kickoffTime,
    record.cutoffTime, record.recordedAt, record.decisionAt].map(instant);
  if ([kickoff, matchKickoff, cutoff, recorded, decided].some((value) => value === null)
    || kickoff !== matchKickoff || cutoff > kickoff || recorded >= cutoff || decided > recorded
    || (record.eventVersion && instant(record.eventVersion) === null)
    || (record.eventVersion && match.eventVersion && instant(record.eventVersion) !== instant(match.eventVersion))) return null;
  const currentCutoff = [match.predictionMeta?.cutoffTime, match.buyEndTime, match.kickoffTime]
    .map(instant).filter((value) => value !== null);
  if (recorded >= Math.min(...currentCutoff)) return null;
  return { ...record, integrityVerified: true };
}

// Only the finalized PUBLIC output calls this function, never prospective
// observations. Provider-prefixed IDs are aliases; exact event clocks are not.
function bindPublicReferenceDecision(match, existing, recordedAtValue) {
  const previous = attestPublicReferenceDecision(existing?.predictionMeta?.publicReferenceDecision, match)
    || attestPublicReferenceDecision(match?.predictionMeta?.publicReferenceDecision, match);
  const recorded = instant(recordedAtValue);
  const kickoff = instant(match?.kickoffTime);
  const cutoffTimes = [match?.predictionMeta?.cutoffTime, match?.buyEndTime, match?.kickoffTime]
    .map(instant).filter((value) => value !== null);
  const cutoff = cutoffTimes.length ? Math.min(...cutoffTimes) : null;
  const best = match?.predictions?.find((tip) => direction(tip));
  const decisionAt = match?.predictionMeta?.decisionGeneratedAt || match?.predictionMeta?.generatedAt;
  const decided = instant(decisionAt);
  const open = match?.status === "SCHEDULED" && recorded !== null && cutoff !== null
    && kickoff !== null && recorded < cutoff && recorded < kickoff;
  // A failed current public decision (including WATCH) cannot be replaced by
  // an older reference while sales are open. After cutoff only replay is legal.
  let record = !open ? previous : null;
  let capturedEvidence = null;
  if (open && best && decided !== null && decided <= recorded && eventId(match)) {
    const unchanged = previous && previous.decisionId === (match.predictionMeta?.decisionId || null)
      && direction(previous.prediction) === direction(best) && previous.prediction.odds === best.odds;
    if (unchanged) record = previous;
    else {
      const next = {
        version: BOUND_VERSION, sourceMatchId: eventId(match), kickoffTime: new Date(kickoff).toISOString(),
        eventVersion: match.eventVersion || null, cutoffTime: new Date(cutoff).toISOString(),
        recordedAt: new Date(recorded).toISOString(), decisionAt: new Date(decided).toISOString(),
        decisionId: match.predictionMeta?.decisionId || null,
        revision: (previous?.revision || 0) + 1, previousHash: previous?.contentHash || null,
        prediction: publicTip(best),
        dataGaps: compactPublicDataGaps(match.predictionMeta?.featureSnapshot),
      };
      capturedEvidence = capturePublicReferenceEvidence(match, next);
      next.evidenceBinding = capturedEvidence?.binding || null;
      record = attestPublicReferenceDecision({ ...next, contentHash: hash(next) }, match);
    }
  }
  const result = { ...match, predictionMeta: { ...(match.predictionMeta || {}), publicReferenceDecision: record || undefined } };
  if (record && capturedEvidence) pendingEvidence.set(result, {
    version: EVIDENCE_VERSION, referenceHash: record.contentHash,
    evidenceHash: capturedEvidence.binding.evidenceHash, evidence: capturedEvidence.evidence,
  });
  return result;
}

module.exports = { attestPublicReferenceDecision, bindPublicReferenceDecision, pendingPublicReferenceEvidence };
