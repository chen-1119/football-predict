import React from 'react';
import { useApp } from '../context/AppContextCore';
import { DailyFeaturedPlans } from '../components/predictions/DailyFeaturedPlans';
import { BestTips as ExistingBestTips } from './BestTips';

interface BestTipsWithFeaturedProps {
  onSelectMatch: (matchId: string) => void;
}

export const BestTipsWithFeatured: React.FC<BestTipsWithFeaturedProps> = ({ onSelectMatch }) => {
  const { matches, language } = useApp();
  return (
    <div className="best-tips-composed-page">
      <DailyFeaturedPlans matches={matches} language={language} onSelectMatch={onSelectMatch} />
      <ExistingBestTips onSelectMatch={onSelectMatch} />
    </div>
  );
};
