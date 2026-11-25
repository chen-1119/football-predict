'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const collector = require('../scripts/collectFootballDataOrgResearch.cjs');
const { teamHistory } = require('../scripts/footballDataOrgNeutralView.cjs');
const mapping = require('../scripts/neutralSportsTeamMap.cjs');
const STORE = '/var/lib/football-data-org';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readFile(file, maximum = 8 * 1024 * 1024) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw Error('UNSAFE_SOURCE');
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw Error('SOURCE_CHANGED');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function verified(file, expected) {
  const bytes = readFile(file);
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha(bytes) !== expected) throw Error('SOURCE_HASH');
  return JSON.parse(bytes);
}
function projectOrg(event, report, directory, now) {
  const mapped = mapping.resolve(event);
  if (!mapped) return { status: 'unmapped', reason: '本场尚无精确球队映射；未按时间或近似名称拼接。' };
  const completed = Date.parse(report.finishedAt);
  if (!Number.isFinite(completed) || completed > now || now - completed > 2 * 3600000) return { status: 'stale', reason: '免费接口资料已过期，未作为当前资料展示。' };
  const competition = report.competitions.find(row => row.code === mapped.code);
  if (!competition?.sourceReceipts) return { status: 'missing', reason: '该联赛本轮采集未完成。' };
  const receipt = competition.sourceReceipts.find(row => new URL(row.url).pathname.endsWith('/matches'));
  if (!receipt || !/^\d{3}\.body$/.test(receipt.rawName)) throw Error('MATCH_RECEIPT');
  const payload = verified(path.join(directory, receipt.rawName), receipt.sha256);
  const matches = collector.inspectMatches(payload, mapped.code, competition.season, Date.parse(receipt.receivedAt), report.config.businessDate);
  const pair = matches.rows.filter(row => row.homeTeam.id === mapped.teams[0][2] && row.awayTeam.id === mapped.teams[1][2]
    && row.homeTeam.name === mapped.teams[0][3] && row.awayTeam.name === mapped.teams[1][3]);
  const exact = pair.filter(row => Date.parse(row.utcDate) === Date.parse(event.kickoff));
  if (exact.length !== 1) return { status: 'conflict', reason: '来源主客队或开球时间与本场不一致，资料未合并。' };
  const names = new Map(matches.rows.flatMap(row => [[row.homeTeam.id,row.homeTeam.name],[row.awayTeam.id,row.awayTeam.name]]));
  return { status: 'available', source: 'football-data.org', providerMatchId: exact[0].id, observedAt: report.finishedAt,
    identityMethod: '已核对配置中的双语球队名、球队 ID、联赛和精确开球；映射尚无独立第二来源验证',
    teams: mapped.teams.map(team => {
      const history = teamHistory(matches, team[2], event.kickoff);
      return { name: team[1], providerName: team[3], standing: competition.standings.find(row => row.providerTeamId === team[2]) || null,
        lastFiveComplete: history.complete, scope: history.scope, lastFive: history.slots.map(row => row.missing ? { missing: true, kickoff: row.kickoff } : { kickoff: row.kickoff, home: names.get(row.orderedProviderTeamIds[0]), away: names.get(row.orderedProviderTeamIds[1]), score: row.score }) };
    }), sources: competition.sourceReceipts.map(row => ({ url: row.url, receivedAt: row.receivedAt, sha256: row.sha256 })), quarantined: competition.quarantined?.length || 0 };
}
function supplementAt(event, store, now, archived) {
  try {
    const pointer = JSON.parse(readFile(path.join(store, archived ? 'official-preserved-' + event.businessDate + '.json' : 'official-latest.json'), 4096));
    if (!/^[a-f0-9-]{36}$/.test(pointer.observation)) throw Error('SUPPLEMENT_POINTER');
    const value = verified(path.join(store, 'official-observations', pointer.observation, 'facts.json'), pointer.sha256);
    const item = value.events.find(row => row.eventId === event.eventId && row.businessDate === event.businessDate);
    if (!item || item.kickoff !== event.kickoff || item.names[0] !== event.homeTeamName || item.names[1] !== event.awayTeamName) return null;
    const observed = Date.parse(value.completedAt), kickoff = Date.parse(event.kickoff);
    if (value.version !== 'neutral-official-sports-v1' || !Number.isFinite(observed) || observed > now) return null;
    if (archived && !(Number.isFinite(kickoff) && observed <= kickoff && kickoff <= now)) return null;
    if (!archived && now - observed > 2 * 3600000) return { status: 'stale', reason: '官方补充资料已过期或时间无法核实。' };
    return { ...item, observedAt: value.completedAt, archived };
  } catch { return null; }
}
function supplement(event, store, now) {
  const current = supplementAt(event, store, now, false);
  return current && current.status !== 'stale' ? current : supplementAt(event, store, now, true) || current;
}
function archivedIdentity(businessDate, eventId, { store = STORE, trustRegistry } = {}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))throw Error('IDENTITY_DAY');
  const saved = require('../scripts/neutralCollectionStore.cjs').load(store,'identity-'+businessDate.replaceAll('-','')) || JSON.parse(readFile(path.join(store, 'identities', businessDate + '.json')));
  if (saved.version !== 'neutral-signed-identity-archive-v1' || saved.businessDate !== businessDate || sha(Buffer.from(JSON.stringify(saved.snapshot))) !== saved.snapshotSha256) throw Error('IDENTITY_ARCHIVE_HASH');
  const times = saved.snapshot.endpoints.filter(entry => ['current','calculator'].includes(entry.method)).map(entry => Date.parse(entry.receivedAt));
  if (times.length !== 2 || !times.every(Number.isFinite) || Math.max(...times) > Date.now()) throw Error('IDENTITY_ARCHIVE_CLOCK');
  const registry = trustRegistry || require('../src/services/collectorAttestation.cjs').loadCollectorTrustRegistry(path.resolve(__dirname, '../deploy/light-server/collector-trust-registry.json'));
  const view = require('./officialScheduleRead.cjs').project(saved.snapshot, businessDate, { now: Math.max(...times) + 1, trustRegistry: registry });
  const events = view.events.filter(event => event.eventId === eventId);
  if (events.length !== 1) return null;
  const { eventId: id, businessDate: day, kickoff, homeTeamId, awayTeamId, homeTeamName, awayTeamName, leagueName } = events[0];
  return { eventId: id, businessDate: day, kickoff, homeTeamId, awayTeamId, homeTeamName, awayTeamName, leagueName, identitySource: 'archived-signed-schedule', identityObservedAt: view.sourceReceivedAt };
}
function read(event, { store = STORE, now = Date.now() } = {}) {
  try { const future=require('../scripts/neutralFutureFacts.cjs').read(event,{store,now});if(future)return future; } catch { }
  let statistics;
  try {
    const pointer = JSON.parse(readFile(path.join(store, 'neutral-latest.json'), 4096));
    if (!/^\d+-[a-f0-9]{24}$/.test(pointer.observation)) throw Error('SOURCE_POINTER');
    const directory = path.join(store, 'research/football-data-org/observations', pointer.observation);
    const report = verified(path.join(directory, 'report.json'), pointer.reportSha256);
    statistics = projectOrg(event, report, directory, now);
  } catch { statistics = { status: 'unavailable', reason: '免费数据源暂时不可核验；未展示旧值或模拟数据。' }; }
  return { version: 'neutral-match-sports-v1', eventId: event.eventId, businessDate: event.businessDate, kickoff: event.kickoff,
    names: [event.homeTeamName,event.awayTeamName], checkedAt: new Date(now).toISOString(), predictionEligible: false,
    identitySource: event.identitySource || 'current-signed-schedule', identityObservedAt: event.identityObservedAt || null,
    statistics, official: supplement(event, store, now), limitations: ['单一来源数据不是独立交叉验证。','未查到伤停不等于无人伤停；预计阵容不等于确认首发。','本模块只展示体育事实，不改动历史原件、预测或推荐。'] };
}
async function handle(req, res, url, { authorize, send, schedule = require('./officialScheduleRead.cjs').read, reader = read, archive = archivedIdentity }) {
  res.setHeader('Cache-Control','private, no-store'); res.setHeader('Vary','Cookie, Authorization');
  if (req.method !== 'GET') return send(405,{ ok:false,error:'method not allowed' });
  if (!await authorize()) return send(401,{ ok:false,error:'access required' });
  if ([...url.searchParams.keys()].sort().join(',') !== 'businessDate,eventId' || !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('businessDate') || '') || !/^\d{1,20}$/.test(url.searchParams.get('eventId') || '')) return send(400,{ ok:false,error:'invalid event' });
  try {
    const day = url.searchParams.get('businessDate'), eventId = url.searchParams.get('eventId');
    let events;
    try { events = schedule(day).events.filter(event => event.eventId === eventId); } catch { events = []; }
    if (events.length > 1) throw Error('IDENTITY_CONFLICT');
    const event = events[0] || archive(day, eventId);
    if (!event) return send(404,{ ok:false,error:'official event not found' });
    return send(200,reader(event));
  } catch { return send(503,{ ok:false,error:'current official identity unavailable' }); }
}
module.exports = { read, projectOrg, supplement, archivedIdentity, handle };
