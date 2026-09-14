"use strict";

const crypto = require("node:crypto");
const https = require("node:https");
const iconv = require("iconv-lite");
const { createPostgresPool, verifyPostgresSchemaCurrent, withPostgresTransaction } = require("../server/postgresStore.cjs");
const { parseRows, requireUsableRows } = require("./sync500Data.cjs");

const SOURCE = "500.com:jczq";
const SOURCE_URL = process.env.FIVE_HUNDRED_JCZQ_URL || "https://trade.500.com/jczq/";
const LOOP = process.argv.includes("--loop") || process.env.MARKET_COLLECTOR_LOOP === "1";
const MIN_SECONDS = Math.max(60, Number(process.env.MARKET_COLLECTOR_MIN_SECONDS || 60));
const MAX_SECONDS = Math.max(MIN_SECONDS, Number(process.env.MARKET_COLLECTOR_MAX_SECONDS || 1800));
const REQUEST_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "identity",
  Referer: "https://www.500.com/",
  Connection: "keep-alive",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const stableStringify = (value) => JSON.stringify(stableValue(value));

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "GET", headers: REQUEST_HEADERS }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const preview = iconv.decode(body.slice(0, 240), "gbk").replace(/\s+/g, " ");
          const error = new Error(`500 collector HTTP ${response.statusCode}: ${preview}`);
          error.code = [403, 429].includes(response.statusCode) ? "SOURCE_BLOCKED" : "SOURCE_HTTP_ERROR";
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(body);
      });
    });
    request.setTimeout(20_000, () => request.destroy(Object.assign(new Error("500 collector timeout"), { code: "SOURCE_TIMEOUT" })));
    request.on("error", reject);
    request.end();
  });
}

function marketsFromParsedRows(rows, observedAt) {
  const markets = [];
  for (const row of rows) {
    const signal = row.signal || {};
    const base = {
      sourceMatchId: String(signal.sourceMatchId || "").trim(),
      fixtureId: String(signal.fixtureId || "").trim() || null,
      matchNo: String(signal.matchNo || "").trim() || null,
      leagueName: signal.leagueName || null,
      homeTeamName: signal.homeTeamName || null,
      awayTeamName: signal.awayTeamName || null,
      kickoffTime: signal.kickoffTime || null,
      buyEndTime: signal.buyEndTime || null,
    };
    if (!base.sourceMatchId) continue;
    for (const [pool, odds] of Object.entries(signal.bookmakerOdds || {})) {
      if (!odds || !Number.isFinite(Number(odds.odds1)) || !Number.isFinite(Number(odds.oddsX)) || !Number.isFinite(Number(odds.odds2))) continue;
      const handicapLine = pool === "hhad" && signal.handicapLine !== undefined
        ? Number(signal.handicapLine)
        : null;
      const payload = {
        source: SOURCE,
        sourceMatchId: base.sourceMatchId,
        fixtureId: base.fixtureId,
        matchNo: base.matchNo,
        leagueName: base.leagueName,
        homeTeamName: base.homeTeamName,
        awayTeamName: base.awayTeamName,
        kickoffTime: base.kickoffTime,
        buyEndTime: base.buyEndTime,
        pool,
        bookmaker: "sporttery",
        handicapLine: Number.isFinite(handicapLine) ? handicapLine : null,
        odds1: Number(odds.odds1),
        oddsX: Number(odds.oddsX),
        odds2: Number(odds.odds2),
      };
      markets.push({ ...payload, observedAt, contentHash: sha256(stableStringify(payload)), payload });
    }
  }
  return markets;
}

function adaptivePollSeconds(markets, nowMs = Date.now()) {
  const future = markets
    .map((market) => Date.parse(market.kickoffTime || ""))
    .filter((value) => Number.isFinite(value) && value > nowMs)
    .sort((a, b) => a - b);
  if (!future.length) return Math.min(MAX_SECONDS, 900);
  const minutes = (future[0] - nowMs) / 60_000;
  let seconds = minutes <= 15 ? 60
    : minutes <= 60 ? 120
      : minutes <= 120 ? 300
        : minutes <= 360 ? 600
          : minutes <= 1440 ? 900
            : 1800;
  seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, seconds));
  return seconds;
}

function jitteredDelayMs(seconds, random = Math.random) {
  const jitter = 0.85 + random() * 0.3;
  return Math.max(MIN_SECONDS * 1000, Math.round(seconds * 1000 * jitter));
}

