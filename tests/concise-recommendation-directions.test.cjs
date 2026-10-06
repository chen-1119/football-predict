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
function fixture({id=892,line=-1,probabilities={home:45.6,draw:26.4,away:28},policy='coherent-market-primary-v1',available=true}={}){
 const source=match(id,NOW,{homeTeamName:'Fixture home',awayTeamName:'Fixture away',odds:{odds1:1.32,oddsX:4.6,odds2:6.3},
  ...(available?{handicapLine:line,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString()}:{}),
  probabilityModel:{version:'synthetic-concise-ui',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:probabilities},calculationTrace:{poisson:{lambdas:{home:1.72,away:1.32}}}}});
 const d=makeDecision(source,{now:NOW,publication:publication(NOW),primaryPolicy:policy}).decision;assert(d);
 return {decision:d,settlement:{state:'PENDING'},scoreDistribution:buildPublishedScoreDistribution(d)};
}
const render=(row,props={})=>renderToStaticMarkup(React.createElement(PublishedMatchPick,{row,language:'zh',now:NOW,...props}));
const plain=markup=>markup.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function renderCenter(row,{now=NOW,language='zh',mode='recommendations',selectedMarket,rows=[row],todayDualResearch=[]}={}){
 const file=require.resolve('../src/components/recommendations/RecommendationCenter.tsx'),module={exports:{}},native=createRequire(file);
 const data={businessDate:row.decision.businessDate,updatedAt:new Date(NOW).toISOString(),inputAsOf:new Date(NOW).toISOString(),
  lanes:{publish:{status:'ok'},combos:{status:'ok'},settlement:{status:'ok'}},current:rows,todayDualResearch,previews:[],todayCombos:[],review:{singles:[],combos:[],statistics:{}}};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Date:class extends Date{static now(){return now;}},Intl,Set,require:id=>{
  if(id==='../../hooks/useRecommendationCenter')return {useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
  if(id==='../../hooks/useRecommendationReviewPage')return {useRecommendationReviewPage:()=>({data:mode==='review'?{rows:[{...row,selectedMarket:selectedMarket??'HAD',selectedOdds:selectedMarket==='HHAD'?row.decision.handicapAnalysis?.marketReference?.odds?.[row.decision.coherentPrimary?.hhadCode]:row.decision.odds,versionKey:'a'.repeat(64),versionLabel:'fixture'}],total:1,page:1,pageCount:1,summary:{windows:{}},versions:[]}:null,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
  if(id==='./SelectionQualityNote')return compile('../src/components/recommendations/SelectionQualityNote.tsx');
  if(id==='../../services/recommendationCenterView')return compile('../src/services/recommendationCenterView.ts');
  if(id==='../../services/publishedMatchRecommendation')return compile('../src/services/publishedMatchRecommendation.ts');
  if(id==='../FollowButton')return {FollowButton:()=>null};
  if(id==='../TeamBadge')return {TeamBadge:()=>null};
  if(id==='./DayCoverage')return {DayCoverage:()=>null};
  if(id==='./DualResearchV2')return compile('../src/components/recommendations/DualResearchV2.tsx');
  if(id==='./MarketComparison')return {MarketComparison:()=>null};
  if(id==='lucide-react')return {RefreshCw:()=>null,ChevronDown:()=>null,Search:()=>null,ArrowUpRight:()=>null};
  if(id.endsWith('.css'))return {};return native(id);
 }},{filename:file});
 return renderToStaticMarkup(React.createElement(module.exports.RecommendationCenter,{language,onSelectMatch:()=>{},mode}));
}
function centerParts(markup){
 const article=markup.match(/<article class="rc-pick"[\s\S]*?<\/article>/);assert(article,'render actual recommendation center card');
 const index=article[0].indexOf('<details class="rc-pick__basis">');assert(index>0);
 return {default:article[0].slice(0,index),evidence:article[0].slice(index)};
}
function parts(markup){
 const index=markup.indexOf('<details class="published-match-pick__basis">');assert(index>0);
 return {default:markup.slice(0,index),evidence:markup.slice(index)};
}

test('-1 HHAD away anchor is the only default direction; conflicting HAD leader and score are closed evidence',()=>{
 const row=fixture(),before=JSON.stringify(row),d=row.decision;assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
 const {default:summary,evidence}=parts(render(row,{compact:true}));
 assert.match(plain(summary),/参考主方向 · 让球 主队让1球（-1） · 让负 主队不胜/);
 assert.equal((summary.match(/data-direction-summary=/g)||[]).length,1);
 assert.doesNotMatch(plain(summary),/主胜|客胜|比分|胜平负倾向/);
 assert.match(plain(evidence),/胜平负倾向 主胜/);assert.match(plain(evidence),/胜平负 · 条件分支 客胜/);
 assert.match(evidence,/data-direction-summary="score-first"/);
 assert.equal(JSON.stringify(row),before);
});

test('the default has only one reference direction, with all scores, prices and explanations folded',()=>{
 const row=fixture(),{default:summary,evidence}=parts(render(row));
 const first=row.scoreDistribution.topScores[0].label;assert.match(plain(evidence),new RegExp(`比分首选 · 参考 ${first}`));
 assert.match(summary,/data-direction-summary="frozen-primary"/);assert.doesNotMatch(summary,/比分|Top 3|无条件概率|SP |\d+\.\d%|data-score-reference="global-top3"|混合模型估计/);
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
  assert.doesNotMatch(plain(summary),/比分|\d+-\d+/);assert.match(plain(evidence),/比分首选 · 参考 待更新/);
  assert.match(evidence,/同源冻结比分暂不可用/);assert(evidence.includes(row.decision.supplementaryResearch.exactScore.label));
 }
});

test('changed or missing anchor data never invents a default direction from a HAD argmax',()=>{
 const row=fixture();
 for(const decision of [{...row.decision,coherentPrimary:undefined},{...row.decision,coherentPrimary:{...row.decision.coherentPrimary,anchorCode:'1'}},
  {...row.decision,probabilities:{'1':.4,X:.4,'2':.2}},{...row.decision,probabilities:{'1':.9,X:.9,'2':.1}}]){
  const summary=parts(render({...row,decision})).default;assert.match(plain(summary),/观望 · 待更新/);
  assert.doesNotMatch(plain(summary),/主胜|客胜|让负/);
 }
});

test('HAD anchors remain the only default direction for both handicap signs; the archived branch is not promoted',()=>{
 for(const line of [-2,-1,1,2]){
  const row=fixture({line,probabilities:line<0?{home:80,draw:12,away:8}:{home:8,draw:12,away:80}}),before=JSON.stringify(row);
  assert.equal(row.decision.coherentPrimary.anchorMarket,'HAD');
  const {default:summary,evidence}=parts(render(row));
  assert.match(plain(summary),line<0?/参考主方向 · 胜平负 主胜/:/参考主方向 · 胜平负 客胜/);
  assert.doesNotMatch(plain(summary),/主队让|主队受让|让胜|让平|让负|比分/);
  assert.match(plain(evidence),new RegExp(`主队${line<0?'让':'受让'}${Math.abs(line)}球`));
  assert.match(plain(evidence),/让球 · 条件分支/);assert.match(plain(summary),/参考 · 未校准/);
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

test('-2 can allow a narrow home win and handicap away, but still exposes just the frozen HHAD primary by default',()=>{
 const row=fixture({line:-2}),before=JSON.stringify(row),d=row.decision;
 assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.coherentPrimary.anchorCode,'2');
 assert.equal(d.coherentPrimary.jointProbabilities['1']['2']>0,true,'a one-goal home win is compatible with -2 handicap away');
 const {default:summary,evidence}=parts(render(row));
 assert.match(plain(summary),/主队让2球（-2） · 让负/);assert.doesNotMatch(plain(summary),/主胜|主队不胜/);
 assert.match(plain(evidence),/胜平负倾向 主胜/);assert.equal(JSON.stringify(row),before);
});

test('missing corresponding HHAD quote leaves the default on watch without falling back to HAD or odds rankings',()=>{
 const row=fixture(),before=JSON.stringify(row);
 for(const marketReference of [null,{...row.decision.handicapAnalysis.marketReference,odds:undefined},
  {...row.decision.handicapAnalysis.marketReference,source:'500.com:AH'},
  {...row.decision.handicapAnalysis.marketReference,odds:{'1':2.4,X:3.3,'2':0}}]){
  const next={...row,decision:{...row.decision,handicapAnalysis:{...row.decision.handicapAnalysis,marketReference}}};
  const {default:summary}=parts(render(next));assert.match(plain(summary),/观望 · 待更新/);assert.doesNotMatch(plain(summary),/主胜|让负/);
 }
 assert.equal(JSON.stringify(row),before);
});

test('missing HHAD in a valid HAD-only record retains its actual HAD anchor',()=>{
 const row=fixture({available:false}),before=JSON.stringify(row);assert.equal(row.decision.coherentPrimary.anchorMarket,'HAD');
 const {default:summary}=parts(render(row));assert.match(plain(summary),/参考主方向 · 胜平负 主胜/);assert.doesNotMatch(plain(summary),/让胜|让负|让平/);
 assert.equal(JSON.stringify(row),before);
});

test('legacy independent-market archives retain only their frozen HAD pick; incompatible HHAD pass remains in evidence',()=>{
 const row=fixture({policy:'independent-market-primary-v1'}),before=JSON.stringify(row);
 assert.equal(row.decision.tipCode,'1');const {default:summary,evidence}=parts(render(row));
 assert.match(plain(summary),/参考主方向 · 胜平负 主胜/);assert.doesNotMatch(plain(summary),/让负|让胜|让平/);
 assert.match(plain(evidence),/不追让球/);assert.equal(JSON.stringify(row),before);
 const legacy={...row,decision:{...row.decision,primaryPickPolicyVersion:undefined,coherentPrimary:undefined}};
 assert.match(plain(parts(render(legacy)).default),/参考主方向 · 胜平负 主胜/);
});

test('expired HHAD prices use the HHAD observation clock and keep the frozen direction in closed evidence',()=>{
 const row=fixture(),h=row.decision.handicapAnalysis;
 const next={...row,decision:{...row.decision,handicapAnalysis:{...h,marketReference:{...h.marketReference,observedAt:new Date(NOW-16*60000).toISOString()}}}};
 const {default:summary,evidence}=parts(render(next));assert.match(plain(summary),/观望 · SP待更新/);assert.doesNotMatch(plain(summary),/让负/);
 assert.match(plain(evidence),/主队让1球（-1） · 让负/);
});

test('closed or kicked-off records preserve the original primary and independent settlements for review',()=>{
 const row=fixture(),before=JSON.stringify(row),cutoff=Date.parse(row.decision.cutoffTime),kickoff=Date.parse(row.decision.kickoffTime);
 for(const now of [cutoff,kickoff,kickoff+3600000]){
  const {default:summary,evidence}=parts(render(row,{now}));assert.match(plain(summary),/原冻结主方向 · 让球 主队让1球（-1） · 让负/);
  assert.match(plain(summary),/已截止 · 仅供复盘/);assert.doesNotMatch(plain(summary),/参考主方向|主胜/);
  assert.match(evidence,/data-result-market="HHAD"/);
 }
 assert.equal(JSON.stringify(row),before);
});

test('a missing caller clock cannot create a fresh direction while React renders',()=>{
 const row=fixture(),{default:summary}=parts(render(row,{now:undefined}));
 assert.match(plain(summary),/观望 · 时间待核/);assert.doesNotMatch(plain(summary),/让负|已截止|参考主方向/);
});

test('actual recommendation center, fixture list and detail all default to the same single bound HHAD anchor',()=>{
 for(const line of [-1,-2]){
  const row=fixture({line}),before=JSON.stringify(row);
  for(const language of ['zh','en']){
   const center=centerParts(renderCenter(row,{language}));
   assert.equal((center.default.match(/data-direction-summary=/g)||[]).length,1);
   assert.match(center.default,/data-primary-market="HHAD"/);
   assert.doesNotMatch(center.default,/had-model-tendency|score-first|global-top3|rc-primary-pick--had|rc-primary-pick--hhad/);
   assert.doesNotMatch(plain(center.default),language==='zh'?/主胜|客胜|比分首选/:/1X2 tendency|Score first choice/);
   assert.match(center.evidence,/data-direction-summary="had-model-tendency"/);assert.match(center.evidence,/data-direction-summary="score-first"/);
   assert.match(center.evidence,/data-score-reference="global-top3"/);assert.doesNotMatch(center.evidence,/<details[^>]*\bopen[\s=>]/);
   const centerDirection=center.default.match(/<div class="published-match-pick__direction"[\s\S]*?<\/div>/)?.[0];assert(centerDirection);
   for(const compact of [true,false])assert.equal(parts(render(row,{language,compact})).default.match(/<div class="published-match-pick__direction"[\s\S]*?<\/div>/)?.[0],centerDirection);
  }
  assert.equal(JSON.stringify(row),before);
 }
});

test('actual center keeps missing HHAD anchors on watch and retains exact probabilities and independent settlement facts in evidence',()=>{
 const row=fixture(),missing={...row,decision:{...row.decision,coherentPrimary:undefined}},before=JSON.stringify(missing);
 const center=centerParts(renderCenter(missing));assert.match(plain(center.default),/观望 · 待更新/);assert.doesNotMatch(plain(center.default),/主胜|让负/);
 assert.match(center.evidence,/data-had-distribution="unconditional"/);
 for(const code of ['1','X','2'])assert(center.evidence.includes(`${(row.decision.probabilities[code]*100).toFixed(1)}%`));
 assert.equal(JSON.stringify(missing),before);
});

test('an explicit center review market shows only that market original record, never another default anchor beside it',()=>{
 const row=fixture(),before=JSON.stringify(row),now=Date.parse(row.decision.cutoffTime)+60000;
 for(const selectedMarket of ['HAD','HHAD']){
  const center=centerParts(renderCenter(row,{mode:'review',selectedMarket,now}));
  assert.equal((center.default.match(/data-direction-summary=/g)||[]).length,1);assert.match(center.default,new RegExp(`data-primary-market="${selectedMarket}"`));
  assert.match(center.default,/data-direction-role="record"/);
  if(selectedMarket==='HAD'){
   assert.match(plain(center.default),/原冻结条件分支 · 胜平负 客胜/);assert.doesNotMatch(plain(center.default),/让负|主胜|主队让/);
  }else{
   assert.match(plain(center.default),/原冻结记录 · 让球 主队让1球（-1） · 让负/);assert.doesNotMatch(plain(center.default),/客胜|主胜/);
  }
  assert.match(center.evidence,/rc-review-selection/);assert.match(center.evidence,/data-score-reference="global-top3"/);
 }
 assert.equal(JSON.stringify(row),before);
});

test('a malformed anchor probability or future corresponding quote clock cannot produce a default direction',()=>{
 const row=fixture();
 for(const decision of [{...row.decision,modelProbability:NaN},{...row.decision,coherentPrimary:{...row.decision.coherentPrimary,anchorProbability:NaN}},
  {...row.decision,handicapAnalysis:{...row.decision.handicapAnalysis,marketReference:{...row.decision.handicapAnalysis.marketReference,observedAt:new Date(NOW+1).toISOString()}}}]){
  for(const summary of [parts(render({...row,decision})).default,centerParts(renderCenter({...row,decision})).default]){
   assert.match(plain(summary),/观望 · 待更新/);assert.doesNotMatch(plain(summary),/主胜|让负/);
  }
 }
});

test('the HAD-only concentration note is closed original-record evidence, preserving its exact count and direction',()=>{
 const rows=[892,893,894].map(id=>fixture({id})),before=JSON.stringify(rows);
 for(const language of ['zh','en']){
  const markup=renderCenter(rows[0],{rows,language}),note=markup.match(/<details class="rc-direction-record-evidence">[\s\S]*?<\/details>/)?.[0];
  assert(note,'the existing same-direction note remains present');assert.doesNotMatch(note,/<details[^>]*\bopen[\s=>]/);
  assert.match(note,/data-direction-concentration="2"/);
  assert.match(plain(note),language==='zh'?/原冻结HAD记录同向.*3 场胜平负记录均为客胜.*可能包含条件分支.*不是当前主方向汇总/:/Frozen HAD records.*3 match-day 1X2 records are Away.*conditional branches.*not a current-primary aggregate/);
  assert.doesNotMatch(markup.slice(0,markup.indexOf('<details class="rc-direction-record-evidence">')),/场方向均为|published match-day directions are/);
 }
 assert.equal(JSON.stringify(rows),before);
});

test('dual-choice research is closed study evidence, retaining the original selections, probabilities and settlement',()=>{
 const row=fixture(),research={version:'dual-choice-research-v2',id:'synthetic-study-closed-evidence',sourceMatchId:row.decision.sourceMatchId,
  matchId:row.decision.matchId,eventVersion:row.decision.eventVersion,businessDate:row.decision.businessDate,
  homeTeamName:row.decision.homeTeamName,awayTeamName:row.decision.awayTeamName,recordedAt:new Date(NOW).toISOString(),cutoffAt:row.decision.cutoffTime,
  recordHash:'a'.repeat(64),researchOnly:true,formalPromotion:false,totalStake:2,unionProbability:.736,
  selections:[{market:'HHAD',tipCode:'2',handicapLine:-1,odds:2.74,modelProbability:.544,quoteObservedAt:new Date(NOW).toISOString()},
   {market:'HHAD',tipCode:'X',handicapLine:-1,odds:3.3,modelProbability:.192,quoteObservedAt:new Date(NOW).toISOString()}],
  settlement:{state:'WON',grossReturn:2.74,netProfit:.74,resultEventId:'synthetic-study-result'}};
 const before=JSON.stringify({row,research});
 for(const language of ['zh','en']){
  const markup=renderCenter(row,{language,todayDualResearch:[research]}),start=markup.indexOf('<details class="rc-dual-research-evidence">');assert(start>=0);
  const end=markup.indexOf('</details>',start),study=markup.slice(start,end+10);
  assert.doesNotMatch(study,/<details[^>]*\bopen[\s=>]/);assert.doesNotMatch(markup.slice(0,start),/synthetic-study-closed-evidence|rc-dual-research__choices/);
  assert.match(study,/data-research-id="synthetic-study-closed-evidence"/);assert.match(study,/data-research-market-pair="HHAD\+HHAD"/);
  assert.match(plain(study),language==='zh'?/双选研究依据 · 非正式推荐.*至少一项命中/:/Dual-choice study evidence · not formal picks.*One or more won/);
  assert.match(study,/SP 2\.74/);assert.match(study,/54\.4%/);assert.match(study,/SP 3\.30/);assert.match(study,/19\.2%/);assert.match(study,/73\.6%/);
 }
 assert.equal(JSON.stringify({row,research}),before);
});
