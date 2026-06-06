import type { Match, PredictionDetail } from './mockData';

export const DISABLED_PREDICTION_MARKETS: PredictionDetail['marketType'][] = ['GG_NG'];

export function isPredictionMarketEnabled(marketType: PredictionDetail['marketType']) {
  return !DISABLED_PREDICTION_MARKETS.includes(marketType);
}

export function getVisiblePredictions(match: Pick<Match, 'predictions'>): PredictionDetail[] {
  return (match.predictions || []).filter((prediction) => isPredictionMarketEnabled(prediction.marketType));
}

export function getVisiblePrediction(
  match: Pick<Match, 'predictions'>,
  marketType: PredictionDetail['marketType']
): PredictionDetail | undefined {
  if (!isPredictionMarketEnabled(marketType)) return undefined;
  return getVisiblePredictions(match).find((prediction) => prediction.marketType === marketType);
}
