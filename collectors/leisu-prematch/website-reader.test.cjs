'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const scope = require('./scope.cjs');
const { createWebsiteReader, createWebsiteHandler } = require('./website-reader.cjs');

const NOW = '2026-09-12T13:40:00.000Z';
const ID = 'sporttery_123';
const addressPattern = /https?:\/\/|www\.|leisu\.com|audit-source\.example|192\.0\.2\.8|\/srv\/collector|C:\\private\\collector/i;
const row = (extra = {}) => ({
  id: ID, sourceMatchId: '123', homeTeamName: '主队', awayTeamName: '客队',
  kickoffTime: '2026-09-12T14:00:00.000Z', eventVersion: '2026-09-12T14:00:00.000Z',
  status: 'SCHEDULED', leagueName: '测试联赛', ...extra,
});

function sample(current = row()) {
  const fixture = scope.selectFixtures([current], NOW).selected[0];
  const base = {
    siteMatchId: fixture.siteMatchId, eventVersion: fixture.eventVersion, providerMatchId: '456',
    status: 'available', receivedAt: '2026-09-12T13:30:00.000Z',
    sourcePublishedAt: null, predictionEligible: false,
    observationId: 'internal-observation', taskKey: 'internal-task', contentHash: 'internal-hash',
    collectorPath: '/srv/collector/private.json',
  };
  const identity = { providerMatchId: '456', homeName: fixture.homeName, awayName: fixture.awayName,
    kickoffUtc: fixture.kickoffUtc, sourcePublishedAt: null };
  const injuries = {
    ...base, kind: 'injuries', sourceUrl: 'https://live.leisu.com/shujufenxi-456',
    data: { ...identity, injuries: [{ side: 'home', name: '球员甲', providerPlayerId: '789',
      reasonAsDisplayed: '膝关节受伤；归队时间未取得', positionAsDisplayed: '未知', returnDateAsDisplayed: '-',
      sourceUrl: 'https://live.leisu.com/player-789', privateNote: 'internal-player-note' }] },
  };
  const players = (side, size, offset = 0) => Array.from({ length: size }, (_, index) => ({
    id: String((side === 'home' ? 1000 : 2000) + offset + index),
    name: `${side === 'home' ? '主' : '客'}球员${offset + index + 1}`, jersey: String(offset + index + 1),
    providerPlayerId: `internal-player-${side}-${index}`, sourceUrl: 'https://audit-source.example/player',
  }));
  const lineup = {
    ...base, kind: 'lineup', sourceUrl: 'https://live.leisu.com/detail-456',
    data: { ...identity, teams: ['home', 'away'].map(side => ({
      side, name: side === 'home' ? fixture.homeName : fixture.awayName, formation: '4-2-3-1',
      coach: side === 'home' ? '主教练' : '客教练', providerTeamId: `internal-team-${side}`,
      starters: players(side, 11), substitutes: players(side, side === 'home' ? 2 : 1, 11),
    })) },
  };
  return { generatedAt: '2026-09-12T13:39:00.000Z', predictionEligible: false,
    exportPath: '/srv/collector/private.json', items: [{ fixture, evidence: {
      siteMatchId: fixture.siteMatchId, eventVersion: fixture.eventVersion, predictionEligible: false,
      sections: { injuries: { latestValid: injuries, latestAttempt: structuredClone(injuries) },
        lineup: { latestValid: lineup, latestAttempt: structuredClone(lineup) } },
    } }] };
}

