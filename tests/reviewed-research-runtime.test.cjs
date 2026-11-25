'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const vm=require('node:vm');
const typescript=require('typescript');
const root=path.resolve(__dirname,'..');
const fixture=require('./fixtures/reviewed-research.cjs');
const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const decision=require('../scripts/recommendationPlatform/reviewedResearchDecision.cjs');
const evidenceArchive=require('../server/researchEvidenceArchive.cjs');
const comboArchive=require('../services/recommendation/comboArchive.cjs');
const researchCombos=require('../scripts/recommendationPlatform/reviewedResearchCombos.cjs');
const evidence=require('../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const officialFixture=require('./fixtures/reviewed-official-event.cjs');
const frontendFilename=path.join(root,'src/services/recommendationCenterView.ts'),frontendModule=new Module(frontendFilename,module);
frontendModule.filename=frontendFilename;frontendModule.paths=Module._nodeModulePaths(path.dirname(frontendFilename));
frontendModule._compile(typescript.transpileModule(fs.readFileSync(frontendFilename,'utf8'),{compilerOptions:{module:typescript.ModuleKind.CommonJS,target:typescript.ScriptTarget.ES2022}}).outputText,frontendFilename);
const frontend=frontendModule.exports;
function database(){
 let committed=new Map(),clock=fixture.NOW,connectionId=0,transactionId=0,unknownWriteCommit=false;
 const log=[];
 let hook=()=>{};
 function client(){
  const id=++connectionId;
  let pending=null,transaction=null,readonly=false;
  return {release(){},async query(sql,args=[]){
   log.push({sql,args:structuredClone(args),connection:id,transaction});
   if(sql.startsWith('BEGIN')){assert.equal(pending,null);pending=new Map([...committed].map(([key,row])=>[key,structuredClone(row)]));readonly=sql.includes('READ ONLY');transaction=++transactionId;return {rows:[]};}
   if(sql==='COMMIT'){
    assert(pending);if(!readonly)committed=pending;pending=null;
    if(!readonly&&unknownWriteCommit){unknownWriteCommit=false;transaction=null;throw Error('synthetic lost COMMIT response after durable commit');}
    transaction=null;return {rows:[]};
   }
   if(sql==='ROLLBACK'){pending=null;transaction=null;return {rows:[]};}
   const store=pending||committed;
   await hook(sql,args,store);
   if(sql.startsWith('SET ')||sql.includes('pg_advisory'))return {rows:[]};
   if(sql.includes('clock_timestamp'))return {rows:[{now:fixture.stamp(++clock)}]};
   if(sql.includes('match_snapshots'))throw Error('v4/v5 must not read native match rows');
   if(sql.startsWith('SELECT count(*)::int AS total'))return {rows:[{total:[...store.values()].filter(row=>row.artifact_version===args[0]&&row.artifact_key.startsWith(args[1].slice(0,-1))).length}]};
   if(sql.startsWith('SELECT artifact_key')&&sql.includes('WHERE artifact_version=$1'))return {rows:[...store.values()].filter(row=>row.artifact_version===args[0]&&row.artifact_key.startsWith(args[1].slice(0,-1))).map(row=>({artifact_key:row.artifact_key,payload_bytes:row.payload_bytes,bytes:Buffer.byteLength(row.payload_json)}))};
   if(sql.startsWith('SELECT artifact_key FROM football.private_model_artifacts')&&sql.includes('artifact_key=$1 OR'))return {rows:[...store.keys()].filter(key=>key===args[0]||(key.startsWith(args[1].slice(0,-1))&&store.get(key).artifact_version===args[2])).sort().map(artifact_key=>({artifact_key}))};
   if(sql.startsWith('INSERT INTO football.private_model_artifacts')){
    assert(pending&&!readonly,'insert must be in a write transaction');assert(!sql.includes('ON CONFLICT'),'immutable insertion only');
    const [key,version,created,updated,json,digest,bytes]=args.length===6?[args[0],args[1],args[2],args[2],args[3],args[4],args[5]]:args;
    assert([6,7].includes(args.length));assert(!store.has(key),'duplicate immutable key');
    store.set(key,{artifact_key:key,artifact_version:version,generated_at:created,updated_at:updated,payload_json:json,payload_sha256:digest,payload_bytes:bytes});return {rows:[]};
   }
   if(sql.includes('WHERE artifact_key=$1')){
    const row=store.get(args[0]);
    if(sql.includes('SELECT payload_bytes,octet_length'))return {rows:row?[{payload_bytes:row.payload_bytes,actual_bytes:Buffer.byteLength(row.payload_json),bytes:Buffer.byteLength(row.payload_json)}]:[]};
    return {rows:row?[structuredClone(row)]:[]};
   }
   throw Error('Unexpected synthetic SQL: '+sql);
  }};
 }
 return {pool:{connect:async()=>client()},client:client(),log,rows:()=>committed,clock:()=>clock,setHook:value=>{hook=value;},loseNextWriteCommit:()=>{unknownWriteCommit=true;}};
}
function graph(context){
 const gates=[];
 const realContinuity=require('../server/researchRevisionPolicy.cjs');
 const watchedPolicy={...realContinuity,requireResearchContinuity(records,draft){gates.push({strategies:records.map(record=>record?.strategy||null),research:records.map(record=>record?.research!==undefined),draftVersion:draft?.version});return realContinuity.requireResearchContinuity(records,draft);}};
 const loaded={};
 function load(relative,extra=''){
  const filename=path.join(root,relative),native=Module.createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+extra,{module,exports:module.exports,process,Buffer,Date,structuredClone,__dirname:path.dirname(filename),require:id=>{
   if(id.endsWith('collectorAttestation.cjs'))return {...native(id),loadCollectorTrustRegistry:()=>context.trustRegistry};
   if(id.endsWith('liveOfficialHandicap.cjs'))return {readLiveOfficialSnapshot:()=>context.snapshot};
   if(id.endsWith('reviewedAnalysisRuntime.cjs'))return loaded.runtime;
   if(id==='./researchReviewedRevision.cjs')return loaded.single;
   if(id==='./researchRevisionPolicy.cjs')return watchedPolicy;
   if(id.endsWith('reviewedOfficialEvent.cjs')&&loaded.official)return loaded.official;
   return native(id);
  }},{filename});
  return module.exports;
 }
 loaded.runtime=load('scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
 loaded.official=load('scripts/recommendationPlatform/reviewedOfficialEvent.cjs');
 loaded.single=load('server/researchReviewedRevision.cjs');
 loaded.combo=load('server/researchComboRevision.cjs','\nmodule.exports.integrationGroup=group;');
 loaded.frozen=load('server/researchFrozenCombos.cjs');
 return {...loaded,gates};
}
function singleDraft(draft){
 const result=structuredClone(draft);result.singles=result.singles.slice(0,1);
 const original=JSON.parse(result.originalArchive);original.singles=original.singles.slice(0,1);result.originalArchive=JSON.stringify(original);result.originalArchiveSha256=policy.sha(result.originalArchive);
 if(result.version===5){result.research.directions=result.research.directions.slice(0,1);result.research.evidenceKeys=result.research.evidenceKeys.slice(0,1);}
 return result;
}
function rowFor(key,value,updated=value.createdAt){
 const json=JSON.stringify(value);return {artifact_key:key,artifact_version:value.version,generated_at:value.createdAt,updated_at:updated,payload_json:json,payload_sha256:policy.sha(json),payload_bytes:Buffer.byteLength(json)};
}
async function setup(){
 const value=fixture.setup(),db=database(),modules=graph(value.context),draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context);
 const archiveProof=[];
 for(const packet of value.packets){const proof=await evidenceArchive.archive(db.pool,packet,policy.sha(JSON.stringify(packet)));assert(proof.verified&&proof.commitAcknowledged&&proof.archiveOnly&&!proof.published);archiveProof.push(proof);}
 assert.equal(db.rows().size,2);
 return {value,db,modules,draft,archiveProof};
}
async function publish(state,draft=state.draft){return state.modules.runtime.publish(draft,{pool:state.db.pool,expectedDraftHash:policy.hash(draft)});}
function singleRequest(base,draft,revision=1,previousRevisionHash=null){return {version:'reviewed-single-request-v1',baseRecordKey:base.key,basePayloadSha256:base.payloadSha256,eventId:draft.singles[0].eventId,revision,previousRevisionHash,draft,draftHash:policy.hash(draft)};}
async function comboRequest(state,base,draft){
 const at=fixture.stamp(++state.testClock),view=await state.modules.runtime.projection(state.db.client,draft.businessDate,at);
 const prepared=comboArchive.prepare(view,{generationId:'g-'+'a'.repeat(64),committedAt:at},at);
 const row=rowFor(prepared.key,prepared.archive);state.db.rows().set(prepared.key,row);
 return {version:'reviewed-combo-request-v1',size:2,band:2.5,baseArchiveKey:prepared.key,baseArchiveSha256:row.payload_sha256,bases:draft.singles.map(record=>({eventId:record.eventId,baseRecordKey:base.key,basePayloadSha256:base.payloadSha256})),draft,draftHash:policy.hash(draft),revision:1,previousRevisionHash:null};
}
async function retainView(state,view,at){
 const client=await state.db.pool.connect();await client.query('BEGIN');
 const result=await comboArchive.retain(client,view,{generationId:'g-'+'a'.repeat(64),committedAt:at},at);await client.query('COMMIT');return result;
}
const populated=groups=>groups.filter(group=>group.legs.length);
function run(name,action){test(name,action);}
async function main(){
 await run('actual evidence archive, runtime freeze, separate ACK, committed replay and projection',async()=>{
  const state=await setup(),offset=state.db.log.length,base=await publish(state),entries=state.db.log.slice(offset);
  assert.equal(state.db.rows().size,4);assert.equal(entries.filter(entry=>entry.sql==='COMMIT').length,2);
  const inserted=entries.filter(entry=>entry.sql.startsWith('INSERT'));assert.equal(inserted.length,2);assert.notEqual(inserted[0].transaction,inserted[1].transaction);
  const at=fixture.stamp(fixture.NOW+2000),read=await state.modules.runtime.readPublication(state.db.client,base.key,at),view=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,at);
  assert.equal(view.records.length,2);assert.equal(view.records[1].sp,1.92);assert.equal(view.formalEligible,false);
  assert.equal(Object.keys(read.v.inputs.evidenceByEvent).length,2);
  assert(entries.filter(entry=>entry.sql.includes('SELECT payload_bytes')).length>=4);
  const group=view.combos.find(item=>item.legs.length);assert(group);assert.equal(group.strategy,'evidence-first-editorial-v1');
  for(const leg of group.legs){const record=view.records.find(item=>item.eventId===leg.eventId);assert.equal(leg.singleHash,policy.hash(record));assert.equal(leg.quoteHash,record.quoteHash);}
  assert.equal(group.modelProbability,null);assert.equal(group.expectedValue,null);
  const before=JSON.stringify([...state.db.rows()]);await assert.rejects(publish(state),/ALREADY_PUBLISHED_READ_FIRST/);assert.equal(JSON.stringify([...state.db.rows()]),before);
  state.db.rows().delete(base.key+'-ack');await assert.rejects(state.modules.runtime.projection(state.db.client,state.draft.businessDate,at),/ACK_MISSING/);
  return {evidenceRows:2,freezeRows:1,ackRows:1,writeTransactions:2,projectedRecords:2,metadataBound:true,noNativeRead:true};
 });
 for(const [label,mutate,expected]of [
  ['wrong stored payload SHA',row=>{row.payload_sha256='f'.repeat(64);},/HASH|SHA/],
  ['future evidence storedAt',row=>{row.updated_at=fixture.stamp(fixture.NOW+10000);},/STORED_IDENTITY/],
  ['bounded SELECT mismatch',row=>{row.payload_bytes++;},/STORED_BOUND/],
 ])await run('runtime rejects '+label,async()=>{
  const state=await setup(),key=state.draft.research.evidenceKeys[0];mutate(state.db.rows().get(key));const before=JSON.stringify([...state.db.rows()]),offset=state.db.log.length;
  await assert.rejects(publish(state),expected);assert.equal(JSON.stringify([...state.db.rows()]),before);assert.equal(state.db.log.slice(offset).filter(entry=>entry.sql.startsWith('INSERT')).length,0);
 });
 await run('runtime rejects missing evidence',async()=>{
  const state=await setup();state.db.rows().delete(state.draft.research.evidenceKeys[0]);await assert.rejects(publish(state),/STORED_BOUND/);assert.equal(state.db.rows().size,1);
 });
 await run('runtime rereads evidence after passive readiness inside write transaction',async()=>{
  const state=await setup(),key=state.draft.research.evidenceKeys[0],offset=state.db.log.length;let changed=false;
  state.db.setHook((sql,args,store)=>{if(sql.includes('pg_advisory')&&!changed){changed=true;store.get(key).updated_at=fixture.stamp(fixture.NOW+10000);}});
  await assert.rejects(publish(state),/STORED_IDENTITY/);assert(changed);assert.equal(state.db.rows().size,2);assert.equal(state.db.log.slice(offset).filter(entry=>entry.sql.startsWith('INSERT')).length,0);
 });
 await run('unknown freeze COMMIT never creates ACK or auto retries',async()=>{
  const state=await setup();state.db.loseNextWriteCommit();const offset=state.db.log.length;
  await assert.rejects(publish(state),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});assert.equal(state.db.rows().size,3);
  assert.equal(state.db.log.slice(offset).filter(entry=>entry.sql.startsWith('INSERT')).length,1);
  await assert.rejects(state.modules.runtime.projection(state.db.client,state.draft.businessDate,fixture.stamp(fixture.NOW+2000)),/ACK_MISSING/);
 });
 await run('actual v5 projection can enter immutable combo archive',async()=>{
  const state=await setup();await publish(state);const at=fixture.stamp(fixture.NOW+2000),view=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,at);
  const prepared=comboArchive.prepare(view,{generationId:'g-'+'a'.repeat(64),committedAt:at},at);assert(prepared.archive.contentHash);
  const retained=await retainView(state,view,at);assert(retained.retained);
  const before=JSON.stringify([...state.db.rows()]),offset=state.db.log.length;
  const frozen=await state.modules.frozen.freezeOriginalGroups(state.db.client,view,at);assert.equal(frozen.comboFreezePolicy,'persisted-original-groups-v1');assert.equal(frozen.comboFreeze[0].frozen,false);assert.equal(policy.hash(populated(frozen.combos)),policy.hash(populated(view.combos)));
  const parsed=frontend.parseReviewedAnalysis(frozen,state.draft.businessDate,at);assert.equal(parsed.combos.filter(group=>group.legs.length===0).length,2);
  const later=new Date(Date.parse(view.records[0].cutoffAt)+1).toISOString(),history=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,later,{historical:true});
  const restored=await state.modules.frozen.freezeOriginalGroups(state.db.client,history,later);assert(restored.comboFreeze.every(item=>item.frozen));assert.equal(policy.hash(populated(restored.combos)),policy.hash(populated(view.combos)));
  assert(frontend.parseReviewedAnalysis(restored,state.draft.businessDate,later).comboFreeze.every(item=>item.frozen));
  const archiveRestored=await comboArchive.restore(state.db.client,history,later);assert.equal(policy.hash(archiveRestored.comboArchive.view.combos),policy.hash(view.combos));
  assert.equal(JSON.stringify([...state.db.rows()]),before);assert(state.db.log.slice(offset).every(entry=>entry.sql.startsWith('SELECT')));
 });
 await run('combo revision group preserves v5 strategy and exact single/quote hashes',async()=>{
  const state=await setup(),base=await publish(state),read=await state.modules.runtime.readPublication(state.db.client,base.key,fixture.stamp(fixture.NOW+2000));
  const group=state.modules.combo.integrationGroup(read.v.record,2.5);assert.equal(group.strategy,'evidence-first-editorial-v1');assert.equal(group.modelProbability,null);assert.equal(group.expectedValue,null);assert.equal(group.formalEligible,false);
  for(const leg of group.legs){const record=read.v.record.records.find(item=>item.eventId===leg.eventId);assert.equal(leg.singleHash,policy.hash(record));assert.equal(leg.quoteHash,record.quoteHash);}
 });
 await run('single revision actual base gate rejects v5 to v4 downgrade',async()=>{
  const state=await setup(),base=await publish(state),request=singleRequest(base,singleDraft(state.value.context.draft)),store=state.modules.single.createRevisionStore({pool:state.db.pool,runExclusive:action=>action()}),before=JSON.stringify([...state.db.rows()]);
  await assert.rejects(store.publish(request),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});assert.equal(JSON.stringify([...state.db.rows()]),before);assert(state.modules.gates.some(gate=>gate.draftVersion===4&&gate.research.includes(true)));
 });
 await run('single revision actual prior gate rejects downgrade after legacy base upgrades',async()=>{
  const state=await setup(),base=await publish(state,state.value.context.draft),store=state.modules.single.createRevisionStore({pool:state.db.pool,runExclusive:action=>action()});
  const request=singleRequest(base,singleDraft(state.draft)),first=await store.publish(request);assert(first.verified&&first.submitted);assert.equal(first.latestDecision.strategy,'evidence-first-editorial-v1');
  const downgraded=singleRequest(base,singleDraft(state.value.context.draft),2,first.payloadSha256),before=JSON.stringify([...state.db.rows()]),offset=state.modules.gates.length;
  await assert.rejects(store.publish(downgraded),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});assert.equal(JSON.stringify([...state.db.rows()]),before);
  const gates=state.modules.gates.slice(offset);assert(gates.some(gate=>gate.draftVersion===4&&gate.research.every(value=>!value)));assert(gates.some(gate=>gate.draftVersion===4&&gate.research.includes(true)));
  return {upgradedRevisionVerified:true,baseAllowedLegacy:true,priorBlockedDowngrade:true};
 });
 await run('combo revision actual prior gate and second ACK preserve v5 metadata',async()=>{
  const state=await setup();state.testClock=state.db.clock();const base=await publish(state,state.value.context.draft);state.testClock=state.db.clock();
  const request=await comboRequest(state,base,state.value.context.draft);request.draft=state.draft;request.draftHash=policy.hash(state.draft);
  const store=state.modules.combo.createComboRevisionStore({pool:state.db.pool,runExclusive:action=>action()}),first=await store.publish(request);assert(first.verified&&first.submitted);assert.equal(first.combo.strategy,'evidence-first-editorial-v1');assert(first.combo.legs.every(leg=>leg.singleHash&&leg.quoteHash));
  const downgraded={...request,draft:state.value.context.draft,draftHash:policy.hash(state.value.context.draft),revision:2,previousRevisionHash:first.payloadSha256},before=JSON.stringify([...state.db.rows()]),offset=state.modules.gates.length;
  await assert.rejects(store.publish(downgraded),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});assert.equal(JSON.stringify([...state.db.rows()]),before);assert(state.modules.gates.slice(offset).some(gate=>gate.draftVersion===4&&gate.research.includes(true)));
  return {upgradedRevisionVerified:true,metadataPreserved:true,priorBlockedDowngrade:true};
 });
 for(const gate of ['base','prior'])await run('single revision persisted reader rejects '+gate+' v5 downgrade',async()=>{
  const state=await setup(),base=await publish(state,gate==='base'?state.draft:state.value.context.draft),store=state.modules.single.createRevisionStore({pool:state.db.pool,runExclusive:action=>action()});
  let request=singleRequest(base,singleDraft(state.draft)),saved=await store.publish(request);
  if(gate==='prior'){request={...request,revision:2,previousRevisionHash:saved.payloadSha256};saved=await store.publish(request);}
  const downgraded={...request,draft:singleDraft(state.value.context.draft)};downgraded.draftHash=policy.hash(downgraded.draft);
  const payload=JSON.parse(state.db.rows().get(saved.key).payload_json);payload.request=downgraded;const {contentHash,...body}=payload;void contentHash;
  state.db.rows().set(saved.key,rowFor(saved.key,policy.seal(body),payload.storedAt));const offset=state.modules.gates.length;
  await assert.rejects(store.read(downgraded),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});assert(state.modules.gates.slice(offset).some(item=>item.draftVersion===4&&item.research.includes(true)));
 });
 for(const gate of ['base','prior'])await run('combo revision actual '+gate+' writer and persisted reader reject v5 downgrade',async()=>{
  const state=await setup(),base=await publish(state,gate==='base'?state.draft:state.value.context.draft);state.testClock=state.db.clock();
  const request=await comboRequest(state,base,gate==='base'?state.draft:state.value.context.draft);request.draft=state.draft;request.draftHash=policy.hash(state.draft);
  const store=state.modules.combo.createComboRevisionStore({pool:state.db.pool,runExclusive:action=>action()});
  let saved=await store.publish(request),current=request;
  if(gate==='prior')current={...request,revision:2,previousRevisionHash:saved.payloadSha256};
  const downgraded={...current,draft:state.value.context.draft,draftHash:policy.hash(state.value.context.draft)};
  if(gate==='base'){
   const fresh={...downgraded,revision:2,previousRevisionHash:saved.payloadSha256};await assert.rejects(store.publish(fresh),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});
  }else{await assert.rejects(store.publish(downgraded),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});saved=await store.publish(current);}
  const payload=JSON.parse(state.db.rows().get(saved.key).payload_json);payload.request=downgraded;const {contentHash,...body}=payload;void contentHash;
  state.db.rows().set(saved.key,rowFor(saved.key,policy.seal(body),payload.storedAt));const offset=state.modules.gates.length;
  await assert.rejects(store.read(downgraded),{code:'REVIEW_REVISION_RESEARCH_DOWNGRADE'});assert(state.modules.gates.slice(offset).some(item=>item.draftVersion===4&&item.research.includes(true)));
 });
 for(const [label,change]of [
  ['single hash',view=>{view.combos[0].legs[0].singleHash='a'.repeat(64);}],
  ['quote hash',view=>{view.combos[0].legs[0].quoteHash='a'.repeat(64);}],
  ['missing strategy',view=>{delete view.combos[0].strategy;}],
  ['extra metadata',view=>{view.combos[0].override=true;}],
  ...[
   ['ineligible',record=>{record.comboEligible=false;}],
   ['model probability',record=>{record.modelProbability=0.9;}],
   ['expected value',record=>{record.expectedValue=0.9;}],
   ['formal adoption',record=>{record.formalEligible=true;}],
   ['missing core',record=>{record.research.coreComplete=false;}],
   ['missing availability',record=>{record.research.availabilityComplete=false;}],
   ['wrong policy',record=>{record.research.comboPolicy='anything';}],
   ['partial research version',record=>{delete record.research.version;}],
  ].map(([label,change])=>[label,view=>{change(view.records[0]);for(const group of view.combos)for(const leg of group.legs)if(leg.eventId===view.records[0].eventId)leg.singleHash=policy.hash(view.records[0]);}]),
 ])await run('archive rejects resealed v5 '+label,async()=>{
  const state=await setup();await publish(state);const at=fixture.stamp(fixture.NOW+2000),view=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,at),body=structuredClone(view);delete body.contentHash;change(body);
  assert.throws(()=>comboArchive.prepare(policy.seal(body),{generationId:'g-'+'a'.repeat(64),committedAt:at},at));
 });
 await run('later actual batch retains original v5 group across publication clock decoration',async()=>{
  const state=await setup();await publish(state);const at=fixture.stamp(state.db.clock()+1),first=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,at);await retainView(state,first,at);
  const originalArchive=[...state.db.rows().values()].find(row=>row.artifact_version===comboArchive.VERSION),originalJson=originalArchive.payload_json;
  const single={...structuredClone(state.value.context.draft.singles[0]),eventId:'3',matchNum:'周四003',orderedTeamIds:[14,15],teams:['主队3','客队3']};
  for(const endpoint of state.value.context.snapshot.endpoints){
   const rows=endpoint.payload.value.matchInfoList[0].subMatchList,extra=structuredClone(rows[0]);Object.assign(extra,{matchId:3,matchNumStr:single.matchNum,homeTeamAllName:single.teams[0],awayTeamAllName:single.teams[1],homeTeamId:14,awayTeamId:15});rows.push(extra);officialFixture.resign(endpoint,state.value.context.pair);
  }
  const packet=evidence.create(fixture.input(single)),direction=decision.choose(packet,state.value.directions[0].choice,fixture.stamp(fixture.NOW-3000));
  await evidenceArchive.archive(state.db.pool,packet,policy.sha(JSON.stringify(packet)));
  const draft=decision.prepare({directions:[direction],evidence:[packet]},state.value.context);await publish(state,draft);
  const later=fixture.stamp(state.db.clock()+1),view=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,later);assert.equal(view.records.length,3);assert(view.records.every(record=>record.publicationCreatedAt&&record.publicationCommitObservedAt));
  assert.equal(frontend.parseReviewedAnalysis(view,state.draft.businessDate,later).records.length,3);
  await retainView(state,view,later);
  const frozen=await state.modules.frozen.freezeOriginalGroups(state.db.client,view,later);assert.equal(policy.hash(populated(frozen.combos)),policy.hash(populated(first.combos)));
  const parsed=frontend.parseReviewedAnalysis(frozen,state.draft.businessDate,later);assert.equal(parsed.records.length,3);assert.equal(populated(parsed.threeCombos).length,1);
  assert.equal(state.db.rows().get(originalArchive.artifact_key).payload_json,originalJson);
  for(const record of view.records){const {publicationCreatedAt,publicationCommitObservedAt,...core}=record;void publicationCreatedAt;void publicationCommitObservedAt;assert.equal(researchCombos.coreHash(record),policy.hash(core));}
 });
 await run('stable single hash omits only the two publication decorations',async()=>{
  const state=await setup();await publish(state);const at=fixture.stamp(fixture.NOW+2000),view=await state.modules.runtime.projection(state.db.client,state.draft.businessDate,at),record=view.records[0];
  assert.equal(researchCombos.coreHash(record),policy.hash(record));
  assert.equal(researchCombos.coreHash({...record,publicationCreatedAt:at,publicationCommitObservedAt:at}),policy.hash(record));
  for(const field of Object.keys(record))assert.notEqual(researchCombos.coreHash({...record,[field]:record[field]===null?true:null}),policy.hash(record),field);
 });
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});

