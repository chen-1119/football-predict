import type { Match } from './mockData';
import type { SavedMatchCapture } from '../components/predictions/CapturedMatchData';

const VERSION = 'captured-1x2-independent-poisson-reference-v1' as const;
const MIN_LAMBDA = 0.02;
const MAX_LAMBDA = 8;
const MAX_GOALS = 35;
const MAX_FIT_ERROR = 0.005;
const MAX_TAIL_MASS = 0.000001;

type Outcomes = { home: number; draw: number; away: number };
type OutcomeCode = keyof Outcomes;
export type CapturedReferenceUnavailableReason =
  | 'capture-missing' | 'invalid-match-identity' | 'capture-identity-mismatch'
  | 'capture-not-reference-only' | 'invalid-time' | 'match-not-scheduled' | 'match-started'
  | 'manual-odds-missing' | 'unsupported-capture-method' | 'invalid-odds'
  | 'observation-in-future' | 'observation-not-prematch'
  | 'fit-quality-insufficient' | 'truncation-quality-insufficient';
export type CapturedReferenceAnalysis = {
  version: typeof VERSION;
  status: 'unavailable';
  reason: CapturedReferenceUnavailableReason;
} | {
  version: typeof VERSION;
  status: 'available';
  recommendationAction: 'reference';
  productionEligible: false;
  inputObservedAt: string;
  inputOdds: [number, number, number];
  market: Outcomes & { overround: number };
  outcome: { code: OutcomeCode; probability: number; gap: number };
  model: {
    homeLambda: number; awayLambda: number; totalLambda: number;
    fitMaxError: number; matrixMass: number; tailMass: number; fittedOutcome: Outcomes;
  };
  scores: Array<{ home: number; away: number; probability: number }>;
  totalGoals: Array<{ label: string; probability: number }>;
  goalsPick: { label: string; probability: number };
  over25: number;
  under25: number;
  btts: number;
};

// Require explicit offsets and valid calendar components; Date.parse alone
// accepts some impossible dates by rolling them into the next month.
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function poisson(lambda: number, max = MAX_GOALS): number[] {
  const probabilities = [Math.exp(-lambda)];
  for (let count = 1; count <= max; count++) probabilities.push(probabilities[count - 1] * lambda / count);
  return probabilities;
}

function evaluate(homeLambda: number, awayLambda: number, target: Outcomes) {
  const home = poisson(homeLambda), away = poisson(awayLambda);
  let homeCdf = 0, awayCdf = 0, win = 0, draw = 0, lose = 0;
  for (let count = 0; count <= MAX_GOALS; count++) {
    win += home[count] * awayCdf;
    lose += away[count] * homeCdf;
    draw += home[count] * away[count];
    homeCdf += home[count];
    awayCdf += away[count];
  }
  const fittedOutcome = { home: win, draw, away: lose };
  const errors = [win - target.home, draw - target.draw, lose - target.away];
  return { homeLambda, awayLambda, fittedOutcome,
    error: errors.reduce((sum, value) => sum + value * value, 0),
    fitMaxError: Math.max(...errors.map(Math.abs)), matrixMass: Math.min(1, homeCdf * awayCdf) };
}

function fitPoisson(target: Outcomes) {
  // Canonicalize the favourite side so swapping the input gives the same
  // numerical search, with only the final home/away axes swapped.
  const swapped = target.home < target.away;
  const canonical = swapped ? { home: target.away, draw: target.draw, away: target.home } : target;
  let best: ReturnType<typeof evaluate>;
  if (canonical.home === canonical.away) {
    let low = MIN_LAMBDA, high = MAX_LAMBDA;
    for (let iteration = 0; iteration < 60; iteration++) {
      const midpoint = (low + high) / 2;
      if (evaluate(midpoint, midpoint, canonical).fittedOutcome.draw > canonical.draw) low = midpoint;
      else high = midpoint;
    }
    best = evaluate((low + high) / 2, (low + high) / 2, canonical);
  } else {
    const low = Math.log(MIN_LAMBDA), high = Math.log(MAX_LAMBDA), gridStep = (high - low) / 16;
    const candidates: Array<{ x: number; y: number; fit: ReturnType<typeof evaluate> }> = [];
    for (let home = 0; home <= 16; home++) {
      for (let away = 0; away <= 16; away++) {
        const x = low + home * gridStep, y = low + away * gridStep;
        candidates.push({ x, y, fit: evaluate(Math.exp(x), Math.exp(y), canonical) });
      }
    }
    candidates.sort((a, b) => a.fit.error - b.fit.error);
    best = candidates[0].fit;
    for (const start of candidates.slice(0, 4)) {
      let current = start, step = gridStep;
      for (let iteration = 0; iteration < 100 && step > 0.000001; iteration++) {
        let next = current;
        for (const dx of [-1, 0, 1]) {
          for (const dy of [-1, 0, 1]) {
            if (dx === 0 && dy === 0) continue;
            const x = Math.max(low, Math.min(high, current.x + dx * step));
            const y = Math.max(low, Math.min(high, current.y + dy * step));
            const fit = evaluate(Math.exp(x), Math.exp(y), canonical);
            if (fit.error < next.fit.error) next = { x, y, fit };
          }
        }
        if (next === current) step /= 2;
        else current = next;
      }
      if (current.fit.error < best.error) best = current.fit;
    }
  }
  return swapped ? evaluate(best.awayLambda, best.homeLambda, target) : best;
}

