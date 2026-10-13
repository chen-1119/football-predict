'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const f=require('./fixtures/coverageFixtures.cjs'),{client}=require('./fixtures/coverageClient.cjs');
const adapter=require('../scripts/recommendationPlatform/publishedReviewCoverageRepository.cjs');
const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
const {collectResults}=require('../scripts/recommendationPlatform/results.cjs');
const target=v=>{const r=v.record.records[0];return {sourceMatchId:r.eventId,eventVersion:r.eventVersion,businessDate:r.businessDate,homeTeamId:r.homeTeamId,awayTeamId:r.awayTeamId};};
function historyDB(v,{pairs=[v.manual],legacyRows=[],candidates=[]}={}){
 const db=client({pairs}),query=db.query.bind(db);
 db.query=async(sql,args=[])=>{
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:v.asOf}]};
  if(sql.startsWith('SELECT m.payload FROM football.match_snapshots m'))return {rows:legacyRows.map(payload=>({payload}))};
  if(sql.includes('JOIN jsonb_to_recordset')){db.log.push({sql,args});return {rows:candidates.filter(r=>r.id>args[1]).sort((x,y)=>x.id<y.id?-1:1).slice(0,args[2])};}
  return query(sql,args);
 };return db;
}
test('detail reads original completed event record plus second ACK and original SP, never current quote',async()=>{
 const v=f.setup(),db=client({pairs:[v.manual,f.trained(v)]});
 const r=await adapter.loadVerifiedPublicationForIdentity(db,{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:target(v)});
 a.equal(r.publications.length,2);const manual=r.publications.find(r=>r.track==='manual');a.deepEqual(manual.record,v.record.records[0]);
 a.equal(manual.ack.storedSha256,manual.publication.payloadSha256);a.equal(manual.publication.recordHash,v.record.contentHash);
 a.equal(r.publications.find(r=>r.track==='trained').record.forecast.event.sourceMatchId,target(v).sourceMatchId);
 a.equal(db.log.some(q=>q.sql.includes('recommendation_decisions')||q.sql.includes('recommendation_result_heads')),false);
 const page=db.log.find(q=>q.sql.includes('artifact_key COLLATE "C">'));a.equal(page.args[2],target(v).businessDate);a.match(page.sql,/artifact_key LIKE 'reviewed-analysis-'/);
});
test('detail rejects incorrect ordered teams, cannot silently convert known event conflict into missing',async()=>{const v=f.setup(),t=target(v);await a.rejects(adapter.loadVerifiedPublicationForIdentity(client({pairs:[v.manual]}),{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:{...t,homeTeamId:t.awayTeamId,awayTeamId:t.homeTeamId}}),/IDENTITY_CONFLICT/);});
test('detail rescheduled event does not inherit a previous version recommendation',async()=>{const v=f.setup(),t=target(v);const r=await adapter.loadVerifiedPublicationForIdentity(client({pairs:[v.manual]}),{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:{...t,eventVersion:f.stamp(Date.parse(t.eventVersion)+86400000)}});a.deepEqual(r.publications,[]);});
test('detail missing ACK fails explicitly without reconstructing an acknowledged publication',async()=>{const v=f.setup();await a.rejects(adapter.loadVerifiedPublicationForIdentity(client({pairs:[{recordRow:v.manual.recordRow}]}),{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:target(v)}),/INCOMPLETE/);});
test('detail refuses fivehundred suffix identity alias',async()=>{const v=f.setup();await a.rejects(adapter.loadVerifiedPublicationForIdentity(client({pairs:[v.manual]}),{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:{...target(v),sourceMatchId:'fivehundred_'+target(v).sourceMatchId}}),/TARGET_IDENTITY/);});
test('detail candidate query includes exact event across business dates and rejects a mismatched requested day',async()=>{
 const v=f.setup(),db=client({pairs:[v.manual]}),t={...target(v),businessDate:'2026-09-16'};
 await a.rejects(adapter.loadVerifiedPublicationForIdentity(db,{asOf:v.asOf,trustRegistry:v.trustRegistry,targetIdentity:t}),/IDENTITY_CONFLICT/);
 const q=db.log.find(q=>q.sql.includes('artifact_key COLLATE "C">'));a.match(q.sql,/json_array_elements\(payload->'record'->'records'\)/);a.match(q.sql,/entry->>'eventId'=\$4 AND entry->>'eventVersion'=\$5/);a.deepEqual(q.args.slice(2),[t.businessDate,t.sourceMatchId,new Date(t.eventVersion).toISOString()]);
});
test('history includes verified exact events and preserves original cohort, while rejecting foreign identities',async()=>{
 const v=f.setup(),t=target(v),good={...v.matches[0],businessDate:t.businessDate,eventVersion:t.eventVersion},old={id:'old-preserved'};
 const candidates=[good,{...good,eventVersion:f.stamp(Date.parse(t.eventVersion)+86400000)},{...good,homeTeamId:t.awayTeamId,awayTeamId:t.homeTeamId},{...good,businessDate:'2026-09-18'},{...good,sourceMatchId:'fivehundred_'+t.sourceMatchId}].map((payload,i)=>({id:'row'+i,payload}));
 const db=historyDB(v,{legacyRows:[old,good],candidates}),repo=new Repository(db,{trustRegistry:v.trustRegistry});
 const r=await repo.history();a.deepEqual(r,[old,good]);const q=db.log.find(q=>q.sql.includes('jsonb_to_recordset'));a.match(q.sql,/m.source_match_id=e\."sourceMatchId" AND m.kickoff_time=e\."eventVersion"/);a.match(q.sql,/m.payload->>'homeTeamId'/);
 a.equal(db.log.some(q=>/INSERT|UPDATE|DELETE/.test(q.sql)),false);
});
test('history missing ACK prevents silently settling an unacknowledged event',async()=>{const v=f.setup(),db=historyDB(v,{pairs:[{recordRow:v.manual.recordRow}]});await a.rejects(new Repository(db,{trustRegistry:v.trustRegistry}).history(),{code:'COVERAGE_HISTORY_INCOMPLETE'});a.equal(db.log.some(q=>q.sql.includes('jsonb_to_recordset')),false);});
test('new history candidates still require original official result validator, unknown result never becomes loss',async()=>{
 const v=f.setup(),good={...v.matches[0],status:'FINISHED',scoreHome:2,scoreAway:0,resultRevision:1};
 const rows=await new Repository(historyDB(v,{candidates:[{id:'one',payload:good}]}),{trustRegistry:v.trustRegistry}).history();a.equal(rows.length,1);
 const denied=collectResults(rows,new Map(),{isFinal:()=>false,isVoid:()=>false},Date.parse(v.asOf));a.equal(denied.updates.length,0);
 const admitted=collectResults(rows,new Map(),{isFinal:()=>true,isVoid:()=>false},Date.parse(v.asOf));a.equal(admitted.updates.length,1);a.equal(admitted.updates[0].sourceMatchId,target(v).sourceMatchId);
});
test('history paginates candidate snapshots without hiding conflicting score copies',async()=>{
 const v=f.setup(),good=v.matches[0],candidates=Array.from({length:65},(_,i)=>({id:String(i).padStart(3,'0'),payload:{...good,resultRevision:i}})),db=historyDB(v,{candidates});
 const rows=await new Repository(db,{trustRegistry:v.trustRegistry}).history();a.equal(rows.length,65);a.equal(db.log.filter(q=>q.sql.includes('jsonb_to_recordset')).length,2);
});
test('review API exposes all three tracks in the same read-only transaction and keeps old statistics intact',async()=>{
 const v=f.setup(),legacy=f.legacy(),db=client({pairs:[v.manual,f.trained(v)],legacy:[legacy]}),query=db.query.bind(db),commands=[];
 db.query=async(sql,args=[])=>{commands.push(sql);
  if(sql.startsWith('BEGIN ')||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes("set_config('statement_timeout'"))return {rows:[]};
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(v.asOf)}]};
  if(sql.includes('daily_featured_combo_state'))return {rows:[{payload:{recommendationCenter:{version:'recommendation-center-v1',updatedAt:v.asOf}}}]};
  if(sql.startsWith('SELECT DISTINCT ON'))return {rows:[legacy]};
  if(sql.includes('recommendation_combo_records')||sql.includes('recommendation_result_heads'))return {rows:[]};
  return query(sql,args);
 };db.release=()=>commands.push('release');
 const {readRecommendationReviewPage}=require('../server/recommendationReviewPage.cjs');
 const page=await readRecommendationReviewPage({connect:async()=>db},new URL('https://fixture.invalid/review'),Date.parse(v.asOf),{trustRegistry:v.trustRegistry});
 a.equal(page.summary.all.published,1);a.equal(page.publishedCoverage.tracks.manual.publishedRecords,2);a.equal(page.publishedCoverage.tracks.trained.publishedRecords,1);
 a.equal(page.publishedCoverage.tracks.legacy.publishedRecords,1);a.equal(page.publishedCoverage.overall.distinctEvents,2);a.equal(page.publishedCoverage.overall.hitRate,null);
 a.match(commands[0],/REPEATABLE READ READ ONLY/);a.deepEqual(commands.slice(-2),['COMMIT','release']);a.equal(Object.hasOwn(page.publishedCoverage,'rows'),false);
});
