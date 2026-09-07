"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { iterateHistoricalEvents } = require("./historicalEventStore.cjs");
const { inspectHistoricalTrainingObject } = require("./historicalTrainingReleaseArtifact.cjs");
const { sourceList } = require("./syncFootballDataResults.cjs");
const { bindHistoricalContentObservation } = require("./historicalContentObservation.cjs");

const rootDir = path.resolve(__dirname, "..");
const inputFile = path.resolve(
  process.env.HISTORICAL_TRAINING_INDEX_PATH
    || path.join(rootDir, "server-data", "training", "historical-training-index.json"),
);
const sourceDir = path.resolve(
  process.env.FOOTBALL_DATA_RESULTS_DIR
    || (process.env.SERVER_STORE_DIR
      ? path.join(process.env.SERVER_STORE_DIR, "training", "raw", "football-data")
      : path.join(rootDir, "server-data", "training", "raw", "football-data")),
);
const outputFile = path.resolve(process.env.HISTORICAL_TRAINING_OUTPUT_PATH || inputFile);
const RECENT_LIMIT = Math.max(12, Number(process.env.HISTORICAL_RECENT_MATCH_LIMIT || 32));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizeKey = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

function listCsvFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
        const relative = path.relative(directory, target).replace(/\\/g, "/");
        if (/^(main-league-season|worldwide-history)\//.test(relative)) files.push(target);
      }
    }
  };
  visit(directory);
  return files.sort();
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function teamRecord(name) {
  return {
    name,
    matches: 0,
    latestElo: 1500,
    eloUpdatedAt: null,
    firstMatchDate: "",
    lastMatchDate: "",
    recent: [],
  };
}

function rating(team) {
  const value = Number(team?.latestElo);
  return Number.isFinite(value) && value >= 800 && value <= 2400 ? value : 1500;
}

function eventKey(event) {
  return [
    event.date,
    normalizeKey(event.homeTeamNormalized || event.homeTeamRaw),
    normalizeKey(event.awayTeamNormalized || event.awayTeamRaw),
    Number(event.score?.home),
    Number(event.score?.away),
  ].join("|");
}

function existingRecentKeys(index) {
  const keys = new Set();
  for (const team of Object.values(index.teams || {})) {
    for (const row of team?.recent || []) {
      const date = String(row.kickoffTime || "").slice(0, 10);
      if (!date) continue;
      keys.add([
        date,
        normalizeKey(row.homeKey),
        normalizeKey(row.awayKey),
        Number(row.scoreHome),
        Number(row.scoreAway),
      ].join("|"));
    }
  }
  return keys;
}

function updateTeam(team, event, side, newRating, sourceObservation = null) {
  const homeKey = normalizeKey(event.homeTeamNormalized || event.homeTeamRaw);
  const awayKey = normalizeKey(event.awayTeamNormalized || event.awayTeamRaw);
  team.matches = Number(team.matches || 0) + 1;
  team.latestElo = Number(newRating.toFixed(2));
  team.eloUpdatedAt = event.date;
  if (!team.firstMatchDate || event.date < team.firstMatchDate) team.firstMatchDate = event.date;
  if (!team.lastMatchDate || event.date > team.lastMatchDate) team.lastMatchDate = event.date;
  team.recent = Array.isArray(team.recent) ? team.recent : [];
  const recentRow = {
    source: event.recentSource || "football-data.co.uk",
    division: event.competition,
    kickoffTime: event.kickoff || `${event.date}T12:00:00+00:00`,
    homeKey,
    awayKey,
    scoreHome: Number(event.score.home),
    scoreAway: Number(event.score.away),
    side,
  };
  const observation = bindHistoricalContentObservation(recentRow, event, sourceObservation);
  if (observation) recentRow.sourceObservation = observation;
  team.recent.push(recentRow);
  if (team.recent.length > RECENT_LIMIT) team.recent.splice(0, team.recent.length - RECENT_LIMIT);
}

