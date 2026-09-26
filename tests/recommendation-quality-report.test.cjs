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

test('frozen SP and model-price groups partition the same settled events and retain paired scoring and unit returns',()=>{
 const price=(id,odds,actual='1',other={oddsX:3.6,odds2:4.4})=>row(id,0,actual,{odds:{odds1:odds,...other}});
 const selected=[
  price(11,1.45),
  price(12,1.70,'2'),
  price(13,2.05,'1',{oddsX:2,odds2:4.4}),
  price(14,2.60,'X',{oddsX:2.60,odds2:4.4}),
  price(15,2.61),
 ];
 const pending=price(16,1.30);pending.settlement={state:'PENDING'};
 const report=buildQualityReport([...selected,structuredClone(selected[0]),pending],{asOf:now+86400000});
 assert.equal(report.overall.settled,5);
 assert.equal(report.exclusions.unsettled,1);
 assert.deepEqual(Object.values(report.bySpBucket).map(group=>group.settled),[1,1,1,1,1]);
 assert.deepEqual(Object.values(report.byModelPriceSignal).map(group=>group.settled),[2,3]);
 assert.equal(report.bySpBucket.sp_gt_1_70_le_2_05.won,1);
 assert.equal(report.byModelPriceSignal.negative.won,1);
 assert.equal(report.byModelPriceSignal.nonnegative.won,2);
 assert.equal(report.overall.pricedRows,report.overall.settled);
 assert(Math.abs(report.overall.flatStakeNetUnits-1.11)<1e-12);
 assert(Math.abs(report.overall.flatStakeRoi-.222)<1e-12);
 for(const groups of [report.bySpBucket,report.byModelPriceSignal]){
  assert.equal(Object.values(groups).reduce((total,group)=>total+group.settled,0),report.overall.settled);
  assert.equal(Object.values(groups).reduce((total,group)=>total+group.won,0),report.overall.won);
  assert(Math.abs(Object.values(groups).reduce((total,group)=>total+(group.flatStakeNetUnits||0),0)-report.overall.flatStakeNetUnits)<1e-12);
  assert(Math.abs(Object.values(groups).reduce((total,group)=>total+(group.brier||0)*group.settled,0)/report.overall.settled-report.overall.brier)<1e-12);
  assert(Math.abs(Object.values(groups).reduce((total,group)=>total+(group.marketBrier||0)*group.settled,0)/report.overall.settled-report.overall.marketBrier)<1e-12);
 }
 const empty=buildQualityReport([],{asOf:now+86400000});
 assert.equal(empty.bySpBucket.sp_le_1_45.flatStakeNetUnits,null);
 assert.equal(empty.byModelPriceSignal.nonnegative.flatStakeRoi,null);
 assert.equal(empty.preliminaryEvidenceSufficient,false);
 assert.equal(empty.formalPromotion,false);
});

