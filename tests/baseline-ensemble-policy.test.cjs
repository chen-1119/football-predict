'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectEnsemblePolicy, validEnsemblePolicy } = require('../src/services/baselineEnsemblePolicy.cjs');
const { verifyModelInputUsage } = require('../src/services/modelInputUsage.cjs');
const select = patch => selectEnsemblePolicy({eloAvailable:true,eloHome:12,eloAway:12,formHome:8,formAway:8,formConfidence:2/3,worldCupPriorAvailable:false,...patch});

test('Elo admission needs six samples on EACH side, not a combined total', () => {
  for (const missing of [0,5,null,undefined,'12',NaN,-1,2.5]) {
    for (const side of ['eloHome','eloAway']) {
      const p=select({[side]:missing});
      assert.equal(p.regime,'form-only');assert.equal(p.weights.elo,0);
    }
  }
  assert.equal(select({eloHome:6,eloAway:6}).regime,'elo-and-form');
  assert.equal(select({eloAvailable:false}).weights.elo,0);
});
test('form admission is paired, and well-supported baseline weights stay unchanged', () => {
  assert.deepEqual(select().weights,{market:.1,teamStrength:.15,elo:.3,poisson:.45,worldCupPrior:0});
  for (const missing of [0,7,null,undefined,'8',NaN]) {
    assert.equal(select({formAway:missing}).regime,'elo-only');
    assert.equal(select({formHome:missing}).regime,'elo-only');
  }
  assert.equal(select({formConfidence:.249}).regime,'elo-only');
  assert.equal(select({eloAvailable:false,formHome:0}).regime,'cold-start');
  for(const patch of [{},{eloAvailable:false},{formHome:0},{eloAvailable:false,formHome:0}]){
    const p=select({...patch,worldCupPriorAvailable:true});
    assert.ok(Math.abs(Object.values(p.weights).reduce((a,b)=>a+b,0)-1)<1e-12);
    assert.equal(p.validation,'unvalidated');assert.equal(p.source,'heuristic-baseline');
    assert.equal(validEnsemblePolicy(p,p.weights),true);
    assert.equal(validEnsemblePolicy({...p,regime:'fitted'},p.weights),false);
  }
});
test('the actual sync blend consumes the policy and archives it in its arithmetic receipt', () => {
  const {predictionSet}=require('../scripts/syncData.cjs');
  const model=predictionSet({sourceMatchId:'policy-test',kickoffTime:'2026-10-01T10:00:00Z',status:'SCHEDULED',
    homeTeam:'Synthetic Home',awayTeam:'Synthetic Away',leagueName:'Synthetic League',
    odds:{odds1:2.1,oddsX:3.4,odds2:3.3},oddsSource:'sporttery:HAD',
    eloSnapshot:{probabilities:{home:.8,draw:.1,away:.1},homeRating:1550,awayRating:1500,homeMatches:30,awayMatches:0,diff:50},
  }).probabilityModel;
  assert.equal(model.version,'unified-poisson-bayes-v76');
  assert.equal(model.baseModelVersion,'independent-elo-form-poisson-v12');
  assert.equal(model.ensembleWeights.elo,0);assert.equal(model.ensemblePolicy.regime,'cold-start');
  const result={usage:model.inputUsage.find(row=>row.stage==='base-outcome-blend')};
  assert.equal(verifyModelInputUsage(result.usage),true);
  const bad=structuredClone(result.usage);bad.ensemblePolicy.samples.elo.away=12;
  const {contentHash,...body}=bad;
  bad.contentHash=require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.equal(verifyModelInputUsage(bad),false,'a rehashed receipt cannot misstate the policy regime');
});
