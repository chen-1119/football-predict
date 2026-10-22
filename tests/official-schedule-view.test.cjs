'use strict';
const test=require('node:test'),a=require('node:assert/strict'),f=require('./fixtures/reviewed-official-event.cjs');
const {project}=require('../server/officialScheduleRead.cjs'),{validateOfficialSchedule}=require('../src/services/officialSchedule.cjs');
const rows=e=>e.payload.value.matchInfoList[0].subMatchList;
function run(input){return project(input.snapshot,input.draft.businessDate,{now:f.NOW,trustRegistry:input.trustRegistry});}
function change(input,fn){for(const e of input.snapshot.endpoints){fn(e);f.resign(e,input.pair);}return input;}
test('signed schedule reads without native data, DB or recommendation generation; originals unchanged',()=>{
 const input=f.setup(),before=JSON.stringify(input),view=run(input);
 a.equal(view.events.length,2);a.equal(view.events[0].markets.length,2);a.equal(view.recommendationEligibilityVerified,false);a.equal(JSON.stringify(input),before);
 a.equal(Object.hasOwn(view.events[0],'predictions'),false);a.equal(Object.hasOwn(view.events[0],'scores'),false);
});
test('stopped current events and current-only Define events remain visible without sale permission or invented prices',()=>{
 const input=change(f.setup(),e=>{rows(e)[0].sellStatus=2;if(e.method==='current'){rows(e)[1].matchStatus='Define';rows(e)[1].sellStatus='';rows(e)[1].oddsList=[];}else rows(e).pop();});
 const view=run(input);a.equal(view.events.length,2);a.equal(view.events[0].sellStatus,'2');a.equal(view.events[1].sellStatus,null);a.deepEqual(view.events[1].markets,[]);a.equal(view.events[1].quoteStatus,'unavailable');
});
for(const [label,modify]of [
 ['unsigned mutation',i=>{rows(i.snapshot.endpoints[0])[0].homeTeamAllName='tampered';}],
 ['different signed cycle',i=>{const e=i.snapshot.endpoints[1];e.sourceCycleId='other-cycle';f.resign(e,i.pair);}],
 ['duplicate ID',i=>change(i,e=>rows(e).push(rows(e)[0]))],
 ['invalid ordered team ID',i=>change(i,e=>{rows(e)[0].homeTeamId=rows(e)[0].awayTeamId;})],
 ['missing lane',i=>i.snapshot.endpoints.pop()],
])test('rejects '+label,()=>{const i=f.setup();modify(i);a.throws(()=>run(i));});
test('stale source and stale client view both refuse, including cached views after a hidden tab resumes',()=>{
 const i=f.setup(),view=run(i);a.throws(()=>project(i.snapshot,i.draft.businessDate,{now:f.NOW+900001,trustRegistry:i.trustRegistry}));
 a.throws(()=>validateOfficialSchedule(view,i.draft.businessDate,f.NOW+900001));
});
test('same identities normalize HH:mm and HH:mm:ss and numeric price spelling',()=>{
 const i=change(f.setup(),e=>{if(e.method==='current'){rows(e)[0].matchTime='23:00';rows(e)[0].oddsList[0].h='1.800';rows(e)[0].oddsList[1].goalLine='-1.00';}});
 a.equal(run(i).events[0].quoteStatus,'matched');
});
for(const [label,mutate]of [
 ['reversed teams',r=>{[r.homeTeamId,r.awayTeamId]=[r.awayTeamId,r.homeTeamId];}],
 ['different kickoff',r=>{r.matchTime='22:00:00';}],
 ['price discrepancy',r=>{r.oddsList[0].h=2;}],
 ['invalid price',r=>{r.oddsList[0].h='';}],
 ['missing market',r=>{r.oddsList.pop();}],
])test('preserves schedule but suppresses conflicted quote: '+label,()=>{
 const i=change(f.setup(),e=>{if(e.method==='calculator')mutate(rows(e)[0]);}),event=run(i).events[0];
 a.equal(event.quoteStatus,'conflict');a.deepEqual(event.markets,[]);
});
test('requested business date never pulls another day or fabricates fixtures',()=>{
 const i=f.setup();a.deepEqual(project(i.snapshot,'2026-09-18',{now:f.NOW,trustRegistry:i.trustRegistry}).events,[]);
 a.throws(()=>project(i.snapshot,'2026-02-30',{now:f.NOW,trustRegistry:i.trustRegistry}));
 a.throws(()=>validateOfficialSchedule(run(i),'2026-09-18',f.NOW));
});
test('HTTP retains access, GET-only, exact query and private no-store without invoking reader on refusal',async()=>{
 const {handle}=require('../server/officialScheduleHttp.cjs');let reads=0,allowed=true;const headers={};
 const deps={authorize:async()=>allowed,send:(status,body)=>({status,body}),read:()=>{reads++;return {ok:true};}},res={setHeader:(k,v)=>{headers[k]=v;}};
 const url=query=>new URL('https://example.com/api/research/official-schedule?'+query);
 a.equal((await handle({method:'POST'},res,url('businessDate=2026-09-17'),deps)).status,405);
 allowed=false;a.equal((await handle({method:'GET'},res,url('businessDate=2026-09-17'),deps)).status,401);allowed=true;
 for(const query of ['','businessDate=2026-09-17&extra=1','businessDate=2026-09-17&businessDate=2026-09-18','businessDate=2026-02-30'])a.equal((await handle({method:'GET'},res,url(query),deps)).status,400);
 a.equal(reads,0);a.equal((await handle({method:'GET'},res,url('businessDate=2026-09-17'),deps)).status,200);a.equal(reads,1);a.equal(headers['Cache-Control'],'private, no-store');
});

