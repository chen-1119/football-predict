'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {importHistoricalEvents}=require('../scripts/historicalEventStore.cjs');
const {FREE_FOOTBALL_TEAM_ALIASES}=require('../scripts/freeFootballTeamAliases.cjs');
const {teamKey,buildEloSnapshots,buildFormSnapshots}=require('../scripts/syncData.cjs');
const {applyEvent}=require('../scripts/augmentHistoricalTrainingFromFootballData.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function imported(input,dataset='football-data'){
 const events=[],rejected=[];
 const manifest=await importHistoricalEvents({dataset,input,onEvent:e=>events.push(e),onRejected:r=>rejected.push(r)});
 return {events,rejected,manifest};
}
const clubs=[['米尔顿凯恩斯','Milton Keynes Dons'],['克劳利','Crawley Town'],['维冈竞技','Wigan'],['布莱克浦','Blackpool'],['诺茨郡','Notts County'],['格里姆斯比','Grimsby']];
test('exact senior aliases use the verified CSV names and keep youth, reserve and women separate',()=>{
 for(const [local,raw] of clubs){
  assert.equal(FREE_FOOTBALL_TEAM_ALIASES[local],raw.toLowerCase());assert.equal(teamKey(local),teamKey(raw));
  for(const suffix of [' U21',' U23',' B',' 女足',' 青年队']){assert.notEqual(teamKey(local+suffix),teamKey(local));assert.notEqual(teamKey(raw+suffix),teamKey(local));}
 }
});
test('real CSV adapter and seed builders connect the six names to Elo and form instead of neutral defaults',async()=>{
 // Synthetic results test the connection only; club names are exact source
 // values, and these rows are never a claim about real historical scores.
 const lines=['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG'];
 for(let i=0;i<clubs.length;i+=2)lines.push(`E3,01/05/2025,${clubs[i][1]},${clubs[i+1][1]},2,1`);
 const {events}=await imported(lines.join('\n')+'\n'),seed={teams:{}};
 for(const e of events)applyEvent(seed,e);
 const matches=[];for(let i=0;i<clubs.length;i+=2)matches.push({sourceMatchId:String(i),homeTeamName:clubs[i][0],awayTeamName:clubs[i+1][0],status:'SCHEDULED',kickoffTime:'2026-09-24T18:00:00Z'});
 const before=JSON.stringify(seed),elo=buildEloSnapshots(matches,seed),form=buildFormSnapshots(matches,seed);
 for(const m of matches){assert.equal(elo.get(m.sourceMatchId).homeMatches,1);assert.equal(elo.get(m.sourceMatchId).awayMatches,1);assert.notEqual(elo.get(m.sourceMatchId).homeRating,1500);assert.equal(form.get(m.sourceMatchId).home.sampleSize,1);assert.equal(form.get(m.sourceMatchId).away.sampleSize,1);}
 assert.equal(JSON.stringify(seed),before);
});
test('Football-Data empty trailing columns retain source hashes and never accept nonempty anonymous values',async()=>{
 const header='Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,,';
 const good='E3,01/05/2025,Wigan,Blackpool,2,1,,',bad='E3,02/05/2025,Wigan,Blackpool,2,1,,0.38';
 const bytes=header+'\r\n'+good+'\r\n'+bad+'\r\n';
 const {events,rejected,manifest}=await imported(bytes);
 assert.equal(events.length,1);assert.equal(manifest.rows,1);assert.equal(manifest.rejected,1);assert.equal(rejected[0].sourceRowNumber,3);assert.equal(rejected[0].reason,'CSV_PARSE_ERROR');assert.match(rejected[0].message,/non-empty unnamed/);
 assert.equal(manifest.sourceFileSha256,sha(bytes));assert.equal(events[0].rawRowSha256,sha(good));assert.equal(rejected[0].rawRowSha256,sha(bad));assert.deepEqual(events[0].score,{home:2,away:1});
});
test('anonymous interior headers and malformed column counts stay rejected',async()=>{
 await assert.rejects(imported('Div,Date,,HomeTeam,AwayTeam,FTHG,FTAG\nE3,01/05/2025,,Wigan,Blackpool,2,1\n'),/empty column name/);
 const {events,manifest}=await imported('Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,\nE3,01/05/2025,Wigan,Blackpool,2,1\n');assert.equal(events.length,0);assert.equal(manifest.rejected,1);
 await assert.rejects(imported('date,home_team,away_team,home_score,away_score,tournament,city,country,neutral,\n2025-05-01,A,B,2,1,Friendly,C,D,FALSE,\n','martj42'),/empty column name/);
});
