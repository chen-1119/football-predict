'use strict';
// Authenticated cloud readers use the same immutable publication and ACK records.
// This module cannot publish, enqueue, migrate, collect, or modify an archive.
const { verifyRow } = require('../scripts/postgresPrivateModelArtifactStore.cjs');
const { SELECT } = require('../scripts/leagueBaselineRegistry.cjs');
const { hash } = require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const MAX = 8 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('INVALID_DATE');
  return value;
}
function publicationKey(value) {
  const match = /^reviewed-analysis-(\d{4}-\d{2}-\d{2})-(?:selected-two|batch-[a-f0-9]{64})$/.exec(value || '');
  if (!match) fail('INVALID_PUBLICATION_KEY');
  day(match[1]); return value;
}
async function boundedRow(client, key) {
  const meta = (await client.query('SELECT payload_bytes,octet_length(payload::text) AS actual_bytes FROM football.private_model_artifacts WHERE artifact_key=$1', [key])).rows;
  if (meta.length > 1) fail('ARCHIVE_IDENTITY_CONFLICT');
  if (!meta.length) return null;
  const bytes = Number(meta[0].payload_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX || Number(meta[0].actual_bytes) !== bytes) fail('ARCHIVE_BYTE_BOUND');
  const rows = (await client.query(SELECT, [key])).rows;
  if (rows.length !== 1) fail('ARCHIVE_IDENTITY_CONFLICT');
  return verifyRow(rows[0], key, MAX);
}
function createResearchArchiveRead({ pool, replay } = {}) {
  if (!pool?.connect || typeof replay !== 'function') throw new Error('Archive reader dependencies required');
  async function snapshot(action) {
    const client = await pool.connect(); let broken;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='8000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
      const row = (await client.query("SELECT clock_timestamp() AS now,current_setting('transaction_read_only') AS readonly")).rows[0];
      if (row?.readonly !== 'on') fail('READ_ONLY_REQUIRED');
      const observedAt = new Date(row.now).toISOString();
      const result = await action(client, observedAt);
      await client.query('COMMIT');
      return { version: 'research-archive-read-v1', storage: 'postgres', observedAt,
        productionWrites: 0, publishSupported: false, retryPublicationAutomatically: false, ...result };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (e) { broken = e; }
      throw error;
    } finally { client.release(broken); }
  }
  return {
    day(value) {
      const date = day(value);
      return snapshot(async client => {
        const rows = (await client.query(`SELECT artifact_key,payload_sha256,payload_bytes FROM football.private_model_artifacts
          WHERE artifact_version=$1 AND (artifact_key=$2 OR artifact_key LIKE $3) ORDER BY artifact_key LIMIT 33`,
        ['reviewed-analysis-freeze-v1', 'reviewed-analysis-' + date + '-selected-two', 'reviewed-analysis-' + date + '-batch-%'])).rows;
        if (rows.length > 32) fail('ARCHIVE_COUNT_BOUND');
        const publications = [];
        for (const row of rows) {
          const key = publicationKey(row.artifact_key);
          const ack = await boundedRow(client, key + '-ack');
          // Presence is not replay acceptance. Fetch the artifact endpoint to verify.
          publications.push({ key, payloadSha256: row.payload_sha256, payloadBytes: Number(row.payload_bytes),
            state: ack ? 'record-and-ack-present-unverified' : 'record-present-ack-missing',
            verified: false, ackSha256: ack?.payloadSha256 || null });
        }
        return { businessDate: date, publications, existingBatchCount: publications.length };
      });
    },
    artifact(value) {
      const key = publicationKey(value);
      return snapshot(async (client, observedAt) => {
        const record = await boundedRow(client, key);
        if (!record) return { key, state: 'record-not-found', verified: false };
        const saved = record.payload, draft = saved?.draft;
        const expectedKey = draft && 'reviewed-analysis-' + day(draft.businessDate)
          + (draft.version === 3 ? '-batch-' + hash(draft) : '-selected-two');
        if (saved?.version !== 'reviewed-analysis-freeze-v1' || expectedKey !== key
          || saved.record?.businessDate !== draft.businessDate) fail('ARCHIVE_IDENTITY_CONFLICT');
        const ack = await boundedRow(client, key + '-ack');
        if (!ack) return { key, state: 'record-present-ack-missing', verified: false, payloadSha256: record.payloadSha256 };
        await replay(client, key, observedAt);
        return { key, state: 'committed-and-acknowledged', verified: true,
          record: { json: record.payloadJson, sha256: record.payloadSha256, bytes: record.payloadBytes },
          ack: { json: ack.payloadJson, sha256: ack.payloadSha256, bytes: ack.payloadBytes } };
      });
    },
  };
}
function createResearchArchiveHandler({ reader, authenticate }) {
  let active = 0;
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/operator/research/')) return false;
    const send = (status, body) => {
      const raw = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie', 'Allow': 'GET' });
      res.end(raw); return true;
    };
    try {
      const auth = await authenticate(req);
      if (!auth) return send(401, { ok: false, error: 'AUTHENTICATION_REQUIRED' });
      if (!['operator', 'admin'].includes(auth.user?.role)) return send(403, { ok: false, error: 'OPERATOR_REQUIRED' });
      if (req.method !== 'GET') return send(405, { ok: false, error: 'READ_ONLY_ENDPOINT' });
      const param = url.pathname === '/api/operator/research/day' ? 'date'
        : url.pathname === '/api/operator/research/artifact' ? 'key' : null;
      if (!param) return send(404, { ok: false, error: 'NOT_FOUND' });
      if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll(param).length !== 1)
        return send(400, { ok: false, error: 'INVALID_QUERY' });
      if (!reader || active >= 2) return send(503, { ok: false, error: 'ARCHIVE_READ_UNAVAILABLE' });
      active++;
      try {
        const value = await reader[param === 'date' ? 'day' : 'artifact'](url.searchParams.get(param));
        if (Buffer.byteLength(JSON.stringify(value)) > 24 * 1024 * 1024) fail('ARCHIVE_RESPONSE_BOUND');
        return send(200, { ok: true, ...value });
      } finally { active--; }
    } catch (error) {
      return send(/^INVALID_/.test(error.code || '') ? 400 : 503,
        { ok: false, error: /^INVALID_/.test(error.code || '') ? error.code : 'ARCHIVE_READ_UNAVAILABLE', retryPublicationAutomatically: false });
    }
  };
}
module.exports = { createResearchArchiveRead, createResearchArchiveHandler, day, publicationKey };
