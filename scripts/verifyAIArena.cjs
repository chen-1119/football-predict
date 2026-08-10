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
const { buildDailyArenaSelection } = moduleRecord.exports;
assert.equal(typeof buildDailyArenaSelection, 'function');

const baseMatch = (overrides = {}) => ({
  id: 'sporttery_arena-fixture',
  sourceMatchId: 'arena-fixture',
  homeTeamId: 'home',
  awayTeamId: 'away',
  leagueId: 'league',
  countryId: 'country',
  homeTeamName: '主队',
  awayTeamName: '客队',
  leagueName: '测试联赛',
  kickoffTime: '2026-08-10T20:00:00+08:00',
  businessDate: '2026-08-10',
  status: 'SCHEDULED',
  oddsSource: 'sporttery:HAD',
  odds: { odds1: 1.82, oddsX: 3.45, odds2: 4.2 },
  predictions: [{ marketType: 'BEST', tipCode: '1', recommendationAction: 'reference' }],
  probabilityModel: {
    version: 'arena-test-model',
    basis: { zh: '测试', en: 'test' },
    oneXTwo: {
      market: { home: 0.52, draw: 0.27, away: 0.21 },
      poisson: { home: 0.55, draw: 0.25, away: 0.2 },
      final: { home: 0.58, draw: 0.24, away: 0.18 },
    },
    elo: { homeMatches: 12, awayMatches: 12 },
    form: { sampleSize: 12 },
    leaguePrior: { matches: 80 },
  },
  externalSignals: {
    fiveHundred: {
      sale: {
        buyEndTime: '2026-08-10 19:55:00',
        availability: { spfdg: true, nspfdg: false },
      },
    },
  },
  projectedScoreHome: 2,
  projectedScoreAway: 0,
  ...overrides,
});

const nowMs = Date.parse('2026-08-10T10:00:00+08:00');
const selected = buildDailyArenaSelection([baseMatch()], '2026-08-10', nowMs);
assert.ok(selected, 'eligible official single match must be selected');
assert.equal(selected.match.id, 'sporttery_arena-fixture');
assert.equal(selected.analysts.length, 6);
assert.equal(selected.disclosure, 'strategy-simulation');
assert.equal(selected.projectedScore, '2-0', 'zero-goal projected scores must remain visible');
assert.equal(selected.consensus.code, '1');
assert.ok(selected.analysts.some((row) => row.pick !== 'X'), 'the role engine must not collapse every row to draw');
assert.ok(selected.analysts.every((row) => row.startingBalance === 10_000));
assert.ok(selected.analysts.every((row) => row.stake > 0 && row.stake <= 1_800));
assert.deepEqual(
  buildDailyArenaSelection([baseMatch()], '2026-08-10', nowMs),
  selected,
  'same match snapshot must produce a deterministic daily comparison',
);

assert.equal(
  buildDailyArenaSelection([baseMatch({ externalSignals: { fiveHundred: { sale: { availability: { spfdg: false } } } } })], '2026-08-10', nowMs),
  null,
  'ordinary non-single fixtures must not enter the arena',
);
assert.equal(
  buildDailyArenaSelection([baseMatch({ oddsSource: '500.com:had-reference' })], '2026-08-10', nowMs),
  null,
  'non-official HAD prices must not enter the arena',
);
assert.equal(
  buildDailyArenaSelection([baseMatch({ probabilityModel: { version: 'missing', basis: { zh: '', en: '' }, oneXTwo: { market: null, poisson: null, final: null } } })], '2026-08-10', nowMs),
  null,
  'missing model probabilities must fail closed',
);
assert.equal(
  buildDailyArenaSelection([baseMatch({ status: 'FINISHED' })], '2026-08-10', nowMs),
  null,
  'finished matches must not be selected',
);

const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const listSource = fs.readFileSync(path.join(root, 'src', 'pages', 'PredictionsList.tsx'), 'utf8');
assert.match(appSource, /path="\/ai-arena\/:matchId"/);
assert.match(listSource, /<AIArenaPreview matches=\{matches\}/);

console.log(JSON.stringify({
  ok: true,
  version: selected.version,
  selectedMatchId: selected.match.id,
  aiScore: selected.aiScore,
  consensus: selected.consensus,
  roles: selected.analysts.map((row) => ({ id: row.id, pick: row.pick, stake: row.stake })),
  failClosedCases: 4,
  deterministic: true,
}, null, 2));