async function temporaryExport(t, document = sample()) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'leisu-website-reader-test-'));
  t.after(async () => {
    // Delete only the unique directory created by this test.
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('leisu-website-reader-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const exportPath = path.join(directory, 'current-evidence.json');
  await fs.writeFile(exportPath, typeof document === 'string' ? document : JSON.stringify(document), 'utf8');
  return { directory, exportPath };
}

function trackOpens(t) {
  const open = fs.open.bind(fs), paths = [];
  t.mock.method(fs, 'open', async (...args) => { paths.push(args[0]); return open(...args); });
  return paths;
}

function response() {
  return { statusCode: null, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

const options = (exportPath, readFixture = async () => row()) => ({ exportPath, readFixture, now: () => NOW });
const keys = object => Object.keys(object).sort();
function assertNoEvidence(result) {
  assert.equal(result.predictionEligible, false);
  for (const section of Object.values(result.sections || {})) assert.equal(section.data, null);
}

test('real JSON export yields injuries and both starting/bench lineups through the public DTO', async t => {
  const document = sample(), { exportPath } = await temporaryExport(t, document);
  const fixtureCalls = [];
  const read = createWebsiteReader(options(exportPath, async id => { fixtureCalls.push(id); return row(); }));
  const result = await read(ID);
  assert.deepEqual(fixtureCalls, [ID]);
  assert.equal(result.status, 'ok');
  assert.equal(result.matchId, ID);
  assert.equal(result.eventVersion, row().eventVersion);
  assert.equal(result.updatedAt, document.generatedAt);
  assert.equal(result.predictionEligible, false);
  assert.deepEqual(result.sections.injuries.data.players, [{ side: 'home', name: '球员甲',
    reason: '膝关节受伤；归队时间未取得', position: '未知', expectedReturn: '-' }]);
  const teams = result.sections.lineup.data.teams;
  assert.deepEqual(teams.map(team => [team.side, team.starters.length, team.substitutes.length]), [['home', 11, 2], ['away', 11, 1]]);
  assert.equal(teams[0].formation, '4-2-3-1');
  assert.equal(teams[1].coach, '客教练');
  assert.deepEqual(teams[0].starters[0], { name: '主球员1', jersey: '1' });
  assert.equal(result.sections.injuries.observedAt, '2026-09-12T13:30:00.000Z');
  assert.equal(result.sections.injuries.previousValue, false);
  assert.deepEqual(JSON.parse(await fs.readFile(exportPath, 'utf8')), document);
});

test('public DTO excludes provider, player IDs, source URLs, paths and storage metadata', async t => {
  const { exportPath } = await temporaryExport(t);
  const result = await createWebsiteReader(options(exportPath))(ID);
  assert.deepEqual(keys(result), ['eventVersion', 'matchId', 'predictionEligible', 'sections', 'status', 'updatedAt']);
  assert.deepEqual(keys(result.sections.injuries), ['data', 'lastAttemptAt', 'observedAt', 'previousValue', 'status']);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /providerMatchId|providerPlayerId|providerTeamId|sourceUrl|sourcePublishedAt|observationId|contentHash|taskKey|exportPath|collectorPath|internal-/);
  assert.doesNotMatch(encoded, addressPattern);
  for (const team of result.sections.lineup.data.teams) {
    assert.deepEqual(keys(team), ['coach', 'formation', 'name', 'side', 'starters', 'substitutes']);
    for (const player of [...team.starters, ...team.substitutes]) assert.deepEqual(keys(player), ['jersey', 'name']);
  }
});

test('free text removes source addresses and paths while preserving SP and missing-data statements', async t => {
  const document = sample(), sections = document.items[0].evidence.sections;
  const message = '来源 https://audit-source.example/a；www.leisu.com；192.0.2.8:8080/a；/srv/collector/x.json；C:\\private\\collector\\x.json；SP 2.45；阵容未公布，归队时间未取得。';
  sections.injuries.latestValid.data.injuries[0].reasonAsDisplayed = message;
  sections.lineup.latestValid.data.teams[0].coach = '教练信息未取得；https://audit-source.example/coach';
  const { exportPath } = await temporaryExport(t, document);
  const result = await createWebsiteReader(options(exportPath))(ID);
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), addressPattern);
  const reason = result.sections.injuries.data.players[0].reason;
  assert.match(reason, /SP 2\.45/);
  assert.match(reason, /阵容未公布，归队时间未取得/);
  assert.match(result.sections.lineup.data.teams[0].coach, /教练信息未取得/);
});

test('UNC paths are removed as complete tokens without changing player names or SP', async t => {
  const document = sample(), { exportPath } = await temporaryExport(t, document);
  const read = createWebsiteReader(options(exportPath));
  for (const unc of [
    String.raw`\\collector-host\private\evidence.json`,
    String.raw`\\collector.internal\private$\evidence.json`,
    String.raw`\\192.0.2.8\private\evidence.json`,
    String.raw`\\采集主机\内部资料\伤停.json`,
    String.raw`"\\collector-host\Private Data\evidence file.json"`,
  ]) {
    const injury = document.items[0].evidence.sections.injuries.latestValid.data.injuries[0];
    injury.name = '若昂·佩德罗';
    injury.reasonAsDisplayed = `伤停未取得；${unc}；SP 2.45`;
    await fs.writeFile(exportPath, JSON.stringify(document));
    const result = await read(ID);
    assert.equal(result.status, 'ok');
    assert.equal(result.sections.injuries.data.players[0].name, '若昂·佩德罗');
    assert.equal(result.sections.injuries.data.players[0].reason, '伤停未取得；资料；SP 2.45');
  }
});

test('empty or omitted exportPath is disabled without reading a fixture or file', async t => {
  let fixtureCalls = 0;
  const opens = trackOpens(t);
  for (const exportPath of [undefined, null, '']) {
    const read = createWebsiteReader(options(exportPath, async () => { fixtureCalls++; throw new Error('must not read'); }));
    assert.deepEqual(await read(ID), { matchId: ID, status: 'disabled', predictionEligible: false });
  }
  assert.equal(fixtureCalls, 0);
  assert.deepEqual(opens, []);
});

test('stale, started, canceled and rescheduled evidence is filtered before public data exposure', async t => {
  const document = sample(), { exportPath } = await temporaryExport(t, document);
  let current = row();
  const read = createWebsiteReader(options(exportPath, async () => current));
  document.generatedAt = '2026-09-12T13:29:59.999Z';
  await fs.writeFile(exportPath, JSON.stringify(document));
  let result = await read(ID);
  assert.equal(result.status, 'stale');
  assertNoEvidence(result);
  await fs.writeFile(exportPath, JSON.stringify(sample()));
  for (const status of ['LIVE', 'FINISHED', 'CANCELED', 'POSTPONED']) {
    current = row({ status });
    result = await read(ID);
    assert.equal(result.status, 'ineligible');
    assertNoEvidence(result);
  }
  current = row();
  result = await createWebsiteReader({ ...options(exportPath), now: () => row().kickoffTime })(ID);
  assert.equal(result.status, 'ineligible');
  assertNoEvidence(result);
  current = row({ kickoffTime: '2026-09-12T15:00:00.000Z', eventVersion: '2026-09-12T15:00:00.000Z' });
  result = await read(ID);
  assert.equal(result.status, 'conflict');
  assertNoEvidence(result);
});

test('malformed, oversized and absent files return generic unavailable without configured paths', async t => {
  const { directory, exportPath } = await temporaryExport(t, '{"privatePath":"/srv/collector/secret"');
  const expected = { matchId: ID, status: 'unavailable', predictionEligible: false };
  assert.deepEqual(await createWebsiteReader(options(exportPath))(ID), expected);
  await fs.writeFile(exportPath, JSON.stringify(sample()));
  assert.deepEqual(await createWebsiteReader({ ...options(exportPath), maxBytes: 32 })(ID), expected);
  assert.deepEqual(await createWebsiteReader(options(path.join(directory, 'secret-absent.json')))(ID), expected);
  assert.deepEqual(await createWebsiteReader(options(directory))(ID), expected);
});

test('malformed nested lineup data cannot throw private errors through the reader', async t => {
  const document = sample();
  document.items[0].evidence.sections.lineup.latestValid.data.teams[0].starters = null;
  const { exportPath } = await temporaryExport(t, document);
  assert.deepEqual(await createWebsiteReader(options(exportPath))(ID), { matchId: ID, status: 'unavailable', predictionEligible: false });
});

test('authorization callback must be configured explicitly before a handler exists', () => {
  for (const authorize of [undefined, null, false, true, 'authorized']) {
    assert.throws(() => createWebsiteHandler({ ...options(undefined), authorize }), /explicit website authorization callback/);
  }
  assert.throws(() => createWebsiteHandler(), /explicit website authorization callback/);
});

test('denied, truthy-only and throwing authorization cannot read the fixture or export', async t => {
  const { exportPath } = await temporaryExport(t), opens = trackOpens(t);
  let fixtureCalls = 0;
  for (const authorize of [async () => false, async () => 'true', async () => { throw new Error(exportPath); }]) {
    const handler = createWebsiteHandler({ ...options(exportPath, async () => { fixtureCalls++; return row(); }), authorize });
    const res = response();
    await handler({ method: 'GET', url: '/api/prematch/sporttery_123' }, res, ID);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { status: 'unauthorized' });
  }
  assert.equal(fixtureCalls, 0);
  assert.deepEqual(opens, []);
});

