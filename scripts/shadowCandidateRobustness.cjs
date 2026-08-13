"use strict";

const crypto = require("node:crypto");

const VERSION = "shadow-candidate-robustness-v1";
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const FAMILY_WISE_ALPHA = 0.05;
const DEFAULT_BOOTSTRAP_ITERATIONS = 5000;
const MIN_PROSPECTIVE_TEST_ROWS = 500;
const MIN_INDEPENDENT_WINDOWS = 6;
const MIN_NOMINATION_ROWS = 150;
const MIN_NOMINATION_WINDOWS = 4;
const MIN_NOMINATION_PASS_RATE = 0.6;
const NOMINATION_SELECTION_VERSION = "window-stability-first-v1";
const NOMINATION_SELECTION_POLICY = Object.freeze({
  version: NOMINATION_SELECTION_VERSION,
  coveragePolicy:
    "rank only candidates with the maximum comparable row coverage and then the maximum comparable non-overlapping window coverage",
  stabilityThresholdWindows: MIN_NOMINATION_WINDOWS,
  stabilityOrder:
    "at or above the stability threshold rank winning-window count and pass rate before aggregate metrics",
  aggregateTieBreak:
    "rank lower aggregate Log Loss, then lower aggregate Brier, then candidate id",
  belowThresholdFallback:
    "before the stability threshold rank full-coverage candidates by the aggregate tie-break only",
});

const nominationSelectionPolicyCommitment = () => ({
  ...NOMINATION_SELECTION_POLICY,
});

const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const sha256 = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const clampProbability = (value) => Math.min(1 - 1e-12, Math.max(1e-12, finite(value, 0)));

const normalizedTriplet = (probabilities) => {
  const parsed = Object.fromEntries(
    OUTCOMES.map((code) => [code, finite(probabilities?.[code], null)]),
  );
  if (OUTCOMES.some((code) => parsed[code] === null || parsed[code] < 0)) return null;
  const total = OUTCOMES.reduce((sum, code) => sum + parsed[code], 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(OUTCOMES.map((code) => [code, parsed[code] / total]));
};

const lossesFor = (probabilities, actual) => {
  const normalized = normalizedTriplet(probabilities);
  if (!normalized || !OUTCOMES.includes(String(actual || ""))) return null;
  let brier = 0;
  for (const code of OUTCOMES) {
    brier += (normalized[code] - (code === actual ? 1 : 0)) ** 2;
  }
  return {
    brier,
    logLoss: -Math.log(clampProbability(normalized[actual])),
  };
};

const scoreDeltaForRow = (row) => {
  const candidate = lossesFor(row?.probabilities, row?.actual);
  const market = lossesFor(row?.marketProbabilities, row?.actual);
  if (!candidate || !market) return null;
  return {
    kickoffTime: row?.kickoffTime || null,
    league: String(row?.league || "unknown"),
    marketOdds: row?.market?.odds || null,
    predictedCode: OUTCOMES
      .slice()
      .sort((left, right) => finite(row?.probabilities?.[right], 0) - finite(row?.probabilities?.[left], 0))[0],
    logLossImprovement: market.logLoss - candidate.logLoss,
    brierImprovement: market.brier - candidate.brier,
  };
};

const mean = (values) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
);

const aggregateCandidateComparator = (left, right) => {
  const leftLogLoss = finite(left?.metrics?.logLoss, Number.POSITIVE_INFINITY);
  const rightLogLoss = finite(right?.metrics?.logLoss, Number.POSITIVE_INFINITY);
  if (leftLogLoss !== rightLogLoss) return leftLogLoss - rightLogLoss;
  const leftBrier = finite(left?.metrics?.brier, Number.POSITIVE_INFINITY);
  const rightBrier = finite(right?.metrics?.brier, Number.POSITIVE_INFINITY);
  if (leftBrier !== rightBrier) return leftBrier - rightBrier;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
};

