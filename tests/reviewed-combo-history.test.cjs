'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {restoreArchivedCombos,validateArchive}=require('../scripts/recommendationPlatform/reviewedComboHistory.cjs');
const archiveFile=path.resolve(__dirname,'../scripts/recommendationPlatform/reviewedComboHistory/2026-10-10.json');
const original=JSON.parse(fs.readFileSync(archiveFile,'utf8')),now='2026-10-11T01:00:00.000Z';
const copy=v=>JSON.parse(JSON.stringify(v));
function history(){const {contentHash,...body}=copy(original.view);void contentHash;return p.seal({...body,updatedAt:now,combos:[],threeCombos:[]});}
test('retained exact online view restores original three pairs without changing singles, archive, clocks or creating triples',()=>{
 a.equal(p.sha(fs.readFileSync(archiveFile)),'f2e3903a44100c1c55359f54802b65dd073e73c14926b0af0882da527ca12242');
 const input=history(),before=JSON.stringify(input),result=restoreArchivedCombos(input,now);
 a.equal(JSON.stringify(input),before);a.deepEqual(result.records,input.records);a.equal(result.updatedAt,now);a.deepEqual(result.combos,[]);a.deepEqual(result.threeCombos,[]);
 a.deepEqual(result.comboArchive,original);a.deepEqual(result.comboArchive.view.combos.map(c=>c.product),[2.5026,5.035,10.011]);
 a.equal(result.comboArchive.view.updatedAt,'2026-10-10T12:16:39.396Z');a.equal(result.comboArchive.view.contentHash,'cd26c576a0aaddf004006337397a55063e2520fbdef80b24090b4eee373ee2cb');
 a.equal(Object.hasOwn(result.comboArchive.view,'threeCombos'),false);const{contentHash,...body}=result;a.equal(p.hash(body),contentHash);
});
test('archive-free days and different real publication batches keep singles unchanged',()=>{
 const missing=p.seal({...history(),businessDate:'2026-10-09'});a.equal(restoreArchivedCombos(missing,now),missing);
 for(const change of [v=>v.publicationHash='a'.repeat(64),v=>v.draftHash='b'.repeat(64),v=>v.records[0].sp+=0.01]){const v=history();change(v);a.equal(restoreArchivedCombos(v,now),v);}
});
for(const [name,change]of[
 ['source receipt',v=>v.source.receiptSha256='a'.repeat(64)],
 ['source observation at cutoff',v=>v.source.observedAt='2026-10-10T15:00:00Z'],
 ['source view bytes',v=>v.source.viewJsonSha256='a'.repeat(64)],
 ['original selection',v=>v.view.combos[0].legs[0].selection='a'],
 ['original price',v=>v.view.combos[0].legs[0].sp=9],
 ['original handicap',v=>v.view.combos[0].legs[1].handicap=2],
 ['product',v=>v.view.combos[0].product=3],
 ['original observation clock',v=>v.view.updatedAt=now],
 ['duplicate event',v=>v.view.records[1]=v.view.records[0]],
 ['manufactured triples',v=>v.view.threeCombos=[{legs:[]}]],
])test('reject altered archive '+name,()=>{const v=copy(original);change(v);a.throws(()=>validateArchive(v,history(),now),/HISTORICAL_COMBO_/);});
for(const [name,change]of[
 ['past read clock',()=> '2026-10-10T13:00:00Z'],
 ['before history clock',()=> '2026-10-11T00:00:00Z'],
 ['invalid read clock',()=> 'unknown'],
])test('reject '+name,()=>a.throws(()=>validateArchive(original,history(),change()),/HISTORICAL_COMBO_/));
test('fresh history must retain all exact original records and its valid seal',()=>{
 const bad=history();bad.records[0].selection='h';a.throws(()=>validateArchive(original,bad,now),/HISTORY_SEAL/);
 const {contentHash,...body}=bad;void contentHash;a.throws(()=>validateArchive(original,p.seal(body),now),/RECORDS/);
});
