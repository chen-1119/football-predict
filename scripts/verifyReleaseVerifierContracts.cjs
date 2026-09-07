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
  'scripts/apiFootballClockEvidence.cjs', 'scripts/verifyApiFootballClockEvidence.cjs',
  'scripts/verifyApiFootballDiagnostics.cjs', 'scripts/verifyCandidateArtifactSeed.cjs', 'scripts/verifyCandidateRevisionLineage.cjs',
  'scripts/verifyLegacyReferenceConflict.cjs', 'src/services/legacyReferenceConflict.ts', 'scripts/verifyFrozenArchiveAuthority.cjs',
  'scripts/verifyOfficialClubResults.cjs', 'scripts/syncOfficialClubResults.cjs', 'scripts/verifyOfficialClubReceiptClocks.cjs',
  'scripts/competitionModelContext.cjs', 'scripts/verifyCompetitionModelContext.cjs',
  'scripts/predictionExecutionCapture.cjs', 'scripts/verifyPredictionExecutionCapture.cjs',
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
const executionProof = { ok: true, checks: 40, retentionChecks: 18, realRetainedBatches: 513,
  retentionPolicyVersion: "prediction-capture-capacity-v2", productionDataTouched: false, providerRequests: 0 };
check('execution capture gate accepts actual boundary and storage cases', () => assert.equal(executionGate(executionProof), true));
for (const bad of [{ ok: false }, { checks: 39 }, { retentionChecks: 17 }, { realRetainedBatches: 512 },
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
console.log(JSON.stringify({ok:true,verifier:'release-verifier-contracts-v1',checks,productionDataTouched:false},null,2));
