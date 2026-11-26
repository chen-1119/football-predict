'use strict';
const {hash,sha,seal}=require('./reviewedAnalysis.cjs');
const {epochNanoseconds}=require('../../src/services/prematchV3Clock.cjs');
const VERSION='reviewed-research-evidence-v1';
const MAX_BYTES=4*1024*1024,MAX_SOURCE_BYTES=2*1024*1024,NEWS_AGE_MS=3*86400000,SOURCE_AGE_MS=86400000;
const KINDS=['last-five','standings','head-to-head','availability','lineup','schedule'];
const check=(value,code)=>{if(!value)throw Object.assign(Error('RESEARCH_EVIDENCE_'+code),{code:'RESEARCH_EVIDENCE_'+code});};
const text=(value,max=500)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\x00-\x1f\ufffd]/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const clock=value=>{check(typeof value==='string'&&epochNanoseconds(value)!==null,'CLOCK');return Date.parse(value);};
const exact=(value,keys)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(','),'FIELDS');
function url(value){try{const parsed=new URL(value);check(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.port&&!parsed.hash,'URL');return parsed;}catch{check(false,'URL');}}
function event(value){
 exact(value,['eventId','matchNum','businessDate','kickoff','teams','orderedTeamIds']);
 check(/^[1-9]\d{0,19}$/.test(value.eventId)&&text(value.matchNum,30)&&/^\d{4}-\d{2}-\d{2}$/.test(value.businessDate),'EVENT');
 check(new Date(value.businessDate+'T00:00:00Z').toISOString().slice(0,10)===value.businessDate,'EVENT');clock(value.kickoff);
 check(Array.isArray(value.teams)&&value.teams.length===2&&value.teams.every(name=>text(name,100))&&value.teams[0]!==value.teams[1]
  &&Array.isArray(value.orderedTeamIds)&&value.orderedTeamIds.length===2&&value.orderedTeamIds.every(id=>Number.isSafeInteger(id)&&id>0)&&value.orderedTeamIds[0]!==value.orderedTeamIds[1],'TEAMS');
 return value;
}
function registry(value){
 check(Array.isArray(value)&&value.length>0&&value.length<=32,'REGISTRY');
 const seen=new Set();
 for(const entry of value){
  exact(entry,['publisherId','editorialGroup','hosts','role']);
  check(text(entry.publisherId,100)&&!seen.has(entry.publisherId)&&text(entry.editorialGroup,100),'REGISTRY');seen.add(entry.publisherId);
  check(['official-club','official-league','statistics','independent-media'].includes(entry.role)&&Array.isArray(entry.hosts)&&entry.hosts.length>0&&entry.hosts.length<=8
   &&entry.hosts.every(host=>typeof host==='string'&&/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)&&host.includes('.')&&!host.includes('..')),'REGISTRY');
 }
 for(const left of value)for(const right of value)if(left.publisherId!==right.publisherId){
  const sharedFamily=left.hosts.some(first=>right.hosts.some(second=>first.split('.').slice(-2).join('.')===second.split('.').slice(-2).join('.')));
  check(!sharedFamily||left.editorialGroup===right.editorialGroup,'HOST_OWNER_CONFLICT');
 }
 const approved=require('./reviewedResearchPublishers.cjs');
 for(const entry of value){
  const trusted=approved.find(item=>item.publisherId===entry.publisherId);
  check(trusted&&entry.editorialGroup===trusted.editorialGroup&&entry.role===trusted.role
   &&entry.hosts.every(host=>trusted.hosts.some(root=>host===root||host.endsWith('.'+root))),'PUBLISHER_UNAPPROVED');
 }
 return value;
}
function span(raw,value){
 exact(value,['start','end','text']);
 check(Number.isSafeInteger(value.start)&&Number.isSafeInteger(value.end)&&value.start>=0&&value.end>value.start&&value.end<=raw.length
  &&typeof value.text==='string'&&Buffer.byteLength(value.text)<=8192&&raw.subarray(value.start,value.end).equals(Buffer.from(value.text)),'EXCERPT');
}
function source(value,entries,at){
 exact(value,['id','url','publisherId','provenance','originPublisherId','originUrl','originId','rawBase64','rawSha256','rawBytes','requestedAt','receivedAt','publishedAt','publicationExcerpt',...(value.native!==undefined?['native']:[])]);
 check(text(value.id,100)&&['original','syndicated','unknown'].includes(value.provenance),'SOURCE');
 const publisher=entries.find(entry=>entry.publisherId===value.publisherId),address=url(value.url);
 check(publisher&&publisher.hosts.includes(address.hostname),'PUBLISHER');
 check(typeof value.rawBase64==='string'&&value.rawBase64.length<=Math.ceil(MAX_SOURCE_BYTES/3)*4,'RAW_BOUND');
 const raw=Buffer.from(value.rawBase64,'base64');
 check(raw.length>0&&raw.length<=MAX_SOURCE_BYTES&&value.rawBase64===raw.toString('base64')&&raw.length===value.rawBytes&&hex(value.rawSha256)&&sha(raw)===value.rawSha256,'RAW_BINDING');
 const requested=clock(value.requestedAt),received=clock(value.receivedAt);
 check(requested<=received&&received<=at,'SOURCE_CLOCK');
 if(value.publishedAt!==null){check(clock(value.publishedAt)<=received,'PUBLICATION_CLOCK');span(raw,value.publicationExcerpt);
  check(clock(value.publicationExcerpt.text)===clock(value.publishedAt),'PUBLICATION_EXCERPT_CLOCK');}
 else check(value.publicationExcerpt===null,'PUBLICATION_CLOCK');
 if(value.provenance==='unknown')check(value.originPublisherId===null&&value.originUrl===null&&value.originId===null,'ORIGIN');
 else{
  const origin=entries.find(entry=>entry.publisherId===value.originPublisherId),originAddress=url(value.originUrl);
  check(origin&&origin.hosts.includes(originAddress.hostname)&&text(value.originId,200),'ORIGIN');
  if(value.provenance==='original')check(value.publisherId===value.originPublisherId,'ORIGIN');
 }
 if(value.native!==undefined)require('./reviewedResearchKLeague.cjs').verifySource(value);
 return value;
}
function matchRows(rows,at,count){
 check(Array.isArray(rows)&&rows.length===count&&count>0&&count<=10,'MATCH_ROWS');
 const seen=new Set();
 for(const row of rows){
  exact(row,['id','kickoff','home','away','score','resultBasis']);
  check(text(row.id,120)&&!seen.has(row.id)&&clock(row.kickoff)<at&&text(row.home,100)&&text(row.away,100)&&row.home!==row.away,'MATCH_ROWS');seen.add(row.id);
  check(row.resultBasis==='90-minutes'&&Array.isArray(row.score)&&row.score.length===2&&row.score.every(goal=>Number.isInteger(goal)&&goal>=0&&goal<=30),'SCORE_BASIS');
 }
 check(rows.every((row,index)=>index===0||clock(rows[index-1].kickoff)>=clock(row.kickoff)),'MATCH_ORDER');
}
function fact(value,sources,at,identity,competition,authority){
 exact(value,['id','kind','side','value','summary','sourceId','excerpt','eventAt',...(value.native!==undefined?['native']:[])]);
 check(text(value.id,100)&&KINDS.includes(value.kind)&&['home','away','both'].includes(value.side)&&text(value.summary,1000),'FACT');
 check(value.kind==='head-to-head'?value.side==='both':value.side!=='both','FACT_SIDE');
 const origin=sources.find(item=>item.id===value.sourceId);check(origin,'FACT_SOURCE');
 if(value.native!==undefined)require('./reviewedResearchKLeague.cjs').verifyFact(value,sources,identity,competition,new Date(at).toISOString(),authority);
 else{
 span(Buffer.from(origin.rawBase64,'base64'),value.excerpt);
 let parsed;try{parsed=JSON.parse(value.excerpt.text);}catch{check(false,'TYPED_FACT_REQUIRED');}
 exact(parsed,['subject','kind','value']);
 check(parsed.kind===value.kind&&hash(parsed.subject)===hash({eventId:identity.eventId,kickoff:identity.kickoff,
  orderedTeamIds:identity.orderedTeamIds,teams:identity.teams,league:competition.league,season:competition.season,side:value.side}),'FACT_SUBJECT_BINDING');
 check(hash(parsed.value)===hash(value.value),'FACT_VALUE_BINDING');
 }
 if(value.eventAt!==null)check(clock(value.eventAt)<=at,'EVENT_CLOCK');
 const body=value.value;
 if(value.kind==='last-five'){
  exact(body,['scope','matches','asOf']);check(['league','all-competitive'].includes(body.scope)&&clock(body.asOf)<=at,'FORM_SCOPE');matchRows(body.matches,clock(body.asOf),5);
  check(body.matches.every(row=>[row.home,row.away].includes(identity.teams[value.side==='home'?0:1])),'FACT_TEAM');
 }else if(value.kind==='head-to-head'){
  exact(body,['scope','matches']);check(body.scope==='competitive','FORM_SCOPE');matchRows(body.matches,at,body.matches?.length);
  check(body.matches.every(row=>[row.home,row.away].includes(identity.teams[0])&&[row.home,row.away].includes(identity.teams[1])),'FACT_TEAM');
 }else if(value.kind==='standings'){
  exact(body,['league','season','rank','points','played','asOf']);
  check(text(body.league,100)&&text(body.season,30)&&Number.isInteger(body.rank)&&body.rank>0&&body.rank<=100&&Number.isInteger(body.points)&&Math.abs(body.points)<=300
   &&Number.isInteger(body.played)&&body.played>=0&&body.played<=100&&clock(body.asOf)<=at
   &&body.league===competition.league&&body.season===competition.season,'STANDINGS');
 }else if(value.kind==='availability'){
  exact(body,['complete','players']);check(typeof body.complete==='boolean'&&Array.isArray(body.players)&&body.players.length<=40,'AVAILABILITY');
  check(body.players.every(player=>{exact(player,['name','status']);return text(player.name,100)&&['out','doubtful','available','suspended'].includes(player.status);})
   &&new Set(body.players.map(player=>player.name)).size===body.players.length,'AVAILABILITY');
 }else if(value.kind==='lineup'){
  exact(body,['status','players']);check(['predicted','confirmed'].includes(body.status)&&Array.isArray(body.players)&&body.players.length===11
   &&body.players.every(player=>text(player,100))&&new Set(body.players).size===11,'LINEUP');
 }else{
  exact(body,['restDays','rotation','asOf','lastCompletedKickoff','scope']);check(typeof body.restDays==='number'&&Number.isFinite(body.restDays)&&body.restDays>=0&&body.restDays<=60&&['unknown','reported','confirmed'].includes(body.rotation)
   &&['league','all-competitive'].includes(body.scope)&&clock(body.asOf)<=at&&clock(body.lastCompletedKickoff)<clock(body.asOf),'SCHEDULE');
 }
 return value;
}
function validate(packet,asOf){
 exact(packet,['version','createdAt','event','competition','sourceRegistry','sources','observations','reviewedBy','reviewedAt','verification','modelProbability','expectedValue','formalEligible','contentHash',...(packet.authority!==undefined?['authority']:[])]);
 check(packet.version===VERSION&&packet.verification==='human-reviewed-literal-evidence'&&packet.modelProbability===null&&packet.expectedValue===null&&packet.formalEligible===false,'VERSION');
 const {contentHash,...body}=packet;check(hex(contentHash)&&hash(body)===contentHash&&Buffer.byteLength(JSON.stringify(packet))<=MAX_BYTES,'HASH_BOUND');
 const at=clock(packet.reviewedAt);check(packet.createdAt===packet.reviewedAt&&at<=clock(asOf)&&text(packet.reviewedBy,100),'REVIEW');event(packet.event);registry(packet.sourceRegistry);
 exact(packet.competition,['league','season']);check(text(packet.competition.league,100)&&text(packet.competition.season,30),'COMPETITION');
 check(Array.isArray(packet.sources)&&packet.sources.length>0&&packet.sources.length<=16&&new Set(packet.sources.map(item=>item.id)).size===packet.sources.length,'SOURCE_BOUND');
 for(const item of packet.sources)source(item,packet.sourceRegistry,at);
 check(Array.isArray(packet.observations)&&packet.observations.length<=128&&new Set(packet.observations.map(item=>item.id)).size===packet.observations.length,'FACT_BOUND');
 if(packet.authority!==undefined)require('./reviewedResearchKLeague.cjs').verifyAuthority(packet.authority,packet.event,packet.competition,packet.reviewedAt);
 for(const item of packet.observations)fact(item,packet.sources,at,packet.event,packet.competition,packet.authority);
 return true;
}
function create(input){
 exact(input,['event','competition','sourceRegistry','sources','observations','reviewedBy','reviewedAt',...(input.authority!==undefined?['authority']:[])]);
 const packet=seal({version:VERSION,createdAt:input.reviewedAt,...structuredClone(input),verification:'human-reviewed-literal-evidence',modelProbability:null,expectedValue:null,formalEligible:false});
 validate(packet,packet.reviewedAt);return packet;
}
function independent(sources,entries){
 const groups=[];
 for(const item of sources){
  if(item.provenance==='unknown')continue;
  const publisher=entries.find(entry=>entry.publisherId===item.publisherId),origin=entries.find(entry=>entry.publisherId===item.originPublisherId);
  const keys=new Set(['owner:'+publisher.editorialGroup,'owner:'+origin.editorialGroup,'origin:'+item.originUrl,'identity:'+item.originId,'body:'+item.rawSha256]);
  const matching=groups.filter(group=>[...keys].some(key=>group.has(key)));
  for(const group of matching){for(const key of group)keys.add(key);groups.splice(groups.indexOf(group),1);}groups.push(keys);
 }
 return groups.length;
}
function semanticFact(kind,value){
 const result=structuredClone(value);
 if(['last-five','standings','schedule'].includes(kind))delete result.asOf;
 if(['last-five','head-to-head'].includes(kind))result.matches=result.matches.map(({id,...row})=>{void id;return row;});
 if(kind==='availability')result.players.sort((left,right)=>left.name.localeCompare(right.name));
 if(kind==='lineup')result.players.sort();
 return result;
}
function assess(packet,asOf){
 validate(packet,asOf);const at=clock(asOf),fields=[],limitations=[];
 for(const kind of KINDS)for(const side of kind==='head-to-head'?['both']:['home','away']){
  const observations=packet.observations.filter(item=>item.kind===kind&&item.side===side);
  const usable=observations.filter(item=>{const page=packet.sources.find(source=>source.id===item.sourceId);
   return at-clock(page.receivedAt)<=(page.native!==undefined?require('./reviewedResearchKLeague.cjs').SOURCE_MAX_AGE_MS:SOURCE_AGE_MS)
    &&(item.native===undefined||item.native.sourceIds.every(id=>at-clock(packet.sources.find(source=>source.id===id).receivedAt)<=require('./reviewedResearchKLeague.cjs').SOURCE_MAX_AGE_MS))
    &&(!['availability','lineup'].includes(kind)||page.publishedAt!==null&&at-clock(page.publishedAt)<=NEWS_AGE_MS)
    &&(kind!=='schedule'||at-clock(item.value.asOf)<=SOURCE_AGE_MS);});
  const values=new Set(usable.map(item=>hash(semanticFact(kind,item.value)))),pages=usable.map(item=>packet.sources.find(page=>page.id===item.sourceId));
  const count=independent(pages,packet.sourceRegistry),primary=pages.some(page=>page.provenance==='original'&&packet.sourceRegistry.find(entry=>entry.publisherId===page.publisherId).role.startsWith('official-'));
  let status=values.size>1?'conflict':count>=2?'dual-source':primary&&usable.length?'single-primary':usable.length?'single-source':observations.length?'stale':'missing';
  if(kind==='lineup'&&status!=='conflict'&&usable.length&&usable[0].value.status==='confirmed'&&!primary)status='unconfirmed';
  const representative=usable.slice().sort((left,right)=>{
   if(['last-five','standings','schedule'].includes(kind))return clock(left.value.asOf)-clock(right.value.asOf)||left.id.localeCompare(right.id);
   return left.id.localeCompare(right.id);
  })[0];
  const value=values.size===1?structuredClone(representative.value):null;
  fields.push({key:kind+':'+side,kind,side,status,independentSourceCount:count,value,observationIds:usable.map(item=>item.id)});
  if(status!=='dual-source'&&!(kind==='availability'&&status==='single-primary')&&!(kind==='lineup'&&status==='single-primary'&&value?.status==='confirmed'))limitations.push(kind+':'+side+':'+status);
  if(kind==='lineup'&&value?.status!=='confirmed')limitations.push('lineup:'+side+':not-confirmed');
  if(kind==='availability'&&value?.complete!==true)limitations.push('availability:'+side+':incomplete');
  if(['availability','lineup'].includes(kind)&&usable.some(item=>item.eventAt===null))limitations.push(kind+':'+side+':event-time-unknown');
 }
 for(const side of ['home','away']){
  const form=fields.find(field=>field.key==='last-five:'+side),schedule=fields.find(field=>field.key==='schedule:'+side);
  if(form.status==='dual-source'&&(!['dual-source','single-primary'].includes(schedule.status)||form.value.scope!==schedule.value?.scope
   ||clock(form.value.matches[0].kickoff)!==clock(schedule.value?.lastCompletedKickoff)||clock(form.value.asOf)<clock(schedule.value?.lastCompletedKickoff))){
   form.status='latest-schedule-unverified';limitations.push('last-five:'+side+':latest-schedule-unverified');
  }
  const standings=fields.find(field=>field.key==='standings:'+side);
  if(standings.status==='dual-source'&&(!['dual-source','single-primary'].includes(schedule.status)||schedule.value?.scope!=='league'
   ||clock(standings.value.asOf)<clock(schedule.value.lastCompletedKickoff))){
   standings.status='latest-schedule-unverified';limitations.push('standings:'+side+':latest-schedule-unverified');
  }
 }
 const core=['last-five:home','last-five:away','standings:home','standings:away','head-to-head:both'];
 const coreComplete=core.every(key=>fields.find(field=>field.key===key).status==='dual-source');
 const availabilityComplete=['home','away'].every(side=>{const field=fields.find(item=>item.key==='availability:'+side);return ['dual-source','single-primary'].includes(field.status)&&field.value?.complete===true;});
 const lineupsConfirmed=['home','away'].every(side=>{const field=fields.find(item=>item.key==='lineup:'+side);return ['dual-source','single-primary'].includes(field.status)&&field.value?.status==='confirmed';});
 const usedIds=new Set(fields.filter(field=>['dual-source','single-primary'].includes(field.status)).flatMap(field=>field.observationIds));
 const usedSourceIds=new Set(packet.observations.filter(item=>usedIds.has(item.id)).map(item=>item.sourceId));
 const sourceCount=independent(packet.sources.filter(page=>usedSourceIds.has(page.id)),packet.sourceRegistry);
 const hasConflict=fields.some(field=>field.status==='conflict');
 return seal({version:'reviewed-research-assessment-v1',evidenceHash:packet.contentHash,asOf,fields,limitations:[...new Set(limitations)],coreComplete,availabilityComplete,lineupsConfirmed,hasConflict,
  independentSourceCount:sourceCount,directionEligible:sourceCount>=2&&fields.some(field=>['dual-source','single-primary'].includes(field.status))&&!hasConflict,
  comboEligible:coreComplete&&availabilityComplete&&!hasConflict,comboPolicy:'dual-core-current-availability-v1',modelProbability:null,expectedValue:null,formalEligible:false});
}
async function archive(client,packet,asOf){
 validate(packet,asOf);const stored=await require('../teamEvidenceStore.cjs').insert(client,'team-evidence-'+packet.contentHash,packet,asOf);
 check(stored.payloadJson===JSON.stringify(packet),'ARCHIVE_ROUNDTRIP');
 return {key:stored.artifactKey,payloadSha256:stored.payloadSha256,contentHash:packet.contentHash,archiveOnly:true,commitAcknowledged:false,published:false};
}
async function loadForDraft(client,draft,asOf){
 check(draft?.version===5&&Array.isArray(draft.research?.evidenceKeys)&&draft.research.evidenceKeys.length>0&&draft.research.evidenceKeys.length<=32,'DRAFT_KEYS');
 const result={};let total=0;
 for(const key of draft.research.evidenceKeys){
  check(/^team-evidence-[a-f0-9]{64}$/.test(key),'DRAFT_KEYS');
  const bounds=(await client.query('SELECT payload_bytes,octet_length(payload::text) AS actual_bytes FROM football.private_model_artifacts WHERE artifact_key=$1',[key])).rows;
  check(bounds.length===1&&Number.isSafeInteger(Number(bounds[0].payload_bytes))&&Number(bounds[0].payload_bytes)>0&&Number(bounds[0].payload_bytes)<=MAX_BYTES
   &&Number(bounds[0].payload_bytes)===Number(bounds[0].actual_bytes)&&(total+=Number(bounds[0].payload_bytes))<=8*1024*1024,'STORED_BOUND');
  const row=await require('../teamEvidenceStore.cjs').read(client,key);
  check(row&&row.artifactVersion===VERSION&&clock(row.updatedAt)<=clock(asOf),'STORED_IDENTITY');
  const packet=row.payload;validate(packet,asOf);check(key==='team-evidence-'+packet.contentHash&&!result[packet.event.eventId]
   &&row.generatedAt===packet.createdAt&&clock(row.generatedAt)<=clock(row.updatedAt),'STORED_IDENTITY');
  result[packet.event.eventId]=[packet];
 }
 return result;
}
module.exports={VERSION,MAX_BYTES,MAX_SOURCE_BYTES,NEWS_AGE_MS,SOURCE_AGE_MS,KINDS,check,text,clock,event,create,validate,assess,independent,archive,loadForDraft};
