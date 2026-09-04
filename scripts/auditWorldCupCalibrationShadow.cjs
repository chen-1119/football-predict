const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const {
  loadInputs,
  normalizeProbabilityTriplet,
  summarizeProbabilityRows,
  topProbabilityCode,
} = require("./auditWorldCupModelRegression.cjs");
const {
  dedupeMatches,
  isWorldCupFinalsMatch,
} = require("./auditWorldCupHitRate.cjs");

const VERSION = "world-cup-calibration-shadow-v1";
const DEFAULT_SNAPSHOT_FILE = path.resolve(__dirname, "..", "server-data", "db", "match-snapshots.jsonl");

const parseAuditTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const sourceMatchIdFor = (row) => String(
  row?.sourceMatchId
  || row?.match?.sourceMatchId
  || row?.matchId
  || row?.match?.id
  || ""
).replace(/^sporttery_/, "");

const actualCodeFor = (match) => {
  const home = Number(match?.scoreHome);
  const away = Number(match?.scoreAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return home > away ? "1" : home < away ? "2" : "X";
};

const decisionDeadlineFor = (settledMatch, snapshotMatch) => {
  const kickoffMs = parseAuditTime(settledMatch?.kickoffTime || settledMatch?.matchDate);
  const cutoffMs = parseAuditTime(
    settledMatch?.predictionMeta?.cutoffTime
    || settledMatch?.buyEndTime
    || snapshotMatch?.predictionMeta?.cutoffTime
    || snapshotMatch?.buyEndTime
  );
  return [kickoffMs, cutoffMs].filter(Number.isFinite).sort((left, right) => left - right)[0] ?? null;
};

const hasOutcomeCooldown = (calibration) => (calibration?.reasons || [])
  .some((reason) => /cooldown|shrink|brake/i.test(String(reason)));

async function loadLatestPreMatchCalibrationRows({
  snapshotFile = DEFAULT_SNAPSHOT_FILE,
  currentMatches = [],
  historyMatches = [],
} = {}) {
  const settledWorldCupMatches = dedupeMatches([...currentMatches, ...historyMatches])
    .filter(isWorldCupFinalsMatch)
    .filter((match) => match.status === "FINISHED" && actualCodeFor(match));
  const resultIndex = new Map(settledWorldCupMatches.map((match) => [sourceMatchIdFor(match), match]));
  const selected = new Map();

  if (!fs.existsSync(snapshotFile)) return [];
  const lines = readline.createInterface({
    input: fs.createReadStream(snapshotFile),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const sourceMatchId = sourceMatchIdFor(row);
    const settledMatch = resultIndex.get(sourceMatchId);
    if (!settledMatch) continue;
    const snapshotMatch = row?.match || row;
    const calibration = snapshotMatch?.probabilityModel?.calibrationAdjustment?.oneXTwo;
    const activeProbabilities = normalizeProbabilityTriplet(calibration?.after);
    const shadowProbabilities = normalizeProbabilityTriplet(calibration?.scoreFeedback?.after);
    if (!activeProbabilities || !shadowProbabilities || !hasOutcomeCooldown(calibration)) continue;

    const capturedMs = parseAuditTime(row?.at || snapshotMatch?.probabilityModel?.generatedAt);
    const deadlineMs = decisionDeadlineFor(settledMatch, snapshotMatch);
    if (!Number.isFinite(capturedMs) || !Number.isFinite(deadlineMs) || capturedMs > deadlineMs) continue;

    const existing = selected.get(sourceMatchId);
    if (existing && existing.capturedMs >= capturedMs) continue;
    selected.set(sourceMatchId, {
      sourceMatchId,
      capturedMs,
      capturedAt: new Date(capturedMs).toISOString(),
      deadlineAt: new Date(deadlineMs).toISOString(),
      actual: actualCodeFor(settledMatch),
      probabilities: activeProbabilities,
      shadowProbabilities,
      activePick: topProbabilityCode(activeProbabilities),
      shadowPick: topProbabilityCode(shadowProbabilities),
      modelVersion: snapshotMatch?.probabilityModel?.version || "unknown",
      reasons: calibration.reasons || [],
    });
  }

  return [...selected.values()].sort((left, right) => left.capturedMs - right.capturedMs);
}

function summarizeCalibrationRows(rows) {
  const active = summarizeProbabilityRows(rows);
  const shadow = summarizeProbabilityRows(rows.map((row) => ({
    ...row,
    probabilities: row.shadowProbabilities,
  })));
  const top1ChangedRows = rows.filter((row) => row.activePick !== row.shadowPick).length;
  return {
    rows: rows.length,
    active,
    shadow,
    comparison: {
      top1ChangedRows,
      accuracyDeltaPoints: active.accuracy === null || shadow.accuracy === null
        ? null
        : Number(((shadow.accuracy - active.accuracy) * 100).toFixed(2)),
      brierImprovement: active.brier === null || shadow.brier === null
        ? null
        : Number((active.brier - shadow.brier).toFixed(4)),
      logLossImprovement: active.logLoss === null || shadow.logLoss === null
        ? null
        : Number((active.logLoss - shadow.logLoss).toFixed(4)),
    },
  };
}

async function buildWorldCupCalibrationShadowReport({ snapshotFile = DEFAULT_SNAPSHOT_FILE, dataDir } = {}) {
  const inputs = loadInputs(dataDir);
  const rows = await loadLatestPreMatchCalibrationRows({
    snapshotFile,
    currentMatches: inputs.currentMatches,
    historyMatches: inputs.historyMatches,
  });
  const metrics = summarizeCalibrationRows(rows);
  return {
    ok: true,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    scope: {
      competition: "2026 FIFA World Cup finals",
      cohort: "latest archived pre-deadline snapshot per settled match with both score-feedback and active stacked-cooldown probabilities",
      shadowPolicy: "retain score-distribution feedback and remove stacked outcome cooldown penalties",
      role: "shadow-only probability calibration audit; never a formal recommendation or ROI cohort",
    },
    data: {
      snapshotFile,
      rows: metrics.rows,
      modelVersions: Object.fromEntries([...new Set(rows.map((row) => row.modelVersion))]
        .sort()
        .map((version) => [version, rows.filter((row) => row.modelVersion === version).length])),
    },
    active: metrics.active,
    shadow: metrics.shadow,
    comparison: metrics.comparison,
    recommendationImpact: {
      formalHitRateDeltaPoints: 0,
      roiDeltaPoints: 0,
      reason: "The patch records shadow probabilities only and does not feed BEST selection, publication, settlement, or staking.",
    },
    promotionGate: {
      eligible: false,
      requiredEvaluationRows: 40,
      requiredChronologicalFolds: 6,
      blockers: [
        ...(metrics.rows < 40 ? [`evaluation-rows-${metrics.rows}-below-40`] : []),
        "chronological-fold-gate-not-yet-complete",
        ...(metrics.shadow.drawRecall === 0 ? ["draw-recall-zero"] : []),
        "shadow-cohort-has-no-formal-recommendation-or-roi-evidence",
      ],
    },
    rowDetailsIncluded: false,
  };
}

if (require.main === module) {
  buildWorldCupCalibrationShadowReport({
    snapshotFile: path.resolve(process.env.WORLD_CUP_SNAPSHOT_FILE || DEFAULT_SNAPSHOT_FILE),
    dataDir: process.env.WORLD_CUP_AUDIT_DATA_DIR
      ? path.resolve(process.env.WORLD_CUP_AUDIT_DATA_DIR)
      : undefined,
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  VERSION,
  parseAuditTime,
  loadLatestPreMatchCalibrationRows,
  summarizeCalibrationRows,
  buildWorldCupCalibrationShadowReport,
};
