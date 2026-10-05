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
const view=compile('../src/services/recommendationCenterView.ts');
const presentation=compile('../src/services/publishedDetailPresentation.ts');
const {SupplementaryResearchNote,SelectionQualityNote}=compile('../src/components/recommendations/SelectionQualityNote.tsx');
const {PublishedMatchPick}=compile('../src/components/recommendations/PublishedMatchPick.tsx');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
const {selectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {selectionFor}=require('../scripts/recommendationPlatform/comboSelections.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
// Probability vector and lambdas from the 2026-10-05 online France observation.
// Fixture prices exercise the HHAD-available branch separately from its later expiry.
function row({line=-1,probabilities={home:45.6,draw:26.4,away:28},available=true,policy='coherent-market-primary-v1'}={}){
 const source=match(2041806,NOW,{homeTeamName:'法国',awayTeamName:'比利时',odds:{odds1:1.32,oddsX:4.6,odds2:6.3},
  handicapLine:line,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:available?'sporttery:HHAD':'unknown',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
  probabilityModel:{version:'online-france-ui-regression',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.7175127632029212,away:1.3237417615322957}}}}});
 const d=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:policy}).decision;assert(d);
 return {decision:d,settlement:{state:'PENDING'},scoreDistribution:buildPublishedScoreDistribution(d)};
}
function payload(r){
 const summary={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
 return {recommendationCenter:{version:'recommendation-center-v1',updatedAt:r.decision.publishedAt,businessDate:r.decision.businessDate,inputAsOf:null,resultAsOf:null,
  lanes:{},current:[r],previews:[],todayCombos:[],overlapDecisionIds:[],review:{singles:[],combos:[],limit:0,statistics:{single:summary,two:summary,three:summary},definition:'test'},excludedCorruptRecords:0,modelValidation:'unvalidated'}};
}
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));

test('France HHAD primary and HAD companion keep unconditional probabilities and expose the conditional denominator',()=>{
 const r=row(),d=r.decision,before=JSON.stringify(r);assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
 const markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:NOW});
 assert(markup.indexOf('让球 · 主方向')<markup.indexOf('胜平负 · 伴随方向'));
 assert.match(markup,/主队让1球（-1）/);assert.match(markup,/无条件概率 54\.4%/);assert.match(markup,/无条件概率 28\.0%/);
 assert.match(markup,/伴随方向条件占比 51\.5%/);assert.match(markup,/不是实际命中率/);assert.equal(JSON.stringify(r),before);
});

test('aligned score reference and frozen global mode have distinct labels and preserve the research settlement',()=>{
 const r=row(),before=JSON.stringify(r),aligned=r.scoreDistribution.alignedScores[0];assert.notEqual(aligned.label,'1-1');
 const markup=render(SupplementaryResearchNote,{decision:r.decision,scoreDistribution:r.scoreDistribution,research:r.decision.supplementaryResearch,language:'zh',settlement:{exactScore:{state:'WON'},totalGoals:{state:'LOST'}}});
 assert.match(markup,new RegExp(`同向比分参考 ${aligned.label}`));assert.match(markup,/全局比分分布参考.*1-1.*12\.1%.*命中/);
 assert.match(markup,/总进球分布最高项.*2.*23\.0%.*未命中/);assert.doesNotMatch(markup,/唯一首选|比分首选/);
 assert.match(markup,/同向比分不另计命中率/);assert.equal(JSON.stringify(r),before);
});

test('compact cards keep the aligned reference visible and collapse global distribution and conditional explanations',()=>{
 const r=row(),markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:NOW});
 assert.match(markup,/<details><summary>查看分布参考<\/summary>/);
 assert(markup.indexOf('同向比分参考')<markup.indexOf('查看分布参考'));
 assert(markup.indexOf('查看分布参考')<markup.indexOf('全局比分分布参考'));
 assert.match(markup,/<details class="published-match-pick__probability-basis"><summary>/);
 assert.doesNotMatch(markup,/<details[^>]*\bopen[\s=>]/);assert.match(markup,/低置信参考/);
});

test('coherent missing, null, wrong-bound and empty aligned projections never borrow legacy scores',()=>{
 const r=row(),legacy=[{home:0,away:1,label:'0-1',probability:90}];
 for(const bound of [undefined,null,{...r.scoreDistribution,recordHash:'f'.repeat(64)},{...r.scoreDistribution,alignedScores:[]}]){
  const result=presentation.publishedDetailPresentation(r.decision,legacy,bound);assert.equal(result.primaryScore,null);
  const markup=render(SupplementaryResearchNote,{decision:r.decision,scoreDistribution:bound,research:r.decision.supplementaryResearch,language:'zh'});
  assert.match(markup,/同向比分参考.*暂不可用/);assert.match(markup,/全局比分分布参考.*1-1/);assert.doesNotMatch(markup,/90\.0%/);
 }
});

test('HAD and both signs retain compatible score scenarios without promoting the HHAD marginal leader',()=>{
 for(const line of [-2,-1,1,2]){
  const r=row({line,probabilities:line<0?{home:80,draw:12,away:8}:{home:8,draw:12,away:80}}),summary=view.primarySelectionSummary(r.decision);
  assert.equal(r.decision.coherentPrimary.anchorMarket,'HAD');
  assert.equal(summary.handicap.probability,r.decision.handicapAnalysis.overallProbabilities[r.decision.coherentPrimary.hhadCode]);
  const detail=presentation.publishedDetailPresentation(r.decision,[],r.scoreDistribution);assert(detail.primaryScore);
  assert.equal(detail.primaryScore.label,r.scoreDistribution.alignedScores[0].label);
  assert.match(view.handicapLineLabel(line,true),new RegExp(line<0?'主队让':'主队受让'));
 }
});

