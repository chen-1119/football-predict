'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createCollectorKeyPair, buildCollectorCommitment, signCollectorCommitment, sha256CollectorJson } = require('../src/services/collectorAttestation.cjs');
const { expectedCollectorCommitment, summarizeTrustedMarketCollectorEvidence } = require('../server/relayCollectorEvidence.cjs');
const { SPORTTERY_CURRENT_URL, SPORTTERY_CALCULATOR_URL } = require('../scripts/sportteryEndpointContract.cjs');
const { auditOfficialClosedSchedule, readOfficialClosedScheduleEvidence, captureOfficialClosedSchedule, auditPublishedOfficialClosedSchedule } = require('../scripts/officialClosedScheduleEvidence.cjs');
const pair = createCollectorKeyPair({keyId:'synthetic-closure',independenceDomain:'synthetic-runtime-1'});
const other = createCollectorKeyPair({keyId:'synthetic-closure-2',independenceDomain:'synthetic-runtime-2'});
const registry = {...pair.registry,keys:[...pair.registry.keys,...other.registry.keys]};
const capturedAt='2026-10-03T00:00:00.000Z', asOf='2026-10-03T00:10:00.000Z';
const copy=value=>JSON.parse(JSON.stringify(value));
function resign(entry, signer=pair) {
  entry.canonicalPayloadSha256=sha256CollectorJson(entry.payload);
  entry.collectorAttestation=signCollectorCommitment(buildCollectorCommitment({...expectedCollectorCommitment(entry),payload:entry.payload}),signer);
  return entry;
}
function fixture() {
  const endpoints=[['current',SPORTTERY_CURRENT_URL,{totalCount:0,lastUpdateTime:'2026-10-03 08:00:00'}],
    ['calculator',SPORTTERY_CALCULATOR_URL,{vtoolsConfig:{offLineSaleStatus:1,onLineSaleStatus:1,offLineStopMessage:'抱歉，本彩种已停止销售',onLineStopMessage:'抱歉，本彩种已停止销售'}}]]
    .map(([method,url,value])=>resign({method,page:null,sourceRequest:{url,method:'GET',page:null,role:method},
      sourceCycleId:'synthetic-source-cycle',requestedAt:capturedAt,receivedAt:capturedAt,providerObservedAt:null,
      httpStatus:200,httpDate:null,httpEtag:null,contentType:'application/json',headersSha256:'a'.repeat(64),rawSha256:'b'.repeat(64),rawBytes:200,
      ok:true,rows:0,payload:{dataFrom:'',emptyFlag:false,errorCode:'0',errorMessage:'处理成功',success:true,value}}));
  return {capturedAt,sourceCycleId:'synthetic-source-cycle',endpoints};
}
const audit=(snapshot,clock=asOf)=>auditOfficialClosedSchedule(snapshot,{asOf:clock,trustRegistry:registry});
let checks=0;
const test=(name,fn)=>{fn();checks++;};
const reject=(mutate,pattern)=>test(String(pattern),()=>{const snapshot=fixture();mutate(snapshot);const r=audit(snapshot);assert.equal(r.emptyCurrentIntegrityEligible,false);assert.match(r.blockers.join(','),pattern);});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-closure-proof-'));
const snapshotPath=path.join(dir,'snapshot.json'),trustRegistryPath=path.join(dir,'registry.json');
fs.writeFileSync(trustRegistryPath,JSON.stringify(registry));
const create=(snapshot=fixture())=>{fs.writeFileSync(snapshotPath,JSON.stringify(snapshot));return captureOfficialClosedSchedule({snapshotPath,trustRegistryPath,asOf,publicationSourceCycleId:'synthetic-publication-cycle',currentListEvaluatedAt:asOf});};
const metaFor=closure=>({sourceCycleId:'synthetic-publication-cycle',files:{current:0,archivedUnsettled:0},currentListPolicy:{version:'kickoff-retention-v1',evaluatedAt:asOf,archivedUnsettled:0,unsettledRetentionHours:48,officialClosedSchedule:closure}});
try {
  test('paired signed stop-sale admits only empty integrity',()=>{const r=audit(fixture());assert.equal(r.emptyCurrentIntegrityEligible,true,JSON.stringify(r));for(const key of ['marketDataEligible','recommendationEligible','independentCollectorRedundancyEligible'])assert.equal(r[key],false);});
  test('empty proof is not a trusted market collector',()=>{const r=summarizeTrustedMarketCollectorEvidence(fixture(),{trustRegistry:registry});assert.equal(r.trustedCollectorCount,0);});
  reject(s=>s.endpoints[0].collectorAttestation.signature='A'.repeat(88),/signature-invalid/);
  reject(s=>s.endpoints[0].payload.value.lastUpdateTime='tampered',/payload-rehash-mismatch/);
  reject(s=>s.endpoints.pop(),/calculator-endpoint-count-invalid/);
  reject(s=>s.endpoints.push(copy(s.endpoints[0])),/current-endpoint-count-invalid/);
  reject(s=>{s.endpoints[0].sourceCycleId='different';resign(s.endpoints[0]);},/cycle-mismatch/);
  reject(s=>resign(s.endpoints[1],other),/runtime-mismatch/);
  reject(s=>{s.endpoints[0].httpStatus=567;resign(s.endpoints[0]);},/response-invalid/);
  reject(s=>{delete s.endpoints[1].payload.value.vtoolsConfig;resign(s.endpoints[1]);},/stop-sale-unproven/);
  reject(s=>{s.endpoints[1].payload.value.vtoolsConfig.onLineSaleStatus=0;resign(s.endpoints[1]);},/stop-sale-unproven/);
  reject(s=>{s.endpoints[1].payload.value.vtoolsConfig.onLineStopMessage='没有比赛';resign(s.endpoints[1]);},/stop-sale-unproven/);
  reject(s=>{s.endpoints[0].payload.value.totalCount=1;resign(s.endpoints[0]);},/total-not-zero/);
  reject(s=>{s.endpoints[0].payload.value.matchInfoList=[{subMatchList:[{matchId:1}]}];resign(s.endpoints[0]);},/response-invalid/);
  reject(s=>{s.endpoints[0].sourceRequest.url+='&unknown=1';resign(s.endpoints[0]);},/scope-invalid/);
  reject(s=>{s.endpoints[0].requestedAt='2026-10-03T00:00:01.000Z';resign(s.endpoints[0]);},/clock-invalid/);
  reject(s=>{s.endpoints[0].receivedAt='2026-10-03T00:00:00.000000001Z';},/signed-clock-mismatch/);
  reject(s=>{s.capturedAt='2026-02-30T00:00:00.000Z';},/envelope-clock-invalid/);
  test('exact twenty minutes accepted; one nanosecond over rejected',()=>{assert.equal(audit(fixture(),'2026-10-03T00:20:00.000Z').emptyCurrentIntegrityEligible,true);assert.equal(audit(fixture(),'2026-10-03T00:20:00.000000001Z').emptyCurrentIntegrityEligible,false);});
  test('future clock rejected at one nanosecond',()=>assert.equal(audit(fixture(),'2026-10-02T23:59:59.999999999Z').emptyCurrentIntegrityEligible,false));
  test('missing trust cannot be supplied by proof metadata',()=>{const s=fixture();s.trustRegistry=registry;s.eligible=true;assert.equal(auditOfficialClosedSchedule(s,{asOf}).emptyCurrentIntegrityEligible,false);});
  test('missing file paths reject',()=>assert.equal(readOfficialClosedScheduleEvidence({asOf}).emptyCurrentIntegrityEligible,false));
  test('proof projection excludes private metadata and does not change input bytes',()=>{const s=fixture();s.producer={secret:'private-only'};s.endpoints[0].requestHeaders={Authorization:'private-only'};fs.writeFileSync(snapshotPath,JSON.stringify(s));const before=fs.readFileSync(snapshotPath);const c=captureOfficialClosedSchedule({snapshotPath,trustRegistryPath,asOf,publicationSourceCycleId:'synthetic-publication-cycle',currentListEvaluatedAt:asOf});assert.equal(c.emptyCurrentIntegrityEligible,true,JSON.stringify(c));assert.ok(c.proof);assert.doesNotMatch(JSON.stringify(c.proof),/private-only|privateKey|publicKeyPem/);assert.deepEqual(fs.readFileSync(snapshotPath),before);assert.equal(c.proof.snapshot.capturedAt,capturedAt);assert.equal(c.proof.snapshot.sourceCycleId,'synthetic-source-cycle');assert.equal(c.proof.publicationSourceCycleId,'synthetic-publication-cycle');});
  test('path alias conflict rejects without fallback',()=>assert.equal(captureOfficialClosedSchedule({snapshotPath,alternateSnapshotPath:path.join(dir,'other.json'),trustRegistryPath,asOf}).proof,null));
  test('public proof rejects extended private payload shape',()=>{const s=fixture();s.endpoints[0].payload.value.authorization='private-only';resign(s.endpoints[0]);assert.equal(create(s).proof,null);});
  const closure=create(),meta=metaFor(closure);
  test('public proof independently verifies with fixed registry',()=>assert.equal(auditPublishedOfficialClosedSchedule(meta,{asOf,trustRegistryPath}).emptyCurrentIntegrityEligible,true));
  test('published true with no proof rejected',()=>assert.equal(auditPublishedOfficialClosedSchedule(metaFor({emptyCurrentIntegrityEligible:true}),{asOf,trustRegistryPath}).emptyCurrentIntegrityEligible,false));
  test('wrong published cycle rejects',()=>{const m=copy(meta);m.sourceCycleId='other';assert.equal(auditPublishedOfficialClosedSchedule(m,{asOf,trustRegistryPath}).emptyCurrentIntegrityEligible,false);});
  test('wrong evaluatedAt rejects',()=>{const m=copy(meta);m.currentListPolicy.evaluatedAt=capturedAt;assert.equal(auditPublishedOfficialClosedSchedule(m,{asOf,trustRegistryPath}).emptyCurrentIntegrityEligible,false);});
  test('proof expires when validated later; published flag ignored',()=>assert.equal(auditPublishedOfficialClosedSchedule(meta,{asOf:'2026-10-03T00:20:01.000Z',trustRegistryPath}).emptyCurrentIntegrityEligible,false));
  test('missing independent registry rejects proof supplied key',()=>{const m=copy(meta);m.currentListPolicy.officialClosedSchedule.proof.registry=registry;assert.equal(auditPublishedOfficialClosedSchedule(m,{asOf,trustRegistryPath:path.join(dir,'missing.json')}).emptyCurrentIntegrityEligible,false);});
  // Evaluate the actual syncData metadata construction, isolating its inputs
  // instead of invoking the large write-capable sync() pipeline.
  const syncFile=path.resolve(__dirname,'../scripts/syncData.cjs'),syncSource=fs.readFileSync(syncFile,'utf8');
  const policyBody=/    currentListPolicy: \{([\s\S]*?)\r?\n    \},\r?\n    files: \{/.exec(syncSource)?.[1];
  assert.ok(policyBody,'actual sync metadata callsite is present');
  function syncPolicy(count,env={}) {
    class Clock extends Date {constructor(...args){super(...(args.length?args:[asOf]));}}
    return vm.runInNewContext('({'+policyBody+'})',{split:{current:Array(count).fill({})},capturedAt:asOf,sourceCycleId:'synthetic-publication-cycle',
      CURRENT_UNSETTLED_RETENTION_HOURS:48,unresolvedArchive:[],process:{env},DEFAULT_SPORTTERY_RELAY_SNAPSHOT:snapshotPath,
      COLLECTOR_TRUST_REGISTRY_PATH:trustRegistryPath,require:createRequire(syncFile),Date:Clock});
  }
  test('actual sync callsite embeds proof under default existing paths',()=>{const policy=syncPolicy(0);assert.equal(policy.officialClosedSchedule.emptyCurrentIntegrityEligible,true);assert.equal(policy.officialClosedSchedule.proof.snapshot.capturedAt,capturedAt);});
  test('actual sync nonempty path does not add closure metadata',()=>assert.equal(syncPolicy(1).officialClosedSchedule,undefined));
  test('actual sync conflicting path aliases fail closed',()=>assert.equal(syncPolicy(0,{SPORTTERY_RELAY_SNAPSHOT:snapshotPath,SPORTTERY_RELAY_SNAPSHOT_PATH:path.join(dir,'conflict.json')}).officialClosedSchedule.proof,null));
  // Exercise the actual validator entry point with deterministic in-memory data;
  // real signatures and the actual proof reader remain active, no production I/O.
  const validator=path.resolve(__dirname,'../scripts/validateData.cjs'),source=fs.readFileSync(validator,'utf8'),baseRequire=createRequire(validator);
  function runValidator(publicOnly,m=meta,badHistory=false,{missingCurrent=false,nonemptyCurrent=false}={}) {
    const history=[{id:'sporttery_991981',sourceMatchId:'991981',source:'sporttery',sourceUrl:SPORTTERY_CURRENT_URL,status:'FINISHED',kickoffTime:'2026-09-06T12:00:00.000Z',homeTeamColor:'#112233',awayTeamColor:'#445566',predictions:[],scoreHome:badHistory?null:1,scoreAway:1}];
    const files=new Map([['matches-current.json',[]],['matches-history.json',history],['sync-meta.json',m],['matches-unresolved-archive.json',[]]]);
    if(missingCurrent)files.delete('matches-current.json');
    if(nonemptyCurrent)files.set('matches-current.json',[{...history[0],id:'sporttery_991982',sourceMatchId:'991982',status:'SCHEDULED',kickoffTime:'2026-10-03T12:00:00.000Z',scoreHome:null,scoreAway:null}]);
    const io=Object.create(fs);io.existsSync=p=>files.has(path.basename(p));io.statSync=p=>({size:Buffer.byteLength(JSON.stringify(files.get(path.basename(p))))});io.readFileSync=p=>JSON.stringify(files.get(path.basename(p)));
    const messages=[];let code=0,payload=null;const stop={};
    class Clock extends Date {constructor(...args){super(...(args.length?args:[asOf]));}static now(){return Date.parse(asOf);}}
    const fn=vm.runInNewContext(`(function(require,__dirname,process,console){${source}\n})`,{Date:Clock});
    const req=name=>['fs','node:fs'].includes(name)?io:name==='../server/chunkedJsonFile.cjs'?{readChunkedJsonFile:p=>({value:JSON.parse(io.readFileSync(p))})}:baseRequire(name);
    try {fn(req,path.dirname(validator),{argv:['node',validator,...(publicOnly?['--public-distribution']:[])],env:{SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH:trustRegistryPath,WRITE_LEGACY_STATIC_PAYLOADS:'0',MIRROR_PUBLISHED_DATA_TO_DIST:'0'},exit:n=>{code=n;throw stop;}},{error:s=>messages.push(s),log:s=>payload=JSON.parse(s)});}catch(e){if(e!==stop)throw e;}
    return {code,payload,messages:messages.join('\n')};
  }
  for(const publicOnly of [false,true]) {
    test('actual validator accepts proven empty in scope '+publicOnly,()=>{const r=runValidator(publicOnly);assert.equal(r.code,0,r.messages);assert.equal(r.payload.officialClosedScheduleEvidence.emptyCurrentIntegrityEligible,true);assert.equal(r.payload.officialClosedScheduleEvidence.recommendationEligible,false);});
    test('actual validator rejects unproven empty in scope '+publicOnly,()=>{const r=runValidator(publicOnly,metaFor({emptyCurrentIntegrityEligible:true}));assert.equal(r.code,1);assert.match(r.messages,/stop-sale proof/);});
    test('actual validator retains history integrity in scope '+publicOnly,()=>{const r=runValidator(publicOnly,meta,true);assert.equal(r.code,1);assert.match(r.messages,/final scores/);});
    test('actual validator rejects missing current file in scope '+publicOnly,()=>{const r=runValidator(publicOnly,meta,false,{missingCurrent:true});assert.equal(r.code,1);assert.match(r.messages,/explicit matches-current/);});
    test('nonempty path is unaffected by unusable closure proof in scope '+publicOnly,()=>{const r=runValidator(publicOnly,metaFor({emptyCurrentIntegrityEligible:true}),false,{nonemptyCurrent:true});assert.equal(r.code,0,r.messages);assert.equal(r.payload.officialClosedScheduleEvidence,null);});
  }
  console.log(JSON.stringify({ok:true,checks,productionDataTouched:false,actualValidatorScopes:2,sourceFreshnessPromoted:false,marketCollectorsPromoted:false,recommendationsPromoted:false},null,2));
} finally {
  const resolved=path.resolve(dir),temp=path.resolve(os.tmpdir());
  if(resolved.startsWith(temp+path.sep)&&path.basename(resolved).startsWith('football-closure-proof-'))fs.rmSync(resolved,{recursive:true,force:true});
}
