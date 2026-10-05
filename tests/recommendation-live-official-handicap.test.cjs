'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCollectorKeyPair,buildCollectorCommitment,signCollectorCommitment,verifyCollectorAttestation,sha256CollectorJson}=require('../src/services/collectorAttestation.cjs');
const {SPORTTERY_CALCULATOR_URL,SPORTTERY_CURRENT_URL}=require('../scripts/sportteryEndpointContract.cjs');
const {joinOfficialHandicap}=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const pair=createCollectorKeyPair({keyId:'fresh-handicap-test',independenceDomain:'test-handicap-runtime'}),stamp=n=>new Date(n).toISOString();
function source(){return match(1,NOW,{handicapLine:-1,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.1},handicapOddsSource:'sporttery:HHAD',handicapOddsReceivedAt:stamp(NOW-20*60000),
 probabilityModel:{version:'test',generatedAt:stamp(NOW-5*60000),oneXTwo:{final:{home:45.5,draw:28,away:26.5}},calculationTrace:{poisson:{lambdas:{home:1.6,away:1.3}}}}});}
function raw(){const m=source();return {matchId:'1',matchDate:'2026-09-17',matchTime:'23:00:00',businessDate:m.businessDate,homeTeamAllName:m.homeTeamName,awayTeamAllName:m.awayTeamName,
 matchStatus:'Selling',sellStatus:1,oddsList:[{poolCode:'HHAD',h:2.4,d:3.3,a:2.1,goalLine:'-1'}],poolList:[{poolCode:'HHAD',poolStatus:'Selling',bettingAllup:1}]};}
function snapshot(now=NOW,mutate=()=>{}){
 return {endpoints:['calculator','current'].map(method=>{
  const r=raw();mutate(r,method);const payload={success:true,value:{matchInfoList:[{subMatchList:[r]}]}},url=method==='calculator'?SPORTTERY_CALCULATOR_URL:SPORTTERY_CURRENT_URL;
  const e={method,page:null,ok:true,url,payload,requestedAt:stamp(now-1000),receivedAt:stamp(now),sourceCycleId:'fresh-official-test',sourceRequest:{method:'GET',url,page:null,role:method},
   httpStatus:200,contentType:'application/json',rawSha256:'b'.repeat(64),rawBytes:500,headersSha256:'a'.repeat(64),canonicalPayloadSha256:sha256CollectorJson(payload)};
  const commitment=buildCollectorCommitment({endpoint:{url,method:'GET',page:null,role:method},collectorCycleId:e.sourceCycleId,requestedAt:e.requestedAt,receivedAt:e.receivedAt,
   response:{httpStatus:e.httpStatus,contentType:e.contentType,rawSha256:e.rawSha256,rawBytes:e.rawBytes,headersSha256:e.headersSha256},payload,canonicalPayloadSha256:sha256CollectorJson(payload)});
  e.collectorAttestation=signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});return e;
 })};
}
const join=(rows,s= snapshot(),now=NOW)=>joinOfficialHandicap(rows,s,{now,trustRegistry:pair.registry});
test('fresh signed official HHAD restores coherent anchor without changing model or frozen parent',()=>{
 const s=snapshot();for(const e of s.endpoints){const audit=verifyCollectorAttestation(e.collectorAttestation,{trustRegistry:pair.registry,payload:e.payload,expected:require('../server/relayCollectorEvidence.cjs').expectedCollectorCommitment(e)});assert(audit.eligible,JSON.stringify(audit.blockers));}
 const m=source(),row={...m,prospectiveForecastInput:structuredClone(m)},before=structuredClone(row),next=join([row])[0];
 assert.deepEqual(row,before);assert.deepEqual(next.probabilityModel,row.probabilityModel);
 assert.equal(next.prospectiveForecastInput.probabilityModel.generatedAt,m.probabilityModel.generatedAt);
 assert.equal(next.prospectiveForecastInput.handicapOddsReceivedAt,stamp(NOW));
 const d=makeDecision(next,{now:NOW,publication:publication(NOW)}).decision;
 assert(d&&validDecision(d));assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'X');assert.equal(d.coherentPrimary.hhadCode,'2');
 assert.equal(d.handicapAnalysis.marketReference.quoteProvenance.version,'signed-live-handicap-v1');
});
test('bad signature, payload tampering, unknown key, URL and incomplete market pair are rejected',()=>{
 for(const mutate of [s=>s.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h=9,
  s=>s.endpoints[0].collectorAttestation.signature='bad',s=>s.endpoints[0].collectorAttestation.keyId='unknown',
  s=>s.endpoints[0].url='https://example.org/odds',s=>s.endpoints.pop()]){
  const m=source(),s=snapshot();mutate(s);assert.equal(join([m],s)[0],m);
 }
});
test('exact teams, kickoff, business day, identity and current sale status bind both endpoints',()=>{
 const changes=[r=>r.homeTeamAllName='other',r=>r.matchTime='23:01:00',r=>r.businessDate='2026-09-18',r=>r.matchId='2',
  r=>r.poolList[0].poolStatus='Closed',r=>r.poolList[0].bettingAllup=0,r=>r.oddsList.push(structuredClone(r.oddsList[0])),r=>r.oddsList[0].goalLine=''];
 for(const change of changes){const m=source();assert.equal(join([m],snapshot(NOW,change))[0],m);}
 for(const patch of [{status:'LIVE'},{predictionMeta:{lockedAt:stamp(NOW)}},{buyEndTime:stamp(NOW)}]){const m={...source(),...patch};assert.equal(join([m])[0],m);}
 for(const change of [r=>r.matchStatus='Suspended',r=>r.sellStatus=0]){const next=join([source()],snapshot(NOW,change))[0];assert.equal(makeDecision(next,{now:NOW,publication:publication(NOW)}).decision,null);}
});
test('acquisition TTL and future clock cannot be extended by copying snapshot metadata',()=>{
 for(const quoteNow of [NOW-16*60000,NOW+1000]){const m=source();assert.equal(join([m],snapshot(quoteNow))[0],m);}
 const m=source(),s=snapshot(NOW-16*60000);s.capturedAt=stamp(NOW);assert.equal(join([m],s)[0],m);
});