function applyEvent(index, event, sourceObservation = null) {
  const homeKey = normalizeKey(event.homeTeamNormalized || event.homeTeamRaw);
  const awayKey = normalizeKey(event.awayTeamNormalized || event.awayTeamRaw);
  if (!index.teams[homeKey]) index.teams[homeKey] = teamRecord(event.homeTeamRaw || homeKey);
  if (!index.teams[awayKey]) index.teams[awayKey] = teamRecord(event.awayTeamRaw || awayKey);
  const home = index.teams[homeKey];
  const away = index.teams[awayKey];
  const homeBefore = rating(home);
  const awayBefore = rating(away);
  const expectedHome = 1 / (1 + 10 ** (-((homeBefore + 62) - awayBefore) / 400));
  const actualHome = event.score.home > event.score.away
    ? 1 : event.score.home < event.score.away ? 0 : 0.5;
  const goalDiff = Math.abs(Number(event.score.home) - Number(event.score.away));
  const margin = goalDiff <= 1 ? 1 : Math.min(1.75, Math.log(goalDiff + 1));
  const delta = 22 * margin * (actualHome - expectedHome);
  updateTeam(home, event, "home", homeBefore + delta, sourceObservation);
  updateTeam(away, event, "away", awayBefore - delta, sourceObservation);
}

function sourceObservationForFile(file, directory, status, manifest, now = Date.now()) {
  const relative = path.relative(directory, file).replace(/\\/g, "/");
  const match = /^(main-league-season|worldwide-history)\/([A-Z0-9]+)-(\d{4})\.csv$/.exec(relative);
  if (!match) return null;
  const expected = sourceList({ season: match[3] }).find(source => source.group === match[1] && source.code === match[2]);
  if (!expected) return null;
  const source = status?.sources?.[expected.url];
  const receipt = source?.observation;
  if (!receipt || receipt.version !== "football-data-content-observation-v1" || receipt.scope !== "local-fetch-only"
    || receipt.sourceVerified !== false || receipt.sourceUrl !== expected.url
    || typeof source.destination !== "string" || path.resolve(source.destination) !== path.resolve(file)
    || receipt.sha256 !== manifest?.sourceFileSha256 || receipt.sha256 !== fileSha256(file)
    || typeof receipt.firstObservedAt !== "string" || !Number.isFinite(Date.parse(receipt.firstObservedAt))
    || new Date(receipt.firstObservedAt).toISOString() !== receipt.firstObservedAt
    || Date.parse(receipt.firstObservedAt) > now) return null;
  return { ...receipt };
}

