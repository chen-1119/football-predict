"use strict";

const {
  candidateInventory,
  canonicalize,
  decisionDeadlineFor,
  normalizedLeagueForMatch,
  sameCohortIdentity,
  settleCandidateProspectiveRegistry,
  sha256,
  updateCandidateProspectiveLedger,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");

const SUITE_VERSION = "candidate-common-cohort-shadow-g2-v2";
const PLAN_VERSION = "candidate-common-cohort-shadow-g2-plan-v2";
const AUDIT_VERSION = "candidate-common-cohort-shadow-g2-audit-v2";
const PUBLIC_AUDIT_VERSION = "candidate-common-cohort-shadow-g2-public-v2";
const INPUT_POLICY_VERSION = "candidate-common-cohort-shadow-g2-input-v2";
const JOURNAL_VERSION = "candidate-common-cohort-shadow-g2-journal-v2";
const ALPHA_LEDGER_VERSION = "candidate-cross-generation-alpha-ledger-v1";
const RESAMPLING_VERSION = "candidate-common-business-day-resampling-v2";
const TERMINAL_POLICY_VERSION = "candidate-common-cohort-shadow-g2-terminal-v2";
const TERMINAL_EVALUATOR_VERSION =
  "candidate-common-cohort-shadow-g2-terminal-evaluator-v2";
const WALK_FORWARD_RESULT_VERSION =
  "candidate-common-cohort-g2-leakage-safe-walk-forward-result-v2";
const LEAGUE_MACRO_RESULT_VERSION =
  "candidate-common-cohort-g2-league-macro-result-v1";
const GENESIS_HASH = "0".repeat(64);

const G2_ALPHA = 0.025;
const PROMOTABLE_ARM_COUNT = 6;
const CONTROL_ARM_COUNT = 1;
const PRIMARY_ENDPOINT_COUNT = 2;
const PRIMARY_HYPOTHESIS_COUNT = PROMOTABLE_ARM_COUNT * PRIMARY_ENDPOINT_COUNT;
const BONFERRONI_THRESHOLD = G2_ALPHA / PRIMARY_HYPOTHESIS_COUNT;
const WINDOW_COUNT = 6;
const WINDOW_DAYS = 30;
const MIN_TOTAL_SETTLED = 500;
const MIN_ROWS_PER_WINDOW = 50;
const MIN_WINNING_WINDOWS = 5;
const MAX_INVALID_SHARE = 0.05;
const MAX_SINGLE_ATTESTOR_SHARE = 0.3;
const MAX_UNKNOWN_LEAGUE_SHARE = 0.02;
const MIN_DISTINCT_LEAGUES = 8;
const MIN_ROWS_PER_LEAGUE = 20;
const MAX_SINGLE_LEAGUE_SHARE = 0.3;
const MIN_LEAGUES_PER_WINDOW = 4;
const MAX_SINGLE_LEAGUE_SHARE_PER_WINDOW = 0.5;
const MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE = 0.75;
const SETTLEMENT_GRACE_DAYS = 14;
const WALK_FORWARD_WARMUP_ROWS = 100;
const WALK_FORWARD_VALIDATION_WINDOWS = 6;
const WALK_FORWARD_ROWS_PER_WINDOW = 50;
const RESAMPLING_ITERATIONS = 100000;
const MARKET_CONTROL_ID = "market-temperature-1-control";
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const TERMINAL_VERIFICATION_CACHE_LIMIT = 16;
const terminalVerificationCache = new Map();
const terminalVerificationCacheCounters = {
  hits: 0,
  misses: 0,
  deterministicRecomputations: 0,
};

const terminalVerificationCacheStats = () => ({
  entries: terminalVerificationCache.size,
  ...terminalVerificationCacheCounters,
});

const resetTerminalVerificationCache = () => {
  terminalVerificationCache.clear();
  terminalVerificationCacheCounters.hits = 0;
  terminalVerificationCacheCounters.misses = 0;
  terminalVerificationCacheCounters.deterministicRecomputations = 0;
};

const modelFeatures = Object.freeze([
  "sporttery-market",
  "current-probability-model",
  "negative-model-residual",
  "temperature-calibration",
]);

const EXACT_ARMS = Object.freeze([
  Object.freeze({
    candidate: Object.freeze({
      id: "market-current-model-residual-minus-20-temperature-0_9",
      role: "shadow-model-candidate",
      featureSet: modelFeatures,
      weights: Object.freeze({ market: 1.2, model: -0.2, temperature: 0.9 }),
    }),
    experimentRole: "active-mirror-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: "market-current-model-residual-minus-10-temperature-0_9",
      role: "shadow-model-candidate",
      featureSet: modelFeatures,
      weights: Object.freeze({ market: 1.1, model: -0.1, temperature: 0.9 }),
    }),
    experimentRole: "residual-deescalation-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: "market-current-model-residual-minus-5-temperature-0_9",
      role: "shadow-model-candidate",
      featureSet: modelFeatures,
      weights: Object.freeze({ market: 1.05, model: -0.05, temperature: 0.9 }),
    }),
    experimentRole: "residual-deescalation-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: "market-temperature-0_9",
      role: "shadow-feature-candidate",
      featureSet: Object.freeze(["sporttery-market", "temperature-calibration"]),
      weights: Object.freeze({ market: 1, model: 0, temperature: 0.9 }),
    }),
    experimentRole: "temperature-calibration-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: "market-current-model-residual-minus-20-temperature-1",
      role: "shadow-temperature-neutralization-candidate",
      featureSet: modelFeatures,
      weights: Object.freeze({ market: 1.2, model: -0.2, temperature: 1 }),
    }),
    experimentRole: "temperature-neutralization-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: "market-current-model-residual-minus-10-temperature-1",
      role: "shadow-temperature-neutralization-candidate",
      featureSet: modelFeatures,
      weights: Object.freeze({ market: 1.1, model: -0.1, temperature: 1 }),
    }),
    experimentRole: "temperature-neutralization-common-cohort-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: MARKET_CONTROL_ID,
      role: "shadow-market-control",
      featureSet: Object.freeze(["sporttery-market", "temperature-identity-control"]),
      weights: Object.freeze({ market: 1, model: 0, temperature: 1 }),
    }),
    experimentRole: "non-promotable-market-control",
    promotable: false,
  }),
]);

const parseTime = (value) => {
  const millis = Date.parse(value || "");
  return Number.isFinite(millis) ? millis : null;
};

const isoTime = (value) => {
  const millis = parseTime(value);
  return millis === null ? null : new Date(millis).toISOString();
};

const validBusinessDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

const addBusinessDays = (date, days) => {
  if (!validBusinessDate(date)) return null;
  const millis = Date.parse(`${date}T00:00:00Z`);
  return new Date(millis + days * 86400000).toISOString().slice(0, 10);
};

const nextShanghaiBusinessDate = (evaluatedAt) => {
  const millis = parseTime(evaluatedAt);
  if (millis === null) return null;
  const localDate = new Date(millis + 8 * 3600000).toISOString().slice(0, 10);
  return addBusinessDays(localDate, 1);
};

const activationInstantFor = (businessDate) => (
  validBusinessDate(businessDate)
    ? new Date(`${businessDate}T00:00:00+08:00`).toISOString()
    : null
);

const businessDateForMatch = (match) => (
  validBusinessDate(match?.businessDate) ? String(match.businessDate) : null
);

const buildBusinessDayWindows = (activationBusinessDate) => (
  Array.from({ length: WINDOW_COUNT }, (_, index) => ({
    index: index + 1,
    startBusinessDate: addBusinessDays(activationBusinessDate, index * WINDOW_DAYS),
    endBusinessDateExclusive: addBusinessDays(
      activationBusinessDate,
      (index + 1) * WINDOW_DAYS,
    ),
    days: WINDOW_DAYS,
  }))
);

const candidateDefinition = (candidate) => canonicalize({
  id: String(candidate?.id || ""),
  role: String(candidate?.role || ""),
  featureSet: Array.isArray(candidate?.featureSet)
    ? candidate.featureSet.map((value) => String(value))
    : [],
  weights: candidate?.weights || {},
});

const exactArms = () => EXACT_ARMS.map((arm) => ({
  candidate: candidateDefinition(arm.candidate),
  experimentRole: arm.experimentRole,
  promotable: arm.promotable,
}));

const activeLedgerFor = (registry) => (
  Array.isArray(registry?.ledgers)
    ? registry.ledgers.find((ledger) => ledger?.ledgerId === registry.activeLedgerId) || null
    : null
);

const trialLedgersFor = (suite) => (Array.isArray(suite?.trials)
  ? suite.trials.map((trial) => activeLedgerFor(trial?.registry)).filter(Boolean)
  : []);

const sourceIsOfficialSporttery = (match) => (
  String(match?.source || "").trim().toLowerCase() === "sporttery"
  && (
    String(match?.id || match?.matchId || "").startsWith("sporttery_")
    || Boolean(String(match?.sourceMatchId || "").trim())
  )
);

const inputEligibilityFor = ({ plan, matches = [] } = {}) => {
  const activationMs = parseTime(plan?.activationAt);
  const startDate = plan?.activationBusinessDate || null;
  const endDate = plan?.horizonEndBusinessDateExclusive || null;
  const eligible = [];
  const counts = {
    excludedReferenceOrNonOfficial: 0,
    excludedPreActivationDeadline: 0,
    excludedInvalidClock: 0,
    excludedBusinessDateMissing: 0,
    excludedOutsideWindowHorizon: 0,
  };
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!sourceIsOfficialSporttery(match)) {
      counts.excludedReferenceOrNonOfficial += 1;
      continue;
    }
    const deadline = decisionDeadlineFor(match);
    const kickoffMs = parseTime(match?.kickoffTime || match?.matchDate);
    const businessDate = businessDateForMatch(match);
    if (activationMs === null || !Number.isFinite(deadline?.millis) || kickoffMs === null) {
      counts.excludedInvalidClock += 1;
      continue;
    }
    if (!businessDate) {
      counts.excludedBusinessDateMissing += 1;
      continue;
    }
    if (deadline.millis <= activationMs || kickoffMs <= activationMs) {
      counts.excludedPreActivationDeadline += 1;
      continue;
    }
    if (businessDate < startDate || businessDate >= endDate) {
      counts.excludedOutsideWindowHorizon += 1;
      continue;
    }
    eligible.push(match);
  }
  return {
    version: INPUT_POLICY_VERSION,
    activationAt: isoTime(plan?.activationAt),
    activationBusinessDate: startDate,
    horizonEndBusinessDateExclusive: endDate,
    receivedMatches: Array.isArray(matches) ? matches.length : 0,
    eligibleMatches: eligible.length,
    ...counts,
    eligible,
    policy:
      "official Sporttery rows require an explicit businessDate inside the frozen six-window horizon and immutable deadline/kickoff strictly after G2 activation; historical, 500-reference and pre-activation rows are excluded before every arm ledger",
  };
};

const buildAlphaLedger = ({ planHash, createdAt }) => {
  const event = canonicalize({
    sequence: 1,
    previousEventHash: GENESIS_HASH,
    type: "generation-alpha-allocation",
    recordedAt: createdAt,
    generation: "G2",
    planHash,
    allocatedAlpha: G2_ALPHA,
    promotableArmCount: PROMOTABLE_ARM_COUNT,
    primaryEndpointCount: PRIMARY_ENDPOINT_COUNT,
    primaryHypothesisCount: PRIMARY_HYPOTHESIS_COUNT,
    adjustment: "Bonferroni",
    perHypothesisThreshold: BONFERRONI_THRESHOLD,
    perHypothesisThresholdDisplay: 0.002083333,
    reclaimable: false,
    state: "ALLOCATED",
    policy:
      "this allocation is append-only and never reclaimable; later generations must append a new allocation instead of editing, recycling or deleting G2 alpha",
  });
  const eventHash = sha256(event);
  return {
    version: ALPHA_LEDGER_VERSION,
    events: [{ ...event, eventHash }],
    rootHash: eventHash,
  };
};

