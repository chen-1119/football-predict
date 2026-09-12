'use strict';
const { selectFixtures } = require('./scope.cjs');
const { strictInstant } = require('../../src/services/strictInstant.cjs');
const VERSION = 'api-football-prematch-reference-v1';
const instant = x => strictInstant(x);
const empty = () => ({ status: 'missing', observedAt: null, lastAttemptAt: null, previousValue: false, data: null });
function displayData(data, kind) {
  const text = v => typeof v === 'string' ? v.slice(0, 300) : '';
  const player = p => ({ side: p.side, name: text(p.name), reason: text(p.reason), position: text(p.position) });
  const validPlayer = p => p && ['home', 'away'].includes(p.side) && typeof p.name === 'string' && Boolean(p.name.trim());
  if (kind === 'injuries') return Array.isArray(data?.players) && data.players.length > 0 && data.players.length <= 100
    && data.players.every(validPlayer) ? { players: data.players.map(player) } : null;
  if (!Array.isArray(data?.teams) || data.teams.length !== 2 || new Set(data.teams.map(t => t.side)).size !== 2) return null;
  if (data.teams.some(t => !['home', 'away'].includes(t.side) || !Array.isArray(t.starters) || t.starters.length !== 11
      || !Array.isArray(t.substitutes) || t.substitutes.length > 30
      || [...t.starters, ...t.substitutes].some(p => !validPlayer(p) || p.side !== t.side))) return null;
  return { teams: data.teams.map(t => ({ side: t.side, formation: text(t.formation), starters: t.starters.map(player), substitutes: t.substitutes.map(player) })) };
}

function section(piece, kind, mapping, fixture, now) {
  const result = empty(), receipt = instant(piece?.observedAt);
  if (!receipt || Date.parse(receipt) > now || Date.parse(receipt) >= Date.parse(fixture.kickoffUtc)
      || now - Date.parse(receipt) > (kind === 'injuries' ? 6 : 2) * 3600000
      || piece.source !== 'api-football' || String(piece.providerFixtureId) !== String(mapping.fixtureId)
      || piece.provenance?.fetchedAt !== receipt || piece.clockEvidence?.version !== 'api-football-clock-evidence-v2'
      || ['invalid', 'after-receipt'].includes(piece.clockEvidence.sourceTimeStatus)) return result;
  // Collection receipts remain displayable after the recommendation cutoff.
  // They never become model input or permission to amend a frozen prediction.
  if (kind === 'injuries') {
    const players = piece.players;
    if (!Array.isArray(players) || !players.length || players.length > 100 || players.some(p =>
      !['home', 'away'].includes(p.side) || typeof p.name !== 'string' || !p.name.trim()
      || String(p.fixtureId) !== String(mapping.fixtureId)
      || String(p.teamId) !== String(mapping[p.side + 'TeamId']))) return result;
    result.data = { players: players.map(p => ({ side: p.side, name: p.name, reason: p.reason || p.type || '', position: p.position || null })) };
  } else {
    const seen = new Set(), teams = [];
    for (const side of ['home', 'away']) {
      const team = piece[side];
      if (String(team?.teamId) !== String(mapping[side + 'TeamId']) || !Array.isArray(team?.startXI)
          || team.startXI.length !== 11 || !Array.isArray(team.substitutes) || team.substitutes.length > 30) return result;
      for (const p of [...team.startXI, ...team.substitutes]) {
        if (!/^[1-9]\d*$/.test(String(p.playerId)) || seen.has(String(p.playerId)) || typeof p.name !== 'string' || !p.name.trim()) return result;
        seen.add(String(p.playerId));
      }
      const player = p => ({ side, name: p.name, position: p.position || null });
      teams.push({ side, formation: team.formation || '', starters: team.startXI.map(player), substitutes: team.substitutes.map(player) });
    }
    result.data = { teams };
  }
  return { ...result, status: 'available', observedAt: receipt, lastAttemptAt: receipt };
}

