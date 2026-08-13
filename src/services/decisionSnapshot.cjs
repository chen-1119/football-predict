const crypto = require("node:crypto");
const {
  evaluateHhadCompanionShadow,
} = require("./hhadCompanionShadow.cjs");
const {
  MULTI_FACTOR_POLICY_VERSION,
  evaluateMultiFactorRecommendation,
} = require("./multiFactorRecommendation.cjs");
const {
  isStrictMarketSourceProvenance,
  marketSourceLineageId,
  normalizeMarketSourceProvenance,
} = require("./marketSourceProvenance.cjs");

const LEGACY_DECISION_SNAPSHOT_VERSION = "candidate-decision-snapshot-v1";
const DECISION_SNAPSHOT_VERSION = "candidate-decision-snapshot-v2";
const EVIDENCE_REPLAY_VERSION = "canonical-multi-factor-replay-v1";
const EVIDENCE_CANONICALIZATION_VERSION = "fixed-point-evidence-input-v1";
const FIXED_POINT_SCALES = Object.freeze({
  odds: 1_000,
  probability: 1_000_000,
  handicapLine: 100,
  trustPenalty: 10_000,
  riskPenalty: 1_000_000,
});
const GOVERNANCE_ONLY_BLOCKERS = new Set([
  "model-risk-not-promotable",
  "upstream-multi-factor-gate-not-passed",
]);

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const rounded = (value, digits = 6) => {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(digits));
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
};

const canonicalStringify = (value) => JSON.stringify(canonicalize(value));

const canonicalHash = (value) => crypto
  .createHash("sha256")
  .update(canonicalStringify(value))
  .digest("hex");

const firstPresent = (...values) => values.find((value) => (
  value !== null && value !== undefined && String(value).trim() !== ""
));

const canonicalInstant = (value) => {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const textValue = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const canonicalFirstPresentInstant = (...values) => canonicalInstant(firstPresent(...values));

const temporalOrderBlocker = (blockers, left, right, code) => {
  const leftMs = Date.parse(left || "");
  const rightMs = Date.parse(right || "");
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs) blockers.push(code);
};

const buildDecisionClockAudit = ({
  match,
  model,
  unified,
  capturedAt,
  decisionAt,
  cutoffTime,
  hadOdds,
  hhadOdds,
  collectorTrustRegistry = null,
}) => {
  const featureSnapshot = match?.predictionMeta?.featureSnapshot || {};
  const featureHad = featureSnapshot?.market?.had || {};
  const featureHhad = featureSnapshot?.market?.hhad || {};
  const immutableMarketProvenance = (featureMarket, topLevelProvenance) => (
    Object.prototype.hasOwnProperty.call(featureMarket || {}, "provenance")
      ? featureMarket.provenance
      : topLevelProvenance
  );
  const rawMarketProvenance = {
    HAD: immutableMarketProvenance(featureHad, match?.oddsMarketProvenance),
    HHAD: immutableMarketProvenance(featureHhad, match?.handicapOddsMarketProvenance),
  };
  const marketProvenance = {
    HAD: normalizeMarketSourceProvenance(rawMarketProvenance.HAD, { trustRegistry: collectorTrustRegistry }),
    HHAD: normalizeMarketSourceProvenance(rawMarketProvenance.HHAD, { trustRegistry: collectorTrustRegistry }),
  };
  const marketLineageId = marketSourceLineageId([
    marketProvenance.HAD,
    marketProvenance.HHAD,
  ]);
  // Prefer the immutable feature snapshot. Top-level match clocks may belong to
  // a later refresh even when the original decision/model was deliberately
  // preserved because the market state did not change.
  const featureCycleId = textValue(featureSnapshot?.sourceCycleId || featureSnapshot?.source?.cycleId);
  const metaCycleId = textValue(match?.predictionMeta?.sourceCycleId);
  const matchCycleId = textValue(match?.sourceCycleId);
  const sourceCycleId = marketLineageId || featureCycleId || metaCycleId || matchCycleId;
  const baseModelGeneratedAt = canonicalFirstPresentInstant(model?.generatedAt);
  const unifiedPosteriorGeneratedAt = canonicalFirstPresentInstant(unified?.generatedAt);
  const modelGeneratedAt = [baseModelGeneratedAt, unifiedPosteriorGeneratedAt]
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const canonicalDecisionAt = canonicalFirstPresentInstant(decisionAt);
  const canonicalCapturedAt = canonicalFirstPresentInstant(capturedAt);
  const canonicalCutoffTime = canonicalFirstPresentInstant(cutoffTime);
  const canonicalKickoffTime = canonicalFirstPresentInstant(match?.kickoffTime);
  const marketTimes = {
    HAD: {
      observedAt: canonicalInstant(marketProvenance.HAD?.timing?.providerObservedAt),
      receivedAt: canonicalInstant(marketProvenance.HAD?.timing?.receivedAt),
      sourceCycleId: textValue(marketProvenance.HAD?.cycles?.collectorSourceCycleId),
      provenanceHash: textValue(marketProvenance.HAD?.hash),
      provenanceEligible: isStrictMarketSourceProvenance(rawMarketProvenance.HAD, { trustRegistry: collectorTrustRegistry }),
    },
    HHAD: {
      observedAt: canonicalInstant(marketProvenance.HHAD?.timing?.providerObservedAt),
      receivedAt: canonicalInstant(marketProvenance.HHAD?.timing?.receivedAt),
      sourceCycleId: textValue(marketProvenance.HHAD?.cycles?.collectorSourceCycleId),
      provenanceHash: textValue(marketProvenance.HHAD?.hash),
      provenanceEligible: isStrictMarketSourceProvenance(rawMarketProvenance.HHAD, { trustRegistry: collectorTrustRegistry }),
    },
  };
  const blockers = [];
  if (!sourceCycleId) blockers.push("source-cycle-id-missing");
  if (marketLineageId && featureCycleId && marketLineageId !== featureCycleId) {
    blockers.push("feature-market-source-cycle-mismatch");
  }
  if (marketLineageId && metaCycleId && marketLineageId !== metaCycleId) {
    blockers.push("prediction-meta-market-source-cycle-mismatch");
  }
  if (featureCycleId && metaCycleId && featureCycleId !== metaCycleId) {
    blockers.push("feature-source-cycle-mismatch");
  }
  if (!canonicalCapturedAt) blockers.push("captured-at-missing-or-invalid");
  if (!canonicalDecisionAt) blockers.push("decision-at-missing-or-invalid");
  if (!baseModelGeneratedAt) blockers.push("base-model-generated-at-missing-or-invalid");
  if (!unifiedPosteriorGeneratedAt) blockers.push("unified-posterior-generated-at-missing-or-invalid");
  if (!modelGeneratedAt) blockers.push("model-generated-at-missing-or-invalid");
  if (!canonicalCutoffTime) blockers.push("cutoff-time-missing-or-invalid");
  if (!canonicalKickoffTime) blockers.push("kickoff-time-missing-or-invalid");
  temporalOrderBlocker(blockers, baseModelGeneratedAt, canonicalDecisionAt, "base-model-generated-after-decision");
  temporalOrderBlocker(blockers, unifiedPosteriorGeneratedAt, canonicalDecisionAt, "unified-posterior-generated-after-decision");
  temporalOrderBlocker(blockers, baseModelGeneratedAt, unifiedPosteriorGeneratedAt, "base-model-generated-after-unified-posterior");
  temporalOrderBlocker(blockers, modelGeneratedAt, canonicalDecisionAt, "model-generated-after-decision");
  temporalOrderBlocker(blockers, canonicalCapturedAt, canonicalDecisionAt, "snapshot-captured-after-decision");
  temporalOrderBlocker(blockers, canonicalDecisionAt, canonicalCutoffTime, "decision-after-cutoff");
  temporalOrderBlocker(blockers, canonicalDecisionAt, canonicalKickoffTime, "decision-after-kickoff");

  for (const [market, odds] of [["HAD", hadOdds], ["HHAD", hhadOdds]]) {
    if (!odds) continue;
    const prefix = market.toLowerCase();
    const times = marketTimes[market];
    const provenance = marketProvenance[market];
    if (!rawMarketProvenance[market]) {
      blockers.push(`${prefix}-market-provenance-missing`);
    } else if (!times.provenanceEligible) {
      const provenanceBlockers = provenance?.strict?.blockers?.length
        ? provenance.strict.blockers
        : ["invalid"];
      blockers.push(...provenanceBlockers.map((blocker) => `${prefix}-market-provenance-${blocker}`));
    }
    if (!times.sourceCycleId) blockers.push(`${prefix}-market-source-cycle-missing`);
    if (!times.observedAt) blockers.push(`${prefix}-odds-observed-at-missing-or-invalid`);
    if (!times.receivedAt) blockers.push(`${prefix}-odds-received-at-missing-or-invalid`);
    temporalOrderBlocker(blockers, times.observedAt, times.receivedAt, `${prefix}-odds-observed-after-received`);
    temporalOrderBlocker(blockers, times.receivedAt, unifiedPosteriorGeneratedAt, `${prefix}-odds-received-after-unified-posterior`);
    temporalOrderBlocker(blockers, times.receivedAt, canonicalDecisionAt, `${prefix}-odds-received-after-decision`);
  }

  return {
    version: "decision-clock-audit-v1",
    eligible: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
    sourceCycleId,
    capturedAt: canonicalCapturedAt,
    decisionAt: canonicalDecisionAt,
    cutoffTime: canonicalCutoffTime,
    kickoffTime: canonicalKickoffTime,
    modelGeneratedAt,
    baseModelGeneratedAt,
    unifiedPosteriorGeneratedAt,
    markets: marketTimes,
  };
};

