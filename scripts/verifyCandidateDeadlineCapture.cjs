"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  ATOMIC_DECISION_VALIDATION_VERSION,
  SETTLEMENT_RECORD_VERSION,
  SETTLEMENT_VALIDATION_VERSION,
  atomicDecisionRecordValid,
  registryLockFileFor,
  sha256,
  updateCandidateProspectiveLedger,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");
const {
  readTopLevelArrayProperty,
  mergeMatchUniverseSources,
  publicHistoryRowsForMatchUniverse,
  sqliteSnapshotsForMatches,
  sqliteProjectedMatchUniverse,
  deferredResearchStatus,
  deadlineOnlyResearchStatus,
  researchHeartbeatReuseDecision,
  researchSettlementInputFingerprint,
  settlementHistoryIdentityValues,
  summarizeDeadlineBatches,
} = require("./captureCandidateProspectiveDeadline.cjs");
const {
  exactHeartbeatMatches,
} = require("./runReleaseCandidateHeartbeatKeeper.cjs");
const {
  AUDIT_VERSION: CHALLENGER_AUDIT_VERSION,
  compactCalibrationChallengerSuitePublic,
} = require("./candidateProspectiveChallengerSuite.cjs");

const reusableResearchStatus = (version) => ({
  version,
  evaluatedAt: "2026-07-27T00:00:00.000Z",
  available: true,
  ok: true,
  skipped: false,
  changed: false,
  onlineEffect: false,
  chainValid: true,
  blockers: [],
});

const fingerprintScheduled = researchSettlementInputFingerprint([{
  id: "sporttery_reuse-1",
  sourceMatchId: "reuse-1",
  kickoffTime: "2026-07-28T01:00:00.000Z",
  status: "SCHEDULED",
  had: { h: 1.8, d: 3.5, a: 4.2 },
}]);
const fingerprintOddsMoved = researchSettlementInputFingerprint([{
  id: "sporttery_reuse-1",
  sourceMatchId: "reuse-1",
  kickoffTime: "2026-07-28T01:00:00.000Z",
  status: "SCHEDULED",
  had: { h: 1.7, d: 3.6, a: 4.4 },
}]);
assert.equal(fingerprintScheduled, fingerprintOddsMoved);
const fingerprintFinal = researchSettlementInputFingerprint([{
  id: "sporttery_reuse-1",
  sourceMatchId: "reuse-1",
  kickoffTime: "2026-07-28T01:00:00.000Z",
  eventVersion: "2026-07-28T01:00:00.000Z",
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 1,
  official: true,
  resultSource: "sporttery:official-api",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/result/getMatchResultV1.qry",
  resultObservedAt: "2026-07-28T03:00:00.000Z",
  resultObservationSource: "sporttery-official-api",
}]);
assert.notEqual(fingerprintScheduled, fingerprintFinal);

const reusablePriorStatus = {
  researchSettlementInputFingerprint: fingerprintScheduled,
  challengerSuite: reusableResearchStatus(
    "candidate-prospective-challenger-suite-audit-v1",
  ),
  temperatureNeutralizationSuite: reusableResearchStatus(
    "candidate-prospective-temperature-neutralization-suite-audit-v1",
  ),
  commonCohortG2: reusableResearchStatus(
    "candidate-common-cohort-shadow-g2-audit-v2",
  ),
};
assert.deepEqual(
  researchHeartbeatReuseDecision({
    priorStatus: reusablePriorStatus,
    settlementInputFingerprint: fingerprintScheduled,
  }),
  {
    settlementInputUnchanged: true,
    suitesHealthy: true,
    reuseSettlement: true,
    reuseCapture: true,
  },
);
assert.equal(researchHeartbeatReuseDecision({
  priorStatus: reusablePriorStatus,
  settlementInputFingerprint: fingerprintScheduled,
  challengerDueMatches: 1,
}).reuseCapture, false);
assert.equal(researchHeartbeatReuseDecision({
  priorStatus: reusablePriorStatus,
  settlementInputFingerprint: fingerprintFinal,
}).reuseSettlement, false);

const deferredResearch = deferredResearchStatus(
  reusablePriorStatus.challengerSuite,
  { dueMatches: 6 },
);
assert.equal(deferredResearch.ok, true);
assert.equal(deferredResearch.skipped, true);
assert.equal(deferredResearch.dueMatches, 6);
assert.equal(deferredResearch.deferredForPrimaryDeadlineCapture, true);
assert.equal(
  deferredResearch.reason,
  "deferred-for-primary-deadline-capture",
);

const rootDir = path.resolve(__dirname, "..");
const captureScript = path.join(__dirname, "captureCandidateProspectiveDeadline.cjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-deadline-capture-"));
const registryFile = path.join(tempDir, "candidate-registry.json");
const statusFile = path.join(tempDir, "capture-status.json");
const benchmarkLedgerFile = path.join(tempDir, "benchmark-ledger.json");
const benchmarkStatusFile = path.join(tempDir, "benchmark-status.json");
const challengerSuiteFile = path.join(tempDir, "challenger-suite.json");
const temperatureSuiteFile = path.join(tempDir, "temperature-suite.json");
const commonCohortSuiteFile = path.join(tempDir, "common-cohort-suite.json");
const currentFile = path.join(tempDir, "matches-current.json");
const historyFile = path.join(tempDir, "matches-history.json");
const snapshotsFile = path.join(tempDir, "prediction-snapshots.json");
const sqliteFile = path.join(tempDir, "football.db");

const sha256File = (filePath) => crypto
  .createHash("sha256")
  .update(fs.readFileSync(filePath))
  .digest("hex");

const writeJson = (filePath, payload) => {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const implementationCommitment = {
  sourceHashes: {
    "scripts/runModelBacktest.cjs": sha256File(path.join(__dirname, "runModelBacktest.cjs")),
    "scripts/candidateProspectiveLedger.cjs": sha256File(
      path.join(__dirname, "candidateProspectiveLedger.cjs"),
    ),
    "scripts/shadowCandidateRobustness.cjs": sha256File(
      path.join(__dirname, "shadowCandidateRobustness.cjs"),
    ),
    "scripts/captureCandidateProspectiveDeadline.cjs": sha256File(captureScript),
  },
  dependencyLockHash: sha256File(path.join(rootDir, "package-lock.json")),
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
  featureSet: ["sporttery-market"],
  weights: { market: 1, model: 0 },
};

const kickoffTime = "2026-07-27T01:00:00.000Z";
const scheduledMatch = {
  id: "sporttery_deadline-1",
  sourceMatchId: "deadline-1",
  kickoffTime,
  buyEndTime: "2026-07-27T00:45:00.000Z",
  status: "SCHEDULED",
  homeTeamName: "Home",
  awayTeamName: "Away",
};
const snapshot = {
  sourceMatchId: "deadline-1",
  matchId: "sporttery_deadline-1",
  kickoffTime,
  capturedAt: "2026-07-27T00:40:00.000Z",
  firstSeenAt: "2026-07-27T00:40:00.000Z",
  phase: "final",
  status: "SCHEDULED",
  sourceCycleId: "cycle-deadline-1",
  modelGeneratedAt: "2026-07-27T00:40:00.000Z",
  policyVersion: "prediction-policy-deadline-v1",
  promptVersion: "prediction-prompt-deadline-v1",
  modelVersion: "prediction-model-deadline-v1",
  calibrationVersion: "prediction-calibration-deadline-v1",
  featureSnapshot: {
    version: "prediction-feature-snapshot-deadline-v1",
    capturedAt: "2026-07-27T00:40:00.000Z",
    modelGeneratedAt: "2026-07-27T00:40:00.000Z",
    sourceCycleId: "cycle-deadline-1",
    modelVersion: "prediction-model-deadline-v1",
    calibrationVersion: "prediction-calibration-deadline-v1",
    modelInputs: {
      market: { home: 0.510729613734, draw: 0.270386266094, away: 0.218884120172 },
      form: { home: 1.6, away: 1.1 },
    },
  },
  decisionSnapshotVersion: "candidate-decision-snapshot-v2",
  featureSnapshotHash: "feature-deadline-1",
  best: {
    tipCode: "1",
    oddsPoolCode: "HAD",
    odds: 1.8,
    trustScore: 70,
    recommendationAction: "reference",
  },
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    sourceMatchId: "deadline-1",
    matchId: "sporttery_deadline-1",
    kickoffTime,
    capturedAt: "2026-07-27T00:40:00.000Z",
    decisionAt: "2026-07-27T00:40:00.000Z",
    sourceCycleId: "cycle-deadline-1",
    policyVersion: "prediction-policy-deadline-v1",
    promptVersion: "prediction-prompt-deadline-v1",
    modelVersion: "prediction-model-deadline-v1",
    calibrationVersion: "prediction-calibration-deadline-v1",
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-27T00:40:00.000Z",
    },
    featureSnapshotHash: "feature-deadline-1",
    policyHash: "policy-deadline-1",
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      trustedCollectorCount: 2,
    },
    markets: {
      HAD: {
        odds: { "1": 1.8, X: 3.4, "2": 4.2 },
        marketProbabilities: {
          "1": 0.510729613734,
          X: 0.270386266094,
          "2": 0.218884120172,
        },
        observedAt: "2026-07-27T00:40:00.000Z",
        receivedAt: "2026-07-27T00:40:00.000Z",
        provenanceHash: "4".repeat(64),
        provenance: {
          provider: {
            id: "sporttery",
            official: true,
          },
          market: {
            poolCode: "HAD",
            sourceMatchId: "deadline-1",
          },
          timing: {
            providerObservedAt: "2026-07-27T00:40:00.000Z",
            receivedAt: "2026-07-27T00:40:00.000Z",
          },
          hash: "4".repeat(64),
          strict: {
            eligible: true,
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "6".repeat(64) },
        },
      },
      HHAD: {
        line: -1,
        odds: { "1": 2.45, X: 3.5, "2": 2.35 },
        marketProbabilities: {
          "1": 0.364623739333,
          X: 0.255236617533,
          "2": 0.380139643134,
        },
        observedAt: "2026-07-27T00:40:00.000Z",
        receivedAt: "2026-07-27T00:40:00.000Z",
        provenanceHash: "7".repeat(64),
        provenance: {
          provider: {
            id: "sporttery",
            official: true,
          },
          market: {
            poolCode: "HHAD",
            sourceMatchId: "deadline-1",
            handicapLine: -1,
          },
          timing: {
            providerObservedAt: "2026-07-27T00:40:00.000Z",
            receivedAt: "2026-07-27T00:40:00.000Z",
          },
          hash: "7".repeat(64),
          strict: {
            eligible: true,
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "8".repeat(64) },
        },
      },
    },
    probabilities: {
      HAD: { "1": 0.62, X: 0.24, "2": 0.14 },
      HHAD: {
        line: -1,
        outcomes: { "1": 0.39, X: 0.31, "2": 0.3 },
      },
    },
    candidates: [{
      key: "HAD:1:0",
      market: "HAD",
      code: "1",
      odds: 1.8,
      evidenceScore: 70,
    }],
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
};
const publicObservationAt = "2026-07-27T00:43:00.000Z";
const publicObservation = JSON.parse(JSON.stringify(snapshot));
publicObservation.capturedAt = publicObservationAt;
publicObservation.firstSeenAt = publicObservationAt;
publicObservation.lastSeenAt = publicObservationAt;
publicObservation.sourceCycleId = "cycle-deadline-public-observation";
publicObservation.modelGeneratedAt = publicObservationAt;
publicObservation.featureSnapshot.capturedAt = publicObservationAt;
publicObservation.featureSnapshot.modelGeneratedAt = publicObservationAt;
publicObservation.featureSnapshot.sourceCycleId = "cycle-deadline-public-observation";
publicObservation.decisionSnapshot.capturedAt = publicObservationAt;
publicObservation.decisionSnapshot.decisionAt = publicObservationAt;
publicObservation.decisionSnapshot.sourceCycleId = "cycle-deadline-public-observation";
publicObservation.decisionSnapshot.sourceTimestamps.modelGeneratedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HAD.observedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HAD.receivedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HAD.provenance.timing.providerObservedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HAD.provenance.timing.receivedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HHAD.observedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HHAD.receivedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HHAD.provenance.timing.providerObservedAt = publicObservationAt;
publicObservation.decisionSnapshot.markets.HHAD.provenance.timing.receivedAt = publicObservationAt;
const semanticCurrentState = JSON.parse(JSON.stringify(publicObservation));
semanticCurrentState.firstSeenAt = "2026-07-26T23:59:00.000Z";

