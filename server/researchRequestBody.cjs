'use strict';
const MAX_BYTES = 1024 * 1024;
function readResearchRequestBody(stream, { maxBytes = MAX_BYTES, timeoutMs = 8000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw Error('RESEARCH_BODY_OPTIONS');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false, timer;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const [event, callback] of [['data', data], ['end', end], ['error', failure], ['aborted', aborted], ['close', aborted]]) stream.removeListener(event, callback);
      if (error) { stream.pause?.(); stream.once('error', () => {}); reject(Object.assign(Error(error), { code: error, retryWriteAutomatically: false })); }
      else resolve(Buffer.concat(chunks));
    };
    const data = chunk => {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return finish('RESEARCH_BODY_ENCODING');
      size += chunk.length;
      if (size > maxBytes) return finish('RESEARCH_REQUEST_BOUND');
      chunks.push(Buffer.from(chunk));
    };
    const end = () => finish();
    const failure = () => finish('RESEARCH_BODY_UNAVAILABLE');
    const aborted = () => finish('RESEARCH_BODY_ABORTED');
    timer = setTimeout(() => finish('RESEARCH_BODY_TIMEOUT'), timeoutMs);
    if (stream.readableEnded || stream.destroyed) return finish('RESEARCH_BODY_UNAVAILABLE');
    for (const [event, callback] of [['data', data], ['end', end], ['error', failure], ['aborted', aborted], ['close', aborted]]) stream.on(event, callback);
  });
}
module.exports = { MAX_BYTES, readResearchRequestBody };