async function persistRun(pool, { runId, startedAt, finishedAt, status, sourceSha256, sourceBytes, nextPollSeconds, markets, error }) {
  return withPostgresTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-market-collector:500.com:jczq"]);
    await client.query(`
      INSERT INTO football.market_collector_runs
        (run_id, source, started_at, finished_at, status, rows_seen, source_sha256, source_bytes, next_poll_seconds, error_code, error_message, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [
      runId, SOURCE, startedAt, finishedAt, status, markets.length, sourceSha256 || null, sourceBytes ?? null,
      nextPollSeconds ?? null, error?.code || null, error?.message || null,
      JSON.stringify({ url: SOURCE_URL, sourceStatusCode: error?.statusCode || null }),
    ]);

    let changed = 0;
    let unchanged = 0;
    for (const market of markets) {
      const latest = await client.query(`
        SELECT l.observation_id, l.content_hash
        FROM football.market_latest l
        WHERE l.source=$1 AND l.source_match_id=$2 AND l.pool=$3 AND l.bookmaker=$4
        FOR UPDATE
      `, [SOURCE, market.sourceMatchId, market.pool, market.bookmaker]);
      if (latest.rows[0]?.content_hash === market.contentHash) {
        await client.query(`
          UPDATE football.market_observations
          SET last_seen_at=$2, seen_count=seen_count+1
          WHERE observation_id=$1
        `, [latest.rows[0].observation_id, market.observedAt]);
        await client.query(`
          UPDATE football.market_latest SET updated_at=$5
          WHERE source=$1 AND source_match_id=$2 AND pool=$3 AND bookmaker=$4
        `, [SOURCE, market.sourceMatchId, market.pool, market.bookmaker, market.observedAt]);
        unchanged += 1;
        continue;
      }
      const observationId = crypto.randomUUID();
      await client.query(`
        INSERT INTO football.market_observations
          (observation_id,run_id,source,source_match_id,fixture_id,match_no,pool,bookmaker,handicap_line,kickoff_time,
           first_seen_at,last_seen_at,seen_count,content_hash,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,1,$12,$13::jsonb)
      `, [
        observationId, runId, SOURCE, market.sourceMatchId, market.fixtureId, market.matchNo, market.pool,
        market.bookmaker, Number.isFinite(market.handicapLine) ? market.handicapLine : null, market.kickoffTime,
        market.observedAt, market.contentHash, JSON.stringify(market.payload),
      ]);
      await client.query(`
        INSERT INTO football.market_latest(source,source_match_id,pool,bookmaker,observation_id,content_hash,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (source,source_match_id,pool,bookmaker) DO UPDATE SET
          observation_id=EXCLUDED.observation_id,
          content_hash=EXCLUDED.content_hash,
          updated_at=EXCLUDED.updated_at
      `, [SOURCE, market.sourceMatchId, market.pool, market.bookmaker, observationId, market.contentHash, market.observedAt]);
      changed += 1;
    }
    await client.query(`
      UPDATE football.market_collector_runs
      SET rows_changed=$2, rows_unchanged=$3
      WHERE run_id=$1
    `, [runId, changed, unchanged]);
    return { changed, unchanged };
  }, { isolationLevel: "READ COMMITTED" });
}

async function collectOnce(pool) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    const body = await httpGetBuffer(SOURCE_URL);
    const observedAt = new Date().toISOString();
    const html = iconv.decode(body, "gbk");
    const parsedRows = requireUsableRows(parseRows(html, observedAt));
    const markets = marketsFromParsedRows(parsedRows, observedAt);
    if (!markets.length) throw Object.assign(new Error("500 collector produced no market rows"), { code: "NO_MARKETS" });
    const nextPollSeconds = adaptivePollSeconds(markets);
    const result = await persistRun(pool, {
      runId, startedAt, finishedAt: new Date().toISOString(), status: "completed",
      sourceSha256: sha256(body), sourceBytes: body.length, nextPollSeconds, markets,
    });
    return { ok: true, runId, rows: markets.length, ...result, nextPollSeconds };
  } catch (error) {
    const status = error?.code === "SOURCE_BLOCKED" ? "blocked" : "failed";
    const backoff = status === "blocked" ? Math.min(MAX_SECONDS, 1800) : Math.min(MAX_SECONDS, 300);
    await persistRun(pool, {
      runId, startedAt, finishedAt: new Date().toISOString(), status,
      sourceSha256: null, sourceBytes: null, nextPollSeconds: backoff, markets: [], error,
    }).catch(() => {});
    return { ok: false, runId, status, error: error.message || String(error), code: error.code || null, nextPollSeconds: backoff };
  }
}

async function main() {
  const pool = createPostgresPool({ applicationName: "football-market-collector" });
  try {
    await verifyPostgresSchemaCurrent(pool);
    do {
      const result = await collectOnce(pool);
      console.log(JSON.stringify({ ...result, source: SOURCE, at: new Date().toISOString() }));
      if (!LOOP) break;
      await sleep(jitteredDelayMs(result.nextPollSeconds));
    } while (true);
  } finally {
    await pool.end();
  }
}

module.exports = { adaptivePollSeconds, jitteredDelayMs, marketsFromParsedRows, collectOnce };

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code || null, error: error.message || String(error) }));
    process.exitCode = 1;
  });
}