const initial = updateCandidateProspectiveLedger({
  candidates: [baseline, candidate],
  selectedCandidate: candidate,
  robustness: {
    version: "shadow-candidate-robustness-v1",
    family: { inventoryHash: null },
    selectedCandidate: { id: candidate.id },
    candidateReadyForProspectiveTest: false,
  },
  matches: [],
  snapshots: [],
  evaluatedAt: "2026-07-27T00:00:00.000Z",
  implementationCommitment,
  trustedCollectorCount: 2,
});
assert.equal(initial.chainValid, true);
writeJson(registryFile, initial.registry);
writeJson(currentFile, [scheduledMatch]);
writeJson(historyFile, []);
writeJson(snapshotsFile, {
  version: 3,
  observations: [publicObservation],
  rows: [snapshot, semanticCurrentState],
});

const db = new DatabaseSync(sqliteFile);
db.exec(`
  CREATE TABLE prediction_snapshots (
    id TEXT PRIMARY KEY,
    state_key TEXT UNIQUE,
    match_id TEXT,
    source_match_id TEXT,
    phase TEXT,
    captured_at TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE odds_snapshots (
    id TEXT PRIMARY KEY,
    state_key TEXT UNIQUE,
    match_id TEXT,
    source_match_id TEXT,
    pool TEXT,
    bookmaker TEXT,
    handicap_line REAL,
    captured_at TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL
  )
`);
db.prepare(`
  INSERT INTO prediction_snapshots (
    id, state_key, match_id, source_match_id, phase,
    captured_at, first_seen_at, last_seen_at, seen_count, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "snapshot-1",
  "state-1",
  snapshot.matchId,
  snapshot.sourceMatchId,
  snapshot.phase,
  snapshot.capturedAt,
  snapshot.firstSeenAt,
  snapshot.capturedAt,
  1,
  JSON.stringify(snapshot),
);
const closingOdds = {
  sourceMatchId: "deadline-1",
  matchId: "sporttery_deadline-1",
  kickoffTime,
  poolCode: "HAD",
  capturedAt: "2026-07-27T00:47:00.000Z",
  firstSeenAt: "2026-07-27T00:47:00.000Z",
  oddsObservedAt: "2026-07-27T00:47:00.000Z",
  oddsReceivedAt: "2026-07-27T00:47:01.000Z",
  odds1: 1.75,
  oddsX: 3.5,
  odds2: 4.3,
  marketProvenance: {
    provider: { id: "sporttery", official: true },
    timing: {
      providerObservedAt: "2026-07-27T00:47:00.000Z",
      receivedAt: "2026-07-27T00:47:01.000Z",
    },
    strict: { eligible: true },
  },
};
db.prepare(`
  INSERT INTO odds_snapshots (
    id, state_key, match_id, source_match_id, pool, bookmaker, handicap_line,
    captured_at, first_seen_at, last_seen_at, seen_count, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "odds-1",
  "odds-state-1",
  closingOdds.matchId,
  closingOdds.sourceMatchId,
  closingOdds.poolCode,
  "sporttery",
  0,
  closingOdds.capturedAt,
  closingOdds.firstSeenAt,
  closingOdds.capturedAt,
  1,
  JSON.stringify(closingOdds),
);
db.close();

const runCapture = (at, extraEnv = {}, extraArgs = []) => spawnSync(
  process.execPath,
  [captureScript, ...extraArgs],
  {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      SERVER_STORE_DIR: tempDir,
      DATASTORE_SQLITE_PATH: sqliteFile,
      CANDIDATE_PROSPECTIVE_REGISTRY_FILE: registryFile,
      BENCHMARK_PROSPECTIVE_LEDGER_FILE: benchmarkLedgerFile,
      BENCHMARK_PROSPECTIVE_CAPTURE_STATUS_FILE: benchmarkStatusFile,
      CANDIDATE_PROSPECTIVE_CHALLENGER_SUITE_FILE: challengerSuiteFile,
      CANDIDATE_PROSPECTIVE_TEMPERATURE_NEUTRALIZATION_SUITE_FILE: temperatureSuiteFile,
      CANDIDATE_COMMON_COHORT_SHADOW_G2_V2_FILE: commonCohortSuiteFile,
      CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: statusFile,
      CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE: currentFile,
      CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE: historyFile,
      CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE: snapshotsFile,
      CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: at,
      CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "100",
      TRUSTED_SPORTTERY_COLLECTOR_COUNT: "2",
      ...extraEnv,
    },
  },
);

const checks = [];
let pendingRegistrySnapshot = null;
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
};

check("formal candidate heartbeat runs before the heavier benchmark lane", () => {
  const source = fs.readFileSync(captureScript, "utf8").replace(/\r\n?/g, "\n");
  const mainStart = source.indexOf("const main = () =>");
  const candidateCapture = source.indexOf("const result = capture({ deadlineOnly });", mainStart);
  const benchmarkCapture = source.indexOf(
    "benchmarkCaptureStatus = publishBenchmarkCaptureStatus(captureBenchmark());",
    candidateCapture,
  );
  assert.ok(mainStart >= 0);
  assert.ok(candidateCapture > mainStart);
  assert.ok(benchmarkCapture > candidateCapture);
});

check("deadline-only research preserves unavailable reasons and prior failures", () => {
  const missing = deadlineOnlyResearchStatus(null, CHALLENGER_AUDIT_VERSION);
  assert.equal(missing.available, false);
  assert.equal(missing.chainValid, false);
  assert.deepEqual(missing.blockers, ["deadline-only-research-unavailable"]);
  const repeated = deadlineOnlyResearchStatus(missing, CHALLENGER_AUDIT_VERSION);
  assert.deepEqual(repeated.blockers, missing.blockers);
  assert.notEqual(repeated.blockers, missing.blockers);
  const publicMissing = compactCalibrationChallengerSuitePublic(repeated);
  assert.equal(publicMissing.available, false);
  assert.equal(publicMissing.trialCount, 0);
  assert.equal(publicMissing.rootHash, null);
  assert.equal(publicMissing.blockerCount, 1);
  const failed = { ...missing, ok: false, blockers: ["research-chain-invalid"] };
  const deferredFailure = deadlineOnlyResearchStatus(failed, CHALLENGER_AUDIT_VERSION);
  assert.equal(deferredFailure.ok, false);
  assert.deepEqual(deferredFailure.blockers, ["research-chain-invalid"]);
  assert.deepEqual(failed.blockers, ["research-chain-invalid"]);
  const healthy = reusableResearchStatus(CHALLENGER_AUDIT_VERSION);
  const deferredHealthy = deadlineOnlyResearchStatus(healthy, CHALLENGER_AUDIT_VERSION);
  assert.equal(deferredHealthy.available, true);
  assert.equal(deferredHealthy.chainValid, true);
  assert.deepEqual(deferredHealthy.blockers, []);
  assert.equal(deferredHealthy.onlineEffect, false);
});

check("deadline-only mode commits the formal heartbeat without touching benchmark", () => {
  const result = runCapture(
    "2026-07-27T00:43:30.000Z",
    {},
    ["--deadline-only"],
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.evaluatedAt, "2026-07-27T00:43:30.000Z");
  assert.equal(status.captureMode, "deadline-only");
  assert.equal(status.ok, true);
  assert.equal(status.skipped, false);
  assert.equal(status.dueCaptureComplete, true);
  assert.equal(status.dueAtomicComplete, true);
  const activeRegistryFile = path.join(tempDir, "exact-active-registry.json");
  const activeStatusFile = path.join(tempDir, "exact-active-status.json");
  const priorRegistry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const priorLedger = priorRegistry.ledgers.find(
    (ledger) => ledger.ledgerId === priorRegistry.activeLedgerId,
  );
  const activated = updateCandidateProspectiveLedger({
    priorRegistry,
    candidates: [baseline, candidate],
    selectedCandidate: candidate,
    robustness: {
      version: "shadow-candidate-robustness-v1",
      family: { inventoryHash: priorLedger.header.inventoryHashAtFreeze },
      selectedCandidate: { id: candidate.id },
      candidateReadyForProspectiveTest: true,
    },
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T00:43:31.000Z",
    implementationCommitment,
    trustedCollectorCount: 2,
  });
  assert.equal(activated.chainValid, true);
  writeJson(activeRegistryFile, activated.registry);
  const activeResult = runCapture(
    "2026-07-27T00:43:32.000Z",
    {
      CANDIDATE_PROSPECTIVE_REGISTRY_FILE: activeRegistryFile,
      CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: activeStatusFile,
    },
    ["--deadline-only"],
  );
  assert.equal(activeResult.status, 0, activeResult.stderr || activeResult.stdout);
  const activeStatus = JSON.parse(fs.readFileSync(activeStatusFile, "utf8"));
  const publicResearch = compactCalibrationChallengerSuitePublic(activeStatus.challengerSuite);
  assert.equal(publicResearch.available, false);
  assert.equal(publicResearch.trialCount, 0);
  assert.ok(publicResearch.blockerCount >= 1, "an unavailable research suite must explain why");
  assert.deepEqual(activeStatus.blockers, [], "research deferral must not contaminate formal capture blockers");
  assert.equal(
    exactHeartbeatMatches(activeStatus, activeStatus.evaluatedAt),
    true,
    "the real active deadline-only producer payload must satisfy the release/worker consumer gate",
  );
  assert.equal(fs.existsSync(benchmarkLedgerFile), false);
  assert.equal(fs.existsSync(benchmarkStatusFile), false);
  for (const researchFile of [
    challengerSuiteFile,
    temperatureSuiteFile,
    commonCohortSuiteFile,
  ]) {
    assert.equal(fs.existsSync(researchFile), false);
    assert.equal(
      fs.existsSync(`${researchFile}.lock`),
      false,
      "deadline-only must not enter a research suite lock",
    );
  }
});

