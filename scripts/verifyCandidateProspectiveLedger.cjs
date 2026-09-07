"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  REGISTRY_VERSION,
  LEDGER_VERSION,
  AUDIT_VERSION,
  MIN_FORMAL_SETTLED,
  MIN_FORMAL_FINALIZED,
  MIN_WINNING_WINDOWS,
  MIN_FORMAL_ROWS_PER_WINDOW,
  WINDOW_COUNT,
  DECISION_DEADLINE_POLICY_VERSION,
  DECISION_RECORD_VERSION,
  ATOMIC_DECISION_VALIDATION_VERSION,
  ATOMIC_DECISION_REQUIRED_FIELDS,
  SETTLEMENT_RECORD_VERSION,
  SETTLEMENT_VALIDATION_VERSION,
  SETTLEMENT_REQUIRED_FIELDS,
  DUAL_MARKET_DECISION_RECORD_VERSION,
  LEAGUE_NORMALIZATION_VERSION,
  REVIEW_CHECKPOINT_AUDIT_VERSION,
  REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION,
  CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  buildCandidateCommitment,
  candidateInventory,
  decisionDeadlineFor,
  verifyLedger,
  verifyRegistry,
  fixedGateSpec,
  assessWindowPerformance,
  sha256,
  normalizedLeagueForMatch,
  atomicDecisionHashFor,
  atomicDecisionRecordBlockers,
  atomicDecisionRecordValid,
  dualMarketDecisionRecordBlockers,
  settlementRecordBlockers,
  selectOfficialSettlementMatch,
  sameCohortIdentity,
  settleCandidateProspectiveRegistry,
  temperatureTriplet,
  logPoolTriplet,
  nominationPolicyHashFor,
  postActivationEvidenceEvents,
  candidateGateSpecCompatibility,
  canonicalFunctionSource,
  candidateEvaluatorSemanticHashes,
  classifyCandidateDecisionEvidence,
  buildDecisionEvent,
  buildReviewCheckpointEvidence,
  REGISTRY_LOCK_VERSION,
  registryLockFileFor,
  processStartTimeForPid,
  readRegistryLockSnapshot,
  registryLockOwnerIsAlive,
  withCandidateProspectiveRegistryLock,
  appendEvent,
  auditLedger,
  updateCandidateProspectiveLedger,
} = require("./candidateProspectiveLedger.cjs");
const {
  nominationSelectionPolicyCommitment,
} = require("./shadowCandidateRobustness.cjs");
const {
  implementationDrift,
} = require("./captureCandidateProspectiveDeadline.cjs");

const implementationCommitment = {
  sourceHashes: {
    "scripts/runModelBacktest.cjs": "1".repeat(64),
    "scripts/candidateProspectiveLedger.cjs": "2".repeat(64),
  },
  dependencyLockHash: "3".repeat(64),
};

const candidate = {
  id: "market-temperature-1_25",
  role: "shadow-feature-candidate",
  featureSet: ["sporttery-market", "temperature-calibration"],
  weights: { market: 1, model: 0, temperature: 1.25 },
};

const baseline = {
  id: "market-baseline",
  role: "baseline",
  featureSet: [],
  weights: { market: 1, model: 0 },
};

const candidates = [baseline, candidate];
const inventory = candidateInventory(candidates, implementationCommitment);

const rehashLedger = (ledger) => {
  let previousHash = "0".repeat(64);
  ledger.events = ledger.events.map((event, index) => {
    const {
      eventHash: ignoredEventHash,
      previousHash: ignoredPreviousHash,
      sequence: ignoredSequence,
      ...payload
    } = event;
    void ignoredEventHash;
    void ignoredPreviousHash;
    void ignoredSequence;
    const sequence = index + 1;
    const eventHash = sha256({
      ledgerId: ledger.ledgerId,
      sequence,
      previousHash,
      event: payload,
    });
    const rehashed = {
      sequence,
      previousHash,
      eventHash,
      ...payload,
    };
    previousHash = eventHash;
    return rehashed;
  });
  ledger.rootHash = previousHash;
  return ledger;
};

const strictSnapshot = ({
  sourceMatchId,
  kickoffTime,
  capturedAt,
  firstSeenAt = capturedAt,
  receivedAt = capturedAt,
  clockEligible = true,
  withAttestation = true,
  withFeatureSnapshot = true,
}) => ({
  sourceMatchId,
  matchId: `sporttery_${sourceMatchId}`,
  kickoffTime,
  capturedAt,
  firstSeenAt,
  phase: "final",
  sourceCycleId: `cycle-${sourceMatchId}`,
  modelGeneratedAt: capturedAt,
  policyVersion: "prediction-policy-test-v1",
  promptVersion: "prediction-prompt-test-v1",
  modelVersion: "prediction-model-test-v1",
  calibrationVersion: "prediction-calibration-test-v1",
  best: {
    tipCode: "1",
    oddsPoolCode: "HAD",
    odds: 1.8,
    recommendationAction: "reference",
  },
  oneXTwo: {
    tipCode: "1",
    oddsPoolCode: "HAD",
    odds: 1.8,
    recommendationAction: "reference",
  },
  featureSnapshot: withFeatureSnapshot ? {
    version: "prediction-feature-snapshot-test-v1",
    capturedAt,
    modelGeneratedAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    modelVersion: "prediction-model-test-v1",
    calibrationVersion: "prediction-calibration-test-v1",
    modelInputs: {
      market: { home: 0.510729613734, draw: 0.270386266094, away: 0.218884120172 },
      form: { home: 1.8, away: 1.1 },
    },
  } : null,
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    sourceMatchId,
    matchId: `sporttery_${sourceMatchId}`,
    kickoffTime,
    capturedAt,
    decisionAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    policyVersion: "prediction-policy-test-v1",
    promptVersion: "prediction-prompt-test-v1",
    modelVersion: "prediction-model-test-v1",
    calibrationVersion: "prediction-calibration-test-v1",
    sourceTimestamps: {
      modelGeneratedAt: capturedAt,
    },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: clockEligible,
      blockers: clockEligible ? [] : ["synthetic-clock-failure"],
    },
    probabilities: {
      HAD: { "1": 0.59, X: 0.25, "2": 0.16 },
      HHAD: {
        line: -1,
        outcomes: { "1": 0.39, X: 0.31, "2": 0.3 },
      },
    },
    markets: {
      HAD: {
        odds: { "1": 1.8, X: 3.4, "2": 4.2 },
        marketProbabilities: {
          "1": 0.510729613734,
          X: 0.270386266094,
          "2": 0.218884120172,
        },
        observedAt: receivedAt,
        receivedAt,
        provenanceHash: withAttestation ? "4".repeat(64) : null,
        provenance: withAttestation ? {
          hash: "4".repeat(64),
          strict: {
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "6".repeat(64) },
        } : null,
      },
      HHAD: {
        line: -1,
        odds: { "1": 2.45, X: 3.5, "2": 2.35 },
        marketProbabilities: {
          "1": 0.364623739333,
          X: 0.255236617533,
          "2": 0.380139643134,
        },
        observedAt: receivedAt,
        receivedAt,
        provenanceHash: withAttestation ? "7".repeat(64) : null,
        provenance: withAttestation ? {
          hash: "7".repeat(64),
          strict: {
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "8".repeat(64) },
        } : null,
      },
    },
    exposure: {
      shadowTracks: {
        HHAD_COMPANION: {
          selection: {
            code: "1",
            handicapLine: -1,
            odds: 2.45,
            modelProbability: 0.39,
            marketProbability: 0.364623739333,
          },
        },
      },
    },
  },
});

const match = ({
  sourceMatchId,
  kickoffTime,
  leagueName = "  测试   联赛  ",
  buyEndTime = null,
  cutoffTime = null,
  predictionCutoffTime = null,
  status = "SCHEDULED",
  scoreHome = null,
  scoreAway = null,
  trustedResult = true,
}) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  leagueName,
  kickoffTime,
  buyEndTime,
  cutoffTime,
  predictionMeta: predictionCutoffTime ? { cutoffTime: predictionCutoffTime } : undefined,
  status,
  scoreHome,
  scoreAway,
  resultObservedAt: status === "FINISHED"
    ? new Date(Date.parse(kickoffTime) + 2 * 60 * 60_000).toISOString()
    : null,
  resultProvenance: status === "FINISHED" ? {
    official: trustedResult,
    trusted: trustedResult,
    provider: trustedResult ? "sporttery" : "unknown",
    observedAt: new Date(Date.parse(kickoffTime) + 2 * 60 * 60_000).toISOString(),
    eventVersion: kickoffTime,
  } : null,
});

const robustness = (ready) => ({
  version: "shadow-candidate-robustness-v1",
  family: { inventoryHash: inventory.hash },
  selectedCandidate: { id: candidate.id },
  candidateReadyForProspectiveTest: ready,
});

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
};

const sleepSync = (milliseconds) => {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, Math.max(0, Number(milliseconds || 0)));
};

const waitForFileSync = (filePath, timeoutMs = 2_000) => {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    sleepSync(10);
  }
  return true;
};

check("registry lock records a unique token and injectable process start time", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-metadata-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  try {
    const result = withCandidateProspectiveRegistryLock(
      registryFile,
      (lock) => {
        const metadata = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        assert.equal(metadata.version, REGISTRY_LOCK_VERSION);
        assert.equal(metadata.ownerToken, "deterministic-owner-token");
        assert.equal(metadata.pid, process.pid);
        assert.equal(metadata.processStartTime, "424242");
        assert.equal(lock.ownerToken, metadata.ownerToken);
        assert.equal(lock.processStartTime, metadata.processStartTime);
        return "recorded";
      },
      {
        ownerTokenFactory: () => "deterministic-owner-token",
        readProcessStartTime: () => "424242",
      },
    );
    assert.equal(result, "recorded");
    assert.equal(fs.existsSync(lockFile), false);

    const procFields = Array.from({ length: 20 }, (_, index) => String(index + 1));
    procFields[19] = "987654321";
    assert.equal(
      processStartTimeForPid(123, {
        platform: "linux",
        readFileSync: () => `123 (worker name with ) paren) ${procFields.join(" ")}`,
      }),
      "987654321",
    );
    let fallbackRead = false;
    assert.equal(
      processStartTimeForPid(123, {
        platform: "win32",
        readFileSync: () => {
          fallbackRead = true;
          return "must-not-read";
        },
      }),
      null,
    );
    assert.equal(fallbackRead, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock snapshot treats Windows delete-pending access errors as transient", () => {
  const fakeStat = { dev: 1, ino: 2, mtimeMs: Date.now() };
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const error = Object.assign(new Error(`injected ${code}`), { code });
    assert.equal(
      readRegistryLockSnapshot("injected-lock-file", {
        statSync: () => fakeStat,
        readFileSync: () => {
          throw error;
        },
      }),
      null,
    );
  }
});

