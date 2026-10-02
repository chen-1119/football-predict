'use strict';
// Read-only policy proposal. No fetch, clock refresh, scheduler or publication writes.
const { sourceInstant: instant } = require('./sourceClock.cjs');
function officialNotice(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['www.sporttery.cn', 'sporttery.cn', 'www.mof.gov.cn'].includes(u.hostname)
      && !u.username && !u.password && !u.port && !u.hash;
  } catch { return false; }
}
function diagnoseSourceCollection(input) {
  const at = instant(input.observedAt);
  if (at === null) throw new Error('Explicit valid observedAt required');
  const failures = input.consecutiveFailures ?? 0;
  if (!Number.isSafeInteger(failures) || failures < 0) throw new Error('Invalid consecutiveFailures');
  const retryAfter = input.retryAfterSeconds ?? 0;
  if (!Number.isSafeInteger(retryAfter) || retryAfter < 0 || retryAfter > 86400) throw new Error('Provider retry requires operator review');
  const closure = input.closure;
  const start = instant(closure?.startsAt), end = instant(closure?.endsAt);
  const checked = instant(closure?.verifiedAt);
  const closed = input.source === 'sporttery' && input.scope === 'current-schedule'
    && closure?.verified === true && closure?.scope === 'current-schedule'
    && officialNotice(closure?.noticeUrl) && start !== null && end !== null && end > start
    && checked !== null && checked <= at && start <= at && at < end;
  const success = input.httpStatus === 200 && input.schemaValid === true && input.providerSuccess === true
    && Number.isSafeInteger(input.rows) && input.rows >= 0;
  let state, reason, delaySeconds;
  if (success && input.rows > 0) {
    state = 'available'; reason = 'validated-nonempty-response'; delaySeconds = 300;
  } else if (success && closed) {
    state = 'closed'; reason = 'verified-official-closure-empty-response';
    delaySeconds = Math.min(21600, Math.ceil((end - at) / 1000));
  } else {
    const blocked = [403, 429, 567].includes(input.httpStatus);
    state = blocked ? 'blocked' : success ? 'unknown-empty' : 'failed';
    reason = blocked ? `http-${input.httpStatus}` : input.httpStatus !== 200 ? 'transport-failure'
      : input.schemaValid !== true ? 'invalid-response-schema' : input.providerSuccess !== true ? 'provider-success-not-confirmed'
        : !success ? 'invalid-row-count' : 'empty-without-verified-closure';
    // Zero prior failures means the first failure; saturate before exponentiation.
    delaySeconds = blocked ? Math.min(86400, 21600 * 2 ** Math.min(failures, 2))
      : Math.min(3600, 60 * 2 ** Math.min(failures, 6));
  }
  delaySeconds = Math.max(delaySeconds, retryAfter);
  return {
    version: 'source-collection-diagnostic-v1', source: input.source || null,
    scope: input.scope || null, observedAt: input.observedAt, state, reason,
    rows: success ? input.rows : null, httpStatus: input.httpStatus ?? null,
    consecutiveFailures: ['available', 'closed'].includes(state) ? 0 : Math.min(failures + 1, Number.MAX_SAFE_INTEGER),
    retryAfterSeconds: delaySeconds, nextAttemptAt: new Date(at + delaySeconds * 1000).toISOString(),
    closureEvidence: closed ? { noticeUrl: closure.noticeUrl, startsAt: closure.startsAt,
      endsAt: closure.endsAt, verifiedAt: closure.verifiedAt } : null,
    publicationAction: 'none', sourceDataUpdatedAt: input.sourceDataUpdatedAt ?? null,
    audit: { sourceCycleId: input.sourceCycleId || null,
      rawSha256: typeof input.rawSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.rawSha256) ? input.rawSha256 : null },
    note: 'Observation and proposed next attempt are not provider data updates. Caller must preserve raw response hash and existing trusted snapshot.',
  };
}
module.exports = { diagnoseSourceCollection };
