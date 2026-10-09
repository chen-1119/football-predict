'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),path=require('node:path');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const fixture=require('./fixtures/signed-live-had.cjs');
function setup(){
 const matches=[fixture.source(1),fixture.source(2),fixture.source(3)];
 const {snapshot,registry}=fixture.snapshot(matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;})});
 const asOf=fixture.stamp(fixture.NOW),frozenAt=fixture.stamp(fixture.NOW-60000);
 const draft={version:1,reportKind:'weekday-2000-selected-two',predictionScope:'chat-only research',businessDate:'2026-09-17',frozenAt,
  singles:matches.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,
   market:'HAD',handicap:null,selection:'h',scores:[[2,0],[3,1]],confidence:'中',reason:'A reviewed fixture',analysisUrl:'https://example.com/preview',
   teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}))};
 return {draft,matches,snapshot,trustRegistry:registry,asOf};
}
test('verified signed source publishes exact own directions with no model probabilities',()=>{const v=setup(),r=p.make(v.draft,v);a.equal(r.records.length,3);a.equal(r.records[0].sp,1.8);a.equal(r.records[0].modelProbability,null);a.equal(r.records[0].publicationMethod,'reviewed-editorial');});
for(const [name,mutate] of [
 ['mismatched team',v=>v.draft.singles[0].orderedTeamIds.reverse()],
 ['reused event',v=>v.draft.singles[0].kickoff='2026-09-18T15:00:00Z'],
 ['post kickoff freeze',v=>v.draft.frozenAt='2026-09-18T00:00:00Z'],
 ['fake probability',v=>v.draft.singles[0].modelProbability=.8],
 ['incompatible score',v=>v.draft.singles[0].scores[0]=[0,1]],
 ['unverified handicap rename',v=>v.draft.singles[0].market='HHAD'],
 ['duplicate event',v=>v.draft.singles[1]=structuredClone(v.draft.singles[0])],
 ['unsafe link',v=>v.draft.singles[0].analysisUrl='javascript:alert(1)'],
 ['tampered signed price',v=>v.snapshot.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h=99],
 ['stale source',v=>v.asOf=fixture.stamp(fixture.NOW+16*60000)],
 ['unmapped PG event',v=>v.matches=[]],
 ['closed event',v=>v.matches[0].isOnSale=false],
])test('reject '+name,()=>{const v=setup();mutate(v);a.throws(()=>p.make(v.draft,v));});
test('combos bind two distinct events, exact multiplication, no repeated pair, no manufactured band',()=>{
 const records=[{eventId:'1',matchNum:'001',market:'HAD',selection:'h',sp:1.21,confidence:'中'},{eventId:'2',matchNum:'002',market:'HAD',selection:'a',sp:1.66,confidence:'中'},{eventId:'3',matchNum:'003',market:'HAD',selection:'d',sp:3.13,confidence:'低'}];
 const c=p.combinations(records);a.equal(c[0].product,3.7873);a.equal(c[1].product,5.1958);a.equal(c[2].product,null);
});
function viewModule(){const filename=path.resolve('src/services/recommendationCenterView.ts'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);return m.exports;}
test('actual browser parser accepts sealed published projection and rejects changed bytes',()=>{
 const v=setup(),record=p.make(v.draft,v),updatedAt=fixture.stamp(fixture.NOW+2000);
 const view=p.seal({version:'reviewed-analysis-view-v1',businessDate:v.draft.businessDate,updatedAt,createdAt:record.createdAt,commitObservedAt:fixture.stamp(fixture.NOW+1),publicationHash:record.contentHash,draftHash:record.draftHash,records:record.records,combos:p.combinations(record.records),formalEligible:false});
 const parser=viewModule().parseReviewedAnalysis;a.equal(parser(view,view.businessDate,updatedAt).records.length,3);view.records[0].sp=99;a.throws(()=>parser(view,view.businessDate,updatedAt));
});
function controlledRuntime(v){
 const filename=path.resolve('scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs'),native=Module.createRequire(filename),m={exports:{}};
 require('node:vm').runInNewContext(fs.readFileSync(filename,'utf8'),{module:m,exports:m.exports,process,Buffer,Date,__dirname:path.dirname(filename),require:id=>{
  if(id.endsWith('collectorAttestation.cjs'))return {loadCollectorTrustRegistry:()=>v.trustRegistry};
  if(id==='./liveOfficialHandicap.cjs')return {readLiveOfficialSnapshot:()=>v.snapshot};
  return native(id);
 }});return m.exports;
}
function controlledPool(v,{failCommit=false}={}){
 let rows=new Map(),pending=null,clock=fixture.NOW-1;const log=[];
 const c={release(){},async query(sql,args=[]){log.push(sql);
  if(sql.startsWith('BEGIN')){pending=new Map(rows);return {rows:[]};}
  if(sql==='COMMIT'){rows=pending;pending=null;if(failCommit)throw Error('connection lost after commit');return {rows:[]};}
  if(sql==='ROLLBACK'){pending=null;return {rows:[]};}
  if(sql.startsWith('SET ')||sql.includes('pg_advisory'))return {rows:[]};
  if(sql.includes('clock_timestamp'))return {rows:[{now:fixture.stamp(++clock)}]};
  if(sql.includes('match_snapshots')){a.match(sql,/LIMIT 513/);return {rows:v.matches.map(payload=>({payload}))};}
  const active=pending||rows;
  if(sql.startsWith('INSERT INTO football.private_model_artifacts')){const [key,version,generated,updated,json,sha,bytes]=args;a.ok(!active.has(key));active.set(key,{artifact_key:key,artifact_version:version,generated_at:generated,updated_at:updated,payload_json:json,payload_sha256:sha,payload_bytes:bytes});return {rows:[]};}
  if(sql.includes('WHERE artifact_key=$1'))return {rows:active.has(args[0])?[active.get(args[0])]:[]};throw Error('unexpected SQL');
 }};return {pool:{connect:async()=>c},client:c,rows:()=>rows,log};
}
test('real importer transaction protocol preserves original, requires separate committed ACK, projects exact directions',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v),opts={pool:db.pool,expectedDraftHash:p.hash(v.draft)};
 const saved=await runtime.publish(v.draft,opts);a.equal(saved.status,'committed-and-acknowledged');a.equal(db.rows().size,2);
 const view=await runtime.projection(db.client,v.draft.businessDate,fixture.stamp(fixture.NOW+1000));a.equal(view.records.length,3);a.equal(view.records[0].selection,v.draft.singles[0].selection);
 a.equal(db.log.filter(q=>q==='COMMIT').length,2);a.equal(db.log.some(q=>q.includes('recommendation_decisions')),false);
 await a.rejects(runtime.publish(v.draft,opts),/ALREADY_PUBLISHED_READ_FIRST/);a.equal(db.rows().size,2);
 db.rows().delete(saved.key+'-ack');await a.rejects(runtime.projection(db.client,v.draft.businessDate,fixture.stamp(fixture.NOW+1000)),/ACK_MISSING/);
});
test('unknown COMMIT retains original without producing ACK or public recommendation',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v,{failCommit:true});
 await a.rejects(runtime.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)}),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
 a.equal(db.rows().size,1);await a.rejects(runtime.projection(db.client,v.draft.businessDate,fixture.stamp(fixture.NOW+1000)),/ACK_MISSING/);
});
