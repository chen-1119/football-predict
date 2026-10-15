'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/signed-live-had.cjs');
function load(relative){const file=path.resolve(__dirname,'..',relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
const front=load('src/services/recommendationCenterView.ts'),pick=load('src/services/publishedMatchRecommendation.ts');
const {parseReviewedHistoryQuery}=require('../server/reviewedHistoryQuery.cjs');
function fixture(){
 const matches=[f.source(1),f.source(2),f.source(3)],s=f.snapshot(matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;})});
 const draft={version:1,reportKind:'weekday-2000-selected-two',predictionScope:'chat-only research',businessDate:matches[0].businessDate,frozenAt:f.stamp(f.NOW-60000),singles:matches.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,market:'HAD',handicap:null,selection:'h',sp:1.8,scores:[[2,0],[3,1]],confidence:'中',reason:'Synthetic original',analysisUrl:'https://example.com/preview',teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}))};
 const publication=p.make(draft,{matches,snapshot:s.snapshot,trustRegistry:s.registry,asOf:f.stamp(f.NOW)}),records=publication.records,day=draft.businessDate,updatedAt=f.stamp(f.NOW+3000);
 const raw=p.seal({version:'reviewed-analysis-view-v1',businessDate:day,createdAt:publication.createdAt,commitObservedAt:f.stamp(f.NOW+1),updatedAt,publicationHash:publication.contentHash,records,combos:p.combinations(records,2),threeCombos:p.combinations(records,3),formalEligible:false});
 const meta={revision:1,payloadSha256:'a'.repeat(64),ackSha256:'b'.repeat(64),previousRevisionHash:null,publishedAt:f.stamp(f.NOW+1000),commitObservedAt:f.stamp(f.NOW+1001),originalSettlementPreserved:true,independentEventIncrement:0};
 const decision=r=>({...r,market:'HAD',selection:'a',sp:4.5,originalSp:4.5,scores:[[0,1],[1,2]],reason:'Synthetic new review'});
 const single={...meta,key:'reviewed-single-'+day+'-'+records[0].eventId+'-v01',eventId:records[0].eventId,originalDecisionHash:p.hash(records[0]),decision:decision(records[0]),settlement:{state:'PENDING'}};
 const ds=records.slice(0,2).map(decision),combo={...meta,key:'reviewed-combo-'+day+'-'+p.hash({size:2,band:2.5,eventIds:ds.map(d=>d.eventId).sort()})+'-v01',baseArchiveKey:'reviewed-combo-view-'+day+'-'+'c'.repeat(64),baseArchiveSha256:'d'.repeat(64),originalCombo:raw.combos[0],decisions:ds,combo:p.combinations(ds,2)[0],frozen:false,settlement:{state:'PENDING'},legSettlements:ds.map(()=>({state:'PENDING'}))};
 const body={version:'reviewed-revisions-view-v1',state:'verified',businessDate:day,updatedAt,originalPublicationHash:raw.publicationHash,singles:[single],combos:[combo],pending:[],originalSettlementPreserved:true,independentEventIncrement:0,formalEligible:false,modelAdoption:false};
 const original=front.parseReviewedAnalysis(raw,day,updatedAt);return {raw,original,body,day,updatedAt,parse:()=>front.parseReviewedRevisions(p.seal(body),raw,original,updatedAt)};
}
test('browser parser and match pick use the latest reviewed direction and retain first direction and scores',()=>{
 const f=fixture(),before=JSON.stringify(f.original),v=f.parse(),row=pick.reviewedLatestRecord(f.original.records[0],v);
 a.equal(row.selection,'a');a.deepEqual(row.scores,[[0,1],[1,2]]);a.equal(row.review.original.selection,'h');a.equal(JSON.stringify(f.original),before);
 a.equal(v.combos[0].combo.product,20.25);a.equal(f.original.combos[0].product,3.24);
});
for(const [label,change]of [
 ['changed original',f=>{f.body.singles[0].originalDecisionHash='0'.repeat(64);}],['incompatible score',f=>{f.body.singles[0].decision.scores=[[2,0],[3,1]];}],
 ['ordered teams swapped',f=>{f.body.singles[0].decision.homeTeamId=f.body.singles[0].decision.awayTeamId;}],['missing first version',f=>{f.body.singles[0].revision=2;f.body.singles[0].previousRevisionHash='f'.repeat(64);}],
 ['mutated combo SP',f=>{f.body.combos[0].combo.legs[0].sp=9;}],['wrong combo product',f=>{f.body.combos[0].combo.product=99;}],
 ['future ACK',f=>{f.body.singles[0].commitObservedAt='2099-01-01T00:00:00.000Z';}],
])test('resealed projection still refuses '+label,()=>{const f=fixture();change(f);a.throws(f.parse);});
test('rendered single shows review and original, while combo keeps independent original legs',()=>{
 const f=fixture(),revisions=f.parse(),React=require('react'),render=require('react-dom/server').renderToStaticMarkup;
 const ui=require('../scripts/lib/loadReviewTsForVerification.cjs')(ts,path.resolve(__dirname,'../src/components/recommendations/ReviewedAnalysis.tsx'));
 const singles=render(React.createElement(ui.ReviewedAnalysisPanel,{data:f.original,revisions,tab:'single',now:Date.parse(f.updatedAt),failed:false}));
 a.match(singles,/复核版 1/);a.match(singles,/首版保留/);a.match(singles,/客胜/);a.match(singles,/主胜/);a.doesNotMatch(singles,/低信心|中信心|高信心/);
 const combos=render(React.createElement(ui.ReviewedAnalysisPanel,{data:f.original,revisions,tab:'two',now:Date.parse(f.updatedAt),failed:false}));
 a.match(combos,/3.24/);a.match(combos,/20.25/);a.match(combos,/复核版 1/);
});
test('a persisted original group remains valid after another batch advances the global publication ACK',()=>{
 const f=fixture(),raw=structuredClone(f.raw),originalCreated=raw.createdAt,originalAck=raw.commitObservedAt;
 raw.records=raw.records.map(r=>({...r,publicationCreatedAt:originalCreated,publicationCommitObservedAt:originalAck}));
 raw.createdAt=f.updatedAt;raw.commitObservedAt=new Date(Date.parse(f.updatedAt)+1).toISOString();raw.updatedAt=new Date(Date.parse(f.updatedAt)+2000).toISOString();
 raw.comboFreezePolicy='persisted-original-groups-v1';raw.comboFreeze=[];
 for(const [groups,size]of [[raw.combos,2],[raw.threeCombos,3]])for(const c of groups.filter(c=>c.legs.length))raw.comboFreeze.push({size,band:c.band,sourceArchiveKey:'reviewed-combo-view-'+f.day+'-'+'c'.repeat(64),sourceArchiveSha256:'d'.repeat(64),observedAt:f.updatedAt,originalComboHash:p.hash(c),frozen:false});
 delete raw.contentHash;const parsed=front.parseReviewedAnalysis(p.seal(raw),f.day,raw.updatedAt);a.equal(parsed.combos[0].product,f.original.combos[0].product);
});

