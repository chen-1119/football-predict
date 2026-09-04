const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const {
  evaluateCandidateProspectiveGoal,
} = require("./candidateProspectiveGoalProgress.cjs");
const {
  advanceCandidateHeartbeatContinuity,
  cleanState: cleanHeartbeatContinuityState,
} = require("./prospectiveHeartbeatContinuity.cjs");
const {
  advanceWatchHealthState,
  cleanWatchHealthState,
} = require("./prospectiveWatchHealthPolicy.cjs");
const {
  advanceCalibrationChallengerContinuity,
  cleanCalibrationChallengerContinuity,
} = require("./candidateProspectiveChallengerSuite.cjs");

const rootDir = path.resolve(__dirname, "..");
const baseUrl = new URL(
  process.env.PROSPECTIVE_WATCH_BASE_URL
  || process.env.REMOTE_BASE_URL
  || "https://134.175.132.183",
);
const targetRows = Math.max(
  1,
  Number(process.env.PROSPECTIVE_WATCH_TARGET_ROWS || 500),
);
const requiredWindows = Math.max(
  1,
  Number(process.env.PROSPECTIVE_WATCH_REQUIRED_WINDOWS || 6),
);
const requiredWinningWindows = Math.max(
  1,
  Number(process.env.PROSPECTIVE_WATCH_REQUIRED_WINNING_WINDOWS || 5),
);
const pollMs = Math.max(5_000, Number(process.env.PROSPECTIVE_WATCH_POLL_MS || 20_000));
const configuredTimeoutMs = Number(process.env.PROSPECTIVE_WATCH_TIMEOUT_MS || 0);
const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
  ? Math.max(pollMs, configuredTimeoutMs)
  : null;
const requestTimeoutMs = Math.max(
  5_000,
  Number(process.env.PROSPECTIVE_WATCH_REQUEST_TIMEOUT_MS || 20_000),
);
const once = process.env.PROSPECTIVE_WATCH_ONCE === "1" || process.argv.includes("--once");
const statusPath = path.resolve(
  process.env.PROSPECTIVE_WATCH_STATUS_PATH
  || path.join(rootDir, ".codex-tmp", "candidate-prospective-watch-status.json"),
);
const continuityPolicyVersion =
  "candidate-prospective-capture-watch-continuity-policy-v2";

const startedAt = new Date().toISOString();
const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;
let captureObserved = false;
let polls = 0;
let requestFailures = 0;
let heartbeatContinuity = cleanHeartbeatContinuityState();
let challengerContinuity = cleanCalibrationChallengerContinuity();
let watchHealth = cleanWatchHealthState();

try {
  const persisted = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  if (
    persisted?.version === "candidate-prospective-capture-watch-v4"
    && persisted?.continuityPolicyVersion === continuityPolicyVersion
    && persisted?.baseUrl === baseUrl.origin
  ) {
    heartbeatContinuity = cleanHeartbeatContinuityState(
      persisted.heartbeatContinuity,
    );
    challengerContinuity = cleanCalibrationChallengerContinuity(
      persisted.challengerContinuity,
    );
    captureObserved = persisted.captureObserved === true;
    watchHealth = cleanWatchHealthState(persisted.watchHealth);
  }
} catch {
  // A missing or older status file starts a fresh continuity baseline.
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const writeStatus = (payload) => {
  const body = {
    version: "candidate-prospective-capture-watch-v4",
    continuityPolicyVersion,
    startedAt,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    targetRows,
    requiredWindows,
    requiredWinningWindows,
    pollMs,
    timeoutMs,
    polls,
    requestFailures,
    captureObserved,
    heartbeatContinuity,
    challengerContinuity,
    watchHealth,
    ...payload,
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, statusPath);
  process.stdout.write(`${JSON.stringify(body)}\n`);
  return body;
};

const requestJson = () => new Promise((resolve) => {
  const target = new URL("/api/v1/model/evaluation", baseUrl);
  const transport = target.protocol === "https:" ? https : http;
  const req = transport.request(target, {
    method: "GET",
    timeout: requestTimeoutMs,
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "user-agent": "football-candidate-prospective-watch/1",
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 512_000) {
        req.destroy(new Error("response too large"));
      }
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      resolve({
        status: Number(res.statusCode || 0),
        body,
        error: body ? null : "invalid-json-response",
      });
    });
  });
  req.on("timeout", () => req.destroy(new Error("request timeout")));
  req.on("error", (error) => resolve({
    status: 0,
    body: null,
    error: error.message || String(error),
  }));
  req.end();
});

