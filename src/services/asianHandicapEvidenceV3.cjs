'use strict';

const { createHash } = require('node:crypto');
const { epochNanoseconds } = require('./prematchV3Clock.cjs');

const VERSION = 'asian-handicap-timeline-v3';
const MARKET = 'AH';
const MASS_TOLERANCE = 1e-10;
const HASH = /^[a-f0-9]{64}$/;
const OUTCOMES = ['fullWin', 'halfWin', 'push', 'halfLoss', 'fullLoss'];
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const clock = epochNanoseconds;
const earlier = (a, b) => a < b ? a : b;
const displayMilliseconds = nanoseconds => Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1000000;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const failure = reason => ({ available: false, market: MARKET, formalEligible: false, reason });

// Prices are converted only from an explicitly declared format. In particular,
// a decimal-looking water price is not evidence of its odds convention.
function finitePrice(value) {
  if (typeof value !== 'number' && (typeof value !== 'string'
    || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function decimalPrice(raw, format) {
  const n = finitePrice(raw);
  if (n === null) return null;
  let decimal = null;
  if (format === 'decimal' && n > 1) decimal = n;
  if (format === 'hong-kong' && n > 0) decimal = 1 + n;
  if (format === 'malay' && n !== 0 && Math.abs(n) <= 1) decimal = n > 0 ? 1 + n : 1 + 1 / Math.abs(n);
  if (format === 'indonesian' && Math.abs(n) >= 1) decimal = n > 0 ? 1 + n : 1 + 1 / Math.abs(n);
  return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
}
function quarterLine(value) {
  // Requiring a numeric signed home adjustment prevents null/blank coercion.
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100
    || !Number.isSafeInteger(value * 4)) return null;
  return Object.is(value, -0) ? 0 : value;
}
function normalizedEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const sourceMatchId = text(event.sourceMatchId), homeTeamId = text(event.homeTeamId), awayTeamId = text(event.awayTeamId);
  const versionNs = clock(event.eventVersion), kickoffNs = clock(event.kickoffTime);
  if (!sourceMatchId || !homeTeamId || !awayTeamId || homeTeamId === awayTeamId || versionNs === null || kickoffNs === null
    || versionNs !== kickoffNs || (event.market != null && event.market !== MARKET)) return null;
  const suppliedCutoffs = ['cutoffAt', 'cutoffTime'].filter(key => Object.hasOwn(event, key));
  if (!suppliedCutoffs.length || suppliedCutoffs.some(key => clock(event[key]) === null)) return null;
  if (suppliedCutoffs.length === 2 && clock(event.cutoffAt) !== clock(event.cutoffTime)) return null;
  return { market: MARKET, sourceMatchId, eventVersion: event.eventVersion, homeTeamId, awayTeamId,
    kickoffTime: event.kickoffTime, cutoffAt: event[suppliedCutoffs[0]] };
}
function normalizeObservation(row, event, asOfNs, deadlineNs) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { reason: 'observation-invalid' };
  if (row.market !== MARKET || (row.pool != null && row.pool !== MARKET)) return { reason: 'asian-market-required' };
  const source = text(row.source), company = text(row.company);
  if (!source || !company || !HASH.test(row.rawPayloadHash || '')) return { reason: 'source-company-or-raw-hash-invalid' };
  if (text(row.sourceMatchId) !== event.sourceMatchId || clock(row.eventVersion) !== clock(event.eventVersion)
    || text(row.homeTeamId) !== event.homeTeamId || text(row.awayTeamId) !== event.awayTeamId) return { reason: 'event-identity-conflict' };
  const homeLine = quarterLine(row.homeLine);
  if (homeLine === null) return { reason: 'signed-home-quarter-line-required' };
  const receivedNs = clock(row.receivedAt), providerNs = clock(row.providerObservedAt);
  if (receivedNs === null || providerNs === null) return { reason: 'explicit-provider-and-receipt-clock-required' };
  if (providerNs > receivedNs) return { reason: 'provider-clock-after-receipt' };
  if (receivedNs > asOfNs || providerNs > asOfNs) return { reason: 'future-observation' };
  if (receivedNs >= deadlineNs || providerNs >= deadlineNs) return { reason: 'observation-at-or-after-cutoff' };
  const format = row.oddsFormat;
  if (!['decimal', 'hong-kong', 'malay', 'indonesian'].includes(format)) return { reason: 'explicit-odds-format-required' };
  const home = decimalPrice(row.rawPrices?.home, format), away = decimalPrice(row.rawPrices?.away, format);
  if (home === null || away === null) return { reason: 'invalid-two-sided-price-for-format' };
  const inverseTotal = 1 / home + 1 / away;
  return { observation: { market: MARKET, source, company, sourceMatchId: event.sourceMatchId,
    eventVersion: row.eventVersion, homeTeamId: event.homeTeamId, awayTeamId: event.awayTeamId, homeLine,
    oddsFormat: format, rawPrices: { home: row.rawPrices.home, away: row.rawPrices.away },
    decimalOdds: { home, away }, providerObservedAt: row.providerObservedAt, receivedAt: row.receivedAt,
    rawPayloadHash: row.rawPayloadHash,
    priceIndicator: { home: (1 / home) / inverseTotal, away: (1 / away) / inverseTotal },
    inversePriceSum: inverseTotal, sourceAuthentication: 'not-established-by-this-contract', formalEligible: false } };
}
function streamFor(source, company, observations) {
  const segments = [], lineTransitions = [];
  let previous = null;
  for (const observation of observations) {
    if (!previous || previous.homeLine !== observation.homeLine) {
      if (previous) lineTransitions.push({ fromHomeLine: previous.homeLine, toHomeLine: observation.homeLine,
        lineDelta: observation.homeLine - previous.homeLine, fromReceivedAt: previous.receivedAt,
        receivedAt: observation.receivedAt, direction: observation.homeLine < previous.homeLine ? 'home-line-decreased' : 'home-line-increased' });
      segments.push({ homeLine: observation.homeLine, firstReceivedAt: observation.receivedAt,
        lastReceivedAt: observation.receivedAt, observations: [], priceChanges: [] });
    }
    const segment = segments.at(-1);
    if (previous && previous.homeLine === observation.homeLine
      && (previous.decimalOdds.home !== observation.decimalOdds.home || previous.decimalOdds.away !== observation.decimalOdds.away)) {
      segment.priceChanges.push({ fromReceivedAt: previous.receivedAt, receivedAt: observation.receivedAt,
        fromDecimalOdds: previous.decimalOdds, toDecimalOdds: observation.decimalOdds,
        decimalPriceDelta: { home: observation.decimalOdds.home - previous.decimalOdds.home, away: observation.decimalOdds.away - previous.decimalOdds.away },
        priceIndicatorDelta: { home: observation.priceIndicator.home - previous.priceIndicator.home,
          away: observation.priceIndicator.away - previous.priceIndicator.away } });
    }
    segment.observations.push(observation);
    segment.lastReceivedAt = observation.receivedAt;
    previous = observation;
  }
  return { source, company, observationCount: observations.length, firstReceivedAt: observations[0].receivedAt,
    baselineKind: 'first-received-observation', openingIsOfficial: false, observations, segments, lineTransitions };
}
function canonicalInput({ event, asOf, observations }) {
  // Keep validation candidates for reproducible auditing, including rejected
  // rows. Only streams/latestQuotes are eligible as-of observations.
  return { event: structuredClone(event), asOf, observations: structuredClone(observations) };
}
function buildAsianHandicapTimeline(input = {}) {
  try {
    const event = normalizedEvent(input.event), asOfNs = clock(input.asOf);
    if (!event) return failure('event-identity-or-deadline-invalid');
    if (asOfNs === null) return failure('explicit-as-of-clock-required');
    if (!Array.isArray(input.observations) || input.observations.length > 20000) return failure('observation-array-invalid');
    const asOf = input.asOf, deadlineAt = clock(event.cutoffAt) < clock(event.kickoffTime) ? event.cutoffAt : event.kickoffTime;
    const deadlineNs = clock(deadlineAt);
    const candidates = [], rejected = [];
    input.observations.forEach((row, index) => {
      const normalized = normalizeObservation(row, event, asOfNs, deadlineNs);
      if (normalized.reason) rejected.push({ index, reason: normalized.reason });
      else candidates.push({ index, observation: normalized.observation });
    });
    const groups = new Map();
    for (const row of candidates) {
      const o = row.observation, key = JSON.stringify([o.source, o.company]);
      const group = groups.get(key) || []; group.push(row); groups.set(key, group);
    }
    const streams = [];
    for (const [key, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      rows.sort((a, b) => {
        const first = clock(a.observation.receivedAt), second = clock(b.observation.receivedAt);
        return first < second ? -1 : first > second ? 1 : a.index - b.index;
      });
      const conflicting = new Set();
      const instants = new Map();
      for (const row of rows) {
        const o = row.observation, at = clock(o.receivedAt).toString(), seen = instants.get(at) || [];
        seen.push(row); instants.set(at, seen);
      }
      for (const rowsAt of instants.values()) {
        if (new Set(rowsAt.map(row => JSON.stringify([row.observation.homeLine, row.observation.decimalOdds]))).size > 1) {
          for (const row of rowsAt) { conflicting.add(row.index); rejected.push({ index: row.index, reason: 'same-company-receipt-time-conflict' }); }
        }
      }
      const accepted = rows.filter(row => !conflicting.has(row.index)).map(row => row.observation);
      if (accepted.length) { const [source, company] = JSON.parse(key); streams.push(streamFor(source, company, accepted)); }
    }
    const latestQuotes = streams.map(stream => ({ ...stream.observations.at(-1),
      ageAtAsOfMs: displayMilliseconds(asOfNs - clock(stream.observations.at(-1).receivedAt)) }));
    const observationCount = streams.reduce((sum, stream) => sum + stream.observationCount, 0);
    const body = { version: VERSION, market: MARKET, available: observationCount > 0,
      reason: observationCount ? null : 'no-eligible-observations', formalEligible: false, event, asOf,
      cutoffAt: earlier(asOfNs, deadlineNs) === asOfNs ? input.asOf : deadlineAt, observationCount, streams, latestQuotes,
      rejected: rejected.sort((a, b) => a.index - b.index),
      homeLineConvention: 'homeGoals-minus-awayGoals-plus-homeLine;negative-home-gives-positive-home-receives',
      priceIndicatorMeaning: 'normalized-inverse-two-sided-prices;not-asian-cover-or-win-probability',
      crossCompanyMovement: 'not-computed;company-set-changes-are-not-line-movement',
      inputKind: 'validation-candidates-not-forecast-input', input: canonicalInput(input) };
    return { ...body, contentHash: hash(body) };
  } catch { return failure('timeline-input-not-serializable'); }
}
function verifyAsianHandicapTimeline(timeline) {
  try {
    if (!timeline || timeline.version !== VERSION || timeline.market !== MARKET || timeline.formalEligible !== false
      || !HASH.test(timeline.contentHash || '') || !timeline.input) return false;
    const { contentHash, ...body } = timeline;
    if (hash(body) !== contentHash) return false;
    const rebuilt = buildAsianHandicapTimeline(timeline.input);
    return Boolean(rebuilt.contentHash && canonicalJson(rebuilt) === canonicalJson(timeline));
  } catch { return false; }
}
function lineLegs(homeLine) {
  return Number.isInteger(homeLine * 2) ? [homeLine] : [Math.floor(homeLine * 2) / 2, Math.ceil(homeLine * 2) / 2];
}
function settleAsianHandicap({ homeGoals, awayGoals, homeLine, decimalOdds, side, market, pool } = {}) {
  if ((market != null && market !== MARKET) || (pool != null && pool !== MARKET)) return failure('asian-market-required');
  if (!Number.isSafeInteger(homeGoals) || homeGoals < 0 || !Number.isSafeInteger(awayGoals) || awayGoals < 0)
    return failure('nonnegative-integer-score-required');
  const line = quarterLine(homeLine), odds = decimalPrice(decimalOdds, 'decimal');
  if (line === null) return failure('signed-home-quarter-line-required');
  if (!['home', 'away'].includes(side)) return failure('asian-side-required');
  if (odds === null) return failure('decimal-price-required');
  if (!Number.isSafeInteger((homeGoals - awayGoals) * 4 + line * 4)) return failure('score-margin-exceeds-exact-quarter-arithmetic');
  const splitLines = lineLegs(line);
  const legs = splitLines.map(legLine => {
    const adjustedMargin = ((homeGoals - awayGoals) * 4 + legLine * 4) * (side === 'home' ? 1 : -1);
    const outcome = adjustedMargin > 0 ? 'win' : adjustedMargin < 0 ? 'loss' : 'push';
    return { homeLine: legLine, stakeFraction: 1 / splitLines.length, outcome,
      grossReturn: outcome === 'win' ? odds : outcome === 'push' ? 1 : 0,
      netReturn: outcome === 'win' ? odds - 1 : outcome === 'push' ? 0 : -1 };
  });
  const wins = legs.filter(leg => leg.outcome === 'win').length, losses = legs.filter(leg => leg.outcome === 'loss').length;
  const outcome = wins === legs.length ? 'fullWin' : losses === legs.length ? 'fullLoss'
    : wins && !losses ? 'halfWin' : losses && !wins ? 'halfLoss' : !wins && !losses ? 'push' : null;
  if (!outcome) return failure('inconsistent-quarter-settlement');
  return { available: true, market: MARKET, formalEligible: false, side, homeLine: line, decimalOdds: odds, outcome, legs,
    grossReturn: legs.reduce((sum, leg) => sum + leg.grossReturn * leg.stakeFraction, 0),
    netReturn: legs.reduce((sum, leg) => sum + leg.netReturn * leg.stakeFraction, 0),
    stake: 1, settlementBasis: 'two-half-stakes-for-quarter-line;integer-push-refunds-stake' };
}
function validatedDistribution(distribution) {
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution) || distribution.complete !== true
    || typeof distribution.tailMass !== 'number' || !Number.isFinite(distribution.tailMass)
    || distribution.tailMass < 0 || distribution.tailMass > MASS_TOLERANCE || !Array.isArray(distribution.rows)
    || !distribution.rows.length || distribution.rows.length > 6561) return null;
  let mass = 0, maxHome = 0, maxAway = 0;
  const seen = new Set(), rows = [];
  for (const row of distribution.rows) {
    const homeGoals = row?.homeGoals ?? row?.home, awayGoals = row?.awayGoals ?? row?.away, probability = row?.probability;
    if ((row?.homeGoals != null && row?.home != null && row.homeGoals !== row.home)
      || (row?.awayGoals != null && row?.away != null && row.awayGoals !== row.away)
      || !Number.isSafeInteger(homeGoals) || homeGoals < 0 || homeGoals > 80 || !Number.isSafeInteger(awayGoals)
      || awayGoals < 0 || awayGoals > 80 || typeof probability !== 'number' || !Number.isFinite(probability)
      || probability < 0 || probability > 1) return null;
    const key = `${homeGoals}:${awayGoals}`;
    if (seen.has(key)) return null;
    seen.add(key); mass += probability; maxHome = Math.max(maxHome, homeGoals); maxAway = Math.max(maxAway, awayGoals);
    rows.push({ homeGoals, awayGoals, probability });
  }
  // A sparse top-K list cannot become complete by renormalizing its prices.
  if (seen.size !== (maxHome + 1) * (maxAway + 1) || Math.abs(mass - 1) > MASS_TOLERANCE
    || Math.abs(mass + distribution.tailMass - 1) > MASS_TOLERANCE) return null;
  return { rows, mass, tailMass: distribution.tailMass };
}
function priceAsianHandicap({ scoreDistribution, homeLine, decimalOdds, side, market, pool } = {}) {
  if ((market != null && market !== MARKET) || (pool != null && pool !== MARKET)) return failure('asian-market-required');
  const distribution = validatedDistribution(scoreDistribution);
  if (!distribution) return failure('complete-score-distribution-required');
  const validation = settleAsianHandicap({ homeGoals: 0, awayGoals: 0, homeLine, decimalOdds, side });
  if (!validation.available) return validation;
  const probabilities = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
  let expectedGrossReturn = 0, expectedNetReturn = 0;
  for (const row of distribution.rows) {
    const settled = settleAsianHandicap({ ...row, homeLine, decimalOdds, side });
    if (!settled.available) return failure('score-settlement-invalid');
    probabilities[settled.outcome] += row.probability;
    expectedGrossReturn += row.probability * settled.grossReturn;
    expectedNetReturn += row.probability * settled.netReturn;
  }
  if (!Number.isFinite(expectedGrossReturn) || !Number.isFinite(expectedNetReturn)) return failure('expected-return-not-finite');
  return { available: true, market: MARKET, formalEligible: false, side, homeLine: validation.homeLine,
    decimalOdds: validation.decimalOdds, probabilities, expectedGrossReturn, expectedNetReturn,
    probabilityMass: distribution.mass, tailMass: distribution.tailMass, stake: 1,
    expectationBasis: 'score-distribution-weighted-full-win-half-win-push-half-loss-full-loss-settlement',
    sourceAuthentication: 'not-established-by-numerical-validation' };
}

module.exports = { buildAsianHandicapTimeline, verifyAsianHandicapTimeline, settleAsianHandicap, priceAsianHandicap };
