"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const {
  createPostgresPool,
  getPostgresHealth,
  runPostgresMigrations,
} = require("../server/postgresStore.cjs");
const { importHistoricalFileToPostgres } = require("./postgresHistoricalSourceStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const defaultOutputDir = path.resolve(
  process.env.SERVER_STORE_DIR
    ? path.join(process.env.SERVER_STORE_DIR, "training", "raw", "football-data")
    : path.join(rootDir, "server-data", "training", "raw", "football-data"),
);

const MAIN_DIVISIONS = Object.freeze([
  "E0", "E1", "D1", "D2", "I1", "I2", "SP1", "SP2", "F1", "F2", "N1", "P1", "B1",
]);
const WORLD_DIVISIONS = Object.freeze([
  "ARG", "AUT", "BRA", "CHN", "DNK", "FIN", "IRL", "JPN", "MEX", "NOR",
  "POL", "ROU", "RUS", "SWE", "SWZ", "USA",
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [key, inline] = token.slice(2).split("=", 2);
    if (["postgres", "refresh"].includes(key)) {
      args[key] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
  }
  return args;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readJson = (file, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJsonDurably = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
};

function previousSeasonCode(now = new Date()) {
  const year = now.getUTCFullYear();
  const seasonStart = now.getUTCMonth() >= 6 ? year - 1 : year - 2;
  return `${String(seasonStart).slice(-2)}${String(seasonStart + 1).slice(-2)}`;
}

function sourceList({ season, only } = {}) {
  const selected = only
    ? new Set(String(only).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))
    : null;
  const rows = [
    ...MAIN_DIVISIONS.map((code) => ({
      code,
      group: "main-league-season",
      url: `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`,
    })),
    ...WORLD_DIVISIONS.map((code) => ({
      code,
      group: "worldwide-history",
      url: `https://www.football-data.co.uk/new/${code}.csv`,
    })),
  ];
  return selected ? rows.filter((row) => selected.has(row.code)) : rows;
}

async function downloadCsv(source, destination, prior = {}, refresh = false) {
  const headers = {
    accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
    "user-agent": "football-predict-free-source-sync/1.0",
  };
  if (!refresh && prior.etag) headers["if-none-match"] = prior.etag;
  if (!refresh && prior.lastModified) headers["if-modified-since"] = prior.lastModified;
  const response = await fetch(source.url, { headers, redirect: "follow", signal: AbortSignal.timeout(45_000) });
  if (response.status === 304 && fs.existsSync(destination)) {
    return { ok: true, changed: false, status: 304, bytes: fs.statSync(destination).size };
  }
  if (!response.ok) {
    return { ok: false, changed: false, status: response.status, error: `HTTP ${response.status}` };
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("csv") && !contentType.includes("text/plain") && !contentType.includes("octet-stream")) {
    return { ok: false, changed: false, status: response.status, error: `unexpected content type ${contentType}` };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600 }));
  const bytes = fs.readFileSync(temporary);
  const firstLine = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8");
  if (!/(HomeTeam|Home),(AwayTeam|Away)/i.test(firstLine) || !/(FTHG|HG),(FTAG|AG)/i.test(firstLine)) {
    fs.unlinkSync(temporary);
    return { ok: false, changed: false, status: response.status, error: "CSV header contract failed" };
  }
  const digest = sha256(bytes);
  const priorDigest = fs.existsSync(destination) ? sha256(fs.readFileSync(destination)) : null;
  if (digest === priorDigest) {
    fs.unlinkSync(temporary);
  } else if (fs.existsSync(destination)) {
    const previous = `${destination}.previous-${process.pid}`;
    fs.renameSync(destination, previous);
    try {
      fs.renameSync(temporary, destination);
      fs.unlinkSync(previous);
    } catch (error) {
      if (fs.existsSync(previous) && !fs.existsSync(destination)) fs.renameSync(previous, destination);
      throw error;
    }
  } else {
    fs.renameSync(temporary, destination);
  }
  return {
    ok: true,
    changed: digest !== priorDigest,
    status: response.status,
    bytes: bytes.length,
    sha256: digest,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const season = String(args.season || process.env.FOOTBALL_DATA_RESULTS_SEASON || previousSeasonCode());
  if (!/^\d{4}$/.test(season)) throw new Error("--season must be a four-digit Football-Data season code such as 2526");
  const outputDir = path.resolve(args.output || defaultOutputDir);
  const statusFile = path.join(outputDir, "sync-status.json");
  const priorStatus = readJson(statusFile, { sources: {} });
  const sources = sourceList({ season, only: args.only });
  const startedAt = new Date().toISOString();
  const results = [];
  let pool = null;
  let postgres = null;
  try {
    if (args.postgres) {
      pool = createPostgresPool({ applicationName: "football-data-results-sync" });
      postgres = {
        health: await getPostgresHealth(pool),
        migrations: await runPostgresMigrations(pool),
      };
    }
    for (const source of sources) {
      const destination = path.join(outputDir, source.group, `${source.code}-${season}.csv`);
      const downloaded = await downloadCsv(
        source,
        destination,
        priorStatus.sources?.[source.url] || {},
        args.refresh === true,
      );
      const row = { ...source, destination, downloaded, import: null };
      if (downloaded.ok && args.postgres) {
        row.import = await importHistoricalFileToPostgres({
          pool,
          dataset: "football-data",
          filePath: destination,
          batchSize: Number(args["batch-size"] || 500),
          maxRejectedRatio: Number(args["max-rejected-ratio"] || 0.01),
        });
      }
      results.push(row);
      process.stderr.write(`${source.code}: ${downloaded.ok ? "ok" : "failed"}${row.import ? ", imported" : ""}\n`);
    }
  } finally {
    if (pool) await pool.end();
  }

  const completedAt = new Date().toISOString();
  const status = {
    version: "football-data-results-sync-v1",
    startedAt,
    completedAt,
    season,
    outputDir,
    postgres,
    summary: {
      sources: results.length,
      downloadedOk: results.filter((row) => row.downloaded.ok).length,
      failed: results.filter((row) => !row.downloaded.ok).length,
      changed: results.filter((row) => row.downloaded.changed).length,
      imported: results.filter((row) => row.import?.ok).length,
    },
    sources: Object.fromEntries(results.map((row) => [row.url, {
      code: row.code,
      group: row.group,
      destination: row.destination,
      checkedAt: completedAt,
      ...row.downloaded,
      import: row.import ? {
        ok: row.import.ok,
        idempotent: row.import.idempotent,
        runId: row.import.runId || row.import.priorRun?.run_id || null,
        acceptedRows: row.import.acceptedRows ?? row.import.priorRun?.accepted_rows ?? null,
        insertedEvents: row.import.insertedEvents ?? 0,
      } : null,
    }])),
  };
  writeJsonDurably(statusFile, status);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (status.summary.downloadedOk === 0 || (args.postgres && status.summary.imported === 0)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || "FOOTBALL_DATA_RESULTS_SYNC_FAILED",
      error: error.message || String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MAIN_DIVISIONS, WORLD_DIVISIONS, previousSeasonCode, sourceList };