test('selected archived day restores a verified manual pick for finished, live and upcoming rows',()=>{
 const f=fixture(),first=f.original.records[0],nextDay=new Date(Date.parse(f.day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 const data={businessDate:nextDay,reviewedAnalysis:{businessDate:nextDay,records:[]},reviewedAnalysisHistory:f.original,reviewedRevisions:f.parse()};
 const match={id:'sporttery_'+first.eventId,sourceMatchId:first.eventId,businessDate:first.businessDate,kickoffTime:first.eventVersion,homeTeamId:first.homeTeamId,awayTeamId:first.awayTeamId,homeTeamName:first.homeTeamName,awayTeamName:first.awayTeamName};
 const before=JSON.stringify(data);
 for(const status of ['FINISHED','LIVE','SCHEDULED']){const r=pick.reviewedMatchRecommendation(data,{...match,status});a.equal(r.selection,first.selection);a.deepEqual(r.scores,first.scores);a.equal(r.sp,first.sp);a.equal(r.review,undefined,'current-day revisions cannot attach to archived records');}
 for(const change of [{businessDate:nextDay},{sourceMatchId:'99999999'},{kickoffTime:new Date(Date.parse(first.eventVersion)+1).toISOString()},{homeTeamId:first.awayTeamId,awayTeamId:first.homeTeamId},{homeTeamName:'Unverified alias'},{awayTeamName:'Another away'}])a.equal(pick.reviewedMatchRecommendation(data,{...match,...change}),null);
 a.equal(JSON.stringify(data),before);
 data.reviewedAnalysisHistory={...f.original,records:[first,first]};a.equal(pick.reviewedMatchRecommendation(data,match),null);
});

test('archived day has its own verified revision chain and does not replace first-version settlement',()=>{
 const f=fixture(),now=new Date(Date.parse(f.updatedAt)+86400000).toISOString(),{contentHash,...body}=f.raw;void contentHash;
 const raw=p.seal({...body,updatedAt:now,combos:[],threeCombos:[]});
 const original=front.parseReviewedAnalysis(raw,f.day,now),revisions=front.parseReviewedRevisions(p.seal({...f.body,updatedAt:now,combos:f.body.combos.map(c=>({...c,frozen:true}))}),raw,original,now);
 const first=original.records[0],data={businessDate:new Date(Date.parse(now)+8*3600000).toISOString().slice(0,10),reviewedAnalysisHistory:original,reviewedRevisionsHistory:revisions};
 const match={id:'sporttery_'+first.eventId,sourceMatchId:first.eventId,businessDate:first.businessDate,kickoffTime:first.eventVersion,homeTeamId:first.homeTeamId,awayTeamId:first.awayTeamId,homeTeamName:first.homeTeamName,awayTeamName:first.awayTeamName};
 const before=JSON.stringify(first),r=pick.reviewedMatchRecommendation(data,match);a.equal(r.selection,'a');a.deepEqual(r.scores,[[0,1],[1,2]]);a.equal(r.review.original.selection,'h');a.equal(JSON.stringify(first),before);
 const React=require('react'),render=require('react-dom/server').renderToStaticMarkup,ui=require('../scripts/lib/loadReviewTsForVerification.cjs')(ts,path.resolve(__dirname,'../src/components/recommendations/ReviewedAnalysis.tsx'));
 const html=render(React.createElement(ui.ReviewedMatchPick,{record:r,now:Date.parse(now)}));a.match(html,/复核版 1/);a.match(html,/首版/);a.match(html,/客胜/);
});

test('archived day query admits one real calendar day and rejects duplicate or malformed selectors',()=>{
 a.equal(parseReviewedHistoryQuery(new URLSearchParams()),undefined);
 a.equal(parseReviewedHistoryQuery(new URLSearchParams('reviewedBusinessDate=2026-10-15')),'2026-10-15');
 for(const query of ['reviewedBusinessDate=','reviewedBusinessDate=2026-02-30','reviewedBusinessDate=2026-1-1','reviewedBusinessDate=2026-10-15T00%3A00Z','reviewedBusinessDate=2026-10-15&reviewedBusinessDate=2026-10-14'])a.throws(()=>parseReviewedHistoryQuery(new URLSearchParams(query)),{code:'INVALID_REVIEWED_HISTORY_QUERY'});
});

test('historical list subscriptions isolate days, retain request cancellation, and clear revoked access',async()=>{
 const controllers=[],events=[],responses=new Map(),file=path.resolve(__dirname,'../src/hooks/useRecommendationCenter.ts'),m=new Module(file,module);
 m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m.require=id=>id==='react'?{useMemo:fn=>fn(),useSyncExternalStore:()=>null}:id.endsWith('/accessControl')?{getAccessAuthHeaders:()=>({})}:id.endsWith('/runtimeUrls')?{buildApiUrl:p=>p}:id.endsWith('/recommendationCenterView')?{parseRecommendationCenter:v=>v}:id.endsWith('/pollingController')?{createPollingController:options=>{const c={options,stopped:false,start(){},stop(){this.stopped=true;},refresh(){},visibilityChanged(){}};controllers.push(c);return c;}}:require(id);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const browser={visibilityState:'visible',addEventListener:(...v)=>events.push(v),removeEventListener(){}};
 require('node:vm').runInNewContext(js,{module:m,exports:m.exports,require:m.require.bind(m),Date,Set,Object,encodeURIComponent,document:browser,window:browser,fetch:async(url,options)=>{responses.set(url,options);return{ok:true,json:async()=>({businessDate:'2026-10-16',updatedAt:new Date(Date.now()-1000).toISOString(),reviewedAnalysisHistory:{businessDate:url.split('=').at(-1)}})};}});
 const stores=['2026-10-14','2026-10-15'].map(day=>m.exports.createRecommendationCenterStore(day)),unsubs=stores.map(s=>s.subscribe(()=>{})),signal=new AbortController().signal;
 for(let i=0;i<2;i++){const data=await controllers[i].options.request(signal);controllers[i].options.onData(data);a.equal(stores[i].getSnapshot().data.reviewedAnalysisHistory.businessDate,['2026-10-14','2026-10-15'][i]);}
 a.equal(responses.size,2);for(const o of responses.values()){a.equal(o.signal,signal);a.equal(o.cache,'no-store');a.equal(o.credentials,'include');}
 controllers[0].options.onError({status:403});a.equal(stores[0].getSnapshot().data,null);a.equal(stores[1].getSnapshot().data.reviewedAnalysisHistory.businessDate,'2026-10-15');
 unsubs[0]();a.equal(controllers[0].stopped,true);a.equal(controllers[1].stopped,false);unsubs[1]();a.equal(controllers[1].stopped,true);a.equal(stores[1].getSnapshot().data,null);
});
