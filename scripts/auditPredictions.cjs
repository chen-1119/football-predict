const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "public", "data");
const files = ["matches-current.json", "matches-history.json"]
  .map((file) => path.join(dataDir, file))
  .filter((file) => fs.existsSync(file));

const matches = files.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const enabledMarkets = new Set(["1X2", "GOALS", "BEST"]);

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

function rows() {
  return matches.flatMap((match) => (match.predictions || [])
    .filter((prediction) => enabledMarkets.has(prediction.marketType))
    .map((prediction) => ({
      date: match.businessDate || (match.kickoffTime || "").slice(0, 10),
      time: (match.kickoffTime || "").slice(11, 16),
      status: match.status,
      league: match.leagueName || match.leagueNameEn || match.leagueId,
      match: matchName(match),
      score: score(match),
      market: prediction.marketType,
      tip: prediction.tipCode,
      odds: prediction.odds,
      oddsBucket: oddsBucket(prediction.odds),
      profile: profileKey(match),
      trust: prediction.trustScore,
      result: prediction.resultStatus,
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
const settled = allRows.filter((row) => row.result !== "PENDING" && row.tip !== "WATCH");
const active = allRows.filter((row) => row.status !== "FINISHED");

console.log(`Prediction audit: ${matches.length} matches, ${allRows.length} prediction rows, ${settled.length} settled rows.`);
console.log("\nSettled by market");
console.table(summarize(settled, (row) => row.market));
console.log("\nSettled by policy");
console.table(summarize(settled, (row) => row.policy));
console.log("\nSettled by league profile");
console.table(summarize(settled, (row) => row.profile));
console.log("\nSettled 1X2 by tip");
console.table(summarize(settled.filter((row) => row.market === "1X2"), (row) => row.tip));
console.log("\nSettled 1X2 by SP bucket");
console.table(summarize(settled.filter((row) => row.market === "1X2" && ["1", "2"].includes(row.tip)), (row) => row.oddsBucket));
console.log("\nSettled GOALS by tip");
console.table(summarize(settled.filter((row) => row.market === "GOALS"), (row) => row.tip));
console.log("\nRecent settled rows");
console.table(settled
  .sort((a, b) => `${b.date}${b.time}${b.match}${b.market}`.localeCompare(`${a.date}${a.time}${a.match}${a.market}`))
  .slice(0, 30));
console.log("\nActive rows");
console.table(active
  .sort((a, b) => `${a.date}${a.time}${a.match}${a.market}`.localeCompare(`${b.date}${b.time}${b.match}${b.market}`))
  .slice(0, 60));
