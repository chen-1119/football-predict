'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {selectionQuality,rawSelectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {bindPublicReferenceDecision,pendingPublicReferenceEvidence}=require('../src/services/publicReferenceDecision.cjs');
const {VERSION,evaluateEvidencePriceRecommendation:evaluate,validEvidencePriceRecommendation:verify,
  eventsConflict}=require('../src/services/evidencePriceRecommendationPolicy.cjs');

// Synthetic arithmetic only. These objects are NOT live observations or trusted
// calibration evidence; no test injects a passing formal-admission callback.
const at=Date.parse('2026-10-05T10:00:00Z');
const publication={generationId:'synthetic-price-policy',manifestHash:'a'.repeat(64)};
function fixture(id,{p={home:55,draw:25,away:20},quote={odds1:1.9,oddsX:4,odds2:5},hhquote={odds1:3.5,oddsX:4,odds2:2.2},line=-1,handicap=true,sparse=false,legacy=false}={}) {
  const match=withVerifiedInputEvidence({id:`sporttery_${id}`,sourceMatchId:id,businessDate:'2026-10-05',status:'SCHEDULED',
    homeTeamId:`h-${id}`,awayTeamId:`a-${id}`,homeTeamName:'Synthetic home',awayTeamName:'Synthetic away',
    kickoffTime:'2026-10-05T16:00:00Z',eventVersion:'2026-10-05T16:00:00Z',
    probabilityModel:{generatedAt:new Date(at).toISOString(),oneXTwo:{final:p},calculationTrace:{poisson:{lambdas:{home:1.7,away:1.3}}}},
    odds:quote,oddsSource:'sporttery:had',oddsUpdatedAt:new Date(at).toISOString(),
    ...(handicap?{handicapLine:line,handicapOdds:hhquote,handicapOddsSource:'sporttery:HHAD',handicapOddsPoolCode:'HHAD',handicapOddsObservedAt:new Date(at).toISOString()}:{}),
  },sparse?{eloHome:1,eloAway:2,formHome:1,formAway:2}:{});
  const d=makeDecision(match,{now:at,publication,...(legacy?{primaryPolicy:'independent-market-primary-v1'}:{})}).decision;
  assert.ok(validDecision(d));return {match,d};
}
const option=(r,market,tipCode)=>r.candidates.find(c=>c.market===market&&c.tipCode===tipCode);

