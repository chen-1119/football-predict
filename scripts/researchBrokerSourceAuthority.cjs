'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const signing=require('./releaseSigning.cjs');
const archive=require('./releaseArchiveSourceInventory.cjs');
const trees=require('./releaseChangeClassification.cjs');
const cp=require('node:child_process');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error('RESEARCH_SOURCE_'+code);};
const stamp=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function plainParents(file){
 for(let directory=path.dirname(file);;directory=path.dirname(directory)){
  const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('DIRECTORY');
  if(directory===path.dirname(directory))break;
 }
}
function readStable(file,maximum){
 plainParents(file);const before=fs.lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>maximum)fail('FILE');
 const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  if(stamp(fs.fstatSync(descriptor))!==stamp(before))fail('FILE_CHANGED');
  const bytes=fs.readFileSync(descriptor);
  if(bytes.length!==before.size||stamp(fs.fstatSync(descriptor))!==stamp(before)||stamp(fs.lstatSync(file))!==stamp(before))fail('FILE_CHANGED');
  return {bytes,identity:stamp(before),sha256:sha(bytes)};
 }finally{fs.closeSync(descriptor);}
}
function inside(root,file){const relative=path.relative(root,file);return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);}
function identities(root,entries){
 return ['',...entries.map(entry=>entry.path)].map(relative=>{
  const file=path.join(root,relative),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))fail('TREE_IDENTITY');
  return [relative,stamp(stat)];
 });
}
function verifyToolClosure(toolRoot,inventory){
 const entries=new Map(inventory.entries.map(entry=>[entry.path,entry])),seen=new Set(),result=[];
 function visit(file){
  if(!inside(toolRoot,file)||file===toolRoot||seen.size>128)fail('TOOL_PATH');
  if(seen.has(file))return;seen.add(file);
  const relative=path.relative(toolRoot,file).split(path.sep).join('/'),entry=entries.get(relative),value=readStable(file,8*1024*1024);
  if(entry?.kind!=='file'||entry.bytes!==value.bytes.length||entry.sha256!==value.sha256)fail('TOOL_NOT_SIGNED_SOURCE');
  result.push({path:relative,sha256:value.sha256,identity:value.identity});
  for(const match of value.bytes.toString('utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g))visit(require.resolve(path.resolve(path.dirname(file),match[1])));
 }
 visit(path.join(toolRoot,'scripts/installResearchBroker.cjs'));
 visit(path.join(toolRoot,'scripts/researchBrokerSourceAuthority.cjs'));
 return result.sort((left,right)=>left.path.localeCompare(right.path));
}
async function verifySignedReleaseSource({bundlePath,sourceRoot,toolRoot}){
 if(typeof sourceRoot!=='string'||!path.isAbsolute(sourceRoot)||typeof toolRoot!=='string'||!path.isAbsolute(toolRoot))fail('ABSOLUTE_ROOT');
 sourceRoot=path.resolve(sourceRoot);toolRoot=path.resolve(toolRoot);bundlePath=path.resolve(bundlePath);
 plainParents(path.join(sourceRoot,'entry'));plainParents(bundlePath);
 const publicKeyPath=path.resolve(signing.resolvePublicKeyPath());
 if(inside(sourceRoot,publicKeyPath)||inside(sourceRoot,bundlePath))fail('EXTERNAL_AUTHORITY_REQUIRED');
 const manifestPath=bundlePath+'.manifest.json',signaturePath=bundlePath+'.manifest.sig';
 const manifest=readStable(manifestPath,1024*1024),signature=readStable(signaturePath,16384),key=readStable(publicKeyPath,16384);
 const authenticated=signing.verifyManifestSignature({manifestPath,signaturePath,publicKeyPath});
 if(!authenticated.manifestBytes.equals(manifest.bytes)||authenticated.manifest.ok!==true
  ||(authenticated.manifest.releaseKind||'full')!=='full'||!authenticated.manifest.archiveSourceEvidence)fail('SIGNED_FULL_RELEASE_REQUIRED');
 const bundleIdentity=stamp(fs.lstatSync(bundlePath));
 await archive.verifyArchiveSourceEvidence(bundlePath,authenticated.manifest);
 if(stamp(fs.lstatSync(bundlePath))!==bundleIdentity)fail('ARCHIVE_CHANGED');
 const expected=authenticated.manifest.archiveSourceEvidence.inventory;
 const before=identities(sourceRoot,expected.entries),actual=trees.captureReleaseSourceInventory(sourceRoot),after=identities(sourceRoot,expected.entries);
 if(JSON.stringify(actual)!==JSON.stringify(expected))fail('COMPLETE_TREE_MISMATCH');
 if(JSON.stringify(before)!==JSON.stringify(after))fail('TREE_CHANGED');
 const tools=verifyToolClosure(toolRoot,expected);
 const names=['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service'];
 const payloads=names.map(name=>{
  const value=readStable(path.join(sourceRoot,name),1024*1024),entry=expected.entries.find(item=>item.path===name);
  if(entry?.kind!=='file'||value.bytes.length!==entry.bytes||value.sha256!==entry.sha256)fail('PAYLOAD_CHANGED');
  return value.bytes;
 });
 for(const [file,original,maximum]of [[manifestPath,manifest,1024*1024],[signaturePath,signature,16384],[publicKeyPath,key,16384]]){
  const latest=readStable(file,maximum);if(latest.identity!==original.identity||!latest.bytes.equals(original.bytes))fail('AUTHORITY_CHANGED');
 }
 if(JSON.stringify(after)!==JSON.stringify(identities(sourceRoot,expected.entries)))fail('TREE_CHANGED');
 const proof={version:'research-signed-release-source-v1',releaseSha256:authenticated.manifest.sha256,manifestSha256:manifest.sha256,
  signatureSha256:signature.sha256,trustedKeySha256:key.sha256,trustedKeyId:authenticated.keyId,inventorySha256:actual.treeHash,
  publicKeyPath,bundleIdentity,manifestIdentity:manifest.identity,signatureIdentity:signature.identity,keyIdentity:key.identity,treeIdentities:after,tools};
 return {proof,manifest:authenticated.manifest,manifestBytes:manifest.bytes,signatureBytes:signature.bytes,payloads};
}
function assertSignedReleaseSourceStable({bundlePath,sourceRoot,toolRoot},verified,inputs=[]){
 const {proof,manifest}=verified,publicKeyPath=path.resolve(signing.resolvePublicKeyPath());
 if(publicKeyPath!==proof.publicKeyPath)fail('AUTHORITY_CHANGED');
 plainParents(path.join(sourceRoot,'entry'));
 if(JSON.stringify(identities(sourceRoot,manifest.archiveSourceEvidence.inventory.entries))!==JSON.stringify(proof.treeIdentities))fail('TREE_CHANGED');
 const files=[[bundlePath,proof.bundleIdentity],[bundlePath+'.manifest.json',proof.manifestIdentity],
  [bundlePath+'.manifest.sig',proof.signatureIdentity],[publicKeyPath,proof.keyIdentity],
  ...proof.tools.map(tool=>[path.join(toolRoot,tool.path),tool.identity]),...inputs.map(input=>[input.file,input.identity])];
 for(const [file,identity]of files){
  plainParents(file);const current=fs.lstatSync(file);
  if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||stamp(current)!==identity)fail('FINAL_IDENTITY_CHANGED');
 }
}
async function readSignedReleaseArchive({bundlePath}){
 if(process.platform!=='win32')fail('ARCHIVE_READER_PLATFORM');
 bundlePath=path.resolve(bundlePath);plainParents(bundlePath);
 const publicKeyPath=path.resolve(signing.resolvePublicKeyPath()),manifestPath=bundlePath+'.manifest.json',signaturePath=bundlePath+'.manifest.sig';
 if([bundlePath,manifestPath,signaturePath].includes(publicKeyPath))fail('EXTERNAL_AUTHORITY_REQUIRED');
 const manifest=readStable(manifestPath,1024*1024),signature=readStable(signaturePath,16384),key=readStable(publicKeyPath,16384);
 const authenticated=signing.verifyManifestSignature({manifestPath,signaturePath,publicKeyPath});
 if(!authenticated.manifestBytes.equals(manifest.bytes)||authenticated.manifest.ok!==true
  ||(authenticated.manifest.releaseKind||'full')!=='full'||!authenticated.manifest.archiveSourceEvidence)fail('SIGNED_FULL_RELEASE_REQUIRED');
 const bundleIdentity=stamp(fs.lstatSync(bundlePath));
 await archive.verifyArchiveSourceEvidence(bundlePath,authenticated.manifest);
 if(stamp(fs.lstatSync(bundlePath))!==bundleIdentity)fail('ARCHIVE_CHANGED');
 const expected=authenticated.manifest.archiveSourceEvidence.inventory;
 const program='C:/Windows/System32/tar.exe';
 const environment={SystemRoot:'C:/Windows',WINDIR:'C:/Windows',PATH:'C:/Windows/System32'};
 const names=['scripts/researchSocketServer.py','scripts/researchSocketPeer.py','deploy/light-server/football-research-broker.service'];
 const payloads=names.map(name=>{
  if(stamp(fs.lstatSync(bundlePath))!==bundleIdentity)fail('ARCHIVE_CHANGED');
  const entry=expected.entries.find(item=>item.path===name);
  if(entry?.kind!=='file'||entry.bytes<1||entry.bytes>1024*1024)fail('PAYLOAD_BOUND');
  const result=cp.spawnSync(program,['-xOf',bundlePath,name],{encoding:null,shell:false,windowsHide:true,env:environment,timeout:30000,maxBuffer:1024*1024});
  if(result.error||result.signal||result.status!==0||!Buffer.isBuffer(result.stdout)||result.stderr?.length)fail('ARCHIVE_PAYLOAD_READ');
  if(result.stdout.length!==entry.bytes||sha(result.stdout)!==entry.sha256)fail('ARCHIVE_PAYLOAD_MISMATCH');
  if(stamp(fs.lstatSync(bundlePath))!==bundleIdentity)fail('ARCHIVE_CHANGED');
  return result.stdout;
 });
 for(const [file,original,maximum]of [[manifestPath,manifest,1024*1024],[signaturePath,signature,16384],[publicKeyPath,key,16384]]){
  const latest=readStable(file,maximum);if(latest.identity!==original.identity||!latest.bytes.equals(original.bytes))fail('AUTHORITY_CHANGED');
 }
 const proof={version:'research-signed-release-archive-v1',releaseSha256:authenticated.manifest.sha256,manifestSha256:manifest.sha256,
  signatureSha256:signature.sha256,trustedKeySha256:key.sha256,trustedKeyId:authenticated.keyId,inventorySha256:expected.treeHash,
  publicKeyPath,bundleIdentity,manifestIdentity:manifest.identity,signatureIdentity:signature.identity,keyIdentity:key.identity,
  payloads:names.map((name,index)=>({path:name,bytes:payloads[index].length,sha256:sha(payloads[index])}))};
 return {proof,manifest:authenticated.manifest,manifestBytes:manifest.bytes,signatureBytes:signature.bytes,payloads};
}
async function verifySignedReleaseArchive({bundlePath,toolRoot,sourceRoot}){
 if(sourceRoot!==undefined)fail('ARCHIVE_SOURCE_ROOT_FORBIDDEN');
 if(typeof toolRoot!=='string'||!path.isAbsolute(toolRoot))fail('ABSOLUTE_ROOT');
 const verified=await readSignedReleaseArchive({bundlePath});
 const tools=verifyToolClosure(path.resolve(toolRoot),verified.manifest.archiveSourceEvidence.inventory);
 return {...verified,proof:{...verified.proof,tools}};
}
function assertSignedReleaseArchiveStable({bundlePath,toolRoot},verified,inputs=[]){
 const {proof}=verified,publicKeyPath=path.resolve(signing.resolvePublicKeyPath());
 if(proof.version!=='research-signed-release-archive-v1'||publicKeyPath!==proof.publicKeyPath)fail('AUTHORITY_CHANGED');
 const files=[[bundlePath,proof.bundleIdentity],[bundlePath+'.manifest.json',proof.manifestIdentity],
  [bundlePath+'.manifest.sig',proof.signatureIdentity],[publicKeyPath,proof.keyIdentity],
  ...proof.tools.map(tool=>[path.join(toolRoot,tool.path),tool.identity]),...inputs.map(input=>[input.file,input.identity])];
 for(const [file,identity]of files){
  plainParents(file);const current=fs.lstatSync(file);
  if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||stamp(current)!==identity)fail('FINAL_IDENTITY_CHANGED');
 }
}
module.exports={readStable,verifySignedReleaseSource,assertSignedReleaseSourceStable,readSignedReleaseArchive,verifySignedReleaseArchive,assertSignedReleaseArchiveStable};
