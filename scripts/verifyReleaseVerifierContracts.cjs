'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8').replace(/\r\n?/g,'\n');
const pkg=JSON.parse(read('package.json')), lock=JSON.parse(read('package-lock.json'));
const checks=[];const check=(name,test)=>{test();checks.push({name,ok:true});};
check('review runtime verifier dependencies survive production pruning',()=>{
  for(const name of ['typescript','react','react-dom']){
    assert.ok(pkg.dependencies?.[name],`${name} is required by production review verification`);
    assert.equal(lock.packages[''].dependencies[name],pkg.dependencies[name]);
    assert.ok(lock.packages[`node_modules/${name}`]);
    assert.notEqual(lock.packages[`node_modules/${name}`].dev,true);
  }
  assert.equal(pkg.devDependencies?.typescript,undefined);
});
const coverage=read('scripts/verifyProductionPlanCoverage.cjs');
const marker='"fast result generation isolates receipt reviews and ships its exact contract"';
const position=coverage.indexOf(marker);assert.ok(position>0);
const start=coverage.lastIndexOf('  pushCheck(',position),end=coverage.indexOf('\n  pushCheck(',position);
assert.ok(start>0&&end>start);
const chunk=coverage.slice(start,end);
const readiness=read('scripts/verifyProductionReadiness.cjs');
const bundle=read('scripts/createReleaseBundle.cjs'),safety=read('scripts/verifyReleaseBundleSafety.cjs');
// Catch the real producer/admin mismatch before reserving a sequence, without
// replaying the full deadline/SQLite suite or touching runtime state.
const deadlineResearchStatus = require('./captureCandidateProspectiveDeadline.cjs').deadlineOnlyResearchStatus;
const apiContract = read('scripts/verifyApiContracts.cjs');
const researchStart = apiContract.indexOf('      const challengerSuiteSerialized =');
const researchEnd = apiContract.indexOf('      const exclusionAuditAllowedKeys =', researchStart);
assert.ok(researchStart >= 0 && researchEnd > researchStart);
const acceptsResearch = candidateChallengerSuite => vm.runInNewContext(
  apiContract.slice(researchStart, researchEnd) + '\nchallengerSuiteIsSanitized;',
  { candidateChallengerSuite }, { timeout: 1000 });
