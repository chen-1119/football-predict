'use strict';
const fallback = new Map();
const MAX_BODY = 16 * 1024 * 1024;
function origin() {
  const value = process.env.FOOTBALL_READ_API_ORIGIN || 'http://127.0.0.1:8790';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid read API origin');
  return url.origin;
}
function headers(cookie) {
  const value = cookie ? { cookie } : {};
  // Local captured-data previews use a server-to-server capability, never a
  // browser token, query parameter or change to production authorization.
  if (process.env.FOOTBALL_PREVIEW_CAPTURE_TOKEN) {
    const url = new URL(origin());
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Preview must stay on loopback');
    value['x-football-local-preview'] = process.env.FOOTBALL_PREVIEW_CAPTURE_TOKEN;
  }
  return value;
}
async function body(response) {
  const chunks = []; let size = 0;
  if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('API_CONTENT_TYPE');
  const reader = response.body.getReader();
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_BODY) throw new Error('API_BODY_BOUND'); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function loadFixtures(query = {}, { fetchImpl = fetch, now = Date.now } = {}) {
  const params = new URLSearchParams(query), key = params.toString();
  try {
    const response = await fetchImpl(origin() + '/api/v2/fixtures' + (key ? '?' + key : ''), { cache: 'no-store', redirect: 'error', headers: headers(), signal: AbortSignal.timeout(7000) });
    if (response.status === 409) return { ok: false, matches: [], availability: 'generation-changed', stale: true };
    if (!response.ok) throw new Error('API_UNAVAILABLE');
    const value = await body(response);
    if (value.ok !== true || !Array.isArray(value.matches) || value.matches.length > 100 || value.storage !== 'postgres' || !value.publication?.generationId) throw new Error('API_CONTRACT');
    if (fallback.size >= 8 && !fallback.has(key)) fallback.delete(fallback.keys().next().value);
    fallback.set(key, { value, at: now() });
    return { ...value, availability: 'available' };
  } catch {
    const saved = fallback.get(key);
    if (saved && now() >= saved.at && now() - saved.at <= 24 * 3600_000) {
      return { ...saved.value, stale: true, availability: 'last-committed-snapshot',
        matches: saved.value.matches.map(row => ({ ...row, quoteStatus: 'expired' })) };
    }
    return { ok: false, matches: [], availability: 'unavailable', stale: true };
  }
}
async function loadMatch(id, { fetchImpl = fetch } = {}) {
  if (!/^(?:sporttery|fivehundred)_\d{1,20}$/.test(id)) return null;
  try {
    const response = await fetchImpl(origin() + '/api/v2/matches/' + id, { cache: 'no-store', redirect: 'error', headers: headers(), signal: AbortSignal.timeout(7000) });
    if (!response.ok) return null;
    const value = await body(response);
    return value.ok === true && value.storage === 'postgres' && value.match?.id === id ? value : null;
  } catch { return null; }
}
async function loadRecommendations(cookie) {
  // Never reuse a private response across users, requests or revocations.
  try {
    const response = await fetch(origin() + '/api/v2/recommendations', { cache: 'no-store', redirect: 'error',
      headers: headers(cookie), signal: AbortSignal.timeout(15_000) });
    if (response.status === 401) return { ok: false, accessRequired: true };
    if (!response.ok) return { ok: false };
    return await body(response);
  } catch { return { ok: false }; }
}
module.exports = { loadFixtures, loadMatch, loadRecommendations, body };
