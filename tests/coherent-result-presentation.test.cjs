'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createRequire}=require('node:module'),cache=new Map();
function compile(file){
 const absolute=require.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const module={exports:{}};cache.set(absolute,module);const native=createRequire(absolute);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,Intl,Set,require:id=>{
  if(id.endsWith('.css'))return {};
  if(id.startsWith('.'))for(const ext of ['.ts','.tsx']){const dependency=path.resolve(path.dirname(absolute),id+ext);if(fs.existsSync(dependency))return compile(dependency);}
  return native(id);
 }},{filename:absolute});return module.exports;
}
const {publishedResultProjection,publishedResultLabel,settlementResultLabel}=compile('../src/services/publishedMatchRecommendation.ts');
const {PublishedMatchPick}=compile('../src/components/recommendations/PublishedMatchPick.tsx');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');

function row({policy='coherent-market-primary-v1',probabilities={home:45.6,draw:26.4,away:28},available=true}={}){
 const source=match(2041806,NOW,{homeTeamName:'法国',awayTeamName:'比利时',odds:{odds1:1.32,oddsX:4.6,odds2:6.3},
  handicapLine:-1,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:available?'sporttery:HHAD':'unknown',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
  probabilityModel:{version:'coherent-result-ui-regression',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.7175127632029212,away:1.3237417615322957}}}}});
 const decision=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:policy}).decision;assert(decision);
 return {decision,settlement:{state:'LOST',score:'1-1',actual:'X',resultEventId:'france-belgium-1-1'},
  handicapSettlement:{state:'WON',score:'1-1',actual:'2',resultEventId:'france-belgium-1-1'}};
}
function assertProjection(result,{coherent,primaryMarket,primarySettlement,companionMarket=null,companionSettlement=null,displayedMarket=primaryMarket,displayedSettlement=primarySettlement,explicitMarket=false}){
 assert.equal(result.coherent,coherent);assert.equal(result.primary.market,primaryMarket);assert.strictEqual(result.primary.settlement,primarySettlement);
 if(companionMarket===null)assert.equal(result.companion,null);
 else {assert.equal(result.companion.market,companionMarket);assert.strictEqual(result.companion.settlement,companionSettlement);}
 assert.equal(result.displayed.market,displayedMarket);assert.strictEqual(result.displayed.settlement,displayedSettlement);assert.equal(result.explicitMarket,explicitMarket);
}
const render=r=>renderToStaticMarkup(React.createElement(PublishedMatchPick,{row:r,language:'zh',now:NOW}));
function renderedResults(markup){
 const start=markup.indexOf('class="published-match-pick__result"');assert(start>=0,'actual PublishedMatchPick must render its result area');
 const end=markup.indexOf('<details',start);
 return markup.slice(start,end<0?undefined:end).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
}

test('France 1-1 displays the won HHAD primary and retains the lost HAD companion',()=>{
 const r=row(),before=JSON.stringify(r);assert.equal(r.decision.coherentPrimary.anchorMarket,'HHAD');assert.equal(r.decision.coherentPrimary.hhadCode,'2');assert.equal(r.decision.tipCode,'2');
 const result=publishedResultProjection(r);
 assertProjection(result,{coherent:true,primaryMarket:'HHAD',primarySettlement:r.handicapSettlement,companionMarket:'HAD',companionSettlement:r.settlement});
 assert.equal(publishedResultLabel(r,'zh'),'命中');assert.equal(publishedResultLabel(r,'en'),'Won');assert.equal(JSON.stringify(r),before);
});

test('result projection follows the selected primary even when its state is lost and HAD is won',()=>{
 // Deliberately synthetic states: this isolates projection, not score settlement.
 const r=row();r.handicapSettlement={state:'LOST'};r.settlement={state:'WON'};
 const before=JSON.stringify(r),result=publishedResultProjection(r);
 assertProjection(result,{coherent:true,primaryMarket:'HHAD',primarySettlement:r.handicapSettlement,companionMarket:'HAD',companionSettlement:r.settlement});
 assert.equal(publishedResultLabel(r,'zh'),'未命中');assert.equal(publishedResultLabel(r,'en'),'Lost');assert.equal(JSON.stringify(r),before);
});