test('all six options use unconditional same-market probabilities and prices without forcing a companion',()=>{
  const {d}=fixture('six'),before=hash(d),r=evaluate(d,{asOf:at});
  assert.equal(r.version,VERSION);assert.equal(r.candidates.length,6);
  assert.equal(r.distributions.HAD.modelLeader,'1');assert.equal(r.primary,null);assert.equal(r.companion,null);
  for(const c of r.candidates){
    const p=c.market==='HAD'?d.probabilities:d.handicapAnalysis.overallProbabilities;
    const q=c.market==='HAD'?d.quoteOdds:d.handicapAnalysis.marketReference.odds;
    assert.equal(c.modelProbability,p[c.tipCode]);assert.equal(c.odds,q[c.tipCode]);
    assert.equal(c.modelExpectedValue,p[c.tipCode]*q[c.tipCode]-1);
    assert.ok(Math.abs(c.marketProbability-(1/q[c.tipCode])/Object.values(q).reduce((sum,v)=>sum+1/v,0))<1e-12);
    assert.equal(c.probabilityBasis,'unconditional');assert.equal(c.formalEligible,false);
  }
  assert.equal(r.eligibleCandidateScope,'research-value-only');assert.ok(option(r,'HAD','1').researchValueEligible);
  assert.equal(r.selectionStatus,'research-value-candidates');assert.equal(hash(d),before);
  assert.ok(verify(r,d,{asOf:at}));assert.equal(verify({...r,formalEligible:true},d,{asOf:at}),false);
});
test('a conditional HAD upset never replaces the independent HAD leader',()=>{
  const {d}=fixture('companion',{p:{home:45.5,draw:26.4,away:28.1},quote:{odds1:1.34,oddsX:4.55,odds2:6.15},hhquote:{odds1:2.09,oddsX:3.5,odds2:2.74}});
  assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
  const r=evaluate(d,{asOf:at});assert.equal(r.distributions.HAD.modelLeader,'1');
  assert.equal(option(r,'HAD','2').modelProbability,.281);assert.equal(r.companion,null);
  assert.ok(option(r,'HHAD','2').risks.includes('material-absolute-model-market-gap'));
  assert.equal(option(r,'HHAD','2').researchValueEligible,false);
});
test('nonpositive price EV is excluded even if the prior raw quality passes',()=>{
  const {d}=fixture('negative',{p:{home:36,draw:27.5,away:36.5},line:1,quote:{odds1:2.96,oddsX:2.9,odds2:2.24},hhquote:{odds1:1.48,oddsX:4,odds2:4.9}});
  const c=option(evaluate(d,{asOf:at}),'HHAD','1');
  assert.equal(c.rawQuality.qualified,true);assert.ok(Math.abs(c.modelExpectedValue+.0602)<1e-12);
  assert.ok(c.reasons.includes('nonpositive-model-expected-value'));assert.equal(c.researchValueEligible,false);
  const zero=fixture('zero',{p:{home:50,draw:30,away:20},quote:{odds1:2,oddsX:3.4,odds2:5},handicap:false}).d;
  assert.equal(option(evaluate(zero,{asOf:at}),'HAD','1').modelExpectedValue,0);
  assert.equal(option(evaluate(zero,{asOf:at}),'HAD','1').researchValueEligible,false);
});
test('positive and negative material market deviations are diagnostic risks, never claimed calibrated edges',()=>{
  const {d}=fixture('gap',{p:{home:55,draw:25,away:20},quote:{odds1:3.2,oddsX:3.8,odds2:1.7},handicap:false});
  const r=evaluate(d,{asOf:at});
  for(const code of ['1','2']){const c=option(r,'HAD',code);assert.ok(c.risks.includes('material-absolute-model-market-gap'));assert.equal(c.researchValueEligible,false);}
  assert.equal(option(r,'HAD','1').calibratedProbability,null);assert.equal(option(r,'HAD','1').conservativeProbability,null);
});
test('missing market quote does not borrow the other market price or fake zero probability',()=>{
  const {d}=fixture('missing',{handicap:false}),r=evaluate(d,{asOf:at});
  assert.equal(r.distributions.HHAD.modelProbabilities,null);assert.equal(r.distributions.HHAD.quoteOdds,null);
  for(const c of r.candidates.filter(c=>c.market==='HHAD')){
    assert.equal(c.modelProbability,null);assert.equal(c.odds,null);assert.equal(c.modelExpectedValue,null);
    assert.ok(c.reasons.includes('official-market-quote-unavailable'));assert.equal(c.researchValueEligible,false);
  }
  assert.equal(option(r,'HAD','1').researchValueEligible,true);
});
test('current quote cutoff is exact to a nanosecond; malformed or future evaluation clocks fail closed',()=>{
  const {d}=fixture('clock');
  assert.equal(option(evaluate(d,{asOf:'2026-10-05T10:15:00.000000000Z'}),'HAD','1').researchValueEligible,true);
  const late=option(evaluate(d,{asOf:'2026-10-05T10:15:00.000000001Z'}),'HAD','1');
  assert.ok(late.reasons.includes('quote-stale'));assert.equal(late.researchValueEligible,false);
  const future=evaluate(d,{asOf:'2026-10-05T09:59:59.999999999Z'});
  assert.ok(future.reasons.includes('frozen-input-after-evaluation'));assert.equal(future.eligibleCandidates.length,0);
  for(const clock of [undefined,NaN,Number.MAX_SAFE_INTEGER,'2026-02-30T10:00:00Z','2026-10-05T10:00:00']){
    const r=evaluate(d,{asOf:clock});assert.ok(r.reasons.includes('evaluation-clock-invalid'));assert.equal(r.eligibleCandidates.length,0);
  }
});
test('after-cutoff observations retain diagnostics but cannot become current value candidates',()=>{
  const {d}=fixture('closed'),r=evaluate(d,{asOf:d.cutoffTime});
  assert.ok(r.reasons.includes('after-cutoff'));assert.equal(r.selectionStatus,'unavailable');assert.equal(r.eligibleCandidates.length,0);
  assert.equal(r.distributions.HAD.modelProbabilities['1'],d.probabilities['1']);
});
test('market/time/hash tampering never produces admissible candidates',()=>{
  const {d}=fixture('tamper');
  for(const mutate of [x=>{x.quoteSource='third-party';},x=>{x.handicapAnalysis.marketReference.handicapLine=1;},x=>{x.quoteOdds['1']=1.95;},x=>{x.probabilities['1']=.99;}]){
    const changed=structuredClone(d);mutate(changed);const r=evaluate(changed,{asOf:at});
    assert.ok(r.reasons.includes('frozen-decision-invalid'));assert.equal(r.eligibleCandidates.length,0);
    assert.equal(r.candidates.length,6);assert.equal(r.distributions.HAD.modelProbabilities,null);
  }
});
test('sparse verified arithmetic remains insufficient independent of apparent positive EV',()=>{
  const {d}=fixture('sparse',{sparse:true}),r=evaluate(d,{asOf:at});
  assert.equal(r.eligibleCandidates.length,0);assert.ok(option(r,'HAD','1').reasons.includes('team-samples-insufficient'));
});
test('caller supplied calibration declarations cannot authorize formal recommendations or invent a lower bound',()=>{
  const {d}=fixture('calibration');
  for(const calibrationEvidence of [null,{status:'validated',passed:true,promoted:true,formalEligible:true,sampleRows:9999,winningWindows:6,conservativeProbability:.99}]){
    const r=evaluate(d,{asOf:at,calibrationEvidence});assert.equal(r.formalEligible,false);assert.equal(r.primary,null);
    assert.equal(r.calibration.trainingPerformed,false);assert.equal(r.calibration.formalAdapter,'not-integrated');
    assert.equal(r.calibration.status,calibrationEvidence?'unverified':'unavailable');
    assert.ok(r.candidates.every(c=>c.formalEligible===false&&c.conservativeProbability===null&&c.conservativeExpectedValue===null));
  }
});
test('margin intersections distinguish actual event contradictions from HAD companion differences',()=>{
  const e=(market,tipCode,handicapLine)=>({market,tipCode,handicapLine});
  assert.equal(eventsConflict(e('HAD','X',0),e('HHAD','2',-1)),false);
  assert.equal(eventsConflict(e('HAD','1',0),e('HHAD','2',-1)),true);
  assert.equal(eventsConflict(e('HAD','1',0),e('HHAD','2',-2)),false);
  assert.equal(eventsConflict(e('HAD','X',0),e('HHAD','1',1)),false);
  assert.equal(eventsConflict(e('HAD','2',0),e('HHAD','1',1)),true);
  assert.equal(eventsConflict(e('HAD','1',0),e('HHAD','2',0)),null);
});
test('unverified old references are diagnostic only; original content-bound references use actual event intersection',()=>{
  const {match,d}=fixture('reference');
  match.predictions=[{marketType:'BEST',recommendationAction:'reference',oddsPoolCode:'HAD',tipCode:'X',odds:4}];
  match.predictionMeta={decisionGeneratedAt:new Date(at).toISOString(),decisionId:'synthetic-reference',modelVersion:match.probabilityModel.version,
    policyVersion:'synthetic-reference-v1',featureSnapshot:{sourceMatchId:match.sourceMatchId,kickoffTime:match.kickoffTime,capturedAt:new Date(at-1).toISOString()}};
  const target=bindPublicReferenceDecision(match,null,new Date(at+500).toISOString());
  const original=pendingPublicReferenceEvidence(target);assert.ok(original);
  const diagnostic=evaluate(d,{asOf:at+1000,referenceMatch:target});
  assert.equal(diagnostic.referenceDiagnostic.status,'unverified');assert.equal(option(diagnostic,'HAD','1').researchValueEligible,true);
  assert.equal(option(diagnostic,'HHAD','2').referenceConflict.structuralConflict,false);
  const checked=evaluate(d,{asOf:at+1000,referenceMatch:target,referenceEvidence:original});
  assert.equal(checked.referenceDiagnostic.status,'content-verified');assert.equal(checked.referenceDiagnostic.sourceVerified,false);
  assert.equal(option(checked,'HAD','1').referenceConflict.blocking,true);
  assert.equal(option(checked,'HHAD','2').referenceConflict.blocking,false);
  const altered=structuredClone(original);altered.evidence.probabilityModel.oneXTwo.final.home=99;
  assert.equal(evaluate(d,{asOf:at+1000,referenceMatch:target,referenceEvidence:altered}).referenceDiagnostic.status,'unverified');
});
test('legacy assessment and frozen bytes are unchanged; raw quality is an exact accessor',()=>{
  for(const legacy of [true,false]){
    const {d}=fixture(`legacy-${legacy}`,{legacy}),before=hash(d),quality=selectionQuality(d);
    assert.deepEqual(rawSelectionQuality(d),quality);evaluate(d,{asOf:at});assert.deepEqual(selectionQuality(d),quality);assert.equal(hash(d),before);
  }
});

