'use strict';
// Shared transaction/proof for the clone and the explicitly signed same-database repair.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const objectHash=v=>hash(JSON.stringify(stable(v)));
function monitorPostgresMemory(pools,readFile=fs.readFileSync.bind(fs)){
 const report={sampleIntervalMs:250,samples:0,backends:{},minHostAvailableBytes:null,unavailable:[]};let stopped=false;
 const sample=()=>{if(stopped)return;report.samples++;try{const value=Number(/^MemAvailable:\s+(\d+) kB$/m.exec(readFile('/proc/meminfo','utf8'))?.[1])*1024;if(!Number.isFinite(value))throw Error('MemAvailable absent');report.minHostAvailableBytes=report.minHostAvailableBytes===null?value:Math.min(report.minHostAvailableBytes,value);}catch(e){if(!report.unavailable.includes('host-memory'))report.unavailable.push('host-memory');}
  for(const pool of pools){const pid=pool.backendPid;if(!Number.isSafeInteger(pid)||pid<=0)continue;const metric=report.backends[pid]||={pid,samples:0,peakRssBytes:0};try{const value=Number(/^VmRSS:\s+(\d+) kB$/m.exec(readFile('/proc/'+pid+'/status','utf8'))?.[1])*1024;if(!Number.isFinite(value))throw Error('VmRSS absent');metric.samples++;metric.peakRssBytes=Math.max(metric.peakRssBytes,value);}catch(e){metric.unavailable=true;}}
 };sample();const timer=setInterval(sample,report.sampleIntervalMs);timer.unref();return{sample,finish(){if(!stopped){sample();stopped=true;clearInterval(timer);}return report;}};
}
function assertProjectionTarget(scope,target,production,candidate){
 assert.ok(['isolated-candidate','production-repair'].includes(scope));assert.equal(target.clusterId,production.systemIdentifier);
 if(scope==='production-repair'){assert.equal(target.database,'football');assert.equal(target.oid,production.oid);}
 else{assert.equal(target.database,candidate.database);assert.equal(target.oid,candidate.oid);assert.notEqual(target.database,'football');assert.notEqual(target.oid,production.oid);}
}
async function readProjectionBaseline(pool,root){const monitor=monitorPostgresMemory([pool]);try{
 const {SOURCE_ID}=require(root+'/server/publicReferenceArchive.cjs'),{protectedFrozenRecommendationHash}=require(root+'/scripts/nativeReleaseDataPlane.cjs');
 const row=(await pool.query("SELECT encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS sha256 FROM football.source_snapshots WHERE id=$1",[SOURCE_ID])).rows[0];assert.match(row?.sha256||'',/^[a-f0-9]{64}$/,'existing PostgreSQL reference archive absent');
 const recommendations=(await pool.query('SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE "C"')).rows.map(r=>({id:r.decision_id,hash:protectedFrozenRecommendationHash(r.record)}));return{archiveSha256:row.sha256,recommendations,postgresMemory:monitor.finish()};
 }finally{monitor.finish();}}
