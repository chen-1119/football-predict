import React from 'react';
import { Layers3, ShieldCheck } from 'lucide-react';
import type { Match } from '../../services/mockData';
import type { FeaturedCombo } from '../../services/dailyFeaturedCombos';
import { getTeamById } from '../../services/entities';
import { getPredictionTipDisplay } from '../../services/bettingDisplay';
import '../../styles/recommendation-quality.css';

type Language = 'zh' | 'en';
type ComboStats = { published: number; settled: number; won: number; lost: number; hitRate: number | null };
type FrozenLeg = { matchId: string; homeTeamId: string; awayTeamId: string; homeTeamName?: string; awayTeamName?: string; market: 'HAD' | 'HHAD'; tipCode: string; handicapLine: number; odds: number; evidenceScore: number };
type FrozenCombo = { id: string; businessDate: string; size: 2 | 3; totalOdds: number; averageEvidenceScore: number; legs: FrozenLeg[]; frozenAt?: string; settlement?: { status?: 'PENDING' | 'WON' | 'LOST' | 'VOID' } };
type ComboLedgerPublic = { updatedAt?: string; businessDate?: string; previews?: FrozenCombo[]; publishable?: boolean; today?: FrozenCombo[]; statistics?: { two?: ComboStats; three?: ComboStats } };

interface DailyFeaturedCombosProps {
  matches: Match[];
  language: Language;
  enabled: boolean;
  onSelectMatch: (matchId: string) => void;
}

