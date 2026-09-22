'use strict';
const { normalizeUsername } = require('../server/accounts.cjs');

async function bootstrap(pool, { username, confirmFirstAdmin } = {}) {
  if (confirmFirstAdmin !== true) throw new Error('Explicit --confirm-first-admin is required');
  const normalized = normalizeUsername(username), client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('football:account-admin-change'))");
    const existing = await client.query("SELECT id FROM football.account_users WHERE role='admin' LIMIT 1");
    if (existing.rows.length) throw new Error('An administrator already exists; use the audited admin interface');
    const user = (await client.query("SELECT id,username FROM football.account_users WHERE username=$1 AND status='active' FOR UPDATE", [normalized])).rows[0];
    if (!user) throw new Error('The explicitly named active account must already be registered');
    await client.query("UPDATE football.account_users SET role='admin',updated_at=clock_timestamp() WHERE id=$1", [user.id]);
    await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
    await client.query("INSERT INTO football.account_audit_events(actor_user_id,target_user_id,action,detail) VALUES(NULL,$1,'admin.bootstrapped',$2::jsonb)", [user.id, JSON.stringify({ method: 'explicit-first-admin-cli', username: user.username })]);
    await client.query('COMMIT');
    return { ok: true, username: user.username, role: 'admin', sessionsRevoked: true };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
function parseArgs(args) {
  if (args.length !== 3 || args[0] !== '--username' || args[2] !== '--confirm-first-admin') throw new Error('Usage: node scripts/bootstrapAccountAdmin.cjs --username <registered-account> --confirm-first-admin');
  return { username: normalizeUsername(args[1]), confirmFirstAdmin: true };
}
if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const { createPostgresPool } = require('../server/postgresStore.cjs');
  const pool = createPostgresPool({ applicationName: 'football-first-admin-bootstrap', max: 1 });
  bootstrap(pool, options).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { bootstrap, parseArgs };
