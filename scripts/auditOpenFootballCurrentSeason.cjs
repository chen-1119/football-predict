"use strict";

// Read-only upstream census. Deliberately has no warehouse, model or sync-worker
// dependency: community scores are candidates, never official settlements.
const crypto = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const LEAGUES = Object.freeze({
  "en.1": "English Premier League",
  "es.1": "Spain Primera División",
  "de.1": "Deutsche Bundesliga",
  "it.1": "Italian Serie A",
  "fr.1": "French Ligue 1",
});
const MAX_BYTES = 2 * 1024 * 1024;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function sourceUrl(season, league) {
  const parts = /^(20\d{2})-(\d{2})$/.exec(season);
  if (!parts || (Number(parts[1]) + 1) % 100 !== Number(parts[2])) throw new Error("Invalid season");
  if (!Object.hasOwn(LEAGUES, league)) throw new Error("Unsupported league");
  return `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${league}.json`;
}

function inspectSource(raw, { season, league, receivedAt }) {
  const url = sourceUrl(season, league);
  if (!strictInstant(receivedAt)) throw new Error("Invalid receipt clock");
  if (!Buffer.isBuffer(raw) || raw.length > MAX_BYTES) throw new Error("Invalid source bytes");
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const expectedName = `${LEAGUES[league]} ${season.replace("-", "/")}`;
  if (data?.name !== expectedName || !Array.isArray(data.matches) || data.matches.length > 2000) {
    throw new Error("Unexpected league, season or match schema");
  }
  const excluded = {};
  const reject = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const candidates = [];
  const groups = new Map();
  const start = `${season.slice(0, 4)}-07-01`;
  const end = `${Number(season.slice(0, 4)) + 1}-07-01`;
  // Date-only data cannot establish a result time. Conservatively quarantine
  // every same-UTC-date score as well as future dates; do not invent midnight.
  const receiptDay = new Date(receivedAt).toISOString().slice(0, 10);
  for (const match of data.matches) {
    if (!match || typeof match !== "object" || Array.isArray(match)) { reject("invalid-match"); continue; }
    const { date, team1, team2 } = match;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !strictInstant(`${date}T00:00:00Z`) || date < start || date >= end) {
      reject("invalid-or-out-of-season-date"); continue;
    }
    if (![team1, team2].every((name) => typeof name === "string" && name === name.trim()
      && name.length > 0 && name.length <= 160 && !/[\x00-\x1f\x7f]/.test(name)) || team1 === team2) {
      reject("invalid-team-identity"); continue;
    }
    // Never strip suffixes, fuzzy-match or fold reserve/women teams into clubs.
    const identity = JSON.stringify([season, league, date, team1, team2]);
    const group = groups.get(identity) || [];
    group.push(match);
    groups.set(identity, group);
  }
  for (const [identity, rows] of groups) {
    // Quarantine ALL copies, including a scored/unscored disagreement.
    if (rows.length !== 1) { for (const _row of rows) reject("duplicate-identity"); continue; }
    const match = rows[0];
    const ft = match.score?.ft;
    if (ft === undefined) { reject("no-full-time-score"); continue; }
    if (!Array.isArray(ft) || ft.length !== 2 || !ft.every((score) => Number.isSafeInteger(score) && score >= 0)) {
      reject("invalid-full-time-score"); continue;
    }
    if (match.date >= receiptDay) { reject("same-day-or-future-score"); continue; }
    candidates.push({
      sourceEventId: `openfootball-json:${sha256(identity)}`,
      date: match.date, homeTeamRaw: match.team1, awayTeamRaw: match.team2,
      scoreHome: ft[0], scoreAway: ft[1], rawRowSha256: sha256(JSON.stringify(match)),
      sourceVerified: false, entityMappingStatus: "unverified",
      resultObservedAt: null, upstreamPublishedAt: null, kickoff: null,
    });
  }
  candidates.sort((a, b) => a.date.localeCompare(b.date) || a.sourceEventId.localeCompare(b.sourceEventId));
  const teams = new Map();
  for (const row of candidates) for (const side of ["homeTeamRaw", "awayTeamRaw"]) {
    const previous = teams.get(row[side]) || { rawName: row[side], rows: 0, latestDate: null };
    previous.rows++;
    previous.latestDate = row.date;
    teams.set(row[side], previous);
  }
  return {
    league, season, url, name: data.name, contentSha256: sha256(raw), bytes: raw.length,
    receipt: { receivedAt: new Date(receivedAt).toISOString(), scope: "this-fetch-only", sourceVerified: false },
    // receivedAt is not persistent firstObservedAt, an official publication
    // clock, proof of pre-decision availability or evidence of current freshness.
    totalRows: data.matches.length, candidateRows: candidates.length, excluded,
    latestResultDate: candidates.at(-1)?.date || null,
    teamCoverage: [...teams.values()].sort((a, b) => a.rawName.localeCompare(b.rawName)),
    candidates, productionAdmittedRows: 0,
  };
}

async function fetchSource(season, league, fetchImpl = fetch) {
  const url = sourceUrl(season, league);
  const response = await fetchImpl(url, {
    redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Accept: "application/json", "User-Agent": "football-openfootball-readonly-audit/1.0" },
  });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Source exceeds byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return inspectSource(Buffer.concat(chunks), { season, league, receivedAt: new Date().toISOString() });
}

async function auditSeason(season, fetchImpl = fetch) {
  const sources = [];
  // Sequential, bounded five-source audit; no automated retry or paid API use.
  for (const league of Object.keys(LEAGUES)) {
    sourceUrl(season, league);
    try { sources.push({ ok: true, ...await fetchSource(season, league, fetchImpl) }); }
    catch (error) {
      const code = error.cause?.code || error.code;
      sources.push({ ok: false, league, season, error: error.message,
        errorCode: typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : null });
    }
  }
  return {
    version: "openfootball-current-season-readonly-audit-v1", checkedAt: new Date().toISOString(),
    season, ok: sources.every((source) => source.ok), sources,
    candidateRows: sources.reduce((n, source) => n + (source.candidateRows || 0), 0),
    productionAdmittedRows: 0, productionDataWritten: false,
    limitations: ["community-not-official", "unverified-entity-mapping", "no-upstream-result-clock",
      "receipt-not-first-observation", "no-decision-time-availability-proof", "no-odds-or-lineups",
      "generation-time-is-not-result-freshness"],
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) { console.error("Usage: node scripts/auditOpenFootballCurrentSeason.cjs YYYY-YY"); process.exitCode = 1; }
  else auditSeason(args[0]).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { LEAGUES, MAX_BYTES, sourceUrl, inspectSource, fetchSource, auditSeason };
