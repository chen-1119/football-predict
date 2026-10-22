'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/reviewed-official-event.cjs');
const {decodeRequest}=require('../server/researchWriteService.cjs');
const rows=e=>e.payload.value.matchInfoList[0].subMatchList;
function publishInput(v){const json=JSON.stringify(v.draft);return {version:'research-broker-request-v1',action:'publish',draftHash:p.hash(v.draft),json,sha256:p.sha(json)};}
test('V4 prices absent-native editorial events from complete dual signed sources and preserves source bytes',()=>{
 const v=f.setup(),before=JSON.stringify(v),r=p.make(v.draft,v);a.equal(r.eventAuthority,'signed-official-events-v1');
 a.equal(r.records.length,2);a.equal(r.records[0].sp,1.8);a.equal(r.records[1].sp,1.92);
 a.deepEqual(r.records[0].eventAuthority.officialOrderedTeamIds,[10,11]);a.equal(r.modelProbability,null);a.equal(r.formalEligible,false);
 a.equal(JSON.stringify(v),before);a.equal(r.draftHash,p.hash(v.draft));a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(publishInput(v)))),publishInput(v));
 const old={...v.draft,version:3};delete old.eventAuthority;a.throws(()=>p.make(old,v),/CANONICAL_EVENT/);
});
const refusals=[
 ['unversioned source',v=>delete v.draft.eventAuthority,false],
 ['native graph injected',v=>v.matches.push({sourceMatchId:v.draft.singles[0].eventId}),false],
 ['future source',v=>{for(const e of v.snapshot.endpoints)e.receivedAt=f.stamp(f.NOW+1);},true],
 ['source over 30 seconds old',v=>{v.asOf=f.stamp(f.NOW+30001);},false],
 ['reversed official team IDs',v=>rows(v.snapshot.endpoints[1])[0].homeTeamId=11,true],
 ['different official event time',v=>rows(v.snapshot.endpoints[1])[0].matchTime='23:01:00',true],
 ['different business day',v=>rows(v.snapshot.endpoints[1])[0].businessDate='2026-09-18',true],
 ['duplicate event in a complete endpoint',v=>rows(v.snapshot.endpoints[1]).push(structuredClone(rows(v.snapshot.endpoints[1])[0])),true],
 ['different source cycle',v=>v.snapshot.endpoints[1].sourceCycleId='other-cycle',true],
 ['unsigned changed price',v=>rows(v.snapshot.endpoints[0])[0].oddsList[0].h=7,false],
 ['authentic cross-lane price conflict',v=>rows(v.snapshot.endpoints[1])[0].oddsList[0].h=7,true],
 ['authentic cross-lane line conflict',v=>rows(v.snapshot.endpoints[1])[1].oddsList[1].goalLine='-2',true],
 ['authentic future calculator pool clock',v=>Object.assign(rows(v.snapshot.endpoints[1])[0].oddsList[0],{updateDate:'2026-09-18',updateTime:'20:00:00'}),true],
 ['closed event despite Selling text',v=>rows(v.snapshot.endpoints[1])[0].sellStatus=2,true],
 ['missing fixed all-up permit',v=>delete rows(v.snapshot.endpoints[1])[0].poolList[0].cbtAllUp,true],
 ['duplicate requested pool',v=>rows(v.snapshot.endpoints[1])[0].oddsList.push(structuredClone(rows(v.snapshot.endpoints[1])[0].oddsList[0])),true],
 ['explicit earlier cutoff',v=>{for(const e of v.snapshot.endpoints)rows(e)[0].buyEndTime=f.stamp(f.NOW-1);},true],
 ['partial or unbounded endpoint shape',v=>{v.snapshot.endpoints[1].payload.value.matchInfoList.push({});},true],
 ['forged collector registry',v=>{v.trustRegistry={version:1,keys:[]};},false],
 ['draft ordered names changed',v=>v.draft.singles[0].teams.reverse(),false],
];
for(const [label,change,signed] of refusals)test('V4 refuses '+label,()=>{
 const v=f.setup();change(v);if(signed)for(const e of v.snapshot.endpoints)f.resign(e,v.pair);a.throws(()=>p.make(v.draft,v));
});
test('V4 uses the earliest actual signed deadline and retains the existing reviewed business-hour cap',()=>{
 const v=f.setup(),deadline=f.stamp(f.NOW+120000);
 for(const e of v.snapshot.endpoints){rows(e)[0].buyEndTime=deadline;f.resign(e,v.pair);}
 a.equal(p.make(v.draft,v).records[0].cutoffAt,deadline);
 const closed=f.setup();closed.asOf='2026-09-17T14:00:00.000Z';
 for(const e of closed.snapshot.endpoints){e.receivedAt=closed.asOf;e.requestedAt='2026-09-17T13:59:59.000Z';f.resign(e,closed.pair);}
 a.throws(()=>p.make(closed.draft,closed));
});
test('V4 revision identity keeps official ordered IDs and refuses authority downgrade in both reader and writer guards',()=>{
 const v=f.setup(),first=p.make(v.draft,v).records[0],same=require('../scripts/recommendationPlatform/reviewedOfficialEvent.cjs').sameOfficialEventIdentity;
 a.equal(same(first,structuredClone(first)),true);
 a.equal(same(first,{...first,eventAuthority:{...first.eventAuthority,officialOrderedTeamIds:[20,21]}}),false);
 const downgraded={...first};delete downgraded.eventAuthority;a.equal(same(first,downgraded),false);a.equal(same(downgraded,first),false);a.equal(same(downgraded,downgraded),true);
});
function runtime(v,{onSnapshotRead=()=>{}}={}){
 const filename=path.resolve(__dirname,'../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs'),native=Module.createRequire(filename),m={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:m,exports:m.exports,process,Buffer,Date,__dirname:path.dirname(filename),require:id=>{
  if(id.endsWith('collectorAttestation.cjs'))return {loadCollectorTrustRegistry:()=>v.trustRegistry};
  if(id==='./liveOfficialHandicap.cjs')return {readLiveOfficialSnapshot:()=>{const snapshot=v.snapshot;onSnapshotRead(snapshot);return snapshot;}};return native(id);
 }});return m.exports;
}
function database({loseCommit=false,onQuery=()=>{}}={}){
 let committed=new Map(),pending=null,clock=f.NOW,readNative=0;const log=[];
 const c={release(){},async query(sql,args=[]){
  log.push(sql);onQuery(sql);if(sql.startsWith('BEGIN')){pending=new Map(committed);return {rows:[]};}
  if(sql==='COMMIT'){committed=pending;pending=null;if(loseCommit)throw Error('lost COMMIT reply');return {rows:[]};}
  if(sql==='ROLLBACK'){pending=null;return {rows:[]};}
  if(sql.startsWith('SET ')||sql.includes('pg_advisory'))return {rows:[]};
  if(sql.includes('clock_timestamp'))return {rows:[{now:f.stamp(++clock)}]};
  if(sql.includes('match_snapshots')){readNative++;throw Error('V4 must not require native event rows');}
  const store=pending||committed;
  if(sql.startsWith('SELECT artifact_key FROM football.private_model_artifacts'))return {rows:[...store.keys()].filter(k=>k===args[0]||k.startsWith(args[1].slice(0,-1))&&store.get(k).artifact_version===args[2]).sort().map(artifact_key=>({artifact_key}))};
  if(sql.startsWith('INSERT INTO football.private_model_artifacts')){const [key,version,created,updated,json,sha,bytes]=args;a(!store.has(key));
   store.set(key,{artifact_key:key,artifact_version:version,generated_at:created,updated_at:updated,payload_json:json,payload_sha256:sha,payload_bytes:bytes});return {rows:[]};}
  if(sql.includes('WHERE artifact_key=$1'))return {rows:store.has(args[0])?[store.get(args[0])]:[]};
  throw Error('Unexpected test SQL '+sql);
 }};
 return {pool:{connect:async()=>c},client:c,rows:()=>committed,log,nativeReads:()=>readNative};
}
test('V4 normal transaction and separate ACK replay into natural projection without reading native events',async()=>{
 const v=f.setup(),r=runtime(v),db=database(),result=await r.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)});
 a.match(result.key,/batch-/);a.equal(db.rows().size,2);a.equal(db.nativeReads(),0);a.equal(db.log.filter(x=>x==='COMMIT').length,2);
 const projected=await r.projection(db.client,v.draft.businessDate,f.stamp(f.NOW+2000));a.equal(projected.records.length,2);
 a.equal(projected.records[1].sp,1.92);const before=[...db.rows()].map(([k,row])=>[k,row.payload_json]);
 await a.rejects(r.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)}),/ALREADY_PUBLISHED_READ_FIRST/);
 a.deepEqual([...db.rows()].map(([k,row])=>[k,row.payload_json]),before);
 db.rows().delete(result.key+'-ack');await a.rejects(r.projection(db.client,v.draft.businessDate,f.stamp(f.NOW+2000)),/ACK_MISSING/);
});
test('V4 unknown COMMIT preserves the original freeze without inventing an ACK or retrying',async()=>{
 const v=f.setup(),r=runtime(v),db=database({loseCommit:true});
 await a.rejects(r.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)}),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
 a.equal(db.rows().size,1);a.equal(db.nativeReads(),0);
 await a.rejects(r.projection(db.client,v.draft.businessDate,f.stamp(f.NOW+2000)),/ACK_MISSING/);
});