const toFixedPoint = (value, scale, normalize = (item) => item) => {
  const number = normalize(value);
  return number === null || !Number.isFinite(number)
    ? null
    : Math.round(number * scale);
};

const fromFixedPoint = (value, scale) => (
  Number.isSafeInteger(value) ? value / scale : undefined
);

const normalizeProbability = (value) => {
  const number = finiteNumber(value);
  if (number === null) return null;
  const decimal = number > 1 ? number / 100 : number;
  if (decimal < 0 || decimal > 1) return null;
  return rounded(decimal);
};

const normalizeTriplet = (value) => {
  if (!value || typeof value !== "object") return null;
  const home = normalizeProbability(value.home ?? value["1"]);
  const draw = normalizeProbability(value.draw ?? value.X);
  const away = normalizeProbability(value.away ?? value["2"]);
  if (![home, draw, away].every((item) => item !== null)) return null;
  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": rounded(home / total),
    X: rounded(draw / total),
    "2": rounded(away / total),
  };
};

const normalizeTwoWay = (value, firstKey, secondKey) => {
  if (!value || typeof value !== "object") return null;
  const first = normalizeProbability(value[firstKey]);
  const second = normalizeProbability(value[secondKey]);
  if (first === null || second === null) return null;
  const total = first + second;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    [firstKey]: rounded(first / total),
    [secondKey]: rounded(second / total),
  };
};

const normalizeOdds = (value) => {
  if (!value || typeof value !== "object") return null;
  const odds1 = finiteNumber(value.odds1 ?? value.home ?? value["1"]);
  const oddsX = finiteNumber(value.oddsX ?? value.draw ?? value.X);
  const odds2 = finiteNumber(value.odds2 ?? value.away ?? value["2"]);
  if (![odds1, oddsX, odds2].every((item) => item !== null && item > 1)) return null;
  return { "1": rounded(odds1, 3), X: rounded(oddsX, 3), "2": rounded(odds2, 3) };
};

const devigProbabilities = (odds) => {
  const normalizedOdds = normalizeOdds(odds);
  if (!normalizedOdds) return null;
  const raw = {
    "1": 1 / normalizedOdds["1"],
    X: 1 / normalizedOdds.X,
    "2": 1 / normalizedOdds["2"],
  };
  const total = raw["1"] + raw.X + raw["2"];
  return {
    "1": rounded(raw["1"] / total),
    X: rounded(raw.X / total),
    "2": rounded(raw["2"] / total),
  };
};

const normalizedLine = (value) => {
  const line = finiteNumber(String(value ?? "").replace(/[^0-9+\-.]/g, ""));
  return line === null ? null : rounded(line, 2);
};

