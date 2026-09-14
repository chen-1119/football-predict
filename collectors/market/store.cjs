'use strict';
const { randomUUID } = require('node:crypto');
const { SOURCE, instant, failure } = require('./policy.cjs');
const { refreshMarketFeature } = require('./features.cjs');
const LOCK_NAME = 'football-market-collector:500.com:jczq';
async function startRun(client, runId, startedAt) {
  await client.query(`INSERT INTO football.market_collector_runs (run_id,source,started_at,status)
    VALUES ($1,$2,$3,'running')`, [runId, SOURCE, startedAt]);
}
async function previousRun(client) {
  return (await client.query(`SELECT finished_at, next_poll_seconds, status, payload
    FROM football.market_collector_runs WHERE source=$1 AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, run_id DESC LIMIT 1`, [SOURCE])).rows[0] || null;
}
function remainingDelay(previous, nowMs) {
  const explicit = instant(previous?.payload?.nextAttemptAt);
  const finished = instant(previous?.finished_at);
  const legacy = finished === null ? null : finished + Number(previous?.next_poll_seconds || 0) * 1000;
  return Math.max(0, Math.ceil(((explicit ?? legacy ?? nowMs) - nowMs) / 1000));
}
async function persistRun(client, input, refresh = refreshMarketFeature) {
  const { runId, markets = [] } = input;
  await client.query('BEGIN');
  try {
    const run = (await client.query(`SELECT status,source_sha256,rows_changed,rows_unchanged
      FROM football.market_collector_runs WHERE run_id=$1 FOR UPDATE`, [runId])).rows[0];
    if (!run) throw failure('RUN_NOT_STARTED', 'Observation requires an audited run');
    if (run.status !== 'running') {
      if (run.status !== input.status || (run.source_sha256 || null) !== (input.sourceSha256 || null)) throw failure('RUN_REPLAY_CONFLICT', 'Conflicting completed run replay');
      await client.query('COMMIT');
      return { changed: run.rows_changed, unchanged: run.rows_unchanged, replayed: true };
    }
    let changed = 0, unchanged = 0, ignored = 0;
    for (const market of markets) {
      const identity = [SOURCE, market.sourceMatchId, market.pool, market.bookmaker];
      const latest = (await client.query(`SELECT observation_id,content_hash,updated_at FROM football.market_latest
        WHERE source=$1 AND source_match_id=$2 AND pool=$3 AND bookmaker=$4 FOR UPDATE`, identity)).rows[0];
      const currentMs = instant(market.observedAt), previousMs = instant(latest?.updated_at);
      if (previousMs !== null && currentMs < previousMs) { ignored++; continue; }
      if (previousMs !== null && currentMs === previousMs) {
        if (latest.content_hash !== market.contentHash) throw failure('QUOTE_TIME_CONFLICT', 'Conflicting quote at the same observation instant');
        ignored++; continue;
      }
      const isChanged = !latest || latest.content_hash !== market.contentHash;
      if (!isChanged) {
        await client.query(`UPDATE football.market_observations SET last_seen_at=$2,seen_count=seen_count+1
          WHERE observation_id=$1`, [latest.observation_id, market.observedAt]);
        await client.query(`UPDATE football.market_latest SET updated_at=$5
          WHERE source=$1 AND source_match_id=$2 AND pool=$3 AND bookmaker=$4`, [...identity, market.observedAt]);
        unchanged++;
      } else {
        const observationId = randomUUID();
        await client.query(`INSERT INTO football.market_observations
          (observation_id,run_id,source,source_match_id,fixture_id,match_no,pool,bookmaker,handicap_line,kickoff_time,
           first_seen_at,last_seen_at,seen_count,content_hash,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,1,$12,$13::jsonb)`,
        [observationId, runId, SOURCE, market.sourceMatchId, market.fixtureId, market.matchNo, market.pool,
          market.bookmaker, market.handicapLine, market.kickoffTime, market.observedAt, market.contentHash, JSON.stringify(market.payload)]);
        await client.query(`INSERT INTO football.market_latest(source,source_match_id,pool,bookmaker,observation_id,content_hash,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source,source_match_id,pool,bookmaker)
          DO UPDATE SET observation_id=EXCLUDED.observation_id,content_hash=EXCLUDED.content_hash,updated_at=EXCLUDED.updated_at`,
        [...identity, observationId, market.contentHash, market.observedAt]);
        changed++;
      }
      await refresh(client, market, isChanged);
    }
    await client.query(`UPDATE football.market_collector_runs SET finished_at=$2,status=$3,rows_seen=$4,rows_changed=$5,
      rows_unchanged=$6,source_sha256=$7,source_bytes=$8,next_poll_seconds=$9,error_code=$10,error_message=$11,payload=$12::jsonb
      WHERE run_id=$1 AND status='running'`,
    [runId, input.finishedAt, input.status, markets.length, changed, unchanged, input.sourceSha256 || null,
      input.sourceBytes ?? null, input.nextPollSeconds, input.error?.code || null,
      input.error ? 'Collection failed; inspect error_code and HTTP status' : null,
      JSON.stringify({ ...input.payload, ignoredOutOfOrderOrDuplicate: ignored, sourceStatusCode: input.httpStatus ?? input.error?.statusCode ?? null })]);
    await client.query('COMMIT');
    return { changed, unchanged, ignored, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
module.exports = { LOCK_NAME, startRun, previousRun, remainingDelay, persistRun };
