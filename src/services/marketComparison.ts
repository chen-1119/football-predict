import type { Decision, Outcome } from './recommendationCenterView';

const CODES: readonly Outcome[] = ['1', 'X', '2'];
const MAX_QUOTE_AGE_MS = 15 * 60_000;

export interface ComparedOutcome {
  code: Outcome;
  probability: number | null;
  frozenSp: number | null;
  frozenPick: boolean;
  independentLeader: boolean;
}

export interface ComparedMarket {
  pool: 'HAD' | 'HHAD';
  line: number;
  probabilityBasis: 'coherent-score-matrix' | 'standalone-historical' | 'unavailable';
  quoteStatus: 'frozen' | 'missing' | 'expired';
  observedAt: string | null;
  outcomes: ComparedOutcome[];
}

export interface MarketComparisonView {
  decisionId: string;
  markets: [ComparedMarket, ComparedMarket];
  companionConditional: boolean;
}

function triplet(value: Record<Outcome, number> | undefined): Record<Outcome, number> | null {
  if (!value || CODES.some(code => typeof value[code] !== 'number' || !Number.isFinite(value[code])
    || value[code] < 0 || value[code] > 1)) return null;
  if (Math.abs(CODES.reduce((sum, code) => sum + value[code], 0) - 1) > 1e-6) return null;
  return value;
}

function frozenQuotes(
  tripletOdds: Record<Outcome, number> | undefined,
  selected: Outcome,
  selectedOdds: number | undefined,
  observedAt: string | undefined,
  publishedAt: string,
  cutoffTime: string
): { prices: Partial<Record<Outcome, number>>; status: ComparedMarket['quoteStatus'] } {
  const observed = Date.parse(observedAt || ''), published = Date.parse(publishedAt), cutoff = Date.parse(cutoffTime);
  if (!Number.isFinite(observed) || !Number.isFinite(published) || !Number.isFinite(cutoff)
    || observed > published || observed >= cutoff) return { prices: {}, status: 'missing' };
  if (published - observed > MAX_QUOTE_AGE_MS) return { prices: {}, status: 'expired' };
  const valid = (price: number | undefined): price is number => typeof price === 'number' && Number.isFinite(price) && price > 1;
  if (tripletOdds) {
    if (CODES.some(code => !valid(tripletOdds[code]))
      || (valid(selectedOdds) && tripletOdds[selected] !== selectedOdds)) return { prices: {}, status: 'missing' };
    return { prices: tripletOdds, status: 'frozen' };
  }
  return valid(selectedOdds) ? { prices: { [selected]: selectedOdds }, status: 'frozen' }
    : { prices: {}, status: 'missing' };
}

/** A read-only comparison of values already bound to one published decision. */
export function buildMarketComparison(decision: Decision): MarketComparisonView {
  const hadProbabilities = triplet(decision.probabilities);
  const hadPrice = frozenQuotes(decision.quoteOdds, decision.tipCode, decision.odds,
    decision.quoteObservedAt, decision.publishedAt, decision.cutoffTime);
  const handicap = decision.handicapAnalysis;
  const line = handicap?.handicapLine;
  const lineValid = Number.isSafeInteger(line) && line !== 0;
  const coherent = Boolean(lineValid && handicap?.version === 'handicap-margin-v3'
    && handicap.distributionBasis === 'had-calibrated-poisson-score-matrix-v1'
    && handicap.straightTipCode === decision.tipCode
    && hadProbabilities && triplet(handicap.straightProbabilities)
    && CODES.every(code => Math.abs(handicap.straightProbabilities![code] - hadProbabilities[code]) <= 1e-8));
  const hhadProbabilities = lineValid && (handicap?.version !== 'handicap-margin-v3' || coherent)
    ? triplet(handicap?.version === 'handicap-margin-v1' ? handicap.probabilities : handicap?.overallProbabilities)
    : null;
  const had: ComparedMarket = {
    pool: 'HAD', line: 0, probabilityBasis: hadProbabilities
      ? (coherent ? 'coherent-score-matrix' : 'standalone-historical') : 'unavailable',
    quoteStatus: hadPrice.status, observedAt: decision.quoteObservedAt || null,
    outcomes: CODES.map(code => ({ code, probability: hadProbabilities?.[code] ?? null,
      frozenSp: hadPrice.prices[code] ?? null, frozenPick: code === decision.tipCode,
      independentLeader: code === decision.tipCode }))
  };
  const hhadBasis: ComparedMarket['probabilityBasis'] = hhadProbabilities
    ? (coherent ? 'coherent-score-matrix' : 'standalone-historical') : 'unavailable';
  const market = handicap?.marketReference;
  const prices = lineValid && market ? frozenQuotes(market.odds, handicap.tipCode,
    market.selectedOdds, market.observedAt, decision.publishedAt, decision.cutoffTime)
    : { prices: {}, status: 'missing' as const };
  const topHhad = hhadProbabilities ? CODES.reduce((best, code) => hhadProbabilities[code] > hhadProbabilities[best] ? code : best, CODES[0]) : null;
  const hhad: ComparedMarket = {
    pool: 'HHAD', line: lineValid ? line! : 0, probabilityBasis: hhadBasis,
    quoteStatus: prices.status, observedAt: market?.observedAt || null,
    outcomes: CODES.map(code => ({ code, probability: hhadProbabilities?.[code] ?? null,
      frozenSp: prices.prices[code] ?? null,
      frozenPick: Boolean(handicap && code === handicap.tipCode && prices.prices[code] !== undefined),
      independentLeader: code === topHhad }))
  };
  return { decisionId: decision.decisionId, markets: [had, hhad],
    companionConditional: handicap?.probabilityBasis === 'conditional-on-straight-primary' };
}
