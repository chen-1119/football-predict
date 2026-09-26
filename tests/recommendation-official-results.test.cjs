'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {match,memoryPorts}=require('./recommendationFixture.cjs');
const {buildFixtureSignal,applyKLeagueOfficialResult}=require('../scripts/syncKLeagueOfficialStandings.cjs');
const {officialResultValidators,supplementaryOfficialEvidence,resultAllowsCalibration}=require('../scripts/recommendationPlatform/officialResults.cjs');
const {collectResults,key,validResultEvent,settleDecision}=require('../scripts/recommendationPlatform/results.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {publication}=require('./recommendationFixture.cjs');
const KICKOFF='2026-09-26T08:30:00.000Z',PUBLISHED=Date.parse('2026-09-26T06:00:00.000Z'),OBSERVED='2026-09-26T10:30:00.000Z',NOW=Date.parse(OBSERVED)+60000;
function scheduled(){return match('2041558',PUBLISHED,{businessDate:'2026-09-26',homeTeamName:'安养FC',awayTeamName:'蔚山现代',
  kickoffTime:KICKOFF,eventVersion:KICKOFF,handicapLine:1,handicapOdds:{odds1:2,oddsX:3,odds2:3},handicapOddsSource:'sporttery:HHAD',
  handicapOddsUpdatedAt:new Date(PUBLISHED).toISOString(),probabilityModel:{version:'test',generatedAt:new Date(PUBLISHED).toISOString(),
    oneXTwo:{final:{home:55,draw:25,away:20}},calculationTrace:{poisson:{lambdas:{home:1.5,away:1}}}}});}
function official({home=2,away=1,observedAt=OBSERVED,status='FE',revision=0}={}){
  const source=scheduled();
  // Exercise the existing official schedule adapter, including Korean local
  // kickoff conversion, unique team mapping and the signed score evidence.
  const fixture=buildFixtureSignal({match:source,rows:[{gameId:2041558,gameDate:'2026.09.26',gameTime:'17:30',
    homeTeam:'K27',awayTeam:'K01',homeTeamName:'ANYANG',awayTeamName:'ULSAN',homeGoal:home,awayGoal:away,gameStatus:status}],
    observedAt,sourceUrl:'https://www.kleague.com/getScheduleList.do',responseSha256:'b'.repeat(64)});
  return {...applyKLeagueOfficialResult({...source,externalSignals:{kLeagueOfficial:{fixture}}}),resultRevision:revision};
}
const collect=(rows,previous=new Map(),now=NOW)=>collectResults(rows,previous,officialResultValidators(now),now);
test('the production Anyang-Ulsan 2041558 provenance is accepted without rewriting its signed timezone representation',()=>{
  const row=require('./fixtures/recommendation-kleague-2041558.json'),before=JSON.stringify(row);
  const event=collect([row]).updates[0];assert(event);assert(validResultEvent(event));
  assert.equal(event.eventVersion,'2026-09-19T10:00:00.000Z');
  assert.equal(event.officialResultEvidence.provenance.eventVersion,'2026-09-19T18:00:00+08:00');
  assert.equal(event.officialResultEvidence.provenance.providerMatchId,'176');
  assert.equal(event.sourceResultObservedAt,'2026-09-19T16:20:52.404Z');
  assert.deepEqual([event.scoreHome,event.scoreAway],[2,1]);assert.equal(JSON.stringify(row),before);
});
test('trusted K League result closes the actual Sporttery event with retained settlement-only evidence',()=>{
  const result=collect([official()]);assert.equal(result.updates.length,1);
  const event=result.updates[0];assert(validResultEvent(event));assert.equal(event.sourceMatchId,'2041558');
  assert.equal(event.eventVersion,KICKOFF);assert.deepEqual([event.scoreHome,event.scoreAway],[2,1]);
  assert.equal(event.sourceResultObservedAt,OBSERVED);assert.equal(event.observedAt,new Date(NOW).toISOString());
  assert.equal(event.settlementOnly,true);assert.equal(event.promotionEligible,false);assert.equal(resultAllowsCalibration(event),false);
  assert.equal(event.officialResultEvidence.provenance.providerMatchId,'2041558');
});
test('untrusted origins, wrong identities, reschedules and changed score hashes cannot settle',()=>{
  for(const edit of [r=>r.resultProvenance.sourceUrl='https://example.com/score',r=>r.resultProvenance.trusted=false,
    r=>r.sourceMatchId='other',r=>r.resultProvenance.providerMatchId='',r=>r.eventVersion='2026-09-26T09:00:00Z',
    r=>r.kickoffTime='2026-09-26T09:00:00Z',r=>r.scoreHome=9,r=>r.resultProvenance.evidenceHash='a'.repeat(64)]){
    const r=official();edit(r);assert.equal(collect([r]).updates.length,0);
  }
  assert.equal(collect([{...scheduled(),status:'FINISHED',scoreHome:2,scoreAway:1,resultSource:'500.com',resultObservedAt:OBSERVED}]).updates.length,0);
});
test('strict actual observation clocks reject early, future, missing and mismatched result clocks',()=>{
  assert.equal(collect([official({observedAt:'2026-09-26T09:00:00Z'})]).updates.length,0);
  for(const edit of [r=>delete r.resultObservedAt,r=>r.resultObservedAt='2026-09-26T10:31:00Z',
    r=>r.resultObservedAt='2026-02-30T10:30:00Z',r=>r.resultObservationFallback=true,
    r=>{r.resultObservedAt=r.resultProvenance.observedAt='2026-09-27T10:30:00Z';}]){
    const r=official();edit(r);assert.equal(collect([r]).updates.length,0);
  }
});
test('canceled or live supplementary rows cannot masquerade as final or official void results',()=>{
  for(const status of ['LIVE','SCHEDULED','CANCELLED'])assert.equal(collect([{...official(),status}]).updates.length,0);
  assert.equal(collect([{...official(),resultDisposition:'VOID',voidSource:'k-league:official-schedule-api',voidReason:'cancelled'}]).updates.length,0);
  assert.equal(collect([official({status:'CANCELLED'})]).updates.length,0);
  const sportteryVoid={...scheduled(),resultDisposition:'VOID',voidSource:'sporttery:official-api',voidReason:'official cancel'};
  assert.equal(collect([sportteryVoid]).updates[0].state,'VOID');
  const canceledSupplement=collect([{...official(),...sportteryVoid}]).updates[0];
  assert.equal(canceledSupplement.state,'VOID');assert.equal(canceledSupplement.source,'sporttery:official-api');
  assert(validResultEvent(canceledSupplement));
});
test('result corrections require a higher official revision, never rewrite the frozen decision',()=>{
  const d=makeDecision(scheduled(),{now:PUBLISHED,publication:publication(PUBLISHED)}).decision,original=JSON.stringify(d);
  const first=collect([official()]).updates[0];assert.equal(settleDecision(d,first).state,'WON');
  const conflict=collect([official({home:0,away:1})],new Map([[key(first),first]])).updates[0];
  assert.equal(conflict.state,'DISPUTED');assert(validResultEvent(conflict));
  const corrected=collect([official({home:0,away:1,revision:1})],new Map([[key(conflict),conflict]])).updates[0];
  assert(validResultEvent(corrected));assert.equal(corrected.previousEventId,conflict.eventId);
  assert.equal(settleDecision(d,corrected).state,'LOST');assert.equal(JSON.stringify(d),original);
  assert.equal(collect([official()],new Map([[key(corrected),corrected]])).updates.length,0);
});
test('supplementary event evidence cannot be discarded, promoted or edited after collection',()=>{
  const event=collect([official()]).updates[0];
  for(const edit of [r=>delete r.officialResultEvidence,r=>delete r.officialResultEvidenceHash,r=>delete r.settlementOnly,r=>r.promotionEligible=true,
    r=>r.officialResultEvidence.scoreHome=9,r=>r.sourceResultObservedAt='2026-09-26T09:00:00Z']){
    const changed=structuredClone(event);edit(changed);assert.equal(validResultEvent(changed),false);
  }
});
test('event identity binds a full supplemental receipt; a different valid same-score receipt cannot replace it',()=>{
  const event=collect([official()]).updates[0];
  const replacement=supplementaryOfficialEvidence(official({observedAt:'2026-09-26T10:29:00.000Z'}),NOW);
  assert(replacement);assert.notEqual(replacement.officialResultEvidenceHash,event.officialResultEvidenceHash);
  assert.equal(validResultEvent({...event,...replacement}),false);
  const asLegacy=structuredClone(event);asLegacy.source='sporttery:official-api';
  for(const field of ['settlementOnly','promotionEligible','sourceResultObservedAt','officialResultEvidence','officialResultEvidenceHash'])delete asLegacy[field];
  assert.equal(validResultEvent(asLegacy),false,'dropping the new evidence cannot restore a legacy event identity');
  assert.equal(collect([official({observedAt:'2026-09-26T10:31:00.000Z'})],new Map([[key(event),event]]),NOW+60000).updates.length,0);
  const dispute=collect([official({home:0,away:1})],new Map([[key(event),event]])).updates[0];
  assert.equal(dispute.state,'DISPUTED');
  assert.equal(collect([official({home:0,away:1,observedAt:'2026-09-26T10:31:00.000Z'})],new Map([[key(dispute),dispute]]),NOW+60000).updates.length,0);
});
test('same-score Sporttery confirmation upgrades evidence without a false dispute or later downgrade',()=>{
  const supplementary=collect([official()]).updates[0];
  const sporttery={...scheduled(),status:'FINISHED',scoreHome:2,scoreAway:1,resultObservedAt:OBSERVED,
    official:true,resultSource:'sporttery:official-api'};
  const upgraded=collect([sporttery],new Map([[key(supplementary),supplementary]])).updates[0];
  assert.equal(upgraded.state,'FINAL');assert(validResultEvent(upgraded));assert.equal(resultAllowsCalibration(upgraded),true);
  assert.equal(upgraded.previousEventId,supplementary.eventId);
  assert.equal(collect([official()],new Map([[key(upgraded),upgraded]])).updates.length,0);
  assert.equal(collect([official(),sporttery]).updates[0].source,'sporttery:official-api');
});
test('default runtime settles the supplemented final but excludes it from live handicap calibration',async()=>{
  const ports=memoryPorts();ports.now=PUBLISHED;ports.current=[scheduled()];
  const runtime=createRuntime(ports);await runtime.publishingCycle();
  assert.equal(ports.state.decisions.length,1);const original=JSON.stringify(ports.state.decisions);
  ports.now=Date.parse('2026-09-27T06:00:00Z');ports.history=[official()];
  const result=await runtime.settlementCycle();assert.equal(result.settlement.ok,true);assert.equal(result.settlement.value.applied,1);
  assert.equal(ports.state.view.review.statistics.single.won,1);
  assert.equal(ports.state.view.review.handicapCalibration.sampleRows,0);
  const quality=ports.state.view.review.qualityReport,target=quality.hitRateTarget.byModelVersion[0].overall;
  assert.equal(quality.overall.settled,1);assert.equal(quality.overall.marketUniqueTopSettled,1);
  assert.equal(target.marketComparison.settled,1);assert.equal(target.marketComparison.modelWins,1);
  assert.equal(target.marketComparison.marketWins,1);assert.equal(quality.formalPromotion,false);
  assert.equal(quality.hitRateTarget.formalPromotion,false);
  assert.equal(JSON.stringify(ports.state.decisions),original);
  const repeat=await runtime.settlementCycle();assert.equal(repeat.settlement.value.applied,0);
  assert.equal(supplementaryOfficialEvidence(official(),NOW).promotionEligible,false);
});
