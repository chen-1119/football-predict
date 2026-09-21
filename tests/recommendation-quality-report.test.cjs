'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildQualityReport,measure}=require('../scripts/recommendationPlatform/qualityReport.cjs');
const now=Date.parse('2026-09-18T02:00:00Z');
function row(id,offset=0,actual='1',patch={}){
 const at=now+offset,d=makeDecision({id:'sporttery_'+id,sourceMatchId:String(id),homeTeamId:'h'+id,awayTeamId:'a'+id,homeTeamName:'H',awayTeamName:'A',status:'SCHEDULED',businessDate:'2026-09-18',kickoffTime:'2026-09-18T10:00:00Z',eventVersion:'2026-09-18T10:00:00Z',odds:{odds1:1.8,oddsX:3.6,odds2:4.4},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(at).toISOString(),probabilityModel:{version:'test',generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},...patch},{now:at,publication:{generationId:'test',manifestHash:'a'.repeat(64)}}).decision;
 assert(d);return{decision:d,settlement:{state:actual==='1'?'WON':'LOST',actual,score:actual==='1'?'1-0':'0-1',resultEventId:'result_'+id}};
}
test('repeated quote versions count once and latest pre-cutoff decision wins',()=>{
 const report=buildQualityReport([row(1),row(1,60000),row(2,0,'2')],{asOf:now+86400000});
 assert.equal(report.overall.settled,2);assert.equal(report.overall.won,1);assert.equal(report.independentMatchDays,1);assert.equal(report.formalPromotion,false);assert(report.blockers.includes('insufficient-independent-match-days'));
});
test('pending, future and tampered decisions cannot improve the reported rate',()=>{
 const bad=row(3);bad.decision={...bad.decision,tipCode:'2'};
 const pending=row(2);pending.settlement={state:'PENDING'};
 const r=buildQualityReport([row(1),bad,pending],{asOf:now+86400000});assert.equal(r.overall.settled,1);assert.equal(r.exclusions.invalid,1);assert.equal(r.exclusions.unsettled,1);
 const early=buildQualityReport([row(1)],{asOf:now+1000});assert.equal(early.overall.settled,0);assert.equal(early.exclusions.future,1);
});
test('mismatched settled outcome is rejected and empty groups do not report zero accuracy',()=>{
 const wrong=row(1);wrong.settlement.state='LOST';const r=buildQualityReport([wrong],{asOf:now+86400000});assert.equal(r.exclusions.resultMismatch,1);assert.equal(r.overall.hitRate,null);assert.equal(r.overall.hitRateInterval95,null);assert.equal(r.formalPromotion,false);
});
test('market probability ties are reported separately rather than arbitrarily counted as home picks',()=>{
 const tie=row(1),unique=row(2);tie.decision={...tie.decision,marketProbabilities:{'1':.4,X:.4,'2':.2}};
 const r=measure([tie,unique]);assert.equal(r.settled,2);assert.equal(r.marketTied,1);assert.equal(r.marketUniqueTopSettled,1);assert.equal(r.marketTopHitRate,1);assert(Number.isFinite(r.marketBrier));
});

test('identical latest rows merge while conflicting results are excluded regardless of input order',()=>{
 const a=row(1),copy=structuredClone(a),other=row(1,0,'2'),options={asOf:now+86400000};
 const duplicate=buildQualityReport([a,copy],options);assert.equal(duplicate.overall.settled,1);assert.equal(duplicate.exclusions.ambiguous,0);
 const forward=buildQualityReport([a,copy,other],options),reverse=buildQualityReport([other,copy,a],options);
 assert.deepEqual(forward,reverse);assert.equal(forward.overall.settled,0);assert.equal(forward.exclusions.ambiguous,1);
});

test('different decisions at the same latest time are ambiguous even with identical outcomes',()=>{
 const a=row(1),b=row(1,0,'1',{odds:{odds1:1.9,oddsX:3.6,odds2:4.4}}),options={asOf:now+86400000};
 assert.notEqual(a.decision.decisionId,b.decision.decisionId);
 const forward=buildQualityReport([a,b],options),reverse=buildQualityReport([b,a],options);
 assert.deepEqual(forward,reverse);assert.equal(forward.overall.settled,0);assert.equal(forward.exclusions.ambiguous,1);
});

test('a newer publication supersedes earlier ambiguity independent of array ordering',()=>{
 const a=row(1),conflict=row(1,0,'2'),later=row(1,60000,'2'),options={asOf:now+86400000};
 const forward=buildQualityReport([a,conflict,later],options),reverse=buildQualityReport([later,conflict,a],options);
 assert.deepEqual(forward,reverse);assert.equal(forward.exclusions.ambiguous,0);assert.equal(forward.overall.settled,1);assert.equal(forward.overall.won,0);
});
