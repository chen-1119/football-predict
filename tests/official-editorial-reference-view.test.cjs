'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),ts=require('typescript'),{createRequire}=require('node:module');
const React=require('react'),render=require('react-dom/server').renderToStaticMarkup;
function load(ts,filename,overrides={}){
 const native=createRequire(filename),m={exports:{}},local=id=>{
  if(Object.hasOwn(overrides,id))return overrides[id];
  if(id.endsWith('.css'))return {};
  if(id.startsWith('.')){const base=path.resolve(path.dirname(filename),id),target=[base,base+'.tsx',base+'.ts'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(target&&/\.tsx?$/.test(target))return load(ts,target,overrides);}
  return native(id);
 };
 const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',js)(local,m,m.exports);return m.exports;
}
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/reviewed-official-event.cjs');
const front=load(ts,path.resolve(__dirname,'../src/services/officialEditorialReferences.ts'));
function fixture(){const input=f.setup(),record=p.make(input.draft,input),at=f.stamp(f.NOW+3000);
 const original=p.seal({version:'reviewed-analysis-view-v1',businessDate:record.businessDate,updatedAt:at,createdAt:record.createdAt,commitObservedAt:f.stamp(f.NOW+1),publicationHash:record.contentHash,records:record.records,combos:[],threeCombos:[],formalEligible:false});
 return {version:'official-editorial-reference-view-v1',businessDate:record.businessDate,updatedAt:at,original,officialEventIds:record.records.map(r=>r.eventId),revisions:null,formalEligible:false,modelAdoption:false};}
test('separate DTO parses only verified V4 references and preserves the original signed view bytes',()=>{
 const raw=fixture(),before=JSON.stringify(raw),view=front.parseOfficialEditorialReferences(raw,raw.businessDate);
 a.equal(view.records.length,2);a.equal(view.records[1].market,'HHAD');a.equal(view.records[1].sp,1.92);a.equal(JSON.stringify(raw),before);
 for(const r of view.records){const route=front.officialReferenceRoute(r),identity=front.parseOfficialReferenceRoute(route);a.equal(identity.eventId,r.eventId);a.equal(identity.businessDate,r.businessDate);}
});
for(const [label,change]of [
 ['wrong requested day',v=>v.businessDate='2026-09-16'],['native record relabelled',v=>delete v.original.records[0].eventAuthority],
 ['extra unverified ID',v=>v.officialEventIds.push('999')],['altered official team ID',v=>v.original.records[0].eventAuthority.officialOrderedTeamIds.reverse()],
 ['model authority claimed',v=>v.modelAdoption=true],['authority hash omitted',v=>delete v.original.records[0].eventAuthority.currentRowHash]
])test('separate DTO refuses '+label,()=>{const v=fixture(),day=v.businessDate;change(v);a.throws(()=>front.parseOfficialEditorialReferences(v,day));});
test('reference route refuses invalid calendar date, native route, suffix and unsafe ID',()=>{
 for(const id of ['official_20260230_1','sporttery_1','official_20260917_1_extra','official_20260917_0','official_20260917_-1'])a.equal(front.parseOfficialReferenceRoute(id),null);
});
test('a native ID alone cannot hide a verified reference and only an actually visible exact decision is deduplicated',()=>{
 const raw=fixture(),view=front.parseOfficialEditorialReferences(raw,raw.businessDate),record=view.records[0];
 const match={sourceMatchId:record.eventId,kickoffTime:record.eventVersion,businessDate:record.businessDate,homeTeamId:record.homeTeamId,awayTeamId:record.awayTeamId,homeTeamName:record.homeTeamName,awayTeamName:record.awayTeamName};
 const center={reviewedAnalysis:{businessDate:record.businessDate,records:view.records}};
 a.equal(front.officialReferenceNeedsSeparateCard(record,[match],null),true);
 a.equal(front.officialReferenceNeedsSeparateCard(record,[{...match,businessDate:'2026-09-18'}],center),true);
 a.equal(front.officialReferenceNeedsSeparateCard(record,[{...match,homeTeamId:'other-team'}],center),true);
 a.equal(front.officialReferenceNeedsSeparateCard(record,[],center),true);
 a.equal(front.officialReferenceNeedsSeparateCard(record,[match],center),false);
 const {officialOrderedTeamIds,...nativeOriginal}=record;
 const revisions={state:'verified',singles:[{eventId:record.eventId,revision:1,publishedAt:record.createdAt,decision:nativeOriginal,settlement:null}],combos:[],pending:0};
 const latest=load(ts,path.resolve(__dirname,'../src/services/publishedMatchRecommendation.ts')).reviewedLatestRecord(record,revisions);
 a.deepEqual(latest.review.original.officialOrderedTeamIds,officialOrderedTeamIds);
 const nativeCenter={reviewedAnalysis:{businessDate:record.businessDate,records:[nativeOriginal]},reviewedRevisions:revisions};
 a.equal(front.officialReferenceNeedsSeparateCard(latest,[match],nativeCenter),false);
 a.equal(front.officialReferenceNeedsSeparateCard({...latest,sp:latest.sp+0.01},[match],nativeCenter),true);
});
test('real list card renders manual direction, frozen SP and both compatible scores without a model or confidence badge',()=>{
 const raw=fixture(),state={data:front.parseOfficialEditorialReferences(raw,raw.businessDate),loading:false,failed:false};
 const ui=load(ts,path.resolve(__dirname,'../src/components/recommendations/OfficialEditorialReferences.tsx'),{'../../hooks/useOfficialEditorialReferences':{useOfficialEditorialReferences:()=>state}});
 const html=render(React.createElement(ui.OfficialReferenceCard,{record:state.data.records[1],onSelect(){},now:f.NOW+3000}));
 a.match(html,/data-official-event-reference/);a.match(html,/让负\(-1\)/);a.match(html,/1\.92/);a.match(html,/1-1 \/ 1-2/);a.match(html,/发布报价观察/);a.doesNotMatch(html,/信心|暂无推荐|模型已验证/);
 const detail=render(React.createElement(ui.OfficialEditorialReferenceDetail,{referenceId:front.officialReferenceRoute(state.data.records[1]),onBack(){}}));
 a.match(detail,/人工审核参考/);a.match(detail,/让负\(-1\)/);a.match(detail,/1\.92/);a.match(detail,/Synthetic actual reviewed evidence/);a.match(detail,/首发/);
});
test('detail fails closed when the verified DTO is missing or access/readback fails',()=>{
 for(const state of [{data:null,loading:false,failed:false},{data:null,loading:false,failed:true}]){
  const ui=load(ts,path.resolve(__dirname,'../src/components/recommendations/OfficialEditorialReferences.tsx'),{'../../hooks/useOfficialEditorialReferences':{useOfficialEditorialReferences:()=>state}});
  const html=render(React.createElement(ui.OfficialEditorialReferenceDetail,{referenceId:'official_20260917_1',onBack(){}}));
  a.match(html,/未找到|无法核验/);a.doesNotMatch(html,/发布时官方 SP|Synthetic actual/);
 }
});
test('reference subscriptions isolate days, send access with cancellation and clear denied or abandoned data',async()=>{
 const vm=require('node:vm'),controllers=[],events=[],responses=[],raw=fixture(),m={exports:{}},browser={visibilityState:'visible',addEventListener:(...args)=>events.push(args),removeEventListener(){}};
 const file=path.resolve(__dirname,'../src/hooks/useOfficialEditorialReferences.ts'),native=createRequire(file),custom=id=>{
  if(id==='react')return {useMemo:fn=>fn(),useSyncExternalStore:()=>null};
  if(id.endsWith('/accessControl'))return {getAccessAuthHeaders:()=>({'X-Fixture-Access':'local-synthetic'})};
  if(id.endsWith('/runtimeUrls'))return {buildApiUrl:v=>v};
  if(id.endsWith('/officialEditorialReferences'))return front;
  if(id.endsWith('/pollingController'))return {createPollingController:options=>{const c={options,stopped:false,start(){},stop(){this.stopped=true;},visibilityChanged(){}};controllers.push(c);return c;}};
  return native(id);
 };
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:m,exports:m.exports,require:custom,document:browser,window:browser,Date,Set,Object,JSON,TextEncoder,encodeURIComponent,
  fetch:async(url,options)=>{responses.push({url,options});return {ok:true,text:async()=>JSON.stringify(raw)};}});
 const first=m.exports.createOfficialEditorialReferenceStore(raw.businessDate),next=m.exports.createOfficialEditorialReferenceStore('2026-09-18'),signal=new AbortController().signal;
 const unFirst=first.subscribe(()=>{}),unNext=next.subscribe(()=>{}),data=await controllers[0].options.request(signal);controllers[0].options.onData(data);
 a.equal(first.getSnapshot().data.records.length,2);a.equal(next.getSnapshot().data,null);a.equal(responses[0].options.signal,signal);a.equal(responses[0].options.credentials,'include');a.equal(responses[0].options.cache,'no-store');
 a.throws(()=>controllers[0].options.onData({...data,updatedAt:'2099-01-01T00:00:00Z'}),/clock/);
 controllers[0].options.onError({status:403});a.equal(first.getSnapshot().data,null);a.equal(first.getSnapshot().failed,true);
 unFirst();a.equal(controllers[0].stopped,true);a.equal(controllers[1].stopped,false);unNext();a.equal(controllers[1].stopped,true);
 controllers[0].options.onData(data);a.equal(first.getSnapshot().data,null);a.equal(events.length,4);
});
