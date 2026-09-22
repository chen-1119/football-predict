import { useApp } from '../context/AppContextCore';
import { useSearchParams } from 'react-router-dom';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
interface BestTipsProps {onSelectMatch:(matchId:string)=>void}
export function BestTips({onSelectMatch}:BestTipsProps){
 const {language}=useApp(),[params,setParams]=useSearchParams();
 const requested=params.get('tab'),tab=requested==='two'||requested==='three'?requested:'single';
 return <RecommendationCenter language={language} onSelectMatch={onSelectMatch} selectedTab={tab} onTabChange={next=>{const query=new URLSearchParams(params);if(next==='single')query.delete('tab');else query.set('tab',next);setParams(query);}}/>;
}
