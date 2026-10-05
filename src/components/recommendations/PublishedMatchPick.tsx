import type { SingleRow } from '../../services/recommendationCenterView';
import { publicationLifecycle, publicationLifecycleLabel, primaryMarketLabel, coherentProbabilityNote, primarySelectionSummary, handicapExtensionText, quoteSourceLabel, outcomeCategoryLabel, outcomeResearchReasonLabel, outcomeResearchFavoriteValueWarning } from '../../services/recommendationCenterView';
import { publishedPickLabel, publishedResultLabel, publishedResultProjection, settlementResultLabel } from '../../services/publishedMatchRecommendation';
import './published-match-pick.css';
import { SelectionQualityNote, selectionReferenceLabel, SupplementaryResearchNote, PublishedHadDistribution, StrategyAssessmentNote } from './SelectionQualityNote';

type Props = { row: SingleRow | null; language: 'zh'|'en'; loading?: boolean; failed?: boolean; compact?: boolean; now?: number };
const time = (value:string,language:'zh'|'en') => new Intl.DateTimeFormat(language==='zh'?'zh-CN':'en-GB',{
  timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
}).format(new Date(value));

export function MixedModelEstimateNote({language}:{language:'zh'|'en'}){
  return <span data-model-source="mixed-uncalibrated">{language==='zh'
    ? '混合模型估计·未校准。基础模型包含市场概率和球队/比分输入；本条实际采用项以可核验回执为准。赔率换算概率不等于独立预测，手设权重与启发式风险调整也不代表经过校准或未来命中率。'
    : 'Mixed model estimate · uncalibrated. The base model includes market probabilities and team/score inputs; inputs actually used for this record require a verifiable receipt. Odds-implied probabilities are not independent predictions; hand-set weights and heuristic risk adjustments do not establish calibration or future hit rates.'}</span>;
}

