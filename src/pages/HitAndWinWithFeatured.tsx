import React from 'react';
import { useApp } from '../context/AppContextCore';
import { FeaturedPlanReviewSummary } from '../components/review/FeaturedPlanReviewSummary';
import { HitAndWin as ExistingHitAndWin } from './HitAndWin';

export const HitAndWinWithFeatured: React.FC = () => {
  const { matches, language } = useApp();
  return (
    <div className="review-composed-page">
      <FeaturedPlanReviewSummary matches={matches} language={language} />
      <ExistingHitAndWin />
    </div>
  );
};