test('missing HHAD result stays awaiting verification instead of borrowing the HAD result',()=>{
 for(const missing of [undefined,null]){
  const r=row();r.settlement={state:'WON',score:'1-1'};
  if(missing===undefined)delete r.handicapSettlement;else r.handicapSettlement=missing;
  const before=JSON.stringify(r),result=publishedResultProjection(r);
  assertProjection(result,{coherent:true,primaryMarket:'HHAD',primarySettlement:null,companionMarket:'HAD',companionSettlement:r.settlement});
  assert.equal(publishedResultLabel(r,'zh'),settlementResultLabel(null,'zh'));assert.match(publishedResultLabel(r,'zh'),/待核/);
  assert.notEqual(publishedResultLabel(r,'zh'),'命中');assert.equal(JSON.stringify(r),before);
 }
});

test('explicit HAD and HHAD filters select that market without changing the coherent roles',()=>{
 for(const probabilities of [{home:45.6,draw:26.4,away:28},{home:80,draw:12,away:8}]){
  const r=row({probabilities}),primaryMarket=r.decision.coherentPrimary.anchorMarket,companionMarket=primaryMarket==='HAD'?'HHAD':'HAD',before=JSON.stringify(r);
  for(const market of ['HAD','HHAD']){
   const result=publishedResultProjection(r,market),settlement=market==='HAD'?r.settlement:r.handicapSettlement;
   assertProjection(result,{coherent:true,primaryMarket,primarySettlement:primaryMarket==='HAD'?r.settlement:r.handicapSettlement,
    companionMarket,companionSettlement:companionMarket==='HAD'?r.settlement:r.handicapSettlement,displayedMarket:market,displayedSettlement:settlement,explicitMarket:true});
   assert.equal(publishedResultLabel(r,'zh',market),settlementResultLabel(settlement,'zh'));
  }
  assert.equal(JSON.stringify(r),before);
 }
});

test('a HAD primary displays its HAD settlement and keeps HHAD as its companion',()=>{
 const r=row({probabilities:{home:80,draw:12,away:8}});assert.equal(r.decision.coherentPrimary.anchorMarket,'HAD');
 assertProjection(publishedResultProjection(r),{coherent:true,primaryMarket:'HAD',primarySettlement:r.settlement,companionMarket:'HHAD',companionSettlement:r.handicapSettlement});
 assert.equal(publishedResultLabel(r,'zh'),'未命中');
});

test('an unavailable coherent HHAD direction creates no companion and an explicit HHAD result cannot fall back',()=>{
 const r=row({available:false});delete r.handicapSettlement;assert.equal(r.decision.coherentPrimary.anchorMarket,'HAD');assert.equal(r.decision.coherentPrimary.hhadCode,null);
 assertProjection(publishedResultProjection(r),{coherent:true,primaryMarket:'HAD',primarySettlement:r.settlement});
 assertProjection(publishedResultProjection(r,'HHAD'),{coherent:true,primaryMarket:'HAD',primarySettlement:r.settlement,displayedMarket:'HHAD',displayedSettlement:null,explicitMarket:true});
 assert.equal(publishedResultLabel(r,'zh','HHAD'),settlementResultLabel(null,'zh'));
});

test('legacy and unknown policies retain HAD defaults even if coherent metadata is present',()=>{
 const r=row(),coherentPrimary=r.decision.coherentPrimary;
 for(const policy of [undefined,'independent-market-primary-v1','coherent-market-primary-v2']){
  const legacy={...r,decision:{...r.decision,primaryPickPolicyVersion:policy,coherentPrimary}},before=JSON.stringify(legacy);
  assertProjection(publishedResultProjection(legacy),{coherent:false,primaryMarket:'HAD',primarySettlement:legacy.settlement});
  assert.equal(publishedResultLabel(legacy,'zh'),'未命中');
  assertProjection(publishedResultProjection(legacy,'HHAD'),{coherent:false,primaryMarket:'HAD',primarySettlement:legacy.settlement,displayedMarket:'HHAD',displayedSettlement:legacy.handicapSettlement,explicitMarket:true});
  assert.equal(publishedResultLabel(legacy,'zh','HHAD'),'命中');assert.equal(JSON.stringify(legacy),before);
 }
});

