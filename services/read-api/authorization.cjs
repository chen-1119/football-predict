'use strict';
const crypto = require('node:crypto');
const { createAccounts } = require('../../server/accounts.cjs');
function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Account bridge must be an exact HTTP loopback origin');
  return url.origin;
}
function createAuthorization({ pool, env = process.env, fetchImpl = fetch } = {}) {
  const secret = env.ACCESS_CODE_SECRET || env.ACCESS_SESSION_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Read API requires the existing access session secret');
  const accounts = createAccounts({ pool, options: { origin: env.ACCOUNT_PUBLIC_ORIGIN || 'https://134.175.132.183',
    csrfSecret: crypto.createHmac('sha256', secret).update('football-account-csrf-v1').digest('hex') } });
  const bridge = loopbackOrigin(env.READ_API_AUTH_BRIDGE_ORIGIN || 'http://127.0.0.1:8788');
  return async req => {
    const cookie = String(req.headers.cookie || '');
    if (Buffer.byteLength(cookie) > 8192) return false;
    const account = await accounts.authenticate(req);
    // Preserve blocked/expired-account precedence over a separate shared code.
    if (account || accounts.hasSessionCookie(req)) return account?.access.active === true;
    const headers = {};
    if (cookie) headers.cookie = cookie;
    const bearer = req.headers.authorization;
    if (typeof bearer === 'string' && bearer.length <= 1024) headers.authorization = bearer;
    const response = await fetchImpl(bridge + '/api/access/status', { headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) return false;
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 8192) return false; chunks.push(Buffer.from(part.value)); } }
    finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value.ok === true && value.authorized === true;
  };
}
module.exports = { createAuthorization, loopbackOrigin };
