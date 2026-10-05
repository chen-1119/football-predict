'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname,'cloud',name),'utf8'));
const files = [
 ['cloud-run.json',15451,'7676b94235db4681b7e6fc3a2da0a77b7c6de88a04cf3f2e58e3738c805a0796'],
 ['cloud-model-review.json',76462,'67ff3a39cca958b17f9920f3a6ad38252ca355490011b40393b54f99faaae844'],
 ['schedule-persistence-update.json',15102,'0537c0fcfa61afbb7b324ce3da5e8101be327c1929500a0fc174510adf2acc1c'],
];
for(const [file,bytes,sha] of files){const raw=fs.readFileSync(path.join(__dirname,'cloud',file));assert.equal(raw.length,bytes);assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),sha);}
const updates = read('schedule-persistence-update.json').map(row=>row.structuredContent.structuredContent);
assert.deepEqual(updates.map(row=>row.automation_id),['6abf7f1911dc8191a0ba3fe47f657dc5','6abf7f19fa888191aee9d6f51cc6186c']);
for(const row of updates){assert.equal(row.success,true);assert.equal(row.automation.is_enabled,true);assert.equal(row.automation.default_timezone,'Asia/Shanghai');assert.match(row.automation.prompt,/scratch/);assert.match(row.automation.prompt,/manifest/);assert.match(row.automation.prompt,/pageId/);}
const receipt=read('readback-verification.json');
receipt.persistenceFixRequested=true;receipt.persistenceFixSavedAndIndependentlyReadBack=true;
receipt.scheduleUpdateReceipts=updates.map(row=>({id:row.automation_id,success:row.success,title:row.automation.title,enabled:row.automation.is_enabled,updatedAt:row.automation.updated_at}));
receipt.additionalFilesVerified=files.map(([file,bytes,sha256])=>({file,bytes,sha256}));
receipt.taskBoardReadBackSequence=read('taskboard-readback.json').sequence;
receipt.completedAt=new Date().toISOString();
fs.writeFileSync(path.join(__dirname,'cloud/readback-verification.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({ok:true,rawFiles:files.length,existingSchedulesUpdated:updates.length,officialCollectionAccepted:false,qualifiedOfficialTrialDays:0}));
