'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {createCollectorKeyPair,buildCollectorCommitment,signCollectorCommitment,sha256CollectorJson}=require('../src/services/collectorAttestation.cjs');
const {SPORTTERY_CALCULATOR_URL,SPORTTERY_CURRENT_URL}=require('../scripts/sportteryEndpointContract.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {collectResults,validResultEvent,settleDecision,settleHandicapDecision}=require('../scripts/recommendationPlatform/results.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {bindPublicReferenceDecision,pendingPublicReferenceEvidence}=require('../src/services/publicReferenceDecision.cjs');
const {VERSION,TRACK,createStandaloneHandicapReference:create,validStandaloneHandicapReference:valid,
  projectStandaloneHandicapReference:project,settleStandaloneHandicapReference:settle,compareMarketEvents:compare}=require('../src/services/standaloneHandicapReference.cjs');

// Synthetic arithmetic and synthetic Ed25519 collector fixtures only. Neither
// these test keys nor the test result adapter is admitted to production.
const NOW=Date.parse('2026-10-06T12:00:00Z'),stamp=n=>new Date(n).toISOString();
const pair=createCollectorKeyPair({keyId:'independent-hhad-test',independenceDomain:'synthetic-adapter'});
function match({p={home:40,draw:30,away:30},sparse=false,...patch}={}){
  return withVerifiedInputEvidence({id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-10-06',status:'SCHEDULED',
    homeTeamId:'h-1',awayTeamId:'a-1',homeTeamName:'Synthetic home',awayTeamName:'Synthetic away',isOnSale:true,
    kickoffTime:'2026-10-07T02:45:00+08:00',eventVersion:'2026-10-06T18:45:00Z',
    probabilityModel:{version:'synthetic-v1',generatedAt:stamp(NOW-20*60000),oneXTwo:{final:p},
      calculationTrace:{poisson:{lambdas:{home:1.2,away:1}}}},...patch},sparse?{eloHome:1,eloAway:2}:{});
}
function snapshot({at=NOW,mutate=()=>{},line=-1,odds=[5,5,1.8],marketExtractions=null,signedUrl=null,signedPage=null,providerAt=at-2000,success=true,cycleFor=()=> 'synthetic-hhad-cycle'}={}){
  return {endpoints:['calculator','current'].map(method=>{
    const row={matchId:'1',matchDate:'2026-10-07',matchTime:'02:45:00',businessDate:'2026-10-06',
      homeTeamAllName:'Synthetic home',awayTeamAllName:'Synthetic away',matchStatus:'Selling',sellStatus:1,
      oddsList:[{poolCode:'HHAD',goalLine:String(line),h:odds[0],d:odds[1],a:odds[2],updateDate:'2026-10-06',updateTime:'19:59:00'}],
      poolList:[{poolCode:'HHAD',poolStatus:'Selling',bettingAllup:1}]};
    mutate(row,method);
    const payload={success,value:{matchInfoList:[{subMatchList:[row]}]}},url=method==='calculator'?SPORTTERY_CALCULATOR_URL:SPORTTERY_CURRENT_URL;
    const entry={method,page:null,ok:true,url,payload,requestedAt:stamp(at-1000),receivedAt:stamp(at-500),providerObservedAt:stamp(providerAt),
      sourceCycleId:cycleFor(method),sourceRequest:{url:signedUrl||url,method:'GET',page:signedPage,role:method},httpStatus:200,contentType:'application/json',
      rawSha256:'b'.repeat(64),rawBytes:500,headersSha256:'a'.repeat(64),canonicalPayloadSha256:sha256CollectorJson(payload)};
    const commitment=buildCollectorCommitment({endpoint:entry.sourceRequest,collectorCycleId:entry.sourceCycleId,
      requestedAt:entry.requestedAt,receivedAt:entry.receivedAt,providerObservedAt:entry.providerObservedAt,
      response:{httpStatus:entry.httpStatus,contentType:entry.contentType,rawSha256:entry.rawSha256,rawBytes:entry.rawBytes,headersSha256:entry.headersSha256},
      payload,canonicalPayloadSha256:entry.canonicalPayloadSha256,marketExtractions});
    entry.collectorAttestation=signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});return entry;
  })};
}
const options=patch=>({now:NOW,publication:{generationId:'synthetic-generation',manifestHash:'a'.repeat(64),committedAt:stamp(NOW-10*60000)},snapshot:snapshot(),trustRegistry:pair.registry,...patch});
function record(m=match(),patch){const result=create(m,options(patch));assert.ok(result.record,result.reason);return result.record;}
function event(record,{scoreHome=1,scoreAway=1,state='FINAL',revision=1,...patch}={}){
  const row={...record,status:state==='VOID'?'VOID':'FINISHED',scoreHome,scoreAway,resultRevision:revision,
    resultObservedAt:'2026-10-07T04:00:00Z',resultSource:'synthetic-result-adapter',...patch};
  const next=collectResults([row],new Map(),{isFinal:r=>r.status==='FINISHED',isVoid:r=>r.status==='VOID'},Date.parse('2026-10-07T04:01:00Z')).updates[0];
  assert.ok(validResultEvent(next));return next;
}

