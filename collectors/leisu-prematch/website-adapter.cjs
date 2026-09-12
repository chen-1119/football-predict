'use strict';

const scope = require('./scope.cjs');
const KINDS = ['injuries', 'lineup'];
const ATTEMPT_STATUSES = new Set(['available', 'source_empty', 'login_required', 'blocked', 'parse_error', 'conflict']);
const MAX_EXPORT_AGE_MS = 10 * 60 * 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptySections = () => Object.fromEntries(KINDS.map(kind => [kind, { latestValid: null, latestAttempt: null }]));

// Reuse the scope module's explicit-zone/calendar validation. Never parse a
// server-local time or read a file, database, browser, or environment variable.
function instant(value) {
  if (typeof value !== 'string') return null;
  try { return Date.parse(scope.windowFor(value).nowUtc); } catch { return null; }
}

function sameFixture(candidate, fixture) {
  return object(candidate) && ['siteMatchId', 'eventVersion', 'kickoffUtc', 'homeName', 'awayName']
    .every(key => candidate[key] === fixture[key]);
}

function validObservation(observation, kind, fixture, nowMs, generatedMs, requireAvailable) {
  if (!object(observation) || observation.kind !== kind || observation.siteMatchId !== fixture.siteMatchId
      || observation.eventVersion !== fixture.eventVersion || !ATTEMPT_STATUSES.has(observation.status)
      || (requireAvailable && observation.status !== 'available')
      || (observation.predictionEligible !== undefined && observation.predictionEligible !== false)
      || typeof observation.providerMatchId !== 'string' || !/^[1-9]\d*$/.test(observation.providerMatchId)) return false;
  const receivedMs = instant(observation.receivedAt);
  if (receivedMs === null || receivedMs > nowMs || receivedMs > generatedMs || receivedMs >= Date.parse(fixture.kickoffUtc)) return false;
  const expectedUrl = `https://live.leisu.com/${kind === 'injuries' ? 'shujufenxi' : 'detail'}-${observation.providerMatchId}`;
  if (observation.sourceUrl !== expectedUrl) return false;
  const payload = observation.data;
  if (observation.status !== 'available') return payload === null;
  if (!object(payload) || payload.providerMatchId !== observation.providerMatchId
      || payload.homeName !== fixture.homeName || payload.awayName !== fixture.awayName
      || payload.kickoffUtc !== fixture.kickoffUtc) return false;
  if (kind === 'injuries' && (!Array.isArray(payload.injuries) || !payload.injuries.length)) return false;
  if (kind === 'lineup' && (!Array.isArray(payload.teams) || payload.teams.length !== 2)) return false;
  for (const publishedAt of [observation.sourcePublishedAt, payload.sourcePublishedAt]) {
    if (publishedAt !== undefined && publishedAt !== null) {
      const publishedMs = instant(publishedAt);
      if (publishedMs === null || publishedMs > receivedMs) return false;
    }
  }
  return true;
}

/**
 * Select one current fixture's reported evidence from an already-read JSON
 * export. `ok` means the envelope passed validation, not that the latest attempt
 * succeeded. Consumers must display latestValid and latestAttempt separately,
 * including each observation's receivedAt. No prediction inputs are produced.
 */
function selectEvidence(exportDoc, currentFixture, now = Date.now()) {
  const selection = scope.selectFixtures([currentFixture], now);
  const nowMs = Date.parse(selection.window.nowUtc);
  let generatedAt = null;
  const reject = (status, reason) => ({ status, reason, generatedAt, predictionEligible: false, sections: emptySections() });
  if (selection.selected.length !== 1) return reject('ineligible', selection.excluded[0]?.reason || 'fixture-not-eligible');
  const fixture = selection.selected[0];
  if (exportDoc === undefined || exportDoc === null) return reject('missing', 'export-missing');
  if (!object(exportDoc) || exportDoc.predictionEligible !== false) return reject('conflict', 'invalid-export-envelope');
  const generatedMs = instant(exportDoc.generatedAt);
  if (generatedMs === null) return reject('conflict', 'invalid-export-time');
  generatedAt = new Date(generatedMs).toISOString();
  if (generatedMs > nowMs) return reject('conflict', 'export-time-in-future');
  if (nowMs - generatedMs > MAX_EXPORT_AGE_MS) return reject('stale', 'export-older-than-ten-minutes');
  if (!Array.isArray(exportDoc.items)) return reject('conflict', 'invalid-export-items');
  const matches = exportDoc.items.filter(item => item?.fixture?.siteMatchId === fixture.siteMatchId);
  if (!matches.length) return reject('missing', 'fixture-not-in-export');
  if (matches.length !== 1) return reject('conflict', 'duplicate-export-fixture');
  const item = matches[0];
  if (!sameFixture(item.fixture, fixture)) return reject('conflict', 'fixture-identity-changed');
  const evidence = item.evidence;
  if (!object(evidence) || evidence.siteMatchId !== fixture.siteMatchId || evidence.eventVersion !== fixture.eventVersion
      || evidence.predictionEligible !== false || !object(evidence.sections)) return reject('conflict', 'invalid-evidence-envelope');
  const sections = emptySections();
  let hasObservation = false;
  for (const kind of KINDS) {
    const section = evidence.sections[kind];
    if (section === undefined || section === null) continue;
    if (!object(section)) return reject('conflict', 'invalid-evidence-section');
    for (const field of ['latestValid', 'latestAttempt']) {
      const observation = section[field];
      if (observation === undefined || observation === null) continue;
      if (!validObservation(observation, kind, fixture, nowMs, generatedMs, field === 'latestValid')) {
        return reject('conflict', `invalid-${kind}-${field}`);
      }
      sections[kind][field] = structuredClone({ ...observation, predictionEligible: false });
      hasObservation = true;
    }
  }
  return { status: hasObservation ? 'ok' : 'missing', generatedAt, predictionEligible: false, sections };
}

module.exports = { selectEvidence };
