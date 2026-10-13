'use strict';
// The normal mandatory suite includes the retained online combo archive checks.
require('./reviewed-combo-history.test.cjs');
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

function dailyView(size){
 const v=setup(),publication=p.make(v.draft,v),updatedAt=fixture.stamp(fixture.NOW+2000);
 const records=Array.from({length:size},(_,i)=>({...publication.records[i%3],eventId:String(80000+i),matchNum:`Synthetic ${i}`,
  market:i%2?'HHAD':'HAD',...(i%2?{handicap:-1,scores:[[2,0],[3,1]]}:{}),
  reason:'研'.repeat(500),publicationCreatedAt:publication.createdAt,publicationCommitObservedAt:fixture.stamp(fixture.NOW+1)}));
 return p.seal({version:'reviewed-analysis-view-v1',businessDate:v.draft.businessDate,updatedAt,createdAt:publication.createdAt,
  commitObservedAt:fixture.stamp(fixture.NOW+1),publicationHash:publication.contentHash,draftHash:publication.draftHash,
  records,combos:p.combinations(records),formalEligible:false});
}
for(const size of [14,27,32])test(`actual browser parser accepts ${size} sealed daily records above the single-paper hash budget`,()=>{
 const view=dailyView(size),{parseReviewedAnalysis,prdPaperPublicHash}=viewModule();
 const {contentHash,...body}=view;a.equal(contentHash,p.hash(body));a.throws(()=>prdPaperPublicHash(body),/budget/);
 const parsed=parseReviewedAnalysis(view,view.businessDate,view.updatedAt);a.equal(parsed.records.length,size);
 a.equal(parsed.records[1].market,'HHAD');a.equal(parsed.records[1].handicap,-1);
});
test('daily parser retains row/count/clock/hash and per-component resource bounds',()=>{
 const parser=viewModule().parseReviewedAnalysis;
 for(const mutate of [
  v=>v.records.push({...v.records[0],eventId:'99999'}),
  v=>{v.records[1].eventId=v.records[0].eventId;},
  v=>{v.records[0].publicationCommitObservedAt=v.records[0].cutoffAt;},
  v=>{v.records[0].reason='x'.repeat(16385);},
  v=>{v.records[0].extra=Array(512).fill(0);},
  v=>{v.extra='x'.repeat(16385);},
  v=>{v.records[0].extra=Array.from({length:9}).reduce(value=>({nested:value}),1);},
 ]){const v=dailyView(32);mutate(v);const {contentHash,...body}=v;void contentHash;const sealed=p.seal(body);a.throws(()=>parser(sealed,sealed.businessDate,sealed.updatedAt));}
 const tampered=dailyView(27);tampered.records[0].sp=9.99;a.throws(()=>parser(tampered,tampered.businessDate,tampered.updatedAt),/seal/);
});
test('the original paper hash keeps its original node, depth and character bounds',()=>{
 const hash=viewModule().prdPaperPublicHash;a.equal(hash({a:'中文',b:[1,true,null]}),p.hash({a:'中文',b:[1,true,null]}));
 a.throws(()=>hash(Array(512).fill(0)),/budget/);a.throws(()=>hash('x'.repeat(16385)),/budget/);
 a.throws(()=>hash(Array.from({length:9}).reduce(value=>({nested:value}),1)),/budget/);
});
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
  if(sql.includes('artifact_key < $3'))return {rows:[...active.values()].filter(row=>row.artifact_version===args[0]
   &&row.artifact_key.startsWith(args[1].slice(0,-1))&&row.artifact_key<args[2]).sort((a,b)=>b.artifact_key.localeCompare(a.artifact_key))
   .slice(0,1).map(row=>({artifact_key:row.artifact_key}))};
  if(sql.startsWith('SELECT artifact_key FROM football.private_model_artifacts'))return {rows:[...active.keys()].filter(k=>k===args[0]||(k.startsWith(args[1].slice(0,-1))&&active.get(k).artifact_version===args[2])).sort().slice(0,33).map(artifact_key=>({artifact_key}))};
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

