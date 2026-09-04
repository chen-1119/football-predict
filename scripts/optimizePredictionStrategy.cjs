const fs = require("fs");
const path = require("path");
const {
  isOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");
const {
  buildPublicationLedgerIndex,
  loadPublicationLedger,
  resolvePublishedRecommendation,
} = require("../src/services/recommendationPublicationLedger.cjs");
const {
  walkForwardPromotionState,
} = require("./walkForwardValidation.cjs");
const {
  buildCandidateFromEvaluation,
  buildLearningEvidenceFromEvaluation,
  sha256,
  stableStringify,
  validateLearningRegistry,
} = require("./modelLearningRegistry.cjs");
const {
  validatePromotionEvidenceManifest,
} = require("../src/services/promotionEvidenceManifest.cjs");
const {
  FEATURE_SCHEMA_VERSION: RESIDUAL_MARKET_FEATURE_SCHEMA_VERSION,
} = require("./residualMarketModel.cjs");
const {
  verifyManifestHash: verifyResidualMarketManifestHash,
} = require("./residualMarketWalkForward.cjs");

const VERSION = "self-optimization-v9-formal-ledger";
const ENABLED_MARKETS = new Set(["1X2", "HHAD", "GOALS", "BEST"]);
const PROFILE_KEYS = ["international", "japan", "other"];

const MIN_RULE_ROWS = 12;
const MIN_PROFILE_ROWS = 20;
const MIN_LOOSEN_ROWS = 100;
const MIN_LOOSEN_MATCH_DAYS = 4;
const MIN_REFERENCE_SHADOW_ROWS = 50;
const MIN_REFERENCE_SHADOW_MATCH_DAYS = 4;
const MAX_DETAIL_BOOST = 0.06;
const DEFAULT_PROMOTION_THRESHOLDS = Object.freeze({
  minBaselineRows: 500,
  minLogLossImprovement: 0,
  minBrierImprovement: 0,
  minRollingPassRate: 0.6,
  minRollingWindows: 6,
  minPromotionEvidenceRows: 500,
});

function readPromotionThresholds(env = process.env) {
  const invalidNames = [];
  const read = (name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    if (!Object.prototype.hasOwnProperty.call(env, name)) return fallback;
    const raw = env[name];
    const parsed = typeof raw === "string" && raw.trim() === "" ? NaN : Number(raw);
    const valid = Number.isFinite(parsed)
      && (!integer || Number.isInteger(parsed))
      && parsed >= min
      && parsed <= max;
    if (!valid) {
      invalidNames.push(name);
      return fallback;
    }
    return parsed;
  };

  const values = {
    minBaselineRows: read(
      "MODEL_PROMOTION_MIN_BASELINE_ROWS",
      DEFAULT_PROMOTION_THRESHOLDS.minBaselineRows,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minBaselineRows, integer: true }
    ),
    minLogLossImprovement: read(
      "MODEL_PROMOTION_MIN_LOG_LOSS_IMPROVEMENT",
      DEFAULT_PROMOTION_THRESHOLDS.minLogLossImprovement,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minLogLossImprovement }
    ),
    minBrierImprovement: read(
      "MODEL_PROMOTION_MIN_BRIER_IMPROVEMENT",
      DEFAULT_PROMOTION_THRESHOLDS.minBrierImprovement,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minBrierImprovement }
    ),
    minRollingPassRate: read(
      "MODEL_PROMOTION_MIN_ROLLING_PASS_RATE",
      DEFAULT_PROMOTION_THRESHOLDS.minRollingPassRate,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minRollingPassRate, max: 1 }
    ),
    minRollingWindows: read(
      "MODEL_PROMOTION_MIN_ROLLING_WINDOWS",
      DEFAULT_PROMOTION_THRESHOLDS.minRollingWindows,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minRollingWindows, integer: true }
    ),
    minPromotionEvidenceRows: read(
      "MODEL_PROMOTION_MIN_EVIDENCE_ROWS",
      DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows,
      { min: DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows, integer: true }
    ),
  };

  return {
    valid: invalidNames.length === 0,
    invalidNames,
    values,
  };
}

const PROMOTION_THRESHOLD_CONFIG = readPromotionThresholds(process.env);
const PRODUCTION_MIN_ROWS_PER_MARKET = 100;
const PRODUCTION_MARKET_VALIDATION_STATUS = "validated";
const MODEL_RISK_TIER_RANK = { stable: 0, watch: 1, degraded: 2 };
const MODEL_LEARNING_CANDIDATE_TYPES = Object.freeze(["market-residual-shadow"]);
const MODEL_LEARNING_FEATURE_SCHEMA_VERSION = RESIDUAL_MARKET_FEATURE_SCHEMA_VERSION;
const MODEL_LEARNING_POLICY_VERSION = "multi-factor-market-evidence-v2";

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const publicationLedgerFile = path.resolve(
  process.env.RECOMMENDATION_PUBLICATION_LEDGER_PATH
  || path.join(serverDataDir, "recommendation-publication-ledger.json")
);
const outputFiles = [...new Set([
  path.join(publicDataDir, "model-strategy.json"),
  path.join(serverDataDir, "model-strategy.json"),
])];
const evaluationFile = path.join(publicDataDir, "model-evaluation.json");

function modelLearningCandidateContract(options = {}) {
  const inferenceFile = path.resolve(options.inferenceFile || path.join(__dirname, "residualMarketModel.cjs"));
  let inferenceImplementationHash = null;
  try {
    inferenceImplementationHash = sha256(fs.readFileSync(inferenceFile));
  } catch {
    inferenceImplementationHash = null;
  }
  return {
    inferenceImplementationHash,
    featureSchemaVersion: options.featureSchemaVersion || MODEL_LEARNING_FEATURE_SCHEMA_VERSION,
    policyVersion: options.policyVersion || MODEL_LEARNING_POLICY_VERSION,
  };
}

function promotionEvidenceStateFromEvaluation(evaluation, minimumRows = DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows) {
  const audit = evaluation?.promotionEvidenceAudit || null;
  const manifest = audit?.manifest || null;
  const records = audit?.records;
  const requiredRows = Number.isSafeInteger(Number(minimumRows))
    ? Math.max(DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows, Number(minimumRows))
    : DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows;
  const blockers = [];
  let validation = { valid: false, promotionEligible: false, errors: ["manifest-not-validated"] };

  if (!manifest || typeof manifest !== "object") blockers.push("promotion-evidence-manifest-missing");
  if (!Array.isArray(records)) blockers.push("promotion-evidence-records-missing");
  if (manifest && typeof manifest === "object" && Array.isArray(records)) {
    validation = validatePromotionEvidenceManifest(manifest, records);
    if (!validation.valid) blockers.push("promotion-evidence-manifest-invalid");
    if (validation.errors.some((error) => error === "manifest-hash-invalid" || error === "manifest-hash-mismatch")) {
      blockers.push("promotion-evidence-manifest-hash-invalid");
    }
  }

  const eligibleRows = finiteMetric(manifest?.eligibleRows);
  const conflictingDuplicateKeys = finiteMetric(manifest?.conflictingDuplicateKeys);
  if (manifest?.promotionEligible !== true || validation.promotionEligible !== true) {
    blockers.push("promotion-evidence-ineligible");
  }
  if (!Number.isSafeInteger(eligibleRows) || eligibleRows < requiredRows) {
    blockers.push(`promotion-evidence-rows:${Number.isSafeInteger(eligibleRows) ? eligibleRows : "missing"}<${requiredRows}`);
  }
  if (!Number.isSafeInteger(conflictingDuplicateKeys) || conflictingDuplicateKeys !== 0) {
    blockers.push(`promotion-evidence-conflicts:${Number.isSafeInteger(conflictingDuplicateKeys) ? conflictingDuplicateKeys : "missing"}!=0`);
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  return {
    version: "promotion-evidence-gate-v1",
    eligible: uniqueBlockers.length === 0,
    requiredRows,
    eligibleRows: Number.isSafeInteger(eligibleRows) ? eligibleRows : null,
    conflictingDuplicateKeys: Number.isSafeInteger(conflictingDuplicateKeys) ? conflictingDuplicateKeys : null,
    manifestHash: manifest?.manifestHash || null,
    manifestValid: validation.valid === true,
    decisionClockRecordsVerified: validation.valid === true && Array.isArray(records),
    validationErrors: Array.isArray(validation.errors) ? validation.errors : [],
    blockers: uniqueBlockers,
  };
}

function modelLearningActivationAuthorityFromRegistry(evaluation, registry, options = {}) {
  const blockers = [];
  const registryValidation = validateLearningRegistry(registry);
  const candidateContract = options.candidateContract || modelLearningCandidateContract(options);
  const supportedCandidateTypes = Array.isArray(options.supportedCandidateTypes)
    ? options.supportedCandidateTypes
    : MODEL_LEARNING_CANDIDATE_TYPES;
  let candidate = null;
  let evidenceHash = null;

  if (!registryValidation.valid) blockers.push("model-learning-registry-invalid");
  if (!candidateContract.inferenceImplementationHash) blockers.push("model-learning-inference-hash-unavailable");
  try {
    candidate = buildCandidateFromEvaluation(evaluation || {}, candidateContract);
  } catch {
    blockers.push("model-learning-candidate-unbuildable");
  }
  try {
    const evidence = buildLearningEvidenceFromEvaluation(evaluation || {}, candidateContract);
    evidenceHash = sha256(stableStringify(evidence));
  } catch {
    blockers.push("model-learning-evidence-unbuildable");
  }

  if (candidate?.validationBlockers?.length) blockers.push("model-learning-candidate-invalid");
  if (candidate && !supportedCandidateTypes.includes(candidate.candidateType)) {
    blockers.push(`model-learning-candidate-type-unsupported:${candidate.candidateType || "missing"}`);
  }
  const residualFinalCandidate = evaluation?.residualMarketWalkForward?.finalCandidate || null;
  const candidateApplies = Boolean(candidate && residualFinalCandidate)
    && candidate.candidateId === residualFinalCandidate.candidateId
    && candidate.candidateType === residualFinalCandidate.candidateType
    && candidate.modelHash === residualFinalCandidate.modelHash
    && candidate.trainingDataHash === residualFinalCandidate.dataHash
    && candidate.parametersHash === residualFinalCandidate.parametersHash
    && candidate.featureSchemaHash === residualFinalCandidate.featureSchemaHash
    && candidate.trainedThrough === residualFinalCandidate.trainedThrough;
  if (!candidateApplies) blockers.push("model-learning-candidate-not-applicable");

  const championArtifactHash = registry?.championArtifactHash || null;
  if (!championArtifactHash) blockers.push("model-learning-champion-missing");
  const championMatchesCandidate = Boolean(candidate?.artifactHash)
    && championArtifactHash === candidate.artifactHash;
  if (championArtifactHash && candidate?.artifactHash && !championMatchesCandidate) {
    blockers.push("model-learning-champion-mismatch");
  }
  const championArtifactPresent = Boolean(championArtifactHash)
    && Array.isArray(registry?.artifacts)
    && registry.artifacts.some((artifact) => artifact?.artifactHash === championArtifactHash);
  if (championArtifactHash && !championArtifactPresent) blockers.push("model-learning-champion-artifact-missing");

  const relevantEntries = Array.isArray(registry?.entries) && candidate?.artifactHash
    ? registry.entries.filter((entry) => entry?.candidateArtifactHash === candidate.artifactHash)
    : [];
  const lastRelevantEvent = relevantEntries[relevantEntries.length - 1] || null;
  const lastRelevantEventValid = lastRelevantEvent?.type === "candidate-evaluation"
    && lastRelevantEvent?.status === "promoted"
    && lastRelevantEvent?.nextChampionArtifactHash === candidate?.artifactHash
    && Array.isArray(lastRelevantEvent?.blockers)
    && lastRelevantEvent.blockers.length === 0;
  if (!lastRelevantEvent) blockers.push("model-learning-promotion-event-missing");
  else if (!lastRelevantEventValid) blockers.push("model-learning-last-event-not-promoted");
  const evidenceHashMatches = Boolean(evidenceHash)
    && lastRelevantEvent?.evidenceHash === evidenceHash;
  if (lastRelevantEvent && !evidenceHashMatches) blockers.push("model-learning-promotion-evidence-mismatch");

  const uniqueBlockers = Array.from(new Set(blockers));
  return {
    version: "model-learning-activation-authority-v1",
    eligible: uniqueBlockers.length === 0,
    registryValid: registryValidation.valid === true,
    registryErrors: registryValidation.errors || [],
    registryHash: registry?.registryHash || null,
    championArtifactHash,
    candidateArtifactHash: candidate?.artifactHash || null,
    candidateIdentity: candidate ? {
      candidateId: candidate.candidateId || null,
      candidateType: candidate.candidateType || null,
      artifactHash: candidate.artifactHash || null,
      modelHash: candidate.modelHash || null,
      trainingDataHash: candidate.trainingDataHash || null,
      parametersHash: candidate.parametersHash || null,
      featureSchemaHash: candidate.featureSchemaHash || null,
      metricsManifestHash: candidate.metricsManifestHash || null,
      trainedThrough: candidate.trainedThrough || null,
    } : null,
    candidateType: candidate?.candidateType || null,
    candidateValidationBlockers: candidate?.validationBlockers || [],
    candidateApplies,
    championMatchesCandidate,
    championArtifactPresent,
    evidenceHash,
    evidenceHashMatches,
    lastRelevantEventValid,
    lastRelevantEvent: lastRelevantEvent ? {
      sequence: lastRelevantEvent.sequence,
      type: lastRelevantEvent.type,
      status: lastRelevantEvent.status,
      at: lastRelevantEvent.at,
      entryHash: lastRelevantEvent.entryHash,
      evidenceHash: lastRelevantEvent.evidenceHash,
    } : null,
    supportedCandidateTypes,
    blockers: uniqueBlockers,
  };
}

function loadModelLearningActivationAuthority(evaluation, registryFile, options = {}) {
  const resolvedFile = path.resolve(
    registryFile
      || process.env.MODEL_LEARNING_REGISTRY_FILE
      || path.join(serverDataDir, "model-artifacts", "model-learning-registry.json")
  );
  if (!fs.existsSync(resolvedFile)) {
    return {
      version: "model-learning-activation-authority-v1",
      eligible: false,
      registryFile: resolvedFile,
      registryValid: false,
      registryErrors: ["registry-file-missing"],
      blockers: ["model-learning-registry-missing"],
    };
  }
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(resolvedFile, "utf8"));
  } catch {
    return {
      version: "model-learning-activation-authority-v1",
      eligible: false,
      registryFile: resolvedFile,
      registryValid: false,
      registryErrors: ["registry-file-invalid-json"],
      blockers: ["model-learning-registry-invalid"],
    };
  }
  return {
    ...modelLearningActivationAuthorityFromRegistry(evaluation, registry, options),
    registryFile: resolvedFile,
  };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isEmbeddedReferenceTighteningStrategy(strategy) {
  return strategy?.activation?.onlineEffect === "tighten-only-reference-shadow"
    && strategy?.activation?.promotionAllowed === false
    && strategy?.activation?.looseningAllowed === false;
}

