const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hasRejectedPriorField = (value) => {
  if (Array.isArray(value)) return value.some(hasRejectedPriorField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    key === 'worldCupPrior'
    || key === 'worldCupPriorSignature'
    || hasRejectedPriorField(item)
  ));
};

const {
  attachWorldCupPrior,
  loadWorldCupKimiDataset,
  worldCupDatasetSummary,
} = require('./syncData.cjs');

const dataset = readJson('public/data/worldcup-kimi-dataset.json');
const teams = Array.isArray(dataset.teams) ? dataset.teams : [];
const fixtures = Array.isArray(dataset.fixtures) ? dataset.fixtures : [];
const expectedGroups = new Set('ABCDEFGHIJKL'.split(''));
const teamByKey = new Map(teams.map((team) => [team.key, team]));
const groupFixtures = fixtures.filter((fixture) => fixture.stage === '小组赛');
const outlookGroups = new Set(teams.map((team) => String(team.groupOutlook?.group || '')).filter(Boolean));
const fixtureGroups = new Set(groupFixtures.map((fixture) => fixture.group).filter(Boolean));
const mismatchedTeamOutlooks = teams.filter((team) => (
  team.groupOutlook?.group && team.groupOutlook.group !== team.group
));
const invalidFixtureDates = fixtures.filter((fixture) => (
  !fixture.kickoffTime || !Number.isFinite(Date.parse(fixture.kickoffTime))
));
const mismatchedFixtureTeams = groupFixtures.filter((fixture) => (
  teamByKey.get(fixture.homeKey)?.group !== fixture.group
  || teamByKey.get(fixture.awayKey)?.group !== fixture.group
));
const malformedGroupCounts = [...expectedGroups].filter((group) => (
  teams.filter((team) => team.group === group).length !== 4
));
const untrustedFixtures = fixtures.filter((fixture) => (
  !['official', 'verified', 'reconciled'].includes(String(fixture.sourceQuality || '').toLowerCase())
));
const rawSafe = (
  teams.length === 48
  && fixtures.length === 104
  && groupFixtures.length === 72
  && outlookGroups.size === 12
  && fixtureGroups.size === 12
  && mismatchedTeamOutlooks.length === 0
  && invalidFixtureDates.length === 0
  && mismatchedFixtureTeams.length === 0
  && malformedGroupCounts.length === 0
  && untrustedFixtures.length === 0
);

const safetySource = readText('src/services/worldCupDatasetSafety.ts');
const worldCupDataSource = readText('src/services/worldCupData.ts');
const appSource = readText('src/App.tsx');
const syncSource = readText('scripts/syncData.cjs');

assert(safetySource.includes('team-group-outlook-mismatch'), 'team/groupOutlook mismatch gate is missing');
assert(safetySource.includes('invalid-fixture-dates'), 'invalid fixture date gate is missing');
assert(safetySource.includes('fixture-groups-not-diverse'), 'single-value fixture group gate is missing');
assert(safetySource.includes('fixture-quality-untrusted'), 'untrusted fallback quality gate is missing');
assert(safetySource.includes('if (!WORLD_CUP_DATASET_SAFETY.teamPriorSafe) return null'), 'unsafe team prior does not fail closed');
assert(safetySource.includes('if (!WORLD_CUP_DATASET_SAFETY.fixtureSeedSafe) return []'), 'unsafe fixtures do not fail closed');
assert(worldCupDataSource.includes('getSafeKimiWorldCupTeamProfile'), 'World Cup model is not using the safe team loader');
assert(worldCupDataSource.includes('getSafeKimiWorldCupFixtureSeeds'), 'World Cup fixtures are not using the safe fixture loader');
assert(worldCupDataSource.includes('if (!WORLD_CUP_DATASET_SAFETY.fixtureSeedSafe) return []'), 'seed fixture API does not fail closed');
assert(!worldCupDataSource.includes('WORLD_CUP_GROUP_PAIRINGS'), 'synthetic group fixture fallback is still enabled');
assert(!worldCupDataSource.includes('seededKickoffTime'), 'synthetic kickoff fallback is still enabled');
// The old page is removed; the dataset and sync guards above and below remain active.
assert(appSource.includes('<Route path="/worldcup" element={<Navigate to="/leagues" replace />} />'),
  'retired World Cup route no longer redirects to the live league page');
assert(['src/pages/WorldCup.tsx', 'src/components/WorldCupSpotlight.tsx', 'src/components/WorldCupLastDance.tsx']
  .every(relative => !fs.existsSync(path.join(rootDir, relative))),
  'retired World Cup UI source has been reintroduced');

