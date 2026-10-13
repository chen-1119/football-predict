'use strict';
// Isolated draft. No database, filesystem, network or mutation entry point.
// Inputs are exact existing PostgreSQL raw artifact rows, never public views.
const p=require('./reviewedAnalysis.cjs');
const league=require('../../src/services/leagueBaselineRecommendation.cjs');
const {within}=require('./leagueBaselineRuntime.cjs');
const {verifyRow}=require('../postgresPrivateModelArtifactStore.cjs');
const {validDecision}=require('./decision.cjs');
const result=require('./results.cjs');
const {epochNanoseconds:ns}=require('../../src/services/prematchV3Clock.cjs');
const check=(v,reason)=>{if(!v)throw Error('REVIEW_COVERAGE_'+reason);};
const time=s=>{const n=ns(s);check(n!==null,'CLOCK');return n;};
const verifiedRows=new WeakMap();
const attest=row=>{verifiedRows.set(row,p.hash(row));return row;};
const sealOK=v=>{check(v&&typeof v==='object','OBJECT');const {contentHash,...body}=v;check(p.hash(body)===contentHash,'SEAL');};
function eventKey(r){
 const id=String(r.sourceMatchId||r.eventId||'');check(/^[A-Za-z0-9_-]{1,100}$/.test(id),'SOURCE_ID');
 // Preserve all other source namespaces. fivehundred_42 is NOT sporttery_42.
 return JSON.stringify([id.replace(/^sporttery_/,''),new Date(Number(time(r.eventVersion)/1000000n)).toISOString()]);
}
function normalize(track,r,{recordId,recordHash,publishedAt,ackAt,payloadSha256,publicationHash}={}){
 check(/^\d{4}-\d{2}-\d{2}$/.test(r.businessDate||''),'BUSINESS_DATE');
 check(r.homeTeamId&&r.awayTeamId&&r.homeTeamId!==r.awayTeamId,'TEAM_IDENTITY');
 check(['HAD','HHAD'].includes(r.market)&&['1','X','2'].includes(r.tipCode),'MARKET');
 check(Number.isSafeInteger(r.handicapLine)&&(r.market==='HAD'?r.handicapLine===0:r.handicapLine!==0),'LINE');
 check(time(publishedAt)<time(r.cutoffAt||r.cutoffTime)&&time(r.cutoffAt||r.cutoffTime)<=time(r.eventVersion),'PROSPECTIVE');
 return attest({...r,track,eventKey:eventKey(r),recordId,recordHash,publishedAt,ackAt:ackAt||null,
  payloadSha256:payloadSha256||null,publicationHash:publicationHash||null});
}
function reviewed(pair,{asOf,trustRegistry}){
 const saved=verifyRow(pair.recordRow,pair.recordRow?.artifact_key,8*1024*1024),v=saved.payload;
 const ackSaved=verifyRow(pair.ackRow,saved.artifactKey+'-ack',8*1024*1024),ack=ackSaved.payload;
 sealOK(v);sealOK(ack);check(v.version==='reviewed-analysis-freeze-v1'&&ack.version==='reviewed-analysis-ack-v1','MANUAL_VERSION');
 const expectedKey=v.draft.version===3?'reviewed-analysis-'+v.draft.businessDate+'-batch-'+p.hash(v.draft):'reviewed-analysis-'+v.draft.businessDate+'-selected-two';
 check(saved.artifactKey===expectedKey&&v.record.businessDate===v.draft.businessDate&&v.createdAt===v.record.createdAt,'MANUAL_IDENTITY');
 check(p.hash(p.make(v.draft,{...v.inputs,trustRegistry,asOf:v.record.createdAt}))===p.hash(v.record),'MANUAL_REPLAY');
 check(ack.recordKey===saved.artifactKey&&ack.storedSha256===saved.payloadSha256&&ack.recordHash===v.record.contentHash,'ACK_BINDING');
 check(time(v.createdAt)<time(v.storedAt)&&time(v.storedAt)<=time(ack.createdAt)
  &&time(ack.createdAt)-time(v.storedAt)<=30000000000n&&time(ack.createdAt)<=time(asOf),'ACK_CLOCK');
 check(v.record.records.every(r=>time(ack.createdAt)<time(r.cutoffAt)),'ACK_AFTER_CUTOFF');
 return v.record.records.map(r=>normalize('manual',{...r,sourceMatchId:r.eventId,
  tipCode:({h:'1',d:'X',a:'2'})[r.selection],handicapLine:r.market==='HHAD'?r.handicap:0},
 {recordId:saved.artifactKey+'/'+r.eventId,recordHash:p.hash(r),publishedAt:v.record.createdAt,
  ackAt:ack.createdAt,payloadSha256:saved.payloadSha256,publicationHash:v.record.contentHash}));
}
function trained(pair,{asOf,trustRegistry}){
 const saved=verifyRow(pair.recordRow,pair.recordRow?.artifact_key),v=saved.payload,r=v.record;
 const ack=verifyRow(pair.ackRow,saved.artifactKey+'-ack').payload;sealOK(v);sealOK(ack);
 check(v.version==='league-baseline-freeze-v1'&&/^league-forecast-[a-f0-9]{64}$/.test(saved.artifactKey)
  &&r.id===saved.artifactKey&&league.verify(r,{...v.inputs,trustRegistry}),'LEAGUE_REPLAY');
 check(ack.version==='league-baseline-adoption-ack-v1'&&ack.recordKey===r.id&&ack.recordHash===r.contentHash
  &&ack.storedSha256===saved.payloadSha256&&ack.modelHash===r.modelHash&&ack.parametersHash===r.parametersHash
  &&ack.formalEligible===false,'ACK_BINDING');
 within(r,ack.observedAt);check(time(ack.observedAt)>=time(v.storedAt)&&time(ack.observedAt)-time(v.storedAt)<=30000000000n
  &&time(ack.observedAt)<=time(asOf),'ACK_CLOCK');
 // Existing trained direction is explicitly HAD. HHAD comparison is not a pick.
 return [normalize('trained',{...r.forecast.event,market:'HAD',handicapLine:0,tipCode:r.forecast.direction,
  cutoffAt:r.forecast.cutoffAt,modelVersion:r.modelVersion,formalEligible:false},
 {recordId:r.id,recordHash:r.contentHash,publishedAt:r.createdAt,ackAt:ack.observedAt,payloadSha256:saved.payloadSha256})];
}
function old(entry,{asOf}){
 const r=entry.payload;check(validDecision(r)&&time(r.publishedAt)<=time(asOf),'LEGACY_INVALID');
 const sequence=typeof entry.sequence==='string'?entry.sequence:Number.isSafeInteger(entry.sequence)?String(entry.sequence):'';
 check(/^[1-9][0-9]{0,18}$/.test(sequence)&&BigInt(sequence)<=9223372036854775807n,'LEGACY_SEQUENCE');
 return attest({...normalize('legacy',r,{recordId:r.decisionId,recordHash:r.recordHash,publishedAt:r.publishedAt}),sequence});
}
function resultMap(values){
 const map=new Map();for(const e of values){try{const key=eventKey(e),rows=map.get(key)||[];rows.push(e);map.set(key,rows);}catch{/* invalid unknown identity cannot settle an event */}}
 return map;
}
function settle(r,heads,asOf){
 const es=heads.get(r.eventKey)||[];
 if(!es.length)return {state:'PENDING',reason:'verified-result-head-missing'};
 if(new Set(es.map(p.hash)).size!==1)return {state:'DISPUTED',reason:'ambiguous-result-head'};
 const e=es[0];
 if(!result.validResultEvent(e)||ns(e.observedAt)===null||time(e.observedAt)>time(asOf))return {state:'UNKNOWN',reason:'invalid-or-future-result'};
 if(!e.homeTeamId||!e.awayTeamId)return {state:'UNKNOWN',reason:'result-team-id-missing'};
 const s=result.settleDecision(r,e);
 if(['WON','LOST'].includes(s.state)&&Array.isArray(r.scores)){
  const hit=r.scores.map(v=>v[0]===e.scoreHome&&v[1]===e.scoreAway);
  return {...s,scoreTop1:hit[0]===true,scoreTop2:hit.some(Boolean)};
 }return s;
}
function counts(rows){
 const out={publishedRecords:rows.length,distinctEvents:new Set(rows.map(r=>r.eventKey)).size,
  settled:0,won:0,lost:0,pending:0,unknown:0,void:0,disputed:0,hitRate:null,scoreEligible:0,scoreTop1:0,scoreTop2:0};
 for(const r of rows){const s=r.settlement||{state:'PENDING'};const field=({WON:'won',LOST:'lost',PENDING:'pending',UNKNOWN:'unknown',VOID:'void',DISPUTED:'disputed'})[s.state];check(field,'STATE');out[field]++;
  if(['WON','LOST'].includes(s.state)&&Array.isArray(r.scores)){out.scoreEligible++;out.scoreTop1+=Number(s.scoreTop1===true);out.scoreTop2+=Number(s.scoreTop2===true);}}
 out.settled=out.won+out.lost;out.hitRate=out.settled?out.won/out.settled:null;return out;
}
function cohort(rows){const markets={HAD:[],HHAD:[]},days=new Map();for(const r of rows){markets[r.market].push(r);const group=days.get(r.businessDate)||[];group.push(r);days.set(r.businessDate,group);}
 return {...counts(rows),markets:Object.fromEntries(Object.entries(markets).map(([k,v])=>[k,counts(v)])),
 days:[...days.keys()].sort().map(businessDate=>({businessDate,...counts(days.get(businessDate))}))};}
