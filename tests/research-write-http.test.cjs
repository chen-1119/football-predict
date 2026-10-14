'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { createAccounts } = require('../server/accounts.cjs');
const { createResearchWriteHandler } = require('../server/researchWriteHttp.cjs');
const { readResearchRequestBody } = require('../server/researchRequestBody.cjs');
const options = { origin: 'https://football.example', csrfSecret: 'synthetic-csrf-secret-not-a-production-key-12345' };
const token = 't'.repeat(43), id = '11111111-1111-4111-8111-111111111111';
const csrf = crypto.createHmac('sha256', options.csrfSecret).update('session:' + token).digest('base64url');
const body = { version: 'research-broker-request-v1', action: 'archive-read', businessDate: '2026-10-14', reportKind: 'weekday-2100-full', sha256: 'a'.repeat(64) };
const url = new URL('/api/operator/research/report-read', options.origin);
function fixture({ role = 'operator', missing = false, submit, timeout = 8000 } = {}) {
  let queries = 0, authChecks = 0, submissions = 0, revoked = false;
  const accounts = createAccounts({ pool: { async connect() { throw Error('unexpected account mutation transaction'); }, async query(sql) {
    queries++;
    if (sql.includes('account_access_grants')) return { rows: [] };
    assert.match(sql, /s\.revoked_at IS NULL/); assert.match(sql, /u\.status='active'/);
    return { rows: missing || revoked ? [] : [{ id, user_id: id, username: 'test', role, status: 'active', session_id: id,
      session_created_at: '2026-10-14T00:00:00Z', session_expires_at: '2026-10-15T00:00:00Z' }] };
  } }, options });
  const handler = createResearchWriteHandler({ accounts: { async authorizeMutation(...args) {
    authChecks++; return accounts.authorizeMutation(...args);
  } }, bodyTimeoutMs: timeout, submit: submit === null ? undefined : async raw => {
    submissions++; return submit ? submit(raw) : { state: 'not-observed', verified: false, retryWriteAutomatically: false };
  } });
  const req = (extra = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {
    origin: options.origin, cookie: '__Host-football_session=' + token, 'x-csrf-token': csrf, 'content-type': 'application/json', ...extra,
  } });
  const res = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw) { this.body = JSON.parse(raw); } });
  return { handler, req, res, counts: () => ({ queries, authChecks, submissions }), revoke: () => { revoked = true; } };
}
for (const [name,headers,status,code] of [
  ['cross origin', { origin: 'https://attacker.example' }, 403, 'origin_rejected'],
  ['cross site', { 'sec-fetch-site': 'cross-site' }, 403, 'origin_rejected'],
  ['wrong CSRF', { 'x-csrf-token': 'wrong' }, 403, 'csrf_rejected'],
  ['wrong browser session', { cookie: '__Host-football_session=' + 'x'.repeat(43) }, 403, 'csrf_rejected'],
  ['plain MIME', { 'content-type': 'text/plain' }, 415, 'JSON_UTF8_REQUIRED'],
  ['compressed body', { 'content-encoding': 'gzip' }, 415, 'JSON_UTF8_REQUIRED'],
  ['oversize length', { 'content-length': String(1024 * 1024 + 1) }, 413, 'RESEARCH_REQUEST_BOUND'],
]) test(name + ' never enters the root broker', async () => {
  const f = fixture(), response = f.res(); await f.handler(f.req(headers), response, url);
  assert.equal(response.status, status); assert.equal(response.body.error, code); assert.equal(f.counts().submissions, 0);
});
for (const [role,missing,status] of [['user',false,403],['operator',true,401]]) test('missing or ordinary account refuses mutation: ' + role, async () => {
  const f = fixture({ role, missing }), response = f.res(); await f.handler(f.req(), response, url);
  assert.equal(response.status, status); assert.equal(f.counts().submissions, 0);
});
test('valid mutation checks the actual account session and CSRF twice, preserving request bytes', async () => {
  const expected = Buffer.from(JSON.stringify(body));
  const f = fixture({ submit: raw => { assert.deepEqual(raw, expected); return { state: 'not-observed', verified: false, retryWriteAutomatically: false }; } }), response = f.res();
  await f.handler(f.req(), response, url);
  assert.equal(response.status, 200); assert.equal(response.body.verified, false); assert.equal(response.body.retryWriteAutomatically, false);
  assert.deepEqual(f.counts(), { queries: 4, authChecks: 2, submissions: 1 }); assert.equal(response.headers['Cache-Control'], 'private, no-store');
});
test('route and body action cannot be changed to a different broker operation', async () => {
  const f = fixture(), response = f.res(); await f.handler(f.req(), response, new URL('/api/operator/research/publish', options.origin));
  assert.equal(response.status, 400); assert.equal(f.counts().submissions, 0);
});
test('queries and GET are rejected, while existing read routes are left to their own handler', async () => {
  const f = fixture(), response = f.res(), request = f.req(); request.method = 'GET';
  await f.handler(request, response, url); assert.equal(response.status, 405);
  await f.handler(f.req(), response, new URL(url.href + '?exec=true')); assert.equal(response.status, 400);
  assert.equal(await f.handler(f.req(), f.res(), new URL('/api/operator/research/day?date=2026-10-14', options.origin)), false); assert.equal(f.counts().submissions, 0);
});
test('an uninstalled fixed broker is unavailable instead of falling back to direct SQL', async () => {
  const f = fixture({ submit: null }), response = f.res(); await f.handler(f.req(), response, url);
  assert.equal(response.status, 503); assert.equal(response.body.error, 'RESEARCH_FIXED_BROKER_UNAVAILABLE'); assert.equal(f.counts().submissions, 0);
});
test('a revoked session during body delivery never reaches the broker', async () => {
  const f = fixture(), request = new PassThrough(), response = f.res(); Object.assign(request, { method: 'POST', headers: f.req().headers });
  const pending = f.handler(request, response, url); await new Promise(resolve => setImmediate(resolve)); f.revoke(); request.end(Buffer.from(JSON.stringify(body)));
  await pending; assert.equal(response.status, 401); assert.equal(f.counts().submissions, 0);
});
test('body timeout releases admission capacity without a write or lock acquisition', async () => {
  const f = fixture({ timeout: 5 }), request = new PassThrough(), response = f.res(); Object.assign(request, { method: 'POST', headers: f.req().headers });
  await f.handler(request, response, url); assert.equal(response.status, 408); assert.equal(f.counts().submissions, 0);
  const next = f.res(); await f.handler(f.req(), next, url); assert.equal(next.status, 200);
});
test('concurrent submissions are rejected until the admitted operation actually ends', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ submit: async () => { await held; return { verified: false, retryWriteAutomatically: false }; } });
  const first = f.res(), second = f.res(); const running = f.handler(f.req(), first, url);
  await new Promise(resolve => setImmediate(resolve)); await f.handler(f.req(), second, url); assert.equal(second.status, 503);
  release(); await running; assert.equal(first.status, 200);
});
test('per-account request limiting cannot be bypassed by changing request JSON', async () => {
  const f = fixture(); for (let i = 0; i < 6; i++) { const r = f.res(); await f.handler(f.req(), r, url); assert.equal(r.status, 200); }
  const blocked = f.res(); await f.handler(f.req(), blocked, url); assert.equal(blocked.status, 429); assert.equal(f.counts().submissions, 6);
});
test('unknown submit outcomes hide internal errors and forbid write retry', async () => {
  const f = fixture({ submit: () => { throw Object.assign(Error('/private/path/key'), { code: 'RESEARCH_BAD /private/path/key' }); } }), response = f.res();
  await f.handler(f.req(), response, url); assert.equal(response.status, 503); assert.equal(response.body.retryWriteAutomatically, false);
  assert(!JSON.stringify(response.body).includes('/private')); assert.match(response.body.error, /READ_FIRST/);
});
test('streamed oversize and byte decoding failures reject before submission', async () => {
  await assert.rejects(readResearchRequestBody(Readable.from([Buffer.alloc(1025)]), { maxBytes: 1024 }), { code: 'RESEARCH_REQUEST_BOUND' });
  await assert.rejects(readResearchRequestBody(Readable.from(['already converted text'])), { code: 'RESEARCH_BODY_ENCODING' });
});
