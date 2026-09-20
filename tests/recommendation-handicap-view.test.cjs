'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'handicap-view-'));after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
for(const name of ['recommendationCenterView']){const s=fs.readFileSync(path.join(__dirname,'../src/services/'+name+'.ts'),'utf8');fs.writeFileSync(path.join(tmp,name+'.js'),ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);}
const {parseRecommendationCenter}=require(path.join(tmp,'recommendationCenterView.js'));
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,validators,NOW,match}=require('./recommendationFixture.cjs');
async function feed(){const p=memoryPorts();p.current=[1,2,3].map(id=>{const m=match(id);m.handicapLine='-1';m.handicapOddsUpdatedAt=new Date(NOW).toISOString();m.probabilityModel.calculationTrace={poisson:{lambdas:{home:1.8,away:.7}}};return m;});await createRuntime(p,{validators}).publishingCycle();return {recommendationCenter:structuredClone(p.state.view)};}
test('actual API shape preserves optional handicap details',async()=>{const r=parseRecommendationCenter(await feed());assert.equal(r.current[0].decision.handicapAnalysis.status,'ready');assert.equal(r.previews.length,2);});
test('bad optional shape cannot be rendered as a valid probability',async()=>{const x=await feed();x.recommendationCenter.current[0].decision.handicapAnalysis.probabilities.X=null;assert.throws(()=>parseRecommendationCenter(x));});
test('handicap snapshot cannot cross-bind another event',async()=>{const x=await feed();x.recommendationCenter.current[0].decision.handicapAnalysis.snapshot.sourceMatchId='999';assert.throws(()=>parseRecommendationCenter(x));});
test('conditional distribution cannot masquerade as unconditional',async()=>{const x=await feed();const a=x.recommendationCenter.current[0].decision.handicapAnalysis;a.conditionalOnPrimary={'1':0,X:1,'2':0};assert.throws(()=>parseRecommendationCenter(x));});
test('unknown handicap has a visible unavailability state without suppressing single',async()=>{const x=await feed();x.recommendationCenter.current[0].decision.handicapAnalysis={version:'net-margin-hhad-v1',status:'unavailable',line:-1,reason:'goal-margin-model-missing'};delete x.recommendationCenter.current[0].settlement.handicap;const r=parseRecommendationCenter(x);assert.equal(r.current.length,3);assert.equal(r.current[0].decision.handicapAnalysis.status,'unavailable');});