const researchVersion = 'candidate-prospective-challenger-suite-audit-v1';
check('absent deadline research satisfies unchanged admin contract before signing', () => {
  const status = deadlineResearchStatus(null, researchVersion);
  assert.equal(acceptsResearch(status), true); assert.equal(status.available, false);
  assert.equal(status.chainValid, false); assert.equal(status.onlineEffect, false);
  assert.deepEqual(status.blockers, ['deadline-only-research-unavailable']);
});
check('legacy unavailable placeholder is normalized without rewriting prior status', () => {
  const prior = deadlineResearchStatus(null, researchVersion); delete prior.trials;
  const bytes = JSON.stringify(prior); assert.equal(acceptsResearch(prior), false);
  const next = deadlineResearchStatus(prior, researchVersion);
  assert.equal(acceptsResearch(next), true); assert.equal(JSON.stringify(prior), bytes);
  assert.deepEqual(next.blockers, prior.blockers); assert.equal(next.available, false);
});
check('deadline research deferral cannot repair malformed existing trial data', () => {
  const prior = { ...deadlineResearchStatus(null, researchVersion), trials: null, ok: false };
  const next = deadlineResearchStatus(prior, researchVersion);
  assert.equal(acceptsResearch(next), false); assert.equal(next.ok, false);
  assert.deepEqual(next.blockers, prior.blockers);
});
const evaluate=(overrides={})=>{
  let result=null;
  vm.runInNewContext(chunk,{scripts:pkg.scripts,verifyProduction:readiness,createReleaseBundle:bundle,verifyReleaseBundleSafety:safety,
    hasAll:(text,needles)=>needles.every(n=>text.includes(n)),pushCheck:(_phase,_name,ok)=>{assert.equal(result,null);result=ok;},...overrides},{timeout:1000});
  assert.equal(typeof result,'boolean');return result;
};
check('actual production plan gate accepts current exact reconciliation contract',()=>assert.equal(evaluate(),true));
check('actual production plan gate rejects stale count 21',()=>assert.equal(evaluate({verifyProduction:readiness.replaceAll('Number(fastResultGeneration.body?.checks) === 23','Number(fastResultGeneration.body?.checks) === 21')}),false));
for(const field of ['pairedReferenceSurvivesReconciliation','invalidPairSourceFailsBeforeAnyWrite']){
  check(`actual production plan gate rejects missing ${field}`,()=>assert.equal(evaluate({verifyProduction:readiness.replaceAll(field,'REMOVED_CONTRACT')}),false));
}
check('actual production plan gate rejects a missing signed reconciler',()=>assert.equal(evaluate({createReleaseBundle:bundle.replaceAll('"scripts/reconcileFastResultGeneration.cjs"','"omitted"')}),false));
check('bundle creation checks verifier contracts before sequence reservation',()=>{
  const preflight=bundle.indexOf('scripts/verifyReleaseVerifierContracts.cjs');
  const reservation=bundle.indexOf('const sequenceReservation = reserveReleaseSequence(');
  assert.ok(preflight>=0&&reservation>preflight);
});
check('exact revision transition and its signed dependencies pass before sequence reservation',()=>{
  const result=require('./verifyCandidateReleaseRevisionTransition.cjs').run();
  assert.ok(result.checks>=27);
  for(const entry of ['deploy/light-server/candidate-revision-transition.json','scripts/verifyCandidateReleaseRevisionTransition.cjs']){
    assert.ok(bundle.includes(`"${entry}"`));
    assert.ok(safety.includes(`"${entry}"`));
  }
});
check('fixed hypothesis lineage survives competing retrospective winners before signing', () => {
  const result = require('./verifyCandidateRevisionLineage.cjs').verifyCandidateRevisionLineage();
  assert.equal(result.ok, true); assert.ok(result.checks >= 11);
});
const collectorEntries = ['src/services/apiFootballDiagnostics.cjs', 'src/services/apiFootballDiagnostics.d.cts',
  'scripts/releaseWorkerPreflight.cjs', 'scripts/verifyReleaseWorkerPreflight.cjs',
  'scripts/releaseWorkspaceFreshness.cjs', 'scripts/verifyReleaseWorkspaceFreshness.cjs',
  'scripts/releaseProgress.cjs', 'scripts/checkReleaseProgress.cjs', 'scripts/verifyReleaseProgress.cjs',
  'scripts/apiFootballClockEvidence.cjs', 'scripts/verifyApiFootballClockEvidence.cjs',
  'scripts/verifyApiFootballDiagnostics.cjs', 'scripts/verifyCandidateArtifactSeed.cjs', 'scripts/verifyCandidateRevisionLineage.cjs',
  'scripts/verifyLegacyReferenceConflict.cjs', 'src/services/legacyReferenceConflict.ts', 'scripts/verifyFrozenArchiveAuthority.cjs',
  'scripts/frozenArchiveRestoration.cjs', 'scripts/data/frozen-archive-restoration.json',
  'scripts/releaseArchivePreflight.cjs', 'scripts/runReleaseArchivePreflight.cjs', 'scripts/verifyReleaseArchivePreflight.cjs',
  'scripts/verifyFrozenArchivePersistence.cjs', 'scripts/verifyFrozenArchiveRestoration.cjs',
  'scripts/verifyOfficialClubResults.cjs', 'scripts/syncOfficialClubResults.cjs', 'scripts/verifyOfficialClubReceiptClocks.cjs',
  'scripts/competitionModelContext.cjs', 'scripts/verifyCompetitionModelContext.cjs',
  'scripts/predictionExecutionCapture.cjs', 'scripts/verifyPredictionExecutionCapture.cjs', 'scripts/verifyDataGenerationPointerLockRace.cjs',
  'scripts/verifyDataGenerationEndToEnd.cjs',
  'scripts/openFootballObservationStore.cjs', 'scripts/auditOpenFootballCurrentSeason.cjs', 'scripts/verifyOpenFootballObservations.cjs',
  'scripts/openFootballResultReceiptIndex.cjs', 'scripts/verifyOpenFootballResultReceiptIndex.cjs',
  'scripts/openFootballObservationSchedule.cjs', 'scripts/runOpenFootballObservationSync.cjs',
  'scripts/verifyOpenFootballObservationSchedule.cjs', 'scripts/footballDataFixtureRetry.cjs',
  'src/services/predictionExecutionClock.cjs', 'scripts/verifyPredictionExecutionClock.cjs',
  'src/services/predictionRuntimeIdentity.cjs', 'scripts/replayPredictionCapture.cjs', 'scripts/verifyPredictionReplay.cjs'];
