'use strict';
const { instant, finiteOdd, handicap, failure } = require('../collectors/market/policy.cjs');
const KEYS = ['odds1', 'oddsX', 'odds2'];
const round = number => Math.round(number * 1e6) / 1e6;
const triplet = (payload, project = key => payload[key]) => Object.fromEntries(KEYS.map(key => [key, project(key)]));
const normalizedImplied = odds => {
  if (KEYS.some(key => finiteOdd(odds?.[key]) === null)) return null;
  const total = KEYS.reduce((sum, key) => sum + 1 / odds[key], 0);
  return triplet(odds, key => round((1 / odds[key]) / total));
};
function normalizeObservations(rows) {
  if (!Array.isArray(rows)) throw failure('INVALID_FEATURE_INPUT', 'Expected observations');
  return rows.map(row => {
    const payload = row?.payload;
    const firstMs = instant(row?.first_seen_at ?? row?.firstSeenAt);
    const lastMs = instant(row?.last_seen_at ?? row?.lastSeenAt);
    const kickoffMs = instant(payload?.kickoffTime);
    const pool = payload?.pool;
    const line = pool === 'hhad' ? handicap(payload?.handicapLine) : null;
    if (!payload || !payload.source || !payload.sourceMatchId || !payload.bookmaker || !['had', 'hhad'].includes(pool)
      || firstMs === null || lastMs === null || lastMs < firstMs || kickoffMs === null
      || (pool === 'hhad' && line === null) || KEYS.some(key => finiteOdd(payload[key]) === null)) {
      throw failure('INVALID_FEATURE_INPUT', 'Invalid observation identity, interval, handicap or price');
    }
    const stream = JSON.stringify([payload.source, payload.sourceMatchId, pool, payload.bookmaker]);
    const event = JSON.stringify([kickoffMs, line]);
    return { payload, firstMs, lastMs, kickoffMs, stream, event, line, odds: triplet(payload, key => Number(payload[key])) };
  }).sort((a, b) => a.firstMs - b.firstMs);
}

/** Descriptive, cutoff-safe observed changes; never a forecast or official opening price. */
function deriveMarketFeature(rows, computedAt = new Date().toISOString()) {
  const asOfMs = instant(computedAt);
  if (asOfMs === null) throw failure('INVALID_AS_OF', 'A timezone-explicit as-of instant is required');
  const normalized = normalizeObservations(rows);
  if (new Set(normalized.map(row => row.stream)).size > 1) throw failure('MIXED_MARKETS', 'Do not mix source/match/pool/bookmaker streams');
  const visible = normalized.filter(row => row.firstMs <= asOfMs);
  if (!visible.length) return null;
  const latest = visible.at(-1);
  // A changed kickoff or handicap starts a new segment. Do not bridge A(-1) -> B(-2) -> C(-1).
  let firstIndex = visible.length - 1;
  while (firstIndex > 0 && visible[firstIndex - 1].event === latest.event) firstIndex--;
  const segment = visible.slice(firstIndex);
  for (let i = 1; i < segment.length; i++) {
    if (segment[i].firstMs === segment[i - 1].firstMs
      && JSON.stringify(segment[i].odds) !== JSON.stringify(segment[i - 1].odds)) {
      throw failure('CONFLICTING_FEATURE_TIME', 'Different quotes cannot share the same observation instant');
    }
  }
  const first = segment[0], minimumOdds = triplet(first.odds), maximumOdds = triplet(first.odds);
  const maximumStep = triplet(first.odds, () => 0), reversals = triplet(first.odds, () => 0);
  const previousSigns = triplet(first.odds, () => 0);
  let priceChangeCount = 0;
  for (let i = 0; i < segment.length; i++) {
    let changed = false;
    for (const key of KEYS) {
      const value = segment[i].odds[key];
      minimumOdds[key] = Math.min(minimumOdds[key], value);
      maximumOdds[key] = Math.max(maximumOdds[key], value);
      if (!i) continue;
      const delta = round(value - segment[i - 1].odds[key]), direction = Math.sign(delta);
      maximumStep[key] = Math.max(maximumStep[key], Math.abs(delta));
      if (direction) {
        changed = true;
        if (previousSigns[key] && direction !== previousSigns[key]) reversals[key]++;
        previousSigns[key] = direction;
      }
    }
    if (changed) priceChangeCount++;
  }
  const absoluteDelta = triplet(first.odds, key => round(latest.odds[key] - first.odds[key]));
  const percentDelta = triplet(first.odds, key => round(latest.odds[key] / first.odds[key] - 1));
  const mostNegative = Math.min(0, ...Object.values(percentDelta));
  const shortened = KEYS.filter(key => mostNegative < 0 && percentDelta[key] === mostNegative);
  const strongestShortening = shortened.length === 1 ? { odds1: '1', oddsX: 'X', odds2: '2' }[shortened[0]] : null;
  // A compressed state's future last_seen_at cannot prove a receipt at the historical as-of.
  const lastKnownMs = latest.lastMs <= asOfMs ? latest.lastMs : latest.firstMs;
  const result = {
    sampleSize: segment.length, firstObservedAt: new Date(first.firstMs).toISOString(), lastObservedAt: new Date(lastKnownMs).toISOString(),
    openingOdds: first.odds, latestOdds: latest.odds, minimumOdds, maximumOdds, absoluteDelta, percentDelta,
    maximumStep, openingImplied: normalizedImplied(first.odds), latestImplied: normalizedImplied(latest.odds),
    strongestShortening, reversalFlags: triplet(first.odds, key => reversals[key] > 0),
    movementScore: round(Object.values(percentDelta).reduce((sum, value) => sum + Math.abs(value), 0)),
    computedAt: new Date(asOfMs).toISOString(),
  };
  return { ...result, payload: { ...result, version: 'market-feature-v2', predictionEligible: false,
    baselineKind: 'first-observed-in-contiguous-market', openingIsOfficial: false,
    impliedProbabilityKind: 'normalized-inverse-odds-not-model-probability',
    percentDeltaUnit: 'fraction', receiptGranularity: 'compressed-state-interval', continuousObservation: false,
    priceChangeCount, reversals, identity: { source: latest.payload.source, sourceMatchId: latest.payload.sourceMatchId,
      pool: latest.payload.pool, bookmaker: latest.payload.bookmaker, kickoffTime: new Date(latest.kickoffMs).toISOString(), handicapLine: latest.line } } };
}
module.exports = { deriveMarketFeature, normalizeObservations, normalizedImplied };
