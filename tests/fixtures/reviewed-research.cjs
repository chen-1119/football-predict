'use strict';
const publisherModule=require.resolve('../../scripts/recommendationPlatform/reviewedResearchPublishers.cjs');
const approvedPublishers=require(publisherModule);
require.cache[publisherModule].exports=[...approvedPublishers,
 {publisherId:'official-a',editorialGroup:'owner-a',hosts:['official-a.test'],role:'official-league'},
 {publisherId:'statistics-b',editorialGroup:'owner-b',hosts:['statistics-b.test'],role:'statistics'},
 {publisherId:'statistics-a',editorialGroup:'owner-a',hosts:['official-a.test'],role:'statistics'},
 {publisherId:'same-owner-b',editorialGroup:'owner-a',hosts:['statistics-b.test'],role:'statistics'}];
const official=require('./reviewed-official-event.cjs');
const evidence=require('../../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const decision=require('../../scripts/recommendationPlatform/reviewedResearchDecision.cjs');
const {sha}=require('../../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const stamp=official.stamp,NOW=official.NOW;
function excerpt(raw,text){const start=raw.indexOf(Buffer.from(text));if(start<0)throw Error('synthetic excerpt missing');return {start,end:start+Buffer.byteLength(text),text};}
function typed(input,item){
 return {subject:{eventId:input.event.eventId,kickoff:input.event.kickoff,orderedTeamIds:input.event.orderedTeamIds,teams:input.event.teams,
  league:input.competition.league,season:input.competition.season,side:item.side},kind:item.kind,value:item.value};
}
function input(single){
 const {eventId,matchNum,businessDate,kickoff,teams,orderedTeamIds}=single;
 const identity={event:{eventId,matchNum,businessDate,kickoff,teams,orderedTeamIds},competition:{league:'Synthetic league',season:'2026'}};
 const values=[];
 for(const side of ['home','away']){
  const matches=Array.from({length:5},(_,index)=>({id:side+'-'+index,kickoff:stamp(NOW-(index*7+3)*86400000),home:teams[side==='home'?0:1],away:'Opponent '+index,score:[2,1],resultBasis:'90-minutes'}));
  values.push({kind:'last-five',side,value:{scope:'league',matches,asOf:stamp(NOW-5000)}});
  values.push({kind:'standings',side,value:{league:'Synthetic league',season:'2026',rank:side==='home'?2:8,points:side==='home'?20:10,played:10,asOf:stamp(NOW-5000)}});
  values.push({kind:'availability',side,value:{complete:true,players:[]}});
  values.push({kind:'lineup',side,value:{status:'predicted',players:Array.from({length:11},(_,index)=>side+' player '+index)}});
  values.push({kind:'schedule',side,value:{restDays:3,rotation:'unknown',asOf:stamp(NOW-5000),lastCompletedKickoff:matches[0].kickoff,scope:'league'}});
 }
 values.push({kind:'head-to-head',side:'both',value:{scope:'competitive',matches:[{id:'past-h2h',kickoff:stamp(NOW-180*86400000),home:teams[0],away:teams[1],score:[1,1],resultBasis:'90-minutes'}]}});
 const publishedAt=stamp(NOW-3600000),sources=[],observations=[];
 for(const publisherId of ['official-a','statistics-b']){
  const raw=Buffer.from(publisherId+' '+publishedAt+'\n'+values.map(item=>JSON.stringify(typed(identity,item))).join('\n'));
  const address='https://'+publisherId+'.test/event/'+eventId;
  sources.push({id:publisherId,url:address,publisherId,provenance:'original',originPublisherId:publisherId,originUrl:address,originId:publisherId+'-'+eventId,
   rawBase64:raw.toString('base64'),rawSha256:sha(raw),rawBytes:raw.length,requestedAt:stamp(NOW-7000),receivedAt:stamp(NOW-6000),publishedAt,publicationExcerpt:excerpt(raw,publishedAt)});
  for(const item of values)observations.push({id:item.kind+'-'+item.side+'-'+publisherId,...structuredClone(item),summary:'Synthetic '+item.kind+' '+item.side,sourceId:publisherId,
   excerpt:excerpt(raw,JSON.stringify(typed(identity,item))),eventAt:item.kind==='availability'?null:stamp(NOW-3600000)});
 }
 return {...identity,sourceRegistry:[
  {publisherId:'official-a',editorialGroup:'owner-a',hosts:['official-a.test'],role:'official-league'},
  {publisherId:'statistics-b',editorialGroup:'owner-b',hosts:['statistics-b.test'],role:'statistics'}],sources,observations,reviewedBy:'synthetic-reviewer',reviewedAt:stamp(NOW-4000)};
}
function rebuildRaw(input){
 for(const source of input.sources){
  const facts=input.observations.filter(item=>item.sourceId===source.id);
  const raw=Buffer.from(source.publisherId+' '+source.publishedAt+'\n'+facts.map(item=>JSON.stringify(typed(input,item))).join('\n'));
  Object.assign(source,{rawBase64:raw.toString('base64'),rawSha256:sha(raw),rawBytes:raw.length,publicationExcerpt:excerpt(raw,source.publishedAt)});
  for(const item of facts)item.excerpt=excerpt(raw,JSON.stringify(typed(input,item)));
 }
 return input;
}
function setup(){
 const context=official.setup();
 const inputs=context.draft.singles.map(input),packets=inputs.map(value=>evidence.create(value));
 const directions=packets.map((packet,index)=>decision.choose(packet,{market:index?'HHAD':'HAD',handicap:index?-1:null,selection:index?'a':'h',scores:index?[[1,1],[1,2]]:[[2,0],[2,1]],
  reason:'Synthetic direction based on cited facts, not prices',confidence:'中',basisIds:['last-five-home-official-a','last-five-away-statistics-b'],comboAllowed:true},stamp(NOW-3000)));
 return {context,inputs,packets,directions};
}
function fakeClient(){
 const rows=new Map(),queries=[];
 return {rows,queries,async query(sql,params){
  queries.push(sql);
  if(sql.includes('INSERT INTO football.private_model_artifacts')){
   if(sql.includes('ON CONFLICT'))throw Error('unexpected mutable write');
   const [key,version,created,updated,json,digest,bytes]=params;if(rows.has(key))throw Error('duplicate insert');
   rows.set(key,{artifact_key:key,artifact_version:version,generated_at:created,updated_at:updated,payload_json:json,payload_sha256:digest,payload_bytes:bytes});return {rows:[]};
  }
  const found=rows.get(params[0]);
  if(sql.includes('octet_length'))return {rows:found?[{payload_bytes:found.payload_bytes,actual_bytes:Buffer.byteLength(found.payload_json)}]:[]};
  if(sql.startsWith('SELECT'))return {rows:found?[structuredClone(found)]:[]};
  throw Error('unexpected synthetic SQL');
 }};
}
module.exports={setup,input,excerpt,rebuildRaw,fakeClient,NOW,stamp};
