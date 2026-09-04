const {
  decideReleaseWatchAction,
  isLocalCandidateLive
} = require("./watchReleaseWindow.cjs");

const candidateSha256 = "a".repeat(64);
const oldLiveSha256 = "b".repeat(64);

const status = ({
  liveComplete = true,
  canAttemptDeploy = false,
  bundleOk = true,
  markerSha256 = oldLiveSha256,
  matchesLocalCandidate = false
} = {}) => ({
  liveComplete,
  canAttemptDeploy,
  bundle: {
    ok: bundleOk,
    actualSha256: candidateSha256
  },
  remoteRelease: {
    ok: true,
    markerSha256,
    matchesLocalCandidate
  }
});

const checks = [];
const pushCheck = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });

const oldLiveRelease = status();
pushCheck(
  "healthy old live release is not the local candidate",
  isLocalCandidateLive(oldLiveRelease) === false
);
pushCheck(
  "healthy old live release keeps waiting while ssh or preflight is blocked",
  decideReleaseWatchAction({ status: oldLiveRelease, allowAutoDeploy: true }) === "wait"
);

const deployWindowForOldRelease = status({ canAttemptDeploy: true });
pushCheck(
  "old live release auto-deploys when the candidate window opens",
  decideReleaseWatchAction({ status: deployWindowForOldRelease, allowAutoDeploy: true }) === "deploy"
);
pushCheck(
  "manual watch reports an open candidate deploy window without deploying",
  decideReleaseWatchAction({ status: deployWindowForOldRelease, allowAutoDeploy: false }) === "report-deploy-window"
);

const matchingCandidate = status({
  markerSha256: candidateSha256,
  matchesLocalCandidate: true
});
pushCheck(
  "matching candidate marker completes the watch",
  isLocalCandidateLive(matchingCandidate) === true
    && decideReleaseWatchAction({ status: matchingCandidate, allowAutoDeploy: true }) === "complete"
);

const explicitMismatchDespiteEqualHashes = status({
  markerSha256: candidateSha256,
  matchesLocalCandidate: false
});
pushCheck(
  "matchesLocalCandidate false cannot complete even when hashes appear equal",
  isLocalCandidateLive(explicitMismatchDespiteEqualHashes) === false
    && decideReleaseWatchAction({ status: explicitMismatchDespiteEqualHashes, allowAutoDeploy: true }) === "wait"
);

const inconsistentMatchFlag = status({
  markerSha256: oldLiveSha256,
  matchesLocalCandidate: true
});
pushCheck(
  "inconsistent match flag cannot bypass direct marker comparison",
  isLocalCandidateLive(inconsistentMatchFlag) === false
);

const unreadableMatchingMarker = status({
  markerSha256: candidateSha256,
  matchesLocalCandidate: true
});
unreadableMatchingMarker.remoteRelease.ok = false;
pushCheck(
  "unverified remote marker read cannot complete",
  isLocalCandidateLive(unreadableMatchingMarker) === false
);

const unhealthyMatchingCandidate = status({
  liveComplete: false,
  markerSha256: candidateSha256,
  matchesLocalCandidate: true
});
pushCheck(
  "matching marker without complete public readiness keeps waiting",
  isLocalCandidateLive(unhealthyMatchingCandidate) === false
    && decideReleaseWatchAction({ status: unhealthyMatchingCandidate, allowAutoDeploy: true }) === "wait"
);

pushCheck(
  "attempted signed deploy waits for marker confirmation instead of redeploying the same bundle",
  decideReleaseWatchAction({
    status: deployWindowForOldRelease,
    allowAutoDeploy: true,
    deployedCandidateSha256: candidateSha256
  }) === "wait-for-candidate-confirmation"
);

const malformedCandidate = status({ canAttemptDeploy: true });
malformedCandidate.bundle.actualSha256 = "not-a-sha256";
malformedCandidate.remoteRelease.markerSha256 = "not-a-sha256";
malformedCandidate.remoteRelease.matchesLocalCandidate = true;
pushCheck(
  "malformed candidate identity never completes",
  isLocalCandidateLive(malformedCandidate) === false
);

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  checks
}, null, 2));
if (!ok) process.exitCode = 1;
