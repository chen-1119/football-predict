'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('../scripts/teamEvidenceSources.cjs');
const store = require('../scripts/teamEvidenceStore.cjs');
const {loadPrematchTeamEvidence} = require('../scripts/loadPrematchTeamEvidence.cjs');
const {buildStoredTeamResearch, researchForMatch} = require('../src/services/teamEvidencePrematchBridge.cjs');
const {attachProspectiveForecastInputs} = require('../src/services/prospectiveForecastInput.cjs');
const {derivedTeamId} = require('../scripts/storedResultTeamIdentity.cjs');
const fs = require('node:fs');
const vm = require('node:vm');

const asOf = '2026-09-17T10:00:10.000Z';
function fixture() {
  const match = {id: 'sporttery_1', sourceMatchId: '1', businessDate: '2026-09-17', status: 'SCHEDULED',
    isOnSale: true, saleStatus: 'SELLING', leagueName: '韩国职业联赛', leagueId: 'kr1',
    homeTeamName: '首尔FC', awayTeamName: '济州SK', homeTeamId: derivedTeamId('首尔FC'), awayTeamId: derivedTeamId('济州SK'),
    kickoffTime: '2026-09-17T15:00:00.000Z', eventVersion: '2026-09-17T15:00:00.000Z',
    cutoffAt: '2026-09-17T14:00:00.000Z', buyEndTime: '2026-09-17 22:00:00',
    oddsSource: 'sporttery:HAD', oddsReceivedAt: '2026-09-17T09:59:00.000Z', oddsObservedAt: '2026-09-17T09:59:00.000Z',
    odds: {odds1: 1.8, oddsX: 3.2, odds2: 4.5},
    probabilityModel: {generatedAt: '2026-09-17T10:00:00.000Z', oneXTwo: {final: {home: 60, draw: 25, away: 15}}}};
  const plans = source.plans([match], asOf);
  const standings = {resultCode: '200', data: {teamRank: [
    {year: 2026, teamId: 'K09', rank: 1, gainPoint: 60, gameCount: 30},
    {year: 2026, teamId: 'K04', rank: 8, gainPoint: 30, gameCount: 30}]}};
  const schedule = {resultCode: '200', data: {scheduleList: [
    {year: 2026, leagueId: 1, gameId: 1, gameDate: '2026.09.18', gameTime: '00:00', homeTeam: 'K09', awayTeam: 'K04', endYn: 'N', gameStatus: '', homeGoal: 0, awayGoal: 0},
    {year: 2026, leagueId: 1, gameId: 2, gameDate: '2026.09.10', gameTime: '19:00', homeTeam: 'K09', awayTeam: 'K04', endYn: 'Y', gameStatus: 'FE', homeGoal: 1, awayGoal: 0}]}};
  const response = value => {
    const raw = JSON.stringify(value);
    return {raw, bytes: Buffer.byteLength(raw), rawSha256: source.sha(raw), status: 200,
      requestedAt: '2026-09-17T09:58:59.000Z', receivedAt: '2026-09-17T09:59:00.000Z'};
  };
  const packets = [source.pack(plans.find(p => p.kind === 'standings'), response(standings)),
    source.pack(plans.find(p => p.month === '09'), response(schedule))];
  return {match, plans, packets, schedule, response};
}
function database() {
  let rows = new Map(), pending = null, tick = Date.parse('2026-09-17T10:00:00.000Z');
  const log = [], failures = new Set();
  const client = {release() {}, async query(sql, args = []) {
    log.push(sql);
    if (failures.has(sql)) throw Error('fixture database error with private details');
    if (sql.startsWith('BEGIN')) { pending = new Map(rows); return {rows: []}; }
    if (sql === 'COMMIT') { rows = pending; pending = null; return {rows: []}; }
    if (sql === 'ROLLBACK') { pending = null; return {rows: []}; }
    if (sql.startsWith('SET ') || sql.includes('advisory')) return {rows: []};
    if (sql.includes('clock_timestamp')) return {rows: [{now: new Date(++tick)}]};
    const current = pending || rows;
    if (sql.startsWith('INSERT INTO football.private_model_artifacts')) {
      const [key, version, generated, updated, json, sha, bytes] = args;
      current.set(key, {artifact_key: key, artifact_version: version, generated_at: generated, updated_at: updated,
        payload_json: json, payload_sha256: sha, payload_bytes: bytes});
      return {rows: []};
    }
    if (sql.includes('WHERE artifact_key=$1')) return {rows: current.has(args[0]) ? [current.get(args[0])] : []};
    throw Error('unexpected SQL: ' + sql);
  }};
  return {pool: {connect: async () => client}, rows: () => rows, log, failures};
}
async function savedFixture() {
  const f = fixture(), db = database();
  for (const packet of f.packets) await store.save(db.pool, packet);
  db.log.length = 0;
  const loaded = await loadPrematchTeamEvidence({matches: [f.match], asOf, pool: db.pool});
  return {...f, db, loaded};
}

