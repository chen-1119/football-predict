const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const nginxPath = path.join(rootDir, "deploy", "light-server", "nginx.conf");
const nginxHttpCommonPath = path.join(rootDir, "deploy", "light-server", "nginx-http-common.conf");
const nginxServerCommonPath = path.join(rootDir, "deploy", "light-server", "nginx-server-common.conf");
const nginxSecurityHeadersPath = path.join(rootDir, "deploy", "light-server", "nginx-security-headers.conf");
const nginxTlsTemplatePath = path.join(rootDir, "deploy", "light-server", "nginx-tls-site.conf.template");
const enableNginxTlsPath = path.join(rootDir, "deploy", "light-server", "enable-nginx-tls.sh");
const deployPowerShellPath = path.join(rootDir, "deploy", "light-server", "deploy.ps1");
const httpsTlsOperationsPath = path.join(rootDir, "docs", "https-tls-operations.md");
const sportteryRelayDocPath = path.join(rootDir, "docs", "sporttery-relay-snapshot.md");
const envExamplePath = path.join(rootDir, "deploy", "light-server", "env.example");
const workerServicePath = path.join(rootDir, "deploy", "light-server", "football-sync-worker.service");
const appServicePath = path.join(rootDir, "deploy", "light-server", "football-predict.service");
const cleanupServicePath = path.join(rootDir, "deploy", "light-server", "football-cleanup.service");
const cleanupTimerPath = path.join(rootDir, "deploy", "light-server", "football-cleanup.timer");
const monitorServicePath = path.join(rootDir, "deploy", "light-server", "football-monitor.service");
const monitorTimerPath = path.join(rootDir, "deploy", "light-server", "football-monitor.timer");
const releaseScriptPath = path.join(rootDir, "deploy", "light-server", "release.sh");
const bundleReleaseScriptPath = path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh");
const releasePrebuildPolicyPath = path.join(rootDir, "scripts", "releasePrebuildPolicy.cjs");
const compactPublicOddsHistoryPath = path.join(rootDir, "scripts", "compactPublicOddsHistory.cjs");
const serverIndexPath = path.join(rootDir, "server", "index.cjs");
const sourceRedundancyPath = path.join(rootDir, "server", "sourceRedundancy.cjs");
const offlineReleaseKitPath = path.join(rootDir, "scripts", "createOfflineReleaseKit.cjs");
const watchReleaseWindowPath = path.join(rootDir, "scripts", "watchReleaseWindow.cjs");
const verifyReleaseWatchPolicyPath = path.join(rootDir, "scripts", "verifyReleaseWatchPolicy.cjs");
const cleanupServerArtifactsPath = path.join(rootDir, "scripts", "cleanupServerArtifacts.cjs");
const createReleaseBundlePath = path.join(rootDir, "scripts", "createReleaseBundle.cjs");
const releaseBundlePolicyPath = path.join(rootDir, "scripts", "releaseBundlePolicy.cjs");
const verifyReleaseBundleSafetyPath = path.join(rootDir, "scripts", "verifyReleaseBundleSafety.cjs");
const deployReleaseBundlePath = path.join(rootDir, "scripts", "deployReleaseBundle.cjs");
const releaseSshHostKeyPinPath = path.join(rootDir, "scripts", "releaseSshHostKeyPin.cjs");
const verifyReleaseSshHostKeyPinPath = path.join(rootDir, "scripts", "verifyReleaseSshHostKeyPin.cjs");
const releaseSigningPath = path.join(rootDir, "scripts", "releaseSigning.cjs");
const signedEntrypointsVerifierPath = path.join(rootDir, "scripts", "verifySignedReleaseEntrypoints.cjs");
const releaseRecoveryVerifierPath = path.join(rootDir, "scripts", "verifyReleaseRecovery.cjs");
const cleanupRelayHardeningVerifierPath = path.join(rootDir, "scripts", "verifyCleanupRelayHardening.cjs");
const sshOperatorKeyRecoveryVerifierPath = path.join(rootDir, "scripts", "verifySshOperatorKeyRecovery.cjs");
const releaseWrapperPath = path.join(rootDir, "deploy", "light-server", "football-release");
const releaseRecoveryHelperPath = path.join(rootDir, "deploy", "light-server", "football-release-recovery.cjs");
const relayPromoterPath = path.join(rootDir, "deploy", "light-server", "football-relay-promote");
const releaseBootstrapPath = path.join(rootDir, "deploy", "light-server", "bootstrap-release-entrypoints.sh");
const releaseSudoersPath = path.join(rootDir, "deploy", "light-server", "football-automation.sudoers");
const qaAccessOperatorPath = path.join(rootDir, "deploy", "light-server", "football-access-code-qa.cjs");
const checkReleaseStatusPath = path.join(rootDir, "scripts", "checkReleaseStatus.cjs");
const syncLockPath = path.join(rootDir, "server", "syncLock.cjs");
const verifySyncLockPath = path.join(rootDir, "scripts", "verifySyncLock.cjs");
const verifyRemotePublicPath = path.join(rootDir, "scripts", "verifyRemotePublicReadiness.cjs");
const verifyFallbackReadinessPath = path.join(rootDir, "scripts", "verifyFallbackReadiness.cjs");
const verifyTlsReadinessPath = path.join(rootDir, "scripts", "verifyTlsReadiness.cjs");
const verifyProductionReadinessPath = path.join(rootDir, "scripts", "verifyProductionReadiness.cjs");
const verifyProductionPlanCoveragePath = path.join(rootDir, "scripts", "verifyProductionPlanCoverage.cjs");
const verifyMatchDetailLifecyclePath = path.join(rootDir, "scripts", "verifyMatchDetailLifecycle.cjs");
const runtimeMonitorPath = path.join(rootDir, "scripts", "checkServerRuntime.cjs");
const startLocalPreviewPath = path.join(rootDir, "scripts", "startLocalPreview.cjs");
const configureSportteryProxyPath = path.join(rootDir, "scripts", "configureSportteryRelayProxy.cjs");
const pushSportteryRelaySnapshotPath = path.join(rootDir, "scripts", "pushSportteryRelaySnapshot.cjs");
const verifySportteryRelayFullRecoveryPath = path.join(rootDir, "scripts", "verifySportteryRelayFullRecovery.cjs");
const verifySportteryRelayDualLaneServerPath = path.join(rootDir, "scripts", "verifySportteryRelayDualLaneServer.cjs");
const runSportteryRelayPushPath = path.join(rootDir, "scripts", "runSportteryRelayPush.ps1");
const installSportteryRelayTaskPath = path.join(rootDir, "scripts", "installSportteryRelayTask.ps1");
const syncDataPath = path.join(rootDir, "scripts", "syncData.cjs");
const apiFootballSyncPath = path.join(rootDir, "scripts", "syncApiFootballData.cjs");
const apiFootballRuntimePolicyPath = path.join(rootDir, "src", "services", "apiFootballRuntimePolicy.cjs");
const oddsHistoryStorePath = path.join(rootDir, "scripts", "oddsHistoryStore.cjs");
const privateModelArtifactStorePath = path.join(rootDir, "scripts", "privateModelArtifactStore.cjs");
const runModelBacktestPath = path.join(rootDir, "scripts", "runModelBacktest.cjs");
const verifyModelPromotionGatePath = path.join(rootDir, "scripts", "verifyModelPromotionGate.cjs");
const packageJsonPath = path.join(rootDir, "package.json");
const cloudflareWorkerPath = path.join(rootDir, "cloudflare", "sync-trigger", "src", "index.js");
const cloudflareSportteryCollectorPath = path.join(rootDir, "cloudflare", "sync-trigger", "src", "sportteryCollector.js");
const cloudflareWranglerPath = path.join(rootDir, "cloudflare", "sync-trigger", "wrangler.jsonc");
const cloudflareSportteryCollectorVerifierPath = path.join(rootDir, "scripts", "verifyCloudflareSportteryCollector.cjs");
const collectorTrustRegistryPath = path.join(rootDir, "deploy", "light-server", "collector-trust-registry.json");
const githubSyncWorkflowPath = path.join(rootDir, ".github", "workflows", "sync.yml");
const githubPagesWorkflowPath = path.join(rootDir, ".github", "workflows", "deploy.yml");
const cloudPushPath = path.join(rootDir, "scripts", "pushCloudSync.cjs");

const readText = (filePath) => {
  try {
    // Git may materialize text files with CRLF on the release workstation,
    // while the signed bundle is verified on Linux. Keep every source-token
    // assertion byte-order independent so the same commit cannot pass locally
    // and fail remotely solely because of checkout line endings.
    return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return "";
  }
};

const normalize = (text) => text.replace(/\s+/g, " ").trim();

