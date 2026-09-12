'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const KINDS = new Set(['injuries', 'lineup']);
const STATUSES = new Set(['available', 'source_empty', 'login_required', 'blocked', 'parse_error', 'conflict']);
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const META_KEYS = ['sync_meta_updated_at', 'data_generation_id', 'manifest_hash'];
const fail = message => { throw new Error(message); };
const plainObject = item => item !== null && typeof item === 'object' && !Array.isArray(item)
  && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
const text = (item, name) => {
  if (typeof item !== 'string' || !item.trim() || item.length > 4096) fail(`${name} must be a non-empty string`);
  return item;
};
const providerId = (item, name) => {
  const result = typeof item === 'number' && Number.isSafeInteger(item) ? String(item) : item;
  if (typeof result !== 'string' || !/^[1-9][0-9]*$/.test(result) || /\s/.test(result)) fail(`${name} must be a positive numeric provider ID`);
  return result;
};
const uuid = (item, name) => {
  if (typeof item !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) || /\s/.test(item)) fail(`${name} must be a UUID`);
  return item;
};
const timestamp = (item, name) => {
  if (item instanceof Date && !Number.isFinite(item.getTime())) fail(`${name} must be a valid date`);
  const raw = item instanceof Date ? item.toISOString() : item;
  if (typeof raw !== 'string') fail(`${name} must include a valid timezone`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match || match[0] !== raw) fail(`${name} must be a timezone-explicit ISO timestamp`);
  const [, yy, mo, dd, hh, mm, ss = '0', fraction = '', zone] = match;
  const year = Number(yy), month = Number(mo), day = Number(dd), hour = Number(hh), minute = Number(mm), second = Number(ss);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) fail(`${name} has invalid calendar components`);
  // Date.parse silently rolls invalid days into the next month. Validate the
  // wall-clock calendar before applying its explicitly supplied UTC offset.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0')));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) fail(`${name} has an invalid calendar date`);
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3)), offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) fail(`${name} has an invalid timezone offset`);
    offsetMinutes = (zone[0] === '+' ? 1 : -1) * (offsetHours * 60 + offsetRemainder);
  }
  return new Date(wall.getTime() - offsetMinutes * 60000).toISOString();
};
const canonical = item => {
  if (item === null || typeof item !== 'object') return JSON.stringify(item);
  if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']';
  return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}';
};

function createPool(connectionString) {
  text(connectionString, 'connectionString');
  // Let pg and the supplied connection string retain their TLS defaults. Never
  // turn off certificate validation or read credentials from the environment here.
  const { Pool } = require('pg');
  return new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000, query_timeout: 30000 });
}

async function transaction(pool, begin, work) {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
    throw error;
  } finally { client.release(); }
}

async function migrate(pool) {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await transaction(pool, 'BEGIN', client => client.query(sql));
}

async function startRun(pool) {
  const runId = randomUUID();
  await pool.query(`INSERT INTO leisu_prematch.runs (run_id, started_at, status)
    VALUES ($1, now(), 'running')`, [runId]);
  return runId;
}

async function finishRun(pool, runId, status) {
  uuid(runId, 'runId');
  if (typeof status !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(status) || status === 'running') fail('Invalid final run status');
  const result = await pool.query(`UPDATE leisu_prematch.runs
    SET ended_at = now(), status = $2
    WHERE run_id = $1 AND ended_at IS NULL
    RETURNING run_id, ended_at, status`, [runId, status]);
  if (result.rows.length !== 1) fail('Run is missing or already finished');
  return { runId: result.rows[0].run_id, endedAt: timestamp(result.rows[0].ended_at, 'endedAt'), status: result.rows[0].status };
}

function validatePlayer(player, seen) {
  if (!plainObject(player)) fail('Invalid lineup player');
  const id = providerId(player.id, 'player.id');
  text(player.name, 'player.name');
  const jersey = typeof player.jersey === 'number' ? String(player.jersey) : player.jersey;
  if (typeof jersey !== 'string' || !/^\d{1,3}$/.test(jersey)) fail('Player jersey must be a displayed number');
  if (seen.has(id)) fail('Duplicate player ID across lineup teams/groups');
  seen.add(id);
}