const ComboCard: React.FC<{
  combo: FeaturedCombo;
  language: Language;
  onSelectMatch: (matchId: string) => void;
}> = ({ combo, language, onSelectMatch }) => (
  <article className={`daily-combo-card ${combo.status === 'ready' ? 'is-ready' : 'is-empty'}`}>
    <header className="daily-combo-card__header">
      <div>
        <span>{language === 'zh' ? `${combo.size} 场精选分析` : `${combo.size}-match featured analysis`}</span>
        <small>{language === 'zh' ? `总 SP ≥ ${combo.minimumTotalOdds.toFixed(2)}` : `Total SP ≥ ${combo.minimumTotalOdds.toFixed(2)}`}</small>
      </div>
      <strong>{combo.status === 'ready' ? `@${combo.totalOdds.toFixed(2)}` : '--'}</strong>
    </header>
    {combo.status === 'ready' ? (
      <>
        <div className="daily-combo-card__legs">
          {combo.legs.map((leg, index) => {
            const home = getTeamById(leg.match.homeTeamId);
            const away = getTeamById(leg.match.awayTeamId);
            return (
              <button key={`${combo.size}-${leg.match.id}`} type="button" className="daily-combo-leg" onClick={() => onSelectMatch(leg.match.id)}>
                <span className="daily-combo-leg__index">{index + 1}</span>
                <span className="daily-combo-leg__match">
                  <strong>{home.shortName[language]} vs {away.shortName[language]}</strong>
                  <small>{getPredictionTipDisplay(leg.prediction, language, true)}</small>
                </span>
                <span className="daily-combo-leg__odds">@{leg.odds.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
        <footer className="daily-combo-card__footer">
          <span>{language === 'zh' ? '平均证据评分' : 'Avg evidence'}</span>
          <strong>{combo.averageEvidenceScore.toFixed(1)}</strong>
        </footer>
      </>
    ) : (
      <div className="daily-combo-card__empty">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>{language === 'zh' ? '今日无合格组合。质量门槛或总 SP 下限未满足，不强行凑单。' : 'No combination currently clears both the quality gate and SP floor.'}</p>
      </div>
    )}
  </article>
);

const formatRate = (stats: ComboStats | undefined, language: Language) => {
  if (!stats || stats.settled === 0 || stats.hitRate === null) return language === 'zh' ? '待积累' : 'Pending';
  return `${(stats.hitRate * 100).toFixed(1)}%`;
};

export const DailyFeaturedCombos: React.FC<DailyFeaturedCombosProps> = ({ matches, language, enabled, onSelectMatch }) => {
  const [error, setError] = React.useState(false);
  const [ledger, setLedger] = React.useState<ComboLedgerPublic | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/v1/daily-featured-combos', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('combo unavailable');
        const payload = await response.json() as ComboLedgerPublic;
        if (!cancelled) { setLedger(payload); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const clock = Date.now();
  const fresh = Boolean(ledger?.updatedAt && clock - Date.parse(ledger.updatedAt) >= 0 && clock - Date.parse(ledger.updatedAt) < 10 * 60_000);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock));
  const frozen = ledger?.businessDate === today ? ledger.today || [] : [];
  const previews = enabled && fresh && !error && ledger?.publishable && ledger.businessDate === today ? ledger.previews || [] : [];
  const rows = frozen.length ? frozen : previews;
  const cardFor = (size: 2 | 3): FeaturedCombo => {
    const row = rows.find((entry) => entry.size === size);
    return { size, minimumTotalOdds: size === 2 ? 2.5 : 5, totalOdds: row?.totalOdds || 1, averageEvidenceScore: row?.averageEvidenceScore || 0, status: row ? 'ready' : 'insufficient', legs: (row?.legs || []).map((leg) => ({
      match: matches.find((match) => match.id === leg.matchId) || { id: leg.matchId, homeTeamId: leg.homeTeamId, awayTeamId: leg.awayTeamId } as Match,
      prediction: { marketType: 'BEST', oddsPoolCode: leg.market, tipCode: leg.tipCode, handicapLine: String(leg.handicapLine), odds: leg.odds, tipLabel: { zh: leg.tipCode, en: leg.tipCode }, trustScore: leg.evidenceScore, explanation: { zh: '', en: '' }, visibilityStatus: 'FREE', resultStatus: 'PENDING' } as Match['predictions'][number],
      odds: leg.odds, evidenceScore: leg.evidenceScore,
    })) };
  };
  const twoStats = ledger?.statistics?.two;
  const threeStats = ledger?.statistics?.three;
  const todaySettled = (ledger?.today || []).filter((entry) => ['WON', 'LOST'].includes(entry.settlement?.status || '')).length;

  return (
    <section className="daily-combo-board" aria-label={language === 'zh' ? '每日精选分析组合' : 'Daily featured analysis combinations'}>
      <header className="daily-combo-board__header">
        <div>
          <span className="daily-combo-board__icon"><Layers3 size={17} aria-hidden="true" /></span>
          <div>
            <h2>{language === 'zh' ? '每日精选组合' : 'Daily Featured Combos'}</h2>
            <p>{language === 'zh' ? '只使用当前正式赛前方向；优先证据强、总 SP 刚过门槛的组合。' : 'Uses current formal pre-match picks only, preferring strong evidence and totals just above the required floor.'}</p>
          </div>
        </div>
        <span className="daily-combo-board__rule">{language === 'zh' ? '2场 ≥2.50 · 3场 ≥5.00' : '2-leg ≥2.50 · 3-leg ≥5.00'}</span>
      </header>
      {error ? <div className="daily-combo-board__disabled" role="alert">{language === 'zh' ? '组合记录暂时读取失败，请稍后重试；历史统计不按零计。' : 'Combo records unavailable; statistics are not reset.'}</div> : !ledger ? <div className="daily-combo-board__disabled" role="status">{language === 'zh' ? '正在读取组合记录…' : 'Loading combo records…'}</div> : null}
      <p>{frozen.length ? (language === 'zh' ? '今日已冻结 · 方向与原始 SP 保持不变' : 'Frozen today · original directions and SP retained') : (language === 'zh' ? '待冻结候选 · 工作日 21:00 / 周末 22:00 冻结，未冻结不计入成绩' : 'Preview · freezes weekdays 21:00 / weekends 22:00, Shanghai time')}</p>
      {!rows.length && !enabled ? (
        <div className="daily-combo-board__disabled">{language === 'zh' ? '正式推荐池尚未达到可发布状态，精选组合保持暂停。' : 'The formal recommendation pool is not publishable yet; featured combinations remain paused.'}</div>
      ) : (
        <div className="daily-combo-board__grid">
          <ComboCard combo={cardFor(2)} language={language} onSelectMatch={onSelectMatch} />
          <ComboCard combo={cardFor(3)} language={language} onSelectMatch={onSelectMatch} />
        </div>
      )}
      <footer className="daily-combo-performance" aria-label={language === 'zh' ? '精选组合复盘统计' : 'Featured combo review statistics'}>
        <div><span>{language === 'zh' ? '2场组合累计' : '2-leg cumulative'}</span><strong>{error ? '--' : formatRate(twoStats, language)}</strong><small>{twoStats ? `${twoStats.won}/${twoStats.settled}` : '--'}</small></div>
        <div><span>{language === 'zh' ? '3场组合累计' : '3-leg cumulative'}</span><strong>{error ? '--' : formatRate(threeStats, language)}</strong><small>{threeStats ? `${threeStats.won}/${threeStats.settled}` : '--'}</small></div>
        <div><span>{language === 'zh' ? '今日已结算组合' : 'Settled today'}</span><strong>{todaySettled}</strong><small>{language === 'zh' ? '冻结后只结算，不改方向' : 'Frozen directions remain immutable'}</small></div>
      </footer>
    </section>
  );
};
