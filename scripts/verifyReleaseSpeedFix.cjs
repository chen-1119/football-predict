"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { BURN, validateSequenceBranches } = require("./releaseSequencePreflight.cjs");
const { recordCheck, probeCurrentList, currentListBudget } = require("./releaseReadinessPolicy.cjs");
const { classifyModelWork } = require("./releaseModelWorkPolicy.cjs");
const { cacheIdentity } = require("./rootStaticResultCache.cjs");
const { hashValue, sealReceipt, openReceipt } = require("./staticVerificationReceipts.cjs");
const root = path.resolve(__dirname, ".."), checks = [];
const source = fs.readFileSync(path.join(root, "deploy/light-server/football-release"), "utf8").replace(/\r\n?/g,"\n");
const check = async (name, fn) => { await fn(); checks.push({ name, ok: true }); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-release-speed-test-"));
const put = (name, value) => { const file = path.join(temp,name); fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file,value); };
(async () => { try {
  const branches = validateSequenceBranches(source);
  await check("actual mutually exclusive release branches consume once on success and failure", () => {
    const bash = process.env.VERIFY_BASH_EXECUTABLE || (process.platform === "win32" ? "D:/app/Git/bin/bash.exe" : "/bin/bash");
    const fullBegin = branches.full.indexOf(BURN), fullEnd = branches.full.indexOf('release_status="$?"', fullBegin) + 'release_status="$?"'.length;
    const full = branches.full.slice(fullBegin,fullEnd);
    for (const kind of ["full","frontend-only"]) for (const status of [0,7]) {
      const script = `set -eu
readonly MANIFEST_KIND=${kind}
MANIFEST_SEQUENCE=99; RECOVERY_CURRENT=/nonexistent-football-fixture-recovery
TRUSTED_KEY_ID=fixture; NODE_BIN=node; FRONTEND_HELPER_DIR=/fixture
BUNDLE_SHA=fixture; work_dir=/fixture; STARTED_AT=fixture; UPLOAD_GROUP=fixture
SOURCE_BUNDLE=/fixture; SOURCE_SHA=/fixture; SOURCE_MANIFEST=/fixture; SOURCE_SIGNATURE=/fixture
TRUSTED_SOURCE_DIR=/fixture; PUBLIC_BASE_URL=https://fixture.invalid
EXPECTED_SITE=fixture; EXPECTED_CHANNEL=fixture; RELEASE_EXPORT_MODE=fixture; RELEASE_SCRIPT_PATH=/fixture
consume_release_sequence_before_execution(){ printf 'consume\\n'; }
preserve_signed_source_baseline(){ return 0; }
write_status(){ :; }
rm(){ :; }
env(){ printf 'execute\\n'; return ${status}; }
${branches.frontend}
${full}
exit "$release_status"
`;
      const result = spawnSync(bash,["--noprofile","--norc","-s"],{input:script,encoding:"utf8",windowsHide:true,timeout:5000,
        env:{ PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, LANG:"C.UTF-8" }});
      assert.equal(result.status,status,result.stderr);
      assert.equal(result.stdout.split("\n").filter(s=>s==="consume").length,1);
      assert.equal(result.stdout.split("\n").filter(s=>s==="execute").length,1);
      assert.ok(result.stdout.indexOf("consume") < result.stdout.indexOf("execute"));
    }
  });
  await check("added consumption and removed early exit cannot pass preflight", () => {
    assert.throws(()=>validateSequenceBranches(source.replace(BURN,BURN+"\n"+BURN)));
    assert.throws(()=>validateSequenceBranches(source.replace('  exit 0\nfi\n\nreadonly TRUSTED_SOURCE_DIR','  :\nfi\n\nreadonly TRUSTED_SOURCE_DIR')));
    assert.throws(()=>validateSequenceBranches(source.replace('    exit "$frontend_status"','    :')));
  });
  await check("failure terminates release checking, diagnostic mode still records a failure", () => {
    const rows=[]; let later=false;
    assert.throws(()=>{recordCheck(rows,"bad",false,{status:1});later=true;},e=>e.readinessReport.summary.failed[0]==="bad");
    assert.equal(later,false); const all=[]; recordCheck(all,"bad",false,{},true); recordCheck(all,"good",true,{},true);
    assert.equal(all.length,2); assert.equal(all.every(r=>r.ok),false);
  });
  for (const mode of ["valid","oversize","verify-failed","network-failed","revoke-failed"]) {
    await check(`early payload ${mode} always revokes its own temporary credential`,async()=>{
      const calls=[];
      const request=async(method,url,body)=>{
        calls.push([method,url,body]);
        if(url==="/api/admin/access-codes") {assert.equal(body.ttlSeconds,900);return {status:200,body:{id:"fixture-id",code:"fixture-secret"}};}
        if(url==="/api/access/verify") return {status:mode==="verify-failed"?401:200,body:{session:{token:"fixture-token"}}};
        if(url.endsWith("/revoke")) return {status:mode==="revoke-failed"?500:200,body:{ok:true,row:{status:"revoked"}}};
        if(mode==="network-failed") throw new Error("fixture-network-failure");
        return {status:200,bytes:mode==="oversize"?21000:19000,body:{rows:[{id:"synthetic"}]}};
      };
      if(mode==="valid") assert.equal((await probeCurrentList({request,adminToken:"fixture-admin"})).ok,true);
      else await assert.rejects(()=>probeCurrentList({request,adminToken:"fixture-admin"}));
      assert.equal(calls.filter(c=>c[1].endsWith("/revoke")).length,1);
    });
  }
  await check("empty, raw private and malformed list payloads fail without raising the budget",()=>{
    for(const response of [{status:200,bytes:0,body:{rows:[]}}, {status:200,bytes:10,body:{rows:[{gptPrediction:{relay:{private:true}}}]}},
      {status:200,bytes:NaN,body:{rows:[{}]}}, {status:401,bytes:10,body:{rows:[{}]}}]) assert.equal(currentListBudget(response).ok,false);
  });
  for(const side of ["live","candidate"]) {
    for(const dir of ["src","scripts","server"]) fs.mkdirSync(path.join(temp,side,dir),{recursive:true});
    for(const name of ["src/services/model.cjs","scripts/syncData.cjs","server/index.cjs","package.json","package-lock.json","deploy/light-server/candidate-revision-transition.json"])
      put(`${side}/${name}`,"{}");
  }
  for(const file of ["model-strategy.json","model-artifacts/evaluation.json","model-artifacts/candidate-prospective-registry.json"]) put(`store/${file}`,'{"version":"synthetic-only"}');
  const options={liveRoot:path.join(temp,"live"),sourceRoot:path.join(temp,"candidate"),storeDir:path.join(temp,"store"),runtime:"v22.22.1"};
  await check("unchanged complete model code preserves existing products; UI-only source need not refit",()=>{
    assert.equal(classifyModelWork(options).mode,"preserve");
    put("candidate/src/styles/shell.css",".synthetic {}\n");assert.equal(classifyModelWork(options).mode,"preserve");
    assert.equal(classifyModelWork(options).modelPromotionAuthorized,false);
  });
  await check("exact release-runtime tooling changes preserve models without rewriting artifacts",()=>{
    const artifacts=["model-strategy.json","model-artifacts/evaluation.json","model-artifacts/candidate-prospective-registry.json"];
    const before=artifacts.map(name=>fs.readFileSync(path.join(temp,"store",name),"utf8"));
    for(const file of ["scripts/frontendInstalledRuntime.cjs","scripts/verifyFrontendInstalledRuntime.cjs",
      "scripts/verifyFrontendRuntimeAlternatives.cjs","scripts/verifyReleaseVerifierContracts.cjs",
      "scripts/frontendReleaseInputs.cjs","scripts/prepareFrontendRelease.cjs","scripts/verifyFrontendReleaseInputs.cjs"]) {
      put(`live/${file}`,"previous-release-tool");put(`candidate/${file}`,"updated-release-tool");
      const result=classifyModelWork(options);
      assert.equal(result.mode,"preserve",file);assert.equal(result.freshDataChecksRequired,true);
      assert.equal(result.modelPromotionAuthorized,false);
    }
    assert.deepEqual(artifacts.map(name=>fs.readFileSync(path.join(temp,"store",name),"utf8")),before);
    const unknown="candidate/scripts/verifyFrontendRuntimeAlternatives-extra.cjs";
    put(unknown,"unreviewed source");assert.equal(classifyModelWork(options).mode,"recompute");
    fs.unlinkSync(path.join(temp,unknown));
  });
  await check("runtime and reusable preparation dependencies are enforced by both real archive membership gates",()=>{
    const required=["scripts/verifyFrontendRuntimeAlternatives.cjs","scripts/frontendReleaseInputs.cjs","scripts/prepareFrontendRelease.cjs","scripts/verifyFrontendReleaseInputs.cjs"], vm=require("node:vm");
    const entries=source=>{
      const match=/const required(?:Release)?Entries = (\[[\s\S]*?\n\]);/.exec(source);
      const prebuilt=/const prebuiltDistBundleEntry = ("[^"\n]+");/.exec(source);
      assert.ok(match&&prebuilt);
      return vm.runInNewContext(match[1], {prebuiltDistBundleEntry:JSON.parse(prebuilt[1]),
        HISTORICAL_TRAINING_RELEASE_ENTRY:require("./historicalTrainingReleaseArtifact.cjs").HISTORICAL_TRAINING_RELEASE_ENTRY}, {timeout:1000});
    };
    for(const entry of required) for(const file of ["scripts/createReleaseBundle.cjs","scripts/verifyReleaseBundleSafety.cjs"]) {
      const source=fs.readFileSync(path.join(root,file),"utf8").replace(/\r\n?/g,"\n");
      assert.equal(entries(source).filter(value=>value===entry).length,1);
      assert.equal(entries(source.replace(`  "${entry}",\n`,"")).includes(entry),false);
      assert.ok(fs.statSync(path.join(root,entry)).isFile());
    }
    assert.match(fs.readFileSync(path.join(root,"scripts/verifyFrontendInstalledRuntime.cjs"),"utf8"),
      /require\("\.\/verifyFrontendRuntimeAlternatives.cjs"\)/);
  });
  await check("model, unknown backend, dependency, added source and runtime changes require recomputation",()=>{
    for(const file of ["src/services/model.cjs","server/index.cjs","package-lock.json","package.json"]){
      put(`candidate/${file}`,"changed");assert.equal(classifyModelWork(options).mode,"recompute",file);put(`candidate/${file}`,"{}");}
    put("candidate/scripts/unknown.cjs","new");assert.equal(classifyModelWork(options).mode,"recompute");
    fs.unlinkSync(path.join(temp,"candidate/scripts/unknown.cjs"));
    assert.equal(classifyModelWork({...options,runtime:"v99.0.0"}).mode,"recompute");
    fs.unlinkSync(path.join(temp,"store/model-artifacts/evaluation.json"));assert.equal(classifyModelWork(options).mode,"recompute");
  });
  await check("cross-release receipt reuse still binds source runtime and original check clock",()=>{
    const now=Date.now(), key=Buffer.alloc(32,42), result={status:0,timedOut:false,body:{ok:true,checks:[{ok:true}]},stdout:'{"ok":true,"checks":[{"ok":true}]}',stderr:""};
    const identity={releaseSha:"a".repeat(64),inputs:{files:["synthetic"]},runtime:{node:"pinned"}};
    const next={...identity,releaseSha:"b".repeat(64)};
    assert.equal(hashValue(cacheIdentity(identity,now)),hashValue(cacheIdentity(next,now)));
    const sealed=sealReceipt({identity:cacheIdentity(identity,now),result,key,now,elapsedMs:42});
    const opened=openReceipt(sealed,{identity:cacheIdentity(next,now),key,now});
    assert.equal(opened.verificationReceipt.verifiedAt,now);assert.equal(opened.verificationReceipt.originalElapsedMs,42);
    for(const changed of [{...next,inputs:{files:["changed"]}},{...next,runtime:{node:"changed"}}])
      assert.equal(openReceipt(sealed,{identity:cacheIdentity(changed,now),key,now}),null);
    assert.equal(openReceipt(sealed,{identity:cacheIdentity(next,now+86400001),key,now:now+86400001}),null);
    assert.equal(openReceipt(sealed,{identity:cacheIdentity(next,now),key:Buffer.alloc(32,1),now}),null);
  });
  await check("both model branches preserve deadline and revision checks; unknown mode cannot skip work",()=>{
    const shell=fs.readFileSync(path.join(root,"deploy/light-server/release-from-bundle.sh"),"utf8");
    assert.match(shell,/case "\$model_work" in preserve\|recompute\) ;; \*\) return 1/);
    const start=shell.indexOf("run_candidate_model_artifact_catchup() {"),end=shell.indexOf("\n}\n",start),body=shell.slice(start,end);
    assert.ok(body.indexOf('if [ "$model_work" = "recompute" ]; then') < body.indexOf("run_build_step model-backtest"));
    assert.ok(body.indexOf("\n  fi\n") < body.indexOf("run_build_step candidate-deadline-capture"));
    assert.ok(body.indexOf("\n  fi\n") < body.indexOf("run_build_step candidate-revision-verification"));
    assert.match(shell,/step-end kind=build/);assert.match(shell,/step-end kind=refresh/);
  });
  console.log(JSON.stringify({ok:true,checks,productionWrites:0,fullReadinessRuns:0},null,2));
} finally {
  const real=fs.realpathSync(temp);assert.equal(real,path.resolve(temp));assert.ok(real.startsWith(path.resolve(os.tmpdir())+path.sep));
  assert.ok(path.basename(real).startsWith("football-release-speed-test-"));fs.rmSync(real,{recursive:true,force:true});
} })().catch(error=>{console.error(error);process.exitCode=1;});
