'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const helper=require('../scripts/nativeSnapshotCopyProof.cjs');
function temporary(action){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-copy-proof-'));try{return action(root);}finally{a.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));a(path.basename(root).startsWith('native-copy-proof-'));fs.rmSync(root,{recursive:true});}}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('streams the exact observed 819651928-byte file with bounded heap',()=>temporary(root=>{
 const file=path.join(root,'history.json'),bytes=819651928,fd=fs.openSync(file,'wx');fs.ftruncateSync(fd,bytes);fs.closeSync(fd);
 const digest=crypto.createHash('sha256'),zero=Buffer.alloc(65536);for(let n=0;n<bytes;n+=zero.length)digest.update(zero.subarray(0,Math.min(zero.length,bytes-n)));
 const expected={bytes,sha256:digest.digest('hex')};const child=require('node:child_process').spawnSync(process.execPath,['--max-old-space-size=32','-e',`const h=require(process.argv[1]);console.log(JSON.stringify(h.digestFile(process.argv[2],JSON.parse(process.argv[3]))))`,require.resolve('../scripts/nativeSnapshotCopyProof.cjs'),file,JSON.stringify(expected)],{encoding:'utf8',windowsHide:true,timeout:30000});a.equal(child.status,0,child.stderr);a.deepEqual(JSON.parse(child.stdout),expected);
}));
test('rejects changed candidate bytes',()=>temporary(root=>{const f=path.join(root,'a');fs.writeFileSync(f,'abd');a.throws(()=>helper.digestFile(f,{bytes:3,sha256:hash('abc')}),/exact generation/);}));
test('rejects wrong length and files above existing 2 GiB reader bound',()=>temporary(root=>{const f=path.join(root,'a');fs.writeFileSync(f,'abc');a.throws(()=>helper.digestFile(f,{bytes:4,sha256:hash('abc')}));a.throws(()=>helper.digestFile(f,{bytes:helper.MAX_BYTES+1,sha256:hash('abc')}),/reader size bound/);}));
test('rejects multiply-linked files',()=>temporary(root=>{const f=path.join(root,'a');fs.writeFileSync(f,'abc');fs.linkSync(f,path.join(root,'b'));a.throws(()=>helper.digestFile(f,{bytes:3,sha256:hash('abc')}),/single-link/);}));
test('rejects directories',()=>temporary(root=>{a.throws(()=>helper.digestFile(root,{bytes:3,sha256:hash('abc')}),/single-link/);}));
test('original 768/512 MiB limits remain; proof exception is only native code history and trusted seed',()=>{
 const shell=fs.readFileSync('deploy/light-server/release-from-bundle.sh','utf8');a.match(shell,/\? 768 \* 1024 \* 1024 : 512 \* 1024 \* 1024/);a(shell.includes('nativeCodeRelease !== "1" || relative !== "public/data/prediction-snapshots.json"'));a(shell.includes('require(snapshotProofHelper).verify({ artifactRoot: buildRoot, relative, seedProof, releaseSha })'));a(shell.includes('${NATIVE_STATE_DIR:-}/seed-accepted.json'));a(shell.includes('${TRUSTED_SOURCE_DIR:-}/scripts/nativeSnapshotCopyProof.cjs'));
 for(const f of ['scripts/createReleaseBundle.cjs','scripts/verifyReleaseBundleSafety.cjs'])a(fs.readFileSync(f,'utf8').includes('"scripts/nativeSnapshotCopyProof.cjs"'));
});
test('seed requires protected matching SHA/code-only generation and no database copies',()=>{
 const source=fs.readFileSync('scripts/nativeSnapshotCopyProof.cjs','utf8');for(const proof of ["a.equal(proof.dataPlane,'code-only')","a.equal(proof.sha,releaseSha)","a.equal(proof.databaseCopies,0)","expectedManifestHash:proof.identity.manifestHash","rootPath(seedProof,false)","a.equal(relative,RELATIVE)"])a(source.includes(proof));a.throws(()=>helper.verify({artifactRoot:'/tmp/untrusted',relative:'public/data/other.json',seedProof:'/tmp/fake',releaseSha:'a'.repeat(64)}));
});
test('root verifier consumes actual generation result shape and matches both source and candidate bytes',()=>temporary(root=>{
 const releaseSha='a'.repeat(64),gid='g-'+'b'.repeat(64),native='/var/lib/football-release/native/'+releaseSha,artifact='/opt/football-predict.build-'+releaseSha.slice(0,12)+'-1';
 const mapped=f=>path.join(root,f.replace(/^\//,''));const generation=native+'/code-seed-store/data-generations/generations/'+gid;
 for(const d of [generation,artifact+'/public/data'])fs.mkdirSync(mapped(d),{recursive:true});
 const bytes=819651928,zero=Buffer.alloc(65536),h=crypto.createHash('sha256');for(let n=0;n<bytes;n+=zero.length)h.update(zero.subarray(0,Math.min(zero.length,bytes-n)));const sha256=h.digest('hex');
 for(const f of [generation+'/prediction-snapshots.json',artifact+'/'+helper.RELATIVE]){const fd=fs.openSync(mapped(f),'wx');fs.ftruncateSync(fd,bytes);fs.closeSync(fd);}
 fs.writeFileSync(mapped(generation+'/manifest.json'),'{}');
 const proof={ok:true,seed:true,dataPlane:'code-only',sha:releaseSha,databaseCopies:0,store:native+'/code-seed-store',identity:{generationId:gid,manifestHash:'b'.repeat(64),sourceCycleId:'synthetic-cycle'}};
 fs.writeFileSync(mapped(native+'/seed-accepted.json'),JSON.stringify(proof));
 const facade={...fs,lstatSync:(f,opts)=>{const s=fs.lstatSync(mapped(f),opts);if(opts?.bigint)return s;return new Proxy(s,{get:(t,k)=>k==='uid'?0:k==='mode'?t.mode&~0o022:typeof t[k]==='function'?t[k].bind(t):t[k]});},realpathSync:f=>{a.equal(fs.realpathSync(mapped(f)),mapped(f));return f;},statSync:f=>fs.statSync(mapped(f)),readFileSync:(f,...args)=>fs.readFileSync(mapped(f),...args),openSync:(f,...args)=>fs.openSync(mapped(f),...args)};
 const module={exports:{}},nativeRequire=require('node:module').createRequire(require.resolve('../scripts/nativeSnapshotCopyProof.cjs'));
 require('node:vm').runInNewContext(fs.readFileSync('scripts/nativeSnapshotCopyProof.cjs','utf8'),{module,exports:module.exports,Buffer,process:{platform:'linux',getuid:()=>0},require:id=>id==='node:fs'?facade:id==='../server/dataGenerationStore.cjs'?{validateGenerationDirectory:o=>{a.equal(o.expectedGenerationId,gid);a.equal(o.expectedManifestHash,proof.identity.manifestHash);a.equal(o.expectedSourceCycleId,'synthetic-cycle');return {generationId:gid,manifest:{files:[{path:'prediction-snapshots.json',bytes,sha256}]}};}}:nativeRequire(id)});
 const r=module.exports.verify({artifactRoot:artifact,relative:helper.RELATIVE,seedProof:native+'/seed-accepted.json',releaseSha});a.equal(r.ok,true);a.equal(r.bytes,bytes);
 proof.sha='c'.repeat(64);fs.writeFileSync(mapped(native+'/seed-accepted.json'),JSON.stringify(proof));a.throws(()=>module.exports.verify({artifactRoot:artifact,relative:helper.RELATIVE,seedProof:native+'/seed-accepted.json',releaseSha}));
}));
