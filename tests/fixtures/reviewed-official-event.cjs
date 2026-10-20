'use strict';
// Synthetic collector keys and events only; never a production grant.
const f=require('./signed-live-had.cjs');
const p=require('../../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {buildCollectorCommitment,signCollectorCommitment,sha256CollectorJson}=require('../../src/services/collectorAttestation.cjs');
const {SPORTTERY_CALCULATOR_URL}=require('../../scripts/sportteryEndpointContract.cjs');
function resign(e,pair){
 e.canonicalPayloadSha256=sha256CollectorJson(e.payload);
 const commitment=buildCollectorCommitment({endpoint:e.sourceRequest,collectorCycleId:e.sourceCycleId,
  requestedAt:e.requestedAt,receivedAt:e.receivedAt,response:{httpStatus:e.httpStatus,contentType:e.contentType,
   rawSha256:e.rawSha256,rawBytes:e.rawBytes,headersSha256:e.headersSha256},payload:e.payload,canonicalPayloadSha256:e.canonicalPayloadSha256});
 e.collectorAttestation=signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});return e;
}
function setup(pair){
 const source=[f.source(1),f.source(2)];
 const signed=f.snapshot(source,{...(pair?{pair}:{}),mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{
  r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;
  r.oddsList.push({poolCode:'HHAD',goalLine:'-1',h:3.15,d:3.25,a:1.92});
  r.poolList.push({poolCode:'HHAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1});
 })});
 const calculator=structuredClone(signed.snapshot.endpoints[0]);calculator.method='calculator';calculator.url=SPORTTERY_CALCULATOR_URL;
 calculator.sourceRequest={method:'GET',url:calculator.url,page:null,role:'calculator'};resign(calculator,signed.pair);
 const snapshot={endpoints:[signed.snapshot.endpoints[0],calculator]};
 const singles=source.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,
  market:i?'HHAD':'HAD',handicap:i?-1:null,selection:i?'a':'h',scores:i?[[1,1],[1,2]]:[[2,0],[3,1]],
  confidence:'中',reason:'Synthetic actual reviewed evidence',analysisUrl:'https://example.com/preview',
  teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],sp:i?1.92:1.8,
  modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}));
 const original={version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',
  businessDate:source[0].businessDate,frozenAt:f.stamp(f.NOW-1000),singles:singles.map(({classification,...r})=>{void classification;return r;})};
 const archive=JSON.stringify(original);
 const draft={version:4,eventAuthority:'signed-official-events-v1',reportKind:'manual-prematch-batch',
  predictionScope:'reviewed-online-reference',businessDate:original.businessDate,frozenAt:original.frozenAt,
  singles,originalArchive:archive,originalArchiveSha256:p.sha(archive)};
 return {draft,snapshot,trustRegistry:signed.registry,pair:signed.pair,matches:[],asOf:f.stamp(f.NOW)};
}
module.exports={setup,resign,NOW:f.NOW,stamp:f.stamp};
