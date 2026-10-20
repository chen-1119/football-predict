'use strict';
// Keep the fixed incident's existing mutable bytes in the active tree. These
// private copies are storage custody only: never reference/evidence authority,
// a generation seed, a PostgreSQL import, or an alternate transition lease.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const VERSION='manual-public-original-carry-forward-v1';
const FILES=[['matches-current.json','current',8388608],['prediction-snapshots.json','warehouse',2147483648]];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const identity=s=>Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
function parents(file){
 const absolute=path.resolve(file);for(let at=path.dirname(absolute);;at=path.dirname(at)){const st=fs.lstatSync(at);a(st.isDirectory()&&!st.isSymbolicLink(),'linked original directory');if(at===path.dirname(at))break;}
 return absolute;
}
function plain(fd){const st=fs.fstatSync(fd,{bigint:true});a(st.isFile()&&st.nlink===1n,'original must be a single-link regular file');return st;}
function named(file,expected){const st=fs.lstatSync(file,{bigint:true});a(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n);a.deepEqual(identity(st),expected,'original path identity changed');}
function inspect(file,pin,max,durable=false){
 parents(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=plain(fd);a(before.size===BigInt(pin.bytes)&&before.size>0n&&before.size<=BigInt(max),'original byte bound');
  const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1048576);let n,total=0;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,n));total+=n;}
  a.equal(total,pin.bytes);a.equal(digest.digest('hex'),pin.sha256,'original hash differs');if(durable&&process.platform==='linux')fs.fsyncSync(fd);a.deepEqual(identity(plain(fd)),identity(before));named(file,identity(before));return identity(before);
 }finally{fs.closeSync(fd);}
}
function syncDirectory(directory){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function createJson(file,value){
 const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(process.platform==='linux')syncDirectory(path.dirname(file));
}
function copyExact(source,target,pin,max){
 parents(source);parents(target);const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let output;
 try{const before=plain(input);a(before.size===BigInt(pin.bytes)&&before.size>0n&&before.size<=BigInt(max));
  output=fs.openSync(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1048576);let n,total=0;
  while((n=fs.readSync(input,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,n));let written=0;while(written<n){const count=fs.writeSync(output,buffer,written,n-written,null);a(count>0);written+=count;}total+=n;}
  a.equal(total,pin.bytes);a.equal(digest.digest('hex'),pin.sha256);fs.fsyncSync(output);a.deepEqual(identity(plain(input)),identity(before));named(source,identity(before));
  fs.closeSync(output);output=undefined;inspect(target,pin,max);return identity(before);
 }finally{if(output!==undefined)fs.closeSync(output);fs.closeSync(input);}
}
function gapFor(file){
 const bytes=fs.readFileSync(file);a(bytes.length<=8388608);const rows=JSON.parse(bytes);a(Array.isArray(rows)&&rows.length<=512);
 return rows.filter(m=>m.predictionMeta?.publicReferenceDecision).map(m=>{const r=m.predictionMeta.publicReferenceDecision;return{sourceMatchId:String(m.sourceMatchId),recordHash:r.contentHash,recordSha256:hash(JSON.stringify(r))};}).sort((x,y)=>x.sourceMatchId<y.sourceMatchId?-1:1);
}
function captureOriginals({live,build,custody,pins,authorizationHash}){
 a.match(authorizationHash,/^[a-f0-9]{64}$/);a.equal(fs.existsSync(custody),false,'original custody is create-only');
 for(const root of [live,build])a.equal(fs.realpathSync(root),path.resolve(root));
 parents(custody);fs.mkdirSync(custody,{mode:0o700});if(process.platform==='linux')syncDirectory(path.dirname(custody));
 const artifacts=FILES.map(([name,key,max])=>({name,key,max,pin:pins[key],sourceIdentity:copyExact(path.join(live,'public/data',name),path.join(custody,name),pins[key],max)}));
 a.deepEqual(gapFor(path.join(custody,'matches-current.json')),pins.gap,'original29 record bytes differ');
 for(const item of artifacts){
  const target=path.join(build,'public/data',item.name),existing=fs.lstatSync(target);a(existing.isFile()&&!existing.isSymbolicLink()&&existing.nlink===1);
  const temporary=target+'.manual-original-'+process.pid;a.equal(fs.existsSync(temporary),false);
  copyExact(path.join(custody,item.name),temporary,item.pin,item.max);fs.renameSync(temporary,target);
  if(process.platform==='linux')syncDirectory(path.dirname(target));inspect(target,item.pin,item.max);named(path.join(live,'public/data',item.name),item.sourceIdentity);
 }
 const proof={version:VERSION,authorizationHash,createdAt:new Date().toISOString(),gapHash:hash(JSON.stringify(pins.gap)),artifacts,privateStorageOnly:true,evidenceAdmissions:0,postgresWrites:0};
 createJson(path.join(custody,'captured.json'),proof);return proof;
}
function verifyOriginals({live,target,custody,pins,authorizationHash,sourceCas}){
 const proof=JSON.parse(fs.readFileSync(path.join(custody,'captured.json')));a.equal(proof.version,VERSION);a.equal(proof.authorizationHash,authorizationHash);a.equal(proof.gapHash,hash(JSON.stringify(pins.gap)));a.equal(proof.artifacts.length,2);
 for(const [index,[name,key,max]]of FILES.entries()){
  const item=proof.artifacts[index];a.equal(item.name,name);a.equal(item.key,key);a.equal(item.max,max);a.deepEqual(item.pin,pins[key]);
  inspect(path.join(custody,name),pins[key],max);inspect(path.join(target,'public/data',name),pins[key],max,true);
  if(sourceCas){a(live);inspect(path.join(live,'public/data',name),pins[key],max);named(path.join(live,'public/data',name),item.sourceIdentity);}
 }
 if(process.platform==='linux')syncDirectory(path.join(target,'public/data'));
 a.deepEqual(gapFor(path.join(target,'public/data/matches-current.json')),pins.gap);return{ok:true,version:VERSION,authorizationHash,originalRecords:pins.gap.length,evidenceAdmissions:0,postgresWrites:0};
}
function main(){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(process.argv.length,6);
 const [stage,sha,ownerText,target]=process.argv.slice(2);a(['capture','next','before-swap','after-swap','serving'].includes(stage));a.match(sha,/^[a-f0-9]{64}$/);a.match(ownerText,/^[1-9]\d*$/);
 const policy=require('./manualOfficialReleaseRecovery.cjs'),root=path.resolve(__dirname,'..'),directory='/var/lib/football-release/native/'+sha;
 require('./baselineAuthorityReplayRepair.cjs').heldAncestorLock(Number(ownerText));
 const state=JSON.parse(fs.readFileSync(path.join(directory,'state.json')));a.equal(state.sha,sha);a.equal(state.dataPlane,'code-only');
 if(!state.manualOfficialPreparationAuthorizationHash){console.log(JSON.stringify({ok:true,manualOriginalCarryForward:false}));return;}
 a.equal(state.oldSha,policy.BASE);
 const bytes=fs.readFileSync(path.join(directory,'manual-official-preparation-authorization.json')),auth=policy.candidateAuthorization(root,JSON.parse(bytes)),authorizationHash=hash(bytes);
 a.equal(authorizationHash,state.manualOfficialPreparationAuthorizationHash);
 const observed=JSON.parse(fs.readFileSync(path.join(directory,'manual-official-preparation-observation.json')));a.equal(observed.authorizationHash,authorizationHash);a.equal(observed.report.preparationAllowed,true);a.equal(observed.report.workerReport.ok,false);
 const unit=require('node:child_process').execFileSync('/usr/bin/systemctl',['show','football-sync-worker.service','--property=ActiveState,MainPID','--value'],{encoding:'utf8',timeout:5000}).trim().split('\n');a(unit.includes('inactive')&&unit.includes('0'),'original copy requires the normally stopped worker');
 const build=/^\/opt\/football-predict\.build-[a-f0-9]{12}-[0-9]+$/;
 if(stage==='capture'){a(build.test(target));a(path.basename(target).startsWith('football-predict.build-'+sha.slice(0,12)+'-'));}
 else a.equal(target,['after-swap','serving'].includes(stage)?'/opt/football-predict':'/opt/football-predict.next');
 const custody=path.join(directory,'manual-public-originals'),pins={current:auth.current,warehouse:auth.warehouse,gap:auth.gap};
 let result;if(stage==='capture')result=captureOriginals({live:'/opt/football-predict',build:target,custody,pins,authorizationHash});
 else result=verifyOriginals({live:'/opt/football-predict',target,custody,pins,authorizationHash,sourceCas:stage==='before-swap'});
 createJson(path.join(custody,stage+'-accepted.json'),{...result,checkedAt:new Date().toISOString(),stage});
 console.log(JSON.stringify({ok:true,stage,originalRecords:auth.gap.length,privateStorageOnly:true,evidenceAdmissions:0,postgresWrites:0}));
}
module.exports={VERSION,FILES,hash,inspect,copyExact,gapFor,captureOriginals,verifyOriginals};
if(require.main===module){try{main();}catch(e){console.error(JSON.stringify({ok:false,version:VERSION,error:e.code||e.message}));process.exitCode=1;}}
