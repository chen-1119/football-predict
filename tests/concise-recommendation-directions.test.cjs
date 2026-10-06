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
const {PublishedMatchPick}=compile('../src/components/recommendations/PublishedMatchPick.tsx');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
// Synthetic model/market disagreement exercises layout; it is not accuracy evidence.
function fixture({line=-1,probabilities={home:45.6,draw:26.4,away:28}}={}){
 const source=match(892,NOW,{homeTeamName:'Fixture home',awayTeamName:'Fixture away',odds:{odds1:1.32,oddsX:4.6,odds2:6.3},
  handicapLine:line,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
  probabilityModel:{version:'synthetic-concise-ui',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.72,away:1.32}}}}});
 const d=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:'coherent-market-primary-v1'}).decision;assert(d);
 return {decision:d,settlement:{state:'PENDING'},scoreDistribution:buildPublishedScoreDistribution(d)};
}
const render=(row,props={})=>renderToStaticMarkup(React.createElement(PublishedMatchPick,{row,language:'zh',now:NOW,...props}));
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function parts(markup){
 const index=markup.indexOf('<details class="published-match-pick__basis">');assert(index>0);
 return {default:markup.slice(0,index),evidence:markup.slice(index)};
}

test('default shows actual HAD model tendency and labels frozen handicap identity, instead of promoting its HAD branch',()=>{
 const row=fixture(),before=JSON.stringify(row),d=row.decision;assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
 const {default:summary,evidence}=parts(render(row,{compact:true}));
 assert.match(plain(summary),/胜平负倾向 主胜/);assert.match(plain(summary),/原冻结 · 让球 · 主方向 主队让1球（-1） · 让负/);
 assert.doesNotMatch(plain(summary),/客胜/);assert.match(plain(evidence),/胜平负 · 条件分支 客胜/);
 assert.equal(JSON.stringify(row),before);
});

test('the default direction area has one score first choice and no explanation, price, probability or alternate-score wall',()=>{
 const row=fixture(),{default:summary,evidence}=parts(render(row));
 const first=row.scoreDistribution.topScores[0].label;assert.match(plain(summary),new RegExp(`比分首选 · 参考 ${first}`));
 assert.match(summary,/data-direction-summary="score-first"/);assert.doesNotMatch(summary,/Top 3|无条件概率|SP |\d+\.\d%|data-score-reference="global-top3"|混合模型估计/);
 assert.match(plain(summary),/参考 · 未校准/);assert.match(evidence,/<summary>查看依据<\/summary>/);
 assert.doesNotMatch(evidence,/<details[^>]*\bopen[\s=>]/);
});

test('collapsed evidence retains exact original probabilities, SP, Top 3, compatibility, source and frozen research',()=>{
 const row=fixture(),before=JSON.stringify(row),{evidence}=parts(render(row,{compact:true})),d=row.decision;
 for(const code of ['1','X','2'])assert(evidence.includes(`${(d.probabilities[code]*100).toFixed(1)}%`));
 assert(evidence.includes(`SP ${d.odds.toFixed(2)}`));assert.match(evidence,/data-had-distribution="unconditional"/);
 assert.match(evidence,/data-score-reference="global-top3"/);assert.match(evidence,/data-primary-compatible=/);
 assert.match(evidence,/原冻结全局比分研究|旧版同向比分研究/);assert.match(evidence,/赔率换算概率不等于独立预测/);
 assert.match(evidence,/冻结条件分支 · 非独立推荐/);assert.match(evidence,/原冻结方向 · 供复盘与版本对照/);
 assert.equal(JSON.stringify(row),before);
});

test('missing or mismatched bound score data remains pending rather than borrowing the frozen research score',()=>{
 const row=fixture();assert(row.decision.supplementaryResearch);
 for(const scoreDistribution of [undefined,null,{...row.scoreDistribution,recordHash:'f'.repeat(64)}]){
  const {default:summary,evidence}=parts(render({...row,scoreDistribution}));
  assert.match(plain(summary),/比分首选 · 参考 待更新/);assert.doesNotMatch(plain(summary),/\d+-\d+/);
  assert.match(evidence,/同源冻结比分暂不可用/);assert(evidence.includes(row.decision.supplementaryResearch.exactScore.label));
 }
});

test('ties and invalid HAD distributions never invent a single directional winner',()=>{
 const row=fixture();
 const tie=parts(render({...row,decision:{...row.decision,probabilities:{'1':.4,X:.4,'2':.2}}})).default;
 assert.match(plain(tie),/胜平负倾向 主胜 \/ 平局/);
 const invalid=parts(render({...row,decision:{...row.decision,probabilities:{'1':.9,X:.9,'2':.1}}})).default;
 assert.match(plain(invalid),/胜平负倾向 待更新/);
});

test('both handicap signs retain the frozen branch or primary label and explicit number of goals',()=>{
 for(const line of [-2,-1,1,2]){
  const row=fixture({line,probabilities:line<0?{home:80,draw:12,away:8}:{home:8,draw:12,away:80}}),before=JSON.stringify(row);
  const summary=plain(parts(render(row)).default);
  assert.match(summary,new RegExp(`主队${line<0?'让':'受让'}${Math.abs(line)}球`));
  assert.match(summary,/原冻结 · 让球 · 条件分支/);assert.match(summary,/参考 · 未校准/);
  assert.equal(JSON.stringify(row),before);
 }
});

test('compact and detailed cards retain record identity and concise status in Chinese and English',()=>{
 const row=fixture(),before=JSON.stringify(row);
 for(const language of ['zh','en'])for(const compact of [true,false]){
  const markup=render(row,{language,compact,now:Date.parse(row.decision.quoteObservedAt)+16*60000}),{default:summary,evidence}=parts(markup);
  assert(markup.includes(`data-record-hash="${row.decision.recordHash}"`));assert(markup.includes(`data-decision-id="${row.decision.decisionId}"`));
  assert.match(plain(summary),language==='zh'?/参考 · 未校准.*SP待更新/:/Reference · uncalibrated.*SP refresh pending/);
  assert.match(plain(evidence),language==='zh'?/SP待更新 · 观望/:/SP refresh pending/i);
 }
 assert.equal(JSON.stringify(row),before);
});
