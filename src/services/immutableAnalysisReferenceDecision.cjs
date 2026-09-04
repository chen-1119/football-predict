"use strict";

const crypto = require("node:crypto");
const {
  buildExternalOddsAnalysisReference,
} = require("./externalOddsAnalysisReference.cjs");

const IMMUTABLE_ANALYSIS_REFERENCE_VERSION = "immutable-analysis-reference-decision-v1";
const IMMUTABLE_ANALYSIS_REFERENCE_INTEGRITY_VERSION = "immutable-analysis-reference-integrity-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const OUTCOME_CODES = new Set(["1", "X", "2"]);

const text = (value) => typeof value === "string" ? value.trim() : "";
const timestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const finiteProbability = (value) => {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
};
const sourceMatchIdFor = (match) => text(
  match?.sourceMatchId || String(match?.id || "").replace(/^[^_]+_/, ""),
);

const sourceOdds = (value) => {
  const odds = {
    odds1: finiteNumber(value?.odds1),
    oddsX: finiteNumber(value?.oddsX),
    odds2: finiteNumber(value?.odds2),
  };
  return Object.values(odds).every((item) => item !== null && item > 1) ? odds : null;
};

const canonicalPayload = (decision) => ({
  version: decision?.version,
  sourcePolicyVersion: decision?.sourcePolicyVersion,
  matchId: decision?.matchId,
  sourceMatchId: decision?.sourceMatchId,
  eventVersion: decision?.eventVersion || null,
  kickoffTime: decision?.kickoffTime,
  cutoffTime: decision?.cutoffTime,
  decisionAt: decision?.decisionAt,
  sourceUpdatedAt: decision?.sourceUpdatedAt,
  sourceCycleId: decision?.sourceCycleId || null,
  selectionReason: decision?.selectionReason,
  market: decision?.market,
  code: decision?.code,
  selectedSourceOdds: decision?.selectedSourceOdds,
  sourceOdds: decision?.sourceOdds,
  marketProbability: decision?.marketProbability,
  runnerUpProbability: decision?.runnerUpProbability,
  leaderGap: decision?.leaderGap,
  source: decision?.source,
  statisticsTrack: decision?.statisticsTrack,
  executable: decision?.executable,
  formalEligible: decision?.formalEligible,
  liveEligible: decision?.liveEligible,
  betSlipEligible: decision?.betSlipEligible,
});

const hashImmutableAnalysisReferenceDecision = (decision) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalPayload(decision)))
  .digest("hex");

const verifyImmutableAnalysisReferenceDecision = (decision, match) => {
  const blockers = [];
  if (!decision || typeof decision !== "object") {
    return { valid: false, blockers: ["analysis-reference-decision-missing"], computedHash: null };
  }

  const computedHash = hashImmutableAnalysisReferenceDecision(decision);
  const kickoffAt = timestamp(decision.kickoffTime);
  const cutoffAt = timestamp(decision.cutoffTime);
  const decisionAt = timestamp(decision.decisionAt);
  const sourceUpdatedAt = timestamp(decision.sourceUpdatedAt);
  const selectedSourceOdds = finiteNumber(decision.selectedSourceOdds);
  const odds = sourceOdds(decision.sourceOdds);

  if (decision.version !== IMMUTABLE_ANALYSIS_REFERENCE_VERSION) blockers.push("analysis-reference-version-invalid");
  if (!text(decision.sourcePolicyVersion)) blockers.push("analysis-reference-source-policy-missing");
  if (!OUTCOME_CODES.has(String(decision.code || ""))) blockers.push("analysis-reference-code-invalid");
  if (decision.market !== "HAD") blockers.push("analysis-reference-market-invalid");
  if (!odds) blockers.push("analysis-reference-source-odds-invalid");
  if (selectedSourceOdds === null || selectedSourceOdds <= 1) blockers.push("analysis-reference-selected-odds-invalid");
  if (finiteProbability(decision.marketProbability) === null) blockers.push("analysis-reference-market-probability-invalid");
  if (finiteProbability(decision.runnerUpProbability) === null) blockers.push("analysis-reference-runner-up-probability-invalid");
  if (finiteProbability(decision.leaderGap) === null) blockers.push("analysis-reference-leader-gap-invalid");
  if (decision.source?.provider !== "500.com" || decision.source?.official !== false) {
    blockers.push("analysis-reference-source-invalid");
  }
  if (decision.selectionReason !== "model-inputs-insufficient") blockers.push("analysis-reference-reason-invalid");
  if (decision.statisticsTrack !== "analysis-only") blockers.push("analysis-reference-statistics-track-invalid");
  for (const key of ["executable", "formalEligible", "liveEligible", "betSlipEligible"]) {
    if (decision[key] !== false) blockers.push(`analysis-reference-${key}-must-be-false`);
  }
  if (!SHA256_PATTERN.test(String(decision.contentHash || ""))) blockers.push("analysis-reference-hash-missing-or-invalid");
  else if (decision.contentHash !== computedHash) blockers.push("analysis-reference-hash-mismatch");
  if (kickoffAt === null || cutoffAt === null || decisionAt === null || sourceUpdatedAt === null) {
    blockers.push("analysis-reference-clock-invalid");
  } else {
    if (sourceUpdatedAt > decisionAt) blockers.push("analysis-reference-source-after-decision");
    if (decisionAt >= cutoffAt) blockers.push("analysis-reference-decision-after-cutoff");
    if (sourceUpdatedAt >= cutoffAt) blockers.push("analysis-reference-source-after-cutoff");
    if (cutoffAt > kickoffAt) blockers.push("analysis-reference-cutoff-after-kickoff");
  }

  if (match) {
    if (text(decision.sourceMatchId) !== sourceMatchIdFor(match)) blockers.push("analysis-reference-match-id-mismatch");
    if (text(decision.matchId) && text(match.id) && text(decision.matchId) !== text(match.id)) {
      blockers.push("analysis-reference-public-match-id-mismatch");
    }
    const matchKickoffAt = timestamp(match.kickoffTime);
    if (kickoffAt === null || matchKickoffAt === null || kickoffAt !== matchKickoffAt) {
      blockers.push("analysis-reference-kickoff-mismatch");
    }
    if (text(decision.eventVersion) && text(match.eventVersion) && decision.eventVersion !== match.eventVersion) {
      blockers.push("analysis-reference-event-version-mismatch");
    }
  }

  return { valid: blockers.length === 0, blockers: Array.from(new Set(blockers)), computedHash };
};