const evidenceReplayPolicyFor = (match) => {
  const model = match?.probabilityModel || {};
  const unified = model.unifiedPosterior || {};
  return {
    decisionSnapshotVersion: DECISION_SNAPSHOT_VERSION,
    evidenceReplayVersion: EVIDENCE_REPLAY_VERSION,
    canonicalizationVersion: EVIDENCE_CANONICALIZATION_VERSION,
    fixedPointScales: FIXED_POINT_SCALES,
    multiFactorPolicyVersion: MULTI_FACTOR_POLICY_VERSION,
    predictionPolicyVersion: match?.predictionMeta?.policyVersion || null,
    promptVersion: match?.predictionMeta?.promptVersion || null,
    modelVersion: match?.predictionMeta?.modelVersion || model.version || null,
    calibrationVersion: match?.predictionMeta?.calibrationVersion
      || model.dynamicCalibration?.version
      || null,
    unifiedPosteriorVersion: unified.version || null,
    selectionPolicy: unified.selectionPolicy || unified.policy || null,
  };
};

const policyHashFor = (policy) => canonicalHash(policy);

const canonicalEvidenceInputsFor = ({
  market,
  code,
  handicapLine,
  odds,
  modelProbability,
  marketProbability,
  modelGap,
  dataQuality,
  diagnostics,
}) => {
  const source = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const normalizedMarket = String(market || "").toUpperCase();
  const normalizedCode = String(code || "").toUpperCase();
  const normalizedHandicapLine = normalizedMarket === "HAD" ? 0 : normalizedLine(handicapLine);
  const trustPenalty = clamp(finiteNumber(source.trustPenalty) ?? 0, 0, 40);
  const riskPenalty = clamp(finiteNumber(source.riskPenalty) ?? 0, 0, 0.3);
  return {
    schema: EVIDENCE_CANONICALIZATION_VERSION,
    market: normalizedMarket,
    code: normalizedCode,
    handicapLineHundredths: toFixedPoint(
      normalizedHandicapLine,
      FIXED_POINT_SCALES.handicapLine,
      finiteNumber,
    ),
    oddsMilli: toFixedPoint(odds, FIXED_POINT_SCALES.odds, (value) => rounded(value, 3)),
    modelProbabilityPpm: toFixedPoint(
      modelProbability,
      FIXED_POINT_SCALES.probability,
      normalizeProbability,
    ),
    marketProbabilityPpm: toFixedPoint(
      marketProbability,
      FIXED_POINT_SCALES.probability,
      normalizeProbability,
    ),
    modelGapPpm: toFixedPoint(modelGap, FIXED_POINT_SCALES.probability, normalizeProbability),
    dataQualityPpm: toFixedPoint(dataQuality, FIXED_POINT_SCALES.probability, normalizeProbability),
    trustPenaltyTenThousandths: toFixedPoint(
      trustPenalty,
      FIXED_POINT_SCALES.trustPenalty,
      finiteNumber,
    ),
    riskPenaltyPpm: toFixedPoint(
      riskPenalty,
      FIXED_POINT_SCALES.riskPenalty,
      finiteNumber,
    ),
    severeMissingCount: Math.max(0, Math.round(finiteNumber(source.severeMissingCount) ?? 0)),
    riskTagsCount: Math.max(0, Math.round(finiteNumber(source.riskTagsCount) ?? 0)),
    scoreAligned: source.scoreAligned === true,
    crossMarketCompatible: source.crossMarketCompatible !== false,
    handicapAligned: source.handicapAligned === true,
    marketLeaderAligned: source.marketLeaderAligned === true,
    trendSupports: source.trendSupports === true,
    trendContradicts: source.trendContradicts === true,
    externalMarketAligned: source.externalMarketAligned === true,
    externalMarketContradicted: source.externalMarketContradicted === true,
    externalMarketRisk: String(source.externalMarketRisk || "").toLowerCase() || null,
    upstreamRecommended: source.upstreamRecommended === true,
    upstreamAligned: source.upstreamAligned === true,
    globalRiskTier: String(source.globalRiskTier || "").toLowerCase() || null,
  };
};

const evidenceEvaluatorInputFromCanonical = (input) => ({
  market: input?.market,
  code: input?.code,
  handicapLine: fromFixedPoint(input?.handicapLineHundredths, FIXED_POINT_SCALES.handicapLine),
  odds: fromFixedPoint(input?.oddsMilli, FIXED_POINT_SCALES.odds),
  modelProbability: fromFixedPoint(input?.modelProbabilityPpm, FIXED_POINT_SCALES.probability),
  marketProbability: fromFixedPoint(input?.marketProbabilityPpm, FIXED_POINT_SCALES.probability),
  modelGap: fromFixedPoint(input?.modelGapPpm, FIXED_POINT_SCALES.probability),
  dataQuality: fromFixedPoint(input?.dataQualityPpm, FIXED_POINT_SCALES.probability),
  trustPenalty: fromFixedPoint(
    input?.trustPenaltyTenThousandths,
    FIXED_POINT_SCALES.trustPenalty,
  ),
  riskPenalty: fromFixedPoint(input?.riskPenaltyPpm, FIXED_POINT_SCALES.riskPenalty),
  severeMissingCount: Number.isSafeInteger(input?.severeMissingCount)
    ? input.severeMissingCount
    : undefined,
  riskTagsCount: Number.isSafeInteger(input?.riskTagsCount) ? input.riskTagsCount : undefined,
  scoreAligned: input?.scoreAligned === true,
  crossMarketCompatible: input?.crossMarketCompatible !== false,
  handicapAligned: input?.handicapAligned === true,
  marketLeaderAligned: input?.marketLeaderAligned === true,
  trendSupports: input?.trendSupports === true,
  trendContradicts: input?.trendContradicts === true,
  externalMarketAligned: input?.externalMarketAligned === true,
  externalMarketContradicted: input?.externalMarketContradicted === true,
  externalMarketRisk: input?.externalMarketRisk || undefined,
  upstreamRecommended: input?.upstreamRecommended === true,
  upstreamAligned: input?.upstreamAligned === true,
  globalRiskTier: input?.globalRiskTier || undefined,
});

