'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {match,NOW} = require('./recommendationFixture.cjs');
const {makeDecision,validDecision} = require('../scripts/recommendationPlatform/decision.cjs');
const {bindMatchDetailAlias,DETAIL_ALIAS_DECISION_HEADS_SQL,decisionRowMatchesPayload} = require('../server/matchDetailIdentity.cjs');
const {acceptMatchDetail,detailBindingBody,detailResponseMatchesFields,exactDetailClock} = require('../src/services/matchDetailIdentity.js');
const {readPostgresMatchDetailById} = require('../server/postgresProjectionStore.cjs');
const clone = structuredClone;
function setup() {
  const raw = match(2041812,NOW,{matchNo:'周四001',buyEndTime:'2026-09-17T15:00:00Z',
    sourceObservedAt:new Date(NOW+1000).toISOString(),sourceReceivedAt:new Date(NOW+1000).toISOString()});
  const publication = {mode:'active-generation',generationId:'g-identity-test',manifestHash:'a'.repeat(64),
    sourceCycleId:'sporttery-full-sync:identity-test',committedAt:new Date(NOW-1000).toISOString()};
  const decision = makeDecision(raw,{now:NOW,publication}).decision;
  assert.ok(decision && validDecision(decision),'fixture must be an actual valid frozen decision');
  const canonical = {...raw,id:'fivehundred_2041812',buyEndTime:'2026-09-17 23:00:00',predictionMeta:{cutoffTime:'2026-09-17T23:00:00+08:00'}};
  return {requestedId:raw.id,candidates:[canonical],decisions:[clone(decision)],publication,observedAt:new Date(NOW+2000).toISOString()};
}
const hashBinding = m => { m.detailIdentity.contentHash = crypto.createHash('sha256').update(JSON.stringify(detailBindingBody(m.detailIdentity))).digest('hex');return m; };
test('verified frozen alias opens original canonical row without changing stored identity or predictions',async () => {
  const input=setup(),before=JSON.stringify(input),result=bindMatchDetailAlias(input);
  assert.equal(result.id,'fivehundred_2041812');assert.equal(JSON.stringify(input),before);
  assert.deepEqual(result.predictions,input.candidates[0].predictions);
  assert.equal(result.detailIdentity.decisionRecordHash,input.decisions[0].recordHash);
  assert.equal(result.detailIdentity.deadlineBasis,'sporttery-buyEndTime-frozen-identity');
  assert.equal(await acceptMatchDetail(input.requestedId,result,{now:NOW+3000}),true);
  assert.equal(await acceptMatchDetail(result.id,result,{now:NOW+3000}),false,'alias proof cannot be reused as an exact-route proof');
  assert.equal(detailResponseMatchesFields(input.requestedId,result,NOW+3000),true);
  assert.equal(detailResponseMatchesFields(result.id,result,NOW+3000),false);
});
for (const [name,patch] of [
  ['missing team ID',{homeTeamId:undefined}],['swapped ordered IDs',{homeTeamId:'a2041812',awayTeamId:'h2041812'}],
  ['missing business day',{businessDate:undefined}],['different business day',{businessDate:'2026-09-18'}],
  ['missing official number',{matchNo:undefined}],['different official number',{matchNo:'周四002'}],
  ['conflicting number alias',{matchNumStr:'周四002'}],['missing event version',{eventVersion:undefined}],
  ['nanosecond event conflict',{eventVersion:'2026-09-17T15:00:00.000000001Z'}],
  ['invalid calendar',{kickoffTime:'2026-09-31T15:00:00Z'}],['conflicting cutoff alias',{cutoffTime:'2026-09-17T14:59:59Z'}],
  ['missing source observation',{sourceObservedAt:undefined}],['future source observation',{sourceObservedAt:new Date(NOW+9000).toISOString()}],
  ['wrong source ID',{sourceMatchId:'999'}],['arbitrary provider prefix',{id:'another_2041812'}],
]) test(`server rejects ${name}`,() => {const input=setup();Object.assign(input.candidates[0],patch);assert.equal(bindMatchDetailAlias(input),null);});
test('a shared source suffix with two actual events is ambiguous even if current is first',() => {
  const input=setup();input.candidates.push({...clone(input.candidates[0]),kickoffTime:'2026-09-18T15:00:00Z',eventVersion:'2026-09-18T15:00:00Z'});
  assert.equal(bindMatchDetailAlias(input),null);
});
test('missing/corrupt frozen anchors and non-active generation are refused',() => {
  for (const mutate of [s=>{s.decisions=[];},s=>{s.decisions[0].recordHash='b'.repeat(64);},s=>{s.publication.mode='legacy-bootstrap';},
    s=>{s.publication.committedAt=new Date(NOW+3000).toISOString();},s=>{s.decisions=Array(17).fill(s.decisions[0]);}]) {
    const input=setup();mutate(input);assert.equal(bindMatchDetailAlias(input),null);
  }
});
test('browser validation and cache replay refuse hash/generation/request/source clock drift',async () => {
  const input=setup(),resolved=bindMatchDetailAlias(input);
  assert.equal(await acceptMatchDetail('sporttery_999',resolved,{now:NOW+3000}),false);
  assert.equal(await acceptMatchDetail(input.requestedId,resolved,{now:NOW+3000,expectedGenerationId:'g-another'}),false);
  assert.equal(await acceptMatchDetail(input.requestedId,resolved,{now:NOW+1999}),false);
  const changed=clone(resolved);changed.detailIdentity.contentHash='b'.repeat(64);
  assert.equal(await acceptMatchDetail(input.requestedId,changed,{now:NOW+3000}),false);
  const clock=clone(resolved);clock.sourceReceivedAt=new Date(NOW+3000).toISOString();
  assert.equal(await acceptMatchDetail(input.requestedId,clock,{now:NOW+3000}),false);
  const event=clone(resolved);event.detailIdentity.eventVersion='2026-09-17T15:00:00.000000001Z';hashBinding(event);
  assert.equal(await acceptMatchDetail(input.requestedId,event,{now:NOW+3000}),false);
  const injected=clone(resolved);injected.detailIdentity.unreviewed='extra';hashBinding(injected);
  assert.equal(await acceptMatchDetail(input.requestedId,injected,{now:NOW+3000}),false);
});
test('plain exact-ID responses remain strict; an alias without proof cannot enter state',async () => {
  const input=setup();assert.equal(await acceptMatchDetail(input.requestedId,input.candidates[0],{now:NOW+3000}),false);
  assert.equal(await acceptMatchDetail(input.requestedId,{...input.candidates[0],id:input.requestedId}),true);
  assert.equal(await acceptMatchDetail('wrong',{...input.candidates[0],id:input.requestedId}),false);
});
test('nanosecond and calendar comparison never collapses conflicting exact clocks',() => {
  assert.notEqual(exactDetailClock('2026-09-17T15:00:00Z'),exactDetailClock('2026-09-17T15:00:00.000000001Z'));
  assert.equal(exactDetailClock('2026-09-17T23:00:00+08:00'),exactDetailClock('2026-09-17T15:00:00Z'));
  for (const value of ['2026-09-31T15:00:00Z','2026-09-17T24:00:00Z','2026-09-17 15:00:00','2026-09-17T15:00:00.1234567890Z']) assert.equal(exactDetailClock(value),null);
});
function poolFor(input,patch={}) {
  const calls=[];let inTransaction=false,released=false;
  const client={async query(sql,values) {
    calls.push({sql,values});
    if(sql.startsWith('BEGIN')) {inTransaction=true;return {rows:[]};}
    assert.equal(inTransaction,true,'all proof inputs must use the same read-only snapshot');
    if(sql.includes('projection_meta')) return {rows:Object.entries({data_publication_mode:input.publication.mode,
      data_generation_id:input.publication.generationId,manifest_hash:input.publication.manifestHash,
      data_generation_source_cycle_id:input.publication.sourceCycleId,committed_at:input.publication.committedAt}).map(([key,value])=>({key,value}))};
    if(sql.startsWith('SET LOCAL')) return {rows:[]};
    if(sql.includes('match_snapshots')) return {rows:patch.rows || input.candidates.map(payload=>({payload,dataset:'current',
      match_id:payload.id,source_match_id:payload.sourceMatchId,kickoff_time:payload.kickoffTime.replace('T',' ').replace('Z','+00')}))};
    if(sql.includes('recommendation_decisions')) return {rows:patch.decisions || input.decisions.map(payload=>({payload,id:payload.decisionId,
      source_match_id:payload.sourceMatchId,event_version:payload.eventVersion.replace('T',' ').replace('Z','+00'),
      business_date:payload.businessDate,published_at:payload.publishedAt.replace('T',' ').replace('Z','+00'),
      cutoff_at:payload.cutoffTime.replace('T',' ').replace('Z','+00'),input_hash:payload.inputHash}))};
    if(sql.includes('clock_timestamp')) return {rows:[{observed_at:input.observedAt.replace('T',' ').replace('Z','+00')}]};
    if(sql==='COMMIT'||sql==='ROLLBACK') {inTransaction=false;return {rows:[]};}
    throw new Error(`unexpected query: ${sql}`);
  },release(){released=true;}};
  return {calls,get released(){return released;},async connect(){return client;}};
}
test('PG reader uses one bounded read-only transaction and real PG generation, not caller-supplied proof',async () => {
  const input=setup(),pool=poolFor(input);
  const result=await readPostgresMatchDetailById(pool,input.requestedId,{publicationIdentity:input.publication});
  assert.ok(result?.detailIdentity);assert.equal(result.detailIdentity.generationId,input.publication.generationId);
  assert.equal(pool.calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.at(-1).sql,'COMMIT');assert.equal(pool.released,true);
  assert.match(pool.calls.find(c=>c.sql.includes('match_snapshots')).sql,/LIMIT 17/);
  assert.match(pool.calls.find(c=>c.sql.includes('recommendation_decisions')).sql,/DISTINCT ON/);
  assert.match(pool.calls.find(c=>c.sql.includes('recommendation_decisions')).sql,/LIMIT 17/);
  assert.ok(pool.calls.some(c=>c.sql==="SET LOCAL statement_timeout = '2500ms'"));
  assert.equal(pool.calls.some(c=>/\b(?:INSERT|UPDATE|DELETE)\b/.test(c.sql)),false);
  assert.equal(await acceptMatchDetail(input.requestedId,result,{now:NOW+3000}),true);
});
test('PG overflow, malformed row and generation drift never produce alias proof',async () => {
  const input=setup();
  for (const patch of [{rows:Array(17).fill({payload:input.candidates[0]})},{rows:[{payload:'invalid-json'}]},{decisions:[{payload:'invalid-json'}]}]) {
    const pool=poolFor(input,patch);assert.equal(await readPostgresMatchDetailById(pool,input.requestedId,{publicationIdentity:input.publication}),null);
  }
  const pool=poolFor(input);assert.equal(await readPostgresMatchDetailById(pool,input.requestedId,{publicationIdentity:{...input.publication,generationId:'g-drift'}}),null);
  assert.equal(pool.calls.some(c=>c.sql.includes('match_snapshots')),false);
});
test('decision heads collapse repeated probability versions while preserving every semantic identity dimension',() => {
  assert.match(DETAIL_ALIAS_DECISION_HEADS_SQL,/SELECT DISTINCT ON \(d.event_version,d.business_date,d.cutoff_at/);
  for(const key of ['sourceMatchId','eventVersion','kickoffTime','homeTeamId','awayTeamId','businessDate','matchNo','cutoffTime'])
    assert.ok(DETAIL_ALIAS_DECISION_HEADS_SQL.includes(`d.payload->>'${key}'`));
  assert.match(DETAIL_ALIAS_DECISION_HEADS_SQL,/d.sequence DESC LIMIT 17$/);
  assert.doesNotMatch(DETAIL_ALIAS_DECISION_HEADS_SQL,/DISTINCT ON[^\n]*input_hash/);
});
test('PG decision column/payload divergence is rejected independently of a valid record hash',async () => {
  const input=setup(),d=input.decisions[0],row={payload:d,id:d.decisionId,source_match_id:d.sourceMatchId,event_version:d.eventVersion,
    business_date:d.businessDate,published_at:d.publishedAt,cutoff_at:d.cutoffTime,input_hash:d.inputHash};
  assert.equal(decisionRowMatchesPayload(row),true);
  for(const patch of [{id:'another'},{source_match_id:'999'},{business_date:'2026-09-18'},
    {event_version:'2026-09-17T15:00:00.000000001Z'},{cutoff_at:'2026-09-17T14:59:59Z'},{input_hash:'b'.repeat(64)}]) {
    assert.equal(decisionRowMatchesPayload({...row,...patch}),false);
    assert.equal(await readPostgresMatchDetailById(poolFor(input,{decisions:[{...row,...patch}]}),input.requestedId,{publicationIdentity:input.publication}),null);
  }
});
test('both detail entrypoints use dedicated admission while publisher/accounts keep original reader',() => {
  const src=fs.readFileSync(require.resolve('../server/index.cjs'),'utf8');
  assert.match(src,/const buildV1MatchPayload[\s\S]*?readMatchDetailById\(decodedId, \{ basePublication \}\)/);
  assert.match(src,/if \(matchDetailRoute\)[\s\S]*?readMatchDetailById\(matchDetailRoute\[1\]\)/);
  assert.match(src,/readMatch: async \(id\) => \{\s*const match=await readMatchById\(id\)/);
  const page=fs.readFileSync(require.resolve('../src/pages/MatchDetail.tsx'),'utf8');
  assert.match(page,/response.status === 304 && cached[\s\S]*?await acceptMatchDetail\(matchId,cached.match\)/);
  assert.match(page,/response.ok && await acceptMatchDetail\(matchId,matchPayload\)/);
  assert.match(page,/detailResponseMatchesFields\(matchId,fullMatch,nowMs\)/);
});
