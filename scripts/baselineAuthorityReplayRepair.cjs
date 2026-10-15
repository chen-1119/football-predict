'use strict';
// One observed code failure, not a general unhealthy-baseline permission.
// The signed root controller alone consumes this SELECT-only preparation proof.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),a=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),APP='/opt/football-predict',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const POLICY=Object.freeze({version:'r876-authority-replay-preparation-v1',baselineSha:'0862f893a8af673c67910cbb1a17d51f23e973b6f2e55433ccaa6e6243c586d5',manifestSha:'161fc726ae4ae8af9633af274f5ba412994e6e3a5e6e2bc6449c465c003d702f',apiPid:1534542,apiInvocation:'cb49592cfe5f45fa9d90d2fa6ea3d769',workerPid:1543498,workerInvocation:'91258f67e78d4509918b2b231b87b43a',oid:'28598409',recordKey:'reviewed-analysis-2026-10-15-batch-29416d784d40104730914178b69201325bf638ff9e87efd1e3265cc6ee5c3be9',payloadSha:'10cd450e1c6d6f237519ad05ad4518e845b1648cb9cffe88684a1a4a9e4ff491',ackSha:'be682ff91b1c75ea8c7692a59e21f521f0db1fd655bc50338def16b172142a1b'});
function authorityRoute(authority,errorCode,stage){
 a(['initial','paused'].includes(stage));
 if(errorCode!==undefined){a.equal(errorCode,'RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY');return'repair';}
 a.equal(stage,'initial');a.equal(authority?.mode,'reviewed-and-trained');a.equal(authority?.activeValidation?.ok,true);
 a.equal(authority.availableForCurrentDay,true);a.equal(authority.businessDate,authority.currentBusinessDate);return'normal-health-required';
}
function validate(s,stage,previous=null){
 a.equal(Object.keys(s).sort().join(','),'ackSha,api,baselineSha,bootId,candidateSha,candidateVerified,dataPlane,flock,monotonicNs,oid,oldError,originalRecords,ownerPid,payloadSha,publication,readonly,wallMs,worker');
 a(Number.isSafeInteger(s.wallMs)&&Number.isSafeInteger(s.ownerPid)&&s.ownerPid>1);a.match(s.monotonicNs,/^\d+$/);a.match(s.bootId,/^[a-f0-9-]{36}$/);
 a.deepEqual(Object.keys(s.flock).sort(),['device','inode','ownerPid']);a(Number.isSafeInteger(s.flock.ownerPid)&&s.flock.ownerPid>1);a.match(s.flock.device,/^\d+$/);a.match(s.flock.inode,/^\d+$/);
 a.equal(s.publication.mode,'active-generation');a.match(s.publication.manifestHash,/^[a-f0-9]{64}$/);a.equal(s.publication.generationId,'g-'+s.publication.manifestHash);a(typeof s.publication.sourceCycleId==='string'&&s.publication.sourceCycleId.length>0&&s.publication.sourceCycleId.length<=256&&Date.parse(s.publication.committedAt)<=s.wallMs);
 a(['initial','paused'].includes(stage));a.equal(s.baselineSha,POLICY.baselineSha);a.match(s.candidateSha,/^[a-f0-9]{64}$/);a.notEqual(s.candidateSha,s.baselineSha);
 a.equal(s.oldError,'RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY');a.equal(s.candidateVerified,true);a.equal(s.originalRecords,13);a.equal(s.oid,POLICY.oid);a.equal(s.readonly,'on');
 a.equal(s.payloadSha,POLICY.payloadSha);a.equal(s.ackSha,POLICY.ackSha);a.equal(s.dataPlane,'code-only');a.equal(s.api.ActiveState,'active');a.equal(s.api.User,'football');
 a.equal(s.api.ControlGroup,'/system.slice/football-predict.service');a.equal(s.api.ControlPID,'0');a.equal(s.api.NoNewPrivileges,'yes');
 if(stage==='initial'){a.equal(Number(s.api.MainPID),POLICY.apiPid);a.equal(s.api.InvocationID,POLICY.apiInvocation);a.equal(Number(s.worker.MainPID),POLICY.workerPid);a.equal(s.worker.InvocationID,POLICY.workerInvocation);a.equal(s.worker.ActiveState,'active');}
 else{a(Number.isSafeInteger(Number(s.api.MainPID))&&Number(s.api.MainPID)>1);a.notEqual(Number(s.api.MainPID),POLICY.apiPid);a.match(s.api.InvocationID,/^[a-f0-9]{32}$/);a.notEqual(s.api.InvocationID,POLICY.apiInvocation);a.equal(s.worker.MainPID,'0');a(['inactive','failed'].includes(s.worker.ActiveState));a(previous);a.equal(previous.version,POLICY.version);a.equal(previous.baselineHealthy,false);a.equal(previous.preparationOnly,true);a.equal(previous.productionDataWrites,0);a.equal(previous.workerBlockersBypassed,false);a.equal(previous.candidateHealthStillRequired,true);a.equal(previous.baselineSha,s.baselineSha);a.equal(previous.candidateSha,s.candidateSha);a.equal(previous.ownerPid,s.ownerPid);a.deepEqual(previous.flock,s.flock);a.equal(previous.bootId,s.bootId);
  const {version,baselineHealthy,preparationOnly,productionDataWrites,workerBlockersBypassed,candidateHealthStillRequired,...prior}=previous;void version;void baselineHealthy;void preparationOnly;void productionDataWrites;void workerBlockersBypassed;void candidateHealthStillRequired;validate(prior,'initial');
  const wall=s.wallMs-previous.wallMs,mono=Number(BigInt(s.monotonicNs)-BigInt(previous.monotonicNs))/1e6;a(wall>=0&&wall<=900000&&mono>=0&&mono<=900000&&Math.abs(wall-mono)<=5000,'baseline proof clock expired or changed');}
 return{...s,version:POLICY.version,baselineHealthy:false,preparationOnly:true,productionDataWrites:0,workerBlockersBypassed:false,candidateHealthStillRequired:true};
}
function read(file,max){const s=fs.lstatSync(file);a(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&s.nlink===1&&!(s.mode&0o022)&&s.size<=max);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const b=fs.readFileSync(fd),end=fs.fstatSync(fd);a.equal(b.length,s.size);a.equal(end.ino,s.ino);a.equal(end.mtimeMs,s.mtimeMs);return b;}finally{fs.closeSync(fd);}}
function ancestorLockDescriptor(ownerPid,lockPath='/run/lock/football-release.lock'){
 const t=fs.lstatSync(lockPath);a(t.isFile()&&!t.isSymbolicLink()&&t.uid===0&&t.nlink===1);const ancestors=new Set([process.pid]);let pid=process.ppid;
 for(let i=0;i<16&&pid>1&&!ancestors.has(ownerPid);i++){const s=fs.readFileSync('/proc/'+pid+'/status','utf8');a.equal(/^Uid:\s+(\d+)/m.exec(s)?.[1],'0');ancestors.add(pid);pid=Number(/^PPid:\s+(\d+)/m.exec(s)?.[1]);}a(ancestors.has(ownerPid));
 const lockEntry=info=>/lock:\s+\d+:\s+(FLOCK\s+ADVISORY\s+WRITE\s+(-?\d+)\s+[^\n]+)/m.exec(info);
 for(const name of fs.readdirSync('/proc/self/fd')){if(!/^\d+$/.test(name))continue;try{
  const st=fs.fstatSync(Number(name));if(st.dev!==t.dev||st.ino!==t.ino)continue;const m=lockEntry(fs.readFileSync('/proc/self/fdinfo/'+name,'utf8'));if(!m)continue;
  if(ancestors.has(Number(m[2])))return{fd:Number(name),proof:{ownerPid:Number(m[2]),device:String(t.dev),inode:String(t.ino)}};
  // The installed shell uses exec 9>lock; flock -n 9. The acquiring child exits
  // while the locked open-file description remains inherited. Verify the same
  // exclusive kernel entry on our descriptor and fixed FD 9 of the root caller.
  const anchor=fs.statSync('/proc/'+ownerPid+'/fd/9'),held=lockEntry(fs.readFileSync('/proc/'+ownerPid+'/fdinfo/9','utf8'));
  if(anchor.dev===t.dev&&anchor.ino===t.ino&&held&&held[1].trim().replace(/\s+/g,' ')===m[1].trim().replace(/\s+/g,' '))return{fd:Number(name),proof:{ownerPid,device:String(t.dev),inode:String(t.ino)}};
 }catch{/* disappearing unrelated descriptor or absent fixed parent descriptor */}}
 throw Error('baseline preparation requires inherited exclusive root flock');
}
function heldAncestorLock(ownerPid,lockPath){return ancestorLockDescriptor(ownerPid,lockPath).proof;}
async function verify(stage,candidateSha,ownerPid,previous){
 a(['initial','paused'].includes(stage));
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(process.version,'v22.22.1');a.match(candidateSha,/^[a-f0-9]{64}$/);a(Number.isSafeInteger(ownerPid)&&ownerPid>1);
 const boundary=()=>{for(const n of ['.release-bundle-sha256','.release-live-complete'])a.equal(read(APP+'/'+n,128).toString().trim(),POLICY.baselineSha);
  if(stage==='initial')a(!fs.existsSync('/var/lib/football-release/recovery/current'));
  else{const t=require(ROOT+'/deploy/light-server/football-release-recovery.cjs').loadTransaction();a(t);a.equal(t.bundleSha,candidateSha);a.equal(t.oldIdentity.bundleMarker,POLICY.baselineSha);a.equal(t.oldIdentity.liveMarker,POLICY.baselineSha);}
 };boundary();const flock=heldAncestorLock(ownerPid);
 a.equal(require('./releaseDataPlanePolicy.cjs').classify(require('./releaseDataPlanePolicy.cjs').capture(APP),require('./releaseDataPlanePolicy.cjs').capture(ROOT)).mode,'code-only');
 const manifestRaw=read('/usr/local/libexec/football-research-broker/manifest.json',4*1024*1024);a.equal(sha(manifestRaw),POLICY.manifestSha);const manifest=JSON.parse(manifestRaw);a.equal(manifest.sha256,POLICY.baselineSha);const inventory=new Map(manifest.archiveSourceEvidence.inventory.entries.map(r=>[r.path,r.sha256])),seen=new Set();
 function visit(file){if(seen.has(file))return;seen.add(file);a(file.startsWith(APP+'/'));const raw=read(file,8*1024*1024);a.equal(sha(raw),inventory.get(path.relative(APP,file)));for(const m of raw.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g))visit(require.resolve(path.resolve(path.dirname(file),m[1])));}
 for(const n of ['server/recommendationAuthority.cjs','server/postgresStore.cjs','deploy/light-server/collector-trust-registry.json'])visit(APP+'/'+n);
 a.notEqual(sha(fs.readFileSync(ROOT+'/server/recommendationAuthority.cjs')),inventory.get('server/recommendationAuthority.cjs'));a.notEqual(sha(fs.readFileSync(ROOT+'/server/researchFrozenCombos.cjs')),inventory.get('server/researchFrozenCombos.cjs'));
 const units=()=>Object.fromEntries(cp.execFileSync('/usr/bin/systemctl',['show','football-predict.service','football-sync-worker.service','--property=Id,MainPID,ActiveState,InvocationID,User,ControlPID,ControlGroup,NoNewPrivileges'],{encoding:'utf8',timeout:5000}).trim().split(/\n\n/).map(b=>{const v=Object.fromEntries(b.split('\n').map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));return[v.Id,v];}));
 // Transport stability is checked without calling a false business result true.
 let before;for(let i=0,stable=0;i<120;i++){before=units();const u=before['football-predict.service'];try{const r=await fetch('http://127.0.0.1:8788/api/health',{signal:AbortSignal.timeout(2000)}),v=await r.json();stable=r.status===200&&v.ok===true&&v.service==='football-predict-server'&&u.ActiveState==='active'?stable+1:0;if(stable>=2)break;}catch{stable=0;}if(i===119)throw Error('baseline transport unavailable');await new Promise(r=>setTimeout(r,1000));}
 const api=before['football-predict.service'],worker=before['football-sync-worker.service'],pid=Number(api.MainPID);a(pid>0);const env=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(Boolean).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));const url=env.FOOTBALL_POSTGRES_URL||env.DATABASE_URL;a(url);a.equal(env.FOOTBALL_STORAGE_MODE,'postgres-only');
 const uid=Number(cp.execFileSync('/usr/bin/id',['-u','football'],{encoding:'utf8',timeout:3000}).trim()),gid=Number(cp.execFileSync('/usr/bin/id',['-g','football'],{encoding:'utf8',timeout:3000}).trim());
 const inherited=ancestorLockDescriptor(ownerPid);a.deepEqual(inherited.proof,flock);
 const pool=require('./baselineReadonlyPeer.cjs').createReadonlyPeerPool({connectionString:url,sslMode:env.FOOTBALL_POSTGRES_SSL_MODE,uid,gid,fd:inherited.fd,lock:flock});let client,result;
 try{client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='10000ms'");const identity=(await client.query("SELECT current_database() AS name,current_user AS role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('transaction_read_only') AS readonly")).rows[0];a.equal(identity.name,'football');a.equal(identity.role,'football');a.equal(identity.oid,POLICY.oid);a.equal(identity.readonly,'on');
  const guard={query(sql,args){a(/^SELECT\b/i.test(sql.trim())&&!/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/i.test(sql),'SELECT-only baseline proof');return client.query(sql,args);}};
  const artifacts=(await guard.query('SELECT artifact_key,payload::text AS json,payload_sha256,payload_bytes FROM football.private_model_artifacts WHERE artifact_key=ANY($1::text[])',[ [POLICY.recordKey,POLICY.recordKey+'-ack'] ])).rows;a.equal(artifacts.length,2);for(const r of artifacts){a.equal(Buffer.byteLength(r.json),Number(r.payload_bytes));a.equal(sha(r.json),r.payload_sha256);a.equal(r.payload_sha256,r.artifact_key.endsWith('-ack')?POLICY.ackSha:POLICY.payloadSha);}
  const old=require(APP+'/server/recommendationAuthority.cjs'),next=require(ROOT+'/server/recommendationAuthority.cjs');let oldError,oldAuthority;try{oldAuthority=await old.readPublicationAuthority(guard,{policy:old.TRAINED_ONLY_POLICY,asOf:new Date().toISOString()});}catch(e){if(typeof e.code!=='string')throw e;oldError=e.code;}
  if(authorityRoute(oldAuthority,oldError,stage)==='normal-health-required'){
   a.deepEqual(units(),before);boundary();a.deepEqual(heldAncestorLock(ownerPid),flock);
   throw Object.assign(Error('BASELINE_REPAIR_NOT_APPLICABLE'),{code:'BASELINE_REPAIR_NOT_APPLICABLE'});
  }
  const proof=await next.readPublicationAuthority(guard,{policy:next.TRAINED_ONLY_POLICY,asOf:new Date().toISOString()}),center=next.getAuthorityCenterPayload(proof)?.recommendationCenter;
  const metadata=Object.fromEntries((await guard.query('SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])',[['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at']])).rows.map(r=>[r.key,{value:r.value}]));
  const publication=require(APP+'/server/postgresProjectionStore.cjs').publicationIdentityFromMeta(metadata,{strictGenerationSource:true});
  const paired=require(APP+'/server/dataGenerationBundle.cjs').resolveCommittedPostgresPublication({storeDir:'/var/lib/football-predict',publicDataDir:APP+'/public/data',postgresIdentity:publication,validatePayloadSemantics:false});a(paired.context);a.equal(paired.context.generationId,publication.generationId);
  result={baselineSha:POLICY.baselineSha,candidateSha,ownerPid,flock,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),wallMs:Date.now(),monotonicNs:String(process.hrtime.bigint()),api,worker,oldError,candidateVerified:proof.activeValidation.ok===true,originalRecords:center?.reviewedAnalysis?.records?.length,oid:identity.oid,readonly:identity.readonly,payloadSha:POLICY.payloadSha,ackSha:POLICY.ackSha,dataPlane:'code-only',publication};
  await client.query('ROLLBACK');
 }finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}await pool.end();}
 const after=units();a.deepEqual(after,before);boundary();a.deepEqual(heldAncestorLock(ownerPid),flock);return validate(result,stage,previous);
}
function readProof(stream){return new Promise((resolve,reject)=>{const chunks=[];let size=0,done=false;
 const finish=error=>{if(done)return;done=true;clearTimeout(timer);stream.removeListener('data',data);stream.removeListener('end',end);stream.removeListener('error',failure);if(error){stream.destroy();reject(Error(error));}else{const b=Buffer.concat(chunks);try{a(Buffer.from(b.toString('utf8')).equals(b));resolve(JSON.parse(b));}catch(e){reject(e);}}};
 const data=b=>{if(!Buffer.isBuffer(b)||size+b.length>8192)return finish('BASELINE_PROOF_BOUND');size+=b.length;chunks.push(b);},end=()=>finish(),failure=()=>finish('BASELINE_PROOF_INPUT');
 const timer=setTimeout(()=>finish('BASELINE_PROOF_TIMEOUT'),8000);stream.on('data',data);stream.once('end',end);stream.once('error',failure);
 });}
module.exports={POLICY,validate,verify,heldAncestorLock,ancestorLockDescriptor,readProof,authorityRoute};
if(require.main===module){const[stage,sha,owner,...rest]=process.argv.slice(2);a.equal(rest.length,0);
 (async()=>verify(stage,sha,Number(owner),stage==='paused'?await readProof(process.stdin):null))().then(v=>console.log(JSON.stringify(v))).catch(e=>{const normal=stage==='initial'&&e.code==='BASELINE_REPAIR_NOT_APPLICABLE';console.error(JSON.stringify({ok:false,scope:POLICY.version,error:String(e.message).slice(0,500),productionDataWrites:0,...(normal?{normalHealthRequired:true}: {})}));process.exitCode=normal?3:1;});}
