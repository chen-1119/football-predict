const fs = require("node:fs");
const path = require("node:path");
const {
  dedupeMatches,
  isWorldCupFinalsMatch,
  stageForMatch,
} = require("./auditWorldCupHitRate.cjs");

const VERSION = "world-cup-model-regression-v1";
const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "public", "data");
const OUTCOMES = Object.freeze(["1", "X", "2"]);

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const asRows = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
};

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const parseAuditTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeProbabilityTriplet = (probabilities) => {
  if (!probabilities || typeof probabilities !== "object") return null;
  const values = {
    "1": Number(probabilities["1"] ?? probabilities.home),
    X: Number(probabilities.X ?? probabilities.draw),
    "2": Number(probabilities["2"] ?? probabilities.away),
  };
  if (!OUTCOMES.every((code) => Number.isFinite(values[code]) && values[code] >= 0)) return null;
  const rawTotal = OUTCOMES.reduce((sum, code) => sum + values[code], 0);
  if (!(rawTotal > 0)) return null;
  const scale = rawTotal > 1.5 ? 100 : 1;
  const scaled = Object.fromEntries(OUTCOMES.map((code) => [code, values[code] / scale]));
  const total = OUTCOMES.reduce((sum, code) => sum + scaled[code], 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(OUTCOMES.map((code) => [code, scaled[code] / total]));
};

const probabilityTripletFromSignature = (signature) => {
  const tail = String(signature || "").split("|").at(-1) || "";
  const match = tail.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  return match ? normalizeProbabilityTriplet({ "1": match[1], X: match[2], "2": match[3] }) : null;
};

const probabilityTripletForMatch = (match) => (
  normalizeProbabilityTriplet(match?.probabilityModel?.oneXTwo?.final)
  || normalizeProbabilityTriplet(match?.probabilityFinal)
  || probabilityTripletFromSignature(match?.signature)
);

const probabilityTripletForSnapshot = (snapshot) => (
  normalizeProbabilityTriplet(snapshot?.decisionSnapshot?.probabilities?.HAD)
  || normalizeProbabilityTriplet(snapshot?.probabilityFinal)
  || normalizeProbabilityTriplet(snapshot?.probabilityModel?.oneXTwo?.final)
  || normalizeProbabilityTriplet(snapshot?.probabilityModel?.final)
  || probabilityTripletFromSignature(snapshot?.signature)
);

const oddsTripletFor = (row) => {
  const source = row?.odds && typeof row.odds === "object" ? row.odds : row;
  const odds = {
    "1": Number(source?.odds1 ?? source?.home ?? source?.h ?? source?.["1"]),
    X: Number(source?.oddsX ?? source?.draw ?? source?.d ?? source?.X),
    "2": Number(source?.odds2 ?? source?.away ?? source?.a ?? source?.["2"]),
  };
  return OUTCOMES.every((code) => Number.isFinite(odds[code]) && odds[code] > 1) ? odds : null;
};

const marketProbabilityTripletFor = (row) => {
  const odds = oddsTripletFor(row);
  if (!odds) return null;
  const inverse = Object.fromEntries(OUTCOMES.map((code) => [code, 1 / odds[code]]));
  const total = OUTCOMES.reduce((sum, code) => sum + inverse[code], 0);
  return Object.fromEntries(OUTCOMES.map((code) => [code, inverse[code] / total]));
};

const topProbabilityCode = (probabilities) => OUTCOMES
  .slice()
  .sort((left, right) => probabilities[right] - probabilities[left])[0];

const resultCodeFor = (match) => {
  const home = Number(match?.scoreHome);
  const away = Number(match?.scoreAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
};

const keyVariantsFor = (row) => {
  const keys = new Set();
  const matchId = String(row?.matchId || row?.id || "").trim();
  const sourceMatchId = String(row?.sourceMatchId || "").trim();
  if (matchId) {
    keys.add(matchId);
    keys.add(matchId.replace(/^sporttery_/, ""));
  }
  if (sourceMatchId) {
    keys.add(sourceMatchId);
    keys.add(`sporttery_${sourceMatchId}`);
  }
  return [...keys].filter(Boolean);
};

const snapshotTimeMs = (snapshot, deadlineMs) => {
  if (String(snapshot?.phase || "").toLowerCase() === "review") return null;
  const captured = parseAuditTime(snapshot?.capturedAt);
  return Number.isFinite(captured) && captured <= deadlineMs ? captured : null;
};

const buildSnapshotIndex = (snapshots) => {
  const index = new Map();
  for (const snapshot of snapshots || []) {
    if (!probabilityTripletForSnapshot(snapshot)) continue;
    for (const key of keyVariantsFor(snapshot)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(snapshot);
    }
  }
  return index;
};

const findPreMatchSnapshotFor = (match, snapshotIndex) => {
  const kickoffMs = parseAuditTime(match?.kickoffTime || match?.matchDate);
  if (!Number.isFinite(kickoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const snapshot of snapshotIndex.get(key) || []) {
      const identity = `${snapshot?.capturedAt || ""}:${snapshot?.signature || ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const cutoffMs = parseAuditTime(
        match?.predictionMeta?.cutoffTime
        || match?.buyEndTime
        || snapshot?.cutoffTime,
      );
      const deadlineMs = [kickoffMs, cutoffMs].filter(Number.isFinite).sort((a, b) => a - b)[0];
      const timeMs = snapshotTimeMs(snapshot, deadlineMs);
      const probabilities = probabilityTripletForSnapshot(snapshot);
      if (!Number.isFinite(timeMs) || !probabilities) continue;
      candidates.push({ snapshot, timeMs, probabilities });
    }
  }
  candidates.sort((left, right) => right.timeMs - left.timeMs);
  return candidates[0] || null;
};

const buildOddsIndex = (rows) => {
  const index = new Map();
  for (const row of rows || []) {
    const pool = String(row?.poolCode || row?.oddsPoolCode || "HAD").toUpperCase();
    if (pool !== "HAD" || !marketProbabilityTripletFor(row)) continue;
    const capturedMs = parseAuditTime(row?.capturedAt || row?.captureBucket || row?.updatedAt);
    if (!Number.isFinite(capturedMs)) continue;
    for (const key of keyVariantsFor(row)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ row, capturedMs });
    }
  }
  for (const entries of index.values()) entries.sort((left, right) => left.capturedMs - right.capturedMs);
  return index;
};

const findLatestOddsBefore = (match, oddsIndex, cutoffMs) => {
  if (!Number.isFinite(cutoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const entry of oddsIndex.get(key) || []) {
      if (entry.capturedMs > cutoffMs) continue;
      const identity = `${entry?.row?.capturedAt || entry?.row?.captureBucket || ""}:${entry?.row?.stateSignature || ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push(entry);
    }
  }
  candidates.sort((left, right) => right.capturedMs - left.capturedMs);
  return candidates[0] || null;
};

const marketFromSnapshot = (selectedSnapshot) => {
  const snapshot = selectedSnapshot?.snapshot;
  if (!snapshot) return null;
  const odds = snapshot?.decisionSnapshot?.markets?.HAD?.odds
    || snapshot?.odds
    || snapshot?.featureSnapshot?.market?.had?.odds
    || null;
  return marketProbabilityTripletFor({ odds });
};

const strictDecisionClockEligible = (snapshot) => {
  const decision = snapshot?.decisionSnapshot;
  const version = String(decision?.version || "");
  const clockEligible = decision?.clockAudit?.eligible === true;
  return /v2/i.test(version) && clockEligible;
};

const trustedResultEligible = (match) => {
  const trustedResult = match?.resultProvenance?.trusted === true
    || match?.resultProvenance?.promotionEligible === true;
  const fallbackResult = match?.resultObservationFallback === true
    || match?.resultProvenance?.fallback === true;
  return trustedResult && !fallbackResult;
};

const wilsonInterval = (wins, total, z = 1.96) => {
  if (!total) return null;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total)) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
};

const summarizeProbabilityRows = (rows) => {
  if (!(rows || []).length) return {
    rows: 0,
    correct: 0,
    accuracy: null,
    accuracyPercent: null,
    confidence95Percent: null,
    brier: null,
    logLoss: null,
    ece: null,
    macroRecall: null,
    drawRecall: null,
    actualDistribution: { "1": 0, X: 0, "2": 0 },
    pickDistribution: { "1": 0, X: 0, "2": 0 },
    confusionMatrix: Object.fromEntries(OUTCOMES.map((actual) => [actual, { "1": 0, X: 0, "2": 0 }])),
    byClass: {},
  };
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  const actualDistribution = { "1": 0, X: 0, "2": 0 };
  const pickDistribution = { "1": 0, X: 0, "2": 0 };
  const confusionMatrix = Object.fromEntries(OUTCOMES.map((actual) => [actual, { "1": 0, X: 0, "2": 0 }]));
  const calibrationBuckets = new Map();
  for (const row of rows) {
    const actual = row.actual;
    const probabilities = normalizeProbabilityTriplet(row.probabilities);
    if (!OUTCOMES.includes(actual) || !probabilities) continue;
    const predicted = topProbabilityCode(probabilities);
    const isCorrect = predicted === actual;
    if (isCorrect) correct += 1;
    actualDistribution[actual] += 1;
    pickDistribution[predicted] += 1;
    confusionMatrix[actual][predicted] += 1;
    for (const code of OUTCOMES) brier += (probabilities[code] - (code === actual ? 1 : 0)) ** 2;
    logLoss += -Math.log(Math.max(0.001, Math.min(0.999, probabilities[actual])));
    const confidence = probabilities[predicted];
    const bucket = Math.min(9, Math.floor(confidence * 10));
    if (!calibrationBuckets.has(bucket)) calibrationBuckets.set(bucket, []);
    calibrationBuckets.get(bucket).push({ confidence, correct: isCorrect ? 1 : 0 });
  }
  const total = rows.length;
  const interval = wilsonInterval(correct, total);
  const byClass = Object.fromEntries(OUTCOMES.map((code) => {
    const truePositive = confusionMatrix[code][code];
    const actual = actualDistribution[code];
    const predicted = pickDistribution[code];
    return [code, {
      actual,
      predicted,
      truePositive,
      recall: actual ? round(truePositive / actual) : null,
      precision: predicted ? round(truePositive / predicted) : null,
    }];
  }));
  const recalls = OUTCOMES.map((code) => byClass[code].recall).filter(Number.isFinite);
  const ece = [...calibrationBuckets.values()].reduce((sum, bucket) => {
    const meanConfidence = bucket.reduce((value, row) => value + row.confidence, 0) / bucket.length;
    const observed = bucket.reduce((value, row) => value + row.correct, 0) / bucket.length;
    return sum + (bucket.length / total) * Math.abs(meanConfidence - observed);
  }, 0);
  return {
    rows: total,
    correct,
    accuracy: round(correct / total),
    accuracyPercent: round((correct / total) * 100, 2),
    confidence95Percent: interval?.map((value) => round(value * 100, 2)) || null,
    brier: round(brier / total),
    logLoss: round(logLoss / total),
    ece: round(ece),
    macroRecall: recalls.length ? round(recalls.reduce((sum, value) => sum + value, 0) / recalls.length) : null,
    drawRecall: byClass.X.recall,
    actualDistribution,
    pickDistribution,
    confusionMatrix,
    byClass,
  };
};

const compareMetrics = (model, market) => ({
  pairedRows: Math.min(model.rows, market.rows),
  accuracyImprovementPoints: model.accuracy === null || market.accuracy === null
    ? null
    : round((model.accuracy - market.accuracy) * 100, 2),
  brierImprovement: model.brier === null || market.brier === null ? null : round(market.brier - model.brier),
  logLossImprovement: model.logLoss === null || market.logLoss === null ? null : round(market.logLoss - model.logLoss),
  modelNonWorseOnAllCoreMetrics: Boolean(
    model.accuracy !== null
    && market.accuracy !== null
    && model.accuracy >= market.accuracy
    && model.brier <= market.brier
    && model.logLoss <= market.logLoss
  ),
});

const pairedOutcomeBreakdown = (rows) => (rows || []).reduce((summary, row) => {
  const modelCorrect = topProbabilityCode(row.probabilities) === row.actual;
  const marketCorrect = topProbabilityCode(row.marketProbabilities) === row.actual;
  if (modelCorrect && marketCorrect) summary.bothCorrect += 1;
  else if (modelCorrect) summary.modelOnlyCorrect += 1;
  else if (marketCorrect) summary.marketOnlyCorrect += 1;
  else summary.bothWrong += 1;
  return summary;
}, { bothCorrect: 0, modelOnlyCorrect: 0, marketOnlyCorrect: 0, bothWrong: 0 });

const groupDiagnostics = (rows, keyFn) => Object.fromEntries(
  [...new Set(rows.map(keyFn).filter(Boolean))]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .map((key) => [key, summarizeProbabilityRows(rows.filter((row) => keyFn(row) === key))]),
);

const modelVersionFor = (selectedSnapshot) => (
  selectedSnapshot?.snapshot?.probabilityModelVersion
  || selectedSnapshot?.snapshot?.modelVersion
  || selectedSnapshot?.snapshot?.decisionSnapshot?.modelVersion
  || selectedSnapshot?.snapshot?.featureSnapshot?.modelVersion
  || "unknown"
);

const buildWorldCupModelRegression = ({
  currentMatches = [],
  historyMatches = [],
  predictionSnapshots = [],
  oddsHistory = [],
  modelEvaluation = {},
  metadata = {},
}) => {
  const matches = dedupeMatches([...currentMatches, ...historyMatches]);
  const worldCupMatches = matches.filter(isWorldCupFinalsMatch);
  const snapshotIndex = buildSnapshotIndex(predictionSnapshots);
  const modelRows = [];
  const missing = [];
  for (const match of worldCupMatches) {
    if (match?.status !== "FINISHED") continue;
    const actual = resultCodeFor(match);
    if (!actual) continue;
    const selectedSnapshot = findPreMatchSnapshotFor(match, snapshotIndex);
    const probabilities = selectedSnapshot?.probabilities || null;
    const forecastTimeMs = selectedSnapshot?.timeMs ?? null;
    if (!probabilities) {
      missing.push({
        matchId: match?.id || null,
        sourceMatchId: match?.sourceMatchId || null,
        homeTeamName: match?.homeTeamName || null,
        awayTeamName: match?.awayTeamName || null,
        reason: "pre-cutoff-probability-snapshot-missing",
      });
      continue;
    }
    const kickoffMs = parseAuditTime(match?.kickoffTime || match?.matchDate);
    const cutoffMs = parseAuditTime(match?.predictionMeta?.cutoffTime || match?.buyEndTime);
    const deadlineMs = [kickoffMs, cutoffMs].filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
    const marketProbabilities = marketFromSnapshot(selectedSnapshot);
    const marketSource = marketProbabilities ? "same-prediction-wrapper" : null;
    const snapshot = selectedSnapshot.snapshot;
    const strictClockEligible = strictDecisionClockEligible(snapshot);
    const strictMarketEligible = strictClockEligible
      && Boolean(marketProbabilityTripletFor(snapshot?.decisionSnapshot?.markets?.HAD));
    const promotionEvidenceEligible = strictMarketEligible && trustedResultEligible(match);
    modelRows.push({
      matchId: match?.id || null,
      sourceMatchId: match?.sourceMatchId || null,
      businessDate: match?.businessDate || null,
      kickoffTime: match?.kickoffTime || null,
      stage: stageForMatch(match),
      homeTeamName: match?.homeTeamName || null,
      awayTeamName: match?.awayTeamName || null,
      actual,
      probabilities,
      marketProbabilities,
      probabilitySource: "strict-pre-cutoff-snapshot",
      marketSource,
      modelVersion: modelVersionFor(selectedSnapshot),
      policyVersion: snapshot?.policyVersion || snapshot?.decisionSnapshot?.policyVersion || "unknown",
      phase: snapshot?.phase || "unknown",
      decisionSnapshotVersion: snapshot?.decisionSnapshot?.version || null,
      forecastTime: Number.isFinite(forecastTimeMs) ? new Date(forecastTimeMs).toISOString() : null,
      deadlineTime: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
      legacyClockEligible: Number.isFinite(forecastTimeMs) && Number.isFinite(deadlineMs) && forecastTimeMs <= deadlineMs,
      strictClockEligible,
      strictMarketEligible,
      promotionEvidenceEligible,
    });
  }
  const pairedRows = modelRows.filter((row) => row.marketProbabilities);
  const modelMetrics = summarizeProbabilityRows(modelRows);
  const pairedModelMetrics = summarizeProbabilityRows(pairedRows);
  const marketMetrics = summarizeProbabilityRows(pairedRows.map((row) => ({
    ...row,
    probabilities: row.marketProbabilities,
  })));
  const comparison = compareMetrics(pairedModelMetrics, marketMetrics);
  const strictModelRows = modelRows.filter((row) => row.strictClockEligible);
  const strictMarketRows = modelRows.filter((row) => row.strictMarketEligible);
  const promotionEvidenceRows = modelRows.filter((row) => row.promotionEvidenceEligible);
  const promotionRows = Number(modelEvaluation?.sample?.promotionProbabilityRows || 0);
  const requiredPromotionRows = 500;
  return {
    ok: true,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    scope: {
      competition: "2026 FIFA World Cup finals",
      modelCohort: "latest non-review snapshot captured no later than the earlier of Sporttery cutoff and kickoff; post-match match probabilities are forbidden",
      marketCohort: "complete HAD odds from that exact selected prediction wrapper only; no cross-time odds-history or closing-line substitution",
      role: "cross-version diagnostic only; not a formal recommendation hit rate or promotion cohort",
    },
    data: {
      ...metadata,
      matches: worldCupMatches.length,
      settledMatches: worldCupMatches.filter((match) => match.status === "FINISHED").length,
      modelRows: modelRows.length,
      marketPairedRows: pairedRows.length,
      legacyClockEligibleRows: modelRows.filter((row) => row.legacyClockEligible).length,
      strictModelRows: strictModelRows.length,
      strictMarketPairedRows: strictMarketRows.length,
      promotionEvidenceRows: promotionEvidenceRows.length,
      missing,
      modelVersions: Object.fromEntries([...new Set(modelRows.map((row) => row.modelVersion))]
        .sort()
        .map((version) => [version, modelRows.filter((row) => row.modelVersion === version).length])),
      policyVersions: Object.fromEntries([...new Set(modelRows.map((row) => row.policyVersion))]
        .sort()
        .map((version) => [version, modelRows.filter((row) => row.policyVersion === version).length])),
      phases: Object.fromEntries([...new Set(modelRows.map((row) => row.phase))]
        .sort()
        .map((phase) => [phase, modelRows.filter((row) => row.phase === phase).length])),
    },
    model: modelMetrics,
    paired: {
      model: pairedModelMetrics,
      market: marketMetrics,
      comparison,
      outcomeBreakdown: pairedOutcomeBreakdown(pairedRows),
    },
    strictPromotionDiagnostic: {
      model: summarizeProbabilityRows(strictModelRows),
      pairedModel: summarizeProbabilityRows(strictMarketRows),
      pairedMarket: summarizeProbabilityRows(strictMarketRows.map((row) => ({
        ...row,
        probabilities: row.marketProbabilities,
      }))),
      eligible: false,
      role: "audit only until the global minimum sample and independent-window gates pass",
    },
    byStage: groupDiagnostics(modelRows, (row) => row.stage),
    byModelVersion: groupDiagnostics(modelRows, (row) => row.modelVersion),
    byPolicyVersion: groupDiagnostics(modelRows, (row) => row.policyVersion),
    byPhase: groupDiagnostics(modelRows, (row) => row.phase),
    promotionGate: {
      eligible: false,
      currentPromotionRows: promotionRows,
      requiredPromotionRows,
      blockers: [
        ...(promotionRows < requiredPromotionRows ? [`promotion-pairs-${promotionRows}-below-${requiredPromotionRows}`] : []),
        ...(comparison.modelNonWorseOnAllCoreMetrics ? [] : ["model-does-not-beat-same-match-market-on-all-core-metrics"]),
        ...(modelMetrics.drawRecall === 0 ? ["draw-recall-zero"] : []),
        "single-tournament-cross-version-cohort-is-diagnostic-only",
      ],
    },
    rowDetailsIncluded: false,
  };
};

const loadInputs = (dataDir = DEFAULT_DATA_DIR) => {
  const currentPayload = readJson(path.join(dataDir, "matches-current.json"), []);
  const historyPayload = readJson(path.join(dataDir, "matches-history.json"), []);
  const snapshotPayload = readJson(path.join(dataDir, "prediction-snapshots.json"), []);
  const oddsPayload = readJson(path.join(dataDir, "odds-history.json"), []);
  const evaluationPayload = readJson(path.join(dataDir, "model-evaluation.json"), {});
  return {
    currentMatches: asRows(currentPayload),
    historyMatches: asRows(historyPayload),
    predictionSnapshots: asRows(snapshotPayload),
    oddsHistory: asRows(oddsPayload),
    modelEvaluation: evaluationPayload,
    metadata: {
      dataDir,
      currentUpdatedAt: currentPayload?.updatedAt || null,
      historyUpdatedAt: historyPayload?.updatedAt || null,
      snapshotsUpdatedAt: snapshotPayload?.updatedAt || null,
      oddsUpdatedAt: oddsPayload?.updatedAt || null,
      modelEvaluationGeneratedAt: evaluationPayload?.generatedAt || null,
    },
  };
};

if (require.main === module) {
  const dataDir = path.resolve(process.env.WORLD_CUP_AUDIT_DATA_DIR || DEFAULT_DATA_DIR);
  process.stdout.write(`${JSON.stringify(buildWorldCupModelRegression(loadInputs(dataDir)), null, 2)}\n`);
}

module.exports = {
  VERSION,
  normalizeProbabilityTriplet,
  marketProbabilityTripletFor,
  topProbabilityCode,
  summarizeProbabilityRows,
  compareMetrics,
  buildSnapshotIndex,
  findPreMatchSnapshotFor,
  buildOddsIndex,
  findLatestOddsBefore,
  buildWorldCupModelRegression,
  loadInputs,
};