const inspect = async () => {
  polls += 1;
  const response = await requestJson();
  if (response.status !== 200 || !response.body) {
    requestFailures += 1;
    return writeStatus({
      status: "retrying",
      ok: false,
      httpStatus: response.status,
      error: response.error || `unexpected-http-${response.status}`,
    });
  }

  const prospective =
    response.body?.publicScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE
    || null;
  const heartbeat = prospective?.captureHeartbeat || null;
  const challengerSuite = heartbeat?.challengerSuite || null;
  const readiness = heartbeat?.readiness || null;
  const dueMatches = Number(heartbeat?.dueMatches || 0);
  const eventsAdded = Number(heartbeat?.eventsAdded || 0);
  const dueCaptureEventsAdded = Number(heartbeat?.dueCaptureEventsAdded || 0);
  const dueDecisionEventsAdded = Number(heartbeat?.dueDecisionEventsAdded || 0);
  const dueExclusionEventsAdded = Number(heartbeat?.dueExclusionEventsAdded || 0);
  const dueAtomicDecisionEventsAdded = Number(
    heartbeat?.dueAtomicDecisionEventsAdded || 0,
  );
  const dueCaptureComplete = heartbeat?.dueCaptureComplete === true
    && heartbeat?.dueAtomicComplete === true
    && dueCaptureEventsAdded === dueMatches
    && dueDecisionEventsAdded + dueExclusionEventsAdded === dueCaptureEventsAdded
    && dueAtomicDecisionEventsAdded === dueDecisionEventsAdded;
  if (dueMatches > 0 && dueCaptureComplete) captureObserved = true;
  const progress = evaluateCandidateProspectiveGoal(prospective, {
    targetRows,
    requiredWindows,
    requiredWinningWindows,
  });
  heartbeatContinuity = advanceCandidateHeartbeatContinuity(
    heartbeatContinuity,
    {
      candidateRevisionId: prospective?.candidateRevisionId,
      evaluatedAt: heartbeat?.evaluatedAt,
      rootHash: prospective?.rootHash,
      eventsAdded,
      admittedRows: prospective?.decisionRecord?.admittedRows,
      atomicRows: prospective?.decisionRecord?.atomicRows,
    },
  );
  challengerContinuity = advanceCalibrationChallengerContinuity(
    challengerContinuity,
    challengerSuite,
  );
  const challengerOperationalBlockers = [];
  if (challengerSuite?.available === true) {
    if (challengerSuite.version !== "candidate-prospective-challenger-suite-public-v1") {
      challengerOperationalBlockers.push("challenger-public-version-invalid");
    }
    if (challengerSuite.onlineEffect !== false) {
      challengerOperationalBlockers.push("challenger-online-effect-not-shadow");
    }
    if (Number(challengerSuite.trialCount || 0) < 1) {
      challengerOperationalBlockers.push("challenger-trials-missing");
    }
    if (challengerSuite.chainValid !== true) {
      challengerOperationalBlockers.push("challenger-chain-invalid");
    }
    if (challengerSuite.allTrialsActive !== true) {
      challengerOperationalBlockers.push("challenger-trials-not-active");
    }
    if (challengerSuite.allTrialsShadowOnly !== true) {
      challengerOperationalBlockers.push("challenger-trials-not-shadow-only");
    }
    if (challengerSuite.countParity !== true) {
      challengerOperationalBlockers.push("challenger-trial-count-parity-failed");
    }
    if (challengerSuite.decisionCoverageComplete !== true) {
      challengerOperationalBlockers.push("challenger-decision-coverage-incomplete");
    }
    if (challengerSuite.settlementCoverageComplete !== true) {
      challengerOperationalBlockers.push("challenger-settlement-coverage-incomplete");
    }
    if (challengerSuite.metricCoverageComplete !== true) {
      challengerOperationalBlockers.push("challenger-metric-coverage-incomplete");
    }
    if (challengerSuite.windowEvaluationCoverageComplete !== true) {
      challengerOperationalBlockers.push("challenger-window-evaluation-incomplete");
    }
    if (Number(challengerSuite.blockerCount || 0) > 0) {
      challengerOperationalBlockers.push("challenger-suite-blocked");
    }
  }
  if (challengerContinuity.violation?.code) {
    challengerOperationalBlockers.push(challengerContinuity.violation.code);
  }
  const operationalBlockers = [
    ...new Set([
      ...progress.operationalBlockers,
      ...challengerOperationalBlockers,
    ]),
  ];
  const healthy = progress.healthy && challengerOperationalBlockers.length === 0;
  watchHealth = advanceWatchHealthState(watchHealth, {
    checkedAt: new Date().toISOString(),
    healthy,
    operationalBlockers,
    candidateState: prospective?.state,
    chainValid: prospective?.chainValid,
    heartbeatSkipped: heartbeat?.skipped,
    continuityViolation:
      heartbeatContinuity.violation?.code
      || challengerContinuity.violation?.code
      || null,
  });

  const result = writeStatus({
    status: heartbeatContinuity.violation || challengerContinuity.violation
      ? "failed"
      : healthy
        ? progress.status
        : watchHealth.lastSeverity === "transient"
          ? "retrying-unhealthy"
          : "monitoring-unhealthy",
    ok: progress.complete,
    healthy,
    candidateRevisionId: progress.candidateRevisionId,
    operationalBlockers,
    goalBlockers: progress.goalBlockers,
    atomicDecision: progress.atomicDecision,
    settlement: progress.settlement,
    formal: progress.formal,
    evaluation: progress.evaluation,
    heartbeat: {
      evaluatedAt: heartbeat?.evaluatedAt || null,
      reason: heartbeat?.reason || null,
      dueMatches,
      eventsAdded,
      dueCaptureEventsAdded,
      dueDecisionEventsAdded,
      dueExclusionEventsAdded,
      dueAtomicDecisionEventsAdded,
      dueCaptureComplete,
    },
    challengerSuite: challengerSuite ? {
      version: challengerSuite.version || null,
      evaluatedAt: challengerSuite.evaluatedAt || null,
      available: challengerSuite.available === true,
      onlineEffect: challengerSuite.onlineEffect,
      dueMatches: Number(challengerSuite.dueMatches || 0),
      changed: challengerSuite.changed === true,
      trialCount: Number(challengerSuite.trialCount || 0),
      chainValid: challengerSuite.chainValid === true,
      allTrialsActive: challengerSuite.allTrialsActive === true,
      allTrialsShadowOnly: challengerSuite.allTrialsShadowOnly === true,
      countParity: challengerSuite.countParity === true,
      decisionCoverageComplete: challengerSuite.decisionCoverageComplete === true,
      settlementCoverageComplete: challengerSuite.settlementCoverageComplete === true,
      metricCoverageComplete: challengerSuite.metricCoverageComplete === true,
      windowEvaluationCoverageComplete:
        challengerSuite.windowEvaluationCoverageComplete === true,
      admittedRows: challengerSuite.admittedRows || null,
      atomicRows: challengerSuite.atomicRows || null,
      settledRows: challengerSuite.settledRows || null,
      excludedRows: challengerSuite.excludedRows || null,
      formalRows: challengerSuite.formalRows || null,
      eligibleWindows: challengerSuite.eligibleWindows || null,
      winningWindows: challengerSuite.winningWindows || null,
      logLossImprovement: challengerSuite.logLossImprovement || null,
      brierImprovement: challengerSuite.brierImprovement || null,
      promotionReviewReadyTrialCount: Number(
        challengerSuite.promotionReviewReadyTrialCount || 0,
      ),
      formalPromotionEligibleTrialCount: Number(
        challengerSuite.formalPromotionEligibleTrialCount || 0,
      ),
      progressUnits: Number(challengerSuite.progressUnits || 0),
      blockerCount: Number(challengerSuite.blockerCount || 0),
      operationalBlockers: challengerOperationalBlockers,
    } : null,
    readiness: readiness ? {
      version: readiness.version || null,
      evaluatedMatches: Number(readiness.evaluatedMatches || 0),
      detailedMatches: Number(readiness.detailedMatches || 0),
      rowsTruncated: Number(readiness.rowsTruncated || 0),
      upcomingMatches: Number(readiness.upcomingMatches || 0),
      readyNow: Number(readiness.readyNow || 0),
      atomicReadyNow: Number(readiness.atomicReadyNow || 0),
      awaitingMarket: Number(readiness.awaitingMarket || 0),
      blocked: Number(readiness.blocked || 0),
      excluded: Number(readiness.excluded || 0),
      nearestDeadlineAt: readiness.nearestDeadlineAt || null,
      nearestFinalizationAt: readiness.nearestFinalizationAt || null,
      nearestStatus: readiness.nearestStatus || null,
      deadlineBatches: Array.isArray(readiness.deadlineBatches)
        ? readiness.deadlineBatches
        : [],
      nearestDeadlineBatch: readiness.nearestDeadlineBatch || null,
      blockerCounts: readiness.blockerCounts || {},
      awaitingReasonCounts: readiness.awaitingReasonCounts || {},
      excludedReasonCounts: readiness.excludedReasonCounts || {},
      marketCoverage: readiness.marketCoverage || null,
      captureGap: readiness.admission?.captureGap ?? null,
      dueUnrecorded: Number(readiness.admission?.dueUnrecorded || 0),
      readyDueUnrecorded: Number(readiness.admission?.readyDueUnrecorded || 0),
    } : null,
  });

  if (watchHealth.shouldExit) {
    const error = new Error(
      `candidate heartbeat continuity violation: ${
        heartbeatContinuity.violation?.code
        || challengerContinuity.violation?.code
        || operationalBlockers.join(",")
        || "persistent-operational-failure"
      }`,
    );
    error.status = result;
    throw error;
  }
  return result;
};

const main = async () => {
  while (true) {
    let result;
    try {
      result = await inspect();
    } catch (error) {
      writeStatus({
        status: "failed",
        ok: false,
        error: error.message || String(error),
      });
      process.exitCode = 1;
      return;
    }
    if (result.status === "complete" || once) return;
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      writeStatus({
        status: "timed-out",
        ok: false,
        error: [
          `formal settled rows did not reach ${targetRows}`,
          `with ${requiredWinningWindows}/${requiredWindows} winning calendar windows`,
          "before the configured timeout",
        ].join(" "),
      });
      process.exitCode = 1;
      return;
    }
    await sleep(pollMs);
  }
};

main().catch((error) => {
  writeStatus({
    status: "failed",
    ok: false,
    error: error.message || String(error),
  });
  process.exitCode = 1;
});
