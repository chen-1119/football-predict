'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const ts=require(process.env.TYPESCRIPT_LIBRARY||'typescript');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recommendation-center-test-'));
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=fs.readFileSync(path.join(__dirname,'../src/services/recommendationCenterView.ts'),'utf8');
fs.writeFileSync(path.join(dir,'view.cjs'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
const view=require(path.join(dir,'view.cjs'));
const {parseRecommendationCenter,visiblePreview,primarySelectionSummary,comboLegSelection,handicapAnalysisBasis,calibrationSampleBasis,sameDirectionConcentration}=view;
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {match,memoryPorts,validators}=require('./recommendationFixture.cjs');
async function sample(){const p=memoryPorts();await createRuntime(p,{validators}).publishingCycle();return {recommendationCenter:p.state.view};}
test('the actual runtime projection parses for current UI',async()=>{const x=parseRecommendationCenter(await sample());assert.equal(x.current.length,3);assert.equal(x.previews.length,2);assert.equal(x.review.statistics.single.published,3);});
test('selection-quality EV must match the frozen published HAD probability and SP',async()=>{
 const payload=await sample(),row=payload.recommendationCenter.current[0];
 assert(Math.abs(row.selectionQuality.expectedValue-(row.decision.modelProbability*row.decision.odds-1))<1e-12);
 row.selectionQuality.expectedValue+=.05;
 assert.throws(()=>parseRecommendationCenter(payload),/Selection quality EV disagrees with frozen decision/);
});
test('same-direction warning counts all published directions, including watch rows, only for a real slate',async()=>{
 const rows=parseRecommendationCenter(await sample()).current;
 assert.equal(rows.length,3);
 const direction=rows[0].decision.tipCode;
 assert(rows.every(row=>row.decision.tipCode===direction));
 assert.deepEqual(sameDirectionConcentration(rows),{count:3,direction});
 assert.equal(sameDirectionConcentration(rows.slice(0,2)),null);
 assert.equal(sameDirectionConcentration(rows.map((row,index)=>index===2?{...row,decision:{...row.decision,tipCode:direction==='1'?'2':'1'}}:row)),null);
});
test('missing product field is a read error rather than an empty successful recommendation pool',()=>assert.throws(()=>parseRecommendationCenter({ok:true,previews:[],today:[]})));
test('invalid numbers are rejected before .toFixed',async()=>{for(const v of [null,'1.8',NaN,true]){const x=await sample();x.recommendationCenter.current[0].decision.odds=v;assert.throws(()=>parseRecommendationCenter(x));}});
test('a changed combo direction cannot be presented as the same decision',async()=>{const x=await sample();x.recommendationCenter.previews[0].legs[0].tipCode='2';assert.throws(()=>parseRecommendationCenter(x));});
test('each combo leg requires the exact decision ID',async()=>{const x=await sample();x.recommendationCenter.previews[0].decisionIds[0]='other';assert.throws(()=>parseRecommendationCenter(x));});
test('late publication timestamp rejects the row',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.publishedAt='2026-09-17T17:00:00Z';assert.throws(()=>parseRecommendationCenter(x));});
test('uncalibrated status cannot be disguised as a validated prediction',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.modelValidation='validated';assert.throws(()=>parseRecommendationCenter(x));});
test('wrong probability vector is rejected',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.probabilities['1']=.8;assert.throws(()=>parseRecommendationCenter(x));});
test('missing summary or contradictory counts fail instead of showing zero performance',async()=>{for(const apply of [x=>delete x.review.statistics.single,x=>x.review.statistics.single.won=999]){const x=await sample();apply(x.recommendationCenter);assert.throws(()=>parseRecommendationCenter(x));}});
test('hit rate is recomputed from audited counts, not trusted as another unrelated field',async()=>{const x=await sample();x.recommendationCenter.review.statistics.single.hitRate=1;assert.equal(parseRecommendationCenter(x).review.statistics.single.hitRate,null);});
test('preview becomes unavailable after cutoff or quote staleness',async()=>{const p=parseRecommendationCenter(await sample()).previews[0];assert.equal(visiblePreview(p,Date.parse('2026-09-17T14:00:00Z')),false);assert.equal(visiblePreview(p,Date.parse('2026-09-17T10:16:00Z')),false);});
test('settlement failure leaves visible publications and a separate stale-review state',async()=>{const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();p.faults.add('history');await r.settlementCycle();const x=parseRecommendationCenter({recommendationCenter:p.state.view});assert.equal(x.current.length,3);assert.equal(x.lanes.settlement.status,'error');});
test('frozen records remain parseable across midnight and retain bound IDs',async()=>{const p=memoryPorts();p.now=Date.parse('2026-09-17T13:00:00Z');p.current=[1,2,3].map(id=>match(id,p.now));const r=createRuntime(p,{validators});await r.publishingCycle();p.now=Date.parse('2026-09-17T17:00:00Z');await r.view();const x=parseRecommendationCenter({recommendationCenter:p.state.view});assert.equal(x.review.combos.length,2);assert.equal(x.todayCombos.length,0);});

