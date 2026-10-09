'use strict';
// Controlled SQL protocol and synthetic signed source, never live adoption.
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../src/services/leagueBaselineModel.cjs'),maker=require('../src/services/leagueBaselineRecommendation.cjs');
const reg=require('../scripts/leagueBaselineRegistry.cjs'),runtime=require('../scripts/recommendationPlatform/leagueBaselineRuntime.cjs');
const signed=require('./fixtures/signed-live-had.cjs');
function fixture(){
 const match={...signed.source(),leagueId:require('../scripts/storedResultTeamIdentity.cjs').derivedTeamId('Synthetic League').replace(/^team_/,'league_')};
 const source=signed.snapshot([match],{mutate:e=>{e.payload.value.matchInfoList[0].subMatchList[0].leagueAllName='Synthetic League';}});
 const parameters={poisson:{teams:['Alpha','Bravo'],attack:[.3,-.3],defense:[0,0],homeIntercept:.3,awayIntercept:.1,converged:true,gradientNorm:1e-8},
  elo:{ratings:{Alpha:1500,Bravo:1500},homeAdvantage:50,drawRate:.25},frequencies:{1:.5,X:.25,2:.25},
  poissonWeight:1,trainingRows:380,through:'2025-12-01',inputHash:'f'.repeat(64)};
 const packet=m.seal({version:m.VERSION,league:'br1',researchOnly:true,formalEligible:false,
  createdAt:signed.stamp(signed.NOW-60000),availableAt:signed.stamp(signed.NOW-60000),parameters,parametersHash:m.hash(parameters),
  reportSha256:'a'.repeat(64),historySha256:'b'.repeat(64),
  validation:{kind:'chronological-statistical-holdout',testRows:380,brier:.6,logLoss:1,baselineBrier:.65,baselineLogLoss:1.1,formalEligible:false},
  bindings:['home','away'].map((side,i)=>({teamId:match[side+'TeamId'],teamName:match[side+'TeamName'],leagueId:require('../scripts/storedResultTeamIdentity.cjs').derivedTeamId('Synthetic League').replace(/^team_/,'league_'),modelTeam:parameters.poisson.teams[i],reviewId:'synthetic-only',reviewedAt:signed.stamp(signed.NOW-65000),evidence:[{url:'https://example.invalid/synthetic',sha256:'c'.repeat(64)}]}))});
 return {packet,match,snapshot:source.snapshot,trustRegistry:source.registry,asOf:signed.stamp(signed.NOW)};
}
function reseal(p){const {contentHash,...b}=p;return m.seal(b);}
function poolAt(now){
 let rows=new Map(),pending=null;const log=[];
 const client={release(){},async query(sql,args=[]){log.push(sql);
  if(sql.startsWith('BEGIN')){pending=new Map(rows);return {rows:[]};}
  if(sql==='COMMIT'){rows=pending;pending=null;return {rows:[]};}
  if(sql==='ROLLBACK'){pending=null;return {rows:[]};}
  if(sql.includes('clock_timestamp()'))return {rows:[{now:new Date(now).toISOString()}]};
  if(sql.startsWith('SET ')||sql.includes('pg_advisory'))return {rows:[]};
  const active=pending||rows;
  if(sql.startsWith('INSERT INTO football.private_model_artifacts')){const [key,version,generated,updated,json,sha,bytes]=args;active.set(key,{artifact_key:key,artifact_version:version,generated_at:generated,updated_at:updated,payload_json:json,payload_sha256:sha,payload_bytes:bytes});return {rows:[]};}
  if(sql.includes("artifact_key ~"))return {rows:[...active.values()].filter(r=>/^league-forecast-[a-f0-9]{64}$/.test(r.artifact_key)&&JSON.parse(r.payload_json).record.businessDate===args[0])};
  if(sql.includes('WHERE artifact_key=$1'))return {rows:active.has(args[0])?[active.get(args[0])]:[]};
  throw Error('Unexpected SQL '+sql);
 }};
 return {pool:{connect:async()=>client},client,log,rows:()=>rows,setNow:value=>{now=value;}};
}
test('projection replays trained Poisson; HAD/HHAD/total mass coherent',()=>{
 const f=fixture(),grid=m.project(f.packet.parameters,'Alpha','Bravo',-1);
 const original=require('../scripts/runLeagueBaselineExperiment.cjs').projection(f.packet.parameters,'Alpha','Bravo',1);
 for(const k of ['1','X','2'])assert.ok(Math.abs(grid.had[k]-original.probabilities[k])<1e-12);
 assert.ok(Math.abs(Object.values(grid.hhad.probabilities).reduce((a,b)=>a+b)-1)<1e-12);
 assert.ok(Math.abs(Object.values(grid.totals).reduce((a,b)=>a+b)-1)<1e-12);
});
for(const [label,mutate]of Object.entries({tampered:p=>p.parameters.poisson.attack[0]++,future:p=>{p.availableAt='2099-01-01T00:00:00Z';},mixture:p=>{p.parameters.poissonWeight=.5;p.parametersHash=m.hash(p.parameters);},holdout:p=>p.validation.testRows=32,duplicate:p=>p.bindings.push(p.bindings[0])}))test('reject model '+label,()=>{
 const f=fixture();mutate(f.packet);const p=label==='tampered'?f.packet:reseal(f.packet);assert.equal(m.verifyPacket(p,f.asOf).valid,false);
});
test('signed price plus trained packet generates version-bound reference; odds never alter p',()=>{
 const f=fixture(),r=maker.make(f);assert.equal(r.modelHash,f.packet.contentHash);assert.equal(r.parametersHash,f.packet.parametersHash);
 assert.equal(r.forecast.marketProbabilityInput,false);assert.equal(maker.verify(r,f),true);
 const old=m.hash(r.forecast.grid);f.match.probabilityModel={oneXTwo:{final:{home:0,draw:0,away:100}}};assert.equal(m.hash(maker.make(f).forecast.grid),old);
 const changed=structuredClone(r);changed.forecast.grid.had['1']+=.1;assert.equal(maker.verify(changed,f),false);
});
for(const [label,mutate]of Object.entries({missingMapping:f=>{f.packet.bindings=[];f.packet=reseal(f.packet);},wrongLeague:f=>f.match.leagueId='other',unsigned:f=>delete f.snapshot.endpoints[0].collectorAttestation,closed:f=>f.match.saleStatus='CLOSED',untrained:f=>{f.packet.bindings[0].modelTeam='Other';f.packet=reseal(f.packet);}}))test('reject input '+label,()=>{const f=fixture();mutate(f);assert.throws(()=>maker.make(f));});
test('optional injury/lineup/xG fields may be absent without fake health assumptions',()=>{const r=maker.make(fixture());assert.deepEqual(r.optionalFactorsUsed,[]);assert.equal(r.formalEligible,false);});
test('registration CAS, immutable history, load and adoption commit roundtrip',async()=>{
 const f=fixture(),db=poolAt(signed.NOW-1000);
 const registered=await reg.install(f.packet,{pool:db.pool,expectedSha256:null});assert.equal(registered.commitAcknowledged,true);
 await assert.rejects(reg.install(f.packet,{pool:db.pool,expectedSha256:null}),/REGISTRY_CHANGED/);
 const loaded=await reg.load(db.client,signed.stamp(signed.NOW+100));assert.equal(loaded.packets[0].contentHash,f.packet.contentHash);
 db.setNow(signed.NOW+1000);const r=maker.make(f),saved=await runtime.append(db.pool,r,f);assert.equal(saved.acknowledged,true);
 const view=await runtime.projection(db.client,f.match.businessDate,signed.stamp(signed.NOW+2000),f.trustRegistry);
 assert.equal(view.records.length,1);assert.equal(view.records[0].modelHash,f.packet.contentHash);
 const again=await runtime.append(db.pool,r,f);assert.equal(again.created,false);assert.equal(db.rows().size,4);
 assert.equal(db.log.some(s=>s.includes('recommendation_decisions')),false);
});
test('missing ACK cannot become visible and cutoff prevents first write',async()=>{
 const f=fixture(),db=poolAt(signed.NOW-1000);await reg.install(f.packet,{pool:db.pool,expectedSha256:null});
 const r=maker.make(f);db.setNow(Date.parse(r.forecast.cutoffAt));await assert.rejects(runtime.append(db.pool,r,f),/COMMIT_DEADLINE/);
 assert.equal((await runtime.projection(db.client,f.match.businessDate,db.rows().values().next().value.updated_at,f.trustRegistry)).records.length,0);
});
test('browser projection verifies binding, hides old-day references and renders one HAD direction',async()=>{
 const f=fixture(),db=poolAt(signed.NOW-1000);await reg.install(f.packet,{pool:db.pool,expectedSha256:null});
 db.setNow(signed.NOW+1000);await runtime.append(db.pool,maker.make(f),f);
 const raw=await runtime.projection(db.client,f.match.businessDate,signed.stamp(signed.NOW+2000),f.trustRegistry);
 const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
 function compile(file){const module={exports:{}},native=require('node:module').createRequire(path.resolve(file));
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
   {module,exports:module.exports,Date,require:(id)=>{if(id.startsWith('.')){const base=path.resolve(path.dirname(file),id);for(const ext of ['.tsx','.ts'])if(fs.existsSync(base+ext))return compile(base+ext);}return native(id);}});return module.exports;}
 const view=compile('src/services/recommendationCenterView.ts');
 const parsed=view.parseLeagueBaseline(raw,raw.businessDate,raw.updatedAt);assert.equal(parsed.records[0].modelHash,f.packet.contentHash);
 const component=compile('src/components/recommendations/LeagueBaselineDirections.tsx').LeagueBaselineDirections;
 const html=require('react-dom/server').renderToStaticMarkup(require('react').createElement(component,{data:parsed,language:'zh',now:signed.NOW+3000,failed:false}));
 assert.match(html,/data-model-hash/);assert.match(html,/未校准/);assert.match(html,/主胜/);
 raw.records[0].parametersHash='d'.repeat(64);assert.throws(()=>view.parseLeagueBaseline(raw,raw.businessDate,raw.updatedAt),/seal/);
});
test('model registered after decision clock cannot be backdated into adoption',async()=>{
 const f=fixture(),db=poolAt(signed.NOW+1000);await reg.install(f.packet,{pool:db.pool,expectedSha256:null});
 await assert.rejects(runtime.append(db.pool,maker.make(f),f),/ACTIVE_MODEL_CHANGED/);
});
test('runtime with empty native registry records absence without acquiring matches or source',async()=>{
 const db=poolAt(signed.NOW);const result=await runtime.run({pool:db.pool,trustRegistry:fixture().trustRegistry});
 assert.equal(result.status,'awaiting-model');assert.equal(result.registry.length,2);assert.equal(result.created,0);
 assert.equal(db.log.some(q=>q.includes('match_snapshots')),false);
});
module.exports={fixture,poolAt};
