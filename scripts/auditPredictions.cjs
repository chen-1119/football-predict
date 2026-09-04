const fs = require("fs");
const path = require("path");
const {
  buildPublicationLedgerIndex,
  loadPublicationLedger,
  resolvePublishedRecommendation,
} = require("../src/services/recommendationPublicationLedger.cjs");

const dataDir = path.join(__dirname, "..", "public", "data");
const files = ["matches-current.json", "matches-history.json"]
  .map((file) => path.join(dataDir, file))
  .filter((file) => fs.existsSync(file));
const currentFile = path.join(dataDir, "matches-current.json");

const rawMatches = files.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const rawCurrentMatches = fs.existsSync(currentFile)
  ? JSON.parse(fs.readFileSync(currentFile, "utf8"))
  : [];
const enabledMarkets = new Set(["1X2", "HHAD", "BEST"]);
const calibrationFile = path.join(dataDir, "model-calibration.json");
const strategyFile = path.join(dataDir, "model-strategy.json");
const snapshotsFile = path.join(dataDir, "prediction-snapshots.json");
const syncMetaFile = path.join(dataDir, "sync-meta.json");
const publicationLedgerFile = path.resolve(
  process.env.RECOMMENDATION_PUBLICATION_LEDGER_PATH
  || path.join(__dirname, "..", "server-data", "recommendation-publication-ledger.json")
);
const modelCalibration = fs.existsSync(calibrationFile)
  ? JSON.parse(fs.readFileSync(calibrationFile, "utf8"))
  : null;
const modelStrategy = fs.existsSync(strategyFile)
  ? JSON.parse(fs.readFileSync(strategyFile, "utf8"))
  : null;
const predictionSnapshots = fs.existsSync(snapshotsFile)
  ? JSON.parse(fs.readFileSync(snapshotsFile, "utf8"))
  : null;
const syncMeta = fs.existsSync(syncMetaFile)
  ? JSON.parse(fs.readFileSync(syncMetaFile, "utf8"))
  : null;
const publicationLedgerLoad = loadPublicationLedger(publicationLedgerFile);
const publicationIndex = buildPublicationLedgerIndex(publicationLedgerLoad);

function matchIdentity(match) {
  return String(
    match?.sourceMatchId
    || String(match?.id || "").replace(/^sporttery_/, "")
    || [
      match?.kickoffTime,
      match?.homeTeamName || match?.homeTeamNameEn || match?.homeTeamId,
      match?.awayTeamName || match?.awayTeamNameEn || match?.awayTeamId,
    ].filter(Boolean).join("|")
  ).trim();
}

function matchQuality(match) {
  let score = 0;
  if (match?.status === "FINISHED") score += 40;
  if (Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway)) score += 30;
  if (match?.predictionMeta?.lockedAt) score += 8;
  if (Array.isArray(match?.predictions) && match.predictions.length) score += 6;
  if (match?.probabilityModel?.scoreDistribution?.length) score += 4;
  if (match?.odds || match?.handicapOdds) score += 2;
  return score;
}

function dedupeMatches(matches) {
  const byId = new Map();
  for (const match of matches || []) {
    const key = matchIdentity(match);
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || matchQuality(match) >= matchQuality(previous)) {
      byId.set(key, match);
    }
  }
  return [...byId.values()];
}

const matches = dedupeMatches(rawMatches);
const currentMatches = dedupeMatches(rawCurrentMatches);

function teamName(match, side) {
  return match[`${side}TeamName`] || match[`${side}TeamNameEn`] || match[`${side}TeamId`] || side;
}

function matchName(match) {
  return `${teamName(match, "home")} vs ${teamName(match, "away")}`;
}

function score(match) {
  return Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)
    ? `${match.scoreHome}-${match.scoreAway}`
    : "-";
}