async function readEvents(file) {
  const iterator = iterateHistoricalEvents({ dataset: "football-data", filePath: file });
  const events = [];
  let manifest = null;
  while (true) {
    const step = await iterator.next();
    if (step.done) {
      manifest = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, manifest };
}

function derivedInitialCutoff(index, events) {
  const dates = [];
  const teamKeys = new Set(events.flatMap((event) => [
    normalizeKey(event.homeTeamNormalized || event.homeTeamRaw),
    normalizeKey(event.awayTeamNormalized || event.awayTeamRaw),
  ]));
  for (const key of teamKeys) {
    const date = String(index.teams?.[key]?.lastMatchDate || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date);
  }
  return dates.sort().at(-1) || "0000-00-00";
}

function writeJsonDurably(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (fs.existsSync(file)) {
    const previous = `${file}.previous-${process.pid}`;
    fs.renameSync(file, previous);
    try {
      fs.renameSync(temporary, file);
      fs.unlinkSync(previous);
    } catch (error) {
      if (fs.existsSync(previous) && !fs.existsSync(file)) fs.renameSync(previous, file);
      throw error;
    }
  } else {
    fs.renameSync(temporary, file);
  }
}

async function main() {
  if (!fs.existsSync(inputFile)) throw new Error(`historical training index is missing: ${inputFile}`);
  const index = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const before = inspectHistoricalTrainingObject(index);
  if (!before.ok) throw new Error(`historical training index is invalid: ${before.blockers.join(",")}`);
  const files = listCsvFiles(sourceDir);
  if (!files.length) throw new Error(`no Football-Data CSV files found under ${sourceDir}`);
  let downloadStatus = null;
  try { downloadStatus = JSON.parse(fs.readFileSync(path.join(sourceDir, "sync-status.json"), "utf8")); } catch { /* Legacy rows stay unobserved. */ }

  const watermarks = index.source?.freeFootballData?.files || {};
  const recentKeys = existingRecentKeys(index);
  const accepted = [];
  const fileReports = [];
  for (const file of files) {
    const digest = fileSha256(file);
    const relative = path.relative(sourceDir, file).replace(/\\/g, "/");
    const prior = watermarks[relative] || null;
    if (prior?.sha256 === digest) {
      fileReports.push({ ...prior, file: relative, sha256: digest, skipped: true, reason: "unchanged" });
      continue;
    }
    const { events, manifest } = await readEvents(file);
    // Recheck the parsed bytes before attaching an existing fetch receipt.
    // Neither file mtime nor this import's current time can substitute for it.
    if (manifest.sourceFileSha256 !== digest || fileSha256(file) !== digest) throw new Error("Football-Data source changed during import");
    const sourceObservation = sourceObservationForFile(file, sourceDir, downloadStatus, manifest);
    const cutoff = prior?.lastDate || derivedInitialCutoff(index, events);
    const candidates = events.filter((event) => (
      (prior ? event.date >= cutoff : event.date > cutoff)
        && !recentKeys.has(eventKey(event))
    ));
    for (const event of candidates) recentKeys.add(eventKey(event));
    accepted.push(...candidates.map((event) => ({ event, file: relative, sourceObservation })));
    fileReports.push({
      file: relative,
      sha256: digest,
      skipped: false,
      cutoff,
      sourceRows: manifest.rows,
      acceptedRows: candidates.length,
      firstDate: candidates[0]?.date || null,
      lastDate: candidates.at(-1)?.date || prior?.lastDate || manifest.dateRange.to || null,
      manifestRootHash: manifest.rootHash,
      contentObservationRows: sourceObservation ? candidates.length : 0,
    });
  }

  accepted.sort((left, right) => (
    left.event.date.localeCompare(right.event.date)
      || left.event.sourceEventId.localeCompare(right.event.sourceEventId)
  ));
  for (const row of accepted) applyEvent(index, row.event, row.sourceObservation);

  const priorAcceptedRows = Math.max(
    Number(index.source?.freeFootballData?.acceptedRows || 0),
    Number(index.sample?.freeFootballDataRows || 0),
  );
  const metadataNeedsRepair = Number(index.source?.freeFootballData?.acceptedRows || 0)
    !== priorAcceptedRows;
  if (accepted.length === 0 && !metadataNeedsRepair) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      idempotent: true,
      inputFile,
      outputFile,
      sourceDir,
      files: fileReports.length,
      acceptedRows: 0,
      inspection: before,
      fileReports,
    }, null, 2)}\n`);
    return;
  }

  const now = new Date().toISOString();
  const latestAcceptedDate = accepted.map((row) => row.event.date).sort().at(-1) || null;
  index.generatedAt = now;
  index.source = {
    ...(index.source || {}),
    name: String(index.source?.name || "historical-training").includes("Football-Data.co.uk")
      ? index.source.name
      : `${index.source?.name || "historical-training"} + Football-Data.co.uk incremental results`,
    freeFootballData: {
      version: "football-data-training-augmentation-v1",
      sourceUrl: "https://www.football-data.co.uk/data.php",
      license: "free-for-league-match-prediction",
      generatedAt: now,
      files: Object.fromEntries(fileReports.map((report) => [report.file, report])),
      acceptedRows: priorAcceptedRows + accepted.length,
    },
  };
  index.sample = {
    ...(index.sample || {}),
    rows: Number(index.sample?.rows || 0) + accepted.length,
    clubRows: Number(index.sample?.clubRows || 0) + accepted.length,
    teams: Object.keys(index.teams || {}).length,
    lastMatchDate: [index.sample?.lastMatchDate, latestAcceptedDate].filter(Boolean).sort().at(-1),
    freeFootballDataRows: Number(index.sample?.freeFootballDataRows || 0) + accepted.length,
  };
  index.raw = {
    ...(index.raw || {}),
    footballData: {
      directory: path.relative(rootDir, sourceDir).replace(/\\/g, "/"),
      files: fileReports.length,
      combinedSha256: sha256(fileReports.map((row) => `${row.file}:${row.sha256}`).sort().join("\n")),
    },
  };

  const after = inspectHistoricalTrainingObject(index);
  if (!after.ok) throw new Error(`augmented historical training index is invalid: ${after.blockers.join(",")}`);
  writeJsonDurably(outputFile, index);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    inputFile,
    outputFile,
    sourceDir,
    files: fileReports.length,
    acceptedRows: accepted.length,
    latestAcceptedDate,
    before,
    after,
    fileReports,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || "HISTORICAL_TRAINING_AUGMENT_FAILED",
      error: error.message || String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { applyEvent, derivedInitialCutoff, eventKey, listCsvFiles, normalizeKey, sourceObservationForFile };
