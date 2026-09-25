import type { SelectionQuality } from '../../services/recommendationCenterView';

// This reads a frozen arithmetic diagnostic. It never promotes a pick: the
// underlying model probability still needs independent calibration.
function selectionPriceStatus(quality:SelectionQuality|null|undefined):'unsupported'|'model-supported'|'unknown'{
 if(!quality||quality.expectedValue==null)return 'unknown';
 return quality.expectedValue<0?'unsupported':'model-supported';
}

export function SelectionQualityNote({quality,language}:{quality?:SelectionQuality|null;language:'zh'|'en'}){
 if(!quality)return null;
 const zh=language==='zh';
 const labels:Record<string,string>=zh?{'input-evidence-unavailable':'本次模型输入依据尚未完整存档','input-arithmetic-unverified':'本次模型输入计算尚未核验','team-samples-insufficient':'实际参与模型的球队样本不足'}:{'input-evidence-unavailable':'Current model inputs are not fully archived','input-arithmetic-unverified':'Current input arithmetic is unverified','team-samples-insufficient':'Too few team samples in the active model'};
 const pct=(n:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`;
 const priceStatus=selectionPriceStatus(quality);
 return <div className="selection-quality-note" data-selection-status={quality.status} data-price-status={priceStatus} style={{padding:'12px 14px',margin:'12px 0',border:'1px solid var(--border-color, #d8e2ea)',borderRadius:12,background:'var(--bg-secondary, #f4f7fa)'}}>
  <strong>{!quality.qualified?(zh?'观望 · 保留模型方向':'Watch · model direction retained'):priceStatus==='unsupported'?(zh?'模型方向 · 当前价格不支持':'Model direction · price not supported'):(zh?'输入证据达标 · 价格待验证':'Input checks passed · price unvalidated')}</strong>
  <p style={{margin:'6px 0',fontSize:13}}>{quality.qualified?(zh?'球队样本和输入计算达到参考展示门槛；这不是价格或命中率验证。模型概率最高只确定方向，不等于值得投注。':'Team samples and input arithmetic pass the reference display checks. This does not validate price or accuracy. The highest model probability is a direction, not a betting edge.'):quality.reasons.map(r=>labels[r]||r).join('；')+(zh?'，暂不进入新串关。':' — excluded from new combos.')}</p>
  <small>{zh?'与第二方向差距':'Lead over second'} {pct(quality.probabilityLead)} · {zh?'市场概率':'Market probability'} {pct(quality.marketProbability)} · {zh?'模型与市场差值':'Model minus market'} {pct(quality.modelMarketGap)}</small>
  <p style={{margin:'6px 0 0',fontSize:12}}>{zh?'冻结发布模型期望值':'Frozen published model expected value'} {pct(quality.expectedValue)} · {quality.marketProbability==null?(zh?'市场热门不可判定':'Market favorite unavailable'):quality.marketFavorite?(zh?'方向与市场热门一致':'Matches market favorite'):(zh?'方向与市场热门不同':'Differs from market favorite')}</p>
  {priceStatus==='unsupported'&&<p className="selection-quality-note__negative" role="note" data-model-ev="negative" style={{margin:'9px 0 0',padding:'8px 10px',borderLeft:'3px solid #b65a25',borderRadius:6,background:'#fff2e7',color:'#793d1c',fontSize:12,lineHeight:1.5}}>{zh?'按冻结模型概率 × 冻结 SP 计算，期望值为负；不能仅因 SP 低或模型概率最高就视为值得投注。':'Frozen model probability × frozen SP implies negative expected value; neither low SP nor the highest model probability establishes a bet.'}</p>}
 </div>;
}
