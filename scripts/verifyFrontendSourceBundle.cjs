"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm"), zlib = require("node:zlib");
const bundleTools = require("./createFrontendReleaseBundle.cjs"), signing = require("./releaseSigning.cjs");
const { captureReleaseArchiveSourceEvidence, verifyArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");
const { compareAuthorizedFrontendSources } = require("./frontendReleaseAuthorization.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), digest = value => hash(JSON.stringify(value));
const H = "a".repeat(64), clone = value => JSON.parse(JSON.stringify(value));
const checks = [], startedAt = Date.now(), temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "football-frontend-source-bundle-"));
fs.chmodSync(temp, 0o700); const rootIdentity = fs.lstatSync(temp).ino;
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
const privateKey = path.join(temp, "private.pem"), publicKey = path.join(temp, "public.pem");
fs.writeFileSync(privateKey, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
fs.writeFileSync(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o600 });
const keyId = signing.publicKeyId(keys.publicKey);
const check = async (name, fn) => { const begin = Date.now(); try { await fn(); checks.push({ name, ok: true, elapsedMs: Date.now() - begin }); } catch (e) { checks.push({ name, ok: false, error: e.stack, elapsedMs: Date.now() - begin }); } };
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { mode: 0o600 }); }
function saveManifest(f, manifest = f.manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); write(f.bundle + ".manifest.json", bytes);
  write(f.bundle + ".manifest.sig", signing.signManifestBytes(bytes, keys.privateKey));
}
async function fixture() {
  const directory = fs.mkdtempSync(path.join(temp, "case-")), workspace = path.join(directory, "workspace"), out = path.join(directory, "out");
  fs.mkdirSync(workspace); fs.mkdirSync(out);
  const data = new Map([
    ["package.json", Buffer.from('{"scripts":{"build":"NEVER RUN"},"private":true}')],
    ["package-lock.json", Buffer.from('{"lockfileVersion":3,"packages":{}}')],
    ["src/App.css", Buffer.from("body{color:red}\n")], ["src/App.tsx", Buffer.from("export default function App(){return null;}\n")],
    ["server/index.cjs", Buffer.from([0, 255, 10, 13, 127, 34])],
    ["dist/index.html", Buffer.from('<script src="/assets/old.js"></script>\n')], ["dist/assets/old.js", Buffer.from("old baseline artifact\n")],
    ["public/data/model-evaluation.json", Buffer.from('{"ok":true,"version":"rolling-backtest-v19"}')],
    [".release-model-assets/historical-training-index.json", Buffer.from('{"version":"historical-training-v1"}')],
  ]);
  const distFiles = [...data].filter(([p]) => p.startsWith("dist/")).map(([p, bytes]) => ({ path: p.slice(5), bytes: bytes.length, sha256: hash(bytes) })).sort((a,b) => a.path.localeCompare(b.path,"en"));
  const distBody = { version: "release-prebuilt-dist-v1", files: distFiles, fileCount: distFiles.length, totalBytes: distFiles.reduce((n,r)=>n+r.bytes,0) };
  const dist = { ...distBody, treeHash: digest(distBody) };
  data.set(".release-prebuilt/dist-manifest.json", Buffer.from(JSON.stringify(dist, null, 2) + "\n"));
  const directories = new Set(); for (const p of data.keys()) { let dir = path.posix.dirname(p); while (dir !== ".") { directories.add(dir); dir = path.posix.dirname(dir); } }
  const rows = [...directories].map(p => ({ path:p,kind:"directory",mode:p.startsWith(".release-")?0o700:0o755 }));
  for (const [p, bytes] of data) rows.push({ path:p,kind:"file",mode:p.startsWith(".release-")?0o600:p==="server/index.cjs"?0o755:0o644,bytes:bytes.length,sha256:hash(bytes) });
  rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0); const inventory=bundleTools.deriveInventory(rows);
  const bundle=path.join(directory,"baseline.tgz");
  await bundleTools.writeCandidateArchive(bundle,inventory,async function*(row){yield data.get(row.path);},Date.now()+30000);
  const archiveSourceEvidence=await captureReleaseArchiveSourceEvidence(bundle);
  assert.deepEqual(archiveSourceEvidence.inventory,inventory);
  const manifest={
    ok:true,manifestVersion:3,site:"fixture",channel:"test",releaseSequence:11,createdAt:"2020-01-01T00:00:00.000Z",expiresAt:"2020-01-03T00:00:00.000Z",
    policyVersion:"release-secret-policy-v2",path:bundle,sha256Path:bundle+".sha256",manifestPath:bundle+".manifest.json",signaturePath:bundle+".manifest.sig",
    bytes:archiveSourceEvidence.archiveBytes,sha256:archiveSourceEvidence.archiveSha256,entries:archiveSourceEvidence.archiveEntryCount,archiveSourceEvidence,
    excludes:["node_modules"],runtimeMutableSourceEntries:["public/data/gpt-predictions.json"],blockedEntries:[],sensitiveEntries:[],missingEntries:[],
    modelEvaluationArtifact:{ok:true,entry:"public/data/model-evaluation.json",sha256:hash(data.get("public/data/model-evaluation.json")),version:"rolling-backtest-v19"},
    historicalTrainingArtifact:{ok:true,entry:".release-model-assets/historical-training-index.json",sha256:hash(data.get(".release-model-assets/historical-training-index.json")),
      bytes:data.get(".release-model-assets/historical-training-index.json").length,sourceMatchesBundle:true},
    prebuiltDistArtifact:{ok:true,entry:".release-prebuilt/dist-manifest.json",version:dist.version,treeHash:dist.treeHash,fileCount:dist.fileCount,totalBytes:dist.totalBytes},
    releaseActions:[],releaseActionEntries:[],signature:{algorithm:signing.RELEASE_SIGNATURE_ALGORITHM,keyId,format:"detached-binary"},
  };
  const state={version:"frontend-release-state-v1",kind:"full",phase:"accepted",runtimeSha256:manifest.sha256,runtimeSequence:11,frontendSha256:manifest.sha256,frontendSequence:11,
    indexSha256:hash(data.get("dist/index.html")),distTreeHash:dist.treeHash,acceptanceSha256:H};
  const runtime={version:"frontend-runtime-binding-v1",runtimeSha256:manifest.sha256,runtimeSequence:11,inventorySha256:inventory.treeHash,
    runtime:{nodeSha256:H,nodeVersion:"v22.22.1",dependencyLockSha256:hash(data.get("package-lock.json")),buildDependencySha256:H,installedRuntimeSha256:H},
    policies:{authorizationSha256:H,runtimeBoundarySha256:H,sandboxSha256:H}};
  const statePath=path.join(directory,"state.json"),runtimePath=path.join(directory,"runtime.json"),output=path.join(out,"candidate.tgz"),sequence=path.join(directory,"sequence.json");
  for(const p of ["src/App.css","src/App.tsx"]){write(path.join(workspace,p),data.get(p));fs.chmodSync(path.join(workspace,p),0o644);}
  write(path.join(workspace,"server/index.cjs"),"unpackaged backend change");
  write(path.join(workspace,"src/App.css"),"body{color:blue}\n");fs.chmodSync(path.join(workspace,"src/App.css"),0o644);
  const f={directory,workspace,out,bundle,manifest,state,runtime,data,inventory,statePath,runtimePath,output,sequence};
  saveManifest(f);write(statePath,JSON.stringify(state)+"\n");write(runtimePath,JSON.stringify(runtime)+"\n");
  f.env={RELEASE_KIND:"frontend-only",RELEASE_SITE:"fixture",RELEASE_CHANNEL:"test",RELEASE_FRONTEND_BASELINE_BUNDLE:bundle,RELEASE_FRONTEND_STATE_PATH:statePath,
    RELEASE_FRONTEND_RUNTIME_PATH:runtimePath,RELEASE_SIGNING_PRIVATE_KEY:privateKey,RELEASE_SIGNING_PUBLIC_KEY:publicKey,RELEASE_SEQUENCE_STATE_PATH:sequence,RELEASE_BUNDLE_PATH:output,RELEASE_SEQUENCE:"20"};
  f.run=()=>bundleTools.createFrontendReleaseBundle({workspaceRoot:workspace,env:f.env});
  f.assertClean=()=>assert.ok(fs.readdirSync(out).every(name=>!name.startsWith(".frontend-source-bundle-")));
  return f;
}
async function reject(f, expression) { await assert.rejects(f.run,expression); assert.equal(fs.existsSync(f.sequence),false); f.assertClean(); }
async function main(){
  await check("actual signed source package preserves every non-UI byte/member/mode and expired baseline is not a fresh release",async()=>{
    const f=await fixture(),before=hash(fs.readFileSync(f.bundle)),result=await f.run();
    assert.equal(result.releaseSequence,20);assert.equal(result.releaseKind,"frontend-only");assert.deepEqual(result.frontendAuthorization.changedPaths,["src/App.css"]);
    assert.equal(result.frontendAuthorization.baseline.frontendStateSha256,hash(fs.readFileSync(f.statePath)));
    assert.equal(result.bundleConstruction.localBuildExecutions,0);assert.equal(result.bundleConstruction.networkRequests,0);assert.equal(result.bundleConstruction.otherWorkspaceChangesIncluded,false);
    assert.equal(result.bundleConstruction.deploymentAuthorized,false);assert.equal(result.archiveSourceEvidence.frontendBuildBinding,null);
    const verified=signing.verifyManifestSignature({manifestPath:f.output+".manifest.json",signaturePath:f.output+".manifest.sig",publicKeyPath:publicKey});
    await verifyArchiveSourceEvidence(f.output,verified.manifest);
    compareAuthorizedFrontendSources({manifest:verified.manifest,baselineInventory:f.inventory,candidateInventory:verified.manifest.archiveSourceEvidence.inventory});
    const next=new Map(verified.manifest.archiveSourceEvidence.inventory.entries.map(r=>[r.path,r]));
    for(const row of f.inventory.entries)if(row.path!=="src/App.css")assert.deepEqual(next.get(row.path),row);
    assert.deepEqual(verified.manifest.prebuiltDistArtifact,f.manifest.prebuiltDistArtifact);assert.equal(hash(fs.readFileSync(f.bundle)),before);
    assert.deepEqual(fs.readdirSync(f.out).sort(),["candidate.tgz","candidate.tgz.manifest.json","candidate.tgz.manifest.sig","candidate.tgz.sha256"].sort());f.assertClean();
  });
  await check("automatic sequence follows accepted frontend even when local fixture sequence is absent",async()=>{const f=await fixture();delete f.env.RELEASE_SEQUENCE;const result=await f.run();assert.equal(result.releaseSequence,12);});
  await check("actual PAX and GNU extended-name input payloads normalize without inventory drift",async()=>{
    for(const kind of ["pax","gnu"]){
      const f=await fixture(),tar=zlib.gunzipSync(fs.readFileSync(f.bundle));let offset=0;
      while(offset<tar.length){
        const h=tar.subarray(offset,offset+512),name=h.subarray(0,100).toString("utf8").replace(/\0.*$/s,"");
        if(name==="src/App.css")break;
        const size=parseInt(h.subarray(124,136).toString("ascii").replace(/\0.*$/s,""),8)||0;offset+=512+size+(512-size%512)%512;
      }
      assert.ok(offset<tar.length);
      const pax=(key,value)=>{let n=key.length+Buffer.byteLength(value)+4;while(true){const r=n+" "+key+"="+value+"\n";if(Buffer.byteLength(r)===n)return r;n=Buffer.byteLength(r);}};
      const metadata=kind==="pax"?Buffer.from(pax("path","src/App.css")+pax("size",String(f.data.get("src/App.css").length))):Buffer.from("src/App.css\0");
      const header=bundleTools.ustarHeader({path:"metadata",kind:"file",mode:0o644,bytes:metadata.length});
      header[156]=kind==="pax"?120:76;header.fill(32,148,156);header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,"0")+"\0 ",148,8,"ascii");
      const actualHeader=Buffer.from(tar.subarray(offset,offset+512));actualHeader.fill(0,0,100);actualHeader.write("src/placeholder.css",0,"ascii");
      actualHeader.fill(32,148,156);actualHeader.write(actualHeader.reduce((a,b)=>a+b,0).toString(8).padStart(6,"0")+"\0 ",148,8,"ascii");
      write(f.bundle,zlib.gzipSync(Buffer.concat([tar.subarray(0,offset),header,metadata,Buffer.alloc((512-metadata.length%512)%512),actualHeader,tar.subarray(offset+512)])));
      const evidence=await captureReleaseArchiveSourceEvidence(f.bundle);assert.deepEqual(evidence.inventory,f.inventory);
      f.manifest.archiveSourceEvidence=evidence;f.manifest.sha256=evidence.archiveSha256;f.manifest.bytes=evidence.archiveBytes;
      f.state.runtimeSha256=f.state.frontendSha256=evidence.archiveSha256;f.runtime.runtimeSha256=evidence.archiveSha256;
      saveManifest(f);write(f.statePath,JSON.stringify(f.state)+"\n");write(f.runtimePath,JSON.stringify(f.runtime)+"\n");
      const result=await f.run();assert.deepEqual(result.frontendAuthorization.changedPaths,["src/App.css"]);f.assertClean();
    }
  });
  await check("pending state cannot become a source baseline",async()=>{const f=await fixture();f.state.phase="pending";f.state.acceptanceSha256=null;write(f.statePath,JSON.stringify(f.state));await reject(f,/not-accepted/);});
  await check("runtime SHA sequence inventory lock and policy bindings are exact",async()=>{
    for(const mutate of [r=>r.runtimeSha256=H,r=>r.runtimeSequence=12,r=>r.inventorySha256=H,r=>r.runtime.dependencyLockSha256=H,r=>r.runtime.nodeVersion="v24.0.0",r=>r.policies.extra=H]){
      const f=await fixture();mutate(f.runtime);write(f.runtimePath,JSON.stringify(f.runtime));await reject(f,/runtime-/);
    }
  });
  await check("raw public state and nested runtime duplicate keys are rejected",async()=>{
    const f=await fixture();write(f.statePath,fs.readFileSync(f.statePath,"utf8").replace('"phase":"accepted"','"phase":"pending","phase":"accepted"'));await reject(f,/duplicate/);
    const g=await fixture();write(g.runtimePath,fs.readFileSync(g.runtimePath,"utf8").replace('"nodeVersion":"v22.22.1"','"nodeVersion":"v22.22.1","node\\u0056ersion":"v22.22.1"'));await reject(g,/duplicate/);
  });
  await check("legacy archive without signed complete inventory is ineligible",async()=>{const f=await fixture();delete f.manifest.archiveSourceEvidence;saveManifest(f);await reject(f,/full-baseline/);});
  await check("signature and actual compressed archive substitution are rejected before sequence reservation",async()=>{
    const f=await fixture();write(f.bundle+".manifest.sig",Buffer.alloc(384));await reject(f,/signature-invalid/);
    const g=await fixture();fs.appendFileSync(g.bundle,Buffer.from("tamper"));await reject(g);
  });
  await check("validly signed but fabricated complete inventory cannot substitute actual tar bytes",async()=>{
    const f=await fixture(),rows=clone(f.inventory.entries);rows.find(r=>r.path==="server/index.cjs").sha256=H;
    f.manifest.archiveSourceEvidence.inventory=bundleTools.deriveInventory(rows);f.manifest.archiveSourceEvidence.inventorySha256=f.manifest.archiveSourceEvidence.inventory.treeHash;
    f.runtime.inventorySha256=f.manifest.archiveSourceEvidence.inventorySha256;write(f.runtimePath,JSON.stringify(f.runtime));saveManifest(f);await reject(f,/archive-mismatch/);
  });
  await check("nonempty signed actions and requested TLS actions cannot use UI path",async()=>{
    const f=await fixture();f.manifest.releaseActions=["enable-ip-tls"];saveManifest(f);await reject(f,/actions-or-blockers/);
    const g=await fixture();g.env.RELEASE_TLS_AGREE_TOS="1";await reject(g,/tls-action-forbidden/);
  });
  await check("new and deleted allowlisted source paths are rejected",async()=>{
    const f=await fixture();write(path.join(f.workspace,"src/pages/BestTips.tsx"),"new");await reject(f,/new-or-deleted/);
    const g=await fixture();fs.unlinkSync(path.join(g.workspace,"src/App.tsx"));await reject(g,/new-or-deleted/);
  });
  await check("hardlinked UI inputs are rejected",async()=>{const f=await fixture();fs.linkSync(path.join(f.workspace,"src/App.css"),path.join(f.directory,"alias"));await reject(f,/nonplain/);});
  await check("no-change source package is not a release",async()=>{const f=await fixture();write(path.join(f.workspace,"src/App.css"),f.data.get("src/App.css"));await reject(f,/no-source-changes/);});
  await check("all four existing output artifacts are preserved without reserving a sequence",async()=>{
    for(const suffix of ["",".sha256",".manifest.json",".manifest.sig"]){const f=await fixture();write(f.output+suffix,"sentinel");await reject(f,/already-exists/);assert.equal(fs.readFileSync(f.output+suffix,"utf8"),"sentinel");}
  });
  await check("unknown kind site mismatch and stale explicit sequence fail closed",async()=>{
    for(const [key,value] of [["RELEASE_KIND","ui"],["RELEASE_SITE","other"],["RELEASE_SEQUENCE","11"]]){
      const f=await fixture();f.env[key]=value;await reject(f);
    }
    await assert.rejects(()=>bundleTools.createFrontendReleaseBundle({ok:true}),/unknown-builder-option/);
  });
  await check("sparse oversized UI file fails before allocating its body",async()=>{
    const f=await fixture(),file=path.join(f.workspace,"src/App.css"),fd=fs.openSync(file,"r+");fs.ftruncateSync(fd,17*1024**2);fs.closeSync(fd);await reject(f,/oversized/);
  });
  await check("inconsistent inherited model or prebuilt metadata is rejected",async()=>{
    const f=await fixture();f.manifest.modelEvaluationArtifact.sha256=H;saveManifest(f);await reject(f,/model-metadata/);
    const g=await fixture();g.manifest.prebuiltDistArtifact.fileCount=99;saveManifest(g);await reject(g,/prebuilt-metadata/);
  });
  await check("full state must match original baseline index and dist commitments",async()=>{const f=await fixture();f.state.indexSha256=H;write(f.statePath,JSON.stringify(f.state));await reject(f,/state-dist-mismatch/);});
  await check("actual writer rejects payload mismatch and unsupported USTAR paths",async()=>{
    const f=await fixture();await assert.rejects(bundleTools.writeCandidateArchive(path.join(f.directory,"bad.tgz"),f.inventory,async function*(){yield Buffer.from("wrong");},Date.now()+10000),/payload/);
    assert.throws(()=>bundleTools.ustarHeader({path:"x".repeat(101),mode:0o644,bytes:0,kind:"file"}),/ustar-capacity/);
    const header=bundleTools.ustarHeader({path:"目录/".repeat(15)+"file.txt",mode:0o755,bytes:0,kind:"file"});assert.equal(header.length,512);
  });
  await check("source drift during packing refuses signing and sequence reservation",async()=>{
    const f=await fixture(),open=fs.openSync;fs.openSync=function(file,...args){const result=open.call(fs,file,...args);if(String(file).endsWith("candidate.tgz")&&String(file).includes(".frontend-source-bundle-"))write(path.join(f.workspace,"src/App.css"),"changed during packing");return result;};
    try{await reject(f,/input-drift/);}finally{fs.openSync=open;}
  });
  await check("partial output failure removes only owned files and does not reuse reserved sequence",async()=>{
    const f=await fixture(),open=fs.openSync;fs.openSync=function(file,...args){if(file===f.output+".manifest.json"){const e=new Error("fixture EACCES");e.code="EACCES";throw e;}return open.call(fs,file,...args);};
    try{await assert.rejects(f.run,/fixture EACCES/);}finally{fs.openSync=open;}
    assert.equal(JSON.parse(fs.readFileSync(f.sequence)).highestReservedSequence,20);assert.deepEqual(fs.readdirSync(f.out),[]);f.assertClean();
  });
  await check("concurrent identical output attempts cannot overwrite or both sign",async()=>{
    const f=await fixture(),r=await Promise.allSettled([f.run(),f.run()]);assert.equal(r.filter(x=>x.status==="fulfilled").length,1);
    signing.verifyManifestSignature({manifestPath:f.output+".manifest.json",signaturePath:f.output+".manifest.sig",publicKeyPath:publicKey});f.assertClean();
  });
  await check("early entry dispatch occurs once before full preflight/build and preserves child failure",()=>{
    const source=fs.readFileSync(path.join(__dirname,"createReleaseBundle.cjs"),"utf8"),prefix=source.slice(0,source.indexOf('const fs = require("node:fs");'));
    assert.ok(prefix.includes("requestedReleaseKind"));assert.ok(!prefix.includes("reserveReleaseSequence")&&!prefix.includes("runLiveArchivePreflight"));
    for(const [kind,status,expected] of [["frontend-only",0,0],["frontend-only",7,7],["frontend-only",null,1]]){
      let calls=0,exit;const fake={env:{RELEASE_KIND:kind},execPath:process.execPath,stderr:{write(){}},exit(code){exit=code;throw new Error("fixture-exit");}};
      assert.throws(()=>vm.runInNewContext(prefix,{process:fake,__dirname,require(name){if(name==="node:path")return path;assert.equal(name,"node:child_process");return {spawnSync(bin,args,options){calls++;assert.equal(bin,process.execPath);assert.deepEqual([...args],[path.join(__dirname,"createFrontendReleaseBundle.cjs")]);assert.equal(options.stdio,"inherit");return {status};}};}}),/fixture-exit/);
      assert.equal(calls,1);assert.equal(exit,expected);
    }
    for(const kind of ["",null,"unknown"])assert.throws(()=>vm.runInNewContext(prefix,{process:{env:{RELEASE_KIND:kind}},require(){throw Error("must not load");}}),/RELEASE_KIND/);
    for(const kind of [undefined,"full"])vm.runInNewContext(prefix,{process:{env:{RELEASE_KIND:kind}},require(){throw Error("must not load");}});
  });
  if(process.platform!=="win32")await check("actual POSIX mode changes and symlink UI parents are rejected",async()=>{
    const f=await fixture();fs.chmodSync(path.join(f.workspace,"src/App.css"),0o755);await reject(f,/mode-change/);
    const g=await fixture(),original=path.join(g.workspace,"src"),moved=path.join(g.directory,"source-moved");fs.renameSync(original,moved);fs.symlinkSync(moved,original);await reject(g,/nonplain-directory/);
  });
}
main().catch(e=>checks.push({name:"suite",ok:false,error:e.stack})).finally(()=>{
  assert.equal(fs.lstatSync(temp).ino,rootIdentity);assert.equal(fs.realpathSync(temp),temp);fs.rmSync(temp,{recursive:true});
  const report={ok:checks.every(c=>c.ok),version:bundleTools.VERSION,checks,startedAt,finishedAt:Date.now(),fixture:temp,fixtureRemoved:!fs.existsSync(temp),
    realReleaseSignatures:0,realReleaseSequencesConsumed:0,localBuildExecutions:0,networkRequests:0,productionWrites:0};
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
});
