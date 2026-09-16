import React from 'react';
import { Layers3 } from 'lucide-react';
import type { Match } from '../../services/mockData';
import { getAccessAuthHeaders } from '../../services/accessControl';
import { buildApiUrl } from '../../services/runtimeUrls';
import { parseComboLedger, visibleCombo, type ComboLedger, type ComboRow, type ComboStats, type ComboSize } from '../../services/dailyComboView';
import '../../styles/recommendation-quality.css';
import '../../styles/combo-performance.css';

type Language = 'zh' | 'en';
interface Props {
  matches: Match[];
  language: Language;
  /** Compatibility only. Formal single-pick status must not gate this board. */
  enabled?: boolean;
  onSelectMatch: (matchId: string) => void;
}
const timeLabel = (value: string | undefined, language: Language) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms)) : '--';
};
const rate = (stats: ComboStats | undefined) => stats && stats.settled > 0 && typeof stats.hitRate === 'number'
  ? `${(stats.hitRate * 100).toFixed(1)}%` : '--';

function ComboCard({ size, row, language, pending, failed, onSelectMatch }: {
  size: ComboSize; row: ComboRow | null; language: Language; pending: boolean; failed: boolean;
  onSelectMatch: (matchId: string) => void;
}) {
  const zh = language === 'zh';
  const status = row?.settlement?.status;
  const state = status === 'WON' ? (zh ? '已命中' : 'Won') : status === 'LOST' ? (zh ? '未命中' : 'Lost')
    : status === 'VOID' ? (zh ? '无效 · 不计命中率' : 'Void · excluded')
      : row?.frozenAt ? (zh ? '已冻结 · 待赛果' : 'Frozen · pending') : (zh ? '即时方案 · 未冻结' : 'Live preview · not frozen');
  return <article className={`daily-combo-card ${row ? 'is-ready' : 'is-empty'}`}>
    <header className="daily-combo-card__header"><div>
      <span>{zh ? `${size}串1` : `${size}-leg combo`}</span>
      <small>SP ≥ {size === 2 ? '2.50' : '5.00'}{row ? ` · ${state}` : ''}</small>
    </div><strong>{row ? `@${row.totalOdds.toFixed(2)}` : '--'}</strong></header>
    {row ? <>
      <div className="daily-combo-card__legs">{row.legs.map((leg, index) => {
        const label = leg.tipCode === '1' ? (zh ? '主胜' : 'Home') : leg.tipCode === 'X' ? (zh ? '平局' : 'Draw') : (zh ? '客胜' : 'Away');
        const result = row.settlement?.results?.find((item) => item.sourceMatchId === leg.sourceMatchId);
        const probability = typeof leg.modelProbability === 'number' && Number.isFinite(leg.modelProbability)
          ? ` · ${zh ? '模型倾向' : 'Model estimate'} ${(leg.modelProbability * 100).toFixed(1)}%` : '';
        return <button key={`${size}-${leg.sourceMatchId}`} type="button" className="daily-combo-leg" onClick={() => onSelectMatch(leg.matchId)}>
          <span className="daily-combo-leg__index">{index + 1}</span>
          <span className="daily-combo-leg__match"><strong>{leg.homeTeamName || leg.homeTeamId || '--'} vs {leg.awayTeamName || leg.awayTeamId || '--'}</strong>
            <small>{leg.matchNo || ''} {timeLabel(leg.kickoffTime, language)} · {leg.market === 'HHAD' ? `${zh ? '让球' : 'Handicap'} ${leg.handicapLine} ` : ''}{label}{probability}</small>
            {result?.finalScore && <small>{zh ? '赛果' : 'Result'} {result.finalScore} · {result.result}</small>}
          </span><span className="daily-combo-leg__odds">@{leg.odds.toFixed(2)}</span>
        </button>;
      })}</div>
      <footer className="daily-combo-card__footer"><span>{zh ? '独立串关统计，不改变单场正式资格' : 'Separate combo track; single-pick status unchanged'}</span>
        <strong>{row.frozenAt ? timeLabel(row.frozenAt, language) : (zh ? '随数据更新' : 'Updating')}</strong></footer>
    </> : <div className="daily-combo-card__empty"><p>{pending ? (zh ? '正在读取当天串关方案…' : 'Loading daily combinations…')
      : failed ? (zh ? '正在恢复数据读取，历史记录保留。' : 'Reconnecting; historical records retained.')
        : (zh ? `当前可用场次尚未组成满足 SP 下限的${size}串1；新数据到达后自动重算。` : `No valid ${size}-leg combination meets the SP floor yet; new data triggers recalculation.`)}</p></div>}
  </article>;
}