const syncDataset = loadWorldCupKimiDataset();
const syncSummary = worldCupDatasetSummary(syncDataset);
assert(syncSummary?.accepted === false, 'sync loader accepted the known-corrupt World Cup dataset');
assert(syncSummary?.modelingStatus === 'rejected', 'sync summary does not expose rejected modeling status');
assert(syncSummary?.modelingUsage === 'rejected-fail-closed', 'sync loader is not failing closed');
[
  'team-group-outlook-mismatch',
  'invalid-fixture-dates',
  'fixture-groups-not-diverse',
  'fixture-quality-untrusted',
].forEach((reason) => {
  assert(syncSummary.rejectionReasons.includes(reason), `sync audit is missing rejection reason: ${reason}`);
});
assert(syncSummary.audit?.mismatchedTeamOutlooks > 0, 'sync audit does not expose team/outlook mismatch counts');
assert(syncSummary.audit?.untrustedFixtures > 0, 'sync audit does not expose untrusted fixture counts');

const storedPriorMatch = {
  id: 'worldcup-gate-verifier',
  leagueNameEn: 'FIFA World Cup',
  worldCupPrior: { source: 'kimi-worldcup-dataset' },
  externalSignals: {
    keep: true,
    worldCupPrior: { source: 'kimi-worldcup-dataset' },
  },
  probabilityModel: {
    keep: true,
    worldCupPrior: { source: 'kimi-worldcup-dataset' },
  },
  predictionMeta: {
    keep: true,
    worldCupPriorSignature: 'stale-signature',
    featureSnapshot: {
      modelInputs: {
        keep: true,
        worldCupPrior: { source: 'kimi-worldcup-dataset' },
      },
    },
  },
};
const strippedMatch = attachWorldCupPrior(storedPriorMatch, syncDataset);
assert(!hasRejectedPriorField(strippedMatch), 'rejected World Cup prior survived recursive sync cleanup');
assert(strippedMatch.externalSignals?.keep === true, 'sync cleanup removed unrelated external signals');
assert(strippedMatch.probabilityModel?.keep === true, 'sync cleanup removed unrelated probability model fields');
assert(strippedMatch.predictionMeta?.featureSnapshot?.modelInputs?.keep === true, 'sync cleanup removed unrelated model inputs');
assert(strippedMatch.predictionMeta?.rejectedDataSources?.includes('kimi-worldcup-dataset'), 'rejected source is not recorded on prediction metadata');
assert(syncSource.includes('worldCupKimiData: worldCupKimiSummary'), 'sync meta does not persist the audited rejection summary');
assert(syncSource.includes('dataSources: match.predictionHealth.dataSources || null'), 'feature snapshot model health omits data-source rejection audit');
assert((syncSource.match(/attachWorldCupPrior\(match, worldCupKimiDataset\)/g) || []).length >= 4,
  'sync pipeline does not re-apply the World Cup gate across merge/model/publish boundaries');

if (!rawSafe) {
  assert(mismatchedTeamOutlooks.length > 0 || invalidFixtureDates.length > 0 || fixtureGroups.size !== 12 || untrustedFixtures.length > 0,
    'dataset is marked unsafe without a measurable reason');
}

const current = readJson('public/data/matches-current.json');
const history = readJson('public/data/matches-history.json');
const worldCupText = '世界杯';
const officialNumbers = [...current, ...history]
  .filter((match) => match.source === 'sporttery' || String(match.id || '').startsWith('sporttery_'))
  .filter((match) => [match.leagueName, match.leagueNameEn, match.leagueShortName, match.leagueShortNameEn]
    .join(' ')
    .toLowerCase()
    .includes(worldCupText))
  .map((match) => Number(String(match.matchNo || '').match(/(\d{3})$/)?.[1]))
  .filter((value) => Number.isInteger(value) && value >= 1 && value <= 104);
assert(officialNumbers.length > 0, 'no official World Cup match numbers are available for dynamic stage resolution');

console.log(JSON.stringify({
  ok: true,
  rawDatasetSafe: rawSafe,
  failClosedExpected: !rawSafe,
  syncModelingStatus: syncSummary.modelingStatus,
  syncModelingUsage: syncSummary.modelingUsage,
  syncRejectionReasons: syncSummary.rejectionReasons,
  recursivePriorCleanup: !hasRejectedPriorField(strippedMatch),
  audit: {
    teams: teams.length,
    fixtures: fixtures.length,
    mismatchedTeamOutlooks: mismatchedTeamOutlooks.length,
    outlookGroups: outlookGroups.size,
    groupFixtureGroups: fixtureGroups.size,
    invalidFixtureDates: invalidFixtureDates.length,
    mismatchedFixtureTeams: mismatchedFixtureTeams.length,
    untrustedFixtures: untrustedFixtures.length,
    officialScheduleRows: officialNumbers.length,
    latestOfficialMatchNumber: Math.max(...officialNumbers)
  }
}, null, 2));
