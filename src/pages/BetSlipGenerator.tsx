import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
interface BetSlipGeneratorProps {onOpenObservations:()=>void}
export function BetSlipGenerator({onOpenObservations}:BetSlipGeneratorProps){const {language}=useApp();const navigate=useNavigate();return <>
  <RecommendationCenter language={language} initialTab="two" onSelectMatch={id=>navigate(`/match/${encodeURIComponent(id)}`)}/>
  <button type="button" className="rc-link" onClick={onOpenObservations}>{language==='zh'?'查看全部赛程':'View all fixtures'}</button>
</>;}
