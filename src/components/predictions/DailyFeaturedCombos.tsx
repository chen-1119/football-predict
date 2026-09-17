import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Match } from '../../services/mockData';
import { visibleComboForSize, type ComboRowView, type ComboSize } from '../../services/dailyComboView';
import { useDailyFeaturedCombos } from '../../hooks/useDailyFeaturedCombos';
import { PublishedForecastPanel } from './PublishedForecastPanel';
import '../../styles/recommendation-quality.css';
interface Props { matches?: Match[]; language: 'zh' | 'en'; enabled?: boolean; onSelectMatch: (id: string) => void }
const at = (s: string | null | undefined) => s && Number.isFinite(Date.parse(s)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s)) : '—';
function ComboCard({ size, row, zh, loading, failed, onSelectMatch }: { size: ComboSize; row: ComboRowView | null; zh: boolean; loading: boolean; failed: boolean; onSelectMatch: (id: string) => void }) {
  const resultText = row?.settlement?.status === 'WON' ? (zh ? '命中' : 'Won') : row?.settlement?.status === 'LOST' ? (zh ? '未命中' : 'Lost') : row?.settlement?.status === 'VOID' ? (zh ? '无效' : 'Void') : row?.frozenAt ? (zh ? '已冻结' : 'Frozen') : (zh ? '即时方案' : 'Preview');
  return <article className={`daily-combo-card ${row ? 'is-ready' : 'is-empty'}`}>
    <header className="daily-combo-card__header"><div><span>{zh ? `${size}串1` : `${size}-leg combo`}</span><small>SP ≥ {size === 2 ? '2.50' : '5.00'}{row ? ` · ${resultText}` : ''}</small></div><strong>{row ? `@${row.totalOdds.toFixed(2)}` : '—'}</strong></header>
    {row ? <><div className="daily-combo-card__legs">{row.legs.map((leg, i) => {
      const label = leg.tipCode === '1' ? (zh ? '主胜' : 'Home') : leg.tipCode === 'X' ? (zh ? '平局' : 'Draw') : (zh ? '客胜' : 'Away');
      const result = row.settlement?.results?.find(r => r.sourceMatchId === leg.sourceMatchId);
      return <button key={leg.sourceMatchId} type="button" className="daily-combo-leg" onClick={() => onSelectMatch(leg.matchId)}>
        <span className="daily-combo-leg__index">{i + 1}</span><span className="daily-combo-leg__match"><strong>{leg.homeTeamName || leg.homeTeamId} vs {leg.awayTeamName || leg.awayTeamId}</strong>
          <small>{leg.matchNo || ''} · {at(leg.kickoffTime)} · {leg.market === 'HHAD' ? `${zh ? '让球' : 'Handicap'} ${leg.handicapLine} ` : ''}{label}</small>
          <small>{zh ? '模型倾向' : 'Model estimate'} {typeof leg.modelProbability === 'number' ? `${(leg.modelProbability * 100).toFixed(1)}%` : '—'} · {zh ? '市场去水' : 'Market'} {typeof leg.marketProbability === 'number' ? `${(leg.marketProbability * 100).toFixed(1)}%` : '—'}</small>
          {result?.finalScore && <small>{result.finalScore} · {result.result === 'WON' ? (zh ? '命中' : 'Won') : result.result === 'LOST' ? (zh ? '未命中' : 'Lost') : result.result}</small>}
        </span><span className="daily-combo-leg__odds">@{leg.odds.toFixed(2)}</span></button>;
    })}</div><footer className="daily-combo-card__footer"><span>{row.frozenAt ? (zh ? '已冻结' : 'Frozen') : (zh ? '计划冻结' : 'Freeze at')} {at(row.frozenAt || row.freezeAt)}</span><strong>{zh ? '与单场成绩分开' : 'Separate combo record'}</strong></footer></>
      : <div className="daily-combo-card__empty"><p>{loading ? (zh ? '正在读取组合…' : 'Loading combos…') : failed ? (zh ? '正在恢复数据连接，已冻结记录保留。' : 'Reconnecting; frozen records retained.') : (zh ? `当前可用场次未组成满足SP下限的${size}串1。` : `No eligible ${size}-leg combination meets the SP floor.`)}</p></div>}
  </article>;
}
export function DailyFeaturedCombos({ language, onSelectMatch }: Props) {
  // One shared request controls single publications and combos. No additional polling layer.
  const { ledger, loading, failed, refresh } = useDailyFeaturedCombos();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer); }, []);
  const zh = language === 'zh', stats = ledger?.independentStatistics;
  return <>
    <PublishedForecastPanel data={ledger?.publishedForecasts} language={language} failed={failed} onSelectMatch={onSelectMatch} />
    <section className="daily-combo-board" aria-label={zh ? '每日独立串关' : 'Independent daily combos'}>
      <header className="daily-combo-board__header"><div><div><h2>{zh ? '每日2串1 / 3串1' : 'Daily 2-leg / 3-leg combos'}</h2><p>{zh ? '按当天比赛独立筛选，不依赖正式单场数量；未冻结方案不计入成绩。' : 'Independent selection; no formal single-pick prerequisite. Only frozen combos enter statistics.'}</p></div></div><div className="daily-combo-board__actions"><span className="daily-combo-board__rule">2串1 ≥2.50 · 3串1 ≥5.00</span><button type="button" className="daily-combo-board__refresh" onClick={refresh} aria-label={zh ? '刷新数据' : 'Refresh data'}><RefreshCw size={14} aria-hidden="true" /></button></div></header>
      <div className="daily-combo-board__meta"><span>{zh ? '候选' : 'Candidates'} {ledger?.candidateCount ?? '—'}</span><span>{zh ? '更新' : 'Updated'} {at(ledger?.updatedAt)}</span><span>{zh ? '临近停售提前冻结' : 'Freeze before cutoff'}</span></div>
      <div className="daily-combo-board__grid">{([2,3] as const).map(size => <ComboCard key={size} size={size} row={visibleComboForSize(ledger, size, now, failed)} zh={zh} loading={loading} failed={failed} onSelectMatch={onSelectMatch} />)}</div>
      <footer className="daily-combo-performance">{([['two',2],['three',3]] as const).map(([key,size]) => <div key={key}><span>{zh ? `${size}串1累计` : `${size}-leg cumulative`}</span><strong>{stats?.[key]?.hitRate == null ? '—' : `${(stats[key]!.hitRate! * 100).toFixed(1)}%`}</strong><small>{stats?.[key] ? `${stats[key]!.won}/${stats[key]!.settled}` : '—'}</small></div>)}<div><span>{zh ? '口径' : 'Cohort'}</span><strong>{zh ? '独立统计' : 'Independent'}</strong><small>{zh ? '排序分不是已验证的组合命中概率' : 'Ranking scores are not calibrated combo probabilities'}</small></div></footer>
    </section>
  </>;
}
