"use strict";

const CLV_TIMING_AUDIT_VERSION = "closing-line-timing-audit-v1";

const round = (value, digits = 4) => {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

const timeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const finiteMetric = (value) => (
  value !== null
  && value !== undefined
  && value !== ""
  && Number.isFinite(Number(value))
);

const assessClvTiming = (input = {}) => {
  const forecastCapturedAt = input.forecastCapturedAt
    || input.forecastOddsCapturedAt;
  const closingCapturedAt = input.closingCapturedAt
    || input.closingOddsCapturedAt;
  const kickoffTime = input.kickoffTime;
  const forecastMs = timeMs(forecastCapturedAt);
  const closingMs = timeMs(closingCapturedAt);
  const kickoffMs = timeMs(kickoffTime);
  let reason = null;

  if (forecastMs === null) reason = "FORECAST_CLOCK_INVALID";
  else if (closingMs === null) reason = "CLOSING_CLOCK_INVALID";
  else if (kickoffMs === null) reason = "KICKOFF_CLOCK_INVALID";
  else if (forecastMs > kickoffMs) reason = "FORECAST_AFTER_KICKOFF";
  else if (closingMs > kickoffMs) reason = "CLOSING_AFTER_KICKOFF";
  else if (closingMs < forecastMs) reason = "CLOSING_BEFORE_FORECAST";
  else if (closingMs === forecastMs) reason = "SAME_OBSERVATION";

  return {
    version: CLV_TIMING_AUDIT_VERSION,
    eligible: reason === null,
    reason,
    forecastCapturedAt: forecastMs === null
      ? null
      : new Date(forecastMs).toISOString(),
    closingCapturedAt: closingMs === null
      ? null
      : new Date(closingMs).toISOString(),
    kickoffTime: kickoffMs === null
      ? null
      : new Date(kickoffMs).toISOString(),
    observationGapSeconds: reason === null
      ? Math.round((closingMs - forecastMs) / 1000)
      : null,
    closingLeadSeconds: reason === null
      ? Math.round((kickoffMs - closingMs) / 1000)
      : null,
  };
};

const summarizeClvRows = (rows = []) => {
  const candidates = Array.isArray(rows) ? rows : [];
  const reasonCounts = {};
  const eligibleRows = [];
  let movementMissingRows = 0;

  for (const row of candidates) {
    const timing = assessClvTiming({
      forecastCapturedAt: row?.forecastOddsCapturedAt,
      closingCapturedAt: row?.closingOddsCapturedAt,
      kickoffTime: row?.kickoffTime,
    });
    if (!timing.eligible) {
      reasonCounts[timing.reason] = (reasonCounts[timing.reason] || 0) + 1;
      continue;
    }
    if (!finiteMetric(row?.clvProbabilityMove)) {
      movementMissingRows += 1;
      continue;
    }
    eligibleRows.push({ ...row, clvTiming: timing });
  }

  const positiveRows = eligibleRows.filter(
    (row) => Number(row.clvProbabilityMove) > 0,
  );
  const flatRows = eligibleRows.filter(
    (row) => Number(row.clvProbabilityMove) === 0,
  );
  const negativeRows = eligibleRows.filter(
    (row) => Number(row.clvProbabilityMove) < 0,
  );
  const oddsMoveRows = eligibleRows.filter(
    (row) => finiteMetric(row.clvOddsRatioMove),
  );
  const candidateRows = candidates.length;
  const rowsWithValidClv = eligibleRows.length;

  return {
    version: "closing-line-value-v2",
    rows: rowsWithValidClv,
    candidateRows,
    timingCoverage: candidateRows
      ? round(rowsWithValidClv / candidateRows, 6)
      : 0,
    positiveClvRate: rowsWithValidClv
      ? round(positiveRows.length / rowsWithValidClv)
      : null,
    avgProbabilityMove: rowsWithValidClv
      ? round(
          eligibleRows.reduce(
            (sum, row) => sum + Number(row.clvProbabilityMove),
            0,
          ) / rowsWithValidClv,
        )
      : null,
    avgOddsRatioMove: oddsMoveRows.length
      ? round(
          oddsMoveRows.reduce(
            (sum, row) => sum + Number(row.clvOddsRatioMove),
            0,
          ) / oddsMoveRows.length,
        )
      : null,
    directionCounts: {
      positive: positiveRows.length,
      flat: flatRows.length,
      negative: negativeRows.length,
    },
    timingAudit: {
      version: CLV_TIMING_AUDIT_VERSION,
      candidateRows,
      eligibleRows: rowsWithValidClv,
      movementMissingRows,
      reasonCounts,
      policy:
        "CLV requires a closing observation strictly later than the forecast observation and no later than kickoff.",
    },
    note:
      "Positive probability move means a distinct later no-vig market observation moved toward the model pick.",
  };
};

module.exports = {
  CLV_TIMING_AUDIT_VERSION,
  assessClvTiming,
  summarizeClvRows,
};
