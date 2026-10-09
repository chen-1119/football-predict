'use strict';
// Native code releases preserve a verified generation. Large history is data,
// never admitted merely because it was found in an untrusted candidate tree.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const RELATIVE='public/data/prediction-snapshots.json',MAX_BYTES=2*1024**3;
const fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink,s.uid,s.gid].map(String).join(':');
function digestFile(file,expected){
 const before=fs.lstatSync(file,{bigint:true});a(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'plain single-link file required');
 a(Number.isSafeInteger(expected.bytes)&&expected.bytes>0&&expected.bytes<=MAX_BYTES,'reader size bound');a.equal(before.size,BigInt(expected.bytes));
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256'),buffer=Buffer.alloc(64*1024);let bytes=0;
 try{a.equal(fingerprint(fs.fstatSync(fd,{bigint:true})),fingerprint(before));for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;bytes+=n;a(bytes<=expected.bytes);hash.update(buffer.subarray(0,n));}
  a.equal(bytes,expected.bytes);a.equal(fingerprint(fs.fstatSync(fd,{bigint:true})),fingerprint(before));a.equal(fingerprint(fs.lstatSync(file,{bigint:true})),fingerprint(before));a.equal(hash.digest('hex'),expected.sha256,'exact generation bytes required');
 }finally{fs.closeSync(fd);}return {bytes,sha256:expected.sha256};
}
function rootPath(file,directory){
 const s=fs.lstatSync(file);a(!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'protected native evidence');a(directory?s.isDirectory():s.isFile()&&s.nlink===1);
}
function verify({artifactRoot,relative,seedProof,releaseSha}){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(relative,RELATIVE);a.match(releaseSha,/^[a-f0-9]{64}$/);
 a(/^\/opt\/football-predict(?:\.build-[a-f0-9]{12}-[0-9]+|\.next)$/.test(artifactRoot));a.equal(fs.realpathSync(artifactRoot),artifactRoot);
 const native='/var/lib/football-release/native/'+releaseSha;a.equal(seedProof,native+'/seed-accepted.json');
 for(const dir of ['/var/lib/football-release','/var/lib/football-release/native',native])rootPath(dir,true);
 rootPath(seedProof,false);a(fs.statSync(seedProof).size<=1024*1024);const proof=JSON.parse(fs.readFileSync(seedProof,'utf8'));
 a.equal(proof.ok,true);a.equal(proof.seed,true);a.equal(proof.dataPlane,'code-only');a.equal(proof.sha,releaseSha);a.equal(proof.databaseCopies,0);
 a.equal(proof.store,native+'/code-seed-store');a.match(proof.identity.generationId,/^g-[a-f0-9]{64}$/);
 const generation=proof.store+'/data-generations/generations/'+proof.identity.generationId;
 for(const dir of [proof.store,proof.store+'/data-generations',proof.store+'/data-generations/generations',generation])rootPath(dir,true);
 rootPath(generation+'/manifest.json',false);a(fs.statSync(generation+'/manifest.json').size<=2*1024*1024);
 const checked=require('../server/dataGenerationStore.cjs').validateGenerationDirectory({generationDir:generation,expectedGenerationId:proof.identity.generationId,expectedManifestHash:proof.identity.manifestHash,expectedSourceCycleId:proof.identity.sourceCycleId});
 const entries=checked.manifest.files.filter(e=>e.path==='prediction-snapshots.json');a.equal(entries.length,1);const entry=entries[0];a(entry.bytes>768*1024**2&&entry.bytes<=MAX_BYTES);
 for(const dir of [artifactRoot,artifactRoot+'/public',artifactRoot+'/public/data']){const s=fs.lstatSync(dir);a(s.isDirectory()&&!s.isSymbolicLink());}
 rootPath(generation+'/prediction-snapshots.json',false);
 const source=digestFile(generation+'/prediction-snapshots.json',entry),target=digestFile(path.join(artifactRoot,relative),entry);a.deepEqual(source,target);
 return {ok:true,kind:'exact-protected-native-generation-copy',generationId:checked.generationId,relative,bytes:target.bytes,sha256:target.sha256,bufferBytes:65536};
}
module.exports={verify,digestFile,MAX_BYTES,RELATIVE};
