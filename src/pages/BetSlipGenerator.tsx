import { useApp } from '../context/AppContextCore';
import { DailyFeaturedCombos } from '../components/predictions/DailyFeaturedCombos';

interface BetSlipGeneratorProps {
  onSelectMatch: (id: string) => void;
}

export function BetSlipGenerator({ onSelectMatch }: BetSlipGeneratorProps) {
  const { language } = useApp();
  return <div className="space-y-6">
    <DailyFeaturedCombos language={language} onSelectMatch={onSelectMatch} />
  </div>;
}
