import React from 'react';
import { Layers3, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Match } from '../../services/mockData';
import {
  visibleComboForSize,
  type ComboRowView,
  type ComboSize,
  type ComboStatsView,
} from '../../services/dailyComboView';
import { useDailyFeaturedCombos } from '../../hooks/useDailyFeaturedCombos';
import '../../styles/recommendation-quality.css';

type Language = 'zh' | 'en';

interface DailyFeaturedCombosProps {
  matches?: Match[];
  language: Language;
  enabled?: boolean;
  onSelectMatch: (matchId: string) => void;
}

const formatTime = (value: string | null | undefined, language: Language) => {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '--';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(parsed));
};

const directionLabel = (code: string, language: Language) => {
  if (code === '1') return language === 'zh' ? '主胜' : 'Home';
  if (code === 'X') return language === 'zh' ? '平局' : 'Draw';
  return language === 'zh' ? '客胜' : 'Away';
};

const percentage = (value: number | null | undefined) => (
  typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--'
);

const rate = (stats: ComboStatsView | undefined) => (
  stats && stats.settled > 0 && typeof stats.hitRate === 'number'
    ? `${(stats.hitRate * 100).toFixed(1)}%`
    : '--'
);

const settlementLabel = (row: ComboRowView, language: Language) => {
  const zh = language === 'zh';
  if (row.settlement?.status === 'WON') return zh ? '已命中' : 'Won';
  if (row.settlement?.status === 'LOST') return zh ? '未命中' : 'Lost';
  if (row.settlement?.status === 'VOID') return zh ? '无效，不计统计' : 'Void, excluded';
  if (row.frozenAt) return zh ? '已冻结，待赛果' : 'Frozen, pending';
  return zh ? '即时方案' : 'Live preview';
};

const ComboCard: React.FC<{
  size: ComboSize;
  row: ComboRowView | null;
  language: Language;
  loading: boolean;
  failed: boolean;
  onSelectMatch: (matchId: string) => void;
}> = ({ size, row, language, loading, failed, onSelectMatch }) => {
  const zh = language === 'zh';
  return (
    <article className={`daily-combo-card ${row ? 'is-ready' : 'is-empty'}`}>
      <header className="daily-combo-card__header">
        <div>
          <span>{zh ? `${size}串1` : `${size}-leg combo`}</span>
          <small>SP ≥ {size === 2 ? '2.50' : '5.00'}{row ? ` · ${settlementLabel(row, language)}` : ''}</small>
        </div>
        <strong>{row ? `@${row.totalOdds.toFixed(2)}` : '--'}</strong>
      </header>

      {row ? (
        <>
          <div className="daily-combo-card__legs">
            {row.legs.map((leg, index) => {
              const result = row.settlement?.results?.find((item) => item.sourceMatchId === leg.sourceMatchId);
              return (
                <button
                  key={`${size}-${leg.sourceMatchId}`}
                  type="button"
                  className="daily-combo-leg"
                  onClick={() => onSelectMatch(leg.matchId)}
                >
                  <span className="daily-combo-leg__index">{index + 1}</span>
                  <span className="daily-combo-leg__match">
                    <strong>{leg.homeTeamName || leg.homeTeamId || '--'} vs {leg.awayTeamName || leg.awayTeamId || '--'}</strong>
                    <small>
                      {leg.matchNo ? `${leg.matchNo} · ` : ''}{formatTime(leg.kickoffTime, language)} · {directionLabel(leg.tipCode, language)}
                    </small>
                    <small className="daily-combo-leg__probabilities">
                      {zh ? '稳健概率' : 'Robust'} {percentage(leg.robustProbability)}
                      {' · '}{zh ? '模型' : 'Model'} {percentage(leg.modelProbability)}
                      {' · '}{zh ? '市场' : 'Market'} {percentage(leg.marketProbability)}
                    </small>
                    {result?.finalScore && (
                      <small>{zh ? '赛果' : 'Result'} {result.finalScore} · {result.result}</small>
                    )}
                  </span>
                  <span className="daily-combo-leg__odds">@{leg.odds.toFixed(2)}</span>
                </button>
              );
            })}
          </div>
          <footer className="daily-combo-card__footer">
            <span>
              {row.frozenAt
                ? `${zh ? '冻结' : 'Frozen'} ${formatTime(row.frozenAt, language)}`
                : `${zh ? '计划冻结' : 'Freeze'} ${formatTime(row.freezeAt, language)}`}
            </span>
            <strong>
              {typeof row.averageQualityScore === 'number'
                ? `${zh ? '稳健分' : 'Quality'} ${(row.averageQualityScore * 100).toFixed(1)}`
                : '--'}
            </strong>
          </footer>
        </>
      ) : (
        <div className="daily-combo-card__empty">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            {loading
              ? (zh ? '正在计算当天组合…' : 'Calculating today’s combinations…')
              : failed
                ? (zh ? '数据读取正在恢复；已冻结记录不会被清空。' : 'Data reconnecting; frozen records are retained.')
                : (zh
                  ? `当前场次尚未组成满足SP门槛的${size}串1；新数据到达后自动重算。`
                  : `No ${size}-leg combination currently clears the SP floor; new data triggers recalculation.`)}
          </p>
        </div>
      )}
    </article>
  );
};

