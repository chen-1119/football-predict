'use strict';
async function handle(req, res, url, { authorize, send, read = require('./officialScheduleRead.cjs').read }) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, Authorization');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: 'method not allowed' });
  if (!await authorize()) return send(401, { ok: false, error: 'access code required' });
  if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('businessDate').length !== 1) return send(400, { ok: false, error: 'invalid business day' });
  try {
    const day = require('./researchArchiveRead.cjs').day(url.searchParams.get('businessDate'));
    return send(200, read(day));
  } catch (error) {
    return send(error.code === 'INVALID_DATE' ? 400 : 503, { ok: false, error: 'official schedule unavailable' });
  }
}
module.exports = { handle };
