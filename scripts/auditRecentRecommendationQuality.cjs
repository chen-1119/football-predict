"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const historyFile = path.resolve(process.env.MATCH_HISTORY_FILE || path.join(rootDir, "public", "data", "matches-history.json"));
const now = Number.isFinite(Date.parse(process.env.AUDIT_NOW || "")) ? Date.parse(process.env.AUDIT_NOW) : Date.now();
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const text = (value) => String(value ?? "").trim();
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const parseLine = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = text(value).replace(/[＋﹢]/g, "+").replace(/[－−–—]/g, "-");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
const businessDate = (match) => {
  const explicit = text(match?.businessDate || match?.matchDate || match?.kickoffDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const kickoff = Date.parse(match?.kickoffTime || "");
  return Number.isFinite(kickoff) ? new Date(kickoff + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
};
const oddsBucket = (odds) => odds <= 1.45 ? "<=1.45" : odds <= 1.70 ? "1.46-1.70" : odds <= 2.05 ? "1.71-2.05" : odds <= 2.60 ? "2.06-2.60" : ">2.60";
const settle = (match, prediction) => {
  if (!Number.isInteger(match?.scoreHome) || !Number.isInteger(match?.scoreAway)) return null;
  let home = match.scoreHome;
  const away = match.scoreAway;
  if (prediction?.oddsPoolCode === "HHAD") {
    const line = parseLine(prediction?.handicapLine ?? match?.handicapLine);
    if (line === null) return null;
    home += line;
  }
  const actual = home > away ? "1" : home < away ? "2" : "X";
  return prediction?.tipCode === actual ? "WON" : "LOST";
};
const formalArchivedBest = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  const prediction = archive?.prediction;
  const capturedAt = Date.parse(archive?.capturedAt || "");
  const kickoffAt = Date.parse(match?.kickoffTime || "");
  if (archive?.version !== "archived-pre-match-prediction-v1"
    || archive?.source !== "immutable-pre-match-prediction-snapshot"
    || !prediction || prediction.marketType !== "BEST"
    || prediction.recommendationAction !== "recommend"
    || !["HAD", "HHAD"].includes(prediction.oddsPoolCode)
    || !["1", "X", "2"].includes(prediction.tipCode)
    || !Number.isFinite(Number(prediction.odds)) || Number(prediction.odds) <= 1
    || !Number.isFinite(capturedAt) || !Number.isFinite(kickoffAt) || capturedAt >= kickoffAt) return null;
  return prediction;
};
const summarize = (rows) => {
  const won = rows.filter((row) => row.result === "WON").length;
  const lost = rows.filter((row) => row.result === "LOST").length;
  const settled = won + lost;
  return { settled, won, lost, hitRate: settled ? Number((won / settled).toFixed(4)) : null,
    averageOdds: settled ? Number((rows.reduce((sum, row) => sum + row.odds, 0) / settled).toFixed(3)) : null };
};
const group = (rows, keyFn) => Object.fromEntries([...new Set(rows.map(keyFn).filter(Boolean))].sort().map((key) => [key, summarize(rows.filter((row) => keyFn(row) === key))]));

const history = readJson(historyFile, []);
const rows = (Array.isArray(history) ? history : []).filter((match) => match?.status === "FINISHED").map((match) => {
  const prediction = formalArchivedBest(match);
  if (!prediction) return null;
  const result = settle(match, prediction);
  if (!result) return null;
  return { matchId: text(match.id), sourceMatchId: text(match.sourceMatchId), date: businessDate(match), kickoffTime: match.kickoffTime || null,
    league: text(match.leagueName || match.leagueId) || "unknown", market: prediction.oddsPoolCode, tip: prediction.tipCode,
    odds: Number(prediction.odds), oddsBucket: oddsBucket(Number(prediction.odds)), evidenceScore: finite(prediction?.multiFactorEvidence?.evidenceScore ?? prediction?.trustScore), result };
}).filter(Boolean);

const windows = {};
for (const days of [7, 14, 30, 90]) {
  const cutoff = now - days * 86400000;
  const scoped = rows.filter((row) => { const at = Date.parse(row.kickoffTime || `${row.date}T00:00:00+08:00`); return Number.isFinite(at) && at >= cutoff && at <= now; });
  windows[`${days}d`] = { ...summarize(scoped), byMarket: group(scoped, (row) => row.market), byOddsBucket: group(scoped, (row) => row.oddsBucket), byTip: group(scoped, (row) => `${row.market}:${row.tip}`), byLeague: group(scoped, (row) => row.league) };
}

console.log(JSON.stringify({ version: "recommendation-quality-audit-v1", generatedAt: new Date(now).toISOString(), historyFile, sampleRows: rows.length, windows,
  policy: { source: "immutable archived pre-match BEST recommendations only", postMatchDirectionReconstruction: false, intendedUse: "diagnostic and conservative gate tuning" } }, null, 2));
