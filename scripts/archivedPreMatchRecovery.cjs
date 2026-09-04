const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseHandicapLine,
} = require("../src/services/officialRecommendationEligibility.cjs");

const RECOVERY_VERSION = "archived-pre-match-recovery-v1";
const RECOVERY_SOURCE = "signed-release-pre-cutoff-snapshot-recovery";
const ARCHIVE_PARITY_REPAIR_REASON = "archived-direction-diverged-from-user-visible-published-direction";
const DEFAULT_RECOVERY_PATH = path.join(
  __dirname,
  "data",
  "archived-prematch-recovery.json"
);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const recoveryIntegrityPayload = (row) => {
  const { integritySha256, ...payload } = row || {};
  void integritySha256;
  return payload;
};

const recoveryIntegritySha256 = (row) => crypto
  .createHash("sha256")
  .update(canonicalJson(recoveryIntegrityPayload(row)))
  .digest("hex");

const parseShanghaiTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(" ", "T")}${text.length === 16 ? ":00" : ""}+08:00`
    : text;
  return Date.parse(normalized);
};

const canonicalSourceMatchId = (value) => String(value || "")
  .trim()
  .replace(/^sporttery_/, "");

const finiteOdds = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 1 ? numeric : null;
};

const oddsForTip = (odds, code) => {
  if (code === "1") return finiteOdds(odds?.odds1);
  if (code === "X") return finiteOdds(odds?.oddsX);
  if (code === "2") return finiteOdds(odds?.odds2);
  return null;
};

const validateRecoveryRow = (row) => {
  const errors = [];
  const sourceMatchId = canonicalSourceMatchId(row?.sourceMatchId);
  const prediction = row?.prediction || {};
  const evidence = row?.evidence || {};
  const capturedMs = parseShanghaiTime(row?.capturedAt);
  const cutoffMs = parseShanghaiTime(row?.cutoffTime);
  const kickoffMs = parseShanghaiTime(row?.kickoffTime);
  const eventMs = parseShanghaiTime(row?.eventVersion);
  const marketPool = String(prediction.oddsPoolCode || "").toUpperCase();
  const tipCode = String(prediction.tipCode || "").toUpperCase();
  const marketEvidenceScope = String(row?.marketEvidenceScope || "result-pool");
  const modelOnlyReference = marketEvidenceScope === "model-only-reference";
  const bindingEvidence = evidence?.evidenceKind === "dual-market-decision-binding";
  const marketOdds = marketPool === "HHAD" ? evidence?.market?.hhad : evidence?.market?.had;
  const selectedOdds = oddsForTip(marketOdds, tipCode);
  const predictionOdds = finiteOdds(prediction.odds);
  const validModelOnlyHhadLine = marketPool !== "HHAD"
    || parseHandicapLine(prediction.handicapLine) !== null;

  if (row?.version !== RECOVERY_VERSION) errors.push("version-invalid");
  if (row?.source !== RECOVERY_SOURCE) errors.push("source-invalid");
  if (!sourceMatchId || sourceMatchId !== String(row?.sourceMatchId || "")) {
    errors.push("source-match-id-invalid");
  }
  if (!Number.isFinite(capturedMs)) errors.push("captured-at-invalid");
  if (!Number.isFinite(cutoffMs)) errors.push("cutoff-time-invalid");
  if (!Number.isFinite(kickoffMs)) errors.push("kickoff-time-invalid");
  if (!Number.isFinite(eventMs) || eventMs !== kickoffMs) errors.push("event-version-invalid");
  if (
    Number.isFinite(capturedMs)
    && Number.isFinite(cutoffMs)
    && capturedMs > cutoffMs
  ) errors.push("captured-after-cutoff");
  if (
    Number.isFinite(capturedMs)
    && Number.isFinite(kickoffMs)
    && capturedMs >= kickoffMs
  ) errors.push("captured-after-kickoff");
  if (prediction.marketType !== "BEST") errors.push("prediction-market-invalid");
  if (!["HAD", "HHAD"].includes(marketPool)) errors.push("odds-pool-invalid");
  if (!["1", "X", "2"].includes(tipCode)) errors.push("tip-code-invalid");
  if (!["result-pool", "model-only-reference"].includes(marketEvidenceScope)) {
    errors.push("market-evidence-scope-invalid");
  }
  if (modelOnlyReference) {
    if (
      Number(prediction.odds) !== 0
      || prediction.recommendationAction !== "reference"
      || !validModelOnlyHhadLine
    ) errors.push("model-only-reference-invalid");
  } else if (!predictionOdds) {
    errors.push("prediction-odds-invalid");
  }
  if (!modelOnlyReference && (!selectedOdds || Math.abs(selectedOdds - predictionOdds) > 0.000001)) {
    errors.push("prediction-odds-evidence-mismatch");
  }
  if (
    marketPool === "HHAD"
    && String(prediction.handicapLine || "") !== String(evidence?.market?.handicapLine || "")
  ) errors.push("handicap-line-evidence-mismatch");
  const expectedBindingSignature = [
    "published-direction-attestation-v1",
    "dual-market-decision-binding",
    `${marketPool}:${tipCode}:${marketPool === "HHAD" ? evidence?.market?.handicapLine : 0}`,
    evidence?.bindingHash,
  ].join(":");
  if (
    !String(row?.signature || "").includes(`BEST:${marketPool}:${tipCode}:`)
    && (!bindingEvidence || row.signature !== expectedBindingSignature)
  ) {
    errors.push("signature-selection-mismatch");
  }
  if (
    evidence?.selectedCandidateKey
    !== `${marketPool}:${tipCode}:${marketPool === "HHAD" ? evidence?.market?.handicapLine : 0}`
  ) errors.push("selected-candidate-mismatch");
  const sourceCycleId = String(evidence?.sourceCycleId || "");
  if (
    (!bindingEvidence && !sourceCycleId.startsWith("sporttery-full-sync:"))
    || (bindingEvidence && !sourceCycleId.startsWith("sporttery-relay:"))
  ) {
    errors.push("source-cycle-invalid");
  }
  if (
    bindingEvidence
    && !/^[a-f0-9]{64}$/.test(String(evidence?.bindingHash || ""))
  ) errors.push("binding-hash-invalid");
  if (!String(evidence?.decisionId || "").startsWith("decision_")) {
    errors.push("decision-id-invalid");
  }
  if (!Number.isInteger(Number(evidence?.decisionRevision)) || Number(evidence.decisionRevision) < 1) {
    errors.push("decision-revision-invalid");
  }
  if (!String(evidence?.featureSnapshotHash || "")) errors.push("feature-snapshot-hash-missing");
  if (evidence?.decisionSnapshotFeatureHash !== evidence?.featureSnapshotHash) {
    errors.push("decision-feature-hash-mismatch");
  }
  if (row?.repair) {
    const previousMarket = String(row.repair?.previous?.market || "").toUpperCase();
    const previousDirection = String(row.repair?.previous?.direction || "").toUpperCase();
    const canonicalMarket = String(row.repair?.canonical?.market || "").toUpperCase();
    const canonicalDirection = String(row.repair?.canonical?.direction || "").toUpperCase();
    if (row.repair.reason !== ARCHIVE_PARITY_REPAIR_REASON) {
      errors.push("repair-reason-invalid");
    }
    if (
      !["HAD", "HHAD"].includes(previousMarket)
      || !["1", "X", "2"].includes(previousDirection)
      || canonicalMarket !== marketPool
      || canonicalDirection !== tipCode
      || (previousMarket === canonicalMarket && previousDirection === canonicalDirection)
    ) errors.push("repair-direction-invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(String(row?.integritySha256 || ""))) {
    errors.push("integrity-sha256-invalid");
  } else if (recoveryIntegritySha256(row) !== row.integritySha256) {
    errors.push("integrity-sha256-mismatch");
  }

  return {
    ok: errors.length === 0,
    errors,
    sourceMatchId,
  };
};

const loadArchivedPreMatchRecoveries = (filePath = DEFAULT_RECOVERY_PATH) => {
  if (!fs.existsSync(filePath)) return new Map();
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload?.version !== RECOVERY_VERSION || !Array.isArray(payload?.rows)) {
    throw new Error(`Archived pre-match recovery manifest is invalid: ${filePath}`);
  }
  const index = new Map();
  for (const row of payload.rows) {
    const validation = validateRecoveryRow(row);
    if (!validation.ok) {
      throw new Error(
        `Archived pre-match recovery ${validation.sourceMatchId || "unknown"} rejected: ${validation.errors.join(", ")}`
      );
    }
    if (index.has(validation.sourceMatchId)) {
      throw new Error(`Duplicate archived pre-match recovery: ${validation.sourceMatchId}`);
    }
    index.set(validation.sourceMatchId, row);
  }
  return index;
};

const recoveryArchiveForMatch = (match, recoveryIndex) => {
  const sourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const row = sourceMatchId ? recoveryIndex?.get(sourceMatchId) : null;
  if (!row) return null;
  const matchKickoffMs = parseShanghaiTime(match?.kickoffTime);
  const matchEventMs = parseShanghaiTime(match?.eventVersion || match?.kickoffTime);
  const explicitMatchCutoffs = [
    parseShanghaiTime(match?.predictionMeta?.cutoffTime),
    parseShanghaiTime(match?.buyEndTime),
  ].filter(Number.isFinite);
  const matchCutoffMs = explicitMatchCutoffs.length > 0
    ? Math.min(...explicitMatchCutoffs)
    : null;
  const rowKickoffMs = parseShanghaiTime(row.kickoffTime);
  const rowEventMs = parseShanghaiTime(row.eventVersion);
  const rowCutoffMs = parseShanghaiTime(row.cutoffTime);
  const rowCapturedMs = parseShanghaiTime(row.capturedAt);
  if (
    !Number.isFinite(matchKickoffMs)
    || !Number.isFinite(matchEventMs)
    || matchKickoffMs !== rowKickoffMs
    || matchEventMs !== rowEventMs
    || !Number.isFinite(rowCutoffMs)
    || (Number.isFinite(matchCutoffMs) && rowCutoffMs !== matchCutoffMs)
    || rowCapturedMs > Math.min(rowCutoffMs, matchKickoffMs)
  ) return null;

  return {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId,
    matchId: match?.id || row.matchId || null,
    kickoffTime: row.kickoffTime,
    eventVersion: row.eventVersion,
    capturedAt: row.capturedAt,
    phase: row.phase || null,
    signature: row.signature || null,
    cutoffTime: row.cutoffTime,
    marketEvidenceScope: row.marketEvidenceScope || "result-pool",
    recoveryEvidence: {
      version: RECOVERY_VERSION,
      source: RECOVERY_SOURCE,
      integritySha256: row.integritySha256,
      sourceCycleId: row.evidence.sourceCycleId,
      decisionId: row.evidence.decisionId,
      decisionRevision: row.evidence.decisionRevision,
      featureSnapshotHash: row.evidence.featureSnapshotHash,
      ...(row.repair ? {
        reason: row.repair.reason,
        previous: row.repair.previous,
        canonical: row.repair.canonical,
      } : {}),
    },
    prediction: {
      ...row.prediction,
      resultStatus: "PENDING",
      explanation: row.prediction.explanation || { zh: "", en: "" },
      visibilityStatus: row.prediction.visibilityStatus || "FREE",
    },
  };
};

module.exports = {
  DEFAULT_RECOVERY_PATH,
  ARCHIVE_PARITY_REPAIR_REASON,
  RECOVERY_SOURCE,
  RECOVERY_VERSION,
  loadArchivedPreMatchRecoveries,
  recoveryArchiveForMatch,
  recoveryIntegritySha256,
  validateRecoveryRow,
};
