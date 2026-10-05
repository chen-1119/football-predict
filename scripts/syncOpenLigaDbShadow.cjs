"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STORE_DIR = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(ROOT, "server-data"));
const SOURCE_URL = "https://api.openligadb.de/getmatchdata/nla/2026";
const CURRENT_FILE = path.join(ROOT, "public", "data", "matches-current.json");
const OUTPUT_FILE = path.join(STORE_DIR, "source-observations", "openligadb", "nla-2026.json");
const RAW_FILE = path.join(STORE_DIR, "source-observations", "openligadb", "nla-2026.raw.json");
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_KICKOFF_DELTA_MS = 10 * 60 * 1000;
const TEAM_ALIASES = Object.freeze({
  belgien: "belgium", "比利时": "belgium", belgium: "belgium",
  danemark: "denmark", "丹麦": "denmark", denmark: "denmark",
  deutschland: "germany", "德国": "germany", germany: "germany",
  england: "england", "英格兰": "england",
  frankreich: "france", "法国": "france", france: "france",
  griechenland: "greece", "希腊": "greece", greece: "greece",
  italien: "italy", "意大利": "italy", italy: "italy",
  kroatien: "croatia", "克罗地亚": "croatia", croatia: "croatia",
  niederlande: "netherlands", "荷兰": "netherlands", netherlands: "netherlands",
  norwegen: "norway", "挪威": "norway", norway: "norway",
  portugal: "portugal", "葡萄牙": "portugal",
  serbien: "serbia", "塞尔维亚": "serbia", serbia: "serbia",
  spanien: "spain", "西班牙": "spain", spain: "spain",
  tschechien: "czechia", "捷克": "czechia", czechia: "czechia",
  turkei: "turkey", "土耳其": "turkey", turkey: "turkey",
  wales: "wales", "威尔士": "wales",
});

const normalizedName = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/\p{M}/gu, "")
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, "")
  .trim();
const teamKey = (value) => TEAM_ALIASES[normalizedName(value)] || null;
const instant = (value) => Date.parse(value || "");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const finalScore = (row) => {
  if (row?.matchIsFinished !== true) return null;
  const result = row.matchResults?.find((entry) => entry?.resultTypeKind === "After90Minutes");
  const home = Number(result?.pointsTeam1);
  const away = Number(result?.pointsTeam2);
  return result && Number.isInteger(home) && Number.isInteger(away) && home >= 0 && away >= 0
    ? { home, away, resultId: result.resultID || null }
    : null;
};

const matchCurrentRows = (current, sourceRows, receivedAt) => {
  const sourceIndex = new Map();
  for (const row of sourceRows) {
    if (row?.leagueShortcut !== "nla" || Number(row?.leagueSeason) !== 2026) continue;
    if (!Number.isInteger(row?.matchID) || !Number.isFinite(instant(row.matchDateTimeUTC))) continue;
    const home = teamKey(row.team1?.teamName);
    const away = teamKey(row.team2?.teamName);
    if (!home || !away || home === away) continue;
    const key = `${home}:${away}`;
    sourceIndex.set(key, [...(sourceIndex.get(key) || []), row]);
  }
  const observations = [];
  const unmatched = [];
  const conflicts = [];
  const usedIds = new Set();
  for (const match of current) {
    if (match?.leagueName !== "欧国联") continue;
    const home = teamKey(match.homeTeamName) || teamKey(match.homeTeamNameEn);
    const away = teamKey(match.awayTeamName) || teamKey(match.awayTeamNameEn);
    const kickoff = instant(match.kickoffTime);
    if (!home || !away || !Number.isFinite(kickoff)) {
      unmatched.push({ matchId: match.id, reason: Number.isFinite(kickoff)
        ? "outside-reviewed-team-set" : "kickoff-unresolved" });
      continue;
    }
    const candidates = (sourceIndex.get(`${home}:${away}`) || [])
      .filter((row) => Math.abs(instant(row.matchDateTimeUTC) - kickoff) <= MAX_KICKOFF_DELTA_MS);
    if (candidates.length !== 1 || usedIds.has(candidates[0]?.matchID)) {
      unmatched.push({ matchId: match.id, reason: candidates.length > 1 ? "ambiguous" : "not-covered" });
      continue;
    }
    const row = candidates[0];
    usedIds.add(row.matchID);
    const score = finalScore(row);
    const observation = {
      matchId: match.id,
      sourceMatchId: row.matchID,
      sourceLeague: "Nations League A 2026",
      sourceHomeName: row.team1.teamName,
      sourceAwayName: row.team2.teamName,
      kickoffTime: row.matchDateTimeUTC,
      receivedAt,
      sourceLastUpdateText: row.lastUpdateDateTime || null,
      score,
      role: "shadow-only",
      preMatchEligible: false,
    };
    observations.push(observation);
    const localHome = Number(match.scoreHome ?? match.result?.scoreHome);
    const localAway = Number(match.scoreAway ?? match.result?.scoreAway);
    if (score && Number.isInteger(localHome) && Number.isInteger(localAway)
      && (score.home !== localHome || score.away !== localAway)) {
      conflicts.push({ matchId: match.id, sourceMatchId: row.matchID,
        local: { home: localHome, away: localAway }, source: score });
    }
  }
  return { observations, unmatched, conflicts };
};

const fetchSource = () => new Promise((resolve, reject) => {
  const request = https.get(SOURCE_URL, { timeout: 15_000, headers: { accept: "application/json" } }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      reject(new Error(`OpenLigaDB HTTP ${response.statusCode}`));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        request.destroy(new Error("OpenLigaDB response exceeds byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
  request.on("timeout", () => request.destroy(new Error("OpenLigaDB request timed out")));
  request.on("error", reject);
});

const writeAtomic = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
};

const writeBytesAtomic = (target, bytes) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, target);
};

const main = async () => {
  const current = JSON.parse(fs.readFileSync(CURRENT_FILE, "utf8"));
  if (!Array.isArray(current)) throw new Error("Current fixtures must be an array");
  const requestedAt = new Date().toISOString();
  const raw = await fetchSource();
  const receivedAt = new Date().toISOString();
  const rows = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(rows) || rows.length < 10) throw new Error("OpenLigaDB season response is empty or incomplete");
  const { observations, unmatched, conflicts } = matchCurrentRows(current, rows, receivedAt);
  const rawSha256 = sha256(raw);
  const output = {
    version: "openligadb-shadow-v1",
    provider: "OpenLigaDB",
    sourceUrl: SOURCE_URL,
    rights: "ODbL-1.0; private shadow observation, no raw public redistribution",
    requestedAt,
    receivedAt,
    rawSha256,
    rawPath: path.relative(ROOT, RAW_FILE),
    sourceCycleId: `openligadb-nla-2026:${receivedAt}:${rawSha256.slice(0, 16)}`,
    sourceRows: rows.length,
    currentRows: current.length,
    nationLeagueRows: current.filter((row) => row?.leagueName === "欧国联").length,
    matchedRows: observations.length,
    unmatchedRows: unmatched.length,
    conflictRows: conflicts.length,
    observations,
    unmatched,
    conflicts,
  };
  writeBytesAtomic(RAW_FILE, raw);
  writeAtomic(OUTPUT_FILE, output);
  console.log(JSON.stringify({ ...output, observations: undefined, unmatched: undefined, conflicts: undefined,
    output: path.relative(ROOT, OUTPUT_FILE) }, null, 2));
};

if (require.main === module) main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

module.exports = { SOURCE_URL, teamKey, finalScore, matchCurrentRows };
