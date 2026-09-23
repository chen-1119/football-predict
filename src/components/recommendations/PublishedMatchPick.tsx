import type { SingleRow } from '../../services/recommendationCenterView';
import { primarySelectionSummary, handicapExtensionText, quoteSourceLabel } from '../../services/recommendationCenterView';
import { publishedPickLabel, publishedResultLabel } from '../../services/publishedMatchRecommendation';
import './published-match-pick.css';
import { SelectionQualityNote } from './SelectionQualityNote';

type Props = { row: SingleRow | null; language: 'zh'|'en'; loading?: boolean; failed?: boolean; compact?: boolean; now?: number };
const time = (value:string,language:'zh'|'en') => new Intl.DateTimeFormat(language==='zh'?'zh-CN':'en-GB',{
  timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
}).format(new Date(value));

export function PublishedMatchPick({row,language,loading=false,failed=false,compact=false,now=Date.now()}:Props){
  const zh=language==='zh';
  if(!row)return <div className="published-match-pick is-empty" role="status"><strong>{loading?(zh?'推荐加载中…':'Loading published pick…'):failed?(zh?'推荐暂未读取，请重试':'Published pick unavailable; retry'):(zh?'暂无已发布推荐':'No published pick')}</strong><small>{zh?'与今日推荐同步，发布后自动显示':'Synced with Today; appears after publication'}</small></div>;
  const d=row.decision,s=primarySelectionSummary(d),h=s.handicap,extension=h?handicapExtensionText(h,language):null;
  const beforeCutoff=now<Math.min(Date.parse(d.cutoffTime),Date.parse(d.kickoffTime));
  const quoteStale=beforeCutoff&&now-Date.parse(d.quoteObservedAt)>15*60000;
  return <div className={`published-match-pick${compact?' is-compact':''}`} data-decision-id={d.decisionId} data-record-hash={d.recordHash}>
    <div className="published-match-pick__directions">
      <div><small>{zh?'胜平负首选':'1X2 primary'}</small><strong>{publishedPickLabel(s.had.code,language)}</strong><span>SP {s.had.odds.toFixed(2)} · {(s.had.probability*100).toFixed(1)}%</span></div>
      <div className={h?.status==='pass'?'is-pass':undefined} data-handicap-extension={h?.status??'unavailable'}><small>{zh?'让球延伸':'Handicap extension'}</small><strong>{extension?.title??'—'}</strong><span>{extension?.detail??(zh?'等待有效让球数据':'Awaiting handicap data')}</span></div>
    </div>
    <small className="published-match-pick__status" data-selection-status={row.selectionQuality?.status??'reference'}>{row.selectionQuality?.qualified===false?(zh?'已发布模型方向 · 观望':'Published model direction · watch'):row.selectionQuality?.qualified===true?(zh?'参考入选 · 尚未通过正式验证':'Reference eligible · formal validation pending'):(zh?'已发布 · 参考／影子':'Published · reference/shadow')}{quoteStale?(zh?' · SP待更新':' · SP refresh pending'):''}{failed?(zh?' · 更新暂时失败':' · Update temporarily failed'):''}</small>
    {compact&&<small className="published-match-pick__quote-time">{zh?'冻结 SP 采集':'Frozen SP observed'} {time(d.quoteObservedAt,language)}</small>}
    <SelectionQualityNote quality={row.selectionQuality} language={language}/>
    {!compact&&<><p>{zh?'本场方向、SP和版本与今日推荐保持一致。串关可选择同一场的不同玩法；已冻结的串关保留选定时的版本。':'Direction, SP and version match Today. A combo may use another market; a frozen combo retains its selected version.'}</p>
      {h?.conditional&&<p>{zh?'让球伴随占比以胜平负首选成立为前提，不是独立让球命中率。':'The companion shares are conditional on the 1X2 pick landing, not standalone handicap win rates.'}</p>}
      {h?.status==='pass'&&<p className="published-match-pick__warning">{zh?'不追让球：盘口风险方向未作为胜平负首选的延伸。同向备选仅供比较，完整概率和已冻结串关仍保留原记录。':'Pass handicap: the model risk direction is not an extension of the 1X2 pick. Aligned alternatives are comparisons; full probabilities and frozen combos retain their original records.'}</p>}
      {quoteStale&&<p role="status">{zh?'当前展示上次发布时的SP，已超过15分钟；等待真实新报价后更新，不作为当前可用串关报价。':'These are previously published prices, now over 15 minutes old. New verified quotes are required for current combo selection.'}</p>}
      <div className="published-match-pick__meta"><span>{zh?'发布时间':'Published'} {time(d.publishedAt,language)}</span><span>{zh?'SP采集':'SP observed'} {time(d.quoteObservedAt,language)}</span><span>{quoteSourceLabel(d,language)}</span></div>
      <div className="published-match-pick__result">{publishedResultLabel(row,language)}{row.settlement.score?` · ${row.settlement.score}`:''}</div>
      <details><summary>{zh?'查看统一推荐版本':'Published record version'}</summary><code>{d.decisionId}</code></details>
    </>}
  </div>;
}
