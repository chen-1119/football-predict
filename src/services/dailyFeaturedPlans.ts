import type { Match, PredictionDetail } from './mockData';
import {
  getOfficialRecommendationOdds,
  isFormalRecommendationPrediction
} from './displayRecommendation';
import { getArchivedPreMatchPrediction } from './archivedPreMatchPrediction';
import { isBeforeMatchSaleCutoff } from './matchLifecycle';
import { getCalibratedModelProbability, getEvidenceScore } from './predictionPresentation';

export type FeaturedPlanKind = 'TWO' | 'THREE';
export type FeaturedPlanSettlement = 'WON' | 'LOST' | 'PENDING' | 'VOID';

export interface FeaturedPlanSelection {
  match: Match;
  prediction: PredictionDetail;
  evidenceScore: number;
  modelProbability: number | null;
}

export interface DailyFeaturedPlan {
  kind: FeaturedPlanKind;
  businessDate: string;
  selectionCount: 2 | 3;
  minimumCombinedSp: number;
  status: 'available' | 'unavailable';
  combinedSp: number | null;
  averageEvidenceScore: number | null;
  averageModelProbability: number | null;
  selections: FeaturedPlanSelection[];
  reason: string;
}

export interface FeaturedPlanReview extends DailyFeaturedPlan {
  settlement: FeaturedPlanSettlement;
  selectionSettlements: FeaturedPlanSettlement[];
}

const PLAN_RULES: Record<FeaturedPlanKind, { count: 2 | 3; minimumCombinedSp: number }> = {
  TWO: { count: 2, minimumCombinedSp: 2.5 },
  THREE: { count: 3, minimumCombinedSp: 5.0 }
};

const resultCodes = new Set(['1', 'X', '2']);

const shanghaiDate = (value: string | number | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : '';
};

export const featuredPlanBusinessDate = (match: Match) => (
  String(match.businessDate || match.matchDate || match.kickoffDate || '').slice(0, 10)
  || shanghaiDate(match.kickoffTime)
);

const precisionFloorForPrediction = (prediction: PredictionDetail) => prediction.oddsPoolCode === 'HHAD'
  ? { maxOdds: 1.85, minEvidence: 78 }
  : { maxOdds: 2.05, minEvidence: 72 };

const selectionPassesFeaturedGate = (prediction: PredictionDetail, evidenceScore: number) => {
  if (prediction.marketType !== 'BEST') return false;
  if (!resultCodes.has(prediction.tipCode)) return false;
  if (prediction.recommendationAction !== 'recommend' || prediction.recommendationTier !== 'main') return false;
  const odds = Number(prediction.odds || 0);
  const floor = precisionFloorForPrediction(prediction);
  return Number.isFinite(odds)
    && odds > 1
    && odds <= floor.maxOdds
    && evidenceScore >= floor.minEvidence;
};

const currentFeaturedCandidates = (matches: Match[], businessDate: string, now: number) => matches
  .filter((match) => (
    featuredPlanBusinessDate(match) === businessDate
    && match.status === 'SCHEDULED'
    && Date.parse(match.kickoffTime) > now
    && isBeforeMatchSaleCutoff(match, now)
  ))
  .map((match): FeaturedPlanSelection | null => {
    const stored = (match.predictions || []).find((prediction) => (
      prediction.marketType === 'BEST' && isFormalRecommendationPrediction(match, prediction)
    ));
    if (!stored) return null;
    const officialOdds = getOfficialRecommendationOdds(match, stored);
    if (!Number.isFinite(officialOdds) || officialOdds <= 1) return null;
    const prediction = { ...stored, odds: officialOdds };
    const evidenceScore = getEvidenceScore(prediction) ?? 0;
    if (!selectionPassesFeaturedGate(prediction, evidenceScore)) return null;
    return {
      match,
      prediction,
      evidenceScore,
      modelProbability: getCalibratedModelProbability(match, prediction)
    };
  })
  .filter((selection): selection is FeaturedPlanSelection => Boolean(selection));

const archivedFeaturedCandidates = (matches: Match[], businessDate: string) => matches
  .filter((match) => featuredPlanBusinessDate(match) === businessDate)
  .map((match): FeaturedPlanSelection | null => {
    const prediction = getArchivedPreMatchPrediction(match, Number.POSITIVE_INFINITY);
    if (!prediction) return null;
    const evidenceScore = getEvidenceScore(prediction) ?? Number(prediction.multiFactorEvidence?.evidenceScore || 0);
    if (!selectionPassesFeaturedGate(prediction, evidenceScore)) return null;
    return {
      match,
      prediction,
      evidenceScore,
      modelProbability: getCalibratedModelProbability(match, prediction)
    };
  })
  .filter((selection): selection is FeaturedPlanSelection => Boolean(selection));

const selectionQuality = (selection: FeaturedPlanSelection) => {
  const modelProbability = Number(selection.modelProbability);
  const probabilityScore = Number.isFinite(modelProbability) ? modelProbability : 0;
  const pricePenalty = Math.max(0, Number(selection.prediction.odds || 1) - 1) * 4;
  return selection.evidenceScore * 1.5 + probabilityScore * 0.35 - pricePenalty;
};

