'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCollectorKeyPair} = require('../src/services/collectorAttestation.cjs');
const {resign} = require('./fixtures/reviewed-official-event.cjs');
const {projectFullRelay, createSignedReader} = require('../server/publicSignedFixtureArchive.cjs');
const {publicArchiveFixture, mergeSources, createArchiveReader, createNativeCache} = require('../server/publicFixtureHistory.cjs');

const NOW = Date.parse('2026-11-24T06:00:00Z'), uri = 'https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all&pageSize=80';
const sample = {businessDate:'2026-11-23',matchDate:'2026-11-24',matchTime:'02:00',matchId:123,
  matchNumStr:'周一001',homeTeamId:'73',awayTeamId:'75',homeTeamAllName:'主队',awayTeamAllName:'客队',
  leagueAllName:'比赛',matchStatus:'11',sectionsNo999:'3:2',sectionsNo1:'0:0',h:'3.01',recommendation:'private'};
function signed(mutate = () => {}) {
  const pair = createCollectorKeyPair({keyId:'fixture-history-test'});
  const page = {method:'all',page:1,url:uri,ok:true,httpStatus:200,sourceCycleId:'fixture-test-cycle',
    requestedAt:'2026-11-24T05:00:00Z',receivedAt:'2026-11-24T05:00:01Z',
    sourceRequest:{method:'GET',url:uri,page:1,role:'method:all'},rawBytes:800,contentType:'application/json',
    rawSha256:'c'.repeat(64),headersSha256:'d'.repeat(64),
    payload:{success:true,value:{pageNo:1,prePage:'0',matchInfoList:[{matchCount:1,matchDate:sample.businessDate,subMatchList:[{...sample}]}]}}};
  mutate(page);
  return {registry:pair.registry, snapshot:{sourceCycleId:page.sourceCycleId,endpoints:[resign(page,pair)]}};
}
function readFixture(mutate) {
  const {snapshot, registry} = signed(mutate);
  return projectFullRelay(snapshot,registry,NOW);
}
test('a signed complete day carries its issue date across midnight, with a public-only full-time projection', () => {
  const archive = readFixture(), row = archive.matches[0];
  assert.deepEqual(archive.incompleteDates, []);
  assert.equal(row.businessDate,'2026-11-23'); assert.equal(row.kickoffTime,'2026-11-23T18:00:00.000Z');
  assert.deepEqual([row.scoreHome,row.scoreAway],[3,2]);
  assert.deepEqual(Object.keys(row).sort(),['id','businessDate','matchNo','leagueName','homeTeamName','awayTeamName','kickoffTime','status','scoreHome','scoreAway'].sort());
});
test('wrong issuer, tampered score, wrong endpoint role, missing pages and repeated event IDs fail closed', () => {
  const {snapshot,registry} = signed();
  assert.throws(()=>projectFullRelay(snapshot,createCollectorKeyPair({keyId:'other'}).registry,NOW));
  snapshot.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].sectionsNo999='9:0';
  assert.throws(()=>projectFullRelay(snapshot,registry,NOW));
  for(const change of [p=>p.sourceRequest.role='result',p=>p.sourceRequest.url=p.url=uri+'&pageNo=2',
    p=>p.payload.value.prePage='1',p=>p.payload.value.matchInfoList[0].subMatchList.push({...sample}),
    p=>p.payload.value.matchInfoList[0].subMatchList[0].businessDate='2026-11-22'])
    assert.throws(()=>readFixture(change));
});
test('the fixed registry file must contain the registry object, never a path to another registry', async t => {
  const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fixture-registry-test-'));
  const source=path.join(dir,'snapshot.json'), registryFile=path.join(dir,'trusted.json'), indirect=path.join(dir,'indirect.json');
  t.after(async()=>{for(const file of [source,registryFile,indirect])await fs.unlink(file);await fs.rmdir(dir);});
  const {snapshot,registry}=signed(p=>{p.requestedAt='2020-01-01T12:00:00Z';p.receivedAt='2020-01-01T12:00:01Z';});
  await Promise.all([fs.writeFile(source,JSON.stringify(snapshot)),fs.writeFile(registryFile,JSON.stringify(registry)),
    fs.writeFile(indirect,JSON.stringify(registryFile))]);
  await createSignedReader(source,registryFile)();
  await assert.rejects(createSignedReader(source,indirect),/could not be verified/);
});
test('a partially retained issue is marked incomplete, and unconfirmed or void games have no score', () => {
  const partial = readFixture(p=>p.payload.value.matchInfoList[0].matchCount=2);
  assert.deepEqual(partial,{matches:[],incompleteDates:['2026-11-23']});
  for(const [status, name, expected] of [['2','已开售','PENDING_RESULT'],['12','取消竞猜','VOID']]){
    const {matches:[row]}=readFixture(p=>Object.assign(p.payload.value.matchInfoList[0].subMatchList[0],{matchStatus:status,matchStatusName:name}));
    assert.deepEqual([row.status,row.scoreHome,row.scoreAway],[expected,null,null]);
  }
});
test('native rows require official result authority and preserve zero scores; aliases coalesce only for the same revision', () => {
  const [row] = readFixture().matches;
  const base={...row, id:'fivehundred_123', resultSource:'sporttery:official-api',official:true};
  assert.equal(publicArchiveFixture({...base,resultSource:'fallback',official:false}).scoreHome,null);
  assert.equal(publicArchiveFixture({...base,scoreHome:0}).scoreHome,0);
  const native=publicArchiveFixture(base);
  assert.equal(mergeSources([native],[row]).byDay.get(row.businessDate).length,1);
  for(const changed of [{scoreHome:4},{awayTeamName:'另一支球队'},{kickoffTime:'2026-11-23T18:30:00.000Z'},{id:'sporttery_456'}]){
    const archive = mergeSources([native],[{...row,...changed}]), result=archive.byDay.get(row.businessDate);
    assert.equal(result.length,1);assert.equal(result[0].status,'CONFLICT');assert.equal(result[0].scoreHome,null);assert.equal(archive.latestResultDate,null);
  }
});
test('a missing native pointer leaves signed lookup available; invalid and uncovered days do not inherit the last selection',async()=>{
  const data=readFixture(),read=createArchiveReader(()=>{throw Error('pointer unavailable')},async()=>data);
  const accepted=await read('2026-11-23'), earlier=await read('2026-11-12');
  assert.deepEqual(accepted.sourceAvailable,{native:false,signed:true});assert.equal(accepted.matches.length,1);
  assert.deepEqual(earlier.matches,[]); assert.equal(earlier.latestResultDate,'2026-11-23');
  assert.equal((await read.find('sporttery_123','2026-11-23')).scoreAway,2);
  await assert.rejects(()=>read.find('sporttery_123','2026-11-12'),/coverage unavailable/);
  assert.equal(await createArchiveReader(()=>[],()=>data).find('sporttery_123','2026-11-12'),null);
  const partial=createArchiveReader(()=>[],()=>({...data,incompleteDates:['2026-11-12']}));
  await assert.rejects(()=>partial.find('sporttery_456'),/coverage unavailable/);
  await assert.rejects(()=>partial.find('sporttery_456','2026-11-12'),/coverage unavailable/);
  assert.equal(await partial.find('sporttery_456','2026-11-11'),null);
  await assert.rejects(()=>read('2026-11-31'),{status:400});
  await assert.rejects(()=>createArchiveReader(()=>null,()=>null)('2026-11-23'));
  const fallback=createArchiveReader(()=>data.matches,()=>{throw Error('signature invalid')});
  assert.equal((await fallback('2026-11-23')).sourceAvailable.signed,false);
});
test('public HTTP history and deep links enforce preview, methods, date scope and public fields',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../server/index.cjs'),'utf8');
  const start=source.indexOf('const handleApi = async (req, res, url) => {');
  const end=source.indexOf('  if (url.pathname === "/api/access/verify")',start);
  const env={PUBLIC_PREVIEW_ENABLED:'1'}, signed=readFixture();
  let isNativeUp=true,isSignedUp=true,overviewCalls=0;
  const handle=vm.runInNewContext(source.slice(start,end)+'}; handleApi', {
    process:{env},URL,require:id=>{assert.equal(id,'./publicFixtureHistory.cjs');return require('../server/publicFixtureHistory.cjs');},
    accountSystem:{handle:async()=>false},researchHttpHandler:async()=>false,
    buildPublicProduct:async()=>{overviewCalls++;throw Error('no overview')},
    readPublicFixtureHistory:createArchiveReader(()=>{if(!isNativeUp)throw Error('pointer down');return []},
      ()=>{if(!isSignedUp)throw Error('signature invalid');return signed}),
    sendJson:(_res,payload,status)=>({payload,status}), sendJsonCached:(_req,_res,payload)=>({payload,status:200}),
  });
  const call=(route,method='GET')=>handle({method},{},new URL('http://localhost'+route));
  const deep='/api/public/matches/sporttery_123',list='/api/public/fixtures/history';
  assert.equal((await call(list+'?date=2026-11-23')).payload.matches[0].scoreHome,3);
  const old=await call(deep);assert.equal(old.status,200);assert.equal(old.payload.match.archiveResult,true);
  const before=overviewCalls;const dated=await call(deep+'?date=2026-11-23');assert.equal(overviewCalls,before);
  assert.deepEqual(Object.keys(dated.payload.match).sort(),['archiveResult','id','businessDate','matchNo','leagueName','homeTeamName','awayTeamName','kickoffTime','status','scoreHome','scoreAway','effectiveStatus','odds'].sort());
  assert.deepEqual(Object.values(dated.payload.match.odds),[null,null,null]);
  assert.equal((await call(deep+'?date=2026-11-12')).status,404);
  assert.equal((await call(deep+'?date=2026-11-32')).status,400);assert.equal((await call(deep,'POST')).status,405);
  isNativeUp=false;assert.equal((await call(deep+'?date=2026-11-23')).status,200);
  isSignedUp=false;assert.equal((await call(deep+'?date=2026-11-23')).status,503);
  assert.equal((await call(list+'?date=2026-11-23')).status,503);
  env.PUBLIC_PREVIEW_ENABLED='0';assert.equal((await call(deep)).status,404);assert.equal((await call(list)).status,404);
});
test('concurrent date reads share one native projection until the publication or result revision changes',async()=>{
  const cached=createNativeCache();let calls=0;
  const load=async()=>{calls++;return []};
  await Promise.all([cached('a.1',load),cached('a.1',load)]);await cached('a.1',load);assert.equal(calls,1);
  await cached('a.2',load);await cached('b.2',load);assert.equal(calls,3);
  await assert.rejects(()=>cached('failed',()=>{throw Error('read')}));await cached('failed',load);assert.equal(calls,4);
});
