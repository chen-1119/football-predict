"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  SETTLEMENT_RECORD_VERSION,
  appendEvent,
  buildDecisionEvent,
  candidateEvaluatorSemanticHashes,
  sha256,
} = require("./candidateProspectiveLedger.cjs");
const {
  BONFERRONI_THRESHOLD,
  EXACT_ARMS,
  G2_ALPHA,
  PLAN_VERSION,
  PRIMARY_HYPOTHESIS_COUNT,
  PUBLIC_AUDIT_VERSION,
  RESAMPLING_ITERATIONS,
  SUITE_VERSION,
  TERMINAL_EVALUATOR_VERSION,
  appendTerminalJudgment,
  buildCommonCohortShadowG2Plan,
  compactCommonCohortShadowG2Public,
  evaluateFrozenTerminalRows,
  evaluateTerminalProtocol,
  inputEligibilityFor,
  resetTerminalVerificationCache,
  settleCommonCohortShadowG2Suite,
  suiteRootHash,
  terminalVerificationCacheStats,
  updateCommonCohortShadowG2Suite,
  verifyCommonCohortShadowG2Suite,
} = require("./candidateCommonCohortShadowG2.cjs");

const implementationCommitment = {
  commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  semanticHashes: candidateEvaluatorSemanticHashes(),
};

const activeLedger = {
  rootHash: "a".repeat(64),
  header: {
    candidateRevisionId: "market-current-model-residual-minus-20-temperature-0_9@g2-source",
    candidateDefinition: EXACT_ARMS[0].candidate,
    candidateImplementation: implementationCommitment,
  },
};

const match = ({
  sourceMatchId,
  businessDate,
  kickoffTime,
  buyEndTime,
  source = "sporttery",
  status = "SCHEDULED",
  scoreHome = null,
  scoreAway = null,
  resultObservedAt = null,
  league = "英超",
}) => ({
  id: `${source === "sporttery" ? "sporttery" : "fivehundred"}_${sourceMatchId}`,
  sourceMatchId,
  source,
  businessDate,
  league,
  competition: { name: league },
  sourceUrl: source === "sporttery"
    ? "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry"
    : "https://trade.500.com/",
  kickoffTime,
  eventVersion: kickoffTime,
  buyEndTime,
  status,
  scoreHome,
  scoreAway,
  resultObservedAt,
  resultProvenance: status === "FINISHED" ? {
    version: "result-provenance-v2",
    official: true,
    trusted: true,
    provider: "sporttery",
    source: "sporttery",
    sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry",
    sourceMatchId,
    sourceStatus: "FINISHED",
    scoreHome,
    scoreAway,
    kickoffTime,
    observedAt: resultObservedAt,
    observationSource: "sporttery-relay-result-observed-at",
    resultObservationFallback: false,
    promotionEligible: true,
    eventVersion: kickoffTime,
  } : null,
});

