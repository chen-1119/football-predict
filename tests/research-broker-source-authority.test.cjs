'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process');
const toolRoot=path.resolve(__dirname,'..'),authority=require('../scripts/researchBrokerSourceAuthority.cjs');
const archive=require('../scripts/releaseArchiveSourceInventory.cjs'),trees=require('../scripts/releaseChangeClassification.cjs');
const signing=require('../scripts/releaseSigning.cjs'),{packageInstall,installRoot}=require('../scripts/installResearchBroker.cjs');
const keypair=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),otherKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'broker-source-'));
after(()=>{assert.equal(path.dirname(fs.realpathSync(temporary)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert(path.basename(temporary).startsWith('broker-source-'));fs.rmSync(temporary,{recursive:true});});
function member(entry,bytes=Buffer.alloc(0)){
 const header=Buffer.alloc(512);assert(Buffer.byteLength(entry.path)<100);header.write(entry.path);
 const number=(value,start,length)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',start,length,'ascii');
 number(entry.mode,100,8);number(0,108,8);number(0,116,8);number(bytes.length,124,12);number(0,136,12);
 header.fill(32,148,156);header.write(entry.type||(entry.kind==='directory'?'5':'0'),156);header.write('ustar\0',257);header.write('00',263);
 header.write(header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
 return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512)]);
}
function put(file,bytes,mode){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,mode===undefined?{flag:'wx'}:{flag:'wx',mode});}
async function fixture({directoryMode,differentTool=false}={}){
 const directory=fs.mkdtempSync(path.join(temporary,'case-')),sourceRoot=path.join(directory,'source'),bundlePath=path.join(directory,'release.tgz');fs.mkdirSync(sourceRoot);
 const seen=new Set();
 function copy(relative){
  relative=path.normalize(relative);
  if(seen.has(relative))return;seen.add(relative);const file=path.join(toolRoot,relative),bytes=fs.readFileSync(file);put(path.join(sourceRoot,relative),differentTool&&relative===path.join('scripts','installResearchBroker.cjs')?Buffer.concat([bytes,Buffer.from('\n')]):bytes);
  for(const match of bytes.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g))copy(path.relative(toolRoot,require.resolve(path.resolve(path.dirname(file),match[1]))));
 }
 copy('scripts/installResearchBroker.cjs');copy('scripts/researchBrokerSourceAuthority.cjs');
 for(const name of ['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service'])put(path.join(sourceRoot,name),fs.readFileSync(path.join(toolRoot,name)));
 put(path.join(sourceRoot,'unrelated-source.txt'),'unchanged non-broker source\n');
 const inventory=trees.captureReleaseSourceInventory(sourceRoot),parts=inventory.entries.map(entry=>member(entry.kind==='directory'&&directoryMode!==undefined?{...entry,mode:directoryMode==='different'?entry.mode^0o111:directoryMode}:entry,entry.kind==='file'?fs.readFileSync(path.join(sourceRoot,entry.path)):undefined));
 put(bundlePath,zlib.gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)])));
 const evidence=await archive.captureReleaseArchiveSourceEvidence(bundlePath),now=Date.now();
 const publicKeyPath=path.join(directory,'existing-trust.pem'),privateKeyPath=path.join(directory,'fixture-private.pem');
 put(publicKeyPath,keypair.publicKey.export({type:'spki',format:'pem'}));put(privateKeyPath,keypair.privateKey.export({type:'pkcs8',format:'pem'}),0o600);
 const manifest={ok:true,manifestVersion:3,site:'football-predict',channel:'production',releaseSequence:1000,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
  sha256:evidence.archiveSha256,bytes:evidence.archiveBytes,entries:evidence.archiveEntryCount,archiveSourceEvidence:evidence,
  signature:{algorithm:'rsa-sha256-pkcs1-v1_5',keyId:sha(keypair.publicKey.export({type:'spki',format:'der'})),format:'detached-binary'}};
 const signManifest=()=>{const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(bundlePath+'.manifest.json',bytes);fs.writeFileSync(bundlePath+'.manifest.sig',crypto.sign('sha256',bytes,{key:keypair.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}));};signManifest();
 const boundaryPath=path.join(directory,'boundary.json'),dependenciesPath=path.join(directory,'dependencies.json'),platformPath=path.join(directory,'platform.json');
 put(boundaryPath,JSON.stringify({observedAt:new Date().toISOString(),releaseSha:manifest.sha256,units:'Id=football-predict.service\nMainPID=10\n\nId=football-sync-worker.service\nMainPID=11',brokerPrevious:{fixtureOnly:true}}));
 put(dependenciesPath,'{"version":"synthetic-only"}');put(platformPath,'{"version":"synthetic-only"}');
 return {directory,sourceRoot,bundlePath,publicKeyPath,privateKeyPath,manifest,signManifest,boundaryPath,dependenciesPath,platformPath,
  verify:()=>authority.verifySignedReleaseSource({bundlePath,sourceRoot,toolRoot}),options:{bundlePath,sourceRoot,boundaryPath,dependenciesPath,platformPath,refresh:true,sourceMode:'signed-release-source'}};
}
async function trusted(value,action){
 const names=['RELEASE_SIGNING_PUBLIC_KEY','RELEASE_SIGNING_PRIVATE_KEY'],old=names.map(name=>process.env[name]);
 process.env[names[0]]=value.publicKeyPath;process.env[names[1]]=value.privateKeyPath;
 try{return await action();}finally{names.forEach((name,index)=>{if(old[index]===undefined)delete process.env[name];else process.env[name]=old[index];});}
}
test('actual signed full archive and complete plain source verify without Git metadata in sourceRoot',async()=>{
 const value=await fixture();await trusted(value,async()=>{const result=await value.verify();assert.equal(result.proof.releaseSha256,value.manifest.sha256);assert.equal(result.proof.inventorySha256,value.manifest.archiveSourceEvidence.inventory.treeHash);assert(result.proof.tools.some(entry=>entry.path==='scripts/installResearchBroker.cjs'));assert(!fs.existsSync(path.join(value.sourceRoot,'.git')));});
});
for(const [label,change]of [
 ['changed non-broker file',value=>fs.appendFileSync(path.join(value.sourceRoot,'unrelated-source.txt'),'changed')],
 ['extra file',value=>put(path.join(value.sourceRoot,'extra.txt'),'extra')],
 ['missing file',value=>fs.unlinkSync(path.join(value.sourceRoot,'unrelated-source.txt'))],
 ['changed installer',value=>fs.appendFileSync(path.join(value.sourceRoot,'scripts/installResearchBroker.cjs'),'\n')],
 ['corrupt real archive',value=>fs.appendFileSync(value.bundlePath,Buffer.from('invalid'))],
 ['changed signed manifest',value=>fs.appendFileSync(value.bundlePath+'.manifest.json',' ')],
 ['wrong external trust',value=>fs.writeFileSync(value.publicKeyPath,otherKeys.publicKey.export({type:'spki',format:'pem'}))],
 ['expired signed manifest',value=>{value.manifest.expiresAt=new Date(Date.now()-1).toISOString();value.signManifest();}],
 ['self-reported inventory',value=>{value.manifest.archiveSourceEvidence.inventory.entries.find(entry=>entry.kind==='file').sha256='0'.repeat(64);value.signManifest();}],
 ['legacy missing inventory',value=>{delete value.manifest.archiveSourceEvidence;value.signManifest();}],
])test('signed source refuses '+label,async()=>{const value=await fixture();change(value);await trusted(value,()=>assert.rejects(value.verify()));});
test('payload-carried public key cannot become its own trust anchor',async()=>{
 const value=await fixture(),embedded=path.join(value.sourceRoot,'embedded.pem');put(embedded,fs.readFileSync(value.publicKeyPath));value.publicKeyPath=embedded;
 await trusted(value,()=>assert.rejects(value.verify(),/EXTERNAL_AUTHORITY_REQUIRED/));
});
test('hard-linked and directory-link source entries are refused',async()=>{
 const value=await fixture(),file=path.join(value.sourceRoot,'unrelated-source.txt'),alias=path.join(value.directory,'alias.txt');fs.linkSync(file,alias);
 await trusted(value,()=>assert.rejects(value.verify()));
 const linked=await fixture();fs.symlinkSync(value.sourceRoot,path.join(linked.sourceRoot,'linked'),process.platform==='win32'?'junction':'dir');await trusted(linked,()=>assert.rejects(linked.verify()));
});
test('unsigned tool root cannot prepare authority for a different signed installer',async()=>{
 const value=await fixture(),otherRoot=path.join(value.directory,'tool');fs.mkdirSync(path.join(otherRoot,'scripts'),{recursive:true});put(path.join(otherRoot,'scripts/installResearchBroker.cjs'),'different');
 await trusted(value,()=>assert.rejects(authority.verifySignedReleaseSource({bundlePath:value.bundlePath,sourceRoot:value.sourceRoot,toolRoot:otherRoot}),/TOOL_NOT_SIGNED_SOURCE/));
});
test('default packager remains synchronous and still refuses dirty Git',async()=>{
 const value=await fixture(),original=cp.execFileSync;cp.execFileSync=(program,args,options)=>program==='git'?args[0]==='rev-parse'?'1'.repeat(40)+'\n':' M scripts/example.cjs\n':original(program,args,options);
 const {sourceMode,sourceRoot,...options}=value.options;void sourceMode;void sourceRoot;
 try{assert.throws(()=>packageInstall(options),/DIRTY_SOURCE/);cp.execFileSync=(program,args,settings)=>program==='git'?args[0]==='rev-parse'?'1'.repeat(40)+'\n':'':original(program,args,settings);
  await trusted(value,()=>{const result=packageInstall(options);assert.equal(typeof result.then,'undefined');assert.equal(result.body.version,'research-broker-refresh-v1');});
 }finally{cp.execFileSync=original;}
});
test('explicit mode awaits both real verifications and retains the exact old wire/installer contract',async()=>{
 const value=await fixture(),original=archive.verifyArchiveSourceEvidence;let scans=0;
 archive.verifyArchiveSourceEvidence=async(...args)=>{scans++;return original(...args);};
 try{await trusted(value,async()=>{const pending=packageInstall(value.options);assert.equal(typeof pending.then,'function');const result=await pending;assert.equal(scans,2);assert.equal(result.body.installerSha256,sha(installRoot.toString()));assert.equal(result.body.manifestSha256,sha(fs.readFileSync(value.bundlePath+'.manifest.json')));
  assert.equal(Object.keys(result).sort().join(','),'body,payloads,signature');assert.equal(result.body.expiresAtMs-result.body.issuedAtMs,900000);assert.equal(result.body.releaseSha,value.manifest.sha256);
  assert(crypto.verify('RSA-SHA256',Buffer.concat([Buffer.from('football-research-broker-refresh-v1\0'),Buffer.from(JSON.stringify(result.body))]),{key:keypair.publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(result.signature,'base64')));
 });}finally{archive.verifyArchiveSourceEvidence=original;}
});
for(const [label,mutate]of [
 ['source file',value=>fs.appendFileSync(path.join(value.sourceRoot,'unrelated-source.txt'),'late')],
 ['source directory entry',value=>put(path.join(value.sourceRoot,'late.txt'),'late')],
 ['authority file identity',value=>fs.writeFileSync(value.publicKeyPath,fs.readFileSync(value.publicKeyPath))],
 ['boundary bytes',value=>fs.appendFileSync(value.boundaryPath,' ')],
 ['dependency bytes',value=>fs.appendFileSync(value.dependenciesPath,' ')],
])test('change before signing refuses '+label+' without signing an authority',async()=>{
 const value=await fixture(),original=archive.verifyArchiveSourceEvidence,sign=crypto.sign;let scans=0,signed=0;
 archive.verifyArchiveSourceEvidence=async(...args)=>{if(++scans===2)mutate(value);return original(...args);};crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(value.options)));assert.equal(signed,0);}finally{archive.verifyArchiveSourceEvidence=original;crypto.sign=sign;}
});
for(const [label,mutate]of [
 ['source bytes',value=>fs.appendFileSync(path.join(value.sourceRoot,'unrelated-source.txt'),'late')],
 ['source extra entry',value=>put(path.join(value.sourceRoot,'late.txt'),'late')],
 ['trust identity',value=>fs.writeFileSync(value.publicKeyPath,fs.readFileSync(value.publicKeyPath))],
 ['already re-read input',value=>fs.appendFileSync(value.boundaryPath,' ')],
])test('last synchronous gate refuses '+label+' changed during final input reads',async()=>{
 const value=await fixture(),original=authority.readStable,sign=crypto.sign;let boundaryReads=0,signed=0;
 authority.readStable=(file,maximum)=>{const result=original(file,maximum);if(file===value.boundaryPath&&++boundaryReads===2)mutate(value);return result;};
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(value.options)));assert.equal(boundaryReads,2);assert.equal(signed,0);}finally{authority.readStable=original;crypto.sign=sign;}
});

