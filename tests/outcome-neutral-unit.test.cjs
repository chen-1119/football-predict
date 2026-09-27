'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const {VERSION,uniquePrimary,leaderReasons}=require('../src/services/primaryDirectionAdmission.cjs');
const {auditRecommendationBias,probabilitySignature,marketLeaderCode}=require('../scripts/auditRecommendationBatchBias.cjs');
const {auditRows}=require('../scripts/auditOutcomeSelection.cjs');
test('all three outcomes can be unique leaders even below a six-point margin',()=>{
 for(const code of ['1','X','2']){const p={'1':.32,X:.32,'2':.32};p[code]=.36;
 assert.equal(uniquePrimary(p),code);assert.deepEqual(leaderReasons({primaryAdmissionVersion:VERSION,probabilityLead:.04}),[]);}
});
test('exact ties, missing data and nonfinite values never create a leader',()=>{
 for(const p of [{'1':.4,X:.4,'2':.2},{'1':null,X:.5,'2':.5},{'1':.34,X:.33,'2':NaN},{'1':2,X:1,'2':0}])assert.equal(uniquePrimary(p),null);
 assert.deepEqual(leaderReasons({primaryAdmissionVersion:VERSION,probabilityLead:0}),['no-unique-model-leader']);
 assert.equal(leaderReasons({probabilityLead:.04}),null);
});
const row=(i,tip,marketTip=tip)=>{
 const p={home:.2+i*.006,draw:.2,away:.6-i*.006};
 if(tip==='1'){p.home=.6-i*.006;p.away=.2+i*.006;}
 return {id:'sporttery_'+i,status:'SCHEDULED',kickoffTime:'2026-09-27T15:00:00Z',predictions:[{marketType:'BEST',tipCode:tip}],
 probabilityModel:{oneXTwo:{final:p},elo:{homeMatches:20,awayMatches:20}},odds:{odds1:marketTip==='1'?1.8:4,oddsX:3.4,odds2:marketTip==='2'?1.8:4}};
};
const now=Date.parse('2026-09-27T05:00:00Z');
test('100pct market copying across mixed home-away leaders triggers review without force-balancing',()=>{
 const report=auditRecommendationBias(Array.from({length:10},(_,i)=>row(i,i%2?'1':'2')),{nowMs:now});
 assert.equal(report.directionTriggered,false);assert.equal(report.marketLeaderAgreementTriggered,true);assert.equal(report.triggered,true);
 assert.equal(report.cause,'market-copy-cluster-requires-review');assert.equal(report.publicationBlocked,false);
});
test('contrarian batches with distinct probabilities and adequate samples are not blocked solely for market disagreement',()=>{
 const report=auditRecommendationBias(Array.from({length:10},(_,i)=>row(i,'2','1')),{nowMs:now});
 assert.equal(report.dominantMarketConflictTriggered,true);assert.equal(report.publicationBlocked,false);
});
test('actual cold-start degeneracy is still blocked',()=>{
 const rows=Array.from({length:10},(_,i)=>row(i,'2','1'));for(const r of rows)delete r.probabilityModel.elo;
 assert.equal(auditRecommendationBias(rows,{nowMs:now}).publicationBlocked,true);
});
test('empty audits are not reported as healthy home-dominant slates',()=>{
 const report=auditRecommendationBias([],{nowMs:now});assert.equal(report.dominantCode,null);assert.equal(report.cause,'no-exposed-best-records');
});
test('nulls do not fabricate probability signatures and tied SP does not assign home by array order',()=>{
 assert.equal(probabilitySignature({probabilityModel:{oneXTwo:{final:{home:null,draw:.4,away:.6}}}}),null);
 assert.equal(marketLeaderCode({odds:{odds1:2.5,oddsX:3,odds2:2.5}}),null);
});
test('source audit covers every model row even when legacy BEST is absent',()=>{
 const rows=[row(1,'1'),row(2,'2','1')];rows[0].predictions=[];rows[0].probabilityModel.oneXTwo.final={home:.32,draw:.37,away:.31};
 const before=JSON.stringify(rows),r=auditRows(rows);assert.equal(r.inputRows,2);assert.equal(r.stages.finalModel.X,1);assert.equal(r.primary.nonfavorite,1);
 assert.equal(r.stages.exposedBest.missing,1);assert.equal(JSON.stringify(rows),before);
});
