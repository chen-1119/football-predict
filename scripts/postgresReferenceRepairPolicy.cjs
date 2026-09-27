'use strict';
// One incident, one base runtime, one reviewed file set. This is not a release gate override.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const VERSION='postgres-reference-repair-v1';
const BASE_RUNTIME='e00b10693a0df6cb75f6d909d901fdb7f0e95298af55e353cc4ae0da84f0118e';
const FILES=Object.freeze(['scripts/postgresGenerationSource.cjs','scripts/postgresProjectionSync.cjs','server/streamedPublicReferenceArchive.cjs','scripts/postgresFileJsonPayload.cjs']);
const NEW_FILES=Object.freeze(FILES.slice(2));
const ARTIFACTS=Object.freeze(['controller','proof','policy']);
const ENTRYPOINT='/usr/local/sbin/football-release';
const GUARD_LINES=Object.freeze(['  [ ! -e "/var/lib/football-release/reference-repairs/current" ] && [ ! -L "/var/lib/football-release/reference-repairs/current" ] \\', '    || die "a signed PostgreSQL reference repair requires its own recovery"']);
function guardedEntrypoint(bytes){const source=bytes.toString('utf8'),newline=source.includes('\r\n')?'\r\n':'\n',guard=GUARD_LINES.join(newline)+newline,anchor='  flock -n 9 || die "another release or recovery is active"'+newline;
 assert.equal(source.split(anchor).length,2,'unexpected fixed publisher lock anchor');
 if(source.includes(guard)){assert.equal(source.split(guard).length,2);assert.ok(source.includes(anchor+guard));return Buffer.from(source);}
 assert.equal(source.includes('/var/lib/football-release/reference-repairs/current'),false,'unknown reference repair entrypoint guard');return Buffer.from(source.replace(anchor,anchor+guard));}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sha=value=>assert.match(value||'',/^[a-f0-9]{64}$/);
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const objectHash=v=>hash(JSON.stringify(stable(v)));
function validateObservation(o,{fresh=false,now=Date.now()}={}){
 assert.equal(o?.runtime,BASE_RUNTIME);assert.equal(o.complete,BASE_RUNTIME);
 assert.equal(o.productionWrites,0);assert.equal(o.faultCode,'POSTGRES_REFERENCE_ADMISSION_LIMIT');
 const at=Date.parse(o.checkedAt);assert.ok(Number.isFinite(at)&&at<=now+5000);if(fresh)assert.ok(now-at<=900000,'repair observation stale');
 assert.equal(o.generation?.generationId,'g-'+o.generation?.manifestHash);sha(o.generation.manifestHash);
 assert.ok(o.generation.sourceCycleId&&Number.isFinite(Date.parse(o.generation.committedAt)));
 assert.equal(o.previousGeneration?.generationId,'g-'+o.previousGeneration?.manifestHash);sha(o.previousGeneration.manifestHash);assert.ok(o.previousGeneration.sourceCycleId&&Number.isFinite(Date.parse(o.previousGeneration.committedAt)));assert.notEqual(o.previousGeneration.generationId,o.generation.generationId);assert.ok(Date.parse(o.previousGeneration.committedAt)<=Date.parse(o.generation.committedAt));
 sha(o.snapshot?.sha256);assert.ok(Number.isSafeInteger(o.snapshot.bytes)&&o.snapshot.bytes>320*1024*1024&&o.snapshot.bytes<2*1024**3);
 assert.equal(o.snapshot.admissionLimitChars,320*1024*1024);assert.ok(Number.isSafeInteger(o.snapshot.retainedChars)&&o.snapshot.retainedChars>o.snapshot.admissionLimitChars,'current immutable snapshot does not reproduce bounded admission failure');
 assert.equal(o.postgres?.database,'football');assert.match(o.postgres.oid||'',/^[1-9][0-9]{0,9}$/);assert.match(o.postgres.systemIdentifier||'',/^[0-9]{10,20}$/);
 assert.equal(o.postgres.publication?.mode,'active-generation');sha(o.postgres.publication.manifestHash);
 assert.equal(o.postgres.publication.generationId,'g-'+o.postgres.publication.manifestHash);
 assert.ok(o.postgres.publication.sourceCycleId&&Number.isFinite(Date.parse(o.postgres.publication.committedAt)));
 sha(o.frontendStateSha256);
 assert.ok(Number.isSafeInteger(o.frozen?.count)&&o.frozen.count>=198);sha(o.frozen.rootHash);
 for(const [root,count] of [['publicDecisionsRoot','publicDecisionCount'],['publicEvidenceRoot','publicEvidenceCount']]){sha(o.frozen[root]);assert.ok(Number.isSafeInteger(o.frozen[count])&&o.frozen[count]>=198);}
 for(const name of ['recommendations','publicDecisions','publicEvidence','archives']){const rows=o.frozenRecords?.[name];assert.ok(Array.isArray(rows)&&rows.length>0&&rows.length<=100000);assert.equal(new Set(rows.map(x=>x.id)).size,rows.length);for(const row of rows){assert.ok(typeof row.id==='string'&&row.id);sha(row.hash);}}
 assert.equal(o.frozen.rootHash,objectHash(o.frozenRecords.recommendations));assert.equal(o.frozen.count,o.frozenRecords.recommendations.length);
 for(const [name,root,count]of [['publicDecisions','publicDecisionsRoot','publicDecisionCount'],['publicEvidence','publicEvidenceRoot','publicEvidenceCount']]){assert.equal(o.frozen[root],objectHash(o.frozenRecords[name]));assert.equal(o.frozen[count],o.frozenRecords[name].length);}
 assert.deepEqual(o.files.map(x=>x.path).sort(),[...FILES].sort());
 for(const f of o.files){if(NEW_FILES.includes(f.path))assert.equal(f.sha256,null);else sha(f.sha256);}
 assert.equal(o.archive?.ok,true);assert.ok(o.archive.baselineRows>=601);
 assert.equal(o.entrypoint?.path,ENTRYPOINT);sha(o.entrypoint.sha256);const entry=Buffer.from(o.entrypoint.base64||'','base64');assert.ok(entry.length>0&&entry.length<256*1024);assert.equal(hash(entry),o.entrypoint.sha256);guardedEntrypoint(entry);
 assert.ok(Number.isSafeInteger(o.worker?.pid)&&o.worker.pid>0);assert.equal(o.worker.faultCode,'POSTGRES_REFERENCE_ADMISSION_LIMIT');
 const e=o.worker.evidence;assert.equal(e?.source,'journald');assert.equal(e.workerPid,o.worker.pid);assert.match(e.invocationId||'',/^[a-f0-9]{32}$/);assert.ok(Array.isArray(e.entries)&&e.entries.length>0&&e.entries.length<=3000);
 const [cycleStart,cycleFinish,statusAt]=[o.worker.lastCycleStartedAt,o.worker.lastCycleFinishedAt,o.worker.statusCheckedAt].map(Date.parse);assert.ok([cycleStart,cycleFinish,statusAt].every(Number.isFinite)&&cycleStart<=cycleFinish&&cycleFinish<=statusAt&&statusAt<=at,'unbound Worker failure clocks');
 assert.equal(e.cycleStartedAt,o.worker.lastCycleStartedAt);assert.equal(e.cycleFinishedAt,o.worker.lastCycleFinishedAt);
 for(const entry of e.entries){const stamp=Date.parse(entry.at);assert.ok(Number.isSafeInteger(entry.pid)&&entry.pid>0&&Number.isFinite(stamp)&&stamp>=cycleStart&&stamp<=cycleFinish,'unbound Worker fault entry');sha(entry.messageSha256);}
 assert.ok(['admission-failure','publication-lag-after-admission'].includes(o.worker.mode));
 if(o.worker.mode==='admission-failure')assert.equal(e.errorCode,'POSTGRES_REFERENCE_ADMISSION_LIMIT');
 else{
  assert.equal(e.errorCode,'PUBLICATION_SQLITE_IDENTITY_MISMATCH');const a=o.worker.admissionEvidence;assert.equal(a?.source,'journald');assert.equal(a.workerPid,o.worker.pid);assert.equal(a.invocationId,e.invocationId);assert.equal(a.errorCode,'POSTGRES_REFERENCE_ADMISSION_LIMIT');assert.equal(a.cycleStartedAt,o.generation.committedAt);assert.equal(a.cycleFinishedAt,o.worker.lastCycleStartedAt);assert.ok(Array.isArray(a.entries)&&a.entries.length>0&&a.entries.length<=8);
  for(const entry of a.entries){const stamp=Date.parse(entry.at);assert.ok(Number.isSafeInteger(entry.pid)&&entry.pid>0&&Number.isFinite(stamp)&&stamp>=Date.parse(o.generation.committedAt)&&stamp<=cycleStart);sha(entry.messageSha256);}
  assert.ok(![o.generation.generationId,o.previousGeneration.generationId].includes(o.postgres.publication.generationId));assert.ok(Date.parse(o.postgres.publication.committedAt)<Date.parse(o.previousGeneration.committedAt),'PostgreSQL identity is not strictly behind both immutable pointers');
 }
 return o;
}
function verify(bytes,signature,publicKey,now=Date.now()){
 assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<8*1024*1024,'repair capsule size invalid');
 const key=crypto.createPublicKey(publicKey);assert.equal(key.asymmetricKeyType,'rsa');assert.ok(key.asymmetricKeyDetails.modulusLength>=3072);
 assert.ok(crypto.verify('sha256',bytes,key,signature),'repair signature invalid');
 const p=JSON.parse(bytes);assert.equal(p.version,VERSION);assert.equal(p.site,'football-predict');assert.equal(p.channel,'production');
 assert.equal(p.baseRuntimeSha256,BASE_RUNTIME);assert.equal(p.baseSequence,773);assert.equal(p.faultCode,'POSTGRES_REFERENCE_ADMISSION_LIMIT');
 const start=Date.parse(p.createdAt),end=Date.parse(p.expiresAt);
 assert.ok(Number.isFinite(start)&&start<=now+5000&&end>now&&end>start&&end-start<=4*3600000,'repair expired or invalid lifetime');
 validateObservation(p.observation,{now});assert.ok(Date.parse(p.observation.checkedAt)<=start+5000);
 assert.deepEqual(p.files.map(f=>f.path).sort(),[...FILES].sort());
 const content=f=>{sha(f.sha256);const value=Buffer.from(f.base64||'','base64');assert.ok(value.length>0&&value.length<2*1024*1024);assert.equal(value.toString('base64'),f.base64);assert.equal(hash(value),f.sha256);};
 for(const f of p.files){assert.equal(f.beforeSha256,p.observation.files.find(x=>x.path===f.path).sha256);content(f);assert.notEqual(f.sha256,f.beforeSha256,'unchanged file is outside repair delta');}
 assert.deepEqual(Object.keys(p.artifacts).sort(),[...ARTIFACTS].sort());for(const value of Object.values(p.artifacts))content(value);
 for(const key of ['modelPromotion','storageMigration','dataRewrite'])assert.equal(p[key],false);
 assert.deepEqual(p.projectionRepair,{kind:'forward-same-database',from:p.observation.postgres.publication,to:p.observation.generation,previous:p.observation.previousGeneration,dataRollback:false});
 const guard=p.entrypointGuard;assert.equal(guard?.path,ENTRYPOINT);assert.equal(guard.beforeSha256,p.observation.entrypoint.sha256);const target=guardedEntrypoint(Buffer.from(p.observation.entrypoint.base64,'base64'));assert.equal(guard.sha256,hash(target));assert.equal(guard.base64,target.toString('base64'));assert.equal(guard.preserveOnRollback,true);
 return p;
}
function compareFrozen(before,after){
 for(const field of ['recommendations','publicDecisions','publicEvidence','archives']){
  assert.ok(Array.isArray(before[field])&&before[field].length>0&&Array.isArray(after[field]),'missing frozen baseline: '+field);
  const current=new Map(after[field].map(x=>[x.id,x.hash]));assert.equal(current.size,after[field].length);
  for(const entry of before[field])assert.equal(current.get(entry.id),entry.hash,'changed frozen '+field+': '+entry.id);
 }
 return{ok:true,retained:Object.fromEntries(['recommendations','publicDecisions','publicEvidence','archives'].map(k=>[k,before[k].length]))};
}
module.exports={VERSION,BASE_RUNTIME,FILES,NEW_FILES,ARTIFACTS,ENTRYPOINT,GUARD_LINES,guardedEntrypoint,hash,validateObservation,verify,compareFrozen};
