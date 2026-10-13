'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript');
const {createRequire}=require('node:module'),native=createRequire(require.resolve('../src/components/recommendations/PrdPaperDirections.tsx'));
const root=path.resolve(__dirname,'..');
function compile(relative){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Date,require:id=>id==='./coherentPrimarySelection.cjs'?require('../src/services/coherentPrimarySelection.cjs'):id==='./publishedRecommendationStatus.cjs'?require('../src/services/publishedRecommendationStatus.cjs'):id==='./publishedReviewCoverage.ts'?require('../src/services/publishedReviewCoverage.ts'):id==='../../services/recommendationCenterView'?view:native(id)});return module.exports;}
const view=compile('src/services/recommendationCenterView.ts'),{PrdPaperDirections}=compile('src/components/recommendations/PrdPaperDirections.tsx'),React=native('react'),{renderToStaticMarkup}=native('react-dom/server');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const teamId=require('../scripts/storedResultTeamIdentity.cjs').derivedTeamId;
const DAY='2026-10-07',UPDATED='2026-10-07T10:00:01.000Z',NOW=Date.parse('2026-10-07T10:00:10.000Z');
function seal(record){const {contentHash,...body}=record;return {...body,contentHash:hash(body)};}
function record({market='HHAD',line=-1,code='2',sp=2.38,probability=.62,marketProbability=.48}={}){
 return seal({version:'prd-paper-direction-view-v1',id:'prd_paper_'+ 'a'.repeat(64),recordHash:'b'.repeat(64),businessDate:DAY,sourceMatchId:'2041823',eventVersion:'2026-10-07T18:00:00.000Z',homeTeamId:teamId('主队甲'),awayTeamId:teamId('客队乙'),homeTeamName:'主队甲',awayTeamName:'客队乙',decidedAt:'2026-10-07T10:00:00.000Z',createdAt:'2026-10-07T10:00:00.100Z',cutoffAt:'2026-10-07T14:00:00.000Z',forecastAsOf:'2026-10-07T09:55:00.000Z',decisionPriceAsOf:'2026-10-07T09:59:59.100000001Z',modelHash:'c'.repeat(64),forecastHash:'d'.repeat(64),paperArtifactHash:'e'.repeat(64),acknowledgementHash:'f'.repeat(64),paperCommitObservedAt:'2026-10-07T10:00:00.200123Z',formalEligible:false,productionEligible:false,primary:null,companion:null,modelValidation:'uncalibrated',selectionStatus:'paper-primary',paperPrimary:{market,tipCode:code,handicapLine:line,probability,sp,marketProbability,edge:probability-marketProbability,expectedValue:probability*sp-1,quoteReceivedAt:'2026-10-07T09:59:59.100000001Z',quoteRequestedAt:'2026-10-07T09:59:59.000000000Z',quoteHash:'1'.repeat(64)},reasons:['paper-only-no-production-admission']});
}
function envelope(records=[record()]){return {version:'prd-paper-pipeline-view-v1',businessDate:DAY,updatedAt:UPDATED,status:records.length?'paper-recorded':'awaiting-inputs',records,blockedCount:0,truncated:false,formalEligible:false,formalStrategyChanged:false,requestedStrategy:'prd-paper-recommendation-v1',activeFormalStrategy:null,legacyReferenceStrategy:'coherent-market-primary-v1',reasons:[]};}
const parse=p=>view.parsePrdPaperDirections(p,DAY,UPDATED),render=(data,extra={})=>renderToStaticMarkup(React.createElement(PrdPaperDirections,{data,language:'zh',now:NOW,...extra}));
test('bounded browser SHA256 matches Node canonical hashes for UTF8 and multi-block boundaries',()=>{
 for(const value of ['',{},[],{z:'足球⚽',a:[null,true,1.25,'中文']},...Array.from({length:8},(_,i)=>({text:'x'.repeat([1,55,56,63,64,127,512,16000][i])}))])assert.equal(view.prdPaperPublicHash(value),hash(value));
 assert.throws(()=>view.prdPaperPublicHash({text:'x'.repeat(16385)}),/budget/);assert.throws(()=>view.prdPaperPublicHash({bad:Infinity}));
});
test('paper parsing preserves nano clocks and verifies the seal including actual storage acknowledgement',()=>{
 const original=envelope(),before=JSON.stringify(original),p=parse(original);assert.equal(p.records[0].paperCommitObservedAt,'2026-10-07T10:00:00.200123Z');assert.equal(p.records[0].paperPrimary.quoteReceivedAt,'2026-10-07T09:59:59.100000001Z');assert.equal(p.records[0].formalEligible,false);assert.equal(JSON.stringify(original),before);
 const changed=envelope();changed.records[0].acknowledgementHash='2'.repeat(64);assert.throws(()=>parse(changed),/seal/);
 assert.equal(require('../src/services/prdPaperRecommendation.cjs').validPublicPrdPaperProjection(original.records[0]),true);
});
test('schema, promotion, date, identity and missing commit metadata fail closed',()=>{
 for(const mutate of [r=>{r.version='unknown';},r=>{r.formalEligible=true;},r=>{r.productionEligible=true;},r=>{r.primary={};},r=>{r.modelValidation='validated';},r=>{r.businessDate='2026-10-06';},r=>{r.homeTeamId=r.awayTeamId;},r=>{r.homeTeamName='其他队';},r=>{r.paperCommitObservedAt=null;},r=>{r.paperArtifactHash=null;},r=>{r.recordHash='bad';},r=>{r.extra=true;}]){
  const p=envelope();mutate(p.records[0]);p.records[0]=seal(p.records[0]);assert.throws(()=>parse(p));
 }
 for(const mutate of [p=>{p.formalStrategyChanged=true;},p=>{p.activeFormalStrategy='prd-paper-recommendation-v1';},p=>{p.businessDate='2026-02-30';},p=>{p.updatedAt='2026-10-07T10:00:02Z';},p=>{p.records.push(structuredClone(p.records[0]));},p=>{p.unknown=true;}]){const p=envelope();mutate(p);assert.throws(()=>parse(p));}
 for(const code of [...Array.from({length:32},(_,i)=>i),127]){const p=envelope();p.records[0]=seal({...p.records[0],reasons:['paper-'+String.fromCharCode(code)+'only']});assert.throws(()=>parse(p),/Invalid PRD paper text/);}
 for(const code of [32,126,128]){const p=envelope();p.records[0]=seal({...p.records[0],reasons:['paper-'+String.fromCharCode(code)+'only']});assert.equal(parse(p).records.length,1);}
 assert.throws(()=>parse(null));
});
test('HAD/HHAD lines and SP arithmetic remain market-specific without old market borrowing',()=>{
 for(const config of [{market:'HAD',line:0,code:'1',sp:1.8,probability:.7},{market:'HHAD',line:1,code:'1'},{market:'HHAD',line:-2,code:'X'}])assert.equal(parse(envelope([record(config)])).records[0].paperPrimary.market,config.market);
 for(const mutate of [q=>{q.market='HAD';},q=>{q.handicapLine=0;},q=>{q.handicapLine=.5;},q=>{q.handicapLine=6;},q=>{q.sp=5.8;},q=>{q.sp=2.38001;},q=>{q.probability=.2;},q=>{q.edge=.05;},q=>{q.quoteHash='wrong-market-label';}]){const p=envelope();mutate(p.records[0].paperPrimary);p.records[0]=seal(p.records[0]);assert.throws(()=>parse(p));}
 const html=render(parse(envelope()));assert.match(html,/主队 -1 · 让负/);assert.match(html,/SP 2\.38/);assert.doesNotMatch(html,/5\.80/);
});
test('knowledge, quote TTL, sales cutoff and postcommit 30-second clocks preserve sub-millisecond boundaries',()=>{
 for(const mutate of [r=>{r.forecastAsOf='2026-10-07T10:00:00.000000001Z';},r=>{r.paperPrimary.quoteReceivedAt='2026-10-07T10:00:00.000000001Z';},r=>{r.paperPrimary.quoteRequestedAt='2026-10-07T09:44:59.999999999Z';},r=>{r.paperCommitObservedAt='2026-10-07T10:00:30.000000001Z';},r=>{r.paperCommitObservedAt='2026-10-07T10:00:00.099999999Z';},r=>{r.cutoffAt=r.paperCommitObservedAt;},r=>{r.cutoffAt='2026-10-07T19:00:00Z';},r=>{r.decidedAt='2026-02-30T10:00:00Z';}]){const p=envelope();mutate(p.records[0]);p.records[0]=seal(p.records[0]);assert.throws(()=>parse(p));}
 const p=envelope();p.updatedAt='2026-10-07T10:00:30.000Z';p.records[0]=seal({...p.records[0],paperCommitObservedAt:p.updatedAt});assert.equal(view.parsePrdPaperDirections(p,DAY,p.updatedAt).records.length,1);
});
test('watch and empty paper states never fabricate a pick or reuse a legacy direction',()=>{
 for(const status of ['watch-ev-tie','watch-no-eligible-option']){const r=seal({...record(),selectionStatus:status,paperPrimary:null}),html=render(parse(envelope([r])));assert.match(html,/观望/);assert.doesNotMatch(html,/SP 2\.38/);}
 const empty=parse(envelope([]));assert.equal(empty.records.length,0);assert.match(render(empty),/暂无纸面方向/);assert.doesNotMatch(render(empty),/让负|主胜/);
 const blocked={...envelope([]),status:'blocked',blockedCount:3,reasons:['model-unavailable']};assert.match(render(parse(blocked)),/暂未通过校验/);assert.match(render(parse(blocked)),/3 场等待有效输入/);
 const waiting={...envelope([]),blockedCount:2};assert.equal(parse(waiting).blockedCount,2);
 const archived={...envelope(),status:'blocked',reasons:['new-paper-input-failed']};assert.match(render(parse(archived)),/更新待验/);assert.match(render(parse(archived)),/冻结 SP 2\.38/);
 const r=record();r.paperPrimary=null;assert.throws(()=>parse(envelope([seal(r)])),/selection state/);
});
test('paper cards stay concise, evidence is collapsed, and stale/closed directions expose frozen SP',()=>{
 const p=parse(envelope()),html=render(p);assert.match(html,/纸面 · 未校准/);assert.match(html,/<details><summary>依据<\/summary>/);assert.doesNotMatch(html,/<details[^>]*open/);assert.doesNotMatch(html,/8周完成|正式推荐|提高命中率/);
 assert.match(render(p,{now:Date.parse('2026-10-07T10:16:00Z')}),/冻结 SP 2\.38/);assert.match(render(p,{now:Date.parse('2026-10-07T14:00:00Z')}),/冻结 SP 2\.38/);
 assert.match(render(p,{now:Date.parse('2026-10-08T10:00:10Z')}),/暂无纸面方向/);assert.doesNotMatch(render(p,{now:Date.parse('2026-10-08T10:00:10Z')}),/让负/);
 assert.match(render(p,{failed:true}),/读取失败/);assert.doesNotMatch(render(p,{failed:true}),/让负/);
 const base=p.records[0],ttl=Date.parse(base.paperPrimary.quoteRequestedAt)+15*60000;assert.equal(view.prdPaperQuoteIsCurrent(base,ttl),true);assert.equal(view.prdPaperQuoteIsCurrent(base,ttl+1),false);assert.match(render(p,{now:ttl+1}),/冻结 SP/);
 const later=structuredClone(base);later.paperCommitObservedAt='2026-10-07T10:00:10.000000001Z';assert.equal(view.prdPaperQuoteIsCurrent(later,NOW),false);
 assert.equal(view.prdPaperQuoteIsCurrent(base,NaN),false);
});
test('new optional paper codec preserves old response and records; explicit invalid paper does not fall back',()=>{
 const summary={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null},legacy={version:'recommendation-center-v1',updatedAt:UPDATED,businessDate:DAY,inputAsOf:null,resultAsOf:null,lanes:{},current:[],previews:[],todayCombos:[],overlapDecisionIds:[],review:{singles:[],combos:[],limit:0,statistics:{single:summary,two:summary,three:summary},definition:'frozen legacy records'},excludedCorruptRecords:0,modelValidation:'unvalidated'};
 assert.equal(view.parseRecommendationCenter({recommendationCenter:legacy}).prdPaper,undefined);
 const before=JSON.stringify(legacy),withPaper={...legacy,prdPaper:envelope()},parsed=view.parseRecommendationCenter({recommendationCenter:withPaper});assert.equal(parsed.prdPaper.records.length,1);assert.equal(parsed.current.length,0);assert.equal(JSON.stringify(legacy),before);
 assert.throws(()=>view.parseRecommendationCenter({recommendationCenter:{...legacy,prdPaper:null}}));
});
