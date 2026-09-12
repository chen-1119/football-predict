'use strict';

// Pure selection/scheduling only: no network, database, timers or production writes.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SITE_ID = /^sporttery_\d+$/;
const PROVIDER_ID = /^\d+$/;
const hasValue = value => value !== undefined && value !== null && value !== '';
const hasName = value => typeof value === 'string' && value.trim().length > 0;

// Require an explicit zone; never interpret a server-local/naive datetime.
function explicitInstant(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = '0'] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

function nowInstant(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime()
    : typeof now === 'number' ? now : explicitInstant(now);
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) {
    throw new TypeError('now must be a valid Date, epoch milliseconds or datetime with an explicit timezone');
  }
  return ms;
}

function windowFor(now = Date.now()) {
  const ms = nowInstant(now);
  const localDay = Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS);
  const startMs = localDay * DAY_MS - SHANGHAI_OFFSET_MS;
  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(startMs + 2 * DAY_MS).toISOString();
  return {
    timeZone: 'Asia/Shanghai',
    nowUtc: new Date(ms).toISOString(),
    today: new Date(startMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10),
    tomorrow: new Date(startMs + SHANGHAI_OFFSET_MS + DAY_MS).toISOString().slice(0, 10),
    startUtc, endUtc, startIso: startUtc, endIso: endUtc,
  };
}

function status(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function duplicateSignature(row) {
  const canonicalTime = value => {
    const ms = explicitInstant(value);
    return ms === null ? value ?? null : new Date(ms).toISOString();
  };
  return JSON.stringify([
    row.sourceMatchId ?? null, row.homeTeamName ?? null, row.awayTeamName ?? null,
    canonicalTime(row.kickoffTime), canonicalTime(row.eventVersion || row.kickoffTime),
    row.leagueName ?? null, row.businessDate ?? null,
    status(row.status), status(row.sourceStatus), status(row.effectiveStatus),
  ]);
}

function selectFixtures(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const window = windowFor(now);
  const nowMs = Date.parse(window.nowUtc);
  const startMs = Date.parse(window.startUtc), endMs = Date.parse(window.endUtc);
  const selected = [], excluded = [], groups = new Map();
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || !SITE_ID.test(id)) {
      excluded.push({ siteMatchId: typeof id === 'string' ? id : null, reason: 'invalid-site-match-id' });
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  for (const [siteMatchId, group] of groups) {
    const reject = reason => excluded.push({ siteMatchId, reason });
    if (new Set(group.map(duplicateSignature)).size > 1) {
      reject('conflicting-duplicate-id');
      continue;
    }
    const row = group[0];
    const sourceMatchId = hasValue(row.sourceMatchId) ? String(row.sourceMatchId) : '';
    if (!PROVIDER_ID.test(sourceMatchId) || siteMatchId !== `sporttery_${sourceMatchId}`) {
      reject('source-match-id-mismatch'); continue;
    }
    if (!hasName(row.homeTeamName) || !hasName(row.awayTeamName)
        || row.homeTeamName === row.awayTeamName) {
      reject('invalid-teams'); continue;
    }
    // A missing optional status is allowed; a conflicting/unknown present status is not.
    const primaryStatuses = [row.status, row.effectiveStatus].filter(hasValue);
    const allStatuses = [...primaryStatuses, ...[row.sourceStatus].filter(hasValue)];
    if (!primaryStatuses.length || allStatuses.some(value => status(value) !== 'SCHEDULED')) {
      reject('not-scheduled'); continue;
    }
    const kickoffMs = explicitInstant(row.kickoffTime);
    if (kickoffMs === null) { reject('invalid-kickoff-timezone-or-date'); continue; }
    if (kickoffMs <= nowMs) { reject('kickoff-not-in-future'); continue; }
    if (kickoffMs < startMs || kickoffMs >= endMs) { reject('outside-today-tomorrow'); continue; }
    const eventMs = hasValue(row.eventVersion) ? explicitInstant(row.eventVersion) : kickoffMs;
    if (eventMs === null || eventMs !== kickoffMs) { reject('event-version-mismatch'); continue; }
    selected.push({
      siteMatchId, sourceMatchId,
      homeName: row.homeTeamName, awayName: row.awayTeamName,
      kickoffUtc: new Date(kickoffMs).toISOString(),
      eventVersion: new Date(eventMs).toISOString(),
      league: hasName(row.leagueName) ? row.leagueName : null,
      businessDate: row.businessDate ?? null,
    });
  }
  selected.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc) || a.siteMatchId.localeCompare(b.siteMatchId));
  return { window, selected, excluded };
}

