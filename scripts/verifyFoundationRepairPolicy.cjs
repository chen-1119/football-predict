'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {VERSION,FILES,hash,verify,objectFingerprint}=require('./foundationRepairPolicy.cjs');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const key=publicKey.export({type:'spki',format:'pem'}),now=Date.now(),h=hash('test'),b=Buffer.from('test').toString('base64');
const p={version:VERSION,site:'football-predict',channel:'production',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
  baseRuntimeSha256:h,frontendStateSha256:h,snapshot:{sha256:h,compactSha256:h,bytes:123,compactBytes:100,validBindings:198},
  publication:{sha256:h,bytes:120,validBindings:193},
  files:FILES.map(path=>({path,beforeSha256:path==='server/chunkedJsonFile.cjs'?null:h,sha256:h,base64:b})),
  controller:{sha256:h,base64:b},proof:{sha256:h,base64:b},policy:{sha256:h,base64:b},modelPromotion:false,storageMigration:false};
const signed=x=>{const bytes=Buffer.from(JSON.stringify(x));return[bytes,crypto.sign('sha256',bytes,privateKey),key,now];};
verify(...signed(p));let cases=1;
for(const mutate of [x=>x.site='other',x=>x.expiresAt=new Date(now-1).toISOString(),x=>x.createdAt=new Date(now+10000).toISOString(),
  x=>x.files[0].path='../scripts/syncData.cjs',x=>x.files.push(x.files[0]),x=>x.files.pop(),x=>x.files[0].sha256='0'.repeat(64),
  x=>x.files[0].beforeSha256=null,x=>x.policy.sha256='0'.repeat(64),x=>x.snapshot.validBindings=0,x=>x.publication.validBindings=0,
  x=>x.publication.validBindings=199,x=>x.publication.sha256='invalid',x=>x.modelPromotion=true,x=>x.storageMigration=true]) {
  const copy=structuredClone(p);mutate(copy);assert.throws(()=>verify(...signed(copy)));cases++;
}
const args=signed(p);args[1][0]^=1;assert.throws(()=>verify(...args));cases++;
const original={rows:[{id:1,frozen:{tip:'DRAW',sp:3.2}}],observations:[{last:true}],publicReferenceDecisions:[{id:2}],publicReferenceEvidence:[{id:2}],metadata:'retain'};
assert.equal(objectFingerprint(original),objectFingerprint(JSON.parse(JSON.stringify(original,null,2))));cases++;
for(const change of [x=>x.rows[0].frozen.tip='HOME',x=>x.observations=[],x=>x.publicReferenceEvidence=[],x=>delete x.metadata]){
  const copy=structuredClone(original);change(copy);assert.notEqual(objectFingerprint(original),objectFingerprint(copy));cases++;
}
console.log(JSON.stringify({ok:true,cases,productionWrites:0}));