const requiredEntries = source => {
  const match = /const required(?:Release)?Entries = (\[[\s\S]*?\n\]);/.exec(source);
  assert.ok(match, 'required release-entry array must be explicit');
  const prebuilt = /const prebuiltDistBundleEntry = ("[^"\n]+");/.exec(source);
  assert.ok(prebuilt, 'prebuilt entry must be an explicit path');
  // Resolve the array's two existing constants from their real definitions.
  return vm.runInNewContext(match[1], { prebuiltDistBundleEntry: JSON.parse(prebuilt[1]), HISTORICAL_TRAINING_RELEASE_ENTRY:
    require('./historicalTrainingReleaseArtifact.cjs').HISTORICAL_TRAINING_RELEASE_ENTRY }, { timeout: 1000 });
};
const collectorDependenciesPresent = (creator, validator) => collectorEntries.every(entry =>
  requiredEntries(creator).includes(entry) && requiredEntries(validator).includes(entry));
check('collector and rehearsal dependencies are required by both actual archive gates', () => {
  assert.equal(collectorDependenciesPresent(bundle, safety), true);
  for (const entry of collectorEntries) assert.ok(fs.statSync(path.join(root, entry)).isFile(), entry);
});
for (const entry of collectorEntries) for (const side of ['creator', 'validator']) {
  check(`${side} gate rejects missing ${entry}`, () => {
    const missing = source => source.replace(`  "${entry}",\n`, '');
    assert.equal(collectorDependenciesPresent(side === 'creator' ? missing(bundle) : bundle,
      side === 'validator' ? missing(safety) : safety), false);
  });
}
const receiptMarker = '  pushCheck(checks, "official club receipt clocks follow complete responses and preserve newer evidence",';
const receiptStart = readiness.indexOf(receiptMarker);
const receiptEnd = readiness.indexOf('\n  const competitionContext', receiptStart);
assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
const receiptGate = body => {
  let result = null;
  vm.runInNewContext(readiness.slice(receiptStart, receiptEnd), { checks: [],
    clubResultReceipts: { status: 0, body, stderr: '' }, pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const receiptProof = { ok: true, checks: 21, networkCalls: 0, productionDataTouched: false };
check('production receipt gate accepts complete isolated clock coverage', () => assert.equal(receiptGate(receiptProof), true));
for (const [name, bad] of Object.entries({ failed: { ok: false }, insufficient: { checks: 20 },
  network: { networkCalls: 1 }, productionWrite: { productionDataTouched: true } })) {
  check(`production receipt gate rejects ${name} proof`, () => assert.equal(receiptGate({ ...receiptProof, ...bad }), false));
}
const competitionStart = readiness.indexOf('  pushCheck(checks, "model competition weights ignore team labels and preserve executed context",');
const competitionEnd = readiness.indexOf('\n  const executionCapture', competitionStart);
assert.ok(competitionStart >= 0 && competitionEnd > competitionStart);
const competitionGate = (body, status = 0) => {
  let result = null;
  vm.runInNewContext(readiness.slice(competitionStart, competitionEnd), { checks: [],
    competitionContext: { status, body, stderr: '' }, pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const competitionProof = { ok: true, checks: 16, productionWrites: 0 };
check('competition gate accepts actual isolated coverage', () => assert.equal(competitionGate(competitionProof), true));
for (const bad of [{ ok: false }, { checks: 15 }, { productionWrites: 1 }]) {
  check('competition gate rejects incomplete or writing proof ' + JSON.stringify(bad), () => assert.equal(competitionGate({ ...competitionProof, ...bad }), false));
}
check('competition gate rejects failed command even with success JSON', () => assert.equal(competitionGate(competitionProof, 1), false));
const executionStart = readiness.indexOf('  pushCheck(checks, "private prediction execution capture preserves exact inputs and never rewrites locked outputs",');
const executionEnd = readiness.indexOf('\n  const executionClock', executionStart);
assert.ok(executionStart >= 0 && executionEnd > executionStart);
const executionGate = (body, status = 0) => {
  let result = null;
  vm.runInNewContext(readiness.slice(executionStart, executionEnd), { checks: [],
    executionCapture: { status, body, stderr: '' }, pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const executionProof = { ok: true, checks: 49, writerLockChecks: 9, retentionChecks: 18, realRetainedBatches: 513,
  retentionPolicyVersion: "prediction-capture-capacity-v2", productionDataTouched: false, providerRequests: 0 };
check('execution capture gate accepts actual boundary and storage cases', () => assert.equal(executionGate(executionProof), true));
for (const bad of [{ ok: false }, { checks: 48 }, { writerLockChecks: 8 }, { writerLockChecks: undefined }, { retentionChecks: 17 }, { realRetainedBatches: 512 },
  { retentionPolicyVersion: "prediction-capture-capacity-v1" }, { productionDataTouched: true }, { providerRequests: 1 }]) {
  check('execution gate rejects invalid evidence ' + JSON.stringify(bad), () => assert.equal(executionGate({ ...executionProof, ...bad }), false));
}
check('execution gate rejects command failure', () => assert.equal(executionGate(executionProof, 1), false));
const clockStart = readiness.indexOf('  pushCheck(checks, "prediction clock replays entire outputs without ignoring fields or forging observation times",');
const clockEnd = readiness.indexOf('\n  const predictionReplay', clockStart);
assert.ok(clockStart >= 0 && clockEnd > clockStart);
const clockGate = (body, status = 0) => {
  let result = null;
  vm.runInNewContext(readiness.slice(clockStart, clockEnd), { checks: [], executionClock: { status, body, stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const clockProof = { ok: true, checks: 14, productionDataTouched: false, providerRequests: 0, fullOutputFieldsIgnored: 0 };
check('clock gate accepts full-output replay without field exclusions', () => assert.equal(clockGate(clockProof), true));
for (const bad of [{ ok: false }, { checks: 13 }, { productionDataTouched: true }, { providerRequests: 1 }, { fullOutputFieldsIgnored: 1 }]) {
  check('clock gate rejects invalid proof ' + JSON.stringify(bad), () => assert.equal(clockGate({ ...clockProof, ...bad }), false));
}
check('clock gate rejects command failure', () => assert.equal(clockGate(clockProof, 1), false));
const replayStart = readiness.indexOf('  pushCheck(checks, "independent prediction replay requires exact executable runtime and rejects corrupt records",');
const replayEnd = readiness.indexOf('\n  const localServerOwnership', replayStart);
assert.ok(replayStart >= 0 && replayEnd > replayStart);
const replayGate = (body, status = 0) => {
  let result = null;
  vm.runInNewContext(readiness.slice(replayStart, replayEnd), { checks: [], predictionReplay: { status, body, stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const replayProof = { ok: true, checks: 13, independentChildRuns: 1, productionDataTouched: false, providerRequests: 0, fullOutputFieldsIgnored: 0 };
check('independent replay gate accepts complete child-process proof', () => assert.equal(replayGate(replayProof), true));
for (const bad of [{ ok: false }, { checks: 12 }, { independentChildRuns: 0 }, { productionDataTouched: true }, { providerRequests: 1 }, { fullOutputFieldsIgnored: 1 }]) {
  check('independent replay gate rejects invalid proof ' + JSON.stringify(bad), () => assert.equal(replayGate({ ...replayProof, ...bad }), false));
}
check('independent replay gate rejects command failure', () => assert.equal(replayGate(replayProof, 1), false));
const lifecycleStart = readiness.indexOf('    pushCheck(checks, "match detail lifecycle artifact",');
const lifecycleEnd = readiness.indexOf('\n    const predictionMetricSemantics', lifecycleStart);
assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
const lifecycleGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(lifecycleStart, lifecycleEnd), { checks: [],
    matchDetailLifecycle: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const lifecycleProof = { ok: true, checks: Array.from({length:24}, (_, i) => ({
  name: i === 0 ? 'isolated SSR collector alias executes the real diagnostics module' : `existing check ${i}`, ok: true })) };
check('lifecycle gate requires actual shared collector execution', () => assert.equal(lifecycleGate(lifecycleProof), true));
for (const bad of [{ok:false}, {checks:[]}, {checks:lifecycleProof.checks.slice(0,23)},
  {checks:lifecycleProof.checks.map(c=>({...c, name:'unrelated'}))},
  {checks:lifecycleProof.checks.map((c,i)=>i===0?{...c,ok:false}:c)}]) {
  check('lifecycle gate rejects absent or failing alias proof', () => assert.equal(lifecycleGate({...lifecycleProof,...bad}), false));
}
check('lifecycle gate rejects child failure', () => assert.equal(lifecycleGate(lifecycleProof,1),false));
const generationStart = readiness.indexOf('    pushCheck(checks, "buffered generation preserves canonical identity and isolated publication behavior",');
const generationEnd = readiness.indexOf('\n    const selectedJson', generationStart);
assert.ok(generationStart >= 0 && generationEnd > generationStart);
const generationGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(generationStart, generationEnd), { checks: [],
    generationCompatibility: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const generationProof = { ok: true, version: 'buffered-generation-compatibility-v1', checks: 125, bufferedCompatibilityChecks: 125, defaultServerDataTouched: false };
check('generation gate accepts complete isolated compatibility coverage', () => assert.equal(generationGate(generationProof), true));
for (const bad of [{ ok: false }, { version: 'unrelated-test' }, { checks: 124 }, { bufferedCompatibilityChecks: 124 },
  { bufferedCompatibilityChecks: undefined }, { defaultServerDataTouched: true }, { defaultServerDataTouched: undefined }]) {
  check('generation gate rejects incomplete or writing proof ' + JSON.stringify(bad), () => assert.equal(generationGate({ ...generationProof, ...bad }), false));
}
check('generation gate rejects child failure', () => assert.equal(generationGate(generationProof, 1), false));
const communityStart = readiness.indexOf('    pushCheck(checks, "community raw receipts preserve first clocks and cannot publish predictions",');
const communityEnd = readiness.indexOf('\n    const generationCompatibility', communityStart);
assert.ok(communityStart >= 0 && communityEnd > communityStart);
const communityGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(communityStart, communityEnd), { checks: [],
    communityObservations: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const communityProof = { ok: true, checks: 51, providerRequests: 0, productionDataTouched: false };
check('community gate requires isolated durable receipt proof', () => assert.equal(communityGate(communityProof), true));
for (const bad of [{ ok: false }, { checks: 50 }, { providerRequests: 1 }, { productionDataTouched: true }]) {
  check('community gate rejects invalid receipt evidence ' + JSON.stringify(bad), () => assert.equal(communityGate({ ...communityProof, ...bad }), false));
}
check('community gate rejects command failure', () => assert.equal(communityGate(communityProof, 1), false));
const scheduleStart = readiness.indexOf('    pushCheck(checks, "community receipt schedule is isolated, bounded and outside base publication",');
const scheduleEnd = readiness.indexOf('\n    const communityObservations', scheduleStart);
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
const scheduleGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(scheduleStart, scheduleEnd), { checks: [],
    communitySchedule: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const scheduleProof = { ok: true, verifier: 'openfootball-observation-schedule-v1', providerRequests: 0, productionDataTouched: false,
  checks: Array.from({ length: 17 }, (_, i) => ({ name: i === 0 ? 'actual worker wiring keeps research step outside base-publication inputs' : `check-${i}`, ok: true })) };
check('community scheduling gate accepts isolated complete wiring evidence', () => assert.equal(scheduleGate(scheduleProof), true));
for (const bad of [{ ok: false }, { verifier: 'unrelated' }, { providerRequests: 1 }, { productionDataTouched: true },
  { checks: scheduleProof.checks.slice(0, 16) }, { checks: scheduleProof.checks.map(c => ({ ...c, name: 'unrelated' })) },
  { checks: scheduleProof.checks.map(c => ({ ...c, ok: false })) }]) {
  check('community scheduling gate rejects incomplete evidence', () => assert.equal(scheduleGate({ ...scheduleProof, ...bad }), false));
}
check('community scheduling gate rejects failed child', () => assert.equal(scheduleGate(scheduleProof, 1), false));
const resultStart = readiness.indexOf('    pushCheck(checks, "community result clocks require actual qualifying receipts and immutable as-of replay",');
const resultEnd = readiness.indexOf('\n    const communitySchedule', resultStart);
assert.ok(resultStart >= 0 && resultEnd > resultStart);
const resultGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(resultStart, resultEnd), { checks: [],
    communityResultReceipts: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const resultNames = ['appended future evidence does not alter historical index hash or rows',
  'same-day source score remains quarantined even when queried a week later'];
const resultProof = { ok: true, verifier: 'openfootball-result-receipt-index-v1', providerRequests: 0, productionDataTouched: false,
  checks: Array.from({ length: 17 }, (_, i) => ({ name: resultNames[i] || `check-${i}`, ok: true })) };
check('result receipt gate accepts bounded as-of and quarantine evidence', () => assert.equal(resultGate(resultProof), true));
for (const bad of [{ ok: false }, { verifier: 'unrelated' }, { providerRequests: 1 }, { productionDataTouched: true },
  { checks: resultProof.checks.slice(0, 16) }, { checks: resultProof.checks.map(c => ({ ...c, name: 'unrelated' })) },
  { checks: resultProof.checks.map(c => ({ ...c, ok: false })) }]) {
  check('result receipt gate rejects incomplete evidence', () => assert.equal(resultGate({ ...resultProof, ...bad }), false));
}
check('result receipt gate rejects failed child', () => assert.equal(resultGate(resultProof, 1), false));
const diagnosticStart = readiness.indexOf('    pushCheck(checks, "collector diagnostics preserve privacy and frozen-decision separation",');
const diagnosticEnd = readiness.indexOf('\n    const wikidataCandidates', diagnosticStart);
assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart);
const diagnosticGate = (body, status = 0) => {
  let result;
  vm.runInNewContext(readiness.slice(diagnosticStart, diagnosticEnd), { checks: [],
    collectorDiagnostics: { status, body, stdout: '', stderr: '' },
    pushCheck: (_checks, _name, ok) => { result = ok; } }, { timeout: 1000 });
  return result;
};
const diagnosticProof = { ok: true, checks: 43, fixtureAccessChecks: 19, productionDataWritten: false };
check('collector diagnostic gate requires date-access integration and privacy proof', () => assert.equal(diagnosticGate(diagnosticProof), true));
for (const bad of [{ ok: false }, { checks: 42 }, { fixtureAccessChecks: 18 }, { fixtureAccessChecks: undefined }, { productionDataWritten: true }]) {
  check('collector diagnostic gate rejects incomplete date-access proof', () => assert.equal(diagnosticGate({ ...diagnosticProof, ...bad }), false));
}
check('collector diagnostic gate rejects failed child', () => assert.equal(diagnosticGate(diagnosticProof, 1), false));
check('worker early rejection has behavioral and serialized read-only coverage',()=>{
  const result=require('./verifyReleaseWorkerPreflight.cjs').verifyReleaseWorkerPreflight();
  assert.equal(result.ok,true);assert.ok(result.checks>=20);assert.equal(result.productionWrites,0);
});
const selectionLabel='multi-factor recommendation gate is time ordered and shadow-safe';
const selectionPosition=coverage.indexOf(selectionLabel);
const selectionChunk=coverage.slice(coverage.lastIndexOf('  pushCheck(',selectionPosition),coverage.indexOf('\n  pushCheck(',selectionPosition));
const selectionSources={modelBacktest:'scripts/runModelBacktest.cjs',modelStrategy:'scripts/optimizePredictionStrategy.cjs',
  verifyRecommendationEligibility:'scripts/verifyRecommendationEligibility.cjs',verifyBetSlipRecommendationGate:'scripts/verifyBetSlipRecommendationGate.cjs',
  verifyPredictionFeatureAsOf:'scripts/verifyPredictionFeatureAsOf.cjs',verifyServerRecommendationBoundary:'scripts/verifyServerRecommendationBoundary.cjs',
  verifyLiveRecommendationLayer:'scripts/verifyLiveRecommendationLayer.cjs'};
const selectionContext=Object.fromEntries(Object.entries(selectionSources).map(([name,file])=>[name,read(file)]));
const selectionGate=(overrides={},source=selectionChunk)=>{
  let passed=null;vm.runInNewContext(source,{...selectionContext,
    modelEvaluation:{recommendationSelection:{gate:{eligible:false}}},formalStrategy:{recommendationSelection:{status:'shadow-only',hardMaxSp:null,directionSwitchByLowerSp:false}},
    hasAll:(value,needles)=>needles.every(needle=>value.includes(needle)),pushCheck:(_phase,_name,ok)=>{passed=ok;},...overrides},{timeout:1000});return passed;
};
check('actual selection coverage accepts stable policy ID with valid synthetic artifact gates',()=>assert.equal(selectionGate(),true));
check('original r707 stale-description failure reproduced without running deployment',()=>{
  const old=selectionChunk.replace('model-only-input-sufficiency-v2','model-only BEST rows keep a visible cold-start reference while formal eligibility fails closed');
  assert.equal(selectionGate({},old),false);
});
check('renaming descriptive text does not invalidate policy coverage',()=>assert.equal(selectionGate({verifyRecommendationEligibility:
  selectionContext.verifyRecommendationEligibility.replace('model-only BEST rows withhold insufficient inputs while auditable model-only references remain available','A renamed human-readable explanation')}),true));
check('missing stable policy declaration rejects coverage',()=>assert.equal(selectionGate({verifyRecommendationEligibility:
  selectionContext.verifyRecommendationEligibility.replaceAll('model-only-input-sufficiency-v2','missing-contract')}),false));
check('actual shadow artifact restriction remains mandatory',()=>assert.equal(selectionGate({modelEvaluation:{recommendationSelection:{gate:{eligible:true}}}}),false));
const eligibilityPosition=readiness.indexOf('pushCheck(checks, "official recommendation eligibility"');
const eligibilityChunk=readiness.slice(eligibilityPosition,readiness.indexOf('\n\n    const externalOddsReference',eligibilityPosition));
const eligibilityGate=(body,status=0)=>{let passed=null;vm.runInNewContext(eligibilityChunk,{checks:[],recommendationComparison:{},
  recommendationEligibility:{status,body,stdout:'',stderr:''},pushCheck:(_checks,_name,ok)=>{passed=ok;}},{timeout:1000});return passed;};
const contractProof={ok:true,policyContracts:{'model-only-input-sufficiency-v2':true}};
check('readiness requires actual successful named behavioral evidence',()=>assert.equal(eligibilityGate(contractProof),true));
for(const body of [{ok:true},{...contractProof,ok:false},{ok:true,policyContracts:{'model-only-input-sufficiency-v2':false}}])
  check('readiness rejects missing/failed policy evidence despite text presence',()=>assert.equal(eligibilityGate(body),false));
check('readiness rejects failed verifier process even with named pass',()=>assert.equal(eligibilityGate(contractProof,1),false));
const modelOnlySource=selectionContext.verifyRecommendationEligibility;
const policyStart=modelOnlySource.indexOf('check("model-only BEST rows withhold');
const policyChunk=modelOnlySource.slice(policyStart,modelOnlySource.indexOf('\ncheck("no model-only row is actionable"',policyStart));
const policyFixture=(row)=>{let result=null;vm.runInNewContext(policyChunk,{regeneratedBestRows:[row],modelOnlyMatches:[{}],
  check:(_name,ok,_details,contractId)=>{result={ok,contractId};}},{timeout:1000});return result;};
const coldRow={inputSufficiency:{sufficient:false},prediction:{recommendationAction:'reference',odds:0,resultStatus:'PENDING',recommendationTier:'input-insufficient-watch',tipCode:'WATCH'}};
check('named policy comes from actual no-input behavior',()=>assert.equal(policyFixture(coldRow).ok,true));
check('named policy rejects fabricated cold-start direction',()=>assert.equal(policyFixture({...coldRow,prediction:{...coldRow.prediction,tipCode:'1'}}).ok,false));
check('named policy preserves auditable model-only reference',()=>assert.equal(policyFixture({inputSufficiency:{sufficient:true},prediction:{...coldRow.prediction,recommendationTier:'model-only-watch',tipCode:'X'}}).ok,true));
for(const mutation of [{recommendationAction:'recommend'},{odds:2.5},{resultStatus:'WON'}])
  check('named policy rejects formal/executable/settled fixture',()=>assert.equal(policyFixture({...coldRow,prediction:{...coldRow.prediction,...mutation}}).ok,false));
check('behavioral result is emitted under a stable non-display ID',()=>assert.equal(policyFixture(coldRow).contractId,'model-only-input-sufficiency-v2'));
check('complete archive preflight behaviors pass before signing',()=>{
  const result=require('./verifyReleaseArchivePreflight.cjs').verifyReleaseArchivePreflight();
  assert.equal(result.ok,true);assert.ok(result.checks.length>=17);assert.equal(result.productionWrites,0);
});
check('online archive preflight precedes sequence reservation and frontend build',()=>{
  const probe=bundle.indexOf('require("./runReleaseArchivePreflight.cjs").runLiveArchivePreflight()');
  assert.ok(probe>=0&&probe<bundle.indexOf('const sequenceReservation = reserveReleaseSequence('));
  assert.ok(probe<bundle.indexOf('const frontendBuild = spawnSync('));
  assert.ok(bundle.includes('if (process.env.RELEASE_DEPLOY_KEY)'));
});
check('deployment rechecks archives before local clone and upload',()=>{
  const client=read('scripts/deployReleaseBundle.cjs');
  const probe=client.indexOf('require("./runReleaseArchivePreflight.cjs").runLiveArchivePreflight()');
  assert.ok(probe>=0&&probe<client.indexOf('const localCloneVerifier = runCommand('));
  assert.ok(probe<client.indexOf('for (const artifact of uploads)'));
});
check('all release entrypoints share tested workspace freshness before signing',()=>{
  const report=require('./verifyReleaseWorkspaceFreshness.cjs').verifyReleaseWorkspaceFreshness();
  assert.equal(report.ok,true);assert.ok(report.checks.length>=12);
  assert.equal(report.productionWrites,0);assert.equal(report.networkCalls,0);
});
check('read-only release progress cannot imply live acceptance or repeat deployment',()=>{
  const report=require('./verifyReleaseProgress.cjs').verifyReleaseProgress();
  assert.equal(report.ok,true);assert.ok(report.checks.length>=21);
  assert.equal(report.productionWrites,0);assert.equal(report.networkCalls,0);
});
console.log(JSON.stringify({ok:true,verifier:'release-verifier-contracts-v1',checks,productionDataTouched:false},null,2));