function validateAvailable(input, now) {
  const { fixture, data, kind, receivedAt, providerMatchId } = input;
  const kickoffUtc = timestamp(fixture.kickoffUtc, 'fixture.kickoffUtc');
  if (Date.parse(receivedAt) > now + FUTURE_TOLERANCE_MS) fail('available receivedAt is too far in the future');
  if (Date.parse(receivedAt) >= Date.parse(kickoffUtc) || now >= Date.parse(kickoffUtc)) fail('New available evidence after kickoff is rejected');
  if (!plainObject(data)) fail('Available evidence needs an object payload');
  if (providerId(data.providerMatchId, 'data.providerMatchId') !== providerMatchId) fail('Provider match ID conflict');
  // Match aliases must already have been explicitly resolved by the caller.
  if (data.homeName !== fixture.homeName || data.awayName !== fixture.awayName) fail('Fixture team name conflict');
  if (timestamp(data.kickoffUtc, 'data.kickoffUtc') !== kickoffUtc) fail('Fixture kickoff conflict');
  if (data.sourcePublishedAt !== null && data.sourcePublishedAt !== undefined) {
    const published = timestamp(data.sourcePublishedAt, 'data.sourcePublishedAt');
    if (Date.parse(published) > Date.parse(receivedAt)) fail('Source publication cannot follow receipt');
  }
  if (kind === 'injuries') {
    if (!Array.isArray(data.injuries) || data.injuries.length === 0) fail('Available injuries must be non-empty');
    const seen = new Set();
    for (const injury of data.injuries) {
      if (!plainObject(injury) || !['home', 'away'].includes(injury.side)) fail('Invalid injury team side');
      const id = providerId(injury.providerPlayerId, 'injury.providerPlayerId');
      text(injury.name, 'injury.name'); text(injury.reasonAsDisplayed, 'injury.reasonAsDisplayed');
      if (seen.has(id)) fail('Duplicate injury player ID');
      seen.add(id);
    }
  } else {
    if (!Array.isArray(data.teams) || data.teams.length !== 2) fail('Lineup requires exactly two teams');
    const sides = new Set(); const seen = new Set();
    for (const team of data.teams) {
      if (!plainObject(team) || !['home', 'away'].includes(team.side) || sides.has(team.side)) fail('Lineup team sides must be distinct');
      sides.add(team.side);
      if (team.name !== (team.side === 'home' ? fixture.homeName : fixture.awayName)) fail('Lineup team name conflict');
      if (!Array.isArray(team.starters) || team.starters.length !== 11) fail('Each lineup team needs exactly 11 starters');
      if (!Array.isArray(team.substitutes)) fail('Lineup substitutes must be an array');
      for (const player of [...team.starters, ...team.substitutes]) validatePlayer(player, seen);
    }
  }
}