const buildCommonCohortShadowG2Plan = ({
  activeLedger = null,
  evaluatedAt = new Date().toISOString(),
  sourceChallengerSuite = null,
  sourceTemperatureSuite = null,
} = {}) => {
  const createdAt = isoTime(evaluatedAt);
  if (!createdAt || !activeLedger?.header) return null;
  const activationBusinessDate = nextShanghaiBusinessDate(createdAt);
  const activationAt = activationInstantFor(activationBusinessDate);
  const windows = buildBusinessDayWindows(activationBusinessDate);
  const horizonEndBusinessDateExclusive = windows.at(-1)?.endBusinessDateExclusive || null;
  const terminalEligibleBusinessDate = addBusinessDays(
    horizonEndBusinessDateExclusive,
    SETTLEMENT_GRACE_DAYS,
  );
  const arms = exactArms();
  const inventoryDefinitions = arms.map((arm) => arm.candidate);
  const implementationCommitment = canonicalize(
    activeLedger.header.candidateImplementation || {},
  );
  const inventory = candidateInventory(inventoryDefinitions, implementationCommitment);
  if (inventory.count !== PROMOTABLE_ARM_COUNT + CONTROL_ARM_COUNT) return null;
  const nominationPolicyCommitment = canonicalize({
    version: PLAN_VERSION,
    onlineEffect: false,
    commonCohortRequired: true,
    futureOnly: true,
    backfillPolicy: "forbidden",
    terminalDecisionCount: 1,
    intermediateCheckpointPolicy: "descriptive-only",
    promotionPolicy: "no automatic promotion; one frozen terminal judgment then independent governance review",
  });
  const plannedArms = arms.map((arm) => ({
    ...arm,
    promotionPolicy: arm.promotable
      ? "single-G2-terminal-judgment-only"
      : "never-promote-control-arm",
    robustness: {
      version: PLAN_VERSION,
      role: arm.experimentRole,
      onlineEffect: false,
      family: {
        candidateCount: inventory.count,
        testedCandidateCount: PROMOTABLE_ARM_COUNT,
        primaryEndpointCount: PRIMARY_ENDPOINT_COUNT,
        inventoryHash: inventory.hash,
      },
      selectedCandidate: { id: arm.candidate.id },
      candidateReadyForProspectiveTest: true,
      formalPromotionEligible: false,
      blockers: arm.promotable
        ? ["G2-terminal-evaluation-pending"]
        : ["control-arm-non-promotable"],
    },
  }));
  const body = canonicalize({
    version: PLAN_VERSION,
    createdAt,
    activationAt,
    activationBusinessDate,
    horizonEndBusinessDateExclusive,
    settlementGraceDays: SETTLEMENT_GRACE_DAYS,
    terminalEligibleBusinessDate,
    terminalEligibleAt: activationInstantFor(terminalEligibleBusinessDate),
    onlineEffect: false,
    sourceActiveCandidateRevisionId: activeLedger.header.candidateRevisionId || null,
    sourceActiveCandidateRootHash: activeLedger.rootHash || null,
    sourceSuites: {
      challenger: sourceChallengerSuite ? {
        version: sourceChallengerSuite.version || null,
        rootHashAtRegistration: sourceChallengerSuite.rootHash || null,
      } : null,
      temperatureNeutralization: sourceTemperatureSuite ? {
        version: sourceTemperatureSuite.version || null,
        rootHashAtRegistration: sourceTemperatureSuite.rootHash || null,
      } : null,
    },
    inputPolicy: {
      version: INPUT_POLICY_VERSION,
      officialSportteryOnly: true,
      explicitBusinessDateRequired: true,
      decisionDeadlineStrictlyAfterActivation: true,
      kickoffStrictlyAfterActivation: true,
      historicalBackfillRows: 0,
      reference500Rows: 0,
      backfillPolicy: "forbidden",
    },
    cohortPolicy: {
      version: JOURNAL_VERSION,
      sharedDeadlineSnapshot: true,
      sharedOfficialResult: true,
      sharedExclusionRules: true,
      allArmsMustHaveIdentityAndTerminalTypeParity: true,
    },
    windows,
    gates: {
      minimumTotalSettled: MIN_TOTAL_SETTLED,
      minimumRowsPerWindow: MIN_ROWS_PER_WINDOW,
      minimumWinningWindows: MIN_WINNING_WINDOWS,
      maximumInvalidShare: MAX_INVALID_SHARE,
      maximumSingleAttestorShare: MAX_SINGLE_ATTESTOR_SHARE,
      maximumUnknownLeagueShare: MAX_UNKNOWN_LEAGUE_SHARE,
      minimumDistinctLeagues: MIN_DISTINCT_LEAGUES,
      minimumRowsPerLeague: MIN_ROWS_PER_LEAGUE,
      maximumSingleLeagueShare: MAX_SINGLE_LEAGUE_SHARE,
      minimumLeaguesPerWindow: MIN_LEAGUES_PER_WINDOW,
      maximumSingleLeagueSharePerWindow: MAX_SINGLE_LEAGUE_SHARE_PER_WINDOW,
      minimumPositiveQualifiedLeagueShare: MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE,
      requiredAtomicDecisionCoverage: 1,
      requiredSettlementCoverage: 1,
      requiredSourceClockCoverage: 1,
      perArmTerminalMetricGate: {
        minimumDualMetricWinningWindows: MIN_WINNING_WINDOWS,
        requireBrierImprovementAboveZeroInWinningWindow: true,
        requireLogLossImprovementAboveZeroInWinningWindow: true,
        requireBonferroniAdjustedOneSidedBrierLowerBoundAboveZero: true,
        requireBonferroniAdjustedOneSidedLogLossLowerBoundAboveZero: true,
        requireLeagueMacroAverageBrierImprovementAboveZero: true,
        requireLeagueMacroAverageLogLossImprovementAboveZero: true,
        minimumQualifiedLeagueDualMetricPositiveShare:
          MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE,
      },
    },
    inference: {
      generation: "G2",
      familyAlpha: G2_ALPHA,
      promotableArmCount: PROMOTABLE_ARM_COUNT,
      primaryEndpointCount: PRIMARY_ENDPOINT_COUNT,
      primaryHypothesisCount: PRIMARY_HYPOTHESIS_COUNT,
      adjustment: "Bonferroni",
      perHypothesisThreshold: BONFERRONI_THRESHOLD,
      resampling: {
        version: RESAMPLING_VERSION,
        unit: "common-Sporttery-business-day",
        iterations: RESAMPLING_ITERATIONS,
        seed: "candidate-common-cohort-shadow-g2-v2",
        seedScope: "frozen-plan-plus-terminal-common-dataset-only",
        candidateAndEndpointExcludedFromSeed: true,
        commonDrawScheduleAcrossAllHypotheses: true,
        executionPolicy: "execute-once-at-terminal-only",
        resultBeforeTerminal: null,
      },
      leagueMacroEvaluationVersion:
        "candidate-common-cohort-g2-league-macro-v1",
      endpointLowerBoundVersion:
        "candidate-common-cohort-g2-adjusted-one-sided-lower-bound-v1",
    },
    leakageSafeWalkForward: {
      version: "candidate-common-cohort-g2-leakage-safe-walk-forward-v2",
      independentPrerequisite: true,
      warmupRows: WALK_FORWARD_WARMUP_ROWS,
      validationWindows: WALK_FORWARD_VALIDATION_WINDOWS,
      minimumRowsPerValidationWindow: WALK_FORWARD_ROWS_PER_WINDOW,
      minimumRowsIncludingWarmup:
        WALK_FORWARD_WARMUP_ROWS
        + WALK_FORWARD_VALIDATION_WINDOWS * WALK_FORWARD_ROWS_PER_WINDOW,
      temporalOrderRequired: true,
      trainingMayOnlyUseRowsBeforeValidationWindow: true,
      businessDayAtomicityRequired: true,
      sameBusinessDateMayNotCrossBoundaries: true,
      validationAllocation:
        "deterministic-balanced-contiguous-business-day-partition",
      executionPolicy: "must-complete-before-the-only-terminal-judgment",
      resultBeforeTerminal: null,
    },
    terminalPolicy: {
      version: TERMINAL_POLICY_VERSION,
      maximumJudgments: 1,
      requireWindowHorizonClosed: true,
      settlementGraceDays: SETTLEMENT_GRACE_DAYS,
      requireSettlementGraceElapsed: true,
      requireAllAdmittedRowsSettled: true,
      requireAtomicDecisionCoverage: 1,
      requireSettlementCoverage: 1,
      requireSourceClockCoverage: 1,
      requireLeakageSafeWalkForwardPass: true,
      requireLeagueGeneralizationPass: true,
      evaluatorExecutionPolicy:
        "all endpoint resampling, adjusted lower bounds, league macro metrics and final selection execute once only after every frozen prerequisite is complete",
      checkpoints: "descriptive-only-no-alpha-spend-no-promotion-decision",
      onlineEffect: false,
    },
    implementationCommitment,
    inventory: inventoryDefinitions,
    inventoryHash: inventory.hash,
    arms: plannedArms,
    nominationPolicyCommitment,
  });
  return { ...body, planHash: sha256(body) };
};

const journalRoot = (events) => events.at(-1)?.eventHash || GENESIS_HASH;

const suiteRootHash = (suite) => sha256({
  version: SUITE_VERSION,
  headerHash: suite?.headerHash || null,
  alphaRootHash: suite?.alphaLedger?.rootHash || null,
  journalRootHash: journalRoot(Array.isArray(suite?.journal) ? suite.journal : []),
  trials: (Array.isArray(suite?.trials) ? suite.trials : []).map((trial) => ({
    candidateId: String(trial?.candidateId || ""),
    registryRootHash: activeLedgerFor(trial?.registry)?.rootHash || null,
  })).sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  terminalJudgmentHash: suite?.terminalJudgmentHash || null,
});

const createSuite = (plan) => {
  const header = canonicalize({
    version: SUITE_VERSION,
    createdAt: plan.createdAt,
    activationAt: plan.activationAt,
    activationBusinessDate: plan.activationBusinessDate,
    onlineEffect: false,
    planHash: plan.planHash,
    frozenPlan: plan,
    storeIsolation:
      "G2 owns this artifact, seven child registries and one common cohort journal; it never mutates active, challenger or temperature-neutralization artifacts",
  });
  const suite = {
    version: SUITE_VERSION,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    header,
    headerHash: sha256(header),
    alphaLedger: buildAlphaLedger({ planHash: plan.planHash, createdAt: plan.createdAt }),
    trials: [],
    journal: [],
    terminalJudgment: null,
    terminalJudgmentHash: null,
    rootHash: null,
  };
  suite.rootHash = suiteRootHash(suite);
  return suite;
};

const appendJournalEvent = (suite, event) => {
  const prior = journalRoot(suite.journal);
  const body = canonicalize({
    ...event,
    sequence: suite.journal.length + 1,
    previousEventHash: prior,
    onlineEffect: false,
  });
  const appended = { ...body, eventHash: sha256(body) };
  suite.journal.push(appended);
  return appended;
};

const sharedTerminalInput = (event) => canonicalize({
  type: event?.type || null,
  phase: event?.phase || null,
  matchId: event?.matchId || null,
  sourceMatchId: event?.sourceMatchId || null,
  leagueNormalizationVersion: event?.leagueNormalizationVersion || null,
  league: event?.league || null,
  market: event?.market || null,
  kickoffAt: event?.kickoffAt || null,
  decisionDeadlineAt: event?.decisionDeadlineAt || null,
  decisionDeadlinePolicyVersion: event?.decisionDeadlinePolicyVersion || null,
  decisionDeadlineSource: event?.decisionDeadlineSource || null,
  captureFinalizationAt: event?.captureFinalizationAt || null,
  snapshotHash: event?.snapshotHash || null,
  decisionSnapshotHash: event?.decisionSnapshotHash || null,
  marketProbabilities: event?.marketProbabilities || null,
  baseModelProbabilities: event?.baseModelProbabilities || null,
  featureSnapshotHash: event?.featureSnapshotHash || null,
  sourceClockHash: event?.sourceClockHash || null,
  dualMarketDecisionHash: event?.dualMarketDecisionHash || null,
  marketProvenanceHash: event?.marketProvenanceHash || null,
  collectorAttestationCommitmentHash: event?.collectorAttestationCommitmentHash || null,
  sourceClass: event?.sourceClass || null,
  singleAttestor: event?.singleAttestor === true,
  marketState: event?.marketState || null,
  primaryExclusionReason: event?.primaryExclusionReason || null,
  blockers: Array.isArray(event?.blockers) ? event.blockers : [],
});

const terminalEventsFor = (ledger) => (Array.isArray(ledger?.events)
  ? ledger.events.filter((event) => event?.type === "decision" || event?.type === "exclusion")
  : []);

const journalIdentity = (event) => sha256({
  matchId: event?.matchId || null,
  sourceMatchId: event?.sourceMatchId || null,
  kickoffAt: event?.kickoffAt || null,
  market: event?.market || "HAD",
});

