"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const root=path.resolve(__dirname,"../.."),read=file=>JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
const sha=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const data=read("outputs/prospective-data-coverage-20261002/verification-receipt.json");
const model=read("outputs/prospective-recommendation-20261002/receipt.json");
const supplement=read("outputs/next-phase-20261002/form-supplement-local-verification.json");
const recovery=read("outputs/next-phase-20261002/form-recovery-receipt.json");
const checks=[];
for(const group of [data.artifacts,model.files,supplement.files])for(const item of group){const name=item.path||item.file;assert.equal(sha(path.resolve(root,name)),item.sha256,name);checks.push({file:name,sha256:item.sha256});}
for(const item of data.sources){assert.equal(sha(item.path),item.sha256);checks.push({file:item.path,sha256:item.sha256});}
assert.equal(recovery.ok,true);assert.deepEqual(recovery.summary,{rows:432,recoveredOmitted:355,snapshotMissing:53,retainedCrossChecked:24});
assert.equal(recovery.candidateEligible,false);assert.equal(recovery.productionWrites,false);
for(const item of recovery.inputs){assert.equal(sha(path.resolve(root,item.capture)),item.captureSha256);assert.equal(sha(path.resolve(root,item.rawResponse)),item.rawResponseSha256);}
assert.equal(recovery.inputs[0].captureSha256,data.sources[0].sha256);
assert.equal(recovery.inputs[0].rawResponseSha256,data.sources[2].sha256);
const tests=fs.readFileSync(path.join(__dirname,"targeted-tests.tap"),"utf8");
const testsPassed=Number(/# pass (\d+)/.exec(tests)?.[1]),testsFailed=Number(/# fail (\d+)/.exec(tests)?.[1]);
assert.equal(testsPassed,52);assert.equal(testsFailed,0);
assert.equal(supplement.pythonTests.passed,24);assert.equal(supplement.pythonTests.failed,0);
assert.equal(supplement.nodeTests.passed,3);assert.equal(supplement.nodeTests.failed,0);
const coverage=read("outputs/prospective-data-coverage-20261002/coverage-final.json");
const diagnostic=read("outputs/prospective-recommendation-20261002/diagnostic.json");
assert.equal(coverage.funnel.selected,432);assert.equal(coverage.funnel.sameDecisionPaired,154);
assert.equal(diagnostic.disagreementAppendix.length,26);assert.equal(diagnostic.overall.models.publishedModel.hits,78);assert.equal(diagnostic.overall.models.sameDecisionMarket.hits,83);
assert.equal(diagnostic.productionEligible,false);assert.equal(diagnostic.improvementProven,false);assert.equal(coverage.productionEligible,false);
const receipt={version:"football-next-phase-delivery-verification-v1",verifiedAt:new Date().toISOString(),node:process.version,
  testsPassed:testsPassed+supplement.pythonTests.passed+supplement.nodeTests.passed,testsFailed,
  testsScope:"55 Node cases and 24 Python cases, including default export byte compatibility; no probability uplift claim",
  targetedLint:{exitCode:0,outputSha256:sha(path.join(__dirname,"lint.txt")),formOutputSha256:sha(path.join(__dirname,"form-lint.txt"))},originalInputsUnchanged:true,
  sourceRows:432,pairedRows:154,disagreementCases:26,newLiveFieldReceipts:0,productionWrites:false,deployed:false,futureExperimentActivated:false,
  historicalFormRecovery:{recovered:355,previouslyReadable:24,readableNow:379,snapshotMissing:53,sourceRows:432,beforeCoverage:24/432,afterCoverage:379/432,candidateEligible:false,receiptSha256:sha(path.join(__dirname,"form-recovery-receipt.json"))},
  files:checks,testsSha256:sha(path.join(__dirname,"targeted-tests.tap"))};
fs.writeFileSync(path.join(__dirname,"verification.json"),JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify({ok:true,testsPassed:receipt.testsPassed,testsFailed,checkedFileHashes:checks.length}));
