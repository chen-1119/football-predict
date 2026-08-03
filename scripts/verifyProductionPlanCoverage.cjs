const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getSqliteStatus } = require("../server/sqliteStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const productionStoreDir = "/var/lib/football-predict";
const productionSqlitePath = path.join(productionStoreDir, "football.db");
const defaultStoreDir = fs.existsSync(productionSqlitePath)
  ? productionStoreDir
  : path.join(rootDir, "server-data");
const storeDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || defaultStoreDir;
const sqliteDbPath = process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db");

const readText = (filePath) => {
  try {
    return fs.readFileSync(path.join(rootDir, filePath), "utf8");
  } catch {
    return "";
  }
};

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, filePath), "utf8"));
  } catch {
    return fallback;
  }
};

const sha256File = (filePath) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(rootDir, filePath))).digest("hex");
  } catch {
    return null;
  }
};

const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));

const referenceShadowRuleMaps = Object.freeze({
  market: "gateByMarket",
  profile: "gateByProfile",
  marketProfile: "gateByMarketProfile",
  oddsBucket: "gateByOddsBucket",
  tip: "gateByTip",
  webConsensus: "gateByWebConsensus",
});

const embeddedReferenceStrategyAudit = (strategy) => {
  if (!strategy) {
    return {
      present: false,
      ok: true,
      activeGateCountsMatch: true,
      activeRuleCount: 0,
      unsafeRuleKeys: [],
    };
  }

  const unsafeRuleKeys = [];
  let activeRuleCount = 0;
  let activeGateCountsMatch = true;
  for (const [activeGateKey, ruleMapKey] of Object.entries(referenceShadowRuleMaps)) {
    const rules = strategy?.[ruleMapKey] && typeof strategy[ruleMapKey] === "object"
      ? Object.entries(strategy[ruleMapKey])
      : [];
    const tighteningRows = rules.filter(([, rule]) => rule?.onlineAction === "tighten");
    activeRuleCount += tighteningRows.length;
    if (Number(strategy?.activeGates?.[activeGateKey] || 0) !== tighteningRows.length) {
      activeGateCountsMatch = false;
    }
    for (const [ruleKey, rule] of rules) {
      const adjustments = rule?.adjustments || {};
      const safe = ["observe", "tighten"].includes(rule?.onlineAction)
        && Number(adjustments.minProbabilityBoost || 0) >= 0
        && Number(adjustments.minModelGapBoost || 0) >= 0
        && Number(adjustments.minHandicapSupportBoost || 0) >= 0
        && Number(adjustments.trustPenalty || 0) >= 0
        && Number(adjustments.maxRiskTagsDelta || 0) <= 0
        && Number(adjustments.goalsMinBoost || 0) >= 0;
      if (!safe) unsafeRuleKeys.push(`${ruleMapKey}:${ruleKey}`);
    }
  }

  const sampleReadyForActiveRules = activeRuleCount === 0 || (
    Number(strategy?.sample?.decisionRows || 0) >= 50
    && Number(strategy?.sample?.independentMatchDays || 0) >= 4
  );
  const isolatedFromFormalPromotion = !strategy?.activation?.promotionGate
    && !strategy?.recommendationSelection
    && !strategy?.activation?.modelSignal
    && !strategy?.activation?.modelSignalEffect;

  return {
    present: true,
    ok: strategy?.activation?.mode === "reference-shadow-tightening"
      && strategy?.activation?.onlineEffect === "tighten-only-reference-shadow"
      && strategy?.activation?.promotionAllowed === false
      && strategy?.activation?.looseningAllowed === false
      && strategy?.referenceShadowRows?.promotionEligible === false
      && strategy?.referenceShadowRows?.countedInFormalMetrics === false
      && activeGateCountsMatch
      && sampleReadyForActiveRules
      && isolatedFromFormalPromotion
      && unsafeRuleKeys.length === 0,
    activeGateCountsMatch,
    activeRuleCount,
    sampleReadyForActiveRules,
    isolatedFromFormalPromotion,
    unsafeRuleKeys,
  };
};

const checks = [];
const watch = [];

const pushCheck = (phase, name, ok, evidence = {}, required = true) => {
  checks.push({ phase, name, required, ok: Boolean(ok), evidence });
};

const pushWatch = (phase, name, details = {}) => {
  watch.push({ phase, name, ...details });
};

const packageJson = readJson("package.json", { scripts: {} });
const scripts = packageJson.scripts || {};
const serverIndex = readText("server/index.cjs");
const dataStore = readText("server/dataStore.cjs");
const sqliteStore = readText("server/sqliteStore.cjs");
const sqliteExporter = readText("scripts/exportDataStoreSqlite.cjs");
const syncData = readText("scripts/syncData.cjs");
const archivedPreMatchPrediction = readText("src/services/archivedPreMatchPrediction.ts");
const verifyArchivedPreMatchCutoff = readText("scripts/verifyArchivedPreMatchCutoff.cjs");
const syncWorker = readText("scripts/runSyncWorker.cjs");
const syncUefaOfficialResults = readText("scripts/syncUefaOfficialResults.cjs");
const verifyUefaOfficialResults = readText("scripts/verifyUefaOfficialResults.cjs");
const syncOfficialClubResults = readText("scripts/syncOfficialClubResults.cjs");
const verifyOfficialClubResults = readText("scripts/verifyOfficialClubResults.cjs");
const officialClubResultSources = readText("scripts/data/official-club-result-sources.json");
const fastResultPublisher = readText("scripts/publishOfficialResultsFast.cjs");
const fastResultPublisherProtocol = readText("scripts/fastResultPublisherProtocol.cjs");
const syncMetaCommitLock = readText("scripts/syncMetaCommitLock.cjs");
const verifyFastResultPublication = readText("scripts/verifyFastResultPublication.cjs");
const relayFastResultWatcher = readText("server/relayFastResultWatcher.cjs");
const verifyRelayFastResultWatcher = readText("scripts/verifyRelayFastResultWatcher.cjs");
const verifySqliteIncrementalExport = readText("scripts/verifySqliteIncrementalExport.cjs");
const nginxSite = readText("deploy/light-server/nginx.conf");
const nginxHttpCommon = readText("deploy/light-server/nginx-http-common.conf");
const nginxServerCommon = readText("deploy/light-server/nginx-server-common.conf");
const nginxSecurityHeaders = readText("deploy/light-server/nginx-security-headers.conf");
const nginxTlsTemplate = readText("deploy/light-server/nginx-tls-site.conf.template");
const enableNginxTls = readText("deploy/light-server/enable-nginx-tls.sh");
const nginx = [nginxHttpCommon, nginxSecurityHeaders, nginxServerCommon, nginxSite].join("\n");
const envExample = readText("deploy/light-server/env.example");
const workerService = readText("deploy/light-server/football-sync-worker.service");
const monitorService = readText("deploy/light-server/football-monitor.service");
const releaseScript = readText("deploy/light-server/release.sh");
const bundleReleaseScript = readText("deploy/light-server/release-from-bundle.sh");
const releaseHeartbeatKeeper = readText("scripts/runReleaseCandidateHeartbeatKeeper.cjs");
const releaseSyncWriteBarrier = readText("scripts/runReleaseSyncWriteBarrier.cjs");
const releasePrebuildPolicy = readText("scripts/releasePrebuildPolicy.cjs");
const sqliteReleaseSeal = readText("scripts/sqliteReleaseSeal.cjs");
const releaseTransitionLease = readText("scripts/releaseTransitionLease.cjs");
const verifyReleaseTransitionLease = readText("scripts/verifyReleaseTransitionLease.cjs");
const compactPublicOddsHistory = readText("scripts/compactPublicOddsHistory.cjs");
const cloudPush = readText("scripts/pushCloudSync.cjs");
const runCloudSync = readText("scripts/runCloudSync.ps1");
const runSportteryRelayPush = readText("scripts/runSportteryRelayPush.ps1");
const installSportteryRelayTask = readText("scripts/installSportteryRelayTask.ps1");
const runSportteryRelayPushHidden = readText("scripts/runSportteryRelayPushHidden.vbs");
const sportteryFastResultLane = readText("scripts/sportteryFastResultLane.cjs");
const runSportteryFastResultLane = readText("scripts/runSportteryFastResultLane.cjs");
const runSportteryFastResultLanePs = readText("scripts/runSportteryFastResultLane.ps1");
const runSportteryFastResultLaneHidden = readText("scripts/runSportteryFastResultLaneHidden.vbs");
const installSportteryFastResultLaneTask = readText("scripts/installSportteryFastResultLaneTask.ps1");
const verifySportteryFastResultLane = readText("scripts/verifySportteryFastResultLane.cjs");
const verifySportteryRelayDualFile = readText("scripts/verifySportteryRelayDualFile.cjs");
const verifySportteryRelayDualLaneServer = readText("scripts/verifySportteryRelayDualLaneServer.cjs");
const createReleaseBundle = readText("scripts/createReleaseBundle.cjs");
const verifyReleaseBundleSafety = readText("scripts/verifyReleaseBundleSafety.cjs");
const createOfflineReleaseKit = readText("scripts/createOfflineReleaseKit.cjs");
const restoreSshOperatorKey = readText("deploy/light-server/restore-ubuntu-operator-key.sh");
const verifySshOperatorKeyRecovery = readText("scripts/verifySshOperatorKeyRecovery.cjs");
const deployReleaseBundle = readText("scripts/deployReleaseBundle.cjs");
const releaseSshHostKeyPin = readText("scripts/releaseSshHostKeyPin.cjs");
const verifyReleaseSshHostKeyPin = readText("scripts/verifyReleaseSshHostKeyPin.cjs");
const releaseSigning = readText("scripts/releaseSigning.cjs");
const releaseWrapper = readText("deploy/light-server/football-release");
const releaseRecoveryHelper = readText("deploy/light-server/football-release-recovery.cjs");
const relayPromoter = readText("deploy/light-server/football-relay-promote");
const releaseBootstrap = readText("deploy/light-server/bootstrap-release-entrypoints.sh");
const releaseSudoers = readText("deploy/light-server/football-automation.sudoers");
const verifySignedReleaseEntrypoints = readText("scripts/verifySignedReleaseEntrypoints.cjs");
const verifyReleaseRecovery = readText("scripts/verifyReleaseRecovery.cjs");
const verifyCleanupRelayHardening = readText("scripts/verifyCleanupRelayHardening.cjs");
const watchReleaseWindow = readText("scripts/watchReleaseWindow.cjs");
const verifyReleaseWatchPolicy = readText("scripts/verifyReleaseWatchPolicy.cjs");
const checkReleaseStatus = readText("scripts/checkReleaseStatus.cjs");
const runtimeMonitor = readText("scripts/checkServerRuntime.cjs");
const verifyRuntimeCandidateCapture = readText("scripts/verifyRuntimeCandidateCaptureMonitor.cjs");
const candidateProspectiveTemporalAudit = readText("server/candidateProspectiveTemporalAudit.cjs");
const verifyCandidateProspectiveTemporalAudit = readText("scripts/verifyCandidateProspectiveTemporalAudit.cjs");
const startLocalPreview = readText("scripts/startLocalPreview.cjs");
const lightServerDoc = readText("docs/light-server-deployment.md");
const viteConfig = readText("vite.config.ts");
const staticDistDataPolicy = readText("scripts/staticDistDataPolicy.cjs");
const stripLargeStaticPayloadsScript = readText("scripts/stripLargeStaticPayloads.cjs");
const appContext = readText("src/context/AppContext.tsx");
const appContextCore = readText("src/context/AppContextCore.ts");
const predictionsList = readText("src/pages/PredictionsList.tsx");
const modelBacktest = readText("scripts/runModelBacktest.cjs");
const oddsObservationTrail = readText("src/services/oddsObservationTrail.cjs");
const verifyOddsObservationTrail = readText("scripts/verifyOddsObservationTrail.cjs");
const privateModelArtifactStore = readText("scripts/privateModelArtifactStore.cjs");
const modelStrategy = readText("scripts/optimizePredictionStrategy.cjs");
const hhadCompanionEvaluation = readText("src/services/hhadCompanionShadowEvaluation.cjs");
const verifyHhadCompanionEvaluation = readText("scripts/verifyHhadCompanionShadowEvaluation.cjs");
const hhadCompanionPublicContract = readText("scripts/hhadCompanionPublicContract.cjs");
const verifyProduction = readText("scripts/verifyProductionReadiness.cjs");
const verifyApiContracts = readText("scripts/verifyApiContracts.cjs");
const verifyFrontend = readText("scripts/verifyFrontendObservability.cjs");
const verifyCloudSyncFreshness = readText("scripts/verifyCloudSyncFreshness.cjs");
const verifyServerPrimary = readText("scripts/verifyServerPrimaryDataFlow.cjs");
const verifyCurrentLaneFreshness = readText("scripts/verifyCurrentLaneFreshness.cjs");
const currentMatchRetention = readText("scripts/currentMatchRetention.cjs");
const verifyCurrentMatchRetention = readText("scripts/verifyCurrentMatchRetention.cjs");
const verifyDeploymentConfig = readText("scripts/verifyDeploymentConfig.cjs");
const verifyRuntimeStability = readText("scripts/verifyRuntimeStability.cjs");
const verifyReviewSettlement = readText("scripts/verifyReviewSettlementPresentation.cjs");
const verifyDataStoreOddsState = readText("scripts/verifyDataStoreOddsStateDedup.cjs");
const streamingCompactor = readText("scripts/compactDataStore.cjs");
const verifyStreamingCompactor = readText("scripts/verifyStreamingDataStoreCompaction.cjs");
const verifySyncDataMemorySafety = readText("scripts/verifySyncDataMemorySafety.cjs");
const relayLaneFreshness = readText("scripts/relayLaneFreshness.cjs");
const verifyRelayLaneFreshness = readText("scripts/verifyRelayLaneFreshness.cjs");
const matchLifecycle = readText("src/services/matchLifecycle.cjs");
const verifyMatchLifecycle = readText("scripts/verifyMatchLifecycleReconciliation.cjs");
const verifyPerf = readText("scripts/verifyApiPerformance.cjs");
const verifyFallback = readText("scripts/verifySourceFallback.cjs");
const verifyRemotePublic = readText("scripts/verifyRemotePublicReadiness.cjs");
const captureCandidateProspectiveDeadline = readText(
  "scripts/captureCandidateProspectiveDeadline.cjs"
);
const verifyCandidateReadinessFullCoverage = readText(
  "scripts/verifyCandidateReadinessFullCoverage.cjs"
);
const watchCandidateProspectiveCapture = readText(
  "scripts/watchCandidateProspectiveCapture.cjs"
);
const verifyRemoteRefresh = readText("scripts/verifyRemoteRefreshPipeline.cjs");
const verifyRemoteRefreshContract = readText("scripts/verifyRemoteRefreshPipelineContract.cjs");
const verifyRemoteRecommendationParity = readText("scripts/verifyRemoteRecommendationParity.cjs");
const verifyRemoteRecommendationParityContract = readText(
  "scripts/verifyRemoteRecommendationParityContract.cjs"
);
const recommendationProjectionParity = readText(
  "server/recommendationProjectionParity.cjs"
);
const verifyRecommendationProjectionParity = readText(
  "scripts/verifyRecommendationProjectionParity.cjs"
);
const verifyTlsReadiness = readText("scripts/verifyTlsReadiness.cjs");
const verifyLlm = readText("scripts/verifyLlmReviewBoundary.cjs");
const verifyLlmEvidence = readText("scripts/verifyLlmEvidenceBoundary.cjs");
const verifyAudit = readText("scripts/verifyPredictionAudit.cjs");
const verifyModelInputAudit = readText("scripts/verifyModelInputAudit.cjs");
const verifyModelRiskTiers = readText("scripts/verifyModelRiskTiers.cjs");
const verifyModelPromotionGate = readText("scripts/verifyModelPromotionGate.cjs");
const verifyRecommendationEligibility = readText("scripts/verifyRecommendationEligibility.cjs");
const verifyLiveRecommendationLayer = readText("scripts/verifyLiveRecommendationLayer.cjs");
const verifyBetSlipRecommendationGate = readText("scripts/verifyBetSlipRecommendationGate.cjs");
const verifyServerRecommendationBoundary = readText("scripts/verifyServerRecommendationBoundary.cjs");
const verifyPredictionFeatureAsOf = readText("scripts/verifyPredictionFeatureAsOf.cjs");
const verifySportteryRelaySnapshot = readText("scripts/verifySportteryRelaySnapshot.cjs");
const verifyRelaySnapshotUploadSerialization = readText("scripts/verifyRelaySnapshotUploadSerialization.cjs");
const verifySportteryEgress = readText("scripts/verifySportteryEgress.cjs");
const verifySportteryRelayProxy = readText("scripts/verifySportteryRelayProxy.cjs");
const sportteryRelayCircuit = readText("scripts/sportteryRelayCircuit.cjs");
const verifySportteryRelayCircuit = readText("scripts/verifySportteryRelayCircuitBreaker.cjs");
const verifySportteryRelayFullRecovery = readText("scripts/verifySportteryRelayFullRecovery.cjs");
const configureSportteryProxy = readText("scripts/configureSportteryRelayProxy.cjs");
const sportteryRelayPush = readText("scripts/pushSportteryRelaySnapshot.cjs");
const cloudflareWorker = readText("cloudflare/sync-trigger/src/index.js");
const githubSyncWorkflow = readText(".github/workflows/sync.yml");
const githubPagesWorkflow = readText(".github/workflows/deploy.yml");
const modelEvaluation = readJson(path.join("public", "data", "model-evaluation.json"), null);
const modelEvaluationSha256 = sha256File(path.join("public", "data", "model-evaluation.json"));
const formalStrategy = readJson(path.join("public", "data", "model-strategy.json"), null);
const publicCalibration = readJson(path.join("public", "data", "model-calibration.json"), null);
const embeddedReferenceStrategy = publicCalibration?.strategy || null;
const referenceStrategyAudit = embeddedReferenceStrategyAudit(embeddedReferenceStrategy);
const syncMeta = readJson(path.join("public", "data", "sync-meta.json"), null);
const runtimeConfig = readJson(path.join("public", "data", "runtime-config.json"), null);