test('missing HHAD market has no companion claim while an independent archive keeps its global score',()=>{
 const absent=row({available:false}),markup=render(PublishedMatchPick,{row:absent,language:'zh',now:NOW});
 assert.match(markup,/让球 · 暂不可用/);assert.doesNotMatch(markup,/伴随方向条件占比/);
 const old=row({policy:'independent-market-primary-v1'}),before=JSON.stringify(old);
 assert.equal(presentation.publishedDetailPresentation(old.decision,[],old.scoreDistribution).primaryScore.label,old.scoreDistribution.topScores[0].label);
 const oldMarkup=render(SupplementaryResearchNote,{decision:old.decision,scoreDistribution:old.scoreDistribution,research:old.decision.supplementaryResearch,language:'zh'});
 assert.match(oldMarkup,/全局比分分布参考/);assert.doesNotMatch(oldMarkup,/同向比分参考/);assert.equal(JSON.stringify(old),before);
});

test('current quality scope binds EV to HHAD anchor while unscoped historic HAD quality remains unchanged',()=>{
 const r=row(),d=r.decision,anchor=selectionFor(d,'HHAD');
 const q={...selectionQuality(d,anchor),assessmentBasis:'coherent-primary-anchor-v1'};
 const parsed=view.parseRecommendationCenter(payload({...r,selectionQuality:q})).current[0].selectionQuality;
 assert.equal(parsed.assessedMarket,'HHAD');assert.equal(parsed.expectedValue,.544*2.74-1);
 assert.match(render(SelectionQualityNote,{quality:parsed,language:'zh'}),/主方向筛选（让球）/);
 const legacy=view.parseRecommendationCenter(payload({...r,selectionQuality:selectionQuality(d)})).current[0].selectionQuality;
 assert.equal(legacy.assessmentBasis,undefined);assert.equal(legacy.expectedValue,.28*6.3-1);
 for(const q2 of [{...q,expectedValue:legacy.expectedValue},{...q,assessmentBasis:'unknown'}])assert.throws(()=>view.parseRecommendationCenter(payload({...r,selectionQuality:q2})));
});

test('empty combo evidence reports existing overlapping counts and supplied reasons without inventing SP failures',()=>{
 const d={businessDate:'2026-10-05',lanes:{combos:{candidateCount:0,referenceCount:7,watchCount:7}},coverage:{businessDate:'2026-10-05',hasMore:false,missing:[{homeTeamName:'法国',awayTeamName:'比利时',reasonText:'模型与同期官方市场差异过大，仅供观望'}]}};
 const v=view.comboEligibilityEvidence(d,true);assert.equal(v.summary,'合格候选 0 · 参考 7 · 观察 7');assert.equal(v.reasons.length,1);assert.match(v.reasons[0],/差异过大/);assert.doesNotMatch(v.summary+v.reasons.join(''),/SP|新场次/);
 assert.equal(view.comboEligibilityEvidence({...d,coverage:{...d.coverage,businessDate:'2026-10-04'}},true).reasons.length,0);
 assert.equal(view.comboEligibilityEvidence(undefined,true).summary,'');
});

if(process.env.ONLINE_RECOMMENDATION_INPUT)test('saved online publications render bound aligned scores without changing any frozen record',()=>{
 const bytes=fs.readFileSync(process.env.ONLINE_RECOMMENDATION_INPUT),input=JSON.parse(bytes),rows=input.center?.current||input.postgres?.center?.current;
 assert(Array.isArray(rows)&&rows.length===7);const evidence=[];
 for(const raw of rows){
  const before=JSON.stringify(raw),r=view.parseRecommendationCenter(payload(raw)).current[0];
  const detail=presentation.publishedDetailPresentation(r.decision,[],r.scoreDistribution);
  const markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:Date.parse(input.observedAt)});
  assert.equal(detail.scoreSource,'published-matrix');assert(detail.primaryScore);assert.match(markup,new RegExp(`同向比分参考 ${detail.primaryScore.label}`));
  assert.equal(detail.primaryScore.label,r.scoreDistribution.alignedScores[0].label);assert.doesNotMatch(markup,/比分与进球数 · 唯一首选|比分首选/);
  assert.equal(JSON.stringify(raw),before);
  evidence.push({decisionId:r.decision.decisionId,recordHash:r.decision.recordHash,home:r.decision.homeTeamName,away:r.decision.awayTeamName,
   anchor:r.decision.coherentPrimary.anchorMarket,alignedScore:detail.primaryScore,globalScore:detail.globalScores[0],frozenResearchUnchanged:true});
 }
 if(process.env.UI_EVIDENCE_OUTPUT)fs.writeFileSync(process.env.UI_EVIDENCE_OUTPUT,JSON.stringify({sourceSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),sourceObservedAt:input.observedAt,checkedAt:new Date().toISOString(),renderingMode:'React static markup, not browser or deployment verification',rows:evidence},null,2));
});
