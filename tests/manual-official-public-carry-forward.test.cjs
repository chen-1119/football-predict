'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const m=require('../scripts/manualOfficialPublicCarryForward.cjs'),transitions=require('../scripts/releaseTransitionLease.cjs');
function fixture(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'football-manual-originals-')),live=path.join(directory,'live'),build=path.join(directory,'build'),custody=path.join(directory,'custody'),next=path.join(directory,'next');
 for(const root of [live,build])fs.mkdirSync(path.join(root,'public/data'),{recursive:true});
 const records=Array.from({length:29},(_,i)=>({sourceMatchId:String(i+1),kickoffTime:'2020-01-01T00:00:00.000Z',predictionMeta:{publicReferenceDecision:{contentHash:String(i+1).padStart(64,'0'),original:'retained-'+i}}}));
 const current=Buffer.from(JSON.stringify(records)),warehouse=Buffer.from('{"synthetic":"'+ 'x'.repeat(1200000)+'"}'),immutable=[{sourceMatchId:'900',kickoffTime:'2020-01-01T00:00:00.000Z'}];
 for(const [root,bytes]of [[live,current],[build,Buffer.from(JSON.stringify(immutable))]]){fs.writeFileSync(path.join(root,'public/data/matches-current.json'),bytes);fs.writeFileSync(path.join(root,'public/data/prediction-snapshots.json'),warehouse);}
 const pin=bytes=>({bytes:bytes.length,sha256:m.hash(bytes)}),pins={current:pin(current),warehouse:pin(warehouse),gap:m.gapFor(path.join(live,'public/data/matches-current.json'))},authorizationHash='a'.repeat(64);
 const value={directory,live,build,custody,next,records,current,warehouse,immutable,pins,authorizationHash};
 try{return run(value);}finally{a.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));a(path.basename(directory).startsWith('football-manual-originals-'));fs.rmSync(directory,{recursive:true,force:true});}
}
function capture(v){return m.captureOriginals(v);}
function verify(v,sourceCas=true){return m.verifyOriginals({...v,target:v.next,sourceCas});}
function entryRouting(state){
 const file=require.resolve('../scripts/manualOfficialPublicCarryForward.cjs'),source=fs.readFileSync(file,'utf8'),module={exports:{}},outputs=[];
 const sha='a'.repeat(64),statePath=path.join('/var/lib/football-release/native',sha,'state.json'),realRequire=require('node:module').createRequire(file);
 const fakeFs={...fs,readFileSync(name){a.equal(name,statePath,'no authorization or production file read in no-op route');return Buffer.from(JSON.stringify({sha,dataPlane:'code-only',...state}));}};
 for(const name of ['openSync','writeFileSync','mkdirSync','renameSync','unlinkSync'])fakeFs[name]=()=>{throw Error('no-op route must not mutate files');};
 const processFixture={platform:'linux',getuid:()=>0,argv:['node',file,'capture',sha,'123','/opt/football-predict.build-'+sha.slice(0,12)+'-123'],exitCode:0};
 const context={module,exports:module.exports,__dirname:path.dirname(file),Buffer,process:processFixture,console:{log:v=>outputs.push(JSON.parse(v)),error:v=>outputs.push(JSON.parse(v))},require(name){if(name==='node:fs')return fakeFs;if(name==='./baselineAuthorityReplayRepair.cjs')return{heldAncestorLock:owner=>{a.equal(owner,123);return{};}};return realRequire(name);}};
 context.require.main=module;require('node:vm').runInNewContext(source,context);return{outputs,exitCode:processFixture.exitCode};
}
test('actual entry leaves ordinary non903 releases on the no-manual route without reading authorization or mutating files',()=>{
 const result=entryRouting({oldSha:'b'.repeat(64)});a.equal(result.exitCode,0);a.deepEqual(result.outputs,[{ok:true,manualOriginalCarryForward:false}]);
});
test('actual entry still rejects a manual carry-forward request for a different baseline',()=>{
 const result=entryRouting({oldSha:'b'.repeat(64),manualOfficialPreparationAuthorizationHash:'c'.repeat(64)});a.equal(result.exitCode,1);a.equal(result.outputs[0].ok,false);
});
test('different immutable current never replaces original29 and ordinary lease still verifies the preserved current',()=>fixture(v=>{
 const original=m.hash(fs.readFileSync(path.join(v.live,'public/data/matches-current.json'))),lease=transitions.createTransitionLease(v.immutable,{refreshAt:'2026-10-20T16:00:00.000Z',verifierRuntimeMaxSeconds:300,preverifyRefreshBudgetSeconds:570,atomicSwapMarginSeconds:30});
 const proof=capture(v);a.equal(proof.privateStorageOnly,true);a.equal(proof.evidenceAdmissions,0);a.equal(proof.postgresWrites,0);
 a(fs.readFileSync(path.join(v.build,'public/data/matches-current.json')).equals(v.current));a(fs.readFileSync(path.join(v.build,'public/data/prediction-snapshots.json')).equals(v.warehouse));
 fs.cpSync(v.build,v.next,{recursive:true});a.equal(verify(v).originalRecords,29);a.equal(m.hash(fs.readFileSync(path.join(v.live,'public/data/matches-current.json'))),original);
 a.equal(transitions.verifyTransitionLease(JSON.parse(fs.readFileSync(path.join(v.next,'public/data/matches-current.json'))),lease,{verifiedAt:'2026-10-20T16:00:01.000Z',requiredMarginSeconds:300}).ok,true);
 a.deepEqual(JSON.parse(fs.readFileSync(path.join(v.custody,'matches-current.json'))),v.records);
}));
test('preserved bytes that change a future transition remain refused by the original lease',()=>fixture(v=>{
 v.records[0].kickoffTime='2030-01-01T00:00:00.000Z';v.current=Buffer.from(JSON.stringify(v.records));fs.writeFileSync(path.join(v.live,'public/data/matches-current.json'),v.current);v.pins.current={bytes:v.current.length,sha256:m.hash(v.current)};
 const lease=transitions.createTransitionLease(v.immutable,{refreshAt:'2026-10-20T16:00:00.000Z',verifierRuntimeMaxSeconds:300,preverifyRefreshBudgetSeconds:570,atomicSwapMarginSeconds:30});
 capture(v);a.throws(()=>transitions.verifyTransitionLease(JSON.parse(fs.readFileSync(path.join(v.build,'public/data/matches-current.json'))),lease,{verifiedAt:'2026-10-20T16:00:01.000Z',requiredMarginSeconds:300}),/transition data changed/);
}));
for(const [label,change]of [
 ['source current drift',v=>fs.appendFileSync(path.join(v.live,'public/data/matches-current.json'),'\n')],
 ['source warehouse drift',v=>fs.appendFileSync(path.join(v.live,'public/data/prediction-snapshots.json'),'\n')],
 ['NEXT copy corruption',v=>fs.appendFileSync(path.join(v.next,'public/data/matches-current.json'),' ')],
 ['missing NEXT warehouse',v=>fs.unlinkSync(path.join(v.next,'public/data/prediction-snapshots.json'))],
 ['source same-byte identity replacement',v=>{const file=path.join(v.live,'public/data/matches-current.json');fs.renameSync(file,file+'.retained');fs.copyFileSync(file+'.retained',file);}],
 ['changed custody receipt',v=>{const file=path.join(v.custody,'captured.json'),p=JSON.parse(fs.readFileSync(file));p.authorizationHash='b'.repeat(64);fs.writeFileSync(file,JSON.stringify(p));}],
])test('carry-forward refuses '+label,()=>fixture(v=>{capture(v);fs.cpSync(v.build,v.next,{recursive:true});change(v);a.throws(()=>verify(v));}));
test('capture refuses missing or multiply linked original before accepting custody',()=>fixture(v=>{
 fs.linkSync(path.join(v.live,'public/data/matches-current.json'),path.join(v.directory,'retained-hardlink'));a.throws(()=>capture(v));a.equal(fs.existsSync(path.join(v.custody,'captured.json')),false);
}));
test('capture refuses a linked public directory',()=>fixture(v=>{
 const data=path.join(v.live,'public/data'),retained=path.join(v.live,'public/retained-data');fs.renameSync(data,retained);fs.symlinkSync(retained,data,'junction');a.throws(()=>capture(v));
}));
test('capture refuses changed original record hashes and never overwrites existing custody',()=>fixture(v=>{
 const first=v.pins.gap[0].recordSha256;v.pins.gap[0].recordSha256='0'.repeat(64);a.throws(()=>capture(v),/record bytes differ/);a.equal(fs.existsSync(path.join(v.custody,'captured.json')),false);
 v.pins.gap[0].recordSha256=first;a.throws(()=>capture(v),/create-only/);a(fs.readFileSync(path.join(v.live,'public/data/matches-current.json')).equals(v.current));
}));
test('actual native shell preserves before assembly, rechecks before lease and confirms APP before service restart',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../deploy/light-server/release-native.sh'),'utf8');
 const captureAt=source.indexOf('manualOfficialPublicCarryForward.cjs" capture'),materialize=source.lastIndexOf('native_materialize_candidate',captureAt),assembly=source.indexOf('  assemble_final_tree',captureAt);
 a(materialize>source.indexOf('    stop_worker_for_release_window'));a(materialize<captureAt&&captureAt<assembly);
 const next=source.indexOf('manualOfficialPublicCarryForward.cjs" next'),before=source.indexOf('manualOfficialPublicCarryForward.cjs" before-swap'),swap=source.indexOf('  mv "$NEXT_DIR" "$APP_DIR"'),after=source.indexOf('manualOfficialPublicCarryForward.cjs" after-swap');
 a(assembly<next&&next<before&&before<source.indexOf('native_code_verify_cutover_lease "$CODE_CUTOVER_POST_SWAP_MARGIN_SECONDS"',before));a(before<swap&&swap<after&&after<source.indexOf('  restart_service_if_needed',after));
 const serving=source.indexOf('manualOfficialPublicCarryForward.cjs" serving');a(serving>source.indexOf(' native-post-swap 120 2 service',after)&&serving<source.indexOf('    [ "$((SECONDS - CODE_CUTOVER_STARTED_SECONDS))" -lt 900 ]',after));
 a(source.includes('--current "$code_root/public/data/matches-current.json" --lease "$CANDIDATE_TRANSITION_LEASE"'));a(source.includes('900 - $1'));
});
