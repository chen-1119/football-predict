'use strict';
// Internal storage primitive only. No HTTP route or production broker is wired.
// runExclusive must be supplied by the reviewed release-lock broker; a callback
// used in isolated database tests is NOT proof of production mutual exclusion.
const { createHash } = require('node:crypto');
const MAX_BYTES = 512 * 1024;
const VERSION = 'cloud-research-report-v1';
const KINDS = Object.freeze(['morning-1100-review-and-early', 'weekday-2000-selected-two',
  'weekday-2100-full', 'weekend-2100-selected-two', 'weekend-2200-full']);
const SELECT = `SELECT artifact_key,artifact_version,generated_at,updated_at,
  payload::text AS payload_json,payload_sha256,payload_bytes
  FROM football.private_model_artifacts WHERE artifact_key=$1`;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function iso(value) {
  const v = value instanceof Date ? value.toISOString() : value;
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('REPORT_CLOCK');
  return v;
}
function reportKey(date, kind) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) fail('REPORT_DATE');
  if (!KINDS.includes(kind)) fail('REPORT_KIND');
  return `research-report-${date}-${kind}`;
}
function prepare(raw, expectedSha256) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX_BYTES) fail('REPORT_BYTE_BOUND');
  // Take an owned copy before any await, then preserve these bytes unchanged.
  const bytes = Buffer.from(raw), json = bytes.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(bytes)) fail('REPORT_UTF8');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || sha(bytes) !== expectedSha256) fail('REPORT_HASH');
  let report; try { report = JSON.parse(json); } catch { fail('REPORT_JSON'); }
  if (!object(report) || report.version !== VERSION || !object(report.contents)
    || Object.keys(report).sort().join(',') !== 'businessDate,contents,generatedAt,reportKind,version') fail('REPORT_SCHEMA');
  const key = reportKey(report.businessDate, report.reportKind), generatedAt = iso(report.generatedAt);
  return Object.freeze({ key, json, sha256: expectedSha256, bytes: bytes.length, generatedAt });
}
function verifyStored(row, key) {
  if (!row || row.artifact_key !== key || row.artifact_version !== VERSION
    || typeof row.payload_json !== 'string') fail('REPORT_STORED_IDENTITY');
  const parsed = prepare(Buffer.from(row.payload_json, 'utf8'), row.payload_sha256);
  if (parsed.key !== key || Number(row.payload_bytes) !== parsed.bytes
    || iso(row.generated_at) !== parsed.generatedAt) fail('REPORT_STORED_IDENTITY');
  const receivedAt = iso(row.updated_at);
  if (Date.parse(receivedAt) < Date.parse(parsed.generatedAt)) fail('REPORT_STORED_CLOCK');
  return { ...parsed, receivedAt };
}
async function readStored(client, key) {
  const rows = (await client.query(`SELECT payload_bytes,octet_length(payload::text) AS actual_bytes
    FROM football.private_model_artifacts WHERE artifact_key=$1`, [key])).rows;
  if (!rows.length) return null;
  if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0].payload_bytes))
    || Number(rows[0].payload_bytes) < 2 || Number(rows[0].payload_bytes) > MAX_BYTES
    || Number(rows[0].actual_bytes) !== Number(rows[0].payload_bytes)) fail('REPORT_STORED_BOUND');
  const full = (await client.query(SELECT, [key])).rows;
  if (full.length !== 1) fail('REPORT_STORED_IDENTITY');
  return verifyStored(full[0], key);
}
function receipt(row, extra = {}) {
  return { state: 'report-archived', key: row.key, sha256: row.sha256, bytes: row.bytes,
    generatedAt: row.generatedAt, receivedAt: row.receivedAt, originalJson: row.json,
    verificationScope: 'archive-byte-integrity-only', published: false,
    recommendationEligibilityVerified: false, retryWriteAutomatically: false, ...extra };
}
function createResearchReportStore({ pool, runExclusive } = {}) {
  if (!pool?.connect) fail('REPORT_POOL_REQUIRED');
  async function read(date, kind, expectedSha256) {
    const key = reportKey(date, kind);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) fail('REPORT_HASH');
    const client = await pool.connect(); let broken;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const row = await readStored(client, key);
      await client.query('COMMIT');
      if (!row) return { state: 'not-observed', key, retryWriteAutomatically: false };
      if (row.sha256 !== expectedSha256) fail('REPORT_IMMUTABLE_CONFLICT');
      return receipt(row, { readbackVerified: true });
    } catch (e) { try { await client.query('ROLLBACK'); } catch (rollback) { broken = rollback; } throw e; }
    finally { client.release(broken); }
  }
  async function archive(raw, expectedSha256) {
    const input = prepare(raw, expectedSha256);
    if (typeof runExclusive !== 'function') fail('REPORT_RELEASE_BROKER_UNAVAILABLE');
    return runExclusive(async () => {
      const client = await pool.connect(); let committing = false, broken, inserted;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SET LOCAL statement_timeout='10000ms'");
        await client.query("SET LOCAL lock_timeout='2000ms'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['football-postgres-projection-sync-v1']);
        const now = iso((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now);
        if (Date.parse(input.generatedAt) > Date.parse(now)) fail('REPORT_FUTURE_CLOCK');
        const prior = await readStored(client, input.key);
        if (prior && (prior.sha256 !== input.sha256 || prior.json !== input.json)) fail('REPORT_IMMUTABLE_CONFLICT');
        inserted = !prior;
        if (!prior) {
          // No UPSERT, replacement, migration, or update of existing evidence.
          await client.query(`INSERT INTO football.private_model_artifacts
            (artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
            VALUES ($1,$2,$3,$4,$5::json,$6,$7)`,
          [input.key, VERSION, input.generatedAt, now, input.json, input.sha256, input.bytes]);
          const stored = await readStored(client, input.key);
          if (!stored || stored.json !== input.json || stored.sha256 !== input.sha256) fail('REPORT_ROUNDTRIP');
        }
        committing = true;
        await client.query('COMMIT');
      } catch (error) {
        if (committing) {
          // Discard uncertain connection. Never issue a second mutation.
          broken = error;
          throw Object.assign(new Error('REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY'), {
            code: 'REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY', key: input.key, sha256: input.sha256,
            retryWriteAutomatically: false });
        }
        try { await client.query('ROLLBACK'); } catch (rollback) { broken = rollback; }
        throw error;
      } finally { client.release(broken); }
      // This read remains inside the broker's release lock, on a new connection.
      try {
        const result = await read(JSON.parse(input.json).businessDate, JSON.parse(input.json).reportKind, input.sha256);
        if (result.state !== 'report-archived') fail('REPORT_READBACK_MISSING');
        return { ...result, inserted, commitAcknowledged: true };
      } catch {
        throw Object.assign(new Error('REPORT_COMMITTED_READBACK_UNVERIFIED'), {
          code: 'REPORT_COMMITTED_READBACK_UNVERIFIED', key: input.key, sha256: input.sha256,
          commitAcknowledged: true, retryWriteAutomatically: false });
      }
    });
  }
  return { archive, read };
}
module.exports = { MAX_BYTES, VERSION, KINDS, reportKey, prepare, verifyStored, createResearchReportStore };