const attestImmutableAnalysisReferenceDecision = (decision, match) => {
  const verification = verifyImmutableAnalysisReferenceDecision(decision, match);
  if (!verification.valid) return null;
  return {
    ...decision,
    integrityVerified: true,
    integrityVersion: IMMUTABLE_ANALYSIS_REFERENCE_INTEGRITY_VERSION,
  };
};

const buildImmutableAnalysisReferenceDecision = (match, decisionAtValue) => {
  if (match?.probabilityModel?.inputSufficiency?.sufficient !== false) return null;
  const decisionAt = timestamp(decisionAtValue);
  if (decisionAt === null) return null;
  const reference = buildExternalOddsAnalysisReference(match, decisionAt);
  if (!reference?.sourceUpdatedAt) return null;
  const cutoffCandidates = [
    match?.predictionMeta?.cutoffTime,
    match?.buyEndTime,
    match?.kickoffTime,
  ].map(timestamp).filter((value) => value !== null);
  const cutoffAt = cutoffCandidates.length ? Math.min(...cutoffCandidates) : null;
  const kickoffAt = timestamp(match?.kickoffTime);
  const sourceUpdatedAt = timestamp(reference.sourceUpdatedAt);
  if (
    cutoffAt === null
    || kickoffAt === null
    || sourceUpdatedAt === null
    || decisionAt >= cutoffAt
    || sourceUpdatedAt > decisionAt
    || sourceUpdatedAt >= cutoffAt
    || cutoffAt > kickoffAt
  ) return null;

  const payload = canonicalPayload({
    version: IMMUTABLE_ANALYSIS_REFERENCE_VERSION,
    sourcePolicyVersion: reference.version,
    matchId: text(match.id),
    sourceMatchId: sourceMatchIdFor(match),
    eventVersion: text(match.eventVersion) || null,
    kickoffTime: new Date(kickoffAt).toISOString(),
    cutoffTime: new Date(cutoffAt).toISOString(),
    decisionAt: new Date(decisionAt).toISOString(),
    sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString(),
    sourceCycleId: text(match?.predictionMeta?.sourceCycleId || match?.sourceCycleId) || null,
    selectionReason: "model-inputs-insufficient",
    market: "HAD",
    code: reference.tipCode,
    selectedSourceOdds: reference.selectedSourceOdds,
    sourceOdds: { ...reference.sourceOdds },
    marketProbability: reference.leaderProbability,
    runnerUpProbability: reference.runnerUpProbability,
    leaderGap: reference.leaderGap,
    source: {
      provider: "500.com",
      official: false,
      rawSource: reference.source.rawSource,
    },
    statisticsTrack: "analysis-only",
    executable: false,
    formalEligible: false,
    liveEligible: false,
    betSlipEligible: false,
  });
  const decision = {
    ...payload,
    contentHash: hashImmutableAnalysisReferenceDecision(payload),
  };
  return attestImmutableAnalysisReferenceDecision(decision, match);
};

module.exports = {
  IMMUTABLE_ANALYSIS_REFERENCE_VERSION,
  IMMUTABLE_ANALYSIS_REFERENCE_INTEGRITY_VERSION,
  hashImmutableAnalysisReferenceDecision,
  verifyImmutableAnalysisReferenceDecision,
  attestImmutableAnalysisReferenceDecision,
  buildImmutableAnalysisReferenceDecision,
};
