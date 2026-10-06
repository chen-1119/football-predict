'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const collector=require('../scripts/collectPrematchV3Evidence.cjs');
const reader=require('../scripts/readPrematchV3OnlineInputs.cjs');
const adapter=require('../scripts/prematchTeamCollectionAdapter.cjs');
const ahAdapter=require('../scripts/prematchAsianHandicapCollectionAdapter.cjs');
const xgAdapter=require('../scripts/prematchXgCollectionAdapter.cjs');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const start='2026-10-06T07:00:00Z',received='2026-10-06T07:00:00.001Z',finished='2026-10-06T07:00:00.002Z';
function online(matches){
 const payload={version:reader.VERSION,readOnly:'on',productionWrites:0,businessDate:'2026-10-06',
  observedAt:'2026-10-06T06:59:59.999Z',generation:{data_generation_id:'synthetic',manifest_hash:'a'.repeat(64)},
  matches:matches||[{...collector.CAMPAIGN_BINDINGS[0],id:'sporttery_2041812',businessDate:'2026-10-06',
   kickoffTime:collector.CAMPAIGN_BINDINGS[0].eventVersion,status:'SCHEDULED',buyEndTime:collector.CAMPAIGN_BINDINGS[0].eventVersion}],
  modelArtifacts:[],modelArtifactInventory:[]};
 const rawBytes=Buffer.from(JSON.stringify(payload));
 const transport={hostKeyPinVerified:true,hostKeyFingerprint:'SHA256:'+'a'.repeat(43),startedAt:'2026-10-06T06:59:59Z',
  finishedAt:start,remoteResponseSha256:sha(rawBytes),remoteResponseFile:'synthetic.remote-response.json',bytes:rawBytes.length};
 Object.assign(transport,reader.validateTransport(transport,payload.observedAt));
 const input={...payload,transport};return {input,inputBytes:Buffer.from(JSON.stringify(input)),rawBytes,outputDir:'C:/synthetic-private'};
}
function kfaBytes(){
 const players=Array.from({length:11},(_,i)=>`<li><a onclick="view_player('${i+1}')"><p class="name">${i+1}. 선수${i}<br/>PLAYER ${i}</p>${i===0?'<p class="release">소집제외:2026-09-27</p>':''}<p class="profile"><br/>2000.01.01<br/>180Cm / 75Kg<br/>클럽 ${i}</p><p class="position mf">MF</p></a></li>`).join('');
 return Buffer.from(`<select><option value="8128" selected>2026년09월21일 남자 축구 국가대표팀 9월, 10월 평가전 소집명단</option></select><select><option selected value="2026">2026</option></select><div class="soccer_list"><ul class="conts">${players}</ul></div><table class="soccer-match-list"><tr><td><ul onclick="layer_popup_national_result('11043')"><li class="korea">남자 국가대표팀<span>0</span></li><li class="away">베네수엘라<span>0</span></li></ul><em>10. 02 금요일 20:00</em></td></tr></table>`);
}
function kfaReceipt(bytes,changes={}){
 const facts=adapter.parseKfaNationalPage(bytes),body={version:adapter.VERSION,endpoint:adapter.SOURCE_URL,
  requestStartedAt:start,collectorObservedAt:received,receivedAt:received,clockBasis:'collector-response-body-completed',
  sourcePublishedAt:null,sourcePublicationClockStatus:'not-provided-by-page',httpStatus:200,
  rawPayloadHash:sha(bytes),rawPayloadBytes:bytes.length,rawRelativePath:'synthetic.html',facts,factsHash:stableHash(facts),
  sourceVerification:'unverified',productionWrites:0,formalEligible:false,...changes};
 return {...body,contentHash:stableHash(body)};
}
function dependencies(changes={}){
 const bytes=kfaBytes(),receipt=kfaReceipt(bytes);let clocks=0,calls=0;
 const deps={now:()=>clocks++===0?start:finished,
  collectKfa:async()=>{calls++;return {receipt,outputPath:'C:/synthetic-private/synthetic.json'};},
  receiptFiles:bundle=>({receipt:bundle.receipt,bytes,receiptPath:bundle.outputPath,receiptFileHash:'b'.repeat(64)}),
  collectXg:async()=>({report:{version:xgAdapter.VERSION,receipts:[],failures:[],productionWrites:0,formalEligible:false},outputPath:'C:/synthetic-private/xg.json'}),
  xgReceiptFiles:bundle=>({report:bundle.report,items:[],reportPath:bundle.outputPath,reportFileHash:'c'.repeat(64)}),
  collectAh:async()=>({version:'synthetic-ah',productionWrites:0,formalEligible:false,fixtures:[],captures:[],
   asianHandicapObservations:[],summary:{eligibleV3Observations:0}}),...changes};
 return {deps,calls:()=>calls,bytes,receipt};
}
test('CLI requires explicit input/output and refuses cache scans and unknown switches',()=>{
 assert.deepEqual(collector.parseArgs(['--input','a','--output','b']),{input:'a',output:'b',history:null,ahStatus:null});
 for(const args of [[],['--input','a'],['--input','a','--input','b','--output','c'],
  ['--input','a','--output','b','--scan','c'],['--input','a','--output','b','--team-receipt','cached']])
  assert.throws(()=>collector.parseArgs(args),/V3_COLLECT_ARGS/);
});
test('current PG raw bytes must match; rehashing a substituted JSON payload cannot qualify it',async()=>{
 const bound=online(),mock=dependencies();bound.input.matches[0].homeTeamName='wrong';bound.inputBytes=Buffer.from(JSON.stringify(bound.input));
 await assert.rejects(collector.collectEvidence(bound,mock.deps),/ONLINE_INPUT_BINDING/);assert.equal(mock.calls(),0);
});
test('a stale online read stops all collection before external requests',async()=>{
 const bound=online(),mock=dependencies({now:()=> '2026-10-06T07:15:00Z'});
 await assert.rejects(collector.collectEvidence(bound,mock.deps),/ONLINE_INPUT_NOT_FRESH/);assert.equal(mock.calls(),0);
});
test('one actual KFA capture yields a bound partial fact, leaving missing impacts and other data explicit',async()=>{
 const bound=online(),mock=dependencies(),original=sha(bound.inputBytes);
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.equal(mock.calls(),1);assert.equal(result.summary.teamObservations,1);
 const event=result.events[0];assert.equal(event.sourceContract.teamObservations[0].providerObservedAt,received);
 assert.equal(event.sourceContract.teamObservations[0].sourcePublishedAt,null);
 assert.equal(event.assessment.teamSnapshot.features['home.injuries.knownUnavailablePlayers'],1);
 assert.equal(event.assessment.teamSnapshot.features['home.injuries.knownUnavailableAttackGapPer90'],null);
 assert.ok(event.missing.home.includes('roster'));assert.ok(event.missing.away.includes('injuries'));
 assert.equal(result.formalEligible,false);assert.equal(result.invariants.productionWrites,0);
 assert.equal(sha(bound.inputBytes),original);assert.equal(result.summary.formalRecommendations,0);
});
test('receipt facts cannot be changed by recomputing their own hashes while raw official bytes stay the same',async()=>{
 const bound=online(),mock=dependencies(),receipt=structuredClone(mock.receipt);
 receipt.facts.players[0].withdrawalDateAsDisplayed='2026-10-01';receipt.factsHash=stableHash(receipt.facts);
 const {contentHash,...body}=receipt;receipt.contentHash=stableHash(body);
 mock.deps.collectKfa=async()=>({receipt,outputPath:'C:/synthetic-private/synthetic.json'});
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.equal(result.summary.teamObservations,0);assert.equal(result.sourceReceipts.KFA.status,'failed');
 assert.equal(result.sourceReceipts.KFA.reason,'V3_COLLECT_TEAM_RAW_REPLAY');
});
test('a valid old receipt is not presented as new collection in the actual run window',async()=>{
 const bound=online(),mock=dependencies();
 const receipt=kfaReceipt(mock.bytes,{requestStartedAt:'2026-10-06T06:59:50Z',collectorObservedAt:'2026-10-06T06:59:51Z',receivedAt:'2026-10-06T06:59:51Z'});
 mock.deps.collectKfa=async()=>({receipt,outputPath:'C:/synthetic-private/synthetic.json'});
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.equal(result.summary.teamObservations,0);assert.equal(result.events[0].officialTeamCapture.reason,'source-actual-collection-window-invalid');
});
test('campaign binding rejects another identity, side name, and event date without fuzzy collection',async()=>{
 const bound=online(),match=bound.input.matches[0];
 for(const change of [{homeTeamId:'different'},{homeTeamName:'韩国U23'},{eventVersion:'2026-10-07T19:00:00+08:00'},
  {sourceMatchId:'2041813'}])assert.equal(collector.bindingFor({...match,...change}),null);
 const other={...match,homeTeamName:'韩国U23'},different=online([other]),mock=dependencies();
 const result=await collector.collectEvidence(different,mock.deps);assert.equal(mock.calls(),0);assert.equal(result.summary.teamObservations,0);
});
test('multiple explicitly bound events share one provider capture and retain their own event IDs',async()=>{
 const first=online().input.matches[0],second={...first,id:'sporttery_2041819',sourceMatchId:'2041819'},bound=online([first,second]);
 const mock=dependencies({bindings:[collector.CAMPAIGN_BINDINGS[0],{...collector.CAMPAIGN_BINDINGS[0],sourceMatchId:'2041819'}]});
 const result=await collector.collectEvidence(bound,mock.deps);assert.equal(mock.calls(),1);assert.equal(result.summary.teamObservations,2);
 assert.deepEqual(result.events.map(row=>row.sourceContract.teamObservations[0].sourceMatchId),['2041812','2041819']);
});
test('unverified AH arrays never enter the event source contract just because hashes are present',async()=>{
 const bound=online(),mock=dependencies({collectAh:async()=>({captures:[],fixtures:[],
  asianHandicapObservations:[{rawPayloadHash:'a'.repeat(64),source:'forged'}],summary:{eligibleV3Observations:1}})});
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.deepEqual(result.events[0].sourceContract.asianHandicapObservations,[]);assert.equal(result.summary.asianObservations,0);
});
test('microsecond source clocks cannot sneak into the earlier as-of boundary',()=>{
 assert.equal(collector.sourceWindow({requestStartedAt:start,receivedAt:'2026-10-06T07:00:00.002001Z'},start,finished),false);
});
function xgPacket(index=0,changes={}){
 const expected=xgAdapter.PILOT[index],ids={'Croatia':10155,'England':8491,'Czechia':8496,'Chicago Fire FC':6397,'Charlotte FC':100000,'Vancouver Whitecaps':307691,'DC United':100001};
 const home={id:ids[expected.home],name:expected.home},away={id:ids[expected.away],name:expected.away};
 const page={general:{matchId:String(5100000+index),homeTeam:home,awayTeam:away,matchTimeUTCDate:expected.kickoffAt,finished:true,gender:'male'},
  header:{teams:[{...home,score:1},{...away,score:2}],status:{utcTime:expected.kickoffAt,finished:true,started:true,cancelled:false,awarded:false,
   reason:{shortKey:'fulltime_short',longKey:'finished'},whoLostOnPenalties:null,halfs:{firstHalfStarted:'unparsed-source-clock',
    secondHalfStarted:'unparsed-source-clock',secondHalfEnded:'unparsed-source-clock',firstExtraHalfStarted:'',secondExtraHalfStarted:''}}},
  content:{stats:{Periods:{All:{stats:[{key:'expected_goals',title:'Expected goals (xG)',type:'title',rawStats:[null,null]},
   {key:'expected_goals',title:'Expected goals (xG)',type:'text',rawStats:[{value:0.4},{value:0.6}]}]},FirstHalf:{stats:[]},SecondHalf:{stats:[]}}},
   shotmap:{shots:[{teamId:home.id,period:'FirstHalf',expectedGoals:0.4,isOwnGoal:false},{teamId:away.id,period:'SecondHalf',expectedGoals:0.6,isOwnGoal:false}]}}};
 if(changes.modifyPage)changes.modifyPage(page);
 const bytes=Buffer.from(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:page}})}</script>`),facts=xgAdapter.parseObservedXgPage(bytes,expected);
 const body={version:xgAdapter.VERSION,requestedUrl:expected.url,finalUrl:expected.url,redirects:[],expectedEvent:expected,
  requestStartedAt:changes.requestStartedAt||start,collectorObservedAt:changes.receivedAt||received,receivedAt:changes.receivedAt||received,
  clockBasis:'collector-response-body-completed',sourcePublishedAt:null,httpStatus:200,contentType:'text/html; charset=utf-8',rawRelativePath:`xg-${index}.html`,
  rawPayloadHash:sha(bytes),rawPayloadBytes:bytes.length,facts,factsHash:stableHash(facts),sourceVerification:'unverified',formalEligible:false,productionWrites:0};
 return {receipt:{...body,contentHash:stableHash(body)},bytes,receiptPath:`C:/synthetic-private/xg-${index}.json`,receiptFileHash:'d'.repeat(64)};
}
function xgCurrentMatches(){
 return [{...collector.CAMPAIGN_BINDINGS[1]},
  {sourceMatchId:'2041818',eventVersion:'2026-10-07T02:45:00+08:00',homeTeamId:'team_uxz399',awayTeamId:'team_r7pbr4',homeTeamName:'克罗地亚',awayTeamName:'西班牙'},
  {sourceMatchId:'2041822',eventVersion:'2026-10-07T08:30:00+08:00',homeTeamId:'team_wrowvw',awayTeamId:'team_1uc711l',homeTeamName:'芝加哥火焰',awayTeamName:'温哥华白帽'}]
  .map(match=>({...match,id:'sporttery_'+match.sourceMatchId,businessDate:'2026-10-06',kickoffTime:match.eventVersion,buyEndTime:match.eventVersion,status:'SCHEDULED'}));
}
function xgDependencies(items,changes={}){
 let requests=0,providerNames;
 const report={version:xgAdapter.VERSION,receipts:items.map((item,index)=>({receiptRelativePath:`xg-${index}.json`,receipt:item.receipt})),
  failures:[],productionWrites:0,formalEligible:false};
 const mock=dependencies({bindings:[],collectXg:async({targetProviderNames})=>{requests++;providerNames=targetProviderNames;return {report,outputPath:'C:/synthetic-private/xg.json'};},
  xgReceiptFiles:()=>({report,items,reportPath:'C:/synthetic-private/xg.json',reportFileHash:'c'.repeat(64)}),...changes});
 return {...mock,requests:()=>requests,providerNames:()=>providerNames};
}
test('one bounded public xG capture binds actual prior measurements to current sides and leaves conflicting data unknown',async()=>{
 const items=[xgPacket(0),xgPacket(1),xgPacket(2),xgPacket(3,{modifyPage:p=>{p.content.shotmap.shots[0].expectedGoals=0.5;}})];
 const bound=online(xgCurrentMatches()),original=sha(bound.inputBytes),mock=xgDependencies(items);
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.equal(mock.requests(),1);assert.deepEqual(new Set(mock.providerNames()),new Set(['England','Czechia','Croatia','Chicago Fire FC','Vancouver Whitecaps']));
 assert.equal(result.observedXgCapture.eligibleSourceMeasurements,3);assert.equal(result.summary.eventSidesWithObservedXg,4);
 assert.equal(result.summary.eventsBothTeamsWithObservedXg,1);assert.equal(result.events[1].assessment.teamSnapshot.features['home.xg.sampleCount'],2);
 const england=result.events[0].sourceContract.teamObservations.find(observation=>observation.family==='xg'&&observation.side==='home');
 assert.equal(england.data.rows[0].observedXgFor,0.6);assert.equal(england.data.rows[0].sourcePublishedAt,null);
 assert.equal(england.data.rows[0].receivedAt,received);assert.equal(england.identityMappingReviewedAt,finished);
 assert.ok(result.events[2].missing.away.includes('xg'));assert.equal(sha(bound.inputBytes),original);
 assert.equal(result.formalEligible,false);assert.equal(result.summary.formalRecommendations,0);assert.equal(result.invariants.trainedParameters,false);
});
test('rehashing xG facts cannot change raw HTML; old or future collection clocks cannot create fresh features',async()=>{
 const changed=xgPacket(0);changed.receipt.facts.away.observedXg=9;changed.receipt.factsHash=stableHash(changed.receipt.facts);
 const {contentHash,...body}=changed.receipt;changed.receipt.contentHash=stableHash(body);
 for(const item of [changed,xgPacket(0,{requestStartedAt:'2026-10-06T06:59:58Z',receivedAt:'2026-10-06T06:59:59Z'}),
  xgPacket(0,{receivedAt:'2026-10-06T07:00:00.002001Z'})]){
  const result=await collector.collectEvidence(online([xgCurrentMatches()[0]]),xgDependencies([item]).deps);
  assert.equal(result.summary.eventSidesWithObservedXg,0);assert.equal(result.observedXgCapture.eligibleSourceMeasurements,0);
  assert.equal(result.events[0].sourceContract.teamObservations.length,0);
 }
});
test('xG identity cannot fuzzy-bind another PG team, provider side, event or category',async()=>{
 const original=xgCurrentMatches()[0],homeBinding=collector.XG_CAMPAIGN_BINDINGS[0];
 for(const change of [{homeTeamId:'wrong'},{homeTeamName:'英格兰U23'},{sourceMatchId:'2041819'},
  {eventVersion:'2026-10-08T02:45:00+08:00',kickoffTime:'2026-10-08T02:45:00+08:00'}]){
  const changed={...original,...change};changed.id='sporttery_'+changed.sourceMatchId;
  if(change.kickoffTime)changed.buyEndTime=change.kickoffTime;
  assert.deepEqual(collector.xgBindingsFor(changed,[homeBinding]),[]);
  const mock=xgDependencies([xgPacket()],{xgBindings:[homeBinding]});
  const result=await collector.collectEvidence(online([changed]),mock.deps);assert.equal(mock.requests(),0);
  assert.equal(result.summary.eventSidesWithObservedXg,0);
 }
 const wrongProvider=xgDependencies([xgPacket()],{xgBindings:[{...homeBinding,providerTeamId:'10155',providerTeamName:'England'}]});
 const result=await collector.collectEvidence(online([original]),wrongProvider.deps);assert.equal(result.summary.eventSidesWithObservedXg,0);
});
test('duplicate prior xG matches are one sample and closed current events never gain usable xG',async()=>{
 const item=xgPacket(),match=xgCurrentMatches()[0];
 const result=await collector.collectEvidence(online([match]),xgDependencies([item,item]).deps);
 assert.equal(result.events[0].assessment.teamSnapshot.features['home.xg.sampleCount'],1);
 assert.ok(result.events[0].xgAdaptations.home.rejected.some(value=>value.reason==='duplicate-prior-event-not-another-sample'));
 for(const change of [{status:'FINISHED'},{isOnSale:false},{saleStatus:'CLOSED'}]){
  const closed=await collector.collectEvidence(online([{...match,...change}]),xgDependencies([item]).deps);
  assert.equal(closed.summary.eventSidesWithObservedXg,0);assert.equal(closed.formalEligible,false);
 }
});
test('xG review clocks are observed after raw semantic replay and before the final snapshot clock',async()=>{
 const item=xgPacket(),bound=online([xgCurrentMatches()[0]]),verified=xgAdapter.verifyObservedXgReceipt;
 let replayCount=0,clockCalls=0;const stages=[];
 xgAdapter.verifyObservedXgReceipt=(...args)=>{const value=verified(...args);replayCount++;return value;};
 const now=()=>{const at=`2026-10-06T07:00:00.${String(clockCalls*3).padStart(3,'0')}Z`;
  stages.push({at,replayCount});clockCalls++;return at;};
 try{
  const result=await collector.collectEvidence(bound,xgDependencies([item],{now}).deps);
  assert.equal(stages[0].replayCount,0);assert.ok(stages[1].replayCount>0);
  assert.equal(stages.length,4);assert.equal(result.calculatedAt,stages[3].at);
  const home=result.events[0].xgAdaptations.home,mapping=home.providerMappings[0];
  assert.equal(home.reviewCompletedAt,stages[1].at);assert.equal(mapping.reviewedAt,stages[1].at);
  assert.ok(stages[1].at<result.calculatedAt);assert.ok(stages[2].replayCount>stages[1].replayCount);
  const observation=home.teamObservations[0];assert.equal(observation.identityMappingReviewedAt,stages[1].at);
  assert.equal(observation.providerObservedAt,received);assert.equal(observation.receivedAt,received);
  assert.equal(observation.data.rows[0].receivedAt,received);assert.equal(result.formalEligible,false);
 }finally{xgAdapter.verifyObservedXgReceipt=verified;}
});
test('a backward final clock cannot turn a completed xG review into an earlier eligible snapshot',async()=>{
 const clocks=[start,'2026-10-06T07:00:00.003Z','2026-10-06T07:00:00.004Z',finished];let index=0;
 await assert.rejects(collector.collectEvidence(online([xgCurrentMatches()[0]]),
  xgDependencies([xgPacket()],{now:()=>clocks[index++]}).deps),/XG_REVIEW_AFTER_SNAPSHOT/);
});
test('public or production paths are never valid research output destinations',()=>{
 for(const output of ['public/data/external-signals.json','src/new.json','outputs/prematch-v3-test/../../public/data/new.json'])
  assert.throws(()=>collector.privateOutputPath(output),/PRIVATE_OUTPUT_REQUIRED/);
});
function accessStatus(){
 const kickoffTime='2026-10-06T19:00:00+08:00',landing='<tr class="bet-tb-tr" data-id="101" data-fixtureid="201" data-homeid="301" data-awayid="401" data-homesxname="Synthetic Home" data-awaysxname="Synthetic Away" data-matchdate="2026-10-06" data-matchtime="19:00"><a href="https://odds.500.com/fenxi/yazhi-201.shtml">&#20122;</a></tr>';
 // Use GBK source bytes for the visible Asian-market anchor.
 const landingBytes=require('iconv-lite').encode(landing.replace('&#20122;','亚'),'gbk');
 const capture=(url,body,requestAt,responseAt,kind)=>ahAdapter.captureState({url,body,statusCode:200,startedAt:requestAt,
  receivedAt:responseAt,bytes:body.length,rawPayloadHash:sha(body),rawBase64:body.toString('base64')},kind).capture;
 const captures=[capture(ahAdapter.LANDING_URL,landingBytes,'2026-10-06T06:58:00Z','2026-10-06T06:58:00.4Z','landing'),
  capture('https://odds.500.com/fenxi/yazhi-201.shtml',Buffer.from('Security Verification captcha.eo.gtimg.com'),
   '2026-10-06T06:58:00.5Z','2026-10-06T06:58:00.9Z','asian')];
 const body={version:ahAdapter.VERSION,startedAt:'2026-10-06T06:58:00Z',finishedAt:'2026-10-06T06:58:01Z',
  onlineInputObservedAt:'2026-10-06T06:57:59Z',inputGeneration:{data_generation_id:'synthetic-previous',manifest_hash:'a'.repeat(64)},
  productionWrites:0,formalEligible:false,predictionEligible:false,completeTimeline:false,asianHandicapObservations:[],captures,
  fixtures:[{sourceMatchId:'101',fixtureId:'201',asianHandicapUrl:'https://odds.500.com/fenxi/yazhi-201.shtml',
   homeTeamId:'301',awayTeamId:'401',kickoffTime,state:'blocked',captureHash:captures[1].rawPayloadHash,
   receivedAt:captures[1].receivedAt,rows:[]}]};
 return {...body,contentHash:sha(JSON.stringify(body))};
}
test('a verified recent block only reuses access status; AH is not fetched or made fresh',async()=>{
 const bound=online(),mock=dependencies();let requests=0;
 mock.deps.collectAh=async()=>{requests++;throw Error('must not request blocked host');};
 const result=await collector.collectEvidence({...bound,ahStatus:accessStatus()},mock.deps);
 assert.equal(requests,0);assert.equal(result.asianHandicapCapture.reusedAccessStatusOnly,true);
 assert.equal(result.asianHandicapCapture.capturesFetchedThisRun,0);
 assert.equal(result.asianHandicapCapture.failureObservedAt,'2026-10-06T06:58:00.9Z');
 assert.deepEqual(result.events[0].sourceContract.asianHandicapObservations,[]);
});
test('access status requires raw body/hash replay, even when the outer JSON hash is recomputed',()=>{
 const value=accessStatus();value.captures[1].rawPayloadHash='f'.repeat(64);
 const {contentHash,...body}=value;value.contentHash=sha(JSON.stringify(body));
 assert.throws(()=>collector.validateAhAccessStatus(value,{asOf:start}),/AH_STATUS_RAW_HASH/);
 const quotes=accessStatus();quotes.fixtures[0].rows=[{company:'invented',current:{rawHomeWater:0.99}}];
 const original=quotes.contentHash;delete quotes.contentHash;quotes.contentHash=sha(JSON.stringify(quotes));
 assert.notEqual(quotes.contentHash,original);
 assert.throws(()=>collector.validateAhAccessStatus(quotes,{asOf:start}),/AH_STATUS_FIXTURE_BINDING/);
});
test('source access blocks cannot be backdated from a future response; six hours expires only the backoff',()=>{
 const value=accessStatus();
 assert.throws(()=>collector.validateAhAccessStatus(value,{asOf:'2026-10-06T06:57:00Z'}),/AH_STATUS_CLOCK/);
 assert.equal(collector.validateAhAccessStatus(value,{asOf:'2026-10-06T12:58:00.9Z'}).active,false);
});
test('FA two-page collector is replayed once and name-only availability stays outside V3 player features',async()=>{
 const groups=[['Goalkeepers',['Player One','Player Two']],['Defenders',['Ezri Konsa',"Nico O'Reilly",'Player Three']],
  ['Midfielders',['Alex Scott','Player Four','Player Five']],['Forwards',['Player Six','Player Seven','Player Eight']]];
 const list=groups.map(([label,names])=>`${label}: ${names.map(name=>`${name} (Club)`).join(', ')}<br/>`).join('<br/>');
 const pages=[Buffer.from(`<h1>England squad named for September and October window</h1><div class="rte-content rte-content--normal"><p>${list}</p></div>`),
  Buffer.from('<h1>Squad update: Scott and Konsa withdrawn</h1><div class="rte-content rte-content--normal"><p>10am, Monday 5 October</p><p>Ezri Konsa and Alex Scott have been ruled out of Tuesday&rsquo;s UEFA Nations League meeting with Czechia at Wembley.</p><p>Thomas Tuchel will continue with a squad of 9 players.</p><p>Rico Lewis has been added to the England squad ahead of Tuesday&rsquo;s UEFA Nations League fixture against Czechia at Wembley Stadium.</p><p>Nico O\'Reilly has returned to Manchester City and will play no part in the forthcoming UEFA Nations League fixtures.</p></div>')];
 const facts=adapter.parseEnglandTeamPages(...pages);
 const rawPages=pages.map((bytes,i)=>({endpoint:[adapter.ENGLAND_SQUAD_URL,adapter.ENGLAND_UPDATE_URL][i],kind:['squad','updates'][i],
  requestStartedAt:i?'2026-10-06T07:00:00.0007Z':start,collectorObservedAt:i?received:'2026-10-06T07:00:00.0005Z',
  receivedAt:i?received:'2026-10-06T07:00:00.0005Z',httpStatus:200,rawRelativePath:`fa-${i}.html`,rawPayloadHash:sha(bytes),rawPayloadBytes:bytes.length}));
 const body={version:adapter.ENGLAND_VERSION,collectorObservedAt:received,receivedAt:received,clockBasis:'collector-response-bodies-completed',
  sourcePublishedAt:null,sourcePublicationClockStatus:'visible-display-time-without-zone',rawPages,facts,factsHash:stableHash(facts),
  sourceVerification:'unverified',productionWrites:0,formalEligible:false};
 const receipt={...body,contentHash:stableHash(body)},binding=collector.CAMPAIGN_BINDINGS[1];
 const bound=online([{...binding,id:'sporttery_2041817',businessDate:'2026-10-06',kickoffTime:binding.eventVersion,
  status:'SCHEDULED',buyEndTime:binding.eventVersion}]);let requests=0;
 const mock=dependencies({collectEngland:async()=>{requests++;return{receipt,outputPath:'C:/synthetic-private/fa.json'};},
  receiptFiles:bundle=>({receipt:bundle.receipt,rawPages:pages,receiptPath:bundle.outputPath,receiptFileHash:'b'.repeat(64)})});
 const result=await collector.collectEvidence(bound,mock.deps);
 assert.equal(requests,1);assert.equal(mock.calls(),0);assert.equal(result.summary.eventsWithOfficialFacts,1);
 assert.equal(result.events[0].officialTeamCapture.currentSquadCountAsDisplayed,9);
 assert.equal(result.events[0].officialTeamCapture.explicitWithdrawals,3);
 assert.deepEqual(result.events[0].sourceContract.teamObservations,[]);
 assert.equal(result.events[0].assessment.teamSnapshot.features['home.injuries.knownUnavailablePlayers'],null);
});
function historyFor(bound){
 const module=require('../scripts/readPrematchV3TeamHistory.cjs'),match=bound.input.matches[0];
 const sourceRow={sourceMatchId:'303',eventVersion:'2026-10-01T12:00:00Z',homeTeamId:match.homeTeamId,
  awayTeamId:'synthetic-opponent',homeTeamName:match.homeTeamName,awayTeamName:'Synthetic Opponent',scoreHome:2,scoreAway:1,
  resultSource:'sporttery:official-api',resultObservedAt:'2026-10-01T14:00:00Z'};
 const head=require('../scripts/recommendationPlatform/results.cjs').collectResults([sourceRow],new Map(),
  {isFinal:()=>true,isVoid:()=>false},Date.parse(sourceRow.resultObservedAt)).updates[0];
 const observedAt='2026-10-06T06:59:59.9995Z',windowEndAt='2026-10-06T06:59:59Z';
 const payload={version:module.VERSION,observedAt,readOnly:'on',productionWrites:0,generation:bound.input.generation,
  windowEndAt,windowStartAt:new Date(Date.parse(windowEndAt)-module.LOOKBACK_DAYS*86400000).toISOString(),
  rows:[{teamId:match.homeTeamId,teamName:match.homeTeamName,sourceMatchId:sourceRow.sourceMatchId,
   kickoffTime:sourceRow.eventVersion,homeTeamId:sourceRow.homeTeamId,awayTeamId:sourceRow.awayTeamId,
   homeTeamName:sourceRow.homeTeamName,awayTeamName:sourceRow.awayTeamName,scoreHome:2,scoreAway:1,resultHead:head,
   historySnapshotBound:true,historySourceMatchId:sourceRow.sourceMatchId,historyKickoffTime:sourceRow.eventVersion,
   historyEventVersion:sourceRow.eventVersion,historyHomeTeamId:sourceRow.homeTeamId,historyAwayTeamId:sourceRow.awayTeamId}]};
 const raw=Buffer.from(JSON.stringify(payload)),transport={hostKeyPinVerified:true,
  hostKeyFingerprint:bound.input.transport.hostKeyFingerprint,startedAt:'2026-10-06T06:59:59.9991Z',finishedAt:'2026-10-06T06:59:59.9999Z',
  remoteResponseSha256:sha(raw),remoteResponseFile:'synthetic-history.remote-response.json',bytes:raw.length};
 Object.assign(transport,reader.validateTransport(transport,observedAt));
 const body={...payload,targets:module.targetsFor(bound.input),transport,targetReadSha256:sha(bound.inputBytes),
  targetReadRemoteSha256:sha(bound.rawBytes),formalEligible:false,
  sourceAdmission:'stored-reference-only; PG presence does not authenticate provider data'};
 return {value:{...body,contentHash:stableHash(body)},raw};
}
test('a bound official PG ledger sample enters history features but never creates fatigue or a full coverage claim',async()=>{
 const bound=online(),mock=dependencies(),history=historyFor(bound);
 const result=await collector.collectEvidence({...bound,history},mock.deps),event=result.events[0];
 assert.equal(event.historyAdaptations.home.status,'captured',JSON.stringify(event.historyAdaptations.home));
 assert.equal(event.assessment.teamSnapshot.features['home.history.sampleCount'],1);
 assert.equal(event.assessment.teamSnapshot.features['home.history.goalsForPerMatch'],2);
 assert.equal(event.assessment.teamSnapshot.features['home.fatigue.restDays'],null);
 assert.equal(event.historyAdaptations.home.completeTeamHistory,false);
 assert.equal(result.summary.eventSidesWithHistory,1);assert.equal(result.summary.eventsBothTeamsWithHistory,0);
 assert.equal(result.summary.referenceHistoryRows,1);assert.equal(result.formalEligible,false);
});
test('rehashing a substituted PG history payload cannot bypass the original remote-response binding',async()=>{
 const bound=online(),mock=dependencies(),history=historyFor(bound);
 history.value.rows[0].scoreHome=3;const {contentHash,...body}=history.value;history.value.contentHash=stableHash(body);
 await assert.rejects(collector.collectEvidence({...bound,history},mock.deps),/HISTORY_PAYLOAD_BINDING/);
 assert.equal(mock.calls(),0);
});