test('V4 rereads after passive readiness and refuses a now-stale source inside its single write transaction',async()=>{
 const v=f.setup(),initial=v.snapshot,original=JSON.stringify(initial),reads=[],r=runtime(v,{onSnapshotRead:snapshot=>reads.push(snapshot)}),db=database({onQuery(sql){if(sql.includes('pg_advisory')){
  v.snapshot=structuredClone(v.snapshot);for(const e of v.snapshot.endpoints){e.requestedAt=f.stamp(f.NOW-31000);e.receivedAt=f.stamp(f.NOW-31000);f.resign(e,v.pair);}
 }}});
 await a.rejects(r.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)}),{code:'REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK'});
 a(reads.length>=2);a.equal(reads[0],initial);a.equal(reads.at(-1),v.snapshot);a.notEqual(initial,v.snapshot);a.equal(JSON.stringify(initial),original);
 a.equal(db.log[0],'SELECT clock_timestamp() AS now');a.equal(db.log.filter(x=>x.startsWith('BEGIN')).length,1);
 a.equal(db.log.filter(x=>x==='ROLLBACK').length,1);a.equal(db.log.filter(x=>x.startsWith('INSERT')).length,0);a.equal(db.rows().size,0);
});

test('V4 transaction rejects newly closed sale after readiness without reusing a previously verified snapshot',async()=>{
 const v=f.setup(),initial=v.snapshot,original=JSON.stringify(initial),reads=[],r=runtime(v,{onSnapshotRead:snapshot=>reads.push(snapshot)}),db=database({onQuery(sql){if(sql.includes('pg_advisory')){
  v.snapshot=structuredClone(v.snapshot);for(const e of v.snapshot.endpoints){rows(e)[0].sellStatus=2;f.resign(e,v.pair);}
 }}});
 await a.rejects(r.publish(v.draft,{pool:db.pool,expectedDraftHash:p.hash(v.draft)}),{code:'REVIEWED_ANALYSIS_OFFICIAL_EVENT_SALE'});
 a(reads.length>=2);a.equal(reads[0],initial);a.equal(reads.at(-1),v.snapshot);a.notEqual(initial,v.snapshot);a.equal(JSON.stringify(initial),original);
 a.equal(db.log.filter(x=>x.startsWith('BEGIN')).length,1);a.equal(db.log.filter(x=>x.startsWith('INSERT')).length,0);a.equal(db.rows().size,0);
});