function aggregate({manual=[],trained:models=[],legacy=[],resultHeads=[],asOf,trustRegistry}){
 time(asOf);check([manual,models,legacy,resultHeads].every(Array.isArray),'ARRAY');
 const rows=[],rejected=[];
 for(const [name,inputs,adapter]of [['manual',manual,reviewed],['trained',models,trained],['legacy',legacy,old]]){
  for(const [i,input]of inputs.entries()){try{const values=adapter(input,{asOf,trustRegistry});rows.push(...(Array.isArray(values)?values:[values]));}catch(e){rejected.push({track:name,index:i,reason:String(e.message)});}}
 }
 return aggregateVerified({rows,resultHeads,asOf,rejected});
}
function aggregateVerified({rows,resultHeads,asOf,rejected=[]}){
 time(asOf);check([rows,resultHeads,rejected].every(Array.isArray),'ARRAY');
 for(const row of rows)check(verifiedRows.get(row)===p.hash(row)&&time(row.ackAt||row.publishedAt)<=time(asOf),'UNVERIFIED_OR_CHANGED_ROW');
 const exact=new Map();for(const row of rows){const id=JSON.stringify([row.track,row.recordId]);
  if(exact.has(id))check(exact.get(id).recordHash===row.recordHash,'DUPLICATE_RECORD_CONFLICT');else exact.set(id,row);}
 const identities=new Map(),firstByTrack=new Map();
 for(const row of exact.values()){
  const teams=identities.get(row.eventKey)||new Set();teams.add(JSON.stringify([row.businessDate,row.homeTeamId,row.awayTeamId]));identities.set(row.eventKey,teams);
  if(row.track==='legacy')continue;
  const key=JSON.stringify([row.track,row.eventKey]),at=time(row.publishedAt),first=firstByTrack.get(key);
  if(!first||at<first.at)firstByTrack.set(key,{at,eventKey:row.eventKey,hashes:new Set([row.recordHash])});
  else if(at===first.at)first.hashes.add(row.recordHash);
 }
 const identityConflicts=[...identities].filter(([,teams])=>teams.size>1).map(([k])=>k).sort();
 const selectionConflicts=[...new Set([...firstByTrack.values()].filter(v=>v.hashes.size>1).map(v=>v.eventKey))].sort();
 const selected=new Map(),superseded=[];
 for(const row of exact.values()){
  const id=JSON.stringify([row.track,row.eventKey]),old=selected.get(id);if(!old){selected.set(id,row);continue;}
  // Preserve old latest-sequence evaluation. Manual/model keep their first
  // acknowledged prospective version, never the best outcome after the match.
  const replace=row.track==='legacy'?BigInt(row.sequence)>BigInt(old.sequence):time(row.publishedAt)<time(old.publishedAt)
   ||(time(row.publishedAt)===time(old.publishedAt)&&row.recordHash<old.recordHash);
  if(row.track==='legacy'&&row.sequence===old.sequence)check(row.recordHash===old.recordHash,'LEGACY_SEQUENCE_CONFLICT');
  superseded.push(replace?old:row);if(replace)selected.set(id,row);
 }
 const chosen=[...selected.values()],heads=resultMap(resultHeads);
 const evaluated=chosen.map(r=>({...r,settlement:settle(r,heads,asOf)}));
 const keys=[...new Set(chosen.map(r=>r.eventKey))];
 const identitySet=new Set(identityConflicts),selectionSet=new Set(selectionConflicts),trackCounts=new Map();
 for(const r of evaluated){trackCounts.set(r.eventKey,(trackCounts.get(r.eventKey)||0)+1);
  if(identitySet.has(r.eventKey))r.settlement={state:'DISPUTED',reason:'publication-event-identity-conflict'};
  if(selectionSet.has(r.eventKey)&&r.track!=='legacy')r.settlement={state:'DISPUTED',reason:'ambiguous-first-publication'};
 }
 const tracks=Object.fromEntries(['manual','trained','legacy'].map(t=>[t,cohort(evaluated.filter(r=>r.track===t))]));
 return {version:'published-review-coverage-v1',asOf,complete:rejected.length===0&&identityConflicts.length===0&&selectionConflicts.length===0,
  overall:{distinctEvents:keys.length,selectedTrackRecords:chosen.length,sourceRecords:exact.size,supersededRecords:superseded.length,
   crossTrackDuplicateEvents:[...trackCounts.values()].filter(n=>n>1).length,hitRate:null,
   definition:'source/event union; outcomes reported separately by track and market'},tracks,rows:evaluated,rejected,identityConflicts,selectionConflicts};
}
function manualDisplayArchive({bytes,expectedSha256},coverage){
 check(Buffer.isBuffer(bytes)||typeof bytes==='string','ARCHIVE_BYTES');check(p.sha(bytes)===expectedSha256,'ARCHIVE_PIN');
 const archive=JSON.parse(bytes),v=archive.version;
 check(['selected-reviewed-combinations-v1','published-combo-observation-v1'].includes(v),'ARCHIVE_VERSION');
 const frozenAt=v==='selected-reviewed-combinations-v1'?archive.frozenAt:archive.generatedAt;check(time(frozenAt)<=time(coverage.asOf),'ARCHIVE_FUTURE');
 const rows=coverage.rows.filter(r=>r.track==='manual'&&r.businessDate===archive.businessDate
  &&(v==='selected-reviewed-combinations-v1'?r.payloadSha256===archive.publicationPayloadSha256:r.publicationHash===archive.publicationHash));
 check(rows.length>0,'ARCHIVE_PUBLICATION');
 const combos=[],seen=new Set();
 for(const [size,name]of [[2,'two'],[3,'three']])for(const [index,c]of (archive[name]||[]).entries()){
  if(!c.legs?.length){check(c.product===null,'EMPTY_COMBO');continue;}
  check(c.legs.length===size&&new Set(c.legs.map(l=>l.eventId)).size===size,'COMBO_LEGS');
  const legs=c.legs.map(l=>{const matches=rows.filter(r=>r.eventId===l.eventId);check(matches.length===1,'COMBO_EVENT');const r=matches[0];
   check(r.market===l.market&&r.selection===l.selection&&(r.handicap??null)===(l.handicap??null)&&r.sp===l.sp
    &&(l.quoteHash===undefined||l.quoteHash===r.quoteHash),'COMBO_BINDING');
   check(time(r.ackAt)<=time(frozenAt)&&time(frozenAt)<time(r.cutoffAt),'COMBO_PROSPECTIVE');return r;});
  check(Math.abs(legs.reduce((a,r)=>a*r.sp,1)-c.product)<1e-8,'COMBO_PRODUCT');
  const group=JSON.stringify(legs.map(r=>r.recordId).sort());check(!seen.has(group),'DUPLICATE_COMBO');seen.add(group);
  const states=legs.map(r=>r.settlement.state),state=['DISPUTED','UNKNOWN','VOID','PENDING'].find(s=>states.includes(s))||(states.every(s=>s==='WON')?'WON':'LOST');
  combos.push({id:expectedSha256+'/'+size+'/'+index,size,label:c.label??c.band,product:c.product,
   frozenAt,settlement:{state},scope:'manual-display-archive',formalPublication:false,legs:legs.map(r=>r.recordId)});
 }
 return {version:'manual-display-archive-review-v1',sourceSha256:expectedSha256,businessDate:archive.businessDate,
  formalPublished:0,archived:combos.length,combos,definition:'genuine pre-match display archive; separate from formal combo table'};
}
module.exports={aggregate,aggregateVerified,reviewed,trained,old,eventKey,counts,manualDisplayArchive};