function stripShadowStrategyFromMutableMatch(match) {
  if (!match || typeof match !== "object") return { match, changed: false };

  // Locked rows are immutable prediction records. Their strategyVersion is
  // provenance, not an active online strategy, and must remain auditable.
  if (match?.predictionMeta?.lockedAt || ["LIVE", "FINISHED"].includes(String(match?.status || "").toUpperCase())) {
    return { match, changed: false };
  }

  let changed = false;
  let probabilityModel = match.probabilityModel;
  if (probabilityModel && typeof probabilityModel === "object") {
    let nextProbabilityModel = probabilityModel;
    if (
      Object.prototype.hasOwnProperty.call(probabilityModel, "strategy")
      && !isEmbeddedReferenceTighteningStrategy(probabilityModel.strategy)
    ) {
      const { strategy: staleLegacyStrategy, ...withoutLegacyStrategy } = nextProbabilityModel;
      void staleLegacyStrategy;
      nextProbabilityModel = withoutLegacyStrategy;
      changed = true;
    }
    if (
      nextProbabilityModel.dynamicCalibration
      && typeof nextProbabilityModel.dynamicCalibration === "object"
      && Object.prototype.hasOwnProperty.call(nextProbabilityModel.dynamicCalibration, "strategy")
      && !isEmbeddedReferenceTighteningStrategy(nextProbabilityModel.dynamicCalibration.strategy)
    ) {
      const { strategy: staleDynamicStrategy, ...withoutDynamicStrategy } = nextProbabilityModel.dynamicCalibration;
      void staleDynamicStrategy;
      nextProbabilityModel = {
        ...nextProbabilityModel,
        dynamicCalibration: withoutDynamicStrategy,
      };
      changed = true;
    }
    probabilityModel = nextProbabilityModel;
  }

  let predictionMeta = match.predictionMeta;
  const retainedReferenceStrategy = isEmbeddedReferenceTighteningStrategy(probabilityModel?.strategy)
    || isEmbeddedReferenceTighteningStrategy(probabilityModel?.dynamicCalibration?.strategy);
  if (predictionMeta && predictionMeta.strategyVersion && predictionMeta.strategyVersion !== "none" && !retainedReferenceStrategy) {
    predictionMeta = {
      ...predictionMeta,
      strategyVersion: "none",
    };
    changed = true;
  }

  return changed ? {
    changed: true,
    match: {
      ...match,
      ...(probabilityModel ? { probabilityModel } : {}),
      ...(predictionMeta ? { predictionMeta } : {}),
    },
  } : { match, changed: false };
}

function removeEmbeddedStrategy(calibration) {
  if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) {
    return { payload: calibration, changed: false };
  }

  let next = calibration;
  let changed = false;
  if (
    Object.prototype.hasOwnProperty.call(next, "strategy")
    && !isEmbeddedReferenceTighteningStrategy(next.strategy)
  ) {
    const { strategy: staleStrategy, ...withoutStrategy } = next;
    void staleStrategy;
    next = withoutStrategy;
    changed = true;
  }
  if (
    next.dynamicCalibration
    && typeof next.dynamicCalibration === "object"
    && Object.prototype.hasOwnProperty.call(next.dynamicCalibration, "strategy")
    && !isEmbeddedReferenceTighteningStrategy(next.dynamicCalibration.strategy)
  ) {
    const { strategy: staleDynamicStrategy, ...withoutDynamicStrategy } = next.dynamicCalibration;
    void staleDynamicStrategy;
    next = {
      ...next,
      dynamicCalibration: withoutDynamicStrategy,
    };
    changed = true;
  }
  return { payload: next, changed };
}

function reconcileShadowStrategyArtifacts(strategy) {
  const syncMetaFile = path.join(publicDataDir, "sync-meta.json");
  const syncMeta = readJson(syncMetaFile, null);
  const strategyMeta = strategy && typeof strategy === "object" ? {
    version: strategy.version || null,
    generatedAt: strategy.generatedAt || null,
    activation: strategy.activation || null,
    sample: strategy.sample || {},
    activeGates: strategy.activeGates || {},
  } : null;
  let syncMetaUpdated = false;
  if (syncMeta && typeof syncMeta === "object" && !Array.isArray(syncMeta)) {
    const currentStrategyMeta = syncMeta.modelStrategy || null;
    if (JSON.stringify(currentStrategyMeta) !== JSON.stringify(strategyMeta)) {
      writeJson(syncMetaFile, { ...syncMeta, modelStrategy: strategyMeta });
      syncMetaUpdated = true;
    }
  }

  if (strategy?.activation?.onlineEffect !== "shadow") {
    return {
      applied: false,
      reason: "strategy-not-shadow",
      mutableMatchesCleared: 0,
      calibrationCleared: false,
      syncMetaUpdated,
    };
  }

  const calibrationFile = path.join(publicDataDir, "model-calibration.json");
  const calibration = readJson(calibrationFile, null);
  const reconciledCalibration = removeEmbeddedStrategy(calibration);
  if (reconciledCalibration.changed) writeJson(calibrationFile, reconciledCalibration.payload);

  const currentFile = path.join(publicDataDir, "matches-current.json");
  const currentPayload = readJson(currentFile, []);
  const currentMatches = Array.isArray(currentPayload)
    ? currentPayload
    : (Array.isArray(currentPayload?.matches) ? currentPayload.matches : []);
  let mutableMatchesCleared = 0;
  const reconciledMatches = currentMatches.map((match) => {
    const reconciled = stripShadowStrategyFromMutableMatch(match);
    if (reconciled.changed) mutableMatchesCleared += 1;
    return reconciled.match;
  });
  if (mutableMatchesCleared > 0) {
    writeJson(currentFile, Array.isArray(currentPayload)
      ? reconciledMatches
      : { ...currentPayload, matches: reconciledMatches });
  }

  return {
    applied: true,
    reason: "shadow-strategy-fail-closed",
    mutableMatchesCleared,
    calibrationCleared: reconciledCalibration.changed,
    syncMetaUpdated,
  };
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function matchDayKey(value) {
  const text = normText(value);
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function independentMatchDays(rows) {
  return new Set((rows || []).map((row) => matchDayKey(row?.matchDay || row?.kickoffTime)).filter(Boolean)).size;
}

function profileKey(match) {
  const text = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.leagueShortName,
    match?.countryName,
    match?.countryNameEn,
    match?.homeTeamName,
    match?.homeTeamNameEn,
    match?.awayTeamName,
    match?.awayTeamNameEn,
  ].filter(Boolean).join(" ");
  if (/(\u65e5\u804c|\u65e5\u8054|\u65e5\u672c|j1|j2|japan)/i.test(text)) return "japan";
  if (/(\u56fd\u9645|\u53cb\u8c0a|\u4e16\u754c\u676f|\u4e16\u9884|\u56fd\u5bb6|international|friendly|world cup|qualifier|fifa)/i.test(text)) return "international";
  return "other";
}

function finiteDecimalOdds(value) {
  const odds = Number(value);
  return Number.isFinite(odds) && odds > 1 ? odds : 0;
}

function normalizeTipCodeForOdds(code) {
  const value = normText(code).toUpperCase();
  if (["1", "H", "HOME", "WIN"].includes(value)) return "1";
  if (["X", "D", "DRAW"].includes(value)) return "X";
  if (["2", "A", "AWAY", "LOSE"].includes(value)) return "2";
  return value;
}

function oddsBucket(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 1) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
}

function marketType(prediction) {
  const role = normText(prediction?.marketType).toUpperCase();
  const pool = normText(prediction?.oddsPoolCode).toUpperCase();
  const code = normText(prediction?.tipCode).toUpperCase();
  if (["1", "X", "2"].includes(code)) {
    if (pool === "HHAD" || role === "HHAD") return "HHAD";
    if (pool === "HAD" || role === "1X2") return "1X2";
  }
  return role;
}

function matchKey(match) {
  return normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
}

function matchIdentity(match) {
  return matchKey(match) || [
    match?.kickoffTime,
    match?.homeTeamName || match?.homeTeamNameEn || match?.homeTeamId,
    match?.awayTeamName || match?.awayTeamNameEn || match?.awayTeamId,
  ].filter(Boolean).join("|");
}

function matchQuality(match) {
  let score = 0;
  if (match?.status === "FINISHED") score += 40;
  if (Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway)) score += 30;
  if (match?.predictionMeta?.lockedAt) score += 8;
  if (Array.isArray(match?.predictions) && match.predictions.length) score += 6;
  if (match?.probabilityModel?.scoreDistribution?.length) score += 4;
  if (match?.odds || match?.handicapOdds) score += 2;
  return score;
}

function dedupeMatches(matches) {
  const byId = new Map();
  for (const match of matches || []) {
    const key = normText(matchIdentity(match));
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || matchQuality(match) >= matchQuality(previous)) {
      byId.set(key, match);
    }
  }
  return [...byId.values()];
}

function probabilityForTip(match, prediction, resolvedMarket = marketType(prediction)) {
  // Raw oneXTwo probabilities describe HAD only. Reusing them for HHAD would
  // silently calibrate a handicap decision against the wrong target variable.
  if (resolvedMarket !== "1X2") return null;
  const oneXTwo = match?.probabilityModel?.oneXTwo?.final || match?.probabilityFinal;
  if (!oneXTwo) return null;
  if (prediction.tipCode === "1") return Number(oneXTwo.home) / 100;
  if (prediction.tipCode === "X") return Number(oneXTwo.draw) / 100;
  if (prediction.tipCode === "2") return Number(oneXTwo.away) / 100;
  return null;
}

