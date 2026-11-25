'use strict';
const sourcesPolicy=require('../teamEvidenceSources.cjs');
const korean=require('../syncKLeagueOfficialStandings.cjs');
const {LEAGUES}=require('../expandedLeagueHistoryParser.cjs');
const {hash,sha}=require('./reviewedAnalysis.cjs');
const path=require('node:path');
const {derivedTeamId}=require('../storedResultTeamIdentity.cjs');
const collector=require('../../src/services/collectorAttestation.cjs');
const live=require('./liveOfficialHad.cjs');
const VERSION='kleague-native-replay-v1';
const SOURCE_MAX_AGE_MS=21600000;
const check=(value,code)=>{if(!value)throw Object.assign(Error('RESEARCH_KLEAGUE_'+code),{code:'RESEARCH_KLEAGUE_'+code});};
const exact=(value,keys)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(','),'FIELDS');
function verifyAuthority(authority,event,competition,asOf){
 exact(authority,['adapter','observedAt','endpoint']);
 check(authority.adapter===VERSION&&Number.isFinite(Date.parse(authority.observedAt))&&Date.parse(authority.observedAt)<=Date.parse(asOf),'AUTHORITY_CLOCK');
 const trustRegistry=collector.loadCollectorTrustRegistry(path.resolve(__dirname,'../../deploy/light-server/collector-trust-registry.json'));
 const input={id:'sporttery_'+event.eventId,sourceMatchId:event.eventId,businessDate:event.businessDate,matchNo:event.matchNum,
  homeTeamName:event.teams[0],awayTeamName:event.teams[1],homeTeamId:derivedTeamId(event.teams[0]),awayTeamId:derivedTeamId(event.teams[1]),
  eventVersion:event.kickoff,kickoffTime:event.kickoff};
 check(live.verifySignedCurrentEventIdentity(input,authority.endpoint,{asOf:authority.observedAt,trustRegistry}),'SIGNED_IDENTITY');
 const rows=authority.endpoint.payload.value.matchInfoList.flatMap(group=>group.subMatchList).filter(row=>String(row.matchId)===event.eventId);
 check(rows.length===1,'SIGNED_ROW');const row=rows[0],season=String(new Date(Date.parse(event.kickoff)+9*3600000).getUTCFullYear());
 check(hash([Number(row.homeTeamId),Number(row.awayTeamId)])===hash(event.orderedTeamIds)
  &&hash([row.homeTeamAllName||row.homeTeamAbbName,row.awayTeamAllName||row.awayTeamAbbName])===hash(event.teams)
  &&String(row.leagueId)==='48'&&row.leagueAllName===LEAGUES['kr.1']&&row.matchNumStr===event.matchNum
  &&hash(competition)===hash({league:'kr.1',season})
  &&[row.season,row.seasonId].every(value=>value==null||String(value)===season),'SIGNED_CONTEXT');
 const providerTeams=event.teams.map(korean.resolveTeamId);
 check(providerTeams.every(Boolean)&&providerTeams[0]!==providerTeams[1],'TEAM_MAPPING');
 return {providerTeams,season:Number(season)};
}
function verifySource(source){
 exact(source.native,['adapter','plan','packetHash']);
 check(source.native.adapter===VERSION&&source.publisherId==='kleague-official'&&source.provenance==='original'
  &&source.originPublisherId==='kleague-official'&&source.publishedAt===null&&source.publicationExcerpt===null,'SOURCE_IDENTITY');
 const plan=source.native.plan;
 check(['standings','schedule'].includes(plan.kind)&&source.id===plan.id&&source.url===plan.url&&source.originUrl===plan.url
  &&source.originId===plan.id,'SOURCE_PLAN');
 const raw=Buffer.from(source.rawBase64,'base64');
 check(raw.length>0&&raw.length<=2*1024*1024&&raw.toString('base64')===source.rawBase64&&raw.length===source.rawBytes&&sha(raw)===source.rawSha256,'RAW_BINDING');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{check(false,'UTF8');}
 const packet=sourcesPolicy.pack(plan,{requestedAt:source.requestedAt,receivedAt:source.receivedAt,status:200,raw:text,rawSha256:source.rawSha256,bytes:raw.length});
 check(packet.contentHash===source.native.packetHash&&sourcesPolicy.verify(packet),'PACKET_BINDING');
 return packet;
}
function fromPacket(packet){
 check(sourcesPolicy.verify(packet)&&['standings','schedule'].includes(packet.plan.kind),'PACKET_BINDING');
 return {id:packet.sourceId,url:packet.plan.url,publisherId:'kleague-official',provenance:'original',originPublisherId:'kleague-official',
  originUrl:packet.plan.url,originId:packet.sourceId,rawBase64:Buffer.from(packet.response.raw).toString('base64'),rawSha256:packet.response.rawSha256,
  rawBytes:packet.response.bytes,requestedAt:packet.response.requestedAt,receivedAt:packet.response.receivedAt,publishedAt:null,publicationExcerpt:null,
  native:{adapter:VERSION,plan:structuredClone(packet.plan),packetHash:packet.contentHash}};
}
function replay({sources,event,competition,asOf,authority}){
 const approved=verifyAuthority(authority,event,competition,asOf);
 check(Array.isArray(sources)&&sources.length===4&&new Set(sources.map(source=>source.id)).size===4,'SOURCE_SET');
 const ordered=sources.slice().sort((left,right)=>left.id.localeCompare(right.id)),packets=ordered.map(verifySource);
 const expectedPlans=sourcesPolicy.plans([{businessDate:event.businessDate,leagueName:LEAGUES['kr.1']}],asOf);
 check(expectedPlans.length===4&&packets.every(packet=>expectedPlans.some(plan=>hash(plan)===hash(packet.plan))),'PLAN_COVERAGE');
 const upstreamEvent={eventId:event.eventId,businessDate:event.businessDate,homeTeamName:event.teams[0],awayTeamName:event.teams[1],
  eventVersion:event.kickoff,leagueName:LEAGUES['kr.1']};
 const adoption=sourcesPolicy.adopt(packets,upstreamEvent,asOf);
 const standings=packets.find(packet=>packet.plan.kind==='standings'),schedules=packets.filter(packet=>packet.plan.kind==='schedule');
 const ranks=JSON.parse(standings.response.raw).data.teamRank;
 check(ranks.every(row=>row.year===approved.season&&row.leagueId===1&&korean.resolveTeamId(row.teamName)===row.teamId),'STANDINGS_SCOPE');
 const observedAt=new Date(Math.min(...schedules.map(packet=>Date.parse(packet.response.receivedAt)))).toISOString();
 const targetDate=new Date(Date.parse(event.kickoff)+9*3600000),targetMonth=String(targetDate.getUTCMonth()+1).padStart(2,'0');
 const current=schedules.find(packet=>packet.plan.year===approved.season&&packet.plan.month===targetMonth);check(current,'CURRENT_SCHEDULE');
 const scheduleRows=schedules.flatMap(packet=>JSON.parse(packet.response.raw).data.scheduleList);
 const native={adapter:VERSION,sourceIds:ordered.map(source=>source.id),authorityHash:hash(authority)};
 const observations=[];
 const teamName=teamId=>{const index=approved.providerTeams.indexOf(teamId);return index<0?teamId:event.teams[index];};
 function add(kind,side,value,sourceId){
  observations.push({id:VERSION+':'+event.eventId+':'+kind+':'+side,kind,side,value,
   summary:'K League 官方原始响应确定性重放；仅单一来源，非双源核实。',sourceId,excerpt:null,eventAt:null,native:structuredClone(native)});
 }
 for(const [index,team] of adoption.teams.entries()){
  const side=index===0?'home':'away';
  add('standings',side,{league:'kr.1',season:competition.season,rank:team.rank,points:team.points,played:team.played,asOf:standings.response.receivedAt},standings.sourceId);
  if(team.lastFive.length!==5)continue;
  const matches=team.lastFive.map(row=>({id:'kleague:'+competition.season+':'+row.gameId,kickoff:row.kickoff,home:teamName(row.home),away:teamName(row.away),score:row.score,resultBasis:'90-minutes'}));
  check(matches.every(row=>Date.parse(row.kickoff)<Date.parse(observedAt)),'RESULT_CLOCK');
  const latest=team.lastFive[0];
  check(!scheduleRows.some(row=>(row.homeTeam===team.teamId||row.awayTeam===team.teamId)
   &&Date.parse(korean.officialKickoffInstant(row))>Date.parse(latest.kickoff)
   &&Date.parse(korean.officialKickoffInstant(row))+100*60000<Date.parse(observedAt)),'LATEST_RESULT_UNVERIFIED');
  add('last-five',side,{scope:'league',matches,asOf:observedAt},current.sourceId);
  add('schedule',side,{restDays:(Date.parse(event.kickoff)-Date.parse(latest.kickoff))/86400000,rotation:'unknown',asOf:observedAt,
   lastCompletedKickoff:latest.kickoff,scope:'league'},current.sourceId);
 }
 return {observations,adoption};
}
function verifyFact(fact,sources,event,competition,asOf,authority){
 exact(fact.native,['adapter','sourceIds','authorityHash']);
 check(fact.native.adapter===VERSION&&fact.native.authorityHash===hash(authority)&&Array.isArray(fact.native.sourceIds)
  &&fact.native.sourceIds.length===4&&new Set(fact.native.sourceIds).size===4&&fact.excerpt===null,'FACT_BINDING');
 const selected=fact.native.sourceIds.map(id=>sources.find(source=>source.id===id));check(selected.every(Boolean),'FACT_SOURCE');
 const expected=replay({sources:selected,event,competition,asOf,authority}).observations.find(item=>item.id===fact.id);
 check(expected&&hash(expected)===hash(fact),'FACT_REPLAY');
 return true;
}
function prepare({packets,event,asOf,reviewedBy,authority}){
 const competition={league:'kr.1',season:String(new Date(Date.parse(event.kickoff)+9*3600000).getUTCFullYear())},sources=packets.map(fromPacket).sort((left,right)=>left.id.localeCompare(right.id));
 const {observations}=replay({sources,event,competition,asOf,authority});
 const sourceRegistry=[{publisherId:'kleague-official',editorialGroup:'kleague',hosts:['www.kleague.com'],role:'official-league'}];
 return require('./reviewedResearchEvidence.cjs').create({event,competition,sourceRegistry,sources,observations,reviewedBy,reviewedAt:asOf,authority});
}
module.exports={VERSION,SOURCE_MAX_AGE_MS,verifyAuthority,verifySource,fromPacket,replay,verifyFact,prepare};
