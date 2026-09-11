'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {VERSION,FILES,hash,verify}=require('./foundationRepairPolicy.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'outputs');
const inventories=fs.readdirSync(out).filter(x=>/^foundation-inventory-\d+\.json$/.test(x));assert.equal(inventories.length,1);
const observed=JSON.parse(JSON.parse(fs.readFileSync(path.join(out,inventories[0]),'utf8')).stdout);
const layerReports=fs.readdirSync(out).filter(x=>/^foundation-binding-layers-\d+\.json$/.test(x)).sort().reverse();
const layers=layerReports.map(n=>JSON.parse(fs.readFileSync(path.join(out,n),'utf8'))).filter(x=>x.exitCode===0).map(x=>JSON.parse(x.stdout))[0];
assert.ok(layers&&layers.activeMissingFromMutable===0&&layers.mutable.bindings===198,'both publication layers require read-only evidence');
assert.equal(observed.runtime,'8c28ca0f4a5b6094b633c4ac5418becee18b05c2d9937a583b3479405b5353b8');
// Reconstruct the reviewed commit delta from the captured original bytes, then
// compare the complete result. Signing cannot accidentally include unrelated edits.
const scratch=fs.mkdtempSync(path.join(out,'foundation-source-check-'));
const oldFiles=FILES.filter(n=>n!=='server/chunkedJsonFile.cjs');
for(const name of oldFiles){const record=observed.files.find(x=>x.path===name),target=path.join(scratch,name);
  const b=Buffer.from(record.base64,'base64');assert.equal(hash(b),record.sha256);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,b,{flag:'wx'});}
const patch=cp.execFileSync('git',['diff','baf275c2^','baf275c2','--',...oldFiles],{cwd:root,windowsHide:true});
cp.execFileSync('git',['apply','--directory='+path.relative(root,scratch).split(path.sep).join('/')],{cwd:root,input:patch,windowsHide:true});
for(const name of oldFiles)assert.equal(hash(fs.readFileSync(path.join(scratch,name))),hash(fs.readFileSync(path.join(out,'live-base',name))),
  'capsule contains changes outside the reviewed foundation delta: '+name);
assert.equal(fs.readFileSync(path.join(root,'server/chunkedJsonFile.cjs'),'utf8').replace(/\r\n/g,'\n'),
  cp.execFileSync('git',['show','baf275c2:server/chunkedJsonFile.cjs'],{cwd:root,windowsHide:true,encoding:'utf8'}));
if(process.argv.includes('--check-sources')){console.log(JSON.stringify({ok:true,files:FILES.length,sourceCommit:'baf275c2',patchSha256:hash(patch),productionWrites:0}));process.exit(0);}
const material=file=>{const b=fs.readFileSync(file);return{sha256:hash(b),base64:b.toString('base64')};};
const created=Date.now();
const p={version:VERSION,site:'football-predict',channel:'production',createdAt:new Date(created).toISOString(),expiresAt:new Date(created+4*3600000).toISOString(),
  sourceCommit:'baf275c2c48325a072dc0a4bc32ea10c5b723d88',baseRuntimeSha256:observed.runtime,
  frontendStateSha256:'7bb08321f5e95ae7bd2fd78fb00f8ace37a38d5903c6764e303581d7586d0c2d',
  publication:{sha256:layers.active.evidence.sha256,bytes:layers.active.evidence.bytes,validBindings:layers.active.bindings},
  snapshot:{bytes:536933381,sha256:'23c537461bc6d4728fb5cc53554dfaa8241ee19816a30de24e77eff71e5ba944',
    compactBytes:342911560,compactSha256:'ca379d99e3620815ddba3315cb61ea4cfb16bf7d26faf76b45624518100530f5',validBindings:198},
  files:FILES.map(file=>({path:file,beforeSha256:observed.files.find(x=>x.path===file)?.sha256||null,
    ...material(path.join(root,file==='server/chunkedJsonFile.cjs'?file:'outputs/live-base/'+file))})),
  controller:material(path.join(__dirname,'foundationRepairController.cjs')),proof:material(path.join(__dirname,'proveFoundationRepair.cjs')),
  policy:material(path.join(__dirname,'foundationRepairPolicy.cjs')),modelPromotion:false,storageMigration:false};
const bytes=Buffer.from(JSON.stringify(p)+'\n');
const privateKey=fs.readFileSync(path.join(root,'../football-release-signing-private.pem'));
const publicKey=fs.readFileSync(path.join(root,'../football-release-signing-public.pem'));
const signature=crypto.sign('sha256',bytes,privateKey);verify(bytes,signature,publicKey);
const id=hash(bytes),dir=path.join(out,'capsule-'+id);fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir,'capsule.json'),bytes,{flag:'wx'});fs.writeFileSync(path.join(dir,'capsule.sig'),signature,{flag:'wx'});
console.log(JSON.stringify({ok:true,directory:dir,capsuleSha256:id,bytes:bytes.length,files:p.files.map(({path,sha256,beforeSha256})=>({path,sha256,beforeSha256})),productionWrites:0}));
