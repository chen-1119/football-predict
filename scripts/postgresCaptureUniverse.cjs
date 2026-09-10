"use strict";
// Equivalent bounded heartbeat projection, expressed as native PostgreSQL JSON
// operators. Full model/evidence payloads are not loaded just to find deadlines.
const fields = ["id", "matchId", "sourceMatchId", "kickoffTime", "matchDate", "kickoff", "kickoffAt", "buyEndTime", "cutoffTime",
  "effectiveStatus", "scoreHome", "scoreAway", "score90Home", "score90Away", "ft90Home", "ft90Away", "resultObservedAt",
  "resultMeta", "resultAudit", "resultCrossCheck", "resultProvenance", "actualKickoffAt", "actualKickoffTime", "actualKickoffSource",
  "firstInPlayObservedAt", "inPlayObservationSource", "businessDate", "competitionName", "leagueId", "leagueName", "leagueShortName",
  "homeTeamId", "homeTeamName", "awayTeamId", "awayTeamName"];
async function postgresCaptureUniverse(session, historyIdentityValues) {
  const result = await session.client.query(`SELECT dataset,match_id,source_match_id,kickoff_time,status,
    jsonb_build_object(${fields.map(key => `'${key}',payload->'${key}'`).join(",")},
      'predictionMeta',jsonb_build_object('cutoffTime',payload#>'{predictionMeta,cutoffTime}')) AS projection
    FROM football.match_snapshots WHERE dataset='current' OR (dataset='history' AND
      ($1::text[] IS NULL OR source_match_id=ANY($1::text[]) OR match_id=ANY($1::text[])))
    ORDER BY CASE dataset WHEN 'current' THEN 0 ELSE 1 END,kickoff_time ASC,match_id ASC`, [historyIdentityValues]);
  const rows = result.rows.map(row => {
    const p = row.projection;
    const projected = { ...p, id: p.id || row.match_id, matchId: p.matchId || row.match_id,
      sourceMatchId: p.sourceMatchId || row.source_match_id, kickoffTime: p.kickoffTime || row.kickoff_time?.toISOString(),
      status: row.status, predictionMeta: p.predictionMeta?.cutoffTime ? p.predictionMeta : null };
    return { dataset: row.dataset, match: Object.fromEntries(Object.entries(projected).filter(([, v]) => v !== null && v !== undefined && v !== "")) };
  });
  return { ok: true, currentMatches: rows.filter(row => row.dataset === "current").map(row => row.match),
    historyMatches: rows.filter(row => row.dataset === "history").map(row => row.match), source: "postgres", reason: null };
}
module.exports = { postgresCaptureUniverse };
