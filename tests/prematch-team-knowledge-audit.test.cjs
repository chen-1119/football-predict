'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildPrematchTeamSnapshot}=require('../src/services/prematchTeamEvidenceV3.cjs');
const {auditPrematchTeamKnowledge,inspectHandicapMarket}=require('../scripts/prematchTeamKnowledgeAudit.cjs');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const event={sourceMatchId:'audit-fixture',eventVersion:'2026-10-08T18:00:00Z',cutoffAt:'2026-10-08T16:00:00Z',
  homeTeamId:'audit-home',awayTeamId:'audit-away',status:'SCHEDULED',isOnSale:true};
const asOf='2026-10-08T12:00:00.000000000Z',known='2026-10-08T11:00:00Z';
const source={provider:'synthetic-only',receiptHash:'a'.repeat(64),rawPayloadHash:'b'.repeat(64)};
function row(family,data,extra={}){return {family,side:'home',sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,
  teamId:event.homeTeamId,source,providerObservedAt:known,receivedAt:known,clockBasis:'collector-response-body-completed',data,...extra};}
const snapshot=observations=>buildPrematchTeamSnapshot({event,asOf,observations});
const players=()=>Array.from({length:11},(_,i)=>({playerId:'synthetic-player-'+i,expectedMinutes:90,
  contributionPer90:{attack:.1,defense:.1},replacementPer90:{attack:.05,defense:.05}}));
const metric={attack:'sourced-per90-attack',defense:'sourced-per90-defense'};
const roster=(status='confirmed',extra={})=>row('roster',{status,players:players(),contributionMetric:metric},extra);
function xg(observed=true,extra={}){return row('xg',{rows:[{sourceMatchId:'prior-fixture',eventVersion:'2026-10-01T18:00:00Z',
  teamId:event.homeTeamId,source,status:'FINISHED',providerObservedAt:'2026-10-02T01:00:00Z',receivedAt:'2026-10-02T01:00:00Z',
  observed,observedXgFor:0,observedXgAgainst:1.1,...extra}]});}
