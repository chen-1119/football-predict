const { spawnSync } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const autoDeploy = process.env.RELEASE_WATCH_AUTO_DEPLOY === "1";
const attempts = Math.max(1, Number(process.env.RELEASE_WATCH_ATTEMPTS || (autoDeploy ? 60 : 1)));
const intervalSeconds = Math.max(5, Number(process.env.RELEASE_WATCH_INTERVAL_SECONDS || 60));
const commandTimeoutMs = Math.max(30_000, Number(process.env.RELEASE_WATCH_COMMAND_TIMEOUT_MS || 180_000));
const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.REMOTE_BASE_URL || "https://134.175.132.183";
const sha256Pattern = /^[0-9a-f]{64}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseJsonOutput = (stdout) => {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
};

const runNodeJson = (script, env = {}) => {
  const result = spawnSync(process.execPath, [script], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
    body: parseJsonOutput(result.stdout)
  };
};

const normalizeSha256 = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return sha256Pattern.test(normalized) ? normalized : null;
};

const localCandidateSha256 = (status) => normalizeSha256(
  status?.bundle?.actualSha256 || status?.bundle?.localCandidateSha256
);

const remoteMarkerSha256 = (status) => normalizeSha256(status?.remoteRelease?.markerSha256);

const isLocalCandidateLive = (status) => {
  const localSha256 = localCandidateSha256(status);
  const remoteSha256 = remoteMarkerSha256(status);
  return status?.liveComplete === true
    && status?.bundle?.ok === true
    && status?.remoteRelease?.ok === true
    && status?.remoteRelease?.matchesLocalCandidate === true
    && Boolean(localSha256)
    && remoteSha256 === localSha256;
};

const decideReleaseWatchAction = ({ status, allowAutoDeploy, deployedCandidateSha256 = null }) => {
  if (isLocalCandidateLive(status)) return "complete";
  if (status?.canAttemptDeploy !== true) return "wait";
  if (!allowAutoDeploy) return "report-deploy-window";
  const candidateSha256 = localCandidateSha256(status);
  if (candidateSha256 && candidateSha256 === normalizeSha256(deployedCandidateSha256)) {
    return "wait-for-candidate-confirmation";
  }
  return "deploy";
};