const strictSnapshot = ({
  sourceMatchId,
  kickoffTime,
  capturedAt,
  modelProbabilities = { "1": 0.59, X: 0.25, "2": 0.16 },
}) => ({
  id: `sporttery_${sourceMatchId}`,
  matchId: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  source: "sporttery",
  kickoffTime,
  capturedAt,
  firstSeenAt: capturedAt,
  sourceCycleId: `cycle-${sourceMatchId}`,
  modelGeneratedAt: capturedAt,
  policyVersion: "prediction-policy-g2-test-v1",
  promptVersion: "prediction-prompt-g2-test-v1",
  modelVersion: "prediction-model-g2-test-v1",
  calibrationVersion: "prediction-calibration-g2-test-v1",
  best: { tipCode: "1", oddsPoolCode: "HAD", odds: 1.8, recommendationAction: "reference" },
  oneXTwo: { tipCode: "1", oddsPoolCode: "HAD", odds: 1.8, recommendationAction: "reference" },
  featureSnapshot: {
    version: "prediction-feature-snapshot-g2-test-v1",
    capturedAt,
    modelGeneratedAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    modelVersion: "prediction-model-g2-test-v1",
    calibrationVersion: "prediction-calibration-g2-test-v1",
    modelInputs: {
      market: { home: 0.510729613734, draw: 0.270386266094, away: 0.218884120172 },
      oneXTwoFinal: {
        home: modelProbabilities["1"],
        draw: modelProbabilities.X,
        away: modelProbabilities["2"],
      },
    },
  },
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    sourceMatchId,
    matchId: `sporttery_${sourceMatchId}`,
    kickoffTime,
    capturedAt,
    decisionAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    policyVersion: "prediction-policy-g2-test-v1",
    promptVersion: "prediction-prompt-g2-test-v1",
    modelVersion: "prediction-model-g2-test-v1",
    calibrationVersion: "prediction-calibration-g2-test-v1",
    sourceTimestamps: { modelGeneratedAt: capturedAt },
    clockAudit: { version: "decision-clock-audit-v1", eligible: true, blockers: [] },
    probabilities: {
      HAD: modelProbabilities,
      HHAD: { line: -1, outcomes: { "1": 0.39, X: 0.31, "2": 0.3 } },
    },
    markets: {
      HAD: {
        odds: { "1": 1.8, X: 3.4, "2": 4.2 },
        marketProbabilities: { "1": 0.510729613734, X: 0.270386266094, "2": 0.218884120172 },
        observedAt: capturedAt,
        receivedAt: capturedAt,
        provenanceHash: "4".repeat(64),
        provenance: {
          hash: "4".repeat(64),
          strict: {
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
        marketProbabilities: { "1": 0.364623739333, X: 0.255236617533, "2": 0.380139643134 },
        observedAt: capturedAt,
        receivedAt: capturedAt,
        provenanceHash: "7".repeat(64),
        provenance: {
          hash: "7".repeat(64),
          strict: {
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "8".repeat(64) },
        },
      },
    },
    exposure: {
      shadowTracks: {
        HHAD_COMPANION: {
          selection: { code: "1", handicapLine: -1, odds: 2.45, modelProbability: 0.39, marketProbability: 0.364623739333 },
        },
      },
    },
  },
});

const createdAt = "2026-08-01T04:00:00.000Z";
const plan = buildCommonCohortShadowG2Plan({ activeLedger, evaluatedAt: createdAt });
const oldRows = Array.from({ length: 4 }, (_, index) => {
  const kickoffHour = String(index + 8).padStart(2, "0");
  const cutoffHour = String(index + 7).padStart(2, "0");
  return match({
    sourceMatchId: `old-${index + 1}`,
    businessDate: "2026-07-31",
    kickoffTime: `2026-08-01T${kickoffHour}:00:00.000Z`,
    buyEndTime: `2026-08-01T${cutoffHour}:30:00.000Z`,
  });
});
const future = match({
  sourceMatchId: "g2-future-1",
  businessDate: "2026-08-02",
  kickoffTime: "2026-08-02T12:00:00.000Z",
  buyEndTime: "2026-08-02T11:00:00.000Z",
});
const snapshot = strictSnapshot({
  sourceMatchId: future.sourceMatchId,
  kickoffTime: future.kickoffTime,
  capturedAt: "2026-08-02T10:58:00.000Z",
});

const checks = [];
const check = (name, callback) => {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error?.message || String(error) });
  }
};

