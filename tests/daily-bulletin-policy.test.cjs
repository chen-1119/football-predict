'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const p=require('../scripts/recommendationPlatform/dailyBulletinPolicy.cjs');
const ev=require('../scripts/recommendationPlatform/dailySourceEvidence.cjs');
const NOW=Date.parse('2026-10-09T12:00:00Z'),at=new Date(NOW).toISOString();
function fixture(line=-1,probs={'1':.55,X:.25,'2':.2}){
 const d={sourceMatchId:'100',eventVersion:'2026-10-09T13:20:00.000Z',businessDate:'2026-10-09',homeTeamId:'h1',awayTeamId:'a1',homeTeamName:'H',awayTeamName:'A',matchNo:'周五001',
  publishedAt:at,kickoffTime:'2026-10-09T13:20:00.000Z',cutoffTime:'2026-10-09T13:15:00.000Z',probabilities:probs,quoteOdds:{'1':2.2,X:3.3,'2':3.5},
  quoteSource:'sporttery:HAD:signed-live',quoteObservedAt:at,decisionId:'source1',recordHash:'a'.repeat(64),
  handicapAnalysis:{handicapLine:line,marketReference:{source:'sporttery:HHAD',observedAt:at,odds:{'1':3.5,X:3.3,'2':2.2}}}};
 const cells=[{home:1,away:0},{home:2,away:0},{home:0,away:0},{home:1,away:1},{home:0,away:1},{home:0,away:2}].map(s=>({...s,label:`${s.home}-${s.away}`,probability:.1}));
 return {decision:d,distribution:{status:'available',topScores:cells,hadProbabilities:probs,hhadProbabilities:{'1':.2,X:.3,'2':.5},totalGoals:[]},
  identity:{saleCutoff:d.cutoffTime},slot:'featured',now:NOW};
}
test('weekday and weekend Beijing schedule and opening boundaries',()=>{
 assert.deepEqual(p.slots('2026-10-09T02:59:59Z'),[]);
 assert.deepEqual(p.slots('2026-10-09T03:00:00Z'),['early']);
 assert.deepEqual(p.slots('2026-10-09T12:00:00Z'),['early','featured']);
 assert.deepEqual(p.slots('2026-10-09T13:00:00Z'),['early','featured','full']);
 assert.deepEqual(p.slots('2026-10-09T14:00:00Z'),[]);
 assert.equal(p.schedule('2026-10-10T12:00:00Z').featuredAt,'2026-10-10T13:00:00.000Z');
 assert.equal(p.schedule('2026-10-11T14:00:00Z').fullAt,'2026-10-11T14:00:00.000Z');
});
test('home favourite ordinary win is never relabelled handicap win',()=>{const r=p.pick(fixture());assert.equal(r.selection.market,'HAD');assert.equal(r.selection.label,'胜');assert.ok(r.scores.every(s=>s.home>s.away));});
test('negative line draw tendency uses authentic handicap loss and compatible scores',()=>{const r=p.pick(fixture(-1,{'1':.2,X:.5,'2':.3}));assert.equal(r.selection.label,'让负(-1)');assert.equal(r.selection.odds,2.2);assert.ok(r.scores.every(s=>s.home-s.away-1<0));});
test('receiving side keeps ordinary outcome',()=>{const r=p.pick(fixture(1,{'1':.2,X:.3,'2':.5}));assert.equal(r.selection.market,'HAD');assert.equal(r.selection.tipCode,'2');});
test('minus two uses actual handicap grid not HAD draw plus loss',()=>{const r=p.pick(fixture(-2,{'1':.2,X:.5,'2':.3}));assert.equal(r.modelProbability,.5);assert.notEqual(r.modelProbability,.8);assert.equal(r.scores[0].label,'1-0');});
test('negative line one goal win settles as handicap draw',()=>{assert.ok(p.compatible({home:2,away:1},{market:'HHAD',handicapLine:-1,tipCode:'X'}));assert.ok(!p.compatible({home:2,away:1},{market:'HHAD',handicapLine:-1,tipCode:'2'}));});
for(const [name,change] of [
 ['cutoff crossed',f=>f.now=Date.parse(f.decision.cutoffTime)],
 ['quote stale',f=>f.decision.quoteObservedAt=new Date(NOW-900001).toISOString()],
 ['future quote',f=>f.decision.quoteObservedAt=new Date(NOW+1).toISOString()],
 ['missing official price',f=>f.decision.quoteOdds.X=null],
 ['wrong business day',f=>f.decision.businessDate='2026-10-08'],
 ['missing identity',f=>f.identity=null],
 ['score model unavailable',f=>f.distribution.status='unavailable'],
 ['tied model leader',f=>f.decision.probabilities={'1':.4,X:.4,'2':.2}],
 ['early future night game',f=>{f.slot='early';f.decision.kickoffTime='2026-10-09T14:00:00Z';}],
 ])test(name+' is not published',()=>{const f=fixture();change(f);assert.equal(p.pick(f),null);});
