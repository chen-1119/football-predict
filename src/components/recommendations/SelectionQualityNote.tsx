import type { SelectionQuality } from '../../services/recommendationCenterView';

export function SelectionQualityNote({quality,language}:{quality?:SelectionQuality|null;language:'zh'|'en'}){
 if(!quality)return null;
 const zh=language==='zh';
 const labels:Record<string,string>=zh?{'input-evidence-unavailable':'本次模型输入依据尚未完整存档','input-arithmetic-unverified':'本次模型输入计算尚未核验','team-samples-insufficient':'实际参与模型的球队样本不足'}:{'input-evidence-unavailable':'Current model inputs are not fully archived','input-arithmetic-unverified':'Current input arithmetic is unverified','team-samples-insufficient':'Too few team samples in the active model'};
 const pct=(n:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`;
 return <div className="selection-quality-note" data-selection-status={quality.status} style={{padding:'12px 14px',margin:'12px 0',border:'1px solid var(--border-color, #d8e2ea)',borderRadius:12,background:'var(--bg-secondary, #f4f7fa)'}}>
  <strong>{quality.qualified?(zh?'参考入选 · 待验证':'Reference eligible · unvalidated'):(zh?'观望 · 保留模型方向':'Watch · model direction retained')}</strong>
  <p style={{margin:'6px 0',fontSize:13}}>{quality.qualified?(zh?'已具备实际参与计算的球队样本；不代表已经验证命中率或回报。':'Active team samples are available; accuracy and returns remain unvalidated.'):quality.reasons.map(r=>labels[r]||r).join('；')+(zh?'，暂不进入新串关。':' — excluded from new combos.')}</p>
  <small>{zh?'与第二方向差距':'Lead over second'} {pct(quality.probabilityLead)} · {zh?'市场概率':'Market probability'} {pct(quality.marketProbability)} · {zh?'模型与市场差值':'Model minus market'} {pct(quality.modelMarketGap)}</small>
  <p style={{margin:'6px 0 0',fontSize:12}}>{zh?'模型期望值':'Model expected value'} {pct(quality.expectedValue)} · {quality.marketFavorite?(zh?'方向与市场热门一致':'Matches market favorite'):(zh?'方向与市场热门不同':'Differs from market favorite')}{quality.expectedValue!=null&&quality.expectedValue<0?(zh?' · 按当前模型与SP计算不占优':' · Negative at the current model probability and SP'):''}</p>
 </div>;
}