const rankShadowCandidatesForNomination = (candidates) => {
  const rows = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!rows.length) {
    return {
      version: NOMINATION_SELECTION_VERSION,
      ranked: [],
      stabilityApplied: false,
      maximumComparableRows: 0,
      maximumComparableWindows: 0,
      policy:
        "No candidate was available; retain the aggregate fallback and keep the prospective gate closed.",
    };
  }

  const maximumComparableRows = Math.max(
    ...rows.map((candidate) => Math.max(0, Number(candidate?.metrics?.rows || 0))),
  );
  const fullCoverage = rows.filter((candidate) => (
    Math.max(0, Number(candidate?.metrics?.rows || 0)) === maximumComparableRows
  ));
  const maximumComparableWindows = Math.max(
    ...fullCoverage.map((candidate) => Math.max(0, Number(candidate?.rolling?.windows || 0))),
  );
  const comparable = fullCoverage.filter((candidate) => (
    Math.max(0, Number(candidate?.rolling?.windows || 0)) === maximumComparableWindows
  ));
  const stabilityApplied = maximumComparableWindows >= MIN_NOMINATION_WINDOWS;
  const ranked = (stabilityApplied ? comparable : fullCoverage)
    .slice()
    .sort((left, right) => {
      if (stabilityApplied) {
        const passedDelta = Number(right?.rolling?.passed || 0)
          - Number(left?.rolling?.passed || 0);
        if (passedDelta !== 0) return passedDelta;
        const passRateDelta = finite(right?.rolling?.passRate, -1)
          - finite(left?.rolling?.passRate, -1);
        if (passRateDelta !== 0) return passRateDelta;
      }
      return aggregateCandidateComparator(left, right);
    });

  return {
    version: NOMINATION_SELECTION_VERSION,
    ranked,
    stabilityApplied,
    maximumComparableRows,
    maximumComparableWindows,
    policy: stabilityApplied
      ? "Among full-coverage candidates evaluated on the maximum available non-overlapping windows, rank winning-window count and pass rate before aggregate Log Loss and Brier."
      : "Fewer than four comparable non-overlapping windows are available; rank full-coverage candidates by aggregate Log Loss and Brier until the stability threshold is reached.",
  };
};

const percentile = (sorted, ratio) => {
  if (!sorted.length) return null;
  const bounded = Math.min(1, Math.max(0, ratio));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * bounded)));
  return sorted[index];
};

const seededRandom = (seedHex) => {
  let state = Number.parseInt(String(seedHex || "").slice(0, 8), 16) >>> 0;
  if (!state) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
};

const pairedCircularBlockBootstrap = (
  rows,
  {
    candidateId = "unknown",
    testedCandidateCount = 1,
    iterations = DEFAULT_BOOTSTRAP_ITERATIONS,
    familyWiseAlpha = FAMILY_WISE_ALPHA,
  } = {},
) => {
  const deltas = (Array.isArray(rows) ? rows : [])
    .map(scoreDeltaForRow)
    .filter(Boolean)
    .sort((left, right) => (
      Date.parse(left.kickoffTime || "") - Date.parse(right.kickoffTime || "")
    ));
  if (!deltas.length) {
    return {
      rows: 0,
      method: "deterministic-circular-block-bootstrap",
      iterations,
      blockSize: null,
      seedHash: null,
      unadjusted95: null,
      familyWiseAdjusted: null,
    };
  }
  const blockSize = Math.max(5, Math.min(20, Math.floor(Math.sqrt(deltas.length))));
  const seedHash = sha256({
    candidateId,
    testedCandidateCount,
    rows: deltas.map((row) => ({
      kickoffTime: row.kickoffTime,
      league: row.league,
      logLossImprovement: round(row.logLossImprovement, 12),
      brierImprovement: round(row.brierImprovement, 12),
    })),
  });
  const random = seededRandom(seedHash);
  const logLossSamples = [];
  const brierSamples = [];
  const sampleCount = Math.max(1000, Math.floor(iterations));
  for (let iteration = 0; iteration < sampleCount; iteration += 1) {
    let logLossSum = 0;
    let brierSum = 0;
    let sampled = 0;
    while (sampled < deltas.length) {
      const start = Math.floor(random() * deltas.length);
      for (let offset = 0; offset < blockSize && sampled < deltas.length; offset += 1) {
        const row = deltas[(start + offset) % deltas.length];
        logLossSum += row.logLossImprovement;
        brierSum += row.brierImprovement;
        sampled += 1;
      }
    }
    logLossSamples.push(logLossSum / sampled);
    brierSamples.push(brierSum / sampled);
  }
  logLossSamples.sort((left, right) => left - right);
  brierSamples.sort((left, right) => left - right);
  const familySize = Math.max(1, Number(testedCandidateCount || 1));
  const adjustedTailAlpha = familyWiseAlpha / (familySize * 2);
  const interval = (samples, tailAlpha) => ({
    lower: round(percentile(samples, tailAlpha)),
    upper: round(percentile(samples, 1 - tailAlpha)),
  });
  return {
    rows: deltas.length,
    method: "deterministic-circular-block-bootstrap",
    iterations: sampleCount,
    blockSize,
    seedHash,
    observed: {
      logLossImprovement: round(mean(deltas.map((row) => row.logLossImprovement))),
      brierImprovement: round(mean(deltas.map((row) => row.brierImprovement))),
    },
    unadjusted95: {
      alpha: familyWiseAlpha,
      logLossImprovement: interval(logLossSamples, familyWiseAlpha / 2),
      brierImprovement: interval(brierSamples, familyWiseAlpha / 2),
    },
    familyWiseAdjusted: {
      method: "bonferroni-over-candidates-and-two-primary-endpoints",
      familyWiseAlpha,
      testedCandidateCount: familySize,
      endpointCount: 2,
      adjustedTailAlpha: round(adjustedTailAlpha, 9),
      logLossImprovement: interval(logLossSamples, adjustedTailAlpha),
      brierImprovement: interval(brierSamples, adjustedTailAlpha),
    },
  };
};