test('missing facts remain unknown and cannot make combos',()=>{const r=p.pick(fixture());assert.equal(r.confidence,'low');assert.equal(r.comboEligible,false);assert.equal(r.analysisLink,null);assert.ok(r.evidence.every(f=>f.status==='unverified'));assert.ok(p.chooseTiers([r],NOW).every(t=>t.status==='unavailable'));});
test('market devig sums to one and differs from model probability',()=>{const r=p.pick(fixture());assert.ok(Math.abs(Object.values(r.marketProbabilities).reduce((a,b)=>a+b,0)-1)<1e-12);assert.notEqual(r.marketProbability,r.modelProbability);});
function candidate(i,odds){const {contentHash,...r}=p.pick(fixture());return p.seal({...r,id:'test'+i,sourceMatchId:String(i),homeTeamId:'h'+i,awayTeamId:'a'+i,comboEligible:true,valueScreen:true,confidence:'medium',selection:{...r.selection,odds}});}
test('combo products exact and three different pairs, not fabricated probability',()=>{const picks=[candidate(1,1.6),candidate(2,2),candidate(3,3.2),candidate(4,4)];const tiers=p.chooseTiers(picks,NOW);
 assert.ok(tiers.every(t=>t.status==='available'));assert.equal(new Set(tiers.map(t=>t.legs.map(l=>l.id).sort().join('|'))).size,3);
 for(const t of tiers){assert.equal(t.totalOdds,Math.round(t.legs[0].selection.odds*100)*Math.round(t.legs[1].selection.odds*100)/10000);assert.ok(t.totalOdds>=t.minimum);assert.equal(t.jointProbability,null);}});
test('rounded 2.50 cannot qualify raw 2.499',()=>{const tiers=p.chooseTiers([candidate(1,1.47),candidate(2,1.7)],NOW);assert.equal(tiers[0].status,'unavailable');});
test('same match and shared team rejected',()=>{const a=candidate(1,4),b=candidate(1,4);assert.ok(p.chooseTiers([a,b],NOW).every(t=>t.status==='unavailable'));});
test('unknown result yields zero denominator not a loss',()=>{const r=p.review([p.pick(fixture())],[],NOW+86400000);assert.equal(r.cumulative.settled,0);assert.equal(r.cumulative.hitRate,null);assert.equal(r.cumulative.pending,1);});
test('archive corruption excluded and report versions deduplicated',()=>{const a=p.pick(fixture()),{contentHash,...raw}=a;const b=p.seal({...raw,id:'other',slot:'full',publishedAt:new Date(NOW+60000).toISOString()});const r=p.review([a,b,{...a,confidence:'high'}],[],NOW+86400000);assert.equal(r.cumulative.published,1);assert.equal(r.versions.full.published,1);});
test('provider allowlist refuses arbitrary, credential and non-https URLs',()=>{assert.equal(ev.provider('https://x.500.com/a'),'500');for(const url of ['http://500.com/a','https://500.com.evil.test','https://user@500.com/','https://127.0.0.1/'])assert.equal(ev.provider(url),null);});
function evidence(){const f=fixture().decision;return ev.seal({version:'daily-source-evidence-v1',createdAt:at,reviewedBy:'operator',identityVerified:true,sourceMatchId:f.sourceMatchId,eventVersion:f.eventVersion,homeTeamId:f.homeTeamId,awayTeamId:f.awayTeamId,businessDate:f.businessDate,cutoffTime:f.cutoffTime,
 facts:ev.FIELDS.map(name=>({name,status:'unverified',text:'未核实',sources:[]}))});}