test('native stored packets become same-event research with source hashes, standings, H2H and honest sample coverage', async () => {
  const f = await savedFixture(), receipt = researchForMatch(f.match, f.loaded, asOf);
  assert.equal(f.loaded.status, 'read'); assert.equal(f.loaded.receipts.filter(r => r.status === 'read').length, 2);
  assert.equal(receipt.verification, 'official-single-source'); assert.equal(receipt.secondIndependentSourceVerified, false);
  assert.equal(receipt.historyCoverage.home.count, 1); assert.equal(receipt.historyCoverage.home.target, 5);
  assert.equal(receipt.historyCoverage.home.completeRecentScheduleVerified, false);
  assert.ok(receipt.missing.includes('home-history-less-than-five')); assert.equal(receipt.standings[0].points, 60);
  assert.deepEqual(receipt.headToHead.rows[0].score, [1, 0]); assert.equal(receipt.headToHead.completeHistoryVerified, false);
  assert.equal(receipt.teamHistory[1].data.rows[0].goalsFor, 0); assert.equal(receipt.teamHistory[1].data.rows[0].goalsAgainst, 1);
  assert.equal(receipt.numericModelInputAdmitted, false); assert.equal(receipt.probabilityFactorsApplied, false);
  assert.ok(f.db.log.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(f.db.log.some(sql => /^(INSERT|UPDATE|DELETE)|pg_advisory/.test(sql)), false);
});

test('actual prospective input carries the new research while the frozen parent and V3 numeric features stay unchanged', async () => {
  const f = await savedFixture(), frozen = {...f.match, probabilityModel: {...f.match.probabilityModel, generatedAt: '2026-09-16T01:00:00Z'}};
  const original = structuredClone(frozen);
  const [without] = attachProspectiveForecastInputs([frozen], [f.match], Date.parse(asOf));
  const [withResearch] = attachProspectiveForecastInputs([frozen], [f.match], Date.parse(asOf), {storedTeamEvidence: f.loaded});
  assert.deepEqual(frozen, original); assert.deepEqual(withResearch.probabilityModel, original.probabilityModel);
  assert.ok(withResearch.prospectiveForecastInput.storedTeamEvidenceResearch);
  assert.deepEqual(withResearch.prospectiveForecastInput.prematchV3Assessment, without.prospectiveForecastInput.prematchV3Assessment);
  assert.equal(withResearch.prospectiveForecastInput.prematchV3Assessment.primary, null);
  assert.ok(withResearch.prospectiveForecastInput.prematchV3Assessment.blockers.includes('v3-source-contract-missing'));
});

test('stale, future, tampered packet or missing standings never becomes research input', () => {
  const f = fixture();
  for (const packets of [[f.packets[1]], [{...f.packets[0], createdAt: '2027-01-01T00:00:00Z'}, f.packets[1]],
    [{...f.packets[0], response: {...f.packets[0].response, raw: f.packets[0].response.raw + ' '}}, f.packets[1]]]) {
    assert.equal(buildStoredTeamResearch(f.match, packets, asOf).status, 'blocked');
  }
  assert.equal(buildStoredTeamResearch(f.match, f.packets, '2026-09-17T16:00:00Z').status, 'blocked');
});

test('closed, live, wrong ordered teams and changed event identity reject attachment', async () => {
  const f = await savedFixture();
  for (const change of [{isOnSale: false}, {status: 'LIVE'}, {saleStatus: 'SUSPENDED'},
    {homeTeamId: f.match.awayTeamId}, {homeTeamName: '全北现代'}, {resultDisposition: 'VOID'},
    {eventVersion: '2026-09-17T16:00:00Z'}, {cutoffAt: '2026-09-17T09:00:00Z'}]) {
    assert.equal(researchForMatch({...f.match, ...change}, f.loaded, asOf), null);
  }
  assert.equal(researchForMatch(f.match, {...f.loaded, events: [...f.loaded.events, ...f.loaded.events]}, asOf), null);
  assert.equal(researchForMatch(f.match, {...f.loaded, storage: 'sqlite'}, asOf), null);
});

test('the real current-feed shape with unknown sale status remains research and never grants sale clearance', async () => {
  const f = await savedFixture();
  const match = {...f.match, isOnSale: undefined};
  const receipt = researchForMatch(match, f.loaded, asOf);
  assert.ok(receipt); assert.equal(receipt.saleVerification.isOnSale, null);
  assert.equal(receipt.saleVerification.publicationAllowed, false);
  assert.equal(receipt.numericModelInputAdmitted, false);
});

test('future default zeros and unfinished games cannot enter form or H2H', () => {
  const f = fixture(), schedule = structuredClone(f.schedule);
  schedule.data.scheduleList[1].endYn = 'N'; schedule.data.scheduleList[1].gameStatus = '';
  const packet = source.pack(f.packets[1].plan, f.response(schedule));
  const result = buildStoredTeamResearch(f.match, [f.packets[0], packet], asOf);
  assert.equal(result.status, 'history-unavailable'); assert.equal(result.receipt.headToHead.rows.length, 0);
  assert.equal(result.receipt.historyCoverage.home.count, 0);
});

test('read transaction failure, rollback failure and corrupt persisted raw bytes cannot leave usable events', async () => {
  for (const failure of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']) {
    const f = await savedFixture(); f.db.failures.add(failure);
    const loaded = await loadPrematchTeamEvidence({matches: [f.match], asOf, pool: f.db.pool});
    assert.equal(loaded.status, 'blocked'); assert.deepEqual(loaded.events, []);
    assert.equal(JSON.stringify(loaded).includes('private details'), false);
  }
  const f = await savedFixture();
  const raw = f.db.rows().get('team-evidence-body-' + f.packets[0].response.rawSha256); raw.payload_json += ' ';
  const loaded = await loadPrematchTeamEvidence({matches: [f.match], asOf, pool: f.db.pool});
  assert.equal(researchForMatch(f.match, loaded, asOf), null);
});

test('head availability precision and expired packets are checked before any attachment', async () => {
  const f = await savedFixture();
  const loaded = await loadPrematchTeamEvidence({matches: [f.match], asOf: '2026-09-17T10:00:00.001001Z', pool: f.db.pool});
  assert.equal(loaded.receipts.filter(r => r.status === 'read').length, 0);
  const late = await loadPrematchTeamEvidence({matches: [f.match], asOf: '2026-09-17T16:00:00Z', pool: f.db.pool});
  assert.deepEqual(late.events, []);
});

test('unsupported leagues do not create a pool or read an unrelated source', async () => {
  const f = fixture(); let connected = false;
  const loaded = await loadPrematchTeamEvidence({matches: [{...f.match, leagueName: '瑞典超级联赛'}], asOf,
    pool: {connect() { connected = true; throw Error('must not connect'); }}});
  assert.equal(connected, false); assert.equal(loaded.status, 'no-supported-events');
});

async function actualOfficialPrefix({enabled = true, outcome = {ok: true}} = {}) {
  const text = fs.readFileSync(require.resolve('../scripts/runSyncWorker.cjs'), 'utf8');
  const start = text.indexOf('    const officialPhaseStartedAt = new Date().toISOString();');
  const end = text.indexOf('    // These two stages are local deterministic projections', start);
  assert.ok(start > 0 && end > start, 'actual official prefix must remain before sync rebuild');
  const calls = [];
  const result = await vm.runInNewContext('(async()=>{' + text.slice(start, end)
    + ';return {officialTeamEvidenceStep,officialSyncStep};})()', {
    Date, storageMode: {postgresOnly: true}, process: {env: {ENABLE_TEAM_EVIDENCE_SYNC: enabled ? '1' : '0'}},
    commandTimeouts: {enrichment: 300000, sync: 600000}, cadence: {workflowMinutes: 5},
    onBeforeHeavyStep: async name => calls.push(['before', name]),
    runOptional: async (on, name, env, options) => {
      calls.push(['optional', on, name, options.fatal, options.timeoutMs]);
      return on ? outcome : {ok: true, skipped: true};
    },
    runCommand: async (name, args, env, options) => {
      calls.push(['command', name, [...args], options.timeoutMs]); return {ok: true};
    },
  });
  return {calls, result};
}

test('the actual official phase collects once before syncData without the background model artifact permit', async () => {
  const {calls} = await actualOfficialPrefix();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['before', 'sync:team-evidence'], ['optional', true, 'sync:team-evidence', false, 300000],
    ['before', 'sync:data'], ['command', 'node', ['scripts/syncData.cjs'], 600000],
  ]);
  const worker = fs.readFileSync(require.resolve('../scripts/runSyncWorker.cjs'), 'utf8');
  assert.doesNotMatch(worker, /runEnrichment\([^\n]*"sync:team-evidence"/);
});

test('a known optional collector failure or already-running collector does not abort official sync', async () => {
  for (const outcome of [{ok: false, errorCode: 'TEAM_EVIDENCE_SOURCE_FAILED'},
    {ok: true, skipped: true, reason: 'collector-running'}]) {
    const {calls, result} = await actualOfficialPrefix({outcome});
    assert.equal(result.officialTeamEvidenceStep, outcome); assert.equal(result.officialSyncStep.ok, true);
    assert.equal(calls.filter(row => row[0] === 'command').length, 1);
  }
});

test('disabled supplementary collection still runs the unchanged official rebuild', async () => {
  const {calls, result} = await actualOfficialPrefix({enabled: false});
  assert.equal(result.officialTeamEvidenceStep.skipped, true);
  assert.equal(calls.some(row => row[0] === 'before' && row[1] === 'sync:team-evidence'), false);
  assert.equal(result.officialSyncStep.ok, true);
});
