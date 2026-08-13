"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateEntityRegistry } = require("./entityResolutionRegistry.cjs");
const { isDecisionClockAuditEligible } = require("../src/services/decisionSnapshot.cjs");

const VERSION = "prediction-capability-audit-v1";
const MIN_PAIRED_ROWS = 500;
const MIN_INDEPENDENT_WINDOWS = 6;
const MIN_RESIDUAL_FOLDS = 3;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const integer = (value) => {
  const number = finite(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const timestampMs = (value) => {
  const valueMs = Date.parse(String(value || ""));
  return Number.isFinite(valueMs) ? valueMs : null;
};
const pct = (numerator, denominator) => Number((100 * numerator / Math.max(1, denominator)).toFixed(1));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
const stableStringify = (value) => JSON.stringify(stableValue(value));

const rowsFrom = (value) => {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of ["rows", "matches", "snapshots", "items"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
};

const dataGapsFor = (match) => match?.probabilityModel?.contextSignals?.dataGaps
  || match?.predictionMeta?.featureSnapshot?.modelInputs?.dataGaps
  || match?.featureSnapshot?.modelInputs?.dataGaps
  || match?.externalSignals?.preMatch?.quality
  || {};

const hasOddsTriplet = (value) => {
  if (!value) return false;
  if (Array.isArray(value)) return value.length >= 3 && value.slice(0, 3).every((item) => finite(item) !== null);
  const candidates = [
    [value.odds1, value.oddsX, value.odds2],
    [value["1"], value.X, value["2"]],
    [value.home, value.draw, value.away],
  ];
  return candidates.some((triplet) => triplet.every((item) => finite(item) !== null));
};

const featureStateFor = (match) => {
  const gaps = dataGapsFor(match);
  const connected = isObject(gaps.connected) ? gaps.connected : {};
  const featureMarket = match?.predictionMeta?.featureSnapshot?.market || match?.featureSnapshot?.market || {};
  const officialHad = hasOddsTriplet(match?.odds) || hasOddsTriplet(featureMarket?.had?.odds);
  const officialHhad = hasOddsTriplet(match?.handicapOdds) || hasOddsTriplet(featureMarket?.hhad?.odds);
  const finished = String(match?.status || "").toUpperCase() === "FINISHED";
  return {
    stableIdentity: Boolean(match?.sourceMatchId && (match?.homeTeamId || match?.homeTeamName) && (match?.awayTeamId || match?.awayTeamName)),
    officialOdds: connected.officialOdds === true || connected.market === true || officialHad || officialHhad,
    sourceCycle: Boolean(match?.sourceCycleId || match?.sourceProvenance?.cycleId),
    resultObserved: !finished || Boolean(timestampMs(match?.resultObservedAt || match?.resultProvenance?.observedAt)),
    lineup: connected.lineup === true,
    injuries: connected.injuries === true,
    xg: connected.xg === true,
    weather: connected.weather === true,
    referee: connected.referee === true,
    teamCards: connected.teamCards === true,
    standings: connected.standings === true,
    motivationStage: connected.motivationStage === true || connected.motivation === true,
    webConsensus: connected.webConsensus === true,
    externalMarket: connected.externalMarket === true,
  };
};

const coverageFor = (matchesInput) => {
  const matches = rowsFrom(matchesInput);
  const scheduled = matches.filter((match) => String(match?.status || "").toUpperCase() === "SCHEDULED");
  const scope = scheduled.length ? scheduled : matches;
  const keys = [
    "stableIdentity",
    "officialOdds",
    "sourceCycle",
    "resultObserved",
    "lineup",
    "injuries",
    "xg",
    "weather",
    "referee",
    "teamCards",
    "standings",
    "motivationStage",
    "webConsensus",
    "externalMarket",
  ];
  const rows = scope.map(featureStateFor);
  const features = Object.fromEntries(keys.map((key) => {
    const covered = rows.filter((row) => row[key] === true).length;
    return [key, { covered, total: scope.length, coveragePct: pct(covered, scope.length) }];
  }));
  const gapScores = scope.map((match) => finite(dataGapsFor(match)?.coverageScore ?? dataGapsFor(match)?.score))
    .filter((value) => value !== null);
  return {
    inputMatches: matches.length,
    scheduledMatches: scheduled.length,
    scope: scheduled.length ? "scheduled" : "current-fallback",
    scopeMatches: scope.length,
    averageDeclaredCoverage: gapScores.length
      ? Number((gapScores.reduce((sum, value) => sum + value, 0) / gapScores.length).toFixed(2))
      : null,
    features,
  };
};

const decisionSnapshotFor = (row) => row?.decisionSnapshot || row?.candidateDecisionSnapshot || row;
const timestampNotAfter = (value, boundary) => {
  const valueMs = timestampMs(value);
  const boundaryMs = timestampMs(boundary);
  return valueMs !== null && boundaryMs !== null && valueMs <= boundaryMs;
};

const snapshotClockAudit = (snapshotsInput) => {
  const rows = rowsFrom(snapshotsInput);
  const v2 = rows.map(decisionSnapshotFor)
    .filter((row) => row?.version === "candidate-decision-snapshot-v2");
  const checks = v2.map((snapshot) => {
    const source = snapshot.sourceTimestamps || {};
    const decisionAt = snapshot.decisionAt || snapshot.capturedAt;
    const hadRequired = Boolean(snapshot.markets?.HAD);
    const hhadRequired = Boolean(snapshot.markets?.HHAD);
    const hadObservedAt = source.hadObservedAt || source.officialHadObservedAt;
    const hhadObservedAt = source.hhadObservedAt || source.officialHhadObservedAt;
    const hadReceivedAt = source.hadReceivedAt || source.officialHadReceivedAt || source.receivedAt;
    const hhadReceivedAt = source.hhadReceivedAt || source.officialHhadReceivedAt || source.receivedAt;
    return {
      authoritativeEligible: isDecisionClockAuditEligible(snapshot),
      sourceCycle: Boolean(snapshot.sourceCycleId || snapshot.sourceProvenance?.cycleId || source.sourceCycleId),
      modelOrdered: timestampNotAfter(source.modelGeneratedAt, decisionAt),
      hadObservedOrdered: !hadRequired || timestampNotAfter(hadObservedAt, decisionAt),
      hhadObservedOrdered: !hhadRequired || timestampNotAfter(hhadObservedAt, decisionAt),
      hadReceivedOrdered: !hadRequired || timestampNotAfter(hadReceivedAt, decisionAt),
      hhadReceivedOrdered: !hhadRequired || timestampNotAfter(hhadReceivedAt, decisionAt),
    };
  });
  const count = (key) => checks.filter((row) => row[key]).length;
  const complete = checks.filter((row) => row.authoritativeEligible === true).length;
  return {
    totalRows: rows.length,
    v2Rows: v2.length,
    completeClockRows: complete,
    completeClockPct: pct(complete, v2.length),
    fields: Object.fromEntries([
      "sourceCycle",
      "modelOrdered",
      "hadObservedOrdered",
      "hhadObservedOrdered",
      "hadReceivedOrdered",
      "hhadReceivedOrdered",
    ].map((key) => [key, { rows: count(key), coveragePct: pct(count(key), v2.length) }])),
    policy: "Legacy or incomplete timestamps remain audit-only. Missing clocks are never inferred from kickoff or file modification time.",
  };
};

const entityResolutionAudit = (registry = {}, matchesInput = []) => {
  const validation = validateEntityRegistry(registry);
  const entities = isObject(registry?.entities) ? registry.entities : {};
  const providerRecords = Object.values(entities)
    .map((entity) => entity?.providers?.["api-football"])
    .filter(Boolean);
  const matches = rowsFrom(matchesInput);
  const scheduled = matches.filter((match) => String(match?.status || "").toUpperCase() === "SCHEDULED");
  const scope = scheduled.length ? scheduled : matches;
  const scopeTeamIds = Array.from(new Set(scope.flatMap((match) => [match?.homeTeamId, match?.awayTeamId])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
  const mappedTeamIds = scopeTeamIds.filter((teamId) => (
    entities?.[teamId]?.providers?.["api-football"]?.status === "verified"
  ));
  return {
    valid: validation.valid,
    errors: validation.errors,
    registryHash: registry?.registryHash || null,
    localEntities: Object.keys(entities).length,
    verifiedApiFootballMappings: providerRecords.filter((mapping) => mapping.status === "verified").length,
    conflictedApiFootballMappings: providerRecords.filter((mapping) => mapping.status === "conflicted").length,
    conflicts: Array.isArray(registry?.conflicts) ? registry.conflicts.length : 0,
    scopeTeamIds: scopeTeamIds.length,
    mappedScopeTeamIds: mappedTeamIds.length,
    mappedScopeCoveragePct: pct(mappedTeamIds.length, scopeTeamIds.length),
    policy: "Only high-confidence, non-reversed fixture co-occurrence may create a provider-id mapping; collisions are quarantined.",
  };
};

const evaluationAudit = (evaluation = {}) => {
  const market = evaluation.marketBaseline || {};
  const comparison = market.comparison || {};
  const modelMetrics = market.modelOnSameRows || evaluation.probabilityMetrics || {};
  const marketMetrics = market.metrics || {};
  const walkForward = evaluation.walkForwardValidation || {};
  const residual = evaluation.residualMarketWalkForward || {};
  const promotionAudit = evaluation.promotionEvidenceAudit || {};
  const promotionManifest = promotionAudit.manifest || {};
  const promotionSummary = promotionAudit.summary || {};
  const productionValidation = evaluation?.recommendationSelection?.productionValidation || {};
  return {
    version: evaluation.version || null,
    generatedAt: evaluation.generatedAt || null,
    modelRows: integer(modelMetrics.rows),
    pairedMarketRows: integer(comparison.rows ?? marketMetrics.rows),
    model: {
      accuracy: finite(modelMetrics.accuracy),
      brier: finite(modelMetrics.brier),
      logLoss: finite(modelMetrics.logLoss),
    },
    market: {
      accuracy: finite(marketMetrics.accuracy),
      brier: finite(marketMetrics.brier),
      logLoss: finite(marketMetrics.logLoss),
    },
    improvementVsMarket: {
      accuracy: finite(comparison.accuracyDelta),
      brier: finite(comparison.brierImprovement),
      logLoss: finite(comparison.logLossImprovement),
    },
    independentWindows: integer(walkForward?.sample?.folds ?? walkForward?.folds?.length),
    walkForwardEligible: walkForward.eligible === true,
    residualFolds: integer(residual?.sample?.completeFolds ?? residual?.folds?.length),
    residualProductionEligible: residual.productionEligible === true,
    immutablePromotionRows: integer(promotionManifest.eligibleRows ?? promotionSummary.eligibleRows ?? productionValidation.cohortRows),
    productionPolicyEligible: productionValidation.eligible === true,
    formalRecommendationRows: integer(evaluation?.recommendationMetrics?.total?.settled),
    riskTier: evaluation?.riskTiers?.overall?.tier || null,
  };
};

const providerAudit = (meta = {}) => {
  const status = meta.accountStatus || meta.apiAccess?.status || {};
  return {
    enabled: meta.skipped !== true || !/not configured|ENABLE_API_FOOTBALL_SYNC=0/i.test(String(meta.reason || "")),
    eligible: status.eligible === true,
    blocked: status.blocked === true || meta.failClosed === true,
    blockers: Array.isArray(status.blockers) ? status.blockers : [],
    reason: status.reason || meta.reason || null,
    checkedAt: status.checkedAt || meta.finishedAt || null,
  };
};

const acquisitionCatalog = Object.freeze({
  officialOdds: {
    impact: "critical",
    source: "Sporttery relay snapshot and official HAD/HHAD endpoints",
    mode: "continuous-structured",
    use: "numeric",
    requirement: "Preserve provider observedAt, local receivedAt and sourceCycleId before cutoff.",
  },
  sourceCycle: {
    impact: "critical",
    source: "Local sync/relay acquisition envelope",
    mode: "continuous-provenance",
    use: "governance",
    requirement: "Generate a deterministic cycle id from the acquired payload envelope; never backfill old rows.",
  },
  resultObserved: {
    impact: "critical",
    source: "Official Sporttery fast-result lane",
    mode: "continuous-structured",
    use: "settlement",
    requirement: "Store official event version, observedAt, receivedAt and exact score append-only.",
  },
  lineup: {
    impact: "high",
    source: "API-Football lineups or time-stamped official club/competition releases",
    mode: "near-kickoff-structured",
    use: "numeric-after-validation",
    requirement: "Entity-map players and teams; projected XI and official XI must be separate features.",
  },
  injuries: {
    impact: "high",
    source: "API-Football injuries plus cited official club reports",
    mode: "event-structured",
    use: "numeric-after-validation",
    requirement: "Keep status, player importance, source URL, observedAt and receivedAt; stale reports expire.",
  },
  xg: {
    impact: "high",
    source: "StatsBomb Open Data for historical experiments; licensed current provider for live coverage",
    mode: "historical-events",
    use: "shadow-training",
    requirement: "Open data cannot be presented as universal live coverage; train and validate per competition.",
  },
  standings: {
    impact: "medium",
    source: "Official competition tables or API-Football standings",
    mode: "daily-structured",
    use: "numeric-after-validation",
    requirement: "Use the table state observed before the forecast, never final standings.",
  },
  motivationStage: {
    impact: "medium",
    source: "Official competition rules, stage and table state",
    mode: "rule-plus-structured",
    use: "derived-feature",
    requirement: "Derive deterministic pressure features; free-text opinions stay explanatory only.",
  },
  referee: {
    impact: "medium",
    source: "Official appointments plus historical event/card data",
    mode: "event-structured",
    use: "shadow-training",
    requirement: "Require enough referee-match history before numerical influence.",
  },
  teamCards: {
    impact: "medium",
    source: "Structured match event feeds such as StatsBomb Open Data where covered",
    mode: "historical-events",
    use: "shadow-training",
    requirement: "Normalize competition and red-card game state; do not synthesize card counts.",
  },
  weather: {
    impact: "low",
    source: "Open-Meteo or equivalent historical forecast endpoint",
    mode: "forecast-structured",
    use: "shadow-training",
    requirement: "Store the forecast issue time and venue coordinates, not post-match observed weather.",
  },
  webConsensus: {
    impact: "low",
    source: "Cited web evidence documents",
    mode: "retrieval-evidence",
    use: "advisory-display-only",
    requirement: "RAG may retrieve, quarantine and summarize cited evidence, but it never changes probabilities, risk penalties, recommendation direction or promotion eligibility.",
  },
  externalMarket: {
    impact: "medium",
    source: "The Odds API or licensed bookmaker history",
    mode: "time-series-structured",
    use: "benchmark-and-clv",
    requirement: "Keep bookmaker, market, line, observedAt and receivedAt; respect plan/licence limits.",
  },
  providerEntityMapping: {
    impact: "high",
    source: "Verified Sporttery-to-provider fixture co-occurrence",
    mode: "append-only-identity-evidence",
    use: "entity-resolution",
    requirement: "Require stable local team id, exact provider team id, high fixture confidence and no reversed/collision evidence.",
  },
});

const acquisitionQueueFor = (coverage, provider) => {
  const ranks = { critical: 4, high: 3, medium: 2, low: 1 };
  const thresholds = {
    officialOdds: 95,
    sourceCycle: 100,
    resultObserved: 100,
    lineup: 70,
    injuries: 70,
    xg: 60,
    standings: 80,
    motivationStage: 80,
    referee: 50,
    teamCards: 50,
    weather: 50,
    webConsensus: 40,
    externalMarket: 50,
    providerEntityMapping: 90,
  };
  const queue = [];
  for (const [feature, catalog] of Object.entries(acquisitionCatalog)) {
    const item = coverage.features[feature];
    if (!item || item.coveragePct >= thresholds[feature]) continue;
    const providerBlocked = provider.blocked && ["lineup", "injuries", "standings"].includes(feature);
    queue.push({
      feature,
      priority: catalog.impact,
      coveragePct: item.coveragePct,
      targetPct: thresholds[feature],
      missingRows: Math.max(0, item.total - item.covered),
      providerBlocked,
      ...catalog,
    });
  }
  return queue.sort((left, right) => (
    ranks[right.priority] - ranks[left.priority]
    || right.missingRows - left.missingRows
    || left.feature.localeCompare(right.feature)
  ));
};

const learningReadinessFor = ({ evaluation, snapshotClocks, provider }) => {
  const blockers = [];
  if ((evaluation.pairedMarketRows || 0) < MIN_PAIRED_ROWS) blockers.push("paired-market-rows-below-500");
  if ((evaluation.independentWindows || 0) < MIN_INDEPENDENT_WINDOWS) blockers.push("independent-windows-below-6");
  if ((evaluation.residualFolds || 0) < MIN_RESIDUAL_FOLDS) blockers.push("residual-walk-forward-folds-below-3");
  if ((evaluation.immutablePromotionRows || 0) < 1) blockers.push("immutable-promotion-evidence-empty");
  if (evaluation.improvementVsMarket.brier === null || evaluation.improvementVsMarket.brier <= 0) {
    blockers.push("model-does-not-beat-market-brier");
  }
  if (evaluation.improvementVsMarket.logLoss === null || evaluation.improvementVsMarket.logLoss <= 0) {
    blockers.push("model-does-not-beat-market-logloss");
  }
  if (snapshotClocks.v2Rows < 1 || snapshotClocks.completeClockPct < 95) {
    blockers.push("decision-snapshot-clock-coverage-below-95pct");
  }
  if (provider.blocked) blockers.push("supplemental-provider-blocked");
  return {
    status: blockers.length ? "blocked-shadow" : "candidate-review",
    productionActivationAllowed: false,
    blockers,
    thresholds: {
      pairedMarketRows: MIN_PAIRED_ROWS,
      independentWindows: MIN_INDEPENDENT_WINDOWS,
      residualFolds: MIN_RESIDUAL_FOLDS,
      completeSnapshotClockPct: 95,
    },
    policy: "The learning loop may register and evaluate shadow candidates autonomously. Production activation remains fail-closed and requires audited evidence plus an exact runtime contract.",
  };
};

const buildCapabilityAudit = ({
  matches = [],
  snapshots = [],
  evaluation = {},
  apiFootballMeta = {},
  entityRegistry = {},
  sourceHashes = {},
  generatedAt = new Date().toISOString(),
} = {}) => {
  const coverage = coverageFor(matches);
  const snapshotClocks = snapshotClockAudit(snapshots);
  const entityResolution = entityResolutionAudit(entityRegistry, matches);
  coverage.features.providerEntityMapping = {
    covered: entityResolution.mappedScopeTeamIds,
    total: entityResolution.scopeTeamIds,
    coveragePct: entityResolution.mappedScopeCoveragePct,
  };
  const evaluationSummary = evaluationAudit(evaluation);
  const provider = providerAudit(apiFootballMeta);
  const learningReadiness = learningReadinessFor({ evaluation: evaluationSummary, snapshotClocks, provider });
  const acquisitionQueue = acquisitionQueueFor(coverage, provider);
  const body = {
    version: VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    sourceHashes: stableValue(sourceHashes),
    capability: {
      status: learningReadiness.status,
      calibratedProbabilityClaim: evaluationSummary.pairedMarketRows > 0,
      hitRateClaim: "descriptive-only-until-formal-recommendation-sample-is-sufficient",
      marketBenchmarkRequired: true,
    },
    evaluation: evaluationSummary,
    dataCoverage: coverage,
    snapshotClocks,
    providers: { apiFootball: provider },
    entityResolution,
    learningReadiness,
    acquisitionQueue,
    aiBoundary: {
      numericControl: false,
      ragRecommended: true,
      allowed: [
        "retrieve cited pre-match documents",
        "extract candidate injury, lineup, motivation and rule claims into a quarantine schema",
        "explain model evidence and blockers",
      ],
      prohibited: [
        "override model probabilities",
        "apply numeric risk penalties or change recommendation direction",
        "create missing structured statistics",
        "rewrite post-cutoff recommendations",
        "promote a model without deterministic backtest gates",
      ],
      promotionRule: "RAG-derived claims remain quarantined advisory evidence only. They never become numeric model inputs or promotion evidence; independently licensed structured data must enter through its own point-in-time pipeline.",
    },
  };
  return {
    ...body,
    auditHash: sha256(stableStringify(body)),
  };
};

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
};

const main = () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = path.resolve(process.env.CAPABILITY_AUDIT_DATA_DIR || path.join(rootDir, "public", "data"));
  const storeDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data"));
  const files = {
    matches: path.resolve(process.env.CAPABILITY_AUDIT_MATCHES_FILE || path.join(dataDir, "matches-current.json")),
    snapshots: path.resolve(process.env.CAPABILITY_AUDIT_SNAPSHOTS_FILE || path.join(dataDir, "prediction-snapshots.json")),
    evaluation: path.resolve(process.env.CAPABILITY_AUDIT_EVALUATION_FILE || path.join(dataDir, "model-evaluation.json")),
    apiFootballMeta: path.resolve(process.env.CAPABILITY_AUDIT_API_META_FILE || path.join(dataDir, "api-football-meta.json")),
    entityRegistry: path.resolve(
      process.env.CAPABILITY_AUDIT_ENTITY_REGISTRY_FILE
        || path.join(storeDir, "entity-resolution", "team-registry.json"),
    ),
  };
  const sourceHashes = Object.fromEntries(Object.entries(files).map(([key, file]) => [
    key,
    fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null,
  ]));
  const audit = buildCapabilityAudit({
    matches: readJson(files.matches, []),
    snapshots: readJson(files.snapshots, []),
    evaluation: readJson(files.evaluation, {}),
    apiFootballMeta: readJson(files.apiFootballMeta, {}),
    entityRegistry: readJson(files.entityRegistry, {}),
    sourceHashes,
  });
  const outputFile = path.resolve(
    process.env.CAPABILITY_AUDIT_OUTPUT_FILE
      || path.join(storeDir, "model-artifacts", "prediction-capability-audit.json"),
  );
  writeJsonAtomic(outputFile, audit);
  console.log(JSON.stringify({
    ok: true,
    version: audit.version,
    outputFile,
    auditHash: audit.auditHash,
    status: audit.learningReadiness.status,
    blockers: audit.learningReadiness.blockers,
    acquisitionQueue: audit.acquisitionQueue.map((item) => ({
      feature: item.feature,
      priority: item.priority,
      coveragePct: item.coveragePct,
      providerBlocked: item.providerBlocked,
    })),
    aiNumericControl: audit.aiBoundary.numericControl,
  }, null, 2));
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  VERSION,
  acquisitionQueueFor,
  buildCapabilityAudit,
  coverageFor,
  entityResolutionAudit,
  evaluationAudit,
  featureStateFor,
  learningReadinessFor,
  providerAudit,
  snapshotClockAudit,
  stableStringify,
};
