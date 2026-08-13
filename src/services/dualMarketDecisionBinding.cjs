const crypto = require("node:crypto");
const {
  devigProbabilities,
  normalizeProbabilityTriplet,
  parseHandicapLine,
} = require("./hhadCompanionShadow.cjs");

const DUAL_MARKET_DECISION_BINDING_VERSION = "dual-market-decision-binding-v1";
const DUAL_MARKET_DECISION_INTEGRITY_VERSION = "dual-market-decision-integrity-v1";
const DUAL_MARKET_PUBLIC_BINDING_VERSION = "dual-market-public-binding-v1";
const OUTCOME_CODES = Object.freeze(["1", "X", "2"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const finiteProbability = (value) => {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 && numeric <= 1 ? numeric : null;
};

const finiteOdds = (value) => {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 1 ? numeric : null;
};

const normalizedSourceMatchId = (value) => String(value || "")
  .trim()
  .replace(/^sporttery_/, "");

const timestamp = (value) => {
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? millis : null;
};

const sameInstant = (left, right, toleranceMs = 2_000) => {
  const leftMs = timestamp(left);
  const rightMs = timestamp(right);
  return leftMs !== null && rightMs !== null && Math.abs(leftMs - rightMs) <= toleranceMs;
};

const sameNumber = (left, right, tolerance = 0.0000015) => {
  const leftNumber = finiteNumber(left);
  const rightNumber = finiteNumber(right);
  return leftNumber !== null
    && rightNumber !== null
    && Math.abs(leftNumber - rightNumber) <= tolerance;
};

const outcomeOdds = (odds, code) => {
  if (!OUTCOME_CODES.includes(code)) return null;
  const key = code === "1" ? "odds1" : code === "X" ? "oddsX" : "odds2";
  return finiteOdds(odds?.[key] ?? odds?.[code]);
};

const outcomeProbability = (probabilities, code) => {
  if (!OUTCOME_CODES.includes(code)) return null;
  return finiteProbability(probabilities?.[code]);
};

const topProbabilityCode = (probabilities) => {
  const normalized = normalizeProbabilityTriplet(probabilities);
  if (!normalized) return null;
  return OUTCOME_CODES
    .map((code, index) => ({ code, probability: normalized[code], index }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index)[0]?.code || null;
};

const predictionFeatureSnapshotHash = (featureSnapshot) => {
  if (!featureSnapshot || typeof featureSnapshot !== "object") return null;
  const { hash: ignoredHash, ...payload } = featureSnapshot;
  void ignoredHash;
  let hash = 2166136261;
  const text = JSON.stringify(payload);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const dualMarketDecisionBindingPayload = (binding) => ({
  version: binding?.version,
  decisionSnapshotVersion: binding?.decisionSnapshotVersion,
  sourceCycleId: binding?.sourceCycleId,
  featureSnapshotHash: binding?.featureSnapshotHash,
  featureSnapshot: binding?.featureSnapshot,
  sourceClocks: binding?.sourceClocks,
  strategyVersions: binding?.strategyVersions,
  had: binding?.had,
  hadAnalysis: binding?.hadAnalysis,
  hhad: binding?.hhad,
  hashes: binding?.hashes,
});

const hashDualMarketDecisionBinding = (binding) => crypto
  .createHash("sha256")
  .update(JSON.stringify(dualMarketDecisionBindingPayload(binding)))
  .digest("hex");

const compactDualMarketDecisionBindingPayload = (binding) => ({
  publicBindingVersion: DUAL_MARKET_PUBLIC_BINDING_VERSION,
  version: binding?.version,
  decisionSnapshotVersion: binding?.decisionSnapshotVersion,
  sourceCycleId: binding?.sourceCycleId,
  featureSnapshotHash: binding?.featureSnapshotHash,
  sourceClocks: binding?.sourceClocks,
  strategyVersions: binding?.strategyVersions,
  had: binding?.had,
  hadAnalysis: binding?.hadAnalysis,
  hhad: binding?.hhad,
  hashes: binding?.hashes,
  bindingHash: binding?.bindingHash,
  integrityVerified: binding?.integrityVerified,
  integrityVersion: binding?.integrityVersion,
});

const hashCompactDualMarketDecisionBinding = (binding) => crypto
  .createHash("sha256")
  .update(JSON.stringify(compactDualMarketDecisionBindingPayload(binding)))
  .digest("hex");

const compactDualMarketDecisionBindingForPublic = (binding) => {
  if (!binding || typeof binding !== "object") return null;
  const { featureSnapshot: internalFeatureSnapshot, ...publicBinding } = binding;
  void internalFeatureSnapshot;
  const compact = {
    ...publicBinding,
    publicBindingVersion: DUAL_MARKET_PUBLIC_BINDING_VERSION,
  };
  return {
    ...compact,
    publicBindingHash: hashCompactDualMarketDecisionBinding(compact),
  };
};

const verifyCompactDualMarketDecisionBinding = (binding) => {
  const blockers = [];
  if (!binding || typeof binding !== "object") {
    return {
      valid: false,
      blockers: ["dual-market-public-binding-missing"],
      computedPublicBindingHash: null,
    };
  }
  const computedPublicBindingHash = hashCompactDualMarketDecisionBinding(binding);
  if (binding.publicBindingVersion !== DUAL_MARKET_PUBLIC_BINDING_VERSION) {
    blockers.push("public-binding-version-invalid");
  }
  if (Object.prototype.hasOwnProperty.call(binding, "featureSnapshot")) {
    blockers.push("public-binding-leaks-feature-snapshot");
  }
  if (binding.integrityVerified !== true) blockers.push("public-binding-not-server-attested");
  if (binding.integrityVersion !== DUAL_MARKET_DECISION_INTEGRITY_VERSION) {
    blockers.push("public-binding-integrity-version-invalid");
  }
  if (!SHA256_PATTERN.test(String(binding.bindingHash || ""))) {
    blockers.push("full-binding-hash-missing-or-invalid");
  }
  if (!SHA256_PATTERN.test(String(binding.publicBindingHash || ""))) {
    blockers.push("public-binding-hash-missing-or-invalid");
  } else if (binding.publicBindingHash !== computedPublicBindingHash) {
    blockers.push("public-binding-hash-mismatch");
  }
  if (!String(binding.featureSnapshotHash || "").trim()) {
    blockers.push("public-feature-snapshot-hash-missing");
  }
  if (!String(binding.sourceCycleId || "").trim()) blockers.push("public-source-cycle-id-missing");
  if (binding.had?.poolCode !== "HAD") blockers.push("public-had-binding-missing-or-invalid");
  if (!OUTCOME_CODES.includes(String(binding.had?.code || ""))) blockers.push("public-had-code-invalid");
  if (finiteOdds(binding.had?.odds) === null) blockers.push("public-had-odds-missing-or-invalid");
  if (finiteProbability(binding.had?.modelProbability) === null) {
    blockers.push("public-had-model-probability-missing-or-invalid");
  }
  if (finiteProbability(binding.had?.marketProbability) === null) {
    blockers.push("public-had-market-probability-missing-or-invalid");
  }
  if (binding.hhad?.poolCode !== "HHAD") blockers.push("public-hhad-binding-missing-or-invalid");
  if (!OUTCOME_CODES.includes(String(binding.hhad?.code || ""))) blockers.push("public-hhad-code-invalid");
  if (parseHandicapLine(binding.hhad?.handicapLine) === null) {
    blockers.push("public-hhad-line-missing-or-invalid");
  }
  if (finiteOdds(binding.hhad?.odds) === null) blockers.push("public-hhad-odds-missing-or-invalid");
  if (finiteProbability(binding.hhad?.modelProbability) === null) {
    blockers.push("public-hhad-model-probability-missing-or-invalid");
  }
  if (finiteProbability(binding.hhad?.marketProbability) === null) {
    blockers.push("public-hhad-market-probability-missing-or-invalid");
  }
  for (const key of [
    "capturedAt",
    "decisionAt",
    "cutoffTime",
    "modelGeneratedAt",
    "hadObservedAt",
    "hadReceivedAt",
    "hhadObservedAt",
    "hhadReceivedAt",
  ]) {
    if (timestamp(binding.sourceClocks?.[key]) === null) {
      blockers.push(`public-${key}-missing-or-invalid`);
    }
  }
  for (const key of ["predictionPolicy", "prompt", "model", "calibration", "hhadCompanion"]) {
    if (!String(binding.strategyVersions?.[key] || "").trim()) {
      blockers.push(`public-${key}-version-missing`);
    }
  }
  for (const key of [
    "policyHash",
    "hadMarketProvenanceHash",
    "hhadMarketProvenanceHash",
    "strategyHash",
    "revisionHash",
    "exposureHash",
    "pairHash",
  ]) {
    if (!SHA256_PATTERN.test(String(binding.hashes?.[key] || ""))) {
      blockers.push(`public-${key}-missing-or-invalid`);
    }
  }
  return {
    valid: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
    computedPublicBindingHash,
  };
};

const pushTemporalBlocker = (blockers, left, right, code) => {
  const leftMs = timestamp(left);
  const rightMs = timestamp(right);
  if (leftMs !== null && rightMs !== null && leftMs > rightMs) blockers.push(code);
};

const verifyDualMarketDecisionBinding = (match) => {
  const binding = match?.predictionMeta?.dualMarketDecision;
  const boundFeatureSnapshot = binding?.featureSnapshot
    && typeof binding.featureSnapshot === "object"
    ? binding.featureSnapshot
    : null;
  const featureSnapshot = boundFeatureSnapshot || match?.predictionMeta?.featureSnapshot;
  const blockers = [];
  if (!binding || typeof binding !== "object") {
    return {
      valid: false,
      blockers: ["dual-market-binding-missing"],
      computedBindingHash: null,
      computedFeatureSnapshotHash: predictionFeatureSnapshotHash(featureSnapshot),
    };
  }

  const computedBindingHash = hashDualMarketDecisionBinding(binding);
  const computedFeatureSnapshotHash = predictionFeatureSnapshotHash(featureSnapshot);
  const had = binding.had;
  const hadAnalysis = binding.hadAnalysis;
  const hhad = binding.hhad;
  const clocks = binding.sourceClocks || {};
  const versions = binding.strategyVersions || {};
  const hashes = binding.hashes || {};
  const featureHad = featureSnapshot?.market?.had;
  const featureHhad = featureSnapshot?.market?.hhad;

  if (binding.version !== DUAL_MARKET_DECISION_BINDING_VERSION) blockers.push("binding-version-invalid");
  if (binding.decisionSnapshotVersion !== "candidate-decision-snapshot-v2") {
    blockers.push("decision-snapshot-version-invalid");
  }
  if (!SHA256_PATTERN.test(String(binding.bindingHash || ""))) blockers.push("binding-hash-missing-or-invalid");
  else if (binding.bindingHash !== computedBindingHash) blockers.push("binding-hash-mismatch");

  if (!featureSnapshot || typeof featureSnapshot !== "object") blockers.push("feature-snapshot-missing");
  if (!computedFeatureSnapshotHash) blockers.push("feature-snapshot-hash-unavailable");
  if (!String(featureSnapshot?.hash || "").trim()) blockers.push("embedded-feature-snapshot-hash-missing");
  else if (featureSnapshot.hash !== computedFeatureSnapshotHash) blockers.push("embedded-feature-snapshot-hash-mismatch");
  if (!boundFeatureSnapshot) {
    if (!String(match?.predictionMeta?.featureSnapshotHash || "").trim()) {
      blockers.push("prediction-meta-feature-snapshot-hash-missing");
    } else if (match.predictionMeta.featureSnapshotHash !== computedFeatureSnapshotHash) {
      blockers.push("prediction-meta-feature-snapshot-hash-mismatch");
    }
  }
  if (!String(binding.featureSnapshotHash || "").trim()) blockers.push("binding-feature-snapshot-hash-missing");
  else if (binding.featureSnapshotHash !== computedFeatureSnapshotHash) {
    blockers.push("binding-feature-snapshot-hash-mismatch");
  }

  if (!String(binding.sourceCycleId || "").trim()) blockers.push("binding-source-cycle-id-missing");
  if (!String(featureSnapshot?.sourceCycleId || "").trim()) blockers.push("feature-source-cycle-id-missing");
  if (
    String(binding.sourceCycleId || "").trim()
    && String(featureSnapshot?.sourceCycleId || "").trim()
    && binding.sourceCycleId !== featureSnapshot.sourceCycleId
  ) blockers.push("binding-feature-source-cycle-mismatch");
  if (
    normalizedSourceMatchId(featureSnapshot?.sourceMatchId)
    !== normalizedSourceMatchId(match?.sourceMatchId || match?.id)
  ) blockers.push("feature-match-identity-mismatch");
  if (!sameInstant(featureSnapshot?.kickoffTime, match?.kickoffTime)) blockers.push("feature-kickoff-mismatch");

  if (had?.poolCode !== "HAD") blockers.push("had-binding-missing-or-invalid");
  if (!OUTCOME_CODES.includes(String(had?.code || ""))) blockers.push("had-code-invalid");
  if (finiteOdds(had?.odds) === null) blockers.push("had-selected-odds-missing-or-invalid");
  if (finiteProbability(had?.modelProbability) === null) blockers.push("had-model-probability-missing-or-invalid");
  if (finiteProbability(had?.marketProbability) === null) blockers.push("had-market-probability-missing-or-invalid");

  if (hadAnalysis !== undefined && hadAnalysis !== null) {
    if (hadAnalysis?.poolCode !== "HAD") blockers.push("had-analysis-binding-invalid");
    if (!OUTCOME_CODES.includes(String(hadAnalysis?.code || ""))) blockers.push("had-analysis-code-invalid");
    if (finiteOdds(hadAnalysis?.odds) === null) blockers.push("had-analysis-odds-missing-or-invalid");
    if (finiteProbability(hadAnalysis?.modelProbability) === null) {
      blockers.push("had-analysis-model-probability-missing-or-invalid");
    }
    if (finiteProbability(hadAnalysis?.marketProbability) === null) {
      blockers.push("had-analysis-market-probability-missing-or-invalid");
    }
  }

  if (hhad?.poolCode !== "HHAD") blockers.push("hhad-binding-missing-or-invalid");
  if (!OUTCOME_CODES.includes(String(hhad?.code || ""))) blockers.push("hhad-code-invalid");
  if (parseHandicapLine(hhad?.handicapLine) === null) blockers.push("hhad-line-missing-or-invalid");
  if (finiteOdds(hhad?.odds) === null) blockers.push("hhad-selected-odds-missing-or-invalid");
  if (finiteProbability(hhad?.modelProbability) === null) blockers.push("hhad-model-probability-missing-or-invalid");
  if (finiteProbability(hhad?.marketProbability) === null) blockers.push("hhad-market-probability-missing-or-invalid");

  if (!featureHad?.odds) blockers.push("feature-had-market-missing");
  if (!featureHhad?.odds) blockers.push("feature-hhad-market-missing");
  const featureHhadLine = parseHandicapLine(featureHhad?.handicapLine);
  if (featureHhadLine === null) blockers.push("feature-hhad-line-missing-or-invalid");
  if (
    parseHandicapLine(hhad?.handicapLine) !== null
    && featureHhadLine !== null
    && parseHandicapLine(hhad.handicapLine) !== featureHhadLine
  ) blockers.push("binding-feature-hhad-line-mismatch");

  const hadCode = String(had?.code || "");
  const hadAnalysisCode = String(hadAnalysis?.code || "");
  const hhadCode = String(hhad?.code || "");
  if (
    OUTCOME_CODES.includes(hadCode)
    && !sameNumber(had?.odds, outcomeOdds(featureHad?.odds, hadCode))
  ) blockers.push("binding-feature-had-odds-mismatch");
  if (
    OUTCOME_CODES.includes(hhadCode)
    && !sameNumber(hhad?.odds, outcomeOdds(featureHhad?.odds, hhadCode))
  ) blockers.push("binding-feature-hhad-odds-mismatch");
  if (
    hadAnalysis
    && OUTCOME_CODES.includes(hadAnalysisCode)
    && !sameNumber(hadAnalysis?.odds, outcomeOdds(featureHad?.odds, hadAnalysisCode))
  ) blockers.push("binding-feature-had-analysis-odds-mismatch");

  const featureHadMarketProbabilities = devigProbabilities(featureHad?.odds);
  const featureHhadMarketProbabilities = devigProbabilities(featureHhad?.odds);
  const featureHadModelProbabilities = normalizeProbabilityTriplet(
    featureSnapshot?.modelOutputs?.had,
  );
  if (
    OUTCOME_CODES.includes(hadCode)
    && !sameNumber(
      had?.marketProbability,
      outcomeProbability(featureHadMarketProbabilities, hadCode),
    )
  ) blockers.push("binding-feature-had-market-probability-mismatch");
  if (
    OUTCOME_CODES.includes(hhadCode)
    && !sameNumber(
      hhad?.marketProbability,
      outcomeProbability(featureHhadMarketProbabilities, hhadCode),
    )
  ) blockers.push("binding-feature-hhad-market-probability-mismatch");
  if (
    hadAnalysis
    && OUTCOME_CODES.includes(hadAnalysisCode)
    && !sameNumber(
      hadAnalysis?.marketProbability,
      outcomeProbability(featureHadMarketProbabilities, hadAnalysisCode),
    )
  ) blockers.push("binding-feature-had-analysis-market-probability-mismatch");
  if (
    hadAnalysis
    && OUTCOME_CODES.includes(hadAnalysisCode)
    && !sameNumber(
      hadAnalysis?.modelProbability,
      outcomeProbability(featureHadModelProbabilities, hadAnalysisCode),
    )
  ) blockers.push("binding-feature-had-analysis-model-probability-mismatch");

  const featureUnifiedSelection = featureSnapshot?.modelOutputs?.unifiedSelection;
  if (
    String(featureUnifiedSelection?.market || "").toUpperCase() === "HAD"
    && OUTCOME_CODES.includes(String(featureUnifiedSelection?.code || "").toUpperCase())
    && String(featureUnifiedSelection.code).toUpperCase() !== hadCode
  ) blockers.push("binding-feature-had-direction-mismatch");
  const featureHhadTopCode = topProbabilityCode(
    featureSnapshot?.modelOutputs?.hhad?.unifiedPosterior,
  );
  if (featureHhadTopCode && featureHhadTopCode !== hhadCode) {
    blockers.push("binding-feature-hhad-direction-mismatch");
  }
  const featureOneXTwoSelection = featureSnapshot?.modelOutputs?.publicSelections?.oneXTwo;
  if (hadAnalysis) {
    if (
      String(featureOneXTwoSelection?.poolCode || "").toUpperCase() !== "HAD"
      || String(featureOneXTwoSelection?.code || "").toUpperCase() !== hadAnalysisCode
    ) blockers.push("binding-feature-had-analysis-direction-mismatch");
  }

  for (const key of [
    "capturedAt",
    "decisionAt",
    "cutoffTime",
    "modelGeneratedAt",
    "hadObservedAt",
    "hadReceivedAt",
    "hhadObservedAt",
    "hhadReceivedAt",
  ]) {
    if (timestamp(clocks[key]) === null) blockers.push(`${key}-missing-or-invalid`);
  }
  pushTemporalBlocker(blockers, clocks.capturedAt, clocks.cutoffTime, "binding-captured-after-cutoff");
  pushTemporalBlocker(blockers, clocks.modelGeneratedAt, clocks.decisionAt, "model-generated-after-decision");
  pushTemporalBlocker(blockers, clocks.decisionAt, clocks.cutoffTime, "decision-after-cutoff");
  pushTemporalBlocker(blockers, clocks.hadObservedAt, clocks.hadReceivedAt, "had-observed-after-received");
  pushTemporalBlocker(blockers, clocks.hadReceivedAt, clocks.decisionAt, "had-received-after-decision");
  pushTemporalBlocker(blockers, clocks.hhadObservedAt, clocks.hhadReceivedAt, "hhad-observed-after-received");
  pushTemporalBlocker(blockers, clocks.hhadReceivedAt, clocks.decisionAt, "hhad-received-after-decision");
  if (!sameInstant(featureSnapshot?.capturedAt, clocks.decisionAt)) {
    blockers.push("feature-capture-decision-clock-mismatch");
  }
  if (!sameInstant(clocks.cutoffTime, featureSnapshot?.cutoffTime)) blockers.push("binding-feature-cutoff-mismatch");
  if (!sameInstant(clocks.modelGeneratedAt, featureSnapshot?.modelGeneratedAt)) {
    blockers.push("binding-feature-model-clock-mismatch");
  }
  if (!sameInstant(clocks.hadObservedAt, featureHad?.observedAt)) blockers.push("binding-feature-had-observed-clock-mismatch");
  if (!sameInstant(clocks.hadReceivedAt, featureHad?.receivedAt)) blockers.push("binding-feature-had-received-clock-mismatch");
  if (!sameInstant(clocks.hhadObservedAt, featureHhad?.observedAt)) blockers.push("binding-feature-hhad-observed-clock-mismatch");
  if (!sameInstant(clocks.hhadReceivedAt, featureHhad?.receivedAt)) blockers.push("binding-feature-hhad-received-clock-mismatch");

  for (const [key, expected] of [
    ["predictionPolicy", null],
    ["prompt", null],
    ["model", featureSnapshot?.modelVersion],
    ["calibration", featureSnapshot?.calibrationVersion],
  ]) {
    if (!String(versions[key] || "").trim()) blockers.push(`${key}-version-missing`);
    else if (String(expected || "").trim() && versions[key] !== expected) {
      blockers.push(`${key}-version-mismatch`);
    }
  }
  if (versions.hhadCompanion !== "hhad-companion-shadow-v2") blockers.push("hhad-companion-version-invalid");

  for (const key of [
    "policyHash",
    "hadMarketProvenanceHash",
    "hhadMarketProvenanceHash",
    "strategyHash",
    "revisionHash",
    "exposureHash",
    "pairHash",
  ]) {
    if (!SHA256_PATTERN.test(String(hashes[key] || ""))) blockers.push(`${key}-missing-or-invalid`);
  }
  if (
    SHA256_PATTERN.test(String(featureHad?.provenanceHash || ""))
    && hashes.hadMarketProvenanceHash !== featureHad.provenanceHash
  ) blockers.push("had-market-provenance-hash-mismatch");
  if (
    SHA256_PATTERN.test(String(featureHhad?.provenanceHash || ""))
    && hashes.hhadMarketProvenanceHash !== featureHhad.provenanceHash
  ) blockers.push("hhad-market-provenance-hash-mismatch");
  if (!SHA256_PATTERN.test(String(featureHad?.provenanceHash || ""))) {
    blockers.push("feature-had-market-provenance-hash-missing-or-invalid");
  }
  if (!SHA256_PATTERN.test(String(featureHhad?.provenanceHash || ""))) {
    blockers.push("feature-hhad-market-provenance-hash-missing-or-invalid");
  }

  return {
    valid: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
    computedBindingHash,
    computedFeatureSnapshotHash,
  };
};

const attestDualMarketDecisionBinding = (match) => {
  const verification = verifyDualMarketDecisionBinding(match);
  if (!verification.valid) return null;
  return {
    ...match.predictionMeta.dualMarketDecision,
    integrityVerified: true,
    integrityVersion: DUAL_MARKET_DECISION_INTEGRITY_VERSION,
  };
};

const boundDecisionOddsForPrediction = (match, prediction) => {
  if (!prediction || !OUTCOME_CODES.includes(String(prediction.tipCode || ""))) return null;
  const verification = verifyDualMarketDecisionBinding(match);
  if (!verification.valid) return null;

  const poolCode = String(prediction.oddsPoolCode || "HAD").toUpperCase();
  const marketType = String(prediction.marketType || "").toUpperCase();
  const binding = match.predictionMeta.dualMarketDecision;
  const leg = poolCode === "HHAD"
    ? binding.hhad
    : poolCode === "HAD"
      ? (
          marketType === "1X2" && binding.hadAnalysis
            ? binding.hadAnalysis
            : binding.had
        )
      : null;
  if (
    poolCode === "HAD"
    && marketType === "1X2"
    && !binding.hadAnalysis
    && String(binding.had?.code || "") !== String(prediction.tipCode || "")
  ) {
    const featureSnapshot = binding.featureSnapshot || match?.predictionMeta?.featureSnapshot;
    const frozenSelection = featureSnapshot?.modelOutputs?.publicSelections?.oneXTwo;
    const latestSignature = String(match?.predictionMeta?.snapshot?.latestSignature || "");
    const signaturePrefix = `1X2:${poolCode}:${prediction.tipCode}:`;
    const selectionMatches = frozenSelection
      ? (
          String(frozenSelection.poolCode || "").toUpperCase() === poolCode
          && String(frozenSelection.code || "").toUpperCase() === String(prediction.tipCode || "")
        )
      : latestSignature.split("|").some((part) => part.startsWith(signaturePrefix));
    const legacyOdds = outcomeOdds(featureSnapshot?.market?.had?.odds, String(prediction.tipCode || ""));
    if (
      selectionMatches
      && legacyOdds !== null
      && sameNumber(prediction.odds, legacyOdds)
    ) return legacyOdds;
  }
  if (!leg || leg.poolCode !== poolCode || String(leg.code || "") !== String(prediction.tipCode || "")) {
    return null;
  }
  if (
    poolCode === "HHAD"
    && parseHandicapLine(prediction.handicapLine ?? match?.handicapLine) !== parseHandicapLine(leg.handicapLine)
  ) {
    return null;
  }
  return finiteOdds(leg.odds);
};

module.exports = {
  DUAL_MARKET_DECISION_BINDING_VERSION,
  DUAL_MARKET_DECISION_INTEGRITY_VERSION,
  DUAL_MARKET_PUBLIC_BINDING_VERSION,
  attestDualMarketDecisionBinding,
  boundDecisionOddsForPrediction,
  compactDualMarketDecisionBindingForPublic,
  compactDualMarketDecisionBindingPayload,
  dualMarketDecisionBindingPayload,
  hashCompactDualMarketDecisionBinding,
  hashDualMarketDecisionBinding,
  predictionFeatureSnapshotHash,
  verifyCompactDualMarketDecisionBinding,
  verifyDualMarketDecisionBinding,
};
