'use strict';
const { beijingDay, selectDay } = require('../collectors/leisu-prematch/local-jingcai-day.cjs');
const COOLDOWN_MS = 30 * 60000;
function eligibleFixture(match, now = Date.now()) {
  if (!match || match.businessDate !== beijingDay(now)) return null;
  const row = selectDay([match], beijingDay(now), now)[0];
  return row?.eligible ? row : null;
}
async function requestRefresh(pool, match, now = Date.now()) {
  const fixture = eligibleFixture(match, now);
  if (!fixture) return { ok: false, error: 'invalid_fixture', statusCode: 409 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same match has one shared queue slot across users. Concurrent page opens
    // cannot spend separate source requests, extend the cooldown or flood jobs.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['prematch-refresh:' + fixture.siteMatchId]);
    const old = (await client.query('SELECT * FROM football.prematch_refresh_requests WHERE match_id=$1', [fixture.siteMatchId])).rows[0];
    const at = new Date(now).toISOString(), next = new Date(now + COOLDOWN_MS).toISOString();
    let row = old, state = 'cooldown';
    if (!old || Date.parse(old.event_version) !== Date.parse(fixture.eventVersion) || Date.parse(old.next_allowed_at) <= now) {
      row = (await client.query(`INSERT INTO football.prematch_refresh_requests
        (match_id,event_version,requested_at,next_allowed_at,expires_at,state) VALUES($1,$2,$3,$4,$2,'pending')
        ON CONFLICT(match_id) DO UPDATE SET event_version=EXCLUDED.event_version,requested_at=EXCLUDED.requested_at,
        next_allowed_at=EXCLUDED.next_allowed_at,expires_at=EXCLUDED.expires_at,state='pending',handled_at=NULL RETURNING *`,
      [fixture.siteMatchId, fixture.eventVersion, at, next])).rows[0];
      state = 'queued';
    }
    await client.query('COMMIT');
    return { ok: true, state, requestedAt: new Date(row.requested_at).toISOString(),
      nextAllowedAt: new Date(row.next_allowed_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
      checkWithinMinutes: 5, referenceOnly: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function readPriorities(client, now = Date.now()) {
  return (await client.query(`SELECT match_id,event_version,requested_at FROM football.prematch_refresh_requests
    WHERE state='pending' AND expires_at>$1 ORDER BY expires_at,requested_at LIMIT 500`, [new Date(now).toISOString()])).rows;
}
async function completePriorities(client, priorities, handled, now = Date.now()) {
  for (const row of priorities.filter(p => handled.has(p.match_id))) {
    // A later request made while the collector ran must remain pending.
    await client.query(`UPDATE football.prematch_refresh_requests SET state='completed',handled_at=$1
      WHERE match_id=$2 AND event_version=$3 AND requested_at=$4 AND state='pending'`,
    [new Date(now).toISOString(), row.match_id, row.event_version, row.requested_at]);
  }
  await client.query('DELETE FROM football.prematch_refresh_requests WHERE expires_at<$1', [new Date(now - 2 * 86400000).toISOString()]);
}
function createRefreshHandler({ pool, readFixture, authorize, origin, clock = Date.now }) {
  return async (req, res, id) => {
    const send = (body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'private, no-store'); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return send({ ok: false, error: 'method_not_allowed' }, 405);
    // Exact trusted origin plus a non-simple header prevents cookie-auth CSRF;
    // clients cannot choose match data, request times or a provider budget.
    if (!origin || req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-prematch-request'] !== '1') return send({ ok: false, error: 'origin_rejected' }, 403);
    if (!(await authorize(req))) return send({ ok: false, error: 'authentication_required' }, 401);
    if (!pool) return send({ ok: false, error: 'unavailable' }, 503);
    req.resume?.();
    try {
      const result = await requestRefresh(pool, await readFixture(id), clock());
      const { statusCode, ...body } = result; return send(body, statusCode || 202);
    } catch { return send({ ok: false, error: 'unavailable' }, 503); }
  };
}
module.exports = { COOLDOWN_MS, eligibleFixture, requestRefresh, readPriorities, completePriorities, createRefreshHandler };
