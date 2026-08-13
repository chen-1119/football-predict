"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  REQUIRED_DECISION_FIELDS,
  REQUIRED_SETTLEMENT_FIELDS,
} = require("./candidateProspectiveGoalProgress.cjs");

const rootDir = path.resolve(__dirname, "..");
const statusPath = path.join(
  os.tmpdir(),
  `verify-prospective-watch-recovery-${process.pid}.json`,
);

const prospective = ({
  fresh,
  evaluatedAt,
  includeDeadlineBatches = true,
}) => ({
  state: "ACTIVE",
  chainValid: true,
  candidateRevisionId: "candidate@watch-recovery-test",
  rootHash: "a".repeat(64),
  decisionRecord: {
    version: "candidate-atomic-decision-record-v3",
    validationVersion: "candidate-atomic-decision-validation-v2",
    dualMarketDecisionRecordVersion: "candidate-dual-market-decision-record-v1",
    formalMetricMarket: "HAD",
    companionMarket: "HHAD",
    decisionDeadlinePolicyVersion: "official-cutoff-first-v1",
    requiredFields: [...REQUIRED_DECISION_FIELDS],
    admittedRows: 500,
    atomicRows: 500,
    completeRows: 500,
    failedRows: 0,
    blockerCounts: {},
    coverage: 1,
    complete: true,
  },
  settlementRecord: {
    version: "candidate-official-settlement-record-v1",
    validationVersion: "candidate-official-settlement-validation-v1",
    requiredFields: [...REQUIRED_SETTLEMENT_FIELDS],
    rows: 500,
    completeRows: 500,
    failedRows: 0,
    blockerCounts: {},
    coverage: 1,
    complete: true,
  },
  cohort: {
    formal: {
      settled: 500,
      finalized: 500,
      denominatorReconciled: true,
    },
  },
  metrics: {
    formalRows: 500,
    brierImprovement: 0.01,
    logLossImprovement: 0.01,
    calendarWindows: 6,
    registeredCalendarWindows: 6,
    winningCalendarWindows: 5,
    calendarWindowGatePassed: true,
  },
  captureHeartbeat: {
    version: "prospective-deadline-heartbeat-v2",
    evaluatedAt,
    fresh,
    ok: true,
    skipped: false,
    reason: fresh ? "recovered-heartbeat" : "release-transition",
    dueMatches: 0,
    eventsAdded: 0,
    dueCaptureEventsAdded: 0,
    dueDecisionEventsAdded: 0,
    dueExclusionEventsAdded: 0,
    dueAtomicDecisionEventsAdded: 0,
    dueCaptureComplete: true,
    dueAtomicComplete: true,
    readiness: {
      version: "candidate-prospective-readiness-preview-v2",
      evaluatedMatches: 1,
      detailedMatches: 1,
      rowsTruncated: 0,
      upcomingMatches: 1,
      readyNow: 1,
      atomicReadyNow: 1,
      awaitingMarket: 0,
      blocked: 0,
      excluded: 0,
      readyInvariantOk: true,
      nearestDeadlineAt: "2026-07-30T14:00:00.000Z",
      nearestFinalizationAt: "2026-07-30T14:02:00.000Z",
      deadlineBatches: includeDeadlineBatches
        ? [
            {
              version: "candidate-deadline-batch-summary-v1",
              deadlineAt: "2026-07-30T14:00:00.000Z",
              finalizationAt: "2026-07-30T14:02:00.000Z",
              phase: "upcoming",
              totalMatches: 1,
              actionableMatches: 1,
              readyNow: 1,
              awaitingMarket: 0,
              blocked: 0,
              excluded: 0,
              terminalDecisions: 0,
              terminalExclusions: 0,
              duplicateTerminalEvents: 0,
              terminalKeysWithDuplicates: 0,
              terminalMatches: 0,
              pendingMatches: 1,
              dueUnrecorded: 0,
              readyDueUnrecorded: 0,
              invariantOk: true,
            },
          ]
        : [],
      nearestDeadlineBatch: includeDeadlineBatches
        ? {
            version: "candidate-deadline-batch-summary-v1",
            deadlineAt: "2026-07-30T14:00:00.000Z",
            finalizationAt: "2026-07-30T14:02:00.000Z",
            phase: "upcoming",
            totalMatches: 1,
            actionableMatches: 1,
            readyNow: 1,
            awaitingMarket: 0,
            blocked: 0,
            excluded: 0,
            terminalDecisions: 0,
            terminalExclusions: 0,
            duplicateTerminalEvents: 0,
            terminalKeysWithDuplicates: 0,
            terminalMatches: 0,
            pendingMatches: 1,
            dueUnrecorded: 0,
            readyDueUnrecorded: 0,
            invariantOk: true,
          }
        : null,
      admission: {
        version: "candidate-prospective-admission-summary-v1",
        registryAvailable: true,
        reconciled: true,
        captureGap: false,
        expectedRows: 1,
        admitted: 0,
        excluded: 0,
        pendingDeadline: 1,
        dueUnrecorded: 0,
        readyDueUnrecorded: 0,
      },
    },
  },
});

