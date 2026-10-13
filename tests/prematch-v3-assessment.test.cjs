'use strict';
// Synthetic contracts test arithmetic/time/freeze boundaries, not accuracy.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const {buildPrematchV3Assessment:build,verifyPrematchV3Assessment:verify,outcomeProjection,SOURCE_VERSION}=require('../src/services/prematchV3Assessment.cjs');
const {attachProspectiveForecastInputs}=require('../src/services/prospectiveForecastInput.cjs');
const {buildReport}=require('../scripts/runPrematchV3Shadow.cjs');
const at='2026-10-06T10:00:00.000000100Z';
const match={id:'sporttery_123',sourceMatchId:'123',businessDate:'2026-10-06',homeTeamId:'h',awayTeamId:'a',
 status:'SCHEDULED',eventVersion:'2026-10-06T12:00:00Z',kickoffTime:'2026-10-06T12:00:00Z',
 predictionMeta:{cutoffTime:'2026-10-06T11:00:00Z',decisionId:'frozen'},odds:{odds1:2,oddsX:3,odds2:4},
 oddsSource:'synthetic:HAD',oddsObservedAt:'2026-10-06T09:00:00Z',oddsReceivedAt:'2026-10-06T09:01:00Z',
 probabilityModel:{version:'old-unchanged',generatedAt:'2026-10-06T09:30:00Z',ensembleWeights:{market:.15},oneXTwo:{final:{home:50,draw:30,away:20}}}};
