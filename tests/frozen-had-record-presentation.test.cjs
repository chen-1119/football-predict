'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createRequire}=require('node:module'),cache=new Map();
const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX};
function compile(file){
 const absolute=require.resolve(file);if(cache.has(absolute))return cache.get(absolute).exports;
 const module={exports:{}};cache.set(absolute,module);const native=createRequire(absolute);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date,Intl,Set,require:id=>{
  if(id.endsWith('.css'))return {};
  if(id==='football-collector-diagnostics')return require('../src/services/apiFootballDiagnostics.cjs');
  if(id.startsWith('.'))for(const ext of ['.ts','.tsx']){const dependency=path.resolve(path.dirname(absolute),id+ext);if(fs.existsSync(dependency))return compile(dependency);}
  return native(id);
 }},{filename:absolute});return module.exports;
}
const {RecommendationEvidenceFacts,FrozenHadPosteriorNote}=compile('../src/components/predictions/RecommendationEvidenceFacts.tsx');
const {publishedPosteriorDisagreement,publishedResultProjection}=compile('../src/services/publishedMatchRecommendation.ts');
const {match:makeMatch,NOW}=require('./recommendationFixture.cjs');
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

// Synthetic boundary data only: these are not captured recommendations or outcomes.
function fixture(){
 const source=makeMatch(990001,NOW),decision={
  decisionId:'synthetic-frozen-had',recordHash:'b'.repeat(64),matchId:source.id,sourceMatchId:source.sourceMatchId,
  eventVersion:source.eventVersion,kickoffTime:source.kickoffTime,tipCode:'2',modelProbability:.281,
  probabilities:{'1':.455,X:.264,'2':.281},modelGeneratedAt:new Date(NOW).toISOString(),
  publishedAt:new Date(NOW+1000).toISOString(),quoteObservedAt:new Date(NOW-1000).toISOString(),
  primaryPickPolicyVersion:'coherent-market-primary-v1',
  coherentPrimary:{anchorMarket:'HHAD',anchorCode:'2',anchorProbability:.544,hadCode:'2',hhadCode:'2',companionConditionalProbability:.5165},
 };
 source.probabilityModel={generatedAt:decision.modelGeneratedAt,oneXTwo:{final:{home:45.5,draw:26.4,away:28.1},unifiedPosterior:{home:46,draw:27,away:27}}};
 return {source,row:{decision,settlement:{state:'LOST',score:'1-1'},handicapSettlement:{state:'WON',score:'1-1'}}};
}

// Extract the actual page expression so the regression proves that MatchDetail
// consumes the tested component and passes the frozen record, not a copied view.
const detailFile=path.join(__dirname,'../src/pages/MatchDetail.tsx');
const detailSource=fs.readFileSync(detailFile,'utf8'),ast=ts.createSourceFile(detailFile,detailSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),expressions=[];
(function visit(node){
 if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken
  &&ts.isJsxSelfClosingElement(node.right)&&node.right.tagName.getText(ast)==='FrozenHadPosteriorNote')expressions.push(node.getText(ast));
 ts.forEachChild(node,visit);
})(ast);
assert.equal(expressions.length,1,'MatchDetail must consume one bound posterior note');
const detailModule={exports:{}};
vm.runInNewContext(ts.transpileModule(`module.exports=({unifiedRow,posteriorDisagreement,language})=>(${expressions[0]});`,{compilerOptions}).outputText,
 {module:detailModule,exports:detailModule.exports,require,FrozenHadPosteriorNote});
const DetailPosterior=detailModule.exports;

for(const language of ['zh','en'])test(`frozen HHAD-anchor HAD branch is explicit with unchanged unconditional numbers (${language})`,()=>{
 const data=freeze(fixture()),before=JSON.stringify(data),d=data.row.decision;
 const markup=render(RecommendationEvidenceFacts,{match:data.source,publishedDecision:d,language,supplementaryModel:false}),text=plain(markup);
 assert.match(markup,/data-frozen-had-role="conditional-branch"/);
 assert(markup.includes(`data-decision-id="${d.decisionId}"`));assert(markup.includes(`data-record-hash="${d.recordHash}"`));
 for(const at of [d.modelGeneratedAt,d.publishedAt,d.quoteObservedAt])assert(markup.includes(`dateTime="${at}"`));
 for(const [code,p]of Object.entries(d.probabilities)){
  const outcome=markup.match(new RegExp(`<div data-outcome="${code}">([\\s\\S]*?)<\\/div>`));assert(outcome);assert(plain(outcome[1]).includes(`${(p*100).toFixed(1)}%`));
 }
 const emphasis=plain(markup.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/)[1]);
 assert(emphasis.includes('28.1%'));assert(!emphasis.includes('45.5%'));assert(!emphasis.includes('54.4%'));assert(!text.includes('51.65%'));
 if(language==='zh'){
  assert.match(text,/原冻结胜平负记录/);assert.match(emphasis,/冻结条件分支：客胜 · 无条件概率 28.1%/);
  assert.match(text,/主方向成立时的一个分支，非独立推荐/);assert.match(text,/尚未验证为真实命中率/);
 }else{
  assert.match(text,/Original frozen 1X2 record/);assert.match(emphasis,/Frozen conditional branch: Away · Unconditional probability 28.1%/);
  assert.match(text,/not an independent recommendation/);assert.match(text,/not validated hit rates/);
 }
 const results=publishedResultProjection(data.row);assert.equal(results.primary.market,'HHAD');assert.equal(results.primary.settlement.state,'WON');assert.equal(results.companion.settlement.state,'LOST');
 assert.equal(publishedResultProjection(data.row,'HAD').displayed.settlement.state,'LOST');
 assert.equal(JSON.stringify(data),before,'the entire source, decision and both settlements remain unchanged');
});

