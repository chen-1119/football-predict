'use strict';
const { deriveMarketFeature } = require('../../scripts/marketFeatureLogic.cjs');
const { SOURCE } = require('./policy.cjs');
const HISTORY_LIMIT = 5000;

/** Called on the same transaction/client as observations. Never touches serving projections. */
async function refreshMarketFeature(client, market, changed) {
  const identity = [SOURCE, market.sourceMatchId, market.pool, market.bookmaker];
  if (!changed) {
    const updated = await client.query(`UPDATE football.market_feature_latest
      SET last_observed_at=$5, computed_at=$5,
        payload=jsonb_set(jsonb_set(payload,'{lastObservedAt}',to_jsonb($5::text)),'{computedAt}',to_jsonb($5::text))
      WHERE source=$1 AND source_match_id=$2 AND pool=$3 AND bookmaker=$4
        AND payload->>'latestContentHash'=$6 AND last_observed_at <= $5::timestamptz`,
    [...identity, market.observedAt, market.contentHash]);
    if (updated.rowCount) return;
  }
  const rows = await client.query(`SELECT payload, first_seen_at, last_seen_at
    FROM football.market_observations
    WHERE source=$1 AND source_match_id=$2 AND pool=$3 AND bookmaker=$4
    ORDER BY first_seen_at DESC, observation_id DESC LIMIT $5`, [...identity, HISTORY_LIMIT + 1]);
  const feature = deriveMarketFeature(rows.rows.slice(0, HISTORY_LIMIT), market.observedAt);
  if (!feature) return;
  feature.payload.historyTruncated = rows.rows.length > HISTORY_LIMIT;
  feature.payload.historyRowLimit = HISTORY_LIMIT;
  feature.payload.latestContentHash = market.contentHash;
  const jsonNames = ['opening_odds','latest_odds','minimum_odds','maximum_odds','absolute_delta','percent_delta',
    'maximum_step','opening_implied','latest_implied'];
  const jsonValues = ['openingOdds','latestOdds','minimumOdds','maximumOdds','absoluteDelta','percentDelta',
    'maximumStep','openingImplied','latestImplied'].map(key => JSON.stringify(feature[key]));
  const columns = ['source','source_match_id','pool','bookmaker','kickoff_time','computed_at','first_observed_at','last_observed_at','sample_size',
    ...jsonNames,'strongest_shortening','reversal_flags','movement_score','payload'];
  const values = [...identity, market.kickoffTime, feature.computedAt, feature.firstObservedAt, feature.lastObservedAt,
    feature.sampleSize, ...jsonValues, feature.strongestShortening, JSON.stringify(feature.reversalFlags), feature.movementScore, JSON.stringify(feature.payload)];
  // Identifiers above are closed constants, not source-controlled values.
  await client.query(`INSERT INTO football.market_feature_latest (${columns.join(',')})
    VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})
    ON CONFLICT (source,source_match_id,pool,bookmaker) DO UPDATE SET
      ${columns.slice(4).map(column => `${column}=EXCLUDED.${column}`).join(',')}`, values);
}
module.exports = { refreshMarketFeature, HISTORY_LIMIT };
