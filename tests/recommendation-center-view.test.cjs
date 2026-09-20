'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const ts=require(process.env.TYPESCRIPT_LIBRARY||'typescript');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recommendation-center-test-'));
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const source=fs.readFileSync(path.join(__dirname,'../src/services/recommendationCenterView.ts'),'utf8');
fs.writeFileSync(path.join(dir,'view.cjs'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
const {parseRecommendationCenter,visiblePreview,primarySelectionSummary}=require(path.join(dir,'view.cjs'));
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {match,memoryPorts,validators}=require('./recommendationFixture.cjs');
async function sample(){const p=memoryPorts();await createRuntime(p,{validators}).publishingCycle();return {recommendationCenter:p.state.view};}
test('the actual runtime projection parses for current UI',async()=>{const x=parseRecommendationCenter(await sample());assert.equal(x.current.length,3);assert.equal(x.previews.length,2);assert.equal(x.review.statistics.single.published,3);});
test('missing product field is a read error rather than an empty successful recommendation pool',()=>assert.throws(()=>parseRecommendationCenter({ok:true,previews:[],today:[]})));
test('invalid numbers are rejected before .toFixed',async()=>{for(const v of [null,'1.8',NaN,true]){const x=await sample();x.recommendationCenter.current[0].decision.odds=v;assert.throws(()=>parseRecommendationCenter(x));}});
test('a changed combo direction cannot be presented as the same decision',async()=>{const x=await sample();x.recommendationCenter.previews[0].legs[0].tipCode='2';assert.throws(()=>parseRecommendationCenter(x));});
test('each combo leg requires the exact decision ID',async()=>{const x=await sample();x.recommendationCenter.previews[0].decisionIds[0]='other';assert.throws(()=>parseRecommendationCenter(x));});
test('late publication timestamp rejects the row',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.publishedAt='2026-09-17T17:00:00Z';assert.throws(()=>parseRecommendationCenter(x));});
test('uncalibrated status cannot be disguised as a validated prediction',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.modelValidation='validated';assert.throws(()=>parseRecommendationCenter(x));});
test('wrong probability vector is rejected',async()=>{const x=await sample();x.recommendationCenter.current[0].decision.probabilities['1']=.8;assert.throws(()=>parseRecommendationCenter(x));});
test('missing summary or contradictory counts fail instead of showing zero performance',async()=>{for(const apply of [x=>delete x.review.statistics.single,x=>x.review.statistics.single.won=999]){const x=await sample();apply(x.recommendationCenter);assert.throws(()=>parseRecommendationCenter(x));}});
test('hit rate is recomputed from audited counts, not trusted as another unrelated field',async()=>{const x=await sample();x.recommendationCenter.review.statistics.single.hitRate=1;assert.equal(parseRecommendationCenter(x).review.statistics.single.hitRate,null);});
test('preview becomes unavailable after cutoff or quote staleness',async()=>{const p=parseRecommendationCenter(await sample()).previews[0];assert.equal(visiblePreview(p,Date.parse('2026-09-17T14:00:00Z')),false);assert.equal(visiblePreview(p,Date.parse('2026-09-17T10:16:00Z')),false);});
test('settlement failure leaves visible publications and a separate stale-review state',async()=>{const p=memoryPorts(),r=createRuntime(p,{validators});await r.publishingCycle();p.faults.add('history');await r.settlementCycle();const x=parseRecommendationCenter({recommendationCenter:p.state.view});assert.equal(x.current.length,3);assert.equal(x.lanes.settlement.status,'error');});
test('frozen records remain parseable across midnight and retain bound IDs',async()=>{const p=memoryPorts();p.now=Date.parse('2026-09-17T13:00:00Z');p.current=[1,2,3].map(id=>match(id,p.now));const r=createRuntime(p,{validators});await r.publishingCycle();p.now=Date.parse('2026-09-17T17:00:00Z');await r.view();const x=parseRecommendationCenter({recommendationCenter:p.state.view});assert.equal(x.review.combos.length,2);assert.equal(x.todayCombos.length,0);});

test('handicap calibration profile is exposed even before groups become active',async()=>{const x=parseRecommendationCenter(await sample());assert.equal(x.review.handicapCalibration.version,'handicap-calibration-v2');assert.equal(typeof x.review.handicapCalibration.profileHash,'string');assert.equal(x.review.handicapCalibration.sampleRows,0);});
test('tampered handicap calibration profile is rejected by frontend parsing',async()=>{const x=await sample();x.recommendationCenter.review.handicapCalibration.profileHash='bad';assert.throws(()=>parseRecommendationCenter(x));});

test('top-card summary exposes both straight and handicap primary picks without opening details',()=>{
  const summary=primarySelectionSummary({tipCode:'1',odds:1.72,modelProbability:.61,handicapAnalysis:{tipCode:'X',handicapLine:-1,handicapLineText:'-1',modelProbability:.38,marketReference:{selectedOdds:3.45},historicalCalibration:{applied:true}}});
  assert.deepEqual(summary,{had:{code:'1',odds:1.72,probability:.61},handicap:{code:'X',line:-1,lineText:'-1',probability:.38,odds:3.45,calibrated:true,conditional:false,overallCode:null}});
});
test('top-card summary keeps handicap slot explicitly unavailable when no handicap analysis exists',()=>{
  const summary=primarySelectionSummary({tipCode:'2',odds:2.1,modelProbability:.47,handicapAnalysis:null});
  assert.equal(summary.had.code,'2');assert.equal(summary.handicap,null);
});

test('top-card summary uses coherent companion direction even when standalone HHAD diagnostic differs',()=>{
  const summary=primarySelectionSummary({tipCode:'1',odds:1.6,modelProbability:.6,handicapAnalysis:{tipCode:'X',handicapLine:-1,handicapLineText:'-1',modelProbability:.7,probabilityBasis:'conditional-on-straight-primary',overallTipCode:'2',marketReference:null,historicalCalibration:{applied:false}}});
  assert.equal(summary.had.code,'1');assert.equal(summary.handicap.code,'X');assert.equal(summary.handicap.conditional,true);assert.equal(summary.handicap.overallCode,'2');
});
