'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {collectResults,validResultEvent}=require('../scripts/recommendationPlatform/results.cjs');
const {buildExperiment,compareVersions,validSeal}=require('../scripts/recommendationPlatform/strategyVersionComparison.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const GENERATED='2026-09-17T14:30:00Z',RESULT_AT='2026-09-17T17:00:00Z';
function source(){
 const d=structuredClone(makeDecision(match(1,NOW,{probabilityModel:{generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}},calculationTrace:{poisson:{lambdas:{home:1.5,away:1}}}}}),{now:NOW,publication:publication(NOW)}).decision);
 return {version:'precutoff-target-versions-readonly-v1',readOnly:'on',productionWrites:0,observedAt:'2026-09-17T14:10:00Z',latestFull:[d],matches:[],currentResultHeads:[],
  versions:[{sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,decisionId:d.decisionId,recordHash:d.recordHash,
   publishedAt:d.publishedAt,cutoffTime:d.cutoffTime,publication:d.publication,sourceCycleId:d.sourceCycleId,
   primaryPickPolicyVersion:d.primaryPickPolicyVersion,coherentPrimary:d.coherentPrimary,upstreamModelVersion:d.upstreamModelVersion,
   HAD:{code:d.tipCode,probabilities:d.probabilities,quoteOdds:d.quoteOdds},HHAD:null,supplementaryResearch:d.supplementaryResearch}]};
}
const options={generatedAt:GENERATED,sourceSha256:'a'.repeat(64),codeCommit:'b'.repeat(40),codeHashes:{policy:'c'.repeat(64)}};
function experiment(s=source(),o=options){const bytes=Buffer.from(JSON.stringify(s));return buildExperiment(bytes,{...o,sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
function finalEvent(d,{home=1,away=0,revision=0,observedAt=RESULT_AT}={}){
 const row={...d,status:'FINISHED',scoreHome:home,scoreAway:away,resultRevision:revision,resultSource:'sporttery:official-api',resultObservedAt:observedAt};
 const e=collectResults([row],new Map(),{isFinal:r=>r.status==='FINISHED',isVoid:()=>false},Date.parse(observedAt)).updates[0];
 assert(validResultEvent(e));return e;
}
const reseal=r=>{const {contentHash,...body}=r;return {...body,contentHash:hash(body)};};

test('new replay freezes actual after-cutoff time and unchanged independent model p, never formal status',()=>{
 const s=source(),before=JSON.stringify(s),{shadow,archive}=experiment(s);
 assert(validSeal(shadow)&&validSeal(archive));assert.equal(JSON.stringify(s),before);
 const row=shadow.rows[0];assert.equal(row.afterCutoff,true);assert.equal(row.beforeKickoff,true);
 assert.equal(row.formalHitRateEligible,false);assert.equal(row.researchComparisonEligible,true);
 assert.equal(row.primary,null);assert.equal(row.companion,null);assert.equal(row.modelTendency.tipCode,'1');
 assert.deepEqual(row.fullHADDistribution,s.latestFull[0].probabilities);
 assert.equal(row.generatedAt,GENERATED);assert.equal(row.inputPublishedAt,s.latestFull[0].publishedAt);
 assert.equal(row.topScores.length,3);assert.equal(row.scoreRule,'global-unconditional-top3; no conditional branch filter');
});
test('bad source, future generation, corrupted frozen record and wrong latest archive binding fail closed',()=>{
 for(const mutate of [s=>s.readOnly='off',s=>s.productionWrites=1,s=>s.latestFull[0].recordHash='e'.repeat(64),
  s=>s.versions[0].recordHash='e'.repeat(64),s=>s.versions[0].publishedAt='2026-09-17T14:01:00Z',
  s=>s.versions[0].HAD.probabilities={'1':.9,X:.4,'2':.2}]){
  const s=source();mutate(s);assert.throws(()=>experiment(s));
 }
 assert.throws(()=>experiment(source(),{...options,generatedAt:'2026-09-17T14:00:00Z'}));
 assert.throws(()=>experiment(source(),{...options,codeCommit:'b'.repeat(64)}));
});
test('pending results have null accuracy and contribute no misses to any version',()=>{
 const {shadow,archive}=experiment(),r=compareVersions(shadow,archive,[],{asOf:GENERATED});
 assert(validSeal(r));assert.equal(r.finalConfirmed,0);
 for(const s of Object.values(r.summary)){assert.equal(s.settled,0);assert.equal(s.lost,0);assert.equal(s.hitRate,null);}
 assert.equal(r.archiveCohorts[0].HAD.pending,1);
});
test('verified ninety-minute result resolves each market separately without rewriting frozen versions',()=>{
 const s=source(),{shadow,archive}=experiment(s),original=JSON.stringify({shadow,archive});
 const e=finalEvent(s.latestFull[0]);
 const report=compareVersions(shadow,archive,[e],{asOf:RESULT_AT});
 assert.equal(report.finalConfirmed,1);assert.equal(report.summary.v2ModelTendency.won,1);
 assert.equal(report.summary.marketBaseline.won,1);assert.equal(report.summary.originalHAD.won,1);
 assert.equal(JSON.stringify({shadow,archive}),original);assert.equal(report.formalHitRateEligible,false);
});
test('future, corrupt and wrong-team result heads are disputed, never counted as a miss',()=>{
 const s=source(),{shadow,archive}=experiment(s),d=s.latestFull[0],e=finalEvent(d);
 for(const event of [{...e,scoreHome:9},finalEvent({...d,homeTeamId:'wrong'}),finalEvent(d,{observedAt:'2026-09-17T18:00:00Z'})]){
  const r=compareVersions(shadow,archive,[event],{asOf:RESULT_AT});
  assert.equal(r.finalConfirmed,0);assert.equal(r.summary.v2ModelTendency.disputed,1);assert.equal(r.summary.v2ModelTendency.settled,0);
 }
});
test('post-kickoff generated shadow is excluded even when original publications can settle',()=>{
 const s=source(),{shadow,archive}=experiment(s,{...options,generatedAt:'2026-09-17T15:01:00Z'});
 const r=compareVersions(shadow,archive,[finalEvent(s.latestFull[0])],{asOf:RESULT_AT});
 assert.equal(r.summary.v2ModelTendency.excluded,1);assert.equal(r.summary.v2ModelTendency.settled,0);
 assert.equal(r.summary.originalHAD.won,1);
});
test('repeated original versions remain separate per-publication cohorts, with one independent event',()=>{
 const s=source();const older=structuredClone(s.versions[0]);older.decisionId='decision_old';older.recordHash='f'.repeat(64);older.publishedAt='2026-09-17T09:50:00Z';s.versions.unshift(older);
 const {shadow,archive}=experiment(s),r=compareVersions(shadow,archive,[finalEvent(s.latestFull[0])],{asOf:RESULT_AT});
 assert.equal(archive.rows.length,2);assert.equal(archive.independentMatchCount,1);assert.equal(r.archiveCohorts.length,2);
 assert(r.archiveCohorts.every(c=>c.independentMatchCount===1&&c.HAD.settled===1));assert.equal(r.summary.originalHAD.settled,1);
});
test('changed experiment bytes cannot settle and top3 coverage remains separate from top1',()=>{
 const s=source(),{shadow,archive}=experiment(s),corrupt=structuredClone(shadow);corrupt.rows[0].modelTendency.tipCode='2';
 assert.throws(()=>compareVersions(corrupt,archive,[],{asOf:GENERATED}));
 const score=shadow.rows[0].topScores[1];const r=compareVersions(shadow,archive,[finalEvent(s.latestFull[0],score)],{asOf:RESULT_AT});
 assert.equal(r.summary.v2GlobalScoreTop3.won,1);assert.equal(r.summary.v2GlobalScoreTop1.lost,1);assert.match(r.warning,/three selections/);
 const wrong=reseal({...archive,sourceSha256:'f'.repeat(64)});assert.throws(()=>compareVersions(shadow,wrong,[],{asOf:GENERATED}));
});
test('duplicate archive rows, malformed cutoff clocks and original-byte hash substitution are rejected',()=>{
 const s=source();s.versions.push(structuredClone(s.versions[0]));assert.throws(()=>experiment(s));
 const broken=source();broken.versions[0].cutoffTime='garbage';assert.throws(()=>experiment(broken));
 assert.throws(()=>buildExperiment(Buffer.from(JSON.stringify(source())),options),/Source file hash mismatch/);
});
test('coherent publications without an HHAD selection never inherit the internal conditional direction',()=>{
 const s=source();s.versions[0].HHAD={line:-1,tipCode:'2',overallTipCode:'2',overallProbabilities:{'1':.2,X:.3,'2':.5}};
 assert.equal(s.versions[0].coherentPrimary.hhadCode,null);
 const {shadow,archive}=experiment(s);assert.equal(archive.rows[0].HHAD,null);
 const r=compareVersions(shadow,archive,[finalEvent(s.latestFull[0])],{asOf:RESULT_AT});
 assert.equal(r.archiveCohorts[0].HHAD.excluded,1);assert.equal(r.archiveCohorts[0].HHAD.settled,0);
});
test('malformed unrelated heads are isolated, exact future nanoseconds dispute, and a genuine pregame VOID remains void',()=>{
 const s=source(),{shadow,archive}=experiment(s),d=s.latestFull[0];
 const good=finalEvent(d);
 assert.equal(compareVersions(shadow,archive,[{eventVersion:'garbage'},good],{asOf:RESULT_AT}).summary.v2ModelTendency.won,1);
 const future=finalEvent(d);
 // collectResults normalizes its operation clock to ms; retain a genuine
 // provider-compatible event observation representation for the boundary.
 future.observedAt='2026-09-17T17:00:00.000000002Z';assert(validResultEvent(future));
 assert.equal(compareVersions(shadow,archive,[future],{asOf:'2026-09-17T17:00:00.000000001Z'}).summary.v2ModelTendency.disputed,1);
 const voided=collectResults([{...d,resultDisposition:'VOID',voidSource:'sporttery:official-api'}],new Map(),
  {isFinal:()=>false,isVoid:()=>true},Date.parse(GENERATED)).updates[0];assert(validResultEvent(voided));
 assert.equal(compareVersions(shadow,archive,[voided],{asOf:GENERATED}).summary.v2ModelTendency.void,1);
});