const combinations = <T,>(rows: T[], count: number): T[][] => {
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === count) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index < rows.length; index += 1) {
      selected.push(rows[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
};

const selectFeaturedPlan = (
  candidates: FeaturedPlanSelection[],
  businessDate: string,
  kind: FeaturedPlanKind
): DailyFeaturedPlan => {
  const rule = PLAN_RULES[kind];
  const ranked = [...candidates]
    .sort((left, right) => selectionQuality(right) - selectionQuality(left))
    .slice(0, 18);
  const eligible = combinations(ranked, rule.count)
    .map((selections) => {
      const combinedSp = selections.reduce((product, row) => product * Number(row.prediction.odds), 1);
      const averageEvidenceScore = selections.reduce((sum, row) => sum + row.evidenceScore, 0) / selections.length;
      const modelProbabilities = selections
        .map((row) => Number(row.modelProbability))
        .filter(Number.isFinite);
      const averageModelProbability = modelProbabilities.length === selections.length
        ? modelProbabilities.reduce((sum, value) => sum + value, 0) / modelProbabilities.length
        : null;
      const quality = selections.reduce((sum, row) => sum + selectionQuality(row), 0)
        - Math.max(0, combinedSp - rule.minimumCombinedSp) * 2.5;
      return { selections, combinedSp, averageEvidenceScore, averageModelProbability, quality };
    })
    .filter((row) => row.combinedSp >= rule.minimumCombinedSp)
    .sort((left, right) => right.quality - left.quality || left.combinedSp - right.combinedSp);

  const best = eligible[0];
  if (!best) {
    return {
      kind,
      businessDate,
      selectionCount: rule.count,
      minimumCombinedSp: rule.minimumCombinedSp,
      status: 'unavailable',
      combinedSp: null,
      averageEvidenceScore: null,
      averageModelProbability: null,
      selections: [],
      reason: `No ${rule.count}-selection precision-qualified plan reaches SP ${rule.minimumCombinedSp.toFixed(2)}.`
    };
  }

  return {
    kind,
    businessDate,
    selectionCount: rule.count,
    minimumCombinedSp: rule.minimumCombinedSp,
    status: 'available',
    combinedSp: Number(best.combinedSp.toFixed(2)),
    averageEvidenceScore: Number(best.averageEvidenceScore.toFixed(1)),
    averageModelProbability: best.averageModelProbability === null ? null : Number(best.averageModelProbability.toFixed(1)),
    selections: best.selections,
    reason: 'Precision-qualified frozen/formal directions selected with a hard combined-SP floor.'
  };
};

export const buildDailyFeaturedPlans = (
  matches: Match[],
  options: { businessDate?: string; now?: number } = {}
) => {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const businessDate = options.businessDate || shanghaiDate(now);
  const candidates = currentFeaturedCandidates(matches, businessDate, now);
  return {
    businessDate,
    candidates: candidates.length,
    two: selectFeaturedPlan(candidates, businessDate, 'TWO'),
    three: selectFeaturedPlan(candidates, businessDate, 'THREE')
  };
};

const parseHandicap = (value: unknown) => {
  const normalized = String(value ?? '').trim().replace(/[＋﹢]/g, '+').replace(/[－−–—]/g, '-');
  if (!/^[+-]?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const settleSelection = (selection: FeaturedPlanSelection): FeaturedPlanSettlement => {
  const { match, prediction } = selection;
  if (match.resultDisposition === 'VOID') return 'VOID';
  if (match.status !== 'FINISHED' || !Number.isInteger(match.scoreHome) || !Number.isInteger(match.scoreAway)) return 'PENDING';
  let actual: '1' | 'X' | '2';
  if (prediction.oddsPoolCode === 'HHAD') {
    const line = parseHandicap(prediction.handicapLine);
    if (line === null) return 'PENDING';
    const adjustedHome = Number(match.scoreHome) + line;
    actual = adjustedHome > Number(match.scoreAway) ? '1' : adjustedHome < Number(match.scoreAway) ? '2' : 'X';
  } else {
    actual = Number(match.scoreHome) > Number(match.scoreAway)
      ? '1'
      : Number(match.scoreHome) < Number(match.scoreAway) ? '2' : 'X';
  }
  return prediction.tipCode === actual ? 'WON' : 'LOST';
};

export const reviewFeaturedPlan = (plan: DailyFeaturedPlan): FeaturedPlanReview => {
  const selectionSettlements = plan.status === 'available'
    ? plan.selections.map(settleSelection)
    : [];
  const settlement: FeaturedPlanSettlement = plan.status !== 'available'
    ? 'PENDING'
    : selectionSettlements.includes('LOST')
      ? 'LOST'
      : selectionSettlements.includes('PENDING')
        ? 'PENDING'
        : selectionSettlements.includes('VOID')
          ? 'VOID'
          : 'WON';
  return { ...plan, settlement, selectionSettlements };
};

export const buildHistoricalFeaturedPlanReview = (matches: Match[], businessDate: string) => {
  const candidates = archivedFeaturedCandidates(matches, businessDate);
  return {
    businessDate,
    candidates: candidates.length,
    two: reviewFeaturedPlan(selectFeaturedPlan(candidates, businessDate, 'TWO')),
    three: reviewFeaturedPlan(selectFeaturedPlan(candidates, businessDate, 'THREE'))
  };
};
