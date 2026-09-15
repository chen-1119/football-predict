'use strict';
const https = require('node:https');
const { config, failure, retryAfterSeconds } = require('./policy.cjs');
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

/** Bounded public-page GET. Redirects, login pages and access blocks are not bypassed. */
function fetchMarketPage(url, { signal, timeoutMs = 20000, maxBytes = 4 * 1024 * 1024,
  request = https.request, now = Date.now } = {}) {
  config({ FIVE_HUNDRED_JCZQ_URL: url });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return Promise.reject(failure('INVALID_REQUEST_BUDGET', 'Invalid request budget'));
  }
  return new Promise((resolve, reject) => {
    let req, response, completed = false, total = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) { req?.destroy(); response?.destroy(); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(failure('COLLECTION_ABORTED', 'Collection cancelled'));
    // A wall-clock deadline also covers DNS/TLS and trickle responses; socket timeout alone cannot.
    const deadline = setTimeout(() => finish(failure('SOURCE_TIMEOUT', 'Source request exceeded its deadline')), timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      req = request(url, { method: 'GET', agent, headers: {
        'User-Agent': 'football-predict/1.0 (public-page collector)',
        Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', 'Accept-Language': 'zh-CN,zh;q=0.9',
      } }, res => {
        response = res;
        res.on('error', () => finish(failure('SOURCE_STREAM_ERROR', 'Source stream failed')));
        res.on('aborted', () => finish(failure('SOURCE_TRUNCATED', 'Source response was interrupted')));
        const statusCode = res.statusCode || 0;
        if (statusCode !== 200) {
          const code = [401, 403, 405, 429].includes(statusCode) ? 'SOURCE_BLOCKED' : 'SOURCE_HTTP_ERROR';
          return finish(Object.assign(failure(code, `Source returned HTTP ${statusCode}`), {
            statusCode, retryAfterSeconds: retryAfterSeconds(res.headers['retry-after'], now()),
          }));
        }
        const length = Number(res.headers['content-length']);
        if (Number.isFinite(length) && length > maxBytes) return finish(failure('SOURCE_TOO_LARGE', 'Source response exceeded its byte budget'));
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          return finish(failure('UNSUPPORTED_ENCODING', 'Unexpected compressed source response'));
        }
        res.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > maxBytes) return finish(failure('SOURCE_TOO_LARGE', 'Source response exceeded its byte budget'));
          chunks.push(buffer);
        });
        res.on('end', () => finish(null, { body: Buffer.concat(chunks), statusCode }));
        res.on('close', () => { if (!res.complete && !completed) finish(failure('SOURCE_TRUNCATED', 'Source closed before completion')); });
      });
      req.on('error', error => finish(failure(error.code === 'ETIMEDOUT' ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR', 'Source network request failed')));
      req.end();
    } catch { finish(failure('SOURCE_NETWORK_ERROR', 'Source request could not start')); }
  });
}
module.exports = { fetchMarketPage, closeMarketTransport: () => agent.destroy() };
