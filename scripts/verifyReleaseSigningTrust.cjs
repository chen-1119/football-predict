"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const trust = require("./releaseSigningTrust.cjs"), baseline = require("./releaseSourceBaseline.cjs");
const archive = require("./releaseArchiveSourceInventory.cjs");
const hash = trust.hash;
async function verifyReleaseSigningTrust() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "football-signing-trust-")), checks = [];
  fs.chmodSync(root, 0o700);
  const old = crypto.generateKeyPairSync("rsa", { modulusLength:3072 }), next = crypto.generateKeyPairSync("rsa", { modulusLength:3072 });
  const pem = pair => Buffer.from(pair.publicKey.export({ type:"spki", format:"pem" }));
  const oldPem = pem(old), nextPem = pem(next), owner = process.getuid?.() ?? 0;
  let count = 0;
  function fixture(enrolled = true) {
    const fixtureRoot = path.join(root, String(++count)); fs.mkdirSync(fixtureRoot, { mode:0o700 });
    const options = { fixtureRoot, fixtureOwnerUid:owner }, at = name => path.join(fixtureRoot,name);
    function write(name, bytes) { const p=at(name);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,bytes,{flag:"wx",mode:0o600});return p; }
    write(trust.LEGACY,oldPem);write(trust.SEQUENCE,"903\n");
    const record = { version:trust.VERSION,enrollmentId:"trust-recovery-"+Date.now()+"-"+crypto.randomBytes(8).toString("hex"),enrolledAt:new Date().toISOString(),cutoverSequence:903,
      legacy:{keyId:trust.key(oldPem).keyId,sha256:hash(oldPem)},active:{keyId:trust.key(nextPem).keyId,sha256:hash(nextPem)} };
    if(enrolled) {
      const bytes=Buffer.from(JSON.stringify(record));write(trust.STORE+"/trust.json",bytes);write(trust.STORE+"/legacy-public.pem",oldPem);write(trust.STORE+"/active-public.pem",nextPem);
      write(trust.JOURNAL+"/"+record.enrollmentId+"/completed.json",JSON.stringify({version:trust.VERSION,enrollmentId:record.enrollmentId,trustSha256:hash(bytes),completedAt:new Date().toISOString(),cutoverSequence:903,legacySha256:hash(oldPem),activeSha256:hash(nextPem)}));
    }
    return {options,at,write,record};
  }
  const check = async(name,fn)=>{await fn();checks.push({name,ok:true});};
  try {
    await check("legacy installation remains accepted until a completed external enrollment exists",()=>{const f=fixture(false);assert.equal(trust.loadReleaseSigningTrust(f.options).version,"legacy-single-key");assert.equal(trust.selectReleaseSigningKey(null,f.options).keyId,trust.key(oldPem).keyId);});
    await check("real RSA signatures select old and new keys at the sequence boundary",()=>{const f=fixture();for(const [sequence,pair,keyId]of [[903,old,f.record.legacy.keyId],[904,next,f.record.active.keyId]]){const m={releaseSequence:sequence,signature:{keyId}},b=Buffer.from(JSON.stringify(m));assert(crypto.verify("sha256",b,trust.selectReleaseSigningKey(m,f.options).key,crypto.sign("sha256",b,pair.privateKey)));}assert.equal(trust.selectReleaseSigningKey(null,f.options).keyId,f.record.active.keyId);});
    await check("new key cannot rewrite historical authority and old key cannot sign a successor",()=>{const f=fixture();for(const [releaseSequence,keyId]of [[903,f.record.active.keyId],[904,f.record.legacy.keyId],[904,"0".repeat(64)]])assert.throws(()=>trust.selectReleaseSigningKey({releaseSequence,signature:{keyId}},f.options),/sequence interval/);});
    await check("partial enrollment never falls back to the legacy key",()=>{const f=fixture();fs.unlinkSync(f.at(trust.JOURNAL+"/"+f.record.enrollmentId+"/completed.json"));assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/ENOENT/);});
    await check("changed active public key is refused",()=>{const f=fixture();fs.writeFileSync(f.at(trust.STORE+"/active-public.pem"),oldPem);assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/key binding/);});
    await check("changed external legacy public key is refused",()=>{const f=fixture();fs.writeFileSync(f.at(trust.LEGACY),nextPem);assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/key binding/);});
    await check("counter rollback and ambiguous counters are refused without rewriting them",()=>{const f=fixture();for(const text of ["902\n","903junk","0","9007199254740992"]){fs.writeFileSync(f.at(trust.SEQUENCE),text);assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/sequence rollback/);assert.equal(fs.readFileSync(f.at(trust.SEQUENCE),"utf8"),text);}});
    await check("tampered completion cannot authorize a public key",()=>{const f=fixture(),p=f.at(trust.JOURNAL+"/"+f.record.enrollmentId+"/completed.json"),r=JSON.parse(fs.readFileSync(p));r.trustSha256="0".repeat(64);fs.writeFileSync(p,JSON.stringify(r));assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/enrollment completion/);});
    await check("extra store members and registry fields are refused",()=>{const f=fixture();fs.writeFileSync(f.at(trust.STORE+"/extra"),"x");assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/store members/);fs.unlinkSync(f.at(trust.STORE+"/extra"));fs.writeFileSync(f.at(trust.STORE+"/trust.json"),JSON.stringify({...f.record,extra:true}));assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/fields/);});
    await check("actual hardlinked public key is refused",()=>{const f=fixture();fs.linkSync(f.at(trust.STORE+"/active-public.pem"),f.at("alias"));assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/file permissions/);});
    if(process.platform!=="win32") {
      await check("POSIX writable parents and symbolic public key links are refused",()=>{const f=fixture(),d=f.at(trust.STORE);fs.chmodSync(d,0o777);assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/directory permissions/);fs.chmodSync(d,0o700);fs.renameSync(d+"/active-public.pem",f.at("moved-key"));fs.symlinkSync(f.at("moved-key"),d+"/active-public.pem");assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/file permissions/);});
      await check("directory fsync EIO refuses otherwise valid trust",()=>{const f=fixture(),original=fs.fsyncSync;try{fs.fsyncSync=()=>{throw Error("fixture EIO");};assert.throws(()=>trust.loadReleaseSigningTrust(f.options),/fixture EIO/);}finally{fs.fsyncSync=original;}});
    }
    await check("actual source baseline recorder preserves and re-verifies both signature generations",async()=>{
      const f=fixture(),work=f.at("work"),storeRoot=f.at("baselines");fs.mkdirSync(work,{mode:0o700});
      for(const [sequence,pair,keyId]of [[903,old,f.record.legacy.keyId],[904,next,f.record.active.keyId]]) {
        const source=path.join(work,"source-"+sequence);fs.mkdirSync(source,{mode:0o700});fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({name:"fixture",sequence}));
        const archivePath=path.join(work,sequence+".tgz"),tar=spawnSync("tar",["-czf",archivePath,"-C",source,"./package.json"],{encoding:"utf8",timeout:10000,windowsHide:true});assert.equal(tar.status,0,tar.stderr);fs.chmodSync(archivePath,0o600);
        const evidence=await archive.captureReleaseArchiveSourceEvidence(archivePath),manifest={ok:true,manifestVersion:3,policyVersion:"release-secret-policy-v2",site:"football-predict",channel:"production",releaseSequence:sequence,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),sha256:evidence.archiveSha256,bytes:evidence.archiveBytes,entries:evidence.archiveEntryCount,archiveSourceEvidence:evidence,sensitiveEntries:[],blockedEntries:[],missingEntries:[],signature:{algorithm:"rsa-sha256-pkcs1-v1_5",keyId,format:"detached-binary"}};
        const bytes=Buffer.from(JSON.stringify(manifest)),manifestPath=path.join(work,sequence+".json"),signaturePath=path.join(work,sequence+".sig");fs.writeFileSync(manifestPath,bytes,{mode:0o600});fs.writeFileSync(signaturePath,crypto.sign("sha256",bytes,pair.privateKey),{mode:0o600});
        const options={sha256:manifest.sha256,sequence,site:manifest.site,channel:manifest.channel,archivePath,manifestPath,signaturePath,publicKeyPath:f.at(trust.LEGACY),storeRoot,fixtureOwnerUid:owner,fixtureTrustBoundary:f.options.fixtureRoot,fixtureSigningTrustRoot:f.options.fixtureRoot};
        assert.equal((await baseline.preserveSourceBaseline(options)).sourceBaselineReady,true);assert.equal((await baseline.verifyRetained(options)).record.release.sequence,sequence);
        assert.deepEqual(fs.readFileSync(path.join(storeRoot,manifest.sha256,baseline.FILES.archive)),fs.readFileSync(archivePath));
      }
    });
    await check("root CLI cannot accept caller-controlled trust roots or commands",()=>{const r=spawnSync(process.execPath,[require.resolve("./releaseSigningTrust.cjs"),"active-path",root],{encoding:"utf8",windowsHide:true,timeout:10000});assert.notEqual(r.status,0);assert.match(r.stderr,/fixed root CLI/);});
    return {ok:true,checks,productionWrites:0,providerRequests:0,actualRsaAndArchive:true,posixFilesystemProof:process.platform!=="win32"};
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^football-signing-trust-/);
    const writable=p=>{const s=fs.lstatSync(p);if(s.isSymbolicLink())return;fs.chmodSync(p,s.isDirectory()?0o700:0o600);if(s.isDirectory())for(const n of fs.readdirSync(p))writable(path.join(p,n));};writable(root);fs.rmSync(root,{recursive:true});
  }
}
module.exports={verifyReleaseSigningTrust};
if(require.main===module)verifyReleaseSigningTrust().then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(e.stack);process.exitCode=1;});