test('explicit signed mode does not silently fall back to Git and cannot accept a future boundary',async()=>{
 const value=await fixture(),boundary=JSON.parse(fs.readFileSync(value.boundaryPath));boundary.observedAt=new Date(Date.now()+3600000).toISOString();fs.writeFileSync(value.boundaryPath,JSON.stringify(boundary));
 await trusted(value,()=>assert.rejects(packageInstall(value.options),/FRESH_BOUNDARY/));
 assert.throws(()=>packageInstall({...value.options,sourceMode:'skip'}),/SOURCE_MODE/);
 assert.throws(()=>packageInstall({...value.options,sourceMode:'git-clean'}),/SOURCE_MODE_REQUIRED/);
});

function archiveOptions(value){const {sourceRoot,...options}=value.options;void sourceRoot;return {...options,sourceMode:'signed-release-archive'};}
for(const platform of ['linux','darwin','freebsd'])test('archive mode refuses unverified '+platform+' before extraction or signing',async()=>{
 const original=Object.getOwnPropertyDescriptor(process,'platform'),spawn=cp.spawnSync,sign=crypto.sign;let children=0,signed=0;
 cp.spawnSync=(...args)=>{children++;return spawn(...args);};crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{
  Object.defineProperty(process,'platform',{...original,value:platform});
  await assert.rejects(authority.readSignedReleaseArchive({bundlePath:'not-read.tgz'}),/ARCHIVE_READER_PLATFORM/);
  await assert.rejects(packageInstall({bundlePath:'not-read.tgz',sourceMode:'signed-release-archive'}),/ARCHIVE_READER_PLATFORM/);
  assert.equal(children,0);assert.equal(signed,0);
 }finally{Object.defineProperty(process,'platform',original);cp.spawnSync=spawn;crypto.sign=sign;}
});
if(process.platform==='win32'){
test('archive mode verifies original POSIX modes without accepting a mismatched materialized tree',async()=>{
 const value=await fixture({directoryMode:'different'});
 await trusted(value,async()=>{
  await assert.rejects(value.verify(),/COMPLETE_TREE_MISMATCH/);
  const verified=await authority.verifySignedReleaseArchive({bundlePath:value.bundlePath,toolRoot});
  assert.equal(verified.proof.version,'research-signed-release-archive-v1');
  assert.equal(verified.proof.inventorySha256,value.manifest.archiveSourceEvidence.inventorySha256);
  assert.deepEqual(verified.proof.payloads.map(item=>item.sha256),verified.payloads.map(sha));
  assert.equal(Object.hasOwn(verified.proof,'treeIdentities'),false);
 });
});
test('archive mode awaits two full inventories and six fixed stdout reads with the exact existing wire',async()=>{
 const value=await fixture(),capture=archive.verifyArchiveSourceEvidence,spawn=cp.spawnSync;let scans=0;const calls=[];
 archive.verifyArchiveSourceEvidence=async(...args)=>{scans++;return capture(...args);};
 cp.spawnSync=(program,args,options)=>{calls.push({program,args,options});return spawn(program,args,options);};
 try{await trusted(value,async()=>{
  const pending=packageInstall(archiveOptions(value));assert.equal(typeof pending.then,'function');const wire=await pending;
  assert.equal(scans,2);assert.equal(calls.length,6);
  const names=['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service'];
  for(let index=0;index<calls.length;index++){
   const call=calls[index];assert.equal(call.program,'C:/Windows/System32/tar.exe');
   assert.deepEqual(call.args,['-xOf',value.bundlePath,names[index%3]]);assert.equal(call.options.shell,false);
   assert.equal(call.options.maxBuffer,1024*1024);assert.equal(call.options.timeout,30000);
   assert.equal(call.options.encoding,null);assert(!Object.keys(call.options.env).some(key=>/^(TAR_|NODE_|LD_)/.test(key)));
  }
  assert.equal(wire.body.installerSha256,sha(installRoot.toString()));assert.equal(wire.body.expiresAtMs-wire.body.issuedAtMs,900000);
  assert.equal(Object.keys(wire).sort().join(','),'body,payloads,signature');
  assert(crypto.verify('RSA-SHA256',Buffer.concat([Buffer.from('football-research-broker-refresh-v1\0'),Buffer.from(JSON.stringify(wire.body))]),{key:keypair.publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(wire.signature,'base64')));
 });}finally{archive.verifyArchiveSourceEvidence=capture;cp.spawnSync=spawn;}
});
test('archive mode explicitly refuses a sourceRoot instead of falling back',async()=>{
 const value=await fixture();
 await assert.rejects(packageInstall({...value.options,sourceMode:'signed-release-archive'}),/ARCHIVE_SOURCE_ROOT_FORBIDDEN/);
 await assert.rejects(authority.verifySignedReleaseArchive({bundlePath:value.bundlePath,toolRoot,sourceRoot:value.sourceRoot}),/ARCHIVE_SOURCE_ROOT_FORBIDDEN/);
});
for(const [label,change]of [
 ['wrong stdout',result=>({...result,stdout:Buffer.from('wrong')})],
 ['excessive stdout',result=>({...result,stdout:Buffer.alloc(1024*1024+1)})],
 ['nonzero exit',result=>({...result,status:1})],
 ['timeout',result=>({...result,error:{code:'ETIMEDOUT'}})],
 ['output bound error',result=>({...result,error:{code:'ENOBUFS'}})],
 ['signal',result=>({...result,signal:'SIGTERM'})],
 ['stderr warning',result=>({...result,stderr:Buffer.from('warning')})],
])test('archive stdout admission refuses '+label+' without signing',async()=>{
 const value=await fixture(),spawn=cp.spawnSync,sign=crypto.sign;let signed=0;
 cp.spawnSync=(...args)=>change(spawn(...args));crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(archiveOptions(value))));assert.equal(signed,0);}finally{cp.spawnSync=spawn;crypto.sign=sign;}
});
test('a changed payload on the second complete replay cannot issue authority',async()=>{
 const value=await fixture(),spawn=cp.spawnSync,sign=crypto.sign;let reads=0,signed=0;
 cp.spawnSync=(...args)=>{const result=spawn(...args);return ++reads===4?{...result,stdout:Buffer.from('second replay changed')}:result;};
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(archiveOptions(value)),/ARCHIVE_PAYLOAD_MISMATCH/));assert.equal(reads,4);assert.equal(signed,0);}finally{cp.spawnSync=spawn;crypto.sign=sign;}
});
for(const [label,change]of [
 ['archive during stdout read',value=>fs.appendFileSync(value.bundlePath,'changed')],
 ['external key during stdout read',value=>fs.writeFileSync(value.publicKeyPath,fs.readFileSync(value.publicKeyPath))],
])test('archive authority refuses '+label,async()=>{
 const value=await fixture(),spawn=cp.spawnSync,sign=crypto.sign;let changed=false,signed=0;
 cp.spawnSync=(...args)=>{const result=spawn(...args);if(!changed){changed=true;change(value);}return result;};
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(archiveOptions(value))));assert.equal(signed,0);}finally{cp.spawnSync=spawn;crypto.sign=sign;}
});
for(const [label,change]of [
 ['bundle identity',value=>fs.writeFileSync(value.bundlePath,fs.readFileSync(value.bundlePath))],
 ['key identity',value=>fs.writeFileSync(value.publicKeyPath,fs.readFileSync(value.publicKeyPath))],
 ['boundary bytes',value=>fs.appendFileSync(value.boundaryPath,' ')],
])test('archive last synchronous gate refuses '+label,async()=>{
 const value=await fixture(),read=authority.readStable,sign=crypto.sign;let boundaryReads=0,signed=0;
 authority.readStable=(file,maximum)=>{const result=read(file,maximum);if(file===value.boundaryPath&&++boundaryReads===2)change(value);return result;};
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(archiveOptions(value))));assert.equal(signed,0);}finally{authority.readStable=read;crypto.sign=sign;}
});
test('new archive packager refuses a signed bundle containing a different executing tool',async()=>{
 const value=await fixture({differentTool:true}),sign=crypto.sign;let signed=0;
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,async()=>{
  const verified=await authority.readSignedReleaseArchive({bundlePath:value.bundlePath});assert.equal(verified.payloads.length,3);
  assert.equal(Object.hasOwn(verified.proof,'tools'),false);
  await assert.rejects(packageInstall(archiveOptions(value)),/TOOL_NOT_SIGNED_SOURCE/);
  assert.equal(signed,0);
 });}finally{crypto.sign=sign;}
});
for(const [label,offset]of [['future',3600000],['stale',-3600000]])test('archive mode refuses '+label+' boundary before signing',async()=>{
 const value=await fixture(),boundary=JSON.parse(fs.readFileSync(value.boundaryPath)),sign=crypto.sign;let signed=0;
 boundary.observedAt=new Date(Date.now()+offset).toISOString();fs.writeFileSync(value.boundaryPath,JSON.stringify(boundary));
 crypto.sign=(...args)=>{signed++;return sign(...args);};
 try{await trusted(value,()=>assert.rejects(packageInstall(archiveOptions(value)),/FRESH_BOUNDARY/));assert.equal(signed,0);}finally{crypto.sign=sign;}
});
for(const [label,change]of [
 ['wrong external key',value=>fs.writeFileSync(value.publicKeyPath,otherKeys.publicKey.export({type:'spki',format:'pem'}))],
 ['unsigned changed manifest',value=>fs.appendFileSync(value.bundlePath+'.manifest.json',' ')],
 ['expired signed manifest',value=>{value.manifest.expiresAt=new Date(Date.now()-1).toISOString();value.signManifest();}],
 ['corrupt non-payload archive bytes',value=>fs.appendFileSync(value.bundlePath,'changed')],
])test('archive full admission refuses '+label+' before any tar child',async()=>{
 const value=await fixture();change(value);const spawn=cp.spawnSync;let children=0;
 cp.spawnSync=(...args)=>{children++;return spawn(...args);};
 try{await trusted(value,()=>assert.rejects(authority.verifySignedReleaseArchive({bundlePath:value.bundlePath,toolRoot})));assert.equal(children,0);}finally{cp.spawnSync=spawn;}
});
for(const usePax of [false,true])test('full inventory refuses '+(usePax?'PAX alias':'duplicate member')+' before extraction',async()=>{
 const value=await fixture(),tar=zlib.gunzipSync(fs.readFileSync(value.bundlePath));let extra;
 if(usePax){
  const record='path=unrelated-source.txt\n';let length=record.length+2;while(String(length).length+1+record.length!==length)length=String(length).length+1+record.length;
  extra=Buffer.concat([member({path:'pax',kind:'file',mode:0o644,type:'x'},Buffer.from(length+' '+record)),member({path:'alias.txt',kind:'file',mode:0o644},Buffer.from('alias'))]);
 }else extra=member({path:'unrelated-source.txt',kind:'file',mode:0o644},Buffer.from('duplicate'));
 const changed=zlib.gzipSync(Buffer.concat([tar.subarray(0,-1024),extra,Buffer.alloc(1024)]));fs.writeFileSync(value.bundlePath,changed);
 value.manifest.sha256=sha(changed);value.manifest.bytes=changed.length;
 value.manifest.archiveSourceEvidence.archiveSha256=sha(changed);value.manifest.archiveSourceEvidence.archiveBytes=changed.length;value.signManifest();
 const spawn=cp.spawnSync;let children=0;cp.spawnSync=(...args)=>{children++;return spawn(...args);};
 try{await trusted(value,()=>assert.rejects(authority.verifySignedReleaseArchive({bundlePath:value.bundlePath,toolRoot}),/duplicate-or-aliased-tar-member/));assert.equal(children,0);}finally{cp.spawnSync=spawn;}
});
}
