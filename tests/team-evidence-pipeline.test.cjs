'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const p=require('../scripts/teamEvidenceSources.cjs'),store=require('../scripts/teamEvidenceStore.cjs');
const {run}=require('../scripts/syncTeamEvidence.cjs');
const f=require('./fixtures/signed-live-had.cjs'),review=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {derivedTeamId}=require('../scripts/storedResultTeamIdentity.cjs');
const at='2026-09-17T10:00:00.000Z';
function fixture(){
 const plans=p.plans([{businessDate:'2026-09-17',leagueName:'韩国职业联赛'}],at);
 const response=payload=>{const raw=JSON.stringify(payload);return {raw,bytes:Buffer.byteLength(raw),rawSha256:p.sha(raw),status:200,requestedAt:'2026-09-17T09:58:00.000Z',receivedAt:'2026-09-17T09:59:00.000Z'};};
 const rank=plans.find(v=>v.kind==='standings'),schedule=plans.find(v=>v.month==='09');
 const standing={resultCode:'200',data:{teamRank:[{year:2026,teamId:'K09',rank:1,gainPoint:60,gameCount:30},{year:2026,teamId:'K04',rank:8,gainPoint:30,gameCount:30}]}};
 const matches={resultCode:'200',data:{scheduleList:[{year:2026,leagueId:1,gameId:1,gameDate:'2026.09.18',gameTime:'00:00',homeTeam:'K09',awayTeam:'K04',endYn:'N',gameStatus:'',homeGoal:0,awayGoal:0},
  {year:2026,leagueId:1,gameId:2,gameDate:'2026.09.10',gameTime:'19:00',homeTeam:'K09',awayTeam:'K04',endYn:'Y',gameStatus:'FE',homeGoal:1,awayGoal:0}]}};
 const packets=[p.pack(rank,response(standing)),p.pack(schedule,response(matches))];
 const event={sourceMatchId:'1',eventVersion:'2026-09-17T15:00:00.000Z',businessDate:'2026-09-17',homeTeamId:derivedTeamId('首尔FC'),awayTeamId:derivedTeamId('济州SK'),homeTeamName:'首尔FC',awayTeamName:'济州SK',leagueName:'韩国职业联赛'};
 return {plans,packets,event,response,standing,matches};
}
function db({commitUnknown=false,matches=[{businessDate:'2026-09-17',leagueName:'韩国职业联赛'}],base=Date.parse(at)}={}){
 let rows=new Map(),pending=null,now=base,fail=commitUnknown;const log=[];
 const c={release(){},async query(sql,args=[]){log.push(sql);
  if(sql.startsWith('BEGIN')){pending=new Map(rows);return {rows:[]};}
  if(sql==='COMMIT'){rows=pending;pending=null;if(fail){fail=false;throw Error('lost COMMIT response');}return {rows:[]};}
  if(sql==='ROLLBACK'){pending=null;return {rows:[]};}
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.startsWith('SET ')||sql.includes('advisory'))return {rows:[]};
  if(sql.includes('clock_timestamp'))return {rows:[{now:new Date(++now)}]};
  if(sql.includes('match_snapshots'))return {rows:matches.map(payload=>({payload}))};
  const current=pending||rows;
  if(sql.startsWith('INSERT INTO football.private_model_artifacts')){const [key,version,generated,updated,json,sha,bytes]=args;if(!sql.includes('ON CONFLICT'))a.ok(!current.has(key));
   current.set(key,{artifact_key:key,artifact_version:version,generated_at:generated,updated_at:updated,payload_json:json,payload_sha256:sha,payload_bytes:bytes});return {rows:[]};}
  if(sql.includes('WHERE artifact_key=$1'))return {rows:current.has(args[0])?[current.get(args[0])]:[]};throw Error('unexpected query: '+sql);
 }};return {pool:{connect:async()=>c},client:c,rows:()=>rows,log};
}
test('plan is limited to current business-day leagues; histories daily and Korean data 6 hourly',()=>{
 const v=fixture();a.equal(v.plans.length,4);a.ok(v.plans.every(p=>p.intervalMs===21600000));
 const h=p.plans([{businessDate:'2026-09-17',leagueName:'英格兰超级联赛'},{businessDate:'2026-09-16',leagueName:'日本职业联赛'}],at);a.equal(h.length,2);a.ok(h.every(x=>x.intervalMs===86400000));
 a.equal(p.validPlan({...h[0],url:'https://example.com'}),false);
});
test('official evidence binds exact ordered teams/time and never claims two-source verification or learned factors',()=>{
 const v=fixture(),r=p.adopt(v.packets,v.event,at);a.equal(r.teams[0].lastFive.length,1);a.equal(r.secondIndependentSourceVerified,false);a.deepEqual(r.probabilityFactorsUsed,[]);a.ok(r.missing.includes('伤停/停赛'));
 for(const change of [{awayTeamName:'安养FC'},{eventVersion:'2026-09-17T14:00:00.000Z'},{leagueName:'英格兰超级联赛'}])a.throws(()=>p.adopt(v.packets,{...v.event,...change},at));
});
test('changed raw bytes, summary, future and expired evidence are rejected',()=>{
 const v=fixture();for(const mutate of [p=>p.response.raw+=' ',p=>p.summary.rows=99,p=>p.createdAt='2027-01-01T00:00:00.000Z']){const b=structuredClone(v.packets);mutate(b[0]);a.throws(()=>p.adopt(b,v.event,at));}
 a.throws(()=>p.adopt(v.packets,v.event,'2026-09-17T16:00:00.000Z'));
});
test('automatic capture forbids redirects and enforces bounded streamed body and errors',async()=>{
 const v=fixture(),plan=v.plans[0];let options;
 const packet=await p.capture(plan,{clock:()=>at,fetchImpl:async(url,opts)=>{options=opts;return new Response(JSON.stringify(v.standing));}});
 a.equal(p.verify(packet),true);a.equal(options.redirect,'error');a.equal(options.method,'POST');
 await a.rejects(p.capture(plan,{clock:()=>at,fetchImpl:async()=>new Response('bad',{status:403})}),/HTTP_403/);
 await a.rejects(p.capture(plan,{clock:()=>at,fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1))}),/RESPONSE_BOUND/);
});
test('native store retains immutable source bytes, advances separate head and proves committed readback',async()=>{
 const v=fixture(),d=db(),saved=await store.save(d.pool,v.packets[0]);a.equal(saved.commitReadback,true);a.equal(d.rows().size,3);
 const before=d.rows().get(saved.key).payload_json;await store.save(d.pool,v.packets[0]);a.equal(d.rows().get(saved.key).payload_json,before);
 await store.save(d.pool,v.packets[1]);const r=await store.loadForReview(d.client,v.packets.map(p=>store.key(p.contentHash)),v.event,'2026-09-17T10:00:01.000Z');a.equal(r.adoption.evidenceHashes.length,2);
 a.equal(d.log.some(q=>/UPDATE football.match|recommendation_decisions/.test(q)),false);
});
test('unknown COMMIT throws without retrying or reporting adoption',async()=>{
 const v=fixture(),d=db({commitUnknown:true});await a.rejects(store.save(d.pool,v.packets[0]),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});a.equal(d.log.filter(q=>q==='COMMIT').length,1);a.equal(d.rows().size,3);
});
test('unchanged provider body is stored once while new acquisition retains a distinct immutable observation',async()=>{
 const v=fixture(),d=db();await store.save(d.pool,v.packets[0]);
 const again=p.pack(v.packets[0].plan,{...v.packets[0].response,receivedAt:'2026-09-17T09:59:01.000Z'});await store.save(d.pool,again);
 a.equal([...d.rows().keys()].filter(k=>k.startsWith('team-evidence-body-')).length,1);
 a.equal([...d.rows().keys()].filter(k=>/^team-evidence-[a-f0-9]{64}$/.test(k)).length,2);
 a.equal((await store.readPacket(d.client,store.key(again.contentHash),'2026-09-17T10:00:01.000Z')).createdAt,again.createdAt);
});
test('community history requires the separately fetched approved license receipt and cannot masquerade as official current facts',()=>{
 const plan=p.plans([{businessDate:'2026-09-17',leagueName:'英格兰超级联赛'}],at)[0];
 const v=fixture(),packet=p.pack(plan,v.response({name:'Premier League 2025/26',matches:[{date:'2025-09-10',team1:'A',team2:'B',score:{ft:[1,0]}}]}));
 a.equal(p.verify(packet),false);const {contentHash,...body}=packet;void contentHash;
 const licensed=p.seal({...body,licenseReceipt:{url:'https://raw.githubusercontent.com/openfootball/football.json/master/LICENSE.md',sha256:'36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673',receivedAt:'2026-09-17T09:58:00.000Z'}});
 a.equal(p.verify(licensed),true);a.throws(()=>p.adopt([licensed],v.event,at));
});
test('job persists attempt cooldown, does not erase good evidence on source failure, and skips repeat network calls',async()=>{
 const v=fixture(),d=db();let calls=0;
 const fetchImpl=async(url,options)=>{calls++;if(url.includes('teamRank'))return new Response(JSON.stringify(v.standing));
  const body=JSON.parse(options.body);if(body.month!=='09')return new Response('unavailable',{status:503});return new Response(JSON.stringify(v.matches));};
 const opts={pool:d.pool,fetchImpl,clock:()=>at,delay:async()=>{}};const first=await run(opts);a.equal(first.sources.filter(s=>s.status==='stored').length,2);a.equal(first.sources.filter(s=>s.status==='failed').length,2);
 const saved=[...d.rows().keys()].filter(k=>/^team-evidence-[a-f0-9]{64}$/.test(k));a.equal(saved.length,2);
 const count=calls,again=await run(opts);a.equal(calls,count);a.ok(again.sources.every(s=>s.status==='not-due'));a.ok(saved.every(k=>d.rows().has(k)));
});
function reviewedFixture(){
 const v=fixture(),match={...f.source(1),...v.event,kickoffTime:v.event.eventVersion};
 const asOf=f.stamp(f.NOW),clock=Date.parse(asOf),packets=v.packets.map(o=>p.pack(o.plan,{...o.response,requestedAt:f.stamp(clock-2000),receivedAt:f.stamp(clock-1000)}));
 const {snapshot,registry}=f.snapshot([match],{mutate:e=>{const r=e.payload.value.matchInfoList[0].subMatchList[0];r.homeTeamId=10;r.awayTeamId=11;r.leagueAllName='韩国职业联赛';}});
 const single={eventId:'1',matchNum:match.matchNo,businessDate:match.businessDate,kickoff:match.kickoffTime,market:'HAD',handicap:null,selection:'h',scores:[[2,0],[1,0]],confidence:'低',reason:'Official standings reviewed; other factors unknown',analysisUrl:'https://www.kleague.com/schedule.do',teams:['首尔FC','济州SK'],orderedTeamIds:[10,11],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research',evidenceKeys:packets.map(p=>store.key(p.contentHash))};
 const draft={version:2,reportKind:'evidence-backed-prematch',predictionScope:'reviewed-online-reference',businessDate:match.businessDate,frozenAt:f.stamp(clock-500),singles:[single]},input={matches:[match],snapshot,trustRegistry:registry,asOf,evidenceByEvent:{'1':packets}};
 return {draft,input,packets};
}
test('reviewed v2 uses actual evidence hashes with signed SP; missing optional facts remain low confidence',()=>{
 const {draft,input}=reviewedFixture(),r=review.make(draft,input);a.equal(r.records[0].evidenceHashes.length,2);a.equal(r.records[0].modelProbability,null);a.equal(r.records[0].sp,1.8);
 a.throws(()=>review.make(draft,{...input,evidenceByEvent:{}}));draft.singles[0].confidence='高';a.throws(()=>review.make(draft,input));
});
test('stored evidence -> actual review importer -> separate commit ACK -> public parser retains evidence adoption',async()=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),v=reviewedFixture(),d=db({matches:v.input.matches,base:f.NOW});
 for(const packet of v.packets)await store.save(d.pool,packet);
 const filename=path.resolve('scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs'),native=Module.createRequire(filename),m={exports:{}};
 require('node:vm').runInNewContext(fs.readFileSync(filename,'utf8'),{module:m,exports:m.exports,process,Buffer,Date,__dirname:path.dirname(filename),require:id=>{
  if(id.endsWith('collectorAttestation.cjs'))return {loadCollectorTrustRegistry:()=>v.input.trustRegistry};
  if(id==='./liveOfficialHandicap.cjs')return {readLiveOfficialSnapshot:()=>v.input.snapshot};return native(id);
 }});
 const saved=await m.exports.publish(v.draft,{pool:d.pool,expectedDraftHash:review.hash(v.draft)});a.equal(saved.status,'committed-and-acknowledged');
 const view=await m.exports.projection(d.client,v.draft.businessDate,f.stamp(f.NOW+5000));a.equal(view.records[0].evidenceHashes.length,2);
 const file=path.resolve('src/services/recommendationCenterView.ts'),mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
 mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
 const parsed=mod.exports.parseReviewedAnalysis(view,view.businessDate,view.updatedAt);a.equal(parsed.records[0].evidence.verification,'official-single-source');
 const bad=structuredClone(view);bad.records[0].evidenceAdoption.event.homeTeamId='wrong';const {contentHash,...body}=bad;void contentHash;bad.contentHash=review.hash(body);
 a.throws(()=>mod.exports.parseReviewedAnalysis(bad,bad.businessDate,bad.updatedAt));
 d.rows().delete(saved.key+'-ack');await a.rejects(m.exports.projection(d.client,v.draft.businessDate,f.stamp(f.NOW+5000)),/ACK_MISSING/);
});
