"use strict";

const {
  atomicDecisionRecordValid,
  candidateInventory,
  canonicalize,
  decisionDeadlineFor,
  sameCohortIdentity,
  settleCandidateProspectiveRegistry,
  sha256,
  updateCandidateProspectiveLedger,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");
const {
  verifyChallengerSuite: verifyCalibrationChallengerSuite,
} = require("./candidateProspectiveChallengerSuite.cjs");

const SUITE_VERSION =
  "candidate-prospective-temperature-neutralization-suite-v1";
const AUDIT_VERSION =
  "candidate-prospective-temperature-neutralization-suite-audit-v1";
const PUBLIC_AUDIT_VERSION =
  "candidate-prospective-temperature-neutralization-suite-public-v1";
const PLAN_VERSION = "candidate-temperature-neutralization-plan-v1";
const NOMINATION_POLICY_VERSION =
  "candidate-temperature-neutralization-nomination-policy-v1";
const FAMILY_WISE_POLICY_VERSION =
  "candidate-cross-suite-family-wise-comparison-v1";
const INPUT_POLICY_VERSION =
  "candidate-temperature-neutralization-future-input-v1";

const RESIDUAL_MINUS_20_ID =
  "market-current-model-residual-minus-20-temperature-1";
const RESIDUAL_MINUS_10_ID =
  "market-current-model-residual-minus-10-temperature-1";
const MARKET_CONTROL_ID = "market-temperature-1-control";

const EXPECTED_ACTIVE_WEIGHTS = Object.freeze({
  market: 1.2,
  model: -0.2,
  temperature: 0.9,
});

const TEMPERATURE_NEUTRALIZATION_ARMS = Object.freeze([
  Object.freeze({
    candidate: Object.freeze({
      id: RESIDUAL_MINUS_20_ID,
      role: "shadow-temperature-neutralization-candidate",
      featureSet: Object.freeze([
        "sporttery-market",
        "current-probability-model",
        "negative-model-residual",
        "temperature-calibration",
      ]),
      weights: Object.freeze({ market: 1.2, model: -0.2, temperature: 1 }),
    }),
    experimentRole: "temperature-neutralization-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: RESIDUAL_MINUS_10_ID,
      role: "shadow-temperature-neutralization-candidate",
      featureSet: Object.freeze([
        "sporttery-market",
        "current-probability-model",
        "negative-model-residual",
        "temperature-calibration",
      ]),
      weights: Object.freeze({ market: 1.1, model: -0.1, temperature: 1 }),
    }),
    experimentRole: "temperature-neutralization-candidate",
    promotable: true,
  }),
  Object.freeze({
    candidate: Object.freeze({
      id: MARKET_CONTROL_ID,
      role: "shadow-market-control",
      featureSet: Object.freeze([
        "sporttery-market",
        "temperature-identity-control",
      ]),
      weights: Object.freeze({ market: 1, model: 0, temperature: 1 }),
    }),
    experimentRole: "non-promotable-market-control",
    promotable: false,
  }),
]);

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseTime = (value) => {
  const millis = Date.parse(value || "");
  return Number.isFinite(millis) ? millis : null;
};

const isoTime = (value) => {
  const millis = parseTime(value);
  return millis === null ? null : new Date(millis).toISOString();
};

const candidateDefinition = (candidate) => canonicalize({
  id: String(candidate?.id || ""),
  role: String(candidate?.role || ""),
  featureSet: Array.isArray(candidate?.featureSet)
    ? candidate.featureSet.map((value) => String(value))
    : [],
  weights: candidate?.weights || {},
});