test('missing evidence remains 46 nulls, with no inferred health, factor readiness or probability',()=>{
  const v=auditPrematchTeamKnowledge(snapshot([]));assert.equal(v.status,'research-audited');
  assert.equal(v.unknownFeatureCount,46);assert(Object.values(v.features).every(x=>x===null));
  assert.equal(v.sides.home.availability.knownUnavailableInObservedList,null);
  assert.equal(v.sides.home.availability.wholeTeamNoInjuryProven,false);assert.equal(v.formalEligible,false);
  assert.equal(v.probabilitiesProduced,false);assert.equal(v.completeFactorReadinessProven,false);
});
test('explicit zero injury count describes only a provided list, never an all-healthy team',()=>{
  const input=snapshot([row('injuries',{players:[{playerId:'synthetic-one',availability:'available'}]})]);
  const v=auditPrematchTeamKnowledge(input);assert.equal(v.features['home.injuries.knownUnavailablePlayers'],0);
  assert(v.sides.home.sections.injuries.zeroFields.includes('home.injuries.knownUnavailablePlayers'));
  assert.equal(v.sides.home.availability.wholeTeamNoInjuryProven,false);
});
test('medical news without stable player identity has no count or appearance probability',()=>{
  const v=auditPrematchTeamKnowledge(snapshot([row('injuries',{availabilityMeaning:'medical-news-only',
    players:[{availability:'out'}]})]));assert.equal(v.sides.home.availability.knownUnavailableInObservedList,null);
  assert.equal(v.sides.home.availability.individualAppearanceProbabilities,null);
  assert.equal(v.sides.home.availability.medicalCauseVerified,false);
});
test('withdrawal count and known identity do not prove diagnosis or likely appearance',()=>{
  const v=auditPrematchTeamKnowledge(snapshot([row('injuries',{availabilityMeaning:'withdrawn-from-call-up;cause-unknown',
    players:[{playerId:'synthetic-one',availability:'out'}]})]));
  assert.equal(v.sides.home.availability.knownUnavailableInObservedList,1);
  assert.deepEqual(v.sides.home.availability.meaning,['withdrawn-from-call-up;cause-unknown']);
  assert.equal(v.sides.home.availability.medicalCauseVerified,false);
  assert.equal(v.sides.home.availability.individualAppearanceProbabilities,null);
});
test('projected and confirmed XI remain separate provider labels without approval upgrade',()=>{
  const v=auditPrematchTeamKnowledge(snapshot([roster('projected'),roster('confirmed')]));
  assert.equal(v.sides.home.roster.confirmed.elevenDistinctPlayerIdsRetained,true);
  assert.equal(v.sides.home.roster.projected.elevenDistinctPlayerIdsRetained,true);
  assert.equal(v.sides.home.roster.confirmed.independentSourceConfirmationProven,false);
  assert.equal(v.sides.home.roster.confirmed.lineupAnnouncementMeaningVerified,false);
});
test('a confirmed list received one nanosecond after early asOf never leaks early XI evidence',()=>{
  const future='2026-10-08T12:00:00.000000001Z';const v=auditPrematchTeamKnowledge(snapshot([roster('confirmed',
    {providerObservedAt:future,receivedAt:future})]));
  assert.equal(v.sides.home.roster.confirmed.elevenDistinctPlayerIdsRetained,false);
  assert(v.rejectedObservations[0].reasons.includes('observation-not-known-at-as-of'));
  assert.equal(v.features['home.roster.confirmed.attackContributionPer90'],null);
});
test('publication and new alias-review clocks remain separate; neither is backdated',()=>{
  const input=snapshot([roster('confirmed',{sourcePublishedAt:'2026-10-08T10:00:00Z',
    identityMappingReviewedAt:'2026-10-08T11:30:00Z',identityMappingHash:'c'.repeat(64)})]);
  const v=auditPrematchTeamKnowledge(input),c=v.sides.home.sections['roster.confirmed'].clocks[0];
  assert.equal(c.receivedAt,known);assert.equal(c.sourcePublishedAt,'2026-10-08T10:00:00Z');
  assert.equal(c.identityMappingReviewedAt,'2026-10-08T11:30:00Z');
  assert.equal(v.sides.home.roster.confirmed.lineupAnnouncementMeaningVerified,false);
});
test('load fields and restDays do not prove complete all-competition schedule',()=>{
  const v=auditPrematchTeamKnowledge(snapshot([row('fatigue',{lastMatchEndedAt:'2026-10-05T20:00:00Z',
    minutesLast7Days:0,minutesLast14Days:90,travelKm:0,rotationCount:0})]));
  assert(v.sides.home.fatigue.restDays>0);assert.equal(v.features['home.fatigue.minutesLast7Days'],0);
  assert.equal(v.sides.home.fatigue.completeScheduleProven,false);
  assert.equal(v.sides.home.fatigue.allCompetitionsCovered,null);assert.equal(v.sides.home.fatigue.playerMinutesCoverage,null);
});
test('prior observed xG zero is preserved, estimated or future xG is unknown',()=>{
  const observed=auditPrematchTeamKnowledge(snapshot([xg()]));
  assert.equal(observed.features['home.xg.observedXgForPerMatch'],0);
  assert.equal(observed.sides.home.xg.observedPriorSampleCount,1);assert.equal(observed.sides.home.xg.completeCoverageProven,false);
  for(const r of [xg(false),xg(true,{receivedAt:'2026-10-08T13:00:00Z'})])
    assert.equal(auditPrematchTeamKnowledge(snapshot([r])).features['home.xg.observedXgForPerMatch'],null);
});
test('future event/closed cutoff or mutated snapshot cannot be audited as ready',()=>{
  const invalid=snapshot([roster()]);invalid.features['home.roster.confirmed.attackContributionPer90']=99;
  assert.equal(auditPrematchTeamKnowledge(invalid).status,'blocked');
  const closed=buildPrematchTeamSnapshot({event,asOf:event.cutoffAt,observations:[roster()]});
  assert.equal(auditPrematchTeamKnowledge(closed).status,'blocked');
});
test('getters, cyclic and sparse inputs are refused before source values execute',()=>{
  let called=0;const v={};Object.defineProperty(v,'secret',{enumerable:true,get(){called++;throw Error('must not run');}});
  assert.equal(auditPrematchTeamKnowledge(v).status,'blocked');assert.equal(called,0);
  const cycle={};cycle.self=cycle;assert.equal(auditPrematchTeamKnowledge(cycle).status,'blocked');
  const sparse=snapshot([]);sparse.observations=new Array(2);assert.equal(auditPrematchTeamKnowledge(sparse).status,'blocked');
});
test('audit is deterministic and keeps source snapshot bytes immutable',()=>{
  const input=snapshot([roster(),xg()]),before=JSON.stringify(input),first=auditPrematchTeamKnowledge(input);
  assert.equal(JSON.stringify(input),before);assert.deepEqual(auditPrematchTeamKnowledge(input),first);
  const {contentHash,...body}=first;assert.equal(contentHash,stableHash(body));
});
test('AH half/quarter/integer lines remain a separate market, without conversion to integer HHAD',()=>{
  for(const line of [-.5,-.75,-1,1.25]){const v=inspectHandicapMarket({market:'AH',line});
    assert.equal(v.status,'classified');assert.equal(v.market,'AH');assert.equal(v.canConvertToJcHhad,false);}
  assert.equal(inspectHandicapMarket({market:'HHAD',line:-.75}).status,'blocked');
});
test('integer HHAD classification never supplies or approves a price; null is not zero',()=>{
  const v=inspectHandicapMarket({market:'HHAD',line:-1});assert.equal(v.status,'classified');
  assert.equal(v.officialPriceBindingProven,false);
  for(const line of [null,undefined,false,'-1',NaN])assert.equal(inspectHandicapMarket({market:'HHAD',line}).status,'blocked');
  assert.equal(inspectHandicapMarket({market:'HHAD',line:0}).status,'classified');
  assert.equal(inspectHandicapMarket({market:'HHAD',line:-1,sp:2}).status,'blocked');
});
