'use strict';
const test = require('node:test');
const a = require('node:assert/strict');
const { createHash } = require('node:crypto');
const store = require('../server/researchReportStore.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const report = changes => Buffer.from(JSON.stringify({ version: store.VERSION, businessDate: '2026-10-14',
  reportKind: 'morning-1100-review-and-early', generatedAt: '2026-10-14T02:30:00.000Z',
  contents: { text: '真实原文：未核实的资料不补造。', sources: [] }, ...changes }, null, 2) + '\n');
function memoryPool({ loseCommit = false } = {}) {
  // Unit fault-injection only; the PostgreSQL verifier separately tests SQL.
  const rows = new Map(), calls = [], releases = [];
  return { rows, calls, releases, async connect() {
    let staged;
    return { release: e => releases.push(e), async query(sql, args = []) {
      calls.push(sql);
      if (sql.startsWith('BEGIN')) { staged = new Map(rows); return { rows: [] }; }
      if (sql === 'ROLLBACK') { staged = null; return { rows: [] }; }
      if (sql === 'COMMIT') {
        for (const [key, value] of staged) rows.set(key, value);
        staged = null;
        if (loseCommit) { loseCommit = false; throw Error('Connection lost after server commit'); }
        return { rows: [] };
      }
      if (sql.includes('clock_timestamp')) return { rows: [{ now: '2026-10-14T03:00:00.000Z' }] };
      if (sql.startsWith('SET ') || sql.includes('pg_advisory')) return { rows: [] };
      if (sql.startsWith('INSERT')) {
        a.ok(!sql.includes('ON CONFLICT'));
        const [key, version, generated, updated, json, hash, bytes] = args;
        a.equal(staged.has(key), false);
        staged.set(key, { artifact_key: key, artifact_version: version, generated_at: generated,
          updated_at: updated, payload_json: json, payload_sha256: hash, payload_bytes: bytes });
        return { rows: [] };
      }
      const row = staged?.get(args[0]);
      if (sql.includes('octet_length')) return { rows: row ? [{ payload_bytes: row.payload_bytes, actual_bytes: Buffer.byteLength(row.payload_json) }] : [] };
      if (sql.includes('payload::text AS payload_json')) return { rows: row ? [row] : [] };
      throw Error('Unexpected SQL');
    } };
  } };
}
const exclusive = async action => action(); // Not a production release lock.
test('original UTF-8 whitespace and hash preserved, one key per business date/slot', () => {
  const raw = report(), input = store.prepare(raw, sha(raw));
  a.equal(input.json, raw.toString()); a.equal(input.bytes, raw.length);
  a.equal(input.key, 'research-report-2026-10-14-morning-1100-review-and-early');
  raw.fill(0); a.ok(input.json.includes('真实原文'));
});
for (const [label, raw, code] of [
  ['oversize', Buffer.alloc(store.MAX_BYTES + 1), 'REPORT_BYTE_BOUND'],
  ['invalid utf8', Buffer.from([123, 255, 125]), 'REPORT_UTF8'],
  ['malformed json', Buffer.from('{bad}'), 'REPORT_JSON'],
  ['non-object', Buffer.from('[]'), 'REPORT_SCHEMA'],
  ['invalid date', report({ businessDate: '2026-02-30' }), 'REPORT_DATE'],
  ['arbitrary key', report({ reportKind: '../../x' }), 'REPORT_KIND'],
  ['unknown fields', report({ executable: 'anything' }), 'REPORT_SCHEMA'],
  ['noncanonical clock', report({ generatedAt: 'yesterday' }), 'REPORT_CLOCK'],
]) test(label + ' rejected', () => a.throws(() => store.prepare(raw, sha(raw)), { code }));
test('wrong expected hash rejected', () => a.throws(() => store.prepare(report(), '0'.repeat(64)), { code: 'REPORT_HASH' }));
test('write unavailable without broker, no database checkout', async () => {
  let connected = false;
  const s = store.createResearchReportStore({ pool: { connect() { connected = true; } } });
  const raw = report(); await a.rejects(s.archive(raw, sha(raw)), { code: 'REPORT_RELEASE_BROKER_UNAVAILABLE' });
  a.equal(connected, false);
});
test('create once, exact retry reads original receive clock, changed bytes conflict', async () => {
  const pool = memoryPool(), s = store.createResearchReportStore({ pool, runExclusive: exclusive });
  const raw = report(), first = await s.archive(raw, sha(raw));
  a.equal(first.inserted, true); a.equal(first.readbackVerified, true); a.equal(first.published, false);
  const second = await s.archive(raw, sha(raw));
  a.equal(second.inserted, false); a.equal(second.receivedAt, first.receivedAt);
  const changed = report({ contents: { text: 'different' } });
  await a.rejects(s.archive(changed, sha(changed)), { code: 'REPORT_IMMUTABLE_CONFLICT' });
  a.equal(pool.calls.filter(sql => sql.startsWith('INSERT')).length, 1);
  a.equal((await s.read('2026-10-14', 'morning-1100-review-and-early', sha(raw))).originalJson, raw.toString());
});
test('lost COMMIT reply reports unknown; readback resolves without another INSERT', async () => {
  const pool = memoryPool({ loseCommit: true }), s = store.createResearchReportStore({ pool, runExclusive: exclusive });
  const raw = report();
  await a.rejects(s.archive(raw, sha(raw)), { code: 'REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY', retryWriteAutomatically: false });
  a.ok(pool.releases[0] instanceof Error);
  a.equal((await s.read('2026-10-14', 'morning-1100-review-and-early', sha(raw))).state, 'report-archived');
  a.equal(pool.calls.filter(sql => sql.startsWith('INSERT')).length, 1);
});
test('future source clock and corrupt stored bytes rejected', async () => {
  const pool = memoryPool(), s = store.createResearchReportStore({ pool, runExclusive: exclusive });
  const future = report({ generatedAt: '2026-10-15T03:00:00.000Z' });
  await a.rejects(s.archive(future, sha(future)), { code: 'REPORT_FUTURE_CLOCK' });
  const raw = report(), result = await s.archive(raw, sha(raw));
  pool.rows.get(result.key).payload_sha256 = '0'.repeat(64);
  await a.rejects(s.read('2026-10-14', 'morning-1100-review-and-early', sha(raw)), { code: 'REPORT_HASH' });
});
test('readback still holds broker scope; missing reads do not authorize writes', async () => {
  let held = false;
  const pool = memoryPool(), originalConnect = pool.connect;
  pool.connect = async () => { a.equal(held, true); return originalConnect(); };
  const s = store.createResearchReportStore({ pool, runExclusive: async action => {
    held = true; try { return await action(); } finally { held = false; }
  } });
  const raw = report(); await s.archive(raw, sha(raw)); a.equal(held, false);
  const reader = store.createResearchReportStore({ pool: memoryPool() });
  a.deepEqual(await reader.read('2026-10-14', 'weekday-2100-full', sha(raw)), {
    state: 'not-observed', key: 'research-report-2026-10-14-weekday-2100-full', retryWriteAutomatically: false });
});
