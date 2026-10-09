import type {DailyBulletin} from '../../services/recommendationCenterView';
import './daily-bulletin.css';
const time=(s:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s));
const band={high:'高',medium:'中',low:'低'};
export function DailyBulletinPanel({data,now,failed,review=false}:{data?:DailyBulletin;now:number;failed:boolean;review?:boolean}){
 const current=!failed&&data?.businessDate===new Date(now+28800000).toISOString().slice(0,10)?data:undefined;
 return <section className="rc-paper daily-bulletin" aria-label="每日竞彩推荐">
  <header><h2>{review?'每日竞彩复盘':'每日竞彩推荐'}</h2><small>北京时间 · 赛前参考</small></header>
  <p>11:00 复盘与早场补充 · 工作日 20:00 精选 / 21:00 完整 · 周末 21:00 精选 / 22:00 完整</p>
  {!current||current.status==='unavailable'?<p role="status">每日推荐暂时不可用，等待有效发布记录。</p>:review?<>
   {current.review?<><h3>{current.review.previousBusinessDate} 竞彩日</h3><p>方向命中 {current.review.previous.won}/{current.review.previous.settled} · 首选比分 {current.review.previous.scoreTop1} · 双比分覆盖 {current.review.previous.scoreTop2} · 待赛果 {current.review.previous.pending}</p>
    <p>累计方向 {current.review.cumulative.won}/{current.review.cumulative.settled}（{current.review.cumulative.hitRate===null?'暂无已结算':`${(100*current.review.cumulative.hitRate).toFixed(1)}%`}）</p>
    <p>{(['high','medium','low'] as const).map(c=>`${band[c]}信心 ${current.review!.confidence[c]?.won??0}/${current.review!.confidence[c]?.settled??0}`).join(' · ')}</p>
    <p>{[2.5,5,10].map(minimum=>{const c=current.review!.combos.find(c=>c.businessDate===current.review!.previousBusinessDate&&c.minimum===minimum);return `2串1 ≥${minimum}：${c?({WON:'命中',LOST:'未命中',PENDING:'待赛果',VOID:'无效',DISPUTED:'争议待核'}[c.state]||'待核'):'未发布'}`;}).join(' · ')}</p>
    <small>按本规则首次赛前记录去重；90分钟含补时。无效、争议及待赛果不入命中分母。首选比分与双比分覆盖分别统计。</small></>:<p>每日11:00后更新复盘。</p>}
  </>:<>
   {!current.records.length?<p role="status">{current.status==='waiting-schedule'?'未到本期发布时段。':'等待当日在售、身份和报价均可核验的场次。'}</p>:
    <div className="daily-bulletin__grid">{current.records.map(r=><article key={r.id} data-bulletin-id={r.id}>
     <small>{r.matchNo||'编号未核实'} · {time(r.kickoffTime)}</small><h3>{r.homeTeamName} vs {r.awayTeamName}</h3>
     <strong>{r.selection.label} · SP {r.selection.odds.toFixed(2)}</strong><p>首选 {r.scores[0].label} · 次选 {r.scores[1].label} · 信心{band[r.confidence]}</p>
     <small>{now>=Date.parse(r.cutoffAt)?'已截止 · 冻结记录':now-Date.parse(r.quoteObservedAt)>900000?'冻结SP已超过15分钟，请勿当作当前报价':'赛前冻结参考'} · 报价 {time(r.quoteObservedAt)}</small>
     <details><summary>分析依据</summary><p>{r.summary}</p><p>去水市场概率：{(['1','X','2'] as const).map((c,i)=>`${['胜','平','负'][i]} ${(r.marketProbabilities[c]*100).toFixed(1)}%`).join(' / ')}（{r.selection.market}）</p>
      {r.evidence.map(f=><p key={f.name}>{f.name}：{f.text}</p>)}<p>{r.analysisLink?<a href={r.analysisLink} target="_blank" rel="noopener noreferrer">已核验赛前分析</a>:'赛前分析链接：未核实'}</p>
      <small>模型 {r.modelVersion} · 当前仍含市场先验，未宣称独立预测优势。两个比分是与本方向相容的参考。</small></details>
    </article>)}</div>}
   <h3>精选2串1</h3><div className="daily-bulletin__grid">{current.tiers.map(t=><article key={t.minimum}><strong>组合 SP ≥{t.minimum}</strong>
    {t.status==='available'?<><p>{t.legs.map(l=>`${l.matchNo||''} ${l.homeTeamName} vs ${l.awayTeamName} ${l.selection.label} ${l.selection.odds.toFixed(2)}`).join(' × ')}</p><p>组合 {t.totalOdds?.toFixed(4)} · {t.reason}</p></>:<p>{t.reason}</p>}</article>)}</div>
   <p>相对更稳：{current.records.filter(r=>r.confidence!=='low').slice(0,2).map(r=>`${r.homeTeamName} vs ${r.awayTeamName}`).join('、')||'暂无证据充分的场次'}；资料未核实、低信心场次建议少碰。</p>
  </>}
 </section>;
}
