'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const fixture=require('./fixtures/recommendation-detail-20260922.json');
const compile=(file,load=require)=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:load,Date,Intl,Set});return module.exports;};
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
const Pick=compile('../src/components/recommendations/PublishedMatchPick.tsx',id=>{
 if(id==='react/jsx-runtime')return jsx;
 if(id.endsWith('/recommendationCenterView'))return view;
 if(id.endsWith('/publishedMatchRecommendation'))return published;
 if(id.endsWith('.css'))return{};throw Error(id);
}).PublishedMatchPick;

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
