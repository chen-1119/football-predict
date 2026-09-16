import type { Match, PredictionDetail } from './mockData';

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
