'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../scripts/syncApiFootballData.cjs');
const { scopedTeamAliases, scopedCategoryLabels } = require('../scripts/apiFootballScopedAliases.cjs');
const { createEntityRegistry, fixtureIdentityHashFor } = require('../scripts/entityResolutionRegistry.cjs');
const { fixtureTeamCategoryAudit } = require('../scripts/teamCategoryIdentity.cjs');

// Static regression examples from the existing provider receipts. Their trust
// hashes below are synthetic test data and are never production attestations.
const cases = [
  [2041643,1588908,'英格兰锦标赛',46,'EFL Trophy','米尔顿凯恩斯','克劳利',1348,1362,'Milton Keynes Dons','Crawley Town','2026-09-23T02:00:00+08:00'],
  [2041655,1588849,'英格兰锦标赛',46,'EFL Trophy','诺茨郡','格里姆斯比',1376,1365,'Notts County','Grimsby','2026-09-23T02:00:00+08:00'],
  [2041644,1588823,'英格兰锦标赛',46,'EFL Trophy','维冈竞技','布莱克浦',61,1356,'Wigan','Blackpool','2026-09-23T02:00:00+08:00'],
  [2041642,1639468,'亚运会男足',803,'Asian Games','韩国亚运男足','沙特阿拉伯亚足',10177,10955,'Korea Republic U23','Saudi Arabia U23','2026-09-22T18:00:00+08:00'],
].map(([sourceId,fixtureId,localLeague,leagueId,league,home,away,homeId,awayId,providerHome,providerAway,kickoff]) => ({
  match:{ id:'sporttery_'+sourceId, sourceMatchId:String(sourceId), homeTeamId:'test_'+homeId, awayTeamId:'test_'+awayId,
    leagueName:localLeague, homeTeamName:home, awayTeamName:away, kickoffTime:kickoff, eventVersion:kickoff, status:'SCHEDULED' },
  fixture:{ fixtureId,date:kickoff,league:{id:leagueId,name:league,season:2026},
    teams:{home:{id:homeId,name:providerHome},away:{id:awayId,name:providerAway}} },
}));
const clone = value => structuredClone(value);
const mappingFor = ({match,fixture}) => {
  const score=api.confidenceForFixture(match,fixture);
  const mapping={sportteryMatchId:match.id,sourceMatchId:match.sourceMatchId,fixtureId:fixture.fixtureId,
    fixtureDate:fixture.date,leagueId:fixture.league.id,leagueName:fixture.league.name,season:fixture.league.season,
    homeTeamId:fixture.teams.home.id,awayTeamId:fixture.teams.away.id,
    homeTeamName:fixture.teams.home.name,awayTeamName:fixture.teams.away.name,
    score,confidence:score.confidence,matchedAt:'2026-09-22T06:00:00.000Z'};
  mapping.providerEvidence={responseSha256:'a'.repeat(64),fixtureIdentitySha256:fixtureIdentityHashFor(mapping)};
  return mapping;
};

for (const entry of cases) {
  test(entry.match.id+' exact competition names flow through live-only registry qualification',()=>{
    const {match,fixture}=entry,score=api.confidenceForFixture(match,fixture), mapping=mappingFor(entry);
    assert.equal(score.teamScore,1);assert.equal(score.leagueScore,1);assert.equal(score.confidence,1);
    const empty=createEntityRegistry({createdAt:'2026-09-22T05:00:00.000Z'}),cache=api.createCache();cache.fixtureMap[match.id]=mapping;
    for(const trust of [null,{live:false,providerResponseSha256:'a'.repeat(64)},{live:true,providerResponseSha256:'b'.repeat(64)}]){
      const result=api.absorbEntityResolutionEvidence([match],cache,empty,trust?new Map([[match.id,trust]]):new Map());
      assert.equal(result.changedRows,0);assert.deepEqual(result.registry,empty);
    }
    const trust={live:true,providerResponseSha256:'a'.repeat(64)};
    const result=api.absorbEntityResolutionEvidence([match],cache,empty,new Map([[match.id,trust]]));
    assert.equal(result.changedRows,1);
    assert.equal(api.mappingVerificationState(match,mapping,result.registry,{liveTrustContext:trust}).verified,true);
    assert.equal(api.mappingVerificationState(match,mapping,result.registry,{liveTrustContext:trust}).currentCycleQualification.eligible,true);
    assert.equal(api.buildVerifiedMappingSet([match],cache,result.registry).has(match.id),true);
  });
  test(entry.match.id+' rejects another competition season team ID or squad',()=>{
    const {match,fixture}=entry,leagueAliases=[fixture.league.name.toLowerCase()];
    for(const alter of [ f=>f.league.id=999, f=>f.league.season=2025, f=>delete f.league.season,
      f=>f.teams.home.id=999, f=>f.teams.home.name+=' Women',f=>f.teams.home.name+=' U21',
      f=>f.teams.home.name+=' B', f=>{const home=f.teams.home;f.teams.home=f.teams.away;f.teams.away=home;}]){
      const changed=clone(fixture);alter(changed);
      assert.deepEqual(scopedTeamAliases(match,'home',changed,leagueAliases),[]);
    }
    for(const localLeague of ['英格兰冠军联赛','英超','亚运会女足','国际友谊赛']){
      assert.deepEqual(scopedTeamAliases({...match,leagueName:localLeague},'home',fixture,leagueAliases),[]);
    }
  });
}

test('Asian Games category evidence is limited to the observed fixture identity, not all U23 or senior sides',()=>{
  const {match,fixture}=cases[3],names={home:fixture.teams.home.name,away:fixture.teams.away.name};
  assert.equal(fixtureTeamCategoryAudit(match,names).compatible,false);
  const audit=fixtureTeamCategoryAudit(match,names,fixture);
  assert.equal(audit.compatible,true);assert.match(audit.categoryEvidence,/1639468/);
  for(const alter of [f=>f.fixtureId++,f=>f.league.id++,f=>f.league.season++,f=>f.teams.away.id++,
    f=>f.date='2026-09-22T18:01:00+08:00']){
    const changed=clone(fixture);alter(changed);assert.equal(scopedCategoryLabels(match,changed,names),null);
    assert.equal(fixtureTeamCategoryAudit(match,names,changed).compatible,false);
  }
  for(const alter of [m=>m.id='sporttery_999',m=>m.sourceMatchId='999',m=>m.leagueName='亚运会女足',
    m=>m.homeTeamName='韩国',m=>m.awayTeamName='沙特阿拉伯',m=>m.eventVersion='2026-09-22T18:01:00+08:00']){
    const changed=clone(match);alter(changed);assert.equal(scopedCategoryLabels(changed,fixture,names),null);
  }
  for(const name of ['Korea Republic Women U23','Korea Republic Men U21','Korea Republic U23 B']){
    const changed={...match,homeTeamNameEn:name};
    assert.equal(fixtureTeamCategoryAudit(changed,names,fixture).compatible,false,'original conflicting labels remain visible');
    assert.equal(api.confidenceForFixture(changed,fixture).teamScore,0);
  }
  const equivalent=clone(fixture);equivalent.date='2026-09-22T10:00:00.000Z';
  assert.equal(fixtureTeamCategoryAudit(match,names,equivalent).compatible,true);
});
