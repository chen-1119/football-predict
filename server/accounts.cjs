'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const scrypt = promisify(crypto.scrypt);
const uuid = () => crypto.randomUUID();
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const iso = value => value ? new Date(value).toISOString() : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
class AccountError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new AccountError(status, code); };
const normalizeUsername = value => {
  if (typeof value !== 'string') fail(400, 'invalid_username');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) fail(400, 'invalid_username');
  return username;
};
const validatePassword = value => {
  if (typeof value !== 'string' || value.length < 15 || value.length > 128) fail(400, 'invalid_password_length');
  return value;
};
let activeHashes = 0;
const hashQueue = [];
async function boundedHash(action) {
  if (activeHashes >= 2) {
    if (hashQueue.length >= 12) fail(429, 'authentication_busy');
    await new Promise(resolve => hashQueue.push(resolve));
  } else activeHashes++;
  try { return await action(); } finally {
    const next = hashQueue.shift();
    if (next) next(); else activeHashes--;
  }
}
async function hashPassword(password) {
  validatePassword(password);
  return boundedHash(async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    return `scrypt$v1$32768$8$3$${salt}$${key.toString('hex')}`;
  });
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const parts = String(encoded || '').split('$');
  if (parts.length !== 7 || parts.slice(0, 5).join('$') !== 'scrypt$v1$32768$8$3'
    || !/^[a-f0-9]{32}$/.test(parts[5]) || !/^[a-f0-9]{64}$/.test(parts[6])) return false;
  return boundedHash(async () => safeEqual((await scrypt(password, parts[5], 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 })).toString('hex'), parts[6]));
}
const DUMMY_HASH = 'scrypt$v1$32768$8$3$' + '0'.repeat(32) + '$' + '0'.repeat(64);
function cookies(req) {
  const result = {};
  for (const item of String(req.headers?.cookie || '').split(';')) {
    const equal = item.indexOf('='); if (equal < 0) continue;
    const name = item.slice(0, equal).trim();
    if (Object.hasOwn(result, name)) { result[name] = ''; continue; }
    result[name] = item.slice(equal + 1).trim();
  }
  return result;
}
function publicUser(row) {
  return { id: row.user_id || row.id, username: row.username, displayName: row.display_name, role: row.role, status: row.status };
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk); if (size > 8192) fail(413, 'request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json');
  return body;
}

/** Readers are read-only. readDecision returns {decision, result?}; readMatch
 * returns {match, result?}. A result must be explicitly marked verified:true by
 * the integration, after its existing official-result checks. No score guessing.
 * readLegacyCode returns {codeId,expiresAt} after checking the legacy code's
 * active status, without consuming it. PostgreSQL owns the one-time redemption.
 */
