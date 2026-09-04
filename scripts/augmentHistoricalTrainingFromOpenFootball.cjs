"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { applyEvent, normalizeKey } = require("./augmentHistoricalTrainingFromFootballData.cjs");
const { iterateHistoricalEvents, stableStringify } = require("./historicalEventStore.cjs");
const {
  historicalWarehouseStatus,
  importHistoricalCsvToWarehouse,
} = require("./historicalTrainingWarehouse.cjs");
const { inspectHistoricalTrainingObject } = require("./historicalTrainingReleaseArtifact.cjs");

const rootDir = path.resolve(__dirname, "..");
const SOURCE_REPOSITORY = "https://github.com/openfootball/europe";
const SOURCE_DATASET = "openfootball/europe:portugal-segunda-liga";
const SOURCE_LICENSE = "CC0-1.0";
const SOURCE_VERSION = "openfootball-portugal-segunda-liga-fill-v1";
const DATASET_CONFIG = Object.freeze({
  adapter: "football-data",
  sourceDataset: SOURCE_DATASET,
  sourceUrl: SOURCE_REPOSITORY,
  license: SOURCE_LICENSE,
});
const APPROVED_SEASONS = Object.freeze([
  "2020-21_pt2.txt",
  "2021-22_pt2.txt",
  "2022-23_pt2.txt",
  "2023-24_pt2.txt",
  "2024-25_pt2.txt",
]);
const APPROVED_SOURCE_PREFIX = "https://raw.githubusercontent.com/openfootball/europe/master/portugal/";
const rawDir = path.resolve(
  process.env.OPENFOOTBALL_RAW_DIR
    || (process.env.SERVER_STORE_DIR
      ? path.join(process.env.SERVER_STORE_DIR, "training", "raw", "openfootball", "portugal")
      : path.join(rootDir, "server-data", "training", "raw", "openfootball", "portugal")),
);
const indexFile = path.resolve(
  process.env.HISTORICAL_TRAINING_INDEX_PATH
    || path.join(rootDir, "server-data", "training", "historical-training-index.json"),
);
const outputFile = path.resolve(process.env.HISTORICAL_TRAINING_OUTPUT_PATH || indexFile);
const warehouseFile = path.resolve(
  process.env.HISTORICAL_TRAINING_DB_PATH
    || (process.env.SERVER_STORE_DIR
      ? path.join(process.env.SERVER_STORE_DIR, "training", "private", "historical-training.sqlite")
      : path.join(rootDir, "server-data", "training", "private", "historical-training.sqlite")),
);
const combinedCsvFile = path.join(rawDir, "portugal-segunda-liga.csv");
const manifestFile = path.join(rawDir, "manifest.json");
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const MONTHS = Object.freeze({
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseSeasonYears(fileName) {
  const match = String(fileName || "").match(/^(\d{4})-(\d{2})_pt2\.txt$/);
  if (!match) throw new Error(`unsupported OpenFootball season file: ${fileName}`);
  const startYear = Number(match[1]);
  const endYear = Math.floor(startYear / 100) * 100 + Number(match[2]);
  return { startYear, endYear: endYear < startYear ? endYear + 100 : endYear };
}

function parseOpenFootballSeason(text, fileName) {
  const { startYear, endYear } = parseSeasonYears(fileName);
  const normalized = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  if (!/^= Portuguese Segunda Liga /m.test(normalized)) {
    throw new Error(`${fileName} is not a Portuguese Segunda Liga dataset`);
  }
  let currentDate = null;
  const rows = [];
  for (const rawLine of normalized.split("\n")) {
    const dateMatch = rawLine.match(/^\s{2}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+(\d{4}))?\s*$/);
    if (dateMatch) {
      const month = MONTHS[dateMatch[1]];
      const explicitYear = Number(dateMatch[3]);
      const year = Number.isFinite(explicitYear) && explicitYear > 1900
        ? explicitYear
        : month >= 7 ? startYear : endYear;
      currentDate = validDate(year, month, Number(dateMatch[2]));
      if (!currentDate) throw new Error(`${fileName} contains an invalid date line: ${rawLine.trim()}`);
      continue;
    }
    const match = rawLine.match(/^\s+(?:(\d{1,2}:\d{2})\s+)?(.+?)\s{2,}v\s+(.+?)\s{2,}(\d+)-(\d+)(?:\s+\([^)]*\))?\s*$/);
    if (!match) continue;
    if (!currentDate) throw new Error(`${fileName} contains a result before its date heading`);
    const homeTeam = match[2].trim();
    const awayTeam = match[3].trim();
    if (!homeTeam || !awayTeam) throw new Error(`${fileName} contains an empty team name`);
    rows.push({
      division: "PT2",
      date: currentDate,
      time: match[1] || "",
      homeTeam,
      awayTeam,
      scoreHome: Number(match[4]),
      scoreAway: Number(match[5]),
      sourceFile: fileName,
    });
  }
  // Some community season files retain future fixtures without scores. Only
  // completed rows enter training; never equate the declared schedule count
  // with result coverage. A minimum of 180 completed matches still gives a
  // useful, reviewable league sample while rejecting truncated/error pages.
  if (rows.length < 180 || rows.length > 500) {
    throw new Error(`${fileName} result count ${rows.length} is outside the approved range`);
  }
  return rows;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCombinedCsv(rows) {
  const header = ["Div", "Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG"];
  const ordered = [...rows].sort((left, right) => (
    left.date.localeCompare(right.date)
      || left.time.localeCompare(right.time)
      || left.homeTeam.localeCompare(right.homeTeam, "en")
      || left.awayTeam.localeCompare(right.awayTeam, "en")
  ));
  return `${[header, ...ordered.map((row) => [
    row.division,
    row.date,
    "",
    row.homeTeam,
    row.awayTeam,
    row.scoreHome,
    row.scoreAway,
  ])].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function assertApprovedUrl(url, fileName) {
  const expected = `${APPROVED_SOURCE_PREFIX}${fileName}`;
  if (!APPROVED_SEASONS.includes(fileName) || url !== expected) {
    throw new Error(`unapproved OpenFootball source URL: ${url}`);
  }
}

function downloadSource(url, fileName) {
  assertApprovedUrl(url, fileName);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 20_000,
      headers: { "User-Agent": "football-predict-openfootball-collector/1.0", Accept: "text/plain" },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${fileName} download returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_SOURCE_BYTES) {
          response.destroy(new Error(`${fileName} exceeded ${MAX_SOURCE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
          resolve({ raw, text, headers: response.headers });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${fileName} download timed out`)));
    request.on("error", reject);
  });
}

function writeDurably(file, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, body, { mode });
  const descriptor = fs.openSync(temporary, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  if (!fs.existsSync(file)) {
    fs.renameSync(temporary, file);
    return;
  }
  const previous = `${file}.previous-${process.pid}`;
  fs.renameSync(file, previous);
  try {
    fs.renameSync(temporary, file);
    fs.unlinkSync(previous);
  } catch (error) {
    if (fs.existsSync(previous) && !fs.existsSync(file)) fs.renameSync(previous, file);
    throw error;
  }
}

async function readCanonicalEvents(csvText) {
  const events = [];
  const iterator = iterateHistoricalEvents({ dataset: DATASET_CONFIG, input: csvText });
  let manifest = null;
  while (true) {
    const step = await iterator.next();
    if (step.done) {
      manifest = step.value;
      break;
    }
    events.push({ ...step.value, recentSource: SOURCE_DATASET });
  }
  return { events, manifest };
}

function ratingIsReady(team) {
  const rating = Number(team?.latestElo);
  return Number.isFinite(rating)
    && rating >= 800
    && rating <= 2400
    && Number(team?.matches || 0) >= 3
    && Array.isArray(team?.recent)
    && team.recent.length >= 3;
}

function fillMissingTrainingTeams(index, events) {
  const isolated = { teams: {} };
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date) || a.sourceEventId.localeCompare(b.sourceEventId))) {
    applyEvent(isolated, event);
  }
  const filledTeamKeys = [];
  for (const [key, team] of Object.entries(isolated.teams)) {
    if (ratingIsReady(index.teams?.[key]) || !ratingIsReady(team)) continue;
    index.teams[key] = team;
    filledTeamKeys.push(key);
  }
  const filled = new Set(filledTeamKeys);
  const contributingEvents = events.filter((event) => (
    filled.has(normalizeKey(event.homeTeamNormalized || event.homeTeamRaw))
      || filled.has(normalizeKey(event.awayTeamNormalized || event.awayTeamRaw))
  ));
  return {
    filledTeamKeys: filledTeamKeys.sort(),
    contributingEventIds: [...new Set(contributingEvents.map((event) => event.sourceEventId))],
  };
}

async function collectSources() {
  const files = [];
  const rows = [];
  fs.mkdirSync(rawDir, { recursive: true });
  for (const fileName of APPROVED_SEASONS) {
    const url = `${APPROVED_SOURCE_PREFIX}${fileName}`;
    let download;
    let reusedCache = false;
    try {
      download = await downloadSource(url, fileName);
      writeDurably(path.join(rawDir, fileName), download.raw);
    } catch (error) {
      const cached = path.join(rawDir, fileName);
      if (!fs.existsSync(cached)) throw error;
      const raw = fs.readFileSync(cached);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      download = { raw, text, headers: {} };
      reusedCache = true;
    }
    const parsed = parseOpenFootballSeason(download.text, fileName);
    rows.push(...parsed);
    files.push({
      file: fileName,
      url,
      sha256: sha256(download.raw),
      bytes: download.raw.length,
      rows: parsed.length,
      firstDate: parsed[0]?.date || null,
      lastDate: parsed.at(-1)?.date || null,
      reusedCache,
      etag: download.headers.etag || null,
      lastModified: download.headers["last-modified"] || null,
    });
  }
  return { files, rows };
}

async function main() {
  if (!fs.existsSync(indexFile)) throw new Error(`historical training index is missing: ${indexFile}`);
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  index.teams = index.teams && typeof index.teams === "object" ? index.teams : {};
  const before = inspectHistoricalTrainingObject(index);
  if (!before.ok) throw new Error(`historical training index is invalid: ${before.blockers.join(",")}`);

  const collected = await collectSources();
  const csvText = buildCombinedCsv(collected.rows);
  writeDurably(combinedCsvFile, csvText);
  const canonical = await readCanonicalEvents(csvText);
  const generatedAt = new Date().toISOString();
  const sourceManifest = {
    version: SOURCE_VERSION,
    generatedAt,
    sourceRepository: SOURCE_REPOSITORY,
    sourceDataset: SOURCE_DATASET,
    license: SOURCE_LICENSE,
    policy: "fill-missing-team-strength-only; never-overwrite-ready-team; date-only-conservative-availability",
    files: collected.files,
    rows: canonical.events.length,
    combinedCsvSha256: sha256(Buffer.from(csvText, "utf8")),
    canonicalRootHash: canonical.manifest.rootHash,
  };
  sourceManifest.manifestSha256 = sha256(Buffer.from(stableStringify(sourceManifest), "utf8"));
  writeDurably(manifestFile, `${JSON.stringify(sourceManifest, null, 2)}\n`);

  const warehouseImport = await importHistoricalCsvToWarehouse({
    dbPath: warehouseFile,
    dataset: DATASET_CONFIG,
    filePath: combinedCsvFile,
    createdAt: generatedAt,
    completedAt: generatedAt,
    allowRejectedRows: false,
  });

  const fill = fillMissingTrainingTeams(index, canonical.events);
  const previousOpen = index.source?.openFootball || {};
  const previousFilledTeamKeys = Array.isArray(previousOpen.filledTeamKeys) ? previousOpen.filledTeamKeys : [];
  const allFilledTeamKeys = [...new Set([...previousFilledTeamKeys, ...fill.filledTeamKeys])].sort();
  const previousOpenRows = Math.max(
    Number(index.sample?.openFootballRows || 0),
    Number(previousOpen.contributingRows || 0),
  );
  const currentOpenRows = Math.max(previousOpenRows, fill.contributingEventIds.length);
  const additionalRows = Math.max(0, currentOpenRows - previousOpenRows);
  index.generatedAt = generatedAt;
  index.source = {
    ...(index.source || {}),
    name: String(index.source?.name || "historical-training").includes("OpenFootball")
      ? index.source.name
      : `${index.source?.name || "historical-training"} + OpenFootball CC0 fill-only`,
    openFootball: {
      ...sourceManifest,
      filledTeamKeys: allFilledTeamKeys,
      contributingRows: currentOpenRows,
      warehouseImportId: warehouseImport.importId || null,
      warehouseStatus: warehouseImport.status || null,
    },
  };
  index.sample = {
    ...(index.sample || {}),
    rows: Number(index.sample?.rows || 0) + additionalRows,
    clubRows: Number(index.sample?.clubRows || 0) + additionalRows,
    teams: Object.keys(index.teams).length,
    openFootballRows: currentOpenRows,
  };
  index.raw = {
    ...(index.raw || {}),
    openFootball: {
      directory: path.relative(rootDir, rawDir).replace(/\\/g, "/"),
      manifestSha256: sourceManifest.manifestSha256,
      combinedCsvSha256: sourceManifest.combinedCsvSha256,
    },
  };

  const after = inspectHistoricalTrainingObject(index);
  if (!after.ok) throw new Error(`augmented historical training index is invalid: ${after.blockers.join(",")}`);
  writeDurably(outputFile, `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: SOURCE_DATASET,
    sourceFiles: collected.files.length,
    sourceRows: canonical.events.length,
    newlyFilledTeamKeys: fill.filledTeamKeys,
    filledTeamKeys: allFilledTeamKeys,
    contributingRows: currentOpenRows,
    indexFile: outputFile,
    warehouseFile,
    warehouseImport,
    warehouse: historicalWarehouseStatus(warehouseFile),
    before,
    after,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || "OPENFOOTBALL_TRAINING_AUGMENT_FAILED",
      error: error.message || String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPROVED_SEASONS,
  DATASET_CONFIG,
  SOURCE_DATASET,
  buildCombinedCsv,
  fillMissingTrainingTeams,
  parseOpenFootballSeason,
};
