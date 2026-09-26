'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const fixture=require('./fixtures/recommendation-detail-20260922.json');
const compile=(file,load=require)=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:id=>id.endsWith('/publishedRecommendationStatus.cjs')?require('../src/services/publishedRecommendationStatus.cjs'):load(id),Date,Intl,Set});return module.exports;};
const presentation=compile('../src/services/publishedDetailPresentation.ts');
const published=compile('../src/services/publishedMatchRecommendation.ts');
const view=compile('../src/services/recommendationCenterView.ts');
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
const words=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(words).join(''):typeof node==='object'?words(node.props?.children):String(node);
const unavailable=()=>{throw Error('Published presentation must not read legacy evidence or generate a competing direction');};
const Facts=compile('../src/components/predictions/RecommendationEvidenceFacts.tsx',id=>{
 if(id==='react/jsx-runtime')return jsx;
 if(id.endsWith('/publishedDetailPresentation'))return presentation;
 if(id.endsWith('/publishedMatchRecommendation'))return published;
 if(id==='./DataAdoptionDetails')return{DataAdoptionDetails:()=>null};
 if(id.endsWith('/legacyReferenceConflict'))return{hasUnboundLegacyReferenceConflict:unavailable};
 if(id.endsWith('/predictionPresentation'))return{getPublishedRecommendationEvidenceBreakdown:unavailable};
 if(id==='./sourceNeutralText')return{formatSourceNeutralText:unavailable};
 if(id.endsWith('.css'))return{};throw Error(id);
}).RecommendationEvidenceFacts;
const qualityNote=compile('../src/components/recommendations/SelectionQualityNote.tsx',id=>{
 if(id==='react/jsx-runtime')return jsx;throw Error(id);
});
const Pick=compile('../src/components/recommendations/PublishedMatchPick.tsx',id=>{
 if(id==='react/jsx-runtime')return jsx;
 if(id.endsWith('/recommendationCenterView'))return view;
 if(id.endsWith('/publishedMatchRecommendation'))return published;
 if(id==='./SelectionQualityNote')return qualityNote;
 if(id.endsWith('.css'))return{};throw Error(id);
}).PublishedMatchPick;

test('detail distinguishes a fresh draw study candidate from the unchanged published home direction',()=>{
 const row=structuredClone(fixture.fixtures[0].row),quoteAt=Date.parse(row.decision.quoteObservedAt);
 row.outcomeResearch={category:'balanced-draw',researchQualified:true,candidateCode:'X',reasons:[],outcomes:[
  {code:'1',modelProbability:.4,odds:2.25},{code:'X',modelProbability:.34,odds:3.45},{code:'2',modelProbability:.26,odds:3.8},
 ]};
 const fresh=Pick({row,language:'zh',now:quoteAt+60000});
 assert.match(words(fresh),/胜平负首选主胜/);
 assert.match(words(fresh),/均势防平 · 平局/);
 assert.match(words(fresh),/研究候选，尚未通过独立比赛日验证/);
 const stale=Pick({row,language:'zh',now:quoteAt+16*60000});
 assert.match(words(stale),/报价过期，仅供比较/);
 assert.doesNotMatch(words(stale),/研究候选，尚未通过独立比赛日验证/);
});