check("match-universe preparation stays outside candidate and benchmark ledger locks", () => {
  const source = fs.readFileSync(captureScript, "utf8").replace(/\r\n?/g, "\n");
  for (const [name, startMarker, nextMarker, lockMarker] of [
    [
      "candidate",
      "const capture = ({ deadlineOnly = false } = {}) => {",
      "const main = () =>",
      "return withCandidateProspectiveRegistryLock(\n    registryFile,",
    ],
    [
      "benchmark",
      "const captureBenchmark = () => {",
      "const capture = ({ deadlineOnly = false } = {}) => {",
      "return withCandidateProspectiveRegistryLock(\n    benchmarkLedgerFile,",
    ],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(nextMarker, start + startMarker.length);
    const body = source.slice(start, end);
    const prepare = body.indexOf("const universe = matchUniverse();");
    const lock = body.indexOf(lockMarker);
    assert.ok(start >= 0 && end > start, `${name} function boundaries are available`);
    assert.ok(prepare >= 0, `${name} prepares the match universe`);
    assert.ok(lock > prepare, `${name} prepares the match universe before taking its ledger lock`);
    assert.equal(
      body.indexOf("const universe = matchUniverse();", prepare + 1),
      -1,
      `${name} does not repeat heavyweight preparation inside the lock`,
    );
  }
});

check("sqlite match projection avoids loading heavyweight match payloads", () => {
  const projectionFile = path.join(tempDir, "match-projection.db");
  const projectionDb = new DatabaseSync(projectionFile);
  projectionDb.exec(`
    CREATE TABLE match_snapshots (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL,
      match_id TEXT,
      source_match_id TEXT,
      kickoff_time TEXT,
      status TEXT,
      payload TEXT NOT NULL
    )
  `);
  const insert = projectionDb.prepare(`
    INSERT INTO match_snapshots (
      id, dataset, match_id, source_match_id, kickoff_time, status, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    "current:projection-1",
    "current",
    "sporttery_projection-1",
    "projection-1",
    "2026-07-28T01:00:00.000Z",
    "SCHEDULED",
    JSON.stringify({
      id: "sporttery_projection-1",
      sourceMatchId: "projection-1",
      kickoffTime: "2026-07-28T01:00:00.000Z",
      buyEndTime: "2026-07-28T00:45:00.000Z",
      predictionMeta: {
        cutoffTime: "2026-07-28T00:44:00.000Z",
        sourceCycleId: "cycle-projection",
        heavyweightInternalEvidence: "must-not-be-projected",
      },
      predictions: Array.from({ length: 1_000 }, (_, index) => ({
        index,
        explanation: "heavy-field-must-not-be-projected",
      })),
    }),
  );
  insert.run(
    "history:projection-2",
    "history",
    "sporttery_projection-2",
    "projection-2",
    "2026-07-27T01:00:00.000Z",
    "FINISHED",
    JSON.stringify({
      id: "sporttery_projection-2",
      sourceMatchId: "projection-2",
      kickoffTime: "2026-07-27T01:00:00.000Z",
      scoreHome: 2,
      scoreAway: 1,
      effectiveStatus: "FINISHED",
      resultObservedAt: "2026-07-27T03:00:00.000Z",
      resultMeta: { status: "OFFICIAL" },
      analysis: { large: "x".repeat(50_000) },
    }),
  );
  projectionDb.close();

  const projection = sqliteProjectedMatchUniverse(projectionFile);
  assert.equal(projection.ok, true, projection.reason);
  assert.equal(projection.currentMatches.length, 1);
  assert.equal(projection.historyMatches.length, 1);
  assert.equal(projection.currentMatches[0].buyEndTime, "2026-07-28T00:45:00.000Z");
  assert.deepEqual(projection.currentMatches[0].predictionMeta, {
    cutoffTime: "2026-07-28T00:44:00.000Z",
  });
  assert.equal(Object.hasOwn(projection.currentMatches[0], "predictions"), false);
  assert.equal(projection.historyMatches[0].scoreHome, 2);
  assert.equal(projection.historyMatches[0].scoreAway, 1);
  assert.equal(projection.historyMatches[0].effectiveStatus, "FINISHED");
  assert.deepEqual(projection.historyMatches[0].resultMeta, { status: "OFFICIAL" });
  assert.equal(Object.hasOwn(projection.historyMatches[0], "analysis"), false);
});

check("sqlite match projection bounds history to persisted decision identities", () => {
  const projectionFile = path.join(tempDir, "match-projection-bounded-history.db");
  const projectionDb = new DatabaseSync(projectionFile);
  projectionDb.exec(`
    CREATE TABLE match_snapshots (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL,
      match_id TEXT,
      source_match_id TEXT,
      kickoff_time TEXT,
      status TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_match_snapshots_dataset_kickoff
      ON match_snapshots(dataset, kickoff_time DESC, match_id);
    CREATE INDEX idx_match_snapshots_dataset_source_match_id
      ON match_snapshots(dataset, source_match_id);
  `);
  const insert = projectionDb.prepare(`
    INSERT INTO match_snapshots (
      id, dataset, match_id, source_match_id, kickoff_time, status, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRow = (dataset, id, sourceMatchId, status) => insert.run(
    `${dataset}:${sourceMatchId}`,
    dataset,
    id,
    sourceMatchId,
    "2026-07-28T01:00:00.000Z",
    status,
    JSON.stringify({
      id,
      sourceMatchId,
      kickoffTime: "2026-07-28T01:00:00.000Z",
      scoreHome: status === "FINISHED" ? 2 : null,
      scoreAway: status === "FINISHED" ? 1 : null,
      analysis: { large: "x".repeat(100_000) },
    }),
  );
  insertRow("current", "sporttery_current-1", "current-1", "SCHEDULED");
  insertRow("history", "sporttery_keep-1", "keep-1", "FINISHED");
  insertRow("history", "sporttery_skip-1", "skip-1", "FINISHED");
  projectionDb.close();

  const projection = sqliteProjectedMatchUniverse(projectionFile, {
    historyIdentityValues: ["keep-1"],
  });
  assert.equal(projection.ok, true, projection.reason);
  assert.equal(projection.currentMatches.length, 1, "all current matches stay projected");
  assert.deepEqual(
    projection.historyMatches.map((row) => row.sourceMatchId),
    ["keep-1"],
    "unrelated heavyweight history payloads are not parsed or returned",
  );

  const moreThanFourThousandIdentities = Array.from(
    { length: 4_501 },
    (_, index) => `missing-ledger-identity-${index}`,
  );
  moreThanFourThousandIdentities[4_321] = "keep-1";
  const largeLedgerProjection = sqliteProjectedMatchUniverse(projectionFile, {
    historyIdentityValues: moreThanFourThousandIdentities,
  });
  assert.equal(
    largeLedgerProjection.ok,
    true,
    `4,501 identities must not exceed SQLite host parameters: ${largeLedgerProjection.reason}`,
  );
  assert.deepEqual(
    largeLedgerProjection.historyMatches.map((row) => row.sourceMatchId),
    ["keep-1"],
    "chunking remains an exact filter and does not degrade to all history",
  );
});

check("settlement history identities come only from persisted match evidence", () => {
  const artifacts = new Map([
    ["registry", {
      ledgers: [{
        events: [{
          type: "decision",
          matchId: "sporttery_decision-1",
          sourceMatchId: "decision-1",
          kickoffAt: "2026-07-28T01:00:00.000Z",
        }],
      }],
      candidateRegistry: [{ candidateRevisionId: "must-not-be-an-identity" }],
    }],
    ["benchmark", {
      events: [{
        type: "settlement_hold",
        matchId: "sporttery_hold-1",
        kickoffAt: "2026-07-28T02:00:00.000Z",
      }],
    }],
  ]);
  const identities = settlementHistoryIdentityValues({
    artifactFiles: [...artifacts.keys()],
    readArtifact: (filePath) => artifacts.get(filePath),
  });
  assert.equal(identities.includes("decision-1"), true);
  assert.equal(identities.includes("sporttery_decision-1"), true);
  assert.equal(identities.includes("hold-1"), true);
  assert.equal(identities.includes("sporttery_hold-1"), true);
  assert.equal(identities.includes("must-not-be-an-identity"), false);
});

check("bounded history projection has lower isolated peak RSS and runtime", () => {
  const projectionFile = path.join(tempDir, "match-projection-memory-budget.db");
  const projectionDb = new DatabaseSync(projectionFile);
  projectionDb.exec(`
    CREATE TABLE match_snapshots (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL,
      match_id TEXT,
      source_match_id TEXT,
      kickoff_time TEXT,
      status TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_match_snapshots_dataset_kickoff
      ON match_snapshots(dataset, kickoff_time DESC, match_id);
    CREATE INDEX idx_match_snapshots_dataset_source_match_id
      ON match_snapshots(dataset, source_match_id);
    BEGIN;
  `);
  const insert = projectionDb.prepare(`
    INSERT INTO match_snapshots (
      id, dataset, match_id, source_match_id, kickoff_time, status, payload
    ) VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
  `);
  for (let index = 0; index < 4_000; index += 1) {
    const sourceMatchId = `memory-${index}`;
    insert.run(
      `history:${sourceMatchId}`,
      `sporttery_${sourceMatchId}`,
      sourceMatchId,
      "2026-07-28T01:00:00.000Z",
      JSON.stringify({
        id: `sporttery_${sourceMatchId}`,
        sourceMatchId,
        kickoffTime: "2026-07-28T01:00:00.000Z",
        scoreHome: 2,
        scoreAway: 1,
        resultMeta: { status: "OFFICIAL" },
        analysis: { large: "x".repeat(4_096) },
      }),
    );
  }
  projectionDb.exec("COMMIT;");
  projectionDb.close();

  const measure = (bounded) => {
    const probe = `
      const capture = require(${JSON.stringify(captureScript)});
      if (global.gc) global.gc();
      const startedAt = performance.now();
      const result = capture.sqliteProjectedMatchUniverse(
        ${JSON.stringify(projectionFile)},
        ${bounded ? `{ historyIdentityValues: ["memory-3999"] }` : "undefined"},
      );
      console.log(JSON.stringify({
        ok: result.ok,
        historyRows: result.historyMatches.length,
        durationMs: performance.now() - startedAt,
        maxRssKb: process.resourceUsage().maxRSS,
      }));
    `;
    const child = spawnSync(process.execPath, ["--expose-gc", "-e", probe], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim());
  };
  const full = measure(false);
  const bounded = measure(true);
  assert.equal(full.ok, true);
  assert.equal(bounded.ok, true);
  assert.equal(full.historyRows, 4_000);
  assert.equal(bounded.historyRows, 1);
  assert.ok(
    bounded.durationMs < full.durationMs,
    `bounded ${bounded.durationMs.toFixed(1)}ms must beat full ${full.durationMs.toFixed(1)}ms`,
  );
  assert.ok(
    bounded.maxRssKb < full.maxRssKb,
    `bounded ${bounded.maxRssKb}KiB must stay below full ${full.maxRssKb}KiB`,
  );
});

check("public and SQLite match rows merge without hiding or duplicating one event", () => {
  const sqliteUpcoming = {
    id: "sporttery_merge-1",
    sourceMatchId: "merge-1",
    kickoffTime: "2026-07-28T01:00:00.000Z",
    status: "SCHEDULED",
    buyEndTime: "2026-07-28T00:45:00.000Z",
  };
  const publicScheduled = {
    id: "sporttery_merge-2",
    kickoffTime: "2026-07-27T01:00:00.000Z",
    status: "SCHEDULED",
    homeTeamName: "Home",
  };
  const sqliteFinal = {
    id: "sporttery_merge-2",
    sourceMatchId: "merge-2",
    kickoffTime: "2026-07-27T01:00:00.000Z",
    status: "PENDING_RESULT",
    effectiveStatus: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
  };
  const merged = mergeMatchUniverseSources({
    publicCurrent: [publicScheduled],
    publicHistory: [],
    sqliteCurrent: [sqliteUpcoming],
    sqliteHistory: [sqliteFinal],
  });
  assert.equal(merged.currentMatches.length, 2);
  assert.equal(
    merged.currentMatches.some((row) => row.sourceMatchId === "merge-1"),
    true,
    "an empty or incomplete public current payload cannot suppress SQLite upcoming rows",
  );
  assert.equal(merged.matches.length, 2);
  const final = merged.matches.find((row) => row.sourceMatchId === "merge-2");
  assert.equal(final.homeTeamName, "Home");
  assert.equal(final.effectiveStatus, "FINISHED");
  assert.equal(final.scoreHome, 2);
});

check("healthy SQLite projection skips the full public-history parse", () => {
  let historyReads = 0;
  const durableRows = publicHistoryRowsForMatchUniverse({
    sqliteReady: true,
    readHistory: () => {
      historyReads += 1;
      return [{ id: "must-not-be-read" }];
    },
  });
  assert.deepEqual(durableRows, []);
  assert.equal(historyReads, 0);

  const fallbackRows = publicHistoryRowsForMatchUniverse({
    sqliteReady: false,
    readHistory: () => {
      historyReads += 1;
      return { matches: [{ id: "fallback-history" }] };
    },
  });
  assert.equal(historyReads, 1);
  assert.equal(fallbackRows[0]?.id, "fallback-history");
});

check("indexed match merge preserves alias, kickoff and market cohort semantics", () => {
  const merged = mergeMatchUniverseSources({
    publicCurrent: [
      {
        id: "sporttery_alias-1",
        kickoffTime: "2026-07-28T01:00:00.000Z",
        status: "SCHEDULED",
        homeTeamName: "Alias Home",
      },
      {
        id: "sporttery_alias-1",
        kickoffTime: "2026-07-29T01:00:00.000Z",
        status: "SCHEDULED",
      },
      {
        id: "sporttery_alias-1",
        kickoffTime: "2026-07-28T01:00:00.000Z",
        market: "HHAD",
        status: "SCHEDULED",
      },
    ],
    sqliteCurrent: [
      {
        id: "sqlite-row-1",
        sourceMatchId: "alias-1",
        kickoffTime: "2026-07-28T01:00:00.000Z",
        status: "SCHEDULED",
        buyEndTime: "2026-07-28T00:45:00.000Z",
      },
    ],
  });
  assert.equal(merged.matches.length, 3);
  const had = merged.matches.find((row) => (
    row.sourceMatchId === "alias-1" && String(row.market || "HAD") === "HAD"
  ));
  assert.equal(had.homeTeamName, "Alias Home");
  assert.equal(had.buyEndTime, "2026-07-28T00:45:00.000Z");
  assert.equal(
    merged.matches.filter((row) => row.kickoffTime === "2026-07-29T01:00:00.000Z").length,
    1,
    "the same alias at a different kickoff remains a distinct cohort",
  );
  assert.equal(
    merged.matches.filter((row) => row.market === "HHAD").length,
    1,
    "the same alias and kickoff in a different market remains a distinct cohort",
  );
});

check("alias bridge keeps later rows bound to the earliest matching cohort", () => {
  const kickoffTime = "2026-07-28T01:00:00.000Z";
  const merged = mergeMatchUniverseSources({
    publicCurrent: [
      { id: "bridge-x", kickoffTime, originA: true },
      { id: "bridge-y", kickoffTime, originB: true },
      {
        id: "bridge-x",
        sourceMatchId: "bridge-y",
        kickoffTime,
        bridgeObserved: true,
      },
      { id: "bridge-y", kickoffTime, laterYUpdate: true },
    ],
  });
  assert.equal(
    merged.currentMatches.length,
    2,
    "the bridge overlays the earliest cohort but does not retroactively delete the later row",
  );
  const updated = merged.currentMatches.find((row) => row.laterYUpdate === true);
  assert.equal(updated.originA, true);
  assert.notEqual(updated.originB, true);
  assert.equal(updated.bridgeObserved, true);
});

check("identity index removes aliases overwritten by a later row", () => {
  const kickoffTime = "2026-07-28T01:00:00.000Z";
  const merged = mergeMatchUniverseSources({
    publicCurrent: [
      {
        id: "stale-x",
        matchId: "stale-old",
        kickoffTime,
        originA: true,
      },
      {
        id: "stale-x",
        matchId: "stale-new",
        kickoffTime,
        replacedAIdentity: true,
      },
      { id: "stale-y", kickoffTime, originB: true },
      {
        id: "stale-y",
        sourceMatchId: "stale-old",
        kickoffTime,
        laterBBridge: true,
      },
    ],
  });
  assert.equal(merged.currentMatches.length, 2);
  const updated = merged.currentMatches.find((row) => row.laterBBridge === true);
  assert.equal(updated.originB, true);
  assert.notEqual(updated.originA, true);
  assert.equal(
    merged.currentMatches.find((row) => row.originA === true)?.matchId,
    "stale-new",
  );
});

check("large match-universe merge stays linear enough for the deadline heartbeat", () => {
  const rows = Array.from({ length: 3_000 }, (_, index) => ({
    id: `sporttery_scale-${index}`,
    sourceMatchId: `scale-${index}`,
    kickoffTime: new Date(Date.UTC(2026, 6, 28, 1, 0, index)).toISOString(),
    status: "SCHEDULED",
  }));
  const sqliteRows = rows.map((row) => ({
    id: `sqlite-${row.sourceMatchId}`,
    sourceMatchId: row.sourceMatchId,
    kickoffTime: row.kickoffTime,
    buyEndTime: new Date(Date.parse(row.kickoffTime) - 15 * 60_000).toISOString(),
  }));
  const startedAt = process.hrtime.bigint();
  const merged = mergeMatchUniverseSources({
    publicCurrent: rows,
    sqliteCurrent: sqliteRows,
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  assert.equal(merged.matches.length, rows.length);
  assert.ok(
    durationMs < 5_000,
    `3,000-row alias merge took ${durationMs.toFixed(1)}ms; heartbeat budget is 5s`,
  );
});

check("deadline batch summary rejects duplicate terminal events explicitly", () => {
  const batches = summarizeDeadlineBatches([
    {
      decisionDeadlineAt: "2026-07-27T00:45:00.000Z",
      captureFinalizationAt: "2026-07-27T00:47:00.000Z",
      status: "ready-now",
      terminalRecordedAt: "2026-07-27T00:47:01.000Z",
      terminalEventCount: 2,
    },
  ], Date.parse("2026-07-27T00:47:30.000Z"));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].terminalMatches, 1);
  assert.equal(batches[0].duplicateTerminalEvents, 1);
  assert.equal(batches[0].terminalKeysWithDuplicates, 1);
  assert.equal(batches[0].invariantOk, false);
});

check("bounded public snapshot prefix reads the complete observations array", () => {
  const prefixFile = path.join(tempDir, "prediction-snapshot-prefix.json");
  writeJson(prefixFile, {
    version: 3,
    observations: [{ sourceMatchId: "prefix-1", note: 'brackets ] [ and quote " stay data' }],
    rows: [{ payload: "x".repeat(32_000) }],
  });
  const result = readTopLevelArrayProperty(prefixFile, "observations", { maxBytes: 4_096 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceMatchId, "prefix-1");
  assert.ok(result.bytesRead < result.fileBytes);
});

check("sqlite snapshot lane selects latest per match before cutoff instead of earliest global rows", () => {
  const latestDbFile = path.join(tempDir, "latest-before-cutoff.db");
  const latestDb = new DatabaseSync(latestDbFile);
  latestDb.exec(`
    CREATE TABLE prediction_snapshots (
      id TEXT PRIMARY KEY,
      state_key TEXT UNIQUE,
      match_id TEXT,
      source_match_id TEXT,
      phase TEXT,
      captured_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    )
  `);
  const insert = latestDb.prepare(`
    INSERT INTO prediction_snapshots (
      id, state_key, match_id, source_match_id, phase,
      captured_at, first_seen_at, last_seen_at, seen_count, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const minute of [10, 20, 30, 40, 50]) {
    const capturedAt = `2026-07-27T00:${String(minute).padStart(2, "0")}:00.000Z`;
    insert.run(
      `latest-${minute}`,
      `latest-state-${minute}`,
      "sporttery_latest-1",
      "latest-1",
      "final",
      capturedAt,
      capturedAt,
      capturedAt,
      1,
      JSON.stringify({ sourceMatchId: "latest-1", capturedAt }),
    );
  }
  latestDb.close();
  const result = sqliteSnapshotsForMatches(
    [{ id: "sporttery_latest-1", sourceMatchId: "latest-1" }],
    "2026-07-27T00:00:00.000Z",
    {
      dbPath: latestDbFile,
      upperBoundForMatch: () => "2026-07-27T00:45:00.000Z",
      perMatchLimit: 2,
    },
  );
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.queryMode, "per-match-latest-before-cutoff-v1");
  assert.equal(result.selectedRows, 2);
  assert.equal(result.saturatedMatches, 1);
  assert.deepEqual(
    result.rows.map((row) => row.capturedAt),
    ["2026-07-27T00:30:00.000Z", "2026-07-27T00:40:00.000Z"],
  );
});

check("transient sqlite failure cannot create a terminal event and recovery commits once", () => {
  const recoveryDir = fs.mkdtempSync(path.join(tempDir, "sqlite-recovery-"));
  const recoveryRegistryFile = path.join(recoveryDir, "candidate-registry.json");
  const recoveryStatusFile = path.join(recoveryDir, "capture-status.json");
  const recoveryBenchmarkFile = path.join(recoveryDir, "benchmark-ledger.json");
  const recoveryCurrentFile = path.join(recoveryDir, "matches-current.json");
  const recoveryHistoryFile = path.join(recoveryDir, "matches-history.json");
  const recoverySnapshotsFile = path.join(recoveryDir, "prediction-snapshots.json");
  const missingSqliteFile = path.join(recoveryDir, "temporarily-missing.db");
  writeJson(recoveryRegistryFile, initial.registry);
  writeJson(recoveryCurrentFile, [scheduledMatch]);
  writeJson(recoveryHistoryFile, []);
  writeJson(recoverySnapshotsFile, { version: 3, observations: [], rows: [] });
  const registryBytesBeforeFailure = fs.readFileSync(recoveryRegistryFile);

  const runRecoveryCapture = (dbPath) => spawnSync(
    process.execPath,
    [captureScript],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        SERVER_STORE_DIR: recoveryDir,
        DATASTORE_SQLITE_PATH: dbPath,
        CANDIDATE_PROSPECTIVE_REGISTRY_FILE: recoveryRegistryFile,
        BENCHMARK_PROSPECTIVE_LEDGER_FILE: recoveryBenchmarkFile,
        CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: recoveryStatusFile,
        CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE: recoveryCurrentFile,
        CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE: recoveryHistoryFile,
        CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE: recoverySnapshotsFile,
        CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: "2026-07-27T00:47:30.000Z",
        CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "100",
        TRUSTED_SPORTTERY_COLLECTOR_COUNT: "2",
      },
    },
  );

  const failed = runRecoveryCapture(missingSqliteFile);
  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  const failedStatus = JSON.parse(fs.readFileSync(recoveryStatusFile, "utf8"));
  const failedRegistry = JSON.parse(fs.readFileSync(recoveryRegistryFile, "utf8"));
  const failedLedger = failedRegistry.ledgers.find(
    (ledger) => ledger.ledgerId === failedRegistry.activeLedgerId,
  );
  assert.equal(failedStatus.reason, "deadline-evidence-query-incomplete");
  assert.equal(failedStatus.changed, false);
  assert.equal(failedStatus.eventsAdded, 0);
  assert.equal(failedStatus.dueCaptureEventsAdded, 0);
  assert.equal(failedStatus.dueDecisionEventsAdded, 0);
  assert.equal(failedStatus.dueExclusionEventsAdded, 0);
  assert.equal(failedStatus.dueAtomicDecisionEventsAdded, 0);
  assert.equal(failedStatus.dueCaptureComplete, false);
  assert.equal(failedStatus.dueAtomicComplete, false);
  assert.equal(failedStatus.dueUnrecorded, 1);
  assert.deepEqual(fs.readFileSync(recoveryRegistryFile), registryBytesBeforeFailure);
  assert.equal(
    failedLedger.events.filter((event) => ["decision", "exclusion"].includes(event.type)).length,
    0,
  );

  const replacementSqliteFile = `${missingSqliteFile}.next`;
  fs.copyFileSync(sqliteFile, replacementSqliteFile);
  fs.renameSync(replacementSqliteFile, missingSqliteFile);
  const recovered = runRecoveryCapture(missingSqliteFile);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  const recoveredStatus = JSON.parse(fs.readFileSync(recoveryStatusFile, "utf8"));
  const recoveredRegistry = JSON.parse(fs.readFileSync(recoveryRegistryFile, "utf8"));
  const recoveredLedger = recoveredRegistry.ledgers.find(
    (ledger) => ledger.ledgerId === recoveredRegistry.activeLedgerId,
  );
  const recoveredRootHash = recoveredLedger.rootHash;
  assert.equal(recoveredStatus.dueDecisionEventsAdded, 1);
  assert.equal(recoveredStatus.dueExclusionEventsAdded, 0);
  assert.equal(recoveredStatus.dueCaptureComplete, true);
  assert.equal(recoveredStatus.dueAtomicComplete, true);
  assert.equal(recoveredStatus.audit.decisionRecord.admittedRows, 1);
  assert.equal(recoveredStatus.audit.decisionRecord.atomicRows, 1);
  assert.equal(recoveredStatus.audit.decisionRecord.coverage, 1);
  assert.equal(recoveredStatus.audit.decisionRecord.complete, true);
  assert.equal(recoveredLedger.events.filter((event) => event.type === "decision").length, 1);
  assert.equal(recoveredLedger.events.filter((event) => event.type === "exclusion").length, 0);

  const repeated = runRecoveryCapture(missingSqliteFile);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  const repeatedStatus = JSON.parse(fs.readFileSync(recoveryStatusFile, "utf8"));
  const repeatedRegistry = JSON.parse(fs.readFileSync(recoveryRegistryFile, "utf8"));
  const repeatedLedger = repeatedRegistry.ledgers.find(
    (ledger) => ledger.ledgerId === repeatedRegistry.activeLedgerId,
  );
  assert.equal(repeatedStatus.eventsAdded, 0);
  assert.equal(repeatedLedger.events.filter((event) => event.type === "decision").length, 1);
  assert.equal(repeatedLedger.rootHash, recoveredRootHash);
  assert.equal(repeatedStatus.readiness.deadlineBatches[0].duplicateTerminalEvents, 0);
  assert.equal(repeatedStatus.readiness.deadlineBatches[0].terminalKeysWithDuplicates, 0);
  assert.equal(verifyRegistry(repeatedRegistry).valid, true);
});

check("pre-deadline heartbeat leaves the frozen denominator unchanged", () => {
  const result = runCapture("2026-07-27T00:44:00.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkLedgerFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.dueMatches, 0);
  assert.equal(status.captureMode, "full");
  assert.equal(status.readiness.version, "candidate-prospective-readiness-preview-v2");
  assert.equal(status.readiness.upcomingMatches, 1);
  assert.equal(status.readiness.readyNow, 1);
  assert.equal(status.readiness.atomicReadyNow, 1);
  assert.equal(status.readiness.awaitingMarket, 0);
  assert.equal(status.readiness.blocked, 0);
  assert.equal(status.readiness.readyInvariantOk, true);
  assert.equal(status.readiness.nearestStatus, "ready-now");
  assert.deepEqual(status.readiness.blockerCounts, {});
  assert.deepEqual(status.readiness.excludedReasonCounts, {});
  assert.equal(status.readiness.rows[0].atomicEvidenceValid, true);
  assert.equal(active.events.filter((event) => event.type === "decision").length, 0);
  assert.equal(status.benchmark.dueMatches, 0);
  assert.equal(status.benchmark.eventsAdded, 1);
  assert.deepEqual(benchmark.events.map((event) => event.type), ["universe"]);
  assert.equal(benchmark.events[0].createdBeforeCutoff, true);
});

check("benchmark-only refresh leaves the formal heartbeat identity untouched", () => {
  const formalBefore = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const result = runCapture(
    "2026-07-27T00:44:30.000Z",
    {},
    ["--benchmark-only"],
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const formalAfter = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const benchmarkStatus = JSON.parse(fs.readFileSync(benchmarkStatusFile, "utf8"));
  assert.equal(formalAfter.evaluatedAt, formalBefore.evaluatedAt);
  assert.equal(formalAfter.captureMode, "full");
  assert.equal(benchmarkStatus.captureMode, "benchmark-only");
  assert.equal(benchmarkStatus.evaluatedAt, "2026-07-27T00:44:30.000Z");
  assert.equal(benchmarkStatus.ok, true);
  assert.equal(benchmarkStatus.skipped, false);
});

check("deadline heartbeat waits for the fixed evidence finalization grace", () => {
  const result = runCapture("2026-07-27T00:45:30.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.dueMatches, 0);
  assert.equal(status.readiness.nearestDeadlineAt, scheduledMatch.buyEndTime);
  assert.equal(status.readiness.nearestFinalizationAt, "2026-07-27T00:47:00.000Z");
  assert.equal(active.events.filter((event) => event.type === "decision").length, 0);
});

check("finalization heartbeat prefers the latest deadline observation over semantic state", () => {
  const result = runCapture("2026-07-27T00:47:30.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkLedgerFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  const decision = active.events.find((event) => event.type === "decision");
  assert.equal(status.dueMatches, 1);
  assert.equal(status.dueCaptureEventsAdded, 1);
  assert.equal(status.dueDecisionEventsAdded, 1);
  assert.equal(status.dueExclusionEventsAdded, 0);
  assert.equal(status.dueAtomicDecisionEventsAdded, 1);
  assert.equal(status.dueCaptureComplete, true);
  assert.equal(status.dueAtomicComplete, true);
  assert.equal(status.sqliteSnapshots, 1);
  assert.equal(status.eventsAdded, 1);
  assert.equal(status.audit.version, "candidate-prospective-audit-v1");
  assert.equal(status.audit.decisionRecord.admittedRows, 1);
  assert.equal(status.audit.decisionRecord.atomicRows, 1);
  assert.equal(
    status.audit.decisionRecord.validationVersion,
    ATOMIC_DECISION_VALIDATION_VERSION,
  );
  assert.equal(status.audit.decisionRecord.completeRows, 1);
  assert.equal(status.audit.decisionRecord.failedRows, 0);
  assert.deepEqual(status.audit.decisionRecord.blockerCounts, {});
  assert.equal(status.audit.settlementRecord.version, SETTLEMENT_RECORD_VERSION);
  assert.equal(
    status.audit.settlementRecord.validationVersion,
    SETTLEMENT_VALIDATION_VERSION,
  );
  assert.equal(status.audit.settlementRecord.rows, 0);
  assert.equal(status.audit.settlementRecord.coverage, 1);
  assert.equal(status.audit.settlementRecord.complete, true);
  assert.equal(status.audit.cohort.shadow.admitted, 1);
  assert.equal(status.audit.cohort.shadow.pending, 1);
  assert.equal(status.audit.shadow.admitted, 1);
  assert.equal(
    status.audit.metrics.diagnostics.version,
    "candidate-formal-metric-diagnostic-v1",
  );
  assert.equal(status.audit.metrics.diagnostics.totalRows, 0);
  assert.equal(status.audit.metrics.diagnostics.detailedRows, 0);
  assert.deepEqual(status.audit.metrics.diagnostics.rows, []);
  assert.equal(decision.sourceMatchId, "deadline-1");
  assert.equal(decision.snapshotCapturedAt, publicObservationAt);
  assert.equal(decision.phase, "pre-gate-shadow");
  assert.equal(decision.admissionEligible, true);
  assert.equal(decision.singleAttestor, false);
  assert.equal(decision.decisionDeadlineAt, scheduledMatch.buyEndTime);
  assert.equal(decision.decisionDeadlineSource, "buy-end-time");
  assert.equal(decision.captureFinalizationAt, "2026-07-27T00:47:00.000Z");
  assert.equal(decision.captureFinalizationPolicyVersion, "deadline-evidence-grace-v1");
  assert.equal(decision.captureFinalizationGraceSeconds, 120);
  assert.equal(decision.featureSnapshot.modelInputs.form.home, 1.6);
  assert.equal(decision.sourceClock.sourceCycleId, "cycle-deadline-public-observation");
  assert.equal(
    decision.strategyVersions.predictionPolicyVersion,
    "prediction-policy-deadline-v1",
  );
  assert.match(decision.atomicDecisionHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyRegistry(registry).valid, true);
  pendingRegistrySnapshot = structuredClone(registry);
  assert.equal(status.benchmark.dueMatches, 0);
  assert.equal(status.benchmark.eventsAdded, 0);
  assert.deepEqual(benchmark.events.map((event) => event.type), ["universe"]);
});

check("independent benchmark captures later without duplicating candidate decision", () => {
  const result = runCapture("2026-07-27T00:50:30.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkLedgerFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.dueMatches, 0);
  assert.equal(active.events.filter((event) => event.type === "decision").length, 1);
  assert.equal(status.benchmark.dueMatches, 1);
  assert.equal(status.benchmark.sqliteSnapshots, 1);
  assert.equal(status.benchmark.eventsAdded, 2);
  assert.deepEqual(benchmark.events.map((event) => event.type), [
    "universe",
    "selection",
    "settlement_hold",
  ]);
  assert.equal(benchmark.events[1].tipCode, "1");
});

check("repeated heartbeat is idempotent for both prospective ledgers", () => {
  const result = runCapture("2026-07-27T00:51:00.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkLedgerFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.dueMatches, 0);
  assert.equal(active.events.filter((event) => event.type === "decision").length, 1);
  assert.equal(status.benchmark.dueMatches, 0);
  assert.equal(status.benchmark.eventsAdded, 0);
  assert.equal(benchmark.events.filter((event) => event.type === "selection").length, 1);
});

const strictOfficialFinalFor = (matchRow, observedAt) => ({
  ...matchRow,
  status: "PENDING_RESULT",
  effectiveStatus: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  resultSource: "sporttery:official-api",
  sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
  resultObservedAt: observedAt,
  resultObservationSource: "sporttery-relay-result-observation",
  resultObservationFallback: false,
  resultProvenance: {
    official: true,
    trusted: true,
    provider: "sporttery",
    source: "sporttery:official-api",
    sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
    promotionEligible: true,
    secondaryResultVerified: true,
    eventVersionConsistent: true,
    resultObservationFallback: false,
    observationSource: "sporttery-relay-result-observation",
    sourceMatchId: matchRow.sourceMatchId,
    observedAt,
    eventVersion: matchRow.kickoffTime,
    scoreHome: 2,
    scoreAway: 0,
  },
});

const runIsolatedCapture = ({
  directory,
  at,
  sqlitePath,
}) => spawnSync(process.execPath, [captureScript], {
  cwd: rootDir,
  encoding: "utf8",
  env: {
    ...process.env,
    NODE_ENV: "test",
    SERVER_STORE_DIR: directory,
    DATASTORE_SQLITE_PATH: sqlitePath,
    CANDIDATE_PROSPECTIVE_REGISTRY_FILE: path.join(directory, "registry.json"),
    BENCHMARK_PROSPECTIVE_LEDGER_FILE: path.join(directory, "benchmark.json"),
    CANDIDATE_PROSPECTIVE_CHALLENGER_SUITE_FILE: path.join(directory, "challengers.json"),
    CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: path.join(directory, "status.json"),
    CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE: path.join(directory, "current.json"),
    CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE: path.join(directory, "history.json"),
    CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE: path.join(directory, "snapshots.json"),
    CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: at,
    CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "100",
    TRUSTED_SPORTTERY_COLLECTOR_COUNT: "2",
  },
});

check("official settlement is not starved by implementation drift", () => {
  assert.ok(pendingRegistrySnapshot);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-drift-settlement-"));
  try {
    const registry = structuredClone(pendingRegistrySnapshot);
    const active = registry.ledgers.find((row) => row.ledgerId === registry.activeLedgerId);
    active.header.candidateImplementation.sourceHashes = {
      ...(active.header.candidateImplementation.sourceHashes || {}),
      "scripts/missing-after-release.cjs": "9".repeat(64),
    };
    active.headerHash = sha256(active.header);
    assert.equal(verifyRegistry(registry).valid, true);
    writeJson(path.join(directory, "registry.json"), registry);
    writeJson(path.join(directory, "current.json"), []);
    writeJson(path.join(directory, "history.json"), [
      strictOfficialFinalFor(scheduledMatch, "2026-07-27T03:00:00.000Z"),
    ]);
    writeJson(path.join(directory, "snapshots.json"), { version: 3, observations: [], rows: [] });
    const sqlitePath = path.join(directory, "missing.db");
    const first = runIsolatedCapture({
      directory,
      at: "2026-07-27T03:03:00.000Z",
      sqlitePath,
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstStatus = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
    const firstRegistry = JSON.parse(fs.readFileSync(path.join(directory, "registry.json"), "utf8"));
    const firstLedger = firstRegistry.ledgers.find(
      (row) => row.ledgerId === firstRegistry.activeLedgerId,
    );
    assert.equal(firstStatus.reason, "candidate-implementation-drift-awaiting-refreeze");
    assert.equal(firstStatus.settlementEventsAdded, 1);
    assert.equal(firstLedger.events.filter((event) => event.type === "settlement").length, 1);
    const firstRoot = firstLedger.rootHash;

    const repeated = runIsolatedCapture({
      directory,
      at: "2026-07-27T03:04:00.000Z",
      sqlitePath,
    });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const repeatedStatus = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
    const repeatedRegistry = JSON.parse(fs.readFileSync(path.join(directory, "registry.json"), "utf8"));
    const repeatedLedger = repeatedRegistry.ledgers.find(
      (row) => row.ledgerId === repeatedRegistry.activeLedgerId,
    );
    assert.equal(repeatedStatus.settlementEventsAdded, 0);
    assert.equal(repeatedLedger.rootHash, firstRoot);
    assert.equal(repeatedLedger.events.filter((event) => event.type === "settlement").length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check("official settlement survives an unrelated incomplete due-evidence query", () => {
  assert.ok(pendingRegistrySnapshot);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-query-settlement-"));
  try {
    const unrelatedDue = {
      id: "sporttery_unrelated-due",
      sourceMatchId: "unrelated-due",
      kickoffTime: "2026-07-27T04:00:00.000Z",
      buyEndTime: "2026-07-27T03:45:00.000Z",
      status: "SCHEDULED",
    };
    writeJson(path.join(directory, "registry.json"), pendingRegistrySnapshot);
    writeJson(path.join(directory, "current.json"), [unrelatedDue]);
    writeJson(path.join(directory, "history.json"), [
      strictOfficialFinalFor(scheduledMatch, "2026-07-27T03:00:00.000Z"),
    ]);
    writeJson(path.join(directory, "snapshots.json"), { version: 3, observations: [], rows: [] });
    const sqlitePath = path.join(directory, "missing.db");
    const first = runIsolatedCapture({
      directory,
      at: "2026-07-27T03:47:30.000Z",
      sqlitePath,
    });
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const firstStatus = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
    const firstRegistry = JSON.parse(fs.readFileSync(path.join(directory, "registry.json"), "utf8"));
    const firstLedger = firstRegistry.ledgers.find(
      (row) => row.ledgerId === firstRegistry.activeLedgerId,
    );
    assert.equal(firstStatus.reason, "deadline-evidence-query-incomplete");
    assert.equal(firstStatus.settlementEventsAdded, 1);
    assert.equal(firstStatus.dueUnrecorded, 1);
    assert.equal(firstLedger.events.filter((event) => event.type === "settlement").length, 1);
    assert.equal(
      firstLedger.events.some((event) => event.sourceMatchId === unrelatedDue.sourceMatchId),
      false,
      "the failed evidence query cannot backfill a decision or exclusion",
    );
    const firstRoot = firstLedger.rootHash;

    const repeated = runIsolatedCapture({
      directory,
      at: "2026-07-27T03:48:00.000Z",
      sqlitePath,
    });
    assert.equal(repeated.status, 1, repeated.stderr || repeated.stdout);
    const repeatedRegistry = JSON.parse(fs.readFileSync(path.join(directory, "registry.json"), "utf8"));
    const repeatedLedger = repeatedRegistry.ledgers.find(
      (row) => row.ledgerId === repeatedRegistry.activeLedgerId,
    );
    assert.equal(repeatedLedger.rootHash, firstRoot);
    assert.equal(repeatedLedger.events.filter((event) => event.type === "settlement").length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check("ineligible result supplement leaves the admitted shadow row pending", () => {
  writeJson(currentFile, []);
  writeJson(historyFile, [{
    ...scheduledMatch,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultObservedAt: "2026-07-27T02:55:00.000Z",
    resultProvenance: {
      official: true,
      trusted: true,
      provider: "official-club",
      promotionEligible: false,
      sourceMatchId: "deadline-1",
      observedAt: "2026-07-27T02:55:00.000Z",
      eventVersion: kickoffTime,
    },
  }]);
  const result = runCapture("2026-07-27T02:56:00.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.audit.shadow.settled, 0);
  assert.equal(status.audit.shadow.pending, 1);
  assert.equal(active.events.filter((event) => event.type === "settlement").length, 0);
});

check("fallback Sporttery-shaped provenance cannot close the pending shadow row", () => {
  writeJson(historyFile, [{
    ...scheduledMatch,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultObservedAt: "2026-07-27T02:57:00.000Z",
    resultObservationFallback: true,
    resultProvenance: {
      official: true,
      trusted: true,
      provider: "sporttery",
      promotionEligible: true,
      eventVersionConsistent: true,
      resultObservationFallback: true,
      observationSource: "legacy-fallback-result",
      sourceMatchId: "deadline-1",
      observedAt: "2026-07-27T02:57:00.000Z",
      eventVersion: kickoffTime,
      scoreHome: 2,
      scoreAway: 0,
    },
  }]);
  const result = runCapture("2026-07-27T02:58:00.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const active = registry.ledgers.find((ledger) => ledger.ledgerId === registry.activeLedgerId);
  assert.equal(status.audit.shadow.settled, 0);
  assert.equal(status.audit.shadow.pending, 1);
  assert.equal(active.events.filter((event) => event.type === "settlement").length, 0);
});

check("heartbeat settles the pending shadow row from promotion-eligible Sporttery provenance", () => {
  writeJson(currentFile, []);
  writeJson(historyFile, [{
    ...scheduledMatch,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultSource: "sporttery:official-api",
    sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
    resultObservedAt: "2026-07-27T03:00:00.000Z",
    resultObservationSource: "sporttery-relay-result-observation",
    resultObservationFallback: false,
    resultProvenance: {
      official: true,
      trusted: true,
      provider: "sporttery",
      source: "sporttery:official-api",
      sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
      promotionEligible: true,
      secondaryResultVerified: true,
      eventVersionConsistent: true,
      resultObservationFallback: false,
      observationSource: "sporttery-relay-result-observation",
      sourceMatchId: "deadline-1",
      observedAt: "2026-07-27T03:00:00.000Z",
      eventVersion: kickoffTime,
      scoreHome: 2,
      scoreAway: 0,
    },
  }]);
  const result = runCapture("2026-07-27T03:01:00.000Z");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkLedgerFile, "utf8"));
  assert.equal(status.audit.shadow.settled, 1);
  assert.equal(status.audit.shadow.pending, 0);
  assert.equal(status.benchmark.eventsAdded, 1);
  assert.equal(status.benchmark.sqliteOdds, 1);
  assert.deepEqual(benchmark.events.map((event) => event.type), [
    "universe",
    "selection",
    "settlement_hold",
    "settlement_hold",
    "settlement_hold",
    "settlement",
  ]);
  assert.equal(benchmark.events[5].outcome, "WON");
  assert.ok(benchmark.events[5].closingSnapshotHash);
});

check("registry lock contention fails closed without corrupting the ledger", () => {
  const priorStatus = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(priorStatus.ok, true);
  assert.equal(priorStatus.skipped, false);
  assert.equal(priorStatus.readiness.version, "candidate-prospective-readiness-preview-v2");
  const lockFile = registryLockFileFor(registryFile);
  fs.writeFileSync(lockFile, "occupied", "utf8");
  const result = runCapture("2026-07-27T03:02:00.000Z", {
    CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "30",
  });
  fs.rmSync(lockFile, { force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const transient = JSON.parse(result.stdout);
  assert.deepEqual(status, priorStatus);
  assert.equal(transient.reason, priorStatus.reason);
  assert.equal(transient.transientAttempt.reason, "registry-lock-busy");
  assert.equal(transient.transientAttempt.evaluatedAt, "2026-07-27T03:02:00.000Z");
  assert.equal(verifyRegistry(registry).valid, true);
});

check("transient sqlite replacement keeps a complete non-skipped readiness heartbeat", () => {
  const priorRegistry = fs.readFileSync(registryFile);
  const validSqlite = fs.readFileSync(sqliteFile);
  const validCurrent = fs.readFileSync(currentFile);
  try {
    writeJson(currentFile, [{
      ...scheduledMatch,
      id: "sporttery_sqlite-replacement-future",
      sourceMatchId: "sqlite-replacement-future",
      kickoffTime: "2026-07-28T01:00:00.000Z",
      buyEndTime: "2026-07-28T00:45:00.000Z",
    }]);
    fs.writeFileSync(sqliteFile, "sqlite replacement in progress", "utf8");
    const result = runCapture("2026-07-27T03:02:30.000Z");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(status.ok, true);
    assert.equal(status.skipped, false);
    assert.equal(status.reason, "settlement-heartbeat");
    assert.equal(status.readiness.version, "candidate-prospective-readiness-preview-v2");
    assert.equal(status.readinessSqliteStatus, "degraded");
    assert.match(
      status.readinessSqliteReason,
      /^sqlite prediction snapshot read failed:/,
    );
    assert.deepEqual(fs.readFileSync(registryFile), priorRegistry);
    assert.equal(verifyRegistry(registry).valid, true);
  } finally {
    fs.writeFileSync(sqliteFile, validSqlite);
    fs.writeFileSync(currentFile, validCurrent);
  }
});

check("deadline heartbeat atomically captures all-ready and mixed six-match cohorts exactly once", () => {
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-deadline-batch-"));
  try {
    const batchRegistryFile = path.join(batchDir, "candidate-registry.json");
    const batchStatusFile = path.join(batchDir, "capture-status.json");
    const batchBenchmarkFile = path.join(batchDir, "benchmark-ledger.json");
    const batchCurrentFile = path.join(batchDir, "matches-current.json");
    const batchHistoryFile = path.join(batchDir, "matches-history.json");
    const batchSnapshotsFile = path.join(batchDir, "prediction-snapshots.json");
    const batchSqliteFile = path.join(batchDir, "football.db");
    const batchInitial = updateCandidateProspectiveLedger({
      candidates: [baseline, candidate],
      selectedCandidate: candidate,
      robustness: {
        version: "shadow-candidate-robustness-v1",
        family: { inventoryHash: null },
        selectedCandidate: { id: candidate.id },
        candidateReadyForProspectiveTest: false,
      },
      matches: [],
      snapshots: [],
      evaluatedAt: "2026-07-27T00:00:00.000Z",
      implementationCommitment,
      trustedCollectorCount: 2,
    });
    assert.equal(batchInitial.chainValid, true);

    const batchMatches = [];
    const batchSnapshots = [];
    for (let index = 1; index <= 6; index += 1) {
      const sourceMatchId = `deadline-batch-${index}`;
      const matchId = `sporttery_${sourceMatchId}`;
      const sourceCycleId = `cycle-${sourceMatchId}`;
      const clonedMatch = {
        ...scheduledMatch,
        id: matchId,
        sourceMatchId,
        homeTeamName: `Home ${index}`,
        awayTeamName: `Away ${index}`,
      };
      const clonedSnapshot = JSON.parse(JSON.stringify(publicObservation));
      clonedSnapshot.sourceMatchId = sourceMatchId;
      clonedSnapshot.matchId = matchId;
      clonedSnapshot.sourceCycleId = sourceCycleId;
      clonedSnapshot.featureSnapshotHash = `feature-${sourceMatchId}`;
      clonedSnapshot.featureSnapshot.sourceCycleId = sourceCycleId;
      clonedSnapshot.decisionSnapshot.sourceMatchId = sourceMatchId;
      clonedSnapshot.decisionSnapshot.matchId = matchId;
      clonedSnapshot.decisionSnapshot.sourceCycleId = sourceCycleId;
      clonedSnapshot.decisionSnapshot.featureSnapshotHash = `feature-${sourceMatchId}`;
      clonedSnapshot.decisionSnapshot.policyHash = `${index}`.repeat(64);
      clonedSnapshot.decisionSnapshot.markets.HAD.provenance.market.sourceMatchId =
        sourceMatchId;
      clonedSnapshot.decisionSnapshot.markets.HAD.provenance.hash =
        `${index}`.repeat(64);
      clonedSnapshot.decisionSnapshot.markets.HAD.provenanceHash =
        `${index}`.repeat(64);
      batchMatches.push(clonedMatch);
      batchSnapshots.push(clonedSnapshot);
    }

    writeJson(batchRegistryFile, batchInitial.registry);
    writeJson(batchCurrentFile, batchMatches);
    writeJson(batchHistoryFile, []);
    writeJson(batchSnapshotsFile, {
      version: 3,
      observations: batchSnapshots,
      rows: batchSnapshots,
    });

    const batchDb = new DatabaseSync(batchSqliteFile);
    batchDb.exec(`
      CREATE TABLE prediction_snapshots (
        id TEXT PRIMARY KEY,
        state_key TEXT UNIQUE,
        match_id TEXT,
        source_match_id TEXT,
        phase TEXT,
        captured_at TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        seen_count INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL
      );
      CREATE TABLE odds_snapshots (
        id TEXT PRIMARY KEY,
        state_key TEXT UNIQUE,
        match_id TEXT,
        source_match_id TEXT,
        pool TEXT,
        bookmaker TEXT,
        handicap_line REAL,
        captured_at TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        seen_count INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL
      );
    `);
    const insertBatchSnapshot = batchDb.prepare(`
      INSERT INTO prediction_snapshots (
        id, state_key, match_id, source_match_id, phase,
        captured_at, first_seen_at, last_seen_at, seen_count, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < batchSnapshots.length; index += 1) {
      const row = batchSnapshots[index];
      insertBatchSnapshot.run(
        `snapshot-batch-${index + 1}`,
        `state-batch-${index + 1}`,
        row.matchId,
        row.sourceMatchId,
        row.phase,
        row.capturedAt,
        row.firstSeenAt,
        row.capturedAt,
        1,
        JSON.stringify(row),
      );
    }
    batchDb.close();

    const runBatchCapture = (at) => spawnSync(
      process.execPath,
      [captureScript],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          SERVER_STORE_DIR: batchDir,
          DATASTORE_SQLITE_PATH: batchSqliteFile,
          CANDIDATE_PROSPECTIVE_REGISTRY_FILE: batchRegistryFile,
          BENCHMARK_PROSPECTIVE_LEDGER_FILE: batchBenchmarkFile,
          CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: batchStatusFile,
          CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE: batchCurrentFile,
          CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE: batchHistoryFile,
          CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE: batchSnapshotsFile,
          CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: at,
          CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "100",
          TRUSTED_SPORTTERY_COLLECTOR_COUNT: "2",
        },
      },
    );

    const first = runBatchCapture("2026-07-27T00:47:30.000Z");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstStatus = JSON.parse(fs.readFileSync(batchStatusFile, "utf8"));
    const firstRegistry = JSON.parse(fs.readFileSync(batchRegistryFile, "utf8"));
    const firstLedger = firstRegistry.ledgers.find(
      (ledger) => ledger.ledgerId === firstRegistry.activeLedgerId,
    );
    const firstDecisions = firstLedger.events.filter((event) => event.type === "decision");
    assert.equal(firstStatus.dueMatches, 6, "due match count");
    assert.equal(firstStatus.dueCaptureEventsAdded, 6, "due cohort events");
    assert.equal(firstStatus.dueDecisionEventsAdded, 6, "due decisions");
    assert.equal(firstStatus.dueExclusionEventsAdded, 0, "due exclusions");
    assert.equal(firstStatus.dueAtomicDecisionEventsAdded, 6, "atomic due decisions");
    assert.equal(firstStatus.dueCaptureComplete, true);
    assert.equal(firstStatus.dueAtomicComplete, true);
    assert.equal(firstStatus.eventsAdded, 6, "events added");
    assert.equal(firstStatus.audit.decisionRecord.admittedRows, 6);
    assert.equal(firstStatus.audit.decisionRecord.atomicRows, 6);
    assert.equal(
      firstStatus.audit.decisionRecord.validationVersion,
      ATOMIC_DECISION_VALIDATION_VERSION,
    );
    assert.equal(firstStatus.audit.decisionRecord.completeRows, 6);
    assert.equal(firstStatus.audit.decisionRecord.failedRows, 0);
    assert.deepEqual(firstStatus.audit.decisionRecord.blockerCounts, {});
    assert.equal(firstStatus.audit.cohort.shadow.admitted, 6);
    assert.equal(firstStatus.audit.shadow.universe, 6, "shadow universe");
    assert.equal(firstStatus.audit.shadow.admitted, 6, "shadow admitted");
    assert.equal(firstStatus.audit.shadow.pending, 6, "shadow pending");
    assert.equal(firstStatus.readiness.deadlineBatches.length, 1);
    assert.deepEqual(
      {
        deadlineAt: firstStatus.readiness.deadlineBatches[0].deadlineAt,
        phase: firstStatus.readiness.deadlineBatches[0].phase,
        totalMatches: firstStatus.readiness.deadlineBatches[0].totalMatches,
        readyNow: firstStatus.readiness.deadlineBatches[0].readyNow,
        excluded: firstStatus.readiness.deadlineBatches[0].excluded,
        terminalDecisions:
          firstStatus.readiness.deadlineBatches[0].terminalDecisions,
        duplicateTerminalEvents:
          firstStatus.readiness.deadlineBatches[0].duplicateTerminalEvents,
        terminalKeysWithDuplicates:
          firstStatus.readiness.deadlineBatches[0].terminalKeysWithDuplicates,
        terminalMatches:
          firstStatus.readiness.deadlineBatches[0].terminalMatches,
        pendingMatches:
          firstStatus.readiness.deadlineBatches[0].pendingMatches,
        dueUnrecorded:
          firstStatus.readiness.deadlineBatches[0].dueUnrecorded,
        readyDueUnrecorded:
          firstStatus.readiness.deadlineBatches[0].readyDueUnrecorded,
        invariantOk: firstStatus.readiness.deadlineBatches[0].invariantOk,
      },
      {
        deadlineAt: "2026-07-27T00:45:00.000Z",
        phase: "post-finalization",
        totalMatches: 6,
        readyNow: 6,
        excluded: 0,
        terminalDecisions: 6,
        duplicateTerminalEvents: 0,
        terminalKeysWithDuplicates: 0,
        terminalMatches: 6,
        pendingMatches: 0,
        dueUnrecorded: 0,
        readyDueUnrecorded: 0,
        invariantOk: true,
      },
    );
    assert.equal(
      firstStatus.readiness.nearestDeadlineBatch,
      null,
    );
    assert.equal(firstStatus.readiness.nearestDeadlineAt, null);
    assert.equal(firstStatus.readiness.nearestFinalizationAt, null);
    assert.equal(firstStatus.readiness.nearestStatus, null);
    assert.equal(firstDecisions.length, 6, "decision count");
    assert.equal(new Set(firstDecisions.map((event) => event.sourceMatchId)).size, 6);
    assert.equal(firstDecisions.every((event) => event.admissionEligible === true), true);
    assert.equal(firstDecisions.every((event) => atomicDecisionRecordValid(event)), true);
    assert.equal(verifyRegistry(firstRegistry).valid, true);
    const firstRootHash = firstLedger.rootHash;

    const repeated = runBatchCapture("2026-07-27T00:47:45.000Z");
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const repeatedStatus = JSON.parse(fs.readFileSync(batchStatusFile, "utf8"));
    const repeatedRegistry = JSON.parse(fs.readFileSync(batchRegistryFile, "utf8"));
    const repeatedLedger = repeatedRegistry.ledgers.find(
      (ledger) => ledger.ledgerId === repeatedRegistry.activeLedgerId,
    );
    assert.equal(repeatedStatus.dueMatches, 0);
    assert.equal(repeatedStatus.dueCaptureEventsAdded, 0);
    assert.equal(repeatedStatus.dueDecisionEventsAdded, 0);
    assert.equal(repeatedStatus.dueExclusionEventsAdded, 0);
    assert.equal(repeatedStatus.dueAtomicDecisionEventsAdded, 0);
    assert.equal(repeatedStatus.dueCaptureComplete, true);
    assert.equal(repeatedStatus.dueAtomicComplete, true);
    assert.equal(repeatedStatus.eventsAdded, 0);
    assert.equal(repeatedLedger.events.filter((event) => event.type === "decision").length, 6);
    assert.equal(repeatedLedger.rootHash, firstRootHash);
    assert.equal(
      repeatedStatus.readiness.deadlineBatches[0].terminalDecisions,
      6,
    );
    assert.equal(
      repeatedStatus.readiness.deadlineBatches[0].duplicateTerminalEvents,
      0,
    );
    assert.equal(
      repeatedStatus.readiness.deadlineBatches[0].terminalKeysWithDuplicates,
      0,
    );
    assert.equal(
      repeatedStatus.readiness.deadlineBatches[0].dueUnrecorded,
      0,
    );
    assert.equal(
      repeatedStatus.readiness.deadlineBatches[0].readyDueUnrecorded,
      0,
    );
    assert.equal(verifyRegistry(repeatedRegistry).valid, true);

    const mixedRegistryFile = path.join(batchDir, "candidate-registry-mixed.json");
    const mixedStatusFile = path.join(batchDir, "capture-status-mixed.json");
    const mixedBenchmarkFile = path.join(batchDir, "benchmark-ledger-mixed.json");
    const mixedMatches = JSON.parse(JSON.stringify(batchMatches));
    const mixedSnapshots = JSON.parse(JSON.stringify(batchSnapshots));
    mixedMatches[5].buyEndTime = "2026-07-27T00:44:00.000Z";
    delete mixedSnapshots[5].decisionSnapshot.markets.HAD;
    writeJson(mixedRegistryFile, batchInitial.registry);
    writeJson(batchCurrentFile, mixedMatches);
    writeJson(batchSnapshotsFile, {
      version: 3,
      observations: mixedSnapshots,
      rows: mixedSnapshots,
    });

    const runMixedCapture = (at) => spawnSync(
      process.execPath,
      [captureScript],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          SERVER_STORE_DIR: batchDir,
          DATASTORE_SQLITE_PATH: batchSqliteFile,
          CANDIDATE_PROSPECTIVE_REGISTRY_FILE: mixedRegistryFile,
          BENCHMARK_PROSPECTIVE_LEDGER_FILE: mixedBenchmarkFile,
          CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE: mixedStatusFile,
          CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE: batchCurrentFile,
          CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE: batchHistoryFile,
          CANDIDATE_PROSPECTIVE_PUBLIC_SNAPSHOTS_FILE: batchSnapshotsFile,
          CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: at,
          CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: "100",
          TRUSTED_SPORTTERY_COLLECTOR_COUNT: "2",
        },
      },
    );

    const mixedFirst = runMixedCapture("2026-07-27T00:47:30.000Z");
    assert.equal(mixedFirst.status, 0, mixedFirst.stderr || mixedFirst.stdout);
    const mixedFirstStatus = JSON.parse(fs.readFileSync(mixedStatusFile, "utf8"));
    const mixedFirstRegistry = JSON.parse(fs.readFileSync(mixedRegistryFile, "utf8"));
    const mixedFirstLedger = mixedFirstRegistry.ledgers.find(
      (ledger) => ledger.ledgerId === mixedFirstRegistry.activeLedgerId,
    );
    const mixedFirstDecisions = mixedFirstLedger.events
      .filter((event) => event.type === "decision");
    const mixedFirstExclusions = mixedFirstLedger.events
      .filter((event) => event.type === "exclusion");
    assert.equal(mixedFirstStatus.dueMatches, 6, "mixed due match count");
    assert.equal(mixedFirstStatus.dueCaptureEventsAdded, 6, "mixed due cohort events");
    assert.equal(mixedFirstStatus.dueDecisionEventsAdded, 5, "mixed due decisions");
    assert.equal(mixedFirstStatus.dueExclusionEventsAdded, 1, "mixed due exclusions");
    assert.equal(
      mixedFirstStatus.dueAtomicDecisionEventsAdded,
      5,
      "mixed atomic due decisions",
    );
    assert.equal(mixedFirstStatus.dueCaptureComplete, true);
    assert.equal(mixedFirstStatus.dueAtomicComplete, true);
    assert.equal(mixedFirstStatus.eventsAdded, 6, "mixed events added");
    assert.equal(mixedFirstStatus.audit.decisionRecord.admittedRows, 5);
    assert.equal(mixedFirstStatus.audit.decisionRecord.atomicRows, 5);
    assert.equal(mixedFirstStatus.audit.decisionRecord.completeRows, 5);
    assert.equal(mixedFirstStatus.audit.decisionRecord.failedRows, 0);
    assert.equal(mixedFirstDecisions.length, 5, "mixed decision count");
    assert.equal(mixedFirstExclusions.length, 1, "mixed exclusion count");
    assert.equal(
      mixedFirstExclusions[0].sourceMatchId,
      "deadline-batch-6",
      "marketless match exclusion",
    );
    assert.ok(
      mixedFirstExclusions[0].blockers.includes(
        "same-decision-devigged-market-missing",
      ),
      "marketless match records the missing same-decision market evidence",
    );
    assert.equal(
      mixedFirstExclusions[0].primaryExclusionReason,
      "official-had-market-not-published",
    );
    assert.equal(
      mixedFirstExclusions[0].marketState,
      "official-had-market-not-published",
    );
    assert.equal(
      new Set(mixedFirstDecisions.map((event) => event.sourceMatchId)).size,
      5,
    );
    assert.equal(
      mixedFirstDecisions.every((event) => atomicDecisionRecordValid(event)),
      true,
    );
    assert.equal(mixedFirstStatus.readiness.readyNow, 5);
    assert.equal(mixedFirstStatus.readiness.atomicReadyNow, 5);
    assert.equal(mixedFirstStatus.readiness.awaitingMarket, 0);
    assert.equal(mixedFirstStatus.readiness.blocked, 0);
    assert.equal(mixedFirstStatus.readiness.excluded, 1);
    assert.equal(
      mixedFirstStatus.readiness.rows.find(
        (row) => row.sourceMatchId === "deadline-batch-6",
      )?.marketState,
      "official-had-market-not-published",
    );
    assert.equal(
      mixedFirstStatus.readiness.nearestDeadlineAt,
      null,
      "nearest deadline ignores terminal decisions and exclusions",
    );
    assert.equal(mixedFirstStatus.readiness.nearestFinalizationAt, null);
    assert.equal(mixedFirstStatus.readiness.nearestStatus, null);
    assert.equal(
      mixedFirstStatus.readiness.excludedReasonCounts[
        "same-decision-devigged-market-missing"
      ],
      1,
    );
    assert.equal(
      mixedFirstStatus.readiness.blockerCounts[
        "same-decision-devigged-market-missing"
      ] || 0,
      0,
      "terminal exclusion blockers do not pollute operational blockers",
    );
    assert.equal(mixedFirstStatus.readiness.readyInvariantOk, true);
    assert.equal(mixedFirstStatus.readiness.deadlineBatches.length, 2);
    assert.deepEqual(
      mixedFirstStatus.readiness.deadlineBatches.map((batch) => ({
        deadlineAt: batch.deadlineAt,
        phase: batch.phase,
        totalMatches: batch.totalMatches,
        actionableMatches: batch.actionableMatches,
        readyNow: batch.readyNow,
        excluded: batch.excluded,
        terminalDecisions: batch.terminalDecisions,
        terminalExclusions: batch.terminalExclusions,
        duplicateTerminalEvents: batch.duplicateTerminalEvents,
        terminalKeysWithDuplicates: batch.terminalKeysWithDuplicates,
        pendingMatches: batch.pendingMatches,
        dueUnrecorded: batch.dueUnrecorded,
        readyDueUnrecorded: batch.readyDueUnrecorded,
        invariantOk: batch.invariantOk,
      })),
      [
        {
          deadlineAt: "2026-07-27T00:44:00.000Z",
          phase: "post-finalization",
          totalMatches: 1,
          actionableMatches: 0,
          readyNow: 0,
          excluded: 1,
          terminalDecisions: 0,
          terminalExclusions: 1,
          duplicateTerminalEvents: 0,
          terminalKeysWithDuplicates: 0,
          pendingMatches: 0,
          dueUnrecorded: 0,
          readyDueUnrecorded: 0,
          invariantOk: true,
        },
        {
          deadlineAt: "2026-07-27T00:45:00.000Z",
          phase: "post-finalization",
          totalMatches: 5,
          actionableMatches: 5,
          readyNow: 5,
          excluded: 0,
          terminalDecisions: 5,
          terminalExclusions: 0,
          duplicateTerminalEvents: 0,
          terminalKeysWithDuplicates: 0,
          pendingMatches: 0,
          dueUnrecorded: 0,
          readyDueUnrecorded: 0,
          invariantOk: true,
        },
      ],
    );
    assert.equal(
      mixedFirstStatus.readiness.nearestDeadlineBatch,
      null,
      "fully terminal deadline batches are not projected as nearest",
    );
    assert.equal(verifyRegistry(mixedFirstRegistry).valid, true);
    const mixedFirstRootHash = mixedFirstLedger.rootHash;

    const mixedRepeated = runMixedCapture("2026-07-27T00:47:45.000Z");
    assert.equal(
      mixedRepeated.status,
      0,
      mixedRepeated.stderr || mixedRepeated.stdout,
    );
    const mixedRepeatedStatus = JSON.parse(fs.readFileSync(mixedStatusFile, "utf8"));
    const mixedRepeatedRegistry = JSON.parse(
      fs.readFileSync(mixedRegistryFile, "utf8"),
    );
    const mixedRepeatedLedger = mixedRepeatedRegistry.ledgers.find(
      (ledger) => ledger.ledgerId === mixedRepeatedRegistry.activeLedgerId,
    );
    assert.equal(mixedRepeatedStatus.dueMatches, 0);
    assert.equal(mixedRepeatedStatus.dueCaptureEventsAdded, 0);
    assert.equal(mixedRepeatedStatus.dueDecisionEventsAdded, 0);
    assert.equal(mixedRepeatedStatus.dueExclusionEventsAdded, 0);
    assert.equal(mixedRepeatedStatus.dueAtomicDecisionEventsAdded, 0);
    assert.equal(mixedRepeatedStatus.dueCaptureComplete, true);
    assert.equal(mixedRepeatedStatus.dueAtomicComplete, true);
    assert.equal(mixedRepeatedStatus.eventsAdded, 0);
    assert.equal(
      mixedRepeatedLedger.events.filter((event) => event.type === "decision").length,
      5,
    );
    assert.equal(
      mixedRepeatedLedger.events.filter((event) => event.type === "exclusion").length,
      1,
    );
    assert.equal(mixedRepeatedLedger.rootHash, mixedFirstRootHash);
    assert.equal(
      mixedRepeatedStatus.readiness.deadlineBatches
        .every((batch) => (
          batch.invariantOk
          && batch.dueUnrecorded === 0
          && batch.readyDueUnrecorded === 0
          && batch.duplicateTerminalEvents === 0
          && batch.terminalKeysWithDuplicates === 0
        )),
      true,
    );
    assert.equal(verifyRegistry(mixedRepeatedRegistry).valid, true);
  } finally {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }
});

check("implementation drift is rejected until the full backtest freezes a new revision", () => {
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const drifted = updateCandidateProspectiveLedger({
    priorRegistry: registry,
    candidates: [baseline, candidate],
    selectedCandidate: candidate,
    robustness: null,
    matches: [],
    snapshots: [],
    evaluatedAt: "2026-07-27T03:03:00.000Z",
    implementationCommitment: {
      ...implementationCommitment,
      sourceHashes: {
        ...implementationCommitment.sourceHashes,
        "scripts/missing-after-release.cjs": "9".repeat(64),
      },
    },
    trustedCollectorCount: 2,
  });
  assert.equal(drifted.chainValid, true);
  writeJson(registryFile, drifted.registry);
  const invalidResult = runCapture("2026-07-27T03:03:00.000Z");
  assert.equal(invalidResult.status, 0, invalidResult.stderr || invalidResult.stdout);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.reason, "candidate-implementation-drift-awaiting-refreeze");
  assert.ok(status.blockers.includes("source-hash-mismatch:scripts/missing-after-release.cjs"));
});

fs.rmSync(tempDir, { recursive: true, force: true });

const ok = checks.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  verifier: "candidate-prospective-deadline-capture",
    assertions: checks.length,
  checks,
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);