test('authorized GET returns private JSON and HEAD returns the same status with no body', async t => {
  const { exportPath } = await temporaryExport(t), events = [];
  const handler = createWebsiteHandler({ ...options(exportPath, async id => { events.push(`fixture:${id}`); return row(); }),
    authorize: async req => { events.push(`authorize:${req.method}`); return true; } });
  for (const method of ['GET', 'HEAD']) {
    const res = response();
    await handler({ method, url: `/api/prematch/${ID}` }, res, ID);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'private, no-store');
    if (method === 'GET') assert.equal(JSON.parse(res.body).sections.lineup.data.teams.length, 2);
    else assert.equal(res.body, '');
  }
  assert.deepEqual(events, ['authorize:GET', `fixture:${ID}`, 'authorize:HEAD', `fixture:${ID}`]);
});

test('POST is rejected before authorization, fixture access or file access', async t => {
  const { exportPath } = await temporaryExport(t), opens = trackOpens(t);
  let authorizations = 0, fixtureCalls = 0;
  const handler = createWebsiteHandler({ ...options(exportPath, async () => { fixtureCalls++; return row(); }),
    authorize: async () => { authorizations++; return true; } });
  const res = response();
  await handler({ method: 'POST', url: '/api/prematch' }, res, ID);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(JSON.parse(res.body), { status: 'method-not-allowed' });
  assert.equal(authorizations, 0);
  assert.equal(fixtureCalls, 0);
  assert.deepEqual(opens, []);
});

