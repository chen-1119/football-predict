import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
import { HitAndWin as LegacyHitAndWin } from './LegacyHitAndWin';
export function HitAndWin(){const {language}=useApp();const navigate=useNavigate();const [legacy,setLegacy]=useState(false);return <>
  <RecommendationCenter language={language} mode="review" onSelectMatch={id=>navigate(`/match/${encodeURIComponent(id)}`)}/>
  <details className="rc-legacy" onToggle={event=>setLegacy(event.currentTarget.open)}><summary>{language==='zh'?'查看升级前的原始复盘口径（不混入新成绩）':'Original pre-upgrade records (separate cohort)'}</summary>{legacy&&<LegacyHitAndWin/>}</details>
</>;}