function datedRow(id,date,actual='1',version='model-v76'){
 const at=Date.parse(date+'T02:00:00Z');
 return row(id,at-now,actual,{businessDate:date,kickoffTime:date+'T10:00:00Z',eventVersion:date+'T10:00:00Z',
  probabilityModel:{version,generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}}});
}
function changedDecision(source,patch){
 const result=structuredClone(source);Object.assign(result.decision,patch);
 const {recordHash,...body}=result.decision;
 result.decision.recordHash=require('../src/services/publishedForecastPolicy.cjs').hash(body);
 return result;
}
test('65 percent target separates model versions, keeps final publications once and excludes other statistics tracks',()=>{
 const older=row(301),newer=row(301,60000,'2',{probabilityModel:{version:'model-v76',generatedAt:new Date(now+60000).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}}});
 const oldModel=row(302),research=changedDecision(row(303),{statisticsTrack:'dual-choice-research'});
 const unpublished=changedDecision(row(304),{publicationStatus:'RESEARCH'});
 const legacy=changedDecision(row(305),{upstreamModelVersion:'unknown'});
 const r=buildQualityReport([older,newer,structuredClone(newer),oldModel,research,unpublished,legacy],{asOf:now+86400000});
 const target=r.hitRateTarget,groups=Object.fromEntries(target.byModelVersion.map(group=>[group.modelVersion,group]));
 assert.equal(groups['model-v76'].overall.settled,1);assert.equal(groups['model-v76'].overall.won,0);
 assert.equal(groups.test.overall.settled,1);assert.equal(groups.test.overall.won,1);
 assert.equal(target.exclusions.notPublishedHadSingle,2);assert.equal(target.exclusions.missingModelVersion,1);
 assert.equal(target.targetHitRate,.65);assert.equal(target.formalPromotion,false);assert.equal(r.formalPromotion,false);
 assert.equal(target.thresholdScope,'observational-target-only-not-formal-promotion');
});
test('target windows use strict inclusive Beijing business dates, not rolling hours or kickoff dates',()=>{
 const asOf=Date.parse('2026-10-01T16:00:00Z'); // Beijing October 2; UTC remains October 1.
 const rows=[datedRow(311,'2026-10-02'),datedRow(312,'2026-09-26'),datedRow(313,'2026-09-25'),
  datedRow(314,'2026-09-03'),datedRow(315,'2026-09-02')];
 const malformed=changedDecision(datedRow(316,'2026-09-29'),{businessDate:'2026-09-31'});
 const future=changedDecision(datedRow(317,'2026-09-29'),{businessDate:'2026-10-03'});
 // This already-published row belongs to October 2 even though its kickoff
 // is later; an asserted early score must not count before kickoff.
 const publishedToday=changedDecision(datedRow(318,'2026-10-01'),{businessDate:'2026-10-02'});
 const r=buildQualityReport([...rows,malformed,future,publishedToday],{asOf}).hitRateTarget;
 const group=r.byModelVersion[0];
 assert.equal(r.asOfBusinessDate,'2026-10-02');assert.equal(r.exclusions.futurePublications,1);
 assert.equal(r.exclusions.invalidBusinessDate,1);assert.equal(r.exclusions.futureBusinessDate,1);
 assert.equal(group.windows.last7.from,'2026-09-26');assert.equal(group.windows.last7.through,'2026-10-02');
 assert.equal(group.windows.last7.settled,2);assert.equal(group.windows.last30.from,'2026-09-03');
 assert.equal(group.windows.last30.settled,4);assert.equal(group.overall.settled,5);
 const again=buildQualityReport([...rows,malformed,future,publishedToday],{asOf}).hitRateTarget;
 assert.deepEqual(r,again);
});
test('a 65 percent estimate is not sufficient evidence; enough independent days and a supporting confidence interval are required',()=>{
 const cohort=(won)=>Array.from({length:100},(_,i)=>datedRow(400+i,`2026-09-${String(20+i%7).padStart(2,'0')}`,i<won?'1':'2'));
 const options={asOf:Date.parse('2026-09-26T14:00:00Z')};
 const r=buildQualityReport(cohort(65),options).hitRateTarget.byModelVersion[0].windows.last7;
 assert.equal(r.settled,100);assert.equal(r.won,65);assert.equal(r.hitRate,.65);
 assert.equal(r.independentMatchDays,7);assert.equal(r.numericTargetReached,true);assert.equal(r.sampleSufficient,true);
 assert.equal(r.evidenceSufficient,false);assert(r.blockers.includes('confidence-lower-bound-below-target'));
 const strong=buildQualityReport(cohort(90),options).hitRateTarget.byModelVersion[0].windows.last7;
 assert.equal(strong.numericTargetReached,true);assert.equal(strong.evidenceSufficient,true);
 const concentrated=buildQualityReport(Array.from({length:100},(_,i)=>datedRow(600+i,'2026-09-26')),options).hitRateTarget.byModelVersion[0].overall;
 assert.equal(concentrated.hitRate,1);assert.equal(concentrated.sampleSufficient,false);assert.equal(concentrated.evidenceSufficient,false);
 assert(concentrated.blockers.includes('insufficient-independent-match-days'));
});
test('pending old business days are visible without becoming losses and empty new-version windows stay null',()=>{
 const dates=['2026-09-18','2026-09-18','2026-09-19'];
 const pending=dates.map((date,i)=>{const r=datedRow(710+i,date);r.settlement={state:'PENDING'};return r;});
 const voided=datedRow(714,'2026-09-19');voided.settlement={state:'VOID'};
 const disputed=datedRow(715,'2026-09-19');disputed.settlement={state:'DISPUTED'};
 const asOf=Date.parse('2026-09-26T03:00:00Z'),today=datedRow(716,'2026-09-26');today.settlement={state:'PENDING'};
 const impossible=datedRow(717,'2026-09-26'); // Claimed result before kickoff is excluded.
 const group=buildQualityReport([...pending,voided,disputed,today,impossible],{asOf}).hitRateTarget.byModelVersion[0];
 assert.equal(group.overall.published,7);assert.equal(group.overall.pending,4);
 assert.equal(group.overall.pendingFromPastBusinessDays,3);assert.equal(group.overall.pendingPastBusinessDays,2);
 assert.equal(group.overall.void,1);assert.equal(group.overall.disputed,1);assert.equal(group.overall.excludedSettlements,1);
 for(const value of [group.overall,group.windows.last7,group.windows.last30]){
  assert.equal(value.settled,0);assert.equal(value.hitRate,null);assert.equal(value.numericTargetReached,null);
  assert.equal(value.sampleSufficient,false);assert.equal(value.evidenceSufficient,false);
  assert.equal(value.marketComparison.modelHitRate,null);assert.equal(value.marketComparison.marketHitRate,null);
 }
 assert.equal(group.windows.last7.pending,1);assert.equal(group.windows.last7.pendingFromPastBusinessDays,0);
 assert.deepEqual(buildQualityReport([],{asOf}).hitRateTarget.byModelVersion,[]);
});
test('target model and market hit rates compare the same unique-market subset while preserving all HAD outcomes',()=>{
 const win=row(801),loss=row(802,0,'2');
 const tie=changedDecision(row(803),{marketProbabilities:{'1':.4,X:.4,'2':.2}});
 const group=buildQualityReport([win,loss,tie],{asOf:now+86400000}).hitRateTarget.byModelVersion[0].overall;
 assert.equal(group.settled,3);assert.equal(group.hitRate,2/3);
 assert.deepEqual(group.marketComparison,{settled:2,modelWins:1,modelHitRate:.5,marketWins:1,marketHitRate:.5,hitRateDifference:0,excludedMarketTies:1});
});