test('invalid or traversal-shaped match IDs cannot become fixture calls or file paths', async t => {
  const { exportPath } = await temporaryExport(t), opens = trackOpens(t);
  let fixtureCalls = 0;
  const handler = createWebsiteHandler({ ...options(exportPath, async () => { fixtureCalls++; return row(); }), authorize: async () => true });
  for (const id of ['../secret.json', '/srv/collector/private.json', 'sporttery_123?file=secret.json',
    'sporttery_123/../../secret.json', 'sporttery_123\n', 'sporttery_0', '123']) {
    const res = response();
    await handler({ method: 'GET', url: `/api/prematch/${id}` }, res, id);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { status: 'invalid-id', predictionEligible: false });
  }
  assert.equal(fixtureCalls, 0);
  assert.deepEqual(opens, []);
});

test('request query and path never override the one configured export file', async t => {
  const { directory, exportPath } = await temporaryExport(t);
  const decoy = path.join(directory, `${ID}.json`);
  await fs.writeFile(decoy, '{"private":"must never read the per-ID decoy"}');
  const opens = trackOpens(t), fixtureCalls = [];
  const handler = createWebsiteHandler({ ...options(exportPath, async id => { fixtureCalls.push(id); return row(); }), authorize: async () => true });
  const res = response();
  await handler({ method: 'GET', url: `/api/prematch/../../secret?exportPath=${encodeURIComponent(decoy)}&matchId=sporttery_999`,
    query: { exportPath: decoy }, params: { path: decoy } }, res, ID);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'ok');
  assert.deepEqual(fixtureCalls, [ID]);
  assert.deepEqual(opens, [exportPath]);
});

test('missing or mismatched current fixtures return 404 without opening the export', async t => {
  const { exportPath } = await temporaryExport(t), opens = trackOpens(t);
  for (const current of [null, row({ id: 'sporttery_999' })]) {
    const handler = createWebsiteHandler({ ...options(exportPath, async () => current), authorize: async () => true });
    const res = response();
    await handler({ method: 'GET' }, res, ID);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { matchId: ID, status: 'missing', predictionEligible: false });
  }
  assert.deepEqual(opens, []);
});

test('fixture read failures are generic 503 responses without exception details', async t => {
  const { exportPath } = await temporaryExport(t), opens = trackOpens(t);
  const handler = createWebsiteHandler({ ...options(exportPath, async () => { throw new Error(`secret fixture store ${exportPath}`); }), authorize: async () => true });
  const res = response();
  await handler({ method: 'GET' }, res, ID);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { status: 'unavailable', predictionEligible: false });
  assert.deepEqual(opens, []);
});

test('a newer empty or failed attempt preserves old data with its actual observation time', async t => {
  const document = sample(), sections = document.items[0].evidence.sections;
  sections.injuries.latestAttempt = { ...sections.injuries.latestAttempt,
    status: 'source_empty', receivedAt: '2026-09-12T13:38:00.000Z', data: null };
  sections.lineup.latestAttempt = { ...sections.lineup.latestAttempt,
    status: 'parse_error', receivedAt: '2026-09-12T13:37:00.000Z', data: null };
  const { exportPath } = await temporaryExport(t, document);
  const result = await createWebsiteReader(options(exportPath))(ID);
  assert.equal(result.sections.injuries.status, 'source_empty');
  assert.equal(result.sections.injuries.observedAt, '2026-09-12T13:30:00.000Z');
  assert.equal(result.sections.injuries.lastAttemptAt, '2026-09-12T13:38:00.000Z');
  assert.equal(result.sections.injuries.previousValue, true);
  assert.equal(result.sections.injuries.data.players.length, 1);
  assert.equal(result.sections.lineup.status, 'parse_error');
  assert.equal(result.sections.lineup.previousValue, true);
  assert.equal(result.sections.lineup.data.teams.length, 2);
});

test('malformed side fields cannot leak addresses through otherwise valid public records', async t => {
  for (const kind of ['injuries', 'lineup']) {
    const document = sample(), data = document.items[0].evidence.sections[kind].latestValid.data;
    if (kind === 'injuries') data.injuries[0].side = 'https://audit-source.example/private';
    else data.teams[0].side = 'https://audit-source.example/private';
    const { exportPath } = await temporaryExport(t, document);
    const result = await createWebsiteReader(options(exportPath))(ID);
    assert.doesNotMatch(JSON.stringify(result), addressPattern);
    assert.ok(['unavailable', 'conflict'].includes(result.status));
    assertNoEvidence(result);
  }
});
