'use strict';
// Synthetic signed fixture only. No provider, production, or performance claim.
const path=require('node:path'),root=path.resolve(__dirname,'../..');
const signed=require(path.join(root,'tests/fixtures/signed-live-had.cjs'));
const p=require(path.join(root,'scripts/recommendationPlatform/reviewedAnalysis.cjs'));
const model=require(path.join(root,'src/services/leagueBaselineModel.cjs'));
const maker=require(path.join(root,'src/services/leagueBaselineRecommendation.cjs'));
const identity=require(path.join(root,'scripts/storedResultTeamIdentity.cjs'));
const {NOW,publication,match}=require(path.join(root,'tests/recommendationFixture.cjs'));
const {makeDecision}=require(path.join(root,'scripts/recommendationPlatform/decision.cjs'));
const result=require(path.join(root,'scripts/recommendationPlatform/results.cjs'));
function raw(key,payload,updated=payload.createdAt){const json=JSON.stringify(payload);return {artifact_key:key,artifact_version:payload.version,generated_at:payload.createdAt,updated_at:updated,payload_json:json,payload_sha256:p.sha(json),payload_bytes:Buffer.byteLength(json)};}
function setup({hhad=false,size=2}={}){
 const leagueId=identity.derivedTeamId('Synthetic League').replace(/^team_/,'league_');
 const matches=Array.from({length:size},(_,i)=>({...signed.source(i+1),leagueId}));
 const s=signed.snapshot(matches,{mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{
  r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;r.leagueAllName='Synthetic League';
  if(hhad&&i===0){r.oddsList=[{poolCode:'HHAD',goalLine:'-1',h:2.4,d:3.6,a:2.1}];r.poolList=[{poolCode:'HHAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1}];}
 })});
 const at=signed.stamp(NOW),frozenAt=signed.stamp(NOW-60000),original={version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate:'2026-09-17',frozenAt,
  singles:matches.map((m,i)=>({eventId:m.sourceMatchId,matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,
   market:hhad&&i===0?'HHAD':'HAD',handicap:hhad&&i===0?-1:null,selection:hhad&&i===0?'d':'h',
   scores:hhad&&i===0?[[1,0],[2,1]]:[[2,0],[3,1]],confidence:'中',reason:'Synthetic fixture, not research',analysisUrl:'https://example.invalid/fixture',
   teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],sp:hhad&&i===0?3.6:1.8,
   modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}))};
 const originalArchive=JSON.stringify(original),draft={...original,version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',originalArchive,originalArchiveSha256:p.sha(originalArchive)};
 const inputs={matches,snapshot:s.snapshot},record=p.make(draft,{...inputs,trustRegistry:s.registry,asOf:at});
 const key='reviewed-analysis-'+record.businessDate+'-batch-'+p.hash(draft),storedAt=signed.stamp(NOW+1),ackAt=signed.stamp(NOW+2);
 const freeze=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:record.createdAt,record,draft,inputs,storedAt});
 const recordRow=raw(key,freeze,storedAt),ackRow=raw(key+'-ack',p.seal({version:'reviewed-analysis-ack-v1',createdAt:ackAt,recordKey:key,storedSha256:recordRow.payload_sha256,recordHash:record.contentHash}));
 return {manual:{recordRow,ackRow},matches,snapshot:s.snapshot,trustRegistry:s.registry,pair:s.pair,asOf:signed.stamp(NOW+8*3600000),record};
}
function rebatch(v,change){
 const b=JSON.parse(v.manual.recordRow.payload_json);change(b);
 const original=JSON.parse(b.draft.originalArchive);original.singles=b.draft.singles;b.draft.originalArchive=JSON.stringify(original);b.draft.originalArchiveSha256=p.sha(b.draft.originalArchive);
 b.record=p.make(b.draft,{...b.inputs,trustRegistry:v.trustRegistry,asOf:b.record.createdAt});delete b.contentHash;
 const key='reviewed-analysis-'+b.record.businessDate+'-batch-'+p.hash(b.draft),recordRow=raw(key,p.seal(b),b.storedAt),oldAck=JSON.parse(v.manual.ackRow.payload_json);delete oldAck.contentHash;
 const ackRow=raw(key+'-ack',p.seal({...oldAck,recordKey:key,storedSha256:recordRow.payload_sha256,recordHash:b.record.contentHash}));return {recordRow,ackRow};
}
function trained(f){
 const match=f.matches[0],parameters={poisson:{teams:['Alpha','Bravo'],attack:[.3,-.3],defense:[0,0],homeIntercept:.3,awayIntercept:.1,converged:true,gradientNorm:1e-8},
  elo:{ratings:{Alpha:1500,Bravo:1500},homeAdvantage:50,drawRate:.25},frequencies:{1:.5,X:.25,2:.25},poissonWeight:1,trainingRows:380,through:'2025-12-01',inputHash:'f'.repeat(64)};
 const packet=model.seal({version:model.VERSION,league:'br1',researchOnly:true,formalEligible:false,createdAt:signed.stamp(NOW-60000),availableAt:signed.stamp(NOW-60000),parameters,parametersHash:model.hash(parameters),reportSha256:'a'.repeat(64),historySha256:'b'.repeat(64),
  validation:{kind:'chronological-statistical-holdout',testRows:380,brier:.6,logLoss:1,baselineBrier:.65,baselineLogLoss:1.1,formalEligible:false},
  bindings:['home','away'].map((side,i)=>({teamId:match[side+'TeamId'],teamName:match[side+'TeamName'],leagueId:match.leagueId,modelTeam:parameters.poisson.teams[i],reviewId:'synthetic-only',reviewedAt:signed.stamp(NOW-65000),evidence:[{url:'https://example.invalid/synthetic',sha256:'c'.repeat(64)}]}))});
 const inputs={packet,match,snapshot:f.snapshot},record=maker.make({...inputs,trustRegistry:f.trustRegistry,asOf:signed.stamp(NOW)}),storedAt=signed.stamp(NOW+1),observedAt=signed.stamp(NOW+2);
 const recordRow=raw(record.id,model.seal({version:'league-baseline-freeze-v1',createdAt:record.createdAt,record,inputs,storedAt}),storedAt);
 const ackRow=raw(record.id+'-ack',model.seal({version:'league-baseline-adoption-ack-v1',createdAt:observedAt,observedAt,recordKey:record.id,recordHash:record.contentHash,storedSha256:recordRow.payload_sha256,modelHash:record.modelHash,parametersHash:record.parametersHash,formalEligible:false}));
 return {recordRow,ackRow};
}
function legacy({sequence=1,now=NOW,id=1,businessDate='2026-09-17',homeTeamId=identity.derivedTeamId('主队'+id)}={}){
 const source=match(id,now,{businessDate,homeTeamName:'主队'+id,awayTeamName:'客队'+id,homeTeamId,awayTeamId:identity.derivedTeamId('客队'+id),eventVersion:'2026-09-17T15:00:00Z',
  handicapLine:-1,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.74},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:signed.stamp(now),
  probabilityModel:{version:'synthetic-coverage',generatedAt:signed.stamp(now),oneXTwo:{final:{home:55,draw:25,away:20}},calculationTrace:{poisson:{lambdas:{home:1.72,away:1.32}}}}});
 const payload=makeDecision(source,{now,publication:publication(now)}).decision;if(!payload)throw Error('Synthetic legacy failed');return {sequence,payload};
}
function head(r,{score=[2,0],state='FINAL',now=NOW+7*3600000}={}){
 const raw={...r,sourceMatchId:r.sourceMatchId||r.eventId,eventVersion:r.eventVersion,kickoffTime:r.eventVersion,status:'FINISHED',scoreHome:score[0],scoreAway:score[1],resultRevision:1,resultObservedAt:signed.stamp(now),resultSource:'synthetic-only'};
 const e=result.collectResults([raw],new Map(),{isFinal:()=>state!=='VOID',isVoid:()=>state==='VOID'},now).updates[0];
 if(state==='DISPUTED'){const other={...raw,scoreHome:score[0]+1};return result.collectResults([raw,other],new Map(),{isFinal:()=>true,isVoid:()=>false},now).updates[0];}return e;
}
module.exports={setup,rebatch,trained,legacy,head,raw,p,NOW,stamp:signed.stamp};
