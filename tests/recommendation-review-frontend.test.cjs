'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.TYPESCRIPT_LIBRARY||'typescript');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const {buildRecommendationReviewPage,parseReviewQuery}=require('../server/recommendationReviewPage.cjs');

function loadFrontendParser(){
  const compile=file=>ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services',file),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const load=(code,dependencies={})=>{const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:id=>{
    if(Object.hasOwn(dependencies,id))return dependencies[id];throw new Error('Unexpected dependency '+id);
  }});return module.exports;};
  const center=load(compile('recommendationCenterView.ts'));
  return load(compile('recommendationReviewPage.ts'),{'./recommendationCenterView':center}).parseRecommendationReviewPage;
}
const parse=loadFrontendParser();
const decision=makeDecision(match(1),{now:NOW,publication:publication(NOW)}).decision;
const source={updatedAt:new Date(NOW).toISOString(),decisions:[decision],combos:[],resultEvents:[],boundDecisions:[]};
const filters=parseReviewQuery(new URL('https://example.test/api/v1/recommendations/review?kind=single&pageSize=12'));

test('frontend accepts one real PostgreSQL review projection with the frozen decision and full-ledger windows',()=>{
  const raw=buildRecommendationReviewPage(source,filters,NOW);
  const page=parse(raw);
  assert.equal(page.total,1);
  assert.equal(page.rows[0].decision.decisionId,decision.decisionId);
  assert.equal(page.rows[0].selectedMarket,'HAD');
  assert.equal(page.rows[0].selectedOdds,decision.odds);
  assert.equal(page.summary.all.published,1);
  assert.equal(page.summary.windows.last7.published,1);
  assert.equal(page.summary.all.hitRate,null);
});

test('review parsing rejects a forged selected result or broken page count',()=>{
  const altered=buildRecommendationReviewPage(source,filters,NOW);
  altered.rows[0].selectedSettlement={state:'WON'};
  assert.throws(()=>parse(altered));
  const truncated=buildRecommendationReviewPage(source,filters,NOW);
  truncated.pageCount=0;
  assert.throws(()=>parse(truncated));
});
