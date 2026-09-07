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
  'scripts/verifyLegacyReferenceConflict.cjs', 'src/services/legacyReferenceConflict.ts'];
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
console.log(JSON.stringify({ok:true,verifier:'release-verifier-contracts-v1',checks,productionDataTouched:false},null,2));