function oddsFromBoard(board, tipCode) {
  const code = normalizeTipCodeForOdds(tipCode);
  const odds = code === "1"
    ? Number(board?.odds1 ?? board?.home ?? board?.h)
    : code === "X"
      ? Number(board?.oddsX ?? board?.draw ?? board?.d)
      : code === "2"
        ? Number(board?.odds2 ?? board?.away ?? board?.a)
        : NaN;
  return finiteDecimalOdds(odds);
}

function oddsForPrediction(match, prediction, resolvedMarket) {
  const direct = finiteDecimalOdds(prediction?.odds || prediction?.sp || prediction?.recommendedOdds || prediction?.decimalOdds);
  if (direct) return direct;
  if (resolvedMarket === "HHAD" || prediction?.oddsPoolCode === "HHAD") {
    return oddsFromBoard(match?.handicapOdds, prediction?.tipCode);
  }
  if (resolvedMarket === "1X2" || resolvedMarket === "BEST" || prediction?.oddsPoolCode === "HAD") {
    return oddsFromBoard(match?.odds, prediction?.tipCode);
  }
  return 0;
}

function completeOfficialBoard(match, prediction) {
  const board = prediction?.oddsPoolCode === "HHAD" ? match?.handicapOdds : match?.odds;
  return ["1", "X", "2"].every((code) => oddsFromBoard(board, code) > 1) ? board : null;
}

function predictionRows(matches, snapshots = [], options = {}) {
  const rowsByKey = new Map();
  const requireVerifiedPublication = options.requireVerifiedPublication !== false;
  const publicationIndex = options.publicationIndex || null;
  const addRow = (match, prediction, options = {}) => {
    if (!prediction || prediction.tipCode === "WATCH") return;
    if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") return;
    const market = options.marketType || marketType(prediction);
    if (!ENABLED_MARKETS.has(market)) return;
    if (!completeOfficialBoard(match, prediction)) return;
    const odds = oddsForPrediction(match, prediction, market);
    const officialHandicapLine = prediction.oddsPoolCode === "HHAD"
      ? (prediction.handicapLine ?? match?.handicapLine)
      : 0;
    if (!isOfficialRecommendationEligible(prediction, odds, officialHandicapLine)) return;
    const publicationRecord = resolvePublishedRecommendation(match, prediction, publicationIndex);
    if (requireVerifiedPublication && !publicationRecord) return;
    const sourceMatchId = matchKey(match);
    const key = [
      sourceMatchId || matchIdentity(match),
      market,
      prediction.oddsPoolCode || options.oddsPoolCode || "",
      match?.handicapLine || "",
      prediction.tipCode,
      prediction.resultStatus,
    ].join("|");
    const row = {
      sourceMatchId,
      kickoffTime: match.kickoffTime || "",
      matchDay: matchDayKey(match.kickoffDate || match.matchDate || match.businessDate || match.kickoffTime),
      league: match.leagueName || match.leagueNameEn || match.leagueId || "",
      profileKey: profileKey(match),
      marketType: market,
      roleMarketType: normText(prediction.marketType).toUpperCase(),
      oddsPoolCode: normText(prediction.oddsPoolCode).toUpperCase(),
      tipCode: prediction.tipCode,
      odds,
      oddsBucket: oddsBucket(odds),
      trustScore: Number(prediction.trustScore || 0),
      resultStatus: prediction.resultStatus,
      policyVersion: match.predictionMeta?.policyVersion || match.policyVersion || "unknown",
      // The v1 publication ledger freezes direction, SP and evidence hashes,
      // but it does not yet contain an immutable probability vector. Never
      // join a later mutable probabilityModel into formal Brier/log-loss.
      probability: requireVerifiedPublication ? null : probabilityForTip(match, prediction, market),
      source: options.source || "match",
      publicationId: publicationRecord?.publicationId || null,
    };
    const previous = rowsByKey.get(key);
    if (
      !previous
      || (Number(row.odds) > 1 && !(Number(previous.odds) > 1))
      || (Number(row.trustScore || 0) > Number(previous.trustScore || 0) && Number(row.odds || 0) >= Number(previous.odds || 0))
    ) {
      rowsByKey.set(key, row);
    }
  };

  for (const match of matches || []) {
    if (match?.status !== "FINISHED") continue;
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;

    for (const prediction of match.predictions || []) {
      addRow(match, prediction, { source: "match.predictions" });
    }
  }

  // Post-match review rows and review snapshots are intentionally excluded.
  // Only the locked pre-match prediction on the match record may enter strategy evidence.

  return [...rowsByKey.values()].sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));
}

function summarizeRows(rows) {
  const settled = rows.length;
  const won = rows.filter((row) => row.resultStatus === "WON").length;
  const lost = rows.filter((row) => row.resultStatus === "LOST").length;
  const oddsRows = rows.filter((row) => finiteDecimalOdds(row.odds));
  const stakeReturn = oddsRows.reduce((sum, row) => {
    if (row.resultStatus === "WON") return sum + Math.max(0, Number(row.odds || 0) - 1);
    if (row.resultStatus === "LOST") return sum - 1;
    return sum;
  }, 0);
  const probabilityRows = rows.filter((row) => Number.isFinite(row.probability));

  return {
    settled,
    won,
    lost,
    hitRate: settled ? round(won / settled) : null,
    roi: oddsRows.length ? round(stakeReturn / oddsRows.length) : null,
    avgOdds: oddsRows.length
      ? round(oddsRows.reduce((sum, row) => sum + Number(row.odds), 0) / oddsRows.length, 2)
      : null,
    oddsRows: oddsRows.length,
    missingOddsRows: settled - oddsRows.length,
    avgTrust: settled ? round(rows.reduce((sum, row) => sum + Number(row.trustScore || 0), 0) / settled, 1) : null,
    avgProbability: probabilityRows.length
      ? round(probabilityRows.reduce((sum, row) => sum + Number(row.probability), 0) / probabilityRows.length)
      : null,
    independentMatchDays: independentMatchDays(rows),
  };
}

