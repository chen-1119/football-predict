'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {repository}=require('../collectors/football-sources/store.cjs');
const {PROVIDERS,hash,identity,urlFor}=require('../collectors/football-sources/core.cjs');
const {collect}=require('../collectors/football-sources/client.cjs');
const {resolveFacts}=require('../collectors/football-sources/adapters.cjs');
async function main(){
  const url=process.env.FOOTBALL_SOURCES_TEST_DATABASE_URL;if(!url)throw new Error('Explicit local test database required');
  if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Only local test database allowed');
  const {Pool}=require('pg'),pool=new Pool({connectionString:url,max:6,ssl:false});
  const schema='fs_test_'+Date.now()+'_'+process.pid;let checks=0;
  const rewrite=sql=>sql.replaceAll('football_sources.',schema+'.').replaceAll('football.match_snapshots',schema+'.fixtures');
  const wrapped={query:(s,p)=>pool.query(rewrite(s),p),connect:async()=>{const c=await pool.connect();return {query:(s,p)=>c.query(rewrite(s),p),release:()=>c.release()};}};
  const repo=repository(wrapped),now=Date.parse('2026-09-27T03:00:00Z');
  const match={id:'sporttery_123',sourceMatchId:'123',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',status:'SCHEDULED',leagueName:'德甲',kickoffTime:'2026-09-27T10:00:00Z'};
  try{
    await pool.query('CREATE SCHEMA '+schema);
    let ddl=fs.readFileSync(path.join(__dirname,'../collectors/football-sources/schema.sql'),'utf8').replace('CREATE SCHEMA IF NOT EXISTS football_sources;','');
    await wrapped.query(ddl);
    await wrapped.query('CREATE TABLE '+schema+'.fixtures(dataset text, payload jsonb)');
    await wrapped.query('INSERT INTO '+schema+'.fixtures VALUES($1,$2::jsonb)',['current',JSON.stringify(match)]);
    const reservations=await Promise.all(Array.from({length:12},()=>repo.reserve('football-data.org',now,PROVIDERS['football-data.org'])));
    assert.equal(reservations.filter(r=>r.allowed).length,1);checks++;
    await repo.failure('football-data.org',now,now,'rate-limited',now+7200000);
    assert.equal((await repo.reserve('football-data.org',now+3600000,PROVIDERS['football-data.org'])).reason,'cooldown');checks++;
    assert.equal((await repo.reserve('football-data.org',now+86400000,PROVIDERS['football-data.org'])).allowed,true);checks++;
    const job={provider:'openligadb',kind:'matches',competition:'bl1',season:2026,ttlMs:1800000};
    const raw=[{matchID:1,leagueShortcut:'bl1',leagueSeason:2026,team1:{teamId:10,teamName:'Home'},team2:{teamId:20,teamName:'Away'},matchDateTimeUTC:match.kickoffTime,matchIsFinished:false,matchResults:[]}];
    const result=await collect(job,repo,{now:()=>now,fetchImpl:async()=>new Response(JSON.stringify(raw))});
    assert.equal(result.state,'available');checks++;
    const c=await repo.getCache(hash(urlFor(job)));assert.equal(c.value.rows.length,1);checks++;
    assert.equal((await wrapped.query('SELECT count(*)::int AS n FROM football_sources.raw_receipts')).rows[0].n,1);checks++;
    const before=JSON.stringify(await repo.current());
    const view=resolveFacts(match,await repo.caches(),now);assert.equal(await repo.saveView(match,view),true);checks++;
    assert.equal((await repo.readView(match)).fields.fixture.provider,'openligadb');checks++;
    assert.equal(await repo.readView({...match,homeTeamId:'different'}),null);checks++;
    assert.equal(await repo.saveView({...match,homeTeamId:'different'},{...view,identity:identity({...match,homeTeamId:'different'})}),false);checks++;
    assert.equal(JSON.stringify(await repo.current()),before);checks++;
    const oldCache=await repo.getCache(c.key);
    await repo.failure('openligadb',now+9000,now+9000,'access-restricted',now+3600000);
    assert.deepEqual(await repo.getCache(c.key),oldCache);checks++;
    const broken={...c,key:'broken-'+c.key,rawHash:'b'.repeat(64)};
    await assert.rejects(repo.save(broken,'payload',{provider:'openligadb',started:now,finished:now,state:null}));
    assert.equal(await repo.getCache(broken.key),null);checks++;
    assert.equal((await wrapped.query('SELECT count(*)::int AS n FROM football_sources.raw_receipts WHERE hash=$1',[broken.rawHash])).rows[0].n,0);checks++;
    console.log(JSON.stringify({ok:true,checks,nativePostgres:true,productionRowsWritten:0}));
  }finally{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