const oddsBucketFor = (row) => {
  const odds = finite(row?.marketOdds?.[row?.predictedCode], null);
  if (!(odds > 1)) return "unknown";
  if (odds < 1.5) return "lt_1_50";
  if (odds < 1.85) return "1_50_1_84";
  if (odds < 2.2) return "1_85_2_19";
  return "ge_2_20";
};

const summarizeGroup = (rows) => ({
  rows: rows.length,
  logLossImprovement: round(mean(rows.map((row) => row.logLossImprovement))),
  brierImprovement: round(mean(rows.map((row) => row.brierImprovement))),
  improvesBoth: mean(rows.map((row) => row.logLossImprovement)) > 0
    && mean(rows.map((row) => row.brierImprovement)) > 0,
});

const groupedScoreDeltas = (rows, keyFor) => {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFor(row) || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, summarizeGroup(group)]),
  );
};

const buildStratification = (rows) => {
  const deltas = (Array.isArray(rows) ? rows : []).map(scoreDeltaForRow).filter(Boolean);
  return {
    policy: "diagnostic-only; strata never change the preregistered production threshold",
    byLeague: groupedScoreDeltas(deltas, (row) => row.league),
    bySelectedMarketOdds: groupedScoreDeltas(deltas, oddsBucketFor),
    byPredictedOutcome: groupedScoreDeltas(deltas, (row) => row.predictedCode),
  };
};

const temperatureGridAudit = (candidates, selectedCandidateId) => {
  const grid = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => (
      candidate?.role === "shadow-feature-candidate"
      && finite(candidate?.weights?.market, null) === 1
      && finite(candidate?.weights?.model, 0) === 0
      && finite(candidate?.weights?.temperature, null) !== null
    ))
    .map((candidate) => ({
      id: candidate.id,
      temperature: finite(candidate.weights.temperature),
      rows: Number(candidate?.metrics?.rows || 0),
      logLossImprovement: finite(candidate?.comparison?.logLossImprovement),
      brierImprovement: finite(candidate?.comparison?.brierImprovement),
    }))
    .sort((left, right) => left.temperature - right.temperature);
  const selectedIndex = grid.findIndex((row) => row.id === selectedCandidateId);
  const selected = selectedIndex >= 0 ? grid[selectedIndex] : null;
  const neighbors = selected
    ? [grid[selectedIndex - 1], grid[selectedIndex + 1]].filter(Boolean)
    : [];
  const bestByLogLoss = grid
    .slice()
    .sort((left, right) => finite(right.logLossImprovement, -Infinity) - finite(left.logLossImprovement, -Infinity))[0]
    || null;
  return {
    policy: "temperature grid is exploratory; the selected coordinate must survive future preregistered data",
    grid,
    gridHash: sha256(grid),
    selected,
    neighbors,
    selectedIsGridBestByLogLoss: Boolean(selected && bestByLogLoss?.id === selected.id),
    bestByLogLoss,
  };
};