const syncCaptureJournal = ({ suite, eligibleMatches, evaluatedAt }) => {
  const ledgers = trialLedgersFor(suite);
  if (ledgers.length !== EXACT_ARMS.length) return ["G2-trial-ledger-count-invalid"];
  const recorded = new Set(suite.journal
    .filter((event) => event.type === "cohort-terminal")
    .map((event) => event.identityHash));
  const blockers = [];
  for (const reference of terminalEventsFor(ledgers[0])) {
    if (reference.phase !== "formal") continue;
    const identityHash = journalIdentity(reference);
    if (recorded.has(identityHash)) continue;
    const aligned = ledgers.map((ledger) => terminalEventsFor(ledger).filter(
      (event) => sameCohortIdentity(reference, event),
    ));
    if (aligned.some((rows) => rows.length !== 1)) {
      blockers.push(`G2-common-cohort-identity-parity-invalid:${identityHash}`);
      continue;
    }
    const events = aligned.map((rows) => rows[0]);
    if (events.some((event) => event.type !== reference.type)) {
      blockers.push(`G2-common-cohort-terminal-type-parity-invalid:${identityHash}`);
      continue;
    }
    const sharedHash = sha256(sharedTerminalInput(reference));
    if (events.some((event) => sha256(sharedTerminalInput(event)) !== sharedHash)) {
      blockers.push(`G2-common-cohort-deadline-snapshot-parity-invalid:${identityHash}`);
      continue;
    }
    const match = eligibleMatches.find((row) => sameCohortIdentity(reference, row));
    const businessDate = businessDateForMatch(match);
    if (!businessDate) {
      blockers.push(`G2-business-date-missing:${identityHash}`);
      continue;
    }
    appendJournalEvent(suite, {
      type: "cohort-terminal",
      recordedAt: isoTime(evaluatedAt),
      identityHash,
      terminalType: reference.type,
      matchId: reference.matchId || null,
      sourceMatchId: reference.sourceMatchId || null,
      kickoffAt: reference.kickoffAt || null,
      decisionDeadlineAt: reference.decisionDeadlineAt || null,
      businessDate,
      league: reference.league || normalizedLeagueForMatch(match),
      sharedInputHash: sharedHash,
      singleAttestor: reference.type === "decision" && reference.singleAttestor === true,
      trialEventHashes: Object.fromEntries(suite.trials.map((trial, index) => [
        trial.candidateId,
        events[index].eventHash,
      ])),
    });
    recorded.add(identityHash);
  }
  return blockers;
};

const sharedSettlementInput = (event) => canonicalize({
  type: event?.type || null,
  phase: event?.phase || null,
  matchId: event?.matchId || null,
  sourceMatchId: event?.sourceMatchId || null,
  market: event?.market || null,
  kickoffAt: event?.kickoffAt || null,
  resultObservedAt: event?.resultObservedAt || null,
  resultProvider: event?.resultProvider || null,
  resultSourceMatchId: event?.resultSourceMatchId || null,
  resultEventVersion: event?.resultEventVersion || null,
  scoreHome: event?.scoreHome,
  scoreAway: event?.scoreAway,
  actual: event?.actual || null,
  valid: event?.valid === true,
  settlementRecordVersion: event?.settlementRecordVersion || null,
  resultProvenanceHash: event?.resultProvenanceHash || null,
});

const syncSettlementJournal = ({ suite, evaluatedAt }) => {
  const blockers = [];
  const settled = new Set(suite.journal
    .filter((event) => event.type === "cohort-settlement")
    .map((event) => event.identityHash));
  for (const terminal of suite.journal.filter(
    (event) => event.type === "cohort-terminal" && event.terminalType === "decision",
  )) {
    if (settled.has(terminal.identityHash)) continue;
    const settlementEvents = suite.trials.map((trial) => {
      const ledger = activeLedgerFor(trial.registry);
      const decisionHash = terminal.trialEventHashes?.[trial.candidateId];
      return (ledger?.events || []).filter(
        (event) => event.type === "settlement" && event.decisionEventHash === decisionHash,
      );
    });
    if (settlementEvents.every((rows) => rows.length === 0)) continue;
    if (settlementEvents.some((rows) => rows.length !== 1)) {
      blockers.push(`G2-common-result-parity-invalid:${terminal.identityHash}`);
      continue;
    }
    const events = settlementEvents.map((rows) => rows[0]);
    const sharedHash = sha256(sharedSettlementInput(events[0]));
    if (events.some((event) => sha256(sharedSettlementInput(event)) !== sharedHash)) {
      blockers.push(`G2-common-result-content-parity-invalid:${terminal.identityHash}`);
      continue;
    }
    appendJournalEvent(suite, {
      type: "cohort-settlement",
      recordedAt: isoTime(evaluatedAt),
      identityHash: terminal.identityHash,
      businessDate: terminal.businessDate,
      league: terminal.league,
      actual: events[0].actual,
      sharedResultHash: sharedHash,
      trialSettlementHashes: Object.fromEntries(suite.trials.map((trial, index) => [
        trial.candidateId,
        events[index].eventHash,
      ])),
    });
    settled.add(terminal.identityHash);
  }
  return blockers;
};

const metricRound = (value, digits = 12) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
};

const mean = (values) => {
  const finiteValues = values.map(Number).filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
};

