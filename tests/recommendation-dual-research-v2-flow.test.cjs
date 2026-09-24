'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {match,publication}=require('./recommendationFixture.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {validDualResearchV2Record}=require('../scripts/recommendationPlatform/dualChoiceResearchV2.cjs');

const NOW=Date.parse('2026-09-17T13:00:00Z');
function hhadOnly(){
  const row=match(91,NOW,{odds:null,oddsSource:null,handicapLine:-2,
    handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},
    handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString()});
  row.probabilityModel.calculationTrace={poisson:{lambdas:{home:2.2,away:.6}}};
  return withVerifiedInputEvidence(row);
}
function compile(file,load){
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,file),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
  {module,exports:module.exports,require:load,Date,Intl,Set});
  return module.exports;
}

test('runtime captures HHAD-only research independently of failed HAD publication and is idempotent',async()=>{
  const row=hhadOnly(),saved=[];
  const ports={supportsResearchV2:true,clock:()=>NOW,async transaction(lane,action){
    if(lane!=='dual-research-v2')throw Object.assign(new Error('No HAD publication'),{code:'SOURCE_STALE'});
    return action({publication:async()=>publication(NOW),currentInputs:async()=>({current:[row]}),
      insertDualResearchV2:async record=>{
        if(saved.some(item=>item.sourceMatchId===record.sourceMatchId&&item.eventVersion===record.eventVersion))return false;
        saved.push(record);return true;
      },savepoint:async action=>({value:await action()}),issue:async()=>{throw Error('Unexpected issue');}});
  }};
  const runtime=createRuntime(ports,{dualResearchEnabled:false});
  const first=await runtime.publishingCycle();
  assert.equal(first.publication.ok,false);
  assert.deepEqual(first.dualResearchV2,{ok:true,enabled:true,created:1,eligible:1,issues:0});
  assert.equal(saved.length,1);
  assert.deepEqual(saved[0].selections.map(s=>s.market),['HHAD','HHAD']);
  assert(validDualResearchV2Record(saved[0],row));
  const second=await runtime.researchV2();
  assert.deepEqual(second,{ok:true,enabled:true,created:0,eligible:1,issues:0});
});

test('browser contract renders the two HHAD SPs as research and rejects altered coverage',async()=>{
  const row=hhadOnly();
  const {createDualResearchV2Record}=require('../scripts/recommendationPlatform/dualChoiceResearchV2.cjs');
  const record=createDualResearchV2Record(row,{now:NOW,publication:publication(NOW)});
  assert(record);
  const projection={version:record.version,id:record.id,sourceMatchId:record.sourceMatchId,
    matchId:record.inputSnapshot.id,eventVersion:record.eventVersion,businessDate:record.businessDate,
    homeTeamName:record.inputSnapshot.homeTeamName,awayTeamName:record.inputSnapshot.awayTeamName,
    recordedAt:record.recordedAt,cutoffAt:record.cutoffAt,recordHash:record.recordHash,
    researchOnly:true,formalPromotion:false,totalStake:2,unionProbability:record.unionProbability,
    selections:record.selections.map(s=>({market:s.market,tipCode:s.tipCode,handicapLine:s.handicapLine,
      odds:s.odds,modelProbability:s.modelProbability,quoteObservedAt:s.quoteObservedAt})),
    settlement:{state:'PENDING',grossReturn:null,netProfit:null,resultEventId:null}};
  const view=compile('../src/services/recommendationCenterView.ts',require);
  const center=compile('../src/components/recommendations/DualResearchV2.tsx',id=>
    id==='react/jsx-runtime'?require(id):id.endsWith('.css')?{}:(()=>{throw Error(id);})());
  const {memoryPorts}=require('./recommendationFixture.cjs');
  const ports=memoryPorts();
  await createRuntime(ports).publishingCycle();
  const response={recommendationCenter:{...ports.state.view,todayDualResearch:[projection]}};
  const parsed=view.parseRecommendationCenter(response);
  assert.deepEqual(parsed.todayDualResearch[0].selections.map(s=>s.market),['HHAD','HHAD']);
  assert.throws(()=>view.parseRecommendationCenter({recommendationCenter:{...response.recommendationCenter,
    todayDualResearch:[{...projection,unionProbability:.1}]}}),/Invalid dual research union/);
  const html=renderToStaticMarkup(React.createElement(center.DualResearchV2,{row:projection,language:'zh'}));
  assert.match(html,/双选/);
  assert.match(html,/非正式推荐/);
  assert.match(html,/让球胜平负/);
  assert.match(html,/不是 2 串 1/);
  for(const selection of projection.selections)assert.match(html,new RegExp(selection.odds.toFixed(2)));
});
