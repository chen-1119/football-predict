import { useState } from 'react';
import type { PublishedForecastPayload, Outcome } from '../../services/publishedForecastView';
import '../../styles/published-forecasts.css';
interface Props { data?: PublishedForecastPayload; language: 'zh' | 'en'; failed: boolean; onSelectMatch: (id: string) => void }
const labels: Record<Outcome, [string, string]> = { '1': ['主胜','Home'], X: ['平局','Draw'], '2': ['客胜','Away'] };
const at = (s: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s));
export function PublishedForecastPanel({ data, language, failed, onSelectMatch }: Props) {
  const [review, setReview] = useState(false);
  const zh = language === 'zh', rows = data ? review ? data.history : data.current : [], stats = data?.summary;
  return <section className="published-forecasts" aria-label={zh ? '正式发布单场推荐' : 'Published match forecasts'}>
    <header><div><small>{zh ? '赛前发布 · 唯一首选 · 独立复盘' : 'Pre-match publication · One pick · Separate record'}</small>
      <h2>{zh ? '正式发布的单场推荐' : 'Published match recommendations'}</h2>
      <p>{zh ? '每条记录保存发布时的方向、概率与SP。模型仍在验证，不把发布状态当作命中率保证。' : 'Directions, probabilities and SP are frozen at publication. Model validation remains pending.'}</p></div>
      <div className="published-forecasts__count"><strong>{stats?.published ?? '—'}</strong><span>{zh ? '累计发布' : 'Published'}</span></div></header>
    <div className="published-forecasts__toolbar">
      <div><button type="button" aria-pressed={!review} onClick={() => setReview(false)}>{zh ? '赛前推荐' : 'Match picks'}</button>
        <button type="button" aria-pressed={review} onClick={() => setReview(true)}>{zh ? '发布记录与复盘' : 'Record & Review'}</button></div>
      <span>{data ? `${zh ? '数据截至' : 'As of'} ${at(data.updatedAt)}` : (zh ? '等待读取发布记录' : 'Loading publication records')}</span>
    </div>
    {failed && <p role="status">{zh ? '连接恢复中；以下保留上次读取的冻结记录。' : 'Reconnecting; retained frozen records shown below.'}</p>}
    {!rows.length ? <p className="published-forecasts__empty">{data ? (zh ? '本批暂无已写入的赛前发布记录；不补造历史推荐。' : 'No persisted pre-match publication in this batch.') : (zh ? '正在读取正式发布台账…' : 'Reading publication ledger…')}</p>
      : <div className="published-forecasts__rows">{rows.map(({ forecast: f, settlement: s }) => <article key={f.id}>
        <div className="published-forecasts__fixture"><small>{f.matchNo || f.sourceMatchId} · {at(f.kickoffTime)}</small><strong>{f.homeTeamName} vs {f.awayTeamName}</strong><small>{zh ? '发布' : 'Published'} {at(f.publishedAt)}</small></div>
        <div className="published-forecasts__pick"><span>{zh ? '唯一首选' : 'Primary pick'}</span><strong>{labels[f.tipCode][zh ? 0 : 1]} <small>@{f.odds.toFixed(2)}</small></strong><span>{(['1','X','2'] as const).map(c => `${labels[c][zh ? 0 : 1]} ${(f.probabilities[c] * 100).toFixed(1)}%`).join(' · ')}</span></div>
        <div className={`published-forecasts__result ${s?.state || ''}`}><strong>{s ? s.state === 'WON' ? (zh ? '命中' : 'Won') : s.state === 'LOST' ? (zh ? '未命中' : 'Lost') : s.state === 'VOID' ? (zh ? '无效' : 'Void') : (zh ? '赛果待核' : 'Disputed') : (zh ? '已发布 · 待赛果' : 'Published · Pending')}</strong><span>{s?.score || (zh ? '模型验证中' : 'Model unvalidated')}</span></div>
        <button type="button" onClick={() => onSelectMatch(f.matchId)}>{zh ? '比赛详情' : 'Details'}</button>
      </article>)}</div>}
    <footer><span>{zh ? '已发布推荐命中率' : 'Published-pick hit rate'} <strong>{stats?.hitRate == null ? '—' : `${(stats.hitRate * 100).toFixed(1)}%`}</strong></span>
      <span>{zh ? '命中 / 已结算' : 'Won / Settled'} <strong>{stats ? `${stats.won} / ${stats.settled}` : '—'}</strong></span>
      <span>{zh ? '待赛果' : 'Pending'} <strong>{stats?.pending ?? '—'}</strong></span>
      <small>{zh ? '此口径从新发布记录开始；不并入旧“已验证正式”成绩，也不计入串关命中率。' : 'New publication cohort; separate from validated-model and combo statistics.'}</small></footer>
  </section>;
}
