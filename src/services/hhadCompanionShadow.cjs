const crypto = require("node:crypto");

const HHAD_COMPANION_SHADOW_VERSION = "hhad-companion-shadow-v2";
const HHAD_COMPANION_SHADOW_STRATEGY = "HHAD_COMPANION_SHADOW";
const OUTCOME_CODES = ["1", "X", "2"];

const HHAD_COMPANION_SHADOW_POLICY = Object.freeze({
  strategy: HHAD_COMPANION_SHADOW_STRATEGY,
  version: HHAD_COMPANION_SHADOW_VERSION,
  poolCode: "HHAD",
  selection: "model-top-only",
  marketFallback: false,
  thresholds: Object.freeze({
    minimumAbsoluteHandicapLine: 0.5,
    minimumModelProbability: 0.48,
    minimumModelGap: 0.1,
    minimumMarketSupport: 0.35,
  }),
  requirements: Object.freeze([
    "exact-official-and-model-hhad-line",
    "complete-official-three-way-odds",
    "complete-model-three-way-probabilities",
    "model-and-market-top-alignment",
    "valid-pre-cutoff-source-and-model-times-when-present",
  ]),
});

const canonicalValue = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
        return result;
      }, {});
  }
  throw new TypeError(`unsupported canonical value: ${typeof value}`);
};

const canonicalStringify = (value) => JSON.stringify(canonicalValue(value));

const canonicalHash = (namespace, value) => crypto
  .createHash("sha256")
  .update(`${namespace}\n${canonicalStringify(value)}`)
  .digest("hex");

const STRATEGY_HASH = canonicalHash("hhad-companion-shadow/strategy", HHAD_COMPANION_SHADOW_POLICY);

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const rounded = (value, digits = 6) => {
  const numeric = finiteNumber(value);
  return numeric === null ? null : Number(numeric.toFixed(digits));
};

const normalizeCode = (value) => {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (["1", "H", "HOME", "WIN"].includes(normalized)) return "1";
  if (["X", "0", "D", "DRAW"].includes(normalized)) return "X";
  if (["2", "A", "AWAY", "LOSE"].includes(normalized)) return "2";
  return null;
};

const outcomeName = (code) => (code === "1" ? "HOME" : code === "X" ? "DRAW" : code === "2" ? "AWAY" : null);

const parseHandicapLine = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? rounded(value, 2) : null;
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-");
  const match = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) ? rounded(line, 2) : null;
};

const formatHandicapLine = (line) => {
  const normalized = parseHandicapLine(line);
  if (normalized === null) return null;
  if (normalized === 0) return "0";
  const magnitude = Number.isInteger(Math.abs(normalized))
    ? String(Math.abs(normalized))
    : String(Math.abs(normalized)).replace(/0+$/, "").replace(/\.$/, "");
  return `${normalized > 0 ? "+" : "-"}${magnitude}`;
};

const tripletValues = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    "1": value["1"] ?? value.home ?? value.odds1,
    X: value.X ?? value.draw ?? value.oddsX,
    "2": value["2"] ?? value.away ?? value.odds2,
  };
};

const normalizeOddsTriplet = (value) => {
  const raw = tripletValues(value);
  if (!raw) return null;
  const odds = Object.fromEntries(OUTCOME_CODES.map((code) => [code, finiteNumber(raw[code])]));
  if (!OUTCOME_CODES.every((code) => odds[code] !== null && odds[code] > 1)) return null;
  return Object.fromEntries(OUTCOME_CODES.map((code) => [code, rounded(odds[code], 3)]));
};

const normalizeProbabilityTriplet = (value) => {
  const raw = tripletValues(value);
  if (!raw) return null;
  const probabilities = {};
  for (const code of OUTCOME_CODES) {
    const numeric = finiteNumber(raw[code]);
    if (numeric === null) return null;
    const decimal = numeric > 1 ? numeric / 100 : numeric;
    if (decimal < 0 || decimal > 1) return null;
    probabilities[code] = decimal;
  }
  const total = OUTCOME_CODES.reduce((sum, code) => sum + probabilities[code], 0);
  if (!Number.isFinite(total) || total < 0.98 || total > 1.02) return null;
  return Object.fromEntries(OUTCOME_CODES.map((code) => [code, rounded(probabilities[code] / total)]));
};

const devigProbabilities = (odds) => {
  const normalized = normalizeOddsTriplet(odds);
  if (!normalized) return null;
  const inverse = Object.fromEntries(OUTCOME_CODES.map((code) => [code, 1 / normalized[code]]));
  const total = OUTCOME_CODES.reduce((sum, code) => sum + inverse[code], 0);
  return Object.fromEntries(OUTCOME_CODES.map((code) => [code, rounded(inverse[code] / total)]));
};

