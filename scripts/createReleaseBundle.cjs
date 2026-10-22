// Dispatch before full-release preflight, verifier chains, sequence reservation
// or local build. A UI package authorizes source for one later isolated build.
const requestedReleaseKind = process.env.RELEASE_KIND;
if (requestedReleaseKind !== undefined && requestedReleaseKind !== "full" && requestedReleaseKind !== "frontend-only") {
  throw new Error("RELEASE_KIND must be full or frontend-only");
}
if (requestedReleaseKind === "frontend-only") {
  const entryPath = require("node:path").join(__dirname, "createFrontendReleaseBundle.cjs");
  const child = require("node:child_process").spawnSync(process.execPath, [entryPath], {
    cwd: require("node:path").resolve(__dirname, ".."), env: process.env,
    stdio: "inherit", windowsHide: true, timeout: 180000,
  });
  if (child.error) process.stderr.write("frontend source bundle child failed: " + child.error.code + "\n");
  process.exit(Number.isInteger(child.status) && child.status >= 0 ? child.status : 1);
}

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
require("./releaseSequencePreflight.cjs").validateSequenceBranches(
  fs.readFileSync(path.join(__dirname, "../deploy/light-server/football-release"), "utf8")
);
const { listReleaseRootEntries } = require("./releaseWorkspaceFreshness.cjs");
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
const { validateSignedArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");

const rootDir = path.resolve(__dirname, "..");
const { MODEL_EVALUATION_ENTRY, EXPECTED_MODEL_EVALUATION_VERSION, EXPECTED_WALK_FORWARD_VERSION,
  EXPECTED_WALK_FORWARD_PROTOCOL, inspectModelEvaluationFile } = require("./releaseModelEvaluationInput.cjs");
const nativePolicyPath = path.join(rootDir, "deploy/light-server/native-release-policy.json");
const nativePreparation = fs.existsSync(nativePolicyPath);
if (nativePreparation) require("./validateNativeReleasePolicy.cjs").readPolicy(nativePolicyPath);
// Online release callers already supply the pinned deployment key. Reject
// unrestorable originals before any sequence reservation or frontend build.
// Offline bundle creation does not claim live readiness; deployment rechecks.
if (process.env.RELEASE_DEPLOY_KEY) {
  const workerPreflight = require("./runReleaseWorkerPreflight.cjs").runLiveWorkerPreflight();
  console.error(JSON.stringify({ phase: "worker-preflight-before-build", ...workerPreflight }));
  if (!workerPreflight.ok && workerPreflight.preparationAllowed !== true) throw new Error(`release foundation unavailable before sequence reservation and build: ${workerPreflight.blockers.join(",")}`);
  const capacityPreflight = require("./runReleaseCapacityPreflight.cjs").runLiveCapacityPreflight();
  console.error(JSON.stringify({ phase: "capacity-preflight-before-build", ...capacityPreflight }));
  if (!capacityPreflight.ok) throw new Error("release capacity unavailable before sequence reservation and build");
  // A signed native package is preparation, not a cutover lease. The root
  // executor reclassifies the actual installed schema immediately before use.
  // Database changes retain the complete server-side migration window.
  const windowPreflight = nativePreparation
    ? { ok: true, windowChecked: false, reason: "native-prepare-only", readyToCutover: false, windowPreauthorized: false }
    : require("./runReleaseWindowPreflight.cjs").runLiveReleaseWindowPreflight({ stage: "before-build" });
  console.error(JSON.stringify({ phase: "window-preflight-before-build", ...windowPreflight }));
  if (!windowPreflight.ok) throw new Error("release window unavailable before archive preflight, sequence reservation and build");
  const { report } = require("./runReleaseArchivePreflight.cjs").runLiveArchivePreflight();
  if (!report.ok) throw new Error(`release archive preflight rejected: ${JSON.stringify(report.blockers)}`);
  console.error(JSON.stringify({ phase: "archive-preflight-before-build", ...report }));
} else {
  console.error(JSON.stringify({ phase: "window-preflight-before-build", windowChecked: false,
    reason: "offline-bundle-creation", readyToCutover: false }));
}
// Existing live worker/window/archive refusals retain their original priority.
// This local input gate still precedes verifier children, signing and sequence.
const admittedModelEvaluation = inspectModelEvaluationFile(path.join(rootDir, MODEL_EVALUATION_ENTRY));
if (!admittedModelEvaluation.ok) throw new Error(`required model evaluation input rejected before sequence reservation: ${admittedModelEvaluation.error}`);
// This source-level production gate also runs on the server. Catch a failing
// frontend evidence contract before reserving a sequence or uploading a bundle.
const frontendEvidenceSemantics = spawnSync(process.execPath, ["scripts/verifyFrontendEvidenceSemantics.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});
if (frontendEvidenceSemantics.status !== 0) {
  let failedChecks = [];
  try {
    failedChecks = JSON.parse(frontendEvidenceSemantics.stdout).checks
      .filter((item) => item.ok !== true).map((item) => item.name);
  } catch { /* Retain the child error and output when it did not return JSON. */ }
  throw new Error(`Frontend evidence semantics preflight failed: ${JSON.stringify({
    status: frontendEvidenceSemantics.status,
    failedChecks,
    error: frontendEvidenceSemantics.error?.message || null,
    output: String(frontendEvidenceSemantics.stderr || frontendEvidenceSemantics.stdout || "").slice(-2000),
  })}`);
}
// Reject a byte-reader regression before reserving a release sequence. This
// verifier uses only synthetic streams and loopback HTTP, never provider data.
const requestJsonUtf8 = spawnSync(process.execPath, ["scripts/verifyRequestJsonUtf8.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});
if (requestJsonUtf8.status !== 0) {
  throw new Error(`Request JSON UTF-8 preflight failed: ${String(
    requestJsonUtf8.error?.message || requestJsonUtf8.stderr || requestJsonUtf8.stdout
  ).slice(-2000)}`);
}
// A fresh signed quote may only refresh an exact-event ephemeral input. Run
// signature/sales/deadline/model/frozen replay contracts before reserving a
// sequence, signing a bundle or starting a remote transaction.
const signedHadPublication = spawnSync(process.execPath, ["scripts/verifySignedLiveHadPublication.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
});
if (signedHadPublication.status !== 0) {
  throw new Error(`Signed HAD publication preflight failed: ${String(
    signedHadPublication.error?.message || signedHadPublication.stderr || signedHadPublication.stdout
  ).slice(-4000)}`);
}
// Catch production-only verification dependencies and stale exact contracts
// locally, before reserving/signing a sequence or starting a remote transaction.
// The bounded source-boundary fixture owns a 300-second budget. Its outer
// controller must not kill a valid child at the former 30-second total limit.
const VERIFIER_CONTRACT_PREFLIGHT_TIMEOUT_MS = 660_000;
const verifierContracts = spawnSync(process.execPath, ["scripts/verifyReleaseVerifierContracts.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: VERIFIER_CONTRACT_PREFLIGHT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
});
if (verifierContracts.status !== 0) {
  throw new Error(`Release verifier contract preflight failed: ${String(verifierContracts.error?.message || verifierContracts.stderr || verifierContracts.stdout).slice(-2000)}`);
}
const sportteryOpening = spawnSync(process.execPath, ["scripts/verifySportteryOpeningPolicy.cjs"], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
});
if (sportteryOpening.status !== 0) {
  throw new Error(`Sporttery opening preflight failed: ${String(sportteryOpening.error?.message || sportteryOpening.stderr || sportteryOpening.stdout).slice(-4000)}`);
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
const modelEvaluationBundleEntry = MODEL_EVALUATION_ENTRY;
const expectedModelEvaluationVersion = EXPECTED_MODEL_EVALUATION_VERSION;
const expectedWalkForwardValidationVersion = EXPECTED_WALK_FORWARD_VERSION;
const expectedWalkForwardProtocolVersion = EXPECTED_WALK_FORWARD_PROTOCOL;

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
  "logs",
  "coverage",
  ".vite",
  ".next",
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
  ...listReleaseRootEntries(rootDir)
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
// Inventory the actual archive bytes, not a pre-exclusion workspace or a file
// count. The helper streams gzip/tar, rejects duplicate/link/unsafe members and
// returns every directory/file commitment. No build-success flag is accepted.
const sourceInventoryCapture = spawnSync(process.execPath, ["scripts/releaseArchiveSourceInventory.cjs", "capture", outputPath], {
  cwd: rootDir, encoding: "utf8", windowsHide: true, timeout: 35_000, maxBuffer: 4 * 1024 * 1024,
});
if (sourceInventoryCapture.status !== 0) {
  throw new Error(`release archive source inventory failed: ${String(
    sourceInventoryCapture.error?.message || sourceInventoryCapture.stderr || "capture failed"
  ).slice(-2000)}`);
}
const archiveSourceEvidence = JSON.parse(sourceInventoryCapture.stdout);
validateSignedArchiveSourceEvidence({ sha256: hash, bytes: stat.size, entries: entries.length, archiveSourceEvidence });
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
      ok: crypto.createHash("sha256").update(extractedModelEvaluation.stdout).digest("hex") === admittedModelEvaluation.sha256
        && parsed?.ok === true
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
  "services/read-api/server.cjs",
  "services/read-api/repository.cjs",
  "services/read-api/authorization.cjs",
  "services/tasks/run.cjs",
  "services/release/writerHandoverTransaction.cjs",
  "tests/writer-handover-transaction.test.cjs",
  "services/tasks/writerResourcePlan.cjs",
  "tests/writer-resource-plan.test.cjs",
  "tests/separated-web-business-clock.test.cjs",
  "services/tasks/roles.cjs",
  "services/tasks/team.cjs",
  "services/tasks/settlement.cjs",
  "services/release/componentPolicy.cjs",
  "scripts/buildServiceArtifact.cjs",
    "scripts/buildSeparatedWeb.cjs",
  "scripts/planServiceRelease.cjs",
  "tests/service-separation-v1.test.cjs",
    "services/recommendation/comboArchive.cjs",
    "services/tasks/combo-archive.cjs",
    "tests/committed-combo-archive.test.cjs",
  "tests/emergency-code-activation.test.cjs",
  "tests/code-cutover-archive-horizon.test.cjs",
  "src/services/prematchV3FeedbackLoop.cjs",
  "scripts/registerPrematchV3Parameters.cjs",
  "tests/prematch-v3-feedback-loop.test.cjs",
  "src/services/sportteryOpeningPolicy.cjs",
  "scripts/verifySportteryOpeningPolicy.cjs",
  "scripts/verifyDailyBulletinPolicy.cjs",
  "scripts/captureDailySourceEvidence.cjs",
  "scripts/recommendationPlatform/dailyBulletinPolicy.cjs",
  "scripts/recommendationPlatform/dailyBulletinRuntime.cjs",
  "scripts/recommendationPlatform/dailySourceEvidence.cjs",
  "tests/daily-bulletin-policy.test.cjs",
  "src/components/recommendations/DailyBulletinPanel.tsx",
  "src/components/recommendations/daily-bulletin.css",
  "tests/sporttery-opening-policy.test.cjs",
  "tests/sporttery-fast-opening.test.cjs",
  "tests/sync-worker-eleven-opening.test.cjs",
  "tests/sporttery-opening-projection.test.cjs",
  "scripts/zeroMarketResearchBaseline.cjs",
  "src/services/marketSeparatedDirectionResearch.cjs",
  "tests/zero-market-research-baseline.test.cjs",
  "tests/market-separated-direction-research.test.cjs",
  "scripts/verifyPrdPaperPipeline.cjs",
  "scripts/releaseOwnedWorkerStop.cjs",
  "scripts/releaseInstalledReadApiIdentity.cjs",
  "tests/installed-read-api-identity.test.cjs",
  "tests/owned-worker-stop.test.cjs",
  "scripts/nativeSnapshotCopyProof.cjs",
  "tests/native-snapshot-copy-proof.test.cjs",
  "scripts/publishReviewedAnalysis.cjs",
  "scripts/teamEvidenceSources.cjs",
  "scripts/teamEvidenceStore.cjs",
  "scripts/syncTeamEvidence.cjs",
  "scripts/loadPrematchTeamEvidence.cjs",
  "src/services/teamEvidencePrematchBridge.cjs",
  "tests/stored-team-evidence-research.test.cjs",
  "scripts/collectExpandedLeagueHistory.cjs",
  "scripts/expandedLeagueHistoryParser.cjs",
  "tests/team-evidence-pipeline.test.cjs",
  "tests/expanded-league-history.test.cjs",
  "scripts/recommendationPlatform/reviewedAnalysis.cjs",
  "scripts/recommendationPlatform/reviewedHandicapQuote.cjs",
  "tests/maintenance-quiescence.test.cjs",
  "scripts/fixedPrematchEvidencePack.cjs",
  "scripts/buildFixedPrematchEvidencePack.cjs",
  "tests/fixed-prematch-evidence-pack.test.cjs",
  "scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs",
  "src/components/recommendations/ReviewedAnalysis.tsx",
  "tests/reviewed-analysis.test.cjs",
  "tests/prospective-forecast-input.test.cjs",
  "server/matchDetailPublication.cjs",
  "collectors/leisu-prematch/website-reader.cjs",
  "collectors/leisu-prematch/website-reader.test.cjs",
  "server/postgresProjectionStore.cjs",
  "src/services/matchDetailPublication.ts",
  "src/pages/MatchDetail.tsx",
  "public/about-data.html",
  "public/methodology.html",
  "public/public-guide.css",
  "src/components/predictions/PrematchCollectionPanel.tsx",
  "src/components/recommendations/DetailPublicationEvidence.tsx",
  "tests/match-detail-publication.test.cjs",
  "tests/prematch-collection-panel.test.cjs",
  "tests/match-detail-identity.test.cjs",
  "tests/fixtures/detail-published-dijon-20261012.json",
  "src/services/publishedReviewCoverage.ts",
  "src/components/recommendations/PublishedReviewCoverage.tsx",
  "src/components/recommendations/published-review-coverage.css",
  "src/services/recommendationCenterView.ts",
  "src/services/recommendationReviewPage.ts",
  "src/components/recommendations/RecommendationCenter.tsx",
  "tests/publishedReviewCoverageUi.test.cjs",
  "scripts/verifyPublishedReviewCoverage.cjs",
  "scripts/recommendationPlatform/publishedReviewCoverage.cjs",
  "scripts/recommendationPlatform/publishedReviewCoverageRepository.cjs",
  "scripts/recommendationPlatform/repository.cjs",
  "scripts/recommendationPlatform/runtime.cjs",
  "server/recommendationReviewPage.cjs",
  "tests/fixtures/coverageFixtures.cjs",
  "tests/fixtures/coverageClient.cjs",
  "tests/publishedReviewCoverage.test.cjs",
  "tests/publishedReviewCoverageRepository.test.cjs",
  "tests/publishedReviewCoverageIntegration.test.cjs",
  "tests/recommendation-review-page.test.cjs",
  "tests/reviewed-three-combo-view.test.cjs",
  "scripts/leagueBaselineRegistry.cjs",
  "scripts/registerLeagueBaseline.cjs",
  "scripts/prepareLeagueModelRegistration.cjs",
  "scripts/collectLeagueTextHistory.cjs",
  "scripts/runLeagueBaselineExperiment.cjs",
  "scripts/recommendationPlatform/leagueBaselineRuntime.cjs",
  "src/services/leagueBaselineModel.cjs",
  "src/services/leagueBaselineRecommendation.cjs",
  "src/components/recommendations/LeagueBaselineDirections.tsx",
  "tests/league-model-adoption.test.cjs",
  "scripts/recommendationPlatform/prdPaperRuntime.cjs",
  "scripts/recommendationPlatform/prdPaperRepository.cjs",
  "src/services/prdPaperRecommendation.cjs",
  "src/components/recommendations/PrdPaperDirections.tsx",
  "tests/prd-paper-recommendation.test.cjs",
  "tests/prd-paper-repository.test.cjs",
  "tests/prd-paper-runtime.test.cjs",
  "tests/prd-paper-directions-view.test.cjs",
  "package.json",
  "scripts/verifySignedLiveHadPublication.cjs",
  "scripts/officialClubResearchEvidence.cjs",
  "tests/official-club-research-evidence.test.cjs",
  "scripts/recommendationPlatform/liveOfficialHad.cjs",
  "scripts/recommendationPlatform/quotePublicationLatency.cjs",
  "tests/fixtures/signed-live-had.cjs",
  "tests/recommendation-live-official-had.test.cjs",
  "tests/recommendation-signed-had-publication.test.cjs",
  "tests/recommendation-quote-publication-latency.test.cjs",
  "scripts/data/football-data-discipline.json",
  "scripts/footballDataDiscipline.cjs",
  "scripts/verifyFootballDataDiscipline.cjs",
  "server/index.cjs",
  "server/readRequestJson.cjs",
  "scripts/verifyRequestJsonUtf8.cjs",
  "server/candidateProspectiveTemporalAudit.cjs",
  "scripts/verifyCandidateProspectiveTemporalAudit.cjs",
  "server/recommendationProjectionParity.cjs",
  "server/recommendationAuthority.cjs",
  "docs/recommendation-publication-authority.md",
  "src/services/recommendationAuthorityPresentation.ts",
  "tests/recommendation-authority.test.cjs",
  "tests/recommendation-authority-integration.test.cjs",
  "tests/recommendation-authority-presentation.test.cjs",
  "tests/remote-recommendation-authority.test.cjs",
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
  "server/chunkedJsonFile.cjs",
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
  "scripts/verifyDataAdoptionSources.cjs",
  "scripts/verifyCandidatePromotionGaps.cjs",
  "src/services/apiFootballDiagnostics.cjs",
  "src/services/apiFootballDiagnostics.d.cts",
  "scripts/apiFootballClockEvidence.cjs",
  "scripts/verifyApiFootballClockEvidence.cjs",
  "scripts/verifyApiFootballDiagnostics.cjs",
  "scripts/verifyCandidateArtifactSeed.cjs",
  "scripts/verifyCandidateRevisionLineage.cjs",
  "scripts/verifyLegacyReferenceConflict.cjs",
  "scripts/verifyFrozenArchiveAuthority.cjs",
  "scripts/frozenArchiveRestoration.cjs",
  "scripts/releaseArchivePreflight.cjs",
  "scripts/verifyReleaseArchiveSuccessor.cjs",
  "scripts/verifyReleaseArchiveSuccessorContracts.cjs",
  "scripts/data/archive-successor-lineage.json",
  "scripts/runReleaseArchivePreflight.cjs",
  "scripts/runReleaseWindowPreflight.cjs",
  "scripts/verifyReleaseWindowPreflight.cjs",
  "scripts/verifyReleaseArchivePreflight.cjs",
  "scripts/data/frozen-archive-restoration.json",
  "scripts/verifyFrozenArchivePersistence.cjs",
  "scripts/verifyFrozenArchiveRestoration.cjs",
  "scripts/verifyOfficialClubResults.cjs",
  "scripts/verifyOfficialClubReceiptClocks.cjs",
  "scripts/competitionModelContext.cjs",
  "scripts/verifyCompetitionModelContext.cjs",
  "scripts/predictionExecutionCapture.cjs",
  "scripts/verifyPredictionExecutionCapture.cjs",
  "scripts/verifyDataGenerationPointerLockRace.cjs",
  "scripts/verifyDataGenerationEndToEnd.cjs",
  "scripts/openFootballObservationStore.cjs",
  "scripts/openFootballResultReceiptIndex.cjs",
  "scripts/verifyOpenFootballResultReceiptIndex.cjs",
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
  "src/services/goalDistribution.cjs",
  "src/services/jointGoalFit.cjs",
  "scripts/verifyJointGoalFit.cjs",
  "scripts/teamCategoryIdentity.cjs",
  "scripts/recentFormEvidence.cjs",
  "scripts/apiFootballScopedAliases.cjs",
  "src/services/strictInstant.cjs",
  "scripts/verifyRecentFormEvidence.cjs",
  "scripts/verifyFootballDataResultsSync.cjs",
  "scripts/verifyTeamCategoryIdentity.cjs",
  "src/services/decisionEventIdentity.cjs",
  "server/publicReferenceArchive.cjs",
  "server/publicReferenceCompanionStore.cjs",
  "tests/public-reference-companion-store.test.cjs",
  "tests/bounded-prediction-snapshots.test.cjs",
  "scripts/manualOfficialReleaseRecovery.cjs",
  "scripts/manualOfficialPublicCarryForward.cjs",
  "scripts/recommendationPlatform/reviewedOfficialEvent.cjs",
  "server/researchOfficialEventRead.cjs",
  "server/officialScheduleRead.cjs",
  "server/officialScheduleHttp.cjs",
  "src/services/officialSchedule.cjs",
  "src/services/officialSchedule.d.cts",
  "src/hooks/useOfficialSchedule.ts",
  "src/components/recommendations/OfficialSchedule.tsx",
  "src/components/recommendations/OfficialSchedule.css",
  "tests/official-schedule-view.test.cjs",
  "src/services/officialEditorialReferences.ts",
  "src/hooks/useOfficialEditorialReferences.ts",
  "src/components/recommendations/OfficialEditorialReferences.tsx",
  "tests/reviewed-official-event.test.cjs",
  "tests/official-editorial-reference-view.test.cjs",
  "tests/manual-official-release-preparation.test.cjs",
  "tests/manual-official-public-carry-forward.test.cjs",
  "tests/fixtures/reviewed-official-event.cjs",
  "scripts/verifyReviewedOfficialEventPostgres.cjs",
  "tests/fixtures/prediction-snapshot-original-functions.json",
  "server/boundedPredictionSnapshots.cjs",
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
  "scripts/runtimePrivateModelArtifactStore.cjs",
  "scripts/postgresPrivateModelArtifactStore.cjs",
  "scripts/verifyPostgresPrivateModelArtifactStore.cjs",
  "scripts/verifyPostgresProjectionSource.cjs",
  "scripts/generationProjectionRows.cjs",
  "scripts/fastResultProjectionGuard.cjs",
  "scripts/postgresGenerationSource.cjs",
  "scripts/runtimePostgresProjection.cjs",
  "server/storageMode.cjs",
  "scripts/modelInputRows.cjs",
  "scripts/postgresModelInput.cjs",
  "scripts/postgresRuntimeReadSession.cjs",
  "scripts/postgresCaptureUniverse.cjs",
  "scripts/postgresWorkerObservation.cjs",
  "scripts/postgresWorkerReadProcess.cjs",
  "scripts/postgresWorkerReadProtocol.cjs",
  "scripts/postgresWorkerReadChild.cjs",
  "scripts/verifyPostgresWorkerReadIsolation.cjs",
  "tests/postgres-worker-read-process.test.cjs",
  "scripts/runtimeOddsHistory.cjs",
  "scripts/nativeStorageReadiness.cjs",
  "scripts/nativePlanStorageStatus.cjs",
  "scripts/postgresReleaseMirror.cjs",
  "scripts/runtimeFastResultInput.cjs",
  "scripts/postgresLearningLedger.cjs",
  "scripts/importPostgresLearningLedger.cjs",
  "scripts/postgresObservationStore.cjs",
  "scripts/importPostgresObservationStore.cjs",
  "server/postgres/migrations/005_learning_ledger.sql",
  "server/postgres/migrations/006_research_observations.sql",
  "scripts/verifyPostgresGenerationSource.cjs",
  "scripts/publicationOperationRunner.cjs",
  "scripts/sqliteFastResultRepository.cjs",
  "scripts/postgresFastResultRepository.cjs",
  "scripts/nativeFastResultFixture.cjs",
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
  "scripts/verifyCandidateTransitionDraft.cjs",
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
  "scripts/verifyResultTimelineSemanticClosure.cjs",
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
  "scripts/verifyPartialPolicyReplayState.cjs",
  "scripts/productionFixtureIsolationContract.cjs",
  "scripts/verifyProductionFixtureIsolationContract.cjs",
  "scripts/verifyProductionFixtureIsolation.cjs",
  "scripts/readCandidatePublicObservations.cjs",
  "server/selectedJsonFullHashWorker.cjs",
  "scripts/verifySelectedJsonParallel.cjs",
  "scripts/capturePublicationCoordinator.cjs",
  "tests/capture-publication-coordination.test.cjs",
  "scripts/workerFastResultPublisher.cjs",
  "scripts/verifyWorkerFastPublisherIsolation.cjs",
  "tests/worker-fast-result-publisher.test.cjs",
  "scripts/postgresCaptureReadiness.cjs",
  "scripts/verifyPostgresCaptureReadiness.cjs",
  "tests/postgres-capture-readiness.test.cjs",
  "scripts/verifyCandidatePublicObservations.cjs",
  "scripts/verifyChunkedJsonFoundation.cjs",
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
  "scripts/releaseWorkerPreflight.cjs",
  "scripts/releaseWorkerCodeRepair.cjs",
  "scripts/verifyReleaseWorkerCodeRepair.cjs",
  "tests/official-model-artifact-isolation.test.cjs",
  "tests/installed-read-api-identity.test.cjs",
  "scripts/runReleaseWorkerPreflight.cjs",
  "scripts/releaseWorkspaceFreshness.cjs",
  "scripts/verifyReleaseWorkspaceFreshness.cjs",
  "scripts/releaseProgress.cjs",
  "scripts/checkReleaseProgress.cjs",
  "scripts/verifyReleaseProgress.cjs",
  "scripts/staticVerificationReceipts.cjs",
  "scripts/rootStaticResultCache.cjs",
  "scripts/releaseSequencePreflight.cjs",
  "scripts/releaseReadinessPolicy.cjs",
  "scripts/releaseModelWorkPolicy.cjs",
  "scripts/verifyReleaseSpeedFix.cjs",
  "scripts/releasePrivateModelSeed.cjs",
  "scripts/verifyReleasePrivateModelSeed.cjs",
  "scripts/verifyReleaseReadinessEarlyExit.cjs",
  "scripts/rootStaticVerificationAttestations.cjs",
  "scripts/createRootStaticVerificationAttestations.cjs",
  "scripts/verifyRootStaticVerificationAttestations.cjs",
  "scripts/verifyReleaseStaticAttestationIntegration.cjs",
  "scripts/releaseStageEvidence.cjs",
  "scripts/verifyReleaseStageEvidence.cjs",
  "scripts/releaseStageShellBridge.cjs",
  "scripts/verifyReleaseStageShellBridge.cjs",
  "scripts/releaseChangeClassification.cjs",
  "scripts/verifyReleaseChangeClassification.cjs",
  "scripts/releaseArchiveSourceInventory.cjs",
  "scripts/verifyReleaseArchiveSourceInventory.cjs",
  "scripts/releaseSigningTrust.cjs",
  "scripts/verifyReleaseSigningTrust.cjs",
  "scripts/releaseSourceBaseline.cjs",
  "scripts/verifyReleaseSourceBaseline.cjs",
  "scripts/verifyReleaseSourceBaselineIntegration.cjs",
  "scripts/frontendBuildEvidence.cjs",
  "scripts/verifyFrontendBuildEvidence.cjs",
  "scripts/frontendBuildSandbox.cjs",
  "scripts/verifyFrontendBuildSandbox.cjs",
  "scripts/frontendOverlayTransaction.cjs",
  "scripts/verifyFrontendOverlayTransaction.cjs",
  "scripts/frontendRuntimeBoundary.cjs",
  "scripts/verifyFrontendRuntimeBoundary.cjs",
  "scripts/createFrontendReleaseBundle.cjs",
  "scripts/verifyFrontendSourceBundle.cjs",
  "scripts/frontendReleaseAuthorization.cjs",
  "scripts/verifyFrontendReleaseAuthorization.cjs",
  "scripts/frontendReleaseController.cjs",
  "scripts/frontendPolicyRefresh.cjs",
  "scripts/verifyFrontendPolicyRefresh.cjs",
    "scripts/verifyFrontendPolicyBootstrap.cjs",
  "scripts/frontendReleaseAttempt.cjs",
  "scripts/verifyFrontendReleaseAttempt.cjs",
  "scripts/verifyFrontendReleaseController.cjs",
  "scripts/verifyFrontendReleaseEntrypoints.cjs",
  "scripts/frontendReleaseTransaction.cjs",
  "scripts/verifyFrontendReleaseTransaction.cjs",
  "scripts/frontendBuildDependencies.cjs",
  "scripts/verifyFrontendBuildDependencies.cjs",
  "scripts/frontendInstalledRuntime.cjs",
  "scripts/verifyFrontendInstalledRuntime.cjs",
  "scripts/verifyFrontendRuntimeAlternatives.cjs",
  "scripts/frontendReleaseInputs.cjs",
  "scripts/prepareFrontendRelease.cjs",
  "scripts/verifyFrontendReleaseInputs.cjs",
  "scripts/stopVerificationChild.cjs",
  "scripts/verifyVerificationChildShutdown.cjs",
  "server/frontendReleaseIdentity.cjs",
  "scripts/verifyFrontendReleaseIdentity.cjs",
  "scripts/verifyFrontendReleaseConsumers.cjs",
  "server/staticFileResponse.cjs",
  "scripts/verifyStaticFileResponseIdentity.cjs",
  "scripts/verifyStaticVerificationReceipts.cjs",
  "scripts/productionPlanSourceContracts.cjs",
  "scripts/verifyProductionPlanSourceContracts.cjs",
  "scripts/data/production-plan-source-contracts.json",
  "scripts/verifyReleaseWorkerPreflight.cjs",
  "tests/fixtures/worker-skipped-after-official-failure-20261015.json",
  "scripts/verifyReleaseRecovery.cjs",
  "scripts/verifyReleaseSidecarRecovery.cjs",
  "scripts/verifyNativeSidecarLifecycle.cjs",
  "scripts/verifyProductionReadiness.cjs",
  "scripts/verifyRemotePublicReadiness.cjs",
  "scripts/fallbackReadiness.cjs",
  "scripts/verifyFallbackReadiness.cjs",
  "scripts/verifyRemoteRefreshPipeline.cjs",
  "scripts/verifyRemoteRefreshPipelineContract.cjs",
  "scripts/verifyDeploymentConfig.cjs",
  "scripts/deployReleaseBundle.cjs",
  "scripts/releaseRecoveryHelperRotation.cjs",
  "scripts/releaseStoragePreflight.cjs",
  "scripts/nativeReleaseJournal.cjs",
  "scripts/nativeDatabaseCutover.cjs",
  "scripts/postgresReleaseMirror.cjs",
  "scripts/nativeReleaseDatabaseSession.cjs",
  "scripts/nativeReleaseDataPlane.cjs",
  "scripts/nativeReleaseCapacity.cjs",
  "scripts/releaseDataPlanePolicy.cjs",
  "scripts/nativeCodeReleaseDataPlane.cjs",
  "scripts/verifyNativeCodeServing.cjs",
  "scripts/committedGenerationRecoveryServingCore.cjs",
  "tests/normal-code-serving.test.cjs",
  "tests/reference-index-repair-boundary.test.cjs",
  "server/researchArchiveRead.cjs",
  "tests/research-archive-read.test.cjs",
  "scripts/verifyResearchArchivePostgres.cjs",
  "tests/code-data-release.test.cjs",
  "tests/postgres-committed-publication.test.cjs",
  "scripts/postgresReceiptBarrier.cjs",
  "scripts/verifyReceiptBarrierPostgres.cjs",
  "tests/postgres-receipt-barrier.test.cjs",
  "tests/postgres-file-json-payload.test.cjs",
  "tests/postgres-source-memory.integration.cjs",
  "tests/generation-startup-streaming.test.cjs",
  "scripts/installResearchBroker.cjs",
  "scripts/verifyResearchSocketBinding.py",
  "tests/research-broker-installer.test.cjs",
  "tests/research-installer-archive-contract.test.cjs",
  "tests/research-refresh-boundary.test.cjs",
  "tests/research-combo-revision.test.cjs",
  "tests/research-review-projection.test.cjs",
  "tests/research-review-frontend.test.cjs",
  "server/researchComboRevision.cjs",
  "server/researchPublicationRetry.cjs",
  "server/researchPublicationInputRecovery.cjs",
  "server/researchArchiveRetry.cjs",
  "tests/research-archive-retry.test.cjs",
  "scripts/verifyResearchArchiveRetryPostgres.cjs",
  "tests/research-publication-retry.test.cjs",
  "tests/research-publication-input-recovery.test.cjs",
  "scripts/verifyResearchPublicationRetryPostgres.cjs",
  "scripts/verifyResearchPublicationInputRecoveryPostgres.cjs",
  "server/researchReviewProjection.cjs",
  "server/reviewedHistoryQuery.cjs",
  "server/researchFrozenCombos.cjs",
  "tests/research-frozen-combos.test.cjs",
  "scripts/verifyResearchRunuser.cjs",
  "scripts/baselineAuthorityReplayRepair.cjs",
  "scripts/baselineReadonlyPeer.cjs",
  "scripts/verifyBaselineReadonlyPeer.cjs",
  "scripts/verifyBaselineAuthorityReplayLock.cjs",
  "tests/baseline-authority-replay-repair.test.cjs",
  "src/services/reviewedPresentation.ts",
  "scripts/verifyResearchComboRevisionPostgres.cjs",
  "server/streamedJsonObjectArrays.cjs",
  "scripts/verifyCodeReleaseShell.cjs",
  "scripts/codeReleaseAcceptance.cjs",
  "scripts/verifyStagedCodeRelease.cjs",
  "tests/staged-code-release.test.cjs",
  "scripts/verifyCodeReleasePostgresIsolation.cjs",
  "scripts/runReleaseCapacityPreflight.cjs",
  "tests/release-capacity-preflight.test.cjs",
  "scripts/releaseRetentionPlan.cjs",
  "tests/native-release-capacity.test.cjs",
  "tests/release-retention-plan.test.cjs",
  "scripts/nativeReleaseGenerationCopy.cjs",
  "scripts/nativeReleasePostgresTransport.cjs",
  "scripts/validateNativeReleasePolicy.cjs",
  "scripts/verifyNativeReleasePipeline.cjs",
  "scripts/verifyNativeReleaseFailureCleanup.cjs",
  "scripts/verifyScheduledStorageRetention.cjs",
  "scripts/verifyPostgresBackupRetention.cjs",
  "deploy/light-server/football-postgres-backup.sh",
  "deploy/light-server/football-postgres-backup.service",
  "deploy/light-server/football-postgres-backup.timer",
  "deploy/light-server/football-journald-retention.conf",
  "scripts/verifyNativeReleaseDataPlane.cjs",
  "scripts/verifyNativeReleaseGenerationCopy.cjs",
  "scripts/verifyNativeReleaseDatabaseSession.cjs",
  "deploy/light-server/release-native.sh",
  "deploy/light-server/recommendation-schema-bridge.cjs",
  "server/postgres/migrations/013_dual_choice_research.sql",
  "server/postgres/migrations/014_dual_choice_market_neutral.sql",
  "deploy/light-server/native-release-policy.json",
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
  archiveSourceEvidence,
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
if (manifestBytes.length > 1024 * 1024) throw new Error("release manifest with source inventory exceeds the trusted 1 MiB limit");
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
