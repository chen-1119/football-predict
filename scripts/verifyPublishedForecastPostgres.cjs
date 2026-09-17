'use strict';
// Explicit test-only database. Never falls back to FOOTBALL_POSTGRES_URL/DATABASE_URL.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { persistPublishedForecasts } = require('./publishedForecastLedger.cjs');
async function verify(client) {
  const schema = `forecast_verify_${process.pid}_${Date.now()}`;
  const query = (sql, args) => client.query(sql.replaceAll('football.', `${schema}.`), args);
  const now = Date.parse('2026-09-17T10:00:00Z');
  const match = { id:'sporttery_test',sourceMatchId:'test',businessDate:'2026-09-17',status:'SCHEDULED',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Test home',awayTeamName:'Test away',kickoffTime:'2026-09-17T15:00:00Z',probabilityModel:{generatedAt:'2026-09-17T10:00:00Z',oneXTwo:{final:{home:60,draw:25,away:15}}},odds:{odds1:1.8,oddsX:3.3,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:'2026-09-17T10:00:00Z',predictions:[] };
  const options = { now,current:[match],history:[],publication:{generationId:'test',manifestHash:'a'.repeat(64)},publishable:true,validators:{isFinal:r=>r.testFinal===true,isVoid:r=>r.testVoid===true} };
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${schema}`);
    await query(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/010_published_forecasts.sql'),'utf8'));
    const first = await persistPublishedForecasts({query},options); assert.equal(first.current.length,1);
    const frozen = (await query('SELECT payload FROM football.published_forecasts')).rows[0].payload;
    await persistPublishedForecasts({query},{...options,current:[{...match,odds:{odds1:2,oddsX:3,odds2:4}}]});
    assert.deepEqual((await query('SELECT payload FROM football.published_forecasts')).rows[0].payload,frozen);
    for(const sql of ["UPDATE football.published_forecasts SET payload='{}'::jsonb",'DELETE FROM football.published_forecasts']) {
      await client.query('SAVEPOINT guard_test'); await assert.rejects(query(sql),{code:'23000'}); await client.query('ROLLBACK TO SAVEPOINT guard_test');
    }
    const settled = await persistPublishedForecasts({query},{...options,now:Date.parse('2026-09-17T18:00:00Z'),current:[],publishable:false,history:[{...match,testFinal:true,scoreHome:2,scoreAway:0}]});
    assert.equal(settled.summary.won,1);
    assert.deepEqual((await query('SELECT payload FROM football.published_forecasts')).rows[0].payload,frozen);
    await persistPublishedForecasts({query},{...options,now:Date.parse('2026-09-17T18:00:00Z'),current:[],publishable:false,history:[{...match,testFinal:true,scoreHome:0,scoreAway:2,resultRevision:2}]});
    assert.equal((await query('SELECT count(*)::int AS n FROM football.published_forecast_results')).rows[0].n,2);
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT to_regnamespace($1) AS ns',[schema])).rows[0].ns,null);
    return {ok:true,checks:8,transactionRolledBack:true,productionRowsWritten:0};
  } finally { await client.query('ROLLBACK'); }
}
if(require.main===module){
  const url=process.env.FORECAST_TEST_DATABASE_URL;
  if(!url) throw new Error('Set an explicit local FORECAST_TEST_DATABASE_URL; production defaults are forbidden');
  const parsed=new URL(url); if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) throw new Error('Only a local test database is allowed');
  const {Client}=require('pg'); const client=new Client({connectionString:url,ssl:false});
  client.connect().then(()=>verify(client)).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>client.end());
}
module.exports={verify};
