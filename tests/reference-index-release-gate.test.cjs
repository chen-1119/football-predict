'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'scripts/verifyReleaseVerifierContracts.cjs'),'utf8');
const begin=source.indexOf("check('reference index repair rejects unrelated faults, changed corpus and clipped journal before signing'");
const end=source.indexOf('\nconst collectorEntries',begin);assert(begin>=0&&end>begin);
const definitions=source.match(/const bundle=read\('scripts\/createReleaseBundle\.cjs'\),safety=read\('scripts\/verifyReleaseBundleSafety\.cjs'\);/);
assert(definitions,'actual factory source bindings absent');
function run({status=0,stdout='# tests 45\n# skipped 0\n',missing=false}={}) {
  const events=[];
  const read=name=>{const text=fs.readFileSync(path.join(root,name),'utf8');return missing?text.replace('"tests/reference-index-repair-boundary.test.cjs"','"removed-test"'):text;};
  const requireFixture=name=>name==='node:child_process'?{spawnSync:(node,args,options)=>{events.push({node,args,options});return {status,stdout,stderr:''};}}:require(name);
  // Execute the real source definitions and actual factory gate, with only
  // the child result simulated. Invented globals cannot mask scope errors.
  new vm.Script(definitions[0]+'\n'+source.slice(begin,end)).runInNewContext({read,root,assert,process:{execPath:process.execPath},require:requireFixture,
    check:(_name,fn)=>fn()});
  return events;
}
test('actual pre-sign gate has defined source bindings and executes its required rejection suite',()=>{
  const events=run();assert.equal(events.length,1);assert.deepEqual(Array.from(events[0].args),['--test','tests/reference-index-repair-boundary.test.cjs']);
  assert.equal(events[0].options.cwd,root);assert.equal(events[0].options.timeout,30000);
});
test('actual pre-sign gate rejects failed, partial or skipped test output',()=>{
  for(const value of [{status:1},{status:null},{stdout:'# tests 44\n# skipped 0\n'},{stdout:'# tests 45\n# skipped 1\n'}])assert.throws(()=>run(value));
});
test('actual pre-sign gate refuses a verifier missing from either signed archive source',()=>assert.throws(()=>run({missing:true})));