const replayHashPayload = (policy, canonicalInputs, canonicalOutput) => ({
  replayVersion: EVIDENCE_REPLAY_VERSION,
  policy,
  canonicalInputs,
  canonicalOutput,
});

const buildEvidenceReplayRecord = (policy, canonicalInputs) => {
  const canonicalOutput = evaluateMultiFactorRecommendation(
    evidenceEvaluatorInputFromCanonical(canonicalInputs),
  );
  return {
    version: EVIDENCE_REPLAY_VERSION,
    canonicalInputs,
    canonicalOutput,
    hash: canonicalHash(replayHashPayload(policy, canonicalInputs, canonicalOutput)),
  };
};

const compactScoreDistribution = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => ({
    home: finiteNumber(row?.home),
    away: finiteNumber(row?.away),
    label: row?.label || null,
    probability: normalizeProbability(row?.probability),
  }))
  .filter((row) => row.home !== null && row.away !== null && row.probability !== null)
  .slice(0, 12);

const candidateKey = (market, code, line) => [
  String(market || "").toUpperCase(),
  String(code || "").toUpperCase(),
  String(market || "").toUpperCase() === "HHAD" ? (line ?? "missing-line") : "0",
].join(":");

const decisionRevisionFor = (match) => {
  const decisionId = String(match?.predictionMeta?.decisionId || "").trim();
  const decisionRevision = finiteNumber(match?.predictionMeta?.decisionRevision);
  if (!decisionId && decisionRevision === null) return null;
  return `${decisionId || "decision"}:r${decisionRevision ?? "unknown"}`;
};

const buildHhadCompanionShadowTrack = ({
  match,
  model,
  unified,
  bestPrediction,
  capturedAt,
  decisionAt,
  cutoffTime,
  evidenceVersion,
  clockAudit,
}) => {
  const featureHhad = match?.predictionMeta?.featureSnapshot?.market?.hhad || {};
  const modelVersion = match?.predictionMeta?.modelVersion || model?.version || null;
  const sourceRevision = decisionRevisionFor(match);
  const sourceSnapshotHash = match?.predictionMeta?.featureSnapshotHash
    || match?.predictionMeta?.featureSnapshot?.hash
    || null;
  const officialHhadObservedAt = clockAudit?.markets?.HHAD?.observedAt
    || canonicalFirstPresentInstant(featureHhad.observedAt, featureHhad.updatedAt)
    || null;
  const officialHhadReceivedAt = clockAudit?.markets?.HHAD?.receivedAt
    || canonicalFirstPresentInstant(featureHhad.receivedAt)
    || null;
  // Keep the raw explicit model clocks here so the shadow evaluator can
  // distinguish an invalid supplied value from a genuinely absent value.
  const modelGeneratedAt = firstPresent(model?.generatedAt) ?? null;
  const unifiedPosteriorGeneratedAt = firstPresent(unified?.generatedAt) ?? null;
  const featureSnapshotCapturedAt = match?.predictionMeta?.featureSnapshot?.capturedAt ?? null;
  const evaluation = evaluateHhadCompanionShadow({
    sourceMatchId: match?.sourceMatchId || null,
    matchId: match?.id || null,
    cutoffTime,
    capturedAt,
    receivedAt: officialHhadReceivedAt,
    observedAt: officialHhadObservedAt,
    modelGeneratedAt,
    unifiedPosteriorGeneratedAt,
    decisionAt,
    featureSnapshotCapturedAt,
    sourceRevision,
    sourceSnapshotHash,
    modelVersion,
    // These are deliberately exact-source inputs. In particular, the shadow
    // track must not fall back to Poisson probabilities or a lower market SP.
    handicapLine: match?.handicapLine,
    modelHandicapLine: model?.handicap?.line,
    odds: match?.handicapOdds,
    modelProbabilities: model?.handicap?.unifiedPosterior,
    best: bestPrediction ? {
      oddsPoolCode: bestPrediction.oddsPoolCode,
      tipCode: bestPrediction.tipCode,
      handicapLine: bestPrediction.handicapLine,
    } : null,
  });

  return {
    ...evaluation,
    publicVisible: false,
    timestamps: {
      capturedAt: evaluation.sourceTimes.capturedAt,
      decisionAt: evaluation.sourceTimes.decisionAt,
      cutoffTime: evaluation.cutoffTime,
      modelGeneratedAt: evaluation.sourceTimes.modelGeneratedAt,
      unifiedPosteriorGeneratedAt: evaluation.sourceTimes.unifiedPosteriorGeneratedAt,
      featureSnapshotCapturedAt: evaluation.sourceTimes.featureSnapshotCapturedAt,
      officialHhadObservedAt: evaluation.sourceTimes.observedAt,
      officialHhadReceivedAt: evaluation.sourceTimes.receivedAt,
    },
    provenance: {
      sourceRevision,
      sourceSnapshotHash,
      sourceCycleId: clockAudit?.sourceCycleId || null,
      decisionSnapshotVersion: DECISION_SNAPSHOT_VERSION,
      policyVersion: match?.predictionMeta?.policyVersion || null,
      promptVersion: match?.predictionMeta?.promptVersion || null,
      modelVersion,
      calibrationVersion: match?.predictionMeta?.calibrationVersion
        || model?.dynamicCalibration?.version
        || null,
      unifiedPosteriorVersion: unified?.version || null,
      evidenceVersion: evidenceVersion || null,
    },
  };
};

