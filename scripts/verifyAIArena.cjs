const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
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
const localRequire = (specifier) => specifier === './runtimeUrls'
  ? { buildApiUrl: (endpoint) => endpoint }
  : require(specifier);
new Function('exports', 'require', 'module', transpiled.outputText)(moduleRecord.exports, localRequire, moduleRecord);
const {
  buildBigFiveSurvivalArena,
  arenaWeekRange,
  isPublishedBigFiveSurvivalArena,
} = moduleRecord.exports;
const {
  AGENTS,
  PAYLOAD_VERSION,
  STATE_VERSION,
  assignInvestments,
  identifyLeague,
  updateAiArenaState,
} = require('./aiArenaEngine.cjs');
const { VERSION: DECISION_ENGINE_VERSION } = require('./aiArenaDecisionEngine.cjs');
const { persistAiArenaSqlite } = require('./aiArenaSqlite.cjs');
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
    contextSignals: {
      attackIntent: { home: 58, away: 53 },
      rankingPressure: { home: 57, away: 55 },
      dataGaps: { coverageScore: 72, trustPenalty: 4, severeMissingCount: 1, missing: [] },
      webConsensus: { available: false },
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
assert.deepEqual(arena.agents.map((row) => row.id), ['gpt', 'kimi', 'gemini', 'deepseek', 'doubao', 'qwen']);
assert.deepEqual(
  arena.agents.map((row) => row.name),
  ['均衡策略', '稳健策略', '融合策略', '价值策略', '逆向策略', '纪律策略'],
);
assert.equal(arena.agents.every((row) => row.providerMode === 'local-strategy-simulation'), true);
assert.equal(arena.agents.some((row) => row.id === 'claude' || row.id === 'grok'), false);
assert.equal(arena.matches.length, 10);
assert.ok(arena.matches.some((row) => row.forecasts.some((forecast) => forecast.projectedScore === '2-0')));

for (const agent of arena.agents) {
  assert.equal(agent.startingBalance, 10_000);
  assert.equal(agent.balance, 10_000);
  assert.equal(agent.forecasts.length, 10, `${agent.name} must forecast every pool match`);
  assert.ok(agent.investedMatches >= 0 && agent.investedMatches <= 10, `${agent.name} must choose its own investment count`);
  assert.ok(agent.totalStake >= 0 && agent.totalStake <= agent.balance * agent.staking.weeklyRiskFraction, `${agent.name} weekly risk cap must hold`);
  assert.equal(agent.reservedBalance, agent.balance - agent.totalStake);
  for (const forecast of agent.forecasts) {
    const probabilityTotal = forecast.probabilities['1'] + forecast.probabilities.X + forecast.probabilities['2'];
    assert.ok(Math.abs(probabilityTotal - 1) < 1e-9, 'AI probabilities must sum to one');
    assert.ok(forecast.confidence >= 1 && forecast.confidence <= 5);
    assert.equal(forecast.reasonsZh.length, 3);
    assert.ok(['HIGH_EVIDENCE', 'REFERENCE', 'LOW_CONFIDENCE'].includes(forecast.recommendationTier));
    assert.ok(forecast.recommendationReasonCodes.includes('DETERMINISTIC_TOP_PROBABILITY'));
    assert.ok(forecast.stakeAudit);
    assert.ok(forecast.stakeReasonZh.length > 0);
    if (!forecast.investment) {
      assert.equal(forecast.stake, 0);
      assert.notEqual(forecast.stakeAudit.reasonCode, 'ALLOCATED');
      continue;
    }
    assert.ok(forecast.stake >= 50);
    assert.equal(forecast.stakeAudit.reasonCode, 'ALLOCATED');
    assert.ok(forecast.stake <= forecast.stakeAudit.singleCap);
    const match = arena.matches.find((row) => row.match.id === forecast.matchId);
    assert.ok(match);
    if (match.odds[forecast.pick] > 3.5) assert.ok(forecast.stake <= 200, 'long odds risk-fraction cap must hold');
  }
}

assert.deepEqual(buildBigFiveSurvivalArena(fixtures, nowMs), arena, 'same snapshot must produce deterministic decisions');
assert.doesNotMatch(source, /Math\.random|stableFraction/, 'arena decisions must not contain pseudo-random direction jitter');

const allocationMatch = (odds = 2.5) => new Map([['allocation-test', {
  id: 'allocation-test', leagueCode: 'premier-league', dateKey: '2026-08-11',
  odds: { '1': odds, X: 3.4, '2': 3.8 },
  marketProbabilities: { '1': 0.40, X: 0.30, '2': 0.30 },
}]]);
const allocationForecast = (overrides = {}) => ({
  matchId: 'allocation-test', pick: '1', probabilities: { '1': 0.70, X: 0.18, '2': 0.12 },
  confidence: 5, projectedScore: '2-0', reasonsZh: ['a', 'b', 'c'], reasonsEn: ['a', 'b', 'c'],
  expectedValue: 0.75, recommendationTier: 'HIGH_EVIDENCE', recommendationReasonCodes: ['DETERMINISTIC_TOP_PROBABILITY'],
  dataQuality: 1, adversarialRisk: 0.10,
  decisionAudit: { dataQuality: 1, adversarialRiskScore: 10 },
  investment: false, stake: 0, stakeReasonZh: '', stakeReasonEn: '', stakeAudit: null,
  ...overrides,
});
const positiveAllocation = assignInvestments([allocationForecast()], allocationMatch(), AGENTS[0], 10_000)[0];
assert.equal(positiveAllocation.investment, true, 'strong positive evidence must be eligible for autonomous staking');
assert.ok(positiveAllocation.stake >= 50 && positiveAllocation.stake <= positiveAllocation.stakeAudit.singleCap);
assert.equal(positiveAllocation.stakeAudit.reasonCode, 'ALLOCATED');
const negativeAllocation = assignInvestments([allocationForecast({ expectedValue: -0.01 })], allocationMatch(), AGENTS[0], 10_000)[0];
assert.equal(negativeAllocation.stake, 0);
assert.equal(negativeAllocation.stakeAudit.reasonCode, 'NEGATIVE_OR_LOW_EV');
const lowQualityAllocation = assignInvestments([allocationForecast({ dataQuality: 0.1, decisionAudit: { dataQuality: 0.1, adversarialRiskScore: 10 } })], allocationMatch(), AGENTS[0], 10_000)[0];
assert.equal(lowQualityAllocation.pick, '1', 'low quality must retain an explicit recommendation direction');
assert.equal(lowQualityAllocation.stake, 0, 'low quality must never force a stake');
assert.equal(lowQualityAllocation.stakeAudit.reasonCode, 'DATA_QUALITY_LOW');
const longOddsAllocation = assignInvestments([allocationForecast({ probabilities: { '1': 0.25, X: 0.40, '2': 0.35 }, expectedValue: 1.5 })], allocationMatch(10), AGENTS[0], 10_000)[0];
assert.ok(longOddsAllocation.stake <= 50, 'odds at or above 8 must stay within 0.5% of balance');
const redZoneAllocation = assignInvestments([allocationForecast()], allocationMatch(), AGENTS[0], 1_000)[0];
assert.equal(redZoneAllocation.stake, 0, 'red zone must stop new stakes while forecasts continue');
assert.equal(redZoneAllocation.stakeAudit.reasonCode, 'RED_ZONE_RESTRICTED');
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

const conflictingBrazilLeague = baseMatch('conflicting-brazil', leagues[1], 1, {
  leagueId: 'laliga',
  leagueName: '巴西甲级联赛',
  leagueNameEn: 'Brazil Serie A',
  leagueShortName: '巴甲',
});
assert.equal(identifyLeague(conflictingBrazilLeague), null, 'readable Brazilian league labels must override a stale La Liga id');
assert.equal(
  buildBigFiveSurvivalArena([conflictingBrazilLeague], nowMs).availableMatches,
  0,
  'the browser preview must not place a Brazilian fixture in a Big Five slot',
);
const conflictingChampionshipLeague = baseMatch('conflicting-championship', leagues[0], 1, {
  leagueId: 'epl',
  leagueName: '英格兰冠军联赛',
  leagueNameEn: 'EFL Championship',
  leagueShortName: '英冠',
});
assert.equal(identifyLeague(conflictingChampionshipLeague), null, 'readable Championship labels must override a stale EPL id');
assert.equal(
  buildBigFiveSurvivalArena([conflictingChampionshipLeague], nowMs).availableMatches,
  0,
  'the browser preview must not place a Championship fixture in a Premier League slot',
);

const lifecycleInput = fixtures.filter((row) => !row.id.endsWith('-overflow'));
const partialInput = [
  baseMatch('partial-laliga', leagues[1], 2, {
    kickoffTime: '2026-08-15T20:00:00+08:00',
    businessDate: '2026-08-15',
  }),
  baseMatch('partial-ligue1', leagues[4], 8, {
    kickoffTime: '2026-08-16T20:00:00+08:00',
    businessDate: '2026-08-16',
  }),
];
const oneMatchCycle = updateAiArenaState({
  matches: [partialInput[0]],
  state: null,
  now: '2026-08-14T00:00:00.000Z',
});
assert.equal(oneMatchCycle.payload.state, 'FORMING', 'one qualified fixture is not enough to lock a round');
assert.equal(oneMatchCycle.payload.roundActive, false);
assert.equal(oneMatchCycle.payload.availableMatches, 1);

const earlyPartialCycle = updateAiArenaState({
  matches: partialInput,
  state: null,
  now: '2026-08-13T00:00:00.000Z',
});
assert.equal(earlyPartialCycle.payload.state, 'FORMING', 'partial pools must keep filling before Friday');
assert.equal(earlyPartialCycle.payload.availableMatches, 2);

const partialCycle = updateAiArenaState({
  matches: partialInput,
  state: null,
  now: '2026-08-14T00:00:00.000Z',
});
assert.equal(partialCycle.payload.version, PAYLOAD_VERSION);
assert.equal(partialCycle.payload.state, 'LOCKED', 'two qualified fixtures must start the current round');
assert.equal(partialCycle.payload.roundActive, true);
assert.equal(partialCycle.payload.complete, false, 'a partial round must not claim the ten-match target is complete');
assert.equal(partialCycle.payload.availableMatches, 2);
assert.equal(partialCycle.payload.matches.length, 2);
assert.equal(partialCycle.payload.rules.predictionsPerAgent, 2);
assert.equal(partialCycle.payload.poolPolicy, 'complete-or-friday-partial-lock-v1');
assert.equal(partialCycle.payload.partialLockAt, '2026-08-14T00:00:00+08:00');
assert.equal(partialCycle.payload.shortfallPolicy, 'lock-current-qualified-pool-no-backfill');
assert.equal(partialCycle.payload.dataAccess.mode, 'shared-immutable-pre-match-snapshot');
assert.equal(partialCycle.payload.dataAccess.identicalInputs, true);
assert.equal(partialCycle.payload.dataAccess.externalProviderCallsActive, false);
assert.equal(partialCycle.payload.resultWriter.mode, 'trusted-official-auto-settlement');
assert.equal(partialCycle.payload.resultWriter.officialOnly, true);
assert.equal(partialCycle.payload.resultWriter.modelScoreWriteAllowed, false);
assert.equal(partialCycle.payload.stakeFreedom, 'any-qualified-match-or-zero-with-risk-caps');
assert.equal(isPublishedBigFiveSurvivalArena(partialCycle.payload), true);
assert.deepEqual(partialCycle.payload.agents.map((row) => row.id), ['gpt', 'kimi', 'gemini', 'deepseek', 'doubao', 'qwen']);
assert.ok(partialCycle.payload.agents.every((row) => row.forecasts.length === 2));

const partialNoBackfillCycle = updateAiArenaState({
  matches: lifecycleInput,
  state: partialCycle.state,
  now: '2026-08-14T00:05:00.000Z',
});
assert.equal(partialNoBackfillCycle.payload.availableMatches, 2, 'a locked partial round must not backfill later fixtures');
assert.equal(partialNoBackfillCycle.payload.poolHash, partialCycle.payload.poolHash);
assert.equal(partialNoBackfillCycle.payload.submissionRootHash, partialCycle.payload.submissionRootHash);

const refreshTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-ai-arena-refresh-'));
try {
  const refreshStoreDir = path.join(refreshTempDir, 'store');
  const refreshPublicDir = path.join(refreshTempDir, 'public', 'data');
  fs.mkdirSync(refreshStoreDir, { recursive: true });
  fs.mkdirSync(refreshPublicDir, { recursive: true });
  fs.writeFileSync(
    path.join(refreshStoreDir, 'ai-arena-state.json'),
    JSON.stringify(partialNoBackfillCycle.state),
  );
  fs.writeFileSync(path.join(refreshPublicDir, 'matches-current.json'), JSON.stringify(partialInput));
  fs.writeFileSync(
    path.join(refreshPublicDir, 'ai-arena.json'),
    JSON.stringify({ ...partialNoBackfillCycle.payload, version: 'ai-big-five-survival-v3' }),
  );
  const refreshed = spawnSync(process.execPath, [path.join(root, 'scripts', 'refreshAiArenaPublication.cjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SERVER_STORE_DIR: refreshStoreDir,
      PUBLIC_DATA_DIR: refreshPublicDir,
      AI_ARENA_REFRESHED_AT: '2026-08-14T00:05:00.000Z',
    },
  });
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const refreshedPayload = JSON.parse(fs.readFileSync(path.join(refreshPublicDir, 'ai-arena.json'), 'utf8'));
  assert.equal(refreshedPayload.version, PAYLOAD_VERSION);
  assert.equal(refreshedPayload.complete, false);
  assert.equal(refreshedPayload.roundActive, true);
  assert.equal(refreshedPayload.poolHash, partialCycle.payload.poolHash);
  assert.equal(refreshedPayload.submissionRootHash, partialCycle.payload.submissionRootHash);
  assert.deepEqual(refreshedPayload.agents.map((row) => row.id), ['gpt', 'kimi', 'gemini', 'deepseek', 'doubao', 'qwen']);
} finally {
  fs.rmSync(refreshTempDir, { recursive: true, force: true });
}

const partialSettledCycle = updateAiArenaState({
  matches: partialInput.map((match, index) => ({
    ...match,
    source: 'sporttery',
    status: 'FINISHED',
    scoreHome: index === 0 ? 1 : 0,
    scoreAway: index === 0 ? 0 : 1,
    resultProvenance: {
      provider: 'sporttery',
      source: 'sporttery:official-results',
      sourceMatchId: match.id,
      sourceStatus: 'FINISHED',
      official: true,
      trusted: true,
      scoreHome: index === 0 ? 1 : 0,
      scoreAway: index === 0 ? 0 : 1,
      kickoffTime: match.kickoffTime,
      eventVersion: `partial-result-${index + 1}`,
    },
  })),
  state: partialNoBackfillCycle.state,
  now: '2026-08-14T16:00:00.000Z',
});
assert.equal(partialSettledCycle.payload.matches.filter((row) => row.settlement?.status === 'SETTLED').length, 2);

const firstCycle = updateAiArenaState({
  matches: lifecycleInput,
  state: null,
  now: '2026-08-11T00:00:00.000Z',
});
assert.equal(firstCycle.state.version, STATE_VERSION);
assert.equal(firstCycle.payload.version, PAYLOAD_VERSION);
assert.equal(firstCycle.payload.state, 'LOCKED');
assert.equal(isPublishedBigFiveSurvivalArena(firstCycle.payload), true);
assert.equal(firstCycle.payload.complete, true);
assert.equal(firstCycle.payload.matches.length, 10);
assert.equal(firstCycle.payload.agents.length, 6);
assert.equal(firstCycle.payload.integrity.immutable, true);
assert.match(firstCycle.payload.poolHash, /^[a-f0-9]{64}$/);
assert.match(firstCycle.payload.submissionRootHash, /^[a-f0-9]{64}$/);
for (const agent of firstCycle.payload.agents) {
  assert.equal(agent.forecasts.length, 10);
  assert.ok(agent.investedMatches >= 0 && agent.investedMatches <= 10);
  assert.ok(agent.totalStake >= 0 && agent.totalStake <= agent.balance * agent.staking.weeklyRiskFraction);
  assert.equal(agent.reservedBalance, agent.balance - agent.totalStake);
  assert.match(agent.submissionHash, /^[a-f0-9]{64}$/);
  for (const forecast of agent.forecasts) {
    assert.equal(forecast.decisionAudit.version, DECISION_ENGINE_VERSION);
    assert.equal(forecast.decisionAudit.evidenceAgents.length, 7);
    assert.ok(forecast.decisionAudit.drawSignalScore >= 0 && forecast.decisionAudit.drawSignalScore <= 100);
    assert.ok(forecast.decisionAudit.adversarialRiskScore >= 0 && forecast.decisionAudit.adversarialRiskScore <= 100);
    assert.ok(['HIGH_EVIDENCE', 'REFERENCE', 'LOW_CONFIDENCE'].includes(forecast.recommendationTier));
    assert.ok(forecast.stakeAudit);
    assert.equal(
      forecast.reasonsZh.some((reason) => reason.includes('平局结构') && reason.includes('反方风险')),
      true,
    );
  }
}

const legacyLockedState = JSON.parse(JSON.stringify(firstCycle.state));
const legacyLockedWeek = legacyLockedState.months[firstCycle.payload.monthKey].weeks[firstCycle.payload.weekStart];
for (const submission of Object.values(legacyLockedWeek.agentForecasts)) {
  submission.model = 'strategy-profile-v1';
  for (const forecast of submission.forecasts) delete forecast.stakeAudit;
}
const legacyCompatibilityCycle = updateAiArenaState({
  matches: lifecycleInput,
  state: legacyLockedState,
  now: '2026-08-11T00:00:00.000Z',
});
assert.equal(legacyCompatibilityCycle.payload.version, 'ai-big-five-survival-v3', 'legacy locked submissions must stay on their original contract');
assert.equal(legacyCompatibilityCycle.payload.stakingEngine, null);
assert.equal(legacyCompatibilityCycle.payload.submissionRootHash, legacyLockedWeek.submissionRootHash, 'legacy locked roots must not be rewritten');

const duplicateCycle = updateAiArenaState({
  matches: lifecycleInput,
  state: firstCycle.state,
  now: '2026-08-11T00:00:00.000Z',
});
assert.equal(duplicateCycle.payload.poolHash, firstCycle.payload.poolHash);
assert.equal(duplicateCycle.payload.submissionRootHash, firstCycle.payload.submissionRootHash);
assert.equal(duplicateCycle.payload.integrity.stateHash, firstCycle.payload.integrity.stateHash);

const delayed = lifecycleInput.map((match, index) => index === 0 ? {
  ...match,
  source: 'sporttery',
  kickoffTime: new Date(Date.parse(match.kickoffTime) + 72 * 60 * 60 * 1000).toISOString(),
  updatedAt: '2026-08-12T00:00:00.000Z',
} : match);
const postponedCycle = updateAiArenaState({
  matches: delayed,
  state: duplicateCycle.state,
  now: '2026-08-12T00:00:00.000Z',
});
assert.equal(postponedCycle.payload.matches.filter((row) => row.settlement?.status === 'VOID').length, 1);

const untrustedFinishedCycle = updateAiArenaState({
  matches: lifecycleInput.map((match) => ({ ...match, status: 'FINISHED', scoreHome: 9, scoreAway: 0 })),
  state: duplicateCycle.state,
  now: '2026-08-14T15:00:00.000Z',
});
assert.equal(
  untrustedFinishedCycle.payload.matches.filter((row) => row.settlement).length,
  0,
  'untrusted scores must not settle the arena',
);

const finishedRows = lifecycleInput.map((match, index) => ({
  ...match,
  source: 'sporttery',
  status: 'FINISHED',
  scoreHome: index % 3 === 0 ? 2 : 0,
  scoreAway: index % 3 === 0 ? 1 : index % 3 === 1 ? 0 : 1,
  eventVersion: `result-${index + 1}`,
  resultProvenance: {
    provider: 'sporttery',
    source: 'sporttery:official-results',
    sourceMatchId: match.id,
    sourceStatus: 'FINISHED',
    official: true,
    trusted: true,
    scoreHome: index % 3 === 0 ? 2 : 0,
    scoreAway: index % 3 === 0 ? 1 : index % 3 === 1 ? 0 : 1,
    kickoffTime: match.kickoffTime,
    eventVersion: `result-${index + 1}`,
  },
}));
const settledCycle = updateAiArenaState({
  matches: finishedRows,
  state: untrustedFinishedCycle.state,
  now: '2026-08-14T16:00:00.000Z',
});
assert.equal(settledCycle.payload.matches.filter((row) => row.settlement).length, 10);
assert.equal(settledCycle.payload.standings.length, 6);
assert.equal(settledCycle.payload.seasonStandings.length, 6);
assert.ok(settledCycle.payload.awards?.monthChampion);
assert.ok(settledCycle.payload.flopBoard.length > 0);
assert.equal(settledCycle.payload.evidenceStandings.length, 6);
assert.ok(settledCycle.payload.evidenceStandings.every((row) => row.settled === 10));
assert.ok(settledCycle.payload.evidenceStandings.every((row) => Number.isFinite(row.brierScore)));
for (const row of settledCycle.payload.standings) {
  assert.equal(row.settledPredictions, 10);
  assert.ok(Number.isFinite(row.brierScore));
  assert.ok(row.balance >= 0);
  assert.ok(row.wealthRank >= 1 && row.wealthRank <= 6);
  assert.ok(row.predictionRank >= 1 && row.predictionRank <= 6);
  assert.ok(row.riskRank >= 1 && row.riskRank <= 6);
  assert.ok(Number.isFinite(row.stageScore));
  assert.ok(row.balanceHistory.length >= 1);
  assert.ok(row.settledStake >= 0);
  assert.ok(Number.isFinite(row.realizedProfit));
  assert.equal(row.roi === null || Number.isFinite(row.roi), true);
}
assert.equal(settledCycle.payload.formalStatisticsExcluded, true);
assert.equal(settledCycle.payload.disclosure, 'strategy-simulation-not-external-model-calls');

const septemberFixtures = lifecycleInput.map((match, index) => ({
  ...match,
  id: `sep-${match.id}`,
  sourceMatchId: `sep-${match.id}`,
  kickoffTime: `2026-09-${String(1 + (index % 3)).padStart(2, '0')}T20:00:00+08:00`,
  businessDate: `2026-09-${String(1 + (index % 3)).padStart(2, '0')}`,
}));
const resetCycle = updateAiArenaState({
  matches: septemberFixtures,
  state: settledCycle.state,
  now: '2026-09-01T00:00:00.000Z',
});
assert.equal(resetCycle.payload.monthKey, '2026-09');
assert.equal(resetCycle.payload.state, 'LOCKED');
assert.ok(resetCycle.payload.agents.every((row) => row.balance === 10_000));
assert.ok(resetCycle.payload.agents.every((row) => row.brierScore === null));
assert.ok(resetCycle.payload.seasonStandings.some((row) => row.seasonPoints > 0));

const sqliteTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'football-ai-arena-'));
try {
  const sqlitePath = path.join(sqliteTempDir, 'ai-arena.db');
  const persisted = persistAiArenaSqlite({
    dbPath: sqlitePath,
    state: settledCycle.state,
    payload: settledCycle.payload,
  });
  assert.equal(persisted.counts.players, 6);
  assert.equal(persisted.counts.predictions, 60);
  assert.ok(persisted.counts.balanceHistory >= 6);
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    assert.ok(tables.includes('ai_players'));
    assert.ok(tables.includes('ai_predictions'));
    assert.ok(tables.includes('ai_balance_history'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_predictions WHERE settled_at IS NOT NULL').get().count, 60);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_predictions WHERE decision_version = ?').get(DECISION_ENGINE_VERSION).count, 60);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_predictions WHERE decision_evidence_json IS NOT NULL').get().count, 60);
  } finally {
    db.close();
  }
} finally {
  fs.rmSync(sqliteTempDir, { recursive: true, force: true });
}

