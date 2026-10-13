'use strict';
const archive = require('../recommendation/comboArchive.cjs');
const authority = require('../../server/recommendationAuthority.cjs');
async function run({ pool }) {
  const client = await pool.connect(); let committing = false, result;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL statement_timeout=10000'); await client.query('SET LOCAL lock_timeout=2000');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('football-postgres-projection-sync-v1'))");
    const rows = await client.query('SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])', [['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at']]);
    const publication = require('../read-api/repository.cjs').validateIdentity(rows.rows, Date.now());
    const trusted = await authority.readPublicationAuthority(client, { policy: authority.TRAINED_ONLY_POLICY, asOf: new Date().toISOString() });
    const center = authority.getAuthorityCenterPayload(trusted)?.recommendationCenter;
    if (!center) throw new Error('ARCHIVE_AUTHORITY_UNAVAILABLE');
    const view = center.reviewedAnalysis, observedAt = new Date().toISOString();
    if (!view?.records?.length || ![...(view.combos || []), ...(view.threeCombos || [])].some(c => c.legs.length)) result = { retained: false, reason: 'no-current-published-combo' };
    else result = await archive.retain(client, view, publication, observedAt);
    committing = true; await client.query('COMMIT'); return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (committing) throw Object.assign(new Error('ARCHIVE_COMMIT_UNKNOWN_READ_FIRST'), { code: 'ARCHIVE_COMMIT_UNKNOWN_READ_FIRST' }); throw error;
  } finally { client.release(); }
}
if (require.main === module) {
  const { createPostgresPool } = require('../../server/postgresStore.cjs'), pool = createPostgresPool({ max: 1, applicationName: 'football-combo-view-archive' });
  run({ pool }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.code || error.message); process.exitCode = error.code === 'ARCHIVE_COMMIT_UNKNOWN_READ_FIRST' ? 75 : 1; }).finally(() => pool.end());
}
module.exports = { run };
