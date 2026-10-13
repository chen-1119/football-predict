import { useState } from 'react';
import { coverageDay, type PublishedReviewCoverage, type PublishedReviewTrack, type PublishedReviewCounts } from '../../services/publishedReviewCoverage';
import './published-review-coverage.css';

const tracks: PublishedReviewTrack[] = ['manual', 'trained', 'legacy'];
const names = { manual: '人工审核', trained: '训练模型参考', legacy: '旧策略归档' };
const enNames = { manual: 'Reviewed editorial', trained: 'Trained model reference', legacy: 'Legacy archive' };
function CountBody({ data, zh }: { data: PublishedReviewCounts; zh: boolean }) {
  return <>
    <p><strong>{zh ? '已发布' : 'Published'} {data.publishedRecords}</strong> · {zh ? '已结算' : 'Settled'} {data.settled}</p>
    <p>{zh ? '方向命中' : 'Winning picks'} {data.won}/{data.settled} · {data.hitRate === null ? (zh ? '暂无已结算分母' : 'No settled denominator') : `${(data.hitRate * 100).toFixed(1)}%`}</p>
    <p>{zh ? '待核验赛果' : 'Awaiting verified result'} {data.pending} · {zh ? '未核实' : 'Unknown'} {data.unknown}</p>
    <p>{zh ? '取消 / 无效' : 'Void'} {data.void} · {zh ? '争议' : 'Disputed'} {data.disputed}</p>
    {data.scoreEligible > 0 && <small>{zh ? '比分已核验样本' : 'Score samples'} {data.scoreEligible} · {zh ? '首选比分' : 'First score'} {data.scoreTop1}/{data.scoreEligible} · {zh ? '双比分覆盖' : 'Either score'} {data.scoreTop2}/{data.scoreEligible}</small>}
  </>;
}
export function PublishedReviewCoveragePanel({ data, failed, language = 'zh' }: { data?: PublishedReviewCoverage; failed: boolean; language?: 'zh' | 'en' }) {
  const zh = language === 'zh';
  const [track, setTrack] = useState<'all' | PublishedReviewTrack>('all');
  const [businessDate, setBusinessDate] = useState('');
  if (!data) return <section className="rc-paper published-review-coverage" aria-label={zh ? '已发布推荐统计' : 'Published recommendation coverage'}>
    <h2>{zh ? '已发布推荐统计' : 'Published recommendation coverage'}</h2>
    <p role="status">{failed ? (zh ? '统计读取失败，当前总数未知。' : 'Coverage failed to load; the total is unknown.') : (zh ? '人工与训练模型统计尚未接入。下方旧策略台账单独保留，不能代表全部推荐。' : 'Editorial and trained-model coverage is not connected yet. The legacy ledger below does not represent all recommendations.')}</p>
  </section>;
  const days = [...new Set(tracks.flatMap(t => data.tracks[t].days.map(d => d.businessDate)))].sort().reverse();
  const visible = track === 'all' ? tracks : [track];
  return <section className="rc-paper published-review-coverage" aria-label={zh ? '已发布推荐统计' : 'Published recommendation coverage'}>
    <header><h2>{zh ? '已发布推荐统计' : 'Published recommendation coverage'}</h2><time dateTime={data.asOf}>{zh ? '统计观察' : 'Observed'} {new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(data.asOf))} · {zh ? '北京时间' : 'Beijing time'}</time></header>
    <p className="published-review-coverage__total"><strong>{zh ? '累计独立比赛' : 'Distinct matches overall'} {data.overall.distinctEvents}</strong>{!data.complete && <span> · {zh ? '已核验部分，完整总数待核' : 'Verified subset; complete total pending'}</span>}</p>
    <p>{zh ? '同一场跨轨道只计一次；命中数与已结算分母按轨道分开。' : 'A match is counted once overall. Wins and settled denominators remain separate by track.'}</p>
    {failed && <p role="status">{zh ? '本次刷新失败，以下保留上次统计及其观察时间。' : 'Refresh failed; the previous observation is retained below.'}</p>}
    {!data.complete && <p role="status">{zh ? '有记录或身份冲突待核验，以下数据不代表完整覆盖。' : 'Records or identity conflicts remain unresolved; these counts are incomplete.'}</p>}
    <div className="published-review-coverage__filters">
      <label>{zh ? '统计轨道' : 'Track'} <select value={track} onChange={e => setTrack(e.target.value as 'all' | PublishedReviewTrack)}><option value="all">{zh ? '全部轨道' : 'All tracks'}</option>{tracks.map(t => <option key={t} value={t}>{zh ? names[t] : enNames[t]}</option>)}</select></label>
      <label>{zh ? '竞彩日' : 'Match day'} <select value={businessDate} onChange={e => setBusinessDate(e.target.value)}><option value="">{zh ? '累计 · 所有竞彩日' : 'All match days'}</option>{days.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
    </div>
    <div className="published-review-coverage__grid">{visible.map(t => {
      const row = businessDate ? coverageDay(data, t, businessDate) : data.tracks[t];
      return <article key={t}><h3>{zh ? names[t] : enNames[t]}</h3><small>{businessDate || (zh ? '累计' : 'All time')}</small>
        {row ? <CountBody data={row} zh={zh}/> : <p>{zh ? '该日数据待核，不能记为零。' : 'This day is unresolved, not zero.'}</p>}
        {!businessDate && <details><summary>{zh ? '按原发布玩法拆分' : 'By original published market'}</summary>{(['HAD', 'HHAD'] as const).map(m => <div key={m}><h4>{m === 'HAD' ? (zh ? '胜平负 HAD' : '1X2 HAD') : (zh ? '让球胜平负 HHAD' : 'Handicap HHAD')}</h4><CountBody data={data.tracks[t].markets[m]} zh={zh}/></div>)}</details>}
      </article>;
    })}</div>
    <small>{zh ? '人工与训练参考取首个合资格赛前版本；旧策略沿用原最新发布版本。仅可信90分钟含补时赛果进入命中分母，待核验、未核实、取消和争议均排除。组合沿用各自冻结档案另行统计。' : 'Editorial and trained references use the first eligible pre-match version; legacy statistics retain their original latest-version rule. Only verified regulation-time results enter hit-rate denominators. Pending, unknown, void and disputed results are excluded. Combos retain their separate frozen archives.'}</small>
  </section>;
}
