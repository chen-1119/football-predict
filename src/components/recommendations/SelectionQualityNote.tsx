import type { Decision, PublishedScores, SelectionQuality, SupplementaryResearch, SingleRow, StrategyAssessment } from '../../services/recommendationCenterView';
import { publishedDetailPresentation } from '../../services/publishedDetailPresentation';

import { selectionPriceStatus, selectionReferenceLabel } from '../../services/publishedRecommendationStatus.cjs';
export { selectionPriceStatus, selectionReferenceLabel };
export function StrategyAssessmentNote({assessment,language}:{assessment?:StrategyAssessment|null;language:'zh'|'en'}){
 if(!assessment)return null;const zh=language==='zh';
 const reasons:Record<string,string>=zh?{
  'model-uncalibrated':'模型尚未校准','calibration-evidence-missing':'缺少可用校准证据','calibration-evidence-unverified':'校准证据尚未核验','formal-calibration-adapter-unavailable':'尚无正式推荐准入',
  'no-research-value-candidate':'当前无符合筛选的研究价值候选','nonpositive-model-expected-value':'模型期望值不为正','market-disagreement-needs-validation':'模型与市场分歧需要验证','material-absolute-model-market-gap':'模型与市场差异较大',
  'verified-reference-event-conflict':'与已核验参考事件冲突','unverified-reference-event-conflict':'存在尚未核验的参考冲突','quote-clock-invalid':'报价时间不可用','quote-stale':'报价已过期','official-market-quote-unavailable':'缺少对应官方报价',
  'price-evaluation-unavailable':'暂不可评估价格','unconditional-probabilities-unavailable':'缺少完整无条件概率','after-cutoff':'已过销售截止时间','model-data-stale':'模型输入已过期',
  'input-evidence-unavailable':'模型输入证据不足','input-arithmetic-unverified':'输入计算尚未核验','team-samples-insufficient':'球队样本不足','model-lead-too-thin':'概率领先幅度较小','material-model-market-disagreement':'与官方市场存在明显分歧',
  'frozen-decision-invalid':'冻结记录核验失败','evaluation-clock-invalid':'审查时间不可用','frozen-clock-invalid':'冻结时间不可用','frozen-input-after-evaluation':'输入晚于审查时点',
 }:{};
 const label=(reason:string)=>reasons[reason]??reason;
 const names=zh?{'1':'主胜',X:'平局','2':'客胜'}:{'1':'Home',X:'Draw','2':'Away'};
 return <section data-strategy-assessment={assessment.version} data-formal-eligible="false" aria-label={zh?'策略审查':'Strategy assessment'}>
  <strong>{zh?'策略审查 · 未校准':'Strategy assessment · uncalibrated'}</strong>
  <p>{zh?'正式主方向：无 · 观察':'Formal primary: none · watch'}{assessment.selectionStatus==='unavailable'?(zh?'（审查输入暂不可用）':' (assessment inputs unavailable)'):assessment.selectionStatus==='research-value-candidates'?(zh?'；存在研究候选，仍非正式推荐。':'; research candidates exist, but none is a formal recommendation.'):''}</p>
  <small>{assessment.reasons.map(label).join(zh?'；':'; ')}</small>
  <details><summary>{zh?'查看六项价格与风险审查':'View six outcome price and risk assessments'}</summary>{assessment.candidates.map(candidate=><p key={candidate.id} data-strategy-option={candidate.market+':'+candidate.tipCode} data-model-ev={candidate.modelExpectedValue!==null&&candidate.modelExpectedValue<=0?'nonpositive':'unvalidated'}>
   <strong>{candidate.market==='HAD'?(zh?'胜平负':'1X2'):(zh?'让球':'Handicap')} · {names[candidate.tipCode]}</strong>{' · '}
   {zh?'模型期望值':'Model EV'} {candidate.modelExpectedValue===null?'—':(candidate.modelExpectedValue*100).toFixed(1)+'%'}{' · '}
   {candidate.researchValueEligible?(zh?'仅研究候选，未校准':'Research candidate only; uncalibrated'):(zh?'观察':'Watch')}<br/>
   <small>{[...candidate.reasons,...candidate.risks].map(label).join(zh?'；':'; ')}</small>
  </p>)}</details>
  <small>{zh?'概率最高、低 SP 或正模型期望值均不等于正式推荐；保留原冻结记录供版本对照。':'The highest probability, low SP or positive model EV does not establish a formal recommendation. Frozen records remain available for version comparison.'}</small>
 </section>;
}
export function PublishedHadDistribution({decision,language}:{decision:Decision;language:'zh'|'en'}){
 const zh=language==='zh',codes=['1','X','2'] as const,labels=zh?{'1':'主胜',X:'平局','2':'客胜'}:{'1':'Home',X:'Draw','2':'Away'};
 const valid=codes.every(code=>Number.isFinite(decision.probabilities[code])&&decision.probabilities[code]>=0&&decision.probabilities[code]<=1)
  &&Math.abs(codes.reduce((sum,code)=>sum+decision.probabilities[code],0)-1)<=1e-6;
 return <section data-had-distribution="unconditional" aria-label={zh?'胜平负完整分布':'Full 1X2 distribution'}>
  <small>{zh?'胜平负完整分布 · 无条件概率 · 混合模型估计 · 未校准':'Full 1X2 distribution · unconditional · mixed-model estimate · uncalibrated'}</small>
  {valid?<div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:8}}>{codes.map(code=><span key={code} data-had-code={code}>{labels[code]} {(decision.probabilities[code]*100).toFixed(1)}%</span>)}</div>:<small>{zh?'完整冻结概率暂不可用':'Complete frozen probabilities unavailable'}</small>}
  {valid&&<small>{zh?'模型赛果倾向：':'Model outcome tendency: '}{codes.filter(code=>decision.probabilities[code]===Math.max(...codes.map(item=>decision.probabilities[item]))).map(code=>labels[code]).join(' / ')}{zh?'；不是正式推荐。':'; not a formal recommendation.'}</small>}
  <small data-model-origin="not-odds-independent">{zh?'原混合估计包含市场输入，未证明独立于赔率的预测优势。':'The original mixed estimate includes market inputs; predictive advantage independent of odds is unproven.'}</small>
 </section>;
}
export function SupplementaryResearchNote({research,decision,scoreDistribution,settlement,language,compact=false}:{research?:SupplementaryResearch|null;decision?:Decision;scoreDistribution?:PublishedScores|null;settlement?:SingleRow['supplementarySettlement'];language:'zh'|'en';compact?:boolean}){
 const coherent=decision?.primaryPickPolicyVersion==='coherent-market-primary-v1';
 if(!research&&!decision)return null;
 const zh=language==='zh',presentation=decision?publishedDetailPresentation(decision,[],scoreDistribution??null):null;
 const topScores=presentation?.scoreSource==='published-matrix'?presentation.globalTopScores:[];
 const aligned=presentation?.alignedScores??[];
 const state=(key:'exactScore'|'totalGoals')=>({PENDING:zh?'待赛果':'Pending',WON:zh?'命中':'Hit',LOST:zh?'未命中':'Miss',VOID:zh?'无效':'Void',DISPUTED:zh?'赛果待核':'Disputed'}[settlement?.[key].state??'PENDING']);
 const frozenResearch=research&&<><p data-score-reference="frozen-research">{research.version==='supplementary-research-v2'?(zh?'原冻结全局比分研究':'Frozen global-score study'):(zh?'旧版同向比分研究':'Legacy aligned score research')} {research.exactScore.label} · {zh?'无条件概率':'Unconditional probability'} {(research.exactScore.probability*100).toFixed(1)}% · {state('exactScore')}</p>
  <p>{zh?'原冻结总进球研究':'Frozen total-goals study'} {research.totalGoals.label} · {zh?'无条件概率':'Unconditional probability'} {(research.totalGoals.probability*100).toFixed(1)}% · {state('totalGoals')}</p></>;
 return <div className="supplementary-research-note" data-supplementary-version={research?.version} data-score-presentation="global-top3">
  <strong>{zh?'全局比分 Top 3 · 参考 / 观察':'Global score Top 3 · reference / watch'}</strong>
  {topScores.length?<ol data-score-reference="global-top3" style={{listStyle:'none',padding:0,margin:'6px 0',display:'grid',gap:6}}>{topScores.map(score=><li key={score.label} data-score-label={score.label} data-primary-compatible={score.primaryCompatible===null?'unknown':String(score.primaryCompatible)}>
   <strong>{score.label}</strong>{' · '}<span>{score.probability.toFixed(1)}% · {zh?'无条件概率':'unconditional probability'}</span>{' · '}
   <small>{score.primaryCompatible===null?(zh?'主方向关系待核':'Primary relation unverified'):score.primaryCompatible?(zh?'符合主方向':'Compatible with primary'):(zh?'不符合主方向':'Not compatible with primary')}</small>
  </li>)}</ol>:<p data-score-reference="unavailable">{zh?'同源冻结比分暂不可用，不用旧研究首项回填 Top 3。':'Bound frozen scores unavailable; the old study pick does not fill the Top 3.'}</p>}
  {(coherent||research)&&<details><summary>{zh?'查看冻结同向比分与原研究结算':'View frozen aligned scores and original study results'}</summary>
   {coherent&&<p data-score-reference="aligned">{zh?'双方向同时成立的比分示例：':'Scores where both frozen directions land: '}{aligned.length?aligned.slice(0,3).map(score=>score.label+' · '+score.probability.toFixed(1)+'%').join(' / '):(zh?'暂不可用':'unavailable')}<br/>{zh?'此范围同时要求主方向和冻结条件分支，不能替代全局 Top 3；概率未重新归一化。':'This subset requires both the primary and frozen conditional branch; it does not replace the global Top 3. Probabilities are not renormalized.'}</p>}
   {frozenResearch}<small>{zh?'原比分与总球研究沿用发布时的冻结首项结算，不改为 Top 3 或同向范围命中。':'Original score and totals settle only the frozen study picks, never the Top 3 or aligned subset.'}</small>
  </details>}
  <small>{compact?(zh?'低置信 · 未校准；Top 3 与同向比分不另计命中率。':'Low confidence · uncalibrated; no Top 3 or aligned hit-rate claim.'):(zh?'无条件概率来自同一冻结分布；未绑定官方比分 SP，模型未校准。Top 3 与同向比分不另计命中率。':'Unconditional probabilities use the same frozen distribution. No official score SP is bound; the model is uncalibrated. No separate Top 3 or aligned hit rate.')}</small>
 </div>;
}

