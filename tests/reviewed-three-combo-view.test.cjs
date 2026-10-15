'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const reviewed=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const businessDate='2030-01-01',createdAt='2030-01-01T08:00:00.000Z',commitObservedAt='2030-01-01T08:00:01.000Z',updatedAt='2030-01-01T09:00:00.000Z';
function loadView(){
 const filename=path.resolve('src/services/recommendationCenterView.ts'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);return m.exports;
}
const view=loadView();
function compile(file,requireFn,date=Date){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:m,exports:m.exports,Date:date,Intl,require:requireFn});return m.exports;}
const ui=require('../scripts/lib/loadReviewTsForVerification.cjs')(ts,path.resolve('src/components/recommendations/ReviewedAnalysis.tsx'));
function record(index,override={}){
 return {eventId:String(100+index),eventVersion:'2030-01-01T14:00:00.000Z',businessDate,matchNum:`周二00${index+1}`,homeTeamId:`home-${index}`,awayTeamId:`away-${index}`,homeTeamName:`Home ${index}`,awayTeamName:`Away ${index}`,market:'HAD',selection:'h',sp:1.85,originalSp:1.81,scores:[[2,0],[2,1]],confidence:'高',reason:'Synthetic reviewed evidence',analysisUrl:'https://example.com/reviewed-preview',limitations:['首发未核实'],cutoffAt:'2030-01-01T12:00:00.000Z',quoteObservedAt:'2030-01-01T07:59:00.000Z',publicationMethod:'reviewed-editorial',formalEligible:false,modelProbability:null,modelVersion:null,...override};
}
function combo(records,band){const legs=records.map(r=>({eventId:r.eventId,matchNum:r.matchNum,market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp:r.sp}));
 return {band,legs,product:Number(records.reduce((product,r)=>product*BigInt(Math.round(r.sp*1000)),1n))/1000**records.length,confidence:records.some(r=>r.confidence==='低')?'低':records.some(r=>r.confidence==='中')?'中':'高'};
}
function body(){
 const records=[record(0),record(1,{market:'HHAD',handicap:-1,selection:'a',sp:2.45,scores:[[1,1],[0,1]],confidence:'低'}),record(2,{market:'HHAD',handicap:2,selection:'h',sp:1.65,scores:[[0,1],[1,2]],confidence:'中'}),record(3,{selection:'d',sp:3.2,scores:[[1,1],[2,2]],confidence:'中'})];
 return {version:'reviewed-analysis-view-v1',businessDate,createdAt,commitObservedAt,updatedAt,formalEligible:false,publicationHash:'a'.repeat(64),records,combos:[combo(records.slice(0,2),2.5)],threeCombos:[combo(records.slice(0,3),5)]};
}
test('verified persisted original pairs and triples survive historical parsing without creating or repricing groups',async()=>{
 const original=reviewed.seal({...body(),draftHash:'c'.repeat(64)}),at='2030-01-02T08:00:00.000Z';
 const archive=require('../services/recommendation/comboArchive.cjs'),saved=archive.prepare(original,{generationId:'g-'+'a'.repeat(64),committedAt:original.commitObservedAt},original.updatedAt),json=JSON.stringify(saved.archive);
 const row={artifact_key:saved.key,artifact_version:archive.VERSION,generated_at:saved.archive.createdAt,updated_at:saved.archive.createdAt,payload_json:json,payload_sha256:reviewed.sha(json),payload_bytes:Buffer.byteLength(json)},calls=[];
 const client={async query(sql,args){calls.push(sql);if(sql.startsWith('SELECT artifact_key,payload_bytes'))return{rows:[{artifact_key:saved.key,payload_bytes:row.payload_bytes,bytes:row.payload_bytes}]};if(sql.includes("dataset='current'"))return{rows:[]};assert.equal(args[0],saved.key);return{rows:[row]};}};
 const {contentHash,...before}=original;void contentHash;
 const historical=await require('../server/researchFrozenCombos.cjs').freezeOriginalGroups(client,reviewed.seal({...before,updatedAt:at,combos:[],threeCombos:[]}),at,{anchor:false});
 const parsed=view.parseReviewedAnalysisHistory(historical,'2030-01-02',at);assert.deepEqual(parsed.combos.filter(c=>c.legs.length),original.combos);assert.deepEqual(parsed.threeCombos.filter(c=>c.legs.length),original.threeCombos);assert.ok(parsed.comboFreeze.every(f=>f.frozen));
 for(const tab of ['two','three']){const html=render(parsed,tab,Date.parse(at));assert.match(html,/历史记录，非今日新荐/);assert.match(html,/整组冻结/);assert.doesNotMatch(html,/未找到该竞彩日已保存/);}
 assert.ok(calls.every(s=>s.startsWith('SELECT')));
 const open=structuredClone(historical);open.comboFreeze[0].frozen=false;delete open.contentHash;assert.throws(()=>view.parseReviewedAnalysisHistory(reviewed.seal(open),'2030-01-02',at));
 const unbound=structuredClone(historical);delete unbound.comboFreeze;delete unbound.comboFreezePolicy;delete unbound.contentHash;assert.throws(()=>view.parseReviewedAnalysisHistory(reviewed.seal(unbound),'2030-01-02',at));
});
const parse=b=>view.parseReviewedAnalysis(reviewed.seal(b),b.businessDate,b.updatedAt);
const render=(data,tab,now=Date.parse(updatedAt),failed=false)=>renderToStaticMarkup(React.createElement(ui.ReviewedAnalysisPanel,{data,tab,now,failed}));