function profileKey(match) {
  const text = [
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.countryName,
    match.countryNameEn,
  ].filter(Boolean).join(" ");
  if (/(\u65e5\u804c|\u65e5\u8054|\u65e5\u672c|j1|j2|japan)/i.test(text)) return "japan";
  if (/(\u56fd\u9645|\u53cb\u8c0a|\u4e16\u754c\u676f|\u4e16\u9884|\u56fd\u5bb6|international|friendly|world cup|qualifier|fifa)/i.test(text)) return "international";
  return "other";
}

function oddsBucket(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 1.45) return "sp<=1.45";
  if (value <= 1.7) return "1.46-1.70";
  if (value <= 2.05) return "1.71-2.05";
  if (value <= 2.6) return "2.06-2.60";
  return "sp>2.60";
}

function marketType(prediction) {
  if (prediction?.oddsPoolCode === "HHAD" && prediction?.marketType === "1X2") return "HHAD";
  return prediction?.marketType || "";
}

function isReferencePrediction(prediction) {
  if (prediction?.marketType === "GOALS" || prediction?.marketType === "GG_NG") return true;
  return prediction?.recommendationAction === "reference"
    || prediction?.recommendationTier === "reference";
}

function isMainPrediction(match, prediction) {
  return prediction?.marketType === "BEST"
    && prediction?.tipCode !== "WATCH"
    && !isReferencePrediction(prediction)
    && Boolean(resolvePublishedRecommendation(match, prediction, publicationIndex));
}

function rows() {
  return matches.flatMap((match) => (match.predictions || [])
    .filter((prediction) => enabledMarkets.has(marketType(prediction)))
    .map((prediction) => ({
      date: match.businessDate || (match.kickoffTime || "").slice(0, 10),
      time: (match.kickoffTime || "").slice(11, 16),
      status: match.status,
      league: match.leagueName || match.leagueNameEn || match.leagueId,
      match: matchName(match),
      score: score(match),
      market: marketType(prediction),
      tip: prediction.tipCode,
      odds: prediction.odds,
      oddsBucket: oddsBucket(prediction.odds),
      profile: profileKey(match),
      trust: prediction.trustScore,
      result: prediction.resultStatus,
      action: prediction.recommendationAction || "recommend",
      tier: prediction.recommendationTier || "-",
      role: isMainPrediction(match, prediction) ? "main" : "reference",
      publicationId: prediction.publicationId || null,
      policy: match.predictionMeta?.policyVersion || "none",
    })));
}

function summarize(sourceRows, keyFn) {
  const grouped = new Map();
  for (const row of sourceRows) {
    const key = keyFn(row);
    const current = grouped.get(key) || { rows: 0, won: 0, lost: 0 };
    current.rows += 1;
    if (row.result === "WON") current.won += 1;
    if (row.result === "LOST") current.lost += 1;
    grouped.set(key, current);
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({
      key,
      rows: value.rows,
      won: value.won,
      lost: value.lost,
      hitRate: value.won + value.lost > 0
        ? `${((value.won / (value.won + value.lost)) * 100).toFixed(1)}%`
        : "-",
    }))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
}

const allRows = rows();
const mainRows = allRows.filter((row) => row.role === "main");
const referenceRows = allRows.filter((row) => row.role !== "main");
const isHitRateResult = (row) => (row.result === "WON" || row.result === "LOST") && row.tip !== "WATCH";
const settled = mainRows.filter(isHitRateResult);
const referenceSettled = referenceRows.filter(isHitRateResult);
const active = mainRows.filter((row) => row.status !== "FINISHED");