function groupSummary(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .map(([key, group]) => [key, summarizeRows(group)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
}

function candidateUsesModelSignal(candidate) {
  const weights = candidate?.weights || {};
  const features = Array.isArray(candidate?.featureSet) ? candidate.featureSet : [];
  const modelWeight = Number(weights.model);
  return (Number.isFinite(modelWeight) && modelWeight !== 0)
    || Number(weights.historical || 0) > 0
    || Number(weights.elo || 0) > 0
    || Number(weights.poisson || 0) > 0
    || features.some((feature) => /historical|elo|poisson|model/i.test(String(feature)));
}

function residualModelSignalProjection(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  return {
    version: candidate.version || null,
    id: candidate.id || null,
    role: candidate.role || null,
    candidateType: candidate.candidateType || null,
    weights: candidate.weights || null,
    featureSet: Array.isArray(candidate.featureSet) ? candidate.featureSet : [],
    metrics: candidate.metrics || null,
    comparison: candidate.comparison || null,
    rolling: candidate.rolling || null,
    performanceManifestHash: candidate.performanceManifestHash || null,
    foldManifestHashes: Array.isArray(candidate.foldManifestHashes) ? candidate.foldManifestHashes : [],
    modelIdentity: candidate.modelIdentity || null,
  };
}

function buildResidualBoundModelSignalCandidate(evaluation, modelLearningAuthority) {
  const residual = evaluation?.residualMarketWalkForward || null;
  const finalCandidate = residual?.finalCandidate || null;
  const aggregate = residual?.aggregate || null;
  const folds = Array.isArray(residual?.folds) ? residual.folds : [];
  const identity = modelLearningAuthority?.candidateIdentity || null;
  if (!residual
      || residual.candidateReady !== true
      || !finalCandidate
      || finalCandidate.candidateReady !== true
      || (Array.isArray(residual.internalCandidateBlockers) && residual.internalCandidateBlockers.length > 0)
      || !verifyResidualMarketManifestHash(residual)
      || !identity
      || identity.candidateId !== finalCandidate.candidateId
      || identity.candidateType !== finalCandidate.candidateType
      || identity.modelHash !== finalCandidate.modelHash
      || identity.trainingDataHash !== finalCandidate.dataHash
      || identity.parametersHash !== finalCandidate.parametersHash
      || identity.featureSchemaHash !== finalCandidate.featureSchemaHash
      || identity.metricsManifestHash !== residual.manifestHash
      || identity.trainedThrough !== finalCandidate.trainedThrough
      || !aggregate
      || finiteMetric(aggregate.rows) <= 0
      || !aggregate.model
      || !aggregate.market
      || !aggregate.improvement
      || folds.length === 0
      || folds.some((fold) => !fold?.foldManifestHash || !fold?.metrics?.improvement)) {
    return null;
  }
  const improvingFolds = folds.filter((fold) => (
    finiteMetric(fold.metrics.improvement.brier) > 0
    && finiteMetric(fold.metrics.improvement.logLoss) > 0
  )).length;
  const body = {
    version: "residual-model-signal-candidate-v1",
    id: finalCandidate.candidateId,
    role: "shadow-model-candidate",
    candidateType: finalCandidate.candidateType,
    weights: { marketLogit: 1, residualLogitOffset: 1, temperature: 1 },
    featureSet: ["sporttery-market", "market-residual-model"],
    metrics: aggregate.model,
    comparison: {
      rows: aggregate.rows,
      logLossImprovement: aggregate.improvement.logLoss,
      brierImprovement: aggregate.improvement.brier,
      accuracyDelta: aggregate.improvement.accuracy,
      pairedByMatch: true,
    },
    rolling: {
      windows: folds.length,
      passRate: improvingFolds / folds.length,
      sufficientIndependentWindows: folds.every((fold) => (
        Array.isArray(fold.blockers)
        && fold.blockers.length === 0
        && fold.sampleGates?.completeHoldout === true
        && fold.sampleGates?.completePredictionCoverage === true
        && fold.sampleGates?.strictWatermark === true
      )),
    },
    performanceManifestHash: residual.manifestHash,
    foldManifestHashes: folds.map((fold) => fold.foldManifestHash),
    modelIdentity: identity,
  };
  return {
    ...body,
    candidateManifestHash: sha256(stableStringify(body)),
  };
}

function modelSignalIdentityMatchesAuthority(modelCandidate, expected) {
  const actualProjection = residualModelSignalProjection(modelCandidate);
  const declaredHash = modelCandidate?.candidateManifestHash || null;
  if (!actualProjection || !expected || typeof declaredHash !== "string") return false;
  const actualHash = sha256(stableStringify(actualProjection));
  return declaredHash === actualHash
    && declaredHash === expected.candidateManifestHash
    && stableStringify(actualProjection) === stableStringify(residualModelSignalProjection(expected));
}

function finiteMetric(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function productionMarketValidationReady(productionValidation, market) {
  const marketValidation = productionValidation?.perMarket?.[market] || null;
  const minimumRows = finiteMetric(marketValidation?.minimumRows);
  const sameSnapshotRows = finiteMetric(marketValidation?.sameSnapshotModelMarketRows);
  const exactReplayRows = finiteMetric(marketValidation?.exactReplayRows);
  return productionValidation?.validatedMarkets?.includes(market)
    && marketValidation?.status === PRODUCTION_MARKET_VALIDATION_STATUS
    && marketValidation?.productionPolicyReplay === true
    && Number.isFinite(minimumRows)
    && minimumRows >= PRODUCTION_MIN_ROWS_PER_MARKET
    && Number.isFinite(sameSnapshotRows)
    && sameSnapshotRows >= minimumRows
    && Number.isFinite(exactReplayRows)
    && exactReplayRows === sameSnapshotRows;
}

function calibratedMarketReferenceFor(shadowCandidates, modelCandidate) {
  if (!modelCandidate || !Array.isArray(shadowCandidates?.candidates)) return null;
  const targetTemperature = finiteMetric(modelCandidate?.weights?.temperature);
  const references = shadowCandidates.candidates.filter((candidate) => {
    if (candidateUsesModelSignal(candidate)) return false;
    const weights = candidate?.weights || {};
    if (finiteMetric(weights.market) !== 1 || finiteMetric(weights.model || 0) !== 0) return false;
    const temperature = finiteMetric(weights.temperature);
    return Number.isFinite(targetTemperature)
      ? Number.isFinite(temperature) && Math.abs(temperature - targetTemperature) < 1e-9
      : !Number.isFinite(temperature);
  });
  return references.sort((left, right) => {
    const leftLogLoss = finiteMetric(left?.metrics?.logLoss);
    const rightLogLoss = finiteMetric(right?.metrics?.logLoss);
    if (Number.isFinite(leftLogLoss) && Number.isFinite(rightLogLoss) && leftLogLoss !== rightLogLoss) {
      return leftLogLoss - rightLogLoss;
    }
    return finiteMetric(left?.metrics?.brier) - finiteMetric(right?.metrics?.brier);
  })[0] || null;
}

function promotionGateFromEvaluation(
  evaluation,
  thresholdConfig = PROMOTION_THRESHOLD_CONFIG,
  modelLearningAuthority = null,
  options = {}
) {
  const effectiveThresholdConfig = thresholdConfig && typeof thresholdConfig === "object"
    ? thresholdConfig
    : { valid: false, invalidNames: ["promotion-threshold-config"], values: DEFAULT_PROMOTION_THRESHOLDS };
  const thresholdValues = effectiveThresholdConfig.values || DEFAULT_PROMOTION_THRESHOLDS;
  const promotionMinBaselineRows = thresholdValues.minBaselineRows;
  const promotionMinLogLossImprovement = thresholdValues.minLogLossImprovement;
  const promotionMinBrierImprovement = thresholdValues.minBrierImprovement;
  const promotionMinRollingPassRate = thresholdValues.minRollingPassRate;
  const promotionMinRollingWindows = thresholdValues.minRollingWindows;
  const promotionMinEvidenceRows = Number.isSafeInteger(Number(thresholdValues.minPromotionEvidenceRows))
    ? Math.max(DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows, Number(thresholdValues.minPromotionEvidenceRows))
    : DEFAULT_PROMOTION_THRESHOLDS.minPromotionEvidenceRows;
  const thresholdConfigReady = effectiveThresholdConfig.valid === true;
  const thresholdConfigInvalidNames = Array.isArray(effectiveThresholdConfig.invalidNames)
    ? effectiveThresholdConfig.invalidNames
    : ["promotion-threshold-config"];
  const currentModelComparison = evaluation?.marketBaseline?.comparison || {};
  const sample = evaluation?.sample || {};
  const shadowCandidates = evaluation?.shadowCandidates || null;
  const bestCandidate = shadowCandidates?.bestCandidate || null;
  const bestModelCandidate = shadowCandidates?.bestModelCandidate || null;
  const candidateRobustness = shadowCandidates?.robustness || null;
  const robustnessSelectedCandidateId = String(candidateRobustness?.selectedCandidate?.id || "");
  const candidateRobustnessInventoryHash = String(candidateRobustness?.family?.inventoryHash || "");
  const candidateRobustnessInventoryCommitted = /^[a-f0-9]{64}$/i.test(candidateRobustnessInventoryHash);
  const candidateRobustnessSelectionBound = Boolean(bestCandidate?.id)
    && robustnessSelectedCandidateId === String(bestCandidate.id);
  const candidateRobustnessReadyForProspectiveTest =
    candidateRobustness?.version === "shadow-candidate-robustness-v1"
    && candidateRobustnessInventoryCommitted
    && candidateRobustnessSelectionBound
    && candidateRobustness?.candidateReadyForProspectiveTest === true;
  const candidateRobustnessPromotionEligible =
    candidateRobustnessReadyForProspectiveTest
    && candidateRobustness?.formalPromotionEligible === true;
  const expectedModelSignalCandidate = buildResidualBoundModelSignalCandidate(
    evaluation,
    modelLearningAuthority
  );
  const candidateComparison = bestCandidate?.comparison || currentModelComparison;
  const modelCandidateComparison = bestModelCandidate?.comparison || {};
  const calibratedMarketReference = expectedModelSignalCandidate
    && bestModelCandidate?.candidateManifestHash === expectedModelSignalCandidate.candidateManifestHash
    ? {
      id: "residual-oos-market-baseline",
      metrics: evaluation?.residualMarketWalkForward?.aggregate?.market || null,
    }
    : calibratedMarketReferenceFor(shadowCandidates, bestModelCandidate);
  const modelCandidateRolling = bestModelCandidate?.rolling || null;
  const candidateRolling = bestCandidate?.rolling || null;
  const legacyRollingWindows = Array.isArray(evaluation?.rollingWindows) ? evaluation.rollingWindows : [];
  const marketBaselineRows = Number(sample.marketBaselineRows || currentModelComparison.rows || 0);
  const probabilityRows = Number(sample.probabilityRows || 0);
  const candidateRows = finiteMetric(candidateComparison.rows);
  const modelCandidateRows = finiteMetric(modelCandidateComparison.rows);
  const logLossImprovement = finiteMetric(candidateComparison.logLossImprovement);
  const brierImprovement = finiteMetric(candidateComparison.brierImprovement);
  const accuracyDelta = finiteMetric(candidateComparison.accuracyDelta);
  const modelLogLossImprovement = finiteMetric(modelCandidateComparison.logLossImprovement);
  const modelBrierImprovement = finiteMetric(modelCandidateComparison.brierImprovement);
  const modelAccuracyDelta = finiteMetric(modelCandidateComparison.accuracyDelta);
  const modelMetricRows = finiteMetric(bestModelCandidate?.metrics?.rows);
  const calibratedReferenceRows = finiteMetric(calibratedMarketReference?.metrics?.rows);
  const modelMetricLogLoss = finiteMetric(bestModelCandidate?.metrics?.logLoss);
  const calibratedReferenceLogLoss = finiteMetric(calibratedMarketReference?.metrics?.logLoss);
  const modelMetricBrier = finiteMetric(bestModelCandidate?.metrics?.brier);
  const calibratedReferenceBrier = finiteMetric(calibratedMarketReference?.metrics?.brier);
  const modelMarginalLogLossImprovement = Number.isFinite(modelMetricLogLoss) && Number.isFinite(calibratedReferenceLogLoss)
    ? calibratedReferenceLogLoss - modelMetricLogLoss
    : NaN;
  const modelMarginalBrierImprovement = Number.isFinite(modelMetricBrier) && Number.isFinite(calibratedReferenceBrier)
    ? calibratedReferenceBrier - modelMetricBrier
    : NaN;
  const modelMarginalReady = Boolean(calibratedMarketReference)
    && Number.isFinite(modelMetricRows)
    && Number.isFinite(calibratedReferenceRows)
    && modelMetricRows >= promotionMinBaselineRows
    && calibratedReferenceRows === modelMetricRows
    && Number.isFinite(modelMarginalLogLossImprovement)
    && modelMarginalLogLossImprovement >= 0
    && Number.isFinite(modelMarginalBrierImprovement)
    && modelMarginalBrierImprovement >= 0;
  const legacyCheckedWindows = legacyRollingWindows.filter((window) => (
    Number.isFinite(finiteMetric(window?.improvement?.logLossImprovement))
    && Number.isFinite(finiteMetric(window?.improvement?.brierImprovement))
  ));
  const legacyPassingWindows = legacyCheckedWindows.filter((window) => (
    finiteMetric(window?.improvement?.logLossImprovement) >= promotionMinLogLossImprovement
    && finiteMetric(window?.improvement?.brierImprovement) >= promotionMinBrierImprovement
  ));
  const candidateRollingWindows = finiteMetric(candidateRolling?.windows);
  const hasCandidateRolling = Number.isFinite(candidateRollingWindows) && candidateRollingWindows > 0;
  const checkedWindowCount = hasCandidateRolling ? candidateRollingWindows : legacyCheckedWindows.length;
  const candidateRollingPassRate = finiteMetric(candidateRolling?.passRate);
  const rollingPassRate = Number.isFinite(candidateRollingPassRate)
    ? candidateRollingPassRate
    : (legacyCheckedWindows.length ? legacyPassingWindows.length / legacyCheckedWindows.length : null);
  const rollingSource = hasCandidateRolling ? "shadow-candidate" : "current-model-legacy";
  const modelCandidateRollingWindows = finiteMetric(modelCandidateRolling?.windows);
  const hasModelCandidateRolling = Number.isFinite(modelCandidateRollingWindows) && modelCandidateRollingWindows > 0;
  const modelCandidateRollingPassRate = finiteMetric(modelCandidateRolling?.passRate);
  const modelRollingPassRate = Number.isFinite(modelCandidateRollingPassRate)
    ? modelCandidateRollingPassRate
    : null;
  const riskTier = String(evaluation?.riskTiers?.overall?.tier || "unknown");
  const inputViolationCount = finiteMetric(evaluation?.inputAudit?.violationCount);
  const inputAuditReady = evaluation?.inputAudit?.ok === true
    && evaluation?.inputAudit?.promotionEligible === true
    && Number.isFinite(inputViolationCount)
    && inputViolationCount === 0;
  const recommendationSelectionReady = evaluation?.recommendationSelection?.gate?.eligible === true;
  const walkForwardState = walkForwardPromotionState(evaluation);
  const promotionEvidenceState = promotionEvidenceStateFromEvaluation(evaluation, promotionMinEvidenceRows);
  const modelLearningAuthorityReady = modelLearningAuthority?.eligible === true
    && modelLearningAuthority?.registryValid === true
    && modelLearningAuthority?.candidateApplies === true
    && modelLearningAuthority?.championMatchesCandidate === true
    && modelLearningAuthority?.championArtifactPresent === true
    && modelLearningAuthority?.lastRelevantEventValid === true
    && modelLearningAuthority?.evidenceHashMatches === true;
  const modelSignalIdentityReady = modelLearningAuthorityReady
    && modelSignalIdentityMatchesAuthority(bestModelCandidate, expectedModelSignalCandidate);
  const productionValidation = evaluation?.recommendationSelection?.productionValidation || null;
  const requiredRecommendationMarkets = ["HAD", "HHAD"];
  const validatedRecommendationMarkets = Array.isArray(productionValidation?.validatedMarkets)
    ? productionValidation.validatedMarkets
    : [];
  const productionPolicyReady = productionValidation?.eligible === true
    && productionValidation?.samePolicyImplementation === true
    && requiredRecommendationMarkets.every((market) => productionMarketValidationReady(productionValidation, market));
  const modelSignalReady = Boolean(bestModelCandidate)
    && thresholdConfigReady
    && Number.isFinite(modelCandidateRows)
    && modelCandidateRows >= promotionMinBaselineRows
    && Number.isFinite(modelLogLossImprovement)
    && modelLogLossImprovement >= promotionMinLogLossImprovement
    && Number.isFinite(modelBrierImprovement)
    && modelBrierImprovement >= promotionMinBrierImprovement
    && hasModelCandidateRolling
    && modelCandidateRollingWindows >= promotionMinRollingWindows
    && (
      Number.isFinite(modelRollingPassRate)
      && modelRollingPassRate >= promotionMinRollingPassRate
    )
    && riskTier === "stable"
    && productionPolicyReady
    && inputAuditReady
    && recommendationSelectionReady
    && candidateRobustnessPromotionEligible
    && modelMarginalReady
    && walkForwardState.eligible
    && promotionEvidenceState.eligible
    && modelLearningAuthorityReady
    && modelSignalIdentityReady;
  const modelSignalStatus = !bestModelCandidate
    ? "missing"
    : (!modelSignalIdentityReady ? "champion-identity-mismatch" : (modelSignalReady ? "candidate-positive" : "shadow-only"));
  const bestCandidateUsesModelSignal = candidateUsesModelSignal(bestCandidate);
  const reasons = [];

  if (!thresholdConfigReady) {
    reasons.push(`promotion-threshold-config-invalid:${thresholdConfigInvalidNames.join(",")}`);
  }
  if (!evaluation) reasons.push("model-evaluation-missing");
  if (!bestCandidate) reasons.push("no-shadow-candidate");
  if (marketBaselineRows < promotionMinBaselineRows) {
    reasons.push(`market-baseline-rows:${marketBaselineRows}<${promotionMinBaselineRows}`);
  }
  if (!Number.isFinite(candidateRows) || candidateRows < promotionMinBaselineRows) {
    reasons.push(`shadow-candidate-rows:${Number.isFinite(candidateRows) ? candidateRows : "missing"}<${promotionMinBaselineRows}`);
  }
  if (!Number.isFinite(logLossImprovement) || logLossImprovement < promotionMinLogLossImprovement) {
    reasons.push(`log-loss-improvement:${Number.isFinite(logLossImprovement) ? round(logLossImprovement, 4) : "missing"}<${promotionMinLogLossImprovement}`);
  }
  if (!Number.isFinite(brierImprovement) || brierImprovement < promotionMinBrierImprovement) {
    reasons.push(`brier-improvement:${Number.isFinite(brierImprovement) ? round(brierImprovement, 4) : "missing"}<${promotionMinBrierImprovement}`);
  }
  if (checkedWindowCount < promotionMinRollingWindows) {
    reasons.push(`independent-rolling-windows:${checkedWindowCount}<${promotionMinRollingWindows}`);
  }
  if (!Number.isFinite(rollingPassRate) || rollingPassRate < promotionMinRollingPassRate) {
    reasons.push(`rolling-pass-rate:${Number.isFinite(rollingPassRate) ? round(rollingPassRate, 4) : "missing"}<${promotionMinRollingPassRate}`);
  }
  if (riskTier !== "stable") reasons.push(`model-risk-tier:${riskTier}!=stable`);
  if (!inputAuditReady) reasons.push("input-audit-failed");
  if (!recommendationSelectionReady) reasons.push("recommendation-selection-gate-ineligible");
  if (!candidateRobustnessSelectionBound) {
    reasons.push("shadow-candidate-robustness-selection-unbound");
  }
  if (!candidateRobustnessInventoryCommitted) {
    reasons.push("shadow-candidate-inventory-uncommitted");
  }
  if (!candidateRobustnessReadyForProspectiveTest) {
    reasons.push("shadow-candidate-robustness-ineligible");
  }
  if (candidateRobustness?.formalPromotionEligible !== true) {
    reasons.push("shadow-candidate-prospective-confirmation-missing");
  }
  reasons.push(...walkForwardState.blockers);
  reasons.push(...promotionEvidenceState.blockers);
  if (!modelLearningAuthority) {
    reasons.push("model-learning-authority-missing");
  } else if (!modelLearningAuthorityReady) {
    const authorityBlockers = Array.isArray(modelLearningAuthority.blockers)
      ? modelLearningAuthority.blockers
      : [];
    reasons.push(...(authorityBlockers.length ? authorityBlockers : ["model-learning-authority-invalid"]));
  }
  if (productionValidation?.samePolicyImplementation !== true || productionValidation?.eligible !== true) {
    reasons.push("production-multi-factor-policy-unvalidated");
  }
  for (const market of requiredRecommendationMarkets) {
    if (!productionMarketValidationReady(productionValidation, market)) {
      reasons.push(`recommendation-market-${market}-unvalidated`);
    }
  }
  if (bestCandidate?.id === "market-baseline") {
    reasons.push("best-shadow-candidate-is-market-baseline");
  }
  if (bestCandidateUsesModelSignal && !modelMarginalReady) {
    reasons.push("model-signal-no-marginal-gain-vs-calibrated-market");
  }
  if (bestCandidateUsesModelSignal && !modelSignalIdentityReady) {
    reasons.push("model-signal-candidate-champion-identity-mismatch");
  }

  return {
    version: "model-promotion-gate-v7",
    status: reasons.length ? "shadow" : "eligible",
    onlineEffect: reasons.length ? "shadow" : "guarded-active",
    eligibleScope: reasons.length
      ? "none"
      : (bestCandidateUsesModelSignal ? "model-signal" : "market-calibration-only"),
    checkedAt: options.checkedAt || new Date().toISOString(),
    sourceEvaluationVersion: evaluation?.version || null,
    thresholds: {
      configValid: thresholdConfigReady,
      configInvalidNames: thresholdConfigInvalidNames,
      minMarketBaselineRows: promotionMinBaselineRows,
      minLogLossImprovement: promotionMinLogLossImprovement,
      minBrierImprovement: promotionMinBrierImprovement,
      minRollingPassRate: promotionMinRollingPassRate,
      minIndependentRollingWindows: promotionMinRollingWindows,
      minPromotionEvidenceRows: promotionMinEvidenceRows,
      minProductionRowsPerMarket: PRODUCTION_MIN_ROWS_PER_MARKET,
      requireCleanInputAudit: true,
      requireRecommendationSelectionGate: true,
      requireSelectionAdjustedCandidateRobustness: true,
      requireUntouchedProspectiveCandidateConfirmation: true,
      requireWalkForwardProtocol: true,
      requireVerifiedTrainingEvaluationWatermark: true,
      requireProductionPolicyReplay: true,
      requireModelMarginalGainVsCalibratedMarket: true,
      requireValidPromotionEvidenceManifest: true,
      requireCompleteDecisionClockRecords: true,
      requireVerifiedModelLearningChampion: true,
      requireModelSignalCandidateChampionIdentity: true,
      requiredModelLearningCandidateTypes: MODEL_LEARNING_CANDIDATE_TYPES,
      requiredValidatedMarkets: requiredRecommendationMarkets,
    },
    sample: {
      probabilityRows,
      marketBaselineRows,
      candidateRows: Number.isFinite(candidateRows) ? candidateRows : 0,
      modelCandidateRows: Number.isFinite(modelCandidateRows) ? modelCandidateRows : 0,
      rollingWindows: checkedWindowCount,
      shadowCandidateRows: Number(shadowCandidates?.sample?.rows || 0),
      modelCandidateCount: Number(shadowCandidates?.summary?.modelCandidateCount || 0),
      balancedModelCandidateCount: Number(shadowCandidates?.summary?.balancedModelCandidateCount || 0),
      productionPolicyVersion: productionValidation?.productionPolicyVersion || null,
      productionPolicyReplay: productionValidation?.samePolicyImplementation === true,
      validatedRecommendationMarkets,
      inputAuditOk: inputAuditReady,
      inputAuditViolationCount: Number.isFinite(inputViolationCount) ? inputViolationCount : null,
      recommendationSelectionEligible: recommendationSelectionReady,
      shadowCandidateRobustnessVersion: candidateRobustness?.version || null,
      shadowCandidateInventoryHash: candidateRobustnessInventoryHash || null,
      shadowCandidateInventoryCommitted: candidateRobustnessInventoryCommitted,
      shadowCandidateRobustnessSelectionBound: candidateRobustnessSelectionBound,
      shadowCandidateReadyForProspectiveTest: candidateRobustnessReadyForProspectiveTest,
      shadowCandidateFormalPromotionEligible: candidateRobustnessPromotionEligible,
      walkForwardProtocolVersion: walkForwardState.protocolVersion,
      walkForwardWatermarkVerified: walkForwardState.watermarkVerified,
      promotionEvidenceEligibleRows: promotionEvidenceState.eligibleRows,
      promotionEvidenceManifestValid: promotionEvidenceState.manifestValid,
      promotionEvidenceDecisionClocksVerified: promotionEvidenceState.decisionClockRecordsVerified,
      modelLearningChampionVerified: modelLearningAuthorityReady,
      modelSignalCandidateChampionIdentityVerified: modelSignalIdentityReady,
    },
    metrics: {
      logLossImprovement: Number.isFinite(logLossImprovement) ? round(logLossImprovement, 4) : null,
      brierImprovement: Number.isFinite(brierImprovement) ? round(brierImprovement, 4) : null,
      accuracyDelta: Number.isFinite(accuracyDelta) ? round(accuracyDelta, 4) : null,
      rollingPassRate: rollingPassRate === null ? null : round(rollingPassRate, 4),
      rollingSource,
      currentModelLogLossImprovement: Number.isFinite(finiteMetric(currentModelComparison.logLossImprovement))
        ? round(finiteMetric(currentModelComparison.logLossImprovement), 4)
        : null,
      currentModelBrierImprovement: Number.isFinite(finiteMetric(currentModelComparison.brierImprovement))
        ? round(finiteMetric(currentModelComparison.brierImprovement), 4)
        : null,
      bestModelLogLossImprovement: Number.isFinite(modelLogLossImprovement) ? round(modelLogLossImprovement, 4) : null,
      bestModelBrierImprovement: Number.isFinite(modelBrierImprovement) ? round(modelBrierImprovement, 4) : null,
      bestModelAccuracyDelta: Number.isFinite(modelAccuracyDelta) ? round(modelAccuracyDelta, 4) : null,
      bestModelRollingPassRate: modelRollingPassRate === null ? null : round(modelRollingPassRate, 4),
      modelMarginalReferenceId: calibratedMarketReference?.id || null,
      modelMarginalLogLossImprovement: Number.isFinite(modelMarginalLogLossImprovement)
        ? round(modelMarginalLogLossImprovement, 4)
        : null,
      modelMarginalBrierImprovement: Number.isFinite(modelMarginalBrierImprovement)
        ? round(modelMarginalBrierImprovement, 4)
        : null,
      modelMarginalReady,
      riskTier,
      productionPolicyReady,
      walkForwardReady: walkForwardState.eligible,
      promotionEvidenceReady: promotionEvidenceState.eligible,
      candidateRobustnessReadyForProspectiveTest,
      candidateRobustnessPromotionEligible,
      candidateRobustnessInventoryCommitted,
      modelLearningAuthorityReady,
      modelSignalIdentityReady,
    },
    shadowCandidate: bestCandidate ? {
      id: bestCandidate.id,
      role: bestCandidate.role,
      featureSet: bestCandidate.featureSet || [],
      weights: bestCandidate.weights || null,
      metrics: bestCandidate.metrics || null,
      comparison: bestCandidate.comparison || null,
      rolling: bestCandidate.rolling || null,
    } : null,
    shadowCandidateRobustness: {
      version: candidateRobustness?.version || null,
      selectedCandidateId: robustnessSelectedCandidateId || null,
      candidateInventoryHash: candidateRobustnessInventoryHash || null,
      candidateInventoryCommitted: candidateRobustnessInventoryCommitted,
      candidateReadyForProspectiveTest: candidateRobustnessReadyForProspectiveTest,
      formalPromotionEligible: candidateRobustnessPromotionEligible,
      blockers: Array.isArray(candidateRobustness?.blockers)
        ? candidateRobustness.blockers
        : ["shadow-candidate-robustness-missing"],
      policy: "Retrospective candidate search may nominate a frozen candidate, but guarded activation also requires an untouched prospective confirmation bound to the same candidate and committed candidate inventory.",
    },
    modelSignal: {
      status: modelSignalStatus,
      onlineEffect: modelSignalReady && bestCandidateUsesModelSignal ? "guarded-active" : "shadow",
      readyForGuardedUse: modelSignalReady,
      bestCandidateUsesModelSignal,
      bestModelCandidateId: bestModelCandidate?.id || null,
      calibratedMarketReferenceId: calibratedMarketReference?.id || null,
      marginalGainVsCalibratedMarket: modelMarginalReady,
      championIdentityMatched: modelSignalIdentityReady,
      candidateManifestHash: bestModelCandidate?.candidateManifestHash || null,
      expectedCandidateManifestHash: expectedModelSignalCandidate?.candidateManifestHash || null,
      rollingSource: hasModelCandidateRolling ? "shadow-model-candidate" : "none",
      productionPolicyReady,
      validatedRecommendationMarkets,
      policy: "Model and historical-signal candidates remain shadow until they are non-worse than the same-temperature market calibration, every promotion-evidence decision clock verifies, and the current evaluation artifact is the hash-matched Champion in a valid model-learning registry.",
    },
    modelSignalCandidate: bestModelCandidate ? {
      id: bestModelCandidate.id,
      role: bestModelCandidate.role,
      featureSet: bestModelCandidate.featureSet || [],
      weights: bestModelCandidate.weights || null,
      metrics: bestModelCandidate.metrics || null,
      comparison: bestModelCandidate.comparison || null,
      rolling: bestModelCandidate.rolling || null,
      modelIdentity: bestModelCandidate.modelIdentity || null,
      candidateManifestHash: bestModelCandidate.candidateManifestHash || null,
      performanceManifestHash: bestModelCandidate.performanceManifestHash || null,
      foldManifestHashes: bestModelCandidate.foldManifestHashes || [],
    } : null,
    reasons,
    promotionEvidence: promotionEvidenceState,
    modelLearningAuthority: modelLearningAuthority ? {
      version: modelLearningAuthority.version || null,
      eligible: modelLearningAuthorityReady,
      registryFile: modelLearningAuthority.registryFile || null,
      registryValid: modelLearningAuthority.registryValid === true,
      registryHash: modelLearningAuthority.registryHash || null,
      championArtifactHash: modelLearningAuthority.championArtifactHash || null,
      candidateArtifactHash: modelLearningAuthority.candidateArtifactHash || null,
      candidateIdentity: modelLearningAuthority.candidateIdentity || null,
      candidateType: modelLearningAuthority.candidateType || null,
      candidateApplies: modelLearningAuthority.candidateApplies === true,
      championMatchesCandidate: modelLearningAuthority.championMatchesCandidate === true,
      championArtifactPresent: modelLearningAuthority.championArtifactPresent === true,
      lastRelevantEventValid: modelLearningAuthority.lastRelevantEventValid === true,
      evidenceHashMatches: modelLearningAuthority.evidenceHashMatches === true,
      lastRelevantEvent: modelLearningAuthority.lastRelevantEvent || null,
      blockers: modelLearningAuthority.blockers || [],
    } : null,
    productionValidation,
    walkForwardValidation: walkForwardState.validation,
    policy: "Model strategy stays shadow until it has clean pre-match inputs, a hash-valid promotion manifest backed by complete decision-clock records, a versioned walk-forward protocol, stable out-of-sample gains, exact production-policy replay, and a matching promoted Champion in the validated model-learning registry.",
  };
}

function hhadCompanionShadowGateFromEvaluation(evaluation) {
  const companion = evaluation?.hhadCompanionEvaluation || null;
  const sourceGate = companion?.gate || null;
  return {
    version: sourceGate?.version || "hhad-companion-candidate-gate-v1",
    strategy: companion?.strategy || "HHAD_COMPANION_SHADOW",
    strategyVersion: companion?.strategyVersion || null,
    strategyHash: companion?.strategyHash || null,
    sourceEvaluationVersion: companion?.version || null,
    evaluatedAt: companion?.evaluatedAt || null,
    status: companion?.candidateStatus || "shadow-collecting",
    thresholds: sourceGate?.thresholds || null,
    checks: sourceGate?.checks || {},
    candidateReady: companion?.candidateReady === true && sourceGate?.candidateReady === true,
    counts: companion?.counts || {},
    exactReplay: companion?.exactReplay || null,
    onlineEffect: "shadow",
    promotionAllowed: false,
    interpretation: sourceGate?.interpretation
      || "HHAD companion evidence remains an independent shadow track and cannot activate the global model gate.",
  };
}

function riskGuardFromEvaluation(evaluation) {
  const riskTier = evaluation?.riskTiers?.overall?.tier || "unknown";
  const rank = MODEL_RISK_TIER_RANK[riskTier] ?? MODEL_RISK_TIER_RANK.degraded;
  const maxCalibrationError = Number(evaluation?.riskTiers?.confidenceBuckets?.maxCalibrationError);
  const clvRows = Number(evaluation?.closingLineValue?.rows || evaluation?.riskTiers?.closingLineValue?.rows || 0);
  const looseningAllowed = rank === MODEL_RISK_TIER_RANK.stable;
  const tighteningAllowed = rank >= MODEL_RISK_TIER_RANK.watch;
  return {
    version: "risk-constrained-exposure-v1",
    riskTier,
    looseningAllowed,
    tighteningAllowed,
    maxCalibrationError: Number.isFinite(maxCalibrationError) ? round(maxCalibrationError, 4) : null,
    clvRows: Number.isFinite(clvRows) ? clvRows : 0,
    policy: "Online strategy may tighten recommendation gates from audited backtests while risk is watch or degraded, but loosening is blocked until the model risk tier is stable."
  };
}

function combineAdjustments(adjustments) {
  const output = {
    minProbabilityBoost: 0,
    minModelGapBoost: 0,
    minHandicapSupportBoost: 0,
    trustPenalty: 0,
    maxRiskTagsDelta: 0,
    goalsMinBoost: 0,
  };

  for (const adjustment of adjustments.filter(Boolean)) {
    output.minProbabilityBoost += Number(adjustment.minProbabilityBoost || 0);
    output.minModelGapBoost += Number(adjustment.minModelGapBoost || 0);
    output.minHandicapSupportBoost += Number(adjustment.minHandicapSupportBoost || 0);
    output.trustPenalty += Number(adjustment.trustPenalty || 0);
    output.maxRiskTagsDelta += Number(adjustment.maxRiskTagsDelta || 0);
    output.goalsMinBoost += Number(adjustment.goalsMinBoost || 0);
  }

  return {
    minProbabilityBoost: round(clamp(output.minProbabilityBoost, -0.02, 0.12)),
    minModelGapBoost: round(clamp(output.minModelGapBoost, -0.015, 0.08)),
    minHandicapSupportBoost: round(clamp(output.minHandicapSupportBoost, -0.015, 0.1)),
    trustPenalty: Math.round(clamp(output.trustPenalty, -3, 18)),
    maxRiskTagsDelta: Math.round(clamp(output.maxRiskTagsDelta, -3, 1)),
    goalsMinBoost: round(clamp(output.goalsMinBoost, -0.02, 0.08)),
  };
}

function ruleAdjustment(summary, context = {}) {
  const minRows = context.minRows || MIN_RULE_ROWS;
  const minDays = Math.max(0, Number(context.minDays || 0));
  const settled = Number(summary?.settled || 0);
  const matchDays = Number(summary?.independentMatchDays || 0);
  const hitRate = Number.isFinite(summary?.hitRate) ? summary.hitRate : null;
  const roi = Number.isFinite(summary?.roi) ? summary.roi : null;
  const reasons = [];
  const adjustments = [];

  if (settled < minRows) {
    return {
      onlineAction: "observe",
      sampleStatus: "low-sample",
      reasons: [`sample<${minRows}`],
      adjustments: combineAdjustments([]),
    };
  }

  if (context.requireMinDaysForAnyAction === true && matchDays < minDays) {
    return {
      onlineAction: "observe",
      sampleStatus: "low-day-diversity",
      reasons: [`independent-match-days<${minDays}`],
      adjustments: combineAdjustments([]),
    };
  }

  if (hitRate !== null && hitRate < 0.32) {
    reasons.push("very-cold-hit-rate");
    adjustments.push({
      minProbabilityBoost: 0.07,
      minModelGapBoost: 0.04,
      minHandicapSupportBoost: 0.05,
      trustPenalty: 10,
      maxRiskTagsDelta: -2,
      goalsMinBoost: context.marketType === "GOALS" ? 0.04 : 0,
    });
  } else if (hitRate !== null && hitRate < 0.4) {
    reasons.push("cold-hit-rate");
    adjustments.push({
      minProbabilityBoost: 0.04,
      minModelGapBoost: 0.025,
      minHandicapSupportBoost: 0.035,
      trustPenalty: 6,
      maxRiskTagsDelta: -1,
      goalsMinBoost: context.marketType === "GOALS" ? 0.03 : 0,
    });
  }

  if (roi !== null && roi < -0.35) {
    reasons.push("negative-flat-stake-roi");
    adjustments.push({
      minProbabilityBoost: 0.02,
      minModelGapBoost: 0.015,
      minHandicapSupportBoost: 0.015,
      trustPenalty: 3,
      maxRiskTagsDelta: -1,
    });
  }

  if (
    !reasons.length
    && settled >= MIN_LOOSEN_ROWS
    && matchDays >= MIN_LOOSEN_MATCH_DAYS
    && hitRate !== null
    && hitRate >= 0.58
    && (roi === null || roi >= 0)
  ) {
    if (context.allowLoosening === false) {
      return {
        onlineAction: "observe",
        sampleStatus: "risk-constrained",
        reasons: ["risk-guard-blocked-loosening"],
        adjustments: combineAdjustments([]),
      };
    }
    return {
      onlineAction: "loosen",
      sampleStatus: "validated",
      reasons: ["validated-hot-sample"],
      adjustments: combineAdjustments([{
        minProbabilityBoost: -0.01,
        minModelGapBoost: -0.006,
        minHandicapSupportBoost: -0.006,
        trustPenalty: -2,
        maxRiskTagsDelta: 1,
        goalsMinBoost: context.marketType === "GOALS" ? -0.01 : 0,
      }]),
    };
  }

  if (
    !reasons.length
    && settled >= MIN_LOOSEN_ROWS
    && matchDays < MIN_LOOSEN_MATCH_DAYS
    && hitRate !== null
    && hitRate >= 0.58
    && (roi === null || roi >= 0)
  ) {
    return {
      onlineAction: "observe",
      sampleStatus: "low-day-diversity",
      reasons: [`independent-match-days<${MIN_LOOSEN_MATCH_DAYS}`],
      adjustments: combineAdjustments([]),
    };
  }

  if (!reasons.length) {
    return {
      onlineAction: "observe",
      sampleStatus: "neutral",
      reasons: ["neutral-sample"],
      adjustments: combineAdjustments([]),
    };
  }

  return {
    onlineAction: "tighten",
    sampleStatus: settled >= MIN_LOOSEN_ROWS ? "validated" : "guarded",
    reasons,
    adjustments: combineAdjustments(adjustments),
  };
}

function buildRule(key, summary, context = {}) {
  const adjustment = ruleAdjustment(summary, context);
  return {
    key,
    settled: Number(summary?.settled || 0),
    won: Number(summary?.won || 0),
    lost: Number(summary?.lost || 0),
    hitRate: Number.isFinite(summary?.hitRate) ? summary.hitRate : null,
    roi: Number.isFinite(summary?.roi) ? summary.roi : null,
    avgOdds: Number.isFinite(summary?.avgOdds) ? summary.avgOdds : null,
    independentMatchDays: Number(summary?.independentMatchDays || 0),
    onlineAction: adjustment.onlineAction,
    sampleStatus: adjustment.sampleStatus,
    reasons: adjustment.reasons,
    adjustments: adjustment.adjustments,
  };
}

function capDetailRule(rule) {
  if (!rule || rule.onlineAction !== "tighten") return rule;
  return {
    ...rule,
    adjustments: {
      ...rule.adjustments,
      minProbabilityBoost: round(clamp(rule.adjustments.minProbabilityBoost || 0, 0, MAX_DETAIL_BOOST)),
      minModelGapBoost: round(clamp(rule.adjustments.minModelGapBoost || 0, 0, MAX_DETAIL_BOOST)),
      minHandicapSupportBoost: round(clamp(rule.adjustments.minHandicapSupportBoost || 0, 0, MAX_DETAIL_BOOST)),
      goalsMinBoost: round(clamp(rule.adjustments.goalsMinBoost || 0, 0, MAX_DETAIL_BOOST)),
      trustPenalty: Math.round(clamp(rule.adjustments.trustPenalty || 0, 0, 10)),
      maxRiskTagsDelta: Math.round(clamp(rule.adjustments.maxRiskTagsDelta || 0, -2, 0)),
    },
  };
}

function activeRuleCount(rulesByKey) {
  return Object.values(rulesByKey || {}).filter((rule) => rule.onlineAction === "tighten").length;
}

function looseningRuleCount(rulesByKey) {
  return Object.values(rulesByKey || {}).filter((rule) => rule.onlineAction === "loosen").length;
}

function isTrustedReferenceSettlement(match) {
  const provenance = match?.resultProvenance;
  return match?.status === "FINISHED"
    && Number.isFinite(match?.scoreHome)
    && Number.isFinite(match?.scoreAway)
    && provenance?.provider === "sporttery"
    && provenance?.official === true
    && provenance?.trusted === true
    && provenance?.promotionEligible === true
    && match?.postMatchReview?.settlement?.resultObservationFallback !== true;
}

function referenceShadowPredictionRows(matches) {
  const rowsByKey = new Map();
  for (const match of dedupeMatches(matches || [])) {
    if (!isTrustedReferenceSettlement(match)) continue;
    const sourceMatchId = matchKey(match);
    const kickoffTime = match.kickoffTime || "";
    const matchDay = matchDayKey(match.kickoffDate || match.matchDate || match.businessDate || kickoffTime);
    const reviewRows = match?.postMatchReview?.predictionReview?.rows;
    if (!Array.isArray(reviewRows)) continue;

    for (const reviewRow of reviewRows) {
      const referenceRole = reviewRow?.reviewRole === "reference"
        || reviewRow?.performanceTrack === "reference"
        || reviewRow?.recommendationAction === "reference"
        || reviewRow?.recommendationTier === "reference";
      if (!referenceRole || !["WON", "LOST"].includes(reviewRow?.resultStatus)) continue;
      const resolvedMarket = marketType(reviewRow);
      if (!["1X2", "HHAD", "GOALS"].includes(resolvedMarket)) continue;
      const roleMarketType = normText(reviewRow?.marketType).toUpperCase();
      const key = [
        sourceMatchId || matchIdentity(match),
        roleMarketType,
        resolvedMarket,
        normText(reviewRow?.oddsPoolCode).toUpperCase(),
        normText(reviewRow?.handicapLine),
        normText(reviewRow?.tipCode).toUpperCase(),
      ].join("|");
      const odds = finiteDecimalOdds(reviewRow?.odds);
      const row = {
        sourceMatchId,
        kickoffTime,
        matchDay,
        league: match.leagueName || match.leagueNameEn || match.leagueId || "",
        profileKey: profileKey(match),
        marketType: resolvedMarket,
        roleMarketType,
        oddsPoolCode: normText(reviewRow?.oddsPoolCode).toUpperCase(),
        tipCode: normText(reviewRow?.tipCode).toUpperCase(),
        odds,
        oddsBucket: oddsBucket(odds),
        trustScore: Number(reviewRow?.trustScore || 0),
        resultStatus: reviewRow.resultStatus,
        probability: null,
        source: "postMatchReview.reference",
      };
      const previous = rowsByKey.get(key);
      if (!previous || Number(row.trustScore || 0) >= Number(previous.trustScore || 0)) {
        rowsByKey.set(key, row);
      }
    }
  }
  return [...rowsByKey.values()].sort((a, b) => (
    String(a.kickoffTime).localeCompare(String(b.kickoffTime))
    || String(a.sourceMatchId).localeCompare(String(b.sourceMatchId))
  ));
}

function referenceShadowRule(key, summary, marketTypeValue = null) {
  const diagnosticRule = capDetailRule(buildRule(key, summary, {
    minRows: MIN_REFERENCE_SHADOW_ROWS,
    minDays: MIN_REFERENCE_SHADOW_MATCH_DAYS,
    requireMinDaysForAnyAction: true,
    allowLoosening: false,
    ...(marketTypeValue ? { marketType: marketTypeValue } : {}),
  }));
  return {
    ...diagnosticRule,
    diagnosticOnlineAction: diagnosticRule.onlineAction,
    onlineAction: "observe",
    sampleStatus: "shadow-quarantined",
    reasons: [...new Set([
      ...(diagnosticRule.reasons || []),
      "reference-cohort-not-tier-isolated",
    ])],
    adjustments: combineAdjustments([]),
  };
}

function buildReferenceShadowEvaluation(matches) {
  const rows = referenceShadowPredictionRows(matches);
  // BEST is the single reference direction shown to the customer. The other
  // reference rows remain diagnostic only so a duplicated 1X2/BEST direction
  // cannot count twice when a tightening rule is learned.
  const decisionRows = rows.filter((row) => row.roleMarketType === "BEST");
  const summary = {
    total: summarizeRows(rows),
    decision: summarizeRows(decisionRows),
    byRole: groupSummary(rows, (row) => row.roleMarketType),
    byMarket: groupSummary(decisionRows, (row) => row.marketType),
    byProfile: groupSummary(decisionRows, (row) => row.profileKey),
    byMarketProfile: groupSummary(decisionRows, (row) => `${row.marketType}:${row.profileKey}`),
    byOddsBucket: groupSummary(decisionRows, (row) => `${row.marketType}:${row.oddsBucket}`),
    byTip: groupSummary(decisionRows, (row) => `${row.marketType}:${row.tipCode}`),
  };
  const gateByMarket = Object.fromEntries(Object.entries(summary.byMarket).map(([key, value]) => (
    [key, referenceShadowRule(`reference:${key}`, value, key)]
  )));
  const gateByProfile = Object.fromEntries(Object.entries(summary.byProfile).map(([key, value]) => (
    [key, referenceShadowRule(`reference:${key}`, value)]
  )));
  const gateByMarketProfile = Object.fromEntries(Object.entries(summary.byMarketProfile).map(([key, value]) => {
    const market = key.split(":")[0];
    return [key, referenceShadowRule(`reference:${key}`, value, market)];
  }));
  const gateByOddsBucket = Object.fromEntries(Object.entries(summary.byOddsBucket).map(([key, value]) => {
    const market = key.split(":")[0];
    return [key, referenceShadowRule(`reference:${key}`, value, market)];
  }));
  const gateByTip = Object.fromEntries(Object.entries(summary.byTip).map(([key, value]) => {
    const market = key.split(":")[0];
    return [key, referenceShadowRule(`reference:${key}`, value, market)];
  }));
  const activeGates = {
    market: activeRuleCount(gateByMarket),
    profile: activeRuleCount(gateByProfile),
    marketProfile: activeRuleCount(gateByMarketProfile),
    oddsBucket: activeRuleCount(gateByOddsBucket),
    tip: activeRuleCount(gateByTip),
  };
  const activeGateCount = Object.values(activeGates).reduce((sum, count) => sum + Number(count || 0), 0);

  return {
    version: "reference-shadow-evaluation-v1",
    role: "reference-shadow-only",
    promotionEligible: false,
    countedInFormalMetrics: false,
    activation: {
      onlineEffect: "shadow-observe",
      automaticPromotionAllowed: false,
      automaticLooseningAllowed: false,
      minimumRows: MIN_REFERENCE_SHADOW_ROWS,
      minimumIndependentMatchDays: MIN_REFERENCE_SHADOW_MATCH_DAYS,
    },
    sample: {
      rows: rows.length,
      decisionRows: decisionRows.length,
      independentMatchDays: independentMatchDays(decisionRows),
    },
    summary,
    tightening: {
      activeGates,
      activeGateCount,
      gateByMarket,
      gateByProfile,
      gateByMarketProfile,
      gateByOddsBucket,
      gateByTip,
    },
    policy: "Reference recommendations remain diagnostic-only until source, tier, policy version, and immutable publication lineage are separated. They never enter formal hit rate, ROI, calibration, promotion evidence, or online gates.",
  };
}

function buildStrategy(matches, evaluation, snapshots = [], options = {}) {
  const rows = predictionRows(matches, snapshots, {
    publicationIndex: options.publicationIndex || null,
    requireVerifiedPublication: options.requireVerifiedPublication !== false,
  });
  const referenceShadowRows = buildReferenceShadowEvaluation(matches);
  const officialRows = rows.filter((row) => finiteDecimalOdds(row.odds));
  const bestRows = officialRows.filter((row) => row.roleMarketType === "BEST");
  const recommendationRows = officialRows.filter((row) => row.marketType === "1X2" || row.marketType === "HHAD");
  const hhadRows = officialRows.filter((row) => row.marketType === "HHAD");
  const goalsRows = officialRows.filter((row) => row.marketType === "GOALS");

  const summary = {
    total: summarizeRows(rows),
    official: summarizeRows(officialRows),
    recommendationPool: summarizeRows(recommendationRows),
    best: summarizeRows(bestRows),
    goals: summarizeRows(goalsRows),
    byMarket: groupSummary(officialRows, (row) => row.marketType),
    byRole: groupSummary(officialRows, (row) => row.roleMarketType),
    byProfile: groupSummary(officialRows, (row) => row.profileKey),
    byMarketProfile: groupSummary(officialRows, (row) => `${row.marketType}:${row.profileKey}`),
    byOddsBucket: groupSummary(
      officialRows.filter((row) => ["1", "X", "2"].includes(row.tipCode)),
      (row) => `${row.marketType}:${row.oddsBucket}`
    ),
    byTip: groupSummary(officialRows, (row) => `${row.marketType}:${row.tipCode}`),
    // Compatibility-only empty bucket. Web/RAG evidence is excluded before
    // settled prediction rows and therefore cannot create strategy evidence.
    byWebConsensus: {},
    byPolicy: groupSummary(officialRows, (row) => row.policyVersion),
  };
  const riskGuard = riskGuardFromEvaluation(evaluation);
  const selectionEvidence = evaluation?.recommendationSelection || null;
  const selectionInputViolationCount = finiteMetric(evaluation?.inputAudit?.violationCount);
  const selectionInputAuditReady = evaluation?.inputAudit?.ok === true
    && evaluation?.inputAudit?.promotionEligible === true
    && Number.isFinite(selectionInputViolationCount)
    && selectionInputViolationCount === 0;
  const selectionWalkForwardReady = walkForwardPromotionState(evaluation).eligible;
  const selectionEligible = selectionEvidence?.gate?.eligible === true
    && selectionEvidence?.hardMaxSp === null
    && Number(selectionEvidence?.after?.settled || 0) >= 300
    && selectionInputAuditReady
    && selectionWalkForwardReady
    && selectionEvidence?.productionValidation?.eligible === true
    && selectionEvidence?.productionValidation?.samePolicyImplementation === true
    && ["HAD", "HHAD"].every((market) => (
      productionMarketValidationReady(selectionEvidence?.productionValidation, market)
    ));
  const recommendationSelection = {
    version: MODEL_LEARNING_POLICY_VERSION,
    status: selectionEligible ? "active-multi-factor" : "shadow-only",
    hardMaxSp: null,
    spRole: "continuous-market-value-and-risk-feature",
    directionSwitchByLowerSp: false,
    unknownSpAction: "watch",
    officialPoolsOnly: ["HAD", "HHAD"],
    mainMarketOnly: "BEST",
    riskConstrained: !riskGuard.looseningAllowed,
    sourceEvaluationVersion: evaluation?.version || null,
    productionValidation: selectionEvidence?.productionValidation || null,
    evidence: selectionEvidence ? {
      beforeSettled: Number(selectionEvidence.before?.settled || 0),
      afterSettled: Number(selectionEvidence.after?.settled || 0),
      coverage: selectionEvidence.coverage ?? null,
      hitRateSpOnly: selectionEvidence.spOnlyBaseline?.hitRate ?? null,
      hitRateAfter: selectionEvidence.after?.hitRate ?? null,
      hitRateDeltaVsSpOnly: selectionEvidence.hitRateDeltaVsSpOnly ?? null,
      highSpCandidates: Number(selectionEvidence.highSpCandidates || 0),
      lowSpRejected: Number(selectionEvidence.lowSpRejected || 0),
      stableWindows: Number(selectionEvidence.gate?.stableWindows || 0)
    } : null,
    policy: "Official SP is a continuous market/value feature, never an accuracy ceiling. Promotion requires aligned independent model, score matrix, HAD/HHAD structure, as-of movement, value, data quality and risk evidence; failure becomes WATCH without changing direction for a lower SP."
  };
  const baseRuleContext = { allowLoosening: riskGuard.looseningAllowed };

  const gateByProfile = Object.fromEntries(PROFILE_KEYS.map((profile) => {
    const overall = buildRule(profile, summary.byProfile[profile] || summarizeRows([]), { ...baseRuleContext, minRows: MIN_PROFILE_ROWS });
    const oneXTwo = buildRule(`1X2:${profile}`, summary.byMarketProfile[`1X2:${profile}`] || summarizeRows([]), { ...baseRuleContext, minRows: MIN_PROFILE_ROWS, marketType: "1X2" });
    const hhad = buildRule(`HHAD:${profile}`, summary.byMarketProfile[`HHAD:${profile}`] || summarizeRows([]), { ...baseRuleContext, minRows: MIN_PROFILE_ROWS, marketType: "HHAD" });
    const goals = buildRule(`GOALS:${profile}`, summary.byMarketProfile[`GOALS:${profile}`] || summarizeRows([]), { ...baseRuleContext, minRows: MIN_PROFILE_ROWS, marketType: "GOALS" });
    // This legacy profile gate is consumed as the HAD base gate. Only HAD
    // evidence may tighten it; HHAD/GOALS remain descriptive and use their
    // own market-qualified gates below.
    const activeAdjustments = [oneXTwo]
      .filter((rule) => rule.onlineAction === "tighten")
      .map((rule) => rule.adjustments);

    return [profile, {
      key: profile,
      sample: {
        overall: summary.byProfile[profile] || summarizeRows([]),
        oneXTwo: summary.byMarketProfile[`1X2:${profile}`] || summarizeRows([]),
        hhad: summary.byMarketProfile[`HHAD:${profile}`] || summarizeRows([]),
        goals: summary.byMarketProfile[`GOALS:${profile}`] || summarizeRows([]),
      },
      onlineAction: activeAdjustments.length ? "tighten" : "observe",
      sampleStatus: activeAdjustments.length ? "guarded" : "observe",
      reasons: [overall, oneXTwo, hhad, goals].flatMap((rule) => rule.reasons.map((reason) => `${rule.key}:${reason}`)),
      adjustments: combineAdjustments(activeAdjustments),
    }];
  }));

  const gateByMarket = Object.fromEntries(
    Object.entries(summary.byMarket).map(([key, value]) => [key, capDetailRule(buildRule(key, value, { ...baseRuleContext, marketType: key }))])
  );
  const gateByMarketProfile = Object.fromEntries(
    Object.entries(summary.byMarketProfile).map(([key, value]) => {
      const market = key.split(":")[0];
      return [key, capDetailRule(buildRule(key, value, { ...baseRuleContext, marketType: market }))];
    })
  );
  const gateByOddsBucket = Object.fromEntries(
    Object.entries(summary.byOddsBucket).map(([key, value]) => {
      const market = key.split(":")[0];
      return [key, capDetailRule(buildRule(key, value, { ...baseRuleContext, marketType: market }))];
    })
  );
  const gateByTip = Object.fromEntries(
    Object.entries(summary.byTip).map(([key, value]) => {
      const market = key.split(":")[0];
      return [key, capDetailRule(buildRule(key, value, { ...baseRuleContext, marketType: market }))];
    })
  );
  // Kept empty so old consumers can read the field without allowing legacy
  // web-consensus artifacts to manufacture a numeric gate.
  const gateByWebConsensus = Object.freeze({});

  const activeGates = {
    profile: activeRuleCount(gateByProfile),
    market: activeRuleCount(gateByMarket),
    marketProfile: activeRuleCount(gateByMarketProfile),
    oddsBucket: activeRuleCount(gateByOddsBucket),
    tip: activeRuleCount(gateByTip),
    webConsensus: 0,
  };
  const looseningGates = {
    profile: looseningRuleCount(gateByProfile),
    market: looseningRuleCount(gateByMarket),
    marketProfile: looseningRuleCount(gateByMarketProfile),
    oddsBucket: looseningRuleCount(gateByOddsBucket),
    tip: looseningRuleCount(gateByTip),
    webConsensus: 0,
  };
  const settledOfficialRows = officialRows.length;
  const promotionGate = promotionGateFromEvaluation(
    evaluation,
    options.promotionThresholdConfig || PROMOTION_THRESHOLD_CONFIG,
    options.modelLearningAuthority || null,
    { checkedAt: options.generatedAt }
  );
  const hhadCompanionShadowGate = hhadCompanionShadowGateFromEvaluation(evaluation);
  const sampleEligibleEffect = settledOfficialRows >= MIN_RULE_ROWS ? "guarded-active" : "shadow";
  const onlineEffect = promotionGate.onlineEffect === "guarded-active" ? sampleEligibleEffect : "shadow";
  const modelSignalReady = promotionGate.modelSignal?.readyForGuardedUse === true;
  const modelSignalEffect = promotionGate.modelSignal?.onlineEffect || "shadow";
  const activationMode = onlineEffect === "shadow" && promotionGate.status !== "eligible"
    ? "market-baseline-shadow"
    : "cooling-only";

  return {
    version: VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: "settled-pre-match-predictions",
    activation: {
      mode: activationMode,
      onlineEffect,
      modelSignalEffect,
      minimumRowsForRule: MIN_RULE_ROWS,
      minimumRowsForProfile: MIN_PROFILE_ROWS,
      minimumRowsForLoosening: MIN_LOOSEN_ROWS,
      minimumMatchDaysForLoosening: MIN_LOOSEN_MATCH_DAYS,
      referenceShadowEffect: referenceShadowRows.activation.onlineEffect,
      promotionGate,
      shadowTracks: {
        HHAD_COMPANION: hhadCompanionShadowGate,
      },
      riskGuard,
      note: onlineEffect === "shadow"
        ? "Strategy is shadow-only until the promotion manifest, decision clocks, and model-learning Champion authority all verify."
        : (riskGuard.looseningAllowed
          ? "Tightening and controlled loosening may run because the model risk tier is stable."
          : (modelSignalReady
            ? "Only tightening rules are applied online; model-signal candidates are positive but loosening is blocked until the model risk tier is stable."
            : "Only market-calibration tightening is applied online; model-signal candidates remain shadow until they beat the market baseline.")),
    },
    sample: {
      matches: matches.length,
      settledRows: rows.length,
      officialRows: settledOfficialRows,
      recommendationRows: recommendationRows.length,
      bestRows: bestRows.length,
      hhadRows: hhadRows.length,
      goalsRows: goalsRows.length,
      webConsensusRows: 0,
    },
    summary,
    referenceShadowRows,
    recommendationSelection,
    activeGates,
    looseningGates,
    gateByProfile,
    gateByMarket,
    gateByMarketProfile,
    gateByOddsBucket,
    gateByTip,
    gateByWebConsensus,
    advisoryPolicy: {
      webConsensus: {
        eligibleForNumericModel: false,
        eligibleForStrategyGate: false,
        onlineEffect: "advisory-only",
        legacyArtifacts: "ignored",
      },
    },
    recommendations: [
      {
        id: "multi-factor-market-evidence-gate",
        status: recommendationSelection.status,
        reason: selectionEligible
          ? "Time-ordered out-of-sample evidence activates the multi-factor recommendation gate; SP remains a continuous feature and never changes direction by itself."
          : "The multi-factor candidate remains shadow-only until enough as-of HAD/HHAD samples beat the same-match market and SP-only baselines.",
      },
      {
        id: "sample-guard",
        status: onlineEffect === "shadow"
          ? "shadow-only"
          : (!riskGuard.looseningAllowed ? "risk-constrained-cooling" : (settledOfficialRows >= MIN_LOOSEN_ROWS ? "ready-for-controlled-loosening" : "cooling-only")),
        reason: !riskGuard.looseningAllowed
          ? `The model risk tier is ${riskGuard.riskTier}, so online automation may tighten gates but cannot loosen thresholds yet.`
          : settledOfficialRows >= MIN_LOOSEN_ROWS
          ? "The settled official sample has reached the loosening floor."
          : "The settled official sample is still small, so automation may tighten gates but will not loosen them.",
      },
      {
        id: "reference-shadow-tightening",
        status: referenceShadowRows.activation.onlineEffect,
        reason: "Reference recommendations are quarantined as diagnostics until their source/tier/version cohorts and immutable publication lineage are separated.",
      },
      {
        id: "market-baseline-gate",
        status: promotionGate.status,
        reason: promotionGate.reasons.length
          ? promotionGate.reasons.join("; ")
          : "Model evaluation is eligible for guarded online tightening against the market baseline.",
      },
      {
        id: "model-signal-gate",
        status: promotionGate.modelSignal?.status || "missing",
        reason: promotionGate.modelSignal?.readyForGuardedUse
          ? `Best model-signal candidate ${promotionGate.modelSignal.bestModelCandidateId} is non-negative on log loss and Brier, so it can remain under guarded review.`
          : "No model or historical-signal candidate is ready to loosen online recommendations yet.",
      },
      {
        id: "next-data-step",
        status: "pending",
        reason: "Import historical league data to seed Elo, form, and league priors before enabling weight optimization.",
      },
    ],
  };
}

function strategySemanticFingerprint(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return null;
  const semantic = JSON.parse(JSON.stringify(strategy));
  delete semantic.generatedAt;
  if (semantic?.activation?.promotionGate) {
    delete semantic.activation.promotionGate.checkedAt;
  }
  return sha256(stableStringify(semantic));
}

function stabilizeStrategyPublication(nextStrategy, previousStrategy) {
  const nextSemanticHash = strategySemanticFingerprint(nextStrategy);
  const previousSemanticHash = strategySemanticFingerprint(previousStrategy);
  const previousGeneratedAt = previousStrategy?.generatedAt || null;
  const previousClockValid = Number.isFinite(Date.parse(previousGeneratedAt || ""));
  const reusable = Boolean(
    nextSemanticHash
      && previousSemanticHash
      && nextSemanticHash === previousSemanticHash
      && previousClockValid
  );
  return {
    strategy: reusable ? previousStrategy : nextStrategy,
    reused: reusable,
    changed: !reusable,
    reason: reusable ? "semantic-strategy-unchanged" : "semantic-strategy-changed",
    nextSemanticHash,
    previousSemanticHash,
    generatedAt: reusable ? previousGeneratedAt : (nextStrategy?.generatedAt || null),
  };
}

function writeJsonIfChanged(file, payload) {
  const previous = readJson(file, null);
  if (stableStringify(previous) === stableStringify(payload)) return false;
  writeJson(file, payload);
  return true;
}

function main() {
  const matchFiles = ["matches-current.json", "matches-history.json"]
    .map((file) => path.join(publicDataDir, file))
    .filter((file) => fs.existsSync(file));
  const rawMatches = matchFiles.flatMap((file) => {
    const parsed = readJson(file, []);
    return Array.isArray(parsed) ? parsed : [];
  });
  const matches = dedupeMatches(rawMatches);
  const modelEvaluation = readJson(evaluationFile, null);
  const predictionSnapshots = readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });
  const snapshotRows = Array.isArray(predictionSnapshots?.rows) ? predictionSnapshots.rows : [];
  const modelLearningRegistryFile = path.resolve(
    process.env.MODEL_LEARNING_REGISTRY_FILE
      || path.join(serverDataDir, "model-artifacts", "model-learning-registry.json")
  );
  const modelLearningAuthority = loadModelLearningActivationAuthority(
    modelEvaluation,
    modelLearningRegistryFile
  );
  const publicationLedgerLoad = loadPublicationLedger(publicationLedgerFile);
  const publicationIndex = buildPublicationLedgerIndex(publicationLedgerLoad);

  const proposedStrategy = buildStrategy(matches, modelEvaluation, snapshotRows, {
    modelLearningAuthority,
    publicationIndex,
    requireVerifiedPublication: true,
  });
  const previousStrategy = readJson(outputFiles[0], null);
  const publication = stabilizeStrategyPublication(proposedStrategy, previousStrategy);
  const strategy = publication.strategy;
  const updatedOutputFiles = outputFiles.filter((file) => writeJsonIfChanged(file, strategy));
  const reconciliation = reconcileShadowStrategyArtifacts(strategy);
  const reconciliationChanged = reconciliation.syncMetaUpdated === true
    || reconciliation.calibrationCleared === true
    || Number(reconciliation.mutableMatchesCleared || 0) > 0;
  const changed = updatedOutputFiles.length > 0 || reconciliationChanged;

  console.log(JSON.stringify({
    ok: true,
    changed,
    skipped: !changed,
    reason: changed ? "strategy-artifacts-updated" : "strategy-artifacts-unchanged",
    version: strategy.version,
    outputFiles,
    updatedOutputFiles,
    publication: {
      reused: publication.reused,
      changed: publication.changed,
      reason: publication.reason,
      nextSemanticHash: publication.nextSemanticHash,
      previousSemanticHash: publication.previousSemanticHash,
      generatedAt: publication.generatedAt,
    },
    sample: strategy.sample,
    activeGates: strategy.activeGates,
    onlineEffect: strategy.activation.onlineEffect,
    publicationLedger: {
      valid: publicationIndex.valid,
      missing: publicationLedgerLoad.missing,
      rows: publicationIndex.rows,
    },
    promotionGate: {
      status: strategy.activation.promotionGate?.status || null,
      metrics: strategy.activation.promotionGate?.metrics || null,
      reasons: strategy.activation.promotionGate?.reasons || [],
      modelLearningAuthority: strategy.activation.promotionGate?.modelLearningAuthority || null,
    },
    reconciliation,
  }, null, 2));
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildStrategy,
    buildReferenceShadowEvaluation,
    buildResidualBoundModelSignalCandidate,
    marketType,
    predictionRows,
    referenceShadowPredictionRows,
    probabilityForTip,
    promotionGateFromEvaluation,
    readPromotionThresholds,
    hhadCompanionShadowGateFromEvaluation,
    loadModelLearningActivationAuthority,
    modelLearningActivationAuthorityFromRegistry,
    modelLearningCandidateContract,
    promotionEvidenceStateFromEvaluation,
    reconcileShadowStrategyArtifacts,
    stabilizeStrategyPublication,
    strategySemanticFingerprint,
    stripShadowStrategyFromMutableMatch,
    writeJsonIfChanged,
  };
}