export function SelectionQualityNote({quality,language}:{quality?:SelectionQuality|null;language:'zh'|'en'}){
 if(!quality)return null;
 const zh=language==='zh';
 const labels:Record<string,string>=zh?{'anchor-market-unavailable':'冻结主方向缺少可用玩法或报价','quote-stale':'主方向报价已过期，等待真实新报价','input-evidence-unavailable':'本次模型输入依据尚未完整存档','input-arithmetic-unverified':'本次模型输入计算尚未核验','team-samples-insufficient':'实际参与模型的球队样本不足','model-lead-too-thin':'模型首位与第二方向差距较小，保留唯一首选并降低置信度','material-model-market-disagreement':'模型概率与同期官方 SP 去水概率明显冲突，暂不纳入串关','cross-track-direction-conflict':quality.assessedMarket==='HHAD'?'胜平负条件分支与赛前参考方向不一致，保留观望限制':'同场赛前参考与发布方向相反，当前观望'}:{'anchor-market-unavailable':'Frozen primary market or price unavailable','quote-stale':'Primary quote expired; awaiting a fresh quote','input-evidence-unavailable':'Current model inputs are not fully archived','input-arithmetic-unverified':'Current input arithmetic is unverified','team-samples-insufficient':'Too few team samples in the active model','model-lead-too-thin':'Model lead is narrow; retain the single primary at low confidence','material-model-market-disagreement':'Model probability materially disagrees with the same-time official market; excluded from combos','cross-track-direction-conflict':quality.assessedMarket==='HHAD'?'The 1X2 conditional branch conflicts with the pre-match reference; the watch restriction remains':'The pre-match reference conflicts with this published direction; watch only'};
 const pct=(n:number|null)=>n==null?'—':`${(n*100).toFixed(1)}%`;
 const priceStatus=selectionPriceStatus(quality);
 return <div className="selection-quality-note" data-selection-status={quality.status} data-price-status={priceStatus} style={{padding:'12px 14px',margin:'12px 0',border:'1px solid var(--border-color, #d8e2ea)',borderRadius:12,background:'var(--bg-secondary, #f4f7fa)'}}>
  <strong>{selectionReferenceLabel(quality,language)}{quality.assessmentBasis==='coherent-primary-anchor-v1'?` · ${zh?'主方向筛选':'Primary assessment'}（${quality.assessedMarket==='HHAD'?(zh?'让球':'HHAD'):(zh?'胜平负':'1X2')}）`:''}</strong>
  <p style={{margin:'6px 0',fontSize:13}}>{quality.qualified?(quality.version==='recommendation-selection-quality-v2'?(zh?'球队样本、模型领先幅度和同期 SP 分歧通过参考筛选；这不是校准、收益或命中率验证。模型概率最高只确定方向，不等于值得投注。':'Samples, model lead, and same-time SP disagreement pass the reference screen. This does not validate calibration, return, or accuracy. The top model probability only sets a direction, not a betting edge.'):(zh?'旧版仅核验球队样本与输入计算；不表示价格或命中率已验证。模型概率最高只确定方向，不等于值得投注。':'The legacy policy checks samples and input arithmetic only; price and accuracy remain unvalidated. The top model probability only sets a direction, not a betting edge.')):quality.reasons.map(r=>labels[r]||r).join('；')+(zh?'，暂不进入新串关。':' — excluded from new combos.')}</p>
  {quality.crossTrack&&<p role="note" data-cross-track-conflict="true" style={{margin:'6px 0',fontSize:12}}>{quality.assessedMarket==='HHAD'&&<strong>{zh?'胜平负条件分支与参考方向不一致。':'The 1X2 conditional branch differs from the reference. '}</strong>}{zh?`同场已核验赛前参考在 ${new Date(quality.crossTrack.referenceRecordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} 记录了${({'1':'主胜',X:'平局','2':'客胜'} as const)[quality.crossTrack.referenceTipCode]}；${quality.crossTrack.knownAtPublication?'发布时已有分歧':'该分歧在本条发布后才记录'}。两条冻结方向保留供复盘，不把任一方向包装成当前确定推荐。`:`An attested pre-match reference recorded ${quality.crossTrack.referenceTipCode} at ${quality.crossTrack.referenceRecordedAt}; ${quality.crossTrack.knownAtPublication?'the disagreement was known at publication':'it arrived after this decision'}. Both frozen directions remain available for review.`}</p>}
  <small>{zh?'与第二方向差距':'Lead over second'} {pct(quality.probabilityLead)} · {zh?'市场概率':'Market probability'} {pct(quality.marketProbability)} · {zh?'模型与市场差值':'Model minus market'} {pct(quality.modelMarketGap)}</small>
  <p style={{margin:'6px 0 0',fontSize:12}}>{zh?'冻结发布模型期望值':'Frozen published model expected value'} {pct(quality.expectedValue)} · {quality.marketProbability==null?(zh?'市场热门不可判定':'Market favorite unavailable'):quality.marketFavorite?(zh?'方向与市场热门一致':'Matches market favorite'):(zh?'方向与市场热门不同':'Differs from market favorite')}</p>
  {priceStatus==='unsupported'&&<p className="selection-quality-note__negative" role="note" data-model-ev="negative" style={{margin:'9px 0 0',padding:'8px 10px',borderLeft:'3px solid #b65a25',borderRadius:6,background:'#fff2e7',color:'#793d1c',fontSize:12,lineHeight:1.5}}>{zh?'按冻结模型概率 × 冻结 SP 计算，期望值为负；不能仅因 SP 低或模型概率最高就视为值得投注。':'Frozen model probability × frozen SP implies negative expected value; neither low SP nor the highest model probability establishes a bet.'}</p>}
 </div>;
}