test('read-only recent history recovers exact frozen singles at the real clock without manufacturing original combos',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v);
 await runtime.publish(batch(v,[0,1]),{pool:db.pool,expectedDraftHash:p.hash(batch(v,[0,1]))});
 await runtime.publish(batch(v,[2],'weekday-2100-full'),{pool:db.pool,expectedDraftHash:p.hash(batch(v,[2],'weekday-2100-full'))});
 const before=[...db.rows()].map(([key,row])=>[key,row.payload_json]),start=db.log.length;
 const now=fixture.stamp(fixture.NOW+48*3600e3),view=await runtime.readLatestHistory(db.client,'2026-09-19',now);
 a.equal(view.businessDate,'2026-09-17');a.equal(view.updatedAt,now);a.equal(view.records.length,3);
 a.deepEqual(JSON.parse(JSON.stringify(view.combos)),[]);a.deepEqual(JSON.parse(JSON.stringify(view.threeCombos)),[]);
 const stored=before.filter(([key])=>!key.endsWith('-ack')).flatMap(([,json])=>JSON.parse(json).record.records);
 a.deepEqual(JSON.parse(JSON.stringify(view.records.map(({publicationCreatedAt,publicationCommitObservedAt,...row})=>{void publicationCreatedAt;void publicationCommitObservedAt;return row;}))),stored);
 a.deepEqual([...db.rows()].map(([key,row])=>[key,row.payload_json]),before);
 a.ok(db.log.slice(start).every(sql=>sql.trim().startsWith('SELECT')));
 a.equal(viewModule().parseReviewedAnalysis(view,view.businessDate,now).records.length,3);
 const zero={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
 const api={ok:true,recommendationCenter:{version:'recommendation-center-v1',businessDate:'2026-09-19',updatedAt:now,
  inputAsOf:null,resultAsOf:null,lanes:{},current:[],previews:[],todayCombos:[],todayDualResearch:[],overlapDecisionIds:[],excludedCorruptRecords:0,modelValidation:'unvalidated',
  reviewedAnalysis:{version:'reviewed-analysis-view-v1',businessDate:'2026-09-19',updatedAt:now,formalEligible:false,records:[],combos:[],threeCombos:[]},
  reviewedAnalysisHistory:view,review:{singles:[],combos:[],limit:50,statistics:{single:zero,two:zero,three:zero},definition:'Original frozen history'}}};
 const parsed=viewModule().parseRecommendationCenter(api);
 a.equal(parsed.businessDate,'2026-09-19');a.equal(parsed.reviewedAnalysis.records.length,0);
 a.equal(parsed.reviewedAnalysisHistory.records.length,3);a.equal(parsed.reviewedAnalysisHistory.combos.length,0);
 a.equal(await runtime.readLatestHistory(db.client,'2026-09-17',now),null,'today is never relabeled as prior history');
 await a.rejects(runtime.readLatestHistory(db.client,'2026-09-20',now),/HISTORY_CLOCK/);
});

for(const [name,change] of [
 ['missing ACK',(db,key)=>db.rows().delete(key+'-ack')],
 ['changed original bytes',(db,key)=>{db.rows().get(key).payload_json+=' ';}],
 ['future ACK',(db,key)=>{const row=db.rows().get(key+'-ack'),payload=JSON.parse(row.payload_json);payload.createdAt='2027-01-01T00:00:00Z';const {contentHash,...body}=payload;void contentHash;const json=JSON.stringify(p.seal(body));Object.assign(row,{payload_json:json,payload_sha256:p.sha(json),payload_bytes:Buffer.byteLength(json)});}],
 ['wrong historical path',(db,key)=>{const moved=key.replace('2026-09-17','2026-09-16'),row=db.rows().get(key),ack=db.rows().get(key+'-ack');db.rows().delete(key);db.rows().delete(key+'-ack');db.rows().set(moved,{...row,artifact_key:moved});db.rows().set(moved+'-ack',{...ack,artifact_key:moved+'-ack'});}]
])test('historical reviewed read still rejects '+name,async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v),saved=await runtime.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)});
 change(db,saved.key);await a.rejects(runtime.readLatestHistory(db.client,'2026-09-19',fixture.stamp(fixture.NOW+48*3600e3)));
});