const onlinePath=path.resolve(__dirname,'../outputs/recommendation-refresh-20261005/online-current-2140.json');
test('explicit 21:43 production export replay: 7 valid frozen records, 42 independent options, no formal promotion',
  {skip:!fs.existsSync(onlinePath)},()=>{
    const input=JSON.parse(fs.readFileSync(onlinePath,'utf8'));
    assert.equal(input.version,'online-current-2140-readonly-v1');assert.equal(input.productionWrites,0);
    const decisions=input.postgres.latestDecisions;assert.equal(decisions.length,7);
    const before=hash(decisions),reports=decisions.map(d=>evaluate(d,{asOf:input.postgres.observedAt,
      referenceMatch:input.postgres.matches.find(m=>String(m.sourceMatchId)===d.sourceMatchId)}));
    assert.ok(decisions.every(validDecision));assert.equal(hash(decisions),before);
    assert.equal(reports.flatMap(r=>r.candidates).length,42);assert.ok(reports.every(r=>r.formalEligible===false&&r.primary===null&&r.companion===null));
    assert.ok(reports.every((r,i)=>verify(r,decisions[i],{asOf:input.postgres.observedAt,referenceMatch:input.postgres.matches.find(m=>String(m.sourceMatchId)===decisions[i].sourceMatchId)})));
    const france=reports.find(r=>r.sourceMatchId==='2041806');assert.equal(france.distributions.HAD.modelLeader,'1');assert.equal(france.distributions.HAD.modelProbabilities['1'],.455);
    const bosnia=reports.find(r=>r.sourceMatchId==='2041811');assert.ok(option(bosnia,'HHAD','1').reasons.includes('nonpositive-model-expected-value'));
    assert.equal(reports.flatMap(r=>r.eligibleCandidates).length,0);
  });