async function projectAndVerify({root,dir,input,policy,pool,scope,target,production,candidate}){
 assertProjectionTarget(scope,target,production,candidate);const start=Date.now(),{publication}=require(root+'/scripts/nativeReleaseDatabaseSession.cjs');
 const actual=(await pool.query("SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,(SELECT system_identifier::text FROM pg_control_system()) AS cluster_id")).rows[0];assert.equal(actual.database,target.database);assert.equal(actual.oid,target.oid);assert.equal(actual.cluster_id,target.clusterId);
 const memory=monitorPostgresMemory([pool]);try{
 const initial=require(root+'/server/dataGenerationStore.cjs').resolveCurrentGeneration({storeDir:input.store});assert.deepEqual(initial.pointer,input.expectedGeneration);
  const {createPostgresGenerationSource}=require(root+'/scripts/postgresGenerationSource.cjs');
  const source=createPostgresGenerationSource({storeDir:input.store,publicDataDir:root+'/public/data',referenceTempDir:dir});
  const api=require(root+'/server/publicReferenceArchive.cjs'),originalRows=source.tableRows.bind(source);let expectedArchiveSha256=null;
  source.tableRows=table=>(async function*(){for await(const row of originalRows(table)){if(table==='source_snapshots'&&row.id===api.SOURCE_ID){expectedArchiveSha256=typeof row.payload==='string'?hash(row.payload):row.payload.sha256;if(scope==='production-repair')assert.equal(expectedArchiveSha256,input.isolatedArchiveSha256,'production input differs from the proved archive before transaction commit');}yield row;}})();
  let verification=null;const beforeCommit=async(client,transaction)=>{assert.ok(transaction&&typeof transaction==='object');assert.notEqual(transaction.skipped,true);
  const projected=await publication(client);for(const k of ['generationId','manifestHash','sourceCycleId','committedAt'])assert.equal(projected[k],input.expectedGeneration[k]);
  const {protectedFrozenRecommendationHash}=require(root+'/scripts/nativeReleaseDataPlane.cjs');
  const recommendations=(await client.query('SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE "C"')).rows.map(r=>({id:r.decision_id,hash:protectedFrozenRecommendationHash(r.record)}));
  const manifest=(await client.query('SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1',[api.INDEX_ID])).rows[0];assert.ok(manifest);const index=JSON.parse(manifest.payload);assert.equal(index.rowCount,input.expectedFrozen.publicDecisions.length);
  const archive=(await client.query("SELECT payload->>'version' AS version,payload->>'contentHash' AS content_hash,payload->>'evidenceContentHash' AS evidence_hash,json_array_length(payload->'rows') AS records,json_array_length(payload->'evidence') AS evidence,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS payload_sha256 FROM football.source_snapshots WHERE id=$1",[api.SOURCE_ID])).rows[0];
  assert.match(expectedArchiveSha256||'',/^[a-f0-9]{64}$/);assert.equal(archive.payload_sha256,expectedArchiveSha256,'complete PG archive bytes differ from the hash-bound source descriptor');
  assert.equal(archive.version,api.VERSION);assert.equal(archive.content_hash,index.archiveContentHash);assert.equal(archive.evidence_hash,index.evidenceContentHash);assert.equal(archive.records,index.rowCount);assert.equal(archive.evidence,input.expectedFrozen.publicEvidence.length);
  const decisions=[],evidence=[];for(const expected of input.expectedFrozen.publicDecisions){const row=(await client.query('SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1',[api.indexRowId(expected.id)])).rows[0];assert.ok(row,'missing reference shard');assert.ok(Buffer.byteLength(row.payload)<=api.MAX_AUDIT_BYTES);const shard=JSON.parse(row.payload),proof=api.resolveIndexedPublicReferenceEvidence(index,shard,expected.id);if(shard.record.evidenceBinding){assert.equal(proof.ok,true);evidence.push({id:expected.id,hash:objectHash(shard.entry)});}else{assert.equal(proof.reason,'evidence-not-recorded');assert.equal(shard.entry,null);}decisions.push({id:expected.id,hash:objectHash(shard.record)});}
  const archiveRows=(await client.query("SELECT payload->'sourceMatchId' AS source_id,payload->>'eventVersion' AS event_version,payload->>'kickoffTime' AS kickoff,payload->'archivedPreMatchPrediction' AS archive FROM football.match_snapshots WHERE payload->'archivedPreMatchPrediction' IS NOT NULL AND (payload->'archivedPreMatchPrediction')::text<>'null' LIMIT 100001")).rows;assert.ok(archiveRows.length<=100000);
  const archiveMap=new Map();for(const row of archiveRows){const id=JSON.stringify([row.source_id,row.event_version||null,row.kickoff]),h=objectHash(row.archive);assert.ok(!archiveMap.has(id)||archiveMap.get(id)===h);archiveMap.set(id,h);}
  const preserved=policy.compareFrozen(input.expectedFrozen,{recommendations,publicDecisions:decisions,publicEvidence:evidence,archives:[...archiveMap].map(([id,hash])=>({id,hash}))});
  // The copied immutable generation is hash-bound; no archive object was transformed by this proof.
  const context=require(root+'/server/dataGenerationStore.cjs').resolveCurrentGeneration({storeDir:input.store});assert.deepEqual(context.pointer,input.expectedGeneration);
  verification={frozenPreserved:preserved.ok,archiveIndexVerified:true,archiveRecords:index.rowCount,referenceRoot:index.rootHash,archiveSha256:archive.payload_sha256,verificationInsideTransaction:true};
  };
  const result=await require(root+'/scripts/postgresProjectionSync.cjs').syncPostgresProjectionFromSource(source,{pool,mode:'backfill',force:true,aiArenaPath:root+'/public/data/ai-arena.json',beforeCommit});
  assert.equal(result.ok,true);assert.notEqual(result.skipped,true);assert.ok(verification,'projection committed without the required in-transaction verifier');
  const committed=await publication(pool);for(const k of ['generationId','manifestHash','sourceCycleId','committedAt'])assert.equal(committed[k],input.expectedGeneration[k]);
  return {ok:true,capsuleSha256:input.capsuleSha256,checkedAt:new Date().toISOString(),elapsedMs:Date.now()-start,projectionSkipped:false,...verification,projection:result,productionProjectionWrites:scope==='production-repair',productionWrites:scope==='production-repair'?1:0,isolatedDatabaseWrites:scope==='isolated-candidate',providerRequests:0,maxRssKiB:process.resourceUsage().maxRSS,postgresMemory:memory.finish()};
 }catch(error){error.postgresMemory=memory.finish();throw error;}finally{memory.finish();}
}
async function main(){
 const inputPath=path.resolve(process.argv[2]||''),dir=path.dirname(inputPath);assert.equal(path.dirname(dir),'/var/lib/football-release/reference-repairs');assert.match(path.basename(dir),/^[a-f0-9]{64}$/);assert.equal(fs.realpathSync(dir),dir);
 const policy=require(dir+'/postgresReferenceRepairPolicy.cjs'),bytes=fs.readFileSync(dir+'/capsule.json');
 const p=policy.verify(bytes,fs.readFileSync(dir+'/capsule.sig'),fs.readFileSync('/etc/football-release/signing-public.pem'));
 const scope=process.argv[3]||'isolated-candidate';assert.ok(['isolated-candidate','production-repair'].includes(scope));
 const input=JSON.parse(fs.readFileSync(inputPath));assert.equal(input.capsuleSha256,hash(bytes));assert.deepEqual(input.expectedGeneration,p.observation.generation);assert.deepEqual(input.expectedFrozen,p.observation.frozenRecords);
 if(scope==='production-repair'){
  assert.equal(input.candidate,'/opt/football-predict');assert.equal(input.store,'/var/lib/football-predict');assert.equal(path.basename(inputPath),'production-input.json');
  const marker=JSON.parse(fs.readFileSync('/var/lib/football-release/reference-repairs/current'));assert.equal(marker.capsuleSha256,input.capsuleSha256);assert.equal(marker.directory,dir);
  assert.ok(fs.existsSync(dir+'/code-swap-started.json'));const proofBytes=fs.readFileSync(dir+'/isolated-proof.json'),accepted=JSON.parse(fs.readFileSync(dir+'/proof-accepted.json')),proof=JSON.parse(proofBytes);assert.equal(accepted.sha256,hash(proofBytes));assert.equal(proof.ok,true);assert.equal(proof.verificationInsideTransaction,true);assert.equal(proof.capsuleSha256,input.capsuleSha256);assert.equal(proof.productionWrites,0);assert.equal(input.isolatedArchiveSha256,proof.archiveSha256);assert.equal(hash(fs.readFileSync(p.entrypointGuard.path)),p.entrypointGuard.sha256);
  const states=require(dir+'/controller.cjs').unitStates();for(const state of Object.values(states))if(state.LoadState!=='not-found')assert.ok(['inactive','failed'].includes(state.ActiveState)&&Number(state.MainPID)===0,'production writers must remain stopped during repair projection');
  for(const file of p.files)assert.equal(hash(fs.readFileSync(input.candidate+'/'+file.path)),file.sha256);
  const {NativeReleasePostgresPool}=require(input.candidate+'/scripts/nativeReleasePostgresTransport.cjs'),pool=new NativeReleasePostgresPool({database:'football',databaseOid:p.observation.postgres.oid,clusterId:p.observation.postgres.systemIdentifier});
  try{assert.deepEqual(await require(input.candidate+'/scripts/nativeReleaseDatabaseSession.cjs').publication(pool),p.observation.postgres.publication);const baseline=await readProjectionBaseline(pool,input.candidate);assert.equal(baseline.archiveSha256,proof.beforeProjection.archiveSha256,'production PG archive changed since the exact clone proof');assert.deepEqual(baseline.recommendations,p.observation.frozenRecords.recommendations);const result={...await projectAndVerify({root:input.candidate,dir,input,policy,pool,scope,target:{database:'football',oid:p.observation.postgres.oid,clusterId:p.observation.postgres.systemIdentifier},production:p.observation.postgres}),beforeProjection:baseline};fs.writeFileSync(dir+'/production-projection.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({...result,beforeProjection:{archiveSha256:baseline.archiveSha256,postgresMemory:baseline.postgresMemory},projection:undefined}));return result;}finally{await pool.end();}
 }
 assert.equal(input.candidate,dir+'/candidate');assert.equal(input.store,dir+'/proof-store');
 const state=JSON.parse(fs.readFileSync('/var/lib/football-release/native/'+input.capsuleSha256+'/state.json'));
 assert.equal(input.candidateDatabase,state.candidateDatabase);assert.equal(input.candidateOid,state.candidateOid);assert.equal(input.clusterId,p.observation.postgres.systemIdentifier);assert.notEqual(input.candidateDatabase,'football');assert.notEqual(input.candidateOid,p.observation.postgres.oid);
 const root=input.candidate;for(const file of p.files)assert.equal(hash(fs.readFileSync(root+'/'+file.path)),file.sha256);
 const {NativeReleasePostgresPool}=require(root+'/scripts/nativeReleasePostgresTransport.cjs');
 const make=(database,oid)=>new NativeReleasePostgresPool({database,databaseOid:oid,clusterId:input.clusterId});
 const sourcePool=make('football',p.observation.postgres.oid),candidatePool=make(input.candidateDatabase,input.candidateOid);
 const {NativeReleaseDatabaseSession,publication}=require(root+'/scripts/nativeReleaseDatabaseSession.cjs');
 const session=new NativeReleaseDatabaseSession({sourcePool,candidatePool,administrator:null,contract:{oldDatabaseOid:p.observation.postgres.oid}});
 const start=Date.now();let mirror,mirrorMemory,mirrorMonitor;
 try{assert.deepEqual(await session.beginSnapshot(),p.observation.postgres.publication);mirrorMonitor=monitorPostgresMemory([sourcePool,candidatePool]);mirror=await session.mirror();assert.equal(mirror.ok,true);assert.equal(mirror.copiedRows,0);assert.equal(mirror.removedCandidateRows,0);assert.equal(mirror.verifiedSeedRows,mirror.inspectedRows);}finally{mirrorMemory=mirrorMonitor?.finish();await session.close();}
 const pool=make(input.candidateDatabase,input.candidateOid);
 try{
  const beforeProjection=await readProjectionBaseline(pool,root);assert.deepEqual(beforeProjection.recommendations,p.observation.frozenRecords.recommendations);
  const projection=await projectAndVerify({root,dir,input,policy,pool,scope:'isolated-candidate',target:{database:input.candidateDatabase,oid:input.candidateOid,clusterId:input.clusterId},production:p.observation.postgres,candidate:{database:state.candidateDatabase,oid:state.candidateOid}});
  const report={...projection,elapsedMs:Date.now()-start,mirror,mirrorPostgresMemory:mirrorMemory,beforeProjection};
  fs.writeFileSync(dir+'/isolated-proof.json',JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({...report,beforeProjection:{archiveSha256:beforeProjection.archiveSha256,postgresMemory:beforeProjection.postgresMemory},mirror:undefined,projection:undefined}));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,postgresMemory:e.postgresMemory||null}));process.exitCode=1;});
module.exports={main,assertProjectionTarget,projectAndVerify,monitorPostgresMemory};
