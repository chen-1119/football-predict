'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {projectRows,loadPostgresTeamHistory,createLiveHistoryOptions,seedCutoff}=require('../scripts/postgresTeamHistory.cjs');
const {teamKey,buildEloSnapshots,buildFormSnapshots,predictionSet}=require('../scripts/syncData.cjs');
const ASOF='2026-09-23T10:00:00.000Z';
function row(day=1,patch={}) { return {match_id:'m'+day,observation_id:'r'+day,match_date:`2026-09-${String(day).padStart(2,'0')}`,kickoff_time:null,home_name:'Wigan',away_name:'Blackpool',source_key:'football-data-co-uk',home_goals:2,away_goals:1,observed_at:'2026-09-22T10:00:00Z',event_observed_at:'2026-09-22T10:00:00Z',available_at:'2026-09-22T10:00:00Z',ingest_completed_at:'2026-09-22T10:00:00Z',event_sha256:'a'.repeat(64),payload:{sourceDataset:'football-data.co.uk:results-csv',score:{home:2,away:1}},conflicted:false,...patch}; }
const target=(patch={})=>({sourceMatchId:'future',homeTeamName:'维冈竞技',awayTeamName:'布莱克浦',status:'SCHEDULED',kickoffTime:'2026-09-24T18:00:00Z',...patch});
function history(rows){const p=projectRows(rows,{asOf:ASOF,teamKey});return {matches:p.matches,summary:{version:'postgres-team-history-v1',inputHash:'b'.repeat(64),asOf:ASOF,perTeamLimit:120,lookbackDays:1095,ratingScope:'bounded window',teams:['wigan','blackpool'].map(key=>({key,selectedMatches:p.matches.filter(m=>[m.homeTeamName,m.awayTeamName].includes(key)).length,mapping:'exact'}))}};}
function snapshots(h,training=null,targets=[target()],existing=[]){const o=createLiveHistoryOptions({history:h,targets,existing,training,asOf:ASOF,teamKey});return {o,elo:buildEloSnapshots(o.matches,o.training,o),form:buildFormSnapshots(o.matches,o.training,o)};}
test('all four knowledge clocks must precede prediction, regardless of old match date',()=>{
 for(const field of ['observed_at','event_observed_at','available_at','ingest_completed_at']){
  assert.equal(projectRows([row(1,{[field]:'2026-09-23T10:00:00.001Z'})],{asOf:ASOF,teamKey}).matches.length,0,field);
  assert.equal(projectRows([row(1,{[field]:null})],{asOf:ASOF,teamKey}).matches.length,0,field+' missing');
 }
 const p=projectRows([row(1,{ingest_completed_at:ASOF})],{asOf:ASOF,teamKey});assert.equal(p.matches[0].resultObservedAt,ASOF);
 assert.equal(p.matches[0].postgresTeamHistory.dateOnly,true);assert.equal(p.matches[0].kickoffTime,'2026-09-01T23:59:59.999Z');
});
test('score period is source contracted, and unresolved conflict or mismatching score never enters features',()=>{
 const bad=[row(1,{source_key:'unknown',payload:{scorePeriod:'REGULAR_TIME',status:'FINISHED',score:{home:2,away:1}}}),row(2,{conflicted:true}),row(3,{home_goals:3}),row(4,{away_goals:null}),row(24)];
 assert.equal(projectRows(bad,{asOf:ASOF,teamKey}).matches.length,0);
});
test('same event under multiple source IDs counts once; competing scores quarantine entire event',()=>{
 const duplicate=row(1,{observation_id:'second',match_id:'other-competition'});
 const p=projectRows([row(1),duplicate],{asOf:ASOF,teamKey});assert.equal(p.matches.length,1);assert.equal(p.duplicateRows,1);
 assert.equal(projectRows([row(1),{...duplicate,home_goals:0,payload:{...duplicate.payload,score:{home:0,away:1}}}],{asOf:ASOF,teamKey}).matches.length,0);
});
test('live model consumes canonical PostgreSQL rows, has real counts and nonzero Elo/form model weights',()=>{
 const {elo,form}=snapshots(history(Array.from({length:12},(_,i)=>row(i+1))));
 const e=elo.get('future'),f=form.get('future');assert.equal(e.homeMatches,12);assert.equal(e.awayMatches,12);assert.notEqual(e.homeRating,1500);assert.equal(f.home.sampleSize,12);assert.equal(f.away.sampleSize,12);
 const result=predictionSet({...target(),homeTeam:'维冈竞技',awayTeam:'布莱克浦',odds:{odds1:2.1,oddsX:3.2,odds2:3.3},eloSnapshot:e,formSnapshot:f});
 assert.equal(result.probabilityModel.elo.homeMatches,12);assert.ok(result.probabilityModel.ensembleWeights.elo>0);assert.ok(result.probabilityModel.lambdaBlend.formWeight>0);
 assert.equal(result.probabilityModel.elo.warehouseHistory.inputHash,'b'.repeat(64));
});
test('late imports never change old forecast/locked inputs or signed seed objects',()=>{
 const h=history([row(1)]),old=target({sourceMatchId:'old',kickoffTime:'2026-09-02T18:00:00Z'}),locked=target({sourceMatchId:'locked',predictionMeta:{lockedAt:'2026-09-23T09:00:00Z'}}),unrelated=target({sourceMatchId:'other',homeTeamName:'Alpha',awayTeamName:'Beta'});
 const original=JSON.stringify([h,old,locked,unrelated]);const {elo,form}=snapshots(h,null,[old,locked,unrelated,target()]);assert.deepEqual([...elo.keys()],['future']);assert.deepEqual([...form.keys()],['future']);assert.equal(JSON.stringify([h,old,locked,unrelated]),original);
 const earlier=projectRows([row(1)],{asOf:'2026-09-21T10:00:00Z',teamKey});assert.equal(earlier.matches.length,0);
 assert.equal(buildEloSnapshots([old]).get('old').homeMatches,0);
});
test('per feature seed cutoff ignores global date and stale aggregate Elo counts',()=>{
 const recent=[{kickoffTime:'2025-05-03T12:00:00+01:00',homeKey:'wigan',awayKey:'blackpool',scoreHome:2,scoreAway:1}];
 const seed={version:'signed',sample:{lastMatchDate:'2026-08-20',rows:292936},teams:{wigan:{latestElo:1418.15,eloUpdatedAt:'2024-04-27',lastMatchDate:'2025-05-03',matches:1056,recent},blackpool:{latestElo:null,eloUpdatedAt:null,matches:1049,recent},other:{latestElo:1600,matches:55,recent}}};
 const before=JSON.stringify(seed);const {o,elo,form}=snapshots(history([row(1)]),seed);
 assert.equal(seedCutoff(seed.teams.wigan,'elo'),Date.parse('2024-04-27T23:59:59.999Z'));
 assert.equal(elo.get('future').homeMatches,1);assert.equal(elo.get('future').awayMatches,1);assert.equal(form.get('future').home.sampleSize,2);
 assert.equal(o.training.teams.other,seed.teams.other);assert.equal(JSON.stringify(seed),before);
 assert.equal(o.warehouseHistory.seedPolicy.find(t=>t.key==='blackpool').elo,'window-from-1500');
 const stale=structuredClone(seed);stale.teams.wigan.eloUpdatedAt='2017-04-30';assert.equal(snapshots(history([row(1)]),stale).o.training.teams.wigan.latestElo,null);
});
test('date-only duplicate of seed final match is not appended a second time to form',()=>{
 const seed={teams:{wigan:{latestElo:null,recent:[{kickoffTime:'2025-05-03T12:00:00+01:00',homeKey:'wigan',awayKey:'blackpool',scoreHome:2,scoreAway:1}]}}};
 const h=history([row(1,{match_date:'2025-05-03'}),row(2)]);const {form,elo}=snapshots(h,seed);
 assert.equal(form.get('future').home.sampleSize,2);assert.equal(elo.get('future').homeMatches,2);
});
test('form ordering uses event date, independent of late import observation order',()=>{
 const h=history([row(1,{observed_at:ASOF}),row(20)]);const {form}=snapshots(h);assert.equal(form.get('future').home.lastMatchAt,'2026-09-20T23:59:59.999Z');
});
test('future or malformed FINISHED existing events cannot enter a live timeline',()=>{
 const h=history([row(1)]),bad={...h.matches[0],sourceMatchId:'bad',kickoffTime:'2026-09-24T00:00:00Z'},invalid={...bad,sourceMatchId:'invalid',kickoffTime:'broken'};
 const {elo}=snapshots(h,null,[target()],[bad,invalid]);assert.equal(elo.get('future').homeMatches,1);
});
test('an existing official snapshot and warehouse copy count once; adjacent date overlap is excluded without guessing',()=>{
 const h=history([row(1)]);const official={...h.matches[0],postgresTeamHistory:undefined,sourceMatchId:'official',kickoffTime:'2026-09-01T18:00:00Z',eventVersion:'2026-09-01T18:00:00Z',resultSource:'sporttery:official-api',official:true,resultObservationSource:'sporttery:relay',resultObservedAt:'2026-09-02T12:00:00Z'};
 const same=snapshots(h,null,[target()],[official]);assert.equal(same.elo.get('future').homeMatches,1);
 const adjacent={...official,kickoffTime:'2026-09-02T00:30:00Z',eventVersion:'2026-09-02T00:30:00Z'};const ambiguous=snapshots(h,null,[target()],[adjacent]);assert.equal(ambiguous.elo.get('future').homeMatches,1);assert.equal(ambiguous.o.warehouseHistory.ambiguousDateOverlap,1);
});
test('each requested team obeys its own selected window even through another target opponent',()=>{
 const h=history([row(1),row(2),row(3)]);h.matches[0].postgresTeamHistory.selectedForKeys=['blackpool'];h.matches.slice(1).forEach(m=>m.postgresTeamHistory.selectedForKeys=['wigan','blackpool']);
 const {elo,form}=snapshots(h);assert.equal(elo.get('future').homeMatches,2);assert.equal(elo.get('future').awayMatches,3);assert.equal(form.get('future').home.sampleSize,2);
});
test('read-only loader resolves exact aliases, bounds rows and releases on SQL failure',async()=>{
 const calls=[];let released=0;const client={query:async(sql,args)=>{calls.push([sql,args]);if(sql.includes('jsonb_to_recordset'))return{rows:[{key:'wigan',team_id:'w',display_name:'Wigan'},{key:'blackpool',team_id:'b',display_name:'Blackpool'}]};if(sql.includes('WITH selected'))return{rows:[row(1),row(2),row(3)]};return {rows:[]};},release:()=>released++};
 const loaded=await loadPostgresTeamHistory({pool:{connect:async()=>client},matches:[target()],asOf:ASOF,teamKey,perTeamLimit:2});assert.equal(loaded.matches.length,2);assert.ok(loaded.summary.teams.every(t=>t.selectedMatches===2&&t.truncated));assert.match(calls[0][0],/READ ONLY/);assert.equal(released,1);assert.deepEqual(calls.find(([sql])=>sql.includes('WITH selected'))[1].slice(2),[1095,3]);
 client.query=async()=>{throw new Error('fixture SQL failure');};await assert.rejects(loadPostgresTeamHistory({pool:{connect:async()=>client},matches:[target()],asOf:ASOF,teamKey}),/fixture SQL failure/);assert.equal(released,2);
});
test('a normal weekend with 66 teams does not disable all PostgreSQL inputs',async()=>{
 let connected=0;const pool={connect:async()=>{connected++;return{query:async()=>({rows:[]}),release(){}}}};
 const result=await loadPostgresTeamHistory({pool,matches:Array.from({length:33},(_,i)=>target({homeTeamName:'team'+i*2,awayTeamName:'team'+(i*2+1)})),asOf:ASOF,teamKey});assert.equal(connected,1);assert.equal(result.summary.teams.length,66);assert.ok(result.summary.teams.every(t=>t.mapping==='missing'));
});
test('ambiguous requested team cannot borrow identity or samples through an exact opponent',async()=>{
 const client={query:async sql=>({rows:sql.includes('jsonb_to_recordset')?[{key:'wigan',team_id:'w-club'},{key:'wigan',team_id:'w-national'},{key:'blackpool',team_id:'b'}]:sql.includes('WITH selected')?[row(1),row(2)]:[]}),release(){}};
 const h=await loadPostgresTeamHistory({pool:{connect:async()=>client},matches:[target()],asOf:ASOF,teamKey});
 assert.equal(h.matches.length,2);const ambiguous=h.summary.teams.find(t=>t.key==='wigan');assert.equal(ambiguous.mapping,'ambiguous');assert.equal(ambiguous.selectedMatches,0);assert.equal(ambiguous.availableWindowMatches,0);assert.ok(h.matches.every(m=>!m.postgresTeamHistory.selectedForKeys.includes('wigan')));
 const {elo,form}=snapshots(h);assert.equal(elo.get('future').homeMatches,0);assert.equal(elo.get('future').homeRating,1500);assert.equal(form.get('future').home.sampleSize,0);assert.equal(form.get('future').h2h.sampleSize,0);assert.equal(elo.get('future').awayMatches,2);assert.equal(form.get('future').away.sampleSize,2);
 // A tampered/legacy selectedForKeys list cannot override the failed resolution.
 h.matches.forEach(m=>m.postgresTeamHistory.selectedForKeys.push('wigan'));const retried=snapshots(h);assert.equal(retried.elo.get('future').homeMatches,0);assert.equal(retried.form.get('future').home.sampleSize,0);
});
test('an owned PostgreSQL pool closes even if initial connection fails',async(t)=>{
 const store=require('../server/postgresStore.cjs');let ended=0;t.mock.method(store,'createPostgresPool',()=>({connect:async()=>{throw new Error('fixture connect failure');},end:async()=>{ended++;}}));
 await assert.rejects(loadPostgresTeamHistory({matches:[target()],asOf:ASOF,teamKey}),/fixture connect failure/);assert.equal(ended,1);
});
test('persisted warehouse evidence is compact per fixture, even for a large team batch',()=>{
 const h=history([row(1)]);h.summary.teams.push(...Array.from({length:100},(_,i)=>({key:'unused'+i,selectedMatches:0})));const {elo}=snapshots(h);assert.equal(elo.get('future').warehouseHistory.teams.length,2);assert.equal(elo.get('future').warehouseHistory.inputHash,h.summary.inputHash);
});
