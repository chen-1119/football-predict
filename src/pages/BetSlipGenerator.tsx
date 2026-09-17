import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { DailyFeaturedCombos } from '../components/predictions/DailyFeaturedCombos';

interface BetSlipGeneratorProps { onOpenObservations: () => void }

/** Both combo entry points consume the same server selections and frozen ledger. */
export const BetSlipGenerator: React.FC<BetSlipGeneratorProps> = ({ onOpenObservations }) => {
  const { language, matches } = useApp();
  const navigate = useNavigate();
  return <section className="best-pool-v4">
    <DailyFeaturedCombos matches={matches} language={language}
      onSelectMatch={(id) => navigate(`/match/${encodeURIComponent(id)}`, { state: { openedFromList: true, fromPath: '/betslip' } })} />
    <button type="button" className="btn btn-secondary" onClick={onOpenObservations}>
      {language === 'zh' ? '查看全部单场分析' : 'View all match analysis'}
    </button>
  </section>;
};
