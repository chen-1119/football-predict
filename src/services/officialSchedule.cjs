'use strict';
function validateOfficialSchedule(value, expectedDay, now) {
  const check = condition => { if (!condition) throw Error('OFFICIAL_SCHEDULE_VIEW_INVALID'); };
  const clock = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
  check(value && value.version === 'signed-official-schedule-view-v1' && value.businessDate === expectedDay
    && /^\d{4}-\d{2}-\d{2}$/.test(expectedDay) && Number.isFinite(Date.parse(expectedDay + 'T00:00:00Z'))
    && new Date(expectedDay + 'T00:00:00Z').toISOString().slice(0, 10) === expectedDay
    && value.sourceSignatureVerified === true && value.recommendationEligibilityVerified === false
    && value.maximumAgeMs === 900000 && text(value.sourceCycleId) && Number.isFinite(now));
  for (const at of [value.updatedAt, value.sourceReceivedAt, value.quoteReceivedAt]) check(clock(at) && Date.parse(at) <= now + 5000 && now - Date.parse(at) <= value.maximumAgeMs);
  check(Date.parse(value.sourceReceivedAt) <= Date.parse(value.updatedAt) && Date.parse(value.quoteReceivedAt) <= Date.parse(value.updatedAt));
  check(Array.isArray(value.events) && value.events.length <= 512);
  const ids = new Set();
  for (const event of value.events) {
    check(event && /^[1-9]\d{0,19}$/.test(event.eventId) && !ids.has(event.eventId) && event.businessDate === expectedDay
      && text(event.matchNum) && text(event.homeTeamName) && text(event.awayTeamName) && clock(event.kickoff)
      && [event.homeTeamId, event.awayTeamId].every(v => Number.isSafeInteger(v) && v > 0) && event.homeTeamId !== event.awayTeamId
      && typeof event.leagueName === 'string' && event.leagueName.length <= 255 && typeof event.matchStatus === 'string' && event.matchStatus.length <= 64
      && (event.sellStatus === null || typeof event.sellStatus === 'string' && event.sellStatus.length <= 16)
      && ['open','closed','awaiting','unknown'].includes(event.saleState) && clock(event.saleCutoffAt) && Date.parse(event.saleCutoffAt)<=Date.parse(event.kickoff)
      && ['matched', 'unavailable', 'conflict'].includes(event.quoteStatus) && Array.isArray(event.markets) && event.markets.length <= 2);
    ids.add(event.eventId);
    if (event.quoteStatus !== 'matched') check(event.markets.length === 0);
    const pools = new Set();
    for (const market of event.markets) {
      check(['HAD', 'HHAD'].includes(market.poolCode) && !pools.has(market.poolCode)
        && [market.h, market.d, market.a].every(v => Number.isFinite(v) && v > 1 && v <= 10000)
        && (market.poolCode === 'HAD' ? market.handicap === null : Number.isSafeInteger(market.handicap) && Math.abs(market.handicap) <= 12));
      pools.add(market.poolCode);
    }
  }
  return value;
}
module.exports = { validateOfficialSchedule };
