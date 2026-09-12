'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {args,config,buildPlan,mappingNeedsRefresh,schedulingAttempts,filterEvidence,main}=require('./cli.cjs');

test('midnight refresh includes new tomorrow fixtures even when cache is only minutes old',()=>{
  const record={generatedAt:'2026-09-12T15:55:00Z',window:{today:'2026-09-12'}};
  assert.equal(mappingNeedsRefresh(record,'2026-09-12T15:59:00Z'),false);
  assert.equal(mappingNeedsRefresh(record,'2026-09-12T16:01:00Z'),true);
  assert.equal(mappingNeedsRefresh({...record,generatedAt:'invalid'},'2026-09-12T15:59:00Z'),true);
});
test('collection cannot use replay time or fixture overrides',()=>{
  assert.throws(()=>args(['collect-once','--now','2026-09-12T00:00:00Z']),/only for plan/);
  assert.throws(()=>args(['probe','--fixtures','fake.json']),/only for plan/);
  assert.equal(args(['plan','--now','2026-09-12T00:00:00Z']).options.now,'2026-09-12T00:00:00Z');
});
test('failed slots retry once after backoff; good observations and exhausted slots do not retry',()=>{
  const failure={taskKey:'lineup-at-30',status:'parse_error',receivedAt:'2026-09-12T13:35:00Z'};
  assert.equal(schedulingAttempts([failure],'2026-09-12T13:40:00Z').length,1);
  assert.equal(schedulingAttempts([failure],'2026-09-12T13:46:00Z').length,0);
  assert.equal(schedulingAttempts([failure,{...failure,receivedAt:'2026-09-12T13:46:00Z'}],'2026-09-12T13:58:00Z').length,1);
  assert.equal(schedulingAttempts([{...failure,status:'available'}],'2026-09-12T13:58:00Z').length,1);
});
test('export hides earlier evidence after team or provider mapping changes',()=>{
  const fixture={siteMatchId:'sporttery_1',eventVersion:'2026-09-12T14:00:00.000Z',kickoffUtc:'2026-09-12T14:00:00.000Z',homeName:'主队',awayName:'客队'};
  const valid={...fixture,providerMatchId:'2',data:{homeName:'主队',awayName:'客队',kickoffUtc:fixture.kickoffUtc}};
  const evidence={sections:{injuries:{latestValid:valid,latestAttempt:valid}}};
  assert.ok(filterEvidence(evidence,fixture,'2').sections.injuries.latestValid);
  assert.equal(filterEvidence(evidence,{...fixture,homeName:'更正球队'},'2').sections.injuries.latestValid,null);
  assert.equal(filterEvidence(evidence,fixture,'3').sections.injuries.latestValid,null);
});
test('default deployment gates prevent browser and database activity',async()=>{
  assert.equal(config({}).enabled,false);assert.equal(config({}).accessValidated,false);
  await assert.rejects(main(['collect-once'],{}),/Collection disabled/);
});
test('worker budgets have bounded defaults and reject invalid configuration',()=>{
  assert.equal(config({}).maxPages,12);
  assert.equal(config({}).maxRunSeconds,480);
  assert.equal(config({LEISU_MAX_PAGES_PER_RUN:'1',LEISU_MAX_RUN_SECONDS:'60'}).maxPages,1);
  for(const value of ['0','101','1.5','bad'])assert.throws(()=>config({LEISU_MAX_PAGES_PER_RUN:value}),/page budget/);
  for(const value of ['59','481','60.5','bad'])assert.throws(()=>config({LEISU_MAX_RUN_SECONDS:value}),/run budget/);
});
test('today/tomorrow plan contains only verified eligible fixtures and no automatic odds',()=>{
  const now='2026-09-12T04:00:00Z';
  const matches=[12,13,14].map((day,i)=>({id:'sporttery_'+(100+i),sourceMatchId:String(100+i),
    homeTeamName:'主队',awayTeamName:'客队',status:'SCHEDULED',kickoffTime:`2026-09-${day}T22:00:00+08:00`}));
  const mappings=matches.map((m,i)=>({siteMatchId:m.id,providerMatchId:String(200+i),homeName:'主队',awayName:'客队',
    kickoffUtc:new Date(m.kickoffTime).toISOString(),verifiedAt:'2026-09-12T03:00:00Z'}));
  const result=buildPlan({matches,offline:true},mappings,[],now);
  assert.equal(result.selected.length,2);assert.equal(result.tasks.length,2);assert.equal(result.automaticOddsEnabled,false);
  assert.ok(result.excluded.some(x=>x.reason==='outside-today-tomorrow'));
});
