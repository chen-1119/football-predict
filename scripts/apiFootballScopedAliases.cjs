"use strict";

// Name vocabulary only, not registry approval or an independent attestation.
// Chinese labels already exist in freeFootballTeamAliases.cjs. Full provider
// names/IDs were checked in the existing provider response; league/season and
// fixture names were cross-checked at the official competition URLs below.
// Do not turn the whole historical short-name dictionary into provider aliases.
const VERSION = "api-football-scoped-aliases-v5-20260922";
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
].map(row => ({ ...row, leagueId: 39, leagueAlias: "premier league" }))).concat([
  // Sporttery current roster + live API fixture response receipts, PostgreSQL
  // run 90822288-7987-42a3-9d46-f228180bd506 (2026-09-14). Vocabulary only;
  // current live fixture evidence and exact registry checks still apply.
  [244, "veikkausliiga", "国际图尔库", "Inter Turku", 1164, 1638097],
  [244, "veikkausliiga", "瓦萨", "VPS", 650, 1638097],
  [135, "serie a", "科莫", "Como", 895, 1550118],
  [135, "serie a", "帕尔马", "Parma", 523, 1550118],
  [135, "serie a", "都灵", "Torino", 503, 1550125],
  [135, "serie a", "罗马", "AS Roma", 497, 1550125],
  [113, "allsvenskan", "佐加顿斯", "Djurgardens IF", 364, 1494274],
  [113, "allsvenskan", "哥德堡盖斯", "Gais", 2170, 1494274],
  [103, "eliteserien", "博德闪耀", "Bodo/Glimt", 327, 1494756],
  [103, "eliteserien", "桑纳菲尤尔", "Sandefjord", 332, 1494756],
  [17, "champions league elite", "吉达国民", "Al-Ahli Jeddah", 2929, 1629915],
  [17, "champions league elite", "棉农", "Pakhtakor", 4220, 1629915],
  [135, "serie a", "国际米兰", "Inter", 505, 1550120],
  [62, "ligue 2", "圣旺红星", "RED Star FC 93", 104, 1552474],
  [62, "ligue 2", "梅斯", "Metz", 112, 1552474],
  [39, "premier league", "利兹联", "Leeds", 63, 1557402],
  [39, "premier league", "纽卡斯尔联", "Newcastle", 34, 1557402],
  [140, "la liga", "比利亚雷亚尔", "Villarreal", 533, 1570382],
  [140, "la liga", "皇家贝蒂斯", "Real Betis", 543, 1570382],
  [94, "primeira liga", "布拉加", "SC Braga", 217, 1575494],
  [94, "primeira liga", "埃斯托里尔", "Estoril", 230, 1575494],
  // Official-day roster + existing live API response, checked 2026-09-22.
  // See docs/API_FOOTBALL_COVERAGE_20260922.md for independent club evidence.
  [46, "efl trophy", "米尔顿凯恩斯", "Milton Keynes Dons", 1348, 1588908],
  [46, "efl trophy", "克劳利", "Crawley Town", 1362, 1588908],
  [46, "efl trophy", "诺茨郡", "Notts County", 1376, 1588849],
  [46, "efl trophy", "格里姆斯比", "Grimsby", 1365, 1588849],
  [46, "efl trophy", "维冈竞技", "Wigan", 61, 1588823],
  [46, "efl trophy", "布莱克浦", "Blackpool", 1356, 1588823],
  [803, "asian games", "韩国亚运男足", "Korea Republic U23", 10177, 1639468],
  [803, "asian games", "沙特阿拉伯亚足", "Saudi Arabia U23", 10955, 1639468],
].map(([leagueId, leagueAlias, localName, providerName, providerTeamId, evidenceFixtureId]) => ({ leagueId, leagueAlias, localName, providerName, providerTeamId, evidenceFixtureId })))
  .map(row => Object.freeze({ ...row, provider: "api-football", season: 2026 })));

const LOCAL_COMPETITIONS = Object.freeze({
  39: Object.freeze(["英超", "英格兰超级联赛"]),
  140: Object.freeze(["西甲", "西班牙甲级联赛", "La Liga"]),
  // "Serie A" alone is not country-qualified (Brazil has one too).
  135: Object.freeze(["意甲", "意大利甲级联赛"]),
  244: Object.freeze(["芬超", "芬兰超级联赛"]),
  113: Object.freeze(["瑞超", "瑞典超级联赛"]),
  103: Object.freeze(["挪超", "挪威超级联赛"]),
  17: Object.freeze(["亚冠精英", "亚洲冠军精英联赛"]),
  62: Object.freeze(["法乙", "法国乙级联赛"]),
  94: Object.freeze(["葡超", "葡萄牙超级联赛"]),
  46: Object.freeze(["英格兰锦标赛"]),
  803: Object.freeze(["亚运会男足"]),
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

// This is the identity of one verified tournament entry, not a rule that all
// Asian Games sides are U23. SAFF fields its U21 squad in this event while the
// provider calls that event entry Saudi Arabia U23. Do not alter raw names or
// extend the alias to a senior/friendly fixture. Registry receipt checks remain
// independent and still require a live response before accepting either ID.
function scopedCategoryLabels(match, fixture, providerNames) {
  const nested = fixture?.teams;
  const id = fixture?.fixtureId;
  const date = fixture?.date || fixture?.fixtureDate;
  const leagueId = fixture?.league?.id ?? fixture?.leagueId;
  const season = fixture?.league?.season ?? fixture?.season;
  const kickoff = "2026-09-22T10:00:00.000Z";
  const { strictInstant } = require('../src/services/strictInstant.cjs');
  const sameKickoff = value => Boolean(strictInstant(value)) && Date.parse(value) === Date.parse(kickoff);
  if (match?.id !== 'sporttery_2041642' || String(match?.sourceMatchId) !== '2041642'
      || match?.leagueName !== '亚运会男足' || String(id) !== '1639468'
      || String(leagueId) !== '803' || String(season) !== '2026'
      || !sameKickoff(match?.kickoffTime) || !sameKickoff(date)) return null;
  if (match.eventVersion && !sameKickoff(match.eventVersion)) return null;
  const expected = { home: ['韩国亚运男足', 'Korea Republic U23', '10177'],
    away: ['沙特阿拉伯亚足', 'Saudi Arabia U23', '10955'] };
  for (const side of ['home', 'away']) {
    const [local, name, teamId] = expected[side];
    if (match[side + 'TeamName'] !== local || providerNames?.[side] !== name
        || (nested?.[side]?.name ?? fixture?.[side + 'TeamName']) !== name
        || String(nested?.[side]?.id ?? fixture?.[side + 'TeamId']) !== teamId) return null;
  }
  return { home: ['Men U23'], away: ['Men U23'],
    evidence: 'asian-games-2026-1639468-official-participant-identity' };
}

module.exports = { VERSION, SCOPED_ALIASES, scopedTeamAliases, scopedCategoryLabels };
