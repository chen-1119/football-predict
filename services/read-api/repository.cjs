'use strict';
const crypto = require('node:crypto');
const { publicationIdentityFromMeta } = require('../../server/postgresProjectionStore.cjs');
const { publicFixture } = require('../../server/publicProduct.cjs');
const authority = require('../../server/recommendationAuthority.cjs');

const META_KEYS = ['data_publication_mode', 'data_generation_id', 'manifest_hash', 'data_generation_source_cycle_id', 'committed_at'];
const PUBLIC_FIELDS = ['id', 'sourceMatchId', 'matchNo', 'businessDate', 'homeTeamId', 'awayTeamId',
  'homeTeamName', 'homeTeamNameEn', 'awayTeamName', 'awayTeamNameEn', 'homeTeamLogo', 'awayTeamLogo',
  'homeTeamLogoType', 'awayTeamLogoType', 'leagueName', 'leagueNameEn', 'leagueId', 'status',
  'effectiveStatus', 'kickoffTime', 'buyEndTime', 'odds', 'oddsUpdatedAt'];
const DTO_SQL = `jsonb_build_object(${PUBLIC_FIELDS.map(key => `'${key}', payload->'${key}'`).join(',')})`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function date(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) fail('INVALID_DATE');
  return value;
}
function cursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_CURSOR');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('INVALID_CURSOR'); }
  if (!parsed || !/^g-[a-f0-9]{64}$/.test(parsed.generation) || typeof parsed.id !== 'string' || parsed.id.length > 160 || !parsed.id || (parsed.date !== null && typeof parsed.date !== 'string')) fail('INVALID_CURSOR');
  date(parsed.date);
  return parsed;
}
function limit(value) {
  if (value == null) return 100;
  if (!/^\d{1,3}$/.test(String(value)) || Number(value) < 1 || Number(value) > 100) fail('INVALID_LIMIT');
  return Number(value);
}
function validateIdentity(meta, now) {
  const identity = publicationIdentityFromMeta(Object.fromEntries(meta.map(r => [r.key, { value: r.value }])), { strictGenerationSource: true });
  if (identity.mode !== 'active-generation' || !/^[a-f0-9]{64}$/.test(identity.manifestHash || '')
    || identity.generationId !== 'g-' + identity.manifestHash || typeof identity.sourceCycleId !== 'string'
    || !identity.sourceCycleId || identity.sourceCycleId.length > 256
    || !Number.isFinite(Date.parse(identity.committedAt)) || Date.parse(identity.committedAt) > now) fail('COMMITTED_PUBLICATION_UNAVAILABLE');
  return identity;
}
function createRepository({ pool, now = Date.now, readAuthority = authority.readPublicationAuthority } = {}) {
  if (!pool?.connect) throw new Error('Read API requires PostgreSQL');
  // This service owns no raw pointer, generation files, migrations or write port.
  // Metadata and every DTO are read in one committed PostgreSQL snapshot.
  async function snapshot(action) {
    const client = await pool.connect();
    let broken;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('statement_timeout','5000',true),set_config('idle_in_transaction_session_timeout','15000',true)");
      const meta = await client.query('SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])', [META_KEYS]);
      const publication = validateIdentity(meta.rows, now());
      const result = await action(client, publication);
      await client.query('COMMIT');
      return { ...result, publication, observedAt: new Date(now()).toISOString(), storage: 'postgres', version: 'separated-read-api-v1' };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
      throw error;
    } finally { client.release(broken); }
  }
  return {
    async fixtures(query = {}) {
      const businessDate = date(query.date), pageSize = limit(query.limit), after = cursor(query.cursor);
      if (after && after.date !== businessDate) fail('INVALID_CURSOR');
      return snapshot(async (client, publication) => {
        if (after && after.generation !== publication.generationId) fail('CURSOR_GENERATION_CHANGED');
        const rows = (await client.query(`SELECT id, ${DTO_SQL} AS fixture FROM football.match_snapshots
          WHERE dataset='current' AND ($1::text IS NULL OR payload->>'businessDate'=$1)
            AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`, [businessDate, after?.id || null, pageSize + 1])).rows;
        if (rows.length > pageSize + 1) fail('QUERY_ROW_BOUND');
        const more = rows.length > pageSize, selected = rows.slice(0, pageSize);
        const matches = selected.map(row => publicFixture(row.fixture, now()));
        if (matches.some(row => !row)) fail('FIXTURE_DTO_INVALID');
        return { ok: true, matches, businessDate, stale: now() - Date.parse(publication.committedAt) > 15 * 60_000,
          nextCursor: more ? Buffer.from(JSON.stringify({ generation: publication.generationId, date: businessDate, id: selected.at(-1).id })).toString('base64url') : null };
      });
    },
    async match(id) {
      if (!/^(?:sporttery|fivehundred)_\d{1,20}$/.test(id)) fail('INVALID_MATCH_ID');
      return snapshot(async client => {
        const rows = (await client.query(`SELECT ${DTO_SQL} AS fixture FROM football.match_snapshots
          WHERE match_id=$1 AND dataset IN ('current','history')
          ORDER BY CASE dataset WHEN 'current' THEN 0 ELSE 1 END, kickoff_time DESC LIMIT 1`, [id])).rows;
        // Links retain the stored provider ID. A matching numeric suffix is
        // not an alias grant and must never substitute another event row.
        if (rows.length > 1 || (rows[0] && rows[0].fixture?.id !== id)) fail('FIXTURE_IDENTITY_MISMATCH');
        return { ok: true, match: rows[0] ? publicFixture(rows[0].fixture, now()) : null };
      });
    },
    async recommendations() {
      return snapshot(async client => {
        // Reuse the installed freeze + second-transaction ACK/signature replay.
        // A stored center alone cannot become a trusted recommendation.
        const verified = await readAuthority(client, { policy: authority.TRAINED_ONLY_POLICY, asOf: new Date(now()).toISOString() });
        const payload = authority.getAuthorityCenterPayload(verified);
        if (!payload) fail('RECOMMENDATION_AUTHORITY_UNAVAILABLE');
        let center = payload.recommendationCenter;
        if (!center.reviewedAnalysis?.records?.length) {
          const history = await require('../../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs').readLatestHistory(client, center.businessDate, new Date(now()).toISOString());
          if (history) center = { ...center, reviewedAnalysisHistory: history.comboArchive ? history : await require('../recommendation/comboArchive.cjs').restore(client, history, new Date(now()).toISOString()) };
        }
        return { ok: true, recommendationCenter: center };
      });
    },
    async health() { return snapshot(async client => {
      const result = await client.query("SELECT oid::text AS oid,current_setting('transaction_read_only') AS read_only FROM pg_database WHERE datname=current_database()");
      if (result.rows.length !== 1 || !/^[1-9][0-9]*$/.test(result.rows[0].oid || '') || result.rows[0].read_only !== 'on') fail('READ_ONLY_DATABASE_UNPROVEN');
      return { ok: true, ready: true, role: 'read-api', writesEnabled: false,
        database: { oid: result.rows[0].oid, transactionReadOnly: true } };
    }); },
  };
}
const etag = value => '"' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') + '"';
module.exports = { createRepository, validateIdentity, date, cursor, limit, etag, PUBLIC_FIELDS };