const buildCandidateDecisionSnapshot = (match, capturedAt, options = {}) => {
  const model = match?.probabilityModel || {};
  const unified = model.unifiedPosterior || {};
  const hadOdds = normalizeOdds(match?.odds);
  const hhadOdds = normalizeOdds(match?.handicapOdds);
  const hhadLine = normalizedLine(match?.handicapLine ?? model.handicap?.line ?? unified.selectedHandicapLine);
  const hadProbabilities = normalizeTriplet(model.oneXTwo?.final);
  const hhadProbabilities = normalizeTriplet(model.handicap?.unifiedPosterior || model.handicap?.poisson);
  const hadMarketProbabilities = devigProbabilities(hadOdds);
  const hhadMarketProbabilities = devigProbabilities(hhadOdds);
  const selectedMarket = String(unified.selectedMarket || "").toUpperCase();
  const selectedCode = String(unified.selectedCode || "").toUpperCase();
  const bestPrediction = (Array.isArray(match?.predictions) ? match.predictions : [])
    .find((prediction) => String(prediction?.marketType || "").toUpperCase() === "BEST") || null;
  const rawCandidates = Array.isArray(unified.candidates) ? unified.candidates : [];
  const evidenceVersion = MULTI_FACTOR_POLICY_VERSION;
  const evidenceReplayPolicy = evidenceReplayPolicyFor(match);
  const policyHash = policyHashFor(evidenceReplayPolicy);
  const rawDecisionAt = firstPresent(
    match?.predictionMeta?.decisionGeneratedAt,
    match?.predictionMeta?.generatedAt,
  );
  const cutoffTime = match?.predictionMeta?.cutoffTime || match?.buyEndTime || match?.kickoffTime || null;
  const clockAudit = buildDecisionClockAudit({
    match,
    model,
    unified,
    capturedAt,
    decisionAt: rawDecisionAt,
    cutoffTime,
    hadOdds,
    hhadOdds,
    collectorTrustRegistry: options.collectorTrustRegistry || null,
  });
  const featureMarket = match?.predictionMeta?.featureSnapshot?.market || {};
  const decisionHadProvenance = normalizeMarketSourceProvenance(
    Object.prototype.hasOwnProperty.call(featureMarket?.had || {}, "provenance")
      ? featureMarket.had.provenance
      : match?.oddsMarketProvenance,
    { trustRegistry: options.collectorTrustRegistry || null },
  );
  const decisionHhadProvenance = normalizeMarketSourceProvenance(
    Object.prototype.hasOwnProperty.call(featureMarket?.hhad || {}, "provenance")
      ? featureMarket.hhad.provenance
      : match?.handicapOddsMarketProvenance,
    { trustRegistry: options.collectorTrustRegistry || null },
  );
  const captured = clockAudit.capturedAt;
  const decisionAt = clockAudit.decisionAt;
  const dataQuality = normalizeProbability(
    unified.dataQuality ?? model.modelHealth?.dataGaps?.coverageScore,
  );

  const candidates = rawCandidates.map((candidate) => {
    const market = String(candidate?.market || "").toUpperCase();
    const code = String(candidate?.code || "").toUpperCase();
    if (!["HAD", "HHAD"].includes(market) || !["1", "X", "2"].includes(code)) return null;
    const sourceLine = market === "HHAD" ? hhadLine : null;
    const marketOdds = market === "HHAD" ? hhadOdds : hadOdds;
    const marketProbabilities = market === "HHAD" ? hhadMarketProbabilities : hadMarketProbabilities;
    const selected = market === selectedMarket && code === selectedCode;
    const selectedEvidence = unified.multiFactorEvidence;
    const evidence = selected
      && selectedEvidence
      && String(selectedEvidence.market || market).toUpperCase() === market
      && String(selectedEvidence.code || code).toUpperCase() === code
      ? selectedEvidence
      : (candidate?.multiFactorEvidence || {});
    const sourceModelProbability = normalizeProbability(candidate?.probability);
    const sourceOdds = finiteNumber(candidate?.odds) || finiteNumber(marketOdds?.[code]);
    const sourceMarketProbability = normalizeProbability(evidence.marketProbability)
      ?? normalizeProbability(marketProbabilities?.[code]);
    const canonicalInputs = canonicalEvidenceInputsFor({
      market,
      code,
      handicapLine: sourceLine,
      odds: sourceOdds,
      modelProbability: sourceModelProbability,
      marketProbability: sourceMarketProbability,
      modelGap: evidence.modelGap ?? candidate?.gap,
      dataQuality,
      diagnostics: evidence.diagnostics,
    });
    const evidenceReplay = buildEvidenceReplayRecord(evidenceReplayPolicy, canonicalInputs);
    const replayInput = evidenceEvaluatorInputFromCanonical(canonicalInputs);
    const canonicalEvidence = evidenceReplay.canonicalOutput;
    const line = market === "HHAD" ? replayInput.handicapLine ?? null : null;
    const odds = replayInput.odds ?? null;
    const modelProbability = replayInput.modelProbability ?? null;
    const marketProbability = replayInput.marketProbability ?? null;
    const blockers = [...canonicalEvidence.blockers];
    const localEvidenceBlockers = blockers.filter((blocker) => !GOVERNANCE_ONLY_BLOCKERS.has(blocker));
    const key = candidateKey(market, code, line);
    return {
      key,
      market,
      code,
      handicapLine: line,
      selected,
      odds,
      modelProbability,
      marketProbability,
      probabilityEdge: canonicalEvidence.probabilityEdge,
      expectedValue: canonicalEvidence.expectedValue,
      modelGap: canonicalEvidence.modelGap,
      posteriorScore: rounded(candidate?.posteriorScore),
      evidenceScore: canonicalEvidence.evidenceScore,
      evidenceThreshold: canonicalEvidence.threshold,
      evidenceGrade: canonicalEvidence.grade,
      evidenceVersion: canonicalEvidence.version,
      publicEligible: canonicalEvidence.eligible === true,
      localEvidenceEligible: localEvidenceBlockers.length === 0,
      shadowEligible: Boolean(selected && modelProbability !== null && odds !== null && odds > 1),
      blockers,
      localEvidenceBlockers,
      supportingFactors: canonicalEvidence.supportingFactors,
      diagnostics: canonicalEvidence.diagnostics,
      components: canonicalEvidence.components,
      evidenceReplay,
    };
  }).filter(Boolean);

  const selectedCandidate = candidates.find((candidate) => candidate.selected) || null;
  const selectedModelBlockers = selectedCandidate
    ? selectedCandidate.localEvidenceBlockers
    : ["no-canonical-selected-candidate"];
  const publicAction = String(bestPrediction?.recommendationAction || unified.recommendationAction || "reference").toLowerCase();
  const publicEligible = clockAudit.eligible
    && publicAction === "recommend"
    && selectedCandidate?.publicEligible === true
    && bestPrediction?.oddsPoolCode === selectedCandidate.market
    && String(bestPrediction?.tipCode || "").toUpperCase() === selectedCandidate.code;
  const hhadCompanionShadowTrack = buildHhadCompanionShadowTrack({
    match,
    model,
    unified,
    bestPrediction,
    capturedAt: captured,
    decisionAt,
    cutoffTime,
    evidenceVersion,
    clockAudit,
  });

  return {
    version: DECISION_SNAPSHOT_VERSION,
    capturedAt: captured,
    decisionAt,
    sourceCycleId: clockAudit.sourceCycleId,
    sourceMatchId: match?.sourceMatchId || null,
    matchId: match?.id || null,
    kickoffTime: clockAudit.kickoffTime,
    cutoffTime: clockAudit.cutoffTime,
    policyVersion: match?.predictionMeta?.policyVersion || null,
    promptVersion: match?.predictionMeta?.promptVersion || null,
    modelVersion: match?.predictionMeta?.modelVersion || model.version || null,
    calibrationVersion: match?.predictionMeta?.calibrationVersion || model.dynamicCalibration?.version || null,
    policyHash,
    evidenceReplayPolicy,
    featureSnapshotHash: match?.predictionMeta?.featureSnapshotHash || match?.predictionMeta?.featureSnapshot?.hash || null,
    sourceTimestamps: {
      modelGeneratedAt: clockAudit.modelGeneratedAt,
      baseModelGeneratedAt: clockAudit.baseModelGeneratedAt,
      unifiedPosteriorGeneratedAt: clockAudit.unifiedPosteriorGeneratedAt,
      hadObservedAt: clockAudit.markets.HAD.observedAt,
      hadReceivedAt: clockAudit.markets.HAD.receivedAt,
      hhadObservedAt: clockAudit.markets.HHAD.observedAt,
      hhadReceivedAt: clockAudit.markets.HHAD.receivedAt,
      externalObservedAt: match?.externalSignals?.fiveHundred?.updatedAt || match?.externalSignals?.updatedAt || null,
    },
    clockAudit,
    markets: {
      HAD: hadOdds ? {
        line: 0,
        odds: hadOdds,
        marketProbabilities: hadMarketProbabilities,
        observedAt: clockAudit.markets.HAD.observedAt,
        receivedAt: clockAudit.markets.HAD.receivedAt,
        provenance: decisionHadProvenance,
        provenanceHash: decisionHadProvenance?.hash || null,
      } : null,
      HHAD: hhadOdds && hhadLine !== null
        ? {
            line: hhadLine,
            odds: hhadOdds,
            marketProbabilities: hhadMarketProbabilities,
            observedAt: clockAudit.markets.HHAD.observedAt,
            receivedAt: clockAudit.markets.HHAD.receivedAt,
            provenance: decisionHhadProvenance,
            provenanceHash: decisionHhadProvenance?.hash || null,
          }
        : null,
    },
    probabilities: {
      HAD: hadProbabilities,
      HHAD: hhadProbabilities && hhadLine !== null ? { line: hhadLine, outcomes: hhadProbabilities } : null,
      GOALS: normalizeTwoWay(model.goalLines, "over25", "under25"),
      BTTS: normalizeTwoWay(model.bothTeamsToScore, "yes", "no"),
    },
    lambdas: model.lambdaBlend ? {
      independentHome: rounded(model.lambdaBlend.independentHomeLambda),
      independentAway: rounded(model.lambdaBlend.independentAwayLambda),
      independentTotal: rounded(model.lambdaBlend.independentTotalLambda),
      marketHome: rounded(model.lambdaBlend.marketHomeLambda),
      marketAway: rounded(model.lambdaBlend.marketAwayLambda),
      leagueHome: rounded(model.lambdaBlend.leagueHomeLambda),
      leagueAway: rounded(model.lambdaBlend.leagueAwayLambda),
      formHome: rounded(model.lambdaBlend.formHomeLambda),
      formAway: rounded(model.lambdaBlend.formAwayLambda),
    } : null,
    scoreDistribution: compactScoreDistribution(model.scoreDistribution),
    dataQuality,
    candidates,
    selectedCandidateKey: selectedCandidate?.key || null,
    exposure: {
      publicAction,
      publicEligible,
      publicCandidateKey: publicEligible ? selectedCandidate.key : null,
      shadowAction: clockAudit.eligible && selectedCandidate?.shadowEligible ? "evaluate" : "skip",
      shadowEligible: clockAudit.eligible && selectedCandidate?.shadowEligible === true,
      shadowCandidateKey: clockAudit.eligible && selectedCandidate?.shadowEligible ? selectedCandidate.key : null,
      localEvidenceEligible: selectedCandidate?.localEvidenceEligible === true,
      governanceBlockers: (selectedCandidate?.blockers || []).filter((blocker) => GOVERNANCE_ONLY_BLOCKERS.has(blocker)),
      modelBlockers: Array.from(new Set([...selectedModelBlockers, ...clockAudit.blockers])),
      shadowTracks: {
        HHAD_COMPANION: hhadCompanionShadowTrack,
      },
    },
  };
};

