import React from 'react';
import { useApp } from '../context/AppContextCore';
import { DailyFeaturedPlans } from '../components/predictions/DailyFeaturedPlans';
import { BestTips as ExistingBestTips } from './BestTips';

interface BestTipsWithFeaturedProps {
  onSelectMatch: (matchId: string) => void;
}

export const BestTipsWithFeatured: React.FC<BestTipsWithFeaturedProps> = ({ onSelectMatch }) => {
  const { matches, language } = useApp();
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="best-tips-composed-page">
      <DailyFeaturedPlans matches={matches} language={language} now={now} onSelectMatch={onSelectMatch} />
      <ExistingBestTips onSelectMatch={onSelectMatch} />
    </div>
  );
};