test('published HAD direction and aligned supplemental research posterior remain separately labeled',()=>{
 const compare=published.publishedPosteriorDisagreement;
 const match={id:'sporttery_2041649',sourceMatchId:'2041649',kickoffTime:'2026-09-24T18:20:00+08:00',
  probabilityModel:{generatedAt:'2026-09-24T15:20:00+08:00',oneXTwo:{final:{home:42,draw:33,away:25},unifiedPosterior:{home:34,draw:35.8,away:30.2}},
   unifiedPosterior:{selectedMarket:'HHAD',selectedCode:'2'}}};
 const decision={matchId:match.id,sourceMatchId:'2041649',eventVersion:match.kickoffTime,
  modelGeneratedAt:match.probabilityModel.generatedAt,tipCode:'1',probabilities:{'1':.42,X:.33,'2':.25}};
 assert.deepEqual(JSON.parse(JSON.stringify(compare(match,decision))),{published:'1',research:'X'},
  'compare the HAD probability triplet rather than the unrelated top-level HHAD selection');
 assert.equal(compare(match,{...decision,tipCode:'X'}),null);
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,generatedAt:'2026-09-24T15:21:00+08:00'}},decision),null,
  'a later model snapshot cannot be compared with a frozen decision');
 assert.equal(compare({...match,kickoffTime:'2026-09-24T19:20:00+08:00'},decision),null);
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,oneXTwo:{...match.probabilityModel.oneXTwo,final:{home:38,draw:37,away:25}}}},decision),null,
  'a matching timestamp without matching frozen probabilities cannot bind a supplemental model output');
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,oneXTwo:{unifiedPosterior:{home:34,draw:35.8,away:30.2}}}},decision),null,
  'no final-probability binding means no comparison');
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,oneXTwo:{...match.probabilityModel.oneXTwo,unifiedPosterior:{home:33,draw:33,away:34}}}},decision)?.research,'2');
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,oneXTwo:{...match.probabilityModel.oneXTwo,unifiedPosterior:{home:34,draw:34,away:32}}}},decision),null,
  'a tied leader is not a second recommendation');
 assert.equal(compare({...match,probabilityModel:{...match.probabilityModel,oneXTwo:{...match.probabilityModel.oneXTwo,unifiedPosterior:{home:1,draw:NaN,away:0}}}},decision),null);
});

for(const {match,row} of fixture.fixtures)test(`real ${match.id}: legacy draw cannot replace published home in detail scores or evidence`,()=>{
 const before=JSON.stringify({match,row});
 assert.equal(match.predictions.find(p=>p.marketType==='BEST').tipCode,'X');
 assert.equal(`${match.projectedScoreHome}-${match.projectedScoreAway}`,'1-1');
 const selected=published.publishedMatchRecommendation({current:[row],review:{singles:[]}},match);
 const detail=presentation.publishedDetailPresentation(selected.decision,match.probabilityModel.scoreDistribution);
 assert.equal(detail.tipCode,'1');assert.equal(detail.primaryScore.label,'1-0');assert.equal(detail.primaryScore.probability,10.2);
 assert.equal(detail.alternativeScore.label,'1-1');assert.equal(detail.alternativeScore.probability,12.7);
 assert.equal(detail.probabilities.draw,row.decision.probabilities.X*100);
 const facts=Facts({match,prediction:{tipCode:'X',oddsPoolCode:'HHAD'},publishedDecision:selected.decision,language:'zh',supplementaryModel:false});
 const pick=Pick({row:selected,language:'zh',now:Date.parse(fixture.observedAt)});
 assert.equal(facts.props['data-decision-id'],pick.props['data-decision-id']);
 assert.equal(facts.props['data-record-hash'],pick.props['data-record-hash']);
 assert.match(words(facts),/主胜 · /);assert(words(facts).includes((row.decision.modelProbability*100).toFixed(1)+'%'));
 assert.match(words(facts),/发布时间/);assert.match(words(facts),/SP采集/);
 assert(words(pick).includes((row.decision.modelProbability*100).toFixed(1)+'%'));
 assert.equal(detail.modelGeneratedAt,row.decision.modelGeneratedAt);assert.equal(detail.publishedAt,row.decision.publishedAt);
 assert.equal(JSON.stringify({match,row}),before,'frozen and legacy records remain unchanged');
});
test('no aligned score means no primary and no alternate promoted into its slot',()=>{
 const {row}=fixture.fixtures[0];const result=presentation.publishedDetailPresentation(row.decision,[{home:1,away:1,label:'1-1',probability:70},{home:0,away:1,label:'0-1',probability:30}]);
 assert.equal(result.primaryScore,null);assert.equal(result.alternativeScore,null);
});
test('missing current publication displays waiting without executing legacy evidence selection',()=>{
 const {match}=fixture.fixtures[0];assert.equal(presentation.publishedDetailPresentation(null,match.probabilityModel.scoreDistribution),null);
 assert.match(words(Facts({match,prediction:{tipCode:'X'},publishedDecision:null,language:'zh',supplementaryModel:false})),/暂无已发布推荐/);
});
test('standard draw X maps to draw, never to a handicap draw or unconditional alternative',()=>{
 const {row}=fixture.fixtures[0],decision={...row.decision,tipCode:'X',modelProbability:.5,probabilities:{'1':.3,X:.5,'2':.2},handicapAnalysis:{tipCode:'1'}};
 const data=presentation.publishedDetailPresentation(decision,[{home:1,away:0,label:'misleading',probability:25},{home:0,away:0,label:'untrusted-label',probability:20}]);
 assert.equal(data.primaryScore.label,'0-0');assert.equal(data.probabilities.draw,50);assert.equal(data.alternativeScore.label,'1-0');
 assert.match(words(Facts({match:fixture.fixtures[0].match,publishedDecision:decision,language:'zh',supplementaryModel:false})),/平局 · 50.0%/);
});
test('score selection rejects invented/invalid rows, ranks existing rows and never mutates input',()=>{
 const {row}=fixture.fixtures[0],scores=[{home:2,away:0,label:'2-0',probability:5},{home:1,away:0,label:'1-0',probability:10},{home:3,away:0,label:'3-0',probability:NaN},{home:-1,away:-2,label:'bad',probability:99},{home:1.5,away:0,label:'bad',probability:99}];
 const before=JSON.stringify(scores),result=presentation.publishedDetailPresentation(row.decision,scores);
 assert.equal(result.primaryScore.label,'1-0');assert.equal(result.alternativeScore.label,'2-0');assert.equal(JSON.stringify(scores),before);
});