const isDecisionSnapshotVersion = (version) => (
  version === DECISION_SNAPSHOT_VERSION || version === LEGACY_DECISION_SNAPSHOT_VERSION
);

const isPromotionDecisionSnapshotVersion = (version) => version === DECISION_SNAPSHOT_VERSION;

const isDecisionClockAuditEligible = (decisionSnapshot, options = {}) => {
  const audit = decisionSnapshot?.clockAudit;
  if (decisionSnapshot?.version !== DECISION_SNAPSHOT_VERSION
      || audit?.version !== "decision-clock-audit-v1"
      || audit?.eligible !== true
      || !Array.isArray(audit?.blockers)
      || audit.blockers.length > 0
      || !textValue(decisionSnapshot?.sourceCycleId)
      || decisionSnapshot.sourceCycleId !== audit.sourceCycleId) {
    return false;
  }
  const required = [
    audit.capturedAt,
    audit.decisionAt,
    audit.cutoffTime,
    audit.kickoffTime,
    audit.modelGeneratedAt,
    audit.baseModelGeneratedAt,
    audit.unifiedPosteriorGeneratedAt,
  ];
  if (!required.every((value) => canonicalInstant(value) === value)) return false;
  const latestModelClock = [audit.baseModelGeneratedAt, audit.unifiedPosteriorGeneratedAt]
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  if (audit.modelGeneratedAt !== latestModelClock) return false;
  const expectedTopLevel = [
    [decisionSnapshot.capturedAt, audit.capturedAt],
    [decisionSnapshot.decisionAt, audit.decisionAt],
    [decisionSnapshot.cutoffTime, audit.cutoffTime],
    [decisionSnapshot.kickoffTime, audit.kickoffTime],
    [decisionSnapshot?.sourceTimestamps?.modelGeneratedAt, audit.modelGeneratedAt],
    [decisionSnapshot?.sourceTimestamps?.baseModelGeneratedAt, audit.baseModelGeneratedAt],
    [decisionSnapshot?.sourceTimestamps?.unifiedPosteriorGeneratedAt, audit.unifiedPosteriorGeneratedAt],
  ];
  if (expectedTopLevel.some(([actual, expected]) => canonicalInstant(actual) !== expected)) return false;
  const orderedPairs = [
    [audit.capturedAt, audit.decisionAt],
    [audit.baseModelGeneratedAt, audit.decisionAt],
    [audit.unifiedPosteriorGeneratedAt, audit.decisionAt],
    [audit.baseModelGeneratedAt, audit.unifiedPosteriorGeneratedAt],
    [audit.modelGeneratedAt, audit.decisionAt],
    [audit.decisionAt, audit.cutoffTime],
    [audit.decisionAt, audit.kickoffTime],
  ];
  if (orderedPairs.some(([left, right]) => Date.parse(left) > Date.parse(right))) return false;
  for (const market of ["HAD", "HHAD"]) {
    if (!decisionSnapshot?.markets?.[market]) continue;
    const times = audit?.markets?.[market];
    const prefix = market.toLowerCase();
    const storedProvenance = decisionSnapshot.markets[market]?.provenance;
    const normalizedProvenance = normalizeMarketSourceProvenance(storedProvenance, {
      trustRegistry: options.collectorTrustRegistry || null,
    });
    if (canonicalInstant(times?.observedAt) !== times?.observedAt
        || canonicalInstant(times?.receivedAt) !== times?.receivedAt
        || Date.parse(times.observedAt) > Date.parse(times.receivedAt)
        || Date.parse(times.receivedAt) > Date.parse(audit.unifiedPosteriorGeneratedAt)
        || Date.parse(times.receivedAt) > Date.parse(audit.decisionAt)
        || canonicalInstant(decisionSnapshot.markets[market]?.observedAt) !== times.observedAt
        || canonicalInstant(decisionSnapshot.markets[market]?.receivedAt) !== times.receivedAt
        || canonicalInstant(decisionSnapshot?.sourceTimestamps?.[`${prefix}ObservedAt`]) !== times.observedAt
        || canonicalInstant(decisionSnapshot?.sourceTimestamps?.[`${prefix}ReceivedAt`]) !== times.receivedAt
        || !isStrictMarketSourceProvenance(storedProvenance, {
          trustRegistry: options.collectorTrustRegistry || null,
        })
        || decisionSnapshot.markets[market]?.provenanceHash !== normalizedProvenance?.hash
        || times.provenanceHash !== normalizedProvenance?.hash
        || times.provenanceEligible !== true
        || times.sourceCycleId !== normalizedProvenance?.cycles?.collectorSourceCycleId
        || times.observedAt !== normalizedProvenance?.timing?.providerObservedAt
        || times.receivedAt !== normalizedProvenance?.timing?.receivedAt) {
      return false;
    }
  }
  const marketLineageId = marketSourceLineageId(["HAD", "HHAD"]
    .map((market) => decisionSnapshot?.markets?.[market]?.provenance)
    .filter(Boolean));
  if (!marketLineageId
      || marketLineageId !== audit.sourceCycleId
      || marketLineageId !== decisionSnapshot.sourceCycleId) {
    return false;
  }
  return true;
};

