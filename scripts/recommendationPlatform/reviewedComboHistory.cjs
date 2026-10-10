'use strict';
// Retained observations are display-only history. Never regenerate an old
// combination or use this archive as a current publication/settlement input.
const fs=require('node:fs'),path=require('node:path');
const p=require('./reviewedAnalysis.cjs');
const {day}=require('../../src/services/publishedForecastPolicy.cjs');
const {epochNanoseconds}=require('../../src/services/prematchV3Clock.cjs');
const catalog=Object.freeze({
 '2026-10-10':Object.freeze({
  file:'2026-10-10.json',sha256:'f2e3903a44100c1c55359f54802b65dd073e73c14926b0af0882da527ca12242',
  receiptSha256:'f5f085f915f8441ada6e6c6d2fb4bedcf1eb1c9966639a43b440757bbeeed324',
  intentSha256:'c568269b48a8a656691daedab9d5ee07053717a8877da41c2f1b5165c00cc924',
  releaseSha256:'24dc8ab5a1462febd55079f4f8236c92f86b9e52a08ce79a54434ae2bb87ec5f',
  viewJsonSha256:'a3b6c9caadbe3b3d06c393adec8e573ca1c21d2891baf23817208811694c1d2b',
  observedAt:'2026-10-10T12:17:26.709Z',
  firstVersionFile:'2026-10-10-first-version.json',firstVersionSha256:'2a36a1d81242b169e2fa9bdea3785fc776faf6299444f21ff8c5f493040c722b',
  screenshotSha256:'8d8d9c795c7c7db998b21d8ef9601e244528ffb3cca8fb5f05ba3e46ed6d12df',
 }),
});
const check=(ok,code)=>p.check(ok,'HISTORICAL_COMBO_'+code);
const stamp=value=>{const ns=epochNanoseconds(value);check(ns!==null,'CLOCK');return ns;};
function loadArchive(entry){return loadFile(entry.file,entry.sha256);}
function loadFile(name,digest){
 const file=path.join(__dirname,'reviewedComboHistory',name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);check(s.isFile()&&s.size>0&&s.size<=65536,'BOUND');const b=Buffer.alloc(s.size);check(fs.readSync(fd,b,0,b.length,0)===b.length,'READ');check(p.sha(b)===digest,'SOURCE_BYTES');return JSON.parse(b.toString('utf8'));}
 finally{fs.closeSync(fd);}
}
function exactProduct(legs){
 let coefficient=1n,places=0;
 for(const leg of legs){check(Number.isFinite(leg.sp)&&leg.sp>1&&leg.sp<1000,'SP');const [whole,fraction='']=String(leg.sp).split('.');check(/^\d+$/.test(whole)&&/^\d{0,4}$/.test(fraction),'SP');coefficient*=BigInt(whole+fraction);places+=fraction.length;}
 const digits=String(coefficient).padStart(places+1,'0');return Number(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits);
}
function validateArchive(archive,history,asOf){
 const entry=catalog[history?.businessDate];check(entry,'DAY');
 check(archive?.version==='reviewed-combo-history-archive-v1'&&archive.businessDate===history.businessDate,'ENVELOPE');
 const source=archive.source,view=archive.view;
 check(source&&source.productionWrites===0&&['receiptSha256','intentSha256','releaseSha256','viewJsonSha256','observedAt'].every(k=>source[k]===entry[k]),'SOURCE');
 check(view&&p.sha(JSON.stringify(view))===entry.viewJsonSha256,'VIEW_BYTES');
 const {contentHash,...body}=view;check(p.hash(body)===contentHash&&view.version==='reviewed-analysis-view-v1'&&view.businessDate===history.businessDate&&view.formalEligible===false,'VIEW_SEAL');
 const {contentHash:historyHash,...historyBody}=history;check(p.hash(historyBody)===historyHash&&history.version===view.version&&history.formalEligible===false,'HISTORY_SEAL');
 check(Number.isFinite(Date.parse(asOf))&&day(Date.parse(asOf))>view.businessDate&&stamp(history.updatedAt)<=stamp(asOf)&&stamp(source.observedAt)<=stamp(asOf),'HISTORY_CLOCK');
 check(stamp(view.createdAt)<stamp(view.commitObservedAt)&&stamp(view.commitObservedAt)<=stamp(view.updatedAt)&&stamp(view.updatedAt)<=stamp(source.observedAt),'OBSERVATION_CLOCK');
 check(view.publicationHash===history.publicationHash&&view.draftHash===history.draftHash&&view.originalFrozenAt===history.originalFrozenAt,'PUBLICATION');
 check(Array.isArray(view.records)&&view.records.length===27&&p.hash(view.records)===p.hash(history.records),'RECORDS');
 check(Array.isArray(history.combos)&&history.combos.length===0&&Array.isArray(history.threeCombos)&&history.threeCombos.length===0&&!Object.hasOwn(history,'comboArchive'),'HISTORY_EMPTY');
 // This original observation predates three-leg support. Preserve that absence.
 check(!Object.hasOwn(view,'threeCombos')&&Array.isArray(view.combos)&&view.combos.length===3,'ORIGINAL_COMBOS');
 const records=new Map(view.records.map(r=>[r.eventId,r]));check(records.size===27,'EVENTS');const groups=new Set(),bands=new Set();
 for(const combo of view.combos){
  check([2.5,5,10].includes(combo.band)&&!bands.has(combo.band)&&Array.isArray(combo.legs)&&combo.legs.length===2,'COMBO');bands.add(combo.band);
  const ids=new Set();const bound=combo.legs.map(leg=>{
   const row=records.get(leg.eventId);check(row&&!ids.has(leg.eventId),'LEG');ids.add(leg.eventId);
   const expected={eventId:row.eventId,matchNum:row.matchNum,market:row.market,...(row.market==='HHAD'?{handicap:row.handicap}:{}),selection:row.selection,sp:row.sp};check(p.hash(leg)===p.hash(expected),'LEG_BINDING');
   check(row.businessDate===view.businessDate&&stamp(row.publicationCommitObservedAt??view.commitObservedAt)<=stamp(view.updatedAt)&&stamp(source.observedAt)<stamp(row.cutoffAt)&&stamp(row.cutoffAt)<=stamp(row.eventVersion),'LEG_CLOCK');return row;
  });
  const group=[...ids].sort().join('/');check(!groups.has(group),'DUPLICATE');groups.add(group);
  check(combo.product===exactProduct(combo.legs)&&combo.product>=combo.band,'PRODUCT');
  const confidence=bound.some(r=>r.confidence==='低')?'低':bound.some(r=>r.confidence==='中')?'中':'高';check(combo.confidence===confidence,'CONFIDENCE');
 }
 return true;
}
function restoreArchivedCombos(history,asOf){
 const entry=catalog[history?.businessDate];if(!entry)return history;
 const archive=loadArchive(entry);
 // A retained observation of a different batch cannot authorize this history.
 // Keep valid singles visible when no exact original combination view matches.
 if(archive.view.publicationHash!==history.publicationHash||archive.view.draftHash!==history.draftHash||p.hash(archive.view.records)!==p.hash(history.records))return history;
 validateArchive(archive,history,asOf);
 const firstVersion=loadFile(entry.firstVersionFile,entry.firstVersionSha256);
 validateFirstVersion(firstVersion,history,asOf);
 const {contentHash,...body}=history;void contentHash;
 return p.seal({...body,comboArchive:{...archive,firstVersion}});
}
function validateFirstVersion(first,history,asOf){
 const entry=catalog[history?.businessDate],{contentHash,...body}=first??{};
 check(entry&&p.hash(body)===contentHash&&first.version==='reviewed-combo-user-first-version-v1'&&first.businessDate===history.businessDate,'FIRST_SEAL');
 check(first.source?.kind==='user-provided-screenshot'&&first.source.imageSha256===entry.screenshotSha256&&first.source.originalObservedAt===null
  &&stamp(first.source.suppliedAt)<=stamp(asOf)&&first.productionWrites===0&&first.settlementEligible===false,'FIRST_SOURCE');
 check(p.hash(first.recordHashes)===p.hash(history.records.map(r=>p.hash(r))),'FIRST_RECORDS');
 check(Array.isArray(first.combos)&&first.combos.length===3&&!Object.hasOwn(first,'threeCombos'),'FIRST_COMBOS');
 const records=new Map(history.records.map(r=>[r.eventId,r])),bands=new Set(),groups=new Set();
 for(const combo of first.combos){
  check([2.5,5,10].includes(combo.band)&&!bands.has(combo.band)&&Array.isArray(combo.legs)&&combo.legs.length===2,'FIRST_BAND');bands.add(combo.band);
  const bound=combo.legs.map(leg=>{const r=records.get(leg.eventId);check(r,'FIRST_LEG');const expected={eventId:r.eventId,matchNum:r.matchNum,market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp:r.sp};check(p.hash(leg)===p.hash(expected),'FIRST_BINDING');return r;});
  const group=bound.map(r=>r.eventId).sort().join('/');check(bound[0].eventId!==bound[1].eventId&&!groups.has(group),'FIRST_DUPLICATE');groups.add(group);
  check(combo.product===exactProduct(combo.legs)&&combo.product>=combo.band,'FIRST_PRODUCT');
  check(combo.confidence===(bound.some(r=>r.confidence==='低')?'低':bound.some(r=>r.confidence==='中')?'中':'高'),'FIRST_CONFIDENCE');
 }
 return true;
}
module.exports={restoreArchivedCombos,validateArchive,validateFirstVersion};