const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
function scorePublication(){
 const now=Date.parse('2026-09-20T02:00:00Z'),at=new Date(now).toISOString();
 const match={id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-20',status:'SCHEDULED',
  homeTeamId:'h1',awayTeamId:'a1',homeTeamName:'Home',awayTeamName:'Away',
  kickoffTime:'2026-09-20T10:00:00Z',eventVersion:'2026-09-20T10:00:00Z',buyEndTime:'2026-09-20T09:30:00Z',
  odds:{odds1:1.7,oddsX:3.5,odds2:4.8},oddsSource:'sporttery:had',oddsUpdatedAt:at,
  handicapLine:-1,handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:at,
  probabilityModel:{version:'detail-score-test',generatedAt:at,oneXTwo:{final:{home:.4,draw:.35,away:.25}},calculationTrace:{poisson:{lambdas:{home:1.2,away:1.1}}}}};
 const decision=makeDecision(match,{now,publication:{generationId:'g',manifestHash:'a'.repeat(64),sourceCycleId:'cycle'}}).decision;
 const scores=buildPublishedScoreDistribution(decision);
 assert.equal(scores.status,'available');return {decision,scores};
}
const legacyScores=[{home:8,away:0,label:'8-0',probability:99}];

test('backend-derived scores replace supplemental values and preserve original global ranking and probabilities',()=>{
 const {decision,scores}=scorePublication(),before=JSON.stringify({decision,scores});
 const result=presentation.publishedDetailPresentation(decision,legacyScores,scores);
 assert.equal(result.scoreSource,'published-matrix');
 assert.equal(result.primaryScore.label,scores.alignedScores[0].label);
 assert.equal(result.primaryScore.probability,scores.alignedScores[0].probability*100);
 assert.equal(result.globalScores[0].label,scores.topScores[0].label);
 assert.equal(scores.topScores[0].hadCode,'X');assert.equal(decision.tipCode,'1');
 assert.equal(result.alternativeScore.label,scores.topScores[0].label);
 assert.equal(result.alternativeScore.probability,scores.topScores[0].probability*100);
 assert.equal(result.tipCode,decision.tipCode);assert.notEqual(result.primaryScore.label,'8-0');
 assert.equal(JSON.stringify({decision,scores}),before);
});