const buildShadowCandidateRobustness = ({
  candidates = [],
  bestCandidateId = null,
  minimumRows = MIN_PROSPECTIVE_TEST_ROWS,
  minimumIndependentWindows = MIN_INDEPENDENT_WINDOWS,
} = {}) => {
  const inventory = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      id: candidate?.id || null,
      role: candidate?.role || null,
      featureSet: Array.isArray(candidate?.featureSet) ? candidate.featureSet : [],
      weights: candidate?.weights || {},
    }))
    .filter((candidate) => candidate.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const testedCandidates = inventory.filter((candidate) => candidate.id !== "market-baseline");
  const selected = candidates.find((candidate) => candidate?.id === bestCandidateId) || null;
  const bootstrap = pairedCircularBlockBootstrap(selected?._rows || [], {
    candidateId: bestCandidateId,
    testedCandidateCount: testedCandidates.length,
  });
  const adjusted = bootstrap?.familyWiseAdjusted;
  const adjustedPositive = finite(adjusted?.logLossImprovement?.lower, null) > 0
    && finite(adjusted?.brierImprovement?.lower, null) > 0;
  const rollingWindows = Number(selected?.rolling?.windows || 0);
  const rollingPassRate = finite(selected?.rolling?.passRate, null);
  const rows = Number(bootstrap?.rows || 0);
  const observedLogLossImprovement = finite(bootstrap?.observed?.logLossImprovement, null);
  const observedBrierImprovement = finite(bootstrap?.observed?.brierImprovement, null);
  const nominationBlockers = [];
  if (!selected) nominationBlockers.push("nomination-selected-candidate-missing");
  if (rows < MIN_NOMINATION_ROWS) {
    nominationBlockers.push(`nomination-paired-rows:${rows}<${MIN_NOMINATION_ROWS}`);
  }
  if (rollingWindows < MIN_NOMINATION_WINDOWS) {
    nominationBlockers.push(
      `nomination-independent-windows:${rollingWindows}<${MIN_NOMINATION_WINDOWS}`,
    );
  }
  if (rollingPassRate === null || rollingPassRate < MIN_NOMINATION_PASS_RATE) {
    nominationBlockers.push(
      `nomination-rolling-pass-rate:${rollingPassRate ?? "missing"}<${MIN_NOMINATION_PASS_RATE}`,
    );
  }
  if (!(observedLogLossImprovement > 0) || !(observedBrierImprovement > 0)) {
    nominationBlockers.push("nomination-point-estimates-not-positive");
  }
  const blockers = [];
  if (!selected) blockers.push("selected-candidate-missing");
  if (rows < minimumRows) blockers.push(`paired-rows:${rows}<${minimumRows}`);
  if (rollingWindows < minimumIndependentWindows) {
    blockers.push(`independent-windows:${rollingWindows}<${minimumIndependentWindows}`);
  }
  if (!adjustedPositive) blockers.push("family-wise-adjusted-bootstrap-lower-bound-not-positive");
  blockers.push("candidate-selected-on-same-retrospective-sample");

  return {
    version: VERSION,
    role: "counterevidence-audit",
    onlineEffect: false,
    family: {
      candidateCount: inventory.length,
      testedCandidateCount: testedCandidates.length,
      primaryEndpointCount: 2,
      familyWiseAlpha: FAMILY_WISE_ALPHA,
      inventoryHash: sha256(inventory),
      inventory,
    },
    selectedCandidate: selected ? {
      id: selected.id,
      role: selected.role || null,
      rows,
      rollingWindows,
      rollingPassRate,
      bootstrap,
      stratification: buildStratification(selected._rows || []),
      temperatureGrid: temperatureGridAudit(candidates, selected.id),
    } : null,
    thresholds: {
      minimumRows,
      minimumIndependentWindows,
      requireFamilyWiseAdjustedLowerBoundsAboveZero: true,
      requireUntouchedProspectiveConfirmation: true,
    },
    nominationThresholds: {
      minimumRows: MIN_NOMINATION_ROWS,
      minimumIndependentWindows: MIN_NOMINATION_WINDOWS,
      minimumRollingPassRate: MIN_NOMINATION_PASS_RATE,
      requirePositivePointEstimates: true,
      onlineEffect: false,
    },
    nominationBlockers,
    candidateReadyForProspectiveTest: nominationBlockers.length === 0,
    formalPromotionEligible: false,
    blockers,
    policy:
      "A structurally valid candidate with enough retrospective support may start a zero-online-effect prospective ledger. The retrospective sample can never promote it; promotion still requires the separately preregistered 500-row, six-window prospective gate.",
  };
};

module.exports = {
  NOMINATION_SELECTION_POLICY,
  NOMINATION_SELECTION_VERSION,
  VERSION,
  aggregateCandidateComparator,
  buildShadowCandidateRobustness,
  nominationSelectionPolicyCommitment,
  pairedCircularBlockBootstrap,
  rankShadowCandidatesForNomination,
  scoreDeltaForRow,
  temperatureGridAudit,
};
