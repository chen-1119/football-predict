'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {hash}=require('../scripts/collectLeagueTextHistory.cjs');
const {experiment}=require('../scripts/runLeagueBaselineExperiment.cjs');
const {inspect}=require('../scripts/prepareLeagueModelRegistration.cjs');
const seal=body=>({...body,contentHash:hash(JSON.stringify(body))});
function fixture(){
  const history=seal({rows:[{id:'one',league:'fi1',date:'2023-04-01',home:'A',away:'B',homeGoals:1,awayGoals:0}]});
  const input=Buffer.from(JSON.stringify(history));
  const report={...experiment(history.rows),inputSha256:hash(input),historyContentHash:history.contentHash,
    completedAt:'2026-10-08T14:00:00.000Z',
    implementationSha256:hash(fs.readFileSync(require.resolve('../scripts/runLeagueBaselineExperiment.cjs'))),
    parserSha256:hash(fs.readFileSync(require.resolve('../scripts/collectLeagueTextHistory.cjs')))};
  return {input,report};
}
const inspectReport=(input,report)=>inspect(input,Buffer.from(JSON.stringify(seal(report))),'2026-10-08T14:30:00.000Z');
test('replayed research report stays unregistered and cannot pass the existing V3 loader',()=>{
  const {input,report}=fixture(),r=inspectReport(input,report);
  assert.equal(r.researchFitReplayed,true);assert.equal(r.trainingVerifier.accepted,false);
  assert.equal(r.existingLoader.accepted,false);assert.equal(r.readyToRegister,false);
  assert.equal(r.registrationCommand,null);assert.equal(r.productionWrites,0);
});
test('resealing modified evaluation cannot substitute for a fit replay',()=>{
  const {input,report}=fixture();report.reports[0].statisticalGatePassed=true;
  assert.throws(()=>inspectReport(input,report),/FIT_REPLAY/);
});
test('changed implementation or input commitments fail',()=>{
  for(const key of ['implementationSha256','inputSha256']){
    const {input,report}=fixture();report[key]='0'.repeat(64);
    assert.throws(()=>inspectReport(input,report),/IMPLEMENTATION|INPUT_BINDING/);
  }
});
test('unsealed or oversized input fails before fitting',()=>{
  const {input,report}=fixture();assert.throws(()=>inspect(input,Buffer.from(JSON.stringify(report))),/INPUT_BINDING/);
  assert.throws(()=>inspect(Buffer.alloc(16*1024*1024+1),Buffer.from('{}')),/OVERSIZED/);
});