const requiredScripts = [
  "datastore:sqlite",
  "sync:worker",
  "sync:wikidata-entity-candidates",
  "sync:sporttery-snapshot",
  "entities:review",
  "collector:key:generate",
  "publish:official-results-fast",
  "sync:sporttery-result-fast",
  "sync:sporttery-result-fast-watch",
  "sync:sporttery-result-fast-install-task",
  "sync:uefa-results",
  "sync:official-club-results",
  "configure:sporttery-proxy",
  "release:bundle",
  "release:signing-key",
  "release:offline-kit",
  "release:deploy-bundle",
  "release:recover",
  "release:watch",
  "release:status",
  "verify:release-watch",
  "model:backtest",
  "optimize:strategy",
  "verify:prediction-audit",
  "verify:prediction-feature-asof",
  "verify:collector-attestation",
  "verify:collector-quorum",
  "verify:collector-runtime",
  "verify:market-source-provenance",
  "verify:odds-observation-trail",
  "verify:odds-observation-backtest",
  "verify:recommendation-selection-time-order",
  "verify:model-input-audit",
  "verify:model-risk-tiers",
  "verify:shadow-candidate-robustness",
  "verify:model-promotion",
  "verify:prediction-direction-integrity",
  "verify:walk-forward",
  "verify:web-consensus-evidence",
  "verify:rag-neutrality",
  "verify:wikidata-entity-candidates",
  "verify:entity-master-data",
  "verify:asof-result-timeline",
  "verify:market-movement",
  "verify:hhad-companion-evaluation",
  "verify:high-sp-safeguard",
  "verify:recommendation-eligibility",
  "verify:live-recommendations",
  "verify:bet-slip-gate",
  "verify:server-recommendation-boundary",
  "verify:llm-boundary",
  "verify:llm-evidence-boundary",
  "verify:sync-lock",
  "verify:runtime-stability",
  "verify:sync-data-memory",
  "verify:release-enrichment-reuse",
  "verify:review-settlement",
  "verify:fast-result-publication",
  "verify:uefa-official-results",
  "verify:official-club-results",
  "verify:relay-fast-watcher",
  "verify:relay-upload-serialization",
  "verify:atomic-refresh",
  "verify:sync-worker-events",
  "verify:publication-ledger",
  "verify:datastore-odds-state",
  "verify:datastore-compaction",
  "verify:sqlite-incremental",
  "verify:private-model-artifact",
  "verify:api-contracts",
  "verify:access-code-concurrency",
  "verify:frontend-observability",
  "verify:frontend-accessibility",
  "verify:frontend-evidence-semantics",
  "verify:benchmark-selection",
  "verify:benchmark-prospective-ledger",
  "verify:candidate-prospective-ledger",
  "verify:candidate-prospective-admission",
  "verify:candidate-prospective-goal",
  "verify:candidate-prospective-challengers",
  "verify:candidate-temperature-neutralization",
  "verify:candidate-common-cohort-g2",
  "verify:candidate-common-cohort-g2:terminal",
  "verify:candidate-deadline-capture",
  "watch:candidate-prospective-capture",
  "verify:predictions-page-focus",
  "verify:cloudflare-worker-policy",
  "verify:cloudflare-sporttery-collector",
  "verify:cloud-sync-freshness",
  "verify:server-primary",
  "verify:current-lane-freshness",
  "verify:current-match-retention",
  "verify:deployment-config",
  "verify:release-host-key-pin",
  "verify:ssh-key-recovery",
  "verify:cleanup-relay-hardening",
  "verify:tls",
  "verify:signed-release-entrypoints",
  "verify:release-transaction-safety",
  "verify:release-sync-write-barrier",
  "verify:release-transition-lease",
  "verify:release-recovery",
  "verify:legacy-release-disabled",
  "verify:remote-public",
  "verify:fallback-readiness",
  "verify:remote-refresh",
  "verify:remote-refresh:strict",
  "verify:remote-refresh-contract",
  "verify:remote-recommendation-parity",
  "verify:remote-recommendation-parity-contract",
  "verify:recommendation-projection-parity",
  "verify:plan-coverage",
  "verify:production-plan",
  "verify:sporttery-relay",
  "verify:sporttery-relay-circuit",
  "verify:sporttery-relay-dual-file",
  "verify:sporttery-relay-dual-server",
  "verify:sporttery-relay-full-recovery",
  "verify:sporttery-result-fast",
  "verify:relay-lane-freshness",
  "verify:match-lifecycle",
  "verify:match-detail-lifecycle",
  "verify:prediction-metric-semantics",
  "verify:sporttery-egress",
  "verify:sporttery-relay-proxy",
  "verify:source-fallback",
  "verify:production",
  "verify:perf"
];

const optionalFallbackScripts = [
  "sync:sporttery-relay-push",
  "sync:sporttery-relay-watch",
  "sync:sporttery-relay-install-task",
  "sync:cloud-push",
  "sync:cloud-watch",
  "sync:cloud-install-task"
];

const modelIntegrityGateSpecs = [
  {
    id: "prediction-direction-integrity",
    label: "prediction direction integrity behavior",
    npmScript: "verify:prediction-direction-integrity",
    file: "scripts/verifyPredictionDirectionIntegrity.cjs",
    validate: (body) => Number(body?.assertions || 0) > 0
      && Object.values(body?.guarantees || {}).length >= 4
      && Object.values(body?.guarantees || {}).every((value) => value === true),
  },
  {
    id: "walk-forward-validation",
    label: "walk-forward folds and non-overlap watermark behavior",
    npmScript: "verify:walk-forward",
    file: "scripts/verifyWalkForwardValidation.cjs",
    validate: (body) => body?.validationVersion === "walk-forward-promotion-validation-v3"
      && body?.protocolVersion === "nested-expanding-window-candidate-selection-v2"
      && Number(body?.eligible?.folds || 0) >= 6
      && body?.eligible?.watermark?.noOverlapVerified === true
      && /^[a-f0-9]{64}$/.test(String(body?.eligible?.foldManifestHash || ""))
      && /^[a-f0-9]{64}$/.test(String(body?.eligible?.featureModelHash || "")),
  },
  {
    id: "shadow-candidate-robustness",
    label: "candidate multiplicity and deterministic counterevidence behavior",
    npmScript: "verify:shadow-candidate-robustness",
    file: "scripts/verifyShadowCandidateRobustness.cjs",
    validate: (body) => body?.version === "shadow-candidate-robustness-v1"
      && Number(body?.checks || 0) >= 17
      && Number(body?.sample?.rows || 0) >= 500
      && Number(body?.sample?.candidates || 0) >= 4
      && Number(body?.sample?.adjustedTailAlpha || 0) > 0
      && Number(body?.sample?.adjustedTailAlpha || 0) < 0.025,
  },
  {
    id: "as-of-result-timeline",
    label: "as-of result observation timeline behavior",
    npmScript: "verify:asof-result-timeline",
    file: "scripts/verifyAsOfResultTimeline.cjs",
    validate: (body) => Number(body?.delayedObservation?.appliedResults) === 1
      && Number(body?.simultaneousKickoff?.appliedResults) === 0
      && body?.invalidClockExcluded?.fallback === true
      && body?.invalidClockExcluded?.promotionEligible === false,
  },
  {
    id: "market-movement",
    label: "devigged market movement and handicap cohort behavior",
    npmScript: "verify:market-movement",
    file: "scripts/verifyMarketMovement.cjs",
    validate: (body) => Number(body?.had?.changes?.["1"]?.probabilityDelta) > 0
      && Number(body?.had?.changes?.["2"]?.probabilityDelta) < 0
      && body?.hhad?.line?.direction === "home-gives-more"
      && Object.keys(body?.marginOnly?.changes || {}).length === 3
      && Object.values(body?.marginOnly?.changes || {})
        .every((change) => Number(change?.probabilityDelta) === 0),
  },
  {
    id: "clv-timing-audit",
    label: "closing-line timing denominator behavior",
    npmScript: "verify:clv-timing-audit",
    file: "scripts/verifyClvTimingAudit.cjs",
    validate: (body) => body?.version === "closing-line-timing-audit-v1"
      && Number(body?.assertions || 0) >= 16
      && Number(body?.sample?.candidateRows || 0) === 4
      && Number(body?.sample?.rows || 0) === 2
      && Number(body?.sample?.timingAudit?.reasonCounts?.SAME_OBSERVATION || 0) === 1,
  },
  {
    id: "odds-observation-trail",
    label: "official receipt-time odds observation trail behavior",
    npmScript: "verify:odds-observation-trail",
    file: "scripts/verifyOddsObservationTrail.cjs",
    validate: (body) => body?.version === "official-odds-observation-trail-v1"
      && Number(body?.assertions || 0) >= 13
      && Number(body?.sample?.observationCount || 0) === 2,
  },
  {
    id: "odds-observation-backtest",
    verifier: "model-backtest-odds-observation-time",
    label: "backtest uses official receipt clocks without capture-bucket lookahead",
    npmScript: "verify:odds-observation-backtest",
    file: "scripts/runModelBacktest.cjs",
    args: ["--verify-odds-observation-time"],
    validate: (body) => body?.verifier === "model-backtest-odds-observation-time"
      && Number(body?.assertions || 0) >= 4
      && Array.isArray(body?.checks)
      && body.checks.every((check) => check?.ok === true),
  },
  {
    id: "recommendation-selection-time-order",
    verifier: "model-backtest-recommendation-selection-time-order",
    label: "recommendation selection orders mixed timezone kickoffs by epoch and fails closed on invalid time",
    npmScript: "verify:recommendation-selection-time-order",
    file: "scripts/runModelBacktest.cjs",
    args: ["--verify-recommendation-selection-time-order"],
    validate: (body) => body?.verifier === "model-backtest-recommendation-selection-time-order"
      && Number(body?.assertions || 0) >= 4
      && Array.isArray(body?.checks)
      && body.checks.every((check) => check?.ok === true),
  },
  {
    id: "frontend-evidence-semantics",
    label: "frontend evidence-score and calibrated-probability semantics",
    npmScript: "verify:frontend-evidence-semantics",
    file: "scripts/verifyFrontendEvidenceSemantics.cjs",
    validate: (body) => Array.isArray(body?.checks)
      && Number(body?.assertions || 0) === body.checks.length
      && body.checks.length > 0
      && body.checks.every((check) => check?.ok === true),
  },
  {
    id: "sqlite-incremental-export",
    label: "SQLite prediction-state-v3 semantic identity behavior",
    npmScript: "verify:sqlite-incremental",
    file: "scripts/verifySqliteIncrementalExport.cjs",
    validate: (body) => {
      const firstPredictionSnapshots = Number(body?.firstCounts?.predictionSnapshots || 0);
      const finalPredictionSnapshots = Number(body?.finalCounts?.predictionSnapshots || 0);
      return body?.predictionStateIdentityVersion === "prediction-state-v3"
        && Number(body?.checks || 0) > 0
        && firstPredictionSnapshots > 0
        && finalPredictionSnapshots === firstPredictionSnapshots;
    },
  },
];

const runNodeVerifier = (file, args = []) => {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout || "");
  } catch {
    body = null;
  }
  return {
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    body,
    stdoutTail: result.status === 0 ? "" : String(result.stdout || "").slice(-500),
    stderrTail: String(result.stderr || "").slice(-500),
  };
};

const positiveRuntimeCounts = (status) => Number(status?.counts?.currentMatches || 0) > 0
  && Number(status?.counts?.historyMatches || 0) > 0
  && Number(status?.counts?.oddsSnapshots || 0) > 0
  && Number(status?.counts?.predictionSnapshots || 0) > 0;

const healthUrlCandidates = () => {
  const explicit = [
    process.env.VERIFY_PLAN_HEALTH_URL,
    process.env.VERIFY_BASE_URL,
    process.env.REMOTE_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.RELEASE_STATUS_PUBLIC_BASE_URL
  ].filter(Boolean);
  const urls = [];
  for (const value of explicit) {
    try {
      const url = new URL(value);
      if (!url.pathname || url.pathname === "/") url.pathname = "/api/v1/health";
      urls.push(url.toString());
    } catch {
      // Ignore malformed optional environment values.
    }
  }
  urls.push("http://127.0.0.1/api/v1/health", "http://localhost/api/v1/health");
  return [...new Set(urls)];
};