test('sealed mixed-market three legs retain exact source direction, signed line, SP product and lowest confidence',()=>{
 const b=body(),before=JSON.stringify(b),parsed=parse(b);assert.equal(parsed.threeCombos[0].product,7.478625);assert.equal(parsed.threeCombos[0].confidence,'低');
 assert.deepEqual(parsed.threeCombos[0].legs,b.threeCombos[0].legs);assert.equal(parsed.threeCombos[0].legs[1].handicap,-1);assert.equal(parsed.threeCombos[0].legs[2].handicap,2);assert.equal(JSON.stringify(b),before);
});
test('old sealed views without optional threeCombos remain readable without inventing a three-leg lane',()=>{const b=body();delete b.threeCombos;const parsed=parse(b);assert.deepEqual(parsed.threeCombos,[]);assert.equal(parsed.combos.length,1);assert.match(render(parsed,'three'),/暂无已保存的3串1组合/);});
test('decimal prices multiply exactly without three-digit truncation or large-product float rejection',()=>{
 for(const [prices,expected] of [[[1.2345,2,3],7.407],[[266.45,136.55,459.65],16723789.538375]]){
  const b=body();b.records=b.records.slice(0,3).map((r,i)=>({...r,sp:prices[i]}));b.combos=[];b.threeCombos=[combo(b.records,2.5)];b.threeCombos[0].product=expected;
  assert.equal(parse(b).threeCombos[0].product,expected);b.threeCombos[0].product=expected+Math.max(Number.EPSILON,Math.abs(expected)*Number.EPSILON);assert.throws(()=>parse(b),/product/);
 }
});
test('empty old and new envelopes preserve the empty lane and reject manufactured combos',()=>{
 for(const include of [false,true]){const b={version:'reviewed-analysis-view-v1',businessDate,updatedAt,formalEligible:false,records:[],combos:[],...(include?{threeCombos:[]}: {})};assert.deepEqual(parse(b).threeCombos,[]);b.threeCombos=[{band:5,product:null,confidence:null,legs:[]}];assert.throws(()=>parse(b),/empty/);}
});
for(const [name,mutate] of [
 ['duplicate event',b=>{b.threeCombos[0].legs[2]={...b.threeCombos[0].legs[0]};}],
 ['only two events',b=>{b.threeCombos[0].legs.pop();}],
 ['four events',b=>{b.threeCombos[0].legs.push(combo([b.records[3]],2.5).legs[0]);}],
 ['unknown event',b=>{b.threeCombos[0].legs[1].eventId='999';}],
 ['switched market',b=>{b.threeCombos[0].legs[1].market='HAD';delete b.threeCombos[0].legs[1].handicap;}],
 ['wrong signed handicap',b=>{b.threeCombos[0].legs[1].handicap=1;}],
 ['HAD with handicap',b=>{b.threeCombos[0].legs[0].handicap=-1;}],
 ['changed direction',b=>{b.threeCombos[0].legs[1].selection='h';}],
 ['changed match number',b=>{b.threeCombos[0].legs[1].matchNum='周二099';}],
 ['current price replacing frozen price',b=>{b.threeCombos[0].legs[1].sp=2.46;}],
 ['incorrect multiplication',b=>{b.threeCombos[0].product+=0.01;}],
 ['below requested band',b=>{b.threeCombos[0].band=10;}],
 ['confidence raised',b=>{b.threeCombos[0].confidence='中';}],
 ['invalid confidence',b=>{b.threeCombos[0].confidence='未定';}],
 ['same combination in another band',b=>{b.threeCombos.push({...b.threeCombos[0],band:2.5,legs:[...b.threeCombos[0].legs].reverse()});}],
 ['duplicate band',b=>{b.threeCombos.push(combo([b.records[0],b.records[2],b.records[3]],5));}],
 ['unsupported band',b=>{b.threeCombos[0].band=3;}],
 ['null optional field',b=>{b.threeCombos=null;}],
 ['too many bands',b=>{b.threeCombos=Array(4).fill(b.threeCombos[0]);}],
 ['oversized combo component',b=>{b.threeCombos[0].extra=Array(512).fill(0);}],
 ['oversized combo text',b=>{b.threeCombos[0].extra='x'.repeat(16385);}],
 ['post-cutoff projection',b=>{b.records[2].cutoffAt=updatedAt;}],
])test(`three-combo parser rejects ${name} even with a recomputed public seal`,()=>{const b=body();mutate(b);assert.throws(()=>parse(b));});
test('two-combo parser also enforces exact minimum confidence and cutoff',()=>{
 for(const mutate of [b=>{b.combos[0].confidence='高';},b=>{b.records[1].cutoffAt=updatedAt;}]){const b=body();b.threeCombos=[];mutate(b);assert.throws(()=>parse(b));}
});
test('three-combo cutoff uses nanoseconds rather than truncating to the same millisecond',()=>{
 const b=body();b.records[2].cutoffAt='2030-01-01T09:00:00.000000001Z';assert.equal(parse(b).threeCombos.length,1);b.updatedAt='2030-01-01T09:00:00.000000001Z';assert.throws(()=>parse(b),/cutoff/);
});
test('unchanged public seal detects three-combo price tampering',()=>{const b=reviewed.seal(body());b.threeCombos[0].legs[0].sp=2.1;assert.throws(()=>view.parseReviewedAnalysis(b,b.businessDate,b.updatedAt),/seal/);});
test('32 individually bounded records plus both combo arrays fit the daily aggregate budget',()=>{
 const b=body();b.records=Array.from({length:32},(_,index)=>record(index,{reason:'证据'.repeat(250)}));b.combos=reviewed.combinations(b.records,2);b.threeCombos=reviewed.combinations(b.records,3);
 const parsed=parse(b);assert.equal(parsed.records.length,32);assert.equal(parsed.threeCombos.length,3);assert.throws(()=>view.prdPaperPublicHash(b),/budget/);b.records.push(record(32));assert.throws(()=>parse(b),/envelope/);
});
test('three tab renders real HHAD signs, publication prices and volatility without confidence labels or model probability',()=>{
 const html=render(parse(body()),'three');assert.match(html,/精选3串1/);assert.match(html,/让负\(-1\) 2\.45/);assert.match(html,/让胜\(\+2\) 1\.65/);assert.match(html,/7\.4786.*高波动/);assert.match(html,/发布时官方 SP，非即时价/);assert.match(html,/没有模型命中概率或收益验证/);assert.doesNotMatch(html,/精选2串1|暂无未截止|信心/);
});
test('single, two and three views omit visible confidence while preserving all stored values',()=>{
 const data=parse(body()),before=JSON.stringify(data);
 for(const tab of ['single','two','three']){const html=render(data,tab);assert.doesNotMatch(html,/信心|confidence/i);assert.match(html,/人工审核/);assert.match(html,/1\.85/);}
 assert.equal(JSON.stringify(data),before);assert.equal(data.records[1].confidence,'低');assert.equal(data.threeCombos[0].confidence,'低');
});
test('rendered price multiplication retains all frozen decimal precision',()=>{
 const b=body();b.records=b.records.slice(0,3).map((r,i)=>({...r,sp:[1.2345,2,3][i]}));b.combos=[];b.threeCombos=[{...combo(b.records,5),product:7.407}];
 const html=render(parse(b),'three');assert.match(html,/1\.2345.*2\.00.*3\.00.*= 7\.407/);assert.doesNotMatch(html,/1\.23 ×|7\.4100/);
});
test('both tabs retain saved combos after cutoff as closed history without rewriting the stored view',()=>{
 const b=body();b.records[2].cutoffAt='2030-01-01T09:45:00.000Z';b.records[1].cutoffAt='2030-01-01T10:00:00.000Z';const data=parse(b),before=JSON.stringify(data);
 assert.match(render(data,'three',Date.parse('2030-01-01T09:44:59.999Z')),/data-reviewed-combo-state="open"/);
 for(const stamp of ['2030-01-01T09:45:00.000Z','2030-01-01T09:59:00.000Z']){const now=Date.parse(stamp);assert.match(render(data,'three',now),/data-reviewed-combo-state="closed"/);assert.match(render(data,'three',now),/已停售.*不作为当前推荐/);assert.match(render(data,'two',now),/data-reviewed-combo-state="open"/);}
 const after=Date.parse('2030-01-01T10:00:00.000Z');assert.match(render(data,'two',after),/data-reviewed-combo-state="closed"/);assert.match(render(data,'single',after),/已截止冻结/);assert.equal(JSON.stringify(data),before);
});
test('a prior day keeps saved combos as history while failures, future days and invalid cutoffs cannot expose a combo',()=>{
 const data=parse(body());assert.equal(render(data,'three',Date.parse(updatedAt),true),'');assert.equal(render(data,'three',Date.parse('2029-12-31T09:00:00Z')),'');
 const html=render(data,'three',Date.parse('2030-01-02T09:00:00Z'));assert.match(html,/data-reviewed-combo-state="historical"/);assert.match(html,/2030-01-01 竞彩日.*历史记录，非今日新荐/);assert.match(html,/已停售/);assert.doesNotMatch(html,/data-reviewed-combo-state="open"/);
 data.records[2].cutoffAt='invalid';assert.doesNotMatch(render(data,'three'),/data-reviewed-combo-band/);
});

