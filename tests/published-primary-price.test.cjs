'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{createRequire}=require('node:module');
const cache=new Map();
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
const {PublishedPrimaryPrice}=compile('../src/components/recommendations/SelectionQualityNote.tsx');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');

// Replay the actual JSX assigned to the fixture list's SP cell. This exercises
// its unified/legacy routing without claiming a full browser/page acceptance.
const listPath=require.resolve('../src/pages/PredictionsList.tsx');
const source=ts.createSourceFile(listPath,fs.readFileSync(listPath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let expression;
function find(node){
 if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='MatchSummaryRow'){
  const attribute=node.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(source)==='odds');
  assert(attribute&&ts.isJsxExpression(attribute.initializer));expression=attribute.initializer.expression.getText(source);
 }
 ts.forEachChild(node,find);
}
find(source);assert(expression,'the actual fixture SP cell exists');
const moduleForCell={exports:{}};
const cellCode=ts.transpileModule(`export function FixtureSpCell(props:any){const {useUnified,unifiedRow,language,nowMs,sp}=props;return (${expression});}`,
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},fileName:'FixtureSpCell.tsx'}).outputText;
vm.runInNewContext(cellCode,{module:moduleForCell,exports:moduleForCell.exports,PublishedPrimaryPrice,require:createRequire(listPath)});
const render=(decision,props={})=>renderToStaticMarkup(React.createElement(moduleForCell.exports.FixtureSpCell,{useUnified:true,unifiedRow:decision?{decision}:null,language:'zh',nowMs:NOW,sp:'9.99',...props}));
const shownPrice=markup=>markup.match(/<strong class="compact-sp">([^<]*)<\/strong>/)?.[1];

// Synthetic contrasting prices reproduce the wrong-market display failure;
// they are UI regression fixtures, not captured matches or accuracy evidence.
function fixture({id=899,line=-1,available=true,hadAway=5.80,hhadHome=2.40,hhadAway=2.38,probabilities={home:45.6,draw:26.4,away:28}}={}){
 const input=match(id,NOW,{homeTeamName:'Synthetic home',awayTeamName:'Synthetic away',
  odds:{odds1:1.32,oddsX:5.50,odds2:hadAway},
  ...(available?{handicapLine:line,handicapOdds:{odds1:hhadHome,oddsX:3.30,odds2:hhadAway},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString()}:{}),
  probabilityModel:{version:'synthetic-primary-price',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.72,away:1.32}}}}});
 const decision=makeDecision(input,{now:NOW,publication:publication(NOW),primaryPolicy:'coherent-market-primary-v1'}).decision;
 assert(decision);return decision;
}

test('the actual list SP cell binds -1 handicap away to 2.38 rather than the frozen HAD away 5.80',()=>{
 const decision=fixture(),before=JSON.stringify(decision);assert.equal(decision.coherentPrimary.anchorMarket,'HHAD');assert.equal(decision.coherentPrimary.anchorCode,'2');assert.equal(decision.odds,5.80);
 for(const language of ['zh','en']){
  const html=render(decision,{language});assert.equal(shownPrice(html),'2.38');assert.doesNotMatch(html,/>5\.80</);
  assert.match(html,/data-primary-price-market="HHAD"/);assert.match(html,/data-primary-price-code="2"/);assert.match(html,/data-primary-price-line="-1"/);
  assert(html.includes(`data-decision-id="${decision.decisionId}"`));assert(html.includes(`data-record-hash="${decision.recordHash}"`));
  assert.match(html,language==='zh'?/发布时让球 SP/:/Published handicap SP/);assert(html.includes(`dateTime="${decision.handicapAnalysis.marketReference.observedAt}"`));
 }
 assert.equal(JSON.stringify(decision),before);
});

test('positive handicaps and a second away handicap select their own frozen quote code',()=>{
 const positive=fixture({line:2,hhadHome:2.00,probabilities:{home:26.4,draw:45.6,away:28}});
 assert.equal(positive.coherentPrimary.anchorMarket,'HHAD');assert.equal(positive.coherentPrimary.anchorCode,'1');assert.equal(positive.odds,5.50);
 const html=render(positive);assert.equal(shownPrice(html),'2.00');assert.doesNotMatch(html,/>5\.50</);assert.match(html,/data-primary-price-code="1"/);assert.match(html,/data-primary-price-line="2"/);
 const away=fixture({id:900,hhadAway:2.15,hadAway:4.60});assert.equal(away.coherentPrimary.anchorCode,'2');assert.equal(shownPrice(render(away)),'2.15');
});

