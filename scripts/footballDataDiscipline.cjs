"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseCsvRecord } = require("./historicalEventStore.cjs");
const { FREE_FOOTBALL_TEAM_ALIASES } = require("./freeFootballTeamAliases.cjs");

const DEFAULT_SOURCE_DIR = path.resolve(
  process.env.FOOTBALL_DATA_RESULTS_DIR
    || path.join(__dirname, "..", "server-data", "training", "raw", "football-data"),
);
const DEFAULT_BUNDLED_ARTIFACT = path.join(__dirname, "data", "football-data-discipline.json");
const MAX_PROFILE_ROWS = Math.max(5, Number(process.env.DISCIPLINE_PROFILE_MATCH_LIMIT || 24));

const PROVIDER_TEAM_ALIASES = Object.freeze({
  "nott m forest": "nottm forest",
  "manchester united": "man united",
  "manchester city": "man city",
  "hull city": "hull",
  "stoke city": "stoke",
  "leeds united": "leeds",
  "birmingham city": "birmingham",
  "brentford fc": "brentford",
  "real betis": "betis",
  "valencia cf": "valencia",
  "athletic bilbao": "ath bilbao",
});

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const normalizedAliases = new Map(
  Object.entries(FREE_FOOTBALL_TEAM_ALIASES).map(([from, to]) => [normalizeKey(from), normalizeKey(to)]),
);

function canonicalTeamKey(value) {
  const normalized = normalizeKey(value);
  const aliased = normalizedAliases.get(normalized) || normalized;
  return PROVIDER_TEAM_ALIASES[aliased] || aliased;
}

function canonicalRefereeKey(value) {
  return normalizeKey(value).replace(/\b(referee|ref)\b/g, "").trim();
}

