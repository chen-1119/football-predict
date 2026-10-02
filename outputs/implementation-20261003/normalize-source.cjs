'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
if (fs.existsSync(path.join(__dirname, 'source-line-endings.json'))) throw Error('Normalization is already recorded; preserve the original byte lineage.');
const files = [
  'scripts/syncData.cjs', 'scripts/validateData.cjs', 'scripts/verifyFrontendEvidenceSemantics.cjs',
  'scripts/diagnoseFrozenModelDisagreement.cjs', 'scripts/officialClosedScheduleEvidence.cjs',
  'src/components/predictions/RecommendationEvidenceFacts.tsx', 'src/services/modelInputUsage.cjs',
  'src/services/recommendationReadinessPresentation.ts', 'src/styles/published-evidence-snapshot.css',
  'tests/published-evidence-snapshot.test.cjs', 'tests/frontend-evidence-shared-helper-gate.test.cjs',
  'tests/frozen-model-disagreement.test.cjs', 'tests/model-input-usage-clock.test.cjs',
  'tests/official-closed-schedule-evidence.test.cjs', 'tests/recommendation-readiness-presentation.test.cjs',
  'docs/model-disagreement-and-clock-repair-20261003.md',
];
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const receipt = { at: new Date().toISOString(), change: 'CRLF to LF only; payload inputs and generated evidence remain byte-identical', files: [] };
for (const file of files) {
  const target = path.join(root, file), before = fs.readFileSync(target), after = Buffer.from(before.toString('utf8').replace(/\r\n/g, '\n'));
  receipt.files.push({path:file,beforeSha256:hash(before),afterSha256:hash(after),beforeBytes:before.length,afterBytes:after.length});
  fs.writeFileSync(target, after);
}
const attrs = path.join(root, '.gitattributes');
let body = fs.readFileSync(attrs,'utf8').replace(/\r\n/g,'\n');
for (const file of files) if (!body.split('\n').includes(file + ' text eol=lf')) body += file + ' text eol=lf\n';
fs.writeFileSync(attrs, body);
for (const file of ['model/receipt.json', 'ui/delivery-receipt.json']) {
  const target = path.join(__dirname, file), saved = JSON.parse(fs.readFileSync(target,'utf8'));
  for (const entry of saved.files) {
    const relative = entry.file || entry.path;
    if (files.includes(relative)) { const raw = fs.readFileSync(path.join(root,relative)); entry.sha256=hash(raw); if ('bytes' in entry) entry.bytes=raw.length; }
  }
  saved.sourceLineEndingNormalization = { receipt:'outputs/implementation-20261003/source-line-endings.json', at:receipt.at, semanticChanges:false };
  fs.writeFileSync(target,JSON.stringify(saved,null,2)+'\n');
}
fs.writeFileSync(path.join(__dirname,'source-line-endings.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({normalized:files.length,semanticChanges:false}));
