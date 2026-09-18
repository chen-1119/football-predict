import { useApp } from '../context/AppContextCore';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
interface BestTipsProps {onSelectMatch:(matchId:string)=>void}
export function BestTips({onSelectMatch}:BestTipsProps){const {language}=useApp();return <RecommendationCenter language={language} onSelectMatch={onSelectMatch}/>;}
