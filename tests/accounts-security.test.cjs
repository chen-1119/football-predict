'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAccounts, normalizeUsername, validatePassword, hashPassword, verifyPassword } = require('../server/accounts.cjs');
const noDb = { query() { throw Error('Unexpected DB access'); }, connect() { throw Error('Unexpected DB access'); } };
const options = { origin: 'https://football.example', csrfSecret: 'accounts-unit-test-secret-only-00000000000000' };
function request(service, method, path, headers = {}, body = {}) {
  const req = Readable.from([JSON.stringify(body)]); req.method = method; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' };
  const output = { headers: {} };
  const res = { statusCode: 200, setHeader(k, v) { output.headers[k.toLowerCase()] = v; }, end(value) { output.status = this.statusCode; output.body = JSON.parse(value); } };
  return service.handle(req, res, new URL(path, options.origin)).then(handled => ({ ...output, handled }));
}

test('username canonicalization and password bounds preserve spaces without granting a role', () => {
  assert.equal(normalizeUsername(' Alice_123 '), 'alice_123');
  for (const value of ['a', 'abc@x', ' x/y ', { toString: () => 'alice' }]) assert.throws(() => normalizeUsername(value));
  assert.equal(validatePassword(' many spaces allowed '), ' many spaces allowed ');
  for (const value of ['x'.repeat(14), 'x'.repeat(129), null]) assert.throws(() => validatePassword(value));
});

test('password hashes use independent salt, fixed memory-bounded scrypt and reject wrong or malformed inputs', async () => {
  const password = 'correct horse battery staple';
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.notEqual(a, b); assert.match(a, /^scrypt\$v1\$32768\$8\$3\$/);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('wrong password', a), false);
  assert.equal(await verifyPassword(password, a.replace('32768', '999999999')), false);
  assert.equal(await verifyPassword('x'.repeat(129), a), false);
});

test('production cookies are HttpOnly Secure Host-scoped and anonymous me has no invented access', async () => {
  const service = createAccounts({ pool: noDb, options });
  const response = await request(service, 'GET', '/api/account/me');
  assert.equal(response.status, 200); assert.equal(response.body.user, null); assert.equal(response.body.access.active, false);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['set-cookie'][0], /^__Host-football_csrf=/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/); assert.match(response.headers['set-cookie'][0], /; Secure$/);
  assert.equal(service.hasSessionCookie({ headers: { cookie: '__Host-football_session=invalid' } }), true);
  assert.equal(service.hasSessionCookie({ headers: {} }), false);
});

test('me expires an invalid account cookie while issuing fresh anonymous CSRF', async () => {
  const service = createAccounts({ pool: noDb, options });
  const response = await request(service, 'GET', '/api/account/me', { cookie: '__Host-football_session=invalid' });
  assert.equal(response.status, 200); assert.equal(response.body.user, null);
  assert(response.headers['set-cookie'].some(cookie => cookie.startsWith('__Host-football_session=;') && /Max-Age=0/.test(cookie)));
  assert(response.headers['set-cookie'].some(cookie => cookie.startsWith('__Host-football_csrf=')));
  assert.match(response.body.csrfToken, /^[a-zA-Z0-9_-]{43}$/);
});

test('cross-origin writes and missing CSRF fail before registration touches PostgreSQL', async () => {
  const service = createAccounts({ pool: noDb, options });
  const crossOrigin = await request(service, 'POST', '/api/account/register', { origin: 'https://attacker.example' });
  assert.equal(crossOrigin.status, 403); assert.equal(crossOrigin.body.error, 'origin_rejected');
  const missing = await request(service, 'POST', '/api/account/register', { origin: options.origin });
  assert.equal(missing.status, 403); assert.equal(missing.body.error, 'csrf_rejected');
});

test('cookie bootstrap cannot be forged or transplanted into a different browser session', async () => {
  const service = createAccounts({ pool: noDb, options });
  const first = await request(service, 'GET', '/api/account/me');
  const second = await request(service, 'GET', '/api/account/me');
  const cookie = second.headers['set-cookie'][0].split(';')[0];
  const response = await request(service, 'POST', '/api/account/register', { origin: options.origin, cookie, 'x-csrf-token': first.body.csrfToken });
  assert.equal(response.status, 403); assert.equal(response.body.error, 'csrf_rejected');
});

test('insecure transport is limited to explicitly opted-in loopback development', () => {
  assert.throws(() => createAccounts({ pool: noDb, options: { ...options, secureCookies: false } }));
  assert.throws(() => createAccounts({ pool: noDb, options: { ...options, origin: 'http://football.example', secureCookies: false, allowInsecureLoopback: true } }));
  assert.throws(() => createAccounts({ pool: noDb, options: { ...options, csrfSecret: 'weak' } }));
  const service = createAccounts({ pool: noDb, options: { ...options, origin: 'http://127.0.0.1:9999', secureCookies: false, allowInsecureLoopback: true } });
  assert.equal(service.cookieNames.session, 'football_session');
});

module.exports = { request };