const fetchJsonWithTimeout = async (url, timeoutMs = 2000) => {
  if (typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const readHealthSqliteStatus = async () => {
  for (const url of healthUrlCandidates()) {
    const body = await fetchJsonWithTimeout(url);
    const sqlite = body?.storage?.sqlite || null;
    if (!sqlite?.counts && !sqlite?.legacyJsonl) continue;
    return {
      ...sqlite,
      available: sqlite.available === true,
      path: sqlite.path || sqliteDbPath,
      statusSource: "health",
      healthUrl: url,
      currentRead: body?.data?.currentRead || null
    };
  }
  return null;
};

const supportedLegacyJsonlVersion = (value) => [
  "legacy-jsonl-import-v1",
  "legacy-jsonl-incremental-v2",
].includes(String(value || ""));

const readPlanSqliteStatus = async () => {
  const direct = await getSqliteStatus(sqliteDbPath);
  if (positiveRuntimeCounts(direct) && supportedLegacyJsonlVersion(direct.legacyJsonl?.version)) {
    return { ...direct, statusSource: "direct" };
  }

  const health = await readHealthSqliteStatus();
  if (health && (positiveRuntimeCounts(health) || supportedLegacyJsonlVersion(health.legacyJsonl?.version))) {
    return {
      ...direct,
      ...health,
      statusSource: "health",
      directReason: direct.reason || null,
      directAvailable: direct.available === true
    };
  }

  return { ...direct, statusSource: "direct" };
};

(async () => {
  const sqliteStatus = await readPlanSqliteStatus();
  const modelIntegrityGateArtifacts = new Map(
    modelIntegrityGateSpecs.map((spec) => [spec.id, runNodeVerifier(spec.file, spec.args || [])]),
  );

  pushCheck("01-security-boundary", "versioned v1 public API routes", hasAll(serverIndex, [
    '"/api/v1/health"',
    '"/api/v1/source-health"',
    '"/api/v1/model/evaluation"',
    '"/api/v1/matches/current"',
    '"/api/v1/matches/history"',
    '"/api/v1/odds/history"'
  ]), { file: "server/index.cjs" });

  pushCheck("01-security-boundary", "protected recommendation reads", hasAll(serverIndex, [
    "isProtectedApiPath",
    'pathname === "/api/v1/matches/current"',
    'pathname === "/api/v1/matches/history"',
    'pathname === "/api/v1/odds/history"',
    "hasRecommendationAccess"
  ]), { file: "server/index.cjs" });

  pushCheck("01-security-boundary", "admin bearer only and query token denied by tests", hasAll(serverIndex, [
    "auth.toLowerCase().startsWith(\"bearer \")",
    "safeSecretEqual(bearer, adminToken)",
    "safeSecretEqual(bearer, accessCodeAdminToken)"
  ]) && hasAll(verifyProduction, [
    "sync admin query token denied",
    "model admin query token denied",
    "db query token denied",
    "access-code admin query token denied"
  ]), { files: ["server/index.cjs", "scripts/verifyProductionReadiness.cjs"] });

  pushCheck("01-security-boundary", "public model evaluation is redacted", hasAll(serverIndex, [
    "compactShadowCandidates",
    "compactInputAudit",
    "compactStrategyForPublic",
    "hiddenFields"
  ]) && hasAll(verifyApiContracts, [
    "model-evaluation public redaction",
    "model-evaluation input audit public summary",
    "model-evaluation risk tier public summary",
    "model-evaluation admin requires bearer",
    "model-evaluation query token denied"
  ]), { files: ["server/index.cjs", "scripts/verifyApiContracts.cjs"] });

  pushCheck("01-security-boundary", "recommendation boundary retries only across model-risk publication drift",
    hasAll(verifyApiContracts, [
      "recommendationBoundaryModel",
      "recommendationBoundaryRiskTier",
      "recommendationBoundaryAttempts",
      "detail.body?.recommendationRiskTier === recommendationBoundaryRiskTier",
      "scheduledBestRecommendationsAreServerSafe(detail.body?.match, globalRiskTier)"
    ]), { file: "scripts/verifyApiContracts.cjs" });

  pushCheck("02-data-warehouse-sync", "SQLite WAL schema has four incremental snapshot tables", hasAll(sqliteExporter, [
    "PRAGMA journal_mode = WAL",
    "CREATE TABLE IF NOT EXISTS source_snapshots",
    "CREATE TABLE IF NOT EXISTS match_snapshots",
    "const createOddsTable",
    "const createPredictionTable",
    "state_key TEXT UNIQUE",
    "football-sqlite-v2-incremental"
  ]), { file: "scripts/exportDataStoreSqlite.cjs" });

  const legacyJsonlRuntimeVersion = sqliteStatus.legacyJsonl?.version || null;
  pushCheck("02-data-warehouse-sync", "legacy JSONL import is cursor-incremental and migration-safe", hasAll(sqliteExporter, [
    "legacy-jsonl-incremental-v2",
    "processJsonlIncrement",
    "jsonl_cursor:",
    "legacy_jsonl_import",
    "jsonlMatchLimit",
    "jsonlOddsLimit",
    "jsonlPredictionLimit"
  ])
    && !sqliteExporter.includes("readJsonlTail")
    && scripts["verify:sqlite-incremental"] === "node scripts/verifySqliteIncrementalExport.cjs"
    && ["legacy-jsonl-import-v1", "legacy-jsonl-incremental-v2"].includes(legacyJsonlRuntimeVersion), {
    file: "scripts/exportDataStoreSqlite.cjs",
    behaviorVerifier: scripts["verify:sqlite-incremental"] || null,
    statusSource: sqliteStatus.statusSource || null,
    directReason: sqliteStatus.directReason || sqliteStatus.reason || null,
    sqliteLegacyJsonl: legacyJsonlRuntimeVersion,
    imported: sqliteStatus.legacyJsonl?.imported || null
  });

  pushCheck("02-data-warehouse-sync", "odds state persistence and JSONL maintenance stay bounded", hasAll(dataStore, [
    "odds-state-",
    "const stateKey = `${oddsKey}:${oddsRow.signature}`",
    "if (state.latestOddsSignatures[stateKey]) return false"
  ]) && hasAll(streamingCompactor, [
    "two-pass-streaming-atomic-swap",
    "two-pass-streaming-noop",
    "source-changed-during-streaming-compaction"
  ]) && hasAll(verifyDataStoreOddsState, [
    "timestamp-only changes must not create a new market state",
    "a real SP change must remain a distinct state"
  ]) && hasAll(verifyStreamingCompactor, [
    "a no-op compaction must preserve the JSONL cursor inode",
    "fresh-1299"
  ]), {
    files: [
      "server/dataStore.cjs",
      "scripts/compactDataStore.cjs",
      "scripts/verifyDataStoreOddsStateDedup.cjs",
      "scripts/verifyStreamingDataStoreCompaction.cjs"
    ],
    scripts: ["verify:datastore-odds-state", "verify:datastore-compaction"]
  });

  pushCheck("02-data-warehouse-sync", "official odds receipt trail prevents backtest capture-bucket lookahead", hasAll(oddsObservationTrail, [
    "official-odds-observation-trail-v1",
    "receivedAt",
    "effectiveDeadlineMs",
    "webapi.sporttery.cn"
  ]) && hasAll(syncData, [
    "withOddsObservationTrail",
    "pre-cutoff-state-change-plus-official-receipt-trail",
    "observationsAppended"
  ]) && hasAll(modelBacktest, [
    "oddsObservationTrailForRow",
    "capture buckets and sync replays are excluded",
    "--verify-odds-observation-time"
  ]) && hasAll(verifyOddsObservationTrail, [
    "a preserved response clock cannot fabricate a second observation",
    "laterSameOdds.observationCount"
  ]), {
    files: [
      "src/services/oddsObservationTrail.cjs",
      "scripts/syncData.cjs",
      "scripts/runModelBacktest.cjs",
      "scripts/verifyOddsObservationTrail.cjs"
    ],
    scripts: ["verify:odds-observation-trail", "verify:odds-observation-backtest"]
  });

  pushCheck("02-data-warehouse-sync", "recommendation selection chronology is epoch ordered and invalid time fails closed", hasAll(modelBacktest, [
    "compareRecommendationSelectionRows",
    "recommendationSelectionKickoffEpoch",
    "invalid-kickoff-time:",
    "--verify-recommendation-selection-time-order"
  ]), {
    file: "scripts/runModelBacktest.cjs",
    script: "verify:recommendation-selection-time-order"
  });

  pushCheck("02-data-warehouse-sync", "sync data large JSON publication is bounded and atomic", hasAll(syncData, [
    "STREAMING_JSON_MIN_ROWS",
    "writePrettyJsonStreaming",
    "filesHaveSameBytes",
    "loadExistingMatchStore",
    "shouldUseStreamingJson"
  ]) && !syncData.includes('const existingHistoryRows = readJsonArray(path.join(dataDir, "matches-history.json"))')
    && hasAll(verifySyncDataMemorySafety, [
      "byte-identical pretty JSON",
      "streaming no-op comparison is chunked",
      "serialization failure leaves the previous file intact",
      "shared 40MB payload writes under a 64MB V8 heap"
    ])
    && scripts["verify:sync-data-memory"] === "node scripts/verifySyncDataMemorySafety.cjs", {
      files: ["scripts/syncData.cjs", "scripts/verifySyncDataMemorySafety.cjs"],
      script: "verify:sync-data-memory"
    });

  pushCheck("02-data-warehouse-sync", "relay current, recent-result and archive freshness are independently timestamped", hasAll(relayLaneFreshness, [
    "summarizeRelayLanes",
    "HISTORY_METHODS",
    "RESULT_METHODS",
    "completenessTimeMs"
  ]) && hasAll(syncData, [
    "relayResultLane",
    "resultFreshnessTime",
    "relayHistoryLane",
    "relayHistoryStale",
    "SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES"
  ]) && hasAll(serverIndex, [
    "relayResultFreshnessTime",
    "relayResultFresh",
    "relayHistoryFreshnessTime",
    "relayHistoryFresh",
    "summarizeRelayLanes"
  ]) && hasAll(verifyRelayLaneFreshness, [
    "fresh result page 1 must not make the complete history lane fresh",
    "missing paged/history lane fails closed without breaking current"
  ]), {
    files: [
      "scripts/relayLaneFreshness.cjs",
      "scripts/syncData.cjs",
      "server/index.cjs",
      "scripts/verifyRelayLaneFreshness.cjs"
    ],
    script: "verify:relay-lane-freshness"
  });

  pushCheck("02-data-warehouse-sync", "match lifecycle is monotonic and reschedule-safe", hasAll(matchLifecycle, [
    "reconcileMatchLifecycle",
    "sameEvent",
    "official-result-conflict-terminal-preserved",
    "kickoff-overdue-awaiting-official-result"
  ]) && hasAll(serverIndex, [
    "resolveMatchLifecycle",
    "reconcileMatchLifecycle"
  ]) && hasAll(verifyMatchLifecycle, [
    "same-event official 0-0 final overrides scheduled",
    "same id with a changed kickoff rejects the old final",
    "out-of-order scheduled row cannot regress"
  ]), {
    files: [
      "src/services/matchLifecycle.cjs",
      "server/index.cjs",
      "server/sqliteStore.cjs",
      "src/context/AppContext.tsx",
      "scripts/verifyMatchLifecycleReconciliation.cjs"
    ],
    script: "verify:match-lifecycle"
  });

  pushCheck("02-data-warehouse-sync", "current list expires stale unresolved rows without fabricating results", hasAll(currentMatchRetention, [
    "DEFAULT_CURRENT_UNSETTLED_RETENTION_HOURS = 48",
    "isMatchEligibleForCurrent",
    "archivedUnsettled",
    "reconcileArchivedUnsettled"
  ]) && hasAll(syncData, [
    "CURRENT_UNSETTLED_RETENTION_HOURS",
    "matches-unresolved-archive.json",
    "kickoff-retention-v1",
    "old-unsettled-exits-current-without-fabricated-settlement"
  ]) && hasAll(verifyCurrentMatchRetention, [
    "same Shanghai-day FINISHED rows remain in current and history",
    "pending results older than the window leave current without becoming FINISHED",
    "future fixtures stay current",
    "archive reconciliation retains absent unresolved rows and removes settled replacements"
  ]) && scripts["verify:current-match-retention"] === "node scripts/verifyCurrentMatchRetention.cjs", {
    files: [
      "scripts/currentMatchRetention.cjs",
      "scripts/syncData.cjs",
      "scripts/validateData.cjs",
      "scripts/verifyCurrentMatchRetention.cjs"
    ],
    script: "verify:current-match-retention"
  });

  pushCheck("02-data-warehouse-sync", "server reads from SQLite with fallback visibility", hasAll(sqliteStore, [
    "readSqliteCurrentMatches",
    "readSqliteHistoryMatchesForList",
    "readSqliteMatchById",
    "readSqliteOddsHistoryRows",
    "legacyJsonl"
  ]) && hasAll(serverIndex, [
    "shouldPreferSqliteRead",
    "sqliteFreshEnough",
    "file-sqlite-stale"
  ]), { files: ["server/sqliteStore.cjs", "server/index.cjs"] });

  pushCheck("02-data-warehouse-sync", "split sync worker has hot cadence, lock, and SQLite export", hasAll(syncWorker, [
    "HOT_SYNC_INTERVAL_SECONDS",
    "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS",
    "HOT_SYNC_WINDOW_MINUTES",
    "acquireSyncLock",
    "sqliteExportEnabled",
    "datastore:sqlite",
    "cycleState",
    "nextWakeAt",
    "official-result-fast-published",
    "publish:official-results-fast",
    "fastEventVisibilityMs",
    "await waitForFastEventVisibility()"
  ]) && hasAll(readText("server/syncLock.cjs"), [
    "SYNC_LOCK_METADATA_GRACE_SECONDS",
    "ageMs > metadataGraceMs",
    'owner.status === "dead" || metadataOrphan'
  ]) && hasAll(envExample, [
    "SYNC_LOCK_METADATA_GRACE_SECONDS=10"
  ]) && hasAll(fastResultPublisher, [
    "BEGIN IMMEDIATE",
    "fast_result_published_at",
    "source_cycle_id",
    "attachPostMatchReviews",
    "isTrustedFinishedForSettlement"
  ]) && hasAll(verifyFastResultPublication, [
    "trusted official result publishes current to history",
    "conflicting score cannot overwrite terminal history",
    "new signed result probe reaches SQLite publication inside ten seconds"
  ]) && hasAll(workerService, [
    "SYNC_WORKER_LOOP=1",
    "DATASTORE_READ_SOURCE=sqlite",
    "ENABLE_SQLITE_EXPORT=1"
    ]), { files: [
      "scripts/runSyncWorker.cjs",
      "scripts/publishOfficialResultsFast.cjs",
      "scripts/verifyFastResultPublication.cjs",
      "deploy/light-server/football-sync-worker.service"
    ] });

  pushCheck("02-data-warehouse-sync", "UEFA official result supplement is strict, auditable, and archive-safe", (
    scripts["sync:uefa-results"] === "node scripts/syncUefaOfficialResults.cjs"
    && scripts["verify:uefa-official-results"] === "node scripts/verifyUefaOfficialResults.cjs"
    && hasAll(syncWorker, [
      "sync:uefa-results",
      "ENABLE_UEFA_OFFICIAL_RESULTS_SYNC",
      "uefaOfficialResultStep"
    ])
    && hasAll(serverIndex, [
      '["run", "sync:uefa-results"]',
      "ENABLE_UEFA_OFFICIAL_RESULTS_SYNC"
    ])
    && hasAll(envExample, [
      "ENABLE_UEFA_OFFICIAL_RESULTS_SYNC=1",
      "UEFA_RESULT_LOOKBACK_HOURS=120",
      "UEFA_RESULT_TIMEOUT_MS=20000"
    ])
    && hasAll(syncData, [
      "loadUefaOfficialResults",
      "uefa-official-results.json",
      "applyUefaOfficialResult",
      "isTrustedOfficialFinal"
    ])
    && hasAll(matchLifecycle, [
      "isTrustedUefaOfficialFinal",
      "isTrustedOfficialFinal"
    ])
    && syncData.indexOf("attachArchivedPreMatchPredictions") < syncData.lastIndexOf("applyUefaOfficialResult")
    && hasAll(syncUefaOfficialResults, [
      "event?.score?.regular",
      "official-competition-organizer",
      "providerKickoffTime",
      "mapping",
      "evidenceHash",
      "resultRevision",
      "settlementEligible",
      "UNRESOLVED_ARCHIVE_FILE",
      "mergeUefaCandidateRows"
    ])
    && hasAll(verifyUefaOfficialResults, [
      "regular-time score is used instead of aggregate score",
      "unique exact-clock UEFA event maps to the Sporttery row",
      "an exact official Sporttery result is never overwritten",
      "ambiguous same-clock events fail closed",
      "event-version mismatch fails closed",
      "an unresolved archived UEFA row receives the organizer regular-time result",
      "official settlement preserves the immutable archived recommendation"
    ])
  ), {
    files: [
      "scripts/syncUefaOfficialResults.cjs",
      "scripts/verifyUefaOfficialResults.cjs",
      "scripts/syncData.cjs",
      "scripts/runSyncWorker.cjs",
      "server/index.cjs",
      "deploy/light-server/env.example"
    ],
    sourcePriority: "Sporttery official result first; UEFA organizer API supplements unresolved UEFA rows"
  });

  pushCheck("02-data-warehouse-sync", "official club result supplement is allowlisted, tamper-evident, and archive-safe", (
    scripts["sync:official-club-results"] === "node scripts/syncOfficialClubResults.cjs"
    && scripts["verify:official-club-results"] === "node scripts/verifyOfficialClubResults.cjs"
    && hasAll(syncWorker, [
      "sync:official-club-results",
      "ENABLE_OFFICIAL_CLUB_RESULTS_SYNC",
      "officialClubResultStep"
    ])
    && hasAll(serverIndex, [
      '["run", "sync:official-club-results"]',
      "ENABLE_OFFICIAL_CLUB_RESULTS_SYNC"
    ])
    && hasAll(envExample, [
      "ENABLE_OFFICIAL_CLUB_RESULTS_SYNC=1"
    ])
    && hasAll(syncData, [
      "loadOfficialClubResults",
      "official-club-results.json",
      "applyOfficialClubResult",
      "isTrustedOfficialFinal"
    ])
    && syncData.indexOf("attachArchivedPreMatchPredictions") < syncData.lastIndexOf("applyOfficialClubResult")
    && hasAll(syncOfficialClubResults, [
      "ALLOWED_HOSTS",
      "www.aikfotboll.se",
      "www.rbk.no",
      "providerKickoffTime",
      "responseSha256",
      "evidenceHash",
      "promotionEligible: false",
      "settlementEligible: true"
    ])
    && hasAll(officialClubResultSources, [
      "2040641",
      "2040642",
      "https://www.aikfotboll.se/",
      "https://www.rbk.no/"
    ])
    && hasAll(matchLifecycle, [
      "officialClubEvidenceHash",
      "isTrustedOfficialClubFinal",
      "promotionEligible === false",
      "isTrustedOfficialFinal"
    ])
    && hasAll(verifyOfficialClubResults, [
      "a score change without a matching evidence hash must fail closed",
      "an unapproved host must fail closed",
      "isTrustedOfficialClubFinal",
      "isTrustedOfficialFinal"
    ])
  ), {
    files: [
      "scripts/syncOfficialClubResults.cjs",
      "scripts/verifyOfficialClubResults.cjs",
      "scripts/data/official-club-result-sources.json",
      "scripts/syncData.cjs",
      "scripts/runSyncWorker.cjs",
      "src/services/matchLifecycle.cjs",
      "server/index.cjs",
      "deploy/light-server/env.example"
    ],
    sourcePriority: "Sporttery first; allowlisted official club result pages settle only unresolved rows and stay promotion-ineligible"
  });

  pushCheck("02-data-warehouse-sync", "relay result publication is independent and monotonic", hasAll(serverIndex, [
    "RELAY_FAST_WATCHER_ENABLED",
    "relayFastResultWatcher.check({ force: true })",
    'source: "relay-fast-result-watcher"',
    'phase: "official-result-fast-published"',
    "clearApiReadCaches();"
  ]) && hasAll(relayFastResultWatcher, [
    "relaySnapshotFingerprint",
    "runFastPublisherChild",
    "FAST_RESULT_PUBLISHER_MACHINE_ENV",
    "parseFastResultPublisherOutput",
    "state.pending",
    "retryNotBefore",
    "lastPublishedAt"
  ]) && hasAll(fastResultPublisherProtocol, [
    "official-result-fast-publisher-v1",
    "JSON.parse(text)",
    "PUBLISHER_OUTPUT_INVALID"
  ]) && hasAll(sqliteExporter, [
    "readFastResultGuard",
    "assertFastResultReceiptUnchanged",
    "guardedFastFinalFor",
    "fast_result_receipt"
  ]) && hasAll(fastResultPublisher, [
    "priorReceiptObservations",
    "receiptObservations = mergeFastResultObservations",
    "exactTerminalHistory",
    "baseHistoryId",
    "eventSuffix",
    "groupsByEvent",
    "authorityIdentityKey",
    "sameAuthorityEvent"
  ]) && hasAll(verifyFastResultPublication, [
    "successive fast publications accumulate an immutable bounded SQLite receipt",
    "sync-meta recovery restores the complete rolling receipt rather than only the latest batch",
    "stale long-cycle export preserves every final from successive fast batches",
    "reused source match id publishes a different exact event without overwriting history",
    "public transition payload preserves the exact current match id while SQLite row ids remain unique",
    "same relay snapshot keeps reused source id events separate and selects the exact current event",
    "same exact event with conflicting scores is rejected without hiding other event versions",
    "SQLite authority high-water persists 513 plus one rows and rejects an older boundary correction byte-for-byte",
    "same result from a newer relay capture and source cycle is semantically idempotent",
    "a relay capture beyond the trusted future-skew window cannot publish or correct a score",
    "a fast writer waits for the full writer then re-reads and merges instead of losing its commit"
  ]) && hasAll(verifyRelayFastResultWatcher, [
    "changes during an active long task coalesce into one immediate rerun",
    "unchanged fingerprint is idempotent",
    "failed fingerprint retries without requiring another file change",
    "publisher protocol rejects stdout garbage instead of masking it",
    "real child keeps ${fixture.label} pending until relay trust is repaired",
    "PUBLISHER_RETRYABLE_SKIP",
    "key: \"stale\"",
    "key: \"empty\"",
    "key: \"read-fail\""
  ]) && hasAll(verifySqliteIncrementalExport, [
    "same-event stale current must not be reinserted",
    "only the genuinely rescheduled event may remain current"
  ]) && hasAll(envExample, [
    "RELAY_FAST_WATCHER_ENABLED=1",
    "RELAY_FAST_WATCHER_POLL_MS=1000",
    "RELAY_FAST_WATCHER_TIMEOUT_MS=8000",
    "TRUSTED_MAX_FUTURE_SKEW_SECONDS=300",
    "SYNC_META_COMMIT_LOCK_WAIT_MS=30000",
    "SYNC_META_COMMIT_LOCK_STALE_MS=120000",
    "RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER=1",
    "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS=5000",
    "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS=30"
  ]) && hasAll(runtimeMonitor, [
    "fastResultWatcher.enabled === true",
    "Number(fastResultWatcher.pollMs || 0) <= fastResultWatcherMaxPollMs",
    "fastWatcherCheckAgeSeconds <= fastResultWatcherMaxCheckAgeSeconds",
    "!fastResultWatcher.lastError"
  ]) && hasAll(syncMetaCommitLock, [
    "fs.mkdirSync(lockDir)",
    "SYNC_META_COMMIT_LOCK_TIMEOUT",
    "release: () =>"
  ]), { files: [
    "server/index.cjs",
    "server/relayFastResultWatcher.cjs",
    "scripts/fastResultPublisherProtocol.cjs",
    "scripts/syncMetaCommitLock.cjs",
    "scripts/exportDataStoreSqlite.cjs",
    "scripts/verifyRelayFastResultWatcher.cjs",
    "scripts/verifySqliteIncrementalExport.cjs",
    "deploy/light-server/env.example"
  ] });

  pushCheck("02-data-warehouse-sync", "independent relay lane uploads are serialized and rollback-safe", hasAll(serverIndex, [
    "const acquireRelaySnapshotUploadLock",
    "RELAY_SNAPSHOT_UPLOAD_QUEUE_FULL",
    "RELAY_SNAPSHOT_UPLOAD_WAIT_TIMEOUT",
    "withRelaySnapshotUploadLock(req",
    "const existingSnapshot = await readJsonFile(sportteryRelaySnapshotPath, null)",
    "await writeJsonFileAtomic(sportteryRelaySnapshotPath, snapshotWithCollector)",
    "const existingSnapshot = await readJsonFile(sportteryRelayFastLaneSnapshotPath, null)",
    "const commitSnapshot = mergeFastLaneWithRetainedResult(",
    "await writeJsonFileAtomic(sportteryRelayFastLaneSnapshotPath, commitSnapshot.snapshot)",
    "relaySnapshotUploadQueue: relaySnapshotUploadQueueHealth()",
    "uploaded.sync = await runSync(\"sporttery-relay-upload\")",
    "uploaded.sync = await runSync(\"sporttery-relay-fast-lane-upload\")"
  ]) && hasAll(verifyRelaySnapshotUploadSerialization, [
    "full and fast concurrent uploads both commit through one serialized queue",
    "serialized commits preserve physically independent full and fast files",
    "validateOnly previews both replacement lanes without entering the write queue",
    "client disconnect during a full commit cannot wedge the shared mutex",
    "write exception releases the shared mutex and the next lane upload succeeds"
  ]) && Boolean(scripts["verify:relay-upload-serialization"]), {
    files: [
      "server/index.cjs",
      "scripts/verifyRelaySnapshotUploadSerialization.cjs",
      "scripts/verifyProductionReadiness.cjs"
    ],
    script: "verify:relay-upload-serialization"
  });

  pushCheck("02-data-warehouse-sync", "runtime status is bounded and deep diagnostics are explicit", hasAll(dataStore, [
    "const getDataStoreStatus = async (storeDir, options = {})",
    "options.exact === true",
    "rowCountSource",
    '"exact-cache"'
  ]) && hasAll(serverIndex, [
    "getDataStoreStatus(storeDir, { exact: true })",
    "getHealth({ exactDataStore: true })",
    "workerLastSuccessAt",
    "workerLastCycleDurationMs",
    "workerLastError"
  ]) && hasAll(syncWorker, [
    "SYNC_WORKER_COMMAND_TIMEOUT_MS",
    "SYNC_WORKER_COMMAND_TIMEOUT",
    "terminateChildTree",
    "workerHistoryFields",
    "lastCycleDurationMs",
    "lastSuccessAt",
    "lastError"
  ]) && hasAll(verifyRuntimeStability, [
    "default datastore status uses state counts without exact file scans",
    "worker command timeout terminates a hanging child",
    "worker history preserves the previous cycle"
  ]) && verifyProduction.includes("runtime stability artifact")
    && scripts["verify:runtime-stability"] === "node scripts/verifyRuntimeStability.cjs", {
    files: [
      "server/dataStore.cjs",
      "server/index.cjs",
      "scripts/runSyncWorker.cjs",
      "scripts/verifyRuntimeStability.cjs"
    ],
    script: "verify:runtime-stability"
  });

  pushCheck("02-data-warehouse-sync", "v1 health merges sync worker heartbeat", hasAll(serverIndex, [
    "syncWorkerRuntimeStatus",
    "syncWorkerStatusPath",
    "workerRunning",
    "workerCheckedAt",
    "nextWakeAt"
  ]) && hasAll(verifyApiContracts, [
    "health sync worker schema",
    "workerRunning"
  ]) && hasAll(verifyRemotePublic, [
    "REMOTE_REQUIRE_SYNC_WORKER",
    "sync worker health when required"
  ]), { files: ["server/index.cjs", "scripts/verifyApiContracts.cjs", "scripts/verifyRemotePublicReadiness.cjs"] });

  pushCheck("02-data-warehouse-sync", "runtime monitor auto-repairs SQLite read drift", hasAll(runtimeMonitor, [
    "RUNTIME_MONITOR_AUTO_REPAIR_SQLITE",
    "sqlite auto-repair",
    "sqlite primary read after repair",
    "datastore:sqlite"
  ]) && hasAll(monitorService, [
    "RUNTIME_MONITOR_REQUIRE_SQLITE=1",
    "RUNTIME_MONITOR_AUTO_REPAIR_SQLITE=1"
  ]), {
    files: [
      "scripts/checkServerRuntime.cjs",
      "deploy/light-server/football-monitor.service"
    ]
  });

  pushCheck("02-data-warehouse-sync", "runtime monitor detects strict official-result settlement misses", hasAll(runtimeMonitor, [
    "candidateProspectiveTemporalRuntimeState",
    "candidate settlement temporal audit",
    "candidate-official-result-settlement-missed",
    "candidate-settlement-read-model-row-missing",
    "candidate-temporal-ineligible-reason-count-mismatch",
    "candidate-published-market-chain-gap",
    "candidate-awaiting-market-classification-incomplete",
    "candidate-market-coverage-denominator-mismatch",
    "RUNTIME_MONITOR_AUTH_FILE"
  ]) && hasAll(verifyRuntimeCandidateCapture, [
    "officialFinishedEligibleUnsettledRows: 0",
    "candidate-official-result-settlement-missed",
    "candidate-settlement-read-model-row-missing",
    "officialFinishedIneligibleRows, 3",
    "candidate-published-market-chain-gap",
    "candidate-awaiting-market-classification-incomplete"
  ]) && hasAll(candidateProspectiveTemporalAudit, [
    "resultEvidenceBlockersForDecision",
    "officialFinishedIneligibleReasonCounts",
    "officialFinishedIneligiblePrimaryReasonCounts"
  ]) && hasAll(verifyCandidateProspectiveTemporalAudit, [
    "not-official-sporttery-final",
    "officialFinishedIneligiblePrimaryReasonCounts"
  ]) && hasAll(monitorService, [
    "RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT=1",
    "RUNTIME_MONITOR_AUTH_FILE=/etc/football-predict/env"
  ]) && Boolean(scripts["verify:runtime-candidate-capture"]), {
    files: [
      "scripts/checkServerRuntime.cjs",
      "scripts/verifyRuntimeCandidateCaptureMonitor.cjs",
      "server/candidateProspectiveTemporalAudit.cjs",
      "scripts/verifyCandidateProspectiveTemporalAudit.cjs",
      "deploy/light-server/football-monitor.service"
    ],
    script: "verify:runtime-candidate-capture"
  });

  pushCheck("02-data-warehouse-sync", "candidate temporal admin diagnostics stay bounded across both production gates", hasAll(serverIndex, [
    "includeDiagnostics: true",
    "diagnosticLimit: 100"
  ]) && hasAll(candidateProspectiveTemporalAudit, [
    "diagnosticRows",
    "diagnosticRowsTruncated",
    "Math.min(number, 200)"
  ]) && [verifyApiContracts, verifyProduction].every((source) => hasAll(source, [
    "temporalStatusAllowedKeys",
    "temporalAggregateKeysAreSanitized",
    "temporalDenominatorIsReconciled",
    "temporalDiagnosticsAreSanitized",
    "temporalDiagnosticRows.length <= 100",
    "resultPromotionEligible"
  ])), {
    files: [
      "server/index.cjs",
      "server/candidateProspectiveTemporalAudit.cjs",
      "scripts/verifyApiContracts.cjs",
      "scripts/verifyProductionReadiness.cjs"
    ]
  });

  pushCheck("02-data-warehouse-sync", "server processing is cloud-primary while official-source redundancy is runtime-evidenced", hasAll(envExample, [
    "PRODUCTION_DATA_MODE=server-primary",
    "SERVER_DATA_PRIMARY=1",
    "LOCAL_DATA_PUSH_REQUIRED=0",
    "CLOUD_SYNC_REQUIRED=0",
    "SPORTTERY_RELAY_REQUIRED=0"
  ]) && hasAll(verifyServerPrimary, [
    "verifyServerPrimaryDataFlow",
    "sync worker cycle is self-contained on server",
    "local push automation is opt-in, not production-required",
    "runtime monitor fails stopped worker unless local push pause is explicitly allowed",
    "official source redundancy is runtime-evidence based",
    "Windows relay task recovery is safe by default"
  ]) && hasAll(verifyCloudSyncFreshness, [
    "explicitLocalPushRequired",
    "serverPrimaryMode",
    "server primary data flow selected"
  ]) && hasAll(runtimeMonitor, [
    "allowLocalPushWorkerPause",
    "RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE"
  ]) && hasAll(monitorService, [
    "RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0"
  ]) && Boolean(scripts["verify:server-primary"]), {
    files: [
      "deploy/light-server/env.example",
      "deploy/light-server/football-monitor.service",
      "scripts/verifyServerPrimaryDataFlow.cjs",
      "scripts/verifyCloudSyncFreshness.cjs",
      "scripts/checkServerRuntime.cjs"
    ],
    script: "verify:server-primary"
  });

  pushCheck("02-data-warehouse-sync", "local cloud sync fallback is opt-in only", hasAll(runCloudSync, [
    "FOOTBALL_CLOUD_SYNC_TIMEOUT_MINUTES",
    "taskkill.exe",
    "cloud sync timeout"
  ]) && hasAll(verifyCloudSyncFreshness, [
    "verifyCloudSyncFreshness",
    "FootballPredictCloudSync",
    "remote recommendations still serviceable",
    "local relay snapshot fresh",
    "localRelayTransport",
    "relayLastFailureWafBlocked",
    "relay-collector-direct-egress",
    "collector-recently-blocked",
    "sporttery-egress-blocked",
    "requireLocalAutomation"
  ]) && Boolean(scripts["verify:cloud-sync-freshness"]), {
    files: ["scripts/runCloudSync.ps1", "scripts/verifyCloudSyncFreshness.cjs"],
    script: "verify:cloud-sync-freshness"
  }, false);

  pushCheck("02-data-warehouse-sync", "Sporttery egress WAF diagnostic exists", hasAll(verifySportteryEgress, [
    "SPORTTERY_OUTBOUND_PROXY",
    "SPORTTERY_EGRESS_AUDIT_ONLY",
    "SPORTTERY_EGRESS_STATUS_OUT",
    "wafBlocked",
    "no Sporttery endpoint returned JSON",
    "stable authenticated mainland egress"
  ]) && hasAll(serverIndex, [
    "sportteryEgressStatusPath",
    "compactSportteryEgressStatus",
    "sportteryEgress",
    "SPORTTERY_EGRESS_STATUS_OUT",
    "sporttery_egress_probe_failed"
  ]) && Boolean(scripts["verify:sporttery-egress"]), {
    files: ["scripts/verifySportteryEgress.cjs", "server/index.cjs"],
    script: "verify:sporttery-egress"
  });

  pushCheck("02-data-warehouse-sync", "overseas server is relay-first for Sporttery", hasAll(syncData, [
    "SKIP_SPORTTERY_DIRECT_FETCH",
    "SPORTTERY_DIRECT_FETCH",
    "direct-disabled",
    "loadSportteryRelaySnapshot"
  ]) && hasAll(serverIndex, [
    "skipSportteryDirectFetch",
    "direct-disabled",
    "Sporttery direct egress is intentionally disabled",
    "SKIP_SPORTTERY_DIRECT_FETCH"
  ]) && envExample.includes("SKIP_SPORTTERY_FETCH=0")
    && envExample.includes("SKIP_SPORTTERY_DIRECT_FETCH=1")
    && envExample.includes("SPORTTERY_DIRECT_FETCH=0"), {
      files: ["scripts/syncData.cjs", "server/index.cjs", "deploy/light-server/env.example"]
    });

  pushCheck("02-data-warehouse-sync", "Sporttery relay proxy preflight is one command", hasAll(verifySportteryRelayProxy, [
    ".codex-tmp",
    "sporttery-relay.env",
    "SPORTTERY_OUTBOUND_PROXY",
    "SPORTTERY_EGRESS_REQUIRE_PROXY",
    "scripts/verifySportteryEgress.cjs",
    "sporttery-egress-proxy-status.json",
    "missing-proxy"
  ]) && Boolean(scripts["verify:sporttery-relay-proxy"]), {
    files: ["scripts/verifySportteryRelayProxy.cjs", "scripts/verifySportteryEgress.cjs"],
    script: "verify:sporttery-relay-proxy"
  });

  pushCheck("02-data-warehouse-sync", "Sporttery relay proxy config is safe and one-command", hasAll(configureSportteryProxy, [
    "SPORTTERY_OUTBOUND_PROXY",
    "sporttery-relay.env",
    "maskProxy",
    "configure:sporttery-proxy",
    "verifySportteryRelayProxy.cjs",
    "http:",
    "socks5h:",
    "writeEnvFile"
  ]) && Boolean(scripts["configure:sporttery-proxy"]), {
    files: ["scripts/configureSportteryRelayProxy.cjs", "package.json"],
    script: "configure:sporttery-proxy"
  });

  pushCheck("02-data-warehouse-sync", "Sporttery relay collector has one-command optional fallback path", hasAll(sportteryRelayPush, [
    "SPORTTERY_RELAY_PUSH_BASE_URL",
    "SPORTTERY_RELAY_ADMIN_TOKEN",
    "sync:sporttery-snapshot",
    "/api/admin/sporttery-relay-snapshot",
    "SPORTTERY_RELAY_DRY_RUN",
    "SPORTTERY_RELAY_VALIDATE_ONLY",
    "requiredChecksOk",
    "using-existing-fresh-snapshot",
    "collector-failed-using-existing-snapshot",
    "SPORTTERY_RELAY_MIN_TRUSTED_ROWS",
    "trustedSnapshotPath",
    "collector-produced-untrusted-snapshot-using-last-good",
    "SPORTTERY_RELAY_UPLOAD_MODE",
    "prepare upload snapshot",
    "remote health after relay upload",
    "SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT",
    "SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT",
    "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES",
    "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES",
    "SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD",
    "backoff current-lane collect",
    "suppressed-during-waf-cooldown",
    "deferred-until-bounded-current-probe",
    "nextBackoffCurrentLaneProbeAt",
    "backoffCurrentLaneProbeMinutes",
    "shouldAttemptBackoffCurrentLane",
    "partial-live-upload-disabled",
    "methods: healthyFullInterval ? \"result\" : \"none\"",
    "shouldPublishAtomicFastLaneUpload",
    "/api/admin/sporttery-relay-fast-lane?runSync=0",
    "remote upload atomic fast lane",
    "upload.payload?.storedValidation?.ok === true"
  ]) && hasAll(readText("docs/sporttery-relay-snapshot.md"), [
    "npm run sync:sporttery-relay-push",
    "SPORTTERY_RELAY_DRY_RUN=1",
    "SPORTTERY_RELAY_VALIDATE_ONLY=1",
    "`full/history` as separate",
    "successful signed current/calculator collection is uploaded directly",
    "SPORTTERY_OUTBOUND_PROXY",
    "SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT=1",
    "SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT=1",
    "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES=10",
    "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES=60",
    "SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=0",
    "SPORTTERY_RELAY_METHODS=none"
  ]) && Boolean(scripts["sync:sporttery-relay-push"]), {
    files: ["scripts/pushSportteryRelaySnapshot.cjs", "docs/sporttery-relay-snapshot.md"],
    script: "sync:sporttery-relay-push"
  }, false);

  pushCheck("02-data-warehouse-sync", "Sporttery relay collector clears stale failure after success", hasAll(sportteryRelayCircuit, [
    "transitionCollectorCycle",
    "fullCircuit.lastFullOkAt",
    "fullCircuit.lastFullFailedAt = null",
    "fullCircuit.lastFullFailure = null"
  ]) && hasAll(verifySportteryRelayCircuit, [
    "real full success closes circuit",
    "explicitly disabled WAF current lane suppresses current and calculator probes",
    "bounded WAF current probe does not run on every minute scheduler tick",
    "consecutive WAF current-lane failures exponentially back off and cap",
    "closed circuit refreshes current between hourly full collections",
    "same cycle pre/post transition is idempotent",
    "current-only cooldown cycles do not advance full failure",
    "periodic full collection forces a complete HTTP upload",
    "independent full recovery preserves archive across fast updates"
  ]) && hasAll(verifySportteryRelayFullRecovery, [
    "complete full upload restores archive in its independent file",
    "fast upload after full keeps the full archive byte-identical"
  ]) && Boolean(scripts["verify:sporttery-relay-circuit"])
    && Boolean(scripts["verify:sporttery-relay-full-recovery"])
    && hasAll(serverIndex, [
    "relayCollectorFailureIsUnresolved",
    "lastCollectOkAt",
    "lastCollectFailedAt",
    "sporttery relay collector recently WAF-blocked"
  ]), {
    files: [
      "scripts/sportteryRelayCircuit.cjs",
      "scripts/verifySportteryRelayCircuitBreaker.cjs",
      "scripts/verifySportteryRelayFullRecovery.cjs",
      "scripts/pushSportteryRelaySnapshot.cjs",
      "server/index.cjs"
    ],
    script: "verify:sporttery-relay-circuit"
  });

  pushCheck("02-data-warehouse-sync", "Sporttery relay keeps full archive and minute fast lane in independent files", hasAll(verifySportteryRelayDualFile, [
    "fresh fast current calculator overrides stale full current without flattening files",
    "fast result page one overrides only the head while full archive pages remain",
    "stale fast current fails closed while the independent full archive stays intact",
    "worker wake fingerprint changes when only the fast file changes"
  ]) && hasAll(syncData, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "sporttery-relay-fast-lane.json",
    "sporttery-relay-dual-file-v1",
    "runtime-lane-overlay"
  ]) && hasAll(syncWorker, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "relayFastLaneSnapshotPath",
    "full:${full.token",
    "fast:${fast.token"
  ]) && Boolean(scripts["verify:sporttery-relay-dual-file"]), {
    files: [
      "scripts/verifySportteryRelayDualFile.cjs",
      "scripts/syncData.cjs",
      "scripts/runSyncWorker.cjs",
      "server/index.cjs"
    ],
    script: "verify:sporttery-relay-dual-file"
  });

  pushCheck("02-data-warehouse-sync", "Sporttery relay server enforces independent atomic full and fast uploads", hasAll(verifySportteryRelayDualLaneServer, [
    "full upload is an atomic replacement without merge",
    "full endpoint rejects compact snapshot",
    "fast endpoint rejects archive methods",
    "fast endpoint rejects same-key clock regression",
    "upload-merge still leaves full archive byte-identical",
    "health prefers fresh fast current lane",
    "health reports full history independently"
  ]) && hasAll(serverIndex, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "relayFullSnapshotValidation",
    "relayFastLaneValidation",
    "RELAY_FAST_LANE_MONOTONICITY_REJECTED",
    "fullSnapshotUntouched",
    "fastLaneUntouched",
    "fullHistorySource",
    "/api/admin/sporttery-relay-fast-lane"
  ]) && hasAll(nginxServerCommon, [
    "location = /api/admin/sporttery-relay-fast-lane"
  ]) && hasAll(envExample, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=/var/lib/football-predict/sporttery-relay-fast-lane.json"
  ]) && hasAll(bundleReleaseScript, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "sporttery-relay-fast-lane.json"
  ]) && hasAll(releaseScript, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "sporttery-relay-fast-lane.json"
  ]) && Boolean(scripts["verify:sporttery-relay-dual-server"]), {
    files: [
      "scripts/verifySportteryRelayDualLaneServer.cjs",
      "server/index.cjs",
      "deploy/light-server/nginx-server-common.conf",
      "deploy/light-server/env.example",
      "deploy/light-server/release-from-bundle.sh",
      "deploy/light-server/release.sh"
    ],
    script: "verify:sporttery-relay-dual-server"
  });

  pushCheck("02-data-warehouse-sync", "Sporttery relay collector has optional hidden scheduled task wrapper", hasAll(runSportteryRelayPush, [
    "sporttery-relay.log",
    "sporttery-relay.lock",
    "sync:sporttery-relay-push",
    "SPORTTERY_RELAY_TIMEOUT_MINUTES",
    "SPORTTERY_RELAY_RUN_SYNC",
    "SPORTTERY_RELAY_TOLERATE_COLLECT_FAILURE",
    ".codex-tmp\\cloud-sync.env",
    ".codex-tmp\\sporttery-relay.env",
    "taskkill.exe"
  ]) && hasAll(installSportteryRelayTask, [
    "FootballPredictSportteryRelay",
    "$DefaultIntervalMinutes = 1",
    "FOOTBALL_RELAY_INTERVAL_MINUTES",
    "runSportteryRelayPushHidden.vbs",
    "schtasks.exe",
    "Settings.Hidden",
    "TASK_INSTANCES_IGNORE_NEW",
    "MultipleInstances = 2",
    "StartWhenAvailable = $true",
    "DisallowStartIfOnBatteries = $false",
    "StopIfGoingOnBatteries = $false",
    "RestartCount = $RetryCount",
    "ExecutionTimeLimit",
    "FOOTBALL_RELAY_WAKE_TO_RUN",
    "FOOTBALL_RELAY_USE_S4U"
  ]) && hasAll(runSportteryRelayPushHidden, [
    "runSportteryRelayPush.ps1",
    "WindowStyle Hidden"
  ]) && hasAll(readText("docs/sporttery-relay-snapshot.md"), [
    "npm run sync:sporttery-relay-install-task",
    "FootballPredictSportteryRelay",
    "Interval: 1 minute for the current/live lane",
    "collector keeps full-history refreshes on its separate slower cadence",
    "TASK_INSTANCES_IGNORE_NEW",
    "logs/sporttery-relay.log"
  ]) && Boolean(scripts["sync:sporttery-relay-watch"]) && Boolean(scripts["sync:sporttery-relay-install-task"]), {
    files: [
      "scripts/runSportteryRelayPush.ps1",
      "scripts/runSportteryRelayPushHidden.vbs",
      "scripts/installSportteryRelayTask.ps1",
      "docs/sporttery-relay-snapshot.md"
    ],
    script: "sync:sporttery-relay-install-task"
  }, false);

  pushCheck("02-data-warehouse-sync", "Sporttery result page has a bounded change-driven fast relay lane", hasAll(readText("scripts/collectSportterySnapshot.cjs"), [
    "SPORTTERY_RELAY_SKIP_INITIAL",
    "skipInitialEndpoints",
    "buildCurlInvocation",
    "stdinConfig",
    "unsafe proxy configuration"
  ]) && hasAll(sportteryFastResultLane, [
    "resultObservationRows",
    "resultFingerprint",
    "computeBackoffMs",
    "acquireInstanceLock",
    "inspectProcessIdentity",
    "processStartKey",
    "commandSignature",
    "live-runner-identity-mismatch",
    "remote-upload-requires-https",
    "payload?.ok === true",
    "payload?.storedValidation?.ok === true",
    "remote-upload-response-aborted",
    "remote-upload-response-closed",
    "remote-upload-wall-clock-timeout",
    "/api/admin/sporttery-relay-fast-lane?runSync=0",
    "fastLanePublishDecision",
    "writeJsonAtomic",
    "finiteNumber"
  ]) && hasAll(runSportteryFastResultLane, [
    "methods: \"result\"",
    "skipInitial: true",
    "methods: \"none\"",
    "skipInitial: false",
    "lastUploadedResultFingerprint",
    "unchanged",
    "SPORTTERY_FAST_RESULT_INTERVAL_SECONDS",
    "SPORTTERY_FAST_CURRENT_HEARTBEAT_SECONDS",
    "lastCurrentHeartbeatAt",
    "lastUploadReason",
    "SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS",
    "lock-health-failed",
    "delayFromCompletionMs",
    "nextAttemptAt"
  ]) && hasAll(runSportteryFastResultLanePs, [
    "sporttery-fast-result.log",
    "SPORTTERY_FAST_RESULT_INTERVAL_SECONDS",
    "https://170.106.75.73",
    "--watch"
  ]) && hasAll(runSportteryFastResultLaneHidden, [
    "runSportteryFastResultLane.ps1",
    "WindowStyle Hidden"
  ]) && hasAll(installSportteryFastResultLaneTask, [
    "FootballPredictSportteryFastResultLane",
    "TASK_INSTANCES_IGNORE_NEW",
    "MultipleInstances = 2",
    "ExecutionTimeLimit = \"PT0S\"",
    "StartWhenAvailable = $true",
    "Stop-ScheduledTask",
    "owner.json",
    "runSportteryFastResultLane.cjs",
    "taskkill.exe",
    "Refusing to terminate unverified",
    'else { "S4U" }',
    "TASK_LOGON_S4U",
    "TASK_LOGON_SERVICE_ACCOUNT",
    "FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE=1",
    "FOOTBALL_FAST_RESULT_VALIDATE_ONLY"
  ]) && hasAll(verifySportteryFastResultLane, [
    "one result request per cycle",
    "companion is fetched on result changes while the heartbeat is not yet due",
    "unchanged result page is not uploaded",
    "unchanged result publishes a fresh current calculator heartbeat at sixty seconds",
    "failure backoff is exponential and capped",
    "runner output never prints bearer token",
    "PID reuse with a runner-like live process fails closed",
    "upload acknowledgement requires 2xx JSON ok=true and storedValidation.ok=true",
    "truncated 200 JSON response settles fail-closed on response abort or close",
    "independent wall-clock upload timer settles once and is cleared",
    "failure backoff sleep starts at failure completion",
    "authenticated proxy credentials travel through curl stdin config",
    "scheduled task defaults to passwordless unattended S4U"
  ]) && hasAll(readText("docs/sporttery-relay-snapshot.md"), [
    "15-second result-page probe",
    "current/calculator requests per 60-second heartbeat",
    "sync:sporttery-result-fast-install-task",
    "does not promise source-to-page updates under 10 seconds",
    "TASK_LOGON_S4U",
    "private stdin config pipe",
    "process start time",
    "stored snapshot validation"
  ]), {
    files: [
      "scripts/collectSportterySnapshot.cjs",
      "scripts/sportteryFastResultLane.cjs",
      "scripts/runSportteryFastResultLane.cjs",
      "scripts/runSportteryFastResultLane.ps1",
      "scripts/runSportteryFastResultLaneHidden.vbs",
      "scripts/installSportteryFastResultLaneTask.ps1",
      "scripts/verifySportteryFastResultLane.cjs",
      "docs/sporttery-relay-snapshot.md"
    ],
    script: "verify:sporttery-result-fast"
  });

  pushCheck("02-data-warehouse-sync", "cloud sync fallback can export SQLite to production var-lib store", hasAll(cloudPush, [
    "SERVER_STORE_DIR=/var/lib/football-predict",
    "DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db",
    "sudo chown football:football /var/lib/football-predict/football.db*"
  ]) && hasAll(verifyDeploymentConfig, [
    "env production store path is var-lib sqlite",
    "cloud data push exports sqlite to production var-lib store"
  ]), {
    files: ["scripts/pushCloudSync.cjs", "scripts/verifyDeploymentConfig.cjs"]
  }, false);

  const sqliteOddsRows = Number(sqliteStatus.counts?.oddsSnapshots || 0);
  const riskGuard = formalStrategy?.activation?.riskGuard || null;
  const missingOddsFailClosed = sqliteOddsRows === 0
    && ["watch", "degraded"].includes(riskGuard?.riskTier)
    && riskGuard?.looseningAllowed === false
    && riskGuard?.tighteningAllowed === true;
  pushCheck("02-data-warehouse-sync", "SQLite runtime counts support fail-closed prediction service", sqliteStatus.available === true
    && Number(sqliteStatus.counts?.currentMatches || 0) > 0
    && Number(sqliteStatus.counts?.historyMatches || 0) > 0
    && (sqliteOddsRows > 0 || missingOddsFailClosed)
    && Number(sqliteStatus.counts?.predictionSnapshots || 0) > 0, {
      dbPath: sqliteStatus.path,
      statusSource: sqliteStatus.statusSource || null,
      directReason: sqliteStatus.directReason || sqliteStatus.reason || null,
      healthUrl: sqliteStatus.healthUrl || null,
      counts: sqliteStatus.counts,
      missingOddsFailClosed,
      riskGuard
    });

  pushCheck("03-large-payload-concurrency", "large static payloads are disabled and stripped from dist", hasAll(serverIndex, [
    "disabledLargeStaticPayloads",
    "large static payload disabled"
  ]) && hasAll(viteConfig, [
    "publicDir: false",
    "copyFilteredPublicAssets",
    "stripLargeStaticPayloads"
  ]) && hasAll(verifyFrontend, [
    "static data allowlist policy",
    "dist static data allowlist enforced",
    "vite public copy filter"
  ]) && hasAll(staticDistDataPolicy, [
    "ALLOWED_STATIC_DATA_JSON",
    "listStaticDataJsonArtifacts",
    "inspectStaticDistData",
    "assertStaticDistDataPolicy"
  ]) && hasAll(stripLargeStaticPayloadsScript, [
    'require("./staticDistDataPolicy.cjs")',
    "assertStaticDistDataPolicy(resolvedDistDir)"
  ]), {
    files: [
      "server/index.cjs",
      "vite.config.ts",
      "scripts/staticDistDataPolicy.cjs",
      "scripts/stripLargeStaticPayloads.cjs",
      "scripts/verifyFrontendObservability.cjs"
    ]
  });

  pushCheck("03-large-payload-concurrency", "cloud data push does not republish large dist payloads", hasAll(cloudPush, [
    "disabledDistPayloads",
    "lightweightDistDataFiles",
    "remoteStripDisabledDistPayloads"
  ]) && !cloudPush.includes("fs.cpSync(publicDataDir, distDataDir")
    && !cloudPush.includes("dist/matches.json dist/matches.json")
    && !cloudPush.includes("dist/odds-history.json dist/odds-history.json"), {
      file: "scripts/pushCloudSync.cjs"
    });

  pushCheck("03-large-payload-concurrency", "cloudflare scheduling worker does not serve protected data", hasAll(cloudflareWorker, [
    "disabledProtectedDataResources",
    "protected data API disabled on sync worker",
    "protected Node /api/v1 service"
  ]) && !cloudflareWorker.includes('"matches/history": "public/data/matches-history.json"')
    && !cloudflareWorker.includes('"odds/history": "public/data/odds-history.json"')
    && !cloudflareWorker.includes('"model/calibration": "public/data/model-calibration.json"'), {
      file: "cloudflare/sync-trigger/src/index.js"
    });

  const pagesBaseCheck = (workflow) => workflow.includes("Verify Pages API Base")
    && workflow.includes("DATA_API_BASE repository variable is required")
    && workflow.includes("https://*")
    && !workflow.includes("http://*|https://*");
  pushCheck("03-large-payload-concurrency", "github pages builds require HTTPS protected api base", pagesBaseCheck(githubSyncWorkflow) && pagesBaseCheck(githubPagesWorkflow), {
    files: [".github/workflows/sync.yml", ".github/workflows/deploy.yml"]
  });

  pushCheck("03-large-payload-concurrency", "v1 reads use ETag and short TTL caches", hasAll(serverIndex, [
    "sendJsonCached",
    "if-none-match",
    "v1CurrentPayloadCache",
    "v1HistoryPayloadCache",
    "v1MatchPayloadCache"
  ]) && hasAll(verifyProduction, [
    "current etag not-modified",
    "match detail etag not-modified",
    "current list compact payload"
  ]), { files: ["server/index.cjs", "scripts/verifyProductionReadiness.cjs"] });

  pushCheck("03-large-payload-concurrency", "Nginx has static cache, no-store runtime, and rate limits", hasAll(nginx, [
    "limit_req_zone",
    "gzip on",
    "upstream football_node",
    "keepalive 64",
    "proxy_set_header Connection \"\"",
    "football-predict-security-headers.conf",
    "immutable",
    "runtime-config.json",
    "no-store",
    "limit_req_status 429",
    "location = /api/admin/sporttery-relay-snapshot",
    "client_max_body_size 32m",
    "limit_req zone=football_api",
    "limit_req zone=football_admin"
  ]), { files: [
    "deploy/light-server/nginx.conf",
    "deploy/light-server/nginx-http-common.conf",
    "deploy/light-server/nginx-server-common.conf",
    "deploy/light-server/nginx-security-headers.conf"
  ] });

  pushCheck("03-large-payload-concurrency", "release restart transport failures use a bounded truthful maintenance fallback", hasAll(nginxHttpCommon, [
    "server 127.0.0.1:8788 max_fails=1 fail_timeout=1s",
    "server 127.0.0.1:8787 backup",
    "listen 127.0.0.1:8787",
    "RELEASE_MAINTENANCE",
    "return 503",
    "Retry-After \"2\" always",
    "Cache-Control \"no-store\" always"
  ]) && hasAll(nginxServerCommon, [
    "proxy_connect_timeout 1s",
    "proxy_next_upstream error timeout",
    "proxy_next_upstream_tries 2",
    "proxy_next_upstream_timeout 2s"
  ]) && !nginxServerCommon.includes("proxy_intercept_errors on;"), { files: [
    "deploy/light-server/nginx-http-common.conf",
    "deploy/light-server/nginx-server-common.conf",
    "scripts/verifyDeploymentConfig.cjs"
  ] });

  pushCheck("03-large-payload-concurrency", "IP TLS bootstrap and strict readiness are reproducible", hasAll(nginxTlsTemplate, [
    "return 308 https://__TLS_IP_ADDRESS__$request_uri",
    "listen 443 ssl http2 default_server",
    "ssl_protocols TLSv1.2 TLSv1.3",
    "ssl_session_tickets off",
    "/etc/letsencrypt/live/__TLS_CERT_NAME__/fullchain.pem",
    "football-predict-server.conf"
  ]) && hasAll(enableNginxTls, [
    "ACME_AGREE_TOS",
    "ACME_EMAIL",
    "--preferred-profile",
    "shortlived",
    "--ip-address",
    "renewal-hooks/deploy/football-predict-nginx"
  ]) && scripts["verify:tls"] === "node scripts/verifyTlsReadiness.cjs"
    && hasAll(verifyTlsReadiness, [
      "certificate has renewal runway",
      "certificate contains expected IP SAN",
      "TLS 1.0 and 1.1 are rejected",
      "ACME challenge bypasses HTTPS redirect"
    ]), { files: [
      "deploy/light-server/nginx-tls-site.conf.template",
      "deploy/light-server/enable-nginx-tls.sh",
      "scripts/verifyTlsReadiness.cjs"
    ] });

  pushCheck("03-large-payload-concurrency", "performance smoke gate exists", hasAll(verifyPerf, [
    "maxP95Ms",
    "maxErrorRate",
    "PERF_KEEP_ALIVE",
    "PERF_ACCEPT_GZIP",
    "PERF_ENDPOINT_COOLDOWN_MS",
    "keepAlive",
    "endpointCooldownMs",
    "shouldAutoStartLocalServer",
    "api-performance-local-admin",
    "ACCESS_CODE_ADMIN_TOKEN: process.env.ACCESS_CODE_ADMIN_TOKEN || accessCodeAdminToken",
    "/api/v1/matches/current?view=list",
    "/api/v1/matches/history?limit=50"
  ]) && Boolean(scripts["verify:perf"]), { file: "scripts/verifyApiPerformance.cjs" });

  pushCheck("04-model-backtest-calibration", "time-ordered rolling backtest and leakage guards", hasAll(modelBacktest, [
    "summarizeRollingWindows",
    "summarizePreMatchInputAudit",
    "marketBaseline",
    "closingLineValue",
    "shadowCandidates",
    "summarizeModelRiskTiers",
    "model-risk-tier-v1",
    "leakageGuard",
    "snapshot?.phase === \"review\"",
    "DATASTORE_SQLITE_PATH",
    "odds_snapshots",
    "selectedSource"
  ]) && hasAll(verifyModelInputAudit, [
    "pre-match input audit has zero leakage violations",
    "rolling windows are time ordered",
    "market baseline is forecast-time baseline"
  ]) && hasAll(verifyModelRiskTiers, [
    "model risk tier artifact available",
    "overall tier follows highest reason severity",
    "risk policy cannot override probabilities"
  ]), { files: ["scripts/runModelBacktest.cjs", "scripts/verifyModelInputAudit.cjs"] });

  pushCheck("04-model-backtest-calibration", "market, Elo, Poisson, and historical blend candidates exist", hasAll(modelBacktest, [
    "market-baseline",
    "elo-rating-v1",
    "poisson-goals-v1",
    "historical-elo-poisson-50",
    "Historical Elo 1X2 rating",
    "Historical Poisson goal distribution"
  ]), { file: "scripts/runModelBacktest.cjs" });

  for (const spec of modelIntegrityGateSpecs) {
    const artifact = modelIntegrityGateArtifacts.get(spec.id);
    const packageCommand = scripts[spec.npmScript] || null;
    const expectedCommand = ["node", spec.file, ...(spec.args || [])].join(" ");
    const packageWired = packageCommand === expectedCommand;
    const contractValid = artifact?.status === 0
      && artifact?.body?.ok === true
      && artifact?.body?.verifier === (spec.verifier || spec.id)
      && spec.validate(artifact.body);
    pushCheck(
      "04-model-backtest-calibration",
      spec.label,
      packageWired && contractValid,
      {
        npmScript: spec.npmScript,
        packageCommand,
        expectedCommand,
        status: artifact?.status ?? null,
        signal: artifact?.signal || null,
        verifier: artifact?.body?.verifier || null,
        assertions: artifact?.body?.assertions ?? artifact?.body?.checks ?? null,
        validationVersion: artifact?.body?.validationVersion || null,
        protocolVersion: artifact?.body?.protocolVersion || null,
        timelineVersion: spec.id === "as-of-result-timeline" ? artifact?.body?.version || null : null,
        predictionStateIdentityVersion: artifact?.body?.predictionStateIdentityVersion || null,
        error: artifact?.error || null,
        stdoutTail: artifact?.stdoutTail || "",
        stderrTail: artifact?.stderrTail || "",
      },
    );
  }

  pushCheck("04-model-backtest-calibration", "promotion gate keeps weak models in shadow", hasAll(modelStrategy, [
    "PROMOTION_MIN_BASELINE_ROWS",
    "PROMOTION_MIN_LOG_LOSS_IMPROVEMENT",
    "PROMOTION_MIN_BRIER_IMPROVEMENT",
    "onlineEffect",
    "shadow"
  ]) && formalStrategy?.activation?.promotionGate?.status, {
    file: "scripts/optimizePredictionStrategy.cjs",
    gateStatus: formalStrategy?.activation?.promotionGate?.status || null,
    onlineEffect: formalStrategy?.activation?.onlineEffect || null
  });

  pushCheck("04-model-backtest-calibration", "reference-shadow calibration is isolated and can only tighten formal gates", Boolean(formalStrategy?.activation?.promotionGate?.status)
    && referenceStrategyAudit.ok, {
      formalStrategyVersion: formalStrategy?.version || null,
      formalOnlineEffect: formalStrategy?.activation?.onlineEffect || null,
      formalPromotionGateStatus: formalStrategy?.activation?.promotionGate?.status || null,
      embeddedReferenceStrategyVersion: embeddedReferenceStrategy?.version || null,
      embeddedReferenceOnlineEffect: embeddedReferenceStrategy?.activation?.onlineEffect || null,
      embeddedReferencePresent: referenceStrategyAudit.present,
      embeddedReferenceActiveRuleCount: referenceStrategyAudit.activeRuleCount,
      embeddedReferenceActiveGateCountsMatch: referenceStrategyAudit.activeGateCountsMatch,
      embeddedReferenceSampleReadyForActiveRules: referenceStrategyAudit.sampleReadyForActiveRules,
      embeddedReferenceIsolatedFromFormalPromotion: referenceStrategyAudit.isolatedFromFormalPromotion,
      embeddedReferenceUnsafeRuleKeys: referenceStrategyAudit.unsafeRuleKeys,
    });

  pushCheck("04-model-backtest-calibration", "HHAD companion evaluation is private-audited and permanently shadow-gated", hasAll(modelBacktest, [
    "evaluateHhadCompanionShadowHistory",
    "globalRiskTier",
    "includeInternalRows: true",
    "privateModelArtifactStore.cjs",
    "writePrivateModelArtifact",
    "removeLegacyPrivateAuditFile",
    "outputFiles: [serverOutputFile, publicOutputFile, shadowCandidatesOutputFile]",
    "hhadCompanionEvaluation"
  ]) && hasAll(privateModelArtifactStore, [
      "private_model_artifacts",
      "CREATE TABLE IF NOT EXISTS",
      "BEGIN IMMEDIATE",
      "INSERT INTO ${PRIVATE_MODEL_ARTIFACT_TABLE}",
      "readPrivateModelArtifact",
      "writePrivateModelArtifact"
    ]) && scripts["verify:private-model-artifact"] === "node scripts/verifyPrivateModelArtifactStore.cjs"
    && hasAll(verifyModelPromotionGate, [
      "privateModelArtifactStore.cjs",
      "readPrivateModelArtifact",
      "legacy HHAD private audit file has been removed"
    ]) && !serverIndex.includes("private_model_artifacts")
    && hasAll(hhadCompanionEvaluation, [
    "pairedThreeWay",
    "six-non-overlapping-chronological-match-day-windows",
    'onlineEffect: "shadow"',
    "promotionAllowed: false"
  ]) && hasAll(modelStrategy, [
    "hhadCompanionShadowGateFromEvaluation",
    "shadowTracks",
    "HHAD_COMPANION",
    'onlineEffect: "shadow"',
    "promotionAllowed: false"
  ]) && hasAll(verifyHhadCompanionEvaluation, [
    "final SKIP must not fall back to the earlier EVALUATE",
    "VOID is retained for audit but excluded from paired metrics",
    "aggregateOnly"
  ]) && hasAll(hhadCompanionPublicContract, [
    "publicHhadCompanionSchemaValid",
    "findHhadCompanionSensitiveKeyLeaks",
    "pairedNonVoidRows"
  ]) && formalStrategy?.activation?.shadowTracks?.HHAD_COMPANION?.onlineEffect === "shadow"
    && formalStrategy?.activation?.shadowTracks?.HHAD_COMPANION?.promotionAllowed === false, {
    files: [
      "scripts/runModelBacktest.cjs",
      "scripts/privateModelArtifactStore.cjs",
      "src/services/hhadCompanionShadowEvaluation.cjs",
      "scripts/optimizePredictionStrategy.cjs",
      "scripts/verifyModelPromotionGate.cjs",
      "scripts/verifyHhadCompanionShadowEvaluation.cjs",
      "scripts/hhadCompanionPublicContract.cjs"
    ],
    candidateStatus: modelEvaluation?.hhadCompanionEvaluation?.candidateStatus || null,
    pairedNonVoidRows: modelEvaluation?.hhadCompanionEvaluation?.counts?.pairedNonVoidRows ?? null
  });

  pushCheck("04-model-backtest-calibration", "risk tier blocks loosening until calibration is stable", hasAll(modelStrategy, [
    "riskGuardFromEvaluation",
    "risk-constrained-exposure-v1",
    "risk-guard-blocked-loosening",
    "risk-constrained-cooling",
    "looseningAllowed"
  ]) && hasAll(verifyModelPromotionGate, [
    "risk guard mirrors evaluation tier",
    "risk guard blocks loosening when tier is not stable"
  ]) && Boolean(formalStrategy?.activation?.riskGuard), {
    files: [
      "scripts/optimizePredictionStrategy.cjs",
      "scripts/verifyModelPromotionGate.cjs"
    ],
    riskGuard: formalStrategy?.activation?.riskGuard || null
  });

  pushCheck("04-model-backtest-calibration", "multi-factor recommendation gate is time ordered and shadow-safe", hasAll(modelBacktest, [
    "recommendationSelectionComparison",
    "six non-overlapping chronological windows; no random split",
    "SP is a continuous market/value feature; no max-SP reroute",
    "multiFactorShadowEligible"
  ]) && hasAll(modelStrategy, [
    "multi-factor-market-evidence-v2",
    "unknownSpAction: \"watch\"",
    "directionSwitchByLowerSp: false"
  ]) && hasAll(verifyRecommendationEligibility, [
    "model-only BEST rows are non-actionable labeled references",
    "recommendation denominator has no unknown SP",
    "rolling windows are chronological and non-overlapping",
    "insufficient samples remain shadow"
  ]) && hasAll(verifyBetSlipRecommendationGate, [
    "reference odds cannot enter an executable bet slip",
    "combination rank prioritizes calibrated joint probability"
  ]) && hasAll(verifyPredictionFeatureAsOf, [
    "post-cutoff-external-market",
    "external-had-market-not-hhad-outcome-evidence"
  ]) && hasAll(verifyServerRecommendationBoundary, [
    "missing BEST action must fail closed",
    "unverified odds source must fail closed"
  ]) && hasAll(verifyLiveRecommendationLayer, [
    "canonical cutoff cannot extend a shorter buy-end clock",
    "snapshot round-trip preserves structured live evidence",
    "settlement writes live metrics without formal denominator pollution",
    "legacy SQLite rows are distinguished from newly publication-bound rows"
  ]) && modelEvaluation?.recommendationSelection?.gate?.eligible === false
    && formalStrategy?.recommendationSelection?.status === "shadow-only"
    && formalStrategy?.recommendationSelection?.hardMaxSp === null
    && formalStrategy?.recommendationSelection?.directionSwitchByLowerSp === false, {
    files: [
      "scripts/runModelBacktest.cjs",
      "scripts/optimizePredictionStrategy.cjs",
      "scripts/verifyRecommendationEligibility.cjs",
      "scripts/verifyBetSlipRecommendationGate.cjs",
      "scripts/verifyPredictionFeatureAsOf.cjs",
      "scripts/verifyServerRecommendationBoundary.cjs",
      "scripts/verifyLiveRecommendationLayer.cjs"
    ],
    recommendationSelection: formalStrategy?.recommendationSelection || null
  });

  pushCheck("04-model-backtest-calibration", "public model artifacts have baseline samples", Number(modelEvaluation?.sample?.probabilityRows || 0) > 0
    && Number(modelEvaluation?.sample?.marketBaselineRows || 0) > 0
    && Boolean(modelEvaluation?.shadowCandidates?.bestCandidateId)
    && Boolean(modelEvaluation?.shadowCandidates?.bestModelCandidateId)
    && modelEvaluation?.inputAudit?.ok === true
    && modelEvaluation?.riskTiers?.version === "model-risk-tier-v1"
    && Boolean(modelEvaluation?.riskTiers?.overall?.tier), {
      file: "public/data/model-evaluation.json",
      probabilityRows: modelEvaluation?.sample?.probabilityRows || 0,
      marketBaselineRows: modelEvaluation?.sample?.marketBaselineRows || 0,
      bestCandidateId: modelEvaluation?.shadowCandidates?.bestCandidateId || null,
      bestModelCandidateId: modelEvaluation?.shadowCandidates?.bestModelCandidateId || null,
      inputAuditOk: modelEvaluation?.inputAudit?.ok ?? null,
      inputAuditVersion: modelEvaluation?.inputAudit?.version || null,
      riskTier: modelEvaluation?.riskTiers?.overall?.tier || null
    });

  pushCheck("04-model-backtest-calibration", "candidate model evaluation schema and digest", modelEvaluation?.ok === true
    && modelEvaluation?.version === "rolling-backtest-v19"
    && modelEvaluation?.walkForwardValidation?.version === "walk-forward-promotion-validation-v3"
    && modelEvaluation?.walkForwardValidation?.protocolVersion === "nested-expanding-window-candidate-selection-v2"
    && /^[a-f0-9]{64}$/.test(String(modelEvaluationSha256 || "")), {
    file: "public/data/model-evaluation.json",
    sha256: modelEvaluationSha256,
    evaluationVersion: modelEvaluation?.version || null,
    expectedEvaluationVersion: "rolling-backtest-v19",
    walkForwardVersion: modelEvaluation?.walkForwardValidation?.version || null,
    expectedWalkForwardVersion: "walk-forward-promotion-validation-v3",
    walkForwardProtocolVersion: modelEvaluation?.walkForwardValidation?.protocolVersion || null,
    expectedWalkForwardProtocolVersion: "nested-expanding-window-candidate-selection-v2"
  });

  const promotionGate = formalStrategy?.activation?.promotionGate || null;
  const modelSignal = promotionGate?.modelSignal || null;
  const modelSignalCandidate = promotionGate?.modelSignalCandidate || null;
  const modelSignalComparison = modelSignalCandidate?.comparison || {};
  const bestModelLogLossImprovement = Number(modelSignalComparison.logLossImprovement);
  const bestModelBrierImprovement = Number(modelSignalComparison.brierImprovement);
  const modelSignalComparisonRows = Number(modelSignalComparison.rows);
  const modelSignalMetricRows = Number(modelSignalCandidate?.metrics?.rows);
  const modelSignalStateConsistent = (
    modelSignal?.status === "candidate-positive"
    && modelSignal?.readyForGuardedUse === true
    && modelSignal?.productionPolicyReady === true
  ) || (
    ["shadow-only", "champion-identity-mismatch"].includes(modelSignal?.status)
    && modelSignal?.readyForGuardedUse === false
  );
  const bestCandidateUsesModelSignal = modelSignal?.bestCandidateUsesModelSignal;
  const expectedModelSignalEffect = modelSignal?.readyForGuardedUse === true
    && bestCandidateUsesModelSignal === true
    ? "guarded-active"
    : "shadow";
  const modelSignalExposureConsistent = typeof bestCandidateUsesModelSignal === "boolean"
    && modelSignal?.onlineEffect === expectedModelSignalEffect
    && (
      bestCandidateUsesModelSignal !== true
      || modelSignal?.readyForGuardedUse === true
      || (
        promotionGate?.status === "shadow"
        && promotionGate?.onlineEffect === "shadow"
        && promotionGate?.eligibleScope === "none"
      )
    );
  const modelSignalMarginalStateConsistent = typeof modelSignal?.marginalGainVsCalibratedMarket === "boolean"
    && typeof promotionGate?.metrics?.modelMarginalReady === "boolean"
    && modelSignal.marginalGainVsCalibratedMarket === promotionGate.metrics.modelMarginalReady;
  const modelSignalMetricsAuditable = Boolean(modelSignal?.bestModelCandidateId)
    && modelSignalCandidate?.id === modelSignal.bestModelCandidateId
    && Number.isFinite(bestModelLogLossImprovement)
    && Number.isFinite(bestModelBrierImprovement)
    && modelSignalComparison?.pairedByMatch === true
    && Number.isFinite(modelSignalComparisonRows)
    && modelSignalComparisonRows > 0
    && Number.isFinite(modelSignalMetricRows)
    && modelSignalComparisonRows === modelSignalMetricRows
    && modelSignalMarginalStateConsistent;
  const modelSignalPerformanceFailClosed = modelSignal?.readyForGuardedUse === true
    ? bestModelLogLossImprovement >= 0 && bestModelBrierImprovement >= 0
    : ["shadow-only", "champion-identity-mismatch"].includes(modelSignal?.status)
      && promotionGate?.status === "shadow"
      && promotionGate?.onlineEffect === "shadow"
      && promotionGate?.eligibleScope === "none"
      && formalStrategy?.activation?.onlineEffect === "shadow"
      && formalStrategy?.activation?.modelSignalEffect === "shadow"
      && formalStrategy?.activation?.riskGuard?.looseningAllowed === false;
  pushCheck("04-model-backtest-calibration", "model-signal candidate is audited separately from market-only calibration", hasAll(modelBacktest, [
    "bestModelCandidateId",
    "candidateUsesModelSignal",
    "balancedModelCandidateCount"
  ]) && hasAll(modelStrategy, [
    "modelSignal",
    "modelSignalCandidate",
    "bestCandidateUsesModelSignal",
    "model-signal-gate"
  ]) && hasAll(verifyModelPromotionGate, [
    "promotion gate model-signal status matches shadow best model",
    "promotion gate model-signal candidate payload matches evaluation"
  ]) && modelSignalStateConsistent
    && modelSignalExposureConsistent
    && modelSignalMetricsAuditable
    && modelSignalPerformanceFailClosed, {
      files: [
        "scripts/runModelBacktest.cjs",
        "scripts/optimizePredictionStrategy.cjs",
        "scripts/verifyModelPromotionGate.cjs"
      ],
      modelSignal,
      modelSignalStateConsistent,
      modelSignalExposureConsistent,
      modelSignalMetricsAuditable,
      modelSignalMarginalStateConsistent,
      modelSignalPerformanceFailClosed,
      modelSignalCandidateId: modelSignalCandidate?.id || null,
      bestModelLogLossImprovement: Number.isFinite(bestModelLogLossImprovement) ? bestModelLogLossImprovement : null,
      bestModelBrierImprovement: Number.isFinite(bestModelBrierImprovement) ? bestModelBrierImprovement : null,
      marketOnlyBestCandidateId: promotionGate?.shadowCandidate?.id || null
    });

  pushCheck("04-model-backtest-calibration", "release mirrors public model artifacts into store", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes("sync_model_artifact_mirrors")
    && text.includes("run_model_artifact_catchup")
    && (text.includes("npm run model:backtest") || text.includes('"$NODE_HOME/bin/npm" run model:backtest'))
    && (text.includes("npm run optimize:strategy") || text.includes('"$NODE_HOME/bin/npm" run optimize:strategy'))
    && text.includes('local public_data_dir="${app_dir}/public/data"')
    && text.includes('"${public_data_dir}/model-evaluation.json"')
    && text.includes("model-artifacts/evaluation.json")
    && text.includes('"${public_data_dir}/model-strategy.json"')
  )) && releaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$NEXT_DIR"')
    && bundleReleaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$BUILD_DIR"'), {
    files: ["deploy/light-server/release.sh", "deploy/light-server/release-from-bundle.sh"]
  });

  pushCheck("05-hybrid-review-cutoff", "LLM is limited to risk review and explanation", hasAll(serverIndex, [
    "llm-risk-review-v2-evidence-boundary",
    "buildLlmEvidenceBundle",
    "validateLlmReviewRow",
    "evidenceIds",
    "riskReview",
    "tierAdjustment",
    "canOverrideProbabilities",
    "canOverrideRecommendationDirection"
  ]) && hasAll(verifyLlm, [
    "VERIFY_LLM_REVIEW_REPAIR",
    "llm invalid rows repaired before audit",
    "llm review boundary audit fields",
    "llm review source prediction signature"
  ]) && hasAll(verifyLlmEvidence, [
    "server prompt no longer serializes full externalSignals",
    "server builds an evidence bundle before relay invocation",
    "legacy row without retrieval commitment is audit-only and not publishable",
    "rawExternalSignalsInPrompt: false"
  ]), {
    files: [
      "server/index.cjs",
      "src/services/llmEvidenceBoundary.cjs",
      "scripts/verifyLlmReviewBoundary.cjs",
      "scripts/verifyLlmEvidenceBoundary.cjs"
    ]
  });

  pushCheck("05-hybrid-review-cutoff", "post-cutoff predictions are locked and audited", hasAll(serverIndex, [
    "llmReviewWindowOpen",
    "generatedBeforeCutoff",
    "predictionAuditSignature"
  ]) && hasAll(verifyAudit, [
    "cutoffTime",
    "featureSnapshot",
    "featureSnapshotHash",
    "locked predictions keep snapshot signature",
    "backtest leakage guard restricts promotion to immutable v2 decision snapshots"
  ]), { files: ["server/index.cjs", "scripts/verifyPredictionAudit.cjs"] });

  pushCheck("05-hybrid-review-cutoff", "source fallback keeps stale data instead of empty publishes", hasAll(verifyFallback, [
    "source-fallback",
    "fallback keeps current data",
    "fallback keeps history data",
    "fallback meta marked stale",
    "fallback sqlite remains readable",
    "fallback health stays serviceable but degraded",
    "fallback reliability window expires recommendation",
    "fallbackWithinReliableWindow",
    "fallback v1 current served from sqlite",
    "fallback v1 current marked stale",
    "/api/v1/matches/current?view=list"
  ]) && hasAll(serverIndex, [
    "publicSourceHealth",
    "getAdminSourceHealth",
    "V1_FALLBACK_MAX_STALE_SECONDS",
    "fallbackWithinReliableWindow",
    "fallbackMaxAgeSeconds",
    "SOURCE_STRICT_PRIMARY_HEALTH",
    "500 fallback serviceable",
    "stale"
  ]) && envExample.includes("V1_FALLBACK_MAX_STALE_SECONDS=3600")
    && envExample.includes("SOURCE_STRICT_PRIMARY_HEALTH=0"), { files: ["scripts/verifySourceFallback.cjs", "server/index.cjs", "deploy/light-server/env.example"] });

  pushCheck("05-hybrid-review-cutoff", "independent fast-file Sporttery relay keeps live freshness", hasAll(serverIndex, [
    "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT",
    "relayFastLaneValidation",
    "/api/admin/sporttery-relay-fast-lane",
    "relayCurrentFresh",
    "syncMetaCurrentStale",
    "sporttery sync metadata current lane is stale, but relay current snapshot is fresh and serviceable"
  ]) && hasAll(verifySportteryRelaySnapshot, [
    "current-only relay accepted",
    "SPORTTERY_RELAY_REQUIRE_PAGED",
    "current endpoint is enough for live/current freshness"
  ]) && hasAll(verifyProduction, [
    "sampleFastSportteryRelaySnapshot",
    "sporttery full relay rejects compact fast snapshot",
    "sporttery fast relay current calculator validate accepted",
    "sporttery fast relay rejects archive methods"
  ]) && hasAll(verifyCurrentLaneFreshness, [
    "currentLaneFresh",
    "fresh current lane is not marked stale",
    "current freshness follows latest source observation"
  ]) && Boolean(scripts["verify:current-lane-freshness"]), {
    files: [
      "server/index.cjs",
      "scripts/verifySportteryRelaySnapshot.cjs",
      "scripts/verifyProductionReadiness.cjs",
      "scripts/verifyCurrentLaneFreshness.cjs"
    ]
  });

  pushCheck("06-c-end-release-experience", "frontend consumes v1 APIs and exposes observability DOM contracts", hasAll(appContext, [
    "apiBaseRef.current || '/api/v1'",
    "matches/current?view=list",
    "dataUrls('/source-health'",
    "dataUrls('/model/evaluation'"
  ]) && hasAll(predictionsList, [
    'data-testid="data-sync-strip"',
    'data-testid="source-health-panel"',
    'data-testid="model-governance-panel"',
    "data-sporttery-egress-status",
    "data-model-input-audit-ok",
    "data-model-risk-tier"
  ]) && hasAll(appContextCore, [
    "modelEvaluation?:",
    "inputAudit?:",
    "riskTiers?:",
    "sourceHealth?:",
    "sportteryEgress?:"
  ]), { files: ["src/context/AppContext.tsx", "src/pages/PredictionsList.tsx", "src/context/AppContextCore.ts"] });

  pushCheck("06-c-end-release-experience", "frontend timeout, abort, and retained-history regressions block production", hasAll(
    verifyReviewSettlement,
    [
      "internally timed out fetches are typed and receive the bounded transient retry",
      "caller aborts are silent while real current and history failures remain observable",
      "one failed history refresh preserves the previously loaded history state"
    ]
  ) && hasAll(verifyProduction, [
    'runLocalJson(["scripts/verifyReviewSettlementPresentation.cjs"])',
    '"frontend fetch/history resilience contract"'
  ]) && Boolean(scripts["verify:review-settlement"]), {
    files: [
      "src/context/AppContext.tsx",
      "scripts/verifyReviewSettlementPresentation.cjs",
      "scripts/verifyProductionReadiness.cjs"
    ],
    script: "verify:review-settlement"
  });

  pushCheck("06-c-end-release-experience", "runtime config and local protected preview use the active relay lane", runtimeConfig?.dataApiBase === "/api/v1"
    && Boolean(scripts["preview:server"])
    && hasAll(startLocalPreview, [
      'path.join(rootDir, ".codex-tmp", "sporttery-relay-snapshot.json")',
      "fs.existsSync(collectorRelaySnapshotPath)",
      "SPORTTERY_RELAY_SNAPSHOT: previewRelaySnapshotPath",
      'RELAY_FAST_WATCHER_ENABLED: process.env.RELAY_FAST_WATCHER_ENABLED || "1"',
      'RELAY_FAST_WATCHER_POLL_MS: process.env.RELAY_FAST_WATCHER_POLL_MS || "1000"',
      "fastResultWatcher: health.sync?.fastResultWatcher || null"
    ]), {
      runtimeDataApiBase: runtimeConfig?.dataApiBase || null,
      script: "preview:server",
      relaySnapshot: ".codex-tmp/sporttery-relay-snapshot.json",
      fastResultWatcherDefault: true
    });

  pushCheck("06-c-end-release-experience", "safe release script aborts before swap and rolls back after swap", hasAll(releaseScript, [
    "CANDIDATE_PORT",
    "CANDIDATE_SQLITE_PATH",
    "SERVER_STORE_DIR=\"$CANDIDATE_STORE_DIR\"",
    "DATASTORE_SQLITE_PATH=\"$CANDIDATE_SQLITE_PATH\"",
    "npm run verify:production",
    "abort_before_swap \"candidate production readiness failed\"",
    "mv \"$APP_DIR\" \"$BACKUP_DIR\"",
    "mv \"$BACKUP_DIR\" \"$APP_DIR\"",
    "backup_live_sqlite_for_rollback",
    "restore_live_sqlite_after_rollback",
    "restore_model_artifacts_after_rollback",
    "systemctl start \"$WORKER_SERVICE_NAME\"",
    "post-health live store refresh failed",
    "post-refresh health failed",
    "post-swap production readiness failed",
    "PUBLIC_BASE_URL",
    "npm run verify:remote-public",
    "rollback \"public origin readiness failed\""
  ]), { file: "deploy/light-server/release.sh" });

  pushCheck("06-c-end-release-experience", "bundle release path supports uncommitted candidate packages", hasAll(bundleReleaseScript, [
    "TRUSTED_SOURCE_DIR",
    "BUNDLE_SHA256",
    "/var/lib/football-release/recovery/current",
    "initialize_release_recovery_snapshot",
    "restore_pre_swap_transaction",
    "restore_app_tree_after_rollback",
    "CANDIDATE_SQLITE_PATH",
    "scripts/verifyProductionReadiness.cjs",
    "post-health live store refresh failed",
    "post-refresh health failed",
    "REMOTE_BASE_URL=\"$PUBLIC_BASE_URL\"",
    "rollback \"public origin readiness failed\"",
    "mv \"$APP_DIR\" \"$BACKUP_DIR\"",
    "restore_external_model_artifacts_after_rollback",
    "MODEL_ARTIFACT_TOKENS=(strategy evaluation candidate-registry candidate-challenger-suite candidate-temperature-suite candidate-common-cohort-g2-v1 candidate-common-cohort-g2-v2 candidate-capture-status benchmark-prospective-ledger)",
    "scripts/candidateReleaseContinuity.cjs\" snapshot",
    "scripts/candidateReleaseContinuity.cjs\" verify",
    ".release-candidate-continuity.json",
    "/var/lib/football-predict/model-strategy.json",
    "/var/lib/football-predict/model-artifacts/evaluation.json",
    "/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json",
    "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json",
    "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json",
    "/var/lib/football-predict/candidate-prospective-capture-status.json",
    "/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json",
    '"$NODE_HOME/bin/node" scripts/compactPublicOddsHistory.cjs',
    "systemctl start \"$WORKER_SERVICE_NAME\""
  ]) && !/hhad[_-]companion[_-]audit/i.test(bundleReleaseScript)
    && hasAll(createReleaseBundle, [
    "football-release-",
    "sha256Path",
    "manifestPath",
    "signaturePath",
    "signManifestBytes",
    "\".git\"",
    "\"node_modules\"",
    "\"dist\"",
    "\"server-data\"",
    "\"logs\"",
    "`--exclude=${entry}`",
    "scripts/privateModelArtifactStore.cjs",
    "scripts/asOfResultTimeline.cjs",
    "scripts/verifyAsOfResultTimeline.cjs",
    "scripts/walkForwardValidation.cjs",
    "scripts/verifyWalkForwardValidation.cjs",
    "src/services/marketMovement.cjs",
    "scripts/verifyMarketMovement.cjs",
    "src/services/predictionPresentation.ts",
    "scripts/verifyFrontendEvidenceSemantics.cjs",
    "scripts/candidateProspectiveTemperatureNeutralizationSuite.cjs",
    "scripts/verifyCandidateProspectiveTemperatureNeutralizationSuite.cjs",
    "public/data/model-evaluation.json",
    "modelEvaluationArtifact",
    "rolling-backtest-v19",
    "walk-forward-promotion-validation-v3",
    "nested-expanding-window-candidate-selection-v2",
    "scripts/compactPublicOddsHistory.cjs",
    "deploy/light-server/release-from-bundle.sh"
  ]) && hasAll(verifyReleaseBundleSafety, [
    "scripts/asOfResultTimeline.cjs",
    "scripts/verifyAsOfResultTimeline.cjs",
    "scripts/walkForwardValidation.cjs",
    "scripts/verifyWalkForwardValidation.cjs",
    "src/services/marketMovement.cjs",
    "scripts/verifyMarketMovement.cjs",
    "src/services/predictionPresentation.ts",
    "scripts/verifyFrontendEvidenceSemantics.cjs",
    "scripts/candidateProspectiveTemperatureNeutralizationSuite.cjs",
    "scripts/verifyCandidateProspectiveTemperatureNeutralizationSuite.cjs",
    "public/data/model-evaluation.json",
    "modelEvaluationMetadataMatches",
    "rolling-backtest-v19",
    "walk-forward-promotion-validation-v3",
    "nested-expanding-window-candidate-selection-v2",
    "scripts/compactPublicOddsHistory.cjs"
  ]) && hasAll(deployReleaseBundle, [
    "RELEASE_DEPLOY_DRY_RUN",
    "RELEASE_DEPLOY_ALLOW_STALE_BUNDLE",
    "RELEASE_BUNDLE_PATH",
    "scp",
    "ssh",
    "verifyManifestSignature",
    'remoteEntrypoint = "/usr/local/sbin/football-release"',
    'remoteDir = "/var/lib/football-release/incoming"',
    ".manifest.sig",
    "sha256 mismatch",
    "release bundle is older than current workspace changes",
    "remote release preflight",
    "sudo -n ${shellQuote(remoteEntrypoint)} --check"
  ]) && !deployReleaseBundle.includes("sudo -n true")
    && !deployReleaseBundle.includes("sudo mv")
    && !deployReleaseBundle.includes("remoteReleaseScriptPath")
    && hasAll(releaseWrapper, [
      "openssl dgst -sha256 -verify",
      "assert_regular_upload",
      "archive must contain exactly one release-from-bundle.sh",
      "archive must contain exactly one compactPublicOddsHistory.cjs",
      "signed odds compactor has invalid JavaScript syntax",
      "consume_release_sequence_before_execution",
      "/var/lib/football-release/recovery/current",
      "env -i"
    ]) && hasAll(compactPublicOddsHistory, [
      "public-odds-history-compaction-v2",
      "odds history input is not valid JSON",
      "odds history mirror digests differ after compaction",
      "mirrorDigestsMatch: true"
  ]) && verifySignedReleaseEntrypoints.includes("signed candidate odds compaction is file-based and fail-closed"), { files: ["deploy/light-server/release-from-bundle.sh", "deploy/light-server/football-release", "scripts/compactPublicOddsHistory.cjs", "scripts/createReleaseBundle.cjs", "scripts/verifyReleaseBundleSafety.cjs", "scripts/deployReleaseBundle.cjs"] });

  pushCheck("06-c-end-release-experience", "release freeze keeps the candidate deadline heartbeat live and fail-closed", hasAll(bundleReleaseScript, [
    "start_release_candidate_heartbeat_keeper",
    "wait_for_frozen_worker_children_to_drain",
    "/sys/fs/cgroup${control_group}/cgroup.procs",
    "frozen sync worker child processes did not drain before keeper handoff",
    "release heartbeat keeper failed its first exact evaluatedAt gate",
    "release_candidate_heartbeat_keeper_is_healthy",
    "release_candidate_heartbeat_keeper_has_latched_failure",
    "stop_release_candidate_heartbeat_keeper",
    "stop_release_candidate_heartbeat_keeper clean",
    "release_candidate_heartbeat_keeper_clean_stop_evidence_is_valid",
    "pre-swap-legacy-top-level-due",
    "allowPreSwapLegacyTopLevelDueOmission",
    "KillMode=mixed",
    "TimeoutStopSec=35s",
    "--uid=football",
    "rollback fail-stop: release heartbeat keeper could not be reaped",
    "fail-stop: release heartbeat keeper could not be reaped from EXIT trap"
  ]) && hasAll(releaseHeartbeatKeeper, [
    "release-candidate-heartbeat-keeper-v2",
    "prospective-deadline-heartbeat-v2",
    "candidate-prospective-readiness-preview-v2",
    "CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT",
    "exact-heartbeat-not-published",
    "capture failed closed and latched until explicit stop",
    "holdUntilExplicitStop",
    "failed-latched",
    "process.on(\"SIGTERM\"",
    "stopDrained",
    "activeAttempt",
    "atomicDecisionRecordInvariantsMatch",
    "allowPreSwapLegacyTopLevelDueOmission",
    "intervalSeconds: integerInRange(raw?.intervalSeconds ?? 20, 5, 30"
  ]) && hasAll(createReleaseBundle, [
    "scripts/runReleaseCandidateHeartbeatKeeper.cjs"
  ]) && hasAll(verifyReleaseBundleSafety, [
    "scripts/runReleaseCandidateHeartbeatKeeper.cjs"
  ]), { files: [
    "deploy/light-server/release-from-bundle.sh",
    "scripts/runReleaseCandidateHeartbeatKeeper.cjs",
    "scripts/verifyReleaseTransactionSafety.cjs",
    "scripts/createReleaseBundle.cjs",
    "scripts/verifyReleaseBundleSafety.cjs"
  ] });

  pushCheck("06-c-end-release-experience", "release prebuilds SQLite online and activates it only after post-freeze CAS", hasAll(bundleReleaseScript, [
    "release-live-sqlite-prebuild-v1",
    "run_live_sqlite_prebuild_step",
    "prepare_live_sqlite_prebuild",
    "live SQLite prebuild requires the heavyweight sync worker to be stopped",
    "live SQLite prebuild refuses to overlap an active sync worker",
    "start_release_sync_write_barrier",
    "canonical live sync write barrier did not drain cleanly after service stop",
    "RELEASE_LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS:-120",
    "LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS\" -ge 60",
    "LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS\" -le 120",
    "IOSchedulingPriority=4",
    "IOWeight=50",
    "MemoryHigh=768M",
    "MemoryMax=1024M",
    "MemorySwapMax=256M",
    "OOMPolicy=stop",
    "assert_live_sqlite_prebuild_capacity",
    "live SQLite prebuild capacity gate rejected the release host",
    "root:football:640:1",
    "run_prebuild_stage copy-rollback",
    "run_prebuild_stage stage-copy",
    "run_prebuild_stage export",
    "run_prebuild_stage quick_check",
    "run_prebuild_stage seal",
    "LIVE_SQLITE_PREBUILD_HEARTBEAT_MAX_AGE_SECONDS=90",
    "POST_PREBUILD_HTTP_HEARTBEAT_MAX_AGE_SECONDS=110",
    "candidate deadline capture heartbeat exceeded 90 seconds after live SQLite prebuild",
    "candidate deadline capture heartbeat exceeded 110 seconds before second refresh",
    "scripts/sqliteReleaseSeal.cjs",
    "source-seal.json",
    "rollback-seal.json",
    "finalize-recovery",
    "verify-metadata",
    "verify_live_sqlite_prebuild_after_freeze",
    "activate_prebuilt_live_sqlite",
    "post-freeze O(1) source/stage seal CAS accepted the transient rollback snapshot",
    "post-freeze SQLite seal CAS rejected the prebuild; restart without swapping",
    "BREAK-GLASS: post-freeze SQLite seal CAS rejected the prebuild; use stopped-window snapshot/export",
    "CAS-verified prebuilt live SQLite activation failed"
  ]) && hasAll(sqliteReleaseSeal, [
    "O_NOFOLLOW",
    "mtimeNs",
    "ctimeNs",
    "copyRollbackSnapshot",
    "finalizeRecoverySnapshot",
    "verifyMetadataSeal"
  ]) && hasAll(releaseSyncWriteBarrier, [
    "release-sync-write-barrier-v1",
    "acquireSyncLock",
    "live sync write barrier ownership changed before release",
    "await lock.release()"
  ]) && hasAll(releasePrebuildPolicy, [
    "release-live-sqlite-prebuild-policy-v2",
    "RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB",
    "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB",
    "DEFAULT_MIN_MEM_AVAILABLE_MIB = 1152",
    "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB",
    "DEFAULT_MAX_APP_MEMORY_CURRENT_MIB = 640",
    "DEFAULT_MAX_APP_WORKING_SET_MIB = 512",
    "evaluateCapacity",
    "evaluateFreshness"
  ]) && hasAll(bundleReleaseScript, [
    'set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB" "1152"',
    'set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB" "640"',
    'set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB" "512"'
  ]) && hasAll(createReleaseBundle, [
    "scripts/runReleaseSyncWriteBarrier.cjs",
    "scripts/releasePrebuildPolicy.cjs"
  ]) && hasAll(verifyReleaseBundleSafety, [
    "scripts/runReleaseSyncWriteBarrier.cjs",
    "scripts/verifyReleaseSyncWriteBarrier.cjs",
    "scripts/releasePrebuildPolicy.cjs"
  ]) && hasAll(scripts["verify:production"] || "", [
    "scripts/verifyReleaseSyncWriteBarrier.cjs"
  ]), { files: [
    "deploy/light-server/release-from-bundle.sh",
    "scripts/runReleaseSyncWriteBarrier.cjs",
    "scripts/verifyReleaseSyncWriteBarrier.cjs",
    "scripts/releasePrebuildPolicy.cjs",
    "scripts/sqliteReleaseSeal.cjs",
    "scripts/verifyReleaseTransactionSafety.cjs"
  ] });

  pushCheck("06-c-end-release-experience", "cold release recovery is fixed, directional, and behaviorally tested", hasAll(releaseWrapper, [
    'if [ "${1:-}" = "--recover" ]',
    'RECOVERY_HELPER="/usr/local/libexec/football-release-recovery.cjs"',
    "acquire_release_lock",
    'RELEASE_SEQUENCE="$MANIFEST_SEQUENCE"'
  ]) && hasAll(releaseRecoveryHelper, [
    "const TRANSACTION_VERSION = 3",
    'treeMarker: readTreeMarker(mapped, ".release-tree-identity")',
    "value !== identity.treeMarker",
    "ROLLBACK_PHASES",
    "FORWARD_PHASES",
    "prevalidateRestoreTargets",
    '["strategy", `${STORE_PATH}/model-strategy.json`]',
    '["evaluation", `${STORE_PATH}/model-artifacts/evaluation.json`]',
    '["candidate-registry", `${STORE_PATH}/model-artifacts/candidate-prospective-registry.json`]',
    '["candidate-challenger-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-challenger-suite.json`]',
    '["candidate-temperature-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-temperature-neutralization-suite.json`]',
    '["candidate-common-cohort-g2-v1", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2.json`]',
    '["candidate-common-cohort-g2-v2", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2-v2.json`]',
    '["candidate-capture-status", `${STORE_PATH}/candidate-prospective-capture-status.json`]',
    '["benchmark-prospective-ledger", `${STORE_PATH}/model-artifacts/benchmark-prospective-ledger.json`]',
    '["candidate-common-cohort-g2", COMMON_COHORT_G2_V1_PATH]',
    "const LEGACY_MODEL_ARTIFACT_COUNTS = new Set([2, 4, 5, 6, 7])",
    "isolateKnownFailedTree",
    "resolveTransaction"
  ]) && !/hhad[_-]companion[_-]audit/i.test(releaseRecoveryHelper)
    && hasAll(privateModelArtifactStore, [
      "private_model_artifacts",
      "BEGIN IMMEDIATE"
    ]) && hasAll(deployReleaseBundle, [
    "if (recoverMode)",
    "--recover",
    "recoveryPending=0",
    'REMOTE_REQUIRE_SQLITE: "1"',
    'REMOTE_REQUIRE_SYNC_WORKER: "1"'
  ]) && hasAll(verifyReleaseRecovery, [
    "rollbackPhases",
    "forwardPhases",
    "tampered snapshot must be rejected",
    "unexpected tree nonce must be rejected",
    "unknown APP identity must be rejected",
    "private_model_artifacts",
    "old-hhad-companion",
    "committed recovery must never roll back APP"
  ]) && scripts["release:recover"] === "node scripts/deployReleaseBundle.cjs --recover"
    && scripts["verify:release-recovery"] === "node scripts/verifyReleaseRecovery.cjs", {
      files: [
        "deploy/light-server/football-release",
        "deploy/light-server/football-release-recovery.cjs",
        "scripts/privateModelArtifactStore.cjs",
        "scripts/deployReleaseBundle.cjs",
        "scripts/verifyReleaseRecovery.cjs"
      ],
      scripts: ["release:recover", "verify:release-recovery"]
    });

  pushCheck("06-c-end-release-experience", "sudo automation is limited to signed release and fixed relay promoters", hasAll(releaseSigning, [
    "rsa-sha256-pkcs1-v1_5",
    "verifyManifestSignature"
  ]) && hasAll(relayPromoter, [
    'TARGET="/var/lib/football-predict/sporttery-relay-snapshot.json"',
    "snapshot sha256 mismatch",
    "flock -x 9",
    "summary.rows does not match endpoint payload rows",
    "capturedAt must be strictly newer than the current target"
  ]) && hasAll(releaseBootstrap, [
    "/usr/local/sbin/football-release",
    "/usr/local/libexec/football-release-recovery.cjs",
    "/usr/local/sbin/football-relay-promote",
    'RECOVERY_CURRENT_PATH="/var/lib/football-release/recovery/current"',
    "recovery transaction pending; run the fixed recovery entrypoint before bootstrap",
    "sudoers was NOT installed"
  ]) && hasAll(releaseSudoers, [
    "NOPASSWD: NOSETENV:",
    "/usr/local/sbin/football-release --recover",
    "^[0-9a-f]{64}$"
  ]) && !releaseSudoers.includes("NOPASSWD: ALL")
    && verifySignedReleaseEntrypoints.includes("tampered manifest is rejected")
    && hasAll(verifyCleanupRelayHardening, [
      "state-directory cleanup still functions",
      "relay rejects forged summary counts",
      "relay rejects forged usable endpoint counts",
      "relay rejects capturedAt rollback"
    ]) && hasAll(verifyDeploymentConfig, [
      "cleanupRelayHardeningRun",
      "cleanup and relay hardening behavioral verifier passes"
    ]), {
      files: [
        "scripts/releaseSigning.cjs",
        "deploy/light-server/football-release",
        "deploy/light-server/football-relay-promote",
        "deploy/light-server/football-automation.sudoers",
        "deploy/light-server/bootstrap-release-entrypoints.sh",
        "scripts/verifyCleanupRelayHardening.cjs",
        "scripts/verifyDeploymentConfig.cjs"
      ]
    });

  pushCheck("06-c-end-release-experience", "offline release kit supports console recovery", hasAll(createOfflineReleaseKit, [
    "football-offline-release-kit-",
    "release bundle is older than current workspace changes",
    "README-server-console.md",
    "release-from-bundle.sh",
    "restore-ubuntu-operator-key.sh",
    "FOOTBALL_OPERATOR_KEY_FINGERPRINT",
    "does not contain an operator public or private key",
    "BUNDLE_SHA256",
    "sha256sum -c",
    "REMOTE_REQUIRE_SQLITE=1",
    "tar",
    "PUBLIC_BASE_URL"
  ]) && hasAll(restoreSshOperatorKey, [
    'readonly TARGET_USER="ubuntu"',
    'readonly KEY_SOURCE="/tmp/football-operator.pub"',
    "FOOTBALL_OPERATOR_KEY_FINGERPRINT",
    'install -d -o "$TARGET_USER" -g "$target_group" -m 0700',
    'chmod 0600 "$authorized_tmp"',
    'mv -fT -- "$authorized_tmp" "$authorized_keys"',
    "/usr/sbin/sshd -t"
  ]) && hasAll(createReleaseBundle, [
    '"deploy/light-server/restore-ubuntu-operator-key.sh"',
    '"scripts/verifySshOperatorKeyRecovery.cjs"'
  ]) && hasAll(verifySshOperatorKeyRecovery, [
    "recovery entrypoint embeds no operator key material",
    "recovery does not loosen ssh, firewall, or password policy",
    "offline kit carries the recovery program but never the operator key"
  ]) && scripts["verify:ssh-key-recovery"] === "node scripts/verifySshOperatorKeyRecovery.cjs"
    && verifyProduction.includes("scripts/verifySshOperatorKeyRecovery.cjs")
    && verifyProduction.includes("SSH operator-key recovery artifact")
    && verifyDeploymentConfig.includes("sshOperatorKeyRecoveryRun")
    && verifyDeploymentConfig.includes("SSH operator-key recovery is narrow and behaviorally gated")
    && hasAll(lightServerDoc, [
    "release:offline-kit",
    "cloud provider console",
    "VNC",
    "restore-ubuntu-operator-key.sh",
    "/tmp/football-operator.pub",
    "guarded candidate",
    "release, not a manual overwrite"
  ]), {
    files: [
      "scripts/createOfflineReleaseKit.cjs",
      "deploy/light-server/restore-ubuntu-operator-key.sh",
      "scripts/verifySshOperatorKeyRecovery.cjs",
      "docs/light-server-deployment.md"
    ],
    scripts: ["release:offline-kit", "verify:ssh-key-recovery"]
  });

  pushCheck("06-c-end-release-experience", "signed release SSH pins one console-verified host key", hasAll(releaseSshHostKeyPin, [
    "RELEASE_DEPLOY_HOST_KEY_SHA256",
    "release known_hosts file must contain exactly one non-comment entry",
    "release SSH host-key fingerprint does not match the explicit pin",
    "StrictHostKeyChecking=yes",
    "UserKnownHostsFile=",
    "GlobalKnownHostsFile=",
    "UpdateHostKeys=no",
    "HostKeyAlgorithms="
  ]) && hasAll(deployReleaseBundle, [
    "resolveReleaseSshHostKeyPin",
    "buildPinnedSshBaseOptions",
    "release SSH host-key pin validation failed"
  ]) && hasAll(checkReleaseStatus, [
    "resolveReleaseSshHostKeyPin",
    "ssh host-key pin invalid"
  ]) && hasAll(verifyReleaseSshHostKeyPin, [
    "mismatched explicit fingerprint is rejected before SSH",
    "known_hosts entry for the wrong port is rejected",
    "fails closed when no explicit fingerprint is supplied"
  ]) && scripts["verify:release-host-key-pin"] === "node scripts/verifyReleaseSshHostKeyPin.cjs"
    && verifyProduction.includes("scripts/verifyReleaseSshHostKeyPin.cjs")
    && verifyProduction.includes("release SSH host-key pin artifact")
    && !deployReleaseBundle.includes("StrictHostKeyChecking=accept-new")
    && !checkReleaseStatus.includes("StrictHostKeyChecking=accept-new")
    && hasAll(lightServerDoc, [
      "cloud serial/VNC console",
      "RELEASE_DEPLOY_KNOWN_HOSTS",
      "RELEASE_DEPLOY_HOST_KEY_SHA256",
      "Do not populate this file with `ssh-keyscan` or trust-on-first-use"
    ]), {
    files: [
      "scripts/releaseSshHostKeyPin.cjs",
      "scripts/deployReleaseBundle.cjs",
      "scripts/checkReleaseStatus.cjs",
      "scripts/verifyReleaseSshHostKeyPin.cjs",
      "docs/light-server-deployment.md"
    ],
    script: "verify:release-host-key-pin"
  });

  pushCheck("06-c-end-release-experience", "release watch can wait for ssh recovery window", hasAll(watchReleaseWindow, [
    "RELEASE_WATCH_AUTO_DEPLOY",
    "RELEASE_WATCH_ATTEMPTS",
    "scripts/checkReleaseStatus.cjs",
    "canAttemptDeploy",
    "isLocalCandidateLive",
    "remoteRelease?.ok === true",
    "matchesLocalCandidate === true",
    "remoteSha256 === localSha256",
    "scripts/deployReleaseBundle.cjs",
    "scripts/verifyRemotePublicReadiness.cjs",
    "REMOTE_REQUIRE_SQLITE",
    "auto deploy disabled"
  ]) && hasAll(verifyReleaseWatchPolicy, [
    "healthy old live release is not the local candidate",
    "old live release auto-deploys when the candidate window opens",
    "matching candidate marker completes the watch",
    "matchesLocalCandidate false cannot complete"
  ]) && scripts["verify:release-watch"] === "node scripts/verifyReleaseWatchPolicy.cjs"
    && hasAll(verifyProduction, [
      "scripts/verifyReleaseWatchPolicy.cjs",
      "release watch candidate identity artifact"
    ]) && hasAll(lightServerDoc, [
    "release:watch",
    "RELEASE_WATCH_AUTO_DEPLOY=1",
    "canAttemptDeploy: true",
    "remote release marker equals",
    "rollback path"
  ]), {
    files: [
      "scripts/watchReleaseWindow.cjs",
      "scripts/verifyReleaseWatchPolicy.cjs",
      "docs/light-server-deployment.md"
    ],
    scripts: ["release:watch", "verify:release-watch"]
  });

  pushCheck("06-c-end-release-experience", "remote public readiness verifies live cutover state", hasAll(verifyRemotePublic, [
    "REMOTE_BASE_URL",
    "REMOTE_REQUIRE_SQLITE",
    "protected static payloads disabled",
    "protected v1 reads deny anonymous",
    "sqlite read source when required",
    "candidate prospective cutoff heartbeat is live and unblocked",
    "prospective-deadline-heartbeat-v2",
    "candidate-prospective-readiness-preview-v2",
    "candidate-dual-market-decision-record-v1",
    "formalMetricMarket",
    "companionMarket",
    "dual-market-decision-record",
    "dual-market-decision-hash",
    "candidateDueCaptureEventsAdded === candidateDueMatches",
    "candidateDueDecisionEventsAdded + candidateDueExclusionEventsAdded",
    "candidateDueAtomicDecisionEventsAdded === candidateDueDecisionEventsAdded",
    "dueCaptureComplete",
    "dueAtomicComplete",
    "deadline-cohort-evaluated",
    "candidateBlocked === 0",
    "candidate-official-market-coverage-preview-v1",
    "candidatePublishedChainGapMatches === 0",
    "awaitingClassificationComplete"
  ]), { file: "scripts/verifyRemotePublicReadiness.cjs" });

  pushCheck("06-c-end-release-experience", "candidate readiness separates unpublished markets from published atomic-chain gaps",
    hasAll(captureCandidateProspectiveDeadline, [
      "candidate-official-market-coverage-preview-v1",
      "official-had-market-not-published",
      "eligible-decision-snapshot-not-observed",
      "publishedChainGapMatches",
      "awaitingClassificationComplete"
    ])
    && hasAll(serverIndex, [
      "compactCandidateMarketCoverage",
      "awaitingReasonCounts",
      "marketCoverage"
    ])
    && hasAll(verifyCandidateReadinessFullCoverage, [
      "candidate-readiness-full-coverage",
      "official-had-market-not-published",
      "publishedChainGapMatches",
      "awaitingClassificationComplete"
    ])
    && hasAll(verifyProduction, [
      "scripts/verifyCandidateReadinessFullCoverage.cjs",
      "candidate readiness classifies unpublished markets separately from published chain gaps"
    ]), {
      files: [
        "scripts/captureCandidateProspectiveDeadline.cjs",
        "server/index.cjs",
        "scripts/verifyCandidateReadinessFullCoverage.cjs",
        "scripts/verifyProductionReadiness.cjs"
      ]
    });

  pushCheck("06-c-end-release-experience", "candidate cutoff watcher enforces settled 500-row and 5-of-6 window goal", hasAll(
    watchCandidateProspectiveCapture,
    [
      "candidate-prospective-capture-watch-v4",
      "evaluateCandidateProspectiveGoal",
      "advanceCandidateHeartbeatContinuity",
      "advanceCalibrationChallengerContinuity",
      "advanceWatchHealthState",
      "monitoring-unhealthy",
      "candidate heartbeat continuity violation",
      "PROSPECTIVE_WATCH_TARGET_ROWS || 500",
      "PROSPECTIVE_WATCH_REQUIRED_WINDOWS || 6",
      "PROSPECTIVE_WATCH_REQUIRED_WINNING_WINDOWS || 5",
      "formal settled rows did not reach",
      "winning calendar windows",
      "progress.complete",
      "progress.healthy",
      "marketCoverage",
      "awaitingReasonCounts",
    ],
  )
    && hasAll(verifyProduction, [
      "scripts/verifyProspectiveWatchHealthPolicy.cjs",
      "scripts/verifyProspectiveWatchRecovery.cjs",
    ])
    && scripts["watch:candidate-prospective-capture"]
    === "node scripts/watchCandidateProspectiveCapture.cjs", {
    file: "scripts/watchCandidateProspectiveCapture.cjs",
    script: scripts["watch:candidate-prospective-capture"] || null,
  });

  pushCheck("06-c-end-release-experience", "remote refresh readiness proves the protected result-to-review pipeline", hasAll(verifyRemoteRefresh, [
    "remote refresh verification uses HTTPS",
    "public health proves SQLite primary reads",
    "kickoff-retention-v1",
    "current list has no expired unresolved matches",
    "official result lane is fresh",
    "history lane is fresh",
    "trustedOfficialResult",
    "availableReviewSamples",
    "missingReviewIds",
    "reviewLockedFieldsAgree",
    "mainLost",
    "mainVoid",
    "allLost",
    "allVoid",
    "referenceLost",
    "referenceVoid",
    "history and match detail agree",
    "admin refresh diagnostics prove official publish",
    "admin refresh diagnostics prove relay wake configuration",
    "REMOTE_REFRESH_ACCESS_TOKEN",
    "REMOTE_REFRESH_ADMIN_TOKEN",
    "REMOTE_REFRESH_REQUIRE_ADMIN",
    "--require-admin",
    "serializeRedactedPayload"
  ]) && hasAll(verifyRemoteRefreshContract, [
    "without leaking credentials",
    "missing protected token fails clearly",
    "strict release mode fails",
    "newest trusted finished rows cannot be replaced",
    "review-only locked-field and row drift fails",
    "same-origin worker cycle must finish at or after policy evaluation",
    "final serialization redacts access and admin tokens reflected",
    "expired unresolved rows and history/detail drift fail the gate",
    "fixed whitelist"
  ]) && hasAll(serverIndex, [
    "compactSyncWorkerRefreshDiagnostics",
    "refreshPipeline: compactSyncWorkerRefreshDiagnostics(syncWorkerStatus)",
    "return { cycle, wake, relayWake }"
  ]) && hasAll(verifyApiContracts, [
    "source-health admin refresh diagnostics are whitelisted",
    "refreshKeys",
    "relayWakeKeys"
  ]) && scripts["verify:remote-refresh"] === "node scripts/verifyRemoteRefreshPipeline.cjs"
    && scripts["verify:remote-refresh:strict"] === "node scripts/verifyRemoteRefreshPipeline.cjs --require-admin"
    && scripts["verify:remote-refresh-contract"] === "node scripts/verifyRemoteRefreshPipelineContract.cjs", {
    files: [
      "scripts/verifyRemoteRefreshPipeline.cjs",
      "scripts/verifyRemoteRefreshPipelineContract.cjs",
      "server/index.cjs"
    ],
    scripts: ["verify:remote-refresh", "verify:remote-refresh:strict", "verify:remote-refresh-contract"]
  });

  pushCheck("06-c-end-release-experience", "remote list detail and frozen archive share one recommendation direction", (
    hasAll(verifyRemoteRecommendationParity, [
      "remote-recommendation-parity-v1",
      "/api/v1/matches/current?view=list",
      "/api/v1/matches/${encodeURIComponent(id)}",
      "canonicalRecommendationDecision",
      "every scheduled row has an explicit BEST recommendation",
      "every directional post-kickoff or result-phase row has an immutable pre-match archive",
      "isAuthoritativeResultOnlyArchive",
      "resultOnlyArchives",
      "postKickoffScheduled",
      "archiveScopeCounts",
      "list, detail, and frozen archive expose one canonical direction",
      "REMOTE_RECOMMENDATION_ACCESS_TOKEN",
      "REMOTE_RECOMMENDATION_ACCESS_CODE_ADMIN_TOKEN",
      "/api/admin/access-codes",
      "/api/access/verify",
      "temporary QA access session is created, verified, and revoked",
      "VERIFY_ACCESS_TOKEN"
    ])
    && hasAll(recommendationProjectionParity, [
      "current-list-detail-recommendation-parity-v1",
      "archivedPreMatchPrediction",
      "match?.sourceStatus ?? match?.status",
      "had-hhad-projection-mismatch",
      "same-current-read-model-list-detail-projection",
      "aggregate-counts-only",
      "buildRecommendationProjectionParityAudit"
    ])
    && hasAll(verifyRecommendationProjectionParity, [
      "matching scheduled projections must pass",
      "changed BEST direction must fail",
      "changed HHAD line must fail",
      "matching immutable archives must pass",
      "public audit must not expose match id"
    ])
    && hasAll(verifyRemoteRecommendationParityContract, [
      "result phase replays the frozen archive",
      "direction drift is detected",
      "a wall-clock post-kickoff SCHEDULED row fails closed without an immutable archive",
      "committed result phase fails closed without an immutable archive",
      "cold-start model-only BEST and its immutable archive remain explicit without pretending to be official HAD",
      "without leaking the token",
      "an admin-only temporary QA code is verified and revoked without leaking secrets"
    ])
    && hasAll(syncData, [
      'marketEvidenceScope === "model-only-reference"',
      'oddsPoolCode: marketEvidenceScope === "model-only-reference" ? "HAD" : archivedPool',
      'prediction?.recommendationAction === "reference"',
      'Number(prediction?.odds) === 0',
      "pretending that an official market was published",
      "formal performance statistics"
    ])
    && hasAll(archivedPreMatchPrediction, [
      "marketEvidenceScope === 'model-only-reference'",
      "archivedPrediction.recommendationAction === 'reference'",
      "Number(archivedPrediction.odds) === 0"
    ])
    && [serverIndex, dataStore].every((source) => hasAll(source, [
      'const marketEvidenceScope = String(archive.marketEvidenceScope || "result-pool").trim();',
      'marketEvidenceScope === "model-only-reference"',
      'prediction?.recommendationAction === "reference"',
      'Number(prediction?.odds) === 0',
      "marketEvidenceScope,"
    ]))
    && hasAll(verifyArchivedPreMatchCutoff, [
      "modelOnlyReferenceArchived",
      "modelOnlyReferenceFormalPromotionRejected",
      "a model-only archive must not masquerade as a published SP row",
      "a model-only archive must remain outside the formal recommendation track"
    ])
    && hasAll(verifyProduction, [
      "scripts/verifyRemoteRecommendationParity.cjs",
      "scripts/verifyArchivedPreMatchCutoff.cjs",
      "model-only pre-match reference archive",
      "all protected list, detail, and frozen archive recommendations share one canonical direction",
      "REMOTE_RECOMMENDATION_ACCESS_CODE_ADMIN_TOKEN",
      "temporaryAccessCodeRevoked",
      "postKickoffScheduled",
      "archiveScopeCounts"
    ])
    && scripts["verify:remote-recommendation-parity"]
      === "node scripts/verifyRemoteRecommendationParity.cjs"
    && scripts["verify:remote-recommendation-parity-contract"]
      === "node scripts/verifyRemoteRecommendationParityContract.cjs"
    && scripts["verify:recommendation-projection-parity"]
      === "node scripts/verifyRecommendationProjectionParity.cjs"
    && scripts["verify:archived-prematch-cutoff"]
      === "node scripts/verifyArchivedPreMatchCutoff.cjs"
  ), {
    files: [
      "scripts/syncData.cjs",
      "src/services/archivedPreMatchPrediction.ts",
      "scripts/verifyArchivedPreMatchCutoff.cjs",
      "scripts/verifyRemoteRecommendationParity.cjs",
      "scripts/verifyRemoteRecommendationParityContract.cjs",
      "server/recommendationProjectionParity.cjs",
      "scripts/verifyRecommendationProjectionParity.cjs",
      "scripts/verifyProductionReadiness.cjs"
    ],
    scripts: [
      "verify:remote-recommendation-parity",
      "verify:remote-recommendation-parity-contract",
      "verify:recommendation-projection-parity",
      "verify:archived-prematch-cutoff"
    ]
  });

  pushCheck("06-c-end-release-experience", "release status reports deploy blockers", hasAll(checkReleaseStatus, [
    "canAttemptDeploy",
    "liveComplete",
    "ssh is not reachable",
    "public origin has not switched to sqlite",
    "remote release preflight failed",
    "remote cold-recovery helper does not match the candidate bundle",
    "checkRemoteRecoveryHelper",
    "inspectBundleEntrySha256",
    "recoveryPending=0",
    "remoteRelease",
    "markerSha256",
    "matchesLocalCandidate",
    "sudo -n /usr/local/sbin/football-release --check",
    "/var/lib/football-release/incoming",
    "anonymousDenied",
    "protectedStaticDisabled",
    "RELEASE_STATUS_STRICT",
    "RELEASE_STATUS_PORT",
    "RELEASE_DEPLOY_PORT"
  ]), { file: "scripts/checkReleaseStatus.cjs" });

  pushCheck("06-c-end-release-experience", "api contract gate self-starts local protected server", hasAll(verifyApiContracts, [
    "shouldAutoStartLocalServer",
    "CONTRACT_START_SERVER !== \"0\"",
    "api-contract-local-admin",
    "ADMIN_TOKEN: process.env.ADMIN_TOKEN || adminToken",
    "ACCESS_CODE_ADMIN_TOKEN: process.env.ACCESS_CODE_ADMIN_TOKEN || accessCodeAdminToken",
    "contract access-code create",
    "protected v1 reads require access"
  ]), { file: "scripts/verifyApiContracts.cjs" });

  const preApiSqliteConvergence = verifyProduction.indexOf(
    'await waitForSqlitePrimaryRead(checks, "sqlite primary read before API contracts")'
  );
  const apiContractGate = verifyProduction.indexOf(
    'const apiContracts = await runLocalJson(["scripts/verifyApiContracts.cjs"]'
  );
  pushCheck("06-c-end-release-experience", "production readiness converges SQLite before cross-request API contracts",
    preApiSqliteConvergence >= 0
      && apiContractGate > preApiSqliteConvergence, {
      preApiSqliteConvergence,
      apiContractGate,
      file: "scripts/verifyProductionReadiness.cjs"
    });

  pushCheck(
    "06-c-end-release-experience",
    "production verification runs the future-only temperature-neutralization suite gate",
    hasAll(scripts["verify:production"] || "", [
      "scripts/verifyCandidateProspectiveTemperatureNeutralizationSuite.cjs",
    ]),
    { file: "package.json" },
  );

  pushCheck(
    "06-c-end-release-experience",
    "production verification runs recommendation selection epoch chronology before readiness",
    hasAll(scripts["verify:production"] || "", [
      "scripts/runModelBacktest.cjs --verify-recommendation-selection-time-order",
      "scripts/verifyProductionReadiness.cjs",
    ]) && (scripts["verify:production"] || "").indexOf(
      "scripts/runModelBacktest.cjs --verify-recommendation-selection-time-order",
    ) < (scripts["verify:production"] || "").indexOf("scripts/verifyProductionReadiness.cjs"),
    { file: "package.json" },
  );

  pushCheck(
    "06-c-end-release-experience",
    "signed release uses a fail-closed dynamic transition lease around candidate verification",
    hasAll(releaseTransitionLease, [
      "decisionDeadlineFor",
      "captureFinalizationFor",
      "liveRecommendationCutoffMs",
      "kickoff-archive",
      "candidate transition horizon is too short",
      "candidate transition was crossed during verification",
      "candidate transition lease lacks required transition margin",
      "dataDigest",
      "inventoryDigest",
      "activeMatches",
      "sourceClockDigest",
      "nextTransition",
    ]) && hasAll(verifyReleaseTransitionLease, [
      "mixed timezone clocks are epoch ordered",
      "excluded matches still retain their kickoff archive transition",
      "invalid candidate clocks fail closed",
      "rejects schedule drift, crossed transitions and lost swap margin",
      "records source clock representation drift without rejecting unchanged semantics",
      "accepts expired-row inventory churn outside the leased future transition set",
      "rejects upcoming-row additions and removals",
      "rejects duplicate match identities before digest set folding",
      "rejects a changed match identity even when the row count is unchanged",
      "post-swap waits can reserve a larger rollback margin without weakening the lease",
    ]) && hasAll(bundleReleaseScript, [
      'releaseTransitionLease.cjs" create',
      'releaseTransitionLease.cjs" verify',
      "RuntimeMaxSec=${CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS}s",
      "CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT=\"$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT\"",
      "candidate transition horizon is unsafe before worker pause",
      "candidate transition crossed or atomic swap margin expired",
      "--required-margin-seconds",
      "verify_post_swap_transition_window",
    ]) && hasAll(scripts["verify:production"] || "", [
      "scripts/verifyReleaseTransitionLease.cjs",
      "scripts/verifyProductionReadiness.cjs",
    ]) && (scripts["verify:production"] || "").indexOf(
      "scripts/verifyReleaseTransitionLease.cjs",
    ) < (scripts["verify:production"] || "").indexOf("scripts/verifyProductionReadiness.cjs"),
    {
      files: [
        "scripts/releaseTransitionLease.cjs",
        "scripts/verifyReleaseTransitionLease.cjs",
        "deploy/light-server/release-from-bundle.sh",
        "package.json",
      ],
    },
  );

  pushCheck("06-c-end-release-experience", "production readiness aggregates required gates", requiredScripts.every((name) => Boolean(scripts[name]))
    && hasAll(verifyProduction, [
      "prediction audit",
      "model input leakage audit",
      "model risk tier artifact",
      "llm boundary stale review cleanup",
      "current match retention artifact",
      "model promotion artifact",
      "candidate admission audit",
      "HHAD companion shadow evaluation",
      "llm boundary artifact",
      "deployment config artifact",
      "release SSH host-key pin artifact",
      "access code concurrency artifact",
      "release transaction safety artifact",
      "legacy release disabled artifact",
      "server-primary data flow artifact",
      "api contract artifact",
      "frontend observability artifact",
      "frontend evidence semantics artifact",
      "candidate model evaluation schema and digest",
      "sqlite legacy jsonl import",
      "sqlite refreshed before local server",
      "sqlite primary read before API contracts",
      "sqlite primary read after refresh"
    ]), {
      requiredScripts,
      missingScripts: requiredScripts.filter((name) => !scripts[name]),
      optionalFallbackScripts,
      missingOptionalFallbackScripts: optionalFallbackScripts.filter((name) => !scripts[name])
    });

  pushCheck("06-c-end-release-experience", "sync meta exposes source fallback and current freshness", Boolean(syncMeta?.updatedAt || syncMeta?.capturedAt)
    && Boolean(syncMeta?.api)
    && Boolean(syncMeta?.sourceHealth || syncMeta?.sourceAttempt || syncMeta?.sourceFallback || syncMeta?.fallback), {
      file: "public/data/sync-meta.json",
      updatedAt: syncMeta?.updatedAt || syncMeta?.capturedAt || null,
      stale: syncMeta?.api?.stale ?? null,
      fallback: Boolean(syncMeta?.api?.fallback || syncMeta?.sourceFallback || syncMeta?.fallback?.keptExisting)
    }, false);

  const requiredChecks = checks.filter((check) => check.required);
  const failed = requiredChecks.filter((check) => !check.ok);
  const phaseSummary = Object.fromEntries(
    Array.from(new Set(checks.map((check) => check.phase))).map((phase) => {
      const phaseChecks = checks.filter((check) => check.phase === phase);
      const requiredPhaseChecks = phaseChecks.filter((check) => check.required);
      return [phase, {
        ok: requiredPhaseChecks.every((check) => check.ok),
        passed: phaseChecks.filter((check) => check.ok).length,
        total: phaseChecks.length,
        required: requiredPhaseChecks.length
      }];
    })
  );

  const ok = failed.length === 0;
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      phases: Object.keys(phaseSummary).length,
      checks: checks.length,
      required: requiredChecks.length,
      failed: failed.length,
      watch: watch.length
    },
    phaseSummary,
    checks,
    watch
  }, null, 2));
  if (!ok) process.exitCode = 1;
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message || String(error)
  }, null, 2));
  process.exit(1);
});