function batch(v,indices=[0],kind='morning-1100-review-and-early'){
 const original={...v.draft,reportKind:kind,predictionScope:'chat-only manual research',singles:indices.map(i=>v.draft.singles[i])};
 const originalArchive=JSON.stringify(original,null,2)+'\n';
 return {...original,version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',originalArchive,originalArchiveSha256:p.sha(originalArchive)};
}
test('morning manual reference preserves original archive bytes and exact directions without pretending evidence admission',()=>{
 const v=setup(),d=batch(v),r=p.make(d,v);a.equal(r.records.length,1);a.equal(r.records[0].selection,'h');a.equal(r.records[0].modelProbability,null);a.equal(r.records[0].evidenceAdoption,undefined);
});
for(const [name,change] of [
 ['changed frozen direction',d=>{d.singles[0].selection='a';d.singles[0].scores=[[0,1],[0,2]];}],
 ['changed confidence',d=>{d.singles[0].confidence='高';}],
 ['changed original time',d=>{d.frozenAt='2026-09-17T00:00:00Z';}],
 ['forged archive bytes',d=>{d.originalArchive+=' ';}],
 ['unsupported original kind',d=>{const o=JSON.parse(d.originalArchive);o.reportKind='after-results';d.originalArchive=JSON.stringify(o);d.originalArchiveSha256=p.sha(d.originalArchive);}]
])test('manual batch rejects '+name,()=>{const v=setup(),d=structuredClone(batch(v));change(d);a.throws(()=>p.make(d,v));});
test('two disjoint same-day batches append with separate ACKs and remain readable by actual browser parser',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v),d1=batch(v,[0]),d2=batch(v,[1],'weekday-2100-full');
 const first=await runtime.publish(d1,{pool:db.pool,expectedDraftHash:p.hash(d1)}),savedBytes=db.rows().get(first.key).payload_json;
 await runtime.publish(d2,{pool:db.pool,expectedDraftHash:p.hash(d2)});a.equal(db.rows().size,4);a.equal(db.rows().get(first.key).payload_json,savedBytes);
 const at=fixture.stamp(fixture.NOW+1000),view=await runtime.projection(db.client,v.draft.businessDate,at);
 a.equal(view.records.length,2);a.equal(viewModule().parseReviewedAnalysis(view,v.draft.businessDate,at).records.length,2);
 a.ok(view.records.every(r=>r.publicationCreatedAt&&r.publicationCommitObservedAt));
 await a.rejects(runtime.publish(d1,{pool:db.pool,expectedDraftHash:p.hash(d1)}),/ALREADY_PUBLISHED_READ_FIRST/);
 const overlap=batch(v,[0,2],'weekday-2100-full');await a.rejects(runtime.publish(overlap,{pool:db.pool,expectedDraftHash:p.hash(overlap)}),/EVENT_ALREADY_FROZEN/);
 a.equal(db.rows().size,4);
 const corrupt=structuredClone(view);corrupt.records[0].publicationCommitObservedAt=corrupt.records[0].cutoffAt;delete corrupt.contentHash;
 a.throws(()=>viewModule().parseReviewedAnalysis(p.seal(corrupt),v.draft.businessDate,at),/clock/);
 const later=await runtime.projection(db.client,v.draft.businessDate,fixture.stamp(fixture.NOW+48*3600e3));
 a.equal(later.records.length,2);a.ok(later.combos.every(c=>c.legs.length===0));
});
test('unknown batch COMMIT blocks further publication until readback, never creates an unacknowledged view',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v,{failCommit:true}),d=batch(v);
 await a.rejects(runtime.publish(d,{pool:db.pool,expectedDraftHash:p.hash(d)}),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
 await a.rejects(runtime.projection(db.client,v.draft.businessDate,fixture.stamp(fixture.NOW+1000)),/ACK_MISSING/);
 const next=batch(v,[1]);await a.rejects(runtime.publish(next,{pool:db.pool,expectedDraftHash:p.hash(next)}),/ACK_MISSING/);
 a.equal(db.rows().size,1);
});

