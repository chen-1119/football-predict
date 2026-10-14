'use strict';
// A new review is append-only. Original decisions/SP/scores retain their
// settlement identity and are never overwritten by this planning policy.
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const instant = value => epochNanoseconds(value);
const startedStates = new Set(['LIVE', 'IN_PLAY', 'INPLAY', 'PLAYING', 'HALFTIME', 'FINISHED', 'FINAL', 'ENDED']);
function eventKey(row) {
  const id = row?.eventId || String(row?.sourceMatchId || '').replace(/^sporttery_/, '');
  const event = instant(row?.eventVersion || row?.kickoff || row?.kickoffTime);
  return typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) && event !== null ? id + ':' + event : null;
}
function reviewDisposition(row, observed, asOf) {
  const now = instant(asOf), original = eventKey(row), latest = eventKey(observed);
  const freeze = reason => ({ canRevisePrematch: false, canAppendFacts: now !== null && original !== null && original === latest,
    reason, overwriteOriginal: false, settlementIdentity: original });
  if (now === null || original === null || latest !== original) return freeze('event-or-observation-unverified');
  const kickoff = instant(observed.eventVersion || observed.kickoff || observed.kickoffTime);
  const state = String(observed.status || '').toUpperCase();
  if (startedStates.has(state) || now >= kickoff) return freeze('event-started-append-facts-only');
  if (state !== 'SCHEDULED' || observed.isOnSale !== true) return freeze('event-not-confirmed-open');
  const cutoff = instant(row.cutoffAt || row.cutoffTime), latestCutoff = instant(observed.cutoffAt || observed.cutoffTime || row.cutoffAt || row.cutoffTime);
  if (cutoff === null || latestCutoff === null || now >= cutoff || now >= latestCutoff) return freeze('sale-cutoff-crossed-or-unverified');
  const observedAt = instant(observed.observedAt);
  if (observedAt === null || observedAt > now || now - observedAt > 15n * 60n * 1000000000n) return freeze('observation-not-current');
  return { canRevisePrematch: true, canAppendFacts: true, reason: 'append-new-reviewed-version',
    overwriteOriginal: false, settlementIdentity: original };
}
function comboDisposition(combo, observations, asOf) {
  const now = instant(asOf), legs = combo?.legs;
  const freeze = reason => ({ canRefresh: false, reason, preserveLegsAndSp: true });
  if (now === null || !Array.isArray(legs) || ![2, 3].includes(legs.length)
    || !Array.isArray(observations) || observations.length > 512) return freeze('combo-unverified');
  const keys = legs.map(eventKey);
  if (keys.some(k => !k) || new Set(keys).size !== legs.length) return freeze('combo-event-identity-unverified');
  for (let i = 0; i < legs.length; i++) {
    const found = observations.filter(r => eventKey(r) === keys[i]);
    if (found.length !== 1) return freeze('combo-leg-observation-unverified');
    const latest = found[0], kickoff = instant(latest.eventVersion || latest.kickoff || latest.kickoffTime);
    if (startedStates.has(String(latest.status || '').toUpperCase()) || now >= kickoff)
      return freeze('combo-has-started-leg');
    if (!reviewDisposition(legs[i], latest, asOf).canRevisePrematch) return freeze('combo-leg-not-open-for-review');
  }
  return { canRefresh: true, reason: 'append-new-combo-version', preserveOriginal: true };
}
module.exports = { eventKey, reviewDisposition, comboDisposition };