function buildReferenceExport(matches, cache, verifiedMappings, now = Date.now()) {
  const items = [];
  for (const fixture of selectFixtures(matches, now).selected) {
    if (!verifiedMappings.has(fixture.siteMatchId)) continue;
    const mapping = cache.fixtureMap?.[fixture.siteMatchId], state = cache.fixtureSignals?.[mapping?.fixtureId];
    if (!mapping?.fixtureId || !state) continue;
    const sections = { injuries: section(state.injuries, 'injuries', mapping, fixture, now),
      lineup: section(state.lineups, 'lineup', mapping, fixture, now) };
    if (!Object.values(sections).some(s => s.data)) continue;
    items.push({ fixture, sections });
  }
  return { version: VERSION, provider: 'api-football', predictionEligible: false, generatedAt: new Date(now).toISOString(), items };
}

function selectReference(doc, currentMatch, now = Date.now()) {
  // A match starting does not erase a pre-kickoff receipt from the reference
  // view. Collection itself still uses selectFixtures and stops at kickoff.
  const rawKickoff = instant(currentMatch?.kickoffTime), rawEvent = instant(currentMatch?.eventVersion || currentMatch?.kickoffTime);
  const kickoff = rawKickoff ? new Date(rawKickoff).toISOString() : null;
  const event = rawEvent ? new Date(rawEvent).toISOString() : null;
  const id = currentMatch?.id, sourceId = String(currentMatch?.sourceMatchId || '');
  const fixture = /^sporttery_[1-9]\d*$/.test(id || '') && id === 'sporttery_' + sourceId && kickoff && event === kickoff
    && ['SCHEDULED', 'LIVE', 'FINISHED', 'PENDING_RESULT'].includes(currentMatch?.status)
    && typeof currentMatch.homeTeamName === 'string' && currentMatch.homeTeamName.trim()
    && typeof currentMatch.awayTeamName === 'string' && currentMatch.awayTeamName.trim()
    && currentMatch.homeTeamName !== currentMatch.awayTeamName
    ? { siteMatchId: id, eventVersion: event, kickoffUtc: kickoff, homeName: currentMatch.homeTeamName, awayName: currentMatch.awayTeamName } : null;
  if (!fixture || doc?.version !== VERSION || doc.predictionEligible !== false || doc.provider !== 'api-football'
      || !instant(doc.generatedAt) || Date.parse(doc.generatedAt) > now || now - Date.parse(doc.generatedAt) > 6 * 3600000
      || !Array.isArray(doc.items) || doc.items.length > 200) return null;
  const found = doc.items.filter(x => x.fixture?.siteMatchId === fixture.siteMatchId);
  if (found.length !== 1 || !['siteMatchId', 'eventVersion', 'kickoffUtc', 'homeName', 'awayName'].every(k => found[0].fixture[k] === fixture[k])) return null;
  const sections = {};
  for (const kind of ['injuries', 'lineup']) {
    const s = found[0].sections?.[kind], receipt = instant(s?.observedAt);
    const data = displayData(s?.data, kind);
    sections[kind] = data && s?.status === 'available' && receipt && Date.parse(receipt) <= Date.parse(doc.generatedAt)
      && Date.parse(receipt) < Date.parse(fixture.kickoffUtc) && now - Date.parse(receipt) <= (kind === 'injuries' ? 6 : 2) * 3600000
      ? { status: 'available', observedAt: receipt, lastAttemptAt: receipt, previousValue: false, data } : empty();
  }
  if (!Object.values(sections).some(s => s.data)) return null;
  return { matchId: fixture.siteMatchId, eventVersion: fixture.eventVersion, provider: 'api-football',
    status: 'ok', updatedAt: doc.generatedAt, predictionEligible: false, sections };
}
function mergeReferenceExports(current, previous, matches, now = Date.now()) {
  const items = new Map(current.items.map(item => [item.fixture.siteMatchId, item]));
  for (const match of matches) {
    if (items.has(match.id)) continue;
    const selected = selectReference(previous, match, now);
    if (!selected) continue;
    const old = previous.items.find(item => item.fixture.siteMatchId === match.id);
    items.set(match.id, { fixture: old.fixture, sections: selected.sections });
  }
  return { ...current, items: [...items.values()].slice(0, 200) };
}
module.exports = { VERSION, buildReferenceExport, selectReference, mergeReferenceExports };
