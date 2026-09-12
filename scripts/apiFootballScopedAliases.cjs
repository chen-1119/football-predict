"use strict";

// Name vocabulary only, not registry approval or an independent attestation.
// Chinese labels already exist in freeFootballTeamAliases.cjs. Full provider
// names/IDs were checked in the existing provider response; league/season and
// fixture names were cross-checked at the official competition URLs below.
// Do not turn the whole historical short-name dictionary into provider aliases.
const VERSION = "api-football-scoped-aliases-v3-20260913";
const SCOPED_ALIASES = Object.freeze([
  { localName: "赫塔费", providerName: "Getafe", providerTeamId: 546, clubUrl: "https://www.laliga.com/clubes/getafe-cf" },
  { localName: "维戈塞尔塔", providerName: "Celta Vigo", providerTeamId: 538, clubUrl: "https://www.laliga.com/clubes/rc-celta" },
  { localName: "埃尔切", providerName: "Elche", providerTeamId: 797, clubUrl: "https://www.laliga.com/en-GB/clubs/elche-c-f/squad" },
  { localName: "皇家社会", providerName: "Real Sociedad", providerTeamId: 548, clubUrl: "https://www.laliga.com/clubes/real-sociedad/proximos-partidos" },
].map(row => ({ ...row, leagueId: 140, leagueAlias: "la liga" })).concat([
  { localName: "卡利亚里", providerName: "Cagliari", providerTeamId: 490, clubUrl: "https://www.legaseriea.it/team/cagliari" },
  { localName: "莱切", providerName: "Lecce", providerTeamId: 867, clubUrl: "https://uslecce.it/" },
  { localName: "乌迪内斯", providerName: "Udinese", providerTeamId: 494, clubUrl: "https://www.legaseriea.it/team" },
  { localName: "拉齐奥", providerName: "Lazio", providerTeamId: 487, clubUrl: "https://www.legaseriea.it/team" },
].map(row => ({ ...row, leagueId: 135, leagueAlias: "serie a" }))).concat([
  // Exact Sporttery names and live provider fixture identities checked on
  // 2026-09-13; these vocabulary entries do not approve a registry mapping.
  { localName: "托特纳姆热刺", providerName: "Tottenham", providerTeamId: 47, evidenceFixtureId: 1557406 },
  { localName: "埃弗顿", providerName: "Everton", providerTeamId: 45, evidenceFixtureId: 1557406 },
  { localName: "桑德兰", providerName: "Sunderland", providerTeamId: 746, evidenceFixtureId: 1557405 },
  { localName: "阿森纳", providerName: "Arsenal", providerTeamId: 42, evidenceFixtureId: 1557405 },
].map(row => ({ ...row, leagueId: 39, leagueAlias: "premier league" })))
  .map(row => Object.freeze({ ...row, provider: "api-football", season: 2026 })));

const LOCAL_COMPETITIONS = Object.freeze({
  39: Object.freeze(["英超", "英格兰超级联赛"]),
  140: Object.freeze(["西甲", "西班牙甲级联赛", "La Liga"]),
  // "Serie A" alone is not country-qualified (Brazil has one too).
  135: Object.freeze(["意甲", "意大利甲级联赛"]),
});

const validId = value => (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  || (typeof value === "string" && /^[1-9]\d*$/.test(value));

function scopedTeamAliases(match, side, fixture, localLeagueAliases) {
  if (!["home", "away"].includes(side) || !Array.isArray(localLeagueAliases)) return [];
  const team = fixture?.teams?.[side];
  if (!validId(team?.id) || !validId(fixture?.league?.id) || !validId(fixture?.league?.season)) return [];
  // Exact source label + exact provider label/id/league/season. No substring,
  // category stripping, provider-ID assignment or date-based season guessing.
  return SCOPED_ALIASES.filter(row => localLeagueAliases.includes(row.leagueAlias)
    && LOCAL_COMPETITIONS[row.leagueId]?.includes(match?.leagueName)
    && row.localName === match?.[`${side}TeamName`]
    && row.providerName === team.name && String(row.providerTeamId) === String(team.id)
    && String(row.leagueId) === String(fixture.league.id) && String(row.season) === String(fixture.league.season))
    .map(row => row.providerName);
}

module.exports = { VERSION, SCOPED_ALIASES, scopedTeamAliases };
