'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const official=require('./fixtures/reviewed-official-event.cjs');
const signed=require('./fixtures/signed-live-had.cjs');
const collector=require('../src/services/collectorAttestation.cjs');
const sources=require('../scripts/teamEvidenceSources.cjs');
const {LEAGUES}=require('../scripts/expandedLeagueHistoryParser.cjs');
const {sha}=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const adapter=require('../scripts/recommendationPlatform/reviewedResearchKLeague.cjs');
const evidence=require('../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const NOW=Date.parse('2026-10-24T00:30:00Z'),stamp=value=>new Date(value).toISOString();
const originalLoader=collector.loadCollectorTrustRegistry;
let trusted;
collector.loadCollectorTrustRegistry=file=>{
 assert.equal(file,path.resolve(__dirname,'../deploy/light-server/collector-trust-registry.json'));
 return trusted;
};
test.after(()=>{collector.loadCollectorTrustRegistry=originalLoader;});
function setup(){
 const event={eventId:'900001',matchNum:'周六901',businessDate:'2026-10-24',kickoff:'2026-10-24T10:00:00Z',teams:['首尔FC','江原FC'],orderedTeamIds:[901,902]};
 const acquisition=signed.snapshot([{...signed.source(1),sourceMatchId:event.eventId,businessDate:event.businessDate,matchNo:event.matchNum,
  homeTeamName:event.teams[0],awayTeamName:event.teams[1]}],{requestedAt:NOW-6000,receivedAt:NOW-5000,mutate:entry=>{
   const group=entry.payload.value.matchInfoList[0];group.businessDate=event.businessDate;
   Object.assign(group.subMatchList[0],{matchDate:'2026-10-24',matchTime:'18:00:00',homeTeamId:901,awayTeamId:902,leagueId:'48',leagueAllName:LEAGUES['kr.1']});
  }});
 trusted=acquisition.registry;
 const dates=['2026.10.20','2026.10.15','2026.10.10','2026.09.26','2026.09.20'];
 const finals=dates.flatMap((date,index)=>['K09','K21'].map((team,side)=>({year:2026,leagueId:1,gameId:100+index*2+side,gameDate:date,gameTime:'14:00',
  homeTeam:team,awayTeam:side?'K03':'K01',endYn:'Y',gameStatus:'FE',homeGoal:index%3,awayGoal:1})));
 const future={year:2026,leagueId:1,gameId:999,gameDate:'2026.10.24',gameTime:'19:00',homeTeam:'K09',awayTeam:'K21',endYn:'N',gameStatus:'SC',homeGoal:null,awayGoal:null};
 const august={...finals[0],gameId:55,gameDate:'2026.08.20'};
 const plans=sources.plans([{businessDate:event.businessDate,leagueName:LEAGUES['kr.1']}],stamp(NOW));
 const ranks=[['K09','SEOUL'],['K21','GANGWON'],['K01','ULSAN'],['K03','POHANG']].map(([teamId,teamName],index)=>({year:2026,leagueId:1,teamId,teamName,rank:index+1,gainPoint:30-index,gameCount:20}));
 const packets=plans.map(plan=>{
  const rows=plan.kind==='standings'?ranks:[...finals,august,future].filter(row=>row.gameDate.slice(5,7)===plan.month);
  const raw=JSON.stringify({resultCode:'200',data:{[plan.kind==='standings'?'teamRank':'scheduleList']:rows}});
  return sources.pack(plan,{requestedAt:stamp(NOW-3000),receivedAt:stamp(NOW-2000),status:200,raw,rawSha256:sha(Buffer.from(raw)),bytes:Buffer.byteLength(raw)});
 });
 return {event,packets,asOf:stamp(NOW),reviewedBy:'synthetic-test',authority:{adapter:adapter.VERSION,observedAt:stamp(NOW-4000),endpoint:acquisition.snapshot.endpoints[0]},pair:acquisition.pair};
}
function inputOf(packet){
 const {event,competition,sourceRegistry,sources:pages,observations,reviewedBy,reviewedAt,authority}=packet;
 return structuredClone({event,competition,sourceRegistry,sources:pages,observations,reviewedBy,reviewedAt,authority});
}
function repack(packet,change){
 const raw=JSON.parse(packet.response.raw);change(raw);const text=JSON.stringify(raw);
 return sources.pack(packet.plan,{...packet.response,raw:text,rawSha256:sha(Buffer.from(text)),bytes:Buffer.byteLength(text)});
}
test('native raw JSON replays signed ordered teams and six facts without fabricated envelopes',()=>{
 const value=setup(),original=JSON.stringify(value.packets),packet=adapter.prepare(value),assessment=evidence.assess(packet,value.asOf);
 assert.equal(JSON.stringify(value.packets),original);assert.equal(packet.observations.length,6);
 for(const page of packet.sources){const source=value.packets.find(item=>item.sourceId===page.id);assert.equal(Buffer.from(page.rawBase64,'base64').toString(),source.response.raw);assert.equal(page.publishedAt,null);}
 assert(packet.observations.every(item=>item.excerpt===null&&item.native.adapter===adapter.VERSION));
 assert.equal(assessment.independentSourceCount,1);assert.equal(assessment.directionEligible,false);assert.equal(assessment.comboEligible,false);
 assert.equal(assessment.availabilityComplete,false);assert.equal(assessment.lineupsConfirmed,false);
 assert.equal(assessment.modelProbability,null);assert.equal(assessment.expectedValue,null);
 assert.equal(packet.contentHash,adapter.prepare(value).contentHash);
 const json=JSON.stringify(packet),request=Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'evidence-archive',json,sha256:sha(json)}));
 assert(request.length<1024*1024);assert.equal(require('../server/researchWriteService.cjs').decodeRequest(request).json,json);
});
for(const [name,change] of [
 ['normalized rank differs from retained raw',input=>{input.observations[0].value.rank=19;}],
 ['away fact copied from home',input=>{input.observations.find(item=>item.kind==='standings'&&item.side==='away').value=structuredClone(input.observations[0].value);}],
 ['outcome differs from raw',input=>{input.observations.find(item=>item.kind==='last-five').value.matches[0].score=[9,0];}],
 ['invented publication clock',input=>{input.sources[0].publishedAt=input.reviewedAt;}],
 ['unverified numeric official team ids',input=>{input.event.orderedTeamIds[0]++;}],
 ['ordered teams reversed',input=>{input.event.teams.reverse();input.event.orderedTeamIds.reverse();}],
 ['wrong event id',input=>{input.event.eventId='900002';}],
 ['wrong kickoff',input=>{input.event.kickoff='2026-10-24T06:00:00Z';}],
 ['wrong business date',input=>{input.event.businessDate='2026-10-25';}],
 ['wrong match number',input=>{input.event.matchNum='周六902';}],
 ['wrong season',input=>{input.competition.season='2025';}],
 ['wrong league',input=>{input.competition.league='jp.1';}],
 ['missing original month',input=>{input.sources.pop();}],
 ['duplicate native source selectors',input=>{input.observations[0].native.sourceIds[1]=input.observations[0].native.sourceIds[0];}],
 ['native adapter not approved',input=>{input.observations[0].native.adapter='arbitrary-parser';}],
 ['source raw hash drift',input=>{input.sources[0].rawSha256='0'.repeat(64);}],
 ['source packet hash drift',input=>{input.sources[0].native.packetHash='0'.repeat(64);}],
 ['invented injury completeness',input=>{input.observations[0].kind='availability';input.observations[0].value={complete:true,players:[]};}],
 ['invented confirmed lineup',input=>{input.observations[0].kind='lineup';input.observations[0].value={status:'confirmed',players:Array.from({length:11},(_,index)=>'Player '+index)};}],
 ['invented H2H',input=>{input.observations[0].kind='head-to-head';input.observations[0].side='both';}],
 ['arbitrary summary instead of replayed fact',input=>{input.observations[0].summary='A new unrelated assertion';}],
 ['removing actual authority',input=>{delete input.authority;}],
 ['packet-supplied trusted key',input=>{input.authority.trustRegistry=trusted;}],
 ['future authority observation',input=>{input.authority.observedAt=stamp(NOW+1);}],
 ['expired signed authority at its claimed observation',input=>{input.authority.observedAt=stamp(NOW+16*60000);input.reviewedAt=input.authority.observedAt;}],
 ['tampered complete signed payload',input=>{input.authority.endpoint.payload.value.matchInfoList[0].subMatchList[0].homeTeamId++;}],
])test('reject '+name,()=>{const packet=adapter.prepare(setup()),input=inputOf(packet);change(input);assert.throws(()=>evidence.create(input));});
test('signed foreign league is not a valid Korean authority',()=>{
 const value=setup();value.authority.endpoint.payload.value.matchInfoList[0].subMatchList[0].leagueId='999';
 official.resign(value.authority.endpoint,value.pair);assert.throws(()=>adapter.prepare(value),/SIGNED_CONTEXT/);
});
test('signed wrong league title and explicit wrong season are rejected',()=>{
 for(const field of ['leagueAllName','season']){const value=setup();value.authority.endpoint.payload.value.matchInfoList[0].subMatchList[0][field]='2025';official.resign(value.authority.endpoint,value.pair);assert.throws(()=>adapter.prepare(value),/SIGNED_CONTEXT/);}
});
test('fixed registry rejects another synthetic collector even if packet claims its key',()=>{
 const value=setup(),other=collector.createCollectorKeyPair({keyId:'untrusted-test'});official.resign(value.authority.endpoint,other);
 assert.throws(()=>adapter.prepare(value),/SIGNED_IDENTITY/);
});
test('trust environment override is ignored by fixed source loading',()=>{
 const prior=process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH='untrusted-test-path';
 try{assert.equal(evidence.assess(adapter.prepare(setup()),stamp(NOW)).independentSourceCount,1);}finally{if(prior===undefined)delete process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH;else process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH=prior;}
});
test('provider fixture mismatch rejects even a correctly rehashed raw packet',()=>{
 const value=setup(),index=value.packets.findIndex(packet=>packet.plan.month==='10');
 value.packets[index]=repack(value.packets[index],raw=>{raw.data.scheduleList.find(row=>row.gameId===999).gameTime='15:00';});
 assert.throws(()=>adapter.prepare(value),/EXACT_EVENT/);
});
test('unknown more recent result prevents claiming complete last-five',()=>{
 const value=setup(),index=value.packets.findIndex(packet=>packet.plan.month==='10');
 value.packets[index]=repack(value.packets[index],raw=>{raw.data.scheduleList.push({...raw.data.scheduleList[0],gameId:888,gameDate:'2026.10.22',endYn:'N',gameStatus:'SC',homeGoal:null,awayGoal:null});});
 assert.throws(()=>adapter.prepare(value),/LATEST_RESULT_UNVERIFIED/);
});
test('provider standings league and team names must bind to the provider ids',()=>{
 for(const field of ['leagueId','teamName']){const value=setup(),index=value.packets.findIndex(packet=>packet.plan.kind==='standings');
  value.packets[index]=repack(value.packets[index],raw=>{raw.data.teamRank[0][field]=field==='leagueId'?2:'GANGWON';});assert.throws(()=>adapter.prepare(value),/STANDINGS_SCOPE/);}
});
test('fresh capture clock cannot extend native six-hour adoption and stale assessment',()=>{
 const value=setup(),packet=adapter.prepare(value);assert.throws(()=>adapter.prepare({...value,asOf:stamp(NOW+adapter.SOURCE_MAX_AGE_MS)}),/ADOPTION_FRESHNESS/);
 const assessment=evidence.assess(packet,stamp(NOW+adapter.SOURCE_MAX_AGE_MS));
 assert.equal(assessment.independentSourceCount,0);assert.equal(assessment.directionEligible,false);
 assert(assessment.fields.filter(field=>['standings','last-five','schedule'].includes(field.kind)).every(field=>field.status==='stale'));
});
test('native facts expire when any required original expires, not only the primary current page',()=>{
 const value=setup(),index=value.packets.findIndex(packet=>packet.plan.month==='08'),old=value.packets[index];
 value.packets[index]=sources.pack(old.plan,{...old.response,requestedAt:stamp(NOW-3601000),receivedAt:stamp(NOW-3600000)});
 const packet=adapter.prepare(value),assessment=evidence.assess(packet,stamp(NOW+5*3600000+1));
 assert.equal(assessment.independentSourceCount,0);assert.equal(assessment.directionEligible,false);
 assert(assessment.fields.filter(field=>['standings','last-five','schedule'].includes(field.kind)).every(field=>field.status==='stale'));
});
