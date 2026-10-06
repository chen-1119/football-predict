'use strict';
// A private research intake, never a production writer or source-admission gate.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const {epochNanoseconds:clock}=require('../src/services/prematchV3Clock.cjs');
const reader=require('./readPrematchV3OnlineInputs.cjs');
const teamAdapter=require('./prematchTeamCollectionAdapter.cjs');
const ahAdapter=require('./prematchAsianHandicapCollectionAdapter.cjs');
const xgAdapter=require('./prematchXgCollectionAdapter.cjs');
const {eventFromMatch,buildPrematchV3Assessment}=require('../src/services/prematchV3Assessment.cjs');
const VERSION='prematch-v3-live-evidence-research-v1',FRESH_NS=15n*60n*1000000000n;
const MAX_OUTPUT_BYTES=16*1024*1024;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(value,code)=>{if(!value)throw Error('V3_COLLECT_'+code);};
// Explicit campaign bindings. Namespace mapping stays research-only and is not
// generalized to U23, women, a fuzzy name, or another calendar event.
const CAMPAIGN_BINDINGS=Object.freeze([
 {provider:'KFA',sourceMatchId:'2041812',eventVersion:'2026-10-06T19:00:00+08:00',side:'home',teamCategory:'senior-men',
  homeTeamId:'team_rivd4r',awayTeamId:'team_1c4kl5h',homeTeamName:'韩国',awayTeamName:'乌兹别克斯坦'},
 {provider:'FA',sourceMatchId:'2041817',eventVersion:'2026-10-07T02:45:00+08:00',side:'home',teamCategory:'senior-men',
  homeTeamId:'team_1hdqy5s',awayTeamId:'team_wsft8n',homeTeamName:'英格兰',awayTeamName:'捷克'},
]);
// Provider IDs are bound to an explicit current event and a reviewed bilingual
// identity. Capturing a same-looking country name never creates a new mapping.
const XG_CAMPAIGN_BINDINGS=Object.freeze([
 {sourceMatchId:'2041817',eventVersion:'2026-10-07T02:45:00+08:00',side:'home',siteTeamId:'team_1hdqy5s',siteTeamName:'英格兰',providerTeamId:'8491',providerTeamName:'England'},
 {sourceMatchId:'2041817',eventVersion:'2026-10-07T02:45:00+08:00',side:'away',siteTeamId:'team_wsft8n',siteTeamName:'捷克',providerTeamId:'8496',providerTeamName:'Czechia'},
 {sourceMatchId:'2041818',eventVersion:'2026-10-07T02:45:00+08:00',side:'home',siteTeamId:'team_uxz399',siteTeamName:'克罗地亚',providerTeamId:'10155',providerTeamName:'Croatia'},
 {sourceMatchId:'2041822',eventVersion:'2026-10-07T08:30:00+08:00',side:'home',siteTeamId:'team_wrowvw',siteTeamName:'芝加哥火焰',providerTeamId:'6397',providerTeamName:'Chicago Fire FC'},
 {sourceMatchId:'2041822',eventVersion:'2026-10-07T08:30:00+08:00',side:'away',siteTeamId:'team_1uc711l',siteTeamName:'温哥华白帽',providerTeamId:'307691',providerTeamName:'Vancouver Whitecaps'},
]);
function parseArgs(args){
 const values={};
 for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1];
  check(['--input','--output','--history','--ah-status'].includes(key)&&!values[key]&&typeof value==='string'&&value.length>0
   &&value.length<=4096&&!/[\x00-\x1f\x7f]/.test(value)&&!value.startsWith('--'),'ARGS');values[key]=value;
 }
 check(values['--input']&&values['--output'],'ARGS');
 return {input:values['--input'],output:values['--output'],history:values['--history']||null,ahStatus:values['--ah-status']||null};
}
function bindingFor(match,bindings=CAMPAIGN_BINDINGS){
 const event=eventFromMatch(match);
 const found=bindings.filter(binding=>binding.sourceMatchId===event.sourceMatchId&&clock(binding.eventVersion)!==null
  &&clock(binding.eventVersion)===clock(event.eventVersion)&&clock(binding.eventVersion)===clock(event.kickoffTime)
  &&['homeTeamId','awayTeamId','homeTeamName','awayTeamName'].every(key=>binding[key]===match[key]));
 check(found.length<=1,'BINDING_CONFLICT');
 return found[0] ? {...found[0],sourceVerification:'unverified',formalEligible:false,
  basis:'explicit-current-PG-event-and-official-provider-senior-men-scope;not-external-source-admission'} : null;
}
function validKnowledgeWindow(input,asOf){
 const at=clock(asOf),read=clock(input?.observedAt);
 return at!==null&&read!==null&&read<=at&&at-read<=FRESH_NS;
}
function sourceWindow(receipt,startedAt,asOf){
 if(Array.isArray(receipt?.rawPages))return receipt.rawPages.length>0&&receipt.rawPages.every(page=>sourceWindow(page,startedAt,asOf))
  &&clock(receipt.receivedAt)!==null&&clock(receipt.receivedAt)<=clock(asOf);
 const start=clock(receipt?.requestStartedAt),received=clock(receipt?.receivedAt),runStart=clock(startedAt),at=clock(asOf);
 return start!==null&&received!==null&&runStart!==null&&at!==null&&start>=runStart&&start<=received&&received<=at;
}
function receiptFiles(bundle,outputDir){
 check(bundle&&bundle.receipt&&typeof bundle.outputPath==='string','TEAM_COLLECTION_RESULT');
 const receiptPath=path.resolve(bundle.outputPath);
 check(path.dirname(receiptPath)===outputDir&&fs.statSync(receiptPath).size<=4*1024*1024,'TEAM_RECEIPT_PATH');
 const diskBytes=fs.readFileSync(receiptPath),disk=JSON.parse(diskBytes);
 check(stableHash(disk)===stableHash(bundle.receipt),'TEAM_RECEIPT_CHANGED');
 const relatives=Array.isArray(disk.rawPages)?disk.rawPages.map(page=>page.rawRelativePath):[disk.rawRelativePath];
 check(relatives.length>0&&relatives.length<=2,'TEAM_RAW_PATH');
 const rawPaths=relatives.map(relative=>{
  check(typeof relative==='string'&&path.basename(relative)===relative&&relative!==path.basename(receiptPath),'TEAM_RAW_PATH');
  const rawPath=path.join(outputDir,relative);check(fs.statSync(rawPath).size<=teamAdapter.MAX_BYTES,'TEAM_RAW_BOUND');return rawPath;
 });
 const rawPages=rawPaths.map(rawPath=>fs.readFileSync(rawPath));
 return {receipt:disk,bytes:rawPages.length===1?rawPages[0]:undefined,rawPages,receiptPath,
  receiptFileHash:hash(diskBytes),rawPaths};
}
function xgBindingsFor(match,bindings=XG_CAMPAIGN_BINDINGS){
 const event=eventFromMatch(match);
 return bindings.filter(binding=>['home','away'].includes(binding.side)&&binding.sourceMatchId===event.sourceMatchId
  &&clock(binding.eventVersion)!==null&&clock(binding.eventVersion)===clock(event.eventVersion)
  &&clock(event.eventVersion)===clock(event.kickoffTime)&&binding.siteTeamId===event[`${binding.side}TeamId`]
  &&binding.siteTeamName===match[`${binding.side}TeamName`]);
}
function xgReceiptFiles(bundle,outputDir){
 check(bundle&&bundle.report&&typeof bundle.outputPath==='string','XG_COLLECTION_RESULT');
 const reportPath=path.resolve(bundle.outputPath);
 check(path.dirname(reportPath)===outputDir&&fs.statSync(reportPath).size<=4*1024*1024,'XG_REPORT_PATH');
 const reportBytes=fs.readFileSync(reportPath),report=JSON.parse(reportBytes),{contentHash,...body}=report;
 check(stableHash(report)===stableHash(bundle.report)&&stableHash(body)===contentHash&&report.version===xgAdapter.VERSION
  &&report.productionWrites===0&&report.formalEligible===false&&report.sourceVerification==='unverified'
  &&report.maximumPages===4&&Array.isArray(report.receipts)&&report.receipts.length<=4&&Array.isArray(report.failures)
  &&Number.isSafeInteger(report.selectedPages)&&report.selectedPages>=0&&report.selectedPages<=4
  &&report.receipts.length+report.failures.length===report.selectedPages&&report.actualReceipts===report.receipts.length
  &&report.observedMatches===report.receipts.filter(item=>item.receipt?.facts?.status==='observed').length,'XG_REPORT_BINDING');
 const seen=new Set();
 const items=report.receipts.map(item=>{
  const relative=item.receiptRelativePath;
  check(typeof relative==='string'&&path.basename(relative)===relative,'XG_RECEIPT_PATH');
  const receiptPath=path.join(outputDir,relative);check(fs.statSync(receiptPath).size<=2*1024*1024,'XG_RECEIPT_BOUND');
  const receiptBytes=fs.readFileSync(receiptPath),receipt=JSON.parse(receiptBytes);
  check(stableHash(receipt)===stableHash(item.receipt)&&!seen.has(receipt.requestedUrl),'XG_RECEIPT_CHANGED');seen.add(receipt.requestedUrl);
  check(typeof receipt.rawRelativePath==='string'&&path.basename(receipt.rawRelativePath)===receipt.rawRelativePath
   &&receipt.rawRelativePath!==relative,'XG_RAW_PATH');
  const rawPath=path.join(outputDir,receipt.rawRelativePath);check(fs.statSync(rawPath).size<=xgAdapter.MAX_BYTES,'XG_RAW_BOUND');
  const bytes=fs.readFileSync(rawPath);
  check(hash(bytes)===receipt.rawPayloadHash&&bytes.length===receipt.rawPayloadBytes,'XG_RAW_HASH');
  return {receipt,bytes,receiptPath,rawPath,receiptFileHash:hash(receiptBytes)};
 });
 return {report,items,reportPath,reportFileHash:hash(reportBytes)};
}
function reviewedXgMapping(binding,receipt,asOf){
 const body={version:xgAdapter.MAPPING_VERSION,sourceVerification:'unverified',formalEligible:false,
  sourceReceiptHash:receipt.contentHash,sourceMatchId:binding.sourceMatchId,eventVersion:binding.eventVersion,
  siteTeamId:binding.siteTeamId,siteTeamName:binding.siteTeamName,providerTeamId:binding.providerTeamId,providerTeamName:binding.providerTeamName,
  reviewedAt:asOf,reviewClockBasis:'current-run-exact-identity-replay-and-mapping-binding-completed',
  mappingScope:'explicit-current-event-and-provider-identity;not-external-source-admission'};
 return {...body,contentHash:stableHash(body)};
}
function validateHistoryEvidence(history,{input,inputBytes,rawBytes,asOf}){
 const module=require('./readPrematchV3TeamHistory.cjs');
 const {contentHash,transport,targets,targetReadSha256,targetReadRemoteSha256,formalEligible,sourceAdmission,...payload}=history.value;
 check(contentHash===stableHash({...history.value,contentHash:undefined}),'HISTORY_HASH');
 check(Buffer.isBuffer(history.raw)&&history.raw.length<=module.MAX_BYTES&&hash(history.raw)===transport?.remoteResponseSha256
  &&history.raw.length===transport?.bytes,'HISTORY_RAW_BINDING');
 check(stableHash(JSON.parse(history.raw))===stableHash(payload),'HISTORY_PAYLOAD_BINDING');
 check(stableHash(targets)===stableHash(module.targetsFor(input))&&targetReadSha256===hash(inputBytes)
  &&targetReadRemoteSha256===hash(rawBytes),'HISTORY_TARGET_BINDING');
 module.validate(payload,targets);
 const expectedTransport=reader.validateTransport(transport,payload.observedAt);
 check(Object.entries(expectedTransport).every(([key,value])=>transport[key]===value)
  &&transport.hostKeyFingerprint===input.transport.hostKeyFingerprint,'HISTORY_TRANSPORT');
 check(formalEligible===false&&sourceAdmission==='stored-reference-only; PG presence does not authenticate provider data'
  &&clock(payload.observedAt)>=clock(input.observedAt)&&clock(payload.observedAt)<=clock(asOf)
  &&clock(asOf)-clock(payload.observedAt)<=FRESH_NS,'HISTORY_CLOCK_OR_ADMISSION');
 return structuredClone(history.value);
}
function validateAhAccessStatus(value,{asOf}={}){
 check(value?.version===ahAdapter.VERSION&&value.productionWrites===0&&value.formalEligible===false
  &&value.predictionEligible===false&&value.completeTimeline===false&&Array.isArray(value.asianHandicapObservations)
  &&value.asianHandicapObservations.length===0&&Array.isArray(value.captures)&&value.captures.length>0
  &&value.captures.length<=ahAdapter.MAX_MATCHES+1&&Array.isArray(value.fixtures)&&value.fixtures.length<=ahAdapter.MAX_MATCHES,'AH_STATUS_SCHEMA');
 const {contentHash,...body}=value;check(contentHash===hash(JSON.stringify(body)),'AH_STATUS_CONTENT_HASH');
 const start=clock(value.startedAt),finish=clock(value.finishedAt),inputAt=clock(value.onlineInputObservedAt),at=clock(asOf);
 check(start!==null&&finish!==null&&inputAt!==null&&at!==null&&inputAt<=start&&start<=finish&&finish<=at,'AH_STATUS_CLOCK');
 check(typeof value.inputGeneration?.data_generation_id==='string'&&/^[a-f0-9]{64}$/.test(value.inputGeneration?.manifest_hash||''),'AH_STATUS_GENERATION');
 const urls=new Set(),decoded=[];
 for(const capture of value.captures){
  check(ahAdapter.allowedUrl(capture.url)===capture.url&&!urls.has(capture.url),'AH_STATUS_URL');urls.add(capture.url);
  check(typeof capture.rawBase64==='string'&&capture.rawBase64.length<=ahAdapter.MAX_BYTES*2,'AH_STATUS_RAW_BOUND');
  const bytes=Buffer.from(capture.rawBase64,'base64');
  check(bytes.toString('base64')===capture.rawBase64&&bytes.length===capture.bytes&&bytes.length<=ahAdapter.MAX_BYTES
   &&hash(bytes)===capture.rawPayloadHash,'AH_STATUS_RAW_HASH');
  const began=clock(capture.startedAt),received=clock(capture.receivedAt);
  check(began!==null&&received!==null&&start<=began&&began<=received&&received<=finish
   &&Number.isSafeInteger(capture.statusCode)&&capture.statusCode>=100&&capture.statusCode<=599,'AH_STATUS_CAPTURE_CLOCK');
  const replay=ahAdapter.captureState({...capture,body:bytes},capture.url===ahAdapter.LANDING_URL?'landing':'asian');
  check(replay.capture.state===capture.state&&replay.capture.reason===capture.reason
   &&replay.capture.decodingReplacementCount===capture.decodingReplacementCount,'AH_STATUS_RAW_REPLAY');
  decoded.push({...replay,url:capture.url,receivedAt:capture.receivedAt});
 }
 const landing=decoded.find(capture=>capture.url===ahAdapter.LANDING_URL);
 check(landing&&['available','partial'].includes(landing.capture.state),'AH_STATUS_LANDING');
 const publicFixtures=ahAdapter.parseTradeFixtures(landing.html),challenges=decoded.filter(capture=>capture.url!==ahAdapter.LANDING_URL
  &&capture.capture.reason==='source-security-challenge'&&capture.capture.state==='blocked');
 check(challenges.length===1&&publicFixtures.some(fixture=>fixture.asianHandicapUrl===challenges[0].url),'AH_STATUS_CHALLENGE_BINDING');
 for(const fixture of value.fixtures){
  const publicFixture=publicFixtures.find(row=>row.sourceMatchId===fixture.sourceMatchId);
  check(publicFixture&&['fixtureId','asianHandicapUrl','homeTeamId','awayTeamId'].every(key=>fixture[key]===publicFixture[key])
   &&clock(fixture.kickoffTime)===clock(publicFixture.kickoffTime)&&Array.isArray(fixture.rows)&&fixture.rows.length===0
   &&fixture.state==='blocked','AH_STATUS_FIXTURE_BINDING');
  if(fixture.requestSkipped!==true)check(fixture.captureHash===challenges[0].capture.rawPayloadHash
   &&fixture.receivedAt===challenges[0].receivedAt&&fixture.asianHandicapUrl===challenges[0].url,'AH_STATUS_ACTUAL_FAILURE_BINDING');
 }
 const failureObservedAt=challenges[0].receivedAt;
 return {version:value.version,contentHash:value.contentHash,failureObservedAt,blockedHost:'odds.500.com',
  rawFailureHash:challenges[0].capture.rawPayloadHash,active:at-clock(failureObservedAt)<21600n*1000000000n,
  sourceVerification:'unverified-access-status-only',eligibleAsianObservations:0};
}
async function collectEvidence({input,inputBytes,rawBytes,outputDir,history=null,ahStatus=null},dependencies={}){
 const now=dependencies.now||(()=>new Date().toISOString());
 const startedAt=now();
 check(reader.verifyOnlineRead(input,{date:input?.businessDate,rawResponse:rawBytes}),'ONLINE_INPUT_BINDING');
 check(Buffer.isBuffer(inputBytes)&&stableHash(JSON.parse(inputBytes))===stableHash(input),'INPUT_BYTES_BINDING');
 check(validKnowledgeWindow(input,startedAt),'ONLINE_INPUT_NOT_FRESH');
 check(input.matches.length<=ahAdapter.MAX_MATCHES,'MATCH_BOUND');
 const accessStatus=ahStatus?validateAhAccessStatus(ahStatus,{asOf:startedAt}):null;
 const historyEvidence=history?validateHistoryEvidence(history,{input,inputBytes,rawBytes,asOf:startedAt}):null;
 const initialInputHash=stableHash(input),bindings=dependencies.bindings||CAMPAIGN_BINDINGS;
 const xgBindings=dependencies.xgBindings||XG_CAMPAIGN_BINDINGS;
 const targetXgBindings=input.matches.map(match=>xgBindingsFor(match,xgBindings));
 const targetBindings=input.matches.map(match=>bindingFor(match,bindings));
 const providers=[...new Set(targetBindings.filter(Boolean).map(binding=>binding.provider))];
 const sources={};
 for(const provider of providers){
  const collector=provider==='KFA' ? (dependencies.collectKfa||teamAdapter.collectKfaTeamFacts)
   : provider==='FA' ? (dependencies.collectEngland||teamAdapter.collectEnglandTeamFacts) : null;
  if(typeof collector!=='function'){sources[provider]={status:'failed',reason:'official-collector-interface-unavailable'};continue;}
  try{
   const bundle=await collector({outputDir});
   const files=(dependencies.receiptFiles||receiptFiles)(bundle,outputDir);
   const verify=provider==='KFA' ? teamAdapter.verifyKfaTeamFacts : teamAdapter.verifyEnglandTeamFacts;
   check(typeof verify==='function'&&verify(files.receipt,provider==='KFA'?files.bytes:files.rawPages),'TEAM_RAW_REPLAY');
   sources[provider]={status:'captured',...files};
  }catch(error){sources[provider]={status:'failed',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'official-capture-failed'};}
 }
 let xgCapture={status:'not-requested',reason:'no-reviewed-current-event-xg-identity',items:[]};
 if(targetXgBindings.some(bindings=>bindings.length)){
  try{
   const bundle=await (dependencies.collectXg||xgAdapter.collectObservedXgPilot)({outputDir,
    targetProviderNames:[...new Set(targetXgBindings.flat().map(binding=>binding.providerTeamName))]});
   xgCapture={status:'captured',...(dependencies.xgReceiptFiles||xgReceiptFiles)(bundle,outputDir)};
  }catch(error){xgCapture={status:'failed',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'public-xg-capture-failed',items:[]};}
 }
 let ah;
 if(accessStatus?.active){
  ah={version:ahAdapter.VERSION,productionWrites:0,formalEligible:false,reusedAccessStatusOnly:true,capturesFetchedThisRun:0,
   failureObservedAt:accessStatus.failureObservedAt,accessStatusReceipt:accessStatus,asianHandicapObservations:[],captures:[],
   fixtures:input.matches.map(match=>({sourceMatchId:eventFromMatch(match).sourceMatchId,state:'blocked',
    reason:'known-source-security-challenge-backoff',requestSkipped:true,rows:[]})),
   summary:{targets:input.matches.length,requestedPages:0,eligibleV3Observations:0}};
 }else try{ah=await (dependencies.collectAh||ahAdapter.collectAsianHandicapPages)({input});
  ah={...ah,reusedAccessStatusOnly:false,capturesFetchedThisRun:ah.captures?.length||0};}
 catch(error){ah={version:ahAdapter.VERSION,productionWrites:0,formalEligible:false,fixtures:[],captures:[],asianHandicapObservations:[],
  summary:{targets:input.matches.length,eligibleV3Observations:0},status:'failed',reason:error.code||'AH_PUBLIC_COLLECTION_FAILED'};}
 const asOf=now();
 check(clock(asOf)!==null&&clock(asOf)>=clock(startedAt)&&validKnowledgeWindow(input,asOf),'FINISHED_CLOCK');
 const historyAdapter=historyEvidence?require('./prematchHistoryCollectionAdapter.cjs'):null;
 const modelRead=require('../src/services/prematchV3ModelRegistry.cjs').readPrematchV3RegistryFromOnlineInput(input,{asOf});
 const options={asOf,baseline:modelRead.baseline,parameters:modelRead.parameters,modelRegistry:{asOf:modelRead.asOf,
  status:modelRead.status,storage:modelRead.storage,blockers:modelRead.blockers,receipts:modelRead.receipts}};
 const events=input.matches.map((match,index)=>{
  const baseEvent=eventFromMatch(match),binding=targetBindings[index];
  const event={...baseEvent,homeTeamName:match.homeTeamName,awayTeamName:match.awayTeamName,
   ...(binding?{teamCategory:binding.teamCategory}: {})};
  let adapted={status:'unavailable',reason:'official-team-campaign-binding-missing',teamObservations:[]};
  if(binding){
   const source=sources[binding.provider];
   if(source.status==='captured'&&sourceWindow(source.receipt,startedAt,asOf)){
    const adapt=binding.provider==='KFA' ? teamAdapter.adaptKfaTeamFacts : teamAdapter.adaptEnglandTeamFacts;
    adapted=typeof adapt==='function' ? adapt({receipt:source.receipt,bytes:source.bytes,rawPages:source.rawPages,event,side:binding.side,asOf})
     : {status:'failed',reason:'official-adapter-interface-unavailable',teamObservations:[]};
   }else adapted={status:'failed',reason:source.reason||'source-actual-collection-window-invalid',teamObservations:[]};
  }
  const historyAdaptations=historyAdapter?Object.fromEntries(['home','away'].map(side=>[side,
   historyAdapter.adaptLedgerTeamHistory({history:historyEvidence,input,event:baseEvent,side,asOf})])):{};
  const xgAdaptations=Object.fromEntries(['home','away'].map(side=>{
   const binding=targetXgBindings[index].find(binding=>binding.side===side),items=[];
   const rejected=[];
   if(binding)for(const item of xgCapture.items){
    if(!sourceWindow(item.receipt,startedAt,asOf)||!xgAdapter.verifyObservedXgReceipt(item.receipt,item.bytes)){
     rejected.push({sourceReceiptHash:item.receipt.contentHash||null,reason:'xg-raw-replay-or-current-run-clock-invalid'});continue;
    }
    if(!['home','away'].some(providerSide=>item.receipt.facts[providerSide]?.providerTeamId===binding.providerTeamId
     &&item.receipt.facts[providerSide]?.nameAsDisplayed===binding.providerTeamName))continue;
    items.push({...item,reviewedProviderMapping:reviewedXgMapping(binding,item.receipt,asOf)});
   }
   const adapted=binding?xgAdapter.combineObservedXgReceipts({items,event,side,asOf})
    : {status:'unavailable',reason:'reviewed-current-event-provider-identity-missing',sampleCount:0,teamObservations:[],formalEligible:false};
   return [side,{...adapted,rejected:[...(adapted.rejected||[]),...rejected],
    providerMappings:items.map(item=>item.reviewedProviderMapping),durationAdmission:'provider-regulation-scope-reference;not-formal-result-admission'}];
  }));
  const teamObservations=[...(adapted.status==='captured'?adapted.teamObservations:[]),
   ...Object.values(historyAdaptations).flatMap(value=>value.status==='captured'?value.teamObservations:[]),
   ...Object.values(xgAdaptations).flatMap(value=>['captured','partial'].includes(value.status)?value.teamObservations:[])];
  check(Array.isArray(teamObservations)&&teamObservations.length<=300,'TEAM_OBSERVATION_BOUND');
  // AH captures are diagnostic facts until the collector establishes provider
  // time, signed-home convention, format, and team mapping. Never promote an
  // externally supplied array merely because it has hashes.
  const sourceContract={version:'prematch-v3-source-input-v1',teamObservations,asianHandicapObservations:[],entityMapping:null,
   sourceAdmission:'unverified-private-research-only',formalEligible:false};
  const derivedMatch={...match,externalSignals:{...(match.externalSignals||{}),prematchV3:sourceContract}};
  const assessment=buildPrematchV3Assessment(derivedMatch,options);
  const historicalFacts=(historyEvidence?.rows||[]).filter(row=>row.teamId===event.homeTeamId||row.teamId===event.awayTeamId);
  const knownFamily=(side,family)=>Object.entries(assessment.teamSnapshot.features).some(([key,value])=>
   key.startsWith(`${side}.${family}.`)&&typeof value==='number');
  const missing=Object.fromEntries(['home','away'].map(side=>[side,['roster','injuries','fatigue','history','xg']
   .filter(family=>!knownFamily(side,family))]));
  const ahFacts=ah.fixtures.find(fixture=>fixture.sourceMatchId===event.sourceMatchId)||null;
  return {sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,homeTeamName:match.homeTeamName,awayTeamName:match.awayTeamName,
   event,binding,officialTeamCapture:adapted,historyAdaptations,xgAdaptations,sourceContract,referenceHistory:{rows:historicalFacts.length,
    modelEligible:false,reason:historicalFacts.length?'stored-reference-not-provider-or-90-minute-admitted':'no-reference-history-captured'},
   asianCapture:ahFacts?{state:ahFacts.state,reason:ahFacts.reason,rawRows:ahFacts.rows.length,requestSkipped:ahFacts.requestSkipped===true}
    : {state:ah.status||'unavailable',reason:ah.reason||'no-event-capture',rawRows:0},
   missing,assessment,formalEligible:false,productionEligible:false};
 });
 check(stableHash(input)===initialInputHash,'ORIGINAL_INPUT_CHANGED');
 const sourceReceipts=Object.fromEntries(Object.entries(sources).map(([provider,value])=>[provider,value.status==='captured'
  ? {status:'captured',receipt:value.receipt,receiptFile:path.basename(value.receiptPath),receiptFileHash:value.receiptFileHash}
  : value]));
 const body={version:VERSION,startedAt,calculatedAt:asOf,collectionMode:'live-public-official-HTTPS-and-recorded-pinned-PG-input',
  inputBinding:{inputSha256:hash(inputBytes),remoteResponseSha256:hash(rawBytes),observedAt:input.observedAt,
   generation:input.generation,originalInputChanged:false},sourceReceipts,asianHandicapCapture:ah,
  observedXgCapture:{status:xgCapture.status,reason:xgCapture.reason||null,report:xgCapture.report||null,
   reportFile:xgCapture.reportPath?path.basename(xgCapture.reportPath):null,reportFileHash:xgCapture.reportFileHash||null,
   sourceAdmission:'unverified-post-match-observed-measurements;no-formal-90-minute-result-admission',
   eligibleSourceMeasurements:xgCapture.items.filter(item=>sourceWindow(item.receipt,startedAt,asOf)
    &&xgAdapter.verifyObservedXgReceipt(item.receipt,item.bytes)&&item.receipt.facts.status==='observed').length},
  history:historyEvidence,events,
  summary:{matches:events.length,officialProvidersCaptured:Object.values(sources).filter(v=>v.status==='captured').length,
   eventsWithOfficialFacts:events.filter(e=>e.officialTeamCapture.status==='captured').length,
   teamObservations:events.reduce((n,e)=>n+e.sourceContract.teamObservations.length,0),asianObservations:0,
   referenceHistoryRows:historyEvidence?.rows.length||0,
   eventsBothTeamsWithHistory:events.filter(event=>['home','away'].every(side=>
    typeof event.assessment.teamSnapshot.features[`${side}.history.sampleCount`]==='number'
    &&event.assessment.teamSnapshot.features[`${side}.history.sampleCount`]>0)).length,
   eventSidesWithHistory:events.reduce((count,event)=>count+['home','away'].filter(side=>
    typeof event.assessment.teamSnapshot.features[`${side}.history.sampleCount`]==='number'
    &&event.assessment.teamSnapshot.features[`${side}.history.sampleCount`]>0).length,0),
   eventsBothTeamsWithObservedXg:events.filter(event=>['home','away'].every(side=>
    typeof event.assessment.teamSnapshot.features[`${side}.xg.sampleCount`]==='number'
    &&event.assessment.teamSnapshot.features[`${side}.xg.sampleCount`]>0)).length,
   eventSidesWithObservedXg:events.reduce((count,event)=>count+['home','away'].filter(side=>
    typeof event.assessment.teamSnapshot.features[`${side}.xg.sampleCount`]==='number'
    &&event.assessment.teamSnapshot.features[`${side}.xg.sampleCount`]>0).length,0),
   knownFeatures:events.reduce((count,event)=>count+Object.values(event.assessment.teamSnapshot.features).filter(value=>typeof value==='number').length,0),
   formalRecommendations:0},
  invariants:{productionWrites:0,sourceAdmission:false,originalInputChanged:false,frozenDecisionsChanged:false,
   forcedCombos:0,trainedParameters:false,accuracyMeasured:false},formalEligible:false,productionEligible:false};
 return {...body,contentHash:stableHash(body)};
}
function privateOutputPath(output){
 const repo=path.resolve(__dirname,'..'),destination=path.resolve(output),relative=path.relative(repo,destination);
 check(/^outputs[\\/]prematch-v3-[^\\/]+[\\/].+\.json$/i.test(relative)&&!relative.split(/[\\/]/).includes('..'),'PRIVATE_OUTPUT_REQUIRED');
 check(!fs.existsSync(destination)&&fs.statSync(path.dirname(destination)).isDirectory(),'NEW_OUTPUT_REQUIRED');return destination;
}
function readBoundFile(input){
 const inputPath=path.resolve(input);check(fs.statSync(inputPath).size<=reader.MAX_BYTES*2,'INPUT_BOUND');
 const inputBytes=fs.readFileSync(inputPath),value=JSON.parse(inputBytes);
 const relative=value.transport?.remoteResponseFile;
 check(typeof relative==='string'&&path.basename(relative)===relative,'RAW_PATH');
 const rawPath=path.join(path.dirname(inputPath),relative);check(rawPath!==inputPath&&fs.statSync(rawPath).size<=reader.MAX_BYTES,'RAW_BOUND');
 return {inputPath,input:value,inputBytes,rawPath,rawBytes:fs.readFileSync(rawPath)};
}
async function run({input,output,history=null,ahStatus=null}){
 check(require.main===module,'STANDALONE_REQUIRED');check(Number(process.versions.node.split('.')[0])===22,'NODE22_REQUIRED');
 const destination=privateOutputPath(output),bound=readBoundFile(input),outputDir=path.dirname(destination);
 let historyBound=null;
 if(history){const historyPath=path.resolve(history),value=JSON.parse(fs.readFileSync(historyPath));
  const relative=value.transport?.remoteResponseFile;check(typeof relative==='string'&&path.basename(relative)===relative,'HISTORY_RAW_PATH');
  const rawPath=path.join(path.dirname(historyPath),relative);check(fs.statSync(rawPath).size<=6*1024*1024,'HISTORY_RAW_BOUND');
  historyBound={value,raw:fs.readFileSync(rawPath)};}
 let accessStatus=null,statusBytes=null,statusPath=null;
 if(ahStatus){statusPath=path.resolve(ahStatus);check(fs.statSync(statusPath).size<=8*1024*1024,'AH_STATUS_FILE_BOUND');
  statusBytes=fs.readFileSync(statusPath);accessStatus=JSON.parse(statusBytes);}
 const implementationFiles=[...new Set([...require('./runPrematchV3Shadow.cjs').IMPLEMENTATION_FILES,
  'scripts/collectPrematchV3Evidence.cjs','scripts/prematchTeamCollectionAdapter.cjs',
  'scripts/prematchXgCollectionAdapter.cjs',
  'scripts/prematchAsianHandicapCollectionAdapter.cjs','scripts/readPrematchV3OnlineInputs.cjs',
  'scripts/readPrematchV3TeamHistory.cjs','scripts/prematchHistoryCollectionAdapter.cjs',
  'src/services/prematchV3Assessment.cjs','src/services/prematchTeamEvidenceV3.cjs',
  'src/services/sportteryDeadlineClock.cjs'])];
 const repo=path.resolve(__dirname,'..');
 const before=Object.fromEntries(implementationFiles.map(file=>[file,hash(fs.readFileSync(path.join(repo,file)))]));
 const report=await collectEvidence({...bound,outputDir,history:historyBound,ahStatus:accessStatus});
 if(statusPath)check(hash(fs.readFileSync(statusPath))===hash(statusBytes),'AH_STATUS_FILE_CHANGED');
 check(hash(fs.readFileSync(bound.inputPath))===hash(bound.inputBytes)&&hash(fs.readFileSync(bound.rawPath))===hash(bound.rawBytes),'INPUT_FILES_CHANGED');
 check(stableHash(before)===stableHash(Object.fromEntries(implementationFiles.map(file=>[file,hash(fs.readFileSync(path.join(repo,file)))]))),'IMPLEMENTATION_CHANGED');
 const body={...report,contentHash:undefined,accessStatusReadBinding:statusBytes?{file:path.basename(statusPath),
  fileSha256:hash(statusBytes),purpose:'access-block-backoff-only; no quote or provider clock renewed'}:null,
  implementation:{nodeVersion:process.version,
  gitHead:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:10000}).trim(),files:before}};
 const saved={...body,contentHash:stableHash(body)},bytes=JSON.stringify(saved,null,2)+'\n';
 check(Buffer.byteLength(bytes)<=MAX_OUTPUT_BYTES,'OUTPUT_BOUND');fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
 return {output:destination,calculatedAt:saved.calculatedAt,contentHash:saved.contentHash,summary:saved.summary,productionWrites:0,formalEligible:false};
}
module.exports={VERSION,FRESH_NS,CAMPAIGN_BINDINGS,parseArgs,bindingFor,validKnowledgeWindow,sourceWindow,receiptFiles,
 XG_CAMPAIGN_BINDINGS,xgBindingsFor,xgReceiptFiles,reviewedXgMapping,validateHistoryEvidence,validateAhAccessStatus,
 collectEvidence,privateOutputPath,readBoundFile,run};
if(require.main===module)(async()=>console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))))))().catch(error=>{
 console.error(/^V3_COLLECT_[A-Z0-9_]+$/.test(error.message)?error.message:'V3_COLLECT_FAILED');process.exitCode=1;});
