'use strict';

const evidence = require('../../scripts/teamEvidenceSources.cjs');
const kleague = require('../../scripts/syncKLeagueOfficialStandings.cjs');
const {derivedTeamId} = require('../../scripts/storedResultTeamIdentity.cjs');
const {eventFromMatch} = require('./prematchV3Assessment.cjs');
const {epochNanoseconds: clock} = require('./prematchV3Clock.cjs');

const VERSION = 'stored-team-evidence-prematch-bridge-v1';
const missing = ['independent-second-source', 'confirmed-lineups', 'injuries-and-suspensions', 'xg', 'actual-match-end-and-fatigue', 'weather'];
const identity = event => [event.sourceMatchId, event.eventVersion, event.homeTeamId, event.awayTeamId, event.cutoffAt];

function eligibleEvent(match, asOf) {
  const event = eventFromMatch(match), at = clock(asOf), cutoff = clock(event.cutoffAt), kickoff = clock(event.eventVersion);
  return at !== null && cutoff !== null && kickoff !== null && at < cutoff && cutoff <= kickoff
    && clock(event.kickoffTime) === kickoff && event.status === 'SCHEDULED' && event.isOnSale !== false
    && !['CLOSED', 'SUSPENDED', 'STOPPED'].includes(String(event.saleStatus || '').toUpperCase())
    && match.resultDisposition !== 'VOID' && event.sourceMatchId && event.homeTeamId !== event.awayTeamId
    && event.homeTeamId === derivedTeamId(match.homeTeamName) && event.awayTeamId === derivedTeamId(match.awayTeamName)
    ? {...event, businessDate: match.businessDate, homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName, leagueName: match.leagueName || match.leagueAllName} : null;
}

function buildStoredTeamResearch(match, packets, asOf) {
  const event = eligibleEvent(match, asOf);
  const blocked = reason => ({version: VERSION, status: 'blocked', reason, formalEligible: false, teamObservations: []});
  if (!event) return blocked('event-or-sale-identity-ineligible');
  try {
    const adopted = evidence.adopt(packets, event, asOf);
    const observations = [];
    const sourceRows = packets.filter(p => p.plan.kind === 'schedule').flatMap(packet =>
      JSON.parse(packet.response.raw).data.scheduleList.map(row => ({row, packet})));
    const historical = sourceRows.filter(({row}) => row.endYn === 'Y' && row.gameStatus === 'FE'
      && [row.homeGoal, row.awayGoal].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 30)
      && Date.parse(kleague.officialKickoffInstant(row)) + 100 * 60000 < Date.parse(asOf));
    const mapped = [kleague.resolveTeamId(event.homeTeamName), kleague.resolveTeamId(event.awayTeamName)];
    for (const [index, side] of ['home', 'away'].entries()) {
      const rows = historical.filter(({row}) => row.homeTeam === mapped[index] || row.awayTeam === mapped[index])
        .sort((a, b) => Date.parse(kleague.officialKickoffInstant(b.row)) - Date.parse(kleague.officialKickoffInstant(a.row)))
        .slice(0, 5);
      if (!rows.length) continue;
      const receivedAt = rows.map(({packet}) => packet.createdAt).sort((a, b) => clock(a) < clock(b) ? -1 : clock(a) > clock(b) ? 1 : 0).at(-1);
      const facts = rows.map(({row, packet}) => ({
        sourceMatchId: `kleague:${row.year}:${row.gameId}`, eventVersion: kleague.officialKickoffInstant(row),
        teamId: event[side + 'TeamId'], status: 'FINISHED', providerObservedAt: packet.createdAt,
        receivedAt: packet.createdAt, clockBasis: 'collector-response-body-completed', sourcePublishedAt: null,
        source: {provider: 'kleague:official-schedule', endpoint: packet.plan.url,
          receiptHash: packet.contentHash, rawPayloadHash: packet.response.rawSha256},
        goalsFor: row.homeTeam === mapped[index] ? row.homeGoal : row.awayGoal,
        goalsAgainst: row.homeTeam === mapped[index] ? row.awayGoal : row.homeGoal,
      }));
      observations.push({family: 'history', side, sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
        teamId: event[side + 'TeamId'], providerObservedAt: receivedAt, receivedAt,
        clockBasis: 'collector-response-body-completed', sourcePublishedAt: null,
        source: {provider: 'kleague:stored-official-schedule', endpoint: 'football.private_model_artifacts',
          receiptHash: adopted.contentHash, rawPayloadHash: evidence.hash(packets.map(p => p.response.rawSha256))},
        data: {rows: facts}});
    }
    const historyCoverage = Object.fromEntries(['home', 'away'].map(side => {
      const count = observations.find(o => o.side === side)?.data.rows.length || 0;
      return [side, {count, target: 5, fiveObservedInStoredWindow: count === 5, completeRecentScheduleVerified: false}];
    }));
    const h2h = historical.filter(({row}) => mapped.includes(row.homeTeam) && mapped.includes(row.awayTeam))
      .map(({row, packet}) => ({providerEventId: row.gameId, kickoffAt: kleague.officialKickoffInstant(row),
        homeProviderTeamId: row.homeTeam, awayProviderTeamId: row.awayTeam, score: [row.homeGoal, row.awayGoal],
        observedAt: packet.createdAt, evidenceHash: packet.contentHash}));
    const receipt = evidence.seal({version: VERSION, asOf, eventIdentity: identity(event),
      evidenceHashes: adopted.evidenceHashes, adoptionHash: adopted.contentHash,
      verification: 'official-single-source', secondIndependentSourceVerified: false,
      saleVerification: {isOnSale: event.isOnSale, cutoffAt: event.cutoffAt,
        authority: 'unverified-research-bound;not-sale-clearance', publicationAllowed: false},
      historyCoverage, standings: adopted.teams.map(({teamId, rank, points, played}) => ({teamId, rank, points, played})),
      headToHead: {rows: h2h, completeHistoryVerified: false}, missing: [...missing,
        ...['home', 'away'].filter(side => historyCoverage[side].count < 5).map(side => `${side}-history-less-than-five`)],
      teamHistory: observations, numericModelInputAdmitted: false,
      formalEligible: false, probabilityFactorsApplied: false, actualMatchEndTimesKnown: false});
    return {version: VERSION, status: observations.length ? 'research-facts-ready' : 'history-unavailable',
      formalEligible: false, teamObservations: observations, receipt};
  } catch (error) { return blocked(/^TEAM_EVIDENCE_[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'stored-evidence-invalid'); }
}

function researchForMatch(match, loaded, asOf) {
  const event = eligibleEvent(match, asOf);
  if (!event || loaded?.asOf !== asOf || loaded?.storage !== 'postgres' || loaded?.blockers?.length) return null;
  const candidates = (loaded.events || []).filter(item =>
    JSON.stringify(item.eventIdentity) === JSON.stringify(identity(event)));
  if (candidates.length !== 1) return null;
  const research = buildStoredTeamResearch(match, candidates[0].packets, asOf);
  return research.status === 'research-facts-ready' ? research.receipt : null;
}

module.exports = {VERSION, eligibleEvent, buildStoredTeamResearch, researchForMatch};