function mappingSignature(mapping) {
  const kickoffMs = explicitInstant(mapping?.kickoffUtc);
  return JSON.stringify([
    mapping?.providerMatchId ?? null, mapping?.homeName ?? null, mapping?.awayName ?? null,
    kickoffMs === null ? mapping?.kickoffUtc ?? null : new Date(kickoffMs).toISOString(),
    mapping?.providerHomeName === undefined ? mapping?.homeName ?? null : mapping.providerHomeName,
    mapping?.providerAwayName === undefined ? mapping?.awayName ?? null : mapping.providerAwayName,
  ]);
}

function buildTasks(selected, mappings, attempts, now = Date.now()) {
  if (![selected, mappings, attempts].every(Array.isArray)) {
    throw new TypeError('selected, mappings and attempts must be arrays');
  }
  const nowMs = nowInstant(now), tasks = [], skipped = [];
  const window = windowFor(nowMs), startMs = Date.parse(window.startUtc), endMs = Date.parse(window.endUtc);
  const attemptedKeys = new Set(attempts.map(attempt => attempt?.taskKey).filter(key => typeof key === 'string'));
  const mappingsBySite = new Map(), sitesByProvider = new Map(), selectedBySite = new Map();
  for (const fixture of selected) {
    if (!selectedBySite.has(fixture?.siteMatchId)) selectedBySite.set(fixture?.siteMatchId, []);
    selectedBySite.get(fixture?.siteMatchId).push(fixture);
  }
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object') continue;
    if (!mappingsBySite.has(mapping.siteMatchId)) mappingsBySite.set(mapping.siteMatchId, []);
    mappingsBySite.get(mapping.siteMatchId).push(mapping);
    if (typeof mapping.providerMatchId === 'string' && PROVIDER_ID.test(mapping.providerMatchId)) {
      if (!sitesByProvider.has(mapping.providerMatchId)) sitesByProvider.set(mapping.providerMatchId, new Set());
      sitesByProvider.get(mapping.providerMatchId).add(mapping.siteMatchId);
    }
  }
  for (const [siteMatchId, fixtureRows] of selectedBySite) {
    const skip = (reason, extra = {}) => skipped.push({ siteMatchId: siteMatchId ?? null, reason, ...extra });
    if (new Set(fixtureRows.map(fixture => JSON.stringify(fixture))).size > 1) {
      skip('conflicting-selected-id'); continue;
    }
    const fixture = fixtureRows[0];
    if (!fixture || typeof siteMatchId !== 'string' || !SITE_ID.test(siteMatchId)
        || siteMatchId !== `sporttery_${fixture.sourceMatchId}`
        || !hasName(fixture.homeName) || !hasName(fixture.awayName) || fixture.homeName === fixture.awayName) {
      skip('invalid-selected-fixture'); continue;
    }
    const kickoffMs = explicitInstant(fixture.kickoffUtc), eventMs = explicitInstant(fixture.eventVersion);
    if (kickoffMs === null || eventMs !== kickoffMs) { skip('invalid-selected-event'); continue; }
    if (kickoffMs <= nowMs) { skip('kickoff-not-in-future'); continue; }
    if (kickoffMs < startMs || kickoffMs >= endMs) { skip('outside-today-tomorrow'); continue; }
    const candidates = mappingsBySite.get(siteMatchId) || [];
    if (!candidates.length) { skip('unmapped'); continue; }
    if (new Set(candidates.map(mappingSignature)).size !== 1) { skip('ambiguous-mapping'); continue; }
    const mapping = candidates[0];
    if (typeof mapping.providerMatchId !== 'string' || !PROVIDER_ID.test(mapping.providerMatchId)) {
      skip('invalid-provider-match-id'); continue;
    }
    if (sitesByProvider.get(mapping.providerMatchId)?.size !== 1) { skip('provider-mapped-to-multiple-sites'); continue; }
    if (candidates.some(candidate => {
      const verifiedMs = explicitInstant(candidate.verifiedAt);
      return verifiedMs === null || verifiedMs > nowMs;
    })) { skip('mapping-not-verified'); continue; }
    if (mapping.homeName !== fixture.homeName || mapping.awayName !== fixture.awayName) {
      skip('mapping-team-mismatch'); continue;
    }
    // These are explicit, manually checked provider names, never inferred aliases.
    const providerHomeName = mapping.providerHomeName === undefined ? fixture.homeName : mapping.providerHomeName;
    const providerAwayName = mapping.providerAwayName === undefined ? fixture.awayName : mapping.providerAwayName;
    if (!hasName(providerHomeName) || !hasName(providerAwayName) || providerHomeName === providerAwayName) {
      skip('invalid-provider-team-names'); continue;
    }
    if (explicitInstant(mapping.kickoffUtc) !== kickoffMs) { skip('mapping-kickoff-mismatch'); continue; }
    const kickoffUtc = new Date(kickoffMs).toISOString();
    const version = new Date(eventMs).toISOString();
    const taskKeyFor = (kind, slot) => `${siteMatchId}|kickoff=${kickoffUtc}|event=${version}|${kind}|${slot}`;
    const schedule = (kind, slot) => {
      const taskKey = taskKeyFor(kind, slot);
      if (attemptedKeys.has(taskKey)) { skip('already-attempted', { kind, taskKey }); return; }
      tasks.push({ fixture, providerMatchId: mapping.providerMatchId, providerHomeName, providerAwayName, kind,
        sourceUrl: `https://live.leisu.com/${kind === 'injuries' ? 'shujufenxi' : 'detail'}-${mapping.providerMatchId}`,
        taskKey });
    };
    const bucketStartMs = Math.floor((nowMs + SHANGHAI_OFFSET_MS) / SIX_HOURS_MS) * SIX_HOURS_MS - SHANGHAI_OFFSET_MS;
    schedule('injuries', `bucket=${new Date(bucketStartMs).toISOString()}`);
    const minutesToKickoff = (kickoffMs - nowMs) / 60000;
    if (minutesToKickoff <= 90) {
      // Follow-ups belong to this exact fixture/event and require a real empty
      // stage-30 result. Earlier available XIs never cancel the normal checks.
      const stage30Key = taskKeyFor('lineup', 'stage=30');
      const stage30Attempts = attempts.filter(attempt => attempt?.taskKey === stage30Key);
      const needsFollowUp = stage30Attempts.some(attempt => attempt.status === 'source_empty')
        && !stage30Attempts.some(attempt => attempt.status === 'available');
      if (minutesToKickoff <= 20 && needsFollowUp) {
        const stage20Key = taskKeyFor('lineup', 'stage=20');
        if (attempts.some(attempt => attempt?.taskKey === stage20Key && attempt.status === 'available')) {
          skip('lineup-follow-up-satisfied', { kind: 'lineup' });
        } else {
          // Only the latest due slot runs; missed stages are not caught up.
          schedule('lineup', `stage=${minutesToKickoff <= 10 ? 10 : 20}`);
        }
      } else {
        schedule('lineup', `stage=${minutesToKickoff <= 30 ? 30 : minutesToKickoff <= 60 ? 60 : 90}`);
      }
    } else {
      skip('lineup-window-not-open', { kind: 'lineup' });
    }
  }
  return { tasks, skipped };
}

module.exports = { windowFor, selectFixtures, buildTasks };