test('handicap calibration profile is exposed even before groups become active',async()=>{const x=parseRecommendationCenter(await sample());assert.equal(x.review.handicapCalibration.version,'handicap-calibration-v2');assert.equal(typeof x.review.handicapCalibration.profileHash,'string');assert.equal(x.review.handicapCalibration.sampleRows,0);});
test('tampered handicap calibration profile is rejected by frontend parsing',async()=>{const x=await sample();x.recommendationCenter.review.handicapCalibration.profileHash='bad';assert.throws(()=>parseRecommendationCenter(x));});

test('top-card summary exposes the aligned handicap extension and supports older summary fixtures',()=>{
  const summary=primarySelectionSummary({tipCode:'1',odds:1.72,modelProbability:.61,handicapAnalysis:{tipCode:'X',handicapLine:-1,handicapLineText:'-1',modelProbability:.38,marketReference:{selectedOdds:3.45},historicalCalibration:{applied:true}}});
  assert.deepEqual(summary,{had:{code:'1',odds:1.72,probability:.61},handicap:{status:'recommend',code:'X',line:-1,lineText:'-1',probability:.38,odds:3.45,calibrated:true,conditional:false,overallCode:null,riskCode:null,riskProbability:null,suggestedCode:null,suggestedProbability:null}});
});
test('top-card summary keeps handicap slot explicitly unavailable when no handicap analysis exists',()=>{
  const summary=primarySelectionSummary({tipCode:'2',odds:2.1,modelProbability:.47,handicapAnalysis:null});
  assert.equal(summary.had.code,'2');assert.equal(summary.handicap,null);
});

test('top-card summary uses coherent companion direction even when standalone HHAD diagnostic differs',()=>{
  const summary=primarySelectionSummary({tipCode:'1',odds:1.6,modelProbability:.6,handicapAnalysis:{tipCode:'X',handicapLine:-1,handicapLineText:'-1',modelProbability:.7,probabilityBasis:'conditional-on-straight-primary',overallTipCode:'2',marketReference:null,historicalCalibration:{applied:false}}});
  assert.equal(summary.had.code,'1');assert.equal(summary.handicap.code,'X');assert.equal(summary.handicap.conditional,true);assert.equal(summary.handicap.overallCode,'2');
});

