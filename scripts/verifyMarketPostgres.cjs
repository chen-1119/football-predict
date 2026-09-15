'use strict';
// Real PostgreSQL integration checks. Refuse to run against the production database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createPostgresPool, runPostgresMigrations, verifyPostgresSchemaCurrent } = require('../server/postgresStore.cjs');
const { normalizeRows, config, failure } = require('../collectors/market/policy.cjs');
const { startRun, persistRun } = require('../collectors/market/store.cjs');
const { collectOnce } = require('./runMarketCollector.cjs');
const connectionString = process.env.MARKET_TEST_POSTGRES_URL;
assert(connectionString, 'Set MARKET_TEST_POSTGRES_URL to an empty disposable PostgreSQL database');
assert.match(new URL(connectionString).pathname, /^\/football_market_test_[a-z0-9_]+$/);
const pool = createPostgresPool({ connectionString, max: 4, applicationName: 'market-integration-test' });
const at = Date.parse('2026-09-15T02:00:00Z');
const raw = (price = 1.8) => [{ keys: ['991001', '2026-09-15:周二001'], signal: { sourceMatchId: '991001', homeTeamName: 'Synthetic Home', awayTeamName: 'Synthetic Away',
  kickoffTime: '2026-09-15T12:00:00Z', bookmakerOdds: { had: { odds1: price, oddsX: 3.4, odds2: 4.2 } } } }];
