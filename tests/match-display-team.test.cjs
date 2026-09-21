'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const knownTeam = {
  id: 'known-club',
  name: { zh: '已登记俱乐部', en: 'Registered Club' },
  shortName: { zh: '已登记', en: 'Registered' },
  logo: '/team-logos/registered.png', logoType: 'crest', value: '-', color: '#123456'
};
const unknownTeam = {
  id: 'unknown', name: { zh: '未知球队', en: 'Unknown Team' },
  shortName: { zh: '未知', en: 'Unknown' }, logo: '?', value: '-', color: '#64748b'
};
const moduleUnderTest = { exports: {} };
const source = ts.transpileModule(
  fs.readFileSync(require.resolve('../src/services/displayRecommendation.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;
vm.runInNewContext(source, {
  module: moduleUnderTest, exports: moduleUnderTest.exports,
  require: id => id === './entities'
    ? { getTeamById: teamId => teamId === knownTeam.id ? knownTeam : { ...unknownTeam, id: teamId } }
    : {}
});
const { getMatchDisplayTeam } = moduleUnderTest.exports;

test('club country metadata never becomes a flag logo, on either match side', () => {
  const match = {
    homeTeamId: 'team_1wz76oe', homeTeamName: '科隆', homeTeamCountryIso: 'CO',
    homeTeamLogo: '', homeTeamLogoType: 'crest-placeholder',
    awayTeamId: 'team_1ckmzgg', awayTeamName: '帕尔马', awayTeamCountryIso: 'PY',
    awayTeamLogo: '', awayTeamLogoType: 'crest-placeholder'
  };
  for (const side of ['home', 'away']) {
    const team = getMatchDisplayTeam(match, side);
    assert.equal(team.logo, '?');
    assert.equal(team.logoType, 'crest-placeholder');
  }
  const unspecified = getMatchDisplayTeam({ ...match, homeTeamLogoType: undefined }, 'home');
  assert.equal(unspecified.logo, '?');
  assert.notEqual(unspecified.logoType, 'flag');
});

test('explicit national flag uses an ISO fallback only when supplied artwork is missing', () => {
  const match = {
    homeTeamId: 'philippines-women', homeTeamName: '菲律宾女足',
    homeTeamCountryIso: 'PH', homeTeamLogoType: 'flag', homeTeamLogo: ''
  };
  assert.equal(getMatchDisplayTeam(match, 'home').logo, 'PH');
  const logo = 'https://example.test/original-ph-flag.svg';
  assert.equal(getMatchDisplayTeam({ ...match, homeTeamLogo: logo }, 'home').logo, logo);
});

test('supplied club artwork and stable id artwork remain available without mutating match data', () => {
  const match = Object.freeze({
    homeTeamId: 'new-club', homeTeamName: '当前主队', homeTeamNameEn: 'Current Home',
    homeTeamLogo: 'https://example.test/real-crest.png', homeTeamLogoType: 'crest', homeTeamCountryIso: 'CO',
    awayTeamId: knownTeam.id, awayTeamName: '当前客队', awayTeamCountryIso: 'PY', awayTeamLogo: ''
  });
  const before = JSON.stringify(match);
  const home = getMatchDisplayTeam(match, 'home'), away = getMatchDisplayTeam(match, 'away');
  assert.equal(home.logo, match.homeTeamLogo);
  assert.equal(home.logoType, 'crest');
  assert.equal(home.name.zh, '当前主队');
  assert.equal(home.name.en, 'Current Home');
  assert.equal(away.logo, knownTeam.logo);
  assert.equal(away.logoType, 'crest');
  assert.equal(away.name.zh, '当前客队');
  assert.equal(JSON.stringify(match), before);
  assert.equal(knownTeam.name.zh, '已登记俱乐部');
});

test('registered teams still use refreshed artwork even when the match omits a display name', () => {
  const logo = '/team-logos/newly-synced.svg';
  const team = getMatchDisplayTeam({
    homeTeamId: knownTeam.id, homeTeamLogo: logo, homeTeamLogoType: 'crest',
    homeTeamCountryIso: 'CO'
  }, 'home');
  assert.equal(team.logo, logo);
  assert.equal(team.name.zh, knownTeam.name.zh);
  assert.equal(team.logoType, 'crest');
});
