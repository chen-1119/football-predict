"use strict";

const DEFAULT_TARGET_RATE = 0.8;
const DEFAULT_MINIMUM_SETTLED_ROWS = 500;
const Z_95 = 1.959963984540054;

const finiteNonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const finiteRate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
};

const finiteNumber = (value) => (
  value !== null
  && value !== undefined
  && value !== ""
  && Number.isFinite(Number(value))
);

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const wilsonInterval95 = (won, settled) => {
  const n = finiteNonNegativeInteger(settled);
  const successes = Math.min(finiteNonNegativeInteger(won), n);
  if (n === 0) return { lower: null, upper: null };

  const observed = successes / n;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / n;
  const center = (observed + zSquared / (2 * n)) / denominator;
  const margin = (
    Z_95
    * Math.sqrt((observed * (1 - observed) + zSquared / (4 * n)) / n)
  ) / denominator;

  return {
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  };
};

const buildHitRateAudit = ({
  metrics,
  closingLineValue,
  targetRate = DEFAULT_TARGET_RATE,
  minimumSettledRows = DEFAULT_MINIMUM_SETTLED_ROWS,
} = {}) => {
  const settled = finiteNonNegativeInteger(metrics?.settled);
  const won = Math.min(finiteNonNegativeInteger(metrics?.won), settled);
  const lost = Math.min(finiteNonNegativeInteger(metrics?.lost), settled - won);
  const observedRate = settled > 0 ? round(won / settled) : null;
  const interval95 = wilsonInterval95(won, settled);
  const target = finiteRate(targetRate) ?? DEFAULT_TARGET_RATE;
  const requiredRows = Math.max(
    1,
    finiteNonNegativeInteger(minimumSettledRows) || DEFAULT_MINIMUM_SETTLED_ROWS,
  );
  const sampleReady = settled >= requiredRows;
  const nearTarget = Boolean(
    sampleReady
    && observedRate !== null
    && observedRate >= target
    && interval95.lower !== null
    && interval95.lower >= Math.max(0, target - 0.05),
  );
  const status = !sampleReady
    ? "collecting"
    : nearTarget
      ? "credible-near-target"
      : "verified-below-target";
  const clvRows = finiteNonNegativeInteger(closingLineValue?.rows);
  const clvCandidateRows = Math.max(
    clvRows,
    finiteNonNegativeInteger(closingLineValue?.candidateRows),
  );

  return {
    version: "formal-hit-rate-audit-v1",
    status,
    targetRate: target,
    minimumSettledRows: requiredRows,
    sampleReady,
    observed: {
      settled,
      won,
      lost,
      hitRate: observedRate,
      interval95,
      flatStakeRoi: finiteNumber(metrics?.flatStakeRoi)
        ? round(Number(metrics.flatStakeRoi))
        : null,
      avgOdds: finiteNumber(metrics?.avgOdds)
        ? round(Number(metrics.avgOdds), 4)
        : null,
      brier: finiteNumber(metrics?.brier)
        ? round(Number(metrics.brier))
        : null,
      logLoss: finiteNumber(metrics?.logLoss)
        ? round(Number(metrics.logLoss))
        : null,
    },
    closingLineValue: {
      version: typeof closingLineValue?.version === "string"
        ? closingLineValue.version
        : null,
      rows: clvRows,
      candidateRows: clvCandidateRows,
      timingCoverage: finiteRate(closingLineValue?.timingCoverage),
      positiveRate: finiteRate(closingLineValue?.positiveClvRate),
      averageProbabilityMove: finiteNumber(closingLineValue?.avgProbabilityMove)
        ? round(Number(closingLineValue.avgProbabilityMove))
        : null,
      timingAudit: {
        version: typeof closingLineValue?.timingAudit?.version === "string"
          ? closingLineValue.timingAudit.version
          : null,
        eligibleRows: finiteNonNegativeInteger(closingLineValue?.timingAudit?.eligibleRows),
        movementMissingRows: finiteNonNegativeInteger(
          closingLineValue?.timingAudit?.movementMissingRows,
        ),
        reasonCounts: Object.fromEntries(
          Object.entries(closingLineValue?.timingAudit?.reasonCounts || {})
            .map(([reason, count]) => [reason, finiteNonNegativeInteger(count)])
            .filter(([, count]) => count > 0),
        ),
      },
    },
    externalBenchmark: {
      claimedRate: target,
      verificationStatus: "unverified-external-claim",
      usableAsTrainingLabel: false,
    },
    denominatorPolicy: [
      "formal-publication-ledger-only",
      "pre-match-frozen-before-cutoff",
      "settled-non-void-only",
      "reference-live-and-analysis-tracks-excluded",
      "no-retrospective-row-deletion",
    ],
    publicationPolicy: {
      immutableLedgerRequired: true,
      appendOnlySettlementRequired: true,
      completeWinsAndLossesRequired: true,
      postCutoffMutationForbidden: true,
    },
  };
};

module.exports = {
  DEFAULT_MINIMUM_SETTLED_ROWS,
  DEFAULT_TARGET_RATE,
  buildHitRateAudit,
  wilsonInterval95,
};
