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
const {SupplementaryResearchNote,SelectionQualityNote,PublishedHadDistribution}=compile('../src/components/recommendations/SelectionQualityNote.tsx');
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
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function globalScoreRows(markup){
 const list=markup.match(/<ol\b[^>]*data-score-reference="global-top3"[^>]*>([\s\S]*?)<\/ol>/);
 return list?[...list[1].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)].map(([,attributes,body])=>({
  label:attributes.match(/data-score-label="([^"]+)"/)?.[1],compatible:attributes.match(/data-primary-compatible="([^"]+)"/)?.[1],text:plain(body)
 })):[];
}
function expectedTopScores(r){
 const c=r.decision.primaryPickPolicyVersion==='coherent-market-primary-v1'?r.decision.coherentPrimary:null;
 return r.scoreDistribution.topScores.slice(0,3).map(score=>({...score,probability:score.probability*100,primaryCompatible:c
  ? (c.anchorMarket==='HAD'?score.hadCode:score.hhadCode)===c.anchorCode:null}));
}
function assertGlobalScores(markup,expected){
 const actual=globalScoreRows(markup);assert.equal(actual.length,expected.length);
 expected.forEach((score,index)=>{assert.equal(actual[index].label,score.label);assert.equal(actual[index].compatible,score.primaryCompatible===null?'unknown':String(score.primaryCompatible));
  assert(actual[index].text.includes(`${score.probability.toFixed(1)}%`));assert.match(actual[index].text,/无条件概率/);
  assert.match(actual[index].text,score.primaryCompatible===null?/主方向关系待核/:score.primaryCompatible?/符合主方向/:/不符合主方向/);
 });
}
function assertHadDistribution(markup,decision){
 const section=markup.match(/<section\b[^>]*data-had-distribution="unconditional"[^>]*>([\s\S]*?)<\/section>/);assert(section,'the complete HAD distribution must be visible');
 for(const [code,label] of [['1','主胜'],['X','平局'],['2','客胜']]){
  const item=section[1].match(new RegExp(`<span[^>]*data-had-code="${code}"[^>]*>([\\s\\S]*?)<\\/span>`));assert(item);assert.equal(plain(item[1]),`${label} ${(decision.probabilities[code]*100).toFixed(1)}%`);
 }
 assert.match(plain(section[1]),/无条件概率.*未校准/);
}

test('France keeps its HHAD primary, labels HAD as a conditional branch, and exposes all three HAD probabilities',()=>{
 const r=row(),d=r.decision,before=JSON.stringify(r);assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
 const markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:NOW});
 assert(markup.indexOf('让球 · 主方向')<markup.indexOf('胜平负 · 条件分支'));
 assert.match(markup,/主队让1球（-1）/);assert.match(markup,/无条件概率 54\.4%/);assert.match(markup,/无条件概率 28\.0%/);
 assert(markup.includes(`冻结条件分支占比 ${(d.coherentPrimary.companionConditionalProbability*100).toFixed(2)}%`));
 assert.match(markup,/不是独立推荐/);assert.match(markup,/接近一半的占比不代表明显优势/);assert.match(markup,/不是实际命中率/);
 assertHadDistribution(markup,d);assert.equal(JSON.stringify(r),before);
});

test('global Top 3 preserves unconditional rank and treats France 1-1 as compatible with HHAD -1 away despite its HAD branch',()=>{
 const r=row(),before=JSON.stringify(r),detail=presentation.publishedDetailPresentation(r.decision,[],r.scoreDistribution),expected=expectedTopScores(r);
 assert.equal(expected[0].label,'1-1');assert.equal(expected[0].hadCode,'X');assert.equal(r.decision.tipCode,'2');assert.equal(expected[0].primaryCompatible,true);
 assert.notEqual(detail.primaryScore.label,'1-1','archived both-direction alignment retains its old semantics');
 expected.forEach((score,index)=>{assert.equal(detail.globalTopScores[index].label,score.label);assert.equal(detail.globalTopScores[index].probability,score.probability);assert.equal(detail.globalTopScores[index].primaryCompatible,score.primaryCompatible);});
 const settlement={exactScore:{state:'WON'},totalGoals:{state:'LOST'}},frozenBefore=JSON.stringify(settlement);
 const markup=render(SupplementaryResearchNote,{decision:r.decision,scoreDistribution:r.scoreDistribution,research:r.decision.supplementaryResearch,language:'zh',settlement});
 assertGlobalScores(markup,expected);const detailsAt=markup.indexOf('<details');assert(detailsAt>0);assertGlobalScores(markup.slice(0,detailsAt),expected);
 assert.doesNotMatch(markup.slice(0,detailsAt),/data-score-reference="aligned"|data-score-reference="frozen-research"/);
 assert.match(markup.slice(detailsAt),/双方向同时成立的比分示例/);assert.match(markup.slice(detailsAt),/原冻结全局比分研究.*1-1.*12\.1%.*命中/);
 assert.match(markup.slice(detailsAt),/原冻结总进球研究.*2.*23\.0%.*未命中/);assert.match(markup,/不改为 Top 3 或同向范围命中/);
 assert.equal(JSON.stringify(r),before);assert.equal(JSON.stringify(settlement),frozenBefore);
});

