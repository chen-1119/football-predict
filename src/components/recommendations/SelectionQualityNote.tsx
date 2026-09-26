import type { SelectionQuality, SupplementaryResearch, SingleRow } from '../../services/recommendationCenterView';

import { selectionPriceStatus, selectionReferenceLabel } from '../../services/publishedRecommendationStatus.cjs';
export { selectionPriceStatus, selectionReferenceLabel };
export function SupplementaryResearchNote({research,settlement,language}:{research?:SupplementaryResearch|null;settlement?:SingleRow['supplementarySettlement'];language:'zh'|'en'}){
 if(!research)return null;
 const zh=language==='zh';
 const state=(key:'exactScore'|'totalGoals')=>({PENDING:zh?'待赛果':'Pending',WON:zh?'命中':'Hit',LOST:zh?'未命中':'Miss',VOID:zh?'无效':'Void',DISPUTED:zh?'赛果待核':'Disputed'}[settlement?.[key].state??'PENDING']);
 return <div className="supplementary-research-note" data-supplementary-version={research.version}>
  <strong>{zh?'比分与进球数 · 冻结研究首选':'Score & goals · frozen research picks'}</strong>
  <p>{zh?'同向比分':'Aligned score'} {research.exactScore.label} · {(research.exactScore.probability*100).toFixed(1)}% · {state('exactScore')}</p>
  <p>{zh?'总进球':'Total goals'} {research.totalGoals.label} · {(research.totalGoals.probability*100).toFixed(1)}% · {state('totalGoals')}</p>
  <small>{zh?'未绑定官方 SP；命中统计独立记录，模型尚未验证。':'No official SP bound; hits tracked separately, model unvalidated.'}</small>
 </div>;
}

export function SelectionQualityNote({quality,language}:{quality?:SelectionQuality|null;language:'zh'|'en'}){
 if(!quality)return null;
 const zh=language==='zh';
 const labels:Record<string,string>=zh?{'input-evidence-unavailable':'本次模型输入依据尚未完整存档','input-arithmetic-unverified':'本次模型输入计算尚未核验','team-samples-insufficient':'实际参与模型的球队样本不足','model-lead-too-thin':'模型首位与第二方向差距过小，不能当作明确推荐','material-model-market-disagreement':'模型概率与同期官方 SP 去水概率明显冲突，暂不纳入串关','cross-track-direction-conflict':'同场赛前参考与发布方向相反，当前观望'}:{'input-evidence-unavailable':'Current model inputs are not fully archived','input-arithmetic-unverified':'Current input arithmetic is unverified','team-samples-insufficient':'Too few team samples in the active model','model-lead-too-thin':'Model lead is too narrow for a clear recommendation','material-model-market-disagreement':'Model probability materially disagrees with the same-time official market; excluded from combos','cross-track-direction-conflict':'The pre-match reference conflicts with this published direction; watch only'};
 const pct=(n:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`;
 const priceStatus=selectionPriceStatus(quality);
 return <div className="selection-quality-note" data-selection-status={quality.status} data-price-status={priceStatus} style={{padding:'12px 14px',margin:'12px 0',border:'1px solid var(--border-color, #d8e2ea)',borderRadius:12,background:'var(--bg-secondary, #f4f7fa)'}}>
  <strong>{selectionReferenceLabel(quality,language)}</strong>
  <p style={{margin:'6px 0',fontSize:13}}>{quality.qualified?(quality.version==='recommendation-selection-quality-v2'?(zh?'球队样本、模型领先幅度和同期 SP 分歧通过参考筛选；这不是校准、收益或命中率验证。模型概率最高只确定方向，不等于值得投注。':'Samples, model lead, and same-time SP disagreement pass the reference screen. This does not validate calibration, return, or accuracy. The top model probability only sets a direction, not a betting edge.'):(zh?'旧版仅核验球队样本与输入计算；不表示价格或命中率已验证。模型概率最高只确定方向，不等于值得投注。':'The legacy policy checks samples and input arithmetic only; price and accuracy remain unvalidated. The top model probability only sets a direction, not a betting edge.')):quality.reasons.map(r=>labels[r]||r).join('；')+(zh?'，暂不进入新串关。':' — excluded from new combos.')}</p>
  {quality.crossTrack&&<p role="note" data-cross-track-conflict="true" style={{margin:'6px 0',fontSize:12}}>{zh?`同场已核验赛前参考在 ${new Date(quality.crossTrack.referenceRecordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} 记录了${({'1':'主胜',X:'平局','2':'客胜'} as const)[quality.crossTrack.referenceTipCode]}；${quality.crossTrack.knownAtPublication?'发布时已有分歧':'该分歧在本条发布后才记录'}。两条冻结方向保留供复盘，不把任一方向包装成当前确定推荐。`:`An attested pre-match reference recorded ${quality.crossTrack.referenceTipCode} at ${quality.crossTrack.referenceRecordedAt}; ${quality.crossTrack.knownAtPublication?'the disagreement was known at publication':'it arrived after this decision'}. Both frozen directions remain available for review.`}</p>}
  <small>{zh?'与第二方向差距':'Lead over second'} {pct(quality.probabilityLead)} · {zh?'市场概率':'Market probability'} {pct(quality.marketProbability)} · {zh?'模型与市场差值':'Model minus market'} {pct(quality.modelMarketGap)}</small>
  <p style={{margin:'6px 0 0',fontSize:12}}>{zh?'冻结发布模型期望值':'Frozen published model expected value'} {pct(quality.expectedValue)} · {quality.marketProbability==null?(zh?'市场热门不可判定':'Market favorite unavailable'):quality.marketFavorite?(zh?'方向与市场热门一致':'Matches market favorite'):(zh?'方向与市场热门不同':'Differs from market favorite')}</p>
  {priceStatus==='unsupported'&&<p className="selection-quality-note__negative" role="note" data-model-ev="negative" style={{margin:'9px 0 0',padding:'8px 10px',borderLeft:'3px solid #b65a25',borderRadius:6,background:'#fff2e7',color:'#793d1c',fontSize:12,lineHeight:1.5}}>{zh?'按冻结模型概率 × 冻结 SP 计算，期望值为负；不能仅因 SP 低或模型概率最高就视为值得投注。':'Frozen model probability × frozen SP implies negative expected value; neither low SP nor the highest model probability establishes a bet.'}</p>}
 </div>;
}
