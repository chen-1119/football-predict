"use strict";

// Each lateral subquery has the original event identities, cutoff, ordering
// and limit. One round trip lets PostgreSQL finish all bounded reads while the
// independent complete public-file verification runs on the caller's CPU.
async function queryReadinessSnapshotBatch(client, requests, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid readiness snapshot limit");
  if (!requests.length) return new Map();
  const result = await client.query(`SELECT q.ordinal,s.payload
    FROM jsonb_to_recordset($2::jsonb) AS q(ordinal integer,identities text[],upper_bound timestamptz)
    CROSS JOIN LATERAL (
      SELECT id,captured_at,payload::text AS payload FROM football.prediction_snapshots
      WHERE captured_at >= $1 AND captured_at <= q.upper_bound
        AND (source_match_id=ANY(q.identities) OR match_id=ANY(q.identities))
      ORDER BY captured_at DESC,id DESC LIMIT $3
    ) AS s ORDER BY q.ordinal,s.captured_at DESC,s.id DESC`,
  [requests[0].frozenAt, JSON.stringify(requests.map(row => ({ ordinal: row.ordinal, identities: row.ids, upper_bound: row.upperBound }))), limit]);
  const grouped = new Map(requests.map(row => [row.ordinal, []]));
  for (const row of result.rows) {
    const group = grouped.get(row.ordinal);
    if (!group || group.length >= limit || typeof row.payload !== "string") throw new Error("invalid readiness snapshot batch response");
    group.push({ payload: row.payload });
  }
  return grouped;
}

async function overlapReadinessInputs(readSnapshots, readPublicObservations) {
  // Attach handlers to both operations immediately. Even a rejection must
  // drain both the native query and the owned full hash reader before the
  // calling capture can release its PostgreSQL transaction and generation lease.
  const settled = await Promise.allSettled([
    Promise.resolve().then(readSnapshots),
    Promise.resolve().then(readPublicObservations),
  ]);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return { snapshots: settled[0].value, publicRows: settled[1].value };
}

module.exports = { queryReadinessSnapshotBatch, overlapReadinessInputs };
