'use strict';
// Synthetic records only, unique disposable schema; no production lock claim.
const a = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { VERSION, createResearchReportStore } = require('../server/researchReportStore.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
async function verify(pool) {
  const schema = `research_report_verify_${process.pid}_${Date.now()}`;
  const sql = s => s.replaceAll('football.', `${schema}.`);
  const q = (s, args) => pool.query(sql(s), args);
  let dropCommit = false;
  const mapped = { async connect() {
    const c = await pool.connect();
    return { release: e => c.release(e), async query(s, args) {
      const result = await c.query(sql(s), args);
      if (s === 'COMMIT' && dropCommit) { dropCommit = false; throw Error('Injected lost commit reply'); }
      return result;
    } };
  } };
  const raw = (kind, text = '双源未核实') => Buffer.from(JSON.stringify({ version: VERSION,
    businessDate: '2026-10-14', reportKind: kind, generatedAt: '2026-01-01T00:00:00.000Z', contents: { text } }, null, 2) + '\n');
  const s = createResearchReportStore({ pool: mapped, runExclusive: action => action() });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,
      generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)`);
    const one = raw('morning-1100-review-and-early');
    const first = await s.archive(one, sha(one));
    a.equal(first.originalJson, one.toString()); a.equal(first.bytes, one.length);
    a.equal(first.published, false); a.equal(first.readbackVerified, true);
    const repeat = await s.archive(one, sha(one));
    a.equal(repeat.inserted, false); a.equal(repeat.receivedAt, first.receivedAt);
    const conflict = raw('morning-1100-review-and-early', 'changed');
    await a.rejects(s.archive(conflict, sha(conflict)), { code: 'REPORT_IMMUTABLE_CONFLICT' });
    // Same-slot contenders may be refused by SERIALIZABLE; none is retried here.
    const pair = [raw('weekday-2100-full', 'first'), raw('weekday-2100-full', 'second')];
    const race = await Promise.allSettled(pair.map(b => s.archive(b, sha(b))));
    a.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    const loser = race.find(r => r.status === 'rejected').reason;
    a.ok(['40001', '23505', 'REPORT_IMMUTABLE_CONFLICT'].includes(loser.code));
    const winner = race.findIndex(r => r.status === 'fulfilled');
    a.equal((await s.read('2026-10-14', 'weekday-2100-full', sha(pair[winner]))).originalJson, pair[winner].toString());
    const unknown = raw('weekday-2000-selected-two'); dropCommit = true;
    await a.rejects(s.archive(unknown, sha(unknown)), { code: 'REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY' });
    a.equal((await s.read('2026-10-14', 'weekday-2000-selected-two', sha(unknown))).state, 'report-archived');
    a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n), 3);
    await q('UPDATE football.private_model_artifacts SET payload_bytes=1 WHERE artifact_key=$1', [first.key]);
    await a.rejects(s.read('2026-10-14', 'morning-1100-review-and-early', sha(one)), { code: 'REPORT_STORED_BOUND' });
    return { ok: true, scope: 'disposable-test-schema', exactUtf8Bytes: true, immutableConflict: true,
      concurrentSingleCompletion: true, unknownCommitReadback: true, productionRowsWritten: 0,
      productionReleaseLockVerified: false, cloudHandoverVerified: false };
  } finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
}
if (require.main === module) {
  const value = process.env.RESEARCH_REPORT_TEST_DATABASE_URL;
  if (!value) throw Error('Explicit disposable test database required');
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    || u.pathname !== '/recommendation_test') throw Error('Local recommendation_test only');
  const pool = new (require('pg').Pool)({ connectionString: value, ssl: false, max: 4 });
  verify(pool).then(result => console.log(JSON.stringify(result))).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { verify };