test('only HAD and HHAD are explicit result market selections',()=>{
 const r=row();
 for(const invalid of [undefined,null,'','Hhad','TOTAL_GOALS','SCORE']){
  assertProjection(publishedResultProjection(r,invalid),{coherent:true,primaryMarket:'HHAD',primarySettlement:r.handicapSettlement,companionMarket:'HAD',companionSettlement:r.settlement});
  assert.equal(publishedResultLabel(r,'zh',invalid),'命中');
 }
});

test('result labels distinguish no publication, missing result, and every recorded settlement state',()=>{
 assert.equal(publishedResultProjection(null),null);assert.equal(publishedResultLabel(null,'zh'),'待发布');assert.equal(publishedResultLabel(null,'en'),'Awaiting publication');assert.match(settlementResultLabel(null,'zh'),/待核/);
 for(const [state,zh,en] of [['PENDING','待赛果','Pending'],['WON','命中','Won'],['LOST','未命中','Lost'],['VOID','无效','Void'],['DISPUTED','赛果待核','Disputed']]){
  assert.equal(settlementResultLabel({state},'zh'),zh);assert.equal(settlementResultLabel({state},'en'),en);
 }
});

test('actual PublishedMatchPick labels both coherent markets with their own 1-1 outcomes',()=>{
 const r=row(),before=JSON.stringify(r),text=renderedResults(render(r));
 assert.match(text,/让球\s*·\s*主方向[：:]\s*命中(?:\s|·|$)/);
 assert.match(text,/胜平负\s*·\s*伴随方向[：:]\s*未命中(?:\s|$)/);
 assert.match(text,/1-1/);assert(text.indexOf('让球')<text.indexOf('胜平负'));assert.equal(JSON.stringify(r),before);
});

test('actual PublishedMatchPick keeps a missing HHAD primary unresolved beside a known HAD result',()=>{
 const r=row();delete r.handicapSettlement;r.settlement={state:'WON',score:'1-1'};
 const text=renderedResults(render(r));assert.match(text,/让球\s*·\s*主方向[：:]\s*[^\s]*待核/);assert.match(text,/胜平负\s*·\s*伴随方向[：:]\s*命中(?:\s|$)/);assert.doesNotMatch(text,/1-1/);
});

test('required evidence scanner rejects fixed-HAD results, missing version guards and detached market-role rendering',()=>{
 const checker=path.resolve(__dirname,'../scripts/verifyFrontendEvidenceSemantics.cjs'),code=fs.readFileSync(checker,'utf8');
 const checkName='published settlement is tied to record state while legacy references stay observational';
 const evaluate=mutation=>{
  let result;const processStub={exitCode:0},native=createRequire(checker);
  const sourceFs={...fs,readFileSync(file,...args){
   const data=fs.readFileSync(file,...args);
   if(!mutation||path.resolve(String(file))!==path.resolve(__dirname,'..',mutation[0]))return data;
   assert.equal(typeof data,'string');assert(data.includes(mutation[1]),'mutation must alter an existing binding');
   return data.replace(mutation[1],mutation[2]);
  }};
  vm.runInNewContext(code,{__dirname:path.dirname(checker),require:id=>id==='node:fs'?sourceFs:native(id),console:{log:value=>{result=JSON.parse(value);}},process:processStub});
  return{result,exitCode:processStub.exitCode};
 };
 const baseline=evaluate(null);assert.equal(baseline.result.ok,true);assert.equal(baseline.exitCode,0);
 for(const mutation of [
  ['src/services/publishedMatchRecommendation.ts',"primaryPickPolicyVersion==='coherent-market-primary-v1'","primaryPickPolicyVersion!=null"],
  ['src/services/publishedMatchRecommendation.ts','row.handicapSettlement??null','row.handicapSettlement??row.settlement'],
  ['src/services/publishedMatchRecommendation.ts','displayed:explicitMarket?resultFor(selectedMarket):primary','displayed:primary'],
  ['src/components/recommendations/RecommendationCenter.tsx','const selected=result.displayed.settlement','const selected=settlement'],
  ['src/components/recommendations/PublishedMatchPick.tsx','primaryMarketLabel(d,result.primary.market,zh)',"primaryMarketLabel(d,'HAD',zh)"],
  ['src/pages/PredictionsList.tsx','unifiedResult?.primary.settlement?.state','unifiedRow?.settlement.state'],
 ]){
  const changed=evaluate(mutation);assert.equal(changed.exitCode,1);assert.equal(changed.result.checks.find(item=>item.name===checkName).ok,false,mutation[0]);
 }
});