const rankTriplet = (triplet) => {
  if (!triplet) return null;
  const ranked = OUTCOME_CODES
    .map((code, index) => ({ code, probability: triplet[code], index }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index);
  return {
    code: ranked[0].code,
    probability: rounded(ranked[0].probability),
    gap: rounded(ranked[0].probability - ranked[1].probability),
    tied: ranked[0].probability === ranked[1].probability,
  };
};

const canonicalInstant = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const matchKeyFor = (input) => {
  const sourceMatchId = String(input.sourceMatchId || "").trim();
  const matchId = String(input.matchId || "").trim();
  return sourceMatchId || matchId || null;
};

const normalizedBest = (input) => {
  const best = input?.best || input?.publicBest || null;
  if (!best || typeof best !== "object") return null;
  const poolCode = String(best.poolCode || best.oddsPoolCode || best.market || "").trim().toUpperCase();
  const code = normalizeCode(best.code ?? best.tipCode);
  if (!poolCode || !code) return null;
  const line = poolCode === "HHAD" ? parseHandicapLine(best.handicapLine) : 0;
  return {
    poolCode,
    code,
    handicapLine: line,
    handicapLineText: poolCode === "HHAD" ? formatHandicapLine(line) : "0",
  };
};

const unique = (items) => Array.from(new Set(items.filter(Boolean)));

const evaluateHhadCompanionShadow = (input = {}) => {
  const matchKey = matchKeyFor(input);
  const officialLine = parseHandicapLine(input.handicapLine ?? input.officialHandicapLine);
  const modelLine = parseHandicapLine(input.modelHandicapLine ?? input.model?.handicapLine);
  const lineMatches = officialLine !== null && modelLine !== null && officialLine === modelLine;
  const odds = normalizeOddsTriplet(input.odds ?? input.officialOdds ?? input.handicapOdds);
  const modelProbabilities = normalizeProbabilityTriplet(input.modelProbabilities ?? input.model?.probabilities);
  const marketProbabilities = devigProbabilities(odds);
  const modelTop = rankTriplet(modelProbabilities);
  const marketTop = rankTriplet(marketProbabilities);
  const cutoffTime = canonicalInstant(input.cutoffTime);
  const capturedAt = canonicalInstant(input.capturedAt);
  const receivedAt = canonicalInstant(input.receivedAt);
  const observedAt = canonicalInstant(input.observedAt);
  const modelGeneratedAt = canonicalInstant(input.modelGeneratedAt);
  const unifiedPosteriorGeneratedAt = canonicalInstant(input.unifiedPosteriorGeneratedAt);
  const decisionAt = canonicalInstant(input.decisionAt);
  const featureSnapshotCapturedAt = canonicalInstant(input.featureSnapshotCapturedAt);
  const selectedCode = modelTop?.code || null;
  const selectedOdds = selectedCode && odds ? odds[selectedCode] : null;
  const marketSupport = selectedCode && marketProbabilities ? marketProbabilities[selectedCode] : null;

  const blockers = [];
  if (!matchKey) blockers.push("missing-match-identity");
  if (!cutoffTime) blockers.push("missing-or-invalid-cutoff-time");
  if (!capturedAt) blockers.push("missing-or-invalid-captured-at");
  if (input.receivedAt !== null && input.receivedAt !== undefined && !receivedAt) blockers.push("invalid-received-at");
  if (input.observedAt !== null && input.observedAt !== undefined && !observedAt) blockers.push("invalid-observed-at");
  if (input.modelGeneratedAt !== null && input.modelGeneratedAt !== undefined && !modelGeneratedAt) {
    blockers.push("invalid-model-generated-at");
  }
  if (input.unifiedPosteriorGeneratedAt !== null
    && input.unifiedPosteriorGeneratedAt !== undefined
    && !unifiedPosteriorGeneratedAt) {
    blockers.push("invalid-unified-posterior-generated-at");
  }
  if (input.decisionAt !== null && input.decisionAt !== undefined && !decisionAt) blockers.push("invalid-decision-at");
  if (input.featureSnapshotCapturedAt !== null
    && input.featureSnapshotCapturedAt !== undefined
    && !featureSnapshotCapturedAt) {
    blockers.push("invalid-feature-snapshot-captured-at");
  }
  if (officialLine === null) blockers.push("missing-official-hhad-line");
  if (modelLine === null) blockers.push("missing-model-hhad-line");
  if (officialLine !== null && modelLine !== null && !lineMatches) blockers.push("hhad-line-mismatch");
  if (lineMatches && Math.abs(officialLine) < HHAD_COMPANION_SHADOW_POLICY.thresholds.minimumAbsoluteHandicapLine) {
    blockers.push("handicap-magnitude-below-threshold");
  }
  if (!odds) blockers.push("incomplete-or-invalid-official-odds");
  if (!modelProbabilities) blockers.push("incomplete-or-invalid-model-probabilities");

  const cutoffMillis = cutoffTime ? Date.parse(cutoffTime) : null;
  for (const [label, instant] of [["captured", capturedAt], ["received", receivedAt], ["observed", observedAt]]) {
    if (cutoffMillis !== null && instant && Date.parse(instant) > cutoffMillis) blockers.push(`${label}-after-cutoff`);
  }
  for (const [label, instant] of [
    ["model-generated", modelGeneratedAt],
    ["unified-posterior-generated", unifiedPosteriorGeneratedAt],
    ["decision", decisionAt],
    ["feature-snapshot-captured", featureSnapshotCapturedAt],
  ]) {
    if (cutoffMillis !== null && instant && Date.parse(instant) > cutoffMillis) blockers.push(`${label}-after-cutoff`);
  }

  if (modelTop && modelTop.probability < HHAD_COMPANION_SHADOW_POLICY.thresholds.minimumModelProbability) {
    blockers.push("model-probability-below-threshold");
  }
  if (modelTop && modelTop.gap < HHAD_COMPANION_SHADOW_POLICY.thresholds.minimumModelGap) {
    blockers.push("model-gap-below-threshold");
  }
  if (modelTop && marketTop && modelTop.code !== marketTop.code) blockers.push("model-market-leader-misaligned");
  if (marketSupport !== null && marketSupport < HHAD_COMPANION_SHADOW_POLICY.thresholds.minimumMarketSupport) {
    blockers.push("market-support-below-threshold");
  }
  if (selectedOdds !== null && (!Number.isFinite(selectedOdds) || selectedOdds <= 1)) blockers.push("invalid-selected-sp");

  const uniqueBlockers = unique(blockers);
  const action = uniqueBlockers.length === 0 ? "EVALUATE" : "SKIP";
  const best = normalizedBest(input);
  const bestDiagnostic = best && selectedCode ? {
    ...best,
    sameOutcomeCode: best.code === selectedCode,
    samePool: best.poolCode === "HHAD",
    exactMatch: best.poolCode === "HHAD" && best.code === selectedCode && best.handicapLine === officialLine,
    conflict: best.code !== selectedCode,
  } : best ? { ...best, sameOutcomeCode: null, samePool: best.poolCode === "HHAD", exactMatch: false, conflict: null } : null;

  const frozenSelection = selectedCode ? {
    poolCode: "HHAD",
    code: selectedCode,
    outcome: outcomeName(selectedCode),
    handicapLine: lineMatches ? officialLine : null,
    handicapLineText: lineMatches ? formatHandicapLine(officialLine) : null,
    odds: selectedOdds,
    modelProbability: modelTop.probability,
    modelGap: modelTop.gap,
    marketProbability: marketSupport,
  } : null;

  const revisionPayload = {
    strategyHash: STRATEGY_HASH,
    matchKey,
    cutoffTime,
    sourceTimes: {
      capturedAt,
      receivedAt,
      observedAt,
      modelGeneratedAt,
      unifiedPosteriorGeneratedAt,
      decisionAt,
      featureSnapshotCapturedAt,
    },
    sourceRevision: input.sourceRevision || null,
    sourceSnapshotHash: input.sourceSnapshotHash || input.featureSnapshotHash || null,
    modelVersion: input.modelVersion || input.model?.version || null,
    officialHandicapLine: officialLine,
    modelHandicapLine: modelLine,
    odds,
    modelProbabilities,
  };
  const revisionHash = canonicalHash("hhad-companion-shadow/revision", revisionPayload);
  const cohortHash = canonicalHash("hhad-companion-shadow/cohort", {
    strategyHash: STRATEGY_HASH,
    poolCode: "HHAD",
    handicapLine: lineMatches ? officialLine : null,
    code: selectedCode,
  });
  const exposureHash = canonicalHash("hhad-companion-shadow/exposure", {
    strategyHash: STRATEGY_HASH,
    revisionHash,
    cohortHash,
    matchKey,
    cutoffTime,
    action,
    blockers: uniqueBlockers,
    selection: frozenSelection,
  });
  const pairHash = canonicalHash("hhad-companion-shadow/pair", {
    exposureHash,
    publicBest: best,
  });

  return {
    strategy: HHAD_COMPANION_SHADOW_STRATEGY,
    version: HHAD_COMPANION_SHADOW_VERSION,
    action,
    eligible: action === "EVALUATE",
    blockers: uniqueBlockers,
    matchKey,
    cutoffTime,
    sourceTimes: {
      capturedAt,
      receivedAt,
      observedAt,
      modelGeneratedAt,
      unifiedPosteriorGeneratedAt,
      decisionAt,
      featureSnapshotCapturedAt,
    },
    market: {
      poolCode: "HHAD",
      officialHandicapLine: officialLine,
      modelHandicapLine: modelLine,
      exactLineMatch: lineMatches,
      odds,
      probabilities: marketProbabilities,
      top: marketTop,
    },
    model: {
      probabilities: modelProbabilities,
      top: modelTop,
    },
    selection: frozenSelection,
    diagnostics: {
      best: bestDiagnostic,
      bestConflictIsBlocker: false,
      usedMarketFallback: false,
    },
    strategyHash: STRATEGY_HASH,
    cohortHash,
    revisionHash,
    exposureHash,
    pairHash,
    hashes: { strategyHash: STRATEGY_HASH, cohortHash, revisionHash, exposureHash, pairHash },
  };
};

const VOID_STATUSES = new Set(["VOID", "CANCELLED", "CANCELED", "ABANDONED"]);

const settleHhadCompanionShadow = (exposure, result = {}) => {
  const exposureHash = String(exposure?.exposureHash || exposure?.hashes?.exposureHash || "") || null;
  const pairHash = String(exposure?.pairHash || exposure?.hashes?.pairHash || "") || null;
  const frozen = exposure?.selection || null;
  const resultStatus = String(result.status || result.matchStatus || "").trim().toUpperCase();
  const scoreHome = finiteNumber(result.scoreHome ?? result.home);
  const scoreAway = finiteNumber(result.scoreAway ?? result.away);
  const voided = result.voided === true || VOID_STATUSES.has(resultStatus);

  let status = "UNSETTLED";
  let reason = null;
  let actualCode = null;
  if (voided) {
    status = "VOID";
  } else if (exposure?.action !== "EVALUATE" || !frozen) {
    reason = "shadow-not-evaluated";
  } else if (!OUTCOME_CODES.includes(frozen.code)
    || parseHandicapLine(frozen.handicapLine) === null
    || finiteNumber(frozen.odds) === null
    || Number(frozen.odds) <= 1) {
    reason = "invalid-frozen-exposure";
  } else if (scoreHome === null || scoreAway === null
    || scoreHome < 0 || scoreAway < 0
    || !Number.isInteger(scoreHome) || !Number.isInteger(scoreAway)) {
    reason = "final-score-unavailable";
  } else {
    const adjustedHome = scoreHome + Number(frozen.handicapLine);
    actualCode = adjustedHome > scoreAway ? "1" : adjustedHome < scoreAway ? "2" : "X";
    status = actualCode === frozen.code ? "WON" : "LOST";
  }

  const odds = finiteNumber(frozen?.odds);
  const profitUnits = status === "WON"
    ? rounded(odds - 1, 3)
    : status === "LOST"
      ? -1
      : status === "VOID"
        ? 0
        : null;
  const settlementPayload = {
    exposureHash,
    status,
    reason,
    scoreHome,
    scoreAway,
    actualCode,
    frozenCode: frozen?.code || null,
    frozenHandicapLine: parseHandicapLine(frozen?.handicapLine),
    frozenOdds: odds,
    profitUnits,
  };
  const settlementHash = canonicalHash("hhad-companion-shadow/settlement", settlementPayload);
  const exposureSettlementPairHash = canonicalHash("hhad-companion-shadow/exposure-settlement-pair", {
    exposureHash,
    settlementHash,
  });

  return {
    strategy: HHAD_COMPANION_SHADOW_STRATEGY,
    version: HHAD_COMPANION_SHADOW_VERSION,
    status,
    reason,
    outcomeCode: actualCode,
    score: scoreHome !== null && scoreAway !== null ? { home: scoreHome, away: scoreAway } : null,
    frozen: frozen ? {
      poolCode: "HHAD",
      code: frozen.code || null,
      handicapLine: parseHandicapLine(frozen.handicapLine),
      odds,
    } : null,
    profitUnits,
    exposureHash,
    pairHash,
    settlementHash,
    exposureSettlementPairHash,
  };
};

module.exports = {
  HHAD_COMPANION_SHADOW_POLICY,
  HHAD_COMPANION_SHADOW_STRATEGY,
  HHAD_COMPANION_SHADOW_VERSION,
  STRATEGY_HASH,
  canonicalHash,
  canonicalStringify,
  devigProbabilities,
  evaluateHhadCompanionShadow,
  formatHandicapLine,
  normalizeOddsTriplet,
  normalizeProbabilityTriplet,
  parseHandicapLine,
  settleHhadCompanionShadow,
};
