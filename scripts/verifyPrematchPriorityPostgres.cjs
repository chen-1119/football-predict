'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { requestRefresh, readPriorities, completePriorities } = require('../server/prematchRefresh.cjs');
async function verify(pool) {
  const schema = `prematch_verify_${process.pid}_${Date.now()}`;
  const replace = sql => sql.replaceAll('football.', schema + '.');
  const mapped = { query: (sql, args) => pool.query(replace(sql), args), async connect() { const c = await pool.connect(); return { query: (sql, args) => c.query(replace(sql), args), release: () => c.release() }; } };
  const now = Date.parse('2026-09-22T06:00:00Z');
  const match = { id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-22',homeTeamName:'home',awayTeamName:'away',status:'SCHEDULED',kickoffTime:'2026-09-22T10:00:00Z' };
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await mapped.query(fs.readFileSync(path.join(__dirname, '../collectors/leisu-prematch/api-daily-schema.sql'), 'utf8'));
    const results = await Promise.all(Array.from({ length: 8 }, () => requestRefresh(mapped, match, now)));
    assert.equal(results.filter(x => x.state === 'queued').length, 1);
    assert.equal(results.filter(x => x.state === 'cooldown').length, 7);
    const pending = await readPriorities(mapped, now); assert.equal(pending.length, 1);
    const transaction = await mapped.connect();
    try { await transaction.query('BEGIN'); await completePriorities(transaction, pending, new Set([match.id]), now + 60000); await transaction.query('ROLLBACK'); }
    finally { transaction.release(); }
    assert.equal((await readPriorities(mapped, now)).length, 1, 'receipt transaction rollback preserves priority request');
    await completePriorities(mapped, pending, new Set(), now + 60000); assert.equal((await readPriorities(mapped, now)).length, 1);
    await completePriorities(mapped, pending, new Set([match.id]), now + 60000); assert.equal((await readPriorities(mapped, now)).length, 0);
    assert.equal((await requestRefresh(mapped, match, now + 120000)).state, 'cooldown');
    assert.equal((await requestRefresh(mapped, match, now + 30 * 60000)).state, 'queued');
    await completePriorities(mapped, pending, new Set([match.id]), now + 31 * 60000);
    assert.equal((await readPriorities(mapped, now + 31 * 60000)).length, 1, 'older worker must not consume newer request');
    assert.equal((await requestRefresh(mapped, { ...match, kickoffTime: '2026-09-22T11:00:00Z' }, now + 32 * 60000)).state, 'queued');
    assert.equal((await readPriorities(mapped, now + 6 * 3600000)).length, 0, 'past cutoff never dispatched');
    assert.equal((await requestRefresh(mapped, { ...match, businessDate: '2026-09-23' }, now)).statusCode, 409);
    await completePriorities(mapped, [], new Set(), now + 3 * 86400000);
    assert.equal(Number((await mapped.query('SELECT count(*) n FROM football.prematch_refresh_requests')).rows[0].n), 0);
    return { ok: true, engine: 'native-postgresql', checks: 13, isolatedSchema: true };
  } finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
}
if (require.main === module) {
  const value = process.env.PREMATCH_TEST_DATABASE_URL;
  if (!value) throw Error('Explicit local disposable PREMATCH_TEST_DATABASE_URL is required');
  const u = new URL(value);
  if (!['localhost','127.0.0.1','[::1]'].includes(u.hostname) || u.pathname !== '/recommendation_test') throw Error('Only local disposable recommendation_test database allowed');
  const pool = new (require('pg').Pool)({ connectionString: value, ssl: false, max: 8 });
  verify(pool).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(JSON.stringify({ ok:false,code:e.code,error:e.message })); process.exitCode=1; }).finally(() => pool.end());
}
module.exports = { verify };