function normalizeInput(input) {
  if (!plainObject(input) || !plainObject(input.fixture)) fail('Observation and fixture must be objects');
  const result = { ...input, fixture: { ...input.fixture } };
  uuid(result.runId, 'runId'); text(result.taskKey, 'taskKey');
  text(result.fixture.siteMatchId, 'fixture.siteMatchId'); text(result.fixture.eventVersion, 'fixture.eventVersion');
  if (!/^sporttery_\d+$/.test(result.fixture.siteMatchId) || /\s/.test(result.fixture.siteMatchId)) fail('fixture.siteMatchId must be sporttery_<numeric ID>');
  text(result.fixture.homeName, 'fixture.homeName'); text(result.fixture.awayName, 'fixture.awayName');
  if (result.fixture.homeName === result.fixture.awayName) fail('Home and away teams must differ');
  result.fixture.kickoffUtc = timestamp(result.fixture.kickoffUtc, 'fixture.kickoffUtc');
  if (timestamp(result.fixture.eventVersion, 'fixture.eventVersion') !== result.fixture.kickoffUtc) fail('fixture.eventVersion must identify the same kickoff instant');
  result.providerMatchId = providerId(result.providerMatchId, 'providerMatchId');
  if (!KINDS.has(result.kind)) fail('Unsupported observation kind');
  if (!STATUSES.has(result.status)) fail('Unsupported observation status');
  result.receivedAt = timestamp(result.receivedAt, 'receivedAt');
  const expectedSourceUrl = `https://live.leisu.com/${result.kind === 'injuries' ? 'shujufenxi' : 'detail'}-${result.providerMatchId}`;
  // Compare the supplied string, not a URL-normalized equivalent. This rejects
  // query/fragment suffixes, alternate hosts/ports, credentials, HTTP and encoded
  // or rewritten paths even if another layer accepted them.
  if (text(result.sourceUrl, 'sourceUrl') !== expectedSourceUrl) fail('sourceUrl must be the exact HTTPS Leisu page for this match and kind');
  if (result.status === 'available') {
    validateAvailable(result, Date.now());
    // Preserve only JSON-compatible data, normalizing an absent publication time
    // to null. No source time is invented from the local receipt time.
    result.data = JSON.parse(JSON.stringify({ ...result.data, sourcePublishedAt: result.data.sourcePublishedAt ?? null }));
  } else if (result.data !== null) fail('Non-available observations require data:null');
  return result;
}

async function saveObservation(pool, observation) {
  const input = normalizeInput(observation);
  const { runId, taskKey, fixture, providerMatchId, kind, receivedAt, sourceUrl, status, data } = input;
  const identity = [fixture.siteMatchId, fixture.eventVersion, kind];
  const hash = createHash('sha256').update(canonical({ identity, providerMatchId, sourceUrl, status, data, receivedAt })).digest('hex');
  return transaction(pool, 'BEGIN', async client => {
    // Serialize updates to one fixture/version/kind; observations remain append-only.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(identity)]);
    const run = await client.query('SELECT run_id FROM leisu_prematch.runs WHERE run_id = $1 AND ended_at IS NULL FOR SHARE', [runId]);
    if (run.rows.length !== 1) fail('Observation requires an active run');
    if (status === 'available') validateAvailable(input, Date.now());
    const observationId = randomUUID();
    const inserted = await client.query(`INSERT INTO leisu_prematch.observations
      (observation_id, run_id, site_match_id, event_version, provider_match_id, kind, task_key, received_at, source_url, status, payload, content_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (run_id, task_key, kind) DO NOTHING
      RETURNING observation_id`, [observationId, runId, fixture.siteMatchId, fixture.eventVersion, providerMatchId, kind, taskKey, receivedAt, sourceUrl, status, data === null ? null : JSON.stringify(data), hash]);
    if (!inserted.rows.length) {
      const previous = await client.query(`SELECT observation_id, content_hash FROM leisu_prematch.observations
        WHERE run_id=$1 AND task_key=$2 AND kind=$3`, [runId, taskKey, kind]);
      if (previous.rows.length !== 1 || previous.rows[0].content_hash !== hash) fail('Conflicting replay of run/task/kind');
      return { observationId: previous.rows[0].observation_id, status, receivedAt, latestUpdated: false, replayed: true, predictionEligible: false };
    }
    let latestUpdated = false;
    if (status === 'available') {
      const previous = await client.query(`SELECT o.received_at FROM leisu_prematch.latest_valid l
        JOIN leisu_prematch.observations o ON o.observation_id=l.observation_id
        WHERE l.site_match_id=$1 AND l.event_version=$2 AND l.kind=$3`, identity);
      if (!previous.rows.length || Date.parse(receivedAt) > Date.parse(previous.rows[0].received_at)) {
        await client.query(`INSERT INTO leisu_prematch.latest_valid (site_match_id,event_version,kind,observation_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT (site_match_id,event_version,kind)
          DO UPDATE SET observation_id=EXCLUDED.observation_id`, [...identity, observationId]);
        latestUpdated = true;
      }
    }
    return { observationId, status, receivedAt, latestUpdated, replayed: false, predictionEligible: false };
  });
}