export const DailyFeaturedCombos: React.FC<DailyFeaturedCombosProps> = ({
  language,
  onSelectMatch,
}) => {
  const { ledger, loading, failed, refresh } = useDailyFeaturedCombos();
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const zh = language === 'zh';
  const rows = {
    2: visibleComboForSize(ledger, 2, now, failed),
    3: visibleComboForSize(ledger, 3, now, failed),
  } as const;
  const stats = ledger?.independentStatistics || ledger?.statistics;

  return (
    <section className="daily-combo-board" aria-label={zh ? '每日独立串关' : 'Independent daily combos'}>
      <header className="daily-combo-board__header">
        <div>
          <span className="daily-combo-board__icon"><Layers3 size={17} aria-hidden="true" /></span>
          <div>
            <h2>{zh ? '每日2串1 / 3串1' : 'Daily 2-leg / 3-leg Combos'}</h2>
            <p>
              {zh
                ? '直接综合赛前模型概率与竞彩去水概率；不等待单场进入“正式推荐”。'
                : 'Blends pre-match model and de-vigged Sporttery probabilities; no formal single-pick gate.'}
            </p>
          </div>
        </div>
        <div className="daily-combo-board__actions">
          <span className="daily-combo-board__rule">2串1 ≥2.50 · 3串1 ≥5.00</span>
          <button type="button" className="daily-combo-board__refresh" onClick={refresh} aria-label={zh ? '刷新组合' : 'Refresh combos'}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="daily-combo-board__meta">
        <span>{zh ? `候选场次 ${ledger?.candidateCount ?? '--'}` : `Candidates ${ledger?.candidateCount ?? '--'}`}</span>
        <span>{zh ? `更新 ${formatTime(ledger?.updatedAt, language)}` : `Updated ${formatTime(ledger?.updatedAt, language)}`}</span>
        <span>{zh ? '临近停售自动提前冻结' : 'Early freeze before the earliest cutoff'}</span>
      </div>

      <div className="daily-combo-board__grid">
        <ComboCard size={2} row={rows[2]} language={language} loading={loading} failed={failed} onSelectMatch={onSelectMatch} />
        <ComboCard size={3} row={rows[3]} language={language} loading={loading} failed={failed} onSelectMatch={onSelectMatch} />
      </div>

      <footer className="daily-combo-performance" aria-label={zh ? '独立串关复盘统计' : 'Independent combo performance'}>
        <div>
          <span>{zh ? '2串1累计' : '2-leg record'}</span>
          <strong>{rate(stats?.two)}</strong>
          <small>{stats?.two ? `${stats.two.won}/${stats.two.settled}` : '--'}</small>
        </div>
        <div>
          <span>{zh ? '3串1累计' : '3-leg record'}</span>
          <strong>{rate(stats?.three)}</strong>
          <small>{stats?.three ? `${stats.three.won}/${stats.three.settled}` : '--'}</small>
        </div>
        <div>
          <span>{zh ? '说明' : 'Method'}</span>
          <strong>{zh ? '稳健融合' : 'Robust blend'}</strong>
          <small>{zh ? '概率仅用于排序，不宣称组合命中率' : 'Probabilities rank legs; no parlay hit-rate claim'}</small>
        </div>
      </footer>
    </section>
  );
};
