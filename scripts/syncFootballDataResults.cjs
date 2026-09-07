"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
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

function currentSeasonCode(now = new Date()) {
  const start = now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
}

function resolveSeason(value, now = new Date()) {
  if (!value || value === "previous") return previousSeasonCode(now);
  if (value === "current") return currentSeasonCode(now);
  if (!/^\d{4}$/.test(String(value))) throw new Error("--season must be current, previous or a four-digit season code");
  const code = String(value);
  if ((Number(code.slice(0, 2)) + 1) % 100 !== Number(code.slice(2))) throw new Error("season code must contain consecutive years");
  return code;
}

function sourceList({ season, only } = {}) {
  const selected = only
    ? new Set(String(only).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))
    : null;
  if (selected && [...selected].some(code => ![...MAIN_DIVISIONS, ...WORLD_DIVISIONS].includes(code))) throw new Error("--only contains an unknown division");
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

async function downloadCsv(source, destination, prior = {}, refresh = false, { maxBytes = 16 * 1024 * 1024, now = () => new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid CSV download size limit");
  const oldBytes = fs.existsSync(destination) && fs.statSync(destination).size <= maxBytes ? fs.readFileSync(destination) : null;
  const priorDigest = oldBytes ? sha256(oldBytes) : null;
  const receipt = prior.observation;
  const validPriorReceipt = receipt?.version === "football-data-content-observation-v1" && receipt.sourceUrl === source.url
    && receipt.sha256 === priorDigest && receipt.scope === "local-fetch-only" && receipt.sourceVerified === false
    && typeof receipt.firstObservedAt === "string" && Number.isFinite(Date.parse(receipt.firstObservedAt))
    && new Date(receipt.firstObservedAt).toISOString() === receipt.firstObservedAt
    && Date.parse(receipt.firstObservedAt) <= Date.parse(now());
  const headers = {
    accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
    "user-agent": "football-predict-free-source-sync/1.0",
  };
  // A legacy/tampered/missing cached file cannot become fresh through a 304.
  if (!refresh && validPriorReceipt && prior.etag) headers["if-none-match"] = prior.etag;
  if (!refresh && validPriorReceipt && prior.lastModified) headers["if-modified-since"] = prior.lastModified;
  const response = await fetch(source.url, { headers, redirect: "follow", signal: AbortSignal.timeout(45_000) });
  if (response.status === 304) {
    if (!validPriorReceipt) return { ok: false, changed: false, status: 304, error: "304 without verified cached content receipt" };
    return { ok: true, changed: false, status: 304, bytes: oldBytes.length, sha256: priorDigest,
      etag: response.headers.get("etag") || prior.etag || null,
      lastModified: response.headers.get("last-modified") || prior.lastModified || null,
      observation: receipt };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, changed: false, status: response.status, error: `HTTP ${response.status}` };
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("csv") && !contentType.includes("text/plain") && !contentType.includes("octet-stream")) {
    await response.body?.cancel();
    return { ok: false, changed: false, status: response.status, error: `unexpected content type ${contentType}` };
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return { ok: false, changed: false, status: response.status, error: "CSV exceeds download size limit" };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let received = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
      received += chunk.length;
      done(received > maxBytes ? new Error("CSV exceeds download size limit") : null, chunk);
    } }), fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    return { ok: false, changed: false, status: response.status, error: error.message };
  }
  const bytes = fs.readFileSync(temporary);
  const firstLine = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8");
  if (!/(HomeTeam|Home),(AwayTeam|Away)/i.test(firstLine) || !/(FTHG|HG),(FTAG|AG)/i.test(firstLine)) {
    fs.unlinkSync(temporary);
    return { ok: false, changed: false, status: response.status, error: "CSV header contract failed" };
  }
  const digest = sha256(bytes);
  if (digest === priorDigest) {
    fs.unlinkSync(temporary);
  } else if (fs.existsSync(destination)) {
    const previous = `${destination}.previous-${process.pid}-${crypto.randomUUID()}`;
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
    observation: validPriorReceipt && digest === priorDigest ? receipt : {
      version: "football-data-content-observation-v1", scope: "local-fetch-only", sourceVerified: false,
      sourceUrl: source.url, sha256: digest, firstObservedAt: now(),
      policy: "first recorded receipt of these exact CSV bytes; not historical result availability or independent-source proof",
    },
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function main({ argv = process.argv.slice(2), sourceRows = null, quiet = false } = {}) {
  const args = parseArgs(argv);
  const season = resolveSeason(args.season || process.env.FOOTBALL_DATA_RESULTS_SEASON);
  const outputDir = path.resolve(args.output || defaultOutputDir);
  const statusFile = path.join(outputDir, "sync-status.json");
  const priorStatus = readJson(statusFile, { sources: {} });
  const sources = sourceRows || sourceList({ season, only: args.only });
  if (!sources.length) throw new Error("no result sources selected");
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
      let downloaded;
      try { downloaded = await downloadCsv(
        source,
        destination,
        priorStatus.sources?.[source.url] || {},
        args.refresh === true,
      ); } catch (error) { downloaded = { ok: false, changed: false, error: error.message || String(error) }; }
      const row = { ...source, destination, downloaded, import: null };
      if (downloaded.ok && args.postgres) {
        try { row.import = await importHistoricalFileToPostgres({
          pool,
          dataset: "football-data",
          filePath: destination,
          batchSize: Number(args["batch-size"] || 500),
          maxRejectedRatio: Number(args["max-rejected-ratio"] || 0.01),
        }); } catch (error) { row.import = { ok: false, error: error.message || String(error) }; }
      }
      results.push(row);
      if (!quiet) process.stderr.write(`${source.code}: ${downloaded.ok ? "ok" : "failed"}${row.import ? row.import.ok ? ", imported" : ", import failed" : ""}\n`);
    }
  } finally {
    if (pool) await pool.end();
  }

  const completedAt = new Date().toISOString();
  const status = {
    version: "football-data-results-sync-v2-content-observation",
    startedAt,
    completedAt,
    season,
    outputDir,
    postgres,
    summary: {
      sources: results.length,
      downloadedOk: results.filter((row) => row.downloaded.ok).length,
      failed: results.filter((row) => !row.downloaded.ok || row.import?.ok === false).length,
      changed: results.filter((row) => row.downloaded.changed).length,
      imported: results.filter((row) => row.import?.ok).length,
    },
    sources: { ...(priorStatus.sources || {}), ...Object.fromEntries(results.map((row) => [row.url, {
      ...(priorStatus.sources?.[row.url] || {}),
      code: row.code,
      group: row.group,
      destination: row.destination,
      checkedAt: completedAt,
      ...row.downloaded,
      error: row.downloaded.error || null,
      import: row.import ? {
        ok: row.import.ok,
        error: row.import.error || null,
        idempotent: row.import.idempotent,
        runId: row.import.runId || row.import.priorRun?.run_id || null,
        acceptedRows: row.import.acceptedRows ?? row.import.priorRun?.accepted_rows ?? null,
        insertedEvents: row.import.insertedEvents ?? 0,
      } : null,
    }])) },
  };
  writeJsonDurably(statusFile, status);
  if (!quiet) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (status.summary.failed > 0 || status.summary.downloadedOk === 0 || (args.postgres && status.summary.imported === 0)) {
    process.exitCode = 1;
  }
  return status;
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

module.exports = { MAIN_DIVISIONS, WORLD_DIVISIONS, previousSeasonCode, currentSeasonCode, resolveSeason, sourceList, downloadCsv, main };