const nonBranches=[
 ['HAD anchor',d=>{d.coherentPrimary.anchorMarket='HAD';}],
 ['legacy policy',d=>{delete d.primaryPickPolicyVersion;delete d.coherentPrimary;}],
 ['independent policy',d=>{d.primaryPickPolicyVersion='independent-market-primary-v1';}],
 ['unknown policy with coherent metadata',d=>{d.primaryPickPolicyVersion='future-policy-v9';}],
 ['metadata without exact policy',d=>{delete d.primaryPickPolicyVersion;}],
 ['missing coherent metadata',d=>{delete d.coherentPrimary;}],
 ['missing anchor',d=>{delete d.coherentPrimary.anchorMarket;}],
];
for(const [name,change]of nonBranches)test(`${name} does not acquire a conditional-branch role`,()=>{
 const data=fixture();change(data.row.decision);freeze(data);const before=JSON.stringify(data);
 for(const language of ['zh','en']){
  const markup=render(RecommendationEvidenceFacts,{match:data.source,publishedDecision:data.row.decision,language,supplementaryModel:false});
  assert.match(markup,/data-frozen-had-role="selection"/);assert.doesNotMatch(plain(markup),/条件分支|conditional branch/i);assert(plain(markup).includes('28.1%'));
  assert.doesNotMatch(plain(markup),/不作为当前正式推荐|not as a current formal recommendation|非独立推荐|not an independent recommendation/i);
  const note=render(DetailPosterior,{unifiedRow:data.row,posteriorDisagreement:{published:'2',research:'1'},language});
  assert.doesNotMatch(plain(note),/条件分支|conditional branch/i);assert.match(plain(note),language==='zh'?/原冻结胜平负选择客胜/:/original frozen 1X2 selection is Away/);
  assert.doesNotMatch(plain(note),/两者均不作为当前正式推荐|neither is a current formal recommendation/i);
  assert.match(plain(note),language==='zh'?/原冻结记录的发布方向及历史结算保持不变/:/original published 1X2 selection and its historical settlement remain unchanged/);
 }
 assert.equal(JSON.stringify(data),before);
});

test('null publication is still unavailable and undefined still uses legacy evidence',()=>{
 const data=freeze(fixture()),props={match:data.source,language:'zh',supplementaryModel:false};
 const missing=render(RecommendationEvidenceFacts,{...props,publishedDecision:null});
 assert.match(plain(missing),/暂无已发布推荐/);assert.doesNotMatch(missing,/data-frozen-had-role|28\.1%|data-record-hash/);
 const legacy=render(RecommendationEvidenceFacts,props);assert.match(legacy,/data-testid="recommendation-evidence-breakdown"/);assert.doesNotMatch(legacy,/data-frozen-had-role|条件分支/);
});

for(const language of ['zh','en'])test(`actual detail posterior expression explains the frozen branch without promoting it (${language})`,()=>{
 const data=freeze(fixture()),before=JSON.stringify(data),disagreement=publishedPosteriorDisagreement(data.source,data.row.decision);
 assert.equal(disagreement.published,'2');assert.equal(disagreement.research,'1');
 const markup=render(DetailPosterior,{unifiedRow:data.row,posteriorDisagreement:disagreement,language}),text=plain(markup);
 assert.match(markup,/data-model-direction-disagreement="true"/);
 if(language==='zh'){
  assert.match(text,/研究后验偏向主胜，与原冻结胜平负条件分支客胜不同/);assert.match(text,/不能证明发布时采用过该后验/);
  assert.match(text,/原冻结记录及其历史结算保留，两者均不作为当前正式推荐/);assert.doesNotMatch(text,/公开方向仍以冻结记录为准/);
 }else{
  assert.match(text,/posterior favors Home, while the original frozen 1X2 conditional branch is Away/);
  assert.match(text,/no posterior content binding proves it was used at publication/);assert.match(text,/historical settlement are retained; neither is a current formal recommendation/);
 }
 assert.equal(JSON.stringify(data),before);
});

test('unbound posterior or missing publication does not create a detail disagreement note',()=>{
 const data=fixture();data.source.probabilityModel.generatedAt=new Date(NOW+60000).toISOString();
 const disagreement=publishedPosteriorDisagreement(data.source,data.row.decision);assert.equal(disagreement,null);
 assert.equal(render(DetailPosterior,{unifiedRow:data.row,posteriorDisagreement:disagreement,language:'zh'}),'');
 assert.equal(render(DetailPosterior,{unifiedRow:null,posteriorDisagreement:{published:'2',research:'1'},language:'zh'}),'');
});
