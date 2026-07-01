const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "public");
const distDir = path.join(__dirname, "..", "dist");
const matchesPath = path.join(publicDir, "matches.json");
const currentMatchesPath = path.join(publicDir, "data", "matches-current.json");
const historyMatchesPath = path.join(publicDir, "data", "matches-history.json");
const syncMetaPath = path.join(publicDir, "data", "sync-meta.json");
const oddsHistoryPath = path.join(publicDir, "odds-history.json");
const dataOddsHistoryPath = path.join(publicDir, "data", "odds-history.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const allowLargeStaticDist = process.env.ALLOW_LARGE_STATIC_DIST === "1";
const disabledLargeDistPayloads = new Set([
  "matches.json",
  "odds-history.json",
  "data/matches-current.json",
  "data/matches-history.json",
  "data/odds-history.json",
  "data/post-match-reviews.json",
  "data/external-signals.json",
  "data/five-hundred-details.json",
  "data/pre-match-signals.json",
  "data/prediction-snapshots.json",
  "data/model-calibration.json",
  "data/model-strategy.json",
  "data/api-football-cache.json",
  "data/api-football-meta.json",
  "data/gpt-predictions.json",
  "data/web-consensus-signals.json",
  "data/weather-locations.json",
  "data/worldcup-kimi-dataset.json",
]);
const rootMatches = fs.existsSync(matchesPath) ? readJson(matchesPath) : [];
const currentMatches = fs.existsSync(currentMatchesPath) ? readJson(currentMatchesPath) : rootMatches;
const historyMatches = fs.existsSync(historyMatchesPath) ? readJson(historyMatchesPath) : [];
const syncMeta = fs.existsSync(syncMetaPath) ? readJson(syncMetaPath) : null;
const matches = Array.from(new Map([...currentMatches, ...historyMatches].map((match) => [match.id, match])).values());
const currentMatchIds = new Set(currentMatches.map((match) => match.id));
const hexColor = /^#[0-9a-fA-F]{6}$/;
const jLeagueText = /(?:\u65e5\u804c|\u65e5\u8054|\u65e5\u672c)/;
const staleText = /胜\(3\)|平\(1\)|负\(0\)|当前 1X2|大于 2\.5|小于 2\.5|Both Teams to Score \(GG\)|稳胆:/;

function expectedSportterySp(match, tipCode) {
  if (tipCode === "1") return match.odds?.odds1;
  if (tipCode === "X") return match.odds?.oddsX;
  if (tipCode === "2") return match.odds?.odds2;
  return undefined;
}

function expectedPredictionSp(match, prediction) {
  const odds = prediction?.oddsPoolCode === "HHAD" ? match.handicapOdds : match.odds;
  if (prediction?.tipCode === "1") return odds?.odds1;
  if (prediction?.tipCode === "X") return odds?.oddsX;
  if (prediction?.tipCode === "2") return odds?.odds2;
  return undefined;
}

function parseHandicapLine(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasFiveHundredResult(match) {
  return String(match?.resultSource || match?.externalSignals?.fiveHundred?.result?.source || "").startsWith("500.com");
}

function expectedPredictionResult(match, prediction) {
  if (prediction.tipCode === "WATCH") return "PENDING";
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
  const code = prediction.tipCode;

  if (prediction.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(code)) {
    const handicap = parseHandicapLine(prediction.handicapLine ?? match.handicapLine);
    if (handicap === null) return "PENDING";
    const adjustedHome = match.scoreHome + handicap;
    const actualHhad = adjustedHome > match.scoreAway ? "1" : adjustedHome < match.scoreAway ? "2" : "X";
    return code === actualHhad ? "WON" : "LOST";
  }

  if ((prediction.marketType === "1X2" || prediction.marketType === "BEST") && ["1", "X", "2"].includes(code)) {
    return code === actual1x2 ? "WON" : "LOST";
  }
  if (prediction.marketType === "GOALS") {
    if (/^[0-6]$/.test(code)) return total === Number(code) ? "WON" : "LOST";
    if (code === "7+") return total >= 7 ? "WON" : "LOST";
    if (code === "O2.5") return total > 2.5 ? "WON" : "LOST";
    if (code === "U2.5") return total < 2.5 ? "WON" : "LOST";
  }
  if (prediction.marketType === "GG_NG") {
    if (code === "GG") return match.scoreHome > 0 && match.scoreAway > 0 ? "WON" : "LOST";
    if (code === "NG") return match.scoreHome === 0 || match.scoreAway === 0 ? "WON" : "LOST";
  }
  return prediction.resultStatus;
}

function isModelOnlyReference(match) {
  const predictions = Array.isArray(match?.predictions) ? match.predictions : [];
  if (!predictions.length) return false;

  const modelOnlyVersion = String(match?.probabilityModel?.version || "").includes("model-only");
  const hasModelOnlyTag = predictions.some((prediction) => (
    Array.isArray(prediction?.riskTags) &&
    prediction.riskTags.some((tag) => /No official SP|Model-only reference/i.test(`${tag?.en || ""} ${tag?.zh || ""}`))
  ));
  const allowedPredictions = predictions.every((prediction) => (
    ["1X2", "BEST"].includes(prediction?.marketType) &&
    Number(prediction?.odds || 0) === 0 &&
    (prediction?.tipCode === "WATCH" || ["1", "X", "2"].includes(prediction?.tipCode))
  ));

  return modelOnlyVersion && hasModelOnlyTag && allowedPredictions;
}

const errors = [];
let oddsHistoryRows = [];

if (!Array.isArray(currentMatches) || currentMatches.length === 0) {
  errors.push("matches-current.json must contain a non-empty array.");
}

if (!Array.isArray(historyMatches)) {
  errors.push("matches-history.json must contain an array.");
}

if (!Array.isArray(matches) || matches.length === 0) {
  errors.push("combined match data must contain a non-empty array.");
}

if (syncMeta?.fallback?.keptExisting) {
  if (syncMeta.api?.stale !== true) {
    errors.push("sync-meta fallback must set api.stale=true.");
  }
  if (!syncMeta.api?.freshnessTime) {
    errors.push("sync-meta fallback must keep api.freshnessTime for the last trusted source data.");
  }
  if (!syncMeta.lastAttemptAt) {
    errors.push("sync-meta fallback must record lastAttemptAt for the failed refresh attempt.");
  }
}

if (syncMeta?.api?.freshnessTime && !Number.isFinite(Date.parse(syncMeta.api.freshnessTime))) {
  errors.push("sync-meta api.freshnessTime must be a valid ISO timestamp.");
}

if (Array.isArray(rootMatches) && rootMatches.length > currentMatches.length + 2) {
  errors.push("root matches.json should stay lightweight and contain current matches only.");
}

for (const match of matches) {
  const oddsValues = [match.odds?.odds1, match.odds?.oddsX, match.odds?.odds2];
  const hasOfficialOdds = match.oddsSource === "sporttery:HAD";
  const handicapOddsValues = [match.handicapOdds?.odds1, match.handicapOdds?.oddsX, match.handicapOdds?.odds2];
  const hasOfficialHandicapOdds = match.handicapOddsSource === "sporttery:HHAD";
  const hasReferenceOdds = String(match.oddsSource || "").startsWith("500.com")
    || String(match.handicapOddsSource || "").startsWith("500.com");
  const hasValidOdds = oddsValues.every((value) => Number.isFinite(value) && value > 1.01);
  const hasValidHandicapOdds = handicapOddsValues.every((value) => Number.isFinite(value) && value > 1.01);
  const isResultOnly = match.status === "FINISHED" && !hasOfficialOdds;
  const isFiveHundredResult = isResultOnly && hasFiveHundredResult(match);
  const isScheduleOnly = match.source === "sporttery" && match.status !== "FINISHED" && !hasOfficialOdds && !hasOfficialHandicapOdds;

  if (!hasValidOdds && !hasValidHandicapOdds && !isResultOnly && !isScheduleOnly) {
    errors.push(`${match.id}: invalid SP values ${JSON.stringify(match.odds)}`);
  }

  if (match.source === "sporttery" && !isResultOnly && !isScheduleOnly && !hasOfficialOdds && !hasOfficialHandicapOdds) {
    errors.push(`${match.id}: missing official Sporttery odds source`);
  }

  if (hasOfficialOdds && !String(match.oddsSourceUrl || "").includes("webapi.sporttery.cn")) {
    errors.push(`${match.id}: missing official Sporttery odds source URL`);
  }

  if (hasOfficialHandicapOdds && !String(match.handicapOddsSourceUrl || "").includes("webapi.sporttery.cn")) {
    errors.push(`${match.id}: missing official Sporttery handicap odds source URL`);
  }

  if (hasOfficialHandicapOdds && !String(match.handicapLine || "")) {
    errors.push(`${match.id}: missing official Sporttery handicap line`);
  }

  if (isResultOnly) {
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) {
      errors.push(`${match.id}: result-only match is missing final score`);
    }
    if (!isFiveHundredResult && !String(match.sourceUrl || "").includes("webapi.sporttery.cn")) {
      errors.push(`${match.id}: result-only match is missing official result URL`);
    }
    if (!isFiveHundredResult && (match.predictions || []).length > 0) {
      errors.push(`${match.id}: result-only match must not contain model predictions`);
    }
    if (!isFiveHundredResult && match.stats) {
      errors.push(`${match.id}: result-only match must not contain simulated model stats`);
    }
  }

  if (isScheduleOnly) {
    const hasAllowedModelOnlyReference = isModelOnlyReference(match);
    if (!hasReferenceOdds && !String(match.sourceUrl || "").includes("webapi.sporttery.cn")) {
      errors.push(`${match.id}: schedule-only match is missing official source URL`);
    }
    if ((match.predictions || []).length > 0 && !hasAllowedModelOnlyReference && !hasReferenceOdds) {
      errors.push(`${match.id}: schedule-only match must not contain model predictions`);
    }
    if (match.stats && !hasAllowedModelOnlyReference && !hasReferenceOdds) {
      errors.push(`${match.id}: schedule-only match must not contain simulated model stats`);
    }
  }

  if (Array.isArray(match.standings) && match.standings.length > 0) {
    errors.push(`${match.id}: standings are not official and must not be emitted`);
  }

  if (!hexColor.test(match.homeTeamColor || "") || !hexColor.test(match.awayTeamColor || "")) {
    errors.push(`${match.id}: invalid team color ${match.homeTeamColor}/${match.awayTeamColor}`);
  }

  if (currentMatchIds.has(match.id) && jLeagueText.test(String(match.leagueName || ""))) {
    for (const [teamName, logo, logoType] of [
      [match.homeTeamName, match.homeTeamLogo, match.homeTeamLogoType],
      [match.awayTeamName, match.awayTeamLogo, match.awayTeamLogoType],
    ]) {
      if (logoType !== "crest" || !/^(?:https?:\/\/|\/|\.\/)/.test(String(logo || ""))) {
        errors.push(`${match.id}: J-League club logo must be a crest image (${teamName || "unknown team"}).`);
      }
    }
  }

  const sportteryPick = match.predictions?.find((prediction) => prediction.marketType === "1X2");
  if (hasOfficialOdds && match.status !== "FINISHED" && !sportteryPick) {
    errors.push(`${match.id}: missing 1X2 prediction`);
  } else if (hasOfficialOdds && match.status !== "FINISHED" && Math.abs(expectedPredictionSp(match, sportteryPick) - sportteryPick.odds) > 1e-9) {
    errors.push(`${match.id}: 1X2 prediction SP does not match selected SP`);
  }

  for (const prediction of match.predictions || []) {
    if (staleText.test(JSON.stringify(prediction))) {
      errors.push(`${match.id}: stale betting copy in ${prediction.marketType}`);
    }
    if (match.status === "FINISHED") {
      const expectedResult = expectedPredictionResult(match, prediction);
      if (prediction.resultStatus !== expectedResult) {
        errors.push(`${match.id}: ${prediction.marketType} resultStatus ${prediction.resultStatus} should be ${expectedResult}`);
      }
    }
  }
}

if (fs.existsSync(oddsHistoryPath)) {
  const history = JSON.parse(fs.readFileSync(oddsHistoryPath, "utf8"));
  if (history?.source !== "sporttery:HAD") {
    errors.push("odds-history.json must use official Sporttery HAD source.");
  }

  if (!Array.isArray(history?.rows)) {
    errors.push("odds-history.json must contain a rows array.");
  } else {
    oddsHistoryRows = history.rows;
    const rowKeys = new Set();
    const historySourceIds = new Set();

    for (const row of oddsHistoryRows) {
      const sourceMatchId = String(row?.sourceMatchId || "");
      const captureBucket = String(row?.captureBucket || "");
      const key = `${sourceMatchId}|${captureBucket}`;
      const rowOdds = [row?.odds1, row?.oddsX, row?.odds2];

      if (!sourceMatchId) errors.push("odds-history.json row is missing sourceMatchId.");
      if (!Number.isFinite(Date.parse(row?.capturedAt))) errors.push(`${sourceMatchId}: invalid capturedAt.`);
      if (!Number.isFinite(Date.parse(captureBucket))) errors.push(`${sourceMatchId}: invalid captureBucket.`);
      if (!rowOdds.every((value) => Number.isFinite(value) && value > 1.01)) {
        errors.push(`${sourceMatchId}: invalid historical SP values ${JSON.stringify(rowOdds)}`);
      }
      if (row?.oddsSource !== "sporttery:HAD") {
        errors.push(`${sourceMatchId}: historical row is not official Sporttery HAD.`);
      }
      if (!String(row?.oddsSourceUrl || "").includes("webapi.sporttery.cn")) {
        errors.push(`${sourceMatchId}: historical row is missing official odds URL.`);
      }
      if (rowKeys.has(key)) {
        errors.push(`${sourceMatchId}: duplicate odds-history bucket ${captureBucket}.`);
      }

      rowKeys.add(key);
      historySourceIds.add(sourceMatchId);
    }

    for (const match of matches) {
      if (match.source !== "sporttery" || match.oddsSource !== "sporttery:HAD") continue;
      const sourceMatchId = String(match.sourceMatchId || "").replace(/^sporttery_/, "");
      if (sourceMatchId && !historySourceIds.has(sourceMatchId)) {
        errors.push(`${match.id}: missing odds-history snapshot.`);
      }
    }
  }
}

if (fs.existsSync(dataOddsHistoryPath)) {
  const rootHistory = fs.existsSync(oddsHistoryPath) ? readJson(oddsHistoryPath) : null;
  const dataHistory = readJson(dataOddsHistoryPath);
  if (rootHistory && JSON.stringify(rootHistory.rows || []) !== JSON.stringify(dataHistory.rows || [])) {
    errors.push("public/data/odds-history.json must mirror public/odds-history.json rows.");
  }
}

if (fs.existsSync(distDir)) {
  for (const fileName of [
    "matches.json",
    "odds-history.json",
    "data/matches-current.json",
    "data/matches-history.json",
    "data/team-index.json",
    "data/odds-history.json",
    "data/post-match-reviews.json",
    "data/external-signals.json",
    "data/five-hundred-details.json",
    "data/pre-match-signals.json",
    "data/prediction-snapshots.json",
    "data/model-calibration.json",
    "data/model-evaluation.json",
    "data/model-strategy.json",
    "data/api-football-cache.json",
    "data/api-football-meta.json",
    "data/gpt-predictions.json",
    "data/web-consensus-signals.json",
    "data/weather-locations.json",
    "data/worldcup-kimi-dataset.json",
    "data/sync-meta.json",
  ]) {
    const publicFile = path.join(publicDir, fileName);
    const distFile = path.join(distDir, fileName);
    if (disabledLargeDistPayloads.has(fileName) && !allowLargeStaticDist) {
      if (fs.existsSync(distFile)) {
        errors.push(`dist/${fileName} must be disabled; use paginated/protected API instead.`);
      }
      continue;
    }
    if (!fs.existsSync(publicFile) && !fs.existsSync(distFile)) continue;
    if (!fs.existsSync(publicFile) || !fs.existsSync(distFile)) {
      errors.push(`dist/${fileName} must mirror public/${fileName}.`);
      continue;
    }
    const publicText = fs.readFileSync(publicFile, "utf8");
    const distText = fs.readFileSync(distFile, "utf8");
    if (publicText !== distText) {
      errors.push(`dist/${fileName} is stale; rerun sync:data to mirror current public data.`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const statuses = matches.reduce((acc, match) => {
  acc[match.status] = (acc[match.status] || 0) + 1;
  return acc;
}, {});
const officialOddsCount = matches.filter((match) => match.oddsSource === "sporttery:HAD").length;
const officialHandicapOddsCount = matches.filter((match) => match.handicapOddsSource === "sporttery:HHAD").length;
const resultOnlyCount = matches.filter((match) => match.status === "FINISHED" && match.oddsSource !== "sporttery:HAD").length;

console.log(
  JSON.stringify(
    { ok: true, count: matches.length, statuses, officialOddsCount, officialHandicapOddsCount, resultOnlyCount, oddsHistoryRows: oddsHistoryRows.length },
    null,
    2
  )
);
