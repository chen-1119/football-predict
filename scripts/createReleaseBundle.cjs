const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
process.umask(0o077);
const {
  RELEASE_BUNDLE_POLICY_VERSION,
  findSensitiveReleaseEntries,
  normalizeReleaseEntry,
  sensitiveTarExcludes
} = require("./releaseBundlePolicy.cjs");
const {
  RELEASE_MANIFEST_VERSION,
  RELEASE_SIGNATURE_ALGORITHM,
  ensureMatchingPublicKeyFile,
  loadReleasePrivateKey,
  reserveReleaseSequence,
  resolveReleaseManifestConfig,
  resolvePublicKeyPath,
  signManifestBytes
} = require("./releaseSigning.cjs");
const {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  MAX_ARTIFACT_BYTES,
  inspectHistoricalTrainingBuffer,
  inspectHistoricalTrainingFile,
} = require("./historicalTrainingReleaseArtifact.cjs");
const {
  inspectPrebuiltDist,
} = require("./releasePrebuiltDist.cjs");

const rootDir = path.resolve(__dirname, "..");
// Catch production-only verification dependencies and stale exact contracts
// locally, before reserving/signing a sequence or starting a remote transaction.
const verifierContracts = spawnSync(process.execPath, ["scripts/verifyReleaseVerifierContracts.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});
if (verifierContracts.status !== 0) {
  throw new Error(`Release verifier contract preflight failed: ${String(verifierContracts.error?.message || verifierContracts.stderr || verifierContracts.stdout).slice(-2000)}`);
}
const outDir = path.join(rootDir, ".codex-tmp");
const workspaceActionPath = path.join(rootDir, ".release-actions");
let workspaceActionPresent = false;
try {
  fs.lstatSync(workspaceActionPath);
  workspaceActionPresent = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (workspaceActionPresent) {
  throw new Error("workspace .release-actions is reserved; remove it before creating a signed release bundle");
}
const tlsActionEnvKeys = [
  "RELEASE_TLS_ACME_EMAIL",
  "RELEASE_TLS_AGREE_TOS",
  "RELEASE_TLS_IP_ADDRESS",
  "RELEASE_TLS_STAGING_PREFLIGHT"
];
const tlsActionRequested = tlsActionEnvKeys.some((key) => String(process.env[key] || "") !== "");
let tlsAction = null;
if (tlsActionRequested) {
  const acmeEmail = String(process.env.RELEASE_TLS_ACME_EMAIL || "");
  const ipAddress = String(process.env.RELEASE_TLS_IP_ADDRESS || "134.175.132.183");
  if (process.env.RELEASE_TLS_AGREE_TOS !== "1") {
    throw new Error("RELEASE_TLS_AGREE_TOS=1 is required for a signed TLS release action");
  }
  if (process.env.RELEASE_TLS_STAGING_PREFLIGHT !== "1") {
    throw new Error("RELEASE_TLS_STAGING_PREFLIGHT=1 is required for a signed TLS release action");
  }
  if (ipAddress !== "134.175.132.183") {
    throw new Error("RELEASE_TLS_IP_ADDRESS must be the fixed production IP 134.175.132.183");
  }
  if (acmeEmail.length > 254
      || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(acmeEmail)) {
    throw new Error("RELEASE_TLS_ACME_EMAIL must be a valid contact email");
  }
  tlsAction = {
    actionVersion: 1,
    action: "enable-ip-tls",
    ipAddress,
    acmeEmail,
    agreeToSubscriberAgreement: true,
    stagingPreflight: true
  };
}
const signingKey = loadReleasePrivateKey();
const trustedPublicKey = ensureMatchingPublicKeyFile(resolvePublicKeyPath(), signingKey.publicKeyPem);
const manifestConfig = resolveReleaseManifestConfig();
const sequenceReservation = reserveReleaseSequence({
  site: manifestConfig.site,
  channel: manifestConfig.channel
});
if (tlsAction) {
  tlsAction = {
    ...tlsAction,
    site: manifestConfig.site,
    channel: manifestConfig.channel,
    releaseSequence: sequenceReservation.releaseSequence
  };
}
const stamp = manifestConfig.createdAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const outputPath = path.resolve(process.env.RELEASE_BUNDLE_PATH || path.join(
  outDir,
  `football-release-${stamp}-r${sequenceReservation.releaseSequence}.tgz`
));
const sha256Path = `${outputPath}.sha256`;
const manifestPath = `${outputPath}.manifest.json`;
const signaturePath = `${outputPath}.manifest.sig`;
let actionStageDir = "";
const historicalTrainingSourcePath = path.join(
  rootDir,
  "server-data",
  "training",
  "historical-training-index.json"
);
const historicalTrainingSourceArtifact = inspectHistoricalTrainingFile(historicalTrainingSourcePath);
if (!historicalTrainingSourceArtifact.ok) {
  throw new Error(
    `historical training release input is invalid: ${(historicalTrainingSourceArtifact.blockers || []).join(",")}`
  );
}
const frontendBuildCommand = process.platform === "win32"
  ? (process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe")
  : "npm";
const frontendBuildArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm.cmd run build"]
  : ["run", "build"];
const frontendBuild = spawnSync(frontendBuildCommand, frontendBuildArgs, {
  cwd: rootDir,
  encoding: "utf8",
  env: { ...process.env, NODE_ENV: "production" },
  maxBuffer: 20 * 1024 * 1024,
});
if (frontendBuild.status !== 0) {
  throw new Error(`release frontend build failed: ${String(
    frontendBuild.error?.message || frontendBuild.stderr || frontendBuild.stdout || "unknown build failure"
  ).slice(-4000)}`);
}
const prebuiltDistManifest = inspectPrebuiltDist(path.join(rootDir, "dist"));
const prebuiltDistBundleEntry = ".release-prebuilt/dist-manifest.json";
const prebuiltDistArtifact = Object.freeze({
  ok: true,
  entry: prebuiltDistBundleEntry,
  version: prebuiltDistManifest.version,
  treeHash: prebuiltDistManifest.treeHash,
  fileCount: prebuiltDistManifest.fileCount,
  totalBytes: prebuiltDistManifest.totalBytes,
});
const runtimeMutableSourceEntries = [
  "public/data/gpt-predictions.json"
];
const modelEvaluationBundleEntry = "public/data/model-evaluation.json";
const expectedModelEvaluationVersion = "rolling-backtest-v19";
const expectedWalkForwardValidationVersion = "walk-forward-promotion-validation-v3";
const expectedWalkForwardProtocolVersion = "nested-expanding-window-candidate-selection-v2";

const cleanupActionStage = () => {
  if (actionStageDir) fs.rmSync(actionStageDir, { recursive: true, force: true });
};
process.once("exit", cleanupActionStage);

const excludes = [
  ".git",
  ".codex",
  ".agents",
  ".codex-tmp",
  "node_modules",
  "server-data",
  "artifacts",
  "outputs",
  "logs",
  "coverage",
  ".vite",
  "*.log",
  ...runtimeMutableSourceEntries,
  ...sensitiveTarExcludes
];

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
for (const artifactPath of [outputPath, sha256Path, manifestPath, signaturePath]) {
  fs.rmSync(artifactPath, { force: true });
}

const tarArgs = [
  "-czf",
  outputPath,
  ...excludes.map((entry) => `--exclude=${entry}`),
  "-C",
  rootDir,
  "."
];

if (tlsAction || historicalTrainingSourceArtifact.ok) {
  actionStageDir = fs.mkdtempSync(path.join(outDir, "release-action-"));
}
if (historicalTrainingSourceArtifact.ok) {
  const modelAssetPath = path.join(actionStageDir, HISTORICAL_TRAINING_RELEASE_ENTRY);
  fs.mkdirSync(path.dirname(modelAssetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(historicalTrainingSourcePath, modelAssetPath);
  fs.chmodSync(modelAssetPath, 0o600);
  tarArgs.push("-C", actionStageDir, HISTORICAL_TRAINING_RELEASE_ENTRY.split("/")[0]);
}
const prebuiltDistManifestPath = path.join(actionStageDir, prebuiltDistBundleEntry);
fs.mkdirSync(path.dirname(prebuiltDistManifestPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(prebuiltDistManifestPath, `${JSON.stringify(prebuiltDistManifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx"
});
tarArgs.push("-C", actionStageDir, prebuiltDistBundleEntry.split("/")[0]);
if (tlsAction) {
  const actionDir = path.join(actionStageDir, ".release-actions");
  const actionPath = path.join(actionDir, "enable-ip-tls.json");
  fs.mkdirSync(actionDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(actionPath, `${JSON.stringify(tlsAction, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  tarArgs.push("-C", actionStageDir, ".release-actions");
}

const tar = spawnSync("tar", tarArgs, {
  cwd: rootDir,
  encoding: "utf8"
});

if (tar.status !== 0) {
  for (const artifactPath of [outputPath, sha256Path, manifestPath, signaturePath]) {
    fs.rmSync(artifactPath, { force: true });
  }
  console.error(JSON.stringify({
    ok: false,
    command: "tar",
    status: tar.status,
    stdout: tar.stdout,
    stderr: tar.stderr
  }, null, 2));
  process.exit(tar.status || 1);
}

const stat = fs.statSync(outputPath);
fs.chmodSync(outputPath, 0o600);
const hash = crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");

const list = spawnSync("tar", ["-tzf", outputPath], {
  cwd: rootDir,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});
const entries = list.status === 0 ? list.stdout.split(/\r?\n/).filter(Boolean) : [];
const extractedModelEvaluation = spawnSync("tar", ["-xOzf", outputPath, `./${modelEvaluationBundleEntry}`], {
  cwd: rootDir,
  encoding: null,
  maxBuffer: 5 * 1024 * 1024
});
let modelEvaluationArtifact = {
  ok: false,
  entry: modelEvaluationBundleEntry,
  sha256: null,
  version: null,
  generatedAt: null,
  walkForwardVersion: null,
  walkForwardProtocolVersion: null,
  error: extractedModelEvaluation.error?.message
    || (extractedModelEvaluation.status === 0 ? null : String(extractedModelEvaluation.stderr || "").slice(-1000))
};
if (extractedModelEvaluation.status === 0
    && Buffer.isBuffer(extractedModelEvaluation.stdout)
    && extractedModelEvaluation.stdout.length > 0) {
  try {
    const parsed = JSON.parse(extractedModelEvaluation.stdout.toString("utf8"));
    modelEvaluationArtifact = {
      ok: parsed?.ok === true
        && parsed?.version === expectedModelEvaluationVersion
        && parsed?.walkForwardValidation?.version === expectedWalkForwardValidationVersion
        && parsed?.walkForwardValidation?.protocolVersion === expectedWalkForwardProtocolVersion,
      entry: modelEvaluationBundleEntry,
      sha256: crypto.createHash("sha256").update(extractedModelEvaluation.stdout).digest("hex"),
      version: parsed?.version || null,
      generatedAt: parsed?.generatedAt || null,
      walkForwardVersion: parsed?.walkForwardValidation?.version || null,
      walkForwardProtocolVersion: parsed?.walkForwardValidation?.protocolVersion || null,
      error: null
    };
  } catch (error) {
    modelEvaluationArtifact.error = error.message || String(error);
  }
}
const extractedHistoricalTraining = spawnSync(
  "tar",
  ["-xOzf", outputPath, `./${HISTORICAL_TRAINING_RELEASE_ENTRY}`],
  {
    cwd: rootDir,
    encoding: null,
    maxBuffer: MAX_ARTIFACT_BYTES + 1024,
  }
);
const bundledHistoricalTrainingArtifact = extractedHistoricalTraining.status === 0
  && Buffer.isBuffer(extractedHistoricalTraining.stdout)
  ? inspectHistoricalTrainingBuffer(extractedHistoricalTraining.stdout)
  : {
      ok: false,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      blockers: ["bundle-artifact-extraction-failed"],
      error: extractedHistoricalTraining.error?.message
        || String(extractedHistoricalTraining.stderr || "").slice(-1000),
    };
const historicalTrainingArtifact = {
  ...bundledHistoricalTrainingArtifact,
  sourceMatchesBundle: bundledHistoricalTrainingArtifact.sha256 === historicalTrainingSourceArtifact.sha256
    && bundledHistoricalTrainingArtifact.bytes === historicalTrainingSourceArtifact.bytes,
};
const releaseActionEntries = entries
  .map(normalizeReleaseEntry)
  .filter((entry) => entry === ".release-actions" || entry.startsWith(".release-actions/"));
const expectedReleaseActionEntries = tlsAction
  ? [".release-actions", ".release-actions/enable-ip-tls.json"]
  : [];
const releaseActionEntriesOk = releaseActionEntries.length === expectedReleaseActionEntries.length
  && expectedReleaseActionEntries.every((entry) => releaseActionEntries.includes(entry));
const sensitiveEntries = findSensitiveReleaseEntries(entries);
const blockedEntries = entries.filter((entry) => {
  const normalized = normalizeReleaseEntry(entry);
  return normalized.startsWith(".git/")
    || normalized.startsWith(".codex-tmp/")
    || normalized.startsWith("node_modules/")
    || normalized.startsWith("artifacts/")
    || normalized.startsWith("outputs/")
    || normalized.startsWith("server-data/")
    || runtimeMutableSourceEntries.includes(normalized);
});
const requiredEntries = [
  "package.json",
  "scripts/data/football-data-discipline.json",
  "scripts/footballDataDiscipline.cjs",
  "scripts/verifyFootballDataDiscipline.cjs",
  "server/index.cjs",
  "server/candidateProspectiveTemporalAudit.cjs",
  "scripts/verifyCandidateProspectiveTemporalAudit.cjs",
  "server/recommendationProjectionParity.cjs",
  "scripts/verifyRecommendationProjectionParity.cjs",
  "server/currentPublicationSafety.cjs",
  "scripts/verifyCurrentPublicationSafety.cjs",
  "server/candidateProspectiveAdmission.cjs",
  "server/openResearchGateway.cjs",
  "server/publicSyncMeta.cjs",
  "scripts/verifyApiContracts.cjs",
  "scripts/verifyCandidateProspectiveAdmission.cjs",
  "server/dataGenerationBundle.cjs",
  "server/dataGenerationStore.cjs",
  "src/services/apiFootballRuntimePolicy.cjs",
  "src/services/collectorAttestation.cjs",
  "src/services/dualMarketDecisionBinding.cjs",
  "src/services/marketSourceProvenance.cjs",
  "src/services/oddsObservationTrail.cjs",
  "src/services/webConsensusEvidence.cjs",
  "src/services/llmEvidenceBoundary.cjs",
  "src/services/liveRecommendationEligibility.cjs",
  "src/services/liveRecommendationEligibility.ts",
  "src/services/analysisReferenceEligibility.cjs",
  "src/services/analysisReferenceEligibility.d.cts",
  "src/services/analysisReferenceEligibility.ts",
  "scripts/verifyAnalysisReferenceEligibility.cjs",
  "src/services/externalOddsAnalysisReference.cjs",
  "src/services/externalOddsAnalysisReference.d.cts",
  "src/services/externalOddsAnalysisReference.ts",
  "src/services/externalOddsReferencePresentation.ts",
  "scripts/verifyExternalOddsAnalysisReference.cjs",
  "src/services/immutableAnalysisReferenceDecision.cjs",
  "src/services/publicReferenceDecision.cjs",
  "src/services/publicReferenceEvidence.cjs",
  "scripts/verifyPublicReferenceEvidence.cjs",
  "scripts/verifyDataAdoption.cjs",
  "src/services/apiFootballDiagnostics.cjs",
  "src/services/apiFootballDiagnostics.d.cts",
  "scripts/apiFootballClockEvidence.cjs",
  "scripts/verifyApiFootballClockEvidence.cjs",
  "scripts/verifyApiFootballDiagnostics.cjs",
  "scripts/verifyCandidateArtifactSeed.cjs",
  "scripts/verifyCandidateRevisionLineage.cjs",
  "scripts/verifyLegacyReferenceConflict.cjs",
  "scripts/verifyFrozenArchiveAuthority.cjs",
  "scripts/verifyOfficialClubResults.cjs",
  "scripts/verifyOfficialClubReceiptClocks.cjs",
  "scripts/competitionModelContext.cjs",
  "scripts/verifyCompetitionModelContext.cjs",
  "scripts/predictionExecutionCapture.cjs",
  "scripts/verifyPredictionExecutionCapture.cjs",
  "scripts/verifyDataGenerationPointerLockRace.cjs",
  "scripts/verifyDataGenerationEndToEnd.cjs",
  "scripts/openFootballObservationStore.cjs",
  "scripts/openFootballObservationSchedule.cjs",
  "scripts/runOpenFootballObservationSync.cjs",
  "scripts/verifyOpenFootballObservationSchedule.cjs",
  "scripts/footballDataFixtureRetry.cjs",
  "scripts/auditOpenFootballCurrentSeason.cjs",
  "scripts/verifyOpenFootballObservations.cjs",
  "src/services/predictionExecutionClock.cjs",
  "scripts/verifyPredictionExecutionClock.cjs",
  "src/services/predictionRuntimeIdentity.cjs",
  "scripts/replayPredictionCapture.cjs",
  "scripts/verifyPredictionReplay.cjs",
  "scripts/syncOfficialClubResults.cjs",
  "src/services/legacyReferenceConflict.ts",
  "scripts/verifyModelInputUsage.cjs",
  "src/services/modelInputUsage.cjs",
  "scripts/teamCategoryIdentity.cjs",
  "scripts/recentFormEvidence.cjs",
  "scripts/apiFootballScopedAliases.cjs",
  "src/services/strictInstant.cjs",
  "scripts/verifyRecentFormEvidence.cjs",
  "scripts/verifyFootballDataResultsSync.cjs",
  "scripts/verifyTeamCategoryIdentity.cjs",
  "src/services/decisionEventIdentity.cjs",
  "server/publicReferenceArchive.cjs",
  "scripts/predictionEvidenceAudit.cjs",
  "scripts/verifyPredictionEvidenceAudit.cjs",
  "scripts/verifyPredictionEvidenceRoundtrip.cjs",
  "src/services/freshnessAwareShadow.cjs",
  "scripts/auditFreshnessAwareShadow.cjs",
  "scripts/providerFailure.cjs",
  "scripts/verifyPublicReferenceIntegrity.cjs",
  "scripts/verifyImmutableAnalysisReferenceDecision.cjs",
  "server/relayFastResultWatcher.cjs",
  "server/sourceRedundancy.cjs",
  "scripts/sync500Data.cjs",
  "scripts/syncData.cjs",
  "scripts/historicalTrainingReleaseArtifact.cjs",
  "scripts/verifyHistoricalTrainingReleaseInput.cjs",
  "scripts/syncPreMatchSignals.cjs",
  "scripts/syncOpenResearchSignals.cjs",
  "scripts/syncWebConsensusSignals.cjs",
  "scripts/optimizePredictionStrategy.cjs",
  "scripts/collectSportterySnapshot.cjs",
  "scripts/generateCollectorAttestationKey.cjs",
  "scripts/verifyCollectorAttestation.cjs",
  "scripts/verifyMarketSourceProvenance.cjs",
  "scripts/verifyOddsObservationTrail.cjs",
  "scripts/verifyWebConsensusEvidence.cjs",
  "scripts/verifyOpenResearchGateway.cjs",
  "scripts/verifyRagPredictionNeutrality.cjs",
  "scripts/verifyLlmEvidenceBoundary.cjs",
  "scripts/verifyLiveRecommendationLayer.cjs",
  "scripts/verify500DataParser.cjs",
  "scripts/wikidataEntityCandidates.cjs",
  "scripts/verifyWikidataEntityCandidates.cjs",
  "scripts/entityMasterData.cjs",
  "scripts/reviewEntityCandidate.cjs",
  "scripts/verifyEntityMasterData.cjs",
  "scripts/currentMatchRetention.cjs",
  "scripts/privateModelArtifactStore.cjs",
  "scripts/runModelBacktest.cjs",
  "scripts/verifyOddsHistoryIntegrity.cjs",
  "scripts/shadowCandidateRobustness.cjs",
  "scripts/candidateProspectiveLedger.cjs",
  "scripts/candidateProspectiveChallengerSuite.cjs",
  "scripts/candidateProspectiveTemperatureNeutralizationSuite.cjs",
  "scripts/candidateCommonCohortShadowG2.cjs",
  "scripts/candidateReleaseContinuity.cjs",
  "deploy/light-server/candidate-revision-transition.json",
  "scripts/captureCandidateProspectiveDeadline.cjs",
  "scripts/runReleaseCandidateHeartbeatKeeper.cjs",
  "scripts/runReleaseSyncWriteBarrier.cjs",
  "scripts/verifyReleaseSyncWriteBarrier.cjs",
  "scripts/releasePrebuildPolicy.cjs",
  "scripts/releasePrebuiltDist.cjs",
  "scripts/verifyReleasePrebuiltDist.cjs",
  "scripts/sqliteReleaseSeal.cjs",
  "scripts/verifyCandidateProspectiveLedger.cjs",
  "scripts/verifyCandidateProspectiveChallengerSuite.cjs",
  "scripts/verifyCandidateProspectiveTemperatureNeutralizationSuite.cjs",
  "scripts/verifyCandidateCommonCohortShadowG2.cjs",
  "scripts/verifyCandidateReleaseContinuity.cjs",
  "scripts/verifyCandidateReleaseRevisionTransition.cjs",
  "scripts/verifyCandidateReadinessFullCoverage.cjs",
  "scripts/verifyCandidateDeadlineCapture.cjs",
  "scripts/verifyShadowCandidateRobustness.cjs",
  "scripts/auditWorldCupHitRate.cjs",
  "scripts/worldCupResearchSnapshot.cjs",
  "scripts/verifyWorldCupResearchSnapshot.cjs",
  "scripts/benchmarkProspectiveLedger.cjs",
  "scripts/verifyBenchmarkProspectiveLedger.cjs",
  "model-research/world-cup-research-benchmark.json",
  "scripts/asOfResultTimeline.cjs",
  "scripts/verifyAsOfResultTimeline.cjs",
  "scripts/walkForwardValidation.cjs",
  "scripts/verifyWalkForwardValidation.cjs",
  "scripts/releaseEnrichmentReuse.cjs",
  "scripts/verifyReleaseEnrichmentReuse.cjs",
  "scripts/runSyncWorker.cjs",
  "scripts/commitCurrentDataGeneration.cjs",
  "scripts/migrateArchivedPreMatchReferences.cjs",
  "scripts/verifyArchivedPreMatchMigration.cjs",
  "scripts/compactPublicOddsHistory.cjs",
  "scripts/exportDataStoreSqlite.cjs",
  "scripts/publishOfficialResultsFast.cjs",
  "scripts/fastResultPublisherProtocol.cjs",
  "scripts/fastResultObservations.cjs",
  "scripts/reconcileFastResultGeneration.cjs",
  "scripts/verifyFastResultGenerationReconciliation.cjs",
  "scripts/verifyReleaseVerifierContracts.cjs",
  "scripts/verifyPostgresSemanticReviewCleanup.cjs",
  "scripts/verifyFastResultPublication.cjs",
  "scripts/verifyFastResultProductionClone.cjs",
  "scripts/verifyRelayFastResultWatcher.cjs",
  "scripts/verifySportteryRelayDualFile.cjs",
  "scripts/verifySportteryRelayDualLaneServer.cjs",
  // verifyDeploymentConfig executes this verifier as a release gate; omitting
  // it makes the signed candidate fail only after upload on the production host.
  "scripts/verifySportteryRelayFullRecovery.cjs",
  "scripts/verifySqliteIncrementalExport.cjs",
  "scripts/verifyAtomicRefreshBridge.cjs",
  "scripts/verifySyncWorkerEventBridge.cjs",
  "src/services/hhadCompanionShadow.cjs",
  "src/services/hhadCompanionShadowEvaluation.cjs",
  "src/services/benchmarkSelectionPolicy.cjs",
  "src/services/benchmarkSelectionPolicy.d.cts",
  "scripts/verifyBenchmarkSelectionPolicy.cjs",
  "src/services/marketMovement.cjs",
  "scripts/verifyMarketMovement.cjs",
  "src/services/recommendationConfidence.cjs",
  "src/services/recommendationConfidence.d.cts",
  "src/services/recommendationConfidence.ts",
  "src/services/multiFactorRecommendation.cjs",
  "src/services/predictionPresentation.ts",
  "src/components/predictions/RecommendationEvidenceFacts.tsx",
  "src/styles/recommendation-evidence.css",
  "scripts/verifyRecommendationConfidencePayload.cjs",
  "scripts/verifyProbabilityDisplaySemantics.cjs",
  "scripts/verifyFrontendEvidenceSemantics.cjs",
  "src/services/atomicMatchRefresh.ts",
  "src/services/recommendationPublicationLedger.cjs",
  "server/hitRateAudit.cjs",
  "scripts/verifyHhadCompanionShadowEvaluation.cjs",
  "scripts/hhadCompanionPublicContract.cjs",
  "deploy/light-server/football-release-recovery.cjs",
  "deploy/light-server/football-access-code-qa.cjs",
  "deploy/light-server/football-automation.sudoers",
  "scripts/verifyQaAccessOperator.cjs",
  "scripts/verifyReleaseTransactionSafety.cjs",
  "scripts/verifyReleaseRecovery.cjs",
  "scripts/verifyProductionReadiness.cjs",
  "scripts/verifyRemotePublicReadiness.cjs",
  "scripts/fallbackReadiness.cjs",
  "scripts/verifyFallbackReadiness.cjs",
  "scripts/verifyRemoteRefreshPipeline.cjs",
  "scripts/verifyRemoteRefreshPipelineContract.cjs",
  "scripts/verifyDeploymentConfig.cjs",
  "scripts/deployReleaseBundle.cjs",
  "scripts/releaseRecoveryHelperRotation.cjs",
  "scripts/verifyRecoveryHelperRotation.cjs",
  "scripts/checkReleaseStatus.cjs",
  "scripts/releaseSshHostKeyPin.cjs",
  "scripts/verifyReleaseSshHostKeyPin.cjs",
  "scripts/verifySshOperatorKeyRecovery.cjs",
  "scripts/watchReleaseWindow.cjs",
  "scripts/verifyReleaseWatchPolicy.cjs",
  "scripts/verifyTlsReadiness.cjs",
  "deploy/light-server/release-from-bundle.sh",
  "deploy/light-server/restore-ubuntu-operator-key.sh",
  "deploy/light-server/nginx.conf",
  "deploy/light-server/nginx-http-common.conf",
  "deploy/light-server/nginx-server-common.conf",
  "deploy/light-server/nginx-security-headers.conf",
  "deploy/light-server/nginx-tls-site.conf.template",
  "deploy/light-server/nginx-tls-provisional-site.conf.template",
  "deploy/light-server/nginx-tls-transition-fallback.conf",
  "deploy/light-server/enable-nginx-tls.sh",
  "deploy/light-server/activate-signed-ip-tls.sh",
  "scripts/validateTlsReleaseAction.cjs",
  "scripts/validateCertbotRenewalConfig.cjs",
  "public/data/matches-current.json",
  "public/data/model-evaluation.json",
  "public/data/sync-meta.json",
  "dist/index.html",
  prebuiltDistBundleEntry,
  HISTORICAL_TRAINING_RELEASE_ENTRY,
];
const missingEntries = requiredEntries.filter((entry) => !entries.some((candidate) => candidate.replace(/^\.\//, "") === entry));

const payload = {
  ok: list.status === 0
    && blockedEntries.length === 0
    && sensitiveEntries.length === 0
    && missingEntries.length === 0
    && modelEvaluationArtifact.ok
    && prebuiltDistArtifact.ok
    && historicalTrainingArtifact.ok
    && historicalTrainingArtifact.sourceMatchesBundle
    && releaseActionEntriesOk,
  manifestVersion: RELEASE_MANIFEST_VERSION,
  site: manifestConfig.site,
  channel: manifestConfig.channel,
  releaseSequence: sequenceReservation.releaseSequence,
  createdAt: manifestConfig.createdAt,
  expiresAt: manifestConfig.expiresAt,
  policyVersion: RELEASE_BUNDLE_POLICY_VERSION,
  path: outputPath,
  sha256Path,
  manifestPath,
  signaturePath,
  bytes: stat.size,
  sha256: hash,
  entries: entries.length,
  excludes,
  runtimeMutableSourceEntries,
  blockedEntries: blockedEntries.slice(0, 20),
  sensitiveEntries: sensitiveEntries.slice(0, 20),
  missingEntries,
  modelEvaluationArtifact,
  prebuiltDistArtifact,
  historicalTrainingArtifact,
  releaseActions: tlsAction ? ["enable-ip-tls"] : [],
  releaseActionEntries,
  signature: {
    algorithm: RELEASE_SIGNATURE_ALGORITHM,
    keyId: trustedPublicKey.keyId,
    format: "detached-binary"
  }
};

fs.writeFileSync(sha256Path, `${hash}  ${path.basename(outputPath)}\n`, { mode: 0o600 });
const manifestBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });

if (!payload.ok) {
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(sha256Path, { force: true });
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(signaturePath, { force: true });
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

try {
  const signature = signManifestBytes(manifestBytes, signingKey.key);
  fs.writeFileSync(signaturePath, signature, { mode: 0o600 });
} catch (error) {
  for (const artifactPath of [outputPath, sha256Path, manifestPath, signaturePath]) {
    fs.rmSync(artifactPath, { force: true });
  }
  console.error(JSON.stringify({
    ok: false,
    error: "release manifest signing failed",
    reason: error.message || String(error)
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ...payload,
  signingPublicKeyPath: trustedPublicKey.path
}, null, 2));