const path=require('node:path'),fs=require('node:fs'),ts=require('typescript'),{createRequire}=require('node:module');
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

test('actual cards and detail render signed facts and stopped status, without fabricated research or model output',()=>{
 const i=change(f.setup(),e=>{rows(e)[0].sellStatus=2;}),view=run(i),state={data:view,loading:false,failed:false};
 const ui=load(ts,path.resolve(__dirname,'../src/components/recommendations/OfficialSchedule.tsx'),{
  '../../hooks/useOfficialSchedule':{useOfficialSchedule:()=>state},
  '../../hooks/useOfficialEditorialReferences':{useOfficialEditorialReferences:()=>({data:{records:[]},loading:false,failed:false})},
 });
 const card=render(React.createElement(ui.OfficialScheduleCard,{event:view.events[0],view,now:f.NOW,onSelect(){}}));
 a.match(card,/官方当前停售/);a.match(card,/1\.80/);a.match(card,/3\.50/);a.match(card,/4\.50/);a.match(card,/北京时间开球/);
 a.doesNotMatch(card,/模型概率|确认首发|信心|正式推荐/);
 const originalNow=Date.now;Date.now=()=>f.NOW;
 try{const detail=render(React.createElement(ui.OfficialScheduleDetail,{referenceId:ui.officialScheduleRoute(view.events[0]),onBack(){}}));
  a.match(detail,/本场尚未发布赛前推荐及参考比分/);a.match(detail,/尚未完成本场核实/);a.match(detail,/1\.80/);
 }finally{Date.now=originalNow;}
});
test('schedule card never presents unavailable analysis as confirmed unpublished',()=>{
 const view=run(f.setup()),ui=load(ts,path.resolve(__dirname,'../src/components/recommendations/OfficialSchedule.tsx'),{'../../hooks/useOfficialSchedule':{},'../../hooks/useOfficialEditorialReferences':{}});
 for(const analysisState of [undefined,'unknown','loading','failed']){
  const html=render(React.createElement(ui.OfficialScheduleCard,{event:view.events[0],view,now:f.NOW,onSelect(){},analysisState}));
  a.doesNotMatch(html,/分析尚未发布|暂无已发布推荐/);
  if(analysisState==='failed')a.match(html,/暂时无法核验/);
 }
 const html=render(React.createElement(ui.OfficialScheduleCard,{event:view.events[0],view,now:f.NOW,onSelect(){},analysisState:'unpublished'}));
 a.match(html,/分析尚未发布/);
});
test('hook isolates days, authenticates, bounds the response and clears old facts on errors or unmount',async()=>{
 const vm=require('node:vm'),controllers=[],requests=[],view=run(f.setup()),m={exports:{}},browser={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
 const file=path.resolve(__dirname,'../src/hooks/useOfficialSchedule.ts'),native=createRequire(file);
 const custom=id=>{
  if(id==='react')return {useMemo:fn=>fn(),useSyncExternalStore:()=>null};
  if(id.endsWith('/accessControl'))return {getAccessAuthHeaders:()=>({'X-Fixture-Access':'synthetic'})};
  if(id.endsWith('/runtimeUrls'))return {buildApiUrl:v=>v};
  if(id.endsWith('/pollingController'))return {createPollingController:options=>{const c={options,start(){},stop(){this.stopped=true;},visibilityChanged(){}};controllers.push(c);return c;}};
  return native(id);
 };
 class Clock extends Date {static now(){return f.NOW;}}
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:m,exports:m.exports,require:custom,document:browser,window:browser,Date:Clock,Set,Object,JSON,TextEncoder,encodeURIComponent,
  fetch:async(url,options)=>{requests.push({url,options});return {ok:true,text:async()=>JSON.stringify(view)};}});
 const first=m.exports.createOfficialScheduleStore(view.businessDate),next=m.exports.createOfficialScheduleStore('2026-09-18'),signal=new AbortController().signal;
 const stop=first.subscribe(()=>{}),stopNext=next.subscribe(()=>{}),data=await controllers[0].options.request(signal);controllers[0].options.onData(data);
 a.equal(first.getSnapshot().data.events.length,2);a.equal(next.getSnapshot().data,null);a.equal(requests[0].options.credentials,'include');a.equal(requests[0].options.signal,signal);
 controllers[0].options.onError();a.equal(first.getSnapshot().data,null);a.equal(first.getSnapshot().failed,true);stop();stopNext();
 controllers[0].options.onData(data);a.equal(first.getSnapshot().data,null);a.equal(controllers[0].stopped,true);
});