test('HAD absent, signed HHAD present creates a distinct immutable reference, never a fake HAD record',()=>{
  const m=match(),before=hash(m),r=record(m);
  assert.equal(r.version,VERSION);assert.equal(r.market,'HHAD');assert.equal(r.statisticsTrack,TRACK);assert.equal(r.tipCode,'2');
  assert.equal(r.probabilities['2'],.6);assert.equal(r.odds,1.8);assert.equal(r.quoteSource,'sporttery:HHAD');
  assert.equal(r.formalEligible,false);assert.equal(r.primary,null);assert.equal(r.companion,null);assert.equal(r.publicationStatus,'FROZEN_REFERENCE');
  assert.equal(r.researchAssessment.researchValueEligible,true);assert.equal(r.researchAssessment.calibratedProbability,null);
  assert.equal(r.inputSnapshot.odds,undefined);assert.deepEqual(r.inputSnapshot.probabilityModel.oneXTwo.final,m.probabilityModel.oneXTwo.final);
  assert.equal(hash(m),before);assert.ok(Object.isFrozen(r.analysis));assert.ok(valid(r,{trustRegistry:pair.registry}));
  assert.equal(validDecision(r),false);
});
test('missing HHAD never falls back to HAD price, legacy HHAD fields or caller eligibility claims',()=>{
  const m=match({odds:{odds1:1.3,oddsX:5,odds2:9},oddsSource:'sporttery:had',handicapOdds:{odds1:5,oddsX:5,odds2:1.8},handicapLine:-1});
  for(const s of [{endpoints:[]},snapshot({mutate:r=>r.oddsList[0].poolCode='HAD'}),snapshot({mutate:r=>r.oddsList=[]})]){
    const result=create(m,options({snapshot:s,eligible:true,formalEligible:true}));assert.equal(result.record,null);assert.equal(result.reason,'signed-independent-hhad-quote-unavailable');
  }
});
test('payload, signature, key, role, URL, missing payload, duplicate endpoint and extraction omission reject',()=>{
  const edits=[s=>s.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].a=9,
    s=>s.endpoints[0].collectorAttestation.signature='bad',s=>s.endpoints[0].collectorAttestation.keyId='unknown',
    s=>s.endpoints[0].url='https://example.org/odds',s=>s.endpoints[0].sourceRequest.role='current',
    s=>delete s.endpoints[0].payload,s=>s.endpoints.push(structuredClone(s.endpoints[0])),s=>s.endpoints.pop()];
  for(const edit of edits){const s=snapshot();edit(s);assert.equal(create(match(),options({snapshot:s})).record,null);}
  assert.equal(create(match(),options({snapshot:snapshot({marketExtractions:[]})})).record,null);
  assert.equal(create(match(),options({trustRegistry:{version:pair.registry.version,keys:[]}})).record,null);
  // A valid collector signature for another URL cannot be relabelled by an
  // unsigned official entry.url. Trust is bound to the signed request itself.
  for(const s of [snapshot({signedUrl:'https://untrusted.example.test/calculator'}),snapshot({signedPage:1})])
    assert.equal(create(match(),options({snapshot:s})).record,null);
  for(const s of [snapshot({success:false}),snapshot({success:null}),snapshot({cycleFor:m=>m}),
    snapshot({cycleFor:()=>null}),snapshot({cycleFor:()=>''}),snapshot({cycleFor:()=>'   '}),
    snapshot({mutate:r=>r.unrelatedDiagnostic='broken\uFFFDname'})])assert.equal(create(match(),options({snapshot:s})).record,null);
});
test('both signed payloads bind source id, exact kickoff, business day, names and sale state',()=>{
  const edits=[r=>r.matchId='2',r=>r.matchTime='02:46:00',r=>r.businessDate='2026-10-07',r=>r.homeTeamAllName='Other',
    r=>r.awayTeamAllName='Other',r=>r.matchStatus='Closed',r=>r.sellStatus=0];
  for(const method of ['calculator','current'])for(const edit of edits){
    assert.equal(create(match(),options({snapshot:snapshot({mutate:(r,m)=>{if(m===method)edit(r);}})})).record,null);
  }
  const s=snapshot();s.endpoints[0].payload.value.matchInfoList[0].subMatchList.push(structuredClone(s.endpoints[0].payload.value.matchInfoList[0].subMatchList[0]));
  assert.equal(create(match(),options({snapshot:s})).record,null);
});
test('HHAD integer line, each same-market price and official pool sale attributes are mandatory',()=>{
  for(const line of [0,.5,13,-13])assert.equal(create(match(),options({snapshot:snapshot({line})})).record,null);
  for(const edit of [r=>r.oddsList[0].goalLine='',r=>r.oddsList[0].h=1,r=>r.oddsList[0].d=null,r=>r.oddsList[0].a=1.23456,
    r=>r.oddsList.push(structuredClone(r.oddsList[0])),r=>r.poolList[0].poolStatus='Closed',r=>r.poolList[0].bettingAllup=0]){
    assert.equal(create(match(),options({snapshot:snapshot({mutate:edit})})).record,null);
  }
  for(const edit of [r=>r.poolList[0].poolStatus='Closed',r=>r.poolList[0].bettingAllup=0,r=>r.poolList.push(structuredClone(r.poolList[0]))]){
    assert.equal(create(match(),options({snapshot:snapshot({mutate:(r,m)=>{if(m==='current')edit(r);}})})).record,null);
  }
  assert.ok(create(match(),options({snapshot:snapshot({mutate:(r,m)=>{if(m==='current'){r.poolList=[];r.oddsList=[];}}})})).record);
});
test('fresh acquisition clocks, provider clocks and actual pool update clocks fail closed',()=>{
  for(const at of [NOW-16*60000,NOW+2000])assert.equal(create(match(),options({snapshot:snapshot({at})})).record,null);
  assert.equal(create(match(),options({snapshot:snapshot({providerAt:NOW+1})})).record,null);
  for(const edit of [r=>r.oddsList[0].updateTime='20:00:01',r=>r.oddsList[0].updateTime='invalid',r=>delete r.oddsList[0].updateDate]){
    assert.equal(create(match(),options({snapshot:snapshot({mutate:edit})})).record,null);
  }
  const s=snapshot();s.endpoints[0].receivedAt=stamp(NOW);s.endpoints[0].capturedAt=stamp(NOW);
  assert.equal(create(match(),options({snapshot:s})).record,null);
});
test('business cutoff, explicit cutoff fields, kickoff, locked and closed events reject before publication',()=>{
  for(const patch of [{status:'LIVE'},{isOnSale:false},{saleStatus:'SUSPENDED'},{resultDisposition:'VOID'},
    {predictionMeta:{lockedAt:stamp(NOW)}},{predictionMeta:{lockedReason:'frozen'}},
    {buyEndTime:stamp(NOW)},{cutoffAt:stamp(NOW)},{cutoffTime:stamp(NOW)},{predictionMeta:{cutoffTime:stamp(NOW)}},
    {cutoffAt:'invalid'},{eventVersion:stamp(NOW)},{businessDate:'2026-10-05'}])assert.equal(create(match(patch),options()).record,null);
  assert.equal(create(match(),options({now:Date.parse('2026-10-06T14:00:00Z')})).reason,'after-cutoff');
});
test('publication and model time/identity evidence cannot be refreshed by new metadata',()=>{
  for(const publication of [{generationId:'g',manifestHash:'bad',committedAt:stamp(NOW)},
    {generationId:'g',manifestHash:'a'.repeat(64),committedAt:stamp(NOW+1)},
    {generationId:'g',manifestHash:'a'.repeat(64),committedAt:stamp(NOW-30*60000)}])assert.equal(create(match(),options({publication})).record,null);
  const m=match();m.probabilityModel.oneXTwo.final.home=99;assert.equal(create(m,options()).record,null);
  for(const at of [NOW+1,NOW-13*3600000]){
    const m=match({probabilityModel:{version:'synthetic-v1',generatedAt:stamp(at),oneXTwo:{final:{home:40,draw:30,away:30}},calculationTrace:{poisson:{lambdas:{home:1.2,away:1}}}}});
    assert.equal(create(m,options()).record,null);
  }
  assert.equal(create(match(),options({now:NaN})).reason,'clock-invalid');
});
test('sparse sample, negative/zero EV and huge unvalidated market gap stay observations',()=>{
  const sparse=record(match({sparse:true}));assert.ok(sparse.researchAssessment.reasons.includes('team-samples-insufficient'));
  const negative=record(match(),{snapshot:snapshot({odds:[3,4,1.5]})});assert.ok(negative.researchAssessment.reasons.includes('nonpositive-model-expected-value'));
  const zero=record(match({p:{home:50,draw:25,away:25}}),{snapshot:snapshot({odds:[5,5,2]})});
  assert.equal(zero.researchAssessment.modelExpectedValue,0);assert.ok(zero.researchAssessment.reasons.includes('nonpositive-model-expected-value'));
  const gap=record(match(),{snapshot:snapshot({odds:[2,3,5]})});assert.ok(gap.researchAssessment.reasons.includes('market-disagreement-needs-validation'));
  for(const r of [sparse,negative,zero,gap]){assert.equal(r.researchAssessment.researchValueEligible,false);assert.equal(r.formalEligible,false);assert.equal(r.primary,null);}
});
test('projection exposes only separate uncalibrated reference and no raw source proof or registry',()=>{
  const r=record(),p=project(r,{trustRegistry:pair.registry});assert.equal(p.modelTendency.market,'HHAD');assert.equal(p.modelTendency.odds,r.odds);
  assert.equal(p.referenceOnly,true);assert.equal(p.formalEligible,false);assert.equal(p.sourceEvidence,undefined);assert.equal(p.trustRegistryHash,undefined);
  assert.equal(p.inputSnapshot,undefined);assert.equal(p.researchAssessment.formalCalibrationAdapter,'not-integrated');
  assert.equal(project({...r,formalEligible:true},{trustRegistry:pair.registry}),null);
});
test('full record replay rejects self-rehashed price, probability, event, settlement track or proof tampering',()=>{
  const original=record();
  for(const edit of [r=>r.odds=9,r=>r.modelProbability=.99,r=>r.probabilities['2']=.99,r=>r.eventVersion=stamp(NOW),
    r=>r.handicapLine=1,r=>r.statisticsTrack='formal',r=>r.sourceEvidence.calculator.payload.value.matchInfoList=[],r=>r.researchAssessment.researchValueEligible=false]){
    const r=structuredClone(original);edit(r);delete r.recordHash;r.recordHash=hash(r);assert.equal(valid(r,{trustRegistry:pair.registry}),false);
  }
});
test('market interval logic evaluates actual integer score sets, including compatible home win and -2 loss',()=>{
  const e=(market,tipCode,handicapLine)=>({market,tipCode,handicapLine});
  for(const [a,b,conflict] of [
    [e('HAD','1',0),e('HHAD','2',-1),true],[e('HAD','X',0),e('HHAD','2',-1),false],
    [e('HAD','1',0),e('HHAD','2',-2),false],[e('HAD','2',0),e('HHAD','1',1),true],
    [e('HAD','X',0),e('HHAD','1',1),false],[e('HAD','2',0),e('HHAD','1',2),false],
    [e('HHAD','X',-2),e('HHAD','1',-1),false],[e('HHAD','X',-2),e('HHAD','2',-2),true]])assert.equal(compare(a,b).structuralConflict,conflict);
  assert.deepEqual(compare(e('HAD','1',0),e('HHAD','2',-2)).intersection,{minimum:1,maximum:1});
  for(const invalid of [e('HHAD','1',0),e('HHAD','1',.5),e('OTHER','1',0),e('HAD','?',0)])assert.equal(compare(invalid,e('HAD','1',0)).structuralConflict,null);
});
test('exhaustive integer range intersection agrees with independent 90-minute arithmetic',()=>{
  const events=[...['1','X','2'].map(tipCode=>({market:'HAD',tipCode,handicapLine:0})),
    ...[-2,-1,1,2].flatMap(handicapLine=>['1','X','2'].map(tipCode=>({market:'HHAD',tipCode,handicapLine})))];
  const applies=(e,d)=>{const v=d+e.handicapLine;return (v>0?'1':v<0?'2':'X')===e.tipCode;};
  for(const a of events)for(const b of events){const overlap=Array.from({length:21},(_,i)=>i-10).some(d=>applies(a,d)&&applies(b,d));assert.equal(compare(a,b).structuralConflict,!overlap);}
});
test('content-verified reference blocks only a real market event conflict, not unrelated tip-code differences',()=>{
  function context(tipCode){const m=match();m.predictions=[{marketType:'BEST',recommendationAction:'reference',oddsPoolCode:'HAD',tipCode,odds:2}];
    m.predictionMeta={decisionGeneratedAt:stamp(NOW-60000),decisionId:'synthetic-original',modelVersion:m.probabilityModel.version,
      policyVersion:'synthetic-original-v1',featureSnapshot:{sourceMatchId:m.sourceMatchId,kickoffTime:m.kickoffTime,capturedAt:stamp(NOW-60001)}};
    const target=bindPublicReferenceDecision(m,null,stamp(NOW-50000));return {referenceMatch:target,referenceEvidence:pendingPublicReferenceEvidence(target)};}
  const conflict=record(match(),context('1'));assert.equal(conflict.researchAssessment.referenceConflict.blocking,true);
  assert.equal(conflict.researchAssessment.referenceConflict.sourceVerified,false);assert.ok(conflict.researchAssessment.reasons.includes('verified-reference-event-conflict'));
  const compatible=record(match(),context('X'));assert.equal(compatible.researchAssessment.referenceConflict.structuralConflict,false);
  const raw=context('1');delete raw.referenceEvidence;assert.equal(record(match(),raw).researchAssessment.referenceConflict.blocking,false);
});
test('independent HHAD settlement uses its own +/- integer line and never an HAD companion',()=>{
  for(const line of [-2,-1,1,2]){const r=record(match(),{snapshot:snapshot({line})});
    for(const [h,a] of [[0,0],[1,0],[2,0],[3,0],[0,1],[0,2]]){const actual=h+line>a?'1':h+line<a?'2':'X',s=settle(r,event(r,{scoreHome:h,scoreAway:a}),{trustRegistry:pair.registry});
      assert.equal(s.actual,actual);assert.equal(s.state,actual===r.tipCode?'WON':'LOST');assert.equal(s.statisticsTrack,TRACK);assert.equal(s.formalEligible,false);}
  }
});
test('unknown, VOID, revision conflict, invalid or wrong-identity results never count as a loss or 0-0',()=>{
  const r=record();assert.equal(settle(r,null,{trustRegistry:pair.registry}).state,'PENDING');
  assert.equal(settle(r,event(r,{state:'VOID'}),{trustRegistry:pair.registry}).state,'VOID');
  for(const patch of [{homeTeamId:null},{homeTeamId:'other'},{sourceMatchId:'2'},{eventVersion:'2026-10-06T18:46:00Z'}]){
    assert.equal(settle(r,event(r,patch),{trustRegistry:pair.registry}).state,'DISPUTED');
  }
  const bad=event(r);bad.scoreHome=99;assert.equal(settle(r,bad,{trustRegistry:pair.registry}).state,'DISPUTED');
  const conflicts=collectResults([1,2].map(scoreHome=>({...r,status:'FINISHED',scoreHome,scoreAway:0,resultRevision:1})),new Map(),
    {isFinal:()=>true,isVoid:()=>false},Date.parse('2026-10-07T04:01:00Z')).updates[0];
  assert.ok(validResultEvent(conflicts));assert.equal(settle(r,conflicts,{trustRegistry:pair.registry}).state,'DISPUTED');
  assert.throws(()=>settle({...r,formalEligible:true},event(r),{trustRegistry:pair.registry}),/Invalid independent/);
});
test('legacy HAD and HHAD frozen records, validators and settlement remain byte-for-byte unchanged',()=>{
  const m=match({odds:{odds1:2.2,oddsX:3.3,odds2:3.4},oddsSource:'sporttery:had',oddsReceivedAt:stamp(NOW-500),
    handicapLine:-1,handicapOdds:{odds1:5,oddsX:5,odds2:1.8},handicapOddsSource:'sporttery:HHAD',handicapOddsReceivedAt:stamp(NOW-500)});
  for(const primaryPolicy of [undefined,'independent-market-primary-v1']){
    const d=makeDecision(m,{now:NOW,publication:options().publication,...(primaryPolicy?{primaryPolicy}:{})}).decision;
    assert.ok(validDecision(d));const bytes=JSON.stringify(d),e=event(d),had=settleDecision(d,e),hh=settleHandicapDecision(d,e);
    const r=record(m);settle(r,e,{trustRegistry:pair.registry});project(r,{trustRegistry:pair.registry});
    assert.equal(JSON.stringify(d),bytes);assert.ok(validDecision(d));assert.deepEqual(settleDecision(d,e),had);assert.deepEqual(settleHandicapDecision(d,e),hh);
  }
});
