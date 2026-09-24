import type { SelectionQuality } from '../../services/recommendationCenterView';

export function SelectionQualityNote({quality,language}:{quality?:SelectionQuality|null;language:'zh'|'en'}){
 if(!quality)return null;
 const zh=language==='zh';
 const labels:Record<string,string>=zh?{'input-evidence-unavailable':'本次模型输入依据尚未完整存档','input-arithmetic-unverified':'本次模型输入计算尚未核验','team-samples-insufficient':'实际参与模型的球队样本不足'}:{'input-evidence-unavailable':'Current model inputs are not fully archived','input-arithmetic-unverified':'Current input arithmetic is unverified','team-samples-insufficient':'Too few team samples in the active model'};
 const pct=(n:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`;
 const negativeExpectedValue=quality.expectedValue!=null&&quality.expectedValue<0;
 return <div className="selection-quality-note" data-selection-status={quality.status} style={{padding:'12px 14px',margin:'12px 0',border:'1px solid var(--border-color, #d8e2ea)',borderRadius:12,background:'var(--bg-secondary, #f4f7fa)'}}>
  <strong>{quality.qualified?(zh?'参考入选 · 待验证':'Reference eligible · unvalidated'):(zh?'观望 · 保留模型方向':'Watch · model direction retained')}</strong>
  <p style={{margin:'6px 0',fontSize:13}}>{quality.qualified?(zh?'模型输入证据与实际参与计算的球队样本达到当前门槛；只代表可列入参考，不代表已经验证命中率或回报。':'Model input evidence and active team samples meet the current checks. This permits a reference listing; accuracy and returns remain unvalidated.'):quality.reasons.map(r=>labels[r]||r).join('；')+(zh?'，暂不进入新串关。':' — excluded from new combos.')}</p>
  <small>{zh?'与第二方向差距':'Lead over second'} {pct(quality.probabilityLead)} · {zh?'市场概率':'Market probability'} {pct(quality.marketProbability)} · {zh?'模型与市场差值':'Model minus market'} {pct(quality.modelMarketGap)}</small>
  <p style={{margin:'6px 0 0',fontSize:12}}>{zh?'冻结发布模型期望值':'Frozen published model expected value'} {pct(quality.expectedValue)} · {quality.marketProbability==null?(zh?'市场热门不可判定':'Market favorite unavailable'):quality.marketFavorite?(zh?'方向与市场热门一致':'Matches market favorite'):(zh?'方向与市场热门不同':'Differs from market favorite')}</p>
  {negativeExpectedValue&&<p className="selection-quality-note__negative" role="note" data-model-ev="negative" style={{margin:'9px 0 0',padding:'8px 10px',borderLeft:'3px solid #b65a25',borderRadius:6,background:'#fff2e7',color:'#793d1c',fontSize:12,lineHeight:1.5}}>{zh?'冻结发布时的模型概率与SP不占优；参考入选不等于值得投注。':'The frozen published model probability and SP do not show an edge; reference eligibility is not a betting recommendation.'}</p>}
 </div>;
}
