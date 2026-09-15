'use strict';
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const policy = require('../collectors/market/policy.cjs');
const transport = require('../collectors/market/http.cjs');
const store = require('../collectors/market/store.cjs');

/** One source cycle. Session lock covers the request, not only the database write. */
async function collectOnce(pool, dependencies = {}) {
  const cfg = dependencies.config || policy.config();
  const now = dependencies.now || Date.now;
  const fetchPage = dependencies.fetchPage || transport.fetchMarketPage;
  const parse = dependencies.parseRows || ((body, observedAt) => {
    const { parseRows } = require('./sync500Data.cjs');
    return parseRows(new TextDecoder('gbk').decode(body), observedAt);
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (dependencies.signal?.aborted) abort();
  const client = await pool.connect();
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) abort();
  let locked = false, broken = false, runId, startedAt;
  const onConnectionError = () => { broken = true; abort(); };
  client.on?.('error', onConnectionError);
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [store.LOCK_NAME])).rows[0]?.locked === true;
    if (!locked) return { ok: true, skipped: 'another-worker', nextPollSeconds: cfg.minSeconds };
    const previous = await store.previousRun(client);
    const cooling = store.remainingDelay(previous, now());
    if (cooling) return { ok: true, skipped: 'not-due', nextPollSeconds: cooling, sourceStatus: previous.status };
    if (controller.signal.aborted) return { ok: false, status: 'cancelled', nextPollSeconds: cfg.minSeconds };
    runId = randomUUID(); startedAt = new Date(now()).toISOString();
    await store.startRun(client, runId, startedAt);
    try {
      const response = await fetchPage(cfg.sourceUrl, { signal: controller.signal });
      const observedAt = new Date(now()).toISOString();
      const normalized = policy.normalizeRows(parse(response.body, observedAt), observedAt);
      const noEvents = !normalized.markets.length && normalized.rejected.length === 0
        && /<p\b[^>]*class=["']nodata-txt["'][^>]*>\s*暂无赛事信息\s*<\/p>/i.test(new TextDecoder('gbk').decode(response.body));
      if (!normalized.markets.length && !noEvents) throw policy.failure('NO_VALID_MARKETS', 'Source returned no valid market rows');
      const seconds = policy.adaptivePollSeconds(normalized.markets, now(), cfg);
      const nextPollSeconds = Math.ceil(policy.jitteredDelayMs(seconds, dependencies.random || Math.random, cfg) / 1000);
      const finishedAt = new Date(now()).toISOString();
      const payload = { url: cfg.sourceUrl, predictionEligible: false, consecutiveFailures: 0,
        nextAttemptAt: new Date(Date.parse(finishedAt) + nextPollSeconds * 1000).toISOString(),
        rejectedRows: normalized.rejected, sourcePublishedAt: null, sourceState: noEvents ? 'no-events' : 'available' };
      const result = await store.persistRun(client, { runId, startedAt, finishedAt, status: 'completed',
        markets: normalized.markets, sourceSha256: policy.hash(response.body), sourceBytes: response.body.length,
        httpStatus: response.statusCode, nextPollSeconds, payload }, dependencies.refreshFeature);
      return { ok: true, runId, rows: normalized.markets.length, sourceState: payload.sourceState, rejectedRows: normalized.rejected.length, ...result, nextPollSeconds };
    } catch (error) {
      if (broken) throw error;
      const consecutiveFailures = Math.min(100, Number(previous?.payload?.consecutiveFailures || 0) + 1);
      const nextPollSeconds = policy.failureDelaySeconds(error, consecutiveFailures);
      const finishedAt = new Date(now()).toISOString();
      const status = error.code === 'SOURCE_BLOCKED' ? 'blocked' : 'failed';
      await store.persistRun(client, { runId, startedAt, finishedAt, status, markets: [], error, nextPollSeconds,
        payload: { url: cfg.sourceUrl, predictionEligible: false, consecutiveFailures,
          nextAttemptAt: new Date(Date.parse(finishedAt) + nextPollSeconds * 1000).toISOString() } });
      return { ok: false, runId, status, code: error.code || 'COLLECTION_FAILED', nextPollSeconds };
    }
  } finally {
    if (locked && !broken) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [store.LOCK_NAME]); }
      catch { broken = true; }
    }
    client.removeListener?.('error', onConnectionError);
    client.release(broken);
    dependencies.signal?.removeEventListener('abort', abort);
  }
}
async function main() {
  const cfg = policy.config();
  const loop = process.argv.includes('--loop') || process.env.MARKET_COLLECTOR_LOOP === '1';
  // Defer runtime-only dependencies so pure policy tests need no PostgreSQL or source credentials.
  const { createPostgresPool, verifyPostgresSchemaCurrent } = require('../server/postgresStore.cjs');
  const pool = createPostgresPool({ applicationName: 'football-market-collector', max: 2 });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  pool.on('error', () => controller.abort());
  try {
    await verifyPostgresSchemaCurrent(pool);
    do {
      const result = await collectOnce(pool, { config: cfg, signal: controller.signal });
      console.log(JSON.stringify({ ...result, source: policy.SOURCE, at: new Date().toISOString() }));
      if (!loop) { if (!result.ok) process.exitCode = 1; break; }
      // Slice very long waits to avoid Node's 32-bit timer overflow. The persisted due time is rechecked.
      await sleep(Math.min(result.nextPollSeconds * 1000, 3600_000), undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    transport.closeMarketTransport();
    await pool.end();
  }
}
module.exports = { adaptivePollSeconds: policy.adaptivePollSeconds, jitteredDelayMs: policy.jitteredDelayMs,
  marketsFromParsedRows: policy.marketsFromParsedRows, collectOnce };
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'COLLECTOR_RUNTIME_ERROR' })); process.exitCode = 1;
});