const parseJsonFile = (filePath) => {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const extractLocation = (nginx, locationHeader) => {
  const index = nginx.indexOf(locationHeader);
  if (index < 0) return "";
  const openIndex = nginx.indexOf("{", index);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let cursor = openIndex; cursor < nginx.length; cursor += 1) {
    if (nginx[cursor] === "{") depth += 1;
    if (nginx[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return nginx.slice(openIndex + 1, cursor);
    }
  }
  return "";
};

const keyValue = (text, key) => {
  const pattern = new RegExp(`^${key}=([^\\r\\n]*)`, "m");
  return text.match(pattern)?.[1]?.trim() || "";
};

const unitDirectiveValues = (text, key) => {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedKey}=(.*)$`, "gm");
  return [...String(text || "").matchAll(pattern)].map((match) => match[1].trim());
};

const hasUnitDirective = (text, key, value) => unitDirectiveValues(text, key).includes(value);
const hasEmptyUnitDirective = (text, key) => unitDirectiveValues(text, key).includes("");
const unitDirectiveTokens = (text, key) => unitDirectiveValues(text, key)
  .flatMap((value) => value.split(/\s+/).filter(Boolean));
const unitEnvironmentKeys = (text) => String(text || "")
  .split(/\r?\n/)
  .map((line) => line.match(/^Environment="?([A-Z][A-Z0-9_]*)=/)?.[1] || null)
  .filter(Boolean);

const run = () => {
  const checks = [];
  const nginxSite = readText(nginxPath);
  const nginxHttpCommon = readText(nginxHttpCommonPath);
  const nginxServerCommon = readText(nginxServerCommonPath);
  const nginxSecurityHeaders = readText(nginxSecurityHeadersPath);
  const nginxTlsTemplate = readText(nginxTlsTemplatePath);
  const enableNginxTls = readText(enableNginxTlsPath);
  const deployPowerShell = readText(deployPowerShellPath);
  const httpsTlsOperations = readText(httpsTlsOperationsPath);
  const sportteryRelayDoc = readText(sportteryRelayDocPath);
  const nginx = [nginxHttpCommon, nginxSecurityHeaders, nginxServerCommon, nginxSite].join("\n");
  const envExample = readText(envExamplePath);
  const workerService = readText(workerServicePath);
  const appService = readText(appServicePath);
  const cleanupService = readText(cleanupServicePath);
  const cleanupTimer = readText(cleanupTimerPath);
  const monitorService = readText(monitorServicePath);
  const monitorTimer = readText(monitorTimerPath);
  const releaseScript = readText(releaseScriptPath);
  const bundleReleaseScript = readText(bundleReleaseScriptPath);
  const releasePrebuildPolicy = readText(releasePrebuildPolicyPath);
  const compactPublicOddsHistory = readText(compactPublicOddsHistoryPath);
  const serverIndex = readText(serverIndexPath);
  const apiFootballSync = readText(apiFootballSyncPath);
  const apiFootballRuntimePolicy = readText(apiFootballRuntimePolicyPath);
  const sourceRedundancy = readText(sourceRedundancyPath);
  const offlineReleaseKit = readText(offlineReleaseKitPath);
  const watchReleaseWindow = readText(watchReleaseWindowPath);
  const verifyReleaseWatchPolicy = readText(verifyReleaseWatchPolicyPath);
  const cleanupServerArtifacts = readText(cleanupServerArtifactsPath);
  const createReleaseBundle = readText(createReleaseBundlePath);
  const releaseBundlePolicy = readText(releaseBundlePolicyPath);
  const verifyReleaseBundleSafety = readText(verifyReleaseBundleSafetyPath);
  const deployReleaseBundle = readText(deployReleaseBundlePath);
  const releaseSshHostKeyPin = readText(releaseSshHostKeyPinPath);
  const verifyReleaseSshHostKeyPin = readText(verifyReleaseSshHostKeyPinPath);
  const releaseSigning = readText(releaseSigningPath);
  const signedEntrypointsVerifier = readText(signedEntrypointsVerifierPath);
  const releaseRecoveryVerifier = readText(releaseRecoveryVerifierPath);
  const cleanupRelayHardeningVerifier = readText(cleanupRelayHardeningVerifierPath);
  const sshOperatorKeyRecoveryVerifier = readText(sshOperatorKeyRecoveryVerifierPath);
  const releaseWrapper = readText(releaseWrapperPath);
  const releaseRecoveryHelper = readText(releaseRecoveryHelperPath);
  const relayPromoter = readText(relayPromoterPath);
  const releaseBootstrap = readText(releaseBootstrapPath);
  const releaseSudoers = readText(releaseSudoersPath);
  const qaAccessOperator = readText(qaAccessOperatorPath);
  const checkReleaseStatus = readText(checkReleaseStatusPath);
  const syncLock = readText(syncLockPath);
  const verifySyncLock = readText(verifySyncLockPath);
  const verifyRemotePublic = readText(verifyRemotePublicPath);
  const verifyTlsReadiness = readText(verifyTlsReadinessPath);
  const verifyProductionReadiness = readText(verifyProductionReadinessPath);
  const verifyProductionPlanCoverage = readText(verifyProductionPlanCoveragePath);
  const verifyMatchDetailLifecycle = readText(verifyMatchDetailLifecyclePath);
  const runtimeMonitor = readText(runtimeMonitorPath);
  const startLocalPreview = readText(startLocalPreviewPath);
  const configureSportteryProxy = readText(configureSportteryProxyPath);
  const sportteryRelayPush = readText(pushSportteryRelaySnapshotPath);
  const verifySportteryRelayFullRecovery = readText(verifySportteryRelayFullRecoveryPath);
  const verifySportteryRelayDualLaneServer = readText(verifySportteryRelayDualLaneServerPath);
  const runSportteryRelayPush = readText(runSportteryRelayPushPath);
  const installSportteryRelayTask = readText(installSportteryRelayTaskPath);
  const syncData = readText(syncDataPath);
  const oddsHistoryStore = readText(oddsHistoryStorePath);
  const privateModelArtifactStore = readText(privateModelArtifactStorePath);
  const runtimePrivateModelArtifactStore = readText(path.join(rootDir, "scripts/runtimePrivateModelArtifactStore.cjs"));
  const postgresPrivateModelArtifactStore = readText(path.join(rootDir, "scripts/postgresPrivateModelArtifactStore.cjs"));
  const runModelBacktest = readText(runModelBacktestPath);
  const verifyModelPromotionGate = readText(verifyModelPromotionGatePath);
  const packageJson = parseJsonFile(packageJsonPath) || { scripts: {} };
  const cloudflareWorker = readText(cloudflareWorkerPath);
  const cloudflareSportteryCollector = readText(cloudflareSportteryCollectorPath);
  const cloudflareWrangler = parseJsonFile(cloudflareWranglerPath);
  const cloudflareSportteryCollectorVerifier = readText(cloudflareSportteryCollectorVerifierPath);
  const collectorTrustRegistry = parseJsonFile(collectorTrustRegistryPath);
  const githubSyncWorkflow = readText(githubSyncWorkflowPath);
  const githubPagesWorkflow = readText(githubPagesWorkflowPath);
  const cloudPush = readText(cloudPushPath);
  const cleanupRelayHardeningRun = spawnSync(process.execPath, [cleanupRelayHardeningVerifierPath], {
    cwd: rootDir,
    encoding: "utf8"
  });
  let cleanupRelayHardeningPayload = null;
  try {
    cleanupRelayHardeningPayload = JSON.parse(cleanupRelayHardeningRun.stdout);
  } catch {
    // The check below reports malformed/no verifier output.
  }
  const sshOperatorKeyRecoveryRun = spawnSync(process.execPath, [sshOperatorKeyRecoveryVerifierPath], {
    cwd: rootDir,
    encoding: "utf8"
  });
  let sshOperatorKeyRecoveryPayload = null;
  try {
    sshOperatorKeyRecoveryPayload = JSON.parse(sshOperatorKeyRecoveryRun.stdout);
  } catch {
    // The check below reports malformed/no verifier output.
  }
  const releaseSshHostKeyPinRun = spawnSync(process.execPath, [verifyReleaseSshHostKeyPinPath], {
    cwd: rootDir,
    encoding: "utf8"
  });
  let releaseSshHostKeyPinPayload = null;
  try {
    releaseSshHostKeyPinPayload = JSON.parse(releaseSshHostKeyPinRun.stdout);
  } catch {
    // The check below reports malformed/no verifier output.
  }
  const fallbackReadinessRun = spawnSync(process.execPath, [verifyFallbackReadinessPath], {
    cwd: rootDir,
    encoding: "utf8"
  });
  let fallbackReadinessPayload = null;
  try {
    fallbackReadinessPayload = JSON.parse(fallbackReadinessRun.stdout);
  } catch {
    // The check below reports malformed/no verifier output.
  }

  const assets = normalize(extractLocation(nginx, "location /assets/"));
  const runtimeConfig = normalize(extractLocation(nginx, "location = /data/runtime-config.json"));
  const data = normalize(extractLocation(nginx, "location /data/"));
  const media = normalize(extractLocation(nginx, "location /media/"));
  const contactQrCode = normalize(extractLocation(nginx, "location = /contact-qr-code.jpg"));
  const contactQr = normalize(extractLocation(nginx, "location = /contact-qr.jpg"));
  const api = normalize(extractLocation(nginx, "location /api/"));
  const relaySnapshotUpload = normalize(extractLocation(nginx, "location = /api/admin/sporttery-relay-snapshot"));
  const collectorEvidenceUpload = normalize(extractLocation(nginxServerCommon, "location = /api/admin/sporttery-collector-evidence"));
  const admin = normalize(extractLocation(nginx, "location /api/admin/"));
  const events = normalize(extractLocation(nginx, "location /api/v1/events"));
  // nginx-http-common.conf also owns a loopback-only maintenance server with
  // its own `location /`.  The public SPA root belongs specifically to the
  // server-context include.
  const root = normalize(extractLocation(nginxServerCommon, "location / {"));
  const startsWorkerBeforeRemotePublicVerify = (text) => {
    const workerStart = text.indexOf('start_worker_for_live_release || rollback "sync worker failed to start after release"');
    const npmRemotePublicVerify = text.indexOf("npm run verify:remote-public");
    const directRemotePublicVerify = text.indexOf("scripts/verifyRemotePublicReadiness.cjs");
    const remotePublicVerify = npmRemotePublicVerify >= 0 ? npmRemotePublicVerify : directRemotePublicVerify;
    return workerStart >= 0 && remotePublicVerify >= 0 && workerStart < remotePublicVerify;
  };
  const waitsForCurrentWorkerIdleAndFreezesAcrossReadiness = (text) => {
    const workerStart = text.indexOf('start_worker_for_live_release || rollback "sync worker failed to start after release"');
    const workerPublishEvidence = text.indexOf('wait_for_worker_official_publish_after "$WORKER_RELEASE_STARTED_AT"');
    const workerIdleEvidence = text.indexOf('wait_for_worker_readiness_idle_after "$WORKER_RELEASE_STARTED_AT"');
    const firstCaptureRefresh = text.indexOf("refresh_candidate_capture_heartbeat_for_readiness", workerIdleEvidence);
    const workerFreeze = text.indexOf("freeze_worker_for_readiness", firstCaptureRefresh);
    const keeperStart = text.indexOf("start_release_candidate_heartbeat_keeper", workerFreeze);
    const postSwapReadiness = text.indexOf('rollback "post-swap production readiness failed"', workerFreeze);
    const remotePublicVerify = text.indexOf("scripts/verifyRemotePublicReadiness.cjs", postSwapReadiness);
    const keeperHealthAfterReadiness = text.indexOf(
      "wait_for_release_candidate_heartbeat_keeper_healthy",
      postSwapReadiness,
    );
    const keeperHealthAfterRemote = text.indexOf(
      "wait_for_release_candidate_heartbeat_keeper_healthy",
      remotePublicVerify,
    );
    const keeperStop = text.indexOf(
      "stop_release_candidate_heartbeat_keeper",
      keeperHealthAfterRemote,
    );
    const workerResume = text.indexOf('resume_worker_after_readiness || rollback "sync worker failed to resume after readiness"');
    return workerStart >= 0
      && workerPublishEvidence > workerStart
      && workerIdleEvidence > workerPublishEvidence
      && firstCaptureRefresh > workerIdleEvidence
      && workerFreeze > firstCaptureRefresh
      && keeperStart > workerFreeze
      && keeperStart < postSwapReadiness
      && postSwapReadiness > workerFreeze
      && keeperHealthAfterReadiness > postSwapReadiness
      && keeperHealthAfterReadiness < remotePublicVerify
      && remotePublicVerify > postSwapReadiness
      && keeperHealthAfterRemote > remotePublicVerify
      && keeperStop > keeperHealthAfterRemote
      && workerResume > keeperStop
      && workerResume > remotePublicVerify;
  };
  const pausesWorkerBeforeCandidateBuild = (text) => {
    const preflight = text.indexOf('wait_for_health "http://${HOST}:${PORT}"');
    const workerPause = preflight >= 0 ? text.indexOf("stop_worker_for_release_window", preflight) : -1;
    const oldBuildCandidate = text.indexOf('log "build candidate"');
    const isolatedBuildCandidate = text.indexOf('log "build candidate inside disposable transient cgroups"');
    const buildCandidate = oldBuildCandidate >= 0 ? oldBuildCandidate : isolatedBuildCandidate;
    return preflight >= 0 && workerPause >= 0 && buildCandidate >= 0 && preflight < workerPause && workerPause < buildCandidate;
  };
  const preservesLiveDataBeforeCandidateBuild = (text) => {
    const preserveNext = text.indexOf('preserve_live_public_data_cache "$APP_DIR" "$NEXT_DIR"');
    const preserveBuild = text.indexOf('preserve_live_public_data_cache "$APP_DIR" "$BUILD_DIR"');
    const preserve = preserveNext >= 0 ? preserveNext : preserveBuild;
    const oldBuildCandidate = text.indexOf('log "build candidate"');
    const isolatedBuildCandidate = text.indexOf('log "build candidate inside disposable transient cgroups"');
    const buildCandidate = oldBuildCandidate >= 0 ? oldBuildCandidate : isolatedBuildCandidate;
    return preserve >= 0 && buildCandidate >= 0 && preserve < buildCandidate;
  };

  const acmeBootstrap = normalize(extractLocation(nginxSite, "location ^~ /.well-known/acme-challenge/"));
  const tlsAcme = normalize(extractLocation(nginxTlsTemplate, "location ^~ /.well-known/acme-challenge/"));
  pushCheck(checks, "nginx config is split by directive context", nginxHttpCommon.includes("limit_req_zone")
    && nginxHttpCommon.includes("upstream football_node")
    && nginxHttpCommon.includes("server_tokens off")
    && nginxServerCommon.includes("location /api/")
    && nginxServerCommon.includes("location / {")
    && nginxSecurityHeaders.includes("add_header X-Content-Type-Options nosniff always;")
    && nginxSecurityHeaders.includes("add_header Referrer-Policy strict-origin-when-cross-origin always;")
    && nginxSite.includes("include /etc/nginx/snippets/football-predict-server.conf;"), {
      hasHttpCommon: Boolean(nginxHttpCommon),
      hasServerCommon: Boolean(nginxServerCommon),
      siteIncludesServerCommon: nginxSite.includes("football-predict-server.conf")
    });

  const securityHeaderInclude = "include /etc/nginx/snippets/football-predict-security-headers.conf;";
  const cacheHeaderLocations = [runtimeConfig, assets, media, contactQrCode, contactQr, data, root];
  pushCheck(checks, "Nginx cache locations retain inherited security headers", nginxServerCommon.includes(securityHeaderInclude)
    && cacheHeaderLocations.every((location) => location.includes(securityHeaderInclude)), {
      serverIncludesSecurityHeaders: nginxServerCommon.includes(securityHeaderInclude),
      protectedCacheLocations: cacheHeaderLocations.filter((location) => location.includes(securityHeaderInclude)).length,
      expectedCacheLocations: cacheHeaderLocations.length
    });

  pushCheck(checks, "HTTP bootstrap exposes an isolated ACME webroot", acmeBootstrap.includes("root /var/www/letsencrypt")
    && acmeBootstrap.includes("try_files $uri =404")
    && !acmeBootstrap.includes("proxy_pass"), {
      acmeBootstrap
    });

  pushCheck(checks, "host-local IP TLS template is modern and fixed-target", nginxTlsTemplate.includes("listen 443 ssl http2 default_server;")
    && nginxTlsTemplate.includes("server_name __TLS_IP_ADDRESS__;")
    && nginxTlsTemplate.includes("ssl_certificate /etc/letsencrypt/live/__TLS_CERT_NAME__/fullchain.pem;")
    && nginxTlsTemplate.includes("ssl_certificate_key /etc/letsencrypt/live/__TLS_CERT_NAME__/privkey.pem;")
    && nginxTlsTemplate.includes("ssl_protocols TLSv1.2 TLSv1.3;")
    && nginxTlsTemplate.includes("ssl_session_tickets off;")
    && nginxTlsTemplate.includes("return 308 https://__TLS_IP_ADDRESS__$request_uri;")
    && tlsAcme.includes("root /var/www/letsencrypt")
    && tlsAcme.includes("try_files $uri =404")
    && nginxTlsTemplate.includes("include /etc/nginx/snippets/football-predict-server.conf;"), {
      listensHttps: nginxTlsTemplate.includes("listen 443 ssl http2 default_server;"),
      protocols: nginxTlsTemplate.match(/ssl_protocols\s+([^;]+);/)?.[1] || null,
      fixedRedirect: nginxTlsTemplate.includes("https://__TLS_IP_ADDRESS__$request_uri"),
      acmeBypass: Boolean(tlsAcme)
    });

  pushCheck(checks, "TLS enable helper requires explicit consent and renewal automation", enableNginxTls.includes('ACME_AGREE_TOS="${ACME_AGREE_TOS:-0}"')
    && enableNginxTls.includes('if [ "$ACME_AGREE_TOS" != "1" ]')
    && enableNginxTls.includes("ACME_EMAIL must be a valid non-empty contact email")
    && enableNginxTls.includes("Certbot 5.4 or newer is required")
    && enableNginxTls.includes("--preferred-profile")
    && enableNginxTls.includes("shortlived")
    && enableNginxTls.includes("--webroot-path")
    && enableNginxTls.includes("--ip-address")
    && enableNginxTls.includes("ACME_STAGING")
    && enableNginxTls.includes("TLS site was not enabled")
    && enableNginxTls.includes("renewal-hooks/deploy/football-predict-nginx")
    && enableNginxTls.includes("nginx -t")
    && enableNginxTls.includes("systemctl reload nginx"), {
      requiresTos: enableNginxTls.includes('ACME_AGREE_TOS" != "1"'),
      requiresEmail: enableNginxTls.includes("ACME_EMAIL must be a valid"),
      requestsShortLived: enableNginxTls.includes("shortlived"),
      hasDeployHook: enableNginxTls.includes("renewal-hooks/deploy")
    });

  pushCheck(checks, "TLS readiness verifier covers bootstrap and strict modes", packageJson.scripts?.["verify:tls"] === "node scripts/verifyTlsReadiness.cjs"
    && verifyTlsReadiness.includes('"bootstrap"')
    && verifyTlsReadiness.includes('"strict"')
    && verifyTlsReadiness.includes("getPeerCertificate")
    && verifyTlsReadiness.includes("certificate has renewal runway")
    && verifyTlsReadiness.includes("certificate contains expected IP SAN")
    && verifyTlsReadiness.includes("TLS 1.0 and 1.1 are rejected")
    && verifyTlsReadiness.includes("HTTP redirects to the fixed HTTPS identity")
    && verifyTlsReadiness.includes("ACME challenge bypasses HTTPS redirect"), {
      packageScript: packageJson.scripts?.["verify:tls"] || null,
      checksCertificate: verifyTlsReadiness.includes("getPeerCertificate"),
      checksLegacyTls: verifyTlsReadiness.includes("TLS 1.0 and 1.1 are rejected")
    });

  pushCheck(checks, "TLS operations are documented without public HTTP bearer examples", httpsTlsOperations.includes("ACME_STAGING=1")
    && httpsTlsOperations.includes("ACME_STAGING=0")
    && httpsTlsOperations.includes("TLS_VERIFY_MODE=strict")
    && httpsTlsOperations.includes("certbot renew --dry-run")
    && httpsTlsOperations.includes("rotate")
    && !sportteryRelayDoc.includes("SPORTTERY_RELAY_PUSH_BASE_URL=http://134.175.132.183")
    && !sportteryRelayDoc.includes('curl -X POST "http://134.175.132.183')
    && !deployPowerShell.includes('Write-Host "ADMIN_TOKEN: $AdminToken"')
    && !deployPowerShell.includes("server_name your-domain.com"), {
      documentsStaging: httpsTlsOperations.includes("ACME_STAGING=1"),
      documentsProduction: httpsTlsOperations.includes("ACME_STAGING=0"),
      documentsRenewalDrill: httpsTlsOperations.includes("certbot renew --dry-run"),
      deployPrintsToken: deployPowerShell.includes('Write-Host "ADMIN_TOKEN: $AdminToken"')
    });

  pushCheck(checks, "nginx rate-limit zones", nginx.includes("limit_req_zone $binary_remote_addr zone=football_api") && nginx.includes("limit_req_zone $binary_remote_addr zone=football_admin"), {
    hasApiZone: nginx.includes("zone=football_api"),
    hasAdminZone: nginx.includes("zone=football_admin")
  });
  pushCheck(checks, "nginx owns the IPv4 and IPv6 default server", nginx.includes("listen 80 default_server;")
    && nginx.includes("listen [::]:80 default_server;"), {
    ipv4Default: nginx.includes("listen 80 default_server;"),
    ipv6Default: nginx.includes("listen [::]:80 default_server;")
  });

  pushCheck(checks, "nginx gzip enabled", nginx.includes("gzip on;") && nginx.includes("gzip_types") && nginx.includes("application/json"), {
    hasGzip: nginx.includes("gzip on;"),
    hasJsonType: nginx.includes("application/json")
  });

  pushCheck(checks, "nginx assets immutable only on successful responses", assets.includes("Cache-Control \"public, max-age=31536000, immutable\"")
    && !assets.includes("Cache-Control \"public, max-age=31536000, immutable\" always")
    && !assets.includes("expires "), {
    hasAssetsLocation: Boolean(assets),
    assets,
    hasDuplicateExpiresDirective: assets.includes("expires "),
    cachesErrorResponses: assets.includes("Cache-Control \"public, max-age=31536000, immutable\" always")
  });

  pushCheck(checks, "nginx static cache headers are emitted once and skip error responses", [media, contactQrCode, contactQr].every((location) => (
    location.includes("Cache-Control \"public, max-age=")
      && !/Cache-Control \"public, max-age=[^\"]+\" always/.test(location)
      && !location.includes("expires ")
  )), {
    media,
    contactQrCode,
    contactQr
  });

  pushCheck(checks, "nginx serves static assets without node upstream", nginx.includes("root /opt/football-predict/dist;")
    && assets.includes("try_files $uri =404")
    && !assets.includes("proxy_pass")
    && media.includes("try_files $uri =404")
    && contactQrCode.includes("try_files $uri =404")
    && contactQr.includes("try_files $uri =404"), {
      hasDistRoot: nginx.includes("root /opt/football-predict/dist;"),
      assetsDirect: assets.includes("try_files $uri =404") && !assets.includes("proxy_pass"),
      mediaDirect: media.includes("try_files $uri =404"),
      contactQrCodeDirect: contactQrCode.includes("try_files $uri =404"),
      contactQrDirect: contactQr.includes("try_files $uri =404")
    });

  pushCheck(checks, "source probes do not fall through to the SPA", nginxServerCommon.includes("location ~ (^|/)\\.")
    && nginxServerCommon.includes("package(?:-lock)?\\.json")
    && serverIndex.includes("blockedStaticSourceProbePaths = new Set")
    && serverIndex.includes('segment.startsWith(".")')
    && fs.existsSync(path.join(rootDir, "public", "robots.txt"))
    && fs.existsSync(path.join(rootDir, "public", "sitemap.xml")), {
      nginxDotfileBlock: nginxServerCommon.includes("location ~ (^|/)\\."),
      nodeSourceProbeBlock: serverIndex.includes("blockedStaticSourceProbePaths = new Set"),
      robotsExists: fs.existsSync(path.join(rootDir, "public", "robots.txt")),
      sitemapExists: fs.existsSync(path.join(rootDir, "public", "sitemap.xml"))
    });

  pushCheck(checks, "nginx runtime config no-store", runtimeConfig.includes("Cache-Control \"no-store\"") && runtimeConfig.includes("expires off"), {
    hasRuntimeLocation: Boolean(runtimeConfig),
    runtimeConfig
  });

  pushCheck(checks, "nginx data json no-store and limited", data.includes("Cache-Control \"no-store\"") && data.includes("limit_req zone=football_api"), {
    hasDataLocation: Boolean(data),
    data
  });

  pushCheck(checks, "nginx api and admin limited", api.includes("limit_req zone=football_api") && admin.includes("limit_req zone=football_admin"), {
    hasApiLimit: api.includes("limit_req zone=football_api"),
    hasAdminLimit: admin.includes("limit_req zone=football_admin")
  });

  pushCheck(checks, "nginx rate limits return 429", nginx.includes("limit_req_status 429;"), {
    limitReqStatus: nginx.includes("limit_req_status 429;") ? "429" : null
  });

  pushCheck(checks, "nginx relay snapshot upload accepts large admin payloads", nginx.includes("client_max_body_size 2m;")
    && relaySnapshotUpload.includes("client_max_body_size 32m")
    && relaySnapshotUpload.includes("limit_req zone=football_admin")
    && relaySnapshotUpload.includes("proxy_pass http://football_node"), {
      defaultClientMaxBodySize: nginx.includes("client_max_body_size 2m;") ? "2m" : null,
      hasRelaySnapshotLocation: Boolean(relaySnapshotUpload),
      relaySnapshotClientMaxBodySize: relaySnapshotUpload.includes("client_max_body_size 32m") ? "32m" : null,
      relaySnapshotAdminLimited: relaySnapshotUpload.includes("limit_req zone=football_admin")
    });

  const proxiedLocations = [runtimeConfig, data, events, relaySnapshotUpload, admin, api];
  pushCheck(checks, "nginx upstream keepalive to node API routes", nginx.includes("upstream football_node")
    && nginx.includes("keepalive 64")
    && proxiedLocations.every((location) => location.includes("proxy_pass http://football_node"))
    && proxiedLocations.every((location) => location.includes("proxy_set_header Connection \"\"")), {
      hasUpstream: nginx.includes("upstream football_node"),
      hasKeepalive: nginx.includes("keepalive 64"),
      locationsUseUpstream: proxiedLocations.filter((location) => location.includes("proxy_pass http://football_node")).length,
      locationsClearConnection: proxiedLocations.filter((location) => location.includes("proxy_set_header Connection \"\"")).length
    });

  const maintenanceFallback = normalize(extractLocation(nginxHttpCommon, "location / {"));
  pushCheck(checks, "nginx release transport fallback is loopback-only, bounded, and truthful", (
    nginxHttpCommon.includes("server 127.0.0.1:8788 max_fails=1 fail_timeout=1s;")
    && nginxHttpCommon.includes("server 127.0.0.1:8787 backup;")
    && nginxHttpCommon.includes("listen 127.0.0.1:8787;")
    && nginxHttpCommon.includes("server_name football_release_maintenance;")
    && maintenanceFallback.includes("return 503")
    && maintenanceFallback.includes("RELEASE_MAINTENANCE")
    && maintenanceFallback.includes("retryable")
    && maintenanceFallback.includes("Retry-After \"2\" always")
    && maintenanceFallback.includes("Cache-Control \"no-store\" always")
    && nginxServerCommon.includes("proxy_connect_timeout 1s;")
    && nginxServerCommon.includes("proxy_next_upstream error timeout;")
    && nginxServerCommon.includes("proxy_next_upstream_tries 2;")
    && nginxServerCommon.includes("proxy_next_upstream_timeout 2s;")
    && !nginxServerCommon.includes("proxy_intercept_errors on;")
  ), {
    primaryFailTimeoutSeconds: nginxHttpCommon.includes("fail_timeout=1s") ? 1 : null,
    connectFailoverBudgetSeconds: nginxServerCommon.includes("proxy_connect_timeout 1s;") ? 1 : null,
    maintenanceStatus: maintenanceFallback.includes("return 503") ? 503 : null,
    doesNotInterceptApplicationErrors: !nginxServerCommon.includes("proxy_intercept_errors on;")
  });

  pushCheck(checks, "nginx sse streaming", events.includes("proxy_buffering off") && events.includes("proxy_read_timeout 90s") && events.includes("limit_req zone=football_api"), {
    hasEventsLocation: Boolean(events),
    events
  });

  pushCheck(checks, "nginx html no-store", root.includes("Cache-Control \"no-store\"") && root.includes("expires off"), {
    hasRootLocation: Boolean(root),
    root
  });

  pushCheck(checks, "nginx SPA remains available without the node upstream", root.includes("try_files $uri $uri/ /index.html")
    && !root.includes("proxy_pass")
    && api.includes("proxy_pass http://football_node")
    && data.includes("proxy_pass http://football_node")
    && nginxServerCommon.includes("location = /matches.json {\n  return 410;")
    && nginxServerCommon.includes("location = /odds-history.json {\n  return 410;"), {
      rootUsesStaticFallback: root.includes("try_files $uri $uri/ /index.html"),
      rootBypassesNode: !root.includes("proxy_pass"),
      protectedApiStillUsesNode: api.includes("proxy_pass http://football_node"),
      protectedDataStillUsesNode: data.includes("proxy_pass http://football_node"),
      legacyRootPayloadsDisabled: nginxServerCommon.includes("location = /matches.json {\n  return 410;")
        && nginxServerCommon.includes("location = /odds-history.json {\n  return 410;")
    });

  pushCheck(checks, "env sqlite read source", keyValue(envExample, "DATASTORE_READ_SOURCE") === "sqlite"
    && keyValue(envExample, "ENABLE_SQLITE_EXPORT") === "1"
    && Number(keyValue(envExample, "SQLITE_READ_STALE_GRACE_SECONDS") || 0) >= 300
    && Number(keyValue(envExample, "V1_MATCH_DETAIL_CACHE_TTL_MS") || 0) >= 30000
    && serverIndex.includes("v1MatchPayloadCacheTtlMs"), {
    dataStoreReadSource: keyValue(envExample, "DATASTORE_READ_SOURCE") || null,
    enableSqliteExport: keyValue(envExample, "ENABLE_SQLITE_EXPORT") || null,
    sqlitePath: keyValue(envExample, "DATASTORE_SQLITE_PATH") || null,
    sqliteReadStaleGraceSeconds: keyValue(envExample, "SQLITE_READ_STALE_GRACE_SECONDS") || null,
    matchDetailCacheTtlMs: keyValue(envExample, "V1_MATCH_DETAIL_CACHE_TTL_MS") || null,
    serverUsesMatchDetailCacheTtl: serverIndex.includes("v1MatchPayloadCacheTtlMs")
  });

  pushCheck(checks, "env production store path is var-lib sqlite", keyValue(envExample, "SERVER_STORE_DIR") === "/var/lib/football-predict"
    && keyValue(envExample, "DATASTORE_SQLITE_PATH") === "/var/lib/football-predict/football.db"
    && keyValue(envExample, "SPORTTERY_RELAY_SNAPSHOT") === "/var/lib/football-predict/sporttery-relay-snapshot.json", {
      serverStoreDir: keyValue(envExample, "SERVER_STORE_DIR") || null,
      sqlitePath: keyValue(envExample, "DATASTORE_SQLITE_PATH") || null,
      relaySnapshot: keyValue(envExample, "SPORTTERY_RELAY_SNAPSHOT") || null
    });

  pushCheck(checks, "relay fast watcher is production-enabled and release-persistent",
    keyValue(envExample, "RELAY_FAST_WATCHER_ENABLED") === "1"
      && Number(keyValue(envExample, "RELAY_FAST_WATCHER_POLL_MS")) > 0
      && Number(keyValue(envExample, "RELAY_FAST_WATCHER_POLL_MS")) <= 5000
      && Number(keyValue(envExample, "RELAY_FAST_WATCHER_TIMEOUT_MS")) <= 8000
      && Number(keyValue(envExample, "TRUSTED_MAX_FUTURE_SKEW_SECONDS")) === 300
      && Number(keyValue(envExample, "SYNC_META_COMMIT_LOCK_WAIT_MS")) === 30000
      && Number(keyValue(envExample, "SYNC_META_COMMIT_LOCK_STALE_MS")) === 120000
      && keyValue(envExample, "RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER") === "1"
      && Number(keyValue(envExample, "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS")) <= 5000
      && Number(keyValue(envExample, "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS")) <= 30
      && serverIndex.includes("createRelayFastResultWatcher")
      && runtimeMonitor.includes('addCheck("fast result watcher"')
      && runtimeMonitor.includes("fastWatcherCheckAgeSeconds <= fastResultWatcherMaxCheckAgeSeconds")
      && runtimeMonitor.includes("Number(fastResultWatcher.pollMs || 0) <= fastResultWatcherMaxPollMs")
      && runtimeMonitor.includes("!fastResultWatcher.lastError")
      && releaseScript.includes('set_env_value "$env_file" "RELAY_FAST_WATCHER_ENABLED" "1"')
      && bundleReleaseScript.includes('set_env_value "$env_file" "RELAY_FAST_WATCHER_ENABLED" "1"')
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "RELAY_FAST_WATCHER_POLL_MS" "1000"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "TRUSTED_MAX_FUTURE_SKEW_SECONDS" "300"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "SYNC_META_COMMIT_LOCK_WAIT_MS" "30000"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "SYNC_META_COMMIT_LOCK_STALE_MS" "120000"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER" "1"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS" "5000"'))
      && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS" "30"')), {
      enabled: keyValue(envExample, "RELAY_FAST_WATCHER_ENABLED") || null,
      pollMs: keyValue(envExample, "RELAY_FAST_WATCHER_POLL_MS") || null,
      timeoutMs: keyValue(envExample, "RELAY_FAST_WATCHER_TIMEOUT_MS") || null,
      trustedMaxFutureSkewSeconds: keyValue(envExample, "TRUSTED_MAX_FUTURE_SKEW_SECONDS") || null,
      syncMetaCommitLockWaitMs: keyValue(envExample, "SYNC_META_COMMIT_LOCK_WAIT_MS") || null,
      syncMetaCommitLockStaleMs: keyValue(envExample, "SYNC_META_COMMIT_LOCK_STALE_MS") || null,
      monitorRequired: keyValue(envExample, "RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER") || null,
      monitorMaxPollMs: keyValue(envExample, "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS") || null,
      monitorMaxCheckAgeSeconds: keyValue(envExample, "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS") || null,
      releasePersistent: releaseScript.includes("RELAY_FAST_WATCHER_ENABLED"),
      bundleReleasePersistent: bundleReleaseScript.includes("RELAY_FAST_WATCHER_ENABLED"),
      runtimeMonitorCheck: runtimeMonitor.includes('addCheck("fast result watcher"')
    });

  pushCheck(checks, "local preview consumes the collector relay snapshot and enables fast results by default",
    startLocalPreview.includes('path.join(rootDir, ".codex-tmp", "sporttery-relay-snapshot.json")')
      && startLocalPreview.includes("fs.existsSync(collectorRelaySnapshotPath)")
      && startLocalPreview.includes("SPORTTERY_RELAY_SNAPSHOT: previewRelaySnapshotPath")
      && startLocalPreview.includes('RELAY_FAST_WATCHER_ENABLED: process.env.RELAY_FAST_WATCHER_ENABLED || "1"')
      && startLocalPreview.includes('RELAY_FAST_WATCHER_POLL_MS: process.env.RELAY_FAST_WATCHER_POLL_MS || "1000"')
      && startLocalPreview.includes("fastResultWatcher: health.sync?.fastResultWatcher || null"), {
      collectorSnapshot: ".codex-tmp/sporttery-relay-snapshot.json",
      explicitSnapshotOverride: startLocalPreview.includes("process.env.SPORTTERY_RELAY_SNAPSHOT"),
      watcherEnabledByDefault: startLocalPreview.includes('RELAY_FAST_WATCHER_ENABLED: process.env.RELAY_FAST_WATCHER_ENABLED || "1"'),
      watcherPollMs: 1000
    });

  pushCheck(checks, "env server-primary mode does not impersonate official-source redundancy", keyValue(envExample, "PRODUCTION_DATA_MODE") === "server-primary"
    && keyValue(envExample, "SERVER_DATA_PRIMARY") === "1"
    && keyValue(envExample, "LOCAL_DATA_PUSH_REQUIRED") === "0"
    && keyValue(envExample, "CLOUD_SYNC_REQUIRED") === "0"
    && keyValue(envExample, "SPORTTERY_RELAY_REQUIRED") === "0"
    && serverIndex.includes("assessOfficialSourceRedundancy")
    && serverIndex.includes("officialSourceSinglePoint")
    && sourceRedundancy.includes("successful-sync-transport")
    && sourceRedundancy.includes("fresh-egress-probe")
    && sourceRedundancy.includes("current-trusted-relay-snapshot")
    && sportteryRelayDoc.includes("not proof of source redundancy")
    && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "PRODUCTION_DATA_MODE" "server-primary"'))
    && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "LOCAL_DATA_PUSH_REQUIRED" "0"'))
    && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "CLOUD_SYNC_REQUIRED" "0"')), {
      productionDataMode: keyValue(envExample, "PRODUCTION_DATA_MODE") || null,
      serverDataPrimary: keyValue(envExample, "SERVER_DATA_PRIMARY") || null,
      localDataPushRequired: keyValue(envExample, "LOCAL_DATA_PUSH_REQUIRED") || null,
      cloudSyncRequired: keyValue(envExample, "CLOUD_SYNC_REQUIRED") || null,
      sportteryRelayRequired: keyValue(envExample, "SPORTTERY_RELAY_REQUIRED") || null,
      runtimeEvidenceBased: serverIndex.includes("assessOfficialSourceRedundancy"),
      releasePreservesMode: [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "PRODUCTION_DATA_MODE" "server-primary"'))
    });

  pushCheck(checks, "Windows Sporttery relay current/live lane defaults to one minute without overlapping runs",
    installSportteryRelayTask.includes("$DefaultIntervalMinutes = 1")
      && installSportteryRelayTask.includes("TASK_INSTANCES_IGNORE_NEW")
      && installSportteryRelayTask.includes("MultipleInstances = 2")
      && runSportteryRelayPush.includes('sporttery-relay.lock')
      && sportteryRelayDoc.includes("Interval: 1 minute for the current/live lane")
      && sportteryRelayDoc.includes("collector keeps full-history refreshes on its separate slower cadence")
      && installSportteryRelayTask.includes("StartWhenAvailable = $true")
      && installSportteryRelayTask.includes("DisallowStartIfOnBatteries = $false")
      && installSportteryRelayTask.includes("StopIfGoingOnBatteries = $false")
      && installSportteryRelayTask.includes("RestartCount = $RetryCount")
      && installSportteryRelayTask.includes("RestartInterval")
      && installSportteryRelayTask.includes("ExecutionTimeLimit")
      && installSportteryRelayTask.includes('FOOTBALL_RELAY_WAKE_TO_RUN -eq "1"')
      && installSportteryRelayTask.includes('FOOTBALL_RELAY_USE_S4U -eq "1"')
      && sportteryRelayDoc.includes("Wake policy: disabled by default")
      && sportteryRelayDoc.includes("S4U is never selected implicitly"), {
      defaultIntervalMinutes: installSportteryRelayTask.includes("$DefaultIntervalMinutes = 1") ? 1 : null,
      ignoresOverlappingTriggers: installSportteryRelayTask.includes("MultipleInstances = 2"),
      wrapperLock: runSportteryRelayPush.includes('sporttery-relay.lock'),
      fullHistoryCadenceIndependent: sportteryRelayDoc.includes("collector keeps full-history refreshes on its separate slower cadence"),
      startWhenAvailable: installSportteryRelayTask.includes("StartWhenAvailable = $true"),
      batterySafe: installSportteryRelayTask.includes("StopIfGoingOnBatteries = $false"),
      wakeOptIn: installSportteryRelayTask.includes('FOOTBALL_RELAY_WAKE_TO_RUN -eq "1"'),
      s4uOptIn: installSportteryRelayTask.includes('FOOTBALL_RELAY_USE_S4U -eq "1"')
    });

  pushCheck(checks, "bearer upload paths require HTTPS outside loopback", envExample.includes("FOOTBALL_CLOUD_API_BASE=https://your-server")
    && cloudPush.includes('`https://${cloudHost}`')
    && cloudPush.includes("refusing to send bearer credentials to a non-HTTPS public origin")
    && sportteryRelayPush.includes("refusing to send bearer credentials to a non-HTTPS public origin")
    && runSportteryRelayPush.includes('"https://$($env:FOOTBALL_CLOUD_HOST)"')
    && runSportteryRelayPush.includes('"https://134.175.132.183"'), {
      envExampleHttps: envExample.includes("FOOTBALL_CLOUD_API_BASE=https://your-server"),
      cloudPushGuarded: cloudPush.includes("refusing to send bearer credentials"),
      relayPushGuarded: sportteryRelayPush.includes("refusing to send bearer credentials"),
      relayTaskDefaultsHttps: runSportteryRelayPush.includes("https://134.175.132.183")
    });

  pushCheck(checks, "sporttery proxy helper is safe and verifiable", Boolean(packageJson.scripts?.["configure:sporttery-proxy"])
    && configureSportteryProxy.includes("SPORTTERY_OUTBOUND_PROXY")
    && configureSportteryProxy.includes("sporttery-relay.env")
    && configureSportteryProxy.includes("maskProxy")
    && configureSportteryProxy.includes("verifySportteryRelayProxy.cjs")
    && configureSportteryProxy.includes("socks5h:")
    && configureSportteryProxy.includes("writeEnvFile"), {
      hasPackageScript: Boolean(packageJson.scripts?.["configure:sporttery-proxy"]),
      masksProxy: configureSportteryProxy.includes("maskProxy"),
      verifiesProxy: configureSportteryProxy.includes("verifySportteryRelayProxy.cjs"),
      writesRelayEnv: configureSportteryProxy.includes("sporttery-relay.env"),
      supportsSocks5h: configureSportteryProxy.includes("socks5h:")
    });

  pushCheck(checks, "env source sync cadence", Number(keyValue(envExample, "SYNC_INTERVAL_SECONDS")) <= 300
    && Number(keyValue(envExample, "HOT_SYNC_INTERVAL_SECONDS")) <= 120
    && Number(keyValue(envExample, "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS")) >= 300
    && Number(keyValue(envExample, "SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES")) >= 60
    && Number(keyValue(envExample, "CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES")) >= 120
    && releaseScript.includes('set_env_value "$env_file" "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS" "300"')
    && bundleReleaseScript.includes('set_env_value "$env_file" "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS" "300"')
    && releaseScript.includes('set_env_value "$env_file" "SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES" "60"')
    && bundleReleaseScript.includes('set_env_value "$env_file" "SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES" "60"')
    && releaseScript.includes('set_env_value "$env_file" "CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES" "120"')
    && bundleReleaseScript.includes('set_env_value "$env_file" "CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES" "120"'), {
    syncIntervalSeconds: keyValue(envExample, "SYNC_INTERVAL_SECONDS") || null,
    hotSyncIntervalSeconds: keyValue(envExample, "HOT_SYNC_INTERVAL_SECONDS") || null,
    postDeadlineHotSyncIntervalSeconds:
      keyValue(envExample, "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS") || null,
    slowPhaseMinIntervalMinutes:
      keyValue(envExample, "SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES") || null,
    candidateDeadlineHotWindowMinutes:
      keyValue(envExample, "CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES") || null
  });

  const openResearchGateway = readText(path.join(rootDir, "server", "openResearchGateway.cjs"));
  const openResearchSync = readText(path.join(rootDir, "scripts", "syncOpenResearchSignals.cjs"));
  const freeFootballSync = readText(path.join(rootDir, "scripts", "syncFreeFootballSignals.cjs"));
  const syncWorker = readText(path.join(rootDir, "scripts", "runSyncWorker.cjs"));
  pushCheck(checks, "free/open research gateway is bounded, protected, and release-persistent",
    packageJson.scripts?.["sync:open-research"] === "node scripts/syncOpenResearchSignals.cjs"
      && packageJson.scripts?.["verify:open-research-gateway"] === "node scripts/verifyOpenResearchGateway.cjs"
      && packageJson.scripts?.["sync:free-football"] === "node scripts/syncFreeFootballSignals.cjs"
      && packageJson.scripts?.["verify:free-football-signals"] === "node scripts/verifyFreeFootballSignals.cjs"
      && keyValue(envExample, "ENABLE_OPEN_RESEARCH_SYNC") === "1"
      && keyValue(envExample, "ENABLE_WEB_CONSENSUS_SYNC") === "1"
      && keyValue(envExample, "ENABLE_API_FOOTBALL_SYNC") === "0"
      && keyValue(envExample, "API_FOOTBALL_SYNC_MODE") === "shadow-enrichment"
      && keyValue(envExample, "API_FOOTBALL_KEY") === ""
      && keyValue(envExample, "API_FOOTBALL_INJURIES_ENABLED") === "1"
      && keyValue(envExample, "API_FOOTBALL_LINEUPS_ENABLED") === "1"
      && keyValue(envExample, "API_FOOTBALL_LIVE_SCORE_ENABLED") === "1"
      && keyValue(envExample, "API_FOOTBALL_ODDS_ENABLED") === "0"
      && Number(keyValue(envExample, "API_FOOTBALL_MAX_CALLS_PER_SYNC")) > 0
      && Number(keyValue(envExample, "API_FOOTBALL_MAX_CALLS_PER_SYNC")) <= 35
      && keyValue(envExample, "ENABLE_FREE_FOOTBALL_SYNC") === "1"
      && Number(keyValue(envExample, "WEB_CONSENSUS_REFRESH_MINUTES")) >= 15
      && Number(keyValue(envExample, "OPEN_RESEARCH_MAX_MATCHES")) > 0
      && Number(keyValue(envExample, "OPEN_RESEARCH_MAX_MATCHES")) <= 4
      && Number(keyValue(envExample, "OPEN_RESEARCH_MAX_RESULTS")) <= 8
      && Number(keyValue(envExample, "OPEN_RESEARCH_MAX_CONCURRENCY")) <= 2
      && Number(keyValue(envExample, "OPEN_RESEARCH_REFRESH_MINUTES")) >= 15
      && Number(keyValue(envExample, "SYNC_WORKER_MIN_IDLE_SECONDS")) >= 10
      && keyValue(envExample, "OPEN_RESEARCH_CONTACT_URL").startsWith("https://")
      && bundleReleaseScript.includes('set_env_value "$env_file" "ENABLE_OPEN_RESEARCH_SYNC" "1"')
      && releaseScript.includes("if ! grep -q '^ENABLE_API_FOOTBALL_SYNC=' \"$env_file\"; then")
      && releaseScript.includes('set_env_value "$env_file" "ENABLE_API_FOOTBALL_SYNC" "0"')
      && releaseScript.includes('set_env_value "$env_file" "ENABLE_FREE_FOOTBALL_SYNC" "1"')
      && bundleReleaseScript.includes("if ! grep -q '^ENABLE_API_FOOTBALL_SYNC=' \"$env_file\"; then")
      && bundleReleaseScript.includes('set_env_value "$env_file" "ENABLE_API_FOOTBALL_SYNC" "0"')
      && bundleReleaseScript.includes('set_env_value "$env_file" "ENABLE_FREE_FOOTBALL_SYNC" "1"')
      && bundleReleaseScript.includes('set_env_value "$env_file" "OPEN_RESEARCH_MAX_CONCURRENCY" "2"')
      && bundleReleaseScript.includes('set_env_value "$env_file" "SYNC_WORKER_MIN_IDLE_SECONDS" "10"')
      && bundleReleaseScript.includes('case "${PUBLIC_BASE_URL:-}" in')
      && bundleReleaseScript.includes('https://*)')
      && bundleReleaseScript.includes('set_env_value "$env_file" "OPEN_RESEARCH_CONTACT_URL" "$PUBLIC_BASE_URL"')
      && bundleReleaseScript.includes('preserve OPEN_RESEARCH_CONTACT_URL because public origin is not HTTPS')
      && syncWorker.indexOf('"sync:open-research"') >= 0
      && syncWorker.lastIndexOf('"sync:web-consensus"') > syncWorker.lastIndexOf('"sync:open-research"')
      && syncWorker.lastIndexOf('"sync:free-football"') > syncWorker.lastIndexOf('"sync:web-consensus"')
      && syncWorker.lastIndexOf('"sync:prematch"') > syncWorker.lastIndexOf('"sync:free-football"')
      && packageJson.scripts?.["sync:api-football"] === "node scripts/syncApiFootballData.cjs"
      && syncWorker.includes('runEnrichment(apiFootballRuntimePolicy.enabled, "sync:api-football")')
      && syncWorker.includes("apiFootballRuntimePolicyFor(process.env)")
      && serverIndex.includes("apiFootballRuntimePolicyFor(process.env)")
      && serverIndex.includes("const enableApiFootballSync = apiFootballRuntimePolicy.enabled")
      && !serverIndex.includes("const enableApiFootballSync = false")
      && apiFootballSync.includes("apiFootballRuntimePolicyFor")
      && apiFootballRuntimePolicy.includes('rawSwitch === "1"')
      && apiFootballRuntimePolicy.includes("mode === API_FOOTBALL_SHADOW_MODE")
      && apiFootballRuntimePolicy.includes("requested && modeSupported && configured")
      && apiFootballRuntimePolicy.includes('odds: env.API_FOOTBALL_ODDS_ENABLED === "1"')
      && apiFootballRuntimePolicy.includes("formalRecommendation: false")
      && apiFootballRuntimePolicy.includes("officialResult: false")
      && apiFootballRuntimePolicy.includes("settlement: false")
      && syncWorker.includes("const postCycleRelayBaseline = relaySnapshotFingerprint()")
      && syncWorker.includes("baseline: postCycleRelayBaseline")
      && serverIndex.includes('"/api/v1/research/search"')
      && serverIndex.includes('"/api/v1/research/status"')
      && serverIndex.includes("consumeOpenResearchRateToken")
      && openResearchGateway.includes('redirect: "error"')
      && openResearchGateway.includes("URL_QUERY_REJECTED")
      && openResearchSync.includes('usableForModel: false')
      && openResearchSync.includes('eligibleForNumericModel: false')
      && freeFootballSync.includes("zeroKeyRequired: true")
      && freeFootballSync.includes('postCutoffMutationAllowed: false'), {
      apiFootballEnabled: keyValue(envExample, "ENABLE_API_FOOTBALL_SYNC") || null,
      apiFootballSyncMode: keyValue(envExample, "API_FOOTBALL_SYNC_MODE") || null,
      apiFootballInjuriesEnabled: keyValue(envExample, "API_FOOTBALL_INJURIES_ENABLED") || null,
      apiFootballLineupsEnabled: keyValue(envExample, "API_FOOTBALL_LINEUPS_ENABLED") || null,
      apiFootballLiveScoreEnabled: keyValue(envExample, "API_FOOTBALL_LIVE_SCORE_ENABLED") || null,
      apiFootballOddsEnabled: keyValue(envExample, "API_FOOTBALL_ODDS_ENABLED") || null,
      apiFootballMaxCallsPerSync: Number(keyValue(envExample, "API_FOOTBALL_MAX_CALLS_PER_SYNC")) || null,
      apiFootballServerRuntimeOptIn: serverIndex.includes("const enableApiFootballSync = apiFootballRuntimePolicy.enabled"),
      apiFootballShadowOnly: apiFootballRuntimePolicy.includes("formalRecommendation: false")
        && apiFootballRuntimePolicy.includes("officialResult: false")
        && apiFootballRuntimePolicy.includes("settlement: false"),
      freeFootballEnabled: keyValue(envExample, "ENABLE_FREE_FOOTBALL_SYNC") || null,
      freeFootballZeroKey: freeFootballSync.includes("zeroKeyRequired: true"),
      enabled: keyValue(envExample, "ENABLE_OPEN_RESEARCH_SYNC") || null,
      maxMatches: keyValue(envExample, "OPEN_RESEARCH_MAX_MATCHES") || null,
      maxResults: keyValue(envExample, "OPEN_RESEARCH_MAX_RESULTS") || null,
      maxConcurrency: keyValue(envExample, "OPEN_RESEARCH_MAX_CONCURRENCY") || null,
      refreshMinutes: keyValue(envExample, "OPEN_RESEARCH_REFRESH_MINUTES") || null,
      contactUrl: keyValue(envExample, "OPEN_RESEARCH_CONTACT_URL") || null,
      webConsensusRefreshMinutes: keyValue(envExample, "WEB_CONSENSUS_REFRESH_MINUTES") || null,
      workerMinIdleSeconds: keyValue(envExample, "SYNC_WORKER_MIN_IDLE_SECONDS") || null,
      openResearchContactRequiresHttps: bundleReleaseScript.includes('case "${PUBLIC_BASE_URL:-}" in')
        && bundleReleaseScript.includes('https://*)'),
      apiProtected: serverIndex.includes('"/api/v1/research/search"'),
      paywallFetchDisabled: openResearchGateway.includes("URL_QUERY_REJECTED")
    });

  pushCheck(checks, "production sync cannot rewrite static application assets",
    keyValue(envExample, "MIRROR_PUBLISHED_DATA_TO_DIST") === "0"
      && keyValue(envExample, "WRITE_LEGACY_STATIC_PAYLOADS") === "0"
      && releaseScript.includes('"MIRROR_PUBLISHED_DATA_TO_DIST" "0"')
      && releaseScript.includes('"WRITE_LEGACY_STATIC_PAYLOADS" "0"')
      && bundleReleaseScript.includes('"MIRROR_PUBLISHED_DATA_TO_DIST" "0"')
      && bundleReleaseScript.includes('"WRITE_LEGACY_STATIC_PAYLOADS" "0"'), {
      mirrorPublishedDataToDist: keyValue(envExample, "MIRROR_PUBLISHED_DATA_TO_DIST"),
      writeLegacyStaticPayloads: keyValue(envExample, "WRITE_LEGACY_STATIC_PAYLOADS")
    });

  pushCheck(checks, "env fallback serviceability mode", keyValue(envExample, "SOURCE_STRICT_PRIMARY_HEALTH") === "0"
    && serverIndex.includes("SOURCE_STRICT_PRIMARY_HEALTH")
    && serverIndex.includes("500 fallback serviceable")
    && releaseScript.includes('set_env_value "$env_file" "SOURCE_STRICT_PRIMARY_HEALTH" "0"')
    && bundleReleaseScript.includes('set_env_value "$env_file" "SOURCE_STRICT_PRIMARY_HEALTH" "0"'), {
      sourceStrictPrimaryHealth: keyValue(envExample, "SOURCE_STRICT_PRIMARY_HEALTH") || null,
      serverHasFallbackWarning: serverIndex.includes("500 fallback serviceable"),
      releasePreservesMode: releaseScript.includes('set_env_value "$env_file" "SOURCE_STRICT_PRIMARY_HEALTH" "0"'),
      bundleReleasePreservesMode: bundleReleaseScript.includes('set_env_value "$env_file" "SOURCE_STRICT_PRIMARY_HEALTH" "0"')
    });

  pushCheck(checks, "overseas server disables Sporttery direct fetch but keeps relay", keyValue(envExample, "SKIP_SPORTTERY_FETCH") === "0"
    && keyValue(envExample, "SKIP_SPORTTERY_DIRECT_FETCH") === "1"
    && keyValue(envExample, "SPORTTERY_DIRECT_FETCH") === "0"
    && serverIndex.includes("skipSportteryDirectFetch")
    && serverIndex.includes("direct-disabled")
    && syncData.includes("SKIP_SPORTTERY_DIRECT_FETCH")
    && syncData.includes("direct-disabled")
    && releaseScript.includes('set_env_value "$env_file" "SKIP_SPORTTERY_DIRECT_FETCH" "1"')
    && bundleReleaseScript.includes('set_env_value "$env_file" "SKIP_SPORTTERY_DIRECT_FETCH" "1"'), {
      skipSportteryFetch: keyValue(envExample, "SKIP_SPORTTERY_FETCH") || null,
      skipSportteryDirectFetch: keyValue(envExample, "SKIP_SPORTTERY_DIRECT_FETCH") || null,
      sportteryDirectFetch: keyValue(envExample, "SPORTTERY_DIRECT_FETCH") || null,
      serverWritesDisabledStatus: serverIndex.includes("direct-disabled"),
      releasePreservesMode: releaseScript.includes('set_env_value "$env_file" "SKIP_SPORTTERY_DIRECT_FETCH" "1"'),
      bundleReleasePreservesMode: bundleReleaseScript.includes('set_env_value "$env_file" "SKIP_SPORTTERY_DIRECT_FETCH" "1"')
    });

  pushCheck(checks, "sporttery relay fast/full upload policy preserves archive coverage", keyValue(envExample, "SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT") === "1"
    && keyValue(envExample, "SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT") === "1"
    && keyValue(envExample, "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES") === "10"
    && keyValue(envExample, "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES") === "60"
    && keyValue(envExample, "SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD") === "0"
    && sportteryRelayPush.includes("SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT")
    && sportteryRelayPush.includes("SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT")
    && sportteryRelayPush.includes("SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES")
    && sportteryRelayPush.includes("SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES")
    && sportteryRelayPush.includes("backoffCurrentLaneProbeMinutes")
    && sportteryRelayPush.includes("nextBackoffCurrentLaneProbeAt")
    && sportteryRelayPush.includes("deferred-until-bounded-current-probe")
    && sportteryRelayPush.includes("shouldAttemptBackoffCurrentLane")
    && sportteryRelayPush.includes("suppressed-during-waf-cooldown")
    && sportteryRelayPush.includes("SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD")
    && sportteryRelayPush.includes("partial-live-upload-disabled")
    && sportteryRelayPush.includes("backoff current-lane collect")
    && sportteryRelayPush.includes("allowPartialLiveUpload")
    && sportteryRelayPush.includes("realFullCollectionSucceeded")
    && sportteryRelayPush.includes("resolveEffectiveUploadMode")
    && sportteryRelayPush.includes('const compactMethods = new Set(["current", "calculator"])')
    && sportteryRelayPush.includes('method !== "result"')
    && sportteryRelayPush.includes("page === 1")
    && sportteryRelayPush.includes("successful periodic full collection is uploaded in full over HTTP")
    && verifySportteryRelayFullRecovery.includes("complete full upload restores archive in its independent file")
    && verifySportteryRelayFullRecovery.includes("fast upload after full keeps the full archive byte-identical")
    && verifySportteryRelayDualLaneServer.includes("full upload is an atomic replacement without merge")
    && verifySportteryRelayDualLaneServer.includes("fast upload cannot modify full file")
    && verifySportteryRelayDualLaneServer.includes("fast endpoint rejects same-key clock regression")
    && serverIndex.includes("relayFullSnapshotValidation")
    && serverIndex.includes("relayFastLaneValidation")
    && serverIndex.includes("RELAY_FAST_LANE_MONOTONICITY_REJECTED")
    && nginxServerCommon.includes("location = /api/admin/sporttery-relay-fast-lane")
    && keyValue(envExample, "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT") === "/var/lib/football-predict/sporttery-relay-fast-lane.json"
    && releaseScript.includes("SPORTTERY_RELAY_FAST_LANE_SNAPSHOT")
    && bundleReleaseScript.includes("SPORTTERY_RELAY_FAST_LANE_SNAPSHOT")
    && packageJson.scripts?.["verify:sporttery-relay-full-recovery"] === "node scripts/verifySportteryRelayFullRecovery.cjs"
    && packageJson.scripts?.["verify:sporttery-relay-dual-server"] === "node scripts/verifySportteryRelayDualLaneServer.cjs"
    && readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT=1")
    && readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT=1")
    && readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES=10")
    && readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES=60")
    && readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=0"), {
      envDefault: keyValue(envExample, "SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT") || null,
      wafBackoffCurrentDefault:
        keyValue(envExample, "SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT") || null,
      wafCurrentProbeMinutes:
        keyValue(envExample, "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES") || null,
      wafCurrentProbeMaxMinutes:
        keyValue(envExample, "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES") || null,
      partialUploadDefault: keyValue(envExample, "SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD") || null,
      scriptKeepsCurrentLane: sportteryRelayPush.includes("backoff current-lane collect"),
      scriptBlocksPartialUploadByDefault: sportteryRelayPush.includes("partial-live-upload-disabled"),
      fastUploadIsCurrentAndResultHeadOnly: sportteryRelayPush.includes('const compactMethods = new Set(["current", "calculator"])')
        && sportteryRelayPush.includes("page === 1"),
      periodicFullHttpRecovery: sportteryRelayPush.includes("successful periodic full collection is uploaded in full over HTTP"),
      hasFullRecoveryVerifier: Boolean(packageJson.scripts?.["verify:sporttery-relay-full-recovery"]),
      hasDualLaneServerVerifier: Boolean(packageJson.scripts?.["verify:sporttery-relay-dual-server"]),
      fastLanePath: keyValue(envExample, "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT") || null,
      nginxFastLaneEndpoint: nginxServerCommon.includes("location = /api/admin/sporttery-relay-fast-lane"),
      docsDescribeCurrentLane: readText(sportteryRelayDocPath).includes("current/calculator lane"),
      docsDescribePartialUploadSwitch: readText(sportteryRelayDocPath).includes("SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=0")
    });

  pushCheck(checks, "source health distinguishes trusted fallback from partial live", serverIndex.includes("effectiveTrustLevel")
    && serverIndex.includes("trusted-fallback")
    && serverIndex.includes("partial live snapshots are not overwriting the source"), {
      hasEffectiveTrustLevel: serverIndex.includes("effectiveTrustLevel"),
      hasTrustedFallbackLevel: serverIndex.includes("trusted-fallback"),
      suppressesPartialLiveWarning: serverIndex.includes("partial live snapshots are not overwriting the source")
    });

  pushCheck(checks, "relay uploads do not run heavyweight sync in API by default",
    sportteryRelayPush.includes('SPORTTERY_RELAY_RUN_SYNC === "1"')
    && sportteryRelayPush.includes('argv.has("--run-sync")')
    && cloudPush.includes('FOOTBALL_CLOUD_RELAY_RUN_SYNC === "1"')
    && !cloudPush.includes("sporttery-relay-snapshot?runSync=1")
    && readText(sportteryRelayDocPath).includes("FOOTBALL_CLOUD_RELAY_RUN_SYNC")
    && readText(sportteryRelayDocPath).includes("API process does not run heavyweight sync work"), {
      relayPushExplicitRunSync: sportteryRelayPush.includes('SPORTTERY_RELAY_RUN_SYNC === "1"'),
      relayPushCliOverride: sportteryRelayPush.includes('argv.has("--run-sync")'),
      cloudPushExplicitRunSync: cloudPush.includes('FOOTBALL_CLOUD_RELAY_RUN_SYNC === "1"'),
      cloudPushHardcodedRunSyncRemoved: !cloudPush.includes("sporttery-relay-snapshot?runSync=1")
    });

  pushCheck(checks, "env model backtest catches up after sqlite sync", keyValue(envExample, "ENABLE_MODEL_BACKTEST_ON_SYNC") === "1"
    && Number(keyValue(envExample, "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES")) >= 120
    && Number(keyValue(envExample, "MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO")) >= 0.98, {
      enableModelBacktestOnSync: keyValue(envExample, "ENABLE_MODEL_BACKTEST_ON_SYNC") || null,
      modelBacktestMinIntervalMinutes: keyValue(envExample, "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES") || null,
      modelCoverageTriggerRatio: keyValue(envExample, "MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO") || null
    });

  pushCheck(checks, "release keeps a bounded calibration odds window", Number(keyValue(envExample, "ODDS_HISTORY_RETENTION_DAYS")) >= 14
    && [releaseScript, bundleReleaseScript].every((text) => text.includes('set_env_value "$env_file" "ODDS_HISTORY_RETENTION_DAYS" "14"')
      && text.includes('COMPACT_RETENTION_DAYS="${ODDS_HISTORY_RETENTION_DAYS:-14}"'))
    && releaseScript.includes("process.env.COMPACT_RETENTION_DAYS || 14")
    && compactPublicOddsHistory.includes("process.env.COMPACT_RETENTION_DAYS || 14"), {
      retentionDays: keyValue(envExample, "ODDS_HISTORY_RETENTION_DAYS") || null,
      releaseUsesFourteenDays: releaseScript.includes('COMPACT_RETENTION_DAYS="${ODDS_HISTORY_RETENTION_DAYS:-14}"'),
      bundleReleaseUsesFourteenDays: bundleReleaseScript.includes('COMPACT_RETENTION_DAYS="${ODDS_HISTORY_RETENTION_DAYS:-14}"')
    });

  pushCheck(checks, "release scripts preserve model backtest catch-up env", ["ENABLE_MODEL_BACKTEST_ON_SYNC", "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES", "MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO"].every((key) => releaseScript.includes(`set_env_value "$env_file" "${key}"`))
    && ["ENABLE_MODEL_BACKTEST_ON_SYNC", "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES", "MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO"].every((key) => bundleReleaseScript.includes(`set_env_value "$env_file" "${key}"`)), {
      releaseHasModelCatchup: releaseScript.includes('set_env_value "$env_file" "ENABLE_MODEL_BACKTEST_ON_SYNC"'),
      bundleReleaseHasModelCatchup: bundleReleaseScript.includes('set_env_value "$env_file" "ENABLE_MODEL_BACKTEST_ON_SYNC"')
    });

  const releaseRunsModelCatchupCommands = (text) => (
    (text.includes("npm run model:backtest") || text.includes('"$NODE_HOME/bin/npm" run model:backtest'))
    && (text.includes("npm run optimize:strategy") || text.includes('"$NODE_HOME/bin/npm" run optimize:strategy'))
  );
  pushCheck(checks, "release scripts mirror public model artifacts to store", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes("sync_model_artifact_mirrors")
    && text.includes("run_model_artifact_catchup")
    && releaseRunsModelCatchupCommands(text)
    && text.includes('local public_data_dir="${app_dir}/public/data"')
    && text.includes('"${public_data_dir}/model-strategy.json"')
    && text.includes('"${public_data_dir}/model-evaluation.json"')
    && text.includes("model-artifacts/evaluation.json")
  )) && releaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$NEXT_DIR"')
    && bundleReleaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$BUILD_DIR"')
    && releaseScript.includes('sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR"')
    && bundleReleaseScript.includes('sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR"'), {
    releaseMirrorsEvaluation: releaseScript.includes("model-artifacts/evaluation.json"),
    bundleReleaseMirrorsEvaluation: bundleReleaseScript.includes("model-artifacts/evaluation.json"),
    releaseMirrorsStrategy: releaseScript.includes('"${public_data_dir}/model-strategy.json"'),
    bundleReleaseMirrorsStrategy: bundleReleaseScript.includes('"${public_data_dir}/model-strategy.json"'),
    releaseRunsBacktestCatchup: releaseScript.includes("run_model_artifact_catchup") && releaseRunsModelCatchupCommands(releaseScript),
    bundleReleaseRunsBacktestCatchup: bundleReleaseScript.includes("run_model_artifact_catchup") && releaseRunsModelCatchupCommands(bundleReleaseScript),
    releaseCandidateMirrorRoot: releaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$NEXT_DIR"'),
    bundleCandidateMirrorRoot: bundleReleaseScript.includes('sync_model_artifact_mirrors "$store_dir" "$BUILD_DIR"'),
    releaseLiveMirrorBeforeReadiness: releaseScript.includes('sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR"'),
    bundleLiveMirrorBeforeReadiness: bundleReleaseScript.includes('sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR"')
  });

  const bundleLiveCatchupStart = bundleReleaseScript.indexOf("run_model_artifact_catchup() {");
  const bundleCandidateCatchupStart = bundleReleaseScript.indexOf("run_candidate_model_artifact_catchup() {");
  const bundleCandidateCatchupEnd = bundleReleaseScript.indexOf("prepare_candidate_llm_cache() {", bundleCandidateCatchupStart);
  const bundleLiveCatchup = bundleReleaseScript.slice(bundleLiveCatchupStart, bundleCandidateCatchupStart);
  const bundleCandidateCatchup = bundleReleaseScript.slice(bundleCandidateCatchupStart, bundleCandidateCatchupEnd);
  const bundleDeferredCatchupStart = bundleReleaseScript.indexOf('log "run deferred model catchup while the healthy HTTP service remains available"');
  const bundleDeferredCatchupEnd = bundleReleaseScript.indexOf('WORKER_RELEASE_STARTED_AT=', bundleDeferredCatchupStart);
  const bundleDeferredCatchup = bundleReleaseScript.slice(bundleDeferredCatchupStart, bundleDeferredCatchupEnd);
  const runtimeEnvCatchupCalls = (bundleLiveCatchup.match(/run_as_service_user_with_runtime_env env/g) || []).length;
  const candidateDatastoreIndex = bundleCandidateCatchup.indexOf("run_build_step candidate-datastore-reconciled");
  const candidateDeadlineCaptureIndex = bundleCandidateCatchup.indexOf("run_build_step candidate-deadline-capture");
  pushCheck(checks, "live deferred model catchup inherits the production runtime env without exposing it to candidates", bundleLiveCatchupStart >= 0
    && bundleCandidateCatchupStart > bundleLiveCatchupStart
    && bundleCandidateCatchupEnd > bundleCandidateCatchupStart
    && runtimeEnvCatchupCalls === 2
    && bundleLiveCatchup.includes('"$NODE_HOME/bin/npm" run model:backtest')
    && bundleLiveCatchup.includes('"$NODE_HOME/bin/npm" run optimize:strategy')
    && !bundleCandidateCatchup.includes("run_as_service_user_with_runtime_env")
    && bundleCandidateCatchup.includes("run_build_step model-backtest")
    && bundleCandidateCatchup.includes("run_build_step optimize-strategy")
    && bundleDeferredCatchupStart >= 0
    && bundleDeferredCatchupEnd > bundleDeferredCatchupStart
    && bundleDeferredCatchup.includes("run_as_service_user_with_runtime_env env SERVER_STORE_DIR=\"$LIVE_STORE_DIR\"")
    && bundleDeferredCatchup.includes("SQLITE_VACUUM_AFTER_EXPORT=0")
    && bundleDeferredCatchup.includes("npm run datastore:sqlite")
    && bundleReleaseScript.includes('set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"'), {
      runtimeEnvCatchupCalls,
      liveUsesPinnedNpm: bundleLiveCatchup.includes('"$NODE_HOME/bin/npm" run model:backtest')
        && bundleLiveCatchup.includes('"$NODE_HOME/bin/npm" run optimize:strategy'),
      candidateLoadsRuntimeEnv: bundleCandidateCatchup.includes("run_as_service_user_with_runtime_env"),
      candidateUsesIsolatedBuildSteps: bundleCandidateCatchup.includes("run_build_step model-backtest")
        && bundleCandidateCatchup.includes("run_build_step optimize-strategy"),
      deferredReconciliationExportLoadsRuntimeEnv: bundleDeferredCatchup.includes("run_as_service_user_with_runtime_env env SERVER_STORE_DIR=\"$LIVE_STORE_DIR\"")
        && bundleDeferredCatchup.includes("SQLITE_VACUUM_AFTER_EXPORT=0")
        && bundleDeferredCatchup.includes("npm run datastore:sqlite"),
      nodeOptionsConfigured: bundleReleaseScript.includes('set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"')
    });

  pushCheck(checks, "candidate release refreshes the exact-revision deadline heartbeat before API readiness", candidateDatastoreIndex >= 0
    && candidateDeadlineCaptureIndex > candidateDatastoreIndex
    && bundleCandidateCatchup.includes('"$NODE_HOME/bin/node" scripts/captureCandidateProspectiveDeadline.cjs --deadline-only')
    && bundleCandidateCatchup.includes('SERVER_STORE_DIR="$store_dir"')
    && bundleCandidateCatchup.includes('DATASTORE_SQLITE_PATH="$sqlite_path"'), {
      candidateDatastoreIndex,
      candidateDeadlineCaptureIndex,
      runsExactRevisionDeadlineCapture: bundleCandidateCatchup.includes('"$NODE_HOME/bin/node" scripts/captureCandidateProspectiveDeadline.cjs --deadline-only'),
      usesCandidateStore: bundleCandidateCatchup.includes('SERVER_STORE_DIR="$store_dir"'),
      usesCandidateSqlite: bundleCandidateCatchup.includes('DATASTORE_SQLITE_PATH="$sqlite_path"')
    });

  const workerOwnedCatchupGate = bundleReleaseScript.indexOf(
    'if [ "${RELEASE_MODEL_CATCHUP_IN_MANDATORY_WORKER:-1}" = "1" ]; then'
  );
  const workerOwnedCatchupLog = bundleReleaseScript.indexOf(
    'log "defer live model catchup to the mandatory release worker cycle"'
  );
  const releaseWorkerStartMarker = bundleReleaseScript.indexOf("WORKER_RELEASE_STARTED_AT=");
  pushCheck(checks, "signed release defaults live model catchup to its mandatory verified worker cycle",
    workerOwnedCatchupGate >= 0
      && workerOwnedCatchupLog > workerOwnedCatchupGate
      && releaseWorkerStartMarker > workerOwnedCatchupLog
      && bundleReleaseScript.includes("wait_for_worker_official_publish_after")
      && bundleReleaseScript.includes("wait_for_worker_readiness_idle_after")
      && bundleReleaseScript.includes("freeze_worker_for_readiness"), {
      defaultsToWorkerOwnedCatchup: workerOwnedCatchupGate >= 0,
      logsWorkerOwnership: workerOwnedCatchupLog > workerOwnedCatchupGate,
      mandatoryWorkerFollows: releaseWorkerStartMarker > workerOwnedCatchupLog,
      verifiesOfficialPublication: bundleReleaseScript.includes("wait_for_worker_official_publish_after"),
      verifiesReadinessIdle: bundleReleaseScript.includes("wait_for_worker_readiness_idle_after"),
    });

  const bundleLiveRefreshStart = bundleReleaseScript.indexOf("refresh_live_store_after_swap() {");
  const bundleLiveRefreshEnd = bundleReleaseScript.indexOf("copy_regular_file_nofollow() {", bundleLiveRefreshStart);
  const bundleLiveRefresh = bundleReleaseScript.slice(bundleLiveRefreshStart, bundleLiveRefreshEnd);
  pushCheck(checks, "signed release post-swap SQLite refresh inherits the production runtime memory limit", bundleLiveRefreshStart >= 0
    && bundleLiveRefreshEnd > bundleLiveRefreshStart
    && bundleLiveRefresh.includes('run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$store_dir"')
    && !bundleLiveRefresh.includes('run_as_service_user env SERVER_STORE_DIR="$store_dir"')
    && bundleLiveRefresh.includes("SQLITE_MAINTENANCE_WINDOW=release-stopped")
    && bundleLiveRefresh.includes("npm run datastore:sqlite")
    && bundleReleaseScript.includes('set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"'), {
      loadsRuntimeEnv: bundleLiveRefresh.includes('run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$store_dir"'),
      possibleBareLiveExport: bundleLiveRefresh.includes('run_as_service_user env SERVER_STORE_DIR="$store_dir"'),
      maintenanceGated: bundleLiveRefresh.includes("SQLITE_MAINTENANCE_WINDOW=release-stopped"),
      nodeOptionsConfigured: bundleReleaseScript.includes('set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"')
    });

  pushCheck(checks, "release SQLite compaction is maintenance-gated and model catchup stays online", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes("SQLITE_VACUUM_AFTER_EXPORT=1")
    && text.includes("SQLITE_MAINTENANCE_WINDOW=release-stopped")
    && text.includes("SQLITE_WAL_CHECKPOINT_MODE=TRUNCATE")
    && text.includes("RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1")
    && text.includes("run deferred model catchup while the healthy HTTP service remains available")
    && text.includes("SQLITE_VACUUM_AFTER_EXPORT=0")
  )), {
    releaseMaintenanceVacuum: releaseScript.includes("SQLITE_MAINTENANCE_WINDOW=release-stopped"),
    bundleMaintenanceVacuum: bundleReleaseScript.includes("SQLITE_MAINTENANCE_WINDOW=release-stopped"),
    releaseDefersModelCatchup: releaseScript.includes("RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1"),
    bundleDefersModelCatchup: bundleReleaseScript.includes("RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1")
  });

  pushCheck(checks, "signed candidate odds cache compaction is isolated, mirrored, and fail-closed", bundleReleaseScript.includes('"$NODE_HOME/bin/node" scripts/compactPublicOddsHistory.cjs')
    && bundleReleaseScript.includes('compact_public_odds_history "$BUILD_DIR"')
    && !bundleReleaseScript.includes("compact_script=")
    && compactPublicOddsHistory.includes("public-odds-history-compaction-v2")
    && compactPublicOddsHistory.includes("odds history input is not valid JSON")
    && compactPublicOddsHistory.includes("odds history mirror digests differ after compaction")
    && compactPublicOddsHistory.includes("mirrorDigestsMatch: true")
    && createReleaseBundle.includes('"scripts/compactPublicOddsHistory.cjs"')
    && verifyReleaseBundleSafety.includes('"scripts/compactPublicOddsHistory.cjs"')
    && signedEntrypointsVerifier.includes("candidate odds compaction is file-based and fail-closed"), {
      invokesSignedHelper: bundleReleaseScript.includes('"$NODE_HOME/bin/node" scripts/compactPublicOddsHistory.cjs'),
      rejectsInlineScript: !bundleReleaseScript.includes("compact_script="),
      validatesInputJson: compactPublicOddsHistory.includes("odds history input is not valid JSON"),
      validatesMirrorDigests: compactPublicOddsHistory.includes("odds history mirror digests differ after compaction"),
      helperRequiredByBundle: createReleaseBundle.includes('"scripts/compactPublicOddsHistory.cjs"')
        && verifyReleaseBundleSafety.includes('"scripts/compactPublicOddsHistory.cjs"'),
    });

  pushCheck(checks, "systemd split services", appService.includes("server/index.cjs") && appService.includes("TimeoutStopSec=8") && appService.includes("KillMode=mixed") && workerService.includes("runSyncWorker.cjs --loop") && workerService.includes("SYNC_WORKER_LOOP=1") && syncWorker.includes('process.argv.includes("--loop")') && !workerService.includes("Environment=DATASTORE_READ_SOURCE=") && hasUnitDirective(workerService, "Environment", "ENABLE_SQLITE_EXPORT=0") && !workerService.includes("ENABLE_SQLITE_EXPORT=1"), {
    hasAppService: appService.includes("server/index.cjs"),
    appHasBoundedStop: appService.includes("TimeoutStopSec=8"),
    appKillModeMixed: appService.includes("KillMode=mixed"),
    hasWorkerService: workerService.includes("runSyncWorker.cjs --loop"),
    workerHasLoopEnvironment: workerService.includes("SYNC_WORKER_LOOP=1"),
    workerHasLoopArgumentFallback: syncWorker.includes('process.argv.includes("--loop")'),
    workerReadSourceFromEnvFile: !workerService.includes("Environment=DATASTORE_READ_SOURCE="),
    workerSqliteExportDisabled: hasUnitDirective(workerService, "Environment", "ENABLE_SQLITE_EXPORT=0")
  });

  const workerUsesBackgroundIoPriority = hasUnitDirective(workerService, "Nice", "10")
    && hasUnitDirective(workerService, "IOSchedulingClass", "best-effort")
    && hasUnitDirective(workerService, "IOSchedulingPriority", "7");
  pushCheck(checks, "sync worker yields CPU and disk priority to the API", workerUsesBackgroundIoPriority, {
    nice: unitDirectiveValues(workerService, "Nice"),
    ioSchedulingClass: unitDirectiveValues(workerService, "IOSchedulingClass"),
    ioSchedulingPriority: unitDirectiveValues(workerService, "IOSchedulingPriority")
  });

  pushCheck(checks, "systemd protects API memory while throttling heavyweight sync publication",
    hasUnitDirective(appService, "OOMScoreAdjust", "-500")
      && hasUnitDirective(appService, "MemoryLow", "512M")
      && hasUnitDirective(workerService, "OOMScoreAdjust", "500")
      && hasUnitDirective(workerService, "Environment", "\"NODE_OPTIONS=--max-old-space-size=768 --expose-gc\"")
      && hasUnitDirective(workerService, "Environment", "MALLOC_ARENA_MAX=2")
      && hasUnitDirective(workerService, "MemoryHigh", "5G")
      && hasUnitDirective(workerService, "MemoryMax", "6G")
      && hasUnitDirective(workerService, "MemorySwapMax", "1G"), {
      appOomScoreAdjust: unitDirectiveValues(appService, "OOMScoreAdjust"),
      appMemoryLow: unitDirectiveValues(appService, "MemoryLow"),
      workerOomScoreAdjust: unitDirectiveValues(workerService, "OOMScoreAdjust"),
      workerEnvironment: unitDirectiveValues(workerService, "Environment"),
      workerMemoryHigh: unitDirectiveValues(workerService, "MemoryHigh"),
      workerMemoryMax: unitDirectiveValues(workerService, "MemoryMax"),
      workerMemorySwapMax: unitDirectiveValues(workerService, "MemorySwapMax"),
    });

  const externalRuntimeEnv = "/etc/football-predict/env";
  const commonWritablePaths = [
    "/var/lib/football-predict",
    "/opt/football-predict/server-data"
  ];
  const commonNonRootSandboxDirectives = [
    ["UMask", "0027"],
    ["PrivateDevices", "true"],
    ["PrivateTmp", "true"],
    ["ProtectHome", "read-only"],
    ["ProtectSystem", "strict"],
    ["ProtectClock", "true"],
    ["ProtectControlGroups", "true"],
    ["ProtectHostname", "true"],
    ["ProtectKernelLogs", "true"],
    ["ProtectKernelModules", "true"],
    ["ProtectKernelTunables", "true"],
    ["LockPersonality", "true"],
    ["RestrictRealtime", "true"],
    ["RestrictSUIDSGID", "true"],
    ["SystemCallArchitectures", "native"],
    ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK"]
  ];
  const appAndWorkerUseExternalEnv = [appService, workerService].every((service) => (
    hasUnitDirective(service, "EnvironmentFile", externalRuntimeEnv)
    && !service.includes("/opt/football-predict/deploy/light-server/env")
  ));
  const appAndWorkerUsePinnedNode = appService.includes("ExecStart=/opt/node-v22.22.1/bin/node /opt/football-predict/server/index.cjs")
    && workerService.includes("ExecStart=/opt/node-v22.22.1/bin/node /opt/football-predict/scripts/runSyncWorker.cjs");
  pushCheck(checks, "systemd runtime environment is outside the release tree", appAndWorkerUseExternalEnv && appAndWorkerUsePinnedNode, {
    externalRuntimeEnv,
    appEnvironmentFiles: unitDirectiveValues(appService, "EnvironmentFile"),
    workerEnvironmentFiles: unitDirectiveValues(workerService, "EnvironmentFile"),
    appUsesPinnedNode: appService.includes("ExecStart=/opt/node-v22.22.1/bin/node"),
    workerUsesPinnedNode: workerService.includes("ExecStart=/opt/node-v22.22.1/bin/node")
  });

  const serviceUsesCommonSandbox = (service) => (
    commonNonRootSandboxDirectives.every(([key, value]) => hasUnitDirective(service, key, value))
    && hasEmptyUnitDirective(service, "CapabilityBoundingSet")
    && hasEmptyUnitDirective(service, "AmbientCapabilities")
    && commonWritablePaths.every((writablePath) => unitDirectiveTokens(service, "ReadWritePaths").includes(writablePath))
    && !unitDirectiveTokens(service, "ReadWritePaths").includes("/opt/football-predict/dist")
    && !hasUnitDirective(service, "MemoryDenyWriteExecute", "true")
  );
  const appAndWorkerSandboxed = serviceUsesCommonSandbox(appService)
    && serviceUsesCommonSandbox(workerService)
    && unitDirectiveTokens(appService, "ReadWritePaths").includes("/opt/football-predict/public/data")
    && !unitDirectiveTokens(appService, "ReadWritePaths").includes("/opt/football-predict/public")
    && unitDirectiveTokens(workerService, "ReadWritePaths").includes("/opt/football-predict/public");
  pushCheck(checks, "systemd app and worker use a V8-compatible filesystem sandbox", appAndWorkerSandboxed, {
    appWritablePaths: unitDirectiveTokens(appService, "ReadWritePaths"),
    workerWritablePaths: unitDirectiveTokens(workerService, "ReadWritePaths"),
    appCapabilitiesEmpty: hasEmptyUnitDirective(appService, "CapabilityBoundingSet"),
    workerCapabilitiesEmpty: hasEmptyUnitDirective(workerService, "CapabilityBoundingSet"),
    appMemoryDenyWriteExecute: unitDirectiveValues(appService, "MemoryDenyWriteExecute"),
    workerMemoryDenyWriteExecute: unitDirectiveValues(workerService, "MemoryDenyWriteExecute")
  });

  const monitorAllowedEnvironmentKeys = new Set([
    "PATH", "NODE_HOME", "NODE_ENV", "NODE_OPTIONS", "SERVER_STORE_DIR", "DATASTORE_SQLITE_PATH",
    "RUNTIME_MONITOR_BASE_URL", "RUNTIME_MONITOR_STATUS_PATH", "RUNTIME_MONITOR_REQUIRE_SQLITE",
    "RUNTIME_MONITOR_AUTO_REPAIR_SQLITE", "RUNTIME_MONITOR_TIMEOUT_MS", "RUNTIME_MONITOR_HTTP_ATTEMPTS",
    "RUNTIME_MONITOR_HTTP_RETRY_DELAY_MS", "RUNTIME_MONITOR_SQLITE_REPAIR_TIMEOUT_MS",
    "RUNTIME_MONITOR_CHECK_CLEANUP", "RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE",
    "RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT", "RUNTIME_MONITOR_AUTH_FILE"
  ]);
  const cleanupAllowedEnvironmentKeys = new Set([
    "PATH", "NODE_HOME", "NODE_ENV", "NODE_OPTIONS", "SERVER_STORE_DIR", "SERVER_CLEANUP_APP_DIR",
    "SERVER_CLEANUP_STORE_DIR", "SERVER_CLEANUP_TMP_DIR", "SNAPSHOT_RETENTION_DAYS",
    "SERVER_CLEANUP_APPLY", "SERVER_CLEANUP_APP_BACKUPS", "SERVER_CLEANUP_APP_ARTIFACTS",
    "SERVER_CLEANUP_TMP_ARTIFACTS", "SERVER_CLEANUP_SYSTEM_LOGS"
  ]);
  const monitorEnvironmentKeys = unitEnvironmentKeys(monitorService);
  const cleanupEnvironmentKeys = unitEnvironmentKeys(cleanupService);
  const sensitiveEnvironmentKey = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_CODE|ADMIN|GPT_RELAY)/;
  const operationalUnitsHaveIsolatedEnvironments = [monitorService, cleanupService].every((service) => (
    unitDirectiveValues(service, "EnvironmentFile").length === 0
  ))
    && monitorEnvironmentKeys.length > 0
    && cleanupEnvironmentKeys.length > 0
    && monitorEnvironmentKeys.every((key) => monitorAllowedEnvironmentKeys.has(key) && !sensitiveEnvironmentKey.test(key))
    && cleanupEnvironmentKeys.every((key) => cleanupAllowedEnvironmentKeys.has(key) && !sensitiveEnvironmentKey.test(key));
  pushCheck(checks, "systemd monitor and cleanup do not inherit application secrets", operationalUnitsHaveIsolatedEnvironments, {
    monitorEnvironmentFiles: unitDirectiveValues(monitorService, "EnvironmentFile"),
    cleanupEnvironmentFiles: unitDirectiveValues(cleanupService, "EnvironmentFile"),
    monitorEnvironmentKeys,
    cleanupEnvironmentKeys,
    monitorUnexpectedKeys: monitorEnvironmentKeys.filter((key) => !monitorAllowedEnvironmentKeys.has(key) || sensitiveEnvironmentKey.test(key)),
    cleanupUnexpectedKeys: cleanupEnvironmentKeys.filter((key) => !cleanupAllowedEnvironmentKeys.has(key) || sensitiveEnvironmentKey.test(key))
  });

  const monitorSandboxed = [
    ["UMask", "0027"],
    ["PrivateDevices", "true"],
    ["PrivateTmp", "false"],
    ["ProtectHome", "read-only"],
    ["ProtectSystem", "strict"],
    ["ProtectProc", "default"],
    ["RestrictNamespaces", "true"],
    ["SystemCallArchitectures", "native"],
    ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
    ["SystemCallFilter", "@system-service"],
    ["SystemCallErrorNumber", "EPERM"]
  ].every(([key, value]) => hasUnitDirective(monitorService, key, value))
    && hasEmptyUnitDirective(monitorService, "CapabilityBoundingSet")
    && hasEmptyUnitDirective(monitorService, "AmbientCapabilities")
    && unitDirectiveTokens(monitorService, "ReadWritePaths").length === 1
    && unitDirectiveTokens(monitorService, "ReadWritePaths")[0] === "/var/lib/football-predict"
    && !hasUnitDirective(monitorService, "PrivateNetwork", "true");
  pushCheck(checks, "systemd monitor sandbox preserves host health visibility", monitorSandboxed, {
    privateTmp: unitDirectiveValues(monitorService, "PrivateTmp"),
    privateNetwork: unitDirectiveValues(monitorService, "PrivateNetwork"),
    protectProc: unitDirectiveValues(monitorService, "ProtectProc"),
    writablePaths: unitDirectiveTokens(monitorService, "ReadWritePaths"),
    syscallFilter: unitDirectiveValues(monitorService, "SystemCallFilter")
  });

  const cleanupSandboxed = [
    ["UMask", "0027"],
    ["PrivateDevices", "true"],
    ["PrivateNetwork", "true"],
    ["PrivateTmp", "true"],
    ["ProtectHome", "true"],
    ["ProtectSystem", "strict"],
    ["ReadOnlyPaths", "/opt/node-v22.22.1"],
    ["ProtectProc", "invisible"],
    ["RestrictNamespaces", "true"],
    ["SystemCallArchitectures", "native"],
    ["RestrictAddressFamilies", "AF_UNIX"],
    ["SystemCallFilter", "@system-service"],
    ["SystemCallErrorNumber", "EPERM"]
  ].every(([key, value]) => hasUnitDirective(cleanupService, key, value))
    && hasEmptyUnitDirective(cleanupService, "CapabilityBoundingSet")
    && hasEmptyUnitDirective(cleanupService, "AmbientCapabilities")
    && hasUnitDirective(cleanupService, "User", "football")
    && hasUnitDirective(cleanupService, "Group", "football")
    && unitDirectiveTokens(cleanupService, "ReadWritePaths").length === 1
    && unitDirectiveTokens(cleanupService, "ReadWritePaths")[0] === "/var/lib/football-predict"
    && !hasUnitDirective(cleanupService, "MemoryDenyWriteExecute", "true");
  pushCheck(checks, "systemd cleanup is unprivileged and state-directory bounded", cleanupSandboxed, {
    user: unitDirectiveValues(cleanupService, "User"),
    group: unitDirectiveValues(cleanupService, "Group"),
    capabilityBoundingSet: unitDirectiveValues(cleanupService, "CapabilityBoundingSet"),
    privateNetwork: unitDirectiveValues(cleanupService, "PrivateNetwork"),
    protectSystem: unitDirectiveValues(cleanupService, "ProtectSystem"),
    writablePaths: unitDirectiveTokens(cleanupService, "ReadWritePaths"),
    readonlyPaths: unitDirectiveTokens(cleanupService, "ReadOnlyPaths"),
    syscallFilter: unitDirectiveValues(cleanupService, "SystemCallFilter")
  });

  pushCheck(checks, "node server has bounded graceful shutdown", serverIndex.includes('process.on("SIGTERM"')
    && serverIndex.includes('process.on("SIGINT"')
    && serverIndex.includes("server.close(")
    && serverIndex.includes("closeIdleConnections")
    && serverIndex.includes('writeSse(res, "server_shutdown"')
    && serverIndex.includes("removeSseClient(res)")
    && serverIndex.includes("SHUTDOWN_GRACE_MS"), {
      handlesSigterm: serverIndex.includes('process.on("SIGTERM"'),
      handlesSigint: serverIndex.includes('process.on("SIGINT"'),
      closesServer: serverIndex.includes("server.close("),
      closesIdleConnections: serverIndex.includes("closeIdleConnections"),
      closesEventStreams: serverIndex.includes('writeSse(res, "server_shutdown"') && serverIndex.includes("removeSseClient(res)"),
      graceEnv: serverIndex.includes("SHUTDOWN_GRACE_MS")
    });

  pushCheck(checks, "sync worker can be stopped for maintenance windows", hasUnitDirective(workerService, "Restart", "always")
    && hasUnitDirective(workerService, "TimeoutStopSec", "45")
    && hasUnitDirective(workerService, "KillSignal", "SIGTERM")
    && releaseScript.includes("stop_worker_for_release_window")
    && bundleReleaseScript.includes("stop_worker_for_release_window"), {
    restartAlways: hasUnitDirective(workerService, "Restart", "always"),
    boundedStop: hasUnitDirective(workerService, "TimeoutStopSec", "45"),
    sigtermStop: hasUnitDirective(workerService, "KillSignal", "SIGTERM"),
    releaseStopsWorker: releaseScript.includes("stop_worker_for_release_window")
      && bundleReleaseScript.includes("stop_worker_for_release_window")
  });

  pushCheck(checks, "release scripts pause sync worker and preserve live data before candidate build", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes("stop_worker_for_release_window")
    && text.includes("preserve_live_public_data_cache")
    && text.includes("preserved ${copied} live public data cache files")
    && pausesWorkerBeforeCandidateBuild(text)
    && preservesLiveDataBeforeCandidateBuild(text)
  )), {
    releasePausesWorkerBeforeBuild: pausesWorkerBeforeCandidateBuild(releaseScript),
    bundlePausesWorkerBeforeBuild: pausesWorkerBeforeCandidateBuild(bundleReleaseScript),
    releasePreservesLiveDataBeforeBuild: preservesLiveDataBeforeCandidateBuild(releaseScript),
    bundlePreservesLiveDataBeforeBuild: preservesLiveDataBeforeCandidateBuild(bundleReleaseScript)
  });

  pushCheck(checks, "safe release script preflights candidate before swap", releaseScript.includes("CANDIDATE_PORT")
    && releaseScript.includes("CANDIDATE_SQLITE_PATH")
    && releaseScript.includes("SERVER_STORE_DIR=\"$CANDIDATE_STORE_DIR\"")
    && releaseScript.includes("DATASTORE_SQLITE_PATH=\"$CANDIDATE_SQLITE_PATH\"")
    && releaseScript.includes("wait_for_health \"http://${HOST}:${CANDIDATE_PORT}\"")
    && releaseScript.includes("VERIFY_BASE_URL=\"http://${HOST}:${CANDIDATE_PORT}\"")
    && releaseScript.includes("npm run verify:production")
    && releaseScript.includes("abort_before_swap \"candidate production readiness failed\"")
    && !releaseScript.includes("rollback \"candidate production readiness failed\""), {
      hasReleaseScript: Boolean(releaseScript),
      hasCandidatePort: releaseScript.includes("CANDIDATE_PORT"),
      hasCandidateSqlite: releaseScript.includes("CANDIDATE_SQLITE_PATH"),
      verifiesCandidate: releaseScript.includes("VERIFY_BASE_URL=\"http://${HOST}:${CANDIDATE_PORT}\""),
      abortsWithoutHistoricalRollback: releaseScript.includes("abort_before_swap \"candidate production readiness failed\"")
        && !releaseScript.includes("rollback \"candidate production readiness failed\"")
    });

  const isolatedCandidateAuditFloorCount = (bundleReleaseScript.match(/MODEL_INPUT_AUDIT_MIN_MARKET_ROWS=30/g) || []).length;
  pushCheck(checks, "isolated bundle candidate uses the bounded model-audit sample floor", isolatedCandidateAuditFloorCount === 1
    && compactPublicOddsHistory.includes("row.lastSeenAt")
    && compactPublicOddsHistory.includes("row.capturedAt")
    && !bundleReleaseScript.includes('export MODEL_INPUT_AUDIT_MIN_MARKET_ROWS'), {
      isolatedCandidateAuditFloorCount,
      retainsOddsByLastSeen: compactPublicOddsHistory.includes("row.lastSeenAt")
        && compactPublicOddsHistory.includes("row.capturedAt"),
      globallyExportsReducedFloor: bundleReleaseScript.includes('export MODEL_INPUT_AUDIT_MIN_MARKET_ROWS')
    });

  for (const verifierName of ["verifyPredictionExecutionCapture.cjs", "verifyPredictionReplay.cjs"]) {
    const verifierSource = readText(path.join(rootDir, "scripts", verifierName));
    pushCheck(checks, `${verifierName} stores synthetic fixtures outside the read-only release tree`,
      verifierSource.includes('fs.mkdtempSync(path.join(require("node:os").tmpdir(), "football-')
        && verifierSource.includes('path.dirname(fs.realpathSync(dir))')
        && !verifierSource.includes('path.join(root, "outputs"'), { verifierName });
  }

  const lifecycleFinallyIndex = verifyMatchDetailLifecycle.indexOf("} finally {");
  const lifecycleViteCloseIndex = verifyMatchDetailLifecycle.indexOf("await vite?.close()", lifecycleFinallyIndex);
  const lifecycleCacheCleanupIndex = verifyMatchDetailLifecycle.indexOf("fs.rmSync(viteCacheDir, { recursive: true, force: true })", lifecycleFinallyIndex);
  const lifecycleUsesSystemTempCache = verifyMatchDetailLifecycle.includes("fs.mkdtempSync(path.join(os.tmpdir(), 'football-match-detail-vite-'))")
    && verifyMatchDetailLifecycle.includes("cacheDir: viteCacheDir")
    && !verifyMatchDetailLifecycle.includes("node_modules/.vite-temp")
    && !verifyMatchDetailLifecycle.includes("path.join(rootDir, 'node_modules'");
  const lifecycleCleansTempCache = lifecycleFinallyIndex >= 0
    && lifecycleViteCloseIndex > lifecycleFinallyIndex
    && lifecycleCacheCleanupIndex > lifecycleViteCloseIndex;
  pushCheck(checks, "match detail lifecycle verifier is safe in a read-only candidate tree", verifyMatchDetailLifecycle.includes("const os = require('node:os')")
    && verifyMatchDetailLifecycle.includes("configFile: false")
    && verifyMatchDetailLifecycle.includes("football-collector-diagnostics:ssr-verifier")
    && verifyMatchDetailLifecycle.includes("collectorModule.compactApiFootballDiagnostics === diagnostics.compactApiFootballDiagnostics")
    && verifyMatchDetailLifecycle.includes("fs.realpathSync(viteCacheDir)")
    && verifyMatchDetailLifecycle.includes("Unsafe lifecycle verifier cache cleanup")
    && lifecycleUsesSystemTempCache
    && lifecycleCleansTempCache, {
      disablesViteConfigLoading: verifyMatchDetailLifecycle.includes("configFile: false"),
      usesAbsoluteSystemTempCache: lifecycleUsesSystemTempCache,
      closesViteBeforeCleanup: lifecycleCleansTempCache,
      dependsOnNodeModulesViteTemp: verifyMatchDetailLifecycle.includes("node_modules/.vite-temp")
        || verifyMatchDetailLifecycle.includes("path.join(rootDir, 'node_modules'")
    });

  const releaseSqliteFailurePropagates = (text) => text.includes("npm run datastore:sqlite || return 1")
    || (
      text.includes("live_sqlite_export()")
      && text.includes("npm run datastore:sqlite")
      && text.includes("live_sqlite_export || return 1")
    );
  const releaseModelFailurePropagates = (text) => (
    (text.includes("npm run model:backtest || return 1")
      || text.includes('"$NODE_HOME/bin/npm" run model:backtest || return 1'))
    && (text.includes("npm run optimize:strategy || return 1")
      || text.includes('"$NODE_HOME/bin/npm" run optimize:strategy || return 1'))
  );
  pushCheck(checks, "release scripts preserve npm executables and separate pre-swap abort from rollback", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes('-path "${app_dir}/node_modules" -prune')
    && text.includes("abort_before_swap()")
    && text.includes('if [ "${SWAP_STARTED:-0}" != "1" ]')
    && text.includes("release_exit_trap()")
    && !text.includes("trap stop_candidate EXIT")
    && text.includes("backup_live_sqlite_for_rollback")
    && text.includes("restore_live_sqlite_after_rollback")
    && text.includes("stop_service_for_release_window")
    && releaseSqliteFailurePropagates(text)
    && releaseModelFailurePropagates(text)
    && text.includes("nginx -t || return 1")
  )), {
    releasePreservesNodeModulesModes: releaseScript.includes('-path "${app_dir}/node_modules" -prune'),
    bundlePreservesNodeModulesModes: bundleReleaseScript.includes('-path "${app_dir}/node_modules" -prune'),
    releaseHasPreSwapAbort: releaseScript.includes("abort_before_swap()"),
    bundleHasPreSwapAbort: bundleReleaseScript.includes("abort_before_swap()"),
    releaseHasSqliteRollbackState: releaseScript.includes("backup_live_sqlite_for_rollback") && releaseScript.includes("restore_live_sqlite_after_rollback"),
    bundleHasSqliteRollbackState: bundleReleaseScript.includes("backup_live_sqlite_for_rollback") && bundleReleaseScript.includes("restore_live_sqlite_after_rollback"),
    releaseCriticalFunctionsPropagate: releaseSqliteFailurePropagates(releaseScript)
      && releaseModelFailurePropagates(releaseScript)
      && releaseScript.includes("nginx -t || return 1"),
    bundleCriticalFunctionsPropagate: releaseSqliteFailurePropagates(bundleReleaseScript)
      && releaseModelFailurePropagates(bundleReleaseScript)
      && bundleReleaseScript.includes("nginx -t || return 1")
  });

  const cacheSnapshotBarrier = bundleReleaseScript.indexOf(
    "canonical sync write barrier could not protect candidate cache snapshot",
  );
  const cacheSnapshotWorkerStop = bundleReleaseScript.indexOf(
    "sync worker could not be paused for candidate cache snapshot",
    cacheSnapshotBarrier,
  );
  const cacheSnapshotIdentityGate = bundleReleaseScript.indexOf(
    "live SQLite publication identity mismatched after candidate cache worker pause",
    cacheSnapshotWorkerStop,
  );
  const cacheSnapshotBarrierDrain = bundleReleaseScript.indexOf(
    "candidate cache snapshot sync barrier did not drain cleanly",
    cacheSnapshotIdentityGate,
  );
  const candidateRefreshBarrier = bundleReleaseScript.indexOf(
    "canonical sync write barrier could not protect candidate readiness refresh",
    cacheSnapshotBarrierDrain,
  );
  const candidateRefreshWorkerStop = bundleReleaseScript.indexOf(
    "sync worker could not be paused for candidate readiness",
    candidateRefreshBarrier,
  );
  const candidateRefreshIdentityGate = bundleReleaseScript.indexOf(
    "live SQLite publication identity mismatched after candidate readiness worker pause",
    candidateRefreshWorkerStop,
  );
  const candidateRefreshBarrierDrain = bundleReleaseScript.indexOf(
    "candidate readiness sync barrier did not drain cleanly",
    candidateRefreshIdentityGate,
  );
  const publicationOfficialGate = bundleReleaseScript.indexOf(
    "sync worker did not publish a fresh official SQLite generation before live prebuild",
    candidateRefreshBarrierDrain,
  );
  const writeBarrier = bundleReleaseScript.indexOf(
    "canonical live sync write barrier could not freeze generation commits before worker pause",
    publicationOfficialGate,
  );
  const finalWorkerStop = bundleReleaseScript.indexOf(
    "sync worker could not be paused before live SQLite prebuild",
    writeBarrier,
  );
  const publicationAffinityGate = bundleReleaseScript.indexOf(
    "live SQLite publication identity changed after the final worker pause",
    finalWorkerStop,
  );
  const capacityGate = bundleReleaseScript.indexOf(
    "live SQLite prebuild capacity gate rejected the release host",
    finalWorkerStop,
  );
  const pressureGate = bundleReleaseScript.indexOf(
    "current HTTP pressure gate failed before final live SQLite prebuild",
    writeBarrier,
  );
  const performanceCredentialCleanup = bundleReleaseScript.indexOf(
    "release performance credential could not be cleaned before final sqlite snapshot",
    pressureGate,
  );
  const postPressureCapacityGate = bundleReleaseScript.indexOf(
    "post-pressure live SQLite prebuild capacity gate rejected the release host",
    performanceCredentialCleanup,
  );
  const finalHeartbeatRefresh = bundleReleaseScript.indexOf(
    "candidate deadline capture heartbeat refresh failed before live SQLite prebuild",
    postPressureCapacityGate,
  );
  const prebuild = bundleReleaseScript.indexOf(
    'prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"',
    finalHeartbeatRefresh,
  );
  const ninetySecondGate = bundleReleaseScript.indexOf(
    "candidate deadline capture heartbeat exceeded ${LIVE_SQLITE_PREBUILD_HEARTBEAT_MAX_AGE_SECONDS} seconds after live SQLite prebuild",
    prebuild,
  );
  const postPrebuildCapacityGate = bundleReleaseScript.indexOf(
    "post-prebuild live SQLite capacity gate rejected the release host",
    ninetySecondGate,
  );
  const sealedHandoffGate = bundleReleaseScript.indexOf(
    "candidate deadline capture heartbeat exceeded the sealed handoff budget",
    postPrebuildCapacityGate,
  );
  const pointerKeeper = bundleReleaseScript.indexOf(
    "start_release_pointer_commit_keeper",
    sealedHandoffGate,
  );
  const sealedWindow = bundleReleaseScript.slice(prebuild, pointerKeeper);
  pushCheck(checks, "signed release bounds live SQLite prebuild resources, capacity, and heartbeat age", (
    bundleReleaseScript.includes("RELEASE_LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS:-900")
    && bundleReleaseScript.includes('[ "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -ge 60 ]')
    && bundleReleaseScript.includes('[ "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -le 900 ]')
    && bundleReleaseScript.includes('IOSchedulingPriority=4')
    && bundleReleaseScript.includes('IOWeight=50')
    && bundleReleaseScript.includes('MemoryHigh=896M')
    && bundleReleaseScript.includes('MemoryMax=1024M')
    && bundleReleaseScript.includes('MemorySwapMax=256M')
    && bundleReleaseScript.includes('root:football:640:1')
    && bundleReleaseScript.includes('run_prebuild_stage copy-rollback')
    && bundleReleaseScript.includes('run_prebuild_stage stage-copy')
    && bundleReleaseScript.includes('run_prebuild_stage export')
    && bundleReleaseScript.includes('SQLITE_EXPORT_REQUIRE_ACTIVE_GENERATION_FAST_PATH=1')
    && bundleReleaseScript.includes('validatePayloadSemantics: false')
    && bundleReleaseScript.includes('RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS:-1500')
    && bundleReleaseScript.includes('RELEASE_CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS:-900')
    && bundleReleaseScript.includes('CANDIDATE_PREVERIFY_MIN_REFRESH_BUDGET_SECONDS=$((')
    && bundleReleaseScript.includes('POST_SWAP_TRANSITION_START_BUDGET_SECONDS - CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS')
    && bundleReleaseScript.includes('LIVE_SQLITE_PUBLICATION_WORKER_STARTED_AT=')
    && bundleReleaseScript.includes('verify_live_sqlite_publication_identity()')
    && bundleReleaseScript.includes('RELEASE_SYNC_WRITE_BARRIER_SCRIPT_ROOT=')
    && bundleReleaseScript.includes('local script_root="${1:-$NEXT_DIR}"')
    && releasePrebuildPolicy.includes('release-live-sqlite-prebuild-policy-v4')
    && bundleReleaseScript.includes(
      'WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS +\n  2 * ((RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS + 999) / 1000) +\n  LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS +\n  POST_SWAP_TRANSITION_START_BUDGET_SECONDS - CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS'
    )
    && bundleReleaseScript.includes('run_prebuild_stage quick_check')
    && bundleReleaseScript.includes('run_prebuild_stage seal')
    && releasePrebuildPolicy.includes('MAX_HEARTBEAT_AGE_SECONDS = 960')
    && releasePrebuildPolicy.includes('DEFAULT_MIN_MEM_AVAILABLE_MIB = 1152')
    && releasePrebuildPolicy.includes('DEFAULT_MAX_APP_MEMORY_CURRENT_MIB = 768')
    && releasePrebuildPolicy.includes('DEFAULT_MAX_APP_WORKING_SET_MIB = 512')
    && envExample.includes('RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB=1152')
    && envExample.includes('RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB=640')
    && envExample.includes('RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB=512')
    && cacheSnapshotBarrier >= 0
    && cacheSnapshotWorkerStop > cacheSnapshotBarrier
    && cacheSnapshotIdentityGate > cacheSnapshotWorkerStop
    && cacheSnapshotBarrierDrain > cacheSnapshotIdentityGate
    && candidateRefreshBarrier > cacheSnapshotBarrierDrain
    && candidateRefreshWorkerStop > candidateRefreshBarrier
    && candidateRefreshIdentityGate > candidateRefreshWorkerStop
    && candidateRefreshBarrierDrain > candidateRefreshIdentityGate
    && publicationOfficialGate > candidateRefreshBarrierDrain
    && writeBarrier > publicationOfficialGate
    && finalWorkerStop > writeBarrier
    && publicationAffinityGate > finalWorkerStop
    && capacityGate > publicationAffinityGate
    && pressureGate > capacityGate
    && performanceCredentialCleanup > pressureGate
    && postPressureCapacityGate > performanceCredentialCleanup
    && finalHeartbeatRefresh > postPressureCapacityGate
    && prebuild > finalHeartbeatRefresh
    && ninetySecondGate > prebuild
    && postPrebuildCapacityGate > ninetySecondGate
    && sealedHandoffGate > postPrebuildCapacityGate
    && pointerKeeper > sealedHandoffGate
    && !sealedWindow.includes('PERF_ACCESS_TOKEN_FILE=')
    && !sealedWindow.includes('verifyApiPerformance.cjs')
    && !sealedWindow.includes('refresh_candidate_capture_heartbeat_for_readiness')
  ), {
    runtimeMinSeconds: 60,
    runtimeMaxSeconds: 900,
    memoryHighMiB: 896,
    memoryMaxMiB: 1024,
    memorySwapMaxMiB: 256,
    barrierBeforeWorkerPause: writeBarrier >= 0
      && finalWorkerStop > writeBarrier
      && capacityGate > finalWorkerStop,
    heartbeatFreshnessOrder: pressureGate > capacityGate
      && performanceCredentialCleanup > pressureGate
      && postPressureCapacityGate > performanceCredentialCleanup
      && finalHeartbeatRefresh > postPressureCapacityGate
      && prebuild > finalHeartbeatRefresh
      && ninetySecondGate > prebuild
      && postPrebuildCapacityGate > ninetySecondGate
      && sealedHandoffGate > postPrebuildCapacityGate
      && pointerKeeper > sealedHandoffGate
      && !sealedWindow.includes('PERF_ACCESS_TOKEN_FILE=')
      && !sealedWindow.includes('verifyApiPerformance.cjs')
      && !sealedWindow.includes('refresh_candidate_capture_heartbeat_for_readiness'),
  });

  const legacyReleaseKeepsSecretsOutsideBuilds = (
    releaseScript.includes('RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-/etc/football-predict/env}"')
    && releaseScript.includes("prepare_runtime_env()")
    && releaseScript.includes("link_runtime_env()")
    && releaseScript.includes('run_as_build_user env HOME="$BUILD_HOME"')
    && releaseScript.includes("ACCESS_CODE_SECRET=\"$CANDIDATE_ACCESS_SECRET\"")
    && releaseScript.includes('run_as_service_user_with_runtime_env env VERIFY_BASE_URL=')
    && !releaseScript.includes('cp "${APP_DIR}/deploy/light-server/env"')
  );
  const isolatedBundleReleaseKeepsSecretsOutsideBuilds = (
    bundleReleaseScript.includes('RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-/etc/football-predict/env}"')
    && bundleReleaseScript.includes("prepare_runtime_env()")
    && bundleReleaseScript.includes("link_runtime_env()")
    && bundleReleaseScript.includes("run_build_step npm-ci")
    && bundleReleaseScript.includes('--uid="$BUILD_USER"')
    && bundleReleaseScript.includes("assert_build_user_quiescent")
    && bundleReleaseScript.includes("ACCESS_CODE_SECRET=\"$CANDIDATE_ACCESS_SECRET\"")
    && bundleReleaseScript.includes('run_as_service_user_with_runtime_env env VERIFY_BASE_URL=')
    && !bundleReleaseScript.includes('cp "${APP_DIR}/deploy/light-server/env"')
  );
  const releasesKeepSecretsOutsideBuilds = legacyReleaseKeepsSecretsOutsideBuilds
    && isolatedBundleReleaseKeepsSecretsOutsideBuilds;
  /* Keep the shared runtime-env boundary explicit for both release paths. */
  const releaseRuntimeEnvBoundaries = [releaseScript, bundleReleaseScript].every((text) => (
    text.includes('RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-/etc/football-predict/env}"')
    && text.includes("prepare_runtime_env()")
    && text.includes("link_runtime_env()")
    && text.includes("ACCESS_CODE_SECRET=\"$CANDIDATE_ACCESS_SECRET\"")
    && text.includes('run_as_service_user_with_runtime_env env VERIFY_BASE_URL=')
    && !text.includes('cp "${APP_DIR}/deploy/light-server/env"')
  ));
  pushCheck(checks, "release builds are non-root and cannot inherit production secrets", releasesKeepSecretsOutsideBuilds && releaseRuntimeEnvBoundaries, {
    runtimeEnvFile: "/etc/football-predict/env",
    releaseUsesBuildUser: releaseScript.includes("run_as_build_user()"),
    bundleUsesTransientBuildUser: bundleReleaseScript.includes('--uid="$BUILD_USER"') && bundleReleaseScript.includes("run_build_step npm-ci"),
    releaseCopiesLegacyEnv: releaseScript.includes('cp "${APP_DIR}/deploy/light-server/env"'),
    bundleCopiesLegacyEnv: bundleReleaseScript.includes('cp "${APP_DIR}/deploy/light-server/env"')
  });

  pushCheck(checks, "release keeps static application roots immutable to runtime users", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes('chown root:root "${app_dir}/public"')
    && text.includes('chmod 0755 "${app_dir}/public"')
    && !text.includes('chmod 0775 "${app_dir}/public"')
    && !text.includes('chown -R football:football "${app_dir}/dist/data"')
  )), {
    releasePublicRootReadOnly: releaseScript.includes('chmod 0755 "${app_dir}/public"'),
    bundlePublicRootReadOnly: bundleReleaseScript.includes('chmod 0755 "${app_dir}/public"')
  });

  pushCheck(checks, "safe release script preserves rollback directory", releaseScript.includes("BACKUP_DIR")
    && releaseScript.includes("mv \"$APP_DIR\" \"$BACKUP_DIR\"")
    && releaseScript.includes("mv \"$BACKUP_DIR\" \"$APP_DIR\"")
    && releaseScript.includes("post-swap production readiness failed"), {
      hasBackupDir: releaseScript.includes("BACKUP_DIR"),
      swapsAppDir: releaseScript.includes("mv \"$APP_DIR\" \"$BACKUP_DIR\""),
    restoresBackup: releaseScript.includes("mv \"$BACKUP_DIR\" \"$APP_DIR\"")
  });

  pushCheck(checks, "post-swap readiness reuses only a frozen identity-verified sqlite projection",
    bundleReleaseScript.includes("freeze_worker_for_readiness")
      && bundleReleaseScript.includes("VERIFY_SQLITE_PREVALIDATED=1")
      && verifyProductionReadiness.includes('process.env.VERIFY_SQLITE_PREVALIDATED === "1"')
      && verifyProductionReadiness.includes("readSourceCycleObservation")
      && verifyProductionReadiness.includes("samePublicationIdentity"), {
      freezesWorker: bundleReleaseScript.includes("freeze_worker_for_readiness"),
      optsIntoPrevalidatedProjection: bundleReleaseScript.includes("VERIFY_SQLITE_PREVALIDATED=1"),
      verifiesPublicationIdentity: verifyProductionReadiness.includes("readSourceCycleObservation")
        && verifyProductionReadiness.includes("samePublicationIdentity")
    });

  const legacyReleaseRestoresModelArtifacts = releaseScript.includes("restore_model_artifacts_after_rollback")
    && releaseScript.includes("run_model_artifact_catchup")
    && releaseScript.includes("rollback model artifacts refreshed")
    && releaseScript.includes("sync_model_artifact_mirrors");
  const bundleReleaseRestoresExactExternalModelArtifacts = bundleReleaseScript.includes("snapshot_external_model_artifacts_for_rollback")
    && bundleReleaseScript.includes("restore_external_model_artifacts_after_rollback")
    && bundleReleaseScript.includes("MODEL_ARTIFACT_TOKENS=(strategy evaluation candidate-registry candidate-challenger-suite candidate-temperature-suite candidate-common-cohort-g2-v1 candidate-common-cohort-g2-v2 candidate-capture-status benchmark-prospective-ledger)")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-strategy.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/evaluation.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/candidate-prospective-capture-status.json")
    && bundleReleaseScript.includes("/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json")
    && !/hhad[_-]companion[_-]audit/i.test(bundleReleaseScript)
    && !bundleReleaseScript.includes("restore_model_artifacts_after_rollback")
    && !bundleReleaseScript.includes("rollback model artifacts refreshed");
  const recoveryHelperUsesCompatibleLegacyArtifactManifests = releaseRecoveryHelper.includes('["strategy", `${STORE_PATH}/model-strategy.json`]')
    && releaseRecoveryHelper.includes('["evaluation", `${STORE_PATH}/model-artifacts/evaluation.json`]')
    && releaseRecoveryHelper.includes('["candidate-registry", `${STORE_PATH}/model-artifacts/candidate-prospective-registry.json`]')
    && releaseRecoveryHelper.includes('["candidate-challenger-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-challenger-suite.json`]')
    && releaseRecoveryHelper.includes('["candidate-temperature-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-temperature-neutralization-suite.json`]')
    && releaseRecoveryHelper.includes('["candidate-common-cohort-g2-v1", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2.json`]')
    && releaseRecoveryHelper.includes('["candidate-common-cohort-g2-v2", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2-v2.json`]')
    && releaseRecoveryHelper.includes('["candidate-capture-status", `${STORE_PATH}/candidate-prospective-capture-status.json`]')
    && releaseRecoveryHelper.includes('["benchmark-prospective-ledger", `${STORE_PATH}/model-artifacts/benchmark-prospective-ledger.json`]')
    && releaseRecoveryHelper.includes('["candidate-common-cohort-g2", COMMON_COHORT_G2_V1_PATH]')
    && releaseRecoveryHelper.includes("const LEGACY_MODEL_ARTIFACT_COUNTS = new Set([2, 4, 5, 6, 7])")
    && !/hhad[_-]companion[_-]audit/i.test(releaseRecoveryHelper);
  const hhadPrivateAuditUsesSqlite = privateModelArtifactStore.includes("private_model_artifacts")
    && privateModelArtifactStore.includes("CREATE TABLE IF NOT EXISTS")
    && privateModelArtifactStore.includes("BEGIN IMMEDIATE")
    && privateModelArtifactStore.includes("INSERT INTO ${PRIVATE_MODEL_ARTIFACT_TABLE}")
    && privateModelArtifactStore.includes("readPrivateModelArtifact")
    && privateModelArtifactStore.includes("writePrivateModelArtifact")
    && runModelBacktest.includes("runtimePrivateModelArtifactStore.cjs")
    && runtimePrivateModelArtifactStore.includes("privateModelArtifactStore.cjs")
    && runtimePrivateModelArtifactStore.includes("postgresPrivateModelArtifactStore.cjs")
    && runtimePrivateModelArtifactStore.includes("invalid PRIVATE_MODEL_ARTIFACT_STORAGE")
    && postgresPrivateModelArtifactStore.includes("transactional roundtrip changed audit evidence")
    && runModelBacktest.includes("writePrivateModelArtifact")
    && runModelBacktest.includes("removeLegacyPrivateAuditFile")
    && runModelBacktest.includes("outputFiles: [serverOutputFile, publicOutputFile, shadowCandidatesOutputFile]")
    && verifyModelPromotionGate.includes("runtimePrivateModelArtifactStore.cjs")
    && verifyModelPromotionGate.includes("readPrivateModelArtifact")
    && verifyModelPromotionGate.includes("legacy HHAD private audit file has been removed")
    && !serverIndex.includes("private_model_artifacts");
  pushCheck(checks, "release rollback restores model state, SQLite private audit, and worker", legacyReleaseRestoresModelArtifacts
    && bundleReleaseRestoresExactExternalModelArtifacts
    && recoveryHelperUsesCompatibleLegacyArtifactManifests
    && hhadPrivateAuditUsesSqlite
    && [releaseScript, bundleReleaseScript].every((text) => text.includes("systemctl start \"$WORKER_SERVICE_NAME\"")), {
    releaseRestoresModelArtifacts: legacyReleaseRestoresModelArtifacts,
    bundleRestoresExactExternalModelArtifacts: bundleReleaseRestoresExactExternalModelArtifacts,
    recoveryHelperUsesCompatibleLegacyArtifactManifests,
    hhadPrivateAuditUsesSqlite,
    releaseRestartsWorker: releaseScript.includes("systemctl start \"$WORKER_SERVICE_NAME\""),
    bundleRestartsWorker: bundleReleaseScript.includes("systemctl start \"$WORKER_SERVICE_NAME\"")
  });

  pushCheck(checks, "safe release script can verify public origin", releaseScript.includes("PUBLIC_BASE_URL")
    && releaseScript.includes("REMOTE_BASE_URL=\"$PUBLIC_BASE_URL\"")
    && releaseScript.includes("REMOTE_REQUIRE_HEALTHY=1")
    && releaseScript.includes("REMOTE_REQUIRE_SQLITE=1")
    && releaseScript.includes("REMOTE_REQUIRE_SYNC_WORKER=1")
    && releaseScript.includes("npm run verify:remote-public")
    && releaseScript.includes("rollback \"public origin readiness failed\""), {
      hasPublicBaseUrl: releaseScript.includes("PUBLIC_BASE_URL"),
      verifiesRemotePublic: releaseScript.includes("npm run verify:remote-public"),
      requiresRemoteHealth: releaseScript.includes("REMOTE_REQUIRE_HEALTHY=1"),
      requiresRemoteSqlite: releaseScript.includes("REMOTE_REQUIRE_SQLITE=1"),
      requiresSyncWorker: releaseScript.includes("REMOTE_REQUIRE_SYNC_WORKER=1"),
      rollsBackOnPublicFailure: releaseScript.includes("rollback \"public origin readiness failed\"")
    });

  pushCheck(checks, "release scripts start sync worker before public cutover verification", [releaseScript, bundleReleaseScript].every((text) => (
    text.includes("start_worker_for_live_release")
    && text.includes("systemctl is-active --quiet \"$WORKER_SERVICE_NAME\"")
    && text.includes("sync worker failed to start after release")
    && text.includes("REMOTE_REQUIRE_SYNC_WORKER=1")
    && startsWorkerBeforeRemotePublicVerify(text)
  )), {
    releaseHasWorkerStartHelper: releaseScript.includes("start_worker_for_live_release"),
    bundleHasWorkerStartHelper: bundleReleaseScript.includes("start_worker_for_live_release"),
    releaseStartsBeforeRemotePublicVerify: startsWorkerBeforeRemotePublicVerify(releaseScript),
    bundleStartsBeforeRemotePublicVerify: startsWorkerBeforeRemotePublicVerify(bundleReleaseScript),
    releaseRequiresRemoteWorker: releaseScript.includes("REMOTE_REQUIRE_SYNC_WORKER=1"),
    bundleRequiresRemoteWorker: bundleReleaseScript.includes("REMOTE_REQUIRE_SYNC_WORKER=1")
  });

  pushCheck(checks, "signed release holds a fresh completed worker cycle idle across strict readiness", waitsForCurrentWorkerIdleAndFreezesAcrossReadiness(bundleReleaseScript)
    && bundleReleaseScript.includes("officialPublishEvidenceAfter")
    && bundleReleaseScript.includes("readinessIdleEvidenceAfter")
    && bundleReleaseScript.includes('eventCycle?.phase === "official-result-published"') === false
    && bundleReleaseScript.includes('rollback "sync worker failed to publish official results for this release"')
    && bundleReleaseScript.includes('rollback "sync worker failed to reach readiness-safe idle for this release"')
    && bundleReleaseScript.includes("RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS")
    && bundleReleaseScript.includes("RELEASE_WORKER_READINESS_IDLE_TIMEOUT_SECONDS")
    && bundleReleaseScript.includes("--signal=SIGSTOP")
    && bundleReleaseScript.includes("--signal=SIGCONT")
    && bundleReleaseScript.includes("WORKER_FROZEN_FOR_READINESS"), {
      workerStartsBeforeEvidence: waitsForCurrentWorkerIdleAndFreezesAcrossReadiness(bundleReleaseScript),
      usesWorkerEvidenceHelper: bundleReleaseScript.includes("officialPublishEvidenceAfter"),
      usesWorkerIdleHelper: bundleReleaseScript.includes("readinessIdleEvidenceAfter"),
      rejectsInlineStatusGuessing: !bundleReleaseScript.includes('eventCycle?.phase === "official-result-published"'),
      rollsBackOnMissingPublication: bundleReleaseScript.includes('rollback "sync worker failed to publish official results for this release"'),
      rollsBackOnMissingIdle: bundleReleaseScript.includes('rollback "sync worker failed to reach readiness-safe idle for this release"'),
      hasBoundedWait: bundleReleaseScript.includes("RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS")
        && bundleReleaseScript.includes("RELEASE_WORKER_READINESS_IDLE_TIMEOUT_SECONDS"),
      freezesAcrossReadiness: bundleReleaseScript.includes("--signal=SIGSTOP")
        && bundleReleaseScript.includes("--signal=SIGCONT")
    });

  pushCheck(checks, "bundle release consumes a root-private trusted tree, isolates builds, and rolls back", bundleReleaseScript.includes("TRUSTED_SOURCE_DIR")
    && bundleReleaseScript.includes(".release-trusted-sha256")
    && bundleReleaseScript.includes("systemd-run --quiet --wait --collect --pipe")
    && bundleReleaseScript.includes("assert_transient_unit_cleared")
    && bundleReleaseScript.includes("assert_build_user_quiescent")
    && bundleReleaseScript.includes("npm-ci")
    && bundleReleaseScript.includes("ci --include=dev --ignore-scripts")
    && bundleReleaseScript.includes("prune --omit=dev --ignore-scripts")
    && bundleReleaseScript.includes("validate_build_artifacts")
    && bundleReleaseScript.includes("assemble_final_tree")
    && bundleReleaseScript.includes("cp -a --no-dereference")
    && bundleReleaseScript.includes("symlink escapes node_modules")
    && bundleReleaseScript.includes("group/world-writable artifact")
    && bundleReleaseScript.includes('install_systemd_units "$NEXT_DIR"')
    && bundleReleaseScript.includes('install_nginx_config "$NEXT_DIR"')
    && bundleReleaseScript.includes("CANDIDATE_SQLITE_PATH")
    && bundleReleaseScript.includes("VERIFY_BASE_URL=\"http://${HOST}:${CANDIDATE_PORT}\"")
    && bundleReleaseScript.includes("scripts/verifyProductionReadiness.cjs")
    && bundleReleaseScript.includes("REMOTE_BASE_URL=\"$PUBLIC_BASE_URL\"")
    && bundleReleaseScript.includes("REMOTE_REQUIRE_HEALTHY=0")
    && verifyRemotePublic.includes('pushCheck(checks, "v1 service ready", health.body?.status?.serviceOk === true')
    && bundleReleaseScript.includes("rollback \"public origin readiness failed\"")
    && bundleReleaseScript.includes("mv \"$APP_DIR\" \"$BACKUP_DIR\"")
    && bundleReleaseScript.includes("restore_app_tree_after_rollback")
    && bundleReleaseScript.includes("FAIL-STOP: BACKUP to APP move failed"), {
      consumesTrustedTree: bundleReleaseScript.includes("TRUSTED_SOURCE_DIR") && bundleReleaseScript.includes(".release-trusted-sha256"),
      transientBuildCgroups: bundleReleaseScript.includes("systemd-run --quiet --wait --collect --pipe") && bundleReleaseScript.includes("assert_transient_unit_cleared"),
      ignoresInstallScripts: bundleReleaseScript.includes("ci --include=dev --ignore-scripts"),
      prunesDevDependencies: bundleReleaseScript.includes("prune --omit=dev --ignore-scripts"),
      assemblesFromAllowlistedArtifacts: bundleReleaseScript.includes("validate_build_artifacts") && bundleReleaseScript.includes("assemble_final_tree"),
      verifiesCandidate: bundleReleaseScript.includes("VERIFY_BASE_URL=\"http://${HOST}:${CANDIDATE_PORT}\""),
      verifiesRemotePublic: bundleReleaseScript.includes("REMOTE_BASE_URL=\"$PUBLIC_BASE_URL\""),
      requiresRemoteService: bundleReleaseScript.includes("REMOTE_REQUIRE_HEALTHY=0")
        && verifyRemotePublic.includes('pushCheck(checks, "v1 service ready", health.body?.status?.serviceOk === true'),
      rollsBack: bundleReleaseScript.includes("restore_app_tree_after_rollback")
        && bundleReleaseScript.includes("FAIL-STOP: BACKUP to APP move failed")
    });

  const productionReadinessRunIndex = verifyProductionReadiness.indexOf("const run = async () =>");
  const migrationPlanCheckIndex = verifyProductionReadiness.indexOf("scripts/verifyPostgresMigrationPlan.cjs");
  const mutableReadinessCheckIndex = verifyProductionReadiness.indexOf("await refreshSqliteBeforeLocalServer(checks)");
  pushCheck(checks, "PostgreSQL migration immutability fails before candidate mutation and atomic swap",
    productionReadinessRunIndex >= 0
      && migrationPlanCheckIndex > productionReadinessRunIndex
      && mutableReadinessCheckIndex > migrationPlanCheckIndex
      && verifyProductionReadiness.includes("PostgreSQL applied migrations remain immutable")
      && bundleReleaseScript.includes("run_build_step postgres-migration-plan")
      && bundleReleaseScript.includes("candidate PostgreSQL migration immutability verification failed"), {
      productionReadinessRunIndex,
      migrationPlanCheckIndex,
      mutableReadinessCheckIndex,
      releasePreflightWired: bundleReleaseScript.includes("run_build_step postgres-migration-plan"),
    });

  pushCheck(checks, "bundle deploy recovers ssh-interrupted releases", deployReleaseBundle.includes("remote release recovery check")
    && deployReleaseBundle.includes(".release-bundle-sha256")
    && deployReleaseBundle.includes(".release-live-complete")
    && deployReleaseBundle.includes('remoteStatusKv.status === "complete"')
    && deployReleaseBundle.includes('remoteStatusKv.ok === "1"')
    && deployReleaseBundle.includes('REMOTE_REQUIRE_HEALTHY: "0"')
    && verifyRemotePublic.includes('pushCheck(checks, "v1 service ready", health.body?.status?.serviceOk === true')
    && deployReleaseBundle.includes("liveCompleteMatches")
    && deployReleaseBundle.includes("REMOTE_REQUIRE_SYNC_WORKER")
    && deployReleaseBundle.includes("verifyRemotePublicReadiness.cjs")
    && deployReleaseBundle.includes("remoteReleaseLogPath")
    && bundleReleaseScript.includes(".release-bundle-sha256")
    && bundleReleaseScript.includes(".release-live-complete")
    && releaseWrapper.includes('write_status "running"')
    && releaseWrapper.includes('write_status "failed"')
    && releaseWrapper.includes('write_status "complete"')
    && !bundleReleaseScript.includes("RELEASE_STATUS_FILE")
    && deployReleaseBundle.includes('remoteStatusDir = "/var/lib/football-release/status"')
    && deployReleaseBundle.includes('remoteEntrypoint = "/usr/local/sbin/football-release"')
    && !deployReleaseBundle.includes("RELEASE_STATUS_FILE="), {
      hasRecoveryCheck: deployReleaseBundle.includes("remote release recovery check"),
      checksMarker: deployReleaseBundle.includes(".release-bundle-sha256"),
      checksLiveComplete: deployReleaseBundle.includes(".release-live-complete") && deployReleaseBundle.includes("liveCompleteMatches"),
      requiresCompleteRemoteStatus: deployReleaseBundle.includes('remoteStatusKv.status === "complete"')
        && deployReleaseBundle.includes('remoteStatusKv.ok === "1"'),
      verifiesRemotePublic: deployReleaseBundle.includes("verifyRemotePublicReadiness.cjs"),
      requiresSyncWorker: deployReleaseBundle.includes("REMOTE_REQUIRE_SYNC_WORKER"),
      hasRemoteLog: deployReleaseBundle.includes("remoteReleaseLogPath"),
      bundleWritesMarker: bundleReleaseScript.includes(".release-bundle-sha256"),
      bundleWritesLiveComplete: bundleReleaseScript.includes(".release-live-complete"),
      wrapperAloneCommitsRemoteStatus: releaseWrapper.includes('write_status "complete"')
        && !bundleReleaseScript.includes("RELEASE_STATUS_FILE"),
      wrapperOwnsStatusPath: deployReleaseBundle.includes('remoteStatusDir = "/var/lib/football-release/status"'),
      callerCannotOverrideStatusPath: !deployReleaseBundle.includes("RELEASE_STATUS_FILE=")
    });

  pushCheck(checks, "signed release entrypoints replace passwordless shell execution", Boolean(packageJson.scripts?.["verify:signed-release-entrypoints"])
    && createReleaseBundle.includes("signManifestBytes")
    && deployReleaseBundle.includes("verifyManifestSignature")
    && deployReleaseBundle.includes('remoteEntrypoint = "/usr/local/sbin/football-release"')
    && !deployReleaseBundle.includes("sudo -n true")
    && !deployReleaseBundle.includes("sudo mv")
    && !deployReleaseBundle.includes("remoteReleaseScriptPath")
    && releaseSigning.includes("rsa-sha256-pkcs1-v1_5")
    && releaseWrapper.includes("openssl dgst -sha256 -verify")
    && releaseWrapper.includes("assert_regular_upload")
    && relayPromoter.includes('TARGET="/var/lib/football-predict/sporttery-relay-snapshot.json"')
    && releaseBootstrap.includes("sudoers was NOT installed")
    && releaseBootstrap.includes('RECOVERY_CURRENT_PATH="/var/lib/football-release/recovery/current"')
    && releaseBootstrap.includes("recovery transaction pending; run the fixed recovery entrypoint before bootstrap")
    && releaseSudoers.includes("NOPASSWD: NOSETENV:")
    && !releaseSudoers.includes("NOPASSWD: ALL")
    && signedEntrypointsVerifier.includes("tampered manifest is rejected"), {
      hasPackageVerifier: Boolean(packageJson.scripts?.["verify:signed-release-entrypoints"]),
      createsSignature: createReleaseBundle.includes("signManifestBytes"),
      verifiesLocally: deployReleaseBundle.includes("verifyManifestSignature"),
      usesFixedRemoteEntrypoint: deployReleaseBundle.includes('remoteEntrypoint = "/usr/local/sbin/football-release"'),
      mutableRemoteScriptRemoved: !deployReleaseBundle.includes("remoteReleaseScriptPath"),
      unrestrictedSudoProbeRemoved: !deployReleaseBundle.includes("sudo -n true"),
      sudoMoveRemoved: !deployReleaseBundle.includes("sudo mv"),
      bootstrapLeavesSudoersManual: releaseBootstrap.includes("sudoers was NOT installed")
    });

  pushCheck(checks, "cold release recovery is fixed-code, fail-stop, and behaviorally gated",
    packageJson.scripts?.["release:recover"] === "node scripts/deployReleaseBundle.cjs --recover"
      && packageJson.scripts?.["verify:release-recovery"] === "node scripts/verifyReleaseRecovery.cjs"
      && releaseWrapper.includes('if [ "${1:-}" = "--recover" ]')
      && releaseWrapper.includes('RECOVERY_HELPER="/usr/local/libexec/football-release-recovery.cjs"')
      && releaseWrapper.includes('RELEASE_SEQUENCE="$MANIFEST_SEQUENCE"')
      && releaseBootstrap.includes("/usr/local/libexec/football-release-recovery.cjs")
      && releaseSudoers.includes("/usr/local/sbin/football-release --recover")
      && deployReleaseBundle.indexOf("if (recoverMode)") < deployReleaseBundle.indexOf("const bundlePath = latestBundlePath()")
      && deployReleaseBundle.includes("recoveryPending=0")
      && [
        'REMOTE_REQUIRE_SQLITE: recoveredNativeStorage ? "0" : "1"',
        'REMOTE_REQUIRE_POSTGRES_ONLY: recoveredNativeStorage ? "1" : "0"',
        'REMOTE_REQUIRED_READ_SOURCE: recoveredNativeStorage ? "postgres" : ""',
        'recoveryStorage=postgres-only'
      ].every(token => deployReleaseBundle.includes(token))
      && deployReleaseBundle.includes('REMOTE_REQUIRE_SYNC_WORKER: "1"')
      && releaseRecoveryHelper.includes("const TRANSACTION_VERSION = 3")
      && releaseRecoveryHelper.includes('treeMarker: readTreeMarker(mapped, ".release-tree-identity")')
      && releaseRecoveryHelper.includes("value !== identity.treeMarker")
      && releaseRecoveryHelper.includes("prevalidateRestoreTargets")
      && releaseRecoveryHelper.includes("isolateKnownFailedTree")
      && releaseRecoveryVerifier.includes("tampered snapshot must be rejected")
      && releaseRecoveryVerifier.includes("unexpected tree nonce must be rejected")
      && releaseRecoveryVerifier.includes("committed recovery must never roll back APP"), {
      releaseRecoverScript: packageJson.scripts?.["release:recover"] || null,
      verifierScript: packageJson.scripts?.["verify:release-recovery"] || null,
      helperInstalledByBootstrap: releaseBootstrap.includes("/usr/local/libexec/football-release-recovery.cjs"),
      sudoersAllowsOnlyFixedRecover: releaseSudoers.includes("/usr/local/sbin/football-release --recover"),
      deployBranchesBeforeBundleRead: deployReleaseBundle.indexOf("if (recoverMode)") < deployReleaseBundle.indexOf("const bundlePath = latestBundlePath()")
    });

  pushCheck(checks, "short-lived QA access is a signed fixed operator with narrow sudo scope",
    packageJson.scripts?.["verify:qa-access-operator"] === "node scripts/verifyQaAccessOperator.cjs"
      && qaAccessOperator.includes('ttlSeconds: 900')
      && qaAccessOperator.includes('qaLabelPattern')
      && qaAccessOperator.includes('target.hostname !== "127.0.0.1"')
      && qaAccessOperator.includes('process.getuid() !== 0')
      && bundleReleaseScript.includes("install_fixed_qa_access_operator")
      && bundleReleaseScript.includes("visudo -cf")
      && releaseSudoers.includes("FOOTBALL_QA_ACCESS")
      && releaseSudoers.includes("football-access-code-qa ^create[[:space:]]codex-qa-")
      && releaseSudoers.includes("football-access-code-qa ^revoke[[:space:]][0-9a-f-]{36}$")
      && !releaseSudoers.includes("NOPASSWD: ALL"), {
        helper: "deploy/light-server/football-access-code-qa.cjs",
        ttlSeconds: 900,
        sudoersNarrow: releaseSudoers.includes("FOOTBALL_QA_ACCESS")
      });

  pushCheck(checks, "relay promotion is serialized, content-counted, and rollback-safe", packageJson.scripts?.["verify:cleanup-relay-hardening"] === "node scripts/verifyCleanupRelayHardening.cjs"
    && relayPromoter.includes("flock -x 9")
    && relayPromoter.includes("summary.rows does not match endpoint payload rows")
    && relayPromoter.includes("summary.usableEndpoints does not match usable endpoints")
    && relayPromoter.includes("capturedAt must be strictly newer than the current target")
    && relayPromoter.includes("current relay target must have exactly one hard link")
    && relayPromoter.includes("fs.existsSync(currentPath)")
    && cleanupRelayHardeningVerifier.includes("relay rejects forged summary counts")
    && cleanupRelayHardeningVerifier.includes("relay rejects forged usable endpoint counts")
    && cleanupRelayHardeningVerifier.includes("relay rejects capturedAt rollback")
    && cleanupRelayHardeningVerifier.includes("state-directory cleanup still functions"), {
      packageVerifier: packageJson.scripts?.["verify:cleanup-relay-hardening"] || null,
      serialized: relayPromoter.includes("flock -x 9"),
      recomputesRows: relayPromoter.includes("summary.rows does not match endpoint payload rows"),
      recomputesUsableEndpoints: relayPromoter.includes("summary.usableEndpoints does not match usable endpoints"),
      rejectsRollback: relayPromoter.includes("capturedAt must be strictly newer than the current target"),
      validatesCurrentTarget: relayPromoter.includes("current relay target must have exactly one hard link"),
      hasBehavioralVerifier: cleanupRelayHardeningVerifier.includes("relay rejects capturedAt rollback")
        && cleanupRelayHardeningVerifier.includes("state-directory cleanup still functions")
    });

  pushCheck(checks, "cleanup and relay hardening behavioral verifier passes", cleanupRelayHardeningRun.status === 0
    && cleanupRelayHardeningPayload?.ok === true, {
      status: cleanupRelayHardeningRun.status,
      checks: Array.isArray(cleanupRelayHardeningPayload?.checks) ? cleanupRelayHardeningPayload.checks.length : null,
      stderr: cleanupRelayHardeningRun.stderr.trim().slice(-500),
      stdoutTail: cleanupRelayHardeningRun.status === 0 ? "" : cleanupRelayHardeningRun.stdout.slice(-500)
    });

  pushCheck(checks, "SSH operator-key recovery is narrow and behaviorally gated",
    packageJson.scripts?.["verify:ssh-key-recovery"] === "node scripts/verifySshOperatorKeyRecovery.cjs"
      && sshOperatorKeyRecoveryVerifier.includes("recovery entrypoint embeds no operator key material")
      && sshOperatorKeyRecoveryVerifier.includes("recovery does not loosen ssh, firewall, or password policy")
      && sshOperatorKeyRecoveryRun.status === 0
      && sshOperatorKeyRecoveryPayload?.ok === true, {
      packageVerifier: packageJson.scripts?.["verify:ssh-key-recovery"] || null,
      status: sshOperatorKeyRecoveryRun.status,
      checks: Array.isArray(sshOperatorKeyRecoveryPayload?.checks) ? sshOperatorKeyRecoveryPayload.checks.length : null,
      stderr: sshOperatorKeyRecoveryRun.stderr.trim().slice(-500),
      stdoutTail: sshOperatorKeyRecoveryRun.status === 0 ? "" : sshOperatorKeyRecoveryRun.stdout.slice(-500)
    });

  pushCheck(checks, "remote public readiness guards fallback runway", verifyRemotePublic.includes("REMOTE_MIN_FALLBACK_RUNWAY_SECONDS")
    && verifyRemotePublic.includes("fallback reliability runway")
    && verifyRemotePublic.includes("evaluateFallbackReadiness")
    && runtimeMonitor.includes("evaluateFallbackReadiness")
    && packageJson.scripts?.["verify:fallback-readiness"] === "node scripts/verifyFallbackReadiness.cjs"
    && fallbackReadinessRun.status === 0
    && fallbackReadinessPayload?.ok === true, {
      hasRunwayEnv: verifyRemotePublic.includes("REMOTE_MIN_FALLBACK_RUNWAY_SECONDS"),
      checksRunway: verifyRemotePublic.includes("fallback reliability runway"),
      sharedRemotePredicate: verifyRemotePublic.includes("evaluateFallbackReadiness"),
      sharedMonitorPredicate: runtimeMonitor.includes("evaluateFallbackReadiness"),
      packageVerifier: packageJson.scripts?.["verify:fallback-readiness"] || null,
      verifierStatus: fallbackReadinessRun.status,
      verifierAssertions: fallbackReadinessPayload?.assertions ?? null,
      verifierStderr: fallbackReadinessRun.stderr.trim().slice(-500)
    });

  pushCheck(checks, "production readiness accepts serviceable fallback sqlite", verifyProductionReadiness.includes("sqliteServiceable")
    && verifyProductionReadiness.includes("healthStatus.dataFresh")
    && verifyProductionReadiness.includes("healthStatus.fallbackDataFresh")
    && verifyProductionReadiness.includes("runtimeStoreEnv")
    && verifyProductionReadiness.includes("verifyModelPromotionGate.cjs\"], runtimeStoreEnv")
    && verifyProductionReadiness.includes("verifyModelInputAudit.cjs\"], runtimeStoreEnv")
    && verifyProductionReadiness.includes("servingMode"), {
      hasSqliteServiceableGate: verifyProductionReadiness.includes("sqliteServiceable"),
      checksHealthDataFresh: verifyProductionReadiness.includes("healthStatus.dataFresh"),
      checksFallbackDataFresh: verifyProductionReadiness.includes("healthStatus.fallbackDataFresh"),
      passesRuntimeStoreToModelAudits: verifyProductionReadiness.includes("runtimeStoreEnv")
        && verifyProductionReadiness.includes("verifyModelPromotionGate.cjs\"], runtimeStoreEnv")
        && verifyProductionReadiness.includes("verifyModelInputAudit.cjs\"], runtimeStoreEnv"),
      reportsServingMode: verifyProductionReadiness.includes("servingMode")
    });

  pushCheck(checks, "production plan coverage reads production sqlite path", verifyProductionPlanCoverage.includes("/var/lib/football-predict")
    && verifyProductionPlanCoverage.includes("productionSqlitePath")
    && verifyProductionPlanCoverage.includes("defaultStoreDir")
    && verifyProductionPlanCoverage.includes("fs.existsSync(productionSqlitePath)")
    && verifyProductionPlanCoverage.includes("readHealthSqliteStatus")
    && verifyProductionPlanCoverage.includes("positiveRuntimeCounts"), {
      hasProductionStorePath: verifyProductionPlanCoverage.includes("/var/lib/football-predict"),
      hasProductionSqliteProbe: verifyProductionPlanCoverage.includes("productionSqlitePath"),
      hasLocalFallback: verifyProductionPlanCoverage.includes("defaultStoreDir"),
      probesBeforeFallback: verifyProductionPlanCoverage.includes("fs.existsSync(productionSqlitePath)"),
      hasHealthFallback: verifyProductionPlanCoverage.includes("readHealthSqliteStatus"),
      checksPositiveCounts: verifyProductionPlanCoverage.includes("positiveRuntimeCounts")
    });

  pushCheck(checks, "release builds the frontend in production mode and rejects React development bundles",
    releaseScript.includes('NODE_ENV=production npm run build')
      && !releaseScript.includes('NODE_ENV=development npm run build')
      && bundleReleaseScript.includes('run_build_step application-build env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production')
      && !bundleReleaseScript.includes('run_build_step application-build env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=development')
      && bundleReleaseScript.includes("Download the React DevTools")
      && bundleReleaseScript.includes("Each child in a list should have a unique")
      && bundleReleaseScript.includes("module entry asset contains React development marker"), {
      legacyBuildProduction: releaseScript.includes('NODE_ENV=production npm run build'),
      bundleBuildProduction: bundleReleaseScript.includes('run_build_step application-build env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production'),
      rejectsReactDevelopmentMarkers: bundleReleaseScript.includes("module entry asset contains React development marker")
    });

  pushCheck(checks, "runtime source health selects the newest relay collector state",
    serverIndex.includes("relayCollectorStateTimestampMs")
      && serverIndex.includes("latestRelayCollectorState")
      && serverIndex.includes("receivedAt: state.receivedAt || null")
      && serverIndex.includes("uploadedRelayCollectorStateMtimeMs")
      && serverIndex.includes("state: fileRelaySnapshotSummary?.collectorState || null")
      && !serverIndex.includes("uploadedRelayCollectorState || fileRelaySnapshotSummary.collectorState"), {
      hasTimestampSelector: serverIndex.includes("relayCollectorStateTimestampMs")
        && serverIndex.includes("latestRelayCollectorState"),
      keepsReceivedAt: serverIndex.includes("receivedAt: state.receivedAt || null"),
      usesStateFileMtime: serverIndex.includes("uploadedRelayCollectorStateMtimeMs"),
      oldUnconditionalPrecedenceRemoved: !serverIndex.includes("uploadedRelayCollectorState || fileRelaySnapshotSummary.collectorState")
    });

  pushCheck(checks, "production odds history loads the freshest canonical or compatibility store",
    syncData.includes('require("./oddsHistoryStore.cjs")')
      && !syncData.includes('function loadOddsHistory(publicDir)')
      && oddsHistoryStore.includes('path.join(publicDir, "data", "odds-history.json")')
      && oddsHistoryStore.includes('path.join(publicDir, "odds-history.json")')
      && oddsHistoryStore.includes("freshnessMs")
      && oddsHistoryStore.includes("left.priority - right.priority"), {
      usesSharedStore: syncData.includes('require("./oddsHistoryStore.cjs")'),
      prefersCanonicalOnTie: oddsHistoryStore.includes("left.priority - right.priority"),
      selectsFreshestPayload: oddsHistoryStore.includes("freshnessMs")
    });

  pushCheck(checks, "remote public readiness verifies frontend assets", verifyRemotePublic.includes("requestText")
    && verifyRemotePublic.includes("frontend asset runtime recovers stale match detail errors")
    && verifyRemotePublic.includes("match detail chunk probability resilience")
    && verifyRemotePublic.includes("football.assetReloadAt")
    && verifyRemotePublic.includes("over25|under25|bttsYes|bttsNo|goalLines|bothTeamsToScore|probabilities")
    && verifyRemotePublic.includes("__assetReload")
    && verifyRemotePublic.includes("location.replace")
    && verifyRemotePublic.includes("frontend bundle uses the React production runtime")
    && verifyRemotePublic.includes("Download the React DevTools")
    && verifyRemotePublic.includes("missing static assets are not cached as immutable"), {
      fetchesTextAssets: verifyRemotePublic.includes("requestText"),
      checksRuntimeRecovery: verifyRemotePublic.includes("frontend asset runtime recovers stale match detail errors"),
      checksMatchDetailChunk: verifyRemotePublic.includes("match detail chunk probability resilience"),
      checksReloadGuard: verifyRemotePublic.includes("football.assetReloadAt"),
      checksProbabilityShapeGuard: verifyRemotePublic.includes("over25|under25|bttsYes|bttsNo|goalLines|bothTeamsToScore|probabilities"),
      checksCacheBustRecovery: verifyRemotePublic.includes("__assetReload") && verifyRemotePublic.includes("location.replace"),
      checksReactProductionRuntime: verifyRemotePublic.includes("frontend bundle uses the React production runtime")
        && verifyRemotePublic.includes("Download the React DevTools"),
      checksNegativeAssetCaching: verifyRemotePublic.includes("missing static assets are not cached as immutable")
    });

  pushCheck(checks, "remote public readiness reconciles relay and signed-store collector domains",
    verifyRemotePublic.includes("sporttery-recent-collector-evidence-summary-v1")
      && verifyRemotePublic.includes("storeIndependenceDomains")
      && verifyRemotePublic.includes("combinedIndependenceDomains")
      && verifyRemotePublic.includes("redundancyIndependenceDomains")
      && verifyRemotePublic.includes("recentCollectorEvidenceStore?.trustRegistryAvailable === true")
      && verifyRemotePublic.includes("redundancyCollectorCount === combinedIndependenceDomains.length"), {
      checksSignedStoreSummary: verifyRemotePublic.includes(
        "sporttery-recent-collector-evidence-summary-v1",
      ),
      combinesIndependenceDomains: verifyRemotePublic.includes("combinedIndependenceDomains"),
      checksPublishedDomains: verifyRemotePublic.includes("redundancyIndependenceDomains"),
      requiresTrustedRegistry: verifyRemotePublic.includes(
        "recentCollectorEvidenceStore?.trustRegistryAvailable === true",
      ),
      reconcilesPublishedCount: verifyRemotePublic.includes(
        "redundancyCollectorCount === combinedIndependenceDomains.length",
      ),
    });

  pushCheck(checks, "remote public readiness keeps prospective sample capture alive",
    verifyRemotePublic.includes("candidate prospective cutoff heartbeat is live and unblocked")
      && verifyRemotePublic.includes('publicCandidateProspective?.state === "ACTIVE"')
      && verifyRemotePublic.includes('"prospective-deadline-heartbeat-v2"')
      && verifyRemotePublic.includes('"candidate-prospective-readiness-preview-v2"')
      && verifyRemotePublic.includes(
        "candidateDueCaptureEventsAdded === candidateDueMatches",
      )
      && verifyRemotePublic.includes(
        "candidateDueAtomicDecisionEventsAdded === candidateDueDecisionEventsAdded",
      )
      && verifyRemotePublic.includes(
        "candidateCaptureHeartbeat?.dueCaptureComplete === true",
      )
      && verifyRemotePublic.includes('"deadline-cohort-evaluated"')
      && verifyRemotePublic.includes("candidateBlocked === 0")
      && verifyRemotePublic.includes("candidateExcluded >= 0")
      && verifyRemotePublic.includes(
        "+ candidateExcluded"
      ), {
      checksActiveLedger:
        verifyRemotePublic.includes('publicCandidateProspective?.state === "ACTIVE"'),
      checksFreshHeartbeat:
        verifyRemotePublic.includes("candidateCaptureHeartbeat?.fresh === true"),
      checksNoBlockedUpcoming:
        verifyRemotePublic.includes("candidateBlocked === 0"),
      checksDueCaptureCompletion:
        verifyRemotePublic.includes(
          "candidateDueCaptureEventsAdded === candidateDueMatches",
        )
        && verifyRemotePublic.includes(
          "candidateDueAtomicDecisionEventsAdded === candidateDueDecisionEventsAdded",
        )
        && verifyRemotePublic.includes(
          "candidateCaptureHeartbeat?.dueCaptureComplete === true",
        )
        && verifyRemotePublic.includes('"deadline-cohort-evaluated"'),
      reconcilesReadinessDenominator:
        verifyRemotePublic.includes(
          "+ candidateExcluded"
        ),
    });

  pushCheck(checks, "release scripts refresh live sqlite once and skip duplicate post-health refresh by default", releaseScript.includes("refresh_live_store_after_swap")
    && bundleReleaseScript.includes("refresh_live_store_after_swap")
    && releaseScript.includes("RELEASE_EXPORT_LIVE_SQLITE:-always")
    && bundleReleaseScript.includes("RELEASE_EXPORT_LIVE_SQLITE:-always")
    && releaseScript.includes("npm run datastore:sqlite")
    && bundleReleaseScript.includes("npm run datastore:sqlite")
    && releaseScript.includes('RELEASE_REFRESH_AFTER_HEALTH:-0')
    && bundleReleaseScript.includes('RELEASE_REFRESH_AFTER_HEALTH:-0')
    && releaseScript.includes("skip post-health live sqlite refresh")
    && bundleReleaseScript.includes("skip post-health live sqlite refresh")
    && releaseScript.includes("post-health live store refresh failed")
    && bundleReleaseScript.includes("post-health live store refresh failed")
    && releaseScript.includes("post-refresh health failed")
    && bundleReleaseScript.includes("post-refresh health failed")
    && releaseScript.includes("preserve existing live sqlite")
    && bundleReleaseScript.includes("preserve existing live sqlite"), {
      releaseHasRefreshFunction: releaseScript.includes("refresh_live_store_after_swap"),
      bundleHasRefreshFunction: bundleReleaseScript.includes("refresh_live_store_after_swap"),
      releaseDefaultRefresh: releaseScript.includes("RELEASE_EXPORT_LIVE_SQLITE:-always"),
      bundleDefaultRefresh: bundleReleaseScript.includes("RELEASE_EXPORT_LIVE_SQLITE:-always"),
      releasePostHealthRefreshDefaultOff: releaseScript.includes('RELEASE_REFRESH_AFTER_HEALTH:-0'),
      bundlePostHealthRefreshDefaultOff: bundleReleaseScript.includes('RELEASE_REFRESH_AFTER_HEALTH:-0'),
      releasePostHealthManualOverride: releaseScript.includes("post-health live store refresh failed"),
      bundlePostHealthManualOverride: bundleReleaseScript.includes("post-health live store refresh failed"),
      preserveOverride: releaseScript.includes("export_mode\" = \"preserve") && bundleReleaseScript.includes("export_mode\" = \"preserve")
    });

  pushCheck(checks, "offline release kit supports no-ssh console recovery", Boolean(packageJson.scripts?.["release:offline-kit"])
    && offlineReleaseKit.includes("football-offline-release-kit-")
    && offlineReleaseKit.includes("release bundle is older than current workspace changes")
    && offlineReleaseKit.includes("README-server-console.md")
    && offlineReleaseKit.includes("sha256sum -c")
    && offlineReleaseKit.includes("BUNDLE_SHA256")
    && offlineReleaseKit.includes("release-from-bundle.sh"), {
      hasPackageScript: Boolean(packageJson.scripts?.["release:offline-kit"]),
      hasFreshnessGate: offlineReleaseKit.includes("release bundle is older than current workspace changes"),
      hasConsoleReadme: offlineReleaseKit.includes("README-server-console.md"),
      verifiesSha256: offlineReleaseKit.includes("sha256sum -c"),
      usesBundleReleaseScript: offlineReleaseKit.includes("release-from-bundle.sh")
    });

  pushCheck(checks, "release watch waits for deploy window safely", Boolean(packageJson.scripts?.["release:watch"])
    && packageJson.scripts?.["verify:release-watch"] === "node scripts/verifyReleaseWatchPolicy.cjs"
    && watchReleaseWindow.includes("RELEASE_WATCH_AUTO_DEPLOY")
    && watchReleaseWindow.includes("scripts/checkReleaseStatus.cjs")
    && watchReleaseWindow.includes("canAttemptDeploy")
    && watchReleaseWindow.includes("isLocalCandidateLive")
    && watchReleaseWindow.includes("remoteRelease?.ok === true")
    && watchReleaseWindow.includes("matchesLocalCandidate === true")
    && watchReleaseWindow.includes("remoteSha256 === localSha256")
    && watchReleaseWindow.includes("scripts/deployReleaseBundle.cjs")
    && watchReleaseWindow.includes("REMOTE_REQUIRE_SQLITE")
    && watchReleaseWindow.includes("auto deploy disabled"), {
      hasPackageScript: Boolean(packageJson.scripts?.["release:watch"]),
      hasBehaviorVerifierScript: packageJson.scripts?.["verify:release-watch"] === "node scripts/verifyReleaseWatchPolicy.cjs",
      explicitAutoDeploy: watchReleaseWindow.includes("RELEASE_WATCH_AUTO_DEPLOY"),
      checksStatusFirst: watchReleaseWindow.includes("scripts/checkReleaseStatus.cjs"),
      requiresCandidateMarker: watchReleaseWindow.includes("matchesLocalCandidate === true")
        && watchReleaseWindow.includes("remoteSha256 === localSha256")
        && watchReleaseWindow.includes("remoteRelease?.ok === true"),
      usesBundleDeploy: watchReleaseWindow.includes("scripts/deployReleaseBundle.cjs"),
      verifiesRemoteSqlite: watchReleaseWindow.includes("REMOTE_REQUIRE_SQLITE"),
      safeDefault: watchReleaseWindow.includes("auto deploy disabled")
    });

  pushCheck(checks, "release watch candidate identity is behaviorally gated", verifyReleaseWatchPolicy.includes("healthy old live release is not the local candidate")
    && verifyReleaseWatchPolicy.includes("old live release auto-deploys when the candidate window opens")
    && verifyReleaseWatchPolicy.includes("matching candidate marker completes the watch")
    && verifyReleaseWatchPolicy.includes("matchesLocalCandidate false cannot complete")
    && verifyProductionReadiness.includes("scripts/verifyReleaseWatchPolicy.cjs"), {
      coversOldLiveRelease: verifyReleaseWatchPolicy.includes("healthy old live release is not the local candidate"),
      coversDeployWindow: verifyReleaseWatchPolicy.includes("old live release auto-deploys when the candidate window opens"),
      coversMatchingCandidate: verifyReleaseWatchPolicy.includes("matching candidate marker completes the watch"),
      productionReadinessWired: verifyProductionReadiness.includes("scripts/verifyReleaseWatchPolicy.cjs")
    });

  pushCheck(checks, "release bundle excludes generated artifacts", createReleaseBundle.includes('"artifacts"')
    && createReleaseBundle.includes('normalized.startsWith("artifacts/")')
    && createReleaseBundle.includes('...listReleaseRootEntries(rootDir)')
    && createReleaseBundle.includes('normalized.startsWith("outputs/")'), {
      excludesArtifacts: createReleaseBundle.includes('"artifacts"'),
      blocksArtifactEntries: createReleaseBundle.includes('normalized.startsWith("artifacts/")'),
      excludesOutputs: createReleaseBundle.includes('...listReleaseRootEntries(rootDir)'),
      blocksOutputEntries: createReleaseBundle.includes('normalized.startsWith("outputs/")')
    });

  pushCheck(checks, "release bundle secret policy is enforced at every release boundary", Boolean(packageJson.scripts?.["verify:release-bundle"])
    && releaseBundlePolicy.includes("RELEASE_BUNDLE_POLICY_VERSION")
    && releaseBundlePolicy.includes("findSensitiveReleaseEntries")
    && releaseBundlePolicy.includes('".npmrc"')
    && releaseBundlePolicy.includes('".netrc"')
    && releaseBundlePolicy.includes('".pypirc"')
    && releaseBundlePolicy.includes('".docker"')
    && releaseBundlePolicy.includes('lowerPath.endsWith("/deploy/light-server/env")')
    && createReleaseBundle.includes("findSensitiveReleaseEntries")
    && verifyReleaseBundleSafety.includes("findSensitiveReleaseEntries")
    && deployReleaseBundle.includes("RELEASE_BUNDLE_POLICY_VERSION")
    && deployReleaseBundle.includes("inspectBundleEntries")
    && deployReleaseBundle.includes("inspectBundleEntrySha256")
    && deployReleaseBundle.includes("release-recovery-helper-mismatch")
    && checkReleaseStatus.includes("RELEASE_BUNDLE_POLICY_VERSION")
    && checkReleaseStatus.includes("inspectBundleEntries")
    && checkReleaseStatus.includes("checkRemoteRecoveryHelper")
    && offlineReleaseKit.includes("findSensitiveReleaseEntries")
    && bundleReleaseScript.includes("assert_bundle_has_no_sensitive_entries")
    && releaseScript.includes("assert_release_tree_has_no_sensitive_entries"), {
      hasPackageVerifier: Boolean(packageJson.scripts?.["verify:release-bundle"]),
      createScansEntries: createReleaseBundle.includes("findSensitiveReleaseEntries"),
      blocksPackageManagerCredentials: releaseBundlePolicy.includes('".npmrc"')
        && releaseBundlePolicy.includes('".netrc"')
        && releaseBundlePolicy.includes('".pypirc"'),
      blocksDockerCredentials: releaseBundlePolicy.includes('".docker"'),
      blocksWrappedArchivePaths: releaseBundlePolicy.includes('lowerPath.endsWith("/deploy/light-server/env")'),
      deployRescansEntries: deployReleaseBundle.includes("inspectBundleEntries"),
      statusRescansEntries: checkReleaseStatus.includes("inspectBundleEntries"),
      offlineKitRescansEntries: offlineReleaseKit.includes("findSensitiveReleaseEntries"),
      remoteBundleRejectsSensitiveEntries: bundleReleaseScript.includes("assert_bundle_has_no_sensitive_entries"),
      gitReleaseRejectsSensitiveEntries: releaseScript.includes("assert_release_tree_has_no_sensitive_entries")
    });

  pushCheck(checks, "production access placeholders fail closed without affecting development", serverIndex.includes('process.env.NODE_ENV === "production"')
    && serverIndex.includes("isUnsafeProductionSecret")
    && serverIndex.includes("unsafe production access secrets")
    && releaseScript.includes("assert_safe_production_secrets")
    && bundleReleaseScript.includes("assert_safe_production_secrets"), {
      runtimeProductionGuard: serverIndex.includes('process.env.NODE_ENV === "production"') && serverIndex.includes("isUnsafeProductionSecret"),
      gitReleasePreflight: releaseScript.includes("assert_safe_production_secrets"),
      bundleReleasePreflight: bundleReleaseScript.includes("assert_safe_production_secrets")
    });

  pushCheck(checks, "signed release SSH uses one explicit pinned host key and never TOFU", [
    "StrictHostKeyChecking=yes",
    "UserKnownHostsFile=",
    "GlobalKnownHostsFile=",
    "UpdateHostKeys=no",
    "IdentitiesOnly=yes",
    "HostKeyAlgorithms=",
    "RELEASE_DEPLOY_HOST_KEY_SHA256",
    "exactly one non-comment entry",
    "fingerprint does not match the explicit pin"
  ].every((token) => `${deployReleaseBundle}\n${checkReleaseStatus}\n${releaseSshHostKeyPin}`.includes(token))
    && !deployReleaseBundle.includes("StrictHostKeyChecking=accept-new")
    && !checkReleaseStatus.includes("StrictHostKeyChecking=accept-new")
    && !deployReleaseBundle.includes("StrictHostKeyChecking=no")
    && !checkReleaseStatus.includes("StrictHostKeyChecking=no")
    && packageJson.scripts?.["verify:release-host-key-pin"] === "node scripts/verifyReleaseSshHostKeyPin.cjs"
    && verifyReleaseSshHostKeyPin.includes("mismatched explicit fingerprint is rejected before SSH")
    && releaseSshHostKeyPinRun.status === 0
    && releaseSshHostKeyPinPayload?.ok === true
    && cloudPush.includes("StrictHostKeyChecking=accept-new")
    && !cloudPush.includes("StrictHostKeyChecking=no"), {
      deployPinned: deployReleaseBundle.includes("resolveReleaseSshHostKeyPin"),
      statusPinned: checkReleaseStatus.includes("resolveReleaseSshHostKeyPin"),
      deployTofuDisabled: !deployReleaseBundle.includes("StrictHostKeyChecking=accept-new"),
      statusTofuDisabled: !checkReleaseStatus.includes("StrictHostKeyChecking=accept-new"),
      verifierStatus: releaseSshHostKeyPinRun.status,
      verifierChecks: Array.isArray(releaseSshHostKeyPinPayload?.checks)
        ? releaseSshHostKeyPinPayload.checks.length
        : null,
      cloudPushAcceptNew: cloudPush.includes("StrictHostKeyChecking=accept-new"),
      cloudPushBlindTrustDisabled: !cloudPush.includes("StrictHostKeyChecking=no")
    });

  pushCheck(checks, "sync lock protects live owners and quickly recovers incomplete metadata", syncLock.includes('owner.status === "dead" || metadataOrphan')
    && syncLock.includes('ageMs > metadataGraceMs')
    && syncLock.includes('["missing", "invalid-pid"].includes(owner.status)')
    && syncLock.includes("SYNC_LOCK_METADATA_GRACE_SECONDS")
    && keyValue(envExample, "SYNC_LOCK_METADATA_GRACE_SECONDS") === "10"
    && !syncLock.includes("ageMs > staleMs || lockPidIsDead")
    && verifySyncLock.includes("live owner is not reclaimed after stale threshold")
    && verifySyncLock.includes("fresh empty lock is protected during metadata grace")
    && verifySyncLock.includes("empty lock is recovered after metadata grace"), {
      reclaimsDeadOwner: syncLock.includes('owner.status === "dead" || metadataOrphan'),
      metadataRecoveryLimitedToOrphans: syncLock.includes('["missing", "invalid-pid"].includes(owner.status)'),
      metadataGraceSeconds: keyValue(envExample, "SYNC_LOCK_METADATA_GRACE_SECONDS"),
      hasLiveOwnerRegression: verifySyncLock.includes("live owner is not reclaimed after stale threshold"),
      hasIncompleteMetadataRegressions: verifySyncLock.includes("fresh empty lock is protected during metadata grace")
        && verifySyncLock.includes("empty lock is recovered after metadata grace")
    });

  pushCheck(checks, "server cleanup is explicit and preserves production data", Boolean(packageJson.scripts?.["server:cleanup"])
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_APPLY")
    && cleanupServerArtifacts.includes("dryRun: !apply")
    && cleanupServerArtifacts.includes("isSafeTarget")
    && cleanupServerArtifacts.includes('path.join(storeDir, "football.db")')
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_APP_BACKUP_KEEP")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_RELEASE_ARCHIVE_KEEP")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_CURRENT_SNAPSHOT_KEEP")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_CURRENT_SNAPSHOT_UNCOMPRESSED_KEEP")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_DATA_BACKUP_COMPRESS_DAYS")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS")
    && cleanupServerArtifacts.includes("gzipStagedFile")
    && cleanupServerArtifacts.includes("stageCandidate")
    && cleanupServerArtifacts.includes("fs.renameSync(sourcePath, stagedPath)")
    && cleanupServerArtifacts.includes("cleanup apply is restricted to the state directory")
    && cleanupServerArtifacts.includes("collectReleaseArchiveCandidates")
    && cleanupServerArtifacts.includes("collectDistBackupCandidates")
    && cleanupServerArtifacts.includes("collectSqliteBackupCandidates")
    && cleanupServerArtifacts.includes("collectCurrentSnapshotCandidates")
    && cleanupServerArtifacts.includes("collectDataBackupCompressCandidates")
    && cleanupServerArtifacts.includes("collectAppArtifactCandidates")
    && cleanupServerArtifacts.includes("SERVER_CLEANUP_APP_ARTIFACTS")
    && cleanupServerArtifacts.includes("app-artifacts")
    && cleanupServerArtifacts.includes("football-cloud-data")
    && cleanupServerArtifacts.includes("tmp-diagnostic")
    && cleanupServerArtifacts.includes("football-cleanup-last.log")
    && cleanupServerArtifacts.includes("football-monitor-now.json")
    && cleanupServerArtifacts.includes("football-server-index.cjs")
    && cleanupServerArtifacts.includes("football-verify-live.json")
    && cleanupServerArtifacts.includes("appDir")
    && Number(keyValue(envExample, "SNAPSHOT_RETENTION_MAX_FILES") || 0) > 0
    && Number(keyValue(envExample, "SERVER_CLEANUP_CURRENT_SNAPSHOT_UNCOMPRESSED_KEEP") || 0) > 0
    && Number(keyValue(envExample, "SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS") || 0) > 0
    && keyValue(envExample, "SERVER_CLEANUP_APP_ARTIFACTS") === "1"
    && Number(keyValue(envExample, "SERVER_CLEANUP_DATA_BACKUP_COMPRESS_DAYS") || 0) > 0
    && Number(keyValue(envExample, "SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS") || 0) > 0, {
      hasPackageScript: Boolean(packageJson.scripts?.["server:cleanup"]),
      requiresApplyFlag: cleanupServerArtifacts.includes("SERVER_CLEANUP_APPLY") && cleanupServerArtifacts.includes("--apply"),
      hasSafetyGate: cleanupServerArtifacts.includes("isSafeTarget"),
      preservesSqlite: cleanupServerArtifacts.includes('path.join(storeDir, "football.db")'),
      hasBackupKeepPolicy: cleanupServerArtifacts.includes("SERVER_CLEANUP_APP_BACKUP_KEEP") && cleanupServerArtifacts.includes("SERVER_CLEANUP_RELEASE_ARCHIVE_KEEP"),
      prunesReleaseArchives: cleanupServerArtifacts.includes("collectReleaseArchiveCandidates"),
      prunesDistBackups: cleanupServerArtifacts.includes("collectDistBackupCandidates"),
      prunesSqliteBackups: cleanupServerArtifacts.includes("collectSqliteBackupCandidates"),
      prunesCurrentSnapshots: cleanupServerArtifacts.includes("collectCurrentSnapshotCandidates"),
      prunesAppArtifacts: cleanupServerArtifacts.includes("collectAppArtifactCandidates") && cleanupServerArtifacts.includes("app-artifacts"),
      compressesCurrentSnapshots: cleanupServerArtifacts.includes("current-snapshot-compress") && cleanupServerArtifacts.includes("SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS"),
      compressesDataBackups: cleanupServerArtifacts.includes("collectDataBackupCompressCandidates") && cleanupServerArtifacts.includes("gzipStagedFile"),
      stagesBeforeMutation: cleanupServerArtifacts.includes("stageCandidate") && cleanupServerArtifacts.includes("fs.renameSync(sourcePath, stagedPath)"),
      applyRestrictedToStateDirectory: cleanupServerArtifacts.includes("cleanup apply is restricted to the state directory"),
      compressesSqliteBackups: cleanupServerArtifacts.includes("SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS"),
      snapshotRetentionMaxFiles: keyValue(envExample, "SNAPSHOT_RETENTION_MAX_FILES") || null,
      currentSnapshotUncompressedKeep: keyValue(envExample, "SERVER_CLEANUP_CURRENT_SNAPSHOT_UNCOMPRESSED_KEEP") || null,
      currentSnapshotCompressAgeHours: keyValue(envExample, "SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS") || null,
      cleanupAppArtifacts: keyValue(envExample, "SERVER_CLEANUP_APP_ARTIFACTS") || null,
      dataBackupCompressDays: keyValue(envExample, "SERVER_CLEANUP_DATA_BACKUP_COMPRESS_DAYS") || null,
      sqliteBackupCompressDays: keyValue(envExample, "SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS") || null,
      prunesCloudSyncTmp: cleanupServerArtifacts.includes("football-cloud-data"),
      prunesDiagnosticTmp: cleanupServerArtifacts.includes("tmp-diagnostic")
        && cleanupServerArtifacts.includes("football-cleanup-last.log")
        && cleanupServerArtifacts.includes("football-monitor-now.json")
        && cleanupServerArtifacts.includes("football-server-index.cjs")
        && cleanupServerArtifacts.includes("football-verify-live.json")
    });

  pushCheck(checks, "server cleanup timer is installed as a conservative oneshot", cleanupService.includes("cleanupServerArtifacts.cjs")
    && cleanupService.includes("SERVER_CLEANUP_APPLY=1")
    && cleanupService.includes("SERVER_CLEANUP_APP_BACKUPS=0")
    && cleanupService.includes("SERVER_CLEANUP_APP_ARTIFACTS=0")
    && cleanupService.includes("SERVER_CLEANUP_TMP_ARTIFACTS=0")
    && cleanupService.includes("SERVER_CLEANUP_SYSTEM_LOGS=0")
    && cleanupService.includes("User=football")
    && cleanupService.includes("ReadWritePaths=/var/lib/football-predict")
    && cleanupService.includes("NoNewPrivileges=true")
    && cleanupTimer.includes("OnCalendar=")
    && cleanupTimer.includes("RandomizedDelaySec=")
    && cleanupTimer.includes("Persistent=true")
    && cleanupTimer.includes("Unit=football-cleanup.service"), {
      hasCleanupService: cleanupService.includes("cleanupServerArtifacts.cjs"),
      appliesExplicitly: cleanupService.includes("SERVER_CLEANUP_APPLY=1"),
      rootOwnedAppCleanupDisabled: cleanupService.includes("SERVER_CLEANUP_APP_BACKUPS=0")
        && cleanupService.includes("SERVER_CLEANUP_APP_ARTIFACTS=0"),
      hostTmpAndLogsDisabled: cleanupService.includes("SERVER_CLEANUP_TMP_ARTIFACTS=0")
        && cleanupService.includes("SERVER_CLEANUP_SYSTEM_LOGS=0"),
      runsAsFootball: cleanupService.includes("User=football"),
      writableStateDirectoryOnly: cleanupService.includes("ReadWritePaths=/var/lib/football-predict"),
      noNewPrivileges: cleanupService.includes("NoNewPrivileges=true"),
      hasCleanupTimer: cleanupTimer.includes("Unit=football-cleanup.service"),
      persistent: cleanupTimer.includes("Persistent=true")
    });

  pushCheck(checks, "runtime monitor covers live C-end dependencies", Boolean(packageJson.scripts?.["server:monitor"])
    && runtimeMonitor.includes('"/api/v1/health"')
    && runtimeMonitor.includes('"/api/v1/source-health"')
    && runtimeMonitor.includes('"/api/v1/model/evaluation"')
    && runtimeMonitor.includes("systemctl")
    && runtimeMonitor.includes("workerPausedForApiSync")
    && runtimeMonitor.includes("workerPausedForCloudSync")
    && runtimeMonitor.includes("allowLocalPushWorkerPause")
    && runtimeMonitor.includes("apiSyncRunning")
    && runtimeMonitor.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE")
    && runtimeMonitor.includes("football-sync-worker")
    && runtimeMonitor.includes("football-cleanup.timer")
    && runtimeMonitor.includes("football-monitor.timer")
    && runtimeMonitor.includes("df")
    && runtimeMonitor.includes("RUNTIME_MONITOR_DISK_WARN_PERCENT")
    && runtimeMonitor.includes("cleanupServerArtifacts.cjs")
    && runtimeMonitor.includes("health-monitor-status.json")
    && runtimeMonitor.includes("RUNTIME_MONITOR_AUTO_REPAIR_SQLITE")
    && runtimeMonitor.includes("sqlite auto-repair")
    && runtimeMonitor.includes("runSqliteRepairCommands")
    && runtimeMonitor.includes('runStep("sqlite", "exportDataStoreSqlite.cjs")')
    && runtimeMonitor.includes('runStep("projection", "syncPostgresProjection.cjs", ["--if-enabled"])')
    && runtimeMonitor.includes("acquireSyncLock")
    && runtimeMonitor.includes("sqlite-auto-repair")
    && runtimeMonitor.includes("RUNTIME_MONITOR_MIN_FALLBACK_RUNWAY_SECONDS")
    && runtimeMonitor.includes("fallback reliability runway")
    && runtimeMonitor.includes("RUNTIME_MONITOR_HTTP_ATTEMPTS")
    && runtimeMonitor.includes("previousAttempts")
    && runtimeMonitor.includes("sporttery relay trust level")
    && runtimeMonitor.includes("sportteryRelayTrustLevel")
    && runtimeMonitor.includes('addCheck("official source redundancy"')
    && runtimeMonitor.includes("officialSourceSinglePoint")
    && runtimeMonitor.includes('addCheck(\n    "candidate prospective capture"')
    && runtimeMonitor.includes("candidateProspectiveRuntimeState")
    && runtimeMonitor.includes("candidateAtomicReadyNow")
    && runtimeMonitor.includes("candidateDueUnrecorded")
    && runtimeMonitor.includes("candidate-readiness-full-coverage-denominator-mismatch")
    && runtimeMonitor.includes("candidate-readiness-detail-truncation-mismatch")
    && runtimeMonitor.includes("candidate-deadline-cohort-capture-incomplete")
    && runtimeMonitor.includes("candidate-deadline-cohort-atomic-incomplete")
    && monitorService.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0"), {
      hasPackageScript: Boolean(packageJson.scripts?.["server:monitor"]),
      checksHealth: runtimeMonitor.includes('"/api/v1/health"'),
      checksSourceHealth: runtimeMonitor.includes('"/api/v1/source-health"'),
      checksModelEvaluation: runtimeMonitor.includes('"/api/v1/model/evaluation"'),
      checksSystemd: runtimeMonitor.includes("systemctl") && runtimeMonitor.includes("football-sync-worker"),
      toleratesApiSyncWorkerPause: runtimeMonitor.includes("workerPausedForApiSync") && runtimeMonitor.includes("apiSyncRunning"),
      localPushWorkerPauseOptIn: runtimeMonitor.includes("allowLocalPushWorkerPause") && runtimeMonitor.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE"),
      monitorDisablesLocalPushPause: monitorService.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0"),
      checksCleanupTimer: runtimeMonitor.includes("football-cleanup.timer"),
      checksMonitorTimer: runtimeMonitor.includes("football-monitor.timer"),
      checksDisk: runtimeMonitor.includes("df") && runtimeMonitor.includes("RUNTIME_MONITOR_DISK_WARN_PERCENT"),
      checksCleanupDryRun: runtimeMonitor.includes("cleanupServerArtifacts.cjs"),
      autoRepairsSqlite: runtimeMonitor.includes("RUNTIME_MONITOR_AUTO_REPAIR_SQLITE") && runtimeMonitor.includes("sqlite auto-repair"),
      sqliteRepairUsesSyncLock: runtimeMonitor.includes("acquireSyncLock") && runtimeMonitor.includes("sqlite-auto-repair"),
      checksFallbackRunway: runtimeMonitor.includes("RUNTIME_MONITOR_MIN_FALLBACK_RUNWAY_SECONDS") && runtimeMonitor.includes("fallback reliability runway"),
      retriesHttpChecks: runtimeMonitor.includes("RUNTIME_MONITOR_HTTP_ATTEMPTS") && runtimeMonitor.includes("previousAttempts"),
      checksSportteryRelayTrust: runtimeMonitor.includes("sporttery relay trust level"),
      checksOfficialSourceRedundancy: runtimeMonitor.includes('addCheck("official source redundancy"'),
      checksCandidateProspectiveCapture:
        runtimeMonitor.includes("candidateProspectiveRuntimeState")
        && runtimeMonitor.includes("candidateAtomicReadyNow")
        && runtimeMonitor.includes("candidateDueUnrecorded")
        && runtimeMonitor.includes("candidate-readiness-full-coverage-denominator-mismatch")
        && runtimeMonitor.includes("candidate-readiness-detail-truncation-mismatch")
        && runtimeMonitor.includes("candidate-deadline-cohort-capture-incomplete")
        && runtimeMonitor.includes("candidate-deadline-cohort-atomic-incomplete"),
      writesStatus: runtimeMonitor.includes("health-monitor-status.json")
    });

  pushCheck(checks, "runtime monitor timer writes status as football user", monitorService.includes("checkServerRuntime.cjs")
    && monitorService.includes("RUNTIME_MONITOR_STATUS_PATH=/var/lib/football-predict/health-monitor-status.json")
    && monitorService.includes("RUNTIME_MONITOR_REQUIRE_SQLITE=1")
    && monitorService.includes("RUNTIME_MONITOR_AUTO_REPAIR_SQLITE=1")
    && monitorService.includes("RUNTIME_MONITOR_TIMEOUT_MS=15000")
    && monitorService.includes("RUNTIME_MONITOR_HTTP_ATTEMPTS=2")
    && monitorService.includes("RUNTIME_MONITOR_HTTP_RETRY_DELAY_MS=750")
    && monitorService.includes("RUNTIME_MONITOR_CHECK_CLEANUP=1")
    && monitorService.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0")
    && monitorService.includes("RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT=1")
    && monitorService.includes("RUNTIME_MONITOR_AUTH_FILE=/etc/football-predict/env")
    && monitorService.includes("User=football")
    && monitorService.includes("NoNewPrivileges=true")
    && monitorTimer.includes("OnUnitActiveSec=5m")
    && monitorTimer.includes("RandomizedDelaySec=")
    && monitorTimer.includes("Persistent=true")
    && monitorTimer.includes("Unit=football-monitor.service"), {
      hasMonitorService: monitorService.includes("checkServerRuntime.cjs"),
      statusPath: monitorService.includes("health-monitor-status.json"),
      autoRepairsSqlite: monitorService.includes("RUNTIME_MONITOR_AUTO_REPAIR_SQLITE=1"),
      requestTimeoutMs: monitorService.match(/RUNTIME_MONITOR_TIMEOUT_MS=([^\r\n]+)/)?.[1] || null,
      httpAttempts: monitorService.match(/RUNTIME_MONITOR_HTTP_ATTEMPTS=([^\r\n]+)/)?.[1] || null,
      requiresCandidateTemporalAudit: monitorService.includes("RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT=1"),
      authFile: monitorService.match(/RUNTIME_MONITOR_AUTH_FILE=([^\r\n]+)/)?.[1] || null,
      runsAsFootball: monitorService.includes("User=football"),
      noNewPrivileges: monitorService.includes("NoNewPrivileges=true"),
      hasTimer: monitorTimer.includes("Unit=football-monitor.service"),
      cadence: monitorTimer.match(/OnUnitActiveSec=([^\r\n]+)/)?.[1] || null,
      persistent: monitorTimer.includes("Persistent=true")
    });

  const monitorWantedUnits = unitDirectiveTokens(monitorService, "Wants");
  pushCheck(checks, "runtime monitor does not revive an intentionally quiesced sync worker", (
    monitorWantedUnits.includes("network-online.target")
    && monitorWantedUnits.includes("football-predict.service")
    && !monitorWantedUnits.includes("football-sync-worker.service")
  ), {
    wantedUnits: monitorWantedUnits,
    workerOrderedAfterMonitor: unitDirectiveTokens(monitorService, "After").includes("football-sync-worker.service")
  });

  pushCheck(checks, "release scripts install operational systemd units", ["football-cleanup.service", "football-cleanup.timer", "football-monitor.service", "football-monitor.timer"].every((unit) => releaseScript.includes(unit))
    && ["football-cleanup.service", "football-cleanup.timer", "football-monitor.service", "football-monitor.timer"].every((unit) => bundleReleaseScript.includes(unit)), {
      releaseHasCleanupTimer: releaseScript.includes("football-cleanup.timer"),
      releaseHasMonitorTimer: releaseScript.includes("football-monitor.timer"),
      bundleReleaseHasCleanupTimer: bundleReleaseScript.includes("football-cleanup.timer"),
      bundleReleaseHasMonitorTimer: bundleReleaseScript.includes("football-monitor.timer")
    });

  pushCheck(checks, "release scripts install and validate nginx config", releaseScript.includes("install_nginx_config")
    && releaseScript.includes("nginx -t")
    && releaseScript.includes("systemctl reload nginx")
    && releaseScript.includes("rm -f /etc/nginx/sites-enabled/default")
    && bundleReleaseScript.includes("install_nginx_config")
    && bundleReleaseScript.includes("nginx -t")
    && bundleReleaseScript.includes("systemctl reload nginx")
    && bundleReleaseScript.includes("remove_managed_path /etc/nginx/sites-enabled/default"), {
      releaseInstallsNginx: releaseScript.includes("install_nginx_config"),
      releaseTestsNginx: releaseScript.includes("nginx -t"),
      releaseReloadsNginx: releaseScript.includes("systemctl reload nginx"),
      bundleInstallsNginx: bundleReleaseScript.includes("install_nginx_config"),
      bundleTestsNginx: bundleReleaseScript.includes("nginx -t"),
      bundleReloadsNginx: bundleReleaseScript.includes("systemctl reload nginx"),
      releaseRemovesStockDefault: releaseScript.includes("rm -f /etc/nginx/sites-enabled/default"),
      bundleSnapshotsAndRemovesStockDefault: bundleReleaseScript.includes("remove_managed_path /etc/nginx/sites-enabled/default")
    });

  const releasePreservesHostTls = (text) => text.includes("/etc/nginx/conf.d/football-predict-common.conf")
    && text.includes("/etc/nginx/snippets/football-predict-server.conf")
    && text.includes("/etc/nginx/snippets/football-predict-security-headers.conf")
    && text.includes("/etc/nginx/sites-enabled/football-predict-tls")
    && text.includes("preserve enabled host-local TLS site")
    && text.includes("legacy monolithic nginx config detected")
    && !text.includes("install -m 0644 deploy/light-server/nginx-tls-site.conf.template");
  pushCheck(checks, "release updates managed Nginx includes without replacing host-local TLS", releasePreservesHostTls(releaseScript)
    && releasePreservesHostTls(bundleReleaseScript), {
      releasePreservesTls: releasePreservesHostTls(releaseScript),
      bundlePreservesTls: releasePreservesHostTls(bundleReleaseScript)
    });

  const crons = Array.isArray(cloudflareWrangler?.triggers?.crons) ? cloudflareWrangler.triggers.crons : [];
  pushCheck(checks, "cloudflare one-minute collector with guarded GitHub cadence", crons.includes("* * * * *")
    && Number(cloudflareWrangler?.vars?.MIN_SECONDS_BETWEEN_DISPATCHES || 0) >= 240
    && cloudflareWorker.includes("Promise.allSettled")
    && cloudflareWorker.includes("collectSportteryEvidence(env)"), {
    crons,
    minSecondsBetweenDispatches: cloudflareWrangler?.vars?.MIN_SECONDS_BETWEEN_DISPATCHES || null,
    independentScheduledTasks: cloudflareWorker.includes("Promise.allSettled")
  });

  const configuredCollectorKeyId = String(cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_KEY_ID || "");
  const configuredCollectorFingerprint = String(cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_KEY_FINGERPRINT || "");
  const trustedCollectorKey = Array.isArray(collectorTrustRegistry?.keys)
    ? collectorTrustRegistry.keys.find((row) => row?.keyId === configuredCollectorKeyId)
    : null;
  pushCheck(checks, "cloudflare collector uses public config and server-side independent trust domain", Boolean(
    cloudflareSportteryCollector.includes("crypto.subtle.sign")
    && cloudflareWorker.includes("/api/sporttery-evidence")
    && cloudflareWorker.includes("createSportteryEvidence(env)")
    && cloudflareSportteryCollectorVerifier.includes("server accepts every signed endpoint")
    && configuredCollectorKeyId
    && /^[a-f0-9]{64}$/.test(configuredCollectorFingerprint)
    && trustedCollectorKey?.enabled === true
    && trustedCollectorKey?.fingerprint === configuredCollectorFingerprint
    && trustedCollectorKey?.independenceDomain === "cloudflare-worker-collector-1"
    && cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_DELIVERY_MODE === "pull"
    && !cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8
    && !cloudflareWrangler?.vars?.FOOTBALL_PRODUCTION_ADMIN_TOKEN
  ), {
    keyId: configuredCollectorKeyId || null,
    fingerprintMatchesRegistry: trustedCollectorKey?.fingerprint === configuredCollectorFingerprint,
    independenceDomain: trustedCollectorKey?.independenceDomain || null,
    deliveryMode: cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_DELIVERY_MODE || null,
    privateSecretsAbsentFromConfig: !cloudflareWrangler?.vars?.SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8
      && !cloudflareWrangler?.vars?.FOOTBALL_PRODUCTION_ADMIN_TOKEN
  });

  pushCheck(checks, "collector evidence upload has bounded dedicated Nginx route", collectorEvidenceUpload.includes("client_max_body_size 8m")
    && collectorEvidenceUpload.includes("limit_req zone=football_admin burst=5 nodelay")
    && keyValue(envExample, "SPORTTERY_COLLECTOR_EVIDENCE_STORE_PATH") === "/var/lib/football-predict/sporttery-collector-evidence.json"
    && keyValue(envExample, "SPORTTERY_SERVER_DIRECT_RELAY_UPLOAD_URL") === "http://127.0.0.1:8788/api/admin/sporttery-relay-fast-lane?runSync=0", {
      routePresent: Boolean(collectorEvidenceUpload),
      evidenceStorePath: keyValue(envExample, "SPORTTERY_COLLECTOR_EVIDENCE_STORE_PATH") || null,
      serverDirectFastLaneUrl: keyValue(envExample, "SPORTTERY_SERVER_DIRECT_RELAY_UPLOAD_URL") || null
    });

  pushCheck(checks, "cloudflare stale repair waits two cycles", Number(cloudflareWrangler?.vars?.STALE_DATA_SECONDS || 0) >= 600, {
    staleDataSeconds: cloudflareWrangler?.vars?.STALE_DATA_SECONDS || null
  });

  pushCheck(checks, "cloudflare manual trigger bearer only", cloudflareWorker.includes("safeSecretEqual(bearerToken, env.MANUAL_TRIGGER_TOKEN)") && !cloudflareWorker.includes('searchParams.get("token")'), {
    hasSafeCompare: cloudflareWorker.includes("safeSecretEqual(bearerToken, env.MANUAL_TRIGGER_TOKEN)"),
    allowsQueryToken: cloudflareWorker.includes('searchParams.get("token")')
  });

  pushCheck(checks, "cloudflare worker does not serve protected data payloads", cloudflareWorker.includes("disabledProtectedDataResources")
    && cloudflareWorker.includes("protected data API disabled on sync worker")
    && cloudflareWorker.includes("C-end recommendation data must be served by the protected Node /api/v1 service")
    && !cloudflareWorker.includes('"matches/history": "public/data/matches-history.json"')
    && !cloudflareWorker.includes('"odds/history": "public/data/odds-history.json"')
    && !cloudflareWorker.includes('"model/calibration": "public/data/model-calibration.json"'), {
      hasDisabledMap: cloudflareWorker.includes("disabledProtectedDataResources"),
      servesHistoryRaw: cloudflareWorker.includes('"matches/history": "public/data/matches-history.json"'),
      servesOddsRaw: cloudflareWorker.includes('"odds/history": "public/data/odds-history.json"'),
      servesModelRaw: cloudflareWorker.includes('"model/calibration": "public/data/model-calibration.json"')
    });

  pushCheck(checks, "github sync does not cancel active run", /cancel-in-progress:\s*false/.test(githubSyncWorkflow), {
    cancelInProgressFalse: /cancel-in-progress:\s*false/.test(githubSyncWorkflow)
  });

  const pagesBaseCheck = (workflow) => workflow.includes("Verify Pages API Base")
    && workflow.includes("DATA_API_BASE repository variable is required")
    && workflow.includes("https://*")
    && !workflow.includes("http://*|https://*");
  pushCheck(checks, "github pages builds require HTTPS protected API base", pagesBaseCheck(githubSyncWorkflow) && pagesBaseCheck(githubPagesWorkflow), {
    syncWorkflowHasGate: pagesBaseCheck(githubSyncWorkflow),
    pagesWorkflowHasGate: pagesBaseCheck(githubPagesWorkflow)
  });

  pushCheck(checks, "cloud data push keeps dist lightweight", cloudPush.includes("disabledDistPayloads")
    && cloudPush.includes("lightweightDistDataFiles")
    && cloudPush.includes("remoteStripDisabledDistPayloads")
    && !cloudPush.includes("fs.cpSync(publicDataDir, distDataDir")
    && !cloudPush.includes("dist/matches.json dist/matches.json")
    && !cloudPush.includes("dist/odds-history.json dist/odds-history.json"), {
      stripsDisabledPayloads: cloudPush.includes("remoteStripDisabledDistPayloads"),
      hasLightweightAllowList: cloudPush.includes("lightweightDistDataFiles"),
      copiesFullPublicDataToDist: cloudPush.includes("fs.cpSync(publicDataDir, distDataDir"),
      copiesRootDistMatches: cloudPush.includes("dist/matches.json dist/matches.json"),
      copiesRootDistOdds: cloudPush.includes("dist/odds-history.json dist/odds-history.json")
    });

  pushCheck(checks, "cloud data push exports sqlite to production var-lib store", cloudPush.includes("SERVER_STORE_DIR=/var/lib/football-predict")
    && cloudPush.includes("DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db")
    && cloudPush.includes("sudo chown football:football /var/lib/football-predict/football.db*")
    && !cloudPush.includes("npm run datastore:sqlite; sudo chown football:football /var/lib/football-predict/football.db"), {
      hasServerStoreDir: cloudPush.includes("SERVER_STORE_DIR=/var/lib/football-predict"),
      hasSqlitePath: cloudPush.includes("DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db"),
      chownsVarLibDb: cloudPush.includes("sudo chown football:football /var/lib/football-predict/football.db*"),
      possibleBareExport: cloudPush.includes("npm run datastore:sqlite; sudo chown football:football /var/lib/football-predict/football.db")
  });

  pushCheck(checks, "cloud data push holds remote sync lock", cloudPush.includes("remote_sync_lock=/var/lib/football-predict/locks/sync.lock")
    && cloudPush.includes("football-cloud-sync")
    && cloudPush.includes("sudo mkdir")
    && cloudPush.includes("remote_sync_lock")
    && cloudPush.includes("trap cleanup_cloud_sync EXIT")
    && cloudPush.includes("sudo rm -rf")
    && cloudPush.includes("rm -rf ${remoteExtractDir} ${remoteArchive}")
    && cloudPush.includes("remote_sync_lock_acquired"), {
      hasRemoteSyncLock: cloudPush.includes("remote_sync_lock=/var/lib/football-predict/locks/sync.lock"),
      writesLockInfo: cloudPush.includes("football-cloud-sync") && cloudPush.includes("lock.json"),
      waitsForLock: cloudPush.includes("waiting for sync lock"),
      releasesLock: cloudPush.includes("sudo rm -rf") && cloudPush.includes("remote_sync_lock_acquired"),
      cleansRemoteTmpOnExit: cloudPush.includes("rm -rf ${remoteExtractDir} ${remoteArchive}")
  });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    files: {
      nginx: path.relative(rootDir, nginxPath).replace(/\\/g, "/"),
      nginxHttpCommon: path.relative(rootDir, nginxHttpCommonPath).replace(/\\/g, "/"),
      nginxServerCommon: path.relative(rootDir, nginxServerCommonPath).replace(/\\/g, "/"),
      nginxSecurityHeaders: path.relative(rootDir, nginxSecurityHeadersPath).replace(/\\/g, "/"),
      nginxTlsTemplate: path.relative(rootDir, nginxTlsTemplatePath).replace(/\\/g, "/"),
      enableNginxTls: path.relative(rootDir, enableNginxTlsPath).replace(/\\/g, "/"),
      deployPowerShell: path.relative(rootDir, deployPowerShellPath).replace(/\\/g, "/"),
      httpsTlsOperations: path.relative(rootDir, httpsTlsOperationsPath).replace(/\\/g, "/"),
      envExample: path.relative(rootDir, envExamplePath).replace(/\\/g, "/"),
      appService: path.relative(rootDir, appServicePath).replace(/\\/g, "/"),
      workerService: path.relative(rootDir, workerServicePath).replace(/\\/g, "/"),
      cleanupService: path.relative(rootDir, cleanupServicePath).replace(/\\/g, "/"),
      cleanupTimer: path.relative(rootDir, cleanupTimerPath).replace(/\\/g, "/"),
      monitorService: path.relative(rootDir, monitorServicePath).replace(/\\/g, "/"),
      monitorTimer: path.relative(rootDir, monitorTimerPath).replace(/\\/g, "/"),
      releaseScript: path.relative(rootDir, releaseScriptPath).replace(/\\/g, "/"),
      bundleReleaseScript: path.relative(rootDir, bundleReleaseScriptPath).replace(/\\/g, "/"),
      bundleDeployScript: path.relative(rootDir, deployReleaseBundlePath).replace(/\\/g, "/"),
      releaseBundlePolicy: path.relative(rootDir, releaseBundlePolicyPath).replace(/\\/g, "/"),
      verifyReleaseBundleSafety: path.relative(rootDir, verifyReleaseBundleSafetyPath).replace(/\\/g, "/"),
      checkReleaseStatus: path.relative(rootDir, checkReleaseStatusPath).replace(/\\/g, "/"),
      syncLock: path.relative(rootDir, syncLockPath).replace(/\\/g, "/"),
      verifySyncLock: path.relative(rootDir, verifySyncLockPath).replace(/\\/g, "/"),
      cleanupRelayHardening: path.relative(rootDir, cleanupRelayHardeningVerifierPath).replace(/\\/g, "/"),
      offlineReleaseKit: path.relative(rootDir, offlineReleaseKitPath).replace(/\\/g, "/"),
      watchReleaseWindow: path.relative(rootDir, watchReleaseWindowPath).replace(/\\/g, "/"),
      verifyReleaseWatchPolicy: path.relative(rootDir, verifyReleaseWatchPolicyPath).replace(/\\/g, "/"),
      runtimeMonitor: path.relative(rootDir, runtimeMonitorPath).replace(/\\/g, "/"),
      remotePublicReadiness: path.relative(rootDir, verifyRemotePublicPath).replace(/\\/g, "/"),
      tlsReadiness: path.relative(rootDir, verifyTlsReadinessPath).replace(/\\/g, "/"),
      productionReadiness: path.relative(rootDir, verifyProductionReadinessPath).replace(/\\/g, "/"),
      productionPlanCoverage: path.relative(rootDir, verifyProductionPlanCoveragePath).replace(/\\/g, "/"),
      syncData: path.relative(rootDir, syncDataPath).replace(/\\/g, "/"),
      cloudflareWorker: path.relative(rootDir, cloudflareWorkerPath).replace(/\\/g, "/"),
      cloudflareWrangler: path.relative(rootDir, cloudflareWranglerPath).replace(/\\/g, "/"),
      githubSyncWorkflow: path.relative(rootDir, githubSyncWorkflowPath).replace(/\\/g, "/"),
      githubPagesWorkflow: path.relative(rootDir, githubPagesWorkflowPath).replace(/\\/g, "/"),
      cloudPush: path.relative(rootDir, cloudPushPath).replace(/\\/g, "/")
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