test('missing, invalid or wrong-source HHAD prices stay unverified instead of borrowing HAD or legacy SP',()=>{
 const decision=fixture(),h=decision.handicapAnalysis;
 for(const marketReference of [null,{...h.marketReference,odds:undefined},{...h.marketReference,source:'500.com:jczq:HAD'},
  {...h.marketReference,odds:{...h.marketReference.odds,'2':0}}, {...h.marketReference,odds:{...h.marketReference.odds,'2':NaN}}]){
  const next={...decision,handicapAnalysis:{...h,marketReference}},before=JSON.stringify(next),html=render(next);
  assert.equal(shownPrice(html),'—');assert.match(html,/冻结 SP 待核/);assert.doesNotMatch(html,/5\.80|9\.99|Published 1X2 SP/);assert.equal(JSON.stringify(next),before);
 }
});

test('the current HAD-only publication uses its own 1X2 price without inheriting an older HHAD quote',()=>{
 const old=fixture(),current=fixture({id:901,available:false}),before=JSON.stringify(current);
 assert.equal(current.coherentPrimary.anchorMarket,'HAD');assert.equal(shownPrice(render(current,{oldRow:{decision:old}})),current.odds.toFixed(2));
 assert.match(render(current),/data-primary-price-market="HAD"/);assert.match(render(current),/发布时胜平负 SP/);assert.doesNotMatch(render(current),/发布时让球 SP|>2\.38</);assert.equal(JSON.stringify(current),before);
});

test('closed and kicked-off records retain the same frozen HHAD price, identity and quote clock',()=>{
 const decision=fixture(),before=JSON.stringify(decision);
 for(const nowMs of [Date.parse(decision.cutoffTime),Date.parse(decision.kickoffTime),Date.parse(decision.kickoffTime)+3600000]){
  const html=render(decision,{nowMs,currentHandicapOdds:{odds1:1.10,oddsX:2.00,odds2:8.88}});
  assert.equal(shownPrice(html),'2.38');assert.match(html,/已截止 · 仅供复盘/);assert.doesNotMatch(html,/>8\.88</);
  assert(html.includes(`dateTime="${decision.handicapAnalysis.marketReference.observedAt}"`));
 }
 assert.equal(JSON.stringify(decision),before);
});

test('staleness and source metadata follow HHAD observation time rather than the fresh HAD clock',()=>{
 const decision=fixture(),oldClock=new Date(NOW-16*60000).toISOString();
 const next={...decision,handicapAnalysis:{...decision.handicapAnalysis,marketReference:{...decision.handicapAnalysis.marketReference,observedAt:oldClock}}};
 const html=render(next);assert.equal(shownPrice(html),'2.38');assert.match(html,/SP待更新 · 观望/);assert(html.includes(`dateTime="${oldClock}"`));assert.match(html,/竞彩网来源SP/);
});

test('anchor, event identity, record identity and future quote failures cannot display a price',()=>{
 const decision=fixture();
 for(const next of [{...decision,coherentPrimary:undefined},{...decision,coherentPrimary:{...decision.coherentPrimary,anchorCode:'1'}},
  {...decision,recordHash:'invalid'},{...decision,eventVersion:new Date(Date.parse(decision.eventVersion)+60000).toISOString()},
  {...decision,publishedAt:new Date(NOW+1).toISOString()}, {...decision,handicapAnalysis:{...decision.handicapAnalysis,market:'HAD'}},
  {...decision,handicapAnalysis:{...decision.handicapAnalysis,marketReference:{...decision.handicapAnalysis.marketReference,observedAt:new Date(NOW+1).toISOString()}}}]){
  const html=render(next);assert.equal(shownPrice(html),'—');assert.match(html,/冻结 SP 待核/);assert.doesNotMatch(html,/>5\.80<|>2\.38<|>9\.99</);
 }
});

test('a missing publication or caller clock remains unverified; a legacy row retains its caller-owned price',()=>{
 for(const html of [render(null),render(fixture(),{nowMs:NaN})]){assert.equal(shownPrice(html),'—');assert.match(html,/冻结 SP 待核/);}
 const legacy=render(fixture(),{useUnified:false,sp:'3.21'});assert.equal(shownPrice(legacy),'3.21');assert.match(legacy,/推荐方向/);assert.doesNotMatch(legacy,/data-primary-price-market/);
});
