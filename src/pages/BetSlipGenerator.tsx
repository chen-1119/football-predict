import { useApp } from '../context/AppContextCore';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
interface BetSlipGeneratorProps {onSelectMatch:(matchId:string)=>void}
export function BetSlipGenerator({onSelectMatch}:BetSlipGeneratorProps){
  const {language}=useApp();
  return <RecommendationCenter language={language} initialTab="two" onSelectMatch={onSelectMatch}/>;
}
