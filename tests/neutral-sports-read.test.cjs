'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const reader=require('../server/neutralSportsRead.cjs'),parser=require('../scripts/neutralOfficialSportsParser.cjs'),mapping=require('../scripts/neutralSportsTeamMap.cjs');
const event={eventId:'2042188',businessDate:'2026-10-24',kickoff:'2026-10-24T11:30:00.000Z',leagueName:'英格兰超级联赛',homeTeamId:2,awayTeamId:12,homeTeamName:'阿斯顿维拉',awayTeamName:'曼彻斯特城'};
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neutral-detail-')),now=Date.parse('2026-10-24T04:00:00Z'),season={id:100,startDate:'2026-08-01',endDate:'2027-06-30',year:2026};
 const payload={competition:{id:2021,code:'PL'},resultSet:{count:1},matches:[{id:560614,competition:{id:2021,code:'PL'},season:{id:100},utcDate:event.kickoff,homeTeam:{id:58,name:'Aston Villa FC'},awayTeam:{id:65,name:'Manchester City FC'},status:'TIMED',score:{duration:'REGULAR',fullTime:{home:null,away:null}}}]};
 const bytes=Buffer.from(JSON.stringify(payload));fs.writeFileSync(path.join(directory,'001.body'),bytes);
 const report={finishedAt:new Date(now).toISOString(),config:{businessDate:event.businessDate},competitions:[{code:'PL',season,standings:[{providerTeamId:58,rank:12,points:8,played:7},{providerTeamId:65,rank:1,points:21,played:7}],quarantined:[],sourceReceipts:[{url:'https://api.football-data.org/v4/competitions/PL/matches?season=2026',rawName:'001.body',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),receivedAt:new Date(now).toISOString()}]}]};
 return{directory,now,report};
}
test('exact event displays source standings but never claims a missing five',()=>{const item=fixture(),value=reader.projectOrg(event,item.report,item.directory,item.now);assert.equal(value.status,'available');assert.equal(value.teams[0].standing.points,8);assert.equal(value.teams[0].lastFiveComplete,false);});
test('one-hour conflict cannot join an otherwise identical fixture',()=>{const item=fixture();assert.equal(reader.projectOrg({...event,kickoff:'2026-10-24T12:30:00.000Z'},item.report,item.directory,item.now).status,'conflict');});
test('reversed sides and renamed official teams never fall back to time-only join',()=>{assert.equal(mapping.resolve({...event,homeTeamName:'another club'}),null);const item=fixture();assert.equal(reader.projectOrg({...event,homeTeamId:12,awayTeamId:2,homeTeamName:event.awayTeamName,awayTeamName:event.homeTeamName},item.report,item.directory,item.now).status,'conflict');});
test('stale data and future source clock are withheld',()=>{const item=fixture();assert.equal(reader.projectOrg(event,item.report,item.directory,item.now+7200001).status,'stale');assert.equal(reader.projectOrg(event,item.report,item.directory,item.now-1).status,'stale');});
test('changed source bytes fail hash verification',()=>{const item=fixture();fs.appendFileSync(path.join(item.directory,'001.body'),' ');assert.throws(()=>reader.projectOrg(event,item.report,item.directory,item.now),/SOURCE_HASH/);});
test('missing production store stays unavailable and cannot become empty success',()=>{const result=reader.read(event,{store:path.join(os.tmpdir(),'not-existent-neutral-'+crypto.randomUUID())});assert.equal(result.statistics.status,'unavailable');assert.equal(result.predictionEligible,false);assert.equal(result.official,null);});
test('HTTP access is checked before reading data; duplicate query and mutations reject',async()=>{
 const response={setHeader(){}};let code,calls=0;const send=(status)=>{code=status;};const options={authorize:()=>false,send,schedule:()=>{calls++;return{events:[event]};}};
 await reader.handle({method:'GET'},response,new URL('https://example.com/api/sports-data?businessDate=2026-10-24&eventId=2042188'),options);assert.equal(code,401);assert.equal(calls,0);
 await reader.handle({method:'POST'},response,new URL('https://example.com/api/sports-data'),options);assert.equal(code,405);
 await reader.handle({method:'GET'},response,new URL('https://example.com/api/sports-data?businessDate=2026-10-24&eventId=2042188&eventId=2042188'),{...options,authorize:()=>true});assert.equal(code,400);
});
test('official schedule failure is not hidden by a stored supplement',async()=>{let status;await reader.handle({method:'GET'},{setHeader(){}},new URL('https://example.com/api/sports-data?businessDate=2026-10-24&eventId=2042188'),{authorize:()=>true,send:code=>{status=code;},schedule:()=>{throw Error('stale');}});assert.equal(status,503);});
test('native sources fail closed on malformed markup and wrong competition schemas',()=>{assert.throws(()=>parser.japanese('<html></html>',{},[]),/JLEAGUE_FLIGHT/);assert.throws(()=>parser.norwegian('<table></table>',{}),/NORWAY_TABLE_HEADER/);assert.throws(()=>parser.australian('<html></html>',{}),/AUSTRALIA_EVENT_COUNT/);assert.throws(()=>parser.cityAvailability('Unavailable: none',Date.now()),/CITY_ARTICLE_SCOPE/);});
test('all three original detail entrypoints include the data panel',()=>{const component=fs.readFileSync(path.join(__dirname,'../src/components/recommendations/OfficialSchedule.tsx'),'utf8');const native=fs.readFileSync(path.join(__dirname,'../src/pages/MatchDetail.tsx'),'utf8');const editorial=fs.readFileSync(path.join(__dirname,'../src/components/recommendations/OfficialEditorialReferences.tsx'),'utf8');assert(component.includes('<NeutralSportsData eventId={event.eventId}'));assert(native.includes('<NeutralSportsData eventId={match.id.slice(10)}'));assert(editorial.includes('<NeutralSportsData eventId={record.eventId}'));});
test('a signed archived identity serves facts without replaying historical prices or sale state',()=>{
 const fixture=require('./fixtures/reviewed-official-event.cjs').setup();
 const store=fs.mkdtempSync(path.join(os.tmpdir(),'neutral-identity-'));fs.mkdirSync(path.join(store,'identities'));
 const day=fixture.draft.businessDate,snapshot=fixture.snapshot,file=path.join(store,'identities',day+'.json');
 fs.writeFileSync(file,JSON.stringify({version:'neutral-signed-identity-archive-v1',businessDate:day,snapshot,snapshotSha256:crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}));
 const projected=require('../server/officialScheduleRead.cjs').project(snapshot,day,{now:require('./fixtures/reviewed-official-event.cjs').NOW,trustRegistry:fixture.trustRegistry});
 const identity=reader.archivedIdentity(day,projected.events[0].eventId,{store,trustRegistry:fixture.trustRegistry});
 assert.equal(identity.identitySource,'archived-signed-schedule');assert.equal(identity.homeTeamId,projected.events[0].homeTeamId);
 assert.equal(identity.markets,undefined);assert.equal(identity.saleState,undefined);
 const changed=JSON.parse(fs.readFileSync(file));changed.snapshotSha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(changed));
 assert.throws(()=>reader.archivedIdentity(day,projected.events[0].eventId,{store,trustRegistry:fixture.trustRegistry}),/IDENTITY_ARCHIVE_HASH/);
});
test('archived identity fallback never changes the requested event and is authenticated first',async()=>{
 let status,body,archiveReads=0;
 await reader.handle({method:'GET'},{setHeader(){}},new URL('https://example.com/api/sports-data?businessDate=2026-10-24&eventId=2042188'),{authorize:()=>true,send:(code,value)=>{status=code;body=value;},schedule:()=>({events:[]}),archive:(day,id)=>{archiveReads++;assert.equal(day,event.businessDate);assert.equal(id,event.eventId);return{...event,identitySource:'archived-signed-schedule'};},reader:value=>({eventId:value.eventId})});
 assert.equal(status,200);assert.equal(body.eventId,event.eventId);assert.equal(archiveReads,1);
});