const replayCandidateEvidence = (decisionSnapshot, candidate) => {
  if (!isPromotionDecisionSnapshotVersion(decisionSnapshot?.version)) {
    return {
      exact: false,
      promotionEligible: false,
      reason: decisionSnapshot?.version === LEGACY_DECISION_SNAPSHOT_VERSION
        ? "legacy-v1-audit-only"
        : "unsupported-decision-snapshot-version",
      replay: null,
    };
  }
  const policy = decisionSnapshot?.evidenceReplayPolicy;
  const record = candidate?.evidenceReplay;
  const canonicalInputs = record?.canonicalInputs;
  const storedOutput = record?.canonicalOutput;
  if (!policy || !record || !canonicalInputs || !storedOutput) {
    return {
      exact: false,
      promotionEligible: true,
      reason: "missing-canonical-replay-envelope",
      replay: null,
    };
  }

  const replay = evaluateMultiFactorRecommendation(
    evidenceEvaluatorInputFromCanonical(canonicalInputs),
  );
  const replayInput = evidenceEvaluatorInputFromCanonical(canonicalInputs);
  const normalizedCanonicalInputs = canonicalEvidenceInputsFor({
    market: replayInput.market,
    code: replayInput.code,
    handicapLine: replayInput.handicapLine,
    odds: replayInput.odds,
    modelProbability: replayInput.modelProbability,
    marketProbability: replayInput.marketProbability,
    modelGap: replayInput.modelGap,
    dataQuality: replayInput.dataQuality,
    diagnostics: replayInput,
  });
  const replayLine = canonicalInputs.market === "HHAD"
    ? replayInput.handicapLine ?? null
    : null;
  const expectedLocalBlockers = replay.blockers
    .filter((blocker) => !GOVERNANCE_ONLY_BLOCKERS.has(blocker));
  const expectedCandidateProjection = {
    key: candidateKey(canonicalInputs.market, canonicalInputs.code, replayLine),
    market: canonicalInputs.market,
    code: canonicalInputs.code,
    handicapLine: replayLine,
    odds: replayInput.odds ?? null,
    modelProbability: replayInput.modelProbability ?? null,
    marketProbability: replayInput.marketProbability ?? null,
    probabilityEdge: replay.probabilityEdge,
    expectedValue: replay.expectedValue,
    modelGap: replay.modelGap,
    evidenceScore: replay.evidenceScore,
    evidenceThreshold: replay.threshold,
    evidenceGrade: replay.grade,
    evidenceVersion: replay.version,
    publicEligible: replay.eligible === true,
    localEvidenceEligible: expectedLocalBlockers.length === 0,
    blockers: replay.blockers,
    localEvidenceBlockers: expectedLocalBlockers,
    supportingFactors: replay.supportingFactors,
    diagnostics: replay.diagnostics,
    components: replay.components,
  };
  const actualCandidateProjection = Object.fromEntries(
    Object.keys(expectedCandidateProjection).map((key) => [key, candidate?.[key]]),
  );
  const expectedReplayHash = canonicalHash(replayHashPayload(policy, canonicalInputs, storedOutput));
  const normalizedPolicyEnvelope = {
    decisionSnapshotVersion: policy.decisionSnapshotVersion,
    evidenceReplayVersion: policy.evidenceReplayVersion,
    canonicalizationVersion: policy.canonicalizationVersion,
    fixedPointScales: policy.fixedPointScales,
    multiFactorPolicyVersion: policy.multiFactorPolicyVersion,
    predictionPolicyVersion: policy.predictionPolicyVersion,
    promptVersion: policy.promptVersion,
    modelVersion: policy.modelVersion,
    calibrationVersion: policy.calibrationVersion,
    unifiedPosteriorVersion: policy.unifiedPosteriorVersion,
    selectionPolicy: policy.selectionPolicy,
  };
  const policyEnvelopeExact = canonicalStringify(policy) === canonicalStringify(normalizedPolicyEnvelope)
    && policy.decisionSnapshotVersion === DECISION_SNAPSHOT_VERSION
    && policy.evidenceReplayVersion === EVIDENCE_REPLAY_VERSION
    && policy.canonicalizationVersion === EVIDENCE_CANONICALIZATION_VERSION
    && policy.multiFactorPolicyVersion === MULTI_FACTOR_POLICY_VERSION
    && canonicalStringify(policy.fixedPointScales) === canonicalStringify(FIXED_POINT_SCALES)
    && canonicalInputs.schema === EVIDENCE_CANONICALIZATION_VERSION;
  const canonicalInputsExact = canonicalStringify(canonicalInputs)
    === canonicalStringify(normalizedCanonicalInputs);
  const policyHashExact = decisionSnapshot.policyHash === policyHashFor(policy);
  const outputExact = canonicalStringify(replay) === canonicalStringify(storedOutput);
  const replayHashExact = record.version === EVIDENCE_REPLAY_VERSION
    && record.hash === expectedReplayHash;
  const candidateProjectionExact = canonicalStringify(actualCandidateProjection)
    === canonicalStringify(expectedCandidateProjection);
  const exact = policyEnvelopeExact
    && canonicalInputsExact
    && policyHashExact
    && outputExact
    && replayHashExact
    && candidateProjectionExact;

  return {
    exact,
    promotionEligible: true,
    reason: exact ? null : "canonical-replay-mismatch",
    replay,
    expectedReplayHash,
    checks: {
      policyEnvelopeExact,
      canonicalInputsExact,
      policyHashExact,
      outputExact,
      replayHashExact,
      candidateProjectionExact,
    },
  };
};

