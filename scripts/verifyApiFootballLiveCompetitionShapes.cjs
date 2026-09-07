"use strict";
const assert = require("node:assert/strict");
const api = require("./syncApiFootballData.cjs");
const { createEntityRegistry, fixtureIdentityHashFor } = require("./entityResolutionRegistry.cjs");
const { scopedTeamAliases } = require("./apiFootballScopedAliases.cjs");
function verifyLiveCompetitionShapes() {
let assertions = 0;
const check = (ok, text) => { assert.ok(ok, text); assertions++; };
// Italian identity/competition fields observed in current SQLite/provider cache
// on 2026-09-07; Spanish cases additionally test a Chinese-only league-field
// variant. Test trust is synthetic, never a live attestation.
const cases = [
  [2041320,1550109,"意大利甲级联赛",135,"Serie A","卡利亚里","莱切",490,867,"Cagliari","Lecce","00:30"],
  [2041325,1550116,"意大利甲级联赛",135,"Serie A","乌迪内斯","拉齐奥",494,487,"Udinese","Lazio","02:45"],
  [2041321,1570368,"西班牙甲级联赛",140,"La Liga","赫塔费","维戈塞尔塔",546,538,"Getafe","Celta Vigo","01:00"],
  [2041327,1570366,"西班牙甲级联赛",140,"La Liga","埃尔切","皇家社会",797,548,"Elche","Real Sociedad","03:30"],
];
for (const [localId,fixtureId,localLeague,leagueId,leagueName,homeName,awayName,homeId,awayId,homeProvider,awayProvider,time] of cases) {
  const match = { id: `sporttery_${localId}`, sourceMatchId: String(localId), leagueName: localLeague,
    leagueNameEn: localLeague, leagueShortName: localLeague.replace("级联赛", ""), leagueShortNameEn: localLeague,
    kickoffTime: `2026-09-08T${time}:00+08:00`, homeTeamId: `local_${homeId}`, awayTeamId: `local_${awayId}`,
    homeTeamName: homeName, homeTeamNameEn: homeName, awayTeamName: awayName, awayTeamNameEn: awayName };
  const fixture = { fixtureId, date: match.kickoffTime, league: { id: leagueId, name: leagueName, season: 2026 },
    teams: { home: { id: homeId, name: homeProvider }, away: { id: awayId, name: awayProvider } } };
  const score = api.confidenceForFixture(match, fixture);
  check(score.teamScore === 1 && score.leagueScore === 1 && score.confidence >= 0.9, `${localId}: actual full labels reach scorer`);
  if (leagueId === 140) {
    const actualSpanish = { ...match, leagueNameEn: "La Liga", leagueShortName: "西甲", leagueShortNameEn: "La Liga" };
    check(api.confidenceForFixture(actualSpanish, fixture).confidence >= 0.9,
      `${localId}: actual Spanish English/shorthand fields remain compatible`);
  }
  const observedAt = "2026-09-07T13:32:38.064Z";
  const mapping = { sportteryMatchId: match.id, sourceMatchId: match.sourceMatchId,
    fixtureId, fixtureDate: fixture.date, leagueId, leagueName, season: 2026,
    homeTeamId: homeId, awayTeamId: awayId, homeTeamName: homeProvider, awayTeamName: awayProvider,
    score, confidence: score.confidence, matchedAt: observedAt };
  mapping.providerEvidence = { responseSha256: "a".repeat(64), fixtureIdentitySha256: fixtureIdentityHashFor(mapping) };
  const cache = api.createCache(); cache.fixtureMap[match.id] = mapping;
  const blank = createEntityRegistry({ createdAt: observedAt });
  const learn = (context) => api.absorbEntityResolutionEvidence([match], cache, blank,
    context ? new Map([[match.id, context]]) : new Map());
  check(learn(null).changedRows === 0, `${localId}: cached identity is not new approval`);
  check(learn({ live: false, providerResponseSha256: "a".repeat(64) }).changedRows === 0, `${localId}: nonlive receipt rejected`);
  check(learn({ live: true, providerResponseSha256: "b".repeat(64) }).changedRows === 0, `${localId}: mismatched receipt rejected`);
  const trust = { live: true, providerResponseSha256: "a".repeat(64) };
  const learned = learn(trust);
  check(learned.changedRows === 1, `${localId}: synthetic valid fixture can learn both identities`);
  check(api.mappingVerificationState(match, mapping, learned.registry, { liveTrustContext: trust }).currentCycleQualification?.eligible,
    `${localId}: aliases survive registry revalidation`);
  const aliases = [leagueName.toLowerCase()];
  for (const changed of [
    { ...fixture, league: { ...fixture.league, id: 71 } },
    { ...fixture, league: { ...fixture.league, season: 2025 } },
    { ...fixture, league: { id: leagueId } },
    { ...fixture, teams: { ...fixture.teams, home: { id: 999, name: homeProvider } } },
    { ...fixture, teams: { home: fixture.teams.away, away: fixture.teams.home } },
  ]) check(scopedTeamAliases(match, "home", changed, aliases).length === 0, `${localId}: wrong identity scope rejected`);
  for (const suffix of [" Women", " U21", " B"]) {
    const changed = { ...fixture, teams: { ...fixture.teams, home: { id: homeId, name: homeProvider + suffix } } };
    check(api.confidenceForFixture(match, changed).teamScore === 0, `${localId}: squad category rejected`);
  }
  for (const wrongLeague of ["巴甲", "巴西甲级联赛", "Serie A", "西班牙乙级联赛"]) {
    check(scopedTeamAliases({ ...match, leagueName: wrongLeague }, "home", fixture, aliases).length === 0,
      `${localId}: ambiguous or foreign local league cannot unlock vocabulary`);
  }
}
return { ok: true, assertions, cases: cases.length, productionDataWritten: false };
}
if (require.main === module) console.log(JSON.stringify(verifyLiveCompetitionShapes()));
module.exports = { verifyLiveCompetitionShapes };