export const DailyFeaturedCombos: React.FC<Props> = ({ language, onSelectMatch }) => {
  const [ledger, setLedger] = React.useState<ComboLedger | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    const load = async () => {
      if (stopped || active) return;
      if (timer) clearTimeout(timer);
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(buildApiUrl('/api/v1/daily-featured-combos'), {
          headers: getAccessAuthHeaders(), cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        });
        if (!response.ok) throw new Error('combo unavailable');
        const payload = parseComboLedger(await response.json());
        if (!stopped) { setLedger(payload); setFailed(false); }
      } catch { if (!stopped) setFailed(true); }
      finally { clearTimeout(timeout); active = undefined; if (!stopped) { setNow(Date.now()); timer = setTimeout(load, 30000); } }
    };
    const wake = () => { if (document.visibilityState === 'visible') void load(); };
    void load();
    const clock = setInterval(() => setNow(Date.now()), 10000);
    window.addEventListener('focus', wake);
    return () => { stopped = true; active?.abort(); if (timer) clearTimeout(timer); clearInterval(clock); window.removeEventListener('focus', wake); };
  }, []);
  const zh = language === 'zh';
  const stats = ledger?.independentStatistics;
  return <section className="daily-combo-board" aria-label={zh ? '每日独立串关' : 'Independent daily combos'}>
    <header className="daily-combo-board__header"><div><span className="daily-combo-board__icon"><Layers3 size={17} aria-hidden="true" /></span><div>
      <h2>{zh ? '每日2串1 / 3串1' : 'Daily 2-leg / 3-leg Combos'}</h2>
      <p>{zh ? '直接从当天比赛的模型概率与在售竞彩 SP 筛选，不等待单场“正式推荐”。' : 'Selected directly from current match probabilities and Sporttery SP; no formal single-pick gate.'}</p>
    </div></div><span className="daily-combo-board__rule">2串1 ≥2.50 · 3串1 ≥5.00</span></header>
    <p>{zh ? '每场一个胜平负方向。当前方案随数据更新；工作日21:00、周末22:00冻结，冻结后只结算。模型倾向不代表已验证的命中率。'
      : 'One HAD direction per match. Previews update with data; freeze weekdays 21:00/weekends 22:00 Shanghai time. Model estimates are not verified hit rates.'}</p>
    {failed && <p role="alert">{zh ? '连接恢复中，已冻结记录仍保留。' : 'Reconnecting; frozen records retained.'}</p>}
    <div className="daily-combo-board__grid">{([2, 3] as const).map((size) => <ComboCard key={size} size={size}
      row={visibleCombo(ledger, size, now, failed)} language={language} pending={!ledger && !failed} failed={failed}
      onSelectMatch={onSelectMatch} />)}</div>
    <footer className="daily-combo-performance" aria-label={zh ? '独立串关复盘统计' : 'Independent combo performance'}>
      {([['two', 2], ['three', 3]] as const).map(([key, size]) => <div key={key}>
        <span>{zh ? `${size}串1独立累计` : `${size}-leg independent record`}</span><strong>{rate(stats?.[key])}</strong>
        <small>{stats?.[key] ? `${stats[key]!.won}/${stats[key]!.settled}` : '--'}</small></div>)}
      <div><span>{zh ? '方案更新（北京时间）' : 'Updated (Shanghai)'}</span><strong>{timeLabel(ledger?.updatedAt, language)}</strong>
        <small>{zh ? '未冻结不计入命中统计' : 'Only frozen combinations enter statistics'}</small></div>
    </footer>
  </section>;
};