/** A bounded reference fit to one saved market observation. This is not a
 * calibrated prediction model and never modifies matches or archived picks. */
export function buildCapturedReferenceAnalysis(
  match: Pick<Match, 'id' | 'homeTeamName' | 'awayTeamName' | 'kickoffTime' | 'status'>,
  capture: SavedMatchCapture | undefined,
  now = Date.now()
): CapturedReferenceAnalysis {
  const unavailable = (reason: CapturedReferenceUnavailableReason): CapturedReferenceAnalysis => ({ version: VERSION, status: 'unavailable', reason });
  if (!capture) return unavailable('capture-missing');
  if (!match || typeof match.id !== 'string' || !match.id.trim()
    || typeof match.homeTeamName !== 'string' || !match.homeTeamName.trim()
    || typeof match.awayTeamName !== 'string' || !match.awayTeamName.trim()
    || match.homeTeamName === match.awayTeamName) return unavailable('invalid-match-identity');
  if (capture.matchId !== match.id || capture.homeName !== match.homeTeamName || capture.awayName !== match.awayTeamName) return unavailable('capture-identity-mismatch');
  if (capture.predictionEligible !== false) return unavailable('capture-not-reference-only');
  const kickoff = timestamp(match.kickoffTime), captureKickoff = timestamp(capture.kickoffTime);
  if (kickoff === null || captureKickoff === null || !Number.isFinite(now)) return unavailable('invalid-time');
  if (kickoff !== captureKickoff) return unavailable('capture-identity-mismatch');
  if (match.status !== 'SCHEDULED') return unavailable('match-not-scheduled');
  if (now >= kickoff) return unavailable('match-started');
  const manual = capture.manualOdds;
  if (!manual) return unavailable('manual-odds-missing');
  if (manual.method !== 'manual-visual-review') return unavailable('unsupported-capture-method');
  const observed = timestamp(manual.observedAt);
  if (observed === null) return unavailable('invalid-time');
  if (observed >= kickoff) return unavailable('observation-not-prematch');
  if (observed > now) return unavailable('observation-in-future');
  if (!Array.isArray(manual.values) || manual.values.length !== 3
    || [0, 1, 2].some(index => typeof manual.values[index] !== 'string'
      || !/^\d+\.\d{2}$/.test(manual.values[index])
      || !Number.isFinite(Number(manual.values[index])) || Number(manual.values[index]) <= 1)) return unavailable('invalid-odds');
  const inputOdds = manual.values.map(Number) as [number, number, number];
  const inverse = inputOdds.map(value => 1 / value);
  const probabilitySum = [...inverse].sort((a, b) => a - b).reduce((sum, value) => sum + value, 0);
  const market = { home: inverse[0] / probabilitySum, draw: inverse[1] / probabilitySum,
    away: inverse[2] / probabilitySum, overround: probabilitySum - 1 };
  const fit = fitPoisson(market);
  if (!Number.isFinite(fit.fitMaxError) || fit.fitMaxError > MAX_FIT_ERROR) return unavailable('fit-quality-insufficient');
  const tailMass = Math.max(0, 1 - fit.matrixMass);
  if (!Number.isFinite(fit.matrixMass) || tailMass > MAX_TAIL_MASS) return unavailable('truncation-quality-insufficient');
  const totalLambda = fit.homeLambda + fit.awayLambda;
  const home = poisson(fit.homeLambda), away = poisson(fit.awayLambda);
  const scores: Array<{ home: number; away: number; probability: number }> = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) scores.push({ home: h, away: a, probability: home[h] * away[a] });
  }
  scores.sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away);
  const totals = poisson(totalLambda, 6);
  const totalGoals = totals.map((probability, goals) => ({ label: String(goals), probability }));
  totalGoals.push({ label: '7+', probability: Math.max(0, 1 - totals.reduce((sum, probability) => sum + probability, 0)) });
  const outcomes = (['home', 'draw', 'away'] as const).map(code => ({ code, probability: market[code] }))
    .sort((a, b) => b.probability - a.probability);
  const under25 = totals[0] + totals[1] + totals[2];
  return {
    version: VERSION, status: 'available', recommendationAction: 'reference', productionEligible: false,
    inputObservedAt: manual.observedAt, inputOdds, market,
    outcome: { ...outcomes[0], gap: outcomes[0].probability - outcomes[1].probability },
    model: { homeLambda: fit.homeLambda, awayLambda: fit.awayLambda, totalLambda,
      fitMaxError: fit.fitMaxError, matrixMass: fit.matrixMass, tailMass, fittedOutcome: fit.fittedOutcome },
    scores: scores.slice(0, 5), totalGoals,
    goalsPick: totalGoals.reduce((best, row) => row.probability > best.probability ? row : best),
    over25: 1 - under25, under25,
    btts: (1 - Math.exp(-fit.homeLambda)) * (1 - Math.exp(-fit.awayLambda)),
  };
}
