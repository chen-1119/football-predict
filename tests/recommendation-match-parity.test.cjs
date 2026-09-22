'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const compile=(file,load=require)=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:load,Date,Intl});return module.exports;};
const view=compile(require.resolve('../src/services/recommendationCenterView.ts'));
const model=compile(require.resolve('../src/services/publishedMatchRecommendation.ts'));
const {memoryPorts,validators}=require('./recommendationFixture.cjs'),{createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
async function fixture(){const ports=memoryPorts();await createRuntime(ports,{validators}).publishingCycle();const data=view.parseRecommendationCenter({recommendationCenter:ports.state.view}),row=data.current[0],d=row.decision;return{data,row,match:{id:d.matchId,sourceMatchId:d.sourceMatchId,kickoffTime:d.kickoffTime,homeTeamName:d.homeTeamName,awayTeamName:d.awayTeamName,businessDate:d.businessDate,status:'SCHEDULED',predictions:[{marketType:'BEST',tipCode:d.tipCode==='1'?'2':'1',odds:99}]}};}
test('fixtures and detail select the center published direction, SP and version despite a contrary legacy BEST',async()=>{
 const {data,row,match}=await fixture();const actual=model.publishedMatchRecommendation(data,match);
 assert.equal(actual,row);assert.notEqual(actual.decision.tipCode,match.predictions[0].tipCode);assert.notEqual(actual.decision.odds,99);
 assert.equal(model.usesPublishedRecommendation(match,row,Date.parse(row.decision.publishedAt)),true);
});
test('same match id with a changed event or swapped team cannot inherit an earlier pick',async()=>{
 const {data,match}=await fixture();for(const patch of [{kickoffTime:'2030-01-01T00:00:00Z'},{sourceMatchId:'unknown'},{homeTeamName:match.awayTeamName,awayTeamName:match.homeTeamName},{homeTeamName:undefined}])assert.equal(model.publishedMatchRecommendation(data,{...match,...patch}),null);
});
test('current publication outranks archived review and frozen combo legs',async()=>{
 const {data,row,match}=await fixture();data.review.singles=[{...row,decision:{...row.decision,decisionId:'archived-different',publishedAt:'2040-01-01T00:00:00Z',odds:99}}];
 assert.equal(model.publishedMatchRecommendation(data,match),row);
 data.current=[];assert.equal(model.publishedMatchRecommendation(data,match).decision.decisionId,'archived-different');
 data.review.singles=[];assert.equal(model.publishedMatchRecommendation(data,match),null);
});
test('a missing current publication stays pending instead of displaying a local fallback; old history remains explicitly separate',async()=>{
 const {match,row}=await fixture();assert.equal(model.publishedMatchRecommendation(null,match),null);
 assert.equal(model.usesPublishedRecommendation(match,null,Date.parse(row.decision.publishedAt)),true);
 assert.equal(model.usesPublishedRecommendation({...match,status:'FINISHED',businessDate:'2000-01-01'},null),false);
 assert.equal(model.publishedResultLabel(null,'zh'),'待发布');assert.equal(model.publishedResultLabel({settlement:{state:'PENDING'}},'zh'),'待赛果');
});
const words=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(words).join(''):typeof node==='object'?words(node.props?.children):String(node);
const pick=compile(require.resolve('../src/components/recommendations/PublishedMatchPick.tsx'),id=>{
 if(id==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
 if(id==='./SelectionQualityNote')return require('./fixtures/selection-quality-note-module.cjs');
 if(id==='../../services/recommendationCenterView')return view;
 if(id==='../../services/publishedMatchRecommendation')return model;
 if(id.endsWith('.css'))return{};throw Error(id);
}).PublishedMatchPick;
test('shared fixture/detail card keeps exact published SP, probability and record identity and labels old quotes',async()=>{
 const {row}=await fixture(),d=row.decision;const first=pick({row,language:'zh',now:Date.parse(d.publishedAt),compact:false});
 assert.equal(first.props['data-decision-id'],d.decisionId);assert.equal(first.props['data-record-hash'],d.recordHash);
 const text=words(first);assert(text.includes(model.publishedPickLabel(d.tipCode,'zh')));assert(text.includes('SP '+d.odds.toFixed(2)));assert(text.includes((d.modelProbability*100).toFixed(1)+'%'));assert(text.includes(d.decisionId));
 const expired=words(pick({row,language:'zh',now:Date.parse(d.quoteObservedAt)+16*60000}));assert.match(expired,/SP待更新/);assert.match(expired,/不作为当前可用串关报价/);
 assert.match(words(pick({row:null,language:'zh',loading:false,failed:true})),/推荐暂未读取/);
});
