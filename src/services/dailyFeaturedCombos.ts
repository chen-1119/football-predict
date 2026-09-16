import type { Match, PredictionDetail } from './mockData';
import { getFormalRecommendationPrediction, getOfficialRecommendationOdds } from './displayRecommendation';
import { getEvidenceScore } from './predictionPresentation';

export type FeaturedComboSize = 2 | 3;

export interface FeaturedComboLeg {
  match: Match;
  prediction: PredictionDetail;
  odds: number;
  evidenceScore: number;
}

export interface FeaturedCombo {
  size: FeaturedComboSize;
  minimumTotalOdds: number;
  totalOdds: number;
  averageEvidenceScore: number;
  legs: FeaturedComboLeg[];
  status: 'ready' | 'insufficient';
  reason?: string;
}

const COMBO_MINIMUMS: Record<FeaturedComboSize, number> = { 2: 2.5, 3: 5 };

const candidateForMatch = (match: Match): FeaturedComboLeg | null => {
  const prediction = getFormalRecommendationPrediction(match);
  if (!prediction || match.status !== 'SCHEDULED') return null;
  if (prediction.marketType !== 'BEST' || prediction.recommendationAction !== 'recommend') return null;
  if (prediction.oddsPoolCode !== 'HAD' && prediction.oddsPoolCode !== 'HHAD') return null;
  if (!['1', 'X', '2'].includes(prediction.tipCode)) return null;

  const odds = getOfficialRecommendationOdds(match, prediction);
  const evidenceScore = getEvidenceScore(prediction);
  if (!Number.isFinite(odds) || odds <= 1 || odds > 2.6) return null;
  if (evidenceScore === null || !Number.isFinite(evidenceScore)) return null;

  const requiredEvidence = prediction.oddsPoolCode === 'HHAD' || odds >= 2.06
    ? 74
    : odds >= 1.71
      ? 70
      : 66;
  if (evidenceScore < requiredEvidence) return null;

  return { match, prediction: { ...prediction, odds }, odds, evidenceScore };
};

const combinationRank = (legs: FeaturedComboLeg[], minimumTotalOdds: number) => {
  const totalOdds = legs.reduce((product, leg) => product * leg.odds, 1);
  const averageEvidenceScore = legs.reduce((sum, leg) => sum + leg.evidenceScore, 0) / legs.length;
  const hhadCount = legs.filter((leg) => leg.prediction.oddsPoolCode === 'HHAD').length;
  const highOddsCount = legs.filter((leg) => leg.odds >= 2.06).length;
  const distanceAboveFloor = Math.log(Math.max(totalOdds, minimumTotalOdds) / minimumTotalOdds);
  return {
    totalOdds,
    averageEvidenceScore,
    score: distanceAboveFloor * 22 + hhadCount * 4 + highOddsCount * 3 - averageEvidenceScore / 10,
  };
};

const chooseBestCombination = (candidates: FeaturedComboLeg[], size: FeaturedComboSize): FeaturedCombo => {
  const minimumTotalOdds = COMBO_MINIMUMS[size];
  let best: FeaturedComboLeg[] | null = null;
  let bestRank: ReturnType<typeof combinationRank> | null = null;

  const walk = (start: number, picked: FeaturedComboLeg[]) => {
    if (picked.length === size) {
      const rank = combinationRank(picked, minimumTotalOdds);
      if (rank.totalOdds + 1e-9 < minimumTotalOdds) return;
      if (!bestRank || rank.score < bestRank.score || (Math.abs(rank.score - bestRank.score) < 1e-9 && rank.averageEvidenceScore > bestRank.averageEvidenceScore)) {
        best = [...picked];
        bestRank = rank;
      }
      return;
    }
    for (let index = start; index < candidates.length; index += 1) walk(index + 1, [...picked, candidates[index]]);
  };

  walk(0, []);
  if (!best || !bestRank) {
    return { size, minimumTotalOdds, totalOdds: 1, averageEvidenceScore: 0, legs: [], status: 'insufficient', reason: `No ${size}-match combination clears the quality and SP floor.` };
  }
  return { size, minimumTotalOdds, totalOdds: Number(bestRank.totalOdds.toFixed(2)), averageEvidenceScore: Number(bestRank.averageEvidenceScore.toFixed(1)), legs: best, status: 'ready' };
};

export const buildDailyFeaturedCombos = (matches: Match[]) => {
  const candidates = matches
    .map(candidateForMatch)
    .filter((candidate): candidate is FeaturedComboLeg => Boolean(candidate))
    .sort((left, right) => {
      const evidence = right.evidenceScore - left.evidenceScore;
      if (evidence !== 0) return evidence;
      const kickoff = Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime);
      if (Number.isFinite(kickoff) && kickoff !== 0) return kickoff;
      return left.odds - right.odds;
    })
    .slice(0, 18);
  return { candidates, two: chooseBestCombination(candidates, 2), three: chooseBestCombination(candidates, 3) };
};