function average(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function contextSignals(match) {
  return match?.probabilityModel?.contextSignals || {};
}

function scheduledContextSummary(sourceMatches) {
  const source = sourceMatches.filter((match) => match.status === "SCHEDULED");
  const rows = source.map((match) => {
    const context = contextSignals(match);
    return {
      match,
      attackIntent: Number(context.attackIntent?.total),
      rankingPressure: Number(context.rankingPressure?.maxPressure),
      yellowCards: Number(context.discipline?.expectedYellowCards?.total),
      redCardRisk: Number(context.discipline?.redCardRisk?.total),
      foulPressure: Number(context.discipline?.foulPressure),
      coverageScore: Number(context.dataGaps?.coverageScore),
      sourceQuality: context.dataGaps?.sourceQuality || "-",
      severeMissingCount: Number(context.dataGaps?.severeMissingCount),
      missing: (context.dataGaps?.missing || []).map((item) => item.key).slice(0, 4).join(", "),
      connected: context.dataGaps?.connected || {},
      disciplineQuality: context.discipline?.dataQuality || "-",
      attackQuality: context.attackIntent?.dataQuality || "-",
    };
  });
  return {
    scheduled: source.length,
    withContext: rows.filter((row) => Number.isFinite(row.attackIntent) || Number.isFinite(row.redCardRisk)).length,
    avgAttackIntent: average(rows.map((row) => row.attackIntent)),
    highAttackIntent: rows.filter((row) => row.attackIntent >= 64).length,
    lowAttackIntent: rows.filter((row) => row.attackIntent <= 42).length,
    highRankingPressure: rows.filter((row) => row.rankingPressure >= 70).length,
    highYellowRisk: rows.filter((row) => row.yellowCards >= 5.2).length,
    highRedRisk: rows.filter((row) => row.redCardRisk >= 0.17).length,
    avgCoverageScore: average(rows.map((row) => row.coverageScore)),
    lowSourceQuality: rows.filter((row) => row.sourceQuality === "low").length,
    missingReferee: rows.filter((row) => row.connected.referee === false).length,
    missingTeamCards: rows.filter((row) => row.connected.teamCards === false).length,
    missingLineupInjury: rows.filter((row) => row.connected.lineup === false && row.connected.injuries === false).length,
    missingXg: rows.filter((row) => row.connected.xg === false).length,
    modelEstimatedDiscipline: rows.filter((row) => row.disciplineQuality === "model-estimated").length,
    rows,
  };
}

console.log(
  `Prediction audit: ${matches.length} matches, ${mainRows.length} ledger-verified main rows, `
  + `${settled.length} settled main rows, ${referenceRows.length} reference rows.`
);
console.log(
  `Publication ledger: ${publicationIndex.valid ? "valid" : "invalid"}, `
  + `${publicationIndex.rows} verified rows${publicationLedgerLoad.missing ? " (missing on disk)" : ""}.`
);
if (syncMeta?.historicalTraining || currentMatches.length) {
  const scheduled = currentMatches.filter((match) => match.status === "SCHEDULED");
  const auditScope = scheduled.length ? scheduled : currentMatches;
  console.log("\nHistorical training");
  console.table([{
    version: syncMeta?.historicalTraining?.version || "-",
    source: syncMeta?.historicalTraining?.source || "-",
    rows: syncMeta?.historicalTraining?.rows || 0,
    lastMatchDate: syncMeta?.historicalTraining?.lastMatchDate || "-",
    scheduled: scheduled.length,
    eloHistorical: auditScope.filter((match) => match.probabilityModel?.elo?.historicalSource).length,
    formHistorical: auditScope.filter((match) => match.probabilityModel?.form?.historicalSource).length,
    leaguePrior: auditScope.filter((match) => match.probabilityModel?.leaguePrior).length,
    lambdaLeagueWeight: auditScope.filter((match) => Number(match.probabilityModel?.lambdaBlend?.leagueWeight) > 0).length,
    trainingSignature: auditScope.filter((match) => Boolean(match.predictionMeta?.trainingSignature)).length,
  }]);
}
if (currentMatches.length) {
  const contextSummary = scheduledContextSummary(currentMatches);
  console.log("\nScheduled context signals");
  console.table([{
    scheduled: contextSummary.scheduled,
    withContext: contextSummary.withContext,
    avgAttackIntent: contextSummary.avgAttackIntent === null ? "-" : contextSummary.avgAttackIntent.toFixed(1),
    highAttackIntent: contextSummary.highAttackIntent,
    lowAttackIntent: contextSummary.lowAttackIntent,
    highRankingPressure: contextSummary.highRankingPressure,
    highYellowRisk: contextSummary.highYellowRisk,
    highRedRisk: contextSummary.highRedRisk,
    avgCoverageScore: contextSummary.avgCoverageScore === null ? "-" : contextSummary.avgCoverageScore.toFixed(1),
    lowSourceQuality: contextSummary.lowSourceQuality,
    missingReferee: contextSummary.missingReferee,
    missingTeamCards: contextSummary.missingTeamCards,
    missingLineupInjury: contextSummary.missingLineupInjury,
    missingXg: contextSummary.missingXg,
    modelEstimatedDiscipline: contextSummary.modelEstimatedDiscipline,
  }]);
  console.table(contextSummary.rows
    .filter((row) => (
      row.attackIntent >= 64
      || row.attackIntent <= 42
      || row.rankingPressure >= 70
      || row.yellowCards >= 5.2
      || row.redCardRisk >= 0.17
      || row.sourceQuality === "low"
    ))
    .sort((a, b) => (
      (b.redCardRisk || 0) - (a.redCardRisk || 0)
      || (b.attackIntent || 0) - (a.attackIntent || 0)
      || (b.rankingPressure || 0) - (a.rankingPressure || 0)
    ))
    .slice(0, 20)
    .map((row) => ({
      date: toMatchDate(row.match),
      league: row.match.leagueName || row.match.leagueNameEn || row.match.leagueId,
      match: matchName(row.match),
      attackIntent: Number.isFinite(row.attackIntent) ? row.attackIntent : "-",
      rankingPressure: Number.isFinite(row.rankingPressure) ? row.rankingPressure : "-",
      yellowCards: Number.isFinite(row.yellowCards) ? row.yellowCards.toFixed(1) : "-",
      redCardRisk: Number.isFinite(row.redCardRisk) ? `${(row.redCardRisk * 100).toFixed(1)}%` : "-",
      foulPressure: Number.isFinite(row.foulPressure) ? row.foulPressure : "-",
      coverage: Number.isFinite(row.coverageScore) ? row.coverageScore : "-",
      sourceQuality: row.sourceQuality,
      missing: row.missing || "-",
      disciplineQuality: row.disciplineQuality,
    })));
}
console.log("\nSettled by market");
console.table(summarize(settled, (row) => row.market));
console.log("\nReference rows, not counted in main hit-rate");
console.table(summarize(referenceSettled, (row) => row.market));
console.log("\nSettled by policy");
console.table(summarize(settled, (row) => row.policy));
console.log("\nSettled by league profile");
console.table(summarize(settled, (row) => row.profile));
console.log("\nSettled 1X2 by tip");
console.table(summarize(settled.filter((row) => row.market === "1X2"), (row) => row.tip));
console.log("\nSettled HHAD by tip");
console.table(summarize(settled.filter((row) => row.market === "HHAD"), (row) => row.tip));
console.log("\nSettled 1X2 by SP bucket");
console.table(summarize(settled.filter((row) => row.market === "1X2" && ["1", "2"].includes(row.tip)), (row) => row.oddsBucket));

function toMatchDate(match) {
  return String(match.businessDate || match.matchDate || match.kickoffTime || "").slice(0, 10);
}

function outcomeCode(home, away) {
  return home > away ? "1" : home < away ? "2" : "X";
}

function totalBand(home, away) {
  const total = home + away;
  if (total <= 1) return "0-1";
  if (total === 2) return "2";
  if (total === 3) return "3";
  return "4+";
}

function parseScoreLabel(label) {
  const match = String(label || "").trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;
  return {
    home: Number(match[1]),
    away: Number(match[2]),
  };
}

function scoreHitRows(days = 2) {
  const scored = matches
    .filter((match) => (
      match.status === "FINISHED"
      && Number.isFinite(match.scoreHome)
      && Number.isFinite(match.scoreAway)
      && Number.isFinite(match.projectedScoreHome)
      && Number.isFinite(match.projectedScoreAway)
    ))
    .sort((a, b) => `${toMatchDate(a)}${a.kickoffTime || ""}`.localeCompare(`${toMatchDate(b)}${b.kickoffTime || ""}`));
  if (!scored.length) return [];

  const latestDate = scored.map(toMatchDate).filter(Boolean).sort().at(-1);
  const latestTime = Date.parse(`${latestDate}T00:00:00Z`);
  const cutoff = Number.isFinite(latestTime)
    ? new Date(latestTime - Math.max(0, days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : latestDate;

  return scored
    .filter((match) => toMatchDate(match) >= cutoff)
    .map((match) => {
      const actualHome = Number(match.scoreHome);
      const actualAway = Number(match.scoreAway);
      const projectedHome = Number(match.projectedScoreHome);
      const projectedAway = Number(match.projectedScoreAway);
      const topScoreRows = (match.probabilityModel?.scoreDistribution || [])
        .slice(0, 3)
        .map((item) => parseScoreLabel(item.label))
        .filter(Boolean);
      const topScores = (match.probabilityModel?.scoreDistribution || [])
        .slice(0, 3)
        .map((item) => item.label)
        .join(", ");
      return {
        date: toMatchDate(match),
        league: match.leagueName || match.leagueNameEn || match.leagueId,
        match: matchName(match),
        actual: `${actualHome}-${actualAway}`,
        projected: `${projectedHome}-${projectedAway}`,
        exact: actualHome === projectedHome && actualAway === projectedAway ? "Y" : "N",
        outcome: outcomeCode(actualHome, actualAway) === outcomeCode(projectedHome, projectedAway) ? "Y" : "N",
        over25: (actualHome + actualAway > 2.5) === (projectedHome + projectedAway > 2.5) ? "Y" : "N",
        totalBand: totalBand(actualHome, actualAway) === totalBand(projectedHome, projectedAway) ? "Y" : "N",
        top3Exact: topScoreRows.some((row) => row.home === actualHome && row.away === actualAway) ? "Y" : "N",
        top3Outcome: topScoreRows.some((row) => outcomeCode(row.home, row.away) === outcomeCode(actualHome, actualAway)) ? "Y" : "N",
        top3Over25: topScoreRows.some((row) => (row.home + row.away > 2.5) === (actualHome + actualAway > 2.5)) ? "Y" : "N",
        top3TotalBand: topScoreRows.some((row) => totalBand(row.home, row.away) === totalBand(actualHome, actualAway)) ? "Y" : "N",
        topScores,
      };
    });
}

function summarizeScoreRows(scoreRows) {
  const pctText = (count, total) => total ? `${((count / total) * 100).toFixed(1)}%` : "-";
  return {
    rows: scoreRows.length,
    exact: pctText(scoreRows.filter((row) => row.exact === "Y").length, scoreRows.length),
    outcome: pctText(scoreRows.filter((row) => row.outcome === "Y").length, scoreRows.length),
    over25: pctText(scoreRows.filter((row) => row.over25 === "Y").length, scoreRows.length),
    totalBand: pctText(scoreRows.filter((row) => row.totalBand === "Y").length, scoreRows.length),
    top3Exact: pctText(scoreRows.filter((row) => row.top3Exact === "Y").length, scoreRows.length),
    top3Outcome: pctText(scoreRows.filter((row) => row.top3Outcome === "Y").length, scoreRows.length),
    top3Over25: pctText(scoreRows.filter((row) => row.top3Over25 === "Y").length, scoreRows.length),
    top3TotalBand: pctText(scoreRows.filter((row) => row.top3TotalBand === "Y").length, scoreRows.length),
  };
}

const recentScoreRows = scoreHitRows(Number(process.env.RECENT_REVIEW_DAYS || 2));
console.log(`\nRecent ${Number(process.env.RECENT_REVIEW_DAYS || 2)}-day score review`);
console.table([summarizeScoreRows(recentScoreRows)]);
console.table(recentScoreRows);
const rollingReviewDays = Number(process.env.ROLLING_SCORE_REVIEW_DAYS || 14);
if (rollingReviewDays !== Number(process.env.RECENT_REVIEW_DAYS || 2)) {
  const rollingScoreRows = scoreHitRows(rollingReviewDays);
  console.log(`\nRolling ${rollingReviewDays}-day score review`);
  console.table([summarizeScoreRows(rollingScoreRows)]);
}
if (modelCalibration) {
  console.log("\nModel calibration");
  console.table([{
    version: modelCalibration.version,
    rows: modelCalibration.sample?.rows || 0,
    oneXTwo: modelCalibration.sample?.oneXTwo || 0,
    goals: modelCalibration.sample?.goals || 0,
    best: modelCalibration.sample?.best || 0,
    oneXTwoHit: modelCalibration.metrics?.oneXTwoHitRate === null || modelCalibration.metrics?.oneXTwoHitRate === undefined
      ? "-"
      : `${(modelCalibration.metrics.oneXTwoHitRate * 100).toFixed(1)}%`,
    goalsHit: modelCalibration.metrics?.goalsHitRate === null || modelCalibration.metrics?.goalsHitRate === undefined
      ? "-"
      : `${(modelCalibration.metrics.goalsHitRate * 100).toFixed(1)}%`,
    bestHit: modelCalibration.metrics?.bestHitRate === null || modelCalibration.metrics?.bestHitRate === undefined
      ? "-"
      : `${(modelCalibration.metrics.bestHitRate * 100).toFixed(1)}%`,
    brier: modelCalibration.metrics?.oneXTwoBrier ?? "-",
    logLoss: modelCalibration.metrics?.oneXTwoLogLoss ?? "-",
  }]);
  if (modelCalibration.scoreCalibration) {
    console.log("\nScore calibration");
    console.table([{
      version: modelCalibration.scoreCalibration.version,
      source: modelCalibration.scoreCalibration.source,
      rows: modelCalibration.scoreCalibration.sample?.rows || 0,
      recentRows: modelCalibration.scoreCalibration.sample?.recentRows || 0,
      sampleDays: modelCalibration.scoreCalibration.sample?.sampleDays || "-",
      exact: modelCalibration.scoreCalibration.sample?.exactHitRate === null || modelCalibration.scoreCalibration.sample?.exactHitRate === undefined
        ? "-"
        : `${(modelCalibration.scoreCalibration.sample.exactHitRate * 100).toFixed(1)}%`,
      top3Exact: modelCalibration.scoreCalibration.sample?.top3ExactHitRate === null || modelCalibration.scoreCalibration.sample?.top3ExactHitRate === undefined
        ? "-"
        : `${(modelCalibration.scoreCalibration.sample.top3ExactHitRate * 100).toFixed(1)}%`,
      top3Outcome: modelCalibration.scoreCalibration.sample?.top3OutcomeHitRate === null || modelCalibration.scoreCalibration.sample?.top3OutcomeHitRate === undefined
        ? "-"
        : `${(modelCalibration.scoreCalibration.sample.top3OutcomeHitRate * 100).toFixed(1)}%`,
      top3Band: modelCalibration.scoreCalibration.sample?.top3TotalBandHitRate === null || modelCalibration.scoreCalibration.sample?.top3TotalBandHitRate === undefined
        ? "-"
        : `${(modelCalibration.scoreCalibration.sample.top3TotalBandHitRate * 100).toFixed(1)}%`,
      lambda: modelCalibration.scoreCalibration.adjustments?.totalLambdaAdjustment ?? 0,
      bandBoosts: JSON.stringify(modelCalibration.scoreCalibration.adjustments?.bandRankBoosts || {}),
      shapeBoosts: JSON.stringify(modelCalibration.scoreCalibration.adjustments?.shapeRankBoosts || {}),
    }]);
  }
  console.log("\nDynamic gates");
  console.table(Object.entries(modelCalibration.gateByProfile || {}).map(([profile, gate]) => ({
    profile,
    reason: gate.reason,
    minProbabilityBoost: gate.minProbabilityBoost,
    minModelGapBoost: gate.minModelGapBoost,
    minHandicapSupportBoost: gate.minHandicapSupportBoost,
    trustPenalty: gate.trustPenalty,
    maxRiskTags: gate.maxRiskTags,
    goalsMinBoost: gate.goalsMinBoost,
  })));
}
if (modelStrategy) {
  console.log("\nSelf-optimization strategy");
  console.table([{
    version: modelStrategy.version,
    onlineEffect: modelStrategy.activation?.onlineEffect || "-",
    mode: modelStrategy.activation?.mode || "-",
    officialRows: modelStrategy.sample?.officialRows || 0,
    recommendationRows: modelStrategy.sample?.recommendationRows || 0,
    bestRows: modelStrategy.sample?.bestRows || 0,
    activeProfileGates: modelStrategy.activeGates?.profile || 0,
    activeMarketGates: modelStrategy.activeGates?.market || 0,
    activeOddsBucketGates: modelStrategy.activeGates?.oddsBucket || 0,
    activeTipGates: modelStrategy.activeGates?.tip || 0,
  }]);
  const activeRules = [
    ...Object.values(modelStrategy.gateByProfile || {}),
    ...Object.values(modelStrategy.gateByMarket || {}),
    ...Object.values(modelStrategy.gateByOddsBucket || {}),
    ...Object.values(modelStrategy.gateByTip || {}),
  ].filter((rule) => rule.onlineAction === "tighten");
  if (activeRules.length) {
    console.log("\nActive self-optimization rules");
    console.table(activeRules.slice(0, 20).map((rule) => ({
      key: rule.key,
      rows: rule.settled ?? rule.sample?.overall?.settled ?? 0,
      hitRate: rule.hitRate === null || rule.hitRate === undefined
        ? "-"
        : `${(rule.hitRate * 100).toFixed(1)}%`,
      roi: rule.roi ?? "-",
      probabilityBoost: rule.adjustments?.minProbabilityBoost || 0,
      modelGapBoost: rule.adjustments?.minModelGapBoost || 0,
      trustPenalty: rule.adjustments?.trustPenalty || 0,
      riskDelta: rule.adjustments?.maxRiskTagsDelta || 0,
      reasons: (rule.reasons || []).slice(0, 2).join(", "),
    })));
  }
}
if (predictionSnapshots) {
  console.log("\nPrediction snapshots");
  console.table([{
    rows: predictionSnapshots.summary?.total || predictionSnapshots.rows?.length || 0,
    appended: predictionSnapshots.summary?.appended || 0,
    updated: predictionSnapshots.summary?.updated || 0,
    baseline: predictionSnapshots.summary?.byPhase?.baseline || 0,
    mid: predictionSnapshots.summary?.byPhase?.mid || 0,
    late: predictionSnapshots.summary?.byPhase?.late || 0,
    final: predictionSnapshots.summary?.byPhase?.final || 0,
    locked: predictionSnapshots.summary?.byPhase?.locked || 0,
    review: predictionSnapshots.summary?.byPhase?.review || 0,
  }]);
}
console.log("\nRecent settled rows");
console.table(settled
  .sort((a, b) => `${b.date}${b.time}${b.match}${b.market}`.localeCompare(`${a.date}${a.time}${a.match}${a.market}`))
  .slice(0, 30));
console.log("\nActive rows");
console.table(active
  .sort((a, b) => `${a.date}${a.time}${a.match}${a.market}`.localeCompare(`${b.date}${b.time}${b.match}${b.market}`))
  .slice(0, 60));