const normalizeEvaluationTriplet = (value) => {
  if (!value || typeof value !== "object") return null;
  const normalized = Object.fromEntries(OUTCOMES.map((code) => [code, Number(value[code])]));
  if (OUTCOMES.some((code) => !Number.isFinite(normalized[code]) || normalized[code] <= 0)) {
    return null;
  }
  const total = OUTCOMES.reduce((sum, code) => sum + normalized[code], 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Object.fromEntries(OUTCOMES.map((code) => [code, normalized[code] / total]));
};

const scoredEndpointRow = ({ decision, settlement, terminal }) => {
  const candidate = normalizeEvaluationTriplet(decision?.probabilities);
  const market = normalizeEvaluationTriplet(decision?.marketProbabilities);
  const actual = String(settlement?.actual || "");
  if (!candidate || !market || settlement?.valid !== true || !OUTCOMES.includes(actual)) {
    return null;
  }
  const logLoss = (probabilities) => -Math.log(Math.max(1e-12, probabilities[actual]));
  const brier = (probabilities) => OUTCOMES.reduce((sum, code) => (
    sum + (probabilities[code] - (code === actual ? 1 : 0)) ** 2
  ), 0);
  const candidateLogLoss = logLoss(candidate);
  const marketLogLoss = logLoss(market);
  const candidateBrier = brier(candidate);
  const marketBrier = brier(market);
  return canonicalize({
    identityHash: terminal.identityHash,
    businessDate: terminal.businessDate,
    kickoffAt: terminal.kickoffAt || decision.kickoffAt || null,
    league: terminal.league || decision.league || "unknown",
    actual,
    decisionEventHash: decision.eventHash,
    settlementEventHash: settlement.eventHash,
    candidateLogLoss,
    marketLogLoss,
    candidateBrier,
    marketBrier,
    logLossImprovement: marketLogLoss - candidateLogLoss,
    brierImprovement: marketBrier - candidateBrier,
  });
};

const terminalDatasetForSuite = (suite) => {
  const blockers = [];
  const terminals = (suite?.journal || []).filter(
    (event) => event.type === "cohort-terminal" && event.terminalType === "decision",
  );
  const settlements = new Map((suite?.journal || [])
    .filter((event) => event.type === "cohort-settlement")
    .map((event) => [event.identityHash, event]));
  const rowsByCandidate = {};
  for (const trial of suite?.trials || []) {
    const ledger = activeLedgerFor(trial.registry);
    const events = new Map((ledger?.events || []).map((event) => [event.eventHash, event]));
    const rows = [];
    for (const terminal of terminals) {
      const commonSettlement = settlements.get(terminal.identityHash);
      if (!commonSettlement) continue;
      const decisionHash = terminal.trialEventHashes?.[trial.candidateId];
      const settlementHash = commonSettlement.trialSettlementHashes?.[trial.candidateId];
      const decision = events.get(decisionHash);
      const settlement = events.get(settlementHash);
      if (
        decision?.type !== "decision"
        || settlement?.type !== "settlement"
        || settlement.decisionEventHash !== decisionHash
        || settlement.actual !== commonSettlement.actual
      ) {
        blockers.push(`G2-terminal-dataset-event-parity-invalid:${trial.candidateId}:${terminal.identityHash}`);
        continue;
      }
      const scored = scoredEndpointRow({ decision, settlement, terminal });
      if (!scored) {
        blockers.push(`G2-terminal-dataset-score-invalid:${trial.candidateId}:${terminal.identityHash}`);
        continue;
      }
      rows.push(scored);
    }
    rowsByCandidate[trial.candidateId] = rows.sort((left, right) => (
      left.businessDate.localeCompare(right.businessDate)
      || String(left.kickoffAt || "").localeCompare(String(right.kickoffAt || ""))
      || left.identityHash.localeCompare(right.identityHash)
    ));
  }
  const candidateIds = Object.keys(rowsByCandidate).sort();
  const referenceIds = (rowsByCandidate[candidateIds[0]] || []).map((row) => row.identityHash);
  for (const candidateId of candidateIds) {
    const ids = rowsByCandidate[candidateId].map((row) => row.identityHash);
    if (sha256(ids) !== sha256(referenceIds)) {
      blockers.push(`G2-terminal-dataset-common-cohort-invalid:${candidateId}`);
    }
  }
  const rowCommitments = candidateIds.map((candidateId) => ({
    candidateId,
    rows: rowsByCandidate[candidateId].length,
    rowHash: sha256(rowsByCandidate[candidateId]),
  }));
  return {
    rowsByCandidate,
    commonRows: referenceIds.length,
    datasetHash: sha256({ version: TERMINAL_EVALUATOR_VERSION, rowCommitments }),
    rowCommitments,
    blockers: [...new Set(blockers)].sort(),
  };
};

const seededRandom = (seedText) => {
  let state = Number.parseInt(sha256(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const clusteredBusinessDayResampling = ({
  rows,
  endpoint,
  candidateId,
  plan,
  datasetHash,
}) => {
  const field = endpoint === "brier" ? "brierImprovement" : "logLossImprovement";
  const grouped = new Map();
  for (const row of rows) {
    const businessDate = row.businessDate;
    const value = Number(row[field]);
    if (!validBusinessDate(businessDate) || !Number.isFinite(value)) continue;
    const aggregate = grouped.get(businessDate) || { sum: 0, rows: 0 };
    aggregate.sum += value;
    aggregate.rows += 1;
    grouped.set(businessDate, aggregate);
  }
  const clusters = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([businessDate, aggregate]) => ({ businessDate, ...aggregate }));
  if (!clusters.length) return null;
  const seedCommitment = sha256([
    plan?.inference?.resampling?.seed,
    plan?.planHash,
    datasetHash,
  ].join("|"));
  const random = seededRandom(seedCommitment);
  const drawScheduleHash = sha256({
    version: RESAMPLING_VERSION,
    seedCommitment,
    clusterBusinessDates: clusters.map((cluster) => cluster.businessDate),
    clusterRowCounts: clusters.map((cluster) => cluster.rows),
    iterations: RESAMPLING_ITERATIONS,
    drawsPerIteration: clusters.length,
  });
  const estimates = new Float64Array(RESAMPLING_ITERATIONS);
  let nonPositive = 0;
  for (let iteration = 0; iteration < RESAMPLING_ITERATIONS; iteration += 1) {
    let sampledSum = 0;
    let sampledRows = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      sampledSum += cluster.sum;
      sampledRows += cluster.rows;
    }
    const estimate = sampledRows ? sampledSum / sampledRows : Number.NEGATIVE_INFINITY;
    estimates[iteration] = estimate;
    if (!(estimate > 0)) nonPositive += 1;
  }
  estimates.sort();
  const lowerIndex = Math.max(
    0,
    Math.min(
      RESAMPLING_ITERATIONS - 1,
      Math.ceil(BONFERRONI_THRESHOLD * RESAMPLING_ITERATIONS) - 1,
    ),
  );
  const lowerBound = estimates[lowerIndex];
  const pValue = (nonPositive + 1) / (RESAMPLING_ITERATIONS + 1);
  return canonicalize({
    version: RESAMPLING_VERSION,
    endpoint,
    unit: "common-Sporttery-business-day",
    clusterCount: clusters.length,
    rows: rows.length,
    iterations: RESAMPLING_ITERATIONS,
    seedCommitment,
    drawScheduleHash,
    pointEstimate: metricRound(mean(rows.map((row) => row[field]))),
    bonferroniThreshold: BONFERRONI_THRESHOLD,
    bonferroniAdjustedOneSidedLowerBound: metricRound(lowerBound),
    oneSidedPValue: metricRound(pValue),
    adjustedPValue: metricRound(Math.min(1, pValue * PRIMARY_HYPOTHESIS_COUNT)),
    pass: lowerBound > 0 && pValue <= BONFERRONI_THRESHOLD,
  });
};

const balancedValidationWindows = (inputRows) => {
  const rows = inputRows.slice().sort((left, right) => (
    String(left.businessDate || "").localeCompare(String(right.businessDate || ""))
    || String(left.kickoffAt || "").localeCompare(String(right.kickoffAt || ""))
    || String(left.identityHash || "").localeCompare(String(right.identityHash || ""))
  ));
  if (rows.length < WALK_FORWARD_WARMUP_ROWS
    + WALK_FORWARD_VALIDATION_WINDOWS * WALK_FORWARD_ROWS_PER_WINDOW) return null;
  const groups = [];
  for (const [index, row] of rows.entries()) {
    if (!validBusinessDate(row.businessDate)) return null;
    let group = groups.at(-1);
    if (!group || group.businessDate !== row.businessDate) {
      group = { businessDate: row.businessDate, start: index, end: index, rows: 0 };
      groups.push(group);
    }
    group.end = index + 1;
    group.rows += 1;
  }
  let warmupGroupCount = 0;
  let warmupRows = 0;
  while (warmupGroupCount < groups.length && warmupRows < WALK_FORWARD_WARMUP_ROWS) {
    warmupRows += groups[warmupGroupCount].rows;
    warmupGroupCount += 1;
  }
  const validationGroups = groups.slice(warmupGroupCount);
  if (
    warmupRows < WALK_FORWARD_WARMUP_ROWS
    || validationGroups.length < WALK_FORWARD_VALIDATION_WINDOWS
    || validationGroups.reduce((sum, group) => sum + group.rows, 0)
      < WALK_FORWARD_VALIDATION_WINDOWS * WALK_FORWARD_ROWS_PER_WINDOW
  ) return null;
  const prefixRows = [0];
  for (const group of validationGroups) {
    prefixRows.push(prefixRows.at(-1) + group.rows);
  }
  const groupCount = validationGroups.length;
  const targetRows = prefixRows.at(-1) / WALK_FORWARD_VALIDATION_WINDOWS;
  const costs = Array.from(
    { length: WALK_FORWARD_VALIDATION_WINDOWS + 1 },
    () => Array(groupCount + 1).fill(Number.POSITIVE_INFINITY),
  );
  const priorCuts = Array.from(
    { length: WALK_FORWARD_VALIDATION_WINDOWS + 1 },
    () => Array(groupCount + 1).fill(-1),
  );
  costs[0][0] = 0;
  for (let segment = 1; segment <= WALK_FORWARD_VALIDATION_WINDOWS; segment += 1) {
    for (let end = segment; end <= groupCount; end += 1) {
      for (let start = segment - 1; start < end; start += 1) {
        if (!Number.isFinite(costs[segment - 1][start])) continue;
        const segmentRows = prefixRows[end] - prefixRows[start];
        if (segmentRows < WALK_FORWARD_ROWS_PER_WINDOW) continue;
        const cost = costs[segment - 1][start] + (segmentRows - targetRows) ** 2;
        if (cost < costs[segment][end]) {
          costs[segment][end] = cost;
          priorCuts[segment][end] = start;
        }
      }
    }
  }
  if (!Number.isFinite(costs[WALK_FORWARD_VALIDATION_WINDOWS][groupCount])) return null;
  const groupWindows = [];
  let end = groupCount;
  for (let segment = WALK_FORWARD_VALIDATION_WINDOWS; segment >= 1; segment -= 1) {
    const start = priorCuts[segment][end];
    if (start < 0) return null;
    groupWindows.unshift({ start, end });
    end = start;
  }
  const windows = groupWindows.map(({ start, end: groupEnd }, index) => {
    const first = validationGroups[start];
    const last = validationGroups[groupEnd - 1];
    return {
      index: index + 1,
      start: first.start,
      end: last.end,
      startBusinessDate: first.businessDate,
      endBusinessDate: last.businessDate,
      businessDays: groupEnd - start,
    };
  });
  return {
    rows,
    warmup: {
      start: 0,
      end: groups[warmupGroupCount - 1].end,
      rows: warmupRows,
      businessDays: warmupGroupCount,
      endBusinessDate: groups[warmupGroupCount - 1].businessDate,
    },
    windows,
  };
};

const leakageSafeWalkForwardFor = ({ rows, candidateId }) => {
  const allocation = balancedValidationWindows(rows);
  if (!allocation) {
    return canonicalize({
      version: WALK_FORWARD_RESULT_VERSION,
      candidateId,
      executed: false,
      pass: false,
      rows: rows.length,
      blockers: ["G2-walk-forward-minimum-rows-not-met"],
    });
  }
  const orderedRows = allocation.rows;
  const validation = allocation.windows.map((window) => {
    const { index, start, end } = window;
    const foldRows = orderedRows.slice(start, end);
    const brierImprovement = mean(foldRows.map((row) => row.brierImprovement));
    const logLossImprovement = mean(foldRows.map((row) => row.logLossImprovement));
    const trainingMaxBusinessDate = orderedRows[start - 1]?.businessDate || null;
    const validationMinBusinessDate = foldRows[0]?.businessDate || null;
    const strictTemporalSeparation = Boolean(
      trainingMaxBusinessDate
      && validationMinBusinessDate
      && trainingMaxBusinessDate < validationMinBusinessDate,
    );
    return {
      index,
      trainingPrefixRows: start,
      validationRows: foldRows.length,
      trainingBusinessDays: new Set(
        orderedRows.slice(0, start).map((row) => row.businessDate),
      ).size,
      validationBusinessDays: window.businessDays,
      trainingMaxBusinessDate,
      validationMinBusinessDate,
      validationMaxBusinessDate: foldRows.at(-1)?.businessDate || null,
      strictTemporalSeparation,
      trainingPrefixHash: sha256(orderedRows.slice(0, start).map((row) => row.identityHash)),
      validationHash: sha256(foldRows.map((row) => row.identityHash)),
      startIdentityHash: foldRows[0]?.identityHash || null,
      endIdentityHash: foldRows.at(-1)?.identityHash || null,
      brierImprovement: metricRound(brierImprovement),
      logLossImprovement: metricRound(logLossImprovement),
      dualMetricWin: brierImprovement > 0 && logLossImprovement > 0,
    };
  });
  const scoredRows = orderedRows.slice(allocation.warmup.end);
  const aggregateBrier = mean(scoredRows.map((row) => row.brierImprovement));
  const aggregateLogLoss = mean(scoredRows.map((row) => row.logLossImprovement));
  const winningWindows = validation.filter((window) => window.dualMetricWin).length;
  return canonicalize({
    version: WALK_FORWARD_RESULT_VERSION,
    candidateId,
    executed: true,
    temporalOrderVerified: true,
    businessDayAtomicityVerified: validation.every(
      (window) => window.strictTemporalSeparation,
    ),
    frozenCandidateNoRefit: true,
    warmupMinimumRows: WALK_FORWARD_WARMUP_ROWS,
    warmupRows: allocation.warmup.rows,
    warmupBusinessDays: allocation.warmup.businessDays,
    warmupEndBusinessDate: allocation.warmup.endBusinessDate,
    warmupHash: sha256(
      orderedRows.slice(0, allocation.warmup.end).map((row) => row.identityHash),
    ),
    validationRows: scoredRows.length,
    validationWindows: validation,
    dualMetricWinningWindows: winningWindows,
    aggregateBrierImprovement: metricRound(aggregateBrier),
    aggregateLogLossImprovement: metricRound(aggregateLogLoss),
    pass:
      winningWindows >= MIN_WINNING_WINDOWS
      && aggregateBrier > 0
      && aggregateLogLoss > 0
      && validation.every((window) => window.strictTemporalSeparation),
    blockers: [],
  });
};

const fixedWindowMetricsFor = ({ rows, plan }) => {
  const windows = (plan?.windows || []).map((window) => {
    const selected = rows.filter((row) => (
      row.businessDate >= window.startBusinessDate
      && row.businessDate < window.endBusinessDateExclusive
    ));
    const brierImprovement = mean(selected.map((row) => row.brierImprovement));
    const logLossImprovement = mean(selected.map((row) => row.logLossImprovement));
    return {
      index: window.index,
      startBusinessDate: window.startBusinessDate,
      endBusinessDateExclusive: window.endBusinessDateExclusive,
      rows: selected.length,
      brierImprovement: metricRound(brierImprovement),
      logLossImprovement: metricRound(logLossImprovement),
      dualMetricWin: selected.length >= MIN_ROWS_PER_WINDOW
        && brierImprovement > 0
        && logLossImprovement > 0,
    };
  });
  return {
    windows,
    dualMetricWinningWindows: windows.filter((window) => window.dualMetricWin).length,
  };
};

const leagueMacroMetricsFor = (rows) => {
  const grouped = new Map();
  for (const row of rows) {
    const league = row.league || "unknown";
    if (!grouped.has(league)) grouped.set(league, []);
    grouped.get(league).push(row);
  }
  const leagues = [...grouped.entries()]
    .filter(([league, leagueRows]) => league !== "unknown" && leagueRows.length >= MIN_ROWS_PER_LEAGUE)
    .map(([league, leagueRows]) => {
      const brierImprovement = mean(leagueRows.map((row) => row.brierImprovement));
      const logLossImprovement = mean(leagueRows.map((row) => row.logLossImprovement));
      return {
        league,
        rows: leagueRows.length,
        brierImprovement: metricRound(brierImprovement),
        logLossImprovement: metricRound(logLossImprovement),
        dualMetricPositive: brierImprovement > 0 && logLossImprovement > 0,
      };
    }).sort((left, right) => left.league.localeCompare(right.league));
  const macroBrier = mean(leagues.map((row) => row.brierImprovement));
  const macroLogLoss = mean(leagues.map((row) => row.logLossImprovement));
  const positiveShare = leagues.length
    ? leagues.filter((row) => row.dualMetricPositive).length / leagues.length
    : null;
  return canonicalize({
    version: LEAGUE_MACRO_RESULT_VERSION,
    qualifiedLeagueCount: leagues.length,
    leagues,
    macroAverageBrierImprovement: metricRound(macroBrier),
    macroAverageLogLossImprovement: metricRound(macroLogLoss),
    qualifiedLeagueDualMetricPositiveShare: metricRound(positiveShare),
    pass:
      leagues.length >= MIN_DISTINCT_LEAGUES
      && macroBrier > 0
      && macroLogLoss > 0
      && positiveShare >= MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE,
  });
};

const evaluateFrozenTerminalRows = ({ plan, rowsByCandidate, datasetHash = null }) => {
  const firstCandidateId = Object.keys(rowsByCandidate || {}).sort()[0] || null;
  const commonScheduleDatasetHash = datasetHash || sha256(
    (rowsByCandidate?.[firstCandidateId] || []).map((row) => ({
      identityHash: row.identityHash,
      businessDate: row.businessDate,
    })),
  );
  const armById = new Map((plan?.arms || []).map((arm) => [arm.candidate.id, arm]));
  const candidateResults = Object.keys(rowsByCandidate || {}).sort().map((candidateId) => {
    const rows = rowsByCandidate[candidateId] || [];
    const arm = armById.get(candidateId) || {};
    const fixedWindows = fixedWindowMetricsFor({ rows, plan });
    const walkForward = leakageSafeWalkForwardFor({ rows, candidateId });
    const leagueMacro = leagueMacroMetricsFor(rows);
    const resampling = arm.promotable === true ? {
      brier: clusteredBusinessDayResampling({
        rows,
        endpoint: "brier",
        candidateId,
        plan,
        datasetHash: commonScheduleDatasetHash,
      }),
      logLoss: clusteredBusinessDayResampling({
        rows,
        endpoint: "log-loss",
        candidateId,
        plan,
        datasetHash: commonScheduleDatasetHash,
      }),
    } : null;
    const blockers = [];
    if (arm.promotable !== true) blockers.push("control-arm-non-promotable");
    if (fixedWindows.dualMetricWinningWindows < MIN_WINNING_WINDOWS) {
      blockers.push("G2-fixed-window-dual-metric-gate-failed");
    }
    if (!walkForward.pass) blockers.push("G2-leakage-safe-walk-forward-gate-failed");
    if (!leagueMacro.pass) blockers.push("G2-league-generalization-gate-failed");
    if (arm.promotable === true && !resampling?.brier?.pass) {
      blockers.push("G2-brier-adjusted-lower-bound-gate-failed");
    }
    if (arm.promotable === true && !resampling?.logLoss?.pass) {
      blockers.push("G2-log-loss-adjusted-lower-bound-gate-failed");
    }
    return canonicalize({
      candidateId,
      promotable: arm.promotable === true,
      rows: rows.length,
      fixedWindows,
      walkForward,
      leagueMacro,
      resampling,
      formalPromotionEligible: blockers.length === 0,
      blockers,
    });
  });
  const promotableResults = candidateResults.filter((row) => row.promotable);
  const eligibleCandidateIds = promotableResults
    .filter((row) => row.formalPromotionEligible)
    .map((row) => row.candidateId);
  const resamplingExecuted =
    promotableResults.length === PROMOTABLE_ARM_COUNT
    && promotableResults.every((row) => (
      row.resampling?.brier?.iterations === RESAMPLING_ITERATIONS
      && row.resampling?.logLoss?.iterations === RESAMPLING_ITERATIONS
    ));
  const resamplingResult = canonicalize({
    version: RESAMPLING_VERSION,
    executed: resamplingExecuted,
    unit: "common-Sporttery-business-day",
    iterations: RESAMPLING_ITERATIONS,
    adjustment: "Bonferroni",
    familyAlpha: G2_ALPHA,
    primaryHypotheses: PRIMARY_HYPOTHESIS_COUNT,
    perHypothesisThreshold: BONFERRONI_THRESHOLD,
    candidates: promotableResults.map((row) => ({
      candidateId: row.candidateId,
      brier: row.resampling.brier,
      logLoss: row.resampling.logLoss,
    })),
  });
  return canonicalize({
    version: TERMINAL_EVALUATOR_VERSION,
    executed: true,
    candidateResults,
    primaryHypothesesEvaluated: promotableResults.length * PRIMARY_ENDPOINT_COUNT,
    resamplingExecuted,
    resamplingResult,
    leakageSafeWalkForwardExecuted: candidateResults.every((row) => row.walkForward.executed),
    eligibleCandidateIds,
    formalPromotionEligible: eligibleCandidateIds.length > 0,
    selectedCandidateId: null,
    selectionPolicy:
      "no automatic promotion or post-hoc winner selection; every eligible frozen arm requires independent governance review",
    onlineEffect: false,
  });
};

const verifyAlphaLedger = (ledger, planHash) => {
  const blockers = [];
  if (ledger?.version !== ALPHA_LEDGER_VERSION) blockers.push("G2-alpha-ledger-version-invalid");
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  if (events.length !== 1) blockers.push("G2-alpha-allocation-count-invalid");
  const event = events[0] || {};
  const { eventHash, ...body } = event;
  if (sha256(body) !== eventHash || ledger?.rootHash !== eventHash) {
    blockers.push("G2-alpha-ledger-chain-invalid");
  }
  if (
    event.generation !== "G2"
    || event.planHash !== planHash
    || event.allocatedAlpha !== G2_ALPHA
    || event.primaryHypothesisCount !== PRIMARY_HYPOTHESIS_COUNT
    || Math.abs(Number(event.perHypothesisThreshold) - BONFERRONI_THRESHOLD) > 1e-15
    || event.reclaimable !== false
  ) blockers.push("G2-alpha-allocation-invalid");
  return blockers;
};

const verifyJournal = (suite) => {
  const blockers = [];
  let previous = GENESIS_HASH;
  const terminals = new Map();
  const settlements = new Set();
  let terminalJudgmentEvents = 0;
  for (const [index, event] of (suite.journal || []).entries()) {
    const { eventHash, ...body } = event;
    if (
      event.sequence !== index + 1
      || event.previousEventHash !== previous
      || sha256(body) !== eventHash
    ) blockers.push("G2-journal-chain-invalid");
    previous = eventHash;
    if (event.type === "cohort-terminal") {
      if (terminals.has(event.identityHash)) blockers.push("G2-duplicate-terminal-row");
      terminals.set(event.identityHash, event);
    }
    if (event.type === "cohort-settlement") {
      if (!terminals.has(event.identityHash) || settlements.has(event.identityHash)) {
        blockers.push("G2-settlement-journal-identity-invalid");
      }
      settlements.add(event.identityHash);
    }
    if (event.type === "terminal-judgment") {
      terminalJudgmentEvents += 1;
      if (terminalJudgmentEvents > 1) blockers.push("G2-terminal-judgment-count-invalid");
      if (index !== suite.journal.length - 1) blockers.push("G2-terminal-judgment-not-final-event");
    }
  }
  return blockers;
};

const terminalResultProjection = (value) => canonicalize({
  candidateResults: value?.candidateResults,
  primaryHypothesesEvaluated: value?.primaryHypothesesEvaluated,
  resamplingExecuted: value?.resamplingExecuted,
  resamplingResult: value?.resamplingResult,
  leakageSafeWalkForwardExecuted: value?.leakageSafeWalkForwardExecuted,
  eligibleCandidateIds: value?.eligibleCandidateIds,
  formalPromotionEligible: value?.formalPromotionEligible,
  selectedCandidateId: value?.selectedCandidateId,
  selectionPolicy: value?.selectionPolicy,
  onlineEffect: value?.onlineEffect,
});

const verifyTerminalJudgment = (suite, plan) => {
  const blockers = [];
  const judgment = suite?.terminalJudgment || null;
  const terminalEvents = (suite?.journal || []).filter(
    (event) => event.type === "terminal-judgment",
  );
  if (!judgment) {
    if (terminalEvents.length) blockers.push("G2-terminal-event-without-judgment");
    if (suite?.terminalJudgmentHash) blockers.push("G2-terminal-hash-without-judgment");
    return blockers;
  }
  if (sha256(judgment) !== suite.terminalJudgmentHash) {
    blockers.push("G2-terminal-judgment-hash-invalid");
  }
  if (terminalEvents.length !== 1) blockers.push("G2-terminal-judgment-count-invalid");
  const terminalEvent = terminalEvents[0] || {};
  if (
    terminalEvent.judgmentHash !== suite.terminalJudgmentHash
    || terminalEvent.planHash !== plan?.planHash
    || terminalEvent.datasetHash !== judgment.datasetHash
  ) blockers.push("G2-terminal-event-reference-invalid");
  const preTerminalSuite = structuredClone(suite);
  preTerminalSuite.journal = (preTerminalSuite.journal || []).filter(
    (event) => event.type !== "terminal-judgment",
  );
  preTerminalSuite.terminalJudgment = null;
  preTerminalSuite.terminalJudgmentHash = null;
  preTerminalSuite.rootHash = suiteRootHash(preTerminalSuite);
  if (
    judgment.version !== TERMINAL_EVALUATOR_VERSION
    || judgment.planHash !== plan?.planHash
    || judgment.sourceSuiteRootHashBeforeTerminal !== preTerminalSuite.rootHash
    || judgment.executionReady !== true
    || judgment.executed !== true
    || judgment.resamplingExecuted !== true
    || judgment.leakageSafeWalkForwardExecuted !== true
    || judgment.onlineEffect !== false
    || judgment.resamplingResult?.version !== RESAMPLING_VERSION
    || judgment.resamplingResult?.iterations !== RESAMPLING_ITERATIONS
    || judgment.resamplingResult?.primaryHypotheses !== PRIMARY_HYPOTHESIS_COUNT
    || Math.abs(
      Number(judgment.resamplingResult?.perHypothesisThreshold)
        - BONFERRONI_THRESHOLD,
    ) > 1e-15
  ) blockers.push("G2-terminal-judgment-schema-invalid");
  const terminalDataset = terminalDatasetForSuite(suite);
  if (
    terminalDataset.blockers.length
    || terminalDataset.datasetHash !== judgment.datasetHash
    || terminalDataset.commonRows !== judgment.commonRows
    || sha256(terminalDataset.rowCommitments) !== sha256(judgment.rowCommitments || [])
  ) blockers.push("G2-terminal-dataset-commitment-invalid");
  const cohortTerminals = (suite?.journal || []).filter(
    (event) => event.type === "cohort-terminal",
  );
  const decisionRows = cohortTerminals.filter((event) => event.terminalType === "decision");
  const exclusionRows = cohortTerminals.filter((event) => event.terminalType === "exclusion");
  const settlementRows = (suite?.journal || []).filter(
    (event) => event.type === "cohort-settlement",
  );
  const referenceRows = terminalDataset.rowsByCandidate[
    (plan?.arms || [])[0]?.candidate?.id
  ] || [];
  const invalidShare = cohortTerminals.length
    ? exclusionRows.length / cohortTerminals.length
    : 1;
  const singleAttestorShare = decisionRows.length
    ? decisionRows.filter((event) => event.singleAttestor === true).length / decisionRows.length
    : 1;
  const leagueCounts = new Map();
  for (const row of referenceRows) {
    const league = row.league || "unknown";
    leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
  }
  const qualifiedLeagues = [...leagueCounts.entries()].filter(
    ([league, rows]) => league !== "unknown" && rows >= MIN_ROWS_PER_LEAGUE,
  );
  const windowsPass = (plan?.windows || []).every((window) => {
    const rows = referenceRows.filter((row) => (
      row.businessDate >= window.startBusinessDate
      && row.businessDate < window.endBusinessDateExclusive
    ));
    const counts = new Map();
    for (const row of rows) counts.set(row.league, (counts.get(row.league) || 0) + 1);
    return rows.length >= MIN_ROWS_PER_WINDOW
      && counts.size >= MIN_LEAGUES_PER_WINDOW
      && Math.max(...counts.values()) / rows.length <= MAX_SINGLE_LEAGUE_SHARE_PER_WINDOW;
  });
  const trialIndexes = (suite?.trials || []).map((trial) => new Map(
    (activeLedgerFor(trial.registry)?.events || []).map((event) => [event.eventHash, event]),
  ));
  const atomicAndClockComplete = decisionRows.every((row) => (
    (suite?.trials || []).every((trial, index) => {
      const event = trialIndexes[index].get(row.trialEventHashes?.[trial.candidateId]);
      return event?.type === "decision"
        && Boolean(event.atomicDecisionHash)
        && Boolean(event.sourceClockHash);
    })
  ));
  const unknownRows = leagueCounts.get("unknown") || 0;
  const maximumLeagueShare = referenceRows.length
    ? Math.max(...leagueCounts.values()) / referenceRows.length
    : 1;
  if (
    parseTime(judgment.recordedAt) < parseTime(plan?.terminalEligibleAt)
    || referenceRows.length < MIN_TOTAL_SETTLED
    || settlementRows.length !== decisionRows.length
    || invalidShare > MAX_INVALID_SHARE
    || singleAttestorShare > MAX_SINGLE_ATTESTOR_SHARE
    || unknownRows / Math.max(1, referenceRows.length) > MAX_UNKNOWN_LEAGUE_SHARE
    || qualifiedLeagues.length < MIN_DISTINCT_LEAGUES
    || maximumLeagueShare > MAX_SINGLE_LEAGUE_SHARE
    || !windowsPass
    || !atomicAndClockComplete
  ) blockers.push("G2-terminal-structural-prerequisite-invalid");
  const results = Array.isArray(judgment.candidateResults)
    ? judgment.candidateResults
    : [];
  const verificationCacheKey = sha256({
    version: TERMINAL_EVALUATOR_VERSION,
    suiteRootHash: suite.rootHash,
    sourceSuiteRootHashBeforeTerminal: preTerminalSuite.rootHash,
    datasetHash: terminalDataset.datasetHash,
    planHash: plan?.planHash || null,
  });
  let expectedProjectionHash = terminalVerificationCache.get(verificationCacheKey) || null;
  if (expectedProjectionHash) {
    terminalVerificationCacheCounters.hits += 1;
  } else {
    terminalVerificationCacheCounters.misses += 1;
    const recomputedTerminal = terminalDataset.blockers.length
      ? null
      : evaluateFrozenTerminalRows({
        plan,
        rowsByCandidate: terminalDataset.rowsByCandidate,
        datasetHash: terminalDataset.datasetHash,
      });
    terminalVerificationCacheCounters.deterministicRecomputations += 1;
    expectedProjectionHash = recomputedTerminal
      ? sha256(terminalResultProjection(recomputedTerminal))
      : null;
    if (expectedProjectionHash) {
      if (terminalVerificationCache.size >= TERMINAL_VERIFICATION_CACHE_LIMIT) {
        terminalVerificationCache.delete(terminalVerificationCache.keys().next().value);
      }
      terminalVerificationCache.set(verificationCacheKey, expectedProjectionHash);
    }
  }
  if (!expectedProjectionHash
    || expectedProjectionHash !== sha256(terminalResultProjection(judgment))) {
    blockers.push("G2-terminal-deterministic-recomputation-mismatch");
  }
  const expectedIds = (plan?.arms || []).map((arm) => arm.candidate.id).sort();
  const resultIds = results.map((row) => row.candidateId).sort();
  if (sha256(expectedIds) !== sha256(resultIds)) {
    blockers.push("G2-terminal-candidate-result-inventory-invalid");
  }
  const promotableResults = results.filter((row) => row.promotable === true);
  if (
    promotableResults.length !== PROMOTABLE_ARM_COUNT
    || promotableResults.some((row) => (
      row.resampling?.brier?.iterations !== RESAMPLING_ITERATIONS
      || row.resampling?.logLoss?.iterations !== RESAMPLING_ITERATIONS
      || row.walkForward?.version !== WALK_FORWARD_RESULT_VERSION
      || row.leagueMacro?.version !== LEAGUE_MACRO_RESULT_VERSION
    ))
  ) blockers.push("G2-terminal-primary-result-schema-invalid");
  for (const row of results) {
    const expectedEligible = row.promotable === true
      && Number(row.fixedWindows?.dualMetricWinningWindows) >= MIN_WINNING_WINDOWS
      && row.walkForward?.pass === true
      && row.leagueMacro?.pass === true
      && row.resampling?.brier?.pass === true
      && row.resampling?.logLoss?.pass === true;
    if (row.formalPromotionEligible !== expectedEligible) {
      blockers.push("G2-terminal-candidate-gate-projection-invalid");
    }
    if (row.promotable === true && (
      !(Number(row.resampling?.brier?.bonferroniAdjustedOneSidedLowerBound) > 0)
      || !(Number(row.resampling?.logLoss?.bonferroniAdjustedOneSidedLowerBound) > 0)
      || Number(row.resampling?.brier?.oneSidedPValue) > BONFERRONI_THRESHOLD
      || Number(row.resampling?.logLoss?.oneSidedPValue) > BONFERRONI_THRESHOLD
    ) && row.formalPromotionEligible === true) {
      blockers.push("G2-terminal-adjusted-endpoint-gate-invalid");
    }
  }
  const control = results.find((row) => row.candidateId === MARKET_CONTROL_ID);
  if (!control || control.promotable !== false || control.formalPromotionEligible !== false) {
    blockers.push("G2-terminal-control-promotion-invalid");
  }
  const computedEligible = promotableResults
    .filter((row) => row.formalPromotionEligible === true)
    .map((row) => row.candidateId)
    .sort();
  const recordedEligible = Array.isArray(judgment.eligibleCandidateIds)
    ? judgment.eligibleCandidateIds.slice().sort()
    : [];
  if (
    sha256(computedEligible) !== sha256(recordedEligible)
    || judgment.formalPromotionEligible !== (computedEligible.length > 0)
    || judgment.selectedCandidateId !== null
  ) blockers.push("G2-terminal-eligibility-projection-invalid");
  return blockers;
};

const verifyCommonCohortShadowG2Suite = (suite) => {
  const blockers = [];
  if (!suite || typeof suite !== "object") return { valid: true, blockers };
  if (suite.version !== SUITE_VERSION) blockers.push("G2-suite-version-invalid");
  if (sha256(suite.header || {}) !== suite.headerHash) blockers.push("G2-header-hash-invalid");
  const plan = suite.header?.frozenPlan || null;
  if (!plan || plan.version !== PLAN_VERSION) blockers.push("G2-plan-version-invalid");
  if (plan?.planHash !== suite.header?.planHash) blockers.push("G2-plan-reference-invalid");
  if (plan) {
    const { planHash, ...body } = plan;
    if (sha256(body) !== planHash) blockers.push("G2-plan-hash-invalid");
    if (plan.onlineEffect !== false) blockers.push("G2-online-effect-invalid");
    if (sha256((plan.arms || []).map((arm) => ({
      candidate: candidateDefinition(arm.candidate),
      experimentRole: arm.experimentRole,
      promotable: arm.promotable === true,
    }))) !== sha256(exactArms())) blockers.push("G2-arm-inventory-invalid");
    if ((plan.arms || []).filter((arm) => arm.promotable).length !== PROMOTABLE_ARM_COUNT) {
      blockers.push("G2-promotable-arm-count-invalid");
    }
    if ((plan.arms || []).filter((arm) => !arm.promotable).length !== CONTROL_ARM_COUNT) {
      blockers.push("G2-control-arm-count-invalid");
    }
    if (plan.inputPolicy?.backfillPolicy !== "forbidden") blockers.push("G2-backfill-policy-invalid");
    if ((plan.windows || []).length !== WINDOW_COUNT) blockers.push("G2-window-count-invalid");
    const expectedWindows = buildBusinessDayWindows(plan.activationBusinessDate);
    if (sha256(plan.windows || []) !== sha256(expectedWindows)) {
      blockers.push("G2-window-boundaries-invalid");
    }
    if (
      plan.activationAt !== activationInstantFor(plan.activationBusinessDate)
      || plan.horizonEndBusinessDateExclusive
        !== expectedWindows.at(-1)?.endBusinessDateExclusive
      || Number(plan.settlementGraceDays) !== SETTLEMENT_GRACE_DAYS
      || plan.terminalEligibleBusinessDate
        !== addBusinessDays(
          plan.horizonEndBusinessDateExclusive,
          SETTLEMENT_GRACE_DAYS,
        )
      || plan.terminalEligibleAt
        !== activationInstantFor(plan.terminalEligibleBusinessDate)
    ) blockers.push("G2-future-window-clock-policy-invalid");
    const gates = plan.gates || {};
    const metricGate = gates.perArmTerminalMetricGate || {};
    if (
      Number(gates.minimumTotalSettled) !== MIN_TOTAL_SETTLED
      || Number(gates.minimumRowsPerWindow) !== MIN_ROWS_PER_WINDOW
      || Number(gates.minimumWinningWindows) !== MIN_WINNING_WINDOWS
      || Number(gates.maximumInvalidShare) !== MAX_INVALID_SHARE
      || Number(gates.maximumSingleAttestorShare) !== MAX_SINGLE_ATTESTOR_SHARE
      || Number(gates.maximumUnknownLeagueShare) !== MAX_UNKNOWN_LEAGUE_SHARE
      || Number(gates.minimumDistinctLeagues) !== MIN_DISTINCT_LEAGUES
      || Number(gates.minimumRowsPerLeague) !== MIN_ROWS_PER_LEAGUE
      || Number(gates.maximumSingleLeagueShare) !== MAX_SINGLE_LEAGUE_SHARE
      || Number(gates.minimumLeaguesPerWindow) !== MIN_LEAGUES_PER_WINDOW
      || Number(gates.maximumSingleLeagueSharePerWindow)
        !== MAX_SINGLE_LEAGUE_SHARE_PER_WINDOW
      || Number(gates.minimumPositiveQualifiedLeagueShare)
        !== MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE
      || Number(gates.requiredAtomicDecisionCoverage) !== 1
      || Number(gates.requiredSettlementCoverage) !== 1
      || Number(gates.requiredSourceClockCoverage) !== 1
      || Number(metricGate.minimumDualMetricWinningWindows)
        !== MIN_WINNING_WINDOWS
      || metricGate.requireBrierImprovementAboveZeroInWinningWindow !== true
      || metricGate.requireLogLossImprovementAboveZeroInWinningWindow !== true
      || metricGate.requireBonferroniAdjustedOneSidedBrierLowerBoundAboveZero !== true
      || metricGate.requireBonferroniAdjustedOneSidedLogLossLowerBoundAboveZero !== true
      || metricGate.requireLeagueMacroAverageBrierImprovementAboveZero !== true
      || metricGate.requireLeagueMacroAverageLogLossImprovementAboveZero !== true
      || Number(metricGate.minimumQualifiedLeagueDualMetricPositiveShare)
        !== MIN_POSITIVE_QUALIFIED_LEAGUE_SHARE
    ) blockers.push("G2-frozen-gates-invalid");
    const inference = plan.inference || {};
    const resampling = inference.resampling || {};
    if (
      inference.generation !== "G2"
      || Number(inference.familyAlpha) !== G2_ALPHA
      || Number(inference.promotableArmCount) !== PROMOTABLE_ARM_COUNT
      || Number(inference.primaryEndpointCount) !== PRIMARY_ENDPOINT_COUNT
      || Number(inference.primaryHypothesisCount) !== PRIMARY_HYPOTHESIS_COUNT
      || inference.adjustment !== "Bonferroni"
      || Math.abs(Number(inference.perHypothesisThreshold) - BONFERRONI_THRESHOLD) > 1e-15
      || resampling.version !== RESAMPLING_VERSION
      || resampling.unit !== "common-Sporttery-business-day"
      || Number(resampling.iterations) !== RESAMPLING_ITERATIONS
      || resampling.seedScope !== "frozen-plan-plus-terminal-common-dataset-only"
      || resampling.candidateAndEndpointExcludedFromSeed !== true
      || resampling.commonDrawScheduleAcrossAllHypotheses !== true
      || resampling.executionPolicy !== "execute-once-at-terminal-only"
      || resampling.resultBeforeTerminal !== null
    ) blockers.push("G2-frozen-inference-invalid");
    const walkForward = plan.leakageSafeWalkForward || {};
    if (
      walkForward.version !== "candidate-common-cohort-g2-leakage-safe-walk-forward-v2"
      || walkForward.independentPrerequisite !== true
      || Number(walkForward.warmupRows) !== WALK_FORWARD_WARMUP_ROWS
      || Number(walkForward.validationWindows) !== WALK_FORWARD_VALIDATION_WINDOWS
      || Number(walkForward.minimumRowsPerValidationWindow)
        !== WALK_FORWARD_ROWS_PER_WINDOW
      || Number(walkForward.minimumRowsIncludingWarmup)
        !== WALK_FORWARD_WARMUP_ROWS
          + WALK_FORWARD_VALIDATION_WINDOWS * WALK_FORWARD_ROWS_PER_WINDOW
      || walkForward.temporalOrderRequired !== true
      || walkForward.trainingMayOnlyUseRowsBeforeValidationWindow !== true
      || walkForward.businessDayAtomicityRequired !== true
      || walkForward.sameBusinessDateMayNotCrossBoundaries !== true
      || walkForward.validationAllocation
        !== "deterministic-balanced-contiguous-business-day-partition"
      || walkForward.executionPolicy
        !== "must-complete-before-the-only-terminal-judgment"
      || walkForward.resultBeforeTerminal !== null
    ) blockers.push("G2-frozen-walk-forward-invalid");
    const terminalPolicy = plan.terminalPolicy || {};
    if (
      terminalPolicy.version !== TERMINAL_POLICY_VERSION
      || Number(terminalPolicy.maximumJudgments) !== 1
      || terminalPolicy.requireWindowHorizonClosed !== true
      || Number(terminalPolicy.settlementGraceDays) !== SETTLEMENT_GRACE_DAYS
      || terminalPolicy.requireSettlementGraceElapsed !== true
      || terminalPolicy.requireAllAdmittedRowsSettled !== true
      || Number(terminalPolicy.requireAtomicDecisionCoverage) !== 1
      || Number(terminalPolicy.requireSettlementCoverage) !== 1
      || Number(terminalPolicy.requireSourceClockCoverage) !== 1
      || terminalPolicy.requireLeakageSafeWalkForwardPass !== true
      || terminalPolicy.requireLeagueGeneralizationPass !== true
      || terminalPolicy.checkpoints
        !== "descriptive-only-no-alpha-spend-no-promotion-decision"
      || terminalPolicy.onlineEffect !== false
    ) blockers.push("G2-frozen-terminal-policy-invalid");
  }
  blockers.push(...verifyAlphaLedger(suite.alphaLedger, plan?.planHash));
  const trials = Array.isArray(suite.trials) ? suite.trials : [];
  if (trials.length !== EXACT_ARMS.length) blockers.push("G2-trial-count-invalid");
  const seen = new Set();
  for (const trial of trials) {
    const candidateId = String(trial?.candidateId || "");
    if (!candidateId || seen.has(candidateId)) blockers.push("G2-trial-identity-invalid");
    seen.add(candidateId);
    const verification = verifyRegistry(trial?.registry);
    blockers.push(...verification.blockers.map((reason) => `${candidateId}:${reason}`));
    const ledger = activeLedgerFor(trial?.registry);
    if (ledger?.header?.baseCandidateId !== candidateId) {
      blockers.push(`${candidateId}:G2-ledger-candidate-mismatch`);
    }
    for (const event of terminalEventsFor(ledger)) {
      if (event.phase === "formal" && parseTime(event.decisionDeadlineAt) <= parseTime(plan?.activationAt)) {
        blockers.push(`${candidateId}:G2-pre-activation-row-present`);
      }
    }
  }
  blockers.push(...verifyJournal(suite));
  blockers.push(...verifyTerminalJudgment(suite, plan));
  if (suite.rootHash !== suiteRootHash(suite)) blockers.push("G2-suite-root-invalid");
  return { valid: blockers.length === 0, blockers: [...new Set(blockers)].sort() };
};

const commonCohortAudit = (suite, evaluatedAt) => {
  const plan = suite?.header?.frozenPlan || {};
  const terminals = (suite?.journal || []).filter((event) => event.type === "cohort-terminal");
  const settlements = (suite?.journal || []).filter((event) => event.type === "cohort-settlement");
  const decisionRows = terminals.filter((event) => event.terminalType === "decision");
  const excludedRows = terminals.filter((event) => event.terminalType === "exclusion");
  const settledIds = new Set(settlements.map((event) => event.identityHash));
  const settledDecisionRows = decisionRows.filter((event) => settledIds.has(event.identityHash));
  const invalidShare = terminals.length ? excludedRows.length / terminals.length : null;
  const singleAttestorRows = decisionRows.filter((event) => event.singleAttestor).length;
  const singleAttestorShare = decisionRows.length ? singleAttestorRows / decisionRows.length : null;
  const rowsByWindow = (plan.windows || []).map((window) => {
    const rows = settledDecisionRows.filter((event) => (
      event.businessDate >= window.startBusinessDate
      && event.businessDate < window.endBusinessDateExclusive
    ));
    const windowLeagueCounts = new Map();
    for (const row of rows) {
      const league = row.league || "unknown";
      windowLeagueCounts.set(league, (windowLeagueCounts.get(league) || 0) + 1);
    }
    return {
      ...window,
      settledRows: rows.length,
      distinctLeagues: new Set(rows.map((row) => row.league || "unknown")).size,
      maximumLeagueShare: rows.length
        ? Math.max(...windowLeagueCounts.values()) / rows.length
        : null,
    };
  });
  const leagueCounts = new Map();
  for (const row of settledDecisionRows) {
    const league = row.league || "unknown";
    leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
  }
  const leagueDistribution = [...leagueCounts.entries()]
    .map(([league, rows]) => ({ league, rows, share: settledDecisionRows.length ? rows / settledDecisionRows.length : 0 }))
    .sort((left, right) => right.rows - left.rows || left.league.localeCompare(right.league));
  const horizonEndAt = activationInstantFor(plan.horizonEndBusinessDateExclusive);
  const horizonClosed = parseTime(evaluatedAt) >= parseTime(horizonEndAt);
  const settlementGraceElapsed = parseTime(evaluatedAt) >= parseTime(plan.terminalEligibleAt);
  const pendingSettlements = Math.max(0, decisionRows.length - settledDecisionRows.length);
  const trialEventIndexes = suite.trials.map((trial) => new Map(
    (activeLedgerFor(trial.registry)?.events || []).map((event) => [event.eventHash, event]),
  ));
  const completeDecisionRows = decisionRows.filter((row) => (
    suite.trials.every((trial, index) => {
      const event = trialEventIndexes[index].get(row.trialEventHashes?.[trial.candidateId]);
      return event?.type === "decision" && Boolean(event.atomicDecisionHash);
    })
  )).length;
  const completeSourceClockRows = decisionRows.filter((row) => (
    suite.trials.every((trial, index) => {
      const event = trialEventIndexes[index].get(row.trialEventHashes?.[trial.candidateId]);
      return event?.type === "decision" && Boolean(event.sourceClockHash);
    })
  )).length;
  const atomicDecisionCoverage = decisionRows.length
    ? completeDecisionRows / decisionRows.length
    : null;
  const sourceClockCoverage = decisionRows.length
    ? completeSourceClockRows / decisionRows.length
    : null;
  const settlementCoverage = decisionRows.length
    ? settledDecisionRows.length / decisionRows.length
    : null;
  const structuralBlockers = [];
  if (settledDecisionRows.length < MIN_TOTAL_SETTLED) structuralBlockers.push(`settled:${settledDecisionRows.length}<${MIN_TOTAL_SETTLED}`);
  if (rowsByWindow.some((window) => window.settledRows < MIN_ROWS_PER_WINDOW)) structuralBlockers.push("G2-window-minimum-rows-not-met");
  if (!(invalidShare !== null && invalidShare <= MAX_INVALID_SHARE)) structuralBlockers.push("G2-invalid-share-too-high-or-missing");
  if (!(singleAttestorShare !== null && singleAttestorShare <= MAX_SINGLE_ATTESTOR_SHARE)) structuralBlockers.push("G2-single-attestor-share-too-high-or-missing");
  const unknownRows = leagueCounts.get("unknown") || 0;
  if (!settledDecisionRows.length || unknownRows / settledDecisionRows.length > MAX_UNKNOWN_LEAGUE_SHARE) structuralBlockers.push("G2-unknown-league-share-too-high");
  const qualifiedLeagues = leagueDistribution.filter((row) => row.league !== "unknown" && row.rows >= MIN_ROWS_PER_LEAGUE);
  if (qualifiedLeagues.length < MIN_DISTINCT_LEAGUES) structuralBlockers.push("G2-distinct-league-coverage-insufficient");
  if (leagueDistribution.some((row) => row.share > MAX_SINGLE_LEAGUE_SHARE)) structuralBlockers.push("G2-single-league-share-too-high");
  if (rowsByWindow.some((window) => window.distinctLeagues < MIN_LEAGUES_PER_WINDOW)) structuralBlockers.push("G2-window-league-diversity-insufficient");
  if (rowsByWindow.some((window) => (
    window.maximumLeagueShare === null
    || window.maximumLeagueShare > MAX_SINGLE_LEAGUE_SHARE_PER_WINDOW
  ))) structuralBlockers.push("G2-window-single-league-share-too-high");
  if (atomicDecisionCoverage !== 1) structuralBlockers.push("G2-atomic-decision-coverage-incomplete");
  if (settlementCoverage !== 1) structuralBlockers.push("G2-settlement-coverage-incomplete");
  if (sourceClockCoverage !== 1) structuralBlockers.push("G2-source-clock-coverage-incomplete");
  if (!suite.terminalJudgment?.leakageSafeWalkForwardExecuted) {
    structuralBlockers.push("G2-leakage-safe-walk-forward-not-executed");
  }
  const judgmentEvents = (suite?.journal || []).filter(
    (event) => event.type === "terminal-judgment",
  );
  return {
    version: AUDIT_VERSION,
    artifactGeneration: "G2-v2",
    artifactNamespaceVersion: "v2",
    legacyV1IgnoredForV2: true,
    evaluatedAt: isoTime(evaluatedAt),
    available: true,
    onlineEffect: false,
    planHash: plan.planHash || null,
    activationAt: plan.activationAt || null,
    activationBusinessDate: plan.activationBusinessDate || null,
    horizonEndBusinessDateExclusive: plan.horizonEndBusinessDateExclusive || null,
    horizonClosed,
    settlementGraceDays: Number(plan.settlementGraceDays || 0),
    terminalEligibleAt: plan.terminalEligibleAt || null,
    settlementGraceElapsed,
    cohort: {
      terminalRows: terminals.length,
      decisionRows: decisionRows.length,
      excludedRows: excludedRows.length,
      settledRows: settledDecisionRows.length,
      pendingSettlements,
      invalidShare,
      singleAttestorRows,
      singleAttestorShare,
      atomicDecisionCoverage,
      settlementCoverage,
      sourceClockCoverage,
    },
    windows: rowsByWindow,
    leagueGeneralization: {
      unknownRows,
      unknownShare: settledDecisionRows.length ? unknownRows / settledDecisionRows.length : null,
      qualifiedLeagueCount: qualifiedLeagues.length,
      distribution: leagueDistribution,
    },
    inference: {
      generation: "G2",
      alpha: G2_ALPHA,
      primaryHypothesisCount: PRIMARY_HYPOTHESIS_COUNT,
      bonferroniThreshold: BONFERRONI_THRESHOLD,
      resampling: {
        ...plan.inference?.resampling,
        executed: Boolean(suite.terminalJudgment?.resamplingExecuted),
        result: suite.terminalJudgment?.resamplingResult || null,
      },
    },
    terminal: {
      eligibleToEvaluate:
        horizonClosed
        && settlementGraceElapsed
        && pendingSettlements === 0,
      judgmentRecorded: Boolean(suite.terminalJudgment),
      judgmentCount: judgmentEvents.length,
      terminalEvaluatorImplemented: true,
      leakageSafeWalkForwardExecuted:
        Boolean(suite.terminalJudgment?.leakageSafeWalkForwardExecuted),
      leakageSafeWalkForwardPass:
        Boolean(suite.terminalJudgment?.candidateResults?.some(
          (row) => row.promotable === true && row.walkForward?.pass === true,
        )),
      formalPromotionEligible:
        Boolean(suite.terminalJudgment?.formalPromotionEligible),
      eligibleCandidateIds: suite.terminalJudgment?.eligibleCandidateIds || [],
      judgmentHash: suite.terminalJudgmentHash || null,
      datasetHash: suite.terminalJudgment?.datasetHash || null,
      checkpointPolicy: "descriptive-only",
    },
    structuralBlockers,
    chainValid: verifyCommonCohortShadowG2Suite(suite).valid,
  };
};

const evaluateTerminalProtocol = ({ suite, evaluatedAt = new Date().toISOString() } = {}) => {
  const plan = suite?.header?.frozenPlan || null;
  const audit = suite ? commonCohortAudit(suite, evaluatedAt) : null;
  const dataset = suite ? terminalDatasetForSuite(suite) : {
    rowsByCandidate: {},
    commonRows: 0,
    datasetHash: null,
    rowCommitments: [],
    blockers: ["G2-suite-missing"],
  };
  const prerequisiteBlockers = [];
  if (!audit?.chainValid) prerequisiteBlockers.push("G2-suite-chain-invalid");
  if (!audit?.horizonClosed) prerequisiteBlockers.push("G2-window-horizon-open");
  if (!audit?.settlementGraceElapsed) prerequisiteBlockers.push("G2-settlement-grace-not-elapsed");
  if (audit?.cohort?.pendingSettlements !== 0) {
    prerequisiteBlockers.push("G2-pending-settlements-remain");
  }
  prerequisiteBlockers.push(...(audit?.structuralBlockers || []).filter(
    (reason) => reason !== "G2-leakage-safe-walk-forward-not-executed",
  ));
  prerequisiteBlockers.push(...dataset.blockers);
  if (dataset.commonRows !== Number(audit?.cohort?.settledRows || 0)) {
    prerequisiteBlockers.push("G2-terminal-dataset-row-count-mismatch");
  }
  if (Object.keys(dataset.rowsByCandidate).length !== EXACT_ARMS.length) {
    prerequisiteBlockers.push("G2-terminal-dataset-arm-count-invalid");
  }
  const uniquePrerequisiteBlockers = [...new Set(prerequisiteBlockers)].sort();
  if (uniquePrerequisiteBlockers.length) {
    return canonicalize({
      version: TERMINAL_EVALUATOR_VERSION,
      evaluatedAt: isoTime(evaluatedAt),
      planHash: plan?.planHash || null,
      executionReady: false,
      executed: false,
      datasetHash: dataset.datasetHash,
      commonRows: dataset.commonRows,
      rowCommitments: dataset.rowCommitments,
      prerequisiteBlockers: uniquePrerequisiteBlockers,
      resamplingExecuted: false,
      resamplingResult: null,
      leakageSafeWalkForwardExecuted: false,
      candidateResults: [],
      eligibleCandidateIds: [],
      formalPromotionEligible: false,
      selectedCandidateId: null,
      onlineEffect: false,
    });
  }
  const protocol = evaluateFrozenTerminalRows({
    plan,
    rowsByCandidate: dataset.rowsByCandidate,
    datasetHash: dataset.datasetHash,
  });
  return canonicalize({
    ...protocol,
    evaluatedAt: isoTime(evaluatedAt),
    planHash: plan.planHash,
    executionReady: true,
    datasetHash: dataset.datasetHash,
    commonRows: dataset.commonRows,
    rowCommitments: dataset.rowCommitments,
    prerequisiteBlockers: [],
    structuralGateEvidence: {
      totalSettledRows: audit.cohort.settledRows,
      fixedWindowRows: audit.windows.map((window) => window.settledRows),
      invalidShare: audit.cohort.invalidShare,
      singleAttestorShare: audit.cohort.singleAttestorShare,
      atomicDecisionCoverage: audit.cohort.atomicDecisionCoverage,
      settlementCoverage: audit.cohort.settlementCoverage,
      sourceClockCoverage: audit.cohort.sourceClockCoverage,
      qualifiedLeagueCount: audit.leagueGeneralization.qualifiedLeagueCount,
      unknownLeagueShare: audit.leagueGeneralization.unknownShare,
    },
  });
};

const appendTerminalJudgment = ({ suite, evaluation, evaluatedAt }) => {
  if (!suite || suite.terminalJudgment) {
    return { suite, changed: false, reason: "G2-terminal-judgment-already-recorded" };
  }
  if (
    evaluation?.version !== TERMINAL_EVALUATOR_VERSION
    || evaluation.executionReady !== true
    || evaluation.executed !== true
    || evaluation.resamplingExecuted !== true
    || evaluation.leakageSafeWalkForwardExecuted !== true
  ) return { suite, changed: false, reason: "G2-terminal-prerequisites-incomplete" };
  const recordedAt = isoTime(evaluatedAt || evaluation.evaluatedAt);
  const sourceSuiteRootHashBeforeTerminal = suite.rootHash;
  const judgment = canonicalize({
    ...evaluation,
    recordedAt,
    sourceSuiteRootHashBeforeTerminal,
  });
  const judgmentHash = sha256(judgment);
  appendJournalEvent(suite, {
    type: "terminal-judgment",
    recordedAt,
    planHash: suite.header.frozenPlan.planHash,
    sourceSuiteRootHashBeforeTerminal,
    datasetHash: judgment.datasetHash,
    judgmentHash,
    commonRows: judgment.commonRows,
    resamplingIterations: RESAMPLING_ITERATIONS,
    formalPromotionEligible: judgment.formalPromotionEligible === true,
    eligibleCandidateIds: judgment.eligibleCandidateIds,
    appendOnly: true,
    recomputationAllowed: false,
  });
  suite.terminalJudgment = judgment;
  suite.terminalJudgmentHash = judgmentHash;
  suite.updatedAt = recordedAt;
  suite.rootHash = suiteRootHash(suite);
  return { suite, changed: true, reason: null };
};

const maybeFinalizeCommonCohortShadowG2Suite = ({ suite, evaluatedAt }) => {
  if (!suite || suite.terminalJudgment) {
    return { suite, changed: false, evaluation: suite?.terminalJudgment || null };
  }
  const evaluation = evaluateTerminalProtocol({ suite, evaluatedAt });
  const appended = appendTerminalJudgment({ suite, evaluation, evaluatedAt });
  return { suite: appended.suite, changed: appended.changed, evaluation };
};

const updateCommonCohortShadowG2Suite = ({
  priorSuite = null,
  plan = null,
  matches = [],
  snapshots = [],
  evaluatedAt = new Date().toISOString(),
  trustedCollectorCount = 1,
  trustedCollectorResolver = null,
  dueMatches = 0,
  evidenceQueryComplete = true,
} = {}) => {
  const priorVerification = verifyCommonCohortShadowG2Suite(priorSuite);
  if (!priorVerification.valid) return { suite: priorSuite, changed: false, chainValid: false, blockers: priorVerification.blockers, audit: null };
  if (Number(dueMatches || 0) > 0 && evidenceQueryComplete !== true) {
    return {
      suite: priorSuite,
      changed: false,
      chainValid: true,
      blockers: ["G2-deadline-evidence-query-incomplete"],
      audit: priorSuite ? { ...commonCohortAudit(priorSuite, evaluatedAt), skipped: true, reason: "G2-deadline-evidence-query-incomplete" } : null,
    };
  }
  if (!priorSuite && !plan) return { suite: null, changed: false, chainValid: true, blockers: ["G2-plan-not-registered"], audit: null };
  const suite = priorSuite ? structuredClone(priorSuite) : createSuite(plan);
  if (suite.terminalJudgment) {
    return { suite: priorSuite, changed: false, chainValid: true, blockers: [], audit: commonCohortAudit(priorSuite, evaluatedAt) };
  }
  const frozenPlan = suite.header.frozenPlan;
  const inputEligibility = inputEligibilityFor({ plan: frozenPlan, matches });
  const priorTrials = new Map((suite.trials || []).map((trial) => [trial.candidateId, trial]));
  const nextTrials = [];
  const blockers = [];
  let changed = !priorSuite;
  for (const arm of frozenPlan.arms || []) {
    const candidateId = arm.candidate.id;
    const priorTrial = priorTrials.get(candidateId) || null;
    const priorRoot = activeLedgerFor(priorTrial?.registry)?.rootHash || null;
    const update = updateCandidateProspectiveLedger({
      priorRegistry: priorTrial?.registry || null,
      candidates: frozenPlan.inventory,
      selectedCandidate: arm.candidate,
      robustness: arm.robustness,
      matches: inputEligibility.eligible,
      snapshots,
      evaluatedAt,
      implementationCommitment: frozenPlan.implementationCommitment,
      nominationPolicyCommitment: frozenPlan.nominationPolicyCommitment,
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    if (!update.chainValid) blockers.push(...update.blockers.map((reason) => `${candidateId}:${reason}`));
    const registry = update.chainValid ? update.registry : priorTrial?.registry || update.registry;
    const nextRoot = activeLedgerFor(registry)?.rootHash || null;
    changed = changed || !priorTrial || priorRoot !== nextRoot;
    nextTrials.push({ candidateId, registry });
  }
  suite.trials = nextTrials.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const journalBefore = journalRoot(suite.journal);
  blockers.push(...syncCaptureJournal({ suite, eligibleMatches: inputEligibility.eligible, evaluatedAt }));
  blockers.push(...syncSettlementJournal({ suite, evaluatedAt }));
  changed = changed || journalBefore !== journalRoot(suite.journal);
  if (changed) suite.updatedAt = isoTime(evaluatedAt);
  suite.rootHash = suiteRootHash(suite);
  let verification = verifyCommonCohortShadowG2Suite(suite);
  blockers.push(...verification.blockers);
  if (verification.valid && blockers.length === 0) {
    const terminal = maybeFinalizeCommonCohortShadowG2Suite({ suite, evaluatedAt });
    changed = changed || terminal.changed;
    verification = verifyCommonCohortShadowG2Suite(suite);
    blockers.push(...verification.blockers);
  }
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    audit: {
      ...commonCohortAudit(suite, evaluatedAt),
      inputEligibility: { ...inputEligibility, eligible: undefined },
      trialCount: suite.trials.length,
      promotableArmCount: PROMOTABLE_ARM_COUNT,
      controlArmCount: CONTROL_ARM_COUNT,
      suiteRootHash: suite.rootHash,
      chainValid: verification.valid && blockers.length === 0,
    },
  };
};

const settleCommonCohortShadowG2Suite = ({
  priorSuite = null,
  matches = [],
  evaluatedAt = new Date().toISOString(),
} = {}) => {
  const priorVerification = verifyCommonCohortShadowG2Suite(priorSuite);
  if (!priorVerification.valid || !priorSuite) {
    return { suite: priorSuite, changed: false, chainValid: priorVerification.valid, settlementsAdded: 0, blockers: priorVerification.blockers, audit: null };
  }
  if (priorSuite.terminalJudgment) {
    return { suite: priorSuite, changed: false, chainValid: true, settlementsAdded: 0, blockers: [], audit: commonCohortAudit(priorSuite, evaluatedAt) };
  }
  const suite = structuredClone(priorSuite);
  const blockers = [];
  let settlementsAdded = 0;
  let changed = false;
  for (const trial of suite.trials || []) {
    const update = settleCandidateProspectiveRegistry({ priorRegistry: trial.registry, matches, evaluatedAt });
    if (!update.chainValid) blockers.push(...update.blockers.map((reason) => `${trial.candidateId}:${reason}`));
    if (update.changed) trial.registry = update.registry;
    changed = changed || update.changed;
    settlementsAdded += Number(update.settlementsAdded || 0);
  }
  const journalBefore = journalRoot(suite.journal);
  blockers.push(...syncSettlementJournal({ suite, evaluatedAt }));
  changed = changed || journalBefore !== journalRoot(suite.journal);
  if (changed) suite.updatedAt = isoTime(evaluatedAt);
  suite.rootHash = suiteRootHash(suite);
  let verification = verifyCommonCohortShadowG2Suite(suite);
  blockers.push(...verification.blockers);
  if (verification.valid && blockers.length === 0) {
    const terminal = maybeFinalizeCommonCohortShadowG2Suite({ suite, evaluatedAt });
    changed = changed || terminal.changed;
    verification = verifyCommonCohortShadowG2Suite(suite);
    blockers.push(...verification.blockers);
  }
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    settlementsAdded,
    blockers: [...new Set(blockers)].sort(),
    audit: { ...commonCohortAudit(suite, evaluatedAt), settlementOnly: true, suiteRootHash: suite.rootHash },
  };
};

const compactCommonCohortShadowG2Public = (audit) => {
  if (!audit || typeof audit !== "object") return null;
  return {
    version: PUBLIC_AUDIT_VERSION,
    artifactGeneration: audit.artifactGeneration || "G2-v2",
    artifactNamespaceVersion: audit.artifactNamespaceVersion || "v2",
    legacyV1Preserved: audit.legacyV1Preserved === true,
    legacyV1IgnoredForV2: true,
    evaluatedAt: audit.evaluatedAt || null,
    available: audit.available === true,
    onlineEffect: false,
    chainValid: audit.chainValid === true,
    rootHash: audit.suiteRootHash || null,
    activationAt: audit.activationAt || null,
    activationBusinessDate: audit.activationBusinessDate || null,
    horizonEndBusinessDateExclusive: audit.horizonEndBusinessDateExclusive || null,
    trialCount: Number(audit.trialCount || PROMOTABLE_ARM_COUNT + CONTROL_ARM_COUNT),
    promotableArmCount: PROMOTABLE_ARM_COUNT,
    controlArmCount: CONTROL_ARM_COUNT,
    controlArmPromotionEligible: false,
    cohort: audit.cohort || null,
    windows: (audit.windows || []).map((window) => ({
      index: window.index,
      startBusinessDate: window.startBusinessDate,
      endBusinessDateExclusive: window.endBusinessDateExclusive,
      settledRows: Number(window.settledRows || 0),
      distinctLeagues: Number(window.distinctLeagues || 0),
    })),
    leagueGeneralization: audit.leagueGeneralization ? {
      unknownRows: Number(audit.leagueGeneralization.unknownRows || 0),
      unknownShare: audit.leagueGeneralization.unknownShare ?? null,
      qualifiedLeagueCount: Number(audit.leagueGeneralization.qualifiedLeagueCount || 0),
    } : null,
    inference: audit.inference || null,
    terminal: audit.terminal || null,
    structuralBlockerCount: Array.isArray(audit.structuralBlockers) ? audit.structuralBlockers.length : 0,
  };
};

module.exports = {
  ALPHA_LEDGER_VERSION,
  AUDIT_VERSION,
  BONFERRONI_THRESHOLD,
  EXACT_ARMS,
  G2_ALPHA,
  INPUT_POLICY_VERSION,
  JOURNAL_VERSION,
  MARKET_CONTROL_ID,
  PLAN_VERSION,
  PRIMARY_HYPOTHESIS_COUNT,
  PUBLIC_AUDIT_VERSION,
  RESAMPLING_ITERATIONS,
  RESAMPLING_VERSION,
  SUITE_VERSION,
  TERMINAL_POLICY_VERSION,
  TERMINAL_EVALUATOR_VERSION,
  WINDOW_COUNT,
  WINDOW_DAYS,
  WALK_FORWARD_RESULT_VERSION,
  appendTerminalJudgment,
  buildBusinessDayWindows,
  buildCommonCohortShadowG2Plan,
  businessDateForMatch,
  compactCommonCohortShadowG2Public,
  commonCohortAudit,
  evaluateFrozenTerminalRows,
  evaluateTerminalProtocol,
  exactArms,
  inputEligibilityFor,
  resetTerminalVerificationCache,
  settleCommonCohortShadowG2Suite,
  suiteRootHash,
  terminalVerificationCacheStats,
  trialLedgersFor,
  updateCommonCohortShadowG2Suite,
  verifyCommonCohortShadowG2Suite,
};