test('evidence cannot bind different ordered teams or event',()=>{const e=evidence(),d=fixture().decision;assert.ok(ev.valid(e,d,NOW));assert.ok(!ev.valid(e,{...d,homeTeamId:'other'},NOW));assert.ok(!ev.valid(e,{...d,eventVersion:'2026-10-10T00:00:00Z'},NOW));});
test('one source is insufficient and hash tampering rejected',()=>{const e=evidence();e.facts[1].status='verified';assert.ok(!ev.valid(e,fixture().decision,NOW));const {contentHash,...body}=e;assert.ok(!ev.valid(ev.seal(body),fixture().decision,NOW));});
test('SQL insert is immutable, bounded, and cannot overwrite old decisions',async()=>{const queries=[],client={query:async(sql,args)=>{queries.push({sql,args});return {rows:[{artifact_key:args?.[0]}]};}};const r=p.pick(fixture());assert.ok(await require('../scripts/recommendationPlatform/dailyBulletinRuntime.cjs').insert(client,r));assert.match(queries[0].sql,/ON CONFLICT\(artifact_key\) DO NOTHING/);assert.ok(!queries.some(q=>/UPDATE|DELETE/.test(q.sql)));});
test('fetched two-source excerpts are admitted, same-origin copies and stale injuries are rejected',async()=>{
 const {contentHash,...request}=evidence();
 const text='The recent five match results were independently checked.';
 request.facts[1]={name:'近5场',status:'verified',text,sources:[
  {url:'https://www.500.com/match',excerpt:text,origin:'editor-500',independent:true},
  {url:'https://www.sporttery.cn/match',excerpt:text,origin:'editor-sporttery',independent:true,preview:true}]};
 const {capture}=require('../scripts/captureDailySourceEvidence.cjs');
 const captured=await capture(request,{clock:()=>NOW,fetcher:async()=>new Response(`<html><body>${text}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}})});
 assert.ok(ev.valid(captured,fixture().decision,NOW));assert.equal(ev.facts(captured,fixture().decision,NOW)[1].status,'verified');
 const {contentHash:ignored,...copy}=structuredClone(captured);copy.facts[1].sources[1].origin=copy.facts[1].sources[0].origin;
 assert.equal(ev.valid(ev.seal(copy),fixture().decision,NOW),false);
 const {contentHash:ignored2,...stale}=structuredClone(captured);stale.facts[0]={...stale.facts[1],name:'伤停/停赛'};
 stale.facts[0].sources=stale.facts[0].sources.map(s=>({...s,publishedAt:new Date(NOW-3*86400000-1).toISOString()}));
 assert.equal(ev.valid(ev.seal(stale),fixture().decision,NOW),false);
 await assert.rejects(capture(request,{clock:()=>NOW,fetcher:async()=>new Response('<body>Different text.</body>',{headers:{'content-type':'text/html'}})}),/excerpt missing/);
});
test('90-minute result revision binds singles, exact score and combo legs independently',()=>{
 const {collectResults}=require('../scripts/recommendationPlatform/results.cjs');
 const a=candidate(1,2),b=candidate(2,3),asOf=NOW+86400000;
 const heads=collectResults([a,b].map(r=>({...r,scoreHome:1,scoreAway:0,resultRevision:1})),new Map(),{isFinal:()=>true,isVoid:()=>false},asOf).updates;
 const tier=p.chooseTiers([a,b],NOW)[0],combo=p.seal({version:p.VERSION,kind:'combo',id:'combo',businessDate:a.businessDate,...tier});
 const r=p.review([a,b],heads,asOf,[combo]);assert.equal(r.cumulative.won,2);assert.equal(r.cumulative.settled,2);assert.equal(r.cumulative.scoreTop1,2);assert.equal(r.combos[0].state,'WON');
 assert.ok(r.combos[0].legs.every(l=>l.resultEventId));
 const {contentHash,...comboBody}=combo;
 const untrusted=p.seal({...comboBody,legs:[{...tier.legs[0],contentHash:'b'.repeat(64)},tier.legs[1]]});
 assert.equal(p.review([a,b],heads,asOf,[untrusted]).combos[0].state,'DISPUTED');
});
test('real signed Repository -> decision -> bulletin -> immutable PG projection is nonempty and idempotent',async()=>{
 const {source,snapshot,NOW}=require('./fixtures/signed-live-had.cjs'),now=NOW+2*3600000;
 const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
 const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
 const m=source(1,now);m.probabilityModel.calculationTrace={poisson:{lambdas:{home:1.5,away:1}}};
 const signed=snapshot([m],{receivedAt:now-1000}),stored=new Map();let clock=now;
 const client={query:async(sql,args)=>{
  if(sql.includes('match_snapshots'))return {rows:[{payload:m}]};if(sql.includes('market_latest'))return {rows:[]};
  if(sql.includes('clock_timestamp()'))return {rows:[{now:new Date(clock+2)}]};
  if(sql.includes('count(*)::int'))return {rows:[{count:stored.size,bytes:[...stored.values()].reduce((n,r)=>n+r.payload_bytes,0),largest:Math.max(0,...[...stored.values()].map(r=>r.payload_bytes))}]};
  if(sql.startsWith('INSERT INTO football.private_model_artifacts')){const [key,version,generated,json,sha,bytes]=args;
   if(stored.has(key))return {rows:[]};stored.set(key,{artifact_key:key,artifact_version:version,generated_at:generated,updated_at:generated,payload_json:json,payload_sha256:sha,payload_bytes:bytes});return {rows:[{artifact_key:key}]};}
  if(sql.includes('private_model_artifacts'))return {rows:args?.length?[]:[...stored.values()]};throw Error('Unexpected query '+sql);
 }};
 const repo=new Repository(client,{clock:()=>clock,readOfficialSnapshot:()=>signed.snapshot,trustRegistry:signed.registry});
 const input=await repo.currentInputs(now);const d=makeDecision(input.current[0],{now,publication:{generationId:'g',manifestHash:'a'.repeat(64),committedAt:new Date(now).toISOString()},inputCapture:input.inputCapture,trustRegistry:signed.registry}).decision;
 assert.ok(d&&validDecision(d,{trustRegistry:signed.registry}));const before=JSON.stringify(d);
 const runtime=require('../scripts/recommendationPlatform/dailyBulletinRuntime.cjs');
 const initial=await runtime.projection(repo,{now,decisions:[d],heads:[]});assert.equal(initial.records.length,0);assert.equal(stored.size,1);
 const retired=await runtime.projection(repo,{now,decisions:[d],heads:[],readOnlyArchive:true});
 assert.equal(stored.size,1);assert.equal(retired.records.length,0); // No late ACK or new old-policy pick after cutover.
 const report=await runtime.projection(repo,{now,decisions:[d],heads:[]});assert.equal(report.records.length,1);assert.equal(report.records[0].matchNo,'周四001');
 assert.equal(report.records[0].selection.market,'HAD');assert.equal(stored.size,2);assert.equal(JSON.stringify(d),before);
 await runtime.projection(repo,{now,decisions:[d],heads:[]});assert.equal(stored.size,2);
 signed.snapshot.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].homeTeamAllName='changed';
 const safe=await runtime.projection(repo,{now,decisions:[d],heads:[]});assert.equal(safe.records.length,1);assert.equal(stored.size,2);
 // A first confirmation at or after cutoff cannot qualify a previous insert.
 for(const [key,row] of stored)if(JSON.parse(row.payload_json).kind==='ack')stored.delete(key);
 clock=Date.parse(report.records[0].cutoffAt);
 const late=await runtime.projection(repo,{now:clock,decisions:[d],heads:[]});assert.equal(late.records.length,0);assert.equal(late.review.cumulative.published,0);
});
