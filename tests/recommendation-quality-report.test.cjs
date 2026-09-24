'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildQualityReport,measure}=require('../scripts/recommendationPlatform/qualityReport.cjs');
const now=Date.parse('2026-09-18T02:00:00Z');
function row(id,offset=0,actual='1',patch={}){
 const at=now+offset,d=makeDecision({id:'sporttery_'+id,sourceMatchId:String(id),homeTeamId:'h'+id,awayTeamId:'a'+id,homeTeamName:'H',awayTeamName:'A',status:'SCHEDULED',businessDate:'2026-09-18',kickoffTime:'2026-09-18T10:00:00Z',eventVersion:'2026-09-18T10:00:00Z',odds:{odds1:1.8,oddsX:3.6,odds2:4.4},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(at).toISOString(),probabilityModel:{version:'test',generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},...patch},{now:at,publication:{generationId:'test',manifestHash:'a'.repeat(64)}}).decision;
 assert(d);return{decision:d,settlement:{state:actual===d.tipCode?'WON':'LOST',actual,score:actual==='1'?'1-0':actual==='X'?'0-0':'0-1',resultEventId:'result_'+id}};
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
 assert.equal(r.evaluationCoverage.settledEvents,0);assert.equal(r.byTipCode['1'].hitRate,null);assert.equal(r.byLeaderAgreement.agree.coverage.share,null);
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

test('frozen tip and market-leader cohorts use one settled denominator with paired model and market metrics',()=>{
 const drawModel={probabilityModel:{version:'test',generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:25,draw:55,away:20}}}};
 const awayModel={probabilityModel:{version:'test',generatedAt:new Date(now+86400000).toISOString(),oneXTwo:{final:{home:20,draw:25,away:55}}},odds:{odds1:4,oddsX:3.2,odds2:1.9}};
 const nextDay={businessDate:'2026-09-19',kickoffTime:'2026-09-19T10:00:00Z',eventVersion:'2026-09-19T10:00:00Z'};
 const agreeHome=row(1,0,'1'),disagreeDraw=row(2,0,'1',drawModel);
 const agreeAway=row(3,86400000,'2',{...nextDay,...awayModel});
 const tiedMarket=row(4,86400000,'X',{...nextDay,odds:{odds1:2.2,oddsX:2.2,odds2:4.4}});
 const pending=row(5,86400000,'1',nextDay);pending.settlement={state:'PENDING'};
 assert.equal(disagreeDraw.decision.tipCode,'X');assert.equal(agreeAway.decision.tipCode,'2');
 const report=buildQualityReport([agreeHome,disagreeDraw,agreeAway,tiedMarket,pending],{asOf:now+2*86400000});
 assert.equal(report.version,'frozen-quality-review-v1');
 assert.equal(report.formalPromotion,false);assert.equal(report.preliminaryEvidenceSufficient,false);
 assert.deepEqual(report.evaluationCoverage,{inputRows:5,distinctPublishedEvents:5,settledEvents:4,settledShareOfPublishedEvents:.8,fixtureCoverage:null,scope:'supplied-frozen-publication-ledger-only'});
 assert.equal(report.independentMatchDays,2);assert.equal(report.exclusions.unsettled,1);
 assert.deepEqual(['1','X','2'].map(code=>report.byTipCode[code].settled),[2,1,1]);
 assert.deepEqual(['agree','disagree','market-tied'].map(group=>report.byLeaderAgreement[group].settled),[2,1,1]);
 assert.equal(report.byLeaderAgreement.agree.independentMatchDays,2);
 assert.equal(report.byLeaderAgreement.disagree.independentMatchDays,1);
 assert.equal(report.byLeaderAgreement.agree.coverage.share,.5);
 assert.equal(report.byLeaderAgreement['market-tied'].marketTopHitRate,null);
 assert.equal(report.byLeaderAgreement['market-tied'].marketTied,1);
 for(const [name,rows] of [['agree',[agreeHome,agreeAway]],['disagree',[disagreeDraw]],['market-tied',[tiedMarket]]]){
  const expected=measure(rows),actual=report.byLeaderAgreement[name];
  for(const metric of ['won','marketTopWins','brier','marketBrier','logLoss','marketLogLoss'])assert.equal(actual[metric],expected[metric]);
 }
 for(const [code,rows] of [['1',[agreeHome,tiedMarket]],['X',[disagreeDraw]],['2',[agreeAway]]]){
  const expected=measure(rows),actual=report.byTipCode[code];
  for(const metric of ['won','marketTopWins','brier','marketBrier','logLoss','marketLogLoss'])assert.equal(actual[metric],expected[metric]);
 }
 for(const metric of ['brier','marketBrier','logLoss','marketLogLoss']){
  const weighted=Object.values(report.byLeaderAgreement).reduce((sum,group)=>sum+group[metric]*group.settled,0)/report.overall.settled;
  assert(Math.abs(weighted-report.overall[metric])<1e-12);
 }
});
