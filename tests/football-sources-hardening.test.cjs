'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../collectors/football-sources/adapters.cjs');
const {repository}=require('../collectors/football-sources/store.cjs');
const {createWebsiteHandler}=require('../collectors/leisu-prematch/website-reader.cjs');
const NOW=Date.parse('2026-09-27T03:00:00Z');
const match={id:'sporttery_123',sourceMatchId:'123',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',status:'SCHEDULED',leagueName:'德甲',kickoffTime:'2026-09-27T10:00:00Z'};
test('MET refuses null, string and non-finite coordinates before using weather',()=>{
  for(const bad of [null,'-0.1',NaN]){
    const body={type:'Feature',geometry:{coordinates:[bad,51.5]},properties:{meta:{updated_at:'2026-09-27T02:00:00Z',units:{air_temperature:'celsius',wind_speed:'m/s'}},timeseries:[]}};
    assert.throws(()=>parse(body,{provider:'met-norway',kind:'weather',lat:51.5,lon:-.1},NOW),/weather-identity-or-clock/);
  }
});
test('view persistence needs only SELECT on core fixture table, not row-lock update privileges',async()=>{
  const sql=[];
  const client={query:async(s)=>{sql.push(s);return {rows:s.includes('FROM football.match_snapshots')?[{payload:match}]:[]};},release:()=>{}};
  const r=repository({connect:async()=>client});
  assert.equal(await r.saveView(match,{generatedAt:new Date(NOW).toISOString()}),true);
  const reads=sql.filter(s=>s.includes('football.match_snapshots'));
  assert.equal(reads.length,1);assert.ok(reads.every(s=>s.startsWith('SELECT')&&!/FOR SHARE|FOR UPDATE/.test(s)));
});
test('authorized HEAD retains authentication and emits no supplementary body',async()=>{
  let reads=0;const handler=createWebsiteHandler({readFixture:async()=>{reads++;return match;},sourceReader:async()=>({fields:{},predictionEligible:false}),authorize:async()=>true});
  const res={writeHead(n){this.status=n;},end(v){this.body=v;}};
  await handler({method:'HEAD'},res,match.id);assert.equal(res.status,200);assert.equal(res.body,'');assert.equal(reads,1);
});