test('compact cards keep global Top 3 visible and collapse aligned scenarios and original research settlement',()=>{
 const r=row(),markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:NOW});
 const research=markup.slice(markup.indexOf('class="supplementary-research-note"')),detailsAt=research.indexOf('<details');
 assertGlobalScores(research.slice(0,detailsAt),expectedTopScores(r));assert.match(research,/<details><summary>查看冻结同向比分与原研究结算<\/summary>/);
 assert.doesNotMatch(research.slice(0,detailsAt),/data-score-reference="aligned"/);
 assert.match(markup,/<details class="published-match-pick__probability-basis"><summary>/);
 assert.doesNotMatch(markup,/<details[^>]*\bopen[\s=>]/);assert.match(markup,/低置信 · 未校准/);
});

test('coherent missing, null, wrong-bound and invalid projections never fill Top 3 from legacy or frozen study picks',()=>{
 const r=row(),legacy=[{home:0,away:1,label:'0-1',probability:90}];
 for(const bound of [undefined,null,{...r.scoreDistribution,status:'unavailable'},{...r.scoreDistribution,recordHash:'f'.repeat(64)},
  {...r.scoreDistribution,decisionId:'wrong-decision'},{...r.scoreDistribution,topScores:[{...r.scoreDistribution.topScores[0],probability:1.1}]}]){
  const result=presentation.publishedDetailPresentation(r.decision,legacy,bound);assert.equal(result.primaryScore,null);assert.equal(result.globalTopScores.length,0);
  const markup=render(SupplementaryResearchNote,{decision:r.decision,scoreDistribution:bound,research:r.decision.supplementaryResearch,language:'zh'});
  assert.equal(globalScoreRows(markup).length,0);assert.match(markup,/同源冻结比分暂不可用/);assert.match(markup,/原冻结全局比分研究.*1-1/);assert.doesNotMatch(markup,/90\.0%/);
  assert.doesNotMatch(markup.slice(0,markup.indexOf('<details')),/1-1/,'the frozen research pick must remain in archive details, not replace missing Top 3');
 }
});

test('an empty aligned subset does not suppress a valid global Top 3',()=>{
 const r=row(),bound={...r.scoreDistribution,alignedScores:[]},detail=presentation.publishedDetailPresentation(r.decision,[],bound);
 assert.equal(detail.primaryScore,null);assert.equal(detail.globalTopScores.length,3);
 assertGlobalScores(render(SupplementaryResearchNote,{decision:r.decision,scoreDistribution:bound,research:r.decision.supplementaryResearch,language:'zh'}),expectedTopScores(r));
});

test('HAD anchors and both handicap signs mark global compatibility against the primary alone without changing archived alignment',()=>{
 for(const line of [-2,-1,1,2]){
  const r=row({line,probabilities:line<0?{home:80,draw:12,away:8}:{home:8,draw:12,away:80}}),summary=view.primarySelectionSummary(r.decision);
  assert.equal(r.decision.coherentPrimary.anchorMarket,'HAD');
  assert.equal(summary.handicap.probability,r.decision.handicapAnalysis.overallProbabilities[r.decision.coherentPrimary.hhadCode]);
  const detail=presentation.publishedDetailPresentation(r.decision,[],r.scoreDistribution);assert(detail.primaryScore);
  assert.equal(detail.primaryScore.label,r.scoreDistribution.alignedScores[0].label);
  expectedTopScores(r).forEach((score,index)=>{assert.equal(detail.globalTopScores[index].probability,score.probability);assert.equal(detail.globalTopScores[index].primaryCompatible,score.hadCode===r.decision.coherentPrimary.anchorCode);});
  assert.match(view.handicapLineLabel(line,true),new RegExp(line<0?'主队让':'主队受让'));
 }
});

test('missing HHAD has no conditional branch claim and independent archives retain frozen research and unclassified global scores',()=>{
 const absent=row({available:false}),markup=render(PublishedMatchPick,{row:absent,language:'zh',now:NOW});
 assert.match(markup,/让球 · 暂不可用/);assert.doesNotMatch(markup,/冻结条件分支占比/);
 const old=row({policy:'independent-market-primary-v1'}),before=JSON.stringify(old);
 const detail=presentation.publishedDetailPresentation(old.decision,[],old.scoreDistribution);assert.equal(detail.primaryScore.label,old.scoreDistribution.topScores[0].label);assert(detail.globalTopScores.every(score=>score.primaryCompatible===null));
 const oldMarkup=render(SupplementaryResearchNote,{decision:old.decision,scoreDistribution:old.scoreDistribution,research:old.decision.supplementaryResearch,language:'zh'});
 assertGlobalScores(oldMarkup,expectedTopScores(old));assert.match(oldMarkup,/原冻结全局比分研究/);assert.doesNotMatch(oldMarkup,/data-score-reference="aligned"/);assert.equal(JSON.stringify(old),before);
 const legacy={...old.decision,primaryPickPolicyVersion:undefined,coherentPrimary:undefined};
 const legacyResult=presentation.publishedDetailPresentation(legacy,[{home:1,away:0,label:'1-0',probability:10},{home:1,away:1,label:'1-1',probability:15}]);
 assert.equal(legacyResult.scoreSource,'legacy-supplemental');assert.equal(legacyResult.primaryScore.label,'1-0');assert.equal(legacyResult.alternativeScore.label,'1-1');
});