const rowToObservation = row => row ? {
  observationId: row.observation_id, runId: row.run_id, siteMatchId: row.site_match_id,
  eventVersion: row.event_version, providerMatchId: row.provider_match_id, kind: row.kind,
  taskKey: row.task_key, receivedAt: timestamp(row.received_at, 'stored received_at'),
  sourceUrl: row.source_url, status: row.status, data: row.payload,
  contentHash: row.content_hash, sourcePublishedAt: row.payload?.sourcePublishedAt ?? null,
  predictionEligible: false,
} : null;

async function getAttempts(pool) {
  const result = await pool.query(`SELECT task_key, status, received_at FROM leisu_prematch.observations
    WHERE received_at >= now() - interval '3 days'
    ORDER BY received_at DESC, observation_id DESC`);
  return result.rows.map(row => ({ taskKey: row.task_key, status: row.status, receivedAt: timestamp(row.received_at, 'stored received_at') }));
}

async function getEvidence(pool, siteMatchId, eventVersion) {
  text(siteMatchId, 'siteMatchId'); text(eventVersion, 'eventVersion');
  return transaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async client => {
    const latest = await client.query(`SELECT o.* FROM leisu_prematch.latest_valid l
      JOIN leisu_prematch.observations o ON o.observation_id=l.observation_id
      WHERE l.site_match_id=$1 AND l.event_version=$2 AND o.status='available'`, [siteMatchId, eventVersion]);
    const attempts = await client.query(`SELECT DISTINCT ON (kind) * FROM leisu_prematch.observations
      WHERE site_match_id=$1 AND event_version=$2
      ORDER BY kind, received_at DESC, observation_id DESC`, [siteMatchId, eventVersion]);
    const sections = {};
    for (const kind of KINDS) sections[kind] = {
      latestValid: rowToObservation(latest.rows.find(row => row.kind === kind)),
      latestAttempt: rowToObservation(attempts.rows.find(row => row.kind === kind)),
    };
    return { siteMatchId, eventVersion, predictionEligible: false, sections };
  });
}

