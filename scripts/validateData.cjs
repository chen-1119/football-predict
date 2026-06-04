const fs = require("fs");
const path = require("path");

const matchesPath = path.join(__dirname, "..", "public", "matches.json");
const oddsHistoryPath = path.join(__dirname, "..", "public", "odds-history.json");
const matches = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
const hexColor = /^#[0-9a-fA-F]{6}$/;
const staleText = /主胜|客胜|当前 1X2|大于 2\.5|小于 2\.5|Both Teams to Score \(GG\)|稳胆:/;

function expectedSportterySp(match, tipCode) {
  if (tipCode === "1") return match.odds?.odds1;
  if (tipCode === "X") return match.odds?.oddsX;
  if (tipCode === "2") return match.odds?.odds2;
  return undefined;
}

const errors = [];
let oddsHistoryRows = [];

if (!Array.isArray(matches) || matches.length === 0) {
  errors.push("matches.json must contain a non-empty array.");
}

for (const match of matches) {
  const oddsValues = [match.odds?.odds1, match.odds?.oddsX, match.odds?.odds2];
  const hasOfficialOdds = match.oddsSource === "sporttery:HAD";
  const hasValidOdds = oddsValues.every((value) => Number.isFinite(value) && value > 1.01);
  const isResultOnly = match.status === "FINISHED" && !hasOfficialOdds;

  if (!hasValidOdds && !isResultOnly) {
    errors.push(`${match.id}: invalid SP values ${JSON.stringify(match.odds)}`);
  }

  if (match.source === "sporttery" && !isResultOnly && !hasOfficialOdds) {
    errors.push(`${match.id}: missing official Sporttery HAD odds source`);
  }

  if (hasOfficialOdds && !String(match.oddsSourceUrl || "").includes("webapi.sporttery.cn")) {
    errors.push(`${match.id}: missing official Sporttery odds source URL`);
  }

  if (isResultOnly) {
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) {
      errors.push(`${match.id}: result-only match is missing final score`);
    }
    if (!String(match.sourceUrl || "").includes("webapi.sporttery.cn")) {
      errors.push(`${match.id}: result-only match is missing official result URL`);
    }
  }

  if (!hexColor.test(match.homeTeamColor || "") || !hexColor.test(match.awayTeamColor || "")) {
    errors.push(`${match.id}: invalid team color ${match.homeTeamColor}/${match.awayTeamColor}`);
  }

  const sportteryPick = match.predictions?.find((prediction) => prediction.marketType === "1X2");
  if (hasOfficialOdds && !sportteryPick) {
    errors.push(`${match.id}: missing 1X2 prediction`);
  } else if (hasOfficialOdds && Math.abs(expectedSportterySp(match, sportteryPick.tipCode) - sportteryPick.odds) > 1e-9) {
    errors.push(`${match.id}: 1X2 prediction SP does not match selected SP`);
  }

  for (const prediction of match.predictions || []) {
    if (staleText.test(JSON.stringify(prediction))) {
      errors.push(`${match.id}: stale betting copy in ${prediction.marketType}`);
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

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const statuses = matches.reduce((acc, match) => {
  acc[match.status] = (acc[match.status] || 0) + 1;
  return acc;
}, {});
const officialOddsCount = matches.filter((match) => match.oddsSource === "sporttery:HAD").length;
const resultOnlyCount = matches.filter((match) => match.status === "FINISHED" && match.oddsSource !== "sporttery:HAD").length;

console.log(
  JSON.stringify(
    { ok: true, count: matches.length, statuses, officialOddsCount, resultOnlyCount, oddsHistoryRows: oddsHistoryRows.length },
    null,
    2
  )
);
