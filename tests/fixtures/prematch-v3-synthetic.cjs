'use strict';
// Every match and source fact below is synthetic. Fitting these fixtures
// exercises the real learning/apply contract, not measured predictive
// accuracy, calibration, source admission or deployment.
const assert = require('node:assert/strict');
const { stableHash } = require('../../src/services/webConsensusEvidence.cjs');
const { buildDynamicGoalStrengthArtifact } = require('../../scripts/dynamicGoalStrengthModel.cjs');
const { FEATURE_SCHEMA, FEATURE_SCHEMA_HASH } = require('../../src/services/prematchTeamEvidenceV3.cjs');
const { SOURCE_VERSION, buildPrematchV3Assessment } = require('../../src/services/prematchV3Assessment.cjs');
const { learnPrematchV3Candidate } = require('../../src/services/prematchV3Learning.cjs');
const { freezePrematchV3Record, joinPrematchV3ResearchResult } = require('../../src/services/prematchV3FrozenRecord.cjs');

const asOf = '2026-10-06T10:00:00.000000100Z';
const source = { provider: 'synthetic-team-fixture', receiptHash: 'a'.repeat(64), rawPayloadHash: 'b'.repeat(64) };
const metric = { attack: 'synthetic-observed-attack-contribution-per90', defense: 'synthetic-observed-defense-contribution-per90' };
const clone = value => structuredClone(value);
function seal(body) { return { ...body, contentHash: stableHash(body) }; }
function reseal(value) { const { contentHash, ...body } = value; return seal(body); }
function syntheticHistory() {
  return Array.from({ length: 12 }, (_, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`;
    return { sourceEventId: `synthetic-baseline-training-${i}`, sourceDataset: 'synthetic-v3-pipeline', date,
      competition: 'fixture-league', neutral: false,
      homeTeam: { entityId: i % 2 ? 'bravo' : 'alpha', raw: i % 2 ? 'Bravo' : 'Alpha' },
      awayTeam: { entityId: i % 2 ? 'alpha' : 'bravo', raw: i % 2 ? 'Alpha' : 'Bravo' },
      score: { home: 2 + i % 3, away: i % 2 }, availableAt: `${date}T16:00:00Z` };
  });
}
const baseline = { artifact: buildDynamicGoalStrengthArtifact(syntheticHistory()),
  createdAt: '2026-10-05T16:00:00Z', availableAt: '2026-10-05T16:01:00Z' };
const match = { id: 'sporttery_pipeline-synthetic', sourceMatchId: 'pipeline-synthetic', businessDate: '2026-10-06',
  eventVersion: '2026-10-06T14:00:00Z', kickoffTime: '2026-10-06T14:00:00Z', homeTeamId: 'alpha', awayTeamId: 'bravo',
  competition: 'fixture-league', neutral: false, status: 'SCHEDULED', isOnSale: true,
  predictionMeta: { cutoffTime: '2026-10-06T13:00:00Z' }, handicapLine: -1,
  odds: { odds1: 2.2, oddsX: 3.4, odds2: 3.1 }, oddsSource: 'synthetic:HAD',
  oddsObservedAt: '2026-10-06T09:30:00.000000050Z', oddsReceivedAt: '2026-10-06T09:31:00.000000099Z' };
function teamRows(side, fixtureMatch = match, depleted = false) {
  const teamId = fixtureMatch[`${side}TeamId`], date = fixtureMatch.eventVersion.slice(0, 10);
  const past = days => new Date(Date.parse(fixtureMatch.eventVersion) - days * 86400000).toISOString();
  const priorDate = past(5).slice(0, 10);
  const observation = (family, data) => ({ family, side, sourceMatchId: fixtureMatch.sourceMatchId,
    eventVersion: fixtureMatch.eventVersion, teamId, source, providerObservedAt: `${date}T09:00:00.000000050Z`,
    receivedAt: `${date}T09:01:00.000000099Z`, data });
  const player = (i, projected = false) => ({ playerId: `${side}-p${i}`, expectedMinutes: 90,
    contributionPer90: { attack: (depleted && side === 'home' ? .04 : .1) + (projected ? .01 : 0), defense: .06 },
    replacementPer90: { attack: .03, defense: .02 } });
  const prior = { sourceMatchId: `synthetic-prior-${side}`, eventVersion: `${priorDate}T12:00:00Z`, teamId,
    status: 'FINISHED', source, providerObservedAt: `${priorDate}T14:00:00Z`, receivedAt: `${priorDate}T14:01:00Z` };
  return [
    ...['confirmed', 'projected'].map(status => observation('roster', { status, contributionMetric: metric,
      players: Array.from({ length: 11 }, (_, i) => player(i, status === 'projected')) })),
    observation('injuries', { contributionMetric: metric, players: [{ ...player(12), availability: 'out' }] }),
    observation('fatigue', { lastMatchEndedAt: past(side === 'home' ? depleted ? 1 : 3 : depleted ? 5 : 2),
      minutesLast7Days: 990, minutesLast14Days: 1900, travelKm: side === 'home' ? 50 : 350, rotationCount: 2 }),
    observation('history', { rows: [{ ...prior, goalsFor: side === 'home' ? 2 : 1, goalsAgainst: 1 }] }),
    observation('xg', { rows: [{ ...prior, observed: true, observedXgFor: side === 'home' ? 1.8 : 1.1, observedXgAgainst: 1.2 }] }),
  ];
}
function asianQuotes() {
  return [-.25, -.75, 0].flatMap((homeLine, i) => [
    { homeLine: 0, rawPrices: { home: 1.95, away: 1.95 }, providerObservedAt: '2026-10-06T08:00:00Z', receivedAt: '2026-10-06T08:01:00Z' },
    { homeLine, rawPrices: { home: 2, away: 1.9 }, providerObservedAt: '2026-10-06T09:30:00Z', receivedAt: '2026-10-06T09:31:00Z' },
  ].map(row => ({ ...row, market: 'AH', source: 'synthetic-ah-fixture', company: `fixture-company-${i}`,
    sourceMatchId: match.sourceMatchId, eventVersion: match.eventVersion, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    oddsFormat: 'decimal', rawPayloadHash: String(i + 1).repeat(64) })));
}
match.externalSignals = { prematchV3: { version: SOURCE_VERSION,
  teamObservations: [...teamRows('home'), ...teamRows('away')], asianHandicapObservations: asianQuotes() } };
function syntheticResult(fixtureMatch, depleted = false) {
  const date = fixtureMatch.eventVersion.slice(0, 10);
  return seal({ regulationMinutes: 90, confirmation: 'research-confirmed-90min', source: 'sporttery:official-api',
    sourceHash: stableHash({ syntheticResult: fixtureMatch.sourceMatchId }), observedAt: `${date}T16:00:00Z`, receivedAt: `${date}T16:01:00Z`,
    match: { sourceMatchId: fixtureMatch.sourceMatchId, eventVersion: fixtureMatch.eventVersion, kickoffTime: fixtureMatch.kickoffTime,
      homeTeamId: fixtureMatch.homeTeamId, awayTeamId: fixtureMatch.awayTeamId, status: 'FINISHED',
      scoreHome: depleted ? 0 : 3, scoreAway: depleted ? 3 : 0,
      resultSource: 'sporttery:official-api', sourceUrl: 'https://webapi.sporttery.cn/synthetic-pipeline-results' } });
}
const learningDays = [1, 2, 3, 4, 5, 6].map(day => `2026-09-${String(day).padStart(2, '0')}`);
const trainingBaseline = { ...baseline, createdAt: '2026-08-01T12:00:00Z', availableAt: '2026-08-01T12:01:00Z' };
const learningRecords = learningDays.flatMap((date, day) => Array.from({ length: 8 }, (_, i) => {
  const depleted = i % 2 === 1, sourceMatchId = `synthetic-pipeline-training-${day}-${i}`;
  const fixtureMatch = { ...match, id: `sporttery_${sourceMatchId}`, sourceMatchId, businessDate: date,
    eventVersion: `${date}T14:00:00Z`, kickoffTime: `${date}T14:00:00Z`,
    predictionMeta: { cutoffTime: `${date}T13:00:00Z` },
    oddsObservedAt: `${date}T09:30:00Z`, oddsReceivedAt: `${date}T09:31:00Z` };
  fixtureMatch.externalSignals = { prematchV3: { version: SOURCE_VERSION,
    teamObservations: [...teamRows('home', fixtureMatch, depleted), ...teamRows('away', fixtureMatch, depleted)], asianHandicapObservations: [] } };
  const fixtureOptions = { asOf: `${date}T10:00:00Z`, baseline: trainingBaseline };
  const assessment = buildPrematchV3Assessment(fixtureMatch, fixtureOptions);
  const frozen = freezePrematchV3Record(assessment, { match: fixtureMatch, options: fixtureOptions });
  assert.ok(frozen, 'complete pre-match base features can freeze before parameters exist');
  return joinPrematchV3ResearchResult(frozen, syntheticResult(fixtureMatch, depleted));
}));
const learned = learnPrematchV3Candidate({ records: learningRecords, asOf: '2026-09-15T10:00:00Z',
  featureSchema: FEATURE_SCHEMA, featureSchemaHash: FEATURE_SCHEMA_HASH,
  featureNames: ['home.fatigue.restDays', 'home.roster.confirmed.attackReplacementGapPer90',
    'home.injuries.knownUnavailableAttackGapPer90', 'away.fatigue.restDays'],
  split: { trainDays: learningDays.slice(0, 3), calibrationDays: learningDays.slice(3, 5), testDays: learningDays.slice(5) } });
assert.equal(learned.status, 'shadow-candidate', JSON.stringify(learned.reasons));
const parameters = learned.artifact;
const options = { asOf, baseline, parameters };
const build = (m = match, o = options) => buildPrematchV3Assessment(m, o);
const close = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

module.exports = { match, options, asOf, baseline, parameters, learningRecords, syntheticResult, clone, seal, reseal, close, build, learned, learningDays, trainingBaseline, syntheticHistory, teamRows, asianQuotes, source, metric };