const checks = [];
async function childProbe(now) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--probe', String(now)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Probe deadline exceeded')); }, 10000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); code ? reject(new Error(err || 'Probe failed')) : resolve(JSON.parse(out)); });
  });
}
async function main() {
  const db = (await pool.query('select current_database() as name, current_user as role')).rows[0];
  assert.match(db.name, /^football_market_test_[a-z0-9_]+$/);
  if (process.argv.includes('--probe')) {
    const result = await collectOnce(pool, { now: () => Number(process.argv.at(-1)), config: config({}), fetchPage: async () => { throw failure('TEST_UNEXPECTED_FETCH', 'No request expected'); } });
    console.log(JSON.stringify(result)); return;
  }
  await runPostgresMigrations(pool); await verifyPostgresSchemaCurrent(pool);
  checks.push('all migrations and runtime schema check under runtime role');
  const client = await pool.connect();
  let replayInput;
  try {
    for (const [index, price] of [1.8, 1.7, 1.8, 1.8].entries()) {
      const observedAt = new Date(at + index * 60000).toISOString(), runId = randomUUID();
      await startRun(client, runId, observedAt);
      replayInput = { runId, markets: normalizeRows(raw(price), observedAt).markets, status: 'completed', finishedAt: observedAt,
        sourceSha256: 'a'.repeat(64), nextPollSeconds: 60, payload: {} };
      await persistRun(client, replayInput);
    }
    const records = (await client.query('select seen_count from football.market_observations order by first_seen_at')).rows;
    assert.deepEqual(records.map(row => row.seen_count), [1, 1, 2]);
    const feature = (await client.query('select sample_size, latest_odds, payload from football.market_feature_latest')).rows[0];
    assert.equal(feature.sample_size, 3); assert.equal(feature.latest_odds.odds1, 1.8); assert.equal(feature.payload.reversals.odds1, 1);
    assert.equal((await persistRun(client, replayInput)).replayed, true);
    checks.push('A-B-A path, unchanged receipt, real feature UPDATE and replay');
    const projected = await require('../collectors/market/signalBridge.cjs').readMarketSignalRows(client);
    assert.equal(projected[0].signal.bookmakerOdds.had.odds1, 1.8);
    assert.equal(projected[0].signal.updatedAt, new Date(at + 180000).toISOString());
    assert.deepEqual(projected[0].keys, ['2026-09-15:周二001', '991001']);
    checks.push('PostgreSQL enrichment bridge preserves source keys, price and receipt time');
    const oldRun = randomUUID(); await startRun(client, oldRun, new Date(at - 60000).toISOString());
    assert.equal((await persistRun(client, { ...replayInput, runId: oldRun, markets: normalizeRows(raw(1.6), new Date(at - 60000).toISOString()).markets })).ignored, 1);
    const failingRun = randomUUID(); await startRun(client, failingRun, new Date(at + 300000).toISOString());
    await assert.rejects(persistRun(client, { ...replayInput, runId: failingRun, markets: normalizeRows(raw(1.6), new Date(at + 300000).toISOString()).markets }, async () => { throw new Error('injected feature error'); }));
    assert.equal((await client.query('select count(*)::integer as n from football.market_observations')).rows[0].n, 3);
    assert.equal((await client.query('select status from football.market_collector_runs where run_id=$1', [failingRun])).rows[0].status, 'running');
    checks.push('out-of-order receipt ignored; transaction rollback preserves observations');
  } finally { client.release(); }
  let entered, finishRequest;
  const requested = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { finishRequest = resolve; });
  const first = collectOnce(pool, { now: () => at + 3600000, config: config({}), random: () => .5, parseRows: () => raw(), fetchPage: async () => { entered(); return response; } });
  await requested;
  assert.equal((await childProbe(at + 3600000)).skipped, 'another-worker');
  finishRequest({ body: Buffer.from('synthetic-only'), statusCode: 200 }); assert.equal((await first).ok, true);
  checks.push('separate process blocked by source lock before HTTP request');
  const blocked = await collectOnce(pool, { now: () => at + 7200000, config: config({}), fetchPage: async () => { throw Object.assign(failure('SOURCE_BLOCKED', 'synthetic 429'), { statusCode: 429, retryAfterSeconds: 86400 }); } });
  assert.equal(blocked.status, 'blocked');
  const cooled = await childProbe(at + 7260000); assert.equal(cooled.skipped, 'not-due'); assert.equal(cooled.nextPollSeconds, 86340);
  checks.push('Retry-After persisted and honored by a fresh process');
  const controller = new AbortController(); let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const stopping = collectOnce(pool, { now: () => at + 100000000, config: config({}), signal: controller.signal,
    fetchPage: async (_url, { signal }) => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(failure('COLLECTION_ABORTED', 'cancelled')), { once: true })); } });
  await fetching; controller.abort(); assert.equal((await stopping).code, 'COLLECTION_ABORTED');
  assert.equal((await childProbe(at + 100000001)).skipped, 'not-due');
  checks.push('abort cancels request, audits failure and releases advisory lock');
  const countBefore = (await pool.query('select count(*)::integer as n from football.market_observations')).rows[0].n;
  const empty = await collectOnce(pool, { now: () => at + 200000000, config: config({}), random: () => .5, parseRows: () => [],
    fetchPage: async () => ({ statusCode: 200, body: require('iconv-lite').encode('<p class="nodata-txt">暂无赛事信息</p>', 'gbk') }) });
  assert.equal(empty.ok, true); assert.equal(empty.sourceState, 'no-events'); assert.equal(empty.rows, 0); assert.equal(empty.nextPollSeconds, 900);
  assert.equal((await pool.query('select count(*)::integer as n from football.market_observations')).rows[0].n, countBefore);
  checks.push('explicit upstream no-events page is audited without erasing existing data');
  let lostPid, notifyFetch;
  const lossFetch = new Promise(resolve => { notifyFetch = resolve; });
  const wrapped = { connect: async () => { const connection = await pool.connect(); lostPid = (await connection.query('select pg_backend_pid() as pid')).rows[0].pid; return connection; } };
  const disconnected = collectOnce(wrapped, { now: () => at + 300000000, config: config({}), fetchPage: async (_url, { signal }) => {
    notifyFetch(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(failure('COLLECTION_ABORTED', 'database disconnected')), { once: true }));
  } });
  const rejected = assert.rejects(disconnected); await lossFetch;
  await pool.query('select pg_terminate_backend($1)', [lostPid]); await rejected;
  const next = await childProbe(at + 300000001); assert.notEqual(next.skipped, 'another-worker');
  checks.push('database connection loss aborts request and frees the process lock');
  console.log(JSON.stringify({ ok: true, database: db.name, role: db.role, checks }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => pool.end());