test('bound score unavailable or explicit null never falls back to the old supplemental model',()=>{
 const {decision,scores}=scorePublication();
 for(const bound of [null,{...scores,status:'unavailable',topScores:[],alignedScores:[]}]){
  const result=presentation.publishedDetailPresentation(decision,legacyScores,bound);
  assert.equal(result.scoreSource,'unavailable');assert.equal(result.primaryScore,null);assert.equal(result.alternativeScore,null);
 }
 const legacy=presentation.publishedDetailPresentation(decision,legacyScores);
 assert.equal(legacy.scoreSource,'legacy-supplemental');assert.equal(legacy.primaryScore.label,'8-0');
});

test('wrong record binding or malformed score units and outcome codes are rejected without a competing fallback',()=>{
 const {decision,scores}=scorePublication();
 for(const change of [
  row=>{row.decisionId='another-decision';},row=>{row.recordHash='f'.repeat(64);},
  row=>{row.topScores[0].probability*=100;},row=>{row.topScores[0].hadCode='1';},
  row=>{row.alignedScores[0].hhadCode=row.alignedScores[0].hhadCode==='X'?'2':'X';},
  row=>{row.topScores[0].home=-1;},row=>{row.topScores[0].label='false-score';},
 ]){
  const invalid=structuredClone(scores);change(invalid);
  const result=presentation.publishedDetailPresentation(decision,legacyScores,invalid);
  assert.equal(result.scoreSource,'unavailable');assert.equal(result.primaryScore,null);assert.equal(result.alternativeScore,null);
 }
});

test('an empty aligned projection cannot promote the global modal draw into the primary score',()=>{
 const {decision,scores}=scorePublication();
 const result=presentation.publishedDetailPresentation(decision,legacyScores,{...scores,alignedScores:[]});
 assert.equal(result.primaryScore,null);assert.equal(result.alternativeScore,null);
 assert.equal(result.globalScores[0].label,scores.topScores[0].label);
});

test('frontend parser accepts server score projection and explicit unavailable without changing the frozen decision',()=>{
 const {decision,scores}=scorePublication();
 const summary={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
 const row={decision,settlement:{state:'PENDING'},scoreDistribution:scores};
 const response={recommendationCenter:{version:'recommendation-center-v1',updatedAt:decision.publishedAt,businessDate:decision.businessDate,
  inputAsOf:null,resultAsOf:null,lanes:{},current:[row],previews:[],todayCombos:[],overlapDecisionIds:[],
  review:{singles:[],combos:[],limit:0,statistics:{single:summary,two:summary,three:summary},definition:'test'},excludedCorruptRecords:0,modelValidation:'unvalidated'}};
 const parsed=view.parseRecommendationCenter(response).current[0];
 const result=presentation.publishedDetailPresentation(parsed.decision,legacyScores,parsed.scoreDistribution);
 assert.equal(result.scoreSource,'published-matrix');assert.equal(result.primaryScore.probability,scores.alignedScores[0].probability*100);
 assert.equal(JSON.stringify(parsed.scoreDistribution.totalGoals),JSON.stringify(scores.totalGoals));
 const tampered=structuredClone(response);
 tampered.recommendationCenter.current[0].scoreDistribution.totalGoals[0].probability+=.01;
 assert.throws(()=>view.parseRecommendationCenter(tampered),/Invalid total-goals binding/);
 const older=structuredClone(response);
 delete older.recommendationCenter.current[0].scoreDistribution.totalGoals;
 assert.equal(view.parseRecommendationCenter(older).current[0].scoreDistribution.totalGoals,undefined,
  'older read-only projections remain displayable without a fabricated total-goals distribution');
 row.scoreDistribution={...scores,status:'unavailable',topScores:[],alignedScores:[],totalGoals:[]};
 const missing=view.parseRecommendationCenter(response).current[0];
 assert.equal(presentation.publishedDetailPresentation(missing.decision,legacyScores,missing.scoreDistribution).primaryScore,null);
 assert.equal(missing.scoreDistribution.totalGoals.length,0);
});
