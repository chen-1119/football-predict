'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { persistRun, remainingDelay } = require('../collectors/market/store.cjs');
const { collectOnce } = require('../scripts/runMarketCollector.cjs');
const { config, normalizeRows } = require('../collectors/market/policy.cjs');
const at = Date.parse('2026-09-14T10:00:00Z');
const raw = price => [{ signal: { sourceMatchId: '1', homeTeamName: 'Home', awayTeamName: 'Away', kickoffTime: '2026-09-14T13:00:00Z', bookmakerOdds: { had: { odds1: price, oddsX: 3.4, odds2: 4.2 } } } }];
const market = (price,time) => normalizeRows(raw(price),new Date(time).toISOString()).markets[0];
function clientStore() {
  const state = { runs: new Map(), latest: null, observations: new Map(), statements: [] };
  return { state, async query(sql, values = []) {
    const text = sql.replace(/\s+/g,' ').trim(); state.statements.push(text);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.startsWith('SELECT status,source_sha256')) return { rows: [state.runs.get(values[0])].filter(Boolean) };
    if (text.startsWith('SELECT observation_id')) return { rows: state.latest ? [state.latest] : [] };
    if (text.startsWith('INSERT INTO football.market_observations')) {
      state.observations.set(values[0], { firstSeen: values[10], lastSeen: values[10], seen: 1 }); return { rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO football.market_latest')) {
      state.latest = { observation_id: values[4], content_hash: values[5], updated_at: values[6] }; return { rowCount: 1 };
    }
    if (text.startsWith('UPDATE football.market_observations')) {
      const row = state.observations.get(values[0]); row.lastSeen = values[1]; row.seen++; return { rowCount: 1 };
    }
    if (text.startsWith('UPDATE football.market_latest')) { state.latest.updated_at = values[4]; return { rowCount: 1 }; }
    if (text.startsWith('UPDATE football.market_collector_runs')) {
      state.runs.set(values[0], { status: values[2], rows_changed: values[4], rows_unchanged: values[5], source_sha256: values[6] }); return { rowCount: 1 };
    }
    throw new Error('Unhandled fake SQL: '+text);
  } };
}
function input(id, m) { return { runId: id, markets: [m], status: 'completed', finishedAt: m.observedAt, sourceSha256: 'x', nextPollSeconds: 60, payload: {} }; }
const noFeature = async () => {};
test('A-B-A appends three state segments; unchanged receipt extends only the last segment', async () => {
  const client = clientStore();
  for (const [index, price] of [1.8,1.7,1.8,1.8].entries()) {
    const id = `run-${index}`; client.state.runs.set(id,{ status: 'running' });
    await persistRun(client,input(id,market(price,at + index * 60000)),noFeature);
  }
  assert.equal(client.state.observations.size,3);
  assert.equal(client.state.observations.get(client.state.latest.observation_id).seen,2);
});
test('completed run replay does not increment observation counters', async () => {
  const client=clientStore(), m=market(1.8,at); client.state.runs.set('one',{status:'running'});
  await persistRun(client,input('one',m),noFeature);
  const result=await persistRun(client,input('one',m),noFeature);
  assert.equal(result.replayed,true); assert.equal(client.state.observations.size,1);
  assert.equal(client.state.observations.get(client.state.latest.observation_id).seen,1);
});
test('old observations cannot regress latest or last_seen_at', async () => {
  const client=clientStore(); client.state.runs.set('a',{status:'running'});
  await persistRun(client,input('a',market(1.8,at)),noFeature);
  client.state.runs.set('b',{status:'running'});
  const result=await persistRun(client,input('b',market(1.7,at-60000)),noFeature);
  assert.equal(result.ignored,1); assert.equal(client.state.observations.size,1);
  assert.equal(client.state.latest.updated_at,new Date(at).toISOString());
});
test('feature failures issue rollback and are not committed as success', async () => {
  const client=clientStore(); client.state.runs.set('a',{status:'running'});
  await assert.rejects(persistRun(client,input('a',market(1.8,at)), async () => { throw new Error('feature failure'); }));
  assert.equal(client.state.statements.at(-1),'ROLLBACK');
  assert.equal(client.state.statements.includes('COMMIT'),false);
});
test('stored Retry-After survives a new worker process', () => {
  const previous={ finished_at: new Date(at), next_poll_seconds:86400,
    payload: { nextAttemptAt: new Date(at+86400000).toISOString() } };
  assert.equal(remainingDelay(previous,at+60000),86340);
});
test('an existing source lock prevents the HTTP request, not just duplicate writes', async () => {
  let fetched=false,released=false;
  const pool={connect:async()=>({query:async()=>({rows:[{locked:false}]}),release:()=>{released=true;}})};
  const result=await collectOnce(pool,{config:config({}),fetchPage:async()=>{fetched=true;}});
  assert.equal(result.skipped,'another-worker'); assert.equal(fetched,false); assert.equal(released,true);
});
test('persistent cooldown suppresses requests and always releases the source lock', async () => {
  const statements=[]; let fetched=false;
  const pool={connect:async()=>({query:async sql=>{
    statements.push(sql);
    if(sql.includes('pg_try'))return {rows:[{locked:true}]};
    if(sql.includes('pg_advisory_unlock'))return {rows:[]};
    return {rows:[{finished_at:new Date(at),status:'blocked',next_poll_seconds:21600,payload:{}}]};
  },release:()=>{}})};
  const result=await collectOnce(pool,{now:()=>at+60000,config:config({}),fetchPage:async()=>{fetched=true;}});
  assert.equal(result.skipped,'not-due'); assert.equal(result.nextPollSeconds,21540); assert.equal(fetched,false);
  assert.ok(statements.at(-1).includes('pg_advisory_unlock'));
});
