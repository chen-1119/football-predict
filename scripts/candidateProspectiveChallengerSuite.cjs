"use strict";

const {
  auditLedger,
  candidateInventory,
  canonicalize,
  settleCandidateProspectiveRegistry,
  sha256,
  updateCandidateProspectiveLedger,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");

const SUITE_VERSION = "candidate-prospective-challenger-suite-v1";
const AUDIT_VERSION = "candidate-prospective-challenger-suite-audit-v1";
const PUBLIC_AUDIT_VERSION = "candidate-prospective-challenger-suite-public-v1";
const PUBLIC_CONTINUITY_VERSION =
  "candidate-prospective-challenger-suite-continuity-v1";
const PLAN_VERSION = "candidate-calibration-deescalation-plan-v1";
const NOMINATION_VERSION = "candidate-calibration-deescalation-nomination-v1";
const MAX_CHALLENGERS = 3;
const MIN_TRIGGER_ROWS = 4;
const MIN_NOMINATION_ROWS = 150;
const MIN_NOMINATION_WINDOWS = 4;
const MIN_NOMINATION_PASS_RATE = 0.6;

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const candidateDefinition = (candidate) => ({
  id: String(candidate?.id || ""),
  role: String(candidate?.role || ""),
  featureSet: Array.isArray(candidate?.featureSet)
    ? candidate.featureSet.map((value) => String(value))
    : [],
  weights: canonicalize(candidate?.weights || {}),
});

const nominationPolicyCommitment = () => ({
  version: NOMINATION_VERSION,
  onlineEffect: false,
  trigger:
    "after a disclosed active-trial calibration regression, preregister only less aggressive same-temperature candidates and evaluate future deadline rows",
  candidateFilter: {
    sameTemperatureAsActive: true,
    modelResidualMovesStrictlyTowardZero: true,
    marketAndModelWeightsSumToOne: true,
    retrospectiveRowsAtLeast: MIN_NOMINATION_ROWS,
    retrospectiveIndependentWindowsAtLeast: MIN_NOMINATION_WINDOWS,
    retrospectiveWindowPassRateAtLeast: MIN_NOMINATION_PASS_RATE,
    retrospectiveLogLossImprovementPositive: true,
    retrospectiveBrierImprovementPositive: true,
  },
  maximumChallengers: MAX_CHALLENGERS,
  futureOnly: true,
  backfillPolicy: "forbidden",
  replacementPolicy:
    "the frozen challenger suite never changes the active recommendation candidate; promotion requires its own 500-row and six-window prospective gate",
});

const calibrationTriggerEvidence = (activeAudit) => {
  const diagnostics = activeAudit?.metrics?.diagnostics || null;
  const counts = diagnostics?.attributionCounts || {};
  const formalRows = Number(activeAudit?.metrics?.formalRows || 0);
  const logLossImprovement = finite(activeAudit?.metrics?.logLossImprovement);
  const brierImprovement = finite(activeAudit?.metrics?.brierImprovement);
  const directionRegression = Number(counts.directionRegression || 0);
  const calibrationRegression = Number(counts.calibrationRegression || 0);
  const eligible = formalRows >= MIN_TRIGGER_ROWS
    && logLossImprovement !== null
    && logLossImprovement < 0
    && brierImprovement !== null
    && brierImprovement < 0
    && directionRegression === 0
    && calibrationRegression > 0;
  return {
    version: "candidate-calibration-trigger-evidence-v1",
    eligible,
    candidateRevisionId: activeAudit?.candidateRevisionId || null,
    evaluatedAt: activeAudit?.evaluatedAt || null,
    formalRows,
    logLossImprovement,
    brierImprovement,
    directionRegression,
    directionGain: Number(counts.directionGain || 0),
    calibrationRegression,
    calibrationGain: Number(counts.calibrationGain || 0),
    diagnosticVersion: diagnostics?.version || null,
    policy:
      "this is a disclosed post-hoc trigger only; all challenger evidence begins after the plan timestamp",
  };
};

const nominationEvidence = (candidate) => {
  const rows = Number(candidate?.metrics?.rows || 0);
  const windows = Number(candidate?.rolling?.windows || 0);
  const passRate = finite(candidate?.rolling?.passRate);
  const logLossImprovement = finite(candidate?.comparison?.logLossImprovement);
  const brierImprovement = finite(candidate?.comparison?.brierImprovement);
  const blockers = [];
  if (rows < MIN_NOMINATION_ROWS) blockers.push(`rows:${rows}<${MIN_NOMINATION_ROWS}`);
  if (windows < MIN_NOMINATION_WINDOWS) {
    blockers.push(`windows:${windows}<${MIN_NOMINATION_WINDOWS}`);
  }
  if (passRate === null || passRate < MIN_NOMINATION_PASS_RATE) {
    blockers.push(`window-pass-rate:${passRate ?? "missing"}<${MIN_NOMINATION_PASS_RATE}`);
  }
  if (!(logLossImprovement > 0)) blockers.push("log-loss-improvement-not-positive");
  if (!(brierImprovement > 0)) blockers.push("brier-improvement-not-positive");
  return {
    version: NOMINATION_VERSION,
    eligible: blockers.length === 0,
    rows,
    windows,
    passedWindows: Number(candidate?.rolling?.passed || 0),
    passRate,
    logLossImprovement,
    brierImprovement,
    blockers,
  };
};

const buildCalibrationDeescalationPlan = ({
  candidates = [],
  activeLedger = null,
  activeAudit = null,
  evaluatedAt = new Date().toISOString(),
  maximumChallengers = MAX_CHALLENGERS,
} = {}) => {
  const triggerEvidence = calibrationTriggerEvidence(activeAudit);
  if (!triggerEvidence.eligible || !activeLedger?.header) return null;
  const activeDefinition = activeLedger.header.candidateDefinition || {};
  const activeTemperature = finite(activeDefinition?.weights?.temperature);
  const activeModelWeight = finite(activeDefinition?.weights?.model);
  if (activeTemperature === null || activeModelWeight === null || !(activeModelWeight < 0)) {
    return null;
  }
  const implementationCommitment = canonicalize(
    activeLedger.header.candidateImplementation || {},
  );
  const frozenInventory = (Array.isArray(candidates) ? candidates : [])
    .map(candidateDefinition)
    .filter((candidate) => candidate.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const inventory = candidateInventory(frozenInventory, implementationCommitment);
  if (!inventory.entries.length) return null;
  const limit = Math.max(1, Math.min(MAX_CHALLENGERS, Number(maximumChallengers || 0)));
  const challengers = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => {
      if (!candidate?.id || candidate.id === activeDefinition.id) return false;
      const marketWeight = finite(candidate?.weights?.market);
      const modelWeight = finite(candidate?.weights?.model);
      const temperature = finite(candidate?.weights?.temperature);
      if (marketWeight === null || modelWeight === null || temperature === null) return false;
      if (Math.abs(temperature - activeTemperature) > 1e-9) return false;
      if (!(modelWeight > activeModelWeight && modelWeight <= 0)) return false;
      if (Math.abs(marketWeight + modelWeight - 1) > 1e-9) return false;
      return nominationEvidence(candidate).eligible;
    })
    .sort((left, right) => (
      finite(left?.weights?.model, 0) - finite(right?.weights?.model, 0)
      || String(left.id).localeCompare(String(right.id))
    ))
    .slice(0, limit)
    .map((candidate) => {
      const evidence = nominationEvidence(candidate);
      return {
        candidate: candidateDefinition(candidate),
        nominationEvidence: evidence,
        robustness: {
          version: NOMINATION_VERSION,
          role: "future-only-calibration-challenger-nomination",
          onlineEffect: false,
          family: {
            candidateCount: inventory.count,
            testedCandidateCount: Math.max(0, inventory.count - 1),
            primaryEndpointCount: 2,
            inventoryHash: inventory.hash,
          },
          selectedCandidate: {
            id: String(candidate.id),
            rows: evidence.rows,
            rollingWindows: evidence.windows,
            rollingPassRate: evidence.passRate,
            retrospectiveLogLossImprovement: evidence.logLossImprovement,
            retrospectiveBrierImprovement: evidence.brierImprovement,
          },
          nominationBlockers: [],
          candidateReadyForProspectiveTest: true,
          formalPromotionEligible: false,
          blockers: ["future-prospective-confirmation-required"],
          policy:
            "retrospective evidence may start this zero-online-effect challenger, but cannot promote it",
        },
      };
    });
  if (!challengers.length) return null;
  const body = canonicalize({
    version: PLAN_VERSION,
    createdAt: new Date(evaluatedAt).toISOString(),
    onlineEffect: false,
    sourceActiveCandidateRevisionId: activeLedger.header.candidateRevisionId || null,
    sourceActiveCandidateRootHash: activeLedger.rootHash || null,
    triggerEvidence,
    nominationPolicyCommitment: nominationPolicyCommitment(),
    implementationCommitment,
    inventory: frozenInventory,
    inventoryHash: inventory.hash,
    challengers,
  });
  return {
    ...body,
    planHash: sha256(body),
  };
};

const activeLedgerFor = (registry) => (
  Array.isArray(registry?.ledgers)
    ? registry.ledgers.find((ledger) => ledger?.ledgerId === registry.activeLedgerId) || null
    : null
);

const suiteRootHash = (suite) => sha256({
  version: SUITE_VERSION,
  headerHash: suite?.headerHash || null,
  trials: (Array.isArray(suite?.trials) ? suite.trials : [])
    .map((trial) => ({
      candidateId: String(trial?.candidateId || ""),
      registryRootHash: activeLedgerFor(trial?.registry)?.rootHash || null,
    }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
});

const createSuite = (plan) => {
  const header = canonicalize({
    version: SUITE_VERSION,
    createdAt: plan.createdAt,
    onlineEffect: false,
    planHash: plan.planHash,
    frozenPlan: plan,
    policy:
      "each challenger owns an independent append-only prospective registry; no challenger affects displayed recommendations",
  });
  const suite = {
    version: SUITE_VERSION,
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    header,
    headerHash: sha256(header),
    trials: [],
    rootHash: null,
  };
  suite.rootHash = suiteRootHash(suite);
  return suite;
};

const verifyChallengerSuite = (suite) => {
  const blockers = [];
  if (!suite || typeof suite !== "object") return { valid: true, blockers };
  if (suite.version !== SUITE_VERSION) blockers.push("suite-version-invalid");
  if (sha256(suite.header || {}) !== suite.headerHash) blockers.push("suite-header-hash-invalid");
  if (suite.header?.frozenPlan?.planHash !== suite.header?.planHash) {
    blockers.push("suite-plan-hash-reference-invalid");
  }
  const frozenPlan = suite.header?.frozenPlan || null;
  if (frozenPlan) {
    const { planHash, ...planBody } = frozenPlan;
    if (sha256(planBody) !== planHash) blockers.push("suite-plan-hash-invalid");
  }
  const candidateIds = new Set();
  for (const trial of Array.isArray(suite.trials) ? suite.trials : []) {
    const candidateId = String(trial?.candidateId || "");
    if (!candidateId || candidateIds.has(candidateId)) blockers.push("suite-trial-identity-invalid");
    candidateIds.add(candidateId);
    const verification = verifyRegistry(trial?.registry);
    if (!verification.valid) {
      blockers.push(...verification.blockers.map((reason) => `${candidateId}:${reason}`));
    }
    const ledger = activeLedgerFor(trial?.registry);
    if (ledger?.header?.baseCandidateId !== candidateId) {
      blockers.push(`${candidateId}:active-ledger-candidate-mismatch`);
    }
  }
  if (suite.rootHash !== suiteRootHash(suite)) blockers.push("suite-root-hash-invalid");
  return { valid: blockers.length === 0, blockers: [...new Set(blockers)].sort() };
};

const compactTrialAudit = (candidateId, audit, registry) => ({
  candidateId,
  candidateRevisionId: audit?.candidateRevisionId || null,
  state: audit?.state || null,
  chainValid: audit?.chainValid === true,
  rootHash: activeLedgerFor(registry)?.rootHash || null,
  onlineEffect: false,
  activationAt: audit?.activationAt || null,
  decisionRecord: audit?.decisionRecord || null,
  settlementRecord: audit?.settlementRecord || null,
  cohort: audit?.cohort || null,
  metrics: audit?.metrics ? {
    formalRows: Number(audit.metrics.formalRows || 0),
    logLossImprovement: audit.metrics.logLossImprovement ?? null,
    brierImprovement: audit.metrics.brierImprovement ?? null,
    diagnostics: audit.metrics.diagnostics || null,
    windows: Array.isArray(audit.metrics.windows) ? audit.metrics.windows : [],
    windowEvaluation: audit.metrics.windowEvaluation || null,
  } : null,
  promotionReviewReady: audit?.promotionReviewReady === true,
  formalPromotionEligible: audit?.formalPromotionEligible === true,
  blockers: Array.isArray(audit?.blockers) ? audit.blockers : [],
});

const nonNegativeInteger = (value) => Math.max(0, Math.trunc(Number(value || 0)));

const nullableFiniteRange = (values) => {
  const finiteValues = (Array.isArray(values) ? values : [])
    .map((value) => (
      value === null || value === undefined || value === ""
        ? null
        : finite(value, null)
    ))
    .filter((value) => value !== null);
  return finiteValues.length
    ? { min: Math.min(...finiteValues), max: Math.max(...finiteValues) }
    : { min: null, max: null };
};

const compactCalibrationChallengerSuitePublic = (audit) => {
  if (!audit || typeof audit !== "object") return null;
  const trials = Array.isArray(audit.trials) ? audit.trials : [];
  const counts = trials.map((trial) => {
    const admittedRows = nonNegativeInteger(trial?.decisionRecord?.admittedRows);
    const atomicRows = nonNegativeInteger(trial?.decisionRecord?.atomicRows);
    const settledRows = nonNegativeInteger(
      trial?.settlementRecord?.rows
      ?? trial?.settlementRecord?.settledRows
      ?? (
        Number(trial?.cohort?.shadow?.settled || 0)
        + Number(trial?.cohort?.formal?.settled || 0)
      ),
    );
    const excludedRows = nonNegativeInteger(
      Number(trial?.cohort?.shadow?.excluded || 0)
      + Number(trial?.cohort?.formal?.excluded || 0),
    );
    const formalRows = nonNegativeInteger(trial?.metrics?.formalRows);
    const eligibleWindows = nonNegativeInteger(
      trial?.metrics?.windowEvaluation?.eligibleWindows,
    );
    const winningWindows = nonNegativeInteger(
      trial?.metrics?.windowEvaluation?.winningWindows,
    );
    return {
      admittedRows,
      atomicRows,
      settledRows,
      excludedRows,
      formalRows,
      eligibleWindows,
      winningWindows,
    };
  });
  const range = (field) => ({
    min: counts.length ? Math.min(...counts.map((row) => row[field])) : 0,
    max: counts.length ? Math.max(...counts.map((row) => row[field])) : 0,
  });
  const admitted = range("admittedRows");
  const atomic = range("atomicRows");
  const settled = range("settledRows");
  const excluded = range("excludedRows");
  const formalRows = range("formalRows");
  const eligibleWindows = range("eligibleWindows");
  const winningWindows = range("winningWindows");
  const logLossImprovement = nullableFiniteRange(
    trials.map((trial) => trial?.metrics?.logLossImprovement),
  );
  const brierImprovement = nullableFiniteRange(
    trials.map((trial) => trial?.metrics?.brierImprovement),
  );
  const blockerCount = Array.isArray(audit.blockers) ? audit.blockers.length : 0;
  const trialCount = nonNegativeInteger(audit.trialCount ?? trials.length);
  const allTrialsActive = trialCount > 0
    && trials.length === trialCount
    && trials.every((trial) => trial?.state === "ACTIVE");
  const allTrialsShadowOnly = trialCount > 0
    && trials.length === trialCount
    && trials.every((trial) => trial?.onlineEffect === false);
  const decisionCoverageComplete = trialCount > 0
    && trials.length === trialCount
    && trials.every((trial) => (
      trial?.decisionRecord?.complete === true
      && Number(trial?.decisionRecord?.coverage) === 1
      && nonNegativeInteger(trial?.decisionRecord?.admittedRows)
        === nonNegativeInteger(trial?.decisionRecord?.atomicRows)
    ));
  const settlementCoverageComplete = trialCount > 0
    && trials.length === trialCount
    && trials.every((trial) => (
      trial?.settlementRecord?.complete === true
      && Number(trial?.settlementRecord?.coverage) === 1
    ));
  const metricCoverageComplete = trialCount > 0
    && trials.length === trialCount
    && trials.every((trial) => (
      trial?.metrics
      && nonNegativeInteger(trial.metrics.formalRows)
        === nonNegativeInteger(
          trial?.cohort?.formal?.settled,
        )
    ));
  const windowEvaluationCoverageComplete = metricCoverageComplete
    && trials.every((trial) => {
      const evaluation = trial?.metrics?.windowEvaluation || null;
      return evaluation
        && nonNegativeInteger(evaluation.registeredWindows) === 6
        && nonNegativeInteger(evaluation.requiredWindows) === 6
        && nonNegativeInteger(evaluation.requiredWinningWindows) === 5
        && nonNegativeInteger(evaluation.rowsAssigned)
          === nonNegativeInteger(trial?.metrics?.formalRows)
        && nonNegativeInteger(evaluation.unassignedRows) === 0
        && nonNegativeInteger(evaluation.reusedRows) === 0
        && evaluation.boundariesValid === true
        && evaluation.boundariesNonOverlapping === true;
    });
  const countParity = [admitted, atomic, settled, excluded]
    .every((item) => item.min === item.max);
  return {
    version: PUBLIC_AUDIT_VERSION,
    evaluatedAt: audit.evaluatedAt || null,
    available: audit.available === true,
    ok: audit.ok === true,
    skipped: audit.skipped === true,
    reason: audit.reason || null,
    onlineEffect: false,
    dueMatches: nonNegativeInteger(audit.dueMatches),
    changed: audit.changed === true,
    rootHash: audit.suiteRootHash || null,
    trialCount,
    chainValid: audit.chainValid === true,
    allTrialsActive,
    allTrialsShadowOnly,
    countParity,
    decisionCoverageComplete,
    settlementCoverageComplete,
    metricCoverageComplete,
    windowEvaluationCoverageComplete,
    admittedRows: admitted,
    atomicRows: atomic,
    settledRows: settled,
    excludedRows: excluded,
    formalRows,
    eligibleWindows,
    winningWindows,
    logLossImprovement,
    brierImprovement,
    promotionReviewReadyTrialCount: trials.filter(
      (trial) => trial?.promotionReviewReady === true,
    ).length,
    formalPromotionEligibleTrialCount: trials.filter(
      (trial) => trial?.formalPromotionEligible === true,
    ).length,
    progressUnits: counts.reduce((sum, row) => (
      sum + row.admittedRows + row.settledRows + row.excludedRows
    ), 0),
    blockerCount,
  };
};

const cleanCalibrationChallengerContinuity = (state = null) => ({
  version: PUBLIC_CONTINUITY_VERSION,
  observed: state?.observed === true,
  rootHash: typeof state?.rootHash === "string" ? state.rootHash : null,
  progressUnits: nonNegativeInteger(state?.progressUnits),
  checkedAt: state?.checkedAt || null,
  violation: state?.violation && typeof state.violation === "object"
    ? {
      code: String(state.violation.code || "challenger-continuity-invalid"),
      detectedAt: state.violation.detectedAt || null,
    }
    : null,
});

const advanceCalibrationChallengerContinuity = (priorState, summary, {
  checkedAt = new Date().toISOString(),
} = {}) => {
  const prior = cleanCalibrationChallengerContinuity(priorState);
  if (prior.violation) return prior;
  if (!summary || summary.available !== true) {
    return prior.observed
      ? {
        ...prior,
        checkedAt,
        violation: { code: "challenger-suite-disappeared", detectedAt: checkedAt },
      }
      : { ...prior, checkedAt };
  }
  const rootHash = typeof summary.rootHash === "string" ? summary.rootHash : null;
  const progressUnits = nonNegativeInteger(summary.progressUnits);
  let violation = null;
  if (!rootHash) {
    violation = { code: "challenger-root-missing", detectedAt: checkedAt };
  } else if (prior.observed && progressUnits < prior.progressUnits) {
    violation = { code: "challenger-progress-regressed", detectedAt: checkedAt };
  } else if (
    prior.observed
    && progressUnits === prior.progressUnits
    && rootHash !== prior.rootHash
  ) {
    violation = {
      code: "challenger-root-changed-without-progress",
      detectedAt: checkedAt,
    };
  } else if (
    prior.observed
    && progressUnits > prior.progressUnits
    && rootHash === prior.rootHash
  ) {
    violation = {
      code: "challenger-progress-changed-without-root",
      detectedAt: checkedAt,
    };
  }
  return {
    version: PUBLIC_CONTINUITY_VERSION,
    observed: true,
    rootHash,
    progressUnits,
    checkedAt,
    violation,
  };
};

const updateCalibrationChallengerSuite = ({
  priorSuite = null,
  plan = null,
  matches = [],
  snapshots = [],
  evaluatedAt = new Date().toISOString(),
  trustedCollectorCount = 1,
  trustedCollectorResolver = null,
} = {}) => {
  const priorVerification = verifyChallengerSuite(priorSuite);
  if (!priorVerification.valid) {
    return {
      suite: priorSuite,
      changed: false,
      chainValid: false,
      blockers: priorVerification.blockers,
      audit: null,
    };
  }
  if (!priorSuite && !plan) {
    return {
      suite: null,
      changed: false,
      chainValid: true,
      blockers: ["challenger-plan-not-triggered"],
      audit: {
        version: AUDIT_VERSION,
        evaluatedAt: new Date(evaluatedAt).toISOString(),
        available: false,
        onlineEffect: false,
        trialCount: 0,
        chainValid: true,
        blockers: ["challenger-plan-not-triggered"],
        trials: [],
      },
    };
  }
  const suite = priorSuite ? structuredClone(priorSuite) : createSuite(plan);
  const frozenPlan = suite.header.frozenPlan;
  const priorTrials = new Map(
    (Array.isArray(suite.trials) ? suite.trials : [])
      .map((trial) => [String(trial?.candidateId || ""), trial]),
  );
  const nextTrials = [];
  const trialAudits = [];
  const blockers = [];
  let changed = !priorSuite;
  for (const challenger of frozenPlan.challengers || []) {
    const candidateId = String(challenger?.candidate?.id || "");
    const priorTrial = priorTrials.get(candidateId) || null;
    const priorRegistry = priorTrial?.registry || null;
    const priorRootHash = activeLedgerFor(priorRegistry)?.rootHash || null;
    const update = updateCandidateProspectiveLedger({
      priorRegistry,
      candidates: frozenPlan.inventory,
      selectedCandidate: challenger.candidate,
      robustness: challenger.robustness,
      matches,
      snapshots,
      evaluatedAt,
      implementationCommitment: frozenPlan.implementationCommitment,
      nominationPolicyCommitment: frozenPlan.nominationPolicyCommitment,
      trustedCollectorCount,
      trustedCollectorResolver,
    });
    if (!update.chainValid) {
      blockers.push(...(update.blockers || []).map((reason) => `${candidateId}:${reason}`));
      nextTrials.push(priorTrial || { candidateId, registry: update.registry });
      continue;
    }
    const nextRootHash = activeLedgerFor(update.registry)?.rootHash || null;
    const trialChanged = !priorTrial || priorRootHash !== nextRootHash;
    const registry = trialChanged ? update.registry : priorRegistry;
    changed = changed || trialChanged;
    nextTrials.push({ candidateId, registry });
    trialAudits.push(compactTrialAudit(candidateId, update.audit, registry));
  }
  suite.trials = nextTrials.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (changed) suite.updatedAt = new Date(evaluatedAt).toISOString();
  suite.rootHash = suiteRootHash(suite);
  const verification = verifyChallengerSuite(suite);
  blockers.push(...verification.blockers);
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    audit: {
      version: AUDIT_VERSION,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      available: true,
      onlineEffect: false,
      planVersion: frozenPlan.version,
      planHash: frozenPlan.planHash,
      planCreatedAt: frozenPlan.createdAt,
      sourceActiveCandidateRevisionId: frozenPlan.sourceActiveCandidateRevisionId,
      sourceActiveCandidateRootHash: frozenPlan.sourceActiveCandidateRootHash,
      triggerEvidence: frozenPlan.triggerEvidence,
      suiteRootHash: suite.rootHash,
      trialCount: suite.trials.length,
      chainValid: verification.valid && blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      trials: trialAudits,
    },
  };
};

const settleCalibrationChallengerSuite = ({
  priorSuite = null,
  matches = [],
  evaluatedAt = new Date().toISOString(),
} = {}) => {
  const priorVerification = verifyChallengerSuite(priorSuite);
  if (!priorVerification.valid) {
    return {
      suite: priorSuite,
      changed: false,
      chainValid: false,
      settlementsAdded: 0,
      blockers: priorVerification.blockers,
      audit: null,
    };
  }
  if (!priorSuite) {
    return {
      suite: null,
      changed: false,
      chainValid: true,
      settlementsAdded: 0,
      blockers: ["challenger-plan-not-triggered"],
      audit: null,
    };
  }

  const suite = structuredClone(priorSuite);
  const blockers = [];
  const trialAudits = [];
  let settlementsAdded = 0;
  let changed = false;
  for (const trial of Array.isArray(suite.trials) ? suite.trials : []) {
    const candidateId = String(trial?.candidateId || "");
    const update = settleCandidateProspectiveRegistry({
      priorRegistry: trial?.registry || null,
      matches,
      evaluatedAt,
    });
    if (!update.chainValid) {
      blockers.push(...(update.blockers || []).map((reason) => `${candidateId}:${reason}`));
      continue;
    }
    if (update.changed) trial.registry = update.registry;
    changed = changed || update.changed;
    settlementsAdded += Number(update.settlementsAdded || 0);
    trialAudits.push(compactTrialAudit(candidateId, update.audit, update.registry));
  }
  if (changed) suite.updatedAt = new Date(evaluatedAt).toISOString();
  suite.rootHash = suiteRootHash(suite);
  const verification = verifyChallengerSuite(suite);
  blockers.push(...verification.blockers);
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    settlementsAdded,
    blockers: [...new Set(blockers)].sort(),
    audit: {
      version: AUDIT_VERSION,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      available: true,
      onlineEffect: false,
      settlementOnly: true,
      suiteRootHash: suite.rootHash,
      trialCount: suite.trials.length,
      chainValid: verification.valid && blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      trials: trialAudits,
    },
  };
};

module.exports = {
  AUDIT_VERSION,
  MAX_CHALLENGERS,
  NOMINATION_VERSION,
  PLAN_VERSION,
  PUBLIC_AUDIT_VERSION,
  PUBLIC_CONTINUITY_VERSION,
  SUITE_VERSION,
  advanceCalibrationChallengerContinuity,
  buildCalibrationDeescalationPlan,
  calibrationTriggerEvidence,
  cleanCalibrationChallengerContinuity,
  compactCalibrationChallengerSuitePublic,
  nominationPolicyCommitment,
  settleCalibrationChallengerSuite,
  updateCalibrationChallengerSuite,
  verifyChallengerSuite,
};