const historyAt='2030-01-01T16:00:01.000Z';
function historyBody(){return {...body(),updatedAt:historyAt,records:Array.from({length:27},(_,i)=>record(i)),combos:[],threeCombos:[]};}
function historyEnvelope(history=reviewed.seal(historyBody())){
 const zero={published:0,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
 return {recommendationCenter:{version:'recommendation-center-v1',businessDate:'2030-01-02',updatedAt:historyAt,inputAsOf:null,resultAsOf:null,lanes:{},current:[],previews:[],todayCombos:[],todayDualResearch:[],overlapDecisionIds:[],excludedCorruptRecords:0,modelValidation:'unvalidated',
  reviewedAnalysis:{version:'reviewed-analysis-view-v1',businessDate:'2030-01-02',updatedAt:historyAt,formalEligible:false,records:[],combos:[],threeCombos:[]},reviewedAnalysisHistory:history,
  review:{singles:[],combos:[],limit:50,statistics:{single:zero,two:zero,three:zero},definition:'Synthetic frozen history'}}};
}
test('actual center parser accepts 27 original history singles without replacing the current day or manufacturing combos',()=>{
 const response=historyEnvelope(),before=JSON.stringify(response),parsed=view.parseRecommendationCenter(response);
 assert.equal(parsed.businessDate,'2030-01-02');assert.equal(parsed.reviewedAnalysis.records.length,0);assert.equal(parsed.reviewedAnalysisHistory.businessDate,businessDate);assert.equal(parsed.reviewedAnalysisHistory.records.length,27);
 assert.deepEqual(parsed.reviewedAnalysisHistory.combos,[]);assert.deepEqual(parsed.reviewedAnalysisHistory.threeCombos,[]);assert.equal(JSON.stringify(response),before);
 for(const tab of ['single','two','three']){const text=center(parsed,Date.parse(historyAt),tab);assert.match(text,/历史推荐/);assert.match(text,/2030-01-01/);assert.match(text,/27 场原冻结记录/);assert.doesNotMatch(text,/今日推荐|信心|暂无可展示的组合|暂时没有可展示的推荐/);if(tab==='single'){assert.match(text,/Home 26/);assert.match(text,/已截止冻结/);}else assert.match(text,new RegExp(`未找到该竞彩日已保存的原${tab==='two'?2:3}串1组合`));}
});
test('history rejects incorrect clocks, day, seal, missing records and retroactively assembled combos',()=>{
 for(const mutate of [b=>{b.businessDate='2030-01-02';},b=>{b.updatedAt=updatedAt;},b=>{b.records=[];},b=>{b.combos=[{band:2.5,product:null,confidence:null,legs:[]}];},b=>{b.threeCombos=[{band:5,product:null,confidence:null,legs:[]}];}]){const b=historyBody();mutate(b);assert.throws(()=>view.parseRecommendationCenter(historyEnvelope(reviewed.seal(b))));}
 const response=historyEnvelope();response.recommendationCenter.reviewedAnalysisHistory.records[0].sp=9;assert.throws(()=>view.parseRecommendationCenter(response),/seal/);
});
test('current reviewed records take precedence over history when present',()=>{
 const data=view.parseRecommendationCenter(historyEnvelope());data.reviewedAnalysis=parse(body());data.reviewedAnalysisHistory.records[0].homeTeamName='HISTORY ONLY';
 const text=center(data,Date.parse(historyAt),'single');assert.match(text,/4 场原冻结记录/);assert.doesNotMatch(text,/HISTORY ONLY|27 场原冻结记录/);
});

function archiveHistory(){
 const h={...historyBody(),draftHash:'b'.repeat(64)},old=structuredClone({...h,updatedAt,combos:[combo(h.records.slice(0,2),2.5)]});delete old.threeCombos;
 const original=reviewed.seal(old);
 return {...h,comboArchive:{version:'reviewed-combo-history-archive-v1',businessDate,source:{receiptSha256:'c'.repeat(64),intentSha256:'d'.repeat(64),releaseSha256:'e'.repeat(64),observedAt:'2030-01-01T09:01:00.000Z',viewJsonSha256:require('node:crypto').createHash('sha256').update(JSON.stringify(original)).digest('hex'),productionWrites:0},view:original}};
}
function resealArchive(h){const a=h.comboArchive;a.view=reviewed.seal(Object.fromEntries(Object.entries(a.view).filter(([key])=>key!=='contentHash')));a.source.viewJsonSha256=require('node:crypto').createHash('sha256').update(JSON.stringify(a.view)).digest('hex');return reviewed.seal(h);}
test('the API history archive displays only the original saved doubles after cutoff and retains current history singles',()=>{
 const h=archiveHistory(),response=historyEnvelope(reviewed.seal(h)),before=JSON.stringify(response),parsed=view.parseRecommendationCenter(response),history=parsed.reviewedAnalysisHistory;
 assert.deepEqual(history.combos,[]);assert.deepEqual(history.threeCombos,[]);assert.equal(history.records.length,27);assert.equal(history.updatedAt,historyAt);
 assert.equal(history.comboArchive.view.updatedAt,updatedAt);assert.equal(history.comboArchive.view.combos[0].product,3.4225);assert.deepEqual(history.comboArchive.view.threeCombos,[]);
 const html=render(history,'two',Date.parse(historyAt));assert.match(html,/原线上存档/);assert.match(html,/3\.4225/);assert.match(html,/已停售.*不作为当前推荐/);assert.match(html,/data-reviewed-combo-state="historical"/);assert.doesNotMatch(html,/data-reviewed-combo-state="open"|信心/);
 assert.match(center(parsed,Date.parse(historyAt),'single'),/27 场原冻结记录/);assert.match(center(parsed,Date.parse(historyAt),'two'),/3\.4225/);assert.match(center(parsed,Date.parse(historyAt),'three'),/未找到该竞彩日已保存的原3串1组合/);assert.equal(JSON.stringify(response),before);
});
for(const [name,change] of [
 ['wrong publication',h=>{h.comboArchive.view.publicationHash='f'.repeat(64);}],
 ['wrong draft',h=>{h.comboArchive.view.draftHash='f'.repeat(64);}],
 ['missing original row',h=>{h.comboArchive.view.records.pop();}],
 ['changed original direction',h=>{const r=h.comboArchive.view.records[26];r.selection='a';r.scores=[[0,1],[1,2]];}],
 ['changed original handicap',h=>{const r=h.comboArchive.view.records[26];r.market='HHAD';r.handicap=1;}],
 ['different original SP',h=>{h.comboArchive.view.records[26].sp=2;}],
 ['nested archive',h=>{h.comboArchive.view.comboArchive=structuredClone(h.comboArchive);}],
 ['original already closed when observed',h=>{h.comboArchive.source.observedAt=h.comboArchive.view.records[0].cutoffAt;}],
 ['archive observed before published',h=>{h.comboArchive.source.observedAt=createdAt;}],
 ['archive observed after read clock',h=>{h.comboArchive.source.observedAt='2030-01-02T18:00:00.000Z';}],
 ['production write claim',h=>{h.comboArchive.source.productionWrites=1;}],
 ['different archive day',h=>{h.comboArchive.businessDate='2030-01-02';}],
 ['unproven three-leg archive',h=>{h.comboArchive.view.threeCombos=[combo(h.comboArchive.view.records.slice(0,3),5)];}],
])test(`history archive rejects ${name} even after public resealing`,()=>{const h=archiveHistory();change(h);assert.throws(()=>view.parseRecommendationCenter(historyEnvelope(resealArchive(h))));});
test('archive integrity rejects unchanged original-byte hash tampering and cannot enter the current parser',()=>{
 const h=archiveHistory();h.comboArchive.source.viewJsonSha256='0'.repeat(64);assert.throws(()=>view.parseRecommendationCenter(historyEnvelope(reviewed.seal(h))),/archive/);
 const original=archiveHistory();assert.throws(()=>view.parseReviewedAnalysis(reviewed.seal(original),businessDate,historyAt),/scope/);
});
test('the saved 2026-10-10 online archive renders exactly its three original doubles through the API parser',()=>{
 const archive=JSON.parse(fs.readFileSync('scripts/recommendationPlatform/reviewedComboHistory/2026-10-10.json','utf8'));
 const original=archive.view,now='2026-10-11T01:00:00.000Z',h=require('../scripts/recommendationPlatform/reviewedComboHistory.cjs').restoreArchivedCombos(reviewed.seal({...Object.fromEntries(Object.entries(original).filter(([key])=>key!=='contentHash')),updatedAt:now,combos:[],threeCombos:[]}),now);
 const response=historyEnvelope(h),raw=response.recommendationCenter;raw.businessDate='2026-10-11';raw.updatedAt=now;raw.reviewedAnalysis={version:'reviewed-analysis-view-v1',businessDate:raw.businessDate,updatedAt:now,formalEligible:false,records:[],combos:[],threeCombos:[]};
 const before=JSON.stringify(response),parsed=view.parseRecommendationCenter(response),html=render(parsed.reviewedAnalysisHistory,'two',Date.parse(now));
 assert.equal(parsed.reviewedAnalysisHistory.records.length,27);assert.deepEqual(parsed.reviewedAnalysisHistory.comboArchive.view.combos,original.combos);assert.deepEqual(parsed.reviewedAnalysisHistory.comboArchive.view.threeCombos,[]);
 assert.deepEqual(parsed.reviewedAnalysisHistory.comboArchive.firstVersion.combos.map(c=>c.product),[2.5026,5.0875,11]);
 for(const text of ['首版组合存档','2.5026','5.0875','11','周六017 主胜 1.29','周六019 让胜(-2) 1.94','周六027 让负(-1) 2.75','周六022 让负(-3) 1.85','周六020 平局 4.00'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/5\.035|10\.011|原线上存档/);
 assert.equal((html.match(/data-reviewed-combo-state="historical"/g)||[]).length,3);assert.match(html,/2026-10-10 竞彩日/);assert.match(html,/已停售/);assert.doesNotMatch(html,/信心|data-reviewed-combo-state="open"/);assert.equal(JSON.stringify(response),before);
});

test('first version parser rejects altered original direction, price, handicap, fake historical clock and duplicate legs even after resealing',()=>{
 const retained=JSON.parse(fs.readFileSync('scripts/recommendationPlatform/reviewedComboHistory/2026-10-10.json','utf8')),first=JSON.parse(fs.readFileSync('scripts/recommendationPlatform/reviewedComboHistory/2026-10-10-first-version.json','utf8'));
 const now='2026-10-11T01:00:00.000Z';
 for(const change of [f=>f.combos[1].legs[0].sp=2.73,f=>f.combos[1].legs[0].handicap=1,f=>f.combos[2].legs[0].selection='h',f=>f.source.originalObservedAt='2026-10-10T13:49:00Z',f=>f.recordHashes[0]='0'.repeat(64),f=>f.combos[0].legs[1]=f.combos[0].legs[0]]){
  const altered=structuredClone(first);change(altered);delete altered.contentHash;
  const h=reviewed.seal({...Object.fromEntries(Object.entries(retained.view).filter(([key])=>key!=='contentHash')),updatedAt:now,combos:[],threeCombos:[],comboArchive:{...retained,firstVersion:reviewed.seal(altered)}});
  assert.throws(()=>view.parseReviewedAnalysisHistory(h,'2026-10-11',now),/first version/);
 }
});

function center(data,now,tab){
 const clock=class extends Date{static now(){return now;}};
 const stub=()=>null,other={DailyBulletinPanel:stub,LeagueBaselineDirections:stub,DayCoverage:stub,DualResearchV2:stub,MarketComparison:stub,PrdPaperDirections:stub,FollowButton:stub,TeamBadge:stub};
 const component=compile('src/components/recommendations/RecommendationCenter.tsx',id=>{
  if(id==='react')return {useEffect:()=>{},useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]};
  if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(id==='./ReviewedAnalysis')return ui;
  if(id==='../../services/reviewedPresentation')return compile('src/services/reviewedPresentation.ts',require);
  if(id==='./PublishedReviewCoverage')return {PublishedReviewCoveragePanel:stub};
  if(id==='../../hooks/useRecommendationCenter')return {useRecommendationCenter:()=>({data,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
  if(id==='../../hooks/useRecommendationReviewPage')return {useRecommendationReviewPage:()=>({data:null,loading:false,failed:false,authorizationRequired:false,refresh:()=>{}})};
  if(id==='../../services/recommendationCenterView')return view;
  if(id.endsWith('publishedRecommendationStatus.cjs'))return require('../src/services/publishedRecommendationStatus.cjs');
  if(id.endsWith('publishedMatchRecommendation')||id==='./SelectionQualityNote'||id.endsWith('.css'))return {};
  if(id==='lucide-react')return {RefreshCw:stub,ChevronDown:stub,Search:stub,ArrowUpRight:stub};
  const name=id.split('/').pop();if(other[name])return {[name]:other[name]};throw Error(id);
 },clock);
 const expand=node=>Array.isArray(node)?node.map(expand):node&&typeof node==='object'?(typeof node.type==='function'?expand(node.type(node.props)):{...node,props:{...node.props,children:expand(node.props?.children)}}):node;
 const words=node=>Array.isArray(node)?node.map(words).join(''):node&&typeof node==='object'?words(node.props?.children):node==null||typeof node==='boolean'?'':String(node);
 return words(expand(component.RecommendationCenter({language:'zh',selectedTab:tab,onSelectMatch:()=>{}})));
}
test('actual center suppresses legacy stale/empty combo banners for both reviewed tabs and retains them when reviewed is absent',()=>{
 const data={businessDate,inputAsOf:createdAt,resultAsOf:null,reviewedAnalysis:parse(body()),strategySwitch:{legacyPublicationEnabled:false},review:{statistics:{},qualityReport:null},current:[],todayCombos:[],previews:[],lanes:{combos:{status:'error',errorCode:'SOURCE_STALE',inputAsOf:createdAt}}};
 for(const tab of ['two','three']){const text=center(data,Date.parse(updatedAt),tab);assert.match(text,tab==='two'?/精选2串1/:/精选3串1/);assert.doesNotMatch(text,/暂无可展示的组合|等待新报价后自动重算|有效期15分钟|报价已超过15分钟/);assert.match(text,/2串1SP≥2\.50/);assert.match(text,/3串1/);assert.doesNotMatch(text,/3串1SP≥|SP≥5\.00/);}
 const without={...data,reviewedAnalysis:undefined};assert.match(center(without,Date.parse(updatedAt),'three'),/暂无可展示的组合/);
});