const run = async () => {
  const checks = [];
  const deployments = [];
  let lastStatus = null;
  let deployedCandidateSha256 = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checkedAt = new Date().toISOString();
    const statusRun = runNodeJson("scripts/checkReleaseStatus.cjs", {
      PUBLIC_BASE_URL: publicBaseUrl
    });
    const status = statusRun.body;
    lastStatus = status;
    const action = decideReleaseWatchAction({
      status,
      allowAutoDeploy: autoDeploy,
      deployedCandidateSha256
    });
    checks.push({
      attempt,
      checkedAt,
      status: statusRun.status,
      parsed: Boolean(status),
      canAttemptDeploy: Boolean(status?.canAttemptDeploy),
      liveComplete: Boolean(status?.liveComplete),
      localCandidateLive: isLocalCandidateLive(status),
      action,
      blockers: status?.blockers || null,
      sshBanner: status?.sshBanner || null,
      bundle: status?.bundle ? {
        ok: status.bundle.ok,
        bundle: status.bundle.bundle || null,
        workspaceFresh: status.bundle.workspaceFresh,
        sha256: status.bundle.actualSha256 || null
      } : null,
      remoteRelease: status?.remoteRelease ? {
        ok: status.remoteRelease.ok === true,
        markerSha256: status.remoteRelease.markerSha256 || null,
        matchesLocalCandidate: status.remoteRelease.matchesLocalCandidate === true
      } : null
    });

    if (action === "complete") {
      console.log(JSON.stringify({
        ok: true,
        mode: "release-watch",
        checkedAt: new Date().toISOString(),
        reason: "local candidate marker is live and public origin is complete",
        attempts: checks,
        deployments,
        publicBaseUrl
      }, null, 2));
      return;
    }

    if (action === "report-deploy-window") {
      console.log(JSON.stringify({
        ok: true,
        mode: "release-watch",
        checkedAt: new Date().toISOString(),
        reason: "deploy window is open for the local candidate; auto deploy disabled",
        autoDeploy,
        nextCommand: "RELEASE_WATCH_AUTO_DEPLOY=1 npm run release:watch",
        attempts: checks,
        deployments,
        publicBaseUrl
      }, null, 2));
      return;
    }

    if (action === "deploy") {
      const candidateSha256 = localCandidateSha256(status);
      // A signed release sequence is single-use once the remote entrypoint sees
      // it, even when the guarded release aborts before swap. Record the
      // attempt before invoking the deployer so this watcher can never submit
      // the same candidate a second time.
      if (candidateSha256) deployedCandidateSha256 = candidateSha256;
      const deploy = runNodeJson("scripts/deployReleaseBundle.cjs", {
        PUBLIC_BASE_URL: publicBaseUrl
      });
      const verify = runNodeJson("scripts/verifyRemotePublicReadiness.cjs", {
        REMOTE_BASE_URL: publicBaseUrl,
        REMOTE_REQUIRE_SQLITE: "1"
      });
      const deployOk = deploy.status === 0 && deploy.body?.ok === true;
      const verifyOk = verify.status === 0 && verify.body?.ok === true;

      const confirmationRun = runNodeJson("scripts/checkReleaseStatus.cjs", {
        PUBLIC_BASE_URL: publicBaseUrl
      });
      const confirmation = confirmationRun.body;
      const candidateConfirmed = isLocalCandidateLive(confirmation);
      const deployment = {
        attemptedAt: new Date().toISOString(),
        candidateSha256,
        deployOk,
        verifyOk,
        candidateConfirmed,
        deploy: deploy.body || {
          status: deploy.status,
          error: deploy.error,
          stderrTail: deploy.stderr.slice(-2000)
        },
        verify: verify.body || {
          status: verify.status,
          error: verify.error,
          stderrTail: verify.stderr.slice(-2000)
        },
        confirmation: confirmation ? {
          status: confirmationRun.status,
          liveComplete: confirmation.liveComplete === true,
          localCandidateLive: candidateConfirmed,
          remoteReleaseOk: confirmation.remoteRelease?.ok === true,
          markerSha256: confirmation.remoteRelease?.markerSha256 || null,
          matchesLocalCandidate: confirmation.remoteRelease?.matchesLocalCandidate === true,
          blockers: confirmation.blockers || null
        } : {
          status: confirmationRun.status,
          error: confirmationRun.error,
          stderrTail: confirmationRun.stderr.slice(-2000)
        }
      };
      deployments.push(deployment);

      if (deployOk && verifyOk && candidateConfirmed) {
        console.log(JSON.stringify({
          ok: true,
          mode: "release-watch",
          checkedAt: new Date().toISOString(),
          reason: "local candidate deployed, marker-matched, and verified",
          attempts: checks,
          deployments,
          publicBaseUrl
        }, null, 2));
        return;
      }

      console.log(JSON.stringify({
        ok: false,
        mode: "release-watch",
        checkedAt: new Date().toISOString(),
        reason: "signed candidate was attempted but not marker-matched and complete; generate a new release sequence before retrying",
        attempts: checks,
        deployments,
        publicBaseUrl
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    if (attempt < attempts) await sleep(intervalSeconds * 1000);
  }

  console.log(JSON.stringify({
    ok: false,
    mode: "release-watch",
    checkedAt: new Date().toISOString(),
    reason: "local candidate was not marker-matched and complete before attempts were exhausted",
    autoDeploy,
    attempts: checks,
    deployments,
    lastBlockers: lastStatus?.blockers || null,
    lastLocalCandidateLive: isLocalCandidateLive(lastStatus),
    publicBaseUrl
  }, null, 2));
  process.exitCode = 1;
};

module.exports = {
  decideReleaseWatchAction,
  isLocalCandidateLive,
  localCandidateSha256,
  remoteMarkerSha256
};

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      mode: "release-watch",
      error: error.message || String(error)
    }, null, 2));
    process.exitCode = 1;
  });
}