for(const [label,mutate]of [
 ['failed provider payload',e=>e.payload.success=false],['HTTP error response',e=>e.httpStatus=500],['wrong MIME',e=>e.contentType='text/plain'],
 ['conflicting group business day',e=>e.payload.value.matchInfoList[0].businessDate='2026-09-18'],
 ['invalid actual calendar date',e=>rows(e)[0].matchDate='2026-02-30'],['malformed complete group',e=>e.payload.value.matchInfoList.push({businessDate:'2026-09-17'})],
 ['invalid deadline',e=>rows(e)[0].buyEndTime='not-a-clock']
])test('complete signed provider source rejects '+label,()=>{const i=change(f.setup(),mutate);a.throws(()=>run(i));});
test('dual lane sale disagreement and explicit cutoff close display sale without altering original SP',()=>{
 const stopped=change(f.setup(),e=>{if(e.method==='calculator')rows(e)[0].sellStatus=2;});a.equal(run(stopped).events[0].saleState,'closed');
 const deadline=change(f.setup(),e=>rows(e)[0].buyEndTime=f.stamp(f.NOW-1));const event=run(deadline).events[0];a.equal(event.saleState,'closed');a.equal(event.markets[0].h,1.8);
});
test('mixed native list fills only missing exact events, and official numeric IDs bind reference association',()=>{
 const ui=load(ts,path.resolve(__dirname,'../src/components/recommendations/OfficialSchedule.tsx'),{'../../hooks/useOfficialSchedule':{},'../../hooks/useOfficialEditorialReferences':{}});
 const view=run(f.setup()),event=view.events[0],other=view.events[1];
 const native={id:'sporttery_'+event.eventId,sourceMatchId:event.eventId,businessDate:event.businessDate,kickoffTime:event.kickoff,homeTeamName:event.homeTeamName,awayTeamName:event.awayTeamName};
 a.equal(ui.scheduleNeedsSeparateCard(event,[native],[]),false);a.equal(ui.scheduleNeedsSeparateCard(other,[native],[]),true);
 a.equal(ui.scheduleNeedsSeparateCard(event,[{...native,kickoffTime:'2020-01-01T00:00:00Z'}],[]),true);
 const record={eventId:event.eventId,businessDate:event.businessDate,eventVersion:event.kickoff,homeTeamName:event.homeTeamName,awayTeamName:event.awayTeamName,officialOrderedTeamIds:[event.homeTeamId,event.awayTeamId]};
 a.equal(ui.scheduleMatchesReference(event,record),true);a.equal(ui.scheduleMatchesReference({...event,homeTeamId:event.homeTeamId+999},record),false);
 a.equal(ui.scheduleNeedsSeparateCard(event,[],[record]),false);
 a.equal(ui.scheduleNeedsSeparateCard({...event,homeTeamId:event.homeTeamId+999},[],[record]),true);
});
