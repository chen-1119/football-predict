'use strict';

// Pure reconciliation of already collected public-page records. No I/O, fuzzy
// matching, mutable registry or clock reads. The caller supplies the current time.
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value; // Preserve original spelling and whitespace for exact matching.
};
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sourceId = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || /\s/.test(value)) throw new TypeError('providerMatchId must be a positive integer ID');
  return value;
};

function exactInstant(value, field) {
  // Restrict precision to milliseconds, the precision available to Date and to
  // this comparison. Validate calendar components before converting the offset;
  // Date.parse alone silently normalizes dates such as February 30.
  if (typeof value !== 'string') throw new TypeError(`${field} must be a timezone-explicit ISO timestamp`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) throw new TypeError(`${field} must be a timezone-explicit ISO timestamp`);
  const [, yy, mo, dd, hh, mm, ss = '0', fraction = '', zone] = match;
  const year = Number(yy), month = Number(mo), day = Number(dd), hour = Number(hh), minute = Number(mm), second = Number(ss);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) throw new TypeError(`${field} has invalid calendar components`);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0')));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) throw new TypeError(`${field} has an invalid calendar date`);
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3)), offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) throw new TypeError(`${field} has an invalid timezone offset`);
    offsetMinutes = (zone[0] === '+' ? 1 : -1) * (offsetHours * 60 + offsetRemainder);
  }
  const result = new Date(wall.getTime() - offsetMinutes * 60000);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${field} is out of range`);
  return result.toISOString();
}

function verificationTime(now) {
  if (typeof now === 'string') return exactInstant(now, 'now');
  if (!(now instanceof Date) && (typeof now !== 'number' || !Number.isFinite(now))) throw new TypeError('now must be an explicit valid date or timestamp');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be an explicit valid date or timestamp');
  return date.toISOString();
}

const identity = (homeName, awayName, kickoffUtc) => JSON.stringify([homeName, awayName, kickoffUtc]);
const groupBy = (items, keyOf) => {
  const groups = new Map();
  for (const item of items) { const key = keyOf(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return groups;
};

/**
 * @returns {{mappings: object[], unmatched: object[], conflicts: object[]}}
 * Conflicts have a stable reason, siteMatchIds/providerMatchIds, and relevant
 * input indexes. Invalid rows are quarantined, not allowed to stop other rows.
 * Invalid top-level arguments or alias configuration throw TypeError.
 */
function reconcileMappings(fixtures, candidates, aliases = {}, now) {
  if (!Array.isArray(fixtures) || !Array.isArray(candidates)) throw new TypeError('fixtures and candidates must be arrays');
  if (!plainObject(aliases)) throw new TypeError('aliases must be an explicit provider-name to website-name object');
  for (const [providerName, websiteName] of Object.entries(aliases)) { requiredText(providerName, 'alias key'); requiredText(websiteName, 'alias value'); }
  const verifiedAt = verificationTime(now);
  const translated = name => Object.hasOwn(aliases, name) ? aliases[name] : name;
  const mappings = [], unmatched = [], conflicts = [];
  const validFixtures = [], validCandidates = [], poisonedProviderIds = new Set();

  fixtures.forEach((fixture, index) => {
    try {
      if (!plainObject(fixture)) throw new TypeError('fixture must be an object');
      const parsed = {
        siteMatchId: requiredText(fixture.siteMatchId, 'siteMatchId'),
        homeName: requiredText(fixture.homeName, 'fixture.homeName'),
        awayName: requiredText(fixture.awayName, 'fixture.awayName'),
        kickoffUtc: exactInstant(fixture.kickoffUtc, 'fixture.kickoffUtc'), index,
      };
      if (parsed.homeName === parsed.awayName) throw new TypeError('fixture home and away names must differ');
      validFixtures.push(parsed);
    } catch (error) {
      const siteMatchId = typeof fixture?.siteMatchId === 'string' ? fixture.siteMatchId : null;
      conflicts.push({ reason: 'invalid_fixture', siteMatchIds: siteMatchId === null ? [] : [siteMatchId], providerMatchIds: [], fixtureIndexes: [index], detail: error.message });
      unmatched.push({ siteMatchId, reason: 'invalid_fixture', fixtureIndex: index });
    }
  });

  candidates.forEach((candidate, index) => {
    let providerMatchId = null;
    try {
      if (!plainObject(candidate)) throw new TypeError('candidate must be an object');
      providerMatchId = sourceId(candidate.providerMatchId);
      const parsed = {
        providerMatchId,
        homeName: requiredText(candidate.homeName, 'candidate.homeName'),
        awayName: requiredText(candidate.awayName, 'candidate.awayName'),
        kickoffUtc: exactInstant(candidate.kickoffUtc, 'candidate.kickoffUtc'),
        sourceUrl: requiredText(candidate.sourceUrl, 'candidate.sourceUrl'), index,
      };
      if (!/^https:\/\/www\.leisu\.com\/data\/zuqiu\/comp-[1-9][0-9]*$/.test(parsed.sourceUrl) || /\s/.test(parsed.sourceUrl)) throw new TypeError('candidate.sourceUrl must be an exact HTTPS Leisu competition page without query or fragment');
      if (parsed.homeName === parsed.awayName || translated(parsed.homeName) === translated(parsed.awayName)) throw new TypeError('candidate home and away names must remain distinct');
      validCandidates.push(parsed);
    } catch (error) {
      if (providerMatchId !== null) poisonedProviderIds.add(providerMatchId);
      conflicts.push({ reason: 'invalid_candidate', siteMatchIds: [], providerMatchIds: providerMatchId === null ? [] : [providerMatchId], candidateIndexes: [index], detail: error.message });
    }
  });

  const uniqueFixtures = [];
  for (const [siteMatchId, group] of groupBy(validFixtures, item => item.siteMatchId)) {
    const identities = new Set(group.map(item => identity(item.homeName, item.awayName, item.kickoffUtc)));
    if (identities.size !== 1) {
      conflicts.push({ reason: 'fixture_identity_conflict', siteMatchIds: [siteMatchId], providerMatchIds: [], fixtureIndexes: group.map(item => item.index) });
      unmatched.push({ siteMatchId, reason: 'fixture_identity_conflict' });
    } else uniqueFixtures.push(group[0]);
  }

  const uniqueCandidates = [];
  for (const [providerMatchId, group] of groupBy(validCandidates, item => item.providerMatchId)) {
    const identities = new Set(group.map(item => identity(item.homeName, item.awayName, item.kickoffUtc)));
    if (identities.size !== 1 || poisonedProviderIds.has(providerMatchId)) {
      conflicts.push({ reason: identities.size !== 1 ? 'provider_identity_conflict' : 'provider_has_invalid_record', siteMatchIds: [], providerMatchIds: [providerMatchId], candidateIndexes: group.map(item => item.index) });
    } else {
      // Exact duplicate records do not create false ambiguity. If the same
      // identity appears on multiple valid league pages, select deterministically.
      uniqueCandidates.push([...group].sort((a, b) => compareText(a.sourceUrl, b.sourceUrl))[0]);
    }
  }

  const candidatesByIdentity = groupBy(uniqueCandidates, item => identity(translated(item.homeName), translated(item.awayName), item.kickoffUtc));
  const edges = uniqueFixtures.map(fixture => ({ fixture, candidates: candidatesByIdentity.get(identity(fixture.homeName, fixture.awayName, fixture.kickoffUtc)) || [] }));
  const sitesByProvider = new Map();
  for (const edge of edges) for (const candidate of edge.candidates) {
    if (!sitesByProvider.has(candidate.providerMatchId)) sitesByProvider.set(candidate.providerMatchId, new Set());
    sitesByProvider.get(candidate.providerMatchId).add(edge.fixture.siteMatchId);
  }
  const reusedProviderIds = new Set();
  for (const [providerMatchId, sites] of sitesByProvider) if (sites.size > 1) {
    reusedProviderIds.add(providerMatchId);
    conflicts.push({ reason: 'one_source_multiple_fixtures', siteMatchIds: [...sites].sort(compareText), providerMatchIds: [providerMatchId] });
  }

  for (const edge of edges) {
    const { fixture } = edge;
    const providerMatchIds = edge.candidates.map(candidate => candidate.providerMatchId).sort(compareText);
    let reason = null;
    if (edge.candidates.length === 0) reason = 'no_exact_candidate';
    else if (edge.candidates.length > 1) {
      reason = 'multiple_exact_candidates';
      conflicts.push({ reason, siteMatchIds: [fixture.siteMatchId], providerMatchIds });
    } else if (reusedProviderIds.has(edge.candidates[0].providerMatchId)) reason = 'one_source_multiple_fixtures';
    if (reason) {
      unmatched.push({ siteMatchId: fixture.siteMatchId, homeName: fixture.homeName, awayName: fixture.awayName, kickoffUtc: fixture.kickoffUtc, reason });
      continue;
    }
    const candidate = edge.candidates[0];
    mappings.push({
      siteMatchId: fixture.siteMatchId,
      providerMatchId: candidate.providerMatchId,
      homeName: fixture.homeName,
      awayName: fixture.awayName,
      providerHomeName: candidate.homeName,
      providerAwayName: candidate.awayName,
      kickoffUtc: fixture.kickoffUtc,
      verifiedAt,
      verificationMethod: 'exact-team-names-and-kickoff',
      sourceUrl: candidate.sourceUrl,
    });
  }
  mappings.sort((a, b) => compareText(a.kickoffUtc, b.kickoffUtc) || compareText(a.siteMatchId, b.siteMatchId));
  return { mappings, unmatched, conflicts };
}

module.exports = { reconcileMappings };
