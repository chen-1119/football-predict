'use strict';
// Explicit disposable local database only. No .env loading and no production defaults.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAccounts } = require('../server/accounts.cjs');
const { bootstrap } = require('./bootstrapAccountAdmin.cjs');
const { makeDecision } = require('./recommendationPlatform/decision.cjs');
const { match, NOW, publication } = require('../tests/recommendationFixture.cjs');

async function verify(pool) {
  const schema = `accounts_verify_${process.pid}_${Date.now()}`;
  assert(/^accounts_verify_\d+_\d+$/.test(schema));
  const replace = sql => sql.replaceAll('football.', `${schema}.`);
  const q = (sql, args) => pool.query(replace(sql), args);
  const mappedPool = { query: q, async connect() { const c = await pool.connect(); return { query: (sql, args) => c.query(replace(sql), args), release: () => c.release() }; } };
  const options = { origin: 'http://127.0.0.1:49999', csrfSecret: 'native-postgres-accounts-test-only-0000000000000', secureCookies: false, allowInsecureLoopback: true };
  const fixtures = new Map([701, 702, 703].map(id => [String(id), match(id)]));
  const decisions = new Map([...fixtures.values()].map(m => { const d = makeDecision(m, { now: NOW, publication: publication(NOW) }).decision; assert(d); return [d.decisionId, d]; }));
  let official = false, readCodes = 0;
  const errors = [];
  const service = createAccounts({ pool: mappedPool, options: { ...options, onError: error => errors.push(error.code) },
    readMatch: async id => { const m = fixtures.get(id.replace(/^sporttery_/, '')); return m ? { match: m, result: official ? { verified: true, state: 'FINISHED', score: '2-0', source: 'test-official', asOf: new Date().toISOString() } : null } : null; },
    readDecision: async id => { const decision = decisions.get(id); return decision ? { decision, result: official ? { verified: true, state: 'WON', score: '2-0', source: 'test-official', asOf: new Date().toISOString() } : null } : null; },
    readLegacyCode: async code => { readCodes++; return code === 'VALID-LEGACY-CODE' ? { codeId: 'legacy-fixture-1', expiresAt: new Date(Date.now() + 3600000).toISOString() } : code === 'EXPIRED-CODE' ? { codeId: 'legacy-expired', expiresAt: new Date(Date.now() - 1000).toISOString() } : null; }
  });
  let checks = 0, browserCounter = 0;
  const check = fn => { fn(); checks++; };
  function browser() {
    const jar = new Map(), address = '127.0.0.' + (++browserCounter); let csrf = '';
    const client = {
      get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
      get csrf() { return csrf; },
      async call(method, route, body = {}, override = {}) {
        const req = Readable.from([JSON.stringify(body)]); req.method = method;
        req.headers = { origin: options.origin, cookie: client.cookie, 'x-csrf-token': csrf, ...override }; req.socket = { remoteAddress: address };
        const response = { headers: {} };
        const res = { statusCode: 200, setHeader(k, v) { response.headers[k.toLowerCase()] = v; }, end(value) { response.status = this.statusCode; response.body = JSON.parse(value); } };
        assert.equal(await service.handle(req, res, new URL('/api/account' + route, options.origin)), true);
        for (const value of response.headers['set-cookie'] || []) { const pair = value.split(';')[0], split = pair.indexOf('='); if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(pair.slice(0, split)); else jar.set(pair.slice(0, split), pair.slice(split + 1)); }
        if (response.body.csrfToken) csrf = response.body.csrfToken;
        return response;
      }
    };
    return client;
  }
  const password = 'test accounts password 2026';
  async function register(name) {
    const b = browser(); await b.call('GET', '/me');
    const response = await b.call('POST', '/register', { username: name, password, displayName: name, role: 'admin', userId: 'attacker-supplied' });
    assert.equal(response.status, 200, JSON.stringify({ error: response.body.error, databaseErrors: errors }));
    return { b, user: response.body.user, recoveryCode: response.body.recoveryCode };
  }
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(fs.readFileSync(path.join(__dirname, '../server/postgres/migrations/012_accounts_and_follows.sql'), 'utf8'));
    const alice = await register('alice_test'), bob = await register('bob_test');
    check(() => assert.equal(alice.user.role, 'user')); check(() => assert.notEqual(alice.user.id, bob.user.id));
    check(() => assert.match(alice.recoveryCode, /^[a-zA-Z0-9_-]{43}$/));
    const me = await alice.b.call('GET', '/me');
    check(() => assert.equal(me.body.access.active, false)); check(() => assert.equal(me.body.access.trialAvailable, true));
    check(() => assert.equal(awaitlessHasNoSecret(me.body), true));
    const wrongOrigin = await alice.b.call('POST', '/trial', {}, { origin: 'https://attacker.example' }); check(() => assert.equal(wrongOrigin.status, 403));
    const wrongCsrf = await alice.b.call('POST', '/trial', {}, { 'x-csrf-token': 'wrong' }); check(() => assert.equal(wrongCsrf.status, 403));
    const follow = await alice.b.call('POST', '/follows', { matchId: 'sporttery_701', userId: bob.user.id });
    check(() => assert.equal(follow.status, 200)); check(() => assert.equal(follow.body.row.decision, null));
    check(() => assert.equal((follow.body.row.result), null));
    const bobEmpty = await bob.b.call('GET', '/follows'); check(() => assert.equal(bobEmpty.body.rows.length, 0));
    const foreignDelete = await bob.b.call('DELETE', '/follows/' + follow.body.row.id); check(() => assert.equal(foreignDelete.status, 404));
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => alice.b.call('POST', '/follows', { matchId: 'sporttery_701' })));
    check(() => assert(duplicates.every(r => r.status === 200 && r.body.row.id === follow.body.row.id)));
    const followCount = await q('SELECT count(*)::int n FROM football.account_follows WHERE user_id=$1', [alice.user.id]); check(() => assert.equal(followCount.rows[0].n, 1));
    const unknown = await alice.b.call('POST', '/follows', { matchId: 'invented' }); check(() => assert.equal(unknown.status, 404));
    const d = [...decisions.values()].find(d => d.matchId === 'sporttery_702'); assert(d);
    const mismatch = await alice.b.call('POST', '/follows', { matchId: 'sporttery_701', decisionId: d.decisionId }); check(() => assert.equal(mismatch.status, 409));
    const saved = await alice.b.call('POST', '/follows', { matchId: d.matchId, decisionId: d.decisionId }); check(() => assert.equal(saved.status, 200));
    check(() => assert.equal(saved.body.row.decision.recordHash, d.recordHash));
    official = true;
    fixtures.set('702', { ...fixtures.get('702'), homeTeamName: 'REPLACED CURRENT NAME', eventVersion: new Date().toISOString() });
    const after = await alice.b.call('GET', '/follows'), kept = after.body.rows.find(row => row.id === saved.body.row.id);
    check(() => assert.equal(kept.homeTeamName, d.homeTeamName)); check(() => assert.equal(kept.result.state, 'WON'));
    check(() => assert.equal(after.body.rows.find(row => row.id === follow.body.row.id).result.state, 'FINISHED'));
    // Capacity is enforced under the user lock; a duplicate never overwrites
    // the first selected decision or consumes another slot.
    const capacityRows = Array.from({ length: 198 }, (_, n) => ({ id: require('node:crypto').randomUUID(), source: `capacity_${n}` }));
    await q(`INSERT INTO football.account_follows(id,user_id,match_id,source_match_id,event_version,home_team_name,away_team_name,kickoff_at)
      SELECT x.id::uuid,$1,x.source,x.source,$3::timestamptz,'Fixture Home','Fixture Away',$3::timestamptz
      FROM jsonb_to_recordset($2::jsonb) AS x(id text,source text)`, [alice.user.id, JSON.stringify(capacityRows), d.eventVersion]);
    const atCapacity = await alice.b.call('POST', '/follows', { matchId: 'sporttery_703' });
    check(() => assert.equal(atCapacity.status, 409)); check(() => assert.equal(atCapacity.body.error, 'follow_limit_reached'));
    const duplicateAtCapacity = await alice.b.call('POST', '/follows', { matchId: d.matchId, decisionId: d.decisionId });
    check(() => assert.equal(duplicateAtCapacity.status, 200)); check(() => assert.equal(duplicateAtCapacity.body.row.id, saved.body.row.id));
    await q("DELETE FROM football.account_follows WHERE user_id=$1 AND source_match_id LIKE 'capacity_%'", [alice.user.id]);
    const trials = await Promise.all([alice.b.call('POST', '/trial', { days: 999 }), alice.b.call('POST', '/trial')]);
    check(() => assert.deepEqual(trials.map(r => r.status).sort(), [200, 409]));
    const trialRows = (await q("SELECT extract(epoch FROM expires_at-starts_at)::int seconds FROM football.account_access_grants WHERE user_id=$1 AND kind='trial'", [alice.user.id])).rows;
    check(() => assert.equal(trialRows.length, 1)); check(() => assert(Math.abs(trialRows[0].seconds - 259200) <= 1));
    await q("UPDATE football.account_access_grants SET starts_at=clock_timestamp()-interval '4 days',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [alice.user.id]);
    const expired = await alice.b.call('GET', '/me'); check(() => assert.equal(expired.body.access.active, false));
    const repeatTrial = await alice.b.call('POST', '/trial'); check(() => assert.equal(repeatTrial.status, 409));
    const redeem = await Promise.all([alice.b.call('POST', '/redeem', { code: 'VALID-LEGACY-CODE' }), bob.b.call('POST', '/redeem', { code: 'VALID-LEGACY-CODE' })]);
    check(() => assert.deepEqual(redeem.map(r => r.status).sort(), [200, 409]));
    check(() => assert.equal((redeem.find(r => r.status === 200)).body.access.kind, 'legacy-code'));
    const expiredCode = await alice.b.call('POST', '/redeem', { code: 'EXPIRED-CODE' }); check(() => assert.equal(expiredCode.status, 409));
    const redemptionCount = await q('SELECT count(*)::int n FROM football.account_legacy_redemptions'); check(() => assert.equal(redemptionCount.rows[0].n, 1)); check(() => assert.equal(readCodes, 3));
    const second = browser(); await second.call('GET', '/me'); const logged = await second.call('POST', '/login', { username: 'ALICE_TEST', password }); check(() => assert.equal(logged.status, 200));
    const sessionRows = await alice.b.call('GET', '/sessions'); check(() => assert.equal(sessionRows.body.rows.length, 2));
    const bobSessions = await bob.b.call('GET', '/sessions'); const foreignSession = await alice.b.call('DELETE', '/sessions/' + bobSessions.body.rows[0].id); check(() => assert.equal(foreignSession.status, 404));
    const revoke = await alice.b.call('POST', '/sessions/revoke-others'); check(() => assert.equal(revoke.body.revoked, 1));
    const revokedSecond = await second.call('GET', '/follows'); check(() => assert.equal(revokedSecond.status, 401));
    const recovery = browser(); await recovery.call('GET', '/me');
    const recoveries = await Promise.all([recovery.call('POST', '/recover', { username: 'alice_test', recoveryCode: alice.recoveryCode, newPassword: 'a changed test password 2026' }), recovery.call('POST', '/recover', { username: 'alice_test', recoveryCode: alice.recoveryCode, newPassword: 'a changed test password 2026' })]);
    check(() => assert.deepEqual(recoveries.map(r => r.status).sort(), [200, 401]));
    check(() => assert.match(recoveries.find(r => r.status === 200).body.recoveryCode, /^[a-zA-Z0-9_-]{43}$/));
    const recoveredSession = await alice.b.call('GET', '/follows'); check(() => assert.equal(recoveredSession.status, 401));
    await recovery.call('GET', '/me');
    const replay = await recovery.call('POST', '/recover', { username: 'alice_test', recoveryCode: alice.recoveryCode, newPassword: password }); check(() => assert.equal(replay.status, 401));
    const oldPassword = await recovery.call('POST', '/login', { username: 'alice_test', password }); check(() => assert.equal(oldPassword.status, 401));
    const fresh = await recovery.call('POST', '/login', { username: 'alice_test', password: 'a changed test password 2026' }); check(() => assert.equal(fresh.status, 200));
    const stillClaimed = await recovery.call('POST', '/trial'); check(() => assert.equal(stillClaimed.status, 409));
    const admin = await register('admin_test'), operator = await register('operator_test');
    // The real bootstrap requires a named existing user and refuses a second administrator.
    const bootstrapped = await bootstrap(mappedPool, { username: admin.user.username, confirmFirstAdmin: true });
    check(() => assert.equal(bootstrapped.role, 'admin'));
    await assert.rejects(bootstrap(mappedPool, { username: bob.user.username, confirmFirstAdmin: true }), /administrator already exists/); checks++;
    const bootstrapSession = await admin.b.call('GET', '/me'); check(() => assert.equal(bootstrapSession.body.user, null));
    await admin.b.call('POST', '/login', { username: admin.user.username, password });
    const makeOperator = await admin.b.call('POST', `/admin/users/${operator.user.id}/role`, { role: 'operator', currentPassword: password, reason: 'test operator role' });
    check(() => assert.equal(makeOperator.status, 200));
    await operator.b.call('GET', '/me'); await operator.b.call('POST', '/login', { username: operator.user.username, password });
    const deniedRole = await operator.b.call('POST', `/admin/users/${bob.user.id}/role`, { role: 'admin', currentPassword: password, reason: 'test' }); check(() => assert.equal(deniedRole.status, 403));
    const deniedPassword = await admin.b.call('POST', `/admin/users/${bob.user.id}/status`, { status: 'blocked', currentPassword: 'wrong', reason: 'test' }); check(() => assert.equal(deniedPassword.status, 403));
    const grant = await operator.b.call('POST', `/admin/users/${bob.user.id}/grant`, { days: 2, currentPassword: password, reason: 'test grant' }); check(() => assert.equal(grant.status, 200));
    const blocked = await admin.b.call('POST', `/admin/users/${bob.user.id}/status`, { status: 'blocked', currentPassword: password, reason: 'test block' }); check(() => assert.equal(blocked.status, 200));
    const blockedMe = await bob.b.call('GET', '/me'), blockedFollows = await bob.b.call('GET', '/follows');
    check(() => assert.equal(blockedMe.body.user, null)); check(() => assert.equal(blockedFollows.status, 401));
    const deniedLogin = await bob.b.call('POST', '/login', { username: 'bob_test', password }); check(() => assert.equal(deniedLogin.status, 401));
    const ownSessions = await recovery.call('GET', '/sessions'); const currentId = ownSessions.body.rows.find(row => row.current).id;
    await q("UPDATE football.account_sessions SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [currentId]);
    const expiredSession = await recovery.call('GET', '/follows'); check(() => assert.equal(expiredSession.status, 401));
    const logout = await operator.b.call('POST', '/logout'); check(() => assert.equal(logout.status, 200));
    const loggedOut = await operator.b.call('GET', '/sessions'); check(() => assert.equal(loggedOut.status, 401));
    const auditRows = (await q('SELECT action,detail FROM football.account_audit_events')).rows;
    check(() => assert(auditRows.some(row => row.action === 'account.status_changed')));
    check(() => assert(!JSON.stringify(auditRows).includes(password) && !JSON.stringify(auditRows).includes(alice.recoveryCode)));
    await assert.rejects(q('UPDATE football.account_audit_events SET action=action'), { code: '23000' }); checks++;
    const secrets = (await q('SELECT password_hash,recovery_hash FROM football.account_users WHERE id=$1', [alice.user.id])).rows[0];
    check(() => assert.notEqual(secrets.recovery_hash, alice.recoveryCode)); check(() => assert.match(secrets.recovery_hash, /^[a-f0-9]{64}$/));
    check(() => assert.equal(errors.length, 0));
    return { ok: true, checks, engine: 'native-postgresql', isolatedSchema: true };
  } finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
}
function awaitlessHasNoSecret(value) { return !('recoveryCode' in value) && !JSON.stringify(value).includes('password_hash'); }
if (require.main === module) {
  const value = process.env.ACCOUNTS_TEST_DATABASE_URL;
  if (!value) throw new Error('Explicit ACCOUNTS_TEST_DATABASE_URL is required; production defaults are never used');
  const parsed = new URL(value);
  if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !['/accounts_test','/recommendation_test'].includes(parsed.pathname)) throw new Error('Use a local disposable accounts_test or recommendation_test database only');
  const { Pool } = require('pg'), pool = new Pool({ connectionString: value, ssl: false, max: 8 });
  verify(pool).then(report => console.log(JSON.stringify(report))).catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || null, error: error.message })); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { verify };