let requests = 0;
const server = http.createServer((req, res) => {
  if (req.url !== "/api/v1/model/evaluation") {
    res.writeHead(404).end();
    return;
  }
  requests += 1;
  const recovered = requests >= 2;
  const deadlineBatchRecovered = requests >= 3;
  const candidate = prospective({
    fresh: recovered,
    includeDeadlineBatches: requests !== 2,
    evaluatedAt: deadlineBatchRecovered
      ? "2026-07-30T08:00:40.000Z"
      : recovered
        ? "2026-07-30T08:00:20.000Z"
        : "2026-07-30T08:00:00.000Z",
  });
  const body = JSON.stringify({
    ok: true,
    publicScorecard: {
      shadowTracks: {
        CANDIDATE_PROSPECTIVE: candidate,
      },
    },
  });
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});

const listen = () => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const close = () => new Promise((resolve) => server.close(resolve));

const runWatcher = (baseUrl) => new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    ["scripts/watchCandidateProspectiveCapture.cjs"],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        PROSPECTIVE_WATCH_BASE_URL: baseUrl,
        PROSPECTIVE_WATCH_POLL_MS: "5000",
        PROSPECTIVE_WATCH_REQUEST_TIMEOUT_MS: "5000",
        PROSPECTIVE_WATCH_STATUS_PATH: statusPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("watch recovery verifier timed out"));
  // The watcher needs three polls (two degraded transition samples followed by
  // one healthy sample). Candidate release verification runs this alongside
  // API performance checks, so allow the three 5-second request budgets plus
  // scheduling headroom without weakening any assertion.
  }, 45_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    resolve({ code, signal, stdout, stderr });
  });
});

(async () => {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  try {
    await listen();
    const address = server.address();
    const result = await runWatcher(`http://127.0.0.1:${address.port}`);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.ok(requests >= 3);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.equal(status.version, "candidate-prospective-capture-watch-v4");
    assert.equal(
      status.continuityPolicyVersion,
      "candidate-prospective-capture-watch-continuity-policy-v2",
    );
    assert.equal(status.status, "complete");
    assert.equal(status.ok, true);
    assert.equal(status.healthy, true);
    assert.equal(status.watchHealth?.unhealthyPolls, 2);
    assert.equal(status.watchHealth?.consecutiveUnhealthyPolls, 0);
    assert.equal(status.watchHealth?.recoveries, 1);
    assert.equal(status.watchHealth?.lastSeverity, "healthy");
    assert.equal(status.watchHealth?.keepRunning, true);
    assert.equal(status.heartbeatContinuity?.violation, null);
    assert.ok(Number(status.heartbeatContinuity?.stableNoOpTransitions) >= 1);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "prospective-watch-recovery",
      assertions: 16,
      requests,
      final: {
        version: status.version,
        continuityPolicyVersion: status.continuityPolicyVersion,
        status: status.status,
        unhealthyPolls: status.watchHealth.unhealthyPolls,
        recoveries: status.watchHealth.recoveries,
        stableNoOpTransitions:
          status.heartbeatContinuity.stableNoOpTransitions,
      },
    }, null, 2)}\n`);
  } finally {
    await close();
    fs.rmSync(statusPath, { force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