check("registry lock waits for another process to release before acquiring", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-wait-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const readyFile = path.join(tempDir, "child-ready");
  const errorFile = path.join(tempDir, "child-error");
  const moduleFile = path.resolve(__dirname, "candidateProspectiveLedger.cjs");
  const childCode = [
    '"use strict";',
    'const fs = require("node:fs");',
    'const lockModule = require(process.argv[1]);',
    'const registryFile = process.argv[2];',
    'const readyFile = process.argv[3];',
    'const errorFile = process.argv[4];',
    'try {',
    '  lockModule.withCandidateProspectiveRegistryLock(registryFile, () => {',
    '    fs.writeFileSync(readyFile, "ready", "utf8");',
    '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);',
    '  });',
    '} catch (error) {',
    '  fs.writeFileSync(errorFile, error?.stack || String(error), "utf8");',
    '  process.exitCode = 1;',
    '}',
  ].join("\n");
  let child = null;
  try {
    child = spawn(
      process.execPath,
      ["-e", childCode, moduleFile, registryFile, readyFile, errorFile],
      { stdio: "ignore", windowsHide: true },
    );
    assert.equal(waitForFileSync(readyFile), true, "child lock owner did not become ready");
    assert.equal(fs.existsSync(errorFile), false);
    const startedAt = Date.now();
    assert.equal(
      withCandidateProspectiveRegistryLock(
        registryFile,
        () => "acquired-after-child",
        { timeoutMs: 2_000, retryMs: 5 },
      ),
      "acquired-after-child",
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 100, `lock wait ended too early: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2_000, `lock wait exceeded timeout: ${elapsedMs}ms`);
    assert.equal(fs.existsSync(errorFile), false);
    assert.equal(fs.existsSync(registryLockFileFor(registryFile)), false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock reclaims a legacy dead owner but never ages out a legacy live owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  const oldTime = new Date(Date.now() - 10_000);
  try {
    // Legacy v1 metadata has no version, token or process start time. A live
    // owner remains protected even after the configured stale threshold.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      acquiredAt: oldTime.toISOString(),
      registryFile,
    }), "utf8");
    fs.utimesSync(lockFile, oldTime, oldTime);
    assert.equal(registryLockOwnerIsAlive(lockFile), true);
    const liveOwnerBytes = fs.readFileSync(lockFile, "utf8");
    assert.throws(
      () => withCandidateProspectiveRegistryLock(
        registryFile,
        () => "must-not-run",
        { timeoutMs: 25, staleMs: 1_000, retryMs: 5 },
      ),
      (error) => error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT",
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.readFileSync(lockFile, "utf8"), liveOwnerBytes);

    // The same legacy shape is migrated safely once its PID is confirmed dead.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 2_147_483_647,
      acquiredAt: oldTime.toISOString(),
      registryFile,
    }), "utf8");
    fs.utimesSync(lockFile, oldTime, oldTime);
    assert.equal(registryLockOwnerIsAlive(lockFile), false);
    assert.equal(
      withCandidateProspectiveRegistryLock(
        registryFile,
        () => {
          const migrated = JSON.parse(fs.readFileSync(lockFile, "utf8"));
          assert.equal(migrated.version, REGISTRY_LOCK_VERSION);
          assert.equal(typeof migrated.ownerToken, "string");
          assert.ok(migrated.ownerToken.length > 0);
          assert.equal(migrated.pid, process.pid);
          return "recovered";
        },
        { timeoutMs: 100, staleMs: 1_000, retryMs: 5 },
      ),
      "recovered",
    );
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock protects young partial metadata and recovers it only after stale", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-partial-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  try {
    fs.writeFileSync(lockFile, '{"pid":', "utf8");
    assert.throws(
      () => withCandidateProspectiveRegistryLock(
        registryFile,
        () => "must-not-run",
        { timeoutMs: 25, staleMs: 1_000, retryMs: 5 },
      ),
      (error) => error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT",
    );
    assert.equal(fs.readFileSync(lockFile, "utf8"), '{"pid":');

    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFile, oldTime, oldTime);
    assert.equal(
      withCandidateProspectiveRegistryLock(
        registryFile,
        () => {
          const migrated = JSON.parse(fs.readFileSync(lockFile, "utf8"));
          assert.equal(migrated.version, REGISTRY_LOCK_VERSION);
          assert.equal(typeof migrated.ownerToken, "string");
          return "partial-recovered";
        },
        { timeoutMs: 100, staleMs: 1_000, retryMs: 5 },
      ),
      "partial-recovered",
    );
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock detects PID reuse through process start time", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-pid-reuse-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  const oldTime = new Date(Date.now() - 10_000);
  try {
    fs.writeFileSync(lockFile, JSON.stringify({
      version: REGISTRY_LOCK_VERSION,
      ownerToken: "previous-process-token",
      pid: process.pid,
      processStartTime: "111111",
      acquiredAt: oldTime.toISOString(),
      registryFile,
    }), "utf8");
    fs.utimesSync(lockFile, oldTime, oldTime);
    assert.equal(
      registryLockOwnerIsAlive(lockFile, { readProcessStartTime: () => "111111" }),
      true,
    );
    assert.equal(
      registryLockOwnerIsAlive(lockFile, { readProcessStartTime: () => "222222" }),
      false,
    );
    assert.equal(
      withCandidateProspectiveRegistryLock(
        registryFile,
        () => "pid-reuse-recovered",
        {
          timeoutMs: 100,
          retryMs: 5,
          ownerTokenFactory: () => "replacement-process-token",
          readProcessStartTime: () => "222222",
        },
      ),
      "pid-reuse-recovered",
    );
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock release preserves a same-inode replacement with another token", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-token-aba-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  try {
    withCandidateProspectiveRegistryLock(
      registryFile,
      () => {
        const replacement = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        replacement.ownerToken = "replacement-token";
        fs.writeFileSync(lockFile, JSON.stringify(replacement), "utf8");
      },
      {
        ownerTokenFactory: () => "original-token",
        readProcessStartTime: () => null,
      },
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(
      JSON.parse(fs.readFileSync(lockFile, "utf8")).ownerToken,
      "replacement-token",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock release preserves a same-token replacement with another owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-owner-aba-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  try {
    withCandidateProspectiveRegistryLock(
      registryFile,
      () => {
        const replacement = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        replacement.pid = process.pid + 1;
        fs.writeFileSync(lockFile, JSON.stringify(replacement), "utf8");
      },
      {
        ownerTokenFactory: () => "shared-token",
        readProcessStartTime: () => null,
      },
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid + 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock release preserves an ABA replacement on another inode", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-inode-aba-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  const displacedFile = `${lockFile}.displaced`;
  try {
    withCandidateProspectiveRegistryLock(
      registryFile,
      () => {
        const replacement = fs.readFileSync(lockFile, "utf8");
        fs.renameSync(lockFile, displacedFile);
        fs.writeFileSync(lockFile, replacement, "utf8");
      },
      {
        ownerTokenFactory: () => "same-owner-token",
        readProcessStartTime: () => "same-process-start",
      },
    );
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.existsSync(displacedFile), true);
    assert.equal(
      JSON.parse(fs.readFileSync(lockFile, "utf8")).ownerToken,
      "same-owner-token",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("registry lock supports sequential reacquisition and times out on nested contention", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-candidate-lock-reentry-"));
  const registryFile = path.join(tempDir, "candidate-prospective-registry.json");
  const lockFile = registryLockFileFor(registryFile);
  try {
    const ownerTokens = [];
    assert.equal(
      withCandidateProspectiveRegistryLock(registryFile, (lock) => {
        ownerTokens.push(lock.ownerToken);
        return "first";
      }),
      "first",
    );
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(
      withCandidateProspectiveRegistryLock(registryFile, (lock) => {
        ownerTokens.push(lock.ownerToken);
        return "second";
      }),
      "second",
    );
    assert.notEqual(ownerTokens[0], ownerTokens[1]);
    assert.equal(fs.existsSync(lockFile), false);

    withCandidateProspectiveRegistryLock(registryFile, () => {
      const outerOwnerBytes = fs.readFileSync(lockFile, "utf8");
      let nestedCallbackCount = 0;
      assert.throws(
        () => withCandidateProspectiveRegistryLock(
          registryFile,
          () => {
            nestedCallbackCount += 1;
            return "must-not-run";
          },
          { timeoutMs: 25, staleMs: 1_000, retryMs: 5 },
        ),
        (error) => error?.code === "CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT",
      );
      assert.equal(nestedCallbackCount, 0);
      assert.equal(fs.existsSync(lockFile), true);
      assert.equal(fs.readFileSync(lockFile, "utf8"), outerOwnerBytes);
    });
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("candidate commitment binds parameters, implementation and dependency lock", () => {
  const first = buildCandidateCommitment(candidate, implementationCommitment);
  const changed = buildCandidateCommitment(candidate, {
    ...implementationCommitment,
    dependencyLockHash: "9".repeat(64),
  });
  assert.match(first.candidateSpecHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.candidateSpecHash, changed.candidateSpecHash);
  assert.match(first.candidateRevisionId, /^market-temperature-1_25@[a-f0-9]{16}$/);
});

check("production semantic commitment is stable and binds the pure evaluator", () => {
  const semanticHashes = candidateEvaluatorSemanticHashes();
  assert.deepEqual(semanticHashes, {
    "candidate-probability-evaluator": CANDIDATE_EVALUATOR_IMPLEMENTATION_HASH,
    "result-input-timeline": require("./asOfResultTimeline.cjs").resultTimelineSemanticHash(),
  });
  assert.match(
    semanticHashes["candidate-probability-evaluator"],
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    canonicalFunctionSource({
      toString: () => "const evaluator = () => {\r\n  return 1;\r\n};\r",
    }),
    "const evaluator = () => {\n  return 1;\n};\n",
  );
  // This is the already-frozen production evaluator identity. Both Windows
  // CRLF and Linux LF checkouts must resolve to this same semantic hash.
  assert.equal(
    semanticHashes["candidate-probability-evaluator"],
    "cab792f5b33c93060cfe589c1f3e170823a73f197dd9be6d862ac01885c444db",
  );
  const stableCommitment = buildCandidateCommitment(candidate, {
    commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes,
    sourceHashes: {},
    dependencyLockHash: "",
  });
  const unrelatedOrchestrationEdit = buildCandidateCommitment(candidate, {
    commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes,
    sourceHashes: {},
    dependencyLockHash: "",
  });
  const changedEvaluator = buildCandidateCommitment(candidate, {
    commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes: {
      "candidate-probability-evaluator": "9".repeat(64),
    },
    sourceHashes: {},
    dependencyLockHash: "",
  });
  assert.equal(
    stableCommitment.candidateRevisionId,
    unrelatedOrchestrationEdit.candidateRevisionId,
  );
  assert.notEqual(
    stableCommitment.candidateRevisionId,
    changedEvaluator.candidateRevisionId,
  );
  const changedTimeline = buildCandidateCommitment(candidate, {
    commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
    semanticHashes: { ...semanticHashes, "result-input-timeline": "7".repeat(64) },
    sourceHashes: {}, dependencyLockHash: "",
  });
  assert.notEqual(stableCommitment.candidateRevisionId, changedTimeline.candidateRevisionId);
});

check("deadline capture independently rejects a changed semantic evaluator", () => {
  const validLedger = {
    header: {
      candidateImplementation: {
        evaluatorVersion: "frozen-shadow-candidate-evaluator-v3",
        commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
        semanticHashes: candidateEvaluatorSemanticHashes(),
        sourceHashes: {},
        dependencyLockHash: "",
      },
    },
  };
  assert.deepEqual(implementationDrift(validLedger), []);
  const driftedLedger = JSON.parse(JSON.stringify(validLedger));
  driftedLedger.header.candidateImplementation.semanticHashes[
    "candidate-probability-evaluator"
  ] = "8".repeat(64);
  assert.deepEqual(implementationDrift(driftedLedger), [
    "semantic-hash-mismatch:candidate-probability-evaluator",
  ]);
  for (const replacement of [undefined, "8".repeat(64)]) {
    const timelineDrift = JSON.parse(JSON.stringify(validLedger));
    if (replacement === undefined) delete timelineDrift.header.candidateImplementation.semanticHashes["result-input-timeline"];
    else timelineDrift.header.candidateImplementation.semanticHashes["result-input-timeline"] = replacement;
    assert.deepEqual(implementationDrift(timelineDrift), ["semantic-hash-mismatch:result-input-timeline"]);
  }
});

check("inventory hash matches the frozen candidate family definition", () => {
  assert.equal(inventory.count, 2);
  assert.match(inventory.hash, /^[a-f0-9]{64}$/);
  assert.match(inventory.commitmentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(inventory.hash, inventory.commitmentHash);
});

check("league identity is normalized from pre-match source data with an explicit unknown", () => {
  assert.equal(
    normalizedLeagueForMatch({ leagueName: "  欧罗巴   联赛  " }),
    "欧罗巴 联赛",
  );
  assert.equal(
    normalizedLeagueForMatch({ competition: { name: "  UEFA   Europa League " } }),
    "UEFA Europa League",
  );
  assert.equal(normalizedLeagueForMatch({ leagueId: 204 }), "league-id:204");
  assert.equal(normalizedLeagueForMatch({}), "unknown");
});

check("temperature 1.25 is deterministic and normalised", () => {
  const value = temperatureTriplet({ "1": 0.6, X: 0.25, "2": 0.15 }, 1.25);
  assert.ok(value);
  assert.ok(Math.abs(value["1"] + value.X + value["2"] - 1) < 1e-9);
  assert.ok(value["1"] < 0.6);
});

check("decision evidence classifier separates unpublished HAD, strict HAD, HHAD and atomic failures", () => {
  const completeHad = {
    odds: { "1": 1.8, X: 3.4, "2": 4.2 },
    marketProbabilities: { "1": 0.51, X: 0.27, "2": 0.22 },
  };
  assert.deepEqual(
    classifyCandidateDecisionEvidence({
      had: {},
      blockers: ["same-decision-devigged-market-missing"],
    }),
    {
      officialHadMarketPresent: false,
      strictOfficialMarketEvidenceComplete: false,
      hhadCompanionEvidenceComplete: true,
      marketState: "official-had-market-not-published",
      primaryExclusionReason: "official-had-market-not-published",
    },
  );
  assert.equal(
    classifyCandidateDecisionEvidence({
      had: completeHad,
      blockers: ["collector-attestation-key-id-missing"],
    }).primaryExclusionReason,
    "official-had-evidence-incomplete",
  );
  assert.equal(
    classifyCandidateDecisionEvidence({
      had: completeHad,
      blockers: ["hhad-odds-triplet-invalid"],
    }).primaryExclusionReason,
    "hhad-companion-evidence-incomplete",
  );
  assert.equal(
    classifyCandidateDecisionEvidence({
      had: completeHad,
      blockers: ["feature-snapshot-missing"],
    }).primaryExclusionReason,
    "atomic-decision-evidence-incomplete",
  );
});

check("negative model residual is deterministic and uses the frozen base model", () => {
  const market = { "1": 0.55, X: 0.29, "2": 0.16 };
  const model = { "1": 0.66, X: 0.21, "2": 0.13 };
  const value = logPoolTriplet(market, model, {
    marketWeight: 1.2,
    modelWeight: -0.2,
    temperature: 1,
  });
  assert.ok(value);
  assert.ok(Math.abs(value["1"] + value.X + value["2"] - 1) < 1e-9);
  assert.ok(value["1"] < market["1"]);
});

check("negative residual deadline capture atomically freezes the exact evaluator inputs", () => {
  const negativeCandidate = {
    id: "market-current-model-residual-minus-20-temperature-0_9",
    role: "shadow-feature-candidate",
    featureSet: ["sporttery-market", "current-model-residual", "temperature-calibration"],
    weights: { market: 1.2, model: -0.2, temperature: 0.9 },
  };
  const negativeCandidates = [baseline, negativeCandidate];
  const negativeInventory = candidateInventory(negativeCandidates, implementationCommitment);
  const negativeRobustness = {
    version: "shadow-candidate-robustness-v1",
    family: { inventoryHash: negativeInventory.hash },
    selectedCandidate: { id: negativeCandidate.id },
    candidateReadyForProspectiveTest: false,
  };
  const negativeMatch = match({
    sourceMatchId: "negative-residual-1",
    kickoffTime: "2026-07-27T01:00:00.000Z",
  });
  const negativeSnapshot = strictSnapshot({
    sourceMatchId: "negative-residual-1",
    kickoffTime: negativeMatch.kickoffTime,
    capturedAt: "2026-07-27T00:40:00.000Z",
  });
  const frozen = updateCandidateProspectiveLedger({
    candidates: negativeCandidates,
    selectedCandidate: negativeCandidate,
    robustness: negativeRobustness,
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T00:00:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const captured = updateCandidateProspectiveLedger({
    priorRegistry: frozen.registry,
    candidates: negativeCandidates,
    selectedCandidate: negativeCandidate,
    robustness: negativeRobustness,
    matches: [negativeMatch],
    snapshots: [negativeSnapshot],
    evaluatedAt: "2026-07-27T00:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const ledger = captured.registry.ledgers[0];
  const decision = ledger.events.find((event) => event.type === "decision");
  const expected = logPoolTriplet(
    negativeSnapshot.decisionSnapshot.markets.HAD.marketProbabilities,
    negativeSnapshot.decisionSnapshot.probabilities.HAD,
    { marketWeight: 1.2, modelWeight: -0.2, temperature: 0.9 },
  );
  assert.deepEqual(decision.baseModelProbabilities, {
    "1": 0.59,
    "2": 0.16,
    X: 0.25,
  });
  assert.equal(decision.leagueNormalizationVersion, LEAGUE_NORMALIZATION_VERSION);
  assert.equal(decision.league, "测试 联赛");
  assert.deepEqual(decision.probabilities, expected);
  assert.match(decision.atomicDecisionHash, /^[a-f0-9]{64}$/);
  assert.notEqual(
    atomicDecisionHashFor({ ...decision, league: "另一联赛" }),
    decision.atomicDecisionHash,
  );
  assert.equal(verifyLedger(ledger).valid, true);
  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.events.find((event) => event.type === "decision")
    .baseModelProbabilities["1"] = 0.6;
  assert.equal(verifyLedger(tampered).valid, false);
});

check("mixed slate admits complete market evidence and explicitly excludes marketless peers", () => {
  const mixedCandidate = {
    id: "market-current-model-residual-minus-20-temperature-0_9",
    role: "shadow-feature-candidate",
    featureSet: ["sporttery-market", "current-model-residual", "temperature-calibration"],
    weights: { market: 1.2, model: -0.2, temperature: 0.9 },
  };
  const mixedCandidates = [baseline, mixedCandidate];
  const mixedInventory = candidateInventory(mixedCandidates, implementationCommitment);
  const mixedRobustness = {
    version: "shadow-candidate-robustness-v1",
    family: { inventoryHash: mixedInventory.hash },
    selectedCandidate: { id: mixedCandidate.id },
    candidateReadyForProspectiveTest: false,
  };
  const completeMatch = match({
    sourceMatchId: "mixed-complete-1",
    kickoffTime: "2026-07-27T01:00:00.000Z",
  });
  const marketlessMatch = match({
    sourceMatchId: "mixed-marketless-1",
    kickoffTime: "2026-07-27T01:00:00.000Z",
  });
  const completeSnapshot = strictSnapshot({
    sourceMatchId: completeMatch.sourceMatchId,
    kickoffTime: completeMatch.kickoffTime,
    capturedAt: "2026-07-27T00:40:00.000Z",
  });
  const marketlessSnapshot = strictSnapshot({
    sourceMatchId: marketlessMatch.sourceMatchId,
    kickoffTime: marketlessMatch.kickoffTime,
    capturedAt: "2026-07-27T00:40:00.000Z",
  });
  marketlessSnapshot.decisionSnapshot.markets = {};
  const frozen = updateCandidateProspectiveLedger({
    candidates: mixedCandidates,
    selectedCandidate: mixedCandidate,
    robustness: mixedRobustness,
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T00:00:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const captured = updateCandidateProspectiveLedger({
    priorRegistry: frozen.registry,
    candidates: mixedCandidates,
    selectedCandidate: mixedCandidate,
    robustness: mixedRobustness,
    matches: [completeMatch, marketlessMatch],
    snapshots: [completeSnapshot, marketlessSnapshot],
    evaluatedAt: "2026-07-27T00:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const ledger = captured.registry.ledgers[0];
  const decision = ledger.events.find((event) => (
    event.type === "decision" && event.sourceMatchId === completeMatch.sourceMatchId
  ));
  const exclusion = ledger.events.find((event) => (
    event.type === "exclusion" && event.sourceMatchId === marketlessMatch.sourceMatchId
  ));
  assert.ok(decision);
  assert.match(decision.atomicDecisionHash, /^[a-f0-9]{64}$/);
  assert.ok(exclusion);
  assert.equal(exclusion.officialHadMarketPresent, false);
  assert.equal(exclusion.strictOfficialMarketEvidenceComplete, false);
  assert.equal(exclusion.hhadCompanionEvidenceComplete, false);
  assert.equal(exclusion.marketState, "official-had-market-not-published");
  assert.equal(
    exclusion.primaryExclusionReason,
    "official-had-market-not-published",
  );
  for (const blocker of [
    "collector-attestation-commitment-hash-missing",
    "collector-attestation-key-id-missing",
    "had-odds-triplet-invalid",
    "hhad-odds-triplet-invalid",
    "market-provenance-hash-missing",
    "odds-observed-at-missing",
    "odds-received-at-missing",
    "same-decision-devigged-market-missing",
  ]) {
    assert.ok(exclusion.blockers.includes(blocker), blocker);
  }
  assert.equal(verifyLedger(ledger).valid, true);
});

let firstUpdate = updateCandidateProspectiveLedger({
  candidates,
  selectedCandidate: candidate,
  robustness: robustness(false),
  matches: [],
  snapshots: [],
  evaluatedAt: "2026-07-27T00:00:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});

check("first run freezes candidate and starts shadow without online effect", () => {
  assert.equal(firstUpdate.chainValid, true);
  assert.equal(firstUpdate.registry.version, REGISTRY_VERSION);
  assert.equal(firstUpdate.registry.ledgers.length, 1);
  const ledger = firstUpdate.registry.ledgers[0];
  assert.equal(ledger.version, LEDGER_VERSION);
  assert.equal(firstUpdate.audit.version, AUDIT_VERSION);
  assert.equal(firstUpdate.audit.state, "SHADOW");
  assert.equal(firstUpdate.audit.onlineEffect, false);
  assert.equal(firstUpdate.audit.cohort.formal.universe, 0);
  assert.ok(firstUpdate.audit.blockers.includes("formal-activation-missing"));
});

const shadowMatch = match({
  sourceMatchId: "shadow-1",
  kickoffTime: "2026-07-27T01:00:00.000Z",
});
const shadowSnapshot = strictSnapshot({
  sourceMatchId: "shadow-1",
  kickoffTime: shadowMatch.kickoffTime,
  capturedAt: "2026-07-27T00:40:00.000Z",
});

let shadowUpdate = updateCandidateProspectiveLedger({
  priorRegistry: firstUpdate.registry,
  candidates,
  selectedCandidate: candidate,
  robustness: robustness(false),
  matches: [shadowMatch],
  snapshots: [shadowSnapshot],
  evaluatedAt: "2026-07-27T00:55:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});

check("deadline capture enters pre-gate shadow and never formal denominator", () => {
  assert.equal(shadowUpdate.audit.state, "SHADOW");
  assert.equal(shadowUpdate.audit.cohort.shadow.universe, 1);
  assert.equal(shadowUpdate.audit.cohort.shadow.admitted, 1);
  assert.equal(shadowUpdate.audit.cohort.formal.universe, 0);
});

check("admitted decision atomically embeds features, clocks and strategy versions", () => {
  const ledger = shadowUpdate.registry.ledgers[0];
  const decision = ledger.events.find((event) => event.type === "decision");
  assert.equal(decision.decisionRecordVersion, DECISION_RECORD_VERSION);
  assert.equal(
    decision.atomicDecisionValidationVersion,
    ATOMIC_DECISION_VALIDATION_VERSION,
  );
  assert.deepEqual(decision.baseModelProbabilities, {
    "1": 0.59,
    "2": 0.16,
    X: 0.25,
  });
  assert.equal(decision.featureSnapshot.modelInputs.form.home, 1.8);
  assert.equal(decision.featureSnapshotHash, sha256(decision.featureSnapshot));
  assert.equal(decision.sourceClock.sourceCycleId, "cycle-shadow-1");
  assert.equal(decision.sourceClockHash, sha256(decision.sourceClock));
  assert.equal(
    decision.strategyVersions.predictionPolicyVersion,
    "prediction-policy-test-v1",
  );
  assert.equal(decision.strategyVersionsHash, sha256(decision.strategyVersions));
  assert.equal(
    decision.dualMarketDecision.version,
    DUAL_MARKET_DECISION_RECORD_VERSION,
  );
  assert.equal(decision.dualMarketDecision.formalMetricMarket, "HAD");
  assert.equal(decision.dualMarketDecision.companionMarket, "HHAD");
  assert.equal(decision.dualMarketDecision.markets.HAD.recommendation.code, "1");
  assert.equal(decision.dualMarketDecision.markets.HHAD.recommendation.code, "1");
  assert.equal(decision.dualMarketDecision.markets.HHAD.line, -1);
  assert.equal(
    decision.dualMarketDecisionHash,
    sha256(decision.dualMarketDecision),
  );
  assert.deepEqual(dualMarketDecisionRecordBlockers(decision), []);
  assert.match(decision.atomicDecisionHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(atomicDecisionRecordBlockers(decision), []);
  assert.equal(atomicDecisionRecordValid(decision), true);
  assert.equal(
    shadowUpdate.audit.decisionRecord.validationVersion,
    ATOMIC_DECISION_VALIDATION_VERSION,
  );
  assert.deepEqual(
    shadowUpdate.audit.decisionRecord.requiredFields,
    [...ATOMIC_DECISION_REQUIRED_FIELDS],
  );
  assert.equal(shadowUpdate.audit.decisionRecord.completeRows, 1);
  assert.equal(shadowUpdate.audit.decisionRecord.failedRows, 0);
  assert.deepEqual(shadowUpdate.audit.decisionRecord.blockerCounts, {});
  const tampered = JSON.parse(JSON.stringify(ledger));
  tampered.events.find((event) => event.type === "decision")
    .featureSnapshot.modelInputs.form.home = 9.9;
  assert.equal(verifyLedger(tampered).valid, false);

  const dualMarketTampered = JSON.parse(JSON.stringify(ledger));
  const dualMarketDecision = dualMarketTampered.events.find(
    (event) => event.type === "decision",
  );
  dualMarketDecision.dualMarketDecision.markets.HHAD.recommendation.code = "2";
  dualMarketDecision.dualMarketDecisionHash = sha256(
    dualMarketDecision.dualMarketDecision,
  );
  dualMarketDecision.atomicDecisionHash = atomicDecisionHashFor(
    dualMarketDecision,
  );
  rehashLedger(dualMarketTampered);
  assert.ok(
    dualMarketDecisionRecordBlockers(dualMarketDecision)
      .includes("hhad-recommendation-odds-mismatch"),
  );
  assert.equal(verifyLedger(dualMarketTampered).valid, false);

  const leagueTampered = JSON.parse(JSON.stringify(ledger));
  leagueTampered.events.find((event) => event.type === "decision").league = "另一联赛";
  assert.equal(verifyLedger(leagueTampered).valid, false);
});

check("pre-extension v3 decisions remain hash-valid without rewriting history", () => {
  const legacyLedger = JSON.parse(JSON.stringify(
    shadowUpdate.registry.ledgers[0],
  ));
  const legacyDecision = legacyLedger.events.find(
    (event) => event.type === "decision",
  );
  delete legacyDecision.atomicDecisionValidationVersion;
  delete legacyDecision.dualMarketDecision;
  delete legacyDecision.dualMarketDecisionHash;
  delete legacyDecision.leagueNormalizationVersion;
  delete legacyDecision.league;
  legacyDecision.atomicDecisionHash = atomicDecisionHashFor(legacyDecision);
  rehashLedger(legacyLedger);
  const legacyRootHash = legacyLedger.rootHash;
  const legacyEvents = structuredClone(legacyLedger.events);
  assert.deepEqual(atomicDecisionRecordBlockers(legacyDecision), []);
  assert.equal(atomicDecisionRecordValid(legacyDecision), true);
  assert.equal(verifyLedger(legacyLedger).valid, true);

  const legacyRegistry = structuredClone(shadowUpdate.registry);
  legacyRegistry.ledgers = legacyRegistry.ledgers.map((ledger) => (
    ledger.ledgerId === legacyLedger.ledgerId ? legacyLedger : ledger
  ));
  const repeated = updateCandidateProspectiveLedger({
    priorRegistry: legacyRegistry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [shadowMatch],
    snapshots: [shadowSnapshot],
    evaluatedAt: "2026-07-27T00:56:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const repeatedLegacyLedger = repeated.registry.ledgers.find(
    (ledger) => ledger.ledgerId === legacyLedger.ledgerId,
  );
  assert.equal(repeatedLegacyLedger.rootHash, legacyRootHash);
  assert.deepEqual(repeatedLegacyLedger.events, legacyEvents);
});

check("missing league is committed as unknown and settlement cannot backfill it", () => {
  const unknownLeagueMatch = match({
    sourceMatchId: "unknown-league-1",
    kickoffTime: "2026-07-27T04:00:00.000Z",
    leagueName: null,
  });
  const unknownLeagueSnapshot = strictSnapshot({
    sourceMatchId: unknownLeagueMatch.sourceMatchId,
    kickoffTime: unknownLeagueMatch.kickoffTime,
    capturedAt: "2026-07-27T03:40:00.000Z",
  });
  const captured = updateCandidateProspectiveLedger({
    priorRegistry: structuredClone(firstUpdate.registry),
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [unknownLeagueMatch],
    snapshots: [unknownLeagueSnapshot],
    evaluatedAt: "2026-07-27T03:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const capturedLedger = captured.registry.ledgers.find(
    (ledger) => ledger.ledgerId === captured.registry.activeLedgerId,
  );
  const capturedDecision = capturedLedger.events.find(
    (event) => event.type === "decision" && event.sourceMatchId === "unknown-league-1",
  );
  assert.equal(capturedDecision.league, "unknown");
  assert.equal(capturedDecision.leagueNormalizationVersion, LEAGUE_NORMALIZATION_VERSION);
  assert.deepEqual(atomicDecisionRecordBlockers(capturedDecision), []);
  const decisionEventHash = capturedDecision.eventHash;

  const settled = settleCandidateProspectiveRegistry({
    priorRegistry: captured.registry,
    matches: [match({
      sourceMatchId: "unknown-league-1",
      kickoffTime: unknownLeagueMatch.kickoffTime,
      leagueName: "赛后补充联赛",
      status: "FINISHED",
      scoreHome: 1,
      scoreAway: 0,
    })],
    evaluatedAt: "2026-07-27T05:10:00.000Z",
  });
  const settledLedger = settled.registry.ledgers.find(
    (ledger) => ledger.ledgerId === settled.registry.activeLedgerId,
  );
  const settledDecision = settledLedger.events.find(
    (event) => event.eventHash === decisionEventHash,
  );
  assert.equal(settledDecision.league, "unknown");
  assert.equal(settledDecision.eventHash, decisionEventHash);
  assert.equal(settled.settlementsAdded, 1);
});

check("recomputed hashes cannot disguise incomplete fields or impossible source clocks", () => {
  const sourceLedger = shadowUpdate.registry.ledgers[0];

  const missingOdds = JSON.parse(JSON.stringify(sourceLedger));
  const missingOddsDecision = missingOdds.events.find((event) => event.type === "decision");
  delete missingOddsDecision.odds["2"];
  missingOddsDecision.atomicDecisionHash = atomicDecisionHashFor(missingOddsDecision);
  rehashLedger(missingOdds);
  assert.ok(atomicDecisionRecordBlockers(missingOddsDecision).includes("odds-triplet-invalid"));
  assert.equal(atomicDecisionRecordValid(missingOddsDecision), false);
  assert.equal(verifyLedger(missingOdds).valid, false);

  const missingStrategy = JSON.parse(JSON.stringify(sourceLedger));
  const missingStrategyDecision = missingStrategy.events.find((event) => event.type === "decision");
  delete missingStrategyDecision.strategyVersions.modelVersion;
  missingStrategyDecision.strategyVersionsHash = sha256(
    missingStrategyDecision.strategyVersions,
  );
  missingStrategyDecision.atomicDecisionHash = atomicDecisionHashFor(
    missingStrategyDecision,
  );
  rehashLedger(missingStrategy);
  assert.ok(
    atomicDecisionRecordBlockers(missingStrategyDecision)
      .includes("strategy-modelVersion-missing"),
  );
  assert.equal(verifyLedger(missingStrategy).valid, false);

  const impossibleClock = JSON.parse(JSON.stringify(sourceLedger));
  const impossibleClockDecision = impossibleClock.events.find((event) => event.type === "decision");
  impossibleClockDecision.oddsReceivedAt = new Date(
    Date.parse(impossibleClockDecision.decisionAt) + 1_000,
  ).toISOString();
  impossibleClockDecision.sourceClock.oddsReceivedAt =
    impossibleClockDecision.oddsReceivedAt;
  impossibleClockDecision.sourceClockHash = sha256(
    impossibleClockDecision.sourceClock,
  );
  impossibleClockDecision.atomicDecisionHash = atomicDecisionHashFor(
    impossibleClockDecision,
  );
  rehashLedger(impossibleClock);
  assert.ok(
    atomicDecisionRecordBlockers(impossibleClockDecision)
      .includes("odds-received-after-decision"),
  );
  assert.equal(verifyLedger(impossibleClock).valid, false);
});

check("missing feature payload is counted as an exclusion, not an unauditable decision", () => {
  const noFeatureMatch = match({
    sourceMatchId: "no-feature-1",
    kickoffTime: "2026-07-27T02:00:00.000Z",
  });
  const noFeatureSnapshot = strictSnapshot({
    sourceMatchId: "no-feature-1",
    kickoffTime: noFeatureMatch.kickoffTime,
    capturedAt: "2026-07-27T01:40:00.000Z",
    withFeatureSnapshot: false,
  });
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: firstUpdate.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [noFeatureMatch],
    snapshots: [noFeatureSnapshot],
    evaluatedAt: "2026-07-27T01:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const exclusion = updated.registry.ledgers[0].events.find(
    (event) => event.type === "exclusion" && event.sourceMatchId === "no-feature-1",
  );
  assert.ok(exclusion);
  assert.ok(exclusion.blockers.includes("feature-snapshot-missing"));
  assert.ok(exclusion.blockers.includes("feature-model-inputs-missing"));
  assert.equal(
    exclusion.primaryExclusionReason,
    "atomic-decision-evidence-incomplete",
  );
});

check("a later weak direct snapshot cannot hide an earlier eligible relay snapshot", () => {
  const relayMatch = match({
    sourceMatchId: "relay-fallback-1",
    kickoffTime: "2026-07-27T04:00:00.000Z",
  });
  const eligibleRelaySnapshot = strictSnapshot({
    sourceMatchId: "relay-fallback-1",
    kickoffTime: relayMatch.kickoffTime,
    capturedAt: "2026-07-27T03:30:00.000Z",
  });
  const laterWeakDirectSnapshot = strictSnapshot({
    sourceMatchId: "relay-fallback-1",
    kickoffTime: relayMatch.kickoffTime,
    capturedAt: "2026-07-27T03:40:00.000Z",
    clockEligible: false,
    withAttestation: false,
  });
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: firstUpdate.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [relayMatch],
    snapshots: [eligibleRelaySnapshot, laterWeakDirectSnapshot],
    evaluatedAt: "2026-07-27T03:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const ledger = updated.registry.ledgers[0];
  const decision = ledger.events.find((event) => (
    event.type === "decision" && event.sourceMatchId === "relay-fallback-1"
  ));
  assert.ok(decision);
  assert.equal(decision.snapshotCapturedAt, eligibleRelaySnapshot.capturedAt);
  assert.equal(decision.snapshotHash, sha256(eligibleRelaySnapshot));
  assert.equal(decision.admissionEligible, true);
  assert.equal(
    ledger.events.some((event) => (
      event.type === "exclusion" && event.sourceMatchId === "relay-fallback-1"
    )),
    false
  );
});

check("official sale cutoff closes prospective admission before the kickoff offset", () => {
  const cutoffMatch = match({
    sourceMatchId: "official-cutoff-1",
    kickoffTime: "2026-07-27T05:00:00.000Z",
    buyEndTime: "2026-07-27T01:00:00.000Z",
  });
  const cutoffSnapshot = strictSnapshot({
    sourceMatchId: "official-cutoff-1",
    kickoffTime: cutoffMatch.kickoffTime,
    capturedAt: "2026-07-27T00:40:00.000Z",
  });
  const deadline = decisionDeadlineFor(cutoffMatch);
  assert.equal(deadline.version, DECISION_DEADLINE_POLICY_VERSION);
  assert.equal(deadline.value, "2026-07-27T01:00:00.000Z");
  assert.equal(deadline.source, "buy-end-time");

  const cutoffFrozen = updateCandidateProspectiveLedger({
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T00:00:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const beforeCutoff = updateCandidateProspectiveLedger({
    priorRegistry: cutoffFrozen.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [cutoffMatch],
    snapshots: [cutoffSnapshot],
    evaluatedAt: "2026-07-27T00:59:59.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(beforeCutoff.audit.cohort.shadow.universe, 0);

  const atCutoff = updateCandidateProspectiveLedger({
    priorRegistry: beforeCutoff.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(false),
    matches: [cutoffMatch],
    snapshots: [cutoffSnapshot],
    evaluatedAt: "2026-07-27T01:02:01.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(atCutoff.audit.cohort.shadow.universe, 1);
  assert.equal(atCutoff.audit.cohort.shadow.admitted, 1);
  const decision = atCutoff.registry.ledgers[0].events
    .find((event) => event.type === "decision");
  assert.equal(decision.decisionDeadlineAt, "2026-07-27T01:00:00.000Z");
  assert.equal(decision.decisionDeadlineSource, "buy-end-time");
  assert.equal(decision.captureFinalizationAt, "2026-07-27T01:02:00.000Z");
  assert.equal(decision.captureFinalizationPolicyVersion, "deadline-evidence-grace-v1");
  assert.equal(decision.captureFinalizationGraceSeconds, 120);
});

let activatedUpdate = updateCandidateProspectiveLedger({
  priorRegistry: shadowUpdate.registry,
  candidates,
  selectedCandidate: candidate,
  robustness: robustness(true),
  matches: [shadowMatch],
  snapshots: [shadowSnapshot],
  evaluatedAt: "2026-07-27T01:05:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});

check("robustness-bound candidate activates but pre-gate rows stay observational", () => {
  assert.equal(activatedUpdate.audit.state, "ACTIVE");
  assert.equal(activatedUpdate.audit.cohort.shadow.universe, 1);
  assert.equal(activatedUpdate.audit.cohort.formal.universe, 0);
  const activation = activatedUpdate.registry.ledgers[0].events
    .find((event) => event.type === "activation");
  assert.equal(activation.robustnessInventoryHash, inventory.hash);
  assert.equal(activation.windowBoundaries.length, 6);
  assert.equal(
    postActivationEvidenceEvents(activatedUpdate.registry.ledgers[0]).length,
    0,
  );
});

check("an activated trial survives retrospective inventory churn when its evaluator is unchanged", () => {
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: activatedUpdate.registry,
    candidates: [baseline],
    selectedCandidate: baseline,
    robustness: robustness(false),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T01:05:30.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.registry.ledgers.length, 1);
  assert.equal(updated.registry.activeLedgerId, activatedUpdate.registry.activeLedgerId);
  assert.equal(updated.audit.state, "ACTIVE");
  assert.equal(
    updated.registry.ledgers[0].events.some((event) => event.type === "retirement"),
    false,
  );
});

check("a versioned nomination-policy change may refreeze a zero-evidence active trial", () => {
  const policyCommitment = nominationSelectionPolicyCommitment();
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: activatedUpdate.registry,
    candidates,
    selectedCandidate: baseline,
    robustness: robustness(false),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T01:06:00.000Z",
    implementationCommitment,
    nominationPolicyCommitment: policyCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.registry.ledgers.length, 2);
  assert.notEqual(updated.registry.activeLedgerId, activatedUpdate.registry.activeLedgerId);
  const retired = updated.registry.ledgers[0].events
    .find((event) => event.type === "retirement");
  const replacement = updated.registry.ledgers[1];
  assert.equal(
    retired.reason,
    "zero-evidence-nomination-policy-revision-changed",
  );
  assert.equal(retired.postActivationEvidenceCount, 0);
  assert.equal(
    replacement.header.nominationPolicyHash,
    nominationPolicyHashFor(policyCommitment),
  );
  assert.equal(replacement.header.baseCandidateId, baseline.id);
});

const formalMatch = match({
  sourceMatchId: "formal-1",
  kickoffTime: "2026-07-27T03:00:00.000Z",
});
const formalSnapshot = strictSnapshot({
  sourceMatchId: "formal-1",
  kickoffTime: formalMatch.kickoffTime,
  capturedAt: "2026-07-27T02:40:00.000Z",
});

let formalCapture = updateCandidateProspectiveLedger({
  priorRegistry: activatedUpdate.registry,
  candidates,
  selectedCandidate: candidate,
  robustness: robustness(true),
  matches: [shadowMatch, formalMatch],
  snapshots: [shadowSnapshot, formalSnapshot],
  evaluatedAt: "2026-07-27T02:55:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});

check("post-activation deadline capture enters formal cohort exactly once", () => {
  assert.equal(formalCapture.audit.cohort.formal.universe, 1);
  assert.equal(formalCapture.audit.cohort.formal.admitted, 1);
  assert.equal(formalCapture.audit.cohort.formal.pending, 1);
  const again = updateCandidateProspectiveLedger({
    priorRegistry: formalCapture.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [shadowMatch, formalMatch],
    snapshots: [shadowSnapshot, formalSnapshot],
    evaluatedAt: "2026-07-27T02:56:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(again.audit.cohort.formal.universe, 1);
  assert.equal(again.audit.cohort.formal.admitted, 1);
});

const settledFormalMatch = match({
  sourceMatchId: "formal-1",
  kickoffTime: formalMatch.kickoffTime,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
});
const supplementalFormalMatch = match({
  sourceMatchId: "formal-1",
  kickoffTime: formalMatch.kickoffTime,
  status: "FINISHED",
  scoreHome: 1,
  scoreAway: 1,
  trustedResult: false,
});

check("strict Sporttery settlement wins over an earlier supplemental final", () => {
  assert.equal(
    selectOfficialSettlementMatch(
      [supplementalFormalMatch, settledFormalMatch],
      {
        matchId: formalMatch.id,
        sourceMatchId: formalMatch.sourceMatchId,
        kickoffAt: formalMatch.kickoffTime,
      },
    ),
    settledFormalMatch,
  );
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: structuredClone(formalCapture.registry),
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [shadowMatch, supplementalFormalMatch, settledFormalMatch],
    snapshots: [shadowSnapshot, formalSnapshot],
    evaluatedAt: "2026-07-27T05:10:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.audit.cohort.formal.settled, 1);
  assert.equal(updated.audit.cohort.formal.pending, 0);
});

check("conflicting strict Sporttery finals fail closed instead of using array order", () => {
  const conflictingFormalMatch = match({
    sourceMatchId: "formal-1",
    kickoffTime: formalMatch.kickoffTime,
    status: "FINISHED",
    scoreHome: 0,
    scoreAway: 1,
  });
  assert.equal(
    selectOfficialSettlementMatch(
      [settledFormalMatch, conflictingFormalMatch],
      {
        matchId: formalMatch.id,
        sourceMatchId: formalMatch.sourceMatchId,
        kickoffAt: formalMatch.kickoffTime,
      },
    ),
    null,
  );
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: structuredClone(formalCapture.registry),
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [shadowMatch, settledFormalMatch, conflictingFormalMatch],
    snapshots: [shadowSnapshot, formalSnapshot],
    evaluatedAt: "2026-07-27T05:10:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.audit.cohort.formal.settled, 0);
  assert.equal(updated.audit.cohort.formal.pending, 1);
});

check("settlement-only accepts a trusted reconciled effective final and is idempotent", () => {
  const effectiveFinal = {
    ...settledFormalMatch,
    status: "PENDING_RESULT",
    effectiveStatus: "FINISHED",
  };
  assert.equal(
    selectOfficialSettlementMatch([effectiveFinal], {
      matchId: formalMatch.id,
      sourceMatchId: formalMatch.sourceMatchId,
      kickoffAt: formalMatch.kickoffTime,
    }),
    effectiveFinal,
  );
  const first = settleCandidateProspectiveRegistry({
    priorRegistry: structuredClone(formalCapture.registry),
    matches: [effectiveFinal],
    evaluatedAt: "2026-07-27T05:10:00.000Z",
  });
  assert.equal(first.chainValid, true);
  assert.equal(first.changed, true);
  assert.equal(first.settlementsAdded, 1);
  assert.equal(first.audit.cohort.formal.settled, 1);
  const firstLedger = first.registry.ledgers.find(
    (row) => row.ledgerId === first.registry.activeLedgerId,
  );
  const second = settleCandidateProspectiveRegistry({
    priorRegistry: first.registry,
    matches: [effectiveFinal],
    evaluatedAt: "2026-07-27T05:11:00.000Z",
  });
  const secondLedger = second.registry.ledgers.find(
    (row) => row.ledgerId === second.registry.activeLedgerId,
  );
  assert.equal(second.changed, false);
  assert.equal(second.settlementsAdded, 0);
  assert.equal(secondLedger.rootHash, firstLedger.rootHash);
});

let settlementUpdate = updateCandidateProspectiveLedger({
  priorRegistry: formalCapture.registry,
  candidates,
  selectedCandidate: candidate,
  robustness: robustness(true),
  matches: [shadowMatch, settledFormalMatch],
  snapshots: [shadowSnapshot, formalSnapshot],
  evaluatedAt: "2026-07-27T05:10:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});

check("official settlement is append-only and reconciles the formal denominator", () => {
  assert.equal(settlementUpdate.audit.cohort.formal.universe, 1);
  assert.equal(settlementUpdate.audit.cohort.formal.pending, 0);
  assert.equal(settlementUpdate.audit.cohort.formal.settled, 1);
  assert.equal(settlementUpdate.audit.cohort.formal.denominatorReconciled, true);
  assert.equal(settlementUpdate.audit.metrics.formalRows, 1);
  const diagnostics = settlementUpdate.audit.metrics.diagnostics;
  assert.equal(diagnostics.version, "candidate-formal-metric-diagnostic-v1");
  assert.equal(diagnostics.totalRows, 1);
  assert.equal(diagnostics.detailedRows, 1);
  assert.equal(diagnostics.rowsTruncated, 0);
  assert.equal(diagnostics.rows.length, 1);
  assert.equal(diagnostics.rows[0].actual, "1");
  assert.equal(
    Math.abs(
      diagnostics.rows[0].candidateActualProbability
        - diagnostics.rows[0].marketActualProbability
        - diagnostics.rows[0].actualProbabilityImprovement,
    ) < 1e-6,
    true,
  );
  assert.equal(
    Object.values(diagnostics.attributionCounts).reduce((sum, count) => sum + count, 0),
    diagnostics.detailedRows,
  );
  const ledger = settlementUpdate.registry.ledgers
    .find((row) => row.ledgerId === settlementUpdate.registry.activeLedgerId);
  const decision = ledger.events.find((event) => (
    event.type === "decision" && event.phase === "formal"
  ));
  const settlement = ledger.events.find((event) => (
    event.type === "settlement" && event.decisionEventHash === decision.eventHash
  ));
  assert.equal(settlement.settlementRecordVersion, SETTLEMENT_RECORD_VERSION);
  assert.deepEqual(settlementRecordBlockers(settlement, decision), []);
  assert.match(settlement.resultProvenanceHash, /^[a-f0-9]{64}$/);
  assert.equal(
    settlementUpdate.audit.settlementRecord.validationVersion,
    SETTLEMENT_VALIDATION_VERSION,
  );
  assert.deepEqual(
    settlementUpdate.audit.settlementRecord.requiredFields,
    SETTLEMENT_REQUIRED_FIELDS,
  );
  assert.equal(settlementUpdate.audit.settlementRecord.rows, 1);
  assert.equal(settlementUpdate.audit.settlementRecord.completeRows, 1);
  assert.equal(settlementUpdate.audit.settlementRecord.failedRows, 0);
  assert.equal(settlementUpdate.audit.settlementRecord.coverage, 1);
  assert.equal(settlementUpdate.audit.settlementRecord.complete, true);
});

check("recomputed chain cannot change a settled outcome without matching official score", () => {
  const ledger = structuredClone(
    settlementUpdate.registry.ledgers
      .find((row) => row.ledgerId === settlementUpdate.registry.activeLedgerId),
  );
  const settlement = ledger.events.find((event) => (
    event.type === "settlement" && event.phase === "formal"
  ));
  settlement.actual = "X";
  rehashLedger(ledger);
  const verification = verifyLedger(ledger);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.blockers.some((blocker) => (
      blocker.endsWith("settlement-outcome-score-mismatch")
    )),
  );
});

check("promotion cannot happen before 500 valid settled formal rows", () => {
  assert.equal(settlementUpdate.audit.promotionReviewReady, false);
  assert.ok(
    settlementUpdate.audit.blockers
      .includes(`formal-settled:1<${MIN_FORMAL_SETTLED}`),
  );
});

check("500 exclusions cannot satisfy the 500 settled-sample gate or trigger review", () => {
  const registry = structuredClone(activatedUpdate.registry);
  const ledger = registry.ledgers.find((row) => row.ledgerId === registry.activeLedgerId);
  for (let index = 0; index < MIN_FORMAL_SETTLED; index += 1) {
    appendEvent(ledger, {
      type: "exclusion",
      phase: "formal",
      recordedAt: new Date(Date.parse("2026-07-27T01:10:00.000Z") + index).toISOString(),
      matchId: `excluded-${index + 1}`,
      sourceMatchId: `excluded-${index + 1}`,
      kickoffTime: new Date(Date.parse("2026-07-28T00:00:00.000Z") + index).toISOString(),
      reasonCodes: ["eligible-deadline-snapshot-missing"],
      onlineEffect: false,
    });
  }
  const before = auditLedger(ledger, {
    totalCandidatesEverTested: registry.candidateRegistry.length,
    evaluatedAt: "2026-07-28T01:00:00.000Z",
  });
  assert.equal(before.cohort.formal.finalized, MIN_FORMAL_SETTLED);
  assert.equal(before.cohort.formal.settled, 0);
  assert.ok(before.blockers.includes(`formal-settled:0<${MIN_FORMAL_SETTLED}`));

  const updated = updateCandidateProspectiveLedger({
    priorRegistry: registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-28T01:01:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(
    updated.registry.ledgers
      .find((row) => row.ledgerId === updated.registry.activeLedgerId)
      .events.some((event) => event.type === "review"),
    false,
  );
});

check("a recomputed hash chain cannot duplicate one formal decision", () => {
  const ledger = structuredClone(
    formalCapture.registry.ledgers
      .find((row) => row.ledgerId === formalCapture.registry.activeLedgerId),
  );
  const original = ledger.events.find((event) => (
    event.type === "decision" && event.phase === "formal"
  ));
  const {
    sequence: ignoredSequence,
    previousHash: ignoredPreviousHash,
    eventHash: ignoredEventHash,
    ...payload
  } = original;
  void ignoredSequence;
  void ignoredPreviousHash;
  void ignoredEventHash;
  appendEvent(ledger, payload);
  const verification = verifyLedger(ledger);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.blockers.some((blocker) => blocker.endsWith("duplicate-cohort-key")),
  );
});

check("a later source alias cannot bypass terminal-event uniqueness", () => {
  const ledger = structuredClone(
    formalCapture.registry.ledgers
      .find((row) => row.ledgerId === formalCapture.registry.activeLedgerId),
  );
  const original = ledger.events.find((event) => (
    event.type === "decision" && event.phase === "formal"
  ));
  original.sourceMatchId = "";
  rehashLedger(ledger);
  const {
    sequence: ignoredSequence,
    previousHash: ignoredPreviousHash,
    eventHash: ignoredEventHash,
    ...payload
  } = original;
  void ignoredSequence;
  void ignoredPreviousHash;
  void ignoredEventHash;
  appendEvent(ledger, { ...payload, sourceMatchId: formalMatch.sourceMatchId });
  const verification = verifyLedger(ledger);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.blockers.some((blocker) => blocker.endsWith("duplicate-cohort-key")),
  );
  assert.equal(
    sameCohortIdentity(
      { id: "same-clock-a", kickoffAt: formalMatch.kickoffTime, market: "HAD" },
      { id: "same-clock-b", kickoffAt: formalMatch.kickoffTime, market: "HAD" },
    ),
    false,
    "two different fixtures at the same kickoff remain distinct",
  );
});

check("a review checkpoint cannot claim 500 rows without 500 settled pairs", () => {
  const ledger = structuredClone(
    activatedUpdate.registry.ledgers
      .find((row) => row.ledgerId === activatedUpdate.registry.activeLedgerId),
  );
  appendEvent(ledger, {
    type: "review",
    recordedAt: "2026-07-28T01:10:00.000Z",
    checkpointSettled: MIN_FORMAL_SETTLED,
    observedSettled: MIN_FORMAL_SETTLED,
    checkpointFinalized: MIN_FORMAL_SETTLED,
    observedFinalized: MIN_FORMAL_SETTLED,
    datasetHashVersion: "candidate-formal-settled-pairs-v1",
    datasetRows: MIN_FORMAL_SETTLED,
    datasetHash: sha256([]),
    passed: true,
    blockers: [],
    onlineEffect: false,
  });
  const verification = verifyLedger(ledger);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.blockers.some((blocker) => (
      blocker.endsWith("review-dataset-row-count-invalid")
    )),
  );
});

check("a 499-to-605 settlement jump evaluates immutable 500 and 600 prefixes", () => {
  const registry = structuredClone(activatedUpdate.registry);
  const ledger = registry.ledgers.find(
    (row) => row.ledgerId === registry.activeLedgerId,
  );
  const activation = ledger.events.find((event) => event.type === "activation");
  const finishedMatches = [];
  for (let index = 0; index < 605; index += 1) {
    const windowIndex = index < 500 ? Math.floor(index / 100) : 5;
    const indexInWindow = index < 500 ? index % 100 : index - 500;
    const window = activation.windowBoundaries[windowIndex];
    const kickoffTime = new Date(
      Date.parse(window.startAt)
      + 24 * 60 * 60_000
      + indexInWindow * 60_000,
    ).toISOString();
    const sourceMatchId = `checkpoint-prefix-${String(index + 1).padStart(3, "0")}`;
    const scheduledMatch = match({ sourceMatchId, kickoffTime });
    const capturedAt = new Date(Date.parse(kickoffTime) - 20 * 60_000).toISOString();
    const snapshot = strictSnapshot({ sourceMatchId, kickoffTime, capturedAt });
    const decision = buildDecisionEvent({
      ledger,
      match: scheduledMatch,
      snapshot,
      evaluatedAt: new Date(Date.parse(kickoffTime) - 5 * 60_000).toISOString(),
      phase: "formal",
      trustedCollectorCount: 2,
    });
    assert.equal(decision.type, "decision");
    appendEvent(ledger, decision);
    finishedMatches.push(match({
      sourceMatchId,
      kickoffTime,
      status: "FINISHED",
      scoreHome: 0,
      scoreAway: 1,
    }));
  }
  assert.equal(verifyRegistry(registry).valid, true);

  const first499 = settleCandidateProspectiveRegistry({
    priorRegistry: registry,
    matches: finishedMatches.slice(0, 499),
    evaluatedAt: new Date(
      Date.parse(finishedMatches[498].kickoffTime) + 3 * 60 * 60_000,
    ).toISOString(),
  });
  assert.equal(first499.chainValid, true);
  assert.equal(first499.audit.cohort.formal.settled, 499);
  assert.equal(
    first499.registry.ledgers
      .find((row) => row.ledgerId === first499.registry.activeLedgerId)
      .events.some((event) => event.type === "review"),
    false,
  );

  const jumped = settleCandidateProspectiveRegistry({
    priorRegistry: first499.registry,
    matches: finishedMatches,
    evaluatedAt: new Date(
      Date.parse(finishedMatches.at(-1).kickoffTime) + 3 * 60 * 60_000,
    ).toISOString(),
  });
  assert.equal(jumped.chainValid, true);
  assert.equal(jumped.settlementsAdded, 106);
  assert.equal(jumped.audit.cohort.formal.settled, 605);
  assert.equal(jumped.audit.promotionReviewReady, true);
  const jumpedLedger = jumped.registry.ledgers.find(
    (row) => row.ledgerId === jumped.registry.activeLedgerId,
  );
  const reviews = jumpedLedger.events
    .filter((event) => event.type === "review")
    .sort((left, right) => left.checkpointSettled - right.checkpointSettled);
  assert.deepEqual(reviews.map((event) => event.checkpointSettled), [500, 600]);
  assert.deepEqual(reviews.map((event) => event.observedSettled), [500, 600]);
  assert.deepEqual(reviews.map((event) => event.observedCurrentSettled), [605, 605]);
  assert.equal(reviews[0].passed, false);
  assert.ok(
    reviews[0].blockers.includes("independent-calendar-windows:5<6"),
  );
  assert.equal(reviews[0].checkpointAudit.metrics.formalRows, 500);
  assert.equal(reviews[0].checkpointAudit.metrics.windowEvaluation.eligibleWindows, 5);
  assert.equal(reviews[1].passed, true);
  assert.deepEqual(reviews[1].blockers, []);
  assert.equal(reviews[1].checkpointAudit.metrics.formalRows, 600);
  assert.equal(reviews[1].checkpointAudit.metrics.windowEvaluation.eligibleWindows, 6);
  for (const review of reviews) {
    assert.equal(review.checkpointAuditVersion, REVIEW_CHECKPOINT_AUDIT_VERSION);
    assert.equal(
      review.checkpointSourceBoundaryVersion,
      REVIEW_CHECKPOINT_SOURCE_BOUNDARY_VERSION,
    );
    const evidence = buildReviewCheckpointEvidence(
      jumpedLedger,
      review.checkpointSettled,
      { totalCandidatesEverTested: review.totalCandidatesEverTested },
    );
    assert.equal(evidence.complete, true);
    assert.equal(review.datasetRows, review.checkpointSettled);
    assert.equal(review.datasetHash, sha256(evidence.dataset));
    assert.equal(review.checkpointAuditHash, evidence.auditHash);
    assert.equal(review.checkpointSourceBoundaryHash, evidence.sourceBoundaryHash);
    assert.deepEqual(review.checkpointAudit, evidence.audit);
    assert.deepEqual(review.checkpointSourceBoundary, evidence.sourceBoundary);
  }

  const eventCount = jumpedLedger.events.length;
  const rootHash = jumpedLedger.rootHash;
  const repeated = settleCandidateProspectiveRegistry({
    priorRegistry: jumped.registry,
    matches: finishedMatches,
    evaluatedAt: new Date(
      Date.parse(finishedMatches.at(-1).kickoffTime) + 4 * 60 * 60_000,
    ).toISOString(),
  });
  const repeatedLedger = repeated.registry.ledgers.find(
    (row) => row.ledgerId === repeated.registry.activeLedgerId,
  );
  assert.equal(repeated.changed, false);
  assert.equal(repeated.eventsAdded, 0);
  assert.equal(repeated.settlementsAdded, 0);
  assert.equal(repeatedLedger.events.length, eventCount);
  assert.equal(repeatedLedger.rootHash, rootHash);

  const reordered = structuredClone(jumpedLedger);
  const settlementIndexes = reordered.events
    .map((event, index) => (event.type === "settlement" ? index : -1))
    .filter((index) => index >= 0);
  const leftIndex = settlementIndexes[499];
  const rightIndex = settlementIndexes[500];
  [reordered.events[leftIndex], reordered.events[rightIndex]] = [
    reordered.events[rightIndex],
    reordered.events[leftIndex],
  ];
  rehashLedger(reordered);
  const reorderedVerification = verifyLedger(reordered);
  assert.equal(reorderedVerification.valid, false);
  assert.ok(reorderedVerification.blockers.some((blocker) => (
    blocker.endsWith("review-dataset-hash-invalid")
    || blocker.endsWith("review-source-boundary-invalid")
  )));

  const duplicated = structuredClone(jumpedLedger);
  const duplicateSettlement = duplicated.events.find(
    (event) => event.type === "settlement",
  );
  const {
    sequence: ignoredSequence,
    previousHash: ignoredPreviousHash,
    eventHash: ignoredEventHash,
    ...duplicatePayload
  } = duplicateSettlement;
  void ignoredSequence;
  void ignoredPreviousHash;
  void ignoredEventHash;
  appendEvent(duplicated, duplicatePayload);
  const duplicateVerification = verifyLedger(duplicated);
  assert.equal(duplicateVerification.valid, false);
  assert.ok(duplicateVerification.blockers.some((blocker) => (
    blocker.endsWith("duplicate-settlement")
  )));
});

check("retrospective ranking changes cannot replace an active prospective candidate", () => {
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: settlementUpdate.registry,
    candidates,
    selectedCandidate: baseline,
    robustness: robustness(false),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T05:20:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.registry.ledgers.length, 1);
  assert.equal(updated.registry.activeLedgerId, settlementUpdate.registry.activeLedgerId);
  assert.equal(updated.audit.state, "ACTIVE");
  assert.equal(updated.audit.candidateRevisionId, settlementUpdate.audit.candidateRevisionId);
  assert.equal(
    updated.registry.ledgers[0].events.some((event) => event.type === "retirement"),
    false,
  );
});

check("a nomination-policy change cannot reset an active trial after cohort evidence", () => {
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: formalCapture.registry,
    candidates,
    selectedCandidate: baseline,
    robustness: robustness(false),
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T05:21:00.000Z",
    implementationCommitment,
    nominationPolicyCommitment: nominationSelectionPolicyCommitment(),
    trustedCollectorCount: 2,
  });
  assert.equal(updated.registry.ledgers.length, 1);
  assert.equal(updated.registry.activeLedgerId, formalCapture.registry.activeLedgerId);
  assert.equal(updated.audit.candidateRevisionId, formalCapture.audit.candidateRevisionId);
  assert.ok(postActivationEvidenceEvents(updated.registry.ledgers[0]).length > 0);
  assert.equal(
    updated.registry.ledgers[0].events.some((event) => event.type === "retirement"),
    false,
  );
});

check("gate-spec drift cannot silently reset an active trial after evidence", () => {
  const replacementGateSpec = {
    ...fixedGateSpec(),
    reviewInterval: fixedGateSpec().reviewInterval + 1,
  };
  const blocked = candidateGateSpecCompatibility({
    priorRegistry: formalCapture.registry,
    expectedGateSpec: replacementGateSpec,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.resetRequired, true);
  assert.equal(blocked.resetAuthorized, false);
  assert.ok(blocked.postActivationEvidenceCount > 0);
  assert.deepEqual(blocked.blockers, [
    "active-gate-spec-reset-requires-explicit-authorization",
  ]);

  const authorized = candidateGateSpecCompatibility({
    priorRegistry: formalCapture.registry,
    expectedGateSpec: replacementGateSpec,
    resetAuthorization: blocked.expectedResetAuthorization,
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.resetRequired, true);
  assert.equal(authorized.resetAuthorized, true);
});

check("zero-evidence gate-spec drift remains safe to refreeze", () => {
  const compatibility = candidateGateSpecCompatibility({
    priorRegistry: activatedUpdate.registry,
    expectedGateSpec: {
      ...fixedGateSpec(),
      reviewInterval: fixedGateSpec().reviewInterval + 1,
    },
  });
  assert.equal(compatibility.ok, true);
  assert.equal(compatibility.resetRequired, true);
  assert.equal(compatibility.resetAuthorized, false);
  assert.equal(compatibility.postActivationEvidenceCount, 0);
});

check("missing provenance is an exclusion that remains in the denominator", () => {
  const badMatch = match({
    sourceMatchId: "formal-bad",
    kickoffTime: "2026-07-27T06:00:00.000Z",
  });
  const badSnapshot = strictSnapshot({
    sourceMatchId: "formal-bad",
    kickoffTime: badMatch.kickoffTime,
    capturedAt: "2026-07-27T05:40:00.000Z",
    clockEligible: false,
    withAttestation: false,
  });
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: settlementUpdate.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [badMatch],
    snapshots: [badSnapshot],
    evaluatedAt: "2026-07-27T05:55:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 1,
  });
  assert.equal(updated.audit.cohort.formal.universe, 2);
  assert.equal(updated.audit.cohort.formal.excluded, 1);
  assert.equal(updated.audit.cohort.formal.invalid, 1);
});

check("late evaluation records a missed capture instead of backfilling", () => {
  const lateMatch = match({
    sourceMatchId: "late-1",
    kickoffTime: "2026-07-27T07:00:00.000Z",
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 1,
  });
  const lateSnapshot = strictSnapshot({
    sourceMatchId: "late-1",
    kickoffTime: lateMatch.kickoffTime,
    capturedAt: "2026-07-27T06:40:00.000Z",
  });
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: settlementUpdate.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: robustness(true),
    matches: [lateMatch],
    snapshots: [lateSnapshot],
    evaluatedAt: "2026-07-27T07:05:00.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  const ledger = updated.registry.ledgers[0];
  const exclusion = ledger.events.find((event) => (
    event.type === "exclusion" && event.sourceMatchId === "late-1"
  ));
  assert.ok(exclusion);
  assert.deepEqual(exclusion.blockers, ["pre-match-ledger-capture-missed"]);
  assert.equal(exclusion.marketState, "capture-missed-before-kickoff");
  assert.equal(exclusion.primaryExclusionReason, "pre-match-ledger-capture-missed");
});

check("tampering with an event invalidates both ledger and registry", () => {
  const tampered = JSON.parse(JSON.stringify(settlementUpdate.registry));
  tampered.ledgers[0].events[1].state = "ACTIVE";
  assert.equal(verifyLedger(tampered.ledgers[0]).valid, false);
  assert.equal(verifyRegistry(tampered).valid, false);
});

check("candidate implementation change retires old ledger and starts a new revision", () => {
  const changedImplementation = {
    ...implementationCommitment,
    sourceHashes: {
      ...implementationCommitment.sourceHashes,
      "scripts/candidateProspectiveLedger.cjs": "8".repeat(64),
    },
  };
  const changedInventory = candidateInventory(candidates, changedImplementation);
  const updated = updateCandidateProspectiveLedger({
    priorRegistry: settlementUpdate.registry,
    candidates,
    selectedCandidate: candidate,
    robustness: {
      ...robustness(false),
      family: { inventoryHash: changedInventory.hash },
    },
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T06:00:00.000Z",
    implementationCommitment: changedImplementation,
    trustedCollectorCount: 2,
  });
  assert.equal(updated.registry.ledgers.length, 2);
  assert.ok(updated.registry.ledgers[0].events.some((event) => event.type === "retirement"));
  assert.notEqual(
    updated.registry.ledgers[0].header.candidateRevisionId,
    updated.registry.ledgers[1].header.candidateRevisionId,
  );
  assert.equal(updated.audit.state, "SHADOW");
});

check("gate spec fixes review, backfill and missing-field policies", () => {
  const gate = fixedGateSpec();
  assert.equal(gate.minimumFormalSettled, 500);
  assert.equal(gate.minimumFormalFinalized, 500);
  assert.equal(gate.minimumIndependentCalendarWindows, 6);
  assert.equal(gate.minimumWinningCalendarWindows, 5);
  assert.equal(gate.minimumFormalRowsPerCalendarWindow, 50);
  assert.equal(gate.settlementRecordVersion, SETTLEMENT_RECORD_VERSION);
  assert.equal(gate.windowCount, 6);
  assert.equal(gate.backfillPolicy, "forbidden");
  assert.equal(gate.missingFieldPolicy, "count-in-denominator-as-invalid");
  assert.equal(gate.admissionSourceClass, "official");
  assert.equal(gate.decisionDeadlinePolicyVersion, DECISION_DEADLINE_POLICY_VERSION);
  assert.equal(gate.captureFinalizationPolicyVersion, "deadline-evidence-grace-v1");
  assert.equal(gate.captureFinalizationGraceSeconds, 120);
  assert.match(gate.activeCandidateSelectionPolicy, /once activated/i);
});

const syntheticWindowRows = (winningWindows = 5, singleMetricOnlyWindow = null) => {
  const start = Date.parse("2026-07-27T00:00:00.000Z");
  return Array.from({ length: WINDOW_COUNT }, (_, index) => {
    const winsBoth = index < winningWindows;
    const singleMetricOnly = index === singleMetricOnlyWindow;
    const logLossImprovement = winsBoth || singleMetricOnly ? 0.04 : -0.04;
    const brierImprovement = winsBoth ? 0.03 : -0.03;
    return Array.from({ length: MIN_FORMAL_ROWS_PER_WINDOW }, (_, rowIndex) => ({
      decisionEventHash: String(
        index * MIN_FORMAL_ROWS_PER_WINDOW + rowIndex + 1,
      ).padStart(64, "0"),
      matchId: `window-${index + 1}-${rowIndex + 1}`,
      kickoffTime: new Date(
        start + index * 30 * 86_400_000 + (rowIndex + 1) * 60_000,
      ).toISOString(),
      candidateLogLoss: 0.61 - logLossImprovement,
      marketLogLoss: 0.61,
      candidateBrier: 0.42 - brierImprovement,
      marketBrier: 0.42,
      logLossImprovement,
      brierImprovement,
    }));
  }).flat();
};

const fixedWindows = Array.from({ length: WINDOW_COUNT }, (_, index) => {
  const start = Date.parse("2026-07-27T00:00:00.000Z");
  return {
    index: index + 1,
    startAt: new Date(start + index * 30 * 86_400_000).toISOString(),
    endAt: new Date(start + (index + 1) * 30 * 86_400_000).toISOString(),
  };
});

check("five of six non-overlapping windows winning both metrics passes", () => {
  const evaluation = assessWindowPerformance(syntheticWindowRows(5), fixedWindows);
  assert.equal(evaluation.registeredWindows, 6);
  assert.equal(evaluation.eligibleWindows, 6);
  assert.equal(evaluation.winningWindows, MIN_WINNING_WINDOWS);
  assert.equal(evaluation.boundariesNonOverlapping, true);
  assert.equal(evaluation.reusedRows, 0);
  assert.equal(evaluation.unassignedRows, 0);
  assert.equal(evaluation.passes, true);
});

check("one row in each window cannot satisfy the independent-window gate", () => {
  const sparseRows = syntheticWindowRows(6)
    .filter((_, index) => index % MIN_FORMAL_ROWS_PER_WINDOW === 0);
  const evaluation = assessWindowPerformance(sparseRows, fixedWindows);
  assert.equal(evaluation.registeredWindows, 6);
  assert.equal(evaluation.eligibleWindows, 0);
  assert.equal(evaluation.minimumRowsPerWindow, MIN_FORMAL_ROWS_PER_WINDOW);
  assert.equal(evaluation.passes, false);
});

check("four of six dual-metric wins cannot pass", () => {
  const evaluation = assessWindowPerformance(syntheticWindowRows(4), fixedWindows);
  assert.equal(evaluation.winningWindows, 4);
  assert.equal(evaluation.passes, false);
});

check("a Brier-only or Log-Loss-only improvement is not a winning window", () => {
  const evaluation = assessWindowPerformance(
    syntheticWindowRows(4, 4),
    fixedWindows,
  );
  assert.equal(evaluation.windows[4].logLossImprovement > 0, true);
  assert.equal(evaluation.windows[4].brierImprovement > 0, false);
  assert.equal(evaluation.windows[4].improvesBoth, false);
  assert.equal(evaluation.winningWindows, 4);
  assert.equal(evaluation.passes, false);
});

check("overlapping window boundaries are rejected and reveal row reuse", () => {
  const overlapping = JSON.parse(JSON.stringify(fixedWindows));
  overlapping[1].startAt = overlapping[0].startAt;
  const evaluation = assessWindowPerformance(syntheticWindowRows(5), overlapping);
  assert.equal(evaluation.boundariesNonOverlapping, false);
  assert.ok(evaluation.reusedRows > 0);
  assert.equal(evaluation.passes, false);
});

check("fixed trial lineage survives implementation changes and repeated backtests", () => {
  const result = require("./verifyCandidateRevisionLineage.cjs").verifyCandidateRevisionLineage();
  assert.equal(result.ok, true);
  assert.ok(result.checks >= 7);
});

const ok = checks.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  verifier: "candidate-prospective-ledger",
  assertions: checks.length,
  checks,
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);