test('large unrelated current rows do not enter a small reviewed batch or its replay',async()=>{
 const v=setup(),d=batch(v,[0]);v.matches[1].unrelated= 'x'.repeat(9*1024*1024);
 const runtime=controlledRuntime(v),db=controlledPool(v);
 const saved=await runtime.publish(d,{pool:db.pool,expectedDraftHash:p.hash(d)});
 const stored=JSON.parse(db.rows().get(saved.key).payload_json);
 a.equal(stored.inputs.matches.length,1);a.equal(stored.inputs.matches[0].sourceMatchId,v.matches[0].sourceMatchId);
 a.equal(p.hash(stored.inputs.snapshot),p.hash(v.snapshot));
 const view=await runtime.projection(db.client,d.businessDate,fixture.stamp(fixture.NOW+1000));
 a.equal(view.records.length,1);a.equal(viewModule().parseReviewedAnalysis(view,d.businessDate,view.updatedAt).records.length,1);
});
test('an oversized selected event still rejects before commit',async()=>{
 const v=setup(),d=batch(v,[0]);v.matches[0].large='x'.repeat(9*1024*1024);
 const runtime=controlledRuntime(v),db=controlledPool(v);
 await a.rejects(runtime.publish(d,{pool:db.pool,expectedDraftHash:p.hash(d)}),/REVIEWED_ANALYSIS_BOUND/);
 a.equal(db.rows().size,0);a.equal(db.log.includes('COMMIT'),false);
});
test('scoping retains duplicate selected identities for rejection',async()=>{
 const v=setup(),d=batch(v,[0]);v.matches.push(structuredClone(v.matches[0]));
 const runtime=controlledRuntime(v),db=controlledPool(v);
 await a.rejects(runtime.publish(d,{pool:db.pool,expectedDraftHash:p.hash(d)}),/CANONICAL_EVENT/);
 a.equal(db.rows().size,0);
});

test('HHAD-only batch publishes the exact signed line and price with score settlement arithmetic',()=>{
 const v=setup();v.draft.singles[0].market='HHAD';v.draft.singles[0].handicap=-1;v.draft.singles[0].selection='d';v.draft.singles[0].scores=[[1,0],[2,1]];
 const signed=fixture.snapshot(v.matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{
  r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;r.oddsList=[{poolCode:'HHAD',goalLine:'-1',h:2.4,d:3.6,a:2.1}];
  r.poolList=[{poolCode:'HHAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1}];
 })});v.snapshot=signed.snapshot;v.trustRegistry=signed.registry;
 const d=batch(v,[0],'on-demand-prematch-supplement'),published=p.make(d,v),r=published.records[0];
 a.equal(r.market,'HHAD');a.equal(r.handicap,-1);a.equal(r.sp,3.6);a.equal(r.selection,'d');
 const at=fixture.stamp(fixture.NOW+2000),view=p.seal({version:'reviewed-analysis-view-v1',businessDate:d.businessDate,updatedAt:at,createdAt:published.createdAt,commitObservedAt:fixture.stamp(fixture.NOW+1),publicationHash:published.contentHash,draftHash:published.draftHash,records:published.records,combos:p.combinations(published.records),formalEligible:false});
 const parsed=viewModule().parseReviewedAnalysis(view,d.businessDate,at);a.equal(parsed.records[0].handicap,-1);
 const bad=structuredClone(view);bad.records[0].handicap=-2;delete bad.contentHash;a.throws(()=>viewModule().parseReviewedAnalysis(p.seal(bad),d.businessDate,at),/scores/);
});
for(const [name,mutate] of [
 ['wrong signed line',r=>{r.oddsList[0].goalLine='-2';}],
 ['suspended pool',r=>{r.poolList[0].poolStatus='Suspended';}],
 ['no fixed allup',r=>{r.poolList[0].cbtAllUp=0;}],
 ['duplicate pool',r=>r.oddsList.push({...r.oddsList[0]})],
 ['future provider clock',r=>Object.assign(r.oddsList[0],{updateDate:'2026-09-18',updateTime:'00:00:00'})],
 ['HAD price renamed',r=>{r.oddsList[0].poolCode='HAD';}],
 ['invalid odds',r=>{r.oddsList[0].d=true;}],
 ['reversed official teams',r=>{[r.homeTeamId,r.awayTeamId]=[r.awayTeamId,r.homeTeamId];}]
])test('HHAD rejects '+name,()=>{
 const v=setup();Object.assign(v.draft.singles[0],{market:'HHAD',handicap:-1,selection:'d',scores:[[1,0],[2,1]]});
 const signed=fixture.snapshot(v.matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{
  r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;r.oddsList=[{poolCode:'HHAD',goalLine:'-1',h:2.4,d:3.6,a:2.1}];r.poolList=[{poolCode:'HHAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1}];if(i===0)mutate(r);
 })});v.snapshot=signed.snapshot;v.trustRegistry=signed.registry;
 a.throws(()=>p.make(batch(v,[0]),v));
});
test('HHAD scores use home plus handicap, not ordinary home result',()=>{
 const v=setup();Object.assign(v.draft.singles[0],{market:'HHAD',handicap:-1,selection:'h',scores:[[1,0],[2,1]]});a.throws(()=>p.validateDraft(batch(v,[0]),v.asOf),/SCORE_DIRECTION/);
 Object.assign(v.draft.singles[0],{handicap:1,selection:'h',scores:[[0,0],[1,1]]});a.equal(p.validateDraft(batch(v,[0]),v.asOf),true);
});
test('HHAD combo legs retain market and line',()=>{
 const records=[{eventId:'1',matchNum:'001',market:'HHAD',handicap:-1,selection:'d',sp:3.6,confidence:'低'},{eventId:'2',matchNum:'002',market:'HAD',selection:'h',sp:1.5,confidence:'中'}];
 const c=p.combinations(records);a.equal(c[0].product,5.4);a.equal(c[0].legs[0].handicap,-1);a.equal(c[0].legs[0].market,'HHAD');
});

