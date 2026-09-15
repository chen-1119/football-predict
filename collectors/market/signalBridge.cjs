'use strict';
const { SOURCE, instant, failure } = require('./policy.cjs');

// Adapt the acquired reference quotes to the existing worker's enrichment input.
// The worker remains the only file publisher; the collector writes PostgreSQL only.
function projectSignalRows(observations) {
  const groups = new Map();
  const sorted = [...observations].sort((a, b) => instant(b.updated_at) - instant(a.updated_at));
  for (const row of sorted) {
    const p = row.payload;
    if (p?.source !== SOURCE || !Array.isArray(p.matchKeys) || !p.matchKeys.length || instant(row.updated_at) === null) continue;
    if (!['had', 'hhad'].includes(p.pool)) continue;
    const event = JSON.stringify([p.kickoffTime, p.homeTeamName, p.awayTeamName]);
    let group = groups.get(p.sourceMatchId);
    if (group && group.event !== event) continue; // never borrow an older event's other pool
    if (!group) {
      group = { event, keys: p.matchKeys, signal: { source: SOURCE, sourceMatchId: p.sourceMatchId, fixtureId: p.fixtureId,
        matchNo: p.matchNo, leagueName: p.leagueName, homeTeamName: p.homeTeamName, awayTeamName: p.awayTeamName,
        kickoffTime: p.kickoffTime, buyEndTime: p.buyEndTime || undefined,
        updatedAt: new Date(instant(row.updated_at)).toISOString(), bookmakerOdds: {} } };
      groups.set(p.sourceMatchId, group);
    }
    if (group.signal.bookmakerOdds[p.pool]) continue;
    const quote = { odds1: p.odds1, oddsX: p.oddsX, odds2: p.odds2, source: SOURCE,
      updatedAt: new Date(instant(row.updated_at)).toISOString(),
      ...(p.pool === 'hhad' ? { handicapLine: String(p.handicapLine) } : {}) };
    group.signal.bookmakerOdds[p.pool] = quote;
    if (p.pool === 'hhad') group.signal.handicapLine = quote.handicapLine;
  }
  return [...groups.values()].map(({ keys, signal }) => {
    const pool = signal.bookmakerOdds.had ? 'had' : 'hhad';
    return { keys, signal: { ...signal, externalOdds: { ...signal.bookmakerOdds[pool], poolCode: pool.toUpperCase() } } };
  });
}
async function readMarketSignalRows(pool) {
  const latest = await pool.query(`SELECT observation.payload, latest.updated_at
    FROM football.market_latest latest JOIN football.market_observations observation
      ON observation.observation_id=latest.observation_id WHERE latest.source=$1`, [SOURCE]);
  const rows = projectSignalRows(latest.rows);
  if (!rows.length) {
    const run = (await pool.query(`SELECT status,payload FROM football.market_collector_runs
      WHERE source=$1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`, [SOURCE])).rows[0];
    if (run?.status !== 'completed' || run.payload?.sourceState !== 'no-events') {
      throw failure('MARKET_BRIDGE_EMPTY', 'No acquired market snapshot; preserving existing enrichment data');
    }
  }
  return rows;
}
module.exports = { projectSignalRows, readMarketSignalRows };
