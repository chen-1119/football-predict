'use strict';
// Native integration: CSV -> isolated PostgreSQL warehouse -> bounded reader -> real builders.
// Never connects through production defaults; all test tables use a generated disposable schema.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {importHistoricalFileToPostgres}=require('./postgresHistoricalSourceStore.cjs');
const {loadPostgresTeamHistory,createLiveHistoryOptions}=require('./postgresTeamHistory.cjs');
const {normalizeEntity}=require('./historicalEventStore.cjs');
const {buildEloSnapshots,buildFormSnapshots,teamKey}=require('./syncData.cjs');
async function verify(pool){
 const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 assert(['accounts_test','recommendation_test'].includes(database),'Disposable test database required');
 const schema=`team_history_verify_${process.pid}_${Date.now()}`;assert(/^team_history_verify_\d+_\d+$/.test(schema));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-team-history-test-')),createdFiles=[];
 const map=sql=>{assert.equal(typeof sql,'string');return sql.replaceAll('football.',schema+'.');};
 const q=(sql,values)=>pool.query(map(sql),values);
 const observedAt=new Date(Date.now()-60000).toISOString(),asOf=new Date(Date.now()+3600000).toISOString(),late=new Date(Date.parse(asOf)+3600000).toISOString();
 const target={id:'audit-target',sourceMatchId:'audit-target',homeTeamName:'Alpha',awayTeamName:'Beta',status:'SCHEDULED',kickoffTime:new Date(Date.parse(asOf)+86400000).toISOString()};
 let readAudit=null,checks=0;const passed=[];const check=(name,fn)=>{fn();checks++;passed.push(name);};
 const track=(sql,args)=>{if(readAudit){readAudit.push({sql,args});assert(/^(?:BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK|COMMIT)\b/i.test(sql.trim()),'Reader attempted non-read-only SQL');}};
 const mapped={query:(sql,args)=>{track(sql,args);return q(sql,args);},async connect(){const c=await pool.connect();return{query:(sql,args)=>{track(sql,args);return c.query(map(sql),args);},release:()=>c.release()};}};
 const load=async(overrides={})=>{readAudit=[];try{const value=await loadPostgresTeamHistory({pool:mapped,matches:[target],asOf,teamKey,...overrides});return{...value,queries:readAudit};}finally{readAudit=null;}};
 const csv=(name,body)=>{const file=path.join(dir,name);fs.writeFileSync(file,body);createdFiles.push(file);return file;};
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);
  await q(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/004_free_source_warehouse.sql'),'utf8'));
  const year=new Date(asOf).getUTCFullYear()-1;
  const rows=[`E2,01/01/${year},12:00,Alpha,Beta,2,0,H`,`E2,02/01/${year},12:00,Alpha,Beta,1,1,D`,`E2,03/01/${year},12:00,Alpha,Beta,0,1,A`,`E2,04/01/${year},12:00,Alpha,Beta,3,0,H`];
  const header='Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR\n';
  const firstFile=csv('E2.csv',header+rows.join('\n')+'\n');
  const imported=await importHistoricalFileToPostgres({pool:mapped,dataset:'football-data',filePath:firstFile,observedAt,timezoneOffset:'+00:00'});
  check('real CSV import commits four source events',()=>{assert(imported.ok);assert.equal(imported.acceptedRows,4);assert.equal(imported.insertedEvents,4);});
  const duplicate=await importHistoricalFileToPostgres({pool:mapped,dataset:'football-data',filePath:firstFile,observedAt:asOf,timezoneOffset:'+00:00'});
  check('identical file import is idempotent',()=>assert(duplicate.ok&&duplicate.idempotent));
  const first=await load();
  check('exact names resolve and load four real warehouse results',()=>{assert.equal(first.matches.length,4);assert(first.summary.teams.every(t=>t.mapping==='exact'&&t.selectedMatches===4));});
  check('reader is an explicit read-only transaction with indexed bounded candidate queries',()=>{assert(first.queries.some(r=>/^BEGIN.*READ ONLY/.test(r.sql)));const row=first.queries.find(r=>r.sql.includes('CROSS JOIN LATERAL'));assert(row);assert(row.sql.includes('LIMIT $4'));assert.equal(row.args[3],121);assert(!row.sql.includes('SELECT *'));});
  check('result proof includes actual observation and committed ingest clocks',()=>{for(const m of first.matches){assert(m.postgresTeamHistory);assert(Date.parse(m.resultObservedAt)<=Date.parse(asOf));assert.equal(m.postgresTeamHistory.sourceKey,'football-data-co-uk');assert.equal(m.postgresTeamHistory.scorePeriod,'REGULAR_TIME');}});
  const duplicateFile=csv('E3.csv',header+rows[3].replace(/^E2,/,'E3,')+'\n');
  await importHistoricalFileToPostgres({pool:mapped,dataset:'football-data',filePath:duplicateFile,observedAt,timezoneOffset:'+00:00'});
  const duplicated=await load();check('same team/date/score across competition IDs is counted once',()=>{assert.equal(duplicated.matches.length,4);assert(duplicated.summary.duplicateRows>=1);});
  const bounded=await load({perTeamLimit:2});check('two-result per-team bound is enforced after de-duplication',()=>{assert.equal(bounded.matches.length,2);assert(bounded.summary.teams.every(t=>t.selectedMatches===2));});
  const options=createLiveHistoryOptions({history:bounded,targets:[target],existing:[],training:null,asOf,teamKey});
  const elo=buildEloSnapshots(options.matches,options.training,options).get(target.sourceMatchId),form=buildFormSnapshots(options.matches,options.training,options).get(target.sourceMatchId);
  check('actual Elo builder consumes two results per team without fake seed counts',()=>{assert.equal(elo.homeMatches,2);assert.equal(elo.awayMatches,2);assert(Number.isFinite(elo.homeRating)&&elo.homeRating!==1500);assert.equal(elo.asOf.forecastAt,asOf);});
  check('actual form builder consumes the same two chronological results',()=>{assert.equal(form.home.sampleSize,2);assert.equal(form.away.sampleSize,2);assert.equal(form.sampleSize,4);assert.equal(form.home.goalsForAvg,1.5);assert.equal(form.home.lastMatchAt,`${year}-01-04T12:00:00.000Z`);});
  const beforeMeta=(await q('SELECT observation_id,observed_at FROM football.historical_result_observations ORDER BY observation_id')).rows;
  for(const [table,idColumn,clockColumn]of [['historical_result_observations','observation_id','observed_at'],['historical_source_events','source_event_id','observed_at'],['historical_result_observations','observation_id','available_at'],['data_ingest_runs','run_id','completed_at']]){
   const saved=(await q(`SELECT ${idColumn} AS id,${clockColumn} AS value FROM football.${table}`)).rows;
   await q(`UPDATE football.${table} SET ${clockColumn}=$1`,[late]);
   try{const afterLate=await load();check(`late ${table}.${clockColumn} cannot enter a past forecast`,()=>assert.equal(afterLate.matches.length,0));}
   finally{for(const row of saved)await q(`UPDATE football.${table} SET ${clockColumn}=$1 WHERE ${idColumn}=$2`,[row.value,row.id]);}
  }
  const payloads=(await q('SELECT source_event_id,payload FROM football.historical_source_events')).rows;
  await q("UPDATE football.historical_source_events SET payload=jsonb_set(payload,'{sourceDataset}','\"unrecognized-source\"'::jsonb)");
  try{const unknown=await load();check('unknown result source cannot borrow fixture identity trust',()=>assert.equal(unknown.matches.length,0));}finally{for(const r of payloads)await q('UPDATE football.historical_source_events SET payload=$1::jsonb WHERE source_event_id=$2',[JSON.stringify(r.payload),r.source_event_id]);}
  await q("UPDATE football.data_sources SET enabled=false");
  try{const disabled=await load();check('disabled source cannot supply model results',()=>assert.equal(disabled.matches.length,0));}finally{await q('UPDATE football.data_sources SET enabled=true');}
  await q(`INSERT INTO football.data_source_conflicts(conflict_id,match_id,conflict_type,source_keys,payload,detected_at) SELECT 'conflict-'||match_id,match_id,'score-conflict',ARRAY['football-data-co-uk'],'{}'::jsonb,$1 FROM football.historical_matches`,[observedAt]);
  try{const conflict=await load();check('unresolved conflict excludes every affected match',()=>assert.equal(conflict.matches.length,0));}finally{await q('DELETE FROM football.data_source_conflicts');}
  const alpha=(await q("SELECT team_id FROM football.historical_teams WHERE normalized_name='alpha'")).rows[0].team_id;
  await q(`INSERT INTO football.historical_team_aliases(source_key,normalized_alias,raw_alias,team_id,mapping_status,first_seen_at) VALUES('football-data-co-uk','alpha alias','Alpha Alias',$1,'verified',$2)`,[alpha,observedAt]);
  const aliasKey=n=>n==='Alpha Alias'?'alpha':teamKey(n);
  const alias=await load({matches:[{...target,homeTeamName:'Alpha Alias'}],teamKey:aliasKey});check('verified exact alias reaches the canonical team',()=>assert.equal(alias.matches.length,4));
  const unmatched=await load({matches:[{...target,homeTeamName:"Alpha%' OR 1=1 --",awayTeamName:'No Such Team'}]});
  check('unmatched names stay parameterized and do not trigger fuzzy fallback',()=>{assert.equal(unmatched.matches.length,0);assert(unmatched.summary.teams.every(t=>t.mapping==='missing'));assert(unmatched.queries.every(r=>!r.sql.includes("Alpha%'")));});
  // An equal display name in another category cannot silently borrow the club history.
  await q(`INSERT INTO football.historical_teams(team_id,scope,normalized_name,display_name) VALUES('other-scope-alpha','international','alpha','Alpha')`);
  const scope=await load({matches:[{...target,awayTeamName:'No Such Team'}]});
  check('cross-scope equal-name ambiguity cannot supply results',()=>{assert.equal(scope.matches.length,0);assert.equal(scope.summary.teams.find(t=>t.key==='alpha').mapping,'ambiguous');});
  // Beta is still exact and therefore fetches Alpha/Beta fixtures. That must not
  // grant Alpha a valid mapping merely because it appears as Beta's opponent.
  const opponentScope=await load();
  check('an exact opponent cannot re-admit an ambiguous requested team',()=>{
    const alphaScope=opponentScope.summary.teams.find(t=>t.key==='alpha');
    const betaScope=opponentScope.summary.teams.find(t=>t.key==='beta');
    assert.equal(alphaScope.mapping,'ambiguous');assert.equal(alphaScope.selectedMatches,0);
    assert.equal(betaScope.mapping,'exact');assert(betaScope.selectedMatches>0);
    for(const match of opponentScope.matches)assert(!match.postgresTeamHistory.selectedForKeys.includes('alpha'));
  });
  const opponentOptions=createLiveHistoryOptions({history:opponentScope,targets:[target],existing:[],training:null,asOf,teamKey});
  const opponentElo=buildEloSnapshots(opponentOptions.matches,opponentOptions.training,opponentOptions).get(target.sourceMatchId);
  const opponentForm=buildFormSnapshots(opponentOptions.matches,opponentOptions.training,opponentOptions).get(target.sourceMatchId);
  check('opponent-retrieved rows do not update ambiguous Alpha Elo or recent form',()=>{
    assert(opponentElo&&opponentForm);assert.equal(opponentElo.homeMatches,0);assert.equal(opponentElo.homeRating,1500);
    assert.equal(opponentForm.home.sampleSize,0);assert(opponentElo.awayMatches>0);assert(opponentForm.away.sampleSize>0);
  });
  await q("DELETE FROM football.historical_teams WHERE team_id='other-scope-alpha'");
  await assert.rejects(load({perTeamLimit:201}),RangeError);checks++;passed.push('reader refuses a request beyond 200 rows per team');
  const afterMeta=(await q('SELECT observation_id,observed_at FROM football.historical_result_observations ORDER BY observation_id')).rows;
  check('read-only loads and builders never restamp result observations',()=>assert.deepEqual(afterMeta,beforeMeta));
  return{ok:true,checks,passed,schema,scope:'loopback-disposable-test-schema',realCsvImport:true,realPostgresReader:true,realEloAndFormBuilders:true,productionRowsWritten:0};
 }finally{
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for(const file of createdFiles){assert.equal(path.dirname(file),dir);if(fs.existsSync(file))fs.unlinkSync(file);}
  fs.rmdirSync(dir);
 }
}
if(require.main===module){const url=process.env.TEAM_HISTORY_TEST_DATABASE_URL||process.env.ACCOUNTS_TEST_DATABASE_URL;assert(url,'Explicit TEAM_HISTORY_TEST_DATABASE_URL is required; production defaults are never used');const parsed=new URL(url);assert(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)&&['/accounts_test','/recommendation_test'].includes(parsed.pathname),'Use loopback accounts_test or recommendation_test only');const {Pool}=require('pg'),pool=new Pool({connectionString:url,max:4});verify(pool).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(()=>pool.end());}
module.exports={verify};
