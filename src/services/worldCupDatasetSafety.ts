import {
  KIMI_WORLD_CUP_DATASET,
  type KimiWorldCupFixtureSeed,
  type KimiWorldCupTeamProfile
} from './worldCupKimiDataset';

const EXPECTED_GROUPS = 'ABCDEFGHIJKL'.split('');
const EXPECTED_GROUP_SET = new Set(EXPECTED_GROUPS);
const TRUSTED_FIXTURE_QUALITIES = new Set(['official', 'verified', 'reconciled']);

type TeamWithOutlookGroup = KimiWorldCupTeamProfile & {
  groupOutlook?: (KimiWorldCupTeamProfile['groupOutlook'] & { group?: string | null }) | null;
};

const teams = KIMI_WORLD_CUP_DATASET.teams as unknown as TeamWithOutlookGroup[];
const fixtures = KIMI_WORLD_CUP_DATASET.fixtures as unknown as KimiWorldCupFixtureSeed[];
const teamByKey = new Map(teams.map((team) => [team.key, team]));

const groupCounts = Object.fromEntries(EXPECTED_GROUPS.map((group) => [group, 0])) as Record<string, number>;
for (const team of teams) {
  if (EXPECTED_GROUP_SET.has(team.group)) groupCounts[team.group] += 1;
}

const invalidTeamGroups = teams
  .filter((team) => !EXPECTED_GROUP_SET.has(team.group))
  .map((team) => team.key);
const mismatchedTeamOutlooks = teams
  .filter((team) => {
    const outlookGroup = String(team.groupOutlook?.group || '').trim();
    return Boolean(outlookGroup) && outlookGroup !== team.group;
  })
  .map((team) => team.key);
const outlookGroups = new Set(
  teams.map((team) => String(team.groupOutlook?.group || '').trim()).filter(Boolean)
);
const malformedGroupCardinality = EXPECTED_GROUPS.filter((group) => groupCounts[group] !== 4);

const groupFixtures = fixtures.filter((fixture) => fixture.stage === '小组赛');
const groupFixtureGroups = new Set(groupFixtures.map((fixture) => fixture.group).filter(Boolean));
const invalidFixtureDates = fixtures
  .filter((fixture) => !fixture.kickoffTime || !Number.isFinite(Date.parse(fixture.kickoffTime)))
  .map((fixture) => fixture.matchNo);
const invalidFixtureGroups = groupFixtures
  .filter((fixture) => !EXPECTED_GROUP_SET.has(fixture.group))
  .map((fixture) => fixture.matchNo);
const mismatchedFixtureTeams = groupFixtures
  .filter((fixture) => {
    const homeGroup = teamByKey.get(fixture.homeKey)?.group;
    const awayGroup = teamByKey.get(fixture.awayKey)?.group;
    return !homeGroup || !awayGroup || homeGroup !== fixture.group || awayGroup !== fixture.group;
  })
  .map((fixture) => fixture.matchNo);
const untrustedFixtureQuality = fixtures
  .filter((fixture) => !TRUSTED_FIXTURE_QUALITIES.has(String(fixture.sourceQuality || '').toLowerCase()))
  .map((fixture) => fixture.matchNo);

const teamPriorSafe = (
  teams.length === 48
  && invalidTeamGroups.length === 0
  && mismatchedTeamOutlooks.length === 0
  && malformedGroupCardinality.length === 0
  && outlookGroups.size === EXPECTED_GROUPS.length
);
const fixtureSeedSafe = (
  teamPriorSafe
  && fixtures.length === 104
  && groupFixtures.length === 72
  && groupFixtureGroups.size === EXPECTED_GROUPS.length
  && invalidFixtureDates.length === 0
  && invalidFixtureGroups.length === 0
  && mismatchedFixtureTeams.length === 0
  && untrustedFixtureQuality.length === 0
);

export const WORLD_CUP_DATASET_SAFETY = Object.freeze({
  version: 'world-cup-dataset-safety-v1',
  sourceSignature: KIMI_WORLD_CUP_DATASET.signature,
  teamPriorSafe,
  fixtureSeedSafe,
  safe: teamPriorSafe && fixtureSeedSafe,
  counts: Object.freeze({
    teams: teams.length,
    fixtures: fixtures.length,
    groupFixtures: groupFixtures.length,
    outlookGroups: outlookGroups.size,
    groupFixtureGroups: groupFixtureGroups.size,
    invalidTeamGroups: invalidTeamGroups.length,
    mismatchedTeamOutlooks: mismatchedTeamOutlooks.length,
    malformedGroupCardinality: malformedGroupCardinality.length,
    invalidFixtureDates: invalidFixtureDates.length,
    invalidFixtureGroups: invalidFixtureGroups.length,
    mismatchedFixtureTeams: mismatchedFixtureTeams.length,
    untrustedFixtureQuality: untrustedFixtureQuality.length
  }),
  reasons: Object.freeze([
    ...(invalidTeamGroups.length ? ['invalid-team-groups'] : []),
    ...(mismatchedTeamOutlooks.length ? ['team-group-outlook-mismatch'] : []),
    ...(malformedGroupCardinality.length ? ['team-group-cardinality-invalid'] : []),
    ...(outlookGroups.size !== EXPECTED_GROUPS.length ? ['team-outlook-groups-not-diverse'] : []),
    ...(invalidFixtureDates.length ? ['invalid-fixture-dates'] : []),
    ...(invalidFixtureGroups.length ? ['invalid-fixture-groups'] : []),
    ...(groupFixtureGroups.size !== EXPECTED_GROUPS.length ? ['fixture-groups-not-diverse'] : []),
    ...(mismatchedFixtureTeams.length ? ['fixture-team-group-mismatch'] : []),
    ...(untrustedFixtureQuality.length ? ['fixture-quality-untrusted'] : [])
  ])
});

const normalizeKey = (value?: string) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
  .replace(/^-+|-+$/g, '');

const safeTeamByKey = new Map<string, KimiWorldCupTeamProfile>();
if (WORLD_CUP_DATASET_SAFETY.teamPriorSafe) {
  for (const team of teams) {
    [team.key, team.nameZh, team.nameEn]
      .forEach((value) => safeTeamByKey.set(normalizeKey(value), team));
  }
}

export const getSafeKimiWorldCupTeamProfile = (value?: string): KimiWorldCupTeamProfile | null => {
  if (!WORLD_CUP_DATASET_SAFETY.teamPriorSafe) return null;
  return safeTeamByKey.get(normalizeKey(value)) || null;
};

export const getSafeKimiWorldCupFixtureSeeds = (): KimiWorldCupFixtureSeed[] => {
  if (!WORLD_CUP_DATASET_SAFETY.fixtureSeedSafe) return [];
  return fixtures.slice();
};
