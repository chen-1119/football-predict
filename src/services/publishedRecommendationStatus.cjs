'use strict';

// Frozen price arithmetic never promotes a direction into validated advice.
function selectionPriceStatus(quality){
 if(!quality||quality.expectedValue==null)return 'unknown';
 return quality.expectedValue<0?'unsupported':'model-supported';
}
function selectionReferenceLabel(quality,language){
 const zh=language==='zh';
 if(!quality)return zh?'模型方向 · 证据待核':'Model direction · evidence pending';
 return !quality.qualified?(zh?'观望 · 保留模型方向':'Watch · model direction retained')
  :selectionPriceStatus(quality)==='unsupported'?(zh?'模型方向 · 当前价格不支持':'Model direction · price not supported')
  :(zh?'参考入选 · 模型未验证':'Reference-qualified · model unvalidated');
}
function publicationLifecycle(d,now){
 const cutoff=Date.parse(d.cutoffTime),kickoff=Date.parse(d.kickoffTime);
 if(!Number.isFinite(now)||!Number.isFinite(cutoff)||!Number.isFinite(kickoff)||now>=Math.min(cutoff,kickoff))return 'review-only';
 const observed=Date.parse(d.quoteObservedAt);
 return !Number.isFinite(observed)||now<observed||now-observed>15*60000?'quote-stale':'open';
}
function publicationLifecycleLabel(status,language){
 return status==='review-only'?(language==='zh'?'已截止 · 仅供复盘':'Cutoff passed · review only')
  :status==='quote-stale'?(language==='zh'?'SP待更新 · 观望':'SP refresh pending · watch'):'';
}
module.exports={selectionPriceStatus,selectionReferenceLabel,publicationLifecycle,publicationLifecycleLabel};
