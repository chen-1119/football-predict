'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {collectResults,validResultEvent}=require('../scripts/recommendationPlatform/results.cjs');
const {CANDIDATES,buildFrozenHadCandidateDiagnostic:build,buildOfflineOfficialResultReplay,auditInputAdmission}=require('../scripts/research/frozenHadCandidates.cjs');
const {NOW,match,publication,validators}=require('./recommendationFixture.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const ASOF=NOW+86400000;
function fixture(id,actual='1',patch={},at=NOW){
  const source=match(id,at,patch),decision=makeDecision(source,{now:at,publication:publication(at)}).decision;
  assert(decision&&validDecision(decision));
  const [scoreHome,scoreAway]=actual==='1'?[1,0]:actual==='2'?[0,1]:[0,0];
  const event=collectResults([{...source,status:'FINISHED',testOfficial:true,scoreHome,scoreAway}],new Map(),validators,ASOF).updates[0];
  assert(event&&validResultEvent(event));return {decision,event};
}
const input=rows=>({observedAt:new Date(ASOF).toISOString(),decisions:rows.map(r=>r.decision),resultHeads:rows.map(r=>r.event),productionWrites:0});

test('fixed candidates share settled events and original-direction groups; never promote the observed winner',()=>{
  const a=fixture(1,'1'),b=fixture(2,'2',{probabilityModel:{version:'test-away',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:{home:20,draw:25,away:55}}}}),c=fixture(3,'X');
  const p=input([a,b,c]),before=JSON.stringify(p),r=build(p);
  assert.equal(JSON.stringify(p),before);assert.equal(r.sample.pairedSettledEvents,3);
  assert.deepEqual(Object.keys(r.overall.candidates),CANDIDATES.map(c=>c.id));
  assert.equal(r.overall.candidates['frozen-model'].commonDirection.won,2);
  assert.equal(r.overall.candidates['frozen-market'].commonDirection.won,1);
  assert.equal(r.byOriginalDirection['2'].commonDirectionRows,1);
  for(const c of Object.values(r.overall.candidates)){assert.equal(c.rows,3);assert.equal(c.commonDirection.settled,3);assert.equal(c.sameRowsMarket.settled,3);}
  assert.equal(r.productionEligible,false);assert.equal(r.productionWrites,0);assert.equal(r.holdoutClaim,false);assert.equal(r.selectedCandidate,null);
  assert.equal(r.sample.fixtureCoverage,null);assert.equal(r.pairedCalendarUncertainty['frozen-model'].status,'insufficient-calendar-support');
  assert.equal(r.pairedCalendarUncertainty['frozen-model'].familyAdjusted,null);assert.deepEqual(build(p),r);
});
test('market ties abstain across the common accuracy cohort without discarding probability loss',()=>{
  const r=build(input([fixture(1,'X',{odds:{odds1:2.2,oddsX:2.2,odds2:4.4}}),fixture(2,'1')]));
  assert.equal(r.overall.probabilityRows,2);assert.equal(r.overall.commonDirectionRows,1);assert.equal(r.overall.tieExcludedRows,1);
  assert.equal(r.overall.candidates['frozen-model'].ownDirection.settled,2);
  assert.equal(r.overall.candidates['frozen-market'].ownDirection.abstainedTies,1);
  for(const c of Object.values(r.overall.candidates)){assert.equal(c.commonDirection.settled,1);assert(Number.isFinite(c.brier));}
});
test('future or pre-kickoff result observations cannot leak into the as-of cohort',()=>{
  const a=fixture(1),b=fixture(2);a.event={...a.event,observedAt:new Date(ASOF+1).toISOString()};b.event={...b.event,observedAt:new Date(NOW).toISOString()};
  const r=build(input([a,b]));assert.equal(r.sample.pairedSettledEvents,0);assert.equal(r.sample.settlementStates.PENDING,2);assert.equal(r.exclusions['result-clock-unavailable'],2);
  assert.equal(r.overall.candidates['frozen-model'].commonDirection.hitRate,null);
});
test('unaccepted public result payload cannot silently settle a pending frozen decision',()=>{
  const p=input([fixture(1)]);p.resultHeads=[];p.knownPendingOfficialResult=[{sourceMatchId:'1',scoreHome:1,scoreAway:0,status:'FINISHED'}];
  const r=build(p);assert.equal(r.sample.pairedSettledEvents,0);assert.equal(r.sample.settlementStates.PENDING,1);assert.equal(r.sample.knownPendingOfficialResult,1);
});
test('tampered decisions and results are excluded instead of improving accuracy',()=>{
  const a=fixture(1),b=fixture(2);a.decision={...a.decision,tipCode:'2'};b.event={...b.event,scoreHome:9};
  const r=build(input([a,b]));assert.equal(r.sample.pairedSettledEvents,0);assert.equal(r.exclusions['invalid-decision'],1);assert.equal(r.sample.settlementStates.DISPUTED,1);
});
test('same-time conflicting publications or result heads fail closed regardless of input order',()=>{
  const a=fixture(1),b=fixture(1,'1',{odds:{odds1:1.9,oddsX:3.5,odds2:4.5}}),p=input([a,b]);
  const r=build(p),reverse=build({...p,decisions:[...p.decisions].reverse()});
  assert.equal(r.sample.publishedEvents,0);assert.deepEqual(r.overall,reverse.overall);assert.equal(r.exclusions['ambiguous-latest-publication'],1);
  const q=input([a]);q.resultHeads.push(fixture(1,'2').event);const conflict=build(q);
  assert.equal(conflict.sample.settlementStates.DISPUTED,1);assert.equal(conflict.sample.pairedSettledEvents,0);
});
test('repeated identical evidence is deduplicated and latest pre-cutoff input supersedes old input',()=>{
  const old=fixture(1),later=fixture(1,'1',{odds:{odds1:1.9,oddsX:3.5,odds2:4.5}},NOW+60000),p=input([old,later,later]);
  const r=build(p);assert.equal(r.sample.publishedEvents,1);assert.equal(r.sample.pairedSettledEvents,1);assert.equal(r.exclusions['superseded-publication'],1);assert.equal(r.exclusions['duplicate-publication'],1);
});
test('team identity conflicts never settle from an otherwise valid score event',()=>{
  const a=fixture(1),other=fixture(1,'1',{homeTeamId:'wrong-home'}),p=input([a]);p.resultHeads=[other.event];
  const r=build(p);assert.equal(r.sample.settlementStates.DISPUTED,1);assert.equal(r.sample.pairedSettledEvents,0);
});
test('sample admission diagnoses observed two-team floors and preserves missing evidence as unknown',()=>{
  assert.equal(auditInputAdmission({}).group,'evidence-unavailable');
  const decision={inputEvidence:{model:{inputEvidence:{samples:{elo:{home:0,away:486},form:{home:0,away:12}},weights:{elo:.35,form:0}}}}};
  const audit=auditInputAdmission(decision);assert.equal(audit.group,'sample-floor-violation');assert.equal(audit.elo,'positive-weight-below-both-team-sample-floor');assert.equal(audit.form,'no-sample-floor-violation');
  decision.inputEvidence.model.inputEvidence.weights.elo=0;assert.equal(auditInputAdmission(decision).group,'no-sample-floor-violation');
  decision.inputEvidence.model.inputEvidence.weights.form=.1;assert.equal(auditInputAdmission(decision).group,'sample-floor-violation');
  delete decision.inputEvidence.model.inputEvidence.samples.form;assert.equal(auditInputAdmission(decision).group,'evidence-incomplete');
});
test('missing as-of clock is rejected rather than silently evaluated with the current machine clock',()=>{
  assert.throws(()=>build({decisions:[],resultHeads:[]}),/observedAt/);
});
test('business-day blocks reject invalid normalized dates and future Beijing business days',()=>{
  const rows=[fixture(1),fixture(2),fixture(3)];
  for(const [i,date] of ['2026-02-30','2026-09-19','2026-9-17'].entries()){
    const {recordHash,...body}=rows[i].decision;body.businessDate=date;rows[i].decision={...body,recordHash:hash(body)};
    assert(validDecision(rows[i].decision));
  }
  const r=build(input(rows));assert.equal(r.sample.pairedSettledEvents,0);assert.equal(r.exclusions['invalid-business-date'],2);assert.equal(r.exclusions['future-business-date'],1);
});
test('explicit offline supplement comparison retains original evidence and has a no-change second replay',()=>{
  const official=require('./fixtures/recommendation-kleague-2041558.json');
  const at=Date.parse('2026-09-19T06:00:00Z'),source=match('2041558',at,{businessDate:'2026-09-19',kickoffTime:'2026-09-19T10:00:00Z',eventVersion:'2026-09-19T10:00:00Z',homeTeamId:official.homeTeamId,awayTeamId:official.awayTeamId,probabilityModel:{version:'test',generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}}});
  const d=makeDecision(source,{now:at,publication:publication(at)}).decision;assert(d&&validDecision(d));
  const p={...input([fixture(1)]),observedAt:'2026-09-26T15:28:12.000Z',knownPendingOfficialResult:[official]};p.decisions.push(d);
  const before=JSON.stringify(p),r=buildOfflineOfficialResultReplay(p);
  assert.equal(JSON.stringify(p),before);assert.equal(r.applied,1);assert.equal(r.retainedUnchangedResultHeads,1);assert.equal(r.noChangeReplay.applied,0);
  assert.equal(r.baseline.sample.pairedSettledEvents,1);assert.equal(r.afterLocalSupplement.sample.pairedSettledEvents,2);
  assert.equal(r.productionWrites,0);assert.equal(r.afterLocalSupplement.productionEligible,false);assert.equal(r.frozenDecisionsUnchanged,true);
});
