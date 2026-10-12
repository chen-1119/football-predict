import type { Match } from './mockData';

// This public marker only suppresses legacy browser fallbacks. It cannot grant
// publication authority or replace the server's private policy/receipt checks.
export const isLegacyCurrentRecommendationRetired = (
  match: Pick<Match, 'recommendationAuthority'>,
): boolean => match.recommendationAuthority?.version === 'recommendation-publication-authority-v1'
  && match.recommendationAuthority.mode === 'reviewed-and-trained'
  && match.recommendationAuthority.legacyCurrentEnabled === false;
