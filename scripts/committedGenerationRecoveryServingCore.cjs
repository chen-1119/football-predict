'use strict';
// Engineering admission for the exact signed code-repair pair only. The
// ordinary active-generation worker observation is retained, never promoted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
function assessServingRepair({healthReport,healthPublication,identity,pair,workerObservation}){
  assert.equal(healthReport.ok,true);assert.equal(pair.version,'signed-committed-generation-repair-pair-v1');assert.equal(pair.reason,'exact-signed-incident-pair');assert.equal(pair.productionWrites,0);
  for(const key of ['generationId','manifestHash','sourceCycleId','committedAt']){assert.equal(healthPublication[key],identity[key]);assert.equal(pair.committed[key],identity[key]);assert.equal(workerObservation.postgres[key],identity[key]);assert.equal(workerObservation.generation[key],pair.rawCurrent[key]);}
  assert.equal(workerObservation.postgres.readable,true);assert.equal(workerObservation.postgres.sourceCycleId,identity.sourceCycleId);assert.equal(workerObservation.postgres.generationSourceCycleId,identity.sourceCycleId);
  assert.equal(workerObservation.validationReady,true);assert.equal(workerObservation.generationReady,true);assert.equal(workerObservation.projectionReady,true);
  const mismatches=['generationId','manifestHash','sourceCycleId','committedAt'].filter(k=>pair.rawCurrent[k]!==identity[k]),expected=mismatches.map(k=>'public-postgres-publication-identity-mismatch:'+k);
  if(pair.rawCurrent.sourceCycleId!==identity.sourceCycleId)expected.push('public-postgres-source-cycle-mismatch');
  assert.deepEqual([...workerObservation.blockers].sort(),expected.sort(),'unexpected worker publication blocker');assert.equal(workerObservation.ready,expected.length===0);
  return{ok:true,verifier:'signed-committed-generation-code-recovery-core-v1',servingCommittedPublicationAccepted:true,originalWorkerReadiness:workerObservation.ready,originalWorkerBlockers:workerObservation.blockers,naturalCycleAcceptance:false,newSourceFreshnessAccepted:false,productionDataWrites:0};
}
async function verifyCommittedArchives({session,generations,archive,releaseSha}){
  const manifest=archive.fixedManifest(),lineage=archive.fixedAuthority(),sourceIds=new Set(manifest.baseline.records.map(r=>String(r.sourceMatchId)));
  assert.equal(sourceIds.size,601);
  await session.client.query("SET LOCAL statement_timeout = '120s'");
  const pg=await session.client.query('SELECT id,dataset,match_id,source_match_id,payload::text AS payload FROM football.match_snapshots WHERE source_match_id=ANY($1::text[])',[[...sourceIds]]);
  const postgresRows=pg.rows.map(r=>archive.archiveObservation({rowId:r.id,dataset:r.dataset,matchId:r.match_id,sourceMatchIdColumn:r.source_match_id,match:JSON.parse(r.payload)}));
  const context=session.publication.context,generationRows=[];
  for(const [name,dataset]of [['matches-current.json','current'],['matches-history.json','history']]){
    const document=generations.readGenerationFile(context,name,{parseJson:true}),matches=Array.isArray(document)?document:document?.matches;assert(Array.isArray(matches));
    for(const match of matches)if(sourceIds.has(String(match?.sourceMatchId)))generationRows.push(archive.archiveObservation({dataset,match}));
  }
  return archive.evaluateSignedBaselineRows({manifest,lineage,generationRows,postgresRows,postgresIdentity:session.identity,generationPointer:context.pointer,releaseSha});
}
async function verify(dir,mode='core'){
  assert(['core','archives'].includes(mode));
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
  const controller=require(dir+'/controller.cjs'),p=controller.load(dir);assert.equal(p.servingCoreVersion,'signed-committed-generation-serving-core-v1');
  const bytes=fs.readFileSync(dir+'/serving-core.cjs');assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),p.servingCoreSha256);
  const APP='/opt/football-predict',STORE='/var/lib/football-predict',RELEASE='/var/lib/football-release';assert.equal(fs.readFileSync(APP+'/.release-bundle-sha256','utf8').trim(),p.targetSha256);assert.equal(fs.existsSync(RELEASE+'/recovery/current'),true);
  const unit=cp.execFileSync('/usr/bin/systemctl',['show','football-sync-worker.service','--property=MainPID,ActiveState','--no-pager'],{encoding:'utf8'});assert(/^MainPID=0$/m.test(unit)&&/^ActiveState=(inactive|failed)$/m.test(unit),'normal worker must remain stopped before code handover');
  const manifest=JSON.parse(fs.readFileSync(RELEASE+'/source-baselines/'+p.targetSha256+'/manifest.json'));assert.equal(manifest.sha256,p.targetSha256);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(RELEASE+'/source-baselines/'+p.targetSha256+'/manifest.json')).digest('hex'),p.manifestSha256);
  const load=require(dir+'/engine.cjs').verifiedModules(p.sourceDir,manifest,fs),module=n=>load(p.sourceDir+'/'+n).exports;
  const core=module('scripts/verifyNativeDeploymentCore.cjs'),generations=module('server/dataGenerationStore.cjs'),code=module('scripts/nativeCodeReleaseDataPlane.cjs'),same=module('scripts/codeReleaseAcceptance.cjs').assertSamePublication;
  module('scripts/releaseWorkerCodeRepair.cjs').candidateAuthorization(APP,p.externalWorker);
  const state=JSON.parse(fs.readFileSync(RELEASE+'/native/'+p.targetSha256+'/state.json'));assert.equal(state.sha,p.targetSha256);assert.equal(state.dataPlane,'code-only');assert.equal(state.coldRecoveryAuthorizationId,p.id);assert.equal(state.committedGenerationRepairAuthorizationHash,p.externalWorkerSha256);assert.equal(state.emergencyActivationAuthorizationHash,p.externalEmergencyAuthorizationHash);
  await code.verifySchema(state);
  const Pool=module('scripts/nativeReleasePostgresTransport.cjs').NativeReleasePostgresPool,pool=new Pool({database:'football',databaseOid:state.oldDatabaseOid,clusterId:state.clusterId});let session,held;
  const fetchHealth=async()=>{const res=await fetch('http://127.0.0.1:8788/api/v1/health',{signal:AbortSignal.timeout(15000)});assert.equal(res.status,200);return res.json();};
  try{
    const before=await fetchHealth(),healthReport=core.assessHealth(before);assert.equal(healthReport.ok,true);
    const originalWorkerObservation=await module('scripts/postgresWorkerObservation.cjs').readPostgresWorkerObservation({storeDir:STORE,publicDataDir:APP+'/public/data',pool,validationStep:{ok:true},generationStep:{ok:true},projectionStep:{ok:true}});
    held=generations.acquirePointerCommitLock({lockDir:generations.storePaths(STORE).pointerLockDir,timeoutMs:10000,staleMs:60000});
    session=await module('scripts/postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({pool,storeDir:STORE,publicDataDir:APP+'/public/data',protectReceipt:true,pointerLockHandle:held});await session.guardedFinals();
    const transaction=(await session.client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];assert.equal(transaction.readonly,'on');assert.equal(transaction.isolation,'repeatable read');
    const pair=code.assertRepairPair(state,session,generations.resolveCurrentGeneration({storeDir:STORE}),generations.resolvePreviousGeneration({storeDir:STORE}),p.externalWorker,p.externalWorkerSha256);
    const result=assessServingRepair({healthReport,healthPublication:healthReport.storage.publication,identity:session.identity,pair,workerObservation:originalWorkerObservation});
    const archives=mode==='archives'?await verifyCommittedArchives({session,generations,archive:module('scripts/verifyReleaseArchiveSuccessor.cjs'),releaseSha:p.targetSha256}):null;
    const after=await fetchHealth(),afterReport=core.assessHealth(after);assert.equal(afterReport.ok,true);same(afterReport.storage.publication,session.identity);await session.guardedFinals();
    return{...result,archives,checkedAt:new Date().toISOString(),target:p.targetSha256,authorizationId:p.id,readonlyTransaction:transaction,storage:healthReport.storage,projectionCounts:healthReport.projectionCounts,signedPair:pair,originalWorkerObservation,scope:'Serving API, schema and exact signed committed PG pair accepted for code recovery. The unchanged worker observation stays pending until natural raw-to-PG convergence. No new quotes, training or recommendation adoption is claimed.'};
  }finally{await session?.close();held?.release();await pool.end();}
}
module.exports={assessServingRepair,verifyCommittedArchives,verify};
if(require.main===module){assert([3,4].includes(process.argv.length));verify(path.resolve(process.argv[2]),process.argv[3]||'core').then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,error:String(e.message).slice(0,500),productionDataWrites:0}));process.exitCode=1;});}