const exactArms = () => TEMPERATURE_NEUTRALIZATION_ARMS.map((arm) => ({
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

const terminalEventsFor = (ledger) => (Array.isArray(ledger?.events)
  ? ledger.events.filter((event) => (
      event?.type === "decision" || event?.type === "exclusion"
    ))
  : []);

const sourceIsOfficialSporttery = (match) => (
  String(match?.source || "").trim().toLowerCase() === "sporttery"
  && (
    String(match?.id || match?.matchId || "").startsWith("sporttery_")
    || Boolean(String(match?.sourceMatchId || "").trim())
  )
);

const inputEligibilityFor = ({ plan, matches = [] } = {}) => {
  const activationAt = plan?.activationAt || plan?.createdAt || null;
  const activationMs = parseTime(activationAt);
  const rows = Array.isArray(matches) ? matches : [];
  const eligible = [];
  let referenceOrNonOfficial = 0;
  let preActivationDeadline = 0;
  let invalidClock = 0;
  for (const match of rows) {
    if (!sourceIsOfficialSporttery(match)) {
      referenceOrNonOfficial += 1;
      continue;
    }
    const deadline = decisionDeadlineFor(match);
    const kickoffMs = parseTime(match?.kickoffTime || match?.matchDate);
    if (
      activationMs === null
      || !Number.isFinite(deadline?.millis)
      || kickoffMs === null
    ) {
      invalidClock += 1;
      continue;
    }
    if (deadline.millis <= activationMs || kickoffMs <= activationMs) {
      preActivationDeadline += 1;
      continue;
    }
    eligible.push(match);
  }
  return {
    version: INPUT_POLICY_VERSION,
    activationAt: isoTime(activationAt),
    receivedMatches: rows.length,
    eligibleMatches: eligible.length,
    excludedReferenceOrNonOfficial: referenceOrNonOfficial,
    excludedPreActivationDeadline: preActivationDeadline,
    excludedInvalidClock: invalidClock,
    eligible,
    policy:
      "only official Sporttery matches whose immutable decision deadline and kickoff are strictly after plan activation may enter this suite; historical and 500-reference rows are never backfilled",
  };
};

const futureOnlyMatchesForSuite = (suite, matches = []) => inputEligibilityFor({
  plan: suite?.header?.frozenPlan || null,
  matches,
}).eligible;

const settlementMatchesForSuite = (suite, matches = []) => {
  const eligible = futureOnlyMatchesForSuite(suite, matches);
  const decisions = trialLedgersFor(suite)
    .flatMap((ledger) => (ledger?.events || []))
    .filter((event) => event?.type === "decision");
  return eligible.filter((match) => (
    decisions.some((decision) => sameCohortIdentity(decision, match))
  ));
};

const sameWeights = (left, right) => ["market", "model", "temperature"]
  .every((key) => Math.abs(finite(left?.[key], NaN) - right[key]) <= 1e-12);

const sourceChallengerArmDefinitions = (suite) => (
  Array.isArray(suite?.header?.frozenPlan?.challengers)
    ? suite.header.frozenPlan.challengers
      .map((row) => candidateDefinition(row?.candidate))
      .filter((candidate) => candidate.id)
    : []
);

const uniqueCandidateDefinitions = (candidates) => {
  const byId = new Map();
  for (const candidate of candidates) {
    const definition = candidateDefinition(candidate);
    if (!definition.id) continue;
    const prior = byId.get(definition.id);
    if (prior && sha256(prior) !== sha256(definition)) return null;
    byId.set(definition.id, definition);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const nominationPolicyCommitment = ({
  familyWiseComparison,
  exactArmHash,
} = {}) => canonicalize({
  version: NOMINATION_POLICY_VERSION,
  onlineEffect: false,
  futureOnly: true,
  backfillPolicy: "forbidden",
  inputPolicyVersion: INPUT_POLICY_VERSION,
  eligibleSource: "official-sporttery-atomic-decision-only",
  formalMetricMarket: "HAD",
  excludedFromFormalEvidence: [
    "500-reference",
    "historical-backfill",
    "pre-activation-deadline",
    "non-atomic-decision",
  ],
  exactArmHash,
  familyWiseComparison,
  controlPolicy: {
    candidateId: MARKET_CONTROL_ID,
    formalPromotionEligible: false,
    promotionPolicy: "never-promote-control-arm",
  },
  replacementPolicy:
    "the suite is shadow-only and cannot alter the active or displayed recommendation candidate",
});

const buildTemperatureNeutralizationPlan = ({
  activeLedger = null,
  calibrationChallengerSuite = null,
  evaluatedAt = new Date().toISOString(),
} = {}) => {
  const createdAt = isoTime(evaluatedAt);
  if (!createdAt || !activeLedger?.header || !calibrationChallengerSuite) return null;
  const sourceVerification = verifyCalibrationChallengerSuite(
    calibrationChallengerSuite,
  );
  if (!sourceVerification.valid) return null;
  const activeDefinition = activeLedger.header.candidateDefinition || {};
  if (!sameWeights(activeDefinition.weights, EXPECTED_ACTIVE_WEIGHTS)) return null;
  const sourceArms = sourceChallengerArmDefinitions(calibrationChallengerSuite);
  const arms = exactArms();
  const familyWiseInventory = uniqueCandidateDefinitions([
    ...sourceArms,
    ...arms.map((arm) => arm.candidate),
  ]);
  if (!familyWiseInventory) return null;
  const existingChallengerArmCount = Number(
    calibrationChallengerSuite?.trials?.length || 0,
  );
  if (
    sourceArms.length !== existingChallengerArmCount
    || familyWiseInventory.length !== existingChallengerArmCount + arms.length
  ) return null;
  const implementationCommitment = canonicalize(
    activeLedger.header.candidateImplementation || {},
  );
  const inventory = candidateInventory(
    familyWiseInventory,
    implementationCommitment,
  );
  const familyWiseComparison = canonicalize({
    version: FAMILY_WISE_POLICY_VERSION,
    existingChallengerArmCount,
    temperatureNeutralizationArmCount: arms.length,
    totalExperimentArmCount: familyWiseInventory.length,
    sourceActiveComparatorCount: 1,
    totalProspectiveTracksIncludingActive: familyWiseInventory.length + 1,
    primaryEndpointCount: 2,
    totalPrimaryHypothesisCount: familyWiseInventory.length * 2,
    candidateRegistryTestedCount: inventory.count,
    inventoryHash: inventory.hash,
    policy:
      "all arms from the frozen calibration-deescalation suite and this suite share one disclosed family-wise comparison count",
  });
  const exactArmHash = sha256(arms);
  const nominationPolicy = nominationPolicyCommitment({
    familyWiseComparison,
    exactArmHash,
  });
  const plannedArms = arms.map((arm) => ({
    ...arm,
    promotionPolicy: arm.promotable
      ? "independent-500-row-six-window-prospective-gate-required"
      : "never-promote-control-arm",
    robustness: {
      version: NOMINATION_POLICY_VERSION,
      role: arm.experimentRole,
      onlineEffect: false,
      family: {
        candidateCount: inventory.count,
        testedCandidateCount: familyWiseInventory.length,
        primaryEndpointCount: 2,
        inventoryHash: inventory.hash,
        crossSuiteFamilyWisePolicyVersion: FAMILY_WISE_POLICY_VERSION,
      },
      selectedCandidate: { id: arm.candidate.id },
      candidateReadyForProspectiveTest: true,
      formalPromotionEligible: false,
      blockers: arm.promotable
        ? ["future-prospective-confirmation-required"]
        : ["control-arm-non-promotable"],
    },
  }));
  const body = canonicalize({
    version: PLAN_VERSION,
    createdAt,
    activationAt: createdAt,
    onlineEffect: false,
    sourceActiveCandidateRevisionId:
      activeLedger.header.candidateRevisionId || null,
    sourceActiveCandidateRootHash: activeLedger.rootHash || null,
    sourceCalibrationChallengerSuite: {
      version: calibrationChallengerSuite.version || null,
      headerHash: calibrationChallengerSuite.headerHash || null,
      planHash: calibrationChallengerSuite.header?.planHash || null,
      rootHashAtRegistration: calibrationChallengerSuite.rootHash || null,
      trialCountAtRegistration: existingChallengerArmCount,
    },
    inputPolicy: {
      version: INPUT_POLICY_VERSION,
      futureOnly: true,
      decisionDeadlineStrictlyAfterActivation: true,
      captureOnlyAfterDeadlineFinalization: true,
      officialSportteryOnly: true,
      backfillPolicy: "forbidden",
      reference500Policy: "excluded-before-ledger",
    },
    familyWiseComparison,
    implementationCommitment,
    familyWiseInventory,
    exactArmHash,
    arms: plannedArms,
    nominationPolicyCommitment: nominationPolicy,
  });
  return { ...body, planHash: sha256(body) };
};

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
    activationAt: plan.activationAt,
    onlineEffect: false,
    planHash: plan.planHash,
    frozenPlan: plan,
    storeIsolation:
      "this suite owns separate registries and a separate artifact; it never mutates the calibration-deescalation suite",
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

const sharedDecisionInput = (event) => canonicalize({
  type: event?.type || null,
  phase: event?.phase || null,
  kickoffAt: isoTime(event?.kickoffAt),
  market: String(event?.market || "HAD").toUpperCase(),
  decisionDeadlineAt: event?.decisionDeadlineAt || null,
  captureFinalizationAt: event?.captureFinalizationAt || null,
  snapshotHash: event?.snapshotHash || null,
  decisionSnapshotHash: event?.decisionSnapshotHash || null,
  odds: event?.odds || null,
  marketProbabilities: event?.marketProbabilities || null,
  baseModelProbabilities: event?.baseModelProbabilities || null,
  featureSnapshotHash: event?.featureSnapshotHash || null,
  strategyVersions: (() => {
    const {
      candidateRevisionId: ignoredCandidateRevisionId,
      ...sharedVersions
    } = event?.strategyVersions || {};
    void ignoredCandidateRevisionId;
    return sharedVersions;
  })(),
  sourceClockHash: event?.sourceClockHash || null,
  dualMarketDecisionHash: event?.dualMarketDecisionHash || null,
  marketProvenanceHash: event?.marketProvenanceHash || null,
  collectorAttestationCommitmentHash:
    event?.collectorAttestationCommitmentHash || null,
  blockers: Array.isArray(event?.blockers) ? event.blockers : [],
});

const batchParityAudit = (suite) => {
  const ledgers = trialLedgersFor(suite);
  const rowsByTrial = ledgers.map((ledger) => terminalEventsFor(ledger).slice());
  const reference = rowsByTrial[0] || [];
  const alignedRowsByTrial = rowsByTrial.map((rows) => {
    if (rows.length !== reference.length) return null;
    const used = new Set();
    const aligned = reference.map((referenceEvent) => {
      const matches = rows
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => (
          !used.has(index) && sameCohortIdentity(referenceEvent, event)
        ));
      if (matches.length !== 1) return null;
      used.add(matches[0].index);
      return matches[0].event;
    });
    return aligned.every(Boolean) && used.size === rows.length ? aligned : null;
  });
  const identityParity = alignedRowsByTrial.every(Boolean);
  const terminalTypeParity = identityParity && alignedRowsByTrial.every((rows) => (
    rows.every((event, index) => event?.type === reference[index]?.type)
  ));
  const sharedInputParity = terminalTypeParity && alignedRowsByTrial.every((rows) => (
    rows.every((event, index) => (
      sha256(sharedDecisionInput(event))
        === sha256(sharedDecisionInput(reference[index]))
    ))
  ));
  const decisions = rowsByTrial.flat().filter((event) => event?.type === "decision");
  const exclusions = rowsByTrial.flat().filter((event) => event?.type === "exclusion");
  return {
    version: "candidate-temperature-neutralization-batch-parity-v1",
    trialCount: ledgers.length,
    terminalRowsPerTrial: rowsByTrial.map((rows) => rows.length),
    decisionRowsPerTrial: rowsByTrial.map((rows) => (
      rows.filter((event) => event?.type === "decision").length
    )),
    exclusionRowsPerTrial: rowsByTrial.map((rows) => (
      rows.filter((event) => event?.type === "exclusion").length
    )),
    identityParity,
    terminalTypeParity,
    sharedInputParity,
    atomicDecisionComplete:
      decisions.every((event) => atomicDecisionRecordValid(event)),
    allFormal: rowsByTrial.flat().every((event) => event?.phase === "formal"),
    excludedRowsOutsideFormalMetricDenominator: exclusions.length,
    complete:
      ledgers.length === TEMPERATURE_NEUTRALIZATION_ARMS.length
      && identityParity
      && terminalTypeParity
      && sharedInputParity
      && decisions.every((event) => atomicDecisionRecordValid(event))
      && rowsByTrial.flat().every((event) => event?.phase === "formal"),
  };
};

const verifyTemperatureNeutralizationSuite = (suite) => {
  const blockers = [];
  if (!suite || typeof suite !== "object") return { valid: true, blockers };
  if (suite.version !== SUITE_VERSION) blockers.push("suite-version-invalid");
  if (sha256(suite.header || {}) !== suite.headerHash) {
    blockers.push("suite-header-hash-invalid");
  }
  const plan = suite.header?.frozenPlan || null;
  if (!plan || plan.version !== PLAN_VERSION) blockers.push("suite-plan-version-invalid");
  if (plan?.planHash !== suite.header?.planHash) {
    blockers.push("suite-plan-hash-reference-invalid");
  }
  if (plan) {
    const { planHash, ...body } = plan;
    if (sha256(body) !== planHash) blockers.push("suite-plan-hash-invalid");
    if (plan.onlineEffect !== false) blockers.push("suite-plan-online-effect-invalid");
    if (plan.inputPolicy?.backfillPolicy !== "forbidden") {
      blockers.push("suite-backfill-policy-invalid");
    }
    if (plan.inputPolicy?.reference500Policy !== "excluded-before-ledger") {
      blockers.push("suite-reference-policy-invalid");
    }
    const expected = exactArms();
    const actual = (Array.isArray(plan.arms) ? plan.arms : []).map((arm) => ({
      candidate: candidateDefinition(arm?.candidate),
      experimentRole: arm?.experimentRole,
      promotable: arm?.promotable === true,
    }));
    if (sha256(actual) !== plan.exactArmHash) {
      blockers.push("suite-exact-arm-hash-invalid");
    }
    if (sha256(actual) !== sha256(expected)) blockers.push("suite-exact-arms-invalid");
    const family = plan.familyWiseComparison || {};
    const expectedTotal = Number(family.existingChallengerArmCount || 0)
      + TEMPERATURE_NEUTRALIZATION_ARMS.length;
    if (Number(family.temperatureNeutralizationArmCount) !== 3) {
      blockers.push("suite-temperature-arm-count-invalid");
    }
    if (Number(family.totalExperimentArmCount) !== expectedTotal) {
      blockers.push("suite-family-wise-total-arm-count-invalid");
    }
    if (
      Number(family.candidateRegistryTestedCount)
      !== Number(family.totalExperimentArmCount)
    ) blockers.push("suite-family-wise-registry-count-invalid");
  }
  const trials = Array.isArray(suite.trials) ? suite.trials : [];
  if (trials.length !== TEMPERATURE_NEUTRALIZATION_ARMS.length) {
    blockers.push("suite-trial-count-invalid");
  }
  const expectedById = new Map(exactArms().map((arm) => [arm.candidate.id, arm]));
  const seen = new Set();
  const activationMs = parseTime(plan?.activationAt || plan?.createdAt);
  for (const trial of trials) {
    const candidateId = String(trial?.candidateId || "");
    if (!candidateId || seen.has(candidateId) || !expectedById.has(candidateId)) {
      blockers.push("suite-trial-identity-invalid");
    }
    seen.add(candidateId);
    const registryVerification = verifyRegistry(trial?.registry);
    if (!registryVerification.valid) {
      blockers.push(...registryVerification.blockers.map(
        (reason) => `${candidateId}:${reason}`,
      ));
    }
    const ledger = activeLedgerFor(trial?.registry);
    const expected = expectedById.get(candidateId);
    if (!ledger || ledger.header?.baseCandidateId !== candidateId) {
      blockers.push(`${candidateId}:active-ledger-candidate-mismatch`);
      continue;
    }
    if (sha256(candidateDefinition(ledger.header?.candidateDefinition))
        !== sha256(expected?.candidate || {})) {
      blockers.push(`${candidateId}:candidate-definition-mismatch`);
    }
    if (
      Number(ledger.header?.totalCandidatesEverTestedAtFreeze || 0)
      !== Number(plan?.familyWiseComparison?.totalExperimentArmCount || 0)
    ) blockers.push(`${candidateId}:family-wise-trial-count-mismatch`);
    const activation = (ledger.events || []).find((event) => event?.type === "activation");
    if (parseTime(activation?.activationAt) !== activationMs) {
      blockers.push(`${candidateId}:activation-time-mismatch`);
    }
    if (
      candidateId === MARKET_CONTROL_ID
      && (ledger.events || []).some((event) => event?.type === "promotion")
    ) blockers.push(`${candidateId}:control-arm-promotion-forbidden`);
    for (const event of terminalEventsFor(ledger)) {
      const deadlineMs = parseTime(event?.decisionDeadlineAt);
      const finalizationMs = parseTime(
        event?.captureFinalizationAt || event?.decisionDeadlineAt,
      );
      const recordedMs = parseTime(event?.recordedAt);
      if (event?.phase !== "formal") {
        blockers.push(`${candidateId}:non-formal-terminal-row-forbidden`);
      }
      if (
        activationMs === null
        || deadlineMs === null
        || deadlineMs <= activationMs
      ) blockers.push(`${candidateId}:pre-activation-deadline-row-forbidden`);
      if (
        recordedMs === null
        || finalizationMs === null
        || recordedMs < finalizationMs
      ) blockers.push(`${candidateId}:pre-finalization-capture-forbidden`);
      if (event?.type === "decision" && (
        event?.sourceClass !== "official"
        || event?.admissionEligible !== true
        || !atomicDecisionRecordValid(event)
      )) blockers.push(`${candidateId}:non-atomic-formal-decision-forbidden`);
      if (event?.type === "decision" && (
        event?.candidateRevisionId !== ledger.header?.candidateRevisionId
        || event?.strategyVersions?.candidateRevisionId
          !== ledger.header?.candidateRevisionId
      )) blockers.push(`${candidateId}:candidate-specific-strategy-binding-invalid`);
    }
  }
  const parity = batchParityAudit(suite);
  if (!parity.identityParity) blockers.push("suite-batch-identity-parity-invalid");
  if (!parity.terminalTypeParity) blockers.push("suite-batch-terminal-type-parity-invalid");
  if (!parity.sharedInputParity) blockers.push("suite-batch-shared-input-parity-invalid");
  if (!parity.atomicDecisionComplete) blockers.push("suite-batch-atomic-coverage-invalid");
  if (!parity.allFormal) blockers.push("suite-batch-formal-phase-invalid");
  if (suite.rootHash !== suiteRootHash(suite)) blockers.push("suite-root-hash-invalid");
  return { valid: blockers.length === 0, blockers: [...new Set(blockers)].sort() };
};

const compactTrialAudit = ({ arm, audit, registry }) => {
  const control = arm.candidate.id === MARKET_CONTROL_ID;
  return {
    candidateId: arm.candidate.id,
    experimentRole: arm.experimentRole,
    promotable: !control && arm.promotable === true,
    candidateRevisionId: audit?.candidateRevisionId || null,
    state: audit?.state || null,
    chainValid: audit?.chainValid === true,
    rootHash: activeLedgerFor(registry)?.rootHash || null,
    onlineEffect: false,
    activationAt: audit?.activationAt || null,
    decisionRecord: audit?.decisionRecord || null,
    settlementRecord: audit?.settlementRecord || null,
    cohort: audit?.cohort || null,
    metrics: audit?.metrics || null,
    promotionReviewReady: control ? false : audit?.promotionReviewReady === true,
    formalPromotionEligible:
      control ? false : audit?.formalPromotionEligible === true,
    permanentBlockers: control ? ["control-arm-non-promotable"] : [],
    blockers: [
      ...(Array.isArray(audit?.blockers) ? audit.blockers : []),
      ...(control ? ["control-arm-non-promotable"] : []),
    ],
  };
};

const updateTemperatureNeutralizationSuite = ({
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
  const priorVerification = verifyTemperatureNeutralizationSuite(priorSuite);
  if (!priorVerification.valid) {
    return {
      suite: priorSuite,
      changed: false,
      chainValid: false,
      blockers: priorVerification.blockers,
      audit: null,
    };
  }
  if (Number(dueMatches || 0) > 0 && evidenceQueryComplete !== true) {
    const frozenPlan = priorSuite?.header?.frozenPlan || plan || null;
    return {
      suite: priorSuite,
      changed: false,
      chainValid: true,
      blockers: [
        "temperature-neutralization-deadline-evidence-query-incomplete",
      ],
      audit: {
        version: AUDIT_VERSION,
        evaluatedAt: isoTime(evaluatedAt),
        available: Boolean(priorSuite),
        onlineEffect: false,
        skipped: true,
        reason: "temperature-neutralization-deadline-evidence-query-incomplete",
        dueMatches: Math.max(0, Math.trunc(Number(dueMatches || 0))),
        planVersion: frozenPlan?.version || null,
        planHash: frozenPlan?.planHash || null,
        suiteRootHash: priorSuite?.rootHash || null,
        familyWiseComparison: frozenPlan?.familyWiseComparison || null,
        chainValid: true,
        blockers: [
          "temperature-neutralization-deadline-evidence-query-incomplete",
        ],
        trials: [],
      },
    };
  }
  if (!priorSuite && !plan) {
    return {
      suite: null,
      changed: false,
      chainValid: true,
      blockers: ["temperature-neutralization-plan-not-registered"],
      audit: {
        version: AUDIT_VERSION,
        evaluatedAt: isoTime(evaluatedAt),
        available: false,
        onlineEffect: false,
        trialCount: 0,
        blockers: ["temperature-neutralization-plan-not-registered"],
        trials: [],
      },
    };
  }
  const suite = priorSuite ? structuredClone(priorSuite) : createSuite(plan);
  const frozenPlan = suite.header.frozenPlan;
  const inputEligibility = inputEligibilityFor({ plan: frozenPlan, matches });
  const priorTrials = new Map(
    (Array.isArray(suite.trials) ? suite.trials : [])
      .map((trial) => [String(trial?.candidateId || ""), trial]),
  );
  const nextTrials = [];
  const trialAudits = [];
  const blockers = [];
  let changed = !priorSuite;
  for (const arm of frozenPlan.arms || []) {
    const candidateId = String(arm?.candidate?.id || "");
    const priorTrial = priorTrials.get(candidateId) || null;
    const priorRegistry = priorTrial?.registry || null;
    const priorRootHash = activeLedgerFor(priorRegistry)?.rootHash || null;
    const update = updateCandidateProspectiveLedger({
      priorRegistry,
      candidates: frozenPlan.familyWiseInventory,
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
    if (!update.chainValid) {
      blockers.push(...(update.blockers || []).map(
        (reason) => `${candidateId}:${reason}`,
      ));
      nextTrials.push(priorTrial || { candidateId, registry: update.registry });
      continue;
    }
    const nextRootHash = activeLedgerFor(update.registry)?.rootHash || null;
    const trialChanged = !priorTrial || priorRootHash !== nextRootHash;
    const registry = trialChanged ? update.registry : priorRegistry;
    changed = changed || trialChanged;
    nextTrials.push({ candidateId, registry });
    trialAudits.push(compactTrialAudit({ arm, audit: update.audit, registry }));
  }
  suite.trials = nextTrials.sort((left, right) => (
    left.candidateId.localeCompare(right.candidateId)
  ));
  if (changed) suite.updatedAt = isoTime(evaluatedAt);
  suite.rootHash = suiteRootHash(suite);
  const verification = verifyTemperatureNeutralizationSuite(suite);
  blockers.push(...verification.blockers);
  const batchParity = batchParityAudit(suite);
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    audit: {
      version: AUDIT_VERSION,
      evaluatedAt: isoTime(evaluatedAt),
      available: true,
      onlineEffect: false,
      planVersion: frozenPlan.version,
      planHash: frozenPlan.planHash,
      planCreatedAt: frozenPlan.createdAt,
      activationAt: frozenPlan.activationAt,
      suiteRootHash: suite.rootHash,
      sourceActiveCandidateRevisionId:
        frozenPlan.sourceActiveCandidateRevisionId,
      sourceCalibrationChallengerSuite:
        frozenPlan.sourceCalibrationChallengerSuite,
      familyWiseComparison: frozenPlan.familyWiseComparison,
      inputEligibility: {
        ...inputEligibility,
        eligible: undefined,
      },
      formalEvidencePolicy: {
        version: INPUT_POLICY_VERSION,
        officialSportteryAtomicOnly: true,
        historicalBackfillRows: 0,
        reference500Rows: 0,
      },
      trialCount: suite.trials.length,
      controlArmCount: trialAudits.filter((trial) => !trial.promotable).length,
      promotableArmCount: trialAudits.filter((trial) => trial.promotable).length,
      chainValid: verification.valid && blockers.length === 0,
      batchParity,
      blockers: [...new Set(blockers)].sort(),
      trials: trialAudits,
    },
  };
};

const settleTemperatureNeutralizationSuite = ({
  priorSuite = null,
  matches = [],
  evaluatedAt = new Date().toISOString(),
} = {}) => {
  const priorVerification = verifyTemperatureNeutralizationSuite(priorSuite);
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
      blockers: ["temperature-neutralization-plan-not-registered"],
      audit: null,
    };
  }
  const suite = structuredClone(priorSuite);
  const frozenPlan = suite.header.frozenPlan;
  const armsById = new Map(
    (frozenPlan.arms || []).map((arm) => [String(arm?.candidate?.id || ""), arm]),
  );
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
      blockers.push(...(update.blockers || []).map(
        (reason) => `${candidateId}:${reason}`,
      ));
      continue;
    }
    if (update.changed) trial.registry = update.registry;
    changed = changed || update.changed;
    settlementsAdded += Number(update.settlementsAdded || 0);
    trialAudits.push(compactTrialAudit({
      arm: armsById.get(candidateId),
      audit: update.audit,
      registry: update.registry,
    }));
  }
  if (changed) suite.updatedAt = isoTime(evaluatedAt);
  suite.rootHash = suiteRootHash(suite);
  const verification = verifyTemperatureNeutralizationSuite(suite);
  blockers.push(...verification.blockers);
  const batchParity = batchParityAudit(suite);
  return {
    suite,
    changed,
    chainValid: verification.valid && blockers.length === 0,
    settlementsAdded,
    blockers: [...new Set(blockers)].sort(),
    audit: {
      version: AUDIT_VERSION,
      evaluatedAt: isoTime(evaluatedAt),
      available: true,
      onlineEffect: false,
      settlementOnly: true,
      planVersion: frozenPlan.version,
      planHash: frozenPlan.planHash,
      planCreatedAt: frozenPlan.createdAt,
      activationAt: frozenPlan.activationAt,
      suiteRootHash: suite.rootHash,
      familyWiseComparison: frozenPlan.familyWiseComparison,
      formalEvidencePolicy: {
        version: INPUT_POLICY_VERSION,
        officialSportteryAtomicOnly: true,
        historicalBackfillRows: 0,
        reference500Rows: 0,
      },
      trialCount: suite.trials.length,
      controlArmCount: trialAudits.filter((trial) => !trial.promotable).length,
      promotableArmCount: trialAudits.filter((trial) => trial.promotable).length,
      chainValid: verification.valid && blockers.length === 0,
      batchParity,
      blockers: [...new Set(blockers)].sort(),
      trials: trialAudits,
    },
  };
};

const nonNegativeInteger = (value) => Math.max(0, Math.trunc(Number(value || 0)));

const rangeFor = (values) => {
  const rows = values.map(nonNegativeInteger);
  return {
    min: rows.length ? Math.min(...rows) : 0,
    max: rows.length ? Math.max(...rows) : 0,
  };
};

const compactTemperatureNeutralizationSuitePublic = (audit) => {
  if (!audit || typeof audit !== "object") return null;
  const trials = Array.isArray(audit.trials) ? audit.trials : [];
  const admittedRows = rangeFor(trials.map(
    (trial) => trial?.decisionRecord?.admittedRows,
  ));
  const atomicRows = rangeFor(trials.map(
    (trial) => trial?.decisionRecord?.atomicRows,
  ));
  const formalRows = rangeFor(trials.map(
    (trial) => trial?.metrics?.formalRows,
  ));
  return {
    version: PUBLIC_AUDIT_VERSION,
    evaluatedAt: audit.evaluatedAt || null,
    available: audit.available === true,
    ok: audit.ok === true,
    skipped: audit.skipped === true,
    reason: audit.reason || null,
    onlineEffect: false,
    rootHash: audit.suiteRootHash || null,
    trialCount: nonNegativeInteger(audit.trialCount ?? trials.length),
    promotableArmCount: nonNegativeInteger(audit.promotableArmCount),
    controlArmCount: nonNegativeInteger(audit.controlArmCount),
    controlArmPromotionEligible: false,
    familyWiseComparison: audit.familyWiseComparison ? {
      version: audit.familyWiseComparison.version || null,
      existingChallengerArmCount: nonNegativeInteger(
        audit.familyWiseComparison.existingChallengerArmCount,
      ),
      temperatureNeutralizationArmCount: nonNegativeInteger(
        audit.familyWiseComparison.temperatureNeutralizationArmCount,
      ),
      totalExperimentArmCount: nonNegativeInteger(
        audit.familyWiseComparison.totalExperimentArmCount,
      ),
      sourceActiveComparatorCount: nonNegativeInteger(
        audit.familyWiseComparison.sourceActiveComparatorCount,
      ),
      totalProspectiveTracksIncludingActive: nonNegativeInteger(
        audit.familyWiseComparison.totalProspectiveTracksIncludingActive,
      ),
      primaryEndpointCount: nonNegativeInteger(
        audit.familyWiseComparison.primaryEndpointCount,
      ),
      totalPrimaryHypothesisCount: nonNegativeInteger(
        audit.familyWiseComparison.totalPrimaryHypothesisCount,
      ),
    } : null,
    inputEligibility: audit.inputEligibility ? {
      version: audit.inputEligibility.version || null,
      activationAt: audit.inputEligibility.activationAt || null,
      receivedMatches: nonNegativeInteger(audit.inputEligibility.receivedMatches),
      eligibleMatches: nonNegativeInteger(audit.inputEligibility.eligibleMatches),
      excludedReferenceOrNonOfficial: nonNegativeInteger(
        audit.inputEligibility.excludedReferenceOrNonOfficial,
      ),
      excludedPreActivationDeadline: nonNegativeInteger(
        audit.inputEligibility.excludedPreActivationDeadline,
      ),
      excludedInvalidClock: nonNegativeInteger(
        audit.inputEligibility.excludedInvalidClock,
      ),
    } : null,
    formalEvidencePolicy: audit.formalEvidencePolicy || null,
    chainValid: audit.chainValid === true,
    batchParityComplete: audit.batchParity?.complete === true,
    admittedRows,
    atomicRows,
    formalRows,
    formalPromotionEligibleTrialCount: trials.filter(
      (trial) => trial?.formalPromotionEligible === true,
    ).length,
    blockerCount: Array.isArray(audit.blockers) ? audit.blockers.length : 0,
  };
};

module.exports = {
  AUDIT_VERSION,
  FAMILY_WISE_POLICY_VERSION,
  INPUT_POLICY_VERSION,
  MARKET_CONTROL_ID,
  NOMINATION_POLICY_VERSION,
  PLAN_VERSION,
  PUBLIC_AUDIT_VERSION,
  RESIDUAL_MINUS_10_ID,
  RESIDUAL_MINUS_20_ID,
  SUITE_VERSION,
  TEMPERATURE_NEUTRALIZATION_ARMS,
  batchParityAudit,
  buildTemperatureNeutralizationPlan,
  compactTemperatureNeutralizationSuitePublic,
  futureOnlyMatchesForSuite,
  inputEligibilityFor,
  nominationPolicyCommitment,
  settleTemperatureNeutralizationSuite,
  settlementMatchesForSuite,
  trialLedgersFor,
  updateTemperatureNeutralizationSuite,
  verifyTemperatureNeutralizationSuite,
};