function createAccounts({ pool, readMatch, readDecision, readLegacyCode, options = {} }) {
  if (!pool?.connect || !pool?.query) throw new Error('Accounts require PostgreSQL');
  const origin = new URL(options.origin || '');
  if (origin.origin !== options.origin || !['https:', 'http:'].includes(origin.protocol)) throw new Error('An exact account origin is required');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const secure = options.secureCookies !== false;
  if (!secure && !(options.allowInsecureLoopback === true && loopback && origin.protocol === 'http:')) throw new Error('Insecure cookies are limited to explicit loopback development');
  if (secure && origin.protocol !== 'https:') throw new Error('Secure accounts require HTTPS');
  if (typeof options.csrfSecret !== 'string' || Buffer.byteLength(options.csrfSecret) < 32) throw new Error('A separate strong CSRF secret is required');
  const sessionName = secure ? '__Host-football_session' : 'football_session';
  const csrfName = secure ? '__Host-football_csrf' : 'football_csrf';
  const sessionDays = Math.max(1, Math.min(30, Number(options.sessionDays) || 7));
  const authMethods = { password: options.passwordEnabled !== false, sms: false };
  const mac = value => crypto.createHmac('sha256', options.csrfSecret).update(value).digest('base64url');
  const tokenOf = req => {
    const token = cookies(req)[sessionName] || '';
    return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : '';
  };
  const hasSessionCookie = req => Object.hasOwn(cookies(req), sessionName);
  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const send = (res, body, status = 200, setCookies = []) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    res.end(JSON.stringify(body));
  };
  async function transaction(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  const audit = (client, actor, target, action, detail = {}) => client.query(
    'INSERT INTO football.account_audit_events(actor_user_id,target_user_id,action,detail) VALUES($1,$2,$3,$4::jsonb)',
    [actor, target, action, JSON.stringify(detail)]);
  async function accessFor(client, user) {
    if (!user || user.status !== 'active') return { active: false, kind: null, expiresAt: null, trialAvailable: false };
    const rows = (await client.query(`SELECT kind,expires_at FROM football.account_access_grants
      WHERE user_id=$1 AND revoked_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()
      ORDER BY expires_at DESC,id LIMIT 1`, [user.user_id || user.id])).rows;
    return { active: Boolean(rows[0]), kind: rows[0]?.kind || null, expiresAt: iso(rows[0]?.expires_at), trialAvailable: !user.trial_claimed_at };
  }
  async function sessionRow(client, req, lock = false) {
    const token = tokenOf(req); if (!token) return null;
    return (await client.query(`SELECT u.*,u.id AS user_id,s.id AS session_id,s.created_at AS session_created_at,s.expires_at AS session_expires_at
      FROM football.account_sessions s JOIN football.account_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active'
      ${lock ? 'FOR UPDATE OF u,s' : ''}`, [digest(token)])).rows[0] || null;
  }
  async function authenticate(req) {
    const row = await sessionRow(pool, req);
    return row ? { user: publicUser(row), session: { id: row.session_id, createdAt: iso(row.session_created_at), expiresAt: iso(row.session_expires_at) }, access: await accessFor(pool, row) } : null;
  }
  async function authorize(req, { role, entitlement = false } = {}) {
    const auth = await authenticate(req);
    if (!auth || (role && ![].concat(role).includes(auth.user.role)) || (entitlement && !auth.access.active)) return null;
    return auth;
  }
  const anonymousCsrf = req => {
    const raw = cookies(req)[csrfName] || '', [nonce, signature] = raw.split('.');
    if (/^[a-zA-Z0-9_-]{43}$/.test(nonce || '') && safeEqual(signature, mac('anonymous:' + nonce))) return { token: nonce, setCookies: [] };
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, setCookies: [cookie(csrfName, `${token}.${mac('anonymous:' + token)}`, 3600)] };
  };
  function checkOrigin(req) {
    if (req.headers.origin !== origin.origin) fail(403, 'origin_rejected');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_rejected');
  }
  function checkCsrf(req, authenticated) {
    const expected = authenticated ? mac('session:' + tokenOf(req)) : anonymousCsrf(req).token;
    if (!safeEqual(req.headers['x-csrf-token'], expected)) fail(403, 'csrf_rejected');
  }
  async function withSession(req, action, { roles, adminLock = false } = {}) {
    return transaction(async client => {
      if (adminLock) await client.query("SELECT pg_advisory_xact_lock(hashtext('football:account-admin-change'))");
      const user = await sessionRow(client, req, true);
      if (!user) fail(401, 'authentication_required');
      checkCsrf(req, true);
      if (roles && !roles.includes(user.role)) fail(403, 'insufficient_role');
      return action(client, user);
    });
  }
  async function rate(req, action, username) {
    const ip = options.clientIp ? options.clientIp(req) : req.socket?.remoteAddress || 'unknown';
    const buckets = [[`${action}:ip:${mac(ip)}`, action === 'register' ? 12 : 60, 900]];
    if (username) buckets.push([`${action}:user:${mac(username)}`, 15, 900]);
    for (const [key, limit, seconds] of buckets) {
      const row = (await pool.query(`INSERT INTO football.account_auth_rate(bucket_key,attempts) VALUES($1,1)
        ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN account_auth_rate.started_at<=clock_timestamp()-$2::int*interval '1 second' THEN 1 ELSE account_auth_rate.attempts+1 END,
        started_at=CASE WHEN account_auth_rate.started_at<=clock_timestamp()-$2::int*interval '1 second' THEN clock_timestamp() ELSE account_auth_rate.started_at END RETURNING attempts`, [key, seconds])).rows[0];
      if (row.attempts > limit) fail(429, 'authentication_rate_limited');
    }
  }
  async function makeSession(client, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO football.account_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4::int*interval '1 day')`, [uuid(), userId, digest(token), sessionDays]);
    return token;
  }
  async function me(req, res, { newToken, extraCookies = [], recoveryCode } = {}) {
    const effectiveReq = newToken ? { ...req, headers: { ...req.headers, cookie: `${sessionName}=${newToken}` } } : req;
    const row = await sessionRow(pool, effectiveReq);
    const csrf = row ? { token: mac('session:' + tokenOf(effectiveReq)), setCookies: [] } : anonymousCsrf(req);
    send(res, { ok: true, user: row ? publicUser(row) : null, access: await accessFor(pool, row), authMethods, csrfToken: csrf.token,
      sessionExpiresAt: row ? iso(row.session_expires_at) : null, ...(recoveryCode ? { recoveryCode } : {}) }, 200,
      [...extraCookies, ...csrf.setCookies, ...(!row && hasSessionCookie(req) ? [cookie(sessionName, '', 0)] : []),
        ...(newToken ? [cookie(sessionName, newToken, sessionDays * 86400), cookie(csrfName, '', 0)] : [])]);
  }
  function verifiedResult(input) {
    if (!input || input.verified !== true || !['WON','LOST','PENDING','VOID','DISPUTED','FINISHED'].includes(input.state)) return null;
    return { state: input.state, score: typeof input.score === 'string' && /^\d+\s*[-:]\s*\d+$/.test(input.score) ? input.score : null,
      source: typeof input.source === 'string' ? input.source.slice(0, 120) : null,
      asOf: input.asOf && Number.isFinite(Date.parse(input.asOf)) ? iso(input.asOf) : null };
  }
  function identity(input) {
    const matchId = String(input.matchId || input.id || ''), sourceMatchId = String(input.sourceMatchId || '').replace(/^sporttery_/, '');
    const eventVersion = input.eventVersion || input.kickoffTime;
    if (!matchId || matchId.length > 160 || !sourceMatchId || sourceMatchId.length > 160 || !Number.isFinite(Date.parse(eventVersion))
      || !Number.isFinite(Date.parse(input.kickoffTime)) || !input.homeTeamName || !input.awayTeamName) fail(422, 'fixture_identity_unavailable');
    return { matchId, sourceMatchId, eventVersion: iso(eventVersion), homeTeamName: String(input.homeTeamName).slice(0, 200), awayTeamName: String(input.awayTeamName).slice(0, 200), kickoffTime: iso(input.kickoffTime) };
  }
  const snapshot = d => ({ decisionId: d.decisionId, recordHash: d.recordHash, market: d.market, handicapLine: d.handicapLine,
    tipCode: d.tipCode, odds: d.odds, publishedAt: d.publishedAt });
  async function followOutput(row) {
    let result = null;
    try {
      if (row.decision_id && readDecision) {
        const value = await readDecision(row.decision_id), d = value?.decision || value;
        if (validDecision(d) && d.recordHash === row.decision_record_hash && d.matchId === row.match_id
          && String(d.sourceMatchId) === row.source_match_id && iso(d.eventVersion) === iso(row.event_version)) result = verifiedResult(value?.result);
      } else if (readMatch) {
        const value = await readMatch(row.match_id), m = value?.match || value;
        if (m && String(m.sourceMatchId) === row.source_match_id && iso(m.eventVersion || m.kickoffTime) === iso(row.event_version)) {
          const trusted = verifiedResult(value?.result);
          if (trusted && ['FINISHED','VOID','DISPUTED','PENDING'].includes(trusted.state)) result = trusted;
        }
      }
    } catch { /* Retain the personal record when upstream result lookup is unavailable. */ }
    return { id: row.id, matchId: row.match_id, sourceMatchId: row.source_match_id, eventVersion: iso(row.event_version),
      homeTeamName: row.home_team_name, awayTeamName: row.away_team_name, kickoffTime: iso(row.kickoff_at), createdAt: iso(row.created_at), decision: row.decision_snapshot, result };
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname !== '/api/account' && !pathname.startsWith('/api/account/')) return false;
    try {
      const method = req.method || 'GET', writing = !['GET','HEAD','OPTIONS'].includes(method);
      if (writing) checkOrigin(req);
      if (pathname === '/api/account/me' && method === 'GET') { await me(req, res); return true; }
      if (['/api/account/register','/api/account/login'].includes(pathname) && method === 'POST') {
        if (!authMethods.password) fail(503, 'password_authentication_disabled');
        const authenticated = await sessionRow(pool, req); checkCsrf(req, Boolean(authenticated));
        const body = await readBody(req), username = normalizeUsername(body.username);
        const registering = pathname.endsWith('/register');
        await rate(req, registering ? 'register' : 'login', username);
        let newToken, recoveryCode;
        if (registering) {
          validatePassword(body.password);
          const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : username;
          if (!displayName || displayName.length > 40) fail(400, 'invalid_display_name');
          const passwordHash = await hashPassword(body.password);
          recoveryCode = crypto.randomBytes(32).toString('base64url');
          newToken = await transaction(async client => {
            const userId = uuid();
            await client.query('INSERT INTO football.account_users(id,username,display_name,password_hash,recovery_hash) VALUES($1,$2,$3,$4,$5)', [userId, username, displayName, passwordHash, digest(recoveryCode)]);
            await audit(client, userId, userId, 'account.registered');
            return makeSession(client, userId);
          });
        } else {
          const candidate = (await pool.query('SELECT id,password_hash,status FROM football.account_users WHERE username=$1', [username])).rows[0];
          const correct = await verifyPassword(body.password, candidate?.password_hash || DUMMY_HASH);
          if (!correct || candidate?.status !== 'active') fail(401, 'invalid_credentials');
          newToken = await transaction(async client => {
            const user = (await client.query("SELECT * FROM football.account_users WHERE id=$1 AND status='active' FOR UPDATE", [candidate.id])).rows[0];
            if (!user || user.password_hash !== candidate.password_hash) fail(401, 'invalid_credentials');
            await audit(client, user.id, user.id, 'account.logged_in');
            return makeSession(client, user.id);
          });
        }
        await me(req, res, { newToken, recoveryCode }); return true;
      }
      if (pathname === '/api/account/recover' && method === 'POST') {
        if (!authMethods.password) fail(503, 'password_authentication_disabled');
        const authenticated = await sessionRow(pool, req); checkCsrf(req, Boolean(authenticated));
        const body = await readBody(req), username = normalizeUsername(body.username);
        await rate(req, 'recover', username);
        const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
        if (!/^[a-zA-Z0-9_-]{43}$/.test(recoveryCode)) fail(401, 'invalid_recovery_credentials');
        const candidate = (await pool.query('SELECT id,recovery_hash,status FROM football.account_users WHERE username=$1', [username])).rows[0];
        if (!safeEqual(candidate?.recovery_hash || '0'.repeat(64), digest(recoveryCode)) || candidate?.status !== 'active') fail(401, 'invalid_recovery_credentials');
        const passwordHash = await hashPassword(body.newPassword), nextCode = crypto.randomBytes(32).toString('base64url');
        await transaction(async client => {
          const user = (await client.query("SELECT * FROM football.account_users WHERE id=$1 AND status='active' FOR UPDATE", [candidate.id])).rows[0];
          if (!user || !safeEqual(user.recovery_hash, digest(recoveryCode))) fail(401, 'invalid_recovery_credentials');
          await client.query('UPDATE football.account_users SET password_hash=$2,recovery_hash=$3,updated_at=clock_timestamp() WHERE id=$1', [user.id, passwordHash, digest(nextCode)]);
          await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
          await audit(client, user.id, user.id, 'account.recovered');
        });
        send(res, { ok: true, recoveryCode: nextCode }, 200, [cookie(sessionName, '', 0), cookie(csrfName, '', 0)]); return true;
      }
      if (pathname === '/api/account/logout' && method === 'POST') {
        await withSession(req, async (client, user) => {
          await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [user.session_id]);
          await audit(client, user.user_id, user.user_id, 'session.logged_out', { sessionId: user.session_id });
        });
        send(res, { ok: true }, 200, [cookie(sessionName, '', 0), cookie(csrfName, '', 0)]); return true;
      }
      if (pathname === '/api/account/sessions' && method === 'GET') {
        const user = await sessionRow(pool, req); if (!user) fail(401, 'authentication_required');
        const rows = (await pool.query(`SELECT id,created_at,expires_at FROM football.account_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 100`, [user.user_id])).rows;
        send(res, { ok: true, rows: rows.map(s => ({ id: s.id, createdAt: iso(s.created_at), expiresAt: iso(s.expires_at), current: s.id === user.session_id })) }); return true;
      }
      const sessionDelete = pathname.match(/^\/api\/account\/sessions\/([0-9a-f-]+)$/i);
      if ((pathname === '/api/account/sessions/revoke-others' && method === 'POST') || (sessionDelete && method === 'DELETE')) {
        const target = sessionDelete?.[1]; if (target && !UUID.test(target)) fail(404, 'session_not_found');
        const value = await withSession(req, async (client, user) => {
          const result = target ? await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [target, user.user_id])
            : await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL RETURNING id', [user.user_id, user.session_id]);
          if (target && !result.rowCount) fail(404, 'session_not_found');
          await audit(client, user.user_id, user.user_id, target ? 'session.revoked' : 'session.others_revoked', { count: result.rowCount });
          return { revoked: result.rowCount, self: target === user.session_id };
        });
        send(res, { ok: true, revoked: value.revoked }, 200, value.self ? [cookie(sessionName, '', 0)] : []); return true;
      }
      if (pathname === '/api/account/trial' && method === 'POST') {
        await withSession(req, async (client, user) => {
          if (user.trial_claimed_at) fail(409, 'trial_already_claimed');
          await client.query(`INSERT INTO football.account_access_grants(id,user_id,kind,source_key,expires_at) VALUES($1,$2,'trial',$3,clock_timestamp()+interval '3 days')`, [uuid(), user.user_id, user.user_id]);
          await client.query('UPDATE football.account_users SET trial_claimed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1', [user.user_id]);
          await audit(client, user.user_id, user.user_id, 'trial.claimed');
        });
        await me(req, res); return true;
      }
      if (pathname === '/api/account/redeem' && method === 'POST') {
        const body = await readBody(req);
        if (typeof body.code !== 'string' || body.code.length > 64) fail(400, 'invalid_access_code');
        await rate(req, 'redeem');
        await withSession(req, async (client, user) => {
          if (!readLegacyCode) fail(503, 'legacy_redemption_unavailable');
          const legacy = await readLegacyCode(body.code);
          if (!legacy?.codeId || !Number.isFinite(Date.parse(legacy.expiresAt))) fail(401, 'invalid_access_code');
          const grantId = uuid();
          const grant = await client.query(`INSERT INTO football.account_access_grants(id,user_id,kind,source_key,expires_at)
            SELECT $1,$2,'legacy-code',$3,$4::timestamptz WHERE $4::timestamptz>clock_timestamp()
            ON CONFLICT(kind,source_key) DO NOTHING RETURNING id`, [grantId, user.user_id, String(legacy.codeId), legacy.expiresAt]);
          if (!grant.rowCount) fail(409, 'access_code_unavailable');
          await client.query('INSERT INTO football.account_legacy_redemptions(code_id,user_id,grant_id) VALUES($1,$2,$3)', [String(legacy.codeId), user.user_id, grantId]);
          await audit(client, user.user_id, user.user_id, 'legacy_code.redeemed', { codeId: String(legacy.codeId) });
        });
        await me(req, res); return true;
      }
      if (pathname === '/api/account/follows' && method === 'GET') {
        const user = await sessionRow(pool, req); if (!user) fail(401, 'authentication_required');
        const rows = (await pool.query('SELECT * FROM football.account_follows WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 201', [user.user_id])).rows;
        const output = []; for (const row of rows.slice(0, 200)) output.push(await followOutput(row));
        send(res, { ok: true, rows: output, hasMore: rows.length > 200 }); return true;
      }
      if (pathname === '/api/account/follows' && method === 'POST') {
        const body = await readBody(req);
        if (typeof body.matchId !== 'string' || !body.matchId || body.matchId.length > 160) fail(400, 'invalid_match_id');
        const row = await withSession(req, async (client, user) => {
          let event, decision = null;
          if (body.decisionId != null) {
            if (typeof body.decisionId !== 'string' || body.decisionId.length > 160) fail(400, 'invalid_decision_id');
            const value = readDecision && await readDecision(body.decisionId), d = value?.decision || value;
            if (!d || !validDecision(d)) fail(404, 'decision_not_found');
            if (d.matchId !== body.matchId || d.decisionId !== body.decisionId) fail(409, 'decision_match_mismatch');
            event = identity(d); decision = snapshot(d);
          } else {
            const value = readMatch && await readMatch(body.matchId), m = value?.match || value;
            if (!m) fail(404, 'match_not_found'); event = identity(m);
            if (event.matchId !== body.matchId) fail(409, 'match_identity_mismatch');
          }
          const existing = (await client.query('SELECT * FROM football.account_follows WHERE user_id=$1 AND source_match_id=$2 AND event_version=$3', [user.user_id, event.sourceMatchId, event.eventVersion])).rows[0];
          if (existing) return existing;
          const count = (await client.query('SELECT count(*)::int n FROM football.account_follows WHERE user_id=$1', [user.user_id])).rows[0].n;
          if (count >= 200) fail(409, 'follow_limit_reached');
          const inserted = await client.query(`INSERT INTO football.account_follows(id,user_id,match_id,source_match_id,event_version,home_team_name,away_team_name,kickoff_at,decision_id,decision_record_hash,decision_snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(user_id,source_match_id,event_version) DO NOTHING RETURNING *`,
          [uuid(), user.user_id, event.matchId, event.sourceMatchId, event.eventVersion, event.homeTeamName, event.awayTeamName, event.kickoffTime, decision?.decisionId || null, decision?.recordHash || null, decision ? JSON.stringify(decision) : null]);
          if (inserted.rows[0]) { await audit(client, user.user_id, user.user_id, 'follow.created', { followId: inserted.rows[0].id, decisionId: decision?.decisionId || null }); return inserted.rows[0]; }
          return (await client.query('SELECT * FROM football.account_follows WHERE user_id=$1 AND source_match_id=$2 AND event_version=$3', [user.user_id, event.sourceMatchId, event.eventVersion])).rows[0];
        });
        send(res, { ok: true, row: await followOutput(row) }); return true;
      }
      const followDelete = pathname.match(/^\/api\/account\/follows\/([0-9a-f-]+)$/i);
      if (followDelete && method === 'DELETE') {
        if (!UUID.test(followDelete[1])) fail(404, 'follow_not_found');
        await withSession(req, async (client, user) => {
          const result = await client.query('DELETE FROM football.account_follows WHERE id=$1 AND user_id=$2 RETURNING id', [followDelete[1], user.user_id]);
          if (!result.rowCount) fail(404, 'follow_not_found');
          await audit(client, user.user_id, user.user_id, 'follow.removed', { followId: followDelete[1] });
        });
        send(res, { ok: true }); return true;
      }
      if (pathname === '/api/account/admin/users' && method === 'GET') {
        const user = await sessionRow(pool, req); if (!user) fail(401, 'authentication_required');
        if (!['admin','operator'].includes(user.role)) fail(403, 'insufficient_role');
        const rows = (await pool.query('SELECT id,username,display_name,role,status,created_at FROM football.account_users ORDER BY created_at DESC LIMIT 100')).rows;
        send(res, { ok: true, rows: rows.map(row => ({ ...publicUser(row), createdAt: iso(row.created_at) })) }); return true;
      }
      const adminMutation = pathname.match(/^\/api\/account\/admin\/users\/([0-9a-f-]+)\/(grant|status|role)$/i);
      if (adminMutation && method === 'POST') {
        if (!UUID.test(adminMutation[1])) fail(404, 'user_not_found');
        const body = await readBody(req), operation = adminMutation[2], targetId = adminMutation[1];
        await rate(req, 'admin-reauth', digest(tokenOf(req)));
        await withSession(req, async (client, actor) => {
          if (!await verifyPassword(body.currentPassword, actor.password_hash)) fail(403, 'reauthentication_required');
          const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
          if (!reason || reason.length > 200) fail(400, 'reason_required');
          const target = (await client.query('SELECT * FROM football.account_users WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
          if (!target) fail(404, 'user_not_found');
          if (actor.role === 'operator' && target.role !== 'user') fail(403, 'insufficient_role');
          if (operation === 'grant') {
            if (!Number.isSafeInteger(body.days) || body.days < 1 || body.days > 365) fail(400, 'invalid_grant_days');
            const grantId = uuid();
            await client.query(`INSERT INTO football.account_access_grants(id,user_id,kind,source_key,expires_at) VALUES($1,$2,'manual',$4,clock_timestamp()+$3::int*interval '1 day')`, [grantId, targetId, body.days, grantId]);
            await audit(client, actor.user_id, targetId, 'access.granted', { days: body.days, reason });
          } else {
            if (targetId === actor.user_id) fail(409, 'cannot_change_own_admin_state');
            const value = operation === 'role' ? body.role : body.status;
            if (!(operation === 'role' ? ['user','operator','admin'] : ['active','blocked']).includes(value)) fail(400, 'invalid_user_state');
            await client.query(`UPDATE football.account_users SET ${operation}=$2,updated_at=clock_timestamp() WHERE id=$1`, [targetId, value]);
            await client.query('UPDATE football.account_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [targetId]);
            await audit(client, actor.user_id, targetId, `account.${operation}_changed`, { previous: target[operation], value, reason });
          }
        }, { roles: operation === 'grant' ? ['operator','admin'] : ['admin'], adminLock: true });
        send(res, { ok: true }); return true;
      }
      fail(404, 'account_endpoint_not_found');
    } catch (error) {
      if (error instanceof AccountError) send(res, { ok: false, error: error.code }, error.status);
      else if (error.code === '23505') send(res, { ok: false, error: 'account_conflict' }, 409);
      else {
        options.onError?.({ code: String(error.code || 'ACCOUNT_SERVICE_ERROR') });
        send(res, { ok: false, error: 'account_service_unavailable' }, 503);
      }
    }
    return true;
  }
  return { handle, authenticate, authorize, hasSessionCookie, authMethods, cookieNames: { session: sessionName, csrf: csrfName } };
}
module.exports = { createAccounts, AccountError, normalizeUsername, validatePassword, hashPassword, verifyPassword };