async function mixedSample(){
  const p=memoryPorts();
  p.current[0]={...p.current[0],handicapLine:1,handicapOdds:{odds1:1.65,oddsX:3.8,odds2:4.8},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(p.now).toISOString(),
    probabilityModel:{...p.current[0].probabilityModel,calculationTrace:{poisson:{lambdas:{home:1.7,away:.8}}}}};
  await createRuntime(p,{validators}).publishingCycle();
  return {recommendationCenter:p.state.view};
}
test('real mixed runtime projection uses frozen HHAD selection odds without changing parent HAD evidence',async()=>{
  const payload=await mixedSample(),x=parseRecommendationCenter(payload),c=x.previews.find(c=>c.size===2);
  assert.ok(c.selections.some(s=>s.market==='HHAD'));assert.ok(c.selections.some(s=>s.market==='HAD'));
  const i=c.selections.findIndex(s=>s.market==='HHAD'),pick=comboLegSelection(c,i);
  assert.equal(pick.handicapLine,1);assert.equal(pick.tipCode,'1');assert.equal(pick.odds,1.65);assert.equal(c.legs[i].odds,1.8);
  assert.equal(pick.probabilityBasis,'unconditional');assert.equal(pick.modelProbability,c.legs[i].handicapAnalysis.overallProbabilities[pick.tipCode]);
  assert.equal(c.totalOdds,2.97);assert.equal(c.legs[i].recordHash,x.current.find(r=>r.decision.decisionId===c.legs[i].decisionId).decision.recordHash);
});
test('mixed parser rejects conditional probability, wrong market line, changed quote and rebound selection',async()=>{
  const changes=[s=>s.probabilityBasis='conditional-on-straight-primary',s=>s.handicapLine=-1,s=>s.odds=1.8,s=>s.decisionRecordHash='0'.repeat(64),s=>s.quoteSource='sporttery:HAD',s=>s.quoteObservedAt='2026-09-17T09:59:00Z',s=>s.probabilities={'1':.55,X:.25,'2':.2}];
  for(const change of changes){const payload=await mixedSample(),c=payload.recommendationCenter.previews.find(c=>c.size===2),s=c.selections.find(s=>s.market==='HHAD');change(s);assert.throws(()=>parseRecommendationCenter(payload));}
  const payload=await mixedSample();payload.recommendationCenter.previews[0].selectionIds.pop();assert.throws(()=>parseRecommendationCenter(payload));
});
test('mixed preview expires by the selected HHAD quote even if parent HAD remains fresh',async()=>{
  const x=parseRecommendationCenter(await mixedSample()),c=x.previews.find(c=>c.selections.some(s=>s.market==='HHAD')),s=c.selections.find(s=>s.market==='HHAD');
  s.quoteObservedAt='2026-09-17T09:46:00Z';
  assert.equal(visiblePreview(c,Date.parse('2026-09-17T10:00:00Z')),true);
  assert.equal(visiblePreview(c,Date.parse('2026-09-17T10:02:00Z')),false);
});
test('legacy all-HAD combo remains readable and never borrows later handicap selections',async()=>{
  const payload=await sample();for(const c of payload.recommendationCenter.previews){c.version='unified-combo-v1';delete c.selections;delete c.selectionIds;c.rawTotalOdds=c.legs.reduce((p,l)=>p*l.odds,1);c.totalOdds=Number(c.rawTotalOdds.toFixed(2));}
  const c=parseRecommendationCenter(payload).previews[0];assert.equal(c.version,'unified-combo-v1');assert.equal(comboLegSelection(c,0).market,'HAD');assert.equal(comboLegSelection(c,0).odds,c.legs[0].odds);
});
test('conditional sample rate is distinct from full-cohort and both-directions rate',async()=>{
  const payload=await sample(),zero={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
  payload.recommendationCenter.review.statistics.handicapBreakdown={standaloneV1:zero,companionV2All:{...zero,published:4,settled:4,won:2,lost:2},companionV2WhenHadWon:{...zero,published:2,settled:2,won:1,lost:1},companionV2BothWon:{...zero,published:4,settled:4,won:1,lost:3}};
  const b=parseRecommendationCenter(payload).review.statistics.handicapBreakdown;assert.equal(b.companionV2All.hitRate,.5);assert.equal(b.companionV2WhenHadWon.hitRate,.5);assert.equal(b.companionV2BothWon.hitRate,.25);assert.equal(b.companionV2WhenHadWon.settled,2);
  payload.recommendationCenter.review.statistics.handicapBreakdown.companionV2BothWon.won=2;payload.recommendationCenter.review.statistics.handicapBreakdown.companionV2BothWon.lost=2;assert.throws(()=>parseRecommendationCenter(payload));
});
test('legacy narratives and calibration denominator retain their original probability basis',()=>{
  assert.equal(handicapAnalysisBasis({handicapAnalysis:{version:'handicap-margin-v1'}}),'unconditional');
  assert.equal(handicapAnalysisBasis({handicapAnalysis:{version:'handicap-margin-v3',probabilityBasis:'conditional-on-straight-primary'}}),'conditional');
  assert.equal(calibrationSampleBasis({version:'handicap-calibration-v1'}),'all');assert.equal(calibrationSampleBasis({version:'handicap-calibration-v2'}),'had-won');
});

function renderedText(data,props,now){
  const vm=require('node:vm'),module={exports:{}},react=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/recommendations/RecommendationCenter.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,Date:now==null?Date:class extends Date{static now(){return now;}},require:id=>{
    if(id==='react')return react;if(id==='react/jsx-runtime')return require(id);
    if(id==='./SelectionQualityNote')return require('./fixtures/selection-quality-note-module.cjs');
    if(id==='./DayCoverage')return {DayCoverage:()=>null};
    if(id==='./MarketComparison')return {MarketComparison:()=>null};
    if(id==='../../hooks/useRecommendationCenter')return {useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
    if(id==='../../hooks/useRecommendationReviewPage')return {useRecommendationReviewPage:filters=>{
      const source=filters.kind==='single'?data.review.singles:data.review.combos.filter(row=>row.combo.size===(filters.kind==='two'?2:3));
      const rows=source.slice((filters.page-1)*filters.pageSize,filters.page*filters.pageSize).map(row=>({...row,selectedMarket:'HAD',selectedSettlement:row.settlement,selectedOdds:row.decision?.odds||row.combo?.totalOdds,oddsState:'available',versionKey:'a'.repeat(64),versionLabel:'fixture'}));
      const summary=data.review.statistics[filters.kind==='single'?'single':filters.kind];
      return{data:{rows,total:source.length,page:filters.page,pageCount:Math.ceil(source.length/filters.pageSize),summary:{all:summary,windows:{last7:summary,last30:summary}},versions:[]},loading:false,failed:false,authorizationRequired:false,refresh:()=>{}};
    }};
    if(id==='../FollowButton')return {FollowButton:()=>null};
    if(id==='../TeamBadge')return {TeamBadge:({team})=>react.createElement('span',{'data-badge-name':team.name.zh})};
    if(id==='../../services/recommendationCenterView')return view;if(id==='./DualResearchV2')return {DualResearchV2:()=>null};if(id==='lucide-react')return {RefreshCw:()=>null,ChevronDown:()=>null,Search:()=>null,ArrowUpRight:()=>null};if(id.endsWith('.css'))return {};throw Error(id);
  }});
  return renderToStaticMarkup(react.createElement(module.exports.RecommendationCenter,{language:'zh',onSelectMatch:()=>{},...props}));
}
test('rendered mixed combo shows selected HHAD line and SP plus unconditional explanation',async()=>{
  const payload=await mixedSample(),c=payload.recommendationCenter.previews.find(c=>c.size===2);c.frozenAt=c.generatedAt;
  payload.recommendationCenter.review.combos=[{combo:c,settlement:{state:'PENDING'}}];
  const html=renderedText(parseRecommendationCenter(payload),{mode:'review',initialTab:'two'});
  assert.match(html,/让球胜平负<!-- --> \+1|让球胜平负 \+1/);assert.match(html,/SP 1\.65/);assert.match(html,/SP 2\.97/);assert.match(html,/完整让球概率中最高的方向/);assert.match(html,/sporttery:HHAD/);
});

