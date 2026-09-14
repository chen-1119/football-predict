'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { beijingDay, validDay, selectDay } = require('../collectors/leisu-prematch/local-jingcai-scope.cjs');
const contract = require('./sportteryEndpointContract.cjs');
const root = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const atomic = (file, value) => { fs.writeFileSync(file + '.next', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.next', file); };

function officialRoster(payload, days) {
  if (payload?.success !== true || !Array.isArray(payload.value?.matchInfoList)) throw Error('Official roster response unavailable');
  const rows = [];
  for (const group of payload.value.matchInfoList) {
    if (!Array.isArray(group.subMatchList)) throw Error('Official roster shape changed');
    for (const raw of group.subMatchList) {
      const day = raw.businessDate || group.businessDate;
      if (!validDay(day)) throw Error('Official betting day missing');
      if (!days.includes(day)) continue;
      if (raw.businessDate && group.businessDate && raw.businessDate !== group.businessDate) throw Error('Conflicting official betting day');
      const time = String(raw.matchTime || '');
      const kickoff = `${raw.matchDate}T${time.length === 5 ? time + ':00' : time}+08:00`;
      const row = { id: `sporttery_${raw.matchId}`, sourceMatchId: String(raw.matchId), businessDate: day,
        matchNo: raw.matchNumStr, leagueName: raw.leagueAllName || raw.leagueAbbName,
        homeTeamName: raw.homeTeamAllName, awayTeamName: raw.awayTeamAllName,
        homeTeamId: raw.homeTeamId, awayTeamId: raw.awayTeamId,
        kickoffTime: kickoff, eventVersion: kickoff,
        status: raw.matchStatus === 'Selling' ? 'SCHEDULED' : 'UNAVAILABLE' };
      rows.push(row);
    }
  }
  // Conflicting duplicates stay excluded by the existing official-day selector.
  return rows;
}

function dueMatches(matches, cache, attempts = {}, now = Date.now()) {
  const selected = [...new Set(matches.map(m => m.businessDate))].flatMap(day => selectDay(matches, day, now));
  const due = [];
  for (const fixture of selected.filter(x => x.eligible)) {
    const row = matches.find(m => m.id === fixture.siteMatchId);
    const id = row.id, map = cache.fixtureMap?.[id], state = cache.fixtureSignals?.[map?.fixtureId] || {};
    const elapsed = at => Number.isFinite(Date.parse(at)) ? now - Date.parse(at) : Infinity;
    if (elapsed(attempts[id]) < 25 * 60000) continue;
    if (!map?.fixtureId || Math.abs(Date.parse(map.fixtureDate) - Date.parse(row.kickoffTime)) > 60000) {
      if (elapsed(attempts[id]) >= 6 * 3600000) due.push(row);
      continue;
    }
    const until = Date.parse(row.kickoffTime) - now;
    if (elapsed(state.injuriesFetchedAt) >= 6 * 3600000
      || (until <= 60 * 60000 && elapsed(state.lineupsFetchedAt) >= 30 * 60000)) due.push(row);
  }
  // Near-kickoff matches get the bounded request budget first.
  return due.sort((a, b) => Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime));
}

async function fetchOfficial() {
  const response = await fetch(contract.SPORTTERY_CURRENT_URL, {
    headers: contract.sportteryRequestHeaders(contract.SPORTTERY_CURRENT_URL), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Official roster HTTP ' + response.status);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 4 * 1024 ** 2) throw Error('Official roster too large'); chunks.push(chunk); }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return { provider: 'sporttery', endpoint: contract.SPORTTERY_CURRENT_URL, httpStatus: response.status,
    receivedAt: new Date().toISOString(), payload, sha256: hash(payload), predictionEligible: false };
}

async function main() {
  const store = path.resolve(process.env.SERVER_STORE_DIR || path.join(root, 'server-data'));
  const dir = path.join(store, 'daily-prematch-api'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pool = require('../server/postgresStore.cjs').createPostgresPool({ max: 1, min: 0, applicationName: 'football-daily-prematch' });
  const client = await pool.connect(); let lock;
  try {
    const advisory = await client.query('SELECT pg_try_advisory_lock(68413922) AS acquired');
    if (!advisory.rows[0].acquired) { console.log(JSON.stringify({ state: 'already-running' })); return; }
    // DDL belongs to deployment, so a routine collection never needs migration privileges.
    if (process.argv.includes('--migrate')) { await client.query(fs.readFileSync(path.join(root, 'collectors/leisu-prematch/api-daily-schema.sql'), 'utf8')); console.log('Daily prematch tables ready in existing PostgreSQL'); return; }
    const now = Date.now(), startedAt = new Date(now).toISOString(), today = beijingDay(now);
    const last = read(path.join(dir, 'status.json'), {});
    if (last.nextAttemptAt && Date.parse(last.nextAttemptAt) > now) { console.log(JSON.stringify({ state: 'backoff', nextAttemptAt: last.nextAttemptAt })); return; }
    lock = await require('../server/syncLock.cjs').acquireSyncLock({ lockDir: path.join(store, 'locks/sync-enrichment-artifacts.lock'), owner: 'daily-prematch-api', source: 'scheduled-source-collection', waitMs: 5000 });
    if (!lock.acquired) { console.log(JSON.stringify({ state: 'writer-busy-retry-next-tick' })); return; }
    const runId = crypto.randomUUID(), job = path.join(dir, runId); fs.mkdirSync(job, { mode: 0o700 });
    const summary = { version: 'daily-prematch-api-v1', runId, provider: 'api-football', startedAt, businessDate: today, predictionEligible: false, state: 'running', newReceipts: 0 };
    let matches = [], reference = { version: 'api-football-prematch-reference-v1', provider: 'api-football', predictionEligible: false, generatedAt: startedAt, items: [] }, receipts = [];
    try {
      const official = await fetchOfficial(); receipts.push(official);
      // Previous-day rows are continuations of an already collected betting day,
      // never a fallback that labels tomorrow's/old fixtures as today's matches.
      const previous = await client.query('SELECT roster FROM football.prematch_source_runs ORDER BY completed_at DESC LIMIT 1');
      const carryDays = (previous.rows[0]?.roster || []).filter(m => m.businessDate < today && Date.parse(m.kickoffTime) > now).map(m => m.businessDate);
      const days = [...new Set([today, ...carryDays])];
      matches = officialRoster(official.payload, days);
      atomic(path.join(job, 'official.json'), official);
      const cacheFile = path.join(root, 'public/data/api-football-cache.json');
      const aliasVersion = require('./apiFootballScopedAliases.cjs').VERSION;
      summary.aliasVersion = aliasVersion;
      const before = read(cacheFile, {}), attempts = last.aliasVersion === aliasVersion ? read(path.join(dir, 'attempts.json'), {}) : {};
      const candidates = dueMatches(matches, before, attempts, now);
      const consumed = before.requestLedger?.date === startedAt.slice(0, 10) ? Number(before.requestLedger.count || 0) : 0;
      const budget = Math.max(0, Math.min(16, 90 - consumed));
      summary.businessDates = days; summary.matches = matches.length; summary.dueMatches = candidates.length;
      summary.rosterReceivedAt = official.receivedAt; summary.rosterSource = 'sporttery-current-api';
      summary.state = candidates.length ? (budget ? 'completed' : 'budget-exhausted') : 'no-due-tasks';
      if (candidates.length && budget) {
        atomic(path.join(job, 'matches.json'), candidates);
        // Reuse tested mapping, cutoff, account, cache and quota logic. Only
        // the reference export is published; model/external signals stay private.
        const result = spawnSync(process.execPath, ['scripts/syncApiFootballData.cjs'], { cwd: root, encoding: 'utf8', timeout: 360000, maxBuffer: 4 * 1024 ** 2,
          env: { ...process.env, ENABLE_API_FOOTBALL_SYNC: '1', API_FOOTBALL_SYNC_MODE: 'shadow-enrichment',
            API_FOOTBALL_LIVE_SCORE_ENABLED: '0', API_FOOTBALL_ODDS_ENABLED: '0', API_FOOTBALL_LOOKBACK_HOURS: '0',
            API_FOOTBALL_STATUS_REFRESH_MINUTES: '360', API_FOOTBALL_INJURY_REFRESH_MINUTES: '360',
            API_FOOTBALL_LINEUP_LOOKAHEAD_MINUTES: '60', API_FOOTBALL_LINEUP_REFRESH_MINUTES: '30',
            API_FOOTBALL_MAX_CALLS_PER_SYNC: String(budget), API_FOOTBALL_CACHE_FILE: cacheFile,
            API_FOOTBALL_CURRENT_MATCHES_FILE: path.join(job, 'matches.json'), API_FOOTBALL_FALLBACK_MATCHES_FILE: path.join(job, 'matches.json'),
            API_FOOTBALL_EXTERNAL_SIGNALS_FILE: path.join(job, 'external-signals.json'), API_FOOTBALL_META_FILE: path.join(job, 'meta.json'),
            API_FOOTBALL_REFERENCE_FILE: path.join(job, 'reference.json'), API_FOOTBALL_RECEIPTS_FILE: path.join(job, 'receipts.jsonl') } });
        fs.writeFileSync(path.join(job, 'collector.log'), (result.stdout || '') + '\n' + (result.stderr || ''), { mode: 0o600 });
        if (fs.existsSync(path.join(job, 'receipts.jsonl'))) receipts.push(...fs.readFileSync(path.join(job, 'receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
        const meta = read(path.join(job, 'meta.json'), {});
        summary.calls = meta.callsThisSync || 0; summary.accountEligible = meta.accountStatus?.eligible;
        summary.mappingBlockers = meta.entityEvidenceBlockers || {}; summary.mappedMatches = meta.mappedMatches || 0;
        for (const m of candidates) attempts[m.id] = startedAt;
        for (const [id, at] of Object.entries(attempts)) if (now - Date.parse(at) > 3 * 86400000) delete attempts[id];
        atomic(path.join(dir, 'attempts.json'), attempts);
        if (result.status !== 0 || meta.ok !== true) { summary.state = 'source-unavailable'; summary.nextAttemptAt = new Date(now + 3600000).toISOString(); }
      }
      const cache = read(cacheFile, {}), api = require('./syncApiFootballData.cjs');
      const registry = require('./entityResolutionRegistry.cjs').loadEntityRegistry(process.env.ENTITY_RESOLUTION_REGISTRY_FILE || path.join(store, 'entity-resolution/team-registry.json'));
      const verified = api.buildVerifiedMappingSet(matches, cache, registry);
      reference = require('../collectors/leisu-prematch/api-football-reference.cjs').buildReferenceExport(matches, cache, verified);
      summary.verifiedMappings = verified.size; summary.referenceMatches = reference.items.length;
      summary.injuryPlayers = reference.items.reduce((n, x) => n + (x.sections.injuries.data?.players.length || 0), 0);
      summary.newInjuryPlayers = reference.items.reduce((n, x) => n + (Date.parse(x.sections.injuries.observedAt) >= now ? x.sections.injuries.data?.players.length || 0 : 0), 0);
      summary.lineupTeams = reference.items.reduce((n, x) => n + (x.sections.lineup.data?.teams.length || 0), 0);
      summary.coverage = matches.map(m => { const item = reference.items.find(x => x.fixture.siteMatchId === m.id); return { id: m.id, businessDate: m.businessDate,
        home: m.homeTeamName, away: m.awayTeamName, kickoff: m.kickoffTime,
        mapped: verified.has(m.id), injuries: item?.sections.injuries.status || 'missing', lineup: item?.sections.lineup.status || (Date.parse(m.kickoffTime) - now > 3600000 ? 'not-due' : 'missing') }; });
      summary.dataComplete = matches.length > 0 && summary.coverage.every(m => m.injuries === 'available' && m.lineup === 'available');
      if (summary.state === 'completed' && summary.coverage.some(m => !m.mapped || m.injuries !== 'available' || m.lineup === 'missing')) summary.state = 'partial';
    } catch (error) {
      summary.state = 'runtime-error'; summary.errorCode = error.code || 'COLLECTION_FAILED';
      summary.nextAttemptAt = new Date(now + 3600000).toISOString();
      fs.writeFileSync(path.join(job, 'error.log'), String(error.stack || error), { mode: 0o600 });
    }
    summary.completedAt = new Date().toISOString(); summary.newReceipts = receipts.filter(r => r.provider === 'api-football').length;
    // Commit receipt bodies and the exact website reference together. A failure
    // never publishes a reference whose database transaction did not commit.
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO football.prematch_source_runs(run_id,started_at,completed_at,provider,summary,roster,reference) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, startedAt, summary.completedAt, 'api-football', summary, JSON.stringify(matches), reference]);
      for (const [i, r] of receipts.entries()) await client.query('INSERT INTO football.prematch_source_receipts(run_id,ordinal,provider,endpoint,received_at,payload_sha256,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, i, r.provider, r.endpoint, r.receivedAt, r.sha256, r]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    if (!['runtime-error', 'source-unavailable'].includes(summary.state)) atomic(path.join(store, 'api-football-prematch-evidence.json'), reference);
    atomic(path.join(dir, 'status.json'), summary);
    console.log(JSON.stringify(summary));
    if (['runtime-error', 'source-unavailable'].includes(summary.state)) process.exitCode = 1;
  } finally { if (lock?.acquired) await lock.release(); await client.query('SELECT pg_advisory_unlock(68413922)').catch(() => {}); client.release(); await pool.end(); }
}
module.exports = { officialRoster, dueMatches };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ state: 'failed', code: error.code || 'COLLECTION_FAILED' })); process.exitCode = 1; });