const collectPathLikeKeys = (value, location = "$", found = []) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPathLikeKeys(item, `${location}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    const nextLocation = `${location}.${key}`;
    if (/path/i.test(key)) found.push(nextLocation);
    collectPathLikeKeys(nested, nextLocation, found);
  }
  return found;
};

check("deadline heartbeat owns an isolated G2 artifact and settlement-first capture path", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "captureCandidateProspectiveDeadline.cjs"),
    "utf8",
  );
  assert.match(source, /CANDIDATE_COMMON_COHORT_SHADOW_G2_FILE/);
  assert.match(source, /CANDIDATE_COMMON_COHORT_SHADOW_G2_V2_FILE/);
  assert.match(source, /candidate-common-cohort-shadow-g2\.json/);
  assert.match(source, /candidate-common-cohort-shadow-g2-v2\.json/);
  assert.match(source, /legacyCommonCohortG2V1SuiteFile/);
  assert.match(source, /const priorSuite = readJson\(commonCohortG2SuiteFile, null\)/);
  assert.doesNotMatch(source, /readJson\(legacyCommonCohortG2V1SuiteFile/);
  assert.doesNotMatch(source, /writeJsonAtomic\(legacyCommonCohortG2V1SuiteFile/);
  assert.match(source, /settleCommonCohortG2\(\{ matches \}\)/);
  assert.match(source, /\.\.\.commonCohortG2DueMatchRows/);
  assert.match(source, /evidenceQueryComplete:\s*commonCohortG2EvidenceQueryComplete/);
  assert.match(source, /commonCohortG2,/);
});

check("server and signed-release paths expose and preserve the isolated G2 artifact", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server", "index.cjs"), "utf8");
  const bundle = fs.readFileSync(path.join(__dirname, "createReleaseBundle.cjs"), "utf8");
  const release = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "light-server", "release-from-bundle.sh"),
    "utf8",
  );
  const recovery = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "light-server", "football-release-recovery.cjs"),
    "utf8",
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(server, /compactCommonCohortShadowG2Public/);
  assert.match(server, /commonCohortG2:\s*publicCommonCohortG2/);
  assert.match(server, /includesCandidateCommonCohortG2/);
  assert.match(bundle, /scripts\/candidateCommonCohortShadowG2\.cjs/);
  assert.match(bundle, /scripts\/verifyCandidateCommonCohortShadowG2\.cjs/);
  assert.match(release, /candidate-common-cohort-shadow-g2\.json/);
  assert.match(release, /candidate-common-cohort-shadow-g2-v2\.json/);
  assert.match(release, /candidate-common-cohort-g2-v1/);
  assert.match(release, /candidate-common-cohort-g2-v2/);
  assert.match(recovery, /candidate-common-cohort-shadow-g2\.json/);
  assert.match(recovery, /candidate-common-cohort-shadow-g2-v2\.json/);
  assert.match(pkg.scripts["verify:production"], /verifyCandidateCommonCohortShadowG2\.cjs/);
});

check("G2 freezes six promotable arms and one permanent market control", () => {
  assert.equal(SUITE_VERSION, "candidate-common-cohort-shadow-g2-v2");
  assert.equal(PLAN_VERSION, "candidate-common-cohort-shadow-g2-plan-v2");
  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.onlineEffect, false);
  assert.equal(plan.arms.length, 7);
  assert.equal(plan.arms.filter((arm) => arm.promotable).length, 6);
  assert.equal(plan.arms.filter((arm) => !arm.promotable).length, 1);
  assert.equal(plan.arms.at(-1).candidate.id, "market-temperature-1-control");
  assert.equal(plan.arms.at(-1).promotionPolicy, "never-promote-control-arm");
});

check("G2 activates at one future Shanghai business-day boundary", () => {
  assert.equal(plan.createdAt, createdAt);
  assert.equal(plan.activationBusinessDate, "2026-08-02");
  assert.equal(plan.activationAt, "2026-08-01T16:00:00.000Z");
  assert.equal(plan.windows.length, 6);
  assert.equal(plan.windows[0].startBusinessDate, "2026-08-02");
  assert.equal(plan.windows[5].endBusinessDateExclusive, "2027-01-29");
});

check("G2 allocates alpha once and freezes the exact Bonferroni threshold", () => {
  assert.equal(plan.inference.familyAlpha, G2_ALPHA);
  assert.equal(plan.inference.primaryHypothesisCount, PRIMARY_HYPOTHESIS_COUNT);
  assert.equal(plan.inference.perHypothesisThreshold, BONFERRONI_THRESHOLD);
  assert.ok(Math.abs(BONFERRONI_THRESHOLD - 0.0020833333333333333) < 1e-15);
  assert.equal(plan.inference.resampling.iterations, RESAMPLING_ITERATIONS);
  assert.equal(plan.inference.resampling.resultBeforeTerminal, null);
});

check("G2 freezes the full terminal, generalization and leakage-safe prerequisites", () => {
  assert.equal(plan.settlementGraceDays, 14);
  assert.equal(plan.terminalEligibleBusinessDate, "2027-02-12");
  assert.equal(plan.gates.maximumSingleLeagueSharePerWindow, 0.5);
  assert.equal(plan.gates.minimumPositiveQualifiedLeagueShare, 0.75);
  assert.equal(plan.gates.requiredAtomicDecisionCoverage, 1);
  assert.equal(plan.gates.requiredSettlementCoverage, 1);
  assert.equal(plan.gates.requiredSourceClockCoverage, 1);
  assert.equal(
    plan.gates.perArmTerminalMetricGate.minimumDualMetricWinningWindows,
    5,
  );
  assert.equal(
    plan.gates.perArmTerminalMetricGate
      .requireBonferroniAdjustedOneSidedBrierLowerBoundAboveZero,
    true,
  );
  assert.equal(
    plan.gates.perArmTerminalMetricGate
      .requireBonferroniAdjustedOneSidedLogLossLowerBoundAboveZero,
    true,
  );
  assert.equal(plan.leakageSafeWalkForward.warmupRows, 100);
  assert.equal(plan.leakageSafeWalkForward.validationWindows, 6);
  assert.equal(plan.leakageSafeWalkForward.minimumRowsPerValidationWindow, 50);
  assert.equal(plan.leakageSafeWalkForward.minimumRowsIncludingWarmup, 400);
  assert.equal(plan.terminalPolicy.requireSettlementGraceElapsed, true);
});

check("all four legacy rows and every 500 reference row are excluded before all G2 ledgers", () => {
  const reference = match({
    sourceMatchId: "fivehundred-only",
    source: "five-hundred",
    businessDate: "2026-08-02",
    kickoffTime: "2026-08-02T13:00:00.000Z",
    buyEndTime: "2026-08-02T12:00:00.000Z",
  });
  const audit = inputEligibilityFor({ plan, matches: [...oldRows, future, reference] });
  assert.equal(audit.eligibleMatches, 1);
  assert.equal(audit.excludedPreActivationDeadline, 4);
  assert.equal(audit.excludedReferenceOrNonOfficial, 1);
});

const initial = updateCommonCohortShadowG2Suite({
  plan,
  matches: [...oldRows, future],
  snapshots: [snapshot],
  evaluatedAt: createdAt,
  trustedCollectorCount: 2,
});

check("an old worker v1 artifact cannot block or be overwritten by isolated v2 registration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-g2-isolation-"));
  const legacyFile = path.join(tempDir, "candidate-common-cohort-shadow-g2.json");
  const v2File = path.join(tempDir, "candidate-common-cohort-shadow-g2-v2.json");
  try {
    const legacyArtifact = {
      version: "candidate-common-cohort-shadow-g2-v1",
      header: {
        frozenPlan: {
          version: "candidate-common-cohort-shadow-g2-plan-v1",
          inference: {
            resampling: {
              version: "candidate-common-business-day-resampling-v1",
              iterations: RESAMPLING_ITERATIONS,
            },
          },
          leakageSafeWalkForward: {
            version: "candidate-common-cohort-g2-leakage-safe-walk-forward-v1",
          },
        },
      },
      rootHash: "b".repeat(64),
    };
    const legacyBytes = Buffer.from(JSON.stringify(legacyArtifact, null, 2));
    fs.writeFileSync(legacyFile, legacyBytes);

    // The v2 path intentionally starts without a prior suite. Old v1 bytes are
    // never offered to the v2 verifier/updater, matching the deadline worker.
    const isolatedV2 = updateCommonCohortShadowG2Suite({
      plan,
      matches: oldRows,
      snapshots: [],
      evaluatedAt: createdAt,
      trustedCollectorCount: 2,
    });
    fs.writeFileSync(v2File, JSON.stringify(isolatedV2.suite, null, 2));

    assert.notEqual(legacyFile, v2File);
    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes);
    assert.equal(JSON.parse(fs.readFileSync(legacyFile, "utf8")).version,
      "candidate-common-cohort-shadow-g2-v1");
    const persistedV2 = JSON.parse(fs.readFileSync(v2File, "utf8"));
    assert.equal(isolatedV2.chainValid, true);
    assert.equal(persistedV2.version, SUITE_VERSION);
    assert.equal(persistedV2.header.frozenPlan.version, PLAN_VERSION);
    assert.equal(persistedV2.journal.length, 0);
    assert.deepEqual(
      verifyCommonCohortShadowG2Suite(persistedV2),
      { valid: true, blockers: [] },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

check("G2 owns seven isolated registries without importing legacy terminal rows", () => {
  assert.equal(initial.chainValid, true);
  assert.equal(initial.suite.version, SUITE_VERSION);
  assert.equal(initial.suite.trials.length, 7);
  assert.equal(initial.suite.journal.length, 0);
  assert.equal(initial.suite.alphaLedger.events.length, 1);
  assert.equal(initial.suite.alphaLedger.events[0].reclaimable, false);
  assert.deepEqual(verifyCommonCohortShadowG2Suite(initial.suite), { valid: true, blockers: [] });
});

const captured = updateCommonCohortShadowG2Suite({
  priorSuite: initial.suite,
  matches: [future],
  snapshots: [snapshot],
  evaluatedAt: "2026-08-02T11:03:00.000Z",
  trustedCollectorCount: 2,
});

check("one due match creates one common journal row and one atomic row in every arm", () => {
  assert.equal(captured.chainValid, true);
  assert.equal(captured.suite.journal.length, 1);
  assert.equal(captured.suite.journal[0].type, "cohort-terminal");
  assert.equal(Object.keys(captured.suite.journal[0].trialEventHashes).length, 7);
  for (const trial of captured.suite.trials) {
    const ledger = trial.registry.ledgers.find((row) => row.ledgerId === trial.registry.activeLedgerId);
    assert.equal(ledger.events.filter((event) => event.type === "decision").length, 1);
    assert.equal(ledger.events.filter((event) => event.type === "exclusion").length, 0);
  }
});

const repeated = updateCommonCohortShadowG2Suite({
  priorSuite: captured.suite,
  matches: [future],
  snapshots: [snapshot],
  evaluatedAt: "2026-08-02T11:04:00.000Z",
  trustedCollectorCount: 2,
});

check("repeated heartbeats are root-stable and never duplicate a common decision", () => {
  assert.equal(repeated.changed, false);
  assert.equal(repeated.suite.rootHash, captured.suite.rootHash);
  assert.equal(repeated.suite.journal.length, 1);
});

const finished = match({
  ...future,
  sourceMatchId: future.sourceMatchId,
  businessDate: future.businessDate,
  kickoffTime: future.kickoffTime,
  buyEndTime: future.buyEndTime,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  resultObservedAt: "2026-08-02T14:05:00.000Z",
});
const settled = settleCommonCohortShadowG2Suite({
  priorSuite: repeated.suite,
  matches: [finished],
  evaluatedAt: "2026-08-02T14:06:00.000Z",
});

check("one official result creates one common settlement row shared by all seven arms", () => {
  assert.equal(settled.chainValid, true);
  assert.equal(settled.settlementsAdded, 7);
  assert.equal(settled.suite.journal.length, 2);
  assert.equal(settled.suite.journal[1].type, "cohort-settlement");
  assert.equal(Object.keys(settled.suite.journal[1].trialSettlementHashes).length, 7);
  assert.equal(settled.audit.cohort.settledRows, 1);
  assert.equal(settled.audit.terminal.formalPromotionEligible, false);
  assert.equal(settled.audit.terminal.terminalEvaluatorImplemented, true);
  assert.equal(settled.audit.terminal.leakageSafeWalkForwardExecuted, false);
  assert.equal(settled.audit.inference.resampling.executed, false);
  assert.equal(settled.audit.inference.resampling.result, null);
});

check("public audit is explicit about zero online effect and pending terminal evidence", () => {
  const projected = compactCommonCohortShadowG2Public(settled.audit);
  assert.equal(projected.version, PUBLIC_AUDIT_VERSION);
  assert.equal(projected.onlineEffect, false);
  assert.equal(projected.trialCount, 7);
  assert.equal(projected.controlArmPromotionEligible, false);
  assert.equal(projected.terminal.judgmentRecorded, false);
  assert.equal(projected.inference.resampling.executed, false);
  assert.equal(projected.artifactGeneration, "G2-v2");
  assert.equal(projected.artifactNamespaceVersion, "v2");
  assert.equal(Object.hasOwn(projected, "artifactPathVersion"), false);
  assert.deepEqual(collectPathLikeKeys(projected), []);
  assert.equal(projected.legacyV1IgnoredForV2, true);
});

const syntheticWindowCounts = [84, 84, 83, 83, 83, 83];
const syntheticCommonRows = [];
let syntheticIndex = 0;
for (const [windowIndex, count] of syntheticWindowCounts.entries()) {
  const window = plan.windows[windowIndex];
  const startMillis = Date.parse(`${window.startBusinessDate}T00:00:00Z`);
  const businessDates = [2, 8, 14, 20].map((offset) => (
    new Date(startMillis + offset * 86400000).toISOString().slice(0, 10)
  ));
  for (let index = 0; index < count; index += 1) {
    const businessDate = businessDates[index % businessDates.length];
    syntheticCommonRows.push({
      identityHash: sha256(`g2-terminal-row-${syntheticIndex}`),
      businessDate,
      kickoffAt: `${businessDate}T12:00:00.000Z`,
      league: `league-${syntheticIndex % 10}`,
      actual: "1",
      decisionEventHash: sha256(`g2-decision-${syntheticIndex}`),
      settlementEventHash: sha256(`g2-settlement-${syntheticIndex}`),
      candidateLogLoss: 0.4,
      marketLogLoss: 0.42,
      candidateBrier: 0.3,
      marketBrier: 0.33,
      logLossImprovement: 0.02 + (syntheticIndex % 3) * 0.0001,
      brierImprovement: 0.03 + (syntheticIndex % 5) * 0.0001,
    });
    syntheticIndex += 1;
  }
}
syntheticCommonRows.sort((left, right) => (
  left.businessDate.localeCompare(right.businessDate)
  || left.identityHash.localeCompare(right.identityHash)
));
const syntheticRowsByCandidate = Object.fromEntries(plan.arms.map((arm) => [
  arm.candidate.id,
  syntheticCommonRows.map((row) => arm.promotable ? row : {
    ...row,
    candidateLogLoss: row.marketLogLoss,
    candidateBrier: row.marketBrier,
    logLossImprovement: 0,
    brierImprovement: 0,
  }),
]));
const syntheticDatasetHash = sha256({
  version: TERMINAL_EVALUATOR_VERSION,
  identities: syntheticCommonRows.map((row) => row.identityHash),
});
const syntheticTerminal = evaluateFrozenTerminalRows({
  plan,
  rowsByCandidate: syntheticRowsByCandidate,
  datasetHash: syntheticDatasetHash,
});

check("100k clustered resampling reuses one common business-day draw schedule for all 12 hypotheses", () => {
  assert.equal(syntheticTerminal.version, TERMINAL_EVALUATOR_VERSION);
  assert.equal(syntheticTerminal.resamplingExecuted, true);
  assert.equal(syntheticTerminal.primaryHypothesesEvaluated, 12);
  const promotable = syntheticTerminal.candidateResults.filter((row) => row.promotable);
  assert.equal(promotable.length, 6);
  const endpoints = promotable.flatMap((row) => [row.resampling.brier, row.resampling.logLoss]);
  assert.equal(endpoints.length, 12);
  assert.equal(new Set(endpoints.map((row) => row.seedCommitment)).size, 1);
  assert.equal(new Set(endpoints.map((row) => row.drawScheduleHash)).size, 1);
  for (const endpoint of endpoints) {
    assert.equal(endpoint.iterations, RESAMPLING_ITERATIONS);
    assert.equal(endpoint.bonferroniThreshold, BONFERRONI_THRESHOLD);
    assert.ok(endpoint.bonferroniAdjustedOneSidedLowerBound > 0);
    assert.ok(endpoint.oneSidedPValue <= BONFERRONI_THRESHOLD);
    assert.equal(endpoint.pass, true);
  }
  assert.equal(syntheticTerminal.eligibleCandidateIds.length, 6);
  assert.equal(syntheticTerminal.formalPromotionEligible, true);
});

check("walk-forward keeps every Sporttery business day atomic across warmup and six validation windows", () => {
  for (const result of syntheticTerminal.candidateResults.filter((row) => row.promotable)) {
    const walkForward = result.walkForward;
    assert.equal(walkForward.executed, true);
    assert.equal(walkForward.businessDayAtomicityVerified, true);
    assert.equal(walkForward.validationWindows.length, 6);
    assert.ok(walkForward.warmupRows >= 100);
    let previousMax = walkForward.warmupEndBusinessDate;
    for (const window of walkForward.validationWindows) {
      assert.ok(window.validationRows >= 50);
      assert.equal(window.strictTemporalSeparation, true);
      assert.ok(window.trainingMaxBusinessDate < window.validationMinBusinessDate);
      assert.ok(previousMax < window.validationMinBusinessDate);
      previousMax = window.validationMaxBusinessDate;
    }
    assert.equal(walkForward.pass, true);
  }
});

check("terminal evaluator remains fail-closed before the frozen common cohort is complete", () => {
  const incomplete = evaluateTerminalProtocol({
    suite: settled.suite,
    evaluatedAt: "2027-02-12T00:00:00.000Z",
  });
  assert.equal(incomplete.executionReady, false);
  assert.equal(incomplete.executed, false);
  assert.equal(incomplete.resamplingExecuted, false);
  assert.ok(incomplete.prerequisiteBlockers.some((reason) => reason.includes("settled:1<500")));
  const clone = structuredClone(settled.suite);
  const rootBefore = clone.rootHash;
  const rejected = appendTerminalJudgment({
    suite: clone,
    evaluation: incomplete,
    evaluatedAt: "2027-02-12T00:00:00.000Z",
  });
  assert.equal(rejected.changed, false);
  assert.equal(clone.rootHash, rootBefore);
  assert.equal(clone.terminalJudgment, null);
});

const runFullTerminalRegression = process.argv.includes("--full-terminal");
if (runFullTerminalRegression) {
let completedTerminalSuite = null;
let completedFinishedMatches = null;
check("500 aligned formal rows append exactly one valid immutable terminal judgment", () => {
  const terminalMatches = [];
  const terminalSnapshots = [];
  for (const [index, template] of syntheticCommonRows.entries()) {
    const sourceMatchId = `g2-terminal-${String(index + 1).padStart(4, "0")}`;
    terminalMatches.push(match({
      sourceMatchId,
      businessDate: template.businessDate,
      kickoffTime: `${template.businessDate}T12:00:00.000Z`,
      buyEndTime: `${template.businessDate}T11:00:00.000Z`,
      league: template.league,
    }));
    terminalSnapshots.push(strictSnapshot({
      sourceMatchId,
      kickoffTime: `${template.businessDate}T12:00:00.000Z`,
      capturedAt: `${template.businessDate}T10:58:00.000Z`,
      modelProbabilities: { "1": 0.35, X: 0.3, "2": 0.35 },
    }));
  }
  const prepopulatedSuite = structuredClone(initial.suite);
  for (const trial of prepopulatedSuite.trials) {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    for (const [index, terminalMatch] of terminalMatches.entries()) {
      const decision = buildDecisionEvent({
        ledger,
        match: terminalMatch,
        snapshot: terminalSnapshots[index],
        evaluatedAt: `${terminalMatch.businessDate}T11:03:00.000Z`,
        phase: "formal",
        trustedCollectorCount: 2,
      });
      assert.equal(decision.type, "decision");
      appendEvent(ledger, decision);
    }
  }
  prepopulatedSuite.updatedAt = "2027-01-25T00:00:00.000Z";
  prepopulatedSuite.rootHash = suiteRootHash(prepopulatedSuite);
  assert.deepEqual(
    verifyCommonCohortShadowG2Suite(prepopulatedSuite),
    { valid: true, blockers: [] },
  );
  const terminalCaptured = updateCommonCohortShadowG2Suite({
    priorSuite: prepopulatedSuite,
    matches: terminalMatches,
    snapshots: terminalSnapshots,
    evaluatedAt: "2027-01-25T00:00:00.000Z",
    trustedCollectorCount: 2,
  });
  assert.equal(terminalCaptured.chainValid, true);
  assert.equal(terminalCaptured.suite.journal.length, 500);
  completedFinishedMatches = terminalMatches.map((row) => match({
    sourceMatchId: row.sourceMatchId,
    businessDate: row.businessDate,
    kickoffTime: row.kickoffTime,
    buyEndTime: row.buyEndTime,
    league: row.league,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultObservedAt: `${row.businessDate}T15:00:00.000Z`,
  }));
  const prepopulatedSettlementSuite = structuredClone(terminalCaptured.suite);
  for (const trial of prepopulatedSettlementSuite.trials) {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    for (const decision of ledger.events.filter((event) => event.type === "decision")) {
      const resultObservedAt = `${decision.kickoffAt.slice(0, 10)}T15:00:00.000Z`;
      const settlementEvidence = {
        version: SETTLEMENT_RECORD_VERSION,
        provider: "sporttery",
        sourceMatchId: decision.sourceMatchId,
        eventVersion: decision.kickoffAt,
        kickoffAt: decision.kickoffAt,
        observedAt: resultObservedAt,
        scoreHome: 2,
        scoreAway: 0,
        provenanceVersion: "result-provenance-v2",
        observationSource: "sporttery-relay-result-observed-at",
        official: true,
        trusted: true,
        promotionEligible: true,
        resultObservationFallback: false,
      };
      appendEvent(ledger, {
        type: "settlement",
        recordedAt: "2027-02-12T00:00:00.000Z",
        phase: decision.phase,
        decisionEventHash: decision.eventHash,
        candidateRevisionId: ledger.header.candidateRevisionId,
        matchId: decision.matchId,
        sourceMatchId: decision.sourceMatchId,
        market: "HAD",
        kickoffAt: decision.kickoffAt,
        resultObservedAt,
        resultProvider: "sporttery",
        resultSourceMatchId: decision.sourceMatchId,
        resultEventVersion: decision.kickoffAt,
        scoreHome: 2,
        scoreAway: 0,
        actual: "1",
        valid: true,
        settlementRecordVersion: SETTLEMENT_RECORD_VERSION,
        resultProvenanceVersion: "result-provenance-v2",
        resultObservationSource: "sporttery-relay-result-observed-at",
        resultOfficial: true,
        resultTrusted: true,
        resultPromotionEligible: true,
        resultObservationFallback: false,
        resultProvenanceHash: sha256(settlementEvidence),
        blockers: [],
        onlineEffect: false,
      });
    }
  }
  prepopulatedSettlementSuite.updatedAt = "2027-02-12T00:00:00.000Z";
  prepopulatedSettlementSuite.rootHash = suiteRootHash(prepopulatedSettlementSuite);
  const terminalSettled = settleCommonCohortShadowG2Suite({
    priorSuite: prepopulatedSettlementSuite,
    matches: [],
    evaluatedAt: "2027-02-12T00:00:00.000Z",
  });
  assert.equal(terminalSettled.chainValid, true);
  assert.equal(terminalSettled.settlementsAdded, 0);
  assert.equal(terminalSettled.suite.journal.length, 1001);
  assert.equal(terminalSettled.suite.journal.at(-1).type, "terminal-judgment");
  assert.equal(terminalSettled.suite.journal.at(-1).recomputationAllowed, false);
  assert.equal(terminalSettled.suite.terminalJudgment.executionReady, true);
  assert.equal(terminalSettled.suite.terminalJudgment.resamplingExecuted, true);
  assert.equal(
    terminalSettled.suite.terminalJudgment.primaryHypothesesEvaluated,
    PRIMARY_HYPOTHESIS_COUNT,
  );
  assert.equal(terminalSettled.suite.terminalJudgment.eligibleCandidateIds.length, 6);
  assert.equal(terminalSettled.audit.terminal.judgmentCount, 1);
  assert.equal(terminalSettled.audit.terminal.formalPromotionEligible, true);
  resetTerminalVerificationCache();
  assert.deepEqual(
    verifyCommonCohortShadowG2Suite(terminalSettled.suite),
    { valid: true, blockers: [] },
  );
  const coldStats = terminalVerificationCacheStats();
  assert.equal(coldStats.misses, 1);
  assert.equal(coldStats.deterministicRecomputations, 1);
  assert.deepEqual(
    verifyCommonCohortShadowG2Suite(terminalSettled.suite),
    { valid: true, blockers: [] },
  );
  const warmStats = terminalVerificationCacheStats();
  assert.equal(warmStats.hits, 1);
  assert.equal(warmStats.deterministicRecomputations, 1);
  completedTerminalSuite = terminalSettled.suite;
});

check("repeated post-terminal settlement is a root-stable no-op", () => {
  assert.ok(completedTerminalSuite);
  const rootBefore = completedTerminalSuite.rootHash;
  const journalLengthBefore = completedTerminalSuite.journal.length;
  const repeatedTerminal = settleCommonCohortShadowG2Suite({
    priorSuite: completedTerminalSuite,
    matches: completedFinishedMatches,
    evaluatedAt: "2027-02-12T00:05:00.000Z",
  });
  assert.equal(repeatedTerminal.chainValid, true);
  assert.equal(repeatedTerminal.changed, false);
  assert.equal(repeatedTerminal.settlementsAdded, 0);
  assert.equal(repeatedTerminal.suite.rootHash, rootBefore);
  assert.equal(repeatedTerminal.suite.journal.length, journalLengthBefore);
  assert.equal(
    repeatedTerminal.suite.journal.filter((event) => event.type === "terminal-judgment").length,
    1,
  );
});

check("self-consistent terminal metric rehash cannot bypass deterministic recomputation", () => {
  assert.ok(completedTerminalSuite);
  const tampered = structuredClone(completedTerminalSuite);
  tampered.terminalJudgment.candidateResults[0]
    .resampling.brier.bonferroniAdjustedOneSidedLowerBound += 0.01;
  tampered.terminalJudgmentHash = sha256(tampered.terminalJudgment);
  const terminalEvent = tampered.journal.at(-1);
  terminalEvent.judgmentHash = tampered.terminalJudgmentHash;
  const terminalBody = structuredClone(terminalEvent);
  delete terminalBody.eventHash;
  terminalEvent.eventHash = sha256(terminalBody);
  tampered.rootHash = suiteRootHash(tampered);
  const cacheBefore = terminalVerificationCacheStats();
  const verification = verifyCommonCohortShadowG2Suite(tampered);
  const cacheAfter = terminalVerificationCacheStats();
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes("G2-terminal-deterministic-recomputation-mismatch"));
  assert.equal(cacheAfter.misses, cacheBefore.misses + 1);
  assert.equal(
    cacheAfter.deterministicRecomputations,
    cacheBefore.deterministicRecomputations + 1,
  );
});
} else {
  check("full 500-row immutable-terminal regression is registered as an explicit release check", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert.match(
      pkg.scripts["verify:candidate-common-cohort-g2:terminal"],
      /verifyCandidateCommonCohortShadowG2\.cjs --full-terminal/,
    );
  });
}

check("tampering with a child ledger or alpha allocation invalidates the suite", () => {
  const childTamper = structuredClone(settled.suite);
  childTamper.trials[0].registry.ledgers[0].events[0].state = "TAMPERED";
  assert.equal(verifyCommonCohortShadowG2Suite(childTamper).valid, false);
  const alphaTamper = structuredClone(settled.suite);
  alphaTamper.alphaLedger.events[0].allocatedAlpha = 0.05;
  assert.equal(verifyCommonCohortShadowG2Suite(alphaTamper).valid, false);
});

const rehashSelfConsistentSuite = (suite) => {
  const planBody = structuredClone(suite.header.frozenPlan);
  delete planBody.planHash;
  suite.header.frozenPlan.planHash = sha256(planBody);
  suite.header.planHash = suite.header.frozenPlan.planHash;
  suite.alphaLedger.events[0].planHash = suite.header.planHash;
  const alphaBody = structuredClone(suite.alphaLedger.events[0]);
  delete alphaBody.eventHash;
  suite.alphaLedger.events[0].eventHash = sha256(alphaBody);
  suite.alphaLedger.rootHash = suite.alphaLedger.events[0].eventHash;
  suite.headerHash = sha256(suite.header);
  suite.rootHash = suiteRootHash(suite);
  return suite;
};

check("self-consistent rehashing cannot weaken any frozen G2 protocol gate", () => {
  const mutations = [
    (suite) => { suite.header.frozenPlan.settlementGraceDays = 0; },
    (suite) => { suite.header.frozenPlan.inference.resampling.iterations = 99999; },
    (suite) => {
      suite.header.frozenPlan.gates.perArmTerminalMetricGate
        .minimumDualMetricWinningWindows = 4;
    },
    (suite) => { suite.header.frozenPlan.inference.familyAlpha = 0.05; },
    (suite) => { suite.header.frozenPlan.leakageSafeWalkForward.warmupRows = 0; },
  ];
  for (const mutate of mutations) {
    const weakened = structuredClone(settled.suite);
    mutate(weakened);
    rehashSelfConsistentSuite(weakened);
    assert.equal(verifyCommonCohortShadowG2Suite(weakened).valid, false);
  }
});

const failed = checks.filter((row) => !row.ok);
console.log(JSON.stringify({
  verifier: "candidate-common-cohort-shadow-g2",
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
}, null, 2));
if (failed.length) process.exit(1);