function extensionDecision(straight,line,tip,probabilities){
  return {tipCode:straight,odds:1.8,modelProbability:.55,handicapAnalysis:{tipCode:tip,handicapLine:line,handicapLineText:line>0?'+'+line:String(line),modelProbability:probabilities?.[tip]??.6,probabilities,marketReference:{selectedOdds:2.5},historicalCalibration:{applied:false}}};
}
test('extension passes opposing home and away handicap risks without promoting the aligned runner-up',()=>{
  for(const [straight,line,tip,vector,alternative] of [
    ['1',-1,'2',{'1':.24,X:.32,'2':.44},'X'],
    ['1',-2,'2',{'1':.29,X:.25,'2':.46},'1'],
    ['2',1,'1',{'1':.41,X:.24,'2':.35},'2'],
    ['2',2,'1',{'1':.51,X:.29,'2':.2},'X'],
  ]){
    const d=extensionDecision(straight,line,tip,vector),before=JSON.stringify(d),h=primarySelectionSummary(d).handicap;
    assert.equal(h.status,'pass');assert.equal(h.code,null);assert.equal(h.probability,null);assert.equal(h.odds,null);
    assert.equal(h.riskCode,tip);assert.equal(h.riskProbability,vector[tip]);assert.equal(h.suggestedCode,alternative);
    assert.equal(JSON.stringify(d),before);assert.match(view.handicapExtensionText(h,'zh').title,/不追让球/);
  }
});
test('signed lines preserve draw and receiving-side mappings instead of using absolute handicap',()=>{
  for(const [straight,line,aligned] of [['X',-1,'2'],['X',2,'1'],['1',1,'1'],['2',-1,'2']]){
    const vector={'1':.2,X:.2,'2':.2};vector[aligned]=.6;
    assert.equal(primarySelectionSummary(extensionDecision(straight,line,aligned,vector)).handicap.status,'recommend');
    const opposite=aligned==='1'?'2':'1',risk={'1':.2,X:.2,'2':.2};risk[opposite]=.6;
    assert.equal(primarySelectionSummary(extensionDecision(straight,line,opposite,risk)).handicap.status,'pass');
  }
});
test('zero or unavailable alternative probability never creates a usable extension',()=>{
  for(const vector of [{'1':0,X:0,'2':1},undefined,{'1':NaN,X:-.1,'2':.8},{'1':Infinity,X:1.1,'2':.8}]){
    const h=primarySelectionSummary(extensionDecision('1',-1,'2',vector)).handicap;
    assert.equal(h.status,'pass');assert.equal(h.suggestedCode,null);assert.equal(h.suggestedProbability,null);
    assert.doesNotMatch(view.handicapExtensionText(h,'zh').detail,/同向备选/);
  }
});
test('conditional risk stays conditional even when the independent diagnostic prefers another side',()=>{
  const d=extensionDecision('1',-2,'2',{'1':.2,X:.3,'2':.5});Object.assign(d.handicapAnalysis,{version:'handicap-margin-v3',probabilityBasis:'conditional-on-straight-primary',overallTipCode:'1'});
  const h=primarySelectionSummary(d).handicap;
  assert.equal(h.status,'pass');assert.equal(h.riskCode,'2');assert.equal(h.overallCode,'1');
  assert.match(view.handicapExtensionText(h,'zh').detail,/条件模型偏 让负 50.0%/);
  assert.match(view.handicapExtensionText(h,'en').detail,/Conditional model leans Handicap away 50.0%/);
});
function renderPublished(row,compact,language='zh'){
  const vm=require('node:vm'),module={exports:{}},react=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/recommendations/PublishedMatchPick.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const modelModule={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/publishedMatchRecommendation.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module:modelModule,exports:modelModule.exports,Date});
  vm.runInNewContext(code,{module,exports:module.exports,Date,Intl,require:id=>{
    if(id==='react/jsx-runtime')return require(id);if(id==='../../services/recommendationCenterView')return view;
    if(id==='./SelectionQualityNote')return require('./fixtures/selection-quality-note-module.cjs');
    if(id==='../../services/publishedMatchRecommendation')return modelModule.exports;if(id.endsWith('.css'))return {};throw Error(id);
  }});
  return renderToStaticMarkup(react.createElement(module.exports.PublishedMatchPick,{row,language,compact,now:Date.parse(row.decision.publishedAt)}));
}
test('real v3 narrow-win record renders the same pass in recommendation, fixture and detail without changing frozen evidence',async()=>{
  const p=memoryPorts();p.current[0]={...p.current[0],handicapLine:-2,handicapOdds:{odds1:4.6,oddsX:4.0,odds2:1.6},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(p.now).toISOString(),probabilityModel:{...p.current[0].probabilityModel,calculationTrace:{poisson:{lambdas:{home:1.2,away:.5}}}}};
  await createRuntime(p,{validators}).publishingCycle();const payload={recommendationCenter:p.state.view};
  const frozen=payload.recommendationCenter.previews.find(c=>c.selections.some(s=>s.market==='HHAD'));
  assert.ok(frozen);frozen.frozenAt=frozen.generatedAt;payload.recommendationCenter.review.combos=[{combo:frozen,settlement:{state:'PENDING'}}];
  const data=parseRecommendationCenter(payload),row=data.current[0],h=row.decision.handicapAnalysis;
  assert.equal(h.version,'handicap-margin-v3');assert.equal(h.tipCode,'2');assert.equal(primarySelectionSummary(row.decision).handicap.status,'pass');
  const before=JSON.stringify(data),copy=view.handicapExtensionText(primarySelectionSummary(row.decision).handicap,'zh');
  for(const html of [renderedText(data,{},p.now),renderPublished(row,true),renderPublished(row,false)]){
    assert.ok(html.includes(copy.title));assert.ok(html.includes(copy.detail));assert.match(html,/data-handicap-extension="pass"/);
    assert.ok(html.includes(row.decision.decisionId));assert.ok(html.includes(row.decision.recordHash));
  }
  const detailed=renderedText(data,{},p.now);assert.match(detailed,/窄胜风险/);assert.match(detailed,/完整三项概率及赛果保留原记录/);
  const combo=renderedText(data,{mode:'review',initialTab:frozen.size===2?'two':'three'});
  assert.match(combo,/让球胜平负<!-- --> -2|让球胜平负 -2/);assert.match(combo,/SP 1\.60/);
  assert.equal(JSON.stringify(data),before);
});
