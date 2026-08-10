const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'src', 'services', 'aiArena.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics || []).filter((row) => row.category === ts.DiagnosticCategory.Error).length,
  0,
  'aiArena.ts must transpile without syntax errors',
);
const moduleRecord = { exports: {} };
new Function('exports', 'require', 'module', transpiled.outputText)(moduleRecord.exports, require, moduleRecord);
const { buildBigFiveSurvivalArena, arenaWeekRange } = moduleRecord.exports;
assert.equal(typeof buildBigFiveSurvivalArena, 'function');

const leagues = [
  ['epl', '英超', 'Premier League'],
  ['laliga', '西甲', 'La Liga'],
  ['seriea', '意甲', 'Serie A'],
  ['bundesliga', '德甲', 'Bundesliga'],
  ['ligue1', '法甲', 'Ligue 1'],
];

const baseMatch = (id, league, index, overrides = {}) => ({
  id,
  sourceMatchId: id,
  homeTeamId: `${id}-home`,
  awayTeamId: `${id}-away`,
  leagueId: league[0],
  countryId: 'test',
  homeTeamName: `${league[1]}主队${index}`,
  awayTeamName: `${league[1]}客队${index}`,
  leagueName: league[1],
  leagueNameEn: league[2],
  kickoffTime: `2026-08-${String(11 + (index % 3)).padStart(2, '0')}T20:00:00+08:00`,
  businessDate: `2026-08-${String(11 + (index % 3)).padStart(2, '0')}`,
  status: 'SCHEDULED',
  oddsSource: 'sporttery:HAD',
  odds: { odds1: 1.82 + index * 0.03, oddsX: 3.65, odds2: 4.2 - index * 0.05 },
  predictions: [{ marketType: 'BEST', tipCode: '1', recommendationAction: 'reference' }],
  probabilityModel: {
    version: 'arena-test-model',
    basis: { zh: '测试', en: 'test' },
    oneXTwo: {
      market: { home: 0.52, draw: 0.27, away: 0.21 },
      poisson: { home: 0.55, draw: 0.25, away: 0.2 },
      final: { home: 0.54 - index * 0.01, draw: 0.25 + index * 0.005, away: 0.21 + index * 0.005 },
    },
    elo: { homeMatches: 12, awayMatches: 12 },
    form: { sampleSize: 12 },
    leaguePrior: { matches: 80 },
  },
  projectedScoreHome: 2,
  projectedScoreAway: index === 0 ? 0 : 1,
  ...overrides,
});

const fixtures = leagues.flatMap((league, leagueIndex) => [
  baseMatch(`${league[0]}-1`, league, leagueIndex * 2),
  baseMatch(`${league[0]}-2`, league, leagueIndex * 2 + 1),
  baseMatch(`${league[0]}-overflow`, league, leagueIndex * 2 + 1),
]);
const nowMs = Date.parse('2026-08-11T08:00:00+08:00');
assert.deepEqual(arenaWeekRange(nowMs), { weekStart: '2026-08-10', weekEnd: '2026-08-16' });

const arena = buildBigFiveSurvivalArena(fixtures, nowMs);
assert.equal(arena.version, 'ai-big-five-survival-preview-v1');
assert.equal(arena.availableMatches, 10);
assert.equal(arena.targetMatches, 10);
assert.equal(arena.complete, true);
assert.deepEqual(arena.leagueSlots.map((row) => row.count), [2, 2, 2, 2, 2]);
assert.equal(arena.agents.length, 6);
assert.equal(arena.matches.length, 10);
assert.ok(arena.matches.some((row) => row.forecasts.some((forecast) => forecast.projectedScore === '2-0')));

for (const agent of arena.agents) {
  assert.equal(agent.startingBalance, 10_000);
  assert.equal(agent.balance, 10_000);
  assert.equal(agent.forecasts.length, 10, `${agent.name} must forecast every pool match`);
  assert.equal(agent.investedMatches, 3, `${agent.name} must invest in exactly three matches`);
  assert.ok(agent.totalStake >= 1500 && agent.totalStake <= 2500, `${agent.name} weekly stake must stay in range`);
  for (const forecast of agent.forecasts) {
    const probabilityTotal = forecast.probabilities['1'] + forecast.probabilities.X + forecast.probabilities['2'];
    assert.ok(Math.abs(probabilityTotal - 1) < 1e-9, 'AI probabilities must sum to one');
    assert.ok(forecast.confidence >= 1 && forecast.confidence <= 5);
    assert.equal(forecast.reasonsZh.length, 3);
    if (!forecast.investment) {
      assert.equal(forecast.stake, 0);
      continue;
    }
    assert.ok(forecast.stake >= 300 && forecast.stake <= 1200);
    const match = arena.matches.find((row) => row.match.id === forecast.matchId);
    assert.ok(match);
    if (match.odds[forecast.pick] > 3.5) assert.ok(forecast.stake <= 500, 'long odds stake cap must hold');
  }
}

assert.deepEqual(buildBigFiveSurvivalArena(fixtures, nowMs), arena, 'same snapshot must produce deterministic decisions');
assert.equal(
  buildBigFiveSurvivalArena([
    baseMatch('cup', ['cup', '欧冠', 'Champions League'], 0),
    baseMatch('wrong-odds', leagues[0], 0, { oddsSource: '500.com:had-reference' }),
    baseMatch('finished', leagues[1], 1, { status: 'FINISHED' }),
    baseMatch('missing-model', leagues[2], 2, { probabilityModel: { oneXTwo: { final: null } } }),
  ], nowMs).availableMatches,
  0,
  'cups, non-official odds, finished matches, and missing probabilities must fail closed',
);

const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const listSource = fs.readFileSync(path.join(root, 'src', 'pages', 'PredictionsList.tsx'), 'utf8');
const arenaSource = fs.readFileSync(path.join(root, 'src', 'pages', 'AIArena.tsx'), 'utf8');
const navbarSource = fs.readFileSync(path.join(root, 'src', 'components', 'Navbar.tsx'), 'utf8');
assert.match(appSource, /path="\/ai-arena"/);
assert.match(appSource, /path="\/ai-arena\/:matchId"/);
assert.doesNotMatch(listSource, /AIArenaPreview/);
assert.match(arenaSource, /AI 五大联赛生存战/);
assert.match(arenaSource, /strategy-simulation/);
assert.match(navbarSource, /key: 'arena'/);
assert.match(navbarSource, /AI生存战/);

console.log(JSON.stringify({
  ok: true,
  version: arena.version,
  week: [arena.weekStart, arena.weekEnd],
  matches: arena.availableMatches,
  leagues: arena.leagueSlots.map((row) => ({ code: row.code, count: row.count })),
  agents: arena.agents.map((agent) => ({
    id: agent.id,
    forecasts: agent.forecasts.length,
    investments: agent.investedMatches,
    stake: agent.totalStake,
  })),
  deterministic: true,
  formalStatisticsExcluded: true,
}, null, 2));