const selectLatestEligibleDecisionSnapshot = (snapshots, kickoffTime) => {
  const kickoffMs = Date.parse(kickoffTime || "");
  if (!Number.isFinite(kickoffMs)) return null;
  const eligible = (Array.isArray(snapshots) ? snapshots : []).flatMap((snapshot) => {
    const decisionSnapshot = snapshot?.decisionSnapshot;
    if (!isDecisionSnapshotVersion(decisionSnapshot?.version) || snapshot?.phase === "review") return [];
    const capturedMs = Date.parse(
      decisionSnapshot.capturedAt || snapshot?.capturedAt || snapshot?.firstSeenAt || "",
    );
    if (!Number.isFinite(capturedMs)) return [];
    const cutoffMs = Date.parse(decisionSnapshot.cutoffTime || "");
    const deadlineMs = Number.isFinite(cutoffMs) ? Math.min(kickoffMs, cutoffMs) : kickoffMs;
    if (capturedMs > deadlineMs) return [];
    return [{ snapshot, capturedMs }];
  });
  eligible.sort((a, b) => (
    b.capturedMs - a.capturedMs
    || Number(isPromotionDecisionSnapshotVersion(b.snapshot?.decisionSnapshot?.version))
      - Number(isPromotionDecisionSnapshotVersion(a.snapshot?.decisionSnapshot?.version))
  ));
  return eligible[0] || null;
};

const resultCode = (scoreHome, scoreAway, line = 0) => {
  const home = finiteNumber(scoreHome);
  const away = finiteNumber(scoreAway);
  const handicap = finiteNumber(line);
  if (home === null || away === null || handicap === null) return null;
  const adjustedHome = home + handicap;
  if (adjustedHome > away) return "1";
  if (adjustedHome < away) return "2";
  return "X";
};

const settleDecisionCandidate = (candidate, scoreHome, scoreAway) => {
  if (!candidate || !["HAD", "HHAD"].includes(candidate.market)) return null;
  const outcomeCode = resultCode(scoreHome, scoreAway, candidate.market === "HHAD" ? candidate.handicapLine : 0);
  if (!outcomeCode) return null;
  return {
    outcomeCode,
    won: outcomeCode === candidate.code,
  };
};

module.exports = {
  DECISION_SNAPSHOT_VERSION,
  LEGACY_DECISION_SNAPSHOT_VERSION,
  EVIDENCE_REPLAY_VERSION,
  EVIDENCE_CANONICALIZATION_VERSION,
  FIXED_POINT_SCALES,
    GOVERNANCE_ONLY_BLOCKERS,
    buildCandidateDecisionSnapshot,
    buildDecisionClockAudit,
  canonicalHash,
  canonicalStringify,
  candidateKey,
    isDecisionSnapshotVersion,
    isDecisionClockAuditEligible,
  isPromotionDecisionSnapshotVersion,
  normalizeProbability,
  normalizeTriplet,
  replayCandidateEvidence,
  selectLatestEligibleDecisionSnapshot,
  settleDecisionCandidate,
};
