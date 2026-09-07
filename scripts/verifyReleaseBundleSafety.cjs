const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  RELEASE_BUNDLE_POLICY_VERSION,
  findSensitiveReleaseEntries,
  isSensitiveReleaseEntry,
  normalizeReleaseEntry
} = require("./releaseBundlePolicy.cjs");
const {
  resolvePublicKeyPath,
  verifyManifestSignature
} = require("./releaseSigning.cjs");
const {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  MAX_ARTIFACT_BYTES,
  inspectHistoricalTrainingBuffer,
} = require("./historicalTrainingReleaseArtifact.cjs");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");

const latestBundlePath = () => {
  if (process.env.RELEASE_BUNDLE_PATH) return path.resolve(process.env.RELEASE_BUNDLE_PATH);
  if (!fs.existsSync(tmpDir)) return "";
  return fs.readdirSync(tmpDir)
    .filter((name) => /^football-release-.+\.tgz$/.test(name))
    .map((name) => {
      const filePath = path.join(tmpDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || "";
};

const bundlePath = latestBundlePath();
if (!bundlePath || !fs.existsSync(bundlePath)) {
  console.error(JSON.stringify({ ok: false, error: "release bundle not found", bundlePath: bundlePath || null }, null, 2));
  process.exit(1);
}

const list = spawnSync("tar", ["-tzf", bundlePath], {
  cwd: rootDir,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});
if (list.status !== 0) {
  console.error(JSON.stringify({
    ok: false,
    error: "release bundle contents could not be inspected",
    bundlePath,
    status: list.status,
    stderr: list.stderr
  }, null, 2));
  process.exit(list.status || 1);
}

const entries = list.stdout.split(/\r?\n/).filter(Boolean);
const runtimeMutableSourceEntries = [
  "public/data/gpt-predictions.json"
];
const modelEvaluationBundleEntry = "public/data/model-evaluation.json";
const expectedModelEvaluationVersion = "rolling-backtest-v19";
const expectedWalkForwardValidationVersion = "walk-forward-promotion-validation-v3";
const expectedWalkForwardProtocolVersion = "nested-expanding-window-candidate-selection-v2";
const prebuiltDistBundleEntry = ".release-prebuilt/dist-manifest.json";
const bundledRuntimeMutableEntries = entries
  .map(normalizeReleaseEntry)
  .filter((entry) => runtimeMutableSourceEntries.includes(entry));
const sensitiveEntries = findSensitiveReleaseEntries(entries);
const releaseActionEntries = entries
  .map(normalizeReleaseEntry)
  .filter((entry) => entry === ".release-actions" || entry.startsWith(".release-actions/"));
const manifestPath = `${bundlePath}.manifest.json`;
const signaturePath = `${bundlePath}.manifest.sig`;
const publicKeyPath = resolvePublicKeyPath();
let signatureVerification = null;
let signatureError = null;
try {
  signatureVerification = verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath });
} catch (error) {
  signatureError = error.message || String(error);
}
const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
const signedArtifactMatches = signatureVerification?.manifest?.sha256 === actualSha256
  && Number(signatureVerification?.manifest?.bytes) === fs.statSync(bundlePath).size;
const signedReleaseActions = signatureVerification?.manifest?.releaseActions;
const signedReleaseActionEntries = signatureVerification?.manifest?.releaseActionEntries;
const signedRuntimeMutableSourceEntries = signatureVerification?.manifest?.runtimeMutableSourceEntries;
const runtimeMutableMetadataMatches = Array.isArray(signedRuntimeMutableSourceEntries)
  && JSON.stringify(signedRuntimeMutableSourceEntries) === JSON.stringify(runtimeMutableSourceEntries);
const hasTlsAction = releaseActionEntries.length > 0;
const expectedReleaseActionEntries = hasTlsAction
  ? [".release-actions", ".release-actions/enable-ip-tls.json"]
  : [];
const releaseActionMetadataMatches = Array.isArray(signedReleaseActions)
  && Array.isArray(signedReleaseActionEntries)
  && JSON.stringify(signedReleaseActions) === JSON.stringify(hasTlsAction ? ["enable-ip-tls"] : [])
  && JSON.stringify(signedReleaseActionEntries) === JSON.stringify(expectedReleaseActionEntries)
  && releaseActionEntries.length === expectedReleaseActionEntries.length
  && expectedReleaseActionEntries.every((entry) => releaseActionEntries.includes(entry));
let releaseActionValid = !hasTlsAction;
let releaseActionError = null;
if (hasTlsAction && releaseActionMetadataMatches) {
  const extracted = spawnSync("tar", ["-xOf", bundlePath, ".release-actions/enable-ip-tls.json"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024
  });
  try {
    if (extracted.status !== 0) throw new Error(extracted.stderr || "action JSON could not be extracted");
    const action = JSON.parse(extracted.stdout);
    const allowedKeys = [
      "actionVersion", "action", "ipAddress", "acmeEmail", "agreeToSubscriberAgreement",
      "stagingPreflight", "site", "channel", "releaseSequence"
    ].sort();
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("action is not an object");
    if (JSON.stringify(Object.keys(action).sort()) !== JSON.stringify(allowedKeys)) throw new Error("action fields mismatch");
    if (action.actionVersion !== 1 || action.action !== "enable-ip-tls") throw new Error("action identity mismatch");
    if (action.ipAddress !== "134.175.132.183") throw new Error("action IP mismatch");
    if (action.agreeToSubscriberAgreement !== true || action.stagingPreflight !== true) {
      throw new Error("action consent or staging preflight is missing");
    }
    if (action.site !== signatureVerification.manifest.site
        || action.channel !== signatureVerification.manifest.channel
        || action.releaseSequence !== signatureVerification.manifest.releaseSequence) {
      throw new Error("action signed identity mismatch");
    }
    if (typeof action.acmeEmail !== "string" || action.acmeEmail.length > 254
        || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(action.acmeEmail)) {
      throw new Error("action email is invalid");
    }
    releaseActionValid = true;
  } catch (error) {
    releaseActionError = error.message || String(error);
  }
}
const expectedSensitiveEntries = [
  ".npmrc",
  "wrapped-release/.netrc",
  "wrapped-release/.pypirc",
  ".docker/config.json",
  "wrapped-release/home/app/.docker/config.json",
  "wrapped-release/deploy/light-server/env",
  "wrapped-release/.config/gcloud/application_default_credentials.json",
  "wrapped-release/.ssh",
  "wrapped-release/.aws/credentials"
];
const expectedSafeEntries = [
  "deploy/light-server/env.example",
  "wrapped-release/package.json",
  "src/config.json",
  "docs/npmrc-example.md"
];
const requiredReleaseEntries = [
  "server/recommendationProjectionParity.cjs",
  "scripts/verifyRecommendationProjectionParity.cjs",
  "server/currentPublicationSafety.cjs",
  "scripts/verifyCurrentPublicationSafety.cjs",
  "server/dataGenerationBundle.cjs",
  "server/dataGenerationStore.cjs",
  "server/openResearchGateway.cjs",
  "src/services/apiFootballRuntimePolicy.cjs",
  "src/services/collectorAttestation.cjs",
  "src/services/dualMarketDecisionBinding.cjs",
  "src/services/marketSourceProvenance.cjs",
  "src/services/webConsensusEvidence.cjs",
  "src/services/llmEvidenceBoundary.cjs",
  "src/services/liveRecommendationEligibility.cjs",
  "src/services/liveRecommendationEligibility.ts",
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
  "scripts/verifyWebConsensusEvidence.cjs",
  "scripts/verifyOpenResearchGateway.cjs",
  "scripts/verifyRagPredictionNeutrality.cjs",
  "scripts/verifyLlmEvidenceBoundary.cjs",
  "scripts/verifyLiveRecommendationLayer.cjs",
  "scripts/wikidataEntityCandidates.cjs",
  "scripts/verifyWikidataEntityCandidates.cjs",
  "scripts/entityMasterData.cjs",
  "scripts/reviewEntityCandidate.cjs",
  "scripts/verifyEntityMasterData.cjs",
  "scripts/commitCurrentDataGeneration.cjs",
  "scripts/runModelBacktest.cjs",
  "scripts/shadowCandidateRobustness.cjs",
  "scripts/candidateProspectiveTemperatureNeutralizationSuite.cjs",
  "scripts/candidateCommonCohortShadowG2.cjs",
  "scripts/candidateReleaseContinuity.cjs",
  "deploy/light-server/candidate-revision-transition.json",
  "scripts/runReleaseCandidateHeartbeatKeeper.cjs",
  "scripts/runReleaseSyncWriteBarrier.cjs",
  "scripts/verifyReleaseSyncWriteBarrier.cjs",
  "scripts/releasePrebuildPolicy.cjs",
  "scripts/releasePrebuiltDist.cjs",
  "scripts/verifyReleasePrebuiltDist.cjs",
  "scripts/sqliteReleaseSeal.cjs",
  "scripts/verifyCandidateProspectiveTemperatureNeutralizationSuite.cjs",
  "scripts/verifyCandidateCommonCohortShadowG2.cjs",
  "scripts/verifyCandidateReleaseContinuity.cjs",
  "scripts/verifyCandidateReleaseRevisionTransition.cjs",
  "scripts/verifyCandidateReadinessFullCoverage.cjs",
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
  "src/services/predictionPresentation.ts",
  "src/components/predictions/RecommendationEvidenceFacts.tsx",
  "src/styles/recommendation-evidence.css",
  "scripts/verifyRecommendationConfidencePayload.cjs",
  "scripts/verifyProbabilityDisplaySemantics.cjs",
  "scripts/verifyFrontendEvidenceSemantics.cjs",
  "scripts/verifyHhadCompanionShadowEvaluation.cjs",
  "scripts/hhadCompanionPublicContract.cjs",
  "scripts/compactPublicOddsHistory.cjs",
  // verifyDeploymentConfig executes this during guarded release preflight.
  "scripts/verifySportteryRelayFullRecovery.cjs",
  "deploy/light-server/football-release-recovery.cjs",
  "deploy/light-server/football-access-code-qa.cjs",
  "deploy/light-server/football-automation.sudoers",
  "scripts/verifyQaAccessOperator.cjs",
  "scripts/verifyReleaseTransactionSafety.cjs",
  "scripts/verifyFastResultProductionClone.cjs",
  "scripts/reconcileFastResultGeneration.cjs",
  "scripts/verifyFastResultGenerationReconciliation.cjs",
  "scripts/verifyReleaseVerifierContracts.cjs",
  "scripts/verifyPostgresSemanticReviewCleanup.cjs",
  "scripts/verifyReleaseRecovery.cjs",
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
  "scripts/validateTlsReleaseAction.cjs",
  "scripts/validateCertbotRenewalConfig.cjs",
  "public/data/model-evaluation.json",
  "dist/index.html",
  prebuiltDistBundleEntry,
  HISTORICAL_TRAINING_RELEASE_ENTRY,
];
const normalizedEntries = new Set(entries.map((entry) => entry.replace(/^\.\//, "")));
const missingReleaseEntries = requiredReleaseEntries.filter((entry) => !normalizedEntries.has(entry));
const extractedModelEvaluation = spawnSync("tar", ["-xOzf", bundlePath, `./${modelEvaluationBundleEntry}`], {
  cwd: rootDir,
  encoding: null,
  maxBuffer: 5 * 1024 * 1024
});
let bundledModelEvaluation = {
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
    bundledModelEvaluation = {
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
    bundledModelEvaluation.error = error.message || String(error);
  }
}
const signedModelEvaluation = signatureVerification?.manifest?.modelEvaluationArtifact || null;
const modelEvaluationMetadataMatches = bundledModelEvaluation.ok === true
  && signedModelEvaluation?.ok === true
  && signedModelEvaluation?.entry === bundledModelEvaluation.entry
  && signedModelEvaluation?.sha256 === bundledModelEvaluation.sha256
  && signedModelEvaluation?.version === bundledModelEvaluation.version
  && signedModelEvaluation?.generatedAt === bundledModelEvaluation.generatedAt
  && signedModelEvaluation?.walkForwardVersion === bundledModelEvaluation.walkForwardVersion
  && signedModelEvaluation?.walkForwardProtocolVersion === bundledModelEvaluation.walkForwardProtocolVersion;
const extractedHistoricalTraining = spawnSync(
  "tar",
  ["-xOzf", bundlePath, `./${HISTORICAL_TRAINING_RELEASE_ENTRY}`],
  {
    cwd: rootDir,
    encoding: null,
    maxBuffer: MAX_ARTIFACT_BYTES + 1024,
  }
);
const bundledHistoricalTraining = extractedHistoricalTraining.status === 0
  && Buffer.isBuffer(extractedHistoricalTraining.stdout)
  ? inspectHistoricalTrainingBuffer(extractedHistoricalTraining.stdout)
  : {
      ok: false,
      entry: HISTORICAL_TRAINING_RELEASE_ENTRY,
      blockers: ["bundle-artifact-extraction-failed"],
      error: extractedHistoricalTraining.error?.message
        || String(extractedHistoricalTraining.stderr || "").slice(-1000),
    };
const signedHistoricalTraining = signatureVerification?.manifest?.historicalTrainingArtifact || null;
const historicalTrainingMetadataMatches = bundledHistoricalTraining.ok === true
  && signedHistoricalTraining?.ok === true
  && signedHistoricalTraining?.sourceMatchesBundle === true
  && signedHistoricalTraining?.entry === bundledHistoricalTraining.entry
  && signedHistoricalTraining?.sha256 === bundledHistoricalTraining.sha256
  && signedHistoricalTraining?.bytes === bundledHistoricalTraining.bytes
  && signedHistoricalTraining?.version === bundledHistoricalTraining.version
  && signedHistoricalTraining?.source === bundledHistoricalTraining.source
  && signedHistoricalTraining?.rows === bundledHistoricalTraining.rows
  && signedHistoricalTraining?.teams === bundledHistoricalTraining.teams
  && signedHistoricalTraining?.finiteEloTeams === bundledHistoricalTraining.finiteEloTeams
  && signedHistoricalTraining?.minElo === bundledHistoricalTraining.minElo
  && signedHistoricalTraining?.maxElo === bundledHistoricalTraining.maxElo
  && signedHistoricalTraining?.lastMatchDate === bundledHistoricalTraining.lastMatchDate;
const prebuiltExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-dist-"));
let bundledPrebuiltDist = {
  ok: false,
  entry: prebuiltDistBundleEntry,
  version: null,
  treeHash: null,
  fileCount: null,
  totalBytes: null,
  error: null,
};
try {
  const extracted = spawnSync("tar", [
    "-xzf", bundlePath,
    "-C", prebuiltExtractDir,
    "./dist",
    `./${prebuiltDistBundleEntry}`,
  ], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr || "prebuilt dist could not be extracted");
  }
  const declared = JSON.parse(fs.readFileSync(path.join(prebuiltExtractDir, prebuiltDistBundleEntry), "utf8"));
  const actual = inspectPrebuiltDist(path.join(prebuiltExtractDir, "dist"));
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error("prebuilt dist manifest does not match bundled files");
  }
  bundledPrebuiltDist = {
    ok: true,
    entry: prebuiltDistBundleEntry,
    version: actual.version,
    treeHash: actual.treeHash,
    fileCount: actual.fileCount,
    totalBytes: actual.totalBytes,
    error: null,
  };
} catch (error) {
  bundledPrebuiltDist.error = error.message || String(error);
} finally {
  fs.rmSync(prebuiltExtractDir, { recursive: true, force: true });
}
const signedPrebuiltDist = signatureVerification?.manifest?.prebuiltDistArtifact || null;
const prebuiltDistMetadataMatches = bundledPrebuiltDist.ok === true
  && signedPrebuiltDist?.ok === true
  && signedPrebuiltDist?.entry === bundledPrebuiltDist.entry
  && signedPrebuiltDist?.version === bundledPrebuiltDist.version
  && signedPrebuiltDist?.treeHash === bundledPrebuiltDist.treeHash
  && Number(signedPrebuiltDist?.fileCount) === Number(bundledPrebuiltDist.fileCount)
  && Number(signedPrebuiltDist?.totalBytes) === Number(bundledPrebuiltDist.totalBytes);
const missedSensitivePolicyCases = expectedSensitiveEntries.filter((entry) => !isSensitiveReleaseEntry(entry));
const falsePositivePolicyCases = expectedSafeEntries.filter((entry) => isSensitiveReleaseEntry(entry));
const policySelfTestOk = missedSensitivePolicyCases.length === 0 && falsePositivePolicyCases.length === 0;
const payload = {
  ok: sensitiveEntries.length === 0
    && bundledRuntimeMutableEntries.length === 0
    && runtimeMutableMetadataMatches
    && policySelfTestOk
    && missingReleaseEntries.length === 0
    && modelEvaluationMetadataMatches
    && historicalTrainingMetadataMatches
    && prebuiltDistMetadataMatches
    && Boolean(signatureVerification)
    && signedArtifactMatches
    && releaseActionMetadataMatches
    && releaseActionValid,
  policyVersion: RELEASE_BUNDLE_POLICY_VERSION,
  bundlePath,
  entries: entries.length,
  missingReleaseEntries,
  modelEvaluationArtifact: {
    ...bundledModelEvaluation,
    manifestMatches: modelEvaluationMetadataMatches
  },
  historicalTrainingArtifact: {
    ...bundledHistoricalTraining,
    manifestMatches: historicalTrainingMetadataMatches,
  },
  prebuiltDistArtifact: {
    ...bundledPrebuiltDist,
    manifestMatches: prebuiltDistMetadataMatches,
  },
  sensitiveEntries: sensitiveEntries.slice(0, 20),
  runtimeMutableSource: {
    expectedExcluded: runtimeMutableSourceEntries,
    bundledEntries: bundledRuntimeMutableEntries,
    manifestMatches: runtimeMutableMetadataMatches
  },
  releaseAction: {
    present: hasTlsAction,
    entries: releaseActionEntries,
    metadataMatches: releaseActionMetadataMatches,
    valid: releaseActionValid,
    error: releaseActionError
  },
  signature: {
    ok: Boolean(signatureVerification),
    artifactMatches: signedArtifactMatches,
    keyId: signatureVerification?.keyId || null,
    error: signatureError
  },
  policySelfTest: {
    ok: policySelfTestOk,
    missedSensitivePolicyCases,
    falsePositivePolicyCases
  }
};

console.log(JSON.stringify(payload, null, 2));
if (!payload.ok) process.exit(1);