export function PublishedMatchPick({row,language,loading=false,failed=false,compact=false,now=Date.now()}:Props){
  const zh=language==='zh';
  if(!row)return <div className="published-match-pick is-empty" role="status"><strong>{loading?(zh?'推荐加载中…':'Loading published pick…'):failed?(zh?'推荐暂未读取，请重试':'Published pick unavailable; retry'):(zh?'暂无已发布推荐':'No published pick')}</strong><small>{zh?'与今日推荐同步，发布后自动显示':'Synced with Today; appears after publication'}</small></div>;
  const d=row.decision,s=primarySelectionSummary(d),h=s.handicap,extension=h?handicapExtensionText(h,language):null;
  const lifecycle=publicationLifecycle(d,now),beforeCutoff=lifecycle!=='review-only',quoteStale=lifecycle==='quote-stale';
  const researchActive=Boolean(row.outcomeResearch?.researchQualified&&beforeCutoff&&!quoteStale&&now>=Date.parse(d.quoteObservedAt));
  const compactCategory=compact&&lifecycle==='open'&&row.outcomeResearch?.candidateCode
    &&(row.outcomeResearch.category==='balanced-draw'||row.outcomeResearch.category==='upset-signal')?row.outcomeResearch:null;
  const favoriteValueWarning=row.outcomeResearch?outcomeResearchFavoriteValueWarning(row.outcomeResearch,zh):null;
  const probabilityNote=coherentProbabilityNote(d,zh);
  const result=publishedResultProjection(row)!;
  const hadCard=<div key="HAD"><small>{primaryMarketLabel(d,'HAD',zh)}</small><strong>{publishedPickLabel(s.had.code,language)}</strong><span>SP {s.had.odds.toFixed(2)} · {zh?'无条件概率':'Unconditional probability'} {(s.had.probability*100).toFixed(1)}%</span></div>;
  const hhadCard=<div key="HHAD" className={h?.status==='pass'?'is-pass':undefined} data-handicap-extension={h?.status??'unavailable'}><small>{h?.status==='pass'?(zh?'让球不追':'Pass handicap'):d.primaryPickPolicyVersion?primaryMarketLabel(d,'HHAD',zh):(zh?'让球延伸':'Handicap extension')}</small><strong>{extension?.title??'—'}</strong><span>{extension?.detail??(zh?'等待有效让球数据':'Awaiting handicap data')}</span></div>;
  const coherent=d.primaryPickPolicyVersion==='coherent-market-primary-v1'?d.coherentPrimary:null;
  const directions=coherent?.anchorMarket==='HHAD'?[hhadCard,hadCard]:[hadCard,hhadCard];
  return <div className={`published-match-pick${compact?' is-compact':''}`} data-decision-id={d.decisionId} data-record-hash={d.recordHash}>
    <StrategyAssessmentNote assessment={row.strategyAssessment} language={language}/>
    {row.strategyAssessment&&<small>{zh?'原冻结方向 · 供复盘与版本对照':'Original frozen directions · review and version comparison'}</small>}
    <div className="published-match-pick__directions">
      {coherent?.hhadCode?<>{directions[0]}<details className="published-match-pick__probability-basis"><summary>{zh?'冻结条件分支 · 非独立推荐':'Frozen conditional branch · not an independent pick'}</summary>{directions[1]}<small>{probabilityNote}</small></details></>:directions}
    </div>
    <PublishedHadDistribution decision={d} language={language}/>
    <small><MixedModelEstimateNote language={language}/></small>
    <small>{zh?'参考 / 观察 · 未校准；冻结主方向不代表价值推荐。':'Reference / watch · uncalibrated; the frozen primary is not a value recommendation.'}</small>
    <small className="published-match-pick__status" data-selection-status={row.selectionQuality?.status??'reference'}>{selectionReferenceLabel(row.selectionQuality,language)}{lifecycle!=='open'?` · ${publicationLifecycleLabel(lifecycle,language)}`:''}{failed?(zh?' · 更新暂时失败':' · Update temporarily failed'):''}</small>
    {compact&&<small className="published-match-pick__quote-time">{zh?'冻结 SP 采集':'Frozen SP observed'} {time(d.quoteObservedAt,language)}</small>}
    <SelectionQualityNote quality={row.selectionQuality} language={language}/>
    {compactCategory?.candidateCode&&<div className="published-match-pick__category" role="note" data-outcome-category={compactCategory.category} data-research-qualified={researchActive}>
      <span>{zh?'分类观察':'Category watch'} · {compactCategory.category==='upset-signal'?(zh?'防冷':'Upset watch'):outcomeCategoryLabel(compactCategory.category,zh)} · {publishedPickLabel(compactCategory.candidateCode,language)}</span>
    </div>}
    {!compact&&row.outcomeResearch&&<div className="published-match-pick__research" data-outcome-category={row.outcomeResearch.category} data-research-qualified={researchActive}>
      <small>{zh?'胜平负分类研究 · 不替换已发布方向':'1X2 category study · published pick unchanged'}</small>
      <strong>{outcomeCategoryLabel(row.outcomeResearch.category,zh)}{row.outcomeResearch.candidateCode?` · ${publishedPickLabel(row.outcomeResearch.candidateCode,language)}`:''}</strong>
      <span>{researchActive?(zh?'研究候选，尚未通过独立比赛日验证':'Study candidate; independent match-day validation pending'):!beforeCutoff?(zh?'已截止，仅供复盘':'Cutoff passed; review only'):quoteStale?(zh?'报价过期，仅供比较':'Price expired; comparison only'):favoriteValueWarning??(row.outcomeResearch.candidateCode?(zh?'分类观察，证据不足，不替换发布方向':'Category observation; evidence insufficient, published pick unchanged'):(zh?'证据不足，仅供三方向比较':'Insufficient evidence; three-way comparison only'))}</span>
      {!compact&&row.outcomeResearch.outcomes.length>0&&<div className="published-match-pick__research-odds">{row.outcomeResearch.outcomes.map(item=><span key={item.code}>{publishedPickLabel(item.code,language)} {(item.modelProbability*100).toFixed(1)}% · SP {item.odds.toFixed(2)}</span>)}</div>}
      {!compact&&row.outcomeResearch.reasons.length>0&&<small>{zh?'限制：':'Limits: '}{row.outcomeResearch.reasons.slice(0,2).map(reason=>outcomeResearchReasonLabel(reason,zh)).join(zh?'、':'; ')}</small>}
    </div>}
    {compact&&<SupplementaryResearchNote compact research={d.supplementaryResearch} decision={d} scoreDistribution={row.scoreDistribution} settlement={row.supplementarySettlement} language={language}/>}
    {!compact&&<><p>{zh?'本场方向、SP和版本与今日推荐保持一致。串关可选择同一场的不同玩法；已冻结的串关保留选定时的版本。':'Direction, SP and version match Today. A combo may use another market; a frozen combo retains its selected version.'}</p>
      {coherent?.hhadCode&&<p>{zh?'旧记录保留发布时的主方向与条件分支；分支只是主方向成立时的一个情形，不作为独立推荐。两玩法展示的仍是无条件概率。':'The frozen record retains its primary and conditional branch. The branch describes one scenario if the primary lands, not an independent pick. Market probabilities remain unconditional.'}</p>}
      {h?.conditional&&<p>{zh?'让球伴随占比以胜平负首选成立为前提，不是独立让球命中率。':'The companion shares are conditional on the 1X2 pick landing, not standalone handicap win rates.'}</p>}
      {h?.status==='pass'&&<p className="published-match-pick__warning">{d.primaryPickPolicyVersion?(zh?'两个最高概率方向无法在同一比分下同时命中；让球只作风险诊断，不作为本场第二条推荐。已冻结记录和独立盘口统计保留原值。':'The two marginal leaders cannot both win on any scoreline. HHAD is a risk diagnostic here, not a second recommendation; frozen records and standalone statistics are unchanged.'):(zh?'不追让球：盘口风险方向未作为胜平负首选的延伸。同向备选仅供比较，完整概率和已冻结串关仍保留原记录。':'Pass handicap: the model risk direction is not an extension of the 1X2 pick. Aligned alternatives are comparisons; full probabilities and frozen combos retain their original records.')}</p>}
      {quoteStale&&<p role="status">{zh?'当前展示上次发布时的SP，已超过15分钟；等待真实新报价后更新，不作为当前可用串关报价。':'These are previously published prices, now over 15 minutes old. New verified quotes are required for current combo selection.'}</p>}
      <div className="published-match-pick__meta"><span>{zh?'发布时间':'Published'} {time(d.publishedAt,language)}</span><span>{zh?'SP采集':'SP observed'} {time(d.quoteObservedAt,language)}</span><span>{quoteSourceLabel(d,language)}</span></div>
      <SupplementaryResearchNote research={d.supplementaryResearch} decision={d} scoreDistribution={row.scoreDistribution} settlement={row.supplementarySettlement} language={language}/>
      <div className="published-match-pick__result" data-result-market={result.primary.market}>
        <div>{result.coherent?`${primaryMarketLabel(d,result.primary.market,zh)}：`:''}{publishedResultLabel(row,language)}{result.primary.settlement?.score?` · ${result.primary.settlement.score}`:''}</div>
        {result.companion&&<small>{primaryMarketLabel(d,result.companion.market,zh)}：{settlementResultLabel(result.companion.settlement,language)}</small>}
      </div>
      <details><summary>{zh?'查看统一推荐版本':'Published record version'}</summary><code>{d.decisionId}</code></details>
    </>}
  </div>;
}