const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const listSource = fs.readFileSync(path.join(root, 'src', 'pages', 'PredictionsList.tsx'), 'utf8');
const arenaSource = fs.readFileSync(path.join(root, 'src', 'pages', 'AIArena.tsx'), 'utf8');
const navbarSource = fs.readFileSync(path.join(root, 'src', 'components', 'Navbar.tsx'), 'utf8');
const previewSource = fs.readFileSync(path.join(root, 'src', 'components', 'predictions', 'AIArenaPreview.tsx'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server', 'index.cjs'), 'utf8');
const generationSource = fs.readFileSync(path.join(root, 'server', 'dataGenerationBundle.cjs'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'scripts', 'syncData.cjs'), 'utf8');
const bundleReleaseSource = fs.readFileSync(path.join(root, 'deploy', 'light-server', 'release-from-bundle.sh'), 'utf8');
assert.match(appSource, /path="\/ai-arena"/);
assert.match(appSource, /path="\/ai-arena\/:matchId"/);
assert.doesNotMatch(listSource, /AIArenaPreview/);
assert.match(arenaSource, /五大联赛策略模拟场/);
assert.match(arenaSource, /这是本地策略规则模拟/);
assert.match(arenaSource, /不是 GPT、Gemini、DeepSeek、Kimi、豆包或 Qwen 的实时 API 对战/);
assert.match(arenaSource, /系统只按可信官方赛果自动结算/);
assert.match(arenaSource, /周五仍不足时，至少 2 场即可锁定开赛/);
assert.match(navbarSource, /key: 'arena'/);
assert.match(navbarSource, /策略模拟/);
assert.match(arenaSource, /fetchPublishedBigFiveSurvivalArena/);
assert.match(arenaSource, /A1–A7 证据模块与最终裁决/);
assert.match(arenaSource, /平局结构分是相对信号，不是平局概率/);
assert.match(arenaSource, /证据模块 Brier 排行/);
assert.match(arenaSource, /自主积分/);
assert.doesNotMatch(arenaSource, /本周三场投资之一/);
assert.match(previewSource, /战绩\/ROI/);
assert.match(previewSource, /survival-flop-board/);
assert.match(previewSource, /balanceHistory/);
assert.match(serverSource, /\/api\/v1\/ai-arena/);
assert.match(serverSource, /\/api\/v1\/ai-arena\/status/);
assert.match(serverSource, /const validArena = Boolean\(arena && typeof arena === "object" && !Array\.isArray\(arena\)\)/);
assert.doesNotMatch(serverSource, /sourceBatches\s*\.slice\(0, 32\)/);
assert.match(generationSource, /ai-arena\.json/);
assert.match(syncSource, /updateAiArenaState/);
assert.match(syncSource, /AI_ARENA_STATE_PATH/);
assert.match(bundleReleaseSource, /PUBLIC_DATA_CACHE_FILES=\([\s\S]*ai-arena\.json[\s\S]*\)/);

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
  immutableLifecycle: {
    version: settledCycle.payload.version,
    poolHash: settledCycle.payload.poolHash,
    submissionRootHash: settledCycle.payload.submissionRootHash,
    settledMatches: settledCycle.payload.matches.filter((row) => row.settlement).length,
    flopRows: settledCycle.payload.flopBoard.length,
  },
  formalStatisticsExcluded: true,
  decisionEngine: DECISION_ENGINE_VERSION,
}, null, 2));