function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function canonicalDate(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = match[3].length === 2 ? Number(`20${match[3]}`) : Number(match[3]);
    return `${String(year).padStart(4, "0")}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? text : null;
}

function normalizedHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function listStatCsvFiles(sourceDir = DEFAULT_SOURCE_DIR) {
  const root = path.resolve(sourceDir);
  const directory = path.join(root, "main-league-season");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function pushBounded(map, key, row) {
  if (!key) return;
  const rows = map.get(key) || [];
  rows.push(row);
  map.set(key, rows);
}

function parseFootballDataDisciplineFile(file, index) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows: 0, accepted: 0 };
  const header = parseCsvRecord(lines[0]).map(normalizedHeader);
  const positions = Object.fromEntries(header.map((name, position) => [name, position]));
  if (!["date", "hometeam", "awayteam", "hy", "ay", "hr", "ar"].every((key) => key in positions)) {
    return { rows: Math.max(0, lines.length - 1), accepted: 0 };
  }
  let accepted = 0;
  for (const line of lines.slice(1)) {
    let cells;
    try {
      cells = parseCsvRecord(line);
    } catch {
      continue;
    }
    const value = (key) => cells[positions[key]];
    const date = canonicalDate(value("date"));
    const homeKey = canonicalTeamKey(value("hometeam"));
    const awayKey = canonicalTeamKey(value("awayteam"));
    const homeYellow = numeric(value("hy"));
    const awayYellow = numeric(value("ay"));
    const homeRed = numeric(value("hr"));
    const awayRed = numeric(value("ar"));
    if (!date || !homeKey || !awayKey || [homeYellow, awayYellow, homeRed, awayRed].every((item) => item === null)) continue;
    const sourceFile = path.basename(file);
    pushBounded(index.teams, homeKey, { date, yellowCards: homeYellow, redCards: homeRed, sourceFile });
    pushBounded(index.teams, awayKey, { date, yellowCards: awayYellow, redCards: awayRed, sourceFile });
    const referee = String(value("referee") || "").trim();
    const refereeKey = canonicalRefereeKey(referee);
    if (refereeKey) {
      pushBounded(index.referees, refereeKey, {
        date,
        name: referee,
        yellowCards: (homeYellow || 0) + (awayYellow || 0),
        redCards: (homeRed || 0) + (awayRed || 0),
        sourceFile,
      });
    }
    accepted += 1;
  }
  return { rows: Math.max(0, lines.length - 1), accepted };
}

function buildFootballDataDisciplineIndex(options = {}) {
  const sourceDir = path.resolve(options.sourceDir || DEFAULT_SOURCE_DIR);
  const index = { version: "football-data-discipline-v2-signed-fallback", sourceDir, teams: new Map(), referees: new Map(), files: [], rows: 0, accepted: 0, asset: null };
  for (const file of listStatCsvFiles(sourceDir)) {
    const report = parseFootballDataDisciplineFile(file, index);
    index.files.push({ file: path.relative(sourceDir, file).replace(/\\/g, "/"), ...report });
    index.rows += report.rows;
    index.accepted += report.accepted;
  }
  if (!index.files.length) {
    const artifactFile = path.resolve(options.bundledArtifactFile || DEFAULT_BUNDLED_ARTIFACT);
    if (fs.existsSync(artifactFile)) {
      const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
      if (artifact?.version !== "football-data-discipline-artifact-v1"
          || !artifact.teams || !artifact.referees
          || !Array.isArray(artifact.files)) {
        throw new Error(`invalid bundled discipline artifact: ${artifactFile}`);
      }
      index.files = artifact.files;
      index.rows = Number(artifact.sourceRows || 0);
      index.accepted = Number(artifact.acceptedRows || 0);
      index.teams = new Map(Object.entries(artifact.teams));
      index.referees = new Map(Object.entries(artifact.referees));
      index.asset = {
        kind: "signed-release-artifact",
        entry: path.relative(path.join(__dirname, ".."), artifactFile).replace(/\\/g, "/"),
      };
    }
  }
  for (const rows of [...index.teams.values(), ...index.referees.values()]) rows.sort((left, right) => left.date.localeCompare(right.date));
  return index;
}

function cutoffDate(value) {
  const instant = Date.parse(value || "");
  return Number.isFinite(instant) ? new Date(instant).toISOString().slice(0, 10) : null;
}

function profileRows(rows, forecastTime, limit = MAX_PROFILE_ROWS) {
  const cutoff = cutoffDate(forecastTime);
  if (!cutoff) return [];
  // Date-only source rows have no trustworthy publication time. Exclude the
  // entire forecast date so a finished same-day match can never leak forward.
  return (rows || []).filter((row) => row.date < cutoff).slice(-limit);
}

function aggregateTeamRows(rows, teamKey) {
  if (!rows.length) return null;
  return {
    key: teamKey,
    teamName: teamKey,
    matches: rows.length,
    cardRows: rows.length,
    yellowCards: rows.reduce((sum, row) => sum + Number(row.yellowCards || 0), 0),
    redCards: rows.reduce((sum, row) => sum + Number(row.redCards || 0), 0),
    fouls: 0,
    corners: 0,
    xgFor: 0,
    xgAgainst: 0,
    xgRows: 0,
    source: "football-data.co.uk-match-statistics",
    sourceUrl: "https://www.football-data.co.uk/data.php",
    sampleFrom: rows[0].date,
    sampleTo: rows.at(-1).date,
  };
}

function teamDisciplineProfile(index, names, forecastTime, limit = MAX_PROFILE_ROWS) {
  for (const name of names || []) {
    const key = canonicalTeamKey(name);
    const rows = profileRows(index?.teams?.get(key), forecastTime, limit);
    if (rows.length) return aggregateTeamRows(rows, key);
  }
  return null;
}

function refereeDisciplineProfile(index, name, forecastTime, limit = MAX_PROFILE_ROWS) {
  const key = canonicalRefereeKey(name);
  const rows = profileRows(index?.referees?.get(key), forecastTime, limit);
  if (!rows.length) return null;
  const yellowCards = rows.reduce((sum, row) => sum + Number(row.yellowCards || 0), 0);
  const redCards = rows.reduce((sum, row) => sum + Number(row.redCards || 0), 0);
  return {
    name: rows.at(-1).name || name,
    sampleSize: rows.length,
    cardsPerMatch: Number(((yellowCards + redCards) / rows.length).toFixed(2)),
    yellowCardsPerMatch: Number((yellowCards / rows.length).toFixed(2)),
    redCardsPerMatch: Number((redCards / rows.length).toFixed(3)),
    source: "football-data.co.uk-match-statistics",
    sourceUrl: "https://www.football-data.co.uk/data.php",
    sampleFrom: rows[0].date,
    sampleTo: rows.at(-1).date,
  };
}

module.exports = {
  DEFAULT_BUNDLED_ARTIFACT,
  MAX_PROFILE_ROWS,
  buildFootballDataDisciplineIndex,
  canonicalDate,
  canonicalRefereeKey,
  canonicalTeamKey,
  listStatCsvFiles,
  refereeDisciplineProfile,
  teamDisciplineProfile,
};