test('three-leg combinations use three distinct frozen events and exact products without changing directions',()=>{
 const rows=[
  {eventId:'1',matchNum:'001',market:'HHAD',handicap:2,selection:'h',sp:2.65,confidence:'低'},
  {eventId:'2',matchNum:'002',market:'HAD',selection:'d',sp:4.7,confidence:'低'},
  {eventId:'3',matchNum:'003',market:'HHAD',handicap:-1,selection:'a',sp:2.13,confidence:'中'},
  {eventId:'4',matchNum:'004',market:'HAD',selection:'h',sp:1.29,confidence:'中'}];
 const original=JSON.stringify(rows),out=p.combinations(rows,3);
 a.equal(JSON.stringify(rows),original);a.equal(out.length,3);
 a.equal(new Set(out.map(c=>c.legs.map(l=>l.eventId).join('/'))).size,3);
 for(const c of out){a.equal(c.legs.length,3);a.equal(new Set(c.legs.map(l=>l.eventId)).size,3);
  a.ok(Math.abs(c.product-c.legs.reduce((v,l)=>v*l.sp,1))<1e-9);a.equal(c.confidence,'低');
  for(const l of c.legs){const r=rows.find(r=>r.eventId===l.eventId);a.equal(l.market,r.market);a.equal(l.handicap,r.handicap);a.equal(l.selection,r.selection);a.equal(l.sp,r.sp);}}
 a.ok(p.combinations(rows.slice(0,2),3).every(c=>c.legs.length===0));
 a.throws(()=>p.combinations([rows[0],rows[0],rows[1]],3),/COMBO_INPUT/);
 a.throws(()=>p.combinations(Array.from({length:33},(_,i)=>({...rows[0],eventId:String(i)})),3),/COMBO_BOUND/);
 a.throws(()=>p.combinations(rows,4),/COMBO_BOUND/);
});

test('three-leg projection uses acknowledged records only, expires at the first cutoff, leaves stored singles untouched',async()=>{
 const v=setup(),runtime=controlledRuntime(v),db=controlledPool(v);
 await runtime.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)});
 const saved=JSON.stringify([...db.rows()]);
 const at=fixture.stamp(fixture.NOW+1000),view=await runtime.projection(db.client,v.draft.businessDate,at);
 a.equal(view.threeCombos.filter(c=>c.legs.length===3).length,1);
 const cutoff=view.records.map(r=>Date.parse(r.cutoffAt)).sort((a,b)=>a-b)[0];
 const expired=await runtime.projection(db.client,v.draft.businessDate,new Date(cutoff).toISOString());
 a.ok(expired.threeCombos.every(c=>c.legs.length===0));
 a.equal(JSON.stringify([...db.rows()]),saved);
});

test('combo decimal multiplication preserves four-place SP and avoids large-product floating noise',()=>{
 for(const [prices,expected]of [[[1.2345,2,3],7.407],[[266.45,136.55,459.65],16723789.538375]]){
  const rows=prices.map((sp,i)=>({eventId:String(i),matchNum:String(i),market:'HAD',selection:'h',sp,confidence:'中'}));
  const combo=p.combinations(rows,3).find(c=>c.legs.length);a.equal(combo.product,expected);
  a.deepEqual(combo.legs.map(l=>l.sp),prices);
 }
});
