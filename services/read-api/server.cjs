'use strict';
const http = require('node:http');
const { etag } = require('./repository.cjs');
function createServer({ repository, authorize = async () => false, maxConcurrent = 8 } = {}) {
  if (!repository) throw new Error('Read repository required');
  let active = 0;
  const send = (res, status, body) => {
    const raw = JSON.stringify(body);
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":false,"error":"RESPONSE_BOUND"}'); return; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'ETag': etag(body), 'X-Football-Read-Source': body.preview ? 'postgres-readonly-capture' : (body.storage || 'unavailable'),
      ...(body.publication ? { 'X-Football-Generation': body.publication.generationId } : {}) });
    res.end(raw);
  };
  return http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); }
    if (active >= maxConcurrent) return send(res, 503, { ok: false, error: 'READ_CAPACITY_BUSY' });
    active++;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.url.length > 2048) return send(res, 414, { ok: false, error: 'URI_BOUND' });
      let result;
      if (url.pathname === '/api/v2/health') result = await repository.health();
      else if (url.pathname === '/api/v2/fixtures') {
        for (const key of url.searchParams.keys()) if (!['date', 'limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1) return send(res, 400, { ok: false, error: 'INVALID_QUERY' });
        result = await repository.fixtures(Object.fromEntries(url.searchParams));
      } else if (/^\/api\/v2\/matches\/(?:sporttery|fivehundred)_\d{1,20}$/.test(url.pathname)) {
        if (url.search) return send(res, 400, { ok: false, error: 'INVALID_QUERY' });
        result = await repository.match(url.pathname.split('/').at(-1));
        if (!result.match) return send(res, 404, result);
      } else if (url.pathname === '/api/v2/recommendations') {
        if (url.search) return send(res, 400, { ok: false, error: 'INVALID_QUERY' });
        if (!(await authorize(req))) return send(res, 401, { ok: false, error: 'ACCESS_REQUIRED' });
        result = await repository.recommendations();
      } else return send(res, 404, { ok: false, error: 'NOT_FOUND' });
      send(res, 200, result);
    } catch (error) {
      const code = /^INVALID_/.test(error.code || '') ? error.code : error.code === 'CURSOR_GENERATION_CHANGED' ? error.code : 'COMMITTED_READ_UNAVAILABLE';
      send(res, code.startsWith('INVALID_') ? 400 : code === 'CURSOR_GENERATION_CHANGED' ? 409 : 503, { ok: false, error: code });
    } finally { active--; }
  });
}
async function main() {
  const { createPostgresPool } = require('../../server/postgresStore.cjs');
  const pool = require('./readOnlyPool.cjs').readOnlyPool(createPostgresPool({ max: 4, min: 0, applicationName: 'football-separated-read-api', queryTimeoutMillis: 6000 }));
  const { createRepository } = require('./repository.cjs');
  const { createAuthorization } = require('./authorization.cjs');
  const server = createServer({ repository: createRepository({ pool }), authorize: createAuthorization({ pool }) });
  const port = Number(process.env.READ_API_PORT || 8790);
  const host = process.env.READ_API_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Read API requires a loopback port');
  server.listen(port, host, () => console.log(JSON.stringify({ role: 'read-api', host, port, writesEnabled: false })));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.close(() => void pool.end()); setTimeout(() => server.closeAllConnections(), 15_000).unref(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (require.main === module) main().catch(error => { console.error(error.code || 'READ_API_START_FAILED'); process.exitCode = 1; });
module.exports = { createServer };
