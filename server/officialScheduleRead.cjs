'use strict';
// Display-only projection of complete signed source payloads. No native row,
// prediction, publication, result, or durable reference is created here.
const live = require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const { loadCollectorTrustRegistry } = require('../src/services/collectorAttestation.cjs');
const { day } = require('./researchArchiveRead.cjs');
const { validateOfficialSchedule } = require('../src/services/officialSchedule.cjs');
const { epochNanoseconds } = require('../src/services/prematchV3Clock.cjs');
const MAX_AGE = 15 * 60 * 1000;
const fail = () => { throw Error('OFFICIAL_SCHEDULE_SOURCE_INVALID'); };
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value) ? value : fail();
function identity(row) {
  const eventId = String(row.matchId);
  if (!/^[1-9]\d{0,19}$/.test(eventId) || ![row.homeTeamId, row.awayTeamId].every(v => Number.isSafeInteger(v) && v > 0) || row.homeTeamId === row.awayTeamId) fail();
  day(row.matchDate);
  const kickoff = `${row.matchDate}T${row.matchTime}+08:00`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?\+08:00$/.test(kickoff) || epochNanoseconds(kickoff) === null) fail();
  return { eventId, businessDate: day(row.businessDate), matchNum: text(row.matchNumStr),
    homeTeamId: row.homeTeamId, awayTeamId: row.awayTeamId,
    homeTeamName: text(row.homeTeamAllName || row.homeTeamAbbName), awayTeamName: text(row.awayTeamAllName || row.awayTeamAbbName),
    kickoff: new Date(kickoff).toISOString() };
}
function project(snapshot, businessDate, { now, trustRegistry }) {
  day(businessDate);
  if (!snapshot || Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) fail();
  const audit = {};
  live.joinOfficialHandicap([], snapshot, { now, trustRegistry, audit });
  if (audit.status !== 'source-verified') fail();
  const lane = method => snapshot.endpoints.find(e => e.method === method);
  const current = lane('current'), calculator = lane('calculator');
  const rows = entry => {
    const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    if (entry.httpStatus!==200 || !/^application\/json(?:\s*;|$)/i.test(entry.contentType||'') || entry.payload?.success!==true
      || entry.page!==null || entry.sourceRequest?.method!=='GET' || entry.sourceRequest.role!==entry.method
      || entry.sourceRequest.page!==null || entry.sourceRequest.url!==entry.url
      || !hex(entry.rawSha256) || !hex(entry.headersSha256) || !hex(entry.canonicalPayloadSha256)
      || !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes<1 || entry.rawBytes>4*1024*1024
      || entry.providerObservedAt!=null && (epochNanoseconds(entry.providerObservedAt)===null || epochNanoseconds(entry.providerObservedAt)>epochNanoseconds(entry.receivedAt))) fail();
    const result=[];
    for(const group of entry.payload.value.matchInfoList){
      if(!group || !Array.isArray(group.subMatchList))fail();
      if(group.businessDate!=null)day(group.businessDate);
      for(const row of group.subMatchList){
        if(!row || typeof row!=='object' || Array.isArray(row) || row.businessDate && group.businessDate && row.businessDate!==group.businessDate)fail();
        const item={...row,businessDate:row.businessDate||group.businessDate};identity(item);result.push(item);
        if(result.length>512)fail();
      }
    }
    return result;
  };
  const unique = list => { const map = new Map(); for (const row of list) { const key = String(row.matchId); if (map.has(key)) fail(); map.set(key, row); } return map; };
  const quotes = unique(rows(calculator)), fixtures = unique(rows(current));
  const events = [];
  for (const row of fixtures.values()) {
    if (row.businessDate !== businessDate) continue;
    const event = identity(row), quote = quotes.get(event.eventId), markets = [];
    const deadlines=[Date.parse(event.kickoff)];
    for(const source of [row,quote].filter(Boolean))for(const key of ['buyEndTime','matchEndTime','sellEndTime','stopSaleTime','endTime']){
      if(source[key]==null||source[key]==='')continue;
      const raw=source[key],clock=typeof raw==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)?raw.replace(' ','T')+'+08:00':raw;
      const value=epochNanoseconds(clock);if(value===null||value%1000000n!==0n)fail();deadlines.push(Number(value/1000000n));
    }
    const saleCutoffAt=new Date(Math.min(...deadlines)).toISOString();
    let quoteStatus = quote ? 'matched' : 'unavailable';
    if (quote && JSON.stringify(identity(quote)) !== JSON.stringify(event)) quoteStatus = 'conflict';
    if (quoteStatus === 'matched') {
      for (const poolCode of ['HAD', 'HHAD']) {
        const left = (row.oddsList || []).filter(p => p.poolCode === poolCode);
        const right = (quote.oddsList || []).filter(p => p.poolCode === poolCode);
        if (!left.length && !right.length) continue;
        const normalize = p => ({ poolCode, handicap: poolCode === 'HHAD' ? Number(p.goalLine) : null, h: Number(p.h), d: Number(p.d), a: Number(p.a) });
        if (left.length !== 1 || right.length !== 1 || JSON.stringify(normalize(left[0])) !== JSON.stringify(normalize(right[0]))) { quoteStatus = 'conflict'; break; }
        const valid=p=>['h','d','a'].every(k=>(typeof p[k]==='string'||typeof p[k]==='number')&&/^\d+(?:\.\d{1,4})?$/.test(String(p[k])));
        if(!valid(left[0])||!valid(right[0])){quoteStatus='conflict';break;}
        const market = normalize(left[0]);
        if ([market.h, market.d, market.a].some(v => !Number.isFinite(v) || v <= 1 || v > 10000)
          || poolCode === 'HHAD' && (left[0].goalLine === '' || left[0].goalLine == null || !Number.isSafeInteger(market.handicap) || Math.abs(market.handicap) > 12)) { quoteStatus = 'conflict'; break; }
        markets.push(market);
      }
    }
    const saleState=now>=Date.parse(saleCutoffAt)||[row,quote].some(r=>r&&String(r.sellStatus)==='2')?'closed'
      :row.matchStatus==='Define'?'awaiting'
      :quoteStatus==='matched'&&[row,quote].every(r=>r&&r.matchStatus==='Selling'&&String(r.sellStatus)==='1')?'open':'unknown';
    events.push({ ...event, saleState, saleCutoffAt, leagueName: typeof row.leagueAllName === 'string' ? row.leagueAllName.slice(0, 255) : '',
      matchStatus: typeof row.matchStatus === 'string' ? row.matchStatus.slice(0, 64) : '',
      sellStatus: row.sellStatus === '' || row.sellStatus == null ? null : String(row.sellStatus),
      quoteStatus, markets: quoteStatus === 'matched' ? markets : [] });
  }
  events.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.matchNum.localeCompare(b.matchNum));
  const result = { version: 'signed-official-schedule-view-v1', businessDate, updatedAt: new Date(now).toISOString(),
    sourceReceivedAt: current.receivedAt, quoteReceivedAt: calculator.receivedAt, sourceCycleId: current.sourceCycleId,
    sourceSignatureVerified: true, recommendationEligibilityVerified: false, maximumAgeMs: MAX_AGE, events };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail();
  validateOfficialSchedule(result, businessDate, now);
  return result;
}
function read(businessDate) {
  return project(live.readLiveOfficialSnapshot(), businessDate, { now: Date.now(), trustRegistry: loadCollectorTrustRegistry(
    process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH || require('node:path').resolve(__dirname, '../deploy/light-server/collector-trust-registry.json')) });
}
module.exports = { project, read };
