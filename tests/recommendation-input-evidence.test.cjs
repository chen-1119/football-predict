'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {buildInputEvidence,validInputEvidence}=require('../src/services/recommendationInputEvidence.cjs');
const {attachProspectiveForecastInputs,forecastInputFor}=require('../src/services/prospectiveForecastInput.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const now=Date.parse('2026-09-22T07:01:00Z');
const match={id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-22',eventVersion:'2026-09-22T10:00:00Z',kickoffTime:'2026-09-22T10:00:00Z',buyEndTime:'2026-09-22T09:50:00Z',status:'SCHEDULED',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',probabilityModel:{version:'test-v1',generatedAt:'2026-09-22T07:00:00Z',oneXTwo:{final:{home:50,draw:30,away:20}}}};
const fixture=options=>withVerifiedInputEvidence(match,options);
const resignReceipt=receipt=>{const {contentHash,...body}=receipt;return{...body,contentHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};};
test('actual arithmetic is carried with exact model binding and source truth remains unverified',()=>{
 const m=fixture(),before=JSON.stringify(m),e=buildInputEvidence(m.probabilityModel,m);
 assert.equal(e.arithmetic.status,'verified');assert.equal(e.arithmetic.sourceVerified,false);assert.equal(e.arithmetic.scope,'base-calculation-only');assert.equal(e.weights.elo,.3);assert.equal(e.weights.form,0);assert.deepEqual(e.samples,{elo:{home:12,away:12},form:{home:0,away:0}});
 assert.deepEqual(e.final,m.probabilityModel.oneXTwo.final);assert.equal(e.modelGeneratedAt,m.probabilityModel.generatedAt);assert.equal(validInputEvidence(e,m.probabilityModel,m),true);assert.equal(JSON.stringify(m),before);
});
test('form-only samples are retained separately from the base outcome weights',()=>{
 const m=fixture({eloHome:0,eloAway:0,formHome:9,formAway:8,formWeight:.336,weights:{elo:0,poisson:.64,teamStrength:.24,market:.12}}),e=m.probabilityModel.inputEvidence;
 assert.equal(e.arithmetic.status,'verified');assert.equal(e.weights.elo,0);assert.equal(e.weights.form,.336);assert.equal(e.samples.form.away,8);
});
test('missing receipts, clocks and samples remain unknown and are not inferred from defaults',()=>{
 const e=buildInputEvidence(match.probabilityModel,match);assert.equal(e.arithmetic.status,'unknown');assert.equal(e.samples.elo.home,null);assert.equal(e.weights.elo,null);assert(e.issues.includes('arithmetic-receipts-missing'));assert(e.issues.includes('execution-clock-missing'));assert.equal(validInputEvidence(e,match.probabilityModel,match),true);
});
test('altered receipt or altered actual model weights is rejected without manufacturing adoption',()=>{
 for(const edit of [m=>m.probabilityModel.inputUsage[1].weights.elo=.8,m=>m.probabilityModel.ensembleWeights.elo=.8,m=>m.probabilityModel.lambdaBlend.formWeight=.2]){
  const m=fixture();edit(m);const e=buildInputEvidence(m.probabilityModel,m);assert.equal(e.arithmetic.status,'invalid');assert.equal(validInputEvidence(e,m.probabilityModel,m),false);
 }
});
test('a valid receipt hash cannot conceal incorrect arithmetic, identity or generation clock',()=>{
 for(const edit of [r=>r.output.home=.9,r=>r.sourceMatchId='2',r=>r.kickoffTime='2026-09-23T10:00:00Z',r=>r.recordedAt='2026-09-22T07:00:01Z',r=>r.recordedAt='2026-09-21T07:00:00Z']){
  const m=fixture(),r=m.probabilityModel.inputUsage[1];edit(r);m.probabilityModel.inputUsage[1]=resignReceipt(r);const e=buildInputEvidence(m.probabilityModel,m);assert.equal(e.arithmetic.status,'invalid');assert.equal(validInputEvidence(e,m.probabilityModel,m),false);
 }
});
test('evidence cannot cross a source, event, model version, clock or exact final vector',()=>{
 const m=fixture(),e=m.probabilityModel.inputEvidence;
 for(const patch of [{sourceMatchId:'2'},{eventVersion:'2026-09-23T10:00:00Z',kickoffTime:'2026-09-23T10:00:00Z'}])assert.equal(validInputEvidence(e,m.probabilityModel,{...m,...patch}),false);
 for(const patch of [{version:'other-v1'},{generatedAt:'2026-09-22T07:00:01Z'},{oneXTwo:{final:{home:49,draw:31,away:20}}},{oneXTwo:{final:{home:.5,draw:.3,away:.2}}}])assert.equal(validInputEvidence(e,{...m.probabilityModel,...patch},m),false);
 const changed=fixture();changed.probabilityModel.oneXTwo.final.home=51;const invalid=buildInputEvidence(changed.probabilityModel,changed);assert.equal(invalid.arithmetic.status,'invalid');
});
test('prospective compaction carries verifiable evidence and preserves the frozen parent',()=>{
 const fresh=fixture(),parent=fixture();parent.probabilityModel.generatedAt='2026-09-20T07:00:00Z';parent.probabilityModel.oneXTwo.final={home:20,draw:60,away:20};const before=JSON.stringify(parent);
 const [out]=attachProspectiveForecastInputs([parent],[fresh],now),input=out.prospectiveForecastInput;
 assert.equal(validInputEvidence(input.probabilityModel.inputEvidence,input.probabilityModel,input),true);assert.equal(input.probabilityModel.inputEvidence.arithmetic.status,'verified');assert.equal(forecastInputFor(out),input);assert.equal(JSON.stringify(parent),before);assert.deepEqual(out.probabilityModel,parent.probabilityModel);
 input.probabilityModel.inputEvidence.samples.elo.home=999;assert.equal(forecastInputFor(out),null);
});
test('later supplementary data or missing fresh receipts never borrows old parent adoption',()=>{
 const parent=fixture(),fresh=structuredClone(match);fresh.externalSignals={injuries:{home:[{name:'new player'}]}};const before=JSON.stringify(parent);
 const [out]=attachProspectiveForecastInputs([parent],[fresh],now),input=out.prospectiveForecastInput,e=input.probabilityModel.inputEvidence;
 assert.equal(e.arithmetic.status,'unknown');assert.equal(e.samples.elo.home,null);assert.equal(e.weights.elo,null);assert.equal(input.externalSignals,undefined);assert.equal(JSON.stringify(parent),before);
 const legacy={...parent,prospectiveForecastInput:undefined};assert.equal(forecastInputFor(legacy),legacy);
});
test('canonical evidence survives database object-key ordering without changing original receipt hashes',()=>{
 const m=fixture(),[out]=attachProspectiveForecastInputs([m],[m],now),input=out.prospectiveForecastInput;
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(k=>[k,reorder(value[k])])):value;
 const ordered=reorder(input);assert.equal(validInputEvidence(ordered.probabilityModel.inputEvidence,ordered.probabilityModel,ordered),true);
 const full=reorder(m);assert.equal(validInputEvidence(full.probabilityModel.inputEvidence,full.probabilityModel,full),true);
 full.probabilityModel.elo.homeMatches=99;assert.equal(validInputEvidence(full.probabilityModel.inputEvidence,full.probabilityModel,full),false);
});
test('actual prediction generator binds all four evidence availability paths without changing weights',()=>{
 const {predictionSet}=require('../scripts/syncData.cjs');
 const raw={id:'sporttery_generator-fixture',sourceMatchId:'generator-fixture',eventVersion:'2099-09-22T10:00:00Z',kickoffTime:'2099-09-22T10:00:00Z',status:'SCHEDULED',homeTeam:'Synthetic Home',awayTeam:'Synthetic Away',leagueName:'Synthetic League',odds:{odds1:2.1,oddsX:3.4,odds2:3.3},oddsSource:'sporttery:HAD',oddsUpdatedAt:new Date().toISOString(),eloSnapshot:{probabilities:{home:.45,draw:.3,away:.25},homeRating:1550,awayRating:1500,homeMatches:20,awayMatches:20,diff:50,historicalSource:{source:'synthetic-history',version:'v1',signature:'test-only'}},formSnapshot:{sampleSize:24,home:{sampleSize:12,goalsForAvg:1.8,goalsAgainstAvg:1.1,lastMatchAt:'2026-09-01T12:00:00Z'},away:{sampleSize:12,goalsForAvg:1.2,goalsAgainstAvg:1.5,lastMatchAt:'2026-09-01T12:00:00Z'},historicalSource:{source:'synthetic-history',version:'v1',signature:'test-only'}}};
 for(const mode of ['both','elo','form','neither']){
  const row=structuredClone(raw);if(mode==='form'||mode==='neither')delete row.eloSnapshot;if(mode==='elo'||mode==='neither')delete row.formSnapshot;
  const model=predictionSet(row).probabilityModel,before=JSON.stringify(model),e=buildInputEvidence(model,row);
  assert.equal(e.arithmetic.status,'verified',mode);assert.equal(validInputEvidence(e,model,row),true,mode);assert.equal(JSON.stringify(model),before);
  for(const key of ['market','teamStrength','elo','poisson'])assert.equal(e.weights[key],model.ensembleWeights[key]);
  assert.equal(e.samples.elo.home,row.eloSnapshot?20:null);assert.equal(e.samples.form.away,row.formSnapshot?12:null);
  assert.equal(e.arithmetic.sourceVerified,false);
 }
});
