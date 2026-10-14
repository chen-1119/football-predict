'use strict';
// Admission candidate only. The server does not wire this handler until the
// signed fixed broker installation and its actual caller binding are verified.
const { decodeRequest, MAX_REQUEST_BYTES } = require('./researchWriteService.cjs');
const { readResearchRequestBody } = require('./researchRequestBody.cjs');
const paths = new Map([
  ['/api/operator/research/report', 'archive'],
  ['/api/operator/research/report-read', 'archive-read'],
  ['/api/operator/research/publish', 'publish'],
  ['/api/operator/research/publication-read', 'publication-read'],
]);
function createResearchWriteHandler({ accounts, submit, bodyTimeoutMs = 8000, now = Date.now } = {}) {
  if (typeof accounts?.authorizeMutation !== 'function') throw Error('RESEARCH_MUTATION_AUTH_REQUIRED');
  let active = 0;
  const rate = new Map();
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie', 'Allow': 'POST', 'Connection': 'close' });
    res.end(JSON.stringify({ ...value, retryWriteAutomatically: false })); return true;
  };
  return async (req, res, url) => {
    const action = paths.get(url.pathname);
    if (!action) return false;
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST_REQUIRED' });
    if (url.search) return send(res, 400, { ok: false, error: 'INVALID_QUERY' });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
      || ![undefined, 'identity'].includes(req.headers['content-encoding'])) return send(res, 415, { ok: false, error: 'JSON_UTF8_REQUIRED' });
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) return send(res, 413, { ok: false, error: 'RESEARCH_REQUEST_BOUND' });
    if (active) return send(res, 503, { ok: false, error: 'RESEARCH_ADMISSION_BUSY' });
    active++;
    try {
      const auth = await accounts.authorizeMutation(req, { role: ['operator', 'admin'] });
      if (!auth?.user?.id || !['operator', 'admin'].includes(auth.user.role)) return send(res, 403, { ok: false, error: 'OPERATOR_REQUIRED' });
      const time = now();
      for (const [key, bucket] of rate) if (time - bucket.startedAt >= 300000) rate.delete(key);
      let bucket = rate.get(auth.user.id);
      if (!bucket) {
        if (rate.size >= 256) return send(res, 503, { ok: false, error: 'RESEARCH_ADMISSION_BUSY' });
        bucket = { startedAt: time, count: 0 }; rate.set(auth.user.id, bucket);
      }
      if (++bucket.count > 6) return send(res, 429, { ok: false, error: 'RESEARCH_REQUEST_RATE_LIMITED' });
      if (typeof submit !== 'function') return send(res, 503, { ok: false, error: 'RESEARCH_FIXED_BROKER_UNAVAILABLE' });
      const raw = await readResearchRequestBody(req, { timeoutMs: bodyTimeoutMs });
      const request = decodeRequest(raw);
      if (request.action !== action) return send(res, 400, { ok: false, error: 'RESEARCH_REQUEST_ACTION_MISMATCH' });
      // Recheck the live session, role, Origin and session-bound CSRF after
      // reading a body; no client field can supply an actor or credentials.
      const current = await accounts.authorizeMutation(req, { role: ['operator', 'admin'] });
      if (current?.user?.id !== auth.user.id || !['operator', 'admin'].includes(current.user.role)) return send(res, 403, { ok: false, error: 'OPERATOR_REQUIRED' });
      const result = await submit(raw);
      if (!result || result.retryWriteAutomatically !== false) return send(res, 503, { ok: false, error: 'RESEARCH_BROKER_RESULT_UNVERIFIED' });
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      const known = /^(RESEARCH|REPORT)_[A-Z0-9_]+$/.test(error.code || '');
      const authError = ['authentication_required', 'insufficient_role', 'origin_rejected', 'csrf_rejected'].includes(error.code);
      const status = authError ? error.status || 403 : error.code === 'RESEARCH_BODY_TIMEOUT' ? 408
        : error.code === 'RESEARCH_REQUEST_BOUND' ? 413 : known && /REQUEST|BODY_ENCODING|DRAFT_|REPORT_(DATE|KIND|JSON|UTF8|HASH)/.test(error.code) ? 400 : 503;
      return send(res, status, { ok: false, error: authError || known ? error.code : 'RESEARCH_SUBMISSION_UNCONFIRMED_READ_FIRST' });
    } finally { active--; }
  };
}
module.exports = { createResearchWriteHandler };