async function getEvidenceBatch(pool, fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length > 500) fail('fixtures must be an array of at most 500 identities');
  // Preserve the exact validated event-version text: it is a text identity in
  // storage, and existing observations may use an explicit offset instead of Z.
  const identities = Array.from(fixtures, fixture => {
    if (!plainObject(fixture)) fail('Each fixture identity must be an object');
    const siteMatchId = text(fixture.siteMatchId, 'siteMatchId');
    if (!/^sporttery_[1-9][0-9]*$/.test(siteMatchId) || /\s/.test(siteMatchId)) fail('siteMatchId must be a canonical positive Sporttery ID');
    const eventVersion = text(fixture.eventVersion, 'eventVersion');
    timestamp(eventVersion, 'eventVersion');
    return { siteMatchId, eventVersion };
  });
  if (!identities.length) return [];
  const identityKey = (siteMatchId, eventVersion) => JSON.stringify([siteMatchId, eventVersion]);
  const unique = new Map(identities.map(identity => [identityKey(identity.siteMatchId, identity.eventVersion), identity]));
  const requested = [...unique.values()];
  const parameters = [requested.map(identity => identity.siteMatchId), requested.map(identity => identity.eventVersion)];
  return transaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async client => {
    // Paired unnest prevents the cross-product bug from two independent ANY
    // predicates when one website match has multiple event versions.
    const latest = await client.query(`SELECT o.* FROM unnest($1::text[], $2::text[]) AS requested(site_match_id, event_version)
      JOIN leisu_prematch.latest_valid l
        ON l.site_match_id=requested.site_match_id AND l.event_version=requested.event_version
      JOIN leisu_prematch.observations o
        ON o.observation_id=l.observation_id AND o.site_match_id=l.site_match_id
          AND o.event_version=l.event_version AND o.kind=l.kind
      WHERE o.status='available'`, parameters);
    const attempts = await client.query(`SELECT DISTINCT ON (o.site_match_id, o.event_version, o.kind) o.*
      FROM unnest($1::text[], $2::text[]) AS requested(site_match_id, event_version)
      JOIN leisu_prematch.observations o
        ON o.site_match_id=requested.site_match_id AND o.event_version=requested.event_version
      ORDER BY o.site_match_id, o.event_version, o.kind, o.received_at DESC, o.observation_id DESC`, parameters);
    const results = new Map(requested.map(identity => [identityKey(identity.siteMatchId, identity.eventVersion), {
      ...identity, predictionEligible: false,
      sections: Object.fromEntries([...KINDS].map(kind => [kind, { latestValid: null, latestAttempt: null }])),
    }]));
    for (const [result, field] of [[latest, 'latestValid'], [attempts, 'latestAttempt']]) {
      if (!Array.isArray(result.rows)) fail('Invalid evidence query result');
      for (const row of result.rows) {
        const evidence = row && results.get(identityKey(row.site_match_id, row.event_version));
        if (!evidence || !KINDS.has(row.kind) || !STATUSES.has(row.status)
            || (field === 'latestValid' && row.status !== 'available')) fail('Evidence row escaped the requested identity or kind');
        if (evidence.sections[row.kind][field] !== null) fail('Duplicate evidence row for one identity and kind');
        evidence.sections[row.kind][field] = rowToObservation(row);
      }
    }
    // Repeated input identities still receive separate objects, in input order.
    return identities.map(identity => structuredClone(results.get(identityKey(identity.siteMatchId, identity.eventVersion))));
  });
}

async function readFixtureFeed(pool, maxAgeMinutes = 60) {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) fail('maxAgeMinutes must be positive');
  return transaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async client => {
    // Verified against server/postgresProjectionStore.cjs: projection_meta is
    // key/value/updated_at, not a table with three named metadata columns.
    const result = await client.query(`SELECT key, value, updated_at FROM football.projection_meta
      WHERE key = ANY($1::text[])`, [META_KEYS]);
    const meta = new Map(result.rows.map(row => [row.key, row.value]));
    for (const key of META_KEYS) text(meta.get(key), 'projection_meta.' + key);
    if (meta.get('manifest_hash').length !== 64 || !/^[0-9a-f]{64}$/i.test(meta.get('manifest_hash'))) fail('manifest_hash must be a 64-character SHA-256 hex digest');
    const generatedAt = timestamp(meta.get('sync_meta_updated_at'), 'sync_meta_updated_at');
    const age = Date.now() - Date.parse(generatedAt);
    if (age > maxAgeMinutes * 60000) fail('Fixture feed is stale');
    if (age < -FUTURE_TOLERANCE_MS) fail('Fixture feed time is too far in the future');
    const rows = await client.query(`SELECT payload FROM football.match_snapshots
      WHERE dataset = 'current' ORDER BY kickoff_time ASC, match_id ASC`);
    if (!Array.isArray(rows.rows)) fail('Fixture snapshot rows must be an array');
    const matches = rows.rows.map(row => {
      let payload = row.payload;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { fail('Fixture snapshot payload is not valid JSON'); } }
      if (!plainObject(payload)) fail('Fixture snapshot payload must be an object');
      return payload;
    });
    // Content-level eligibility belongs to scope.selectFixtures. One old or
    // incomplete fixture must not invalidate an otherwise fresh feed.
    return { generatedAt, generationId: meta.get('data_generation_id'), manifestHash: meta.get('manifest_hash'), matches };
  });
}

module.exports = { createPool, migrate, startRun, finishRun, saveObservation, getAttempts, getEvidence, getEvidenceBatch, readFixtureFeed };
