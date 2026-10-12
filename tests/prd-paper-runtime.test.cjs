'use strict';
// Synthetic transaction/transport boundaries. Actual mathematical replay and
// signature admission are covered by the separate maker/repository suites.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const {memoryPorts,validators}=require('./recommendationFixture.cjs');
const ROOT=path.resolve(__dirname,'..');
function moduleWith(file,overrides){
 const filename=path.join(ROOT,file),native=createRequire(filename),box={module:{exports:{}},Buffer,Date,Set,Map,Object,Array,Number,JSON,BigInt,RegExp,process,structuredClone};
 box.require=id=>Object.hasOwn(overrides,id)?overrides[id]:native(id);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename});return box.module.exports;
}
function policyBoundary({tasks=[],matches=[],snapshot={synthetic:true},saved={inserted:true,acknowledged:true}}={}){
 const calls=[],event={recordedSourceMatchId:'123',eventVersion:new Date(Date.now()+3600000).toISOString(),homeTeamId:'h',awayTeamId:'a'};
 const day=require('../src/services/publishedForecastPolicy.cjs').day(Date.now());
 const task={input:{businessDate:day,artifact:{synthetic:true},forecast:{event}}};
 let clientHeld=false;
 const client={async query(sql){calls.push(sql);return{rows:[]};},release(){clientHeld=false;calls.push('release');}};
 const pool={async connect(){assert.equal(clientHeld,false);clientHeld=true;return client;}};
 class Repository{
  constructor(c,options){assert.equal(c,client);this.options=options;calls.push(['repository',options]);}
  async currentInputs(){calls.push('inputs');return{current:matches===true?[{sourceMatchId:'123',businessDate:day,homeTeamId:'h',awayTeamId:'a',eventVersion:event.eventVersion}]:matches};}
 }
 const policy=moduleWith('scripts/recommendationPlatform/prdPaperRuntime.cjs',{
  './repository.cjs':{Repository},
  './prdPaperRepository.cjs':{
   async readPrdForwardInputs(){calls.push('tasks');return{tasks:tasks===true?[task]:tasks,blockedCount:0,truncated:false};},
   async appendPrdPaper(p,{trustRegistry}){assert.equal(p,pool);assert.equal(clientHeld,false,'the old/read transaction must release before the writer');assert.equal(trustRegistry.version,'synthetic-configured-registry');calls.push('append');return saved;},
  },
  './liveOfficialHandicap.cjs':{readLiveOfficialSnapshot(){assert.equal(clientHeld,false);calls.push('snapshot');return snapshot;}},
  '../../src/services/prdPaperRecommendation.cjs':{createPrdPaperRecommendation({trustRegistry}){assert.equal(trustRegistry.version,'synthetic-configured-registry');calls.push('maker');return{version:'prd-paper-recommendation-v1',status:'paper-screened'};}},
 });
 return{policy,pool,calls,registry:{version:'synthetic-configured-registry',keys:[]}};
}
test('missing approval configuration performs no PG/source/model work',async()=>{
 const b=policyBoundary();const r=await b.policy.runPrdPaperCycle({pool:b.pool,env:{}});
 assert.equal(r.status,'awaiting-inputs');assert.equal(r.created,0);assert.equal(r.formalEligible,false);assert.deepEqual(b.calls,[]);
});
test('model hash configuration rejects duplicate, oversized and non-JSON approvals',()=>{
 const {policy}=policyBoundary(),h='a'.repeat(64);
 assert.deepEqual(Array.from(policy.approvedModelHashes({PRD_PAPER_APPROVED_MODEL_HASHES:JSON.stringify([h])})),[h]);
 for(const raw of ['true','["bad"]',JSON.stringify([h,h]),' '.repeat(1201),JSON.stringify(Array.from({length:17},(_,i)=>i.toString(16).padStart(64,'0')))])
  assert.throws(()=>policy.approvedModelHashes({PRD_PAPER_APPROVED_MODEL_HASHES:raw}),e=>e.code==='PRD_MODEL_CONFIG_INVALID');
});
test('an approved model with no forward task has a read-only bounded transaction and no source duplication',async()=>{
 const b=policyBoundary();const r=await b.policy.runPrdPaperCycle({pool:b.pool,env:{PRD_PAPER_APPROVED_MODEL_HASHES:JSON.stringify(['a'.repeat(64)])},trustRegistry:b.registry});
 assert.equal(r.status,'awaiting-inputs');assert.equal(b.calls.includes('inputs'),false);assert.equal(b.calls.includes('snapshot'),false);
 assert(b.calls.includes('SET TRANSACTION READ ONLY'));assert(b.calls.includes('SET LOCAL statement_timeout = 7000'));
 assert.equal(b.calls.at(-1),'release');assert(b.calls.includes('COMMIT'));
});
test('configured trust resolves outside the pure maker and paper commit runs after read transaction release',async()=>{
 const b=policyBoundary({tasks:true,matches:true});const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prd-trust-'));
 try{const filename=path.join(dir,'registry.json');fs.writeFileSync(filename,JSON.stringify(b.registry));
  const r=await b.policy.runPrdPaperCycle({pool:b.pool,env:{PRD_PAPER_APPROVED_MODEL_HASHES:JSON.stringify(['a'.repeat(64)]),SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH:filename}});
  assert.equal(r.status,'paper-recorded');assert.equal(r.acknowledged,1);assert(b.calls.indexOf('release')<b.calls.indexOf('maker'));assert(b.calls.includes('append'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('ordered-team mismatch never reaches the maker/writer',async()=>{
 const b=policyBoundary({tasks:true,matches:[{sourceMatchId:'123',businessDate:'2000-01-01',homeTeamId:'a',awayTeamId:'h',eventVersion:'2000-01-01T00:00:00Z'}]});
 const r=await b.policy.runPrdPaperCycle({pool:b.pool,env:{PRD_PAPER_APPROVED_MODEL_HASHES:JSON.stringify(['a'.repeat(64)])},trustRegistry:b.registry});
 assert.equal(r.status,'blocked');assert.equal(r.created,0);assert.equal(b.calls.includes('maker'),false);assert.equal(b.calls.includes('append'),false);
});
test('paper projection never declares the old reference to be an active formal strategy',()=>{
 const {policy}=policyBoundary(),view=policy.pipelineView({businessDate:'2026-10-07',updatedAt:'2026-10-07T00:00:00Z',projection:{records:[],blockedCount:0}});
 assert.equal(view.activeFormalStrategy,null);assert.equal(view.legacyReferenceStrategy,'coherent-market-primary-v1');assert.equal(view.formalStrategyChanged,false);
 assert.equal(view.requestedStrategy,'prd-paper-recommendation-v1');assert.equal(view.status,'awaiting-inputs');
 const failed=policy.pipelineView({businessDate:view.businessDate,updatedAt:view.updatedAt,readFailed:true});
 assert.equal(failed.status,'blocked');assert.deepEqual(Array.from(failed.records),[]);
 assert.equal(policy.pipelineView({businessDate:view.businessDate,updatedAt:view.updatedAt,lane:{status:'ok',paperStatus:'blocked'},projection:{records:[],blockedCount:1}}).status,'blocked');
 assert.equal(policy.errorCode({code:'password=secret'}),'PRD_PAPER_FAILED');
});
function runtimeBoundary(run){
 const base=memoryPorts();let inTransaction=false;
 const ports={...base,clock:()=>base.now,prdPaperPool:{synthetic:true},async transaction(lane,fn){
  return base.transaction(lane,async repo=>{inTransaction=true;repo.prdPaperProjection=async(date,options)=>{assert.equal(options.asOf,new Date(base.now).toISOString());assert.equal(date,require('../src/services/publishedForecastPolicy.cjs').day(base.now));return{records:[],blockedCount:0,truncated:false};};
   try{return await fn(repo);}finally{inTransaction=false;}});
 }};
 const realPolicy=require('../scripts/recommendationPlatform/prdPaperRuntime.cjs');
 const createRuntime=moduleWith('scripts/recommendationPlatform/runtime.cjs',{'./prdPaperRuntime.cjs':{...realPolicy,async runPrdPaperCycle(){assert.equal(inTransaction,false);return run(base);}}}).createRuntime;
 return{base,runtime:createRuntime(ports,{validators,dualResearchEnabled:false,dualResearchV2Enabled:false})};
}
test('paper failure does not roll back old frozen publication or leak raw SQL into the public lane',async()=>{
 const b=runtimeBoundary(()=>{throw Object.assign(new Error('SELECT secret credentials'),{code:'SQL password secret'});});
 const r=await b.runtime.publishingCycle();assert.equal(r.publication.ok,true);assert.equal(r.prdPaper.ok,false);assert.equal(r.prdPaper.errorCode,'PRD_PAPER_FAILED');
 assert(b.base.state.decisions.length>0);const hashes=b.base.state.decisions.map(d=>d.recordHash);
 assert.equal(b.base.state.view.prdPaper.status,'blocked');assert.equal(JSON.stringify(b.base.state.view.prdPaper).includes('secret'),false);
 await b.runtime.prdPaper();assert.deepEqual(b.base.state.decisions.map(d=>d.recordHash),hashes);
});
test('paper error preserves the previous success clock and cannot overwrite a newer lane attempt',async()=>{
 const b=runtimeBoundary(()=>{throw Object.assign(new Error('Synthetic failure'),{code:'SYNTHETIC_FAILURE'});});
 const previous=new Date(b.base.now-1000).toISOString();
 await b.base.transaction('seed',repo=>repo.saveLane('prd-paper',{status:'ok',lastSuccessAt:previous}));
 await b.runtime.prdPaper();assert.equal(b.base.state.lanes['prd-paper'].lastSuccessAt,previous);
 const newer=new Date(b.base.now+1000).toISOString();
 await b.base.transaction('seed',repo=>repo.saveLane('prd-paper',{status:'ok',lastAttemptAt:newer,lastSuccessAt:newer}));
 await b.runtime.prdPaper();assert.equal(b.base.state.lanes['prd-paper'].lastAttemptAt,newer);assert.equal(b.base.state.lanes['prd-paper'].status,'ok');
});
test('legacy ports without the new pool retain the old center shape',async()=>{
 const ports=memoryPorts(),r=require('../scripts/recommendationPlatform/runtime.cjs').createRuntime(ports,{validators,dualResearchEnabled:false,dualResearchV2Enabled:false});
 const result=await r.publishingCycle();assert.equal(result.publication.ok,true);assert.equal(Object.hasOwn(result,'prdPaper'),false);assert.equal(Object.hasOwn(ports.state.view,'prdPaper'),false);
});
