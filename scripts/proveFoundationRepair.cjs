'use strict';
// Executed only inside the copied application, under a read-only host mount and private network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { hash, objectFingerprint } = require('./foundationRepairPolicy.cjs');
const { readChunkedJsonFile } = require('../server/chunkedJsonFile.cjs');
const { collectPublicReferenceEvidence } = require('../src/services/publicReferenceEvidence.cjs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(__dirname, '..');
assert.ok(root.startsWith('/var/lib/football-release/foundation-repairs/') && root.endsWith('/candidate'));
assert.equal(fs.realpathSync(root), root);
const input = path.join(root, 'public/data/prediction-snapshots.json');
let parsed = readChunkedJsonFile(input,{expectedBytes:plan.snapshot.bytes,expectedSha256:plan.snapshot.sha256});
const before = objectFingerprint(parsed.value);
const decisions = parsed.value.publicReferenceDecisions, evidence = parsed.value.publicReferenceEvidence;
assert.equal(collectPublicReferenceEvidence(decisions,evidence).length,plan.snapshot.validBindings);
const protectedObjects = {decisions:decisions.map(x=>hash(JSON.stringify(x))),evidence:evidence.map(x=>hash(JSON.stringify(x)))};
const { writeJson } = require('./syncData.cjs');
const outputDir = path.join(root,'repair-proof-output');fs.mkdirSync(outputDir,{mode:0o700});
const output = path.join(outputDir,'prediction-snapshots.json');
writeJson(output,parsed.value);
const counts = Object.fromEntries(Object.entries(parsed.value).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length]));
parsed = null; if(global.gc)global.gc();
const after = readChunkedJsonFile(output,{expectedBytes:plan.snapshot.compactBytes,expectedSha256:plan.snapshot.compactSha256});
assert.equal(objectFingerprint(after.value),before, 'full snapshot object changed');
assert.equal(collectPublicReferenceEvidence(after.value.publicReferenceDecisions,after.value.publicReferenceEvidence).length,198);
const report={version:'foundation-isolated-proof-v1',ok:true,checkedAt:new Date().toISOString(),capsuleSha256:hash(fs.readFileSync(process.argv[2])),
  originalSha256:plan.snapshot.sha256,compactSha256:after.evidence.sha256,fullObjectSha256:before,counts,protectedObjects,
  maxRssKiB:process.resourceUsage().maxRSS,productionWrites:0,providerRequests:0,modelPromotion:false};
fs.writeFileSync(path.join(root,'repair-proof.json'),JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({...report,protectedObjects:undefined}));