test('absent sourced features/parameters do not mint independent predictions from old odds model',()=>{
 const before=structuredClone(match),a=build(match,{asOf:at});
 assert.equal(a.status,'blocked');assert.equal(a.comparisons.teamOnly,null);assert.equal(a.comparisons.hybrid,null);
 assert.equal(a.baseline.baseRates,null);assert.equal(a.formalEligible,false);assert.equal(a.primary,null);
 assert.equal(a.legacyModel.marketWeight,.15);assert.ok(Object.values(a.teamSnapshot.features).every(v=>v===null));assert.deepEqual(match,before);
 assert.ok(verify(a,{match}));assert.equal(verify(a),false,'checksum alone is insufficient');
});
test('market baseline has explicit same-time reference role and rejects same-millisecond future receipt',()=>{
 const a=build(match,{asOf:at});const p=a.comparisons.marketOnly.probabilities;
 assert.ok(Math.abs(p['1']-6/13)<1e-12);assert.match(a.comparisons.marketOnly.role,/not-a-team-prediction/);
 const future={...match,oddsReceivedAt:'2026-10-06T10:00:00.000000101Z'};
 assert.equal(build(future,{asOf:at}).comparisons.marketOnly.available,false);
});
test('rehashing wrong outcome arithmetic or replacing valid team snapshot cannot verify',()=>{
 const a=build(match,{asOf:at}),alter=structuredClone(a);alter.comparisons.marketOnly.probabilities={'1':.99,X:.005,'2':.005};
 const {contentHash,...body}=alter;alter.contentHash=stableHash(body);assert.equal(verify(alter,{match}),false);
 const foreign=build({...match,sourceMatchId:'other',id:'sporttery_other'},{asOf:at});
 const swapped={...a,teamSnapshot:foreign.teamSnapshot};const {contentHash:oldHash,...otherBody}=swapped;
 swapped.contentHash=stableHash(otherBody);assert.equal(verify(swapped,{match}),false);
});
test('cutoff/closed/invalid identity never permit a team forecast; missing sales clock stays unknown',()=>{
 for(const m of [{...match,isOnSale:false},{...match,resultDisposition:'VOID'},
  {...match,eventVersion:'2026-10-06T12:00:00.000000001Z'}, {...match,predictionMeta:{}}, {...match,homeTeamId:'a'}]){
  const a=build(m,{asOf:at});assert.ok(a.blockers.includes('event-or-sale-clock-ineligible'));assert.equal(a.comparisons.teamOnly,null);
 }
 assert.ok(build(match,{asOf:'2026-10-06T11:00:00Z'}).blockers.includes('event-or-sale-clock-ineligible'));
});
test('all explicit source cutoffs constrain analysis and prospective generation',()=>{
 const earlier={...match,cutoffAt:'2026-10-06T09:59:59.999999999Z'};
 const a=build(earlier,{asOf:at});assert.equal(a.event.cutoffAt,earlier.cutoffAt);
 assert.ok(a.blockers.includes('event-or-sale-clock-ineligible'));
 assert.equal(attachProspectiveForecastInputs([earlier],[earlier],Date.parse('2026-10-06T10:00:00Z'))[0].prospectiveForecastInput,null);
 const only={...match,predictionMeta:{},cutoffTime:'2026-10-06T11:00:00Z'};
 assert.equal(build(only,{asOf:at}).event.cutoffAt,only.cutoffTime);
 const conflict={...match,cutoffAt:'2026-10-06T11:00:00Z',cutoffTime:'2026-10-06T10:59:59Z'};
 assert.equal(build(conflict,{asOf:at}).event.cutoffAt,null);
});
test('prospective pipeline attaches only current-cycle shadow and preserves parent frozen bytes',()=>{
 const old={...structuredClone(match),probabilityModel:{...match.probabilityModel,generatedAt:'2026-10-05T09:30:00Z'},
  externalSignals:{prematchV3:{version:'not-valid',teamObservations:[{secret:'do-not-borrow'}]}}};
 const parentBytes=JSON.stringify(old),now=Date.parse(at),[out]=attachProspectiveForecastInputs([old],[match],now);
 assert.equal(JSON.stringify(old),parentBytes);assert.deepEqual(out.probabilityModel,old.probabilityModel);
 const shadow=out.prospectiveForecastInput.prematchV3Assessment;assert.equal(shadow.status,'blocked');
 assert.equal(shadow.teamSnapshot.observations.length,0);assert.equal(shadow.comparisons.teamOnly,null);
 assert.equal(out.prospectiveForecastInput.probabilityModel.oneXTwo.final.home,50);
 assert.equal(attachProspectiveForecastInputs([old],[match],Date.parse('2026-10-06T11:00:00Z'))[0].prospectiveForecastInput,null);
});
test('prospective matching and generation gate retain same-millisecond event/knowledge distinctions',()=>{
 const now=Date.parse('2026-10-06T10:00:00Z');
 const laterEvent={...match,eventVersion:'2026-10-06T12:00:00.000000001Z',kickoffTime:'2026-10-06T12:00:00.000000001Z'};
 assert.equal(attachProspectiveForecastInputs([match],[laterEvent],now)[0].prospectiveForecastInput,null);
 const laterModel={...match,probabilityModel:{...match.probabilityModel,generatedAt:'2026-10-06T10:00:00.000000001Z'}};
 assert.equal(attachProspectiveForecastInputs([match],[laterModel],now)[0].prospectiveForecastInput,null);
});
test('lottery HHAD uses only integer home adjustment and goal rows retain explicit residual tail',()=>{
 const p=outcomeProjection({home:3,away:.4},-1),matrix=p.scoreDistribution;
 assert.equal(p.hhAd.market,'HHAD');assert.ok(matrix.tailMass<=1e-10);assert.ok(matrix.rows.length>30);
 assert.notDeepEqual(p.scoreTop3.map(r=>`${r.home}-${r.away}`),['1-1','1-1','1-1']);
 assert.equal(outcomeProjection({home:3,away:.4},-.75).hhAd,null,'AH cannot masquerade as HHAD');
 assert.ok(Math.abs(Object.values(p.probabilities).reduce((a,b)=>a+b,0)+matrix.tailMass-1)<1e-12);
});
test('structured AH evidence flows separately from HHAD without manufacturing team probability',()=>{
 const observation={market:'AH',source:'synthetic-ah',company:'A',sourceMatchId:'123',eventVersion:match.eventVersion,
  homeTeamId:'h',awayTeamId:'a',homeLine:-.5,oddsFormat:'hong-kong',rawPrices:{home:.9,away:1},
  providerObservedAt:'2026-10-06T09:00:00Z',receivedAt:'2026-10-06T09:01:00Z',rawPayloadHash:'a'.repeat(64)};
 const m={...match,externalSignals:{prematchV3:{version:SOURCE_VERSION,teamObservations:[],asianHandicapObservations:[observation]}}};
 const a=build(m,{asOf:at});assert.equal(a.asianTimeline.observationCount,1);assert.equal(a.asianPrices.length,0);
 assert.equal(a.comparisons.teamOnly,null);assert.equal(a.formalEligible,false);assert.ok(verify(a,{match:m}));
});
test('untrusted source JSON cannot fill missing private model namespaces or bypass a registry clock',()=>{
 const source={version:SOURCE_VERSION,teamObservations:[],asianHandicapObservations:[],
  zeroMarketBaseline:{artifact:{version:'forged'}},parameters:{version:'forged'}};
 const m={...match,externalSignals:{prematchV3:source}};
 const a=build(m,{asOf:at,baseline:null,parameters:null,modelRegistry:{asOf:'2026-10-06T09:59:00Z',storage:'postgres',status:'missing'}});
 assert.ok(a.baseline.blockers.includes('zero-market-trained-baseline-missing'));assert.deepEqual(a.parameterCheck.reasons,['trained-parameters-missing']);
 const future=build(m,{asOf:at,modelRegistry:{asOf:'2026-10-06T10:00:00.000000101Z',storage:'postgres'}});
 assert.ok(future.blockers.includes('model-registry-clock-or-storage-invalid'));assert.equal(future.comparisons.teamOnly,null);
});
test('online coverage report is not a win-rate or training result and cannot backdate calculation',()=>{
 const input={version:'prematch-v3-online-readonly-v2',businessDate:match.businessDate,observedAt:'2026-10-06T09:59:59.999999999Z',generation:{id:'test'},
  readOnly:'on',productionWrites:0,matches:[match],modelArtifactInventory:[],transport:{remoteResponseSha256:'b'.repeat(64)}};
 const report=buildReport(input,{asOf:at,gitHead:'synthetic',implementationHashes:{}});
 assert.equal(report.summary.matches,1);assert.equal(report.summary.marketReferences,1);assert.equal(report.summary.formalRecommendations,0);
 assert.equal(report.learning.accuracyMeasured,false);assert.equal(report.learning.hitRate,null);assert.equal(report.invariants.productionWrites,0);
 assert.throws(()=>buildReport(input,{asOf:'2026-10-06T09:59:59.999999998Z',implementationHashes:{}}),/CALCULATION_CLOCK/);
});