test('the shared HAD distribution displays all frozen outcomes without substituting the selected branch',()=>{
 const r=row(),before=JSON.stringify(r.decision);assertHadDistribution(render(PublishedHadDistribution,{decision:r.decision,language:'zh'}),r.decision);
 const invalid={...r.decision,probabilities:{'1':.9,X:.9,'2':.1}},markup=render(PublishedHadDistribution,{decision:invalid,language:'zh'});
 assert.match(markup,/完整冻结概率暂不可用/);assert.doesNotMatch(markup,/data-had-code=/);assert.equal(JSON.stringify(r.decision),before);
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

const onlineInputPath=process.env.ONLINE_RECOMMENDATION_INPUT||path.join(__dirname,'../outputs/recommendation-policy-v2-20261005/precutoff-target-versions.json');
test('all seven saved online publications render the original global Top 3 and anchor-only compatibility without changing frozen research',{skip:!process.env.ONLINE_RECOMMENDATION_INPUT&&!fs.existsSync(onlineInputPath)},()=>{
 const inputPath=onlineInputPath;
 const bytes=fs.readFileSync(inputPath),input=JSON.parse(bytes),rows=input.center?.current||input.postgres?.center?.current;
 assert(Array.isArray(rows)&&rows.length===7);const evidence=[];let franceChecked=false;
 for(const raw of rows){
  const before=JSON.stringify(raw),r=view.parseRecommendationCenter(payload(raw)).current[0];
  const detail=presentation.publishedDetailPresentation(r.decision,[],r.scoreDistribution);
  const markup=render(PublishedMatchPick,{row:r,language:'zh',compact:true,now:Date.parse(input.observedAt)});
  const expected=expectedTopScores(r);assert.equal(expected.length,3);assert.equal(detail.scoreSource,'published-matrix');assert.equal(detail.globalTopScores.length,3);
  expected.forEach((score,index)=>{assert.equal(detail.globalTopScores[index].label,score.label);assert.equal(detail.globalTopScores[index].probability,score.probability);assert.equal(detail.globalTopScores[index].primaryCompatible,score.primaryCompatible);});
  assertGlobalScores(markup,expected);assertHadDistribution(markup,r.decision);
  const research=markup.slice(markup.indexOf('class="supplementary-research-note"')),detailsAt=research.indexOf('<details');
  assertGlobalScores(research.slice(0,detailsAt),expected);assert.doesNotMatch(research.slice(0,detailsAt),/data-score-reference="aligned"|data-score-reference="frozen-research"/);
  assert.equal(detail.primaryScore?.label,r.scoreDistribution.alignedScores[0]?.label,'archived both-direction semantics remain unchanged');
  if(r.decision.homeTeamName==='法国'&&r.decision.awayTeamName==='比利时'){
   assert.equal(r.decision.coherentPrimary.anchorMarket,'HHAD');assert.equal(r.decision.coherentPrimary.anchorCode,'2');assert.equal(r.decision.handicapAnalysis.handicapLine,-1);assert.equal(r.decision.tipCode,'2');
   assert.equal(detail.globalTopScores[0].label,'1-1');assert.equal(r.scoreDistribution.topScores[0].hadCode,'X');assert.equal(detail.globalTopScores[0].primaryCompatible,true);
   assert.notEqual(detail.primaryScore.label,'1-1');franceChecked=true;
  }
  const frozen=r.decision.supplementaryResearch;if(frozen){assert(research.slice(detailsAt).includes(frozen.exactScore.label));assert(research.slice(detailsAt).includes(`${(frozen.exactScore.probability*100).toFixed(1)}%`));}
  assert.equal(JSON.stringify(raw),before);
  evidence.push({decisionId:r.decision.decisionId,recordHash:r.decision.recordHash,home:r.decision.homeTeamName,away:r.decision.awayTeamName,
   anchor:r.decision.coherentPrimary.anchorMarket,anchorCode:r.decision.coherentPrimary.anchorCode,conditionalBranch:r.decision.tipCode,
   globalTop3:detail.globalTopScores,archivedAlignedScore:detail.primaryScore,hadProbabilities:r.decision.probabilities,
   frozenResearchUnchanged:true,frozenSettlementUnchanged:true});
 }
 assert(franceChecked,'the mandatory seven-row replay must include the current France / Belgium HHAD primary');
 if(process.env.UI_EVIDENCE_OUTPUT)fs.writeFileSync(process.env.UI_EVIDENCE_OUTPUT,JSON.stringify({sourceSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),sourceObservedAt:input.observedAt,checkedAt:new Date().toISOString(),renderingMode:'React static markup, not browser or deployment verification',rows:evidence},null,2));
});
